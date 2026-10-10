/**
 * ClickHouse-DDL — names and DDL text for the ClickHouse store (internal-contracts §56.1–§56.2).
 *
 *   sanitizeInstanceKey(pInstanceID)            [^A-Za-z0-9_] → '_'
 *   databaseName(pInstanceID, pOverride)        Stores.ClickHouse.Database, else 'rfs_' + InstanceKey (+ '_' + a
 *                                               short hash of the raw InstanceID when sanitizing changed it, so
 *                                               'prod.eu' / 'prod-eu' / 'prod_eu' never share a database)
 *   quoteIdentifier(pName) / qualified(pDatabase, pTable)
 *   mirrorTableName(pEntity, pBuildID?) / keymapTableName(pEntity, pBuildID?)
 *   createDatabaseDDL(pDatabase)                CREATE DATABASE IF NOT EXISTS … ENGINE = Atomic
 *   mirrorDDL(pDatabase, pSpec, pBuildID?) / keymapDDL(pDatabase, pSpec, pBuildID?) / entityStateDDL(pDatabase)
 *   leaseDDL(pDatabase) / ownerDDL(pDatabase)   the materializer lease and the database's owner marker
 *   addColumnsDDL(pDatabase, pTable, pColumns, pComment?) / exchangeDDL(…) / renameDDL(…) / dropTableDDL(…)
 *   modifyCommentDDL(pDatabase, pTable, pComment)
 *   specComment(pKind, pEntity, pSpecHash) / parseSpecComment(pComment) → { Kind, Entity, SpecHash } | null
 *   mirrorColumns(pSpec) / keymapColumns(pSpec) → [ { Column, Mirror } ] (the non-meta columns of each table)
 *
 * Every identifier is validated (IDENTIFIER_PATTERN) and backtick-quoted; nothing from a client ever
 * reaches this module.  Column types come only from the spec, validated against MIRROR_TYPE_PATTERN.
 * A pure module (no requires), so it moves with the client.
 *
 * Contract: internal-contracts §56.  Owner: builder A (M5).
 *
 * @author Steven Velozo <steven@velozo.com>
 */

// Bumped whenever generated DDL changes shape (part of every SpecHash, §55.2 rule 4).
const DDL_VERSION = 1;

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const BUILD_ID_PATTERN = /^[0-9a-f]{8}$/;
const SPEC_HASH_PATTERN = /^ms:[0-9a-f]{8}$/;

// The meta columns every mirror carries (keymaps: _Version, _IsDeleted).
const META_COLUMNS = Object.freeze([ '_Version', '_IsDeleted', '_AppliedAt' ]);

const STATE_TABLE = '_rfs_entity_state';
// One row per store: the process that materializes it (the lease, §68 #16 review fix).
const LEASE_TABLE = '_rfs_lease';
// One row per store: the deployment that owns the database (InstanceID + source fingerprint).
const OWNER_TABLE = '_rfs_owner';
const KEYMAP_PREFIX = '_rfs_keys_';
const SHADOW_INFIX = '__shadow_';

// The column types a spec may name (the type map's output, §56.3).
const MIRROR_TYPE_PATTERN = /^(?:Nullable\()?(?:Int64|UInt8|UInt64|Float64|String|DateTime64\(3, 'UTC'\))\)?$/;

// The table COMMENT that carries the SpecHash: 'rfs mirror LabForm spec=ms:0123abcd'.
const SPEC_COMMENT_PATTERN = /^rfs (mirror|keymap) ([A-Za-z_][A-Za-z0-9_]{0,63}) spec=(ms:[0-9a-f]{8})$/;

// Mirror settings (allow_nullable_key only when a sort-key column is Nullable).
const MIRROR_SETTINGS = 'index_granularity = 8192, non_replicated_deduplication_window = 1000';
// Keymaps are point-lookup tables (readKeys: up to a few thousand IDs per read): a small granularity
// keeps the rows read per lookup near the rows wanted (8192 read ~20× more at 20M rows, measured).
const KEYMAP_SETTINGS = 'index_granularity = 256, non_replicated_deduplication_window = 1000';

/**
 * @param {string} pInstanceID
 * @return {string}
 */
const sanitizeInstanceKey = (pInstanceID) =>
{
	let tmpKey = String((pInstanceID === null) || (typeof(pInstanceID) === 'undefined') ? 'main' : pInstanceID).replace(/[^A-Za-z0-9_]/g, '_');
	return (tmpKey.length > 0) ? tmpKey : 'main';
};

