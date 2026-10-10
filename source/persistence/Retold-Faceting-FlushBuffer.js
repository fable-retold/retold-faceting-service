/**
 * Retold Faceting - FlushBuffer
 *
 * The cycles a (store, entity) WriterLoop has diffed but not yet written (design 04 §6.1 step 7;
 * internal-contracts §58.6): rows, tombstones, keymap intents and retirements per target, plus the
 * covered hints of every cycle.  It is due when FlushIntervalMS has passed since its first append, or
 * it holds FlushRows rows, or a flushNow() asks; a flush writes, per target and in this order, the
 * keymap intents, ONE mirror INSERT carrying rows AND tombstones, the keymap retirements, each with
 * the token '<Entity>:<FlushID>:<Target>:<K|M|R><chunk>' (FlushID = the first cycle's _Version).
 *
 *   append(pTarget, pBatch, pCycle)   one target's share of one cycle (a cycle that writes two targets
 *                                     appends twice with the SAME pCycle object; it is counted once)
 *   due(pNow) / size() / rows() / take()
 *   keys(pTarget, pID, pStoreKeys)    the before-image of record: the store's live keymap keys of an ID
 *                                     with this buffer's not-yet-flushed intents and retirements applied
 *                                     in cycle order (a later cycle of the same ID must see the earlier
 *                                     cycle's keys, or a row moved twice inside one flush window would
 *                                     leave a ghost at its first key)
 *
 * Batch entries are ready-to-insert table rows (internal-contracts §58.6 as built by the WriterLoop):
 *   Rows        every spec column + _Version + _IsDeleted 0
 *   Tombstones  identity + sort-key columns, every other spec column NULL, _Version, _IsDeleted 1
 *   KeyIntents  every keymap column + _Version + _IsDeleted 0
 *   KeyRetires  identity + sort-key scope columns, every other keymap column NULL, _Version, _IsDeleted 1
 *
 * Constructed by the Materializer (one per (store, entity)), never registered.  Synchronous, no I/O.
 *
 * Contract: internal-contracts §58.6.  Owner: builder B (M5).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');

/**
 * An empty per-target batch.
 *
 * @return {{ Rows: Array<any>, Tombstones: Array<any>, KeyIntents: Array<any>, KeyRetires: Array<any> }}
 */
const emptyBatch = () =>
{
	return { Rows: [], Tombstones: [], KeyIntents: [], KeyRetires: [] };
};

/**
 * A stable text for a sort-key scope tuple (the keymap key minus the identity).
 *
 * @param {Array<string>} pKeyColumns
 * @param {Record<string, any>} pRow
 * @return {string}
 */
const keyText = (pKeyColumns, pRow) =>
{
	let tmpValues = [];
	for (let i = 0; i < pKeyColumns.length; i++)
	{
		let tmpValue = pRow ? pRow[pKeyColumns[i]] : null;
		if ((typeof(tmpValue) === 'undefined') || (tmpValue === null))
		{
			tmpValues.push(null);
		}
		else if (typeof(tmpValue) === 'bigint')
		{
			tmpValues.push(Number.isSafeInteger(Number(tmpValue)) ? Number(tmpValue) : String(tmpValue));
		}
		else if ((typeof(tmpValue) === 'string') && /^-?(0|[1-9][0-9]{0,15})$/.test(tmpValue) && Number.isSafeInteger(Number(tmpValue)))
		{
			// Int64 values come back from ClickHouse as numbers (or decimal strings beyond 2^53).
			tmpValues.push(Number(tmpValue));
		}
		else
		{
			tmpValues.push(tmpValue);
		}
	}
	return JSON.stringify(tmpValues);
};

