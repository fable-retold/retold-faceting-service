/**
 * Change-Intake-Interim -- the interim change source (design 05 §4.4, 09 §4.8), until the upstream
 * DAL hook (M-1) and ChangeContext (ME-3) exist.
 *
 * Wraps, on every facetable entity's ROUTE-BOUND controller, two things that a host's ordinary
 * setBehavior() calls never touch:
 *
 *   1. the behavior DISPATCHER (BehaviorInjection.runBehavior), once per controller.  Every slot of
 *      every write path of meadow-endpoints 4.0.21 and 4.1.x goes through it, whatever function a
 *      host put in the slot (or none).  The dispatcher wrapper looks at the slot name only:
 *
 *        Update- / Delete- / Undelete-PreOperation   snapshot a copy of the pre-image (OriginalRecord)
 *                                                    BEFORE any host behavior runs (a behavior that
 *                                                    mutates the shared Record object cannot rewrite it)
 *        Create- / Update-QueryConfiguration,        once the slot called back without an error, ARM
 *        Delete- / Undelete-PreOperation             the write query (the last slot before the DAL call)
 *        Create- / Update- / Delete- /               capture the change and ingest it AT ENTRY (the row
 *        Undelete-PostOperation                      is committed), then dispatch to the host's behavior;
 *                                                    its callback is passed through unchanged
 *
 *      Every other slot (reads, Count, the endpoint-level *Bulk-PostOperation slots) is dispatched
 *      untouched after one string lookup.
 *
 *   2. the controller DAL's doCreate / doUpdate / doDelete / doUndelete, once per DAL object.  Only
 *      an ARMED query is observed (a DAL-direct write from host code passes straight through): when
 *      the DAL calls back with an error, or Create / Update without a record (a committed UPDATE whose
 *      re-read failed: meadow's own delete tracking or a QueryConfiguration filter the new row no
 *      longer satisfies), the write may have committed but no PostOperation will run, so a
 *      CONSERVATIVE event is ingested (the pre-image's and the submitted tenants / owners,
 *      ChangedColumns null → '#all').
 *
 * One event per request state at most (a per-state marker: the precise PostOperation path and the
 * conservative DAL path never both ingest, and a dispatcher wrapped twice never doubles an event).
 * Nothing here ever fails, throws into or delays a write; wrapper errors are logged and counted, and
 * a capture that cannot be derived ingests a fail-closed EntityDirty (Tenants ['*']) instead of
 * nothing.  The wrappers only act while their intake's source is 'Interim'.
 *
 * With ME-1 (no runBehavior to wrap but BehaviorInjection.addBehavior) the capture is registered at
 * the LOWEST order (it runs before the host's own behaviors, so it captures the undecorated images)
 * and the snapshot / arm behaviors at the lowest / highest order respectively.
 *
 * A plain class (an intake adapter, internal-contracts §38.3): constructed by the ChangeIntake service
 * with itself, never registered on fable.
 *
 * Contract: internal-contracts §40.1–§40.4.  Owner: builder B (M4; review fixes §51.46–§51.52).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFacetUtil = require('../contract/Facet-Contract-Util.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');

// The marker on a wrapper function (the dispatcher, a DAL method): { Intake, Entity, Original }; and,
// for ME-1 controllers, a non-enumerable Set of the registered slot names on the controller.
const INTAKE_MARKER = Symbol.for('RetoldFaceting.Intake');
// The per-request-state marker: { Ingested, Before }.
const STATE_MARKER = Symbol.for('RetoldFaceting.IntakeState');
// The armed write on a query object: { Entity, Operation, State, Request }.
const PENDING_MARKER = Symbol.for('RetoldFaceting.IntakePending');

// The per-record capture slots (internal-contracts §40.2) → the ChangeEvent Operation they produce.
const SLOTS = Object.freeze(
	{
		'Create-PostOperation': 'Create',
		'Update-PostOperation': 'Update',
		'Delete-PostOperation': 'Delete',
		'Undelete-PostOperation': 'Undelete'
	});

// The slots whose entry snapshots the pre-image (before any host behavior can mutate it).
const SNAPSHOT_SLOTS = Object.freeze(
	{
		'Update-PreOperation': 'Update',
		'Delete-PreOperation': 'Delete',
		'Undelete-PreOperation': 'Undelete'
	});

// The last slot before each DAL write: a successful dispatch arms the write query.
const ARM_SLOTS = Object.freeze(
	{
		'Create-QueryConfiguration': 'Create',
		'Update-QueryConfiguration': 'Update',
		'Delete-PreOperation': 'Delete',
		'Undelete-PreOperation': 'Undelete'
	});

// The controller DAL methods observed for armed queries → their Operation.
const DAL_METHODS = Object.freeze(
	{
		doCreate: 'Create',
		doUpdate: 'Update',
		doDelete: 'Delete',
		doUndelete: 'Undelete'
	});

// Every slot name the dispatcher wrapper looks at.
const INTERCEPTED = new Set(Object.keys(SLOTS).concat(Object.keys(SNAPSHOT_SLOTS), Object.keys(ARM_SLOTS)));

// The ME-1 registrations (05 §4.3): the capture and the snapshot run first, the arm runs last.
const ADD_BEHAVIOR_OPTIONS = Object.freeze({ Name: 'Faceting', Order: -1000 });
const ADD_BEHAVIOR_ARM_OPTIONS = Object.freeze({ Name: 'FacetingArm', Order: 1000 });

// How far up ParentRequestState the Verb walk goes (doCreate → Upsert → UpsertBulk is three).
const MAX_VERB_DEPTH = 8;

/**
 * A record-shaped value of the request state (a plain object), else null.
 *
 * @param {any} pValue
 * @return {Record<string, any>|null}
 */
