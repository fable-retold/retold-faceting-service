#!/usr/bin/env node
/**
 * Milestone 2 smoke run: boots the ProjectTrack (port 19191) and LabTrack (an ephemeral port) test
 * harnesses — plain retold-data-service, Embedded faceting, the domain definitions files loaded at
 * attach, seeded on in-memory SQLite — and prints the three motivating queries of design 08 over
 * HTTP, abridged, as the principal of 08: user 42 in tenant 7.
 *
 *   node debug/m2-smoke.js
 *
 * The fixtures' story principal (ProjectTrack Lead, LabTrack Tech) is user 1 of tenant 1; after
 * seeding, this script renumbers tenant 1 → 7 and user 1 → 42 in both databases (every IDCustomer
 * column, every *IDUser column; neither 7 nor 42 exists in the seeds), so the requests run exactly
 * as 08 writes them.  Printed:
 *
 *   E1  POST /1.0/Facet/Project/Query (three named scopes, three clauses incl. an InternalJoin,
 *       Status / Client / Started / MyOverdueBand / Status × Client, Records)
 *   E2  POST /1.0/Facet/Document/Query (form type + month window, ByMonth / ByForm / Status, Records)
 *   E3A POST /1.0/Facet/MaterialIntakeRequirement/Query (MyFormsToDo + siblings) and the work list
 *       POST …/Scope/MaterialIntakeRequirement.ToDoForMe/Records/0/5 and …/Records/Count
 *   E3B POST /1.0/Facet/MaterialIntake/Query (the TuplePivot FormsToDo + siblings)
 *
 * Exit code 0 when every call answers 200, 1 otherwise.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libHarness = require('../test/support/Facet-Test-Harness.js');

const PORT = 19191;

// The principal of design 08.
const TENANT = 7;
const USER = 42;
// The fixtures' story principal, renumbered to it.
const SEED_TENANT = 1;
const SEED_USER = 1;

let _ProjectTrack = null;
let _LabTrack = null;
let _Failures = 0;

/**
 * Renumber the story principal of a seeded SQLite database to the principal of 08.
 *
 * @param {Record<string, any>} pHarness
 */
const renumber = (pHarness) =>
{
	let tmpTables = pHarness.model.Tables;
	Object.keys(tmpTables).forEach(
		(pTable) =>
		{
			tmpTables[pTable].Columns.forEach(
				(pColumn) =>
				{
					if (pColumn.Column === 'IDCustomer')
					{
						pHarness.db.prepare(`UPDATE "${pTable}" SET "IDCustomer" = ? WHERE "IDCustomer" = ?`).run(TENANT, SEED_TENANT);
					}
					else if (/IDUser$/.test(pColumn.Column))
					{
						pHarness.db.prepare(`UPDATE "${pTable}" SET "${pColumn.Column}" = ? WHERE "${pColumn.Column}" = ?`).run(USER, SEED_USER);
					}
				});
		});
};

/**
 * One bucket, abridged: key, label when it differs, count, '*' when selected.
 *
 * @param {Record<string, any>} pBucket
 * @return {string}
 */
const bucketText = (pBucket) =>
{
	let tmpKey = (typeof(pBucket.Key) === 'string') ? ((pBucket.Key.length > 0) ? pBucket.Key : "''") : String(pBucket.Key);
	let tmpLabel = ((typeof(pBucket.Label) === 'string') && (pBucket.Label !== String(pBucket.Key)) && (pBucket.Label.length > 0)) ? ` (${pBucket.Label})` : '';
	return `${tmpKey}${tmpLabel}=${pBucket.Count}${pBucket.Selected ? '*' : ''}`;
};

/**
 * Print an envelope, abridged (08 §2.5 style).
 *
 * @param {string} pTitle
 * @param {Record<string, any>} pResponse - { Status, Headers, Body }
 */
