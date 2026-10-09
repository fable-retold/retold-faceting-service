/**
 * Facet-Motivating-Queries (wiring; internal-contracts §31.5, §34): the three motivating queries of
 * design 08 end to end — over HTTP, through the real pipeline (DefinitionRegistry loaded at attach →
 * Binder → FilterAST → Planner → Live / Reference → envelope, and the Records / Count / Keys routes):
 *
 *   E1  "all the projects for this user based on this complex criteria" (ProjectTrack, Project):
 *       the MyProjects / HasMyOverdue / Unblocked scopes, a Status clause, an InternalJoin to Client
 *       and a StartDate window; Status, Client, Started, the MyOverdueBand ChildRollup and the
 *       Status × Client pivot; Records sorted by StartDate DESC;
 *   E2  "the documents of this form type, bucketed by month" (ProjectTrack, Document);
 *   E3  "the lab forms I still have to fill out for my queues' intakes" (LabTrack): variant A over
 *       stored requirements with the co-reference anti-join (TenantOnly), variant B as a TuplePivot.
 *
 * For each, as every principal of the domain:
 *
 *   - O1: Live == Reference (in-process, the pinned Now), and the HTTP Live envelope == the in-process one;
 *   - O-hand: every count equals an oracle computed in JS over the seed's own rows, written from the
 *     definitions' prose (each hop visible to the principal: live, same tenant, LabForm owned unless
 *     the step is TenantOnly), independent of both engines and of the database;
 *   - O2: every bucket Clause round-trips (counted through the Reference: the bodies are scoped);
 *   - Records == the set the facets count (the Keys route, the Records/Count route, full pages), in
 *     the requested order, through the pict FilterEndpointOverride shapes for E3A;
 *   - per-hop two-tenant isolation, the LabForm owner scope and the TenantOnly relaxation, the
 *     cross-tenant and soft-deleted traps of every hop.
 *
 * Plus the request-level wiring: Versions differ across principals of one tenant (BindHash), an unset
 * $CurrentUser is 401, a client '$Now' is a literal, and the per-entity gate (403 whole request for a
 * scope / join entity, per facet for a definition's hop or tuple side, unlabelled keys for a label
 * target).
 *
 * SQLite always; PostgreSQL too when RFS_TEST_POSTGRES=1 (or RFS_TEST_POSTGRES_URL) is set
 * (`npm run test:pg`).
 *
 * Port 19126 (internal-contracts §32.4); every harness binds an ephemeral port.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libHarness = require('./support/Facet-Test-Harness.js');
const libProviders = require('./support/Facet-Harness-Providers.js');
const libFacetBuckets = require('../source/contract/Facet-Contract-Buckets.js');
const libFacetEnvelope = require('../source/contract/Facet-Contract-Envelope.js');

const PORT = 19126;

// The pinned request clock and the $Now it binds (floored to Cache.NowBucketMS = 1 minute).
const TEST_NOW = '2026-10-08T12:00:00Z';
const NOW = '2026-10-08 12:00:00';

const E1_ROLES = [ 'Owner', 'Lead' ];
const E1_STATUSES = [ 'Active', 'AtRisk' ];
const E1_START = '2026-01-01 00:00:00';
const E1_END = '2027-01-01 00:00:00';
const E2_START = '2026-01-01 00:00:00';
const E2_END = '2026-07-01 00:00:00';
const E3_INTAKE_STATUSES = [ 'Received', 'InProgress' ];

// ---------------------------------------------------------------------------------- request bodies

const e1Body = (pTraps) =>
{
	return (
		{
			Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: E1_ROLES.slice() } }, { Scope: 'Project.HasMyOverdue' }, { Scope: 'Project.Unblocked' } ],
			Clauses:
				[
					{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: E1_STATUSES.slice(), FilterKey: 'Status', Hash: 'Status-DSVL-1' },
					{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', JoinExternalConnectionColumn: 'IDClient', Values: pTraps.E1ClientIDs.slice(), FilterKey: 'IDClient', Hash: 'IDClient-IJ-1' },
					{ Type: 'DateRange', FilterByColumn: 'StartDate', Values: { Start: E1_START, End: E1_END }, EndExclusive: true, FilterKey: 'StartDate', Hash: 'StartDate-DR-1' }
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
					{ Type: 'DateRange', FilterByColumn: 'DocumentDate', Values: { Start: E2_START, End: E2_END }, EndExclusive: true, FilterKey: 'DocumentDate', Hash: 'DocumentDate-DR-1' }
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

const clone = (pValue) =>
{
	return JSON.parse(JSON.stringify(pValue));
};

// ---------------------------------------------------------------------------------- the JS oracle

/**
 * The fixture rows a principal sees through each entity's own list (the domain policy, internal-
 * contracts §31.2): live (Deleted = 0) where the table has a delete column, the principal's tenant
 * where it has IDCustomer, and — LabForm — the principal's own forms unless the hop is TenantOnly.
 */
class DomainOracle
{
	/**
	 * @param {Record<string, Array<Record<string, any>>>} pRows - seed.Rows
	 * @param {{ Tenant: number, User: number }} pPrincipal
	 */
	constructor(pRows, pPrincipal)
	{
		this.Rows = pRows;
		this.Tenant = pPrincipal.Tenant;
		this.User = pPrincipal.User;
		this._Visible = {};
	}

	/**
	 * @param {string} pTable
	 * @param {string} [pScope] - 'Inherit' (default) | 'TenantOnly'
	 * @return {Array<Record<string, any>>}
	 */
	visible(pTable, pScope)
	{
		let tmpKey = `${pTable}|${pScope || 'Inherit'}`;
		if (this._Visible[tmpKey])
		{
			return this._Visible[tmpKey];
		}
		let tmpRows = (this.Rows[pTable] || []).filter(
			(pRow) =>
			{
				if (Object.prototype.hasOwnProperty.call(pRow, 'Deleted') && (pRow.Deleted !== 0))
				{
					return false;
				}
				if (Object.prototype.hasOwnProperty.call(pRow, 'IDCustomer') && (pRow.IDCustomer !== this.Tenant))
				{
					return false;
				}
				if ((pTable === 'LabForm') && (pScope !== 'TenantOnly') && (pRow.OwnerIDUser !== this.User))
				{
					return false;
				}
				return true;
			});
		this._Visible[tmpKey] = tmpRows;
		return tmpRows;
	}

	/**
	 * The visible row of pTable whose pColumn equals pValue (to-one hops), or null.
	 */
	one(pTable, pColumn, pValue)
	{
		if ((pValue === null) || (typeof(pValue) === 'undefined'))
		{
			return null;
		}
		return this.visible(pTable).find((pRow) => { return pRow[pColumn] === pValue; }) || null;
	}

	// ---------------------------------------------------------------- E1

	myOverdue(pProject)
	{
		return this.visible('Task').filter(
			(pTask) =>
			{
				return (pTask.IDProject === pProject.IDProject) && (pTask.AssignedIDUser === this.User)
					&& (typeof(pTask.DueDate) === 'string') && (pTask.DueDate < NOW)
					&& (typeof(pTask.Status) === 'string') && (pTask.Status !== 'Done');
			}).length;
	}

