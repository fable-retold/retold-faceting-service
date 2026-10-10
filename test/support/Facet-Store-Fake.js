/**
 * Facet-Store-Fake — an in-memory store implementing the store contract's lifecycle and write side
 * (internal-contracts §54.3, §66.1), so the WriterLoop, the Materializer, the Rebuilder and the
 * Reconciler can be unit tested with no ClickHouse:
 *
 *   configure / connect / ensureSchema / createLive / addColumns / health / maxVersion
 *   readKeys / readKeyRange / writeBatch (the K / M / R inserts with per-table insert_deduplication_token
 *   dedup, every insert recorded in .Inserts) / beginShadow / swapShadow / dropShadow / readState /
 *   writeState / bucketChecksums / readLeafRows / queryRows (a test handler) / command (DROP TABLE) /
 *   dropDatabase / capabilities / status
 *
 *   failNext(pMethod, pWhen, pError)   fault injection: 'Before' (fail, nothing written), 'After' (write,
 *                                      then report the failure); writeBatch also 'AfterKeys' (the keymap
 *                                      intents landed) and 'AfterMirror' (intents and the mirror insert landed)
 *   tables()                           { '<table>': [ every inserted row … ] }
 *   finalRows(pTable)                  ReplacingMergeTree(_Version, _IsDeleted) FINAL semantics
 *   mirror(pEntity, pTarget) / keymap(pEntity, pTarget)   the FINAL live rows of a target
 *
 * Tables exist only once created (ensureSchema creates the database and the state table, createLive /
 * beginShadow + swapShadow the entity tables); writing a missing table fails with Code 60, anything after
 * dropDatabase with Code 81 (the wipe codes, §59.3).  Every callback is asynchronous (setImmediate).
 *
 * Owner: builder B (M5); builder D's unit tests may use it too.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libStoreBase = require('../../source/store/Retold-Faceting-StoreBase.js');
const libDDL = require('../../source/store/clickhouse/ClickHouse-DDL.js');
const libTypeMap = require('../../source/store/clickhouse/ClickHouse-TypeMap.js');

const WIPE_ERROR_CODES = Object.freeze([ 60, 81 ]);

/**
 * A store error like the real store's (no values in the message).
 *
 * @param {string} pMessage
 * @param {number|null} [pCode]
 * @param {number} [pStatus]
 * @return {Error}
 */
const storeError = (pMessage, pCode, pStatus) =>
{
	let tmpError = new Error(`FakeStore: ${pMessage}`);
	tmpError.StoreError = true;
	tmpError.Code = (typeof(pCode) === 'number') ? pCode : null;
	tmpError.Status = (typeof(pStatus) === 'number') ? pStatus : 500;
	tmpError.Retryable = (tmpError.Status >= 500) || (tmpError.Status === 0);
	return tmpError;
};

/**
 * A JSON clone.
 *
 * @param {any} pValue
 * @return {any}
 */
const clone = (pValue) =>
{
	return (pValue === undefined) ? undefined : JSON.parse(JSON.stringify(pValue));
};

class FacetStoreFake
{
	/**
	 * @param {{ StoreName?: string, Database?: string, Up?: boolean }} [pOptions]
	 */
	constructor(pOptions)
	{
		let tmpOptions = pOptions || {};
		this.StoreName = tmpOptions.StoreName || 'ClickHouse';
		this.Database = tmpOptions.Database || 'rfs_fake';
		this.Up = (tmpOptions.Up !== false);
		this.DatabaseExists = false;
		this._Tables = {};
		this._Specs = {};
		this._Tokens = {};
		this._Faults = [];
		this._State = [];
		this.Inserts = [];
		this.Commands = [];
		this.Calls = {};
		// queryRows handler (pSQL, pParams, pTypes) → rows | Error
		this.queryHandler = null;
	}

	// ---- helpers ------------------------------------------------------------------------------

	/**
	 * Count a call; take a matching fault.
	 *
	 * @param {string} pMethod
	 * @return {Record<string, any>|null}
	 */
	_enter(pMethod, pTarget)
	{
		this.Calls[pMethod] = (this.Calls[pMethod] || 0) + 1;
		for (let i = 0; i < this._Faults.length; i++)
		{
			let tmpFault = this._Faults[i];
			if ((tmpFault.Method === pMethod) && (!tmpFault.Target || (tmpFault.Target === pTarget)))
			{
				return this._Faults.splice(i, 1)[0];
			}
		}
		return null;
	}

