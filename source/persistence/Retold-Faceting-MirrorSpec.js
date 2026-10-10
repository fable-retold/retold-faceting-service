/**
 * Retold Faceting - MirrorSpec
 *
 * Compiles RetoldFaceting.Materialize (validated against Materialize-Schema.json) into one MirrorSpec
 * per (store, entity) (design 04 §4, internal-contracts §55): the mirrored columns (identity, every
 * policy column, the delete column, UpdateDate / CreateDate, every Join column, every filterable column
 * the type map mirrors — never Sensitive / Text / JSON / long String / GUID unless named), the sort key
 * (tenant[, owner], identity), TrackedKeyColumns, KeymapColumns, the source projection, the watermark
 * and the SpecHash.  It also answers the closure rule: covers(pStore, pDepSet) — a fold is
 * store-eligible only if every DepSet entity is mirrored with every column it reads.
 *
 * Invalid entries disable that entity in that store (logged, listed by disabled()), never a partial
 * spec; the design's PathColumns / RelationFields / Rollups / Aggregates / Dictionary load with an
 * 'Unsupported:<Key>' warning and are ignored in M5 (§68 #4).  No closure entity is ever added
 * automatically: definitions whose entities are not all mirrored produce 'ClosureIncomplete' warnings.
 *
 *   compile(pMaterialize?, pEnvironment?)  → { Specs: { Store: { Entity: MirrorSpec } }, Disabled, Warnings }   (stores the result)
 *   validate(pMaterialize, pEnvironment?)  → { Valid, Errors, Warnings }                                        (no state change)
 *   spec(pStore, pEntity) / specs(pStore) / entities(pStore) / stores()
 *   covers(pStore, pDepSet, pFilling)      → { Covered, Reason }
 *   column(pStore, pEntity, pColumn)       → spec column | null
 *   classifyChange(pTableReport, pSpec)    → { Kind: 'Same' | 'Additive' | 'Rebuild' | 'Absent', Added, KeymapAdded, Reason }   (§55.4)
 *   declareAll(pStores, pEnvironment?)     → a Materialize declaration of every facetable entity (tests, the harness)
 *   disabled() / warnings()
 *   validateSchema(pValue, pRef?)          (static) the built-in draft-07 subset validator over Materialize-Schema.json
 *
 * Contract: internal-contracts §55.  Owner: builder A (M5).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetUtil = require('../contract/Facet-Contract-Util.js');
const libFacetClauses = require('../contract/Facet-Contract-Clauses.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');
const libTypeMap = require('../store/clickhouse/ClickHouse-TypeMap.js');
const libDDL = require('../store/clickhouse/ClickHouse-DDL.js');

// Bumped when the compilation rules change shape.
const SPEC_VERSION = 1;

// The Materialize declaration schema (draft-07; the built-in validator below applies it).
const MATERIALIZE_SCHEMA = require('./Materialize-Schema.json');

// Design keys accepted with a warning and ignored in M5 (§55.1).
const UNSUPPORTED_KEYS = Object.freeze([ 'PathColumns', 'RelationFields', 'Rollups', 'Aggregates', 'Dictionary' ]);

// The stores M5 builds specs for (a declaration may name the others; they must still be configured).
const STORE_NAMES = Object.freeze([ 'ClickHouse', 'Solr', 'OpenSearch' ]);

// Strings longer than this are not mirrored by 'Auto' (IncludeColumns opts one in).
const AUTO_MAX_STRING_SIZE = 256;
// Stricture's default String size when a model column has none.
const DEFAULT_STRING_SIZE = 64;

// The disabled-entry reasons.
const REASONS = Object.freeze(
	[
		'Schema', 'StoreNotConfigured', 'UnknownEntity', 'NoDAL', 'ReservedName', 'MetaColumnName', 'UnknownColumn',
		'ExcludeRequired', 'ColumnNotMirrorable', 'NoIdentity', 'ScopeColumnType', 'NoWatermarkColumn', 'NoCatalog'
	]);

const hasOwn = libFacetUtil.hasOwn;
const isPlainObject = libFacetUtil.isPlainObject;

// ------------------------------------------------------------------ the built-in schema validator

/**
 * A JSON-pointer token.
 *
 * @param {string} pKey
 * @return {string}
 */
