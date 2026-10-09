/**
 * Faceting-Demo-Writes -- the demo's write surface (internal-contracts §47.4–§47.5).  DEMO ONLY.
 *
 *   WRITE_ROUTES                    the front proxy's write allowlist: exactly the "Make a change" requests
 *                                   ({ Action, Domain, Method, Path (display), Pattern (RegExp over the upstream path; group 1 =
 *                                   the record ID of a path-addressed write), Entity, Operation, Fields: [ permitted
 *                                   body keys ], Required, Rules }); anything else under /api/<Domain>/1.0/ stays
 *                                   404 DEMO_NOT_FOUND, extra body keys are 400 DEMO_WRITE_INVALID; JSON only,
 *                                   ≤ MAX_WRITE_BODY_BYTES
 *   matchWrite(pDomain, pMethod, pUpstreamPath) → route | null
 *   checkBody(pRoute, pBody) → null | { Code, Message, Detail }
 *   installWriteGuards(pDomain, pHarness)   chain-wraps (harness.installBehavior, AFTER boot) on every entity:
 *                                   Create-PreOperation stamps the tenant column (and the PersonalScopes owner
 *                                   column: OwnerIDUser on LabForm) from the session and refuses (403) a body naming
 *                                   another, and refuses (403) a foreign key (IDProject, IDBook, IDFormType, …) whose
 *                                   row is not in the persona's tenant (or, for a shared lookup, does not exist);
 *                                   Update- / Delete- / Undelete-PreOperation refuse (403) a row outside the
 *                                   session's tenant (and owner on LabForm), an update that moves a row out of them,
 *                                   and — OWNERSHIP_RULES — a row the persona does not own: a Project the persona is
 *                                   not an active member of, a Document it neither created nor is an active member
 *                                   of the project of, a Review it did not write; a global (excluded / tenant-less)
 *                                   entity is not writable (403); no session is 401.  The faceting intake wraps the
 *                                   behavior dispatcher, never a slot, so these guards and the intake never touch
 *                                   each other.  Sets pHarness.DemoWriteGuard = { Installed, Entities, Refused,
 *                                   LastRefused }.
 *
 * The domain servers are the module's test harness (any loopback client may write through their stock CRUD
 * routes with x-facet-test-* headers), so the guards are what keeps a demo write inside the persona's own data
 * even if the proxy were bypassed; the proxy's allowlist is what keeps the CRUD API closed to the browser.
 *
 * Contract: internal-contracts §47.4–§47.5.  Owner: builder D (M4).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */

// Largest write body the proxy forwards.
const MAX_WRITE_BODY_BYTES = 16 * 1024;

const ERROR_CODE = 'DEMO_WRITE_INVALID';

// A record ID in a path ('/1.0/Document/12').
const ID_PATTERN = '([1-9][0-9]{0,9})';

const PROJECT_STATUSES = Object.freeze([ 'Active', 'AtRisk', 'OnHold', 'Done' ]);
const LAB_FORM_STATUSES = Object.freeze([ 'Complete', 'Pending' ]);

// The behavior slots a guard sits in (the PreOperation of every per-record write).
const GUARD_SLOTS = Object.freeze([ 'Create-PreOperation', 'Update-PreOperation', 'Delete-PreOperation', 'Undelete-PreOperation' ]);

// Who may change an existing row beyond its tenant (S10, "the UI's 'my' scope"): Creator — the persona wrote it
// (CreatingIDUser); Membership — the persona is an active member of the project the row belongs to.
const OWNERSHIP_RULES = Object.freeze(
	{
		Project: Object.freeze({ Creator: false, Membership: Object.freeze({ Entity: 'ProjectMembership', Via: 'IDProject' }) }),
		Document: Object.freeze({ Creator: true, Membership: Object.freeze({ Entity: 'ProjectMembership', Via: 'IDProject' }) }),
		Review: Object.freeze({ Creator: true, Membership: null })
	});

/**
 * @param {Record<string, any>} pRoute
 * @return {Record<string, any>}
 */
const freezeRoute = (pRoute) =>
{
	pRoute.Fields = Object.freeze(pRoute.Fields || []);
	pRoute.Required = Object.freeze(pRoute.Required || []);
	pRoute.Rules = Object.freeze(pRoute.Rules || {});
	return Object.freeze(pRoute);
};

