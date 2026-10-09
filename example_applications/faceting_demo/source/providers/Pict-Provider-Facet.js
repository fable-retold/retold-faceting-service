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
 *   subscribe(pGroupHash, fListener)             views re-render on state transitions
 *   subscribeLog(fListener)                      the inspector re-renders on every exchange
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
 * Cache: Version-keyed.  Key = Facet-Selection.requestKey(Domain, PrincipalKey, Method, Path, Body); value =
 * { ETag, Body }.  A repeat request sends If-None-Match: <ETag>; a 304 serves the cached body (the exchange is
 * logged NotModified).  Only 200 answers are stored; any other status deletes the entry (errors are never cached).
 * The server's Version hashes the computed answer, the principal's scope values and the BindHash, so a 304
 * is never stale and never crosses principals.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libPictProvider = require('pict-provider');

const libFacetSelection = require('./Facet-Selection.js');
const libFacetDisplay = require('./Facet-Display.js');
const libFacetLookup = require('./Facet-Lookup.js');

const _DEFAULT_CONFIGURATION =
	{
		ProviderIdentifier: 'Facet',
		AutoInitialize: true,
		AutoInitializeOrdinal: 0,
		// Facet requests issued within this window for one group merge into one POST (design 02 §13: 10 ms).
		CoalesceMS: 10,
		// Exchanges kept for the inspector (newest first).
		MaxLog: 30,
		// Version-cache entries kept (LRU).
		MaxCache: 60,
		// Records page size when a group does not say.
		DefaultRecordsCap: 25
	};

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
	 * for another principal, or ended in an error -- and nothing for the current principal is in flight.
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
		return (tmpState.Status === 'Idle') || (tmpState.Status === 'Error') || (tmpState.PrincipalKey !== tmpPrincipal);
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
	 * @param {string} pReason - 'Loading' | 'Ready' | 'Error' | 'Records' | 'Count' | 'State'
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

		tmpState.Seq = (tmpState.Seq || 0) + 1;
		let tmpPrincipal = this.principalKey();
		let tmpBody = libFacetSelection.buildQueryBody(tmpState);
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
		let tmpFlight = { Seq: tmpState.Seq, Controller: tmpController, Callbacks: tmpCallbacks };
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
			{ GroupHash: pGroupHash, Kind: 'Query', Seq: tmpFlight.Seq, Signal: tmpController ? tmpController.signal : null, Principal: tmpPrincipal },
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
				this._applyQuery(tmpState, tmpBody, pResponse, tmpPrincipal, tmpFlight.Seq);
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
	 */
	_applyQuery(pState, pBody, pResponse, pPrincipal, pSeq)
	{
		let tmpResponse = pResponse || {};
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
				Posts: pState.PostsSinceChange || 1
			};
		if (tmpResponse.Ok && tmpResponse.Body && (typeof(tmpResponse.Body) === 'object'))
		{
			pState.Envelope = tmpResponse.Body;
			pState.Status = 'Ready';
			pState.Error = null;
			this._rememberLabels(pState, pPrincipal);
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
	 * @param {{ GroupHash?: string|null, Kind?: string, Seq?: number, Signal?: any, Principal?: string|null }} pOptions
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
		let tmpCacheKey = libFacetSelection.requestKey(pDomain, tmpPrincipal, tmpMethod, pPath, tmpHasBody ? pBody : null);
		let tmpCached = this._Cache.get(tmpCacheKey);
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
				Error: null
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
					if (tmpStatus === 304)
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