	isMine(pProject)
	{
		let tmpMember = this.visible('ProjectMembership').some(
			(pMembership) =>
			{
				return (pMembership.IDProject === pProject.IDProject) && (pMembership.IDUser === this.User)
					&& (E1_ROLES.indexOf(pMembership.Role) >= 0) && (pMembership.Active === 1);
			});
		return tmpMember || (pProject.OwnerIDUser === this.User);
	}

	isUnblocked(pProject)
	{
		return !this.visible('Issue').some((pIssue) => { return (pIssue.IDProject === pProject.IDProject) && (pIssue.Severity === 'Blocker') && (pIssue.State === 'Open'); });
	}

	/**
	 * E1's rows, optionally without one of its three clauses (a facet's own, excluded).
	 *
	 * @param {Array<number>} pClients - Traps.E1ClientIDs
	 * @param {{ Status?: boolean, Client?: boolean, Start?: boolean }} pKeep
	 * @return {Array<Record<string, any>>}
	 */
	e1(pClients, pKeep)
	{
		let tmpKeep = pKeep || {};
		return this.visible('Project').filter(
			(pProject) =>
			{
				if ((tmpKeep.Status !== false) && (E1_STATUSES.indexOf(pProject.Status) < 0))
				{
					return false;
				}
				if ((tmpKeep.Client !== false) && !(this.one('Client', 'IDClient', pProject.IDClient) && (pClients.indexOf(pProject.IDClient) >= 0)))
				{
					return false;
				}
				if ((tmpKeep.Start !== false) && !((typeof(pProject.StartDate) === 'string') && (pProject.StartDate >= E1_START) && (pProject.StartDate < E1_END)))
				{
					return false;
				}
				return this.isMine(pProject) && (this.myOverdue(pProject) >= 1) && this.isUnblocked(pProject);
			});
	}

	// ---------------------------------------------------------------- E2

	e2(pFormTypeID, pKeep)
	{
		let tmpKeep = pKeep || {};
		return this.visible('Document').filter(
			(pDocument) =>
			{
				if ((tmpKeep.Form !== false) && !((pDocument.IDFormType === pFormTypeID) && this.one('FormType', 'IDFormType', pDocument.IDFormType)))
				{
					return false;
				}
				if ((tmpKeep.Window !== false) && !((typeof(pDocument.DocumentDate) === 'string') && (pDocument.DocumentDate >= E2_START) && (pDocument.DocumentDate < E2_END)))
				{
					return false;
				}
				return true;
			});
	}

	// ---------------------------------------------------------------- E3

	inMyQueues(pIntake)
	{
		if (!pIntake || (E3_INTAKE_STATUSES.indexOf(pIntake.Status) < 0))
		{
			return false;
		}
		let tmpQueue = this.one('LabQueue', 'IDLabQueue', pIntake.IDLabQueue);
		return !!tmpQueue && this.visible('LabQueueMember').some(
			(pMember) =>
			{
				return (pMember.IDLabQueue === tmpQueue.IDLabQueue) && (pMember.IDUser === this.User) && (pMember.Active === 1);
			});
	}

	/**
	 * Is (intake, form type) completed by anyone in my lab (TenantOnly) — or, pAnyOwner false, by me?
	 */
	completed(pIntakeID, pFormTypeID, pAnyOwner)
	{
		return this.visible('LabForm', (pAnyOwner === false) ? 'Inherit' : 'TenantOnly').some(
			(pForm) =>
			{
				return (pForm.IDMaterialIntake === pIntakeID) && (pForm.IDLabFormType === pFormTypeID) && (pForm.Status === 'Complete');
			});
	}

	/**
	 * E3 variant A: my requirements still to do.
	 *
	 * @param {boolean} [pAnyOwner] - false: only my own completed forms count (what TenantOnly fixes)
	 * @return {Array<Record<string, any>>}
	 */
	e3a(pAnyOwner)
	{
		return this.visible('MaterialIntakeRequirement').filter(
			(pRequirement) =>
			{
				let tmpIntake = this.one('MaterialIntake', 'IDMaterialIntake', pRequirement.IDMaterialIntake);
				return this.inMyQueues(tmpIntake) && !this.completed(pRequirement.IDMaterialIntake, pRequirement.IDLabFormType, pAnyOwner);
			});
	}

	started(pRequirement)
	{
		return this.visible('LabForm').some(
			(pForm) =>
			{
				return (pForm.IDMaterialIntake === pRequirement.IDMaterialIntake) && (pForm.IDLabFormType === pRequirement.IDLabFormType)
					&& (typeof(pForm.Status) === 'string') && (pForm.Status !== 'Complete');
			});
	}

	/**
	 * E3 variant B: distinct (intake, required form type) tuples still to do.
	 *
	 * @return {Array<{ Intake: Record<string, any>, FormType: number }>}
	 */
	e3b()
	{
		let tmpTuples = new Map();
		let tmpRequirements = this.visible('MaterialTypeFormRequirement').filter((pRequirement) => { return pRequirement.Required === 1; });
		this.visible('MaterialIntake').forEach(
			(pIntake) =>
			{
				if (!this.inMyQueues(pIntake))
				{
					return;
				}
				tmpRequirements.forEach(
					(pRequirement) =>
					{
						if ((pRequirement.IDMaterialType !== pIntake.IDMaterialType) || (pIntake.IDMaterialType === null))
						{
							return;
						}
						if (this.completed(pIntake.IDMaterialIntake, pRequirement.IDLabFormType, true))
						{
							return;
						}
						tmpTuples.set(`${pIntake.IDMaterialIntake}|${pRequirement.IDLabFormType}`, { Intake: pIntake, FormType: pRequirement.IDLabFormType });
					});
			});
		return Array.from(tmpTuples.values());
	}
}

/**
 * Group rows by a key function: { Counts: Map String(key) → count, Missing: rows whose key is null }.
 *
 * @param {Array<any>} pRows
 * @param {(pRow: any) => any} fKey
 * @return {{ Counts: Map<string, number>, Missing: number }}
 */
const groupBy = (pRows, fKey) =>
{
	let tmpCounts = new Map();
	let tmpMissing = 0;
	pRows.forEach(
		(pRow) =>
		{
			let tmpKey = fKey(pRow);
			if ((tmpKey === null) || (typeof(tmpKey) === 'undefined'))
			{
				tmpMissing++;
				return;
			}
			tmpCounts.set(String(tmpKey), (tmpCounts.get(String(tmpKey)) || 0) + 1);
		});
	return { Counts: tmpCounts, Missing: tmpMissing };
};

/**
 * A bucketed FacetResult equals a grouping: every non-empty bucket has the oracle's count, every
 * oracle key has a bucket, and MissingCount matches.
 *
 * @param {Record<string, any>} pFacet - FacetResult
 * @param {{ Counts: Map<string, number>, Missing: number }} pExpected
 * @param {string} pLabel
 */
