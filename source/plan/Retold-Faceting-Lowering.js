/**
 * Retold Faceting - Lowering
 *
 * Pure helpers the Planner uses to lower BOUND canonical predicates and definitions into FoldIR
 * (internal-contracts §24.8).  Not a service: every function takes an environment
 *
 *   pEnv = { Catalog, Graph, Counter: AliasCounter, Memo: Map }
 *
 * and never reads fable.  Nothing here touches a database; nothing here is solved at query time
 * (paths arrive resolved as PathPlans, internal-contracts §21.2).
 *
 * Lowering rules (normative, internal-contracts §24.8):
 *   Exists { Path s₁…sₙ, Where W, Correlate C } at outer alias o
 *     → Exists { Rel(s₁.To, Where col(s₁.Where)), On s₁.On (Outer o),
 *                Where And(path(s₁.Where), <s₂ … the same, Outer = s₁'s alias>) }
 *     the innermost Rel's Where = col(sₙ.Where ∧ W), its nested Where = path(sₙ.Where ∧ W), and C is
 *     appended to the innermost On with Outer = the alias the path starts from (the pivot, or the
 *     TuplePivot side named by From / by the pair's own alias).
 *   NotExists → the OUTERMOST node is NotExists, every inner node Exists ("no visible chain").
 *   co-reference step with CheckParent → inside that Exists's Where an Exists over Rel(Parent).
 *   HavingCount (one step) → CountCmp.
 *   And → And; Or stays whole (its leaves Cmp on the alias in scope).
 *   col(X) / path(X): split of an And — column-only items go into the Rel's Where (ColumnPred),
 *   items holding existence nodes stay nested FoldPreds.
 *   step Scope 'TenantOnly' → Rel.Scope / ScopeReason.
 *
 * Aliases are plan-wide unique (one counter per prefix): 'p' the pivot / Home side, 'p<n>' extra
 * pivot renderings, 'u<n>' tuple sides, 'h<n>' Variant filter hops, 'j<n>' definition Where hops,
 * 'l<n>' Via lookups, 'm<n>' Multi chains, 'x<n>' ChildAgg children, 'e<n>' ExistsFlag hops; parent
 * checks take their chain's prefix.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libFacetBuckets = require('../contract/Facet-Contract-Buckets.js');
const libFacetClauses = require('../contract/Facet-Contract-Clauses.js');
const libFacetUtil = require('../contract/Facet-Contract-Util.js');
const libRetoldFacetingFoldIR = require('./Retold-Faceting-FoldIR.js');

const hasOwn = libFacetUtil.hasOwn;
const isPlainObject = libFacetUtil.isPlainObject;

// Canonical / bound existence node kinds.
const EXISTENCE_KINDS = Object.freeze([ 'Exists', 'NotExists', 'HavingCount' ]);

// Every alias prefix the plan uses (internal-contracts §24.7).
const ALIAS_PREFIXES = Object.freeze([ 'p', 'u', 'h', 'j', 'l', 'm', 'x', 'e' ]);

// FoldPred comparison ops for CountCmp.
const COUNT_OPS = Object.freeze([ 'EQ', 'NE', 'GT', 'GE', 'LT', 'LE' ]);

/**
 * The plan-wide alias counter.
 */
class AliasCounter
{
	constructor()
	{
		this.Counts = {};
		ALIAS_PREFIXES.forEach((pPrefix) => { this.Counts[pPrefix] = 0; });
		// 'p' itself is the pivot; extra pivot renderings start at 'p2'.
		this.Counts.p = 1;
	}

	/**
	 * @param {string} pPrefix - one of ALIAS_PREFIXES
	 * @return {string} the next alias for that prefix ('h1', 'h2', … ; 'p2', 'p3', …)
	 */
	next(pPrefix)
	{
		if (!hasOwn(this.Counts, pPrefix))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'Lowering: unknown alias prefix.');
		}
		this.Counts[pPrefix]++;
		return pPrefix + this.Counts[pPrefix];
	}
}

/**
 * @return {AliasCounter}
 */
const newAliasCounter = () =>
{
	return new AliasCounter();
};

/**
 * Does a canonical / bound predicate hold an existence node anywhere?
 *
 * @param {any} pPred
 * @return {boolean}
 */
const hasExistence = (pPred) =>
{
	if (!isPlainObject(pPred))
	{
		return false;
	}
	for (let i = 0; i < EXISTENCE_KINDS.length; i++)
	{
		if (isPlainObject(pPred[EXISTENCE_KINDS[i]]))
		{
			return true;
		}
	}
	let tmpChildren = Array.isArray(pPred.And) ? pPred.And : Array.isArray(pPred.Or) ? pPred.Or : [];
	for (let i = 0; i < tmpChildren.length; i++)
	{
		if (hasExistence(tmpChildren[i]))
		{
			return true;
		}
	}
	return false;
};

