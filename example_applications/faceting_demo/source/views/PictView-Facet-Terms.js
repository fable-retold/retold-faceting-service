/**
 * Facet-Terms -- a Terms-shaped facet card (DEMO-SPEC §7.4).  Liftable (pict-section-facet: PRSP-FilterType-FacetTerms).
 *
 * Displays (panel.Display):
 *   Checklist  rows: checkbox, label, proportional count bar, count; collapses after panel.Collapse rows
 *   Chips      inline pills "Label  count"; selected pills filled
 *   Bars       horizontal bars (ChildRollup bands, multi-valued K9, TuplePivot facets); clickable only when the
 *              bucket has a Clause
 *   Split      one stacked bar with a legend (ExistsSplit: two buckets)
 *
 * Model: AppData.Facet.Groups[<Group>].Widgets[<FacetKey>] (prepared from Envelope.Facets[<FacetKey>]; every
 * row keeps the bucket's Index so handlers pass indices, never keys).
 * Write-back: toggleBucket -> Facet-Selection.toggleTermsKey -> provider.setSelection (the bucket's own Clause).
 * Selected-zero rows stay (server appends them with Count 0 and Selected: true).  Clause: null -> display-only
 * with the "Read-only" pill.  panel.SortBy ('KeyDesc' | 'KeyAsc') orders an ordinal scale by key (5 stars
 * first) instead of by count; panel.KeyNoun names an unresolved key ("Client #11 (no name)", with a tooltip
 * that says why).  Focus survives the re-render that follows a click (data-focus-key).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libPictView = require('pict-view');

const libFacetSelection = require('../providers/Facet-Selection.js');
const libFacetDisplay = require('../providers/Facet-Display.js');

const VIEW_IDENTIFIER = 'Facet-Terms';

const _ViewConfiguration =
	{
		ViewIdentifier: VIEW_IDENTIFIER,
		DefaultRenderable: 'Facet-Terms-Panel',
		DefaultDestinationAddress: '#FD-Rail',
		AutoRender: false,

		CSS: /*css*/`
			.facet-terms-list { display: flex; flex-direction: column; gap: 1px; }
			.facet-check-row { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; column-gap: 8px; row-gap: 3px;
				padding: 4px 6px; margin: 0 -6px; border-radius: var(--facet-radius-sm, 6px); cursor: pointer; transition: background-color 100ms; }
			.facet-check-row:hover { background: var(--facet-surface-2, #f0f2f5); }
			.facet-check-row input { margin: 0; width: 15px; height: 15px; cursor: pointer; accent-color: var(--facet-accent, #3b5bdb); }
			.facet-check-row input:focus-visible { outline: 2px solid var(--facet-accent, #3b5bdb); outline-offset: 2px; }
			.facet-check-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--facet-text, #1b2230); }
			.facet-check-count { min-width: 3.5em; text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--facet-text-muted, #5d6878); }
			.facet-check-bar { grid-column: 2 / 4; height: 3px; border-radius: 2px; background: var(--facet-surface-2, #f0f2f5); overflow: hidden; }
			.facet-check-bar-fill { height: 100%; border-radius: 2px; background: var(--facet-bar, #b4c2ea); transition: background-color 100ms; }
			.facet-row-selected .facet-check-bar-fill { background: var(--facet-accent, #3b5bdb); }
			.facet-row-selected .facet-check-label { font-weight: 600; }
			.facet-row-zero .facet-check-label, .facet-row-zero .facet-check-count { color: var(--facet-text-faint, #8a94a3); }
			.facet-row-static { cursor: default; }
			.facet-row-static:hover { background: transparent; }
			.facet-row-static input { cursor: default; }
			.facet-label-muted { color: var(--facet-text-faint, #8a94a3); }
			.facet-label-blank { font-style: italic; }
			.facet-terms-more { margin-top: 4px; }

			.facet-chips { display: flex; flex-wrap: wrap; gap: 6px; }
			.facet-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 3px 10px; border-radius: 999px; font: inherit; font-size: 12px; line-height: 18px;
				color: var(--facet-text, #1b2230); background: var(--facet-surface, #ffffff); border: 1px solid var(--facet-border, #dfe3e9); cursor: pointer;
				transition: background-color 100ms, border-color 100ms, color 100ms; }
			.facet-chip:hover { border-color: var(--facet-accent, #3b5bdb); }
			.facet-chip:focus-visible { outline: 2px solid var(--facet-accent, #3b5bdb); outline-offset: 1px; }
			.facet-chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.facet-chip-count { font-variant-numeric: tabular-nums; color: var(--facet-text-muted, #5d6878); }
			.facet-chip-selected { background: var(--facet-accent, #3b5bdb); border-color: var(--facet-accent, #3b5bdb); color: var(--facet-accent-text, #ffffff); }
			.facet-chip-selected .facet-chip-count, .facet-chip-selected .facet-label-muted { color: var(--facet-accent-text, #ffffff); opacity: 0.85; }
			.facet-chip-zero { opacity: 0.6; }
			.facet-chip-static { cursor: default; }
			.facet-chip-static:hover { border-color: var(--facet-border, #dfe3e9); }

			.facet-bars { display: flex; flex-direction: column; gap: 2px; }
			.facet-bar-row { display: grid; grid-template-columns: 120px minmax(0, 1fr) 4.5em; align-items: center; gap: 8px; width: 100%; padding: 3px 4px; margin: 0;
				border: 0; border-radius: 4px; background: none; font: inherit; font-size: 12px; color: var(--facet-text, #1b2230); text-align: left; transition: background-color 100ms; }
			button.facet-bar-row { cursor: pointer; }
			button.facet-bar-row:hover { background: var(--facet-surface-2, #f0f2f5); }
			button.facet-bar-row:focus-visible { outline: 2px solid var(--facet-accent, #3b5bdb); outline-offset: 1px; }
			.facet-bar-row-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.facet-bar-track { height: 10px; border-radius: 3px; overflow: hidden; background: var(--facet-bar-zero, #e4e8ef); }
			.facet-bar-fill { height: 100%; border-radius: 3px; background: var(--facet-bar, #b4c2ea); transition: background-color 100ms; }
			button.facet-bar-row:hover .facet-bar-fill { background: var(--facet-bar-hover, #8fa3e0); }
			.facet-bar-selected .facet-bar-fill { background: var(--facet-bar-selected, #3b5bdb); }
			.facet-bar-count { text-align: right; font-variant-numeric: tabular-nums; color: var(--facet-text-muted, #5d6878); }
			.facet-bar-zero .facet-bar-row-label, .facet-bar-zero .facet-bar-count { color: var(--facet-text-faint, #8a94a3); }

			.facet-split-bar { display: flex; height: 14px; border-radius: 4px; overflow: hidden; background: var(--facet-bar-zero, #e4e8ef); }
			.facet-split-seg { height: 100%; min-width: 0; border: 0; padding: 0; transition: opacity 100ms; }
			.facet-split-seg-0 { background: var(--facet-accent, #3b5bdb); }
			.facet-split-seg-1 { background: var(--facet-bar, #b4c2ea); }
			.facet-split-seg-2 { background: var(--facet-bar-disabled, #c9ced8); }
			.facet-split-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 8px; font-size: 12px; color: var(--facet-text-muted, #5d6878); }
			.facet-split-key { display: inline-flex; align-items: center; gap: 6px; }
			.facet-split-swatch { width: 10px; height: 10px; border-radius: 3px; }
			.facet-split-key strong { color: var(--facet-text, #1b2230); font-weight: 600; font-variant-numeric: tabular-nums; }
		`,

		Templates:
			[
				{
					Hash: 'Facet-Terms-Panel-Template',
					Template: /*html*/`
<div class="facet-card facet-terms {~D:Record.CardClass~}">
	<header class="facet-card-head">
		<h3 class="facet-card-title">{~D:Record.Title~}</h3>
		<span class="facet-card-badges">{~TS:Facet-Badge-Template:Record.Badges~}</span>
		<span class="facet-card-spacer"></span>
		{~TS:Facet-Terms-Clear-Template:Record.ClearSlot~}
	</header>
	{~TS:Facet-Unavailable-Template:Record.UnavailableSlot~}
	{~TS:Facet-Inline-Error-Template:Record.ErrorSlot~}
	{~TS:Facet-Empty-Template:Record.EmptySlot~}
	{~TS:Facet-Terms-Checklist-Template:Record.ChecklistSlot~}
	{~TS:Facet-Terms-Chips-Template:Record.ChipsSlot~}
	{~TS:Facet-Terms-Bars-Template:Record.BarsSlot~}
	{~TS:Facet-Terms-Split-Template:Record.SplitSlot~}
	{~TS:Facet-Footer-Template:Record.FooterSlot~}
</div>`
				},
				{
					Hash: 'Facet-Terms-Clear-Template',
					Template: /*html*/`<button type="button" class="facet-link" data-focus-key="clear" onclick="{~P~}.views['{~D:Record.ViewHash~}'].clear('{~D:Record.Group~}', '{~D:Record.Key~}')">Clear</button>`
				},
				// ---------------------------------------------------------------- Checklist
				{
					Hash: 'Facet-Terms-Checklist-Template',
					Template: /*html*/`
<div class="facet-terms-list" role="group">
	{~TS:Facet-Terms-Check-Row-Template:Record.Rows~}
</div>
{~TS:Facet-Terms-More-Template:Record.MoreSlot~}`
				},
				{
					Hash: 'Facet-Terms-Check-Row-Template',
					Template: /*html*/`
<label class="facet-check-row {~D:Record.RowClass~}" title="{~D:Record.Tip~}">
	<input type="checkbox" {~D:Record.CheckedAttr~} {~D:Record.DisabledAttr~} data-focus-key="{~D:Record.FocusKey~}" onchange="{~P~}.views['{~D:Record.ViewHash~}'].toggleBucket('{~D:Record.Group~}', '{~D:Record.Key~}', {~D:Record.Index~})" />
	<span class="facet-check-label {~D:Record.LabelClass~}">{~D:Record.LabelText~}</span>
	<span class="facet-check-count">{~D:Record.CountText~}</span>
	<span class="facet-check-bar"><span class="facet-check-bar-fill" style="display: block; width: {~D:Record.BarPct~}%"></span></span>
</label>`
				},
				{
					Hash: 'Facet-Terms-More-Template',
					Template: /*html*/`<div class="facet-terms-more"><button type="button" class="facet-link" data-focus-key="more" onclick="{~P~}.views['{~D:Record.ViewHash~}'].toggleExpanded('{~D:Record.Group~}', '{~D:Record.Key~}')">{~D:Record.Text~}</button></div>`
				},
				// ---------------------------------------------------------------- Chips
				{
					Hash: 'Facet-Terms-Chips-Template',
					Template: /*html*/`<div class="facet-chips">{~TS:Facet-Terms-Chip-Template:Record.Rows~}</div>`
				},
				{
					Hash: 'Facet-Terms-Chip-Template',
					Template: /*html*/`{~TS:Facet-Terms-Chip-Button-Template:Record.ClickableSlot~}{~TS:Facet-Terms-Chip-Static-Template:Record.StaticSlot~}`
				},
				{
					Hash: 'Facet-Terms-Chip-Button-Template',
					Template: /*html*/`<button type="button" class="facet-chip {~D:Record.ChipClass~}" aria-pressed="{~D:Record.Pressed~}" title="{~D:Record.Tip~}" data-focus-key="{~D:Record.FocusKey~}" onclick="{~P~}.views['{~D:Record.ViewHash~}'].toggleBucket('{~D:Record.Group~}', '{~D:Record.Key~}', {~D:Record.Index~})"><span class="facet-chip-label {~D:Record.LabelClass~}">{~D:Record.LabelText~}</span><span class="facet-chip-count">{~D:Record.CountText~}</span></button>`
				},
				{
					Hash: 'Facet-Terms-Chip-Static-Template',
					Template: /*html*/`<span class="facet-chip facet-chip-static {~D:Record.ChipClass~}" title="{~D:Record.Tip~}"><span class="facet-chip-label {~D:Record.LabelClass~}">{~D:Record.LabelText~}</span><span class="facet-chip-count">{~D:Record.CountText~}</span></span>`
				},
				// ---------------------------------------------------------------- Bars
				{
					Hash: 'Facet-Terms-Bars-Template',
					Template: /*html*/`<div class="facet-bars">{~TS:Facet-Terms-Bar-Template:Record.Rows~}</div>`
				},
				{
					Hash: 'Facet-Terms-Bar-Template',
					Template: /*html*/`{~TS:Facet-Terms-Bar-Button-Template:Record.ClickableSlot~}{~TS:Facet-Terms-Bar-Static-Template:Record.StaticSlot~}`
				},
				{
					Hash: 'Facet-Terms-Bar-Button-Template',
					Template: /*html*/`
<button type="button" class="facet-bar-row {~D:Record.BarClass~}" aria-pressed="{~D:Record.Pressed~}" title="{~D:Record.Tip~}" data-focus-key="{~D:Record.FocusKey~}" onclick="{~P~}.views['{~D:Record.ViewHash~}'].toggleBucket('{~D:Record.Group~}', '{~D:Record.Key~}', {~D:Record.Index~})">
	<span class="facet-bar-row-label {~D:Record.LabelClass~}">{~D:Record.LabelText~}</span>
	<span class="facet-bar-track"><span class="facet-bar-fill" style="display: block; width: {~D:Record.BarPct~}%"></span></span>
	<span class="facet-bar-count">{~D:Record.CountText~}</span>
</button>`
				},
				{
					Hash: 'Facet-Terms-Bar-Static-Template',
					Template: /*html*/`
<div class="facet-bar-row {~D:Record.BarClass~}" title="{~D:Record.Tip~}">
	<span class="facet-bar-row-label {~D:Record.LabelClass~}">{~D:Record.LabelText~}</span>
	<span class="facet-bar-track"><span class="facet-bar-fill" style="display: block; width: {~D:Record.BarPct~}%"></span></span>
	<span class="facet-bar-count">{~D:Record.CountText~}</span>
</div>`
				},
				// ---------------------------------------------------------------- Split
				{
					Hash: 'Facet-Terms-Split-Template',
					Template: /*html*/`
<div class="facet-split-bar" role="img" aria-label="{~D:Record.Aria~}">{~TS:Facet-Terms-Split-Segment-Template:Record.Segments~}</div>
<div class="facet-split-legend">{~TS:Facet-Terms-Split-Legend-Template:Record.Segments~}</div>`
				},
				{
					Hash: 'Facet-Terms-Split-Segment-Template',
					Template: /*html*/`<span class="facet-split-seg facet-split-seg-{~D:Record.Tone~}" style="width: {~D:Record.Pct~}%" title="{~D:Record.Tip~}"></span>`
				},
				{
					Hash: 'Facet-Terms-Split-Legend-Template',
					Template: /*html*/`<span class="facet-split-key"><span class="facet-split-swatch facet-split-seg-{~D:Record.Tone~}"></span><span class="{~D:Record.LabelClass~}">{~D:Record.LabelText~}</span> <strong>{~D:Record.CountText~}</strong></span>`
				}
			],

		Renderables:
			[
				{
					RenderableHash: 'Facet-Terms-Panel',
					TemplateHash: 'Facet-Terms-Panel-Template',
					ContentDestinationAddress: '#FD-Rail',
					RenderMethod: 'replace'
				}
			]
	};

