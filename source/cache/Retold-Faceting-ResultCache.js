/**
 * Retold Faceting - Result Cache
 *
 * The in-memory answer cache (design 05 §7): a Map-based LRU of whole Query envelopes, bounded by
 * entries and by bytes, keyed by the CacheKey (plan, captured scope, BindHash, role set, engine
 * class; never a SessionID) and validated at read against the GenVector of the request.  Freshness:
 *
 *   Exact    serve an entry only when its GenVector equals the current one;
 *   Bounded  also serve the latest entry of the key, Stale, while its age ≤ MaxLagMS;
 *   Fast     also serve it while its age ≤ Cache.MaxAgeMS;
 *
 * and a stale serve starts at most ONE background refresh per key (single flight).  Errors and Opaque
 * answers are never stored (the wiring's post checks; set() also refuses anything that is not a
 * well-formed entry, and flights never retain a result).  cachetrax is deliberately not used
 * (05 §7, [UPSTREAM CT-1]).
 *
 * Entries hold the envelope as a JSON string (Body): a hit parses a fresh copy, so no caller can
 * ever mutate the stored answer.
 *
 * Recency is a use stamp on each slot (get / set stamp it), never a Map re-insertion (a hot key's
 * delete + set degrades a large V8 Map); eviction drops the least recently used of the
 * EVICTION_SAMPLE oldest-inserted entries (approximate LRU, exact for small caches).  At most
 * Cache.MaxConcurrentRefreshes background refreshes run at once: beyond that a Stale serve starts
 * none (the stale answer keeps being served until a slot frees).
 *
 * Contract: internal-contracts §43 (entry §43.1, bounds §43.2, lookup §43.3, single flight §43.4,
 * metrics §43.5, API §43.6).  Owner: builder A (M4).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');

// Lookup statuses (internal-contracts §43.3).
const LOOKUP_STATUSES = Object.freeze([ 'Hit', 'Stale', 'Miss' ]);

// Freshness modes (02 §3.3); anything else is treated as Exact (never stale).
const FRESHNESS_MODES = Object.freeze([ 'Exact', 'Bounded', 'Fast' ]);

// Bookkeeping overhead added to every entry's Body bytes (internal-contracts §43.1).
const ENTRY_OVERHEAD_BYTES = 512;

// A refresh that never called back stops blocking new refreshes of its key after this long.
const MIN_REFRESH_STALL_MS = 60000;

// Longest Bypass reason counted as its own metric (anything longer is counted as 'Other').
const MAX_REASON_LENGTH = 64;

// How many of the oldest-inserted entries one eviction step compares (approximate LRU).
const EVICTION_SAMPLE = 16;

// Background refreshes in flight at once (Cache.MaxConcurrentRefreshes default).
const DEFAULT_MAX_CONCURRENT_REFRESHES = 4;

/**
 * A non-negative integer option, else the default.
 *
 * @param {any} pValue
 * @param {number} pDefault
 * @return {number}
 */
const nonNegativeInteger = (pValue, pDefault) =>
{
	return (Number.isSafeInteger(pValue) && (pValue >= 0)) ? pValue : pDefault;
};

