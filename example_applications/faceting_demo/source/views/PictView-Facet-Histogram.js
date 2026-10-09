/**
 * Facet-Histogram -- DateHistogram / NumericHistogram (and Ranges) card (DEMO-SPEC §7.5).  Liftable
 * (pict-section-facet: PRSP-FilterType-FacetHistogram; prior art: Sluice PictView-Sluice-Filter-Histogram).
 *
 *   CSS-div bars (no SVG), height ∝ Count / max; counts on the bars when there are few, a dashed max line
 *   otherwise; a sparse x-axis whose labels carry the year where it changes (minor ticks drop out on a narrow
 *   card); hover readout; local preview during a drag.
 *
 * The selection is the group's range CLAUSE, and the card reads it as such:
 *   - every bar is classified against the clause span (Facet-Selection.bucketCoverage): Full (inside: drawn
 *     selected), Partial (an edge bar only partly inside, e.g. after an interval change: drawn hatched), None;
 *   - the readout says the clause's own span the way the axis does ('Selected Jan – Jun 2026', an inclusive
 *     end) and the count of rows it selects, which IS the envelope Total (the same number as the page head and
 *     the list), never a sum of highlighted bars;
 *   - click a bar          -> that bucket's own Clause; clicking the bar whose Clause IS the selection clears it
 *   - drag bars i..j       -> rangeClause(i, j): the first bucket's Clause spanning Start(i) .. End(j)
 *   - Clear                -> setSelection(null)
 *   - interval control (panel.Intervals) -> provider.setFacetOption({ Interval }); the selection is kept as it
 *     is (the filter, and so the Total, do not change because the bars got finer or coarser).
 *
 * Stable domain: the server trims the axis to the data of each answer, so the card keeps the union of the
 * buckets it has seen for (principal, facet, interval) while they stay contiguous and pads the missing ones
 * with zero bars (each still carrying the Clause the server gave it), so a bar does not move under the
 * pointer when another filter changes.
 *
 * The drag is the one documented addEventListener exception (as in the Sluice widget): an inline onpointerdown
 * on a bar starts it; window pointermove / pointerup / pointercancel listeners exist ONLY during the drag.
 * Keyboard: every clickable bar is a <button>; Enter / Space (a click with detail 0) toggles it, and focus
 * stays on that bar across the re-render (data-focus-key).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libPictView = require('pict-view');

const libFacetSelection = require('../providers/Facet-Selection.js');
const libFacetDisplay = require('../providers/Facet-Display.js');

const VIEW_IDENTIFIER = 'Facet-Histogram';

const HINT_SELECTABLE = 'Click a bar, or drag across bars to select a range';
const HINT_SELECTION_ONLY = 'Read-only: hover a bar to read it';

// Counts are written on the bars up to this many bars; past it a dashed max line carries the scale.
const MAX_VALUE_LABELS = 24;

/**
 * The label of a bucket span: one bucket -> its text; numeric range labels ("2000–2009", "2010–2019")
 * join as one range ("2000–2019"); anything else -> "first – last".
 *
 * @param {Record<string, any>} pFacet
 * @param {Record<string, any>} pFirst - bucket
 * @param {Record<string, any>} pLast - bucket
 * @return {string} raw text (escape before display)
 */
const spanLabel = (pFacet, pFirst, pLast) =>
{
	if ((pFirst.Start !== null) && (typeof(pFirst.Start) !== 'undefined') && (pLast.End !== null) && (typeof(pLast.End) !== 'undefined'))
	{
		return libFacetDisplay.rangeText({ Start: pFirst.Start, End: pLast.End }, pLast.EndExclusive !== false);
	}
	let tmpFrom = libFacetDisplay.bucketText(pFacet, pFirst);
	if (pFirst === pLast)
	{
		return tmpFrom;
	}
	return `${tmpFrom} – ${libFacetDisplay.bucketText(pFacet, pLast)}`;
};