const recordOf = (pValue) =>
{
	return ((typeof(pValue) === 'object') && (pValue !== null) && !Array.isArray(pValue)) ? pValue : null;
};

/**
 * A shallow copy of a record (the snapshot of a pre-image), else null.
 *
 * @param {any} pValue
 * @return {Record<string, any>|null}
 */
const copyRecord = (pValue) =>
{
	let tmpRecord = recordOf(pValue);
	return tmpRecord ? Object.assign({}, tmpRecord) : null;
};

/**
 * Define (or overwrite) a non-enumerable, configurable property (never serialized, never copied by
 * Object.assign / cloneAsyncSafeRequestState).
 *
 * @param {any} pTarget
 * @param {symbol} pKey
 * @param {any} pValue
 */
const defineHidden = (pTarget, pKey, pValue) =>
{
	Object.defineProperty(pTarget, pKey, { value: pValue, enumerable: false, configurable: true, writable: true });
};

class ChangeIntakeInterim
{
	/**
	 * @param {any} pIntake - the RetoldFacetingChangeIntake service that owns this adapter
	 */
	constructor(pIntake)
	{
		this.Intake = pIntake;
		this.fable = pIntake ? pIntake.fable : null;
		this.log = (pIntake && pIntake.fable) ? pIntake.fable.log : null;
		// pRequest → { Session, PrincipalKey, UserID } (one principal build per HTTP request, P13)
		this._Actors = new WeakMap();
	}

	/**
	 * The host the owning service is attached to (null before attach).
	 *
	 * @return {any|null}
	 */
	_host()
	{
		let tmpService = this.fable ? this.fable.RetoldFacetingService : null;
		return (tmpService && tmpService.Host) ? tmpService.Host : null;
	}

	/**
	 * Is this adapter the intake's live source?
	 *
	 * @return {boolean}
	 */
	_active()
	{
		return !!this.Intake && (this.Intake._Source === 'Interim');
	}

	/**
	 * Log at warn (entity and reason only, never values) and count a wrapper error.
	 *
	 * @param {string} pEntity
	 * @param {string} pWhat
	 * @param {any} pError
	 */
	_wrapperError(pEntity, pWhat, pError)
	{
		if (this.Intake && this.Intake._Stats)
		{
			this.Intake._Stats.WrapperErrors++;
		}
		if (this.log)
		{
			let tmpMessage = (pError && (typeof(pError.message) === 'string')) ? pError.message : String(pError);
			this.log.warn(`RetoldFaceting change intake: ${pWhat} failed on ${libFacetUtil.logSafe(pEntity)}: ${libFacetUtil.logSafe(tmpMessage)}`);
		}
	}

	// ---------------------------------------------------------------- install and coverage

	/**
	 * Wrap every facetable entity's route-bound controller (idempotent: a dispatcher or DAL method that
	 * already carries this intake's wrapper is left alone; one that was replaced is wrapped again).
	 *
	 * @return {Array<string>} the catalog entities whose route-bound controller is covered now
	 */
	install()
	{
		let tmpHost = this._host();
		let tmpCatalog = this.fable ? this.fable.RetoldFacetingCatalog : null;
		if (!tmpHost || (typeof(tmpHost.getRouteBoundController) !== 'function') || !tmpCatalog || (typeof(tmpCatalog.entities) !== 'function'))
		{
			return [];
		}
		let tmpEntities = tmpCatalog.entities();
		let tmpCovered = [];
		for (let i = 0; i < tmpEntities.length; i++)
		{
			let tmpEntity = tmpEntities[i];
			try
			{
				let tmpController = tmpHost.getRouteBoundController(tmpEntity);
				if (!tmpController)
				{
					continue;
				}
				this.wrapController(tmpEntity, tmpController);
				if (this.isCovered(tmpController))
				{
					tmpCovered.push(tmpEntity);
				}
			}
			catch (pWrapError)
			{
				this._wrapperError(tmpEntity, 'wrapping the write path', pWrapError);
			}
		}
		return tmpCovered;
	}

