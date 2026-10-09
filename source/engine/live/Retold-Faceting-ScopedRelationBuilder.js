/**
 * Retold Faceting - Scoped Relation Builder
 *
 * Renders one entity in isolation, exactly as its list would be rendered for the same
 * principal (03 §3.1–§3.2): a fresh DAL.query, client conjuncts fenced in '(' ')', the
 * definition predicate (Rel.Where) in its own fence, an explicit Deleted = 0 at depth 0 (D-37),
 * the entity's own Reads-QueryConfiguration on the ROUTE-BOUND controller (ScopeCapture +
 * ScopeGuard; 'TenantOnly' hops relax exactly the personal-scope entry), a minimal queryOverride
 * projection, then harvested as SQL text plus parameters renamed '<Alias>_<name>'.
 *
 * Every hop of a cross-entity fold is one of these (M2): each composed only by alias.  The
 * pre-harvest relation is memoized per request by (Entity | ClientIds | Where | Scope | SoftDelete |
 * Project) — the alias is NOT part of the key — and harvested once per alias, so the same hop under
 * two aliases costs one relation and one behavior run.
 *
 * An Opaque capture (a host behavior added a join, replaced the query, …) is refused, except for
 * an entity listed in Scope.TrustedOpaque: a leaf existence hop (Rel.Stage 'Allowed') then comes back
 * unbuilt with NeedsStage: true and the captured query, for RetoldFacetingStagedKeys to run Staged
 * (internal-contracts §26.3).
 *
 * Never FoxHound addJoin; every identifier comes from the schema whitelist; every value binds.
 *
 * Contract: internal-contracts §7 and §26.1.
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

// Relation aliases never start with 'f' (shell parameters are f*) — internal-contracts §7.1.
const ALIAS_PATTERN = /^[a-eg-z][a-z0-9]{0,7}$/;

const PROJECTION_TEMPLATE = 'SELECT <%= _Params.FacetProjection %> FROM<%= TableName %><%= Where %>';

const IDENTIFIER_PATTERN = libFacetRequest.IDENTIFIER_PATTERN;

// The scope modes a Rel may ask for (internal-contracts §24.1).
const SCOPE_MODES = Object.freeze([ 'Inherit', 'TenantOnly' ]);

/**
 * Is a Rel.Where a column-only predicate (M1 Pred shape: { Field, Op, Value } / { And } / { Or })?
 *
 * @param {any} pPred
 * @return {boolean}
 */
const isColumnPred = (pPred) =>
{
	if ((typeof(pPred) !== 'object') || (pPred === null))
	{
		return false;
	}
	if (Array.isArray(pPred.And) || Array.isArray(pPred.Or))
	{
		let tmpItems = pPred.And || pPred.Or;
		return (tmpItems.length > 0) && tmpItems.every(isColumnPred);
	}
	return (typeof(pPred.Field) === 'string') && (typeof(pPred.Op) === 'string');
};

