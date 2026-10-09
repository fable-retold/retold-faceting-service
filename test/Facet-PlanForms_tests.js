/**
 * Facet-PlanForms tests (oracle O5, Builder C): the plan forms of the Live engine answer
 * identically.  For every cross-entity fixture (E1, E2, E3A, E3B, the coverage folds):
 *
 *   { Cube: 'Never', Staged: 'Never' }  ==  { Cube: 'Always' }  ==  { Staged: 'Always' }
 *
 * at the RawFacetResult level (post-processing is a pure function of Agg + RawFacetResult, so equal
 * raw results are equal envelopes).  Also: the E1 cube is ONE statement for six facets; a cube over
 * Limits.CubeMaxGroups falls back to the per-Variant statements (Execution.CubeFallbacks) with the
 * same answers; a Staged key set of more than 1 000 keys equals the fused form; MaxStagedKeys gives
 * 422 FACET_PATH_TOO_BROAD (whole request from a Variant path predicate, per facet from a facet's
 * own hop); the correlated and the pivot-restricted ChildAgg forms agree; marginalize() is pure.
 *
 * With RFS_TEST_POSTGRES=1 (TZ=UTC) the same O5 matrix also runs on PostgreSQL.
 *
 * Port 19123 (internal-contracts §32.4; the bench binds an ephemeral port).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libKit = require('./support/Facet-Live-M2-Kit.js');
const F = require('./support/Facet-Live-M2-FoldIR.js');
const libBuilders = require('./support/Facet-Test-Builders.js');
const libOptions = require('../source/Retold-Faceting-Service-Options.js');

const libRetoldFacetingCubeExecutor = require('../source/engine/live/Retold-Faceting-CubeExecutor.js');

const PORT = 19123;

const CLIENTS = [ 1, 2, 3, 4, 5, 8, 101 ];

/**
 * The fixtures every O5 form runs: { Name, Domain, Entity, Principal, Variants(), Aggs() }.
 */
const FIXTURES =
[
	{
		Name: 'E1', Domain: 'ProjectTrack', Entity: 'Project', Principal: 'Lead',
		Variants: () => { return F.e1Plan(1, CLIENTS).Variants; },
		Aggs: () => { return F.e1Plan(1, CLIENTS).Aggs; }
	},
	{
		Name: 'E2', Domain: 'ProjectTrack', Entity: 'Document', Principal: 'Lead',
		Variants: () => { return F.projectCoverage(1, 3).E2Variants; },
		Aggs: () => { return F.projectCoverage(1, 3).E2Aggs; }
	},
	{
		Name: 'ProjectCoverage', Domain: 'ProjectTrack', Entity: 'Project', Principal: 'Lead',
		Variants: () => { return { v0: F.variant('v0', 'Project', [], null) }; },
		Aggs: () => { let C = F.projectCoverage(1, 3); return [ C.ByMember, C.HasOpenIssues, C.ManyOverdue ]; }
	},
	{
		Name: 'DocumentCoverage', Domain: 'ProjectTrack', Entity: 'Document', Principal: 'Lead',
		Variants: () => { return { v0: F.variant('v0', 'Document', [], null) }; },
		Aggs: () => { let C = F.projectCoverage(1, 3); return [ C.ByClient, C.InMyProjects ]; }
	},
	{
		Name: 'E3A', Domain: 'LabTrack', Entity: 'MaterialIntakeRequirement', Principal: 'Tech',
		Variants: () => { return { v0: F.variant('v0', 'MaterialIntakeRequirement', [], null), vt: F.variant('vt', 'MaterialIntakeRequirement', [], null) }; },
		Aggs: () => { return F.e3aAggs(1, 'TenantOnly'); }
	},
	{
		Name: 'E3AExtras', Domain: 'LabTrack', Entity: 'MaterialIntakeRequirement', Principal: 'Tech',
		Variants: () => { return { v0: F.variant('v0', 'MaterialIntakeRequirement', [], null), vt: F.variant('vt', 'MaterialIntakeRequirement', [], null) }; },
		Aggs: () => { return F.e3aAggs(1, 'TenantOnly').concat(F.e3aExtraAggs(1)); }
	},
	{
		Name: 'E3B', Domain: 'LabTrack', Entity: 'MaterialIntake', Principal: 'Tech',
		Variants: () => { return { v0: F.variant('v0', 'MaterialIntake', [], null) }; },
		Aggs: () => { return F.e3bAggs(1); }
	},
	{
		Name: 'LabCoverage', Domain: 'LabTrack', Entity: 'MaterialIntake', Principal: 'Tech',
		Variants: () => { return { v0: F.variant('v0', 'MaterialIntake', [], null) }; },
		Aggs: () => { return Object.values(F.labCoverageAggs(1)); }
	},
	{
		// Two On pairs share their INNER column (a co-reference step plus a Correlate onto the same
		// column): the staged key columns map to the On pairs by position, so both correlations hold.
		Name: 'RepeatedInnerColumn', Domain: 'LabTrack', Entity: 'MaterialIntakeRequirement', Principal: 'Tech',
		Variants: () => { return { v0: F.variant('v0', 'MaterialIntakeRequirement', [], null) }; },
		Aggs: () =>
		{
			let tmpWhere = F.notExists(F.rel('LabForm', 'j1', [ 'IDLabForm', 'IDMaterialIntake' ], { Stage: 'Allowed' }),
				[ F.on('p', 'IDMaterialIntake', 'IDMaterialIntake'), F.on('p', 'IDLabFormType', 'IDMaterialIntake') ]);
			let tmpLoose = F.notExists(F.rel('LabForm', 'j2', [ 'IDLabForm', 'IDMaterialIntake' ], { Stage: 'Allowed' }), [ F.on('p', 'IDMaterialIntake', 'IDMaterialIntake') ]);
			return (
				[
					F.agg({ Key: 'Repeated', Kind: 'Terms', Pivot: 'MaterialIntakeRequirement', VariantId: 'v0', Where: tmpWhere, WhereHash: 'wh:repeated', Dimensions: [ F.columnDim('IDLabFormType', 'Numeric') ] }),
					F.agg({ Key: 'Loose', Kind: 'Count', Pivot: 'MaterialIntakeRequirement', VariantId: 'v0', Where: tmpLoose, WhereHash: 'wh:loose' })
				]);
		}
	}
];

