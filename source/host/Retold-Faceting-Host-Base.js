/**
 * Retold Faceting - Host Base
 *
 * The seam between the faceting service and whatever process it runs in (design 07; host kinds
 * DataService, ApplicationServer, Remote).  Every engine, the catalog and the security services
 * reach DALs, controllers, the scope policy and the principal ONLY through a host
 * (internal-contracts §12).  Process-specific methods here are abstract: they throw, call back
 * with an error, or return null.
 *
 * The base also owns the host-independent pieces every concrete host shares:
 *   - buildScopePolicy(): normalizes a `RetoldFaceting.Scope` section into the policy object of
 *     internal-contracts §8.3 (requiredFor / isScoped), given a "does entity E have column C" test;
 *   - buildPrincipal(): turns resolved session data into the frozen Principal of §12.2;
 *   - the onModelChanged listener list and its notifier;
 *   - reservedEntityNames(): the D-17 route-collision check (one implementation, used by attach).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libFacetRequest = require('../contract/Facet-Contract-Request.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');

// The SQL dialects the Live engine has shell templates for (internal-contracts §7.4).
const SUPPORTED_DIALECTS = Object.freeze([ 'SQLite', 'PostgreSQL', 'MySQL', 'MSSQL' ]);

// Guard modes a policy may run under (06 §3.3).  'Off' is legal only without a policy.
const POLICY_GUARD_MODES = Object.freeze([ 'Strict', 'Repair' ]);

const isPlainObject = libRetoldFacetingUtil.isPlainObject;

/**
 * Own-property lookup that is safe against prototype names ('__proto__', 'constructor', ...).
 *
 * @param {Record<string, any>} pObject
 * @param {string} pKey
 * @return {boolean}
 */
const hasOwn = (pObject, pKey) =>
{
	return isPlainObject(pObject) && (typeof(pKey) === 'string') && libRetoldFacetingUtil.hasOwn(pObject, pKey);
};

/**
 * Scope values are normalized ONCE here (trimmed; numeric literals → Number; booleans → 0 / 1;
 * anything else → null), so the unset check, the ScopeGuard comparison and the Version hash all
 * see the same value: a session IDTenant of '0', ' 0', '00' or false is unset (06 §2.2).
 *
 * @param {any} pValue
 * @return {string|number|null}
 */
const scopeValue = libRetoldFacetingUtil.normalizeScopeValue;

