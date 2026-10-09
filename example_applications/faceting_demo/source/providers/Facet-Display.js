/**
 * Facet-Display -- pure display helpers shared by the Facet-* widget views (liftable with them into
 * pict-section-facet).  No DOM, no pict, no fetch.
 *
 * Pict's {~D:~} inserts a value verbatim, so every string that came from the server (bucket labels, keys,
 * messages, JSON) goes through text() / json() before it lands in a display model.  Display models hold
 * escaped TEXT and small attribute tokens (a class name, 'checked'), never markup: the templates own the HTML.
 *
 *   text(pValue)                    HTML-escaped text ('' for null / undefined)
 *   json(pValue, pMaxChars)         pretty JSON, HTML-escaped, truncated with a note past pMaxChars
 *   compactJSON(pValue)             one-line JSON, HTML-escaped
 *   count(pNumber)                  toLocaleString() for finite numbers, '—' otherwise
 *   bucketLabel(pFacet, pBucket, pOptions)
 *                                   { Text, Muted, Blank, Unresolved, Tip } -- '' -> "(blank)", an unresolved FK ->
 *                                   "Client #11 (no name)" with a tooltip saying why
 *   deCamel(pName)                  'MyProjects' -> 'My projects'
 *   shortETag(pETag)                'W/"fv1:85dd2a…"' -> 'fv1:85dd2a01…'
 *   dateTimeShort(pValue)           '2026-03-04 05:06:07' -> '2026-03-04 05:06'
 *   dateShort(pValue)               '2026-03-04 05:06:07' -> 'Mar 4, 2026'
 *   dateParts(pValue)               '2026-03-04 05:06:07' -> { Year, Month, Day, Hour, Minute, Second }
 *   rangeText(pValues, pEndExclusive)
 *                                   a range clause's span as a reader says it: 'Jan – Jun 2026' (inclusive end),
 *                                   'Mar 2026', '2026', 'Jan 5 – Jun 28, 2026', '2000–2019', '≥ 1950'
 *   tickText(pFacet, pBucket, pPrevious)
 *                                   compact histogram axis text: 'Jan 2026', 'Mar', "Dec 29 ’25", 'Jan 5', 'Q2'
 *   bucketText(pFacet, pBucket)     a bucket as a reader says it ('Week of Jan 5, 2026', 'Mar 2026', '2000–2009')
 *   statusTone(pStatus)             'ok' | 'warn' | 'error' | 'muted'
 *   isSelectionOnly(pFacet)         no bucket carries a list Clause (Clause: null everywhere)
 *   facetBadges(pFacet, pOptions)   the card badges: user-facing (Multi-select, Read-only, Overlapping, Top n of m);
 *                                   pOptions.Internals adds the contract vocabulary (Fold, CountMode, Relaxed, …)
 *   facetFooter(pFacet, pNoun)      "Missing 3 · Other 0" when non-zero; Σ for multi-valued facets
 *   parseServerTiming(pHeader)      'upstream;dur=21.2' -> [ { Name: 'upstream', DurationMS: 21.2, Description: null } ]
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;', '`': '&#96;' };

const MONTHS = [ 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec' ];

const DATE_PATTERN = /^(-?\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/;

/**
 * @param {any} pValue
 * @return {string}
 */