/**
 * Run one fixture under a plan form; the cube plan (built like the Planner's) rides along when asked.
 *
 * @param {Record<string, any>} K
 * @param {Record<string, any>} pFixture
 * @param {Record<string, any>} pPlanForm
 * @param {Record<string, any>} [pExtra] - context overrides (Options, …)
 * @param {(pError?: Error, pExecution?: Record<string, any>, pContext?: Record<string, any>) => void} fCallback
 */
const runForm = (K, pFixture, pPlanForm, pExtra, fCallback) =>
{
	let tmpVariants = pFixture.Variants();
	let tmpAggs = pFixture.Aggs();
	let tmpOverrides = Object.assign({ Variants: tmpVariants, PlanForm: pPlanForm }, pExtra || {});
	if (pPlanForm.Cube !== 'Never')
	{
		let tmpCube = F.cubePlanFor('cube0', pFixture.Entity, tmpAggs, tmpVariants);
		if (tmpCube)
		{
			tmpCube.MemberAggs.forEach((pAgg) => { pAgg.CubeId = 'cube0'; });
			delete tmpCube.MemberAggs;
			tmpOverrides.Cubes = [ tmpCube ];
		}
	}
	K.context(pFixture.Entity, pFixture.Principal, tmpOverrides,
		(pContextError, pContext) =>
		{
			if (pContextError)
			{
				return fCallback(pContextError);
			}
			K.execute(K.fable.RetoldFacetingEngineLive, pContext, tmpAggs,
				(pError, pExecution) =>
				{
					return fCallback(pError, pExecution, pContext);
				});
		});
};

/**
 * Assert two executions answer identically (every RawFacetResult and every error).
 *
 * @param {Record<string, any>} pA
 * @param {Record<string, any>} pB
 * @param {string} pLabel
 */
const expectSameAnswers = (pA, pB, pLabel) =>
{
	Expect(Object.keys(pA.Results).sort(), `${pLabel} result keys`).to.deep.equal(Object.keys(pB.Results).sort());
	Object.keys(pA.Results).forEach((pKey) => { Expect(F.normalizeRaw(pB.Results[pKey]), `${pLabel} ${pKey}`).to.deep.equal(F.normalizeRaw(pA.Results[pKey])); });
	Expect(pB.Errors, `${pLabel} errors`).to.deep.equal(pA.Errors);
};

