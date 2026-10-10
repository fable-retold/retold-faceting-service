/**
 * Facet Contract - Request
 *
 * PURE: requires nothing outside source/contract/. Shared with pict-section-facet.
 *
 * Constants and pure helpers for the facet request contract (02 §3, internal-contracts §3 and
 * §11.2), including the full request normalization: defaults, the L1 request-shape limits
 * (06 §8 / 02 §9), refusal of request features that are not in Milestone 1, and the legacy
 * RecordSetSearchFacetPayload converter (02 §3.2; a seam: off unless AcceptLegacy).
 * The RetoldFacetingRequestNormalizer service delegates to normalizeRequest(); the client can run
 * the same function to validate a request before sending it.
 *
 * It also owns the shared request-limit defaults (LIMIT_DEFAULTS): the service options build their
 * Limits section from it, so a configured limit applies everywhere the contract reads one.
 *
 * @author Steven Velozo <steven@velozo.com>
 */

const libFacetErrors = require('./Facet-Contract-Errors.js');
const libFacetUtil = require('./Facet-Contract-Util.js');

const CONTRACT_VERSION = 1;

// Fold kinds a client may name in Facets[].Fold (01 §2; M2 adds the ChildRollup and ExistsSplit
// bucket kinds, internal-contracts §28.2 — only valid on a declared facet that lists them).
const FOLDS = Object.freeze([ 'Terms', 'DateHistogram', 'NumericHistogram', 'Ranges', 'Stats', 'DistinctCount', 'Missing', 'Pivot', 'ChildRollup', 'ExistsSplit' ]);

// Folds whose buckets can be selected (and so carry Clause + Selection).
const SELECTABLE_FOLDS = Object.freeze([ 'Terms', 'DateHistogram', 'NumericHistogram', 'Ranges' ]);

const INTERVALS = Object.freeze([ 'day', 'week', 'month', 'quarter', 'year' ]);

const ORDERS = Object.freeze([ 'CountDesc', 'KeyAsc', 'KeyDesc' ]);

const NUMERIC_MODES = Object.freeze([ 'Nice', 'Edges' ]);

const EXCLUDE_POLICIES = Object.freeze([ 'Self', 'None' ]);

// Default disjunctive policy per fold (01 §8.3).
const DEFAULT_EXCLUDE = Object.freeze(
	{
		Terms: 'Self',
		DateHistogram: 'Self',
		NumericHistogram: 'Self',
		Ranges: 'Self',
		Stats: 'None',
		DistinctCount: 'None',
		Missing: 'None',
		Pivot: 'None',
		Count: 'None',
		ChildRollup: 'None',
		ExistsSplit: 'None'
	});

// The pict clause type a selection on each fold writes back (02 §5).
const FOLD_CLAUSE_TYPE = Object.freeze(
	{
		Terms: 'DistinctSelectedValueList',
		DateHistogram: 'DateRange',
		NumericHistogram: 'NumericRange',
		Ranges: 'NumericRange',
		Stats: null,
		DistinctCount: null,
		Missing: null,
		Pivot: null,
		ChildRollup: null,
		ExistsSplit: null
	});

// Clause types the M1 ClauseCompiler accepts (internal-contracts §4.4).
const M1_CLAUSE_TYPES = Object.freeze(
	[
		'DistinctSelectedValueList',
		'DateRange', 'NumericRange', 'StringRange', 'Range',
		'Match', 'StringMatch', 'DateMatch', 'NumericMatch',
		'RawFilter'
	]);

// meadow-filter instructions the FilterValidator accepts; FSF is stripped with a warning.
const FILTER_INSTRUCTIONS = Object.freeze([ 'FBV', 'FBVOR', 'FBL', 'FBLOR', 'FOP', 'FOPOR', 'FCP' ]);
const FILTER_STRIPPED_INSTRUCTIONS = Object.freeze([ 'FSF' ]);

// meadow-filter operator → FilterAST Op (meadow-filter 'IN' means IS NULL; 'INN' is the IN list).
const FILTER_OPERATOR_MAP = Object.freeze(
	{
		EQ: 'EQ', NE: 'NE', GT: 'GT', GE: 'GE', LT: 'LT', LE: 'LE',
		LK: 'LK', NLK: 'NLK',
		IN: 'NULL', NN: 'NOTNULL',
		INN: 'IN', NIN: 'NIN'
	});

// FilterAST Ops (01 §4.4, column-only subset).
const PRED_OPS = Object.freeze([ 'EQ', 'NE', 'GT', 'GE', 'LT', 'LE', 'LK', 'NLK', 'IN', 'NIN', 'NULL', 'NOTNULL' ]);

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// The definitions $-token grammar (internal-contracts §22.2): $CurrentUser.<F>, $Scope.<Column>,
// $Param.<Name>, $StartOf.<unit>, $Now, $Today.  Server-side only (client values are never parsed
// for '$'); shared by the DefinitionRegistry (load-time validation) and the Binder (binding).
const TOKEN_PATTERN = /^\$(CurrentUser|Scope|Param|StartOf)\.([A-Za-z_][A-Za-z0-9_]{0,63})$|^\$(Now|Today)$/;

// Param types a definition may declare (01 §4.3, internal-contracts §22.3).
const PARAM_TYPES = Object.freeze([ 'Enum', 'EnumList', 'Integer', 'IntegerList', 'String', 'Boolean', 'DateTime' ]);

/**
 * Parse a FacetID (internal-contracts §11.2).
 *
 *   'Book.Language'                    → { Kind: 'Auto', Entity: 'Book', Column: 'Language' }
 *   'Review.IDBook>Book.Language'      → { Kind: 'Path', Entity: 'Review', Raw }
 *   'Book.ByAuthor/Top'                → { Kind: 'Declared', Entity: 'Book', Name: 'ByAuthor/Top' }
 *   anything malformed                 → null
 *
 * @param {any} pFacetID
 * @return {{ Kind: string, Entity: string, Column?: string, Name?: string, Raw: string } | null}
 */
const parseFacetID = (pFacetID) =>
{
	if ((typeof(pFacetID) !== 'string') || (pFacetID.length < 3) || (pFacetID.length > 256))
	{
		return null;
	}
	let tmpDotIndex = pFacetID.indexOf('.');
	if (tmpDotIndex < 1)
	{
		return null;
	}
	let tmpEntity = pFacetID.substring(0, tmpDotIndex);
	let tmpRest = pFacetID.substring(tmpDotIndex + 1);
	if (!IDENTIFIER_PATTERN.test(tmpEntity) || (tmpRest.length < 1))
	{
		return null;
	}
	if (tmpRest.indexOf('>') >= 0)
	{
		return { Kind: 'Path', Entity: tmpEntity, Raw: pFacetID };
	}
	if (tmpRest.indexOf('/') >= 0)
	{
		let tmpParts = tmpRest.split('/');
		for (let i = 0; i < tmpParts.length; i++)
		{
			if (!IDENTIFIER_PATTERN.test(tmpParts[i]))
			{
				return null;
			}
		}
		return { Kind: 'Declared', Entity: tmpEntity, Name: tmpRest, Raw: pFacetID };
	}
	if (!IDENTIFIER_PATTERN.test(tmpRest))
	{
		return null;
	}
	// 'Entity.Name' is syntactically identical to an auto facet; the catalog decides (an unknown
	// column is FACET_UNKNOWN_FACET in M1 because no definitions are loaded).
	return { Kind: 'Auto', Entity: tmpEntity, Column: tmpRest, Raw: pFacetID };
};

/**
 * The default Exclude policy for a fold kind.
 *
 * @param {string} pFold
 * @return {string} 'Self' | 'None'
 */
const defaultExcludeFor = (pFold) =>
{
	return libFacetUtil.hasOwn(DEFAULT_EXCLUDE, pFold) ? DEFAULT_EXCLUDE[pFold] : 'None';
};

