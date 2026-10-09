/**
 * Facet-Selection -- the pure client-side contract of the faceting demo (DEMO-SPEC §5).
 *
 * Everything that decides WHAT goes on the wire lives here, with no DOM, no pict and no fetch, so the
 * browser provider and the node smoke test (server/Faceting-Demo-Smoke.js) build byte-identical bodies:
 *
 *   initialGroupState(pDefinition)          group definition (source/pages/FacetDemo-Pages.js) -> group state
 *   buildQueryBody(pState)                  POST …/Query body: Scopes, Clauses, Facets, Total, Records
 *   buildRecordsBody(pState)                POST …/Records/:Begin/:Cap and …/Records/Count body
 *   routePath(pState, pKind, pBegin, pCap)  '/1.0/Facet/<E>[/Scope/<S>]/Query' | '/Records/<b>/<c>' | '/Records/Count'
 *   termsClause / toggleTermsKey            Terms write-back: the bucket's own Clause, Values = the selected keys
 *   rangeClause                             range write-back: the first bucket's Clause spanning buckets i..j
 *   pivotCellSelections                     a pivot cell -> the two 1-D facets' own bucket Clauses
 *   rangeOf / bucketCoverage / sameRange    how a range selection covers a histogram bucket ('Full' | 'Partial' |
 *                                           'None'), and whether a selection IS a bucket's own Clause
 *   lookupClause                            a key-list clause for a display lookup (NOT a facet selection)
 *   selectedKeysOf, isSelectable, sameKey, selectionHash, requestKey
 *
 * Write-back rule (the reason the list total and a clicked bucket always agree): a widget never builds a
 * clause from scratch.  It copies a Clause the server put on a bucket of the CURRENT envelope and changes
 * only its Values -- the list of keys for list-valued clauses, the { Start, End } span for range clauses.
 * A bucket whose Clause is null (restricted paths, bands, exists splits, TuplePivot facets) is read-only:
 * no list clause selects exactly its rows, so the widgets show it but do not make it clickable.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFacetContract = require('../Facet-Contract.js');

const KIND_QUERY = 'Query';
const KIND_RECORDS = 'Records';
const KIND_COUNT = 'Count';

/**
 * Deep copy of plain JSON data.
 *
 * @param {any} pValue
 * @return {any}
 */
const cloneJSON = (pValue) =>
{
	if ((pValue === null) || (typeof(pValue) === 'undefined'))
	{
		return pValue;
	}
	return JSON.parse(JSON.stringify(pValue));
};

/**
 * Two bucket keys are the same key (numbers and numeric strings compare equal: keys travel through HTML
 * attributes and JSON; '' and null never equal anything else).
 *
 * @param {any} pLeft
 * @param {any} pRight
 * @return {boolean}
 */
const sameKey = (pLeft, pRight) =>
{
	if (pLeft === pRight)
	{
		return true;
	}
	if ((pLeft === null) || (pRight === null) || (typeof(pLeft) === 'undefined') || (typeof(pRight) === 'undefined'))
	{
		return false;
	}
	if ((pLeft === '') || (pRight === ''))
	{
		return false;
	}
	return (typeof(pLeft) !== typeof(pRight)) && (String(pLeft) === String(pRight));
};

/**
 * The clause Hash a group gives a facet's selection (shows up in envelope Filter.Applied and in the
 * facet's Excluded list, so the inspector can say which clause a facet ignored).
 *
 * @param {string} pGroupHash
 * @param {string} pFacetKey
 * @return {string}
 */
const selectionHash = (pGroupHash, pFacetKey) =>
{
	return `${pGroupHash}-${pFacetKey}`;
};

/**
 * A bucket is clickable when the facet is Selectable and the bucket carries a list clause.
 *
 * @param {Record<string, any>} pFacetResult
 * @param {Record<string, any>} pBucket
 * @return {boolean}
 */
const isSelectable = (pFacetResult, pBucket) =>
{
	return !!pFacetResult && (pFacetResult.Selectable !== false) && !!pBucket && (typeof(pBucket.Clause) === 'object') && (pBucket.Clause !== null);
};

/**
 * The selected keys a list-valued selection clause carries (in its own order).
 *
 * @param {Record<string, any>|null} pClause
 * @return {Array<any>}
 */
const selectedKeysOf = (pClause) =>
{
	return (pClause && Array.isArray(pClause.Values)) ? pClause.Values.slice() : [];
};

