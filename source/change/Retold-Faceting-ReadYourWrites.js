/**
 * Retold Faceting - Read Your Writes
 *
 * The read-your-writes fallback of design 04 §8.3 while meadow-endpoints returns no
 * X-Retold-Change-Seq (ME-3): the intake reports every change with the writer's principal key; for
 * Freshness.ReadYourWritesMS after a principal's own write, that principal's Bounded / Fast requests
 * are upgraded to Exact.  An explicit MinSeq (any epoch) also upgrades to Exact: the Live path cannot
 * wait for a foreign or future Seq, and generations bump synchronously at intake, so an Exact answer
 * already includes every write the node has seen.  A MinSeq this process cannot prove applied (another
 * epoch, or beyond the local counter) additionally makes the Cache stage skip the lookup and the 304
 * (the answer is computed Live, internal-contracts §51.50).
 *
 *   onChange(pEvent)                                      ChangeIntake subscriber 'ReadYourWrites'
 *   effectiveFreshness(pPrincipal, pFreshness, pNow) → { Mode, MaxLagMS, MinSeq, Requested, Upgrade }
 *   lastWrite(pPrincipal, pNow) → { Seq, At } | null
 *   stats(), clear()
 *
 * Tracking: one entry per principal key, { Seq, At } of its latest write, in a Map kept in write
 * order (a write moves its principal to the newest end), bounded by
 * Freshness.ReadYourWritesMaxPrincipals (the oldest writer is dropped first).  Entries older than
 * ReadYourWritesMS are expired lazily: from the oldest end on every write and stats(), and on
 * lookup.  A notify settle re-delivery (ChangeID '…~settle', internal-contracts §40.5) is the same
 * write again, not a new one, so it does not move the window.  ReadYourWritesMS <= 0 disables the
 * tracker (nothing is recorded, nothing is upgraded for writes; MinSeq still upgrades).
 *
 * Never throws: onChange runs inside the write path (an intake subscriber), effectiveFreshness inside
 * the request pipeline.
 *
 * Contract: internal-contracts §45.  Owner: builder C (M4).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetRequest = require('../contract/Facet-Contract-Request.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');

// The Freshness modes (02 §3.3); the contract module owns the list once the wiring adds it.
const FRESHNESS_MODES = Array.isArray(libFacetRequest.FRESHNESS_MODES) ? libFacetRequest.FRESHNESS_MODES : Object.freeze([ 'Exact', 'Bounded', 'Fast' ]);

// The upgrade reasons (internal-contracts §38.6 Freshness.Upgrade).
const UPGRADE_READ_YOUR_WRITES = 'ReadYourWrites';
const UPGRADE_MIN_SEQ = 'MinSeq';

// The suffix of a notify settle re-delivery's ChangeID (internal-contracts §40.5).
const SETTLE_SUFFIX = '~settle';

class RetoldFacetingReadYourWrites extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingReadYourWrites';

		// principal key → { Seq, At } (Map insertion order = oldest write first); the newest key
		this._Writes = new Map();
		this._Newest = null;
		this._Stats = { Writes: 0, Upgrades: { ReadYourWrites: 0, MinSeq: 0 } };
	}

	/**
	 * Freshness.ReadYourWritesMS (0 when unset or not a positive number: the tracker is off).
	 *
	 * @return {number}
	 */
	windowMS()
	{
		let tmpFreshness = this.options.Freshness || {};
		let tmpWindow = Number(tmpFreshness.ReadYourWritesMS);
		return (Number.isFinite(tmpWindow) && (tmpWindow > 0)) ? tmpWindow : 0;
	}

	/**
	 * Freshness.ReadYourWritesMaxPrincipals (at least 1).
	 *
	 * @return {number}
	 */
	maxPrincipals()
	{
		let tmpFreshness = this.options.Freshness || {};
		let tmpMax = Number(tmpFreshness.ReadYourWritesMaxPrincipals);
		return (Number.isFinite(tmpMax) && (tmpMax >= 1)) ? Math.floor(tmpMax) : 10000;
	}

	/**
	 * The tracking key of a principal: its principalKey (internal-contracts §38.5), or a principal key
	 * string passed as is.
	 *
	 * @param {Record<string, any>|string} pPrincipal
	 * @return {string|null}
	 */
	keyOf(pPrincipal)
	{
		if (typeof(pPrincipal) === 'string')
		{
			return (/^pk:[0-9a-f]{16}$/.test(pPrincipal)) ? pPrincipal : null;
		}
		return libRetoldFacetingUtil.principalKey(pPrincipal);
	}

	/**
	 * Drop expired entries from the oldest end of the Map.
	 *
	 * @param {number} pNow
	 */
	prune(pNow)
	{
		let tmpWindow = this.windowMS();
		let tmpLimit = this.maxPrincipals();
		for (let [ tmpKey, tmpEntry ] of this._Writes)
		{
			let tmpExpired = (tmpWindow <= 0) || ((pNow - tmpEntry.At) > tmpWindow);
			if (!tmpExpired && (this._Writes.size <= tmpLimit))
			{
				break;
			}
			this._Writes.delete(tmpKey);
		}
	}

	/**
	 * Record a write of a principal (a ChangeEvent with Actor.PrincipalKey; internal-contracts §45).
	 * Events without a principal key (DAL-direct notify without a Principal, a failed principal
	 * build) and settle re-deliveries are ignored.  Never throws.
	 *
	 * @param {Record<string, any>} pEvent - a ChangeEvent (internal-contracts §39.2)
	 */
	onChange(pEvent)
	{
		try
		{
			if (!pEvent || (typeof(pEvent) !== 'object') || !pEvent.Actor || (typeof(pEvent.Actor) !== 'object'))
			{
				return;
			}
			let tmpKey = this.keyOf(pEvent.Actor.PrincipalKey);
			if (!tmpKey || (this.windowMS() <= 0))
			{
				return;
			}
			if ((typeof(pEvent.ChangeID) === 'string') && pEvent.ChangeID.endsWith(SETTLE_SUFFIX))
			{
				return;
			}
			let tmpNow = Date.now();
			let tmpSeq = (typeof(pEvent.Seq) === 'string') ? pEvent.Seq : null;
			let tmpEntry = this._Writes.get(tmpKey);
			if (tmpEntry && (this._Newest === tmpKey))
			{
				// Already the newest end (a bulk write: one event per record of one principal): updated in
				// place, no Map re-insertion per record (P3); the write order stays exact.
				tmpEntry.Seq = tmpSeq;
				tmpEntry.At = tmpNow;
			}
			else
			{
				// delete + set moves the principal to the newest end (the Map stays in write order)
				this._Writes.delete(tmpKey);
				this._Writes.set(tmpKey, { Seq: tmpSeq, At: tmpNow });
				this._Newest = tmpKey;
			}
			this._Stats.Writes++;
			this.prune(tmpNow);
		}
		catch (pError)
		{
			this.fable.log.warn(`RetoldFaceting ReadYourWrites: a change could not be recorded: ${pError.message}`);
		}
	}

	/**
	 * The principal's latest write within ReadYourWritesMS, or null (an expired entry is dropped).
	 *
	 * @param {Record<string, any>|string} pPrincipal - a Principal, or its principal key
	 * @param {number} [pNow] - default Date.now()
	 * @return {{ Seq: string|null, At: number }|null}
	 */
	lastWrite(pPrincipal, pNow)
	{
		let tmpKey = this.keyOf(pPrincipal);
		if (!tmpKey || !this._Writes.has(tmpKey))
		{
			return null;
		}
		let tmpNow = Number.isFinite(pNow) ? pNow : Date.now();
		let tmpEntry = this._Writes.get(tmpKey);
		let tmpWindow = this.windowMS();
		if ((tmpWindow <= 0) || ((tmpNow - tmpEntry.At) > tmpWindow))
		{
			this._Writes.delete(tmpKey);
			return null;
		}
		return { Seq: tmpEntry.Seq, At: tmpEntry.At };
	}

	/**
	 * The freshness a request actually runs with (internal-contracts §45):
	 *
	 *   - Requested is the normalized mode (an invalid / absent mode is Freshness.DefaultMode);
	 *   - 'Exact' stays Exact (Upgrade null);
	 *   - a MinSeq (any epoch) → Exact, Upgrade 'MinSeq';
	 *   - else a write of this principal within ReadYourWritesMS → Exact, Upgrade 'ReadYourWrites';
	 *   - else unchanged.
	 *
	 * MaxLagMS is kept (a non-negative integer, else Freshness.MaxLagMS).  MinSeq is returned when it
	 * matches SEQ_PATTERN (the normalizer 400s anything else before this runs; a malformed string from
	 * an in-process caller still upgrades, toward the fresher answer, and is returned as null).
	 * Never throws.
	 *
	 * @param {Record<string, any>} pPrincipal
	 * @param {{ Mode?: string, MaxLagMS?: number, MinSeq?: string|null }} pFreshness - NormalizedRequest.Freshness
	 * @param {number} [pNow] - default Date.now()
	 * @return {{ Mode: string, MaxLagMS: number, MinSeq: string|null, Requested: string, Upgrade: string|null }}
	 */
	effectiveFreshness(pPrincipal, pFreshness, pNow)
	{
		let tmpOptions = this.options.Freshness || {};
		let tmpFreshness = libRetoldFacetingUtil.isPlainObject(pFreshness) ? pFreshness : {};
		let tmpDefaultMode = (FRESHNESS_MODES.indexOf(tmpOptions.DefaultMode) >= 0) ? tmpOptions.DefaultMode : 'Exact';
		let tmpRequested = (FRESHNESS_MODES.indexOf(tmpFreshness.Mode) >= 0) ? tmpFreshness.Mode : tmpDefaultMode;
		let tmpMaxLagMS = (Number.isInteger(tmpFreshness.MaxLagMS) && (tmpFreshness.MaxLagMS >= 0)) ? tmpFreshness.MaxLagMS
			: (Number.isInteger(tmpOptions.MaxLagMS) && (tmpOptions.MaxLagMS >= 0)) ? tmpOptions.MaxLagMS
			: 0;
		let tmpMinSeqAsked = (typeof(tmpFreshness.MinSeq) === 'string') && (tmpFreshness.MinSeq.length > 0);
		let tmpMinSeq = (tmpMinSeqAsked && libRetoldFacetingUtil.SEQ_PATTERN.test(tmpFreshness.MinSeq)) ? tmpFreshness.MinSeq : null;
		let tmpResult = { Mode: tmpRequested, MaxLagMS: tmpMaxLagMS, MinSeq: tmpMinSeq, Requested: tmpRequested, Upgrade: null };
		if (tmpRequested === 'Exact')
		{
			return tmpResult;
		}
		if (tmpMinSeqAsked)
		{
			tmpResult.Mode = 'Exact';
			tmpResult.Upgrade = UPGRADE_MIN_SEQ;
			this._Stats.Upgrades.MinSeq++;
			return tmpResult;
		}
		let tmpLastWrite = null;
		try
		{
			tmpLastWrite = this.lastWrite(pPrincipal, pNow);
		}
		catch (pError)
		{
			// A principal that cannot be keyed is simply not tracked.
			tmpLastWrite = null;
		}
		if (tmpLastWrite)
		{
			tmpResult.Mode = 'Exact';
			tmpResult.Upgrade = UPGRADE_READ_YOUR_WRITES;
			this._Stats.Upgrades.ReadYourWrites++;
		}
		return tmpResult;
	}

	/**
	 * @return {{ Principals: number, Writes: number, Upgrades: { ReadYourWrites: number, MinSeq: number } }}
	 */
	stats()
	{
		this.prune(Date.now());
		return { Principals: this._Writes.size, Writes: this._Stats.Writes, Upgrades: Object.assign({}, this._Stats.Upgrades) };
	}

	/**
	 * Forget every tracked write (tests).
	 */
	clear()
	{
		this._Writes.clear();
		this._Newest = null;
	}
}

module.exports = RetoldFacetingReadYourWrites;
module.exports.serviceType = 'RetoldFacetingReadYourWrites';
module.exports.FRESHNESS_MODES = FRESHNESS_MODES;
