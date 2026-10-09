/**
 * Facet Contract - Envelope
 *
 * PURE: requires nothing outside source/contract/. Shared with pict-section-facet.
 *
 * Envelope / FacetResult / Bucket shapes (02 §4) and the pure post-processing that turns an
 * engine's RawFacetResult into a FacetResult (internal-contracts §10.4).  Engines never do
 * envelope arithmetic; this module does all of it, identically for every engine, so a Live
 * envelope and a Reference envelope built from equal raw results are deep-equal.
 *
 * Post-processing rules that are engine-independent by construction:
 *   - Groups are re-keyed through the canonical key functions and duplicates merged (an engine that
 *     groups '1' and 1 apart still yields one key).
 *   - Terms: the kept set is the first Top groups in the canonical order (Count desc, then Key asc),
 *     whatever Order asks for; Order only changes the display order of the kept set.  So an engine
 *     that returns only Top + 1 groups and one that returns every group produce the same buckets.
 *   - Missing: false folds missing rows into OtherCount (MissingCount 0) so
 *     SumOfCounts + MissingCount + OtherCount === Total always holds for bucketed folds.
 *   - Missing means NULL (and, for typed columns, a value of the wrong shape); a row outside every
 *     declared range or Edges bucket is Other, on single-dimension folds and on Pivot axes alike.
 *
 * Milestone 2 (internal-contracts §29): ChildRollup (bands 0..n, zero-filled) and ExistsSplit
 * (keys 1 then 0) buckets; multi-valued (K9) Terms report OtherCount null; path facets write the
 * clauses of FacetClauses.bucketClause §29.3; declared / path-auto facets carry Declared,
 * Definition, Path, Relaxed and Semantics (auto facets do not, so M1 envelopes are unchanged).
 *
 * @author Steven Velozo <steven@velozo.com>
 */

const libFacetErrors = require('./Facet-Contract-Errors.js');
const libFacetRequest = require('./Facet-Contract-Request.js');
const libFacetBuckets = require('./Facet-Contract-Buckets.js');
const libFacetClauses = require('./Facet-Contract-Clauses.js');
const libFacetUtil = require('./Facet-Contract-Util.js');

// Data types whose Terms keys are numbers (internal-contracts §9.2).
const NUMERIC_KEY_TYPES = libFacetBuckets.NUMERIC_KEY_TYPES;

// Fields removed by normalizeForComparison (they legitimately differ between engines/calls).
const VOLATILE_FIELDS = Object.freeze([ 'Version', 'AsOf', 'ElapsedMS', 'Engine', 'Cached', 'LagMS', 'Stale' ]);

// Folds with no buckets.
const SCALAR_FOLDS = Object.freeze([ 'Stats', 'DistinctCount', 'Missing', 'Count' ]);

// Pivot axis Dim.Kind → the single-dimension fold it mirrors.
const DIMENSION_FOLD = Object.freeze({ Column: 'Terms', DateBucket: 'DateHistogram', NumericBucket: 'NumericHistogram', Range: 'Ranges' });

// Fallbacks when the caller passes no Limits (the contract's LIMIT_DEFAULTS own the values).
const DEFAULT_TOP = libFacetRequest.LIMIT_DEFAULTS.DefaultTop;
const DEFAULT_MAX_DATE_BUCKETS = libFacetRequest.LIMIT_DEFAULTS.MaxDateBuckets;
const DEFAULT_MAX_TOP = libFacetRequest.LIMIT_DEFAULTS.MaxTop;

/**
 * Normalize a raw column value into a bucket Key (Numeric/Decimal/ID/Boolean/ForeignKey → Number;
 * everything else → String; null stays null).  Same function as FacetBuckets.normalizeKey.
 *
 * @param {any} pValue
 * @param {string} pDataType - Stricture DataType of the column
 * @return {number|string|null}
 */
const normalizeKey = libFacetBuckets.normalizeKey;

// ---------------------------------------------------------------- small helpers

const isPresent = libFacetUtil.isPresent;

const toCount = libFacetUtil.toCount;

/**
 * @param {any} pValue
 * @return {number|null} a positive integer, or null
 */
const positiveInteger = (pValue) =>
{
	return ((typeof(pValue) === 'number') && Number.isInteger(pValue) && (pValue > 0)) ? pValue : null;
};

/**
 * The Agg's first dimension (or null).
 *
 * @param {Record<string, any>} pAgg
 * @return {Record<string, any>|null}
 */
const primaryDimension = (pAgg) =>
{
	return (Array.isArray(pAgg.Dimensions) && (pAgg.Dimensions.length > 0)) ? pAgg.Dimensions[0] : null;
};

/**
 * The field a result reports: the Agg's Field, else the dimension's Field (K8) or KeyField (K9).
 *
 * @param {Record<string, any>} pAgg
 * @return {string|null}
 */
const resultField = (pAgg) =>
{
	if ((typeof(pAgg.Field) === 'string') && (pAgg.Field.length > 0))
	{
		return pAgg.Field;
	}
	let tmpDimension = primaryDimension(pAgg);
	if (tmpDimension && (pAgg.Kind !== 'Pivot'))
	{
		return tmpDimension.Field || tmpDimension.KeyField || null;
	}
	return null;
};

/**
 * Does this Agg come from a definition or a path FacetID (Origin other than 'Auto')?
 *
 * @param {Record<string, any>} pAgg
 * @return {boolean}
 */
const isDeclaredOrigin = (pAgg) =>
{
	return (typeof(pAgg.Origin) === 'string') && (pAgg.Origin.length > 0) && (pAgg.Origin !== 'Auto');
};

/**
 * The column DataType a single-field result reports.
 *
 * @param {Record<string, any>} pAgg
 * @return {string|null}
 */
const resultDataType = (pAgg) =>
{
	if ((pAgg.Kind === 'Pivot') || (pAgg.Kind === 'Count'))
	{
		return null;
	}
	if (pAgg.FieldInfo && (typeof(pAgg.FieldInfo.DataType) === 'string'))
	{
		return pAgg.FieldInfo.DataType;
	}
	let tmpDimension = primaryDimension(pAgg);
	if (tmpDimension)
	{
		if (typeof(tmpDimension.DataType) === 'string')
		{
			return tmpDimension.DataType;
		}
		if (tmpDimension.Kind === 'DateBucket')
		{
			return 'DateTime';
		}
		if ((tmpDimension.Kind === 'NumericBucket') || (tmpDimension.Kind === 'Range'))
		{
			return tmpDimension.IsInteger ? 'Numeric' : 'Decimal';
		}
	}
	return (typeof(pAgg.DataType) === 'string') ? pAgg.DataType : null;
};

/**
 * A type-tagged map key for a bucket key (so 1 and '1' stay distinct until normalized).
 *
 * @param {any} pKey
 * @return {string}
 */
const mapKey = (pKey) =>
{
	return (typeof(pKey) === 'number') ? `n:${pKey}` : `s:${pKey}`;
};

/**
 * Re-key engine groups through fKey and merge duplicates.  Groups whose key normalizes to null are
 * counted in NullCount (they belong in MissingCount; engines should not return them).
 *
 * @param {any} pGroups - [ { Key, Count } ]
 * @param {function(any): any} fKey
 * @return {{ Groups: Array<{ Key: any, Count: number }>, NullCount: number, MergedAway: number }}
 */