const text = (pValue) =>
{
	if ((pValue === null) || (typeof(pValue) === 'undefined'))
	{
		return '';
	}
	return String(pValue).replace(/[&<>"'`]/g, (pCharacter) => { return ESCAPES[pCharacter]; });
};

/**
 * Pretty JSON for a code block (escaped).  Long payloads are cut at pMaxChars with a visible note.
 *
 * @param {any} pValue
 * @param {number} [pMaxChars]
 * @return {string}
 */
const json = (pValue, pMaxChars) =>
{
	let tmpText;
	try
	{
		tmpText = (typeof(pValue) === 'undefined') ? 'undefined' : JSON.stringify(pValue, null, 2);
	}
	catch (pError)
	{
		tmpText = `/* not serializable: ${pError.message} */`;
	}
	let tmpMax = (typeof(pMaxChars) === 'number') ? pMaxChars : 200000;
	if (tmpText.length > tmpMax)
	{
		tmpText = `${tmpText.slice(0, tmpMax)}\n/* … ${(tmpText.length - tmpMax).toLocaleString()} more characters */`;
	}
	return text(tmpText);
};

/**
 * @param {any} pValue
 * @return {string}
 */
const compactJSON = (pValue) =>
{
	try
	{
		return text(JSON.stringify(pValue));
	}
	catch (pError)
	{
		return '';
	}
};

/**
 * @param {any} pNumber
 * @return {string}
 */
const count = (pNumber) =>
{
	if ((typeof(pNumber) === 'number') && isFinite(pNumber))
	{
		return pNumber.toLocaleString();
	}
	return '—';
};

const UNRESOLVED_TIP = 'No label could be read for this key (LabelResolved: false): the row it names is deleted or not visible to this principal. The key still filters.';

/**
 * The display label of a bucket: the server Label, '' -> "(blank)", a key whose label did not resolve
 * (LabelResolved: false, a dangling or unlabeled foreign key) -> "<KeyNoun> #<key> (no name)" (muted, with a
 * tooltip that says why).
 *
 * @param {Record<string, any>} pFacet
 * @param {Record<string, any>} pBucket
 * @param {{ KeyNoun?: string }} [pOptions]
 * @return {{ Text: string, Muted: boolean, Blank: boolean, Unresolved: boolean, Tip: string }}
 */
const bucketLabel = (pFacet, pBucket, pOptions) =>
{
	let tmpOptions = pOptions || {};
	let tmpBucket = pBucket || {};
	if ((tmpBucket.Key === '') || ((tmpBucket.Label === '') && (tmpBucket.Key === null)))
	{
		return { Text: '(blank)', Muted: true, Blank: true, Unresolved: false, Tip: 'An empty string value' };
	}
	if ((tmpBucket.Key === null) && ((tmpBucket.Label === null) || (typeof(tmpBucket.Label) === 'undefined')))
	{
		return { Text: '(none)', Muted: true, Blank: true, Unresolved: false, Tip: 'No value (NULL)' };
	}
	if (tmpBucket.LabelResolved === false)
	{
		let tmpNoun = (typeof(tmpOptions.KeyNoun) === 'string') && (tmpOptions.KeyNoun.length > 0) ? `${tmpOptions.KeyNoun} ` : '';
		return { Text: text(`${tmpNoun}#${tmpBucket.Key} (no name)`), Muted: true, Blank: false, Unresolved: true, Tip: text(UNRESOLVED_TIP) };
	}
	let tmpLabel = ((typeof(tmpBucket.Label) === 'string') && (tmpBucket.Label.length > 0)) ? tmpBucket.Label : String(tmpBucket.Key);
	return { Text: text(tmpLabel), Muted: false, Blank: false, Unresolved: false, Tip: '' };
};

/**
 * 'MyProjects' -> 'My projects', 'HasMyOverdue' -> 'Has my overdue', 'WellReviewed' -> 'Well reviewed'.
 *
 * @param {string} pName
 * @return {string}
 */
const deCamel = (pName) =>
{
	let tmpWords = String(pName || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').split(/\s+/).filter((pWord) => { return pWord.length > 0; });
	return tmpWords.map(
		(pWord, pIndex) =>
		{
			if (pIndex === 0)
			{
				return pWord.charAt(0).toUpperCase() + pWord.slice(1);
			}
			// Keep acronyms (ID, URL) as they are.
			return (pWord === pWord.toUpperCase()) ? pWord : pWord.toLowerCase();
		}).join(' ');
};

/**
 * @param {string} pETag - 'W/"fv1:85dd2a01ffee…"'
 * @return {string} 'fv1:85dd2a01…' (escaped) or ''
 */
const shortETag = (pETag) =>
{
	if (typeof(pETag) !== 'string' || (pETag.length < 1))
	{
		return '';
	}
	let tmpBare = pETag.replace(/^W\//, '').replace(/"/g, '');
	let tmpColon = tmpBare.indexOf(':');
	let tmpPrefix = (tmpColon >= 0) ? tmpBare.slice(0, tmpColon + 1) : '';
	let tmpHex = (tmpColon >= 0) ? tmpBare.slice(tmpColon + 1) : tmpBare;
	return text(`${tmpPrefix}${tmpHex.slice(0, 8)}${(tmpHex.length > 8) ? '…' : ''}`);
};

/**
 * @param {any} pValue - 'YYYY-MM-DD HH:mm:ss' (or ISO)
 * @return {string}
 */
const dateTimeShort = (pValue) =>
{
	if ((pValue === null) || (typeof(pValue) === 'undefined') || (pValue === ''))
	{
		return '';
	}
	let tmpText = String(pValue).replace('T', ' ');
	return text((/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(tmpText)) ? tmpText.slice(0, 16) : tmpText);
};

/**
 * @param {any} pValue - 'YYYY-MM-DD …'
 * @return {{ Year: number, Month: number, Day: number, Hour: number, Minute: number, Second: number }|null}
 */
const dateParts = (pValue) =>
{
	if ((typeof(pValue) !== 'string') || (pValue.length < 10))
	{
		return null;
	}
	let tmpMatch = DATE_PATTERN.exec(pValue);
	if (!tmpMatch)
	{
		return null;
	}
	return (
		{
			Year: parseInt(tmpMatch[1], 10),
			Month: parseInt(tmpMatch[2], 10),
			Day: parseInt(tmpMatch[3], 10),
			Hour: tmpMatch[4] ? parseInt(tmpMatch[4], 10) : 0,
			Minute: tmpMatch[5] ? parseInt(tmpMatch[5], 10) : 0,
			Second: tmpMatch[6] ? parseInt(tmpMatch[6], 10) : 0
		});
};

/**
 * @param {any} pValue - 'YYYY-MM-DD …'
 * @return {string} 'Mar 4, 2026' (escaped), or the value itself when it is not a date
 */
const dateShort = (pValue) =>
{
	let tmpParts = dateParts(pValue);
	if (!tmpParts)
	{
		return text((pValue === null) || (typeof(pValue) === 'undefined') ? '' : pValue);
	}
	return text(`${MONTHS[tmpParts.Month - 1]} ${tmpParts.Day}, ${tmpParts.Year}`);
};

/**
 * The calendar day before a date (UTC arithmetic on the date part only).
 *
 * @param {{ Year: number, Month: number, Day: number }} pParts
 * @return {{ Year: number, Month: number, Day: number, Hour: number, Minute: number, Second: number }}
 */
const dayBefore = (pParts) =>
{
	let tmpDate = new Date(Date.UTC(pParts.Year, pParts.Month - 1, pParts.Day) - 86400000);
	return { Year: tmpDate.getUTCFullYear(), Month: tmpDate.getUTCMonth() + 1, Day: tmpDate.getUTCDate(), Hour: 0, Minute: 0, Second: 0 };
};

/**
 * @param {{ Year: number, Month: number }} pParts
 * @return {number} the number of days in that month
 */
const daysInMonth = (pParts) =>
{
	return new Date(Date.UTC(pParts.Year, pParts.Month, 0)).getUTCDate();
};

/**
 * A date span as a reader says it, with an INCLUSIVE end (an exclusive midnight end is the day before):
 *   whole years    '2026' | '2025 – 2026'
 *   whole months   'Mar 2026' | 'Jan – Jun 2026' | 'Dec 2025 – Feb 2026'
 *   days           'Mar 4, 2026' | 'Jan 5 – Jun 28, 2026' | 'Dec 29, 2025 – Jan 4, 2026'
 *
 * @param {string|undefined} pStart
 * @param {string|undefined} pEnd
 * @param {boolean} pEndExclusive
 * @return {string} raw text
 */
const dateRangeText = (pStart, pEnd, pEndExclusive) =>
{
	let tmpStart = dateParts(pStart);
	let tmpEnd = dateParts(pEnd);
	if (tmpEnd && pEndExclusive && (tmpEnd.Hour === 0) && (tmpEnd.Minute === 0) && (tmpEnd.Second === 0))
	{
		tmpEnd = dayBefore(tmpEnd);
	}
	let fDay = (pParts, pWithYear) => { return `${MONTHS[pParts.Month - 1]} ${pParts.Day}${pWithYear ? `, ${pParts.Year}` : ''}`; };
	if (!tmpStart && !tmpEnd)
	{
		return 'any date';
	}
	if (!tmpStart)
	{
		return `until ${fDay(tmpEnd, true)}`;
	}
	if (!tmpEnd)
	{
		return `from ${fDay(tmpStart, true)}`;
	}
	let tmpWholeMonths = (tmpStart.Day === 1) && (tmpStart.Hour === 0) && (tmpStart.Minute === 0) && (tmpEnd.Day === daysInMonth(tmpEnd));
	if (tmpWholeMonths)
	{
		if ((tmpStart.Month === 1) && (tmpEnd.Month === 12))
		{
			return (tmpStart.Year === tmpEnd.Year) ? String(tmpStart.Year) : `${tmpStart.Year} – ${tmpEnd.Year}`;
		}
		if (tmpStart.Year === tmpEnd.Year)
		{
			if (tmpStart.Month === tmpEnd.Month)
			{
				return `${MONTHS[tmpStart.Month - 1]} ${tmpStart.Year}`;
			}
			return `${MONTHS[tmpStart.Month - 1]} – ${MONTHS[tmpEnd.Month - 1]} ${tmpStart.Year}`;
		}
		return `${MONTHS[tmpStart.Month - 1]} ${tmpStart.Year} – ${MONTHS[tmpEnd.Month - 1]} ${tmpEnd.Year}`;
	}
	if ((tmpStart.Year === tmpEnd.Year) && (tmpStart.Month === tmpEnd.Month) && (tmpStart.Day === tmpEnd.Day))
	{
		return fDay(tmpStart, true);
	}
	if (tmpStart.Year === tmpEnd.Year)
	{
		return `${fDay(tmpStart, false)} – ${fDay(tmpEnd, true)}`;
	}
	return `${fDay(tmpStart, true)} – ${fDay(tmpEnd, true)}`;
};

/**
 * A numeric span: integer bounds with an exclusive end read inclusively ('2000–2019'); otherwise the bounds
 * with their comparison ('≥ 1.5 and < 3').
 *
 * @param {number|undefined} pStart
 * @param {number|undefined} pEnd
 * @param {boolean} pEndExclusive
 * @return {string} raw text
 */
const numericRangeText = (pStart, pEnd, pEndExclusive) =>
{
	let tmpHasStart = (typeof(pStart) === 'number') && isFinite(pStart);
	let tmpHasEnd = (typeof(pEnd) === 'number') && isFinite(pEnd);
	if (tmpHasStart && tmpHasEnd)
	{
		if (pEndExclusive && Number.isInteger(pStart) && Number.isInteger(pEnd))
		{
			return (pEnd - 1 === pStart) ? String(pStart) : `${pStart}–${pEnd - 1}`;
		}
		return `≥ ${pStart} and ${pEndExclusive ? '<' : '≤'} ${pEnd}`;
	}
	if (tmpHasStart)
	{
		return `≥ ${pStart}`;
	}
	if (tmpHasEnd)
	{
		return `${pEndExclusive ? '<' : '≤'} ${pEnd}`;
	}
	return 'any value';
};

/**
 * The span of a range clause (DateRange, NumericRange, InternalJoinDateRange, …) as a reader says it.
 *
 * @param {Record<string, any>|null} pValues - Clause.Values { Start, End }
 * @param {boolean} [pEndExclusive] - Clause.EndExclusive
 * @return {string} raw text (escape before display)
 */
const rangeText = (pValues, pEndExclusive) =>
{
	let tmpValues = (pValues && (typeof(pValues) === 'object')) ? pValues : {};
	let tmpExclusive = (pEndExclusive !== false);
	if ((typeof(tmpValues.Start) === 'number') || (typeof(tmpValues.End) === 'number'))
	{
		return numericRangeText(tmpValues.Start, tmpValues.End, tmpExclusive);
	}
	return dateRangeText(tmpValues.Start, tmpValues.End, tmpExclusive);
};

/**
 * Compact axis text of a histogram bucket.  Dates: the year shows on the first tick and wherever it changes.
 *   month    'Jan 2026', then 'Mar', 'May', … ('Jan 2027' at the turn)
 *   quarter  'Q1 2026', then 'Q2', …
 *   week/day "Dec 29 ’25", then 'Jan 5', 'Jan 12', … ("Jan 4 ’27" at the turn)
 *   year     '2026'
 * Anything else: the server Label.
 *
 * @param {Record<string, any>} pFacet
 * @param {Record<string, any>} pBucket
 * @param {Record<string, any>|null} pPrevious - the previous TICK's bucket (null for the first tick)
 * @return {string} raw text
 */
const tickText = (pFacet, pBucket, pPrevious) =>
{
	let tmpLabel = String((pBucket.Label !== null) && (typeof(pBucket.Label) !== 'undefined') ? pBucket.Label : pBucket.Key);
	if (!pFacet || (pFacet.Fold !== 'DateHistogram'))
	{
		return tmpLabel;
	}
	let tmpParts = dateParts(pBucket.Start || pBucket.Key);
	if (!tmpParts)
	{
		return tmpLabel;
	}
	let tmpPrevious = pPrevious ? dateParts(pPrevious.Start || pPrevious.Key) : null;
	let tmpYearShows = !tmpPrevious || (tmpPrevious.Year !== tmpParts.Year);
	let tmpShortYear = `’${String(tmpParts.Year).slice(-2)}`;
	switch (pFacet.Interval)
	{
		case 'year':
			return String(tmpParts.Year);
		case 'quarter':
			return tmpYearShows ? `Q${Math.floor((tmpParts.Month - 1) / 3) + 1} ${tmpParts.Year}` : `Q${Math.floor((tmpParts.Month - 1) / 3) + 1}`;
		case 'month':
			return tmpYearShows ? `${MONTHS[tmpParts.Month - 1]} ${tmpParts.Year}` : MONTHS[tmpParts.Month - 1];
		case 'week':
		case 'day':
			return tmpYearShows ? `${MONTHS[tmpParts.Month - 1]} ${tmpParts.Day} ${tmpShortYear}` : `${MONTHS[tmpParts.Month - 1]} ${tmpParts.Day}`;
		default:
			return tmpLabel;
	}
};

/**
 * A bucket as a reader says it (hover readout, aria labels): 'Week of Jan 5, 2026', 'Mar 4, 2026', else the
 * server Label ('Mar 2026', 'Q2 2026', '2000–2009').
 *
 * @param {Record<string, any>} pFacet
 * @param {Record<string, any>} pBucket
 * @return {string} raw text
 */
const bucketText = (pFacet, pBucket) =>
{
	let tmpLabel = String((pBucket.Label !== null) && (typeof(pBucket.Label) !== 'undefined') ? pBucket.Label : pBucket.Key);
	if (!pFacet || (pFacet.Fold !== 'DateHistogram'))
	{
		return tmpLabel;
	}
	let tmpParts = dateParts(pBucket.Start || pBucket.Key);
	if (!tmpParts)
	{
		return tmpLabel;
	}
	if (pFacet.Interval === 'week')
	{
		return `Week of ${MONTHS[tmpParts.Month - 1]} ${tmpParts.Day}, ${tmpParts.Year}`;
	}
	if (pFacet.Interval === 'day')
	{
		return `${MONTHS[tmpParts.Month - 1]} ${tmpParts.Day}, ${tmpParts.Year}`;
	}
	return tmpLabel;
};

/**
 * @param {number|null} pStatus
 * @return {string}
 */
const statusTone = (pStatus) =>
{
	if ((pStatus === 200) || (pStatus === 304))
	{
		return 'ok';
	}
	if ((typeof(pStatus) !== 'number') || (pStatus === 0))
	{
		return 'muted';
	}
	if (pStatus >= 500)
	{
		return 'error';
	}
	return 'warn';
};

/**
 * A facet is Selection-only when it has buckets and none of them carries a list Clause (restricted paths,
 * ChildRollup bands, ExistsSplit, TuplePivot, multi-valued K9): no list clause can select exactly those rows.
 *
 * @param {Record<string, any>} pFacet
 * @return {boolean}
 */
const isSelectionOnly = (pFacet) =>
{
	if (!pFacet)
	{
		return false;
	}
	if (pFacet.Selectable === false)
	{
		return true;
	}
	let tmpBuckets = Array.isArray(pFacet.Buckets) ? pFacet.Buckets : [];
	if (tmpBuckets.length < 1)
	{
		return (pFacet.ClauseType === null);
	}
	return !tmpBuckets.some((pBucket) => { return pBucket && (typeof(pBucket.Clause) === 'object') && (pBucket.Clause !== null); });
};

const SELECTION_ONLY_TIP = 'Read-only: these counts describe the result, but no list filter can select exactly these rows (the buckets carry Clause: null), so they are not clickable.';

/**
 * The badges of a facet card.  Each badge: { Text, Tone, Tip } (escaped).
 *
 * Without pOptions.Internals only what a reader acts on: "Multi-select" (the counts ignore the card's own
 * selection), "Read-only" (no list clause), "Overlapping" (a row counts once per value), "Top n of m".  With
 * Internals the contract vocabulary joins them: the Fold, CountMode, Relaxed and the raw Disjunctive name.
 *
 * @param {Record<string, any>} pFacet - envelope.Facets[Key]
 * @param {{ ExpectedFold?: string, NounOne?: string, RelaxedTip?: string, Top?: number, Internals?: boolean }} [pOptions]
 * @return {Array<Record<string, string>>}
 */
const facetBadges = (pFacet, pOptions) =>
{
	let tmpOptions = pOptions || {};
	let tmpInternals = (tmpOptions.Internals === true);
	let tmpBadges = [];
	if (!pFacet)
	{
		return tmpBadges;
	}
	if (Array.isArray(pFacet.Excluded) && (pFacet.Excluded.length > 0))
	{
		tmpBadges.push({ Text: 'Multi-select', Tone: 'accent', Tip: text(`Pick several values: these counts ignore this card's own selection, so picking one never zeroes the others (disjunctive; Excluded: ${pFacet.Excluded.join(', ')}).`) });
	}
	if (isSelectionOnly(pFacet))
	{
		tmpBadges.push({ Text: 'Read-only', Tone: 'muted', Tip: text(SELECTION_ONLY_TIP) });
	}
	if (pFacet.MultiValued === true)
	{
		tmpBadges.push({ Text: 'Overlapping', Tone: 'neutral', Tip: text(`A ${tmpOptions.NounOne || 'row'} counts once in every bucket it has a value in, so the counts can add up to more than the total.`) });
	}
	if (pFacet.Truncated === true)
	{
		// The requested Top when the caller knows it (selected keys past Top are appended as extra buckets).
		let tmpShown = (typeof(tmpOptions.Top) === 'number') ? tmpOptions.Top : (Array.isArray(pFacet.Buckets) ? pFacet.Buckets.length : 0);
		let tmpOf = (typeof(pFacet.DistinctCount) === 'number') ? ` of ${pFacet.DistinctCount}` : '';
		tmpBadges.push({ Text: text(`Top ${tmpShown}${tmpOf}`), Tone: 'neutral', Tip: text(`Only the ${tmpShown} largest values are listed${pFacet.TruncatedReason ? ` (${pFacet.TruncatedReason})` : ''}; "Other" holds the rest.`) });
	}
	if (!tmpInternals)
	{
		return tmpBadges;
	}
	let tmpExpected = tmpOptions.ExpectedFold || 'Terms';
	if (pFacet.Fold && (pFacet.Fold !== tmpExpected))
	{
		tmpBadges.push({ Text: text(pFacet.Fold), Tone: 'internal', Tip: text(`Fold: ${pFacet.Fold}`) });
	}
	if (pFacet.Disjunctive)
	{
		tmpBadges.push({ Text: text(`Disjunctive ${pFacet.Disjunctive}`), Tone: 'internal', Tip: text(`Disjunctive: ${pFacet.Disjunctive}; Excluded: ${(pFacet.Excluded || []).join(', ') || '—'}`) });
	}
	if (pFacet.CountMode)
	{
		let tmpTip = (pFacet.CountMode === 'KeyDistinct') ? 'KeyDistinct: counts distinct key tuples, not rows.' : ((pFacet.CountMode === 'Rows') ? 'Rows: counts rows.' : `${pFacet.CountMode}: counts distinct (row, value) pairs.`);
		tmpBadges.push({ Text: text(pFacet.CountMode), Tone: 'internal', Tip: text(tmpTip) });
	}
	if (pFacet.Relaxed === true)
	{
		tmpBadges.push({ Text: 'Relaxed', Tone: 'internal', Tip: text(tmpOptions.RelaxedTip || 'Relaxed: a TenantOnly hop counts matches anywhere in my tenant, not just my own rows.') });
	}
	return tmpBadges;
};

/**
 * The footer facts of a facet card: "Missing 3 · Other 0" when non-zero; Σ for multi-valued facets.
 *
 * @param {Record<string, any>} pFacet
 * @param {string} [pNoun] - plural noun of the route entity ('books')
 * @return {Array<Record<string, string>>} [ { Text } ]
 */
const facetFooter = (pFacet, pNoun) =>
{
	let tmpParts = [];
	if (!pFacet)
	{
		return [];
	}
	if (pFacet.MultiValued === true)
	{
		tmpParts.push(`Σ ${count(pFacet.SumOfCounts)} across ${count(pFacet.Total)} ${pNoun || 'rows'}`);
	}
	let tmpMissing = (typeof(pFacet.MissingCount) === 'number') ? pFacet.MissingCount : 0;
	let tmpOther = (typeof(pFacet.OtherCount) === 'number') ? pFacet.OtherCount : 0;
	if ((tmpMissing > 0) || (tmpOther > 0))
	{
		tmpParts.push(`Missing ${count(tmpMissing)} · Other ${count(tmpOther)}`);
	}
	return (tmpParts.length > 0) ? [ { Text: text(tmpParts.join(' · ')) } ] : [];
};

/**
 * Parse a Server-Timing header: 'upstream;dur=21.2, db;dur=3;desc="SQL"'.
 *
 * @param {string|null} pHeader
 * @return {Array<{ Name: string, DurationMS: number|null, Description: string|null }>}
 */
const parseServerTiming = (pHeader) =>
{
	if ((typeof(pHeader) !== 'string') || (pHeader.length < 1))
	{
		return [];
	}
	return pHeader.split(',').map(
		(pMetric) =>
		{
			let tmpParts = pMetric.split(';').map((pPart) => { return pPart.trim(); }).filter((pPart) => { return pPart.length > 0; });
			let tmpEntry = { Name: tmpParts[0] || '', DurationMS: null, Description: null };
			tmpParts.slice(1).forEach(
				(pParam) =>
				{
					let tmpEquals = pParam.indexOf('=');
					let tmpName = ((tmpEquals >= 0) ? pParam.slice(0, tmpEquals) : pParam).trim().toLowerCase();
					let tmpValue = (tmpEquals >= 0) ? pParam.slice(tmpEquals + 1).trim().replace(/^"(.*)"$/, '$1') : '';
					if (tmpName === 'dur')
					{
						let tmpNumber = parseFloat(tmpValue);
						tmpEntry.DurationMS = isFinite(tmpNumber) ? tmpNumber : null;
					}
					else if (tmpName === 'desc')
					{
						tmpEntry.Description = tmpValue;
					}
				});
			return tmpEntry;
		}).filter((pEntry) => { return pEntry.Name.length > 0; });
};

module.exports = (
	{
		MONTHS: MONTHS,
		text: text,
		json: json,
		compactJSON: compactJSON,
		count: count,
		bucketLabel: bucketLabel,
		deCamel: deCamel,
		shortETag: shortETag,
		dateTimeShort: dateTimeShort,
		dateShort: dateShort,
		dateParts: dateParts,
		dateRangeText: dateRangeText,
		numericRangeText: numericRangeText,
		rangeText: rangeText,
		tickText: tickText,
		bucketText: bucketText,
		statusTone: statusTone,
		isSelectionOnly: isSelectionOnly,
		facetBadges: facetBadges,
		facetFooter: facetFooter,
		parseServerTiming: parseServerTiming,
		SELECTION_ONLY_TIP: SELECTION_ONLY_TIP,
		UNRESOLVED_TIP: UNRESOLVED_TIP
	});