// The allowlist: internal-contracts §47.4, row for row.
const WRITE_ROUTES = Object.freeze(
	[
		// Projects for me: set the status of a listed project (Active / At risk / On hold / Done); Undo is the same PUT.
		freezeRoute(
			{
				Action: 'ProjectStatus', Domain: 'ProjectTrack', Method: 'PUT', Path: '/1.0/Project', Pattern: /^\/1\.0\/Project$/, Entity: 'Project', Operation: 'Update',
				Fields: [ 'IDProject', 'Status' ], Required: [ 'IDProject', 'Status' ],
				Rules: { IDProject: { Type: 'ID' }, Status: { Enum: PROJECT_STATUSES } }
			}),
		// Documents by form type: add a Draft document of the selected form type; delete it; undelete it.
		freezeRoute(
			{
				Action: 'DocumentAdd', Domain: 'ProjectTrack', Method: 'POST', Path: '/1.0/Document', Pattern: /^\/1\.0\/Document$/, Entity: 'Document', Operation: 'Create',
				Fields: [ 'Title', 'Status', 'DocumentDate', 'IDFormType', 'IDProject' ], Required: [ 'Title', 'Status', 'DocumentDate', 'IDFormType', 'IDProject' ],
				Rules: { Title: { Type: 'Text', Max: 120 }, Status: { Enum: [ 'Draft' ] }, DocumentDate: { Type: 'Date' }, IDFormType: { Type: 'ID' }, IDProject: { Type: 'ID' } }
			}),
		freezeRoute(
			{
				Action: 'DocumentDelete', Domain: 'ProjectTrack', Method: 'DELETE', Path: '/1.0/Document/<ID>', Pattern: new RegExp(`^/1\\.0/Document/${ID_PATTERN}$`), Entity: 'Document', Operation: 'Delete',
				Fields: []
			}),
		freezeRoute(
			{
				Action: 'DocumentUndelete', Domain: 'ProjectTrack', Method: 'GET', Path: '/1.0/Document/Undelete/<ID>', Pattern: new RegExp(`^/1\\.0/Document/Undelete/${ID_PATTERN}$`), Entity: 'Document', Operation: 'Undelete',
				Fields: []
			}),
		// Lab forms (A): complete one of my started forms; re-open it.
		freezeRoute(
			{
				Action: 'LabFormStatus', Domain: 'LabTrack', Method: 'PUT', Path: '/1.0/LabForm', Pattern: /^\/1\.0\/LabForm$/, Entity: 'LabForm', Operation: 'Update',
				Fields: [ 'IDLabForm', 'Status', 'CompletedDate' ], Required: [ 'IDLabForm', 'Status' ],
				Rules: { IDLabForm: { Type: 'ID' }, Status: { Enum: LAB_FORM_STATUSES }, CompletedDate: { Type: 'Date', Nullable: true } }
			}),
		// Bookstore explorer: add a 5-star review to the first listed book; remove it.
		freezeRoute(
			{
				Action: 'ReviewAdd', Domain: 'Bookstore', Method: 'POST', Path: '/1.0/Review', Pattern: /^\/1\.0\/Review$/, Entity: 'Review', Operation: 'Create',
				Fields: [ 'IDBook', 'Rating', 'Text' ], Required: [ 'IDBook', 'Rating' ],
				Rules: { IDBook: { Type: 'ID' }, Rating: { Type: 'Integer', Min: 1, Max: 5 }, Text: { Type: 'Text', Max: 500 } }
			}),
		freezeRoute(
			{
				Action: 'ReviewDelete', Domain: 'Bookstore', Method: 'DELETE', Path: '/1.0/Review/<ID>', Pattern: new RegExp(`^/1\\.0/Review/${ID_PATTERN}$`), Entity: 'Review', Operation: 'Delete',
				Fields: []
			})
	]);

/**
 * The allowlisted write a request is, or null.
 *
 * @param {string} pDomain
 * @param {string} pMethod
 * @param {string} pUpstreamPath - '/1.0/<Entity>…' (still percent-encoded: an encoded character never matches)
 * @return {Record<string, any>|null}
 */
