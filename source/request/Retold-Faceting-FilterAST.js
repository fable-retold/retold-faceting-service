/**
 * Retold Faceting - FilterAST
 *
 * The normalized filter (01 §8): an AND of conjuncts built from pict clauses and meadow-filter
 * strings, with SQL precedence reproduced exactly, conjunct ownership info for disjunctive
 * faceting, and the one renderer that turns conjuncts back into FoxHound filter entries
 * (applyToQuery) or a fenced meadow-filter string (toFilterString).
 *
 * Precedence (internal-contracts §4.4): meadow-filter writes every stanza as one flat FoxHound
 * entry with its own connector and FoxHound emits them in order, so SQL precedence applies
 * (AND binds tighter than OR).  The depth-0 term sequence (a term is one stanza or one whole
 * FOP…FCP group) is split at every OR-connected term into OR-branches, each the AND of its
 * terms; the first term's connector is ignored (FoxHound emits none there).  One branch → each
 * term is its own conjunct.  Two or more → the WHOLE string is one conjunct
 * Or[ And(branch₁), And(branch₂), … ].  Inside a group the same rule yields the group's Pred.
 *
 * combine / branches / branchesToPred are the ONE implementation of that precedence algebra; the
 * ClauseCompiler uses them for clause junctions too.
 *
 * Synchronous; throws FacetErrors.  Contract: internal-contracts §4.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libFacetRequest = require('../contract/Facet-Contract-Request.js');
const libFacetUtil = require('../contract/Facet-Contract-Util.js');
const libRetoldFacetingFilterValidator = require('./Retold-Faceting-FilterValidator.js');

// FilterAST Op → FoxHound operator (internal-contracts §4.5).  NULL is dialect-specific.
const FOXHOUND_OPERATORS = Object.freeze(
	{
		EQ: '=', NE: '!=', GT: '>', GE: '>=', LT: '<', LE: '<=',
		LK: 'LIKE', NLK: 'NOT LIKE',
		IN: 'IN', NIN: 'NOT IN',
		NOTNULL: 'IS NOT NULL'
	});

// FilterAST Op → meadow-filter operator (for toFilterString).
const FILTER_STRING_OPERATORS = Object.freeze(
	{
		EQ: 'EQ', NE: 'NE', GT: 'GT', GE: 'GE', LT: 'LT', LE: 'LE',
		LK: 'LK', NLK: 'NLK',
		NULL: 'IN', NOTNULL: 'NN',
		IN: 'INN', NIN: 'NIN'
	});

// The meadow-filter instruction sets are the FilterValidator's.
const OPEN_INSTRUCTIONS = libRetoldFacetingFilterValidator.OPEN_INSTRUCTIONS;
const OR_INSTRUCTIONS = libRetoldFacetingFilterValidator.OR_INSTRUCTIONS;
const LIST_INSTRUCTIONS = libRetoldFacetingFilterValidator.LIST_INSTRUCTIONS;

const FENCE_OPEN = 'FOP~0~(~0';
const FENCE_CLOSE = 'FCP~0~)~0';

// The existence nodes of a bound Pred (M2, internal-contracts §23.2).
const EXISTENCE_KINDS = Object.freeze([ 'Exists', 'NotExists', 'HavingCount' ]);

/**
 * Does a Pred hold an Exists / NotExists / HavingCount node anywhere (Shape 'Path')?
 *
 * @param {any} pPred
 * @return {boolean}
 */