/**
 * The And of two canonical / bound predicates (either may be null; nested Ands are flattened).
 *
 * @param {any} pA
 * @param {any} pB
 * @return {any}
 */
const andPred = (pA, pB) =>
{
	let tmpItems = [];
	[ pA, pB ].forEach(
		(pPred) =>
		{
			if (!isPlainObject(pPred))
			{
				return;
			}
			if (Array.isArray(pPred.And))
			{
				tmpItems = tmpItems.concat(pPred.And);
				return;
			}
			tmpItems.push(pPred);
		});
	if (tmpItems.length < 1)
	{
		return null;
	}
	return (tmpItems.length === 1) ? tmpItems[0] : { And: tmpItems };
};

/**
 * col(X) / path(X): split the items of an And (a non-And is one item) into the column-only part
 * (a ColumnPred for a Rel's Where) and the items holding existence nodes.
 *
 * @param {any} pPred
 * @return {{ Col: any, Path: Array<any> }}
 */
const splitWhere = (pPred) =>
{
	if (!isPlainObject(pPred))
	{
		return { Col: null, Path: [] };
	}
	let tmpItems = Array.isArray(pPred.And) ? pPred.And : [ pPred ];
	let tmpColumn = [];
	let tmpPath = [];
	for (let i = 0; i < tmpItems.length; i++)
	{
		if (hasExistence(tmpItems[i]))
		{
			tmpPath.push(tmpItems[i]);
		}
		else
		{
			tmpColumn.push(columnPred(tmpItems[i]));
		}
	}
	return (
		{
			Col: (tmpColumn.length < 1) ? null : ((tmpColumn.length === 1) ? tmpColumn[0] : { And: tmpColumn }),
			Path: tmpPath
		});
};

/**
 * A column-only predicate in the plain Pred grammar ({ Field, Op, Value } / And / Or), copied.
 *
 * @param {any} pPred
 * @return {Record<string, any>}
 */
const columnPred = (pPred) =>
{
	if (Array.isArray(pPred.And) || Array.isArray(pPred.Or))
	{
		let tmpKind = Array.isArray(pPred.And) ? 'And' : 'Or';
		let tmpNode = {};
		tmpNode[tmpKind] = pPred[tmpKind].map(columnPred);
		return tmpNode;
	}
	if ((typeof(pPred.Field) !== 'string') || (typeof(pPred.Op) !== 'string'))
	{
		throw libFacetErrors.create('FACET_INTERNAL', 'Lowering: malformed column predicate.');
	}
	let tmpLeaf = { Field: pPred.Field, Op: pPred.Op };
	if (hasOwn(pPred, 'Value'))
	{
		tmpLeaf.Value = Array.isArray(pPred.Value) ? pPred.Value.slice() : pPred.Value;
	}
	if (hasOwn(pPred, 'Bind'))
	{
		// An unbound leaf must never reach a plan.
		throw libFacetErrors.create('FACET_INTERNAL', 'Lowering: an unbound predicate leaf.');
	}
	return tmpLeaf;
};

/**
 * The primary key of an entity (catalog first, then the graph).
 *
 * @param {Record<string, any>} pEnv
 * @param {string} pEntity
 * @return {string|null}
 */
const primaryKey = (pEnv, pEntity) =>
{
	let tmpDescriptor = (pEnv.Catalog && (typeof(pEnv.Catalog.getFacetable) === 'function')) ? pEnv.Catalog.getFacetable(pEntity) : null;
	if (tmpDescriptor && (typeof(tmpDescriptor.PK) === 'string'))
	{
		return tmpDescriptor.PK;
	}
	return (pEnv.Graph && (typeof(pEnv.Graph.primaryKey) === 'function')) ? pEnv.Graph.primaryKey(pEntity) : null;
};

/**
 * Is a column of an entity integer-typed (Staged keys are integers only)?
 *
 * @param {Record<string, any>} pEnv
 * @param {string} pEntity
 * @param {string} pColumn
 * @return {boolean}
 */
const isIntegerColumn = (pEnv, pEntity, pColumn) =>
{
	let tmpColumn = (pEnv.Catalog && (typeof(pEnv.Catalog.column) === 'function')) ? pEnv.Catalog.column(pEntity, pColumn) : null;
	if (!tmpColumn)
	{
		return false;
	}
	if (tmpColumn.IsInteger === true)
	{
		return true;
	}
	return libFacetBuckets.isIntegerType(tmpColumn.DataType);
};

/**
 * The SQL alias a predicate scope maps a TuplePivot side name to.
 *
 * @param {Record<string, any>} pScope
 * @param {string|null} pName
 * @return {string}
 */