	/**
	 * Call back on a later tick.
	 *
	 * @param {Function} fCallback
	 * @param {...any} pArgs
	 */
	_later(fCallback, ...pArgs)
	{
		setImmediate(() => { fCallback(...pArgs); });
	}

	/**
	 * The tables of a target.
	 *
	 * @param {string} pEntity
	 * @param {string} pTarget
	 * @return {{ Mirror: string, Keymap: string, BuildID: string|null }}
	 */
	_names(pEntity, pTarget)
	{
		let tmpBuildID = libStoreBase.isShadowTarget(pTarget);
		return { Mirror: libDDL.mirrorTableName(pEntity, tmpBuildID || undefined), Keymap: libDDL.keymapTableName(pEntity, tmpBuildID || undefined), BuildID: tmpBuildID };
	}

	/**
	 * The error a missing database / table gives, or null.
	 *
	 * @param {Array<string>} pTables
	 * @return {Error|null}
	 */
	_missing(pTables)
	{
		if (!this.DatabaseExists)
		{
			return storeError('the database does not exist.', 81, 404);
		}
		for (let i = 0; i < pTables.length; i++)
		{
			if (!this._Tables[pTables[i]])
			{
				return storeError('a table does not exist.', 60, 404);
			}
		}
		return null;
	}

	/**
	 * The ORDER BY columns of a table.
	 *
	 * @param {string} pTable
	 * @return {Array<string>}
	 */
	_orderBy(pTable)
	{
		let tmpInfo = this._Specs[pTable];
		if (!tmpInfo)
		{
			return [];
		}
		return tmpInfo.Kind === 'Keymap' ? libDDL.keymapOrder(tmpInfo.Spec) : tmpInfo.Spec.SortKey;
	}

	/**
	 * Insert rows into a table (token dedup per table).
	 *
	 * @param {string} pTable
	 * @param {Array<Record<string, any>>} pRows
	 * @param {string} pToken
	 * @return {boolean} inserted (false: a duplicate token)
	 */
	_insert(pTable, pRows, pToken)
	{
		if (!this._Tokens[pTable])
		{
			this._Tokens[pTable] = new Set();
		}
		this.Inserts.push({ Table: pTable, Token: pToken, Rows: pRows.length, Duplicate: this._Tokens[pTable].has(pToken) });
		if (this._Tokens[pTable].has(pToken))
		{
			return false;
		}
		this._Tokens[pTable].add(pToken);
		let tmpTable = this._Tables[pTable];
		pRows.forEach((pRow) => { tmpTable.push(clone(pRow)); });
		return true;
	}

	/**
	 * A key text over columns (numbers and integer strings agree).
	 *
	 * @param {Array<string>} pColumns
	 * @param {Record<string, any>} pRow
	 * @return {string}
	 */
	_keyText(pColumns, pRow)
	{
		return JSON.stringify(pColumns.map(
			(pColumn) =>
			{
				let tmpValue = pRow[pColumn];
				if ((tmpValue === undefined) || (tmpValue === null))
				{
					return null;
				}
				if ((typeof(tmpValue) === 'string') && /^-?\d+$/.test(tmpValue) && Number.isSafeInteger(Number(tmpValue)))
				{
					return Number(tmpValue);
				}
				return tmpValue;
			}));
	}

	/**
	 * ReplacingMergeTree(_Version, _IsDeleted) FINAL: the highest version per ORDER BY key (the later
	 * insert on a tie), deleted rows dropped.
	 *
	 * @param {string} pTable
	 * @return {Array<Record<string, any>>}
	 */
	finalRows(pTable)
	{
		let tmpRows = this._Tables[pTable] || [];
		let tmpOrder = this._orderBy(pTable);
		let tmpByKey = new Map();
		tmpRows.forEach(
			(pRow) =>
			{
				let tmpKey = this._keyText(tmpOrder, pRow);
				let tmpCurrent = tmpByKey.get(tmpKey);
				if (!tmpCurrent || (Number(pRow._Version) >= Number(tmpCurrent._Version)))
				{
					tmpByKey.set(tmpKey, pRow);
				}
			});
		return Array.from(tmpByKey.values()).filter((pRow) => { return Number(pRow._IsDeleted) !== 1; }).map(clone);
	}

