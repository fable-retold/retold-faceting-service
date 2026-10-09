/**
 * Retold Faceting - Statement Composer (Live, M2 helper; not a registered service)
 *
 * Turns the FoldIR of one Agg (or a cube, or the Records base) into the structural SQL its shell
 * splices through _Params.SR0 / JOINS / AND_WHERE, composing Scoped Relations ONLY by alias
 * (internal-contracts §26.4):
 *
 *   F  flags     SELECT <cols>, CASE WHEN <frag> THEN 1 ELSE 0 END AS "q<n>" FROM (<SR p>) "p"
 *                (only when a column predicate on the pivot is needed outside its sole scope)
 *   W  where     SELECT <cols>, <computed> FROM (<F | SR p>) "p" WHERE <PathPred AND Agg.Where>
 *                computed: cube / W_def flags "b<n>" / "w<n>", ExistsFlag "FacetX<n>",
 *                correlated ChildAgg counts "FacetC<n>"; "p" is the SOLE FROM item, so pivot
 *                PredicateFragments are valid here (pivot-level predicates first)
 *   J  joins     SELECT "p".<cols>, "l<k>"."<Field>" AS "FacetV<n>" FROM (<W>) "p"
 *                LEFT JOIN (<SR l1>) "l1" ON … (K8 Via: an invisible target is NULL, never a dropped
 *                row) and the restricted ChildAgg form LEFT JOIN (… "p2" …) "c<n>"
 *
 * The shell then reads `FROM (<SR0>) "p"` exactly as in M1, with every dimension rewritten to the
 * column of the base that carries it; an M1-shaped Agg composes to its plain pivot SR (no layer),
 * so M1 statements are unchanged.  K9 (Multi) adds the chain as JOINS (inner joins of the chain's
 * own Scoped Relations) and its path predicates as AND_WHERE.  A TuplePivot composes
 *   SELECT DISTINCT <Key columns> AS "TK<i>", <dimension values> AS "FacetT<n>"
 *   FROM (<side p>) "p" JOIN (<side u1>) "u1" ON … WHERE <PathPred AND Agg.Where>
 * — one row per distinct Key tuple (every tuple dimension is a function of the tuple), so the M1
 * shells count tuples (KeyDistinct).
 *
 * Every Rel referenced anywhere is built once (memoized, sequentially: captures never race) through
 * the ScopedRelationBuilder with its projection widened to every column the tree reads on its alias;
 * leaf existence hops run Staged when the plan form or an Opaque trusted capture asks for it.
 *
 * Contract: internal-contracts §24, §26.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFacetErrors = require('../../contract/Facet-Contract-Errors.js');
const libFacetBuckets = require('../../contract/Facet-Contract-Buckets.js');
const libFacetClauses = require('../../contract/Facet-Contract-Clauses.js');
const libRetoldFacetingUtil = require('../../Retold-Faceting-Util.js');

const hasOwn = libRetoldFacetingUtil.hasOwn;

const EXISTENCE_NODES = Object.freeze([ 'Exists', 'NotExists', 'CountCmp' ]);

/**
 * Visit every node of a FoldPred tree (nested existence Wheres included).
 *
 * @param {Record<string, any>|null} pNode
 * @param {(pNode: Record<string, any>) => void} fVisit
 */
const walkPred = (pNode, fVisit) =>
{
	if (!pNode || (typeof(pNode) !== 'object'))
	{
		return;
	}
	fVisit(pNode);
	if (((pNode.Node === 'And') || (pNode.Node === 'Or')) && Array.isArray(pNode.Items))
	{
		for (let i = 0; i < pNode.Items.length; i++)
		{
			walkPred(pNode.Items[i], fVisit);
		}
	}
	else if (EXISTENCE_NODES.indexOf(pNode.Node) >= 0)
	{
		walkPred(pNode.Where, fVisit);
	}
};

/**
 * And of the non-null predicates (null when none).
 *
 * @param {Array<Record<string, any>|null>} pPreds
 * @return {Record<string, any>|null}
 */
const andOf = (pPreds) =>
{
	let tmpItems = pPreds.filter((pPred) => { return (pPred !== null) && (typeof(pPred) === 'object'); });
	if (tmpItems.length < 1)
	{
		return null;
	}
	return (tmpItems.length === 1) ? tmpItems[0] : { Node: 'And', Items: tmpItems };
};

class RetoldFacetingStatementComposer
{
	/**
	 * @param {import('fable')} pFable
	 */
	constructor(pFable)
	{
		this.fable = pFable;
	}

	// ------------------------------------------------------------------ dialect helpers

	quote(pDialectName, pIdentifier)
	{
		return this.fable.RetoldFacetingDialects.quote(pDialectName, pIdentifier);
	}

	qualify(pDialectName, pAlias, pColumn)
	{
		return this.fable.RetoldFacetingDialects.qualify(pDialectName, pAlias, pColumn);
	}

	/**
	 * '"p"."c" AS "c", …'
	 *
	 * @param {string} pDialectName
	 * @param {string} pAlias
	 * @param {Array<string>} pColumns
	 * @return {string}
	 */
	passThrough(pDialectName, pAlias, pColumns)
	{
		return pColumns.map((pColumn) => { return `${this.qualify(pDialectName, pAlias, pColumn)} AS ${this.quote(pDialectName, pColumn)}`; }).join(', ');
	}