const _ViewConfiguration =
	{
		ViewIdentifier: VIEW_IDENTIFIER,
		DefaultRenderable: 'Facet-Histogram-Panel',
		DefaultDestinationAddress: '#FD-Main',
		AutoRender: false,

		CSS: /*css*/`
			.facet-hist { container-type: inline-size; }
			.facet-hist-intervals { display: inline-flex; border: 1px solid var(--facet-border, #dfe3e9); border-radius: var(--facet-radius-sm, 6px); overflow: hidden; }
			.facet-hist-interval { border: 0; border-right: 1px solid var(--facet-border, #dfe3e9); margin: 0; padding: 2px 9px; font: inherit; font-size: 11px; line-height: 18px;
				background: var(--facet-surface, #ffffff); color: var(--facet-text-muted, #5d6878); cursor: pointer; transition: background-color 100ms, color 100ms; }
			.facet-hist-interval:last-child { border-right: 0; }
			.facet-hist-interval:hover { color: var(--facet-accent, #3b5bdb); }
			.facet-hist-interval:focus-visible { outline: 2px solid var(--facet-accent, #3b5bdb); outline-offset: -2px; }
			.facet-hist-interval-active { background: var(--facet-accent-soft, #e8edfd); color: var(--facet-accent, #3b5bdb); font-weight: 600; }
			.facet-hist-readout { min-height: 18px; margin: 0 0 6px; font-size: 12px; color: var(--facet-text-muted, #5d6878); font-variant-numeric: tabular-nums; }
			.facet-hist-readout strong { color: var(--facet-text, #1b2230); font-weight: 600; }
			.facet-hist-plot { position: relative; }
			.facet-hist-gridline { position: absolute; left: 0; right: 0; top: 16px; border-top: 1px dashed var(--facet-border, #dfe3e9); pointer-events: none; }
			.facet-hist-ymax { position: absolute; right: 0; top: 0; font-size: 10px; line-height: 14px; color: var(--facet-text-faint, #8a94a3); font-variant-numeric: tabular-nums; pointer-events: none; }
			.facet-hist-bars { position: relative; display: flex; align-items: stretch; gap: 2px; height: 156px; padding-top: 16px; border-bottom: 1px solid var(--facet-border, #dfe3e9);
				touch-action: none; user-select: none; -webkit-user-select: none; }
			.facet-hist-gap-1 { gap: 1px; }
			.facet-hist-gap-0 { gap: 0; }
			.facet-hist-col { flex: 1 1 0; min-width: 0; height: 100%; display: flex; align-items: flex-end; margin: 0; padding: 0; border: 0; background: transparent;
				border-radius: 2px 2px 0 0; cursor: pointer; }
			.facet-hist-col:focus-visible { outline: 2px solid var(--facet-accent, #3b5bdb); outline-offset: 1px; }
			.facet-hist-bar { position: relative; display: block; width: 100%; min-height: 2px; border-radius: 2px 2px 0 0; background: var(--facet-bar, #b4c2ea); transition: background-color 100ms; pointer-events: none; }
			.facet-hist-val { position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); margin-bottom: 1px; font-size: 10px; line-height: 12px;
				color: var(--facet-text-muted, #5d6878); font-variant-numeric: tabular-nums; white-space: nowrap; }
			.facet-hist-col:hover .facet-hist-bar { background: var(--facet-bar-hover, #8fa3e0); }
			.facet-hist-selected .facet-hist-bar, .facet-hist-selected:hover .facet-hist-bar { background: var(--facet-bar-selected, #3b5bdb); }
			.facet-hist-selected .facet-hist-val { color: var(--facet-text, #1b2230); font-weight: 600; }
			.facet-hist-partial .facet-hist-bar, .facet-hist-partial:hover .facet-hist-bar
				{ background: repeating-linear-gradient(135deg, var(--facet-bar-selected, #3b5bdb) 0 3px, var(--facet-bar, #b4c2ea) 3px 6px); }
			.facet-hist-zero .facet-hist-bar, .facet-hist-zero:hover .facet-hist-bar { min-height: 1px; height: 1px !important; background: var(--facet-bar-zero, #e4e8ef); }
			.facet-hist-zero.facet-hist-selected .facet-hist-bar, .facet-hist-zero.facet-hist-partial .facet-hist-bar { min-height: 2px; height: 2px !important; background: var(--facet-bar-selected, #3b5bdb); }
			.facet-hist-preview .facet-hist-bar, .facet-hist-preview:hover .facet-hist-bar { background: var(--facet-bar-preview, #7b93e6); }
			.facet-hist-zero.facet-hist-preview .facet-hist-bar { min-height: 2px; height: 2px !important; }
			.facet-hist-col-static { cursor: default; }
			.facet-hist-col-static .facet-hist-bar, .facet-hist-col-static:hover .facet-hist-bar { background: var(--facet-bar-disabled, #c9ced8); }
			.facet-hist-col-static.facet-hist-zero .facet-hist-bar { background: var(--facet-bar-zero, #e4e8ef); }
			.facet-hist-axis { position: relative; height: 18px; margin-top: 4px; font-size: 11px; color: var(--facet-text-faint, #8a94a3); font-variant-numeric: tabular-nums; }
			.facet-hist-tick { position: absolute; top: 0; transform: translateX(-50%); white-space: nowrap; }
			.facet-hist-tick-first { transform: none; }
			.facet-hist-tick-last { transform: translateX(-100%); }
			.facet-hist-legend { display: inline-flex; align-items: center; gap: 5px; margin-left: 6px; color: var(--facet-text-faint, #8a94a3); }
			.facet-hist-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px;
				background: repeating-linear-gradient(135deg, var(--facet-bar-selected, #3b5bdb) 0 2px, var(--facet-bar, #b4c2ea) 2px 4px); }
			@container (max-width: 560px)
			{
				.facet-hist-tick-minor { display: none; }
				.facet-hist-val { display: none; }
			}
		`,

		Templates:
			[
				{
					Hash: 'Facet-Histogram-Panel-Template',
					Template: /*html*/`
<div class="facet-card facet-hist {~D:Record.CardClass~}">
	<header class="facet-card-head">
		<h3 class="facet-card-title">{~D:Record.Title~}</h3>
		<span class="facet-card-badges">{~TS:Facet-Badge-Template:Record.Badges~}</span>
		<span class="facet-card-spacer"></span>
		{~TS:Facet-Histogram-Intervals-Template:Record.IntervalSlot~}
		{~TS:Facet-Histogram-Clear-Template:Record.ClearSlot~}
	</header>
	{~TS:Facet-Unavailable-Template:Record.UnavailableSlot~}
	{~TS:Facet-Inline-Error-Template:Record.ErrorSlot~}
	{~TS:Facet-Empty-Template:Record.EmptySlot~}
	{~TS:Facet-Histogram-Chart-Template:Record.ChartSlot~}
	{~TS:Facet-Footer-Template:Record.FooterSlot~}
</div>`
				},
				{
					Hash: 'Facet-Histogram-Clear-Template',
					Template: /*html*/`<button type="button" class="facet-link" data-focus-key="clear" onclick="{~P~}.views['{~D:Record.ViewHash~}'].clear('{~D:Record.Group~}', '{~D:Record.Key~}')">Clear</button>`
				},
				{
					Hash: 'Facet-Histogram-Intervals-Template',
					Template: /*html*/`<span class="facet-hist-intervals" role="group" aria-label="Interval">{~TS:Facet-Histogram-Interval-Template:Record.Options~}</span>`
				},
				{
					Hash: 'Facet-Histogram-Interval-Template',
					Template: /*html*/`<button type="button" class="facet-hist-interval {~D:Record.ActiveClass~}" aria-pressed="{~D:Record.Pressed~}" data-focus-key="interval-{~D:Record.Interval~}" onclick="{~P~}.views['{~D:Record.ViewHash~}'].setInterval('{~D:Record.Group~}', '{~D:Record.Key~}', '{~D:Record.Interval~}')">{~D:Record.Interval~}</button>`
				},
				{
					Hash: 'Facet-Histogram-Chart-Template',
					Template: /*html*/`
<div class="facet-hist-readout" id="{~D:Record.ReadoutID~}" aria-live="polite">{~D:Record.ReadoutHTML~}</div>
<div class="facet-hist-plot">
	{~TS:Facet-Histogram-Max-Template:Record.MaxSlot~}
	<div class="facet-hist-bars {~D:Record.GapClass~}" id="{~D:Record.BarsID~}" onmouseleave="{~P~}.views['{~D:Record.ViewHash~}'].hover('{~D:Record.Group~}', '{~D:Record.Key~}', -1)">{~TS:Facet-Histogram-Bar-Template:Record.Bars~}</div>
</div>
<div class="facet-hist-axis" aria-hidden="true">{~TS:Facet-Histogram-Tick-Template:Record.Axis~}</div>`
				},
				{
					Hash: 'Facet-Histogram-Max-Template',
					Template: /*html*/`<div class="facet-hist-gridline"></div><span class="facet-hist-ymax">{~D:Record.Text~}</span>`
				},
				{
					Hash: 'Facet-Histogram-Bar-Template',
					Template: /*html*/`{~TS:Facet-Histogram-Bar-Button-Template:Record.ClickableSlot~}{~TS:Facet-Histogram-Bar-Static-Template:Record.StaticSlot~}`
				},
				{
					Hash: 'Facet-Histogram-Bar-Button-Template',
					Template: /*html*/`<button type="button" class="facet-hist-col {~D:Record.BarClass~}" data-index="{~D:Record.Index~}" data-focus-key="{~D:Record.FocusKey~}" aria-label="{~D:Record.Aria~}" aria-pressed="{~D:Record.Pressed~}" title="{~D:Record.Aria~}" onpointerdown="{~P~}.views['{~D:Record.ViewHash~}'].beginDrag(event, '{~D:Record.Group~}', '{~D:Record.Key~}', {~D:Record.Index~})" onclick="{~P~}.views['{~D:Record.ViewHash~}'].keyActivate(event, '{~D:Record.Group~}', '{~D:Record.Key~}', {~D:Record.Index~})" onmouseenter="{~P~}.views['{~D:Record.ViewHash~}'].hover('{~D:Record.Group~}', '{~D:Record.Key~}', {~D:Record.Index~})"><span class="facet-hist-bar" style="height: {~D:Record.HeightPct~}%">{~TS:Facet-Histogram-Value-Template:Record.ValueSlot~}</span></button>`
				},
				{
					Hash: 'Facet-Histogram-Bar-Static-Template',
					Template: /*html*/`<div class="facet-hist-col facet-hist-col-static {~D:Record.BarClass~}" data-index="{~D:Record.Index~}" title="{~D:Record.Aria~}" onmouseenter="{~P~}.views['{~D:Record.ViewHash~}'].hover('{~D:Record.Group~}', '{~D:Record.Key~}', {~D:Record.Index~})"><span class="facet-hist-bar" style="height: {~D:Record.HeightPct~}%">{~TS:Facet-Histogram-Value-Template:Record.ValueSlot~}</span></div>`
				},
				{
					Hash: 'Facet-Histogram-Value-Template',
					Template: /*html*/`<span class="facet-hist-val">{~D:Record.Text~}</span>`
				},
				{
					Hash: 'Facet-Histogram-Tick-Template',
					Template: /*html*/`<span class="facet-hist-tick {~D:Record.TickClass~}" style="left: {~D:Record.LeftPct~}%">{~D:Record.Text~}</span>`
				},
				{
					Hash: 'Facet-Histogram-Readout-Template',
					Template: /*html*/`{~D:Record.Text~}`
				}
			],

		Renderables:
			[
				{
					RenderableHash: 'Facet-Histogram-Panel',
					TemplateHash: 'Facet-Histogram-Panel-Template',
					ContentDestinationAddress: '#FD-Main',
					RenderMethod: 'replace'
				}
			]
	};

