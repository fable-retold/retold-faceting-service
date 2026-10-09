/**
 * Retold Faceting - Definition Registry
 *
 * Loads app-owned definitions files ({ FormatVersion, Aliases, Expressions, Scopes, Facets }),
 * validates each against catalog/Facet-Definition-Schema.json (built-in validator, no runtime
 * dependency) and then against the FacetGraph and the catalog, and serves the CANONICAL forms the
 * Planner and the ClauseCompiler consume: paths resolved to PathPlans (Graph.resolvePath), aliases
 * spliced, Any / Not desugared, named-scope references inlined (cycles and depth > MaxScopeDepth
 * refused), literal values coerced by column DataType, $-tokens kept as { Bind } leaves for the
 * Binder.  An invalid definition is DISABLED with a logged FACET_DEFINITION_INVALID, never
 * partially loaded; everything that depends on it is disabled too.
 *
 * Also synthesizes the auto 1-hop path facets ('Review.IDBook>Book.Language', K8).
 *
 *   load(pSources?, pEnvironment?)            → { Loaded, Disabled, Warnings, DefinitionsHash } (atomic swap)
 *   validate(pDefinitions, pEnvironment?)     → { Valid, Errors, Warnings, Canonical } (no state change)
 *   facet / resolveFacet / scope / scopesFor / facetsFor / alias / expression / disabled / warnings /
 *   definitionsHash / status
 *
 * Canonical forms (internal-contracts §20.7) are deep-frozen: consumers build new trees (the
 * Binder's bind() returns a new tree), they never write into the registry's.
 *
 * Contract: internal-contracts §20 (registry), §21 (paths), §24.8 (what lowering expects).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFS = require('fs');
const libPath = require('path');
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libFacetRequest = require('../contract/Facet-Contract-Request.js');
const libFacetBuckets = require('../contract/Facet-Contract-Buckets.js');
const libFacetClauses = require('../contract/Facet-Contract-Clauses.js');
const libFacetUtil = require('../contract/Facet-Contract-Util.js');
const libRetoldFacetingUtil = require('../Retold-Faceting-Util.js');
// The token grammar and the param types (constants only).
// Literal values are coerced by the ClauseCompiler's pure coerceValue rule (no service needed).
const libRetoldFacetingClauseCompiler = require('../request/Retold-Faceting-ClauseCompiler.js');
// Pure helpers (display names).
const libRetoldFacetingCatalog = require('./Retold-Faceting-Catalog.js');

// The JSON schema of a definitions file (shape only; semantics are checked against the graph).
const DEFINITION_SCHEMA = require('./Facet-Definition-Schema.json');

const FORMAT_VERSION = 1;

// Facet keys accepted and ignored in M2 (load warning 'Ignored:<Key>', internal-contracts §20.3 stage 13).
const IGNORED_FACET_KEYS = Object.freeze([ 'Engines', 'Freshness', 'Limits', 'Visibility', 'Records', 'Missing', 'ClauseType', 'Selectable' ]);

// Operator negation for Not push-down (internal-contracts §20.7; SQL three-valued logic holds).
const NEGATED_OPS = Object.freeze(
	{
		EQ: 'NE', NE: 'EQ', GT: 'LE', LE: 'GT', GE: 'LT', LT: 'GE',
		LK: 'NLK', NLK: 'LK', IN: 'NIN', NIN: 'IN', NULL: 'NOTNULL', NOTNULL: 'NULL'
	});
const NEGATED_COUNT_OPS = Object.freeze({ EQ: 'NE', NE: 'EQ', GE: 'LT', LT: 'GE', GT: 'LE', LE: 'GT' });

const LIST_OPS = Object.freeze([ 'IN', 'NIN' ]);
const NO_VALUE_OPS = Object.freeze([ 'NULL', 'NOTNULL' ]);
const LIKE_OPS = Object.freeze([ 'LK', 'NLK' ]);

const LIST_PARAM_TYPES = Object.freeze([ 'EnumList', 'IntegerList' ]);
// The $-token grammar and the param types live in the request contract (the Binder uses the same).
const PARAM_TYPES = libFacetRequest.PARAM_TYPES;
const TOKEN_PATTERN = libFacetRequest.TOKEN_PATTERN;
// Default String param MaxLength (internal-contracts §22.3).
const DEFAULT_PARAM_MAX_LENGTH = 256;

// Bucketed dimension kinds (the ones a to-one path or a TuplePivot side may bucket by).
const BUCKET_KINDS = Object.freeze([ 'Terms', 'DateHistogram', 'NumericHistogram', 'Ranges' ]);

// Pred keys that are existence predicates (internal-contracts §20.7).
const EXISTENCE_KINDS = Object.freeze([ 'Exists', 'NotExists', 'HavingCount', 'All', 'AllNonEmpty' ]);

// 'alias.Column' (TuplePivot) or 'Column'.
const FIELD_REFERENCE_PATTERN = /^(?:([a-z][a-z0-9]{0,7})\.)?([A-Za-z_][A-Za-z0-9_]{0,63})$/;

// Every load-time reason a disabled entry can carry (internal-contracts §20.3 plus the ones this
// implementation adds; §36 / the M2 report list the additions).
const REASONS = Object.freeze(
	[
		// stage 1 and the file envelope
		'Schema', 'Unreadable', 'InvalidJSON',
		// stage 2 names
		'DuplicateName', 'AliasShadowsBridge', 'NameShadowsColumn', 'ScopeEntityMismatch', 'UnknownEntity', 'HomeMismatch', 'PivotMismatch',
		// stages 3 and 4 aliases and paths (Graph.resolvePath)
		'UnknownAlias', 'AliasCycle', 'InvalidPath', 'InvalidStep', 'WrongStart', 'UnknownEdge', 'NotAJoin', 'NotCoReferent', 'AmbiguousCoReference', 'TooManyHops',
		// stage 5 predicates
		'UnknownField', 'DeletedField', 'PolicyField', 'InvalidValue', 'UnknownToken', 'UndeclaredParam', 'ParamShape', 'TokenType', 'CorrelateType', 'ParamSchema',
		// stage 6 scope references
		'UnknownScope', 'DependsOnDisabled', 'ScopeParamMissing', 'ScopeParamInvalid', 'ScopeTooDeep', 'ScopeCycle',
		// stages 7 and 8
		'ExistsTooDeep', 'TenantOnlyNotAllowed', 'TenantOnlyNeedsReason', 'TenantOnlyNeedsPolicy', 'TenantOnlyNeedsTenant', 'TenantOnlyParam',
		// stages 10 and 11 dimensions and tuple pivots
		'DimensionShape', 'FieldType', 'FieldNotFoldable', 'LabelsPath', 'CountModeRows', 'PivotAxis', 'BandEdges',
		'TupleAlias', 'TupleHome', 'TupleOnNotJoined', 'TupleDimensionNotKeyed', 'TuplePath',
		// an unexpected exception while compiling (logged)
		'Internal'
	]);

// Features that load with Supported: false in M2 (stage 12; a request using one gets 422 FACET_FOLD_UNSUPPORTED).
const UNSUPPORTED_FEATURES = Object.freeze(
	[
		'Quantified', 'Computed', 'UnionOfSources', 'LogMode', 'CountMode', 'Measures', 'ChildRollupAgg', 'ChildRollupPath',
		'HavingCountPath', 'ExcludeGroup', 'LookupPathWhere', 'TuplePivotPivot', 'TimeZone'
	]);

// The policy used when the registry has no host (no tenancy, no personal scopes).
const NONE_POLICY = Object.freeze(
	{
		Kind: 'None', Column: null, Exclude: [], PersonalScopes: {}, Required: {},
		requiredFor: () => { return []; },
		isScoped: () => { return false; }
	});

const isPlainObject = libFacetUtil.isPlainObject;
const hasOwn = libFacetUtil.hasOwn;
const canonicalJSON = libFacetClauses.canonicalJSON;

// One SHA-1 helper for the server services (Retold-Faceting-Util).
const sha1Hex = libRetoldFacetingUtil.sha1Hex;

/**
 * JSON pointer escaping of one token ('~' → '~0', '/' → '~1').
 *
 * @param {any} pToken
 * @return {string}
 */
const pointerToken = (pToken) =>
{
	return String(pToken).replace(/~/g, '~0').replace(/\//g, '~1');
};

/**
 * Freeze an object graph (plain objects and arrays).
 *
 * @param {any} pValue
 * @return {any} pValue
 */
const deepFreeze = (pValue) =>
{
	if ((pValue === null) || (typeof(pValue) !== 'object') || Object.isFrozen(pValue))
	{
		return pValue;
	}
	Object.freeze(pValue);
	Object.keys(pValue).forEach((pKey) => { deepFreeze(pValue[pKey]); });
	return pValue;
};

/**
 * A plain deep copy (JSON values only).
 *
 * @param {any} pValue
 * @return {any}
 */
const clone = (pValue) =>
{
	return (typeof(pValue) === 'undefined') ? undefined : JSON.parse(JSON.stringify(pValue));
};

/**
 * A load-time definition error (never a request error).
 *
 * @param {string} pReason
 * @param {{ Pointer?: string, Step?: number|null, Entity?: string|null, Field?: string|null, DependsOn?: string|null }} [pFields]
 * @return {Error}
 */
const definitionError = (pReason, pFields) =>
{
	let tmpFields = pFields || {};
	let tmpError = new Error(`Facet definition invalid: ${pReason}.`);
	tmpError.DefinitionError = true;
	tmpError.Reason = pReason;
	tmpError.Pointer = (typeof(tmpFields.Pointer) === 'string') ? tmpFields.Pointer : '';
	tmpError.Step = (typeof(tmpFields.Step) === 'number') ? tmpFields.Step : null;
	tmpError.Entity = (typeof(tmpFields.Entity) === 'string') ? tmpFields.Entity : null;
	tmpError.Field = (typeof(tmpFields.Field) === 'string') ? tmpFields.Field : null;
	tmpError.DependsOn = (typeof(tmpFields.DependsOn) === 'string') ? tmpFields.DependsOn : null;
	return tmpError;
};

/**
 * A FACET_DEFINITION_INVALID error from Graph.resolvePath, as a definition error at pPointer.
 *
 * @param {any} pError
 * @param {string} pPointer - the path's pointer
 * @return {Error}
 */
const fromPathError = (pError, pPointer) =>
{
	if (pError && pError.DefinitionError)
	{
		return pError;
	}
	if (libFacetErrors.isFacetError(pError) && (pError.Code === 'FACET_DEFINITION_INVALID') && pError.Detail && (typeof(pError.Detail.Reason) === 'string'))
	{
		let tmpStep = (typeof(pError.Detail.Step) === 'number') ? pError.Detail.Step : null;
		return definitionError(pError.Detail.Reason,
			{
				Pointer: (tmpStep === null) ? pPointer : `${pPointer}/${tmpStep}`,
				Step: tmpStep,
				Entity: pError.Detail.Entity || null
			});
	}
	throw pError;
};

/**
 * 'alias.Column' / 'Column' → { Alias, Field } (null when malformed).
 *
 * @param {any} pText
 * @return {{ Alias: string|null, Field: string }|null}
 */
const parseFieldRef = (pText) =>
{
	let tmpMatch = (typeof(pText) === 'string') ? FIELD_REFERENCE_PATTERN.exec(pText) : null;
	return tmpMatch ? { Alias: tmpMatch[1] || null, Field: tmpMatch[2] } : null;
};

// ---------------------------------------------------------------- The built-in JSON schema validator

// Compiled regular expressions of schema patterns.
const SCHEMA_PATTERN_CACHE = new Map();

/**
 * Does pValue match the JSON schema type name?
 *
 * @param {string} pType
 * @param {any} pValue
 * @return {boolean}
 */
const schemaTypeMatches = (pType, pValue) =>
{
	switch (pType)
	{
		case 'null':
			return (pValue === null);
		case 'boolean':
			return (typeof(pValue) === 'boolean');
		case 'string':
			return (typeof(pValue) === 'string');
		case 'number':
			return (typeof(pValue) === 'number') && Number.isFinite(pValue);
		case 'integer':
			return (typeof(pValue) === 'number') && Number.isInteger(pValue);
		case 'array':
			return Array.isArray(pValue);
		case 'object':
			return isPlainObject(pValue);
		default:
			return false;
	}
};

/**
 * Resolve a local $ref ('#', '#/definitions/X').
 *
 * @param {Record<string, any>} pRoot
 * @param {string} pRef
 * @return {any} the schema, or undefined
 */
const resolveSchemaRef = (pRoot, pRef) =>
{
	if (pRef === '#')
	{
		return pRoot;
	}
	if ((typeof(pRef) !== 'string') || (pRef.indexOf('#/') !== 0))
	{
		return undefined;
	}
	let tmpNode = pRoot;
	let tmpParts = pRef.substring(2).split('/').map((pPart) => { return pPart.replace(/~1/g, '/').replace(/~0/g, '~'); });
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
 * The deepest error of a list (the branch that got furthest), first on ties.
 *
 * @param {Array<Record<string, any>>} pErrors
 * @return {Record<string, any>}
 */
const deepestError = (pErrors) =>
{
	let tmpBest = pErrors[0];
	for (let i = 1; i < pErrors.length; i++)
	{
		if (pErrors[i].Pointer.split('/').length > tmpBest.Pointer.split('/').length)
		{
			tmpBest = pErrors[i];
		}
	}
	return tmpBest;
};

/**
 * Validate a value against a schema node (the keywords Facet-Definition-Schema.json uses: type const
 * enum pattern properties propertyNames required additionalProperties items minItems maxItems
 * minLength maxLength minimum maximum oneOf anyOf $ref; annotations are ignored).  Returns the first
 * error, or null.
 *
 * @param {Record<string, any>} pRoot - the root schema ($ref target document)
 * @param {any} pSchema - the schema node
 * @param {any} pValue
 * @param {string} pPointer - JSON pointer of pValue
 * @return {{ Pointer: string, Keyword: string, Message: string }|null}
 */
const validateSchemaNode = (pRoot, pSchema, pValue, pPointer) =>
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
		let tmpTarget = resolveSchemaRef(pRoot, pSchema.$ref);
		if (typeof(tmpTarget) === 'undefined')
		{
			return fError('$ref', `Unresolvable $ref ${pSchema.$ref}.`);
		}
		return validateSchemaNode(pRoot, tmpTarget, pValue, pPointer);
	}
	if (hasOwn(pSchema, 'type'))
	{
		let tmpTypes = Array.isArray(pSchema.type) ? pSchema.type : [ pSchema.type ];
		if (!tmpTypes.some((pType) => { return schemaTypeMatches(pType, pValue); }))
		{
			return fError('type', `Expected ${tmpTypes.join(' | ')}.`);
		}
	}
	if (hasOwn(pSchema, 'const') && (canonicalJSON(pSchema.const) !== canonicalJSON(pValue)))
	{
		return fError('const', 'Unexpected value.');
	}
	if (Array.isArray(pSchema.enum))
	{
		let tmpValueJSON = canonicalJSON(pValue);
		if (!pSchema.enum.some((pAllowed) => { return canonicalJSON(pAllowed) === tmpValueJSON; }))
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
		if (typeof(pSchema.pattern) === 'string')
		{
			if (!SCHEMA_PATTERN_CACHE.has(pSchema.pattern))
			{
				SCHEMA_PATTERN_CACHE.set(pSchema.pattern, new RegExp(pSchema.pattern));
			}
			if (!SCHEMA_PATTERN_CACHE.get(pSchema.pattern).test(pValue))
			{
				return fError('pattern', 'Does not match the required pattern.');
			}
		}
	}
	if (typeof(pValue) === 'number')
	{
		if ((typeof(pSchema.minimum) === 'number') && (pValue < pSchema.minimum))
		{
			return fError('minimum', `Below ${pSchema.minimum}.`);
		}
		if ((typeof(pSchema.maximum) === 'number') && (pValue > pSchema.maximum))
		{
			return fError('maximum', `Above ${pSchema.maximum}.`);
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
				let tmpItemError = validateSchemaNode(pRoot, pSchema.items, pValue[i], `${pPointer}/${i}`);
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
				if (validateSchemaNode(pRoot, pSchema.propertyNames, tmpKeys[i], `${pPointer}/${pointerToken(tmpKeys[i])}`))
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
				let tmpPropertyError = validateSchemaNode(pRoot, tmpProperties[tmpKey], pValue[tmpKey], tmpChildPointer);
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
				let tmpAdditionalError = validateSchemaNode(pRoot, pSchema.additionalProperties, pValue[tmpKey], tmpChildPointer);
				if (tmpAdditionalError)
				{
					return tmpAdditionalError;
				}
			}
		}
	}
	if (Array.isArray(pSchema.anyOf))
	{
		let tmpErrors = [];
		for (let i = 0; i < pSchema.anyOf.length; i++)
		{
			let tmpBranchError = validateSchemaNode(pRoot, pSchema.anyOf[i], pValue, pPointer);
			if (!tmpBranchError)
			{
				tmpErrors = null;
				break;
			}
			tmpErrors.push(tmpBranchError);
		}
		if (tmpErrors)
		{
			return deepestError(tmpErrors);
		}
	}
	if (Array.isArray(pSchema.oneOf))
	{
		let tmpErrors = [];
		let tmpMatches = 0;
		for (let i = 0; i < pSchema.oneOf.length; i++)
		{
			let tmpBranchError = validateSchemaNode(pRoot, pSchema.oneOf[i], pValue, pPointer);
			if (tmpBranchError)
			{
				tmpErrors.push(tmpBranchError);
			}
			else
			{
				tmpMatches++;
			}
		}
		if (tmpMatches === 0)
		{
			return deepestError(tmpErrors);
		}
		if (tmpMatches > 1)
		{
			return fError('oneOf', 'Matches more than one allowed shape.');
		}
	}
	return null;
};

/**
 * Validate a value against the definitions schema (the whole file by default, or one
 * '#/definitions/X' entry schema).
 *
 * @param {any} pValue
 * @param {string} [pRef] - '#' (default) or '#/definitions/<Name>'
 * @param {string} [pPointer] - pointer prefix of pValue
 * @return {{ Pointer: string, Keyword: string, Message: string }|null}
 */
const validateSchema = (pValue, pRef, pPointer) =>
{
	return validateSchemaNode(DEFINITION_SCHEMA, { $ref: pRef || '#' }, pValue, pPointer || '');
};

// The file envelope schema: the root with the sections checked for type only (each entry is
// validated on its own, so one bad entry never disables its neighbours).
const ENVELOPE_SCHEMA = (() =>
{
	let tmpEnvelope = clone(DEFINITION_SCHEMA);
	tmpEnvelope.properties.Aliases = { type: 'object' };
	tmpEnvelope.properties.Scopes = { type: 'object' };
	tmpEnvelope.properties.Facets = { type: 'array' };
	tmpEnvelope.properties.Expressions = { type: 'object' };
	return deepFreeze(tmpEnvelope);
})();

/**
 * Validate a definitions file's envelope (FormatVersion, section types, no unknown keys).
 *
 * @param {any} pValue
 * @return {{ Pointer: string, Keyword: string, Message: string }|null}
 */
const validateEnvelope = (pValue) =>
{
	return validateSchemaNode(DEFINITION_SCHEMA, ENVELOPE_SCHEMA, pValue, '');
};

// ---------------------------------------------------------------- One compilation (a load or a validate)

/**
 * The per-run state of a compilation: source entries, their states, the disabled list and the
 * canonical results.  Not a service (one is built per load / validate).
 */
class DefinitionCompilation
{
	/**
	 * @param {RetoldFacetingDefinitionRegistry} pRegistry
	 * @param {{ Graph: any, Catalog: any, Policy: Record<string, any>, Options: Record<string, any>, ClauseCompiler: any }} pEnvironment
	 */
	constructor(pRegistry, pEnvironment)
	{
		this.fable = pRegistry.fable;
		this.Graph = pEnvironment.Graph;
		this.Catalog = pEnvironment.Catalog;
		this.Policy = pEnvironment.Policy || NONE_POLICY;
		this.Options = pEnvironment.Options;
		this.Limits = this.Options.Limits;
		this.ClauseCompiler = pEnvironment.ClauseCompiler;

		this.Disabled = [];
		this.FileWarnings = [];
		// name → entry (the first entry of a duplicated name; every duplicate is disabled)
		this.Aliases = new Map();
		this.Scopes = new Map();
		this.FacetEntries = [];
		this.AliasEntries = [];
		this.ScopeEntries = [];
		// Names defined by sources whose envelope failed (dependents are DependsOnDisabled).
		this.LostNames = { Alias: new Set(), Scope: new Set(), Facet: new Set() };
		this.Sources = [];
	}

