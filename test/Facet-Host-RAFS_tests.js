/**
 * Host tests for retold-application-foundation-server (internal-contracts Part V, §80).
 *
 * Four layers:
 *   1. Module surface (always runs, no RAFS): the host constructs and fails closed until bound, the
 *      installers follow RAFS's step convention, the option precedence, the DeniedPrefixes mirror,
 *      the RAFS gate.
 *   2. RAFS pins (run when RAFS resolves, §80.1): the exact RAFS 1.0.5 behaviors Part V is built on —
 *      the boot order, the tenancy layer marker and outer group, the fence's operator allowlist, the
 *      entitlements route mapping, the tenant-0 default.  No server boots; RAFS's own exported
 *      functions run against fake endpoints and real FoxHound queries.
 *   3. The harness (§80.2 / §80.3): test/support/Facet-RAFS-Harness.js boots a REAL RAFS app in-process
 *      (LabTrack / ProjectTrack + the probe overlay, SQLite in memory) with both faceting installers in
 *      its own hookInstallers() / routeInstallers(); principals hold real sessions (Login: POST
 *      /1.0/Authenticate through Auth.Local + Entitlements + Membership; Header: the tenancy
 *      resolveSession RAFS's own tenancy tests use).  The smoke rows check the harness wiring and GET
 *      /1.0/Facet/Describe as a tenant user; the PostgreSQL row runs under the PG gate.
 *   4. End to end on the booted app (§80.4), as authenticated users in two tenants:
 *        - the motivating queries E1, E2 (ProjectTrack) and E3A, E3B (LabTrack) through /1.0/Facet/<E>/Query
 *          as every fixture principal with a real RetoldSessionID cookie: O1 (Live == the Reference, which
 *          reads through each entity's own route-bound list waterfall — RAFS's tenancy guards — as the same
 *          session; HTTP == in-process) and O2 for every bucket (the stock RAFS Count route where the list
 *          syntax carries the body, the Reference where scopes / joins / declared Wheres need it);
 *        - Records == the rows RAFS's own list returns (whole rows, same session); tenant isolation of
 *          facets, labels, Keys and Records (assertTenantIsolation), of SSE streams and of ETags;
 *        - R1–R10 (coverage, isolation on every Installed entity, tenant 0 / anonymous 401 before any
 *          SQL, the LabForm PersonalScopes owner scope and the TenantOnly relaxation, isFacetable over the
 *          probe overlay, the peeled RAFS fence and the IS swap, Repair refused at boot, M4 change capture
 *          through RAFS's CRUD routes, shutdown) and L1–L5 (tenant switch, entitlements 404 / 403 /
 *          unlabeled, a UserAction deny, RoleSetHash cache separation, the platform principal, IDUser
 *          enrichment);
 *        - V1–V8, the host-review regressions (internal-contracts §83): entitlement invalidation without
 *          facetable role tables, an authenticating app without tenancy, coverage that changes between the
 *          phases, in-process persona enrichment, open streams revalidated on a revocation, mismatched
 *          installer options, the shutdown hook from the hook phase;
 *        - PostgreSQL (the PG gate) and the ClickHouse store (the CH gate: ClickHouse == Live == Reference).
 *
 * RAFS is private: when it does not resolve (no monorepo checkout, RFS_TEST_RAFS_PATH unset or wrong)
 * layers 2–4 are one pending test whose title says why.  Registry ports 19138 (Header sessions)
 * and 19139 (Login sessions) (§80.5); every server binds 127.0.0.1:0.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libFoxHound = require('foxhound');

const libRetoldFacetingHostApplicationServer = require('../source/host/Retold-Faceting-Host-ApplicationServer.js');
const libRetoldFacetingHostDataService = require('../source/host/Retold-Faceting-Host-DataService.js');
const libRetoldFacetingInstallers = require('../source/Retold-Faceting-Installers.js');
const libFacetErrors = require('../source/contract/Facet-Contract-Errors.js');
const libRetoldFacetingUtil = require('../source/Retold-Faceting-Util.js');
const libRetoldFacetingScopeCapture = require('../source/security/Retold-Faceting-ScopeCapture.js');
const libRetoldFacetingScopeGuard = require('../source/security/Retold-Faceting-ScopeGuard.js');
const libRetoldFacetingChangeIntake = require('../source/change/Retold-Faceting-ChangeIntake.js');

const libFacetEnvelope = require('../source/contract/Facet-Contract-Envelope.js');

const libBuilders = require('./support/Facet-Test-Builders.js');
const libRAFSHarness = require('./support/Facet-RAFS-Harness.js');
const libHarnessProviders = require('./support/Facet-Harness-Providers.js');
const libClickHouseSupport = require('./support/Facet-ClickHouse-Support.js');

/**
 * The smallest object that passes the host's duck type (a RAFS whose boot reached a hook step).
 *
 * @param {Record<string, any>} [pOptions] - becomes pServer.options
 * @return {Record<string, any>}
 */
const fakeServer = (pOptions) =>
{
	return (
		{
			fable: libBuilders.newFable('RetoldFacetingRAFSFake'),
			options: pOptions || {},
			DAL: {},
			Endpoints: {},
			MeadowModel: { Tables: {} },
			tenancyConfig: () => { return null; }
		});
};

/**
 * A meadow-endpoints-shaped endpoint whose controller has the single-slot BehaviorInjection surface
 * Retold-Tenancy installs on (Retold-Tenancy.js:186-192), with a coded error handler.
 *
 * @return {{ Endpoint: Record<string, any>, Controller: Record<string, any>, Injection: Record<string, any> }}
 */
const fakeEndpoint = () =>
{
	let tmpInjection = (
		{
			_BehaviorFunctions: {},
			setBehavior: function (pHash, fBehavior)
			{
				this._BehaviorFunctions[pHash] = fBehavior;
			}
		});
	let tmpController = (
		{
			BehaviorInjection: tmpInjection,
			DAL: { defaultIdentifier: 'IDLabForm', defaultGUIdentifier: 'GUIDLabForm' },
			ErrorHandler:
			{
				getError: (pMessage, pStatusCode) =>
				{
					let tmpError = new Error(pMessage);
					tmpError.StatusCode = pStatusCode;
					return tmpError;
				}
			}
		});
	return { Endpoint: { _Controller: tmpController }, Controller: tmpController, Injection: tmpInjection };
};

/**
 * A FoxHound query shaped like a faceting pivot before the behaviors run: the client fence around
 * one client conjunct, then the explicit soft delete (internal-contracts §7.2).
 *
 * @param {Record<string, any>} pClientEntry - { Column, Value, Operator }
 * @return {any}
 */
const facetingQuery = (pClientEntry) =>
{
	let tmpQuery = libFoxHound.new(libBuilders.newFable('RetoldFacetingRAFSQuery')).setScope('LabForm');
	tmpQuery.addFilter('', '', '(', 'AND', 'FacetFenceOpen');
	tmpQuery.addFilter(pClientEntry.Column, pClientEntry.Value, pClientEntry.Operator, 'AND', 'c0');
	tmpQuery.addFilter('', '', ')', 'AND', 'FacetFenceClose');
	tmpQuery.addFilter('Deleted', 0, '=', 'AND', 'FacetSoftDelete');
	return tmpQuery;
};

/**
 * Run the tenancy guard RAFS installed on Reads-QueryConfiguration, the way ScopeCapture runs it.
 *
 * @param {Record<string, any>} pFake - fakeEndpoint()
 * @param {Record<string, any>} pUserSession
 * @param {any} pQuery
 * @param {(pError: any) => void} fCallback
 */
const runReadsGuard = (pFake, pUserSession, pQuery, fCallback) =>
{
	let fGuard = pFake.Injection._BehaviorFunctions['Reads-QueryConfiguration'];
	return fGuard.call(pFake.Controller, { UserSession: pUserSession }, { Query: pQuery }, fCallback);
};

const bareEntry = (pOperator) =>
{
	return { Column: '', Operator: pOperator, Value: '', Connector: 'AND', Parameter: '' };
};

// ---------------------------------------------------------------------------------- end-to-end support

const PG_GATE = libHarnessProviders.available('PostgreSQL');
const CH_GATE = libClickHouseSupport.available();

const LABTRACK_PRINCIPALS = Object.freeze([ 'Tech', 'Colleague', 'Newbie', 'OtherTech' ]);
const PROJECTTRACK_PRINCIPALS = Object.freeze([ 'Lead', 'Member', 'Outsider', 'OtherLead' ]);

// §75.2 on the LabTrack app (+ the Kit identity tables and the probe overlay, §80.3): what RAFS installed
// tenancy on (the controller marker), what it excluded, what has no route, what was mounted late.
const LABTRACK_COVERAGE = Object.freeze(
	{
		Customer: 'Installed', User: 'Installed', LabQueue: 'Installed', LabQueueMember: 'Installed', MaterialType: 'Installed',
		MaterialIntake: 'Installed', LabFormType: 'Excluded', MaterialIntakeRequirement: 'Installed', MaterialTypeFormRequirement: 'Installed',
		LabForm: 'Installed', RFSAccount: 'Controllerless', RFSMembership: 'Controllerless', Role: 'Installed', RoleAction: 'Installed',
		UserRole: 'Installed', UserAction: 'Controllerless', ProbeHidden: 'Controllerless', ProbeDenied: 'Installed', ProbeExcluded: 'Excluded',
		ProbeGlobal: 'Excluded', ProbeLate: 'Unguarded', ProbeLateGlobal: 'Unguarded', ProbeLink: 'Installed'
	});

// The motivating queries (design 08; the bodies of test/Facet-Motivating-Queries_tests.js).
const E1_ROLES = [ 'Owner', 'Lead' ];
const E1_STATUSES = [ 'Active', 'AtRisk' ];

const e1Body = (pTraps) =>
{
	return (
		{
			Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: E1_ROLES.slice() } }, { Scope: 'Project.HasMyOverdue' }, { Scope: 'Project.Unblocked' } ],
			Clauses:
				[
					{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: E1_STATUSES.slice(), FilterKey: 'Status', Hash: 'Status-DSVL-1' },
					{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', JoinExternalConnectionColumn: 'IDClient', Values: pTraps.E1ClientIDs.slice(), FilterKey: 'IDClient', Hash: 'IDClient-IJ-1' },
					{ Type: 'DateRange', FilterByColumn: 'StartDate', Values: { Start: '2026-01-01 00:00:00', End: '2027-01-01 00:00:00' }, EndExclusive: true, FilterKey: 'StartDate', Hash: 'StartDate-DR-1' }
				],
			Facets:
				[
					{ Key: 'Status', Facet: 'Project.Status' },
					{ Key: 'Client', Facet: 'Project.IDClient', Top: 20 },
					{ Key: 'Started', Facet: 'Project.StartDate', Interval: 'month' },
					{ Key: 'MyOverdue', Facet: 'Project.MyOverdueBand' },
					{ Key: 'StatusByClient', Facet: [ 'Project.Status', 'Project.IDClient' ], Fold: 'Pivot' }
				],
			Total: true,
			Records: { Begin: 0, Cap: 50, Sort: [ { Field: 'StartDate', Dir: 'DESC' } ] }
		});
};

const e2Body = (pTraps) =>
{
	return (
		{
			Clauses:
				[
					{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'FormType', JoinInternalConnectionColumn: 'IDFormType', JoinExternalConnectionColumn: 'IDFormType', Values: [ pTraps.E2FormTypeID ], FilterKey: 'IDFormType', Hash: 'IDFormType-IJ-1' },
					{ Type: 'DateRange', FilterByColumn: 'DocumentDate', Values: { Start: '2026-01-01 00:00:00', End: '2026-07-01 00:00:00' }, EndExclusive: true, FilterKey: 'DocumentDate', Hash: 'DocumentDate-DR-1' }
				],
			Facets:
				[
					{ Key: 'ByMonth', Facet: 'Document.DocumentDate', Interval: 'month', Chart: true },
					{ Key: 'ByForm', Facet: 'Document.IDFormType', Top: 20 },
					{ Key: 'Status', Facet: 'Document.Status', Exclude: 'None' }
				],
			Records: { Begin: 0, Cap: 100 }
		});
};