/**
 * Terms write-back: a copy of the template Clause with Values = the selected keys.  Null when nothing is
 * selected or the template is not a list-valued clause (DistinctSelectedValueList, InternalJoinSelectedValueList,
 * InternalJoinMatch, ExternalJoinSelectedValueList all are).
 *
 * @param {Record<string, any>|null} pTemplateClause - a bucket's Clause
 * @param {Array<any>} pSelectedKeys
 * @return {Record<string, any>|null}
 */
const termsClause = (pTemplateClause, pSelectedKeys) =>
{
	if (!pTemplateClause || !Array.isArray(pTemplateClause.Values) || !Array.isArray(pSelectedKeys) || (pSelectedKeys.length < 1))
	{
		return null;
	}
	let tmpClause = cloneJSON(pTemplateClause);
	tmpClause.Values = pSelectedKeys.slice();
	delete tmpClause.Hash;
	return tmpClause;
};

/**
 * Toggle one bucket of a Terms facet in or out of the facet's selection.  The template is the clicked
 * bucket's own Clause; the selected keys keep the facet's bucket order (keys no longer listed go last, in
 * their previous order).  Returns the new selection clause, or null when the selection becomes empty.
 *
 * @param {Record<string, any>} pFacetResult - envelope.Facets[Key]
 * @param {Record<string, any>|null} pCurrentClause - the group's current selection for this facet
 * @param {number} pBucketIndex - index into pFacetResult.Buckets
 * @return {Record<string, any>|null}
 */
const toggleTermsKey = (pFacetResult, pCurrentClause, pBucketIndex) =>
{
	let tmpBuckets = (pFacetResult && Array.isArray(pFacetResult.Buckets)) ? pFacetResult.Buckets : [];
	let tmpBucket = tmpBuckets[pBucketIndex];
	if (!isSelectable(pFacetResult, tmpBucket))
	{
		return cloneJSON(pCurrentClause || null);
	}
	let tmpSelected = selectedKeysOf(pCurrentClause);
	let tmpWasSelected = tmpSelected.some((pKey) => { return sameKey(pKey, tmpBucket.Key); });
	if (tmpWasSelected)
	{
		tmpSelected = tmpSelected.filter((pKey) => { return !sameKey(pKey, tmpBucket.Key); });
	}
	else
	{
		tmpSelected.push(tmpBucket.Key);
	}
	// Bucket order first, then any selected key the envelope no longer lists.
	let tmpOrdered = [];
	tmpBuckets.forEach(
		(pCandidate) =>
		{
			if (tmpSelected.some((pKey) => { return sameKey(pKey, pCandidate.Key); }) && !tmpOrdered.some((pKey) => { return sameKey(pKey, pCandidate.Key); }))
			{
				tmpOrdered.push(pCandidate.Key);
			}
		});
	tmpSelected.forEach(
		(pKey) =>
		{
			if (!tmpOrdered.some((pOrderedKey) => { return sameKey(pOrderedKey, pKey); }))
			{
				tmpOrdered.push(pKey);
			}
		});
	return termsClause(tmpBucket.Clause, tmpOrdered);
};

/**
 * Range write-back for DateHistogram / NumericHistogram / Ranges facets: buckets pFromIndex..pToIndex
 * (inclusive, either order) -> a copy of the FIRST bucket's Clause (DateRange, NumericRange,
 * InternalJoinDateRange, InternalJoinNumericRange) whose Values span first.Start .. last.End with the last
 * bucket's EndExclusive.  A single bucket returns its own Clause unchanged.  An open-ended last bucket
 * (no End) gives a Start-only span.  Null when the first or last bucket is Selection-only.
 *
 * @param {Record<string, any>} pFacetResult
 * @param {number} pFromIndex
 * @param {number} pToIndex
 * @return {Record<string, any>|null}
 */