	/**
	 * The FINAL live mirror rows of a target.
	 *
	 * @param {string} pEntity
	 * @param {string} [pTarget]
	 * @return {Array<Record<string, any>>}
	 */
	mirror(pEntity, pTarget)
	{
		return this.finalRows(this._names(pEntity, pTarget || libStoreBase.TARGET_LIVE).Mirror);
	}

	/**
	 * The FINAL live keymap rows of a target.
	 *
	 * @param {string} pEntity
	 * @param {string} [pTarget]
	 * @return {Array<Record<string, any>>}
	 */
	keymap(pEntity, pTarget)
	{
		return this.finalRows(this._names(pEntity, pTarget || libStoreBase.TARGET_LIVE).Keymap);
	}

	/**
	 * @return {Record<string, Array<Record<string, any>>>}
	 */
	tables()
	{
		return this._Tables;
	}

	/**
	 * Queue a fault.
	 *
	 * @param {string} pMethod
	 * @param {'Before'|'After'|'AfterKeys'|'AfterMirror'} [pWhen]
	 * @param {Error} [pError]
	 * @param {{ Target?: string }} [pMatch] - only a call for this target (writeBatch / readKeys / readKeyRange)
	 */
	failNext(pMethod, pWhen, pError, pMatch)
	{
		this._Faults.push({ Method: pMethod, When: pWhen || 'Before', Error: pError || storeError('injected failure.', null, 500), Target: (pMatch && pMatch.Target) ? pMatch.Target : null });
	}

	/**
	 * Create a table for a spec.
	 *
	 * @param {string} pTable
	 * @param {'Mirror'|'Keymap'} pKind
	 * @param {Record<string, any>} pSpec
	 */
	_create(pTable, pKind, pSpec)
	{
		this._Tables[pTable] = [];
		this._Specs[pTable] = { Kind: pKind, Spec: pSpec };
		this._Tokens[pTable] = new Set();
	}

	// ---- lifecycle ----------------------------------------------------------------------------

	/**
	 * @param {Record<string, any>} pOptions
	 * @return {{ Configured: boolean, Available: boolean, Reason: string|null }}
	 */
	configure(pOptions)
	{
		return { Configured: true, Available: true, Reason: null };
	}

	/**
	 * @param {Function} fCallback
	 */
	connect(fCallback)
	{
		let tmpFault = this._enter('connect');
		if (tmpFault)
		{
			return this._later(fCallback, tmpFault.Error);
		}
		return this._later(fCallback, null, { Up: this.Up, Version: this.Up ? 'fake-24.8' : null });
	}

	/**
	 * @param {Record<string, any>} pSpecs
	 * @param {Function} fCallback
	 */
	ensureSchema(pSpecs, fCallback)
	{
		let tmpFault = this._enter('ensureSchema');
		if (tmpFault && (tmpFault.When === 'Before'))
		{
			return this._later(fCallback, tmpFault.Error);
		}
		this.DatabaseExists = true;
		if (!this._Tables[libDDL.STATE_TABLE])
		{
			this._Tables[libDDL.STATE_TABLE] = [];
		}
		let tmpReport = { Entities: {} };
		Object.keys(pSpecs || {}).forEach(
			(pEntity) =>
			{
				let tmpMirror = libDDL.mirrorTableName(pEntity);
				let tmpKeymap = libDDL.keymapTableName(pEntity);
				let tmpMirrorInfo = this._Specs[tmpMirror];
				let tmpKeymapInfo = this._Specs[tmpKeymap];
				let tmpShadowPattern = new RegExp(`^${pEntity}${libDDL.SHADOW_INFIX}([0-9a-f]{8})$`);
				let tmpShadows = Object.keys(this._Tables).map((pTable) => { let tmpMatch = tmpShadowPattern.exec(pTable); return tmpMatch ? tmpMatch[1] : null; }).filter((pBuildID) => { return !!pBuildID; }).sort();
				let tmpEntry = { MirrorExists: !!this._Tables[tmpMirror], KeymapExists: !!this._Tables[tmpKeymap], SpecHash: null, Columns: [], ColumnTypes: {}, SortKey: [], KeymapColumnTypes: {}, KeymapSortKey: [], Shadows: tmpShadows };
				if (tmpEntry.MirrorExists && tmpMirrorInfo)
				{
					tmpEntry.SpecHash = tmpMirrorInfo.Spec.SpecHash;
					tmpMirrorInfo.Spec.Columns.forEach((pColumn) => { tmpEntry.Columns.push(pColumn.Column); tmpEntry.ColumnTypes[pColumn.Column] = pColumn.Mirror; });
					tmpEntry.SortKey = tmpMirrorInfo.Spec.SortKey.slice();
				}
				if (tmpEntry.KeymapExists && tmpKeymapInfo)
				{
					let tmpTypes = {};
					tmpKeymapInfo.Spec.Columns.forEach((pColumn) => { tmpTypes[pColumn.Column] = pColumn.Mirror; });
					(tmpKeymapInfo.Spec.KeymapColumns || []).forEach((pColumn) => { tmpEntry.KeymapColumnTypes[pColumn] = tmpTypes[pColumn]; });
					tmpEntry.KeymapSortKey = libDDL.keymapOrder(tmpKeymapInfo.Spec);
				}
				tmpReport.Entities[pEntity] = tmpEntry;
			});
		if (tmpFault)
		{
			return this._later(fCallback, tmpFault.Error);
		}
		return this._later(fCallback, null, tmpReport);
	}