const matchWrite = (pDomain, pMethod, pUpstreamPath) =>
{
	let tmpMethod = String(pMethod || '').toUpperCase();
	if (typeof(pUpstreamPath) !== 'string')
	{
		return null;
	}
	for (let i = 0; i < WRITE_ROUTES.length; i++)
	{
		let tmpRoute = WRITE_ROUTES[i];
		if ((tmpRoute.Domain === pDomain) && (tmpRoute.Method === tmpMethod) && tmpRoute.Pattern.test(pUpstreamPath))
		{
			return tmpRoute;
		}
	}
	return null;
};

/**
 * The record ID of a path-addressed write ('/1.0/Document/12' -> 12), or null.
 *
 * @param {Record<string, any>} pRoute
 * @param {string} pUpstreamPath
 * @return {number|null}
 */
const pathID = (pRoute, pUpstreamPath) =>
{
	let tmpMatch = (pRoute && (typeof(pUpstreamPath) === 'string')) ? pRoute.Pattern.exec(pUpstreamPath) : null;
	return (tmpMatch && tmpMatch[1]) ? parseInt(tmpMatch[1], 10) : null;
};

/**
 * @param {string} pMessage
 * @param {Record<string, any>} [pDetail]
 * @return {{ Code: string, Message: string, Detail?: Record<string, any> }}
 */
const invalid = (pMessage, pDetail) =>
{
	let tmpError = { Code: ERROR_CODE, Message: pMessage };
	if (pDetail)
	{
		tmpError.Detail = pDetail;
	}
	return tmpError;
};

/**
 * Is a value a date the demo accepts ('YYYY-MM-DD', 'YYYY-MM-DD HH:mm[:ss]' or an ISO date-time)?
 *
 * @param {any} pValue
 * @return {boolean}
 */
const isDateValue = (pValue) =>
{
	if ((typeof(pValue) !== 'string') || !/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z)?)?$/.test(pValue))
	{
		return false;
	}
	return !isNaN(Date.parse(pValue.replace(' ', 'T')));
};

/**
 * Check one value against its rule.
 *
 * @param {string} pField
 * @param {any} pValue
 * @param {Record<string, any>} pRule
 * @return {{ Code: string, Message: string, Detail?: Record<string, any> }|null}
 */
const checkValue = (pField, pValue, pRule) =>
{
	let tmpRule = pRule || {};
	if (pValue === null)
	{
		return (tmpRule.Nullable === true) ? null : invalid(`${pField} may not be null.`, { Field: pField });
	}
	if (Array.isArray(tmpRule.Enum))
	{
		return (tmpRule.Enum.indexOf(pValue) >= 0) ? null : invalid(`${pField} must be one of ${tmpRule.Enum.join(', ')}.`, { Field: pField, Allowed: tmpRule.Enum.slice() });
	}
	switch (tmpRule.Type)
	{
		case 'ID':
			return (Number.isInteger(pValue) && (pValue > 0) && (pValue < 1e10)) ? null : invalid(`${pField} must be a positive integer.`, { Field: pField });
		case 'Integer':
			if (!Number.isInteger(pValue) || ((typeof(tmpRule.Min) === 'number') && (pValue < tmpRule.Min)) || ((typeof(tmpRule.Max) === 'number') && (pValue > tmpRule.Max)))
			{
				return invalid(`${pField} must be an integer from ${tmpRule.Min} to ${tmpRule.Max}.`, { Field: pField, Min: tmpRule.Min, Max: tmpRule.Max });
			}
			return null;
		case 'Text':
			if ((typeof(pValue) !== 'string') || (pValue.trim().length < 1) || (pValue.length > (tmpRule.Max || 200)))
			{
				return invalid(`${pField} must be text of 1 to ${tmpRule.Max || 200} characters.`, { Field: pField, Max: tmpRule.Max || 200 });
			}
			return null;
		case 'Date':
			return isDateValue(pValue) ? null : invalid(`${pField} must be a date (YYYY-MM-DD or YYYY-MM-DD HH:mm:ss).`, { Field: pField });
		default:
			return invalid(`${pField} has no rule.`, { Field: pField });
	}
};

/**
 * Check a write body against its route: a plain object with only the permitted keys, every required key, and
 * each value of the right shape.  A route without Fields takes no body (absent, null or {}).
 *
 * @param {Record<string, any>} pRoute
 * @param {any} pBody - the parsed JSON body (undefined when the request had none)
 * @return {{ Code: string, Message: string, Detail?: Record<string, any> }|null}
 */