	/**
	 * Does this intake capture the writes of a controller right now (its dispatcher still carries this
	 * intake's wrapper, or — ME-1 — its capture behaviors are registered)?  A property test, cheap
	 * enough for every cacheable request.
	 *
	 * @param {any} pController
	 * @return {boolean}
	 */
	isCovered(pController)
	{
		if ((typeof(pController) !== 'object') || (pController === null))
		{
			return false;
		}
		let tmpInjection = pController.BehaviorInjection;
		if (!tmpInjection)
		{
			return false;
		}
		if (typeof(tmpInjection.runBehavior) === 'function')
		{
			return this._ours(tmpInjection.runBehavior);
		}
		let tmpMarker = pController[INTAKE_MARKER];
		return (tmpMarker instanceof Set) && Object.keys(SLOTS).every((pSlot) => { return tmpMarker.has(pSlot); });
	}

	/**
	 * Is the entity's route-bound controller covered?  A dispatcher or DAL method replaced since the
	 * install is wrapped again (logged at warn), and — because writes in between may have gone
	 * unseen — an EntityDirty (every tenant) is ingested for the entity before this returns, so no
	 * answer computed during the gap survives.  Never throws.
	 *
	 * @param {string} pEntity
	 * @return {boolean}
	 */
	ensureCovered(pEntity)
	{
		let tmpHost = this._host();
		if (!tmpHost || (typeof(tmpHost.getRouteBoundController) !== 'function'))
		{
			return false;
		}
		try
		{
			let tmpController = tmpHost.getRouteBoundController(pEntity);
			if (!tmpController)
			{
				return false;
			}
			let tmpCovered = this.isCovered(tmpController);
			let tmpDALIntact = this._dalIntact(tmpController.DAL);
			if (tmpCovered && tmpDALIntact)
			{
				return true;
			}
			if (this.wrapController(pEntity, tmpController))
			{
				if (this.log)
				{
					this.log.warn(`RetoldFaceting change intake: the write path of ${libFacetUtil.logSafe(pEntity)} was replaced after the intake wrapped it; wrapped again (every cached answer over it is invalidated).`);
				}
				if (this.Intake)
				{
					this.Intake._Stats.Rewraps = (this.Intake._Stats.Rewraps || 0) + 1;
				}
				this._ingestFailClosed(pEntity, 'Rewrap');
			}
			return this.isCovered(tmpController);
		}
		catch (pCoverageError)
		{
			this._wrapperError(pEntity, 'checking the write path', pCoverageError);
			return false;
		}
	}

	/**
	 * Is a function one of this intake's wrappers?
	 *
	 * @param {any} fFunction
	 * @return {boolean}
	 */
	_ours(fFunction)
	{
		let tmpMarker = (typeof(fFunction) === 'function') ? fFunction[INTAKE_MARKER] : null;
		return !!tmpMarker && (tmpMarker.Intake === this);
	}

	/**
	 * Are the DAL's write methods (those it has) this intake's wrappers?
	 *
	 * @param {any} pDAL
	 * @return {boolean}
	 */
	_dalIntact(pDAL)
	{
		if ((typeof(pDAL) !== 'object') || (pDAL === null))
		{
			return true;
		}
		let tmpMethods = Object.keys(DAL_METHODS);
		for (let i = 0; i < tmpMethods.length; i++)
		{
			if ((typeof(pDAL[tmpMethods[i]]) === 'function') && !this._ours(pDAL[tmpMethods[i]]))
			{
				return false;
			}
		}
		return true;
	}

	/**
	 * The capture slots a controller is wrapped for (the four PostOperation slots when covered).
	 *
	 * @param {any} pController
	 * @return {Array<string>}
	 */
	wrappedSlots(pController)
	{
		return this.isCovered(pController) ? Object.keys(SLOTS) : [];
	}

	/**
	 * The ME-1 marker Set of a controller, created (non-enumerable) when pCreate.
	 *
	 * @param {any} pController
	 * @param {boolean} pCreate
	 * @return {Set<string>|null}
	 */
	_marker(pController, pCreate)
	{
		let tmpMarker = pController[INTAKE_MARKER];
		if (tmpMarker instanceof Set)
		{
			return tmpMarker;
		}
		if (!pCreate)
		{
			return null;
		}
		tmpMarker = new Set();
		Object.defineProperty(pController, INTAKE_MARKER, { value: tmpMarker, enumerable: false, configurable: false, writable: false });
		return tmpMarker;
	}