	// ------------------------------------------------------------ entries and errors

	/**
	 * @param {string} pKind - 'Alias' | 'Scope' | 'Facet'
	 * @param {string} pName
	 * @param {Record<string, any>} pSource
	 * @param {string} pPointer
	 * @param {any} pRaw
	 * @return {Record<string, any>}
	 */
	_entry(pKind, pName, pSource, pPointer, pRaw)
	{
		return { Kind: pKind, Name: pName, Source: pSource.Source, Pointer: pPointer, Raw: pRaw, State: 'Pending', Result: null, Warnings: [], DefinitionHash: null };
	}

	/**
	 * Disable an entry (first error wins; an entry already disabled keeps its reason).
	 *
	 * @param {Record<string, any>} pEntry
	 * @param {any} pError
	 */
	_disable(pEntry, pError)
	{
		if (pEntry.State === 'Disabled')
		{
			return;
		}
		if (!pError || !pError.DefinitionError)
		{
			// An unexpected exception is still a disabled entry (never a partial load).
			this.fable.log.error(`RetoldFaceting definitions: ${pEntry.Kind} ${libFacetUtil.logSafe(pEntry.Name)} failed to compile: ${(pError && pError.message) ? pError.message : String(pError)}`);
			pError = definitionError('Internal', { Pointer: pEntry.Pointer });
		}
		pEntry.State = 'Disabled';
		pEntry.Result = null;
		this.Disabled.push(
			{
				Kind: pEntry.Kind,
				Name: pEntry.Name,
				Source: pEntry.Source,
				Errors:
				[
					{
						Code: 'FACET_DEFINITION_INVALID',
						Reason: pError.Reason,
						Pointer: pError.Pointer || pEntry.Pointer,
						Step: pError.Step,
						Entity: pError.Entity,
						Field: pError.Field,
						DependsOn: pError.DependsOn
					}
				]
			});
	}

	/**
	 * A warning on an entry.
	 *
	 * @param {Array<Record<string, any>>} pWarnings
	 * @param {string} pCode
	 * @param {string} pPointer
	 */
	_warn(pWarnings, pCode, pPointer)
	{
		if (!pWarnings.some((pWarning) => { return (pWarning.Code === pCode) && (pWarning.Pointer === pPointer); }))
		{
			pWarnings.push({ Code: pCode, Pointer: pPointer });
		}
	}

	/**
	 * A collector of what a canonical tree reads and binds.
	 *
	 * @param {Array<Record<string, any>>} pWarnings - the entry's warning list
	 * @return {Record<string, any>}
	 */
	_collector(pWarnings)
	{
		return { Entities: [], Binds: [], Relaxed: false, NoVisibleMatch: false, Unsupported: null, Warnings: pWarnings };
	}

	/**
	 * @param {Record<string, any>} pCollector
	 * @param {string} pEntity
	 */
	_addEntity(pCollector, pEntity)
	{
		if ((typeof(pEntity) === 'string') && (pCollector.Entities.indexOf(pEntity) < 0))
		{
			pCollector.Entities.push(pEntity);
		}
	}

	/**
	 * @param {Record<string, any>} pCollector
	 * @param {string} pFeature
	 */
	_unsupported(pCollector, pFeature)
	{
		if (!pCollector.Unsupported)
		{
			pCollector.Unsupported = { Feature: pFeature, Milestone: 2 };
		}
	}

	/**
	 * Merge collectors (in order) into a fresh one.
	 *
	 * @param {Array<Record<string, any>>} pCollectors
	 * @param {Array<Record<string, any>>} pWarnings
	 * @return {Record<string, any>}
	 */
	_mergeCollectors(pCollectors, pWarnings)
	{
		let tmpMerged = this._collector(pWarnings);
		pCollectors.forEach(
			(pCollector) =>
			{
				pCollector.Entities.forEach((pEntity) => { this._addEntity(tmpMerged, pEntity); });
				pCollector.Binds.forEach((pBind) => { if (tmpMerged.Binds.indexOf(pBind) < 0) { tmpMerged.Binds.push(pBind); } });
				tmpMerged.Relaxed = tmpMerged.Relaxed || pCollector.Relaxed;
				tmpMerged.NoVisibleMatch = tmpMerged.NoVisibleMatch || pCollector.NoVisibleMatch;
				if (!tmpMerged.Unsupported && pCollector.Unsupported)
				{
					tmpMerged.Unsupported = pCollector.Unsupported;
				}
			});
		return tmpMerged;
	}

	// ------------------------------------------------------------ the run

	/**
	 * Compile every source.
	 *
	 * @param {Array<Record<string, any>>} pSources - { Source, HashName, Content, Object, Error }
	 * @return {Record<string, any>}
	 */
	run(pSources)
	{
		this.Sources = pSources;
		pSources.forEach((pSource) => { this._collectSource(pSource); });
		this._markDuplicates();

		// Stage 1: each entry against its schema.
		this.AliasEntries.forEach(
			(pEntry) =>
			{
				let tmpError = validateSchema(pEntry.Name, '#/definitions/AliasName', pEntry.Pointer) || validateSchema(pEntry.Raw, '#/definitions/Path', pEntry.Pointer);
				if (tmpError)
				{
					this._disable(pEntry, definitionError('Schema', { Pointer: tmpError.Pointer }));
				}
			});
		this.ScopeEntries.forEach(
			(pEntry) =>
			{
				let tmpError = validateSchema(pEntry.Name, '#/definitions/QualifiedName', pEntry.Pointer) || validateSchema(pEntry.Raw, '#/definitions/ScopeDefinition', pEntry.Pointer);
				if (tmpError)
				{
					this._disable(pEntry, definitionError('Schema', { Pointer: tmpError.Pointer }));
				}
			});
		this.FacetEntries.forEach(
			(pEntry) =>
			{
				let tmpError = validateSchema(pEntry.Raw, '#/definitions/FacetDefinition', pEntry.Pointer);
				if (tmpError)
				{
					this._disable(pEntry, definitionError('Schema', { Pointer: tmpError.Pointer }));
				}
			});

		this.AliasEntries.forEach((pEntry) => { this._compileAlias(pEntry, []); });
		this.ScopeEntries.forEach((pEntry) => { this._compileScope(pEntry, []); });
		this.FacetEntries.forEach((pEntry) => { this._compileFacet(pEntry); });

		return this._result();
	}

	/**
	 * Split a source into entries (or disable it as a whole when its envelope is bad).
	 *
	 * @param {Record<string, any>} pSource
	 */
	_collectSource(pSource)
	{
		let fFileError = (pReason, pPointer) =>
		{
			this.Disabled.push(
				{
					Kind: 'File', Name: pSource.Source, Source: pSource.Source,
					Errors: [ { Code: 'FACET_DEFINITION_INVALID', Reason: pReason, Pointer: pPointer || '', Step: null, Entity: null, Field: null, DependsOn: null } ]
				});
		};
		if (pSource.Error)
		{
			fFileError(pSource.Error, '');
			return;
		}
		let tmpObject = pSource.Object;
		let tmpEnvelopeError = validateEnvelope(tmpObject);
		if (tmpEnvelopeError)
		{
			fFileError('Schema', tmpEnvelopeError.Pointer);
			// Best effort: the names it defined are lost, so dependents report DependsOnDisabled.
			if (isPlainObject(tmpObject))
			{
				if (isPlainObject(tmpObject.Aliases))
				{
					Object.keys(tmpObject.Aliases).forEach((pName) => { this.LostNames.Alias.add(pName); });
				}
				if (isPlainObject(tmpObject.Scopes))
				{
					Object.keys(tmpObject.Scopes).forEach((pName) => { this.LostNames.Scope.add(pName); });
				}
				if (Array.isArray(tmpObject.Facets))
				{
					tmpObject.Facets.forEach((pFacet) => { if (isPlainObject(pFacet) && (typeof(pFacet.Facet) === 'string')) { this.LostNames.Facet.add(pFacet.Facet); } });
				}
			}
			return;
		}
		if (hasOwn(tmpObject, 'Catalog'))
		{
			this.FileWarnings.push({ Code: 'CatalogSectionIgnored', Kind: 'File', Name: pSource.Source, Source: pSource.Source, Pointer: '/Catalog' });
		}
		if (isPlainObject(tmpObject.Aliases))
		{
			Object.keys(tmpObject.Aliases).forEach(
				(pName) =>
				{
					this.AliasEntries.push(this._entry('Alias', pName, pSource, `/Aliases/${pointerToken(pName)}`, tmpObject.Aliases[pName]));
				});
		}
		if (isPlainObject(tmpObject.Scopes))
		{
			Object.keys(tmpObject.Scopes).forEach(
				(pName) =>
				{
					this.ScopeEntries.push(this._entry('Scope', pName, pSource, `/Scopes/${pointerToken(pName)}`, tmpObject.Scopes[pName]));
				});
		}
		if (Array.isArray(tmpObject.Facets))
		{
			tmpObject.Facets.forEach(
				(pFacet, pIndex) =>
				{
					let tmpName = (isPlainObject(pFacet) && (typeof(pFacet.Facet) === 'string')) ? pFacet.Facet : `#facet${pIndex}`;
					this.FacetEntries.push(this._entry('Facet', tmpName, pSource, `/Facets/${pIndex}`, pFacet));
				});
		}
	}

	/**
	 * Stage 2 (names are global): a name defined twice disables every definition of it; a declared
	 * alias may not take a bridge alias name.
	 */
	_markDuplicates()
	{
		let fGroup = (pEntries, pLost) =>
		{
			let tmpCounts = new Map();
			pEntries.forEach((pEntry) => { tmpCounts.set(pEntry.Name, (tmpCounts.get(pEntry.Name) || 0) + 1); });
			return (pEntry) => { return (tmpCounts.get(pEntry.Name) > 1) || pLost.has(pEntry.Name); };
		};
		let fAliasDuplicate = fGroup(this.AliasEntries, this.LostNames.Alias);
		let fScopeDuplicate = fGroup(this.ScopeEntries, this.LostNames.Scope);
		let fFacetDuplicate = fGroup(this.FacetEntries, this.LostNames.Facet);
		this.AliasEntries.forEach(
			(pEntry) =>
			{
				if (!this.Aliases.has(pEntry.Name))
				{
					this.Aliases.set(pEntry.Name, pEntry);
				}
				if (fAliasDuplicate(pEntry))
				{
					this._disable(pEntry, definitionError('DuplicateName', { Pointer: pEntry.Pointer }));
				}
				else if (this.Graph && this.Graph.alias(pEntry.Name))
				{
					this._disable(pEntry, definitionError('AliasShadowsBridge', { Pointer: pEntry.Pointer }));
				}
			});
		this.ScopeEntries.forEach(
			(pEntry) =>
			{
				if (!this.Scopes.has(pEntry.Name))
				{
					this.Scopes.set(pEntry.Name, pEntry);
				}
				if (fScopeDuplicate(pEntry))
				{
					this._disable(pEntry, definitionError('DuplicateName', { Pointer: pEntry.Pointer }));
				}
			});
		this.FacetEntries.forEach(
			(pEntry) =>
			{
				if (fFacetDuplicate(pEntry))
				{
					this._disable(pEntry, definitionError('DuplicateName', { Pointer: pEntry.Pointer }));
				}
			});
	}

	// ------------------------------------------------------------ aliases (stage 3)