const sideAlias = (pScope, pName) =>
{
	if ((pName === null) || (typeof(pName) === 'undefined'))
	{
		return pScope.Alias;
	}
	let tmpNames = isPlainObject(pScope.Names) ? pScope.Names : {};
	if (!hasOwn(tmpNames, pName))
	{
		throw libFacetErrors.create('FACET_INTERNAL', 'Lowering: a predicate names an unknown tuple side.');
	}
	return tmpNames[pName];
};

/**
 * A FoldPred And / Or of lowered items (null for none, the item for one).
 *
 * @param {string} pNode - 'And' | 'Or'
 * @param {Array<any>} pItems
 * @return {Record<string, any>|null}
 */
const combineNodes = (pNode, pItems) =>
{
	let tmpItems = [];
	for (let i = 0; i < pItems.length; i++)
	{
		let tmpItem = pItems[i];
		if (!isPlainObject(tmpItem))
		{
			continue;
		}
		if (tmpItem.Node === pNode)
		{
			tmpItems = tmpItems.concat(tmpItem.Items);
			continue;
		}
		tmpItems.push(tmpItem);
	}
	if (tmpItems.length < 1)
	{
		return null;
	}
	if (tmpItems.length === 1)
	{
		return tmpItems[0];
	}
	return { Node: pNode, Items: tmpItems };
};

/**
 * The On pairs of a PathPlan step from an outer alias.
 *
 * @param {Record<string, any>} pStep
 * @param {string} pOuterAlias
 * @return {Array<Record<string, any>>}
 */
const stepOn = (pStep, pOuterAlias) =>
{
	let tmpOn = Array.isArray(pStep.On) ? pStep.On : [];
	if (tmpOn.length < 1)
	{
		throw libFacetErrors.create('FACET_INTERNAL', 'Lowering: a path step has no On pairs.');
	}
	return tmpOn.map(
		(pPair) =>
		{
			if (!Array.isArray(pPair) || (pPair.length !== 2) || (typeof(pPair[0]) !== 'string') || (typeof(pPair[1]) !== 'string'))
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'Lowering: a malformed step On pair.');
			}
			return { Outer: { Alias: pOuterAlias, Field: pPair[0] }, Inner: pPair[1] };
		});
};

/**
 * Stage: 'Allowed' for a leaf existence Rel (no nested Where) whose every inner On column is an
 * integer column (internal-contracts §24.1, §26.3), else 'Never'.
 *
 * @param {Record<string, any>} pEnv
 * @param {Record<string, any>} pRel
 * @param {Array<Record<string, any>>} pOn
 * @param {any} pNestedWhere
 * @return {string}
 */
const stageFor = (pEnv, pRel, pOn, pNestedWhere) =>
{
	if (pNestedWhere !== null)
	{
		return 'Never';
	}
	for (let i = 0; i < pOn.length; i++)
	{
		if (!isIntegerColumn(pEnv, pRel.Entity, pOn[i].Inner))
		{
			return 'Never';
		}
	}
	return 'Allowed';
};

/**
 * Lower a BOUND predicate at a scope.
 *
 * @param {any} pPred - bound Pred (internal-contracts §23.2)
 * @param {{ Alias: string, Entity: string, Prefix: string, Names?: Record<string, string>, SideEntities?: Record<string, string> }} pScope
 * @param {Record<string, any>} pEnv
 * @return {Record<string, any>|null} FoldPred
 */
const lowerPred = (pPred, pScope, pEnv) =>
{
	if ((pPred === null) || (typeof(pPred) === 'undefined'))
	{
		return null;
	}
	if (!isPlainObject(pPred))
	{
		throw libFacetErrors.create('FACET_INTERNAL', 'Lowering: malformed predicate.');
	}
	if (Array.isArray(pPred.And))
	{
		return combineNodes('And', pPred.And.map((pItem) => { return lowerPred(pItem, pScope, pEnv); }));
	}
	if (Array.isArray(pPred.Or))
	{
		let tmpItems = pPred.Or.map((pItem) => { return lowerPred(pItem, pScope, pEnv); });
		if (tmpItems.length === 1)
		{
			return tmpItems[0];
		}
		return { Node: 'Or', Items: tmpItems };
	}
	if (isPlainObject(pPred.Exists))
	{
		return lowerExistence('Exists', pPred.Exists, pScope, pEnv);
	}
	if (isPlainObject(pPred.NotExists))
	{
		return lowerExistence('NotExists', pPred.NotExists, pScope, pEnv);
	}
	if (isPlainObject(pPred.HavingCount))
	{
		return lowerCountCmp(pPred.HavingCount, pScope, pEnv);
	}
	if (pPred.True === true)
	{
		return { Node: 'True' };
	}
	if (pPred.False === true)
	{
		return { Node: 'False' };
	}
	// A column leaf on the scope alias (or a tuple side: 'alias.Field' / Alias).
	let tmpAlias = pScope.Alias;
	let tmpField = pPred.Field;
	if (typeof(pPred.Alias) === 'string')
	{
		tmpAlias = sideAlias(pScope, pPred.Alias);
	}
	else if ((typeof(tmpField) === 'string') && (tmpField.indexOf('.') > 0) && isPlainObject(pScope.Names))
	{
		tmpAlias = sideAlias(pScope, tmpField.substring(0, tmpField.indexOf('.')));
		tmpField = tmpField.substring(tmpField.indexOf('.') + 1);
	}
	let tmpLeaf = columnPred(Object.assign({}, pPred, { Field: tmpField }));
	return Object.assign({ Node: 'Cmp', Alias: tmpAlias }, tmpLeaf);
};