	/**
	 * Wrap one controller: its dispatcher (or, ME-1, its slots) and its DAL's write methods.
	 * Idempotent per intake.
	 *
	 * @param {string} pEntity
	 * @param {any} pController - a meadow-endpoints controller
	 * @return {boolean} true when something was wrapped now
	 */
	wrapController(pEntity, pController)
	{
		if ((typeof(pController) !== 'object') || (pController === null))
		{
			return false;
		}
		let tmpInjection = pController.BehaviorInjection;
		if (!tmpInjection || ((typeof(tmpInjection.runBehavior) !== 'function') && (typeof(tmpInjection.addBehavior) !== 'function')))
		{
			return false;
		}
		let tmpWrappedNow = false;
		if (typeof(tmpInjection.runBehavior) === 'function')
		{
			if (!this._ours(tmpInjection.runBehavior))
			{
				// An own (non-enumerable) property shadows the prototype method; the original runs with the
				// injection as this.
				Object.defineProperty(tmpInjection, 'runBehavior', { value: this._dispatcherFor(pEntity, tmpInjection.runBehavior), enumerable: false, configurable: true, writable: true });
				tmpWrappedNow = true;
			}
		}
		else
		{
			// ME-1: multi-subscriber slots (never replaced by a host's setBehavior).
			let tmpMarker = this._marker(pController, true);
			Object.keys(SLOTS).forEach(
				(pSlot) =>
				{
					if (!tmpMarker.has(pSlot))
					{
						tmpInjection.addBehavior(pSlot, this._behaviorFor(pEntity, pSlot, 'Capture'), Object.assign({}, ADD_BEHAVIOR_OPTIONS));
						tmpMarker.add(pSlot);
						tmpWrappedNow = true;
					}
				});
			Object.keys(SNAPSHOT_SLOTS).forEach(
				(pSlot) =>
				{
					let tmpName = `${pSlot}#Snapshot`;
					if (!tmpMarker.has(tmpName))
					{
						tmpInjection.addBehavior(pSlot, this._behaviorFor(pEntity, pSlot, 'Snapshot'), Object.assign({}, ADD_BEHAVIOR_OPTIONS));
						tmpMarker.add(tmpName);
						tmpWrappedNow = true;
					}
				});
			Object.keys(ARM_SLOTS).forEach(
				(pSlot) =>
				{
					let tmpName = `${pSlot}#Arm`;
					if (!tmpMarker.has(tmpName))
					{
						tmpInjection.addBehavior(pSlot, this._behaviorFor(pEntity, pSlot, 'Arm'), Object.assign({}, ADD_BEHAVIOR_ARM_OPTIONS));
						tmpMarker.add(tmpName);
						tmpWrappedNow = true;
					}
				});
		}
		if (this.wrapDAL(pEntity, pController.DAL))
		{
			tmpWrappedNow = true;
		}
		return tmpWrappedNow;
	}

	/**
	 * Wrap a DAL's write methods (those it has and that are not already this intake's).
	 *
	 * @param {string} pEntity
	 * @param {any} pDAL
	 * @return {boolean} true when a method was wrapped now
	 */
	wrapDAL(pEntity, pDAL)
	{
		if ((typeof(pDAL) !== 'object') || (pDAL === null))
		{
			return false;
		}
		let tmpWrapped = false;
		Object.keys(DAL_METHODS).forEach(
			(pMethod) =>
			{
				let fOriginal = pDAL[pMethod];
				if ((typeof(fOriginal) !== 'function') || this._ours(fOriginal))
				{
					return;
				}
				pDAL[pMethod] = this._dalMethodFor(pEntity, pMethod, fOriginal);
				tmpWrapped = true;
			});
		return tmpWrapped;
	}

	// ---------------------------------------------------------------- the wrappers

	/**
	 * The dispatcher wrapper of one controller.  A `function`: runBehavior is called as a method of the
	 * BehaviorInjection (this), which the original keeps.
	 *
	 * @param {string} pEntity
	 * @param {Function} fOriginal - the dispatcher that was in place
	 * @return {Function}
	 */
	_dispatcherFor(pEntity, fOriginal)
	{
		let tmpSelf = this;
		let fDispatch = function (pBehaviorHash, pController, pRequest, pRequestState, fCallback)
		{
			if (!INTERCEPTED.has(pBehaviorHash) || (typeof(fCallback) !== 'function') || !tmpSelf._active())
			{
				return fOriginal.apply(this, arguments);
			}
			tmpSelf._beforeSlot(pEntity, pBehaviorHash, pRequest, pRequestState);
			if (!Object.prototype.hasOwnProperty.call(ARM_SLOTS, pBehaviorHash))
			{
				return fOriginal.call(this, pBehaviorHash, pController, pRequest, pRequestState, fCallback);
			}
			let fArmed = function (...pArguments)
			{
				if (!pArguments[0])
				{
					tmpSelf._arm(pEntity, pBehaviorHash, pRequest, pRequestState);
				}
				return fCallback.apply(this, pArguments);
			};
			return fOriginal.call(this, pBehaviorHash, pController, pRequest, pRequestState, fArmed);
		};
		Object.defineProperty(fDispatch, INTAKE_MARKER, { value: { Intake: this, Entity: pEntity, Original: fOriginal }, enumerable: false });
		return fDispatch;
	}

