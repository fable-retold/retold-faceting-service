/**
 * Facet-Inspector -- the collapsible "Request / envelope" drawer (DEMO-SPEC §7.8).  Liftable (a debug panel).
 *
 * Tied to the page on screen: the host calls setContext({ Label, Groups, Domains }) on every route change, and the
 * drawer shows only that page's exchanges (its groups' Query / Records / Count / Lookup calls and its domains'
 * Describe), with an "All pages" toggle.  The bar always names the page and its latest answer, and says so when
 * the page kept an earlier answer (no new request since it was shown).
 *
 * Collapsed: a 40px bar fixed to the bottom: "Request / envelope · <Page> · METHOD path · status · ms · ETag".
 * Open (45vh; Escape closes it; the page gets as much bottom room as the drawer takes, through
 * html[data-facet-inspector="open"]): left, the exchange list (newest first: kind, group, status, NotModified /
 * Superseded / error badges, ms); right, the selected exchange with three tabs:
 *   Request   METHOD browser URL, upstream path, request headers (the DEMO principal header, If-None-Match),
 *             the JSON body
 *   Envelope  status, ETag / Version, ModelVersion, Engine, Exact, the timing split (service ElapsedMS, the
 *             proxy's Server-Timing upstream, the browser round trip) as a stacked bar, the demo session the
 *             proxy resolved, then one row per facet: Key, Fold, Disjunctive, Excluded, KeptMixed, CountMode,
 *             Total / Σ / Missing / Other, flags, error; Filter.Applied; Warnings; Errors
 *   Raw       the response JSON
 * State: AppData.Facet.Inspector = { Open, SelectedID, Tab, AllPages, Context } (+ View: the display model).
 * Re-renders on every exchange (provider.subscribeLog); the list and detail are only built while open.  The
 * Escape listener is the one window listener, and it exists only while the drawer is open.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libPictView = require('pict-view');

const libFacetDisplay = require('../providers/Facet-Display.js');

const VIEW_IDENTIFIER = 'Facet-Inspector';

const TABS = [ 'Request', 'Envelope', 'Raw' ];

const KIND_TONES = { Query: 'accent', Records: 'neutral', Count: 'ok', Describe: 'warn', Lookup: 'muted' };

const _ViewConfiguration =
	{
		ViewIdentifier: VIEW_IDENTIFIER,
		DefaultRenderable: 'Facet-Inspector-Drawer',
		DefaultDestinationAddress: '#FD-Inspector',
		AutoRender: false,

		CSS: /*css*/`
			.facet-insp { position: fixed; left: 0; right: 0; bottom: 0; z-index: 50; font-size: 12px; color: var(--facet-text, #1b2230);
				background: var(--facet-surface, #ffffff); border-top: 1px solid var(--facet-border, #dfe3e9); box-shadow: 0 -6px 20px rgba(16, 24, 40, 0.12); }
			.facet-insp-bar { display: flex; align-items: center; gap: 10px; width: 100%; height: 40px; margin: 0; padding: 0 16px; border: 0;
				background: var(--facet-surface-2, #f0f2f5); font: inherit; color: inherit; text-align: left; cursor: pointer; transition: background-color 100ms; }
			.facet-insp-bar:hover { background: var(--facet-accent-soft, #e8edfd); }
			.facet-insp-bar:focus-visible { outline: 2px solid var(--facet-accent, #3b5bdb); outline-offset: -2px; }
			.facet-insp-bar .pict-icon { font-size: 15px; color: var(--facet-accent, #3b5bdb); }
			.facet-insp-bar-title { font-weight: 600; white-space: nowrap; }
			.facet-insp-last { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
				font-family: var(--facet-mono, ui-monospace, Menlo, monospace); color: var(--facet-text-muted, #5d6878); }
			.facet-insp-count { white-space: nowrap; color: var(--facet-text-faint, #8a94a3); }
			.facet-insp-page { font-weight: 600; white-space: nowrap; color: var(--facet-text, #1b2230); }
			.facet-insp-list-col { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--facet-border, #dfe3e9); }
			.facet-insp-list-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--facet-border, #dfe3e9);
				font-size: 11px; color: var(--facet-text-muted, #5d6878); background: var(--facet-surface, #ffffff); }
			.facet-insp-timing { margin: 10px 0 4px; }
			.facet-insp-timing-bar { display: flex; height: 12px; border-radius: 3px; overflow: hidden; background: var(--facet-bar-zero, #e4e8ef); }
			.facet-insp-timing-seg { height: 100%; min-width: 2px; }
			.facet-insp-timing-0 { background: var(--facet-accent, #3b5bdb); }
			.facet-insp-timing-1 { background: var(--facet-bar, #b4c2ea); }
			.facet-insp-timing-2 { background: var(--facet-bar-disabled, #c9ced8); }
			.facet-insp-timing-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 6px; font-size: 11px; color: var(--facet-text-muted, #5d6878); }
			.facet-insp-timing-key { display: inline-flex; align-items: center; gap: 5px; font-variant-numeric: tabular-nums; }
			.facet-insp-timing-swatch { width: 10px; height: 10px; border-radius: 2px; }
			.facet-insp-body { display: grid; grid-template-columns: minmax(240px, 340px) minmax(0, 1fr); height: calc(45vh - 40px); min-height: 220px; }
			.facet-insp-list { flex: 1 1 auto; min-height: 0; overflow: auto; }
			.facet-insp-item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 3px 8px; width: 100%; margin: 0; padding: 7px 12px;
				border: 0; border-bottom: 1px solid var(--facet-border, #dfe3e9); background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; transition: background-color 100ms; }
			.facet-insp-item:hover { background: var(--facet-surface-2, #f0f2f5); }
			.facet-insp-item:focus-visible { outline: 2px solid var(--facet-accent, #3b5bdb); outline-offset: -2px; }
			.facet-insp-item-selected, .facet-insp-item-selected:hover { background: var(--facet-accent-soft, #e8edfd); }
			.facet-insp-item-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--facet-mono, ui-monospace, Menlo, monospace); font-size: 11px; }
			.facet-insp-item-meta { grid-column: 2 / 4; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; color: var(--facet-text-faint, #8a94a3); font-variant-numeric: tabular-nums; }
			.facet-insp-status { font-family: var(--facet-mono, ui-monospace, Menlo, monospace); font-weight: 600; }
			.facet-insp-tone-ok { color: var(--facet-ok, #2b8a3e); }
			.facet-insp-tone-warn { color: var(--facet-warn, #a8620a); }
			.facet-insp-tone-error { color: var(--facet-error, #c92a2a); }
			.facet-insp-tone-muted { color: var(--facet-text-faint, #8a94a3); }
			.facet-insp-detail { overflow: auto; padding: 0 16px 16px; }
			.facet-insp-tabs { position: sticky; top: 0; z-index: 1; display: flex; gap: 2px; margin: 0 0 10px; padding-top: 8px; border-bottom: 1px solid var(--facet-border, #dfe3e9); background: var(--facet-surface, #ffffff); }
			.facet-insp-tab { margin: 0; padding: 6px 12px; border: 0; border-bottom: 2px solid transparent; background: none; font: inherit; color: var(--facet-text-muted, #5d6878); cursor: pointer; transition: color 100ms; }
			.facet-insp-tab:hover { color: var(--facet-accent, #3b5bdb); }
			.facet-insp-tab:focus-visible { outline: 2px solid var(--facet-accent, #3b5bdb); outline-offset: -2px; }
			.facet-insp-tab-active { color: var(--facet-accent, #3b5bdb); border-bottom-color: var(--facet-accent, #3b5bdb); font-weight: 600; }
			.facet-insp-h { margin: 12px 0 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--facet-text-faint, #8a94a3); }
			.facet-insp-kv { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 4px 12px; margin: 0; }
			.facet-insp-kv dt { color: var(--facet-text-muted, #5d6878); }
			.facet-insp-kv dd { margin: 0; font-family: var(--facet-mono, ui-monospace, Menlo, monospace); word-break: break-all; }
			.facet-insp-code { margin: 0 0 8px; padding: 10px 12px; border-radius: var(--facet-radius-sm, 6px); overflow: auto; white-space: pre; tab-size: 2;
				background: var(--facet-code-bg, #f3f5f8); color: var(--facet-code-text, #24292f); font-family: var(--facet-mono, ui-monospace, Menlo, monospace); font-size: 11.5px; line-height: 1.5; }
			.facet-insp-table-wrap { overflow-x: auto; }
			.facet-insp-table { border-collapse: collapse; width: 100%; font-size: 11.5px; font-variant-numeric: tabular-nums; }
			.facet-insp-table th { text-align: left; font-weight: 600; color: var(--facet-text-muted, #5d6878); padding: 4px 8px; border-bottom: 1px solid var(--facet-border, #dfe3e9); white-space: nowrap; }
			.facet-insp-table td { padding: 4px 8px; border-bottom: 1px solid var(--facet-border, #dfe3e9); white-space: nowrap; font-family: var(--facet-mono, ui-monospace, Menlo, monospace); }
			.facet-insp-error { margin: 8px 0; }
			@media (max-width: 960px)
			{
				.facet-insp-body { grid-template-columns: minmax(0, 1fr); grid-template-rows: 35% minmax(0, 1fr); height: calc(70vh - 40px); }
				.facet-insp-list-col { border-right: 0; border-bottom: 1px solid var(--facet-border, #dfe3e9); }
				.facet-insp-last { display: none; }
			}
		`,

		Templates:
			[
				{
					Hash: 'Facet-Inspector-Drawer-Template',
					Template: /*html*/`
<div class="facet-insp">
	<button type="button" class="facet-insp-bar" aria-expanded="{~D:Record.Expanded~}" onclick="{~P~}.views['{~D:Record.ViewHash~}'].toggleOpen()">
		{~I:Code~}
		<span class="facet-insp-bar-title">Request / envelope</span>
		<span class="facet-insp-page">{~D:Record.PageText~}</span>
		<span class="facet-insp-last">{~D:Record.LastText~}</span>
		<span class="facet-insp-count">{~D:Record.CountText~}</span>
		{~TS:Facet-Inspector-Chevron-Up-Template:Record.CollapsedSlot~}{~TS:Facet-Inspector-Chevron-Down-Template:Record.OpenSlot~}
	</button>
	{~TS:Facet-Inspector-Body-Template:Record.BodySlot~}
</div>`
				},
				{
					Hash: 'Facet-Inspector-Chevron-Up-Template',
					Template: /*html*/`{~I:ChevronUp~}`
				},
				{
					Hash: 'Facet-Inspector-Chevron-Down-Template',
					Template: /*html*/`{~I:ChevronDown~}`
				},
				{
					Hash: 'Facet-Inspector-Body-Template',
					Template: /*html*/`
<div class="facet-insp-body">
	<div class="facet-insp-list-col">
		<div class="facet-insp-list-head"><span>{~D:Record.ScopeText~}</span><button type="button" class="facet-link" onclick="{~P~}.views['{~D:Record.ViewHash~}'].toggleAllPages()">{~D:Record.ToggleText~}</button></div>
		<div class="facet-insp-list" role="listbox" aria-label="Exchanges">{~TS:Facet-Inspector-Item-Template:Record.Items~}{~TS:Facet-Empty-Template:Record.EmptySlot~}</div>
	</div>
	<div class="facet-insp-detail">{~TS:Facet-Inspector-Detail-Template:Record.DetailSlot~}</div>
</div>`
				},
				{
					Hash: 'Facet-Inspector-Item-Template',
					Template: /*html*/`
<button type="button" role="option" aria-selected="{~D:Record.Selected~}" class="facet-insp-item {~D:Record.SelectedClass~}" onclick="{~P~}.views['{~D:Record.ViewHash~}'].select({~D:Record.ID~})">
	<span class="facet-badge facet-badge-{~D:Record.KindTone~}">{~D:Record.Kind~}</span>
	<span class="facet-insp-item-path" title="{~D:Record.Method~} {~D:Record.Path~}">{~D:Record.Method~} {~D:Record.Path~}</span>
	<span class="facet-insp-status facet-insp-tone-{~D:Record.Tone~}">{~D:Record.StatusText~}</span>
	<span class="facet-insp-item-meta">#{~D:Record.ID~} · {~D:Record.Group~} · {~D:Record.MS~}{~TS:Facet-Badge-Template:Record.Flags~}</span>
</button>`
				},
				{
					Hash: 'Facet-Inspector-Detail-Template',
					Template: /*html*/`
<div class="facet-insp-tabs" role="tablist">{~TS:Facet-Inspector-Tab-Template:Record.Tabs~}</div>
{~TS:Facet-Inspector-Request-Template:Record.RequestSlot~}
{~TS:Facet-Inspector-Envelope-Template:Record.EnvelopeSlot~}
{~TS:Facet-Inspector-Raw-Template:Record.RawSlot~}`
				},
				{
					Hash: 'Facet-Inspector-Tab-Template',
					Template: /*html*/`<button type="button" role="tab" aria-selected="{~D:Record.Selected~}" class="facet-insp-tab {~D:Record.ActiveClass~}" onclick="{~P~}.views['{~D:Record.ViewHash~}'].selectTab('{~D:Record.Tab~}')">{~D:Record.Tab~}</button>`
				},
				{
					Hash: 'Facet-Inspector-KV-Template',
					Template: /*html*/`<dt>{~D:Record.Name~}</dt><dd>{~D:Record.Value~}</dd>`
				},
				{
					Hash: 'Facet-Inspector-Request-Template',
					Template: /*html*/`
<dl class="facet-insp-kv">{~TS:Facet-Inspector-KV-Template:Record.Facts~}</dl>
<h4 class="facet-insp-h">Request headers</h4>
<dl class="facet-insp-kv">{~TS:Facet-Inspector-KV-Template:Record.Headers~}</dl>
<h4 class="facet-insp-h">Body</h4>
<pre class="facet-insp-code">{~D:Record.BodyJSON~}</pre>`
				},
				{
					Hash: 'Facet-Inspector-Envelope-Template',
					Template: /*html*/`
{~TS:Facet-Inspector-Error-Template:Record.ErrorSlot~}
<dl class="facet-insp-kv">{~TS:Facet-Inspector-KV-Template:Record.Facts~}</dl>
{~TS:Facet-Inspector-Timing-Template:Record.TimingSlot~}
{~TS:Facet-Inspector-Facets-Template:Record.FacetsSlot~}
{~TS:Facet-Inspector-Code-Section-Template:Record.Sections~}
<h4 class="facet-insp-h">Response headers</h4>
<dl class="facet-insp-kv">{~TS:Facet-Inspector-KV-Template:Record.Headers~}</dl>`
				},
				{
					Hash: 'Facet-Inspector-Timing-Template',
					Template: /*html*/`
<div class="facet-insp-timing">
	<h4 class="facet-insp-h">Where the time went</h4>
	<div class="facet-insp-timing-bar" role="img" aria-label="{~D:Record.Aria~}">{~TS:Facet-Inspector-Timing-Segment-Template:Record.Segments~}</div>
	<div class="facet-insp-timing-legend">{~TS:Facet-Inspector-Timing-Key-Template:Record.Segments~}</div>
</div>`
				},
				{
					Hash: 'Facet-Inspector-Timing-Segment-Template',
					Template: /*html*/`<span class="facet-insp-timing-seg facet-insp-timing-{~D:Record.Tone~}" style="width: {~D:Record.Pct~}%" title="{~D:Record.Text~}"></span>`
				},
				{
					Hash: 'Facet-Inspector-Timing-Key-Template',
					Template: /*html*/`<span class="facet-insp-timing-key"><span class="facet-insp-timing-swatch facet-insp-timing-{~D:Record.Tone~}"></span>{~D:Record.Text~}</span>`
				},
				{
					Hash: 'Facet-Inspector-Error-Template',
					Template: /*html*/`<div class="facet-inline-error facet-insp-error"><div><span class="facet-inline-error-code">{~I:Warning~} {~D:Record.Code~} · {~D:Record.Status~}</span> {~D:Record.Message~}</div>{~TS:Facet-Inspector-Error-Detail-Template:Record.DetailSlot~}</div>`
				},
				{
					Hash: 'Facet-Inspector-Error-Detail-Template',
					Template: /*html*/`<code>{~D:Record.Text~}</code>`
				},
				{
					Hash: 'Facet-Inspector-Facets-Template',
					Template: /*html*/`
<h4 class="facet-insp-h">Facets</h4>
<div class="facet-insp-table-wrap">
	<table class="facet-insp-table">
		<thead><tr><th>Key</th><th>Fold</th><th>Disjunctive</th><th>Excluded</th><th>KeptMixed</th><th>CountMode</th><th>Total</th><th>Σ</th><th>Missing</th><th>Other</th><th>Flags</th><th>Error</th></tr></thead>
		<tbody>{~TS:Facet-Inspector-Facet-Row-Template:Record.Rows~}</tbody>
	</table>
</div>`
				},
				{
					Hash: 'Facet-Inspector-Facet-Row-Template',
					Template: /*html*/`<tr><td>{~D:Record.Key~}</td><td>{~D:Record.Fold~}</td><td>{~D:Record.Disjunctive~}</td><td>{~D:Record.Excluded~}</td><td>{~D:Record.KeptMixed~}</td><td>{~D:Record.CountMode~}</td><td>{~D:Record.Total~}</td><td>{~D:Record.Sum~}</td><td>{~D:Record.Missing~}</td><td>{~D:Record.Other~}</td><td>{~D:Record.Flags~}</td><td class="facet-insp-tone-error">{~D:Record.Error~}</td></tr>`
				},
				{
					Hash: 'Facet-Inspector-Code-Section-Template',
					Template: /*html*/`<h4 class="facet-insp-h">{~D:Record.Title~}</h4><pre class="facet-insp-code">{~D:Record.Code~}</pre>`
				},
				{
					Hash: 'Facet-Inspector-Raw-Template',
					Template: /*html*/`<pre class="facet-insp-code">{~D:Record.RawJSON~}</pre>`
				}
			],

		Renderables:
			[
				{
					RenderableHash: 'Facet-Inspector-Drawer',
					TemplateHash: 'Facet-Inspector-Drawer-Template',
					ContentDestinationAddress: '#FD-Inspector',
					RenderMethod: 'replace'
				}
			]
	};