	/**
	 * The entity a declared alias starts on when it can be told from its first step (null for a
	 * co-reference, which stands on any co-referencing entity).
	 *
	 * @param {any} pFirst
	 * @return {string|null}
	 */
	_aliasStart(pFirst)
	{
		if (isPlainObject(pFirst) && (typeof(pFirst.Via) === 'string'))
		{
			return pFirst.Via.split('.')[0];
		}
		let tmpText = isPlainObject(pFirst) ? pFirst.Step : pFirst;
		let tmpMatch = (typeof(tmpText) === 'string') ? /^([<>=])([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(tmpText) : null;
		if (!tmpMatch || (tmpMatch[1] === '='))
		{
			return null;
		}
		if (tmpMatch[1] === '>')
		{
			return tmpMatch[2];
		}
		let tmpEdge = this.Graph.edge(`${tmpMatch[2]}.${tmpMatch[3]}`);
		return tmpEdge ? tmpEdge.To : tmpMatch[2];
	}

	/**
	 * Splice a declared alias (recursively) and check that it resolves from its natural start.
	 *
	 * @param {Record<string, any>} pEntry
	 * @param {Array<string>} pStack - aliases being compiled (cycle detection)
	 * @return {Record<string, any>} the entry
	 */
	_compileAlias(pEntry, pStack)
	{
		if ((pEntry.State === 'Done') || (pEntry.State === 'Disabled'))
		{
			return pEntry;
		}
		if (pStack.indexOf(pEntry.Name) >= 0)
		{
			// Every alias in the cycle is disabled.
			pStack.slice(pStack.indexOf(pEntry.Name)).forEach(
				(pName) =>
				{
					let tmpMember = this.Aliases.get(pName);
					if (tmpMember)
					{
						this._disable(tmpMember, definitionError('AliasCycle', { Pointer: tmpMember.Pointer }));
					}
				});
			return pEntry;
		}
		pEntry.State = 'Compiling';
		try
		{
			if (!this.Graph)
			{
				throw definitionError('UnknownEntity', { Pointer: pEntry.Pointer });
			}
			let tmpEntries = [];
			try
			{
				tmpEntries = this.Graph.pathEntries(pEntry.Raw);
			}
			catch (pPathError)
			{
				throw fromPathError(pPathError, pEntry.Pointer);
			}
			let tmpSteps = [];
			for (let i = 0; i < tmpEntries.length; i++)
			{
				let tmpStep = tmpEntries[i];
				let tmpMatch = (typeof(tmpStep) === 'string') ? /^@(.+)$/.exec(tmpStep) : null;
				if (!tmpMatch)
				{
					tmpSteps.push(clone(tmpStep));
					continue;
				}
				let tmpName = tmpMatch[1];
				let tmpDeclared = this.Aliases.get(tmpName);
				if (tmpDeclared)
				{
					this._compileAlias(tmpDeclared, pStack.concat([ pEntry.Name ]));
					if (tmpDeclared.State !== 'Done')
					{
						throw definitionError('DependsOnDisabled', { Pointer: `${pEntry.Pointer}/${i}`, DependsOn: tmpName });
					}
					tmpDeclared.Result.forEach((pSpliced) => { tmpSteps.push(clone(pSpliced)); });
					continue;
				}
				if (this.LostNames.Alias.has(tmpName))
				{
					throw definitionError('DependsOnDisabled', { Pointer: `${pEntry.Pointer}/${i}`, DependsOn: tmpName });
				}
				let tmpBridge = this.Graph.alias(tmpName);
				if (!tmpBridge)
				{
					throw definitionError('UnknownAlias', { Pointer: `${pEntry.Pointer}/${i}`, Step: tmpSteps.length });
				}
				tmpBridge.forEach((pSpliced) => { tmpSteps.push(pSpliced); });
			}
			let tmpStart = (tmpSteps.length > 0) ? this._aliasStart(tmpSteps[0]) : null;
			if (tmpStart)
			{
				try
				{
					this.Graph.resolvePath(tmpStart, tmpSteps, { MaxHops: this.Limits.MaxHops });
				}
				catch (pPathError)
				{
					throw fromPathError(pPathError, pEntry.Pointer);
				}
			}
			pEntry.Result = deepFreeze(tmpSteps);
			pEntry.State = 'Done';
		}
		catch (pError)
		{
			this._disable(pEntry, pError);
		}
		return pEntry;
	}

	/**
	 * The enabled declared aliases (name → canonical steps) for Graph.resolvePath.
	 *
	 * @return {Map<string, any>}
	 */
	_aliasMap()
	{
		let tmpMap = new Map();
		this.Aliases.forEach((pEntry, pName) => { if (pEntry.State === 'Done') { tmpMap.set(pName, pEntry.Result); } });
		return tmpMap;
	}

	// ------------------------------------------------------------ fields, params, tokens

	/**
	 * Is pColumn a scope-policy column of pEntity (the policy Column wherever it exists, the
	 * entity's PersonalScopes column, its Required columns)?
	 *
	 * @param {string} pEntity
	 * @param {string} pColumn
	 * @param {Record<string, any>|null} pInfo - ColumnInfo
	 * @return {boolean}
	 */
	_isPolicyColumn(pEntity, pColumn, pInfo)
	{
		if (pInfo && (pInfo.IsPolicyColumn === true))
		{
			return true;
		}
		let tmpPolicy = this.Policy;
		if ((typeof(tmpPolicy.Column) === 'string') && (tmpPolicy.Column === pColumn))
		{
			return true;
		}
		if (isPlainObject(tmpPolicy.PersonalScopes) && hasOwn(tmpPolicy.PersonalScopes, pEntity) && (tmpPolicy.PersonalScopes[pEntity].Column === pColumn))
		{
			return true;
		}
		if (isPlainObject(tmpPolicy.Required) && hasOwn(tmpPolicy.Required, pEntity) && Array.isArray(tmpPolicy.Required[pEntity]))
		{
			return tmpPolicy.Required[pEntity].some((pEntry) => { return pEntry && (pEntry.Column === pColumn); });
		}
		return false;
	}

	/**
	 * Every policy column name ($Scope.<Column> tokens).
	 *
	 * @return {Array<string>}
	 */
	_policyColumns()
	{
		let tmpPolicy = this.Policy;
		let tmpColumns = [];
		let fAdd = (pColumn) => { if ((typeof(pColumn) === 'string') && (tmpColumns.indexOf(pColumn) < 0)) { tmpColumns.push(pColumn); } };
		fAdd(tmpPolicy.Column);
		if (isPlainObject(tmpPolicy.PersonalScopes))
		{
			Object.keys(tmpPolicy.PersonalScopes).forEach((pEntity) => { fAdd(tmpPolicy.PersonalScopes[pEntity].Column); });
		}
		if (isPlainObject(tmpPolicy.Required))
		{
			Object.keys(tmpPolicy.Required).forEach((pEntity) => { (Array.isArray(tmpPolicy.Required[pEntity]) ? tmpPolicy.Required[pEntity] : []).forEach((pEntry) => { fAdd(pEntry && pEntry.Column); }); });
		}
		return tmpColumns;
	}

	/**
	 * Stage 5: a catalog column of the entity a predicate is evaluated on, never the delete column or
	 * a policy column.
	 *
	 * @param {string} pEntity
	 * @param {string} pField
	 * @param {string} pPointer
	 * @return {Record<string, any>} ColumnInfo
	 */
	_checkField(pEntity, pField, pPointer)
	{
		let tmpInfo = (this.Catalog && (typeof(pEntity) === 'string')) ? this.Catalog.column(pEntity, pField) : null;
		if (!tmpInfo)
		{
			throw definitionError('UnknownField', { Pointer: pPointer, Entity: pEntity, Field: pField });
		}
		if (tmpInfo.IsDeleteColumn)
		{
			throw definitionError('DeletedField', { Pointer: pPointer, Entity: pEntity, Field: pField });
		}
		if (this._isPolicyColumn(pEntity, pField, tmpInfo))
		{
			throw definitionError('PolicyField', { Pointer: pPointer, Entity: pEntity, Field: pField });
		}
		return tmpInfo;
	}

	/**
	 * Check one value against a declared param schema (internal-contracts §22.3).
	 *
	 * @param {Record<string, any>} pSchema
	 * @param {any} pValue
	 * @return {{ Ok: boolean, Value?: any }}
	 */
	_checkParamValue(pSchema, pValue)
	{
		let tmpMaxInList = this.Limits.MaxInList || libFacetRequest.LIMIT_DEFAULTS.MaxInList;
		let fInteger = (pCandidate) =>
		{
			let tmpNumber = (typeof(pCandidate) === 'number') ? pCandidate : ((typeof(pCandidate) === 'string') ? libFacetUtil.toFiniteNumber(pCandidate.trim()) : null);
			if ((tmpNumber === null) || !Number.isInteger(tmpNumber))
			{
				return null;
			}
			if ((typeof(pSchema.Min) === 'number') && (tmpNumber < pSchema.Min))
			{
				return null;
			}
			if ((typeof(pSchema.Max) === 'number') && (tmpNumber > pSchema.Max))
			{
				return null;
			}
			return tmpNumber;
		};
		let tmpValues = Array.isArray(pSchema.Values) ? pSchema.Values : [];
		switch (pSchema.Type)
		{
			case 'Enum':
				return (tmpValues.indexOf(pValue) >= 0) ? { Ok: true, Value: pValue } : { Ok: false };
			case 'EnumList':
				{
					if (!Array.isArray(pValue) || (pValue.length < 1) || (pValue.length > tmpMaxInList))
					{
						return { Ok: false };
					}
					let tmpDistinct = new Set(pValue.map((pMember) => { return canonicalJSON(pMember); }));
					if ((tmpDistinct.size !== pValue.length) || !pValue.every((pMember) => { return tmpValues.indexOf(pMember) >= 0; }))
					{
						return { Ok: false };
					}
					return { Ok: true, Value: pValue.slice() };
				}
			case 'Integer':
				{
					let tmpInteger = fInteger(pValue);
					return (tmpInteger === null) ? { Ok: false } : { Ok: true, Value: tmpInteger };
				}
			case 'IntegerList':
				{
					if (!Array.isArray(pValue) || (pValue.length < 1) || (pValue.length > tmpMaxInList))
					{
						return { Ok: false };
					}
					let tmpIntegers = pValue.map(fInteger);
					return tmpIntegers.some((pInteger) => { return pInteger === null; }) ? { Ok: false } : { Ok: true, Value: tmpIntegers };
				}
			case 'String':
				{
					let tmpMaxLength = (typeof(pSchema.MaxLength) === 'number') ? pSchema.MaxLength : DEFAULT_PARAM_MAX_LENGTH;
					if ((typeof(pValue) !== 'string') || (pValue.length > tmpMaxLength) || libFacetClauses.TILDE_PATTERN.test(pValue))
					{
						return { Ok: false };
					}
					return { Ok: true, Value: pValue };
				}
			case 'Boolean':
				if ((pValue === true) || (pValue === 1) || (pValue === '1') || (pValue === 'true'))
				{
					return { Ok: true, Value: 1 };
				}
				if ((pValue === false) || (pValue === 0) || (pValue === '0') || (pValue === 'false'))
				{
					return { Ok: true, Value: 0 };
				}
				return { Ok: false };
			case 'DateTime':
				{
					let tmpCanonical = (typeof(pValue) === 'string') ? libFacetBuckets.canonicalDateTime(pValue) : null;
					return (tmpCanonical === null) ? { Ok: false } : { Ok: true, Value: tmpCanonical };
				}
			default:
				return { Ok: false };
		}
	}

	/**
	 * A declared Params schema, checked (ParamSchema) and canonicalized (Defaults canonical).
	 *
	 * @param {any} pParams
	 * @param {string} pPointer
	 * @return {Record<string, any>} name → { Type, Values?, Default?, Min?, Max?, MaxLength?, Description? }
	 */
	_checkParams(pParams, pPointer)
	{
		let tmpResult = {};
		if (!isPlainObject(pParams))
		{
			return tmpResult;
		}
		Object.keys(pParams).forEach(
			(pName) =>
			{
				let tmpSchema = pParams[pName];
				let tmpPointer = `${pPointer}/${pointerToken(pName)}`;
				let fBad = () => { throw definitionError('ParamSchema', { Pointer: tmpPointer, Field: pName }); };
				if (PARAM_TYPES.indexOf(tmpSchema.Type) < 0)
				{
					fBad();
				}
				let tmpIsEnum = (tmpSchema.Type === 'Enum') || (tmpSchema.Type === 'EnumList');
				let tmpIsInteger = (tmpSchema.Type === 'Integer') || (tmpSchema.Type === 'IntegerList');
				if (tmpIsEnum !== Array.isArray(tmpSchema.Values))
				{
					fBad();
				}
				if (!tmpIsInteger && (hasOwn(tmpSchema, 'Min') || hasOwn(tmpSchema, 'Max')))
				{
					fBad();
				}
				if ((typeof(tmpSchema.Min) === 'number') && (typeof(tmpSchema.Max) === 'number') && (tmpSchema.Min > tmpSchema.Max))
				{
					fBad();
				}
				if ((tmpSchema.Type !== 'String') && hasOwn(tmpSchema, 'MaxLength'))
				{
					fBad();
				}
				let tmpCanonical = { Type: tmpSchema.Type };
				[ 'Values', 'Min', 'Max', 'MaxLength', 'Description' ].forEach((pKey) => { if (hasOwn(tmpSchema, pKey)) { tmpCanonical[pKey] = clone(tmpSchema[pKey]); } });
				if (hasOwn(tmpSchema, 'Default'))
				{
					let tmpDefault = this._checkParamValue(tmpSchema, tmpSchema.Default);
					if (!tmpDefault.Ok)
					{
						fBad();
					}
					tmpCanonical.Default = tmpDefault.Value;
				}
				tmpResult[pName] = tmpCanonical;
			});
		return tmpResult;
	}

	/**
	 * Resolve a $-token in a context (internal-contracts §22.2): { Bind, Kind, Field?, Schema? } for a
	 * token the Binder binds, or { Value, Schema } for a param an inlined scope reference fixed to a
	 * literal.
	 *
	 * @param {string} pToken
	 * @param {Record<string, any>} pContext
	 * @param {string} pPointer
	 * @return {Record<string, any>}
	 */
	_resolveToken(pToken, pContext, pPointer)
	{
		let tmpMatch = TOKEN_PATTERN.exec(pToken);
		if (!tmpMatch)
		{
			throw definitionError('UnknownToken', { Pointer: pPointer });
		}
		if (tmpMatch[3])
		{
			return { Bind: pToken, Kind: 'Date' };
		}
		let tmpName = tmpMatch[2];
		switch (tmpMatch[1])
		{
			case 'CurrentUser':
				{
					let tmpFields = [ 'IDUser', 'IDCustomer' ].concat(Array.isArray(this.Options.Scope.UserRecordFields) ? this.Options.Scope.UserRecordFields : []);
					if (tmpFields.indexOf(tmpName) < 0)
					{
						throw definitionError('UnknownToken', { Pointer: pPointer });
					}
					return { Bind: pToken, Kind: 'CurrentUser', Field: tmpName };
				}
			case 'Scope':
				if (this._policyColumns().indexOf(tmpName) < 0)
				{
					throw definitionError('UnknownToken', { Pointer: pPointer });
				}
				return { Bind: pToken, Kind: 'Scope', Field: tmpName };
			case 'StartOf':
				if (libFacetBuckets.INTERVAL_ORDER.indexOf(tmpName) < 0)
				{
					throw definitionError('UnknownToken', { Pointer: pPointer });
				}
				return { Bind: pToken, Kind: 'Date' };
			case 'Param':
				if (pContext.Substitution)
				{
					if (!pContext.Substitution.has(tmpName))
					{
						throw definitionError('UndeclaredParam', { Pointer: pPointer, Field: tmpName });
					}
					return pContext.Substitution.get(tmpName);
				}
				if (!isPlainObject(pContext.Params) || !hasOwn(pContext.Params, tmpName))
				{
					throw definitionError('UndeclaredParam', { Pointer: pPointer, Field: tmpName });
				}
				return { Bind: pToken, Kind: 'Param', Field: tmpName, Schema: pContext.Params[tmpName] };
			default:
				throw definitionError('UnknownToken', { Pointer: pPointer });
		}
	}

	/**
	 * Is a resolved token's type compatible with the column (TokenType)?
	 *
	 * @param {Record<string, any>} pResolved
	 * @param {Record<string, any>} pColumn
	 * @param {string} pPointer
	 */
	_checkTokenType(pResolved, pColumn, pPointer)
	{
		let tmpDataType = pColumn.DataType;
		let fBad = () => { throw definitionError('TokenType', { Pointer: pPointer, Entity: pColumn.Entity, Field: pColumn.Column }); };
		if ((pResolved.Kind === 'Date') && (tmpDataType !== 'DateTime'))
		{
			fBad();
		}
		if ((pResolved.Kind === 'CurrentUser') && ((pResolved.Field === 'IDUser') || (pResolved.Field === 'IDCustomer')) && !libFacetBuckets.isNumericType(tmpDataType))
		{
			fBad();
		}
		if ((pResolved.Kind === 'Param') && pResolved.Schema)
		{
			let tmpType = pResolved.Schema.Type;
			if (((tmpType === 'Integer') || (tmpType === 'IntegerList') || (tmpType === 'Boolean')) && !libFacetBuckets.isNumericType(tmpDataType))
			{
				fBad();
			}
			if ((tmpType === 'DateTime') && (tmpDataType !== 'DateTime'))
			{
				fBad();
			}
			if (((tmpType === 'Enum') || (tmpType === 'EnumList')) && Array.isArray(pResolved.Schema.Values))
			{
				pResolved.Schema.Values.forEach(
					(pMember) =>
					{
						try
						{
							this.ClauseCompiler.coerceValue(pColumn, pMember);
						}
						catch (pCoerceError)
						{
							fBad();
						}
					});
			}
		}
	}

	/**
	 * Coerce a literal by the column DataType (ClauseCompiler.coerceValue; LIKE patterns stay strings).
	 *
	 * @param {Record<string, any>} pColumn
	 * @param {string} pOp
	 * @param {any} pValue
	 * @param {string} pPointer
	 * @return {any}
	 */
	_coerce(pColumn, pOp, pValue, pPointer)
	{
		if ((typeof(pValue) === 'string') && (pValue.charAt(0) === '$'))
		{
			// A token is a whole Value, never an array member or a param's literal.
			throw definitionError('UnknownToken', { Pointer: pPointer });
		}
		let tmpInfo = (LIKE_OPS.indexOf(pOp) >= 0) ? { Column: pColumn.Column, DataType: 'String' } : pColumn;
		try
		{
			return this.ClauseCompiler.coerceValue(tmpInfo, pValue);
		}
		catch (pCoerceError)
		{
			throw definitionError('InvalidValue', { Pointer: pPointer, Entity: pColumn.Entity, Field: pColumn.Column });
		}
	}

	// ------------------------------------------------------------ canonical predicates (stages 5–8)

	/**
	 * A context on another entity (an existence node's Where, a step Where).
	 *
	 * @param {Record<string, any>} pContext
	 * @param {string} pEntity
	 * @return {Record<string, any>}
	 */
	_on(pContext, pEntity)
	{
		return Object.assign({}, pContext, { Entity: pEntity, Tuple: null, DefaultFrom: null });
	}

	/**
	 * And of canonical items (flattened; nulls dropped; one item → the item; none → null).
	 *
	 * @param {Array<any>} pItems
	 * @return {Record<string, any>|null}
	 */
	_and(pItems)
	{
		let tmpItems = [];
		pItems.forEach(
			(pItem) =>
			{
				if (!pItem)
				{
					return;
				}
				if (Array.isArray(pItem.And))
				{
					pItem.And.forEach((pChild) => { tmpItems.push(pChild); });
					return;
				}
				tmpItems.push(pItem);
			});
		if (tmpItems.length < 1)
		{
			return null;
		}
		return (tmpItems.length === 1) ? tmpItems[0] : { And: tmpItems };
	}

	/**
	 * Or of canonical items (flattened; one item → the item).
	 *
	 * @param {Array<any>} pItems
	 * @return {Record<string, any>|null}
	 */
	_or(pItems)
	{
		let tmpItems = [];
		pItems.forEach(
			(pItem) =>
			{
				if (!pItem)
				{
					return;
				}
				if (Array.isArray(pItem.Or))
				{
					pItem.Or.forEach((pChild) => { tmpItems.push(pChild); });
					return;
				}
				tmpItems.push(pItem);
			});
		if (tmpItems.length < 1)
		{
			return null;
		}
		return (tmpItems.length === 1) ? tmpItems[0] : { Or: tmpItems };
	}

	/**
	 * A Where list as one canonical predicate (an And; one item → the item; empty → null).
	 *
	 * @param {any} pItems
	 * @param {Record<string, any>} pContext
	 * @param {string} pPointer
	 * @return {Record<string, any>|null}
	 */
	_canonicalWhere(pItems, pContext, pPointer)
	{
		if (!Array.isArray(pItems) || (pItems.length < 1))
		{
			return null;
		}
		return this._and(pItems.map((pItem, pIndex) => { return this._canonicalPred(pItem, pContext, `${pPointer}/${pIndex}`, false); }));
	}

	/**
	 * One authored Pred → CanonicalPred (Any → Or, Not pushed down, scope references inlined).
	 *
	 * @param {Record<string, any>} pItem
	 * @param {Record<string, any>} pContext
	 * @param {string} pPointer
	 * @param {boolean} pNegated
	 * @return {Record<string, any>|null}
	 */
	_canonicalPred(pItem, pContext, pPointer, pNegated)
	{
		if (!isPlainObject(pItem))
		{
			throw definitionError('Schema', { Pointer: pPointer });
		}
		if (hasOwn(pItem, 'Field'))
		{
			return this._canonicalLeaf(pItem, pContext, pPointer, pNegated);
		}
		if (hasOwn(pItem, 'Expr'))
		{
			this._unsupported(pContext.Collector, 'Computed');
			return { Expr: pItem.Expr, Op: pNegated ? NEGATED_OPS[pItem.Op] : pItem.Op, Value: clone(pItem.Value) };
		}
		if (Array.isArray(pItem.And))
		{
			let tmpChildren = pItem.And.map((pChild, pIndex) => { return this._canonicalPred(pChild, pContext, `${pPointer}/And/${pIndex}`, pNegated); });
			return pNegated ? this._or(tmpChildren) : this._and(tmpChildren);
		}
		if (Array.isArray(pItem.Or) || Array.isArray(pItem.Any))
		{
			let tmpKey = Array.isArray(pItem.Or) ? 'Or' : 'Any';
			let tmpChildren = pItem[tmpKey].map((pChild, pIndex) => { return this._canonicalPred(pChild, pContext, `${pPointer}/${tmpKey}/${pIndex}`, pNegated); });
			return pNegated ? this._and(tmpChildren) : this._or(tmpChildren);
		}
		if (hasOwn(pItem, 'Not'))
		{
			return this._canonicalPred(pItem.Not, pContext, `${pPointer}/Not`, !pNegated);
		}
		if (hasOwn(pItem, 'Exists') || hasOwn(pItem, 'NotExists'))
		{
			let tmpKey = hasOwn(pItem, 'Exists') ? 'Exists' : 'NotExists';
			let tmpKind = ((tmpKey === 'Exists') !== pNegated) ? 'Exists' : 'NotExists';
			let tmpBody = this._existenceBody(pItem[tmpKey], pContext, `${pPointer}/${tmpKey}`, 'Existence');
			if (tmpKind === 'NotExists')
			{
				pContext.Collector.NoVisibleMatch = true;
			}
			return { [tmpKind]: tmpBody };
		}
		if (hasOwn(pItem, 'All') || hasOwn(pItem, 'AllNonEmpty'))
		{
			let tmpKey = hasOwn(pItem, 'All') ? 'All' : 'AllNonEmpty';
			this._unsupported(pContext.Collector, 'Quantified');
			let tmpBody = this._existenceBody(pItem[tmpKey], pContext, `${pPointer}/${tmpKey}`, 'Existence');
			return { [tmpKey]: tmpBody, Negated: pNegated };
		}
		if (hasOwn(pItem, 'HavingCount'))
		{
			let tmpBody = this._existenceBody(pItem.HavingCount, pContext, `${pPointer}/HavingCount`, 'Existence');
			let tmpSteps = tmpBody.Path.Steps;
			if ((tmpSteps.length !== 1) || ((tmpSteps[0].Direction !== 'Reverse') && (tmpSteps[0].Direction !== 'CoReference')))
			{
				this._unsupported(pContext.Collector, 'HavingCountPath');
			}
			tmpBody.Op = pNegated ? NEGATED_COUNT_OPS[pItem.HavingCount.Op] : pItem.HavingCount.Op;
			tmpBody.Value = pItem.HavingCount.Value;
			return { HavingCount: tmpBody };
		}
		if (hasOwn(pItem, 'Scope'))
		{
			return this._inlineScope(pItem, pContext, pPointer, pNegated);
		}
		throw definitionError('Schema', { Pointer: pPointer });
	}

	/**
	 * A column leaf.
	 *
	 * @param {Record<string, any>} pItem - { Field, Op, Value? }
	 * @param {Record<string, any>} pContext
	 * @param {string} pPointer
	 * @param {boolean} pNegated
	 * @return {Record<string, any>}
	 */
	_canonicalLeaf(pItem, pContext, pPointer, pNegated)
	{
		let tmpReference = parseFieldRef(pItem.Field);
		if (!tmpReference)
		{
			throw definitionError('UnknownField', { Pointer: `${pPointer}/Field` });
		}
		let tmpEntity = pContext.Entity;
		let tmpAlias = null;
		if (pContext.Tuple)
		{
			tmpAlias = tmpReference.Alias || pContext.DefaultFrom;
			if (!pContext.Tuple.has(tmpAlias))
			{
				throw definitionError('TupleAlias', { Pointer: `${pPointer}/Field` });
			}
			tmpEntity = pContext.Tuple.get(tmpAlias);
		}
		else if (tmpReference.Alias)
		{
			throw definitionError('UnknownField', { Pointer: `${pPointer}/Field`, Entity: tmpEntity, Field: pItem.Field });
		}
		let tmpColumn = this._checkField(tmpEntity, tmpReference.Field, `${pPointer}/Field`);
		let tmpOp = pItem.Op;
		let tmpLeaf = {};
		if (tmpAlias)
		{
			tmpLeaf.Alias = tmpAlias;
		}
		tmpLeaf.Field = tmpReference.Field;
		tmpLeaf.Op = pNegated ? NEGATED_OPS[tmpOp] : tmpOp;
		let tmpHasValue = hasOwn(pItem, 'Value');
		let tmpValuePointer = `${pPointer}/Value`;
		if (NO_VALUE_OPS.indexOf(tmpOp) >= 0)
		{
			if (tmpHasValue)
			{
				throw definitionError('InvalidValue', { Pointer: tmpValuePointer, Entity: tmpEntity, Field: tmpReference.Field });
			}
			return tmpLeaf;
		}
		if (!tmpHasValue)
		{
			throw definitionError('InvalidValue', { Pointer: tmpValuePointer, Entity: tmpEntity, Field: tmpReference.Field });
		}
		let tmpIsList = (LIST_OPS.indexOf(tmpOp) >= 0);
		let tmpValue = pItem.Value;
		if ((typeof(tmpValue) === 'string') && (tmpValue.charAt(0) === '$'))
		{
			let tmpResolved = this._resolveToken(tmpValue, pContext, tmpValuePointer);
			if (hasOwn(tmpResolved, 'Value'))
			{
				// A param the enclosing scope reference fixed to a literal.
				tmpLeaf.Value = this._literalValue(tmpColumn, tmpOp, tmpResolved.Value, tmpValuePointer, true);
				return tmpLeaf;
			}
			let tmpListParam = (tmpResolved.Kind === 'Param') && tmpResolved.Schema && (LIST_PARAM_TYPES.indexOf(tmpResolved.Schema.Type) >= 0);
			let tmpEnumParam = (tmpResolved.Kind === 'Param') && tmpResolved.Schema && (tmpResolved.Schema.Type === 'Enum');
			if (tmpIsList ? !(tmpListParam || tmpEnumParam) : tmpListParam)
			{
				throw definitionError('ParamShape', { Pointer: tmpValuePointer, Entity: tmpEntity, Field: tmpReference.Field });
			}
			this._checkTokenType(tmpResolved, tmpColumn, tmpValuePointer);
			tmpLeaf.Bind = tmpResolved.Bind;
			if (pContext.Collector.Binds.indexOf(tmpResolved.Bind) < 0)
			{
				pContext.Collector.Binds.push(tmpResolved.Bind);
			}
			return tmpLeaf;
		}
		tmpLeaf.Value = this._literalValue(tmpColumn, tmpOp, tmpValue, tmpValuePointer, false);
		return tmpLeaf;
	}

	/**
	 * A literal leaf value: IN / NIN a non-empty list (a scalar param literal becomes a one-element
	 * list), every other op one scalar; each value coerced by the column DataType.
	 *
	 * @param {Record<string, any>} pColumn
	 * @param {string} pOp
	 * @param {any} pValue
	 * @param {string} pPointer
	 * @param {boolean} pFromParam - the value came from a param (shape errors are ParamShape)
	 * @return {any}
	 */
	_literalValue(pColumn, pOp, pValue, pPointer, pFromParam)
	{
		let tmpShapeReason = pFromParam ? 'ParamShape' : 'InvalidValue';
		if (LIST_OPS.indexOf(pOp) >= 0)
		{
			let tmpList = Array.isArray(pValue) ? pValue : (pFromParam ? [ pValue ] : null);
			if (!tmpList || (tmpList.length < 1))
			{
				throw definitionError(tmpShapeReason, { Pointer: pPointer, Entity: pColumn.Entity, Field: pColumn.Column });
			}
			return tmpList.map((pMember, pIndex) => { return this._coerce(pColumn, pOp, pMember, `${pPointer}/${pIndex}`); });
		}
		if (Array.isArray(pValue) || (pValue === null) || isPlainObject(pValue))
		{
			throw definitionError(tmpShapeReason, { Pointer: pPointer, Entity: pColumn.Entity, Field: pColumn.Column });
		}
		return this._coerce(pColumn, pOp, pValue, pPointer);
	}

	/**
	 * The body of an existence predicate (Exists / NotExists / HavingCount / All): From, the resolved
	 * path (step Wheres canonical, TenantOnly checked), Where on the path's last entity, Correlate.
	 *
	 * @param {Record<string, any>} pBody - { Path, Where?, From?, Correlate? }
	 * @param {Record<string, any>} pContext
	 * @param {string} pPointer
	 * @param {string} pPathContext - 'Existence'
	 * @return {Record<string, any>}
	 */
	_existenceBody(pBody, pContext, pPointer, pPathContext)
	{
		let tmpFrom = null;
		let tmpStart = pContext.Entity;
		if (hasOwn(pBody, 'From'))
		{
			if (!pContext.Tuple || !pContext.Tuple.has(pBody.From))
			{
				throw definitionError('TupleAlias', { Pointer: `${pPointer}/From` });
			}
			tmpFrom = pBody.From;
			tmpStart = pContext.Tuple.get(tmpFrom);
		}
		else if (pContext.Tuple)
		{
			tmpFrom = pContext.DefaultFrom;
			tmpStart = pContext.Tuple.get(tmpFrom);
		}
		let tmpPath = this._resolvePath(tmpStart, pBody.Path, pContext, `${pPointer}/Path`, pPathContext);
		let tmpWhere = this._canonicalWhere(pBody.Where, this._on(pContext, tmpPath.To), `${pPointer}/Where`);
		let tmpCorrelate = this._canonicalCorrelate(pBody.Correlate, pContext, tmpFrom, tmpStart, tmpPath.To, `${pPointer}/Correlate`);
		if (tmpPath.Steps.some((pStep) => { return pStep.Scope === 'TenantOnly'; })
			&& (this._bindsParam(tmpWhere) || tmpPath.Steps.some((pStep) => { return this._bindsParam(pStep.Where); })))
		{
			// A client-chosen value compared with the relaxed rows (other users' rows) would let a
			// client binary-search their private column values (06 §4.4): only literals and
			// $CurrentUser / $Scope / $Now tokens may appear under a TenantOnly path.
			throw definitionError('TenantOnlyParam', { Pointer: `${pPointer}/Where` });
		}
		return { From: tmpFrom, Path: tmpPath, Where: tmpWhere, Correlate: tmpCorrelate };
	}

	/**
	 * Correlate pairs [ outer, inner ] → [ { Outer: { Alias, Field }, Inner } ] (numeric-class match).
	 *
	 * @param {any} pPairs
	 * @param {Record<string, any>} pContext
	 * @param {string|null} pFrom - the path's tuple side (null on an entity pivot)
	 * @param {string} pOuterEntity
	 * @param {string} pInnerEntity
	 * @param {string} pPointer
	 * @return {Array<Record<string, any>>}
	 */
	_canonicalCorrelate(pPairs, pContext, pFrom, pOuterEntity, pInnerEntity, pPointer)
	{
		if (!Array.isArray(pPairs))
		{
			return [];
		}
		return pPairs.map(
			(pPair, pIndex) =>
			{
				let tmpPointer = `${pPointer}/${pIndex}`;
				let tmpOuter = parseFieldRef(pPair[0]);
				let tmpInner = parseFieldRef(pPair[1]);
				if (!tmpOuter || !tmpInner || tmpInner.Alias)
				{
					throw definitionError('UnknownField', { Pointer: tmpPointer });
				}
				let tmpAlias = null;
				let tmpOuterEntity = pOuterEntity;
				if (tmpOuter.Alias)
				{
					if (!pContext.Tuple || !pContext.Tuple.has(tmpOuter.Alias))
					{
						throw definitionError('TupleAlias', { Pointer: `${tmpPointer}/0` });
					}
					tmpAlias = tmpOuter.Alias;
					tmpOuterEntity = pContext.Tuple.get(tmpAlias);
				}
				else if (pFrom)
				{
					tmpAlias = pFrom;
				}
				let tmpOuterColumn = this._checkField(tmpOuterEntity, tmpOuter.Field, `${tmpPointer}/0`);
				let tmpInnerColumn = this._checkField(pInnerEntity, tmpInner.Field, `${tmpPointer}/1`);
				if (libFacetBuckets.isNumericType(tmpOuterColumn.DataType) !== libFacetBuckets.isNumericType(tmpInnerColumn.DataType))
				{
					throw definitionError('CorrelateType', { Pointer: tmpPointer, Entity: pInnerEntity, Field: tmpInner.Field });
				}
				return { Outer: { Alias: tmpAlias, Field: tmpOuter.Field }, Inner: tmpInner.Field };
			});
	}

	/**
	 * Resolve a declared path standing on pStart (Graph.resolvePath with the enabled declared
	 * aliases), canonicalize every step Where, check TenantOnly (stage 8) and collect entities.
	 *
	 * @param {string} pStart
	 * @param {any} pRawPath
	 * @param {Record<string, any>} pContext
	 * @param {string} pPointer
	 * @param {string} pPathContext - 'Existence' | 'Lookup' (K8) | 'Multi' (K9) | 'Child' (K12) | 'Label'
	 * @return {Record<string, any>} PathPlan
	 */
	_resolvePath(pStart, pRawPath, pContext, pPointer, pPathContext)
	{
		let tmpReferenced = this.Graph ? this.Graph.pathAliasReferences(pRawPath) : [];
		for (let i = 0; i < tmpReferenced.length; i++)
		{
			let tmpDeclared = this.Aliases.get(tmpReferenced[i]);
			if ((tmpDeclared && (tmpDeclared.State !== 'Done')) || (!tmpDeclared && this.LostNames.Alias.has(tmpReferenced[i])))
			{
				throw definitionError('DependsOnDisabled', { Pointer: pPointer, DependsOn: tmpReferenced[i] });
			}
		}
		if (!this.Graph)
		{
			throw definitionError('UnknownEntity', { Pointer: pPointer, Entity: pStart });
		}
		let tmpPlan = null;
		try
		{
			tmpPlan = this.Graph.resolvePath(pStart, pRawPath, { Aliases: this._aliasMap(), MaxHops: this.Limits.MaxHops });
		}
		catch (pPathError)
		{
			throw fromPathError(pPathError, pPointer);
		}
		tmpPlan.Steps.forEach(
			(pStep) =>
			{
				let tmpStepPointer = `${pPointer}/${pStep.Index}`;
				if ((pPathContext !== 'Label') && (!this.Catalog || !this.Catalog.getFacetable(pStep.To)))
				{
					throw definitionError('UnknownEntity', { Pointer: tmpStepPointer, Step: pStep.Index, Entity: pStep.To });
				}
				if (pStep.Elide === true)
				{
					this._warn(pContext.Collector.Warnings, 'ElideIgnored', tmpStepPointer);
					pStep.Elide = false;
				}
				if (pStep.Scope === 'TenantOnly')
				{
					if (pPathContext !== 'Existence')
					{
						throw definitionError('TenantOnlyNotAllowed', { Pointer: tmpStepPointer, Step: pStep.Index, Entity: pStep.To });
					}
					if (!pStep.ScopeReason)
					{
						throw definitionError('TenantOnlyNeedsReason', { Pointer: tmpStepPointer, Step: pStep.Index, Entity: pStep.To });
					}
					if (!isPlainObject(this.Policy.PersonalScopes) || !hasOwn(this.Policy.PersonalScopes, pStep.To))
					{
						throw definitionError('TenantOnlyNeedsPolicy', { Pointer: tmpStepPointer, Step: pStep.Index, Entity: pStep.To });
					}
					if (!this._tenantOnlyKeepsTenant(pStep.To))
					{
						// Fail closed (06 §4.4): relaxing the personal scope must leave at least one other
						// required policy column (the tenant), never "every row of every tenant".
						throw definitionError('TenantOnlyNeedsTenant', { Pointer: tmpStepPointer, Step: pStep.Index, Entity: pStep.To });
					}
					pContext.Collector.Relaxed = true;
				}
				let tmpRawWhere = pStep.Where;
				pStep.Where = null;
				if (Array.isArray(tmpRawWhere) && (tmpRawWhere.length > 0))
				{
					pStep.Where = this._canonicalWhere(tmpRawWhere, this._on(pContext, pStep.To), `${tmpStepPointer}/Where`);
					if (((pPathContext === 'Lookup') || (pPathContext === 'Label')) && this._hasExistence(pStep.Where))
					{
						this._unsupported(pContext.Collector, 'LookupPathWhere');
					}
				}
				if (pPathContext !== 'Label')
				{
					this._addEntity(pContext.Collector, pStep.To);
					if (pStep.CheckParent)
					{
						this._addEntity(pContext.Collector, pStep.Parent);
					}
				}
			});
		return tmpPlan;
	}

	/**
	 * May a TenantOnly step relax pEntity's personal scope (06 §4.4: "never crosses tenants")?
	 * Only when the policy still requires at least one OTHER column of the entity for every principal
	 * (Policy.requiredFor(E, null) minus the personal column is non-empty), and the personal column
	 * is neither the policy's tenancy Column nor one of the entity's explicit Required columns
	 * (removing it would then remove a tenancy / required predicate too).
	 *
	 * @param {string} pEntity
	 * @return {boolean}
	 */
	_tenantOnlyKeepsTenant(pEntity)
	{
		let tmpPersonal = (isPlainObject(this.Policy.PersonalScopes) && hasOwn(this.Policy.PersonalScopes, pEntity)) ? this.Policy.PersonalScopes[pEntity] : null;
		let tmpColumn = (tmpPersonal && (typeof(tmpPersonal.Column) === 'string') && (tmpPersonal.Column.length > 0)) ? tmpPersonal.Column : null;
		if (!tmpColumn)
		{
			return false;
		}
		if ((typeof(this.Policy.Column) === 'string') && (this.Policy.Column === tmpColumn))
		{
			return false;
		}
		let tmpExplicit = (isPlainObject(this.Policy.Required) && Array.isArray(this.Policy.Required[pEntity])) ? this.Policy.Required[pEntity] : [];
		if (tmpExplicit.some((pEntry) => { return pEntry && (pEntry.Column === tmpColumn); }))
		{
			return false;
		}
		let tmpRequired = (typeof(this.Policy.requiredFor) === 'function') ? this.Policy.requiredFor(pEntity, null) : [];
		return (Array.isArray(tmpRequired) ? tmpRequired : []).some((pEntry) => { return pEntry && (typeof(pEntry.Column) === 'string') && (pEntry.Column !== tmpColumn); });
	}

	/**
	 * Does a canonical predicate (an existence body's Where, step Wheres included) bind a $Param?
	 *
	 * @param {any} pPred
	 * @return {boolean}
	 */
	_bindsParam(pPred)
	{
		if (Array.isArray(pPred))
		{
			return pPred.some((pItem) => { return this._bindsParam(pItem); });
		}
		if (!isPlainObject(pPred))
		{
			return false;
		}
		if ((typeof(pPred.Bind) === 'string') && (pPred.Bind.indexOf('$Param.') === 0))
		{
			return true;
		}
		return Object.keys(pPred).some((pKey) => { return (pKey !== 'Bind') && this._bindsParam(pPred[pKey]); });
	}

	/**
	 * Does a canonical predicate contain an existence node?
	 *
	 * @param {any} pPred
	 * @return {boolean}
	 */
	_hasExistence(pPred)
	{
		if (!isPlainObject(pPred))
		{
			return false;
		}
		if (Array.isArray(pPred.And) || Array.isArray(pPred.Or))
		{
			return (pPred.And || pPred.Or).some((pChild) => { return this._hasExistence(pChild); });
		}
		return EXISTENCE_KINDS.some((pKind) => { return hasOwn(pPred, pKind); });
	}

	/**
	 * Negate a canonical tree (Not push-down over an inlined scope).
	 *
	 * @param {any} pPred
	 * @param {Record<string, any>} pCollector
	 * @return {any}
	 */
	_negate(pPred, pCollector)
	{
		if (!isPlainObject(pPred))
		{
			return pPred;
		}
		if (Array.isArray(pPred.And))
		{
			return this._or(pPred.And.map((pChild) => { return this._negate(pChild, pCollector); }));
		}
		if (Array.isArray(pPred.Or))
		{
			return this._and(pPred.Or.map((pChild) => { return this._negate(pChild, pCollector); }));
		}
		if (hasOwn(pPred, 'Exists'))
		{
			pCollector.NoVisibleMatch = true;
			return { NotExists: pPred.Exists };
		}
		if (hasOwn(pPred, 'NotExists'))
		{
			return { Exists: pPred.NotExists };
		}
		if (hasOwn(pPred, 'HavingCount'))
		{
			return { HavingCount: Object.assign({}, pPred.HavingCount, { Op: NEGATED_COUNT_OPS[pPred.HavingCount.Op] }) };
		}
		if (hasOwn(pPred, 'All') || hasOwn(pPred, 'AllNonEmpty'))
		{
			return Object.assign({}, pPred, { Negated: !pPred.Negated });
		}
		return Object.assign({}, pPred, { Op: NEGATED_OPS[pPred.Op] });
	}

	/**
	 * Put an inlined scope's top level on a TuplePivot side (leaves get the side Alias, top-level
	 * existence nodes start From that side).
	 *
	 * @param {any} pPred
	 * @param {string} pSide
	 * @return {any}
	 */
	_onSide(pPred, pSide)
	{
		if (!isPlainObject(pPred))
		{
			return pPred;
		}
		if (Array.isArray(pPred.And))
		{
			return { And: pPred.And.map((pChild) => { return this._onSide(pChild, pSide); }) };
		}
		if (Array.isArray(pPred.Or))
		{
			return { Or: pPred.Or.map((pChild) => { return this._onSide(pChild, pSide); }) };
		}
		let tmpKind = EXISTENCE_KINDS.find((pKind) => { return hasOwn(pPred, pKind); });
		if (tmpKind)
		{
			let tmpBody = Object.assign({}, pPred[tmpKind],
				{
					From: pSide,
					Correlate: pPred[tmpKind].Correlate.map((pPair) => { return { Outer: { Alias: pPair.Outer.Alias || pSide, Field: pPair.Outer.Field }, Inner: pPair.Inner }; })
				});
			return Object.assign({}, pPred, { [tmpKind]: tmpBody });
		}
		if (hasOwn(pPred, 'Field'))
		{
			return Object.assign({ Alias: pSide }, pPred);
		}
		return pPred;
	}

	/**
	 * Inline a { Scope, Params } reference (stage 6): the scope's Where re-canonicalized in the
	 * enclosing context with its params substituted (literals, the reference's tokens, or Defaults).
	 *
	 * @param {Record<string, any>} pItem
	 * @param {Record<string, any>} pContext
	 * @param {string} pPointer
	 * @param {boolean} pNegated
	 * @return {Record<string, any>|null}
	 */
	_inlineScope(pItem, pContext, pPointer, pNegated)
	{
		let tmpName = pItem.Scope;
		let tmpEntry = this.Scopes.get(tmpName);
		if (!tmpEntry)
		{
			if (this.LostNames.Scope.has(tmpName))
			{
				throw definitionError('DependsOnDisabled', { Pointer: pPointer, DependsOn: tmpName });
			}
			throw definitionError('UnknownScope', { Pointer: pPointer, DependsOn: null });
		}
		this._compileScope(tmpEntry, pContext.ScopeStack);
		if (tmpEntry.State !== 'Done')
		{
			throw definitionError('DependsOnDisabled', { Pointer: pPointer, DependsOn: tmpName });
		}
		let tmpTarget = tmpEntry.Result;
		let tmpEvaluatedOn = pContext.Tuple ? pContext.Tuple.get(pContext.DefaultFrom) : pContext.Entity;
		if (tmpTarget.Entity !== tmpEvaluatedOn)
		{
			throw definitionError('ScopeEntityMismatch', { Pointer: pPointer, Entity: tmpTarget.Entity });
		}
		let tmpDepth = (pContext.InlineDepth || 0) + 1;
		if (tmpDepth > this.Limits.MaxScopeDepth)
		{
			throw definitionError('ScopeTooDeep', { Pointer: pPointer });
		}
		// The substitution of every declared param.
		let tmpReferenceParams = isPlainObject(pItem.Params) ? pItem.Params : {};
		let tmpDeclared = tmpTarget.Params;
		Object.keys(tmpReferenceParams).forEach(
			(pParam) =>
			{
				if (!hasOwn(tmpDeclared, pParam))
				{
					throw definitionError('ScopeParamInvalid', { Pointer: `${pPointer}/Params/${pointerToken(pParam)}`, Field: pParam });
				}
			});
		let tmpSubstitution = new Map();
		Object.keys(tmpDeclared).forEach(
			(pParam) =>
			{
				let tmpSchema = tmpDeclared[pParam];
				let tmpParamPointer = `${pPointer}/Params/${pointerToken(pParam)}`;
				let tmpIsList = (LIST_PARAM_TYPES.indexOf(tmpSchema.Type) >= 0);
				if (hasOwn(tmpReferenceParams, pParam))
				{
					let tmpValue = tmpReferenceParams[pParam];
					if ((typeof(tmpValue) === 'string') && (tmpValue.charAt(0) === '$'))
					{
						let tmpResolved = this._resolveToken(tmpValue, pContext, tmpParamPointer);
						if (hasOwn(tmpResolved, 'Value'))
						{
							let tmpLiteral = this._checkParamValue(tmpSchema, tmpResolved.Value);
							if (!tmpLiteral.Ok)
							{
								throw definitionError('ScopeParamInvalid', { Pointer: tmpParamPointer, Field: pParam });
							}
							tmpSubstitution.set(pParam, { Value: tmpLiteral.Value, Schema: tmpSchema });
							return;
						}
						let tmpResolvedList = (tmpResolved.Kind === 'Param') && tmpResolved.Schema && (LIST_PARAM_TYPES.indexOf(tmpResolved.Schema.Type) >= 0);
						if (tmpResolvedList !== tmpIsList)
						{
							throw definitionError('ScopeParamInvalid', { Pointer: tmpParamPointer, Field: pParam });
						}
						tmpSubstitution.set(pParam, tmpResolved);
						return;
					}
					let tmpLiteral = this._checkParamValue(tmpSchema, tmpValue);
					if (!tmpLiteral.Ok)
					{
						throw definitionError('ScopeParamInvalid', { Pointer: tmpParamPointer, Field: pParam });
					}
					tmpSubstitution.set(pParam, { Value: tmpLiteral.Value, Schema: tmpSchema });
					return;
				}
				if (hasOwn(tmpSchema, 'Default'))
				{
					tmpSubstitution.set(pParam, { Value: tmpSchema.Default, Schema: tmpSchema });
					return;
				}
				throw definitionError('ScopeParamMissing', { Pointer: pPointer, Field: pParam });
			});
		let tmpInlineContext = Object.assign({}, pContext,
			{
				Entity: tmpTarget.Entity,
				Tuple: null,
				DefaultFrom: null,
				Params: tmpDeclared,
				Substitution: tmpSubstitution,
				ScopeStack: pContext.ScopeStack.concat([ tmpName ]),
				InlineDepth: tmpDepth
			});
		if (tmpTarget.Supported === false)
		{
			this._unsupported(pContext.Collector, tmpTarget.Unsupported.Feature);
		}
		let tmpPred = null;
		try
		{
			tmpPred = this._canonicalWhere(tmpEntry.Raw.Where, tmpInlineContext, `${tmpEntry.Pointer}/Where`);
		}
		catch (pInlineError)
		{
			if (pInlineError && pInlineError.DefinitionError)
			{
				// Report it where this definition references the scope.
				pInlineError.Pointer = pPointer;
			}
			throw pInlineError;
		}
		if (pContext.Tuple)
		{
			tmpPred = this._onSide(tmpPred, pContext.DefaultFrom);
		}
		return pNegated ? this._negate(tmpPred, pContext.Collector) : tmpPred;
	}

	// ------------------------------------------------------------ CheckParent forcing (stage 9) and depth (stage 7)

	/**
	 * Does a co-reference's parent need a visibility check (a delete column, or a policy column some
	 * principal must match)?
	 *
	 * @param {string} pParent
	 * @return {boolean}
	 */
	_parentNeedsCheck(pParent)
	{
		let tmpDescriptor = this.Catalog ? this.Catalog.getFacetable(pParent) : null;
		if (tmpDescriptor && tmpDescriptor.DeleteColumn)
		{
			return true;
		}
		if (!tmpDescriptor)
		{
			let tmpTable = (this.Graph && this.Graph.builtFrom() && isPlainObject(this.Graph.builtFrom().Tables)) ? this.Graph.builtFrom().Tables[pParent] : null;
			let tmpSchema = (tmpTable && isPlainObject(tmpTable.MeadowSchema) && Array.isArray(tmpTable.MeadowSchema.Schema)) ? tmpTable.MeadowSchema.Schema : [];
			if (tmpSchema.some((pColumn) => { return pColumn && (pColumn.Type === 'Deleted'); }))
			{
				return true;
			}
		}
		if ((typeof(this.Policy.requiredFor) === 'function') && (this.Policy.requiredFor(pParent, null).length > 0))
		{
			return true;
		}
		let tmpExclude = Array.isArray(this.Policy.Exclude) ? this.Policy.Exclude : [];
		return (typeof(this.Policy.Column) === 'string') && (tmpExclude.indexOf(pParent) < 0) && !!this.Graph && !!this.Graph.modelColumn(pParent, this.Policy.Column);
	}

	/**
	 * Force CheckParent on the co-reference steps of one path (§21.4): a first-step co-reference is
	 * exempt when a sibling conjunct is an Exists whose first step is '>S.s' — the same FK into the
	 * parent — from the same side.
	 *
	 * @param {Record<string, any>} pPath - PathPlan
	 * @param {string|null} pFrom
	 * @param {Array<any>} pSiblings - the conjunct list the path's predicate sits in (may be [])
	 * @param {any} pSelf - the predicate itself (excluded from the siblings)
	 * @param {Record<string, any>} pCollector
	 * @param {string} pPointer
	 */
	_forcePath(pPath, pFrom, pSiblings, pSelf, pCollector, pPointer)
	{
		pPath.Steps.forEach(
			(pStep) =>
			{
				if ((pStep.Direction === 'CoReference') && !pStep.CheckParent && this._parentNeedsCheck(pStep.Parent))
				{
					let tmpExempt = (pStep.Index === 0) && pSiblings.some(
						(pSibling) =>
						{
							if ((pSibling === pSelf) || !isPlainObject(pSibling) || !isPlainObject(pSibling.Exists))
							{
								return false;
							}
							let tmpFirst = pSibling.Exists.Path.Steps[0];
							return (pSibling.Exists.From === pFrom) && tmpFirst && (tmpFirst.Direction === 'Forward') && (tmpFirst.Edge === pStep.Via);
						});
					if (!tmpExempt)
					{
						pStep.CheckParent = true;
						this._addEntity(pCollector, pStep.Parent);
						this._warn(pCollector.Warnings, 'CheckParentForced', `${pPointer}/${pStep.Index}`);
					}
				}
				if (pStep.Where)
				{
					this._forceCheckParent(pStep.Where, pCollector, `${pPointer}/${pStep.Index}/Where`);
				}
			});
	}

	/**
	 * Walk a canonical predicate and force CheckParent where §21.4 requires it.  Every And node is a
	 * sibling list; Or children are separate lists.
	 *
	 * @param {any} pPred
	 * @param {Record<string, any>} pCollector
	 * @param {string} pPointer
	 */
	_forceCheckParent(pPred, pCollector, pPointer)
	{
		if (!isPlainObject(pPred))
		{
			return;
		}
		let tmpItems = Array.isArray(pPred.And) ? pPred.And : [ pPred ];
		tmpItems.forEach(
			(pItem) =>
			{
				if (!isPlainObject(pItem))
				{
					return;
				}
				if (Array.isArray(pItem.Or))
				{
					pItem.Or.forEach((pChild) => { this._forceCheckParent(pChild, pCollector, pPointer); });
					return;
				}
				if (Array.isArray(pItem.And))
				{
					this._forceCheckParent(pItem, pCollector, pPointer);
					return;
				}
				let tmpKind = EXISTENCE_KINDS.find((pKind) => { return hasOwn(pItem, pKind); });
				if (!tmpKind)
				{
					return;
				}
				let tmpBody = pItem[tmpKind];
				this._forcePath(tmpBody.Path, tmpBody.From, tmpItems, pItem, pCollector, `${pPointer}/${tmpKind}/Path`);
				if (tmpBody.Where)
				{
					this._forceCheckParent(tmpBody.Where, pCollector, `${pPointer}/${tmpKind}/Where`);
				}
			});
	}

	/**
	 * The nested existence depth of a path body: one level per step, one more for a parent check
	 * inside a co-reference step, plus the nested Wheres.
	 *
	 * @param {Record<string, any>} pBody - { Path, Where }
	 * @return {number}
	 */
	_pathDepth(pBody)
	{
		let tmpDepth = 0;
		pBody.Path.Steps.forEach(
			(pStep, pIndex) =>
			{
				tmpDepth = Math.max(tmpDepth, pIndex + 1 + (pStep.CheckParent ? 1 : 0), pIndex + 1 + this._depth(pStep.Where));
			});
		return Math.max(tmpDepth, pBody.Path.Steps.length + this._depth(pBody.Where));
	}

	/**
	 * @param {any} pPred
	 * @return {number} nested existence subqueries of a canonical predicate
	 */
	_depth(pPred)
	{
		if (!isPlainObject(pPred))
		{
			return 0;
		}
		if (Array.isArray(pPred.And) || Array.isArray(pPred.Or))
		{
			return (pPred.And || pPred.Or).reduce((pMax, pChild) => { return Math.max(pMax, this._depth(pChild)); }, 0);
		}
		let tmpKind = EXISTENCE_KINDS.find((pKind) => { return hasOwn(pPred, pKind); });
		return tmpKind ? this._pathDepth(pPred[tmpKind]) : 0;
	}

	/**
	 * Stage 7: refuse a nesting deeper than Limits.MaxExistsDepth.
	 *
	 * @param {number} pDepth
	 * @param {string} pPointer
	 */
	_checkDepth(pDepth, pPointer)
	{
		if (pDepth > this.Limits.MaxExistsDepth)
		{
			throw definitionError('ExistsTooDeep', { Pointer: pPointer });
		}
	}

	// ------------------------------------------------------------ scopes

	/**
	 * Compile one named scope (memoized; reference cycles disable every member).
	 *
	 * @param {Record<string, any>} pEntry
	 * @param {Array<string>} pStack - scopes being compiled
	 * @return {Record<string, any>} the entry
	 */
	_compileScope(pEntry, pStack)
	{
		if ((pEntry.State === 'Done') || (pEntry.State === 'Disabled'))
		{
			return pEntry;
		}
		if (pStack.indexOf(pEntry.Name) >= 0)
		{
			pStack.slice(pStack.indexOf(pEntry.Name)).forEach(
				(pName) =>
				{
					let tmpMember = this.Scopes.get(pName);
					if (tmpMember)
					{
						this._disable(tmpMember, definitionError('ScopeCycle', { Pointer: tmpMember.Pointer }));
					}
				});
			return pEntry;
		}
		pEntry.State = 'Compiling';
		try
		{
			let tmpDefinition = pEntry.Raw;
			let tmpPrefix = pEntry.Name.split('.')[0];
			if (tmpPrefix !== tmpDefinition.Entity)
			{
				throw definitionError('ScopeEntityMismatch', { Pointer: `${pEntry.Pointer}/Entity`, Entity: tmpDefinition.Entity });
			}
			if (!this.Catalog || !this.Catalog.getFacetable(tmpDefinition.Entity))
			{
				throw definitionError('UnknownEntity', { Pointer: `${pEntry.Pointer}/Entity`, Entity: tmpDefinition.Entity });
			}
			let tmpParams = this._checkParams(tmpDefinition.Params, `${pEntry.Pointer}/Params`);
			let tmpCollector = this._collector(pEntry.Warnings);
			this._addEntity(tmpCollector, tmpDefinition.Entity);
			let tmpContext = (
				{
					Entity: tmpDefinition.Entity, Tuple: null, DefaultFrom: null, Params: tmpParams, Substitution: null,
					ScopeStack: pStack.concat([ pEntry.Name ]), InlineDepth: 0, Collector: tmpCollector
				});
			let tmpWhere = this._canonicalWhere(tmpDefinition.Where, tmpContext, `${pEntry.Pointer}/Where`);
			this._forceCheckParent(tmpWhere, tmpCollector, `${pEntry.Pointer}/Where`);
			this._checkDepth(this._depth(tmpWhere), `${pEntry.Pointer}/Where`);
			if (pEntry.State === 'Disabled')
			{
				// A reference cycle through this scope disabled it while it compiled.
				return pEntry;
			}
			let tmpDefinitionHash = 'dh:' + sha1Hex(canonicalJSON({ Scope: pEntry.Name, Definition: tmpDefinition })).substring(0, 12);
			pEntry.Result = deepFreeze(
				{
					Scope: pEntry.Name,
					Entity: tmpDefinition.Entity,
					Description: (typeof(tmpDefinition.Description) === 'string') ? tmpDefinition.Description : null,
					Params: tmpParams,
					Where: tmpWhere,
					Entities: tmpCollector.Entities.slice(),
					Binds: tmpCollector.Binds.slice(),
					Relaxed: tmpCollector.Relaxed,
					Supported: !tmpCollector.Unsupported,
					Unsupported: tmpCollector.Unsupported,
					DefinitionHash: tmpDefinitionHash,
					Source: pEntry.Source
				});
			pEntry.State = 'Done';
		}
		catch (pError)
		{
			this._disable(pEntry, pError);
		}
		return pEntry;
	}

	// ------------------------------------------------------------ dimensions (stage 10) and tuple pivots (stage 11)

	/**
	 * The Labels of a Terms dimension → LabelLookup (internal-contracts §20.5): Labels false → none;
	 * { Path, Field } → the path's last entity keyed by its last step's target column (the dimension
	 * key must be that column, or an FK to it); LabelField (path dimensions) → the last entity; else
	 * the catalog's FK label lookup of the keyed column.
	 *
	 * @param {Record<string, any>} pDimension - authored
	 * @param {string} pEntity - the entity holding the keyed column
	 * @param {string} pField - the keyed column
	 * @param {any} pDefaultLabels - facet-level Labels (main dimensions), undefined otherwise
	 * @param {boolean} pAllowLabelField
	 * @param {Record<string, any>} pContext
	 * @param {string} pPointer
	 * @return {Record<string, any>|null}
	 */
	_labelLookup(pDimension, pEntity, pField, pDefaultLabels, pAllowLabelField, pContext, pPointer)
	{
		let tmpHasLabels = hasOwn(pDimension, 'Labels');
		let tmpLabels = tmpHasLabels ? pDimension.Labels : pDefaultLabels;
		let tmpLabelsPointer = tmpHasLabels ? `${pPointer}/Labels` : '/Labels';
		if (tmpLabels === false)
		{
			return null;
		}
		if (isPlainObject(tmpLabels) && hasOwn(tmpLabels, 'Path'))
		{
			let tmpPath = this._resolvePath(pEntity, tmpLabels.Path, pContext, `${tmpLabelsPointer}/Path`, 'Label');
			if (!tmpPath.ToOne)
			{
				throw definitionError('LabelsPath', { Pointer: `${tmpLabelsPointer}/Path` });
			}
			let tmpLast = tmpPath.Steps[tmpPath.Steps.length - 1];
			let tmpKeyColumn = tmpLast.On[0][1];
			let tmpEdge = this.Graph.edge(`${pEntity}.${pField}`);
			let tmpKeyed = ((pEntity === tmpPath.To) && (pField === tmpKeyColumn)) || (tmpEdge && (tmpEdge.To === tmpPath.To) && (tmpEdge.ToColumn === tmpKeyColumn));
			if (!tmpKeyed)
			{
				throw definitionError('LabelsPath', { Pointer: `${tmpLabelsPointer}/Path` });
			}
			// A label target need not be facetable (an unreadable one leaves keys unlabeled at request time).
			if (!this.Graph.modelColumn(tmpPath.To, tmpLabels.Field) || this.Catalog.isSensitive(tmpPath.To, tmpLabels.Field))
			{
				throw definitionError('UnknownField', { Pointer: `${tmpLabelsPointer}/Field`, Entity: tmpPath.To, Field: tmpLabels.Field });
			}
			return { Entity: tmpPath.To, KeyColumn: tmpKeyColumn, LabelColumn: tmpLabels.Field };
		}
		if (isPlainObject(tmpLabels))
		{
			this._warn(pContext.Collector.Warnings, 'Ignored:Labels', tmpLabelsPointer);
		}
		if (typeof(pDimension.LabelField) === 'string')
		{
			if (!pAllowLabelField)
			{
				throw definitionError('DimensionShape', { Pointer: `${pPointer}/LabelField` });
			}
			this._checkField(pEntity, pDimension.LabelField, `${pPointer}/LabelField`);
			return { Entity: pEntity, KeyColumn: pField, LabelColumn: pDimension.LabelField };
		}
		let tmpDescriptor = this.Catalog.facet(`${pEntity}.${pField}`);
		if (tmpDescriptor && tmpDescriptor.LabelLookup && tmpDescriptor.LabelLookup.LabelColumn)
		{
			return { Entity: tmpDescriptor.LabelLookup.Entity, KeyColumn: tmpDescriptor.LabelLookup.KeyColumn, LabelColumn: tmpDescriptor.LabelLookup.LabelColumn };
		}
		return null;
	}

	/**
	 * Kind ↔ column type (FieldType) and the bucket options (Edges, Ranges, Mode).
	 *
	 * @param {Record<string, any>} pDimension - authored
	 * @param {Record<string, any>|null} pColumn - ColumnInfo of the keyed column
	 * @param {Record<string, any>} pCollector
	 * @param {string} pPointer
	 */
	_checkBucketKind(pDimension, pColumn, pCollector, pPointer)
	{
		let tmpKind = pDimension.Kind;
		if (pColumn && (tmpKind === 'DateHistogram') && (pColumn.DataType !== 'DateTime'))
		{
			throw definitionError('FieldType', { Pointer: `${pPointer}/Field`, Entity: pColumn.Entity, Field: pColumn.Column });
		}
		if (pColumn && ((tmpKind === 'NumericHistogram') || (tmpKind === 'Ranges'))
			&& (!libFacetBuckets.isNumericType(pColumn.DataType) || (pColumn.DataType === 'Boolean')))
		{
			// A Boolean is categorical (Terms / Missing, as the auto catalog folds it): on a production
			// PostgreSQL schema it is a BOOLEAN, which has no min / max / arithmetic for bounds or edges.
			throw definitionError('FieldType', { Pointer: `${pPointer}/Field`, Entity: pColumn.Entity, Field: pColumn.Column });
		}
		if (pDimension.Mode === 'Log')
		{
			this._unsupported(pCollector, 'LogMode');
		}
		if ((typeof(pDimension.TimeZone) === 'string') && (pDimension.TimeZone !== this.Options.Time.StorageTimeZone))
		{
			this._unsupported(pCollector, 'TimeZone');
		}
		if (hasOwn(pDimension, 'Bounds'))
		{
			this._warn(pCollector.Warnings, 'Ignored:Bounds', `${pPointer}/Bounds`);
		}
		let tmpEdges = pDimension.Edges;
		if (hasOwn(pDimension, 'Edges') && (tmpKind !== 'NumericHistogram'))
		{
			throw definitionError('DimensionShape', { Pointer: `${pPointer}/Edges` });
		}
		if ((tmpKind === 'NumericHistogram') && ((pDimension.Mode === 'Edges') || hasOwn(pDimension, 'Edges')))
		{
			let tmpAscending = Array.isArray(tmpEdges) && (tmpEdges.length >= 2) && tmpEdges.every((pEdge, pIndex) => { return (pIndex === 0) || (pEdge > tmpEdges[pIndex - 1]); });
			if (!tmpAscending || (pDimension.Mode === 'Nice'))
			{
				throw definitionError('DimensionShape', { Pointer: `${pPointer}/Edges` });
			}
		}
		if (hasOwn(pDimension, 'Ranges') && (tmpKind !== 'Ranges'))
		{
			throw definitionError('DimensionShape', { Pointer: `${pPointer}/Ranges` });
		}
		if (tmpKind === 'Ranges')
		{
			let tmpRanges = Array.isArray(pDimension.Ranges) ? pDimension.Ranges : [];
			let tmpKeys = new Set();
			let tmpValid = (tmpRanges.length > 0) && tmpRanges.every(
				(pRange) =>
				{
					let tmpUnique = !tmpKeys.has(pRange.Key);
					tmpKeys.add(pRange.Key);
					let tmpOrdered = !((typeof(pRange.From) === 'number') && (typeof(pRange.To) === 'number') && (pRange.From >= pRange.To));
					return tmpUnique && tmpOrdered && (libFacetUtil.keyProblem(pRange.Key) === null) && (pRange.Key.charAt(0) !== '#');
				});
			if (!tmpValid)
			{
				throw definitionError('DimensionShape', { Pointer: `${pPointer}/Ranges` });
			}
		}
		if ((tmpKind !== 'Terms') && (hasOwn(pDimension, 'LabelField') || (isPlainObject(pDimension.Labels) && hasOwn(pDimension.Labels, 'Path'))))
		{
			throw definitionError('DimensionShape', { Pointer: `${pPointer}/Labels` });
		}
	}

	/**
	 * The request-overridable options of a dimension (null when not declared).
	 *
	 * @param {Record<string, any>} pDimension
	 * @return {Record<string, any>}
	 */
	_dimensionOptions(pDimension)
	{
		let tmpMode = hasOwn(pDimension, 'Mode') ? pDimension.Mode : ((pDimension.Kind === 'NumericHistogram') && hasOwn(pDimension, 'Edges') ? 'Edges' : null);
		let fOption = (pKey) => { return hasOwn(pDimension, pKey) ? clone(pDimension[pKey]) : null; };
		return (
			{
				Edges: fOption('Edges'),
				Top: fOption('Top'),
				Order: fOption('Order'),
				Missing: fOption('Missing'),
				Interval: fOption('Interval'),
				EmptyBuckets: fOption('EmptyBuckets'),
				Mode: tmpMode,
				Buckets: fOption('Buckets'),
				OpenEnded: fOption('OpenEnded'),
				Ranges: fOption('Ranges')
			});
	}

	/**
	 * One dimension → { Dim: CanonicalDim, Info } (internal-contracts §20.5, §20.7).
	 *
	 * @param {Record<string, any>} pDimension - authored
	 * @param {Record<string, any>} pFacet - { Home, Tuple: Map|null, HomeSide, Params, Siblings (W_def conjunct list), DefaultLabels, Warnings, ScopeStack }
	 * @param {string} pPointer
	 * @param {any} pDefaultLabels - the facet-level Labels for a main dimension
	 * @return {{ Dim: Record<string, any>, Info: Record<string, any> }}
	 */
	_canonicalDimension(pDimension, pFacet, pPointer, pDefaultLabels)
	{
		let tmpCollector = this._collector(pFacet.Warnings);
		let tmpContext = (
			{
				Entity: pFacet.Home, Tuple: null, DefaultFrom: null, Params: pFacet.Params, Substitution: null,
				ScopeStack: [], InlineDepth: 0, Collector: tmpCollector
			});
		let tmpKind = pDimension.Kind;
		let tmpDim = Object.assign(
			{
				Kind: tmpKind, Field: null, Alias: null, Path: null, PathShape: null, KeyField: null, LabelLookup: null,
				Where: null, Correlate: null, Child: null, Labels: null
			}, this._dimensionOptions(pDimension), { DataType: null, IsInteger: false, Scale: 0 });
		let tmpInfo = { OwnedFields: [], ClauseType: null, MultiValued: false, FilterKeyDefault: null, Path: null, Collector: tmpCollector, PathFacet: false };
		let fColumnType = (pColumn) =>
		{
			tmpDim.DataType = pColumn.DataType;
			tmpDim.IsInteger = !!pColumn.IsInteger;
			tmpDim.Scale = (typeof(pColumn.Scale) === 'number') ? pColumn.Scale : 0;
		};

		if (hasOwn(pDimension, 'Expr'))
		{
			this._unsupported(tmpCollector, 'Computed');
			return { Dim: tmpDim, Info: tmpInfo };
		}

		if (pFacet.Tuple)
		{
			// TuplePivot dimension: '<alias>.<Column>' keyed by the tuple (single-valued).
			if (hasOwn(pDimension, 'Path') || (tmpKind === 'ChildRollup') || (tmpKind === 'ExistsSplit'))
			{
				throw definitionError('TuplePath', { Pointer: pPointer });
			}
			let tmpReference = parseFieldRef(pDimension.Field);
			if (!tmpReference || !tmpReference.Alias || !pFacet.Tuple.has(tmpReference.Alias))
			{
				throw definitionError('TupleAlias', { Pointer: `${pPointer}/Field` });
			}
			let tmpEntity = pFacet.Tuple.get(tmpReference.Alias);
			let tmpColumn = this._checkField(tmpEntity, tmpReference.Field, `${pPointer}/Field`);
			let tmpPK = this.Graph.primaryKey(tmpEntity);
			let tmpKeyed = pFacet.TupleKey.some((pKey) => { return (pKey.Name === tmpReference.Alias) && ((pKey.Field === tmpReference.Field) || (pKey.Field === tmpPK)); });
			if (!tmpKeyed)
			{
				throw definitionError('TupleDimensionNotKeyed', { Pointer: `${pPointer}/Field`, Entity: tmpEntity, Field: tmpReference.Field });
			}
			this._checkBucketKind(pDimension, tmpColumn, tmpCollector, pPointer);
			tmpDim.Field = tmpReference.Field;
			tmpDim.Alias = tmpReference.Alias;
			fColumnType(tmpColumn);
			if (tmpKind === 'Terms')
			{
				tmpDim.LabelLookup = this._labelLookup(pDimension, tmpEntity, tmpReference.Field, pDefaultLabels, false, tmpContext, pPointer);
			}
			return { Dim: tmpDim, Info: tmpInfo };
		}

		if (tmpKind === 'ChildRollup')
		{
			let tmpChild = isPlainObject(pDimension.Child) ? pDimension.Child : null;
			if (!tmpChild || hasOwn(pDimension, 'Path') || hasOwn(pDimension, 'Field') || !Array.isArray(pDimension.Edges))
			{
				throw definitionError('DimensionShape', { Pointer: pPointer });
			}
			if (!libFacetBuckets.isBandEdges(pDimension.Edges))
			{
				// Strictly ascending positive integers starting at 1 (band 0 = no visible child).
				throw definitionError('BandEdges', { Pointer: `${pPointer}/Edges` });
			}
			let tmpPath = this._resolvePath(pFacet.Home, tmpChild.Path, tmpContext, `${pPointer}/Child/Path`, 'Child');
			if ((tmpPath.Steps.length !== 1) || (tmpPath.Steps[0].Direction !== 'Reverse'))
			{
				this._unsupported(tmpCollector, 'ChildRollupPath');
			}
			if (tmpChild.Agg !== 'count')
			{
				this._unsupported(tmpCollector, 'ChildRollupAgg');
			}
			let tmpWhere = this._canonicalWhere(tmpChild.Where, this._on(tmpContext, tmpPath.To), `${pPointer}/Child/Where`);
			this._forcePath(tmpPath, null, pFacet.Siblings, null, tmpCollector, `${pPointer}/Child/Path`);
			this._forceCheckParent(tmpWhere, tmpCollector, `${pPointer}/Child/Where`);
			tmpDim.Child = { Path: tmpPath, Agg: tmpChild.Agg, Field: (typeof(tmpChild.Field) === 'string') ? tmpChild.Field : null, Where: tmpWhere };
			tmpDim.Labels = (isPlainObject(pDimension.Labels) && !hasOwn(pDimension.Labels, 'Path')) ? clone(pDimension.Labels) : null;
			tmpDim.DataType = 'Numeric';
			tmpDim.IsInteger = true;
			tmpDim.Scale = 0;
			tmpCollector.NoVisibleMatch = true;
			tmpInfo.Depth = 1 + this._depth(tmpWhere);
			return { Dim: tmpDim, Info: tmpInfo };
		}

		if (tmpKind === 'ExistsSplit')
		{
			if (!hasOwn(pDimension, 'Path') || hasOwn(pDimension, 'Field') || hasOwn(pDimension, 'KeyField'))
			{
				throw definitionError('DimensionShape', { Pointer: pPointer });
			}
			let tmpBody = this._existenceBody({ Path: pDimension.Path, Where: pDimension.Where, Correlate: pDimension.Correlate }, tmpContext, pPointer, 'Existence');
			this._forcePath(tmpBody.Path, null, pFacet.Siblings, null, tmpCollector, `${pPointer}/Path`);
			this._forceCheckParent(tmpBody.Where, tmpCollector, `${pPointer}/Where`);
			let tmpLabels = isPlainObject(pDimension.Labels) ? pDimension.Labels : {};
			tmpDim.Path = tmpBody.Path;
			tmpDim.PathShape = tmpBody.Path.ToOne ? 'ToOne' : 'ToMany';
			tmpDim.Where = tmpBody.Where;
			tmpDim.Correlate = tmpBody.Correlate;
			tmpDim.Labels =
				{
					true: (typeof(tmpLabels.true) === 'string') ? tmpLabels.true : libFacetBuckets.EXISTS_SPLIT_DEFAULT_LABELS.true,
					false: (typeof(tmpLabels.false) === 'string') ? tmpLabels.false : libFacetBuckets.EXISTS_SPLIT_DEFAULT_LABELS.false
				};
			tmpDim.DataType = 'Boolean';
			tmpDim.IsInteger = true;
			tmpDim.Scale = 0;
			tmpCollector.NoVisibleMatch = true;
			tmpInfo.Depth = this._pathDepth(tmpBody);
			return { Dim: tmpDim, Info: tmpInfo };
		}

		if (hasOwn(pDimension, 'Child') || hasOwn(pDimension, 'Correlate'))
		{
			throw definitionError('DimensionShape', { Pointer: pPointer });
		}

		if (hasOwn(pDimension, 'Path'))
		{
			// K8 (to-one) or K9 (any '<' / '=' step).
			let tmpProbe = this._resolvePathProbe(pFacet.Home, pDimension.Path);
			let tmpPathContext = (tmpProbe && tmpProbe.ToOne) ? 'Lookup' : 'Multi';
			let tmpPath = this._resolvePath(pFacet.Home, pDimension.Path, tmpContext, `${pPointer}/Path`, tmpPathContext);
			this._forcePath(tmpPath, null, pFacet.Siblings, null, tmpCollector, `${pPointer}/Path`);
			tmpDim.Path = tmpPath;
			tmpDim.PathShape = tmpPath.ToOne ? 'ToOne' : 'ToMany';
			tmpInfo.Path = tmpPath.Steps.map((pStep) => { return pStep.Raw; });
			tmpInfo.PathFacet = true;
			tmpInfo.FilterKeyDefault = 'FacetID';
			let tmpLast = tmpPath.To;
			if (tmpPath.ToOne)
			{
				if (!hasOwn(pDimension, 'Field') || hasOwn(pDimension, 'KeyField') || hasOwn(pDimension, 'Where'))
				{
					throw definitionError('DimensionShape', { Pointer: pPointer });
				}
				let tmpColumn = this._checkField(tmpLast, pDimension.Field, `${pPointer}/Field`);
				this._checkBucketKind(pDimension, tmpColumn, tmpCollector, pPointer);
				tmpDim.Field = pDimension.Field;
				fColumnType(tmpColumn);
				if (tmpKind === 'Terms')
				{
					tmpDim.LabelLookup = this._labelLookup(pDimension, tmpLast, pDimension.Field, pDefaultLabels, true, tmpContext, pPointer);
				}
				tmpInfo.OwnedFields = [ `@path:${tmpPath.Signature}#${pDimension.Field}` ];
				if (tmpPath.Steps.length === 1)
				{
					let tmpToColumn = tmpPath.Steps[0].On[0][1];
					tmpInfo.ClauseType = (tmpKind === 'Terms') ? ((pDimension.Field === tmpToColumn) ? 'InternalJoinSelectedValueList' : 'InternalJoinMatch')
						: (tmpKind === 'DateHistogram') ? 'InternalJoinDateRange'
						: 'InternalJoinNumericRange';
				}
				tmpInfo.Depth = this._pathDepth({ Path: tmpPath, Where: null });
				return { Dim: tmpDim, Info: tmpInfo };
			}
			// K9
			if ((tmpKind !== 'Terms') || !hasOwn(pDimension, 'KeyField') || hasOwn(pDimension, 'Field'))
			{
				throw definitionError('DimensionShape', { Pointer: pPointer });
			}
			let tmpKeyColumn = this._checkField(tmpLast, pDimension.KeyField, `${pPointer}/KeyField`);
			this._checkBucketKind(pDimension, tmpKeyColumn, tmpCollector, pPointer);
			let tmpWhere = this._canonicalWhere(pDimension.Where, this._on(tmpContext, tmpLast), `${pPointer}/Where`);
			this._forceCheckParent(tmpWhere, tmpCollector, `${pPointer}/Where`);
			tmpDim.KeyField = pDimension.KeyField;
			tmpDim.Where = tmpWhere;
			fColumnType(tmpKeyColumn);
			tmpDim.LabelLookup = this._labelLookup(pDimension, tmpLast, pDimension.KeyField, pDefaultLabels, true, tmpContext, pPointer);
			tmpInfo.MultiValued = true;
			tmpInfo.OwnedFields = [ `@path:${tmpPath.Signature}#${pDimension.KeyField}` ];
			let tmpSteps = tmpPath.Steps;
			let tmpBridgeForm = (tmpSteps.length === 2) && (tmpSteps[0].Direction === 'Reverse') && (tmpSteps[1].Direction === 'Forward')
				&& (tmpSteps[0].Edge.split('.')[0] === tmpSteps[1].Edge.split('.')[0]) && (pDimension.KeyField === tmpSteps[1].On[0][1]);
			tmpInfo.ClauseType = tmpBridgeForm ? 'ExternalJoinSelectedValueList' : null;
			tmpInfo.Depth = this._pathDepth({ Path: tmpPath, Where: tmpWhere });
			return { Dim: tmpDim, Info: tmpInfo };
		}

		// A pivot column.
		if (!hasOwn(pDimension, 'Field') || hasOwn(pDimension, 'KeyField') || hasOwn(pDimension, 'Where') || hasOwn(pDimension, 'LabelField'))
		{
			throw definitionError('DimensionShape', { Pointer: pPointer });
		}
		let tmpReference = parseFieldRef(pDimension.Field);
		if (!tmpReference || tmpReference.Alias)
		{
			throw definitionError('UnknownField', { Pointer: `${pPointer}/Field` });
		}
		let tmpColumn = this._checkField(pFacet.Home, tmpReference.Field, `${pPointer}/Field`);
		let tmpModelColumn = this.Graph.modelColumn(pFacet.Home, tmpReference.Field) || {};
		let tmpSize = parseInt(String(tmpModelColumn.Size || ''), 10);
		let tmpIsGUID = (tmpColumn.DataType === 'GUID') || (tmpColumn.MeadowType === 'AutoGUID') || (tmpColumn.Column.indexOf('GUID') === 0);
		let tmpLongString = (tmpColumn.DataType === 'String') && Number.isFinite(tmpSize) && (tmpSize > this.Options.Catalog.MaxTermsStringSize);
		if (tmpColumn.IsPK || tmpIsGUID || ([ 'Text', 'JSON', 'JSONProxy' ].indexOf(tmpColumn.DataType) >= 0) || tmpLongString)
		{
			throw definitionError('FieldNotFoldable', { Pointer: `${pPointer}/Field`, Entity: pFacet.Home, Field: tmpReference.Field });
		}
		this._checkBucketKind(pDimension, tmpColumn, tmpCollector, pPointer);
		tmpDim.Field = tmpReference.Field;
		fColumnType(tmpColumn);
		if (tmpKind === 'Terms')
		{
			tmpDim.LabelLookup = this._labelLookup(pDimension, pFacet.Home, tmpReference.Field, pDefaultLabels, false, tmpContext, pPointer);
		}
		tmpInfo.OwnedFields = [ tmpReference.Field ];
		tmpInfo.FilterKeyDefault = 'Field';
		tmpInfo.ClauseType = libFacetRequest.clauseTypeFor(tmpKind);
		tmpInfo.Depth = 0;
		return { Dim: tmpDim, Info: tmpInfo };
	}

	/**
	 * Resolve a dimension path only to learn its shape (errors are reported by the real resolution).
	 *
	 * @param {string} pStart
	 * @param {any} pRawPath
	 * @return {Record<string, any>|null}
	 */
	_resolvePathProbe(pStart, pRawPath)
	{
		try
		{
			return this.Graph.resolvePath(pStart, pRawPath, { Aliases: this._aliasMap(), MaxHops: this.Limits.MaxHops });
		}
		catch (pProbeError)
		{
			return null;
		}
	}

	/**
	 * The TuplePivot of a facet (internal-contracts §20.6).
	 *
	 * @param {Record<string, any>} pDefinition
	 * @param {string} pHome
	 * @param {Record<string, any>} pCollector
	 * @param {Record<string, any>} pParams
	 * @param {string} pPointer - the facet's pointer
	 * @return {{ Pivot: Record<string, any>, Map: Map<string, string>, HomeSide: string, Key: Array<Record<string, any>> }}
	 */
	_canonicalTuple(pDefinition, pHome, pCollector, pParams, pPointer)
	{
		let tmpTuple = pDefinition.Pivot.Tuple;
		let tmpPointer = `${pPointer}/Pivot/Tuple`;
		let tmpMap = new Map();
		tmpTuple.From.forEach(
			(pSide, pIndex) =>
			{
				if (tmpMap.has(pSide.As))
				{
					throw definitionError('TupleAlias', { Pointer: `${tmpPointer}/From/${pIndex}/As` });
				}
				if (!this.Catalog.getFacetable(pSide.Entity))
				{
					throw definitionError('UnknownEntity', { Pointer: `${tmpPointer}/From/${pIndex}/Entity`, Entity: pSide.Entity });
				}
				tmpMap.set(pSide.As, pSide.Entity);
				this._addEntity(pCollector, pSide.Entity);
			});
		let tmpHomeSide = tmpTuple.From.find((pSide) => { return pSide.Entity === pHome; });
		if (!tmpHomeSide)
		{
			throw definitionError('TupleHome', { Pointer: `${tmpPointer}/From`, Entity: pHome });
		}
		let tmpSides = tmpTuple.From.map(
			(pSide, pIndex) =>
			{
				let tmpContext = (
					{
						Entity: pSide.Entity, Tuple: null, DefaultFrom: null, Params: pParams, Substitution: null,
						ScopeStack: [], InlineDepth: 0, Collector: pCollector
					});
				let tmpWhere = this._canonicalWhere(pSide.Where, tmpContext, `${tmpPointer}/From/${pIndex}/Where`);
				this._forceCheckParent(tmpWhere, pCollector, `${tmpPointer}/From/${pIndex}/Where`);
				this._checkDepth(this._depth(tmpWhere), `${tmpPointer}/From/${pIndex}/Where`);
				return { Name: pSide.As, Entity: pSide.Entity, Where: tmpWhere };
			});
		let fSideColumn = (pText, pFieldPointer) =>
		{
			let tmpReference = parseFieldRef(pText);
			if (!tmpReference || !tmpReference.Alias || !tmpMap.has(tmpReference.Alias))
			{
				throw definitionError('TupleAlias', { Pointer: pFieldPointer });
			}
			this._checkField(tmpMap.get(tmpReference.Alias), tmpReference.Field, pFieldPointer);
			return { Name: tmpReference.Alias, Field: tmpReference.Field, Entity: tmpMap.get(tmpReference.Alias) };
		};
		// Join-related On pairs (one column Joins the other side's primary key, or both Join the same
		// target key) link two sides; every side must be reachable from the Home side through such
		// links (BFS), so no side is a near-cartesian product and every engine can join the sides in
		// connectivity order (internal-contracts §20.6).
		let tmpLinks = [];
		let tmpOn = tmpTuple.On.map(
			(pPair, pIndex) =>
			{
				let tmpLeft = fSideColumn(pPair[0], `${tmpPointer}/On/${pIndex}/0`);
				let tmpRight = fSideColumn(pPair[1], `${tmpPointer}/On/${pIndex}/1`);
				let tmpLeftEdge = this.Graph.edge(`${tmpLeft.Entity}.${tmpLeft.Field}`);
				let tmpRightEdge = this.Graph.edge(`${tmpRight.Entity}.${tmpRight.Field}`);
				let fJoinsKey = (pEdge, pOther) => { return !!pEdge && (pEdge.To === pOther.Entity) && (pEdge.ToColumn === pOther.Field) && (this.Graph.primaryKey(pOther.Entity) === pOther.Field); };
				if ((tmpLeft.Name !== tmpRight.Name) && (fJoinsKey(tmpLeftEdge, tmpRight) || fJoinsKey(tmpRightEdge, tmpLeft)
					|| (tmpLeftEdge && tmpRightEdge && (tmpLeftEdge.To === tmpRightEdge.To) && (tmpLeftEdge.ToColumn === tmpRightEdge.ToColumn))))
				{
					tmpLinks.push([ tmpLeft.Name, tmpRight.Name ]);
				}
				return { Left: { Name: tmpLeft.Name, Field: tmpLeft.Field }, Right: { Name: tmpRight.Name, Field: tmpRight.Field } };
			});
		let tmpReached = new Set([ tmpHomeSide.As ]);
		let tmpGrew = true;
		while (tmpGrew)
		{
			tmpGrew = false;
			for (let i = 0; i < tmpLinks.length; i++)
			{
				let tmpLeftIn = tmpReached.has(tmpLinks[i][0]);
				let tmpRightIn = tmpReached.has(tmpLinks[i][1]);
				if (tmpLeftIn !== tmpRightIn)
				{
					tmpReached.add(tmpLeftIn ? tmpLinks[i][1] : tmpLinks[i][0]);
					tmpGrew = true;
				}
			}
		}
		let tmpUnjoined = tmpTuple.From.findIndex((pSide) => { return !tmpReached.has(pSide.As); });
		if (tmpUnjoined >= 0)
		{
			throw definitionError('TupleOnNotJoined', { Pointer: `${tmpPointer}/From/${tmpUnjoined}` });
		}
		let tmpKey = tmpTuple.Key.map(
			(pText, pIndex) =>
			{
				let tmpColumn = fSideColumn(pText, `${tmpPointer}/Key/${pIndex}`);
				return { Name: tmpColumn.Name, Field: tmpColumn.Field };
			});
		return (
			{
				Pivot: { Kind: 'Tuple', Sides: tmpSides, On: tmpOn, Key: tmpKey, Home: tmpHomeSide.As },
				Map: tmpMap,
				HomeSide: tmpHomeSide.As,
				Key: tmpKey
			});
	}

	// ------------------------------------------------------------ facets

	/**
	 * Compile one declared facet and its siblings (all or nothing).
	 *
	 * @param {Record<string, any>} pEntry
	 * @return {Record<string, any>} the entry
	 */
	_compileFacet(pEntry)
	{
		if (pEntry.State !== 'Pending')
		{
			return pEntry;
		}
		pEntry.State = 'Compiling';
		try
		{
			let tmpDefinition = pEntry.Raw;
			let tmpPointer = pEntry.Pointer;
			let tmpParts = tmpDefinition.Facet.split('.');
			let tmpHome = tmpParts[0];
			let tmpName = tmpParts[1];
			if (!this.Catalog || !this.Catalog.getFacetable(tmpHome))
			{
				throw definitionError('UnknownEntity', { Pointer: `${tmpPointer}/Facet`, Entity: tmpHome });
			}
			if (this.Graph.modelColumn(tmpHome, tmpName))
			{
				throw definitionError('NameShadowsColumn', { Pointer: `${tmpPointer}/Facet`, Entity: tmpHome, Field: tmpName });
			}
			if (hasOwn(tmpDefinition, 'Home') && (tmpDefinition.Home !== tmpHome))
			{
				throw definitionError('HomeMismatch', { Pointer: `${tmpPointer}/Home`, Entity: tmpDefinition.Home });
			}
			let tmpWarnings = pEntry.Warnings;
			IGNORED_FACET_KEYS.forEach((pKey) => { if (hasOwn(tmpDefinition, pKey)) { this._warn(tmpWarnings, `Ignored:${pKey}`, `${tmpPointer}/${pKey}`); } });

			let tmpShared = this._collector(tmpWarnings);
			this._addEntity(tmpShared, tmpHome);
			// Stage 12 (facet level).
			if (Array.isArray(tmpDefinition.Measures) && ((tmpDefinition.Measures.length !== 1) || (canonicalJSON(tmpDefinition.Measures[0]) !== canonicalJSON({ Op: 'count' }))))
			{
				this._unsupported(tmpShared, 'Measures');
			}
			if ((tmpDefinition.CountMode === 'Approx') || hasOwn(tmpDefinition, 'DistinctKey'))
			{
				this._unsupported(tmpShared, 'CountMode');
			}
			if (hasOwn(tmpDefinition, 'ExcludeGroup') || ((typeof(tmpDefinition.Exclude) === 'string') && (tmpDefinition.Exclude.indexOf('Group:') === 0)))
			{
				this._unsupported(tmpShared, 'ExcludeGroup');
			}
			let tmpParams = this._checkParams(tmpDefinition.Params, `${tmpPointer}/Params`);

			// The pivot.
			let tmpPivot = null;
			let tmpTuple = null;
			if (isPlainObject(tmpDefinition.Pivot) && hasOwn(tmpDefinition.Pivot, 'Union'))
			{
				this._unsupported(tmpShared, 'UnionOfSources');
				pEntry.Result = deepFreeze([ this._unsupportedFacet(pEntry, tmpHome, tmpShared, tmpParams) ]);
				pEntry.State = 'Done';
				return pEntry;
			}
			if (isPlainObject(tmpDefinition.Pivot) && hasOwn(tmpDefinition.Pivot, 'Tuple'))
			{
				tmpTuple = this._canonicalTuple(tmpDefinition, tmpHome, tmpShared, tmpParams, tmpPointer);
				tmpPivot = tmpTuple.Pivot;
				if (tmpDefinition.Dimensions.length > 1)
				{
					this._unsupported(tmpShared, 'TuplePivotPivot');
				}
			}
			else
			{
				let tmpPivotEntity = (typeof(tmpDefinition.Pivot) === 'string') ? tmpDefinition.Pivot : tmpHome;
				if (tmpPivotEntity !== tmpHome)
				{
					throw definitionError('PivotMismatch', { Pointer: `${tmpPointer}/Pivot`, Entity: tmpPivotEntity });
				}
				tmpPivot = { Kind: 'Entity', Entity: tmpHome };
			}
			if (tmpTuple && (tmpDefinition.CountMode === 'PivotDistinct'))
			{
				this._unsupported(tmpShared, 'CountMode');
			}
			if (tmpTuple && (tmpDefinition.CountMode === 'Rows'))
			{
				// A TuplePivot counts DISTINCT Key tuples (KeyDistinct); a declared bag count ('Rows', 08 §4.3)
				// is canonicalized, never silently: duplicate obligation rows collapse into one tuple.
				this._warn(tmpShared.Warnings, 'CountModeCanonicalized', `${tmpPointer}/CountMode`);
			}
			if (!tmpTuple && (tmpDefinition.CountMode === 'KeyDistinct'))
			{
				this._unsupported(tmpShared, 'CountMode');
			}

			// The definition Where (W_def), never excluded.
			let tmpWhereContext = (
				{
					Entity: tmpTuple ? null : tmpHome, Tuple: tmpTuple ? tmpTuple.Map : null, DefaultFrom: tmpTuple ? tmpTuple.HomeSide : null,
					Params: tmpParams, Substitution: null, ScopeStack: [], InlineDepth: 0, Collector: tmpShared
				});
			let tmpWhere = this._canonicalWhere(tmpDefinition.Where, tmpWhereContext, `${tmpPointer}/Where`);
			this._forceCheckParent(tmpWhere, tmpShared, `${tmpPointer}/Where`);
			this._checkDepth(this._depth(tmpWhere), `${tmpPointer}/Where`);
			let tmpSiblingList = !tmpWhere ? [] : (Array.isArray(tmpWhere.And) ? tmpWhere.And : [ tmpWhere ]);

			let tmpFacetContext = (
				{
					Home: tmpHome, Tuple: tmpTuple ? tmpTuple.Map : null, TupleKey: tmpTuple ? tmpTuple.Key : [], HomeSide: tmpTuple ? tmpTuple.HomeSide : null,
					Params: tmpParams, Siblings: tmpSiblingList, Warnings: tmpWarnings
				});
			let tmpFacetLabels = hasOwn(tmpDefinition, 'Labels') ? tmpDefinition.Labels : undefined;
			let tmpMain = tmpDefinition.Dimensions.map((pDimension, pIndex) => { return this._canonicalDimension(pDimension, tmpFacetContext, `${tmpPointer}/Dimensions/${pIndex}`, tmpFacetLabels); });
			tmpMain.forEach((pDimension) => { this._checkDepth(pDimension.Info.Depth || 0, tmpPointer); });
			if (tmpMain.length === 2)
			{
				tmpMain.forEach(
					(pDimension, pIndex) =>
					{
						if (pDimension.Info.MultiValued || (pDimension.Dim.Kind === 'ChildRollup') || (pDimension.Dim.Kind === 'ExistsSplit'))
						{
							throw definitionError('PivotAxis', { Pointer: `${tmpPointer}/Dimensions/${pIndex}` });
						}
					});
			}
			if ((tmpMain.length === 1) && tmpMain[0].Info.MultiValued && (tmpDefinition.CountMode === 'Rows'))
			{
				throw definitionError('CountModeRows', { Pointer: `${tmpPointer}/CountMode` });
			}
			let tmpSiblingNames = isPlainObject(tmpDefinition.Siblings) ? Object.keys(tmpDefinition.Siblings) : [];
			let tmpSiblings = tmpSiblingNames.map(
				(pSiblingName) =>
				{
					let tmpDimension = this._canonicalDimension(tmpDefinition.Siblings[pSiblingName], tmpFacetContext, `${tmpPointer}/Siblings/${pointerToken(pSiblingName)}`, undefined);
					this._checkDepth(tmpDimension.Info.Depth || 0, `${tmpPointer}/Siblings/${pointerToken(pSiblingName)}`);
					return { Name: pSiblingName, Dimension: tmpDimension };
				});

			let tmpDefinitionHash = 'dh:' + sha1Hex(canonicalJSON(tmpDefinition)).substring(0, 12);
			let tmpGraphHash = this.Graph.graphHash();
			let tmpFacetID = tmpDefinition.Facet;
			let tmpResults = [];
			tmpResults.push(this._facetResult(
				{
					Entry: pEntry, Definition: tmpDefinition, FacetID: tmpFacetID, Origin: 'Declared', SiblingOf: null, Home: tmpHome, Name: tmpName,
					Pivot: tmpPivot, Tuple: tmpTuple, Where: tmpWhere, Dimensions: tmpMain, Shared: tmpShared, Params: tmpParams,
					DefinitionHash: tmpDefinitionHash, FoldHash: 'fh:' + sha1Hex(`${tmpDefinitionHash}|${tmpGraphHash}`).substring(0, 12),
					Siblings: tmpSiblingNames.map((pSiblingName) => { return `${tmpFacetID}/${pSiblingName}`; })
				}));
			tmpSiblings.forEach(
				(pSibling) =>
				{
					tmpResults.push(this._facetResult(
						{
							Entry: pEntry, Definition: tmpDefinition, FacetID: `${tmpFacetID}/${pSibling.Name}`, Origin: 'Sibling', SiblingOf: tmpFacetID, Home: tmpHome, Name: pSibling.Name,
							Pivot: tmpPivot, Tuple: tmpTuple, Where: tmpWhere, Dimensions: [ pSibling.Dimension ], Shared: tmpShared, Params: tmpParams,
							DefinitionHash: tmpDefinitionHash, FoldHash: 'fh:' + sha1Hex(`${tmpDefinitionHash}/${pSibling.Name}|${tmpGraphHash}`).substring(0, 12),
							Siblings: []
						}));
				});
			pEntry.Result = deepFreeze(tmpResults);
			pEntry.State = 'Done';
		}
		catch (pError)
		{
			this._disable(pEntry, pError);
		}
		return pEntry;
	}

	/**
	 * The canonical form of a facet that loads unsupported before its dimensions are resolved
	 * (K16 UnionOfSources).
	 *
	 * @param {Record<string, any>} pEntry
	 * @param {string} pHome
	 * @param {Record<string, any>} pCollector
	 * @param {Record<string, any>} pParams
	 * @return {Record<string, any>}
	 */
	_unsupportedFacet(pEntry, pHome, pCollector, pParams)
	{
		let tmpDefinition = pEntry.Raw;
		let tmpDefinitionHash = 'dh:' + sha1Hex(canonicalJSON(tmpDefinition)).substring(0, 12);
		return (
			{
				Facet: tmpDefinition.Facet, Origin: 'Declared', SiblingOf: null, Entity: pHome, Version: tmpDefinition.Version,
				Title: tmpDefinition.Title || null, Description: tmpDefinition.Description || null,
				DisplayName: tmpDefinition.DisplayName || tmpDefinition.Title || libRetoldFacetingCatalog.deCamel(tmpDefinition.Facet.split('.')[1]),
				Pivot: { Kind: 'Union', Entity: pHome }, Where: null, Dimensions: [], Fold: null, Folds: [], CountMode: 'Rows',
				Exclude: 'None', FilterKey: null, Params: pParams, Entities: pCollector.Entities.slice(), Binds: [], Relaxed: false, Semantics: null,
				Supported: false, Unsupported: pCollector.Unsupported, DefinitionHash: tmpDefinitionHash,
				FoldHash: 'fh:' + sha1Hex(`${tmpDefinitionHash}|${this.Graph.graphHash()}`).substring(0, 12), Source: pEntry.Source,
				Path: null, MultiValued: false, Selectable: false, ClauseType: null, OwnedFields: [], WhereScopes: null, Siblings: []
			});
	}

	/**
	 * Assemble one CanonicalFacet (internal-contracts §20.7 plus Path, MultiValued, Selectable,
	 * ClauseType, OwnedFields, WhereScopes, Siblings).
	 *
	 * @param {Record<string, any>} pParts
	 * @return {Record<string, any>}
	 */
	_facetResult(pParts)
	{
		let tmpDefinition = pParts.Definition;
		let tmpDimensions = pParts.Dimensions;
		let tmpCollector = this._mergeCollectors([ pParts.Shared ].concat(tmpDimensions.map((pDimension) => { return pDimension.Info.Collector; })), pParts.Entry.Warnings);
		let tmpIsPivot = (tmpDimensions.length === 2);
		let tmpFirst = tmpDimensions[0];
		let tmpFold = tmpIsPivot ? 'Pivot' : tmpFirst.Dim.Kind;
		let tmpMultiValued = !tmpIsPivot && tmpFirst.Info.MultiValued;
		let tmpCountMode = pParts.Tuple ? 'KeyDistinct' : (tmpMultiValued ? 'PivotDistinct' : 'Rows');
		let tmpOwnsNothing = !!pParts.Tuple || (tmpFold === 'ChildRollup') || (tmpFold === 'ExistsSplit');
		let tmpDeclaredExclude = hasOwn(tmpDefinition, 'Exclude') && ((tmpDefinition.Exclude === 'Self') || (tmpDefinition.Exclude === 'None') || Array.isArray(tmpDefinition.Exclude));
		let tmpExclude = null;
		if (tmpDeclaredExclude && ((pParts.Origin === 'Declared') || !tmpOwnsNothing))
		{
			tmpExclude = clone(tmpDefinition.Exclude);
		}
		else
		{
			tmpExclude = (tmpOwnsNothing || tmpIsPivot) ? 'None' : 'Self';
		}
		// FilterKey (§23.5, §36.27): declared (main facet only); a pivot-column facet defaults to its
		// column; every other single-dimension facet (paths, bands, splits, tuples) to its FacetID.
		let tmpFilterKey = null;
		if ((pParts.Origin === 'Declared') && (typeof(tmpDefinition.FilterKey) === 'string'))
		{
			tmpFilterKey = tmpDefinition.FilterKey;
		}
		else if (!tmpIsPivot)
		{
			tmpFilterKey = (!pParts.Tuple && (tmpFirst.Info.FilterKeyDefault === 'Field')) ? tmpFirst.Dim.Field : pParts.FacetID;
		}
		let tmpOwnedFields = [];
		if (!tmpOwnsNothing)
		{
			tmpDimensions.forEach((pDimension) => { pDimension.Info.OwnedFields.forEach((pField) => { if (tmpOwnedFields.indexOf(pField) < 0) { tmpOwnedFields.push(pField); } }); });
		}
		let tmpWhereScopes = null;
		if (Array.isArray(tmpDefinition.Where) && (tmpDefinition.Where.length > 0)
			&& tmpDefinition.Where.every((pItem) => { return isPlainObject(pItem) && (typeof(pItem.Scope) === 'string') && !canonicalJSON(pItem.Params || {}).includes('"$'); }))
		{
			tmpWhereScopes = tmpDefinition.Where.map((pItem) => { return { Scope: pItem.Scope, Params: clone(pItem.Params || {}) }; });
		}
		let tmpDisplayName = (pParts.Origin === 'Sibling') ? libRetoldFacetingCatalog.deCamel(pParts.Name)
			: (tmpDefinition.DisplayName || tmpDefinition.Title || libRetoldFacetingCatalog.deCamel(pParts.Name));
		return (
			{
				Facet: pParts.FacetID,
				Origin: pParts.Origin,
				SiblingOf: pParts.SiblingOf,
				Entity: pParts.Home,
				Version: tmpDefinition.Version,
				Title: (pParts.Origin === 'Declared') ? (tmpDefinition.Title || null) : null,
				Description: (pParts.Origin === 'Declared') ? (tmpDefinition.Description || null) : null,
				DisplayName: tmpDisplayName,
				Pivot: clone(pParts.Pivot),
				Where: clone(pParts.Where),
				Dimensions: tmpDimensions.map((pDimension) => { return clone(pDimension.Dim); }),
				Fold: tmpFold,
				Folds: [ tmpFold ],
				CountMode: tmpCountMode,
				Exclude: tmpExclude,
				FilterKey: tmpFilterKey,
				Params: clone(pParts.Params),
				Entities: tmpCollector.Entities.slice(),
				Binds: tmpCollector.Binds.slice(),
				Relaxed: tmpCollector.Relaxed,
				Semantics: tmpCollector.NoVisibleMatch ? 'NoVisibleMatch' : null,
				Supported: !tmpCollector.Unsupported,
				Unsupported: tmpCollector.Unsupported ? clone(tmpCollector.Unsupported) : null,
				DefinitionHash: pParts.DefinitionHash,
				FoldHash: pParts.FoldHash,
				Source: pParts.Entry.Source,
				// Additions (internal-contracts §20.7 notes): what Describe, the Planner and the post-processor read.
				Path: (!tmpIsPivot && tmpFirst.Info.Path) ? tmpFirst.Info.Path.slice() : null,
				MultiValued: tmpMultiValued,
				Selectable: !tmpIsPivot,
				ClauseType: (tmpIsPivot || pParts.Tuple) ? null : tmpFirst.Info.ClauseType,
				OwnedFields: tmpOwnedFields,
				WhereScopes: tmpWhereScopes,
				Siblings: pParts.Siblings.slice()
			});
	}

	// ------------------------------------------------------------ the result

	/**
	 * The maps, lists and hash of the compilation.
	 *
	 * @return {Record<string, any>}
	 */
	_result()
	{
		let tmpFacets = new Map();
		let tmpScopes = new Map();
		let tmpAliases = new Map();
		let tmpWarnings = this.FileWarnings.slice();
		let fWarnings = (pEntry) =>
		{
			pEntry.Warnings.forEach((pWarning) => { tmpWarnings.push({ Code: pWarning.Code, Kind: pEntry.Kind, Name: pEntry.Name, Source: pEntry.Source, Pointer: pWarning.Pointer }); });
		};
		this.AliasEntries.forEach((pEntry) => { if ((pEntry.State === 'Done') && !tmpAliases.has(pEntry.Name)) { tmpAliases.set(pEntry.Name, pEntry.Result); fWarnings(pEntry); } });
		this.ScopeEntries.forEach((pEntry) => { if ((pEntry.State === 'Done') && !tmpScopes.has(pEntry.Name)) { tmpScopes.set(pEntry.Name, pEntry.Result); fWarnings(pEntry); } });
		this.FacetEntries.forEach(
			(pEntry) =>
			{
				if (pEntry.State !== 'Done')
				{
					return;
				}
				pEntry.Result.forEach((pFacet) => { tmpFacets.set(pFacet.Facet, pFacet); });
				fWarnings(pEntry);
			});
		let tmpHashSource = (
			{
				Sources: this.Sources.map((pSource) => { return { Source: pSource.HashName, Hash: sha1Hex((typeof(pSource.Content) === 'string') ? pSource.Content : '') }; }),
				Disabled: this.Disabled.map((pEntry) => { return `${pEntry.Kind}:${pEntry.Name}`; })
			});
		return (
			{
				Facets: tmpFacets,
				Scopes: tmpScopes,
				Aliases: tmpAliases,
				Disabled: this.Disabled.map((pEntry) => { return deepFreeze(pEntry); }),
				Warnings: tmpWarnings.map((pWarning) => { return deepFreeze(pWarning); }),
				Files: this.Sources.map((pSource) => { return pSource.Source; }),
				DefinitionsHash: 'd:' + sha1Hex(canonicalJSON(tmpHashSource)).substring(0, 12)
			});
	}
}

// ---------------------------------------------------------------- The service

class RetoldFacetingDefinitionRegistry extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingDefinitionRegistry';

		// FacetID → CanonicalFacet (declared facets and their siblings), Map (client-keyed lookups)
		this._Facets = new Map();
		// Scope name → CanonicalScope
		this._Scopes = new Map();
		// Alias name → canonical step list
		this._Aliases = new Map();
		// [ DisabledEntry ]
		this._Disabled = [];
		this._Warnings = [];
		this._Files = [];
		this._DefinitionsHash = 'd:000000000000';
		// The sources of the last load (a model reload re-validates them)
		this._Sources = null;
		// The environment of the last load (PathAuto synthesis uses the same graph and catalog)
		this._Environment = null;
		// FacetID → synthesized PathAuto CanonicalFacet (hits only; misses are never cached), cleared on every load
		this._PathAuto = new Map();
		// Disabled entries already logged (each is logged once)
		this._Logged = new Set();
	}