/**
 * The clause type a bucket of this fold writes back (null when not selectable).
 *
 * @param {string} pFold
 * @return {string|null}
 */
const clauseTypeFor = (pFold) =>
{
	return libFacetUtil.hasOwn(FOLD_CLAUSE_TYPE, pFold) ? FOLD_CLAUSE_TYPE[pFold] : null;
};

/**
 * Clamp a client-supplied positive integer.
 *
 * @param {any} pValue
 * @param {number} pDefault - used when pValue is null/undefined
 * @param {number} pMax
 * @return {number|null} the clamped integer, or null when pValue is not a positive integer
 */
const clampPositiveInteger = (pValue, pDefault, pMax) =>
{
	if ((pValue === null) || (typeof(pValue) === 'undefined'))
	{
		return pDefault;
	}
	if ((typeof(pValue) !== 'number') || !Number.isInteger(pValue) || (pValue < 1))
	{
		return null;
	}
	return Math.min(pValue, pMax);
};

// ---------------------------------------------------------------- Request normalization (internal-contracts §3)

// The request / envelope limits the contract reads, and their defaults.  The single owner: the
// service options build Limits from these (Retold-Faceting-Service-Options), and the envelope
// post-processor falls back to them, so a configured limit applies everywhere.
const LIMIT_DEFAULTS = Object.freeze(
	{
		MaxFacets: 20,
		MaxTop: 500,
		DefaultTop: 20,
		MaxBuckets: 500,
		DefaultBuckets: 20,
		MaxDateBuckets: 400,
		MaxPivotDimensions: 2,
		TimeoutMS: 10000,
		MaxBodyBytes: 262144,
		MaxJSONDepth: 8,
		MaxClauses: 100,
		MaxValueBytes: 1024,
		MaxInList: 1000,
		// Records / Keys (internal-contracts §28.2): page size, deepest offset, Keys cap.
		MaxRecordsPage: 500,
		MaxRecordsOffset: 10000,
		MaxKeys: 50000
	});

// The milestone whose request contract this module implements (Detail.Milestone of a 422 refusal).
const MILESTONE = 2;

// Folds a client cannot name: PathTerms / BridgeTerms / TuplePivot facets are requested by FacetID
// (their fold is the declared bucket kind), Computed and UnionOfSources are later milestones — all
// 422 FACET_FOLD_UNSUPPORTED, not 400.
const LATER_FOLDS = Object.freeze([ 'PathTerms', 'BridgeTerms', 'Computed', 'UnionOfSources', 'TuplePivot' ]);

// The request modes normalizeRequest serves (internal-contracts §19.5 Mode, §28.2).
const REQUEST_MODES = Object.freeze([ 'Query', 'Records', 'Count', 'Keys' ]);

// Records.Sort: at most this many fields; Dir values.
const MAX_RECORDS_SORT = 4;
const SORT_DIRECTIONS = Object.freeze([ 'ASC', 'DESC' ]);

// Facet Keys starting with this are reserved for the service ('#Total').
const RESERVED_KEY_PREFIX = '#';

// M5 (internal-contracts §62.2): the request Engine values ('Live' never routes to a store).
const REQUEST_ENGINES = Object.freeze([ 'Auto', 'Live' ]);

// M4 (internal-contracts §44.2): the Freshness modes (02 §3.3), their defaults, and the local change
// sequence grammar a MinSeq must match ('<NodeEpoch>:<n>', NodeEpoch 'e:' + 8 lowercase hex,
// internal-contracts §39.1; Retold-Faceting-Util re-exports this pattern so there is one grammar).
const FRESHNESS_MODES = Object.freeze([ 'Exact', 'Bounded', 'Fast' ]);
const FRESHNESS_DEFAULTS = Object.freeze({ DefaultMode: 'Exact', MaxLagMS: 5000, MaxAgeMS: 600000 });
const SEQ_PATTERN = /^e:[0-9a-f]{8}:(0|[1-9][0-9]{0,14})$/;

/**
 * @param {any} pValue
 * @return {boolean}
 */
const isPlainObject = libFacetUtil.isPlainObject;

/**
 * @param {any} pValue
 * @return {boolean}
 */
const isAbsent = (pValue) =>
{
	return (pValue === null) || (typeof(pValue) === 'undefined');
};

/**
 * UTF-8 byte length of a string.
 *
 * @param {string} pText
 * @return {number}
 */
const utf8Length = (pText) =>
{
	let tmpLength = 0;
	for (let i = 0; i < pText.length; i++)
	{
		let tmpCode = pText.charCodeAt(i);
		if (tmpCode < 0x80)
		{
			tmpLength += 1;
		}
		else if (tmpCode < 0x800)
		{
			tmpLength += 2;
		}
		else if ((tmpCode >= 0xD800) && (tmpCode <= 0xDBFF) && ((i + 1) < pText.length))
		{
			tmpLength += 4;
			i++;
		}
		else
		{
			tmpLength += 3;
		}
	}
	return tmpLength;
};

/**
 * A 400 FACET_REQUEST_INVALID.
 *
 * @param {string} pMessage
 * @param {Record<string, any>} [pDetail]
 * @return {Error}
 */
const invalid = (pMessage, pDetail) =>
{
	return libFacetErrors.create('FACET_REQUEST_INVALID', pMessage, pDetail);
};

/**
 * A 422 FACET_FOLD_UNSUPPORTED for a feature of a later milestone.
 *
 * @param {string} pFeature
 * @return {Error}
 */
const unsupported = (pFeature) =>
{
	return libFacetErrors.create('FACET_FOLD_UNSUPPORTED', `${pFeature} is not supported in this version.`, { Feature: pFeature, Milestone: MILESTONE });
};

/**
 * Resolve the limits normalizeRequest reads.
 *
 * @param {Record<string, any>} [pLimits]
 * @return {Record<string, number>}
 */
const resolveLimits = (pLimits) =>
{
	let tmpLimits = Object.assign({}, LIMIT_DEFAULTS);
	if (isPlainObject(pLimits))
	{
		let tmpKeys = Object.keys(LIMIT_DEFAULTS);
		for (let i = 0; i < tmpKeys.length; i++)
		{
			let tmpValue = pLimits[tmpKeys[i]];
			if ((typeof(tmpValue) === 'number') && (tmpValue > 0))
			{
				tmpLimits[tmpKeys[i]] = tmpValue;
			}
		}
	}
	return tmpLimits;
};

/**
 * L1 request-shape limits (06 §8): approximate JSON size ≤ MaxBodyBytes, container depth ≤
 * MaxJSONDepth (the body itself is depth 1), Clauses ≤ MaxClauses, every string (and object key)
 * ≤ MaxValueBytes, every array ≤ MaxInList.  Filter strings (top-level FilterString, a clause's
 * Filter / Value) are exempt from the per-string limit (only the body limit applies to them; the
 * FilterValidator limits each value inside them).  Throws 400 FACET_REQUEST_INVALID with
 * Detail: { Limit, Max, Path }.
 *
 * @param {any} pBody - the parsed JSON body
 * @param {Record<string, any>} [pLimits] - RetoldFaceting.Limits
 */