	/**
	 * An ME-1 behavior (capture, snapshot or arm); never calls back an error.
	 *
	 * @param {string} pEntity
	 * @param {string} pSlot
	 * @param {string} pRole - 'Capture' | 'Snapshot' | 'Arm'
	 * @return {Function}
	 */
	_behaviorFor(pEntity, pSlot, pRole)
	{
		let tmpSelf = this;
		return function (pRequest, pRequestState, fCallback)
		{
			if (tmpSelf._active())
			{
				if (pRole === 'Arm')
				{
					tmpSelf._arm(pEntity, pSlot, pRequest, pRequestState);
				}
				else
				{
					tmpSelf._beforeSlot(pEntity, pSlot, pRequest, pRequestState);
				}
			}
			return fCallback();
		};
	}

	/**
	 * A DAL write method wrapper: an armed query's outcome is observed; anything else passes through.
	 *
	 * @param {string} pEntity
	 * @param {string} pMethod
	 * @param {Function} fOriginal
	 * @return {Function}
	 */
	_dalMethodFor(pEntity, pMethod, fOriginal)
	{
		let tmpSelf = this;
		let tmpOperation = DAL_METHODS[pMethod];
		let fWrapped = function (pQuery, fCallback)
		{
			let tmpPending = ((typeof(pQuery) === 'object') && (pQuery !== null)) ? pQuery[PENDING_MARKER] : null;
			if (!tmpPending || (typeof(fCallback) !== 'function'))
			{
				return fOriginal.apply(this, arguments);
			}
			// A query is written once: consume the arm.
			defineHidden(pQuery, PENDING_MARKER, null);
			let fObserved = function (...pResults)
			{
				tmpSelf._afterWrite(pEntity, tmpOperation, tmpPending, pQuery, pResults);
				return fCallback.apply(this, pResults);
			};
			return fOriginal.call(this, pQuery, fObserved);
		};
		Object.defineProperty(fWrapped, INTAKE_MARKER, { value: { Intake: this, Entity: pEntity, Original: fOriginal }, enumerable: false });
		return fWrapped;
	}

	// ---------------------------------------------------------------- per-slot work (never throws)

	/**
	 * The request state's marker, created when pCreate.
	 *
	 * @param {any} pRequestState
	 * @param {boolean} pCreate
	 * @return {{ Ingested: boolean, Before: Record<string, any>|null }|null}
	 */
	_stateOf(pRequestState, pCreate)
	{
		if (!recordOf(pRequestState))
		{
			return null;
		}
		let tmpMarker = pRequestState[STATE_MARKER];
		if (tmpMarker || !pCreate)
		{
			return tmpMarker || null;
		}
		tmpMarker = { Ingested: false, Before: null };
		defineHidden(pRequestState, STATE_MARKER, tmpMarker);
		return tmpMarker;
	}

	/**
	 * Before a slot's behavior runs: snapshot the pre-image (Pre slots), or capture and ingest the
	 * change (PostOperation slots).  Never throws.
	 *
	 * @param {string} pEntity
	 * @param {string} pSlot
	 * @param {any} pRequest
	 * @param {any} pRequestState
	 */
	_beforeSlot(pEntity, pSlot, pRequest, pRequestState)
	{
		try
		{
			if (Object.prototype.hasOwnProperty.call(SNAPSHOT_SLOTS, pSlot))
			{
				let tmpState = this._stateOf(pRequestState, true);
				if (tmpState && !tmpState.Before)
				{
					tmpState.Before = copyRecord(pRequestState.OriginalRecord) || copyRecord(pRequestState.Record);
				}
				return;
			}
			if (!Object.prototype.hasOwnProperty.call(SLOTS, pSlot))
			{
				return;
			}
			let tmpState = this._stateOf(pRequestState, true);
			if (tmpState && tmpState.Ingested)
			{
				return;
			}
			if (tmpState)
			{
				tmpState.Ingested = true;
			}
			this._ingestWithFallback(pEntity, this._safeCapture(pEntity, pSlot, pRequest, pRequestState));
		}
		catch (pSlotError)
		{
			this._wrapperError(pEntity, `observing ${pSlot}`, pSlotError);
		}
	}