	/**
	 * The validation environment: the fable services and the host's scope policy unless given.
	 *
	 * @param {{ Graph?: any, Catalog?: any, Policy?: any, Options?: any, ClauseCompiler?: any }} [pEnvironment]
	 * @return {Record<string, any>}
	 */
	_environment(pEnvironment)
	{
		let tmpEnvironment = isPlainObject(pEnvironment) ? pEnvironment : {};
		let tmpCatalog = tmpEnvironment.Catalog || this.fable.RetoldFacetingCatalog || null;
		let tmpPolicy = tmpEnvironment.Policy || null;
		if (!tmpPolicy)
		{
			let tmpService = this.fable.RetoldFacetingService;
			let tmpHost = (tmpService && tmpService.Host) ? tmpService.Host : ((tmpCatalog && (typeof(tmpCatalog.getHost) === 'function')) ? tmpCatalog.getHost() : null);
			tmpPolicy = (tmpHost && (typeof(tmpHost.getScopePolicy) === 'function')) ? tmpHost.getScopePolicy() : NONE_POLICY;
		}
		// Literal values are coerced by the ClauseCompiler's one rule: the registered service when the
		// environment has one, else the module's pure coerceValue (no ad-hoc service registration).
		let tmpClauseCompiler = tmpEnvironment.ClauseCompiler || this.fable.RetoldFacetingClauseCompiler || { coerceValue: libRetoldFacetingClauseCompiler.coerceValue };
		return (
			{
				Graph: tmpEnvironment.Graph || this.fable.RetoldFacetingGraph || null,
				Catalog: tmpCatalog,
				Policy: tmpPolicy,
				Options: tmpEnvironment.Options ? libOptions.resolve(tmpEnvironment.Options) : this.options,
				ClauseCompiler: tmpClauseCompiler
			});
	}