const checkLimits = (pBody, pLimits) =>
{
	let tmpLimits = resolveLimits(pLimits);
	if (isPlainObject(pBody) && Array.isArray(pBody.Clauses) && (pBody.Clauses.length > tmpLimits.MaxClauses))
	{
		throw invalid('Too many clauses.', { Limit: 'MaxClauses', Max: tmpLimits.MaxClauses, Path: 'Clauses' });
	}
	let tmpState = { Bytes: 0 };

	let fWalk = (pValue, pDepth, pPath, pExempt) =>
	{
		if (typeof(pValue) === 'string')
		{
			let tmpBytes = utf8Length(pValue);
			if (!pExempt && (tmpBytes > tmpLimits.MaxValueBytes))
			{
				throw invalid('A string value is too long.', { Limit: 'MaxValueBytes', Max: tmpLimits.MaxValueBytes, Path: pPath });
			}
			tmpState.Bytes += tmpBytes + 2;
		}
		else if ((typeof(pValue) === 'number') || (typeof(pValue) === 'boolean'))
		{
			tmpState.Bytes += String(pValue).length;
		}
		else if (pValue === null)
		{
			tmpState.Bytes += 4;
		}
		else if (Array.isArray(pValue) || isPlainObject(pValue))
		{
			if (pDepth > tmpLimits.MaxJSONDepth)
			{
				throw invalid('The request is nested too deeply.', { Limit: 'MaxJSONDepth', Max: tmpLimits.MaxJSONDepth, Path: pPath });
			}
			if (Array.isArray(pValue))
			{
				if (pValue.length > tmpLimits.MaxInList)
				{
					throw invalid('An array is too long.', { Limit: 'MaxInList', Max: tmpLimits.MaxInList, Path: pPath });
				}
				tmpState.Bytes += 2;
				for (let i = 0; i < pValue.length; i++)
				{
					fWalk(pValue[i], pDepth + 1, `${pPath}[${i}]`, false);
					tmpState.Bytes += 1;
				}
			}
			else
			{
				let tmpKeys = Object.keys(pValue);
				let tmpIsRawFilter = (pValue.Type === 'RawFilter');
				tmpState.Bytes += 2;
				for (let i = 0; i < tmpKeys.length; i++)
				{
					let tmpKey = tmpKeys[i];
					let tmpKeyBytes = utf8Length(tmpKey);
					if (tmpKeyBytes > tmpLimits.MaxValueBytes)
					{
						throw invalid('An object key is too long.', { Limit: 'MaxValueBytes', Max: tmpLimits.MaxValueBytes, Path: pPath });
					}
					tmpState.Bytes += tmpKeyBytes + 4;
					let tmpChildPath = pPath ? `${pPath}.${tmpKey}` : tmpKey;
					let tmpExempt = ((pDepth === 1) && (tmpKey === 'FilterString'))
						|| (/^Clauses\[\d+\]$/.test(pPath) && ((tmpKey === 'Filter') || (tmpIsRawFilter && (tmpKey === 'Value'))));
					fWalk(pValue[tmpKey], pDepth + 1, tmpChildPath.slice(0, 256), tmpExempt);
				}
			}
		}
		if (tmpState.Bytes > tmpLimits.MaxBodyBytes)
		{
			throw invalid('The request body is too large.', { Limit: 'MaxBodyBytes', Max: tmpLimits.MaxBodyBytes });
		}
	};

	fWalk(pBody, 1, '', false);
};

/**
 * A boolean option: absent → pDefault; a boolean → itself; anything else → 400.
 *
 * @param {any} pValue
 * @param {boolean|null} pDefault
 * @param {Record<string, any>} pDetail
 * @return {boolean|null}
 */
const booleanOption = (pValue, pDefault, pDetail) =>
{
	if (isAbsent(pValue))
	{
		return pDefault;
	}
	if (typeof(pValue) !== 'boolean')
	{
		throw invalid(`${pDetail.Field} must be a boolean.`, pDetail);
	}
	return pValue;
};

/**
 * The Freshness settings normalizeRequest reads (internal-contracts §44.2): DefaultMode, MaxLagMS
 * (the default lag bound) and MaxAgeMS (the largest MaxLagMS a request may ask for, Cache.MaxAgeMS).
 *
 * @param {Record<string, any>} [pFreshness]
 * @return {{ DefaultMode: string, MaxLagMS: number, MaxAgeMS: number }}
 */
const resolveFreshnessSettings = (pFreshness) =>
{
	let tmpFreshness = isPlainObject(pFreshness) ? pFreshness : {};
	let tmpMaxAgeMS = (Number.isSafeInteger(tmpFreshness.MaxAgeMS) && (tmpFreshness.MaxAgeMS >= 0)) ? tmpFreshness.MaxAgeMS : FRESHNESS_DEFAULTS.MaxAgeMS;
	let tmpMaxLagMS = (Number.isSafeInteger(tmpFreshness.MaxLagMS) && (tmpFreshness.MaxLagMS >= 0)) ? Math.min(tmpFreshness.MaxLagMS, tmpMaxAgeMS) : Math.min(FRESHNESS_DEFAULTS.MaxLagMS, tmpMaxAgeMS);
	return (
		{
			DefaultMode: (FRESHNESS_MODES.indexOf(tmpFreshness.DefaultMode) >= 0) ? tmpFreshness.DefaultMode : FRESHNESS_DEFAULTS.DefaultMode,
			MaxLagMS: tmpMaxLagMS,
			MaxAgeMS: tmpMaxAgeMS
		});
};

/**
 * Normalize a request's Freshness (02 §3.3, internal-contracts §44.2): absent → { Mode: DefaultMode,
 * MaxLagMS, MinSeq: null }; otherwise a plain object whose Mode is one of FRESHNESS_MODES, whose
 * MaxLagMS is an integer 0 … MaxAgeMS and whose MinSeq matches SEQ_PATTERN (each optional; unknown
 * keys are ignored).  Throws 400 FACET_REQUEST_INVALID { Field } on anything else.  Freshness is never
 * cache key material: it chooses which answer may be served, not what the answer is.
 *
 * @param {any} pFreshness - the body's Freshness
 * @param {Record<string, any>} [pSettings] - { DefaultMode, MaxLagMS, MaxAgeMS }
 * @return {{ Mode: string, MaxLagMS: number, MinSeq: string|null }}
 */
const normalizeFreshness = (pFreshness, pSettings) =>
{
	let tmpSettings = resolveFreshnessSettings(pSettings);
	if (isAbsent(pFreshness))
	{
		return { Mode: tmpSettings.DefaultMode, MaxLagMS: tmpSettings.MaxLagMS, MinSeq: null };
	}
	if (!isPlainObject(pFreshness))
	{
		throw invalid('Freshness must be an object.', { Field: 'Freshness' });
	}
	let tmpMode = tmpSettings.DefaultMode;
	if (!isAbsent(pFreshness.Mode))
	{
		if (FRESHNESS_MODES.indexOf(pFreshness.Mode) < 0)
		{
			throw invalid(`Freshness.Mode must be one of ${FRESHNESS_MODES.join(', ')}.`, { Field: 'Freshness.Mode' });
		}
		tmpMode = pFreshness.Mode;
	}
	let tmpMaxLagMS = tmpSettings.MaxLagMS;
	if (!isAbsent(pFreshness.MaxLagMS))
	{
		if (!Number.isSafeInteger(pFreshness.MaxLagMS) || (pFreshness.MaxLagMS < 0) || (pFreshness.MaxLagMS > tmpSettings.MaxAgeMS))
		{
			throw invalid(`Freshness.MaxLagMS must be an integer between 0 and ${tmpSettings.MaxAgeMS}.`, { Field: 'Freshness.MaxLagMS', Max: tmpSettings.MaxAgeMS });
		}
		tmpMaxLagMS = pFreshness.MaxLagMS;
	}
	let tmpMinSeq = null;
	if (!isAbsent(pFreshness.MinSeq))
	{
		if ((typeof(pFreshness.MinSeq) !== 'string') || !SEQ_PATTERN.test(pFreshness.MinSeq))
		{
			throw invalid('Freshness.MinSeq must be a change sequence (\'e:<8 hex>:<n>\').', { Field: 'Freshness.MinSeq' });
		}
		tmpMinSeq = pFreshness.MinSeq;
	}
	return { Mode: tmpMode, MaxLagMS: tmpMaxLagMS, MinSeq: tmpMinSeq };
};