const e3aBody = () =>
{
	return (
		{
			Facets:
				[
					{ Key: 'ToDo', Facet: 'MaterialIntakeRequirement.MyFormsToDo' },
					{ Key: 'Queue', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue' },
					{ Key: 'Week', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByWeek' },
					{ Key: 'Discipline', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline' },
					{ Key: 'Started', Facet: 'MaterialIntakeRequirement.MyFormsToDo/Started' }
				]
		});
};

const e3bBody = () =>
{
	return (
		{
			Facets:
				[
					{ Key: 'ToDo', Facet: 'MaterialIntake.FormsToDo' },
					{ Key: 'Queue', Facet: 'MaterialIntake.FormsToDo/ByQueue' },
					{ Key: 'Week', Facet: 'MaterialIntake.FormsToDo/ByWeek' }
				]
		});
};

// Column-only bodies (the stock list syntax carries them: O2 through the RAFS Count route).
const LABFORM_COLUMN_BODY = () =>
{
	return (
		{
			Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Pending', 'Complete' ], FilterKey: 'Status', Hash: 'Status-DSVL-1' } ],
			Facets:
				[
					{ Key: 'Status', Facet: 'LabForm.Status' },
					{ Key: 'Type', Facet: 'LabForm.IDLabFormType', Top: 50 },
					{ Key: 'Done', Facet: 'LabForm.CompletedDate', Interval: 'month', Missing: true },
					{ Key: 'Owner', Facet: 'LabForm.OwnerIDUser' }
				],
			Total: true
		});
};

const MATERIALINTAKE_COLUMN_BODY = () =>
{
	return (
		{
			Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Received', 'InProgress' ], FilterKey: 'Status', Hash: 'Status-DSVL-1' } ],
			Facets:
				[
					{ Key: 'Status', Facet: 'MaterialIntake.Status' },
					{ Key: 'Priority', Facet: 'MaterialIntake.Priority' },
					{ Key: 'Queue', Facet: 'MaterialIntake.IDLabQueue', Top: 50 },
					{ Key: 'Received', Facet: 'MaterialIntake.ReceivedDate', Interval: 'month' }
				],
			Total: true
		});
};

// Change capture on RAFS: the cache (ETags are generation Versions) and fast SSE coalescing.
const CHANGE_FACETING = Object.freeze({ Cache: { Enabled: true }, SSE: { CoalesceMS: 15, IncludeSeq: true } });

// L2 / L3: a role with every read but MaterialIntake (LabFormType is in ExcludeEntities: no grant needed).
const ENTITLEMENT_ROLES = Object.freeze(
	[
		{ Key: 'owner', Name: 'Owner', Description: 'Every action.', Actions: [ '*' ] },
		{ Key: 'reader', Name: 'Reader', Description: 'Every read.', Actions: [ '*.read' ] },
		{ Key: 'limited', Name: 'Limited', Description: 'Every read but MaterialIntake.', Actions: [ 'Customer.read', 'User.read', 'LabQueue.read', 'LabQueueMember.read', 'MaterialType.read', 'MaterialIntakeRequirement.read', 'MaterialTypeFormRequirement.read', 'LabForm.read', 'ProbeLink.read' ] }
	]);

/**
 * Run fStep over every item in sequence.
 *
 * @param {Array<any>} pItems
 * @param {(pItem: any, fNext: (pError?: Error|null) => void) => void} fStep
 * @param {(pError?: Error|null) => void} fDone
 */
const eachSeries = (pItems, fStep, fDone) =>
{
	let fNext = (pIndex) =>
	{
		if (pIndex >= pItems.length)
		{
			return fDone(null);
		}
		try
		{
			fStep(pItems[pIndex], (pError) => { return pError ? fDone(pError) : fNext(pIndex + 1); });
		}
		catch (pAssertion)
		{
			return fDone(pAssertion);
		}
	};
	return fNext(0);
};

/**
 * Poll a condition until it holds or the time runs out.
 *
 * @param {() => boolean} fCondition
 * @param {number} pTimeoutMS
 * @param {(pError?: Error) => void} fCallback
 * @param {string} [pWhat]
 */
const waitFor = (fCondition, pTimeoutMS, fCallback, pWhat) =>
{
	let tmpStart = Date.now();
	let fCheck = () =>
	{
		if (fCondition())
		{
			return fCallback();
		}
		if ((Date.now() - tmpStart) > pTimeoutMS)
		{
			return fCallback(new Error(`timed out after ${pTimeoutMS} ms waiting for ${pWhat || 'a condition'}`));
		}
		setTimeout(fCheck, 5);
	};
	fCheck();
};

/**
 * The first differing facet of two normalized envelopes (a readable deep-equal message).
 *
 * @param {Record<string, any>} pA
 * @param {Record<string, any>} pB
 * @return {string}
 */
const firstDifference = (pA, pB) =>
{
	let tmpKeys = Object.keys(Object.assign({}, (pA && pA.Facets) || {}, (pB && pB.Facets) || {}));
	for (let i = 0; i < tmpKeys.length; i++)
	{
		let tmpLeft = JSON.stringify(((pA && pA.Facets) || {})[tmpKeys[i]]);
		let tmpRight = JSON.stringify(((pB && pB.Facets) || {})[tmpKeys[i]]);
		if (tmpLeft !== tmpRight)
		{
			return `facet ${tmpKeys[i]}\n  A: ${String(tmpLeft).slice(0, 800)}\n  B: ${String(tmpRight).slice(0, 800)}`;
		}
	}
	return `envelope fields differ\n  A: ${JSON.stringify(Object.assign({}, pA || {}, { Facets: null })).slice(0, 800)}\n  B: ${JSON.stringify(Object.assign({}, pB || {}, { Facets: null })).slice(0, 800)}`;
};

/**
 * One motivating query as one principal, end to end on the RAFS app:
 *   O1  in-process Live == the Reference (both as the principal's own session, the fixture's pinned Now),
 *       with no facet error, and the HTTP answer (POST <RoutePrefix>/<E>/Query with the session's
 *       cookie / headers) == the in-process Live on the real clock;
 *   O2  assertSelectionRoundTrip (CountVia 'Auto': the Reference for bodies the list syntax cannot carry).
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity
 * @param {Record<string, any>} pBody
 * @param {string} pName
 * @param {(pError?: Error|null, pResult?: { Live: Record<string, any>, Reference: Record<string, any>, Http: Record<string, any>, Report: Record<string, any> }) => void} fCallback
 */
const checkMotivating = (pHarness, pEntity, pBody, pName, fCallback) =>
{
	let tmpNow = pHarness.traps.TestNow;
	let tmpLabel = `${pEntity} as ${pName}`;
	pHarness.query(pEntity, pBody, { As: pName, Now: tmpNow },
		(pLiveError, pLive) =>
		{
			if (pLiveError)
			{
				return fCallback(pLiveError);
			}
			pHarness.reference(pEntity, pBody, { As: pName, Now: tmpNow },
				(pReferenceError, pReference) =>
				{
					if (pReferenceError)
					{
						return fCallback(pReferenceError);
					}
					try
					{
						Expect(pLive.Errors || {}, `${tmpLabel}: facet errors`).to.deep.equal({});
						Expect(Object.keys(pLive.Facets).sort(), tmpLabel).to.deep.equal(pBody.Facets.map((pSpec) => { return pSpec.Key; }).sort());
						let tmpLive = libFacetEnvelope.normalizeForComparison(pLive);
						let tmpReference = libFacetEnvelope.normalizeForComparison(pReference);
						if (JSON.stringify(tmpLive) !== JSON.stringify(tmpReference))
						{
							Expect(tmpLive, `${tmpLabel}: Live == Reference\n${firstDifference(tmpLive, tmpReference)}`).to.deep.equal(tmpReference);
						}
					}
					catch (pAssertion)
					{
						return fCallback(pAssertion);
					}
					pHarness.facet(pEntity, pBody, pName,
						(pHttpError, pHttp) =>
						{
							if (pHttpError)
							{
								return fCallback(pHttpError);
							}
							pHarness.query(pEntity, pBody, { As: pName },
								(pNowError, pNowLive) =>
								{
									try
									{
										Expect(pNowError, tmpLabel).to.equal(null);
										Expect(pHttp.Status, `${tmpLabel}: ${pHttp.Text}`).to.equal(200);
										Expect(libFacetEnvelope.normalizeForComparison(pHttp.JSON), `${tmpLabel}: HTTP == in-process`).to.deep.equal(libFacetEnvelope.normalizeForComparison(pNowLive));
									}
									catch (pAssertion)
									{
										return fCallback(pAssertion);
									}
									pHarness.assertSelectionRoundTrip(pEntity, pBody, pLive, { As: pName, Now: tmpNow },
										(pRoundTripError, pReport) =>
										{
											if (pRoundTripError)
											{
												return fCallback(pRoundTripError);
											}
											return fCallback(null, { Live: pLive, Reference: pReference, Http: pHttp.JSON, Report: pReport });
										});
								});
						});
				});
		});
};

/**
 * A Terms body over up to three columns of an entity (string columns and foreign keys), for the
 * isolation oracle.
 *
 * @param {Record<string, any>} pModel
 * @param {string} pEntity
 * @return {Record<string, any>}
 */
const isolationBody = (pModel, pEntity) =>
{
	let tmpColumns = pModel.Tables[pEntity].Columns.filter(
		(pColumn) =>
		{
			if (/^GUID/.test(pColumn.Column) || (pColumn.Column === 'Password'))
			{
				return false;
			}
			return (pColumn.DataType === 'String') || (((pColumn.DataType === 'Numeric') || (pColumn.DataType === 'ForeignKey')) && /^ID/.test(pColumn.Column) && (pColumn.Column !== 'IDCustomer'));
		}).slice(0, 3);
	return { Facets: tmpColumns.map((pColumn) => { return { Key: pColumn.Column, Facet: `${pEntity}.${pColumn.Column}`, Top: 50 }; }), Total: true };
};

/**
 * Capture one entity's scope in-process exactly as the engines do (ScopeCapture.capture on the route-bound
 * controller, ScopeGuard), as a principal's session: a fresh execution-DAL query with the client fence
 * around pEntries and the explicit soft delete.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pName
 * @param {string} pEntity
 * @param {Array<{ Column: string, Value: any, Operator: string }>} pEntries
 * @param {string} pScopeMode - 'Inherit' | 'TenantOnly'
 * @param {(pError?: Error|null, pCapture?: Record<string, any>, pQuery?: any) => void} fCallback
 */
const captureAs = (pHarness, pName, pEntity, pEntries, pScopeMode, fCallback) =>
{
	let tmpRequest = { params: { Entity: pEntity }, headers: {}, query: {}, body: {}, UserSession: pHarness.sessionFor(pName) };
	pHarness.host.resolvePrincipal(tmpRequest,
		(pError, pPrincipal) =>
		{
			if (pError)
			{
				return fCallback(pError);
			}
			let tmpContext = pHarness.service.newContext(pEntity, tmpRequest, {});
			tmpContext.Principal = pPrincipal;
			let tmpQuery = pHarness.host.getExecutionDAL(pEntity).query;
			tmpQuery.addFilter('', '', '(', 'AND', 'FacetFenceOpen');
			pEntries.forEach((pEntry, pIndex) => { tmpQuery.addFilter(pEntry.Column, pEntry.Value, pEntry.Operator, 'AND', `c${pIndex}`); });
			tmpQuery.addFilter('', '', ')', 'AND', 'FacetFenceClose');
			tmpQuery.addFilter('Deleted', 0, '=', 'AND', 'FacetSoftDelete');
			pHarness.fable.RetoldFacetingScopeCapture.capture(tmpContext, pEntity, tmpQuery, pScopeMode, { Fresh: true },
				(pCaptureError, pCapture) =>
				{
					setImmediate(() => { fCallback(pCaptureError || null, pCapture, tmpQuery); });
				});
		});
};

/**
 * Anonymous and the authenticated tenant-0 session: 401 FACET_UNAUTHENTICATED on Query and Describe.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity
 * @param {Record<string, any>} pBody
 * @param {(pError?: Error|null) => void} fCallback
 */
const assertUnauthenticated = (pHarness, pEntity, pBody, fCallback) =>
{
	eachSeries([ null, 'TenantZero' ],
		(pName, fNext) =>
		{
			pHarness.facet(pEntity, pBody, pName,
				(pError, pResponse) =>
				{
					Expect(pResponse.Status, `${pEntity} as ${pName}`).to.equal(401);
					Expect(pResponse.JSON.Error.Code).to.equal('FACET_UNAUTHENTICATED');
					pHarness.describe(null, pName,
						(pDescribeError, pDescribe) =>
						{
							Expect(pDescribe.Status, `Describe as ${pName}`).to.equal(401);
							return fNext();
						});
				});
		}, fCallback);
};

/**
 * O3 on the RAFS app: the body as a principal's session answered by ClickHouse (PreferEngine), Live and the
 * Reference — equal, and every facet answered by the store.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity
 * @param {Record<string, any>} pBody
 * @param {string} pName
 * @param {(pError?: Error|null, pResult?: Record<string, any>) => void} fCallback
 */
const assertStoreEqualsLive = (pHarness, pEntity, pBody, pName, fCallback) =>
{
	let tmpLabel = `${pEntity} as ${pName}`;
	pHarness.compareStore(pEntity, pBody, { As: pName },
		(pError, pResult) =>
		{
			if (pError)
			{
				return fCallback(pError);
			}
			try
			{
				if (JSON.stringify(pResult.StoreNormalized) !== JSON.stringify(pResult.LiveNormalized))
				{
					Expect(pResult.StoreNormalized, `${tmpLabel}: ClickHouse == Live\n${firstDifference(pResult.StoreNormalized, pResult.LiveNormalized)}`).to.deep.equal(pResult.LiveNormalized);
				}
				if (JSON.stringify(pResult.LiveNormalized) !== JSON.stringify(pResult.ReferenceNormalized))
				{
					Expect(pResult.LiveNormalized, `${tmpLabel}: Live == Reference\n${firstDifference(pResult.LiveNormalized, pResult.ReferenceNormalized)}`).to.deep.equal(pResult.ReferenceNormalized);
				}
				Expect(pResult.Store.Store.Available, tmpLabel).to.equal(true);
				Expect(Object.keys(pResult.Engines).length, tmpLabel).to.be.above(0);
				Object.keys(pResult.Engines).forEach(
					(pKey) =>
					{
						let tmpReason = (pResult.StoreMeta && pResult.StoreMeta.Refused) ? pResult.StoreMeta.Refused[pKey] : null;
						Expect(pResult.Engines[pKey], `${tmpLabel} / ${pKey}: ${tmpReason}`).to.equal('ClickHouse');
					});
			}
			catch (pAssertion)
			{
				return fCallback(pAssertion);
			}
			return fCallback(null, pResult);
		});
};

suite
(
	'Facet-Host-RAFS',
	() =>
	{
		suite
		(
			'module surface (no RAFS needed)',
			() =>
			{
				test('the host extends the DataService host, fails closed until bound, and binds a minimal RetoldApplicationServer (M1)',
					(fDone) =>
					{
						let tmpHost = new libRetoldFacetingHostApplicationServer(libBuilders.newFable('RetoldFacetingRAFSHost'));
						Expect(tmpHost).to.be.an.instanceof(libRetoldFacetingHostDataService);
						Expect(tmpHost.serviceType).to.equal('RetoldFacetingHostApplicationServer');
						Expect(tmpHost.getHostKind()).to.equal('ApplicationServer');
						// Unbound: every security-relevant answer fails closed.
						Expect(tmpHost.isBound()).to.equal(false);
						Expect(tmpHost.isFacetable('LabForm')).to.equal(false);
						Expect(tmpHost.getAuthorizer().canRead('LabForm', {})).to.equal(false);
						Expect(tmpHost.tenancyCoverage('LabForm')).to.equal(libRetoldFacetingHostApplicationServer.COVERAGE.None);
						Expect(tmpHost.captureLateMounts()).to.deep.equal([]);
						Expect(tmpHost.rawWriterEntities()).to.deep.equal([]);
						Expect(tmpHost.fenceProfile()).to.deep.equal({ Swap: { IS: '=' } });
						Expect(tmpHost.getScopePolicy().Kind).to.equal('None');
						Expect(() => { tmpHost.buildPrincipal({}, { UserSession: {} }); }).to.throw('not bound');
						tmpHost.resolvePrincipal({ UserSession: { UserRecord: { IDCustomer: 1 } } },
							(pUnboundError, pUnbound) =>
							{
								Expect(pUnboundError.Code).to.equal('FACET_INTERNAL');
								Expect(pUnbound).to.equal(undefined);
								tmpHost.bind({},
									(pNotAServer) =>
									{
										Expect(libFacetErrors.isFacetError(pNotAServer)).to.equal(true);
										Expect(pNotAServer.Code).to.equal('FACET_INTERNAL');
										Expect(tmpHost.isBound()).to.equal(false);
										tmpHost.bind(fakeServer(),
											(pBindError) =>
											{
												Expect(pBindError || null).to.equal(null);
												Expect(tmpHost.isBound()).to.equal(true);
												// No tenancyConfig(): no fence, no policy, no entitlements authorizer.
												Expect(tmpHost.fenceProfile()).to.equal(null);
												Expect(tmpHost.getScopePolicy().Kind).to.equal('None');
												Expect(tmpHost.getAuthorizer()).to.equal(null);
												let tmpSession = { UserSession: { UserRecord: { IDCustomer: 1, IDUser: 3 } } };
												tmpHost.resolvePrincipal(tmpSession,
													(pPrincipalError, pPrincipal) =>
													{
														Expect(pPrincipalError).to.equal(null);
														Expect(pPrincipal).to.include({ Kind: 'User', IDUser: 3, IDCustomer: 1, RoleSetHash: '', Platform: false });
														Expect(Object.isFrozen(pPrincipal)).to.equal(true);
														// The write principal (§76.4) has the same identity as the read one.
														Expect(libRetoldFacetingUtil.principalIdentityKey(tmpHost.buildPrincipal({}, tmpSession))).to.equal(libRetoldFacetingUtil.principalIdentityKey(pPrincipal));
														return fDone();
													});
											});
									});
							});
					});

				test('isApplicationServer duck-types a RetoldApplicationServer whose boot reached a hook step',
					() =>
					{
						Expect(libRetoldFacetingHostApplicationServer.isApplicationServer(fakeServer())).to.equal(true);
						Expect(libRetoldFacetingHostApplicationServer.isApplicationServer({})).to.equal(false);
						Expect(libRetoldFacetingHostApplicationServer.isApplicationServer(null)).to.equal(false);
						let tmpNoModel = fakeServer();
						tmpNoModel.MeadowModel = null;
						Expect(libRetoldFacetingHostApplicationServer.isApplicationServer(tmpNoModel)).to.equal(false);
						let tmpNoTenancyHook = fakeServer();
						delete tmpNoTenancyHook.tenancyConfig;
						Expect(libRetoldFacetingHostApplicationServer.isApplicationServer(tmpNoTenancyHook)).to.equal(false);
					});

				test('deniedByPrefixes mirrors the RAFS pre() handler on the singular and the plural route',
					() =>
					{
						let fDenied = libRetoldFacetingHostApplicationServer.deniedByPrefixes;
						Expect(fDenied('Customer', [ '/1.0/Customer' ])).to.equal(true);
						// indexOf === 0 semantics: a prefix also hides every entity whose name starts with it.
						Expect(fDenied('CustomerNote', [ '/1.0/Customer' ])).to.equal(true);
						Expect(fDenied('Item', [ '/1.0/Items' ])).to.equal(true);
						Expect(fDenied('Note', [ '/1.0/Customer' ])).to.equal(false);
						Expect(fDenied('Note', [])).to.equal(false);
						Expect(fDenied('Note', [ '', null, 7 ])).to.equal(false);
						Expect(fDenied('Note', [ '/2.0/Note' ], '2.0')).to.equal(true);
						Expect(fDenied('Note', [ '/2.0/Note' ])).to.equal(false);
					});

				test('the installers follow the RAFS step convention: (pServer, pOptions) builds a step, (…, fStep) runs and calls back once, never synchronously (M4)',
					(fDone) =>
					{
						let tmpServer = fakeServer();
						let fStep = libRetoldFacetingInstallers.foundationRouteInstaller(tmpServer, {});
						Expect(fStep).to.be.a('function');
						Expect(libRetoldFacetingInstallers.foundationHookInstaller(tmpServer, {})).to.be.a('function');

						let tmpCalls = [];
						let fRecord = (pLabel) => { return (pError) => { tmpCalls.push({ Label: pLabel, Error: pError || null }); }; };
						// The fake server has no Orator service server: the route phase refuses (after a hook phase).
						Expect(libRetoldFacetingInstallers.foundationRouteInstaller(fakeServer(), {}, fRecord('Routes'))).to.equal(undefined);
						// Put in the array unbound, the installer receives RAFS's step callback: a usage error, not a hang.
						Expect(libRetoldFacetingInstallers.foundationHookInstaller(fRecord('RawStep'))).to.equal(undefined);
						libRetoldFacetingInstallers.foundationRouteInstaller({}, {}, fRecord('NotAServer'));
						libRetoldFacetingInstallers.foundationHookInstaller(fakeServer(), { Role: 'Agent' }, fRecord('Agent'));
						libRetoldFacetingInstallers.foundationHookInstaller(fakeServer(), {}, fRecord('Hook'));
						Expect(tmpCalls).to.deep.equal([]);

						setImmediate(
							() =>
							{
								Expect(tmpCalls.map((pCall) => { return pCall.Label; })).to.have.members([ 'Routes', 'RawStep', 'NotAServer', 'Agent', 'Hook' ]);
								let fCall = (pLabel) => { return tmpCalls.find((pCall) => { return pCall.Label === pLabel; }); };
								[ 'Routes', 'RawStep', 'NotAServer', 'Agent' ].forEach((pLabel) => { Expect(fCall(pLabel).Error.Code, pLabel).to.equal('FACET_INTERNAL'); });
								Expect(fCall('Routes').Error.message).to.contain('no Orator service server');
								Expect(fCall('RawStep').Error.message).to.contain('foundationHookInstaller(this, options)');
								Expect(fCall('NotAServer').Error.message).to.contain('foundationRouteInstaller needs the RetoldApplicationServer');
								Expect(fCall('Agent').Error.message).to.contain(`Role 'Embedded'`);
								// The hook phase on a minimal RAFS attaches (nothing is served yet).
								Expect(fCall('Hook').Error).to.equal(null);

								// Exactly as RAFS runs it: fable Anticipate (which throws on a second callback); the boot
								// fails with our error and no later step runs.
								let tmpLaterRan = false;
								let tmpAnticipate = tmpServer.fable.newAnticipate();
								tmpAnticipate.anticipate(fStep);
								tmpAnticipate.anticipate((fNext) => { tmpLaterRan = true; return fNext(); });
								tmpAnticipate.wait(
									(pError) =>
									{
										Expect(pError.Code).to.equal('FACET_INTERNAL');
										Expect(pError.message).to.contain('no Orator service server');
										Expect(tmpLaterRan).to.equal(false);
										return fDone();
									});
							});
					});

				test('options sourcing: explicit > pServer.options.Faceting > the manifest Faceting block > defaults, never merged',
					() =>
					{
						let fResolve = libRetoldFacetingInstallers.resolveFoundationOptions;
						class ManifestServer
						{
							constructor(pOptions)
							{
								this.options = pOptions || {};
							}
						}
						ManifestServer.manifest = { Options: { Faceting: { InstanceID: 'from_manifest', Limits: { MaxFacets: 3 } } } };

						let tmpExplicit = fResolve(new ManifestServer({ Faceting: { InstanceID: 'from_options' } }), { InstanceID: 'explicit' });
						Expect(tmpExplicit.Source).to.equal('Explicit');
						Expect(tmpExplicit.Options.InstanceID).to.equal('explicit');
						// The winning source is used whole: the manifest's Limits do not leak into it.
						Expect(tmpExplicit.Options.Limits.MaxFacets).to.equal(20);

						let tmpServerOptions = fResolve(new ManifestServer({ Faceting: { InstanceID: 'from_options' } }));
						Expect(tmpServerOptions.Source).to.equal('ServerOptions');
						Expect(tmpServerOptions.Options.InstanceID).to.equal('from_options');

						let tmpManifest = fResolve(new ManifestServer({}), null);
						Expect(tmpManifest.Source).to.equal('Manifest');
						Expect(tmpManifest.Options.InstanceID).to.equal('from_manifest');
						Expect(tmpManifest.Options.Limits.MaxFacets).to.equal(3);

						class TopLevelManifestServer extends ManifestServer
						{
						}
						TopLevelManifestServer.manifest = { Faceting: { InstanceID: 'top_level' } };
						Expect(fResolve(new TopLevelManifestServer({})).Options.InstanceID).to.equal('top_level');

						let tmpDefaults = fResolve(fakeServer());
						Expect(tmpDefaults.Source).to.equal('Defaults');
						Expect(tmpDefaults.Options.InstanceID).to.equal('main');
						Expect(libRetoldFacetingInstallers.FOUNDATION_OPTION_SOURCES).to.deep.equal([ 'Explicit', 'ServerOptions', 'Manifest', 'Defaults' ]);
						Expect(libRetoldFacetingInstallers.FOUNDATION_PHASES).to.deep.equal([ 'Hook', 'Routes' ]);
					});

				test('§75.4 without RAFS: a host wrap layer is peeled (aligned inside only), the fence swap brackets a behavior run and detects a rewrite, the guard checks the client fence at the wrap depth',
					() =>
					{
						let tmpFable = libBuilders.newFable('RetoldFacetingRAFSCapture');
						let tmpCapture = new libRetoldFacetingScopeCapture(tmpFable);
						let tmpQuery = facetingQuery({ Column: 'Status', Value: 'Complete', Operator: '=' });
						tmpQuery.query.schema = [ { Column: 'IDLabForm' }, { Column: 'Status' }, { Column: 'Deleted' }, { Column: 'IDCustomer' }, { Column: 'OwnerIDUser' } ];
						let tmpBefore = tmpCapture.snapshot(tmpQuery);
						let fTenant = (pColumn, pValue) => { return { Column: pColumn, Operator: '=', Value: pValue, Connector: 'AND', Parameter: `Tenant${pColumn}` }; };
						// RAFS's fence: the whole prior filter in a bare group, then the scope (one layer).
						tmpQuery.parameters.filter = [ bareEntry('(') ].concat(JSON.parse(JSON.stringify(tmpBefore.Filter)), [ bareEntry(')'), fTenant('IDCustomer', 7), fTenant('OwnerIDUser', 3) ]);
						let tmpOne = tmpCapture.analyze(tmpBefore, tmpQuery);
						Expect(tmpOne).to.include({ Opaque: false, Portable: true, HostWraps: 1 });
						Expect(tmpOne.Transformed).to.deep.equal([]);
						Expect(tmpOne.Appended.map((pEntry) => { return [ pEntry.Column, pEntry.Depth ]; })).to.deep.equal([ [ 'IDCustomer', 0 ], [ 'OwnerIDUser', 0 ] ]);
						let tmpDepths = libRetoldFacetingScopeGuard.filterDepths(tmpQuery.parameters.filter).Depths;
						Expect(libRetoldFacetingScopeGuard.fenceIntact(tmpQuery.parameters.filter, tmpDepths, 1)).to.equal(true);
						Expect(libRetoldFacetingScopeGuard.fenceIntact(tmpQuery.parameters.filter, tmpDepths, 0)).to.equal(false);

						// Two layers, an app behavior inside the inner one, an operator it rewrote (Transformed, by
						// pre-behavior index): Appended innermost first.
						let tmpInner = JSON.parse(JSON.stringify(tmpBefore.Filter));
						tmpInner[1].Operator = 'LIKE';
						tmpQuery.parameters.filter = [ bareEntry('('), bareEntry('(') ].concat(tmpInner, [ { Column: 'Status', Operator: '!=', Value: 'X', Connector: 'AND', Parameter: 'App' }, bareEntry(')'), fTenant('IDCustomer', 7), bareEntry(')'), fTenant('OwnerIDUser', 3) ]);
						let tmpTwo = tmpCapture.analyze(tmpBefore, tmpQuery);
						Expect(tmpTwo).to.include({ Opaque: false, HostWraps: 2 });
						Expect(tmpTwo.Transformed).to.deep.equal([ { Index: 1, Before: { Operator: '=' }, After: { Operator: 'LIKE' } } ]);
						Expect(tmpTwo.Appended.map((pEntry) => { return [ pEntry.Column, pEntry.Depth ]; })).to.deep.equal([ [ 'Status', 2 ], [ 'IDCustomer', 1 ], [ 'OwnerIDUser', 0 ] ]);
						Expect(tmpCapture.fingerprint(Object.assign({ Entity: 'LabForm', Behavior: 'Reads-QueryConfiguration' }, tmpOne), 'Inherit'))
							.to.not.equal(tmpCapture.fingerprint(Object.assign({ Entity: 'LabForm', Behavior: 'Reads-QueryConfiguration' }, tmpOne, { HostWraps: 0 }), 'Inherit'));

						// A wrap whose inside no longer aligns (a client entry's value changed) is never peeled: Opaque.
						let tmpRewritten = JSON.parse(JSON.stringify(tmpBefore.Filter));
						tmpRewritten[1].Value = 'Pending';
						tmpQuery.parameters.filter = [ bareEntry('(') ].concat(tmpRewritten, [ bareEntry(')'), fTenant('IDCustomer', 7) ]);
						Expect(libRetoldFacetingScopeCapture.peelHostWraps(tmpBefore.Filter, tmpQuery.parameters.filter)).to.equal(null);
						Expect(tmpCapture.analyze(tmpBefore, tmpQuery).OpaqueReasons).to.include('FilterRewritten');
						// Faceting's own parens are never a host wrap (their Parameter is Facet*).
						Expect(libRetoldFacetingScopeCapture.peelHostWraps([], tmpBefore.Filter)).to.equal(null);

						// The fence swap: only faceting's IS + null entries, restored in place; a rewrite is detected.
						let tmpHost = { fenceProfile: () => { return { Swap: { IS: '=' } }; } };
						let tmpNull = facetingQuery({ Column: 'CompletedDate', Value: null, Operator: 'IS' });
						let tmpSwap = libRetoldFacetingScopeCapture.applyFenceSwap(tmpHost, tmpNull);
						Expect(tmpNull.parameters.filter[1]).to.include({ Operator: '=', Value: null, Parameter: `c0${libRetoldFacetingScopeCapture.SWAP_MARKER}` });
						Expect(tmpNull.parameters.filter[3].Operator).to.equal('=');
						Expect(libRetoldFacetingScopeCapture.restoreFenceSwap(tmpSwap, tmpNull)).to.equal(true);
						Expect(tmpNull.parameters.filter[1]).to.include({ Operator: 'IS', Value: null, Parameter: 'c0' });
						Expect(libRetoldFacetingScopeCapture.applyFenceSwap({ fenceProfile: () => { return null; } }, tmpNull)).to.equal(null);
						Expect(libRetoldFacetingScopeCapture.applyFenceSwap({}, tmpNull)).to.equal(null);
						let tmpTampered = libRetoldFacetingScopeCapture.applyFenceSwap(tmpHost, tmpNull);
						tmpNull.parameters.filter[1].Operator = '!=';
						Expect(libRetoldFacetingScopeCapture.restoreFenceSwap(tmpTampered, tmpNull)).to.equal(false);
						Expect(tmpNull.parameters.filter[1]).to.include({ Operator: 'IS', Parameter: 'c0' });
					});

				test('§71.2 / §79.2 without RAFS: Util.principalIdentityKey ignores the role set; ChangeIntake.covers is false for Host.rawWriterEntities() unless NotifyManaged names the entity',
					() =>
					{
						let tmpPrincipal = { Kind: 'User', IDUser: 3, IDCustomer: 7, ScopeValues: { IDCustomer: 7 }, RoleSetHash: '' };
						let tmpWithRoles = Object.assign({}, tmpPrincipal, { RoleSetHash: 'r:0123456789ab' });
						Expect(libRetoldFacetingUtil.principalIdentityKey(tmpWithRoles)).to.equal(libRetoldFacetingUtil.principalIdentityKey(tmpPrincipal));
						Expect(libRetoldFacetingUtil.principalIdentityKey(tmpPrincipal)).to.equal(libRetoldFacetingUtil.principalKey(tmpPrincipal));
						Expect(libRetoldFacetingUtil.principalKey(tmpWithRoles)).to.not.equal(libRetoldFacetingUtil.principalKey(tmpPrincipal));
						Expect(libRetoldFacetingUtil.principalIdentityKey(Object.assign({}, tmpPrincipal, { IDCustomer: 8, ScopeValues: { IDCustomer: 8 } }))).to.not.equal(libRetoldFacetingUtil.principalIdentityKey(tmpPrincipal));
						Expect(libRetoldFacetingUtil.principalIdentityKey(null)).to.equal(null);

						let tmpFable = libBuilders.newFable('RetoldFacetingRAFSIntake');
						let tmpIntake = new libRetoldFacetingChangeIntake(tmpFable, {});
						tmpFable.RetoldFacetingService = { Host: { rawWriterEntities: () => { return [ 'Role', 'RFSAccount' ]; } } };
						// Source 'None' (notify-only): covered, except the host's DAL-direct writers.
						Expect(tmpIntake.covers('Note')).to.equal(true);
						Expect(tmpIntake.covers('Role')).to.equal(false);
						Expect(tmpIntake.uncovered([ 'Note', 'Role', 'RFSAccount' ])).to.deep.equal([ 'Role', 'RFSAccount' ]);
						let tmpManaged = new libRetoldFacetingChangeIntake(tmpFable, { ChangeCapture: { NotifyManaged: [ 'Role' ] } });
						Expect(tmpManaged.covers('Role')).to.equal(true);
						Expect(tmpManaged.covers('RFSAccount')).to.equal(false);
						// A throwing host fails closed (uncovered); a host without the method changes nothing.
						tmpFable.RetoldFacetingService = { Host: { rawWriterEntities: () => { throw new Error('boom'); } } };
						Expect(tmpIntake.covers('Note')).to.equal(false);
						tmpFable.RetoldFacetingService = { Host: {} };
						Expect(tmpIntake.covers('Role')).to.equal(true);
					});

				test('the RAFS gate names the checkout it looked for and how to point it elsewhere',
					() =>
					{
						let tmpSaved = process.env[libRAFSHarness.ENV_RAFS_PATH];
						try
						{
							process.env[libRAFSHarness.ENV_RAFS_PATH] = '/nonexistent/rfs-test-rafs-checkout';
							let tmpMissing = libRAFSHarness.resolveRAFS();
							Expect(tmpMissing.Available).to.equal(false);
							Expect(tmpMissing.Source).to.equal(libRAFSHarness.ENV_RAFS_PATH);
							Expect(tmpMissing.Reason).to.contain('/nonexistent/rfs-test-rafs-checkout');
							Expect(tmpMissing.Reason).to.contain(libRAFSHarness.ENV_RAFS_PATH);

							delete process.env[libRAFSHarness.ENV_RAFS_PATH];
							let tmpDefault = libRAFSHarness.resolveRAFS();
							Expect(tmpDefault.Source).to.equal('Monorepo');
							Expect(tmpDefault.Path).to.equal(libRAFSHarness.MONOREPO_RAFS_PATH);
						}
						finally
						{
							if (typeof(tmpSaved) === 'string')
							{
								process.env[libRAFSHarness.ENV_RAFS_PATH] = tmpSaved;
							}
							else
							{
								delete process.env[libRAFSHarness.ENV_RAFS_PATH];
							}
						}
						Expect(libRAFSHarness.PORTS).to.deep.equal({ Header: 19138, Login: 19139 });
					});
			}
		);

		let tmpRAFS = libRAFSHarness.resolveRAFS();
		if (!tmpRAFS.Available)
		{
			suite
			(
				'against retold-application-foundation-server',
				() =>
				{
					// Pending, with the reason in the title (internal-contracts §80.1).
					test(`skipped: ${tmpRAFS.Reason}`);
				}
			);
			return;
		}

		suite
		(
			`RAFS ${tmpRAFS.Version} pins (the behaviors Part V is built on; no server boots)`,
			() =>
			{
				let libRAFS = null;

				suiteSetup(
					() =>
					{
						libRAFS = libRAFSHarness.load(tmpRAFS);
					});

				test('the duck-typed surface: hook methods, statics, and the boot order the installers rely on (§72.2)',
					() =>
					{
						[ 'start', 'startupSteps', 'hookInstallers', 'routeInstallers', 'tenancyConfig', 'entitlementsConfig', 'membershipConfig', 'authConfig' ].forEach(
							(pMethod) =>
							{
								Expect(libRAFS.prototype[pMethod], pMethod).to.be.a('function');
							});
						Expect(libRAFS.Tenancy.installTenancy).to.be.a('function');
						Expect(libRAFS.Tenancy.installTenancyBehaviors).to.be.a('function');
						[ 'can', 'resolveActions', 'resolveIDUser', 'requiredActionFor', 'buildCatalog' ].forEach(
							(pFunction) =>
							{
								Expect(libRAFS.Entitlements[pFunction], pFunction).to.be.a('function');
							});
						// Statics inherit, so a subclass reaches the Entitlements module through its constructor (§77.1).
						class PinServer extends libRAFS
						{
							hookInstallers()
							{
								return [ function RFSHookMarker(fStep) { return fStep(); } ];
							}

							routeInstallers()
							{
								return [ function RFSRouteMarker(fStep) { return fStep(); } ];
							}
						}
						Expect(PinServer.Entitlements).to.equal(libRAFS.Entitlements);

						let tmpServer = new PinServer({ MeadowModel: { Tables: {} } });
						Expect(tmpServer.DAL).to.deep.equal({});
						Expect(tmpServer.Endpoints).to.deep.equal({});
						Expect(tmpServer.NoAutoCRUDTables).to.deep.equal({});
						let tmpNames = tmpServer.startupSteps().map((pStep) => { return pStep.name.replace(/^bound /, ''); });
						let fAt = (pName) =>
						{
							let tmpIndex = tmpNames.indexOf(pName);
							Expect(tmpIndex, pName).to.be.at.least(0);
							return tmpIndex;
						};
						Expect(fAt('_loadMeadowEndpoints')).to.be.below(fAt('_mountAuthentication'));
						Expect(fAt('_mountAuthentication')).to.be.below(fAt('_mountTenancy'));
						Expect(fAt('_mountTenancy')).to.be.below(fAt('_mountEntitlements'));
						Expect(fAt('_mountEntitlements')).to.be.below(fAt('_mountMembership'));
						Expect(fAt('_mountMembership')).to.be.below(fAt('RFSHookMarker'));
						Expect(fAt('RFSHookMarker')).to.be.below(fAt('RFSRouteMarker'));
						Expect(fAt('RFSRouteMarker')).to.be.below(fAt('_mountStaticAssets'));
						Expect(fAt('_mountStaticAssets')).to.be.below(fAt('_startOrator'));
					});

				test('tenancy marks the BehaviorInjection and wraps the whole prior filter in a bare outer group before appending the scope (§75.1, §75.4)',
					(fDone) =>
					{
						let tmpFake = fakeEndpoint();
						Expect(libRAFS.Tenancy.installTenancyBehaviors(tmpFake.Endpoint, [ { Column: 'IDCustomer', getValue: (pSession) => { return pSession.UserRecord.IDCustomer; } } ])).to.equal(true);
						Expect(tmpFake.Injection[libRetoldFacetingHostApplicationServer.TENANCY_LAYERS_MARKER]).to.be.an('array').with.lengthOf(1);

						let tmpQuery = facetingQuery({ Column: 'Status', Value: 'Complete', Operator: '=' });
						let tmpBefore = JSON.parse(JSON.stringify(tmpQuery.parameters.filter));
						runReadsGuard(tmpFake, { UserRecord: { IDCustomer: 7 } }, tmpQuery,
							(pError) =>
							{
								Expect(pError).to.equal(false);
								let tmpAfter = tmpQuery.parameters.filter;
								let tmpN = tmpBefore.length;
								Expect(tmpAfter.length).to.equal(tmpN + 3);
								// The outer group is unshifted: every pre-behavior entry moves one index right.
								Expect(tmpAfter[0]).to.deep.equal(bareEntry('('));
								Expect(tmpAfter.slice(1, tmpN + 1)).to.deep.equal(tmpBefore);
								Expect(tmpAfter[tmpN + 1]).to.deep.equal(bareEntry(')'));
								Expect(tmpAfter[tmpN + 2]).to.deep.equal({ Column: 'IDCustomer', Operator: '=', Value: 7, Connector: 'AND', Parameter: 'TenantIDCustomer' });

								// A later single-slot setBehavior lands INSIDE the guard (the scope is still appended).
								tmpFake.Injection.setBehavior('Reads-QueryConfiguration', function (pRequest, pRequestState, fCallback) { return fCallback(); });
								let tmpClobbered = facetingQuery({ Column: 'Status', Value: 'Complete', Operator: '=' });
								runReadsGuard(tmpFake, { UserRecord: { IDCustomer: 7 } }, tmpClobbered,
									(pClobberError) =>
									{
										Expect(pClobberError).to.equal(false);
										Expect(tmpClobbered.parameters.filter[tmpClobbered.parameters.filter.length - 1].Column).to.equal('IDCustomer');
										return fDone();
									});
							});
					});

				test(`the fence refuses faceting's SQLite NULL form (Operator 'IS') with a 400 and admits '=' + null (§75.4 swap)`,
					(fDone) =>
					{
						let tmpFake = fakeEndpoint();
						libRAFS.Tenancy.installTenancyBehaviors(tmpFake.Endpoint, [ { Column: 'IDCustomer', getValue: (pSession) => { return pSession.UserRecord.IDCustomer; } } ]);
						let tmpIsQuery = facetingQuery({ Column: 'Status', Value: null, Operator: 'IS' });
						let tmpIsBefore = JSON.parse(JSON.stringify(tmpIsQuery.parameters.filter));
						runReadsGuard(tmpFake, { UserRecord: { IDCustomer: 7 } }, tmpIsQuery,
							(pError) =>
							{
								Expect(pError).to.be.an('error');
								Expect(pError.StatusCode).to.equal(400);
								Expect(tmpIsQuery.parameters.filter).to.deep.equal(tmpIsBefore);
								let tmpSwapQuery = facetingQuery({ Column: 'Status', Value: null, Operator: '=' });
								runReadsGuard(tmpFake, { UserRecord: { IDCustomer: 7 } }, tmpSwapQuery,
									(pSwapError) =>
									{
										Expect(pSwapError).to.equal(false);
										Expect(tmpSwapQuery.parameters.filter[tmpSwapQuery.parameters.filter.length - 1].Value).to.equal(7);
										return fDone();
									});
							});
					});

				test('the entitlements gate never maps the facet routes, and maps a RoutePrefix that collides with an entity (§77.5)',
					() =>
					{
						let tmpServer = { Endpoints: { Item: {}, Note: {} } };
						let tmpConfig = { APIPrefix: '/1.0/', ExcludeEntities: [ 'Note' ] };
						let fAction = (pMethod, pPath) => { return libRAFS.Entitlements.requiredActionFor(tmpServer, tmpConfig, pMethod, pPath); };
						Expect(fAction('POST', '/1.0/Facet/Item/Query')).to.equal(null);
						Expect(fAction('GET', '/1.0/Facet/Changes')).to.equal(null);
						Expect(fAction('GET', '/1.0/Items')).to.equal('Item.read');
						Expect(fAction('GET', '/1.0/Notes')).to.equal(null);
						// A RoutePrefix of '/1.0/Item' would turn every facet POST into Item.create.
						Expect(fAction('POST', '/1.0/Item/Query')).to.equal('Item.create');
						Expect(libRAFS.Entitlements.can(new Set([ 'Item.read' ]), 'Item.read')).to.equal(true);
						Expect(libRAFS.Entitlements.can(new Set([ 'Item.read' ]), 'Note.read')).to.equal(false);
						Expect(libRAFS.Entitlements.can(null, 'Item.read')).to.equal(false);
					});

				test('installTenancy: an anonymous request gets UserSession {}, a membership-less session scopes to tenant 0 (§75.5)',
					(fDone) =>
					{
						let tmpFake = fakeEndpoint();
						let tmpPreHandlers = [];
						let tmpServer = (
							{
								ApplicationName: 'rfs-pin',
								fable: { Orator: { serviceServer: { pre: (fHandler) => { tmpPreHandlers.push(fHandler); } } }, log: { info: () => {} } },
								Endpoints: { LabForm: tmpFake.Endpoint, LabFormType: fakeEndpoint().Endpoint }
							});
						libRAFS.Tenancy.installTenancy(tmpServer,
							{
								Column: 'IDCustomer',
								Exclude: [ 'LabFormType' ],
								PersonalScopes: { LabForm: { Column: 'OwnerIDUser', SessionField: 'IDUser' } },
								resolveSession: (pRequest, fCallback) => { return fCallback(null, null); }
							},
							() =>
							{
								Expect(tmpPreHandlers).to.have.lengthOf(1);
								Expect(tmpFake.Injection[libRetoldFacetingHostApplicationServer.TENANCY_LAYERS_MARKER]).to.be.an('array').with.lengthOf(1);
								Expect(tmpServer.Endpoints.LabFormType._Controller.BehaviorInjection[libRetoldFacetingHostApplicationServer.TENANCY_LAYERS_MARKER]).to.equal(undefined);
								let tmpRequest = { url: '/1.0/Facet/LabForm/Query', headers: {} };
								tmpPreHandlers[0](tmpRequest, { send: () => {} },
									() =>
									{
										Expect(tmpRequest.UserSession).to.deep.equal({});
										let tmpQuery = facetingQuery({ Column: 'Status', Value: 'Complete', Operator: '=' });
										runReadsGuard(tmpFake, { UserRecord: { IDAccount: 4 } }, tmpQuery,
											(pError) =>
											{
												Expect(pError).to.equal(false);
												let tmpFilter = tmpQuery.parameters.filter;
												Expect(tmpFilter.slice(-2)).to.deep.equal(
													[
														{ Column: 'IDCustomer', Operator: '=', Value: 0, Connector: 'AND', Parameter: 'TenantIDCustomer' },
														{ Column: 'OwnerIDUser', Operator: '=', Value: 0, Connector: 'AND', Parameter: 'TenantOwnerIDUser' }
													]);
												runReadsGuard(tmpFake, {}, facetingQuery({ Column: 'Status', Value: 'Complete', Operator: '=' }),
													(pAnonymousError) =>
													{
														Expect(pAnonymousError.StatusCode).to.equal(401);
														return fDone();
													});
											});
									});
							});
					});
			}
		);

		// ---- The harness (internal-contracts §80.2 / §80.3): a real RAFS app booted in-process with the
		// faceting installers in its own hook arrays, real sessions, and the probe overlay. ----

		suite
		(
			`RAFS ${tmpRAFS.Version} harness: Login sessions + Entitlements + Membership (LabTrack + overlay, SQLite in memory; port 19139)`,
			() =>
			{
				let _Harness = null;

				suiteSetup(
					function (fDone)
					{
						this.timeout(60000);
						_Harness = libRAFSHarness.start({ Port: libRAFSHarness.PORTS.Login, Fixture: 'LabTrack', Session: 'Login' }, (pError) => { return fDone(pError); });
					});

				suiteTeardown(
					(fDone) =>
					{
						return _Harness ? _Harness.stop(fDone) : fDone();
					});

				test('boots the app with both installers from its own hook arrays on 127.0.0.1, and every principal holds a real orator-authentication session',
					() =>
					{
						Expect(_Harness.baseURL).to.match(/^http:\/\/127\.0\.0\.1:\d+$/);
						Expect(_Harness.port).to.not.equal(libRAFSHarness.PORTS.Login);
						Expect(_Harness.rafs.Version).to.equal(tmpRAFS.Version);
						Expect(_Harness.service).to.be.an('object');
						Expect(_Harness.host).to.be.an.instanceof(libRetoldFacetingHostApplicationServer);
						Expect(_Harness.host.getHostKind()).to.equal('ApplicationServer');
						Expect(_Harness.fable.OratorAuthentication).to.be.an('object');
						Expect(Object.keys(_Harness.principals)).to.include.members([ 'Tech', 'Colleague', 'Newbie', 'OtherTech', 'Root', 'Traveler', 'TenantZero' ]);
						Expect(_Harness.as('Tech')).to.deep.equal({ Tenant: 1, User: 1 });
						Expect(_Harness.as('OtherTech').Tenant).to.equal(2);
						Expect(_Harness.as('TenantZero')).to.deep.equal({ Tenant: 0, User: 0 });
						Object.keys(_Harness.principals).forEach(
							(pName) =>
							{
								Expect(_Harness.principals[pName].Cookie, pName).to.match(/^RetoldSessionID=/);
								Expect(_Harness.principals[pName], pName).to.not.have.property('Password');
							});
						// The in-process session is the stored one: tenant from the membership, persona from the
						// entitlements enrichment, the platform marker on the account.
						let tmpTech = _Harness.sessionFor('Tech').UserRecord;
						Expect(tmpTech.IDCustomer).to.equal(1);
						Expect(tmpTech.IDUser).to.equal(1);
						Expect(tmpTech).to.not.have.property('Password');
						Expect(_Harness.sessionFor('Root').UserRecord.SystemRole).to.equal('root');
						Expect(_Harness.sessionFor('TenantZero').UserRecord.IDCustomer).to.equal(0);
						Expect(_Harness.sessionFor(null)).to.deep.equal({});
					});

				test('the stock RAFS lists are tenant- and owner-scoped for the real sessions, and agree with the visibleRows oracle',
					(fDone) =>
					{
						let tmpChecks = [ [ 'LabForm', 'Tech' ], [ 'LabForm', 'Colleague' ], [ 'LabForm', 'OtherTech' ], [ 'MaterialIntake', 'Tech' ], [ 'MaterialIntake', 'OtherTech' ] ];
						let tmpCounts = {};
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpChecks.length)
							{
								// Owner scope: Tech and Colleague share a tenant but not LabForms.
								Expect(tmpCounts['LabForm/Tech']).to.not.equal(tmpCounts['LabForm/Colleague']);
								Expect(tmpCounts['MaterialIntake/Tech']).to.not.equal(tmpCounts['MaterialIntake/OtherTech']);
								return _Harness.request('GET', '/1.0/LabForms/Count', null, null,
									(pError, pResponse) =>
									{
										Expect(pError).to.equal(null);
										Expect(pResponse.Status).to.equal(401);
										return fDone();
									});
							}
							let tmpEntity = tmpChecks[pIndex][0];
							let tmpName = tmpChecks[pIndex][1];
							_Harness.listCount(tmpEntity, null, tmpName,
								(pError, pCount) =>
								{
									Expect(pError, `${tmpEntity} as ${tmpName}`).to.equal(null);
									Expect(pCount, `${tmpEntity} as ${tmpName}`).to.equal(_Harness.visibleRows(tmpEntity, tmpName).length);
									Expect(pCount).to.be.above(0);
									tmpCounts[`${tmpEntity}/${tmpName}`] = pCount;
									return fNext(pIndex + 1);
								});
						};
						return fNext(0);
					});

				test('the overlay is wired as §80.3: ProbeHidden has no route, ProbeDenied is 404 at the tenancy pre-handler, the late mounts are unguarded lists',
					(fDone) =>
					{
						_Harness.request('GET', '/1.0/ProbeHiddens/Count', null, 'Tech',
							(pHiddenError, pHidden) =>
							{
								Expect(pHidden.Status).to.equal(404);
								_Harness.request('GET', '/1.0/ProbeDenieds/Count', null, 'Tech',
									(pDeniedError, pDenied) =>
									{
										Expect(pDenied.Status).to.equal(404);
										Expect(_Harness.server.Endpoints).to.have.property('ProbeLate');
										Expect(_Harness.server.NoAutoCRUDTables).to.include.keys('ProbeHidden', 'ProbeLate', 'ProbeLateGlobal', 'RFSAccount', 'RFSMembership', 'UserAction');
										// Registered after _mountTenancy: no tenancy layer, so its list shows BOTH tenants' live rows.
										_Harness.listCount('ProbeLate', null, 'Tech',
											(pLateError, pLateCount) =>
											{
												Expect(pLateError).to.equal(null);
												Expect(pLateCount).to.equal(_Harness.seed.LiveCounts.ProbeLate);
												Expect(pLateCount).to.equal(_Harness.visibleRows('ProbeLate', 'Tech').length);
												Expect(pLateCount).to.be.above(_Harness.seed.TenantLiveCounts[1].ProbeLate);
												return fDone();
											});
									});
							});
					});

				test('GET /1.0/Facet/Describe as a tenant user: 200 from the ApplicationServer host, with the facetable entities only',
					(fDone) =>
					{
						_Harness.describe(null, 'Tech',
							(pError, pResponse) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResponse.Status, pResponse.Text).to.equal(200);
								let tmpDescribe = pResponse.JSON;
								Expect(tmpDescribe.Role).to.equal('Embedded');
								Expect(tmpDescribe.ScopeAssurance).to.equal('Guarded');
								Expect(tmpDescribe.Engines.Live).to.deep.equal({ Available: true, Dialect: 'SQLite' });
								let tmpEntities = Object.keys(tmpDescribe.Entities);
								// Installed (incl. the tenant root), and Global by opt-in (§78 rule 4).
								Expect(tmpEntities).to.include.members([ 'LabForm', 'MaterialIntake', 'LabQueue', 'Customer', 'LabFormType', 'ProbeGlobal', 'ProbeLateGlobal', 'ProbeLink' ]);
								// Controllerless, denied by prefix, excluded without opt-in, an unguarded late mount with the column.
								[ 'ProbeHidden', 'ProbeDenied', 'ProbeExcluded', 'ProbeLate', 'RFSAccount', 'RFSMembership', 'UserAction' ].forEach(
									(pEntity) =>
									{
										Expect(tmpEntities, pEntity).to.not.include(pEntity);
									});
								return fDone();
							});
					});

				test('Describe refuses the anonymous request and the authenticated tenant-0 session with 401 FACET_UNAUTHENTICATED',
					(fDone) =>
					{
						_Harness.describe(null, null,
							(pAnonymousError, pAnonymous) =>
							{
								Expect(pAnonymous.Status).to.equal(401);
								Expect(pAnonymous.JSON.Error.Code).to.equal('FACET_UNAUTHENTICATED');
								_Harness.describe(null, 'TenantZero',
									(pZeroError, pZero) =>
									{
										Expect(pZero.Status).to.equal(401);
										Expect(pZero.JSON.Error.Code).to.equal('FACET_UNAUTHENTICATED');
										return fDone();
									});
							});
					});

				test('the query / compare / isolation helpers run end-to-end on a Global entity (LabFormType: Excluded, opted in, ungated by entitlements)',
					(fDone) =>
					{
						let tmpBody = { Facets: [ { Facet: 'LabFormType.Discipline' } ] };
						_Harness.query('LabFormType', tmpBody, { As: 'Newbie', Now: _Harness.traps.TestNow },
							(pError, pEnvelope) =>
							{
								Expect(pError).to.equal(null);
								Expect(pEnvelope.Total).to.equal(_Harness.visibleRows('LabFormType', 'Newbie').length);
								_Harness.assertTenantIsolation('LabFormType', tmpBody, null,
									(pIsolationError, pReport) =>
									{
										Expect(pIsolationError).to.equal(null);
										Expect(Object.keys(pReport.Principals)).to.deep.equal([ 'Tech', 'Colleague', 'Newbie', 'OtherTech' ]);
										Expect(pReport.Checked).to.be.above(0);
										return fDone();
									});
							});
					});

				test('switchTenant goes through the Membership route: the persona resets to 0, the next request re-enriches it, and the lists follow',
					(fDone) =>
					{
						let tmpHome = _Harness.as('Traveler');
						let tmpAway = _Harness.principals.Traveler.Memberships[1];
						_Harness.switchTenant('Traveler', tmpAway.Tenant,
							(pError, pResponse) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResponse.JSON.Switched).to.equal(true);
								Expect(_Harness.as('Traveler')).to.deep.equal({ Tenant: tmpAway.Tenant, User: tmpAway.User });
								Expect(_Harness.sessionFor('Traveler').UserRecord.IDUser).to.equal(0);
								_Harness.listCount('MaterialIntake', null, 'Traveler',
									(pCountError, pCount) =>
									{
										Expect(pCountError).to.equal(null);
										Expect(pCount).to.equal(_Harness.visibleRows('MaterialIntake', 'Traveler').length);
										Expect(_Harness.sessionFor('Traveler').UserRecord).to.include({ IDCustomer: tmpAway.Tenant, IDUser: tmpAway.User });
										_Harness.switchTenant('Traveler', 999,
											(pRefusedError, pRefused) =>
											{
												Expect(pRefused.JSON.Switched).to.equal(false);
												_Harness.login('Traveler',
													(pLoginError) =>
													{
														Expect(pLoginError).to.equal(null);
														Expect(_Harness.as('Traveler')).to.deep.equal(tmpHome);
														return fDone();
													});
											});
									});
							});
					});
			}
		);

		suite
		(
			`RAFS ${tmpRAFS.Version} harness: Header sessions (LabTrack + overlay, SQLite in memory; port 19138)`,
			() =>
			{
				let _Harness = null;

				suiteSetup(
					function (fDone)
					{
						this.timeout(60000);
						_Harness = libRAFSHarness.start({ Port: libRAFSHarness.PORTS.Header, Fixture: 'LabTrack', Session: 'Header' }, (pError) => { return fDone(pError); });
					});

				suiteTeardown(
					(fDone) =>
					{
						return _Harness ? _Harness.stop(fDone) : fDone();
					});

				test('the header resolver is the session: no authentication, no entitlements, in-process sessions mirror the headers',
					() =>
					{
						Expect(_Harness.session).to.equal('Header');
						Expect(_Harness.fable.OratorAuthentication).to.equal(undefined);
						Expect(_Harness.entitlements).to.equal(null);
						Expect(_Harness.tenancy.resolveSession).to.be.a('function');
						Expect(_Harness.sessionFor('Colleague')).to.deep.equal({ UserRecord: { IDCustomer: 1, IDUser: 2 } });
						Expect(_Harness.host.getHostKind()).to.equal('ApplicationServer');
					});

				test('GET /1.0/Facet/Describe as a tenant user is 200; the tenant-0 session is 401 while its RAFS list answers 200 with no rows (§75.5)',
					(fDone) =>
					{
						_Harness.describe(null, 'OtherTech',
							(pError, pResponse) =>
							{
								Expect(pError).to.equal(null);
								Expect(pResponse.Status, pResponse.Text).to.equal(200);
								Expect(pResponse.JSON.Entities).to.have.property('LabForm');
								Expect(pResponse.JSON.Entities).to.not.have.property('ProbeHidden');
								_Harness.describe(null, 'TenantZero',
									(pZeroError, pZero) =>
									{
										Expect(pZero.Status).to.equal(401);
										_Harness.listCount('MaterialIntake', null, 'TenantZero',
											(pCountError, pCount) =>
											{
												Expect(pCountError).to.equal(null);
												Expect(pCount).to.equal(0);
												return fDone();
											});
									});
							});
					});

				test('the stock lists are scoped by the header session (tenant and LabForm owner)',
					(fDone) =>
					{
						_Harness.listCount('LabForm', null, 'Tech',
							(pError, pCount) =>
							{
								Expect(pError).to.equal(null);
								Expect(pCount).to.equal(_Harness.visibleRows('LabForm', 'Tech').length);
								_Harness.listCount('LabForm', null, 'OtherTech',
									(pOtherError, pOtherCount) =>
									{
										Expect(pOtherError).to.equal(null);
										Expect(pOtherCount).to.equal(_Harness.visibleRows('LabForm', 'OtherTech').length);
										return fDone();
									});
							});
					});
			}
		);

		suite
		(
			`RAFS ${tmpRAFS.Version} harness: Installers 'None' (ProjectTrack, Header sessions)`,
			() =>
			{
				let _Harness = null;

				suiteSetup(
					function (fDone)
					{
						this.timeout(60000);
						_Harness = libRAFSHarness.start({ Port: libRAFSHarness.PORTS.Header, Fixture: 'ProjectTrack', Session: 'Header', Installers: 'None' }, (pError) => { return fDone(pError); });
					});

				suiteTeardown(
					(fDone) =>
					{
						return _Harness ? _Harness.stop(fDone) : fDone();
					});

				test('the facet routes exist only through the installers: the same app without them serves its lists and no /1.0/Facet',
					(fDone) =>
					{
						Expect(_Harness.service).to.equal(null);
						Expect(Object.keys(_Harness.principals)).to.include.members([ 'Lead', 'Member', 'Outsider', 'OtherLead' ]);
						_Harness.describe(null, 'Lead',
							(pError, pResponse) =>
							{
								Expect(pResponse.Status).to.equal(404);
								_Harness.listCount('Project', null, 'Lead',
									(pCountError, pCount) =>
									{
										Expect(pCountError).to.equal(null);
										Expect(pCount).to.equal(_Harness.visibleRows('Project', 'Lead').length);
										return fDone();
									});
							});
					});
			}
		);

		if (!PG_GATE.Available)
		{
			suite
			(
				`RAFS ${tmpRAFS.Version} harness on PostgreSQL`,
				() =>
				{
					test(`skipped: ${PG_GATE.Reason}`);
				}
			);
		}
		else
		{
			suite
			(
				`RAFS ${tmpRAFS.Version} harness on PostgreSQL (Login sessions, rfs-test-postgres)`,
				() =>
				{
					let _Harness = null;

					suiteSetup(
						function (fDone)
						{
							this.timeout(180000);
							_Harness = libRAFSHarness.start({ Port: libRAFSHarness.PORTS.Login, Fixture: 'LabTrack', Session: 'Login', Provider: 'PostgreSQL' }, (pError) => { return fDone(pError); });
						});

					suiteTeardown(
						function (fDone)
						{
							this.timeout(60000);
							return _Harness ? _Harness.stop(fDone) : fDone();
						});

					test('boots on a fresh rfs_<pid>_<n> database: Describe as a tenant user is 200 on the PostgreSQL dialect; the stock lists are scoped',
						(fDone) =>
						{
							_Harness.describe(null, 'Tech',
								(pError, pResponse) =>
								{
									Expect(pError).to.equal(null);
									Expect(pResponse.Status, pResponse.Text).to.equal(200);
									Expect(pResponse.JSON.Engines.Live.Dialect).to.equal('PostgreSQL');
									Expect(pResponse.JSON.Entities).to.have.property('LabForm');
									_Harness.listCount('MaterialIntake', null, 'OtherTech',
										(pCountError, pCount) =>
										{
											Expect(pCountError).to.equal(null);
											Expect(pCount).to.equal(_Harness.visibleRows('MaterialIntake', 'OtherTech').length);
											return fDone();
										});
								});
						});

					test('P1 (R2 + R3 + R4 on PostgreSQL): E3A and E3B as Tech and OtherTech (O1, O2), O2 through the RAFS Count route, isolation, Records == the list; tenant 0 and anonymous 401',
						function (fDone)
						{
							this.timeout(120000);
							let tmpCases = [];
							[ 'Tech', 'OtherTech' ].forEach((pName) => { tmpCases.push([ 'MaterialIntakeRequirement', e3aBody(), pName ], [ 'MaterialIntake', e3bBody(), pName ]); });
							eachSeries(tmpCases,
								(pCase, fNext) => { checkMotivating(_Harness, pCase[0], pCase[1], pCase[2], (pError) => { return fNext(pError || null); }); },
								(pError) =>
								{
									if (pError)
									{
										return fDone(pError);
									}
									eachSeries([ [ 'MaterialIntakeRequirement', e3aBody() ], [ 'MaterialIntake', e3bBody() ], [ 'LabForm', LABFORM_COLUMN_BODY() ] ],
										(pCase, fNext) => { _Harness.assertTenantIsolation(pCase[0], pCase[1], LABTRACK_PRINCIPALS, (pIsolationError) => { return fNext(pIsolationError || null); }); },
										(pIsolationError) =>
										{
											if (pIsolationError)
											{
												return fDone(pIsolationError);
											}
											eachSeries([ 'Tech', 'OtherTech' ],
												(pName, fNext) =>
												{
													_Harness.facet('LabForm', LABFORM_COLUMN_BODY(), pName,
														(pFacetError, pResponse) =>
														{
															Expect(pResponse.Status, pResponse.Text).to.equal(200);
															_Harness.assertSelectionRoundTrip('LabForm', LABFORM_COLUMN_BODY(), pResponse.JSON, { As: pName, CountVia: 'List' },
																(pRoundTripError) =>
																{
																	if (pRoundTripError)
																	{
																		return fNext(pRoundTripError);
																	}
																	_Harness.assertRecordsMatchList('LabForm', LABFORM_COLUMN_BODY(), pName, (pRecordsError) => { return fNext(pRecordsError || null); });
																});
														});
												},
												(pListError) =>
												{
													if (pListError)
													{
														return fDone(pListError);
													}
													assertUnauthenticated(_Harness, 'MaterialIntake', e3bBody(), fDone);
												});
										});
								});
						});
				}
			);
		}

		// ---- End to end on a real RAFS app (internal-contracts §80.4): the motivating queries as
		// authenticated users in two tenants, the R / L rows, change capture, PostgreSQL, ClickHouse. ----

		suite
		(
			`RAFS ${tmpRAFS.Version} app: E3A / E3B as authenticated users in two tenants (Login + Entitlements + Membership, LabTrack; port 19139)`,
			() =>
			{
				let _Harness = null;

				suiteSetup(
					function (fDone)
					{
						this.timeout(60000);
						_Harness = libRAFSHarness.start({ Port: libRAFSHarness.PORTS.Login, Fixture: 'LabTrack', Session: 'Login' }, (pError) => { return fDone(pError); });
					});

				suiteTeardown(
					(fDone) =>
					{
						return _Harness ? _Harness.stop(fDone) : fDone();
					});

				test('R1 boot: both installers ran from the app\'s own hook arrays before listen; Host ApplicationServer; the coverage snapshot classifies every model table (§73, §75.2)',
					() =>
					{
						Expect(_Harness.service._Attached).to.equal(true);
						Expect(_Harness.service._RoutesConnected).to.equal(true);
						Expect(_Harness.host.getHostKind()).to.equal('ApplicationServer');
						Expect(_Harness.host.isBound()).to.equal(true);
						Expect(_Harness.host.getApplicationServer()).to.equal(_Harness.server);
						let tmpSnapshot = _Harness.host.tenancySnapshot();
						Expect(tmpSnapshot.Source).to.equal('Marker');
						Expect(tmpSnapshot.Column).to.equal('IDCustomer');
						Expect(tmpSnapshot.Classes).to.deep.equal(LABTRACK_COVERAGE);
						Expect(Object.keys(tmpSnapshot.Classes).sort()).to.deep.equal(Object.keys(_Harness.model.Tables).sort());
						// The policy's Required set is what RAFS installed (§75.3).
						let tmpPolicy = _Harness.host.getScopePolicy();
						Expect(tmpPolicy.requiredFor('LabForm', null).map((pEntry) => { return pEntry.Column; }).sort()).to.deep.equal([ 'IDCustomer', 'OwnerIDUser' ]);
						Expect(tmpPolicy.requiredFor('MaterialIntake', null).map((pEntry) => { return pEntry.Column; })).to.deep.equal([ 'IDCustomer' ]);
						Expect(tmpPolicy.requiredFor('LabFormType', null)).to.deep.equal([]);
						Expect(tmpPolicy.requiredFor('ProbeLate', null)).to.deep.equal([]);
					});

				[ [ 'MaterialIntakeRequirement', 'E3A', e3aBody ], [ 'MaterialIntake', 'E3B', e3bBody ] ].forEach(
					(pCase) =>
					{
						test(`${pCase[1]} through POST /1.0/Facet/${pCase[0]}/Query as Tech, Colleague, Newbie and OtherTech: O1 (Live == the Reference read through RAFS's own list waterfall, same session; HTTP == in-process) and O2 for every bucket`,
							function (fDone)
							{
								this.timeout(60000);
								eachSeries(LABTRACK_PRINCIPALS,
									(pName, fNext) =>
									{
										checkMotivating(_Harness, pCase[0], pCase[2](_Harness.traps), pName,
											(pError, pResult) =>
											{
												if (pError)
												{
													return fNext(pError);
												}
												Expect(pResult.Live.Total, `${pCase[1]} as ${pName}`).to.be.a('number');
												Expect(pResult.Report.CountVia).to.equal('Reference');
												Expect(pResult.Report.Checked, `${pCase[1]} as ${pName}: O2 checks`).to.be.above(3);
												return fNext();
											});
									}, fDone);
							});
					});

				test('E3A / E3B tenant isolation: per principal Live == Reference, every bucket key and resolved label from a row its RAFS list shows, every Keys key and Records row visible, Keys Count == Total; the two tenants\' answers differ',
					function (fDone)
					{
						this.timeout(60000);
						let tmpTotals = {};
						eachSeries([ [ 'MaterialIntakeRequirement', e3aBody() ], [ 'MaterialIntake', e3bBody() ] ],
							(pCase, fNext) =>
							{
								_Harness.assertTenantIsolation(pCase[0], pCase[1], LABTRACK_PRINCIPALS,
									(pError, pReport) =>
									{
										if (pError)
										{
											return fNext(pError);
										}
										Expect(pReport.Checked, pCase[0]).to.be.above(10);
										tmpTotals[pCase[0]] = pReport.Principals;
										return fNext();
									});
							},
							(pError) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								[ 'MaterialIntakeRequirement', 'MaterialIntake' ].forEach(
									(pEntity) =>
									{
										Expect(tmpTotals[pEntity].Tech.Total, pEntity).to.not.equal(tmpTotals[pEntity].OtherTech.Total);
										Expect(tmpTotals[pEntity].Tech.Keys, pEntity).to.be.above(0);
										Expect(tmpTotals[pEntity].OtherTech.Keys, pEntity).to.be.above(0);
									});
								return fDone();
							});
					});

				test('Records == the rows RAFS\'s own list returns, as the same session: every row of E3A\'s and E3B\'s entity, a bucket\'s selection, and a column-clause body on the owner-scoped LabForm',
					function (fDone)
					{
						this.timeout(60000);
						let tmpLabFormBody = { Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Pending', 'Complete' ], FilterKey: 'Status', Hash: 'Status-1' } ] };
						let tmpCases = [];
						LABTRACK_PRINCIPALS.forEach(
							(pName) =>
							{
								tmpCases.push([ 'MaterialIntakeRequirement', {}, pName ]);
								tmpCases.push([ 'MaterialIntake', {}, pName ]);
								tmpCases.push([ 'LabForm', tmpLabFormBody, pName ]);
							});
						eachSeries(tmpCases,
							(pCase, fNext) =>
							{
								_Harness.assertRecordsMatchList(pCase[0], pCase[1], pCase[2],
									(pError, pReport) =>
									{
										if (pError)
										{
											return fNext(pError);
										}
										Expect(pReport.Records, `${pCase[0]} as ${pCase[2]}`).to.equal(pReport.Listed);
										Expect(pReport.Records, `${pCase[0]} as ${pCase[2]}`).to.equal(_Harness.visibleRows(pCase[0], pCase[2]).filter((pRow) => { return (pCase[0] !== 'LabForm') || ([ 'Pending', 'Complete' ].indexOf(pRow.Status) >= 0); }).length);
										return fNext();
									});
							},
							(pError) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								// A bucket of E3A selected: the bucket Clause as the Records filter equals the list's rows.
								_Harness.facet('MaterialIntakeRequirement', e3aBody(), 'Tech',
									(pFacetError, pResponse) =>
									{
										Expect(pResponse.Status, pResponse.Text).to.equal(200);
										let tmpBucket = pResponse.JSON.Facets.ToDo.Buckets.find((pEntry) => { return pEntry.Clause && (pEntry.Count > 0); });
										Expect(tmpBucket).to.be.an('object');
										_Harness.assertRecordsMatchList('MaterialIntakeRequirement', { Clauses: [ tmpBucket.Clause ] }, 'Tech',
											(pRecordsError, pReport) =>
											{
												Expect(pRecordsError).to.equal(null);
												Expect(pReport.Records).to.be.above(0);
												return fDone();
											});
									});
							});
					});

				test('O2 through the stock RAFS Count route (GET /1.0/<E>s/Count/FilteredTo/…, as the same session) on every guarded E3 entity and the owner-scoped LabForm, both tenants',
					function (fDone)
					{
						this.timeout(60000);
						let tmpCases = [];
						[ 'Tech', 'OtherTech' ].forEach(
							(pName) =>
							{
								tmpCases.push([ 'LabForm', LABFORM_COLUMN_BODY(), pName ]);
								tmpCases.push([ 'MaterialIntake', MATERIALINTAKE_COLUMN_BODY(), pName ]);
								tmpCases.push([ 'MaterialIntakeRequirement', { Facets: [ { Key: 'Type', Facet: 'MaterialIntakeRequirement.IDLabFormType' }, { Key: 'Intake', Facet: 'MaterialIntakeRequirement.IDMaterialIntake', Top: 50 } ], Total: true }, pName ]);
							});
						eachSeries(tmpCases,
							(pCase, fNext) =>
							{
								_Harness.facet(pCase[0], pCase[1], pCase[2],
									(pError, pResponse) =>
									{
										Expect(pResponse.Status, pResponse.Text).to.equal(200);
										_Harness.assertSelectionRoundTrip(pCase[0], pCase[1], pResponse.JSON, { As: pCase[2], CountVia: 'List' },
											(pRoundTripError, pReport) =>
											{
												if (pRoundTripError)
												{
													return fNext(pRoundTripError);
												}
												Expect(pReport.CountVia).to.equal('List');
												Expect(pReport.Checked, `${pCase[0]} as ${pCase[2]}`).to.be.above(3);
												return fNext();
											});
									});
							}, fDone);
					});

				test('L1 / L5: facets follow the logged-in session; a tenant switch (POST /1.0/Session/Context/:ID) re-scopes them, re-enriches the persona before the facet route runs, and changes the principal key (§76)',
					function (fDone)
					{
						this.timeout(30000);
						let tmpBody = { Facets: [ { Key: 'Status', Facet: 'MaterialIntake.Status' } ], Total: true };
						let tmpHome = _Harness.as('Traveler');
						let tmpAway = _Harness.principals.Traveler.Memberships.find((pMembership) => { return pMembership.Tenant !== tmpHome.Tenant; });
						_Harness.principalFor('Traveler',
							(pHomePrincipalError, pHomePrincipal) =>
							{
								Expect(pHomePrincipal).to.include({ Kind: 'User', IDCustomer: tmpHome.Tenant, IDUser: tmpHome.User });
								_Harness.facet('MaterialIntake', tmpBody, 'Traveler',
									(pHomeError, pHomeResponse) =>
									{
										Expect(pHomeResponse.Status, pHomeResponse.Text).to.equal(200);
										Expect(pHomeResponse.JSON.Total).to.equal(_Harness.visibleRows('MaterialIntake', 'Traveler').length);
										_Harness.switchTenant('Traveler', tmpAway.Tenant,
											(pSwitchError, pSwitch) =>
											{
												Expect(pSwitch.JSON.Switched).to.equal(true);
												// The switch reset the persona; the FACET request is the first one after it.
												Expect(_Harness.sessionFor('Traveler').UserRecord.IDUser).to.equal(0);
												_Harness.facet('LabForm', { Facets: [ { Key: 'Status', Facet: 'LabForm.Status' } ], Total: true }, 'Traveler',
													(pLabFormError, pLabForm) =>
													{
														Expect(pLabForm.Status, pLabForm.Text).to.equal(200);
														// L5: the entitlements pre-handler re-enriched the persona before the facet route,
														// so the owner scope is the away persona's (never 0, never the home persona).
														Expect(_Harness.sessionFor('Traveler').UserRecord.IDUser).to.equal(tmpAway.User);
														Expect(pLabForm.JSON.Total).to.equal(_Harness.visibleRows('LabForm', 'Traveler').length);
														Expect(pLabForm.JSON.Total, 'the away persona owns forms').to.be.above(0);
														_Harness.facet('MaterialIntake', tmpBody, 'Traveler',
															(pAwayError, pAwayResponse) =>
															{
																Expect(pAwayResponse.JSON.Total).to.equal(_Harness.visibleRows('MaterialIntake', 'Traveler').length);
																Expect(pAwayResponse.JSON.Total).to.not.equal(pHomeResponse.JSON.Total);
																_Harness.principalFor('Traveler',
																	(pAwayPrincipalError, pAwayPrincipal) =>
																	{
																		Expect(pAwayPrincipal).to.include({ IDCustomer: tmpAway.Tenant, IDUser: tmpAway.User });
																		Expect(libRetoldFacetingUtil.principalKey(pAwayPrincipal)).to.not.equal(libRetoldFacetingUtil.principalKey(pHomePrincipal));
																		Expect(libRetoldFacetingUtil.principalIdentityKey(pAwayPrincipal)).to.not.equal(libRetoldFacetingUtil.principalIdentityKey(pHomePrincipal));
																		_Harness.login('Traveler', (pLoginError) => { return fDone(pLoginError || undefined); });
																	});
															});
													});
											});
									});
							});
					});
			}
		);

		suite
		(
			`RAFS ${tmpRAFS.Version} app: E1 / E2 as authenticated users in two tenants (Login + Entitlements + Membership, ProjectTrack; port 19139)`,
			() =>
			{
				let _Harness = null;

				suiteSetup(
					function (fDone)
					{
						this.timeout(60000);
						_Harness = libRAFSHarness.start({ Port: libRAFSHarness.PORTS.Login, Fixture: 'ProjectTrack', Session: 'Login' }, (pError) => { return fDone(pError); });
					});

				suiteTeardown(
					(fDone) =>
					{
						return _Harness ? _Harness.stop(fDone) : fDone();
					});

				[ [ 'Project', 'E1', e1Body ], [ 'Document', 'E2', e2Body ] ].forEach(
					(pCase) =>
					{
						test(`${pCase[1]} through POST /1.0/Facet/${pCase[0]}/Query as Lead, Member, Outsider and OtherLead: O1 and O2 for every bucket (CountVia Reference: scopes, joins)`,
							function (fDone)
							{
								this.timeout(60000);
								let tmpTotals = {};
								eachSeries(PROJECTTRACK_PRINCIPALS,
									(pName, fNext) =>
									{
										checkMotivating(_Harness, pCase[0], pCase[2](_Harness.traps), pName,
											(pError, pResult) =>
											{
												if (pError)
												{
													return fNext(pError);
												}
												tmpTotals[pName] = pResult.Live.Total;
												Expect(pResult.Report.Checked, `${pCase[1]} as ${pName}: O2 checks`).to.be.above(3);
												return fNext();
											});
									},
									(pError) =>
									{
										if (pError)
										{
											return fDone(pError);
										}
										Expect(Object.keys(tmpTotals)).to.have.lengthOf(PROJECTTRACK_PRINCIPALS.length);
										return fDone();
									});
							});
					});

				test('E1 / E2 tenant isolation (facets, labels, Keys, Records) as every principal; Records == the RAFS list for the column clauses of E1 and E2',
					function (fDone)
					{
						this.timeout(60000);
						eachSeries([ [ 'Project', e1Body(_Harness.traps) ], [ 'Document', e2Body(_Harness.traps) ] ],
							(pCase, fNext) =>
							{
								_Harness.assertTenantIsolation(pCase[0], pCase[1], PROJECTTRACK_PRINCIPALS,
									(pError, pReport) =>
									{
										if (pError)
										{
											return fNext(pError);
										}
										Expect(pReport.Checked, pCase[0]).to.be.above(5);
										return fNext();
									});
							},
							(pError) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								let tmpE1Columns = { Clauses: e1Body(_Harness.traps).Clauses.filter((pClause) => { return !/Join/.test(pClause.Type); }), Records: { Sort: [ { Field: 'StartDate', Dir: 'DESC' } ] } };
								let tmpE2Columns = { Clauses: e2Body(_Harness.traps).Clauses.filter((pClause) => { return !/Join/.test(pClause.Type); }) };
								let tmpCases = [];
								PROJECTTRACK_PRINCIPALS.forEach((pName) => { tmpCases.push([ 'Project', tmpE1Columns, pName ], [ 'Document', tmpE2Columns, pName ]); });
								eachSeries(tmpCases,
									(pCase, fNext) =>
									{
										_Harness.assertRecordsMatchList(pCase[0], pCase[1], pCase[2], (pRecordsError) => { return fNext(pRecordsError || null); });
									}, fDone);
							});
					});
			}
		);

		suite
		(
			`RAFS ${tmpRAFS.Version} app: the R rows on Header sessions (LabTrack + probe overlay, SQLite; port 19138)`,
			() =>
			{
				let _Harness = null;
				let _Warnings = [];

				suiteSetup(
					function (fDone)
					{
						this.timeout(60000);
						_Harness = libRAFSHarness.start(
							{
								Port: libRAFSHarness.PORTS.Header, Fixture: 'LabTrack', Session: 'Header',
								// Right before the faceting route installer: record its boot warnings (the late-mount capture).
								BeforeListen: (pHarness) =>
								{
									let fWarn = pHarness.fable.log.warn;
									pHarness.fable.log.warn = function (pMessage)
									{
										_Warnings.push(String(pMessage));
										return fWarn.apply(this, arguments);
									};
								}
							}, (pError) => { return fDone(pError); });
					});

				suiteTeardown(
					(fDone) =>
					{
						return _Harness ? _Harness.stop(fDone) : fDone();
					});

				test('R1 on Header sessions: the same coverage table; the route phase captured the late mounts and warned about the unguarded one that carries the tenancy column',
					() =>
					{
						Expect(_Harness.host.tenancySnapshot().Classes).to.deep.equal(LABTRACK_COVERAGE);
						Expect(_Harness.service._RoutesConnected).to.equal(true);
						Expect(_Warnings.some((pMessage) => { return (pMessage.indexOf('ProbeLate') >= 0) && (pMessage.indexOf('ProbeLateGlobal') < 0); }), _Warnings.join('\n')).to.equal(true);
					});

				test('R2 parity on Header sessions: E3A and E3B as Tech and OtherTech (O1, O2)',
					function (fDone)
					{
						this.timeout(60000);
						let tmpCases = [];
						[ 'Tech', 'OtherTech' ].forEach((pName) => { tmpCases.push([ 'MaterialIntakeRequirement', e3aBody(), pName ], [ 'MaterialIntake', e3bBody(), pName ]); });
						eachSeries(tmpCases,
							(pCase, fNext) =>
							{
								checkMotivating(_Harness, pCase[0], pCase[1], pCase[2], (pError) => { return fNext(pError || null); });
							}, fDone);
					});

				test('R3 isolation: assertTenantIsolation on every Installed facetable entity for both tenants; a client clause naming the other tenant inside the fence matches nothing',
					function (fDone)
					{
						this.timeout(120000);
						let tmpEntities = Object.keys(LABTRACK_COVERAGE).filter((pEntity) => { return (LABTRACK_COVERAGE[pEntity] === 'Installed') && _Harness.host.isFacetable(pEntity); });
						Expect(tmpEntities).to.include.members([ 'Customer', 'User', 'LabQueue', 'MaterialIntake', 'MaterialIntakeRequirement', 'LabForm', 'ProbeLink' ]);
						eachSeries(tmpEntities,
							(pEntity, fNext) =>
							{
								let tmpBody = isolationBody(_Harness.model, pEntity);
								_Harness.assertTenantIsolation(pEntity, tmpBody, LABTRACK_PRINCIPALS,
									(pError) =>
									{
										if (pError)
										{
											return fNext(pError);
										}
										// The other tenant named inside the client fence: never a row of it.
										eachSeries([ [ 'Tech', 2 ], [ 'OtherTech', 1 ] ],
											(pProbe, fProbeNext) =>
											{
												_Harness.facet(pEntity, { FilterString: `FBV~IDCustomer~EQ~${pProbe[1]}`, Facets: tmpBody.Facets, Total: true }, pProbe[0],
													(pFenceError, pResponse) =>
													{
														Expect(pResponse.Status, `${pEntity} as ${pProbe[0]}: ${pResponse.Text}`).to.equal(200);
														Expect(pResponse.JSON.Total, `${pEntity} as ${pProbe[0]}`).to.equal(0);
														Object.keys(pResponse.JSON.Facets).forEach(
															(pKey) =>
															{
																(pResponse.JSON.Facets[pKey].Buckets || []).forEach((pBucket) => { Expect(pBucket.Count, `${pEntity}.${pKey}`).to.equal(0); });
															});
														_Harness.keys(pEntity, { FilterString: `FBV~IDCustomer~EQ~${pProbe[1]}` }, pProbe[0],
															(pKeysError, pKeys) =>
															{
																Expect(pKeys.JSON.Keys, pEntity).to.deep.equal([]);
																return fProbeNext();
															});
													});
											}, fNext);
									});
							}, fDone);
					});

				test('R4 tenant 0 and anonymous: 401 FACET_UNAUTHENTICATED on every facet route before any capture or statement, while the RAFS list for the same tenant-0 session answers 200 with no rows; owner 0 is 401 only where the root needs the owner (§75.5)',
					function (fDone)
					{
						this.timeout(30000);
						let tmpService = _Harness.service;
						let tmpCalls = { Captures: 0, Statements: 0 };
						let tmpCapture = _Harness.fable.RetoldFacetingScopeCapture;
						let tmpLive = _Harness.fable.RetoldFacetingEngineLive;
						let fCapture = tmpCapture.capture;
						let fStatement = tmpLive.runStatement;
						tmpCapture.capture = function () { tmpCalls.Captures++; return fCapture.apply(this, arguments); };
						tmpLive.runStatement = function () { tmpCalls.Statements++; return fStatement.apply(this, arguments); };
						let fRestore = () =>
						{
							delete tmpCapture.capture;
							delete tmpLive.runStatement;
						};
						let tmpRoutes = [ [ 'POST', '/1.0/Facet/MaterialIntake/Query', e3bBody() ], [ 'POST', '/1.0/Facet/LabForm/Records', {} ], [ 'POST', '/1.0/Facet/LabForm/Records/Count', {} ], [ 'POST', '/1.0/Facet/MaterialIntake/Keys', {} ], [ 'GET', '/1.0/Facet/Describe', null ], [ 'GET', '/1.0/Facet/Changes', null ] ];
						let tmpOwnerZero = { Headers: { 'x-rfs-test-tenant': '1', 'x-rfs-test-user': '0' } };
						let tmpCases = [];
						[ null, 'TenantZero' ].forEach((pAs) => { tmpRoutes.forEach((pRoute) => { tmpCases.push([ pRoute, pAs ]); }); });
						// Owner 0 (no persona) is unset only for the owner-scoped LabForm (§75.5, per entity).
						[ [ 'POST', '/1.0/Facet/LabForm/Query', { Facets: [ { Key: 'Status', Facet: 'LabForm.Status' } ] } ], [ 'POST', '/1.0/Facet/LabForm/Records', {} ], [ 'POST', '/1.0/Facet/LabForm/Records/Count', {} ], [ 'POST', '/1.0/Facet/LabForm/Keys', {} ] ].forEach((pRoute) => { tmpCases.push([ pRoute, tmpOwnerZero ]); });
						eachSeries(tmpCases,
							(pCase, fNext) =>
							{
								_Harness.request(pCase[0][0], pCase[0][1], pCase[0][2], pCase[1],
									(pError, pResponse) =>
									{
										Expect(pResponse.Status, `${pCase[0][1]} as ${JSON.stringify(pCase[1])}`).to.equal(401);
										Expect(pResponse.JSON.Error.Code).to.equal('FACET_UNAUTHENTICATED');
										return fNext();
									});
							},
							(pError) =>
							{
								fRestore();
								if (pError)
								{
									return fDone(pError);
								}
								Expect(tmpCalls).to.deep.equal({ Captures: 0, Statements: 0 });
								Expect(tmpService).to.equal(_Harness.service);
								_Harness.listCount('MaterialIntake', null, 'TenantZero',
									(pCountError, pCount) =>
									{
										Expect(pCountError).to.equal(null);
										Expect(pCount).to.equal(0);
										// The owner-0 session facets a non-personal entity exactly as its RAFS list shows it; Describe
										// does not list the owner-scoped LabForm for it.
										_Harness.facet('MaterialIntake', { Facets: [ { Key: 'Status', Facet: 'MaterialIntake.Status' } ], Total: true }, tmpOwnerZero,
											(pFacetError, pFacet) =>
											{
												Expect(pFacet.Status, pFacet.Text).to.equal(200);
												_Harness.listCount('MaterialIntake', null, tmpOwnerZero,
													(pListError, pListCount) =>
													{
														Expect(pListError).to.equal(null);
														Expect(pFacet.JSON.Total).to.equal(pListCount);
														Expect(pListCount).to.be.above(0);
														_Harness.request('GET', '/1.0/Facet/Describe', null, tmpOwnerZero,
															(pDescribeError, pDescribe) =>
															{
																Expect(pDescribe.Status, pDescribe.Text).to.equal(200);
																Expect(pDescribe.JSON.Entities).to.have.property('MaterialIntake');
																Expect(pDescribe.JSON.Entities).to.not.have.property('LabForm');
																return fDone();
															});
													});
											});
									});
							});
					});

				test('R5 personal scope: LabForm facets as Tech count only Tech\'s forms (RAFS PersonalScopes); the TenantOnly capture keeps the tenant and sees Colleague\'s forms; an unset owner value is 401',
					function (fDone)
					{
						this.timeout(30000);
						let tmpTech = _Harness.as('Tech');
						let tmpColleague = _Harness.as('Colleague');
						let tmpOwners = {};
						_Harness.visibleRows('LabForm', 'Colleague').concat(_Harness.visibleRows('LabForm', 'Tech')).forEach((pRow) => { tmpOwners[pRow.IDLabForm] = pRow.OwnerIDUser; });
						_Harness.facet('LabForm', { Facets: [ { Key: 'Status', Facet: 'LabForm.Status' } ], Total: true }, 'Tech',
							(pError, pResponse) =>
							{
								Expect(pResponse.Status, pResponse.Text).to.equal(200);
								Expect(pResponse.JSON.Total).to.equal(_Harness.visibleRows('LabForm', 'Tech').length);
								Expect(pResponse.JSON.Total).to.be.below(_Harness.visibleRows('LabForm', 'Tech').length + _Harness.visibleRows('LabForm', 'Colleague').length);
								_Harness.keys('LabForm', {}, 'Tech',
									(pKeysError, pKeys) =>
									{
										Expect(pKeys.JSON.Keys.length).to.equal(pResponse.JSON.Total);
										pKeys.JSON.Keys.forEach((pKey) => { Expect(tmpOwners[pKey], `LabForm ${pKey}`).to.equal(tmpTech.User); });
										fCapture();
									});
							});
						let fCapture = () =>
							{
								captureAs(_Harness, 'Tech', 'LabForm', [ { Column: 'Status', Value: 'Complete', Operator: '=' } ], 'TenantOnly',
									(pCaptureError, pCapture, pQuery) =>
									{
										Expect(pCaptureError).to.equal(null);
										Expect(pCapture.Opaque).to.equal(false);
										Expect(pCapture.Relaxed).to.equal(true);
										Expect(pCapture.HostWraps).to.equal(1);
										Expect(pCapture.Removed.map((pEntry) => { return pEntry.Column; })).to.deep.equal([ 'OwnerIDUser' ]);
										Expect(pCapture.Appended.map((pEntry) => { return [ pEntry.Column, pEntry.Value, pEntry.Depth ]; })).to.deep.equal([ [ 'IDCustomer', tmpTech.Tenant, 0 ] ]);
										_Harness.host.getExecutionDAL('LabForm').doReads(pQuery,
											(pReadError, pReadQuery, pRows) =>
											{
												Expect(pReadError).to.not.be.ok;
												let tmpOwners = new Set(pRows.map((pRow) => { return pRow.OwnerIDUser; }));
												Expect(tmpOwners.has(tmpColleague.User), 'a Colleague form').to.equal(true);
												pRows.forEach((pRow) => { Expect(pRow.IDCustomer).to.equal(tmpTech.Tenant); });
												_Harness.facet('LabForm', { Facets: [ { Key: 'Status', Facet: 'LabForm.Status' } ] }, { Headers: { 'x-rfs-test-tenant': String(tmpTech.Tenant), 'x-rfs-test-user': '0' } },
													(pUnsetError, pUnset) =>
													{
														Expect(pUnset.Status).to.equal(401);
														Expect(pUnset.JSON.Error.Code).to.equal('FACET_UNAUTHENTICATED');
														return fDone();
													});
											});
									});
							};
					});

				test('R6 isFacetable (§78): every probe as root, hop and label target; unknown, hidden, denied and unguarded entities are indistinguishable; Customer (Installed root) is facetable; ProbeLateGlobal is Global',
					function (fDone)
					{
						this.timeout(30000);
						let tmpHidden = [ 'ProbeHidden', 'ProbeDenied', 'ProbeExcluded', 'ProbeLate' ];
						let tmpGlobal = [ 'ProbeGlobal', 'ProbeLateGlobal' ];
						_Harness.facet('ProbeNowhere', { Facets: [ { Key: 'N', Facet: 'ProbeNowhere.Name' } ] }, 'Tech',
							(pUnknownError, pUnknown) =>
							{
								Expect(pUnknown.Status).to.equal(404);
								_Harness.facet('ProbeLink', { Facets: [ { Key: 'Hop', Facet: 'ProbeLink.IDProbeNowhere>ProbeNowhere.Name' } ] }, 'Tech',
									(pUnknownHopError, pUnknownHop) =>
									{
										let tmpUnknownHop = pUnknownHop.JSON.Errors.Hop;
										eachSeries(tmpHidden.concat(tmpGlobal),
											(pProbe, fNext) =>
											{
												let tmpIsGlobal = (tmpGlobal.indexOf(pProbe) >= 0);
												_Harness.facet(pProbe, { Facets: [ { Key: 'N', Facet: `${pProbe}.Name` } ], Total: true }, 'Tech',
													(pRootError, pRoot) =>
													{
														if (tmpIsGlobal)
														{
															Expect(pRoot.Status, pProbe).to.equal(200);
															// Global: both tenants' live rows (exactly what its own unguarded list shows).
															Expect(pRoot.JSON.Total, pProbe).to.equal(_Harness.visibleRows(pProbe, 'Tech').length);
														}
														else
														{
															Expect(pRoot.Status, pProbe).to.equal(404);
															Expect(pRoot.JSON, pProbe).to.deep.equal(pUnknown.JSON);
														}
														_Harness.facet('ProbeLink', { Facets: [ { Key: 'Hop', Facet: `ProbeLink.ID${pProbe}>${pProbe}.Name` }, { Key: 'Label', Facet: `ProbeLink.ID${pProbe}` } ] }, 'Tech',
															(pLinkError, pLink) =>
															{
																Expect(pLink.Status, pProbe).to.equal(200);
																let tmpLabels = pLink.JSON.Facets.Label.Buckets;
																Expect(tmpLabels.length, pProbe).to.be.above(0);
																if (tmpIsGlobal)
																{
																	Expect(pLink.JSON.Facets.Hop.Buckets.length, pProbe).to.be.above(0);
																	Expect(tmpLabels.some((pBucket) => { return pBucket.LabelResolved === true; }), pProbe).to.equal(true);
																}
																else
																{
																	// The hop is refused exactly like a path to an entity that does not exist, and the
																	// label target stays unlabeled.
																	Expect(pLink.JSON.Facets).to.not.have.property('Hop');
																	let tmpHop = JSON.parse(JSON.stringify(pLink.JSON.Errors.Hop));
																	let tmpExpected = JSON.parse(JSON.stringify(tmpUnknownHop));
																	delete tmpHop.Detail;
																	delete tmpExpected.Detail;
																	Expect(tmpHop, pProbe).to.deep.equal(tmpExpected);
																	tmpLabels.forEach((pBucket) => { Expect(pBucket.LabelResolved, `${pProbe} label`).to.not.equal(true); });
																}
																return fNext();
															});
													});
											},
											(pError) =>
											{
												if (pError)
												{
													return fDone(pError);
												}
												_Harness.describe(null, 'Tech',
													(pDescribeError, pDescribe) =>
													{
														tmpHidden.concat([ 'RFSAccount', 'RFSMembership', 'UserAction' ]).forEach((pEntity) => { Expect(pDescribe.JSON.Entities, pEntity).to.not.have.property(pEntity); });
														Expect(pDescribe.JSON.Entities).to.include.keys('Customer', 'ProbeGlobal', 'ProbeLateGlobal', 'LabFormType');
														_Harness.facet('Customer', { Facets: [ { Key: 'Name', Facet: 'Customer.Name' } ], Total: true }, 'OtherTech',
															(pCustomerError, pCustomer) =>
															{
																Expect(pCustomer.Status).to.equal(200);
																Expect(pCustomer.JSON.Total).to.equal(1);
																return fDone();
															});
													});
											});
									});
							});
					});

				test('R7 capture (§75.4): the RAFS outer group is peeled (HostWraps 1, Appended exactly the policy entries at depth 0, Portable); a later non-chaining setBehavior lands inside the guard and stays scoped; a direct _BehaviorFunctions write is a 500 under Strict',
					function (fDone)
					{
						this.timeout(30000);
						let tmpTech = _Harness.as('Tech');
						captureAs(_Harness, 'Tech', 'LabForm', [ { Column: 'Status', Value: 'Complete', Operator: '=' } ], 'Inherit',
							(pError, pCapture) =>
							{
								Expect(pError).to.equal(null);
								Expect(pCapture).to.include({ Opaque: false, Portable: true, HostWraps: 1 });
								Expect(pCapture.Transformed).to.deep.equal([]);
								Expect(pCapture.Guard.Satisfied).to.equal(true);
								Expect(pCapture.Appended.map((pEntry) => { return [ pEntry.Column, pEntry.Operator, pEntry.Value, pEntry.Depth ]; }))
									.to.deep.equal([ [ 'IDCustomer', '=', tmpTech.Tenant, 0 ], [ 'OwnerIDUser', '=', tmpTech.User, 0 ] ]);
								let tmpController = _Harness.host.getRouteBoundController('MaterialIntake');
								let tmpFunctions = tmpController.BehaviorInjection._BehaviorFunctions;
								let tmpGuard = tmpFunctions['Reads-QueryConfiguration'];
								// An app behavior registered the way meadow-endpoints documents it (single slot, does not chain):
								// RAFS's patched setBehavior keeps it inside the guard.
								tmpController.BehaviorInjection.setBehavior('Reads-QueryConfiguration',
									function (pRequest, pRequestState, fCallback)
									{
										pRequestState.Query.addFilter('Status', 'Cancelled', '!=', 'AND', 'AppNotCancelled');
										return fCallback();
									});
								let fRestore = () => { tmpFunctions['Reads-QueryConfiguration'] = tmpGuard; };
								captureAs(_Harness, 'Tech', 'MaterialIntake', [ { Column: 'Priority', Value: 'High', Operator: '!=' } ], 'Inherit',
									(pAppError, pAppCapture) =>
									{
										Expect(pAppError).to.equal(null);
										Expect(pAppCapture).to.include({ Opaque: false, HostWraps: 1 });
										Expect(pAppCapture.Appended.map((pEntry) => { return [ pEntry.Column, pEntry.Depth ]; })).to.deep.equal([ [ 'Status', 1 ], [ 'IDCustomer', 0 ] ]);
										_Harness.compare('MaterialIntake', e3bBody(), { As: 'Tech' },
											(pCompareError, pCompared) =>
											{
												Expect(pCompareError).to.equal(null);
												Expect(pCompared.Live.Status, pCompared.Live.Text).to.equal(200);
												Expect(pCompared.LiveNormalized).to.deep.equal(pCompared.ReferenceNormalized);
												// A direct slot write replaces RAFS's guard itself: Strict refuses (never an unscoped answer).
												tmpFunctions['Reads-QueryConfiguration'] = function (pRequest, pRequestState, fCallback) { return fCallback(); };
												_Harness.facet('MaterialIntake', e3bBody(), 'Tech',
													(pStrictError, pStrict) =>
													{
														fRestore();
														Expect(pStrict.Status).to.equal(500);
														Expect(pStrict.JSON.Error.Code).to.equal('FACET_SCOPE_POLICY_VIOLATION');
														Expect(JSON.stringify(pStrict.JSON)).to.not.contain('IDCustomer');
														_Harness.facet('MaterialIntake', e3bBody(), 'Tech',
															(pRestoredError, pRestored) =>
															{
																Expect(pRestored.Status).to.equal(200);
																return fDone();
															});
													});
											});
									});
							});
					});

				test('R8 NULL on SQLite (§75.4 swap): the Missing rows\' filter (rendered IS + null) passes RAFS\'s fence and equals the Reference, the MissingCount and the seed; the capture restores IS (nothing Transformed)',
					function (fDone)
					{
						this.timeout(30000);
						let tmpBody = { Facets: [ { Key: 'Done', Facet: 'LabForm.CompletedDate', Interval: 'month', Missing: true }, { Key: 'Status', Facet: 'LabForm.Status' } ], Total: true };
						_Harness.facet('LabForm', tmpBody, 'Tech',
							(pError, pResponse) =>
							{
								Expect(pResponse.Status, pResponse.Text).to.equal(200);
								let tmpMissing = pResponse.JSON.Facets.Done.MissingCount;
								Expect(tmpMissing, 'the fixture has open forms').to.be.above(0);
								Expect(tmpMissing).to.equal(_Harness.visibleRows('LabForm', 'Tech').filter((pRow) => { return (pRow.CompletedDate === null) || (typeof(pRow.CompletedDate) === 'undefined'); }).length);
								// meadow-filter's NULL form (FBV~<Column>~IN~0): FilterAST renders it IS + null on SQLite (FH-2).
								let tmpBodies = [ { FilterString: 'FBV~CompletedDate~IN~0', Facets: [ { Key: 'Status', Facet: 'LabForm.Status' } ], Total: true } ];
								eachSeries(tmpBodies,
									(pBody, fNext) =>
									{
										_Harness.compare('LabForm', pBody, { As: 'Tech' },
											(pCompareError, pCompared) =>
											{
												Expect(pCompared.Live.Status, pCompared.Live.Text).to.equal(200);
												Expect(pCompared.LiveNormalized).to.deep.equal(pCompared.ReferenceNormalized);
												Expect(pCompared.Live.JSON.Total).to.equal(tmpMissing);
												// Counted through the Reference: the stock list cannot carry a NULL filter on SQLite (FoxHound's
												// SQLite dialect renders 'IS NULL :p', FH-2 — the reason faceting renders 'IS' + null at all).
												_Harness.assertSelectionRoundTrip('LabForm', pBody, pCompared.Live.JSON, { As: 'Tech', CountVia: 'Reference' }, (pRoundTripError) => { return fNext(pRoundTripError || null); });
											});
									},
									(pBodiesError) =>
									{
										if (pBodiesError)
										{
											return fDone(pBodiesError);
										}
										captureAs(_Harness, 'Tech', 'LabForm', [ { Column: 'CompletedDate', Value: null, Operator: 'IS' } ], 'Inherit',
											(pCaptureError, pCapture, pQuery) =>
											{
												Expect(pCaptureError).to.equal(null);
												Expect(pCapture).to.include({ Opaque: false, HostWraps: 1 });
												Expect(pCapture.Transformed).to.deep.equal([]);
												let tmpEntry = pQuery.parameters.filter.find((pEntry) => { return pEntry.Column === 'CompletedDate'; });
												Expect(tmpEntry).to.include({ Operator: 'IS', Value: null, Parameter: 'c0' });
												return fDone();
											});
									});
							});
					});
			}
		);

		suite
		(
			`RAFS ${tmpRAFS.Version} app: ScopeGuard Repair is refused with tenancy (Header sessions, LabTrack; port 19138)`,
			() =>
			{
				test('R7 Repair: Scope.Guard \'Repair\' fails the RAFS boot (Strict only: faceting never fills in a displaced tenancy guard, §73.5); a direct _BehaviorFunctions write is a 500 under Strict (R7 above)',
					function (fDone)
					{
						this.timeout(60000);
						let tmpHarness = libRAFSHarness.start({ Port: libRAFSHarness.PORTS.Header, Fixture: 'LabTrack', Session: 'Header', Faceting: { Scope: { Guard: 'Repair' } } },
							(pError) =>
							{
								Expect(pError, 'the boot fails').to.be.an('error');
								Expect(pError.Code).to.equal('FACET_INTERNAL');
								Expect(pError.message).to.contain(`Scope.Guard 'Repair'`);
								Expect(tmpHarness.baseURL).to.equal(null);
								return tmpHarness.stop(() => { return fDone(); });
							});
					});
			}
		);

		suite
		(
			`RAFS ${tmpRAFS.Version} app: M4 change capture through RAFS's own CRUD routes (Login, Cache on, SSE; LabTrack; port 19139)`,
			() =>
			{
				let _Harness = null;

				suiteSetup(
					function (fDone)
					{
						this.timeout(60000);
						_Harness = libRAFSHarness.start({ Port: libRAFSHarness.PORTS.Login, Fixture: 'LabTrack', Session: 'Login', Faceting: CHANGE_FACETING }, (pError) => { return fDone(pError); });
					});

				suiteTeardown(
					(fDone) =>
					{
						return _Harness ? _Harness.stop(fDone) : fDone();
					});

				test('R9: the interim intake wraps every Installed / Global facetable route-bound controller; chassis raw writers are uncovered (never cached) (§79)',
					(fDone) =>
					{
						let tmpIntake = _Harness.fable.RetoldFacetingChangeIntake;
						Expect(tmpIntake.covers('LabForm')).to.equal(true);
						Expect(tmpIntake.covers('MaterialIntake')).to.equal(true);
						Expect(tmpIntake.covers('LabFormType')).to.equal(true);
						let tmpRawWriters = _Harness.host.rawWriterEntities();
						Expect(tmpRawWriters).to.include.members([ 'RFSAccount', 'RFSMembership', 'Role', 'RoleAction', 'UserRole', 'UserAction' ]);
						tmpRawWriters.forEach((pEntity) => { Expect(tmpIntake.covers(pEntity), pEntity).to.equal(false); });
						_Harness.query('Role', { Facets: [ { Key: 'Name', Facet: 'Role.Name' } ], Total: true }, { As: 'Tech' },
							(pError, pEnvelope, pMeta) =>
							{
								Expect(pError).to.equal(null);
								Expect(pMeta.Cache).to.include({ Status: 'Bypass', Reason: 'NoChangeSource' });
								// The roles were provisioned DAL-direct at seed time (Entitlements.provisionDefaultRoles): count them
								// through RAFS's own Role list as the same session.
								_Harness.listCount('Role', null, 'Tech',
									(pCountError, pCount) =>
									{
										Expect(pCountError).to.equal(null);
										Expect(pEnvelope.Total).to.equal(pCount);
										Expect(pCount).to.be.above(0);
										_Harness.query('MaterialIntake', e3bBody(), { As: 'Tech' },
											(pIntakeError, pIntakeEnvelope, pIntakeMeta) =>
											{
												Expect(pIntakeError).to.equal(null);
												Expect(pIntakeMeta.Cache.Reason).to.not.equal('NoChangeSource');
												return fDone();
											});
									});
							});
					});

				test('a RAFS CRUD write by tenant 1 (PUT /1.0/LabForm as Tech) bumps tenant-1 keys only: Tech\'s ETag changes and its SSE stream gets one generation event; OtherTech\'s ETag still 304s and its stream stays quiet; ETags never cross tenants',
					function (fDone)
					{
						this.timeout(30000);
						let tmpBody = LABFORM_COLUMN_BODY();
						let tmpOtherBody = MATERIALINTAKE_COLUMN_BODY();
						_Harness.facet('LabForm', tmpBody, 'Tech',
							(pError, pTech) =>
							{
								Expect(pTech.Status, pTech.Text).to.equal(200);
								let tmpTechTag = pTech.Headers.etag;
								Expect(tmpTechTag).to.match(/^W\/"fv1:[0-9a-f]{16}"$/);
								_Harness.facet('LabForm', tmpBody, 'OtherTech',
									(pOtherError, pOther) =>
									{
										let tmpOtherTag = pOther.Headers.etag;
										Expect(tmpOtherTag).to.not.equal(tmpTechTag);
										_Harness.facet('MaterialIntake', tmpOtherBody, 'OtherTech',
											(pOtherIntakeError, pOtherIntake) =>
											{
												let tmpOtherIntakeTag = pOtherIntake.Headers.etag;
												eachSeries([ [ 'Tech', tmpTechTag, 304 ], [ 'OtherTech', tmpOtherTag, 304 ], [ 'OtherTech', tmpTechTag, 200 ] ],
													(pCase, fNext) =>
													{
														_Harness.request('POST', '/1.0/Facet/LabForm/Query', tmpBody, { As: pCase[0], Headers: { 'if-none-match': pCase[1] } },
															(pTagError, pTagged) =>
															{
																Expect(pTagged.Status, `${pCase[0]} with ${pCase[1]}`).to.equal(pCase[2]);
																return fNext();
															});
													},
													() =>
													{
														_Harness.openChanges('Tech',
															(pTechStreamError, pTechStream) =>
															{
																Expect(pTechStream.Status).to.equal(200);
																_Harness.openChanges('OtherTech',
																	(pOtherStreamError, pOtherStream) =>
																	{
																		Expect(pOtherStream.Status).to.equal(200);
																		let tmpRow = _Harness.visibleRows('LabForm', 'Tech')[0];
																		_Harness.request('PUT', '/1.0/LabForm', { IDLabForm: tmpRow.IDLabForm, Status: (tmpRow.Status === 'Pending') ? 'Complete' : 'Pending' }, 'Tech',
																			(pWriteError, pWrite) =>
																			{
																				Expect(pWrite.Status, pWrite.Text).to.equal(200);
																				Expect(pWrite.JSON.IDCustomer).to.equal(_Harness.as('Tech').Tenant);
																				waitFor(() => { return pTechStream.generations('LabForm').length > 0; }, 5000,
																					(pWaitError) =>
																					{
																						Expect(pWaitError || null).to.equal(null);
																						setTimeout(
																							() =>
																							{
																								Expect(pTechStream.generations('LabForm')).to.have.lengthOf(1);
																								Expect(Object.keys(pTechStream.generations('LabForm')[0].Data).sort()).to.deep.equal([ 'Entity', 'Generation', 'Seq' ]);
																								Expect(pOtherStream.generations()).to.deep.equal([]);
																								eachSeries([ [ 'LabForm', tmpBody, 'Tech', tmpTechTag, 200 ], [ 'LabForm', tmpBody, 'OtherTech', tmpOtherTag, 304 ], [ 'MaterialIntake', tmpOtherBody, 'OtherTech', tmpOtherIntakeTag, 304 ] ],
																									(pCase, fNext) =>
																									{
																										_Harness.request('POST', `/1.0/Facet/${pCase[0]}/Query`, pCase[1], { As: pCase[2], Headers: { 'if-none-match': pCase[3] } },
																											(pAfterError, pAfter) =>
																											{
																												Expect(pAfter.Status, `${pCase[0]} as ${pCase[2]} after the write`).to.equal(pCase[4]);
																												if (pCase[4] === 200)
																												{
																													Expect(pAfter.Headers.etag).to.not.equal(pCase[3]);
																												}
																												return fNext();
																											});
																									},
																									() =>
																									{
																										pTechStream.close();
																										pOtherStream.close();
																										return fDone();
																									});
																							}, 120);
																					}, 'Tech\'s generation event');
																			});
																	});
															});
													});
											});
									});
							});
					});

				test('read-your-writes keys by the principal identity (§71.2): Tech\'s write (RoleSetHash \'\') upgrades its own Bounded reads (RoleSetHash r:…) to Exact, never OtherTech\'s',
					(fDone) =>
					{
						// Tech's own write through the stock CRUD route (its session's write principal has no action set).
						let tmpRow = _Harness.visibleRows('LabForm', 'Tech')[1];
						_Harness.request('PUT', '/1.0/LabForm', { IDLabForm: tmpRow.IDLabForm, Status: tmpRow.Status }, 'Tech',
							(pWriteError, pWrite) =>
							{
								Expect(pWrite.Status, pWrite.Text).to.equal(200);
								_Harness.principalFor('Tech', (pError, pTech) => { fCheck(pError, pTech); });
							});
						let fCheck = (pError, pTech) =>
							{
								Expect(pTech.RoleSetHash).to.match(/^r:[0-9a-f]{12}$/);
								Expect(pTech.Actions.has('LabForm.read')).to.equal(true);
								Expect(Object.keys(pTech)).to.not.include('Actions');
								let tmpTracker = _Harness.fable.RetoldFacetingReadYourWrites;
								Expect(tmpTracker.lastWrite(pTech)).to.be.an('object');
								let tmpBody = Object.assign(LABFORM_COLUMN_BODY(), { Freshness: { Mode: 'Bounded', MaxLagMS: 60000 } });
								_Harness.query('LabForm', tmpBody, { As: 'Tech' },
									(pQueryError, pEnvelope, pMeta) =>
									{
										Expect(pQueryError).to.equal(null);
										Expect(pMeta.Freshness).to.include({ Mode: 'Exact', Requested: 'Bounded', Upgrade: 'ReadYourWrites' });
										_Harness.query('LabForm', tmpBody, { As: 'OtherTech' },
											(pOtherError, pOtherEnvelope, pOtherMeta) =>
											{
												Expect(pOtherMeta.Freshness.Upgrade).to.equal(null);
												return fDone();
											});
									});
							};
					});
			}
		);

		suite
		(
			`RAFS ${tmpRAFS.Version} app: the L rows (Login; custom roles, a UserAction deny, Cache on, Admin routes; LabTrack; port 19139)`,
			() =>
			{
				let _Harness = null;

				suiteSetup(
					function (fDone)
					{
						this.timeout(60000);
						_Harness = libRAFSHarness.start(
							{
								Port: libRAFSHarness.PORTS.Login, Fixture: 'LabTrack', Session: 'Login',
								Roles: ENTITLEMENT_ROLES,
								Grants: { Newbie: [ 'limited' ] },
								Denies: { Colleague: [ 'LabQueue.read' ] },
								Faceting: { Cache: { Enabled: true, ExposeStatus: true }, Authorization: { EntitlementCacheMS: 0 }, Admin: { Routes: true } }
							}, (pError) => { return fDone(pError); });
					});

				suiteTeardown(
					(fDone) =>
					{
						return _Harness ? _Harness.stop(fDone) : fDone();
					});

				test('L2: without MaterialIntake.read the root is 404 (exactly an unknown entity\'s answer), a hop is 403, label keys stay unlabeled, Describe does not list it; ExcludeEntities stay readable; a UserAction deny wins over a role grant (§77.2)',
					function (fDone)
					{
						this.timeout(30000);
						_Harness.facet('NoSuchEntity', { Facets: [ { Key: 'S', Facet: 'NoSuchEntity.Status' } ] }, 'Newbie',
							(pUnknownError, pUnknown) =>
							{
								_Harness.facet('MaterialIntake', e3bBody(), 'Newbie',
									(pRootError, pRoot) =>
									{
										Expect(pRoot.Status).to.equal(404);
										Expect(pRoot.JSON).to.deep.equal(pUnknown.JSON);
										let tmpBody = { Facets: [ { Key: 'Hop', Facet: 'MaterialIntakeRequirement.MyFormsToDo' }, { Key: 'Path', Facet: 'MaterialIntakeRequirement.IDMaterialIntake>MaterialIntake.Status' }, { Key: 'NoPath', Facet: 'MaterialIntakeRequirement.IDNowhere>Nowhere.Status' }, { Key: 'Label', Facet: 'MaterialIntakeRequirement.IDMaterialIntake', Top: 50 }, { Key: 'Type', Facet: 'MaterialIntakeRequirement.IDLabFormType' } ], Total: true };
										_Harness.facet('MaterialIntakeRequirement', tmpBody, 'Newbie',
											(pHopError, pHop) =>
											{
												Expect(pHop.Status, pHop.Text).to.equal(200);
												// A declared facet's own hop through MaterialIntake: that facet is 403 (Tech gets it).
												Expect(pHop.JSON.Errors.Hop).to.include({ Code: 'FACET_FORBIDDEN', Status: 403 });
												// An ad-hoc path into it is refused exactly like a path to an entity that does not exist.
												let fStrip = (pEntry) => { let tmpCopy = JSON.parse(JSON.stringify(pEntry)); delete tmpCopy.Detail; return tmpCopy; };
												Expect(fStrip(pHop.JSON.Errors.Path)).to.deep.equal(fStrip(pHop.JSON.Errors.NoPath));
												Expect(pHop.JSON.Facets.Label.Buckets.length).to.be.above(0);
												pHop.JSON.Facets.Label.Buckets.forEach((pBucket) => { Expect(pBucket.LabelResolved).to.not.equal(true); });
												// LabFormType is in ExcludeEntities: readable without a LabFormType.read grant.
												Expect(pHop.JSON.Facets.Type.Buckets.some((pBucket) => { return pBucket.LabelResolved === true; })).to.equal(true);
												_Harness.describe(null, 'Newbie',
													(pDescribeError, pDescribe) =>
													{
														Expect(pDescribe.Status).to.equal(200);
														Expect(pDescribe.JSON.Entities).to.not.have.property('MaterialIntake');
														Expect(pDescribe.JSON.Entities).to.include.keys('MaterialIntakeRequirement', 'LabFormType');
														Expect(JSON.stringify(pDescribe.JSON)).to.not.contain('ReceivedDate');
														eachSeries([ [ 'Tech', 200 ], [ 'Newbie', 403 ] ],
															(pCase, fNext) =>
															{
																// A join clause naming MaterialIntake fails the whole request (a request-level entity).
																_Harness.facet('MaterialIntakeRequirement', { Clauses: [ { Type: 'InternalJoinSelectedValueList', RemoteTable: 'MaterialIntake', JoinInternalConnectionColumn: 'IDMaterialIntake', JoinExternalConnectionColumn: 'IDMaterialIntake', Values: [ 1 ], FilterKey: 'IDMaterialIntake', Hash: 'Intake-IJ-1' } ], Facets: [ { Key: 'Type', Facet: 'MaterialIntakeRequirement.IDLabFormType' } ] }, pCase[0],
																	(pJoinError, pJoin) =>
																	{
																		Expect(pJoin.Status, `join as ${pCase[0]}`).to.equal(pCase[1]);
																		return fNext();
																	});
															}, () => { fDenyCheck(); });
														let fDenyCheck = () => eachSeries([ [ 'Colleague', 404 ], [ 'Tech', 200 ] ],
															(pCase, fNext) =>
															{
																_Harness.facet('LabQueue', { Facets: [ { Key: 'Name', Facet: 'LabQueue.Name' } ] }, pCase[0],
																	(pQueueError, pQueue) =>
																	{
																		Expect(pQueue.Status, `LabQueue as ${pCase[0]}`).to.equal(pCase[1]);
																		return fNext();
																	});
															}, fDone);
													});
											});
									});
							});
					});

				test('L3: different role sets in one tenant get different RoleSetHash and separate cache entries (no label leak with Cache.Enabled) (§77.3)',
					function (fDone)
					{
						this.timeout(30000);
						let tmpBody = { Facets: [ { Key: 'Intake', Facet: 'MaterialIntakeRequirement.IDMaterialIntake', Top: 20 } ], Total: true };
						let fLabeled = (pResponse) => { return pResponse.JSON.Facets.Intake.Buckets.filter((pBucket) => { return pBucket.LabelResolved === true; }).length; };
						let _L3Principals = {};
						eachSeries([ 'Tech', 'Newbie' ],
							(pName, fNext) => { _Harness.principalFor(pName, (pError, pPrincipal) => { _L3Principals[pName] = pPrincipal; return fNext(pError); }); },
							() =>
							{
								Expect(_L3Principals.Tech.IDCustomer).to.equal(_L3Principals.Newbie.IDCustomer);
								Expect(_L3Principals.Tech.RoleSetHash).to.not.equal(_L3Principals.Newbie.RoleSetHash);
								_Harness.facet('MaterialIntakeRequirement', tmpBody, 'Tech',
									(pTechError, pTech) =>
									{
										Expect(pTech.Headers['x-retold-facet-cache']).to.equal('Miss');
										Expect(fLabeled(pTech)).to.be.above(0);
										_Harness.facet('MaterialIntakeRequirement', tmpBody, 'Newbie',
											(pNewbieError, pNewbie) =>
											{
												// Not Tech's entry: a Miss of its own, and no label resolved from MaterialIntake.
												Expect(pNewbie.Headers['x-retold-facet-cache']).to.equal('Miss');
												Expect(fLabeled(pNewbie)).to.equal(0);
												Expect(pNewbie.Headers.etag).to.not.equal(pTech.Headers.etag);
												_Harness.facet('MaterialIntakeRequirement', tmpBody, 'Newbie',
													(pAgainError, pAgain) =>
													{
														Expect(pAgain.Headers['x-retold-facet-cache']).to.equal('Hit');
														Expect(fLabeled(pAgain)).to.equal(0);
														_Harness.facet('MaterialIntakeRequirement', tmpBody, 'Tech',
															(pTechAgainError, pTechAgain) =>
															{
																Expect(pTechAgain.Headers['x-retold-facet-cache']).to.equal('Hit');
																Expect(fLabeled(pTechAgain)).to.equal(fLabeled(pTech));
																return fDone();
															});
													});
											});
									});
							});
					});

				test('L4: the platform principal (SystemRole root) passes Admin.authorize, a tenant owner gets 403; root\'s queries stay tenant-scoped (§77.4)',
					function (fDone)
					{
						this.timeout(30000);
						eachSeries([ [ 'Tech', false ], [ 'Root', true ] ],
							(pCase, fNext) =>
							{
								_Harness.principalFor(pCase[0],
									(pError, pPrincipal) =>
									{
										Expect(pPrincipal.Platform, pCase[0]).to.equal(pCase[1]);
										Expect(_Harness.host.isPlatformPrincipal(pPrincipal)).to.equal(pCase[1]);
										_Harness.request('POST', '/1.0/Facet/Admin/Reconcile/ClickHouse/LabForm', { Level: 'Sweep' }, pCase[0],
											(pAdminError, pAdmin) =>
											{
												if (pCase[1])
												{
													// Authorized; this app has no store, so the action itself is refused (not a 403).
													Expect(pAdmin.Status, pAdmin.Text).to.equal(404);
													Expect(pAdmin.JSON.Error.Code).to.equal('FACET_UNKNOWN_ENTITY');
												}
												else
												{
													Expect(pAdmin.Status).to.equal(403);
													Expect(pAdmin.JSON.Error.Code).to.equal('FACET_FORBIDDEN');
												}
												return fNext();
											});
									});
							},
							() =>
							{
								_Harness.facet('MaterialIntake', e3bBody(), 'Root',
									(pRootError, pRoot) =>
									{
										Expect(pRoot.Status, pRoot.Text).to.equal(200);
										Expect(pRoot.JSON.Total).to.equal(_Harness.visibleRows('MaterialIntake', 'Root').length);
										_Harness.assertTenantIsolation('MaterialIntake', MATERIALINTAKE_COLUMN_BODY(), [ 'Root' ], (pIsolationError) => { return fDone(pIsolationError || undefined); });
									});
							});
					});

				test('L2: with EntitlementCacheMS 0 a role granted DAL-direct (Entitlements.grantRole) is reflected on the next request',
					function (fDone)
					{
						this.timeout(30000);
						let libEntitlements = _Harness.server.constructor.Entitlements;
						let tmpNewbie = _Harness.as('Newbie');
						let tmpRoleQuery = _Harness.server.DAL.Role.query.clone().addFilter('Key', 'reader').addFilter('IDCustomer', tmpNewbie.Tenant);
						_Harness.server.DAL.Role.doRead(tmpRoleQuery,
							(pReadError, pQuery, pRole) =>
							{
								Expect(pRole && pRole.IDRole).to.be.above(0);
								libEntitlements.grantRole(_Harness.server, _Harness.entitlements, tmpNewbie.User, pRole.IDRole, tmpNewbie.Tenant,
									(pGrantError) =>
									{
										Expect(pGrantError || null).to.equal(null);
										_Harness.facet('MaterialIntake', e3bBody(), 'Newbie',
											(pError, pResponse) =>
											{
												Expect(pResponse.Status, pResponse.Text).to.equal(200);
												Expect(pResponse.JSON.Total).to.equal(_Harness.visibleRows('MaterialIntake', 'Newbie').length);
												return fDone();
											});
									});
							});
					});
			}
		);

		suite
		(
			`RAFS ${tmpRAFS.Version} app: R10 shutdown (Login, LabTrack; port 19139)`,
			() =>
			{
				let _Harness = null;

				suiteSetup(
					function (fDone)
					{
						this.timeout(60000);
						_Harness = libRAFSHarness.start({ Port: libRAFSHarness.PORTS.Login, Fixture: 'LabTrack', Session: 'Login', Faceting: { SSE: { CoalesceMS: 15 } } }, (pError) => { return fDone(pError); });
					});

				suiteTeardown(
					(fDone) =>
					{
						return _Harness ? _Harness.stop(fDone) : fDone();
					});

				test('R10: fable.Orator.stopService runs the faceting shutdown first: open SSE streams get their closed event and end; the server stops listening',
					function (fDone)
					{
						this.timeout(30000);
						_Harness.openChanges('Tech',
							(pError, pStream) =>
							{
								Expect(pStream.Status).to.equal(200);
								_Harness.openChanges('OtherTech',
									(pOtherError, pOtherStream) =>
									{
										Expect(pOtherStream.Status).to.equal(200);
										_Harness.fable.Orator.stopService(
											() =>
											{
												waitFor(() => { return pStream.Ended && pOtherStream.Ended; }, 5000,
													(pWaitError) =>
													{
														Expect(pWaitError || null).to.equal(null);
														Expect(pStream.events('closed')).to.have.lengthOf(1);
														Expect(pOtherStream.events('closed')).to.have.lengthOf(1);
														Expect(_Harness.fable.OratorServiceServer.server.address()).to.equal(null);
														return fDone();
													}, 'the streams to end');
											});
									});
							});
					});
			}
		);

		suite
		(
			`RAFS ${tmpRAFS.Version} app: host review regressions V1–V3 (Login; role tables NeverFacet, a 60 s entitlement cache, SSE; LabTrack; port 19139)`,
			() =>
			{
				let _Harness = null;
				let tmpStatusBody = () => { return { Facets: [ { Key: 'Status', Facet: 'MaterialIntake.Status' } ], Total: true }; };

				suiteSetup(
					function (fDone)
					{
						this.timeout(60000);
						_Harness = libRAFSHarness.start(
							{
								Port: libRAFSHarness.PORTS.Login,
								Fixture: 'LabTrack',
								Session: 'Login',
								Faceting: { Catalog: { NeverFacet: [ 'Role', 'RoleAction', 'UserRole' ] }, Authorization: { EntitlementCacheMS: 60000 }, SSE: { CoalesceMS: 15 } }
							}, (pError) => { return fDone(pError); });
					});

				suiteTeardown(
					(fDone) =>
					{
						return _Harness ? _Harness.stop(fDone) : fDone();
					});

				test('V1 / V5: a revocation through RAFS\'s own CRUD route on a NON-facetable role table (NeverFacet) reaches the facets at once despite a 60 s cache (the role-table DAL wrap, §79.3), and closes the revoked principal\'s open change stream; the RAFS list and the facet agree (403 / 404)',
					function (fDone)
					{
						this.timeout(30000);
						Expect(_Harness.host.isFacetable('UserRole')).to.equal(false);
						let tmpColleague = _Harness.as('Colleague');
						_Harness.facet('MaterialIntake', tmpStatusBody(), 'Colleague',
							(pBeforeError, pBefore) =>
							{
								// Cached for 60 s from here.
								Expect(pBefore.Status, pBefore.Text).to.equal(200);
								_Harness.openChanges('Colleague',
									(pStreamError, pStream) =>
									{
										Expect(pStream.Status).to.equal(200);
										let tmpQuery = _Harness.server.DAL.UserRole.query.clone().addFilter('IDUser', tmpColleague.User).addFilter('IDCustomer', tmpColleague.Tenant);
										_Harness.server.DAL.UserRole.doReads(tmpQuery,
											(pReadError, pReadQuery, pRows) =>
											{
												Expect(pReadError || null).to.equal(null);
												Expect(pRows.length).to.be.above(0);
												eachSeries(pRows,
													(pRow, fNext) =>
													{
														_Harness.request('DELETE', `/1.0/UserRole/${pRow.IDUserRole}`, null, 'Tech',
															(pDeleteError, pDelete) =>
															{
																Expect(pDelete.Status, pDelete.Text).to.equal(200);
																return fNext();
															});
													},
													(pDeleteError) =>
													{
														if (pDeleteError)
														{
															return fDone(pDeleteError);
														}
														_Harness.request('GET', '/1.0/MaterialIntakes/0/10', null, 'Colleague',
															(pListError, pList) =>
															{
																Expect(pList.Status, 'the RAFS list is 403 now').to.equal(403);
																_Harness.facet('MaterialIntake', tmpStatusBody(), 'Colleague',
																	(pAfterError, pAfter) =>
																	{
																		Expect(pAfter.Status, pAfter.Text).to.equal(404);
																		Expect(pAfter.JSON.Error.Code).to.equal('FACET_UNKNOWN_ENTITY');
																		waitFor(() => { return pStream.Ended; }, 5000,
																			(pWaitError) =>
																			{
																				Expect(pWaitError || null).to.equal(null);
																				Expect(pStream.events('closed').map((pFrame) => { return pFrame.Data.Reason; })).to.deep.equal([ 'Revalidate' ]);
																				return fDone();
																			}, 'the revoked stream to close');
																	});
															});
													});
											});
									});
							});
					});

				test('V2: a DAL-direct grant (Entitlements.grantRole, as an app seed or job does) also invalidates the cache; another principal\'s open stream is revalidated and stays open (same role set)',
					function (fDone)
					{
						this.timeout(30000);
						let libEntitlements = _Harness.server.constructor.Entitlements;
						let tmpColleague = _Harness.as('Colleague');
						_Harness.openChanges('Tech',
							(pStreamError, pTechStream) =>
							{
								Expect(pTechStream.Status).to.equal(200);
								let tmpRoleQuery = _Harness.server.DAL.Role.query.clone().addFilter('Key', 'reader').addFilter('IDCustomer', tmpColleague.Tenant);
								_Harness.server.DAL.Role.doRead(tmpRoleQuery,
									(pReadError, pQuery, pRole) =>
									{
										Expect(pRole && pRole.IDRole).to.be.above(0);
										libEntitlements.grantRole(_Harness.server, _Harness.entitlements, tmpColleague.User, pRole.IDRole, tmpColleague.Tenant,
											(pGrantError) =>
											{
												Expect(pGrantError || null).to.equal(null);
												_Harness.facet('MaterialIntake', tmpStatusBody(), 'Colleague',
													(pError, pResponse) =>
													{
														Expect(pResponse.Status, pResponse.Text).to.equal(200);
														Expect(pResponse.JSON.Total).to.equal(_Harness.visibleRows('MaterialIntake', 'Colleague').length);
														// Tech's rights did not change: revalidated (same principal key), still open.
														setTimeout(
															() =>
															{
																Expect(pTechStream.Ended).to.equal(false);
																Expect(_Harness.fable.RetoldFacetingSSE.stats().Revalidated).to.be.above(0);
																pTechStream.close();
																return fDone();
															}, 100);
													});
											});
									});
							});
					});

				test('V3 (in-process enrichment, §76.2): a session no HTTP request enriched (the Account row, no persona yet) is enriched with RAFS\'s Entitlements.resolveIDUser before the principal is built: the owner scope and the action set are the persona\'s',
					function (fDone)
					{
						this.timeout(30000);
						let tmpTech = _Harness.as('Tech');
						let tmpRecord = Object.assign({}, _Harness.sessionFor('Tech').UserRecord);
						delete tmpRecord.IDUser;
						let tmpSession = { UserRecord: tmpRecord };
						_Harness.service.query('LabForm', { Facets: [ { Key: 'Status', Facet: 'LabForm.Status' } ], Total: true }, { params: {}, headers: {}, query: {}, UserSession: tmpSession },
							(pError, pEnvelope) =>
							{
								Expect(pError || null).to.equal(null);
								Expect(tmpSession.UserRecord.IDUser).to.equal(tmpTech.User);
								Expect(pEnvelope.Total).to.equal(_Harness.visibleRows('LabForm', 'Tech').length);
								return fDone();
							});
					});
			}
		);

		suite
		(
			`RAFS ${tmpRAFS.Version} app: an authenticating app WITHOUT tenancyConfig() — V4 (Login + Entitlements, Tenancy false; LabTrack; port 19139)`,
			() =>
			{
				let _Harness = null;

				suiteSetup(
					function (fDone)
					{
						this.timeout(60000);
						_Harness = libRAFSHarness.start({ Port: libRAFSHarness.PORTS.Login, Fixture: 'LabTrack', Session: 'Login', Tenancy: false, Faceting: { Catalog: { GlobalEntities: [] } } }, (pError) => { return fDone(pError); });
					});

				suiteTeardown(
					(fDone) =>
					{
						return _Harness ? _Harness.stop(fDone) : fDone();
					});

				test('V4: no tenancy pre-handler resolves sessions, so the facet routes resolve the cookie session through RAFS\'s own OratorAuthentication and enrich it: a logged-in user facets as itself (its entitlements apply), anonymous is 401 on every route, an ExcludeEntities entity included (06 §5.1 rule 5)',
					function (fDone)
					{
						this.timeout(30000);
						Expect(_Harness.host.tenancyCoverage('MaterialIntake')).to.equal('None');
						Expect(_Harness.host.authenticationRequired()).to.equal(true);
						let tmpBody = { Facets: [ { Key: 'Status', Facet: 'MaterialIntake.Status' } ], Total: true };
						_Harness.facet('MaterialIntake', tmpBody, 'Tech',
							(pError, pResponse) =>
							{
								Expect(pResponse.Status, pResponse.Text).to.equal(200);
								// Without tenancy RAFS's own list answers every caller over every tenant's rows; the facet
								// as Tech (who holds MaterialIntake.read) equals it.
								_Harness.listCount('MaterialIntake', null, 'Tech',
									(pCountError, pCount) =>
									{
										Expect(pCountError).to.equal(null);
										Expect(pResponse.JSON.Total).to.equal(pCount);
										_Harness.principalFor('Tech',
											(pPrincipalError, pPrincipal) =>
											{
												Expect(pPrincipalError || null).to.equal(null);
												Expect(pPrincipal.Kind).to.equal('User');
												Expect(pPrincipal.RoleSetHash).to.match(/^r:[0-9a-f]{12}$/);
												let tmpRoutes = [ [ 'POST', '/1.0/Facet/MaterialIntake/Query', tmpBody ], [ 'POST', '/1.0/Facet/LabFormType/Query', { Total: true } ], [ 'POST', '/1.0/Facet/MaterialIntake/Keys', {} ], [ 'GET', '/1.0/Facet/Describe', null ] ];
												eachSeries(tmpRoutes,
													(pRoute, fNext) =>
													{
														_Harness.request(pRoute[0], pRoute[1], pRoute[2], null,
															(pAnonymousError, pAnonymous) =>
															{
																Expect(pAnonymous.Status, `${pRoute[1]} anonymous`).to.equal(401);
																Expect(pAnonymous.JSON.Error.Code).to.equal('FACET_UNAUTHENTICATED');
																return fNext();
															});
													}, fDone);
											});
									});
							});
					});
			}
		);

		suite
		(
			`RAFS ${tmpRAFS.Version} app: coverage that changes between the phases — V6 (Header; no late mounts; an app route installer guards ProbeExcluded; port 19138)`,
			() =>
			{
				let _Harness = null;

				suiteSetup(
					function (fDone)
					{
						this.timeout(60000);
						_Harness = libRAFSHarness.start(
							{
								Port: libRAFSHarness.PORTS.Header,
								Fixture: 'LabTrack',
								Session: 'Header',
								LateMounts: [],
								// An app route installer between the phases puts RAFS's own tenancy layer on an excluded table.
								BeforeListen: (pHarness) =>
								{
									let libTenancy = pHarness.server.constructor.Tenancy;
									libTenancy.installTenancyBehaviors(pHarness.server.Endpoints.ProbeExcluded, [ { Column: 'IDCustomer', getValue: (pSession) => { return (pSession && pSession.UserRecord) ? (pSession.UserRecord.IDCustomer || 0) : 0; } } ]);
								}
							}, (pError) => { return fDone(pError); });
					});

				suiteTeardown(
					(fDone) =>
					{
						return _Harness ? _Harness.stop(fDone) : fDone();
					});

				test('V6: the route phase re-classifies ProbeExcluded Installed and the catalog, the intake and the cache follow (no late mount needed): it facets as each tenant exactly as its now-guarded RAFS list',
					function (fDone)
					{
						this.timeout(30000);
						Expect(_Harness.host.tenancyCoverage('ProbeExcluded')).to.equal('Installed');
						Expect(!!_Harness.fable.RetoldFacetingCatalog.getFacetable('ProbeExcluded')).to.equal(true);
						Expect(_Harness.fable.RetoldFacetingChangeIntake.covers('ProbeExcluded')).to.equal(true);
						eachSeries([ 'Tech', 'OtherTech' ],
							(pName, fNext) =>
							{
								_Harness.facet('ProbeExcluded', { Facets: [ { Key: 'Name', Facet: 'ProbeExcluded.Name' } ], Total: true }, pName,
									(pError, pResponse) =>
									{
										Expect(pResponse.Status, pResponse.Text).to.equal(200);
										_Harness.listCount('ProbeExcluded', null, pName,
											(pCountError, pCount) =>
											{
												Expect(pCountError).to.equal(null);
												Expect(pResponse.JSON.Total, pName).to.equal(pCount);
												Expect(pCount).to.be.above(0);
												return fNext();
											});
									});
							}, fDone);
					});
			}
		);

		if (!PG_GATE.Available)
		{
			suite
			(
				`RAFS ${tmpRAFS.Version} app on PostgreSQL: E1 / E2 (ProjectTrack, Login)`,
				() =>
				{
					test(`skipped: ${PG_GATE.Reason}`);
				}
			);
		}
		else
		{
			suite
			(
				`RAFS ${tmpRAFS.Version} app on PostgreSQL: E1 / E2 as authenticated users in two tenants (ProjectTrack, Login, rfs-test-postgres)`,
				() =>
				{
					let _Harness = null;

					suiteSetup(
						function (fDone)
						{
							this.timeout(180000);
							_Harness = libRAFSHarness.start({ Port: libRAFSHarness.PORTS.Login, Fixture: 'ProjectTrack', Session: 'Login', Provider: 'PostgreSQL' }, (pError) => { return fDone(pError); });
						});

					suiteTeardown(
						function (fDone)
						{
							this.timeout(60000);
							return _Harness ? _Harness.stop(fDone) : fDone();
						});

					test('P1: E1 and E2 as Lead and OtherLead on the PostgreSQL dialect: O1, O2, isolation; tenant 0 and anonymous 401',
						function (fDone)
						{
							this.timeout(120000);
							let tmpCases = [];
							[ 'Lead', 'OtherLead' ].forEach((pName) => { tmpCases.push([ 'Project', e1Body(_Harness.traps), pName ], [ 'Document', e2Body(_Harness.traps), pName ]); });
							eachSeries(tmpCases,
								(pCase, fNext) =>
								{
									checkMotivating(_Harness, pCase[0], pCase[1], pCase[2],
										(pError, pResult) =>
										{
											if (pError)
											{
												return fNext(pError);
											}
											Expect(pResult.Live.Engine).to.equal('Live');
											return fNext();
										});
								},
								(pError) =>
								{
									if (pError)
									{
										return fDone(pError);
									}
									eachSeries([ [ 'Project', e1Body(_Harness.traps) ], [ 'Document', e2Body(_Harness.traps) ] ],
										(pCase, fNext) => { _Harness.assertTenantIsolation(pCase[0], pCase[1], [ 'Lead', 'OtherLead' ], (pIsolationError) => { return fNext(pIsolationError || null); }); },
										(pIsolationError) =>
										{
											if (pIsolationError)
											{
												return fDone(pIsolationError);
											}
											assertUnauthenticated(_Harness, 'Project', e1Body(_Harness.traps), fDone);
										});
								});
						});
				}
			);
		}

		if (!CH_GATE.Available)
		{
			suite
			(
				`RAFS ${tmpRAFS.Version} app with the ClickHouse store`,
				() =>
				{
					test(`skipped: ${CH_GATE.Reason}`);
				}
			);
			return;
		}

		suite
		(
			`RAFS ${tmpRAFS.Version} app with the ClickHouse store: E3A / E3B answer from ClickHouse equal to Live (Login, LabTrack, rfs-test-clickhouse)`,
			() =>
			{
				let _Harness = null;

				suiteSetup(
					function (fDone)
					{
						this.timeout(180000);
						_Harness = libRAFSHarness.start({ Port: libRAFSHarness.PORTS.Login, Fixture: 'LabTrack', Session: 'Login', Store: 'ClickHouse', Faceting: { Admin: { Routes: true } } }, (pError) => { return fDone(pError); });
					});

				suiteTeardown(
					function (fDone)
					{
						this.timeout(60000);
						return _Harness ? _Harness.stop(fDone) : fDone();
					});

				test('the materializer mirrored the RAFS app\'s facetable entities through the RAFS host; E3A, E3B and the column bodies as Tech and OtherTech: ClickHouse == Live == Reference, every facet answered by the store',
					function (fDone)
					{
						this.timeout(120000);
						let tmpCases = [];
						[ 'Tech', 'OtherTech', 'Colleague' ].forEach(
							(pName) =>
							{
								tmpCases.push([ 'MaterialIntakeRequirement', e3aBody(), pName ], [ 'MaterialIntake', e3bBody(), pName ], [ 'LabForm', LABFORM_COLUMN_BODY(), pName ], [ 'MaterialIntake', MATERIALINTAKE_COLUMN_BODY(), pName ]);
							});
						eachSeries(tmpCases,
							(pCase, fNext) =>
							{
								assertStoreEqualsLive(_Harness, pCase[0], pCase[1], pCase[2], (pError) => { return fNext(pError || null); });
							}, fDone);
					});

				test('over HTTP with the default Freshness (Exact): the facets answer from ClickHouse with the numbers of Engine \'Live\'; a RAFS CRUD write is materialized and the store agrees again',
					function (fDone)
					{
						this.timeout(120000);
						let tmpBody = LABFORM_COLUMN_BODY();
						_Harness.facet('LabForm', tmpBody, 'Tech',
							(pError, pStore) =>
							{
								Expect(pStore.Status, pStore.Text).to.equal(200);
								Object.keys(pStore.JSON.Facets).forEach((pKey) => { Expect(pStore.JSON.Facets[pKey].Engine, pKey).to.equal('ClickHouse'); });
								_Harness.facet('LabForm', Object.assign({}, tmpBody, { Engine: 'Live' }), 'Tech',
									(pLiveError, pLive) =>
									{
										Expect(libFacetEnvelope.normalizeForComparison(pStore.JSON)).to.deep.equal(libFacetEnvelope.normalizeForComparison(pLive.JSON));
										let tmpRow = _Harness.visibleRows('LabForm', 'Tech').find((pEntry) => { return pEntry.Status === 'Pending'; });
										_Harness.request('PUT', '/1.0/LabForm', { IDLabForm: tmpRow.IDLabForm, Status: 'Complete' }, 'Tech',
											(pWriteError, pWrite) =>
											{
												Expect(pWrite.Status, pWrite.Text).to.equal(200);
												_Harness.quiesce(
													(pQuiesceError) =>
													{
														Expect(pQuiesceError || null).to.equal(null);
														assertStoreEqualsLive(_Harness, 'LabForm', tmpBody, 'Tech',
															(pCompareError, pResult) =>
															{
																if (pCompareError)
																{
																	return fDone(pCompareError);
																}
																let fCount = (pEnvelope) => { let tmpBucket = pEnvelope.Facets.Status.Buckets.find((pEntry) => { return pEntry.Key === 'Complete'; }); return tmpBucket ? tmpBucket.Count : 0; };
																Expect(fCount(pResult.Store)).to.equal(fCount(pLive.JSON) + 1);
																_Harness.request('PUT', '/1.0/LabForm', { IDLabForm: tmpRow.IDLabForm, Status: 'Pending' }, 'Tech', () => { _Harness.quiesce(() => { return fDone(); }); });
															});
													});
											});
									});
							});
					});

				test('L4 with a store: the platform principal\'s Admin reconcile is accepted (202), a tenant owner\'s is 403',
					function (fDone)
					{
						this.timeout(30000);
						_Harness.request('POST', '/1.0/Facet/Admin/Reconcile/ClickHouse/LabForm', { Level: 'Sweep' }, 'Tech',
							(pError, pTech) =>
							{
								Expect(pTech.Status).to.equal(403);
								_Harness.request('POST', '/1.0/Facet/Admin/Reconcile/ClickHouse/LabForm', { Level: 'Sweep' }, 'Root',
									(pRootError, pRoot) =>
									{
										Expect(pRoot.Status, pRoot.Text).to.equal(202);
										Expect(pRoot.JSON).to.include({ Started: true, Action: 'Sweep', Store: 'ClickHouse', Entity: 'LabForm' });
										_Harness.quiesce(() => { return fDone(); });
									});
							});
					});
			}
		);

		suite
		(
			`RAFS ${tmpRAFS.Version} app with the ClickHouse store: E1 / E2 answer from ClickHouse equal to Live (Login, ProjectTrack, rfs-test-clickhouse)`,
			() =>
			{
				let _Harness = null;

				suiteSetup(
					function (fDone)
					{
						this.timeout(180000);
						_Harness = libRAFSHarness.start({ Port: libRAFSHarness.PORTS.Login, Fixture: 'ProjectTrack', Session: 'Login', Store: 'ClickHouse' }, (pError) => { return fDone(pError); });
					});

				suiteTeardown(
					function (fDone)
					{
						this.timeout(60000);
						return _Harness ? _Harness.stop(fDone) : fDone();
					});

				test('E1 and E2 as Lead, Member and OtherLead: ClickHouse == Live == Reference, every facet answered by the store',
					function (fDone)
					{
						this.timeout(120000);
						let tmpCases = [];
						[ 'Lead', 'Member', 'OtherLead' ].forEach((pName) => { tmpCases.push([ 'Project', e1Body(_Harness.traps), pName ], [ 'Document', e2Body(_Harness.traps), pName ]); });
						eachSeries(tmpCases,
							(pCase, fNext) =>
							{
								assertStoreEqualsLive(_Harness, pCase[0], pCase[1], pCase[2], (pError) => { return fNext(pError || null); });
							}, fDone);
					});
			}
		);
	}
);