	// ------------------------------------------------------------------ collection

	/**
	 * A fresh needs collector: every Rel the trees reference (with how it is used) and every column
	 * read on every alias.
	 *
	 * @return {{ Uses: Array<Record<string, any>>, Columns: Map<string, Set<string>> }}
	 */
	newNeeds()
	{
		// Leaves: alias → column leaves rendered as PredicateFragments outside the alias's Scoped
		// Relation (probed for behavior operator transforms before composition, §26.4).
		return { Uses: [], Columns: new Map(), Leaves: new Map() };
	}

	/**
	 * Note one column leaf ({ Field, Op, Value }) that a PredicateFragment will render on pAlias.
	 *
	 * @param {Record<string, any>} pNeeds
	 * @param {string} pAlias
	 * @param {Record<string, any>} pLeaf
	 */
	noteLeaf(pNeeds, pAlias, pLeaf)
	{
		if (!pNeeds.Leaves)
		{
			pNeeds.Leaves = new Map();
		}
		if (!pNeeds.Leaves.has(pAlias))
		{
			pNeeds.Leaves.set(pAlias, []);
		}
		pNeeds.Leaves.get(pAlias).push(pLeaf);
	}

	/**
	 * Note every leaf of a Part I column Pred ({ Field, Op, Value } / And / Or) on pAlias.
	 *
	 * @param {Record<string, any>} pNeeds
	 * @param {string} pAlias
	 * @param {Record<string, any>|null} pColumnPred
	 */
	noteColumnPred(pNeeds, pAlias, pColumnPred)
	{
		if (!pColumnPred || (typeof(pColumnPred) !== 'object'))
		{
			return;
		}
		if (Array.isArray(pColumnPred.And) || Array.isArray(pColumnPred.Or))
		{
			(pColumnPred.And || pColumnPred.Or).forEach((pChild) => { this.noteColumnPred(pNeeds, pAlias, pChild); });
			return;
		}
		if (typeof(pColumnPred.Field) === 'string')
		{
			this.noteLeaf(pNeeds, pAlias, pColumnPred);
		}
	}

