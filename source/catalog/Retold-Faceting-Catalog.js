/**
 * Retold Faceting - Catalog
 *
 * Auto-derives the per-entity list of filterable columns and facetable columns (with their
 * folds) from the compiled Stricture model (01 §3, internal-contracts §11).  The catalog is the
 * identifier whitelist: every column name that reaches SQL comes from here.  Sensitive columns
 * are never returned.
 *
 *   Facet types come from Columns[].DataType (authoritative), never from MeadowSchema.Schema[].Type
 *   (which loses FK, Text and JSON); MeadowSchema types are read only to recognize the PK, GUID,
 *   delete and audit columns.  FK detection keys on Columns[].Join; targets resolve through the
 *   Graph's PK-column index.
 *
 * Overrides (all optional, server-authored):
 *   Catalog.AutoDerive: false                  no auto facets (columns stay filterable)
 *   Catalog.MaxTermsStringSize                 longest String that gets Terms (default 128)
 *   Catalog.Sensitive: 'Default' | [ 'E.C' | 'C' ]   the name-pattern denylist plus explicit entries
 *   Catalog.Include / Catalog.Exclude: [ 'E.C' ]     global FacetID lists
 *   Catalog.<Entity>: { Include, Exclude, DisplayName, DisplayNames, Intervals, Cardinality,
 *                       Sensitive, IncludeSensitive, LabelColumn }     (01 §3.3)
 *
 * Milestone 2: ModelVersion also covers the loaded definitions (refreshModelVersion, after the
 * DefinitionRegistry loads), the auto one-hop path facets ('E.c>T.col', pathAutoDescriptor /
 * pathAutoFacets) are derived here, and Describe lists named scopes and declared facets from the
 * registry (internal-contracts §20.1, §20.8, §30.1).
 *
 * Contract: internal-contracts §11, §20.8, §30.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libFacetRequest = require('../contract/Facet-Contract-Request.js');
const libFacetBuckets = require('../contract/Facet-Contract-Buckets.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');
// Pure helpers (canonical JSON, sha1, PK detection) and the class for self-registration only.
const libRetoldFacetingGraph = require('./Retold-Faceting-Graph.js');

// Default Sensitive-name denylist (01 §3.2).
const SENSITIVE_PATTERN = /Password|Hash|Secret|Token|Salt|ApiKey|Key$|Code$|Email|Phone/i;

// Fold lists per column class (internal-contracts §11.2; first = default).
const FOLDS_JOIN = Object.freeze([ 'Terms', 'Missing', 'DistinctCount' ]);
const FOLDS_BOOLEAN = Object.freeze([ 'Terms', 'Missing' ]);
const FOLDS_DATETIME = Object.freeze([ 'DateHistogram', 'Stats', 'Missing' ]);
const FOLDS_INTEGER = Object.freeze([ 'NumericHistogram', 'Terms', 'Ranges', 'Stats', 'DistinctCount', 'Missing' ]);
const FOLDS_DECIMAL = Object.freeze([ 'NumericHistogram', 'Ranges', 'Stats', 'Missing' ]);
const FOLDS_STRING = Object.freeze([ 'Terms', 'Missing', 'DistinctCount' ]);

// DataTypes that never get auto facets (still filterable).
const UNBOUNDED_DATATYPES = Object.freeze([ 'Text', 'JSON', 'JSONProxy' ]);
// DataTypes whose values are integers (keys normalize to Number, Scale 0): the contract's table.
const INTEGER_DATATYPES = libFacetBuckets.INTEGER_TYPES;

// Audit columns (MeadowSchema types and the Stricture magic names).
const AUDIT_MEADOW_TYPES = libRetoldFacetingGraph.AUDIT_STAMP_MEADOW_TYPES;
const AUDIT_COLUMN_NAMES = libRetoldFacetingGraph.AUDIT_STAMP_COLUMN_NAMES;
const AUDIT_USER_MEADOW_TYPES = libRetoldFacetingGraph.AUDIT_USER_MEADOW_TYPES;
const AUDIT_USER_COLUMN_NAMES = libRetoldFacetingGraph.AUDIT_USER_COLUMNS;

// Stricture defaults when a column carries no Size (Stricture-Service-Compiler '$' and '.').
const STRICTURE_DEFAULT_STRING_SIZE = 64;
const STRICTURE_DEFAULT_DECIMAL_SCALE = 3;

// Label-column candidates for FK targets (01 §3.2), in preference order.
const LABEL_COLUMN_CANDIDATES = Object.freeze([ 'Name', 'Title', 'FullName' ]);
const LABEL_COLUMN_MAX_SIZE = 128;

// Folds a path dimension can bucket by (PathAuto, internal-contracts §20.8).
const BUCKETED_FOLDS = Object.freeze([ 'Terms', 'DateHistogram', 'NumericHistogram', 'Ranges' ]);

// 'Entity.Column>Target.Column' (an auto one-hop path FacetID).
const PATH_AUTO_PATTERN = /^([A-Za-z_][A-Za-z0-9_]{0,63})\.([A-Za-z_][A-Za-z0-9_]{0,63})>([A-Za-z_][A-Za-z0-9_]{0,63})\.([A-Za-z_][A-Za-z0-9_]{0,63})$/;

// Keys of the Catalog options section that are not per-entity overrides.
const CATALOG_RESERVED_KEYS = Object.freeze(
	[
		'AutoDerive', 'MaxTermsStringSize', 'AutoFKTermsMaxTargetRows', 'OverridesFile', 'HubEntities', 'ListOneHop',
		'Sensitive', 'GlobalEntities', 'AllowAnonymous', 'NeverFacet', 'Controllerless'
	]);

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

/**
 * 'SaleDate' → 'Sale Date', 'IDBookStore' → 'ID Book Store', 'TransactionID' → 'Transaction ID'.
 *
 * @param {string} pName
 * @return {string}
 */
const deCamel = (pName) =>
{
	return String(pName)
		.replace(/_+/g, ' ')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.replace(/\s+/g, ' ')
		.trim();
};

/**
 * 'BookStoreSale' → 'Book Store Sales', 'Category' → 'Categories'.
 *
 * @param {string} pEntity
 * @return {string}
 */
const entityDisplayName = (pEntity) =>
{
	let tmpName = deCamel(pEntity);
	if (/[^aeiou]y$/i.test(tmpName))
	{
		return tmpName.substring(0, tmpName.length - 1) + 'ies';
	}
	if (/(s|x|z|ch|sh)$/i.test(tmpName))
	{
		return tmpName + 'es';
	}
	return tmpName + 's';
};

/**
 * Parse a Stricture Size into an integer, or null ('int', 'Default', missing).
 *
 * @param {any} pSize
 * @return {number|null}
 */
const parseIntegerSize = (pSize) =>
{
	if ((typeof(pSize) === 'number') && Number.isInteger(pSize))
	{
		return pSize;
	}
	if ((typeof(pSize) === 'string') && /^[0-9]+$/.test(pSize.trim()))
	{
		return parseInt(pSize.trim(), 10);
	}
	return null;
};