const mergeGroups = (pGroups, fKey) =>
{
	let tmpResult = { Groups: [], NullCount: 0, MergedAway: 0 };
	if (!Array.isArray(pGroups))
	{
		return tmpResult;
	}
	let tmpIndex = new Map();
	for (let i = 0; i < pGroups.length; i++)
	{
		let tmpGroup = pGroups[i];
		if (!tmpGroup || (typeof(tmpGroup) !== 'object'))
		{
			continue;
		}
		let tmpKey = fKey(tmpGroup.Key);
		let tmpCount = toCount(tmpGroup.Count);
		if (!isPresent(tmpKey))
		{
			tmpResult.NullCount += tmpCount;
			continue;
		}
		let tmpMapKey = mapKey(tmpKey);
		if (tmpIndex.has(tmpMapKey))
		{
			tmpIndex.get(tmpMapKey).Count += tmpCount;
			tmpResult.MergedAway++;
			continue;
		}
		let tmpEntry = { Key: tmpKey, Count: tmpCount };
		tmpIndex.set(tmpMapKey, tmpEntry);
		tmpResult.Groups.push(tmpEntry);
	}
	return tmpResult;
};

/**
 * Canonical Terms order: Count descending, then Key ascending (compareKeys).
 *
 * @param {{ Key: any, Count: number }} pA
 * @param {{ Key: any, Count: number }} pB
 * @return {number}
 */
const compareCountDesc = (pA, pB) =>
{
	if (pA.Count !== pB.Count)
	{
		return (pA.Count > pB.Count) ? -1 : 1;
	}
	return libFacetBuckets.compareKeys(pA.Key, pB.Key);
};

/**
 * The RawFacetResult MissingCount, falling back to null-key groups an engine returned.
 *
 * @param {Record<string, any>} pRaw
 * @param {number} pNullGroupCount
 * @return {number}
 */
const rawMissing = (pRaw, pNullGroupCount) =>
{
	return isPresent(pRaw.MissingCount) ? toCount(pRaw.MissingCount) : pNullGroupCount;
};

/**
 * The display strings for Excluded: each excluded conjunct's clause Hash, else its Id.
 *
 * @param {Record<string, any>} pDisjunctive - Agg.Disjunctive
 * @param {Array<Record<string, any>>} pOwnedConjuncts
 * @return {Array<string>}
 */
const excludedLabels = (pDisjunctive, pOwnedConjuncts) =>
{
	let tmpIds = Array.isArray(pDisjunctive.Excluded) ? pDisjunctive.Excluded : [];
	let tmpHashes = Array.isArray(pDisjunctive.ExcludedHashes) ? pDisjunctive.ExcludedHashes : [];
	let tmpById = {};
	(Array.isArray(pOwnedConjuncts) ? pOwnedConjuncts : []).forEach(
		(pConjunct) =>
		{
			if (pConjunct && (typeof(pConjunct.Id) === 'string'))
			{
				tmpById[pConjunct.Id] = pConjunct;
			}
		});
	return tmpIds.map(
		(pId, pIndex) =>
		{
			let tmpConjunct = tmpById[pId];
			if (tmpConjunct && tmpConjunct.Origin && (typeof(tmpConjunct.Origin.Hash) === 'string') && (tmpConjunct.Origin.Hash.length > 0))
			{
				return tmpConjunct.Origin.Hash;
			}
			if ((tmpHashes.length === tmpIds.length) && (typeof(tmpHashes[pIndex]) === 'string') && (tmpHashes[pIndex].length > 0))
			{
				return tmpHashes[pIndex];
			}
			return pId;
		});
};

/**
 * Finish a bucket: Selected, Clause, Selection (in the 02 §4.4 field order).
 *
 * @param {Record<string, any>} pAgg
 * @param {Record<string, any>} pMeta - { Fold, Field, FilterKey, DataType } for bucketClause
 * @param {Record<string, any>} pSelected - from FacetClauses.selectedFrom
 * @param {Record<string, any>} pBucket - { Key, Label, Count, Start?, End?, EndExclusive? }
 * @return {Record<string, any>}
 */
const finishBucket = (pAgg, pMeta, pSelected, pBucket) =>
{
	let tmpBucket = { Key: pBucket.Key, Label: pBucket.Label, Count: pBucket.Count, Selected: libFacetClauses.bucketSelected(pAgg, pSelected, pBucket) };
	if (isPresent(pBucket.Start))
	{
		tmpBucket.Start = pBucket.Start;
	}
	if (isPresent(pBucket.End))
	{
		tmpBucket.End = pBucket.End;
	}
	if (typeof(pBucket.EndExclusive) === 'boolean')
	{
		tmpBucket.EndExclusive = pBucket.EndExclusive;
	}
	if (!pAgg.Selectable || (pBucket.ClauseSpan === false))
	{
		tmpBucket.Clause = null;
	}
	else if (pBucket.ClauseSpan && (typeof(pBucket.ClauseSpan) === 'object'))
	{
		// The rows a bucket really holds differ from its declared span (an overlapped range).
		tmpBucket.Clause = libFacetClauses.bucketClause(pMeta, Object.assign({}, tmpBucket, pBucket.ClauseSpan));
	}
	else
	{
		tmpBucket.Clause = libFacetClauses.bucketClause(pMeta, tmpBucket);
	}
	if (pAgg.Selectable)
	{
		tmpBucket.Selection = { Facet: pAgg.FacetID, Key: pBucket.Key };
	}
	return tmpBucket;
};

/**
 * The Chart projection of a bucket list.
 *
 * @param {Array<Record<string, any>>} pBuckets
 * @param {string} pLabel
 * @return {{ Labels: Array<string>, Datasets: Array<{ label: string, data: Array<number> }> }}
 */
const bucketChart = (pBuckets, pLabel) =>
{
	return (
		{
			Labels: pBuckets.map((pBucket) => { return pBucket.Label; }),
			Datasets: [ { label: pLabel, data: pBuckets.map((pBucket) => { return pBucket.Count; }) } ]
		});
};

// ---------------------------------------------------------------- per-kind post-processing

/**
 * Terms (K1).
 *
 * @param {Record<string, any>} pResult - FacetResult being built
 * @param {Record<string, any>} pAgg
 * @param {Record<string, any>} pRaw
 * @param {Record<string, any>} pContext - { Limits, Selected, Meta, ReportMissing }
 */