/**
 * A short, stable hash of a text (FNV-1a 32 bit, 8 lowercase hex): no requires, so the module stays pure.
 *
 * @param {string} pText
 * @return {string}
 */
const shortHash = (pText) =>
{
	let tmpHash = 0x811c9dc5;
	let tmpText = String(pText);
	for (let i = 0; i < tmpText.length; i++)
	{
		tmpHash ^= tmpText.charCodeAt(i);
		tmpHash = Math.imul(tmpHash, 0x01000193) >>> 0;
	}
	return tmpHash.toString(16).padStart(8, '0');
};

/**
 * The database name: the override, else 'rfs_' + the sanitized InstanceID — injective: when sanitizing
 * changed the InstanceID (it held characters outside [A-Za-z0-9_]) a short hash of the raw text is
 * appended, so two InstanceIDs that sanitize alike never share a database.
 *
 * @param {string} pInstanceID
 * @param {string|null} [pOverride] - Stores.ClickHouse.Database
 * @return {string}
 */
const databaseName = (pInstanceID, pOverride) =>
{
	let tmpName = null;
	if ((typeof(pOverride) === 'string') && (pOverride.length > 0))
	{
		tmpName = pOverride;
	}
	else
	{
		let tmpRaw = String((pInstanceID === null) || (typeof(pInstanceID) === 'undefined') ? 'main' : pInstanceID);
		let tmpKey = sanitizeInstanceKey(tmpRaw);
		tmpName = (tmpKey === tmpRaw) ? `rfs_${tmpKey}` : `rfs_${tmpKey.slice(0, 50)}_${shortHash(tmpRaw)}`;
	}
	if (!IDENTIFIER_PATTERN.test(tmpName))
	{
		throw new Error('ClickHouse-DDL: the database name must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$.');
	}
	return tmpName;
};

/**
 * @param {string} pName
 * @return {string}
 */
const quoteIdentifier = (pName) =>
{
	if ((typeof(pName) !== 'string') || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(pName))
	{
		throw new Error('ClickHouse-DDL: an invalid identifier.');
	}
	return `\`${pName}\``;
};

/**
 * @param {string} pDatabase
 * @param {string} pTable
 * @return {string}
 */
const qualified = (pDatabase, pTable) =>
{
	if (!IDENTIFIER_PATTERN.test(String(pDatabase)))
	{
		throw new Error('ClickHouse-DDL: an invalid database name.');
	}
	return `${quoteIdentifier(pDatabase)}.${quoteIdentifier(pTable)}`;
};

/**
 * @param {string|null|undefined} pBuildID
 * @return {string} '' or '__shadow_<BuildID>'
 */
const shadowSuffix = (pBuildID) =>
{
	if ((pBuildID === null) || (typeof(pBuildID) === 'undefined'))
	{
		return '';
	}
	if (!BUILD_ID_PATTERN.test(String(pBuildID)))
	{
		throw new Error('ClickHouse-DDL: a BuildID is 8 lowercase hex characters.');
	}
	return `${SHADOW_INFIX}${pBuildID}`;
};

/**
 * @param {string} pEntity
 * @param {string} [pBuildID]
 * @return {string}
 */
const mirrorTableName = (pEntity, pBuildID) =>
{
	if (!IDENTIFIER_PATTERN.test(String(pEntity)) || (String(pEntity).indexOf('_rfs_') === 0))
	{
		throw new Error('ClickHouse-DDL: an invalid entity name for a mirror.');
	}
	return `${pEntity}${shadowSuffix(pBuildID)}`;
};

/**
 * @param {string} pEntity
 * @param {string} [pBuildID]
 * @return {string}
 */
const keymapTableName = (pEntity, pBuildID) =>
{
	return `${KEYMAP_PREFIX}${mirrorTableName(pEntity)}${shadowSuffix(pBuildID)}`;
};

/**
 * @param {string} pDatabase
 * @return {string}
 */
const createDatabaseDDL = (pDatabase) =>
{
	return `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(databaseName(null, pDatabase))} ENGINE = Atomic`;
};

/**
 * @param {'mirror'|'keymap'} pKind
 * @param {string} pEntity
 * @param {string} pSpecHash
 * @return {string}
 */