const rangeClause = (pFacetResult, pFromIndex, pToIndex) =>
{
	let tmpBuckets = (pFacetResult && Array.isArray(pFacetResult.Buckets)) ? pFacetResult.Buckets : [];
	let tmpLo = Math.min(pFromIndex, pToIndex);
	let tmpHi = Math.max(pFromIndex, pToIndex);
	let tmpFirst = tmpBuckets[tmpLo];
	let tmpLast = tmpBuckets[tmpHi];
	if (!isSelectable(pFacetResult, tmpFirst) || !isSelectable(pFacetResult, tmpLast))
	{
		return null;
	}
	let tmpClause = cloneJSON(tmpFirst.Clause);
	delete tmpClause.Hash;
	if (tmpLo === tmpHi)
	{
		return tmpClause;
	}
	let tmpValues = {};
	if ((tmpFirst.Clause.Values) && (typeof(tmpFirst.Clause.Values.Start) !== 'undefined'))
	{
		tmpValues.Start = tmpFirst.Clause.Values.Start;
	}
	if ((tmpLast.Clause.Values) && (typeof(tmpLast.Clause.Values.End) !== 'undefined'))
	{
		tmpValues.End = tmpLast.Clause.Values.End;
	}
	tmpClause.Values = tmpValues;
	if (typeof(tmpLast.Clause.EndExclusive) !== 'undefined')
	{
		tmpClause.EndExclusive = tmpLast.Clause.EndExclusive;
	}
	return tmpClause;
};

/**
 * A pivot cell click -> the selections of the two 1-D Terms facets the pivot is drawn from, each the exact
 * Clause of that facet's bucket for the cell's key.  Null when either facet is absent from the envelope or
 * has no clickable bucket for the key (the cell is then display-only).
 *
 * @param {Record<string, any>} pEnvelope
 * @param {string} pRowFacetKey - e.g. 'Status'
 * @param {string} pColumnFacetKey - e.g. 'Client'
 * @param {any} pRowKey - Cells[].K1
 * @param {any} pColumnKey - Cells[].K2
 * @return {Record<string, Record<string, any>>|null} { [pRowFacetKey]: clause, [pColumnFacetKey]: clause }
 */
const pivotCellSelections = (pEnvelope, pRowFacetKey, pColumnFacetKey, pRowKey, pColumnKey) =>
{
	let tmpFacets = (pEnvelope && pEnvelope.Facets) ? pEnvelope.Facets : {};
	let fClauseFor = (pFacetKey, pKey) =>
	{
		let tmpFacet = tmpFacets[pFacetKey];
		let tmpBuckets = (tmpFacet && Array.isArray(tmpFacet.Buckets)) ? tmpFacet.Buckets : [];
		for (let i = 0; i < tmpBuckets.length; i++)
		{
			if (sameKey(tmpBuckets[i].Key, pKey) && isSelectable(tmpFacet, tmpBuckets[i]))
			{
				return termsClause(tmpBuckets[i].Clause, [ tmpBuckets[i].Key ]);
			}
		}
		return null;
	};
	let tmpRow = fClauseFor(pRowFacetKey, pRowKey);
	let tmpColumn = fClauseFor(pColumnFacetKey, pColumnKey);
	if (!tmpRow || !tmpColumn)
	{
		return null;
	}
	let tmpResult = {};
	tmpResult[pRowFacetKey] = tmpRow;
	tmpResult[pColumnFacetKey] = tmpColumn;
	return tmpResult;
};

/**
 * The { Start, End, EndExclusive } span of a range clause, or null (not a range clause).
 *
 * @param {Record<string, any>|null} pClause
 * @return {{ Start: any, End: any, EndExclusive: boolean }|null}
 */
const rangeOf = (pClause) =>
{
	if (!pClause || !pClause.Values || (typeof(pClause.Values) !== 'object') || Array.isArray(pClause.Values))
	{
		return null;
	}
	let tmpHasStart = (typeof(pClause.Values.Start) !== 'undefined') && (pClause.Values.Start !== null);
	let tmpHasEnd = (typeof(pClause.Values.End) !== 'undefined') && (pClause.Values.End !== null);
	if (!tmpHasStart && !tmpHasEnd)
	{
		return null;
	}
	return { Start: tmpHasStart ? pClause.Values.Start : undefined, End: tmpHasEnd ? pClause.Values.End : undefined, EndExclusive: (pClause.EndExclusive !== false) };
};

/**
 * Order two range bounds of one facet: numbers numerically, 'YYYY-MM-DD HH:mm:ss' strings lexically (which is
 * chronological).
 *
 * @param {any} pLeft
 * @param {any} pRight
 * @return {number} < 0, 0, > 0
 */
const compareBound = (pLeft, pRight) =>
{
	if ((typeof(pLeft) === 'number') && (typeof(pRight) === 'number'))
	{
		return pLeft - pRight;
	}
	let tmpLeft = String(pLeft);
	let tmpRight = String(pRight);
	return (tmpLeft < tmpRight) ? -1 : ((tmpLeft > tmpRight) ? 1 : 0);
};