class PictViewFacetHistogram extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this._Drag = null;
		this._Panels = {};             // Group-Key -> the panel last rendered
		this._Display = {};            // Group-Key -> { Facet, Buckets } the bars on screen (gesture indices point here)
		this._Domains = {};            // Group-Key -> { Key, Buckets: { '<Start>': bucket template } } (stable domain)
		this._DeferredRender = {};     // Group-Key -> true when a render arrived during a drag
		this._BoundDragMove = this._onDragMove.bind(this);
		this._BoundDragEnd = this._onDragEnd.bind(this);
		this._BoundDragCancel = this._onDragCancel.bind(this);
	}

	/**
	 * @param {Record<string, any>} pState
	 * @param {string} pFacetKey
	 * @return {Record<string, any>|null}
	 */
	_facet(pState, pFacetKey)
	{
		return (pState && pState.Envelope && pState.Envelope.Facets) ? (pState.Envelope.Facets[pFacetKey] || null) : null;
	}

	/**
	 * The bars to draw: the answer's buckets, inside the union of the contiguous bucket spans seen for this
	 * (principal, facet, interval, edges); a bucket the answer trimmed away comes back with Count 0 and the
	 * Clause the server gave it earlier.  Every bar is classified against the selection's span.
	 *
	 * @param {Record<string, any>} pPanel
	 * @param {Record<string, any>} pState
	 * @param {Record<string, any>} pFacet
	 * @param {Record<string, any>} pSpec - the request spec
	 * @return {Array<Record<string, any>>}
	 */
	_displayBuckets(pPanel, pState, pFacet, pSpec)
	{
		let tmpLive = Array.isArray(pFacet.Buckets) ? pFacet.Buckets : [];
		let tmpRange = libFacetSelection.rangeOf(pState.Selections[pPanel.FacetKey] || null);
		let fClassify = (pBucket, pPadded) =>
		{
			let tmpCoverage = tmpRange ? libFacetSelection.bucketCoverage(pBucket, tmpRange) : ((pBucket.Selected === true) ? 'Full' : 'None');
			return Object.assign({}, pBucket, { Count: pPadded ? 0 : pBucket.Count, Coverage: tmpCoverage, Padded: pPadded });
		};
		let tmpRangeable = (tmpLive.length > 0) && tmpLive.every((pBucket) => { return (pBucket.Start !== null) && (typeof(pBucket.Start) !== 'undefined'); });
		if (!tmpRangeable)
		{
			return tmpLive.map((pBucket) => { return fClassify(pBucket, false); });
		}
		let tmpPanelKey = `${pPanel.Group}-${pPanel.FacetKey}`;
		let tmpDomainKey = JSON.stringify([ this.pict.providers.Facet.principalKey(), pFacet.Fold, pFacet.Interval || pSpec.Interval || null, pSpec.Mode || null, pSpec.Edges || null, pSpec.Width || null ]);
		let tmpDomain = this._Domains[tmpPanelKey];
		if (!tmpDomain || (tmpDomain.Key !== tmpDomainKey))
		{
			tmpDomain = { Key: tmpDomainKey, Buckets: {} };
		}
		let tmpLiveByStart = {};
		tmpLive.forEach(
			(pBucket) =>
			{
				let tmpStart = String(pBucket.Start);
				tmpLiveByStart[tmpStart] = pBucket;
				tmpDomain.Buckets[tmpStart] = { Key: pBucket.Key, Label: pBucket.Label, Start: pBucket.Start, End: pBucket.End, EndExclusive: pBucket.EndExclusive, Clause: pBucket.Clause || null };
			});
		let tmpUnion = Object.keys(tmpDomain.Buckets).map((pStart) => { return tmpDomain.Buckets[pStart]; });
		tmpUnion.sort((pLeft, pRight) => { return libFacetSelection.compareBound(pLeft.Start, pRight.Start); });
		let tmpContiguous = tmpUnion.every(
			(pBucket, pIndex) =>
			{
				let tmpNext = tmpUnion[pIndex + 1];
				return !tmpNext || ((pBucket.End !== null) && (typeof(pBucket.End) !== 'undefined') && (libFacetSelection.compareBound(pBucket.End, tmpNext.Start) === 0));
			});
		if (!tmpContiguous)
		{
			// A gap (another principal's data, a changed width): start over from this answer.
			tmpDomain = { Key: tmpDomainKey, Buckets: {} };
			tmpLive.forEach((pBucket) => { tmpDomain.Buckets[String(pBucket.Start)] = { Key: pBucket.Key, Label: pBucket.Label, Start: pBucket.Start, End: pBucket.End, EndExclusive: pBucket.EndExclusive, Clause: pBucket.Clause || null }; });
			tmpUnion = tmpLive.slice();
		}
		this._Domains[tmpPanelKey] = tmpDomain;
		return tmpUnion.map(
			(pBucket) =>
			{
				let tmpLiveBucket = tmpLiveByStart[String(pBucket.Start)];
				return tmpLiveBucket ? fClassify(tmpLiveBucket, false) : fClassify(pBucket, true);
			});
	}

	/**
	 * The readout of the current selection (or the hint): the clause's own span, read like the axis, and the
	 * rows it selects (the envelope Total: the page head and the list say the same number).
	 *
	 * @param {Record<string, any>} pPanel
	 * @param {Record<string, any>} pState
	 * @param {Array<Record<string, any>>} pBuckets - display buckets
	 * @param {boolean} pSelectable
	 * @return {string} escaped HTML-safe text (may hold <strong> / the legend swatch)
	 */
	_selectionText(pPanel, pState, pBuckets, pSelectable)
	{
		let tmpClause = pState.Selections[pPanel.FacetKey] || null;
		let tmpRange = libFacetSelection.rangeOf(tmpClause);
		if (!tmpRange)
		{
			return libFacetDisplay.text(pSelectable ? HINT_SELECTABLE : HINT_SELECTION_ONLY);
		}
		let tmpEnvelope = pState.Envelope;
		let tmpFull = pBuckets.filter((pBucket) => { return pBucket.Coverage === 'Full'; });
		let tmpPartial = pBuckets.filter((pBucket) => { return pBucket.Coverage === 'Partial'; });
		let tmpCount = (tmpEnvelope && (typeof(tmpEnvelope.Total) === 'number')) ? tmpEnvelope.Total : null;
		let tmpCountText = '';
		if (typeof(tmpCount) === 'number')
		{
			tmpCountText = ` · <strong>${libFacetDisplay.count(tmpCount)}</strong> ${libFacetDisplay.text((tmpCount === 1) ? (pPanel.NounOne || 'row') : (pPanel.Noun || 'rows'))}`;
		}
		else
		{
			let tmpSum = tmpFull.reduce((pSum, pBucket) => { return pSum + ((typeof(pBucket.Count) === 'number') ? pBucket.Count : 0); }, 0);
			tmpCountText = ` · ${libFacetDisplay.count(tmpSum)} in the bars fully inside${(tmpPartial.length > 0) ? ', plus part of the edge bars' : ''}`;
		}
		let tmpText = `Selected <strong>${libFacetDisplay.text(libFacetDisplay.rangeText(tmpClause.Values, tmpClause.EndExclusive !== false))}</strong>${tmpCountText}`;
		if (tmpPartial.length > 0)
		{
			tmpText += `<span class="facet-hist-legend"><span class="facet-hist-swatch"></span>${libFacetDisplay.text(`${tmpPartial.length} edge bar${(tmpPartial.length === 1) ? ' is' : 's are'} only partly inside`)}</span>`;
		}
		else if ((tmpFull.length < 1) && (pBuckets.length > 0))
		{
			tmpText += libFacetDisplay.text(' · outside the bars shown');
		}
		return tmpText;
	}

	/**
	 * @param {Record<string, any>} pPanel - layout entry + PanelID
	 */
	renderPanel(pPanel)
	{
		let tmpProvider = this.pict.providers.Facet;
		let tmpState = tmpProvider.group(pPanel.Group);
		if (!tmpState)
		{
			return;
		}
		let tmpPanelKey = `${pPanel.Group}-${pPanel.FacetKey}`;
		this._Panels[tmpPanelKey] = pPanel;
		if (this._Drag && (this._Drag.PanelKey === tmpPanelKey))
		{
			// Never swap the bars out from under a drag: render when it ends.
			this._DeferredRender[tmpPanelKey] = true;
			return;
		}
		let tmpKey = pPanel.FacetKey;
		let tmpEnvelope = tmpState.Envelope;
		let tmpFacet = this._facet(tmpState, tmpKey);
		let tmpFacetError = (tmpEnvelope && tmpEnvelope.Errors) ? (tmpEnvelope.Errors[tmpKey] || null) : null;
		let tmpSpec = tmpState.Facets.find((pCandidate) => { return pCandidate.Key === tmpKey; }) || {};
		let tmpBase = { ViewHash: VIEW_IDENTIFIER, Group: pPanel.Group, Key: tmpKey };

		let tmpTitle = pPanel.Title || (tmpFacet ? tmpFacet.DisplayName : null) || tmpKey;
		let tmpModel =
			{
				ViewHash: VIEW_IDENTIFIER,
				Group: pPanel.Group,
				Key: tmpKey,
				Title: libFacetDisplay.text(tmpTitle),
				CardClass: (tmpState.Status === 'Loading') ? 'facet-loading-dim' : '',
				Badges: libFacetDisplay.facetBadges(tmpFacet, { ExpectedFold: tmpFacet ? tmpFacet.Fold : 'DateHistogram', RelaxedTip: pPanel.RelaxedTip, Internals: tmpProvider.showInternals(), NounOne: pPanel.NounOne }),
				IntervalSlot: [],
				ClearSlot: tmpState.Selections[tmpKey] ? [ Object.assign({}, tmpBase) ] : [],
				UnavailableSlot: [],
				ErrorSlot: [],
				EmptySlot: [],
				ChartSlot: [],
				FooterSlot: [],
				ReadoutText: ''
			};

		if (Array.isArray(pPanel.Intervals) && (pPanel.Intervals.length > 0))
		{
			let tmpCurrent = tmpSpec.Interval || (tmpFacet ? tmpFacet.Interval : null);
			tmpModel.IntervalSlot = [ { Options: pPanel.Intervals.map((pInterval) => { return Object.assign({}, tmpBase, { Interval: libFacetDisplay.text(pInterval), ActiveClass: (pInterval === tmpCurrent) ? 'facet-hist-interval-active' : '', Pressed: (pInterval === tmpCurrent) ? 'true' : 'false' }); }) } ];
		}

		this._Display[tmpPanelKey] = null;
		if (tmpFacetError)
		{
			let tmpSuggest = (tmpFacetError.Detail && tmpFacetError.Detail.Suggest && tmpFacetError.Detail.Suggest.Interval) ? [ { Group: pPanel.Group, Key: tmpKey, Interval: libFacetDisplay.text(tmpFacetError.Detail.Suggest.Interval) } ] : [];
			tmpModel.ErrorSlot = [ { Code: libFacetDisplay.text(tmpFacetError.Code), Status: libFacetDisplay.text(tmpFacetError.Status), Message: libFacetDisplay.text(tmpFacetError.Message), SuggestSlot: tmpSuggest } ];
		}
		else if (!tmpFacet)
		{
			tmpModel.UnavailableSlot = [ { Text: (tmpState.Status === 'Error') ? 'Unavailable' : (tmpEnvelope ? 'Not in this answer' : 'Loading…') } ];
		}
		else
		{
			let tmpBuckets = this._displayBuckets(pPanel, tmpState, tmpFacet, tmpSpec);
			this._Display[tmpPanelKey] = { Facet: tmpFacet, Buckets: tmpBuckets };
			let tmpSelectable = tmpBuckets.some((pBucket) => { return libFacetSelection.isSelectable(tmpFacet, pBucket); });
			tmpModel.ReadoutText = this._selectionText(pPanel, tmpState, tmpBuckets, tmpSelectable);
			if (tmpBuckets.length < 1)
			{
				tmpModel.EmptySlot = [ { Text: libFacetDisplay.text('No values under this filter') } ];
			}
			else
			{
				tmpModel.ChartSlot = [ this._chartModel(pPanel, tmpFacet, tmpBuckets, tmpBase, tmpModel.ReadoutText) ];
			}
			tmpModel.FooterSlot = this._footer(tmpFacet, tmpSpec, pPanel);
		}

		tmpState.Widgets[tmpKey] = tmpModel;
		let tmpFocus = tmpProvider.captureFocus(pPanel.PanelID);
		this.render('Facet-Histogram-Panel', `#${pPanel.PanelID}`, `AppData.Facet.Groups.${pPanel.Group}.Widgets.${tmpKey}`);
		tmpProvider.restoreFocus(pPanel.PanelID, tmpFocus);
	}

	/**
	 * @param {Record<string, any>} pPanel
	 * @param {Record<string, any>} pFacet
	 * @param {Array<Record<string, any>>} pBuckets - display buckets
	 * @param {Record<string, any>} pBase
	 * @param {string} pReadoutText
	 * @return {Record<string, any>}
	 */
	_chartModel(pPanel, pFacet, pBuckets, pBase, pReadoutText)
	{
		let tmpCount = pBuckets.length;
		let tmpMax = 1;
		pBuckets.forEach((pBucket) => { tmpMax = Math.max(tmpMax, (typeof(pBucket.Count) === 'number') ? pBucket.Count : 0); });
		let tmpShowValues = (tmpCount <= MAX_VALUE_LABELS);
		let tmpBars = pBuckets.map(
			(pBucket, pIndex) =>
			{
				let tmpValue = (typeof(pBucket.Count) === 'number') ? pBucket.Count : 0;
				let tmpSelectable = libFacetSelection.isSelectable(pFacet, pBucket);
				let tmpState = (pBucket.Coverage === 'Full') ? ', selected' : ((pBucket.Coverage === 'Partial') ? ', partly inside the selection' : '');
				let tmpBar = Object.assign({}, pBase,
					{
						Index: pIndex,
						FocusKey: libFacetDisplay.text(`bar-${pBucket.Key}`),
						HeightPct: (tmpValue > 0) ? Math.max(1.5, Math.round((tmpValue / tmpMax) * 1000) / 10) : 0,
						BarClass: [ (pBucket.Coverage === 'Full') ? 'facet-hist-selected' : '', (pBucket.Coverage === 'Partial') ? 'facet-hist-partial' : '', (tmpValue === 0) ? 'facet-hist-zero' : '' ].join(' ').trim(),
						Pressed: (pBucket.Coverage === 'Full') ? 'true' : ((pBucket.Coverage === 'Partial') ? 'mixed' : 'false'),
						Aria: libFacetDisplay.text(`${libFacetDisplay.bucketText(pFacet, pBucket)}: ${libFacetDisplay.count(tmpValue)}${tmpState}`),
						ValueSlot: (tmpShowValues && (tmpValue > 0)) ? [ { Text: libFacetDisplay.count(tmpValue) } ] : [],
						ClickableSlot: [],
						StaticSlot: []
					});
				if (tmpSelectable)
				{
					tmpBar.ClickableSlot = [ Object.assign({}, tmpBar, { ClickableSlot: [], StaticSlot: [] }) ];
				}
				else
				{
					tmpBar.StaticSlot = [ Object.assign({}, tmpBar, { ClickableSlot: [], StaticSlot: [] }) ];
				}
				return tmpBar;
			});

		// Sparse axis: first, last and every k-th label (k = ceil(N / 8)), skipping k-th labels that crowd the last.
		// Each label carries the year when it differs from the previous LABEL's; every other inner label is minor
		// (hidden on a narrow card).
		let tmpStep = Math.max(1, Math.ceil(tmpCount / 8));
		let tmpAxis = [];
		let tmpPreviousTick = null;
		let tmpInner = 0;
		pBuckets.forEach(
			(pBucket, pIndex) =>
			{
				let tmpIsFirst = (pIndex === 0);
				let tmpIsLast = (pIndex === tmpCount - 1);
				let tmpOnStep = ((pIndex % tmpStep) === 0) && ((tmpCount - 1 - pIndex) >= Math.ceil(tmpStep / 2));
				if (!tmpIsFirst && !tmpIsLast && !tmpOnStep)
				{
					return;
				}
				let tmpMinor = !tmpIsFirst && !tmpIsLast && ((tmpInner++ % 2) === 0);
				tmpAxis.push(
					{
						Text: libFacetDisplay.text(libFacetDisplay.tickText(pFacet, pBucket, tmpPreviousTick)),
						LeftPct: tmpIsFirst ? 0 : (tmpIsLast ? 100 : Math.round(((pIndex + 0.5) / tmpCount) * 10000) / 100),
						TickClass: [ tmpIsFirst ? 'facet-hist-tick-first' : (tmpIsLast ? 'facet-hist-tick-last' : ''), tmpMinor ? 'facet-hist-tick-minor' : '' ].join(' ').trim()
					});
				tmpPreviousTick = pBucket;
			});
		if ((tmpCount === 1) && (tmpAxis.length === 1))
		{
			tmpAxis[0].TickClass = 'facet-hist-tick-first';
		}

		return Object.assign({}, pBase,
			{
				BarsID: `${pPanel.PanelID}-Bars`,
				ReadoutID: `${pPanel.PanelID}-Readout`,
				ReadoutHTML: pReadoutText,
				GapClass: (tmpCount > 150) ? 'facet-hist-gap-0' : ((tmpCount > 60) ? 'facet-hist-gap-1' : ''),
				MaxSlot: tmpShowValues ? [] : [ { Text: libFacetDisplay.text(`max ${libFacetDisplay.count(tmpMax)}`) } ],
				Bars: tmpBars,
				Axis: tmpAxis
			});
	}

	/**
	 * "Missing 1 · Other 0"; for an Edges histogram, say what Other means ("outside 1950–2030").
	 *
	 * @param {Record<string, any>} pFacet
	 * @param {Record<string, any>} pSpec
	 * @param {Record<string, any>} pPanel
	 * @return {Array<Record<string, string>>}
	 */
	_footer(pFacet, pSpec, pPanel)
	{
		let tmpMissing = (typeof(pFacet.MissingCount) === 'number') ? pFacet.MissingCount : 0;
		let tmpOther = (typeof(pFacet.OtherCount) === 'number') ? pFacet.OtherCount : 0;
		if (!((pSpec.Mode === 'Edges') && Array.isArray(pSpec.Edges) && (pSpec.Edges.length > 1) && (tmpOther > 0)))
		{
			return libFacetDisplay.facetFooter(pFacet, pPanel.Noun);
		}
		let tmpOtherText = `Other ${libFacetDisplay.count(tmpOther)} (outside ${pSpec.Edges[0]}–${pSpec.Edges[pSpec.Edges.length - 1] - 1})`;
		return [ { Text: libFacetDisplay.text(`${tmpOtherText} · Missing ${libFacetDisplay.count(tmpMissing)}`) } ];
	}

	/**
	 * Write back a span of the bars on screen (DEMO-SPEC §5.2).  One bar: its own Clause, or clear when that
	 * Clause IS the selection.  A span: the first bar's Clause stretched to the last bar's End.
	 *
	 * @param {string} pGroupHash
	 * @param {string} pFacetKey
	 * @param {number} pFrom - display index
	 * @param {number} pTo - display index
	 * @return {boolean} whether a write-back happened
	 */
	_apply(pGroupHash, pFacetKey, pFrom, pTo)
	{
		let tmpProvider = this.pict.providers.Facet;
		let tmpState = tmpProvider.group(pGroupHash);
		let tmpDisplay = this._Display[`${pGroupHash}-${pFacetKey}`];
		if (!tmpState || !tmpDisplay)
		{
			return false;
		}
		let tmpBuckets = tmpDisplay.Buckets;
		if (!tmpBuckets[pFrom] || !tmpBuckets[pTo])
		{
			return false;
		}
		// rangeClause over the bars as drawn (padded bars carry the Clause the server gave them earlier).
		let tmpFacet = { Selectable: tmpDisplay.Facet.Selectable, Buckets: tmpBuckets };
		if ((pFrom === pTo) && libFacetSelection.isSelectable(tmpFacet, tmpBuckets[pFrom]) && libFacetSelection.sameRange(tmpState.Selections[pFacetKey] || null, tmpBuckets[pFrom].Clause))
		{
			return tmpProvider.setSelection(pGroupHash, pFacetKey, null);
		}
		let tmpClause = libFacetSelection.rangeClause(tmpFacet, pFrom, pTo);
		if (!tmpClause)
		{
			return false;
		}
		return tmpProvider.setSelection(pGroupHash, pFacetKey, tmpClause);
	}

	/**
	 * Inline onpointerdown on a bar.
	 *
	 * @param {Event} pEvent
	 * @param {string} pGroupHash
	 * @param {string} pFacetKey
	 * @param {number} pIndex
	 */
	beginDrag(pEvent, pGroupHash, pFacetKey, pIndex)
	{
		if (!pEvent || ((typeof(pEvent.button) === 'number') && (pEvent.button !== 0)))
		{
			return;
		}
		let tmpPanel = this._Panels[`${pGroupHash}-${pFacetKey}`];
		let tmpDisplay = this._Display[`${pGroupHash}-${pFacetKey}`];
		if (!tmpPanel || !tmpDisplay)
		{
			return;
		}
		let tmpBarsElements = this.pict.ContentAssignment.getElement(`#${tmpPanel.PanelID}-Bars`);
		let tmpBarsElement = (tmpBarsElements && tmpBarsElements.length) ? tmpBarsElements[0] : null;
		if (!tmpBarsElement)
		{
			return;
		}
		if (pEvent.cancelable)
		{
			pEvent.preventDefault();
		}
		this._endDragListeners();
		this._Drag =
			{
				PanelKey: `${pGroupHash}-${pFacetKey}`,
				PanelID: tmpPanel.PanelID,
				Group: pGroupHash,
				Key: pFacetKey,
				Facet: tmpDisplay.Facet,
				Buckets: tmpDisplay.Buckets,
				From: pIndex,
				To: pIndex,
				BarsElement: tmpBarsElement,
				Columns: Array.prototype.slice.call(tmpBarsElement.children)
			};
		this._paintPreview();
		// The documented exception: window listeners exist only while this drag is active.
		window.addEventListener('pointermove', this._BoundDragMove);
		window.addEventListener('pointerup', this._BoundDragEnd);
		window.addEventListener('pointercancel', this._BoundDragCancel);
	}

	_endDragListeners()
	{
		if (typeof(window) === 'undefined')
		{
			return;
		}
		window.removeEventListener('pointermove', this._BoundDragMove);
		window.removeEventListener('pointerup', this._BoundDragEnd);
		window.removeEventListener('pointercancel', this._BoundDragCancel);
	}

	/**
	 * Preview classes on the bars of the drag span (no re-render) and the span readout.
	 */
	_paintPreview()
	{
		let tmpDrag = this._Drag;
		if (!tmpDrag)
		{
			return;
		}
		let tmpLo = Math.min(tmpDrag.From, tmpDrag.To);
		let tmpHi = Math.max(tmpDrag.From, tmpDrag.To);
		tmpDrag.Columns.forEach(
			(pColumn, pIndex) =>
			{
				if ((pIndex >= tmpLo) && (pIndex <= tmpHi))
				{
					pColumn.classList.add('facet-hist-preview');
				}
				else
				{
					pColumn.classList.remove('facet-hist-preview');
				}
			});
		let tmpBuckets = tmpDrag.Buckets;
		let tmpSum = 0;
		for (let i = tmpLo; i <= tmpHi; i++)
		{
			tmpSum += (tmpBuckets[i] && (typeof(tmpBuckets[i].Count) === 'number')) ? tmpBuckets[i].Count : 0;
		}
		let tmpSpan = (tmpBuckets[tmpLo] && tmpBuckets[tmpHi]) ? spanLabel(tmpDrag.Facet, tmpBuckets[tmpLo], tmpBuckets[tmpHi]) : '';
		this._setReadout(tmpDrag.PanelID, libFacetDisplay.text(`${tmpSpan} · ${libFacetDisplay.count(tmpSum)} (release to select)`));
	}

	/**
	 * @param {string} pPanelID
	 * @param {string} pHTML - escaped
	 */
	_setReadout(pPanelID, pHTML)
	{
		let tmpHTML = this.pict.parseTemplateByHash('Facet-Histogram-Readout-Template', { Text: pHTML });
		this.pict.ContentAssignment.assignContent(`#${pPanelID}-Readout`, tmpHTML);
	}

	_onDragMove(pEvent)
	{
		let tmpDrag = this._Drag;
		if (!tmpDrag)
		{
			return;
		}
		if (pEvent.cancelable)
		{
			pEvent.preventDefault();
		}
		let tmpRect = tmpDrag.BarsElement.getBoundingClientRect();
		let tmpCount = tmpDrag.Columns.length;
		if ((tmpCount < 1) || (tmpRect.width <= 0))
		{
			return;
		}
		let tmpRatio = (pEvent.clientX - tmpRect.left) / tmpRect.width;
		let tmpIndex = Math.max(0, Math.min(tmpCount - 1, Math.floor(tmpRatio * tmpCount)));
		if (tmpIndex !== tmpDrag.To)
		{
			tmpDrag.To = tmpIndex;
			this._paintPreview();
		}
	}

	_onDragEnd(pEvent)
	{
		let tmpDrag = this._Drag;
		this._endDragListeners();
		this._Drag = null;
		if (!tmpDrag)
		{
			return;
		}
		let tmpApplied = this._apply(tmpDrag.Group, tmpDrag.Key, tmpDrag.From, tmpDrag.To);
		if (!tmpApplied || this._DeferredRender[tmpDrag.PanelKey])
		{
			// Nothing written (or an answer arrived mid-drag): repaint from the current state.
			delete this._DeferredRender[tmpDrag.PanelKey];
			let tmpPanel = this._Panels[tmpDrag.PanelKey];
			if (tmpPanel)
			{
				this.renderPanel(tmpPanel);
			}
		}
	}

	_onDragCancel()
	{
		let tmpDrag = this._Drag;
		this._endDragListeners();
		this._Drag = null;
		if (!tmpDrag)
		{
			return;
		}
		delete this._DeferredRender[tmpDrag.PanelKey];
		let tmpPanel = this._Panels[tmpDrag.PanelKey];
		if (tmpPanel)
		{
			this.renderPanel(tmpPanel);
		}
	}

	/**
	 * Inline onclick on a bar: pointer clicks were handled by the drag (pointerup); a keyboard activation
	 * (Enter / Space, event.detail === 0) toggles the bar.
	 *
	 * @param {Event} pEvent
	 * @param {string} pGroupHash
	 * @param {string} pFacetKey
	 * @param {number} pIndex
	 */
	keyActivate(pEvent, pGroupHash, pFacetKey, pIndex)
	{
		if (!pEvent || (pEvent.detail !== 0))
		{
			return;
		}
		this._apply(pGroupHash, pFacetKey, pIndex, pIndex);
	}

	/**
	 * Inline onmouseenter: update the hover readout (pIndex < 0: back to the selection text).
	 *
	 * @param {string} pGroupHash
	 * @param {string} pFacetKey
	 * @param {number} pIndex
	 */
	hover(pGroupHash, pFacetKey, pIndex)
	{
		if (this._Drag)
		{
			return;
		}
		let tmpPanel = this._Panels[`${pGroupHash}-${pFacetKey}`];
		let tmpState = this.pict.providers.Facet.group(pGroupHash);
		let tmpDisplay = this._Display[`${pGroupHash}-${pFacetKey}`];
		if (!tmpPanel || !tmpState)
		{
			return;
		}
		let tmpBucket = (tmpDisplay && (pIndex >= 0)) ? tmpDisplay.Buckets[pIndex] : null;
		if (!tmpBucket)
		{
			let tmpWidget = tmpState.Widgets[pFacetKey];
			this._setReadout(tmpPanel.PanelID, tmpWidget ? tmpWidget.ReadoutText : '');
			return;
		}
		let tmpNote = (tmpBucket.Coverage === 'Full') ? ' (selected)' : ((tmpBucket.Coverage === 'Partial') ? ' (only partly inside the selection)' : '');
		let tmpText = `${libFacetDisplay.bucketText(tmpDisplay.Facet, tmpBucket)} · ${libFacetDisplay.count(tmpBucket.Count)}${tmpNote}`;
		this._setReadout(tmpPanel.PanelID, libFacetDisplay.text(tmpText));
	}

	/**
	 * @param {string} pGroupHash
	 * @param {string} pFacetKey
	 * @param {string} pInterval - 'day' | 'week' | 'month' | 'quarter' | 'year'
	 */
	setInterval(pGroupHash, pFacetKey, pInterval)
	{
		return this.pict.providers.Facet.setFacetOption(pGroupHash, pFacetKey, { Interval: pInterval });
	}

	/**
	 * @param {string} pGroupHash
	 * @param {string} pFacetKey
	 */
	clear(pGroupHash, pFacetKey)
	{
		return this.pict.providers.Facet.setSelection(pGroupHash, pFacetKey, null);
	}

	onAfterRender(pRenderable, pRenderDestinationAddress, pRecord, pContent)
	{
		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pRenderDestinationAddress, pRecord, pContent);
	}
}

module.exports = PictViewFacetHistogram;
module.exports.default_configuration = _ViewConfiguration;
module.exports.spanLabel = spanLabel;