	/**
	 * Arm the write query of a request state (the last slot before the DAL call succeeded).
	 *
	 * @param {string} pEntity
	 * @param {string} pSlot
	 * @param {any} pRequest
	 * @param {any} pRequestState
	 */
	_arm(pEntity, pSlot, pRequest, pRequestState)
	{
		try
		{
			let tmpQuery = recordOf(pRequestState) ? pRequestState.Query : null;
			if ((typeof(tmpQuery) !== 'object') || (tmpQuery === null))
			{
				return;
			}
			this._stateOf(pRequestState, true);
			defineHidden(tmpQuery, PENDING_MARKER, { Entity: pEntity, Operation: ARM_SLOTS[pSlot], State: pRequestState, Request: pRequest });
		}
		catch (pArmError)
		{
			this._wrapperError(pEntity, `arming ${pSlot}`, pArmError);
		}
	}

	/**
	 * After an armed DAL write called back: a failure (an error, or Create / Update without a
	 * record) may still have committed, and no PostOperation will run, so the conservative event is
	 * ingested (once per request state).  Never throws.
	 *
	 * @param {string} pEntity
	 * @param {string} pOperation
	 * @param {Record<string, any>} pPending
	 * @param {any} pQuery
	 * @param {Array<any>} pResults - the DAL callback's arguments
	 */
	_afterWrite(pEntity, pOperation, pPending, pQuery, pResults)
	{
		try
		{
			let tmpOperation = (typeof(pPending.Operation) === 'string') ? pPending.Operation : pOperation;
			let tmpFailed = !!pResults[0] || (((tmpOperation === 'Create') || (tmpOperation === 'Update')) && !recordOf(pResults[3]));
			if (!tmpFailed || !this._active())
			{
				return;
			}
			let tmpState = this._stateOf(pPending.State, true);
			if (tmpState && tmpState.Ingested)
			{
				return;
			}
			if (tmpState)
			{
				tmpState.Ingested = true;
			}
			if (this.Intake)
			{
				this.Intake._Stats.UnconfirmedWrites = (this.Intake._Stats.UnconfirmedWrites || 0) + 1;
			}
			let tmpRaw = null;
			try
			{
				tmpRaw = this.unconfirmedChange(pEntity, tmpOperation, pPending, pQuery);
			}
			catch (pCaptureError)
			{
				this._wrapperError(pEntity, `capturing an unconfirmed ${tmpOperation}`, pCaptureError);
			}
			this._ingestWithFallback(pEntity, tmpRaw);
		}
		catch (pWriteError)
		{
			this._wrapperError(pEntity, 'observing a write', pWriteError);
		}
	}

	/**
	 * The conservative raw change of a write whose outcome is unknown (internal-contracts §40.4): the
	 * pre-image (the snapshot) and the record actually submitted to the provider
	 * (pQuery.query.records[0]); an Update's after-image is the pre-image overlaid with the submitted
	 * columns; ChangedColumns null ('#all').
	 *
	 * @param {string} pEntity
	 * @param {string} pOperation
	 * @param {Record<string, any>} pPending
	 * @param {any} pQuery
	 * @return {Record<string, any>}
	 */
	unconfirmedChange(pEntity, pOperation, pPending, pQuery)
	{
		let tmpRequestState = recordOf(pPending.State) || {};
		let tmpState = this._stateOf(tmpRequestState, false);
		let tmpBefore = (tmpState && tmpState.Before) ? tmpState.Before : recordOf(tmpRequestState.OriginalRecord);
		let tmpRecords = (pQuery && pQuery.query && Array.isArray(pQuery.query.records)) ? pQuery.query.records : [];
		let tmpSubmitted = recordOf(tmpRecords[0]);
		let tmpExtra = { Source: 'Interim', Actor: this.actorOf(pPending.Request, tmpRequestState), ChangedColumns: null };
		switch (pOperation)
		{
			case 'Create':
				return this.Intake.changeFromRows(pEntity, 'Create', null, tmpSubmitted || recordOf(tmpRequestState.RecordToCreate), tmpExtra);
			case 'Update':
				tmpExtra.Submitted = tmpSubmitted;
				return this.Intake.changeFromRows(pEntity, 'Update', tmpBefore,
					tmpBefore ? Object.assign({}, tmpBefore, tmpSubmitted || {}) : tmpSubmitted, tmpExtra);
			default:
				if ((typeof(tmpRequestState.IDRecord) === 'number') || (typeof(tmpRequestState.IDRecord) === 'string'))
				{
					tmpExtra.FallbackIDs = [ tmpRequestState.IDRecord ];
				}
				return this.Intake.changeFromRows(pEntity, pOperation, tmpBefore || recordOf(tmpRequestState.Record), null, tmpExtra);
		}
	}