/**
 * An enumerated option: absent → null; a member → itself; anything else → 400.
 *
 * @param {any} pValue
 * @param {Array<string>} pAllowed
 * @param {Record<string, any>} pDetail
 * @return {string|null}
 */
const enumOption = (pValue, pAllowed, pDetail) =>
{
	if (isAbsent(pValue))
	{
		return null;
	}
	if ((typeof(pValue) !== 'string') || (pAllowed.indexOf(pValue) < 0))
	{
		throw invalid(`${pDetail.Field} must be one of ${pAllowed.join(', ')}.`, pDetail);
	}
	return pValue;
};

/**
 * Normalize one Facets[] entry (internal-contracts §3).  Throws request-level FacetErrors; never
 * looks at the catalog.
 *
 * @param {any} pSpec - the client's Facets[pIndex]
 * @param {number} pIndex
 * @param {Record<string, any>} [pSettings] - { Limits, Time: { StorageTimeZone } } (resolved RetoldFaceting options)
 * @param {Array<Record<string, any>>} [pWarnings] - appended to (FACET_TOP_CLAMPED, FACET_BUCKETS_CLAMPED)
 * @return {Record<string, any>} the normalized facet spec
 */
const normalizeFacetSpec = (pSpec, pIndex, pSettings, pWarnings) =>
{
	let tmpSettings = isPlainObject(pSettings) ? pSettings : {};
	let tmpLimits = resolveLimits(tmpSettings.Limits);
	let tmpStorageTimeZone = (isPlainObject(tmpSettings.Time) && (typeof(tmpSettings.Time.StorageTimeZone) === 'string')) ? tmpSettings.Time.StorageTimeZone : 'UTC';
	let tmpWarnings = Array.isArray(pWarnings) ? pWarnings : [];
	let fDetail = (pField, pExtra) => { return Object.assign({ Field: pField, Index: pIndex }, pExtra || {}); };

	if (!isPlainObject(pSpec))
	{
		throw invalid('Each facet must be an object.', fDetail('Facets'));
	}
	if (!isAbsent(pSpec.Definition))
	{
		throw libFacetErrors.create('FACET_ADHOC_FORBIDDEN', null, { Index: pIndex });
	}

	// Fold
	let tmpFold = null;
	if (!isAbsent(pSpec.Fold))
	{
		if (typeof(pSpec.Fold) !== 'string')
		{
			throw invalid('Fold must be a string.', fDetail('Fold'));
		}
		if (LATER_FOLDS.indexOf(pSpec.Fold) >= 0)
		{
			throw unsupported(pSpec.Fold);
		}
		if (FOLDS.indexOf(pSpec.Fold) < 0)
		{
			throw libFacetErrors.create('FACET_UNKNOWN_FOLD', null, { Index: pIndex, Fold: pSpec.Fold });
		}
		tmpFold = pSpec.Fold;
	}

	// Facet (a FacetID, or exactly two for a Pivot)
	let tmpFacetIDs = null;
	if (typeof(pSpec.Facet) === 'string')
	{
		if (tmpFold === 'Pivot')
		{
			throw invalid('A Pivot needs Facet to be an array of two FacetIDs.', fDetail('Facet', { Reason: 'PivotNeedsTwoFacets' }));
		}
		tmpFacetIDs = [ pSpec.Facet ];
	}
	else if (Array.isArray(pSpec.Facet))
	{
		// M1 pivots are 2-D (K14); MaxPivotDimensions can only lower that.
		let tmpPivotDimensions = Math.min(2, tmpLimits.MaxPivotDimensions);
		if (pSpec.Facet.length !== tmpPivotDimensions)
		{
			throw invalid('A Pivot takes exactly two FacetIDs.', fDetail('Facet', { Reason: 'PivotDimensions', Max: tmpPivotDimensions }));
		}
		if (tmpFold !== 'Pivot')
		{
			throw invalid('An array of FacetIDs requires Fold: Pivot.', fDetail('Facet', { Reason: 'FacetArrayNeedsPivot' }));
		}
		tmpFacetIDs = pSpec.Facet.slice();
	}
	else
	{
		throw invalid('Facet is required.', fDetail('Facet', { Reason: 'Missing' }));
	}
	for (let i = 0; i < tmpFacetIDs.length; i++)
	{
		if (parseFacetID(tmpFacetIDs[i]) === null)
		{
			throw invalid('Facet is not a valid FacetID.', fDetail('Facet', { Reason: 'InvalidFacetID' }));
		}
	}

	// Key (it becomes a map key and log text: no control characters, no Object.prototype names)
	let tmpKey = isAbsent(pSpec.Key) ? tmpFacetIDs.join('|') : pSpec.Key;
	let tmpKeyProblem = libFacetUtil.keyProblem(tmpKey);
	if ((tmpKeyProblem === 'NotString') || (tmpKeyProblem === 'Empty'))
	{
		throw invalid('Key must be a non-empty string.', fDetail('Key'));
	}
	if (tmpKeyProblem !== null)
	{
		throw invalid('This facet Key is not allowed.', fDetail('Key', { Reason: (tmpKeyProblem === 'ReservedName') ? 'ReservedKey' : tmpKeyProblem }));
	}
	if (tmpKey.indexOf(RESERVED_KEY_PREFIX) === 0)
	{
		throw invalid('Keys starting with # are reserved.', fDetail('Key', { Reason: 'ReservedKey' }));
	}

	// Interval / TimeZone (D-22)
	let tmpInterval = enumOption(pSpec.Interval, INTERVALS, fDetail('Interval'));
	let tmpTimeZone = null;
	if (!isAbsent(pSpec.TimeZone))
	{
		if (typeof(pSpec.TimeZone) !== 'string')
		{
			throw invalid('TimeZone must be a string.', fDetail('TimeZone'));
		}
		if (pSpec.TimeZone !== tmpStorageTimeZone)
		{
			throw libFacetErrors.create('FACET_TIMEZONE_UNSUPPORTED', null, { Index: pIndex, StorageTimeZone: tmpStorageTimeZone });
		}
		tmpTimeZone = pSpec.TimeZone;
	}

	// Top (clamped silently to MaxTop, with a warning)
	let tmpTop = null;
	if (!isAbsent(pSpec.Top))
	{
		if ((typeof(pSpec.Top) !== 'number') || !Number.isInteger(pSpec.Top) || (pSpec.Top < 1))
		{
			throw invalid('Top must be a positive integer.', fDetail('Top'));
		}
		tmpTop = Math.min(pSpec.Top, tmpLimits.MaxTop);
		if (tmpTop !== pSpec.Top)
		{
			tmpWarnings.push({ Code: 'FACET_TOP_CLAMPED', Detail: { Key: tmpKey, Requested: pSpec.Top, Applied: tmpTop } });
		}
	}

	let tmpOrder = enumOption(pSpec.Order, ORDERS, fDetail('Order'));
	let tmpMissing = booleanOption(pSpec.Missing, true, fDetail('Missing'));

	// Buckets (Nice target, clamped to MaxBuckets with a warning)
	let tmpBuckets = null;
	if (!isAbsent(pSpec.Buckets))
	{
		if ((typeof(pSpec.Buckets) !== 'number') || !Number.isInteger(pSpec.Buckets) || (pSpec.Buckets < 1))
		{
			throw invalid('Buckets must be a positive integer.', fDetail('Buckets'));
		}
		tmpBuckets = Math.min(pSpec.Buckets, tmpLimits.MaxBuckets);
		if (tmpBuckets !== pSpec.Buckets)
		{
			tmpWarnings.push({ Code: 'FACET_BUCKETS_CLAMPED', Detail: { Key: tmpKey, Requested: pSpec.Buckets, Applied: tmpBuckets } });
		}
	}

	// Mode / Edges / OpenEnded
	let tmpMode = null;
	if (!isAbsent(pSpec.Mode))
	{
		if (pSpec.Mode === 'Log')
		{
			throw unsupported('LogMode');
		}
		tmpMode = enumOption(pSpec.Mode, NUMERIC_MODES, fDetail('Mode'));
	}
	let tmpEdges = null;
	if (!isAbsent(pSpec.Edges))
	{
		if (!Array.isArray(pSpec.Edges) || (pSpec.Edges.length < 2) || (pSpec.Edges.length > (tmpLimits.MaxBuckets + 1)))
		{
			throw invalid(`Edges must be an array of 2 to ${tmpLimits.MaxBuckets + 1} numbers.`, fDetail('Edges'));
		}
		for (let i = 0; i < pSpec.Edges.length; i++)
		{
			let tmpEdge = pSpec.Edges[i];
			if ((typeof(tmpEdge) !== 'number') || !Number.isFinite(tmpEdge) || ((i > 0) && (tmpEdge <= pSpec.Edges[i - 1])))
			{
				throw invalid('Edges must be strictly ascending finite numbers.', fDetail('Edges', { EdgeIndex: i }));
			}
		}
		tmpEdges = pSpec.Edges.slice();
		if (tmpMode === null)
		{
			tmpMode = 'Edges';
		}
		else if (tmpMode !== 'Edges')
		{
			throw invalid('Edges are only used by Mode: Edges.', fDetail('Edges', { Reason: 'EdgesWithNice' }));
		}
	}
	else if (tmpMode === 'Edges')
	{
		throw invalid('Mode: Edges requires Edges.', fDetail('Edges', { Reason: 'EdgesRequired' }));
	}
	let tmpOpenEnded = booleanOption(pSpec.OpenEnded, false, fDetail('OpenEnded'));

	// Ranges
	let tmpRanges = null;
	if (!isAbsent(pSpec.Ranges))
	{
		if (!Array.isArray(pSpec.Ranges) || (pSpec.Ranges.length < 1) || (pSpec.Ranges.length > tmpLimits.MaxBuckets))
		{
			throw invalid(`Ranges must be an array of 1 to ${tmpLimits.MaxBuckets} ranges.`, fDetail('Ranges'));
		}
		tmpRanges = [];
		let tmpRangeKeys = new Set();
		for (let i = 0; i < pSpec.Ranges.length; i++)
		{
			let tmpRange = pSpec.Ranges[i];
			let fRangeDetail = (pReason) => { return fDetail('Ranges', { RangeIndex: i, Reason: pReason }); };
			if (!isPlainObject(tmpRange))
			{
				throw invalid('Each range must be an object.', fRangeDetail('NotObject'));
			}
			let tmpRangeKeyProblem = libFacetUtil.keyProblem(tmpRange.Key);
			if ((tmpRangeKeyProblem === 'NotString') || (tmpRangeKeyProblem === 'Empty') || tmpRangeKeys.has(tmpRange.Key))
			{
				throw invalid('Each range needs a unique, non-empty string Key.', fRangeDetail('Key'));
			}
			if ((tmpRangeKeyProblem !== null) || (tmpRange.Key.indexOf(RESERVED_KEY_PREFIX) === 0))
			{
				throw invalid('This range Key is not allowed.', fRangeDetail((tmpRangeKeyProblem === null) || (tmpRangeKeyProblem === 'ReservedName') ? 'ReservedKey' : tmpRangeKeyProblem));
			}
			tmpRangeKeys.add(tmpRange.Key);
			let tmpFrom = isAbsent(tmpRange.From) ? null : tmpRange.From;
			let tmpTo = isAbsent(tmpRange.To) ? null : tmpRange.To;
			if (((tmpFrom !== null) && ((typeof(tmpFrom) !== 'number') || !Number.isFinite(tmpFrom)))
				|| ((tmpTo !== null) && ((typeof(tmpTo) !== 'number') || !Number.isFinite(tmpTo))))
			{
				throw invalid('Range From / To must be finite numbers or null.', fRangeDetail('Bound'));
			}
			if ((tmpFrom !== null) && (tmpTo !== null) && (tmpFrom >= tmpTo))
			{
				throw invalid('Range From must be less than To.', fRangeDetail('Order'));
			}
			if (!isAbsent(tmpRange.Label) && (typeof(tmpRange.Label) !== 'string'))
			{
				throw invalid('Range Label must be a string.', fRangeDetail('Label'));
			}
			tmpRanges.push({ Key: tmpRange.Key, From: tmpFrom, To: tmpTo, Label: isAbsent(tmpRange.Label) ? null : tmpRange.Label });
		}
	}

	// Exclude
	let tmpExclude = null;
	if (!isAbsent(pSpec.Exclude))
	{
		if (typeof(pSpec.Exclude) === 'string')
		{
			if (pSpec.Exclude.indexOf('Group:') === 0)
			{
				throw unsupported('ExcludeGroup');
			}
			tmpExclude = enumOption(pSpec.Exclude, EXCLUDE_POLICIES, fDetail('Exclude'));
		}
		else if (Array.isArray(pSpec.Exclude))
		{
			for (let i = 0; i < pSpec.Exclude.length; i++)
			{
				if ((typeof(pSpec.Exclude[i]) !== 'string') || (pSpec.Exclude[i].length < 1))
				{
					throw invalid('Exclude entries must be clause Hashes or conjunct Ids.', fDetail('Exclude'));
				}
			}
			tmpExclude = pSpec.Exclude.slice();
		}
		else
		{
			throw invalid('Exclude must be Self, None or an array.', fDetail('Exclude'));
		}
	}

	// CountMode (only Rows in M1)
	let tmpCountMode = null;
	if (!isAbsent(pSpec.CountMode))
	{
		if (pSpec.CountMode !== 'Rows')
		{
			throw unsupported('CountMode');
		}
		tmpCountMode = 'Rows';
	}

	return (
		{
			Key: tmpKey,
			FacetIDs: tmpFacetIDs,
			Fold: tmpFold,
			Interval: tmpInterval,
			TimeZone: tmpTimeZone,
			Top: tmpTop,
			Order: tmpOrder,
			Missing: tmpMissing,
			Buckets: tmpBuckets,
			Mode: tmpMode,
			Edges: tmpEdges,
			OpenEnded: tmpOpenEnded,
			Ranges: tmpRanges,
			Exclude: tmpExclude,
			CountMode: tmpCountMode,
			Labels: booleanOption(pSpec.Labels, null, fDetail('Labels')),
			Chart: booleanOption(pSpec.Chart, false, fDetail('Chart')),
			EmptyBuckets: booleanOption(pSpec.EmptyBuckets, true, fDetail('EmptyBuckets'))
		});
};