const checkBody = (pRoute, pBody) =>
{
	if (!pRoute || !Array.isArray(pRoute.Fields))
	{
		return invalid('Not an allowlisted demo write.');
	}
	let tmpIsObject = (pBody !== null) && (typeof(pBody) === 'object') && !Array.isArray(pBody);
	if (pRoute.Fields.length < 1)
	{
		if ((typeof(pBody) === 'undefined') || (pBody === null) || (tmpIsObject && (Object.keys(pBody).length < 1)))
		{
			return null;
		}
		return invalid(`${pRoute.Method} ${pRoute.Entity} takes no body.`);
	}
	if (!tmpIsObject)
	{
		return invalid('The body must be a JSON object.');
	}
	let tmpKeys = Object.keys(pBody);
	for (let i = 0; i < tmpKeys.length; i++)
	{
		if (pRoute.Fields.indexOf(tmpKeys[i]) < 0)
		{
			return invalid(`${tmpKeys[i]} is not writable through the demo (${pRoute.Action} permits ${pRoute.Fields.join(', ')}).`, { Field: tmpKeys[i], Allowed: pRoute.Fields.slice() });
		}
	}
	for (let i = 0; i < pRoute.Required.length; i++)
	{
		if (!Object.prototype.hasOwnProperty.call(pBody, pRoute.Required[i]))
		{
			return invalid(`${pRoute.Required[i]} is required.`, { Field: pRoute.Required[i], Required: true });
		}
	}
	for (let i = 0; i < tmpKeys.length; i++)
	{
		let tmpError = checkValue(tmpKeys[i], pBody[tmpKeys[i]], pRoute.Rules[tmpKeys[i]]);
		if (tmpError)
		{
			return tmpError;
		}
	}
	return null;
};

/**
 * A scope value that names nobody (the harness's anonymous session carries 0).
 *
 * @param {any} pValue
 * @return {boolean}
 */
const isUnset = (pValue) =>
{
	return (pValue === null) || (typeof(pValue) === 'undefined') || (pValue === 0) || (pValue === '') || (pValue === '0');
};

/**
 * @param {any} pLeft
 * @param {any} pRight
 * @return {boolean}
 */
const sameValue = (pLeft, pRight) =>
{
	return !isUnset(pLeft) && !isUnset(pRight) && (String(pLeft) === String(pRight));
};

/**
 * Read one row through a domain's DAL (meadow's delete tracking hides deleted rows), with exact filters.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity
 * @param {Record<string, any>} pFilters - { Column: Value }
 * @param {(pRow: Record<string, any>|null) => void} fCallback - null on any error or no row
 */
const readRow = (pHarness, pEntity, pFilters, fCallback) =>
{
	let tmpDAL = (pHarness.fable && pHarness.fable.DAL) ? pHarness.fable.DAL[pEntity] : null;
	if (!tmpDAL)
	{
		return fCallback(null);
	}
	try
	{
		let tmpQuery = tmpDAL.query;
		Object.keys(pFilters).forEach((pColumn) => { tmpQuery.addFilter(pColumn, pFilters[pColumn]); });
		tmpDAL.doRead(tmpQuery, (pError, pQuery, pRecord) => { return fCallback((!pError && pRecord) ? pRecord : null); });
	}
	catch (pReadError)
	{
		return fCallback(null);
	}
};

/**
 * The guard behaviors of one entity.
 *
 * @param {Record<string, any>} pSpec - { Entity, TenantColumn (null: a global entity), TenantSessionField, Personal: { Column, SessionField } | null,
 *                                       References: [ { Column, Entity, TenantColumn } ], Ownership: OWNERSHIP_RULES[Entity] | null }
 * @param {Record<string, any>} pGuardState - harness.DemoWriteGuard (counts refusals)
 * @param {Record<string, any>} pHarness - the domain's harness (DAL reads for references and ownership)
 * @return {Record<string, Function>} { <slot>: function (pRequest, pRequestState, fCallback) }
 */