class RetoldFacetingHostBase extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options (resolved here)
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingHostBase';

		this._ModelChangedListeners = [];
	}

	/**
	 * Which kind of host this is.
	 *
	 * @return {string} 'DataService' | 'ApplicationServer' | 'Remote'
	 */
	getHostKind()
	{
		return 'Base';
	}

	/**
	 * Has bind() completed?
	 *
	 * @return {boolean}
	 */
	isBound()
	{
		return false;
	}

	/**
	 * Bind the host to its process objects (for a DataService: the RetoldDataService instance).
	 *
	 * @param {any} pHostObject
	 * @param {(pError?: Error) => void} fCallback
	 */
	bind(pHostObject, fCallback)
	{
		return fCallback(libFacetErrors.create('FACET_INTERNAL', 'RetoldFacetingHostBase.bind is abstract.'));
	}

	/**
	 * The compiled Stricture model (Tables[E].Columns[] + MeadowSchema).
	 *
	 * @param {(pError?: Error, pModel?: Record<string, any>) => void} fCallback
	 */
	getModel(fCallback)
	{
		return fCallback(libFacetErrors.create('FACET_INTERNAL', 'RetoldFacetingHostBase.getModel is abstract.'));
	}

	/**
	 * Synchronous form of getModel (the catalog build is synchronous).
	 *
	 * @return {Record<string, any>|null}
	 */
	getModelSync()
	{
		return null;
	}

	/**
	 * The model table for one entity (Tables[E]) or null.
	 *
	 * @param {string} pEntity
	 * @return {Record<string, any>|null}
	 */
	getEntityModel(pEntity)
	{
		let tmpModel = this.getModelSync();
		if (!tmpModel || !hasOwn(tmpModel.Tables, pEntity) || !isPlainObject(tmpModel.Tables[pEntity]))
		{
			return null;
		}
		return tmpModel.Tables[pEntity];
	}

	/**
	 * Does the entity's model declare this column?  (Columns[] first, MeadowSchema.Schema[] fallback.)
	 *
	 * @param {string} pEntity
	 * @param {string} pColumn
	 * @return {boolean}
	 */
	entityHasColumn(pEntity, pColumn)
	{
		let tmpTable = this.getEntityModel(pEntity);
		if (!tmpTable || (typeof(pColumn) !== 'string'))
		{
			return false;
		}
		if (Array.isArray(tmpTable.Columns) && tmpTable.Columns.some((pColumnEntry) => { return pColumnEntry && (pColumnEntry.Column === pColumn); }))
		{
			return true;
		}
		let tmpMeadowSchema = isPlainObject(tmpTable.MeadowSchema) ? tmpTable.MeadowSchema : {};
		return Array.isArray(tmpMeadowSchema.Schema) && tmpMeadowSchema.Schema.some((pSchemaEntry) => { return pSchemaEntry && (pSchemaEntry.Column === pColumn); });
	}

	/**
	 * Register a listener called with the new model after the host reloads its model (D-31).
	 *
	 * @param {(pModel: Record<string, any>) => void} fListener
	 */
	onModelChanged(fListener)
	{
		if (typeof(fListener) === 'function')
		{
			this._ModelChangedListeners.push(fListener);
		}
	}

	/**
	 * Call every onModelChanged listener with the current model.  A throwing listener is logged and
	 * does not stop the others.
	 *
	 * @param {Record<string, any>|null} pModel
	 */
	notifyModelChanged(pModel)
	{
		for (let i = 0; i < this._ModelChangedListeners.length; i++)
		{
			try
			{
				this._ModelChangedListeners[i](pModel);
			}
			catch (pListenerError)
			{
				this.fable.log.error(`RetoldFaceting host: a model-changed listener failed: ${pListenerError.message}`);
			}
		}
	}

	/**
	 * Every entity with a DAL.
	 *
	 * @return {Array<string>}
	 */
	listEntities()
	{
		return [];
	}

	/**
	 * The meadow DAL for an entity.
	 *
	 * @param {string} pEntity
	 * @return {any|null}
	 */
	getDAL(pEntity)
	{
		return null;
	}

	/**
	 * The DAL statements execute on (M1, Shared pool mode: the DAL the entity's list routes read
	 * through — the route-bound controller's — so Live is built from the same DAL and schema as the
	 * list it claims parity with, even after a model reload (D-31); controller-less entities, a later
	 * milestone, fall back to getDAL).
	 *
	 * @param {string} pEntity
	 * @return {any|null}
	 */
	getExecutionDAL(pEntity)
	{
		let tmpController = this.getRouteBoundController(pEntity);
		if (tmpController && tmpController.DAL && (typeof(tmpController.DAL) === 'object'))
		{
			return tmpController.DAL;
		}
		return this.getDAL(pEntity);
	}

	/**
	 * Entity names that would collide with the facet route segments (D-17): any DAL, route-bound
	 * endpoint or model table named like one.
	 *
	 * @return {Array<string>}
	 */
	reservedEntityNames()
	{
		let tmpNames = new Set(this.listEntities());
		let tmpModel = this.getModelSync();
		if (tmpModel && isPlainObject(tmpModel.Tables))
		{
			Object.keys(tmpModel.Tables).forEach((pName) => { tmpNames.add(pName); });
		}
		return libOptions.ROUTE_RESERVED_NAMES.filter((pName) => { return tmpNames.has(pName); });
	}

	/**
	 * The meadow-endpoints controller the entity's CRUD routes are actually bound to.
	 *
	 * @param {string} pEntity
	 * @return {any|null}
	 */
	getRouteBoundController(pEntity)
	{
		return null;
	}

	/**
	 * The Orator service server facet routes mount on.
	 *
	 * @return {any|null}
	 */
	getServiceServer()
	{
		return null;
	}

	/**
	 * The normalized scope policy (internal-contracts §8.3).
	 *
	 * @return {Record<string, any>}
	 */
	getScopePolicy()
	{
		return this.buildScopePolicy({ Policy: false, Required: {} }, () => { return false; });
	}

	/**
	 * ScopeAssurance (02 §7) for one entity, or deployment-wide when pEntity is omitted:
	 * 'Unscoped' (no policy), 'Guarded' (policy + ScopeGuard), 'Global' (a policy host's entity with
	 * no scope requirement), 'Spoofable' (header-asserted sessions allowed).
	 *
	 * @param {string} [pEntity]
	 * @return {string}
	 */
	scopeAssurance(pEntity)
	{
		let tmpPolicy = this.getScopePolicy();
		if (tmpPolicy.Kind !== 'Policy')
		{
			return 'Unscoped';
		}
		if ((typeof(pEntity) === 'string') && !tmpPolicy.isScoped(pEntity))
		{
			return 'Global';
		}
		return 'Guarded';
	}

	/**
	 * The host's entitlement authorizer, or null when the host has none (plain RDS).
	 *
	 * @return {any|null}
	 */
	getAuthorizer()
	{
		return null;
	}

	/**
	 * The SQL dialect an entity's DAL speaks.
	 *
	 * @param {string} pEntity
	 * @return {{ Name: string|null, Provider: string|null, Supported: boolean }}
	 */
	getDialectProfile(pEntity)
	{
		return { Name: 'SQLite', Provider: null, Supported: true };
	}

	/**
	 * @param {string} pEntity
	 * @return {boolean}
	 */
	hasDeleteColumn(pEntity)
	{
		return (this.getDeleteColumn(pEntity) !== null);
	}

	/**
	 * @param {string} pEntity
	 * @return {string|null}
	 */
	getDeleteColumn(pEntity)
	{
		return null;
	}

	/**
	 * @param {string} pEntity
	 * @return {string|null}
	 */
	getPrimaryKey(pEntity)
	{
		return null;
	}

	/**
	 * Host.isFacetable (06 §5.1).
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} [pPrincipal]
	 * @return {boolean}
	 */
	isFacetable(pEntity, pPrincipal)
	{
		return false;
	}

	/**
	 * Resolve the raw principal for a request (internal-contracts §12.2).
	 *
	 * @param {any} pRequest - restify request or a synthetic { params, headers, query, UserSession }
	 * @param {(pError?: Error, pPrincipal?: Record<string, any>) => void} fCallback
	 */
	resolvePrincipal(pRequest, fCallback)
	{
		return fCallback(libFacetErrors.create('FACET_INTERNAL', 'RetoldFacetingHostBase.resolvePrincipal is abstract.'));
	}

	/**
	 * Install a change intake (later milestones).
	 *
	 * @param {any} pIntake
	 * @return {boolean} false: not supported in M1
	 */
	installChangeIntake(pIntake)
	{
		return false;
	}

	/**
	 * The scope columns of one entity under the policy (internal-contracts §41.2), for change capture
	 * (which row values name the tenant / owner of a write) and generations (which tenant keys a write
	 * bumps and a fold reads):
	 *
	 *   Kind          'Unscoped' (no policy) | 'Personal' (has its PersonalScopes column) |
	 *                 'Tenant' (has the policy Column and is not Excluded) | 'Global' (anything else:
	 *                 a global lookup, an Excluded entity, or one scoped only by Required columns)
	 *   TenantColumn  the policy Column when the entity has it and is not Excluded, else null
	 *   OwnerColumn   PersonalScopes[E].Column when the entity has it, else null
	 *   RequiredColumns  Required[E] columns other than the two above
	 *   DeleteColumn, PrimaryKey
	 *   RowColumns    the columns whose change moves a row in or out of a scope or a fold
	 *                 (delete, tenant, owner, identity, Required): a write of one bumps '#row'
	 *
	 * @param {string} pEntity
	 * @return {Readonly<{ Entity: string, Kind: string, TenantColumn: string|null, OwnerColumn: string|null, RequiredColumns: Array<string>, DeleteColumn: string|null, PrimaryKey: string|null, RowColumns: Array<string> }>}
	 */
	entityScopeColumns(pEntity)
	{
		let tmpPolicy = this.getScopePolicy();
		// Memoized per policy object (a model load builds a new one, so the memo follows it): the write
		// path asks this several times per record (P13).
		let tmpMemo = null;
		if (tmpPolicy && (typeof(tmpPolicy) === 'object'))
		{
			if (!this._ScopeColumnsMemo)
			{
				this._ScopeColumnsMemo = new WeakMap();
			}
			tmpMemo = this._ScopeColumnsMemo.get(tmpPolicy);
			if (!tmpMemo)
			{
				tmpMemo = new Map();
				this._ScopeColumnsMemo.set(tmpPolicy, tmpMemo);
			}
			if (tmpMemo.has(pEntity))
			{
				return tmpMemo.get(pEntity);
			}
		}
		let tmpDescriptor = this._entityScopeColumns(pEntity, tmpPolicy);
		if (tmpMemo && (tmpMemo.size < 4096))
		{
			tmpMemo.set(pEntity, tmpDescriptor);
		}
		return tmpDescriptor;
	}

	/**
	 * entityScopeColumns without the memo.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pPolicy - getScopePolicy()
	 * @return {Readonly<Record<string, any>>}
	 */
	_entityScopeColumns(pEntity, pPolicy)
	{
		let tmpPolicy = pPolicy;
		let tmpTenantColumn = null;
		let tmpOwnerColumn = null;
		let tmpRequiredColumns = [];
		if (tmpPolicy && (tmpPolicy.Kind === 'Policy'))
		{
			let tmpExclude = Array.isArray(tmpPolicy.Exclude) ? tmpPolicy.Exclude : [];
			if (tmpPolicy.Column && (tmpExclude.indexOf(pEntity) < 0) && this.entityHasColumn(pEntity, tmpPolicy.Column))
			{
				tmpTenantColumn = tmpPolicy.Column;
			}
			let tmpPersonal = isPlainObject(tmpPolicy.PersonalScopes) ? tmpPolicy.PersonalScopes : {};
			if (hasOwn(tmpPersonal, pEntity) && tmpPersonal[pEntity] && this.entityHasColumn(pEntity, tmpPersonal[pEntity].Column))
			{
				tmpOwnerColumn = tmpPersonal[pEntity].Column;
			}
			let tmpRequired = isPlainObject(tmpPolicy.Required) ? tmpPolicy.Required : {};
			if (hasOwn(tmpRequired, pEntity) && Array.isArray(tmpRequired[pEntity]))
			{
				tmpRequired[pEntity].forEach(
					(pEntry) =>
					{
						if (pEntry && (typeof(pEntry.Column) === 'string') && (pEntry.Column !== tmpTenantColumn) && (pEntry.Column !== tmpOwnerColumn) && (tmpRequiredColumns.indexOf(pEntry.Column) < 0))
						{
							tmpRequiredColumns.push(pEntry.Column);
						}
					});
			}
		}
		let tmpKind = (!tmpPolicy || (tmpPolicy.Kind !== 'Policy')) ? 'Unscoped'
			: tmpOwnerColumn ? 'Personal'
			: tmpTenantColumn ? 'Tenant'
			: 'Global';
		let tmpDeleteColumn = this.getDeleteColumn(pEntity);
		let tmpPrimaryKey = this.getPrimaryKey(pEntity);
		let tmpRowColumns = [];
		[ tmpDeleteColumn, tmpTenantColumn, tmpOwnerColumn, tmpPrimaryKey ].concat(tmpRequiredColumns).forEach(
			(pColumn) =>
			{
				if ((typeof(pColumn) === 'string') && (pColumn.length > 0) && (tmpRowColumns.indexOf(pColumn) < 0))
				{
					tmpRowColumns.push(pColumn);
				}
			});
		return Object.freeze(
			{
				Entity: pEntity,
				Kind: tmpKind,
				TenantColumn: tmpTenantColumn,
				OwnerColumn: tmpOwnerColumn,
				RequiredColumns: Object.freeze(tmpRequiredColumns),
				DeleteColumn: tmpDeleteColumn || null,
				PrimaryKey: tmpPrimaryKey || null,
				RowColumns: Object.freeze(tmpRowColumns)
			});
	}

	/**
	 * Validate a Scope section; returns a list of human-readable problems (empty when valid).
	 * Hosts refuse to bind when this is non-empty (fail closed on a mis-configured policy).
	 *
	 * @param {Record<string, any>} [pScope] - RetoldFaceting.Scope (defaults to this.options.Scope)
	 * @return {Array<string>}
	 */
	validateScopeConfiguration(pScope)
	{
		let tmpScope = isPlainObject(pScope) ? pScope : (this.options.Scope || {});
		let tmpProblems = [];
		let tmpIdentifierPattern = libFacetRequest.IDENTIFIER_PATTERN;
		let tmpPolicy = isPlainObject(tmpScope.Policy) ? tmpScope.Policy : null;
		if ((tmpScope.Policy !== false) && (tmpScope.Policy !== 'Auto') && (typeof(tmpScope.Policy) !== 'undefined') && (tmpScope.Policy !== null) && !tmpPolicy)
		{
			tmpProblems.push(`Scope.Policy must be false, 'Auto' or an object (got ${typeof(tmpScope.Policy)}).`);
		}
		if (tmpPolicy)
		{
			if ((typeof(tmpPolicy.Column) !== 'undefined') && ((typeof(tmpPolicy.Column) !== 'string') || !tmpIdentifierPattern.test(tmpPolicy.Column)))
			{
				tmpProblems.push('Scope.Policy.Column must be a plain column identifier.');
			}
			if ((typeof(tmpPolicy.SessionField) !== 'undefined') && (typeof(tmpPolicy.SessionField) !== 'string'))
			{
				tmpProblems.push('Scope.Policy.SessionField must be a string.');
			}
			if ((typeof(tmpPolicy.Exclude) !== 'undefined') && !Array.isArray(tmpPolicy.Exclude))
			{
				tmpProblems.push('Scope.Policy.Exclude must be an array of entity names.');
			}
			let tmpPersonal = isPlainObject(tmpPolicy.PersonalScopes) ? tmpPolicy.PersonalScopes : {};
			Object.keys(tmpPersonal).forEach(
				(pEntity) =>
				{
					let tmpEntry = tmpPersonal[pEntity];
					if (!isPlainObject(tmpEntry) || (typeof(tmpEntry.Column) !== 'string') || !tmpIdentifierPattern.test(tmpEntry.Column))
					{
						tmpProblems.push(`Scope.Policy.PersonalScopes.${pEntity} needs a plain Column identifier.`);
					}
				});
		}
		let tmpRequired = isPlainObject(tmpScope.Required) ? tmpScope.Required : {};
		Object.keys(tmpRequired).forEach(
			(pEntity) =>
			{
				let tmpEntries = tmpRequired[pEntity];
				if (!Array.isArray(tmpEntries))
				{
					tmpProblems.push(`Scope.Required.${pEntity} must be an array of { Column, From }.`);
					return;
				}
				tmpEntries.forEach(
					(pEntry) =>
					{
						if (!isPlainObject(pEntry) || (typeof(pEntry.Column) !== 'string') || !tmpIdentifierPattern.test(pEntry.Column))
						{
							tmpProblems.push(`Scope.Required.${pEntity} has an entry without a plain Column identifier.`);
						}
						else if ((typeof(pEntry.From) !== 'string') || !/^\$(CurrentUser|Scope)\.[A-Za-z_][A-Za-z0-9_]*$/.test(pEntry.From))
						{
							tmpProblems.push(`Scope.Required.${pEntity}.${pEntry.Column} needs From: '$CurrentUser.<Field>' or '$Scope.<Column>'.`);
						}
					});
			});
		let tmpHasPolicy = libOptions.hasScopePolicy({ Scope: tmpScope }) || (tmpPolicy && isPlainObject(tmpPolicy.PersonalScopes) && (Object.keys(tmpPolicy.PersonalScopes).length > 0));
		if (tmpHasPolicy && (POLICY_GUARD_MODES.indexOf(tmpScope.Guard) < 0))
		{
			tmpProblems.push(`Scope.Guard '${tmpScope.Guard}' is not allowed with a scope policy (use 'Strict' or 'Repair'; 'Off' is only legal without a policy).`);
		}
		return tmpProblems;
	}

	/**
	 * Normalize a Scope section into the policy object of internal-contracts §8.3.
	 *
	 *   { Kind: 'Policy' | 'None', Column, SessionField, Exclude, PersonalScopes, Required, UnsetValues, Guard,
	 *     requiredFor(pEntity, pPrincipal) → [ { Column, Value } ], isScoped(pEntity) → boolean }
	 *
	 * Required set for entity E: the policy Column if E has it and is not in Exclude; plus
	 * PersonalScopes[E].Column if E has it; plus Required[E] entries.  Values come from
	 * Principal.ScopeValues[Column] (null when absent, so the Guard fails closed).
	 *
	 * @param {Record<string, any>} pScope - RetoldFaceting.Scope
	 * @param {(pEntity: string, pColumn: string) => boolean} fHasColumn
	 * @return {Record<string, any>}
	 */
	buildScopePolicy(pScope, fHasColumn)
	{
		let tmpScope = isPlainObject(pScope) ? pScope : {};
		let fEntityHasColumn = (typeof(fHasColumn) === 'function') ? fHasColumn : () => { return false; };
		let tmpPolicyConfig = isPlainObject(tmpScope.Policy) ? tmpScope.Policy : null;

		let tmpColumn = (tmpPolicyConfig && (typeof(tmpPolicyConfig.Column) === 'string') && (tmpPolicyConfig.Column.length > 0)) ? tmpPolicyConfig.Column : null;
		let tmpSessionField = (tmpPolicyConfig && (typeof(tmpPolicyConfig.SessionField) === 'string') && (tmpPolicyConfig.SessionField.length > 0)) ? tmpPolicyConfig.SessionField : tmpColumn;
		let tmpExclude = (tmpPolicyConfig && Array.isArray(tmpPolicyConfig.Exclude)) ? tmpPolicyConfig.Exclude.filter((pEntity) => { return (typeof(pEntity) === 'string'); }) : [];

		let tmpPersonalScopes = {};
		let tmpPersonalConfig = (tmpPolicyConfig && isPlainObject(tmpPolicyConfig.PersonalScopes)) ? tmpPolicyConfig.PersonalScopes : {};
		Object.keys(tmpPersonalConfig).forEach(
			(pEntity) =>
			{
				let tmpEntry = tmpPersonalConfig[pEntity];
				if (isPlainObject(tmpEntry) && (typeof(tmpEntry.Column) === 'string') && (tmpEntry.Column.length > 0))
				{
					tmpPersonalScopes[pEntity] = (
						{
							Column: tmpEntry.Column,
							SessionField: ((typeof(tmpEntry.SessionField) === 'string') && (tmpEntry.SessionField.length > 0)) ? tmpEntry.SessionField : tmpEntry.Column
						});
				}
			});

		let tmpRequired = {};
		let tmpRequiredConfig = isPlainObject(tmpScope.Required) ? tmpScope.Required : {};
		Object.keys(tmpRequiredConfig).forEach(
			(pEntity) =>
			{
				if (!Array.isArray(tmpRequiredConfig[pEntity]))
				{
					return;
				}
				let tmpEntries = tmpRequiredConfig[pEntity].filter((pEntry) => { return isPlainObject(pEntry) && (typeof(pEntry.Column) === 'string') && (pEntry.Column.length > 0); });
				if (tmpEntries.length > 0)
				{
					tmpRequired[pEntity] = tmpEntries.map((pEntry) => { return { Column: pEntry.Column, From: (typeof(pEntry.From) === 'string') ? pEntry.From : null }; });
				}
			});

		let tmpKind = (tmpColumn || (Object.keys(tmpPersonalScopes).length > 0) || (Object.keys(tmpRequired).length > 0)) ? 'Policy' : 'None';
		let tmpGuard = 'Off';
		if (tmpKind === 'Policy')
		{
			// Fail closed: anything but an explicit 'Repair' runs Strict (bind refuses 'Off' with a policy).
			tmpGuard = (tmpScope.Guard === 'Repair') ? 'Repair' : 'Strict';
		}
		let tmpUnsetValues = Array.isArray(tmpScope.UnsetValues) ? tmpScope.UnsetValues.slice() : [ 0, '', null ];

		/**
		 * The required scope columns for an entity, with the principal's values.
		 *
		 * @param {string} pEntity
		 * @param {Record<string, any>} [pPrincipal]
		 * @return {Array<{ Column: string, Value: any }>}
		 */
		let requiredFor = (pEntity, pPrincipal) =>
		{
			let tmpResult = [];
			if (tmpKind !== 'Policy')
			{
				return tmpResult;
			}
			let tmpScopeValues = (pPrincipal && isPlainObject(pPrincipal.ScopeValues)) ? pPrincipal.ScopeValues : {};
			let fAdd = (pColumn) =>
			{
				if (tmpResult.some((pEntry) => { return pEntry.Column === pColumn; }))
				{
					return;
				}
				tmpResult.push({ Column: pColumn, Value: hasOwn(tmpScopeValues, pColumn) ? scopeValue(tmpScopeValues[pColumn]) : null });
			};
			if (tmpColumn && (tmpExclude.indexOf(pEntity) < 0) && fEntityHasColumn(pEntity, tmpColumn))
			{
				fAdd(tmpColumn);
			}
			if (hasOwn(tmpPersonalScopes, pEntity) && fEntityHasColumn(pEntity, tmpPersonalScopes[pEntity].Column))
			{
				fAdd(tmpPersonalScopes[pEntity].Column);
			}
			if (hasOwn(tmpRequired, pEntity))
			{
				tmpRequired[pEntity].forEach((pEntry) => { fAdd(pEntry.Column); });
			}
			return tmpResult;
		};

		/**
		 * @param {string} pEntity
		 * @return {boolean} the entity has at least one required scope column
		 */
		let isScoped = (pEntity) =>
		{
			return (requiredFor(pEntity, null).length > 0);
		};

		return (
			{
				Kind: tmpKind,
				Column: tmpColumn,
				SessionField: tmpSessionField,
				Exclude: tmpExclude,
				PersonalScopes: tmpPersonalScopes,
				Required: tmpRequired,
				UnsetValues: tmpUnsetValues,
				Guard: tmpGuard,
				requiredFor: requiredFor,
				isScoped: isScoped
			});
	}

	/**
	 * The plain-data part of a scope policy (what ModelVersion hashes; functions dropped).
	 *
	 * @param {Record<string, any>} [pPolicy] - defaults to getScopePolicy()
	 * @return {Record<string, any>}
	 */
	scopePolicyData(pPolicy)
	{
		let tmpPolicy = pPolicy || this.getScopePolicy();
		return (
			{
				Kind: tmpPolicy.Kind,
				Column: tmpPolicy.Column || null,
				SessionField: tmpPolicy.SessionField || null,
				Exclude: (tmpPolicy.Exclude || []).slice().sort(),
				PersonalScopes: tmpPolicy.PersonalScopes || {},
				Required: tmpPolicy.Required || {},
				UnsetValues: tmpPolicy.UnsetValues || [],
				Guard: tmpPolicy.Guard
			});
	}

	/**
	 * Build the frozen Principal (internal-contracts §12.2) from resolved session data.
	 *
	 *   Kind        'User' when SessionData.LoggedIn === true, else 'Anonymous'
	 *   IDUser      SessionData.UserID || SessionData.IDUser || 0
	 *   IDCustomer  SessionData.CustomerID || SessionData.IDCustomer || 0
	 *   ScopeValues keyed by policy column: Policy.Column ← SessionData[SessionField];
	 *               PersonalScopes[E].Column ← SessionData[SessionField];
	 *               Required[E][].Column ← '$Scope.<C>' (a scope value, else SessionData[C]) or
	 *               '$CurrentUser.<F>' (IDUser / IDCustomer / a whitelisted UserRecord field)
	 *   UserRecord  only Scope.UserRecordFields
	 *
	 * @param {Record<string, any>} pSessionData
	 * @param {any} [pRequest] - for UserSession.UserRecord (06 §2.2)
	 * @param {string} [pSource] - default 'InProcess'
	 * @return {Readonly<Record<string, any>>}
	 */
	buildPrincipal(pSessionData, pRequest, pSource)
	{
		let tmpSession = isPlainObject(pSessionData) ? pSessionData : {};
		let tmpUserSession = (pRequest && isPlainObject(pRequest.UserSession)) ? pRequest.UserSession : {};
		let tmpSessionUserRecord = isPlainObject(tmpUserSession.UserRecord) ? tmpUserSession.UserRecord
			: isPlainObject(tmpSession.UserRecord) ? tmpSession.UserRecord
			: {};

		let tmpIDUser = tmpSession.UserID || tmpSession.IDUser || 0;
		let tmpIDCustomer = tmpSession.CustomerID || tmpSession.IDCustomer || 0;

		// UserRecord: only whitelisted fields ($CurrentUser.<Field>, 06 §2.3)
		let tmpUserRecordFields = Array.isArray(this.options.Scope.UserRecordFields) ? this.options.Scope.UserRecordFields : [];
		let tmpUserRecord = {};
		for (let i = 0; i < tmpUserRecordFields.length; i++)
		{
			let tmpField = tmpUserRecordFields[i];
			if (typeof(tmpField) !== 'string')
			{
				continue;
			}
			if (tmpField === 'IDUser')
			{
				tmpUserRecord.IDUser = scopeValue(tmpIDUser);
			}
			else if (tmpField === 'IDCustomer')
			{
				tmpUserRecord.IDCustomer = scopeValue(tmpIDCustomer);
			}
			else if (hasOwn(tmpSessionUserRecord, tmpField))
			{
				tmpUserRecord[tmpField] = scopeValue(tmpSessionUserRecord[tmpField]);
			}
			else
			{
				tmpUserRecord[tmpField] = hasOwn(tmpSession, tmpField) ? scopeValue(tmpSession[tmpField]) : null;
			}
		}

		// ScopeValues, keyed by policy column
		let tmpPolicy = this.getScopePolicy();
		let tmpScopeValues = {};
		let fSessionValue = (pField) =>
		{
			return hasOwn(tmpSession, pField) ? scopeValue(tmpSession[pField]) : null;
		};
		if (tmpPolicy.Column)
		{
			tmpScopeValues[tmpPolicy.Column] = fSessionValue(tmpPolicy.SessionField || tmpPolicy.Column);
		}
		Object.keys(tmpPolicy.PersonalScopes || {}).forEach(
			(pEntity) =>
			{
				let tmpEntry = tmpPolicy.PersonalScopes[pEntity];
				if (!hasOwn(tmpScopeValues, tmpEntry.Column))
				{
					tmpScopeValues[tmpEntry.Column] = fSessionValue(tmpEntry.SessionField || tmpEntry.Column);
				}
			});
		Object.keys(tmpPolicy.Required || {}).forEach(
			(pEntity) =>
			{
				tmpPolicy.Required[pEntity].forEach(
					(pEntry) =>
					{
						if (hasOwn(tmpScopeValues, pEntry.Column))
						{
							return;
						}
						let tmpValue = null;
						let tmpMatch = (typeof(pEntry.From) === 'string') ? /^\$(CurrentUser|Scope)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(pEntry.From) : null;
						if (tmpMatch && (tmpMatch[1] === 'Scope'))
						{
							tmpValue = hasOwn(tmpScopeValues, tmpMatch[2]) ? tmpScopeValues[tmpMatch[2]] : fSessionValue(tmpMatch[2]);
						}
						else if (tmpMatch && (tmpMatch[1] === 'CurrentUser'))
						{
							tmpValue = hasOwn(tmpUserRecord, tmpMatch[2]) ? tmpUserRecord[tmpMatch[2]] : null;
						}
						tmpScopeValues[pEntry.Column] = tmpValue;
					});
			});

		return Object.freeze(
			{
				Kind: (tmpSession.LoggedIn === true) ? 'User' : 'Anonymous',
				Source: (typeof(pSource) === 'string') ? pSource : 'InProcess',
				IDUser: tmpIDUser,
				IDCustomer: tmpIDCustomer,
				ScopeValues: Object.freeze(tmpScopeValues),
				UserRecord: Object.freeze(tmpUserRecord),
				RoleSetHash: '',
				ResolvedAt: Date.now()
			});
	}
}

module.exports = RetoldFacetingHostBase;
module.exports.serviceType = 'RetoldFacetingHostBase';
module.exports.SUPPORTED_DIALECTS = SUPPORTED_DIALECTS;
module.exports.isPlainObject = isPlainObject;
module.exports.hasOwn = hasOwn;