	/**
	 * @param {string} pEntity
	 * @param {Record<string, any>} pSpec
	 * @param {Function} fCallback
	 */
	createLive(pEntity, pSpec, fCallback)
	{
		this.DatabaseExists = true;
		if (!this._Tables[libDDL.mirrorTableName(pEntity)])
		{
			this._create(libDDL.mirrorTableName(pEntity), 'Mirror', pSpec);
			this._create(libDDL.keymapTableName(pEntity), 'Keymap', pSpec);
		}
		return this._later(fCallback, null);
	}

	/**
	 * @param {string} pEntity
	 * @param {Record<string, any>} pSpec
	 * @param {Array<string>} pColumns
	 * @param {Function} fCallback
	 */
	addColumns(pEntity, pSpec, pColumns, fCallback)
	{
		let tmpFault = this._enter('addColumns');
		if (tmpFault)
		{
			return this._later(fCallback, tmpFault.Error);
		}
		let tmpMissing = this._missing([ libDDL.mirrorTableName(pEntity), libDDL.keymapTableName(pEntity) ]);
		if (tmpMissing)
		{
			return this._later(fCallback, tmpMissing);
		}
		this._Specs[libDDL.mirrorTableName(pEntity)].Spec = pSpec;
		this._Specs[libDDL.keymapTableName(pEntity)].Spec = pSpec;
		this.Commands.push(`ADD COLUMNS ${pEntity} ${(pColumns || []).join(',')}`);
		return this._later(fCallback, null);
	}

	/**
	 * @param {Function} fCallback
	 */
	health(fCallback)
	{
		return this._later(fCallback, null, { Up: this.Up, Version: 'fake-24.8', Database: this.Database, Tables: Object.keys(this._Tables).length, ActivePartsMax: 1 });
	}

	/**
	 * @param {Function} fCallback
	 */
	maxVersion(fCallback)
	{
		let tmpFault = this._enter('maxVersion');
		if (tmpFault)
		{
			return this._later(fCallback, tmpFault.Error);
		}
		let tmpMax = 0;
		Object.keys(this._Tables).forEach((pTable) => { this._Tables[pTable].forEach((pRow) => { if (Number(pRow._Version) > tmpMax) { tmpMax = Number(pRow._Version); } }); });
		this._State.forEach((pRow) => { if (Number(pRow._Version) > tmpMax) { tmpMax = Number(pRow._Version); } });
		return this._later(fCallback, null, tmpMax);
	}

	// ---- write side ---------------------------------------------------------------------------