const guardBehaviors = (pSpec, pGuardState, pHarness) =>
{
	let fDeny = (pController, pRequestState, pStatus, pMessage, fCallback) =>
	{
		pGuardState.Refused++;
		pGuardState.LastRefused = { Entity: pSpec.Entity, Verb: pRequestState.Verb || null, Status: pStatus, At: new Date().toISOString() };
		return fCallback(pController.ErrorHandler.getError(pMessage, pStatus));
	};
	// Session values, or an error message (401) when the session names no tenant / owner.
	let fSession = (pRequestState) =>
	{
		let tmpSession = pRequestState.SessionData || {};
		let tmpTenant = tmpSession[pSpec.TenantSessionField];
		if (isUnset(tmpTenant))
		{
			return null;
		}
		let tmpOwner = pSpec.Personal ? tmpSession[pSpec.Personal.SessionField] : null;
		if (pSpec.Personal && isUnset(tmpOwner))
		{
			return null;
		}
		return { Tenant: tmpTenant, Owner: tmpOwner, User: tmpSession.UserID };
	};
	// Every foreign key of a new row names a row of the persona's tenant (or an existing shared lookup row).
	let fReferencesAllowed = (pRecord, pSession, fDone) =>
	{
		let tmpChecks = (pSpec.References || []).filter((pReference) => { return !isUnset(pRecord[pReference.Column]); });
		let fNext = (pIndex) =>
		{
			if (pIndex >= tmpChecks.length)
			{
				return fDone(null);
			}
			let tmpReference = tmpChecks[pIndex];
			let tmpFilters = {};
			tmpFilters[`ID${tmpReference.Entity}`] = pRecord[tmpReference.Column];
			if (tmpReference.TenantColumn)
			{
				tmpFilters[tmpReference.TenantColumn] = pSession.Tenant;
			}
			readRow(pHarness, tmpReference.Entity, tmpFilters, (pRow) => { return pRow ? fNext(pIndex + 1) : fDone(tmpReference); });
		};
		fNext(0);
	};
	// The persona owns an existing row (OWNERSHIP_RULES): wrote it, or is an active member of its project.
	let fOwned = (pRow, pSession, fDone) =>
	{
		let tmpRule = pSpec.Ownership;
		if (!tmpRule)
		{
			return fDone(true);
		}
		if (tmpRule.Creator && sameValue(pRow.CreatingIDUser, pSession.User))
		{
			return fDone(true);
		}
		if (!tmpRule.Membership || isUnset(pRow[tmpRule.Membership.Via]))
		{
			return fDone(false);
		}
		let tmpFilters = { IDUser: pSession.User, Active: 1 };
		tmpFilters[tmpRule.Membership.Via] = pRow[tmpRule.Membership.Via];
		if (pSpec.TenantColumn)
		{
			tmpFilters[pSpec.TenantColumn] = pSession.Tenant;
		}
		readRow(pHarness, tmpRule.Membership.Entity, tmpFilters, (pMembership) => { return fDone(!!pMembership); });
	};
	// The pre-image of an update / delete / undelete is inside the session's tenant (and owner)?
	let fRowAllowed = (pRow, pSession) =>
	{
		if (!pRow || (typeof(pRow) !== 'object'))
		{
			return false;
		}
		if (!sameValue(pRow[pSpec.TenantColumn], pSession.Tenant))
		{
			return false;
		}
		return !pSpec.Personal || sameValue(pRow[pSpec.Personal.Column], pSession.Owner);
	};
	let fCommon = (pController, pRequestState, fCallback) =>
	{
		let tmpSession = fSession(pRequestState);
		if (!tmpSession)
		{
			fDeny(pController, pRequestState, 401, 'DEMO write guard: the session names no tenant (sign in as a persona).', fCallback);
			return null;
		}
		if (!pSpec.TenantColumn)
		{
			fDeny(pController, pRequestState, 403, `DEMO write guard: ${pSpec.Entity} is shared by every tenant; the demo does not write it.`, fCallback);
			return null;
		}
		return tmpSession;
	};

	let tmpBehaviors = {};
	tmpBehaviors['Create-PreOperation'] = function (pRequest, pRequestState, fCallback)
	{
		let tmpSession = fCommon(this, pRequestState, fCallback);
		if (!tmpSession)
		{
			return;
		}
		let tmpRecord = pRequestState.RecordToCreate;
		if (!tmpRecord || (typeof(tmpRecord) !== 'object'))
		{
			return fCallback();
		}
		if (!isUnset(tmpRecord[pSpec.TenantColumn]) && !sameValue(tmpRecord[pSpec.TenantColumn], tmpSession.Tenant))
		{
			return fDeny(this, pRequestState, 403, `DEMO write guard: the ${pSpec.Entity} names another tenant.`, fCallback);
		}
		tmpRecord[pSpec.TenantColumn] = tmpSession.Tenant;
		if (pSpec.Personal)
		{
			if (!isUnset(tmpRecord[pSpec.Personal.Column]) && !sameValue(tmpRecord[pSpec.Personal.Column], tmpSession.Owner))
			{
				return fDeny(this, pRequestState, 403, `DEMO write guard: the ${pSpec.Entity} names another owner.`, fCallback);
			}
			tmpRecord[pSpec.Personal.Column] = tmpSession.Owner;
		}
		let tmpController = this;
		fReferencesAllowed(tmpRecord, tmpSession,
			(pRefused) =>
			{
				if (pRefused)
				{
					return fDeny(tmpController, pRequestState, 403, `DEMO write guard: the ${pRefused.Entity} the ${pSpec.Entity} names is not in this persona's data.`, fCallback);
				}
				return fCallback();
			});
	};
	tmpBehaviors['Update-PreOperation'] = function (pRequest, pRequestState, fCallback)
	{
		let tmpSession = fCommon(this, pRequestState, fCallback);
		if (!tmpSession)
		{
			return;
		}
		if (!fRowAllowed(pRequestState.OriginalRecord, tmpSession))
		{
			return fDeny(this, pRequestState, 403, `DEMO write guard: that ${pSpec.Entity} is not this persona's to change.`, fCallback);
		}
		let tmpChange = pRequestState.RecordToModify || {};
		let tmpMoves = (Object.prototype.hasOwnProperty.call(tmpChange, pSpec.TenantColumn) && !sameValue(tmpChange[pSpec.TenantColumn], tmpSession.Tenant))
			|| (pSpec.Personal && Object.prototype.hasOwnProperty.call(tmpChange, pSpec.Personal.Column) && !sameValue(tmpChange[pSpec.Personal.Column], tmpSession.Owner));
		if (tmpMoves)
		{
			return fDeny(this, pRequestState, 403, `DEMO write guard: an update may not move the ${pSpec.Entity} to another tenant or owner.`, fCallback);
		}
		let tmpController = this;
		fOwned(pRequestState.OriginalRecord, tmpSession,
			(pOwned) =>
			{
				return pOwned ? fCallback() : fDeny(tmpController, pRequestState, 403, `DEMO write guard: that ${pSpec.Entity} is not this persona's to change.`, fCallback);
			});
	};
	let fExisting = function (pRequest, pRequestState, fCallback)
	{
		let tmpSession = fCommon(this, pRequestState, fCallback);
		if (!tmpSession)
		{
			return;
		}
		let tmpRow = pRequestState.OriginalRecord || pRequestState.Record;
		if (!fRowAllowed(tmpRow, tmpSession))
		{
			return fDeny(this, pRequestState, 403, `DEMO write guard: that ${pSpec.Entity} is not this persona's to change.`, fCallback);
		}
		let tmpController = this;
		fOwned(tmpRow, tmpSession,
			(pOwned) =>
			{
				return pOwned ? fCallback() : fDeny(tmpController, pRequestState, 403, `DEMO write guard: that ${pSpec.Entity} is not this persona's to change.`, fCallback);
			});
	};
	tmpBehaviors['Delete-PreOperation'] = fExisting;
	tmpBehaviors['Undelete-PreOperation'] = fExisting;
	return tmpBehaviors;
};