/**
 * Is this body the recordset's legacy RecordSetSearchFacetPayload (02 §3.2)?  Either the payload
 * itself ({ ReturnRecords, Fields, Ranges } with no Facets array) or a RecordSetFilter carrying it
 * as an object under Facets.
 *
 * @param {any} pBody
 * @return {boolean}
 */
const isLegacyPayload = (pBody) =>
{
	if (!isPlainObject(pBody))
	{
		return false;
	}
	if (isPlainObject(pBody.Facets))
	{
		return Array.isArray(pBody.Facets.Fields) || Array.isArray(pBody.Facets.Ranges);
	}
	return isAbsent(pBody.Facets) && (Array.isArray(pBody.Fields) || Array.isArray(pBody.Ranges));
};

/**
 * A legacy range Gap that names a date interval ('month', 'MONTH', '+1MONTH', '1 month'), or null.
 *
 * @param {any} pGap
 * @return {string|null}
 */
const legacyGapInterval = (pGap) =>
{
	if (typeof(pGap) !== 'string')
	{
		return null;
	}
	let tmpMatch = /^\+?1?\s*(DAY|WEEK|MONTH|QUARTER|YEAR)S?$/i.exec(pGap.trim());
	return tmpMatch ? tmpMatch[1].toLowerCase() : null;
};