	/**
	 * Read the definitions sources (internal-contracts §20.1): *.json directly under Path (sorted,
	 * not recursive; Path false or a missing directory loads nothing), then Files (absolute, or
	 * relative to Path, or to process.cwd() when Path is false), then Objects ('#object<i>').
	 *
	 * @param {Record<string, any>} pSources - Options.Definitions shape
	 * @return {Array<{ Source: string, HashName: string, Content: string|null, Object: any, Error: string|null }>}
	 */
	_readSources(pSources)
	{
		let tmpSources = isPlainObject(pSources) ? pSources : {};
		let tmpResult = [];
		let tmpSeen = new Set();
		let tmpBase = ((typeof(tmpSources.Path) === 'string') && (tmpSources.Path.length > 0)) ? libPath.resolve(tmpSources.Path) : null;
		let fRead = (pFile) =>
		{
			if (tmpSeen.has(pFile))
			{
				return;
			}
			tmpSeen.add(pFile);
			let tmpEntry = { Source: pFile, HashName: libPath.basename(pFile), Content: null, Object: null, Error: null };
			try
			{
				tmpEntry.Content = libFS.readFileSync(pFile, 'utf8');
			}
			catch (pReadError)
			{
				tmpEntry.Error = 'Unreadable';
				tmpResult.push(tmpEntry);
				return;
			}
			try
			{
				tmpEntry.Object = JSON.parse(tmpEntry.Content);
			}
			catch (pParseError)
			{
				tmpEntry.Error = 'InvalidJSON';
			}
			tmpResult.push(tmpEntry);
		};
		this._PathMissing = null;
		if (tmpBase)
		{
			let tmpNames = [];
			try
			{
				if (libFS.statSync(tmpBase).isDirectory())
				{
					tmpNames = libFS.readdirSync(tmpBase).filter((pName) => { return /\.json$/i.test(pName); }).sort();
				}
				else
				{
					this._PathMissing = tmpBase;
				}
			}
			catch (pDirectoryError)
			{
				// A missing directory still loads nothing, but load() reports it (a typo in the
				// configured path must not boot silently with every declared facet unknown).
				tmpNames = [];
				this._PathMissing = tmpBase;
			}
			tmpNames.forEach((pName) => { fRead(libPath.join(tmpBase, pName)); });
		}
		(Array.isArray(tmpSources.Files) ? tmpSources.Files : []).forEach(
			(pFile) =>
			{
				if ((typeof(pFile) !== 'string') || (pFile.length < 1))
				{
					tmpResult.push({ Source: String(pFile), HashName: String(pFile), Content: null, Object: null, Error: 'Unreadable' });
					return;
				}
				fRead(libPath.isAbsolute(pFile) ? pFile : libPath.resolve(tmpBase || process.cwd(), pFile));
			});
		(Array.isArray(tmpSources.Objects) ? tmpSources.Objects : []).forEach(
			(pObject, pIndex) =>
			{
				tmpResult.push({ Source: `#object${pIndex}`, HashName: `#object${pIndex}`, Content: canonicalJSON(pObject), Object: pObject, Error: null });
			});
		return tmpResult;
	}

