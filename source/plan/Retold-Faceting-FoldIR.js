/**
 * Retold Faceting - FoldIR
 *
 * The engine-neutral plan objects (01 §6): Agg and its Dimensions (M1), plus the M2 relational
 * pieces — Rel (one Scoped Relation per hop / tuple side / lookup / chain link / child / parent),
 * FoldPred (Cmp / And / Or / Exists / NotExists / CountCmp / True / False), the Via / Multi /
 * ChildAgg / ExistsFlag dimensions and the TupleJoin.  Every engine compiles Aggs; no engine
 * re-reads the catalog for typing, so every Dim carries DataType, IsInteger and Scale.  Pure
 * builders and pure tree walkers (relations, columnsOf, realias, depSet): both engines read the
 * same FoldIR, Live compiling it to SQL and the Reference interpreting it over list reads.
 *
 * Contract: internal-contracts §5 (M1), §24 (M2).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');
const libCrypto = require('crypto');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libFacetRequest = require('../contract/Facet-Contract-Request.js');
const libFacetClauses = require('../contract/Facet-Contract-Clauses.js');
const libFacetUtil = require('../contract/Facet-Contract-Util.js');

// Date intervals when a descriptor does not list its own (the contract's list).
const INTERVALS = libFacetRequest.INTERVALS;

// Rel roles (internal-contracts §24.1).
const REL_ROLES = Object.freeze([ 'Pivot', 'TupleSide', 'Hop', 'Lookup', 'Multi', 'Child', 'Parent' ]);

// FoldPred node kinds (internal-contracts §24.2).
const PRED_NODES = Object.freeze([ 'Cmp', 'And', 'Or', 'Exists', 'NotExists', 'CountCmp', 'True', 'False' ]);

// Dimension kinds whose value is a column of an alias (M1 kinds; may carry Alias / Via in M2).
const COLUMN_DIMENSION_KINDS = Object.freeze([ 'Column', 'DateBucket', 'NumericBucket', 'Range' ]);

/**
 * 'wh:' + 12 hex of sha1(canonicalJSON(pWhere)), '' for no Where.
 *
 * @param {any} pWhere
 * @return {string}
 */
const whereHash = (pWhere) =>
{
	if ((pWhere === null) || (typeof(pWhere) === 'undefined'))
	{
		return '';
	}
	return 'wh:' + libCrypto.createHash('sha1').update(libFacetClauses.canonicalJSON(pWhere)).digest('hex').substring(0, 12);
};

/**
 * A Rel with every field of internal-contracts §24.1 present (defaults applied; WhereHash derived
 * from Where unless given).
 *
 * @param {Record<string, any>} pFields
 * @return {Record<string, any>}
 */
const newRel = (pFields) =>
{
	let tmpFields = libFacetUtil.isPlainObject(pFields) ? pFields : {};
	let tmpRel = Object.assign(
		{
			Entity: null,
			As: null,
			Role: 'Hop',
			Project: [],
			Client: null,
			Where: null,
			WhereHash: '',
			Scope: 'Inherit',
			ScopeReason: null,
			SoftDelete: 'Explicit',
			Stage: 'Never'
		}, tmpFields);
	if (!libFacetUtil.hasOwn(tmpFields, 'WhereHash'))
	{
		tmpRel.WhereHash = whereHash(tmpRel.Where);
	}
	return tmpRel;
};

/**
 * Walk a FoldIR tree: a FoldPred, a Dim, an Agg, a Variant, a TupleJoin or an array of those.
 * fVisit(pKind, pNode, pExtra) is called with:
 *   'Rel'  (Rel, { On, Owner })          every Rel (Owner: the node / link / side that holds it)
 *   'Pred' (FoldPred node)               every FoldPred node
 *   'Dim'  (Dim)                         every dimension
 *   'Tuple'(TupleJoin)                   every TupleJoin
 *
 * @param {any} pTree
 * @param {(pKind: string, pNode: any, pExtra?: any) => void} fVisit
 */