const postTerms = (pResult, pAgg, pRaw, pContext) =>
{
	let tmpDataType = pResult.DataType;
	let tmpMerged = mergeGroups(pRaw.Groups, (pKey) => { return normalizeKey(pKey, tmpDataType); });
	let tmpSorted = tmpMerged.Groups.slice().sort(compareCountDesc);
	let tmpDistinct = (typeof(pRaw.DistinctKeys) === 'number') ? Math.max(tmpSorted.length, pRaw.DistinctKeys - tmpMerged.MergedAway) : tmpSorted.length;
	let tmpTop = positiveInteger(pAgg.Top) || positiveInteger(pContext.Limits.DefaultTop) || DEFAULT_TOP;

	let tmpKept = tmpSorted.slice(0, tmpTop);
	pResult.Truncated = (tmpSorted.length > tmpTop) || (tmpDistinct > tmpTop);
	pResult.TruncatedReason = pResult.Truncated ? 'Top' : null;
	if (pAgg.Order === 'KeyAsc')
	{
		tmpKept.sort((pA, pB) => { return libFacetBuckets.compareKeys(pA.Key, pB.Key); });
	}
	else if (pAgg.Order === 'KeyDesc')
	{
		tmpKept.sort((pA, pB) => { return libFacetBuckets.compareKeys(pB.Key, pA.Key); });
	}

	let tmpBuckets = tmpKept.map(
		(pGroup) =>
		{
			return finishBucket(pAgg, pContext.Meta, pContext.Selected, { Key: pGroup.Key, Label: String(pGroup.Key), Count: pGroup.Count });
		});

	// Selected keys always come back (01 §8.3): a selected key outside the kept set is appended with
	// the count the engine returned for it, else 0.
	let tmpAppended = pContext.Selected.Keys.filter(
		(pKey) => { return !tmpKept.some((pGroup) => { return libFacetBuckets.compareKeys(pGroup.Key, pKey) === 0; }); });
	tmpAppended.sort(libFacetBuckets.compareKeys);
	for (let i = 0; i < tmpAppended.length; i++)
	{
		let tmpReturned = tmpSorted.find((pGroup) => { return libFacetBuckets.compareKeys(pGroup.Key, tmpAppended[i]) === 0; });
		let tmpBucket = finishBucket(pAgg, pContext.Meta, pContext.Selected, { Key: tmpAppended[i], Label: String(tmpAppended[i]), Count: tmpReturned ? tmpReturned.Count : 0 });
		tmpBucket.Selected = true;
		tmpBuckets.push(tmpBucket);
	}

	pResult.DistinctCount = tmpDistinct;
	pResult.Buckets = tmpBuckets;
	pResult.MissingCount = pContext.ReportMissing ? rawMissing(pRaw, tmpMerged.NullCount) : 0;
};

/**
 * DateHistogram (K2): gap fill between the bucket keys of Bounds, half-open buckets.
 *
 * @param {Record<string, any>} pResult
 * @param {Record<string, any>} pAgg
 * @param {Record<string, any>} pRaw
 * @param {Record<string, any>} pContext
 */
const postDateHistogram = (pResult, pAgg, pRaw, pContext) =>
{
	let tmpDimension = primaryDimension(pAgg) || {};
	let tmpInterval = tmpDimension.Interval || 'month';
	let tmpMaxDateBuckets = positiveInteger(pContext.Limits.MaxDateBuckets) || DEFAULT_MAX_DATE_BUCKETS;
	let tmpMerged = mergeGroups(pRaw.Groups, (pKey) => { return libFacetBuckets.normalizeDateKey(pKey, tmpInterval); });
	let tmpCounts = new Map();
	tmpMerged.Groups.forEach((pGroup) => { tmpCounts.set(pGroup.Key, pGroup.Count); });

	let tmpBounds = null;
	if (pRaw.Bounds && isPresent(pRaw.Bounds.Lo) && isPresent(pRaw.Bounds.Hi))
	{
		tmpBounds = { Lo: libFacetBuckets.canonicalDateTime(pRaw.Bounds.Lo), Hi: libFacetBuckets.canonicalDateTime(pRaw.Bounds.Hi) };
		if ((tmpBounds.Lo === null) || (tmpBounds.Hi === null))
		{
			tmpBounds = null;
		}
	}

	let tmpKeys = tmpMerged.Groups.map((pGroup) => { return pGroup.Key; });
	if (pAgg.EmptyBuckets !== false)
	{
		let tmpLo = tmpBounds ? tmpBounds.Lo : null;
		let tmpHi = tmpBounds ? tmpBounds.Hi : null;
		for (let i = 0; i < tmpKeys.length; i++)
		{
			tmpLo = ((tmpLo === null) || (libFacetBuckets.compareDateKeys(tmpKeys[i], tmpLo) < 0)) ? tmpKeys[i] : tmpLo;
			tmpHi = ((tmpHi === null) || (libFacetBuckets.compareDateKeys(tmpKeys[i], tmpHi) > 0)) ? tmpKeys[i] : tmpHi;
		}
		if (tmpLo !== null)
		{
			tmpKeys = libFacetBuckets.fillDateKeys(tmpLo, tmpHi, tmpInterval, tmpMaxDateBuckets);
		}
	}
	tmpKeys.sort(libFacetBuckets.compareDateKeys);
	if (tmpKeys.length > tmpMaxDateBuckets)
	{
		throw libFacetErrors.create('FACET_INTERVAL_TOO_FINE', null,
			{ Interval: tmpInterval, MaxDateBuckets: tmpMaxDateBuckets, Suggest: { Interval: libFacetBuckets.coarserInterval(tmpInterval) } });
	}
	if (pAgg.Order === 'KeyDesc')
	{
		tmpKeys.reverse();
	}

	pResult.Interval = tmpInterval;
	pResult.TimeZone = pContext.StorageTimeZone;
	pResult.Bounds = tmpBounds;
	pResult.Buckets = tmpKeys.map(
		(pKey) =>
		{
			return finishBucket(pAgg, pContext.Meta, pContext.Selected,
				{
					Key: pKey,
					Label: libFacetBuckets.dateLabel(pKey, tmpInterval),
					Count: tmpCounts.has(pKey) ? tmpCounts.get(pKey) : 0,
					Start: pKey,
					End: libFacetBuckets.nextDateKey(pKey, tmpInterval),
					EndExclusive: true
				});
		});
	pResult.MissingCount = pContext.ReportMissing ? rawMissing(pRaw, tmpMerged.NullCount) : 0;
};

/**
 * NumericHistogram (K3): one bucket per index 0..N−1, zero-filled.
 *
 * @param {Record<string, any>} pResult
 * @param {Record<string, any>} pAgg
 * @param {Record<string, any>} pRaw
 * @param {Record<string, any>} pContext
 */