/**
 * The O5 matrix on one provider.
 *
 * @param {string} pProvider
 */
const o5Suite = (pProvider) =>
{
	[ 'ProjectTrack', 'LabTrack' ].forEach(
		(pDomain) =>
		{
			suite
			(
				`O5 on ${pDomain} (${pProvider})`,
				() =>
				{
					let K = null;
					let tmpSkip = null;

					suiteSetup(
						function (fDone)
						{
							K = libKit.start({ Domain: pDomain, Provider: pProvider },
								(pError) =>
								{
									if (pError && pError.Skip)
									{
										tmpSkip = pError.message;
										return fDone();
									}
									return fDone(pError);
								});
						});
					suiteTeardown((fDone) => { K.stop(fDone); });
					setup(function () { if (tmpSkip) { this.skip(); } });

					FIXTURES.filter((pFixture) => { return pFixture.Domain === pDomain; }).forEach(
						(pFixture) =>
						{
							test(`${pFixture.Name}: { Cube: Never, Staged: Never } == { Cube: Always } == { Staged: Always }`,
								(fDone) =>
								{
									runForm(K, pFixture, { Cube: 'Never', Staged: 'Never' }, {},
										(pError, pBase) =>
										{
											Expect(pError).to.equal(null);
											Expect(pBase.Errors, `${pFixture.Name} base errors`).to.deep.equal({});
											Expect(pBase.Staged).to.deep.equal({ Relations: 0, Keys: 0 });
											runForm(K, pFixture, { Cube: 'Always', Staged: 'Never' }, {},
												(pCubeError, pCube) =>
												{
													Expect(pCubeError).to.equal(null);
													Expect(pCube.CubeFallbacks, `${pFixture.Name} cube fell back`).to.deep.equal([]);
													expectSameAnswers(pBase, pCube, `${pFixture.Name} cube`);
													runForm(K, pFixture, { Cube: 'Never', Staged: 'Always' }, {},
														(pStagedError, pStaged) =>
														{
															Expect(pStagedError).to.equal(null);
															expectSameAnswers(pBase, pStaged, `${pFixture.Name} staged`);
															return fDone();
														});
												});
										});
								});
						});

					if (pDomain === 'ProjectTrack')
					{
						test('E1: the cube answers all six facets (four Variants) with ONE statement',
							(fDone) =>
							{
								runForm(K, FIXTURES[0], { Cube: 'Always', Staged: 'Never' }, {},
									(pError, pCube) =>
									{
										Expect(pError).to.equal(null);
										Expect(Object.keys(pCube.Results).length).to.equal(6);
										Expect(pCube.Statements).to.equal(1);
										runForm(K, FIXTURES[0], { Cube: 'Never', Staged: 'Never' }, {},
											(pBaseError, pBase) =>
											{
												Expect(pBase.Statements).to.be.at.least(6);
												return fDone();
											});
									});
							});

						test('E1: a grain over CubeMaxGroups falls back to the per-Variant statements, with the same answers',
							(fDone) =>
							{
								let tmpOptions = libOptions.resolve(libOptions.deepMerge(K.faceting.options, { Limits: { CubeMaxGroups: 3 } }));
								runForm(K, FIXTURES[0], { Cube: 'Always', Staged: 'Never' }, { Options: tmpOptions },
									(pError, pFallback) =>
									{
										Expect(pError).to.equal(null);
										Expect(pFallback.CubeFallbacks).to.deep.equal([ 'cube0' ]);
										runForm(K, FIXTURES[0], { Cube: 'Never', Staged: 'Never' }, { Options: tmpOptions },
											(pBaseError, pBase) =>
											{
												expectSameAnswers(pBase, pFallback, 'fallback');
												return fDone();
											});
									});
							});

						test('a behavior that rewrote a client operator on the Common relation (Transformed) makes the cube fall back',
							(fDone) =>
							{
								// cR (Status != 'Done') is owned by no facet: it fences the cube's Common relation.
								let tmpC1 = F.conjunct('c1', { Field: 'Status', Op: 'IN', Value: [ 'Active', 'AtRisk' ] }, { Fields: [ 'Status' ] });
								let tmpCR = F.conjunct('c2', { Field: 'Status', Op: 'NE', Value: 'Done' }, { Fields: [ 'Status' ], NeverExclude: true });
								let tmpFixture = (
									{
										Name: 'Transformed', Entity: 'Project', Principal: 'Lead',
										Variants: () => { return { v0: F.variant('v0', 'Project', [ tmpC1, tmpCR ], null), v1: F.variant('v1', 'Project', [ tmpCR ], null) }; },
										Aggs: () => { return [ F.agg({ Key: '#Total', Kind: 'Count', Pivot: 'Project' }), F.agg({ Key: 'Status', Kind: 'Terms', Pivot: 'Project', VariantId: 'v1', Dimensions: [ F.columnDim('Status', 'String') ] }), F.agg({ Key: 'Client', Kind: 'Terms', Pivot: 'Project', Dimensions: [ F.columnDim('IDClient', 'Numeric') ] }) ]; }
									});
								let tmpFunctions = K.fable.MeadowEndpoints.Project.controller.BehaviorInjection._BehaviorFunctions;
								let tmpOriginal = tmpFunctions['Reads-QueryConfiguration'];
								tmpFunctions['Reads-QueryConfiguration'] = function (pRequest, pRequestState, fCallback)
								{
									return tmpOriginal.call(this, pRequest, pRequestState,
										(pError) =>
										{
											// '!=' → '<>': same meaning, but a rewrite the cube's flags would bypass.
											pRequestState.Query.parameters.filter.forEach((pEntry) => { if (pEntry.Operator === '!=') { pEntry.Operator = '<>'; } });
											return fCallback(pError);
										});
								};
								runForm(K, tmpFixture, { Cube: 'Always', Staged: 'Never' }, {},
									(pError, pCube) =>
									{
										runForm(K, tmpFixture, { Cube: 'Never', Staged: 'Never' }, {},
											(pBaseError, pBase) =>
											{
												tmpFunctions['Reads-QueryConfiguration'] = tmpOriginal;
												Expect(pError).to.equal(null);
												Expect(pCube.CubeFallbacks).to.deep.equal([ 'cube0' ]);
												expectSameAnswers(pBase, pCube, 'transformed');
												Expect(pBase.Results['#Total'].Total).to.be.above(0);
												return fDone();
											});
									});
							});

						test('E1: the correlated and the pivot-restricted child aggregate (MyOverdue band) agree, in and out of the cube',
							(fDone) =>
							{
								runForm(K, FIXTURES[0], { Cube: 'Never', Staged: 'Never', ChildAgg: 'Restricted' }, {},
									(pError, pRestricted) =>
									{
										Expect(pError).to.equal(null);
										runForm(K, FIXTURES[0], { Cube: 'Always', Staged: 'Always', ChildAgg: 'Restricted' }, {},
											(pCubeError, pCube) =>
											{
												Expect(pCube.CubeFallbacks).to.deep.equal([]);
												runForm(K, FIXTURES[0], { Cube: 'Never', Staged: 'Never' }, {},
													(pBaseError, pBase) =>
													{
														expectSameAnswers(pBase, pRestricted, 'restricted');
														expectSameAnswers(pBase, pCube, 'restricted cube + staged');
														return fDone();
													});
											});
									});
							});
					}

					if (pDomain === 'LabTrack')
					{
						test('a staged hop whose On pairs repeat an inner column keeps BOTH correlations (staged == fused, narrower than one pair)',
							(fDone) =>
							{
								let tmpFixture = FIXTURES.find((pFixture) => { return pFixture.Name === 'RepeatedInnerColumn'; });
								runForm(K, tmpFixture, { Cube: 'Never', Staged: 'Always' }, {},
									(pError, pStaged) =>
									{
										Expect(pError).to.equal(null);
										Expect(pStaged.Errors).to.deep.equal({});
										Expect(pStaged.Staged.Relations).to.be.at.least(1);
										// NOT EXISTS over (IDMaterialIntake = p.IDMaterialIntake AND IDMaterialIntake = p.IDLabFormType)
										// keeps more rows than NOT EXISTS over the first pair alone.
										Expect(pStaged.Results.Repeated.Total).to.be.above(pStaged.Results.Loose.Total);
										runForm(K, tmpFixture, { Cube: 'Never', Staged: 'Never' }, {},
											(pFusedError, pFused) =>
											{
												Expect(pFusedError).to.equal(null);
												expectSameAnswers(pFused, pStaged, 'repeated inner column');
												return fDone();
											});
									});
							});

						test('MaxStagedKeys: 422 FACET_PATH_TOO_BROAD per facet from a facet hop, for the whole request from a Variant path predicate',
							(fDone) =>
							{
								let tmpOptions = libOptions.resolve(libOptions.deepMerge(K.faceting.options, { Limits: { MaxStagedKeys: 5 } }));
								runForm(K, FIXTURES.find((pFixture) => { return pFixture.Name === 'E3A'; }), { Cube: 'Never', Staged: 'Always' }, { Options: tmpOptions },
									(pError, pExecution) =>
									{
										Expect(pError).to.equal(null);
										Expect(pExecution.Errors.ToDo).to.include({ Code: 'FACET_PATH_TOO_BROAD', Status: 422 });
										Expect(pExecution.Errors.ToDo.Detail).to.deep.equal({ Limit: 'MaxStagedKeys', Max: 5, Suggest: { Engine: 'ClickHouse' } });
										let tmpPathPred = F.notExists(F.rel('LabForm', 'h9', [ 'IDLabForm', 'IDMaterialIntake', 'IDLabFormType' ], { Where: { Field: 'Status', Op: 'EQ', Value: 'Complete' }, Scope: 'TenantOnly', ScopeReason: 'test', Stage: 'Allowed' }),
											[ F.on('p', 'IDMaterialIntake', 'IDMaterialIntake'), F.on('p', 'IDLabFormType', 'IDLabFormType') ]);
										let tmpFixture = (
											{
												Name: 'PathPred', Entity: 'MaterialIntakeRequirement', Principal: 'Tech',
												Variants: () => { return { v0: F.variant('v0', 'MaterialIntakeRequirement', [ F.conjunct('c1', { NotExists: {} }, { Shape: 'Path', FoldPred: tmpPathPred }) ], tmpPathPred) }; },
												Aggs: () => { return [ F.agg({ Key: '#Total', Kind: 'Count', Pivot: 'MaterialIntakeRequirement' }) ]; }
											});
										runForm(K, tmpFixture, { Cube: 'Never', Staged: 'Always' }, { Options: tmpOptions },
											(pWholeError) =>
											{
												Expect(pWholeError).to.include({ Code: 'FACET_PATH_TOO_BROAD' });
												return fDone();
											});
									});
							});
					}
				}
			);
		});
};