const walk = (pTree, fVisit) =>
{
	let tmpSeen = new Set();
	let fPred = (pNode) =>
	{
		if (!libFacetUtil.isPlainObject(pNode) || tmpSeen.has(pNode))
		{
			return;
		}
		tmpSeen.add(pNode);
		fVisit('Pred', pNode);
		switch (pNode.Node)
		{
			case 'And':
			case 'Or':
				(Array.isArray(pNode.Items) ? pNode.Items : []).forEach(fPred);
				return;
			case 'Exists':
			case 'NotExists':
			case 'CountCmp':
				if (libFacetUtil.isPlainObject(pNode.Rel))
				{
					fVisit('Rel', pNode.Rel, { On: Array.isArray(pNode.On) ? pNode.On : [], Owner: pNode });
				}
				fPred(pNode.Where);
				return;
			default:
				return;
		}
	};
	let fDim = (pDim) =>
	{
		if (!libFacetUtil.isPlainObject(pDim) || tmpSeen.has(pDim))
		{
			return;
		}
		tmpSeen.add(pDim);
		fVisit('Dim', pDim);
		if (Array.isArray(pDim.Via))
		{
			pDim.Via.forEach((pLink) => { if (pLink && pLink.Rel) { fVisit('Rel', pLink.Rel, { On: Array.isArray(pLink.On) ? pLink.On : [], Owner: pLink }); } });
		}
		if (Array.isArray(pDim.Chain))
		{
			pDim.Chain.forEach((pLink) => { if (pLink && pLink.Rel) { fVisit('Rel', pLink.Rel, { On: Array.isArray(pLink.On) ? pLink.On : [], Owner: pLink }); } });
		}
		if ((pDim.Kind === 'ChildAgg') && libFacetUtil.isPlainObject(pDim.Rel))
		{
			fVisit('Rel', pDim.Rel, { On: Array.isArray(pDim.On) ? pDim.On : [], Owner: pDim });
		}
		if ((pDim.Kind === 'Multi') || (pDim.Kind === 'ChildAgg'))
		{
			fPred(pDim.Where);
		}
		if (pDim.Kind === 'ExistsFlag')
		{
			fPred(pDim.Pred);
		}
	};
	let fTuple = (pTuple) =>
	{
		if (!libFacetUtil.isPlainObject(pTuple) || tmpSeen.has(pTuple))
		{
			return;
		}
		tmpSeen.add(pTuple);
		fVisit('Tuple', pTuple);
		(Array.isArray(pTuple.Sides) ? pTuple.Sides : []).forEach((pSide) => { if (pSide && pSide.Rel) { fVisit('Rel', pSide.Rel, { On: [], Owner: pSide }); } });
	};
	let fAny = (pNode) =>
	{
		if (Array.isArray(pNode))
		{
			pNode.forEach(fAny);
			return;
		}
		if (!libFacetUtil.isPlainObject(pNode))
		{
			return;
		}
		if (typeof(pNode.Node) === 'string')
		{
			fPred(pNode);
			return;
		}
		if (Array.isArray(pNode.Dimensions))
		{
			// An Agg (checked before the Variant test: an Agg carries a VariantId too).
			pNode.Dimensions.forEach(fDim);
			fPred(pNode.Where);
			fTuple(pNode.Tuple);
			return;
		}
		if ((typeof(pNode.VariantId) === 'string') && Array.isArray(pNode.ConjunctIds))
		{
			// A Variant: its PathPred and its W_def.
			fPred(pNode.PathPred);
			fPred(pNode.Where);
			return;
		}
		if (Array.isArray(pNode.Sides) && Array.isArray(pNode.Key))
		{
			fTuple(pNode);
			return;
		}
		if (typeof(pNode.Kind) === 'string')
		{
			fDim(pNode);
		}
	};
	fAny(pTree);
};

/**
 * Every Rel inside a tree (each once, in walk order).
 *
 * @param {any} pTree
 * @return {Array<Record<string, any>>}
 */
const relationsOf = (pTree) =>
{
	let tmpRels = [];
	walk(pTree,
		(pKind, pNode) =>
		{
			if ((pKind === 'Rel') && (tmpRels.indexOf(pNode) < 0))
			{
				tmpRels.push(pNode);
			}
		});
	return tmpRels;
};

/**
 * Every column a tree reads from one alias (sorted, unique): Cmp leaves on it, On pairs (Outer
 * on it, Inner of its own Rel), dimension fields read from it (a Via / Multi dimension reads its
 * Field / KeyField from its LAST link), TupleJoin On / Key columns.
 *
 * @param {any} pTree
 * @param {string} pAlias
 * @return {Array<string>}
 */
