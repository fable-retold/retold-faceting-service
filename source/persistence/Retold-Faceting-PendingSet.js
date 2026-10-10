/**
 * Retold Faceting - PendingSet
 *
 * The IDs one (store, entity) still has to re-read (design 04 §6.2; internal-contracts §58.3):
 * ID → { FirstSeen, LastSeen, Hints, MinSeqN, InFlight } on the LOCAL monotonic clock (never event
 * timestamps); take() marks a batch in flight with a snapshot; ack(pTaken, pReadStart) after the
 * flush removes only entries with LastSeen ≤ readStart and unchanged Hints (a change committed after
 * the read is never acked away); release() returns a failed flush's hints; markDirty / clearDirty
 * drive the whole-entity Resync (unknown IDs, overflow).  Lag is measured from FirstSeen.
 *
 *   add(pID, pSeqN, pNow)            a hint (re-hint: LastSeen = pNow, Hints++, MinSeqN = min; an
 *                                    in-flight entry also records Rehint = { FirstSeen, MinSeqN })
 *   take(pMax)                       oldest FirstSeen first; marks them in flight (O(taken): the
 *                                    available entries are queued apart from the in-flight ones)
 *   oldestAvailableFirstSeen()       how long the oldest un-read hint has waited (cycle batching)
 *   ack(pTaken, pReadStart)          after a successful flush
 *   release(pTaken)                  after a failed flush (the retry is a new cycle)
 *   markDirty(pSeqN, pTenants, pNow) / clearDirty(pGeneration)
 *   size() / inFlight() / available() / info()
 *
 * Overflow (internal-contracts §58.3, §68 #9): more than Materializer.OverflowIDs pending IDs → every
 * entry that is not in flight collapses into the Dirty mark (a whole-entity Resync re-reads them) and
 * the set keeps accepting into a fresh map.
 *
 * Constructed by the Materializer (one per (store, entity)), never registered.  Synchronous, no I/O.
 *
 * Contract: internal-contracts §58.3.  Owner: builder B (M5).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');

/**
 * The lower of two optional sequence numbers (null = none).
 *
 * @param {number|null} pA
 * @param {number|null} pB
 * @return {number|null}
 */
const minSeq = (pA, pB) =>
{
	let tmpA = (typeof(pA) === 'number') && Number.isFinite(pA);
	let tmpB = (typeof(pB) === 'number') && Number.isFinite(pB);
	if (tmpA && tmpB)
	{
		return Math.min(pA, pB);
	}
	return tmpA ? pA : (tmpB ? pB : null);
};