	/**
	 * Log each newly disabled entry once (code, source, pointer, reason; never a value).
	 *
	 * @param {Array<Record<string, any>>} pDisabled
	 */
	_logDisabled(pDisabled)
	{
		let tmpLogged = new Set();
		pDisabled.forEach(
			(pEntry) =>
			{
				let tmpError = pEntry.Errors[0] || {};
				let tmpKey = `${pEntry.Kind}|${pEntry.Name}|${pEntry.Source}|${tmpError.Reason}|${tmpError.Pointer}`;
				tmpLogged.add(tmpKey);
				if (this._Logged.has(tmpKey))
				{
					return;
				}
				this.fable.log.error(`RetoldFaceting definitions: ${pEntry.Kind} ${libFacetUtil.logSafe(pEntry.Name)} disabled: FACET_DEFINITION_INVALID ${tmpError.Reason} at ${libFacetUtil.logSafe(pEntry.Source)}${libFacetUtil.logSafe(tmpError.Pointer || '')}${tmpError.DependsOn ? ` (depends on ${libFacetUtil.logSafe(tmpError.DependsOn)})` : ''}`);
			});
		this._Logged = tmpLogged;
	}

	/**
	 * Load (or reload) every definitions source and replace the registry contents atomically.
	 *
	 * @param {{ Path?: string|false, Files?: Array<string>, Objects?: Array<Record<string, any>> }} [pSources] - default the sources of the last load, else Options.Definitions
	 * @param {{ Graph?: any, Catalog?: any, Policy?: any, Options?: any, ClauseCompiler?: any }} [pEnvironment] - default the fable services and Host.getScopePolicy()
	 * @return {{ Loaded: { Facets: number, Scopes: number, Aliases: number }, Disabled: Array<Record<string, any>>, Warnings: Array<Record<string, any>>, DefinitionsHash: string }}
	 */
	load(pSources, pEnvironment)
	{
		if ((pSources !== null) && (typeof(pSources) !== 'undefined'))
		{
			this._Sources = pSources;
		}
		let tmpSources = this._Sources || this.options.Definitions;
		let tmpResult = null;
		let tmpEnvironment = null;
		try
		{
			tmpEnvironment = this._environment(pEnvironment);
			let tmpCompilation = new DefinitionCompilation(this, tmpEnvironment);
			tmpResult = tmpCompilation.run(this._readSources(tmpSources));
		}
		catch (pLoadError)
		{
			this.fable.log.error(`RetoldFaceting definitions: the load failed; keeping the previous registry: ${pLoadError.message}`);
			return { Loaded: { Facets: this._Facets.size, Scopes: this._Scopes.size, Aliases: this._Aliases.size }, Disabled: this.disabled(), Warnings: this.warnings(), DefinitionsHash: this._DefinitionsHash, Failed: true };
		}
		// Atomic swap.
		this._Facets = tmpResult.Facets;
		this._Scopes = tmpResult.Scopes;
		this._Aliases = tmpResult.Aliases;
		this._Disabled = tmpResult.Disabled;
		this._Warnings = tmpResult.Warnings;
		this._Files = tmpResult.Files;
		this._DefinitionsHash = tmpResult.DefinitionsHash;
		this._Environment = tmpEnvironment;
		this._PathAuto = new Map();
		this._logDisabled(this._Disabled);
		if (this._PathMissing)
		{
			let tmpConfigured = isPlainObject(tmpSources) ? tmpSources.Path : null;
			let tmpDefault = (libOptions.DEFAULTS && libOptions.DEFAULTS.Definitions) ? libOptions.DEFAULTS.Definitions.Path : null;
			let tmpMessage = `RetoldFaceting definitions: Definitions.Path ${libFacetUtil.logSafe(this._PathMissing)} is not a directory; no definitions were read from it.`;
			if (tmpConfigured === tmpDefault)
			{
				// The default path on a host that declares nothing: worth a note, not a warning.
				this.fable.log.info(tmpMessage);
			}
			else
			{
				this._Warnings = this._Warnings.concat([ { Code: 'DEFINITIONS_PATH_MISSING', Kind: 'File', Name: null, Source: this._PathMissing, Pointer: '' } ]);
				this.fable.log.warn(tmpMessage);
			}
		}
		if (this._Warnings.length > 0)
		{
			this.fable.log.warn(`RetoldFaceting definitions: ${this._Warnings.length} warning(s): ${this._Warnings.map((pWarning) => { return `${pWarning.Code} ${pWarning.Name}`; }).join('; ')}`);
		}
		return { Loaded: { Facets: this._Facets.size, Scopes: this._Scopes.size, Aliases: this._Aliases.size }, Disabled: this.disabled(), Warnings: this.warnings(), DefinitionsHash: this._DefinitionsHash };
	}