/**
 * Lower an Exists / NotExists node (internal-contracts §24.8).
 *
 * @param {string} pKind - 'Exists' | 'NotExists'
 * @param {Record<string, any>} pBody - { From, Path: PathPlan, Where, Correlate }
 * @param {Record<string, any>} pScope
 * @param {Record<string, any>} pEnv
 * @return {Record<string, any>}
 */
const lowerExistence = (pKind, pBody, pScope, pEnv) =>
{
	let tmpPath = isPlainObject(pBody.Path) ? pBody.Path : null;
	let tmpSteps = (tmpPath && Array.isArray(tmpPath.Steps)) ? tmpPath.Steps : [];
	if (tmpSteps.length < 1)
	{
		throw libFacetErrors.create('FACET_INTERNAL', 'Lowering: an existence node has no path.');
	}
	let tmpStartAlias = sideAlias(pScope, (typeof(pBody.From) === 'string') ? pBody.From : null);
	let tmpCorrelate = correlatePairs(pBody.Correlate, pScope, tmpStartAlias);
	let tmpNode = lowerChain(tmpSteps, 0, tmpStartAlias, (pBody.Where === undefined) ? null : pBody.Where, tmpCorrelate, pScope, pEnv);
	if (pKind === 'NotExists')
	{
		// Only the outermost node negates: "no visible chain".
		tmpNode.Node = 'NotExists';
	}
	return tmpNode;
};

/**
 * Correlate pairs → On pairs (Outer = the path's start alias unless the pair names a side).
 *
 * @param {any} pCorrelate - [ { Outer: { Alias, Field }, Inner } ] (canonical) or [ [ outer, inner ] ]
 * @param {Record<string, any>} pScope
 * @param {string} pStartAlias
 * @return {Array<Record<string, any>>}
 */
const correlatePairs = (pCorrelate, pScope, pStartAlias) =>
{
	let tmpPairs = Array.isArray(pCorrelate) ? pCorrelate : [];
	return tmpPairs.map(
		(pPair) =>
		{
			let tmpOuterAlias = null;
			let tmpOuterField = null;
			let tmpInner = null;
			if (Array.isArray(pPair))
			{
				// Tolerate the authored form [ 'r.Field' | 'Field', 'Inner' ].
				let tmpOuter = String(pPair[0]);
				if (tmpOuter.indexOf('.') > 0)
				{
					tmpOuterAlias = tmpOuter.substring(0, tmpOuter.indexOf('.'));
					tmpOuterField = tmpOuter.substring(tmpOuter.indexOf('.') + 1);
				}
				else
				{
					tmpOuterField = tmpOuter;
				}
				tmpInner = pPair[1];
			}
			else if (isPlainObject(pPair) && isPlainObject(pPair.Outer))
			{
				tmpOuterAlias = (typeof(pPair.Outer.Alias) === 'string') ? pPair.Outer.Alias : null;
				tmpOuterField = pPair.Outer.Field;
				tmpInner = pPair.Inner;
			}
			if ((typeof(tmpOuterField) !== 'string') || (typeof(tmpInner) !== 'string'))
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'Lowering: a malformed Correlate pair.');
			}
			return { Outer: { Alias: (tmpOuterAlias === null) ? pStartAlias : sideAlias(pScope, tmpOuterAlias), Field: tmpOuterField }, Inner: tmpInner };
		});
};

/**
 * The parent check of a co-reference step (CheckParent: true): an Exists over Rel(Parent)
 * correlated to the co-referenced entity's FK (01 §4.5).
 *
 * @param {Record<string, any>} pStep
 * @param {string} pInnerAlias - the alias of the co-referenced entity's Rel
 * @param {Record<string, any>} pScope
 * @param {Record<string, any>} pEnv
 * @return {Record<string, any>}
 */