const postNumericHistogram = (pResult, pAgg, pRaw, pContext) =>
{
	let tmpDimension = primaryDimension(pAgg) || {};
	let tmpBounds = (pRaw.Bounds && isPresent(pRaw.Bounds.Lo) && isPresent(pRaw.Bounds.Hi))
		? { Lo: Number(pRaw.Bounds.Lo), Hi: Number(pRaw.Bounds.Hi) }
		: null;
	let tmpGeometry = pRaw.Geometry;
	if (!tmpGeometry || !Array.isArray(tmpGeometry.Edges) || (typeof(tmpGeometry.N) !== 'number'))
	{
		if (tmpDimension.Mode === 'Edges')
		{
			tmpGeometry = libFacetBuckets.edgesGeometry(tmpDimension.Edges, tmpDimension.OpenEnded, tmpDimension.Scale);
		}
		else
		{
			tmpGeometry = libFacetBuckets.numericGeometry(tmpBounds ? tmpBounds.Lo : null, tmpBounds ? tmpBounds.Hi : null,
				tmpDimension.Buckets || pContext.Limits.DefaultBuckets, tmpDimension.Scale, pContext.Limits.MaxBuckets);
		}
	}
	let tmpMerged = mergeGroups(pRaw.Groups,
		(pKey) =>
		{
			let tmpIndex = Number(pKey);
			return (isPresent(pKey) && Number.isInteger(tmpIndex) && (tmpIndex >= 0) && (tmpIndex < tmpGeometry.N)) ? tmpIndex : null;
		});
	let tmpCounts = new Map();
	tmpMerged.Groups.forEach((pGroup) => { tmpCounts.set(pGroup.Key, pGroup.Count); });

	let tmpBuckets = [];
	for (let i = 0; i < tmpGeometry.N; i++)
	{
		let tmpSpan = libFacetBuckets.numericBucketBounds(tmpGeometry, i);
		tmpBuckets.push(finishBucket(pAgg, pContext.Meta, pContext.Selected,
			{
				Key: i,
				Label: libFacetBuckets.numericLabel(tmpGeometry, i, !!tmpDimension.IsInteger),
				Count: tmpCounts.has(i) ? tmpCounts.get(i) : 0,
				Start: tmpSpan.Start,
				End: tmpSpan.End,
				EndExclusive: tmpSpan.EndExclusive
			}));
	}
	if (pAgg.Order === 'KeyDesc')
	{
		tmpBuckets.reverse();
	}
	pResult.Bounds = tmpBounds;
	pResult.Geometry =
		{
			Mode: tmpGeometry.Mode,
			Lo: isPresent(tmpGeometry.Lo) ? tmpGeometry.Lo : null,
			Hi: isPresent(tmpGeometry.Hi) ? tmpGeometry.Hi : null,
			Width: isPresent(tmpGeometry.Width) ? tmpGeometry.Width : null,
			N: tmpGeometry.N,
			Scale: tmpGeometry.Scale,
			Edges: tmpGeometry.Edges.slice()
		};
	if (tmpGeometry.Mode === 'Edges')
	{
		pResult.Geometry.OpenEnded = !!tmpGeometry.OpenEnded;
	}
	pResult.Buckets = tmpBuckets;
	// Null keys here are values outside an Edges geometry, not NULLs: they stay in OtherCount.
	pResult.MissingCount = pContext.ReportMissing ? toCount(pRaw.MissingCount) : 0;
};

/**
 * The span of values a declared range really collects under CASE (first match) semantics: its own
 * [From, To) minus every earlier range.  Returns null when that is the declared span itself, an
 * object { Start, End } when it is one smaller interval (the bucket Clause then selects exactly the
 * bucket's rows), or false when it is empty or split in two (no single NumericRange clause
 * expresses it; the bucket keeps its Selection but gets Clause null, 02 §4.3).
 *
 * @param {Array<{ From: number|null, To: number|null }>} pRanges
 * @param {number} pIndex
 * @return {{ Start: number|null, End: number|null }|false|null}
 */
const effectiveRangeSpan = (pRanges, pIndex) =>
{
	let fLo = (pRange) => { return isPresent(pRange.From) ? pRange.From : -Infinity; };
	let fHi = (pRange) => { return isPresent(pRange.To) ? pRange.To : Infinity; };
	let tmpPieces = [ [ fLo(pRanges[pIndex]), fHi(pRanges[pIndex]) ] ];
	for (let j = 0; j < pIndex; j++)
	{
		let tmpCutLo = fLo(pRanges[j]);
		let tmpCutHi = fHi(pRanges[j]);
		let tmpNext = [];
		for (let k = 0; k < tmpPieces.length; k++)
		{
			let tmpLo = tmpPieces[k][0];
			let tmpHi = tmpPieces[k][1];
			if ((tmpCutHi <= tmpLo) || (tmpCutLo >= tmpHi))
			{
				tmpNext.push(tmpPieces[k]);
				continue;
			}
			if (tmpLo < tmpCutLo)
			{
				tmpNext.push([ tmpLo, tmpCutLo ]);
			}
			if (tmpCutHi < tmpHi)
			{
				tmpNext.push([ tmpCutHi, tmpHi ]);
			}
		}
		tmpPieces = tmpNext;
	}
	if (tmpPieces.length !== 1)
	{
		return false;
	}
	if ((tmpPieces[0][0] === fLo(pRanges[pIndex])) && (tmpPieces[0][1] === fHi(pRanges[pIndex])))
	{
		return null;
	}
	return (
		{
			Start: (tmpPieces[0][0] === -Infinity) ? null : tmpPieces[0][0],
			End: (tmpPieces[0][1] === Infinity) ? null : tmpPieces[0][1]
		});
};

/**
 * Ranges (K4): one bucket per declared range, zero-filled, in declared order.  A range that
 * overlaps an earlier one collects only what the earlier ranges left (CASE semantics); its Clause
 * selects exactly that (effectiveRangeSpan).
 *
 * @param {Record<string, any>} pResult
 * @param {Record<string, any>} pAgg
 * @param {Record<string, any>} pRaw
 * @param {Record<string, any>} pContext
 */
const postRanges = (pResult, pAgg, pRaw, pContext) =>
{
	let tmpDimension = primaryDimension(pAgg) || {};
	let tmpRanges = Array.isArray(tmpDimension.Ranges) ? tmpDimension.Ranges : [];
	let tmpMerged = mergeGroups(pRaw.Groups, (pKey) => { return isPresent(pKey) ? String(pKey) : null; });
	// Range Keys are client-chosen: a Map, never a plain object.
	let tmpCounts = new Map();
	tmpMerged.Groups.forEach((pGroup) => { tmpCounts.set(pGroup.Key, pGroup.Count); });
	pResult.Buckets = tmpRanges.map(
		(pRange, pIndex) =>
		{
			let tmpBucket =
				{
					Key: pRange.Key,
					Label: libFacetBuckets.rangeLabel(pRange, !!tmpDimension.IsInteger),
					Count: tmpCounts.has(pRange.Key) ? tmpCounts.get(pRange.Key) : 0,
					Start: isPresent(pRange.From) ? pRange.From : null,
					End: isPresent(pRange.To) ? pRange.To : null,
					EndExclusive: true
				};
			let tmpSpan = effectiveRangeSpan(tmpRanges, pIndex);
			if (tmpSpan !== null)
			{
				tmpBucket.ClauseSpan = tmpSpan;
			}
			return finishBucket(pAgg, pContext.Meta, pContext.Selected, tmpBucket);
		});
	pResult.MissingCount = pContext.ReportMissing ? toCount(pRaw.MissingCount) : 0;
};

/**
 * ChildRollup (K12, internal-contracts §29.2): every band 0..n (zero-filled) in band order; band 0
 * is 'None' (no visible matching child), integer bands 'a–(b−1)', the open band 'a+'; Start / End
 * are the band edges (band 0 has none); never a Clause (Selection only in M2).
 *
 * @param {Record<string, any>} pResult
 * @param {Record<string, any>} pAgg
 * @param {Record<string, any>} pRaw
 * @param {Record<string, any>} pContext
 */