/**
 * How a range selection covers a histogram bucket [Start, End): 'Full' (the bucket lies inside: the server
 * marks it Selected), 'Partial' (they overlap, but rows of the bucket fall outside the selection: an edge
 * bucket after an interval change or a hand-made span), or 'None'.  A missing bound is open.
 *
 * @param {Record<string, any>} pBucket - { Start, End, EndExclusive }
 * @param {{ Start: any, End: any, EndExclusive: boolean }|null} pRange - rangeOf(selection)
 * @return {string} 'Full' | 'Partial' | 'None'
 */
const bucketCoverage = (pBucket, pRange) =>
{
	if (!pBucket || !pRange)
	{
		return 'None';
	}
	let tmpHasBucketStart = (typeof(pBucket.Start) !== 'undefined') && (pBucket.Start !== null);
	let tmpHasBucketEnd = (typeof(pBucket.End) !== 'undefined') && (pBucket.End !== null);
	if (!tmpHasBucketStart && !tmpHasBucketEnd)
	{
		return 'None';
	}
	let tmpHasStart = (typeof(pRange.Start) !== 'undefined');
	let tmpHasEnd = (typeof(pRange.End) !== 'undefined');
	// Overlap of [bStart, bEnd) and [rStart, rEnd) (or [rStart, rEnd] when the selection end is inclusive).
	let tmpOverlaps = (!tmpHasEnd || !tmpHasBucketStart || (pRange.EndExclusive ? (compareBound(pBucket.Start, pRange.End) < 0) : (compareBound(pBucket.Start, pRange.End) <= 0)))
		&& (!tmpHasStart || !tmpHasBucketEnd || (compareBound(pBucket.End, pRange.Start) > 0));
	if (!tmpOverlaps)
	{
		return 'None';
	}
	let tmpStartInside = !tmpHasStart || (tmpHasBucketStart && (compareBound(pRange.Start, pBucket.Start) <= 0));
	let tmpEndInside = !tmpHasEnd || (tmpHasBucketEnd && (compareBound(pBucket.End, pRange.End) <= 0));
	return (tmpStartInside && tmpEndInside) ? 'Full' : 'Partial';
};

/**
 * Is a selection exactly a bucket's own range clause (same column, same span)?  Used by the histogram: a click
 * on the bar whose Clause IS the selection clears it; any other click writes that bar's Clause.
 *
 * @param {Record<string, any>|null} pSelection
 * @param {Record<string, any>|null} pClause
 * @return {boolean}
 */
const sameRange = (pSelection, pClause) =>
{
	let tmpLeft = rangeOf(pSelection);
	let tmpRight = rangeOf(pClause);
	if (!tmpLeft || !tmpRight || (pSelection.Type !== pClause.Type) || (pSelection.FilterKey !== pClause.FilterKey) || (pSelection.FilterByColumn !== pClause.FilterByColumn))
	{
		return false;
	}
	let fSame = (pA, pB) => { return ((typeof(pA) === 'undefined') && (typeof(pB) === 'undefined')) || ((typeof(pA) !== 'undefined') && (typeof(pB) !== 'undefined') && (compareBound(pA, pB) === 0)); };
	return fSame(tmpLeft.Start, tmpRight.Start) && fSame(tmpLeft.End, tmpRight.End) && (tmpLeft.EndExclusive === tmpRight.EndExclusive);
};

/**
 * The clause of a display LOOKUP: rows of an entity whose pField is one of pKeys (a DistinctSelectedValueList,
 * the shape pict-section-filter sends).  A lookup reads related names for the list (an intake's received date,
 * a client's name); it is never part of a facet group's filter, so it is the one clause the client builds
 * itself.
 *
 * @param {string} pField
 * @param {Array<any>} pKeys
 * @return {Record<string, any>}
 */
const lookupClause = (pField, pKeys) =>
{
	return { Type: 'DistinctSelectedValueList', FilterByColumn: pField, Values: (Array.isArray(pKeys) ? pKeys.slice() : []), FilterKey: pField, ClauseKey: 'DistinctSelectedValueList' };
};

/**
 * A fresh group state from a group definition (FacetDemo-Pages.js Groups[*]): the request-shaping fields
 * deep-copied, the runtime fields reset.  The provider stores this at AppData.Facet.Groups[Hash].
 *
 * @param {Record<string, any>} pDefinition
 * @return {Record<string, any>}
 */
