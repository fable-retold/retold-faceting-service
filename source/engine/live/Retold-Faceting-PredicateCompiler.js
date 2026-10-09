/**
 * Retold Faceting - Predicate Compiler (Live)
 *
 * Compiles FoldIR predicate trees (FoldPred: Cmp / And / Or / Exists / NotExists / CountCmp / True /
 * False) into the structural SQL text of a shell's WHERE / flag / computed-column slots, given the
 * Scoped Relations (or Staged key sets) already built for every Rel the tree references.
 *
 *   - Exists / NotExists → [NOT] EXISTS (SELECT 1 FROM (<SR>) "<alias>" WHERE <On pairs> [AND <nested>])
 *     (anti-joins are always NOT EXISTS, never NOT IN);
 *   - CountCmp            → (SELECT count(*) FROM (<SR>) "<alias>" WHERE <On> [AND <nested>]) <op> :q<n>_N;
 *   - Cmp leaves (and column-only And/Or subtrees on ONE alias) → PredicateFragment: rendered through
 *     FoxHound against the alias's entity (unqualified columns, every value bound, parameters renamed
 *     'q<n>_…'), valid only in a scope whose sole FROM item is that alias.  Elsewhere (a TuplePivot's
 *     joined scope, an outer alias inside a subquery) the subtree is handed to the caller's Flag
 *     callback, which projects it as a 0/1 column of that alias's wrapper and gets "<alias>"."q<n>" = 1;
 *   - a Staged hop (an Exists / NotExists whose relation is a StagedRelation) → the dialect's
 *     one-scalar key-set membership (RetoldFacetingStagedKeys.membership).
 *
 * SQL three-valued logic holds: a Cmp on NULL is unknown, On pairs are SQL equality.  Folding an
 * unknown flag to 0 is safe because FoldPred has no Not node (negation only at NotExists).
 *
 * Identifiers come only from catalog columns and plan aliases; values only from binds.
 *
 * Contract: internal-contracts §24.2, §26.4.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../../contract/Facet-Contract-Errors.js');
const libFacetRequest = require('../../contract/Facet-Contract-Request.js');
const libFacetClauses = require('../../contract/Facet-Contract-Clauses.js');
const libRetoldFacetingUtil = require('../../Retold-Faceting-Util.js');

const hasOwn = libRetoldFacetingUtil.hasOwn;

// PredicateFragment bind-name prefix (q<n>_<name>); SR binds are '<alias>_…', shell binds 'f…'.
const FRAGMENT_PREFIX = 'q';

// CountCmp operators (K19) → SQL.
const COUNT_OPERATORS = Object.freeze({ EQ: '=', NE: '<>', GT: '>', GE: '>=', LT: '<', LE: '<=' });

const EXISTENCE_NODES = Object.freeze([ 'Exists', 'NotExists', 'CountCmp' ]);

/**
 * The single alias of a column-only subtree (Cmp, or And/Or of column-only subtrees on one alias),
 * or null when the subtree holds an existence node or spans several aliases.
 *
 * @param {Record<string, any>} pNode
 * @return {string|null}
 */
const columnAlias = (pNode) =>
{
	if (!pNode || (typeof(pNode) !== 'object'))
	{
		return null;
	}
	if (pNode.Node === 'Cmp')
	{
		return (typeof(pNode.Alias) === 'string') ? pNode.Alias : null;
	}
	if (((pNode.Node === 'And') || (pNode.Node === 'Or')) && Array.isArray(pNode.Items) && (pNode.Items.length > 0))
	{
		let tmpAlias = columnAlias(pNode.Items[0]);
		for (let i = 1; (i < pNode.Items.length) && (tmpAlias !== null); i++)
		{
			if (columnAlias(pNode.Items[i]) !== tmpAlias)
			{
				tmpAlias = null;
			}
		}
		return tmpAlias;
	}
	return null;
};

/**
 * A column-only FoldPred subtree as a Part I Pred ({ Field, Op, Value } / { And } / { Or }), the
 * shape FilterAST.applyToQuery renders.
 *
 * @param {Record<string, any>} pNode
 * @return {Record<string, any>}
 */
