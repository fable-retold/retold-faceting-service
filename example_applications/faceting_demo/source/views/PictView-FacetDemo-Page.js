/**
 * FacetDemo-Page -- renders the active page of FacetDemo-Pages into #FD-Page (DEMO-SPEC §7.2):
 *
 *   #FD-Page-Head    title (+ a muted design reference), the question as a literal query, the page Note, the
 *                    summary strip (Total, Engine, Exact, ms, ETag, POSTs), the ACTIVE FILTERS line (every on scope
 *                    and every selection as a removable chip, named the way the cards name them) with Reset and
 *                    "Show internals", a "Try" line, the loading bar and the whole-request error banner
 *   #FD-Tabs         page tabs (LabForms: A | B) and #FD-Tab-Note (what the active tab is)
 *   #FD-Top          Top panels (Scope bar; M4: the "Make a change" panel)
 *   #FD-Rail         Rail panels (Terms cards)
 *   #FD-Main         Main panels (Histogram, Pivot, Compare, Records)
 *
 * Every panel gets a container <section class="fd-card" id="FD-P-<Group>-<FacetKey | Widget>"> from the page
 * template; after the page renders (and on every provider notify for one of its groups) this view asks each
 * panel's widget view to renderPanel(pPanel).  The page view never draws a facet itself.  A 'Described' entry
 * expands to the panels a Describe-driven group derived (FacetDemo-Pages.describedFacets), or to a placeholder
 * until its Describe arrives.
 *
 * Widgets may also have data to fetch that belongs to an answer, not to a drawing (a list page's lookups, the
 * Compare cross-check): their preparePanel(pPanel) runs BEFORE renderPanel after the events that can bring new
 * data, so renderPanel stays free of network side effects.
 *
 * Re-render policy per provider reason:
 *   State / Loading   head + tabs + the Scope bar (local state) + the dimmed-body class; facet cards keep the
 *                     previous answer on screen (a native checkbox keeps its click until the answer arrives)
 *   Ready / Error     head + tabs + every panel of that group (and the Compare panel that reads it)
 *   Records / Count   the Records panel only
 *   Stream (M4)       head (the Live chip) + the Change panel: the domain's change-stream status changed
 *
 * M4 summary strip: Stale (+ age) instead of Exact for a Bounded answer served from the cache before its refresh,
 * the server's X-Retold-Facet-Cache (Hit / Miss / Stale / NotModified / Bypass / Off), the freshness the server
 * applied (X-Retold-Facet-Freshness, e.g. "Exact; upgraded=MinSeq"), the trigger of an SSE-driven refetch
 * ("Live update: Project @ e:…:15") and the domain's stream status (Live / Reconnecting / Off); the Seq with
 * "Show internals".
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libPictView = require('pict-view');

const libFacetDemoPages = require('../pages/FacetDemo-Pages.js');
const libFacetSelection = require('../providers/Facet-Selection.js');
const libFacetDisplay = require('../providers/Facet-Display.js');
const libFacetChanges = require('../providers/Facet-Changes.js');

// Panel widget -> view identifier.
const WIDGET_VIEWS =
	{
		Scope: 'Facet-Scope',
		Terms: 'Facet-Terms',
		Histogram: 'Facet-Histogram',
		Pivot: 'Facet-Pivot',
		Records: 'Facet-Records',
		Compare: 'FacetDemo-Compare',
		Change: 'FacetDemo-Change'
	};

// What the server's X-Retold-Facet-Cache says (internal-contracts §44.8).
const CACHE_TIPS =
	{
		Hit: 'The server answered from its result cache: the generations this answer depends on have not moved since it was computed.',
		Miss: 'The server computed this answer (and stored it).',
		Stale: 'Bounded freshness: the server served a cached answer computed before the latest change and is refreshing it in the background.',
		NotModified: 'If-None-Match matched the current generation Version: the server sent no body and ran no SQL.',
		Refresh: 'A background refresh.',
		Bypass: 'This request is not cacheable (the server says why in its log and pMeta); it was computed.',
		Off: 'The server\'s result cache is off: the answer was computed.'
	};

// Widgets that draw one facet (their panel id is the facet key; the rest use the widget name).
const FACET_WIDGETS = [ 'Terms', 'Histogram', 'Pivot' ];

// DEMO-SPEC §5.4 hints by error code.
const ERROR_HINTS =
	{
		FACET_UNAUTHENTICATED: 'No session. Pick a signed-in user in the DEMO switcher (top right).',
		FACET_PARAM_INVALID: 'A scope parameter is invalid (Detail names it). For My projects, pick at least one role, or turn the switch off and on to get the default roles back.',
		FACET_FORBIDDEN: 'This principal may not facet an entity the request reads.',
		FACET_UNKNOWN_SCOPE: 'The scope is unknown or not visible to this principal.',
		DEMO_UPSTREAM_UNAVAILABLE: 'The demo host could not reach this domain\'s server. Restart npm start.',
		DEMO_NETWORK: 'The demo host is not answering: run npm start in example_applications/faceting_demo.',
		DEMO_NOT_FOUND: 'The demo host does not know this route.'
	};

const DEFAULT_EMPTY_HINT = 'Try removing a filter.';

// Chips listed by name before the line collapses the rest into "+n more".
const MAX_CHIP_VALUES = 3;

const _ViewConfiguration =
	{
		ViewIdentifier: 'FacetDemo-Page',
		DefaultRenderable: 'FacetDemo-Page-Body',
		DefaultDestinationAddress: '#FD-Page',
		AutoRender: false,

		CSS: /*css*/`
			.fd-page-head { position: relative; margin: 20px 0 14px; padding: 16px 18px 12px; overflow: hidden; background: var(--fd-surface, #ffffff);
				border: 1px solid var(--fd-border, #dfe3e9); border-radius: var(--fd-radius, 10px); box-shadow: var(--fd-shadow, 0 1px 2px rgba(16, 24, 40, 0.06)); }
			.fd-loading-bar { position: absolute; top: 0; left: 0; right: 0; height: 2px; overflow: hidden; opacity: 0; transition: opacity 120ms; }
			.fd-loading-on .fd-loading-bar { opacity: 1; }
			.fd-loading-bar::after { content: ''; position: absolute; top: 0; bottom: 0; left: -30%; width: 30%; background: var(--fd-accent, #3b5bdb); animation: fd-indeterminate 1.1s ease-in-out infinite; }
			@keyframes fd-indeterminate { 0% { left: -30%; } 100% { left: 100%; } }
			.fd-head-grid { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px 24px; flex-wrap: wrap; }
			.fd-head-text { min-width: 280px; flex: 1 1 520px; }
			.fd-title-row { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
			.fd-title { margin: 0; font-size: 22px; font-weight: 600; color: var(--fd-text, #1b2230); }
			.fd-ref { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--fd-text-faint, #8a94a3); cursor: help; border-bottom: 1px dotted var(--fd-border-strong, #c5ccd6); }
			.fd-ref .pict-icon { font-size: 12px; }
			.fd-question { margin: 6px 0 0; font-size: 15px; line-height: 1.45; color: var(--fd-text, #1b2230); max-width: 780px; }
			.fd-note { display: flex; align-items: flex-start; gap: 6px; margin: 8px 0 0; padding: 6px 10px; max-width: 780px; border-radius: var(--fd-radius-sm, 6px); font-size: 12.5px; line-height: 1.45;
				background: var(--fd-info-soft, #e7f1fb); color: var(--fd-text, #1b2230); }
			.fd-note .pict-icon { flex: 0 0 auto; margin-top: 2px; color: var(--fd-info, #1c64b0); }
			.fd-filters { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--fd-border, #dfe3e9); }
			.fd-filters-label { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fd-text-faint, #8a94a3); margin-right: 2px; }
			.fd-filter { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 1px 2px 1px 9px; border-radius: 999px; font-size: 12px; line-height: 20px;
				background: var(--fd-accent-soft, #e8edfd); color: var(--fd-text, #1b2230); border: 1px solid transparent; }
			.fd-filter-Scope { background: var(--fd-surface-2, #f0f2f5); border-color: var(--fd-border, #dfe3e9); }
			.fd-filter-name { color: var(--fd-text-muted, #5d6878); }
			.fd-filter-value { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.fd-filter-x { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; margin: 0; padding: 0; border: 0; border-radius: 50%;
				background: none; color: var(--fd-text-muted, #5d6878); cursor: pointer; font-size: 11px; }
			.fd-filter-x:hover { background: var(--fd-surface, #ffffff); color: var(--fd-error, #c92a2a); }
			.fd-filter-x:focus-visible { outline: 2px solid var(--fd-accent, #3b5bdb); outline-offset: 1px; }
			.fd-filter-none { font-size: 12px; color: var(--fd-text-faint, #8a94a3); }
			.fd-filters-spacer { flex: 1 1 auto; }
			.fd-reset, .fd-toggle { display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border: 0; background: none; font: inherit; font-size: 12px; color: var(--fd-accent, #3b5bdb); cursor: pointer; border-radius: 4px; }
			.fd-reset:hover, .fd-toggle:hover { background: var(--fd-accent-soft, #e8edfd); }
			.fd-reset:focus-visible, .fd-toggle:focus-visible { outline: 2px solid var(--fd-accent, #3b5bdb); outline-offset: 1px; }
			.fd-toggle { color: var(--fd-text-muted, #5d6878); }
			.fd-toggle[aria-pressed="true"] { color: var(--fd-accent, #3b5bdb); font-weight: 600; }
			.fd-try { margin: 8px 0 0; font-size: 12px; line-height: 1.45; color: var(--fd-text-muted, #5d6878); }
			.fd-try strong { color: var(--fd-text, #1b2230); font-weight: 600; margin-right: 4px; }
			.fd-summary { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
			.fd-total-line { display: flex; align-items: baseline; gap: 8px; }
			.fd-total { font-size: 28px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; color: var(--fd-text, #1b2230); }
			.fd-noun { font-size: 14px; color: var(--fd-text-muted, #5d6878); }
			.fd-chips { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; max-width: 460px; }
			.fd-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 11px; line-height: 18px; white-space: nowrap; cursor: help;
				background: var(--fd-surface-2, #f0f2f5); color: var(--fd-text-muted, #5d6878); border: 1px solid var(--fd-border, #dfe3e9); font-variant-numeric: tabular-nums; }
			.fd-chip-ok { background: var(--fd-ok-soft, #e6f4ea); color: var(--fd-ok, #2b8a3e); border-color: transparent; }
			.fd-chip-warn { background: var(--fd-warn-soft, #fdf3e1); color: var(--fd-warn, #a8620a); border-color: transparent; }
			.fd-chip-accent { background: var(--fd-accent-soft, #e8edfd); color: var(--fd-accent, #3b5bdb); border-color: transparent; }
			.fd-chip-info { background: var(--fd-info-soft, #e7f1fb); color: var(--fd-info, #1c64b0); border-color: transparent; }
			.fd-chip-mono { font-family: var(--fd-mono, ui-monospace, Menlo, monospace); }
			.fd-chip-internal { background: transparent; border-style: dotted; font-family: var(--fd-mono, ui-monospace, Menlo, monospace); }
			.fd-pending { font-size: 13px; color: var(--fd-text-faint, #8a94a3); }
			.fd-banner { margin-top: 14px; padding: 12px 14px; border-radius: var(--fd-radius-sm, 6px); background: var(--fd-error-soft, #fdecec);
				border-left: 3px solid var(--fd-error, #c92a2a); color: var(--fd-text, #1b2230); }
			.fd-banner-title { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--fd-error, #c92a2a); }
			.fd-banner-title code { font-family: var(--fd-mono, ui-monospace, Menlo, monospace); }
			.fd-banner-msg { margin-top: 4px; }
			.fd-banner-detail { margin-top: 6px; padding: 6px 8px; border-radius: 4px; font-family: var(--fd-mono, ui-monospace, Menlo, monospace); font-size: 12px;
				background: var(--fd-code-bg, #f3f5f8); color: var(--fd-code-text, #24292f); overflow-x: auto; white-space: pre; }
			.fd-banner-hint { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 12px; color: var(--fd-text-muted, #5d6878); }
			.fd-tabs { display: flex; gap: 4px; margin: 0 0 6px; border-bottom: 1px solid var(--fd-border, #dfe3e9); overflow-x: auto; }
			.fd-tabs:empty { display: none; }
			.fd-tab { display: inline-flex; align-items: center; gap: 8px; margin: 0 0 -1px; padding: 8px 14px; border: 0; border-bottom: 2px solid transparent; background: none;
				font: inherit; font-size: 13px; color: var(--fd-text-muted, #5d6878); white-space: nowrap; cursor: pointer; transition: color 100ms, border-color 100ms; }
			.fd-tab:hover { color: var(--fd-text, #1b2230); }
			.fd-tab:focus-visible { outline: 2px solid var(--fd-accent, #3b5bdb); outline-offset: -2px; }
			.fd-tab-active { color: var(--fd-accent, #3b5bdb); border-bottom-color: var(--fd-accent, #3b5bdb); font-weight: 600; }
			.fd-tab-count { padding: 0 7px; border-radius: 999px; font-size: 11px; font-variant-numeric: tabular-nums; background: var(--fd-surface-2, #f0f2f5); color: var(--fd-text-muted, #5d6878); }
			.fd-tab-note { margin: 0 0 14px; font-size: 12px; color: var(--fd-text-muted, #5d6878); }
			.fd-tab-note:empty { display: none; }
			.fd-top { display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px; }
			.fd-top:empty { display: none; }
			.fd-grid { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: var(--fd-gap, 16px); align-items: start; }
			.fd-rail, .fd-main { display: flex; flex-direction: column; gap: var(--fd-gap, 16px); min-width: 0; }
			.fd-card { min-width: 0; padding: 14px 16px; background: var(--fd-surface, #ffffff); border: 1px solid var(--fd-border, #dfe3e9);
				border-radius: var(--fd-radius, 10px); box-shadow: var(--fd-shadow, 0 1px 2px rgba(16, 24, 40, 0.06)); transition: opacity 120ms; }
			.fd-card-Scope { padding: 10px 14px; }
			.fd-card-Placeholder { font-size: 12px; color: var(--fd-text-faint, #8a94a3); }
			.fd-body-loading .fd-card { opacity: 0.6; }
			@media (max-width: 960px)
			{
				.fd-grid { grid-template-columns: minmax(0, 1fr); }
				.fd-summary { align-items: flex-start; }
				.fd-chips { justify-content: flex-start; }
			}
		`,

		Templates:
			[
				{
					Hash: 'FacetDemo-Page-Body-Template',
					Template: /*html*/`
<div id="FD-Page-Head" class="fd-page-head"></div>
<div id="FD-Tabs" class="fd-tabs" role="tablist"></div>
<div id="FD-Tab-Note" class="fd-tab-note"></div>
<div id="FD-Body" class="fd-body">
	<div id="FD-Top" class="fd-top">{~TS:FacetDemo-Panel-Slot-Template:AppData.FacetDemo.PageView.Top~}</div>
	<div class="fd-grid">
		<div id="FD-Rail" class="fd-rail">{~TS:FacetDemo-Panel-Slot-Template:AppData.FacetDemo.PageView.Rail~}</div>
		<div id="FD-Main" class="fd-main">{~TS:FacetDemo-Panel-Slot-Template:AppData.FacetDemo.PageView.Main~}</div>
	</div>
</div>`
				},
				{
					Hash: 'FacetDemo-Panel-Slot-Template',
					Template: /*html*/`<section class="fd-card fd-card-{~D:Record.Widget~}" id="{~D:Record.PanelID~}">{~D:Record.Placeholder~}</section>`
				},
				{
					Hash: 'FacetDemo-Page-Head-Template',
					Template: /*html*/`
<div class="fd-head {~D:Record.LoadingClass~}">
	<div class="fd-loading-bar" aria-hidden="true"></div>
	<div class="fd-head-grid">
		<div class="fd-head-text">
			<div class="fd-title-row"><h1 class="fd-title">{~D:Record.Title~}</h1>{~TS:FacetDemo-Page-Ref-Template:Record.RefSlot~}</div>
			<p class="fd-question">{~D:Record.Question~}</p>
			{~TS:FacetDemo-Page-Note-Template:Record.NoteSlot~}
		</div>
		{~TS:FacetDemo-Page-Strip-Template:Record.StripSlot~}
		{~TS:FacetDemo-Page-Pending-Template:Record.PendingSlot~}
	</div>
	<div class="fd-filters" role="group" aria-label="Active filters">
		<span class="fd-filters-label">Filters</span>
		{~TS:FacetDemo-Page-Filter-Template:Record.Filters~}
		{~TS:FacetDemo-Page-No-Filter-Template:Record.NoFilterSlot~}
		<span class="fd-filters-spacer"></span>
		<button type="button" class="fd-reset" title="Back to this page's initial request" onclick="{~P~}.views['FacetDemo-Page'].resetPage()">{~I:Refresh~} Reset filters</button>
		<button type="button" class="fd-toggle" aria-pressed="{~D:Record.InternalsPressed~}" title="Show the contract vocabulary on the cards (Fold, CountMode, Relaxed, Disjunctive): the inspector always has it" onclick="{~P~}.PictApplication.toggleInternals()">{~I:Code~} Show internals</button>
	</div>
	{~TS:FacetDemo-Page-Try-Template:Record.TrySlot~}
	{~TS:FacetDemo-Page-Banner-Template:Record.ErrorSlot~}
</div>`
				},
				{
					Hash: 'FacetDemo-Page-Ref-Template',
					Template: /*html*/`<span class="fd-ref" title="{~D:Record.Tip~}">{~I:Info~} {~D:Record.Text~}</span>`
				},
				{
					Hash: 'FacetDemo-Page-Note-Template',
					Template: /*html*/`<p class="fd-note">{~I:Info~}<span>{~D:Record.Text~}</span></p>`
				},
				{
					Hash: 'FacetDemo-Page-Filter-Template',
					Template: /*html*/`<span class="fd-filter fd-filter-{~D:Record.Kind~}" title="{~D:Record.Tip~}"><span class="fd-filter-name">{~D:Record.Name~}</span><span class="fd-filter-value">{~D:Record.Value~}</span><button type="button" class="fd-filter-x" aria-label="Remove {~D:Record.Name~} {~D:Record.Value~}" title="Remove" onclick="{~P~}.views['FacetDemo-Page'].removeFilter({~D:Record.Index~})">{~I:Close~}</button></span>`
				},
				{
					Hash: 'FacetDemo-Page-No-Filter-Template',
					Template: /*html*/`<span class="fd-filter-none">{~D:Record.Text~}</span>`
				},
				{
					Hash: 'FacetDemo-Page-Try-Template',
					Template: /*html*/`<p class="fd-try"><strong>Try</strong>{~D:Record.Text~}</p>`
				},
				{
					Hash: 'FacetDemo-Page-Strip-Template',
					Template: /*html*/`
<div class="fd-summary" aria-live="polite">
	<div class="fd-total-line"><span class="fd-total">{~D:Record.TotalText~}</span><span class="fd-noun">{~D:Record.NounText~}</span></div>
	<div class="fd-chips">{~TS:FacetDemo-Page-Chip-Template:Record.Chips~}</div>
</div>`
				},
				{
					Hash: 'FacetDemo-Page-Chip-Template',
					Template: /*html*/`<span class="fd-chip fd-chip-{~D:Record.Tone~}" title="{~D:Record.Tip~}">{~TS:FacetDemo-Page-Chip-Check-Template:Record.CheckSlot~}{~D:Record.Text~}</span>`
				},
				{
					Hash: 'FacetDemo-Page-Chip-Check-Template',
					Template: /*html*/`{~I:Check~}`
				},
				{
					Hash: 'FacetDemo-Page-Pending-Template',
					Template: /*html*/`<div class="fd-summary"><span class="fd-pending">{~D:Record.Text~}</span></div>`
				},
				{
					Hash: 'FacetDemo-Page-Banner-Template',
					Template: /*html*/`
<div class="fd-banner" role="alert">
	<div class="fd-banner-title">{~I:Error~} <code>{~D:Record.Code~}</code> · {~D:Record.Status~}</div>
	<div class="fd-banner-msg">{~D:Record.Message~}</div>
	{~TS:FacetDemo-Page-Banner-Detail-Template:Record.DetailSlot~}
	<div class="fd-banner-hint">{~I:Info~} {~D:Record.Hint~}</div>
</div>`
				},
				{
					Hash: 'FacetDemo-Page-Banner-Detail-Template',
					Template: /*html*/`<div class="fd-banner-detail">{~D:Record.Text~}</div>`
				},
				{
					Hash: 'FacetDemo-Page-Tabs-Template',
					Template: /*html*/`{~TS:FacetDemo-Page-Tab-Template:Record.Tabs~}`
				},
				{
					Hash: 'FacetDemo-Page-Tab-Template',
					Template: /*html*/`<button type="button" role="tab" aria-selected="{~D:Record.Selected~}" class="fd-tab {~D:Record.ActiveClass~}" onclick="{~P~}.views['FacetDemo-Page'].selectTab('{~D:Record.Hash~}')">{~D:Record.Label~}{~TS:FacetDemo-Page-Tab-Count-Template:Record.CountSlot~}</button>`
				},
				{
					Hash: 'FacetDemo-Page-Tab-Count-Template',
					Template: /*html*/`<span class="fd-tab-count" title="{~D:Record.Tip~}">{~D:Record.Text~}</span>`
				},
				{
					Hash: 'FacetDemo-Page-Tab-Note-Template',
					Template: /*html*/`{~D:Record.Text~}`
				}
			],

		Renderables:
			[
				{
					RenderableHash: 'FacetDemo-Page-Body',
					TemplateHash: 'FacetDemo-Page-Body-Template',
					ContentDestinationAddress: '#FD-Page',
					RenderMethod: 'replace'
				},
				{
					RenderableHash: 'FacetDemo-Page-Head',
					TemplateHash: 'FacetDemo-Page-Head-Template',
					ContentDestinationAddress: '#FD-Page-Head',
					DefaultTemplateRecordAddress: 'AppData.FacetDemo.Head',
					RenderMethod: 'replace'
				},
				{
					RenderableHash: 'FacetDemo-Page-Tabs',
					TemplateHash: 'FacetDemo-Page-Tabs-Template',
					ContentDestinationAddress: '#FD-Tabs',
					DefaultTemplateRecordAddress: 'AppData.FacetDemo.TabsView',
					RenderMethod: 'replace'
				},
				{
					RenderableHash: 'FacetDemo-Page-Tab-Note',
					TemplateHash: 'FacetDemo-Page-Tab-Note-Template',
					ContentDestinationAddress: '#FD-Tab-Note',
					DefaultTemplateRecordAddress: 'AppData.FacetDemo.TabNoteView',
					RenderMethod: 'replace'
				}
			]
	};