	/**
	 * Ingest a captured raw change (only while this intake's source is the interim one); when there is
	 * no usable change (the capture failed, or ingest refused it), fail closed: an EntityDirty of
	 * every tenant (internal-contracts §40.2 rule 3).  Never throws.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>|null} pRaw
	 * @return {Readonly<Record<string, any>>|null}
	 */
	_ingestWithFallback(pEntity, pRaw)
	{
		if (!this._active())
		{
			return null;
		}
		let tmpEvent = null;
		if (pRaw)
		{
			try
			{
				tmpEvent = this.Intake.ingest(pRaw);
			}
			catch (pIngestError)
			{
				// ingest never throws; belt and braces for a write path.
				this._wrapperError(pEntity, 'ingesting the change', pIngestError);
			}
		}
		if (tmpEvent)
		{
			return tmpEvent;
		}
		return this._ingestFailClosed(pEntity, 'CaptureFailed');
	}

	/**
	 * Ingest an EntityDirty of every tenant for an entity (fail closed; counted).  Never throws.
	 *
	 * @param {string} pEntity
	 * @param {string} pReason - stats bucket ('CaptureFailed', 'Rewrap')
	 * @return {Readonly<Record<string, any>>|null}
	 */
	_ingestFailClosed(pEntity, pReason)
	{
		if (!this.Intake || (typeof(pEntity) !== 'string') || (pEntity.length < 1))
		{
			return null;
		}
		try
		{
			this.Intake._Stats.FailClosed = (this.Intake._Stats.FailClosed || 0) + 1;
			return this.Intake.ingest(
				{
					Source: 'Interim',
					Entity: pEntity,
					Operation: 'EntityDirty',
					IDs: [],
					Tenants: [ '*' ],
					Owners: null,
					ChangedColumns: null,
					KeyImages: {},
					Filter: null,
					Actor: { PrincipalKey: null, UserID: 0, Verb: pReason }
				});
		}
		catch (pIngestError)
		{
			this._wrapperError(pEntity, 'ingesting a fail-closed change', pIngestError);
			return null;
		}
	}

	/**
	 * Capture at entry, swallowing (and counting) any failure.
	 *
	 * @param {string} pEntity
	 * @param {string} pSlot
	 * @param {any} pRequest
	 * @param {any} pRequestState
	 * @return {Record<string, any>|null}
	 */
	_safeCapture(pEntity, pSlot, pRequest, pRequestState)
	{
		try
		{
			return this.captureChange(pEntity, pSlot, pRequest, pRequestState);
		}
		catch (pCaptureError)
		{
			this._wrapperError(pEntity, `capturing ${pSlot}`, pCaptureError);
			return null;
		}
	}

	/**
	 * The writing principal's identity and the endpoint verb (internal-contracts §40.3 Actor).  A
	 * principal that cannot be built leaves PrincipalKey null (no read-your-writes for that write).
	 * The principal is built once per (request, session) and reused for every record of a bulk write.
	 *
	 * @param {any} pRequest
	 * @param {Record<string, any>} pRequestState
	 * @return {{ PrincipalKey: string|null, UserID: any, Verb: string }}
	 */
	actorOf(pRequest, pRequestState)
	{
		let tmpActor = { PrincipalKey: null, UserID: 0, Verb: this.verbOf(pRequestState) };
		let tmpHost = this._host();
		if (!tmpHost || (typeof(tmpHost.buildPrincipal) !== 'function'))
		{
			return tmpActor;
		}
		let tmpSession = recordOf(pRequestState) ? pRequestState.SessionData : null;
		let tmpMemo = ((typeof(pRequest) === 'object') && (pRequest !== null)) ? this._Actors.get(pRequest) : null;
		if (tmpMemo && (tmpMemo.Session === tmpSession))
		{
			tmpActor.PrincipalKey = tmpMemo.PrincipalKey;
			tmpActor.UserID = tmpMemo.UserID;
			return tmpActor;
		}
		try
		{
			let tmpPrincipal = tmpHost.buildPrincipal(tmpSession, pRequest);
			// §71.2: the identity key (no role set), as read-your-writes looks reads up.
			tmpActor.PrincipalKey = libRetoldFacetingUtil.principalIdentityKey(tmpPrincipal);
			let tmpUserID = libRetoldFacetingUtil.normalizeScopeValue(tmpPrincipal ? tmpPrincipal.IDUser : null);
			tmpActor.UserID = (tmpUserID === null) ? 0 : tmpUserID;
		}
		catch (pPrincipalError)
		{
			if (this.log)
			{
				this.log.debug(`RetoldFaceting change intake: the writing principal could not be built (no read-your-writes for this write): ${libFacetUtil.logSafe(pPrincipalError.message)}`);
			}
			tmpActor.PrincipalKey = null;
			tmpActor.UserID = 0;
		}
		if ((typeof(pRequest) === 'object') && (pRequest !== null))
		{
			this._Actors.set(pRequest, { Session: tmpSession, PrincipalKey: tmpActor.PrincipalKey, UserID: tmpActor.UserID });
		}
		return tmpActor;
	}