const parentCheck = (pStep, pInnerAlias, pScope, pEnv) =>
{
	let tmpParent = pStep.Parent;
	if (typeof(tmpParent) !== 'string')
	{
		throw libFacetErrors.create('FACET_INTERNAL', 'Lowering: a co-reference step without a Parent.');
	}
	let tmpEdge = (pEnv.Graph && (typeof(pEnv.Graph.edge) === 'function') && (typeof(pStep.Edge) === 'string')) ? pEnv.Graph.edge(pStep.Edge) : null;
	let tmpParentKey = (tmpEdge && (typeof(tmpEdge.ToColumn) === 'string')) ? tmpEdge.ToColumn : primaryKey(pEnv, tmpParent);
	let tmpColumn = pStep.On[0][1];
	let tmpRel = libRetoldFacetingFoldIR.newRel({ Entity: tmpParent, As: pEnv.Counter.next(pScope.Prefix), Role: 'Parent' });
	let tmpOn = [ { Outer: { Alias: pInnerAlias, Field: tmpColumn }, Inner: tmpParentKey } ];
	tmpRel.Stage = stageFor(pEnv, tmpRel, tmpOn, null);
	return { Node: 'Exists', Rel: tmpRel, On: tmpOn, Where: null };
};

/**
 * Lower steps[i…] of an existence path (Exists nodes; the caller negates the outermost).
 *
 * @param {Array<Record<string, any>>} pSteps
 * @param {number} pIndex
 * @param {string} pOuterAlias
 * @param {any} pFinalWhere - the existence node's Where (on the last step's target)
 * @param {Array<Record<string, any>>} pCorrelate - On pairs appended to the innermost node
 * @param {Record<string, any>} pScope
 * @param {Record<string, any>} pEnv
 * @return {Record<string, any>}
 */
const lowerChain = (pSteps, pIndex, pOuterAlias, pFinalWhere, pCorrelate, pScope, pEnv) =>
{
	let tmpStep = pSteps[pIndex];
	let tmpLast = (pIndex === (pSteps.length - 1));
	let tmpAlias = pEnv.Counter.next(pScope.Prefix);
	let tmpWhere = tmpLast ? andPred(tmpStep.Where, pFinalWhere) : (isPlainObject(tmpStep.Where) ? tmpStep.Where : null);
	let tmpSplit = splitWhere(tmpWhere);
	let tmpRel = libRetoldFacetingFoldIR.newRel(
		{
			Entity: tmpStep.To,
			As: tmpAlias,
			Role: 'Hop',
			Where: tmpSplit.Col,
			Scope: (tmpStep.Scope === 'TenantOnly') ? 'TenantOnly' : 'Inherit',
			ScopeReason: (tmpStep.Scope === 'TenantOnly') ? (tmpStep.ScopeReason || null) : null
		});
	let tmpOn = stepOn(tmpStep, pOuterAlias);
	if (tmpLast)
	{
		tmpOn = tmpOn.concat(pCorrelate);
	}
	let tmpInnerScope = { Alias: tmpAlias, Entity: tmpStep.To, Prefix: pScope.Prefix, Names: pScope.Names, SideEntities: pScope.SideEntities };
	let tmpNested = [];
	if (tmpStep.CheckParent === true)
	{
		tmpNested.push(parentCheck(tmpStep, tmpAlias, pScope, pEnv));
	}
	for (let i = 0; i < tmpSplit.Path.length; i++)
	{
		tmpNested.push(lowerPred(tmpSplit.Path[i], tmpInnerScope, pEnv));
	}
	if (!tmpLast)
	{
		tmpNested.push(lowerChain(pSteps, pIndex + 1, tmpAlias, pFinalWhere, pCorrelate, pScope, pEnv));
	}
	let tmpNestedWhere = combineNodes('And', tmpNested);
	tmpRel.Stage = stageFor(pEnv, tmpRel, tmpOn, tmpNestedWhere);
	return { Node: 'Exists', Rel: tmpRel, On: tmpOn, Where: tmpNestedWhere };
};

/**
 * Lower a HavingCount node (one '<' or '=' step) into CountCmp.
 *
 * @param {Record<string, any>} pBody - { From, Path, Where, Correlate, Op, Value }
 * @param {Record<string, any>} pScope
 * @param {Record<string, any>} pEnv
 * @return {Record<string, any>}
 */