class PictViewFacetDemoPage extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this._Unsubscribers = [];
		this._Page = null;
		this._ActivePanels = [];
		this._FilterTargets = [];
	}

	/**
	 * The page definition of a hash.
	 *
	 * @param {string} pPageHash
	 * @return {Record<string, any>|null}
	 */
	pageDefinition(pPageHash)
	{
		return libFacetDemoPages.Pages.find((pPage) => { return pPage.Hash === pPageHash; }) || null;
	}

	/**
	 * The panel container id of a layout entry (facet widgets by facet key, the others by widget name, so the
	 * Compare panel and the B ToDo bars of LabFormsB do not collide).
	 *
	 * @param {Record<string, any>} pPanel
	 * @return {string}
	 */
	panelID(pPanel)
	{
		let tmpSuffix = ((FACET_WIDGETS.indexOf(pPanel.Widget) >= 0) && pPanel.FacetKey) ? pPanel.FacetKey : pPanel.Widget;
		return `FD-P-${pPanel.Group}-${tmpSuffix}`;
	}

	/**
	 * @param {Record<string, any>} pPage
	 * @return {Record<string, any>|null} the active tab definition (tabbed pages only)
	 */
	activeTab(pPage)
	{
		if (!pPage || !Array.isArray(pPage.Tabs) || (pPage.Tabs.length < 1))
		{
			return null;
		}
		let tmpWanted = this.pict.AppData.FacetDemo.ActiveTab[pPage.Hash];
		return pPage.Tabs.find((pTab) => { return pTab.Hash === tmpWanted; }) || pPage.Tabs[0];
	}

	/**
	 * The groups a page shows right now (a tabbed page: the active tab's group).
	 *
	 * @param {Record<string, any>} pPage
	 * @return {Array<string>}
	 */
	visibleGroups(pPage)
	{
		let tmpTab = this.activeTab(pPage);
		return tmpTab ? [ tmpTab.Group ] : (pPage ? pPage.Groups.slice() : []);
	}

	/**
	 * @param {Record<string, any>} pPage
	 * @return {Record<string, Array<Record<string, any>>>} { Top, Rail, Main }
	 */
	_layout(pPage)
	{
		let tmpTab = this.activeTab(pPage);
		return tmpTab ? (pPage.Layout[tmpTab.Hash] || {}) : (pPage.Layout || {});
	}

	/**
	 * Expand a 'Described' entry into the panels its group derived from Describe (or one placeholder).
	 *
	 * @param {Record<string, any>} pEntry
	 * @param {string} pRegion
	 * @return {Array<Record<string, any>>}
	 */
	_expand(pEntry, pRegion)
	{
		if (pEntry.Widget !== 'Described')
		{
			return [ pEntry ];
		}
		let tmpState = this.pict.providers.Facet.group(pEntry.Group);
		if (!tmpState || !Array.isArray(tmpState.DescribedPanels))
		{
			return (pRegion === 'Rail') ? [ { Widget: 'Placeholder', Group: pEntry.Group, Placeholder: 'Reading the facet list from GET /1.0/Facet/Describe…' } ] : [];
		}
		return tmpState.DescribedPanels.filter((pPanel) => { return pPanel.Region === pRegion; });
	}

	/**
	 * Render a page (router target through the application's showPage).
	 *
	 * @param {string} pPageHash
	 */
	showPage(pPageHash)
	{
		let tmpPage = this.pageDefinition(pPageHash);
		if (!tmpPage)
		{
			return false;
		}
		this._Page = tmpPage;
		let tmpLayout = this._layout(tmpPage);
		let tmpPageView = { Top: [], Rail: [], Main: [] };
		this._ActivePanels = [];
		[ 'Top', 'Rail', 'Main' ].forEach(
			(pRegion) =>
			{
				(Array.isArray(tmpLayout[pRegion]) ? tmpLayout[pRegion] : []).forEach(
					(pLayoutEntry) =>
					{
						this._expand(pLayoutEntry, pRegion).forEach(
							(pEntry) =>
							{
								let tmpPanel = Object.assign({}, pEntry,
									{
										PanelID: (pEntry.Widget === 'Placeholder') ? `FD-P-${pEntry.Group}-Placeholder` : this.panelID(pEntry),
										Region: pRegion,
										Noun: tmpPage.Noun ? tmpPage.Noun.Many : 'rows',
										NounOne: tmpPage.Noun ? tmpPage.Noun.One : 'row',
										EmptyHint: pEntry.EmptyHint || tmpPage.EmptyHint || DEFAULT_EMPTY_HINT
									});
								this._ActivePanels.push(tmpPanel);
								tmpPageView[pRegion].push({ PanelID: tmpPanel.PanelID, Widget: tmpPanel.Widget, Placeholder: libFacetDisplay.text(tmpPanel.Placeholder || '') });
							});
					});
			});
		this.pict.AppData.FacetDemo.PageView = tmpPageView;
		this._resubscribe(tmpPage);
		this.render('FacetDemo-Page-Body');
		return true;
	}

	/**
	 * Follow every group of the page (both tabs: Compare on tab B reads A).
	 *
	 * @param {Record<string, any>} pPage
	 */
	_resubscribe(pPage)
	{
		this._Unsubscribers.forEach((fUnsubscribe) => { fUnsubscribe(); });
		this._Unsubscribers = [];
		let tmpProvider = this.pict.providers.Facet;
		pPage.Groups.forEach(
			(pGroupHash) =>
			{
				this._Unsubscribers.push(tmpProvider.subscribe(pGroupHash, (pState, pReason) => { this._onGroupEvent(pGroupHash, pReason); }));
			});
	}

	/**
	 * @param {string} pGroupHash
	 * @param {string} pReason
	 */
	_onGroupEvent(pGroupHash, pReason)
	{
		if (!this._Page)
		{
			return;
		}
		let tmpRelevant = (this.visibleGroups(this._Page).indexOf(pGroupHash) >= 0) || this._ActivePanels.some((pPanel) => { return (pPanel.Group === pGroupHash) || (pPanel.CompareGroup === pGroupHash); });
		if (!tmpRelevant)
		{
			// e.g. LabFormsB answering while tab A shows: only the tab counts change.
			this.renderTabs();
			return;
		}
		if (pReason === 'Stream')
		{
			// The domain's change stream opened, broke off or closed: the Live chip and the Change panel say so.
			this.renderHead();
			this.renderPanels({ Group: pGroupHash, Widgets: [ 'Change' ] });
			return;
		}
		if ((pReason === 'Records') || (pReason === 'Count'))
		{
			this.preparePanels({ Group: pGroupHash, Widgets: [ 'Records' ] });
			this.renderPanels({ Group: pGroupHash, Widgets: [ 'Records' ] });
			return;
		}
		this.renderHead();
		this.renderTabs();
		this._updateLoading();
		if ((pReason === 'Loading') || (pReason === 'State'))
		{
			this.renderPanels({ Group: pGroupHash, Widgets: [ 'Scope' ] });
			return;
		}
		this.preparePanels({ Group: pGroupHash });
		this.renderPanels({ Group: pGroupHash });
	}

	/**
	 * Dim the cards while a visible group is loading (the previous answer stays on screen).
	 */
	_updateLoading()
	{
		if (!this._Page)
		{
			return;
		}
		let tmpProvider = this.pict.providers.Facet;
		let tmpLoading = this.visibleGroups(this._Page).some((pGroupHash) => { let tmpState = tmpProvider.group(pGroupHash); return !!tmpState && (tmpState.Status === 'Loading'); });
		if (tmpLoading)
		{
			this.pict.ContentAssignment.addClass('#FD-Body', 'fd-body-loading');
		}
		else
		{
			this.pict.ContentAssignment.removeClass('#FD-Body', 'fd-body-loading');
		}
	}

	/**
	 * The question's total for a group: the envelope Total, or (Total: false groups such as the TuplePivot
	 * variant) the first facet's Total.
	 *
	 * @param {Record<string, any>} pState
	 * @return {number|null}
	 */
	_questionTotal(pState)
	{
		let tmpEnvelope = pState ? pState.Envelope : null;
		if (!tmpEnvelope)
		{
			return null;
		}
		if (typeof(tmpEnvelope.Total) === 'number')
		{
			return tmpEnvelope.Total;
		}
		let tmpFirst = (Array.isArray(pState.Facets) && pState.Facets[0]) ? pState.Facets[0].Key : null;
		let tmpFacet = (tmpFirst && tmpEnvelope.Facets) ? tmpEnvelope.Facets[tmpFirst] : null;
		return (tmpFacet && (typeof(tmpFacet.Total) === 'number')) ? tmpFacet.Total : null;
	}

	/**
	 * The name a page gives a facet: its panel title, Describe's title, else the key de-camel-cased.
	 *
	 * @param {Record<string, any>} pState
	 * @param {string} pFacetKey
	 * @return {string}
	 */
	_facetName(pState, pFacetKey)
	{
		let tmpPanel = this._ActivePanels.find((pCandidate) => { return (pCandidate.Group === pState.Hash) && (pCandidate.FacetKey === pFacetKey) && pCandidate.Title; });
		if (tmpPanel)
		{
			return tmpPanel.Title;
		}
		let tmpSpec = pState.Facets.find((pCandidate) => { return pCandidate.Key === pFacetKey; });
		let tmpCapabilities = this.pict.providers.Facet.entityCapabilities(pState.Domain, pState.Entity);
		if (tmpSpec && tmpCapabilities && Array.isArray(tmpCapabilities.Facets) && (typeof(tmpSpec.Facet) === 'string'))
		{
			let tmpDescribed = tmpCapabilities.Facets.find((pCandidate) => { return pCandidate.Facet === tmpSpec.Facet; });
			if (tmpDescribed && (tmpDescribed.Title || tmpDescribed.DisplayName))
			{
				return tmpDescribed.Title || tmpDescribed.DisplayName;
			}
		}
		let tmpFacet = (pState.Envelope && pState.Envelope.Facets) ? pState.Envelope.Facets[pFacetKey] : null;
		return (tmpFacet && tmpFacet.DisplayName) ? tmpFacet.DisplayName : libFacetDisplay.deCamel(pFacetKey);
	}

	/**
	 * The active filters of a group as removable chips: every ON scope (with its params), then every selection,
	 * named the way the cards name them.  this._FilterTargets[i] says what chip i removes.
	 *
	 * @param {Record<string, any>} pState
	 * @return {Array<Record<string, any>>}
	 */
	_activeFilters(pState)
	{
		let tmpProvider = this.pict.providers.Facet;
		let tmpChips = [];
		this._FilterTargets = [];
		if (!pState)
		{
			return tmpChips;
		}
		let tmpScopePanel = this._ActivePanels.find((pPanel) => { return (pPanel.Widget === 'Scope') && (pPanel.Group === pState.Hash); }) || {};
		let tmpLabels = tmpScopePanel.Labels || {};
		let tmpDescriptions = tmpScopePanel.Descriptions || {};
		let tmpHide = Array.isArray(tmpScopePanel.Hide) ? tmpScopePanel.Hide : [];
		Object.keys(pState.ScopeState || {}).forEach(
			(pScope) =>
			{
				let tmpEntry = pState.ScopeState[pScope];
				if (!tmpEntry || (tmpEntry.On !== true) || (tmpHide.indexOf(pScope) >= 0))
				{
					return;
				}
				let tmpParams = Object.keys(tmpEntry.Params || {}).map((pParam) => { let tmpValue = tmpEntry.Params[pParam]; return Array.isArray(tmpValue) ? ((tmpValue.length > 0) ? tmpValue.join(', ') : `no ${pParam.toLowerCase()}`) : String(tmpValue); });
				this._FilterTargets.push({ Kind: 'Scope', Group: pState.Hash, Scope: pScope });
				tmpChips.push(
					{
						Index: this._FilterTargets.length - 1,
						Kind: 'Scope',
						Name: libFacetDisplay.text(`${tmpLabels[pScope] || libFacetDisplay.deCamel(String(pScope).split('.').pop())}${(tmpParams.length > 0) ? ':' : ''}`),
						Value: libFacetDisplay.text(tmpParams.join('; ')),
						Tip: libFacetDisplay.text(`Scope ${pScope}${tmpDescriptions[pScope] ? `: ${tmpDescriptions[pScope]}` : ''}`)
					});
			});
		let tmpOrder = pState.Facets.map((pSpec) => { return pSpec.Key; });
		Object.keys(pState.Selections || {}).sort((pLeft, pRight) => { return tmpOrder.indexOf(pLeft) - tmpOrder.indexOf(pRight); }).forEach(
			(pFacetKey) =>
			{
				let tmpClause = pState.Selections[pFacetKey];
				if (!tmpClause)
				{
					return;
				}
				let tmpValue = '';
				let tmpRange = libFacetSelection.rangeOf(tmpClause);
				if (tmpRange)
				{
					tmpValue = libFacetDisplay.rangeText(tmpClause.Values, tmpClause.EndExclusive !== false);
				}
				else
				{
					let tmpKeys = libFacetSelection.selectedKeysOf(tmpClause);
					let tmpNames = tmpKeys.map(
						(pKey) =>
						{
							if (pKey === '')
							{
								return '(blank)';
							}
							let tmpLabel = tmpProvider.labelOf(pState.Hash, pFacetKey, pKey);
							if (tmpLabel && !tmpLabel.LabelResolved)
							{
								return `#${pKey}`;
							}
							return (tmpLabel && (typeof(tmpLabel.Label) === 'string') && (tmpLabel.Label.length > 0)) ? tmpLabel.Label : String(pKey);
						});
					tmpValue = (tmpNames.length > MAX_CHIP_VALUES) ? `${tmpNames.slice(0, MAX_CHIP_VALUES - 1).join(', ')} +${tmpNames.length - (MAX_CHIP_VALUES - 1)} more` : tmpNames.join(', ');
				}
				this._FilterTargets.push({ Kind: 'Selection', Group: pState.Hash, FacetKey: pFacetKey });
				tmpChips.push(
					{
						Index: this._FilterTargets.length - 1,
						Kind: 'Selection',
						Name: libFacetDisplay.text(`${this._facetName(pState, pFacetKey)}:`),
						Value: libFacetDisplay.text(tmpValue),
						Tip: libFacetDisplay.text(`${tmpClause.Type} on ${tmpClause.FilterKey || tmpClause.FilterByColumn}`)
					});
			});
		return tmpChips;
	}

	/**
	 * Build AppData.FacetDemo.Head (DEMO-SPEC §7.2) and render it.
	 */
	renderHead()
	{
		let tmpPage = this._Page;
		if (!tmpPage)
		{
			return;
		}
		let tmpProvider = this.pict.providers.Facet;
		let tmpGroupHash = this.visibleGroups(tmpPage)[0];
		let tmpState = tmpProvider.group(tmpGroupHash);
		let tmpCurrent = !!tmpState && (tmpState.PrincipalKey === tmpProvider.principalKey());
		let tmpNotes = [];
		if (tmpPage.Note)
		{
			tmpNotes.push(tmpPage.Note);
		}
		if (tmpState && Array.isArray(tmpState.DescribedSkipped) && (tmpState.DescribedSkipped.length > 0))
		{
			tmpNotes.push(`Not drawn: ${tmpState.DescribedSkipped.map((pSkipped) => { return `${pSkipped.Title} (${pSkipped.Reason})`; }).join(', ')}.`);
		}
		let tmpFilters = this._activeFilters(tmpState);
		let tmpHead =
			{
				Title: libFacetDisplay.text(tmpPage.Title),
				Question: libFacetDisplay.text(tmpPage.Question),
				RefSlot: tmpPage.Reference ? [ { Text: libFacetDisplay.text(tmpPage.Reference.Text), Tip: libFacetDisplay.text(tmpPage.Reference.Tip || '') } ] : [],
				NoteSlot: (tmpNotes.length > 0) ? [ { Text: libFacetDisplay.text(tmpNotes.join(' ')) } ] : [],
				TrySlot: tmpPage.Try ? [ { Text: libFacetDisplay.text(tmpPage.Try) } ] : [],
				Filters: tmpFilters,
				NoFilterSlot: (tmpFilters.length < 1) ? [ { Text: (tmpState && (tmpState.Hash === 'LabFormsB')) ? 'None: variant B has no list clause to filter with' : 'None: every row this user may see' } ] : [],
				InternalsPressed: tmpProvider.showInternals() ? 'true' : 'false',
				LoadingClass: (tmpState && (tmpState.Status === 'Loading')) ? 'fd-loading-on' : '',
				StripSlot: [],
				PendingSlot: [],
				ErrorSlot: []
			};
		if (tmpState && (tmpState.Status === 'Error') && tmpState.Error)
		{
			let tmpError = tmpState.Error;
			tmpHead.ErrorSlot =
				[
					{
						Code: libFacetDisplay.text(tmpError.Code),
						Status: libFacetDisplay.text(tmpError.Status),
						Message: libFacetDisplay.text(tmpError.Message),
						DetailSlot: tmpError.Detail ? [ { Text: libFacetDisplay.compactJSON(tmpError.Detail) } ] : [],
						Hint: libFacetDisplay.text(ERROR_HINTS[tmpError.Code] || tmpError.Message || 'The request failed.')
					}
				];
			tmpHead.PendingSlot = [ { Text: 'No answer' } ];
		}
		else if (tmpState && tmpState.Envelope)
		{
			tmpHead.StripSlot = [ this._strip(tmpPage, tmpState, tmpCurrent) ];
		}
		else
		{
			tmpHead.PendingSlot = [ { Text: 'Loading…' } ];
		}
		this.pict.AppData.FacetDemo.Head = tmpHead;
		this.render('FacetDemo-Page-Head');
	}

	/**
	 * The summary strip: Total + noun, then Engine, Exact, timings, ETag, 304, POST count (+ the contract
	 * vocabulary with "Show internals").
	 *
	 * @param {Record<string, any>} pPage
	 * @param {Record<string, any>} pState
	 * @param {boolean} pCurrent - the answer is for the current principal
	 * @return {Record<string, any>}
	 */
	_strip(pPage, pState, pCurrent)
	{
		let tmpEnvelope = pState.Envelope;
		let tmpAnswer = pState.LastAnswer || {};
		let tmpTotal = this._questionTotal(pState);
		let tmpNoun = pPage.Noun ? ((tmpTotal === 1) ? pPage.Noun.One : pPage.Noun.Many) : '';
		let tmpInternals = this.pict.providers.Facet.showInternals();
		let tmpChips = [];
		if (!pCurrent)
		{
			tmpChips.push({ Text: 'previous user', Tone: 'warn', Tip: 'This answer was computed for another principal; a new one is on its way.', CheckSlot: [] });
		}
		if (tmpEnvelope.Engine)
		{
			tmpChips.push({ Text: libFacetDisplay.text(`Engine: ${tmpEnvelope.Engine}`), Tone: 'accent', Tip: 'The engine that answered (Live: computed from the database for this request).', CheckSlot: [] });
		}
		if (tmpAnswer.Stale === true)
		{
			tmpChips.push({ Text: libFacetDisplay.text(`Stale · ${(Math.round((tmpAnswer.LagMS || 0) / 100) / 10).toFixed(1)} s old`), Tone: 'warn', Tip: 'Freshness Bounded: a cached answer computed before the latest change (never older than MaxLagMS). The server refreshes it in the background and the page asks again in a moment.', CheckSlot: [] });
		}
		else if (tmpEnvelope.Exact === true)
		{
			tmpChips.push({ Text: 'Exact', Tone: 'ok', Tip: 'Every count is exact and current.', CheckSlot: [ {} ] });
		}
		else
		{
			tmpChips.push({ Text: 'Approximate', Tone: 'warn', Tip: 'Some counts are estimates.', CheckSlot: [] });
		}
		// M4: what the server's cache did, the freshness it applied, and why this answer was fetched.
		if (tmpAnswer.CacheStatus)
		{
			let tmpCacheTone = ((tmpAnswer.CacheStatus === 'Hit') || (tmpAnswer.CacheStatus === 'NotModified')) ? 'ok' : ((tmpAnswer.CacheStatus === 'Stale') ? 'warn' : 'neutral');
			tmpChips.push({ Text: libFacetDisplay.text(`Cache: ${tmpAnswer.CacheStatus}`), Tone: tmpCacheTone, Tip: libFacetDisplay.text(`${CACHE_TIPS[tmpAnswer.CacheStatus] || 'X-Retold-Facet-Cache'}${tmpAnswer.Seq ? ` Covers changes up to ${tmpAnswer.Seq}.` : ''}`), CheckSlot: [] });
		}
		else if (tmpAnswer.Cached === true)
		{
			tmpChips.push({ Text: 'Cached', Tone: 'ok', Tip: 'The server answered from its result cache.', CheckSlot: [] });
		}
		if (tmpAnswer.Freshness)
		{
			tmpChips.push({ Text: libFacetDisplay.text(tmpAnswer.Freshness.replace(/;\s*upgraded=/, ' ↑ ')), Tone: /upgraded/.test(tmpAnswer.Freshness) ? 'accent' : 'neutral', Tip: libFacetDisplay.text(`X-Retold-Facet-Freshness: ${tmpAnswer.Freshness}. The page asks for Bounded (a cached answer up to 5 s old may come back marked Stale); after my own write (read-your-writes) or with a MinSeq from the change stream the server answers Exact.`), CheckSlot: [] });
		}
		if (tmpInternals && tmpAnswer.Seq)
		{
			tmpChips.push({ Text: libFacetDisplay.text(`Seq ${libFacetChanges.shortSeq(tmpAnswer.Seq) || tmpAnswer.Seq}`), Tone: 'internal', Tip: libFacetDisplay.text(`X-Retold-Facet-Seq: ${tmpAnswer.Seq} (the last change this answer covers)`), CheckSlot: [] });
		}
		if (tmpAnswer.Trigger)
		{
			let tmpFromStream = /^Live update/.test(tmpAnswer.Trigger);
			tmpChips.push({ Text: libFacetDisplay.text(tmpAnswer.Trigger.replace(/ @ .*$/, '').replace(/ \(.*\)$/, '')), Tone: 'info', Tip: libFacetDisplay.text(tmpFromStream ? `${tmpAnswer.Trigger}: this answer was fetched because the change stream said data it depends on changed (no reload).` : `${tmpAnswer.Trigger}: why this answer was fetched (no gesture on the page).`), CheckSlot: [] });
		}
		let tmpFirstFacet = (Array.isArray(pState.Facets) && pState.Facets[0] && tmpEnvelope.Facets) ? tmpEnvelope.Facets[pState.Facets[0].Key] : null;
		if (tmpInternals && (typeof(tmpEnvelope.Total) !== 'number') && tmpFirstFacet && tmpFirstFacet.CountMode && (tmpFirstFacet.CountMode !== 'Rows'))
		{
			tmpChips.push({ Text: libFacetDisplay.text(tmpFirstFacet.CountMode), Tone: 'internal', Tip: 'The total counts distinct (intake, form type) tuples: the ToDo facet\'s Total (the envelope Total is not requested).', CheckSlot: [] });
		}
		if (tmpInternals && tmpFirstFacet && (tmpFirstFacet.Relaxed === true))
		{
			tmpChips.push({ Text: 'Relaxed', Tone: 'internal', Tip: 'A TenantOnly hop: a form completed by any technician in my lab counts.', CheckSlot: [] });
		}
		let tmpTiming = [];
		if (typeof(tmpEnvelope.ElapsedMS) === 'number')
		{
			tmpTiming.push(`${tmpEnvelope.ElapsedMS} ms server`);
		}
		if (typeof(tmpAnswer.ElapsedMS) === 'number')
		{
			tmpTiming.push(`${Math.round(tmpAnswer.ElapsedMS)} ms round trip`);
		}
		if (tmpTiming.length > 0)
		{
			tmpChips.push({ Text: libFacetDisplay.text(tmpTiming.join(' · ')), Tone: 'neutral', Tip: 'Server ElapsedMS (from the envelope) and the browser round trip through the demo proxy (the inspector splits it).', CheckSlot: [] });
		}
		if (tmpAnswer.ETag)
		{
			tmpChips.push({ Text: `ETag ${libFacetDisplay.shortETag(tmpAnswer.ETag)}`, Tone: 'mono', Tip: libFacetDisplay.text(`${tmpAnswer.ETag}: the Version of this answer (with the server's cache on: the cache key and the generations it depends on, so it changes exactly when a write could change the answer; else a hash of the computed result).`), CheckSlot: [] });
		}
		if (tmpAnswer.NotModified)
		{
			tmpChips.push({ Text: '304 from cache', Tone: 'ok', Tip: 'If-None-Match matched: the server sent no body and the client reused its cached answer.', CheckSlot: [] });
		}
		let tmpPosts = (typeof(tmpAnswer.Posts) === 'number') ? tmpAnswer.Posts : 1;
		tmpChips.push({ Text: `${tmpPosts} POST${(tmpPosts === 1) ? '' : 's'}`, Tone: (tmpPosts === 1) ? 'neutral' : 'warn', Tip: 'Query POSTs sent for the last filter change: widget requests are coalesced per group per tick.', CheckSlot: [] });
		let tmpStream = libFacetChanges.streamLabel(this.pict.providers.Facet.changeState(pState.Domain));
		tmpChips.push({ Text: libFacetDisplay.text(tmpStream.Text), Tone: tmpStream.Tone, Tip: libFacetDisplay.text(tmpStream.Tip), CheckSlot: (tmpStream.Tone === 'ok') ? [ {} ] : [] });
		return { TotalText: libFacetDisplay.count(tmpTotal), NounText: libFacetDisplay.text(tmpNoun), Chips: tmpChips };
	}

	/**
	 * Tabs (LabForms A | B) with each variant's total ('—' until it answered for the current principal), and the
	 * active tab's note.
	 */
	renderTabs()
	{
		let tmpPage = this._Page;
		let tmpTabs = [];
		let tmpNote = '';
		if (tmpPage && Array.isArray(tmpPage.Tabs))
		{
			let tmpProvider = this.pict.providers.Facet;
			let tmpActive = this.activeTab(tmpPage);
			tmpTabs = tmpPage.Tabs.map(
				(pTab) =>
				{
					let tmpState = tmpProvider.group(pTab.Group);
					let tmpTotal = (tmpState && (tmpState.PrincipalKey === tmpProvider.principalKey()) && (tmpState.Status !== 'Error')) ? this._questionTotal(tmpState) : null;
					let tmpIsActive = !!tmpActive && (tmpActive.Hash === pTab.Hash);
					return (
						{
							Hash: libFacetDisplay.text(pTab.Hash),
							Label: libFacetDisplay.text(pTab.Label),
							ActiveClass: tmpIsActive ? 'fd-tab-active' : '',
							Selected: tmpIsActive ? 'true' : 'false',
							CountSlot: [ { Text: (typeof(tmpTotal) === 'number') ? libFacetDisplay.count(tmpTotal) : '—', Tip: (typeof(tmpTotal) === 'number') ? 'forms to do in this variant' : 'not answered yet' } ]
						});
				});
			tmpNote = (tmpActive && tmpActive.Note) ? tmpActive.Note : '';
		}
		this.pict.AppData.FacetDemo.TabsView = { Tabs: tmpTabs };
		this.pict.AppData.FacetDemo.TabNoteView = { Text: libFacetDisplay.text(tmpNote) };
		this.render('FacetDemo-Page-Tabs');
		this.render('FacetDemo-Page-Tab-Note');
	}

	/**
	 * @param {Record<string, any>} pPanel
	 * @param {{ Group?: string, Widgets?: Array<string> }} pFilter
	 * @return {boolean}
	 */
	_matches(pPanel, pFilter)
	{
		if (pFilter.Group && (pPanel.Group !== pFilter.Group) && (pPanel.CompareGroup !== pFilter.Group))
		{
			return false;
		}
		return !(Array.isArray(pFilter.Widgets) && (pFilter.Widgets.indexOf(pPanel.Widget) < 0));
	}

	/**
	 * Let widgets fetch what an answer needs before they draw it (preparePanel; see the header).
	 *
	 * @param {{ Group?: string, Widgets?: Array<string> }} [pFilter]
	 */
	preparePanels(pFilter)
	{
		let tmpFilter = pFilter || {};
		this._ActivePanels.forEach(
			(pPanel) =>
			{
				if (!this._matches(pPanel, tmpFilter))
				{
					return;
				}
				let tmpView = this.pict.views[WIDGET_VIEWS[pPanel.Widget]];
				if (!tmpView || (typeof(tmpView.preparePanel) !== 'function'))
				{
					return;
				}
				try
				{
					tmpView.preparePanel(pPanel);
				}
				catch (pError)
				{
					this.log.error(`FacetDemo-Page: panel [${pPanel.PanelID}] failed to prepare: ${pError.message}`);
				}
			});
	}

	/**
	 * Ask every panel's widget view to render (DEMO-SPEC §7.2).
	 *
	 * @param {{ Group?: string, Widgets?: Array<string> }} [pFilter] - only panels of (or comparing) a group / of some widgets
	 */
	renderPanels(pFilter)
	{
		let tmpFilter = pFilter || {};
		this._ActivePanels.forEach(
			(pPanel) =>
			{
				if (!this._matches(pPanel, tmpFilter))
				{
					return;
				}
				let tmpView = this.pict.views[WIDGET_VIEWS[pPanel.Widget]];
				if (!tmpView || (typeof(tmpView.renderPanel) !== 'function'))
				{
					return;
				}
				try
				{
					tmpView.renderPanel(pPanel);
				}
				catch (pError)
				{
					this.log.error(`FacetDemo-Page: panel [${pPanel.PanelID}] failed to render: ${pError.message}`);
				}
			});
	}

	/**
	 * Tab click (LabForms A | B).
	 *
	 * @param {string} pTabHash
	 */
	selectTab(pTabHash)
	{
		let tmpPage = this._Page;
		if (!tmpPage || !Array.isArray(tmpPage.Tabs) || !tmpPage.Tabs.some((pTab) => { return pTab.Hash === pTabHash; }))
		{
			return;
		}
		this.pict.AppData.FacetDemo.ActiveTab[tmpPage.Hash] = pTabHash;
		this.showPage(tmpPage.Hash);
		this.pict.PictApplication.updateInspectorContext(tmpPage.Hash);
		this.pict.PictApplication.loadPage(tmpPage.Hash);
	}

	/**
	 * Remove one active-filter chip (an ON scope goes off; a selection is cleared).  One POST.
	 *
	 * @param {number} pIndex - into this._FilterTargets
	 */
	removeFilter(pIndex)
	{
		let tmpTarget = this._FilterTargets[pIndex];
		if (!tmpTarget)
		{
			return false;
		}
		let tmpProvider = this.pict.providers.Facet;
		if (tmpTarget.Kind === 'Scope')
		{
			let tmpState = tmpProvider.group(tmpTarget.Group);
			let tmpEntry = (tmpState && tmpState.ScopeState) ? tmpState.ScopeState[tmpTarget.Scope] : null;
			return tmpProvider.setScope(tmpTarget.Group, tmpTarget.Scope, false, tmpEntry ? tmpEntry.Params : undefined);
		}
		return tmpProvider.setSelection(tmpTarget.Group, tmpTarget.FacetKey, null);
	}

	/**
	 * Back to the page's initial request (FacetDemo-Pages InitialScopes / InitialSelections) for the visible groups.
	 */
	resetPage()
	{
		let tmpPage = this._Page;
		if (!tmpPage)
		{
			return;
		}
		let tmpProvider = this.pict.providers.Facet;
		this.visibleGroups(tmpPage).forEach(
			(pGroupHash) =>
			{
				tmpProvider.defineGroup(libFacetDemoPages.Groups[pGroupHash], true);
				tmpProvider.notify(pGroupHash, 'State');
				tmpProvider.refresh(pGroupHash);
			});
	}

	onAfterRender(pRenderable, pRenderDestinationAddress, pRecord, pContent)
	{
		this.pict.CSSMap.injectCSS();
		if (pRenderable && (pRenderable.RenderableHash === 'FacetDemo-Page-Body'))
		{
			this.renderHead();
			this.renderTabs();
			this.preparePanels();
			this.renderPanels();
			this._updateLoading();
		}
		return super.onAfterRender(pRenderable, pRenderDestinationAddress, pRecord, pContent);
	}
}

module.exports = PictViewFacetDemoPage;
module.exports.default_configuration = _ViewConfiguration;
module.exports.WIDGET_VIEWS = WIDGET_VIEWS;
