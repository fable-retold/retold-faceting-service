/**
 * Facet-Live-Unit tests: ScopeGuard (every rule, every mode), ScopeCapture (Appended /
 * Transformed / Opaque, fingerprints, memoized replay, behavior 401), ScopedRelationBuilder (fence,
 * explicit soft-delete, tenancy at depth 0, renamed binds, memo, budgets, Opaque refusal) and the
 * Live engine itself — compared fold by fold against the Reference engine (O1 at the RawFacetResult
 * level) on the seeded Bookstore and Bookstore-Tenant fixtures, through the real route-bound
 * controllers of a booted retold-data-service.
 *
 * Port 19104 (internal-contracts §14.4); the two harnesses run one after the other on it.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libFoxHound = require('foxhound');

const libHarness = require('./support/Facet-Test-Harness.js');
const libBuilders = require('./support/Facet-Test-Builders.js');
const libFacetBuckets = require('../source/contract/Facet-Contract-Buckets.js');
const libOptions = require('../source/Retold-Faceting-Service-Options.js');

const libRetoldFacetingScopeGuard = require('../source/security/Retold-Faceting-ScopeGuard.js');
const libRetoldFacetingScopeCapture = require('../source/security/Retold-Faceting-ScopeCapture.js');
const libFacetEnvelope = require('../source/contract/Facet-Contract-Envelope.js');

const PORT = 19104;

// The default Limits.MaxDateBuckets (the DateHistogram shell returns at most this + 2 key rows).
const MAX_DATE_BUCKETS = libOptions.DEFAULTS.Limits.MaxDateBuckets;

// ---------------------------------------------------------------- helpers

const newFable = () => { return libBuilders.newFable('RetoldFacetingLiveUnit'); };

const conjunct = libBuilders.conjunct;

const variant = libBuilders.variant;

/**
 * A request context (internal-contracts §2.2) for driving engines directly.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity
 * @param {Record<string, any>} pVariants
 * @param {{ Tenant?: number, User?: number }} [pSession]
 * @param {Record<string, any>} [pOverrides]
 * @return {Record<string, any>}
 */
const newContext = (pHarness, pEntity, pVariants, pSession, pOverrides) =>
{
	let tmpSession = pSession || {};
	let tmpTenant = (typeof(tmpSession.Tenant) === 'number') ? tmpSession.Tenant : null;
	return Object.assign(
		{
			RequestID: 'rfq-live-unit',
			Entity: pEntity,
			Request: libHarness.syntheticRequest(pEntity, tmpSession),
			Host: pHarness.fable.RetoldFacetingHostDataService,
			Options: pHarness.faceting.options,
			Principal: Object.freeze(
				{
					Kind: (tmpTenant !== null) ? 'User' : 'Anonymous', Source: 'InProcess', IDUser: tmpSession.User || 0, IDCustomer: tmpTenant || 0,
					ScopeValues: (tmpTenant !== null) ? { IDTenant: tmpTenant } : {}, UserRecord: {}, RoleSetHash: '', ResolvedAt: 0
				}),
			NormalizedRequest: null,
			FilterAST: null,
			Variants: pVariants,
			Dialect: 'SQLite',
			Now: '2026-10-08T15:02:11.120Z',
			Deadline: Date.now() + 30000,
			ForceEngine: null,
			Memo: { Relations: {}, Captures: {}, VariantRows: {} },
			Counters: { Relations: 0, BehaviorRuns: 0, Statements: 0 },
			Warnings: []
		}, pOverrides || {});
};

/**
 * Run an engine and leave its stack before asserting.
 */
const execute = (pEngine, pContext, pAggs, fCallback) =>
{
	pEngine.execute(pContext, pAggs,
		(pError, pExecution) =>
		{
			setImmediate(() => { fCallback(pError, pExecution); });
		});
};

/**
 * An Agg (internal-contracts §5.1) for a catalog column.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pKey
 * @param {string} pKind
 * @param {string} pEntity
 * @param {Record<string, any>} pSpec - Field, Interval, Top, Order, Mode, Buckets, Edges, OpenEnded, Ranges, Axes, VariantId
 * @return {Record<string, any>}
 */
const agg = (pHarness, pKey, pKind, pEntity, pSpec) =>
{
	let tmpSpec = pSpec || {};
	let tmpCatalog = pHarness.fable.RetoldFacetingCatalog;
	let fInfo = (pField) =>
	{
		let tmpInfo = tmpCatalog.column(pEntity, pField);
		if (!tmpInfo)
		{
			throw new Error(`test: no catalog column ${pEntity}.${pField}`);
		}
		return tmpInfo;
	};
	let fDimension = (pDimensionSpec) =>
	{
		let tmpInfo = fInfo(pDimensionSpec.Field);
		switch (pDimensionSpec.Kind)
		{
			case 'Column':
				return { Kind: 'Column', Field: pDimensionSpec.Field, DataType: tmpInfo.DataType, IsInteger: tmpInfo.IsInteger, Scale: tmpInfo.Scale };
			case 'DateBucket':
				return { Kind: 'DateBucket', Field: pDimensionSpec.Field, Interval: pDimensionSpec.Interval || 'month' };
			case 'NumericBucket':
				return { Kind: 'NumericBucket', Field: pDimensionSpec.Field, Mode: pDimensionSpec.Mode || 'Nice', Buckets: pDimensionSpec.Buckets || 20, Edges: pDimensionSpec.Edges || null, OpenEnded: !!pDimensionSpec.OpenEnded, IsInteger: tmpInfo.IsInteger, Scale: tmpInfo.Scale };
			case 'Range':
				return { Kind: 'Range', Field: pDimensionSpec.Field, Ranges: pDimensionSpec.Ranges, IsInteger: tmpInfo.IsInteger, Scale: tmpInfo.Scale };
			default:
				throw new Error('test: dimension kind');
		}
	};
	let tmpDimensions = [];
	let tmpField = tmpSpec.Field || null;
	switch (pKind)
	{
		case 'Terms':
			tmpDimensions = [ fDimension({ Kind: 'Column', Field: tmpSpec.Field }) ];
			break;
		case 'DateHistogram':
			tmpDimensions = [ fDimension({ Kind: 'DateBucket', Field: tmpSpec.Field, Interval: tmpSpec.Interval }) ];
			break;
		case 'NumericHistogram':
			tmpDimensions = [ fDimension(Object.assign({ Kind: 'NumericBucket' }, tmpSpec)) ];
			break;
		case 'Ranges':
			tmpDimensions = [ fDimension({ Kind: 'Range', Field: tmpSpec.Field, Ranges: tmpSpec.Ranges }) ];
			break;
		case 'Pivot':
			tmpDimensions = tmpSpec.Axes.map(fDimension);
			tmpField = null;
			break;
		default:
			break;
	}
	return (
		{
			Key: pKey,
			FacetID: tmpField ? `${pEntity}.${tmpField}` : pEntity,
			Kind: pKind,
			Pivot: pEntity,
			Dimensions: tmpDimensions,
			Field: tmpField,
			FieldInfo: ((pKind === 'Stats') || (pKind === 'DistinctCount') || (pKind === 'Missing')) ? fInfo(tmpField) : null,
			Measures: [ { Op: 'count' } ],
			CountMode: 'Rows',
			Top: (pKind === 'Terms') ? ((typeof(tmpSpec.Top) === 'number') ? tmpSpec.Top : 20) : null,
			Order: tmpSpec.Order || 'CountDesc',
			Missing: true,
			EmptyBuckets: true,
			Chart: false,
			Exclude: 'Self',
			VariantId: tmpSpec.VariantId || 'v0'
		});
};

/**
 * Groups / cells as a comparable map (zero counts dropped; keys typed).
 *
 * @param {Array<{ Key?: any, Keys?: Array<any>, Count: number }>} pEntries
 * @return {Record<string, number>}
 */
const countMap = (pEntries) =>
{
	let tmpMap = {};
	(pEntries || []).forEach(
		(pEntry) =>
		{
			if (pEntry.Count > 0)
			{
				let tmpKey = Array.isArray(pEntry.Keys) ? JSON.stringify(pEntry.Keys) : JSON.stringify(pEntry.Key);
				tmpMap[tmpKey] = (tmpMap[tmpKey] || 0) + pEntry.Count;
			}
		});
	return tmpMap;
};

/**
 * O1 at the raw level: a Live RawFacetResult equals the Reference one for the same Agg.
 *
 * @param {Record<string, any>} pAgg
 * @param {Record<string, any>} pLive
 * @param {Record<string, any>} pReference
 */
