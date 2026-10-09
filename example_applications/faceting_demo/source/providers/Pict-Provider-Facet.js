/**
 * Pict-Provider-Facet -- the client half of the faceting contract (design 02 §13, 10 §1.2; DEMO-SPEC §4).
 * Liftable into pict-section-facet: nothing here knows about the demo pages, personas or the proxy; the host
 * wires those in through setEndpointPrefix / setRequestHeaders / setPrincipalKey.
 *
 *   describe(pDomain, fCallback)                 GET  <prefix>/1.0/Facet/Describe  -> AppData.FacetCapabilities[Domain]
 *   refresh(pGroupHash) / query(...)             POST <prefix>/1.0/Facet/<E>[/Scope/<S>]/Query, coalesced per group per tick
 *   loadRecordsPage(pGroupHash, pBegin)          POST <prefix>/1.0/Facet/<E>[/Scope/<S>]/Records/<Begin>/<Cap>   (FilterEndpointOverride)
 *   verifyCount(pGroupHash)                      POST <prefix>/1.0/Facet/<E>[/Scope/<S>]/Records/Count, compared with the
 *                                                envelope it was asked about (a Query in flight is waited for)
 *   lookupForRows / fetchLookup / lookupRows     display lookups of related rows (Facet-Lookup.js), cached per principal
 *   fetchAllRecords(pGroupHash)                  every list row of a group (pages of 500), for a cross-check panel
 *   setSelection / setSelections / setScope / setFacetOption / setRecordsSort / clearSelections
 *                                                (state writes; each schedules ONE refresh)
 *   applyDescribedFacets(pGroupHash, …)          a group whose facet list comes from Describe (FacetsFrom: 'Describe')
 *   labelOf(pGroupHash, pFacetKey, pKey)         every label this principal has seen for a facet's key (stable source)
 *   subscribe(pGroupHash, fListener)             views re-render on state transitions (+ reason 'Stream': the domain's
 *                                                change-stream status changed)
 *   subscribeLog(fListener)                      the inspector re-renders on every exchange
 *
 * M4 (internal-contracts §47.1–§47.3):
 *   subscribeChanges(pDomain)                    open (or reuse) ONE stream per domain for the current principal key:
 *                                                GET <prefix>/1.0/Facet/Changes (EventSource when the host sends no
 *                                                request headers, else a fetch() stream reader parsed by Facet-Changes;
 *                                                no persona or ID ever goes into a URL).  Reconnects with jittered
 *                                                backoff (the server's retry:, doubled, ≤ 30 s, × [½, 1]), also after a
 *                                                'closed' event (Shutdown: a restart; Revalidate: at once, through the
 *                                                host's authentication); a 401 / 403 / 404 / 429 answer stops it until
 *                                                the next principal change
 *   closeChanges(pDomain)                        one domain, or every domain when omitted (a principal switch)
 *   changeState(pDomain)                         AppData.Facet.Changes[pDomain] = { Status: 'Connecting' | 'Open' |
 *                                                'Closed' | 'Error', PrincipalKey, LastSeq, LastEventAt, Events,
 *                                                Reconnects, Reason, Error, NodeEpoch }
 *   setGroupVisibility(fIsVisible)               which groups are on screen: a change refetches a visible group at once
 *                                                and marks the others (ChangedSince: refetched when shown, isStale)
 *   refreshForChange(pGroupHash, pSeq, pTrigger) the SSE refetch: the group's normal coalesced POST with
 *                                                Freshness.MinSeq (and If-None-Match from the Version cache)
 *   write(pDomain, pMethod, pPath, pBody, …)     a host write (logged Kind 'Write'; never cached)
 * Events: generation(Entity, Seq) refetches every group of the domain whose last DependsOn names Entity (and drops
 * the principal's lookup rows of Entity); ready (after the first) and model refetch every group of the domain.
 * Every event is logged as an exchange of Kind 'Change'.  Query bodies carry Freshness (options.Freshness, Bounded
 * by default); an answer that comes back Stale is refetched once more after StaleRefetchMS (the server refreshes
 * it in the background), at most MaxStaleRefetches times in a row.
 *
 * State: AppData.Facet = { PrincipalKey, Groups: { <Hash>: <group state, Facet-Selection.initialGroupState> },
 *                          Log: [ <exchange> ], LogSeq, Inspector: { Open, SelectedID, Tab, AllPages },
 *                          DescribeErrors: { <Domain>: <Error> }, ShowInternals }
 *
 * The count check belongs to ONE answer: CountCheck.AnswerSeq is the AnswerSeq of the envelope its Total came
 * from; any new Query clears it, and a view shows a verdict only while the two match.
 *
 * Coalescing (design 02 §13): every refresh / query for one group within CoalesceMS sends ONE POST; every
 * pending callback receives that answer.  A newer flush supersedes the one in flight: the older fetch is
 * aborted (AbortController), its exchange is logged Superseded / Aborted, its callbacks move to the newer
 * flight, and its answer is never applied.
 *
 * Cache: Version-keyed.  Key = Facet-Selection.requestKey(Domain, PrincipalKey, Method, Path, Body) (Body without
 * Freshness: an SSE refetch revalidates the answer it replaces); value = { ETag, Body }.  A repeat request sends If-None-Match: <ETag>; a 304 serves the cached body (the exchange is
 * logged NotModified).  Only 200 answers are stored; any other status deletes the entry (errors are never cached).
 * The server's Version hashes the computed answer, the principal's scope values and the BindHash (M4, cache on:
 * the cache key and the generation vector), so a 304 is never stale and never crosses principals.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libPictProvider = require('pict-provider');

const libFacetSelection = require('./Facet-Selection.js');
const libFacetDisplay = require('./Facet-Display.js');
const libFacetLookup = require('./Facet-Lookup.js');
const libFacetChanges = require('./Facet-Changes.js');

const _DEFAULT_CONFIGURATION =
	{
		ProviderIdentifier: 'Facet',
		AutoInitialize: true,
		AutoInitializeOrdinal: 0,
		// Facet requests issued within this window for one group merge into one POST (design 02 §13: 10 ms).
		CoalesceMS: 10,
		// Exchanges kept for the inspector (newest first; M4 adds the change stream's events and the host's writes).
		MaxLog: 40,
		// Version-cache entries kept (LRU).
		MaxCache: 60,
		// Records page size when a group does not say.
		DefaultRecordsCap: 25,
		// M4: the Freshness every Query asks for (null: the server's default, Exact).
		Freshness: libFacetSelection.DEFAULT_FRESHNESS,
		// M4: the change-stream transport: 'Auto' (EventSource when no request headers are needed, else fetch),
		// 'EventSource' or 'Fetch'.
		ChangesTransport: 'Auto',
		// M4: a Stale answer is refetched once more after this long (0: never), at most this many times in a row.
		StaleRefetchMS: 1000,
		MaxStaleRefetches: 3,
		// M4: an SSE-triggered refetch waits a random 0..ChangeJitterMS first, so every page that heard one event
		// does not refetch in the same tick (0: at once).
		ChangeJitterMS: 150
	};

// Stream answers that stop reconnecting until the next principal change (§47.1): no session / not allowed, no stream
// on this server, over a connection limit.
const STREAM_STOP_STATUSES = [ 400, 401, 403, 404, 405, 406, 429, 501 ];

// Response headers an exchange keeps (canonical spelling for the inspector).
const KEPT_HEADERS =
	{
		'etag': 'ETag',
		'content-type': 'Content-Type',
		'cache-control': 'Cache-Control',
		'server-timing': 'Server-Timing'
	};

// Shared widget chrome: card head, badges, inline notes and errors.  Every rule reads only --facet-* tokens,
// each with a hard fallback, so the widgets lift unchanged (pict-section-facet maps --facet-* onto --theme-color-*).
const _SHARED_CSS = /*css*/`
	.facet-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0 0 10px; min-height: 22px; }
	.facet-card-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--facet-text, #1b2230); letter-spacing: 0.01em; }
	.facet-card-badges { display: inline-flex; gap: 4px; flex-wrap: wrap; }
	.facet-card-spacer { flex: 1 1 auto; }
	.facet-badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 500; line-height: 18px; white-space: nowrap; cursor: help;
		background: var(--facet-surface-2, #f0f2f5); color: var(--facet-text-muted, #5d6878); border: 1px solid var(--facet-border, #dfe3e9); }
	.facet-badge-accent { background: var(--facet-accent-soft, #e8edfd); color: var(--facet-accent, #3b5bdb); border-color: transparent; }
	.facet-badge-warn { background: var(--facet-warn-soft, #fdf3e1); color: var(--facet-warn, #a8620a); border-color: transparent; }
	.facet-badge-ok { background: var(--facet-ok-soft, #e6f4ea); color: var(--facet-ok, #2b8a3e); border-color: transparent; }
	.facet-badge-error { background: var(--facet-error-soft, #fdecec); color: var(--facet-error, #c92a2a); border-color: transparent; }
	.facet-badge-muted { background: transparent; color: var(--facet-text-faint, #8a94a3); border-style: dashed; }
	.facet-badge-internal { background: transparent; color: var(--facet-text-muted, #5d6878); border-style: dotted; font-family: var(--facet-mono, ui-monospace, Menlo, monospace); font-size: 10.5px; }
	.facet-badge-info { background: var(--facet-info-soft, #e7f1fb); color: var(--facet-info, #1c64b0); border-color: transparent; }
	.facet-link { background: none; border: 0; padding: 2px 4px; margin: 0; font: inherit; font-size: 12px; color: var(--facet-accent, #3b5bdb); cursor: pointer; border-radius: 4px; transition: background-color 100ms, color 100ms; }
	.facet-link:hover { background: var(--facet-accent-soft, #e8edfd); }
	.facet-link:focus-visible, .facet-btn:focus-visible { outline: 2px solid var(--facet-accent, #3b5bdb); outline-offset: 1px; }
	.facet-btn { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: var(--facet-radius-sm, 6px); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer;
		background: var(--facet-surface, #ffffff); color: var(--facet-text, #1b2230); border: 1px solid var(--facet-border, #dfe3e9); transition: background-color 100ms, border-color 100ms; }
	.facet-btn:hover:not([disabled]) { border-color: var(--facet-accent, #3b5bdb); color: var(--facet-accent, #3b5bdb); }
	.facet-btn[disabled] { opacity: 0.45; cursor: default; }
	.facet-note { font-size: 12px; color: var(--facet-text-muted, #5d6878); padding: 6px 0; }
	.facet-note-empty { padding: 14px 0; text-align: center; color: var(--facet-text-faint, #8a94a3); }
	.facet-foot { margin-top: 8px; font-size: 11px; color: var(--facet-text-faint, #8a94a3); font-variant-numeric: tabular-nums; }
	.facet-inline-error { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: var(--facet-radius-sm, 6px); font-size: 12px;
		background: var(--facet-error-soft, #fdecec); color: var(--facet-error, #c92a2a); }
	.facet-inline-error-code { font-family: var(--facet-mono, ui-monospace, Menlo, monospace); font-weight: 600; }
	.facet-inline-error .facet-btn { align-self: flex-start; }
	.facet-unavailable { padding: 14px 0; text-align: center; font-size: 12px; color: var(--facet-text-faint, #8a94a3); }
	.facet-num { font-variant-numeric: tabular-nums; }
	.facet-loading-dim { opacity: 0.6; transition: opacity 120ms; }
`;

// Shared fragments (iterated with {~TS:~} by every widget).
const _SHARED_TEMPLATES =
	[
		{
			Hash: 'Facet-Badge-Template',
			Template: /*html*/`<span class="facet-badge facet-badge-{~D:Record.Tone~}" title="{~D:Record.Tip~}">{~D:Record.Text~}</span>`
		},
		{
			Hash: 'Facet-Footer-Template',
			Template: /*html*/`<div class="facet-foot">{~D:Record.Text~}</div>`
		},
		{
			Hash: 'Facet-Unavailable-Template',
			Template: /*html*/`<div class="facet-unavailable">{~D:Record.Text~}</div>`
		},
		{
			Hash: 'Facet-Empty-Template',
			Template: /*html*/`<div class="facet-note facet-note-empty">{~D:Record.Text~}</div>`
		},
		{
			Hash: 'Facet-Inline-Error-Template',
			Template: /*html*/`
<div class="facet-inline-error" role="alert">
	<div><span class="facet-inline-error-code">{~I:Warning~} {~D:Record.Code~} · {~D:Record.Status~}</span> {~D:Record.Message~}</div>
	{~TS:Facet-Inline-Error-Suggest-Template:Record.SuggestSlot~}
</div>`
		},
		{
			Hash: 'Facet-Inline-Error-Suggest-Template',
			Template: /*html*/`<button type="button" class="facet-btn" onclick="{~P~}.providers.Facet.setFacetOption('{~D:Record.Group~}', '{~D:Record.Key~}', { Interval: '{~D:Record.Interval~}' })">{~I:Refresh~} Use {~D:Record.Interval~}</button>`
		}
	];

/**
 * performance.now() when available (browser), else Date.now().
 *
 * @return {number}
 */
const now = () =>
{
	if ((typeof(performance) === 'object') && (performance !== null) && (typeof(performance.now) === 'function'))
	{
		return performance.now();
	}
	return Date.now();
};

/**
 * 'x-retold-facet-records-dropped' -> 'X-Retold-Facet-Records-Dropped'
 *
 * @param {string} pName
 * @return {string}
 */
const canonicalHeaderName = (pName) =>
{
	let tmpName = String(pName || '').toLowerCase();
	if (KEPT_HEADERS[tmpName])
	{
		return KEPT_HEADERS[tmpName];
	}
	return tmpName.split('-').map((pPart) => { return pPart.charAt(0).toUpperCase() + pPart.slice(1); }).join('-');
};