const lowerCountCmp = (pBody, pScope, pEnv) =>
{
	let tmpSteps = (isPlainObject(pBody.Path) && Array.isArray(pBody.Path.Steps)) ? pBody.Path.Steps : [];
	if ((tmpSteps.length !== 1) || (tmpSteps[0].Direction === 'Forward'))
	{
		throw libFacetErrors.create('FACET_FOLD_UNSUPPORTED', null, { Feature: 'HavingCountPath', Milestone: 2 });
	}
	if (COUNT_OPS.indexOf(pBody.Op) < 0)
	{
		throw libFacetErrors.create('FACET_INTERNAL', 'Lowering: HavingCount has an unknown operator.');
	}
	let tmpN = libFacetUtil.toFiniteNumber(pBody.Value);
	if ((tmpN === null) || !Number.isInteger(tmpN))
	{
		throw libFacetErrors.create('FACET_INTERNAL', 'Lowering: HavingCount needs an integer Value.');
	}
	let tmpStartAlias = sideAlias(pScope, (typeof(pBody.From) === 'string') ? pBody.From : null);
	let tmpNode = lowerChain(tmpSteps, 0, tmpStartAlias, (pBody.Where === undefined) ? null : pBody.Where, correlatePairs(pBody.Correlate, pScope, tmpStartAlias), pScope, pEnv);
	tmpNode.Rel.Stage = 'Never';
	return { Node: 'CountCmp', Rel: tmpNode.Rel, On: tmpNode.On, Where: tmpNode.Where, Op: pBody.Op, N: tmpN };
};

/**
 * Memoize a lowered structure by its canonical (alias-free) key, so identical dimensions share
 * Rels (the cube then de-duplicates them by canonical JSON).
 *
 * @param {Record<string, any>} pEnv
 * @param {string} pKind
 * @param {any} pKeyMaterial
 * @param {() => any} fBuild
 * @return {any}
 */
const memo = (pEnv, pKind, pKeyMaterial, fBuild) =>
{
	if (!(pEnv.Memo instanceof Map))
	{
		return fBuild();
	}
	let tmpKey = pKind + '|' + libFacetClauses.canonicalJSON(pKeyMaterial);
	if (!pEnv.Memo.has(tmpKey))
	{
		pEnv.Memo.set(tmpKey, fBuild());
	}
	return pEnv.Memo.get(tmpKey);
};

/**
 * The alias-free key material of a bound PathPlan (Raw step strings, step Wheres, scope modes).
 *
 * @param {Record<string, any>} pPathPlan
 * @return {Array<any>}
 */
const pathKey = (pPathPlan) =>
{
	let tmpSteps = (isPlainObject(pPathPlan) && Array.isArray(pPathPlan.Steps)) ? pPathPlan.Steps : [];
	return tmpSteps.map((pStep) => { return { Raw: pStep.Raw, Edge: pStep.Edge, On: pStep.On, Where: pStep.Where || null, Scope: pStep.Scope || 'Inherit', CheckParent: pStep.CheckParent === true }; });
};

/**
 * K8: the to-one Via chain of a dimension path (one Lookup Rel per step; a step Where's column
 * part becomes the Rel's Where; a path part is refused, 'LookupPathWhere').
 *
 * @param {Record<string, any>} pPathPlan - bound
 * @param {string} pStartAlias
 * @param {Record<string, any>} pEnv
 * @return {Array<{ Rel: Record<string, any>, On: Array<Record<string, any>> }>}
 */
const lowerVia = (pPathPlan, pStartAlias, pEnv) =>
{
	return memo(pEnv, 'Via', { Start: pStartAlias, Path: pathKey(pPathPlan) },
		() =>
		{
			let tmpSteps = (isPlainObject(pPathPlan) && Array.isArray(pPathPlan.Steps)) ? pPathPlan.Steps : [];
			let tmpLinks = [];
			let tmpOuter = pStartAlias;
			for (let i = 0; i < tmpSteps.length; i++)
			{
				let tmpStep = tmpSteps[i];
				if (tmpStep.Direction !== 'Forward')
				{
					throw libFacetErrors.create('FACET_INTERNAL', 'Lowering: a Via path must be to-one.');
				}
				let tmpSplit = splitWhere(tmpStep.Where);
				if (tmpSplit.Path.length > 0)
				{
					throw libFacetErrors.create('FACET_FOLD_UNSUPPORTED', null, { Feature: 'LookupPathWhere', Milestone: 2 });
				}
				let tmpRel = libRetoldFacetingFoldIR.newRel({ Entity: tmpStep.To, As: pEnv.Counter.next('l'), Role: 'Lookup', Where: tmpSplit.Col });
				tmpLinks.push({ Rel: tmpRel, On: stepOn(tmpStep, tmpOuter) });
				tmpOuter = tmpRel.As;
			}
			return tmpLinks;
		});
};

/**
 * K9: the Multi chain of a to-many dimension path (one Multi Rel per step; step Wheres split
 * col / path; the dimension's Where joins the last step's).  Path parts become Multi.Where, which
 * is evaluated with every chain alias in scope.
 *
 * @param {Record<string, any>} pPathPlan - bound
 * @param {any} pDimensionWhere - bound, on the last entity
 * @param {string} pStartAlias
 * @param {Record<string, any>} pEnv
 * @return {{ Chain: Array<Record<string, any>>, Where: Record<string, any>|null }}
 */