const postChildRollup = (pResult, pAgg, pRaw, pContext) =>
{
	let tmpDimension = primaryDimension(pAgg) || {};
	let tmpEdges = Array.isArray(tmpDimension.Edges) ? tmpDimension.Edges : [];
	if (!libFacetBuckets.isBandEdges(tmpEdges))
	{
		throw libFacetErrors.create('FACET_INTERNAL', 'A ChildRollup needs ascending positive integer Edges.');
	}
	let tmpLabels = libFacetUtil.isPlainObject(tmpDimension.Labels) ? tmpDimension.Labels : (libFacetUtil.isPlainObject(pAgg.Labels) ? pAgg.Labels : null);
	let tmpMerged = mergeGroups(pRaw.Groups,
		(pKey) =>
		{
			let tmpBand = libFacetUtil.toFiniteNumber(pKey);
			return ((tmpBand !== null) && Number.isInteger(tmpBand) && (tmpBand >= 0) && (tmpBand <= tmpEdges.length)) ? tmpBand : null;
		});
	let tmpCounts = new Map();
	tmpMerged.Groups.forEach((pGroup) => { tmpCounts.set(pGroup.Key, pGroup.Count); });
	let tmpBuckets = [];
	for (let i = 0; i <= tmpEdges.length; i++)
	{
		let tmpBounds = libFacetBuckets.bandBounds(tmpEdges, i) || {};
		tmpBuckets.push(finishBucket(pAgg, pContext.Meta, pContext.Selected,
			{
				Key: i,
				Label: libFacetBuckets.bandLabel(tmpEdges, i, tmpLabels),
				Count: tmpCounts.has(i) ? tmpCounts.get(i) : 0,
				Start: tmpBounds.Start,
				End: tmpBounds.End,
				EndExclusive: tmpBounds.EndExclusive,
				ClauseSpan: false
			}));
	}
	if (pAgg.Order === 'KeyDesc')
	{
		tmpBuckets.reverse();
	}
	pResult.Buckets = tmpBuckets;
	pResult.MissingCount = pContext.ReportMissing ? toCount(pRaw.MissingCount) : 0;
};

/**
 * ExistsSplit (K20, internal-contracts §29.2): Key 1 (a visible match exists) then Key 0, labels
 * from the definition (default 'Yes' / 'No'); never a Clause (Selection only in M2).
 *
 * @param {Record<string, any>} pResult
 * @param {Record<string, any>} pAgg
 * @param {Record<string, any>} pRaw
 * @param {Record<string, any>} pContext
 */
const postExistsSplit = (pResult, pAgg, pRaw, pContext) =>
{
	let tmpDimension = primaryDimension(pAgg) || {};
	let tmpLabels = libFacetUtil.isPlainObject(tmpDimension.Labels) ? tmpDimension.Labels : (libFacetUtil.isPlainObject(pAgg.Labels) ? pAgg.Labels : null);
	let tmpMerged = mergeGroups(pRaw.Groups, libFacetBuckets.existsSplitKey);
	let tmpCounts = new Map();
	tmpMerged.Groups.forEach((pGroup) => { tmpCounts.set(pGroup.Key, pGroup.Count); });
	pResult.Buckets = libFacetBuckets.EXISTS_SPLIT_KEYS.map(
		(pKey) =>
		{
			return finishBucket(pAgg, pContext.Meta, pContext.Selected,
				{
					Key: pKey,
					Label: libFacetBuckets.existsSplitLabel(pKey, tmpLabels),
					Count: tmpCounts.has(pKey) ? tmpCounts.get(pKey) : 0,
					ClauseSpan: false
				});
		});
	pResult.MissingCount = pContext.ReportMissing ? toCount(pRaw.MissingCount) : 0;
};

/**
 * Stats (K5): exact integer-unit sums, formatted per internal-contracts §10.2.
 *
 * @param {Record<string, any>} pResult
 * @param {Record<string, any>} pAgg
 * @param {Record<string, any>} pRaw
 */
const postStats = (pResult, pAgg, pRaw) =>
{
	let tmpRawStats = pRaw.Stats || {};
	let tmpInfo = pAgg.FieldInfo || primaryDimension(pAgg) || {};
	let tmpRows = isPresent(tmpRawStats.Rows) ? toCount(tmpRawStats.Rows) : toCount(pRaw.Total);
	let tmpNonNull = toCount(tmpRawStats.NonNull);
	let tmpStats = { Rows: tmpRows, NonNull: tmpNonNull, Min: null, Max: null, Sum: null, Avg: null };
	if (tmpNonNull > 0)
	{
		if (pResult.DataType === 'DateTime')
		{
			tmpStats.Min = libFacetBuckets.canonicalDateTime(tmpRawStats.Min);
			tmpStats.Max = libFacetBuckets.canonicalDateTime(tmpRawStats.Max);
		}
		else
		{
			let tmpIsInteger = !!tmpInfo.IsInteger;
			let tmpScale = tmpIsInteger ? 0 : (Number.isInteger(tmpInfo.Scale) ? tmpInfo.Scale : 0);
			let tmpFactor = Math.pow(10, tmpScale);
			let tmpSumUnits = toCount(tmpRawStats.SumUnits);
			let tmpMinUnits = libFacetBuckets.units(tmpRawStats.Min, tmpScale);
			let tmpMaxUnits = libFacetBuckets.units(tmpRawStats.Max, tmpScale);
			if (tmpIsInteger)
			{
				tmpStats.Min = tmpMinUnits;
				tmpStats.Max = tmpMaxUnits;
				tmpStats.Sum = tmpSumUnits;
			}
			else
			{
				tmpStats.Min = (tmpMinUnits === null) ? null : libFacetBuckets.formatUnits(tmpMinUnits, tmpScale);
				tmpStats.Max = (tmpMaxUnits === null) ? null : libFacetBuckets.formatUnits(tmpMaxUnits, tmpScale);
				tmpStats.Sum = libFacetBuckets.formatUnits(tmpSumUnits, tmpScale);
			}
			tmpStats.Avg = Number((tmpSumUnits / tmpNonNull / tmpFactor).toFixed(tmpScale + 4));
		}
	}
	pResult.Total = tmpRows;
	pResult.MissingCount = isPresent(tmpRawStats.Rows) ? (tmpRows - tmpNonNull) : toCount(pRaw.MissingCount);
	pResult.Stats = tmpStats;
};

/**
 * The key of a pivot axis value, computed exactly as the axis's single-dimension fold computes it.
 * A Range axis value in no declared range arrives as NO_RANGE_KEY and stays that key.
 *
 * @param {Record<string, any>} pDimension
 * @param {any} pValue
 * @return {any}
 */
const pivotAxisKey = (pDimension, pValue) =>
{
	if (!isPresent(pValue))
	{
		return null;
	}
	switch (pDimension.Kind)
	{
		case 'DateBucket':
			return libFacetBuckets.normalizeDateKey(pValue, pDimension.Interval || 'month');
		case 'Range':
			return String(pValue);
		case 'NumericBucket':
			return normalizeKey(pValue, 'Numeric');
		default:
			return normalizeKey(pValue, pDimension.DataType);
	}
};

/**
 * The display label of a pivot axis key.
 *
 * @param {Record<string, any>} pDimension
 * @param {any} pKey
 * @return {string}
 */
const pivotAxisLabel = (pDimension, pKey) =>
{
	if (pDimension.Kind === 'DateBucket')
	{
		return libFacetBuckets.dateLabel(pKey, pDimension.Interval || 'month');
	}
	if ((pDimension.Kind === 'Range') && Array.isArray(pDimension.Ranges))
	{
		let tmpRange = pDimension.Ranges.find((pRange) => { return pRange.Key === pKey; });
		if (tmpRange)
		{
			return libFacetBuckets.rangeLabel(tmpRange, !!pDimension.IsInteger);
		}
	}
	return String(pKey);
};

/**
 * Keep the top keys of one pivot axis by marginal, then order them for display (Column axes by
 * Order, date axes by key, range axes in declared order).
 *
 * @param {Record<string, any>} pDimension
 * @param {Map<string, { Key: any, Count: number }>} pMarginals - mapKey → { Key, Count }
 * @param {number} pTop
 * @param {string|null} pOrder
 * @return {{ Keys: Array<any>, Truncated: boolean }}
 */