class RetoldFacetingPendingSet extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash] - '<Store>:<Entity>'
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingPendingSet';

		// ID → entry (pending and in flight), in FirstSeen order while _Ordered is true.
		this._Entries = new Map();
		this._Ordered = true;
		// ID → entry of the entries a take() can hand out (never the in-flight ones), in FirstSeen order
		// while _QueueOrdered is true: take() and the oldest available entry are O(taken), never a scan
		// past the in-flight head.
		this._Queue = new Map();
		this._QueueOrdered = true;
		this._InFlight = 0;
		this._Dirty = null;
		this._DirtyGeneration = 0;
		this._Overflow = false;
		this._Overflows = 0;

		let tmpLimit = (this.options.Materializer && (typeof(this.options.Materializer.OverflowIDs) === 'number')) ? this.options.Materializer.OverflowIDs : 100000;
		this.OverflowIDs = (tmpLimit > 0) ? tmpLimit : 100000;
	}

	/**
	 * A hint for one ID.
	 *
	 * @param {any} pID - a safe integer (the Materializer normalizes)
	 * @param {number|null} pSeqN - the change's local Seq counter (null: a foreign or unsequenced hint)
	 * @param {number} pNow - performance.now()
	 */
	add(pID, pSeqN, pNow)
	{
		let tmpSeqN = ((typeof(pSeqN) === 'number') && Number.isFinite(pSeqN)) ? pSeqN : null;
		let tmpEntry = this._Entries.get(pID);
		if (tmpEntry)
		{
			tmpEntry.LastSeen = pNow;
			tmpEntry.Hints++;
			tmpEntry.MinSeqN = minSeq(tmpEntry.MinSeqN, tmpSeqN);
			if (tmpEntry.InFlight)
			{
				// The read in flight may predate this change: the ack keeps the entry, and its lag and
				// AppliedSeq restart from the first hint that arrived while it was in flight.
				if (!tmpEntry.Rehint)
				{
					tmpEntry.Rehint = { FirstSeen: pNow, MinSeqN: tmpSeqN };
				}
				else
				{
					tmpEntry.Rehint.MinSeqN = minSeq(tmpEntry.Rehint.MinSeqN, tmpSeqN);
				}
			}
			return;
		}
		if (this._Queue.size >= this.OverflowIDs)
		{
			this._overflow(pNow);
		}
		let tmpNew = { FirstSeen: pNow, LastSeen: pNow, Hints: 1, MinSeqN: tmpSeqN, InFlight: null, Rehint: null };
		this._Entries.set(pID, tmpNew);
		this._Queue.set(pID, tmpNew);
	}

	/**
	 * Collapse every entry that is not in flight into the Dirty mark (§58.3 overflow).
	 *
	 * @param {number} pNow
	 */
	_overflow(pNow)
	{
		let tmpSince = pNow;
		let tmpMinSeqN = null;
		let tmpDropped = 0;
		this._Queue.forEach(
			(pEntry, pID) =>
			{
				tmpSince = Math.min(tmpSince, pEntry.FirstSeen);
				tmpMinSeqN = minSeq(tmpMinSeqN, pEntry.MinSeqN);
				this._Entries.delete(pID);
				tmpDropped++;
			});
		this._Queue = new Map();
		this._QueueOrdered = true;
		this._Overflow = true;
		this._Overflows++;
		this._markDirty(tmpMinSeqN, [ '*' ], tmpSince);
		this.fable.log.warn(`RetoldFaceting PendingSet ${this.Hash || ''}: more than ${this.OverflowIDs} pending IDs; ${tmpDropped} collapsed into a whole-entity Resync.`);
	}

	/**
	 * Restore FirstSeen order (an ack that kept a re-hinted entry moved its FirstSeen forward).
	 */
	_reorder()
	{
		let tmpEntries = Array.from(this._Entries.entries());
		tmpEntries.sort((pA, pB) => { return pA[1].FirstSeen - pB[1].FirstSeen; });
		this._Entries = new Map(tmpEntries);
		this._Ordered = true;
	}

	/**
	 * Restore the FirstSeen order of the available queue (an ack kept or a release returned entries).
	 */
	_reorderQueue()
	{
		let tmpEntries = Array.from(this._Queue.entries());
		tmpEntries.sort((pA, pB) => { return pA[1].FirstSeen - pB[1].FirstSeen; });
		this._Queue = new Map(tmpEntries);
		this._QueueOrdered = true;
	}

	/**
	 * Take up to pMax pending entries (oldest FirstSeen first) and mark them in flight.
	 *
	 * @param {number} pMax
	 * @return {Array<{ ID: any, Snapshot: { LastSeen: number, Hints: number, MinSeqN: number|null } }>}
	 */
	take(pMax)
	{
		let tmpMax = ((typeof(pMax) === 'number') && (pMax > 0)) ? pMax : Infinity;
		if (!this._QueueOrdered)
		{
			this._reorderQueue();
		}
		let tmpTaken = [];
		for (let [ tmpID, tmpEntry ] of this._Queue)
		{
			if (tmpTaken.length >= tmpMax)
			{
				break;
			}
			tmpEntry.InFlight = { LastSeen: tmpEntry.LastSeen, Hints: tmpEntry.Hints, MinSeqN: tmpEntry.MinSeqN };
			tmpEntry.Rehint = null;
			this._InFlight++;
			tmpTaken.push({ ID: tmpID, Snapshot: tmpEntry.InFlight });
		}
		for (let i = 0; i < tmpTaken.length; i++)
		{
			this._Queue.delete(tmpTaken[i].ID);
		}
		return tmpTaken;
	}

	/**
	 * The FirstSeen of the oldest entry a take() would hand out (null when none): how long the oldest
	 * un-read hint has waited (the WriterLoop starts a stream cycle once it waited a flush interval).
	 *
	 * @return {number|null}
	 */
	oldestAvailableFirstSeen()
	{
		if (this._Queue.size < 1)
		{
			return null;
		}
		if (!this._QueueOrdered)
		{
			this._reorderQueue();
		}
		return this._Queue.values().next().value.FirstSeen;
	}

	/**
	 * After the flush that covered pTaken succeeded: drop the entries no newer hint touched.
	 *
	 * @param {Array<Record<string, any>>} pTaken
	 * @param {number} pReadStart - performance.now() just before the source read
	 * @return {number} entries removed
	 */
	ack(pTaken, pReadStart)
	{
		let tmpRemoved = 0;
		let tmpLast = null;
		(Array.isArray(pTaken) ? pTaken : []).forEach(
			(pTakenEntry) =>
			{
				let tmpEntry = this._Entries.get(pTakenEntry.ID);
				if (!tmpEntry || !tmpEntry.InFlight)
				{
					return;
				}
				tmpEntry.InFlight = null;
				this._InFlight--;
				if ((tmpEntry.LastSeen <= pReadStart) && (tmpEntry.Hints === pTakenEntry.Snapshot.Hints))
				{
					this._Entries.delete(pTakenEntry.ID);
					tmpRemoved++;
					return;
				}
				// A change arrived during (or after) the read: the entry stays for another cycle, with
				// the lag and sequence of the hints the read may have missed.
				if (tmpEntry.Rehint)
				{
					tmpEntry.FirstSeen = tmpEntry.Rehint.FirstSeen;
					tmpEntry.MinSeqN = tmpEntry.Rehint.MinSeqN;
					tmpEntry.Rehint = null;
					tmpLast = tmpEntry;
				}
				this._Queue.set(pTakenEntry.ID, tmpEntry);
				this._QueueOrdered = false;
			});
		if (tmpLast)
		{
			this._Ordered = false;
		}
		return tmpRemoved;
	}

	/**
	 * After a failed flush: the entries stay pending unchanged (the retry is a NEW cycle).
	 *
	 * @param {Array<Record<string, any>>} pTaken
	 */
	release(pTaken)
	{
		(Array.isArray(pTaken) ? pTaken : []).forEach(
			(pTakenEntry) =>
			{
				let tmpEntry = this._Entries.get(pTakenEntry.ID);
				if (!tmpEntry || !tmpEntry.InFlight)
				{
					return;
				}
				tmpEntry.InFlight = null;
				tmpEntry.Rehint = null;
				this._InFlight--;
				this._Queue.set(pTakenEntry.ID, tmpEntry);
				this._QueueOrdered = false;
			});
	}

	/**
	 * Something in the entity changed and the IDs are unknown: a whole-entity Resync is due.
	 *
	 * @param {number|null} pSeqN
	 * @param {Array<any>} pTenants
	 * @param {number} pNow
	 * @return {number} the Dirty generation now in force
	 */
	markDirty(pSeqN, pTenants, pNow)
	{
		return this._markDirty(((typeof(pSeqN) === 'number') && Number.isFinite(pSeqN)) ? pSeqN : null, pTenants, pNow);
	}

	/**
	 * @param {number|null} pSeqN
	 * @param {Array<any>} pTenants
	 * @param {number} pSince
	 * @return {number}
	 */
	_markDirty(pSeqN, pTenants, pSince)
	{
		this._DirtyGeneration++;
		let tmpTenants = Array.isArray(pTenants) ? pTenants : [ '*' ];
		if (!this._Dirty)
		{
			this._Dirty = { Since: pSince, MinSeqN: pSeqN, Tenants: tmpTenants.slice(), Generation: this._DirtyGeneration };
			return this._DirtyGeneration;
		}
		// An existing mark keeps its Since (lag continuity) and its lowest Seq.
		this._Dirty.Since = Math.min(this._Dirty.Since, pSince);
		this._Dirty.MinSeqN = minSeq(this._Dirty.MinSeqN, pSeqN);
		tmpTenants.forEach((pTenant) => { if (this._Dirty.Tenants.indexOf(pTenant) < 0) { this._Dirty.Tenants.push(pTenant); } });
		this._Dirty.Generation = this._DirtyGeneration;
		return this._DirtyGeneration;
	}

	/**
	 * The Resync that started at pGeneration completed: clear the mark unless a newer markDirty
	 * arrived since (then another Resync is due).
	 *
	 * @param {number} pGeneration
	 * @return {boolean} cleared
	 */
	clearDirty(pGeneration)
	{
		if (!this._Dirty || (this._Dirty.Generation !== pGeneration))
		{
			return false;
		}
		this._Dirty = null;
		this._Overflow = false;
		return true;
	}

	/**
	 * @return {Record<string, any>|null} the Dirty mark (a copy)
	 */
	dirty()
	{
		return this._Dirty ? Object.assign({}, this._Dirty, { Tenants: this._Dirty.Tenants.slice() }) : null;
	}

	/**
	 * Is this ID pending (or in flight)?
	 *
	 * @param {any} pID
	 * @return {boolean}
	 */
	has(pID)
	{
		return this._Entries.has(pID);
	}

	/**
	 * @return {number} entries pending or in flight
	 */
	size()
	{
		return this._Entries.size;
	}

	/**
	 * @return {number} entries in flight
	 */
	inFlight()
	{
		return this._InFlight;
	}

	/**
	 * @return {number} entries a take() can hand out
	 */
	available()
	{
		return this._Queue.size;
	}

	/**
	 * The oldest FirstSeen (O(1) while the map is in FirstSeen order, else a scan).
	 *
	 * @return {number|null}
	 */
	oldestFirstSeen()
	{
		if (this._Entries.size < 1)
		{
			return null;
		}
		if (this._Ordered)
		{
			return this._Entries.values().next().value.FirstSeen;
		}
		let tmpOldest = null;
		this._Entries.forEach((pEntry) => { tmpOldest = (tmpOldest === null) ? pEntry.FirstSeen : Math.min(tmpOldest, pEntry.FirstSeen); });
		return tmpOldest;
	}

	/**
	 * @param {{ Light?: boolean }} [pOptions] - Light: skip the MinSeqN scan (the request path needs only
	 *        counts, the oldest FirstSeen and the Dirty mark; MinSeqN is for AppliedSeq after a flush)
	 * @return {{ Pending: number, InFlight: number, OldestFirstSeen: number|null, MinSeqN: number|null, Dirty: Record<string, any>|null, Overflow: boolean }}
	 */
	info(pOptions)
	{
		let tmpOldest = this.oldestFirstSeen();
		let tmpMinSeqN = null;
		if (!(pOptions && pOptions.Light))
		{
			this._Entries.forEach(
				(pEntry) =>
				{
					tmpMinSeqN = minSeq(tmpMinSeqN, pEntry.MinSeqN);
					if (pEntry.Rehint)
					{
						tmpMinSeqN = minSeq(tmpMinSeqN, pEntry.Rehint.MinSeqN);
					}
				});
		}
		return (
			{
				Pending: this._Entries.size - this._InFlight,
				InFlight: this._InFlight,
				OldestFirstSeen: tmpOldest,
				MinSeqN: tmpMinSeqN,
				Dirty: this.dirty(),
				Overflow: this._Overflow
			});
	}

	/**
	 * Forget everything (a crash, tests).
	 */
	clear()
	{
		this._Entries = new Map();
		this._Ordered = true;
		this._Queue = new Map();
		this._QueueOrdered = true;
		this._InFlight = 0;
		this._Dirty = null;
		this._Overflow = false;
	}
}

module.exports = RetoldFacetingPendingSet;
module.exports.serviceType = 'RetoldFacetingPendingSet';
module.exports.minSeq = minSeq;