const specComment = (pKind, pEntity, pSpecHash) =>
{
	if ((pKind !== 'mirror') && (pKind !== 'keymap'))
	{
		throw new Error('ClickHouse-DDL: a spec comment kind is mirror or keymap.');
	}
	if (!IDENTIFIER_PATTERN.test(String(pEntity)))
	{
		throw new Error('ClickHouse-DDL: an invalid entity name in a spec comment.');
	}
	if (!SPEC_HASH_PATTERN.test(String(pSpecHash)))
	{
		throw new Error('ClickHouse-DDL: a SpecHash is ms: and 8 lowercase hex characters.');
	}
	return `rfs ${pKind} ${pEntity} spec=${pSpecHash}`;
};

/**
 * @param {string} pComment
 * @return {{ Kind: string, Entity: string, SpecHash: string } | null}
 */
const parseSpecComment = (pComment) =>
{
	let tmpMatch = (typeof(pComment) === 'string') ? SPEC_COMMENT_PATTERN.exec(pComment.trim()) : null;
	if (!tmpMatch)
	{
		return null;
	}
	return { Kind: tmpMatch[1], Entity: tmpMatch[2], SpecHash: tmpMatch[3] };
};

/**
 * A validated column type.
 *
 * @param {string} pType
 * @return {string}
 */
const columnType = (pType) =>
{
	if ((typeof(pType) !== 'string') || !MIRROR_TYPE_PATTERN.test(pType))
	{
		throw new Error('ClickHouse-DDL: an unsupported mirror column type.');
	}
	return pType;
};

/**
 * The spec column of a name.
 *
 * @param {Record<string, any>} pSpec
 * @param {string} pColumn
 * @return {Record<string, any>}
 */
const specColumn = (pSpec, pColumn) =>
{
	let tmpColumns = Array.isArray(pSpec.Columns) ? pSpec.Columns : [];
	for (let i = 0; i < tmpColumns.length; i++)
	{
		if (tmpColumns[i] && (tmpColumns[i].Column === pColumn))
		{
			return tmpColumns[i];
		}
	}
	throw new Error('ClickHouse-DDL: a sort-key or keymap column is not a spec column.');
};

/**
 * Validate the parts of a spec the DDL reads.
 *
 * @param {Record<string, any>} pSpec
 */
const assertSpec = (pSpec) =>
{
	if (!pSpec || (typeof(pSpec) !== 'object') || !Array.isArray(pSpec.Columns) || (pSpec.Columns.length < 1)
		|| !Array.isArray(pSpec.SortKey) || (pSpec.SortKey.length < 1))
	{
		throw new Error('ClickHouse-DDL: a MirrorSpec needs Columns and a SortKey.');
	}
	mirrorTableName(pSpec.Entity);
	let tmpSeen = {};
	for (let i = 0; i < pSpec.Columns.length; i++)
	{
		let tmpColumn = pSpec.Columns[i];
		if (!tmpColumn || !IDENTIFIER_PATTERN.test(String(tmpColumn.Column)) || (META_COLUMNS.indexOf(tmpColumn.Column) >= 0))
		{
			throw new Error('ClickHouse-DDL: an invalid mirror column name.');
		}
		if (Object.prototype.hasOwnProperty.call(tmpSeen, tmpColumn.Column))
		{
			throw new Error('ClickHouse-DDL: a duplicate mirror column.');
		}
		tmpSeen[tmpColumn.Column] = true;
		columnType(tmpColumn.Mirror);
	}
};

/**
 * The non-meta columns of a mirror: the spec's columns in spec order.
 *
 * @param {Record<string, any>} pSpec
 * @return {Array<{ Column: string, Mirror: string }>}
 */
const mirrorColumns = (pSpec) =>
{
	assertSpec(pSpec);
	return pSpec.Columns.map((pColumn) => { return { Column: pColumn.Column, Mirror: pColumn.Mirror }; });
};

/**
 * The non-meta columns of a keymap: KeymapColumns (identity, sort-key scope columns, tracked
 * columns, UpdateDate), typed as in the mirror.
 *
 * @param {Record<string, any>} pSpec
 * @return {Array<{ Column: string, Mirror: string }>}
 */