	/**
	 * Keymap rows → Map<ID, [ { Key, Tracked, UpdateDate, Version } ]>.
	 *
	 * @param {string} pKeymap
	 * @param {(pID: number) => boolean} fMatch
	 * @return {Map<number, Array<Record<string, any>>>}
	 */
	_keys(pKeymap, fMatch)
	{
		let tmpInfo = this._Specs[pKeymap];
		let tmpSpec = tmpInfo.Spec;
		let tmpKeys = new Map();
		this.finalRows(pKeymap).forEach(
			(pRow) =>
			{
				let tmpID = Number(pRow[tmpSpec.Identity]);
				if (!fMatch(tmpID))
				{
					return;
				}
				if (!tmpKeys.has(tmpID))
				{
					tmpKeys.set(tmpID, []);
				}
				tmpKeys.get(tmpID).push({ Key: libTypeMap.keyOf(tmpSpec, pRow), Tracked: libTypeMap.trackedOf(tmpSpec, pRow), UpdateDate: (pRow.UpdateDate === undefined) ? null : pRow.UpdateDate, Version: Number(pRow._Version) });
			});
		return tmpKeys;
	}

	/**
	 * @param {string} pEntity
	 * @param {Array<number>} pIDs
	 * @param {string} pTarget
	 * @param {Function} fCallback
	 */
	readKeys(pEntity, pIDs, pTarget, fCallback)
	{
		let tmpFault = this._enter('readKeys', pTarget);
		if (tmpFault)
		{
			return this._later(fCallback, tmpFault.Error);
		}
		let tmpNames = this._names(pEntity, pTarget);
		let tmpMissing = this._missing([ tmpNames.Keymap ]);
		if (tmpMissing)
		{
			return this._later(fCallback, tmpMissing);
		}
		let tmpWanted = new Set((pIDs || []).map(Number));
		return this._later(fCallback, null, this._keys(tmpNames.Keymap, (pID) => { return tmpWanted.has(pID); }));
	}

	/**
	 * @param {string} pEntity
	 * @param {number|null} pAfterID
	 * @param {number|null} pToID
	 * @param {string} pTarget
	 * @param {Function} fCallback
	 */
	readKeyRange(pEntity, pAfterID, pToID, pTarget, fCallback)
	{
		let tmpFault = this._enter('readKeyRange', pTarget);
		if (tmpFault)
		{
			return this._later(fCallback, tmpFault.Error);
		}
		let tmpNames = this._names(pEntity, pTarget);
		let tmpMissing = this._missing([ tmpNames.Keymap ]);
		if (tmpMissing)
		{
			return this._later(fCallback, tmpMissing);
		}
		return this._later(fCallback, null, this._keys(tmpNames.Keymap,
			(pID) =>
			{
				return (((pAfterID === null) || (pAfterID === undefined)) || (pID > pAfterID)) && (((pToID === null) || (pToID === undefined)) || (pID <= pToID));
			}));
	}

	/**
	 * The three-insert flush protocol (§58.6): keymap intents (K), ONE mirror insert with rows and
	 * tombstones (M), keymap retirements (R).
	 *
	 * @param {string} pEntity
	 * @param {Record<string, Array<any>>} pBatch
	 * @param {string} pToken
	 * @param {string} pTarget
	 * @param {Function} fCallback
	 */
	writeBatch(pEntity, pBatch, pToken, pTarget, fCallback)
	{
		let tmpFault = this._enter('writeBatch', pTarget);
		if (tmpFault && (tmpFault.When === 'Before'))
		{
			return this._later(fCallback, tmpFault.Error);
		}
		let tmpNames = this._names(pEntity, pTarget);
		let tmpMissing = this._missing([ tmpNames.Mirror, tmpNames.Keymap ]);
		if (tmpMissing)
		{
			return this._later(fCallback, tmpMissing);
		}
		let tmpBatch = pBatch || {};
		let tmpIntents = Array.isArray(tmpBatch.KeyIntents) ? tmpBatch.KeyIntents : [];
		let tmpMirror = (Array.isArray(tmpBatch.Rows) ? tmpBatch.Rows : []).concat(Array.isArray(tmpBatch.Tombstones) ? tmpBatch.Tombstones : []);
		let tmpRetires = Array.isArray(tmpBatch.KeyRetires) ? tmpBatch.KeyRetires : [];
		if (tmpIntents.length > 0)
		{
			this._insert(tmpNames.Keymap, tmpIntents, `${pToken}:K0`);
		}
		if (tmpFault && (tmpFault.When === 'AfterKeys'))
		{
			return this._later(fCallback, tmpFault.Error);
		}
		if (tmpMirror.length > 0)
		{
			this._insert(tmpNames.Mirror, tmpMirror, `${pToken}:M0`);
		}
		if (tmpFault && (tmpFault.When === 'AfterMirror'))
		{
			return this._later(fCallback, tmpFault.Error);
		}
		if (tmpRetires.length > 0)
		{
			this._insert(tmpNames.Keymap, tmpRetires, `${pToken}:R0`);
		}
		if (tmpFault)
		{
			return this._later(fCallback, tmpFault.Error);
		}
		return this._later(fCallback, null, { Rows: (tmpBatch.Rows || []).length, Tombstones: (tmpBatch.Tombstones || []).length, Inserts: 3 });
	}