const pivotAxisKeys = (pDimension, pMarginals, pTop, pOrder) =>
{
	let tmpAll = Array.from(pMarginals.values()).sort(compareCountDesc);
	let tmpKept = tmpAll.slice(0, pTop);
	if (pDimension.Kind === 'DateBucket')
	{
		tmpKept.sort((pA, pB) => { return libFacetBuckets.compareDateKeys(pA.Key, pB.Key); });
	}
	else if ((pDimension.Kind === 'Range') && Array.isArray(pDimension.Ranges))
	{
		let tmpOrder = pDimension.Ranges.map((pRange) => { return pRange.Key; });
		tmpKept.sort((pA, pB) => { return tmpOrder.indexOf(pA.Key) - tmpOrder.indexOf(pB.Key); });
	}
	else if (pOrder === 'KeyAsc')
	{
		tmpKept.sort((pA, pB) => { return libFacetBuckets.compareKeys(pA.Key, pB.Key); });
	}
	else if (pOrder === 'KeyDesc')
	{
		tmpKept.sort((pA, pB) => { return libFacetBuckets.compareKeys(pB.Key, pA.Key); });
	}
	return { Keys: tmpKept.map((pEntry) => { return pEntry.Key; }), Truncated: tmpAll.length > pTop };
};

/**
 * Pivot (K14): marginals, Top per axis by marginal, cells restricted to kept keys.  A cell with a
 * NULL key on either axis is MissingCount; a cell whose Range axis value fell in no declared range
 * (NO_RANGE_KEY) is OtherCount, exactly as the single-dimension Ranges fold counts that row.
 * Marginals are over the cells with both keys real (so the two marginal sums are equal), reported
 * for the kept keys; Marginals.Total is the sum of the shown cells (= SumOfCounts).
 *
 * The result fields sit at the FacetResult top level (02 §4.3): Dimensions, RowKeys, ColumnKeys,
 * Cells: [ { K1, K2, Count } ], Marginals: { Rows, Columns, Total }.
 *
 * @param {Record<string, any>} pResult
 * @param {Record<string, any>} pAgg
 * @param {Record<string, any>} pRaw
 * @param {Record<string, any>} pContext
 */
const postPivot = (pResult, pAgg, pRaw, pContext) =>
{
	let tmpDimensions = Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions : [];
	if (tmpDimensions.length !== 2)
	{
		throw libFacetErrors.create('FACET_INTERNAL', 'A Pivot needs exactly two dimensions.');
	}
	let tmpCells = new Map();
	let tmpMissing = 0;
	let tmpRowMarginals = new Map();
	let tmpColumnMarginals = new Map();
	let fMarginal = (pMarginals, pKey, pCount) =>
	{
		let tmpMapKey = mapKey(pKey);
		if (!pMarginals.has(tmpMapKey))
		{
			pMarginals.set(tmpMapKey, { Key: pKey, Count: 0 });
		}
		pMarginals.get(tmpMapKey).Count += pCount;
	};
	(Array.isArray(pRaw.Cells) ? pRaw.Cells : []).forEach(
		(pCell) =>
		{
			if (!pCell || !Array.isArray(pCell.Keys))
			{
				return;
			}
			let tmpK1 = pivotAxisKey(tmpDimensions[0], pCell.Keys[0]);
			let tmpK2 = pivotAxisKey(tmpDimensions[1], pCell.Keys[1]);
			let tmpCount = toCount(pCell.Count);
			if (!isPresent(tmpK1) || !isPresent(tmpK2))
			{
				tmpMissing += tmpCount;
				return;
			}
			if ((tmpK1 === libFacetBuckets.NO_RANGE_KEY) || (tmpK2 === libFacetBuckets.NO_RANGE_KEY))
			{
				// In no declared range: OtherCount (by the Total − Sum − Missing identity).
				return;
			}
			let tmpCellKey = `${mapKey(tmpK1)}|${mapKey(tmpK2)}`;
			if (!tmpCells.has(tmpCellKey))
			{
				tmpCells.set(tmpCellKey, { K1: tmpK1, K2: tmpK2, Count: 0 });
			}
			tmpCells.get(tmpCellKey).Count += tmpCount;
			fMarginal(tmpRowMarginals, tmpK1, tmpCount);
			fMarginal(tmpColumnMarginals, tmpK2, tmpCount);
		});

	let tmpTop = positiveInteger(pAgg.Top) || positiveInteger(pContext.Limits.MaxTop) || DEFAULT_MAX_TOP;
	let tmpRows = pivotAxisKeys(tmpDimensions[0], tmpRowMarginals, tmpTop, pAgg.Order);
	let tmpColumns = pivotAxisKeys(tmpDimensions[1], tmpColumnMarginals, tmpTop, pAgg.Order);
	let tmpShownCells = [];
	let tmpSum = 0;
	for (let i = 0; i < tmpRows.Keys.length; i++)
	{
		for (let j = 0; j < tmpColumns.Keys.length; j++)
		{
			let tmpCell = tmpCells.get(`${mapKey(tmpRows.Keys[i])}|${mapKey(tmpColumns.Keys[j])}`);
			if (tmpCell)
			{
				tmpShownCells.push({ K1: tmpCell.K1, K2: tmpCell.K2, Count: tmpCell.Count });
				tmpSum += tmpCell.Count;
			}
		}
	}
	let tmpFacetIDs = Array.isArray(pAgg.FacetIDs) ? pAgg.FacetIDs : [];
	pResult.Dimensions = tmpDimensions.map(
		(pDimension, pIndex) =>
		{
			return (
				{
					Facet: tmpFacetIDs[pIndex] || null,
					Field: pDimension.Field || null,
					Fold: DIMENSION_FOLD[pDimension.Kind] || null,
					Interval: (pDimension.Kind === 'DateBucket') ? (pDimension.Interval || 'month') : null
				});
		});
	pResult.RowKeys = tmpRows.Keys;
	pResult.ColumnKeys = tmpColumns.Keys;
	pResult.Cells = tmpShownCells;
	pResult.Marginals =
		{
			Rows: tmpRows.Keys.map((pKey) => { return { Key: pKey, Count: tmpRowMarginals.get(mapKey(pKey)).Count }; }),
			Columns: tmpColumns.Keys.map((pKey) => { return { Key: pKey, Count: tmpColumnMarginals.get(mapKey(pKey)).Count }; }),
			Total: tmpSum
		};
	pResult.Truncated = tmpRows.Truncated || tmpColumns.Truncated;
	pResult.TruncatedReason = pResult.Truncated ? 'Top' : null;
	pResult.MissingCount = pContext.ReportMissing ? tmpMissing : 0;
	pResult.SumOfCounts = tmpSum;
	pContext.PivotLabels =
		{
			Rows: tmpRows.Keys.map((pKey) => { return pivotAxisLabel(tmpDimensions[0], pKey); }),
			Columns: tmpColumns.Keys.map((pKey) => { return pivotAxisLabel(tmpDimensions[1], pKey); })
		};
};

// ---------------------------------------------------------------- public builders

/**
 * An empty FacetResult skeleton for an Agg (identity fields filled, counts zero, every M1 field present).
 *
 * @param {Record<string, any>} pAgg - internal-contracts §5.1
 * @return {Record<string, any>}
 */