const printEnvelope = (pTitle, pResponse) =>
{
	console.log(`${pTitle} → ${pResponse.Status}  ETag ${pResponse.Headers.etag || '-'}`);
	if (pResponse.Status !== 200)
	{
		_Failures++;
		console.log(JSON.stringify(pResponse.Body, null, '\t'));
		console.log('');
		return;
	}
	let tmpEnvelope = pResponse.Body;
	console.log(`  Total ${tmpEnvelope.Total}, Engine ${tmpEnvelope.Engine}, Exact ${tmpEnvelope.Exact}, ModelVersion ${tmpEnvelope.ModelVersion}`);
	console.log(`  Filter.Applied ${JSON.stringify(tmpEnvelope.Filter ? tmpEnvelope.Filter.Applied : [])}`);
	Object.keys(tmpEnvelope.Facets || {}).forEach(
		(pKey) =>
		{
			let tmpFacet = tmpEnvelope.Facets[pKey];
			let tmpExtras = [];
			if (tmpFacet.Declared !== undefined)
			{
				tmpExtras.push(`Declared ${tmpFacet.Declared}`);
			}
			if (tmpFacet.CountMode)
			{
				tmpExtras.push(`CountMode ${tmpFacet.CountMode}`);
			}
			if (tmpFacet.Relaxed)
			{
				tmpExtras.push('Relaxed');
			}
			if (Array.isArray(tmpFacet.Path))
			{
				tmpExtras.push(`Path ${tmpFacet.Path.join(' ')}`);
			}
			console.log(`  ${pKey} (${tmpFacet.Fold})  Total ${tmpFacet.Total}  Sum ${tmpFacet.SumOfCounts}  Missing ${tmpFacet.MissingCount}  Other ${tmpFacet.OtherCount}  Excluded ${JSON.stringify(tmpFacet.Excluded || [])}${tmpExtras.length ? `  [${tmpExtras.join(', ')}]` : ''}`);
			if (Array.isArray(tmpFacet.Cells))
			{
				let tmpCells = tmpFacet.Cells.slice(0, 8).map((pCell) => { return `${JSON.stringify(pCell.Keys || [ pCell.K1, pCell.K2 ])}=${pCell.Count}`; });
				console.log(`     cells: ${tmpCells.join(', ')}${(tmpFacet.Cells.length > 8) ? `, … (${tmpFacet.Cells.length} cells)` : ''}`);
				return;
			}
			let tmpBuckets = (Array.isArray(tmpFacet.Buckets) ? tmpFacet.Buckets : []).filter((pBucket) => { return (pBucket.Count > 0) || pBucket.Selected || (tmpFacet.Fold === 'ChildRollup'); });
			let tmpText = tmpBuckets.slice(0, 10).map(bucketText).join(', ');
			console.log(`     ${tmpText}${(tmpBuckets.length > 10) ? `, … (${tmpBuckets.length} non-empty buckets)` : ''}`);
		});
	Object.keys(tmpEnvelope.Errors || {}).forEach(
		(pKey) =>
		{
			_Failures++;
			console.log(`  ERROR ${pKey}: ${JSON.stringify(tmpEnvelope.Errors[pKey])}`);
		});
	if (Array.isArray(tmpEnvelope.Records))
	{
		console.log(`  Records: ${tmpEnvelope.Records.length} (${tmpEnvelope.RecordShape}, dropped ${tmpEnvelope.RecordsDropped})`);
	}
	console.log('');
};

/**
 * Print a few records.
 *
 * @param {Array<Record<string, any>>} pRecords
 * @param {Array<string>} pColumns
 */
const printRecords = (pRecords, pColumns) =>
{
	(Array.isArray(pRecords) ? pRecords : []).slice(0, 5).forEach(
		(pRecord) =>
		{
			console.log(`     ${pColumns.map((pColumn) => { return `${pColumn}=${JSON.stringify(pRecord[pColumn])}`; }).join('  ')}`);
		});
};

/**
 * Stop both harnesses and exit.
 */