class RetoldFacetingScopedRelationBuilder extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingScopedRelationBuilder';
	}

	/**
	 * The dialect a relation is rendered in: pContext.Dialect (Host.getDialectProfile(Entity).Name,
	 * pinned per request), else the host's profile for the entity.  null when neither knows it (the
	 * caller fails with FACET_INTERNAL: never a guessed dialect).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {string} pEntity
	 * @return {string|null}
	 */
	dialectFor(pContext, pEntity)
	{
		if (pContext && (typeof(pContext.Dialect) === 'string') && (pContext.Dialect.length > 0))
		{
			return pContext.Dialect;
		}
		let tmpHost = pContext ? pContext.Host : null;
		let tmpProfile = (tmpHost && (typeof(tmpHost.getDialectProfile) === 'function')) ? tmpHost.getDialectProfile(pEntity) : null;
		return (tmpProfile && (typeof(tmpProfile.Name) === 'string') && (tmpProfile.Name.length > 0)) ? tmpProfile.Name : null;
	}

	/**
	 * The effective Staged plan form of a request ('Auto' when unset).
	 *
	 * @param {Record<string, any>} pContext
	 * @return {string} 'Auto' | 'Always' | 'Never'
	 */
	stagedForm(pContext)
	{
		let tmpForm = (pContext && pContext.PlanForm) ? pContext.PlanForm.Staged : null;
		return ([ 'Auto', 'Always', 'Never' ].indexOf(tmpForm) >= 0) ? tmpForm : 'Auto';
	}

	/**
	 * Build (or return the memoized) Scoped Relation for pRel.
	 *
	 * @param {Record<string, any>} pContext - internal-contracts §2.2
	 * @param {{ Entity: string, As: string, Project: Array<string>, Client: Array<Record<string, any>>|null, Where: any, Scope: string, ScopeReason?: string, SoftDelete: string, Stage?: string }} pRel
	 * @param {(pError?: Error, pRelation?: { Alias: string, Entity: string, SQL: string, Params: Record<string, any>, ParamTypes: Record<string, any>, Columns: Array<string>, Capture: Record<string, any>, Staged: boolean, NeedsStage?: boolean, Query?: any }) => void} fCallback
	 */
	buildRelation(pContext, pRel, fCallback)
	{
		let tmpContext = pContext || {};
		let tmpOptions = tmpContext.Options || this.options;
		if (!tmpContext.Memo)
		{
			tmpContext.Memo = { Relations: {}, Captures: {}, VariantRows: {} };
		}
		if (!tmpContext.Memo.Relations)
		{
			tmpContext.Memo.Relations = {};
		}
		if (!tmpContext.Counters)
		{
			tmpContext.Counters = { Relations: 0, BehaviorRuns: 0, Statements: 0 };
		}

		// Shape checks (the Planner builds Rels from catalog identifiers; anything else is a bug).
		if (!pRel || (typeof(pRel.Entity) !== 'string') || !IDENTIFIER_PATTERN.test(pRel.Entity))
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'Invalid relation entity.'));
		}
		if ((typeof(pRel.As) !== 'string') || !ALIAS_PATTERN.test(pRel.As))
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'Invalid relation alias.'));
		}
		if (!Array.isArray(pRel.Project) || (pRel.Project.length < 1))
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'A relation needs a projection.'));
		}
		let tmpWhere = ((pRel.Where === null) || (typeof(pRel.Where) === 'undefined')) ? null : pRel.Where;
		if ((tmpWhere !== null) && !isColumnPred(tmpWhere))
		{
			// Path predicates never reach a relation: the Planner lowers them into FoldPred nodes.
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'A relation Where must be a column-only predicate.'));
		}
		let tmpScopeMode = pRel.Scope || 'Inherit';
		if (SCOPE_MODES.indexOf(tmpScopeMode) < 0)
		{
			return fCallback(libFacetErrors.create('FACET_FOLD_UNSUPPORTED', 'This scope mode is not supported.', { Feature: `ScopeMode:${tmpScopeMode}`, Milestone: 2 }));
		}
		if ((tmpScopeMode === 'TenantOnly') && ((typeof(pRel.ScopeReason) !== 'string') || (pRel.ScopeReason.length < 1)))
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'A TenantOnly relation needs its ScopeReason.'));
		}

		let tmpKey = this.relationKey(pRel);
		let tmpAliasKey = `${tmpKey}#${pRel.As}`;
		if (hasOwn(tmpContext.Memo.Relations, tmpAliasKey))
		{
			return fCallback(null, tmpContext.Memo.Relations[tmpAliasKey]);
		}
		let tmpBuiltKey = `built:${tmpKey}`;
		if (hasOwn(tmpContext.Memo.Relations, tmpBuiltKey))
		{
			return this._harvestFor(tmpContext, tmpContext.Memo.Relations[tmpBuiltKey], pRel, tmpAliasKey, fCallback);
		}

		let tmpMaxRelations = (tmpOptions.Limits && (typeof(tmpOptions.Limits.MaxRelationsPerRequest) === 'number')) ? tmpOptions.Limits.MaxRelationsPerRequest : 32;
		if ((tmpContext.Counters.Relations + 1) > tmpMaxRelations)
		{
			return fCallback(libFacetErrors.create('FACET_TOO_LARGE', 'The request needs too many relations.', { Limit: 'MaxRelationsPerRequest' }));
		}

		let tmpHost = tmpContext.Host;
		let tmpDAL = (tmpHost && (typeof(tmpHost.getExecutionDAL) === 'function')) ? tmpHost.getExecutionDAL(pRel.Entity) : null;
		if (!tmpDAL)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The entity has no DAL.'));
		}
		let tmpDialects = this.fable.RetoldFacetingDialects;
		let tmpScopeCapture = this.fable.RetoldFacetingScopeCapture;
		if (!tmpDialects || !tmpScopeCapture)
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The live engine services are not registered.'));
		}
		let tmpDialectName = this.dialectFor(tmpContext, pRel.Entity);
		if (!tmpDialectName || !tmpDialects.forName(tmpDialectName))
		{
			return fCallback(libFacetErrors.create('FACET_INTERNAL', 'Unknown SQL dialect.'));
		}

		tmpContext.Counters.Relations++;

		// 1. A fresh FoxHound clone (Meadow.js: DAL.query clones every access).
		let tmpQuery = tmpDAL.query;
		let tmpProjection;
		try
		{
			// Projection: whitelisted schema columns only (never client text).
			let tmpSchema = Array.isArray(tmpQuery.query.schema) ? tmpQuery.query.schema : [];
			let tmpColumns = {};
			for (let i = 0; i < tmpSchema.length; i++)
			{
				tmpColumns[tmpSchema[i].Column] = true;
			}
			for (let i = 0; i < pRel.Project.length; i++)
			{
				if (!hasOwn(tmpColumns, pRel.Project[i]))
				{
					throw libFacetErrors.create('FACET_INTERNAL', 'A projected column is not in the entity schema.');
				}
			}
			tmpProjection = pRel.Project.map((pColumn) => { return tmpDialects.quote(tmpDialectName, pColumn); }).join(', ');

			let tmpFilterAST = this.fable.RetoldFacetingFilterAST;
			// 2. Client conjuncts, fenced so a client top-level OR can never widen past the scope (F2).
			let tmpClient = Array.isArray(pRel.Client) ? pRel.Client : [];
			if (tmpClient.length > 0)
			{
				if (!tmpFilterAST || (typeof(tmpFilterAST.applyToQuery) !== 'function'))
				{
					throw libFacetErrors.create('FACET_INTERNAL', 'The FilterAST service is not registered.');
				}
				tmpQuery.addFilter('', '', '(', 'AND', 'FacetFenceOpen');
				tmpFilterAST.applyToQuery(tmpClient, tmpQuery, { Dialect: tmpDialectName, ParameterPrefix: 'c' });
				tmpQuery.addFilter('', '', ')', 'AND', 'FacetFenceClose');
			}

			// 2b. The definition predicate (bound, column-only), in its own fence (§26.1 step 2).
			if (tmpWhere !== null)
			{
				if (!tmpFilterAST || (typeof(tmpFilterAST.applyToQuery) !== 'function'))
				{
					throw libFacetErrors.create('FACET_INTERNAL', 'The FilterAST service is not registered.');
				}
				tmpQuery.addFilter('', '', '(', 'AND', 'FacetWhereOpen');
				tmpFilterAST.applyToQuery([ { Id: 'w', Pred: tmpWhere, Shape: 'Column' } ], tmpQuery, { Dialect: tmpDialectName, ParameterPrefix: 'w' });
				tmpQuery.addFilter('', '', ')', 'AND', 'FacetWhereClose');
			}

			// 3. Explicit soft-delete at depth 0, outside the fence (D-37).  FoxHound's implicit
			//    Deleted = 0 switches itself off whenever any entry names the column; this one cannot.
			let tmpClientNamesDeleted = tmpClient.some((pConjunct) => { return pConjunct && (pConjunct.NamesDeleted === true); });
			if ((pRel.SoftDelete !== 'ClientControlled') && !tmpClientNamesDeleted
				&& (typeof(tmpHost.hasDeleteColumn) === 'function') && tmpHost.hasDeleteColumn(pRel.Entity))
			{
				tmpQuery.addFilter(tmpHost.getDeleteColumn(pRel.Entity), 0, '=', 'AND', 'FacetSoftDelete');
			}
		}
		catch (pPrepareError)
		{
			return fCallback(libFacetErrors.isFacetError(pPrepareError) ? pPrepareError : libFacetErrors.create('FACET_INTERNAL'));
		}

		// 4. The entity's own scope, on the route-bound controller, then the guard.
		tmpScopeCapture.capture(tmpContext, pRel.Entity, tmpQuery, tmpScopeMode, { Columns: pRel.Project },
			(pCaptureError, pCapture) =>
			{
				if (pCaptureError)
				{
					return fCallback(pCaptureError);
				}
				if (!pCapture)
				{
					return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The scope capture returned nothing.'));
				}

				// 5. Opaque captures: only a trusted entity's leaf existence hop may run Staged.
				if (pCapture.Opaque)
				{
					let tmpReasons = Array.isArray(pCapture.OpaqueReasons) ? pCapture.OpaqueReasons.join(', ') : 'unknown';
					if (!pCapture.Trusted || (this.stagedForm(tmpContext) === 'Never'))
					{
						this.fable.log.error(`RetoldFaceting refused an opaque scope capture for ${pRel.Entity}: ${tmpReasons}`);
						return fCallback(libFacetErrors.create('FACET_SCOPE_POLICY_VIOLATION', null, { Entity: pRel.Entity, Reason: 'OpaqueUntrusted' }));
					}
					if (pRel.Stage !== 'Allowed')
					{
						this.fable.log.warn(`RetoldFaceting cannot stage the trusted opaque ${pRel.Entity} relation (not a leaf existence hop): ${tmpReasons}`);
						return fCallback(libFacetErrors.create('FACET_FOLD_UNSUPPORTED', 'This relation cannot run Staged.', { Feature: 'StagedNonLeaf', Milestone: 2 }));
					}
					let tmpOpaque = (
						{
							Alias: pRel.As,
							Entity: pRel.Entity,
							Dialect: tmpDialectName,
							SQL: null,
							Params: {},
							ParamTypes: {},
							Columns: pRel.Project.slice(),
							Capture: pCapture,
							Staged: false,
							NeedsStage: true,
							// The behavior-built query: the staged run executes it as captured.
							Query: tmpQuery
						});
					tmpContext.Memo.Relations[tmpBuiltKey] = tmpOpaque;
					tmpContext.Memo.Relations[tmpAliasKey] = tmpOpaque;
					return fCallback(null, tmpOpaque);
				}

				// 6. Minimal projection over the fully scoped WHERE, built in the entity's dialect.
				try
				{
					tmpQuery.parameters.FacetProjection = tmpProjection;
					tmpQuery.parameters.queryOverride = PROJECTION_TEMPLATE;
					tmpQuery.setDialect(tmpDialectName).buildReadQuery();
				}
				catch (pBuildError)
				{
					this.fable.log.error(`RetoldFaceting could not build the scoped relation for ${pRel.Entity}: ${pBuildError.message}`);
					return fCallback(libFacetErrors.isFacetError(pBuildError) ? pBuildError : libFacetErrors.create('FACET_INTERNAL'));
				}
				let tmpBuilt = (
					{
						Entity: pRel.Entity,
						Dialect: tmpDialectName,
						Query: tmpQuery,
						Columns: pRel.Project.slice(),
						Capture: pCapture
					});
				tmpContext.Memo.Relations[tmpBuiltKey] = tmpBuilt;
				return this._harvestFor(tmpContext, tmpBuilt, pRel, tmpAliasKey, fCallback);
			});
	}

	/**
	 * 7. Harvest a built relation for one alias: every bind renamed '<As>_<name>', the trailing ';'
	 * stripped (internal-contracts §7.2 step 6); memoized per alias.
	 *
	 * @param {Record<string, any>} pContext
	 * @param {Record<string, any>} pBuilt - { Entity, Dialect, Query, Columns, Capture } (or a NeedsStage relation)
	 * @param {Record<string, any>} pRel
	 * @param {string} pAliasKey
	 * @param {(pError?: Error, pRelation?: Record<string, any>) => void} fCallback
	 */
	_harvestFor(pContext, pBuilt, pRel, pAliasKey, fCallback)
	{
		if (pBuilt.NeedsStage)
		{
			// The unbuilt opaque relation is alias-independent (StagedKeys names its binds per alias).
			let tmpAliased = Object.assign({}, pBuilt, { Alias: pRel.As });
			pContext.Memo.Relations[pAliasKey] = tmpAliased;
			return fCallback(null, tmpAliased);
		}
		let tmpHarvested;
		try
		{
			tmpHarvested = this.fable.RetoldFacetingDialects.harvest(pBuilt.Query, pRel.As, pBuilt.Dialect);
		}
		catch (pHarvestError)
		{
			this.fable.log.error(`RetoldFaceting could not harvest the scoped relation for ${pRel.Entity}: ${pHarvestError.message}`);
			return fCallback(libFacetErrors.isFacetError(pHarvestError) ? pHarvestError : libFacetErrors.create('FACET_INTERNAL'));
		}
		let tmpRelation = (
			{
				Alias: pRel.As,
				Entity: pRel.Entity,
				Dialect: pBuilt.Dialect,
				SQL: tmpHarvested.SQL,
				Params: tmpHarvested.Params,
				ParamTypes: tmpHarvested.ParamTypes,
				Columns: pBuilt.Columns.slice(),
				Capture: pBuilt.Capture,
				Staged: false
			});
		pContext.Memo.Relations[pAliasKey] = tmpRelation;
		return fCallback(null, tmpRelation);
	}

	/**
	 * The memoization key of a relation: (Entity | ClientIds | Where | Scope | SoftDelete | Project).
	 * The alias is NOT part of it (§26.1 step 7): the same hop under two aliases is one relation.
	 *
	 * @param {Record<string, any>} pRel
	 * @return {string}
	 */
	relationKey(pRel)
	{
		let tmpClientIds = Array.isArray(pRel.Client) ? pRel.Client.map((pConjunct) => { return pConjunct.Id; }).join(',') : '';
		let tmpProject = Array.isArray(pRel.Project) ? pRel.Project.join(',') : '';
		let tmpWhere = ((pRel.Where === null) || (typeof(pRel.Where) === 'undefined')) ? '' : libFacetClauses.canonicalJSON(pRel.Where);
		return `${pRel.Entity}|${tmpClientIds}|${tmpWhere}|${pRel.Scope || 'Inherit'}|${pRel.SoftDelete}|${tmpProject}`;
	}
}

module.exports = RetoldFacetingScopedRelationBuilder;
module.exports.serviceType = 'RetoldFacetingScopedRelationBuilder';
module.exports.ALIAS_PATTERN = ALIAS_PATTERN;
module.exports.PROJECTION_TEMPLATE = PROJECTION_TEMPLATE;
module.exports.SCOPE_MODES = SCOPE_MODES;
module.exports.isColumnPred = isColumnPred;