class RetoldFacetingFlushBuffer extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash] - '<Store>:<Entity>'
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingFlushBuffer';

		let tmpMaterializer = this.options.Materializer || {};
		this.FlushIntervalMS = (typeof(tmpMaterializer.FlushIntervalMS) === 'number') ? tmpMaterializer.FlushIntervalMS : 1000;
		// ×n while the store has too many active parts (merge back-pressure, the Materializer sets it).
		this.Stretch = 1;
		this.FlushRows = ((typeof(tmpMaterializer.FlushRows) === 'number') && (tmpMaterializer.FlushRows > 0)) ? tmpMaterializer.FlushRows : 50000;

		// The identity column and the sort-key scope columns (setKeyColumns), for the key overlay.
		this._Identity = null;
		this._KeyColumns = [];

		this._reset();
	}

	/**
	 * Empty the buffer.
	 */
	_reset()
	{
		this._Cycles = [];
		this._CycleSet = new Set();
		this._Targets = {};
		this._Rows = 0;
		this._FirstAppendAt = null;
		// Target → ID → [ { Op: 'Intent' | 'Retire', Text, Key, Row } … ] in append (cycle) order.
		this._Overlay = {};
	}

	/**
	 * Tell the buffer which columns form a keymap key (the WriterLoop calls it whenever its spec changes).
	 *
	 * @param {string} pIdentity
	 * @param {Array<string>} pKeyColumns - the sort-key columns without the identity
	 */
	setKeyColumns(pIdentity, pKeyColumns)
	{
		this._Identity = pIdentity;
		this._KeyColumns = Array.isArray(pKeyColumns) ? pKeyColumns.slice() : [];
	}

	/**
	 * Add one target's share of one cycle.
	 *
	 * @param {string} pTarget
	 * @param {{ Rows: Array<any>, Tombstones: Array<any>, KeyIntents: Array<any>, KeyRetires: Array<any> }} pBatch
	 * @param {{ Version: number, ReadStart: number, Taken: Array<any> }} pCycle
	 * @param {number} [pNow] - Date.now() (the due clock)
	 * @param {Array<string>} [pKeyColumns] - this target's sort-key scope columns (default: setKeyColumns)
	 */
	append(pTarget, pBatch, pCycle, pNow, pKeyColumns)
	{
		let tmpKeyColumns = Array.isArray(pKeyColumns) ? pKeyColumns : this._KeyColumns;
		let tmpBatch = pBatch || emptyBatch();
		if (!this._Targets[pTarget])
		{
			this._Targets[pTarget] = emptyBatch();
		}
		let tmpTarget = this._Targets[pTarget];
		[ 'Rows', 'Tombstones', 'KeyIntents', 'KeyRetires' ].forEach(
			(pPart) =>
			{
				let tmpEntries = Array.isArray(tmpBatch[pPart]) ? tmpBatch[pPart] : [];
				for (let i = 0; i < tmpEntries.length; i++)
				{
					tmpTarget[pPart].push(tmpEntries[i]);
				}
			});
		this._Rows += (Array.isArray(tmpBatch.Rows) ? tmpBatch.Rows.length : 0) + (Array.isArray(tmpBatch.Tombstones) ? tmpBatch.Tombstones.length : 0);
		if (pCycle && !this._CycleSet.has(pCycle))
		{
			this._CycleSet.add(pCycle);
			this._Cycles.push(pCycle);
		}
		if (this._FirstAppendAt === null)
		{
			this._FirstAppendAt = (typeof(pNow) === 'number') ? pNow : Date.now();
		}
		// The key overlay, in cycle order: intents add a key, retirements remove one.
		if (this._Identity)
		{
			if (!this._Overlay[pTarget])
			{
				this._Overlay[pTarget] = new Map();
			}
			let tmpOverlay = this._Overlay[pTarget];
			let fRecord = (pOp, pRow) =>
			{
				let tmpID = pRow[this._Identity];
				let tmpList = tmpOverlay.get(tmpID);
				if (!tmpList)
				{
					tmpList = [];
					tmpOverlay.set(tmpID, tmpList);
				}
				tmpList.push({ Op: pOp, Text: keyText(tmpKeyColumns, pRow), Row: pRow, KeyColumns: tmpKeyColumns });
			};
			(Array.isArray(tmpBatch.KeyIntents) ? tmpBatch.KeyIntents : []).forEach((pRow) => { fRecord('Intent', pRow); });
			(Array.isArray(tmpBatch.KeyRetires) ? tmpBatch.KeyRetires : []).forEach((pRow) => { fRecord('Retire', pRow); });
		}
	}

	/**
	 * The live keymap keys of an ID in a target after this buffer's pending changes.
	 *
	 * @param {string} pTarget
	 * @param {any} pID
	 * @param {Array<{ Key: Record<string, any>, Tracked?: Record<string, any>, UpdateDate?: any, Version?: number }>} pStoreKeys
	 * @param {Array<string>} [pKeyColumns] - this target's sort-key scope columns (default: setKeyColumns)
	 * @return {Array<{ Key: Record<string, any>, Tracked?: Record<string, any>, UpdateDate?: any, Version?: number, Buffered?: boolean }>}
	 */
	keys(pTarget, pID, pStoreKeys, pKeyColumns)
	{
		let tmpKeyColumns = Array.isArray(pKeyColumns) ? pKeyColumns : this._KeyColumns;
		let tmpKeys = Array.isArray(pStoreKeys) ? pStoreKeys.slice() : [];
		let tmpOverlay = this._Overlay[pTarget];
		let tmpOps = tmpOverlay ? tmpOverlay.get(pID) : null;
		if (!tmpOps || (tmpOps.length < 1))
		{
			return tmpKeys;
		}
		let tmpByText = new Map();
		tmpKeys.forEach((pKey) => { tmpByText.set(keyText(tmpKeyColumns, pKey.Key), pKey); });
		for (let i = 0; i < tmpOps.length; i++)
		{
			let tmpOp = tmpOps[i];
			if (tmpOp.Op === 'Retire')
			{
				tmpByText.delete(tmpOp.Text);
				continue;
			}
			let tmpKey = {};
			tmpKeyColumns.forEach((pColumn) => { tmpKey[pColumn] = tmpOp.Row[pColumn]; });
			tmpByText.set(tmpOp.Text, { Key: tmpKey, Tracked: Object.assign({}, tmpOp.Row), UpdateDate: tmpOp.Row.UpdateDate, Version: tmpOp.Row._Version, Buffered: true });
		}
		return Array.from(tmpByText.values());
	}

	/**
	 * Is a flush due?  FlushIntervalMS since the first append, or FlushRows buffered rows.
	 *
	 * @param {number} pNow - Date.now()
	 * @return {boolean}
	 */
	due(pNow)
	{
		if (this._Cycles.length < 1)
		{
			return false;
		}
		if (this._Rows >= this.FlushRows)
		{
			return true;
		}
		return (typeof(pNow) === 'number') && (this._FirstAppendAt !== null) && ((pNow - this._FirstAppendAt) >= this.intervalMS());
	}

	/**
	 * Milliseconds until the interval makes a flush due (0 when due now; null when empty).
	 *
	 * @param {number} pNow
	 * @return {number|null}
	 */
	dueInMS(pNow)
	{
		if (this._Cycles.length < 1)
		{
			return null;
		}
		if (this.due(pNow))
		{
			return 0;
		}
		return Math.max(0, this.intervalMS() - (pNow - this._FirstAppendAt));
	}

	/**
	 * @return {number} buffered cycles
	 */
	size()
	{
		return this._Cycles.length;
	}

	/**
	 * @return {number} buffered rows (rows + tombstones, every target)
	 */
	rows()
	{
		return this._Rows;
	}

	/**
	 * Take everything buffered (the flush owns it from here).
	 *
	 * @return {{ FlushID: string|null, Targets: Record<string, Record<string, Array<any>>>, Cycles: Array<any>, Rows: number }}
	 */
	take()
	{
		let tmpCycles = this._Cycles;
		let tmpTaken = (
			{
				FlushID: (tmpCycles.length > 0) ? String(tmpCycles[0].Version) : null,
				Targets: this._Targets,
				Cycles: tmpCycles,
				Rows: this._Rows
			});
		this._reset();
		return tmpTaken;
	}

	/**
	 * @return {boolean} a buffered cycle belongs to a Range task (its caller waits for the flush)
	 */
	hasTaskCycle(pKinds)
	{
		for (let i = 0; i < this._Cycles.length; i++)
		{
			if (this._Cycles[i] && this._Cycles[i].Task && (!Array.isArray(pKinds) || (pKinds.indexOf(this._Cycles[i].Task.Kind) >= 0)))
			{
				return true;
			}
		}
		return false;
	}

	/**
	 * The flush interval in force (FlushIntervalMS × Stretch).
	 *
	 * @return {number}
	 */
	intervalMS()
	{
		return this.FlushIntervalMS * Math.max(1, this.Stretch || 1);
	}

	/**
	 * Stretch the flush interval (merge back-pressure: too many active parts in the store).
	 *
	 * @param {number} pFactor - 1 = normal
	 */
	setStretch(pFactor)
	{
		this.Stretch = (Number.isFinite(pFactor) && (pFactor >= 1)) ? pFactor : 1;
	}

	/**
	 * The IDs with buffered (unflushed) keymap changes in a target.
	 *
	 * @param {string} pTarget
	 * @return {Array<any>}
	 */
	bufferedIDs(pTarget)
	{
		let tmpOverlay = this._Overlay[pTarget];
		return tmpOverlay ? Array.from(tmpOverlay.keys()) : [];
	}

	/**
	 * Drop one target's buffered writes (an aborted rebuild's shadow); the cycles stay.
	 *
	 * @param {string} pTarget
	 */
	dropTarget(pTarget)
	{
		if (this._Targets[pTarget])
		{
			this._Rows -= this._Targets[pTarget].Rows.length + this._Targets[pTarget].Tombstones.length;
			delete this._Targets[pTarget];
		}
		delete this._Overlay[pTarget];
	}
}

module.exports = RetoldFacetingFlushBuffer;
module.exports.serviceType = 'RetoldFacetingFlushBuffer';
module.exports.keyText = keyText;
module.exports.emptyBatch = emptyBatch;