const columnsOf = (pTree, pAlias) =>
{
	let tmpColumns = {};
	let fAdd = (pAliasName, pField) =>
	{
		if ((pAliasName === pAlias) && (typeof(pField) === 'string') && (pField.length > 0))
		{
			tmpColumns[pField] = true;
		}
	};
	let fPairs = (pOn, pInnerAlias) =>
	{
		(Array.isArray(pOn) ? pOn : []).forEach(
			(pPair) =>
			{
				if (pPair && pPair.Outer)
				{
					fAdd(pPair.Outer.Alias, pPair.Outer.Field);
				}
				if (pPair)
				{
					fAdd(pInnerAlias, pPair.Inner);
				}
			});
	};
	walk(pTree,
		(pKind, pNode, pExtra) =>
		{
			if (pKind === 'Pred')
			{
				if (pNode.Node === 'Cmp')
				{
					fAdd(pNode.Alias, pNode.Field);
				}
				return;
			}
			if (pKind === 'Rel')
			{
				fPairs(pExtra ? pExtra.On : [], pNode.As);
				return;
			}
			if (pKind === 'Dim')
			{
				if (COLUMN_DIMENSION_KINDS.indexOf(pNode.Kind) >= 0)
				{
					if (Array.isArray(pNode.Via) && (pNode.Via.length > 0))
					{
						let tmpLast = pNode.Via[pNode.Via.length - 1];
						fAdd(tmpLast && tmpLast.Rel ? tmpLast.Rel.As : null, pNode.Field);
					}
					else
					{
						fAdd((typeof(pNode.Alias) === 'string') ? pNode.Alias : 'p', pNode.Field);
					}
				}
				else if ((pNode.Kind === 'Multi') && Array.isArray(pNode.Chain) && (pNode.Chain.length > 0))
				{
					let tmpLast = pNode.Chain[pNode.Chain.length - 1];
					fAdd(tmpLast && tmpLast.Rel ? tmpLast.Rel.As : null, pNode.KeyField);
				}
				else if ((pNode.Kind === 'ChildAgg') && pNode.Rel)
				{
					fAdd(pNode.Rel.As, pNode.Field);
				}
				return;
			}
			if (pKind === 'Tuple')
			{
				(Array.isArray(pNode.On) ? pNode.On : []).forEach(
					(pPair) =>
					{
						if (pPair && pPair.Left)
						{
							fAdd(pPair.Left.Alias, pPair.Left.Field);
						}
						if (pPair && pPair.Right)
						{
							fAdd(pPair.Right.Alias, pPair.Right.Field);
						}
					});
				(Array.isArray(pNode.Key) ? pNode.Key : []).forEach((pKey) => { if (pKey) { fAdd(pKey.Alias, pKey.Field); } });
			}
		});
	return Object.keys(tmpColumns).sort();
};

/**
 * A deep copy of a tree with every use of one alias renamed (Rel.As, On Outer.Alias, Cmp.Alias,
 * Dim.Alias, TupleJoin Left / Right / Key / side Alias, TupleJoin.Names values).  Pure.
 *
 * @param {any} pTree
 * @param {string} pFrom
 * @param {string} pTo
 * @return {any}
 */
const realias = (pTree, pFrom, pTo) =>
{
	let tmpCopies = new Map();
	let fCopy = (pNode, pKey) =>
	{
		if (Array.isArray(pNode))
		{
			return pNode.map((pItem) => { return fCopy(pItem, null); });
		}
		if (!libFacetUtil.isPlainObject(pNode))
		{
			return pNode;
		}
		if (tmpCopies.has(pNode))
		{
			// Shared sub-trees stay shared in the copy.
			return tmpCopies.get(pNode);
		}
		let tmpCopy = {};
		tmpCopies.set(pNode, tmpCopy);
		let tmpKeys = Object.keys(pNode);
		for (let i = 0; i < tmpKeys.length; i++)
		{
			let tmpKey = tmpKeys[i];
			let tmpValue = pNode[tmpKey];
			if (((tmpKey === 'As') || (tmpKey === 'Alias')) && (tmpValue === pFrom))
			{
				tmpCopy[tmpKey] = pTo;
			}
			else if ((tmpKey === 'Names') && libFacetUtil.isPlainObject(tmpValue))
			{
				let tmpNames = {};
				Object.keys(tmpValue).forEach((pName) => { tmpNames[pName] = (tmpValue[pName] === pFrom) ? pTo : tmpValue[pName]; });
				tmpCopy[tmpKey] = tmpNames;
			}
			else if (tmpKey === 'Client')
			{
				// Client conjuncts are FilterAST objects (no aliases): shared, never copied.
				tmpCopy[tmpKey] = tmpValue;
			}
			else
			{
				tmpCopy[tmpKey] = fCopy(tmpValue, tmpKey);
			}
		}
		return tmpCopy;
	};
	return fCopy(pTree, null);
};

