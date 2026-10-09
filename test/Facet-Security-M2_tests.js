/**
 * Facet-Security-M2 tests (oracle O6 for M2; Builder C's engine-level part — the wiring agent adds the
 * HTTP-level 403 / 401 gates): per-hop scope on the Live engine.
 *
 *   - every hop is its own Scoped Relation: a hop whose tenancy behavior is missing is refused by
 *     ScopeGuard (Strict) — the whole request for a Variant path predicate hop, that facet only for a
 *     facet's own hop (§19.7);
 *   - the owner-scoped LabForm: an Inherit hop sees only the principal's own forms, a TenantOnly hop the
 *     tenant's, never another tenant's; the relaxation is refused (500, never a wider scope) when the
 *     owner column appears anywhere but the one exact depth-0 entry — even for a TrustedOpaque entity;
 *   - Opaque captures: an untrusted Opaque hop is a 500; a TrustedOpaque leaf hop runs Staged (its
 *     key query is the behavior's own, asserted to name every policy column with the principal's
 *     values); a TrustedOpaque non-leaf hop is 422 StagedNonLeaf; PlanForm Staged 'Never' refuses it;
 *   - a hop behavior's 401 fails the whole request;
 *   - Execution.Captures fingerprints every captured entity; TenantOnly fingerprints differ.
 *
 * Port 19128 (internal-contracts §32.4; the bench binds an ephemeral port).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libKit = require('./support/Facet-Live-M2-Kit.js');
const F = require('./support/Facet-Live-M2-FoldIR.js');

const PORT = 19128;

const READS = 'Reads-QueryConfiguration';

/**
 * Temporarily replace one behavior of one entity's route-bound controller (restored by the returned
 * function).
 *
 * @param {Record<string, any>} K
 * @param {string} pEntity
 * @param {Function|null} fBehavior - null removes it
 * @return {() => void}
 */
const swapBehavior = (K, pEntity, fBehavior) =>
{
	let tmpFunctions = K.fable.MeadowEndpoints[pEntity].controller.BehaviorInjection._BehaviorFunctions;
	let tmpOriginal = tmpFunctions[READS];
	if (fBehavior)
	{
		tmpFunctions[READS] = fBehavior;
	}
	else
	{
		delete tmpFunctions[READS];
	}
	return () => { tmpFunctions[READS] = tmpOriginal; };
};

/**
 * Run Aggs for a principal (context, then execute).
 */
const run = (K, pEntity, pPrincipal, pOverrides, pAggs, fCallback) =>
{
	K.context(pEntity, pPrincipal, pOverrides,
		(pContextError, pContext) =>
		{
			if (pContextError)
			{
				return fCallback(pContextError);
			}
			K.execute(K.fable.RetoldFacetingEngineLive, pContext, pAggs, fCallback);
		});
};

const variants = (pEntity) =>
{
	return { Variants: { v0: F.variant('v0', pEntity, [], null), vt: F.variant('vt', pEntity, [], null) } };
};

/**
 * The tenancy behavior with an extra mutation of the query after it.
 *
 * @param {(pQuery: any, pSession: Record<string, any>) => void} fMutate
 * @return {Function}
 */
const tenancyThen = (fMutate) =>
{
	return function (pRequest, pRequestState, fCallback)
	{
		let tmpSession = pRequestState.SessionData || {};
		pRequestState.Query.addFilter('IDCustomer', tmpSession.CustomerID, '=', 'AND', 'TestTenancy');
		fMutate(pRequestState.Query, tmpSession);
		return fCallback();
	};
};