const lowerMulti = (pPathPlan, pDimensionWhere, pStartAlias, pEnv) =>
{
	return memo(pEnv, 'Multi', { Start: pStartAlias, Path: pathKey(pPathPlan), Where: pDimensionWhere || null },
		() =>
		{
			let tmpSteps = (isPlainObject(pPathPlan) && Array.isArray(pPathPlan.Steps)) ? pPathPlan.Steps : [];
			let tmpChain = [];
			let tmpNested = [];
			let tmpOuter = pStartAlias;
			for (let i = 0; i < tmpSteps.length; i++)
			{
				let tmpStep = tmpSteps[i];
				let tmpLast = (i === (tmpSteps.length - 1));
				let tmpSplit = splitWhere(tmpLast ? andPred(tmpStep.Where, pDimensionWhere) : tmpStep.Where);
				let tmpRel = libRetoldFacetingFoldIR.newRel({ Entity: tmpStep.To, As: pEnv.Counter.next('m'), Role: 'Multi', Where: tmpSplit.Col });
				tmpChain.push({ Rel: tmpRel, On: stepOn(tmpStep, tmpOuter) });
				let tmpInnerScope = { Alias: tmpRel.As, Entity: tmpStep.To, Prefix: 'm' };
				if (tmpStep.CheckParent === true)
				{
					tmpNested.push(parentCheck(tmpStep, tmpRel.As, tmpInnerScope, pEnv));
				}
				for (let j = 0; j < tmpSplit.Path.length; j++)
				{
					tmpNested.push(lowerPred(tmpSplit.Path[j], tmpInnerScope, pEnv));
				}
				tmpOuter = tmpRel.As;
			}
			return { Chain: tmpChain, Where: combineNodes('And', tmpNested) };
		});
};

/**
 * K12: the child relation of a ChildRollup (one '<' step), restricted by the child Where.
 *
 * @param {Record<string, any>} pChild - bound { Path, Agg, Field, Where }
 * @param {string} pStartAlias
 * @param {Record<string, any>} pEnv
 * @return {{ Rel: Record<string, any>, On: Array<Record<string, any>>, Where: Record<string, any>|null }}
 */
const lowerChild = (pChild, pStartAlias, pEnv) =>
{
	return memo(pEnv, 'Child', { Start: pStartAlias, Path: pathKey(pChild.Path), Where: pChild.Where || null },
		() =>
		{
			let tmpSteps = (isPlainObject(pChild.Path) && Array.isArray(pChild.Path.Steps)) ? pChild.Path.Steps : [];
			if ((tmpSteps.length !== 1) || (tmpSteps[0].Direction !== 'Reverse'))
			{
				throw libFacetErrors.create('FACET_FOLD_UNSUPPORTED', null, { Feature: 'ChildRollupPath', Milestone: 2 });
			}
			let tmpStep = tmpSteps[0];
			let tmpSplit = splitWhere(andPred(tmpStep.Where, pChild.Where));
			let tmpRel = libRetoldFacetingFoldIR.newRel({ Entity: tmpStep.To, As: pEnv.Counter.next('x'), Role: 'Child', Where: tmpSplit.Col });
			let tmpInnerScope = { Alias: tmpRel.As, Entity: tmpStep.To, Prefix: 'x' };
			let tmpNested = tmpSplit.Path.map((pItem) => { return lowerPred(pItem, tmpInnerScope, pEnv); });
			return { Rel: tmpRel, On: stepOn(tmpStep, pStartAlias), Where: combineNodes('And', tmpNested) };
		});
};

/**
 * K20: the Exists predicate of an ExistsSplit dimension, lowered at the start alias with 'e' hops.
 *
 * @param {Record<string, any>} pDimension - bound { Path, Where, Correlate }
 * @param {Record<string, any>} pScope - { Alias, Entity, Names?, SideEntities? }
 * @param {Record<string, any>} pEnv
 * @return {Record<string, any>} an Exists FoldPred node
 */
const lowerExistsFlag = (pDimension, pScope, pEnv) =>
{
	return memo(pEnv, 'ExistsFlag', { Start: pScope.Alias, Path: pathKey(pDimension.Path), Where: pDimension.Where || null, Correlate: pDimension.Correlate || null },
		() =>
		{
			return lowerExistence('Exists', { From: null, Path: pDimension.Path, Where: pDimension.Where || null, Correlate: pDimension.Correlate || [] },
				{ Alias: pScope.Alias, Entity: pScope.Entity, Prefix: 'e', Names: pScope.Names, SideEntities: pScope.SideEntities }, pEnv);
		});
};

/**
 * Every column each alias of a forest is read by (alias → Set).
 *
 * @param {any} pForest
 * @return {Map<string, Set<string>>}
 */