	/**
	 * @param {string} pEntity
	 * @param {string} pBuildID
	 * @param {Record<string, any>} pSpec
	 * @param {Function} fCallback
	 */
	beginShadow(pEntity, pBuildID, pSpec, fCallback)
	{
		let tmpFault = this._enter('beginShadow');
		if (tmpFault)
		{
			return this._later(fCallback, tmpFault.Error);
		}
		if (!this.DatabaseExists)
		{
			return this._later(fCallback, storeError('the database does not exist.', 81, 404));
		}
		let tmpNames = this._names(pEntity, libStoreBase.shadowTarget(pBuildID));
		this._create(tmpNames.Mirror, 'Mirror', pSpec);
		this._create(tmpNames.Keymap, 'Keymap', pSpec);
		return this._later(fCallback, null);
	}

	/**
	 * First enable: RENAME the shadow live (the live tables must not exist); else EXCHANGE.
	 *
	 * @param {string} pEntity
	 * @param {string} pBuildID
	 * @param {boolean} pFirstEnable
	 * @param {Function} fCallback
	 */
	swapShadow(pEntity, pBuildID, pFirstEnable, fCallback)
	{
		let tmpFault = this._enter('swapShadow');
		if (tmpFault)
		{
			return this._later(fCallback, tmpFault.Error);
		}
		let tmpShadow = this._names(pEntity, libStoreBase.shadowTarget(pBuildID));
		let tmpLive = this._names(pEntity, libStoreBase.TARGET_LIVE);
		let tmpMissing = this._missing([ tmpShadow.Mirror, tmpShadow.Keymap ]);
		if (tmpMissing)
		{
			return this._later(fCallback, tmpMissing);
		}
		let fMove = (pFrom, pTo) =>
		{
			this._Tables[pTo] = this._Tables[pFrom];
			this._Specs[pTo] = this._Specs[pFrom];
			this._Tokens[pTo] = this._Tokens[pFrom];
			delete this._Tables[pFrom];
			delete this._Specs[pFrom];
			delete this._Tokens[pFrom];
		};
		if (pFirstEnable)
		{
			if (this._Tables[tmpLive.Mirror] || this._Tables[tmpLive.Keymap])
			{
				return this._later(fCallback, storeError('the live table already exists.', 57, 500));
			}
			fMove(tmpShadow.Mirror, tmpLive.Mirror);
			fMove(tmpShadow.Keymap, tmpLive.Keymap);
			this.Commands.push(`RENAME ${pEntity} ${pBuildID}`);
			return this._later(fCallback, null);
		}
		let tmpMissingLive = this._missing([ tmpLive.Mirror, tmpLive.Keymap ]);
		if (tmpMissingLive)
		{
			return this._later(fCallback, tmpMissingLive);
		}
		[ [ tmpShadow.Mirror, tmpLive.Mirror ], [ tmpShadow.Keymap, tmpLive.Keymap ] ].forEach(
			(pPair) =>
			{
				let tmpA = { T: this._Tables[pPair[0]], S: this._Specs[pPair[0]], K: this._Tokens[pPair[0]] };
				this._Tables[pPair[0]] = this._Tables[pPair[1]];
				this._Specs[pPair[0]] = this._Specs[pPair[1]];
				this._Tokens[pPair[0]] = this._Tokens[pPair[1]];
				this._Tables[pPair[1]] = tmpA.T;
				this._Specs[pPair[1]] = tmpA.S;
				this._Tokens[pPair[1]] = tmpA.K;
			});
		this.Commands.push(`EXCHANGE ${pEntity} ${pBuildID}`);
		return this._later(fCallback, null);
	}