suite
(
	'Facet-Security-M2',
	() =>
	{
		suite
		(
			'Per-hop scope on LabTrack (Live)',
			() =>
			{
				let K = null;

				suiteSetup((fDone) => { K = libKit.start({ Domain: 'LabTrack', LogLevel: process.env.RFS_LOG || 'fatal' }, fDone); });
				suiteTeardown((fDone) => { K.stop(fDone); });

				test('a facet hop without its tenancy behavior is refused (500, that facet only); a Variant path-predicate hop fails the whole request',
					(fDone) =>
					{
						let fRestore = swapBehavior(K, 'LabQueue', null);
						let tmpAggs = F.e3aAggs(1, 'TenantOnly').slice(0, 1).concat([ F.agg({ Key: 'Plain', Kind: 'Terms', Pivot: 'MaterialIntakeRequirement', VariantId: 'v0', Dimensions: [ F.columnDim('IDLabFormType', 'Numeric') ] }) ]);
						run(K, 'MaterialIntakeRequirement', 'Tech', variants('MaterialIntakeRequirement'), tmpAggs,
							(pError, pExecution) =>
							{
								if (pError)
								{
									fRestore();
								}
								Expect(pError).to.equal(null);
								// A 5xx entry carries only the canonical message, never the rule list.
								Expect(pExecution.Errors.ToDo).to.include({ Code: 'FACET_SCOPE_POLICY_VIOLATION', Status: 500 });
								Expect(pExecution.Errors.ToDo).to.not.have.property('Detail');
								Expect(pExecution.Results.Plain.Total).to.be.above(0);
								let tmpPathPred = F.labQueuePath('p', 'h1', 'h2', 1);
								let tmpVariants = { v0: F.variant('v0', 'MaterialIntake', [ F.conjunct('c1', { Exists: {} }, { Shape: 'Path', FoldPred: tmpPathPred }) ], tmpPathPred) };
								run(K, 'MaterialIntake', 'Tech', { Variants: tmpVariants }, [ F.agg({ Key: '#Total', Kind: 'Count', Pivot: 'MaterialIntake' }) ],
									(pWholeError) =>
									{
										fRestore();
										Expect(pWholeError).to.include({ Code: 'FACET_SCOPE_POLICY_VIOLATION' });
										Expect(pWholeError.Detail.Violations).to.deep.equal([ { Rule: 'MissingPredicate', Column: 'IDCustomer' } ]);
										return fDone();
									});
							});
					});

				test('a hop behavior widening the tenant (OR at depth 0) is refused; a wrong tenant value is refused',
					(fDone) =>
					{
						let fRestore = swapBehavior(K, 'LabQueueMember', tenancyThen((pQuery) => { pQuery.addFilter('IDCustomer', 2, '=', 'OR', 'Widen'); }));
						run(K, 'MaterialIntakeRequirement', 'Tech', variants('MaterialIntakeRequirement'), F.e3aAggs(1, 'TenantOnly').slice(0, 1),
							(pError, pExecution) =>
							{
								fRestore();
								Expect(pError).to.equal(null);
								Expect(pExecution.Errors.ToDo).to.include({ Code: 'FACET_SCOPE_POLICY_VIOLATION' });
								let fRestoreWrong = swapBehavior(K, 'LabQueueMember', function (pRequest, pRequestState, fCallback)
								{
									pRequestState.Query.addFilter('IDCustomer', 2, '=', 'AND', 'WrongTenant');
									return fCallback();
								});
								run(K, 'MaterialIntakeRequirement', 'Tech', variants('MaterialIntakeRequirement'), F.e3aAggs(1, 'TenantOnly').slice(0, 1),
									(pWrongError, pWrong) =>
									{
										fRestoreWrong();
										Expect(pWrong.Errors.ToDo).to.include({ Code: 'FACET_SCOPE_POLICY_VIOLATION' });
										return fDone();
									});
							});
					});

				test('TenantOnly is refused when the owner column appears anywhere else (under OR, with IN, twice) — even for a TrustedOpaque LabForm',
					(fDone) =>
					{
						let tmpMutations =
						[
							(pQuery, pSession) => { pQuery.addFilter('OwnerIDUser', pSession.UserID, '=', 'AND', 'TestOwner'); pQuery.addFilter('OwnerIDUser', 2, '=', 'OR', 'AlsoColleague'); },
							(pQuery, pSession) => { pQuery.addFilter('OwnerIDUser', [ pSession.UserID ], 'IN', 'AND', 'TestOwner'); },
							(pQuery, pSession) => { pQuery.addFilter('OwnerIDUser', pSession.UserID, '=', 'AND', 'TestOwner'); pQuery.addFilter('OwnerIDUser', pSession.UserID, '=', 'AND', 'Again'); },
							(pQuery, pSession) => { pQuery.addFilter('', '', '(', 'AND', 'Group'); pQuery.addFilter('OwnerIDUser', pSession.UserID, '=', 'AND', 'TestOwner'); pQuery.addFilter('', '', ')', 'AND', 'GroupEnd'); }
						];
						let tmpTrusted = K.faceting.options.Scope.TrustedOpaque;
						let fNext = (pIndex, pTrusted) =>
						{
							if (pIndex >= tmpMutations.length)
							{
								if (!pTrusted)
								{
									// Again with LabForm trusted: a refused relaxation is never staged.
									K.faceting.options.Scope.TrustedOpaque = [ 'LabForm' ];
									return fNext(0, true);
								}
								K.faceting.options.Scope.TrustedOpaque = tmpTrusted;
								return fDone();
							}
							let fRestore = swapBehavior(K, 'LabForm', tenancyThen(tmpMutations[pIndex]));
							run(K, 'MaterialIntakeRequirement', 'Tech', variants('MaterialIntakeRequirement'), F.e3aAggs(1, 'TenantOnly').slice(0, 1),
								(pError, pExecution) =>
								{
									fRestore();
									Expect(pError).to.equal(null);
									Expect(pExecution.Errors.ToDo, `mutation ${pIndex} trusted ${pTrusted}`).to.include({ Code: 'FACET_SCOPE_POLICY_VIOLATION', Status: 500 });
									return fNext(pIndex + 1, pTrusted);
								});
						};
						fNext(0, false);
					});

				test('an untrusted Opaque hop (the behavior replaced the query) is a 500; trusted, the leaf hop runs Staged and agrees with the fused answer',
					(fDone) =>
					{
						// A behavior that REPLACES the query but keeps the scoped WHERE (tenancy bound).
						let tmpOverride = function (pRequest, pRequestState, fCallback)
						{
							pRequestState.Query.addFilter('IDCustomer', pRequestState.SessionData.CustomerID, '=', 'AND', 'TestTenancy');
							pRequestState.Query.parameters.queryOverride = 'SELECT `IDLabQueue`, `IDLabQueueMember` FROM LabQueueMember<%= Where %>';
							return fCallback();
						};
						let tmpAggs = F.e3aAggs(1, 'TenantOnly').slice(0, 1);
						run(K, 'MaterialIntakeRequirement', 'Tech', variants('MaterialIntakeRequirement'), tmpAggs,
							(pFusedError, pFused) =>
							{
								Expect(pFusedError).to.equal(null);
								let fRestore = swapBehavior(K, 'LabQueueMember', tmpOverride);
								run(K, 'MaterialIntakeRequirement', 'Tech', variants('MaterialIntakeRequirement'), tmpAggs,
									(pError, pUntrusted) =>
									{
										Expect(pError).to.equal(null);
										Expect(pUntrusted.Errors.ToDo).to.include({ Code: 'FACET_SCOPE_POLICY_VIOLATION' });
										let tmpTrusted = K.faceting.options.Scope.TrustedOpaque;
										K.faceting.options.Scope.TrustedOpaque = [ 'LabQueueMember' ];
										run(K, 'MaterialIntakeRequirement', 'Tech', variants('MaterialIntakeRequirement'), tmpAggs,
											(pTrustedError, pTrustedRun) =>
											{
												Expect(pTrustedError).to.equal(null);
												Expect(pTrustedRun.Errors).to.deep.equal({});
												Expect(pTrustedRun.Staged.Relations).to.equal(1);
												Expect(F.normalizeRaw(pTrustedRun.Results.ToDo)).to.deep.equal(F.normalizeRaw(pFused.Results.ToDo));
												// PlanForm Staged Never: the trusted Opaque hop is refused.
												run(K, 'MaterialIntakeRequirement', 'Tech', Object.assign(variants('MaterialIntakeRequirement'), { PlanForm: { Staged: 'Never' } }), tmpAggs,
													(pNeverError, pNever) =>
													{
														Expect(pNever.Errors.ToDo).to.include({ Code: 'FACET_SCOPE_POLICY_VIOLATION' });
														K.faceting.options.Scope.TrustedOpaque = tmpTrusted;
														fRestore();
														return fDone();
													});
											});
									});
							});
					});

				test('a trusted replaced query must still show every policy column with the principal\'s value (else 500); a trusted non-leaf hop is 422 StagedNonLeaf',
					(fDone) =>
					{
						let tmpTrusted = K.faceting.options.Scope.TrustedOpaque;
						K.faceting.options.Scope.TrustedOpaque = [ 'LabQueueMember', 'LabQueue' ];
						// The override drops the WHERE: no tenancy in the rendered SQL.
						let fRestore = swapBehavior(K, 'LabQueueMember', function (pRequest, pRequestState, fCallback)
						{
							pRequestState.Query.addFilter('IDCustomer', pRequestState.SessionData.CustomerID, '=', 'AND', 'TestTenancy');
							pRequestState.Query.parameters.queryOverride = 'SELECT `IDLabQueue` FROM LabQueueMember';
							return fCallback();
						});
						run(K, 'MaterialIntakeRequirement', 'Tech', variants('MaterialIntakeRequirement'), F.e3aAggs(1, 'TenantOnly').slice(0, 1),
							(pError, pExecution) =>
							{
								fRestore();
								Expect(pError).to.equal(null);
								Expect(pExecution.Errors.ToDo).to.include({ Code: 'FACET_SCOPE_POLICY_VIOLATION' });
								// LabQueue (j2) is not a leaf: trusted but Opaque → 422.
								let fRestoreQueue = swapBehavior(K, 'LabQueue', function (pRequest, pRequestState, fCallback)
								{
									pRequestState.Query.addFilter('IDCustomer', pRequestState.SessionData.CustomerID, '=', 'AND', 'TestTenancy');
									pRequestState.Query.parameters.queryOverride = 'SELECT `IDLabQueue` FROM LabQueue<%= Where %>';
									return fCallback();
								});
								run(K, 'MaterialIntakeRequirement', 'Tech', variants('MaterialIntakeRequirement'), F.e3aAggs(1, 'TenantOnly').slice(0, 1),
									(pQueueError, pQueue) =>
									{
										fRestoreQueue();
										K.faceting.options.Scope.TrustedOpaque = tmpTrusted;
										Expect(pQueueError).to.equal(null);
										Expect(pQueue.Errors.ToDo).to.include({ Code: 'FACET_FOLD_UNSUPPORTED', Status: 422 });
										return fDone();
									});
							});
					});

				test('a trusted replaced query is checked exactly: no WHERE, an OR after it, a UNION, or a queryBranches replacement is a 500 (never a wider count)',
					(fDone) =>
					{
						let tmpTrusted = K.faceting.options.Scope.TrustedOpaque;
						K.faceting.options.Scope.TrustedOpaque = [ 'LabQueueMember' ];
						let tmpAggs = F.e3aAggs(1, 'TenantOnly').slice(0, 1);
						let tmpOverrides =
							[
								// Every column the policy names appears, and a bind holds the tenant (the behavior's own
								// filter entry) — but the template never renders the WHERE: every tenant's rows.
								(pQuery) => { pQuery.parameters.queryOverride = 'SELECT `IDLabQueue`, `IDUser`, `IDCustomer` FROM LabQueueMember'; },
								(pQuery) => { pQuery.parameters.queryOverride = 'SELECT `IDLabQueue`, `IDLabQueueMember` FROM LabQueueMember<%= Where %> OR 1 = 1'; },
								(pQuery) => { pQuery.parameters.queryOverride = 'SELECT `IDLabQueue`, `IDLabQueueMember` FROM LabQueueMember<%= Where %> UNION SELECT `IDLabQueue`, `IDLabQueueMember` FROM LabQueueMember'; },
								(pQuery) => { pQuery.parameters.queryOverride = 'SELECT `IDLabQueue`, `IDLabQueueMember` FROM LabQueueMember<%= Where %><%= Where %>'; },
								(pQuery) => { pQuery.parameters.queryBranches = [ { Any: true } ]; }
							];
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpOverrides.length)
							{
								K.faceting.options.Scope.TrustedOpaque = tmpTrusted;
								return fDone();
							}
							let fRestore = swapBehavior(K, 'LabQueueMember', tenancyThen(tmpOverrides[pIndex]));
							run(K, 'MaterialIntakeRequirement', 'Tech', variants('MaterialIntakeRequirement'), tmpAggs,
								(pError, pExecution) =>
								{
									fRestore();
									Expect(pError).to.equal(null);
									Expect(pExecution.Errors.ToDo, `override ${pIndex}`).to.include({ Code: 'FACET_SCOPE_POLICY_VIOLATION', Status: 500 });
									return fNext(pIndex + 1);
								});
						};
						return fNext(0);
					});

				test('a memoized trusted Opaque capture replays the behavior\'s own query (not just its filter) for a second projection of the same hop',
					(fDone) =>
					{
						let tmpTrusted = K.faceting.options.Scope.TrustedOpaque;
						K.faceting.options.Scope.TrustedOpaque = [ 'LabQueueMember' ];
						let tmpRuns = 0;
						let fRestore = swapBehavior(K, 'LabQueueMember', function (pRequest, pRequestState, fCallback)
						{
							tmpRuns++;
							pRequestState.Query.addFilter('IDCustomer', pRequestState.SessionData.CustomerID, '=', 'AND', 'TestTenancy');
							// Only ACTIVE memberships of the queue (a narrowing the filter alone does not show).
							pRequestState.Query.parameters.queryOverride = 'SELECT `IDLabQueue`, `IDLabQueueMember`, `IDUser` FROM LabQueueMember<%= Where %> AND `Active` = 1';
							return fCallback();
						});
						let tmpMember = (pAlias, pProject) => { return F.rel('LabQueueMember', pAlias, pProject, { Where: { Field: 'IDUser', Op: 'EQ', Value: 1 }, Stage: 'Allowed' }); };
						let fQueuePath = (pQueueAlias, pMemberAlias, pProject) =>
						{
							return F.exists(F.rel('LabQueue', pQueueAlias, [ 'IDLabQueue' ]), [ F.on('p', 'IDLabQueue', 'IDLabQueue') ],
								F.exists(tmpMember(pMemberAlias, pProject), [ F.on(pQueueAlias, 'IDLabQueue', 'IDLabQueue') ]));
						};
						let tmpAggs =
						[
							F.agg({ Key: 'A', Kind: 'Count', Pivot: 'MaterialIntake', Where: fQueuePath('j1', 'j2', [ 'IDLabQueueMember', 'IDLabQueue' ]), WhereHash: 'wh:a' }),
							F.agg({ Key: 'B', Kind: 'Count', Pivot: 'MaterialIntake', Where: fQueuePath('j3', 'j4', [ 'IDLabQueueMember', 'IDLabQueue', 'IDUser' ]), WhereHash: 'wh:b' })
						];
						run(K, 'MaterialIntake', 'Tech', variants('MaterialIntake'), tmpAggs,
							(pError, pExecution) =>
							{
								fRestore();
								K.faceting.options.Scope.TrustedOpaque = tmpTrusted;
								Expect(pError).to.equal(null);
								Expect(pExecution.Errors).to.deep.equal({});
								Expect(tmpRuns, 'the behavior ran once; the second projection replayed it').to.equal(1);
								Expect(pExecution.Staged.Relations).to.equal(2);
								let tmpExpected = K.sql(`SELECT count(*) AS N FROM MaterialIntake i WHERE ${F.visible('i', 1)} AND EXISTS (SELECT 1 FROM LabQueue q WHERE ${F.visible('q', 1)} AND q.IDLabQueue = i.IDLabQueue`
									+ ` AND EXISTS (SELECT 1 FROM LabQueueMember m WHERE ${F.visible('m', 1)} AND m.IDLabQueue = q.IDLabQueue AND m.IDUser = 1 AND m.Active = 1))`)[0].N;
								Expect(pExecution.Results.A.Total).to.equal(tmpExpected);
								Expect(pExecution.Results.B.Total).to.equal(tmpExpected);
								return fDone();
							});
					});

				test('a hop behavior\'s 401 fails the whole request',
					(fDone) =>
					{
						K.context('MaterialIntakeRequirement', 'Tech', variants('MaterialIntakeRequirement'),
							(pContextError, pContext) =>
							{
								// The LabForm owner behavior needs UserID: drop it from the session (the principal stays).
								delete pContext.Request.UserSession.UserID;
								K.execute(K.fable.RetoldFacetingEngineLive, pContext, F.e3aAggs(1, 'Inherit').slice(0, 1),
									(pError) =>
									{
										Expect(pError).to.include({ Code: 'FACET_UNAUTHENTICATED', Status: 401 });
										return fDone();
									});
							});
					});

				test('Execution.Captures: one fingerprint entry per captured entity, the relaxed LabForm distinct from the Inherit one',
					(fDone) =>
					{
						let tmpAggs = F.e3aAggs(1, 'TenantOnly').slice(0, 1).concat(F.e3aAggs(1, 'Inherit').slice(4, 5));
						run(K, 'MaterialIntakeRequirement', 'Tech', variants('MaterialIntakeRequirement'), tmpAggs,
							(pError, pExecution) =>
							{
								Expect(pError).to.equal(null);
								Expect(pExecution.Errors).to.deep.equal({});
								// LabForm captured twice: TenantOnly (ToDo's anti-join) and Inherit (Started).
								Expect(pExecution.Captures.LabForm.Fingerprints.length).to.equal(2);
								Expect(pExecution.Captures.LabForm.Fingerprint).to.equal(pExecution.Captures.LabForm.Fingerprints.join(','));
								[ 'MaterialIntakeRequirement', 'MaterialIntake', 'LabQueue', 'LabQueueMember' ].forEach((pEntity) => { Expect(pExecution.Captures[pEntity].Fingerprints.length, pEntity).to.equal(1); });
								return fDone();
							});
					});

				test('two tenants: the same plan as tenant 2 never counts a tenant-1 row on any hop',
					(fDone) =>
					{
						run(K, 'MaterialIntake', 'OtherTech', variants('MaterialIntake'), F.e3bAggs(101),
							(pError, pExecution) =>
							{
								Expect(pError).to.equal(null);
								let O = F.e3bOracle(K, 2, 101);
								Expect(pExecution.Results.Total.Total).to.equal(O.Total);
								let tmpTenant1Intakes = K.sql('SELECT IDMaterialIntake AS ID FROM MaterialIntake WHERE IDCustomer = 1').map((pRow) => { return pRow.ID; });
								let tmpKeys = K.sql(`SELECT DISTINCT i.IDMaterialIntake AS ID FROM MaterialIntake i WHERE ${F.visible('i', 2)}`).map((pRow) => { return pRow.ID; });
								tmpKeys.forEach((pKey) => { Expect(tmpTenant1Intakes).to.not.include(pKey); });
								// Tenant 2's intake 1026 points at tenant-1 queue 1: its queue path fails existence.
								Expect(K.sql(`SELECT count(*) AS N FROM MaterialIntake i WHERE i.IDMaterialIntake = 1026 AND EXISTS (SELECT 1 FROM LabQueue q WHERE ${F.visible('q', 2)} AND q.IDLabQueue = i.IDLabQueue)`)[0].N).to.equal(0);
								return fDone();
							});
					});
			}
		);
	}
);