/**
 * Convert the legacy RecordSetSearchFacetPayload into the standard request body (02 §3.2):
 * Fields → Terms facets (Key = the field), Ranges → DateHistogram (a date Gap) or Edges-mode
 * NumericHistogram (a numeric Gap from Start to End; Key = 'Range:<Field>').  Clauses / FilterString
 * are carried over; ReturnRecords is dropped (Records are a later milestone).  Throws 400 on a
 * malformed legacy payload.  Used by normalizeRequest only when pSettings.AcceptLegacy is true.
 *
 * @param {string} pEntity - the route entity (FacetIDs are '<Entity>.<Field>')
 * @param {Record<string, any>} pBody
 * @param {Record<string, any>} [pLimits] - RetoldFaceting.Limits (MaxBuckets bounds the generated edges)
 * @return {Record<string, any>} a standard request body
 */
const legacyToRequest = (pEntity, pBody, pLimits) =>
{
	let tmpLimits = resolveLimits(pLimits);
	let tmpSource = isPlainObject(pBody.Facets) ? pBody.Facets : pBody;
	let tmpFacets = [];
	let tmpFields = Array.isArray(tmpSource.Fields) ? tmpSource.Fields : [];
	for (let i = 0; i < tmpFields.length; i++)
	{
		if ((typeof(tmpFields[i]) !== 'string') || !IDENTIFIER_PATTERN.test(tmpFields[i]))
		{
			throw invalid('Legacy facet Fields must be column names.', { Field: 'Fields', Index: i, Reason: 'LegacyField' });
		}
		tmpFacets.push({ Key: tmpFields[i], Facet: `${pEntity}.${tmpFields[i]}`, Fold: 'Terms' });
	}
	let tmpRanges = Array.isArray(tmpSource.Ranges) ? tmpSource.Ranges : [];
	for (let i = 0; i < tmpRanges.length; i++)
	{
		let tmpRange = tmpRanges[i];
		if (!isPlainObject(tmpRange) || (typeof(tmpRange.Field) !== 'string') || !IDENTIFIER_PATTERN.test(tmpRange.Field))
		{
			throw invalid('Legacy facet Ranges need a Field.', { Field: 'Ranges', Index: i, Reason: 'LegacyRange' });
		}
		let tmpFacetID = `${pEntity}.${tmpRange.Field}`;
		let tmpKey = `Range:${tmpRange.Field}`;
		let tmpInterval = legacyGapInterval(tmpRange.Gap);
		if (tmpInterval !== null)
		{
			tmpFacets.push({ Key: tmpKey, Facet: tmpFacetID, Fold: 'DateHistogram', Interval: tmpInterval });
			continue;
		}
		let tmpStart = Number(tmpRange.Start);
		let tmpEnd = Number(tmpRange.End);
		let tmpGap = Number(tmpRange.Gap);
		if (isAbsent(tmpRange.Start) || isAbsent(tmpRange.End) || isAbsent(tmpRange.Gap)
			|| !Number.isFinite(tmpStart) || !Number.isFinite(tmpEnd) || !Number.isFinite(tmpGap) || (tmpGap <= 0) || (tmpStart >= tmpEnd))
		{
			throw invalid('Legacy facet Ranges need numeric Start < End and a positive Gap (or a date Gap).', { Field: 'Ranges', Index: i, Reason: 'LegacyRange' });
		}
		let tmpEdges = [];
		for (let tmpStep = 0; tmpEdges.length <= tmpLimits.MaxBuckets; tmpStep++)
		{
			let tmpEdge = Number((tmpStart + (tmpStep * tmpGap)).toFixed(10));
			if (tmpEdge >= tmpEnd)
			{
				break;
			}
			tmpEdges.push(tmpEdge);
		}
		tmpEdges.push(tmpEnd);
		tmpFacets.push({ Key: tmpKey, Facet: tmpFacetID, Fold: 'NumericHistogram', Mode: 'Edges', Edges: tmpEdges });
	}
	let tmpRequest = { Facets: tmpFacets, Total: true };
	if (!isAbsent(pBody.Clauses))
	{
		tmpRequest.Clauses = pBody.Clauses;
	}
	if (!isAbsent(pBody.FilterString))
	{
		tmpRequest.FilterString = pBody.FilterString;
	}
	return tmpRequest;
};

/**
 * A client parameter map (top-level Params, a scope reference's Params): a plain object whose keys
 * are safe map keys (no control characters, no Object.prototype names), copied into a fresh object
 * (values are shape-checked later by the Binder against the declared schema).
 *
 * @param {any} pValue
 * @param {Record<string, any>} pDetail - Detail of the 400 (Field, Index…)
 * @return {Record<string, any>}
 */
const normalizeParams = (pValue, pDetail) =>
{
	if (isAbsent(pValue))
	{
		return {};
	}
	if (!isPlainObject(pValue))
	{
		throw invalid('Params must be an object.', pDetail);
	}
	let tmpParams = {};
	let tmpNames = Object.keys(pValue);
	for (let i = 0; i < tmpNames.length; i++)
	{
		let tmpProblem = libFacetUtil.keyProblem(tmpNames[i]);
		if (tmpProblem !== null)
		{
			throw invalid('This parameter name is not allowed.', Object.assign({}, pDetail, { Reason: (tmpProblem === 'ReservedName') ? 'ReservedKey' : tmpProblem }));
		}
		tmpParams[tmpNames[i]] = pValue[tmpNames[i]];
	}
	return tmpParams;
};

/**
 * Request Scopes (internal-contracts §28.2): an array of { Scope: '<Entity>.<Name>', Params? }.
 * Shape only — whether the scope exists, is enabled, is on this entity and how many a request may
 * name are the FilterAST's (400 FACET_UNKNOWN_SCOPE / 422 MaxScopesPerRequest).
 *
 * @param {any} pScopes
 * @return {Array<{ Scope: string, Params: Record<string, any> }>}
 */
const normalizeScopes = (pScopes) =>
{
	if (isAbsent(pScopes))
	{
		return [];
	}
	if (!Array.isArray(pScopes))
	{
		throw invalid('Scopes must be an array.', { Field: 'Scopes' });
	}
	let tmpScopes = [];
	for (let i = 0; i < pScopes.length; i++)
	{
		let tmpReference = pScopes[i];
		if (!isPlainObject(tmpReference) || (typeof(tmpReference.Scope) !== 'string') || (tmpReference.Scope.length < 1) || (tmpReference.Scope.length > 256))
		{
			throw invalid('Each scope must be an object { Scope, Params }.', { Field: 'Scopes', Index: i });
		}
		tmpScopes.push({ Scope: tmpReference.Scope, Params: normalizeParams(tmpReference.Params, { Field: 'Scopes', Index: i }) });
	}
	return tmpScopes;
};

/**
 * A page bound: an integer in [pMin, pMax] (absent → pDefault), else 400 { Field, Max }.
 *
 * @param {any} pValue
 * @param {number} pDefault
 * @param {number} pMin
 * @param {number} pMax
 * @param {string} pField
 * @return {number}
 */
const pageBound = (pValue, pDefault, pMin, pMax, pField) =>
{
	if (isAbsent(pValue))
	{
		return pDefault;
	}
	if ((typeof(pValue) !== 'number') || !Number.isInteger(pValue) || (pValue < pMin) || (pValue > pMax))
	{
		throw invalid(`${pField} must be an integer from ${pMin} to ${pMax}.`, { Field: pField, Max: pMax });
	}
	return pValue;
};