/**
 * Install the write guards on every entity of a booted domain (after boot: chain-wrapped through
 * harness.installBehavior, so a behavior already in a slot still runs first).
 *
 * @param {string} pDomain
 * @param {Record<string, any>} pHarness - a started test harness
 * @return {Array<string>} the entities guarded
 */
const installWriteGuards = (pDomain, pHarness) =>
{
	if (!pHarness || !pHarness.fable || (typeof(pHarness.installBehavior) !== 'function'))
	{
		throw new Error(`Faceting-Demo-Writes.installWriteGuards: ${pDomain} has no started harness.`);
	}
	if (pHarness.DemoWriteGuard && pHarness.DemoWriteGuard.Installed)
	{
		return pHarness.DemoWriteGuard.Entities.slice();
	}
	let tmpScope = (pHarness.facetingOptions && pHarness.facetingOptions.Scope) ? pHarness.facetingOptions.Scope : {};
	let tmpPolicy = tmpScope.Policy || null;
	let tmpGuardState = { Installed: true, Domain: pDomain, Entities: [], Refused: 0, LastRefused: null };
	let tmpEndpoints = pHarness.fable.MeadowEndpoints || {};
	let tmpTables = (pHarness.model && pHarness.model.Tables) ? pHarness.model.Tables : {};
	let tmpExclude = (tmpPolicy && Array.isArray(tmpPolicy.Exclude)) ? tmpPolicy.Exclude : [];
	let tmpPersonal = (tmpPolicy && tmpPolicy.PersonalScopes) ? tmpPolicy.PersonalScopes : {};
	Object.keys(tmpEndpoints).sort().forEach(
		(pEntity) =>
		{
			let tmpColumns = (tmpTables[pEntity] && Array.isArray(tmpTables[pEntity].Columns)) ? tmpTables[pEntity].Columns.map((pColumn) => { return pColumn.Column; }) : [];
			let tmpTenantColumn = (tmpPolicy && tmpPolicy.Column && (tmpExclude.indexOf(pEntity) < 0) && (tmpColumns.indexOf(tmpPolicy.Column) >= 0)) ? tmpPolicy.Column : null;
			let tmpOwner = tmpPersonal[pEntity];
			// The foreign keys of the entity by meadow's naming convention (ID<Table> of another table), except the
			// tenant and owner columns (the guard stamps and checks those itself).
			let tmpReferences = tmpColumns
				.filter((pColumn) => { return /^ID[A-Z]/.test(pColumn) && (pColumn !== `ID${pEntity}`) && (pColumn !== tmpTenantColumn) && (!tmpOwner || (pColumn !== tmpOwner.Column)) && Object.prototype.hasOwnProperty.call(tmpTables, pColumn.slice(2)); })
				.map(
					(pColumn) =>
					{
						let tmpTarget = pColumn.slice(2);
						let tmpTargetColumns = Array.isArray(tmpTables[tmpTarget].Columns) ? tmpTables[tmpTarget].Columns.map((pTargetColumn) => { return pTargetColumn.Column; }) : [];
						let tmpTargetTenant = (tmpPolicy && tmpPolicy.Column && (tmpExclude.indexOf(tmpTarget) < 0) && (tmpTargetColumns.indexOf(tmpPolicy.Column) >= 0)) ? tmpPolicy.Column : null;
						return { Column: pColumn, Entity: tmpTarget, TenantColumn: tmpTargetTenant };
					});
			let tmpSpec =
				{
					Entity: pEntity,
					TenantColumn: tmpTenantColumn,
					TenantSessionField: tmpPolicy ? tmpPolicy.SessionField : null,
					Personal: (tmpOwner && tmpOwner.Column && (tmpColumns.indexOf(tmpOwner.Column) >= 0)) ? { Column: tmpOwner.Column, SessionField: tmpOwner.SessionField } : null,
					References: tmpReferences,
					Ownership: Object.prototype.hasOwnProperty.call(OWNERSHIP_RULES, pEntity) ? OWNERSHIP_RULES[pEntity] : null
				};
			if (!tmpPolicy)
			{
				// No policy: nothing scopes a row to a persona, so nothing is writable.
				tmpSpec.TenantSessionField = '__none__';
			}
			let tmpBehaviors = guardBehaviors(tmpSpec, tmpGuardState, pHarness);
			GUARD_SLOTS.forEach((pSlot) => { pHarness.installBehavior(pEntity, pSlot, tmpBehaviors[pSlot]); });
			tmpGuardState.Entities.push(pEntity);
		});
	pHarness.DemoWriteGuard = tmpGuardState;
	return tmpGuardState.Entities.slice();
};

module.exports = (
	{
		MAX_WRITE_BODY_BYTES: MAX_WRITE_BODY_BYTES,
		ERROR_CODE: ERROR_CODE,
		PROJECT_STATUSES: PROJECT_STATUSES,
		LAB_FORM_STATUSES: LAB_FORM_STATUSES,
		GUARD_SLOTS: GUARD_SLOTS,
		OWNERSHIP_RULES: OWNERSHIP_RULES,
		WRITE_ROUTES: WRITE_ROUTES,
		matchWrite: matchWrite,
		pathID: pathID,
		checkBody: checkBody,
		isDateValue: isDateValue,
		installWriteGuards: installWriteGuards
	});