class PictViewFacetInspector extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this._Unsubscribe = null;
		this._RenderQueued = false;
		this._BoundKeyDown = this._onKeyDown.bind(this);
		this._KeyListening = false;
	}

	/**
	 * The page on screen: its label, its groups and its domains.  The drawer lists only their exchanges (unless
	 * "All pages"), and the bar names the page's latest answer.
	 *
	 * @param {{ Label: string, Groups: Array<string>, Domains: Array<string> }} pContext
	 */
	setContext(pContext)
	{
		let tmpInspector = this.pict.AppData.Facet.Inspector;
		tmpInspector.Context = (pContext && (typeof(pContext) === 'object')) ? { Label: pContext.Label || '', Groups: (pContext.Groups || []).slice(), Domains: (pContext.Domains || []).slice() } : null;
		// Exchanges up to this ID happened before the page was (re)shown: an answer that old is "kept".
		tmpInspector.ShownAtSeq = this.pict.AppData.Facet.LogSeq || 0;
		tmpInspector.SelectedID = null;
		this.renderDrawer();
	}

	/**
	 * @param {Record<string, any>} pExchange
	 * @return {boolean} whether the exchange belongs to the page on screen
	 */
	_inContext(pExchange)
	{
		let tmpContext = this.pict.AppData.Facet.Inspector.Context;
		if (!tmpContext)
		{
			return true;
		}
		if (pExchange.GroupHash)
		{
			return tmpContext.Groups.indexOf(pExchange.GroupHash) >= 0;
		}
		return tmpContext.Domains.indexOf(pExchange.Domain) >= 0;
	}

	toggleAllPages()
	{
		let tmpInspector = this.pict.AppData.Facet.Inspector;
		tmpInspector.AllPages = !(tmpInspector.AllPages === true);
		tmpInspector.SelectedID = null;
		this.renderDrawer();
	}

	/**
	 * Escape closes the open drawer.
	 *
	 * @param {KeyboardEvent} pEvent
	 */
	_onKeyDown(pEvent)
	{
		if (pEvent && ((pEvent.key === 'Escape') || (pEvent.key === 'Esc')) && (this.pict.AppData.Facet.Inspector.Open === true))
		{
			this.toggleOpen();
		}
	}

	/**
	 * Keep the window keydown listener (and the html attribute the page's bottom room keys on) in step with
	 * the drawer.
	 *
	 * @param {boolean} pOpen
	 */
	_syncOpenState(pOpen)
	{
		if (typeof(window) === 'undefined')
		{
			return;
		}
		if (pOpen && !this._KeyListening)
		{
			window.addEventListener('keydown', this._BoundKeyDown);
			this._KeyListening = true;
		}
		else if (!pOpen && this._KeyListening)
		{
			window.removeEventListener('keydown', this._BoundKeyDown);
			this._KeyListening = false;
		}
		this.pict.ContentAssignment.setAttribute('html', 'data-facet-inspector', pOpen ? 'open' : 'closed');
	}

	/**
	 * The timing split of an answer: the service's own ElapsedMS (envelope), the proxy's round trip to the
	 * domain server (Server-Timing upstream) and the browser's round trip to the proxy.
	 *
	 * @param {Record<string, any>} pExchange
	 * @return {{ Facts: string, Slot: Array<Record<string, any>> }}
	 */
	_timing(pExchange)
	{
		let tmpSummary = pExchange.Summary || {};
		let tmpHeaders = pExchange.ResponseHeaders || {};
		let tmpClient = (typeof(pExchange.ElapsedMS) === 'number') ? pExchange.ElapsedMS : null;
		// A 304 carries no envelope: the ElapsedMS in the cached body belongs to the earlier answer.
		let tmpService = (!pExchange.NotModified && (typeof(tmpSummary.ServerElapsedMS) === 'number')) ? tmpSummary.ServerElapsedMS : null;
		let tmpUpstream = null;
		libFacetDisplay.parseServerTiming(tmpHeaders['Server-Timing']).forEach((pMetric) => { if ((pMetric.Name === 'upstream') && (typeof(pMetric.DurationMS) === 'number')) { tmpUpstream = pMetric.DurationMS; } });
		let fMS = (pValue) => { return `${Math.round(pValue * 10) / 10} ms`; };
		let tmpFacts = [];
		if (tmpClient !== null)
		{
			tmpFacts.push(`browser round trip ${fMS(tmpClient)}`);
		}
		if (tmpUpstream !== null)
		{
			tmpFacts.push(`proxy → domain server ${fMS(tmpUpstream)}`);
		}
		if (tmpService !== null)
		{
			tmpFacts.push(`faceting service ${fMS(tmpService)}`);
		}
		else if (pExchange.NotModified)
		{
			tmpFacts.push('304: the service revalidated the Version, no envelope was sent');
		}
		if ((tmpClient === null) || (tmpClient <= 0))
		{
			return { Facts: tmpFacts.join(' · '), Slot: [] };
		}
		let tmpSegments = [];
		let tmpUsed = 0;
		if (tmpService !== null)
		{
			tmpSegments.push({ Tone: 0, MS: Math.min(tmpService, tmpClient), Text: `faceting service ${fMS(tmpService)} (envelope ElapsedMS)` });
			tmpUsed = Math.min(tmpService, tmpClient);
		}
		if (tmpUpstream !== null)
		{
			let tmpHop = Math.max(0, Math.min(tmpUpstream, tmpClient) - tmpUsed);
			tmpSegments.push({ Tone: 1, MS: tmpHop, Text: (tmpService !== null) ? `domain server HTTP + routing ${fMS(tmpHop)} (Server-Timing upstream ${fMS(tmpUpstream)} minus the service)` : `proxy → domain server ${fMS(tmpHop)} (Server-Timing upstream)` });
			tmpUsed += tmpHop;
		}
		let tmpRest = Math.max(0, tmpClient - tmpUsed);
		tmpSegments.push({ Tone: 2, MS: tmpRest, Text: `browser ↔ demo proxy ${fMS(tmpRest)}` });
		let tmpSlot = tmpSegments.map((pSegment) => { return { Tone: pSegment.Tone, Pct: Math.round((pSegment.MS / tmpClient) * 1000) / 10, Text: libFacetDisplay.text(pSegment.Text) }; });
		return { Facts: tmpFacts.join(' · '), Slot: [ { Segments: tmpSlot, Aria: libFacetDisplay.text(tmpFacts.join(', ')) } ] };
	}

	/**
	 * Start following the exchange log (idempotent) and render the drawer.
	 */
	attach()
	{
		if (!this._Unsubscribe && this.pict.providers.Facet)
		{
			this._Unsubscribe = this.pict.providers.Facet.subscribeLog(() => { this._queueRender(); });
		}
		this.renderDrawer();
	}

	/**
	 * Coalesce bursts of log events (start + finish of several exchanges) into one render per frame.
	 */
	_queueRender()
	{
		if (this._RenderQueued)
		{
			return;
		}
		this._RenderQueued = true;
		let fRender = () =>
		{
			this._RenderQueued = false;
			this.renderDrawer();
		};
		if (typeof(window) !== 'undefined' && (typeof(window.requestAnimationFrame) === 'function'))
		{
			window.requestAnimationFrame(fRender);
		}
		else
		{
			setTimeout(fRender, 16);
		}
	}

	/**
	 * Short "METHOD path · status · ms · etag" line of an exchange.
	 *
	 * @param {Record<string, any>} pExchange
	 * @return {string} escaped
	 */
	_line(pExchange)
	{
		let tmpParts = [ `${pExchange.Method} ${pExchange.UpstreamPath}`, this._statusText(pExchange) ];
		if (typeof(pExchange.ElapsedMS) === 'number')
		{
			tmpParts.push(`${pExchange.ElapsedMS} ms`);
		}
		let tmpETag = (pExchange.ResponseHeaders && pExchange.ResponseHeaders.ETag) ? pExchange.ResponseHeaders.ETag : null;
		let tmpLine = libFacetDisplay.text(tmpParts.join(' · '));
		if (tmpETag)
		{
			tmpLine = `${tmpLine} · ${libFacetDisplay.shortETag(tmpETag)}`;
		}
		return tmpLine;
	}

	/**
	 * @param {Record<string, any>} pExchange
	 * @return {string}
	 */
	_statusText(pExchange)
	{
		if (pExchange.Pending)
		{
			return '…';
		}
		if (pExchange.Aborted)
		{
			return 'aborted';
		}
		if (pExchange.Status === 0)
		{
			return 'network';
		}
		return String(pExchange.Status);
	}

	/**
	 * Build AppData.Facet.Inspector.View and render.
	 */
	renderDrawer()
	{
		let tmpFacetState = this.pict.AppData.Facet;
		if (!tmpFacetState)
		{
			return;
		}
		let tmpInspector = tmpFacetState.Inspector;
		let tmpAll = Array.isArray(tmpFacetState.Log) ? tmpFacetState.Log : [];
		let tmpContext = tmpInspector.Context || null;
		let tmpPageLog = tmpAll.filter((pExchange) => { return this._inContext(pExchange); });
		let tmpLog = ((tmpInspector.AllPages === true) || !tmpContext) ? tmpAll : tmpPageLog;
		let tmpOpen = (tmpInspector.Open === true);
		// The bar: the latest Query of the page's first (visible) group, else the page's latest Query, else anything.
		let tmpFocusGroup = (tmpContext && tmpContext.Groups.length > 0) ? tmpContext.Groups[0] : null;
		let tmpLatest = tmpPageLog.find((pExchange) => { return (pExchange.Kind === 'Query') && (pExchange.GroupHash === tmpFocusGroup); })
			|| tmpPageLog.find((pExchange) => { return pExchange.Kind === 'Query'; }) || tmpPageLog[0] || null;
		let tmpLastText = 'No requests yet';
		if (tmpLatest)
		{
			tmpLastText = this._line(tmpLatest);
			if (!tmpLatest.Pending && (tmpLatest.ID <= (tmpInspector.ShownAtSeq || 0)))
			{
				let tmpAt = '';
				try
				{
					tmpAt = new Date(tmpLatest.At).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
				}
				catch (pError)
				{
					tmpAt = String(tmpLatest.At || '');
				}
				tmpLastText = `${tmpLastText} · ${libFacetDisplay.text(`answered at ${tmpAt}, kept (no new request)`)}`;
			}
		}
		let tmpModel =
			{
				ViewHash: VIEW_IDENTIFIER,
				Expanded: tmpOpen ? 'true' : 'false',
				PageText: tmpContext ? libFacetDisplay.text(`${tmpContext.Label} ·`) : '',
				LastText: tmpLastText,
				CountText: tmpContext ? `${tmpPageLog.length} on this page · ${tmpAll.length} in all` : `${tmpAll.length} exchange${(tmpAll.length === 1) ? '' : 's'}`,
				CollapsedSlot: tmpOpen ? [] : [ {} ],
				OpenSlot: tmpOpen ? [ {} ] : [],
				BodySlot: []
			};
		if (tmpOpen)
		{
			let tmpSelected = (tmpInspector.SelectedID !== null) ? tmpLog.find((pExchange) => { return pExchange.ID === tmpInspector.SelectedID; }) : null;
			if (!tmpSelected)
			{
				tmpSelected = tmpLog.find((pExchange) => { return pExchange.Kind === 'Query'; }) || tmpLog[0] || null;
			}
			let tmpItems = tmpLog.map(
				(pExchange) =>
				{
					let tmpFlags = [];
					if (pExchange.NotModified)
					{
						tmpFlags.push({ Text: '304', Tone: 'ok', Tip: 'Served from the Version cache (If-None-Match matched).' });
					}
					if (pExchange.Superseded)
					{
						tmpFlags.push({ Text: 'superseded', Tone: 'muted', Tip: 'A newer request for the same group replaced this one; its answer was not applied.' });
					}
					let tmpIsSelected = !!tmpSelected && (tmpSelected.ID === pExchange.ID);
					return (
						{
							ViewHash: VIEW_IDENTIFIER,
							ID: pExchange.ID,
							Kind: libFacetDisplay.text(pExchange.Kind),
							KindTone: KIND_TONES[pExchange.Kind] || 'neutral',
							Method: libFacetDisplay.text(pExchange.Method),
							Path: libFacetDisplay.text(pExchange.UpstreamPath),
							Group: libFacetDisplay.text(pExchange.GroupHash || pExchange.Domain),
							StatusText: libFacetDisplay.text(this._statusText(pExchange)),
							Tone: pExchange.Pending ? 'muted' : libFacetDisplay.statusTone(pExchange.NotModified ? 304 : pExchange.Status),
							MS: (typeof(pExchange.ElapsedMS) === 'number') ? `${pExchange.ElapsedMS} ms` : '…',
							Flags: tmpFlags,
							Selected: tmpIsSelected ? 'true' : 'false',
							SelectedClass: tmpIsSelected ? 'facet-insp-item-selected' : ''
						});
				});
			tmpModel.BodySlot =
				[
					{
						ViewHash: VIEW_IDENTIFIER,
						ScopeText: libFacetDisplay.text(((tmpInspector.AllPages === true) || !tmpContext) ? `Every page · ${tmpAll.length} exchanges` : `${tmpContext.Label} · ${tmpPageLog.length} exchange${(tmpPageLog.length === 1) ? '' : 's'}`),
						ToggleText: ((tmpInspector.AllPages === true) || !tmpContext) ? (tmpContext ? 'This page only' : '') : 'All pages',
						Items: tmpItems,
						EmptySlot: (tmpItems.length < 1) ? [ { Text: 'No requests yet' } ] : [],
						DetailSlot: tmpSelected ? [ this._detail(tmpSelected, tmpInspector.Tab) ] : []
					}
				];
		}
		tmpInspector.View = tmpModel;
		this.render('Facet-Inspector-Drawer', '#FD-Inspector', 'AppData.Facet.Inspector.View');
		this._syncOpenState(tmpOpen);
	}

	/**
	 * The detail pane of one exchange.
	 *
	 * @param {Record<string, any>} pExchange
	 * @param {string} pTab
	 * @return {Record<string, any>}
	 */
	_detail(pExchange, pTab)
	{
		let tmpTab = (TABS.indexOf(pTab) >= 0) ? pTab : 'Envelope';
		let tmpKV = (pName, pValue) => { return { Name: libFacetDisplay.text(pName), Value: libFacetDisplay.text(((pValue === null) || (typeof(pValue) === 'undefined') || (pValue === '')) ? '—' : pValue) }; };
		let tmpDetail =
			{
				Tabs: TABS.map((pName) => { return { ViewHash: VIEW_IDENTIFIER, Tab: pName, ActiveClass: (pName === tmpTab) ? 'facet-insp-tab-active' : '', Selected: (pName === tmpTab) ? 'true' : 'false' }; }),
				RequestSlot: [],
				EnvelopeSlot: [],
				RawSlot: []
			};
		if (tmpTab === 'Request')
		{
			tmpDetail.RequestSlot =
				[
					{
						Facts:
							[
								tmpKV('Browser request', `${pExchange.Method} ${pExchange.URL}`),
								tmpKV('Upstream path', pExchange.UpstreamPath),
								tmpKV('Kind / group', `${pExchange.Kind} · ${pExchange.GroupHash || pExchange.Domain}`),
								tmpKV('Sent at', pExchange.At)
							],
						Headers: Object.keys(pExchange.RequestHeaders || {}).map((pName) => { return tmpKV(pName, pExchange.RequestHeaders[pName]); }),
						BodyJSON: (pExchange.Body === null) ? libFacetDisplay.text('(no body)') : libFacetDisplay.json(pExchange.Body)
					}
				];
			return tmpDetail;
		}
		if (tmpTab === 'Raw')
		{
			tmpDetail.RawSlot = [ { RawJSON: pExchange.Pending ? libFacetDisplay.text('(waiting for the answer)') : libFacetDisplay.json(pExchange.Response) } ];
			return tmpDetail;
		}

		let tmpHeaders = pExchange.ResponseHeaders || {};
		let tmpSummary = pExchange.Summary || {};
		let tmpTiming = this._timing(pExchange);
		let tmpFacts =
			[
				tmpKV('Status', `${this._statusText(pExchange)}${pExchange.NotModified ? ' (Not Modified: body from the Version cache)' : ''}${pExchange.Superseded ? ' (superseded, not applied)' : ''}`),
				tmpKV('ETag', tmpHeaders.ETag),
				tmpKV('Version', tmpSummary.Version),
				tmpKV('ModelVersion', tmpSummary.ModelVersion),
				tmpKV('Engine', tmpSummary.Engine),
				tmpKV('Exact', (typeof(tmpSummary.Exact) === 'boolean') ? String(tmpSummary.Exact) : null),
				tmpKV('Timing', tmpTiming.Facts),
				tmpKV('Demo session', tmpHeaders['X-Retold-Facet-Demo-Session']),
				tmpKV('Total', (typeof(tmpSummary.Total) === 'number') ? tmpSummary.Total : null)
			];
		if (typeof(tmpSummary.Records) === 'number')
		{
			tmpFacts.push(tmpKV('Records', tmpSummary.Records));
		}
		if (typeof(tmpSummary.Count) === 'number')
		{
			tmpFacts.push(tmpKV('Count', tmpSummary.Count));
		}
		if (typeof(tmpSummary.Entities) === 'number')
		{
			tmpFacts.push(tmpKV('Entities described', tmpSummary.Entities));
		}
		let tmpError = pExchange.Error;
		let tmpFacetRows = Array.isArray(tmpSummary.Facets) ? tmpSummary.Facets.map(
			(pFacet) =>
			{
				let tmpFlags = [];
				if (pFacet.Truncated)
				{
					tmpFlags.push('Truncated');
				}
				if (pFacet.MultiValued)
				{
					tmpFlags.push('MultiValued');
				}
				if (pFacet.Relaxed)
				{
					tmpFlags.push('Relaxed');
				}
				if (pFacet.Semantics)
				{
					tmpFlags.push(pFacet.Semantics);
				}
				let fNumber = (pValue) => { return (typeof(pValue) === 'number') ? libFacetDisplay.count(pValue) : '—'; };
				return (
					{
						Key: libFacetDisplay.text(pFacet.Key),
						Fold: libFacetDisplay.text(pFacet.Fold || '—'),
						Disjunctive: libFacetDisplay.text(pFacet.Disjunctive || '—'),
						Excluded: libFacetDisplay.text((pFacet.Excluded.length > 0) ? pFacet.Excluded.join(', ') : '—'),
						KeptMixed: libFacetDisplay.text((pFacet.KeptMixed.length > 0) ? pFacet.KeptMixed.join(', ') : '—'),
						CountMode: libFacetDisplay.text(pFacet.CountMode || '—'),
						Total: fNumber(pFacet.Total),
						Sum: fNumber(pFacet.SumOfCounts),
						Missing: fNumber(pFacet.MissingCount),
						Other: fNumber(pFacet.OtherCount),
						Flags: libFacetDisplay.text(tmpFlags.join(' ') || '—'),
						Error: libFacetDisplay.text(pFacet.Error ? `${pFacet.Error.Code} ${pFacet.Error.Status}` : '')
					});
			}) : [];
		let tmpSections = [];
		if (Array.isArray(tmpSummary.FilterApplied))
		{
			tmpSections.push({ Title: 'Filter.Applied', Code: libFacetDisplay.json(tmpSummary.FilterApplied) });
		}
		if (Array.isArray(tmpSummary.Warnings) && (tmpSummary.Warnings.length > 0))
		{
			tmpSections.push({ Title: 'Warnings', Code: libFacetDisplay.json(tmpSummary.Warnings) });
		}
		if (tmpSummary.Errors && (Object.keys(tmpSummary.Errors).length > 0))
		{
			tmpSections.push({ Title: 'Errors', Code: libFacetDisplay.json(tmpSummary.Errors) });
		}
		tmpDetail.EnvelopeSlot =
			[
				{
					ErrorSlot: tmpError ? [ { Code: libFacetDisplay.text(tmpError.Code), Status: libFacetDisplay.text(tmpError.Status), Message: libFacetDisplay.text(tmpError.Message), DetailSlot: tmpError.Detail ? [ { Text: libFacetDisplay.compactJSON(tmpError.Detail) } ] : [] } ] : [],
					Facts: tmpFacts,
					TimingSlot: tmpTiming.Slot,
					FacetsSlot: (tmpFacetRows.length > 0) ? [ { Rows: tmpFacetRows } ] : [],
					Sections: tmpSections,
					Headers: Object.keys(tmpHeaders).map((pName) => { return tmpKV(pName, tmpHeaders[pName]); })
				}
			];
		return tmpDetail;
	}

	toggleOpen()
	{
		let tmpInspector = this.pict.AppData.Facet.Inspector;
		tmpInspector.Open = !(tmpInspector.Open === true);
		this.renderDrawer();
	}

	/**
	 * @param {number} pExchangeID
	 */
	select(pExchangeID)
	{
		this.pict.AppData.Facet.Inspector.SelectedID = pExchangeID;
		this.renderDrawer();
	}

	/**
	 * @param {string} pTab - 'Request' | 'Envelope' | 'Raw'
	 */
	selectTab(pTab)
	{
		if (TABS.indexOf(pTab) < 0)
		{
			return;
		}
		this.pict.AppData.Facet.Inspector.Tab = pTab;
		this.renderDrawer();
	}

	onAfterRender(pRenderable, pRenderDestinationAddress, pRecord, pContent)
	{
		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pRenderDestinationAddress, pRecord, pContent);
	}
}

module.exports = PictViewFacetInspector;
module.exports.default_configuration = _ViewConfiguration;