const initialGroupState = (pDefinition) =>
{
	let tmpDefinition = pDefinition || {};
	let tmpScopeState = {};
	let tmpInitialScopes = tmpDefinition.InitialScopes || {};
	Object.keys(tmpInitialScopes).forEach(
		(pScope) =>
		{
			let tmpEntry = tmpInitialScopes[pScope] || {};
			tmpScopeState[pScope] = { On: (tmpEntry.On === true), Params: cloneJSON(tmpEntry.Params || {}) };
		});
	let tmpSelections = {};
	let tmpInitialSelections = tmpDefinition.InitialSelections || {};
	Object.keys(tmpInitialSelections).forEach(
		(pFacetKey) =>
		{
			tmpSelections[pFacetKey] = cloneJSON(tmpInitialSelections[pFacetKey]);
		});
	return (
		{
			Hash: tmpDefinition.Hash,
			Domain: tmpDefinition.Domain,
			Entity: tmpDefinition.Entity,
			RouteScope: tmpDefinition.RouteScope || null,
			Total: (tmpDefinition.Total !== false),
			Facets: cloneJSON(tmpDefinition.Facets || []),
			BaseClauses: cloneJSON(tmpDefinition.BaseClauses || []),
			ScopeState: tmpScopeState,
			Selections: tmpSelections,
			Records: tmpDefinition.Records ? cloneJSON(tmpDefinition.Records) : null,
			// Runtime (owned by Pict-Provider-Facet; DEMO-SPEC §4.2)
			Status: 'Idle',
			Seq: 0,
			PrincipalKey: null,
			Envelope: null,
			Error: null,
			RecordsPage: null,
			CountCheck: null,
			LastExchangeID: null,
			Widgets: {}
		});
};

/**
 * The Scopes array of a request: every scope whose state is On, in state (insertion) order, with its
 * Params only when it has any.
 *
 * @param {Record<string, any>} pState
 * @return {Array<Record<string, any>>}
 */
const scopesOf = (pState) =>
{
	let tmpScopeState = (pState && pState.ScopeState) ? pState.ScopeState : {};
	let tmpScopes = [];
	Object.keys(tmpScopeState).forEach(
		(pScope) =>
		{
			let tmpEntry = tmpScopeState[pScope];
			if (!tmpEntry || (tmpEntry.On !== true))
			{
				return;
			}
			let tmpScope = { Scope: pScope };
			if (tmpEntry.Params && (Object.keys(tmpEntry.Params).length > 0))
			{
				tmpScope.Params = cloneJSON(tmpEntry.Params);
			}
			tmpScopes.push(tmpScope);
		});
	return tmpScopes;
};

/**
 * The Clauses array of a request: the group's fixed clauses, then every facet's selection in Facets order
 * (selections whose key is not a facet of the group go last, sorted), each stamped with its selectionHash.
 *
 * @param {Record<string, any>} pState
 * @return {Array<Record<string, any>>}
 */
const clausesOf = (pState) =>
{
	let tmpClauses = cloneJSON((pState && pState.BaseClauses) ? pState.BaseClauses : []);
	let tmpSelections = (pState && pState.Selections) ? pState.Selections : {};
	let tmpOrder = ((pState && Array.isArray(pState.Facets)) ? pState.Facets : []).map((pSpec) => { return pSpec.Key; });
	Object.keys(tmpSelections).sort().forEach(
		(pFacetKey) =>
		{
			if (tmpOrder.indexOf(pFacetKey) < 0)
			{
				tmpOrder.push(pFacetKey);
			}
		});
	tmpOrder.forEach(
		(pFacetKey) =>
		{
			let tmpClause = tmpSelections[pFacetKey];
			if (!tmpClause || (typeof(tmpClause) !== 'object'))
			{
				return;
			}
			let tmpCopy = cloneJSON(tmpClause);
			tmpCopy.Hash = selectionHash(pState.Hash, pFacetKey);
			tmpClauses.push(tmpCopy);
		});
	return tmpClauses;
};

/**
 * POST …/Query body for a group (one per filter change; DEMO-SPEC §5.1).  The Query always asks for the FIRST
 * page of records: a new answer (a filter change, another principal, a retry) may have fewer rows than the
 * page the list was on, and later pages come from POST …/Records/:Begin/:Cap (the provider's loadRecordsPage),
 * which never writes the paging cursor back into the request state.
 *
 * @param {Record<string, any>} pState
 * @return {Record<string, any>}
 */