const keymapColumns = (pSpec) =>
{
	assertSpec(pSpec);
	let tmpNames = Array.isArray(pSpec.KeymapColumns) && (pSpec.KeymapColumns.length > 0) ? pSpec.KeymapColumns : pSpec.SortKey;
	let tmpSeen = {};
	let tmpColumns = [];
	for (let i = 0; i < tmpNames.length; i++)
	{
		if (Object.prototype.hasOwnProperty.call(tmpSeen, tmpNames[i]))
		{
			continue;
		}
		tmpSeen[tmpNames[i]] = true;
		let tmpColumn = specColumn(pSpec, tmpNames[i]);
		tmpColumns.push({ Column: tmpColumn.Column, Mirror: tmpColumn.Mirror });
	}
	return tmpColumns;
};

/**
 * The keymap ORDER BY: identity first, then the sort-key scope columns (several live keys per ID).
 *
 * @param {Record<string, any>} pSpec
 * @return {Array<string>}
 */
const keymapOrder = (pSpec) =>
{
	let tmpOrder = [ pSpec.Identity ];
	for (let i = 0; i < pSpec.SortKey.length; i++)
	{
		if (tmpOrder.indexOf(pSpec.SortKey[i]) < 0)
		{
			tmpOrder.push(pSpec.SortKey[i]);
		}
	}
	return tmpOrder;
};

/**
 * Does any of these sort-key columns have a Nullable type?
 *
 * @param {Record<string, any>} pSpec
 * @param {Array<string>} pColumns
 * @return {boolean}
 */