const columnsByAlias = (pForest) =>
{
	let tmpResult = new Map();
	let tmpRels = libRetoldFacetingFoldIR.relationsOf(pForest);
	let tmpAliases = new Set([ 'p' ]);
	tmpRels.forEach((pRel) => { tmpAliases.add(pRel.As); });
	tmpAliases.forEach((pAlias) => { tmpResult.set(pAlias, new Set(libRetoldFacetingFoldIR.columnsOf(pForest, pAlias))); });
	return tmpResult;
};

/**
 * Fill Rel.Project for every Rel of a forest: the PK first, then every column the forest reads
 * from that alias (inner On columns, columns later links / nested nodes correlate on, Cmp fields,
 * the Field / KeyField read from the last Via / Multi link, tuple On / Key / dimension columns),
 * sorted; catalog columns only.  Idempotent (a Rel shared by several trees gets the union).
 *
 * Every alias but 'p' is plan-wide unique, so one pass over the whole forest is exact for them;
 * a Rel whose alias is 'p' (a TuplePivot Home side) must be projected from its own Agg and Variant
 * (pass pOptions.SkipAliases: [ 'p' ] for the forest pass, then call again per Agg).
 *
 * @param {any} pForest
 * @param {Record<string, any>} pEnv
 * @param {Record<string, Array<string>>} [pExtra] - alias → extra columns
 * @param {{ SkipAliases?: Array<string>, OnlyAliases?: Array<string> }} [pOptions]
 */
const assignProjects = (pForest, pEnv, pExtra, pOptions) =>
{
	let tmpOptions = isPlainObject(pOptions) ? pOptions : {};
	let tmpSkip = Array.isArray(tmpOptions.SkipAliases) ? tmpOptions.SkipAliases : [];
	let tmpOnly = Array.isArray(tmpOptions.OnlyAliases) ? tmpOptions.OnlyAliases : null;
	let tmpColumns = columnsByAlias(pForest);
	let tmpRels = libRetoldFacetingFoldIR.relationsOf(pForest);
	for (let i = 0; i < tmpRels.length; i++)
	{
		let tmpRel = tmpRels[i];
		if ((tmpSkip.indexOf(tmpRel.As) >= 0) || (tmpOnly && (tmpOnly.indexOf(tmpRel.As) < 0)))
		{
			continue;
		}
		let tmpPK = primaryKey(pEnv, tmpRel.Entity);
		let tmpSet = new Set(Array.isArray(tmpRel.Project) ? tmpRel.Project : []);
		(tmpColumns.has(tmpRel.As) ? Array.from(tmpColumns.get(tmpRel.As)) : []).forEach((pColumn) => { tmpSet.add(pColumn); });
		if (isPlainObject(pExtra) && hasOwn(pExtra, tmpRel.As) && Array.isArray(pExtra[tmpRel.As]))
		{
			pExtra[tmpRel.As].forEach((pColumn) => { tmpSet.add(pColumn); });
		}
		if (tmpPK)
		{
			tmpSet.delete(tmpPK);
		}
		let tmpOthers = Array.from(tmpSet).filter(
			(pColumn) =>
			{
				if (!pEnv.Catalog || (typeof(pEnv.Catalog.column) !== 'function'))
				{
					return true;
				}
				return !!pEnv.Catalog.column(tmpRel.Entity, pColumn);
			}).sort();
		tmpRel.Project = tmpPK ? [ tmpPK ].concat(tmpOthers) : tmpOthers;
	}
};

/**
 * { Alias, Entity, Role } of every Rel in a tree (informational listings).
 *
 * @param {any} pTree
 * @return {Array<{ Alias: string, Entity: string, Role: string }>}
 */
const relationListing = (pTree) =>
{
	return libRetoldFacetingFoldIR.relationsOf(pTree).map((pRel) => { return { Alias: pRel.As, Entity: pRel.Entity, Role: pRel.Role }; });
};

module.exports = (
	{
		EXISTENCE_KINDS: EXISTENCE_KINDS,
		ALIAS_PREFIXES: ALIAS_PREFIXES,
		AliasCounter: AliasCounter,
		newAliasCounter: newAliasCounter,
		hasExistence: hasExistence,
		andPred: andPred,
		splitWhere: splitWhere,
		columnPred: columnPred,
		combineNodes: combineNodes,
		primaryKey: primaryKey,
		isIntegerColumn: isIntegerColumn,
		lowerPred: lowerPred,
		lowerExistence: lowerExistence,
		lowerCountCmp: lowerCountCmp,
		lowerVia: lowerVia,
		lowerMulti: lowerMulti,
		lowerChild: lowerChild,
		lowerExistsFlag: lowerExistsFlag,
		pathKey: pathKey,
		columnsByAlias: columnsByAlias,
		assignProjects: assignProjects,
		relationListing: relationListing
	});