const expectBuckets = (pFacet, pExpected, pLabel) =>
{
	Expect(pFacet, `${pLabel}: facet result`).to.be.an('object');
	let tmpActual = new Map();
	(pFacet.Buckets || []).forEach((pBucket) => { if (pBucket.Count > 0) { tmpActual.set(String(pBucket.Key), pBucket.Count); } });
	Expect(Object.fromEntries(tmpActual), `${pLabel}: bucket counts`).to.deep.equal(Object.fromEntries(pExpected.Counts));
	Expect(pFacet.MissingCount, `${pLabel}: MissingCount`).to.equal(pExpected.Missing);
};

const monthKey = (pValue) =>
{
	return (typeof(pValue) === 'string') ? libFacetBuckets.dateKey(pValue, 'month') : null;
};

const weekKey = (pValue) =>
{
	return (typeof(pValue) === 'string') ? libFacetBuckets.dateKey(pValue, 'week') : null;
};

const band = (pCount) =>
{
	return (pCount < 1) ? 0 : (pCount < 3) ? 1 : (pCount < 10) ? 2 : 3;
};

/**
 * Sort projects as E1's Records ask: StartDate DESC with NULLs last, the primary key ascending.
 */
const e1RecordOrder = (pA, pB) =>
{
	let tmpA = (typeof(pA.StartDate) === 'string') ? pA.StartDate : null;
	let tmpB = (typeof(pB.StartDate) === 'string') ? pB.StartDate : null;
	if ((tmpA === null) !== (tmpB === null))
	{
		return (tmpA === null) ? 1 : -1;
	}
	if ((tmpA !== null) && (tmpA !== tmpB))
	{
		return (tmpA < tmpB) ? 1 : -1;
	}
	return pA.IDProject - pB.IDProject;
};

const ids = (pRows, pColumn) =>
{
	return pRows.map((pRow) => { return pRow[pColumn]; });
};

const sortedNumbers = (pValues) =>
{
	return pValues.slice().map(Number).sort((pA, pB) => { return pA - pB; });
};

// ---------------------------------------------------------------------------------- suites

const POSTGRES = libProviders.available('PostgreSQL');

const PROVIDERS =
	[
		{ Provider: 'SQLite', Ready: true, Reason: null },
		{ Provider: 'PostgreSQL', Ready: POSTGRES.Available, Reason: POSTGRES.Reason }
	];

