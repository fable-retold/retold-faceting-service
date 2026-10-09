/**
 * Retold Faceting - Graph
 *
 * The FacetGraph (01 §5): edges derived from Stricture Columns[].Join (resolved through the
 * PK-column index, keyed by (From, FromColumn)), bridges detected structurally, hub entities and
 * bridge aliases.  In M1 it only feeds ModelVersion and Describe `Target`; cross-entity paths
 * (M2+) build on it.
 *
 *   edge   { Name: 'Review.IDBook', From: 'Review', FromColumn: 'IDBook', To: 'Book', ToColumn: 'IDBook',
 *            Cardinality: 'N:1', Audit: false, Tenant: false }
 *   bridge { Entity: 'BookAuthorJoin', Edges: [ 'BookAuthorJoin.IDBook', 'BookAuthorJoin.IDAuthor' ],
 *            Alias: 'Book~Author', Tenant: true }
 *   alias  'Book~Author' → [ '<BookAuthorJoin.IDBook', '>BookAuthorJoin.IDAuthor' ]
 *
 * Milestone 2 adds path resolution (01 §4.5, internal-contracts §21): resolvePath turns a declared
 * path ('>E.c' to-one, '<E.c' to-many, '=E.c' co-reference, '@Alias' splices, step objects and the
 * explicit { Via, To } co-reference) into a PathPlan.  Paths are resolved when definitions load and
 * never solved at query time.
 *
 *   PathPlan { From, To, Steps: [ { Index, Raw, Direction, Edge, From, To, On, Via, Parent, CheckParent,
 *              Cardinality, Where, Scope, ScopeReason, Elide, As } ], Hops, ToOne, Signature }
 *
 * Step Where lists are carried as authored; the DefinitionRegistry canonicalizes them.
 *
 * Contract: internal-contracts §11.3, §21.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetClauses = require('../contract/Facet-Contract-Clauses.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');

// Path step strings (01 §4.5): '>E.c' | '<E.c' | '=E.c', and alias splices '@Name'.
const STEP_PATTERN = /^([<>=])([A-Za-z_][A-Za-z0-9_]{0,63})\.([A-Za-z_][A-Za-z0-9_]{0,63})$/;
const ALIAS_STEP_PATTERN = /^@([A-Za-z_][A-Za-z0-9_~]{0,127})$/;
const EDGE_NAME_PATTERN = /^([A-Za-z_][A-Za-z0-9_]{0,63})\.([A-Za-z_][A-Za-z0-9_]{0,63})$/;

// Step directions by prefix.
const STEP_DIRECTIONS = Object.freeze({ '>': 'Forward', '<': 'Reverse', '=': 'CoReference' });

/**
 * A load-time path error: FACET_DEFINITION_INVALID with Detail { Reason, Step, … } (identifiers
 * only, never a value).
 *
 * @param {string} pReason
 * @param {number|null} pStep - step index after alias splicing
 * @param {Record<string, any>} [pDetail]
 * @return {Error}
 */
const pathError = (pReason, pStep, pDetail) =>
{
	return libFacetErrors.create('FACET_DEFINITION_INVALID', `Invalid path: ${pReason}.`,
		Object.assign({ Reason: pReason, Step: (typeof(pStep) === 'number') ? pStep : null }, pDetail || {}));
};

// THE audit table (the Catalog imports it).  Audit-user columns (01 §5.1: edges flagged Audit,
// excluded from suggestions and bridge counting):
const AUDIT_USER_COLUMNS = Object.freeze([ 'CreatingIDUser', 'UpdatingIDUser', 'DeletingIDUser' ]);
const AUDIT_USER_MEADOW_TYPES = Object.freeze([ 'CreateIDUser', 'UpdateIDUser', 'DeleteIDUser' ]);
// Audit stamps (dates and users):
const AUDIT_STAMP_MEADOW_TYPES = Object.freeze([ 'CreateDate', 'UpdateDate', 'DeleteDate' ].concat(AUDIT_USER_MEADOW_TYPES));
const AUDIT_STAMP_COLUMN_NAMES = Object.freeze([ 'CreateDate', 'UpdateDate', 'DeleteDate' ].concat(AUDIT_USER_COLUMNS));
// Columns that are never bridge payload (the audit stamps and the soft-delete flag):
const AUDIT_MEADOW_TYPES = Object.freeze(AUDIT_STAMP_MEADOW_TYPES.concat([ 'Deleted' ]));
const AUDIT_COLUMN_NAMES = Object.freeze(AUDIT_STAMP_COLUMN_NAMES.concat([ 'Deleted' ]));
// Tenancy columns (01 §5.1 "tenancy edges (IDCustomer) Tenant: true"); the policy column is added.
const DEFAULT_TENANT_COLUMNS = Object.freeze([ 'IDCustomer', 'IDTenant' ]);

const isPlainObject = libRetoldFacetingUtil.isPlainObject;

/**
 * @param {Record<string, any>} pObject
 * @param {string} pKey
 * @return {boolean}
 */
const hasOwn = (pObject, pKey) =>
{
	return isPlainObject(pObject) && (typeof(pKey) === 'string') && libRetoldFacetingUtil.hasOwn(pObject, pKey);
};