const pointerToken = (pKey) =>
{
	return String(pKey).replace(/~/g, '~0').replace(/\//g, '~1');
};

/**
 * Does a value have a draft-07 type?
 *
 * @param {string} pType
 * @param {any} pValue
 * @return {boolean}
 */
const typeMatches = (pType, pValue) =>
{
	switch (pType)
	{
		case 'object':
			return isPlainObject(pValue);
		case 'array':
			return Array.isArray(pValue);
		case 'string':
			return (typeof(pValue) === 'string');
		case 'boolean':
			return (typeof(pValue) === 'boolean');
		case 'number':
			return (typeof(pValue) === 'number') && Number.isFinite(pValue);
		case 'integer':
			return Number.isInteger(pValue);
		case 'null':
			return (pValue === null);
		default:
			return false;
	}
};

/**
 * Resolve a local '#/definitions/X' reference.
 *
 * @param {Record<string, any>} pRoot
 * @param {string} pRef
 * @return {any}
 */
const resolveRef = (pRoot, pRef) =>
{
	if (pRef === '#')
	{
		return pRoot;
	}
	if (typeof(pRef) !== 'string' || (pRef.indexOf('#/') !== 0))
	{
		return undefined;
	}
	let tmpNode = pRoot;
	let tmpParts = pRef.slice(2).split('/').map((pPart) => { return pPart.replace(/~1/g, '/').replace(/~0/g, '~'); });
	for (let i = 0; i < tmpParts.length; i++)
	{
		if (!isPlainObject(tmpNode) || !hasOwn(tmpNode, tmpParts[i]))
		{
			return undefined;
		}
		tmpNode = tmpNode[tmpParts[i]];
	}
	return tmpNode;
};

/**
 * Validate a value against a schema node: the draft-07 keywords Materialize-Schema.json uses (type
 * enum const pattern propertyNames required properties additionalProperties items minItems maxItems
 * minLength maxLength oneOf anyOf $ref).  Returns the first error, or null.
 *
 * @param {Record<string, any>} pRoot
 * @param {any} pSchema
 * @param {any} pValue
 * @param {string} pPointer
 * @return {{ Pointer: string, Keyword: string, Message: string }|null}
 */
const validateNode = (pRoot, pSchema, pValue, pPointer) =>
{
	let fError = (pKeyword, pMessage, pAt) =>
	{
		return { Pointer: (typeof(pAt) === 'string') ? pAt : pPointer, Keyword: pKeyword, Message: pMessage };
	};
	if (pSchema === true)
	{
		return null;
	}
	if (pSchema === false)
	{
		return fError('false', 'No value is allowed here.');
	}
	if (!isPlainObject(pSchema))
	{
		return null;
	}
	if (typeof(pSchema.$ref) === 'string')
	{
		let tmpTarget = resolveRef(pRoot, pSchema.$ref);
		if (typeof(tmpTarget) === 'undefined')
		{
			return fError('$ref', 'Unresolvable $ref.');
		}
		return validateNode(pRoot, tmpTarget, pValue, pPointer);
	}
	if (hasOwn(pSchema, 'type'))
	{
		let tmpTypes = Array.isArray(pSchema.type) ? pSchema.type : [ pSchema.type ];
		if (!tmpTypes.some((pType) => { return typeMatches(pType, pValue); }))
		{
			return fError('type', `Expected ${tmpTypes.join(' | ')}.`);
		}
	}
	if (hasOwn(pSchema, 'const') && (libFacetClauses.canonicalJSON(pSchema.const) !== libFacetClauses.canonicalJSON(pValue)))
	{
		return fError('const', 'Unexpected value.');
	}
	if (Array.isArray(pSchema.enum))
	{
		let tmpValueJSON = libFacetClauses.canonicalJSON(pValue);
		if (!pSchema.enum.some((pAllowed) => { return libFacetClauses.canonicalJSON(pAllowed) === tmpValueJSON; }))
		{
			return fError('enum', 'Not one of the allowed values.');
		}
	}
	if (typeof(pValue) === 'string')
	{
		let tmpLength = Array.from(pValue).length;
		if ((typeof(pSchema.minLength) === 'number') && (tmpLength < pSchema.minLength))
		{
			return fError('minLength', `Shorter than ${pSchema.minLength}.`);
		}
		if ((typeof(pSchema.maxLength) === 'number') && (tmpLength > pSchema.maxLength))
		{
			return fError('maxLength', `Longer than ${pSchema.maxLength}.`);
		}
		if ((typeof(pSchema.pattern) === 'string') && !(new RegExp(pSchema.pattern)).test(pValue))
		{
			return fError('pattern', 'Does not match the required pattern.');
		}
	}
	if (Array.isArray(pValue))
	{
		if ((typeof(pSchema.minItems) === 'number') && (pValue.length < pSchema.minItems))
		{
			return fError('minItems', `Fewer than ${pSchema.minItems} items.`);
		}
		if ((typeof(pSchema.maxItems) === 'number') && (pValue.length > pSchema.maxItems))
		{
			return fError('maxItems', `More than ${pSchema.maxItems} items.`);
		}
		if (hasOwn(pSchema, 'items') && !Array.isArray(pSchema.items))
		{
			for (let i = 0; i < pValue.length; i++)
			{
				let tmpItemError = validateNode(pRoot, pSchema.items, pValue[i], `${pPointer}/${i}`);
				if (tmpItemError)
				{
					return tmpItemError;
				}
			}
		}
	}
	if (isPlainObject(pValue))
	{
		let tmpKeys = Object.keys(pValue);
		if (Array.isArray(pSchema.required))
		{
			for (let i = 0; i < pSchema.required.length; i++)
			{
				if (!hasOwn(pValue, pSchema.required[i]))
				{
					return fError('required', `Missing ${pSchema.required[i]}.`);
				}
			}
		}
		if (hasOwn(pSchema, 'propertyNames'))
		{
			for (let i = 0; i < tmpKeys.length; i++)
			{
				if (validateNode(pRoot, pSchema.propertyNames, tmpKeys[i], `${pPointer}/${pointerToken(tmpKeys[i])}`))
				{
					return fError('propertyNames', 'A property name is not allowed.', `${pPointer}/${pointerToken(tmpKeys[i])}`);
				}
			}
		}
		let tmpProperties = isPlainObject(pSchema.properties) ? pSchema.properties : {};
		for (let i = 0; i < tmpKeys.length; i++)
		{
			let tmpKey = tmpKeys[i];
			let tmpChildPointer = `${pPointer}/${pointerToken(tmpKey)}`;
			if (hasOwn(tmpProperties, tmpKey))
			{
				let tmpPropertyError = validateNode(pRoot, tmpProperties[tmpKey], pValue[tmpKey], tmpChildPointer);
				if (tmpPropertyError)
				{
					return tmpPropertyError;
				}
				continue;
			}
			if (pSchema.additionalProperties === false)
			{
				return fError('additionalProperties', `Unknown property ${JSON.stringify(tmpKey)}.`, tmpChildPointer);
			}
			if (isPlainObject(pSchema.additionalProperties))
			{
				let tmpAdditionalError = validateNode(pRoot, pSchema.additionalProperties, pValue[tmpKey], tmpChildPointer);
				if (tmpAdditionalError)
				{
					return tmpAdditionalError;
				}
			}
		}
	}
	if (Array.isArray(pSchema.anyOf))
	{
		let tmpFirstError = null;
		let tmpMatched = false;
		for (let i = 0; i < pSchema.anyOf.length; i++)
		{
			let tmpBranchError = validateNode(pRoot, pSchema.anyOf[i], pValue, pPointer);
			if (!tmpBranchError)
			{
				tmpMatched = true;
				break;
			}
			tmpFirstError = tmpFirstError || tmpBranchError;
		}
		if (!tmpMatched)
		{
			return tmpFirstError || fError('anyOf', 'Matches none of the allowed shapes.');
		}
	}
	if (Array.isArray(pSchema.oneOf))
	{
		let tmpFirstError = null;
		let tmpMatches = 0;
		for (let i = 0; i < pSchema.oneOf.length; i++)
		{
			let tmpBranchError = validateNode(pRoot, pSchema.oneOf[i], pValue, pPointer);
			if (tmpBranchError)
			{
				tmpFirstError = tmpFirstError || tmpBranchError;
			}
			else
			{
				tmpMatches++;
			}
		}
		if (tmpMatches === 0)
		{
			return tmpFirstError || fError('oneOf', 'Matches none of the allowed shapes.');
		}
		if (tmpMatches > 1)
		{
			return fError('oneOf', 'Matches more than one allowed shape.');
		}
	}
	return null;
};

/**
 * Validate a value against Materialize-Schema.json ('#' = the whole declaration,
 * '#/definitions/EntityDeclaration' = one entry).
 *
 * @param {any} pValue
 * @param {string} [pRef]
 * @param {string} [pPointer]
 * @return {{ Pointer: string, Keyword: string, Message: string }|null}
 */
const validateSchema = (pValue, pRef, pPointer) =>
{
	return validateNode(MATERIALIZE_SCHEMA, { $ref: pRef || '#' }, pValue, pPointer || '');
};

/**
 * Deep-freeze a plain value.
 *
 * @param {any} pValue
 * @return {any}
 */
const deepFreeze = (pValue) =>
{
	if (pValue && (typeof(pValue) === 'object') && !Object.isFrozen(pValue))
	{
		Object.freeze(pValue);
		Object.keys(pValue).forEach((pKey) => { deepFreeze(pValue[pKey]); });
	}
	return pValue;
};

/**
 * A numeric String size (Stricture sizes are strings: '128', 'int', 'Default').
 *
 * @param {any} pSize
 * @return {number}
 */
const stringSize = (pSize) =>
{
	let tmpSize = (typeof(pSize) === 'number') ? pSize : parseInt(String((pSize === null) || (typeof(pSize) === 'undefined') ? '' : pSize), 10);
	return (Number.isInteger(tmpSize) && (tmpSize > 0)) ? tmpSize : DEFAULT_STRING_SIZE;
};

/**
 * Is a catalog column a GUID (the catalog's rule: DataType GUID, MeadowType AutoGUID, or a name
 * starting with 'GUID')?
 *
 * @param {Record<string, any>} pInfo
 * @return {boolean}
 */
const isGUIDColumn = (pInfo) =>
{
	return (pInfo.DataType === 'GUID') || (pInfo.MeadowType === 'AutoGUID') || (String(pInfo.Column).indexOf('GUID') === 0);
};

/**
 * Unique, order-preserving.
 *
 * @param {Array<any>} pList
 * @return {Array<any>}
 */
const unique = (pList) =>
{
	let tmpSeen = new Set();
	let tmpResult = [];
	for (let i = 0; i < pList.length; i++)
	{
		if ((pList[i] === null) || (typeof(pList[i]) === 'undefined') || tmpSeen.has(pList[i]))
		{
			continue;
		}
		tmpSeen.add(pList[i]);
		tmpResult.push(pList[i]);
	}
	return tmpResult;
};

/**
 * The SpecHash (§55.2 rule 4).
 *
 * @param {Array<Record<string, any>>} pColumns
 * @param {Array<string>} pSortKey
 * @param {Array<string>} pKeymapColumns
 * @return {string}
 */
const specHash = (pColumns, pSortKey, pKeymapColumns) =>
{
	let tmpPairs = pColumns.map((pColumn) => { return [ pColumn.Column, pColumn.Mirror ]; }).sort((pA, pB) => { return (pA[0] < pB[0]) ? -1 : ((pA[0] > pB[0]) ? 1 : 0); });
	let tmpMaterial = libFacetClauses.canonicalJSON(
		{
			Columns: tmpPairs,
			SortKey: pSortKey,
			KeymapColumns: pKeymapColumns,
			TypeMap: libTypeMap.TYPE_MAP_VERSION,
			DDL: libDDL.DDL_VERSION
		});
	return `ms:${libRetoldFacetingUtil.sha1Hex(tmpMaterial).slice(0, 8)}`;
};

class RetoldFacetingMirrorSpec extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingMirrorSpec';

		this._Specs = {};
		this._Disabled = [];
		this._Warnings = [];
	}

	/**
	 * The compile environment: Catalog, Host, Registry, Options and the configured store names.
	 *
	 * @param {Record<string, any>} [pEnvironment]
	 * @return {{ Catalog: any, Host: any, Registry: any, Options: Record<string, any>, Stores: Array<string> }}
	 */
	_environment(pEnvironment)
	{
		let tmpEnvironment = isPlainObject(pEnvironment) ? pEnvironment : {};
		let tmpService = this.fable.RetoldFacetingService;
		let tmpOptions = isPlainObject(tmpEnvironment.Options) ? tmpEnvironment.Options : this.options;
		let tmpStores = Array.isArray(tmpEnvironment.Stores) ? tmpEnvironment.Stores.slice()
			: STORE_NAMES.filter((pStore) => { return isPlainObject(tmpOptions.Stores) && isPlainObject(tmpOptions.Stores[pStore]); });
		return (
			{
				Catalog: hasOwn(tmpEnvironment, 'Catalog') ? tmpEnvironment.Catalog : (this.fable.RetoldFacetingCatalog || null),
				Host: hasOwn(tmpEnvironment, 'Host') ? tmpEnvironment.Host : ((tmpService && tmpService.Host) || this.fable.RetoldFacetingHostDataService || null),
				Registry: hasOwn(tmpEnvironment, 'Registry') ? tmpEnvironment.Registry : (this.fable.RetoldFacetingDefinitionRegistry || null),
				Options: tmpOptions,
				Stores: tmpStores
			});
	}

	/**
	 * The entity's scope columns (Host.entityScopeColumns, else an Unscoped descriptor).
	 *
	 * @param {Record<string, any>} pEnvironment
	 * @param {string} pEntity
	 * @param {Record<string, any>} pDescriptor - the catalog EntityDescriptor
	 * @return {Record<string, any>}
	 */
	_scopeColumns(pEnvironment, pEntity, pDescriptor)
	{
		let tmpHost = pEnvironment.Host;
		if (tmpHost && (typeof(tmpHost.entityScopeColumns) === 'function'))
		{
			try
			{
				return tmpHost.entityScopeColumns(pEntity);
			}
			catch (pError)
			{
				this.fable.log.warn(`RetoldFaceting MirrorSpec: entityScopeColumns(${pEntity}) failed; treating it as Unscoped.`);
			}
		}
		return { Entity: pEntity, Kind: 'Unscoped', TenantColumn: null, OwnerColumn: null, RequiredColumns: [], DeleteColumn: pDescriptor.DeleteColumn || null, PrimaryKey: pDescriptor.PK || null };
	}

	/**
	 * The policy's UnsetValues.
	 *
	 * @param {Record<string, any>} pEnvironment
	 * @return {Array<any>}
	 */
	_unsetValues(pEnvironment)
	{
		let tmpHost = pEnvironment.Host;
		if (tmpHost && (typeof(tmpHost.getScopePolicy) === 'function'))
		{
			try
			{
				let tmpPolicy = tmpHost.getScopePolicy();
				if (tmpPolicy && Array.isArray(tmpPolicy.UnsetValues))
				{
					return tmpPolicy.UnsetValues.slice();
				}
			}
			catch (pError)
			{
				// fall through to the options
			}
		}
		let tmpScope = isPlainObject(pEnvironment.Options.Scope) ? pEnvironment.Options.Scope : {};
		return Array.isArray(tmpScope.UnsetValues) ? tmpScope.UnsetValues.slice() : [ 0, '', null ];
	}

	/**
	 * The raw model table of an entity (for column names the catalog hides and index declarations).
	 *
	 * @param {Record<string, any>} pEnvironment
	 * @param {string} pEntity
	 * @return {Record<string, any>|null}
	 */
	_modelTable(pEnvironment, pEntity)
	{
		let tmpHost = pEnvironment.Host;
		if (tmpHost && (typeof(tmpHost.getEntityModel) === 'function'))
		{
			try
			{
				return tmpHost.getEntityModel(pEntity);
			}
			catch (pError)
			{
				return null;
			}
		}
		return null;
	}

	/**
	 * Is a column indexed in the model (column-level Indexed, MeadowSchema Indexed, or the first
	 * column of a declared index)?
	 *
	 * @param {Record<string, any>|null} pTable
	 * @param {string} pColumn
	 * @return {boolean}
	 */
	_isIndexed(pTable, pColumn)
	{
		if (!isPlainObject(pTable))
		{
			return false;
		}
		let tmpColumnLists = [ Array.isArray(pTable.Columns) ? pTable.Columns : [] ];
		if (isPlainObject(pTable.MeadowSchema) && Array.isArray(pTable.MeadowSchema.Schema))
		{
			tmpColumnLists.push(pTable.MeadowSchema.Schema);
		}
		for (let i = 0; i < tmpColumnLists.length; i++)
		{
			let tmpEntry = tmpColumnLists[i].find((pEntry) => { return pEntry && (pEntry.Column === pColumn); });
			if (tmpEntry && tmpEntry.Indexed)
			{
				return true;
			}
		}
		let tmpIndexLists = [];
		if (Array.isArray(pTable.Indices))
		{
			tmpIndexLists.push(pTable.Indices);
		}
		if (isPlainObject(pTable.MeadowSchema) && Array.isArray(pTable.MeadowSchema.Indices))
		{
			tmpIndexLists.push(pTable.MeadowSchema.Indices);
		}
		for (let i = 0; i < tmpIndexLists.length; i++)
		{
			for (let j = 0; j < tmpIndexLists[i].length; j++)
			{
				let tmpIndex = tmpIndexLists[i][j];
				if (tmpIndex && Array.isArray(tmpIndex.Columns) && (tmpIndex.Columns[0] === pColumn))
				{
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * The semantic checks of one entry that do not depend on the store; null when it passes.
	 *
	 * @param {Record<string, any>} pEnvironment
	 * @param {string} pEntity
	 * @param {Record<string, any>} pEntry
	 * @return {{ Reason: string, Column?: string, Pointer: string }|null}
	 */
	_checkEntry(pEnvironment, pEntity, pEntry)
	{
		let tmpCatalog = pEnvironment.Catalog;
		let tmpPointer = `/${pointerToken(pEntity)}`;
		if (!tmpCatalog || (typeof(tmpCatalog.getFacetable) !== 'function'))
		{
			return { Reason: 'NoCatalog', Pointer: tmpPointer };
		}
		let tmpCatalogOptions = isPlainObject(pEnvironment.Options.Catalog) ? pEnvironment.Options.Catalog : {};
		let tmpNever = libOptions.NEVER_FACETABLE.concat(Array.isArray(tmpCatalogOptions.NeverFacet) ? tmpCatalogOptions.NeverFacet : []);
		if ((pEntity.indexOf('_rfs_') === 0) || (tmpNever.indexOf(pEntity) >= 0) || (libOptions.ROUTE_RESERVED_NAMES.indexOf(pEntity) >= 0))
		{
			return { Reason: 'ReservedName', Pointer: tmpPointer };
		}
		let tmpDescriptor = tmpCatalog.getFacetable(pEntity);
		if (!tmpDescriptor)
		{
			return { Reason: 'UnknownEntity', Pointer: tmpPointer };
		}
		let tmpHost = pEnvironment.Host;
		if (tmpHost && (typeof(tmpHost.getDAL) === 'function') && !tmpHost.getDAL(pEntity))
		{
			return { Reason: 'NoDAL', Pointer: tmpPointer };
		}
		// A model column named like a meta column (the catalog hides Sensitive ones; the model has them all).
		let tmpModelTable = this._modelTable(pEnvironment, pEntity);
		let tmpModelColumns = (tmpModelTable && Array.isArray(tmpModelTable.Columns)) ? tmpModelTable.Columns.map((pColumn) => { return pColumn ? pColumn.Column : null; }) : Object.keys(tmpDescriptor.Columns || {});
		let tmpMeta = tmpModelColumns.find((pColumn) => { return libDDL.META_COLUMNS.indexOf(pColumn) >= 0; });
		if (tmpMeta)
		{
			return { Reason: 'MetaColumnName', Column: tmpMeta, Pointer: tmpPointer };
		}
		let tmpLists = [ [ 'Columns', Array.isArray(pEntry.Columns) ? pEntry.Columns : [] ], [ 'IncludeColumns', pEntry.IncludeColumns || [] ], [ 'ExcludeColumns', pEntry.ExcludeColumns || [] ] ];
		for (let i = 0; i < tmpLists.length; i++)
		{
			for (let j = 0; j < tmpLists[i][1].length; j++)
			{
				let tmpColumn = tmpLists[i][1][j];
				// Unknown and Sensitive get the same answer (the catalog hides Sensitive columns).
				if (!tmpCatalog.column(pEntity, tmpColumn))
				{
					return { Reason: 'UnknownColumn', Column: tmpColumn, Pointer: `${tmpPointer}/${tmpLists[i][0]}/${j}` };
				}
			}
		}
		let tmpScope = this._scopeColumns(pEnvironment, pEntity, tmpDescriptor);
		let tmpRequired = unique([ tmpScope.PrimaryKey || tmpDescriptor.PK, tmpScope.TenantColumn, tmpScope.OwnerColumn, tmpScope.DeleteColumn || tmpDescriptor.DeleteColumn ].concat(tmpScope.RequiredColumns || []));
		let tmpExclude = pEntry.ExcludeColumns || [];
		for (let j = 0; j < tmpExclude.length; j++)
		{
			if (tmpRequired.indexOf(tmpExclude[j]) >= 0)
			{
				return { Reason: 'ExcludeRequired', Column: tmpExclude[j], Pointer: `${tmpPointer}/ExcludeColumns/${j}` };
			}
		}
		return null;
	}

	/**
	 * Build one spec (the entry passed _checkEntry); { Spec } or { Disabled: { Reason, Column?, Pointer } }.
	 *
	 * @param {Record<string, any>} pEnvironment
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {Record<string, any>} pEntry
	 * @param {Array<string>} pWarnings - the entry's warning codes
	 * @return {{ Spec?: Record<string, any>, Disabled?: Record<string, any> }}
	 */
	_buildSpec(pEnvironment, pStore, pEntity, pEntry, pWarnings)
	{
		let tmpCatalog = pEnvironment.Catalog;
		let tmpPointer = `/${pointerToken(pEntity)}`;
		let tmpDescriptor = tmpCatalog.getFacetable(pEntity);
		let tmpScope = this._scopeColumns(pEnvironment, pEntity, tmpDescriptor);
		let tmpIdentity = tmpScope.PrimaryKey || tmpDescriptor.PK;
		let tmpIdentityInfo = tmpIdentity ? tmpCatalog.column(pEntity, tmpIdentity) : null;
		if (!tmpIdentityInfo || (libTypeMap.mirrorType(tmpIdentityInfo, 'Identity') !== 'Int64'))
		{
			return { Disabled: { Reason: 'NoIdentity', Column: tmpIdentity || null, Pointer: tmpPointer } };
		}
		let tmpTenant = (tmpScope.TenantColumn && (tmpScope.TenantColumn !== tmpIdentity)) ? tmpScope.TenantColumn : null;
		let tmpOwner = (tmpScope.OwnerColumn && (tmpScope.OwnerColumn !== tmpIdentity)) ? tmpScope.OwnerColumn : null;
		let tmpRequiredColumns = (Array.isArray(tmpScope.RequiredColumns) ? tmpScope.RequiredColumns : []).filter((pColumn) => { return (pColumn !== tmpIdentity) && (pColumn !== tmpTenant) && (pColumn !== tmpOwner); });
		let tmpDelete = tmpScope.DeleteColumn || tmpDescriptor.DeleteColumn || null;
		let tmpCatalogNames = Object.keys(tmpDescriptor.Columns || {});
		let tmpHasUpdateDate = !!tmpCatalog.column(pEntity, 'UpdateDate');
		let tmpHasCreateDate = !!tmpCatalog.column(pEntity, 'CreateDate');
		let tmpJoinColumns = tmpCatalogNames.filter((pColumn) => { let tmpInfo = tmpCatalog.column(pEntity, pColumn); return !!(tmpInfo && tmpInfo.Join); });

		// Scope columns must be mirrorable (and visible to the catalog).
		let tmpScopeColumns = [ [ tmpTenant, 'Tenant' ], [ tmpOwner, 'Owner' ] ].concat(tmpRequiredColumns.map((pColumn) => { return [ pColumn, 'Required' ]; }));
		for (let i = 0; i < tmpScopeColumns.length; i++)
		{
			if (!tmpScopeColumns[i][0])
			{
				continue;
			}
			let tmpInfo = tmpCatalog.column(pEntity, tmpScopeColumns[i][0]);
			if (!tmpInfo || !libTypeMap.mirrorType(tmpInfo, tmpScopeColumns[i][1]))
			{
				return { Disabled: { Reason: 'ScopeColumnType', Column: tmpScopeColumns[i][0], Pointer: tmpPointer } };
			}
		}

		// Watermark (§60.1).
		let tmpWatermark = null;
		if (pEntry.Watermark === 'UpdateDate')
		{
			if (!tmpHasUpdateDate || ((pEntry.ExcludeColumns || []).indexOf('UpdateDate') >= 0))
			{
				return { Disabled: { Reason: 'NoWatermarkColumn', Column: 'UpdateDate', Pointer: `${tmpPointer}/Watermark` } };
			}
			tmpWatermark = 'UpdateDate';
		}
		else if ((pEntry.Watermark === 'Auto') || (typeof(pEntry.Watermark) === 'undefined'))
		{
			if (tmpHasUpdateDate && ((pEntry.ExcludeColumns || []).indexOf('UpdateDate') < 0) && this._isIndexed(this._modelTable(pEnvironment, pEntity), 'UpdateDate'))
			{
				tmpWatermark = 'UpdateDate';
			}
		}

		// The always-added columns, then 'Auto' or the explicit list (§55.2 rule 1).
		let tmpAlways = unique([ tmpIdentity, tmpTenant, tmpOwner ].concat(tmpRequiredColumns, [ tmpDelete, tmpHasUpdateDate ? 'UpdateDate' : null ], tmpJoinColumns));
		let tmpExclude = pEntry.ExcludeColumns || [];
		let tmpNamed = [];
		let tmpAuto = ((typeof(pEntry.Columns) === 'undefined') || (pEntry.Columns === 'Auto'));
		if (tmpAuto)
		{
			if (tmpHasCreateDate)
			{
				tmpNamed.push('CreateDate');
			}
			tmpCatalogNames.forEach(
				(pColumn) =>
				{
					let tmpInfo = tmpCatalog.column(pEntity, pColumn);
					if (!tmpInfo || !tmpInfo.Filterable || isGUIDColumn(tmpInfo) || !libTypeMap.mirrorType(tmpInfo, 'Column'))
					{
						return;
					}
					if ((tmpInfo.DataType === 'String') && (stringSize(tmpInfo.Size) > AUTO_MAX_STRING_SIZE))
					{
						return;
					}
					tmpNamed.push(pColumn);
				});
		}
		else
		{
			tmpNamed = tmpNamed.concat(pEntry.Columns);
		}
		let tmpIncluded = (pEntry.IncludeColumns || []).slice();
		// ExcludeColumns never names a scope / identity / delete column (_checkEntry refuses that entry).
		let tmpProtected = [ tmpIdentity, tmpTenant, tmpOwner, tmpDelete ].concat(tmpRequiredColumns);
		let tmpSelected = unique(tmpAlways.concat(tmpNamed, tmpIncluded)).filter((pColumn) => { return (tmpProtected.indexOf(pColumn) >= 0) || (tmpExclude.indexOf(pColumn) < 0); });

		// Order: identity, tenant, owner, then model (catalog) order.
		let tmpLeading = unique([ tmpIdentity, tmpTenant, tmpOwner ]);
		let tmpOrdered = tmpLeading.concat(tmpCatalogNames.filter((pColumn) => { return (tmpLeading.indexOf(pColumn) < 0) && (tmpSelected.indexOf(pColumn) >= 0); }));
		let tmpColumns = [];
		for (let i = 0; i < tmpOrdered.length; i++)
		{
			let tmpName = tmpOrdered[i];
			let tmpInfo = tmpCatalog.column(pEntity, tmpName);
			let tmpRole = (tmpName === tmpIdentity) ? 'Identity'
				: (tmpName === tmpTenant) ? 'Tenant'
				: (tmpName === tmpOwner) ? 'Owner'
				: (tmpRequiredColumns.indexOf(tmpName) >= 0) ? 'Required'
				: (tmpName === tmpDelete) ? 'Delete'
				: ((tmpName === 'UpdateDate') && (tmpWatermark === 'UpdateDate')) ? 'Watermark'
				: (tmpInfo && tmpInfo.Join) ? 'FK'
				: 'Column';
			let tmpMirror = tmpInfo ? libTypeMap.mirrorType(tmpInfo, tmpRole) : null;
			if (!tmpMirror)
			{
				return { Disabled: { Reason: 'ColumnNotMirrorable', Column: tmpName, Pointer: tmpPointer } };
			}
			tmpColumns.push(
				{
					Column: tmpName,
					DataType: tmpInfo.DataType,
					Mirror: tmpMirror,
					Role: tmpRole,
					Join: tmpInfo.Join || null,
					IsInteger: !!tmpInfo.IsInteger,
					Scale: Number.isInteger(tmpInfo.Scale) ? tmpInfo.Scale : 0
				});
		}
		let tmpColumnNames = tmpColumns.map((pColumn) => { return pColumn.Column; });

		// Sort key (§55.2 rule 3).
		let tmpSortKey;
		if ((tmpScope.Kind === 'Tenant') || (tmpScope.Kind === 'Personal'))
		{
			tmpSortKey = unique([ tmpTenant, tmpOwner, tmpIdentity ]);
		}
		else
		{
			tmpSortKey = [ tmpIdentity ];
		}
		let tmpTracked = unique([ tmpTenant, tmpOwner ].concat(tmpRequiredColumns, tmpJoinColumns)).filter((pColumn) => { return (pColumn !== tmpIdentity) && (tmpColumnNames.indexOf(pColumn) >= 0); });
		let tmpKeymapColumns = unique([ tmpIdentity ].concat(tmpSortKey.filter((pColumn) => { return pColumn !== tmpIdentity; }), tmpTracked, (tmpColumnNames.indexOf('UpdateDate') >= 0) ? [ 'UpdateDate' ] : []));

		let tmpWarnings = pWarnings.slice();
		if (!tmpWatermark)
		{
			tmpWarnings.push('NoWatermark');
		}
		let tmpSpec =
			{
				Entity: pEntity,
				Store: pStore,
				SpecVersion: SPEC_VERSION,
				Identity: tmpIdentity,
				Kind: tmpScope.Kind,
				// The policy's columns as is (a tenant column that is also the identity — Customer — stays named here,
				// so the compiler's fail-closed tenant check still sees it).
				TenantColumn: tmpScope.TenantColumn || null,
				OwnerColumn: tmpScope.OwnerColumn || null,
				RequiredColumns: tmpRequiredColumns,
				DeleteColumn: tmpDelete,
				SortKey: tmpSortKey,
				Columns: tmpColumns,
				ColumnNames: tmpColumnNames.slice().sort(),
				KeymapColumns: tmpKeymapColumns,
				TrackedKeyColumns: tmpTracked,
				SourceColumns: tmpColumnNames.slice(),
				Watermark: tmpWatermark,
				Mutability: 'Mutable',
				UnsetValues: this._unsetValues(pEnvironment),
				Warnings: tmpWarnings,
				SpecHash: specHash(tmpColumns, tmpSortKey, tmpKeymapColumns)
			};
		try
		{
			// The DDL accepts it (identifiers, types, sort / keymap columns).
			libDDL.mirrorDDL('rfs_check', tmpSpec);
			libDDL.keymapDDL('rfs_check', tmpSpec);
		}
		catch (pDDLError)
		{
			return { Disabled: { Reason: 'ColumnNotMirrorable', Column: null, Pointer: tmpPointer } };
		}
		return { Spec: deepFreeze(tmpSpec) };
	}

	/**
	 * Compile without storing.
	 *
	 * @param {Record<string, any>} pMaterialize
	 * @param {Record<string, any>} pEnvironment - resolved
	 * @return {{ Specs: Record<string, Record<string, any>>, Disabled: Array<Record<string, any>>, Warnings: Array<Record<string, any>> }}
	 */
	_compile(pMaterialize, pEnvironment)
	{
		let tmpSpecs = {};
		let tmpDisabled = [];
		let tmpWarnings = [];
		let fDisable = (pStore, pEntity, pProblem) =>
		{
			tmpDisabled.push(Object.assign({ Code: 'FACET_DEFINITION_INVALID', Kind: 'Materialize', Store: pStore, Entity: pEntity }, pProblem));
		};
		if ((pMaterialize === null) || (typeof(pMaterialize) === 'undefined'))
		{
			return { Specs: tmpSpecs, Disabled: tmpDisabled, Warnings: tmpWarnings };
		}
		if (!isPlainObject(pMaterialize))
		{
			fDisable(null, null, { Reason: 'Schema', Pointer: '', Keyword: 'type', Message: 'Expected object.' });
			return { Specs: tmpSpecs, Disabled: tmpDisabled, Warnings: tmpWarnings };
		}
		let tmpEntities = Object.keys(pMaterialize).sort();
		for (let i = 0; i < tmpEntities.length; i++)
		{
			let tmpEntity = tmpEntities[i];
			let tmpEntry = pMaterialize[tmpEntity];
			let tmpPointer = `/${pointerToken(tmpEntity)}`;
			let tmpNameError = validateNode(MATERIALIZE_SCHEMA, MATERIALIZE_SCHEMA.propertyNames, tmpEntity, tmpPointer);
			let tmpSchemaError = tmpNameError ? { Pointer: tmpPointer, Keyword: 'propertyNames', Message: 'An entity name is an identifier.' }
				: validateSchema(tmpEntry, '#/definitions/EntityDeclaration', tmpPointer);
			if (tmpSchemaError)
			{
				let tmpStores = (isPlainObject(tmpEntry) && Array.isArray(tmpEntry.Store)) ? unique(tmpEntry.Store.filter((pStore) => { return typeof(pStore) === 'string'; })) : [];
				if (tmpStores.length < 1)
				{
					tmpStores = [ null ];
				}
				tmpStores.forEach((pStore) => { fDisable(pStore, tmpEntity, { Reason: 'Schema', Pointer: tmpSchemaError.Pointer, Keyword: tmpSchemaError.Keyword, Message: tmpSchemaError.Message }); });
				continue;
			}
			let tmpEntryWarnings = [];
			UNSUPPORTED_KEYS.forEach(
				(pKey) =>
				{
					let tmpValue = tmpEntry[pKey];
					if ((tmpValue === true) || (isPlainObject(tmpValue) && (Object.keys(tmpValue).length > 0)))
					{
						tmpEntryWarnings.push(`Unsupported:${pKey}`);
					}
				});
			if (tmpEntry.Mutability === 'AppendOnly')
			{
				tmpEntryWarnings.push('AppendOnlyTreatedAsMutable');
			}
			let tmpProblem = this._checkEntry(pEnvironment, tmpEntity, tmpEntry);
			let tmpStores = unique(tmpEntry.Store);
			for (let j = 0; j < tmpStores.length; j++)
			{
				let tmpStore = tmpStores[j];
				tmpEntryWarnings.forEach((pCode) => { tmpWarnings.push({ Code: pCode, Kind: 'Materialize', Store: tmpStore, Entity: tmpEntity, Pointer: tmpPointer }); });
				if (pEnvironment.Stores.indexOf(tmpStore) < 0)
				{
					fDisable(tmpStore, tmpEntity, { Reason: 'StoreNotConfigured', Pointer: `${tmpPointer}/Store/${tmpEntry.Store.indexOf(tmpStore)}` });
					continue;
				}
				if (tmpProblem)
				{
					fDisable(tmpStore, tmpEntity, tmpProblem);
					continue;
				}
				let tmpBuilt = this._buildSpec(pEnvironment, tmpStore, tmpEntity, tmpEntry, tmpEntryWarnings);
				if (tmpBuilt.Disabled)
				{
					fDisable(tmpStore, tmpEntity, tmpBuilt.Disabled);
					continue;
				}
				if (!hasOwn(tmpSpecs, tmpStore))
				{
					tmpSpecs[tmpStore] = {};
				}
				tmpSpecs[tmpStore][tmpEntity] = tmpBuilt.Spec;
			}
		}
		this._closureWarnings(pEnvironment, tmpSpecs, tmpWarnings);
		return { Specs: tmpSpecs, Disabled: tmpDisabled, Warnings: tmpWarnings };
	}

	/**
	 * 'ClosureIncomplete': a declared facet / scope homed on a mirrored entity whose Entities are not
	 * all mirrored in that store (it will stay Live; §55.3 — never auto-enabled).
	 *
	 * @param {Record<string, any>} pEnvironment
	 * @param {Record<string, Record<string, any>>} pSpecs
	 * @param {Array<Record<string, any>>} pWarnings
	 */
	_closureWarnings(pEnvironment, pSpecs, pWarnings)
	{
		let tmpRegistry = pEnvironment.Registry;
		if (!tmpRegistry || (typeof(tmpRegistry.facetsFor) !== 'function') || (typeof(tmpRegistry.scopesFor) !== 'function'))
		{
			return;
		}
		Object.keys(pSpecs).sort().forEach(
			(pStore) =>
			{
				let tmpMirrored = pSpecs[pStore];
				Object.keys(tmpMirrored).sort().forEach(
					(pEntity) =>
					{
						let tmpDefinitions = [];
						try
						{
							(tmpRegistry.facetsFor(pEntity) || []).forEach((pFacet) => { tmpDefinitions.push([ 'Facet', pFacet ? pFacet.Facet : null, pFacet ]); });
							(tmpRegistry.scopesFor(pEntity) || []).forEach((pScope) => { tmpDefinitions.push([ 'Scope', pScope ? pScope.Scope : null, pScope ]); });
						}
						catch (pRegistryError)
						{
							return;
						}
						tmpDefinitions.forEach(
							(pDefinition) =>
							{
								let tmpEntities = (pDefinition[2] && Array.isArray(pDefinition[2].Entities)) ? pDefinition[2].Entities : [];
								let tmpMissing = unique(tmpEntities.filter((pEntityName) => { return !hasOwn(tmpMirrored, pEntityName); }));
								if (tmpMissing.length > 0)
								{
									pWarnings.push({ Code: 'ClosureIncomplete', Kind: pDefinition[0], Store: pStore, Entity: pEntity, Name: pDefinition[1], Missing: tmpMissing });
								}
							});
					});
			});
	}

	/**
	 * Compile RetoldFaceting.Materialize into specs and store the result (§55.5).  Invalid entries are
	 * logged once each (no values) and listed by disabled().
	 *
	 * @param {Record<string, any>} [pMaterialize] - default this.options.Materialize
	 * @param {Record<string, any>} [pEnvironment] - { Catalog, Host, Registry, Options, Stores }
	 * @return {{ Specs: Record<string, Record<string, any>>, Disabled: Array<Record<string, any>>, Warnings: Array<Record<string, any>> }}
	 */
	compile(pMaterialize, pEnvironment)
	{
		let tmpEnvironment = this._environment(pEnvironment);
		let tmpMaterialize = (typeof(pMaterialize) === 'undefined') ? tmpEnvironment.Options.Materialize : pMaterialize;
		let tmpResult = this._compile(tmpMaterialize, tmpEnvironment);
		this._Specs = tmpResult.Specs;
		this._Disabled = tmpResult.Disabled;
		this._Warnings = tmpResult.Warnings;
		tmpResult.Disabled.forEach(
			(pEntry) =>
			{
				this.fable.log.error(`RetoldFaceting Materialize entry disabled: ${pEntry.Code} store ${pEntry.Store || '?'} entity ${libRetoldFacetingUtil.logSafe(pEntry.Entity || '?')} reason ${pEntry.Reason}${pEntry.Column ? ` column ${libRetoldFacetingUtil.logSafe(pEntry.Column)}` : ''} at ${pEntry.Pointer || ''}`);
			});
		tmpResult.Warnings.forEach(
			(pWarning) =>
			{
				if (pWarning.Code === 'ClosureIncomplete')
				{
					this.fable.log.warn(`RetoldFaceting Materialize: ${pWarning.Kind} ${libRetoldFacetingUtil.logSafe(pWarning.Name)} reads entities not mirrored in ${pWarning.Store} (${pWarning.Missing.join(', ')}); it stays Live.`);
				}
				else if (pWarning.Code !== 'NoWatermark')
				{
					this.fable.log.warn(`RetoldFaceting Materialize: ${pWarning.Code} on ${pWarning.Store}.${pWarning.Entity} (ignored in M5).`);
				}
			});
		return tmpResult;
	}

	/**
	 * Validate a declaration without changing any state.
	 *
	 * @param {Record<string, any>} pMaterialize
	 * @param {Record<string, any>} [pEnvironment]
	 * @return {{ Valid: boolean, Errors: Array<Record<string, any>>, Warnings: Array<Record<string, any>> }}
	 */
	validate(pMaterialize, pEnvironment)
	{
		let tmpResult = this._compile(pMaterialize, this._environment(pEnvironment));
		return { Valid: (tmpResult.Disabled.length === 0), Errors: tmpResult.Disabled, Warnings: tmpResult.Warnings };
	}

	/**
	 * A declaration that mirrors every facetable entity of the catalog in these stores.
	 *
	 * @param {Array<string>} [pStores] - default [ 'ClickHouse' ]
	 * @param {Record<string, any>} [pEnvironment]
	 * @return {Record<string, Record<string, any>>}
	 */
	declareAll(pStores, pEnvironment)
	{
		let tmpEnvironment = this._environment(pEnvironment);
		let tmpStores = (Array.isArray(pStores) && (pStores.length > 0)) ? pStores.slice() : [ 'ClickHouse' ];
		let tmpDeclaration = {};
		let tmpEntities = (tmpEnvironment.Catalog && (typeof(tmpEnvironment.Catalog.entities) === 'function')) ? tmpEnvironment.Catalog.entities() : [];
		tmpEntities.forEach((pEntity) => { tmpDeclaration[pEntity] = { Store: tmpStores.slice() }; });
		return tmpDeclaration;
	}

	/**
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @return {Record<string, any>|null}
	 */
	spec(pStore, pEntity)
	{
		let tmpStore = this._Specs[pStore];
		return (tmpStore && hasOwn(tmpStore, pEntity)) ? tmpStore[pEntity] : null;
	}

	/**
	 * { Entity: MirrorSpec } of a store (what Store.ensureSchema takes).
	 *
	 * @param {string} pStore
	 * @return {Record<string, Record<string, any>>}
	 */
	specs(pStore)
	{
		return Object.assign({}, this._Specs[pStore] || {});
	}

	/**
	 * @param {string} pStore
	 * @return {Array<string>}
	 */
	entities(pStore)
	{
		return Object.keys(this._Specs[pStore] || {}).sort();
	}

	/**
	 * @return {Array<string>} the stores with at least one spec
	 */
	stores()
	{
		return Object.keys(this._Specs).filter((pStore) => { return Object.keys(this._Specs[pStore]).length > 0; }).sort();
	}

	/**
	 * The closure rule (§55.3): every DepSet entity is mirrored in the store with every column the fold
	 * reads, none of them still filling.  The first failing entity / column (sorted) is the Reason.
	 *
	 * @param {string} pStore
	 * @param {Record<string, Array<string>|Record<string, any>>} pDepSet - { Entity: [ columns ] }
	 * @param {Record<string, Array<string>>} [pFilling] - { Entity: [ columns still being filled ] }
	 * @return {{ Covered: boolean, Reason: string|null }}
	 */
	covers(pStore, pDepSet, pFilling)
	{
		let tmpDepSet = isPlainObject(pDepSet) ? pDepSet : {};
		let tmpFilling = isPlainObject(pFilling) ? pFilling : {};
		let tmpEntities = Object.keys(tmpDepSet).sort();
		for (let i = 0; i < tmpEntities.length; i++)
		{
			let tmpEntity = tmpEntities[i];
			let tmpSpec = this.spec(pStore, tmpEntity);
			if (!tmpSpec)
			{
				return { Covered: false, Reason: `NotMirrored:${tmpEntity}` };
			}
			let tmpRaw = tmpDepSet[tmpEntity];
			let tmpColumns = Array.isArray(tmpRaw) ? tmpRaw.slice() : (isPlainObject(tmpRaw) ? Object.keys(tmpRaw) : []);
			tmpColumns.sort();
			let tmpFillingColumns = Array.isArray(tmpFilling[tmpEntity]) ? tmpFilling[tmpEntity] : [];
			for (let j = 0; j < tmpColumns.length; j++)
			{
				let tmpColumn = tmpColumns[j];
				if ((typeof(tmpColumn) !== 'string') || (tmpColumn.length < 1) || (tmpColumn.charAt(0) === '@'))
				{
					// '@scope:…' / '@path:…' pseudo-fields are not columns (FoldIR.depSet drops them too).
					continue;
				}
				if ((tmpSpec.ColumnNames.indexOf(tmpColumn) < 0) || (tmpFillingColumns.indexOf(tmpColumn) >= 0))
				{
					return { Covered: false, Reason: `NotMirrored:${tmpEntity}.${tmpColumn}` };
				}
			}
		}
		return { Covered: true, Reason: null };
	}

	/**
	 * @param {string} pStore
	 * @param {string} pEntity
	 * @param {string} pColumn
	 * @return {Record<string, any>|null}
	 */
	column(pStore, pEntity, pColumn)
	{
		let tmpSpec = this.spec(pStore, pEntity);
		return tmpSpec ? libTypeMap.specColumn(tmpSpec, pColumn) : null;
	}

	/**
	 * Classify a spec against the live tables (§55.4), from Store.ensureSchema's per-entity report:
	 *
	 *   'Absent'   no live mirror or keymap                                    → backfill
	 *   'Same'     the mirror COMMENT carries this SpecHash                    → resume
	 *   'Additive' every existing column has the same type, the sort keys are
	 *              equal, and the spec only adds (Nullable) columns            → Store.addColumns(Added); fill
	 *   'Rebuild'  anything else (a removed / retyped column, a sort-key change) → shadow rebuild ('SpecChange')
	 *
	 * @param {Record<string, any>|null} pTableReport - { MirrorExists, KeymapExists, SpecHash, ColumnTypes, SortKey, KeymapColumnTypes, KeymapSortKey }
	 * @param {Record<string, any>} pSpec
	 * @return {{ Kind: string, Added: Array<string>, KeymapAdded: Array<string>, Reason: string|null }}
	 */
	classifyChange(pTableReport, pSpec)
	{
		let tmpReport = isPlainObject(pTableReport) ? pTableReport : {};
		if (!tmpReport.MirrorExists || !tmpReport.KeymapExists)
		{
			return { Kind: 'Absent', Added: [], KeymapAdded: [], Reason: tmpReport.MirrorExists ? 'NoKeymap' : 'NoMirror' };
		}
		if (tmpReport.SpecHash && (tmpReport.SpecHash === pSpec.SpecHash))
		{
			return { Kind: 'Same', Added: [], KeymapAdded: [], Reason: null };
		}
		let fSameList = (pA, pB) => { return JSON.stringify(pA || []) === JSON.stringify(pB || []); };
		if (!fSameList(tmpReport.SortKey, pSpec.SortKey))
		{
			return { Kind: 'Rebuild', Added: [], KeymapAdded: [], Reason: 'SortKey' };
		}
		let tmpKeymapOrder = libDDL.keymapOrder(pSpec);
		if (!fSameList(tmpReport.KeymapSortKey, tmpKeymapOrder))
		{
			return { Kind: 'Rebuild', Added: [], KeymapAdded: [], Reason: 'KeymapSortKey' };
		}
		let tmpTypes = isPlainObject(tmpReport.ColumnTypes) ? tmpReport.ColumnTypes : {};
		let tmpKeymapTypes = isPlainObject(tmpReport.KeymapColumnTypes) ? tmpReport.KeymapColumnTypes : {};
		let tmpSpecTypes = {};
		pSpec.Columns.forEach((pColumn) => { tmpSpecTypes[pColumn.Column] = pColumn.Mirror; });
		let tmpExisting = Object.keys(tmpTypes);
		for (let i = 0; i < tmpExisting.length; i++)
		{
			if (!hasOwn(tmpSpecTypes, tmpExisting[i]))
			{
				return { Kind: 'Rebuild', Added: [], KeymapAdded: [], Reason: `RemovedColumn:${tmpExisting[i]}` };
			}
			if (tmpSpecTypes[tmpExisting[i]] !== tmpTypes[tmpExisting[i]])
			{
				return { Kind: 'Rebuild', Added: [], KeymapAdded: [], Reason: `RetypedColumn:${tmpExisting[i]}` };
			}
		}
		let tmpKeymapExisting = Object.keys(tmpKeymapTypes);
		let tmpSpecKeymap = Array.isArray(pSpec.KeymapColumns) ? pSpec.KeymapColumns : [];
		for (let i = 0; i < tmpKeymapExisting.length; i++)
		{
			if ((tmpSpecKeymap.indexOf(tmpKeymapExisting[i]) < 0) || (tmpSpecTypes[tmpKeymapExisting[i]] !== tmpKeymapTypes[tmpKeymapExisting[i]]))
			{
				return { Kind: 'Rebuild', Added: [], KeymapAdded: [], Reason: `KeymapColumn:${tmpKeymapExisting[i]}` };
			}
		}
		let tmpAdded = pSpec.Columns.map((pColumn) => { return pColumn.Column; }).filter((pColumn) => { return !hasOwn(tmpTypes, pColumn); });
		let tmpKeymapAdded = tmpSpecKeymap.filter((pColumn) => { return !hasOwn(tmpKeymapTypes, pColumn); });
		for (let i = 0; i < tmpAdded.length; i++)
		{
			if (!libTypeMap.isNullableType(tmpSpecTypes[tmpAdded[i]]))
			{
				return { Kind: 'Rebuild', Added: [], KeymapAdded: [], Reason: `KeyColumnAdded:${tmpAdded[i]}` };
			}
		}
		if ((tmpAdded.length < 1) && (tmpKeymapAdded.length < 1))
		{
			// Same columns, a different hash (a version bump): nothing to add, but the tables carry an old
			// hash; a rebuild re-renders them exactly.
			return { Kind: 'Rebuild', Added: [], KeymapAdded: [], Reason: 'SpecHash' };
		}
		return { Kind: 'Additive', Added: tmpAdded, KeymapAdded: tmpKeymapAdded, Reason: null };
	}

	/**
	 * @return {Array<Record<string, any>>}
	 */
	disabled()
	{
		return this._Disabled.slice();
	}

	/**
	 * @return {Array<Record<string, any>>}
	 */
	warnings()
	{
		return this._Warnings.slice();
	}
}

module.exports = RetoldFacetingMirrorSpec;
module.exports.serviceType = 'RetoldFacetingMirrorSpec';
module.exports.SPEC_VERSION = SPEC_VERSION;
module.exports.MATERIALIZE_SCHEMA = MATERIALIZE_SCHEMA;
module.exports.UNSUPPORTED_KEYS = UNSUPPORTED_KEYS;
module.exports.REASONS = REASONS;
module.exports.AUTO_MAX_STRING_SIZE = AUTO_MAX_STRING_SIZE;
module.exports.validateSchema = validateSchema;
module.exports.specHash = specHash;