	/**
	 * The endpoint verb of a write: the Verb of the outermost request state ('Create', 'CreateBulk',
	 * 'Update', 'UpdateBulk', 'Upsert', 'UpsertBulk', 'UpsertBulkDetailed', 'Delete', 'Undelete'),
	 * walking up from the per-record operation state ('doCreate' / 'doUpdate').
	 *
	 * @param {Record<string, any>} pRequestState
	 * @return {string}
	 */
	verbOf(pRequestState)
	{
		let tmpVerb = null;
		let tmpState = recordOf(pRequestState);
		for (let i = 0; (i < MAX_VERB_DEPTH) && tmpState; i++)
		{
			if ((typeof(tmpState.Verb) === 'string') && (tmpState.Verb.length > 0))
			{
				tmpVerb = tmpState.Verb;
			}
			tmpState = recordOf(tmpState.ParentRequestState);
		}
		return tmpVerb ? tmpVerb.slice(0, 64) : 'Unknown';
	}

	/**
	 * The raw change of one committed write, computed from the request state at PostOperation entry
	 * (internal-contracts §40.3).  An Update's before-image is the snapshot taken at Update-PreOperation
	 * entry; without one (a host that replaced the dispatcher, a test calling a slot directly) it is
	 * OriginalRecord, which a PreOperation behavior may have mutated through the shared Record object,
	 * so the submitted model columns are added to the diff and a submitted policy column whose two
	 * images agree adds the unknown tenant / owner (§51.47).
	 *
	 * @param {string} pEntity
	 * @param {string} pSlot - e.g. 'Update-PostOperation'
	 * @param {any} pRequest
	 * @param {Record<string, any>} pRequestState
	 * @return {Record<string, any>|null}
	 */
	captureChange(pEntity, pSlot, pRequest, pRequestState)
	{
		if (!Object.prototype.hasOwnProperty.call(SLOTS, pSlot) || !this.Intake)
		{
			return null;
		}
		let tmpOperation = SLOTS[pSlot];
		let tmpRequestState = recordOf(pRequestState) || {};
		let tmpState = this._stateOf(tmpRequestState, false);
		let tmpSnapshot = (tmpState && tmpState.Before) ? tmpState.Before : null;
		let tmpExtra = { Source: 'Interim', Actor: this.actorOf(pRequest, tmpRequestState) };
		let tmpBefore = null;
		let tmpAfter = null;
		switch (tmpOperation)
		{
			case 'Create':
				tmpAfter = recordOf(tmpRequestState.Record) || recordOf(tmpRequestState.RecordToCreate);
				break;
			case 'Update':
				tmpBefore = tmpSnapshot || recordOf(tmpRequestState.OriginalRecord);
				tmpAfter = recordOf(tmpRequestState.Record);
				tmpExtra.Submitted = recordOf(tmpRequestState.RecordToModify);
				if (!tmpSnapshot && tmpBefore)
				{
					tmpExtra.BeforeMayBeAliased = true;
				}
				break;
			case 'Delete':
				tmpBefore = tmpSnapshot || recordOf(tmpRequestState.OriginalRecord) || recordOf(tmpRequestState.Record);
				if ((typeof(tmpRequestState.IDRecord) === 'number') || (typeof(tmpRequestState.IDRecord) === 'string'))
				{
					tmpExtra.FallbackIDs = [ tmpRequestState.IDRecord ];
				}
				break;
			case 'Undelete':
				tmpBefore = tmpSnapshot || recordOf(tmpRequestState.OriginalRecord) || recordOf(tmpRequestState.Record);
				break;
		}
		return this.Intake.changeFromRows(pEntity, tmpOperation, tmpBefore, tmpAfter, tmpExtra);
	}
}

module.exports = ChangeIntakeInterim;
module.exports.INTAKE_MARKER = INTAKE_MARKER;
module.exports.STATE_MARKER = STATE_MARKER;
module.exports.PENDING_MARKER = PENDING_MARKER;
module.exports.SLOTS = SLOTS;
module.exports.SNAPSHOT_SLOTS = SNAPSHOT_SLOTS;
module.exports.ARM_SLOTS = ARM_SLOTS;
module.exports.DAL_METHODS = DAL_METHODS;
module.exports.ADD_BEHAVIOR_OPTIONS = ADD_BEHAVIOR_OPTIONS;