// Model hashes use the contract's canonical JSON (one implementation).
const canonicalJSON = libFacetClauses.canonicalJSON;

// One SHA-1 helper for the server services (Retold-Faceting-Util).
const sha1Hex = libRetoldFacetingUtil.sha1Hex;

/**
 * Table names in model order (TablesSequence first, then any remaining Tables keys).
 *
 * @param {Record<string, any>} pModel
 * @return {Array<string>}
 */
const tableNames = (pModel) =>
{
	let tmpTables = (pModel && isPlainObject(pModel.Tables)) ? pModel.Tables : {};
	let tmpNames = [];
	let tmpSeen = {};
	let tmpSequence = (pModel && Array.isArray(pModel.TablesSequence)) ? pModel.TablesSequence : [];
	let fAdd = (pName) =>
	{
		if ((typeof(pName) === 'string') && hasOwn(tmpTables, pName) && isPlainObject(tmpTables[pName]) && !tmpSeen[pName])
		{
			tmpSeen[pName] = true;
			tmpNames.push(pName);
		}
	};
	tmpSequence.forEach(fAdd);
	Object.keys(tmpTables).forEach(fAdd);
	return tmpNames;
};

/**
 * The primary-key column of a model table: MeadowSchema.DefaultIdentifier, else the DataType 'ID'
 * column, else the MeadowSchema AutoIdentity column.
 *
 * @param {Record<string, any>} pTable
 * @return {string|null}
 */
const primaryKeyOf = (pTable) =>
{
	if (!isPlainObject(pTable))
	{
		return null;
	}
	let tmpMeadowSchema = isPlainObject(pTable.MeadowSchema) ? pTable.MeadowSchema : {};
	if ((typeof(tmpMeadowSchema.DefaultIdentifier) === 'string') && (tmpMeadowSchema.DefaultIdentifier.length > 0))
	{
		return tmpMeadowSchema.DefaultIdentifier;
	}
	let tmpColumns = Array.isArray(pTable.Columns) ? pTable.Columns : [];
	for (let i = 0; i < tmpColumns.length; i++)
	{
		if (tmpColumns[i] && (tmpColumns[i].DataType === 'ID') && (typeof(tmpColumns[i].Column) === 'string'))
		{
			return tmpColumns[i].Column;
		}
	}
	let tmpSchema = Array.isArray(tmpMeadowSchema.Schema) ? tmpMeadowSchema.Schema : [];
	for (let i = 0; i < tmpSchema.length; i++)
	{
		if (tmpSchema[i] && (tmpSchema[i].Type === 'AutoIdentity') && (typeof(tmpSchema[i].Column) === 'string'))
		{
			return tmpSchema[i].Column;
		}
	}
	return null;
};

/**
 * Column → MeadowSchema.Schema Type for one table.
 *
 * @param {Record<string, any>} pTable
 * @return {Record<string, string>}
 */
const meadowTypesOf = (pTable) =>
{
	let tmpTypes = {};
	let tmpSchema = (isPlainObject(pTable) && isPlainObject(pTable.MeadowSchema) && Array.isArray(pTable.MeadowSchema.Schema)) ? pTable.MeadowSchema.Schema : [];
	for (let i = 0; i < tmpSchema.length; i++)
	{
		if (tmpSchema[i] && (typeof(tmpSchema[i].Column) === 'string'))
		{
			tmpTypes[tmpSchema[i].Column] = tmpSchema[i].Type;
		}
	}
	return tmpTypes;
};