const emptyFacetResult = (pAgg) =>
{
	let tmpDisjunctive = pAgg.Disjunctive || {};
	let tmpResult =
		{
			Key: pAgg.Key,
			Facet: (Array.isArray(pAgg.FacetIDs) && (pAgg.FacetIDs.length > 1)) ? pAgg.FacetIDs.slice() : (pAgg.FacetID || null),
			Field: resultField(pAgg),
			Fold: pAgg.Kind,
			DisplayName: pAgg.DisplayName || null,
			DataType: resultDataType(pAgg),
			Selectable: !!pAgg.Selectable,
			ClauseType: pAgg.ClauseType || null,
			FilterKey: pAgg.FilterKey || null,
			Engine: null,
			Exact: true,
			AsOf: null,
			LagMS: 0,
			Stale: false,
			Cached: false,
			Disjunctive: tmpDisjunctive.Mode || 'NotApplicable',
			Excluded: [],
			KeptMixed: Array.isArray(tmpDisjunctive.KeptMixed) ? tmpDisjunctive.KeptMixed.slice() : [],
			CountMode: pAgg.CountMode || 'Rows',
			Total: 0,
			SumOfCounts: 0,
			MissingCount: 0,
			OtherCount: 0,
			MultiValued: (pAgg.MultiValued === true),
			Truncated: false,
			TruncatedReason: null,
			DistinctCount: null,
			Bounds: null,
			Buckets: [],
			Stats: null,
			Geometry: null,
			Chart: null
		};
	if (!isDeclaredOrigin(pAgg))
	{
		return tmpResult;
	}
	// internal-contracts §29.1: only on declared / sibling / path-auto facets.
	let tmpDefinition = libFacetUtil.isPlainObject(pAgg.Definition) ? pAgg.Definition : null;
	let tmpDeclared =
		{
			Declared: (pAgg.Origin === 'Declared') || (pAgg.Origin === 'Sibling'),
			Definition: tmpDefinition ? { Facet: tmpDefinition.Facet || null, Version: isPresent(tmpDefinition.Version) ? tmpDefinition.Version : null } : null,
			Path: (Array.isArray(pAgg.Path) && (pAgg.Path.length > 0)) ? pAgg.Path.slice() : null,
			Relaxed: (pAgg.Relaxed === true),
			Semantics: (typeof(pAgg.Semantics) === 'string') ? pAgg.Semantics : null
		};
	// Insert after CountMode (02 §4.3 field order; deep-equal ignores order).
	let tmpOrdered = {};
	Object.keys(tmpResult).forEach(
		(pKey) =>
		{
			tmpOrdered[pKey] = tmpResult[pKey];
			if (pKey === 'CountMode')
			{
				Object.assign(tmpOrdered, tmpDeclared);
			}
		});
	return tmpOrdered;
};

/**
 * Turn an engine RawFacetResult into a FacetResult (internal-contracts §10.4).
 *
 * @param {Record<string, any>} pAgg - the Agg (internal-contracts §5.1)
 * @param {Record<string, any>} pRaw - RawFacetResult (internal-contracts §9.2)
 * @param {{ Engine: string, AsOf: string, Exact: boolean, Limits: Record<string, any>, StorageTimeZone: string, OwnedConjuncts: Array<Record<string, any>>, DisplayName?: string }} pPost
 * @return {Record<string, any>} FacetResult (throws a FacetError for this facet, e.g. FACET_INTERVAL_TOO_FINE)
 */
const buildFacetResult = (pAgg, pRaw, pPost) =>
{
	if (!pAgg || (typeof(pAgg) !== 'object'))
	{
		throw libFacetErrors.create('FACET_INTERNAL', 'buildFacetResult needs an Agg.');
	}
	if (!pRaw || (typeof(pRaw) !== 'object'))
	{
		throw libFacetErrors.create('FACET_INTERNAL', 'buildFacetResult needs a raw result.');
	}
	let tmpPost = pPost || {};
	let tmpResult = emptyFacetResult(pAgg);
	tmpResult.Engine = tmpPost.Engine || null;
	tmpResult.Exact = (tmpPost.Exact !== false);
	tmpResult.AsOf = tmpPost.AsOf || null;
	tmpResult.DisplayName = tmpPost.DisplayName || tmpResult.DisplayName;
	tmpResult.Excluded = excludedLabels(pAgg.Disjunctive || {}, tmpPost.OwnedConjuncts);
	tmpResult.Total = toCount(pRaw.Total);

	let tmpContext =
		{
			Limits: tmpPost.Limits || {},
			StorageTimeZone: tmpPost.StorageTimeZone || 'UTC',
			Selected: libFacetClauses.selectedFrom(pAgg, tmpPost.OwnedConjuncts),
			Meta:
				{
					Fold: pAgg.Kind,
					Field: resultField(pAgg),
					FilterKey: pAgg.FilterKey,
					DataType: tmpResult.DataType,
					// M2 (internal-contracts §29.3): what a path / tuple bucket clause is built from.
					Path: Array.isArray(pAgg.Path) ? pAgg.Path : null,
					Dimension: primaryDimension(pAgg),
					Tuple: pAgg.Tuple || null,
					MultiValued: (pAgg.MultiValued === true)
				},
			ReportMissing: (pAgg.Missing !== false),
			PivotLabels: null
		};

	switch (pAgg.Kind)
	{
		case 'Terms':
			postTerms(tmpResult, pAgg, pRaw, tmpContext);
			break;
		case 'DateHistogram':
			postDateHistogram(tmpResult, pAgg, pRaw, tmpContext);
			break;
		case 'NumericHistogram':
			postNumericHistogram(tmpResult, pAgg, pRaw, tmpContext);
			break;
		case 'Ranges':
			postRanges(tmpResult, pAgg, pRaw, tmpContext);
			break;
		case 'Stats':
			postStats(tmpResult, pAgg, pRaw);
			break;
		case 'DistinctCount':
			tmpResult.DistinctCount = toCount(pRaw.DistinctCount);
			tmpResult.MissingCount = toCount(pRaw.MissingCount);
			break;
		case 'Missing':
			tmpResult.MissingCount = toCount(pRaw.MissingCount);
			break;
		case 'Pivot':
			postPivot(tmpResult, pAgg, pRaw, tmpContext);
			break;
		case 'ChildRollup':
			postChildRollup(tmpResult, pAgg, pRaw, tmpContext);
			break;
		case 'ExistsSplit':
			postExistsSplit(tmpResult, pAgg, pRaw, tmpContext);
			break;
		case 'Count':
			break;
		default:
			throw libFacetErrors.create('FACET_INTERNAL', 'buildFacetResult: unknown fold kind.', { Kind: String(pAgg.Kind) });
	}

	if (SCALAR_FOLDS.indexOf(pAgg.Kind) >= 0)
	{
		// internal-contracts §10.2: SumOfCounts and OtherCount are 0 for folds without buckets.
		tmpResult.SumOfCounts = 0;
		tmpResult.OtherCount = 0;
	}
	else
	{
		if (pAgg.Kind !== 'Pivot')
		{
			tmpResult.SumOfCounts = tmpResult.Buckets.reduce((pSum, pBucket) => { return pSum + pBucket.Count; }, 0);
		}
		// A multi-valued facet (K9) counts a row once per key: SumOfCounts may exceed Total, so no
		// OtherCount identity holds (internal-contracts §29.1).
		tmpResult.OtherCount = tmpResult.MultiValued ? null : (tmpResult.Total - tmpResult.SumOfCounts - tmpResult.MissingCount);
	}

	if (pAgg.Chart === true)
	{
		let tmpLabel = tmpResult.DisplayName || tmpResult.Key;
		if (pAgg.Kind === 'Pivot')
		{
			tmpResult.Chart =
				{
					Labels: tmpContext.PivotLabels.Rows,
					Datasets: tmpResult.ColumnKeys.map(
						(pColumnKey, pColumnIndex) =>
						{
							return (
								{
									label: tmpContext.PivotLabels.Columns[pColumnIndex],
									data: tmpResult.RowKeys.map(
										(pRowKey) =>
										{
											let tmpCell = tmpResult.Cells.find((pCell) => { return (libFacetBuckets.compareKeys(pCell.K1, pRowKey) === 0) && (libFacetBuckets.compareKeys(pCell.K2, pColumnKey) === 0); });
											return tmpCell ? tmpCell.Count : 0;
										})
								});
						})
				};
		}
		else if (SCALAR_FOLDS.indexOf(pAgg.Kind) < 0)
		{
			tmpResult.Chart = bucketChart(tmpResult.Buckets, tmpLabel);
		}
	}
	return tmpResult;
};