/**
 * Decimal scale from a Stricture Size ('10,2' → 2, '20' → 0); null when unparseable.
 *
 * @param {any} pSize
 * @return {number|null}
 */
const parseDecimalScale = (pSize) =>
{
	if ((typeof(pSize) === 'number') && Number.isInteger(pSize))
	{
		return 0;
	}
	if (typeof(pSize) !== 'string')
	{
		return null;
	}
	let tmpMatch = /^\s*([0-9]+)\s*(?:,\s*([0-9]+)\s*)?$/.exec(pSize);
	if (!tmpMatch)
	{
		return null;
	}
	return (typeof(tmpMatch[2]) === 'string') ? parseInt(tmpMatch[2], 10) : 0;
};

class RetoldFacetingCatalog extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingCatalog';

		// Entity → EntityDescriptor
		this._Entities = {};
		// FacetID → facet descriptor
		this._Facets = {};
		// Entity → { PK, DeleteColumn, PolicyColumns } for the Sensitive structural exemption
		this._Structural = {};
		this._ModelVersion = 'm:000000000000';
		// The ModelVersion material of the last rebuild (refreshModelVersion re-hashes it with the definitions).
		this._VersionMaterial = null;
		this._Host = null;
		this._Model = null;
		this._Warnings = [];
	}

	/**
	 * The Graph service on fable, registered if absent and rebuilt when it was built from a
	 * different model object (the service normally rebuilds it first).
	 *
	 * @param {Record<string, any>|null} pModel
	 * @return {any} RetoldFacetingGraph
	 */
	_graphFor(pModel)
	{
		if (!this.fable.RetoldFacetingGraph)
		{
			if (!this.fable.servicesMap || !hasOwn(this.fable.servicesMap, 'RetoldFacetingGraph'))
			{
				this.fable.addServiceType('RetoldFacetingGraph', libRetoldFacetingGraph);
			}
			this.fable.instantiateServiceProvider('RetoldFacetingGraph', this.options);
		}
		let tmpGraph = this.fable.RetoldFacetingGraph;
		if (tmpGraph.builtFrom() !== (pModel || null))
		{
			tmpGraph.rebuild(pModel);
		}
		return tmpGraph;
	}

	/**
	 * Per-entity overrides from the Catalog section (01 §3.3).
	 *
	 * @param {string} pEntity
	 * @return {Record<string, any>}
	 */
	_entityOverrides(pEntity)
	{
		let tmpCatalog = this.options.Catalog || {};
		if ((CATALOG_RESERVED_KEYS.indexOf(pEntity) >= 0) || !hasOwn(tmpCatalog, pEntity) || !isPlainObject(tmpCatalog[pEntity]))
		{
			return {};
		}
		return tmpCatalog[pEntity];
	}

	/**
	 * Column names listed for an entity in a global FacetID list ('E.C') plus an entity list ('C').
	 *
	 * @param {string} pEntity
	 * @param {any} pGlobalList - Catalog.Include / Catalog.Exclude
	 * @param {any} pEntityList - Catalog.<E>.Include / Catalog.<E>.Exclude
	 * @param {string} pListName - for warnings
	 * @return {Array<string>}
	 */
	_columnList(pEntity, pGlobalList, pEntityList, pListName)
	{
		let tmpColumns = [];
		let fAdd = (pEntry) =>
		{
			if (typeof(pEntry) !== 'string')
			{
				return;
			}
			if ((pEntry.indexOf('>') >= 0) || (pEntry.indexOf('/') >= 0))
			{
				this._Warnings.push({ Code: 'OverrideNotInMilestone', Entity: pEntity, List: pListName, Entry: pEntry });
				return;
			}
			tmpColumns.push(pEntry);
		};
		if (Array.isArray(pGlobalList))
		{
			pGlobalList.forEach(
				(pEntry) =>
				{
					if ((typeof(pEntry) === 'string') && (pEntry.indexOf(pEntity + '.') === 0))
					{
						fAdd(pEntry.substring(pEntity.length + 1));
					}
				});
		}
		if (Array.isArray(pEntityList))
		{
			pEntityList.forEach(fAdd);
		}
		return tmpColumns;
	}

	/**
	 * Is a column name Sensitive (default denylist + Catalog.Sensitive entries − IncludeSensitive)?
	 * The entity's own primary key, delete column and scope-policy columns are structural and are
	 * never Sensitive by name pattern (only by an explicit entry).
	 *
	 * @param {string} pEntity
	 * @param {string} pColumn
	 * @return {boolean}
	 */
	isSensitive(pEntity, pColumn)
	{
		if (typeof(pColumn) !== 'string')
		{
			return true;
		}
		let tmpOverrides = this._entityOverrides(pEntity);
		let tmpIncludeSensitive = tmpOverrides.IncludeSensitive;
		if ((isPlainObject(tmpIncludeSensitive) && hasOwn(tmpIncludeSensitive, pColumn)) || (Array.isArray(tmpIncludeSensitive) && (tmpIncludeSensitive.indexOf(pColumn) >= 0)))
		{
			return false;
		}
		let tmpGlobal = this.options.Catalog.Sensitive;
		if (Array.isArray(tmpGlobal) && ((tmpGlobal.indexOf(`${pEntity}.${pColumn}`) >= 0) || (tmpGlobal.indexOf(pColumn) >= 0)))
		{
			return true;
		}
		if (Array.isArray(tmpOverrides.Sensitive) && (tmpOverrides.Sensitive.indexOf(pColumn) >= 0))
		{
			return true;
		}
		let tmpStructural = hasOwn(this._Structural, pEntity) ? this._Structural[pEntity] : null;
		if (tmpStructural && ((pColumn === tmpStructural.PK) || (pColumn === tmpStructural.DeleteColumn) || (tmpStructural.PolicyColumns.indexOf(pColumn) >= 0)))
		{
			return false;
		}
		return SENSITIVE_PATTERN.test(pColumn);
	}

	/**
	 * The scope policy of the host (or an empty policy when the catalog is built without a host).
	 *
	 * @param {any} pHost
	 * @return {Record<string, any>}
	 */
	_policyOf(pHost)
	{
		if (pHost && (typeof(pHost.getScopePolicy) === 'function'))
		{
			return pHost.getScopePolicy();
		}
		return { Kind: 'None', Column: null, Exclude: [], PersonalScopes: {}, Required: {}, UnsetValues: [ 0, '', null ], Guard: 'Off', requiredFor: () => { return []; }, isScoped: () => { return false; } };
	}

	/**
	 * Columns the entity's scope policy requires (they never get facets).
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pPolicy
	 * @param {Record<string, boolean>} pColumnNames
	 * @return {Array<string>}
	 */
	_policyColumnsFor(pEntity, pPolicy, pColumnNames)
	{
		let tmpColumns = [];
		let fAdd = (pColumn) =>
		{
			if ((typeof(pColumn) === 'string') && hasOwn(pColumnNames, pColumn) && (tmpColumns.indexOf(pColumn) < 0))
			{
				tmpColumns.push(pColumn);
			}
		};
		// The policy column is never a facet on ANY entity that has it (Exclude only drops the requirement).
		fAdd(pPolicy.Column);
		if (hasOwn(pPolicy.PersonalScopes, pEntity))
		{
			fAdd(pPolicy.PersonalScopes[pEntity].Column);
		}
		if (hasOwn(pPolicy.Required, pEntity))
		{
			pPolicy.Required[pEntity].forEach((pEntry) => { fAdd(pEntry.Column); });
		}
		return tmpColumns;
	}

	/**
	 * Is a String column part of a unique index (Stricture Indices[] or column-level Indexed: 'unique')?
	 *
	 * @param {Record<string, any>} pTable
	 * @param {string} pColumn
	 * @return {boolean}
	 */
	_isUniqueIndexed(pTable, pColumn)
	{
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
				if (tmpIndex && (tmpIndex.Unique === true) && Array.isArray(tmpIndex.Columns) && (tmpIndex.Columns.indexOf(pColumn) >= 0))
				{
					return true;
				}
			}
		}
		let tmpColumnLists = [ Array.isArray(pTable.Columns) ? pTable.Columns : [] ];
		if (isPlainObject(pTable.MeadowSchema) && Array.isArray(pTable.MeadowSchema.Schema))
		{
			tmpColumnLists.push(pTable.MeadowSchema.Schema);
		}
		for (let i = 0; i < tmpColumnLists.length; i++)
		{
			let tmpEntry = tmpColumnLists[i].find((pColumnEntry) => { return pColumnEntry && (pColumnEntry.Column === pColumn); });
			if (tmpEntry && ((tmpEntry.Indexed === 'unique') || (tmpEntry.Unique === true)))
			{
				return true;
			}
		}
		return false;
	}

	/**
	 * The auto folds of one column (internal-contracts §11.2).
	 *
	 * @param {Record<string, any>} pInfo - ColumnInfo (+ private _IsGUID, _IsDeleteDate, _IsAuditUser)
	 * @param {Record<string, any>} pTable
	 * @param {boolean} pForceInclude - Catalog Include: opt in audit / policy / long or unique strings
	 * @return {{ Folds: Array<string>, Reason: string|null }}
	 */
	_deriveFolds(pInfo, pTable, pForceInclude)
	{
		if (pInfo.IsPK || pInfo._IsGUID)
		{
			return { Folds: [], Reason: 'Identity' };
		}
		if (UNBOUNDED_DATATYPES.indexOf(pInfo.DataType) >= 0)
		{
			return { Folds: [], Reason: 'Unbounded' };
		}
		if (!pForceInclude)
		{
			if (pInfo.IsDeleteColumn)
			{
				return { Folds: [], Reason: 'DeleteColumn' };
			}
			if (pInfo._IsDeleteDate || pInfo._IsAuditUser)
			{
				return { Folds: [], Reason: 'Audit' };
			}
			if (pInfo.IsPolicyColumn)
			{
				return { Folds: [], Reason: 'Policy' };
			}
		}
		else if (pInfo._IsAuditUser || pInfo.IsPolicyColumn)
		{
			// Opted-in user / tenancy keys are categorical (Terms), not measurements.
			return { Folds: FOLDS_JOIN.slice(), Reason: null };
		}
		if (pInfo.Join)
		{
			return { Folds: FOLDS_JOIN.slice(), Reason: null };
		}
		switch (pInfo.DataType)
		{
			case 'Boolean':
				return { Folds: FOLDS_BOOLEAN.slice(), Reason: null };
			case 'DateTime':
				return { Folds: FOLDS_DATETIME.slice(), Reason: null };
			case 'Numeric':
				return { Folds: FOLDS_INTEGER.slice(), Reason: null };
			case 'Decimal':
				return { Folds: FOLDS_DECIMAL.slice(), Reason: null };
			case 'ForeignKey':
				// '~' without '->' (01 §3.2): no target to label; opt in with Include.
				if (pForceInclude)
				{
					return { Folds: FOLDS_JOIN.slice(), Reason: null };
				}
				return { Folds: [], Reason: 'ForeignKeyWithoutJoin' };
			case 'String':
			{
				if (pForceInclude)
				{
					return { Folds: FOLDS_STRING.slice(), Reason: null };
				}
				let tmpSize = (pInfo._SizeNumber === null) ? STRICTURE_DEFAULT_STRING_SIZE : pInfo._SizeNumber;
				if (tmpSize > this.options.Catalog.MaxTermsStringSize)
				{
					return { Folds: [], Reason: 'LongString' };
				}
				if (this._isUniqueIndexed(pTable, pInfo.Column))
				{
					return { Folds: [], Reason: 'UniqueIndex' };
				}
				return { Folds: FOLDS_STRING.slice(), Reason: null };
			}
			default:
				return { Folds: [], Reason: 'UnsupportedDataType' };
		}
	}

	/**
	 * The FK label lookup descriptor (labels are a later milestone; this is the seam): the target
	 * entity, its key column and its label column (override LabelColumn, else the first
	 * non-Sensitive of Name / Title / FullName, else the first non-Sensitive String ≤ 128;
	 * LoginID only by override).
	 *
	 * @param {Record<string, any>} pModel
	 * @param {string|null} pTarget
	 * @param {string} pKeyColumn
	 * @return {Record<string, any>|null}
	 */
	_labelLookup(pModel, pTarget, pKeyColumn)
	{
		if (!pTarget || !hasOwn(pModel.Tables, pTarget))
		{
			return null;
		}
		let tmpTable = pModel.Tables[pTarget];
		let tmpColumns = Array.isArray(tmpTable.Columns) ? tmpTable.Columns.filter((pColumn) => { return pColumn && (typeof(pColumn.Column) === 'string'); }) : [];
		let tmpOverride = this._entityOverrides(pTarget).LabelColumn;
		let tmpLabelColumn = null;
		if ((typeof(tmpOverride) === 'string') && tmpColumns.some((pColumn) => { return pColumn.Column === tmpOverride; }) && !this.isSensitive(pTarget, tmpOverride))
		{
			tmpLabelColumn = tmpOverride;
		}
		for (let i = 0; !tmpLabelColumn && (i < LABEL_COLUMN_CANDIDATES.length); i++)
		{
			let tmpCandidate = LABEL_COLUMN_CANDIDATES[i];
			if (tmpColumns.some((pColumn) => { return pColumn.Column === tmpCandidate; }) && !this.isSensitive(pTarget, tmpCandidate))
			{
				tmpLabelColumn = tmpCandidate;
			}
		}
		if (!tmpLabelColumn)
		{
			let tmpFallback = tmpColumns.find(
				(pColumn) =>
				{
					let tmpSize = parseIntegerSize(pColumn.Size);
					return (pColumn.DataType === 'String') && (pColumn.Column !== 'LoginID') && ((tmpSize === null ? STRICTURE_DEFAULT_STRING_SIZE : tmpSize) <= LABEL_COLUMN_MAX_SIZE) && !this.isSensitive(pTarget, pColumn.Column);
				});
			tmpLabelColumn = tmpFallback ? tmpFallback.Column : null;
		}
		return Object.freeze({ Entity: pTarget, KeyColumn: pKeyColumn, LabelColumn: tmpLabelColumn });
	}

	/**
	 * Rebuild everything from the model.  Synchronous; throws a FacetError (FACET_INTERNAL) on an
	 * identifier of a facetable entity outside IDENTIFIER_PATTERN (L4: reject, never strip), in
	 * which case the previous catalog stays in place.  A null model empties the catalog.
	 *
	 * @param {Record<string, any>} pModel - { Tables: { E: { Columns, MeadowSchema, … } } }
	 * @param {any} [pHost] - RetoldFacetingHost* (isFacetable, policy, delete column, PK).  Without a
	 *                        host every model table is facetable and there is no policy.
	 * @return {RetoldFacetingCatalog}
	 */
	rebuild(pModel, pHost)
	{
		// All-or-nothing: a refused model leaves the previous catalog in place.
		let tmpPrevious = (
			{
				Entities: this._Entities, Facets: this._Facets, Structural: this._Structural, ModelVersion: this._ModelVersion,
				Host: this._Host, Model: this._Model, Warnings: this._Warnings, VersionMaterial: this._VersionMaterial
			});
		try
		{
			return this._rebuild(pModel, pHost);
		}
		catch (pRebuildError)
		{
			this._Entities = tmpPrevious.Entities;
			this._Facets = tmpPrevious.Facets;
			this._Structural = tmpPrevious.Structural;
			this._ModelVersion = tmpPrevious.ModelVersion;
			this._Host = tmpPrevious.Host;
			this._Model = tmpPrevious.Model;
			this._Warnings = tmpPrevious.Warnings;
			this._VersionMaterial = tmpPrevious.VersionMaterial;
			throw pRebuildError;
		}
	}

	/**
	 * The body of rebuild (state is committed only when it returns).
	 *
	 * @param {Record<string, any>} pModel
	 * @param {any} [pHost]
	 * @return {RetoldFacetingCatalog}
	 */
	_rebuild(pModel, pHost)
	{
		let tmpModel = (pModel && isPlainObject(pModel.Tables)) ? pModel : { Tables: {} };
		let tmpGraph = this._graphFor(pModel || null);
		let tmpPolicy = this._policyOf(pHost);
		let tmpIdentifierPattern = libFacetRequest.IDENTIFIER_PATTERN;
		let tmpCatalogOptions = this.options.Catalog || {};

		let tmpEntities = {};
		let tmpFacets = {};
		this._Structural = {};
		this._Warnings = [];
		this._Host = pHost || null;
		this._Model = pModel || null;

		let tmpEntityNames = libRetoldFacetingGraph.tableNames(tmpModel);
		let tmpFacetable = tmpEntityNames.filter((pEntity) => { return pHost ? pHost.isFacetable(pEntity) : true; });

		// Structural columns first (isSensitive needs them for every facetable entity, incl. FK targets).
		for (let i = 0; i < tmpEntityNames.length; i++)
		{
			let tmpEntity = tmpEntityNames[i];
			let tmpTable = tmpModel.Tables[tmpEntity];
			let tmpColumnNames = {};
			(Array.isArray(tmpTable.Columns) ? tmpTable.Columns : []).forEach(
				(pColumn) =>
				{
					if (pColumn && (typeof(pColumn.Column) === 'string'))
					{
						tmpColumnNames[pColumn.Column] = true;
					}
				});
			let tmpPK = (pHost && (typeof(pHost.getPrimaryKey) === 'function') && pHost.getPrimaryKey(tmpEntity)) || libRetoldFacetingGraph.primaryKeyOf(tmpTable);
			let tmpDeleteColumn = (pHost && (typeof(pHost.getDeleteColumn) === 'function')) ? pHost.getDeleteColumn(tmpEntity) : null;
			if (!pHost || (typeof(pHost.getDeleteColumn) !== 'function'))
			{
				let tmpSchema = (isPlainObject(tmpTable.MeadowSchema) && Array.isArray(tmpTable.MeadowSchema.Schema)) ? tmpTable.MeadowSchema.Schema : [];
				let tmpDeleteEntry = tmpSchema.find((pEntry) => { return pEntry && (pEntry.Type === 'Deleted'); });
				tmpDeleteColumn = tmpDeleteEntry ? tmpDeleteEntry.Column : null;
			}
			this._Structural[tmpEntity] = (
				{
					PK: tmpPK || null,
					DeleteColumn: tmpDeleteColumn || null,
					PolicyColumns: this._policyColumnsFor(tmpEntity, tmpPolicy, tmpColumnNames),
					ColumnNames: tmpColumnNames
				});
		}

		for (let i = 0; i < tmpFacetable.length; i++)
		{
			let tmpEntity = tmpFacetable[i];
			if (!tmpIdentifierPattern.test(tmpEntity))
			{
				throw libFacetErrors.create('FACET_INTERNAL', `RetoldFaceting catalog: entity name [${tmpEntity}] is not a plain identifier.`);
			}
			let tmpDescriptor = this._buildEntity(tmpEntity, tmpModel, tmpGraph, tmpPolicy, pHost, tmpCatalogOptions);
			tmpEntities[tmpEntity] = tmpDescriptor;
			for (let j = 0; j < tmpDescriptor.Facets.length; j++)
			{
				tmpFacets[tmpDescriptor.Facets[j].Facet] = tmpDescriptor.Facets[j];
			}
		}

		this._Entities = tmpEntities;
		this._Facets = tmpFacets;

		// ModelVersion = sha1(GraphHash | catalog options | policy hash | facetable entity set) (01 §5.4)
		let tmpPolicyData = (pHost && (typeof(pHost.scopePolicyData) === 'function')) ? pHost.scopePolicyData(tmpPolicy)
			: { Kind: tmpPolicy.Kind, Column: tmpPolicy.Column || null };
		let tmpVersionSource = (
			[
				tmpGraph.graphHash(),
				libRetoldFacetingGraph.canonicalJSON(tmpCatalogOptions),
				libRetoldFacetingGraph.canonicalJSON(tmpPolicyData),
				libRetoldFacetingGraph.canonicalJSON(Object.keys(tmpEntities).sort())
			]).join('|');
		this._VersionMaterial = tmpVersionSource;
		this._ModelVersion = this._versionFrom(tmpVersionSource);

		if (this._Warnings.length > 0)
		{
			this.fable.log.warn(`RetoldFaceting catalog: ${this._Warnings.length} warning(s): ${this._Warnings.map((pWarning) => { return `${pWarning.Code} ${pWarning.Entity}${pWarning.Column ? '.' + pWarning.Column : ''}${pWarning.Entry ? ' ' + pWarning.Entry : ''}`; }).join('; ')}`);
		}
		return this;
	}

	/**
	 * Build one EntityDescriptor.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pModel
	 * @param {any} pGraph
	 * @param {Record<string, any>} pPolicy
	 * @param {any} pHost
	 * @param {Record<string, any>} pCatalogOptions
	 * @return {Record<string, any>}
	 */
	_buildEntity(pEntity, pModel, pGraph, pPolicy, pHost, pCatalogOptions)
	{
		let tmpIdentifierPattern = libFacetRequest.IDENTIFIER_PATTERN;
		let tmpTable = pModel.Tables[pEntity];
		let tmpStructural = this._Structural[pEntity];
		let tmpOverrides = this._entityOverrides(pEntity);
		let tmpMeadowTypes = {};
		let tmpSchema = (isPlainObject(tmpTable.MeadowSchema) && Array.isArray(tmpTable.MeadowSchema.Schema)) ? tmpTable.MeadowSchema.Schema : [];
		tmpSchema.forEach(
			(pEntry) =>
			{
				if (pEntry && (typeof(pEntry.Column) === 'string'))
				{
					tmpMeadowTypes[pEntry.Column] = pEntry.Type;
				}
			});

		let tmpExclude = this._columnList(pEntity, pCatalogOptions.Exclude, tmpOverrides.Exclude, 'Exclude');
		let tmpInclude = this._columnList(pEntity, pCatalogOptions.Include, tmpOverrides.Include, 'Include');
		let tmpDisplayNames = isPlainObject(tmpOverrides.DisplayNames) ? tmpOverrides.DisplayNames : {};
		let tmpIntervalOverrides = isPlainObject(tmpOverrides.Intervals) ? tmpOverrides.Intervals : {};
		let tmpCardinality = isPlainObject(tmpOverrides.Cardinality) ? tmpOverrides.Cardinality : {};
		let tmpAutoDerive = (pCatalogOptions.AutoDerive !== false);
		let tmpDefaultInterval = this.options.Time.DefaultInterval;

		let tmpColumnsMap = {};
		let tmpFacets = [];
		let tmpColumns = Array.isArray(tmpTable.Columns) ? tmpTable.Columns : [];
		let tmpSeenColumns = {};

		for (let i = 0; i < tmpColumns.length; i++)
		{
			let tmpRaw = tmpColumns[i];
			if (!tmpRaw || (typeof(tmpRaw.Column) !== 'string') || hasOwn(tmpSeenColumns, tmpRaw.Column))
			{
				continue;
			}
			let tmpName = tmpRaw.Column;
			tmpSeenColumns[tmpName] = true;
			if (!tmpIdentifierPattern.test(tmpName))
			{
				throw libFacetErrors.create('FACET_INTERNAL', `RetoldFaceting catalog: column name [${pEntity}.${tmpName}] is not a plain identifier.`);
			}
			if (this.isSensitive(pEntity, tmpName))
			{
				continue;
			}
			let tmpDataType = (typeof(tmpRaw.DataType) === 'string') ? tmpRaw.DataType : null;
			let tmpMeadowType = hasOwn(tmpMeadowTypes, tmpName) ? tmpMeadowTypes[tmpName] : null;
			let tmpJoin = ((typeof(tmpRaw.Join) === 'string') && (tmpRaw.Join.length > 0)) ? tmpRaw.Join : null;
			let tmpEdge = tmpJoin ? pGraph.edge(`${pEntity}.${tmpName}`) : null;
			if (tmpJoin && !tmpEdge)
			{
				this._Warnings.push({ Code: 'JoinTargetUnresolved', Entity: pEntity, Column: tmpName });
			}
			let tmpIsInteger = (INTEGER_DATATYPES.indexOf(tmpDataType) >= 0);
			let tmpScale = 0;
			if (tmpDataType === 'Decimal')
			{
				let tmpParsedScale = (typeof(tmpRaw.Size) === 'undefined') ? STRICTURE_DEFAULT_DECIMAL_SCALE : parseDecimalScale(tmpRaw.Size);
				if (tmpParsedScale === null)
				{
					this._Warnings.push({ Code: 'DecimalScaleAssumed', Entity: pEntity, Column: tmpName });
					tmpParsedScale = STRICTURE_DEFAULT_DECIMAL_SCALE;
				}
				tmpScale = tmpParsedScale;
			}

			let tmpInfo = (
				{
					Entity: pEntity,
					Column: tmpName,
					DataType: tmpDataType,
					MeadowType: tmpMeadowType,
					Size: (typeof(tmpRaw.Size) === 'undefined') ? null : tmpRaw.Size,
					IsInteger: tmpIsInteger,
					Scale: tmpScale,
					Join: tmpJoin,
					JoinTarget: tmpEdge ? tmpEdge.To : null,
					IsPK: (tmpName === tmpStructural.PK) || (tmpDataType === 'ID') || (tmpMeadowType === 'AutoIdentity'),
					IsDeleteColumn: (tmpName === tmpStructural.DeleteColumn) || (tmpMeadowType === 'Deleted'),
					IsAudit: (AUDIT_MEADOW_TYPES.indexOf(tmpMeadowType) >= 0) || (AUDIT_COLUMN_NAMES.indexOf(tmpName) >= 0),
					IsPolicyColumn: (tmpStructural.PolicyColumns.indexOf(tmpName) >= 0),
					Sensitive: false,
					Filterable: true,
					Facetable: false
				});
			let tmpDerivation = this._deriveFolds(
				Object.assign({}, tmpInfo,
					{
						_IsGUID: (tmpDataType === 'GUID') || (tmpMeadowType === 'AutoGUID') || (tmpName.indexOf('GUID') === 0),
						_IsDeleteDate: (tmpMeadowType === 'DeleteDate') || (tmpName === 'DeleteDate'),
						_IsAuditUser: (AUDIT_USER_MEADOW_TYPES.indexOf(tmpMeadowType) >= 0) || (AUDIT_USER_COLUMN_NAMES.indexOf(tmpName) >= 0),
						_SizeNumber: parseIntegerSize(tmpRaw.Size)
					}),
				tmpTable,
				(tmpInclude.indexOf(tmpName) >= 0));
			if ((tmpDerivation.Reason === 'ForeignKeyWithoutJoin'))
			{
				this._Warnings.push({ Code: 'ForeignKeyWithoutJoin', Entity: pEntity, Column: tmpName });
			}
			let tmpFolds = (tmpAutoDerive || (tmpInclude.indexOf(tmpName) >= 0)) ? tmpDerivation.Folds : [];
			if (tmpExclude.indexOf(tmpName) >= 0)
			{
				tmpFolds = [];
			}
			tmpInfo.Facetable = (tmpFolds.length > 0);
			tmpColumnsMap[tmpName] = Object.freeze(tmpInfo);

			if (tmpFolds.length < 1)
			{
				continue;
			}
			let tmpDefaultFold = tmpFolds[0];
			let tmpFacetID = `${pEntity}.${tmpName}`;
			let tmpDisplayName = (typeof(tmpDisplayNames[tmpName]) === 'string') ? tmpDisplayNames[tmpName]
				: (tmpJoin && /^ID[A-Z]/.test(tmpName)) ? deCamel(tmpName.substring(2))
				: deCamel(tmpName);
			let tmpDescriptor = (
				{
					Facet: tmpFacetID,
					Entity: pEntity,
					Field: tmpName,
					DisplayName: tmpDisplayName,
					DataType: tmpDataType,
					IsInteger: tmpIsInteger,
					Scale: tmpScale,
					Folds: Object.freeze(tmpFolds.slice()),
					DefaultFold: tmpDefaultFold,
					ClauseType: libFacetRequest.clauseTypeFor(tmpDefaultFold),
					FilterKey: tmpName
				});
			if (tmpDataType === 'DateTime')
			{
				let tmpIntervals = Array.isArray(tmpIntervalOverrides[tmpName])
					? libFacetRequest.INTERVALS.filter((pInterval) => { return tmpIntervalOverrides[tmpName].indexOf(pInterval) >= 0; })
					: libFacetRequest.INTERVALS.slice();
				if (tmpIntervals.length < 1)
				{
					tmpIntervals = libFacetRequest.INTERVALS.slice();
				}
				tmpDescriptor.Intervals = Object.freeze(tmpIntervals);
				tmpDescriptor.DefaultInterval = (tmpIntervals.indexOf(tmpDefaultInterval) >= 0) ? tmpDefaultInterval : tmpIntervals[0];
			}
			tmpDescriptor.Target = tmpEdge ? tmpEdge.To : null;
			tmpDescriptor.LabelLookup = tmpEdge ? this._labelLookup(pModel, tmpEdge.To, tmpEdge.ToColumn) : null;
			// FK Terms buckets are labelled by a scoped read of the target (wiring post-processing).
			tmpDescriptor.Labels = !!(tmpDescriptor.LabelLookup && tmpDescriptor.LabelLookup.LabelColumn);
			if (typeof(tmpCardinality[tmpName]) === 'string')
			{
				tmpDescriptor.Cardinality = tmpCardinality[tmpName];
			}
			tmpDescriptor.Selectable = (libFacetRequest.SELECTABLE_FOLDS.indexOf(tmpDefaultFold) >= 0);
			tmpDescriptor.Engines = Object.freeze([ 'Live' ]);
			tmpDescriptor.Auto = true;
			tmpFacets.push(Object.freeze(tmpDescriptor));
		}

		// Overrides that name columns the entity does not have (or that cannot be faceted).
		tmpInclude.forEach(
			(pColumn) =>
			{
				if (!hasOwn(tmpColumnsMap, pColumn) || !tmpColumnsMap[pColumn].Facetable)
				{
					this._Warnings.push({ Code: 'IncludeIgnored', Entity: pEntity, Column: pColumn });
				}
			});
		tmpExclude.forEach(
			(pColumn) =>
			{
				if (!hasOwn(tmpSeenColumns, pColumn))
				{
					this._Warnings.push({ Code: 'ExcludeUnknownColumn', Entity: pEntity, Column: pColumn });
				}
			});

		let tmpDates = tmpFacets.filter((pFacet) => { return pFacet.DataType === 'DateTime'; }).map((pFacet) => { return pFacet.Field; });
		let tmpNumeric = tmpFacets.filter((pFacet) => { return pFacet.DefaultFold === 'NumericHistogram'; }).map((pFacet) => { return pFacet.Field; });
		let tmpCategorical = tmpFacets.filter((pFacet) => { return pFacet.DefaultFold === 'Terms'; }).map((pFacet) => { return pFacet.Field; });

		let tmpScopeAssurance = (pHost && (typeof(pHost.scopeAssurance) === 'function')) ? pHost.scopeAssurance(pEntity)
			: (pPolicy.Kind !== 'Policy') ? 'Unscoped'
			: pPolicy.isScoped(pEntity) ? 'Guarded'
			: 'Global';

		return Object.freeze(
			{
				Entity: pEntity,
				DisplayName: (typeof(tmpOverrides.DisplayName) === 'string') ? tmpOverrides.DisplayName : entityDisplayName(pEntity),
				PK: tmpStructural.PK,
				DeleteColumn: tmpStructural.DeleteColumn,
				Columns: Object.freeze(tmpColumnsMap),
				Facets: Object.freeze(tmpFacets),
				Dates: Object.freeze(tmpDates),
				Numeric: Object.freeze(tmpNumeric),
				Categorical: Object.freeze(tmpCategorical),
				ScopeAssurance: tmpScopeAssurance,
				Bridge: pGraph.isBridge(pEntity),
				// Size class (01 §3.2): internal, never in Describe; 'Unknown' until refreshSizeClasses runs.
				SizeClass: 'Unknown'
			});
	}

	/**
	 * @return {string} 'm:' + 12 hex
	 */
	modelVersion()
	{
		return this._ModelVersion;
	}

	/**
	 * The DefinitionRegistry on fable, when one is registered.
	 *
	 * @return {any|null}
	 */
	_registry()
	{
		let tmpRegistry = this.fable.RetoldFacetingDefinitionRegistry;
		return (tmpRegistry && (typeof(tmpRegistry.definitionsHash) === 'function')) ? tmpRegistry : null;
	}

	/**
	 * ModelVersion from its material plus, when a DefinitionRegistry is registered, its
	 * definitionsHash() (internal-contracts §30.2).
	 *
	 * @param {string} pMaterial
	 * @return {string} 'm:' + 12 hex
	 */
	_versionFrom(pMaterial)
	{
		let tmpRegistry = this._registry();
		let tmpSource = tmpRegistry ? `${pMaterial}|${tmpRegistry.definitionsHash()}` : pMaterial;
		return 'm:' + libRetoldFacetingGraph.sha1Hex(tmpSource).substring(0, 12);
	}

	/**
	 * Recompute ModelVersion after the DefinitionRegistry (re)loaded: the boot / reload order is
	 * Graph.rebuild → Catalog.rebuild → DefinitionRegistry.load → Catalog.refreshModelVersion()
	 * (internal-contracts §20.1).
	 *
	 * @return {string} the new ModelVersion
	 */
	refreshModelVersion()
	{
		if (typeof(this._VersionMaterial) === 'string')
		{
			this._ModelVersion = this._versionFrom(this._VersionMaterial);
		}
		return this._ModelVersion;
	}

	/**
	 * @return {any|null} the host the catalog was built with (null without one)
	 */
	getHost()
	{
		return this._Host;
	}

	/**
	 * The graph this catalog was built from (null before a rebuild).
	 *
	 * @return {any|null}
	 */
	_builtGraph()
	{
		let tmpGraph = this.fable.RetoldFacetingGraph;
		return (tmpGraph && (typeof(tmpGraph.edge) === 'function')) ? tmpGraph : null;
	}

	/**
	 * Is pEdge offered as an auto one-hop path (01 §5.1, §5.2: never audit-user or tenancy edges, never
	 * into a hub) from a facetable entity to a facetable target?
	 *
	 * @param {any} pGraph
	 * @param {Record<string, any>} pEdge
	 * @return {boolean}
	 */
	_isPathAutoEdge(pGraph, pEdge)
	{
		return !!pEdge && !pEdge.Audit && !pEdge.Tenant && !pGraph.isHub(pEdge.To) && !!this.getFacetable(pEdge.From) && !!this.getFacetable(pEdge.To);
	}

	/**
	 * The auto one-hop path facet 'E.c>T.col' (internal-contracts §20.8): E.c is a graph edge to T
	 * that is neither Audit nor Tenant, T is not a hub, and T.col has a catalog descriptor with at
	 * least one bucketed fold.  Exactly one hop (a longer path is declared, never auto).
	 *
	 * @param {string} pFacetID
	 * @return {{ Facet: string, Entity: string, Edge: string, Column: string, Target: string, Field: string, Descriptor: Record<string, any>, Folds: Array<string>, DefaultFold: string }|null}
	 */
	pathAutoDescriptor(pFacetID)
	{
		let tmpMatch = (typeof(pFacetID) === 'string') ? PATH_AUTO_PATTERN.exec(pFacetID) : null;
		let tmpGraph = this._builtGraph();
		if (!tmpMatch || !tmpGraph)
		{
			return null;
		}
		let tmpEdge = tmpGraph.edge(`${tmpMatch[1]}.${tmpMatch[2]}`);
		if (!tmpEdge || (tmpEdge.To !== tmpMatch[3]) || !this._isPathAutoEdge(tmpGraph, tmpEdge))
		{
			return null;
		}
		let tmpDescriptor = this.facet(`${tmpMatch[3]}.${tmpMatch[4]}`);
		if (!tmpDescriptor)
		{
			return null;
		}
		let tmpFolds = tmpDescriptor.Folds.filter((pFold) => { return BUCKETED_FOLDS.indexOf(pFold) >= 0; });
		if (tmpFolds.length < 1)
		{
			return null;
		}
		return (
			{
				Facet: pFacetID,
				Entity: tmpMatch[1],
				Edge: tmpEdge.Name,
				Column: tmpMatch[2],
				Target: tmpMatch[3],
				Field: tmpMatch[4],
				Descriptor: tmpDescriptor,
				Folds: tmpFolds,
				DefaultFold: (tmpFolds.indexOf(tmpDescriptor.DefaultFold) >= 0) ? tmpDescriptor.DefaultFold : tmpFolds[0]
			});
	}

	/**
	 * Every auto one-hop path facet from pEntity (edge order, then the target's facet order).
	 *
	 * @param {string} pEntity
	 * @return {Array<Record<string, any>>} pathAutoDescriptor results
	 */
	pathAutoFacets(pEntity)
	{
		let tmpGraph = this._builtGraph();
		if (!tmpGraph || !this.getFacetable(pEntity))
		{
			return [];
		}
		let tmpResult = [];
		tmpGraph.outgoing(pEntity).forEach(
			(pEdge) =>
			{
				if (!this._isPathAutoEdge(tmpGraph, pEdge))
				{
					return;
				}
				this.getFacetable(pEdge.To).Facets.forEach(
					(pDescriptor) =>
					{
						let tmpPathAuto = this.pathAutoDescriptor(`${pEdge.Name}>${pDescriptor.Facet}`);
						if (tmpPathAuto)
						{
							tmpResult.push(tmpPathAuto);
						}
					});
			});
		return tmpResult;
	}

	/**
	 * The Describe entry of a declared (or path-auto) canonical facet (internal-contracts §30.1).
	 *
	 * @param {Record<string, any>} pFacet - CanonicalFacet
	 * @return {Record<string, any>}
	 */
	_describeDefinedFacet(pFacet)
	{
		let tmpEntry = (
			{
				Facet: pFacet.Facet,
				Declared: (pFacet.Origin !== 'PathAuto'),
				Title: pFacet.Title || null,
				Description: pFacet.Description || null,
				DisplayName: pFacet.DisplayName || null,
				Folds: Array.isArray(pFacet.Folds) ? pFacet.Folds.slice() : [ pFacet.Fold ],
				DefaultFold: pFacet.Fold,
				Selectable: (pFacet.Selectable === true),
				ClauseType: pFacet.ClauseType || null,
				FilterKey: pFacet.FilterKey || null
			});
		if (Array.isArray(pFacet.Path) && (pFacet.Path.length > 0))
		{
			tmpEntry.Path = pFacet.Path.slice();
		}
		tmpEntry.MultiValued = (pFacet.MultiValued === true);
		// What a count means: Rows, PivotDistinct (K9: distinct pivot rows per key) or KeyDistinct
		// (a TuplePivot counts distinct Key tuples; a declared 'Rows' is canonicalized to it).
		tmpEntry.CountMode = pFacet.CountMode || 'Rows';
		tmpEntry.Relaxed = (pFacet.Relaxed === true);
		tmpEntry.Semantics = pFacet.Semantics || null;
		tmpEntry.Params = JSON.parse(JSON.stringify(pFacet.Params || {}));
		tmpEntry.Engines = [ 'Live' ];
		tmpEntry.Supported = (pFacet.Supported !== false);
		tmpEntry.Unsupported = pFacet.Unsupported ? Object.assign({}, pFacet.Unsupported) : null;
		return tmpEntry;
	}

	/**
	 * Facetable entity names (model order).
	 *
	 * @return {Array<string>}
	 */
	entities()
	{
		return Object.keys(this._Entities);
	}

	/**
	 * @param {string} pEntity
	 * @return {Record<string, any>|null} EntityDescriptor
	 */
	getFacetable(pEntity)
	{
		return hasOwn(this._Entities, pEntity) ? this._Entities[pEntity] : null;
	}

	/**
	 * Auto FacetIDs only in M1 ('Entity.Column').
	 *
	 * @param {string} pFacetID - 'Entity.Column'
	 * @return {Record<string, any>|null} facet descriptor
	 */
	facet(pFacetID)
	{
		return hasOwn(this._Facets, pFacetID) ? this._Facets[pFacetID] : null;
	}

	/**
	 * The filter whitelist: ColumnInfo for a filterable column, null for unknown or Sensitive.
	 *
	 * @param {string} pEntity
	 * @param {string} pColumn
	 * @return {Record<string, any>|null}
	 */
	column(pEntity, pColumn)
	{
		let tmpEntity = this.getFacetable(pEntity);
		if (!tmpEntity || !hasOwn(tmpEntity.Columns, pColumn))
		{
			return null;
		}
		return tmpEntity.Columns[pColumn];
	}

	/**
	 * @param {string} pEntity
	 * @return {Array<string>}
	 */
	filterableColumns(pEntity)
	{
		let tmpEntity = this.getFacetable(pEntity);
		return tmpEntity ? Object.keys(tmpEntity.Columns) : [];
	}

	/**
	 * Catalog build warnings ({ Code, Entity, Column?, Entry? }).
	 *
	 * @return {Array<Record<string, any>>}
	 */
	warnings()
	{
		return this._Warnings.slice();
	}

	/**
	 * The Describe block for one entity (02 §7), filtered for the principal: null when the entity
	 * is not in the catalog or not facetable for this principal; FK Target names appear only when
	 * the target is facetable too; internal fields (label lookup, size classes) are omitted.
	 *
	 * @param {string} pEntity
	 * @param {Record<string, any>} pPrincipal
	 * @param {(pEntity: string) => boolean} [fCanRead] - the Authorizer's read gate; an FK Target
	 *        is named only when the principal can read it
	 * @return {Record<string, any>|null}
	 */
	describe(pEntity, pPrincipal, fCanRead)
	{
		let fReadable = (typeof(fCanRead) === 'function') ? fCanRead : () => { return true; };
		let tmpEntity = this.getFacetable(pEntity);
		if (!tmpEntity)
		{
			return null;
		}
		if (this._Host && !this._Host.isFacetable(pEntity, pPrincipal))
		{
			return null;
		}
		let tmpFacets = tmpEntity.Facets.map(
			(pDescriptor) =>
			{
				let tmpPublic = (
					{
						Facet: pDescriptor.Facet,
						Field: pDescriptor.Field,
						DisplayName: pDescriptor.DisplayName,
						DataType: pDescriptor.DataType,
						Folds: pDescriptor.Folds.slice(),
						DefaultFold: pDescriptor.DefaultFold,
						ClauseType: pDescriptor.ClauseType,
						FilterKey: pDescriptor.FilterKey
					});
				if (Array.isArray(pDescriptor.Intervals))
				{
					tmpPublic.Intervals = pDescriptor.Intervals.slice();
					tmpPublic.DefaultInterval = pDescriptor.DefaultInterval;
				}
				if (pDescriptor.Target && this.getFacetable(pDescriptor.Target) && (!this._Host || this._Host.isFacetable(pDescriptor.Target, pPrincipal)) && fReadable(pDescriptor.Target))
				{
					tmpPublic.Target = pDescriptor.Target;
				}
				if (typeof(pDescriptor.Cardinality) === 'string')
				{
					tmpPublic.Cardinality = pDescriptor.Cardinality;
				}
				tmpPublic.Labels = pDescriptor.Labels;
				tmpPublic.Selectable = pDescriptor.Selectable;
				tmpPublic.Engines = pDescriptor.Engines.slice();
				tmpPublic.Auto = pDescriptor.Auto;
				return tmpPublic;
			});
		// M2 (internal-contracts §30.1): named scopes and declared facets of the registry whose every
		// entity this principal may facet (Authorizer.canFacet = host-facetable ∧ catalog ∧ canRead).
		let fCanFacet = (pTarget) =>
		{
			return !!this.getFacetable(pTarget) && (!this._Host || this._Host.isFacetable(pTarget, pPrincipal)) && fReadable(pTarget);
		};
		let fAllFacetable = (pEntities) =>
		{
			return (Array.isArray(pEntities) ? pEntities : []).every(fCanFacet);
		};
		let tmpScopes = [];
		let tmpRegistry = this._registry();
		if (tmpRegistry)
		{
			tmpScopes = tmpRegistry.scopesFor(pEntity).filter((pScope) => { return (pScope.Supported !== false) && fAllFacetable(pScope.Entities); }).map(
				(pScope) =>
				{
					return { Scope: pScope.Scope, Description: pScope.Description || null, Params: JSON.parse(JSON.stringify(pScope.Params || {})), Relaxed: (pScope.Relaxed === true) };
				});
			tmpRegistry.facetsFor(pEntity).forEach(
				(pFacet) =>
				{
					if (fAllFacetable(pFacet.Entities))
					{
						tmpFacets.push(this._describeDefinedFacet(pFacet));
					}
				});
			if (this.options.Catalog.ListOneHop === true)
			{
				this.pathAutoFacets(pEntity).forEach(
					(pPathAuto) =>
					{
						let tmpFacet = tmpRegistry.resolveFacet(pPathAuto.Facet);
						if (tmpFacet && fAllFacetable(tmpFacet.Entities))
						{
							tmpFacets.push(this._describeDefinedFacet(tmpFacet));
						}
					});
			}
		}
		return (
			{
				Entity: tmpEntity.Entity,
				DisplayName: tmpEntity.DisplayName,
				ScopeAssurance: tmpEntity.ScopeAssurance,
				Facets: tmpFacets,
				Scopes: tmpScopes,
				Dates: tmpEntity.Dates.slice(),
				Numeric: tmpEntity.Numeric.slice(),
				Categorical: tmpEntity.Categorical.slice()
			});
	}

	/**
	 * The size class of an entity (internal; never in Describe): 'Small' (≤ Catalog.AutoFKTermsMaxTargetRows
	 * live rows), 'Large', or 'Unknown' (not measured yet).
	 *
	 * @param {string} pEntity
	 * @return {string}
	 */
	sizeClass(pEntity)
	{
		let tmpEntity = this.getFacetable(pEntity);
		return tmpEntity ? tmpEntity.SizeClass : 'Unknown';
	}

	/**
	 * Measure entity size classes (01 §3.2) with an unscoped, non-deleted COUNT through each DAL.
	 * Deployment-wide numbers used only by the planner / cost model seams; M1 does not gate FK
	 * listing on them (internal-contracts §16.4).  Not run at boot; call when wanted.
	 *
	 * @param {(pError?: Error, pSizeClasses?: Record<string, string>) => void} fCallback
	 */
	refreshSizeClasses(fCallback)
	{
		let tmpHost = this._Host;
		let tmpEntities = this.entities();
		let tmpThreshold = this.options.Catalog.AutoFKTermsMaxTargetRows;
		let tmpResult = {};
		if (!tmpHost || (typeof(tmpHost.getDAL) !== 'function'))
		{
			return fCallback(null, tmpResult);
		}
		// One count at a time (each a separate DB round trip).
		this.fable.Utility.eachLimit(tmpEntities, 1,
			(pEntity, fNext) =>
			{
				let tmpDAL = tmpHost.getDAL(pEntity);
				let fStore = (pSizeClass) =>
				{
					tmpResult[pEntity] = pSizeClass;
					if (hasOwn(this._Entities, pEntity))
					{
						this._Entities[pEntity] = Object.freeze(Object.assign({}, this._Entities[pEntity], { SizeClass: pSizeClass }));
					}
					return setImmediate(() => { fNext(); });
				};
				if (!tmpDAL || (typeof(tmpDAL.doCount) !== 'function'))
				{
					return fStore('Unknown');
				}
				try
				{
					tmpDAL.doCount(tmpDAL.query,
						(pError, pQuery, pCount) =>
						{
							if (pError || (typeof(pCount) !== 'number'))
							{
								return fStore('Unknown');
							}
							return fStore((pCount <= tmpThreshold) ? 'Small' : 'Large');
						});
				}
				catch (pCountError)
				{
					this.fable.log.warn(`RetoldFaceting catalog: size count for [${pEntity}] failed: ${pCountError.message}`);
					return fStore('Unknown');
				}
			},
			() =>
			{
				return fCallback(null, tmpResult);
			});
	}
}

module.exports = RetoldFacetingCatalog;
module.exports.serviceType = 'RetoldFacetingCatalog';
module.exports.SENSITIVE_PATTERN = SENSITIVE_PATTERN;
module.exports.deCamel = deCamel;
module.exports.entityDisplayName = entityDisplayName;
module.exports.BUCKETED_FOLDS = BUCKETED_FOLDS;
module.exports.PATH_AUTO_PATTERN = PATH_AUTO_PATTERN;
