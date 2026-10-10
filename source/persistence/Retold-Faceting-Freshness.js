/**
 * Retold Faceting - Freshness
 *
 * How current a store is, per (store, entity), and whether a request may use it (design 04 §8;
 * internal-contracts §61): the state machine (Absent / Building / CatchingUp / Live / Lagging /
 * Rebuilding / Unverified / Degraded), ObservedSeq (the ChangeIntake subscriber 'Freshness'),
 * AppliedSeq and LagMS from the Materializer's pending work, Exact(DepSet), the admission table per
 * request Freshness mode (Exact — also MinSeq and read-your-writes upgrades — Bounded, Fast), and the
 * circuit breaker per (engine, entity) for reads and writes.
 *
 *   observe(pEvent) / observedSeq(pEntity)
 *   register / setState / setEpoch / state / applied / appliedSeq / entityFreshness / freshness(pStore, pDepSet, pNow)
 *   admits(pStore, pDepSet, pFreshness, pNow) → { Admit, Reason, Freshness }
 *   recordFailure / recordSuccess / breakerOpen (pEngine, pEntity, pNow, pKind)
 *   recordWriteFailure / recordWriteSuccess (pStore, pEntity) / stats()
 *
 * Pending work (what makes an entity not Exact) comes from Materializer.pendingInfo: pending or in-flight
 * hints, a Dirty mark (unknown IDs: a whole-entity Resync), filter resolutions.  LagMS is measured on the
 * local monotonic clock (the PendingSet's FirstSeen / Dirty.Since), except an Unverified entity's, which is
 * wall-clock time since UnverifiedSince.
 *
 * Breakers (§61.4): BreakerFailures failures within BreakerWindowMS open the breaker for BreakerOpenMS;
 * then it is half-open: exactly one probe request is let through (the Router's admission claims it;
 * every other request still sees the breaker open until the probe's outcome is recorded), the probe's
 * success closes it, its failure re-opens it.
 * Reads and writes count separately (pKind 'Read' | 'Write'); an open write breaker is the Degraded state.
 *
 * Never throws: observe() runs inside the write path (an intake subscriber), admits() inside the
 * request pipeline.
 *
 * Contract: internal-contracts §61.  Owner: builder B (M5).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libCrypto = require('crypto');
const libPerfHooks = require('perf_hooks');

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');
const libFacetClauses = require('../contract/Facet-Contract-Clauses.js');

// The per (store, entity) states, best first (§61.1); 'Lagging' is computed, never persisted.
const STATES = Object.freeze([ 'Live', 'Lagging', 'Rebuilding', 'CatchingUp', 'Unverified', 'Degraded', 'Building', 'Absent' ]);

// The admission table (§61.3): for each state, which request modes may use the store.
// 'IfExact' = only when Exact(S, E); 'IfLag' = only when LagMS ≤ MaxLagMS; true / false = always / never.
const ADMISSION = Object.freeze(
	{
		Absent: Object.freeze({ Exact: false, Bounded: false, Fast: false }),
		Building: Object.freeze({ Exact: false, Bounded: false, Fast: false }),
		Degraded: Object.freeze({ Exact: false, Bounded: false, Fast: false }),
		CatchingUp: Object.freeze({ Exact: false, Bounded: false, Fast: true }),
		Live: Object.freeze({ Exact: 'IfExact', Bounded: 'IfLag', Fast: true }),
		Lagging: Object.freeze({ Exact: 'IfExact', Bounded: 'IfLag', Fast: true }),
		Rebuilding: Object.freeze({ Exact: 'IfExactNotDivergence', Bounded: 'IfLag', Fast: true }),
		Unverified: Object.freeze({ Exact: false, Bounded: 'IfLag', Fast: true })
	});

// Circuit breaker defaults (§61.4; Freshness.BreakerFailures / BreakerWindowMS / BreakerOpenMS override).
const BREAKER_DEFAULTS = Object.freeze({ Failures: 5, WindowMS: 30000, OpenMS: 30000 });

// States in which the live mirror holds a complete build (Exact is possible).
const EXACT_STATES = Object.freeze([ 'Live', 'Lagging', 'Rebuilding' ]);

// States whose lag is unbounded (nothing usable in the live mirror, or writes failing).
const INFINITE_LAG_STATES = Object.freeze([ 'Building', 'Absent', 'Degraded' ]);

// A Degraded entity returns to these on recovery (else CatchingUp).
const RESUMABLE_STATES = Object.freeze([ 'Building', 'Rebuilding', 'Unverified' ]);

const BREAKER_KINDS = Object.freeze([ 'Read', 'Write' ]);

const isPlainObject = libRetoldFacetingUtil.isPlainObject;

class RetoldFacetingFreshness extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingFreshness';

		// Entity → { <NodeEpoch>: highest n }
		this._Observed = new Map();
		// 'S:E' → the state entry
		this._States = new Map();
		// 'S:E' → { <NodeEpoch>: n } (advanced by applied())
		this._Applied = new Map();
		// 'Engine:E:Kind' → breaker
		this._Breakers = new Map();

		let tmpFreshness = this.options.Freshness || {};
		this.Breaker = (
			{
				Failures: ((typeof(tmpFreshness.BreakerFailures) === 'number') && (tmpFreshness.BreakerFailures > 0)) ? tmpFreshness.BreakerFailures : BREAKER_DEFAULTS.Failures,
				WindowMS: ((typeof(tmpFreshness.BreakerWindowMS) === 'number') && (tmpFreshness.BreakerWindowMS > 0)) ? tmpFreshness.BreakerWindowMS : BREAKER_DEFAULTS.WindowMS,
				OpenMS: ((typeof(tmpFreshness.BreakerOpenMS) === 'number') && (tmpFreshness.BreakerOpenMS >= 0)) ? tmpFreshness.BreakerOpenMS : BREAKER_DEFAULTS.OpenMS
			});
		this.LagWarnMS = (typeof(tmpFreshness.LagWarnMS) === 'number') ? tmpFreshness.LagWarnMS : 2000;
		this.MaxLagMS = (typeof(tmpFreshness.MaxLagMS) === 'number') ? tmpFreshness.MaxLagMS : 5000;

		// The local monotonic clock pending work is measured on (the Materializer's; tests replace both).
		this.monotonicNow = () => { return libPerfHooks.performance.now(); };
	}

	// ---- helpers ------------------------------------------------------------------------------

	/**
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {string}
	 */
	_key(pStore, pEntity)
	{
		return `${pStore}:${pEntity}`;
	}

	/**
	 * The entities of a DepSet ({ Entity: [ columns ] }, or an array of entity names).
	 *
	 * @param {any} pDepSet
	 * @return {Array<string>}
	 */
	_entities(pDepSet)
	{
		if (Array.isArray(pDepSet))
		{
			return pDepSet.filter((pEntity) => { return typeof(pEntity) === 'string'; }).slice().sort();
		}
		if (isPlainObject(pDepSet))
		{
			return Object.keys(pDepSet).sort();
		}
		return [];
	}

	/**
	 * @return {string|null} the local NodeEpoch
	 */
	_localEpoch()
	{
		let tmpIntake = this.fable.RetoldFacetingChangeIntake;
		return (tmpIntake && (typeof(tmpIntake.NodeEpoch) === 'string')) ? tmpIntake.NodeEpoch : null;
	}

	/**
	 * Does a change source see every write of the entity (ChangeIntake.covers)?
	 *
	 * @param {string} pEntity
	 * @return {boolean}
	 */
	_covers(pEntity)
	{
		let tmpIntake = this.fable.RetoldFacetingChangeIntake;
		if (!tmpIntake || (typeof(tmpIntake.covers) !== 'function'))
		{
			return false;
		}
		try
		{
			return tmpIntake.covers(pEntity) === true;
		}
		catch (pError)
		{
			return false;
		}
	}

	/**
	 * The Materializer's pending work of (S, E), or null.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {boolean} [pLight] - counts, the oldest FirstSeen and Dirty only (the request path)
	 * @return {Record<string, any>|null}
	 */
	_pendingInfo(pStore, pEntity, pLight)
	{
		let tmpMaterializer = this.fable.RetoldFacetingMaterializer;
		if (!tmpMaterializer || (typeof(tmpMaterializer.pendingInfo) !== 'function'))
		{
			return null;
		}
		try
		{
			return tmpMaterializer.pendingInfo(pStore, pEntity, pLight ? { Light: true } : undefined);
		}
		catch (pError)
		{
			return null;
		}
	}

	/**
	 * Is there hinted work not yet applied?
	 *
	 * @param {Record<string, any>|null} pInfo
	 * @return {boolean}
	 */
	_hasPendingWork(pInfo)
	{
		if (!pInfo)
		{
			return false;
		}
		return ((pInfo.Pending || 0) > 0) || ((pInfo.InFlight || 0) > 0) || ((pInfo.Resolving || 0) > 0) || !!pInfo.Dirty;
	}

	// ---- observed sequence ----------------------------------------------------------------------

	/**
	 * The ChangeIntake subscriber 'Freshness' (synchronous; never throws).
	 *
	 * @param {Record<string, any>} pEvent
	 */
	observe(pEvent)
	{
		try
		{
			if (!pEvent || (typeof(pEvent.Entity) !== 'string'))
			{
				return;
			}
			let tmpSeq = libRetoldFacetingUtil.parseSeq(pEvent.Seq);
			if (!tmpSeq)
			{
				return;
			}
			let tmpVector = this._Observed.get(pEvent.Entity);
			if (!tmpVector)
			{
				tmpVector = {};
				this._Observed.set(pEvent.Entity, tmpVector);
			}
			if (!(tmpSeq.Epoch in tmpVector) || (tmpVector[tmpSeq.Epoch] < tmpSeq.N))
			{
				tmpVector[tmpSeq.Epoch] = tmpSeq.N;
			}
		}
		catch (pError)
		{
			// Never in the write path.
		}
	}

	/**
	 * @param {string} pEntity
	 * @return {Record<string, number>}
	 */
	observedSeq(pEntity)
	{
		return Object.assign({}, this._Observed.get(pEntity) || {});
	}

	// ---- state ----------------------------------------------------------------------------------

	/**
	 * Start tracking (S, E) (idempotent: an existing entry keeps its state unless pState is given).
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {string|{ State?: string, Epoch?: number, UnverifiedSince?: number|null, Reason?: string|null }} [pState]
	 * @return {Record<string, any>} the state entry (a copy)
	 */
	register(pStore, pEntity, pState)
	{
		let tmpKey = this._key(pStore, pEntity);
		let tmpEntry = this._States.get(tmpKey);
		if (!tmpEntry)
		{
			tmpEntry = { Store: pStore, Entity: pEntity, State: 'Absent', Since: Date.now(), Reason: null, Epoch: 0, Divergence: false, UnverifiedSince: null, PriorState: null, PriorDivergence: false };
			this._States.set(tmpKey, tmpEntry);
		}
		let tmpInput = (typeof(pState) === 'string') ? { State: pState } : (isPlainObject(pState) ? pState : {});
		if ((typeof(tmpInput.Epoch) === 'number') && Number.isFinite(tmpInput.Epoch))
		{
			tmpEntry.Epoch = tmpInput.Epoch;
		}
		if (typeof(tmpInput.State) === 'string')
		{
			this.setState(pStore, pEntity, tmpInput.State, (typeof(tmpInput.Reason) === 'string') ? tmpInput.Reason : null);
		}
		if ((typeof(tmpInput.UnverifiedSince) === 'number') && (tmpEntry.State === 'Unverified'))
		{
			tmpEntry.UnverifiedSince = tmpInput.UnverifiedSince;
		}
		return this.state(pStore, pEntity);
	}

	/**
	 * Forget (S, E) (an entity removed from Materialize).
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 */
	unregister(pStore, pEntity)
	{
		let tmpKey = this._key(pStore, pEntity);
		this._States.delete(tmpKey);
		this._Applied.delete(tmpKey);
	}

	/**
	 * A state transition (the Materializer, the Rebuilder and the Reconciler call it).  'Lagging' is
	 * computed, so setting it means Live.  A Reason of 'Divergence' marks a Rebuilding / Unverified
	 * entity as divergence-triggered (§61.3).
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {string} pState
	 * @param {string|null} [pReason]
	 * @return {boolean} the state is known (and was applied)
	 */
	setState(pStore, pEntity, pState, pReason)
	{
		let tmpState = (pState === 'Lagging') ? 'Live' : pState;
		if (STATES.indexOf(tmpState) < 0)
		{
			this.fable.log.warn(`RetoldFaceting Freshness: unknown state [${libRetoldFacetingUtil.logSafe(pState)}] for ${libRetoldFacetingUtil.logSafe(pStore)}:${libRetoldFacetingUtil.logSafe(pEntity)}.`);
			return false;
		}
		let tmpKey = this._key(pStore, pEntity);
		let tmpEntry = this._States.get(tmpKey);
		if (!tmpEntry)
		{
			tmpEntry = { Store: pStore, Entity: pEntity, State: 'Absent', Since: Date.now(), Reason: null, Epoch: 0, Divergence: false, UnverifiedSince: null, PriorState: null, PriorDivergence: false };
			this._States.set(tmpKey, tmpEntry);
		}
		let tmpReason = (typeof(pReason) === 'string') ? pReason : null;
		let tmpNow = Date.now();
		let tmpPrior = tmpEntry.State;
		// Was the live table unproven before this transition (its divergence / unverified mark must
		// survive a Degraded detour and a rebuild started from it)?  CatchingUp counts: its catch-up
		// Sweep may still be paging, so downtime writes are neither applied nor pending yet.
		let tmpPriorUnproven = (tmpPrior === 'Unverified') || (tmpPrior === 'CatchingUp')
			|| ((tmpPrior === 'Rebuilding') && tmpEntry.Divergence)
			|| ((tmpPrior === 'Degraded') && (tmpEntry.PriorDivergence || (tmpEntry.PriorState === 'Unverified') || (tmpEntry.PriorState === 'CatchingUp')));
		if (tmpEntry.State !== tmpState)
		{
			if (tmpState === 'Degraded')
			{
				tmpEntry.PriorState = tmpEntry.State;
				tmpEntry.PriorDivergence = !!tmpEntry.Divergence;
			}
			tmpEntry.State = tmpState;
			tmpEntry.Since = tmpNow;
		}
		tmpEntry.Reason = tmpReason;
		if (tmpState === 'Unverified')
		{
			if (tmpEntry.UnverifiedSince === null)
			{
				tmpEntry.UnverifiedSince = tmpNow;
			}
		}
		else if (tmpState !== 'Degraded')
		{
			tmpEntry.UnverifiedSince = null;
		}
		if (tmpState === 'Rebuilding')
		{
			// A divergence rebuild — or any rebuild started while the live tables were not proven current
			// (Unverified, CatchingUp, a divergence rebuild, or a Degraded detour from one of them) — never
			// serves Exact requests before its swap.
			tmpEntry.Divergence = (tmpReason === 'Divergence') || tmpPriorUnproven;
		}
		else if (tmpState === 'Unverified')
		{
			// A divergence rebuild keeps its mark into the Unverified state it ends in (through Degraded too).
			tmpEntry.Divergence = (tmpReason === 'Divergence')
				|| ((tmpEntry.Divergence || ((tmpPrior === 'Degraded') && tmpEntry.PriorDivergence)) && (tmpReason !== 'UncleanShutdown'));
		}
		else if (tmpState !== 'Degraded')
		{
			tmpEntry.Divergence = false;
		}
		if (tmpState !== 'Degraded')
		{
			tmpEntry.PriorDivergence = false;
		}
		return true;
	}

	/**
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {number} pEpoch
	 */
	setEpoch(pStore, pEntity, pEpoch)
	{
		let tmpEntry = this._States.get(this._key(pStore, pEntity));
		if (tmpEntry && (typeof(pEpoch) === 'number') && Number.isFinite(pEpoch))
		{
			tmpEntry.Epoch = pEpoch;
		}
	}

	/**
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {{ State: string, Since: number|null, Reason: string|null, Epoch: number, Divergence: boolean, UnverifiedSince: number|null }}
	 */
	state(pStore, pEntity)
	{
		let tmpEntry = this._States.get(this._key(pStore, pEntity));
		if (!tmpEntry)
		{
			return { State: 'Absent', Since: null, Reason: null, Epoch: 0, Divergence: false, UnverifiedSince: null };
		}
		return { State: tmpEntry.State, Since: tmpEntry.Since, Reason: tmpEntry.Reason, Epoch: tmpEntry.Epoch, Divergence: tmpEntry.Divergence, UnverifiedSince: tmpEntry.UnverifiedSince };
	}

	// ---- applied sequence and the numbers ------------------------------------------------------

	/**
	 * Recompute AppliedSeq(S, E) after a flush was acknowledged (§61.2): ObservedSeq when no hinted work
	 * is pending, else (local epoch) the lowest pending Seq − 1; other epochs keep their last applied value.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {Record<string, number>} the new AppliedSeq
	 */
	applied(pStore, pEntity)
	{
		let tmpKey = this._key(pStore, pEntity);
		let tmpObserved = this.observedSeq(pEntity);
		let tmpInfo = this._pendingInfo(pStore, pEntity);
		let tmpApplied;
		if (!this._hasPendingWork(tmpInfo))
		{
			tmpApplied = tmpObserved;
		}
		else
		{
			tmpApplied = Object.assign({}, this._Applied.get(tmpKey) || {});
			let tmpLocal = this._localEpoch();
			if (tmpLocal)
			{
				let tmpMinSeqN = (tmpInfo && (typeof(tmpInfo.MinSeqN) === 'number')) ? tmpInfo.MinSeqN : null;
				if (tmpInfo && tmpInfo.Dirty && (typeof(tmpInfo.Dirty.MinSeqN) === 'number'))
				{
					tmpMinSeqN = (tmpMinSeqN === null) ? tmpInfo.Dirty.MinSeqN : Math.min(tmpMinSeqN, tmpInfo.Dirty.MinSeqN);
				}
				let tmpObservedLocal = (tmpLocal in tmpObserved) ? tmpObserved[tmpLocal] : 0;
				let tmpCandidate = (tmpMinSeqN === null) ? tmpObservedLocal : Math.min(tmpObservedLocal, tmpMinSeqN - 1);
				// Never backwards.
				if (!(tmpLocal in tmpApplied) || (tmpApplied[tmpLocal] < tmpCandidate))
				{
					tmpApplied[tmpLocal] = Math.max(0, tmpCandidate);
				}
			}
		}
		this._Applied.set(tmpKey, tmpApplied);
		return Object.assign({}, tmpApplied);
	}

	/**
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {Record<string, number>} the last computed AppliedSeq
	 */
	appliedSeq(pStore, pEntity)
	{
		return Object.assign({}, this._Applied.get(this._key(pStore, pEntity)) || {});
	}

	/**
	 * One entity's freshness (§61.2).
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {number} [pNow] - Date.now()
	 * @return {{ State: string, Exact: boolean, LagMS: number, AppliedSeq: Record<string, number>, ObservedSeq: Record<string, number>, Pending: boolean, Covered: boolean, Divergence: boolean }}
	 */
	entityFreshness(pStore, pEntity, pNow)
	{
		let tmpNow = (typeof(pNow) === 'number') ? pNow : Date.now();
		let tmpEntry = this._States.get(this._key(pStore, pEntity));
		let tmpState = tmpEntry ? tmpEntry.State : 'Absent';
		let tmpInfo = this._pendingInfo(pStore, pEntity, true);
		let tmpPending = this._hasPendingWork(tmpInfo);
		let tmpLag = 0;
		if (INFINITE_LAG_STATES.indexOf(tmpState) >= 0)
		{
			tmpLag = Infinity;
		}
		else
		{
			let tmpMono = this.monotonicNow();
			if (tmpInfo && (typeof(tmpInfo.OldestFirstSeen) === 'number'))
			{
				tmpLag = Math.max(tmpLag, tmpMono - tmpInfo.OldestFirstSeen);
			}
			if (tmpInfo && tmpInfo.Dirty && (typeof(tmpInfo.Dirty.Since) === 'number'))
			{
				tmpLag = Math.max(tmpLag, tmpMono - tmpInfo.Dirty.Since);
			}
			if (tmpInfo && (typeof(tmpInfo.ResolvingSince) === 'number'))
			{
				tmpLag = Math.max(tmpLag, tmpMono - tmpInfo.ResolvingSince);
			}
			if ((tmpState === 'Unverified') && tmpEntry && (typeof(tmpEntry.UnverifiedSince) === 'number'))
			{
				tmpLag = Math.max(tmpLag, tmpNow - tmpEntry.UnverifiedSince);
			}
			tmpLag = Math.max(0, Math.round(tmpLag));
		}
		let tmpCovered = this._covers(pEntity);
		let tmpDivergence = tmpEntry ? tmpEntry.Divergence : false;
		let tmpExact = (EXACT_STATES.indexOf(tmpState) >= 0) && !((tmpState === 'Rebuilding') && tmpDivergence) && !tmpPending && tmpCovered;
		let tmpReported = ((tmpState === 'Live') && (tmpLag > this.LagWarnMS)) ? 'Lagging' : tmpState;
		return (
			{
				State: tmpReported,
				Exact: tmpExact,
				LagMS: tmpLag,
				AppliedSeq: this.appliedSeq(pStore, pEntity),
				ObservedSeq: this.observedSeq(pEntity),
				Pending: tmpPending,
				Covered: tmpCovered,
				Divergence: tmpDivergence
			});
	}

	/**
	 * A DepSet's freshness (§61.2): Exact = every entity Exact; LagMS = the max; AsOf = now − LagMS;
	 * State = the worst entity state; ApplyToken over (Entity, AppliedSeq, Epoch).
	 *
	 * @param {string} pStore
	 * @param {Record<string, Array<string>>|Array<string>} pDepSet
	 * @param {number} [pNow]
	 * @return {{ Exact: boolean, LagMS: number, AsOf: string|null, State: string, ApplyToken: string|null, Entities: Record<string, any> }}
	 */
	freshness(pStore, pDepSet, pNow)
	{
		let tmpNow = (typeof(pNow) === 'number') ? pNow : Date.now();
		let tmpEntities = this._entities(pDepSet);
		if (tmpEntities.length < 1)
		{
			return { Exact: false, LagMS: Infinity, AsOf: null, State: 'Absent', ApplyToken: null, Entities: {} };
		}
		let tmpResult = { Exact: true, LagMS: 0, AsOf: null, State: 'Live', ApplyToken: null, Entities: {} };
		let tmpWorst = 0;
		let tmpTokenMaterial = [];
		for (let i = 0; i < tmpEntities.length; i++)
		{
			let tmpEntity = tmpEntities[i];
			let tmpEntityFreshness = this.entityFreshness(pStore, tmpEntity, tmpNow);
			tmpResult.Entities[tmpEntity] = tmpEntityFreshness;
			tmpResult.Exact = tmpResult.Exact && tmpEntityFreshness.Exact;
			tmpResult.LagMS = Math.max(tmpResult.LagMS, tmpEntityFreshness.LagMS);
			tmpWorst = Math.max(tmpWorst, STATES.indexOf(tmpEntityFreshness.State));
			tmpTokenMaterial.push([ tmpEntity, tmpEntityFreshness.AppliedSeq, this.state(pStore, tmpEntity).Epoch ]);
		}
		tmpResult.State = STATES[tmpWorst];
		tmpResult.AsOf = Number.isFinite(tmpResult.LagMS) ? new Date(tmpNow - tmpResult.LagMS).toISOString() : null;
		tmpResult.ApplyToken = `at:${libCrypto.createHash('sha256').update(libFacetClauses.canonicalJSON(tmpTokenMaterial), 'utf8').digest('hex').slice(0, 16)}`;
		return tmpResult;
	}

	/**
	 * May a request with this Freshness use the store for this DepSet (§61.3)?  The first failing entity
	 * (sorted) gives the Reason.  A MinSeq (or a read-your-writes upgrade, which the Freshness stage
	 * already turned into Exact) is an Exact request (§68 #13).
	 *
	 * @param {string} pStore
	 * @param {Record<string, Array<string>>|Array<string>} pDepSet
	 * @param {{ Mode?: string, MaxLagMS?: number, MinSeq?: string|null }} pFreshness
	 * @param {number} [pNow]
	 * @return {{ Admit: boolean, Reason: string|null, Freshness: Record<string, any> }}
	 */
	admits(pStore, pDepSet, pFreshness, pNow, pOptions)
	{
		let tmpNow = (typeof(pNow) === 'number') ? pNow : Date.now();
		let tmpFreshness = this.freshness(pStore, pDepSet, tmpNow);
		// The claim token: the request's own (its Aggs share one probe), or true.
		this._ClaimProbes = (pOptions && pOptions.ClaimProbe) ? ((typeof(pOptions.ClaimProbe) === 'string') ? pOptions.ClaimProbe : true) : false;
		this._Claimed = [];
		let tmpClaimed = this._Claimed;
		let fRelease = (pResult) =>
		{
			// A refusal gives back the probes this admission claimed (no outcome will be recorded for them).
			if (!pResult.Admit)
			{
				tmpClaimed.forEach((pEntity) => { this.releaseProbe(pStore, pEntity, 'Read'); });
			}
			else
			{
				pResult.Probes = tmpClaimed.slice();
			}
			return pResult;
		};
		try
		{
			let tmpRequest = isPlainObject(pFreshness) ? pFreshness : {};
			let tmpMode = ((typeof(tmpRequest.MinSeq) === 'string') && (tmpRequest.MinSeq.length > 0)) ? 'Exact'
				: (([ 'Exact', 'Bounded', 'Fast' ].indexOf(tmpRequest.Mode) >= 0) ? tmpRequest.Mode : 'Exact');
			let tmpMaxLag = ((typeof(tmpRequest.MaxLagMS) === 'number') && (tmpRequest.MaxLagMS >= 0)) ? tmpRequest.MaxLagMS : this.MaxLagMS;
			let tmpEntities = this._entities(pDepSet);
			if (tmpEntities.length < 1)
			{
				return fRelease({ Admit: false, Reason: 'StoreUnavailable', Freshness: tmpFreshness });
			}
			for (let i = 0; i < tmpEntities.length; i++)
			{
				let tmpEntity = tmpEntities[i];
				let tmpReason = this._admitEntity(pStore, tmpEntity, tmpMode, tmpMaxLag, tmpFreshness.Entities[tmpEntity], tmpNow);
				if (tmpReason)
				{
					return fRelease({ Admit: false, Reason: tmpReason, Freshness: tmpFreshness });
				}
			}
			return fRelease({ Admit: true, Reason: null, Freshness: tmpFreshness });
		}
		catch (pError)
		{
			this.fable.log.error(`RetoldFaceting Freshness.admits failed: ${pError.message}`);
			return fRelease({ Admit: false, Reason: 'StoreUnavailable', Freshness: tmpFreshness });
		}
		finally
		{
			this._ClaimProbes = false;
			this._Claimed = null;
		}
	}

	/**
	 * One entity's admission: null when admitted, else the reason.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {string} pMode
	 * @param {number} pMaxLag
	 * @param {Record<string, any>} pEntityFreshness
	 * @param {number} pNow
	 * @return {string|null}
	 */
	_admitEntity(pStore, pEntity, pMode, pMaxLag, pEntityFreshness, pNow)
	{
		if (this.breakerOpen(pStore, pEntity, pNow, 'Read', this._ClaimProbes || false))
		{
			return `Breaker:${pEntity}`;
		}
		let tmpState = this.state(pStore, pEntity).State;
		let tmpRow = ADMISSION[tmpState] || ADMISSION.Absent;
		let tmpRule = tmpRow[pMode];
		if (tmpRule === true)
		{
			return null;
		}
		if (tmpRule === false)
		{
			return (tmpState === 'Unverified') ? `Unverified:${pEntity}` : `State:${tmpState}:${pEntity}`;
		}
		if (tmpRule === 'IfLag')
		{
			return (pEntityFreshness.LagMS <= pMaxLag) ? null : `Lagging:${pEntity}`;
		}
		// IfExact / IfExactNotDivergence
		if ((tmpRule === 'IfExactNotDivergence') && pEntityFreshness.Divergence)
		{
			return `Unverified:${pEntity}`;
		}
		if (!pEntityFreshness.Covered)
		{
			return `NoChangeSource:${pEntity}`;
		}
		return pEntityFreshness.Exact ? null : `NotExact:${pEntity}`;
	}

	// ---- breakers -------------------------------------------------------------------------------

	/**
	 * @param {string} pEngine
	 * @param {string} pEntity
	 * @param {string} [pKind]
	 * @return {Record<string, any>}
	 */
	_breaker(pEngine, pEntity, pKind)
	{
		let tmpKind = (BREAKER_KINDS.indexOf(pKind) >= 0) ? pKind : 'Read';
		let tmpKey = `${pEngine}:${pEntity}:${tmpKind}`;
		let tmpBreaker = this._Breakers.get(tmpKey);
		if (!tmpBreaker)
		{
			tmpBreaker = { Failures: [], OpenUntil: null, HalfOpen: false, Opens: 0, ProbeAt: null };
			this._Breakers.set(tmpKey, tmpBreaker);
		}
		return tmpBreaker;
	}

	/**
	 * Count a failure; returns true when this failure opened (or re-opened) the breaker.
	 *
	 * @param {string} pEngine
	 * @param {string} pEntity
	 * @param {number} [pNow]
	 * @param {'Read'|'Write'} [pKind]
	 * @return {boolean}
	 */
	recordFailure(pEngine, pEntity, pNow, pKind)
	{
		let tmpNow = (typeof(pNow) === 'number') ? pNow : Date.now();
		let tmpBreaker = this._breaker(pEngine, pEntity, pKind);
		if (tmpBreaker.HalfOpen || ((tmpBreaker.OpenUntil !== null) && (tmpNow >= tmpBreaker.OpenUntil)))
		{
			// The half-open probe failed: open again.
			tmpBreaker.HalfOpen = false;
			tmpBreaker.ProbeAt = null;
			tmpBreaker.Failures = [];
			tmpBreaker.OpenUntil = tmpNow + this.Breaker.OpenMS;
			tmpBreaker.Opens++;
			return true;
		}
		if (tmpBreaker.OpenUntil !== null)
		{
			// Already open: a failure of a request let through earlier changes nothing.
			return false;
		}
		tmpBreaker.Failures = tmpBreaker.Failures.filter((pAt) => { return (tmpNow - pAt) < this.Breaker.WindowMS; });
		tmpBreaker.Failures.push(tmpNow);
		if (tmpBreaker.Failures.length >= this.Breaker.Failures)
		{
			tmpBreaker.Failures = [];
			tmpBreaker.OpenUntil = tmpNow + this.Breaker.OpenMS;
			tmpBreaker.Opens++;
			return true;
		}
		return false;
	}

	/**
	 * A success closes the breaker (and forgets earlier failures).
	 *
	 * @param {string} pEngine
	 * @param {string} pEntity
	 * @param {number} [pNow]
	 * @param {'Read'|'Write'} [pKind]
	 */
	recordSuccess(pEngine, pEntity, pNow, pKind)
	{
		let tmpBreaker = this._breaker(pEngine, pEntity, pKind);
		tmpBreaker.Failures = [];
		tmpBreaker.OpenUntil = null;
		tmpBreaker.HalfOpen = false;
		tmpBreaker.ProbeAt = null;
	}

	/**
	 * Is the breaker open now?  After BreakerOpenMS it is half-open: exactly ONE probe goes through — the
	 * first caller that claims it (pClaim, the Router's admission) — and every other caller still sees it
	 * open until the probe's outcome is recorded (a success closes it, a failure re-opens it) or the probe
	 * expires (BreakerOpenMS: a probe that never reported).  Without pClaim it is a capability read
	 * (capable(), Describe): open only during the open period; the admission decides the probe.
	 *
	 * @param {string} pEngine
	 * @param {string} pEntity
	 * @param {number} [pNow]
	 * @param {'Read'|'Write'} [pKind]
	 * @param {boolean|string} [pClaim] - take the half-open probe when it is free (a string: the claiming
	 *        request's token — its other Aggs share the probe)
	 * @return {boolean}
	 */
	breakerOpen(pEngine, pEntity, pNow, pKind, pClaim)
	{
		let tmpKind = (BREAKER_KINDS.indexOf(pKind) >= 0) ? pKind : 'Read';
		let tmpBreaker = this._Breakers.get(`${pEngine}:${pEntity}:${tmpKind}`);
		if (!tmpBreaker || (tmpBreaker.OpenUntil === null))
		{
			return false;
		}
		let tmpNow = (typeof(pNow) === 'number') ? pNow : Date.now();
		if (tmpNow < tmpBreaker.OpenUntil)
		{
			return true;
		}
		tmpBreaker.HalfOpen = true;
		if (!pClaim)
		{
			// A capability read (capable(), Describe): half-open is not open; the admission decides the probe.
			return false;
		}
		let tmpProbeLive = (typeof(tmpBreaker.ProbeAt) === 'number') && ((tmpNow - tmpBreaker.ProbeAt) < Math.max(1, this.Breaker.OpenMS));
		if (tmpProbeLive)
		{
			// The probe in flight is this request's own (another Agg of it): it goes too.
			return !(pClaim && (typeof(pClaim) === 'string') && (tmpBreaker.ProbeOwner === pClaim));
		}
		if (pClaim)
		{
			tmpBreaker.ProbeAt = tmpNow;
			tmpBreaker.ProbeOwner = (typeof(pClaim) === 'string') ? pClaim : null;
			if (Array.isArray(this._Claimed))
			{
				this._Claimed.push(pEntity);
			}
		}
		return false;
	}

	/**
	 * Give back a claimed half-open probe that produced no outcome (its Agg was refused before running).
	 *
	 * @param {string} pEngine
	 * @param {string} pEntity
	 * @param {'Read'|'Write'} [pKind]
	 */
	releaseProbe(pEngine, pEntity, pKind)
	{
		let tmpKind = (BREAKER_KINDS.indexOf(pKind) >= 0) ? pKind : 'Read';
		let tmpBreaker = this._Breakers.get(`${pEngine}:${pEntity}:${tmpKind}`);
		if (tmpBreaker)
		{
			tmpBreaker.ProbeAt = null;
		}
	}

	/**
	 * A WriterLoop flush failed: counted on the write breaker; when it opens the entity is Degraded.
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {number} [pNow]
	 * @return {boolean} the breaker is open (the entity is Degraded)
	 */
	recordWriteFailure(pStore, pEntity, pNow)
	{
		let tmpNow = (typeof(pNow) === 'number') ? pNow : Date.now();
		this.recordFailure(pStore, pEntity, tmpNow, 'Write');
		// Open, or re-opened by this failure (a write that failed while half-open).
		let tmpOpen = (this._breaker(pStore, pEntity, 'Write').OpenUntil !== null);
		if (tmpOpen && (this.state(pStore, pEntity).State !== 'Degraded'))
		{
			this.setState(pStore, pEntity, 'Degraded', 'WriteBreaker');
			this.fable.log.warn(`RetoldFaceting Freshness: writes to ${libRetoldFacetingUtil.logSafe(pStore)}:${libRetoldFacetingUtil.logSafe(pEntity)} keep failing; the entity is Degraded (served Live).`);
		}
		return tmpOpen;
	}

	/**
	 * A WriterLoop flush succeeded: the write breaker closes; a Degraded entity resumes (CatchingUp, or the
	 * build / rebuild / verification it was in).
	 *
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {number} [pNow]
	 */
	recordWriteSuccess(pStore, pEntity, pNow)
	{
		this.recordSuccess(pStore, pEntity, pNow, 'Write');
		let tmpEntry = this._States.get(this._key(pStore, pEntity));
		if (tmpEntry && (tmpEntry.State === 'Degraded'))
		{
			let tmpResume = (RESUMABLE_STATES.indexOf(tmpEntry.PriorState) >= 0) ? tmpEntry.PriorState : 'CatchingUp';
			// setState reads PriorState / PriorDivergence (a divergence-marked rebuild stays non-Exact).
			this.setState(pStore, pEntity, tmpResume, 'WriteRecovered');
			tmpEntry.PriorState = null;
		}
	}

	/**
	 * @return {{ Entities: Record<string, { State: string, LagMS: number, Exact: boolean }>, Breakers: Record<string, { Open: boolean, HalfOpen: boolean, Failures: number, Opens: number }> }}
	 */
	stats()
	{
		let tmpNow = Date.now();
		let tmpStats = { Entities: {}, Breakers: {} };
		this._States.forEach(
			(pEntry, pKey) =>
			{
				let tmpFreshness = this.entityFreshness(pEntry.Store, pEntry.Entity, tmpNow);
				tmpStats.Entities[pKey] = { State: tmpFreshness.State, LagMS: tmpFreshness.LagMS, Exact: tmpFreshness.Exact };
			});
		this._Breakers.forEach(
			(pBreaker, pKey) =>
			{
				tmpStats.Breakers[pKey] = { Open: (pBreaker.OpenUntil !== null) && (tmpNow < pBreaker.OpenUntil), HalfOpen: pBreaker.HalfOpen || ((pBreaker.OpenUntil !== null) && (tmpNow >= pBreaker.OpenUntil)), Failures: pBreaker.Failures.length, Opens: pBreaker.Opens };
			});
		return tmpStats;
	}
}

module.exports = RetoldFacetingFreshness;
module.exports.serviceType = 'RetoldFacetingFreshness';
module.exports.STATES = STATES;
module.exports.ADMISSION = ADMISSION;
module.exports.BREAKER_DEFAULTS = BREAKER_DEFAULTS;