suite
(
	'Facet-PlanForms',
	() =>
	{
		o5Suite('SQLite');

		suite
		(
			'A Staged key set of more than 1 000 keys equals the fused form',
			() =>
			{
				let K = null;
				suiteSetup(
					(fDone) =>
					{
						K = libKit.start(
							{
								Domain: 'LabTrack',
								// 1 500 extra completed forms on intakes that do not exist (they join nothing) plus 300 on
								// real requirements: the staged LabForm key set exceeds 1 000 distinct tuples.
								Mutate: (pRows) =>
								{
									let tmpID = 50000;
									for (let i = 0; i < 1500; i++)
									{
										tmpID++;
										pRows.LabForm.push({ IDLabForm: tmpID, GUIDLabForm: `big-${tmpID}`, Deleted: 0, IDMaterialIntake: 5000 + i, IDLabFormType: 1 + (i % 10), Status: 'Complete', OwnerIDUser: 4, IDCustomer: 1 });
									}
									for (let i = 0; i < 300; i++)
									{
										tmpID++;
										pRows.LabForm.push({ IDLabForm: tmpID, GUIDLabForm: `big-${tmpID}`, Deleted: 0, IDMaterialIntake: 1 + (i % 120), IDLabFormType: 1 + ((i * 7) % 10), Status: 'Complete', OwnerIDUser: 6, IDCustomer: 1 });
									}
								}
							}, fDone);
					});
				suiteTeardown((fDone) => { K.stop(fDone); });

				test('E3A Staged (> 1 000 composite keys, one scalar bind) == fused == the direct-SQL oracle',
					(fDone) =>
					{
						let tmpFixture = FIXTURES.find((pFixture) => { return pFixture.Name === 'E3A'; });
						runForm(K, tmpFixture, { Cube: 'Never', Staged: 'Always' }, {},
							(pError, pStaged) =>
							{
								Expect(pError).to.equal(null);
								Expect(pStaged.Staged.Keys).to.be.above(1500);
								runForm(K, tmpFixture, { Cube: 'Never', Staged: 'Never' }, {},
									(pFusedError, pFused) =>
									{
										expectSameAnswers(pFused, pStaged, 'big staged');
										let O = F.e3aOracle(K, 1, 1, true);
										Expect(F.groupList(pFused.Results.ToDo.Groups)).to.deep.equal(F.oracleList(O.ToDo));
										return fDone();
									});
							});
					});
			}
		);

		suite
		(
			'CubeExecutor.marginalize (pure)',
			() =>
			{
				test('members sum the grain rows whose RequireFlags (and RequireWhere) are all 1, grouped by their dims',
					() =>
					{
						let tmpExecutor = new libRetoldFacetingCubeExecutor(libBuilders.newFable('RetoldFacetingPlanForms'));
						let tmpPlan = (
							{
								CubeId: 'c', Pivot: 'X',
								Dims: [ { Column: 'd1', Dim: F.columnDim('Status', 'String') }, { Column: 'd2', Dim: F.dateDim('When', 'month') }, { Column: 'd3', Dim: { Kind: 'ExistsFlag', Field: 'f' } } ],
								Bounds: [ { Dim: 'd2', Lo: 'lo2', Hi: 'hi2' } ],
								Members:
								[
									{ AggKey: '#Total', Dims: [], RequireFlags: [ 'b1', 'b2' ], RequireWhere: null },
									{ AggKey: 'Status', Dims: [ 'd1' ], RequireFlags: [ 'b2' ], RequireWhere: null },
									{ AggKey: 'When', Dims: [ 'd2' ], RequireFlags: [ 'b1' ], RequireWhere: 'w1' },
									{ AggKey: 'Flag', Dims: [ 'd3' ], RequireFlags: [ 'b1', 'b2' ], RequireWhere: null },
									{ AggKey: 'Grid', Dims: [ 'd1', 'd2' ], RequireFlags: [ 'b1', 'b2' ], RequireWhere: null }
								]
							});
						let tmpAggs =
						[
							F.agg({ Key: '#Total', Kind: 'Count' }),
							F.agg({ Key: 'Status', Kind: 'Terms', Top: 1, SelectedKeys: [ 'C' ], Dimensions: [ F.columnDim('Status', 'String') ] }),
							F.agg({ Key: 'When', Kind: 'DateHistogram', Dimensions: [ F.dateDim('When', 'month') ] }),
							F.agg({ Key: 'Flag', Kind: 'ExistsSplit', Dimensions: [ { Kind: 'ExistsFlag', Field: 'f' } ] }),
							F.agg({ Key: 'Grid', Kind: 'Pivot', Dimensions: [ F.columnDim('Status', 'String'), F.dateDim('When', 'month') ] })
						];
						let tmpRows =
						[
							{ d1: 'A', d2: '2026-01-01 00:00:00', d3: 1, b1: 1, b2: 1, w1: 1, N: 5, lo2: '2026-01-03 00:00:00', hi2: '2026-01-20 10:00:00' },
							{ d1: 'A', d2: '2026-02-01 00:00:00', d3: 0, b1: 0, b2: 1, w1: 1, N: '2', lo2: '2026-02-02 00:00:00', hi2: '2026-02-02 00:00:00' },
							{ d1: 'B', d2: null, d3: 0, b1: 1, b2: 0, w1: 1, N: 3, lo2: null, hi2: null },
							{ d1: 'C', d2: '2026-03-01 00:00:00', d3: 1, b1: 1, b2: 1, w1: 0, N: 1, lo2: '2026-03-31 23:59:59', hi2: '2026-03-31 23:59:59' },
							{ d1: null, d2: '2026-01-01 00:00:00', d3: 0, b1: 1, b2: 1, w1: 1, N: 4, lo2: '2026-01-01 00:00:00', hi2: '2026-01-02 00:00:00' }
						];
						let tmpResult = tmpExecutor.marginalize(tmpPlan, tmpAggs, tmpRows, libOptions.resolve({}));
						Expect(tmpResult.Errors).to.deep.equal({});
						let R = tmpResult.Results;
						Expect(R['#Total'].Total).to.equal(10);
						// Status (b2 only): A 7, C 1, NULL 4 → Top 1 cut keeps A (rank 1) and B? no: B fails b2; C is selected.
						Expect(R.Status).to.include({ Total: 12, MissingCount: 4, DistinctKeys: 2 });
						Expect(F.groupList(R.Status.Groups)).to.deep.equal([ [ 'A', 7 ], [ 'C', 1 ] ]);
						// When (b1 and w1): Jan 5 + 4, NULL 3.
						Expect(R.When).to.include({ Total: 12, MissingCount: 3 });
						Expect(F.groupList(R.When.Groups)).to.deep.equal([ [ '2026-01-01 00:00:00', 9 ] ]);
						Expect(R.When.Bounds).to.deep.equal({ Lo: '2026-01-01 00:00:00', Hi: '2026-01-20 10:00:00' });
						Expect(R.Flag.Groups).to.deep.equal([ { Key: 1, Count: 6 }, { Key: 0, Count: 4 } ]);
						Expect(R.Grid.Total).to.equal(10);
						Expect(R.Grid.Cells.length).to.equal(3);
						// A Pivot past CubeMaxGroups is that member's 422, never the others'.
						let tmpTight = tmpExecutor.marginalize(tmpPlan, tmpAggs, tmpRows, libOptions.resolve({ Limits: { CubeMaxGroups: 2 } }));
						Expect(tmpTight.Errors.Grid).to.include({ Code: 'FACET_TOO_LARGE' });
						Expect(tmpTight.Results.Status.Total).to.equal(12);
					});

				test('the Terms cut reproduces the shell: ties at Top + 1 kept, MaxTermsGroups, selected keys always back',
					() =>
					{
						let tmpExecutor = new libRetoldFacetingCubeExecutor(libBuilders.newFable('RetoldFacetingPlanForms'));
						let tmpGroups = [ { Key: 'a', Count: 5 }, { Key: 'b', Count: 4 }, { Key: 'c', Count: 4 }, { Key: 'd', Count: 4 }, { Key: 'e', Count: 1 }, { Key: 'f', Count: 1 } ];
						let tmpDim = F.columnDim('X', 'String');
						let fKeys = (pAgg, pLimits) => { return tmpExecutor.termsCut(pAgg, tmpGroups, tmpDim, pLimits).map((pGroup) => { return pGroup.Key; }); };
						Expect(fKeys({ Top: 1 }, { MaxTermsGroups: 100 })).to.deep.equal([ 'a', 'b', 'c', 'd' ]);
						Expect(fKeys({ Top: 1 }, { MaxTermsGroups: 3 })).to.deep.equal([ 'a', 'b', 'c' ]);
						Expect(fKeys({ Top: 1, SelectedKeys: [ 'f' ] }, { MaxTermsGroups: 100 })).to.deep.equal([ 'a', 'b', 'c', 'd', 'f' ]);
						Expect(fKeys({ Top: 4 }, { MaxTermsGroups: 100 })).to.deep.equal([ 'a', 'b', 'c', 'd', 'e', 'f' ]);
					});

				test('eligibility: Multi, TuplePivot and Nice histograms are never cube members; Stats / Missing join as measures',
					() =>
					{
						let tmpExecutor = new libRetoldFacetingCubeExecutor(libBuilders.newFable('RetoldFacetingPlanForms'));
						let A = F.labCoverageAggs(1);
						Expect(tmpExecutor.eligible(A.RequirementBands)).to.equal(true);
						Expect(tmpExecutor.eligible(A.ByRequiredForm)).to.equal(false);
						Expect(tmpExecutor.eligible(F.e3bAggs(1)[0])).to.equal(false);
						Expect(tmpExecutor.eligible(F.agg({ Kind: 'NumericHistogram', Dimensions: [ { Kind: 'NumericBucket', Field: 'X', Mode: 'Nice' } ] }))).to.equal(false);
						Expect(tmpExecutor.eligible(F.agg({ Kind: 'NumericHistogram', Dimensions: [ { Kind: 'NumericBucket', Field: 'X', Mode: 'Edges', Edges: [ 0, 1 ] } ] }))).to.equal(true);
						Expect(tmpExecutor.eligible(F.agg({ Kind: 'Stats', Field: 'X' }))).to.equal(true);
						Expect(tmpExecutor.eligible(F.agg({ Kind: 'Missing', Field: 'X' }))).to.equal(true);
						Expect(tmpExecutor.eligible(F.agg({ Kind: 'Stats' }))).to.equal(false);
						Expect(tmpExecutor.eligible(F.agg({ Kind: 'DistinctCount', Field: 'X' }))).to.equal(false);
					});
			}
		);

		o5Suite('PostgreSQL');
	}
);