/**
 * The Records page of a request (internal-contracts §28.2): { Begin, Cap, Sort: [ { Field, Dir } ] }.
 * Begin 0…MaxRecordsOffset (default 0), Cap 1…MaxRecordsPage (default min(250, MaxRecordsPage),
 * the list's and the recordset's default page), at most MAX_RECORDS_SORT sort fields (Field an
 * identifier — the service checks it is a filterable pivot column — Dir ASC | DESC, default ASC).
 *
 * @param {any} pRecords
 * @param {Record<string, number>} pLimits - resolved limits
 * @return {{ Begin: number, Cap: number, Sort: Array<{ Field: string, Dir: string }> }}
 */
const normalizeRecordsPage = (pRecords, pLimits) =>
{
	let tmpRecords = isAbsent(pRecords) ? {} : pRecords;
	if (!isPlainObject(tmpRecords))
	{
		throw invalid('Records must be an object { Begin, Cap, Sort }.', { Field: 'Records' });
	}
	let tmpBegin = pageBound(tmpRecords.Begin, 0, 0, pLimits.MaxRecordsOffset, 'Begin');
	let tmpCap = pageBound(tmpRecords.Cap, Math.min(250, pLimits.MaxRecordsPage), 1, pLimits.MaxRecordsPage, 'Cap');
	let tmpSort = [];
	if (!isAbsent(tmpRecords.Sort))
	{
		if (!Array.isArray(tmpRecords.Sort) || (tmpRecords.Sort.length > MAX_RECORDS_SORT))
		{
			throw invalid(`Records.Sort must be an array of at most ${MAX_RECORDS_SORT} sort fields.`, { Field: 'Sort', Max: MAX_RECORDS_SORT });
		}
		for (let i = 0; i < tmpRecords.Sort.length; i++)
		{
			let tmpEntry = tmpRecords.Sort[i];
			if (!isPlainObject(tmpEntry) || (typeof(tmpEntry.Field) !== 'string') || !IDENTIFIER_PATTERN.test(tmpEntry.Field))
			{
				throw invalid('Each sort entry needs a Field.', { Field: 'Sort', Index: i });
			}
			let tmpDir = isAbsent(tmpEntry.Dir) ? 'ASC' : (typeof(tmpEntry.Dir) === 'string') ? tmpEntry.Dir.toUpperCase() : null;
			if (SORT_DIRECTIONS.indexOf(tmpDir) < 0)
			{
				throw invalid('Sort Dir must be ASC or DESC.', { Field: 'Sort', Index: i, Reason: 'Dir' });
			}
			tmpSort.push({ Field: tmpEntry.Field, Dir: tmpDir });
		}
	}
	return { Begin: tmpBegin, Cap: tmpCap, Sort: tmpSort };
};

/**
 * Normalize a facet request body into the NormalizedRequest (internal-contracts §3, §28.2).
 * Synchronous; throws a FacetError on rejection:
 *
 *   400 FACET_REQUEST_INVALID     body shape, L1 limits (Detail.Limit), bad option values, duplicate Keys,
 *                                 malformed Scopes / Params / Records, a Records page or Keys Cap out of
 *                                 range (Detail: { Field: 'Begin' | 'Cap', Max }), a legacy payload (unless AcceptLegacy)
 *   400 FACET_TOO_MANY_FACETS     Facets.length > Limits.MaxFacets
 *   400 FACET_UNKNOWN_FOLD        a Fold name that does not exist
 *   403 FACET_ADHOC_FORBIDDEN     a facet carries a Definition
 *   422 FACET_FOLD_UNSUPPORTED    Selections, FilterExperience, folds named only through a FacetID or of a
 *                                 later milestone, Log mode, Group: exclusion, non-Rows CountMode
 *                                 (Detail: { Feature, Milestone: 2 })
 *   422 FACET_TIMEZONE_UNSUPPORTED  a facet TimeZone other than Time.StorageTimeZone
 *
 * Modes (pSettings.Mode): 'Query' (default; Facets required, Records optional), 'Records' (the
 * Records routes: Facets optional and ignored, Records page defaulted), 'Count' (Facets and Records
 * ignored), 'Keys' (Facets and Records ignored; top-level Cap 1…MaxKeys, default MaxKeys).  Every
 * mode reads the same filter inputs: Clauses (NamedScope clauses included), FilterString, Scopes,
 * Params.  The recordset's Experience is accepted and ignored.
 *
 * @param {string} pEntity - the route :Entity
 * @param {any} pBody - the parsed JSON body
 * @param {Record<string, any>} [pSettings] - the resolved RetoldFaceting options ({ Limits, Time }); AcceptLegacy: true enables 02 §3.2; Mode
 * @return {Record<string, any>} NormalizedRequest
 */