	/**
	 * Validate one definitions object without changing the registry (tests, CLI).  The object is
	 * validated on its own (it cannot reference the loaded registry's entries).
	 *
	 * @param {Record<string, any>} pDefinitions - a parsed definitions file
	 * @param {{ Graph?: any, Catalog?: any, Policy?: any, Options?: any, ClauseCompiler?: any }} [pEnvironment]
	 * @return {{ Valid: boolean, Errors: Array<Record<string, any>>, Warnings: Array<Record<string, any>>, Canonical: { Facets: Array<any>, Scopes: Array<any>, Aliases: Record<string, any> } }}
	 */
	validate(pDefinitions, pEnvironment)
	{
		let tmpCompilation = new DefinitionCompilation(this, this._environment(pEnvironment));
		let tmpResult = tmpCompilation.run([ { Source: '#object0', HashName: '#object0', Content: canonicalJSON(pDefinitions), Object: pDefinitions, Error: null } ]);
		let tmpErrors = [];
		tmpResult.Disabled.forEach((pEntry) => { pEntry.Errors.forEach((pError) => { tmpErrors.push(Object.assign({ Kind: pEntry.Kind, Name: pEntry.Name }, pError)); }); });
		let tmpAliases = {};
		tmpResult.Aliases.forEach((pSteps, pName) => { tmpAliases[pName] = pSteps; });
		return (
			{
				Valid: (tmpErrors.length === 0),
				Errors: tmpErrors,
				Warnings: tmpResult.Warnings,
				Canonical: { Facets: Array.from(tmpResult.Facets.values()), Scopes: Array.from(tmpResult.Scopes.values()), Aliases: tmpAliases }
			});
	}