const expectSameRaw = (pAgg, pLive, pReference) =>
{
	let tmpLabel = `${pAgg.Key} (${pAgg.Kind})`;
	Expect(pLive, `${tmpLabel} live`).to.be.an('object');
	Expect(pReference, `${tmpLabel} reference`).to.be.an('object');
	Expect(pLive.Kind, tmpLabel).to.equal(pReference.Kind);
	Expect(pLive.VariantId, tmpLabel).to.equal(pReference.VariantId);
	if ((pAgg.Kind === 'DateHistogram') && (pReference.Groups.length > MAX_DATE_BUCKETS))
	{
		// More keys than MaxDateBuckets: the Live statement stops at MaxDateBuckets + 2 key rows
		// (the facet is FACET_INTERVAL_TOO_FINE whatever the rest holds, on both engines).
		Expect(pLive.Groups.length, `${tmpLabel} capped key rows`).to.be.within(MAX_DATE_BUCKETS + 1, MAX_DATE_BUCKETS + 2);
		Expect(() => { libFacetEnvelope.buildFacetResult(pAgg, pLive, { Limits: { MaxDateBuckets: MAX_DATE_BUCKETS } }); }, `${tmpLabel} live`).to.throw().with.property('Code', 'FACET_INTERVAL_TOO_FINE');
		Expect(() => { libFacetEnvelope.buildFacetResult(pAgg, pReference, { Limits: { MaxDateBuckets: MAX_DATE_BUCKETS } }); }, `${tmpLabel} reference`).to.throw().with.property('Code', 'FACET_INTERVAL_TOO_FINE');
		return;
	}
	Expect(pLive.Total, `${tmpLabel} Total`).to.equal(pReference.Total);
	if (pAgg.Kind !== 'Pivot')
	{
		Expect(pLive.MissingCount, `${tmpLabel} MissingCount`).to.equal(pReference.MissingCount);
	}
	switch (pAgg.Kind)
	{
		case 'Terms':
			{
				Expect(pLive.DistinctKeys, `${tmpLabel} DistinctKeys`).to.equal(pReference.DistinctKeys);
				let tmpReferenceMap = countMap(pReference.Groups);
				let tmpLiveMap = countMap(pLive.Groups);
				Object.keys(tmpLiveMap).forEach((pKey) => { Expect(tmpLiveMap[pKey], `${tmpLabel} group ${pKey}`).to.equal(tmpReferenceMap[pKey]); });
				// Live must return at least the canonical first min(Top + 1, DistinctKeys) groups BY COUNT,
				// whatever the Order (the kept set is the top by count; Order only re-sorts it).
				let tmpCanonical = pReference.Groups.filter((pGroup) => { return pGroup.Count > 0; }).slice().sort(
					(pA, pB) =>
					{
						return (pB.Count - pA.Count) || libFacetBuckets.compareKeys(pA.Key, pB.Key);
					});
				let tmpNeeded = Math.min(((typeof(pAgg.Top) === 'number') ? pAgg.Top : 20) + 1, tmpCanonical.length);
				for (let i = 0; i < tmpNeeded; i++)
				{
					Expect(tmpLiveMap, `${tmpLabel} must include canonical key #${i}`).to.have.property(JSON.stringify(tmpCanonical[i].Key));
				}
			}
			break;
		case 'DateHistogram':
			Expect(countMap(pLive.Groups), `${tmpLabel} groups`).to.deep.equal(countMap(pReference.Groups));
			Expect(pLive.Bounds, `${tmpLabel} Bounds`).to.deep.equal(pReference.Bounds);
			break;
		case 'NumericHistogram':
			Expect(countMap(pLive.Groups), `${tmpLabel} groups`).to.deep.equal(countMap(pReference.Groups));
			Expect(pLive.Bounds, `${tmpLabel} Bounds`).to.deep.equal(pReference.Bounds);
			Expect(pLive.Geometry, `${tmpLabel} Geometry`).to.deep.equal(pReference.Geometry);
			break;
		case 'Ranges':
			Expect(countMap(pLive.Groups), `${tmpLabel} groups`).to.deep.equal(countMap(pReference.Groups));
			break;
		case 'Stats':
			Expect(pLive.Stats, `${tmpLabel} Stats`).to.deep.equal(pReference.Stats);
			break;
		case 'DistinctCount':
			Expect(pLive.DistinctCount, `${tmpLabel} DistinctCount`).to.equal(pReference.DistinctCount);
			break;
		case 'Pivot':
			Expect(countMap(pLive.Cells), `${tmpLabel} cells`).to.deep.equal(countMap(pReference.Cells));
			break;
		default:
			break;
	}
};

/**
 * Run Live and Reference on twin contexts and compare every Agg.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity
 * @param {() => Record<string, any>} fVariants - fresh Variants per engine
 * @param {Array<Record<string, any>>} pAggs
 * @param {Record<string, any>} pSession
 * @param {(pLive: Record<string, any>, pReference: Record<string, any>) => void} fDone
 */
const compareEngines = (pHarness, pEntity, fVariants, pAggs, pSession, fDone) =>
{
	execute(pHarness.fable.RetoldFacetingEngineLive, newContext(pHarness, pEntity, fVariants(), pSession), pAggs,
		(pLiveError, pLive) =>
		{
			Expect(pLiveError, 'live error').to.equal(null);
			execute(pHarness.fable.RetoldFacetingEngineReference, newContext(pHarness, pEntity, fVariants(), pSession, { ForceEngine: 'Reference' }), pAggs,
				(pReferenceError, pReference) =>
				{
					Expect(pReferenceError, 'reference error').to.equal(null);
					Expect(pLive.Errors, 'live per-facet errors').to.deep.equal({});
					Expect(pReference.Errors, 'reference per-facet errors').to.deep.equal({});
					Expect(pLive.Engine).to.equal('Live');
					pAggs.forEach((pAgg) => { expectSameRaw(pAgg, pLive.Results[pAgg.Key], pReference.Results[pAgg.Key]); });
					return fDone(pLive, pReference);
				});
		});
};

/**
 * A FoxHound query with a filter built from compact entries, for guard unit tests.
 *
 * @param {Array<Array<any>>} pEntries - [ Column, Value, Operator, Connector, Parameter ]
 * @return {any}
 */
const filterQuery = (pEntries) =>
{
	let tmpQuery = libFoxHound.new(newFable()).setScope('Sale');
	tmpQuery.query.schema = [ { Column: 'IDSale', Type: 'AutoIdentity' }, { Column: 'Deleted', Type: 'Deleted' }, { Column: 'IDTenant', Type: 'Integer' }, { Column: 'Rating', Type: 'Integer' }, { Column: 'Title', Type: 'String' } ];
	pEntries.forEach((pEntry) => { tmpQuery.addFilter.apply(tmpQuery, pEntry); });
	return tmpQuery;
};

const FENCE_OPEN = [ '', '', '(', 'AND', 'FacetFenceOpen' ];
const FENCE_CLOSE = [ '', '', ')', 'AND', 'FacetFenceClose' ];
const SOFT_DELETE = [ 'Deleted', 0, '=', 'AND', 'FacetSoftDelete' ];

/**
 * A policy host stub for guard unit tests.
 *
 * @param {string} pGuard
 * @return {Record<string, any>}
 */
const policyHost = (pGuard) =>
{
	return (
		{
			getScopePolicy: () =>
			{
				return (
					{
						Kind: 'Policy', Column: 'IDTenant', Guard: pGuard, UnsetValues: [ 0, '', null ],
						requiredFor: (pEntity, pPrincipal) => { return (pEntity === 'GlobalThing') ? [] : [ { Column: 'IDTenant', Value: pPrincipal.ScopeValues.IDTenant } ]; },
						isScoped: (pEntity) => { return pEntity !== 'GlobalThing'; }
					});
			}
		});
};

const guardContext = (pGuard, pTenant) =>
{
	return { Host: policyHost(pGuard), Principal: { ScopeValues: { IDTenant: pTenant } }, Options: libOptions.resolve({}) };
};

/**
 * A context whose host reports a different guard mode (prototype proxy over the real host).
 *
 * @param {Record<string, any>} pContext
 * @param {string} pGuard
 * @return {Record<string, any>}
 */
const withGuard = (pContext, pGuard) =>
{
	let tmpRealHost = pContext.Host;
	let tmpHost = Object.create(tmpRealHost);
	tmpHost.getScopePolicy = () => { return Object.assign({}, tmpRealHost.getScopePolicy(), { Guard: pGuard }); };
	pContext.Host = tmpHost;
	return pContext;
};

/**
 * Temporarily replace an entity's behavior on its route-bound controller.
 *
 * @param {Record<string, any>} pHarness
 * @param {string} pEntity
 * @param {Function} fBehavior
 * @return {() => void} restore
 */