class RetoldFacetingGraph extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingGraph';

		// 'Review.IDBook' → { Name, From, FromColumn, To, ToColumn, Cardinality: 'N:1', Audit, Tenant }
		this._Edges = {};
		// Entity → bridge record
		this._Bridges = {};
		// 'Book~Author' → [ '<BookAuthorJoin.IDBook', '>BookAuthorJoin.IDAuthor' ]
		this._Aliases = {};
		// PK column → [ entities ] (an entry with more than one entity is ambiguous)
		this._PrimaryKeyIndex = {};
		// Entity → PK column
		this._PrimaryKeys = {};
		this._Entities = [];
		this._Hubs = [];
		this._Warnings = [];
		this._GraphHash = 'g:000000000000';
		// The model object this graph was built from (identity; lets the catalog detect staleness)
		this._Model = null;
	}

	/**
	 * The tenancy columns: the scope-policy column plus the defaults (IDCustomer, IDTenant).
	 *
	 * @return {Array<string>}
	 */
	tenantColumns()
	{
		let tmpColumns = DEFAULT_TENANT_COLUMNS.slice();
		let tmpPolicy = (this.options.Scope && isPlainObject(this.options.Scope.Policy)) ? this.options.Scope.Policy : null;
		if (tmpPolicy && (typeof(tmpPolicy.Column) === 'string') && (tmpColumns.indexOf(tmpPolicy.Column) < 0))
		{
			tmpColumns.push(tmpPolicy.Column);
		}
		return tmpColumns;
	}

	/**
	 * Rebuild edges, bridges, aliases, hubs and GraphHash from the model.  A null model empties the
	 * graph.
	 *
	 * @param {Record<string, any>} pModel - { Tables: { E: { Columns, MeadowSchema, … } }, TablesSequence? }
	 * @return {RetoldFacetingGraph}
	 */
	rebuild(pModel)
	{
		this._Edges = {};
		this._Bridges = {};
		this._Aliases = {};
		this._PrimaryKeyIndex = {};
		this._PrimaryKeys = {};
		this._Warnings = [];
		this._Model = pModel || null;

		let tmpTables = (pModel && isPlainObject(pModel.Tables)) ? pModel.Tables : {};
		this._Entities = tableNames(pModel);
		let tmpTenantColumns = this.tenantColumns();

		// 1. PK-column index (targets resolve through it, never by stripping an 'ID' prefix).
		for (let i = 0; i < this._Entities.length; i++)
		{
			let tmpEntity = this._Entities[i];
			let tmpPK = primaryKeyOf(tmpTables[tmpEntity]);
			if (!tmpPK)
			{
				continue;
			}
			this._PrimaryKeys[tmpEntity] = tmpPK;
			if (!hasOwn(this._PrimaryKeyIndex, tmpPK))
			{
				this._PrimaryKeyIndex[tmpPK] = [];
			}
			this._PrimaryKeyIndex[tmpPK].push(tmpEntity);
		}

		// 2. Edges, keyed by (From, FromColumn) so two FKs to the same table both survive.
		for (let i = 0; i < this._Entities.length; i++)
		{
			let tmpEntity = this._Entities[i];
			let tmpTable = tmpTables[tmpEntity];
			let tmpMeadowTypes = meadowTypesOf(tmpTable);
			let tmpColumns = Array.isArray(tmpTable.Columns) ? tmpTable.Columns : [];
			for (let j = 0; j < tmpColumns.length; j++)
			{
				let tmpColumn = tmpColumns[j];
				if (!tmpColumn || (typeof(tmpColumn.Column) !== 'string') || (typeof(tmpColumn.Join) !== 'string') || (tmpColumn.Join.length < 1))
				{
					continue;
				}
				let tmpTargets = hasOwn(this._PrimaryKeyIndex, tmpColumn.Join) ? this._PrimaryKeyIndex[tmpColumn.Join] : [];
				if (tmpTargets.length !== 1)
				{
					this._Warnings.push(
						{
							Code: (tmpTargets.length === 0) ? 'JoinTargetUnresolved' : 'JoinTargetAmbiguous',
							Entity: tmpEntity,
							Column: tmpColumn.Column,
							Join: tmpColumn.Join,
							Candidates: tmpTargets.slice()
						});
					continue;
				}
				let tmpName = `${tmpEntity}.${tmpColumn.Column}`;
				this._Edges[tmpName] = Object.freeze(
					{
						Name: tmpName,
						From: tmpEntity,
						FromColumn: tmpColumn.Column,
						To: tmpTargets[0],
						ToColumn: tmpColumn.Join,
						Cardinality: 'N:1',
						Audit: (AUDIT_USER_COLUMNS.indexOf(tmpColumn.Column) >= 0) || (AUDIT_USER_MEADOW_TYPES.indexOf(tmpMeadowTypes[tmpColumn.Column]) >= 0),
						Tenant: (tmpTenantColumns.indexOf(tmpColumn.Column) >= 0)
					});
			}
		}

		// 3. Bridges: exactly two non-audit, non-tenant Join edges and no other payload (01 §5.3).
		let tmpAliasCandidates = {};
		for (let i = 0; i < this._Entities.length; i++)
		{
			let tmpEntity = this._Entities[i];
			let tmpBridge = this._detectBridge(tmpEntity, tmpTables[tmpEntity], tmpTenantColumns);
			if (!tmpBridge)
			{
				continue;
			}
			this._Bridges[tmpEntity] = tmpBridge;
			if (!hasOwn(tmpAliasCandidates, tmpBridge.Alias))
			{
				tmpAliasCandidates[tmpBridge.Alias] = [];
			}
			tmpAliasCandidates[tmpBridge.Alias].push(tmpEntity);
		}
		Object.keys(tmpAliasCandidates).forEach(
			(pAlias) =>
			{
				let tmpBridgeEntities = tmpAliasCandidates[pAlias];
				if (tmpBridgeEntities.length !== 1)
				{
					// Two bridges between the same pair: neither gets the synthetic alias (declare one).
					this._Warnings.push({ Code: 'BridgeAliasAmbiguous', Alias: pAlias, Candidates: tmpBridgeEntities.slice() });
					tmpBridgeEntities.forEach((pBridgeEntity) => { this._Bridges[pBridgeEntity] = Object.freeze(Object.assign({}, this._Bridges[pBridgeEntity], { Alias: null })); });
					return;
				}
				let tmpBridgeRecord = this._Bridges[tmpBridgeEntities[0]];
				let tmpNearEdge = this._Edges[tmpBridgeRecord.Edges[0]];
				let tmpFarEdge = this._Edges[tmpBridgeRecord.Edges[1]];
				this._Aliases[pAlias] = Object.freeze([ `<${tmpNearEdge.Name}`, `>${tmpFarEdge.Name}` ]);
			});

		// 4. Hubs (Catalog.HubEntities present in the model).
		let tmpHubs = Array.isArray(this.options.Catalog.HubEntities) ? this.options.Catalog.HubEntities : [];
		this._Hubs = tmpHubs.filter((pEntity) => { return (typeof(pEntity) === 'string') && hasOwn(tmpTables, pEntity); });

		// 5. GraphHash = sha1(canonical(Tables subset: names, Columns[].{Column, DataType, Join, TableJoin})) (01 §5.4).
		let tmpSubset = {};
		for (let i = 0; i < this._Entities.length; i++)
		{
			let tmpEntity = this._Entities[i];
			let tmpColumns = Array.isArray(tmpTables[tmpEntity].Columns) ? tmpTables[tmpEntity].Columns : [];
			tmpSubset[tmpEntity] = tmpColumns.filter((pColumn) => { return pColumn && (typeof(pColumn.Column) === 'string'); }).map(
				(pColumn) =>
				{
					return (
						{
							Column: pColumn.Column,
							DataType: (typeof(pColumn.DataType) === 'string') ? pColumn.DataType : null,
							Join: (typeof(pColumn.Join) === 'string') ? pColumn.Join : null,
							TableJoin: (typeof(pColumn.TableJoin) === 'string') ? pColumn.TableJoin : null
						});
				});
		}
		this._GraphHash = 'g:' + sha1Hex(canonicalJSON(tmpSubset)).substring(0, 12);

		if (this._Warnings.length > 0)
		{
			this.fable.log.warn(`RetoldFaceting graph: ${this._Warnings.length} warning(s): ${this._Warnings.map((pWarning) => { return `${pWarning.Code}${pWarning.Entity ? ' ' + pWarning.Entity + '.' + pWarning.Column : ' ' + pWarning.Alias}`; }).join('; ')}`);
		}
		return this;
	}

	/**
	 * Structural bridge test for one table.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pTable
	 * @param {Array<string>} pTenantColumns
	 * @return {Record<string, any>|null} the bridge record
	 */
	_detectBridge(pEntity, pTable, pTenantColumns)
	{
		let tmpColumns = Array.isArray(pTable.Columns) ? pTable.Columns : [];
		let tmpMeadowTypes = meadowTypesOf(pTable);
		let tmpPK = hasOwn(this._PrimaryKeys, pEntity) ? this._PrimaryKeys[pEntity] : null;
		let tmpJoinEdges = [];
		let tmpTenant = false;
		for (let i = 0; i < tmpColumns.length; i++)
		{
			let tmpColumn = tmpColumns[i];
			if (!tmpColumn || (typeof(tmpColumn.Column) !== 'string'))
			{
				continue;
			}
			let tmpName = tmpColumn.Column;
			let tmpMeadowType = tmpMeadowTypes[tmpName];
			if ((tmpName === tmpPK) || (tmpColumn.DataType === 'ID') || (tmpColumn.DataType === 'GUID') || (tmpMeadowType === 'AutoIdentity') || (tmpMeadowType === 'AutoGUID'))
			{
				continue;
			}
			if ((AUDIT_COLUMN_NAMES.indexOf(tmpName) >= 0) || (AUDIT_MEADOW_TYPES.indexOf(tmpMeadowType) >= 0))
			{
				continue;
			}
			if (pTenantColumns.indexOf(tmpName) >= 0)
			{
				tmpTenant = true;
				continue;
			}
			let tmpEdgeName = `${pEntity}.${tmpName}`;
			if ((typeof(tmpColumn.Join) === 'string') && hasOwn(this._Edges, tmpEdgeName))
			{
				tmpJoinEdges.push(tmpEdgeName);
				continue;
			}
			// Any other column is payload: a regular entity.
			return null;
		}
		if (tmpJoinEdges.length !== 2)
		{
			return null;
		}
		let tmpNear = this._Edges[tmpJoinEdges[0]];
		let tmpFar = this._Edges[tmpJoinEdges[1]];
		return Object.freeze(
			{
				Entity: pEntity,
				Edges: Object.freeze(tmpJoinEdges.slice()),
				Alias: `${tmpNear.To}~${tmpFar.To}`,
				Tenant: tmpTenant,
				// 01 §5.3: a join table with a tenancy column is a regular entity for scoping: its alias
				// is only a convenience splice (every hop stays its own Scoped Relation), and a future L4
				// elision must NEVER skip it (eliding it would skip its tenant predicate: a cross-tenant
				// leak).  Elision may only consider bridges with Elidable: true.
				Elidable: !tmpTenant
			});
	}

	/**
	 * @param {string} pName - 'Entity.Column'
	 * @return {Record<string, any>|null}
	 */
	edge(pName)
	{
		return hasOwn(this._Edges, pName) ? this._Edges[pName] : null;
	}

	/**
	 * Every edge, in model order.
	 *
	 * @return {Array<Record<string, any>>}
	 */
	edges()
	{
		return Object.keys(this._Edges).map((pKey) => { return this._Edges[pKey]; });
	}

	/**
	 * Edges whose From is pEntity.
	 *
	 * @param {string} pEntity
	 * @return {Array<Record<string, any>>}
	 */
	outgoing(pEntity)
	{
		return this.edges().filter((pEdge) => { return pEdge.From === pEntity; });
	}

	/**
	 * Edges whose To is pEntity.
	 *
	 * @param {string} pEntity
	 * @return {Array<Record<string, any>>}
	 */
	incoming(pEntity)
	{
		return this.edges().filter((pEdge) => { return pEdge.To === pEntity; });
	}

	/**
	 * @param {string} pEntity
	 * @return {boolean}
	 */
	isBridge(pEntity)
	{
		return hasOwn(this._Bridges, pEntity);
	}

	/**
	 * @param {string} pEntity
	 * @return {Record<string, any>|null} { Entity, Edges, Alias, Tenant }
	 */
	bridge(pEntity)
	{
		return hasOwn(this._Bridges, pEntity) ? this._Bridges[pEntity] : null;
	}

	/**
	 * @return {Array<string>} bridge entity names
	 */
	bridges()
	{
		return Object.keys(this._Bridges);
	}

	/**
	 * A synthetic bridge alias ('Book~Author' → [ '<BookAuthorJoin.IDBook', '>BookAuthorJoin.IDAuthor' ]).
	 *
	 * @param {string} pName
	 * @return {Array<string>|null}
	 */
	alias(pName)
	{
		return hasOwn(this._Aliases, pName) ? this._Aliases[pName] : null;
	}

	/**
	 * @return {Record<string, Array<string>>}
	 */
	aliases()
	{
		return Object.assign({}, this._Aliases);
	}

	/**
	 * @return {Array<string>} Catalog.HubEntities present in the model
	 */
	hubs()
	{
		return this._Hubs.slice();
	}

	/**
	 * @param {string} pEntity
	 * @return {boolean}
	 */
	isHub(pEntity)
	{
		return (this._Hubs.indexOf(pEntity) >= 0);
	}

	/**
	 * The entity whose primary key is this column (null when unknown or ambiguous).
	 *
	 * @param {string} pColumn
	 * @return {string|null}
	 */
	entityForKey(pColumn)
	{
		if (!hasOwn(this._PrimaryKeyIndex, pColumn) || (this._PrimaryKeyIndex[pColumn].length !== 1))
		{
			return null;
		}
		return this._PrimaryKeyIndex[pColumn][0];
	}

	/**
	 * @param {string} pEntity
	 * @return {string|null} the entity's primary-key column per the model
	 */
	primaryKey(pEntity)
	{
		return hasOwn(this._PrimaryKeys, pEntity) ? this._PrimaryKeys[pEntity] : null;
	}

	/**
	 * @return {Array<string>} every model entity, in model order
	 */
	entities()
	{
		return this._Entities.slice();
	}

	/**
	 * The model column record of Entity.Column (null when either is unknown).
	 *
	 * @param {string} pEntity
	 * @param {string} pColumn
	 * @return {Record<string, any>|null}
	 */
	modelColumn(pEntity, pColumn)
	{
		let tmpTables = (this._Model && isPlainObject(this._Model.Tables)) ? this._Model.Tables : {};
		if ((typeof(pEntity) !== 'string') || !hasOwn(tmpTables, pEntity) || !isPlainObject(tmpTables[pEntity]))
		{
			return null;
		}
		let tmpColumns = Array.isArray(tmpTables[pEntity].Columns) ? tmpTables[pEntity].Columns : [];
		let tmpColumn = tmpColumns.find((pEntry) => { return pEntry && (pEntry.Column === pColumn); });
		return tmpColumn || null;
	}

	/**
	 * The graph edge Entity.Column, or a path error: UnknownEdge (unknown entity / column, or a Join
	 * that did not resolve), NotAJoin (a column without Join).
	 *
	 * @param {string} pEntity
	 * @param {string} pColumn
	 * @param {number} pStep
	 * @return {Record<string, any>}
	 */
	_edgeOrThrow(pEntity, pColumn, pStep)
	{
		let tmpEdge = this.edge(`${pEntity}.${pColumn}`);
		if (tmpEdge)
		{
			return tmpEdge;
		}
		let tmpColumn = this.modelColumn(pEntity, pColumn);
		if (tmpColumn && ((typeof(tmpColumn.Join) !== 'string') || (tmpColumn.Join.length < 1)))
		{
			throw pathError('NotAJoin', pStep, { Edge: `${pEntity}.${pColumn}` });
		}
		throw pathError('UnknownEdge', pStep, { Edge: `${pEntity}.${pColumn}` });
	}

	/**
	 * A path in its list form: a JSON array of steps (strings or step objects), or the
	 * space-separated string sugar.  Anything else is InvalidPath.
	 *
	 * @param {any} pSteps
	 * @return {Array<string|Record<string, any>>}
	 */
	pathEntries(pSteps)
	{
		if (typeof(pSteps) === 'string')
		{
			let tmpParts = pSteps.trim().split(/\s+/).filter((pPart) => { return pPart.length > 0; });
			if (tmpParts.length < 1)
			{
				throw pathError('InvalidPath', null);
			}
			return tmpParts;
		}
		if (!Array.isArray(pSteps))
		{
			throw pathError('InvalidPath', null);
		}
		for (let i = 0; i < pSteps.length; i++)
		{
			if ((typeof(pSteps[i]) !== 'string') && !isPlainObject(pSteps[i]))
			{
				throw pathError('InvalidStep', i);
			}
		}
		return pSteps.slice();
	}

	/**
	 * The alias names a path splices directly ('@Name' entries, not recursively).
	 *
	 * @param {any} pSteps
	 * @return {Array<string>}
	 */
	pathAliasReferences(pSteps)
	{
		let tmpEntries = [];
		try
		{
			tmpEntries = this.pathEntries(pSteps);
		}
		catch (pError)
		{
			return [];
		}
		let tmpNames = [];
		tmpEntries.forEach(
			(pEntry) =>
			{
				let tmpMatch = (typeof(pEntry) === 'string') ? ALIAS_STEP_PATTERN.exec(pEntry) : null;
				if (tmpMatch && (tmpNames.indexOf(tmpMatch[1]) < 0))
				{
					tmpNames.push(tmpMatch[1]);
				}
			});
		return tmpNames;
	}

	/**
	 * Splice '@Alias' entries recursively: declared aliases (pAliases, a Map or a plain object of
	 * name → path) first, then the synthetic bridge aliases.  A step object's options stay on that
	 * one step.  Errors: UnknownAlias, AliasCycle (Step = the index after splicing).
	 *
	 * @param {any} pSteps
	 * @param {Map<string, any>|Record<string, any>} [pAliases]
	 * @param {Array<string>} [pStack] - aliases being spliced (cycle detection)
	 * @param {number} [pOffset] - index of the first produced step in the outer path
	 * @return {Array<string|Record<string, any>>}
	 */
	spliceAliases(pSteps, pAliases, pStack, pOffset)
	{
		let tmpStack = Array.isArray(pStack) ? pStack : [];
		let tmpOffset = (typeof(pOffset) === 'number') ? pOffset : 0;
		let tmpEntries = this.pathEntries(pSteps);
		let tmpResult = [];
		for (let i = 0; i < tmpEntries.length; i++)
		{
			let tmpEntry = tmpEntries[i];
			if ((typeof(tmpEntry) === 'string') && (tmpEntry.charAt(0) === '@'))
			{
				let tmpMatch = ALIAS_STEP_PATTERN.exec(tmpEntry);
				if (!tmpMatch)
				{
					throw pathError('InvalidStep', tmpOffset + tmpResult.length);
				}
				let tmpName = tmpMatch[1];
				if (tmpStack.indexOf(tmpName) >= 0)
				{
					throw pathError('AliasCycle', tmpOffset + tmpResult.length, { Alias: tmpName });
				}
				let tmpAlias = null;
				if (pAliases instanceof Map)
				{
					tmpAlias = pAliases.has(tmpName) ? pAliases.get(tmpName) : null;
				}
				else if (isPlainObject(pAliases) && hasOwn(pAliases, tmpName))
				{
					tmpAlias = pAliases[tmpName];
				}
				if ((tmpAlias === null) || (typeof(tmpAlias) === 'undefined'))
				{
					tmpAlias = this.alias(tmpName);
				}
				if (!tmpAlias)
				{
					throw pathError('UnknownAlias', tmpOffset + tmpResult.length, { Alias: tmpName });
				}
				let tmpSpliced = this.spliceAliases(tmpAlias, pAliases, tmpStack.concat([ tmpName ]), tmpOffset + tmpResult.length);
				for (let j = 0; j < tmpSpliced.length; j++)
				{
					tmpResult.push(tmpSpliced[j]);
				}
				continue;
			}
			tmpResult.push(tmpEntry);
		}
		return tmpResult;
	}

	/**
	 * The unique FK column of pEntity whose edge reaches the same target primary key as pEdgeName
	 * (the source side of a '=E.c' co-reference).  Only edges of the same kind are candidates
	 * (audit-user edges pair with audit-user edges, tenancy edges with tenancy edges).
	 *
	 * @param {string} pEntity - the entity the co-reference stands on
	 * @param {string} pEdgeName - 'E.c' (the target side's edge)
	 * @return {string|null} 'S.s', or null when none (throws FACET_DEFINITION_INVALID AmbiguousCoReference when several)
	 */
	coReferenceSource(pEntity, pEdgeName)
	{
		let tmpEdge = this.edge(pEdgeName);
		if (!tmpEdge)
		{
			return null;
		}
		let tmpCandidates = this.outgoing(pEntity).filter(
			(pCandidate) =>
			{
				return (pCandidate.To === tmpEdge.To) && (pCandidate.Audit === tmpEdge.Audit) && (pCandidate.Tenant === tmpEdge.Tenant);
			});
		if (tmpCandidates.length < 1)
		{
			return null;
		}
		if (tmpCandidates.length > 1)
		{
			throw pathError('AmbiguousCoReference', null, { Entity: pEntity, Edge: pEdgeName, Candidates: tmpCandidates.map((pCandidate) => { return pCandidate.Name; }) });
		}
		return tmpCandidates[0].Name;
	}

	/**
	 * Resolve one spliced step standing on pCurrent.
	 *
	 * @param {string} pCurrent
	 * @param {string|Record<string, any>} pEntry
	 * @param {number} pIndex
	 * @return {Record<string, any>} PathPlan step
	 */
	_resolveStep(pCurrent, pEntry, pIndex)
	{
		let tmpObject = isPlainObject(pEntry) ? pEntry : {};
		let tmpStep = null;
		if (isPlainObject(pEntry) && hasOwn(pEntry, 'Via'))
		{
			// Explicit co-reference { Via: 'S.s', To: 'E.c' }.
			let tmpVia = (typeof(pEntry.Via) === 'string') ? EDGE_NAME_PATTERN.exec(pEntry.Via) : null;
			let tmpTo = (typeof(pEntry.To) === 'string') ? EDGE_NAME_PATTERN.exec(pEntry.To) : null;
			if (!tmpVia || !tmpTo)
			{
				throw pathError('InvalidStep', pIndex);
			}
			let tmpViaEdge = this._edgeOrThrow(tmpVia[1], tmpVia[2], pIndex);
			let tmpToEdge = this._edgeOrThrow(tmpTo[1], tmpTo[2], pIndex);
			if (tmpViaEdge.From !== pCurrent)
			{
				throw pathError('WrongStart', pIndex, { Entity: pCurrent, Edge: tmpViaEdge.Name });
			}
			if (tmpViaEdge.To !== tmpToEdge.To)
			{
				throw pathError('NotCoReferent', pIndex, { Entity: pCurrent, Edge: tmpToEdge.Name });
			}
			// The string form when it names the same source FK; the Via is spelled out only when it must be.
			let tmpDefaultSource = null;
			try
			{
				tmpDefaultSource = this.coReferenceSource(pCurrent, tmpToEdge.Name);
			}
			catch (pAmbiguous)
			{
				tmpDefaultSource = null;
			}
			tmpStep = (
				{
					Raw: (tmpDefaultSource === tmpViaEdge.Name) ? `=${tmpToEdge.Name}` : `=${tmpToEdge.Name}@${tmpViaEdge.Name}`,
					Direction: 'CoReference',
					Edge: tmpToEdge.Name,
					From: pCurrent,
					To: tmpToEdge.From,
					On: [ [ tmpViaEdge.FromColumn, tmpToEdge.FromColumn ] ],
					Via: tmpViaEdge.Name,
					Parent: tmpToEdge.To,
					Cardinality: 'ToMany'
				});
		}
		else
		{
			let tmpText = isPlainObject(pEntry) ? pEntry.Step : pEntry;
			let tmpMatch = (typeof(tmpText) === 'string') ? STEP_PATTERN.exec(tmpText) : null;
			if (!tmpMatch)
			{
				throw pathError('InvalidStep', pIndex);
			}
			let tmpEdge = this._edgeOrThrow(tmpMatch[2], tmpMatch[3], pIndex);
			let tmpDirection = STEP_DIRECTIONS[tmpMatch[1]];
			if (tmpDirection === 'Forward')
			{
				if (tmpEdge.From !== pCurrent)
				{
					throw pathError('WrongStart', pIndex, { Entity: pCurrent, Edge: tmpEdge.Name });
				}
				tmpStep = { Raw: tmpText, Direction: 'Forward', Edge: tmpEdge.Name, From: pCurrent, To: tmpEdge.To, On: [ [ tmpEdge.FromColumn, tmpEdge.ToColumn ] ], Via: null, Parent: null, Cardinality: 'ToOne' };
			}
			else if (tmpDirection === 'Reverse')
			{
				if (tmpEdge.To !== pCurrent)
				{
					throw pathError('WrongStart', pIndex, { Entity: pCurrent, Edge: tmpEdge.Name });
				}
				tmpStep = { Raw: tmpText, Direction: 'Reverse', Edge: tmpEdge.Name, From: pCurrent, To: tmpEdge.From, On: [ [ tmpEdge.ToColumn, tmpEdge.FromColumn ] ], Via: null, Parent: null, Cardinality: 'ToMany' };
			}
			else
			{
				let tmpSource = null;
				try
				{
					tmpSource = this.coReferenceSource(pCurrent, tmpEdge.Name);
				}
				catch (pAmbiguous)
				{
					throw pathError('AmbiguousCoReference', pIndex, (pAmbiguous.Detail && pAmbiguous.Detail.Candidates) ? { Entity: pCurrent, Edge: tmpEdge.Name, Candidates: pAmbiguous.Detail.Candidates } : { Entity: pCurrent, Edge: tmpEdge.Name });
				}
				if (!tmpSource)
				{
					throw pathError('NotCoReferent', pIndex, { Entity: pCurrent, Edge: tmpEdge.Name });
				}
				let tmpSourceEdge = this.edge(tmpSource);
				tmpStep = (
					{
						Raw: tmpText, Direction: 'CoReference', Edge: tmpEdge.Name, From: pCurrent, To: tmpEdge.From,
						On: [ [ tmpSourceEdge.FromColumn, tmpEdge.FromColumn ] ], Via: tmpSource, Parent: tmpEdge.To, Cardinality: 'ToMany'
					});
			}
		}
		let tmpScope = (tmpObject.Scope === 'TenantOnly') ? 'TenantOnly' : 'Inherit';
		return (
			{
				Index: pIndex,
				Raw: tmpStep.Raw,
				Direction: tmpStep.Direction,
				Edge: tmpStep.Edge,
				From: tmpStep.From,
				To: tmpStep.To,
				On: tmpStep.On,
				Via: tmpStep.Via,
				Parent: tmpStep.Parent,
				// Only a co-reference has a parent to check (forcing is the registry's, internal-contracts §21.4).
				CheckParent: (tmpStep.Direction === 'CoReference') && (tmpObject.CheckParent === true),
				Cardinality: tmpStep.Cardinality,
				// As authored (a Pred list) or null; the DefinitionRegistry canonicalizes it.
				Where: Array.isArray(tmpObject.Where) ? tmpObject.Where : null,
				Scope: tmpScope,
				ScopeReason: ((typeof(tmpObject.ScopeReason) === 'string') && (tmpObject.ScopeReason.length > 0)) ? tmpObject.ScopeReason : null,
				Elide: (tmpObject.Elide === true),
				As: (typeof(tmpObject.As) === 'string') ? tmpObject.As : null
			});
	}

	/**
	 * Resolve a declared path standing on pFrom into a PathPlan (internal-contracts §21.2).
	 * Structure only: step Where fields, TenantOnly rules and existence depth are the registry's.
	 *
	 * @param {string} pFrom - the entity the path starts on
	 * @param {any} pSteps - a JSON array of steps, or the space-separated string sugar
	 * @param {{ Aliases?: Map<string, any>|Record<string, any>, MaxHops?: number }} [pOptions]
	 * @return {Record<string, any>} PathPlan (throws FACET_DEFINITION_INVALID { Reason, Step })
	 */
	resolvePath(pFrom, pSteps, pOptions)
	{
		let tmpOptions = isPlainObject(pOptions) ? pOptions : {};
		let tmpMaxHops = (Number.isInteger(tmpOptions.MaxHops) && (tmpOptions.MaxHops > 0)) ? tmpOptions.MaxHops : this.options.Limits.MaxHops;
		if ((typeof(pFrom) !== 'string') || (this._Entities.indexOf(pFrom) < 0))
		{
			throw pathError('UnknownEntity', null, { Entity: (typeof(pFrom) === 'string') ? pFrom : null });
		}
		let tmpEntries = this.spliceAliases(pSteps, tmpOptions.Aliases);
		if (tmpEntries.length < 1)
		{
			throw pathError('InvalidPath', null);
		}
		if (tmpEntries.length > tmpMaxHops)
		{
			throw pathError('TooManyHops', tmpMaxHops, { MaxHops: tmpMaxHops });
		}
		let tmpCurrent = pFrom;
		let tmpSteps = [];
		for (let i = 0; i < tmpEntries.length; i++)
		{
			let tmpStep = this._resolveStep(tmpCurrent, tmpEntries[i], i);
			tmpSteps.push(tmpStep);
			tmpCurrent = tmpStep.To;
		}
		let tmpPlan = (
			{
				From: pFrom,
				To: tmpCurrent,
				Steps: tmpSteps,
				Hops: tmpSteps.length,
				ToOne: tmpSteps.every((pStep) => { return pStep.Direction === 'Forward'; }),
				Signature: ''
			});
		tmpPlan.Signature = this.pathSignature(tmpPlan);
		return tmpPlan;
	}

	/**
	 * The step Raw strings (aliases spliced, Where / Scope ignored) joined by ' '.
	 *
	 * @param {Record<string, any>} pPathPlan
	 * @return {string}
	 */
	pathSignature(pPathPlan)
	{
		if (!isPlainObject(pPathPlan) || !Array.isArray(pPathPlan.Steps))
		{
			return '';
		}
		return pPathPlan.Steps.map((pStep) => { return pStep.Raw; }).join(' ');
	}

	/**
	 * @return {Array<Record<string, any>>} build warnings (unresolved / ambiguous joins, ambiguous aliases)
	 */
	warnings()
	{
		return this._Warnings.slice();
	}

	/**
	 * @return {Record<string, any>|null} the model object this graph was built from
	 */
	builtFrom()
	{
		return this._Model;
	}

	/**
	 * @return {string} 'g:' + 12 hex
	 */
	graphHash()
	{
		return this._GraphHash;
	}
}

module.exports = RetoldFacetingGraph;
module.exports.serviceType = 'RetoldFacetingGraph';
module.exports.DEFAULT_TENANT_COLUMNS = DEFAULT_TENANT_COLUMNS;
module.exports.canonicalJSON = canonicalJSON;
module.exports.AUDIT_USER_COLUMNS = AUDIT_USER_COLUMNS;
module.exports.AUDIT_USER_MEADOW_TYPES = AUDIT_USER_MEADOW_TYPES;
module.exports.AUDIT_STAMP_MEADOW_TYPES = AUDIT_STAMP_MEADOW_TYPES;
module.exports.AUDIT_STAMP_COLUMN_NAMES = AUDIT_STAMP_COLUMN_NAMES;
module.exports.sha1Hex = sha1Hex;
module.exports.primaryKeyOf = primaryKeyOf;
module.exports.tableNames = tableNames;
module.exports.STEP_PATTERN = STEP_PATTERN;
module.exports.ALIAS_STEP_PATTERN = ALIAS_STEP_PATTERN;
module.exports.pathError = pathError;