	/**
	 * A declared facet or sibling ('E.Name' | 'E.Name/Sibling'); null when unknown or disabled.
	 *
	 * @param {string} pFacetID
	 * @return {Record<string, any>|null} CanonicalFacet (internal-contracts §20.7)
	 */
	facet(pFacetID)
	{
		return this._Facets.has(pFacetID) ? this._Facets.get(pFacetID) : null;
	}

	/**
	 * facet(), or an auto 1-hop path facet synthesized on demand ('E.c>T.col', internal-contracts
	 * §20.8); null otherwise.
	 *
	 * @param {string} pFacetID
	 * @return {Record<string, any>|null} CanonicalFacet with Origin 'Declared' | 'Sibling' | 'PathAuto'
	 */
	resolveFacet(pFacetID)
	{
		let tmpDeclared = this.facet(pFacetID);
		if (tmpDeclared)
		{
			return tmpDeclared;
		}
		if ((typeof(pFacetID) !== 'string') || (pFacetID.indexOf('>') < 0))
		{
			return null;
		}
		if (this._PathAuto.has(pFacetID))
		{
			return this._PathAuto.get(pFacetID);
		}
		let tmpSynthesized = this._synthesizePathAuto(pFacetID);
		if (tmpSynthesized)
		{
			// Only real PathAuto facets are cached: they are bounded by edges × target columns.  A miss
			// (any client string) is never remembered, so unique bogus FacetIDs cannot grow memory.
			this._PathAuto.set(pFacetID, tmpSynthesized);
		}
		return tmpSynthesized;
	}

	/**
	 * Build the PathAuto CanonicalFacet of 'E.c>T.col'.
	 *
	 * @param {string} pFacetID
	 * @return {Record<string, any>|null}
	 */
	_synthesizePathAuto(pFacetID)
	{
		let tmpEnvironment = this._Environment || this._environment();
		let tmpCatalog = tmpEnvironment.Catalog;
		let tmpGraph = tmpEnvironment.Graph;
		if (!tmpCatalog || !tmpGraph || (typeof(tmpCatalog.pathAutoDescriptor) !== 'function'))
		{
			return null;
		}
		let tmpAuto = tmpCatalog.pathAutoDescriptor(pFacetID);
		if (!tmpAuto)
		{
			return null;
		}
		let tmpPath = null;
		try
		{
			tmpPath = tmpGraph.resolvePath(tmpAuto.Entity, [ `>${tmpAuto.Edge}` ], { MaxHops: tmpEnvironment.Options.Limits.MaxHops });
		}
		catch (pPathError)
		{
			return null;
		}
		tmpPath.Steps.forEach((pStep) => { pStep.Where = null; });
		let tmpTarget = tmpAuto.Descriptor;
		let tmpFold = tmpAuto.DefaultFold;
		let tmpLookup = ((tmpFold === 'Terms') && tmpTarget.LabelLookup && tmpTarget.LabelLookup.LabelColumn)
			? { Entity: tmpTarget.LabelLookup.Entity, KeyColumn: tmpTarget.LabelLookup.KeyColumn, LabelColumn: tmpTarget.LabelLookup.LabelColumn } : null;
		let tmpToColumn = tmpPath.Steps[0].On[0][1];
		let tmpClauseType = (tmpFold === 'Terms') ? ((tmpAuto.Field === tmpToColumn) ? 'InternalJoinSelectedValueList' : 'InternalJoinMatch')
			: (tmpFold === 'DateHistogram') ? 'InternalJoinDateRange'
			: 'InternalJoinNumericRange';
		let tmpDefinitionHash = 'dh:' + sha1Hex(canonicalJSON({ PathAuto: pFacetID })).substring(0, 12);
		let tmpColumnName = /^ID[A-Z]/.test(tmpAuto.Column) ? tmpAuto.Column.substring(2) : tmpAuto.Column;
		return deepFreeze(
			{
				Facet: pFacetID,
				Origin: 'PathAuto',
				SiblingOf: null,
				Entity: tmpAuto.Entity,
				Version: 1,
				Title: null,
				Description: null,
				DisplayName: `${libRetoldFacetingCatalog.deCamel(tmpColumnName)} ${tmpTarget.DisplayName}`,
				Pivot: { Kind: 'Entity', Entity: tmpAuto.Entity },
				Where: null,
				Dimensions:
				[
					{
						Kind: tmpFold, Field: tmpAuto.Field, Alias: null, Path: tmpPath, PathShape: 'ToOne', KeyField: null, LabelLookup: tmpLookup,
						Where: null, Correlate: null, Child: null, Labels: null,
						Edges: null, Top: null, Order: null, Missing: null, Interval: (tmpFold === 'DateHistogram') ? (tmpTarget.DefaultInterval || null) : null,
						EmptyBuckets: null, Mode: null, Buckets: null, OpenEnded: null, Ranges: null,
						DataType: tmpTarget.DataType, IsInteger: !!tmpTarget.IsInteger, Scale: tmpTarget.Scale || 0
					}
				],
				Fold: tmpFold,
				Folds: tmpAuto.Folds.slice(),
				CountMode: 'Rows',
				Exclude: 'Self',
				FilterKey: pFacetID,
				Params: {},
				Entities: [ tmpAuto.Entity, tmpAuto.Target ],
				Binds: [],
				Relaxed: false,
				Semantics: null,
				Supported: true,
				Unsupported: null,
				DefinitionHash: tmpDefinitionHash,
				FoldHash: 'fh:' + sha1Hex(`${tmpDefinitionHash}|${tmpGraph.graphHash()}`).substring(0, 12),
				Source: '#auto',
				Path: [ tmpPath.Steps[0].Raw ],
				MultiValued: false,
				Selectable: true,
				ClauseType: tmpClauseType,
				OwnedFields: [ `@path:${tmpPath.Signature}#${tmpAuto.Field}` ],
				WhereScopes: null,
				Siblings: []
			});
	}

	/**
	 * @param {string} pName - 'Entity.Name'
	 * @return {Record<string, any>|null} CanonicalScope (internal-contracts §20.7)
	 */
	scope(pName)
	{
		return this._Scopes.has(pName) ? this._Scopes.get(pName) : null;
	}

	/**
	 * @param {string} pEntity
	 * @return {Array<Record<string, any>>} the enabled scopes whose Entity is pEntity (Describe)
	 */
	scopesFor(pEntity)
	{
		return Array.from(this._Scopes.values()).filter((pScope) => { return pScope.Entity === pEntity; });
	}

	/**
	 * @param {string} pEntity
	 * @return {Array<Record<string, any>>} the enabled declared facets (and siblings) homed on pEntity
	 */
	facetsFor(pEntity)
	{
		return Array.from(this._Facets.values()).filter((pFacet) => { return pFacet.Entity === pEntity; });
	}

	/**
	 * @param {string} pName
	 * @return {Array<any>|null} canonical steps of a declared alias (graph bridge aliases come from RetoldFacetingGraph.alias)
	 */
	alias(pName)
	{
		return this._Aliases.has(pName) ? this._Aliases.get(pName) : null;
	}

	/**
	 * Expressions (K15) are accepted and never served in M2.
	 *
	 * @param {string} pName
	 * @return {null}
	 */
	expression(pName)
	{
		return null;
	}

	/**
	 * @return {Array<Record<string, any>>} DisabledEntry list (internal-contracts §20.4)
	 */
	disabled()
	{
		return this._Disabled.slice();
	}

	/**
	 * @return {Array<Record<string, any>>} load warnings (CheckParentForced, ElideIgnored, CatalogSectionIgnored, Ignored:<Key>)
	 */
	warnings()
	{
		return this._Warnings.slice();
	}

	/**
	 * @return {string} 'd:' + 12 hex over the loaded sources and the disabled set (part of ModelVersion)
	 */
	definitionsHash()
	{
		return this._DefinitionsHash;
	}

	/**
	 * @return {{ Files: Array<string>, Facets: number, Scopes: number, Aliases: number, Disabled: number, Warnings: number }}
	 */
	status()
	{
		return { Files: this._Files.slice(), Facets: this._Facets.size, Scopes: this._Scopes.size, Aliases: this._Aliases.size, Disabled: this._Disabled.length, Warnings: this._Warnings.length };
	}
}

module.exports = RetoldFacetingDefinitionRegistry;
module.exports.serviceType = 'RetoldFacetingDefinitionRegistry';
module.exports.DEFINITION_SCHEMA = DEFINITION_SCHEMA;
module.exports.FORMAT_VERSION = FORMAT_VERSION;
module.exports.REASONS = REASONS;
module.exports.UNSUPPORTED_FEATURES = UNSUPPORTED_FEATURES;
module.exports.IGNORED_FACET_KEYS = IGNORED_FACET_KEYS;
module.exports.NEGATED_OPS = NEGATED_OPS;
module.exports.NEGATED_COUNT_OPS = NEGATED_COUNT_OPS;
module.exports.validateSchema = validateSchema;
module.exports.validateEnvelope = validateEnvelope;
module.exports.parseFieldRef = parseFieldRef;