/**
 * Assemble the envelope (internal-contracts §10.1).  Total / TotalCountMode are present only when
 * pParts.Total is a number (Total requested and computed).
 *
 * @param {{ Entity: string, Version: string, ModelVersion: string, Engine: string, Exact: boolean, AsOf: string, ElapsedMS: number,
 *           Total?: number, IncludesDeleted: boolean, FilterAST: Record<string, any>, Facets: Record<string, any>, Errors: Record<string, any>, Warnings: Array<any>,
 *           Records?: Array<Record<string, any>>, RecordShape?: string, RecordsDropped?: number, DependsOn?: Array<string>,
 *           Cached?: boolean, Stale?: boolean, LagMS?: number }} pParts
 * @return {Record<string, any>}
 */
const buildEnvelope = (pParts) =>
{
	let tmpParts = pParts || {};
	let tmpFilterAST = tmpParts.FilterAST || {};
	let tmpEnvelope =
		{
			ContractVersion: libFacetRequest.CONTRACT_VERSION,
			Entity: tmpParts.Entity || null,
			Version: tmpParts.Version || null,
			ModelVersion: tmpParts.ModelVersion || null,
			Engine: tmpParts.Engine || null,
			Exact: (tmpParts.Exact !== false),
			AsOf: tmpParts.AsOf || null,
			LagMS: (typeof(tmpParts.LagMS) === 'number') ? tmpParts.LagMS : 0,
			Stale: (tmpParts.Stale === true),
			Cached: (tmpParts.Cached === true),
			ElapsedMS: (typeof(tmpParts.ElapsedMS) === 'number') ? tmpParts.ElapsedMS : 0
		};
	if (typeof(tmpParts.Total) === 'number')
	{
		tmpEnvelope.Total = tmpParts.Total;
		tmpEnvelope.TotalCountMode = tmpParts.TotalCountMode || 'Rows';
	}
	tmpEnvelope.IncludesDeleted = (typeof(tmpParts.IncludesDeleted) === 'boolean') ? tmpParts.IncludesDeleted : (tmpFilterAST.IncludesDeleted === true);
	tmpEnvelope.Filter =
		{
			Applied: Array.isArray(tmpFilterAST.Applied) ? tmpFilterAST.Applied.slice() : [],
			Warnings: Array.isArray(tmpFilterAST.Warnings) ? tmpFilterAST.Warnings.slice() : []
		};
	tmpEnvelope.Facets = tmpParts.Facets || {};
	tmpEnvelope.Errors = tmpParts.Errors || {};
	tmpEnvelope.Warnings = Array.isArray(tmpParts.Warnings) ? tmpParts.Warnings.slice() : [];
	if (Array.isArray(tmpParts.DependsOn))
	{
		// M4 (internal-contracts §44.7): the sorted entity names the answer depends on (readable ones
		// only), so a client can match change events to the groups it shows.  Not volatile.
		tmpEnvelope.DependsOn = tmpParts.DependsOn.slice();
	}
	if (Array.isArray(tmpParts.Records))
	{
		// internal-contracts §28.4: a Query body with Records (always Live records, kept by normalizeForComparison).
		tmpEnvelope.Records = tmpParts.Records;
		tmpEnvelope.RecordShape = (typeof(tmpParts.RecordShape) === 'string') ? tmpParts.RecordShape : 'Entity';
		tmpEnvelope.RecordsDropped = (typeof(tmpParts.RecordsDropped) === 'number') ? tmpParts.RecordsDropped : 0;
	}
	return tmpEnvelope;
};

/**
 * internal-contracts §10.1: the request fails only when every facet AND the Total (if requested)
 * failed.  Returns that failure's first error entry (insertion order of Errors), else null.
 *
 * @param {Record<string, any>} pEnvelope
 * @param {boolean} pTotalRequested
 * @return {{ Code: string, Status: number, Message: string } | null}
 */
const requestFailure = (pEnvelope, pTotalRequested) =>
{
	if (!pEnvelope || (typeof(pEnvelope) !== 'object'))
	{
		return null;
	}
	let tmpErrors = pEnvelope.Errors || {};
	let tmpErrorKeys = Object.keys(tmpErrors);
	if (tmpErrorKeys.length < 1)
	{
		return null;
	}
	if (Object.keys(pEnvelope.Facets || {}).length > 0)
	{
		return null;
	}
	if (pTotalRequested && (typeof(pEnvelope.Total) === 'number'))
	{
		return null;
	}
	return tmpErrors[tmpErrorKeys[0]];
};

/**
 * A deep copy of an envelope with the volatile fields removed (envelope level and every facet),
 * so a Live envelope and a Reference envelope can be compared with deep.equal (O1).
 *
 * @param {Record<string, any>} pEnvelope
 * @return {Record<string, any>}
 */
const normalizeForComparison = (pEnvelope) =>
{
	if ((typeof(pEnvelope) !== 'object') || (pEnvelope === null))
	{
		return pEnvelope;
	}
	let tmpCopy = JSON.parse(JSON.stringify(pEnvelope));
	for (let i = 0; i < VOLATILE_FIELDS.length; i++)
	{
		delete tmpCopy[VOLATILE_FIELDS[i]];
	}
	if ((typeof(tmpCopy.Facets) === 'object') && (tmpCopy.Facets !== null))
	{
		let tmpKeys = Object.keys(tmpCopy.Facets);
		for (let i = 0; i < tmpKeys.length; i++)
		{
			for (let j = 0; j < VOLATILE_FIELDS.length; j++)
			{
				delete tmpCopy.Facets[tmpKeys[i]][VOLATILE_FIELDS[j]];
			}
		}
	}
	return tmpCopy;
};

module.exports = (
	{
		CONTRACT_VERSION: libFacetRequest.CONTRACT_VERSION,
		NUMERIC_KEY_TYPES: NUMERIC_KEY_TYPES,
		VOLATILE_FIELDS: VOLATILE_FIELDS,
		normalizeKey: normalizeKey,
		emptyFacetResult: emptyFacetResult,
		buildFacetResult: buildFacetResult,
		buildEnvelope: buildEnvelope,
		requestFailure: requestFailure,
		normalizeForComparison: normalizeForComparison
	});
