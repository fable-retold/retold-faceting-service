/**
 * Retold Faceting - Dialects
 *
 * Per-dialect identifier quoting, parameter sigils and the Scoped Relation harvest
 * (parameter renaming '<Alias>_<name>', longest names first, word boundary, skipping PG '::'
 * casts; MSSQL '@' sigils and parameterTypes; SQLite IN-expansion keys that exist only after
 * build) — 03 §3.2 and §3.6.
 *
 * Renaming is one left-to-right pass that matches the WHOLE identifier after each sigil
 * (maximal munch) and renames it only when it is a bound name.  That is the "longest name first,
 * word boundary" rule done in one step: ':p_w1' can never eat the front of ':p_w10', and a
 * doubled sigil ('::numeric' on PostgreSQL, '@@DATEFIRST' on MSSQL) is never treated as a bind.
 *
 * Contract: internal-contracts §7.2–§7.4.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../../contract/Facet-Contract-Errors.js');
const libFacetRequest = require('../../contract/Facet-Contract-Request.js');
const libRetoldFacetingUtil = require('../../Retold-Faceting-Util.js');

const hasOwn = libRetoldFacetingUtil.hasOwn;

// Static profile per dialect (03 §3.6).  Quote characters are for identifiers the service emits.
const DIALECT_PROFILES = Object.freeze(
	{
		SQLite: Object.freeze({ Name: 'SQLite', Sigil: ':', QuoteOpen: '"', QuoteClose: '"', WindowFunctions: true, GroupingSets: false }),
		PostgreSQL: Object.freeze({ Name: 'PostgreSQL', Sigil: ':', QuoteOpen: '"', QuoteClose: '"', WindowFunctions: true, GroupingSets: true }),
		MySQL: Object.freeze({ Name: 'MySQL', Sigil: ':', QuoteOpen: '`', QuoteClose: '`', WindowFunctions: true, GroupingSets: false }),
		MSSQL: Object.freeze({ Name: 'MSSQL', Sigil: '@', QuoteOpen: '[', QuoteClose: ']', WindowFunctions: true, GroupingSets: true })
	});

// meadow provider names (DAL.providerName) → dialect names
const PROVIDER_DIALECTS = Object.freeze(
	{
		SQLite: 'SQLite',
		PostgreSQL: 'PostgreSQL',
		MySQL: 'MySQL',
		MSSQL: 'MSSQL',
		MicrosoftSQL: 'MSSQL'
	});

// MeadowSchema Type → MSSQL parameter type (mirrors FoxHound's MSSQL dialect, keyed by the filter COLUMN
// instead of the filter's parameter name, which is not a column name for the facet's own entries).
const MSSQL_SCHEMA_PARAMETER_TYPES = Object.freeze(
	{
		AutoIdentity: 'Int',
		CreateIDUser: 'Int',
		UpdateIDUser: 'Int',
		DeleteIDUser: 'Int',
		Integer: 'Int',
		Deleted: 'TinyInt',
		Boolean: 'TinyInt',
		Decimal: 'Decimal',
		String: 'VarChar',
		AutoGUID: 'VarChar',
		Text: 'VarChar',
		CreateDate: 'DateTime',
		UpdateDate: 'DateTime',
		DeleteDate: 'DateTime',
		DateTime: 'DateTime'
	});

// The identifier whitelist pattern is the contract's (one owner).
const IDENTIFIER_PATTERN = libFacetRequest.IDENTIFIER_PATTERN;

/**
 * Escape a string for use inside a RegExp.
 *
 * @param {string} pText
 * @return {string}
 */