suite
(
	'Facet-Motivating-Queries',
	() =>
	{
		PROVIDERS.forEach(
			(pProvider) =>
			{
				(pProvider.Ready ? suite : suite.skip)
				(
					`${pProvider.Provider}${pProvider.Ready ? '' : ` (skipped: ${pProvider.Reason})`}`,
					function ()
					{
						this.timeout(120000);

						let _ProjectTrack = null;
						let _LabTrack = null;

						suiteSetup((fDone) =>
						{
							_ProjectTrack = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Provider: pProvider.Provider },
								(pError) =>
								{
									if (pError)
									{
										return fDone(pError);
									}
									_LabTrack = libHarness.start({ Port: PORT, Fixture: 'LabTrack', Provider: pProvider.Provider },
										(pLabError) =>
										{
											return fDone(pLabError || undefined);
										});
								});
						});

						suiteTeardown((fDone) =>
						{
							let fStopLab = () => { return _LabTrack ? _LabTrack.stop(() => { fDone(); }) : fDone(); };
							return _ProjectTrack ? _ProjectTrack.stop(fStopLab) : fStopLab();
						});

						let fOracle = (pHarness, pName) =>
						{
							return new DomainOracle(pHarness.seed.Rows, pHarness.as(pName));
						};

						/**
						 * HTTP Live as the principal; O1 in-process (pinned Now) and the HTTP envelope equal to
						 * the in-process Live one; then fCheck(pEnvelope, pOracle); then O2 through the Reference.
						 */
						let fConformance = (pHarness, pEntity, pBody, pName, fCheck, fDone) =>
						{
							let tmpPrincipal = pHarness.as(pName);
							let tmpOptions = Object.assign({ Now: TEST_NOW }, tmpPrincipal);
							pHarness.facetQuery(pEntity, pBody, tmpPrincipal,
								(pHTTPError, pHTTP) =>
								{
									Expect(pHTTPError, pName).to.not.exist;
									Expect(pHTTP.Status, `${pName}: ${JSON.stringify(pHTTP.Body).slice(0, 400)}`).to.equal(200);
									Expect(pHTTP.Headers.etag).to.match(/^W\/"fv1:[0-9a-f]{16}"$/);
									Expect(pHTTP.Body.Errors || {}, `${pName}: HTTP errors`).to.deep.equal({});
									pHarness.compareInProcess(pEntity, pBody, tmpOptions,
										(pError, pResult) =>
										{
											Expect(pError, pName).to.not.exist;
											Expect(pResult.Live.Errors || {}, `${pName}: Live errors`).to.deep.equal({});
											Expect(pResult.LiveNormalized, `${pName}: O1 Live == Reference`).to.deep.equal(pResult.ReferenceNormalized);
											Expect(libFacetEnvelope.normalizeForComparison(pHTTP.Body), `${pName}: HTTP == in-process`).to.deep.equal(pResult.LiveNormalized);
											fCheck(pHTTP.Body, fOracle(pHarness, pName));
											pHarness.assertSelectionRoundTrip(pEntity, pBody, pResult.Live, tmpOptions,
												(pRoundTripError, pReport) =>
												{
													Expect(pRoundTripError, `${pName} O2 ${JSON.stringify(pReport && pReport.Mismatches)}`).to.not.exist;
													Expect(pReport.CountVia).to.equal('Reference');
													Expect(pReport.Checked).to.be.above(0);
													return fDone();
												});
										});
								});
						};

						/**
						 * Run fConformance for each principal in turn.
						 */
						let fEachPrincipal = (pHarness, pEntity, pBody, pNames, fCheck, fDone) =>
						{
							let fNext = (pIndex) =>
							{
								if (pIndex >= pNames.length)
								{
									return fDone();
								}
								return fConformance(pHarness, pEntity, pBody, pNames[pIndex], (pEnvelope, pOracle) => { return fCheck(pNames[pIndex], pEnvelope, pOracle); }, () => { return fNext(pIndex + 1); });
							};
							return fNext(0);
						};

						/**
						 * The Keys route and every Records page of a body equal one oracle set (Records == the set
						 * the facets count), and Records/Count equals it too.
						 */
						let fRecordsEqual = (pHarness, pEntity, pBody, pName, pPrimaryKey, pExpectedIDs, fDone) =>
						{
							let tmpPrincipal = pHarness.as(pName);
							let tmpFilter = clone(pBody);
							delete tmpFilter.Facets;
							delete tmpFilter.Records;
							delete tmpFilter.Total;
							let tmpExpected = sortedNumbers(pExpectedIDs);
							pHarness.keys(pEntity, tmpFilter, tmpPrincipal,
								(pKeysError, pKeys) =>
								{
									Expect(pKeysError).to.not.exist;
									Expect(pKeys.Status, JSON.stringify(pKeys.Body)).to.equal(200);
									Expect(pKeys.Body).to.include({ Entity: pEntity, Count: tmpExpected.length, Truncated: false });
									Expect(pKeys.Body.Version).to.match(/^fv1:/);
									Expect(sortedNumbers(pKeys.Body.Keys), `${pName}: Keys`).to.deep.equal(tmpExpected);
									pHarness.recordsCount(pEntity, tmpFilter, tmpPrincipal,
										(pCountError, pCount) =>
										{
											Expect(pCountError).to.not.exist;
											Expect(pCount.Status).to.equal(200);
											Expect(pCount.Body, `${pName}: Records/Count`).to.deep.equal({ Count: tmpExpected.length });
											// Every row, in pages of 7 through the FilterEndpointOverride page form.
											let tmpSeen = [];
											let fPage = (pBegin) =>
											{
												pHarness.recordsPage(pEntity, pBegin, 7, tmpFilter, tmpPrincipal,
													(pPageError, pPage) =>
													{
														Expect(pPageError).to.not.exist;
														Expect(pPage.Status, JSON.stringify(pPage.Body)).to.equal(200);
														Expect(pPage.Body).to.be.an('array');
														tmpSeen = tmpSeen.concat(pPage.Body.map((pRecord) => { return pRecord[pPrimaryKey]; }));
														if (pPage.Body.length === 7)
														{
															return fPage(pBegin + 7);
														}
														Expect(sortedNumbers(tmpSeen), `${pName}: every Records page`).to.deep.equal(tmpExpected);
														Expect(new Set(tmpSeen).size, `${pName}: no record twice`).to.equal(tmpSeen.length);
														return fDone();
													});
											};
											return fPage(0);
										});
								});
						};

						// ============================================================ E1
						suite
						(
							'E1 — projects for this user by complex criteria (ProjectTrack, Project)',
							() =>
							{
								test('O1, O-hand and O2 as Lead, Member, Outsider and OtherLead (every facet, the band rollup, the pivot)',
									function (fDone)
									{
										let tmpTraps = _ProjectTrack.traps;
										let tmpLeadTotal = null;
										fEachPrincipal(_ProjectTrack, 'Project', e1Body(tmpTraps), [ 'Lead', 'Member', 'Outsider', 'OtherLead' ],
											(pName, pEnvelope, pOracle) =>
											{
												let tmpClients = tmpTraps.E1ClientIDs;
												let tmpFull = pOracle.e1(tmpClients, {});
												Expect(pEnvelope.Total, `${pName} Total`).to.equal(tmpFull.length);
												Expect(pEnvelope.Filter.Applied).to.deep.equal(
													[ { Hash: 'Status-DSVL-1' }, { Hash: 'IDClient-IJ-1' }, { Hash: 'StartDate-DR-1' }, { Scope: 'Project.MyProjects' }, { Scope: 'Project.HasMyOverdue' }, { Scope: 'Project.Unblocked' } ]);
												// Each facet excludes exactly its own clause; scopes are never excluded.
												Expect(pEnvelope.Facets.Status.Excluded).to.deep.equal([ 'Status-DSVL-1' ]);
												Expect(pEnvelope.Facets.Client.Excluded).to.deep.equal([ 'IDClient-IJ-1' ]);
												Expect(pEnvelope.Facets.Started.Excluded).to.deep.equal([ 'StartDate-DR-1' ]);
												Expect(pEnvelope.Facets.MyOverdue.Excluded).to.deep.equal([]);
												expectBuckets(pEnvelope.Facets.Status, groupBy(pOracle.e1(tmpClients, { Status: false }), (pRow) => { return pRow.Status; }), `${pName} Status`);
												expectBuckets(pEnvelope.Facets.Client, groupBy(pOracle.e1(tmpClients, { Client: false }), (pRow) => { return pRow.IDClient; }), `${pName} Client`);
												expectBuckets(pEnvelope.Facets.Started, groupBy(pOracle.e1(tmpClients, { Start: false }), (pRow) => { return monthKey(pRow.StartDate); }), `${pName} Started`);
												// The ChildRollup: every band 0…3 zero-filled, 0 empty (HasMyOverdue requires one).
												let tmpBands = groupBy(tmpFull, (pRow) => { return band(pOracle.myOverdue(pRow)); });
												Expect(pEnvelope.Facets.MyOverdue.Fold).to.equal('ChildRollup');
												Expect(pEnvelope.Facets.MyOverdue.Declared).to.equal(true);
												Expect(pEnvelope.Facets.MyOverdue.Buckets.map((pBucket) => { return pBucket.Key; })).to.deep.equal([ 0, 1, 2, 3 ]);
												Expect(pEnvelope.Facets.MyOverdue.Buckets.map((pBucket) => { return pBucket.Label; })).to.deep.equal([ 'None', '1–2', '3–9', '10+' ]);
												pEnvelope.Facets.MyOverdue.Buckets.forEach((pBucket) => { Expect(pBucket.Count, `${pName} band ${pBucket.Key}`).to.equal(tmpBands.Counts.get(String(pBucket.Key)) || 0); });
												// The Status × Client pivot under the full filter.
												let tmpCells = groupBy(tmpFull, (pRow) => { return JSON.stringify([ pRow.Status, pRow.IDClient ]); });
												let tmpActualCells = {};
												(pEnvelope.Facets.StatusByClient.Cells || []).forEach((pCell) => { if (pCell.Count > 0) { tmpActualCells[JSON.stringify(Array.isArray(pCell.Keys) ? pCell.Keys : [ pCell.K1, pCell.K2 ])] = pCell.Count; } });
												Expect(tmpActualCells, `${pName} pivot cells`).to.deep.equal(Object.fromEntries(tmpCells.Counts));
												// Records: the first page of the full filter, StartDate DESC (NULLs last), then the key.
												Expect(pEnvelope.RecordShape).to.equal('Entity');
												Expect(pEnvelope.RecordsDropped).to.equal(0);
												Expect(ids(pEnvelope.Records, 'IDProject'), `${pName} Records order`).to.deep.equal(ids(tmpFull.slice().sort(e1RecordOrder).slice(0, 50), 'IDProject'));
												if (pName === 'Lead')
												{
													tmpLeadTotal = tmpFull.length;
													// The story projects are exactly the E1 answer for Lead.
													Expect(sortedNumbers(ids(tmpFull, 'IDProject'))).to.deep.equal(sortedNumbers(tmpTraps.E1StoryProjectIDs));
													// Every band is populated by the story (08 §2.5).
													[ 1, 2, 3 ].forEach((pBand) => { Expect(tmpBands.Counts.get(String(pBand)), `band ${pBand}`).to.be.above(0); });
												}
											},
											() =>
											{
												Expect(tmpLeadTotal).to.be.above(0);
												return fDone();
											});
									});

								test('Records == the set the facets count: Keys, Records/Count and every page (as Lead and OtherLead)',
									function (fDone)
									{
										let tmpBody = e1Body(_ProjectTrack.traps);
										fRecordsEqual(_ProjectTrack, 'Project', tmpBody, 'Lead', 'IDProject', ids(fOracle(_ProjectTrack, 'Lead').e1(_ProjectTrack.traps.E1ClientIDs, {}), 'IDProject'),
											() =>
											{
												fRecordsEqual(_ProjectTrack, 'Project', tmpBody, 'OtherLead', 'IDProject', ids(fOracle(_ProjectTrack, 'OtherLead').e1(_ProjectTrack.traps.E1ClientIDs, {}), 'IDProject'), fDone);
											});
									});

								test('hops are scoped per entity: a soft-deleted or cross-tenant Blocker never blocks, a live one does; a join to a soft-deleted or cross-tenant client never matches',
									function (fDone)
									{
										let tmpTraps = _ProjectTrack.traps;
										let tmpLead = _ProjectTrack.as('Lead');
										_ProjectTrack.keys('Project', { Scopes: [ { Scope: 'Project.Unblocked' } ] }, tmpLead,
											(pError, pUnblocked) =>
											{
												Expect(pUnblocked.Status).to.equal(200);
												Expect(pUnblocked.Body.Keys).to.not.include(tmpTraps.BlockedProjectID);
												Expect(pUnblocked.Body.Keys).to.include(tmpTraps.DeletedBlockerProjectID);
												Expect(pUnblocked.Body.Keys).to.include(tmpTraps.CrossTenantBlockerProjectID);
												Expect(sortedNumbers(pUnblocked.Body.Keys)).to.deep.equal(sortedNumbers(ids(fOracle(_ProjectTrack, 'Lead').visible('Project').filter((pProject) => { return fOracle(_ProjectTrack, 'Lead').isUnblocked(pProject); }), 'IDProject')));
												let tmpTrapClients = [ tmpTraps.DeletedClientID, tmpTraps.CrossTenantClientID ];
												_ProjectTrack.recordsCount('Project', { Clauses: [ { Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', JoinExternalConnectionColumn: 'IDClient', Values: tmpTrapClients } ] }, tmpLead,
													(pJoinError, pJoin) =>
													{
														Expect(pJoin.Status).to.equal(200);
														Expect(pJoin.Body.Count, 'an InternalJoin needs a VISIBLE client').to.equal(0);
														_ProjectTrack.recordsCount('Project', { Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'IDClient', Values: tmpTrapClients } ] }, tmpLead,
															(pColumnError, pColumn) =>
															{
																Expect(pColumn.Status).to.equal(200);
																Expect(pColumn.Body.Count, 'the column clause still sees the referencing projects').to.be.above(0);
																return fDone();
															});
													});
											});
									});

								test('per-hop two-tenant isolation: every key, label, Keys key and record belongs to the principal\'s tenant (Lead, OtherLead)',
									function (fDone)
									{
										_ProjectTrack.assertTenantIsolation('Project', e1Body(_ProjectTrack.traps), [ 'Lead', 'OtherLead' ],
											(pError, pReport) =>
											{
												Expect(pError, JSON.stringify(pReport && pReport.Mismatches)).to.not.exist;
												Expect(pReport.Principals.Lead.Keys).to.be.above(0);
												return fDone();
											});
									});

								test('Versions: the same request differs across principals of one tenant (BindHash) and is stable for one principal; an unset $CurrentUser is 401; a client \'$Now\' is a literal',
									function (fDone)
									{
										let tmpBody = e1Body(_ProjectTrack.traps);
										delete tmpBody.Records;
										_ProjectTrack.facetQuery('Project', tmpBody, _ProjectTrack.as('Lead'),
											(pError, pLead) =>
											{
												_ProjectTrack.facetQuery('Project', tmpBody, _ProjectTrack.as('Lead'),
													(pAgainError, pAgain) =>
													{
														_ProjectTrack.facetQuery('Project', tmpBody, _ProjectTrack.as('Outsider'),
															(pOutsiderError, pOutsider) =>
															{
																Expect(pLead.Status).to.equal(200);
																Expect(pOutsider.Status).to.equal(200);
																Expect(pAgain.Headers.etag).to.equal(pLead.Headers.etag);
																Expect(pOutsider.Headers.etag).to.not.equal(pLead.Headers.etag);
																// A tenant session without a user (UserID 0, unset): the scopes bind
																// $CurrentUser.IDUser → 401, never "matches nothing".
																_ProjectTrack.facetQuery('Project', tmpBody, { Tenant: 1, User: 0 },
																	(pAnonymousError, pNoUser) =>
																	{
																		Expect(pNoUser.Status).to.equal(401);
																		Expect(pNoUser.Body.Error.Code).to.equal('FACET_UNAUTHENTICATED');
																		Expect(pNoUser.Body.Error).to.not.have.property('Detail');
																		// …whereas E2 binds nothing and answers.
																		_ProjectTrack.facetQuery('Document', e2Body(_ProjectTrack.traps), { Tenant: 1, User: 0 },
																			(pE2Error, pE2) =>
																			{
																				Expect(pE2.Status).to.equal(200);
																				_ProjectTrack.facetQuery('Project', { Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ '$Now' ] } ], Facets: [ { Facet: 'Project.Status' } ] }, _ProjectTrack.as('Lead'),
																					(pLiteralError, pLiteral) =>
																					{
																						Expect(pLiteral.Status).to.equal(200);
																						Expect(pLiteral.Body.Total).to.equal(0);
																						return fDone();
																					});
																			});
																	});
															});
													});
											});
									});
							}
						);

						// ============================================================ E2
						suite
						(
							'E2 — documents of a form type, by month (ProjectTrack, Document)',
							() =>
							{
								test('O1, O-hand and O2 as Lead and OtherLead (ByMonth keeps the form type, ByForm keeps the window, Status keeps both)',
									function (fDone)
									{
										let tmpTraps = _ProjectTrack.traps;
										fEachPrincipal(_ProjectTrack, 'Document', e2Body(tmpTraps), [ 'Lead', 'OtherLead' ],
											(pName, pEnvelope, pOracle) =>
											{
												let tmpFull = pOracle.e2(tmpTraps.E2FormTypeID, {});
												Expect(pEnvelope.Total, `${pName} Total`).to.equal(tmpFull.length);
												expectBuckets(pEnvelope.Facets.ByMonth, groupBy(pOracle.e2(tmpTraps.E2FormTypeID, { Window: false }), (pRow) => { return monthKey(pRow.DocumentDate); }), `${pName} ByMonth`);
												Expect(pEnvelope.Facets.ByMonth.Excluded).to.deep.equal([ 'DocumentDate-DR-1' ]);
												Expect(pEnvelope.Facets.ByMonth.Chart).to.be.an('object');
												expectBuckets(pEnvelope.Facets.ByForm, groupBy(pOracle.e2(tmpTraps.E2FormTypeID, { Form: false }), (pRow) => { return pRow.IDFormType; }), `${pName} ByForm`);
												Expect(pEnvelope.Facets.ByForm.Excluded).to.deep.equal([ 'IDFormType-IJ-1' ]);
												expectBuckets(pEnvelope.Facets.Status, groupBy(tmpFull, (pRow) => { return pRow.Status; }), `${pName} Status`);
												// The selected form type is marked Selected; its label comes from the global lookup.
												let tmpSelected = pEnvelope.Facets.ByForm.Buckets.filter((pBucket) => { return pBucket.Selected; });
												if (tmpFull.length > 0)
												{
													Expect(tmpSelected.map((pBucket) => { return pBucket.Key; })).to.deep.equal([ tmpTraps.E2FormTypeID ]);
													Expect(tmpSelected[0].LabelResolved).to.equal(true);
												}
												// Records: the first 100 by primary key.
												Expect(ids(pEnvelope.Records, 'IDDocument'), `${pName} Records`).to.deep.equal(sortedNumbers(ids(tmpFull, 'IDDocument')).slice(0, 100));
											}, fDone);
									});

								test('Records == the set the facets count, and per-hop two-tenant isolation (Lead, OtherLead)',
									function (fDone)
									{
										let tmpBody = e2Body(_ProjectTrack.traps);
										fRecordsEqual(_ProjectTrack, 'Document', tmpBody, 'Lead', 'IDDocument', ids(fOracle(_ProjectTrack, 'Lead').e2(_ProjectTrack.traps.E2FormTypeID, {}), 'IDDocument'),
											() =>
											{
												_ProjectTrack.assertTenantIsolation('Document', tmpBody, [ 'Lead', 'OtherLead' ],
													(pError, pReport) =>
													{
														Expect(pError, JSON.stringify(pReport && pReport.Mismatches)).to.not.exist;
														return fDone();
													});
											});
									});
							}
						);

						// ============================================================ E3 variant A
						suite
						(
							'E3 variant A — lab forms I still have to fill out (LabTrack, MaterialIntakeRequirement)',
							() =>
							{
								test('O1, O-hand and O2 as Tech, Colleague, Newbie and OtherTech (ToDo, ByQueue, ByWeek, ByDiscipline, Started)',
									function (fDone)
									{
										let tmpTechTotal = null;
										fEachPrincipal(_LabTrack, 'MaterialIntakeRequirement', e3aBody(), [ 'Tech', 'Colleague', 'Newbie', 'OtherTech' ],
											(pName, pEnvelope, pOracle) =>
											{
												let tmpToDo = pOracle.e3a();
												let tmpFacets = pEnvelope.Facets;
												[ 'ToDo', 'Queue', 'Week', 'Discipline', 'Started' ].forEach(
													(pKey) =>
													{
														Expect(tmpFacets[pKey].Total, `${pName} ${pKey} Total`).to.equal(tmpToDo.length);
														Expect(tmpFacets[pKey].Declared).to.equal(true);
														Expect(tmpFacets[pKey].Relaxed, `${pName} ${pKey} Relaxed (TenantOnly hop)`).to.equal(true);
													});
												expectBuckets(tmpFacets.ToDo, groupBy(tmpToDo, (pRow) => { return pRow.IDLabFormType; }), `${pName} ToDo`);
												expectBuckets(tmpFacets.Queue, groupBy(tmpToDo, (pRow) => { let tmpIntake = pOracle.one('MaterialIntake', 'IDMaterialIntake', pRow.IDMaterialIntake); let tmpQueue = tmpIntake ? pOracle.one('LabQueue', 'IDLabQueue', tmpIntake.IDLabQueue) : null; return tmpQueue ? tmpQueue.IDLabQueue : null; }), `${pName} Queue`);
												expectBuckets(tmpFacets.Week, groupBy(tmpToDo, (pRow) => { let tmpIntake = pOracle.one('MaterialIntake', 'IDMaterialIntake', pRow.IDMaterialIntake); return tmpIntake ? weekKey(tmpIntake.ReceivedDate) : null; }), `${pName} Week`);
												expectBuckets(tmpFacets.Discipline, groupBy(tmpToDo, (pRow) => { let tmpType = pOracle.one('LabFormType', 'IDLabFormType', pRow.IDLabFormType); return tmpType ? tmpType.Discipline : null; }), `${pName} Discipline`);
												expectBuckets(tmpFacets.Started, groupBy(tmpToDo, (pRow) => { return pOracle.started(pRow) ? 1 : 0; }), `${pName} Started`);
												Expect(tmpFacets.Started.Fold).to.equal('ExistsSplit');
												Expect(tmpFacets.Started.Buckets.map((pBucket) => { return pBucket.Key; })).to.deep.equal([ 1, 0 ]);
												Expect(tmpFacets.Started.Buckets.map((pBucket) => { return pBucket.Label; })).to.deep.equal([ 'Started', 'Not started' ]);
												if (pName === 'Tech')
												{
													tmpTechTotal = tmpToDo.length;
													// TenantOnly: forms only the Colleague completed are done for Tech too.
													let tmpOwnOnly = pOracle.e3a(false);
													Expect(tmpOwnOnly.length, 'the relaxation matters for Tech').to.be.above(tmpToDo.length);
													let tmpToDoPairs = new Set(tmpToDo.map((pRow) => { return `${pRow.IDMaterialIntake}|${pRow.IDLabFormType}`; }));
													_LabTrack.traps.ColleagueCompleted.forEach((pPair) => { Expect(tmpToDoPairs.has(`${pPair.IDMaterialIntake}|${pPair.IDLabFormType}`), JSON.stringify(pPair)).to.equal(false); });
												}
												if (pName === 'Newbie')
												{
													Expect(tmpToDo.length, 'Newbie is in no queue').to.equal(0);
												}
											},
											() =>
											{
												Expect(tmpTechTotal).to.be.above(0);
												return fDone();
											});
									});

								test('the work list through pict\'s FilterEndpointOverride (…/Scope/…ToDoForMe/Records/:Begin/:Cap and /Count) is the set ToDo counts',
									function (fDone)
									{
										let tmpTech = _LabTrack.as('Tech');
										let tmpExpected = sortedNumbers(ids(fOracle(_LabTrack, 'Tech').e3a(), 'IDMaterialIntakeRequirement'));
										// pict-section-recordset posts { Clauses, Experience } to these exact URLs.
										let tmpPictBody = { Clauses: [], Experience: { ResultDestinationAddress: 'AppData.FormsToDo' } };
										_LabTrack.scopeRecordsCount('MaterialIntakeRequirement', 'MaterialIntakeRequirement.ToDoForMe', tmpPictBody, tmpTech,
											(pCountError, pCount) =>
											{
												Expect(pCount.Status, JSON.stringify(pCount.Body)).to.equal(200);
												Expect(pCount.Body).to.deep.equal({ Count: tmpExpected.length });
												Expect(pCount.Headers.etag).to.match(/^W\/"fv1:/);
												let tmpSeen = [];
												let fPage = (pBegin) =>
												{
													_LabTrack.scopeRecords('MaterialIntakeRequirement', 'MaterialIntakeRequirement.ToDoForMe', pBegin, 50, tmpPictBody, tmpTech,
														(pPageError, pPage) =>
														{
															Expect(pPage.Status, JSON.stringify(pPage.Body)).to.equal(200);
															Expect(pPage.Body).to.be.an('array');
															// Plan order: by primary key.
															let tmpPageIDs = ids(pPage.Body, 'IDMaterialIntakeRequirement');
															Expect(tmpPageIDs).to.deep.equal(sortedNumbers(tmpPageIDs));
															pPage.Body.forEach((pRecord) => { Expect(pRecord.IDCustomer).to.equal(tmpTech.Tenant); Expect(pRecord.Deleted).to.equal(0); });
															tmpSeen = tmpSeen.concat(tmpPageIDs);
															if (pPage.Body.length === 50)
															{
																return fPage(pBegin + 50);
															}
															Expect(tmpSeen).to.deep.equal(tmpExpected);
															// The Query route's scope form answers the same scope.
															_LabTrack.request('POST', '/1.0/Facet/MaterialIntakeRequirement/Scope/MaterialIntakeRequirement.ToDoForMe/Query', { Facets: [ { Key: 'Type', Facet: 'MaterialIntakeRequirement.IDLabFormType' } ] }, tmpTech,
																(pQueryError, pQuery) =>
																{
																	Expect(pQuery.Status, JSON.stringify(pQuery.Body)).to.equal(200);
																	Expect(pQuery.Body.Total).to.equal(tmpExpected.length);
																	Expect(pQuery.Body.Filter.Applied).to.deep.equal([ { Scope: 'MaterialIntakeRequirement.ToDoForMe' } ]);
																	return fDone();
																});
														});
												};
												return fPage(0);
											});
									});

								test('per-hop two-tenant isolation (Tech, OtherTech) and Records == the set (Keys, Count, pages) as OtherTech',
									function (fDone)
									{
										let tmpBody = Object.assign(e3aBody(), { Scopes: [ { Scope: 'MaterialIntakeRequirement.ToDoForMe' } ] });
										_LabTrack.assertTenantIsolation('MaterialIntakeRequirement', tmpBody, [ 'Tech', 'OtherTech' ],
											(pError, pReport) =>
											{
												Expect(pError, JSON.stringify(pReport && pReport.Mismatches)).to.not.exist;
												fRecordsEqual(_LabTrack, 'MaterialIntakeRequirement', tmpBody, 'OtherTech', 'IDMaterialIntakeRequirement', ids(fOracle(_LabTrack, 'OtherTech').e3a(), 'IDMaterialIntakeRequirement'), fDone);
											});
									});
							}
						);

						// ============================================================ E3 variant B
						suite
						(
							'E3 variant B — the same question from configuration (LabTrack, MaterialIntake TuplePivot)',
							() =>
							{
								test('O1, O-hand and O2 as Tech, Colleague, Newbie and OtherTech (distinct tuples, no bucket Clause)',
									function (fDone)
									{
										fEachPrincipal(_LabTrack, 'MaterialIntake', e3bBody(), [ 'Tech', 'Colleague', 'Newbie', 'OtherTech' ],
											(pName, pEnvelope, pOracle) =>
											{
												let tmpTuples = pOracle.e3b();
												let tmpFacets = pEnvelope.Facets;
												[ 'ToDo', 'Queue', 'Week' ].forEach(
													(pKey) =>
													{
														Expect(tmpFacets[pKey].Total, `${pName} ${pKey} Total`).to.equal(tmpTuples.length);
														Expect(tmpFacets[pKey].CountMode).to.equal('KeyDistinct');
														Expect(tmpFacets[pKey].Buckets.every((pBucket) => { return pBucket.Clause === null; }), `${pName} ${pKey}: tuple counts have no list Clause`).to.equal(true);
													});
												expectBuckets(tmpFacets.ToDo, groupBy(tmpTuples, (pTuple) => { return pTuple.FormType; }), `${pName} ToDo`);
												expectBuckets(tmpFacets.Queue, groupBy(tmpTuples, (pTuple) => { return pTuple.Intake.IDLabQueue; }), `${pName} Queue`);
												expectBuckets(tmpFacets.Week, groupBy(tmpTuples, (pTuple) => { return weekKey(pTuple.Intake.ReceivedDate); }), `${pName} Week`);
												if (pName === 'Tech')
												{
													Expect(tmpTuples.length).to.be.above(0);
													// The duplicate type-requirement row is one tuple, never two.
													let tmpDuplicate = _LabTrack.traps.DuplicateTypeRequirement;
													let tmpDuplicates = pOracle.visible('MaterialTypeFormRequirement').filter((pRow) => { return (pRow.IDMaterialType === tmpDuplicate.IDMaterialType) && (pRow.IDLabFormType === tmpDuplicate.IDLabFormType) && (pRow.Required === 1); });
													Expect(tmpDuplicates.length).to.be.above(1);
												}
											}, fDone);
									});

								test('a client clause naming the delete column reaches the tuple Home side the same way on both engines',
									function (fDone)
									{
										let tmpBody = Object.assign(e3bBody(), { Clauses: [ { Type: 'RawFilter', Value: 'FBL~Deleted~INN~0,1' } ] });
										_LabTrack.compareInProcess('MaterialIntake', tmpBody, Object.assign({ Now: TEST_NOW }, _LabTrack.as('Tech')),
											(pError, pResult) =>
											{
												Expect(pError).to.not.exist;
												Expect(pResult.Live.Errors || {}).to.deep.equal({});
												Expect(pResult.LiveNormalized).to.deep.equal(pResult.ReferenceNormalized);
												return fDone();
											});
									});

								test('per-hop two-tenant isolation (Tech, OtherTech)',
									function (fDone)
									{
										_LabTrack.assertTenantIsolation('MaterialIntake', e3bBody(), [ 'Tech', 'OtherTech' ],
											(pError, pReport) =>
											{
												Expect(pError, JSON.stringify(pReport && pReport.Mismatches)).to.not.exist;
												return fDone();
											});
									});
							}
						);

						// ============================================================ owner scope
						suite
						(
							'LabForm owner scope (PersonalScopes OwnerIDUser)',
							() =>
							{
								test('facets, Keys and Records on LabForm see only the principal\'s own forms, never another tenant\'s (every principal)',
									function (fDone)
									{
										let tmpBody = { Facets: [ { Key: 'Status', Facet: 'LabForm.Status' }, { Key: 'Type', Facet: 'LabForm.IDLabFormType' } ], Total: true };
										_LabTrack.assertTenantIsolation('LabForm', tmpBody, [ 'Tech', 'Colleague', 'Newbie', 'OtherTech' ],
											(pError, pReport) =>
											{
												Expect(pError, JSON.stringify(pReport && pReport.Mismatches)).to.not.exist;
												let tmpTech = _LabTrack.as('Tech');
												let tmpOwn = fOracle(_LabTrack, 'Tech').visible('LabForm');
												Expect(tmpOwn.length).to.be.above(0);
												Expect(pReport.Principals.Tech.Total).to.equal(tmpOwn.length);
												fRecordsEqual(_LabTrack, 'LabForm', { Clauses: [] }, 'Tech', 'IDLabForm', ids(tmpOwn, 'IDLabForm'),
													() =>
													{
														_LabTrack.records('LabForm', { Records: { Begin: 0, Cap: 500 } }, tmpTech,
															(pRecordsError, pRecords) =>
															{
																Expect(pRecords.Status).to.equal(200);
																pRecords.Body.forEach((pRecord) => { Expect(pRecord.OwnerIDUser).to.equal(tmpTech.User); Expect(pRecord.IDCustomer).to.equal(tmpTech.Tenant); });
																return fDone();
															});
													});
											});
									});
							}
						);

						// ============================================================ the per-entity gate
						suite
						(
							'The per-entity gate over HTTP (internal-contracts §19.6): 403 without Detail',
							() =>
							{
								/**
								 * Deny pEntities to every principal through a host authorizer for one call chain.
								 */
								let fDenying = (pHarness, pEntities, fWork, fDone) =>
								{
									let tmpHost = pHarness.faceting.Host;
									tmpHost.getAuthorizer = () => { return { canRead: (pEntity) => { return pEntities.indexOf(pEntity) < 0; } }; };
									fWork(
										(pError) =>
										{
											delete tmpHost.getAuthorizer;
											return fDone(pError);
										});
								};

								test('an entity the request filter reads (a scope hop, a join target) fails the whole request 403 before its fields are validated',
									function (fDone)
									{
										let tmpLead = _ProjectTrack.as('Lead');
										fDenying(_ProjectTrack, [ 'Issue', 'Client' ],
											(fRelease) =>
											{
												_ProjectTrack.facetQuery('Project', { Scopes: [ { Scope: 'Project.Unblocked' } ], Facets: [ { Facet: 'Project.Status' } ] }, tmpLead,
													(pError, pScope) =>
													{
														Expect(pScope.Status).to.equal(403);
														Expect(pScope.Body.Error.Code).to.equal('FACET_FORBIDDEN');
														Expect(pScope.Body.Error).to.not.have.property('Detail');
														// A join clause to the unreadable Client, even with an unknown remote field: 403, not 400.
														_ProjectTrack.facetQuery('Project', { Clauses: [ { Type: 'InternalJoinMatch', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', JoinExternalConnectionColumn: 'IDClient', ExternalFilterByColumns: [ 'NoSuchColumn' ], Values: [ 'Acme' ] } ], Facets: [ { Facet: 'Project.Status' } ] }, tmpLead,
															(pJoinError, pJoin) =>
															{
																Expect(pJoin.Status).to.equal(403);
																Expect(pJoin.Body.Error).to.not.have.property('Detail');
																// The Records routes gate the same way.
																_ProjectTrack.scopeRecordsCount('Project', 'Project.Unblocked', {}, tmpLead,
																	(pCountError, pCount) =>
																	{
																		Expect(pCount.Status).to.equal(403);
																		return fRelease();
																	});
															});
													});
											}, fDone);
									});

								test('an entity one facet reads (a definition hop, a tuple side) fails that facet 403; a label target only loses its labels',
									function (fDone)
									{
										let tmpTech = _LabTrack.as('Tech');
										fDenying(_LabTrack, [ 'MaterialTypeFormRequirement', 'LabFormType' ],
											(fRelease) =>
											{
												let tmpBody = { Facets: e3bBody().Facets.concat([ { Key: 'Status', Facet: 'MaterialIntake.Status' } ]) };
												_LabTrack.facetQuery('MaterialIntake', tmpBody, tmpTech,
													(pError, pE3B) =>
													{
														Expect(pE3B.Status).to.equal(200);
														[ 'ToDo', 'Queue', 'Week' ].forEach(
															(pKey) =>
															{
																Expect(pE3B.Body.Errors[pKey].Code, pKey).to.equal('FACET_FORBIDDEN');
																Expect(pE3B.Body.Errors[pKey]).to.not.have.property('Detail');
															});
														Expect(pE3B.Body.Facets.Status.Total).to.be.above(0);
														_LabTrack.facetQuery('MaterialIntakeRequirement', e3aBody(), tmpTech,
															(pE3AError, pE3A) =>
															{
																Expect(pE3A.Status).to.equal(200);
																// ByDiscipline hops into LabFormType: refused; ToDo is labelled from it: unlabelled.
																Expect(pE3A.Body.Errors.Discipline.Code).to.equal('FACET_FORBIDDEN');
																Expect(pE3A.Body.Facets.ToDo.Total).to.be.above(0);
																pE3A.Body.Facets.ToDo.Buckets.forEach((pBucket) => { Expect(pBucket.LabelResolved).to.equal(false); Expect(pBucket.Label).to.equal(String(pBucket.Key)); });
																return fRelease();
															});
													});
											}, fDone);
									});

								test('Describe lists the declared facets and scopes (with Params) only when every entity they read is facetable',
									function (fDone)
									{
										let tmpLead = _ProjectTrack.as('Lead');
										_ProjectTrack.request('GET', '/1.0/Facet/Project/Describe', null, tmpLead,
											(pError, pDescribe) =>
											{
												Expect(pDescribe.Status).to.equal(200);
												let tmpBlock = pDescribe.Body.Entities.Project;
												let tmpScopes = tmpBlock.Scopes.map((pScope) => { return pScope.Scope; });
												Expect(tmpScopes).to.include.members([ 'Project.MyProjects', 'Project.HasMyOverdue', 'Project.Unblocked' ]);
												let tmpMine = tmpBlock.Scopes.find((pScope) => { return pScope.Scope === 'Project.MyProjects'; });
												Expect(tmpMine.Params.Roles).to.include({ Type: 'EnumList' });
												Expect(tmpMine.Params.Roles.Default).to.deep.equal([ 'Owner', 'Lead', 'Member' ]);
												let tmpBand = tmpBlock.Facets.find((pFacet) => { return pFacet.Facet === 'Project.MyOverdueBand'; });
												Expect(tmpBand).to.include({ Declared: true, DefaultFold: 'ChildRollup' });
												fDenying(_ProjectTrack, [ 'Issue' ],
													(fRelease) =>
													{
														_ProjectTrack.request('GET', '/1.0/Facet/Project/Describe', null, tmpLead,
															(pDeniedError, pDenied) =>
															{
																let tmpDenied = pDenied.Body.Entities.Project;
																Expect(tmpDenied.Scopes.map((pScope) => { return pScope.Scope; })).to.not.include('Project.Unblocked');
																Expect(tmpDenied.Facets.map((pFacet) => { return pFacet.Facet; })).to.not.include('Project.HasOpenIssues');
																Expect(tmpDenied.Facets.map((pFacet) => { return pFacet.Facet; })).to.include('Project.MyOverdueBand');
																return fRelease();
															});
													}, fDone);
											});
									});
							}
						);
					}
				);
			});
	}
);