const toColumnPred = (pNode) =>
{
	if (pNode.Node === 'Cmp')
	{
		let tmpLeaf = { Field: pNode.Field, Op: pNode.Op };
		if ((pNode.Op !== 'NULL') && (pNode.Op !== 'NOTNULL'))
		{
			tmpLeaf.Value = pNode.Value;
		}
		return tmpLeaf;
	}
	let tmpKind = (pNode.Node === 'And') ? 'And' : 'Or';
	let tmpResult = {};
	tmpResult[tmpKind] = pNode.Items.map(toColumnPred);
	return tmpResult;
};

/**
 * The identity of one FoxHound filter entry for operator transforms: column (unqualified),
 * operator, value.  null for a paren.
 *
 * @param {Record<string, any>} pEntry
 * @return {string|null}
 */
const entrySignature = (pEntry) =>
{
	if (!pEntry || (pEntry.Operator === '(') || (pEntry.Operator === ')'))
	{
		return null;
	}
	return `${libRetoldFacetingUtil.stripColumn(pEntry.Column)}|${String(pEntry.Operator)}|${libFacetClauses.canonicalJSON(pEntry.Value)}`;
};

class RetoldFacetingPredicateCompiler extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingPredicateCompiler';
	}

	/**
	 * Compile a FoldPred tree.
	 *
	 * pOptions:
	 *   - Scope: the aliases of the FROM at this level (default [ 'p' ]); a column subtree on the
	 *     sole alias renders inline as a PredicateFragment;
	 *   - Flag: (pAlias, pColumnPred) => column name | null — for a column subtree outside its sole
	 *     scope (the caller projects it as a 0/1 column of that alias's wrapper);
	 *   - State: { Fragments: n } — the per-statement fragment counter (q<n>), shared across calls.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>|null} pPred - FoldPred (internal-contracts §24.2)
	 * @param {Record<string, Record<string, any>>} pRelations - alias → built relation (ScopedRelationBuilder result, or a StagedRelation)
	 * @param {string} pDialectName
	 * @param {{ Scope?: Array<string>, Flag?: Function, State?: { Fragments: number } }} [pOptions]
	 * @return {{ SQL: string, Params: Record<string, any>, ParamTypes: Record<string, any> }} SQL '' for a null tree
	 */
	compile(pContext, pPred, pRelations, pDialectName, pOptions)
	{
		let tmpOptions = ((typeof(pOptions) === 'object') && (pOptions !== null)) ? pOptions : {};
		let tmpOut = { SQL: '', Params: {}, ParamTypes: {} };
		if ((pPred === null) || (typeof(pPred) === 'undefined'))
		{
			return tmpOut;
		}
		let tmpEnvironment = (
			{
				Context: pContext,
				Relations: pRelations || {},
				Dialect: pDialectName,
				Flag: (typeof(tmpOptions.Flag) === 'function') ? tmpOptions.Flag : null,
				State: tmpOptions.State || { Fragments: 0 },
				Out: tmpOut
			});
		tmpOut.SQL = this._node(pPred, Array.isArray(tmpOptions.Scope) ? tmpOptions.Scope : [ 'p' ], tmpEnvironment);
		return tmpOut;
	}

	/**
	 * Quote an identifier / qualify a column for the dialect (catalog identifiers only).
	 *
	 * @param {string} pDialectName
	 * @param {string} pAlias
	 * @param {string} pColumn
	 * @return {string}
	 */
	qualify(pDialectName, pAlias, pColumn)
	{
		return this.fable.RetoldFacetingDialects.qualify(pDialectName, pAlias, pColumn);
	}

	/**
	 * Merge a piece's binds into the output.
	 *
	 * @param {Record<string, any>} pOut
	 * @param {{ Params?: Record<string, any>, ParamTypes?: Record<string, any> }} pPiece
	 */
	_merge(pOut, pPiece)
	{
		Object.assign(pOut.Params, pPiece.Params || {});
		Object.assign(pOut.ParamTypes, pPiece.ParamTypes || {});
	}

	/**
	 * One node.
	 *
	 * @param {Record<string, any>} pNode
	 * @param {Array<string>} pScope - aliases of the FROM at this level
	 * @param {Record<string, any>} pEnvironment
	 * @return {string}
	 */
	_node(pNode, pScope, pEnvironment)
	{
		if (!pNode || (typeof(pNode) !== 'object') || (typeof(pNode.Node) !== 'string'))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'Malformed FoldPred node.');
		}
		switch (pNode.Node)
		{
			case 'True':
				return '1 = 1';
			case 'False':
				return '1 = 0';
			case 'Cmp':
				return this._column(pNode, pScope, pEnvironment);
			case 'And':
			case 'Or':
				{
					if (!Array.isArray(pNode.Items) || (pNode.Items.length < 1))
					{
						return (pNode.Node === 'And') ? '1 = 1' : '1 = 0';
					}
					if (columnAlias(pNode) !== null)
					{
						return this._column(pNode, pScope, pEnvironment);
					}
					let tmpParts = pNode.Items.map((pItem) => { return this._node(pItem, pScope, pEnvironment); });
					return (tmpParts.length === 1) ? tmpParts[0] : `(${tmpParts.join((pNode.Node === 'And') ? ' AND ' : ' OR ')})`;
				}
			case 'Exists':
			case 'NotExists':
				return this._exists(pNode, pScope, pEnvironment);
			case 'CountCmp':
				return this._countCmp(pNode, pScope, pEnvironment);
			default:
				throw libFacetErrors.create('FACET_INTERNAL', 'Unknown FoldPred node.');
		}
	}

	/**
	 * A column-only subtree on one alias: inline fragment in its sole scope, else a flag.
	 *
	 * @param {Record<string, any>} pNode
	 * @param {Array<string>} pScope
	 * @param {Record<string, any>} pEnvironment
	 * @return {string}
	 */
	_column(pNode, pScope, pEnvironment)
	{
		let tmpAlias = columnAlias(pNode);
		if (tmpAlias === null)
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'A column predicate needs one alias.');
		}
		let tmpColumnPred = toColumnPred(pNode);
		if ((pScope.length === 1) && (pScope[0] === tmpAlias))
		{
			let tmpRelation = hasOwn(pEnvironment.Relations, tmpAlias) ? pEnvironment.Relations[tmpAlias] : null;
			if (!tmpRelation || (typeof(tmpRelation.Entity) !== 'string'))
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'A column predicate names an alias with no relation.');
			}
			pEnvironment.State.Fragments++;
			let tmpFragment = this.fragment(pEnvironment.Context, tmpRelation.Entity, tmpColumnPred, `${FRAGMENT_PREFIX}${pEnvironment.State.Fragments}`, pEnvironment.Dialect);
			this._merge(pEnvironment.Out, tmpFragment);
			return `(${tmpFragment.SQL})`;
		}
		let tmpFlagColumn = pEnvironment.Flag ? pEnvironment.Flag(tmpAlias, tmpColumnPred) : null;
		if (typeof(tmpFlagColumn) !== 'string')
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'A column predicate is outside the scope of its alias.');
		}
		return `${this.qualify(pEnvironment.Dialect, tmpAlias, tmpFlagColumn)} = 1`;
	}

	/**
	 * The On pairs of an existence node as SQL equalities.
	 *
	 * @param {Array<Record<string, any>>} pOn
	 * @param {string} pInnerAlias
	 * @param {string} pDialectName
	 * @return {Array<string>}
	 */
	onPairs(pOn, pInnerAlias, pDialectName)
	{
		if (!Array.isArray(pOn) || (pOn.length < 1))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'An existence node needs its On pairs.');
		}
		return pOn.map(
			(pPair) =>
			{
				if (!pPair || !pPair.Outer || (typeof(pPair.Outer.Alias) !== 'string') || (typeof(pPair.Outer.Field) !== 'string') || (typeof(pPair.Inner) !== 'string'))
				{
					throw libFacetErrors.create('FACET_INTERNAL', 'Malformed On pair.');
				}
				return `${this.qualify(pDialectName, pInnerAlias, pPair.Inner)} = ${this.qualify(pDialectName, pPair.Outer.Alias, pPair.Outer.Field)}`;
			});
	}

	/**
	 * The relation of an existence node (built for its alias).
	 *
	 * @param {Record<string, any>} pNode
	 * @param {Record<string, any>} pEnvironment
	 * @return {Record<string, any>}
	 */
	_relationOf(pNode, pEnvironment)
	{
		let tmpAlias = (pNode.Rel && (typeof(pNode.Rel.As) === 'string')) ? pNode.Rel.As : null;
		if (!tmpAlias || !hasOwn(pEnvironment.Relations, tmpAlias))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'An existence node names a relation that was not built.');
		}
		return pEnvironment.Relations[tmpAlias];
	}

	/**
	 * Exists / NotExists (or a Staged membership).
	 *
	 * @param {Record<string, any>} pNode
	 * @param {Array<string>} pScope
	 * @param {Record<string, any>} pEnvironment
	 * @return {string}
	 */
	_exists(pNode, pScope, pEnvironment)
	{
		let tmpRelation = this._relationOf(pNode, pEnvironment);
		let tmpAlias = pNode.Rel.As;
		let tmpNegated = (pNode.Node === 'NotExists');
		if (tmpRelation.Staged === true)
		{
			if (pNode.Where)
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'Only a leaf existence hop runs Staged.');
			}
			// The staged key columns are the On pairs' inner columns IN On ORDER (StatementComposer.useRel
			// builds them positionally): map key i to On[i]'s outer column by index, so two pairs that
			// share an inner column ('=E.c' plus a Correlate onto c) keep both correlations.
			let tmpOn = Array.isArray(pNode.On) ? pNode.On : [];
			if (tmpRelation.Columns.length !== tmpOn.length)
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'A staged hop must correlate on exactly its key columns.');
			}
			let tmpOuter = tmpRelation.Columns.map(
				(pColumn, pIndex) =>
				{
					let tmpPair = tmpOn[pIndex];
					if (!tmpPair || (tmpPair.Inner !== pColumn) || !tmpPair.Outer)
					{
						throw libFacetErrors.create('FACET_INTERNAL', 'A staged key column has no On pair.');
					}
					return this.qualify(pEnvironment.Dialect, tmpPair.Outer.Alias, tmpPair.Outer.Field);
				});
			let tmpMembership = this.fable.RetoldFacetingStagedKeys.membership(pEnvironment.Dialect, tmpRelation, tmpOuter, tmpNegated);
			this._merge(pEnvironment.Out, tmpMembership);
			return `(${tmpMembership.SQL})`;
		}
		if (typeof(tmpRelation.SQL) !== 'string')
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'An existence node relation has no SQL.');
		}
		let tmpConditions = this.onPairs(pNode.On, tmpAlias, pEnvironment.Dialect);
		if (pNode.Where)
		{
			tmpConditions.push(this._node(pNode.Where, [ tmpAlias ], pEnvironment));
		}
		this._merge(pEnvironment.Out, tmpRelation);
		return `${tmpNegated ? 'NOT ' : ''}EXISTS (SELECT 1 FROM (${tmpRelation.SQL}) ${this.fable.RetoldFacetingDialects.quote(pEnvironment.Dialect, tmpAlias)} WHERE ${tmpConditions.join(' AND ')})`;
	}

	/**
	 * CountCmp (K19): (number of matching visible rows) Op N.
	 *
	 * @param {Record<string, any>} pNode
	 * @param {Array<string>} pScope
	 * @param {Record<string, any>} pEnvironment
	 * @return {string}
	 */
	_countCmp(pNode, pScope, pEnvironment)
	{
		let tmpOperator = hasOwn(COUNT_OPERATORS, pNode.Op) ? COUNT_OPERATORS[pNode.Op] : null;
		if (!tmpOperator || (typeof(pNode.N) !== 'number') || !Number.isSafeInteger(pNode.N) || (pNode.N < 0))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'Malformed CountCmp.');
		}
		let tmpRelation = this._relationOf(pNode, pEnvironment);
		if ((tmpRelation.Staged === true) || (typeof(tmpRelation.SQL) !== 'string'))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'A CountCmp relation cannot run Staged.');
		}
		let tmpAlias = pNode.Rel.As;
		let tmpConditions = this.onPairs(pNode.On, tmpAlias, pEnvironment.Dialect);
		if (pNode.Where)
		{
			tmpConditions.push(this._node(pNode.Where, [ tmpAlias ], pEnvironment));
		}
		this._merge(pEnvironment.Out, tmpRelation);
		pEnvironment.State.Fragments++;
		let tmpBindName = `${FRAGMENT_PREFIX}${pEnvironment.State.Fragments}_N`;
		let tmpSigil = this.fable.RetoldFacetingDialects.forName(pEnvironment.Dialect).Sigil;
		pEnvironment.Out.Params[tmpBindName] = pNode.N;
		if (pEnvironment.Dialect === 'MSSQL')
		{
			pEnvironment.Out.ParamTypes[tmpBindName] = 'Int';
		}
		let tmpBind = (pEnvironment.Dialect === 'PostgreSQL') ? `CAST(${tmpSigil}${tmpBindName} AS bigint)` : `${tmpSigil}${tmpBindName}`;
		return `(SELECT count(*) FROM (${tmpRelation.SQL}) ${this.fable.RetoldFacetingDialects.quote(pEnvironment.Dialect, tmpAlias)} WHERE ${tmpConditions.join(' AND ')}) ${tmpOperator} ${tmpBind}`;
	}

	/**
	 * The probed operator transforms of an entity in this request (entrySignature → operator), or null.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {string} pEntity
	 * @return {Map<string, string>|null}
	 */
	transformsFor(pContext, pEntity)
	{
		let tmpProbes = (pContext && pContext.Memo && (pContext.Memo.FragmentProbes instanceof Map)) ? pContext.Memo.FragmentProbes : null;
		let tmpProbe = tmpProbes ? tmpProbes.get(pEntity) : null;
		return tmpProbe ? tmpProbe.Transforms : null;
	}

	/**
	 * Probe the entity's own read behavior on the column leaves its PredicateFragments will render
	 * (internal-contracts §26.4): one capture of a fresh query whose client fence holds exactly those
	 * leaves (the explicit soft delete after it), through ScopeCapture (the entity's
	 * Reads-QueryConfiguration on the route-bound controller, ScopeGuard).  Every leaf entry whose
	 * operator the behavior rewrote (Transformed, e.g. LIKE → ILIKE) is recorded so fragment() renders
	 * the rewritten operator.  Memoized per request and entity: a leaf is probed once.  An Opaque
	 * capture is refused (a fragment cannot reproduce it).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {string} pEntity
	 * @param {Array<Record<string, any>>} pLeaves - { Field, Op, Value } column leaves
	 * @param {(pError?: Error, pTransformed?: number) => void} fCallback - pTransformed: how many of pLeaves a behavior rewrote
	 */
	probeTransforms(pContext, pEntity, pLeaves, fCallback)
	{
		let tmpContext = pContext || {};
		if (!tmpContext.Memo)
		{
			tmpContext.Memo = { Relations: {}, Captures: {}, VariantRows: {} };
		}
		if (!(tmpContext.Memo.FragmentProbes instanceof Map))
		{
			tmpContext.Memo.FragmentProbes = new Map();
		}
		let tmpProbe = tmpContext.Memo.FragmentProbes.get(pEntity);
		if (!tmpProbe)
		{
			tmpProbe = { Probed: new Map(), Transforms: new Map() };
			tmpContext.Memo.FragmentProbes.set(pEntity, tmpProbe);
		}
		let tmpLeaves = [];
		let tmpSeen = new Set();
		(Array.isArray(pLeaves) ? pLeaves : []).forEach(
			(pLeaf) =>
			{
				let tmpKey = libFacetClauses.canonicalJSON(pLeaf);
				if (!tmpSeen.has(tmpKey))
				{
					tmpSeen.add(tmpKey);
					tmpLeaves.push({ Key: tmpKey, Leaf: pLeaf });
				}
			});
		let fCount = () =>
		{
			return tmpLeaves.filter((pEntry) => { return tmpProbe.Probed.get(pEntry.Key) === true; }).length;
		};
		let tmpNew = tmpLeaves.filter((pEntry) => { return !tmpProbe.Probed.has(pEntry.Key); });
		if (tmpNew.length < 1)
		{
			return fCallback(null, fCount());
		}
		let tmpHost = tmpContext.Host;
		let tmpDAL = (tmpHost && (typeof(tmpHost.getExecutionDAL) === 'function')) ? tmpHost.getExecutionDAL(pEntity) : null;
		let tmpProfile = (tmpHost && (typeof(tmpHost.getDialectProfile) === 'function')) ? tmpHost.getDialectProfile(pEntity) : null;
		let tmpDialect = (tmpContext.Dialect) ? tmpContext.Dialect : ((tmpProfile && tmpProfile.Name) ? tmpProfile.Name : null);
		let tmpCapture = this.fable.RetoldFacetingScopeCapture;
		if (!tmpDAL || !tmpDialect || !tmpCapture)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The fragment entity cannot be probed.'));
		}
		let tmpQuery;
		let tmpRanges = [];
		let tmpBefore;
		try
		{
			tmpQuery = tmpDAL.query;
			tmpQuery.addFilter('', '', '(', 'AND', 'FacetFenceOpen');
			for (let i = 0; i < tmpNew.length; i++)
			{
				let tmpStart = tmpQuery.parameters.filter.length;
				this.fable.RetoldFacetingFilterAST.applyToQuery([ { Id: `f${i}`, Pred: tmpNew[i].Leaf, Shape: 'Column' } ], tmpQuery, { Dialect: tmpDialect, ParameterPrefix: `f${i}` });
				tmpRanges.push({ Start: tmpStart, End: tmpQuery.parameters.filter.length });
			}
			tmpQuery.addFilter('', '', ')', 'AND', 'FacetFenceClose');
			if ((typeof(tmpHost.hasDeleteColumn) === 'function') && tmpHost.hasDeleteColumn(pEntity))
			{
				tmpQuery.addFilter(tmpHost.getDeleteColumn(pEntity), 0, '=', 'AND', 'FacetSoftDelete');
			}
			tmpBefore = tmpCapture.snapshot(tmpQuery).Filter;
		}
		catch (pBuildError)
		{
			return fCallback(libFacetErrors.isFacetError(pBuildError) ? pBuildError : libFacetErrors.create('FACET_INTERNAL'));
		}
		let tmpColumns = [];
		tmpNew.forEach((pEntry) => { if ((typeof(pEntry.Leaf.Field) === 'string') && (tmpColumns.indexOf(pEntry.Leaf.Field) < 0)) { tmpColumns.push(pEntry.Leaf.Field); } });
		tmpCapture.capture(tmpContext, pEntity, tmpQuery, 'Inherit', { Columns: tmpColumns },
			(pCaptureError, pCaptured) =>
			{
				if (pCaptureError)
				{
					return fCallback(pCaptureError);
				}
				if (!pCaptured || pCaptured.Opaque)
				{
					this.fable.log.error(`RetoldFaceting refused an opaque scope capture for the column predicates of ${pEntity}.`);
					return fCallback(libFacetErrors.create('FACET_SCOPE_POLICY_VIOLATION', null, { Entity: pEntity, Reason: 'OpaqueUntrusted' }));
				}
				let tmpTransformed = Array.isArray(pCaptured.Transformed) ? pCaptured.Transformed : [];
				let tmpLeafTransformed = tmpNew.map(() => { return false; });
				for (let i = 0; i < tmpTransformed.length; i++)
				{
					let tmpIndex = tmpTransformed[i].Index;
					let tmpSignature = entrySignature(tmpBefore[tmpIndex]);
					if (!tmpSignature || !tmpTransformed[i].After || (typeof(tmpTransformed[i].After.Operator) !== 'string'))
					{
						continue;
					}
					tmpProbe.Transforms.set(tmpSignature, tmpTransformed[i].After.Operator);
					let tmpLeafIndex = tmpRanges.findIndex((pRange) => { return (tmpIndex >= pRange.Start) && (tmpIndex < pRange.End); });
					if (tmpLeafIndex >= 0)
					{
						tmpLeafTransformed[tmpLeafIndex] = true;
					}
				}
				tmpNew.forEach((pEntry, pIndex) => { tmpProbe.Probed.set(pEntry.Key, tmpLeafTransformed[pIndex]); });
				return fCallback(null, fCount());
			});
	}

	/**
	 * Render a column-only predicate on one entity as a bare SQL fragment (no FROM, no leading WHERE):
	 * a fresh query of the entity's execution DAL (delete tracking off), the predicate applied by
	 * FilterAST.applyToQuery (so operators, IN expansion and NULL rendering are the dialect's own),
	 * queryOverride '<%= Where %>', the leading WHERE stripped, every bind renamed '<pFragmentName>_…'.
	 * Its columns are unqualified: it is valid only where its entity's alias is the sole FROM item.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {string} pEntity
	 * @param {Record<string, any>} pColumnPred - { Field, Op, Value } / And / Or
	 * @param {string} pFragmentName - unique per statement ('q1', 'q2', …)
	 * @param {string} pDialectName
	 * @return {{ SQL: string, Params: Record<string, any>, ParamTypes: Record<string, any> }}
	 */
	fragment(pContext, pEntity, pColumnPred, pFragmentName, pDialectName)
	{
		if ((typeof(pFragmentName) !== 'string') || !/^q[0-9]+$/.test(pFragmentName))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'Invalid fragment name.');
		}
		if ((typeof(pEntity) !== 'string') || !libFacetRequest.IDENTIFIER_PATTERN.test(pEntity))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'Invalid fragment entity.');
		}
		let tmpHost = pContext ? pContext.Host : null;
		let tmpDAL = (tmpHost && (typeof(tmpHost.getExecutionDAL) === 'function')) ? tmpHost.getExecutionDAL(pEntity) : null;
		if (!tmpDAL)
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'The fragment entity has no DAL.');
		}
		let tmpQuery = tmpDAL.query;
		tmpQuery.setDisableDeleteTracking(true);
		// Bare field names as FoxHound parameters (MSSQL types a bind by Parameter == schema Column).
		this.fable.RetoldFacetingFilterAST.applyToQuery([ { Id: pFragmentName, Pred: pColumnPred, Shape: 'Column' } ], tmpQuery, { Dialect: pDialectName, ParameterPrefix: '' });
		// The entity's behaviors never run on a fragment: render the operators they rewrite (probed on
		// this very leaf by probeTransforms, e.g. LIKE → ILIKE) so the fragment means what the list means.
		let tmpTransforms = this.transformsFor(pContext, pEntity);
		if (tmpTransforms && (tmpTransforms.size > 0))
		{
			tmpQuery.parameters.filter.forEach(
				(pEntry) =>
				{
					let tmpSignature = entrySignature(pEntry);
					if (tmpSignature && tmpTransforms.has(tmpSignature))
					{
						pEntry.Operator = tmpTransforms.get(tmpSignature);
					}
				});
		}
		tmpQuery.parameters.queryOverride = '<%= Where %>';
		tmpQuery.setDialect(pDialectName).buildReadQuery();
		let tmpHarvested = this.fable.RetoldFacetingDialects.harvest(tmpQuery, pFragmentName, pDialectName);
		let tmpSQL = tmpHarvested.SQL.replace(/^\s*WHERE\s+/i, '').trim();
		if (tmpSQL.length < 1)
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'The fragment did not build.');
		}
		return { SQL: tmpSQL, Params: tmpHarvested.Params, ParamTypes: tmpHarvested.ParamTypes };
	}
}

module.exports = RetoldFacetingPredicateCompiler;
module.exports.entrySignature = entrySignature;
module.exports.serviceType = 'RetoldFacetingPredicateCompiler';
module.exports.FRAGMENT_PREFIX = FRAGMENT_PREFIX;
module.exports.COUNT_OPERATORS = COUNT_OPERATORS;
module.exports.EXISTENCE_NODES = EXISTENCE_NODES;
module.exports.columnAlias = columnAlias;
module.exports.toColumnPred = toColumnPred;