const finish = () =>
{
	let tmpCode = (_Failures === 0) ? 0 : 1;
	let fStopLab = () => { return _LabTrack ? _LabTrack.stop(() => { process.exit(tmpCode); }) : process.exit(tmpCode); };
	return _ProjectTrack ? _ProjectTrack.stop(fStopLab) : fStopLab();
};

const PRINCIPAL = { Tenant: TENANT, User: USER };

/**
 * The three motivating queries, in order.
 */
const run = () =>
{
	let tmpTraps = _ProjectTrack.traps;
	let tmpE1 = (
		{
			Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: [ 'Owner', 'Lead' ] } }, { Scope: 'Project.HasMyOverdue' }, { Scope: 'Project.Unblocked' } ],
			Clauses:
				[
					{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active', 'AtRisk' ], FilterKey: 'Status', Hash: 'Status-DSVL-1' },
					{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', JoinExternalConnectionColumn: 'IDClient', Values: tmpTraps.E1ClientIDs, FilterKey: 'IDClient', Hash: 'IDClient-IJ-1' },
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
	let tmpE2 = (
		{
			Clauses:
				[
					{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'FormType', JoinInternalConnectionColumn: 'IDFormType', JoinExternalConnectionColumn: 'IDFormType', Values: [ tmpTraps.E2FormTypeID ], FilterKey: 'IDFormType', Hash: 'IDFormType-IJ-1' },
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
	let tmpE3A = (
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
	let tmpE3B = (
		{
			Facets:
				[
					{ Key: 'ToDo', Facet: 'MaterialIntake.FormsToDo' },
					{ Key: 'Queue', Facet: 'MaterialIntake.FormsToDo/ByQueue' },
					{ Key: 'Week', Facet: 'MaterialIntake.FormsToDo/ByWeek' }
				]
		});

	_ProjectTrack.request('GET', '/1.0/Facet/Project/Describe', null, PRINCIPAL,
		(pDescribeError, pDescribe) =>
		{
			if (pDescribeError || (pDescribe.Status !== 200))
			{
				_Failures++;
				console.log(`GET /1.0/Facet/Project/Describe failed: ${pDescribeError ? pDescribeError.message : pDescribe.Status}`);
				return finish();
			}
			let tmpBlock = pDescribe.Body.Entities.Project;
			console.log(`GET /1.0/Facet/Project/Describe → 200  (ModelVersion ${pDescribe.Body.ModelVersion})`);
			console.log(`  Scopes: ${tmpBlock.Scopes.map((pScope) => { return `${pScope.Scope}${(Object.keys(pScope.Params || {}).length > 0) ? `(${Object.keys(pScope.Params).join(', ')})` : ''}`; }).join(', ')}`);
			console.log(`  Declared facets: ${tmpBlock.Facets.filter((pFacet) => { return pFacet.Declared === true; }).map((pFacet) => { return `${pFacet.Facet} [${pFacet.Folds.join('/')}]`; }).join(', ')}`);
			console.log('');

			console.log('=== E1: projects for user 42 by complex criteria (08 §2) ===');
			_ProjectTrack.facetQuery('Project', tmpE1, PRINCIPAL,
				(pE1Error, pE1) =>
				{
					if (pE1Error)
					{
						_Failures++;
						console.log(`E1 failed: ${pE1Error.message}`);
						return finish();
					}
					printEnvelope('POST /1.0/Facet/Project/Query', pE1);
					if (pE1.Status === 200)
					{
						printRecords(pE1.Body.Records, [ 'IDProject', 'Name', 'Status', 'StartDate', 'IDClient' ]);
						console.log('');
					}

					console.log('=== E2: documents of form type, by month (08 §3) ===');
					_ProjectTrack.facetQuery('Document', tmpE2, PRINCIPAL,
						(pE2Error, pE2) =>
						{
							if (pE2Error)
							{
								_Failures++;
								console.log(`E2 failed: ${pE2Error.message}`);
								return finish();
							}
							printEnvelope('POST /1.0/Facet/Document/Query', pE2);

							console.log('=== E3 variant A: lab forms I still have to fill out (08 §4.2) ===');
							_LabTrack.facetQuery('MaterialIntakeRequirement', tmpE3A, PRINCIPAL,
								(pE3AError, pE3A) =>
								{
									if (pE3AError)
									{
										_Failures++;
										console.log(`E3A failed: ${pE3AError.message}`);
										return finish();
									}
									printEnvelope('POST /1.0/Facet/MaterialIntakeRequirement/Query', pE3A);
									_LabTrack.scopeRecords('MaterialIntakeRequirement', 'MaterialIntakeRequirement.ToDoForMe', 0, 5, { Clauses: [], Experience: {} }, PRINCIPAL,
										(pPageError, pPage) =>
										{
											_LabTrack.scopeRecordsCount('MaterialIntakeRequirement', 'MaterialIntakeRequirement.ToDoForMe', { Clauses: [], Experience: {} }, PRINCIPAL,
												(pCountError, pCount) =>
												{
													if (pPageError || pCountError || (pPage.Status !== 200) || (pCount.Status !== 200))
													{
														_Failures++;
														console.log(`E3A work list failed: ${pPageError ? pPageError.message : pPage.Status} / ${pCountError ? pCountError.message : pCount.Status}`);
														return finish();
													}
													console.log(`POST …/Scope/MaterialIntakeRequirement.ToDoForMe/Records/0/5 → 200 (${pPage.Body.length} records)   …/Records/Count → ${JSON.stringify(pCount.Body)}`);
													printRecords(pPage.Body, [ 'IDMaterialIntakeRequirement', 'IDMaterialIntake', 'IDLabFormType', 'IDCustomer' ]);
													console.log('');

													console.log('=== E3 variant B: the same question from configuration (TuplePivot, 08 §4.3) ===');
													_LabTrack.facetQuery('MaterialIntake', tmpE3B, PRINCIPAL,
														(pE3BError, pE3B) =>
														{
															if (pE3BError)
															{
																_Failures++;
																console.log(`E3B failed: ${pE3BError.message}`);
																return finish();
															}
															printEnvelope('POST /1.0/Facet/MaterialIntake/Query', pE3B);
															console.log((_Failures === 0) ? 'M2 smoke: every call answered 200.' : `M2 smoke: ${_Failures} failure(s).`);
															return finish();
														});
												});
										});
								});
						});
				});
		});
};

// A debug script pins its registry port (tests bind ephemeral ports); LabTrack takes an ephemeral one.
_ProjectTrack = libHarness.start({ Port: PORT, FixedPort: true, Fixture: 'ProjectTrack', LogLevel: 'error' },
	(pProjectError) =>
	{
		if (pProjectError)
		{
			console.error(`ProjectTrack harness failed to start: ${pProjectError.message}`);
			_Failures++;
			return finish();
		}
		_LabTrack = libHarness.start({ Port: PORT, Fixture: 'LabTrack', LogLevel: 'error' },
			(pLabError) =>
			{
				if (pLabError)
				{
					console.error(`LabTrack harness failed to start: ${pLabError.message}`);
					_Failures++;
					return finish();
				}
				renumber(_ProjectTrack);
				renumber(_LabTrack);
				let tmpRegistry = _ProjectTrack.fable.RetoldFacetingDefinitionRegistry.status();
				let tmpLabRegistry = _LabTrack.fable.RetoldFacetingDefinitionRegistry.status();
				console.log(`Retold faceting M2 smoke: ProjectTrack ${_ProjectTrack.baseURL}, LabTrack ${_LabTrack.baseURL} (SQLite; principal tenant ${TENANT}, user ${USER})`);
				console.log(`  ProjectTrack definitions: ${JSON.stringify(tmpRegistry)}`);
				console.log(`  LabTrack definitions:     ${JSON.stringify(tmpLabRegistry)}`);
				console.log('');
				return run();
			});
	});