const buildQueryBody = (pState) =>
{
	let tmpBody = {};
	let tmpScopes = scopesOf(pState);
	if (tmpScopes.length > 0)
	{
		tmpBody.Scopes = tmpScopes;
	}
	tmpBody.Clauses = clausesOf(pState);
	tmpBody.Facets = cloneJSON(pState.Facets || []);
	tmpBody.Total = (pState.Total !== false);
	if (pState.Records)
	{
		let tmpRecords = { Begin: 0, Cap: pState.Records.Cap || 25 };
		if (Array.isArray(pState.Records.Sort) && (pState.Records.Sort.length > 0))
		{
			tmpRecords.Sort = cloneJSON(pState.Records.Sort);
		}
		tmpBody.Records = tmpRecords;
	}
	return tmpBody;
};

/**
 * POST …/Records/:Begin/:Cap and …/Records/Count body: the same filter inputs as the Query (so the list and
 * the facets come from one compiler), the sort, and the recordset's Experience (accepted, ignored).
 *
 * @param {Record<string, any>} pState
 * @return {Record<string, any>}
 */
const buildRecordsBody = (pState) =>
{
	let tmpBody = {};
	let tmpScopes = scopesOf(pState);
	if (tmpScopes.length > 0)
	{
		tmpBody.Scopes = tmpScopes;
	}
	tmpBody.Clauses = clausesOf(pState);
	if (pState.Records && Array.isArray(pState.Records.Sort) && (pState.Records.Sort.length > 0))
	{
		tmpBody.Records = { Sort: cloneJSON(pState.Records.Sort) };
	}
	tmpBody.Experience = {};
	return tmpBody;
};

/**
 * The faceting route path of a group request (upstream form; the demo client prefixes '/api/<Domain>').
 *
 * @param {Record<string, any>} pState
 * @param {string} pKind - 'Query' | 'Records' | 'Count'
 * @param {number} [pBegin]
 * @param {number} [pCap]
 * @return {string}
 */
const routePath = (pState, pKind, pBegin, pCap) =>
{
	let tmpBase = `/1.0/Facet/${encodeURIComponent(pState.Entity)}`;
	if (pState.RouteScope)
	{
		tmpBase = `${tmpBase}/Scope/${encodeURIComponent(pState.RouteScope)}`;
	}
	if (pKind === KIND_RECORDS)
	{
		return `${tmpBase}/Records/${parseInt(pBegin, 10) || 0}/${parseInt(pCap, 10) || 25}`;
	}
	if (pKind === KIND_COUNT)
	{
		return `${tmpBase}/Records/Count`;
	}
	return `${tmpBase}/Query`;
};

/**
 * The Version-cache key of a request: everything that can change the answer except the server's own
 * generations (the ETag revalidates those).  Never includes a response.
 *
 * @param {string} pDomain
 * @param {string} pPrincipalKey
 * @param {string} pMethod
 * @param {string} pPath
 * @param {any} pBody
 * @return {string}
 */
const requestKey = (pDomain, pPrincipalKey, pMethod, pPath, pBody) =>
{
	return libFacetContract.Clauses.canonicalJSON({ Domain: pDomain, Principal: pPrincipalKey || '', Method: pMethod, Path: pPath, Body: (typeof(pBody) === 'undefined') ? null : pBody });
};

module.exports = (
	{
		KIND_QUERY: KIND_QUERY,
		KIND_RECORDS: KIND_RECORDS,
		KIND_COUNT: KIND_COUNT,
		cloneJSON: cloneJSON,
		sameKey: sameKey,
		selectionHash: selectionHash,
		isSelectable: isSelectable,
		selectedKeysOf: selectedKeysOf,
		termsClause: termsClause,
		toggleTermsKey: toggleTermsKey,
		rangeClause: rangeClause,
		pivotCellSelections: pivotCellSelections,
		rangeOf: rangeOf,
		compareBound: compareBound,
		bucketCoverage: bucketCoverage,
		sameRange: sameRange,
		lookupClause: lookupClause,
		initialGroupState: initialGroupState,
		scopesOf: scopesOf,
		clausesOf: clausesOf,
		buildQueryBody: buildQueryBody,
		buildRecordsBody: buildRecordsBody,
		routePath: routePath,
		requestKey: requestKey
	});