	/**
	 * @param {string} pEntity
	 * @param {string} pBuildID
	 * @param {Function} fCallback
	 */
	dropShadow(pEntity, pBuildID, fCallback)
	{
		let tmpFault = this._enter('dropShadow');
		if (tmpFault)
		{
			return this._later(fCallback, tmpFault.Error);
		}
		let tmpNames = this._names(pEntity, libStoreBase.shadowTarget(pBuildID));
		[ tmpNames.Mirror, tmpNames.Keymap ].forEach((pTable) => { delete this._Tables[pTable]; delete this._Specs[pTable]; delete this._Tokens[pTable]; });
		this.Commands.push(`DROP SHADOW ${pEntity} ${pBuildID}`);
		return this._later(fCallback, null);
	}

	/**
	 * @param {string} pEntity
	 * @param {Function} fCallback
	 */
	readState(pEntity, fCallback)
	{
		let tmpFault = this._enter('readState');
		if (tmpFault)
		{
			return this._later(fCallback, tmpFault.Error);
		}
		if (!this.DatabaseExists)
		{
			return this._later(fCallback, storeError('the database does not exist.', 81, 404));
		}
		let tmpLatest = null;
		this._State.forEach((pRow) => { if ((pRow.Store === this.StoreName) && (pRow.Entity === pEntity) && (!tmpLatest || (Number(pRow._Version) >= Number(tmpLatest._Version)))) { tmpLatest = pRow; } });
		return this._later(fCallback, null, tmpLatest ? clone(tmpLatest) : null);
	}

	/**
	 * @param {string} pEntity
	 * @param {Record<string, any>} pState
	 * @param {Function} fCallback
	 */
	writeState(pEntity, pState, fCallback)
	{
		let tmpFault = this._enter('writeState');
		if (tmpFault && (tmpFault.When === 'Before'))
		{
			return this._later(fCallback, tmpFault.Error);
		}
		if (!this.DatabaseExists)
		{
			return this._later(fCallback, storeError('the database does not exist.', 81, 404));
		}
		let tmpRow = Object.assign({ Store: this.StoreName, Entity: pEntity }, clone(pState));
		tmpRow._Version = Number(pState._Version || pState.Version || 0);
		this._State.push(tmpRow);
		if (tmpFault)
		{
			return this._later(fCallback, tmpFault.Error);
		}
		return this._later(fCallback, null);
	}

	/**
	 * The latest state row of an entity (synchronous; tests).
	 *
	 * @param {string} pEntity
	 * @return {Record<string, any>|null}
	 */
	stateOf(pEntity)
	{
		let tmpLatest = null;
		this._State.forEach((pRow) => { if ((pRow.Entity === pEntity) && (!tmpLatest || (Number(pRow._Version) >= Number(tmpLatest._Version)))) { tmpLatest = pRow; } });
		return tmpLatest ? clone(tmpLatest) : null;
	}

	/**
	 * Every state row written (tests).
	 *
	 * @return {Array<Record<string, any>>}
	 */
	stateRows()
	{
		return this._State.map(clone);
	}

	/**
	 * @param {string} pEntity
	 * @param {number} pLeafRange
	 * @param {string} pTarget
	 * @param {Function} fCallback
	 */
	bucketChecksums(pEntity, pLeafRange, pTarget, fCallback)
	{
		let tmpFault = this._enter('bucketChecksums');
		if (tmpFault)
		{
			return this._later(fCallback, tmpFault.Error);
		}
		let tmpNames = this._names(pEntity, pTarget);
		let tmpMissing = this._missing([ tmpNames.Keymap ]);
		if (tmpMissing)
		{
			return this._later(fCallback, tmpMissing);
		}
		let tmpBuckets = {};
		let tmpSeen = new Set();
		let tmpIdentity = this._Specs[tmpNames.Keymap].Spec.Identity;
		this.finalRows(tmpNames.Keymap).forEach(
			(pRow) =>
			{
				let tmpID = Number(pRow[tmpIdentity]);
				if (tmpSeen.has(tmpID))
				{
					return;
				}
				tmpSeen.add(tmpID);
				let tmpBucket = String(Math.floor(tmpID / pLeafRange));
				if (!tmpBuckets[tmpBucket])
				{
					tmpBuckets[tmpBucket] = { Count: 0, IDSum: 0 };
				}
				tmpBuckets[tmpBucket].Count++;
				tmpBuckets[tmpBucket].IDSum += tmpID;
			});
		return this._later(fCallback, null, tmpBuckets);
	}