class RetoldFacetingResultCache extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingResultCache';

		// Key → { Entry: <frozen entry>, Used } (insertion order; recency is the Used stamp)
		this._Entries = new Map();
		this._UseClock = 0;
		this._Bytes = 0;
		// Key → Date.now() at start, for every key with a background refresh in flight
		this._Refreshing = new Map();
		// Flight key → { Waiters: [ fCallback … ] }
		this._Flights = new Map();
		this._Stats =
			{
				Hits: 0, StaleHits: 0, Misses: 0, Stores: 0, Rejected: 0, Evictions: 0, Expired: 0,
				Refreshes: 0, RefreshErrors: 0, RefreshesSkipped: 0, Flights: 0, NotModified: 0, Bypass: {}
			};
	}

	/**
	 * The Cache options (bounds) with their defaults.
	 *
	 * @return {{ MaxEntries: number, MaxBytes: number, MaxEntryBytes: number, MaxAgeMS: number }}
	 */
	_bounds()
	{
		let tmpCache = this.options.Cache || {};
		return (
			{
				MaxEntries: nonNegativeInteger(tmpCache.MaxEntries, 5000),
				MaxBytes: nonNegativeInteger(tmpCache.MaxBytes, 67108864),
				MaxEntryBytes: nonNegativeInteger(tmpCache.MaxEntryBytes, 4194304),
				MaxAgeMS: nonNegativeInteger(tmpCache.MaxAgeMS, 600000)
			});
	}

	/**
	 * Remove one entry and its bytes.
	 *
	 * @param {string} pKey
	 * @return {boolean} true when an entry was removed
	 */
	_remove(pKey)
	{
		let tmpSlot = this._Entries.get(pKey);
		if (!tmpSlot)
		{
			return false;
		}
		this._Entries.delete(pKey);
		this._Bytes -= tmpSlot.Entry.Bytes;
		if (this._Bytes < 0)
		{
			this._Bytes = 0;
		}
		return true;
	}

	/**
	 * Is an entry older than Cache.MaxAgeMS at pNow?
	 *
	 * @param {Record<string, any>} pEntry
	 * @param {number} pNow
	 * @return {boolean}
	 */
	_expired(pEntry, pNow)
	{
		return (pNow - pEntry.CreatedAt) > this._bounds().MaxAgeMS;
	}

	/**
	 * The entry of a key at pNow: recency refreshed, or deleted (and counted) when expired.
	 *
	 * @param {string} pKey
	 * @param {number} pNow
	 * @return {Record<string, any>|null}
	 */
	_get(pKey, pNow)
	{
		let tmpSlot = this._Entries.get(pKey);
		if (!tmpSlot)
		{
			return null;
		}
		if (this._expired(tmpSlot.Entry, pNow))
		{
			this._remove(pKey);
			this._Stats.Expired++;
			return null;
		}
		tmpSlot.Used = ++this._UseClock;
		return tmpSlot.Entry;
	}

	/**
	 * The key of the least recently used of the EVICTION_SAMPLE oldest-inserted entries.
	 *
	 * @return {string|null}
	 */
	_victim()
	{
		let tmpVictimKey = null;
		let tmpVictimUsed = Infinity;
		let tmpSeen = 0;
		for (let [ tmpKey, tmpSlot ] of this._Entries)
		{
			if (tmpSlot.Used < tmpVictimUsed)
			{
				tmpVictimKey = tmpKey;
				tmpVictimUsed = tmpSlot.Used;
			}
			tmpSeen++;
			if (tmpSeen >= EVICTION_SAMPLE)
			{
				break;
			}
		}
		return tmpVictimKey;
	}

	/**
	 * @param {string} pKey
	 * @return {Record<string, any>|null} the entry (recency refreshed; expired entries deleted)
	 */
	get(pKey)
	{
		return this._get(pKey, Date.now());
	}

	/**
	 * Store (or replace) the entry of a key, then evict to the bounds (internal-contracts §43.2).
	 * Refused (false): a malformed entry (no Body string, no GenVectorHash, an Errors / Error flag), an
	 * entry over Cache.MaxEntryBytes (Rejected), or an existing live entry with a larger MaxTick (a
	 * slow compute never overwrites a newer answer).
	 *
	 * @param {string} pKey
	 * @param {Record<string, any>} pEntry - internal-contracts §43.1
	 * @return {boolean} true when the entry is stored (and survived eviction)
	 */
	set(pKey, pEntry)
	{
		if ((typeof(pKey) !== 'string') || (pKey.length < 1) || !libRetoldFacetingUtil.isPlainObject(pEntry)
			|| (typeof(pEntry.Body) !== 'string') || (typeof(pEntry.GenVectorHash) !== 'string')
			|| (pEntry.Error !== undefined) || (libRetoldFacetingUtil.isPlainObject(pEntry.Meta) && (pEntry.Meta.Errors > 0)))
		{
			// Never an error, never something that is not an answer (internal-contracts §42.3 / §44.6).
			return false;
		}
		let tmpBounds = this._bounds();
		let tmpNow = Date.now();
		let tmpEntry = Object.assign({}, pEntry,
			{
				Key: pKey,
				MaxTick: (typeof(pEntry.MaxTick) === 'number') && Number.isFinite(pEntry.MaxTick) ? pEntry.MaxTick : 0,
				Bytes: Buffer.byteLength(pEntry.Body, 'utf8') + ENTRY_OVERHEAD_BYTES,
				CreatedAt: (typeof(pEntry.CreatedAt) === 'number') && Number.isFinite(pEntry.CreatedAt) ? pEntry.CreatedAt : tmpNow
			});
		if (tmpEntry.Bytes > tmpBounds.MaxEntryBytes)
		{
			this._Stats.Rejected++;
			return false;
		}
		let tmpExisting = this._Entries.get(pKey);
		if (tmpExisting && !this._expired(tmpExisting.Entry, tmpNow) && (tmpExisting.Entry.MaxTick > tmpEntry.MaxTick))
		{
			// The stored answer saw a later write than this one: keep it.
			return false;
		}
		this._remove(pKey);
		this._Entries.set(pKey, { Entry: Object.freeze(tmpEntry), Used: ++this._UseClock });
		this._Bytes += tmpEntry.Bytes;
		this._Stats.Stores++;
		while ((this._Entries.size > 0) && ((this._Entries.size > tmpBounds.MaxEntries) || (this._Bytes > tmpBounds.MaxBytes)))
		{
			this._remove(this._victim());
			this._Stats.Evictions++;
		}
		return this._Entries.has(pKey);
	}

	/**
	 * @param {string} pKey
	 */
	delete(pKey)
	{
		this._remove(pKey);
	}

	/**
	 * Drop every entry (model reloads, tests).  Metrics are kept.
	 */
	clear()
	{
		this._Entries.clear();
		this._Bytes = 0;
	}

	/**
	 * Freshness lookup (internal-contracts §43.3):
	 *
	 *   no entry (or expired)                 Miss    Miss     Miss
	 *   same GenVector                        Hit     Hit      Hit
	 *   vector differs, age ≤ MaxLagMS        Miss    Stale    Stale
	 *   vector differs, age > MaxLagMS        Miss    Miss     Stale (until Cache.MaxAgeMS expires it)
	 *                                         Exact   Bounded  Fast
	 *
	 * LagMS is the entry's age for Stale (an upper bound of its staleness), 0 for Hit.
	 *
	 * @param {string} pKey
	 * @param {{ Hash: string, MaxTick?: number }} pGenVector - the request's current vector
	 * @param {{ Mode: string, MaxLagMS?: number }} pFreshness - the EFFECTIVE freshness (§45)
	 * @param {number} [pNow] - Date.now()
	 * @return {{ Status: string, Entry: Record<string, any>|null, LagMS: number }}
	 */
	lookup(pKey, pGenVector, pFreshness, pNow)
	{
		let tmpNow = ((typeof(pNow) === 'number') && Number.isFinite(pNow)) ? pNow : Date.now();
		let tmpEntry = (typeof(pKey) === 'string') ? this._get(pKey, tmpNow) : null;
		if (!tmpEntry)
		{
			this._Stats.Misses++;
			return { Status: 'Miss', Entry: null, LagMS: 0 };
		}
		let tmpHash = (pGenVector && (typeof(pGenVector.Hash) === 'string')) ? pGenVector.Hash : null;
		if ((tmpHash !== null) && (tmpEntry.GenVectorHash === tmpHash))
		{
			this._Stats.Hits++;
			return { Status: 'Hit', Entry: tmpEntry, LagMS: 0 };
		}
		let tmpFreshness = libRetoldFacetingUtil.isPlainObject(pFreshness) ? pFreshness : {};
		let tmpMode = (FRESHNESS_MODES.indexOf(tmpFreshness.Mode) >= 0) ? tmpFreshness.Mode : 'Exact';
		let tmpDefaultLag = (this.options.Freshness && Number.isSafeInteger(this.options.Freshness.MaxLagMS)) ? this.options.Freshness.MaxLagMS : 0;
		let tmpMaxLagMS = nonNegativeInteger(tmpFreshness.MaxLagMS, tmpDefaultLag);
		let tmpAge = Math.max(0, tmpNow - tmpEntry.CreatedAt);
		let tmpStale = (tmpMode === 'Fast') || ((tmpMode === 'Bounded') && (tmpAge <= tmpMaxLagMS));
		if ((tmpHash === null) || !tmpStale)
		{
			// Exact never takes an entry whose vector differs (so it never returns a stale answer).
			this._Stats.Misses++;
			return { Status: 'Miss', Entry: null, LagMS: 0 };
		}
		this._Stats.StaleHits++;
		return { Status: 'Stale', Entry: tmpEntry, LagMS: tmpAge };
	}

	/**
	 * Is a background refresh of this key in flight?
	 *
	 * @param {string} pKey
	 * @return {boolean}
	 */
	refreshing(pKey)
	{
		if (!this._Refreshing.has(pKey))
		{
			return false;
		}
		let tmpLimits = this.options.Limits || {};
		let tmpStallMS = Math.max(MIN_REFRESH_STALL_MS, 2 * nonNegativeInteger(tmpLimits.TimeoutMS, 0));
		if ((Date.now() - this._Refreshing.get(pKey)) > tmpStallMS)
		{
			// A refresh that never called back must not block its key forever.
			this._Refreshing.delete(pKey);
			return false;
		}
		return true;
	}

	/**
	 * Start a background refresh of a key unless one is in flight (internal-contracts §43.4).  fWork
	 * runs on the next turn of the event loop (after the stale answer is on its way); fDone(pError)
	 * clears the flag (once); an error is logged and counted (RefreshErrors), never thrown.
	 *
	 * @param {string} pKey
	 * @param {(fDone: (pError?: Error) => void) => void} fWork
	 * @return {boolean} true when started
	 */
	refresh(pKey, fWork)
	{
		if ((typeof(pKey) !== 'string') || (typeof(fWork) !== 'function') || this.refreshing(pKey))
		{
			return false;
		}
		let tmpCache = this.options.Cache || {};
		let tmpMaxRefreshes = (Number.isSafeInteger(tmpCache.MaxConcurrentRefreshes) && (tmpCache.MaxConcurrentRefreshes > 0)) ? tmpCache.MaxConcurrentRefreshes : DEFAULT_MAX_CONCURRENT_REFRESHES;
		if (this._Refreshing.size >= tmpMaxRefreshes)
		{
			// The stale answer keeps being served; a later stale serve starts the refresh (P5).
			this._Stats.RefreshesSkipped++;
			return false;
		}
		let tmpStartedAt = Date.now();
		this._Refreshing.set(pKey, tmpStartedAt);
		this._Stats.Refreshes++;
		let tmpDone = false;
		let fDone = (pError) =>
		{
			if (tmpDone)
			{
				return;
			}
			tmpDone = true;
			// Only this refresh's own flag (shutdown or a stall may have handed the key to another one).
			if (this._Refreshing.get(pKey) === tmpStartedAt)
			{
				this._Refreshing.delete(pKey);
			}
			if (pError)
			{
				this._Stats.RefreshErrors++;
				this.fable.log.warn(`RetoldFaceting ResultCache: a background refresh of ${pKey.slice(0, 15)} failed: ${pError.Code || pError.message || pError}`);
			}
		};
		setImmediate(
			() =>
			{
				try
				{
					fWork(fDone);
				}
				catch (pWorkError)
				{
					fDone(pWorkError || new Error('refresh failed'));
				}
			});
		return true;
	}

	/**
	 * Single flight: concurrent callers with one flight key share one fWork run and all receive its
	 * (pError, pResult); the first caller gets pCoalesced false, every joiner true (internal-contracts
	 * §43.4).  Nothing is retained after the work calls back (an error is never cached), and a
	 * waiter's exception never starves the other waiters (the first one is rethrown after all ran).
	 *
	 * @param {string} pFlightKey
	 * @param {(fDone: (pError?: Error, pResult?: any) => void) => void} fWork
	 * @param {(pError?: Error, pResult?: any, pCoalesced?: boolean) => void} fCallback
	 */
	flight(pFlightKey, fWork, fCallback)
	{
		let tmpExisting = this._Flights.get(pFlightKey);
		if (tmpExisting)
		{
			tmpExisting.Waiters.push({ Callback: fCallback, Coalesced: true });
			return;
		}
		let tmpFlight = { Waiters: [ { Callback: fCallback, Coalesced: false } ], Done: false };
		this._Flights.set(pFlightKey, tmpFlight);
		this._Stats.Flights++;
		let fDone = (pError, pResult) =>
		{
			if (tmpFlight.Done)
			{
				return;
			}
			tmpFlight.Done = true;
			if (this._Flights.get(pFlightKey) === tmpFlight)
			{
				this._Flights.delete(pFlightKey);
			}
			let tmpFirstThrown = null;
			tmpFlight.Waiters.forEach(
				(pWaiter) =>
				{
					try
					{
						pWaiter.Callback(pError || null, pResult, pWaiter.Coalesced);
					}
					catch (pCallbackError)
					{
						if (tmpFirstThrown === null)
						{
							tmpFirstThrown = pCallbackError;
						}
					}
				});
			if (tmpFirstThrown !== null)
			{
				throw tmpFirstThrown;
			}
		};
		let tmpThrown = null;
		try
		{
			fWork(fDone);
		}
		catch (pWorkError)
		{
			tmpThrown = pWorkError;
		}
		if ((tmpThrown !== null) && !tmpFlight.Done)
		{
			// The work threw before calling back: every waiter gets the error (nothing is retained).
			fDone(tmpThrown);
		}
		else if (tmpThrown !== null)
		{
			// Thrown by a continuation after the work called back: it belongs to the caller.
			throw tmpThrown;
		}
	}

	/**
	 * Count a wiring-side event: note('NotModified') or note('Bypass', '<Reason>').
	 *
	 * @param {string} pMetric
	 * @param {string} [pReason]
	 */
	note(pMetric, pReason)
	{
		if (pMetric === 'NotModified')
		{
			this._Stats.NotModified++;
			return;
		}
		if (pMetric === 'Bypass')
		{
			let tmpReason = ((typeof(pReason) === 'string') && (pReason.length > 0) && (pReason.length <= MAX_REASON_LENGTH)) ? pReason : 'Other';
			this._Stats.Bypass[tmpReason] = (this._Stats.Bypass[tmpReason] || 0) + 1;
		}
	}

	/**
	 * @return {Record<string, any>} internal-contracts §43.5
	 */
	stats()
	{
		let tmpBounds = this._bounds();
		return Object.assign(
			{
				Entries: this._Entries.size,
				Bytes: this._Bytes,
				MaxEntries: tmpBounds.MaxEntries,
				MaxBytes: tmpBounds.MaxBytes
			}, this._Stats, { Bypass: Object.assign({}, this._Stats.Bypass) });
	}

	/**
	 * Forget in-flight bookkeeping (service shutdown): no refresh blocks its key and no flight is
	 * joined any more.  Work already running still calls its own waiters back.
	 */
	shutdown()
	{
		this._Refreshing.clear();
		this._Flights.clear();
	}
}

module.exports = RetoldFacetingResultCache;
module.exports.serviceType = 'RetoldFacetingResultCache';
module.exports.LOOKUP_STATUSES = LOOKUP_STATUSES;
module.exports.ENTRY_OVERHEAD_BYTES = ENTRY_OVERHEAD_BYTES;