const hasNullableKey = (pSpec, pColumns) =>
{
	for (let i = 0; i < pColumns.length; i++)
	{
		if (/^Nullable\(/.test(specColumn(pSpec, pColumns[i]).Mirror))
		{
			return true;
		}
	}
	return false;
};

/**
 * The column list of a CREATE TABLE.
 *
 * @param {Array<{ Column: string, Mirror: string }>} pColumns
 * @param {Array<string>} pMeta - meta column definitions
 * @return {string}
 */
const columnList = (pColumns, pMeta) =>
{
	let tmpLines = pColumns.map((pColumn) => { return `\t${quoteIdentifier(pColumn.Column)} ${columnType(pColumn.Mirror)}`; });
	return tmpLines.concat(pMeta.map((pLine) => { return `\t${pLine}`; })).join(',\n');
};

/**
 * The mirror table (§56.2): ReplacingMergeTree(_Version, _IsDeleted) ordered by the spec's sort key.
 *
 * @param {string} pDatabase
 * @param {Record<string, any>} pSpec
 * @param {string} [pBuildID]
 * @return {string}
 */
const mirrorDDL = (pDatabase, pSpec, pBuildID) =>
{
	let tmpColumns = mirrorColumns(pSpec);
	pSpec.SortKey.forEach((pColumn) => { specColumn(pSpec, pColumn); });
	let tmpSettings = (hasNullableKey(pSpec, pSpec.SortKey) ? 'allow_nullable_key = 1, ' : '') + MIRROR_SETTINGS;
	return [
		`CREATE TABLE IF NOT EXISTS ${qualified(pDatabase, mirrorTableName(pSpec.Entity, pBuildID))}`,
		'(',
		columnList(tmpColumns, [ '`_Version` UInt64', '`_IsDeleted` UInt8', "`_AppliedAt` DateTime64(3, 'UTC') DEFAULT now64(3)" ]),
		')',
		'ENGINE = ReplacingMergeTree(`_Version`, `_IsDeleted`)',
		`ORDER BY (${pSpec.SortKey.map(quoteIdentifier).join(', ')})`,
		`SETTINGS ${tmpSettings}`,
		`COMMENT '${specComment('mirror', pSpec.Entity, pSpec.SpecHash)}'`
	].join('\n');
};

/**
 * The keymap table (§56.2): the before-image of record, ordered by (identity, sort-key scope columns).
 *
 * @param {string} pDatabase
 * @param {Record<string, any>} pSpec
 * @param {string} [pBuildID]
 * @return {string}
 */
const keymapDDL = (pDatabase, pSpec, pBuildID) =>
{
	let tmpColumns = keymapColumns(pSpec);
	let tmpOrder = keymapOrder(pSpec);
	tmpOrder.forEach(
		(pColumn) =>
		{
			if (!tmpColumns.some((pKeymapColumn) => { return pKeymapColumn.Column === pColumn; }))
			{
				throw new Error('ClickHouse-DDL: a keymap needs every sort-key column.');
			}
		});
	let tmpSettings = (hasNullableKey(pSpec, tmpOrder) ? 'allow_nullable_key = 1, ' : '') + KEYMAP_SETTINGS;
	return [
		`CREATE TABLE IF NOT EXISTS ${qualified(pDatabase, keymapTableName(pSpec.Entity, pBuildID))}`,
		'(',
		columnList(tmpColumns, [ '`_Version` UInt64', '`_IsDeleted` UInt8' ]),
		')',
		'ENGINE = ReplacingMergeTree(`_Version`, `_IsDeleted`)',
		`ORDER BY (${tmpOrder.map(quoteIdentifier).join(', ')})`,
		`SETTINGS ${tmpSettings}`,
		`COMMENT '${specComment('keymap', pSpec.Entity, pSpec.SpecHash)}'`
	].join('\n');
};

/**
 * The per (store, entity) state table, inside the store it describes (04 §8.1, §56.2).
 *
 * @param {string} pDatabase
 * @return {string}
 */
const entityStateDDL = (pDatabase) =>
{
	return [
		`CREATE TABLE IF NOT EXISTS ${qualified(pDatabase, STATE_TABLE)}`,
		'(',
		[
			'`Store` LowCardinality(String)',
			'`Entity` String',
			'`State` LowCardinality(String)',
			'`Epoch` UInt32',
			'`SpecHash` String',
			'`AppliedSeq` String',
			'`CleanShutdown` UInt8',
			'`LossyColumns` String',
			'`FillingColumns` String',
			'`SweepWatermark` Nullable(String)',
			'`ScrubCursor` Nullable(Int64)',
			"`ScrubbedThrough` Nullable(DateTime64(3, 'UTC'))",
			"`LastRebuild` Nullable(DateTime64(3, 'UTC'))",
			"`LastBisect` Nullable(DateTime64(3, 'UTC'))",
			"`UnverifiedSince` Nullable(DateTime64(3, 'UTC'))",
			'`Detail` String',
			'`_Version` UInt64',
			"`_UpdatedAt` DateTime64(3, 'UTC') DEFAULT now64(3)"
		].map((pLine) => { return `\t${pLine}`; }).join(',\n'),
		')',
		'ENGINE = ReplacingMergeTree(`_Version`)',
		'ORDER BY (`Store`, `Entity`)'
	].join('\n');
};

/**
 * The materializer lease (one row per store; the latest _Version wins): which process materializes
 * the store, until when.  A process that does not hold an unexpired lease never writes.
 *
 * @param {string} pDatabase
 * @return {string}
 */
const leaseDDL = (pDatabase) =>
{
	return [
		`CREATE TABLE IF NOT EXISTS ${qualified(pDatabase, LEASE_TABLE)}`,
		'(',
		[
			'`Store` LowCardinality(String)',
			'`Owner` String',
			"`ExpiresAt` DateTime64(3, 'UTC')",
			'`Released` UInt8',
			'`_Version` UInt64',
			"`_UpdatedAt` DateTime64(3, 'UTC') DEFAULT now64(3)"
		].map((pLine) => { return `\t${pLine}`; }).join(',\n'),
		')',
		'ENGINE = ReplacingMergeTree(`_Version`)',
		'ORDER BY (`Store`)'
	].join('\n');
};

/**
 * The database's owner marker (one row per store): the InstanceID and the source fingerprint of the
 * deployment that created it.  A different deployment pointed at the same database is refused.
 *
 * @param {string} pDatabase
 * @return {string}
 */
const ownerDDL = (pDatabase) =>
{
	return [
		`CREATE TABLE IF NOT EXISTS ${qualified(pDatabase, OWNER_TABLE)}`,
		'(',
		[
			'`Store` LowCardinality(String)',
			'`InstanceID` String',
			'`Fingerprint` String',
			'`_Version` UInt64',
			"`_UpdatedAt` DateTime64(3, 'UTC') DEFAULT now64(3)"
		].map((pLine) => { return `\t${pLine}`; }).join(',\n'),
		')',
		'ENGINE = ReplacingMergeTree(`_Version`)',
		'ORDER BY (`Store`)'
	].join('\n');
};

/**
 * Additive ALTER (§55.4): ADD COLUMN IF NOT EXISTS for each column, and the new COMMENT when given.
 * Added columns are always Nullable (never a key column).
 *
 * @param {string} pDatabase
 * @param {string} pTable
 * @param {Array<{ Column: string, Mirror: string }>} pColumns
 * @param {string} [pComment] - a specComment
 * @return {string}
 */
const addColumnsDDL = (pDatabase, pTable, pColumns, pComment) =>
{
	let tmpActions = (Array.isArray(pColumns) ? pColumns : []).map(
		(pColumn) =>
		{
			if (!pColumn || (META_COLUMNS.indexOf(pColumn.Column) >= 0) || !/^Nullable\(/.test(columnType(pColumn.Mirror)))
			{
				throw new Error('ClickHouse-DDL: an added column must be a Nullable, non-meta column.');
			}
			return `ADD COLUMN IF NOT EXISTS ${quoteIdentifier(pColumn.Column)} ${pColumn.Mirror}`;
		});
	if (typeof(pComment) === 'string')
	{
		if (!parseSpecComment(pComment))
		{
			throw new Error('ClickHouse-DDL: an invalid spec comment.');
		}
		tmpActions.push(`MODIFY COMMENT '${pComment}'`);
	}
	if (tmpActions.length < 1)
	{
		throw new Error('ClickHouse-DDL: addColumnsDDL needs at least one column or a comment.');
	}
	return `ALTER TABLE ${qualified(pDatabase, pTable)} ${tmpActions.join(', ')}`;
};

/**
 * @param {string} pDatabase
 * @param {string} pTable
 * @param {string} pComment - a specComment
 * @return {string}
 */
const modifyCommentDDL = (pDatabase, pTable, pComment) =>
{
	return addColumnsDDL(pDatabase, pTable, [], pComment);
};

/**
 * @param {string} pDatabase
 * @param {string} pTableA
 * @param {string} pTableB
 * @return {string}
 */
const exchangeDDL = (pDatabase, pTableA, pTableB) =>
{
	return `EXCHANGE TABLES ${qualified(pDatabase, pTableA)} AND ${qualified(pDatabase, pTableB)}`;
};

/**
 * @param {string} pDatabase
 * @param {string} pFrom
 * @param {string} pTo
 * @return {string}
 */
const renameDDL = (pDatabase, pFrom, pTo) =>
{
	return `RENAME TABLE ${qualified(pDatabase, pFrom)} TO ${qualified(pDatabase, pTo)}`;
};

/**
 * DROP TABLE IF EXISTS … SYNC (an Atomic database otherwise keeps the data for a while).
 *
 * @param {string} pDatabase
 * @param {string} pTable
 * @return {string}
 */
const dropTableDDL = (pDatabase, pTable) =>
{
	return `DROP TABLE IF EXISTS ${qualified(pDatabase, pTable)} SYNC`;
};

module.exports = (
	{
		DDL_VERSION: DDL_VERSION,
		IDENTIFIER_PATTERN: IDENTIFIER_PATTERN,
		META_COLUMNS: META_COLUMNS,
		STATE_TABLE: STATE_TABLE,
		LEASE_TABLE: LEASE_TABLE,
		OWNER_TABLE: OWNER_TABLE,
		KEYMAP_PREFIX: KEYMAP_PREFIX,
		SHADOW_INFIX: SHADOW_INFIX,
		SPEC_HASH_PATTERN: SPEC_HASH_PATTERN,
		MIRROR_TYPE_PATTERN: MIRROR_TYPE_PATTERN,
		sanitizeInstanceKey: sanitizeInstanceKey,
		databaseName: databaseName,
		quoteIdentifier: quoteIdentifier,
		qualified: qualified,
		mirrorTableName: mirrorTableName,
		keymapTableName: keymapTableName,
		createDatabaseDDL: createDatabaseDDL,
		mirrorDDL: mirrorDDL,
		keymapDDL: keymapDDL,
		entityStateDDL: entityStateDDL,
		leaseDDL: leaseDDL,
		ownerDDL: ownerDDL,
		shortHash: shortHash,
		addColumnsDDL: addColumnsDDL,
		modifyCommentDDL: modifyCommentDDL,
		exchangeDDL: exchangeDDL,
		renameDDL: renameDDL,
		dropTableDDL: dropTableDDL,
		specComment: specComment,
		parseSpecComment: parseSpecComment,
		mirrorColumns: mirrorColumns,
		keymapColumns: keymapColumns,
		keymapOrder: keymapOrder
	});