	/**
	 * @param {string} pEntity
	 * @param {number|null} pAfterID
	 * @param {number|null} pToID
	 * @param {Array<string>|null} pColumns
	 * @param {Function} fCallback
	 */
	readLeafRows(pEntity, pAfterID, pToID, pColumns, fCallback)
	{
		let tmpNames = this._names(pEntity, libStoreBase.TARGET_LIVE);
		let tmpMissing = this._missing([ tmpNames.Mirror ]);
		if (tmpMissing)
		{
			return this._later(fCallback, tmpMissing);
		}
		let tmpIdentity = this._Specs[tmpNames.Mirror].Spec.Identity;
		let tmpRows = this.finalRows(tmpNames.Mirror).filter(
			(pRow) =>
			{
				let tmpID = Number(pRow[tmpIdentity]);
				return (((pAfterID === null) || (pAfterID === undefined)) || (tmpID > pAfterID)) && (((pToID === null) || (pToID === undefined)) || (tmpID <= pToID));
			}).sort((pA, pB) => { return Number(pA[tmpIdentity]) - Number(pB[tmpIdentity]); });
		if (Array.isArray(pColumns))
		{
			tmpRows = tmpRows.map((pRow) => { let tmpOut = {}; pColumns.forEach((pColumn) => { tmpOut[pColumn] = (pRow[pColumn] === undefined) ? null : pRow[pColumn]; }); return tmpOut; });
		}
		return this._later(fCallback, null, tmpRows);
	}

	// ---- statements ---------------------------------------------------------------------------

	/**
	 * @param {string} pSQL
	 * @param {Record<string, any>} pParams
	 * @param {Record<string, string>} pTypes
	 * @param {Record<string, any>} pSettings
	 * @param {Function} fCallback
	 */
	queryRows(pSQL, pParams, pTypes, pSettings, fCallback)
	{
		let tmpFault = this._enter('queryRows');
		if (tmpFault)
		{
			return this._later(fCallback, tmpFault.Error);
		}
		if (typeof(this.queryHandler) !== 'function')
		{
			return this._later(fCallback, storeError('no query handler.', null, 500));
		}
		let tmpResult = this.queryHandler(pSQL, pParams, pTypes);
		if (tmpResult instanceof Error)
		{
			return this._later(fCallback, tmpResult);
		}
		return this._later(fCallback, null, tmpResult || []);
	}

	/**
	 * DDL: DROP TABLE IF EXISTS `db`.`T` is honored; anything else is recorded.
	 *
	 * @param {string} pSQL
	 * @param {Record<string, any>} pParams
	 * @param {Record<string, any>} pSettings
	 * @param {Function} fCallback
	 */
	command(pSQL, pParams, pSettings, fCallback)
	{
		this.Commands.push(String(pSQL));
		let tmpMatch = /^DROP TABLE IF EXISTS `[^`]+`\.`([^`]+)`/.exec(String(pSQL));
		if (tmpMatch)
		{
			delete this._Tables[tmpMatch[1]];
			delete this._Specs[tmpMatch[1]];
			delete this._Tokens[tmpMatch[1]];
		}
		return this._later(fCallback, null);
	}

	/**
	 * @param {Function} fCallback
	 */
	dropDatabase(fCallback)
	{
		this.DatabaseExists = false;
		this._Tables = {};
		this._Specs = {};
		this._Tokens = {};
		this._State = [];
		return this._later(fCallback, null);
	}

	/**
	 * @return {Record<string, any>}
	 */
	capabilities()
	{
		return { Folds: [], Predicates: 'Portable', Paths: 'Subquery', CountModes: [ 'Rows', 'PivotDistinct', 'KeyDistinct' ], TimeZones: [ 'UTC' ] };
	}

	/**
	 * @return {Record<string, any>}
	 */
	status()
	{
		return { Configured: true, Available: this.Up, Reason: this.Up ? null : 'Down', Database: this.Database, Version: 'fake-24.8', LastError: null, ConnectedAt: null };
	}
}

module.exports = FacetStoreFake;
module.exports.WIPE_ERROR_CODES = WIPE_ERROR_CODES;
module.exports.storeError = storeError;