const hasExistence = (pPred) =>
{
	if ((typeof(pPred) !== 'object') || (pPred === null))
	{
		return false;
	}
	for (let i = 0; i < EXISTENCE_KINDS.length; i++)
	{
		if ((typeof(pPred[EXISTENCE_KINDS[i]]) === 'object') && (pPred[EXISTENCE_KINDS[i]] !== null))
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
 * Every entity the existence nodes of a Pred read (each step's target, the parent of a
 * CheckParent co-reference), sorted, unique.
 *
 * @param {any} pPred
 * @return {Array<string>}
 */
const entitiesOf = (pPred) =>
{
	let tmpEntities = {};
	let fWalk = (pNode) =>
	{
		if ((typeof(pNode) !== 'object') || (pNode === null))
		{
			return;
		}
		if (Array.isArray(pNode))
		{
			pNode.forEach(fWalk);
			return;
		}
		for (let i = 0; i < EXISTENCE_KINDS.length; i++)
		{
			let tmpBody = pNode[EXISTENCE_KINDS[i]];
			if ((typeof(tmpBody) !== 'object') || (tmpBody === null))
			{
				continue;
			}
			let tmpSteps = (tmpBody.Path && Array.isArray(tmpBody.Path.Steps)) ? tmpBody.Path.Steps : [];
			tmpSteps.forEach(
				(pStep) =>
				{
					if (typeof(pStep.To) === 'string')
					{
						tmpEntities[pStep.To] = true;
					}
					if ((pStep.CheckParent === true) && (typeof(pStep.Parent) === 'string'))
					{
						tmpEntities[pStep.Parent] = true;
					}
					fWalk(pStep.Where);
				});
			fWalk(tmpBody.Where);
		}
		fWalk(pNode.And);
		fWalk(pNode.Or);
	};
	fWalk(pPred);
	return Object.keys(tmpEntities).sort();
};

/**
 * Combine two-or-more preds under one boolean node, flattening children of the same kind.
 *
 * @param {string} pKind - 'And' | 'Or'
 * @param {Array<Record<string, any>>} pPreds
 * @return {Record<string, any>} the node (or the single pred when there is only one)
 */
const combine = (pKind, pPreds) =>
{
	let tmpChildren = [];
	for (let i = 0; i < pPreds.length; i++)
	{
		let tmpPred = pPreds[i];
		if ((typeof(tmpPred) === 'object') && (tmpPred !== null) && Array.isArray(tmpPred[pKind]))
		{
			for (let j = 0; j < tmpPred[pKind].length; j++)
			{
				tmpChildren.push(tmpPred[pKind][j]);
			}
		}
		else
		{
			tmpChildren.push(tmpPred);
		}
	}
	if (tmpChildren.length === 1)
	{
		return tmpChildren[0];
	}
	let tmpNode = {};
	tmpNode[pKind] = tmpChildren;
	return tmpNode;
};

/**
 * Split a connector-tagged term sequence into OR-branches (SQL precedence).  The first term's
 * connector is ignored.
 *
 * @param {Array<{ Connector: string, Pred: Record<string, any> }>} pTerms
 * @return {Array<Array<Record<string, any>>>} branches of preds
 */
const branches = (pTerms) =>
{
	let tmpBranches = [];
	let tmpCurrent = [];
	for (let i = 0; i < pTerms.length; i++)
	{
		if ((i > 0) && (pTerms[i].Connector === 'OR'))
		{
			tmpBranches.push(tmpCurrent);
			tmpCurrent = [];
		}
		tmpCurrent.push(pTerms[i].Pred);
	}
	if (tmpCurrent.length > 0)
	{
		tmpBranches.push(tmpCurrent);
	}
	return tmpBranches;
};

/**
 * The single Pred of a branch set: Or of (And of each branch).
 *
 * @param {Array<Array<Record<string, any>>>} pBranches
 * @return {Record<string, any>}
 */
const branchesToPred = (pBranches) =>
{
	let tmpBranchPreds = [];
	for (let i = 0; i < pBranches.length; i++)
	{
		tmpBranchPreds.push(combine('And', pBranches[i]));
	}
	return combine('Or', tmpBranchPreds);
};

class RetoldFacetingFilterAST extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingFilterAST';
	}

	/**
	 * A sibling service (found through fable only).
	 *
	 * @param {string} pServiceType
	 * @return {any}
	 */
	_service(pServiceType)
	{
		let tmpService = this.fable[pServiceType];
		if (!tmpService)
		{
			throw libFacetErrors.create('FACET_INTERNAL', `RetoldFacetingFilterAST needs the ${pServiceType} service.`);
		}
		return tmpService;
	}

	/**
	 * Does a pred reference the entity's delete column?
	 *
	 * @param {string} pEntity
	 * @param {Array<string>} pFields
	 * @return {boolean}
	 */
	namesDeleted(pEntity, pFields)
	{
		let tmpCatalog = this.fable.RetoldFacetingCatalog;
		if (!tmpCatalog || (typeof(tmpCatalog.column) !== 'function'))
		{
			return false;
		}
		for (let i = 0; i < pFields.length; i++)
		{
			let tmpColumn = tmpCatalog.column(pEntity, pFields[i]);
			if (tmpColumn && (tmpColumn.IsDeleteColumn === true))
			{
				return true;
			}
		}
		return false;
	}

	/**
	 * Build a conjunct (without an Id) around a Pred.
	 *
	 * pExtra (M2, internal-contracts §23.1): Fields (ownership fields, default: the Pred's column
	 * fields), Entities (non-root entities it reads), Binds (tokens it bound), Shape (default 'Path'
	 * when the Pred holds an existence node, else 'Column'), Scope / Params (Scope origins only).
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pPred
	 * @param {Record<string, any>} pOrigin
	 * @param {boolean} pNeverExclude
	 * @param {Record<string, any>} [pExtra]
	 * @return {Record<string, any>}
	 */
	newConjunct(pEntity, pPred, pOrigin, pNeverExclude, pExtra)
	{
		let tmpExtra = ((typeof(pExtra) === 'object') && (pExtra !== null)) ? pExtra : {};
		let tmpFields = Array.isArray(tmpExtra.Fields) ? tmpExtra.Fields.slice() : this.fieldsOf(pPred);
		let tmpOrigin =
			{
				Kind: pOrigin.Kind,
				Hash: (typeof(pOrigin.Hash) === 'string') ? pOrigin.Hash : null,
				FilterKey: (typeof(pOrigin.FilterKey) === 'string') ? pOrigin.FilterKey : null,
				ClauseType: (typeof(pOrigin.ClauseType) === 'string') ? pOrigin.ClauseType : null,
				Index: (typeof(pOrigin.Index) === 'number') ? pOrigin.Index : 0
			};
		if (pOrigin.Kind === 'Scope')
		{
			tmpOrigin.Scope = pOrigin.Scope;
			tmpOrigin.Params = pOrigin.Params;
		}
		return (
			{
				Id: null,
				Origin: tmpOrigin,
				Fields: tmpFields,
				NeverExclude: (pNeverExclude === true),
				Fence: true,
				// Pseudo-fields ('@scope:…', '@path:…') never name a column of the route entity.
				NamesDeleted: this.namesDeleted(pEntity, tmpFields.filter((pField) => { return pField.charAt(0) !== '@'; })),
				Pred: pPred,
				Shape: ((tmpExtra.Shape === 'Path') || (tmpExtra.Shape === 'Column')) ? tmpExtra.Shape : (hasExistence(pPred) ? 'Path' : 'Column'),
				Binds: Array.isArray(tmpExtra.Binds) ? tmpExtra.Binds.slice() : [],
				Entities: Array.isArray(tmpExtra.Entities) ? tmpExtra.Entities.slice() : []
			});
	}

	/**
	 * Is a conjunct Path-shaped (its Pred holds an Exists / NotExists / HavingCount node)?
	 *
	 * @param {Record<string, any>} pConjunct
	 * @return {boolean}
	 */
	isPathConjunct(pConjunct)
	{
		if (!pConjunct)
		{
			return false;
		}
		return (pConjunct.Shape === 'Path') || hasExistence(pConjunct.Pred);
	}

	/**
	 * The conjunct (no Id) for one named scope (a request Scopes entry or a NamedScope clause)
	 * (internal-contracts §23.4):
	 *   registry.scope(Scope): unknown, disabled or another entity's → 400 FACET_UNKNOWN_SCOPE { Scope };
	 *   Supported: false → 422 FACET_FOLD_UNSUPPORTED (its Unsupported Detail);
	 *   every entity it reads passes the gate (pInput.CanFacet) BEFORE anything else is validated → 403;
	 *   Params validated against the scope's schema (400 FACET_PARAM_INVALID);
	 *   Pred = Binder.bind(scope.Where) (401 when a principal value is unset).
	 * Fields [ '@scope:<Scope>' ] (owned by no facet), NeverExclude, Shape by its Pred.
	 *
	 * @param {string} pEntity - the route entity
	 * @param {{ Scope: any, Params?: any }} pScopeRef
	 * @param {{ Hash?: string|null, ClauseType?: string|null, Index?: number }} pOrigin
	 * @param {{ Bind?: Record<string, any>|null, CanFacet?: ((pEntity: string) => boolean)|null }} pInput
	 * @return {Record<string, any>}
	 */
	scopeConjunct(pEntity, pScopeRef, pOrigin, pInput)
	{
		let tmpInput = ((typeof(pInput) === 'object') && (pInput !== null)) ? pInput : {};
		let tmpName = ((typeof(pScopeRef) === 'object') && (pScopeRef !== null) && (typeof(pScopeRef.Scope) === 'string')) ? pScopeRef.Scope : null;
		let tmpRegistry = this.fable.RetoldFacetingDefinitionRegistry;
		let tmpScope = (tmpName && tmpRegistry && (typeof(tmpRegistry.scope) === 'function')) ? tmpRegistry.scope(tmpName) : null;
		if (!tmpScope || (tmpScope.Entity !== pEntity))
		{
			// Unknown, disabled and wrong-entity scopes get the same answer.
			throw libFacetErrors.create('FACET_UNKNOWN_SCOPE', null, { Scope: (typeof(tmpName) === 'string') ? tmpName.substring(0, 128) : null });
		}
		// The gate comes first: nothing about an entity the principal cannot read is validated or
		// revealed — not even which features the scope uses (Supported is checked after it).  The
		// registry's list, plus every entity the canonical Where walks (defense in depth).
		let tmpEntities = Array.isArray(tmpScope.Entities) ? tmpScope.Entities.slice() : [ pEntity ];
		entitiesOf(tmpScope.Where).forEach((pTarget) => { if (tmpEntities.indexOf(pTarget) < 0) { tmpEntities.push(pTarget); } });
		if (typeof(tmpInput.CanFacet) === 'function')
		{
			for (let i = 0; i < tmpEntities.length; i++)
			{
				if (tmpInput.CanFacet(tmpEntities[i]) !== true)
				{
					throw libFacetErrors.create('FACET_FORBIDDEN');
				}
			}
		}
		if (tmpScope.Supported === false)
		{
			let tmpUnsupported = ((typeof(tmpScope.Unsupported) === 'object') && (tmpScope.Unsupported !== null)) ? tmpScope.Unsupported : {};
			throw libFacetErrors.create('FACET_FOLD_UNSUPPORTED', null, { Feature: tmpUnsupported.Feature || 'Scope', Milestone: 2 });
		}
		let tmpBinder = this._service('RetoldFacetingBinder');
		let tmpParams = tmpBinder.validateParams(tmpScope.Params || {}, pScopeRef.Params, { Scope: tmpScope.Scope });
		if (!tmpInput.Bind)
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'A named scope needs the request BindContext (FilterAST.build pInput.Bind).');
		}
		let tmpPred = tmpBinder.bind(tmpScope.Where, tmpInput.Bind, tmpParams, { Entity: pEntity, Owner: tmpScope.Scope, OwnerKind: 'Scope' });
		if (!tmpPred)
		{
			// An empty scope Where would be "every row": refuse rather than widen.
			throw libFacetErrors.create('FACET_INTERNAL', 'A named scope has no Where.');
		}
		let tmpOrigin = ((typeof(pOrigin) === 'object') && (pOrigin !== null)) ? pOrigin : {};
		return this.newConjunct(pEntity, tmpPred,
			{
				Kind: 'Scope',
				Hash: (typeof(tmpOrigin.Hash) === 'string') ? tmpOrigin.Hash : null,
				FilterKey: null,
				ClauseType: (typeof(tmpOrigin.ClauseType) === 'string') ? tmpOrigin.ClauseType : null,
				Index: (typeof(tmpOrigin.Index) === 'number') ? tmpOrigin.Index : 0,
				Scope: tmpScope.Scope,
				Params: tmpParams
			}, true,
			{
				Fields: [ `@scope:${tmpScope.Scope}` ],
				Binds: tmpBinder.tokensOf(tmpScope.Where),
				Entities: tmpEntities.filter((pTarget) => { return pTarget !== pEntity; }).sort()
			});
	}

	/**
	 * The Pred for one validated value stanza.
	 *
	 * @param {Record<string, any>} pStanza
	 * @return {Record<string, any>}
	 */
	_stanzaPred(pStanza)
	{
		let tmpOp = libFacetUtil.hasOwn(libFacetRequest.FILTER_OPERATOR_MAP, pStanza.Operator) ? libFacetRequest.FILTER_OPERATOR_MAP[pStanza.Operator] : null;
		if (!tmpOp)
		{
			throw libFacetErrors.create('FACET_FILTER_INVALID', 'The filter string is invalid.', { Offset: pStanza.Offset, Token: String(pStanza.Operator).substring(0, 16), Reason: 'UnsupportedOperator' });
		}
		if ((tmpOp === 'NULL') || (tmpOp === 'NOTNULL'))
		{
			return { Field: pStanza.Field, Op: tmpOp };
		}
		if (LIST_INSTRUCTIONS.indexOf(pStanza.Instruction) >= 0)
		{
			let tmpValues = Array.isArray(pStanza.Values) ? pStanza.Values.slice() : String(pStanza.Value).split(',');
			return { Field: pStanza.Field, Op: tmpOp, Value: tmpValues };
		}
		return { Field: pStanza.Field, Op: tmpOp, Value: pStanza.Value };
	}

	/**
	 * Scan stanzas into depth-0 terms: { Connector, Pred, Index }.  A group's Pred is the
	 * precedence-combined Pred of its member stanzas.  (Public: the ClauseCompiler splices a
	 * RawFilter's terms into the clause sequence exactly where pict's filter string puts them.)
	 *
	 * @param {Array<Record<string, any>>} pStanzas
	 * @return {Array<{ Connector: string, Pred: Record<string, any>, Index: number }>}
	 */
	terms(pStanzas)
	{
		return this._terms(pStanzas);
	}

	/**
	 * @param {Array<Record<string, any>>} pStanzas
	 * @return {Array<{ Connector: string, Pred: Record<string, any>, Index: number }>}
	 */
	_terms(pStanzas)
	{
		let tmpTerms = [];
		let i = 0;
		while (i < pStanzas.length)
		{
			let tmpStanza = pStanzas[i];
			let tmpConnector = (OR_INSTRUCTIONS.indexOf(tmpStanza.Instruction) >= 0) ? 'OR' : 'AND';
			if (OPEN_INSTRUCTIONS.indexOf(tmpStanza.Instruction) >= 0)
			{
				let tmpInner = [];
				let j = i + 1;
				while ((j < pStanzas.length) && (pStanzas[j].Instruction !== 'FCP'))
				{
					if (OPEN_INSTRUCTIONS.indexOf(pStanzas[j].Instruction) >= 0)
					{
						throw libFacetErrors.create('FACET_FILTER_INVALID', 'The filter string is invalid.', { Offset: pStanzas[j].Offset, Token: pStanzas[j].Instruction, Reason: 'NestedGroup' });
					}
					tmpInner.push({ Connector: (OR_INSTRUCTIONS.indexOf(pStanzas[j].Instruction) >= 0) ? 'OR' : 'AND', Pred: this._stanzaPred(pStanzas[j]) });
					j++;
				}
				if ((j >= pStanzas.length) || (tmpInner.length < 1))
				{
					throw libFacetErrors.create('FACET_FILTER_INVALID', 'The filter string is invalid.', { Offset: tmpStanza.Offset, Token: tmpStanza.Instruction, Reason: (tmpInner.length < 1) ? 'EmptyGroup' : 'UnbalancedParens' });
				}
				tmpTerms.push({ Connector: tmpConnector, Pred: branchesToPred(branches(tmpInner)), Index: tmpTerms.length });
				i = j + 1;
				continue;
			}
			if (tmpStanza.Instruction === 'FCP')
			{
				throw libFacetErrors.create('FACET_FILTER_INVALID', 'The filter string is invalid.', { Offset: tmpStanza.Offset, Token: 'FCP', Reason: 'UnbalancedParens' });
			}
			tmpTerms.push({ Connector: tmpConnector, Pred: this._stanzaPred(tmpStanza), Index: tmpTerms.length });
			i++;
		}
		return tmpTerms;
	}

	/**
	 * Build conjuncts from validated meadow-filter stanzas with SQL precedence (§4.4).
	 *
	 * @param {string} pEntity
	 * @param {Array<Record<string, any>>} pStanzas - FilterValidator.validate(...).Stanzas
	 * @param {{ Kind: string, Hash?: string|null, FilterKey?: string|null, ClauseType?: string|null, Index?: number }} pOrigin
	 * @return {Array<Record<string, any>>} conjuncts without Ids
	 */
	fromStanzas(pEntity, pStanzas, pOrigin)
	{
		let tmpOrigin = Object.assign({ Kind: 'String', Hash: null, FilterKey: null, ClauseType: null }, pOrigin || {});
		let tmpNeverExclude = (tmpOrigin.Kind === 'RawFilter');
		let tmpTerms = this._terms(Array.isArray(pStanzas) ? pStanzas : []);
		if (tmpTerms.length < 1)
		{
			return [];
		}
		let tmpBranches = branches(tmpTerms);
		let tmpConjuncts = [];
		if (tmpBranches.length > 1)
		{
			// (t1 AND … AND tk) OR …: the whole string is ONE conjunct; nothing is peeled off.
			tmpConjuncts.push(this.newConjunct(pEntity, branchesToPred(tmpBranches), Object.assign({}, tmpOrigin, { Index: (typeof(tmpOrigin.Index) === 'number') ? tmpOrigin.Index : 0 }), tmpNeverExclude));
			return tmpConjuncts;
		}
		for (let i = 0; i < tmpTerms.length; i++)
		{
			let tmpTermOrigin = Object.assign({}, tmpOrigin, { Index: (tmpOrigin.Kind === 'String') ? tmpTerms[i].Index : ((typeof(tmpOrigin.Index) === 'number') ? tmpOrigin.Index : 0) });
			tmpConjuncts.push(this.newConjunct(pEntity, tmpTerms[i].Pred, tmpTermOrigin, tmpNeverExclude));
		}
		return tmpConjuncts;
	}

	/**
	 * Build the FilterAST for a normalized request: Clauses (array order; a NamedScope clause at its
	 * own index), then FilterString terms, then the request Scopes (array order); assigns Ids
	 * c1..cn, Fields, NamesDeleted, IncludesDeleted, Applied, Warnings (§4.3), and (M2, §23.3)
	 * Shape / Binds / Entities per conjunct and the FilterAST's Entities.  Bodies without scopes or
	 * join clauses produce exactly the M1 conjuncts and Ids.
	 *
	 * Reads ONLY pInput.Clauses, pInput.FilterString, pInput.Scopes, pInput.Bind (the request
	 * BindContext; required when a scope or join clause is present) and pInput.CanFacet (the
	 * per-entity gate for every entity the filter reads, internal-contracts §19.6; null = allow).
	 *
	 * @param {string} pEntity
	 * @param {{ Clauses?: Array<Record<string, any>>, FilterString?: string|null, Scopes?: Array<{ Scope: string, Params?: Record<string, any> }>|null, Bind?: Record<string, any>|null, CanFacet?: ((pEntity: string) => boolean)|null }} pInput
	 * @return {Record<string, any>} FilterAST
	 */
	build(pEntity, pInput)
	{
		let tmpInput = ((typeof(pInput) === 'object') && (pInput !== null)) ? pInput : {};
		let tmpWarnings = [];
		let tmpConjuncts = [];

		let tmpClauses = Array.isArray(tmpInput.Clauses) ? tmpInput.Clauses : [];
		if ((tmpInput.Clauses !== null) && (typeof(tmpInput.Clauses) !== 'undefined') && !Array.isArray(tmpInput.Clauses))
		{
			// Fail closed: a filter input that cannot be read is never an unfiltered answer.
			throw libFacetErrors.create('FACET_FILTER_INVALID', 'Clauses must be an array.', { ClauseType: null, Reason: 'ClausesNotArray' });
		}
		let tmpScopes = Array.isArray(tmpInput.Scopes) ? tmpInput.Scopes : [];
		if ((tmpInput.Scopes !== null) && (typeof(tmpInput.Scopes) !== 'undefined') && !Array.isArray(tmpInput.Scopes))
		{
			throw libFacetErrors.create('FACET_REQUEST_INVALID', 'Scopes must be an array.', { Field: 'Scopes' });
		}
		let tmpScopeCount = tmpScopes.length;
		for (let i = 0; i < tmpClauses.length; i++)
		{
			if (tmpClauses[i] && (tmpClauses[i].Type === 'NamedScope') && (tmpClauses[i].Enabled !== false))
			{
				tmpScopeCount++;
			}
		}
		let tmpMaxScopes = (this.options.Limits && (typeof(this.options.Limits.MaxScopesPerRequest) === 'number')) ? this.options.Limits.MaxScopesPerRequest : 16;
		if (tmpScopeCount > tmpMaxScopes)
		{
			throw libFacetErrors.create('FACET_TOO_LARGE', null, { Limit: 'MaxScopesPerRequest', Max: tmpMaxScopes });
		}
		let tmpCompileOptions = { Bind: tmpInput.Bind || null, CanFacet: (typeof(tmpInput.CanFacet) === 'function') ? tmpInput.CanFacet : null };
		if (tmpClauses.length > 0)
		{
			let tmpCompiled = this._service('RetoldFacetingClauseCompiler').compile(pEntity, tmpClauses, tmpCompileOptions);
			tmpConjuncts = tmpConjuncts.concat(tmpCompiled.Conjuncts);
			tmpWarnings = tmpWarnings.concat(tmpCompiled.Warnings || []);
		}

		if ((typeof(tmpInput.FilterString) === 'string') && (tmpInput.FilterString.length > 0))
		{
			let tmpValidated = this._service('RetoldFacetingFilterValidator').validate(pEntity, tmpInput.FilterString, { AllowDeleteColumn: true });
			tmpWarnings = tmpWarnings.concat(tmpValidated.Warnings || []);
			tmpConjuncts = tmpConjuncts.concat(this.fromStanzas(pEntity, tmpValidated.Stanzas, { Kind: 'String', Hash: null, FilterKey: null, ClauseType: null }));
		}
		else if ((tmpInput.FilterString !== null) && (typeof(tmpInput.FilterString) !== 'undefined') && (tmpInput.FilterString !== ''))
		{
			throw libFacetErrors.create('FACET_FILTER_INVALID', 'The filter string must be a string.', { Offset: 0, Token: 'FilterString', Reason: 'NotAString' });
		}

		// Request Scopes come last, in array order (internal-contracts §23.3).
		for (let i = 0; i < tmpScopes.length; i++)
		{
			let tmpScopeRef = tmpScopes[i];
			if ((typeof(tmpScopeRef) !== 'object') || (tmpScopeRef === null) || Array.isArray(tmpScopeRef))
			{
				throw libFacetErrors.create('FACET_UNKNOWN_SCOPE', null, { Scope: null });
			}
			tmpConjuncts.push(this.scopeConjunct(pEntity, tmpScopeRef, { Hash: null, ClauseType: null, Index: i }, tmpCompileOptions));
		}

		let tmpIncludesDeleted = false;
		let tmpApplied = [];
		let tmpStringApplied = false;
		let tmpEntities = [];
		for (let i = 0; i < tmpConjuncts.length; i++)
		{
			let tmpConjunct = tmpConjuncts[i];
			tmpConjunct.Id = 'c' + (i + 1);
			if (tmpConjunct.NamesDeleted)
			{
				tmpIncludesDeleted = true;
			}
			(Array.isArray(tmpConjunct.Entities) ? tmpConjunct.Entities : []).forEach((pTarget) => { if ((pTarget !== pEntity) && (tmpEntities.indexOf(pTarget) < 0)) { tmpEntities.push(pTarget); } });
			switch (tmpConjunct.Origin.Kind)
			{
				case 'String':
					if (!tmpStringApplied)
					{
						tmpApplied.push({ String: true });
						tmpStringApplied = true;
					}
					break;
				case 'Scope':
					tmpApplied.push({ Scope: tmpConjunct.Origin.Scope });
					break;
				default:
				{
					// One entry per contributing clause (an OR-merged conjunct lists every member, each
					// RawFilter member as { RawFilter }).
					let tmpHashes = Array.isArray(tmpConjunct.Origin.Hashes) ? tmpConjunct.Origin.Hashes : [ tmpConjunct.Origin.Hash ];
					let tmpIndexes = Array.isArray(tmpConjunct.Origin.Indexes) ? tmpConjunct.Origin.Indexes : [ tmpConjunct.Origin.Index ];
					let tmpKinds = Array.isArray(tmpConjunct.Origin.Kinds) ? tmpConjunct.Origin.Kinds : [ tmpConjunct.Origin.Kind ];
					for (let j = 0; j < tmpHashes.length; j++)
					{
						if (tmpKinds[j] === 'RawFilter')
						{
							tmpApplied.push({ RawFilter: (tmpHashes[j] !== null) ? tmpHashes[j] : tmpIndexes[j] });
							continue;
						}
						tmpApplied.push((tmpHashes[j] !== null) ? { Hash: tmpHashes[j] } : { Hash: null, Index: tmpIndexes[j] });
					}
					break;
				}
			}
		}

		// One warning per distinct (Code, Detail).
		let tmpSeen = new Set();
		let tmpUniqueWarnings = [];
		for (let i = 0; i < tmpWarnings.length; i++)
		{
			let tmpSignature = tmpWarnings[i].Code + '|' + JSON.stringify(tmpWarnings[i].Detail);
			if (!tmpSeen.has(tmpSignature))
			{
				tmpSeen.add(tmpSignature);
				tmpUniqueWarnings.push(tmpWarnings[i]);
			}
		}

		return (
			{
				Entity: pEntity,
				Conjuncts: tmpConjuncts,
				IncludesDeleted: tmpIncludesDeleted,
				Applied: tmpApplied,
				Warnings: tmpUniqueWarnings,
				Entities: tmpEntities.sort()
			});
	}

	/**
	 * The parameter name stem for a conjunct's leaves: '<Prefix><n>_<Field>' (FoxHound appends
	 * '_w<i>').  n is the conjunct's Id number (c3 → 3), else its 1-based position.
	 * ParameterPrefix '' means the bare Field (so MSSQL's Parameter→schema type lookup works).
	 *
	 * @param {Record<string, any>} pConjunct
	 * @param {number} pPosition
	 * @param {string} pPrefix
	 * @param {string} pField
	 * @return {string}
	 */
	_parameterName(pConjunct, pPosition, pPrefix, pField)
	{
		if (pPrefix === '')
		{
			return pField;
		}
		let tmpNumber = pPosition + 1;
		if ((typeof(pConjunct.Id) === 'string') && /^c[0-9]+$/.test(pConjunct.Id))
		{
			tmpNumber = parseInt(pConjunct.Id.substring(1), 10);
		}
		return `${pPrefix}${tmpNumber}_${pField}`;
	}

	/**
	 * Append the FoxHound entries for one Pred.
	 *
	 * @param {Record<string, any>} pPred
	 * @param {any} pQuery
	 * @param {string} pConnector - connector of the first entry this Pred appends
	 * @param {(pField: string) => string} fParameter - Field → parameter name
	 * @param {boolean} pSQLiteNull - render NULL as `IS :p` with a NULL bind (FH-2)
	 */
	_applyPred(pPred, pQuery, pConnector, fParameter, pSQLiteNull)
	{
		if ((typeof(pPred) !== 'object') || (pPred === null))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'FilterAST: malformed predicate.');
		}
		let tmpKind = Array.isArray(pPred.And) ? 'And' : Array.isArray(pPred.Or) ? 'Or' : null;
		if (tmpKind)
		{
			let tmpChildren = pPred[tmpKind];
			if (tmpChildren.length < 1)
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'FilterAST: empty boolean node.');
			}
			let tmpInnerConnector = (tmpKind === 'Or') ? 'OR' : 'AND';
			pQuery.addFilter('', '', '(', pConnector);
			for (let i = 0; i < tmpChildren.length; i++)
			{
				this._applyPred(tmpChildren[i], pQuery, (i === 0) ? 'AND' : tmpInnerConnector, fParameter, pSQLiteNull);
			}
			pQuery.addFilter('', '', ')');
			return;
		}

		if ((typeof(pPred.Field) !== 'string') || !libFacetRequest.IDENTIFIER_PATTERN.test(pPred.Field) || (libFacetRequest.PRED_OPS.indexOf(pPred.Op) < 0))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'FilterAST: malformed predicate leaf.');
		}
		let tmpParameter = fParameter(pPred.Field);
		// A leaf FoxHound would silently drop (an undefined value) must never reach it: that would
		// widen the filter.  Values are scalars; booleans bind as 0 / 1.
		let fBindable = (pValue) =>
		{
			if (typeof(pValue) === 'boolean')
			{
				return pValue ? 1 : 0;
			}
			if ((typeof(pValue) === 'string') || ((typeof(pValue) === 'number') && isFinite(pValue)))
			{
				return pValue;
			}
			throw libFacetErrors.create('FACET_INTERNAL', 'FilterAST: a predicate value is not bindable.');
		};
		switch (pPred.Op)
		{
			case 'NULL':
				if (pSQLiteNull)
				{
					// FH-2: the SQLite dialect has no IS NULL branch; `"C" IS :p` with a NULL bind is IS NULL.
					pQuery.addFilter(pPred.Field, null, 'IS', pConnector, tmpParameter);
				}
				else
				{
					pQuery.addFilter(pPred.Field, '', 'IS NULL', pConnector, tmpParameter);
				}
				return;
			case 'NOTNULL':
				pQuery.addFilter(pPred.Field, '', 'IS NOT NULL', pConnector, tmpParameter);
				return;
			case 'IN':
			case 'NIN':
				if (!Array.isArray(pPred.Value) || (pPred.Value.length < 1))
				{
					throw libFacetErrors.create('FACET_INTERNAL', 'FilterAST: IN predicate without values.');
				}
				pQuery.addFilter(pPred.Field, pPred.Value.map(fBindable), FOXHOUND_OPERATORS[pPred.Op], pConnector, tmpParameter);
				return;
			default:
				pQuery.addFilter(pPred.Field, fBindable(pPred.Value), FOXHOUND_OPERATORS[pPred.Op], pConnector, tmpParameter);
				return;
		}
	}

	/**
	 * Append FoxHound filter entries for the conjuncts (ANDed, no fence) (§4.5).
	 *
	 * @param {Array<Record<string, any>>} pConjuncts
	 * @param {any} pQuery - a FoxHound query (DAL.query)
	 * @param {{ Dialect: string, ParameterPrefix?: string }} pOptions
	 * @return {any} pQuery
	 */
	applyToQuery(pConjuncts, pQuery, pOptions)
	{
		let tmpOptions = ((typeof(pOptions) === 'object') && (pOptions !== null)) ? pOptions : {};
		if ((typeof(tmpOptions.Dialect) !== 'string') || (tmpOptions.Dialect.length < 1))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'FilterAST.applyToQuery needs pOptions.Dialect (NULL rendering is dialect-specific).');
		}
		if (!pQuery || (typeof(pQuery.addFilter) !== 'function'))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'FilterAST.applyToQuery needs a FoxHound query.');
		}
		let tmpPrefix = (typeof(tmpOptions.ParameterPrefix) === 'string') ? tmpOptions.ParameterPrefix : 'c';
		if ((tmpPrefix !== '') && !/^[A-Za-z][A-Za-z0-9]{0,15}$/.test(tmpPrefix))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'FilterAST.applyToQuery: illegal ParameterPrefix.');
		}
		let tmpSQLiteNull = (tmpOptions.Dialect === 'SQLite');
		let tmpConjuncts = Array.isArray(pConjuncts) ? pConjuncts : [];
		for (let i = 0; i < tmpConjuncts.length; i++)
		{
			if (this.isPathConjunct(tmpConjuncts[i]))
			{
				// Path-shaped conjuncts are FoldPreds (Variant.PathPred), never FoxHound filter entries:
				// reaching here is a wiring bug (internal-contracts §23.6).
				throw libFacetErrors.create('FACET_INTERNAL', 'FilterAST.applyToQuery cannot render a Path-shaped conjunct.');
			}
		}
		for (let i = 0; i < tmpConjuncts.length; i++)
		{
			let tmpConjunct = tmpConjuncts[i];
			let fParameter = (pField) =>
			{
				return this._parameterName(tmpConjunct, i, tmpPrefix, pField);
			};
			this._applyPred(tmpConjunct.Pred, pQuery, 'AND', fParameter, tmpSQLiteNull);
		}
		return pQuery;
	}

	/**
	 * Render one value for a meadow-filter string.
	 *
	 * @param {any} pValue
	 * @param {boolean} pEncode
	 * @param {boolean} pInList - list items may not contain ','
	 * @return {string}
	 */
	_filterStringValue(pValue, pEncode, pInList)
	{
		if ((pValue === null) || (typeof(pValue) === 'undefined') || (typeof(pValue) === 'object'))
		{
			throw libFacetErrors.create('FACET_FILTER_INVALID', 'A filter value cannot be rendered as a filter string.', { Reason: 'NonScalarValue' });
		}
		let tmpValue = (typeof(pValue) === 'boolean') ? (pValue ? '1' : '0') : String(pValue);
		if (tmpValue.indexOf('~') >= 0)
		{
			throw libFacetErrors.create('FACET_FILTER_INVALID', 'A filter value containing "~" cannot be rendered as a filter string.', { Reason: 'TildeInValue' });
		}
		if (pInList && (tmpValue.indexOf(',') >= 0))
		{
			throw libFacetErrors.create('FACET_FILTER_INVALID', 'A list value containing "," cannot be rendered as a filter string.', { Reason: 'CommaInListValue' });
		}
		return pEncode ? encodeURIComponent(tmpValue) : tmpValue;
	}

	/**
	 * Rewrite a Pred into a form meadow-filter can carry: an IN / NIN leaf holding an empty-string
	 * item (our validator refuses empty FBL list items) or an item with ',' (FBL splits on it)
	 * becomes the equivalent EQ-Or / NE-And.
	 *
	 * @param {Record<string, any>} pPred
	 * @param {boolean} pEncode
	 * @return {Record<string, any>}
	 */
	_stringable(pPred, pEncode)
	{
		let tmpKind = Array.isArray(pPred.And) ? 'And' : Array.isArray(pPred.Or) ? 'Or' : null;
		if (tmpKind)
		{
			return combine(tmpKind, pPred[tmpKind].map((pChild) => { return this._stringable(pChild, pEncode); }));
		}
		if (((pPred.Op === 'IN') || (pPred.Op === 'NIN')) && Array.isArray(pPred.Value))
		{
			let tmpNeedsLeaves = false;
			for (let i = 0; i < pPred.Value.length; i++)
			{
				let tmpText = this._filterStringValue(pPred.Value[i], pEncode, false);
				if ((tmpText.length < 1) || (tmpText.indexOf(',') >= 0))
				{
					tmpNeedsLeaves = true;
				}
			}
			if (tmpNeedsLeaves)
			{
				let tmpLeaves = pPred.Value.map((pValue) => { return { Field: pPred.Field, Op: (pPred.Op === 'IN') ? 'EQ' : 'NE', Value: pValue }; });
				return combine((pPred.Op === 'IN') ? 'Or' : 'And', tmpLeaves);
			}
		}
		return pPred;
	}

	/**
	 * Flatten a Pred into items joined with SQL precedence inside an enclosing group:
	 * an Or's members are OR-joined (an And member's terms stay AND-joined — AND binds tighter);
	 * an And's members are AND-joined, and an Or member needs its own group.
	 *
	 * @param {Record<string, any>} pPred
	 * @return {Array<{ Or: boolean, Leaf?: Record<string, any>, Group?: Record<string, any> }>}
	 */
	_flatItems(pPred)
	{
		if (Array.isArray(pPred.Or))
		{
			let tmpItems = [];
			for (let i = 0; i < pPred.Or.length; i++)
			{
				let tmpChild = pPred.Or[i];
				let tmpChildItems = (Array.isArray(tmpChild.Or) || Array.isArray(tmpChild.And)) ? this._flatItems(tmpChild) : [ { Or: false, Leaf: tmpChild } ];
				tmpChildItems[0].Or = (i > 0);
				tmpItems = tmpItems.concat(tmpChildItems);
			}
			return tmpItems;
		}
		if (Array.isArray(pPred.And))
		{
			let tmpItems = [];
			for (let i = 0; i < pPred.And.length; i++)
			{
				let tmpChild = pPred.And[i];
				if (Array.isArray(tmpChild.Or))
				{
					tmpItems.push({ Or: false, Group: tmpChild });
				}
				else if (Array.isArray(tmpChild.And))
				{
					tmpItems = tmpItems.concat(this._flatItems(tmpChild).map((pItem) => { pItem.Or = false; return pItem; }));
				}
				else
				{
					tmpItems.push({ Or: false, Leaf: tmpChild });
				}
			}
			return tmpItems;
		}
		return [ { Or: false, Leaf: pPred } ];
	}

	/**
	 * Render flat items as stanzas.
	 *
	 * @param {Array<Record<string, any>>} pItems
	 * @param {boolean} pEncode
	 * @return {Array<string>}
	 */
	_renderItems(pItems, pEncode)
	{
		let tmpParts = [];
		for (let i = 0; i < pItems.length; i++)
		{
			let tmpItem = pItems[i];
			if (tmpItem.Group)
			{
				tmpParts.push(tmpItem.Or ? 'FOPOR~0~(~0' : FENCE_OPEN);
				tmpParts = tmpParts.concat(this._renderItems(this._flatItems(tmpItem.Group), pEncode));
				tmpParts.push(FENCE_CLOSE);
				continue;
			}
			tmpParts.push(this._leafToFilterString(tmpItem.Leaf, tmpItem.Or, pEncode));
		}
		return tmpParts;
	}

	/**
	 * Render one leaf as a meadow-filter stanza.
	 *
	 * @param {Record<string, any>} pLeaf
	 * @param {boolean} pOr - OR-connected to its predecessor?
	 * @param {boolean} pEncode
	 * @return {string}
	 */
	_leafToFilterString(pLeaf, pOr, pEncode)
	{
		let tmpOperator = libFacetUtil.hasOwn(FILTER_STRING_OPERATORS, pLeaf.Op) ? FILTER_STRING_OPERATORS[pLeaf.Op] : null;
		if (!tmpOperator || (typeof(pLeaf.Field) !== 'string') || !libFacetRequest.IDENTIFIER_PATTERN.test(pLeaf.Field))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'FilterAST: malformed predicate leaf.');
		}
		switch (pLeaf.Op)
		{
			case 'NULL':
			case 'NOTNULL':
				return `${pOr ? 'FBVOR' : 'FBV'}~${pLeaf.Field}~${tmpOperator}~0`;
			case 'IN':
			case 'NIN':
			{
				let tmpValues = Array.isArray(pLeaf.Value) ? pLeaf.Value : [ pLeaf.Value ];
				let tmpRendered = tmpValues.map((pValue) => { return this._filterStringValue(pValue, pEncode, true); });
				return `${pOr ? 'FBLOR' : 'FBL'}~${pLeaf.Field}~${tmpOperator}~${tmpRendered.join(',')}`;
			}
			default:
				return `${pOr ? 'FBVOR' : 'FBV'}~${pLeaf.Field}~${tmpOperator}~${this._filterStringValue(pLeaf.Value, pEncode, false)}`;
		}
	}

	/**
	 * Render conjuncts as a FENCED meadow-filter string (for the list oracle) (§4.5).
	 *
	 * Shape: FOP~0~(~0 ~ <conjunct> ~ … ~ FCP~0~)~0, where a leaf conjunct is one stanza and an
	 * And/Or conjunct is its own FOP … FCP group whose members are written flat with SQL
	 * precedence (a nested group only for an Or inside an And).  FilterValidator unwraps the
	 * whole-string fence, so the output is also a valid facet FilterString (Encode: true) for
	 * every conjunct without an Or-inside-And.
	 *
	 * @param {Array<Record<string, any>>} pConjuncts
	 * @param {{ Encode?: boolean }} [pOptions] - Encode: false (default) = the raw decoded string
	 * @return {string} '' when there are no conjuncts
	 */
	toFilterString(pConjuncts, pOptions)
	{
		let tmpConjuncts = Array.isArray(pConjuncts) ? pConjuncts : [];
		if (tmpConjuncts.length < 1)
		{
			return '';
		}
		let tmpEncode = ((typeof(pOptions) === 'object') && (pOptions !== null) && (pOptions.Encode === true));
		for (let i = 0; i < tmpConjuncts.length; i++)
		{
			if (this.isPathConjunct(tmpConjuncts[i]))
			{
				// The stock list syntax cannot carry an existence predicate (internal-contracts §23.6).
				throw libFacetErrors.create('FACET_FILTER_INVALID', 'A path predicate cannot be rendered as a filter string.', { Reason: 'PathConjunct' });
			}
		}
		let tmpItems = [];
		for (let i = 0; i < tmpConjuncts.length; i++)
		{
			let tmpPred = this._stringable(tmpConjuncts[i].Pred, tmpEncode);
			if (Array.isArray(tmpPred.And) || Array.isArray(tmpPred.Or))
			{
				tmpItems.push({ Or: false, Group: tmpPred });
			}
			else
			{
				tmpItems.push({ Or: false, Leaf: tmpPred });
			}
		}
		return [ FENCE_OPEN ].concat(this._renderItems(tmpItems, tmpEncode), [ FENCE_CLOSE ]).join('~');
	}

	/**
	 * Every Field referenced in a Pred (sorted, unique).
	 *
	 * @param {Record<string, any>} pPred
	 * @return {Array<string>}
	 */
	fieldsOf(pPred)
	{
		let tmpFields = {};
		let fWalk = (pNode) =>
		{
			if ((typeof(pNode) !== 'object') || (pNode === null))
			{
				return;
			}
			if (typeof(pNode.Field) === 'string')
			{
				tmpFields[pNode.Field] = true;
			}
			let tmpChildren = Array.isArray(pNode.And) ? pNode.And : Array.isArray(pNode.Or) ? pNode.Or : [];
			for (let i = 0; i < tmpChildren.length; i++)
			{
				fWalk(tmpChildren[i]);
			}
		};
		fWalk(pPred);
		return Object.keys(tmpFields).sort();
	}
}

module.exports = RetoldFacetingFilterAST;
module.exports.serviceType = 'RetoldFacetingFilterAST';
module.exports.FOXHOUND_OPERATORS = FOXHOUND_OPERATORS;
module.exports.FILTER_STRING_OPERATORS = FILTER_STRING_OPERATORS;
module.exports.combine = combine;
module.exports.branches = branches;
module.exports.branchesToPred = branchesToPred;
module.exports.EXISTENCE_KINDS = EXISTENCE_KINDS;
module.exports.hasExistence = hasExistence;
module.exports.entitiesOf = entitiesOf;