	/**
	 * @param {Record<string, any>} pNeeds
	 * @param {string} pAlias
	 * @param {string} pColumn
	 */
	need(pNeeds, pAlias, pColumn)
	{
		if ((typeof(pAlias) !== 'string') || (typeof(pColumn) !== 'string'))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'Malformed FoldIR column reference.');
		}
		if (!pNeeds.Columns.has(pAlias))
		{
			pNeeds.Columns.set(pAlias, new Set());
		}
		pNeeds.Columns.get(pAlias).add(pColumn);
	}

	/**
	 * Record a Rel used through On pairs (inner columns on the Rel, outer columns on their aliases).
	 *
	 * @param {Record<string, any>} pNeeds
	 * @param {Record<string, any>} pRel
	 * @param {Array<Record<string, any>>} pOn
	 * @param {string} pKind - 'Exists' | 'NotExists' | 'CountCmp' | 'Via' | 'Multi' | 'ChildAgg'
	 * @param {Record<string, any>|null} pNode - the existence node (staging eligibility)
	 */
	useRel(pNeeds, pRel, pOn, pKind, pNode)
	{
		if (!pRel || (typeof(pRel.As) !== 'string') || (typeof(pRel.Entity) !== 'string'))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'Malformed FoldIR relation.');
		}
		let tmpOn = Array.isArray(pOn) ? pOn : [];
		for (let i = 0; i < tmpOn.length; i++)
		{
			if (!tmpOn[i] || !tmpOn[i].Outer || (typeof(tmpOn[i].Inner) !== 'string'))
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'Malformed On pair.');
			}
			this.need(pNeeds, pRel.As, tmpOn[i].Inner);
			this.need(pNeeds, tmpOn[i].Outer.Alias, tmpOn[i].Outer.Field);
		}
		let tmpLeaf = ((pKind === 'Exists') || (pKind === 'NotExists')) && pNode && !pNode.Where;
		pNeeds.Uses.push({ Rel: pRel, Kind: pKind, Node: pNode, KeyColumns: tmpLeaf ? tmpOn.map((pPair) => { return pPair.Inner; }) : null, Leaf: !!tmpLeaf });
		let tmpProject = Array.isArray(pRel.Project) ? pRel.Project : [];
		for (let i = 0; i < tmpProject.length; i++)
		{
			this.need(pNeeds, pRel.As, tmpProject[i]);
		}
	}

	/**
	 * Collect a FoldPred tree.
	 *
	 * @param {Record<string, any>} pNeeds
	 * @param {Record<string, any>|null} pPred
	 */
	collectPred(pNeeds, pPred)
	{
		walkPred(pPred,
			(pNode) =>
			{
				if (pNode.Node === 'Cmp')
				{
					this.need(pNeeds, pNode.Alias, pNode.Field);
					let tmpLeaf = { Field: pNode.Field, Op: pNode.Op };
					if ((pNode.Op !== 'NULL') && (pNode.Op !== 'NOTNULL'))
					{
						tmpLeaf.Value = pNode.Value;
					}
					this.noteLeaf(pNeeds, pNode.Alias, tmpLeaf);
				}
				else if (EXISTENCE_NODES.indexOf(pNode.Node) >= 0)
				{
					this.useRel(pNeeds, pNode.Rel, pNode.On, pNode.Node, pNode);
				}
			});
	}

	/**
	 * Collect one dimension (Via chains, Multi chains, ChildAgg, ExistsFlag, plain columns).
	 *
	 * @param {Record<string, any>} pNeeds
	 * @param {Record<string, any>} pDimension
	 * @param {string} pDefaultAlias - 'p'
	 */
	collectDimension(pNeeds, pDimension, pDefaultAlias)
	{
		if (!pDimension || (typeof(pDimension) !== 'object'))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'Malformed dimension.');
		}
		switch (pDimension.Kind)
		{
			case 'Multi':
				{
					let tmpChain = Array.isArray(pDimension.Chain) ? pDimension.Chain : [];
					if (tmpChain.length < 1)
					{
						throw libFacetErrors.create('FACET_INTERNAL', 'A Multi dimension needs its chain.');
					}
					for (let i = 0; i < tmpChain.length; i++)
					{
						this.useRel(pNeeds, tmpChain[i].Rel, tmpChain[i].On, 'Multi', null);
					}
					this.need(pNeeds, tmpChain[tmpChain.length - 1].Rel.As, pDimension.KeyField);
					this.collectPred(pNeeds, pDimension.Where || null);
				}
				return;
			case 'ChildAgg':
				this.useRel(pNeeds, pDimension.Rel, pDimension.On, 'ChildAgg', null);
				this.collectPred(pNeeds, pDimension.Where || null);
				return;
			case 'ExistsFlag':
				this.collectPred(pNeeds, pDimension.Pred);
				return;
			default:
				break;
		}
		if (Array.isArray(pDimension.Via) && (pDimension.Via.length > 0))
		{
			for (let i = 0; i < pDimension.Via.length; i++)
			{
				this.useRel(pNeeds, pDimension.Via[i].Rel, pDimension.Via[i].On, 'Via', null);
			}
			this.need(pNeeds, pDimension.Via[pDimension.Via.length - 1].Rel.As, pDimension.Field);
			return;
		}
		if (typeof(pDimension.Field) === 'string')
		{
			this.need(pNeeds, (typeof(pDimension.Alias) === 'string') ? pDimension.Alias : pDefaultAlias, pDimension.Field);
		}
	}

	/**
	 * Every column pNeeds reads on pAlias, sorted.
	 *
	 * @param {Record<string, any>} pNeeds
	 * @param {string} pAlias
	 * @return {Array<string>}
	 */
	columnsOf(pNeeds, pAlias)
	{
		return pNeeds.Columns.has(pAlias) ? Array.from(pNeeds.Columns.get(pAlias)).sort() : [];
	}

	/**
	 * A projection: the primary key first, then the sorted unique columns.
	 *
	 * @param {string|null} pPrimaryKey
	 * @param {Array<string>} pColumns
	 * @return {Array<string>}
	 */
	projection(pPrimaryKey, pColumns)
	{
		let tmpOthers = Array.from(new Set(pColumns)).filter((pColumn) => { return pColumn !== pPrimaryKey; }).sort();
		return (typeof(pPrimaryKey) === 'string') ? [ pPrimaryKey ].concat(tmpOthers) : tmpOthers;
	}

	// ------------------------------------------------------------------ building

	/**
	 * Build every used Rel (sequentially, memoized), widening each projection to the columns the
	 * trees read on its alias; leaf existence hops run Staged when asked (§26.3).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pNeeds
	 * @param {Record<string, Record<string, any>>} pRelations - alias → relation (filled in)
	 * @param {(pError?: Error) => void} fCallback
	 */
	buildUses(pContext, pNeeds, pRelations, fCallback)
	{
		let tmpBuilder = this.fable.RetoldFacetingScopedRelationBuilder;
		let tmpStaged = this.fable.RetoldFacetingStagedKeys;
		let tmpForm = tmpBuilder.stagedForm(pContext);
		let tmpUses = pNeeds.Uses.filter((pUse, pIndex) => { return pNeeds.Uses.findIndex((pOther) => { return pOther.Rel.As === pUse.Rel.As; }) === pIndex; });
		let fNext = (pIndex) =>
		{
			if (pIndex >= tmpUses.length)
			{
				// Every relation is built: probe the column leaves that render as fragments outside their
				// relation for behavior operator transforms (they would bypass them otherwise).
				return this.probeFragments(pContext, pNeeds, pRelations, fCallback);
			}
			let tmpUse = tmpUses[pIndex];
			if (hasOwn(pRelations, tmpUse.Rel.As))
			{
				return fNext(pIndex + 1);
			}
			let tmpPrimaryKey = pContext.Host.getPrimaryKey(tmpUse.Rel.Entity);
			let tmpRel = Object.assign({}, tmpUse.Rel, { Project: this.projection(tmpPrimaryKey, this.columnsOf(pNeeds, tmpUse.Rel.As)) });
			let tmpStageable = tmpUse.Leaf && (tmpUse.Rel.Stage === 'Allowed');
			let fStaged = () =>
			{
				tmpStaged.stage(pContext, tmpRel, tmpUse.KeyColumns,
					(pStageError, pStagedRelation) =>
					{
						if (pStageError)
						{
							return fCallback(pStageError);
						}
						pRelations[tmpUse.Rel.As] = pStagedRelation;
						return fNext(pIndex + 1);
					});
			};
			if (tmpStageable && (tmpForm === 'Always'))
			{
				return fStaged();
			}
			tmpBuilder.buildRelation(pContext, tmpRel,
				(pError, pRelation) =>
				{
					if (pError)
					{
						return fCallback(pError);
					}
					if (pRelation.NeedsStage)
					{
						if (!tmpStageable)
						{
							return fCallback(libFacetErrors.create('FACET_FOLD_UNSUPPORTED', 'This relation cannot run Staged.', { Feature: 'StagedNonLeaf', Milestone: 2 }));
						}
						return fStaged();
					}
					pRelations[tmpUse.Rel.As] = pRelation;
					return fNext(pIndex + 1);
				});
		};
		return fNext(0);
	}

	/**
	 * Probe every noted fragment leaf for host-behavior operator transforms (PredicateCompiler
	 * .probeTransforms, per entity, memoized per request); PredicateFragments then render the
	 * post-behavior operators, exactly as the leaf would be rendered inside its entity's own list.
	 * The alias 'p' without a built relation (a TuplePivot's Variant hops are built before its sides)
	 * is the route entity (the pivot / Home side of every M2 plan).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pNeeds
	 * @param {Record<string, Record<string, any>>} pRelations
	 * @param {(pError?: Error, pProbe?: { Transformed: number }) => void} fCallback - Transformed: how many of these leaves a behavior rewrote
	 */
	probeFragments(pContext, pNeeds, pRelations, fCallback)
	{
		let tmpByEntity = new Map();
		let tmpLeaves = (pNeeds && (pNeeds.Leaves instanceof Map)) ? pNeeds.Leaves : new Map();
		tmpLeaves.forEach(
			(pAliasLeaves, pAlias) =>
			{
				let tmpRelation = (pRelations && hasOwn(pRelations, pAlias)) ? pRelations[pAlias] : null;
				let tmpEntity = (tmpRelation && (typeof(tmpRelation.Entity) === 'string')) ? tmpRelation.Entity
					: ((pAlias === 'p') && pContext && (typeof(pContext.Entity) === 'string')) ? pContext.Entity : null;
				if (!tmpEntity)
				{
					return;
				}
				if (!tmpByEntity.has(tmpEntity))
				{
					tmpByEntity.set(tmpEntity, []);
				}
				tmpByEntity.set(tmpEntity, tmpByEntity.get(tmpEntity).concat(pAliasLeaves));
			});
		let tmpEntities = Array.from(tmpByEntity.keys());
		let tmpTransformed = 0;
		let fNext = (pIndex) =>
		{
			if (pIndex >= tmpEntities.length)
			{
				return fCallback(null, { Transformed: tmpTransformed });
			}
			this.fable.RetoldFacetingPredicateCompiler.probeTransforms(pContext, tmpEntities[pIndex], tmpByEntity.get(tmpEntities[pIndex]),
				(pError, pCount) =>
				{
					if (pError)
					{
						return fCallback(pError);
					}
					tmpTransformed += (pCount || 0);
					return fNext(pIndex + 1);
				});
		};
		return fNext(0);
	}

	// ------------------------------------------------------------------ compilation

	/**
	 * A compile session: one fragment counter per statement, flag registries per wrapper alias.
	 *
	 * @param {string} pDialectName
	 * @param {Record<string, Record<string, any>>} pRelations
	 * @return {Record<string, any>}
	 */
	newSession(pDialectName, pRelations)
	{
		return { Dialect: pDialectName, Relations: pRelations, State: { Fragments: 0 }, Flags: new Map(), Params: {}, ParamTypes: {} };
	}

	/**
	 * Compile a FoldPred in a scope; column subtrees outside their sole scope become flags of a
	 * wrapper alias (pFlagAliases), projected later by wrapperSQL().
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pSession
	 * @param {Record<string, any>|null} pPred
	 * @param {Array<string>} pScope
	 * @param {Array<string>} pFlagAliases - aliases whose wrapper can project flag columns
	 * @return {string} '' for a null tree
	 */
	compilePred(pContext, pSession, pPred, pScope, pFlagAliases)
	{
		if (!pPred)
		{
			return '';
		}
		let tmpCompiled = this.fable.RetoldFacetingPredicateCompiler.compile(pContext, pPred, pSession.Relations, pSession.Dialect,
			{
				Scope: pScope,
				State: pSession.State,
				Flag: (pAlias, pColumnPred) =>
				{
					if (pFlagAliases.indexOf(pAlias) < 0)
					{
						return null;
					}
					pSession.State.Fragments++;
					let tmpName = `q${pSession.State.Fragments}`;
					if (!pSession.Flags.has(pAlias))
					{
						pSession.Flags.set(pAlias, []);
					}
					pSession.Flags.get(pAlias).push({ Column: tmpName, Pred: pColumnPred });
					return tmpName;
				}
			});
		Object.assign(pSession.Params, tmpCompiled.Params);
		Object.assign(pSession.ParamTypes, tmpCompiled.ParamTypes);
		return tmpCompiled.SQL;
	}

	/**
	 * A FROM item for an alias, wrapped to project the flag columns registered for it:
	 * (SELECT <cols>, CASE WHEN <frag> THEN 1 ELSE 0 END AS "q<n>" FROM (<SR>) "<a>") — or the bare SR.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pSession
	 * @param {string} pAlias
	 * @param {Array<string>} pColumns - the relation's columns to pass through
	 * @return {string} the inner SQL (without the alias)
	 */
	wrapperSQL(pContext, pSession, pAlias, pColumns)
	{
		let tmpRelation = pSession.Relations[pAlias];
		this.mergeRelation(pSession, tmpRelation);
		let tmpFlags = pSession.Flags.has(pAlias) ? pSession.Flags.get(pAlias) : [];
		if (tmpFlags.length < 1)
		{
			return tmpRelation.SQL;
		}
		let tmpParts = [ this.passThrough(pSession.Dialect, pAlias, pColumns) ];
		for (let i = 0; i < tmpFlags.length; i++)
		{
			let tmpFragment = this.fable.RetoldFacetingPredicateCompiler.fragment(pContext, tmpRelation.Entity, tmpFlags[i].Pred, tmpFlags[i].Column, pSession.Dialect);
			Object.assign(pSession.Params, tmpFragment.Params);
			Object.assign(pSession.ParamTypes, tmpFragment.ParamTypes);
			tmpParts.push(`CASE WHEN (${tmpFragment.SQL}) THEN 1 ELSE 0 END AS ${this.quote(pSession.Dialect, tmpFlags[i].Column)}`);
		}
		return `SELECT ${tmpParts.join(', ')} FROM (${tmpRelation.SQL}) ${this.quote(pSession.Dialect, pAlias)}`;
	}

	/**
	 * Merge a relation's binds into the session.
	 *
	 * @param {Record<string, any>} pSession
	 * @param {Record<string, any>} pRelation
	 */
	mergeRelation(pSession, pRelation)
	{
		if (!pRelation || (typeof(pRelation.SQL) !== 'string'))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'A composed relation has no SQL (Staged relations are memberships only).');
		}
		Object.assign(pSession.Params, pRelation.Params || {});
		Object.assign(pSession.ParamTypes, pRelation.ParamTypes || {});
	}

	/**
	 * The correlated ChildAgg count: (SELECT count(*) FROM (<SR x>) "x" WHERE <On> [AND <nested>]).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pSession
	 * @param {Record<string, any>} pDimension - ChildAgg
	 * @return {string}
	 */
	childCountSQL(pContext, pSession, pDimension)
	{
		let tmpAlias = pDimension.Rel.As;
		let tmpRelation = pSession.Relations[tmpAlias];
		this.mergeRelation(pSession, tmpRelation);
		let tmpCompiler = this.fable.RetoldFacetingPredicateCompiler;
		let tmpConditions = tmpCompiler.onPairs(pDimension.On, tmpAlias, pSession.Dialect);
		let tmpNested = this.compilePred(pContext, pSession, pDimension.Where || null, [ tmpAlias ], [ 'p' ]);
		if (tmpNested.length > 0)
		{
			tmpConditions.push(tmpNested);
		}
		return `(SELECT count(*) FROM (${tmpRelation.SQL}) ${this.quote(pSession.Dialect, tmpAlias)} WHERE ${tmpConditions.join(' AND ')})`;
	}

	/**
	 * Compose the entity-pivot base (layers F / W / J) for a set of dimensions, pivot-level
	 * predicates and computed flags.
	 *
	 * pSpec:
	 *   Columns    pivot columns the base passes through (the pivot relation's projection)
	 *   Preds      FoldPreds ANDed at the W level (Variant.PathPred, Agg.Where, Common path preds)
	 *   Flags      [ { Column: 'b1', ColumnPred: <Part I Pred> } | { Column: 'b2', Pred: <FoldPred> } ] → 0/1 columns at W
	 *   Dimensions [ Dim ] → rewritten copies (Field = the base column carrying the key)
	 *   ChildAggForm 'Correlated' (default) | 'Restricted'
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pSession
	 * @param {Record<string, any>} pSpec
	 * @return {{ SQL: string, Dimensions: Array<Record<string, any>>, Columns: Array<string>, Layered: boolean }}
	 */
	entityBase(pContext, pSession, pSpec)
	{
		let tmpDialect = pSession.Dialect;
		let tmpPivot = pSession.Relations.p;
		let tmpColumns = pSpec.Columns.slice();
		let tmpTaken = new Set(tmpColumns);
		let fName = (pPrefix, pIndex) =>
		{
			let tmpName = `${pPrefix}${pIndex}`;
			if (tmpTaken.has(tmpName))
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'A synthetic column collides with a pivot column.');
			}
			tmpTaken.add(tmpName);
			return tmpName;
		};

		// W-level predicate first (it may register pivot flags).
		let tmpWhere = this.compilePred(pContext, pSession, andOf(Array.isArray(pSpec.Preds) ? pSpec.Preds : []), [ 'p' ], [ 'p' ]);

		// W-level computed columns.
		let tmpComputed = [];
		let tmpComputedNames = [];
		let tmpFlags = Array.isArray(pSpec.Flags) ? pSpec.Flags : [];
		for (let i = 0; i < tmpFlags.length; i++)
		{
			let tmpName = tmpFlags[i].Column;
			if (tmpTaken.has(tmpName))
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'A flag column collides with a pivot column.');
			}
			tmpTaken.add(tmpName);
			let tmpCondition;
			if (tmpFlags[i].ColumnPred)
			{
				pSession.State.Fragments++;
				let tmpFragment = this.fable.RetoldFacetingPredicateCompiler.fragment(pContext, tmpPivot.Entity, tmpFlags[i].ColumnPred, `q${pSession.State.Fragments}`, tmpDialect);
				Object.assign(pSession.Params, tmpFragment.Params);
				Object.assign(pSession.ParamTypes, tmpFragment.ParamTypes);
				tmpCondition = `(${tmpFragment.SQL})`;
			}
			else
			{
				tmpCondition = this.compilePred(pContext, pSession, tmpFlags[i].Pred, [ 'p' ], [ 'p' ]);
			}
			tmpComputed.push(`CASE WHEN ${tmpCondition} THEN 1 ELSE 0 END AS ${this.quote(tmpDialect, tmpName)}`);
			tmpComputedNames.push(tmpName);
		}

		let tmpDimensions = Array.isArray(pSpec.Dimensions) ? pSpec.Dimensions : [];
		let tmpRewritten = [];
		let tmpJoins = [];
		let tmpJoinColumns = [];
		let tmpRestricted = [];
		for (let i = 0; i < tmpDimensions.length; i++)
		{
			let tmpDimension = tmpDimensions[i];
			if (tmpDimension.Kind === 'ExistsFlag')
			{
				let tmpName = fName('FacetX', i);
				let tmpCondition = this.compilePred(pContext, pSession, tmpDimension.Pred, [ 'p' ], [ 'p' ]);
				tmpComputed.push(`CASE WHEN ${tmpCondition} THEN 1 ELSE 0 END AS ${this.quote(tmpDialect, tmpName)}`);
				tmpComputedNames.push(tmpName);
				tmpRewritten.push(Object.assign({}, tmpDimension, { Field: tmpName, DataType: 'Boolean', IsInteger: true }));
			}
			else if (tmpDimension.Kind === 'ChildAgg')
			{
				let tmpName = fName('FacetC', i);
				let tmpOn = Array.isArray(tmpDimension.On) ? tmpDimension.On : [];
				if ((pSpec.ChildAggForm === 'Restricted') && (tmpOn.length === 1) && (tmpOn[0].Outer.Alias === 'p'))
				{
					tmpRestricted.push({ Dimension: tmpDimension, Column: tmpName, Index: i });
				}
				else
				{
					tmpComputed.push(`${this.childCountSQL(pContext, pSession, tmpDimension)} AS ${this.quote(tmpDialect, tmpName)}`);
					tmpComputedNames.push(tmpName);
				}
				tmpRewritten.push(Object.assign({}, tmpDimension, { Field: tmpName, DataType: 'Numeric', IsInteger: true }));
			}
			else if (Array.isArray(tmpDimension.Via) && (tmpDimension.Via.length > 0))
			{
				let tmpName = fName('FacetV', i);
				for (let j = 0; j < tmpDimension.Via.length; j++)
				{
					let tmpLink = tmpDimension.Via[j];
					let tmpOn = this.fable.RetoldFacetingPredicateCompiler.onPairs(tmpLink.On, tmpLink.Rel.As, tmpDialect);
					let tmpRelation = pSession.Relations[tmpLink.Rel.As];
					this.mergeRelation(pSession, tmpRelation);
					tmpJoins.push(`LEFT JOIN (${tmpRelation.SQL}) ${this.quote(tmpDialect, tmpLink.Rel.As)} ON ${tmpOn.join(' AND ')}`);
				}
				let tmpLast = tmpDimension.Via[tmpDimension.Via.length - 1].Rel.As;
				tmpJoinColumns.push(`${this.qualify(tmpDialect, tmpLast, tmpDimension.Field)} AS ${this.quote(tmpDialect, tmpName)}`);
				let tmpCopy = Object.assign({}, tmpDimension, { Field: tmpName });
				delete tmpCopy.Via;
				tmpRewritten.push(tmpCopy);
			}
			else
			{
				tmpRewritten.push(tmpDimension);
			}
		}

		// Layer F: flags registered for the pivot while compiling (column predicates out of scope).
		let tmpInner = this.wrapperSQL(pContext, pSession, 'p', tmpColumns);
		let tmpPivotFlags = pSession.Flags.has('p') ? pSession.Flags.get('p').map((pFlag) => { return pFlag.Column; }) : [];
		let tmpLayered = (tmpPivotFlags.length > 0);

		// Layer W.
		let tmpWColumns = tmpColumns.concat(tmpPivotFlags);
		let tmpSQL = tmpInner;
		if ((tmpWhere.length > 0) || (tmpComputed.length > 0) || tmpLayered)
		{
			let tmpSelect = [ this.passThrough(tmpDialect, 'p', tmpWColumns) ].concat(tmpComputed).join(', ');
			tmpSQL = `SELECT ${tmpSelect} FROM (${tmpInner}) ${this.quote(tmpDialect, 'p')}${(tmpWhere.length > 0) ? ` WHERE ${tmpWhere}` : ''}`;
			tmpLayered = true;
		}
		let tmpBaseColumns = tmpWColumns.concat(tmpComputedNames);

		// Layer J: Via lookups and restricted child aggregates.
		if ((tmpJoins.length > 0) || (tmpRestricted.length > 0))
		{
			let tmpRestrictedColumns = [];
			for (let i = 0; i < tmpRestricted.length; i++)
			{
				let tmpEntry = tmpRestricted[i];
				let tmpDimension = tmpEntry.Dimension;
				let tmpChildAlias = tmpDimension.Rel.As;
				let tmpChild = pSession.Relations[tmpChildAlias];
				this.mergeRelation(pSession, tmpChild);
				let tmpInnerColumn = this.qualify(tmpDialect, tmpChildAlias, tmpDimension.On[0].Inner);
				let tmpOuterField = tmpDimension.On[0].Outer.Field;
				// The pivot restricted to its own keys: a second rendering of the W base, binds renamed.
				let tmpCopyPrefix = `p2c${tmpEntry.Index}_`;
				let tmpCopy = this.renamedCopy(tmpSQL, pSession, tmpCopyPrefix);
				let tmpConditions = [ `${tmpInnerColumn} IN (SELECT ${this.qualify(tmpDialect, 'p2', tmpOuterField)} FROM (${tmpCopy}) ${this.quote(tmpDialect, 'p2')})` ];
				let tmpNested = this.compilePred(pContext, pSession, tmpDimension.Where || null, [ tmpChildAlias ], []);
				if (tmpNested.length > 0)
				{
					tmpConditions.push(tmpNested);
				}
				let tmpAggregateAlias = `c${tmpEntry.Index}`;
				tmpJoins.push(`LEFT JOIN (SELECT ${tmpInnerColumn} AS ${this.quote(tmpDialect, 'K')}, count(*) AS ${this.quote(tmpDialect, 'N')}`
					+ ` FROM (${tmpChild.SQL}) ${this.quote(tmpDialect, tmpChildAlias)} WHERE ${tmpConditions.join(' AND ')} GROUP BY ${tmpInnerColumn}) ${this.quote(tmpDialect, tmpAggregateAlias)}`
					+ ` ON ${this.qualify(tmpDialect, tmpAggregateAlias, 'K')} = ${this.qualify(tmpDialect, 'p', tmpOuterField)}`);
				tmpRestrictedColumns.push(`${this.qualify(tmpDialect, tmpAggregateAlias, 'N')} AS ${this.quote(tmpDialect, tmpEntry.Column)}`);
			}
			let tmpSelect = [ this.passThrough(tmpDialect, 'p', tmpBaseColumns) ].concat(tmpJoinColumns, tmpRestrictedColumns).join(', ');
			tmpSQL = `SELECT ${tmpSelect} FROM (${tmpSQL}) ${this.quote(tmpDialect, 'p')} ${tmpJoins.join(' ')}`;
			tmpLayered = true;
		}

		return { SQL: tmpSQL, Dimensions: tmpRewritten, Columns: tmpBaseColumns, Layered: tmpLayered };
	}

	/**
	 * A second rendering of composed SQL whose every session bind is renamed '<prefix><name>' (the
	 * renamed values are added to the session).  Aliases need no renaming: derived-table aliases are
	 * local to their own subquery scope.
	 *
	 * @param {string} pSQL
	 * @param {Record<string, any>} pSession
	 * @param {string} pPrefix
	 * @return {string}
	 */
	renamedCopy(pSQL, pSession, pPrefix)
	{
		let tmpDialects = this.fable.RetoldFacetingDialects;
		let tmpSigil = tmpDialects.forName(pSession.Dialect).Sigil;
		let tmpParams = Object.assign({}, pSession.Params);
		let tmpRenamed = tmpDialects.renameParameters(pSQL, tmpParams, pPrefix, tmpSigil);
		let tmpNames = Object.keys(tmpParams);
		for (let i = 0; i < tmpNames.length; i++)
		{
			pSession.Params[`${pPrefix}${tmpNames[i]}`] = tmpParams[tmpNames[i]];
			if (hasOwn(pSession.ParamTypes, tmpNames[i]))
			{
				pSession.ParamTypes[`${pPrefix}${tmpNames[i]}`] = pSession.ParamTypes[tmpNames[i]];
			}
		}
		return tmpRenamed;
	}

	/**
	 * The K9 chain: JOINS (inner joins of each link's Scoped Relation, flagged wrappers where a
	 * column predicate must be evaluated out of its sole scope) and AND_WHERE (Multi.Where).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pSession
	 * @param {Record<string, any>} pDimension - Multi
	 * @param {Record<string, any>} pNeeds
	 * @return {{ JOINS: string, AND_WHERE: string, KeyAlias: string }}
	 */
	multiPieces(pContext, pSession, pDimension, pNeeds)
	{
		let tmpDialect = pSession.Dialect;
		let tmpChain = pDimension.Chain;
		let tmpScope = [ 'p' ].concat(tmpChain.map((pLink) => { return pLink.Rel.As; }));
		let tmpChainAliases = tmpChain.map((pLink) => { return pLink.Rel.As; });
		let tmpWhere = this.compilePred(pContext, pSession, pDimension.Where || null, tmpScope, tmpChainAliases);
		let tmpJoins = [];
		for (let i = 0; i < tmpChain.length; i++)
		{
			let tmpAlias = tmpChain[i].Rel.As;
			let tmpRelation = pSession.Relations[tmpAlias];
			let tmpInner = this.wrapperSQL(pContext, pSession, tmpAlias, tmpRelation.Columns);
			let tmpOn = this.fable.RetoldFacetingPredicateCompiler.onPairs(tmpChain[i].On, tmpAlias, tmpDialect);
			tmpJoins.push(` JOIN (${tmpInner}) ${this.quote(tmpDialect, tmpAlias)} ON ${tmpOn.join(' AND ')}`);
		}
		return { JOINS: tmpJoins.join(''), AND_WHERE: (tmpWhere.length > 0) ? ` AND ${tmpWhere}` : '', KeyAlias: tmpChainAliases[tmpChainAliases.length - 1] };
	}

	/**
	 * The TuplePivot base (K18): one row per distinct Key tuple with its dimension values.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pSession
	 * @param {Record<string, any>} pTuple - Agg.Tuple
	 * @param {Array<Record<string, any>|null>} pPreds - Variant.PathPred, Agg.Where
	 * @param {Array<Record<string, any>>} pDimensions
	 * @return {{ SQL: string, Dimensions: Array<Record<string, any>>, Columns: Array<string> }}
	 */
	tupleBase(pContext, pSession, pTuple, pPreds, pDimensions)
	{
		let tmpDialect = pSession.Dialect;
		let tmpSides = pTuple.Sides;
		let tmpAliases = tmpSides.map((pSide) => { return pSide.Alias; });
		let tmpWhere = this.compilePred(pContext, pSession, andOf(pPreds), tmpAliases, tmpAliases);

		let tmpSelect = [];
		let tmpColumns = [];
		for (let i = 0; i < pTuple.Key.length; i++)
		{
			tmpSelect.push(`${this.qualify(tmpDialect, pTuple.Key[i].Alias, pTuple.Key[i].Field)} AS ${this.quote(tmpDialect, `TK${i}`)}`);
			tmpColumns.push(`TK${i}`);
		}
		let tmpRewritten = [];
		for (let i = 0; i < pDimensions.length; i++)
		{
			let tmpDimension = pDimensions[i];
			let tmpAlias = (typeof(tmpDimension.Alias) === 'string') ? tmpDimension.Alias : 'p';
			let tmpName = `FacetT${i}`;
			tmpSelect.push(`${this.qualify(tmpDialect, tmpAlias, tmpDimension.Field)} AS ${this.quote(tmpDialect, tmpName)}`);
			tmpColumns.push(tmpName);
			let tmpCopy = Object.assign({}, tmpDimension, { Field: tmpName });
			delete tmpCopy.Alias;
			tmpRewritten.push(tmpCopy);
		}

		let tmpFrom = [];
		let tmpPlaced = [];
		let tmpOnPairs = Array.isArray(pTuple.On) ? pTuple.On : [];
		for (let i = 0; i < tmpSides.length; i++)
		{
			let tmpAlias = tmpSides[i].Alias;
			let tmpRelation = pSession.Relations[tmpAlias];
			let tmpInner = this.wrapperSQL(pContext, pSession, tmpAlias, tmpRelation.Columns);
			if (i === 0)
			{
				tmpFrom.push(`(${tmpInner}) ${this.quote(tmpDialect, tmpAlias)}`);
			}
			else
			{
				let tmpConditions = [];
				for (let j = 0; j < tmpOnPairs.length; j++)
				{
					let tmpPair = tmpOnPairs[j];
					let tmpInvolves = (tmpPair.Left.Alias === tmpAlias) || (tmpPair.Right.Alias === tmpAlias);
					let tmpOther = (tmpPair.Left.Alias === tmpAlias) ? tmpPair.Right.Alias : tmpPair.Left.Alias;
					if (tmpInvolves && ((tmpPlaced.indexOf(tmpOther) >= 0) || (tmpOther === tmpAlias)))
					{
						tmpConditions.push(`${this.qualify(tmpDialect, tmpPair.Left.Alias, tmpPair.Left.Field)} = ${this.qualify(tmpDialect, tmpPair.Right.Alias, tmpPair.Right.Field)}`);
					}
				}
				if (tmpConditions.length < 1)
				{
					throw libFacetErrors.create('FACET_INTERNAL', 'A tuple side is not joined to the sides before it.');
				}
				tmpFrom.push(`JOIN (${tmpInner}) ${this.quote(tmpDialect, tmpAlias)} ON ${tmpConditions.join(' AND ')}`);
			}
			tmpPlaced.push(tmpAlias);
		}
		let tmpSQL = `SELECT DISTINCT ${tmpSelect.join(', ')} FROM ${tmpFrom.join(' ')}${(tmpWhere.length > 0) ? ` WHERE ${tmpWhere}` : ''}`;
		return { SQL: tmpSQL, Dimensions: tmpRewritten, Columns: tmpColumns };
	}
}

module.exports = RetoldFacetingStatementComposer;
module.exports.walkPred = walkPred;
module.exports.andOf = andOf;
module.exports.EXISTENCE_NODES = EXISTENCE_NODES;