const normalizeRequest = (pEntity, pBody, pSettings) =>
{
	let tmpSettings = isPlainObject(pSettings) ? pSettings : {};
	let tmpLimits = resolveLimits(tmpSettings.Limits);
	let tmpMode = isAbsent(tmpSettings.Mode) ? 'Query' : tmpSettings.Mode;
	if (REQUEST_MODES.indexOf(tmpMode) < 0)
	{
		throw libFacetErrors.create('FACET_INTERNAL', 'normalizeRequest: unknown request mode.');
	}
	if (!isPlainObject(pBody))
	{
		throw invalid('The request body must be a JSON object.', { Reason: 'BodyNotObject' });
	}
	let tmpBody = pBody;
	let tmpWarnings = [];
	if ((tmpMode === 'Query') && isLegacyPayload(tmpBody))
	{
		if (tmpSettings.AcceptLegacy !== true)
		{
			throw invalid('The legacy RecordSetSearchFacetPayload is not accepted; send Facets[].', { Field: 'Facets', Reason: 'LegacyPayload' });
		}
		checkLimits(tmpBody, tmpLimits);
		tmpBody = legacyToRequest(pEntity, tmpBody, tmpLimits);
		tmpWarnings.push({ Code: 'FACET_LEGACY_PAYLOAD', Detail: 'The legacy facet payload was converted to Facets[].' });
	}
	checkLimits(tmpBody, tmpLimits);

	// Named scopes and parameters (shape only; the registry and the Binder validate meaning).
	let tmpScopes = normalizeScopes(tmpBody.Scopes);
	let tmpParams = normalizeParams(tmpBody.Params, { Field: 'Params' });

	// Features that are later milestones: refuse, never silently ignore (a client must not get an unfiltered answer).
	if (!isAbsent(tmpBody.Selections))
	{
		if (!Array.isArray(tmpBody.Selections))
		{
			throw invalid('Selections must be an array.', { Field: 'Selections' });
		}
		if (tmpBody.Selections.length > 0)
		{
			throw unsupported('Selections');
		}
	}
	if (!isAbsent(tmpBody.FilterExperience))
	{
		throw unsupported('FilterExperience');
	}

	// Clauses: shape-checked only (compiled later; a NamedScope clause is expanded by the FilterAST)
	let tmpClauses = [];
	if (!isAbsent(tmpBody.Clauses))
	{
		if (!Array.isArray(tmpBody.Clauses))
		{
			throw invalid('Clauses must be an array.', { Field: 'Clauses' });
		}
		for (let i = 0; i < tmpBody.Clauses.length; i++)
		{
			let tmpClause = tmpBody.Clauses[i];
			if (!isPlainObject(tmpClause) || (typeof(tmpClause.Type) !== 'string') || (tmpClause.Type.length < 1))
			{
				throw invalid('Each clause must be an object with a Type.', { Field: 'Clauses', Index: i });
			}
			if (tmpClause.Type === 'FacetSelection')
			{
				throw unsupported('Selections');
			}
			let tmpCopy = Object.assign({}, tmpClause);
			if ((tmpClause.Type === 'NamedScope') && !isAbsent(tmpClause.Params))
			{
				tmpCopy.Params = normalizeParams(tmpClause.Params, { Field: 'Clauses', Index: i });
			}
			tmpClauses.push(tmpCopy);
		}
	}

	// FilterString: RAW as received (the FilterValidator decodes it once)
	let tmpFilterString = null;
	if (!isAbsent(tmpBody.FilterString))
	{
		if (typeof(tmpBody.FilterString) !== 'string')
		{
			throw invalid('FilterString must be a string.', { Field: 'FilterString' });
		}
		tmpFilterString = (tmpBody.FilterString.length > 0) ? tmpBody.FilterString : null;
	}

	// Facets (the Query mode only; the Records / Count / Keys routes ignore them)
	let tmpFacets = [];
	if (tmpMode === 'Query')
	{
		if (isAbsent(tmpBody.Facets))
		{
			throw invalid('Facets is required.', { Field: 'Facets', Reason: 'Missing' });
		}
		if (!Array.isArray(tmpBody.Facets) || (tmpBody.Facets.length < 1))
		{
			throw invalid('Facets must be a non-empty array.', { Field: 'Facets' });
		}
		if (tmpBody.Facets.length > tmpLimits.MaxFacets)
		{
			throw libFacetErrors.create('FACET_TOO_MANY_FACETS', null, { Max: tmpLimits.MaxFacets, Count: tmpBody.Facets.length });
		}
		let tmpFacetSettings = { Limits: tmpLimits, Time: tmpSettings.Time };
		let tmpKeys = new Set();
		for (let i = 0; i < tmpBody.Facets.length; i++)
		{
			let tmpFacet = normalizeFacetSpec(tmpBody.Facets[i], i, tmpFacetSettings, tmpWarnings);
			if (tmpKeys.has(tmpFacet.Key))
			{
				throw invalid('Facet Keys must be unique.', { Field: 'Key', Index: i, Reason: 'DuplicateKey' });
			}
			tmpKeys.add(tmpFacet.Key);
			tmpFacets.push(tmpFacet);
		}
	}

	// Records (a page of the full filter's rows): optional on a Query, the point of the Records mode.
	let tmpRecords = null;
	if (tmpMode === 'Records')
	{
		tmpRecords = normalizeRecordsPage(tmpBody.Records, tmpLimits);
	}
	else if ((tmpMode === 'Query') && !isAbsent(tmpBody.Records) && (tmpBody.Records !== false))
	{
		tmpRecords = normalizeRecordsPage(tmpBody.Records, tmpLimits);
	}

	// Keys cap
	let tmpCap = null;
	if (tmpMode === 'Keys')
	{
		tmpCap = pageBound(tmpBody.Cap, tmpLimits.MaxKeys, 1, tmpLimits.MaxKeys, 'Cap');
	}

	// Total, TimeoutMS, Freshness
	let tmpTotal = (tmpMode === 'Query') ? booleanOption(tmpBody.Total, true, { Field: 'Total' }) : false;
	let tmpTimeoutMS = tmpLimits.TimeoutMS;
	if (!isAbsent(tmpBody.TimeoutMS))
	{
		if ((typeof(tmpBody.TimeoutMS) !== 'number') || !Number.isFinite(tmpBody.TimeoutMS) || (tmpBody.TimeoutMS < 1))
		{
			throw invalid('TimeoutMS must be a positive number.', { Field: 'TimeoutMS' });
		}
		tmpTimeoutMS = Math.min(Math.floor(tmpBody.TimeoutMS), tmpLimits.TimeoutMS);
	}
	// M4 (internal-contracts §44.2): every mode shape-checks Freshness; only a Query reads it.
	let tmpFreshness = normalizeFreshness(tmpBody.Freshness, tmpSettings.Freshness);
	// M5 (internal-contracts §62.2): 'Auto' (a store may answer) | 'Live' (the authoritative engine);
	// every mode shape-checks it, only a Query routes by it.  Never key material: it can only make an
	// answer a Live answer.
	let tmpEngine = 'Auto';
	if (!isAbsent(tmpBody.Engine))
	{
		if (REQUEST_ENGINES.indexOf(tmpBody.Engine) < 0)
		{
			throw invalid(`Engine must be one of ${REQUEST_ENGINES.join(', ')}.`, { Field: 'Engine' });
		}
		tmpEngine = tmpBody.Engine;
	}

	return (
		{
			Entity: pEntity,
			Mode: tmpMode,
			Clauses: tmpClauses,
			FilterString: tmpFilterString,
			Scopes: tmpScopes,
			Params: tmpParams,
			Facets: tmpFacets,
			Total: tmpTotal,
			Records: tmpRecords,
			Cap: tmpCap,
			TimeoutMS: tmpTimeoutMS,
			// M4: { Mode, MaxLagMS, MinSeq } (the service's Freshness stage turns it into the effective mode).
			Freshness: tmpFreshness,
			// M5 (internal-contracts §62.2)
			Engine: tmpEngine,
			Warnings: tmpWarnings
		});
};

module.exports = (
	{
		CONTRACT_VERSION: CONTRACT_VERSION,
		FOLDS: FOLDS,
		SELECTABLE_FOLDS: SELECTABLE_FOLDS,
		INTERVALS: INTERVALS,
		ORDERS: ORDERS,
		NUMERIC_MODES: NUMERIC_MODES,
		EXCLUDE_POLICIES: EXCLUDE_POLICIES,
		DEFAULT_EXCLUDE: DEFAULT_EXCLUDE,
		FOLD_CLAUSE_TYPE: FOLD_CLAUSE_TYPE,
		M1_CLAUSE_TYPES: M1_CLAUSE_TYPES,
		FILTER_INSTRUCTIONS: FILTER_INSTRUCTIONS,
		FILTER_STRIPPED_INSTRUCTIONS: FILTER_STRIPPED_INSTRUCTIONS,
		FILTER_OPERATOR_MAP: FILTER_OPERATOR_MAP,
		PRED_OPS: PRED_OPS,
		IDENTIFIER_PATTERN: IDENTIFIER_PATTERN,
		TOKEN_PATTERN: TOKEN_PATTERN,
		PARAM_TYPES: PARAM_TYPES,
		parseFacetID: parseFacetID,
		defaultExcludeFor: defaultExcludeFor,
		clauseTypeFor: clauseTypeFor,
		clampPositiveInteger: clampPositiveInteger,
		LIMIT_DEFAULTS: LIMIT_DEFAULTS,
		resolveLimits: resolveLimits,
		LATER_FOLDS: LATER_FOLDS,
		MILESTONE: MILESTONE,
		REQUEST_MODES: REQUEST_MODES,
		MAX_RECORDS_SORT: MAX_RECORDS_SORT,
		SORT_DIRECTIONS: SORT_DIRECTIONS,
		RESERVED_KEY_PREFIX: RESERVED_KEY_PREFIX,
		FRESHNESS_MODES: FRESHNESS_MODES,
		FRESHNESS_DEFAULTS: FRESHNESS_DEFAULTS,
		REQUEST_ENGINES: REQUEST_ENGINES,
		SEQ_PATTERN: SEQ_PATTERN,
		resolveFreshnessSettings: resolveFreshnessSettings,
		normalizeFreshness: normalizeFreshness,
		checkLimits: checkLimits,
		normalizeFacetSpec: normalizeFacetSpec,
		normalizeRequest: normalizeRequest,
		normalizeScopes: normalizeScopes,
		normalizeParams: normalizeParams,
		normalizeRecordsPage: normalizeRecordsPage,
		isLegacyPayload: isLegacyPayload,
		legacyToRequest: legacyToRequest
	});