class PictViewFacetTerms extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		// The last panel definition per Group-Key (so local UI toggles can re-render without the page).
		this._Panels = {};
	}

	/**
	 * The title of a facet card: the panel's, else Describe's (declared Title / auto DisplayName), else the
	 * FacetResult's DisplayName, else the key.
	 *
	 * @param {Record<string, any>} pPanel
	 * @param {Record<string, any>} pState
	 * @param {Record<string, any>|null} pFacet
	 * @return {string}
	 */
	_title(pPanel, pState, pFacet)
	{
		if (pPanel.Title)
		{
			return pPanel.Title;
		}
		let tmpSpec = pState.Facets.find((pCandidate) => { return pCandidate.Key === pPanel.FacetKey; });
		let tmpCapabilities = this.pict.providers.Facet.entityCapabilities(pState.Domain, pState.Entity);
		if (tmpSpec && tmpCapabilities && Array.isArray(tmpCapabilities.Facets) && (typeof(tmpSpec.Facet) === 'string'))
		{
			let tmpDescribed = tmpCapabilities.Facets.find((pCandidate) => { return pCandidate.Facet === tmpSpec.Facet; });
			if (tmpDescribed && (tmpDescribed.Title || tmpDescribed.DisplayName))
			{
				return tmpDescribed.Title || tmpDescribed.DisplayName;
			}
		}
		if (pFacet && pFacet.DisplayName)
		{
			return pFacet.DisplayName;
		}
		return pPanel.FacetKey;
	}

	/**
	 * Prepare AppData.Facet.Groups[pPanel.Group].Widgets[pPanel.FacetKey] and render into #<pPanel.PanelID>.
	 *
	 * @param {Record<string, any>} pPanel - a FacetDemo-Pages layout entry + PanelID
	 */
	renderPanel(pPanel)
	{
		let tmpState = this.pict.providers.Facet.group(pPanel.Group);
		if (!tmpState)
		{
			return;
		}
		this._Panels[`${pPanel.Group}-${pPanel.FacetKey}`] = pPanel;
		let tmpKey = pPanel.FacetKey;
		let tmpEnvelope = tmpState.Envelope;
		let tmpFacet = (tmpEnvelope && tmpEnvelope.Facets) ? (tmpEnvelope.Facets[tmpKey] || null) : null;
		let tmpFacetError = (tmpEnvelope && tmpEnvelope.Errors) ? (tmpEnvelope.Errors[tmpKey] || null) : null;
		let tmpPrevious = tmpState.Widgets[tmpKey] || {};
		let tmpDisplay = pPanel.Display || 'Checklist';
		let tmpBase = { ViewHash: VIEW_IDENTIFIER, Group: pPanel.Group, Key: tmpKey };
		let tmpSpec = tmpState.Facets.find((pCandidate) => { return pCandidate.Key === tmpKey; }) || null;

		let tmpModel =
			{
				ViewHash: VIEW_IDENTIFIER,
				Group: pPanel.Group,
				Key: tmpKey,
				Display: tmpDisplay,
				Expanded: (tmpPrevious.Expanded === true),
				Title: libFacetDisplay.text(this._title(pPanel, tmpState, tmpFacet)),
				CardClass: (tmpState.Status === 'Loading') ? 'facet-loading-dim' : '',
				Badges: libFacetDisplay.facetBadges(tmpFacet, { RelaxedTip: pPanel.RelaxedTip, NounOne: pPanel.NounOne, Top: tmpSpec ? tmpSpec.Top : undefined, Internals: this.pict.providers.Facet.showInternals() }),
				ClearSlot: tmpState.Selections[tmpKey] ? [ Object.assign({}, tmpBase) ] : [],
				UnavailableSlot: [],
				ErrorSlot: [],
				EmptySlot: [],
				ChecklistSlot: [],
				ChipsSlot: [],
				BarsSlot: [],
				SplitSlot: [],
				FooterSlot: []
			};

		if (tmpFacetError)
		{
			let tmpSuggest = (tmpFacetError.Detail && tmpFacetError.Detail.Suggest && tmpFacetError.Detail.Suggest.Interval) ? [ { Group: pPanel.Group, Key: tmpKey, Interval: libFacetDisplay.text(tmpFacetError.Detail.Suggest.Interval) } ] : [];
			tmpModel.ErrorSlot = [ { Code: libFacetDisplay.text(tmpFacetError.Code), Status: libFacetDisplay.text(tmpFacetError.Status), Message: libFacetDisplay.text(tmpFacetError.Message), SuggestSlot: tmpSuggest } ];
		}
		else if (!tmpFacet)
		{
			tmpModel.UnavailableSlot = [ { Text: (tmpState.Status === 'Error') ? 'Unavailable' : ((tmpEnvelope) ? 'Not in this answer' : 'Loading…') } ];
		}
		else
		{
			this._buildBody(tmpModel, tmpFacet, tmpDisplay, pPanel, tmpBase);
			tmpModel.FooterSlot = libFacetDisplay.facetFooter(tmpFacet, pPanel.Noun);
		}

		tmpState.Widgets[tmpKey] = tmpModel;
		let tmpFocus = this.pict.providers.Facet.captureFocus(pPanel.PanelID);
		this.render('Facet-Terms-Panel', `#${pPanel.PanelID}`, `AppData.Facet.Groups.${pPanel.Group}.Widgets.${tmpKey}`);
		this.pict.providers.Facet.restoreFocus(pPanel.PanelID, tmpFocus);
	}

	/**
	 * Rows for the display chosen by the panel.
	 *
	 * @param {Record<string, any>} pModel
	 * @param {Record<string, any>} pFacet
	 * @param {string} pDisplay
	 * @param {Record<string, any>} pPanel
	 * @param {Record<string, any>} pBase - { ViewHash, Group, Key }
	 */
	_buildBody(pModel, pFacet, pDisplay, pPanel, pBase)
	{
		let tmpBuckets = Array.isArray(pFacet.Buckets) ? pFacet.Buckets : [];
		if (tmpBuckets.length < 1)
		{
			pModel.EmptySlot = [ { Text: 'No values under this filter' } ];
			return;
		}
		let tmpMax = 1;
		let tmpSum = 0;
		tmpBuckets.forEach(
			(pBucket) =>
			{
				let tmpCount = (typeof(pBucket.Count) === 'number') ? pBucket.Count : 0;
				tmpMax = Math.max(tmpMax, tmpCount);
				tmpSum += tmpCount;
			});

		let tmpRows = tmpBuckets.map(
			(pBucket, pIndex) =>
			{
				let tmpCount = (typeof(pBucket.Count) === 'number') ? pBucket.Count : 0;
				let tmpLabel = libFacetDisplay.bucketLabel(pFacet, pBucket, { KeyNoun: pPanel.KeyNoun });
				let tmpSelectable = libFacetSelection.isSelectable(pFacet, pBucket);
				let tmpSelected = (pBucket.Selected === true);
				let tmpTip = `${tmpLabel.Blank ? tmpLabel.Text : libFacetDisplay.text(tmpLabel.Unresolved ? `#${pBucket.Key}` : (pBucket.Label || pBucket.Key))}: ${libFacetDisplay.count(tmpCount)}${tmpSelected ? ' (selected)' : ''}${tmpSelectable ? '' : ' · read-only'}${tmpLabel.Unresolved ? ` · ${tmpLabel.Tip}` : ''}`;
				let tmpRow = Object.assign({}, pBase,
					{
						Index: pIndex,
						FocusKey: libFacetDisplay.text(`term-${pBucket.Key}`),
						LabelText: tmpLabel.Text,
						LabelClass: `${tmpLabel.Muted ? 'facet-label-muted' : ''} ${tmpLabel.Blank ? 'facet-label-blank' : ''}`.trim(),
						CountText: libFacetDisplay.count(tmpCount),
						BarPct: (tmpCount > 0) ? Math.max(2, Math.round((tmpCount / tmpMax) * 1000) / 10) : 0,
						Selected: tmpSelected,
						Pressed: tmpSelected ? 'true' : 'false',
						CheckedAttr: tmpSelected ? 'checked' : '',
						DisabledAttr: tmpSelectable ? '' : 'disabled',
						RowClass: [ tmpSelected ? 'facet-row-selected' : '', (tmpCount === 0) ? 'facet-row-zero' : '', tmpSelectable ? '' : 'facet-row-static' ].join(' ').trim(),
						ChipClass: [ tmpSelected ? 'facet-chip-selected' : '', (tmpCount === 0) ? 'facet-chip-zero' : '' ].join(' ').trim(),
						BarClass: [ tmpSelected ? 'facet-bar-selected' : '', (tmpCount === 0) ? 'facet-bar-zero' : '' ].join(' ').trim(),
						Tip: tmpTip,
						ClickableSlot: [],
						StaticSlot: []
					});
				if (tmpSelectable)
				{
					tmpRow.ClickableSlot = [ Object.assign({}, tmpRow, { ClickableSlot: [], StaticSlot: [] }) ];
				}
				else
				{
					tmpRow.StaticSlot = [ Object.assign({}, tmpRow, { ClickableSlot: [], StaticSlot: [] }) ];
				}
				return tmpRow;
			});

		if ((pPanel.SortBy === 'KeyDesc') || (pPanel.SortBy === 'KeyAsc'))
		{
			// An ordinal scale (ratings, bands) reads in key order, not by count.  Rows keep their bucket Index.
			let tmpDirection = (pPanel.SortBy === 'KeyDesc') ? -1 : 1;
			tmpRows = tmpRows.slice().sort(
				(pLeft, pRight) =>
				{
					let tmpLeft = tmpBuckets[pLeft.Index].Key;
					let tmpRight = tmpBuckets[pRight.Index].Key;
					let tmpOrder = ((typeof(tmpLeft) === 'number') && (typeof(tmpRight) === 'number')) ? (tmpLeft - tmpRight) : String(tmpLeft).localeCompare(String(tmpRight));
					return tmpOrder * tmpDirection;
				});
		}

		if (pDisplay === 'Chips')
		{
			pModel.ChipsSlot = [ { Rows: tmpRows } ];
			return;
		}
		if (pDisplay === 'Bars')
		{
			pModel.BarsSlot = [ { Rows: tmpRows } ];
			return;
		}
		if (pDisplay === 'Split')
		{
			let tmpSegments = tmpRows.map(
				(pRow, pIndex) =>
				{
					let tmpCount = (typeof(tmpBuckets[pRow.Index].Count) === 'number') ? tmpBuckets[pRow.Index].Count : 0;
					return (
						{
							Tone: Math.min(pIndex, 2),
							Pct: (tmpSum > 0) ? Math.round((tmpCount / tmpSum) * 1000) / 10 : 0,
							LabelText: pRow.LabelText,
							LabelClass: pRow.LabelClass,
							CountText: pRow.CountText,
							Tip: pRow.Tip
						});
				});
			let tmpAria = tmpSegments.map((pSegment) => { return `${pSegment.LabelText} ${pSegment.CountText}`; }).join(' · ');
			pModel.SplitSlot = [ { Segments: tmpSegments, Aria: tmpAria } ];
			return;
		}

		// Checklist (default): collapse after panel.Collapse rows, but keep every selected row visible.
		let tmpVisible = tmpRows;
		let tmpCollapse = (typeof(pPanel.Collapse) === 'number') ? pPanel.Collapse : 0;
		let tmpMore = [];
		if ((tmpCollapse > 0) && (tmpRows.length > tmpCollapse))
		{
			if (pModel.Expanded)
			{
				tmpMore = [ Object.assign({}, pBase, { Text: 'Show fewer' }) ];
			}
			else
			{
				tmpVisible = tmpRows.filter((pRow, pIndex) => { return (pIndex < tmpCollapse) || pRow.Selected; });
				let tmpHidden = tmpRows.length - tmpVisible.length;
				if (tmpHidden > 0)
				{
					tmpMore = [ Object.assign({}, pBase, { Text: `Show all ${tmpRows.length}` }) ];
				}
			}
		}
		pModel.ChecklistSlot = [ { Rows: tmpVisible, MoreSlot: tmpMore } ];
	}

	/**
	 * Inline handler: toggle bucket pIndex of the facet in or out of the selection.
	 *
	 * @param {string} pGroupHash
	 * @param {string} pFacetKey
	 * @param {number} pIndex - Envelope.Facets[pFacetKey].Buckets index
	 */
	toggleBucket(pGroupHash, pFacetKey, pIndex)
	{
		let tmpProvider = this.pict.providers.Facet;
		let tmpState = tmpProvider.group(pGroupHash);
		let tmpFacet = (tmpState && tmpState.Envelope && tmpState.Envelope.Facets) ? tmpState.Envelope.Facets[pFacetKey] : null;
		let tmpBucket = (tmpFacet && Array.isArray(tmpFacet.Buckets)) ? tmpFacet.Buckets[pIndex] : null;
		if (!tmpBucket || !libFacetSelection.isSelectable(tmpFacet, tmpBucket))
		{
			return false;
		}
		let tmpClause = libFacetSelection.toggleTermsKey(tmpFacet, tmpState.Selections[pFacetKey] || null, pIndex);
		return tmpProvider.setSelection(pGroupHash, pFacetKey, tmpClause);
	}

	/**
	 * Inline handler: clear this facet's selection.
	 *
	 * @param {string} pGroupHash
	 * @param {string} pFacetKey
	 */
	clear(pGroupHash, pFacetKey)
	{
		return this.pict.providers.Facet.setSelection(pGroupHash, pFacetKey, null);
	}

	/**
	 * Inline handler: expand / collapse a long checklist (Widgets[pFacetKey].Expanded).
	 *
	 * @param {string} pGroupHash
	 * @param {string} pFacetKey
	 */
	toggleExpanded(pGroupHash, pFacetKey)
	{
		let tmpState = this.pict.providers.Facet.group(pGroupHash);
		if (!tmpState)
		{
			return;
		}
		let tmpWidget = tmpState.Widgets[pFacetKey] || {};
		tmpWidget.Expanded = !(tmpWidget.Expanded === true);
		tmpState.Widgets[pFacetKey] = tmpWidget;
		let tmpPanel = this._Panels[`${pGroupHash}-${pFacetKey}`];
		if (tmpPanel)
		{
			this.renderPanel(tmpPanel);
		}
	}

	onAfterRender(pRenderable, pRenderDestinationAddress, pRecord, pContent)
	{
		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pRenderDestinationAddress, pRecord, pContent);
	}
}

module.exports = PictViewFacetTerms;
module.exports.default_configuration = _ViewConfiguration;