/**
 * Every Field a column predicate ({ Field, Op, Value } / And / Or) references.
 *
 * @param {any} pPred
 * @return {Array<string>}
 */
const columnPredFields = (pPred) =>
{
	let tmpFields = {};
	let fWalk = (pNode) =>
	{
		if (!libFacetUtil.isPlainObject(pNode))
		{
			return;
		}
		if (typeof(pNode.Field) === 'string')
		{
			tmpFields[pNode.Field] = true;
		}
		(Array.isArray(pNode.And) ? pNode.And : Array.isArray(pNode.Or) ? pNode.Or : []).forEach(fWalk);
	};
	fWalk(pPred);
	return Object.keys(tmpFields).sort();
};

// Folds whose dimension may be a Pivot axis in M1 (Column, DateBucket, Range; internal-contracts §5.2).
const PIVOT_AXIS_FOLDS = Object.freeze([ 'Terms', 'DateHistogram', 'Ranges' ]);

// Fold kind → dimension kind (internal-contracts §5.2)
const FOLD_DIMENSION_KIND = Object.freeze(
	{
		Terms: 'Column',
		DateHistogram: 'DateBucket',
		NumericHistogram: 'NumericBucket',
		Ranges: 'Range'
	});

class RetoldFacetingFoldIR extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingFoldIR';
	}

	/**
	 * An Agg with every field of internal-contracts §5.1 present (defaults applied).
	 *
	 * @param {Record<string, any>} pFields
	 * @return {Record<string, any>}
	 */
	agg(pFields)
	{
		let tmpFields = (typeof(pFields) === 'object') && (pFields !== null) ? pFields : {};
		return Object.assign(
			{
				Key: null,
				FacetID: null,
				FacetIDs: [],
				Kind: null,
				Pivot: null,
				Dimensions: [],
				Field: null,
				FieldInfo: null,
				Measures: [ { Op: 'count' } ],
				CountMode: 'Rows',
				Top: null,
				Order: 'CountDesc',
				Missing: true,
				EmptyBuckets: true,
				Chart: false,
				Exclude: 'None',
				VariantId: 'v0',
				Disjunctive: { Mode: 'NotApplicable', Excluded: [], ExcludedHashes: [], KeptMixed: [], Owned: [] },
				ClauseType: null,
				FilterKey: null,
				Selectable: false,
				DepSet: {},
				DisplayName: null,
				// Wiring additions: Terms keys the facet's own conjuncts select (the Live statement then
				// returns every group, so selected keys ranked below Top keep their real counts), and the
				// FK label lookup used by post-processing (null = no labels).
				SelectedKeys: [],
				LabelLookup: null,
				// M2 (internal-contracts §24.5)
				Origin: 'Auto',
				Definition: null,
				Where: null,
				WhereHash: '',
				Tuple: null,
				MultiValued: false,
				Relaxed: false,
				Semantics: null,
				Path: null,
				OwnedFields: [],
				Entities: [],
				Relations: [],
				CubeId: null
			}, tmpFields);
	}

	/**
	 * A Rel with defaults applied (internal-contracts §24.1).
	 *
	 * @param {Record<string, any>} pFields
	 * @return {Record<string, any>}
	 */
	rel(pFields)
	{
		return newRel(pFields);
	}

	/**
	 * A copy of a tree with one alias renamed (pure; tests and statement composers).
	 *
	 * @param {any} pTree
	 * @param {string} pFrom
	 * @param {string} pTo
	 * @return {any}
	 */
	realias(pTree, pFrom, pTo)
	{
		return realias(pTree, pFrom, pTo);
	}

	/**
	 * Every Rel inside a FoldPred / Dim / Agg / Variant (each once).
	 *
	 * @param {any} pTree
	 * @return {Array<Record<string, any>>}
	 */
	relations(pTree)
	{
		return relationsOf(pTree);
	}

	/**
	 * Every column a tree reads from one alias (e.g. the pivot 'p': the columns its Scoped Relation
	 * must project for the Variant PathPred, the definition Where, and the first Via / Multi /
	 * ChildAgg links).
	 *
	 * @param {any} pTree
	 * @param {string} pAlias
	 * @return {Array<string>}
	 */
	columnsOf(pTree, pAlias)
	{
		return columnsOf(pTree, pAlias);
	}

	/**
	 * The pivot columns an Agg and its Variant read from alias 'p' besides its dimensions: the
	 * Outer columns of the PathPred, the definition Where and every first link (internal-contracts
	 * §26.4: the pivot SR projects them).
	 *
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, any>} [pVariant]
	 * @return {Array<string>}
	 */
	pivotColumns(pAgg, pVariant)
	{
		return columnsOf([ pAgg, pVariant ].filter((pItem) => { return !!pItem; }), 'p');
	}

	/**
	 * The Dim for a fold on a catalog descriptor (internal-contracts §5.2).
	 *
	 * @param {string} pFold
	 * @param {Record<string, any>} pDescriptor - catalog facet descriptor
	 * @param {Record<string, any>} pFacetSpec - NormalizedRequest.Facets[i]
	 * @return {Record<string, any>} Dim (throws a per-facet FacetError)
	 */
	dimensionFor(pFold, pDescriptor, pFacetSpec)
	{
		let tmpSpec = ((typeof(pFacetSpec) === 'object') && (pFacetSpec !== null)) ? pFacetSpec : {};
		if ((typeof(pDescriptor) !== 'object') || (pDescriptor === null) || (typeof(pDescriptor.Field) !== 'string'))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'A dimension needs a catalog descriptor.');
		}
		let tmpLimits = this.options.Limits;
		let tmpIsInteger = !!pDescriptor.IsInteger;
		let tmpScale = (typeof(pDescriptor.Scale) === 'number') ? pDescriptor.Scale : 0;
		switch (FOLD_DIMENSION_KIND[pFold])
		{
			case 'Column':
				return { Kind: 'Column', Field: pDescriptor.Field, DataType: pDescriptor.DataType, IsInteger: tmpIsInteger, Scale: tmpScale };

			case 'DateBucket':
				{
					let tmpIntervals = Array.isArray(pDescriptor.Intervals) ? pDescriptor.Intervals : INTERVALS;
					let tmpInterval = (typeof(tmpSpec.Interval) === 'string') ? tmpSpec.Interval
						: (typeof(pDescriptor.DefaultInterval) === 'string') ? pDescriptor.DefaultInterval
						: this.options.Time.DefaultInterval;
					if (tmpIntervals.indexOf(tmpInterval) < 0)
					{
						throw libFacetErrors.create('FACET_REQUEST_INVALID', 'This facet does not offer that interval.',
							{ Field: 'Interval', Facet: pDescriptor.Facet, Reason: 'IntervalNotOffered', Intervals: tmpIntervals.slice() });
					}
					return { Kind: 'DateBucket', Field: pDescriptor.Field, Interval: tmpInterval, DataType: pDescriptor.DataType };
				}

			case 'NumericBucket':
				{
					let tmpMode = (tmpSpec.Mode === 'Edges') ? 'Edges' : 'Nice';
					if ((tmpMode === 'Edges') && (!Array.isArray(tmpSpec.Edges) || (tmpSpec.Edges.length < 2)))
					{
						throw libFacetErrors.create('FACET_REQUEST_INVALID', 'Mode: Edges requires Edges.', { Field: 'Edges', Facet: pDescriptor.Facet, Reason: 'EdgesRequired' });
					}
					return (
						{
							Kind: 'NumericBucket',
							Field: pDescriptor.Field,
							Mode: tmpMode,
							Buckets: (tmpMode === 'Nice') ? ((typeof(tmpSpec.Buckets) === 'number') ? tmpSpec.Buckets : tmpLimits.DefaultBuckets) : null,
							Edges: (tmpMode === 'Edges') ? tmpSpec.Edges.slice() : null,
							OpenEnded: (tmpMode === 'Edges') && (tmpSpec.OpenEnded === true),
							DataType: pDescriptor.DataType,
							IsInteger: tmpIsInteger,
							Scale: tmpScale
						});
				}

			case 'Range':
				{
					if (!Array.isArray(tmpSpec.Ranges) || (tmpSpec.Ranges.length < 1))
					{
						throw libFacetErrors.create('FACET_REQUEST_INVALID', 'A Ranges facet needs Ranges.', { Field: 'Ranges', Facet: pDescriptor.Facet, Reason: 'RangesRequired' });
					}
					return (
						{
							Kind: 'Range',
							Field: pDescriptor.Field,
							Ranges: tmpSpec.Ranges.map((pRange) => { return { Key: pRange.Key, From: pRange.From, To: pRange.To, Label: pRange.Label }; }),
							DataType: pDescriptor.DataType,
							IsInteger: tmpIsInteger,
							Scale: tmpScale
						});
				}

			default:
				throw libFacetErrors.create('FACET_INTERNAL', 'This fold has no dimension.');
		}
	}

	/**
	 * The Dim of one Pivot axis (internal-contracts §5.2): the axis facet's own default fold mapped
	 * like a single-dimension fold, the request Interval applied to date axes.  M1 axes are Column,
	 * DateBucket and Range only.  A numeric axis (default fold NumericHistogram) becomes a Range axis
	 * when the request carries Ranges, else a Column axis when the facet lists Terms (integer
	 * columns), else it is refused (422, Feature 'NumericPivotAxis').
	 *
	 * @param {Record<string, any>} pDescriptor - catalog descriptor of the axis FacetID
	 * @param {Record<string, any>} pFacetSpec - NormalizedRequest.Facets[i]
	 * @return {Record<string, any>} Dim (throws a per-facet FacetError)
	 */
	pivotAxisFor(pDescriptor, pFacetSpec)
	{
		let tmpSpec = ((typeof(pFacetSpec) === 'object') && (pFacetSpec !== null)) ? pFacetSpec : {};
		let tmpFolds = Array.isArray(pDescriptor.Folds) ? pDescriptor.Folds : [];
		let tmpFold = pDescriptor.DefaultFold;
		if (tmpFold === 'NumericHistogram')
		{
			if (Array.isArray(tmpSpec.Ranges) && (tmpSpec.Ranges.length > 0) && (tmpFolds.indexOf('Ranges') >= 0))
			{
				tmpFold = 'Ranges';
			}
			else if (tmpFolds.indexOf('Terms') >= 0)
			{
				tmpFold = 'Terms';
			}
			else
			{
				throw libFacetErrors.create('FACET_FOLD_UNSUPPORTED', 'A numeric histogram cannot be a pivot axis yet.', { Feature: 'NumericPivotAxis', Milestone: 1, Facet: pDescriptor.Facet });
			}
		}
		if (PIVOT_AXIS_FOLDS.indexOf(tmpFold) < 0)
		{
			throw libFacetErrors.create('FACET_FOLD_UNSUPPORTED', 'This facet cannot be a pivot axis yet.', { Feature: `PivotAxis:${tmpFold}`, Milestone: 1, Facet: pDescriptor.Facet });
		}
		return this.dimensionFor(tmpFold, pDescriptor, tmpSpec);
	}

	/**
	 * DepSet of an Agg under its Variant (internal-contracts §5.1, §24.10):
	 *   the pivot: PK, delete column, policy columns, the dimension / measure columns read from the
	 *   pivot, every kept conjunct's column fields (pseudo-fields '@scope:…' / '@path:…' excluded) and
	 *   every pivot column the PathPred, the definition Where and the first links read;
	 *   every Rel inside the Agg and inside the Variant's PathPred: its PK, delete column, policy
	 *   columns, Project columns, Where fields and inner On columns.
	 * An M1 Agg (no Rels) gets exactly its M1 DepSet.
	 *
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, any>} pVariant
	 * @param {any} pCatalog
	 * @return {Record<string, Array<string>>}
	 */
	depSet(pAgg, pVariant, pCatalog)
	{
		let tmpEntity = (pAgg && (typeof(pAgg.Pivot) === 'string')) ? pAgg.Pivot : null;
		if (!tmpEntity)
		{
			return {};
		}
		let tmpSets = {};
		let fAdd = (pEntity, pColumn) =>
		{
			if ((typeof(pEntity) !== 'string') || (typeof(pColumn) !== 'string') || (pColumn.length < 1) || (pColumn.charAt(0) === '@'))
			{
				return;
			}
			if (!libFacetUtil.hasOwn(tmpSets, pEntity))
			{
				tmpSets[pEntity] = {};
			}
			tmpSets[pEntity][pColumn] = true;
		};
		let fStructural = (pTarget) =>
		{
			let tmpDescriptor = (pCatalog && (typeof(pCatalog.getFacetable) === 'function')) ? pCatalog.getFacetable(pTarget) : null;
			if (!tmpDescriptor)
			{
				return;
			}
			fAdd(pTarget, tmpDescriptor.PK);
			fAdd(pTarget, tmpDescriptor.DeleteColumn);
			let tmpColumnNames = Object.keys(tmpDescriptor.Columns || {});
			for (let i = 0; i < tmpColumnNames.length; i++)
			{
				if (tmpDescriptor.Columns[tmpColumnNames[i]].IsPolicyColumn)
				{
					fAdd(pTarget, tmpColumnNames[i]);
				}
			}
		};

		fStructural(tmpEntity);
		if (!libFacetUtil.hasOwn(tmpSets, tmpEntity))
		{
			tmpSets[tmpEntity] = {};
		}
		let tmpDimensions = Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions : [];
		let tmpPivotOnly = !pAgg.Tuple;
		for (let i = 0; i < tmpDimensions.length; i++)
		{
			let tmpDimension = tmpDimensions[i];
			if (!tmpDimension || (COLUMN_DIMENSION_KINDS.indexOf(tmpDimension.Kind) < 0))
			{
				tmpPivotOnly = false;
				continue;
			}
			if (Array.isArray(tmpDimension.Via) && (tmpDimension.Via.length > 0))
			{
				tmpPivotOnly = false;
				continue;
			}
			if ((typeof(tmpDimension.Alias) !== 'string') || (tmpDimension.Alias === 'p'))
			{
				fAdd(tmpEntity, tmpDimension.Field);
			}
		}
		if (tmpPivotOnly)
		{
			// The measured column (Stats / DistinctCount / Missing; = the dimension field otherwise).
			fAdd(tmpEntity, pAgg.Field);
		}
		let tmpConjuncts = (pVariant && Array.isArray(pVariant.Conjuncts)) ? pVariant.Conjuncts : [];
		for (let i = 0; i < tmpConjuncts.length; i++)
		{
			let tmpFields = Array.isArray(tmpConjuncts[i].Fields) ? tmpConjuncts[i].Fields : [];
			for (let j = 0; j < tmpFields.length; j++)
			{
				fAdd(tmpEntity, tmpFields[j]);
			}
		}
		let tmpTrees = [ pAgg ];
		if (pVariant)
		{
			tmpTrees.push(pVariant);
		}
		columnsOf(tmpTrees, 'p').forEach((pColumn) => { fAdd(tmpEntity, pColumn); });

		let tmpRels = relationsOf(tmpTrees);
		for (let i = 0; i < tmpRels.length; i++)
		{
			let tmpRel = tmpRels[i];
			if (typeof(tmpRel.Entity) !== 'string')
			{
				continue;
			}
			fStructural(tmpRel.Entity);
			(Array.isArray(tmpRel.Project) ? tmpRel.Project : []).forEach((pColumn) => { fAdd(tmpRel.Entity, pColumn); });
			columnPredFields(tmpRel.Where).forEach((pColumn) => { fAdd(tmpRel.Entity, pColumn); });
			columnsOf(tmpTrees, tmpRel.As).forEach((pColumn) => { fAdd(tmpRel.Entity, pColumn); });
		}

		let tmpResult = {};
		Object.keys(tmpSets).forEach((pTarget) => { tmpResult[pTarget] = Object.keys(tmpSets[pTarget]).sort(); });
		return tmpResult;
	}
}

module.exports = RetoldFacetingFoldIR;
module.exports.serviceType = 'RetoldFacetingFoldIR';
module.exports.FOLD_DIMENSION_KIND = FOLD_DIMENSION_KIND;
module.exports.PIVOT_AXIS_FOLDS = PIVOT_AXIS_FOLDS;
module.exports.REL_ROLES = REL_ROLES;
module.exports.PRED_NODES = PRED_NODES;
module.exports.COLUMN_DIMENSION_KINDS = COLUMN_DIMENSION_KINDS;
module.exports.whereHash = whereHash;
module.exports.newRel = newRel;
module.exports.walk = walk;
module.exports.relationsOf = relationsOf;
module.exports.columnsOf = columnsOf;
module.exports.realias = realias;
module.exports.columnPredFields = columnPredFields;