const escapeRegExp = (pText) =>
{
	return String(pText).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const stripColumn = libRetoldFacetingUtil.stripColumn;

class RetoldFacetingDialects extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingDialects';
	}

	/**
	 * The profile for a dialect name.
	 *
	 * @param {string} pDialectName - 'SQLite' | 'PostgreSQL' | 'MySQL' | 'MSSQL'
	 * @return {Record<string, any>|null}
	 */
	forName(pDialectName)
	{
		return hasOwn(DIALECT_PROFILES, pDialectName) ? DIALECT_PROFILES[pDialectName] : null;
	}

	/**
	 * The profile for a DAL (from its provider name).
	 *
	 * @param {any} pDAL
	 * @return {Record<string, any>|null}
	 */
	forDAL(pDAL)
	{
		if ((typeof(pDAL) !== 'object') || (pDAL === null))
		{
			return null;
		}
		let tmpProviderName = pDAL.providerName;
		if ((typeof(tmpProviderName) !== 'string') || !hasOwn(PROVIDER_DIALECTS, tmpProviderName))
		{
			return null;
		}
		return this.forName(PROVIDER_DIALECTS[tmpProviderName]);
	}

	/**
	 * Quote one identifier for a dialect.  Throws on anything outside IDENTIFIER_PATTERN (L4).
	 *
	 * @param {string} pDialectName
	 * @param {string} pIdentifier
	 * @return {string}
	 */
	quote(pDialectName, pIdentifier)
	{
		let tmpProfile = this.forName(pDialectName);
		if (!tmpProfile)
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'Unknown SQL dialect.');
		}
		if ((typeof(pIdentifier) !== 'string') || !IDENTIFIER_PATTERN.test(pIdentifier))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'Refusing to quote an invalid identifier.');
		}
		return `${tmpProfile.QuoteOpen}${pIdentifier}${tmpProfile.QuoteClose}`;
	}

	/**
	 * An alias-qualified, quoted column reference ("p"."Rating", `p`.`Rating`, [p].[Rating]).
	 *
	 * @param {string} pDialectName
	 * @param {string} pAlias
	 * @param {string} pColumn
	 * @return {string}
	 */
	qualify(pDialectName, pAlias, pColumn)
	{
		return `${this.quote(pDialectName, pAlias)}.${this.quote(pDialectName, pColumn)}`;
	}

	/**
	 * Rename every bound name in pSQL that is a key of pParams to pPrefix + name (one pass,
	 * maximal munch, doubled sigils skipped).  Pure helper (also used by tests).
	 *
	 * @param {string} pSQL
	 * @param {Record<string, any>} pParams
	 * @param {string} pPrefix - e.g. 'p_'
	 * @param {string} pSigil - ':' | '@'
	 * @return {string}
	 */
	renameParameters(pSQL, pParams, pPrefix, pSigil)
	{
		let tmpSigil = escapeRegExp(pSigil);
		let tmpPattern = new RegExp(`(${tmpSigil}{1,2})([A-Za-z_][A-Za-z0-9_]*)`, 'g');
		return String(pSQL).replace(tmpPattern,
			(pMatch, pSigils, pName) =>
			{
				if (pSigils.length > 1)
				{
					// '::type' (PostgreSQL cast) or '@@SYSTEMVAR' (MSSQL): never a bind
					return pMatch;
				}
				if (!Object.prototype.hasOwnProperty.call(pParams, pName))
				{
					return pMatch;
				}
				return `${pSigils}${pPrefix}${pName}`;
			});
	}

	/**
	 * Harvest a built FoxHound query as a Scoped Relation: SQL text (trailing ';' stripped) and
	 * parameters renamed '<pAlias>_<name>' (internal-contracts §7.2 step 6).
	 *
	 * MSSQL: array values (FoxHound's IN binds one '@name' to a JS array, which the MSSQL provider
	 * cannot bind) are expanded into scalar '@name_0, @name_1, …'; parameterTypes are renamed and
	 * corrected from the filter COLUMN's schema type.
	 *
	 * @param {any} pQuery - a FoxHound query after buildReadQuery()
	 * @param {string} pAlias
	 * @param {string} pDialectName
	 * @return {{ SQL: string, Params: Record<string, any>, ParamTypes: Record<string, any> }}
	 */
	harvest(pQuery, pAlias, pDialectName)
	{
		let tmpProfile = this.forName(pDialectName);
		if (!tmpProfile)
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'Unknown SQL dialect.');
		}
		if ((typeof(pAlias) !== 'string') || !IDENTIFIER_PATTERN.test(pAlias))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'Invalid relation alias.');
		}
		if (!pQuery || !pQuery.query || (typeof(pQuery.query.body) !== 'string') || (pQuery.query.body.length < 1))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'The relation query did not build.');
		}

		let tmpSQL = pQuery.query.body;
		let tmpSourceParams = (typeof(pQuery.query.parameters) === 'object' && pQuery.query.parameters) ? pQuery.query.parameters : {};
		let tmpParams = {};
		let tmpParamTypes = {};
		let tmpSourceTypes = (pDialectName === 'MSSQL') ? this._correctedMSSQLParameterTypes(pQuery) : {};

		let tmpNames = Object.keys(tmpSourceParams);
		for (let i = 0; i < tmpNames.length; i++)
		{
			let tmpValue = tmpSourceParams[tmpNames[i]];
			if ((pDialectName === 'MSSQL') && Array.isArray(tmpValue))
			{
				// Expand '@name' into '@name_0, @name_1, …' before the rename pass (MSSQL binds scalars only).
				let tmpElementNames = [];
				for (let j = 0; j < tmpValue.length; j++)
				{
					let tmpElementName = `${tmpNames[i]}_${j}`;
					tmpElementNames.push(`@${tmpElementName}`);
					tmpParams[tmpElementName] = tmpValue[j];
					if (hasOwn(tmpSourceTypes, tmpNames[i]))
					{
						tmpParamTypes[tmpElementName] = tmpSourceTypes[tmpNames[i]];
					}
				}
				let tmpArrayPattern = new RegExp(`(^|[^@A-Za-z0-9_])@${escapeRegExp(tmpNames[i])}(?![A-Za-z0-9_])`, 'g');
				tmpSQL = tmpSQL.replace(tmpArrayPattern, (pMatch, pLead) => { return `${pLead}${(tmpElementNames.length > 0) ? tmpElementNames.join(', ') : 'NULL'}`; });
				continue;
			}
			tmpParams[tmpNames[i]] = Array.isArray(tmpValue) ? tmpValue.slice() : tmpValue;
			if (hasOwn(tmpSourceTypes, tmpNames[i]))
			{
				tmpParamTypes[tmpNames[i]] = tmpSourceTypes[tmpNames[i]];
			}
		}

		let tmpPrefix = `${pAlias}_`;
		tmpSQL = this.renameParameters(tmpSQL, tmpParams, tmpPrefix, tmpProfile.Sigil);
		tmpSQL = tmpSQL.replace(/;\s*$/, '').trim();

		let tmpRenamedParams = {};
		let tmpRenamedTypes = {};
		let tmpParamNames = Object.keys(tmpParams);
		for (let i = 0; i < tmpParamNames.length; i++)
		{
			tmpRenamedParams[`${tmpPrefix}${tmpParamNames[i]}`] = tmpParams[tmpParamNames[i]];
			if (hasOwn(tmpParamTypes, tmpParamNames[i]))
			{
				tmpRenamedTypes[`${tmpPrefix}${tmpParamNames[i]}`] = tmpParamTypes[tmpParamNames[i]];
			}
		}

		return { SQL: tmpSQL, Params: tmpRenamedParams, ParamTypes: tmpRenamedTypes };
	}

	/**
	 * MSSQL parameterTypes of a built query, corrected from each filter entry's COLUMN schema type
	 * (FoxHound types by the entry's Parameter name, which falls back to VarChar for 'c1_Rating',
	 * 'FacetSoftDelete', 'TestTenancy', …).
	 *
	 * @param {any} pQuery
	 * @return {Record<string, string>}
	 */
	_correctedMSSQLParameterTypes(pQuery)
	{
		let tmpTypes = Object.assign({}, (pQuery.query && pQuery.query.parameterTypes) ? pQuery.query.parameterTypes : {});
		let tmpSchema = (pQuery.query && Array.isArray(pQuery.query.schema)) ? pQuery.query.schema : [];
		let tmpSchemaTypes = {};
		for (let i = 0; i < tmpSchema.length; i++)
		{
			tmpSchemaTypes[tmpSchema[i].Column] = tmpSchema[i].Type;
		}
		let tmpFilter = (pQuery.parameters && Array.isArray(pQuery.parameters.filter)) ? pQuery.parameters.filter : [];
		for (let i = 0; i < tmpFilter.length; i++)
		{
			let tmpEntry = tmpFilter[i];
			if ((tmpEntry.Operator === '(') || (tmpEntry.Operator === ')') || (tmpEntry.Operator === 'IS NULL') || (tmpEntry.Operator === 'IS NOT NULL'))
			{
				continue;
			}
			let tmpName = `${tmpEntry.Parameter}_w${i}`;
			let tmpSchemaType = tmpSchemaTypes[stripColumn(tmpEntry.Column)];
			if (hasOwn(tmpTypes, tmpName) && hasOwn(MSSQL_SCHEMA_PARAMETER_TYPES, tmpSchemaType))
			{
				tmpTypes[tmpName] = MSSQL_SCHEMA_PARAMETER_TYPES[tmpSchemaType];
			}
		}
		return tmpTypes;
	}

	/**
	 * Merge relation parameterTypes into the outer query (MSSQL).
	 *
	 * @param {any} pQuery
	 * @param {Record<string, any>} pParamTypes
	 * @return {any} pQuery
	 */
	mergeParameterTypes(pQuery, pParamTypes)
	{
		if (!pQuery || !pQuery.query || (typeof(pParamTypes) !== 'object') || (pParamTypes === null))
		{
			return pQuery;
		}
		let tmpNames = Object.keys(pParamTypes);
		if (tmpNames.length < 1)
		{
			return pQuery;
		}
		if ((typeof(pQuery.query.parameterTypes) !== 'object') || (pQuery.query.parameterTypes === null))
		{
			pQuery.query.parameterTypes = {};
		}
		for (let i = 0; i < tmpNames.length; i++)
		{
			pQuery.query.parameterTypes[tmpNames[i]] = pParamTypes[tmpNames[i]];
		}
		return pQuery;
	}
}

module.exports = RetoldFacetingDialects;
module.exports.serviceType = 'RetoldFacetingDialects';
module.exports.DIALECT_PROFILES = DIALECT_PROFILES;
module.exports.PROVIDER_DIALECTS = PROVIDER_DIALECTS;
module.exports.IDENTIFIER_PATTERN = IDENTIFIER_PATTERN;
module.exports.stripColumn = stripColumn;