class PictProviderFacet extends libPictProvider
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, Object.assign({}, _DEFAULT_CONFIGURATION, pOptions || {}), pServiceHash);

		this.serviceType = 'PictProviderFacet';

		// Host wiring
		this._EndpointPrefix = () => { return ''; };
		this._RequestHeaders = () => { return {}; };

		// Runtime (not AppData: functions, timers, in-flight bookkeeping)
		this._Listeners = {};          // GroupHash -> [ fListener ]
		this._LogListeners = [];       // [ fListener ] (the inspector)
		this._CoalesceTimers = {};     // GroupHash -> timer id
		this._PendingCallbacks = {};   // GroupHash -> [ fCallback ] waiting on the coalesced POST
		this._PendingSpecs = {};       // GroupHash -> { Key: spec } extra specs merged by query()
		this._InFlight = {};           // GroupHash -> { Seq, Controller, Callbacks } of the Query in flight
		this._RecordsSeq = {};         // GroupHash -> sequence of the latest records page request
		this._CountSeq = {};           // GroupHash -> sequence of the latest count request
		this._Cache = new Map();       // requestKey -> { ETag, Body }   (Map insertion order = LRU order)
		this._DescribeInFlight = {};   // Domain|Principal -> [ fCallback ]
		this._DescribedFor = {};       // Domain -> the principal whose Describe sits in AppData.FacetCapabilities
		this._VerifyAfter = {};        // GroupHash -> [ fCallback ] count checks waiting for the Query in flight
		this._Labels = {};             // Principal|Group|FacetKey -> { '<key>': { Key, Label, LabelResolved } }
		this._LookupCache = {};        // Domain|Principal|Entity|KeyField -> { '<key>': [ rows ] }
		this._PrincipalInfo = {};      // what the host knows about the principal (e.g. { User: 42 }) for "(you)"
		this._Streams = {};            // Domain -> the change stream (M4): { Domain, PrincipalKey, Controller, Source, Timer, … }
		this._PendingFreshness = {};   // GroupHash -> { MinSeq, Exact, Trigger } for the next flush (an SSE refetch)
		this._StaleTimers = {};        // GroupHash -> the follow-up refetch of a Stale answer
		this._ChangeTimers = {};       // GroupHash -> the jittered SSE-triggered refetch
		this._IsGroupVisible = () => { return true; };

		if (!this.pict.AppData.Facet)
		{
			this.pict.AppData.Facet = { PrincipalKey: null, Groups: {}, Log: [], LogSeq: 0 };
		}
		if (!this.pict.AppData.Facet.Inspector)
		{
			this.pict.AppData.Facet.Inspector = { Open: false, SelectedID: null, Tab: 'Envelope' };
		}
		if (!this.pict.AppData.Facet.DescribeErrors)
		{
			this.pict.AppData.Facet.DescribeErrors = {};
		}
		if (typeof(this.pict.AppData.Facet.ShowInternals) !== 'boolean')
		{
			this.pict.AppData.Facet.ShowInternals = false;
		}
		if (!this.pict.AppData.FacetCapabilities)
		{
			this.pict.AppData.FacetCapabilities = {};
		}
		if (!this.pict.AppData.Facet.Changes)
		{
			this.pict.AppData.Facet.Changes = {};
		}

		// Shared widget chrome (providers register CSS and templates themselves; views get theirs from configuration).
		if (this.pict.CSSMap && (typeof(this.pict.CSSMap.addCSS) === 'function'))
		{
			this.pict.CSSMap.addCSS('Pict-Provider-Facet-CSS', _SHARED_CSS, 400, 'Pict-Provider-Facet');
		}
		if (this.pict.TemplateProvider && (typeof(this.pict.TemplateProvider.addTemplate) === 'function'))
		{
			_SHARED_TEMPLATES.forEach(
				(pTemplate) =>
				{
					this.pict.TemplateProvider.addTemplate(pTemplate.Hash, pTemplate.Template, 'Pict-Provider-Facet');
				});
		}
	}

	// ------------------------------------------------------------------ host wiring

	/**
	 * @param {(pDomain: string) => string} fPrefix - e.g. (pDomain) => `/api/${pDomain}`
	 */
	setEndpointPrefix(fPrefix)
	{
		this._EndpointPrefix = (typeof(fPrefix) === 'function') ? fPrefix : () => { return ''; };
	}

	/**
	 * @param {() => Record<string, string>} fHeaders - merged into every request
	 */
	setRequestHeaders(fHeaders)
	{
		this._RequestHeaders = (typeof(fHeaders) === 'function') ? fHeaders : () => { return {}; };
	}

	/**
	 * Partition the Version cache and the Describe capabilities by principal.  Does not refresh anything.
	 *
	 * @param {string|null} pKey
	 */
	setPrincipalKey(pKey)
	{
		this.pict.AppData.Facet.PrincipalKey = pKey || null;
	}

	/**
	 * @return {string|null}
	 */
	principalKey()
	{
		return this.pict.AppData.Facet.PrincipalKey || null;
	}

	/**
	 * What the host knows about the current principal (display only: { User: 42 } lets a list say "(you)").
	 *
	 * @param {Record<string, any>|null} pInfo
	 */
	setPrincipalInfo(pInfo)
	{
		this._PrincipalInfo = (pInfo && (typeof(pInfo) === 'object')) ? Object.assign({}, pInfo) : {};
	}

	/**
	 * @return {Record<string, any>}
	 */
	principalInfo()
	{
		return this._PrincipalInfo;
	}

	/**
	 * Show the contract vocabulary (Fold, CountMode, Relaxed, …) on the widget cards.  The views read it on their
	 * next render; the host re-renders.
	 *
	 * @param {boolean} pShow
	 */
	setShowInternals(pShow)
	{
		this.pict.AppData.Facet.ShowInternals = (pShow === true);
	}

	/**
	 * @return {boolean}
	 */
	showInternals()
	{
		return (this.pict.AppData.Facet.ShowInternals === true);
	}

	// ------------------------------------------------------------------ focus across re-renders

	/**
	 * Every widget replaces its panel HTML on re-render; a keyboard user must not be thrown back to the top of
	 * the page.  Interactive elements carry data-focus-key; a view captures the focused key before it renders
	 * and restores it after.
	 *
	 * @param {string} pContainerID - the panel container id
	 * @return {string|null} the data-focus-key of the focused element inside it
	 */
	captureFocus(pContainerID)
	{
		if ((typeof(document) === 'undefined') || !document.activeElement || (typeof(document.getElementById) !== 'function'))
		{
			return null;
		}
		let tmpContainer = document.getElementById(pContainerID);
		let tmpActive = document.activeElement;
		if (!tmpContainer || !tmpContainer.contains(tmpActive) || (typeof(tmpActive.getAttribute) !== 'function'))
		{
			return null;
		}
		return tmpActive.getAttribute('data-focus-key') || null;
	}

	/**
	 * @param {string} pContainerID
	 * @param {string|null} pFocusKey - from captureFocus
	 */
	restoreFocus(pContainerID, pFocusKey)
	{
		if (!pFocusKey || (typeof(document) === 'undefined') || (typeof(document.getElementById) !== 'function'))
		{
			return;
		}
		let tmpContainer = document.getElementById(pContainerID);
		if (!tmpContainer)
		{
			return;
		}
		let tmpElements = tmpContainer.querySelectorAll('[data-focus-key]');
		for (let i = 0; i < tmpElements.length; i++)
		{
			if (tmpElements[i].getAttribute('data-focus-key') === pFocusKey)
			{
				try
				{
					tmpElements[i].focus({ preventScroll: true });
				}
				catch (pError)
				{
					tmpElements[i].focus();
				}
				return;
			}
		}
	}

	// ------------------------------------------------------------------ groups

	/**
	 * Register a group (FacetDemo-Pages Groups[*]).  Idempotent: an existing state is kept unless pReset.
	 *
	 * @param {Record<string, any>} pDefinition
	 * @param {boolean} [pReset]
	 * @return {Record<string, any>} the group state
	 */
	defineGroup(pDefinition, pReset)
	{
		let tmpGroups = this.pict.AppData.Facet.Groups;
		let tmpPrevious = tmpGroups[pDefinition.Hash] || null;
		if (!tmpPrevious || pReset)
		{
			let tmpState = libFacetSelection.initialGroupState(pDefinition);
			// Runtime additions (DEMO-SPEC §4.2 lists the contract fields; these feed the summary strip).
			tmpState.PendingPrincipalKey = null;
			tmpState.PostsSinceChange = 0;
			tmpState.LastAnswer = null;
			tmpState.AnswerSeq = null;
			tmpState.FacetsFrom = pDefinition.FacetsFrom || null;
			tmpState.DescribedPanels = null;
			tmpState.DescribedSkipped = null;
			tmpState.DescribedFor = null;
			if (tmpPrevious && (pDefinition.FacetsFrom === 'Describe'))
			{
				// A reset goes back to the initial selections, not to "no facets": the Describe-derived list stays.
				tmpState.Facets = libFacetSelection.cloneJSON(tmpPrevious.Facets || []);
				tmpState.DescribedPanels = tmpPrevious.DescribedPanels;
				tmpState.DescribedSkipped = tmpPrevious.DescribedSkipped;
				tmpState.DescribedFor = tmpPrevious.DescribedFor;
			}
			tmpGroups[pDefinition.Hash] = tmpState;
		}
		return tmpGroups[pDefinition.Hash];
	}

	/**
	 * Install the facet list of a Describe-driven group (FacetsFrom: 'Describe'): the request specs and the
	 * panels the page draws for them.  Selections of facets that are gone are dropped.  Does not refresh.
	 *
	 * @param {string} pGroupHash
	 * @param {Array<Record<string, any>>} pFacets - request specs
	 * @param {Array<Record<string, any>>} pPanels - layout entries ({ Region, Widget, FacetKey, … })
	 * @param {Array<Record<string, any>>} [pSkipped] - [ { Facet, Reason } ] Describe offered but the page does not draw
	 * @return {boolean} whether the facet list changed
	 */
	applyDescribedFacets(pGroupHash, pFacets, pPanels, pSkipped)
	{
		let tmpState = this.group(pGroupHash);
		if (!tmpState)
		{
			return false;
		}
		let tmpFacets = libFacetSelection.cloneJSON(Array.isArray(pFacets) ? pFacets : []);
		let tmpChanged = (JSON.stringify(tmpFacets) !== JSON.stringify(tmpState.Facets || [])) || (JSON.stringify(pPanels || []) !== JSON.stringify(tmpState.DescribedPanels || []));
		tmpState.Facets = tmpFacets;
		tmpState.DescribedPanels = libFacetSelection.cloneJSON(Array.isArray(pPanels) ? pPanels : []);
		tmpState.DescribedSkipped = libFacetSelection.cloneJSON(Array.isArray(pSkipped) ? pSkipped : []);
		tmpState.DescribedFor = this.principalKey();
		let tmpKeys = tmpFacets.map((pSpec) => { return pSpec.Key; });
		Object.keys(tmpState.Selections).forEach(
			(pFacetKey) =>
			{
				if (tmpKeys.indexOf(pFacetKey) < 0)
				{
					delete tmpState.Selections[pFacetKey];
				}
			});
		return tmpChanged;
	}

	/**
	 * Put a group in the Error state without a Query (e.g. its facet list comes from a Describe that failed).
	 *
	 * @param {string} pGroupHash
	 * @param {Record<string, any>} pError - { Code, Status, Message }
	 */
	failGroup(pGroupHash, pError)
	{
		let tmpState = this.group(pGroupHash);
		if (!tmpState)
		{
			return;
		}
		tmpState.Status = 'Error';
		tmpState.Error = pError || { Code: 'DEMO_NETWORK', Status: 0, Message: 'No answer.' };
		tmpState.Envelope = null;
		tmpState.RecordsPage = null;
		tmpState.CountCheck = null;
		tmpState.PrincipalKey = this.principalKey();
		tmpState.PendingPrincipalKey = null;
		this.notify(pGroupHash, 'Error');
	}

	/**
	 * @param {string} pGroupHash
	 * @return {Record<string, any>|null}
	 */
	group(pGroupHash)
	{
		return this.pict.AppData.Facet.Groups[pGroupHash] || null;
	}

	/**
	 * Does the group need a (re)load for the current principal?  True when it never loaded, last answered
	 * for another principal, ended in an error, or a change event arrived while it was not on screen
	 * (ChangedSince) -- and nothing for the current principal is in flight.
	 *
	 * @param {string} pGroupHash
	 * @return {boolean}
	 */
	isStale(pGroupHash)
	{
		let tmpState = this.group(pGroupHash);
		if (!tmpState)
		{
			return false;
		}
		let tmpPrincipal = this.principalKey();
		if ((tmpState.Status === 'Loading') && (tmpState.PendingPrincipalKey === tmpPrincipal))
		{
			return false;
		}
		if (this._CoalesceTimers[pGroupHash])
		{
			return false;
		}
		return (tmpState.Status === 'Idle') || (tmpState.Status === 'Error') || (tmpState.PrincipalKey !== tmpPrincipal) || !!tmpState.ChangedSince;
	}

	/**
	 * @param {string} pGroupHash
	 * @param {(pState: Record<string, any>, pReason: string) => void} fListener
	 * @return {() => void} unsubscribe
	 */
	subscribe(pGroupHash, fListener)
	{
		if (!this._Listeners[pGroupHash])
		{
			this._Listeners[pGroupHash] = [];
		}
		this._Listeners[pGroupHash].push(fListener);
		return () =>
		{
			this._Listeners[pGroupHash] = (this._Listeners[pGroupHash] || []).filter((pListener) => { return pListener !== fListener; });
		};
	}

	/**
	 * @param {string} pGroupHash
	 * @param {string} pReason - 'Loading' | 'Ready' | 'Error' | 'Records' | 'Count' | 'State' | 'Stream'
	 */
	notify(pGroupHash, pReason)
	{
		let tmpState = this.group(pGroupHash);
		(this._Listeners[pGroupHash] || []).slice().forEach(
			(fListener) =>
			{
				try
				{
					fListener(tmpState, pReason);
				}
				catch (pError)
				{
					this.log.error(`Pict-Provider-Facet: a [${pGroupHash}] listener failed: ${pError.message}`);
				}
			});
	}

	/**
	 * Listen to the exchange log (every exchange start and finish).
	 *
	 * @param {(pLog: Array<Record<string, any>>) => void} fListener
	 * @return {() => void} unsubscribe
	 */
	subscribeLog(fListener)
	{
		this._LogListeners.push(fListener);
		return () =>
		{
			this._LogListeners = this._LogListeners.filter((pListener) => { return pListener !== fListener; });
		};
	}

	_notifyLog()
	{
		let tmpLog = this.pict.AppData.Facet.Log;
		this._LogListeners.slice().forEach(
			(fListener) =>
			{
				try
				{
					fListener(tmpLog);
				}
				catch (pError)
				{
					this.log.error(`Pict-Provider-Facet: a log listener failed: ${pError.message}`);
				}
			});
	}

	/**
	 * Every filter write starts the list over and invalidates the count check.
	 *
	 * @param {Record<string, any>} pState
	 */
	_markFilterChange(pState)
	{
		if (pState.Records)
		{
			pState.Records.Begin = 0;
		}
		pState.CountCheck = null;
		pState.PostsSinceChange = 0;
	}

	/**
	 * A widget's write-back (DEMO-SPEC §5.2): the clause it copied from a bucket, or null to clear.
	 *
	 * @param {string} pGroupHash
	 * @param {string} pFacetKey
	 * @param {Record<string, any>|null} pClause
	 * @return {boolean}
	 */
	setSelection(pGroupHash, pFacetKey, pClause)
	{
		let tmpSelections = {};
		tmpSelections[pFacetKey] = pClause;
		return this.setSelections(pGroupHash, tmpSelections);
	}

	/**
	 * Several write-backs, one POST (a pivot cell sets two facets).
	 *
	 * @param {string} pGroupHash
	 * @param {Record<string, Record<string, any>|null>} pSelections
	 * @return {boolean}
	 */
	setSelections(pGroupHash, pSelections)
	{
		let tmpState = this.group(pGroupHash);
		if (!tmpState)
		{
			return false;
		}
		let tmpSelections = pSelections || {};
		Object.keys(tmpSelections).forEach(
			(pFacetKey) =>
			{
				let tmpClause = tmpSelections[pFacetKey];
				if (tmpClause && (typeof(tmpClause) === 'object'))
				{
					tmpState.Selections[pFacetKey] = libFacetSelection.cloneJSON(tmpClause);
				}
				else
				{
					delete tmpState.Selections[pFacetKey];
				}
			});
		this._markFilterChange(tmpState);
		this.notify(pGroupHash, 'State');
		this.refresh(pGroupHash);
		return true;
	}

	/**
	 * @param {string} pGroupHash
	 * @param {string} pScope
	 * @param {boolean} pOn
	 * @param {Record<string, any>} [pParams] - replaces the scope's Params when given
	 * @return {boolean}
	 */
	setScope(pGroupHash, pScope, pOn, pParams)
	{
		let tmpState = this.group(pGroupHash);
		if (!tmpState)
		{
			return false;
		}
		// Insertion order is the body order: an existing scope keeps its place, a new one appends.
		if (!tmpState.ScopeState[pScope])
		{
			tmpState.ScopeState[pScope] = { On: false, Params: {} };
		}
		tmpState.ScopeState[pScope].On = (pOn === true);
		if (pParams && (typeof(pParams) === 'object'))
		{
			tmpState.ScopeState[pScope].Params = libFacetSelection.cloneJSON(pParams);
		}
		this._markFilterChange(tmpState);
		this.notify(pGroupHash, 'State');
		this.refresh(pGroupHash);
		return true;
	}

	/**
	 * Edit a facet spec in place (e.g. { Interval: 'week' }) and refresh.  A null / undefined option removes it.
	 *
	 * @param {string} pGroupHash
	 * @param {string} pFacetKey
	 * @param {Record<string, any>} pOptions
	 * @return {boolean}
	 */
	setFacetOption(pGroupHash, pFacetKey, pOptions)
	{
		let tmpState = this.group(pGroupHash);
		if (!tmpState)
		{
			return false;
		}
		let tmpSpec = tmpState.Facets.find((pSpec) => { return pSpec.Key === pFacetKey; });
		if (!tmpSpec)
		{
			return false;
		}
		let tmpOptions = pOptions || {};
		Object.keys(tmpOptions).forEach(
			(pOption) =>
			{
				if ((tmpOptions[pOption] === null) || (typeof(tmpOptions[pOption]) === 'undefined'))
				{
					delete tmpSpec[pOption];
				}
				else
				{
					tmpSpec[pOption] = libFacetSelection.cloneJSON(tmpOptions[pOption]);
				}
			});
		this._markFilterChange(tmpState);
		this.notify(pGroupHash, 'State');
		this.refresh(pGroupHash);
		return true;
	}

	/**
	 * Header click on a records column: same field toggles ASC/DESC, a new field starts ASC.  Refreshes the
	 * group (the sort travels in the Query body's Records, so the first page and the facets stay one POST).
	 *
	 * @param {string} pGroupHash
	 * @param {string} pField
	 * @return {boolean}
	 */
	setRecordsSort(pGroupHash, pField)
	{
		let tmpState = this.group(pGroupHash);
		if (!tmpState || !tmpState.Records)
		{
			return false;
		}
		let tmpCurrent = (Array.isArray(tmpState.Records.Sort) && (tmpState.Records.Sort.length > 0)) ? tmpState.Records.Sort[0] : null;
		let tmpDir = 'ASC';
		if (tmpCurrent && (tmpCurrent.Field === pField))
		{
			tmpDir = (tmpCurrent.Dir === 'ASC') ? 'DESC' : 'ASC';
		}
		tmpState.Records.Sort = [ { Field: pField, Dir: tmpDir } ];
		tmpState.Records.Begin = 0;
		tmpState.PostsSinceChange = 0;
		this.notify(pGroupHash, 'State');
		this.refresh(pGroupHash);
		return true;
	}

	/**
	 * @param {string} pGroupHash
	 * @return {boolean}
	 */
	clearSelections(pGroupHash)
	{
		let tmpState = this.group(pGroupHash);
		if (!tmpState)
		{
			return false;
		}
		tmpState.Selections = {};
		this._markFilterChange(tmpState);
		this.notify(pGroupHash, 'State');
		this.refresh(pGroupHash);
		return true;
	}

	// ------------------------------------------------------------------ change stream (M4, internal-contracts §47)

	/**
	 * Tell the provider which groups are on screen.  A change event refetches a visible group at once; any other
	 * group of the domain is marked (ChangedSince) and refetched when it is shown (isStale is true for it).
	 *
	 * @param {(pGroupHash: string) => boolean} fIsVisible
	 */
	setGroupVisibility(fIsVisible)
	{
		this._IsGroupVisible = (typeof(fIsVisible) === 'function') ? fIsVisible : () => { return true; };
	}

	/**
	 * @param {string} pDomain
	 * @return {Record<string, any>|null} AppData.Facet.Changes[pDomain]
	 */
	changeState(pDomain)
	{
		return this.pict.AppData.Facet.Changes[pDomain] || null;
	}

	/**
	 * Refetch a group because data it depends on changed (an SSE event): the group's normal coalesced POST (one per
	 * group per tick, If-None-Match from the Version cache) with Freshness.MinSeq = pSeq (Mode 'Exact' when the
	 * event carried no Seq).  A group that is not on screen is only marked; a group that never asked is left alone.
	 *
	 * @param {string} pGroupHash
	 * @param {string|null} pSeq
	 * @param {string} [pTrigger] - logged on the exchange and shown on the page ("Live update: Project @ e:…:15")
	 * @return {boolean} true when a refetch was scheduled
	 */
	refreshForChange(pGroupHash, pSeq, pTrigger)
	{
		let tmpState = this.group(pGroupHash);
		if (!tmpState || ((tmpState.Status === 'Idle') && !tmpState.Envelope))
		{
			return false;
		}
		let tmpSeq = libFacetChanges.parseSeq(pSeq) ? pSeq : null;
		let tmpTrigger = pTrigger || libFacetChanges.triggerText(null, tmpSeq);
		if (!this._IsGroupVisible(pGroupHash))
		{
			let tmpChanged = tmpState.ChangedSince || {};
			tmpState.ChangedSince = { Seq: libFacetChanges.laterSeq(tmpChanged.Seq || null, tmpSeq), Exact: (!tmpSeq || !!tmpChanged.Exact), Trigger: tmpTrigger };
			return false;
		}
		let tmpPending = this._PendingFreshness[pGroupHash] || {};
		this._PendingFreshness[pGroupHash] = { MinSeq: libFacetChanges.laterSeq(tmpPending.MinSeq || null, tmpSeq), Exact: (!tmpSeq || !!tmpPending.Exact), Trigger: tmpTrigger };
		let tmpJitterMS = Number(this.options.ChangeJitterMS);
		if (!(tmpJitterMS > 0))
		{
			return this.refresh(pGroupHash);
		}
		if (!this._ChangeTimers[pGroupHash])
		{
			// One jittered refetch per group: later events before it fires merge into its pending freshness.
			this._ChangeTimers[pGroupHash] = setTimeout(
				() =>
				{
					delete this._ChangeTimers[pGroupHash];
					this.refresh(pGroupHash);
				}, Math.round(Math.random() * tmpJitterMS));
		}
		return true;
	}

	/**
	 * Refetch every group of a domain (a reconnect or a model change: anything may have changed).
	 *
	 * @param {string} pDomain
	 * @param {string|null} pSeq
	 * @param {string} pTrigger
	 * @return {Array<string>} the groups refetched now
	 */
	refetchDomain(pDomain, pSeq, pTrigger)
	{
		let tmpGroups = this.pict.AppData.Facet.Groups;
		return Object.keys(tmpGroups).sort().filter(
			(pGroupHash) =>
			{
				return (tmpGroups[pGroupHash].Domain === pDomain) && this.refreshForChange(pGroupHash, pSeq, pTrigger);
			});
	}

	/**
	 * A host write (e.g. a demo's "Make a change" call through its CRUD API): logged as an exchange of Kind 'Write',
	 * never cached, Ok for any 2xx.  The provider does not refresh anything afterwards: the change stream does.
	 *
	 * @param {string} pDomain
	 * @param {string} pMethod - 'POST' | 'PUT' | 'DELETE' | 'GET'
	 * @param {string} pPath - upstream path, '/1.0/<Entity>…'
	 * @param {any} pBody - object or null
	 * @param {{ GroupHash?: string|null, Trigger?: string }} pOptions
	 * @param {(pError?: Error|null, pResponse?: Record<string, any>) => void} fCallback
	 */
	write(pDomain, pMethod, pPath, pBody, pOptions, fCallback)
	{
		let tmpOptions = Object.assign({}, pOptions || {}, { Kind: 'Write', NoCache: true });
		return this.request(pDomain, pMethod, pPath, pBody, tmpOptions, fCallback);
	}

	/**
	 * Open (or keep) the change stream of a domain for the current principal (§47.1).
	 *
	 * @param {string} pDomain
	 * @return {Record<string, any>|null} the change state
	 */
	subscribeChanges(pDomain)
	{
		let tmpPrincipal = this.principalKey();
		let tmpExisting = this._Streams[pDomain] || null;
		if (tmpExisting && (tmpExisting.PrincipalKey === tmpPrincipal) && !tmpExisting.Closed)
		{
			// Open, connecting, waiting to reconnect, or stopped for this principal (401 / 429 / closed): keep it.
			return this.changeState(pDomain);
		}
		if (tmpExisting)
		{
			this._closeStream(tmpExisting, 'Principal');
		}
		let tmpStream =
			{
				Domain: pDomain,
				PrincipalKey: tmpPrincipal,
				Closed: false,
				Stopped: false,
				Controller: null,
				Source: null,
				Timer: null,
				Attempt: 0,
				RetryMS: libFacetChanges.DEFAULT_RETRY_MS,
				LastEventID: null,
				ReadyCount: 0,
				Generation: 0
			};
		this._Streams[pDomain] = tmpStream;
		this.pict.AppData.Facet.Changes[pDomain] = { Status: 'Connecting', PrincipalKey: tmpPrincipal, LastSeq: null, LastEventAt: null, Events: 0, Reconnects: 0, Reason: null, Error: null, NodeEpoch: null, Transport: null };
		this._openStream(tmpStream);
		return this.changeState(pDomain);
	}

	/**
	 * Close the change stream of one domain, or of every domain (a principal switch closes all; the next
	 * subscribeChanges opens a stream for the new principal).
	 *
	 * @param {string} [pDomain]
	 */
	closeChanges(pDomain)
	{
		let tmpDomains = (typeof(pDomain) === 'string') ? [ pDomain ] : Object.keys(this._Streams);
		tmpDomains.forEach(
			(pName) =>
			{
				let tmpStream = this._Streams[pName];
				if (tmpStream)
				{
					this._closeStream(tmpStream, 'Client');
				}
			});
	}

	/**
	 * @param {Record<string, any>} pStream
	 * @param {string} pReason
	 */
	_closeStream(pStream, pReason)
	{
		pStream.Closed = true;
		pStream.Generation++;
		if (pStream.Timer)
		{
			clearTimeout(pStream.Timer);
			pStream.Timer = null;
		}
		if (pStream.Controller)
		{
			try
			{
				pStream.Controller.abort();
			}
			catch (pError)
			{
				// already settled
			}
			pStream.Controller = null;
		}
		if (pStream.Source)
		{
			try
			{
				pStream.Source.close();
			}
			catch (pError)
			{
				// already closed
			}
			pStream.Source = null;
		}
		if (this._Streams[pStream.Domain] === pStream)
		{
			delete this._Streams[pStream.Domain];
		}
		this._setStreamState(pStream, { Status: 'Closed', Reason: pReason });
	}

	/**
	 * Update the domain's change state (when it still belongs to this stream) and tell the domain's groups.
	 *
	 * @param {Record<string, any>} pStream
	 * @param {Record<string, any>} pPatch
	 */
	_setStreamState(pStream, pPatch)
	{
		let tmpState = this.pict.AppData.Facet.Changes[pStream.Domain];
		if (!tmpState || (tmpState.PrincipalKey !== pStream.PrincipalKey))
		{
			return;
		}
		let tmpBefore = `${tmpState.Status}|${tmpState.Reconnects}`;
		Object.assign(tmpState, pPatch || {});
		if (`${tmpState.Status}|${tmpState.Reconnects}` === tmpBefore)
		{
			return;
		}
		let tmpGroups = this.pict.AppData.Facet.Groups;
		Object.keys(tmpGroups).forEach(
			(pGroupHash) =>
			{
				if (tmpGroups[pGroupHash].Domain === pStream.Domain)
				{
					this.notify(pGroupHash, 'Stream');
				}
			});
		this._notifyLog();
	}

	/**
	 * Which transport this host needs: EventSource cannot send request headers, so a host that authenticates
	 * through headers (the demo's persona header) reads the stream with fetch().
	 *
	 * @return {string} 'EventSource' | 'Fetch' | 'None'
	 */
	_streamTransport()
	{
		let tmpWanted = this.options.ChangesTransport || 'Auto';
		let tmpHasFetch = (typeof(fetch) === 'function') && (typeof(TextDecoder) === 'function');
		let tmpHasEventSource = (typeof(EventSource) === 'function');
		if (tmpWanted === 'EventSource')
		{
			return tmpHasEventSource ? 'EventSource' : 'None';
		}
		if (tmpWanted === 'Fetch')
		{
			return tmpHasFetch ? 'Fetch' : 'None';
		}
		let tmpHeaders = this._RequestHeaders() || {};
		if (tmpHasEventSource && (Object.keys(tmpHeaders).length < 1))
		{
			return 'EventSource';
		}
		return tmpHasFetch ? 'Fetch' : 'None';
	}

	/**
	 * @param {Record<string, any>} pStream
	 */
	_openStream(pStream)
	{
		if (pStream.Closed)
		{
			return;
		}
		pStream.Timer = null;
		let tmpTransport = this._streamTransport();
		this._setStreamState(pStream, { Status: 'Connecting', Transport: tmpTransport });
		if (tmpTransport === 'None')
		{
			pStream.Stopped = true;
			this._setStreamState(pStream, { Status: 'Closed', Reason: 'Unsupported' });
			return;
		}
		let tmpURL = `${this._EndpointPrefix(pStream.Domain)}/1.0/Facet/Changes`;
		let tmpGeneration = pStream.Generation;
		if (tmpTransport === 'EventSource')
		{
			return this._openEventSource(pStream, tmpURL, tmpGeneration);
		}
		let tmpController = (typeof(AbortController) === 'function') ? new AbortController() : null;
		pStream.Controller = tmpController;
		let tmpHeaders = Object.assign({ 'Accept': 'text/event-stream' }, this._RequestHeaders() || {});
		if (pStream.LastEventID)
		{
			tmpHeaders['Last-Event-ID'] = pStream.LastEventID;
		}
		let fCurrent = () => { return !pStream.Closed && (pStream.Generation === tmpGeneration); };
		let tmpParser = libFacetChanges.createParser((pEvent) => { if (fCurrent()) { this._onStreamEvent(pStream, pEvent); } });
		let tmpFetchOptions = { method: 'GET', headers: tmpHeaders, cache: 'no-store', credentials: 'same-origin' };
		if (tmpController)
		{
			tmpFetchOptions.signal = tmpController.signal;
		}
		fetch(tmpURL, tmpFetchOptions)
			.then(
				(pResponse) =>
				{
					if (!fCurrent())
					{
						return null;
					}
					let tmpType = String(pResponse.headers.get('content-type') || '');
					if ((pResponse.status !== 200) || !/text\/event-stream/i.test(tmpType) || !pResponse.body || (typeof(pResponse.body.getReader) !== 'function'))
					{
						return pResponse.text().then(
							(pText) =>
							{
								let tmpError = null;
								try
								{
									let tmpParsed = JSON.parse(pText);
									tmpError = (tmpParsed && tmpParsed.Error && (typeof(tmpParsed.Error) === 'object')) ? tmpParsed.Error : null;
								}
								catch (pParseError)
								{
									tmpError = null;
								}
								if (fCurrent())
								{
									this._streamRefused(pStream, pResponse.status, tmpError || { Code: `DEMO_HTTP_${pResponse.status}`, Status: pResponse.status, Message: (pResponse.status === 200) ? 'The answer is not an event stream.' : (pResponse.statusText || `HTTP ${pResponse.status}`) });
								}
							});
					}
					this._setStreamState(pStream, { Status: 'Open', Error: null, Reason: null });
					let tmpReader = pResponse.body.getReader();
					let tmpDecoder = new TextDecoder('utf-8');
					let fRead = () =>
					{
						return tmpReader.read().then(
							(pChunk) =>
							{
								if (!fCurrent())
								{
									try
									{
										tmpReader.cancel();
									}
									catch (pError)
									{
										// already done
									}
									return null;
								}
								if (pChunk.done)
								{
									tmpParser.feed(tmpDecoder.decode());
									tmpParser.flush();
									return this._streamEnded(pStream, null);
								}
								tmpParser.feed(tmpDecoder.decode(pChunk.value, { stream: true }));
								return fRead();
							});
					};
					return fRead();
				})
			.catch(
				(pError) =>
				{
					if (!fCurrent() || (pError && (pError.name === 'AbortError')))
					{
						return;
					}
					this._streamEnded(pStream, { Code: 'DEMO_NETWORK', Status: 0, Message: (pError && pError.message) ? pError.message : 'The change stream failed.' });
				});
	}

	/**
	 * The EventSource transport (a host whose session travels in cookies): the browser reconnects by itself.
	 *
	 * @param {Record<string, any>} pStream
	 * @param {string} pURL
	 * @param {number} pGeneration
	 */
	_openEventSource(pStream, pURL, pGeneration)
	{
		let tmpSource = null;
		try
		{
			tmpSource = new EventSource(pURL, { withCredentials: true });
		}
		catch (pError)
		{
			pStream.Stopped = true;
			this._setStreamState(pStream, { Status: 'Closed', Reason: 'Unsupported', Error: { Code: 'DEMO_NETWORK', Status: 0, Message: pError.message } });
			return;
		}
		pStream.Source = tmpSource;
		let fCurrent = () => { return !pStream.Closed && (pStream.Generation === pGeneration) && (pStream.Source === tmpSource); };
		tmpSource.onopen = () =>
		{
			if (fCurrent())
			{
				this._setStreamState(pStream, { Status: 'Open', Error: null, Reason: null });
			}
		};
		tmpSource.onerror = () =>
		{
			if (!fCurrent())
			{
				return;
			}
			if (tmpSource.readyState === 2)
			{
				// The browser gave up (a refusal or not an event stream): stop until the next principal change.
				pStream.Stopped = true;
				this._setStreamState(pStream, { Status: 'Closed', Reason: 'Refused' });
				return;
			}
			let tmpState = this.changeState(pStream.Domain) || {};
			this._setStreamState(pStream, { Status: 'Connecting', Reconnects: (tmpState.Reconnects || 0) + 1 });
		};
		libFacetChanges.EVENT_TYPES.forEach(
			(pType) =>
			{
				tmpSource.addEventListener(pType,
					(pMessage) =>
					{
						if (!fCurrent())
						{
							return;
						}
						let tmpData = null;
						try
						{
							tmpData = JSON.parse(pMessage.data);
						}
						catch (pError)
						{
							tmpData = null;
						}
						this._onStreamEvent(pStream, { Event: pType, Data: tmpData, Raw: pMessage.data, ID: pMessage.lastEventId || null, Retry: null });
					});
			});
	}

	/**
	 * The server refused the stream (a non-200 answer): 401 / 403 / 404 / 429 / … stop until the next principal
	 * change; anything else (5xx, the proxy's 502) reconnects with backoff.
	 *
	 * @param {Record<string, any>} pStream
	 * @param {number} pStatus
	 * @param {Record<string, any>} pError
	 */
	_streamRefused(pStream, pStatus, pError)
	{
		pStream.Controller = null;
		if (STREAM_STOP_STATUSES.indexOf(pStatus) >= 0)
		{
			pStream.Stopped = true;
			let tmpReason = 'Refused';
			if ((pStatus === 404) || (pStatus === 405) || (pStatus === 501))
			{
				tmpReason = 'Unavailable';
			}
			else if (pStatus === 429)
			{
				tmpReason = 'Limit';
			}
			else if (pStatus === 401)
			{
				tmpReason = 'Unauthenticated';
			}
			this._setStreamState(pStream, { Status: 'Closed', Reason: tmpReason, Error: pError });
			return;
		}
		this._streamEnded(pStream, pError);
	}

	/**
	 * The stream ended (the server closed it, or the network failed): reconnect after backoff unless it was
	 * stopped ('closed' event, a refusal) or closed by the client.
	 *
	 * @param {Record<string, any>} pStream
	 * @param {Record<string, any>|null} pError
	 */
	_streamEnded(pStream, pError)
	{
		pStream.Controller = null;
		if (pStream.Closed || pStream.Stopped || pStream.Timer)
		{
			// Closed, stopped, or a reconnect is already scheduled (a 'closed' frame, then the end of the body).
			return;
		}
		let tmpDelay = libFacetChanges.backoffMS(pStream.Attempt, pStream.RetryMS);
		pStream.Attempt++;
		let tmpState = this.changeState(pStream.Domain) || {};
		this._setStreamState(pStream, { Status: 'Error', Error: pError || { Code: 'DEMO_STREAM_ENDED', Status: 0, Message: 'The change stream ended.' }, Reconnects: (tmpState.Reconnects || 0) + 1, Reason: `reconnecting in ${Math.round(tmpDelay / 100) / 10} s` });
		pStream.Timer = setTimeout(() => { this._openStream(pStream); }, tmpDelay);
	}

	/**
	 * Drop the current principal's lookup rows of an entity in a domain (a change event says they may be old).
	 *
	 * @param {string} pDomain
	 * @param {string|null} pEntity - null: every entity of the domain
	 */
	_dropLookups(pDomain, pEntity)
	{
		let tmpPrefix = `${pDomain}|${this.principalKey() || ''}|${pEntity ? `${pEntity}|` : ''}`;
		Object.keys(this._LookupCache).forEach(
			(pKey) =>
			{
				if (pKey.indexOf(tmpPrefix) === 0)
				{
					delete this._LookupCache[pKey];
				}
			});
	}

	/**
	 * One event of a domain's stream (§46.2, §47.2).
	 *
	 * @param {Record<string, any>} pStream
	 * @param {{ Event: string, Data: any, Raw?: string, ID: string|null, Retry: number|null }} pEvent
	 */
	_onStreamEvent(pStream, pEvent)
	{
		if ((typeof(pEvent.Retry) === 'number') && (pEvent.Retry > 0))
		{
			pStream.RetryMS = pEvent.Retry;
		}
		if (pEvent.ID)
		{
			pStream.LastEventID = pEvent.ID;
		}
		let tmpData = (pEvent.Data && (typeof(pEvent.Data) === 'object')) ? pEvent.Data : {};
		let tmpState = this.changeState(pStream.Domain) || {};
		let tmpPatch = { LastEventAt: new Date().toISOString(), Events: (tmpState.Events || 0) + 1 };
		let tmpSeq = libFacetChanges.parseSeq(tmpData.Seq) ? tmpData.Seq : null;
		if (tmpSeq)
		{
			tmpPatch.LastSeq = libFacetChanges.laterSeq(tmpState.LastSeq || null, tmpSeq);
		}
		let tmpRefetched = [];
		switch (pEvent.Event)
		{
			case 'ready':
				pStream.ReadyCount++;
				pStream.Attempt = 0;
				tmpPatch.Status = 'Open';
				tmpPatch.Error = null;
				tmpPatch.Reason = null;
				tmpPatch.NodeEpoch = tmpData.NodeEpoch || null;
				if ((pStream.ReadyCount > 1) || (tmpData.Reset === true))
				{
					// Events are not replayed: anything may have changed while the stream was down.
					this._dropLookups(pStream.Domain, null);
					tmpRefetched = this.refetchDomain(pStream.Domain, tmpSeq, 'Live update: the change stream reconnected');
				}
				break;
			case 'generation':
				if (typeof(tmpData.Entity) === 'string')
				{
					this._dropLookups(pStream.Domain, tmpData.Entity);
					let tmpTrigger = libFacetChanges.triggerText(tmpData.Entity, tmpSeq);
					libFacetChanges.groupsToRefetch(this.pict.AppData.Facet.Groups, pStream.Domain, tmpData.Entity).forEach(
						(pGroupHash) =>
						{
							if (this.refreshForChange(pGroupHash, tmpSeq, tmpTrigger))
							{
								tmpRefetched.push(pGroupHash);
							}
						});
				}
				break;
			case 'model':
				this._dropLookups(pStream.Domain, null);
				delete this._DescribedFor[pStream.Domain];
				tmpRefetched = this.refetchDomain(pStream.Domain, tmpSeq, 'Live update: the model changed');
				break;
			case 'closed':
				// The server ends this stream right after the frame: 'Revalidate' (the periodic re-authentication:
				// reconnect promptly, through the host's own authentication — a 401 then stops it) or 'Shutdown'
				// (a restart or a deploy: reconnect with jittered backoff).  Never a reason to stop for good.
				tmpPatch.Reason = `Server: ${tmpData.Reason || 'closed'}`;
				if (tmpData.Reason === 'Revalidate')
				{
					pStream.Attempt = 0;
				}
				if (pStream.Source)
				{
					// EventSource reconnects by itself once the server ends the response.
					break;
				}
				if (pStream.Controller)
				{
					try
					{
						pStream.Controller.abort();
					}
					catch (pError)
					{
						// already settled
					}
					pStream.Controller = null;
				}
				this._streamEnded(pStream, { Code: 'DEMO_STREAM_CLOSED', Status: 0, Message: `The server closed the change stream (${tmpData.Reason || 'closed'}).` });
				break;
			default:
				break;
		}
		this._logChange(pStream, pEvent, tmpData, tmpRefetched);
		this._setStreamState(pStream, tmpPatch);
	}

	/**
	 * Log a stream event as an exchange of Kind 'Change' (the inspector lists it with the page's domains).
	 *
	 * @param {Record<string, any>} pStream
	 * @param {Record<string, any>} pEvent
	 * @param {Record<string, any>} pData
	 * @param {Array<string>} pRefetched
	 */
	_logChange(pStream, pEvent, pData, pRefetched)
	{
		let tmpFacetState = this.pict.AppData.Facet;
		tmpFacetState.LogSeq = (tmpFacetState.LogSeq || 0) + 1;
		let tmpGroups = tmpFacetState.Groups;
		let tmpMarked = Object.keys(tmpGroups).filter((pGroupHash) => { return (tmpGroups[pGroupHash].Domain === pStream.Domain) && !!tmpGroups[pGroupHash].ChangedSince && (pRefetched.indexOf(pGroupHash) < 0); });
		tmpFacetState.Log.unshift(
			{
				ID: tmpFacetState.LogSeq,
				At: new Date().toISOString(),
				GroupHash: null,
				Kind: 'Change',
				Event: pEvent.Event,
				Domain: pStream.Domain,
				Method: 'SSE',
				URL: `${this._EndpointPrefix(pStream.Domain)}/1.0/Facet/Changes`,
				UpstreamPath: '/1.0/Facet/Changes',
				RequestHeaders: {},
				Body: null,
				Pending: false,
				Status: 200,
				NotModified: false,
				Superseded: false,
				Aborted: false,
				ElapsedMS: null,
				ResponseHeaders: {},
				Response: pEvent.Data,
				Summary: { Event: pEvent.Event, Entity: pData.Entity || null, Generation: pData.Generation || null, Seq: pData.Seq || null, Reason: pData.Reason || null, Refetched: pRefetched.slice(), Marked: tmpMarked },
				Error: null,
				Trigger: null
			});
		while (tmpFacetState.Log.length > this.options.MaxLog)
		{
			tmpFacetState.Log.pop();
		}
		this._notifyLog();
	}

	/**
	 * @param {string} pGroupHash
	 */
	_clearStaleTimer(pGroupHash)
	{
		if (this._StaleTimers[pGroupHash])
		{
			clearTimeout(this._StaleTimers[pGroupHash]);
			delete this._StaleTimers[pGroupHash];
		}
	}

	/**
	 * A Stale answer (Bounded freshness: a cached answer older than the data, while the server refreshes it in the
	 * background) is refetched once more after StaleRefetchMS, at most MaxStaleRefetches times in a row, so the page
	 * converges without a change event.
	 *
	 * @param {Record<string, any>} pState
	 */
	_scheduleStaleRefetch(pState)
	{
		let tmpStale = !!pState.LastAnswer && (pState.LastAnswer.Stale === true);
		if (!tmpStale)
		{
			pState.StaleRefetches = 0;
			return;
		}
		let tmpDelay = this.options.StaleRefetchMS;
		if (!(tmpDelay > 0) || ((pState.StaleRefetches || 0) >= this.options.MaxStaleRefetches))
		{
			return;
		}
		pState.StaleRefetches = (pState.StaleRefetches || 0) + 1;
		let tmpGroupHash = pState.Hash;
		let tmpPrincipal = pState.PrincipalKey;
		this._clearStaleTimer(tmpGroupHash);
		this._StaleTimers[tmpGroupHash] = setTimeout(
			() =>
			{
				delete this._StaleTimers[tmpGroupHash];
				let tmpCurrent = this.group(tmpGroupHash);
				if (tmpCurrent && (tmpCurrent.PrincipalKey === this.principalKey()) && (tmpPrincipal === this.principalKey()) && (tmpCurrent.Status === 'Ready'))
				{
					this._PendingFreshness[tmpGroupHash] = Object.assign({}, this._PendingFreshness[tmpGroupHash] || {}, { Trigger: `Stale answer (${Math.round(pState.LastAnswer.LagMS || 0)} ms old): refetching` });
					this.refresh(tmpGroupHash);
				}
			}, tmpDelay);
	}

	// ------------------------------------------------------------------ requests

	/**
	 * Schedule the group's Query.  Every call within CoalesceMS for one group sends ONE POST; every callback
	 * receives that answer.  A newer POST supersedes an older one (Seq): a late answer is logged Superseded
	 * and never applied.
	 *
	 * @param {string} pGroupHash
	 * @param {(pError?: Error|null, pState?: Record<string, any>) => void} [fCallback]
	 */
	refresh(pGroupHash, fCallback)
	{
		return this.query(pGroupHash, null, fCallback);
	}

	/**
	 * The design 02 §13 entry point: a widget asks for its specs; specs for one group in one tick merge by Key
	 * into the group's single POST.
	 *
	 * @param {string} pGroupHash
	 * @param {Array<Record<string, any>>|null} pFacetSpecs - extra specs (null = the group's own)
	 * @param {(pError?: Error|null, pState?: Record<string, any>) => void} [fCallback]
	 */
	query(pGroupHash, pFacetSpecs, fCallback)
	{
		let tmpState = this.group(pGroupHash);
		if (!tmpState)
		{
			if (typeof(fCallback) === 'function')
			{
				fCallback(new Error(`Pict-Provider-Facet: unknown group [${pGroupHash}].`));
			}
			return false;
		}
		if ((!Array.isArray(tmpState.Facets) || (tmpState.Facets.length < 1)) && !Array.isArray(pFacetSpecs))
		{
			// A Describe-driven group before its Describe: there is nothing to ask for yet.
			if (typeof(fCallback) === 'function')
			{
				fCallback(new Error(`Pict-Provider-Facet: group [${pGroupHash}] has no facets yet.`));
			}
			return false;
		}
		if (typeof(fCallback) === 'function')
		{
			if (!this._PendingCallbacks[pGroupHash])
			{
				this._PendingCallbacks[pGroupHash] = [];
			}
			this._PendingCallbacks[pGroupHash].push(fCallback);
		}
		if (Array.isArray(pFacetSpecs))
		{
			if (!this._PendingSpecs[pGroupHash])
			{
				this._PendingSpecs[pGroupHash] = {};
			}
			pFacetSpecs.forEach(
				(pSpec) =>
				{
					if (pSpec && (typeof(pSpec.Key) === 'string'))
					{
						this._PendingSpecs[pGroupHash][pSpec.Key] = libFacetSelection.cloneJSON(pSpec);
					}
				});
		}
		if (!this._CoalesceTimers[pGroupHash])
		{
			this._CoalesceTimers[pGroupHash] = setTimeout(() => { this._flush(pGroupHash); }, this.options.CoalesceMS);
		}
		return true;
	}

	/**
	 * Send the group's ONE coalesced POST.
	 *
	 * @param {string} pGroupHash
	 */
	_flush(pGroupHash)
	{
		delete this._CoalesceTimers[pGroupHash];
		let tmpState = this.group(pGroupHash);
		let tmpCallbacks = this._PendingCallbacks[pGroupHash] || [];
		delete this._PendingCallbacks[pGroupHash];
		let tmpExtraSpecs = this._PendingSpecs[pGroupHash] || {};
		delete this._PendingSpecs[pGroupHash];

		// Supersede the flight in progress: abort it and carry its waiters over to this one.
		let tmpPrevious = this._InFlight[pGroupHash];
		if (tmpPrevious)
		{
			tmpCallbacks = tmpPrevious.Callbacks.concat(tmpCallbacks);
			tmpPrevious.Callbacks = [];
			if (tmpPrevious.Controller)
			{
				try
				{
					tmpPrevious.Controller.abort();
				}
				catch (pError)
				{
					// already settled
				}
			}
		}

		// M4: the freshness of this POST: an SSE refetch (or a change that arrived while the group was not on screen)
		// asks for MinSeq; a flush that supersedes such a flight keeps its MinSeq (the newer answer must be as fresh).
		let tmpPending = this._PendingFreshness[pGroupHash] || null;
		delete this._PendingFreshness[pGroupHash];
		let tmpChanged = tmpState.ChangedSince || null;
		tmpState.ChangedSince = null;
		this._clearStaleTimer(pGroupHash);
		let tmpMinSeq = libFacetChanges.laterSeq(tmpPending ? tmpPending.MinSeq : null, tmpChanged ? tmpChanged.Seq : null);
		tmpMinSeq = libFacetChanges.laterSeq(tmpPrevious ? tmpPrevious.MinSeq : null, tmpMinSeq);
		let tmpExact = !!((tmpPending && tmpPending.Exact) || (tmpChanged && tmpChanged.Exact) || (tmpPrevious && tmpPrevious.Exact));
		let tmpTrigger = (tmpPending && tmpPending.Trigger) || (tmpChanged && tmpChanged.Trigger) || (tmpPrevious && tmpPrevious.Trigger) || null;
		let tmpFreshness = null;
		if (this.options.Freshness || tmpMinSeq || tmpExact)
		{
			tmpFreshness = libFacetSelection.freshnessBody(this.options.Freshness || { Mode: 'Exact' }, tmpMinSeq, tmpExact);
		}

		tmpState.Seq = (tmpState.Seq || 0) + 1;
		let tmpPrincipal = this.principalKey();
		let tmpBody = libFacetSelection.buildQueryBody(tmpState, tmpFreshness ? { Freshness: tmpFreshness } : null);
		Object.keys(tmpExtraSpecs).forEach(
			(pKey) =>
			{
				let tmpIndex = tmpBody.Facets.findIndex((pSpec) => { return pSpec.Key === pKey; });
				if (tmpIndex >= 0)
				{
					tmpBody.Facets[tmpIndex] = tmpExtraSpecs[pKey];
				}
				else
				{
					tmpBody.Facets.push(tmpExtraSpecs[pKey]);
				}
			});
		let tmpController = (typeof(AbortController) === 'function') ? new AbortController() : null;
		let tmpFlight = { Seq: tmpState.Seq, Controller: tmpController, Callbacks: tmpCallbacks, MinSeq: tmpMinSeq, Exact: tmpExact, Trigger: tmpTrigger };
		this._InFlight[pGroupHash] = tmpFlight;
		// A newer Query also outdates any records page or count request of this group.
		this._RecordsSeq[pGroupHash] = (this._RecordsSeq[pGroupHash] || 0) + 1;
		this._CountSeq[pGroupHash] = (this._CountSeq[pGroupHash] || 0) + 1;

		tmpState.Status = 'Loading';
		tmpState.PendingPrincipalKey = tmpPrincipal;
		// The envelope on screen is about to be replaced: a count verdict about it no longer applies (a check the
		// user asked for while this Query was coming stays pending and runs against its answer).
		if (!this._VerifyAfter[pGroupHash])
		{
			tmpState.CountCheck = null;
		}
		// POSTs it took to reach the next applied answer: 1, or more when this flush superseded one in flight.
		tmpState.PostsSinceChange = tmpPrevious ? ((tmpState.PostsSinceChange || 1) + 1) : 1;
		this.notify(pGroupHash, 'Loading');

		this.request(tmpState.Domain, 'POST', libFacetSelection.routePath(tmpState, libFacetSelection.KIND_QUERY), tmpBody,
			{ GroupHash: pGroupHash, Kind: 'Query', Seq: tmpFlight.Seq, Signal: tmpController ? tmpController.signal : null, Principal: tmpPrincipal, Trigger: tmpTrigger },
			(pError, pResponse) =>
			{
				if (this._InFlight[pGroupHash] !== tmpFlight)
				{
					// Superseded: logged, never applied; the waiters already moved to the newer flight.
					this._patchExchange(pResponse ? pResponse.ExchangeID : null, { Superseded: true });
					return;
				}
				delete this._InFlight[pGroupHash];
				let tmpWaitingChecks = this._VerifyAfter[pGroupHash] || null;
				delete this._VerifyAfter[pGroupHash];
				this._applyQuery(tmpState, tmpBody, pResponse, tmpPrincipal, tmpFlight.Seq, tmpTrigger);
				if (tmpWaitingChecks && (tmpState.Status !== 'Ready'))
				{
					tmpState.CountCheck = null;
				}
				this.notify(pGroupHash, (tmpState.Status === 'Ready') ? 'Ready' : 'Error');
				let tmpCallbackError = (tmpState.Status === 'Ready') ? null : new Error(`${tmpState.Error ? tmpState.Error.Code : 'FACET_ERROR'}: ${tmpState.Error ? tmpState.Error.Message : ''}`);
				if (tmpWaitingChecks)
				{
					if (tmpState.Status === 'Ready')
					{
						this.verifyCount(pGroupHash, (pCountError, pCountState) => { tmpWaitingChecks.forEach((fWaiting) => { fWaiting(pCountError, pCountState); }); });
					}
					else
					{
						tmpWaitingChecks.forEach((fWaiting) => { fWaiting(tmpCallbackError, tmpState); });
					}
				}
				tmpFlight.Callbacks.forEach(
					(fCallback) =>
					{
						try
						{
							fCallback(tmpCallbackError, tmpState);
						}
						catch (pCallbackError)
						{
							this.log.error(`Pict-Provider-Facet: a [${pGroupHash}] query callback failed: ${pCallbackError.message}`);
						}
					});
			});
	}

	/**
	 * Apply a Query answer to the group state (DEMO-SPEC §4.3 Apply).
	 *
	 * @param {Record<string, any>} pState
	 * @param {Record<string, any>} pBody - the body that was sent
	 * @param {Record<string, any>} pResponse
	 * @param {string|null} pPrincipal - the principal the request was sent as
	 * @param {number} [pSeq] - the flight's Seq (becomes AnswerSeq: the identity of the answer on screen)
	 * @param {string|null} [pTrigger] - why this POST went out when it was not a user gesture (M4: "Live update: …")
	 */
	_applyQuery(pState, pBody, pResponse, pPrincipal, pSeq, pTrigger)
	{
		let tmpResponse = pResponse || {};
		let tmpHeaders = tmpResponse.Headers || {};
		let tmpEnvelopeBody = (tmpResponse.Body && (typeof(tmpResponse.Body) === 'object') && !Array.isArray(tmpResponse.Body)) ? tmpResponse.Body : {};
		pState.PendingPrincipalKey = null;
		pState.PrincipalKey = pPrincipal;
		pState.AnswerSeq = (typeof(pSeq) === 'number') ? pSeq : ((pState.AnswerSeq || 0) + 1);
		pState.LastExchangeID = (typeof(tmpResponse.ExchangeID) === 'number') ? tmpResponse.ExchangeID : null;
		pState.LastAnswer =
			{
				ExchangeID: pState.LastExchangeID,
				Status: tmpResponse.Status,
				NotModified: (tmpResponse.NotModified === true),
				ElapsedMS: tmpResponse.ElapsedMS,
				ETag: (tmpResponse.Headers && tmpResponse.Headers.ETag) ? tmpResponse.Headers.ETag : null,
				ServerTiming: (tmpResponse.Headers && tmpResponse.Headers['Server-Timing']) ? tmpResponse.Headers['Server-Timing'] : null,
				Posts: pState.PostsSinceChange || 1,
				// M4 (internal-contracts §44.7–§44.8): how the server answered, and why the client asked.
				CacheStatus: tmpHeaders['X-Retold-Facet-Cache'] || null,
				Seq: tmpHeaders['X-Retold-Facet-Seq'] || null,
				Freshness: tmpHeaders['X-Retold-Facet-Freshness'] || null,
				Cached: (tmpEnvelopeBody.Cached === true),
				Stale: (tmpEnvelopeBody.Stale === true) && !(tmpResponse.NotModified === true),
				LagMS: (typeof(tmpEnvelopeBody.LagMS) === 'number') ? tmpEnvelopeBody.LagMS : 0,
				AsOf: tmpEnvelopeBody.AsOf || null,
				Version: tmpEnvelopeBody.Version || null,
				Trigger: pTrigger || null
			};
		if (tmpResponse.Ok && tmpResponse.Body && (typeof(tmpResponse.Body) === 'object'))
		{
			pState.Envelope = tmpResponse.Body;
			pState.Status = 'Ready';
			pState.Error = null;
			// M4: the entities this answer depends on (a change event of one of them refetches the group).
			pState.DependsOn = Array.isArray(tmpResponse.Body.DependsOn) ? tmpResponse.Body.DependsOn.slice() : null;
			this._rememberLabels(pState, pPrincipal);
			this._scheduleStaleRefetch(pState);
			if (pBody.Records)
			{
				pState.RecordsPage =
					{
						// Page 1 travels inside the Query envelope (its Records block).
						Source: 'Query',
						Begin: pBody.Records.Begin || 0,
						Cap: pBody.Records.Cap || this.options.DefaultRecordsCap,
						Rows: Array.isArray(tmpResponse.Body.Records) ? tmpResponse.Body.Records : [],
						Status: 'Ready',
						Error: null,
						Dropped: (typeof(tmpResponse.Body.RecordsDropped) === 'number') ? tmpResponse.Body.RecordsDropped : null
					};
			}
			else
			{
				pState.RecordsPage = null;
			}
			return;
		}
		// A stale answer for another principal or filter must not stay on screen.
		pState.Envelope = null;
		pState.Status = 'Error';
		pState.Error = tmpResponse.Error || { Code: 'DEMO_NETWORK', Status: 0, Message: 'No answer.' };
		pState.RecordsPage = null;
		pState.CountCheck = null;
	}

	/**
	 * POST …/Records/:Begin/:Cap with the group's filter (pict-section-recordset FilterEndpointOverride shape).
	 *
	 * @param {string} pGroupHash
	 * @param {number} pBegin
	 * @param {(pError?: Error|null, pState?: Record<string, any>) => void} [fCallback]
	 */
	loadRecordsPage(pGroupHash, pBegin, fCallback)
	{
		let tmpState = this.group(pGroupHash);
		let fDone = (typeof(fCallback) === 'function') ? fCallback : () => {};
		if (!tmpState || !tmpState.Records)
		{
			return fDone(new Error(`Pict-Provider-Facet: group [${pGroupHash}] has no records.`));
		}
		let tmpCap = tmpState.Records.Cap || this.options.DefaultRecordsCap;
		let tmpBegin = Math.max(0, parseInt(pBegin, 10) || 0);
		// The paging cursor lives only in RecordsPage: the next Query (any refresh) asks for page 1 again.
		let tmpSeq = (this._RecordsSeq[pGroupHash] || 0) + 1;
		this._RecordsSeq[pGroupHash] = tmpSeq;
		tmpState.RecordsPage = Object.assign({ Rows: [] }, tmpState.RecordsPage || {}, { Source: 'Records', Begin: tmpBegin, Cap: tmpCap, Status: 'Loading', Error: null, Lookup: null });
		this.notify(pGroupHash, 'Records');
		this.request(tmpState.Domain, 'POST', libFacetSelection.routePath(tmpState, libFacetSelection.KIND_RECORDS, tmpBegin, tmpCap), libFacetSelection.buildRecordsBody(tmpState),
			{ GroupHash: pGroupHash, Kind: 'Records' },
			(pError, pResponse) =>
			{
				if (this._RecordsSeq[pGroupHash] !== tmpSeq)
				{
					this._patchExchange(pResponse ? pResponse.ExchangeID : null, { Superseded: true });
					return fDone(new Error('Superseded.'));
				}
				if (pResponse && pResponse.Ok)
				{
					let tmpDropped = pResponse.Headers ? pResponse.Headers['X-Retold-Facet-Records-Dropped'] : null;
					tmpState.RecordsPage = { Source: 'Records', Begin: tmpBegin, Cap: tmpCap, Rows: Array.isArray(pResponse.Body) ? pResponse.Body : [], Status: 'Ready', Error: null, Dropped: tmpDropped ? (parseInt(tmpDropped, 10) || 0) : null };
				}
				else
				{
					tmpState.RecordsPage = { Source: 'Records', Begin: tmpBegin, Cap: tmpCap, Rows: [], Status: 'Error', Error: (pResponse && pResponse.Error) ? pResponse.Error : { Code: 'DEMO_NETWORK', Status: 0, Message: 'No answer.' }, Dropped: null };
				}
				this.notify(pGroupHash, 'Records');
				return fDone((tmpState.RecordsPage.Status === 'Ready') ? null : new Error(tmpState.RecordsPage.Error.Code), tmpState);
			});
	}

	/**
	 * POST …/Records/Count with the group's filter and compare it with the envelope Total of the answer on
	 * screen: state.CountCheck = { Status, Count, Total, Agrees, Error, AnswerSeq }.  While a Query is coming
	 * (Loading, or a coalesced write not sent yet) the check waits for that answer and counts against IT, so
	 * the verdict never compares a new filter's count with an old Total.  Any later Query clears the verdict.
	 *
	 * @param {string} pGroupHash
	 * @param {(pError?: Error|null, pState?: Record<string, any>) => void} [fCallback]
	 */
	verifyCount(pGroupHash, fCallback)
	{
		let tmpState = this.group(pGroupHash);
		let fDone = (typeof(fCallback) === 'function') ? fCallback : () => {};
		if (!tmpState || !tmpState.Records)
		{
			return fDone(new Error(`Pict-Provider-Facet: group [${pGroupHash}] has no records.`));
		}
		if ((tmpState.Status === 'Loading') || this._CoalesceTimers[pGroupHash])
		{
			if (!this._VerifyAfter[pGroupHash])
			{
				this._VerifyAfter[pGroupHash] = [];
			}
			this._VerifyAfter[pGroupHash].push(fDone);
			tmpState.CountCheck = { Status: 'Loading', Waiting: true, Count: null, Total: null, Agrees: null, Error: null, AnswerSeq: null };
			this.notify(pGroupHash, 'Count');
			return;
		}
		if ((tmpState.Status !== 'Ready') || !tmpState.Envelope)
		{
			return fDone(new Error(`Pict-Provider-Facet: group [${pGroupHash}] has no answer to verify.`));
		}
		let tmpTotal = (typeof(tmpState.Envelope.Total) === 'number') ? tmpState.Envelope.Total : null;
		let tmpAnswerSeq = tmpState.AnswerSeq;
		let tmpSeq = (this._CountSeq[pGroupHash] || 0) + 1;
		this._CountSeq[pGroupHash] = tmpSeq;
		tmpState.CountCheck = { Status: 'Loading', Waiting: false, Count: null, Total: tmpTotal, Agrees: null, Error: null, AnswerSeq: tmpAnswerSeq, Seq: tmpSeq };
		this.notify(pGroupHash, 'Count');
		this.request(tmpState.Domain, 'POST', libFacetSelection.routePath(tmpState, libFacetSelection.KIND_COUNT), libFacetSelection.buildRecordsBody(tmpState),
			{ GroupHash: pGroupHash, Kind: 'Count' },
			(pError, pResponse) =>
			{
				if ((this._CountSeq[pGroupHash] !== tmpSeq) || (tmpState.AnswerSeq !== tmpAnswerSeq))
				{
					// A newer Query (or count) replaced the answer this count was about: drop it, and never leave a
					// "Counting…" behind.
					this._patchExchange(pResponse ? pResponse.ExchangeID : null, { Superseded: true });
					if (tmpState.CountCheck && (tmpState.CountCheck.Seq === tmpSeq))
					{
						tmpState.CountCheck = null;
						this.notify(pGroupHash, 'Count');
					}
					return fDone(new Error('Superseded.'));
				}
				if (pResponse && pResponse.Ok && pResponse.Body && (typeof(pResponse.Body.Count) === 'number'))
				{
					tmpState.CountCheck = { Status: 'Ready', Count: pResponse.Body.Count, Total: tmpTotal, Agrees: (pResponse.Body.Count === tmpTotal), Error: null, AnswerSeq: tmpAnswerSeq, Seq: tmpSeq };
				}
				else
				{
					tmpState.CountCheck = { Status: 'Error', Count: null, Total: tmpTotal, Agrees: null, Error: (pResponse && pResponse.Error) ? pResponse.Error : { Code: 'DEMO_NETWORK', Status: 0, Message: 'No answer.' }, AnswerSeq: tmpAnswerSeq, Seq: tmpSeq };
				}
				this.notify(pGroupHash, 'Count');
				return fDone((tmpState.CountCheck.Status === 'Ready') ? null : new Error(tmpState.CountCheck.Error.Code), tmpState);
			});
	}

	// ------------------------------------------------------------------ labels and lookups (display only)

	/**
	 * Remember every bucket label of an applied answer (per principal, group and facet), so a list cell or an
	 * active-filter chip can name a key even when the current answer no longer lists its bucket.
	 *
	 * @param {Record<string, any>} pState
	 * @param {string|null} pPrincipal
	 */
	_rememberLabels(pState, pPrincipal)
	{
		let tmpFacets = (pState.Envelope && pState.Envelope.Facets) ? pState.Envelope.Facets : {};
		Object.keys(tmpFacets).forEach(
			(pFacetKey) =>
			{
				let tmpBuckets = (tmpFacets[pFacetKey] && Array.isArray(tmpFacets[pFacetKey].Buckets)) ? tmpFacets[pFacetKey].Buckets : [];
				if (tmpBuckets.length < 1)
				{
					return;
				}
				let tmpMapKey = `${pPrincipal || ''}|${pState.Hash}|${pFacetKey}`;
				let tmpMap = this._Labels[tmpMapKey] || (this._Labels[tmpMapKey] = {});
				tmpBuckets.forEach(
					(pBucket) =>
					{
						if (!pBucket || (pBucket.Key === null) || (typeof(pBucket.Key) === 'undefined') || (typeof(pBucket.Key) === 'object'))
						{
							return;
						}
						tmpMap[String(pBucket.Key)] = { Key: pBucket.Key, Label: pBucket.Label, LabelResolved: (pBucket.LabelResolved !== false) };
					});
			});
	}

	/**
	 * The label this principal has seen for a facet key (any earlier answer), or null.
	 *
	 * @param {string} pGroupHash
	 * @param {string} pFacetKey
	 * @param {any} pKey
	 * @return {{ Key: any, Label: any, LabelResolved: boolean }|null}
	 */
	labelOf(pGroupHash, pFacetKey, pKey)
	{
		let tmpMap = this._Labels[`${this.principalKey() || ''}|${pGroupHash}|${pFacetKey}`];
		return (tmpMap && Object.prototype.hasOwnProperty.call(tmpMap, String(pKey))) ? tmpMap[String(pKey)] : null;
	}

	/**
	 * @param {string} pDomain
	 * @param {string} pEntity
	 * @param {string} pKeyField
	 * @param {string|null} [pPrincipal]
	 * @return {string}
	 */
	_lookupCacheKey(pDomain, pEntity, pKeyField, pPrincipal)
	{
		let tmpPrincipal = (typeof(pPrincipal) !== 'undefined') ? pPrincipal : this.principalKey();
		return `${pDomain}|${tmpPrincipal || ''}|${pEntity}|${pKeyField}`;
	}

	/**
	 * The cached related rows of one key for the current principal: an array ([] = none visible), or undefined
	 * when the key was never looked up.
	 *
	 * @param {string} pDomain
	 * @param {string} pEntity
	 * @param {string} pKeyField
	 * @param {any} pKey
	 * @return {Array<Record<string, any>>|undefined}
	 */
	lookupRows(pDomain, pEntity, pKeyField, pKey)
	{
		let tmpCache = this._LookupCache[this._lookupCacheKey(pDomain, pEntity, pKeyField)];
		return (tmpCache && Object.prototype.hasOwnProperty.call(tmpCache, String(pKey))) ? tmpCache[String(pKey)] : undefined;
	}

	/**
	 * Read the related rows of some keys (POST /1.0/Facet/<Entity>/Records/<Begin>/500 with a key-list clause,
	 * KEYS_PER_REQUEST keys per request, paged while pages come back full), cache them per principal (errors
	 * are never cached), and call back when every key has an entry.  Calls back synchronously when nothing is
	 * missing.  Exchanges are logged with Kind 'Lookup'.
	 *
	 * @param {string} pDomain
	 * @param {string} pEntity
	 * @param {string} pKeyField
	 * @param {Array<any>} pKeys
	 * @param {{ GroupHash?: string|null }} pOptions
	 * @param {(pError?: Error|null) => void} fCallback
	 */
	fetchLookup(pDomain, pEntity, pKeyField, pKeys, pOptions, fCallback)
	{
		let fDone = (typeof(fCallback) === 'function') ? fCallback : () => {};
		let tmpOptions = pOptions || {};
		let tmpPrincipal = this.principalKey();
		let tmpCacheKey = this._lookupCacheKey(pDomain, pEntity, pKeyField, tmpPrincipal);
		let tmpCache = this._LookupCache[tmpCacheKey] || (this._LookupCache[tmpCacheKey] = {});
		let tmpMissing = (Array.isArray(pKeys) ? pKeys : []).filter((pKey) => { return !Object.prototype.hasOwnProperty.call(tmpCache, String(pKey)); });
		if (tmpMissing.length < 1)
		{
			return fDone(null);
		}
		let tmpChunks = libFacetLookup.chunk(tmpMissing, libFacetLookup.KEYS_PER_REQUEST);
		let fChunk = (pIndex, pBegin, pRows) =>
		{
			if (pIndex >= tmpChunks.length)
			{
				return fDone(null);
			}
			let tmpPath = `/1.0/Facet/${encodeURIComponent(pEntity)}/Records/${pBegin}/${libFacetLookup.PAGE_SIZE}`;
			this.request(pDomain, 'POST', tmpPath, libFacetLookup.requestBody(pKeyField, tmpChunks[pIndex]),
				{ GroupHash: tmpOptions.GroupHash || null, Kind: 'Lookup', Principal: tmpPrincipal },
				(pError, pResponse) =>
				{
					if (!pResponse || !pResponse.Ok || !Array.isArray(pResponse.Body))
					{
						let tmpError = (pResponse && pResponse.Error) ? pResponse.Error : { Code: 'DEMO_NETWORK', Message: 'No answer.' };
						return fDone(new Error(`${tmpError.Code}: ${tmpError.Message}`));
					}
					let tmpRows = pRows.concat(pResponse.Body);
					if ((pResponse.Body.length >= libFacetLookup.PAGE_SIZE) && ((pBegin + libFacetLookup.PAGE_SIZE) <= 10000))
					{
						return fChunk(pIndex, pBegin + libFacetLookup.PAGE_SIZE, tmpRows);
					}
					Object.assign(tmpCache, libFacetLookup.indexRows(tmpRows, pKeyField, tmpChunks[pIndex]));
					return fChunk(pIndex + 1, 0, []);
				});
		};
		return fChunk(0, 0, []);
	}

	/**
	 * Resolve every Lookup column (Facet-Lookup.chains) for some list rows: level by level (a chain's next step
	 * needs the previous step's rows), one request family per (Entity, KeyField) per level.  Calls back
	 * synchronously when everything is cached.
	 *
	 * @param {string} pGroupHash
	 * @param {Array<Record<string, any>>} pRows
	 * @param {Array<Record<string, any>>} pColumns
	 * @param {(pError?: Error|null) => void} fCallback
	 */
	lookupForRows(pGroupHash, pRows, pColumns, fCallback)
	{
		let fDone = (typeof(fCallback) === 'function') ? fCallback : () => {};
		let tmpState = this.group(pGroupHash);
		if (!tmpState)
		{
			return fDone(new Error(`Pict-Provider-Facet: unknown group [${pGroupHash}].`));
		}
		let tmpDomain = tmpState.Domain;
		let tmpChains = libFacetLookup.chains(pColumns);
		let tmpChainKeys = tmpChains.map((pChain) => { return libFacetLookup.keysOf(pRows, pChain[0].From); });
		let tmpFirstError = null;
		let fLevel = (pLevel) =>
		{
			let tmpRequests = {};
			tmpChains.forEach(
				(pChain, pChainIndex) =>
				{
					let tmpStep = pChain[pLevel];
					if (!tmpStep)
					{
						return;
					}
					if (pLevel > 0)
					{
						// The previous step's rows give this step's keys.
						let tmpPrevious = pChain[pLevel - 1];
						let tmpRelated = [];
						tmpChainKeys[pChainIndex].forEach(
							(pKey) =>
							{
								tmpRelated = tmpRelated.concat(this.lookupRows(tmpDomain, tmpPrevious.Entity, libFacetLookup.keyFieldOf(tmpPrevious), pKey) || []);
							});
						tmpChainKeys[pChainIndex] = libFacetLookup.keysOf(tmpRelated, tmpPrevious.Show);
					}
					let tmpRequestKey = `${tmpStep.Entity}|${libFacetLookup.keyFieldOf(tmpStep)}`;
					if (!tmpRequests[tmpRequestKey])
					{
						tmpRequests[tmpRequestKey] = { Entity: tmpStep.Entity, KeyField: libFacetLookup.keyFieldOf(tmpStep), Keys: [] };
					}
					tmpChainKeys[pChainIndex].forEach(
						(pKey) =>
						{
							if (tmpRequests[tmpRequestKey].Keys.indexOf(pKey) < 0)
							{
								tmpRequests[tmpRequestKey].Keys.push(pKey);
							}
						});
				});
			let tmpRequestKeys = Object.keys(tmpRequests);
			if (tmpRequestKeys.length < 1)
			{
				return fDone(tmpFirstError);
			}
			let tmpPending = tmpRequestKeys.length;
			tmpRequestKeys.forEach(
				(pRequestKey) =>
				{
					let tmpRequest = tmpRequests[pRequestKey];
					this.fetchLookup(tmpDomain, tmpRequest.Entity, tmpRequest.KeyField, tmpRequest.Keys, { GroupHash: pGroupHash },
						(pError) =>
						{
							if (pError && !tmpFirstError)
							{
								tmpFirstError = pError;
							}
							tmpPending--;
							if (tmpPending === 0)
							{
								return fLevel(pLevel + 1);
							}
						});
				});
		};
		return fLevel(0);
	}

	/**
	 * Every list row of a group under its current filter (POST …/Records/<Begin>/500 until a page comes back
	 * short; at most MaxRecordsOffset).  Logged with Kind 'Lookup'.
	 *
	 * @param {string} pGroupHash
	 * @param {(pError?: Error|null, pRows?: Array<Record<string, any>>) => void} fCallback
	 */
	fetchAllRecords(pGroupHash, fCallback)
	{
		let fDone = (typeof(fCallback) === 'function') ? fCallback : () => {};
		let tmpState = this.group(pGroupHash);
		if (!tmpState || !tmpState.Records)
		{
			return fDone(new Error(`Pict-Provider-Facet: group [${pGroupHash}] has no records.`));
		}
		let tmpBody = libFacetSelection.buildRecordsBody(tmpState);
		let fPage = (pBegin, pRows) =>
		{
			this.request(tmpState.Domain, 'POST', libFacetSelection.routePath(tmpState, libFacetSelection.KIND_RECORDS, pBegin, libFacetLookup.PAGE_SIZE), tmpBody,
				{ GroupHash: pGroupHash, Kind: 'Lookup' },
				(pError, pResponse) =>
				{
					if (!pResponse || !pResponse.Ok || !Array.isArray(pResponse.Body))
					{
						let tmpError = (pResponse && pResponse.Error) ? pResponse.Error : { Code: 'DEMO_NETWORK', Message: 'No answer.' };
						return fDone(new Error(`${tmpError.Code}: ${tmpError.Message}`));
					}
					let tmpRows = pRows.concat(pResponse.Body);
					if ((pResponse.Body.length >= libFacetLookup.PAGE_SIZE) && ((pBegin + libFacetLookup.PAGE_SIZE) <= 10000))
					{
						return fPage(pBegin + libFacetLookup.PAGE_SIZE, tmpRows);
					}
					return fDone(null, tmpRows);
				});
		};
		return fPage(0, []);
	}

	/**
	 * GET <prefix>/1.0/Facet/Describe once per (Domain, PrincipalKey); concurrent callers share the fetch.
	 * Result at AppData.FacetCapabilities[pDomain] (replaced when the principal changes).  A failure clears the
	 * domain's capabilities and is reported at AppData.Facet.DescribeErrors[pDomain]; it is never cached.
	 *
	 * @param {string} pDomain
	 * @param {(pError?: Error|null, pDescribe?: Record<string, any>) => void} [fCallback]
	 */
	describe(pDomain, fCallback)
	{
		let fDone = (typeof(fCallback) === 'function') ? fCallback : () => {};
		let tmpPrincipal = this.principalKey();
		let tmpCapabilities = this.pict.AppData.FacetCapabilities;
		if ((this._DescribedFor[pDomain] === tmpPrincipal) && tmpCapabilities[pDomain])
		{
			return fDone(null, tmpCapabilities[pDomain]);
		}
		let tmpKey = `${pDomain}|${tmpPrincipal || ''}`;
		if (this._DescribeInFlight[tmpKey])
		{
			this._DescribeInFlight[tmpKey].push(fDone);
			return;
		}
		this._DescribeInFlight[tmpKey] = [ fDone ];
		this.request(pDomain, 'GET', '/1.0/Facet/Describe', null, { GroupHash: null, Kind: 'Describe', Principal: tmpPrincipal },
			(pError, pResponse) =>
			{
				let tmpWaiters = this._DescribeInFlight[tmpKey] || [];
				delete this._DescribeInFlight[tmpKey];
				if (this.principalKey() !== tmpPrincipal)
				{
					// The principal changed while this was in flight: a Describe for the new one is the caller's job.
					tmpWaiters.forEach((fWaiter) => { fWaiter(new Error('Superseded: the principal changed.')); });
					return;
				}
				if (pResponse && pResponse.Ok)
				{
					tmpCapabilities[pDomain] = pResponse.Body;
					this._DescribedFor[pDomain] = tmpPrincipal;
					delete this.pict.AppData.Facet.DescribeErrors[pDomain];
					tmpWaiters.forEach((fWaiter) => { fWaiter(null, pResponse.Body); });
					return;
				}
				tmpCapabilities[pDomain] = null;
				delete this._DescribedFor[pDomain];
				let tmpError = (pResponse && pResponse.Error) ? pResponse.Error : { Code: 'DEMO_NETWORK', Status: 0, Message: 'No answer.' };
				this.pict.AppData.Facet.DescribeErrors[pDomain] = tmpError;
				tmpWaiters.forEach((fWaiter) => { fWaiter(new Error(`${tmpError.Code}: ${tmpError.Message}`)); });
			});
	}

	/**
	 * The Describe entry of an entity for the current principal, or null.
	 *
	 * @param {string} pDomain
	 * @param {string} pEntity
	 * @return {Record<string, any>|null}
	 */
	entityCapabilities(pDomain, pEntity)
	{
		let tmpDescribe = this.pict.AppData.FacetCapabilities[pDomain];
		if (!tmpDescribe || (this._DescribedFor[pDomain] !== this.principalKey()) || !tmpDescribe.Entities)
		{
			return null;
		}
		return tmpDescribe.Entities[pEntity] || null;
	}

	/**
	 * @param {string} pDomain
	 * @return {Record<string, any>|null} the last Describe failure for the domain
	 */
	describeError(pDomain)
	{
		return this.pict.AppData.Facet.DescribeErrors[pDomain] || null;
	}

	/**
	 * Transport: fetch + Version cache + exchange log (DEMO-SPEC §4.3).
	 *
	 * fCallback(pError, pResponse) where pResponse is always present:
	 *   { Ok, Status, Headers, Body, NotModified, ElapsedMS, ExchangeID, Error }
	 * Ok is true for a 200, and for a 304 served from the Version cache.
	 *
	 * @param {string} pDomain
	 * @param {string} pMethod - 'GET' | 'POST'
	 * @param {string} pPath - upstream path, '/1.0/Facet/…'
	 * @param {any} pBody - object (POST) or null
	 * @param {{ GroupHash?: string|null, Kind?: string, Seq?: number, Signal?: any, Principal?: string|null, NoCache?: boolean, Trigger?: string|null }} pOptions
	 *        NoCache (writes): no If-None-Match, nothing stored or dropped, and any 2xx is Ok; Trigger is logged
	 * @param {(pError?: Error|null, pResponse?: Record<string, any>) => void} fCallback
	 */
	request(pDomain, pMethod, pPath, pBody, pOptions, fCallback)
	{
		let tmpOptions = pOptions || {};
		let fDone = (typeof(fCallback) === 'function') ? fCallback : () => {};
		let tmpPrincipal = (typeof(tmpOptions.Principal) !== 'undefined') ? tmpOptions.Principal : this.principalKey();
		let tmpMethod = String(pMethod || 'GET').toUpperCase();
		let tmpHasBody = (tmpMethod !== 'GET') && (typeof(pBody) !== 'undefined') && (pBody !== null);
		let tmpURL = `${this._EndpointPrefix(pDomain)}${pPath}`;

		let tmpHeaders = { 'Accept': 'application/json' };
		if (tmpHasBody)
		{
			tmpHeaders['Content-Type'] = 'application/json';
		}
		Object.assign(tmpHeaders, this._RequestHeaders() || {});
		let tmpNoCache = (tmpOptions.NoCache === true);
		let tmpCacheKey = tmpNoCache ? null : libFacetSelection.requestKey(pDomain, tmpPrincipal, tmpMethod, pPath, tmpHasBody ? pBody : null);
		let tmpCached = tmpNoCache ? null : this._Cache.get(tmpCacheKey);
		if (tmpCached && tmpCached.ETag)
		{
			tmpHeaders['If-None-Match'] = tmpCached.ETag;
		}

		let tmpFacetState = this.pict.AppData.Facet;
		tmpFacetState.LogSeq = (tmpFacetState.LogSeq || 0) + 1;
		let tmpExchange =
			{
				ID: tmpFacetState.LogSeq,
				At: new Date().toISOString(),
				GroupHash: tmpOptions.GroupHash || null,
				Kind: tmpOptions.Kind || 'Query',
				Domain: pDomain,
				Method: tmpMethod,
				URL: tmpURL,
				UpstreamPath: pPath,
				RequestHeaders: Object.assign({}, tmpHeaders),
				Body: tmpHasBody ? pBody : null,
				Pending: true,
				Status: null,
				NotModified: false,
				Superseded: false,
				Aborted: false,
				ElapsedMS: null,
				ResponseHeaders: {},
				Response: null,
				Summary: null,
				Error: null,
				Trigger: tmpOptions.Trigger || null
			};
		tmpFacetState.Log.unshift(tmpExchange);
		while (tmpFacetState.Log.length > this.options.MaxLog)
		{
			tmpFacetState.Log.pop();
		}
		this._notifyLog();

		let tmpStarted = now();
		let fFinish = (pResponse) =>
		{
			tmpExchange.Pending = false;
			tmpExchange.Status = pResponse.Status;
			tmpExchange.NotModified = pResponse.NotModified;
			tmpExchange.ElapsedMS = pResponse.ElapsedMS;
			tmpExchange.ResponseHeaders = pResponse.Headers;
			tmpExchange.Response = pResponse.Body;
			tmpExchange.Error = pResponse.Error;
			tmpExchange.Summary = this.summarize(pResponse.Body, tmpExchange.Kind);
			pResponse.ExchangeID = tmpExchange.ID;
			this._notifyLog();
			return fDone(pResponse.Ok ? null : new Error(pResponse.Error ? pResponse.Error.Code : 'FACET_ERROR'), pResponse);
		};

		if (typeof(fetch) !== 'function')
		{
			return fFinish({ Ok: false, Status: 0, Headers: {}, Body: null, NotModified: false, ElapsedMS: 0, Error: { Code: 'DEMO_NETWORK', Status: 0, Message: 'fetch is not available in this environment.' } });
		}

		let tmpFetchOptions = { method: tmpMethod, headers: tmpHeaders, cache: 'no-store', credentials: 'same-origin' };
		if (tmpHasBody)
		{
			tmpFetchOptions.body = JSON.stringify(pBody);
		}
		if (tmpOptions.Signal)
		{
			tmpFetchOptions.signal = tmpOptions.Signal;
		}

		fetch(tmpURL, tmpFetchOptions)
			.then(
				(pFetchResponse) =>
				{
					return pFetchResponse.text().then((pText) => { return { Response: pFetchResponse, Text: pText }; });
				})
			.then(
				(pResult) =>
				{
					let tmpElapsed = Math.round((now() - tmpStarted) * 10) / 10;
					let tmpStatus = pResult.Response.status;
					let tmpResponseHeaders = {};
					pResult.Response.headers.forEach(
						(pValue, pName) =>
						{
							let tmpName = String(pName).toLowerCase();
							if (KEPT_HEADERS[tmpName] || (tmpName.indexOf('x-retold-facet-') === 0))
							{
								tmpResponseHeaders[canonicalHeaderName(tmpName)] = pValue;
							}
						});
					let tmpParsed = null;
					let tmpParseFailed = false;
					if (pResult.Text && (pResult.Text.length > 0))
					{
						try
						{
							tmpParsed = JSON.parse(pResult.Text);
						}
						catch (pParseError)
						{
							tmpParseFailed = true;
						}
					}
					let tmpAnswer = { Ok: false, Status: tmpStatus, Headers: tmpResponseHeaders, Body: tmpParsed, NotModified: false, ElapsedMS: tmpElapsed, Error: null };
					if (tmpNoCache)
					{
						// A write: any 2xx is the answer; nothing goes into (or comes out of) the Version cache.
						tmpAnswer.Ok = (tmpStatus >= 200) && (tmpStatus < 300) && !tmpParseFailed;
						if (!tmpAnswer.Ok)
						{
							tmpAnswer.Error = (tmpParsed && tmpParsed.Error && (typeof(tmpParsed.Error) === 'object')) ? tmpParsed.Error : { Code: tmpParseFailed ? 'DEMO_BAD_RESPONSE' : `DEMO_HTTP_${tmpStatus}`, Status: tmpStatus, Message: (tmpParsed && (typeof(tmpParsed.Error) === 'string')) ? tmpParsed.Error : (pResult.Response.statusText || `HTTP ${tmpStatus}`) };
						}
					}
					else if (tmpStatus === 304)
					{
						tmpAnswer.NotModified = true;
						if (tmpCached)
						{
							// LRU touch, then serve the cached body.
							this._Cache.delete(tmpCacheKey);
							this._Cache.set(tmpCacheKey, tmpCached);
							tmpAnswer.Ok = true;
							tmpAnswer.Body = tmpCached.Body;
						}
						else
						{
							tmpAnswer.Error = { Code: 'DEMO_CACHE_MISS', Status: 304, Message: 'A 304 arrived for a request this client has no cached answer for.' };
						}
					}
					else if ((tmpStatus === 200) && !tmpParseFailed)
					{
						tmpAnswer.Ok = true;
						if (tmpResponseHeaders.ETag)
						{
							this._cacheSet(tmpCacheKey, { ETag: tmpResponseHeaders.ETag, Body: tmpParsed });
						}
						else
						{
							this._Cache.delete(tmpCacheKey);
						}
					}
					else
					{
						// Errors are never cached.
						this._Cache.delete(tmpCacheKey);
						if (tmpParsed && tmpParsed.Error && (typeof(tmpParsed.Error) === 'object'))
						{
							tmpAnswer.Error = tmpParsed.Error;
						}
						else
						{
							tmpAnswer.Error = { Code: tmpParseFailed ? 'DEMO_BAD_RESPONSE' : `DEMO_HTTP_${tmpStatus}`, Status: tmpStatus, Message: tmpParseFailed ? 'The answer was not JSON.' : (pResult.Response.statusText || `HTTP ${tmpStatus}`) };
						}
					}
					return fFinish(tmpAnswer);
				})
			.catch(
				(pError) =>
				{
					let tmpAborted = !!pError && (pError.name === 'AbortError');
					tmpExchange.Aborted = tmpAborted;
					tmpExchange.Superseded = tmpAborted;
					return fFinish(
						{
							Ok: false,
							Status: 0,
							Headers: {},
							Body: null,
							NotModified: false,
							ElapsedMS: Math.round((now() - tmpStarted) * 10) / 10,
							Error: tmpAborted ? { Code: 'DEMO_ABORTED', Status: 0, Message: 'Superseded by a newer request for the same group.' } : { Code: 'DEMO_NETWORK', Status: 0, Message: (pError && pError.message) ? pError.message : 'The request failed.' }
						});
				});
	}

	/**
	 * @param {string} pKey
	 * @param {{ ETag: string, Body: any }} pEntry
	 */
	_cacheSet(pKey, pEntry)
	{
		this._Cache.delete(pKey);
		this._Cache.set(pKey, pEntry);
		while (this._Cache.size > this.options.MaxCache)
		{
			this._Cache.delete(this._Cache.keys().next().value);
		}
	}

	/**
	 * @param {number|null} pExchangeID
	 * @param {Record<string, any>} pPatch
	 */
	_patchExchange(pExchangeID, pPatch)
	{
		if (typeof(pExchangeID) !== 'number')
		{
			return;
		}
		let tmpExchange = this.exchange(pExchangeID);
		if (tmpExchange)
		{
			Object.assign(tmpExchange, pPatch);
			this._notifyLog();
		}
	}

	/**
	 * The inspector summary of an answer: envelope facts + one row per facet (DEMO-SPEC §4.2 Exchange.Summary).
	 *
	 * @param {any} pBody
	 * @param {string} pKind
	 * @return {Record<string, any>|null}
	 */
	summarize(pBody, pKind)
	{
		if (!pBody || (typeof(pBody) !== 'object'))
		{
			return null;
		}
		if (Array.isArray(pBody))
		{
			return { Records: pBody.length };
		}
		if (pKind === 'Write')
		{
			let tmpIDField = Object.keys(pBody).find((pKey) => { return /^ID[A-Z]/.test(pKey) && (typeof(pBody[pKey]) === 'number'); }) || null;
			return { Written: true, IDField: tmpIDField, ID: tmpIDField ? pBody[tmpIDField] : null, Count: (typeof(pBody.Count) === 'number') ? pBody.Count : null };
		}
		if ((pKind === 'Count') || ((typeof(pBody.Count) === 'number') && !pBody.Facets))
		{
			return { Count: pBody.Count };
		}
		if (pKind === 'Describe')
		{
			return { Entities: pBody.Entities ? Object.keys(pBody.Entities).length : 0, ModelVersion: pBody.ModelVersion || null };
		}
		if (!pBody.Facets || (typeof(pBody.Facets) !== 'object'))
		{
			return null;
		}
		let tmpErrors = (pBody.Errors && (typeof(pBody.Errors) === 'object')) ? pBody.Errors : {};
		let tmpFacets = Object.keys(pBody.Facets).map(
			(pKey) =>
			{
				let tmpFacet = pBody.Facets[pKey] || {};
				return (
					{
						Key: pKey,
						Fold: tmpFacet.Fold || null,
						Disjunctive: tmpFacet.Disjunctive || null,
						Excluded: Array.isArray(tmpFacet.Excluded) ? tmpFacet.Excluded : [],
						KeptMixed: Array.isArray(tmpFacet.KeptMixed) ? tmpFacet.KeptMixed : [],
						CountMode: tmpFacet.CountMode || null,
						Total: tmpFacet.Total,
						SumOfCounts: tmpFacet.SumOfCounts,
						MissingCount: tmpFacet.MissingCount,
						OtherCount: tmpFacet.OtherCount,
						Truncated: tmpFacet.Truncated === true,
						MultiValued: tmpFacet.MultiValued === true,
						Relaxed: tmpFacet.Relaxed === true,
						Semantics: tmpFacet.Semantics || null,
						Error: null
					});
			});
		Object.keys(tmpErrors).forEach(
			(pKey) =>
			{
				if (!pBody.Facets[pKey])
				{
					tmpFacets.push({ Key: pKey, Fold: null, Disjunctive: null, Excluded: [], KeptMixed: [], CountMode: null, Total: null, SumOfCounts: null, MissingCount: null, OtherCount: null, Truncated: false, MultiValued: false, Relaxed: false, Semantics: null, Error: tmpErrors[pKey] });
				}
			});
		let tmpWarnings = [];
		if (pBody.Filter && Array.isArray(pBody.Filter.Warnings))
		{
			tmpWarnings = tmpWarnings.concat(pBody.Filter.Warnings);
		}
		if (Array.isArray(pBody.Warnings))
		{
			tmpWarnings = tmpWarnings.concat(pBody.Warnings);
		}
		return (
			{
				Engine: pBody.Engine || null,
				Exact: pBody.Exact,
				Version: pBody.Version || null,
				// M4 (internal-contracts §44.7)
				Cached: (typeof(pBody.Cached) === 'boolean') ? pBody.Cached : null,
				Stale: (typeof(pBody.Stale) === 'boolean') ? pBody.Stale : null,
				LagMS: (typeof(pBody.LagMS) === 'number') ? pBody.LagMS : null,
				AsOf: pBody.AsOf || null,
				DependsOn: Array.isArray(pBody.DependsOn) ? pBody.DependsOn.slice() : null,
				ModelVersion: pBody.ModelVersion || null,
				ServerElapsedMS: pBody.ElapsedMS,
				Total: pBody.Total,
				Records: Array.isArray(pBody.Records) ? pBody.Records.length : null,
				Facets: tmpFacets,
				FilterApplied: (pBody.Filter && Array.isArray(pBody.Filter.Applied)) ? pBody.Filter.Applied : [],
				Warnings: tmpWarnings,
				Errors: tmpErrors
			});
	}

	/**
	 * @param {number} pExchangeID
	 * @return {Record<string, any>|null}
	 */
	exchange(pExchangeID)
	{
		return this.pict.AppData.Facet.Log.find((pExchange) => { return pExchange.ID === pExchangeID; }) || null;
	}

	/**
	 * @return {Array<Record<string, any>>} AppData.Facet.Log (newest first)
	 */
	exchanges()
	{
		return this.pict.AppData.Facet.Log;
	}

	clearLog()
	{
		this.pict.AppData.Facet.Log = [];
		this._notifyLog();
	}
}

module.exports = PictProviderFacet;
module.exports.default_configuration = _DEFAULT_CONFIGURATION;
module.exports.Selection = libFacetSelection;
module.exports.Display = libFacetDisplay;
module.exports.Lookup = libFacetLookup;