const swapBehavior = (pHarness, pEntity, fBehavior) =>
{
	let tmpController = pHarness.fable.RetoldFacetingHostDataService.getRouteBoundController(pEntity);
	let tmpFunctions = tmpController.BehaviorInjection._BehaviorFunctions;
	let tmpHad = Object.prototype.hasOwnProperty.call(tmpFunctions, 'Reads-QueryConfiguration');
	let tmpPrevious = tmpFunctions['Reads-QueryConfiguration'];
	tmpController.BehaviorInjection.setBehavior('Reads-QueryConfiguration', fBehavior);
	return () =>
	{
		if (tmpHad)
		{
			tmpFunctions['Reads-QueryConfiguration'] = tmpPrevious;
		}
		else
		{
			delete tmpFunctions['Reads-QueryConfiguration'];
		}
	};
};

// ---------------------------------------------------------------- suites

suite
(
	'Facet-Live-Unit',
	() =>
	{
		suite
		(
			'ScopeGuard (06 §3.3)',
			() =>
			{
				let _Guard = null;

				suiteSetup(() => { _Guard = new libRetoldFacetingScopeGuard(newFable()); });

				test('Strict: a depth-0 = AND predicate with the principal value satisfies the policy',
					() =>
					{
						let tmpQuery = filterQuery([ FENCE_OPEN, [ 'Rating', 4, '>=', 'AND', 'c1_Rating' ], FENCE_CLOSE, SOFT_DELETE, [ 'IDTenant', 1, '=', 'AND', 'TestTenancy' ] ]);
						let tmpResult = _Guard.assert(guardContext('Strict', 1), 'Sale', tmpQuery, { Opaque: false });
						Expect(tmpResult).to.deep.equal({ Mode: 'Strict', Required: [ { Column: 'IDTenant', Value: 1 } ], Satisfied: true, Repaired: false, Violations: [] });
						// Qualified and quoted column names count (behaviors may qualify).
						let tmpQualified = filterQuery([ [ '"Sale"."IDTenant"', 1, '=', 'AND', 'T' ] ]);
						Expect(_Guard.assert(guardContext('Strict', 1), 'Sale', tmpQualified, {}).Satisfied).to.equal(true);
						// String session value vs numeric filter value
						Expect(_Guard.assert(guardContext('Strict', '1'), 'Sale', tmpQualified, {}).Satisfied).to.equal(true);
					});

				test('Strict: a client-supplied tenant predicate inside the fence never satisfies the guard',
					() =>
					{
						let tmpQuery = filterQuery([ FENCE_OPEN, [ 'IDTenant', 1, '=', 'AND', 'c1_IDTenant' ], FENCE_CLOSE, SOFT_DELETE ]);
						let tmpResult = _Guard.assert(guardContext('Strict', 1), 'Sale', tmpQuery, {});
						Expect(tmpResult.Satisfied).to.equal(false);
						Expect(tmpResult.Violations).to.deep.equal([ { Rule: 'MissingPredicate', Column: 'IDTenant' } ]);
					});

				test('Strict: wrong value, unset value, depth-0 OR, other operators and connectors are violations',
					() =>
					{
						let fRules = (pEntries, pTenant) =>
						{
							return _Guard.assert(guardContext('Strict', pTenant), 'Sale', filterQuery(pEntries), {}).Violations;
						};
						Expect(fRules([ [ 'IDTenant', 2, '=', 'AND', 'T' ] ], 1)).to.deep.equal([ { Rule: 'WrongValue', Column: 'IDTenant' } ]);
						Expect(fRules([ [ 'IDTenant', 0, '=', 'AND', 'T' ] ], 0)).to.deep.equal([ { Rule: 'UnsetValue', Column: 'IDTenant' } ]);
						Expect(fRules([ [ 'IDTenant', 1, '=', 'AND', 'T' ], [ 'Rating', 5, '=', 'OR', 'X' ] ], 1)).to.deep.equal([ { Rule: 'DepthZeroOr' } ]);
						Expect(fRules([ [ 'IDTenant', 1, '=', 'AND', 'T' ], [ 'Rating', 5, '=', 'XOR', 'X' ] ], 1)).to.deep.equal([ { Rule: 'DepthZeroOr' } ]);
						Expect(fRules([ [ 'IDTenant', [ 1, 2 ], 'IN', 'AND', 'T' ] ], 1)).to.deep.equal([ { Rule: 'MissingPredicate', Column: 'IDTenant' } ]);
						Expect(fRules([ [ 'IDTenant', 1, '=', 'OR', 'T' ] ], 1)).to.deep.equal([ { Rule: 'MissingPredicate', Column: 'IDTenant' } ]);
						// An OR inside a behavior's own group is not depth 0, but neither is its predicate.
						Expect(fRules([ [ '', '', '(', 'AND', 'G' ], [ 'IDTenant', 1, '=', 'AND', 'T' ], [ 'Rating', 5, '=', 'OR', 'X' ], [ '', '', ')', 'AND', 'G' ] ], 1))
							.to.deep.equal([ { Rule: 'MissingPredicate', Column: 'IDTenant' } ]);
						// The first entry's connector is never emitted, so an OR there is harmless.
						Expect(fRules([ [ 'IDTenant', 1, '=', 'AND', 'T' ], FENCE_OPEN, [ 'Rating', 5, '=', 'OR', 'X' ], FENCE_CLOSE ], 1)).to.deep.equal([]);
					});

				test('Strict: unbalanced or broken fences and Opaque captures are refused',
					() =>
					{
						let tmpTenancy = [ 'IDTenant', 1, '=', 'AND', 'T' ];
						let fRules = (pEntries, pCapture) =>
						{
							return _Guard.assert(guardContext('Strict', 1), 'Sale', filterQuery(pEntries), pCapture || {}).Violations.map((pViolation) => { return pViolation.Rule; });
						};
						Expect(fRules([ FENCE_OPEN, [ 'Rating', 5, '=', 'AND', 'X' ], tmpTenancy ])).to.include('UnbalancedFence');
						Expect(fRules([ FENCE_OPEN, [ 'Rating', 5, '=', 'AND', 'X' ], [ '', '', ')', 'AND', 'NotTheFence' ], tmpTenancy ])).to.deep.equal([ 'UnbalancedFence' ]);
						Expect(fRules([ [ '', '', ')', 'AND', 'X' ], FENCE_OPEN, tmpTenancy ])).to.include('UnbalancedFence');
						Expect(fRules([ tmpTenancy ], { Opaque: true })).to.deep.equal([ 'OpaqueUntrusted' ]);
					});

				test('Repair fixes ONLY an absent predicate: wrap the filter, append the policy at depth 0',
					() =>
					{
						let tmpQuery = filterQuery([ FENCE_OPEN, [ 'Rating', 4, '>=', 'AND', 'c1_Rating' ], [ 'Rating', 5, '=', 'OR', 'c2_Rating' ], FENCE_CLOSE, SOFT_DELETE ]);
						let tmpResult = _Guard.assert(guardContext('Repair', 7), 'Sale', tmpQuery, {});
						Expect(tmpResult.Satisfied).to.equal(true);
						Expect(tmpResult.Repaired).to.equal(true);
						let tmpFilter = tmpQuery.parameters.filter;
						Expect(tmpFilter[0]).to.include({ Operator: '(', Parameter: 'FacetRepairOpen' });
						Expect(tmpFilter[tmpFilter.length - 2]).to.include({ Operator: ')', Parameter: 'FacetRepairClose' });
						Expect(tmpFilter[tmpFilter.length - 1]).to.deep.equal({ Column: 'IDTenant', Operator: '=', Value: 7, Connector: 'AND', Parameter: 'FacetPolicyIDTenant' });
						// The repaired filter now passes Strict on its own (minus the fence rule: the fence moved to depth 1).
						tmpQuery.setDialect('SQLite').buildReadQuery();
						Expect(tmpQuery.query.body).to.match(/WHERE \( \( `Rating` >= :c1_Rating_w2 OR `Rating` = :c2_Rating_w3 \) AND `Deleted` = :FacetSoftDelete_w5 \) AND `IDTenant` = :FacetPolicyIDTenant_w7;$/);
						// Anything but an absent predicate is refused in Repair too.
						[
							[ [ 'IDTenant', 1, '=', 'AND', 'T' ], [ 'Rating', 5, '=', 'OR', 'X' ] ],
							[ [ 'IDTenant', 2, '=', 'AND', 'T' ] ],
							[ FENCE_OPEN, [ 'IDTenant', 1, '=', 'AND', 'T' ] ]
						].forEach(
							(pEntries) =>
							{
								let tmpRefused = _Guard.assert(guardContext('Repair', 1), 'Sale', filterQuery(pEntries), {});
								Expect(tmpRefused.Satisfied).to.equal(false);
								Expect(tmpRefused.Repaired).to.equal(false);
							});
						Expect(_Guard.assert(guardContext('Repair', 1), 'Sale', filterQuery([]), { Opaque: true }).Satisfied).to.equal(false);
					});

				test('Off without a policy; a policy never runs Off (fails closed to Strict); Global entities need no predicate',
					() =>
					{
						let tmpNoPolicy = { Host: { getScopePolicy: () => { return { Kind: 'None', Guard: 'Off', requiredFor: () => { return []; } }; } }, Principal: null, Options: libOptions.resolve({}) };
						Expect(_Guard.assert(tmpNoPolicy, 'Sale', filterQuery([ [ 'Rating', 1, '=', 'OR', 'X' ] ]), {})).to.deep.equal({ Mode: 'Off', Required: [], Satisfied: true, Repaired: false, Violations: [] });
						let tmpOffWithPolicy = _Guard.assert(guardContext('Off', 1), 'Sale', filterQuery([]), {});
						Expect(tmpOffWithPolicy.Mode).to.equal('Strict');
						Expect(tmpOffWithPolicy.Satisfied).to.equal(false);
						Expect(_Guard.assert(guardContext('Strict', 1), 'GlobalThing', filterQuery([ SOFT_DELETE ]), {}).Satisfied).to.equal(true);
						Expect(_Guard.assert({ Principal: null }, 'Sale', filterQuery([]), {}).Mode).to.equal('Off');
					});
			}
		);

		suite
		(
			'ScopeCapture analysis (06 §3.2)',
			() =>
			{
				test('Appended, Transformed and every Opaque reason; depth per entry',
					() =>
					{
						let tmpCapture = new libRetoldFacetingScopeCapture(newFable());
						let tmpQuery = filterQuery([ FENCE_OPEN, [ 'Title', '%x%', 'LIKE', 'AND', 'c1_Title' ], FENCE_CLOSE, SOFT_DELETE ]);
						let tmpBefore = tmpCapture.snapshot(tmpQuery);
						// A behavior rewrites LIKE → ILIKE in place and appends tenancy.
						tmpQuery.parameters.filter[1].Operator = 'ILIKE';
						tmpQuery.addFilter('IDTenant', 3, '=', 'AND', 'Tenancy');
						let tmpAnalysis = tmpCapture.analyze(tmpBefore, tmpQuery);
						Expect(tmpAnalysis.Opaque).to.equal(false);
						Expect(tmpAnalysis.Transformed).to.deep.equal([ { Index: 1, Before: { Operator: 'LIKE' }, After: { Operator: 'ILIKE' } } ]);
						Expect(tmpAnalysis.Appended).to.deep.equal([ { Column: 'IDTenant', Operator: '=', Value: 3, Connector: 'AND', Parameter: 'Tenancy', Depth: 0 } ]);
						// The snapshot is a copy: later mutation never alters it.
						Expect(tmpBefore.Filter[1].Operator).to.equal('LIKE');

						let fReasons = (fMutate) =>
						{
							let tmpOpaqueQuery = filterQuery([ FENCE_OPEN, [ 'Rating', 4, '>=', 'AND', 'c1_Rating' ], FENCE_CLOSE ]);
							let tmpOpaqueBefore = tmpCapture.snapshot(tmpOpaqueQuery);
							fMutate(tmpOpaqueQuery);
							return tmpCapture.analyze(tmpOpaqueBefore, tmpOpaqueQuery).OpaqueReasons;
						};
						Expect(fReasons((pQuery) => { pQuery.addJoin('Other', 'Other.IDSale', 'Sale.IDSale'); })).to.deep.equal([ 'JoinAdded' ]);
						Expect(fReasons((pQuery) => { pQuery.parameters.queryOverride = 'SELECT 1'; })).to.deep.equal([ 'QueryOverride' ]);
						Expect(fReasons((pQuery) => { pQuery.parameters.queryBranches = [ {} ]; })).to.deep.equal([ 'QueryBranches' ]);
						Expect(fReasons((pQuery) => { pQuery.parameters.filter.splice(1, 1); })).to.include('FilterRewritten');
						Expect(fReasons((pQuery) => { pQuery.parameters.filter[1].Value = 1; })).to.deep.equal([ 'FilterRewritten' ]);
						Expect(fReasons((pQuery) => { pQuery.addFilter('Secret', 1); })).to.deep.equal([ 'UnknownColumn:Secret' ]);
						Expect(fReasons((pQuery) => { pQuery.addFilter('Rating', 1, 'SOUNDS LIKE'); })).to.deep.equal([ 'UnknownOperator:SOUNDS LIKE' ]);
						Expect(fReasons((pQuery) => { pQuery.addFilter('Rating', { $gt: 1 }); })).to.deep.equal([ 'NonScalarValue:Rating' ]);
						Expect(fReasons((pQuery) => { pQuery.addFilter('"Sale"."Rating"', [ 1, 2 ], 'IN'); })).to.deep.equal([]);
						// Another table's column (a join the capture cannot see) is opaque even when the name matches.
						Expect(fReasons((pQuery) => { pQuery.addFilter('Other.Rating', 1); })).to.deep.equal([ 'UnknownColumn:Other.Rating' ]);
					});

				test('the fingerprint is stable, and changes with the appended scope',
					() =>
					{
						let tmpCapture = new libRetoldFacetingScopeCapture(newFable());
						let tmpBase = { Entity: 'Sale', Appended: [ { Column: 'IDTenant', Operator: '=', Value: 1, Connector: 'AND', Parameter: 'T', Depth: 0 } ], Transformed: [], Behavior: 'Reads-QueryConfiguration' };
						let tmpA = tmpCapture.fingerprint(tmpBase, 'Inherit');
						Expect(tmpA).to.match(/^sf:[0-9a-f]{12}$/);
						Expect(tmpCapture.fingerprint(JSON.parse(JSON.stringify(tmpBase)), 'Inherit')).to.equal(tmpA);
						let tmpOther = JSON.parse(JSON.stringify(tmpBase));
						tmpOther.Appended[0].Value = 2;
						Expect(tmpCapture.fingerprint(tmpOther, 'Inherit')).to.not.equal(tmpA);
					});
			}
		);

		suite
		(
			'Live vs Reference on the seeded Bookstore (O1, raw results)',
			() =>
			{
				let _Harness = null;

				suiteSetup((fDone) =>
				{
					_Harness = libHarness.start({ Port: PORT, Fixture: 'Bookstore' },
						(pError) =>
						{
							Expect(pError).to.not.be.an('error');
							return fDone();
						});
				});
				suiteTeardown((fDone) => { _Harness.stop(fDone); });

				test('BookStoreSale: every fold over the unfiltered Variant',
					(fDone) =>
					{
						let H = _Harness;
						let tmpAggs = (
							[
								agg(H, '#Total', 'Count', 'BookStoreSale', {}),
								agg(H, 'ByPayment', 'Terms', 'BookStoreSale', { Field: 'PaymentMethod', Top: 2 }),
								agg(H, 'ByPaymentKey', 'Terms', 'BookStoreSale', { Field: 'PaymentMethod', Top: 2, Order: 'KeyAsc' }),
								agg(H, 'ByStore', 'Terms', 'BookStoreSale', { Field: 'IDBookStore', Top: 3 }),
								agg(H, 'ByDay', 'DateHistogram', 'BookStoreSale', { Field: 'SaleDate', Interval: 'day' }),
								agg(H, 'ByWeek', 'DateHistogram', 'BookStoreSale', { Field: 'SaleDate', Interval: 'week' }),
								agg(H, 'ByMonth', 'DateHistogram', 'BookStoreSale', { Field: 'SaleDate', Interval: 'month' }),
								agg(H, 'ByQuarter', 'DateHistogram', 'BookStoreSale', { Field: 'SaleDate', Interval: 'quarter' }),
								agg(H, 'ByYear', 'DateHistogram', 'BookStoreSale', { Field: 'SaleDate', Interval: 'year' }),
								agg(H, 'ByAmount', 'NumericHistogram', 'BookStoreSale', { Field: 'TotalAmount', Buckets: 10 }),
								agg(H, 'ByAmountFine', 'NumericHistogram', 'BookStoreSale', { Field: 'TotalAmount', Buckets: 200 }),
								agg(H, 'ByAmountEdges', 'NumericHistogram', 'BookStoreSale', { Field: 'TotalAmount', Mode: 'Edges', Edges: [ 20, 50, 100.5, 250 ], OpenEnded: false }),
								agg(H, 'ByAmountOpen', 'NumericHistogram', 'BookStoreSale', { Field: 'TotalAmount', Mode: 'Edges', Edges: [ 0, 25, 100 ], OpenEnded: true }),
								agg(H, 'AmountBands', 'Ranges', 'BookStoreSale', { Field: 'TotalAmount', Ranges: [ { Key: 'low', From: null, To: 30 }, { Key: 'mid', From: 20, To: 200 }, { Key: 'high', From: 200, To: null } ] }),
								agg(H, 'AmountStats', 'Stats', 'BookStoreSale', { Field: 'TotalAmount' }),
								agg(H, 'DateStats', 'Stats', 'BookStoreSale', { Field: 'SaleDate' }),
								agg(H, 'PaymentDistinct', 'DistinctCount', 'BookStoreSale', { Field: 'PaymentMethod' }),
								agg(H, 'SaleDateMissing', 'Missing', 'BookStoreSale', { Field: 'SaleDate' }),
								agg(H, 'PaymentByYear', 'Pivot', 'BookStoreSale', { Axes: [ { Kind: 'Column', Field: 'PaymentMethod' }, { Kind: 'DateBucket', Field: 'SaleDate', Interval: 'year' } ] }),
								agg(H, 'BandByStore', 'Pivot', 'BookStoreSale', { Axes: [ { Kind: 'Range', Field: 'TotalAmount', Ranges: [ { Key: 'small', From: null, To: 50 }, { Key: 'large', From: 50, To: null } ] }, { Kind: 'Column', Field: 'IDBookStore' } ] })
							]);
						compareEngines(H, 'BookStoreSale', () => { return { v0: variant('v0', 'BookStoreSale', []) }; }, tmpAggs, {},
							(pLive) =>
							{
								// One relation for the whole Variant; one statement per Agg (two per NumericHistogram).
								Expect(Object.keys(pLive.Captures)).to.deep.equal([ 'BookStoreSale' ]);
								Expect(pLive.Captures.BookStoreSale.Fingerprint).to.match(/^sf:[0-9a-f]{12}$/);
								Expect(pLive.Statements).to.equal(tmpAggs.length + 4);
								// The seed carries the traps: Missing dates, '' payment keys, decimals.
								Expect(pLive.Results.ByMonth.MissingCount).to.be.above(0);
								Expect(pLive.Results.ByPayment.Groups.map((pGroup) => { return pGroup.Key; })).to.have.length.within(3, 5);
								Expect(pLive.Results.AmountStats.Stats.Factor).to.equal(100);
								Expect(pLive.Results.DateStats.Stats.SumUnits).to.equal(null);
								return fDone();
							});
					});

				test('BookStoreSale: disjunctive Variants (IN, range, NULL, Or) share a relation per Variant',
					(fDone) =>
					{
						let H = _Harness;
						let fVariants = () =>
						{
							let tmpPayment = conjunct('c1', { Field: 'PaymentMethod', Op: 'IN', Value: [ 'Credit', 'Cash', '' ] });
							let tmpAmount = conjunct('c2', { And: [ { Field: 'TotalAmount', Op: 'GE', Value: 20 }, { Field: 'TotalAmount', Op: 'LT', Value: 1000 } ] });
							let tmpDate = conjunct('c3', { Or: [ { Field: 'SaleDate', Op: 'NULL' }, { Field: 'SaleDate', Op: 'GE', Value: '2022-06-01 00:00:00' } ] });
							let tmpEither = conjunct('c4', { Or: [ { Field: 'IDBookStore', Op: 'IN', Value: [ 1, 2, 3 ] }, { Field: 'PaymentMethod', Op: 'EQ', Value: 'Debit' } ] });
							return (
								{
									v0: variant('v0', 'BookStoreSale', [ tmpPayment, tmpAmount, tmpDate, tmpEither ]),
									v1: variant('v1', 'BookStoreSale', [ tmpAmount, tmpDate, tmpEither ]),
									v2: variant('v2', 'BookStoreSale', [ tmpPayment, tmpDate, tmpEither ]),
									v3: variant('v3', 'BookStoreSale', [ tmpPayment, tmpAmount, tmpEither ])
								});
						};
						let tmpAggs = (
							[
								agg(H, '#Total', 'Count', 'BookStoreSale', { VariantId: 'v0' }),
								agg(H, 'ByPayment', 'Terms', 'BookStoreSale', { Field: 'PaymentMethod', Top: 3, VariantId: 'v1' }),
								agg(H, 'ByAmount', 'NumericHistogram', 'BookStoreSale', { Field: 'TotalAmount', Buckets: 8, VariantId: 'v2' }),
								agg(H, 'AmountStats', 'Stats', 'BookStoreSale', { Field: 'TotalAmount', VariantId: 'v0' }),
								agg(H, 'ByQuarter', 'DateHistogram', 'BookStoreSale', { Field: 'SaleDate', Interval: 'quarter', VariantId: 'v3' }),
								agg(H, 'Missing', 'Missing', 'BookStoreSale', { Field: 'SaleDate', VariantId: 'v0' }),
								agg(H, 'Cells', 'Pivot', 'BookStoreSale', { Axes: [ { Kind: 'Column', Field: 'PaymentMethod' }, { Kind: 'DateBucket', Field: 'SaleDate', Interval: 'year' } ], VariantId: 'v0' })
							]);
						compareEngines(H, 'BookStoreSale', fVariants, tmpAggs, {},
							(pLive) =>
							{
								// Excluding a conjunct can only widen the base set.
								Expect(pLive.Results.ByPayment.Total).to.be.at.least(pLive.Results['#Total'].Total);
								Expect(pLive.Results.ByAmount.Total).to.be.at.least(pLive.Results['#Total'].Total);
								Expect(pLive.Results['#Total'].Total).to.be.above(0);
								return fDone();
							});
					});

				test('Book and Review: integer histograms with a negative outlier, \'\' terms, Ranges on an integer, FK terms',
					(fDone) =>
					{
						let H = _Harness;
						let tmpBookAggs = (
							[
								agg(H, '#Total', 'Count', 'Book', {}),
								agg(H, 'ByYear', 'NumericHistogram', 'Book', { Field: 'PublicationYear', Buckets: 12 }),
								agg(H, 'ByYearEdges', 'NumericHistogram', 'Book', { Field: 'PublicationYear', Mode: 'Edges', Edges: [ 1800, 1900, 2000 ], OpenEnded: true }),
								agg(H, 'ByLanguage', 'Terms', 'Book', { Field: 'Language', Top: 4 }),
								agg(H, 'LanguageDistinct', 'DistinctCount', 'Book', { Field: 'Language' }),
								agg(H, 'YearStats', 'Stats', 'Book', { Field: 'PublicationYear' }),
								agg(H, 'YearMissing', 'Missing', 'Book', { Field: 'PublicationYear' })
							]);
						compareEngines(H, 'Book', () => { return { v0: variant('v0', 'Book', []) }; }, tmpBookAggs, {},
							(pBookLive) =>
							{
								Expect(pBookLive.Results.ByYear.Bounds.Lo).to.be.below(0);
								Expect(pBookLive.Results.ByYear.Geometry.LoUnits).to.be.below(0);
								let tmpReviewAggs = (
									[
										agg(H, 'ByRating', 'Terms', 'Review', { Field: 'Rating', Top: 3 }),
										agg(H, 'RatingBands', 'Ranges', 'Review', { Field: 'Rating', Ranges: [ { Key: 'low', From: null, To: 3 }, { Key: 'high', From: 3, To: null } ] }),
										agg(H, 'ByBook', 'Terms', 'Review', { Field: 'IDBook', Top: 5 }),
										agg(H, 'RatingStats', 'Stats', 'Review', { Field: 'Rating' }),
										agg(H, 'RatingByBand', 'Pivot', 'Review', { Axes: [ { Kind: 'Range', Field: 'Rating', Ranges: [ { Key: 'low', From: null, To: 3 }, { Key: 'high', From: 3, To: null } ] }, { Kind: 'Column', Field: 'Rating' } ] })
									]);
								compareEngines(H, 'Review', () => { return { v0: variant('v0', 'Review', [ conjunct('c1', { Field: 'Rating', Op: 'GE', Value: 2 }) ]) }; }, tmpReviewAggs, {},
									() =>
									{
										return fDone();
									});
							});
					});

				test('BookPrice: \'\' and NULL dates are Missing in Stats, Missing and DateHistogram',
					(fDone) =>
					{
						let H = _Harness;
						let tmpAggs = (
							[
								agg(H, 'EndStats', 'Stats', 'BookPrice', { Field: 'EndDate' }),
								agg(H, 'EndMissing', 'Missing', 'BookPrice', { Field: 'EndDate' }),
								agg(H, 'EndByYear', 'DateHistogram', 'BookPrice', { Field: 'EndDate', Interval: 'year' }),
								agg(H, 'PriceStats', 'Stats', 'BookPrice', { Field: 'Price' }),
								agg(H, 'ByPrice', 'NumericHistogram', 'BookPrice', { Field: 'Price', Buckets: 15 })
							]);
						compareEngines(H, 'BookPrice', () => { return { v0: variant('v0', 'BookPrice', []) }; }, tmpAggs, {},
							(pLive) =>
							{
								let tmpEmpty = H.db.prepare("SELECT count(*) AS N FROM BookPrice WHERE Deleted = 0 AND EndDate = ''").get().N;
								Expect(tmpEmpty, 'the seed carries \'\' dates').to.be.above(0);
								Expect(pLive.Results.EndMissing.MissingCount).to.be.at.least(tmpEmpty);
								return fDone();
							});
					});

				test('Show-deleted: a conjunct naming Deleted turns the explicit soft-delete off (ClientControlled)',
					(fDone) =>
					{
						let H = _Harness;
						let fVariants = () =>
						{
							return (
								{
									v0: variant('v0', 'Review', [ conjunct('c1', { Field: 'Deleted', Op: 'EQ', Value: 1 }) ]),
									v1: variant('v1', 'Review', [ conjunct('c2', { Field: 'Deleted', Op: 'IN', Value: [ 0, 1 ] }) ])
								});
						};
						let tmpAggs = (
							[
								agg(H, '#Total', 'Count', 'Review', { VariantId: 'v0' }),
								agg(H, 'All', 'Count', 'Review', { VariantId: 'v1' }),
								agg(H, 'ByRating', 'Terms', 'Review', { Field: 'Rating', Top: 10, VariantId: 'v0' })
							]);
						compareEngines(H, 'Review', fVariants, tmpAggs, {},
							(pLive) =>
							{
								let tmpDeleted = H.db.prepare('SELECT count(*) AS N FROM Review WHERE Deleted = 1').get().N;
								let tmpAll = H.db.prepare('SELECT count(*) AS N FROM Review').get().N;
								Expect(tmpDeleted).to.be.above(0);
								Expect(pLive.Results['#Total'].Total).to.equal(tmpDeleted);
								Expect(pLive.Results.All.Total).to.equal(tmpAll);
								return fDone();
							});
					});

				test('the relation is a fenced, explicitly soft-deleted, renamed derived table; memoized per request',
					(fDone) =>
					{
						let H = _Harness;
						let tmpBuilder = H.fable.RetoldFacetingScopedRelationBuilder;
						let tmpClient = [ conjunct('c1', { Or: [ { Field: 'Rating', Op: 'EQ', Value: 5 }, { Field: 'Rating', Op: 'NULL' } ] }) ];
						let tmpContext = newContext(H, 'Review', {});
						let tmpRel = { Entity: 'Review', As: 'p', Project: [ 'IDReview', 'Rating' ], Client: tmpClient, Where: null, Scope: 'Inherit', SoftDelete: 'Explicit' };
						tmpBuilder.buildRelation(tmpContext, tmpRel,
							(pError, pRelation) =>
							{
								Expect(pError).to.equal(null);
								// fence ( #0, group ( #1, = #2, IS #3, ) #4, fence ) #5, soft-delete #6 — FoxHound names binds <Parameter>_w<index>.
								Expect(pRelation.SQL).to.equal('SELECT "IDReview", "Rating" FROM Review WHERE ( ( `Rating` = :p_c1_Rating_w2 OR `Rating` IS :p_c1_Rating_w3 ) ) AND `Deleted` = :p_FacetSoftDelete_w6');
								Expect(pRelation.Params).to.deep.equal({ p_c1_Rating_w2: 5, p_c1_Rating_w3: null, p_FacetSoftDelete_w6: 0 });
								Expect(pRelation.Capture.BehaviorRan).to.equal(false);
								Expect(pRelation.Capture.Guard.Mode).to.equal('Off');
								Expect(pRelation.Staged).to.equal(false);
								// Same Rel → the same relation object, no new build, no new behavior run.
								tmpBuilder.buildRelation(tmpContext, Object.assign({}, tmpRel),
									(pAgainError, pAgain) =>
									{
										Expect(pAgain).to.equal(pRelation);
										Expect(tmpContext.Counters).to.include({ Relations: 1, BehaviorRuns: 1 });
										// Another projection over the same filter replays the memoized capture.
										tmpBuilder.buildRelation(tmpContext, Object.assign({}, tmpRel, { Project: [ 'IDReview' ] }),
											(pOtherError, pOther) =>
											{
												Expect(pOther).to.not.equal(pRelation);
												Expect(pOther.Capture).to.equal(pRelation.Capture);
												Expect(tmpContext.Counters).to.include({ Relations: 2, BehaviorRuns: 1 });
												// The relation counts exactly what the SQL says.
												let tmpCount = H.db.prepare(`SELECT count(*) AS N FROM (${pRelation.SQL}) "p"`).get(pRelation.Params).N;
												let tmpExpected = H.db.prepare('SELECT count(*) AS N FROM Review WHERE (Rating = 5 OR Rating IS NULL) AND Deleted = 0').get().N;
												Expect(tmpCount).to.equal(tmpExpected);
												// Budgets: one more distinct relation than allowed → FACET_TOO_LARGE.
												let tmpTight = newContext(H, 'Review', {}, {}, { Options: libOptions.resolve({ Limits: { MaxRelationsPerRequest: 1 } }) });
												tmpBuilder.buildRelation(tmpTight, tmpRel,
													(pFirstError) =>
													{
														Expect(pFirstError).to.equal(null);
														tmpBuilder.buildRelation(tmpTight, Object.assign({}, tmpRel, { Project: [ 'IDReview' ] }),
															(pBudgetError) =>
															{
																Expect(pBudgetError.Code).to.equal('FACET_TOO_LARGE');
																// Bad shapes are refused before any SQL.
																tmpBuilder.buildRelation(newContext(H, 'Review', {}), Object.assign({}, tmpRel, { As: 'f1' }),
																	(pAliasError) =>
																	{
																		Expect(pAliasError.Code).to.equal('FACET_INTERNAL');
																		tmpBuilder.buildRelation(newContext(H, 'Review', {}), Object.assign({}, tmpRel, { Project: [ 'IDReview', 'NotAColumn' ] }),
																			(pColumnError) =>
																			{
																				Expect(pColumnError.Code).to.equal('FACET_INTERNAL');
																				return setImmediate(fDone);
																			});
																	});
															});
													});
											});
									});
							});
					});

				test('engine errors stay per facet: unsupported kinds, unknown Variants, deadlines, relation budgets, failing statements',
					(fDone) =>
					{
						let H = _Harness;
						let tmpEngine = H.fable.RetoldFacetingEngineLive;
						let tmpGood = agg(H, 'Good', 'Count', 'Review', {});
						let tmpAggs = (
							[
								tmpGood,
								{ Key: 'Bridge', Kind: 'BridgeTerms', Pivot: 'Review', Dimensions: [] },
								Object.assign(agg(H, 'Lost', 'Count', 'Review', {}), { VariantId: 'v9' }),
								Object.assign(agg(H, 'NumericAxis', 'Pivot', 'Review', { Axes: [ { Kind: 'Column', Field: 'Rating' }, { Kind: 'Column', Field: 'IDBook' } ] }), { Dimensions: [ { Kind: 'NumericBucket', Field: 'Rating' }, { Kind: 'Column', Field: 'IDBook', DataType: 'Numeric' } ] }),
								Object.assign(agg(H, 'Log', 'NumericHistogram', 'Review', { Field: 'Rating' }), { Dimensions: [ { Kind: 'NumericBucket', Field: 'Rating', Mode: 'Log' } ] })
							]);
						Expect(tmpEngine.capable(tmpGood, {})).to.deep.equal({ Capable: true });
						Expect(tmpEngine.capable(tmpAggs[1], {}).Capable).to.equal(false);
						execute(tmpEngine, newContext(H, 'Review', { v0: variant('v0', 'Review', []) }), tmpAggs,
							(pError, pExecution) =>
							{
								Expect(pError).to.equal(null);
								Expect(pExecution.Results.Good.Total).to.be.above(0);
								Expect(pExecution.Errors.Bridge.Code).to.equal('FACET_FOLD_UNSUPPORTED');
								Expect(pExecution.Errors.Lost.Code).to.equal('FACET_INTERNAL');
								Expect(pExecution.Errors.NumericAxis.Code).to.equal('FACET_FOLD_UNSUPPORTED');
								Expect(pExecution.Errors.Log.Code).to.equal('FACET_FOLD_UNSUPPORTED');
								// Past the deadline: no statement runs.
								let tmpLate = newContext(H, 'Review', { v0: variant('v0', 'Review', []) }, {}, { Deadline: Date.now() - 1 });
								execute(tmpEngine, tmpLate, [ tmpGood ],
									(pLateError, pLateExecution) =>
									{
										Expect(pLateError).to.equal(null);
										Expect(pLateExecution.Errors.Good.Code).to.equal('FACET_TIMEOUT');
										Expect(pLateExecution.Statements).to.equal(0);
										// Relation budget: the second Variant's facets fail, the first Variant's succeed.
										let tmpTight = newContext(H, 'Review', { v0: variant('v0', 'Review', []), v1: variant('v1', 'Review', [ conjunct('c1', { Field: 'Rating', Op: 'EQ', Value: 1 }) ]) }, {},
											{ Options: libOptions.resolve({ Limits: { MaxRelationsPerRequest: 1 } }) });
										execute(tmpEngine, tmpTight, [ tmpGood, Object.assign(agg(H, 'Second', 'Count', 'Review', {}), { VariantId: 'v1' }) ],
											(pTightError, pTightExecution) =>
											{
												Expect(pTightError).to.equal(null);
												Expect(pTightExecution.Results.Good.Total).to.be.above(0);
												Expect(pTightExecution.Errors.Second.Code).to.equal('FACET_TOO_LARGE');
												// A statement that fails in the database fails only its own facet.
												let tmpShells = H.fable.RetoldFacetingShellTemplates;
												let fRender = tmpShells.render;
												tmpShells.render = function (pDialect, pAgg, pSlots)
												{
													let tmpShell = fRender.call(this, pDialect, pAgg, pSlots);
													if (pAgg.Key === 'Broken')
													{
														tmpShell.Template = 'SELECT nonsense FROM (<%= _Params.SR0 %>) "p" GROUP BY';
													}
													return tmpShell;
												};
												execute(tmpEngine, newContext(H, 'Review', { v0: variant('v0', 'Review', []) }, {}, { Options: libOptions.resolve({ Execution: { MaxParallelStatements: 1 } }) }),
													[ tmpGood, agg(H, 'Broken', 'Terms', 'Review', { Field: 'Rating' }), agg(H, 'After', 'Missing', 'Review', { Field: 'Rating' }) ],
													(pBrokenError, pBrokenExecution) =>
													{
														tmpShells.render = fRender;
														Expect(pBrokenError).to.equal(null);
														Expect(pBrokenExecution.Errors.Broken.Code).to.equal('FACET_INTERNAL');
														Expect(pBrokenExecution.Errors.Broken.Message).to.equal('Internal error.');
														Expect(pBrokenExecution.Results.Good.Total).to.be.above(0);
														Expect(pBrokenExecution.Results.After.Total).to.equal(pBrokenExecution.Results.Good.Total);
														return fDone();
													});
											});
									});
							});
					});

				test('compileAgg returns the statements without executing (Nice histograms need a geometry for pass 2)',
					(fDone) =>
					{
						let H = _Harness;
						let tmpContext = newContext(H, 'BookStoreSale', { v0: variant('v0', 'BookStoreSale', []) });
						let tmpAgg = agg(H, 'ByAmount', 'NumericHistogram', 'BookStoreSale', { Field: 'TotalAmount', Buckets: 10 });
						H.fable.RetoldFacetingScopedRelationBuilder.buildRelation(tmpContext, H.fable.RetoldFacetingEngineLive.pivotRel(tmpContext, 'BookStoreSale', { Conjuncts: [], IncludesDeleted: false }, [ 'TotalAmount' ]),
							(pError, pRelation) =>
							{
								Expect(pError).to.equal(null);
								let tmpStatementsBefore = tmpContext.Counters.Statements;
								let tmpBoundsOnly = H.fable.RetoldFacetingEngineLive.compileAgg(tmpContext, tmpAgg, [ pRelation ], 'SQLite');
								Expect(tmpBoundsOnly.Statements.map((pStatement) => { return pStatement.Name; })).to.deep.equal([ 'NumericBounds' ]);
								let tmpBoth = H.fable.RetoldFacetingEngineLive.compileAgg(tmpContext, tmpAgg, [ pRelation ], 'SQLite', { Geometry: libFacetBuckets.numericGeometry(10, 500, 10, 2, 500) });
								Expect(tmpBoth.Statements.map((pStatement) => { return pStatement.Name; })).to.deep.equal([ 'NumericBounds', 'NumericHistogram' ]);
								Expect(tmpBoth.SQL).to.equal(tmpBoth.Statements[0].SQL);
								Expect(tmpBoth.Statements[1].Params).to.include({ fFactor: 100, fLoUnits: 0, fWidthUnits: 5000, fLastIndex: 9 });
								Expect(tmpContext.Counters.Statements).to.equal(tmpStatementsBefore);
								return setImmediate(fDone);
							});
					});
			}
		);

		suite
		(
			'Tenancy: behaviors, the guard and isolation (Bookstore-Tenant)',
			() =>
			{
				let _Harness = null;

				suiteSetup((fDone) =>
				{
					_Harness = libHarness.start({ Port: PORT, Fixture: 'Bookstore-Tenant' },
						(pError) =>
						{
							Expect(pError).to.not.be.an('error');
							return fDone();
						});
				});
				suiteTeardown((fDone) => { _Harness.stop(fDone); });

				let tenantAggs = (H) =>
				{
					return (
						[
							agg(H, '#Total', 'Count', 'BookStoreSale', {}),
							agg(H, 'ByPayment', 'Terms', 'BookStoreSale', { Field: 'PaymentMethod', Top: 3 }),
							agg(H, 'ByStore', 'Terms', 'BookStoreSale', { Field: 'IDBookStore', Top: 50 }),
							agg(H, 'ByMonth', 'DateHistogram', 'BookStoreSale', { Field: 'SaleDate', Interval: 'month' }),
							agg(H, 'ByAmount', 'NumericHistogram', 'BookStoreSale', { Field: 'TotalAmount', Buckets: 10 }),
							agg(H, 'AmountStats', 'Stats', 'BookStoreSale', { Field: 'TotalAmount' }),
							agg(H, 'Cells', 'Pivot', 'BookStoreSale', { Axes: [ { Kind: 'Column', Field: 'PaymentMethod' }, { Kind: 'DateBucket', Field: 'SaleDate', Interval: 'quarter' } ] })
						]);
				};

				test('each tenant: Live equals the Reference, counts only its own live rows, and fingerprints differ',
					(fDone) =>
					{
						let H = _Harness;
						compareEngines(H, 'BookStoreSale', () => { return { v0: variant('v0', 'BookStoreSale', []) }; }, tenantAggs(H), { Tenant: 1 },
							(pTenantOne) =>
							{
								compareEngines(H, 'BookStoreSale', () => { return { v0: variant('v0', 'BookStoreSale', []) }; }, tenantAggs(H), { Tenant: 2 },
									(pTenantTwo) =>
									{
										[ [ 1, pTenantOne ], [ 2, pTenantTwo ] ].forEach(
											(pPair) =>
											{
												let tmpExpected = H.db.prepare('SELECT count(*) AS N FROM BookStoreSale WHERE IDTenant = ? AND Deleted = 0').get(pPair[0]).N;
												Expect(pPair[1].Results['#Total'].Total, `tenant ${pPair[0]}`).to.equal(tmpExpected);
												let tmpStores = H.db.prepare('SELECT IDBookStore AS K, count(*) AS N FROM BookStoreSale WHERE IDTenant = ? AND Deleted = 0 GROUP BY IDBookStore').all(pPair[0]);
												let tmpStoreMap = {};
												tmpStores.forEach((pRow) => { if (pRow.K !== null) { tmpStoreMap[JSON.stringify(pRow.K)] = pRow.N; } });
												// Live returns the top groups (ties included); every one it returns is the tenant's own count.
												let tmpLiveStores = countMap(pPair[1].Results.ByStore.Groups);
												Expect(Object.keys(tmpLiveStores).length).to.be.at.least(Math.min(51, Object.keys(tmpStoreMap).length));
												Object.keys(tmpLiveStores).forEach((pKey) => { Expect(tmpLiveStores[pKey], `tenant ${pPair[0]} store ${pKey}`).to.equal(tmpStoreMap[pKey]); });
												Expect(pPair[1].Results.ByStore.DistinctKeys).to.equal(Object.keys(tmpStoreMap).length);
											});
										Expect(pTenantTwo.Results['#Total'].Total).to.be.below(pTenantOne.Results['#Total'].Total);
										Expect(pTenantOne.Captures.BookStoreSale.Fingerprint).to.not.equal(pTenantTwo.Captures.BookStoreSale.Fingerprint);
										Expect(pTenantOne.Captures.BookStoreSale.Repaired).to.equal(false);
										return fDone();
									});
							});
					});

				test('the capture appends tenancy at depth 0 after the fence; a client tenant predicate stays fenced',
					(fDone) =>
					{
						let H = _Harness;
						// Tenant 1 asks for tenant 2's rows in its own filter: the fence keeps it inside, tenancy still ANDs.
						let tmpContext = newContext(H, 'BookStoreSale', {}, { Tenant: 1 });
						let tmpRel = { Entity: 'BookStoreSale', As: 'p', Project: [ 'IDBookStoreSale' ], Client: [ conjunct('c1', { Or: [ { Field: 'IDTenant', Op: 'EQ', Value: 2 }, { Field: 'PaymentMethod', Op: 'EQ', Value: 'Cash' } ] }) ], Where: null, Scope: 'Inherit', SoftDelete: 'Explicit' };
						H.fable.RetoldFacetingScopedRelationBuilder.buildRelation(tmpContext, tmpRel,
							(pError, pRelation) =>
							{
								Expect(pError).to.equal(null);
								Expect(pRelation.SQL).to.match(/WHERE \( \( `IDTenant` = :p_c1_IDTenant_w2 OR `PaymentMethod` = :p_c1_PaymentMethod_w3 \) \) AND `Deleted` = :p_FacetSoftDelete_w6 AND `IDTenant` = :p_TestTenancy_w7$/);
								Expect(pRelation.Params.p_TestTenancy_w7).to.equal(1);
								Expect(pRelation.Capture.Appended).to.deep.equal([ { Column: 'IDTenant', Operator: '=', Value: 1, Connector: 'AND', Parameter: 'TestTenancy', Depth: 0 } ]);
								Expect(pRelation.Capture.Guard).to.include({ Mode: 'Strict', Satisfied: true, Repaired: false });
								Expect(pRelation.Capture.BehaviorRan).to.equal(true);
								let tmpRows = H.db.prepare(`SELECT count(*) AS N FROM (${pRelation.SQL}) "p"`).get(pRelation.Params).N;
								let tmpExpected = H.db.prepare("SELECT count(*) AS N FROM BookStoreSale WHERE IDTenant = 1 AND Deleted = 0 AND (IDTenant = 2 OR PaymentMethod = 'Cash')").get().N;
								Expect(tmpRows).to.equal(tmpExpected);
								return setImmediate(fDone);
							});
					});

				test('anonymous: the behavior\'s 401 is a whole-request FACET_UNAUTHENTICATED',
					(fDone) =>
					{
						let H = _Harness;
						execute(H.fable.RetoldFacetingEngineLive, newContext(H, 'BookStoreSale', { v0: variant('v0', 'BookStoreSale', []) }, {}), tenantAggs(H),
							(pError, pExecution) =>
							{
								Expect(pError.Code).to.equal('FACET_UNAUTHENTICATED');
								Expect(pError.Status).to.equal(401);
								Expect(pExecution).to.equal(undefined);
								return fDone();
							});
					});

				test('a clobbered behavior (no tenancy): Strict refuses the whole request; Repair restores exactly the tenant\'s rows',
					(fDone) =>
					{
						let H = _Harness;
						let fRestore = swapBehavior(H, 'BookStoreSale', function (pRequest, pRequestState, fCallback) { return fCallback(); });
						execute(H.fable.RetoldFacetingEngineLive, newContext(H, 'BookStoreSale', { v0: variant('v0', 'BookStoreSale', []) }, { Tenant: 2 }), tenantAggs(H),
							(pStrictError) =>
							{
								Expect(pStrictError.Code).to.equal('FACET_SCOPE_POLICY_VIOLATION');
								Expect(pStrictError.Detail).to.deep.equal({ Entity: 'BookStoreSale', Violations: [ { Rule: 'MissingPredicate', Column: 'IDTenant' } ] });
								let tmpRepairContext = withGuard(newContext(H, 'BookStoreSale', { v0: variant('v0', 'BookStoreSale', []) }, { Tenant: 2 }), 'Repair');
								execute(H.fable.RetoldFacetingEngineLive, tmpRepairContext, tenantAggs(H),
									(pRepairError, pRepaired) =>
									{
										fRestore();
										Expect(pRepairError).to.equal(null);
										Expect(pRepaired.Captures.BookStoreSale.Repaired).to.equal(true);
										let tmpExpected = H.db.prepare('SELECT count(*) AS N FROM BookStoreSale WHERE IDTenant = 2 AND Deleted = 0').get().N;
										Expect(pRepaired.Results['#Total'].Total).to.equal(tmpExpected);
										return fDone();
									});
							});
					});

				test('behaviors that OR at depth 0, use the wrong tenant, or add a join are refused in Strict and in Repair',
					(fDone) =>
					{
						let H = _Harness;
						let tmpCases = (
							[
								{
									Name: 'DepthZeroOr',
									Behavior: function (pRequest, pRequestState, fCallback)
									{
										pRequestState.Query.addFilter('IDTenant', pRequestState.SessionData.IDTenant, '=', 'AND', 'TestTenancy');
										pRequestState.Query.addFilter('IDBookStore', 1, '=', 'OR', 'PublicStore');
										return fCallback();
									},
									Expect: (pError) => { Expect(pError.Detail.Violations).to.deep.equal([ { Rule: 'DepthZeroOr' } ]); }
								},
								{
									Name: 'WrongValue',
									Behavior: function (pRequest, pRequestState, fCallback)
									{
										pRequestState.Query.addFilter('IDTenant', 1, '=', 'AND', 'TestTenancy');
										return fCallback();
									},
									Expect: (pError) => { Expect(pError.Detail.Violations).to.deep.equal([ { Rule: 'WrongValue', Column: 'IDTenant' } ]); }
								},
								{
									Name: 'Opaque',
									Behavior: function (pRequest, pRequestState, fCallback)
									{
										pRequestState.Query.addFilter('IDTenant', pRequestState.SessionData.IDTenant, '=', 'AND', 'TestTenancy');
										pRequestState.Query.addJoin('BookStore', 'BookStore.IDBookStore', 'BookStoreSale.IDBookStore');
										return fCallback();
									},
									Expect: (pError) => { Expect(pError.Detail.Violations).to.deep.equal([ { Rule: 'OpaqueUntrusted' } ]); }
								},
								{
									Name: 'Throws',
									Behavior: function (pRequest, pRequestState, fCallback)
									{
										throw new Error('behavior bug');
									},
									Expect: (pError) => { Expect(pError.Code).to.equal('FACET_INTERNAL'); }
								}
							]);
						let fNext = (pIndex) =>
						{
							if (pIndex >= (tmpCases.length * 2))
							{
								return fDone();
							}
							let tmpCase = tmpCases[Math.floor(pIndex / 2)];
							let tmpMode = (pIndex % 2 === 0) ? 'Strict' : 'Repair';
							let fRestore = swapBehavior(H, 'BookStoreSale', tmpCase.Behavior);
							execute(H.fable.RetoldFacetingEngineLive, withGuard(newContext(H, 'BookStoreSale', { v0: variant('v0', 'BookStoreSale', []) }, { Tenant: 2 }), tmpMode), tenantAggs(H),
								(pError, pExecution) =>
								{
									fRestore();
									Expect(pError, `${tmpCase.Name} / ${tmpMode}`).to.be.an('error');
									Expect(pExecution).to.equal(undefined);
									if (tmpCase.Name !== 'Throws')
									{
										Expect(pError.Code, `${tmpCase.Name} / ${tmpMode}`).to.equal('FACET_SCOPE_POLICY_VIOLATION');
									}
									tmpCase.Expect(pError);
									return fNext(pIndex + 1);
								});
						};
						fNext(0);
					});

				test('an added behavior that chains with tenancy is captured (Appended) and still equals the Reference',
					(fDone) =>
					{
						let H = _Harness;
						let tmpController = H.fable.RetoldFacetingHostDataService.getRouteBoundController('BookStoreSale');
						let fTenancy = tmpController.BehaviorInjection._BehaviorFunctions['Reads-QueryConfiguration'];
						let fRestore = swapBehavior(H, 'BookStoreSale',
							function (pRequest, pRequestState, fCallback)
							{
								return fTenancy.call(this, pRequest, pRequestState,
									(pError) =>
									{
										if (pError)
										{
											return fCallback(pError);
										}
										pRequestState.Query.addFilter('PaymentMethod', 'Online', '!=', 'AND', 'NoOnline');
										return fCallback();
									});
							});
						compareEngines(H, 'BookStoreSale', () => { return { v0: variant('v0', 'BookStoreSale', []) }; }, tenantAggs(H), { Tenant: 1 },
							(pLive) =>
							{
								fRestore();
								Expect(pLive.Results.ByPayment.Groups.map((pGroup) => { return pGroup.Key; })).to.not.include('Online');
								let tmpExpected = H.db.prepare("SELECT count(*) AS N FROM BookStoreSale WHERE IDTenant = 1 AND Deleted = 0 AND PaymentMethod != 'Online'").get().N;
								Expect(pLive.Results['#Total'].Total).to.equal(tmpExpected);
								return fDone();
							});
					});
			}
		);
	}
);
