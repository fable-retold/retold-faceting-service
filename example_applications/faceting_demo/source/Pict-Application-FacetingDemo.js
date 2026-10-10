/**
 * Faceting Demo -- application bootstrap (DEMO-SPEC §4).
 *
 *   providers  Facet (Pict-Provider-Facet: describe / query / records / count, per-group coalescing,
 *              Version cache), PictRouter (hash routes from FacetDemo-Pages)
 *   views      FacetDemo-Layout (header: nav, DEMO principal switcher, theme toggle; page + inspector slots)
 *              FacetDemo-Page (renders the active page's panels and asks each widget to render its panel)
 *              FacetDemo-Compare (E3 variant A vs B), FacetDemo-Change (M4: the "Make a change" panel)
 *              Facet-Scope, Facet-Terms, Facet-Histogram, Facet-Pivot, Facet-Records, Facet-Inspector (liftable)
 *
 * Boot: GET /api/Demo/Principals + /api/Demo/Status -> AppData.FacetDemo.Personas / .Status, pick the saved
 * persona (localStorage 'retold-faceting-demo-principal') or the server's Default, then render the layout
 * (which resolves the router: empty hash -> #/Projects).  A failed boot fetch renders a full-page error card.
 *
 * A page load (loadPage) describes the page's domains and refreshes EVERY group of the page that is stale (the
 * LabForms page loads variant B with A, so its tab count and the Compare cross-check need no extra gesture).  A
 * Describe-driven group (FacetsFrom: 'Describe', the Bookstore) waits for its Describe: the facet list and the
 * cards come from FacetDemo-Pages.describedFacets, then the group is queried.  The inspector follows the page
 * (setContext on every route change).
 *
 * M4 (DEMO-SPEC §12): loadPage also opens the change stream of every domain of the page (provider.subscribeChanges:
 * GET /api/<Domain>/1.0/Facet/Changes, read with fetch() because the persona travels in a header EventSource cannot
 * send); a principal switch closes every stream first (closeChanges), and the page's groups are the "visible" ones
 * (setGroupVisibility): a change event refetches them at once and marks the groups of other pages.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libPictApplication = require('pict-application');
const libPictRouter = require('pict-router');

const libFacetDemoPages = require('./pages/FacetDemo-Pages.js');

const libPictProviderFacet = require('./providers/Pict-Provider-Facet.js');

const libViewLayout = require('./views/PictView-FacetDemo-Layout.js');
const libViewPage = require('./views/PictView-FacetDemo-Page.js');
const libViewCompare = require('./views/PictView-FacetDemo-Compare.js');
const libViewChange = require('./views/PictView-FacetDemo-Change.js');
const libViewFacetScope = require('./views/PictView-Facet-Scope.js');
const libViewFacetTerms = require('./views/PictView-Facet-Terms.js');
const libViewFacetHistogram = require('./views/PictView-Facet-Histogram.js');
const libViewFacetPivot = require('./views/PictView-Facet-Pivot.js');
const libViewFacetRecords = require('./views/PictView-Facet-Records.js');
const libViewFacetInspector = require('./views/PictView-Facet-Inspector.js');

// Browser-facing API prefix of a domain (the demo host proxies /api/<Domain>/1.0/Facet/* upstream).
const API_PREFIX = '/api';

const STORAGE_PRINCIPAL = 'retold-faceting-demo-principal';
const STORAGE_THEME = 'retold-faceting-demo-theme';
const STORAGE_INTERNALS = 'retold-faceting-demo-internals';

/**
 * localStorage read that never throws (private windows, blocked storage).
 *
 * @param {string} pKey
 * @return {string|null}
 */
const storageGet = (pKey) =>
{
	try
	{
		return (typeof(window) !== 'undefined' && window.localStorage) ? window.localStorage.getItem(pKey) : null;
	}
	catch (pError)
	{
		return null;
	}
};

/**
 * @param {string} pKey
 * @param {string} pValue
 */
const storageSet = (pKey, pValue) =>
{
	try
	{
		if (typeof(window) !== 'undefined' && window.localStorage)
		{
			window.localStorage.setItem(pKey, pValue);
		}
	}
	catch (pError)
	{
		// storage blocked: the choice simply does not persist
	}
};

/**
 * GET a demo-host JSON document.
 *
 * @param {string} pURL
 * @param {(pError: Error|null, pBody?: any) => void} fCallback
 */
const getJSON = (pURL, fCallback) =>
{
	if (typeof(fetch) !== 'function')
	{
		return fCallback(new Error('fetch is not available.'));
	}
	fetch(pURL, { headers: { 'Accept': 'application/json' }, cache: 'no-store' })
		.then(
			(pResponse) =>
			{
				return pResponse.json().then(
					(pBody) =>
					{
						if (!pResponse.ok)
						{
							let tmpError = new Error((pBody && pBody.Error && pBody.Error.Message) ? pBody.Error.Message : `HTTP ${pResponse.status}`);
							tmpError.Code = (pBody && pBody.Error && pBody.Error.Code) ? pBody.Error.Code : `DEMO_HTTP_${pResponse.status}`;
							throw tmpError;
						}
						return pBody;
					});
			})
		.then((pBody) => { fCallback(null, pBody); })
		.catch((pError) => { fCallback(pError); });
};

class PictApplicationFacetingDemo extends libPictApplication
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		// The layout resolves the router itself once its DOM exists.
		this.pict.settings.RouterSkipRouteResolveOnAdd = true;

		this.pict.addProvider('PictRouter',
			{
				ProviderIdentifier: 'Pict-Router',
				AutoInitialize: true,
				AutoInitializeOrdinal: 0,
				Routes: libFacetDemoPages.Pages.map(
					(pPage) =>
					{
						return { path: pPage.Route, template: `{~LV:Pict.PictApplication.showPage(\`${pPage.Hash}\`)~}` };
					})
			}, libPictRouter);

		// The persona travels in a request header, which EventSource cannot send: read the change stream with fetch().
		this.pict.addProvider('Facet', Object.assign({}, libPictProviderFacet.default_configuration, { ChangesTransport: 'Fetch' }), libPictProviderFacet);

		this.pict.addView('FacetDemo-Layout', libViewLayout.default_configuration, libViewLayout);
		this.pict.addView('FacetDemo-Page', libViewPage.default_configuration, libViewPage);
		this.pict.addView('FacetDemo-Compare', libViewCompare.default_configuration, libViewCompare);
		this.pict.addView('FacetDemo-Change', libViewChange.default_configuration, libViewChange);
		this.pict.addView('Facet-Scope', libViewFacetScope.default_configuration, libViewFacetScope);
		this.pict.addView('Facet-Terms', libViewFacetTerms.default_configuration, libViewFacetTerms);
		this.pict.addView('Facet-Histogram', libViewFacetHistogram.default_configuration, libViewFacetHistogram);
		this.pict.addView('Facet-Pivot', libViewFacetPivot.default_configuration, libViewFacetPivot);
		this.pict.addView('Facet-Records', libViewFacetRecords.default_configuration, libViewFacetRecords);
		this.pict.addView('Facet-Inspector', libViewFacetInspector.default_configuration, libViewFacetInspector);
	}

	onAfterInitializeAsync(fCallback)
	{
		this.pict.AppData.FacetDemo =
			{
				Ready: false,
				ActivePage: null,
				ActiveTab: { LabForms: 'A' },
				Personas: [],
				PrincipalKey: null,
				PrincipalHeader: 'X-Retold-Facet-Demo-Principal',
				Theme: this._currentTheme(),
				Status: null,
				BootError: null,
				// M4: the "Make a change" panels' state (FacetDemo-Change).
				Change: {}
			};

		let tmpFacet = this.pict.providers.Facet;
		tmpFacet.setShowInternals(storageGet(STORAGE_INTERNALS) === '1');
		tmpFacet.setEndpointPrefix((pDomain) => { return `${API_PREFIX}/${pDomain}`; });
		tmpFacet.setRequestHeaders(
			() =>
			{
				let tmpDemo = this.pict.AppData.FacetDemo;
				let tmpHeaders = {};
				if (tmpDemo.PrincipalKey)
				{
					tmpHeaders[tmpDemo.PrincipalHeader] = tmpDemo.PrincipalKey;
				}
				return tmpHeaders;
			});
		Object.keys(libFacetDemoPages.Groups).forEach(
			(pGroupHash) =>
			{
				tmpFacet.defineGroup(libFacetDemoPages.Groups[pGroupHash]);
			});
		// A change event refetches the groups of the page on screen (both LabForms tabs: their counts both show).
		tmpFacet.setGroupVisibility(
			(pGroupHash) =>
			{
				let tmpPage = libFacetDemoPages.Pages.find((pCandidate) => { return pCandidate.Hash === this.pict.AppData.FacetDemo.ActivePage; });
				return !!tmpPage && (tmpPage.Groups.indexOf(pGroupHash) >= 0);
			});

		let tmpDemo = this.pict.AppData.FacetDemo;
		getJSON('/api/Demo/Principals',
			(pPrincipalsError, pPrincipals) =>
			{
				if (pPrincipalsError || !pPrincipals || !Array.isArray(pPrincipals.Personas))
				{
					tmpDemo.BootError = { Code: (pPrincipalsError && pPrincipalsError.Code) ? pPrincipalsError.Code : 'DEMO_NETWORK', Message: pPrincipalsError ? pPrincipalsError.message : 'No persona list.' };
					this.pict.views['FacetDemo-Layout'].render();
					return super.onAfterInitializeAsync(fCallback);
				}
				tmpDemo.Personas = pPrincipals.Personas;
				if (typeof(pPrincipals.Header) === 'string')
				{
					tmpDemo.PrincipalHeader = pPrincipals.Header;
				}
				let tmpSaved = storageGet(STORAGE_PRINCIPAL);
				let tmpKey = tmpDemo.Personas.some((pPersona) => { return pPersona.Key === tmpSaved; }) ? tmpSaved : (pPrincipals.Default || (tmpDemo.Personas[0] ? tmpDemo.Personas[0].Key : null));
				tmpDemo.PrincipalKey = tmpKey;
				tmpFacet.setPrincipalKey(tmpKey);
				this._applyPrincipalInfo();
				getJSON('/api/Demo/Status',
					(pStatusError, pStatus) =>
					{
						// The status only feeds the footer; a failure there is not a boot failure.
						tmpDemo.Status = pStatusError ? null : pStatus;
						tmpDemo.Ready = true;
						this.pict.views['FacetDemo-Layout'].render();
						return super.onAfterInitializeAsync(fCallback);
					});
			});
	}

	/**
	 * The theme in effect: the saved / pre-paint attribute, else the OS preference.
	 *
	 * @return {string} 'dark' | 'light'
	 */
	_currentTheme()
	{
		let tmpAttribute = null;
		try
		{
			// (ContentAssignment.readAttribute returns the element set in this pict version, so read the element.)
			let tmpRoots = this.pict.ContentAssignment.getElement('html');
			tmpAttribute = (tmpRoots && tmpRoots.length && (typeof(tmpRoots[0].getAttribute) === 'function')) ? tmpRoots[0].getAttribute('data-fd-theme') : null;
		}
		catch (pError)
		{
			tmpAttribute = null;
		}
		if ((tmpAttribute === 'dark') || (tmpAttribute === 'light'))
		{
			return tmpAttribute;
		}
		try
		{
			return (typeof(window) !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
		}
		catch (pError)
		{
			return 'light';
		}
	}

	/**
	 * Tell the provider what the demo knows about the persona (display only: "(you)" in a list, the empty-state
	 * note).
	 */
	_applyPrincipalInfo()
	{
		let tmpDemo = this.pict.AppData.FacetDemo;
		let tmpPersona = (tmpDemo.Personas || []).find((pCandidate) => { return pCandidate.Key === tmpDemo.PrincipalKey; }) || null;
		this.pict.providers.Facet.setPrincipalInfo(tmpPersona ? { User: (typeof(tmpPersona.User) === 'number') ? tmpPersona.User : null, Label: tmpPersona.Label, Notes: tmpPersona.Domains || {} } : null);
	}

	/**
	 * After a Describe: derive the facet list of the page's Describe-driven groups of that domain, redraw the
	 * page when it changed, and query the group.  A failed Describe leaves a group without facets in the Error
	 * state (its banner says why).
	 *
	 * @param {Record<string, any>} pPage
	 * @param {string} pDomain
	 * @param {Error|null} pError
	 */
	_applyDescribed(pPage, pDomain, pError)
	{
		let tmpFacet = this.pict.providers.Facet;
		pPage.Groups.forEach(
			(pGroupHash) =>
			{
				let tmpDefinition = libFacetDemoPages.Groups[pGroupHash];
				let tmpState = tmpFacet.group(pGroupHash);
				if (!tmpDefinition || !tmpState || (tmpDefinition.FacetsFrom !== 'Describe') || (tmpDefinition.Domain !== pDomain))
				{
					return;
				}
				if (pError)
				{
					if (/^Superseded/.test(pError.message || ''))
					{
						return;
					}
					if (!Array.isArray(tmpState.Facets) || (tmpState.Facets.length < 1))
					{
						tmpFacet.failGroup(pGroupHash, tmpFacet.describeError(pDomain) || { Code: 'DEMO_NETWORK', Status: 0, Message: pError.message });
					}
					return;
				}
				let tmpEntity = tmpFacet.entityCapabilities(pDomain, tmpDefinition.Entity);
				if (!tmpEntity)
				{
					tmpFacet.failGroup(pGroupHash, { Code: 'FACET_UNKNOWN_ENTITY', Status: 404, Message: `Describe lists no ${tmpDefinition.Entity} for this principal.` });
					return;
				}
				let tmpDerived = libFacetDemoPages.describedFacets(tmpDefinition, tmpEntity);
				let tmpChanged = tmpFacet.applyDescribedFacets(pGroupHash, tmpDerived.Facets, tmpDerived.Panels, tmpDerived.Skipped);
				if (tmpChanged && (this.pict.AppData.FacetDemo.ActivePage === pPage.Hash))
				{
					this.pict.views['FacetDemo-Page'].showPage(pPage.Hash);
				}
				if (tmpFacet.isStale(pGroupHash))
				{
					tmpFacet.refresh(pGroupHash);
				}
			});
	}

	/**
	 * Describe the page's domains (once per principal) and refresh every group of the page that never loaded,
	 * loaded for another principal, or failed.
	 *
	 * @param {string} pPageHash
	 */
	loadPage(pPageHash)
	{
		let tmpPageView = this.pict.views['FacetDemo-Page'];
		let tmpPage = tmpPageView.pageDefinition(pPageHash);
		if (!tmpPage)
		{
			return;
		}
		let tmpFacet = this.pict.providers.Facet;
		let tmpDomains = [];
		tmpPage.Groups.forEach(
			(pGroupHash) =>
			{
				let tmpDomain = libFacetDemoPages.Groups[pGroupHash].Domain;
				if (tmpDomains.indexOf(tmpDomain) < 0)
				{
					tmpDomains.push(tmpDomain);
				}
			});
		tmpDomains.forEach(
			(pDomain) =>
			{
				// M4: one change stream per domain for the current persona (kept while it stays open).
				tmpFacet.subscribeChanges(pDomain);
				tmpFacet.describe(pDomain,
					(pError) =>
					{
						// Scope bars and Describe-titled cards follow the capabilities of the current principal.
						if (this.pict.AppData.FacetDemo.ActivePage === tmpPage.Hash)
						{
							tmpPageView.renderPanels({ Widgets: [ 'Scope', 'Terms' ] });
							tmpPageView.renderHead();
						}
						this._applyDescribed(tmpPage, pDomain, pError || null);
					});
			});
		// Every group of the page (a Describe-driven group without facets yet sends nothing until its Describe).
		tmpPage.Groups.forEach(
			(pGroupHash) =>
			{
				if (tmpFacet.isStale(pGroupHash))
				{
					tmpFacet.refresh(pGroupHash);
				}
			});
	}

	/**
	 * Router target: show a page (DEMO-SPEC §4.4).
	 *
	 * @param {string} pPageHash - FacetDemo-Pages Pages[].Hash
	 */
	showPage(pPageHash)
	{
		let tmpPageView = this.pict.views['FacetDemo-Page'];
		let tmpPage = tmpPageView.pageDefinition(pPageHash) || tmpPageView.pageDefinition(libFacetDemoPages.DefaultPage);
		this.pict.AppData.FacetDemo.ActivePage = tmpPage.Hash;
		this.pict.views['FacetDemo-Layout'].renderHeader();
		tmpPageView.showPage(tmpPage.Hash);
		this.updateInspectorContext(tmpPage.Hash);
		this.loadPage(tmpPage.Hash);
	}

	/**
	 * Point the inspector at a page: its groups (the visible ones first, so the bar shows the answer on screen)
	 * and its domains (for Describe).
	 *
	 * @param {string} pPageHash
	 */
	updateInspectorContext(pPageHash)
	{
		let tmpInspector = this.pict.views['Facet-Inspector'];
		let tmpPageView = this.pict.views['FacetDemo-Page'];
		let tmpPage = tmpPageView.pageDefinition(pPageHash);
		if (!tmpInspector || !tmpPage)
		{
			return;
		}
		let tmpGroups = tmpPageView.visibleGroups(tmpPage);
		tmpPage.Groups.forEach((pGroupHash) => { if (tmpGroups.indexOf(pGroupHash) < 0) { tmpGroups.push(pGroupHash); } });
		let tmpDomains = [];
		tmpPage.Groups.forEach((pGroupHash) => { let tmpDomain = libFacetDemoPages.Groups[pGroupHash].Domain; if (tmpDomains.indexOf(tmpDomain) < 0) { tmpDomains.push(tmpDomain); } });
		let tmpTab = tmpPageView.activeTab(tmpPage);
		tmpInspector.setContext({ Label: tmpTab ? `${tmpPage.NavLabel} (${tmpTab.Hash})` : tmpPage.NavLabel, Groups: tmpGroups, Domains: tmpDomains });
	}

	/**
	 * Header switcher target: change the DEMO principal (DEMO-SPEC §3.4).  Selections are kept: the same
	 * request, a different answer.
	 *
	 * @param {string} pPersonaKey
	 */
	setPrincipal(pPersonaKey)
	{
		let tmpDemo = this.pict.AppData.FacetDemo;
		if (!tmpDemo.Personas.some((pPersona) => { return pPersona.Key === pPersonaKey; }))
		{
			return;
		}
		storageSet(STORAGE_PRINCIPAL, pPersonaKey);
		tmpDemo.PrincipalKey = pPersonaKey;
		// The streams belong to the previous persona: close them (loadPage opens the new persona's).
		this.pict.providers.Facet.closeChanges();
		this.pict.providers.Facet.setPrincipalKey(pPersonaKey);
		this._applyPrincipalInfo();
		this.pict.views['FacetDemo-Layout'].renderHeader();
		if (tmpDemo.ActivePage)
		{
			let tmpPageView = this.pict.views['FacetDemo-Page'];
			// The scope bars depend on the new principal's Describe: show them pending right away.
			tmpPageView.renderPanels({ Widgets: [ 'Scope' ] });
			tmpPageView.renderHead();
			this.loadPage(tmpDemo.ActivePage);
		}
	}

	/**
	 * Header toggle target: light / dark (DEMO-SPEC §8.3).
	 */
	toggleTheme()
	{
		let tmpDemo = this.pict.AppData.FacetDemo;
		let tmpNext = (this._currentTheme() === 'dark') ? 'light' : 'dark';
		this.pict.ContentAssignment.setAttribute('html', 'data-fd-theme', tmpNext);
		storageSet(STORAGE_THEME, tmpNext);
		tmpDemo.Theme = tmpNext;
		this.pict.views['FacetDemo-Layout'].renderHeader();
	}

	/**
	 * Head toggle target: show the contract vocabulary (Fold, CountMode, Relaxed, …) on the cards.
	 */
	toggleInternals()
	{
		let tmpFacet = this.pict.providers.Facet;
		tmpFacet.setShowInternals(!tmpFacet.showInternals());
		storageSet(STORAGE_INTERNALS, tmpFacet.showInternals() ? '1' : '0');
		let tmpPageView = this.pict.views['FacetDemo-Page'];
		tmpPageView.renderHead();
		tmpPageView.renderPanels();
	}

	/**
	 * M5 head toggle target (DEMO_CLICKHOUSE=1): which engine the page's Queries ask for — 'Auto' (the server routes
	 * each facet: the store when it is fresh enough for the page's Freshness), 'Live' (Engine: 'Live') or 'Fast'
	 * (Freshness Fast: the store whenever it can answer) — then refetch the page's groups.
	 *
	 * @param {string} pMode
	 */
	setEngineMode(pMode)
	{
		let tmpFacet = this.pict.providers.Facet;
		tmpFacet.setEngineMode(pMode);
		this.pict.AppData.FacetDemo.EngineCompare = null;
		let tmpDemo = this.pict.AppData.FacetDemo;
		let tmpPageView = this.pict.views['FacetDemo-Page'];
		let tmpPage = tmpPageView.pageDefinition(tmpDemo.ActivePage);
		tmpPageView.renderHead();
		if (tmpPage)
		{
			tmpPage.Groups.forEach((pGroupHash) => { tmpFacet.refresh(pGroupHash, () => { tmpPageView.renderHead(); }); });
		}
	}

	/**
	 * M5 head button target: the page's first group answered by Live and by the store (Freshness Fast) side by side
	 * (FacetDemo.EngineCompare; the head shows the verdict, the inspector both exchanges).
	 */
	compareEngines()
	{
		let tmpDemo = this.pict.AppData.FacetDemo;
		let tmpPageView = this.pict.views['FacetDemo-Page'];
		let tmpPage = tmpPageView.pageDefinition(tmpDemo.ActivePage);
		if (!tmpPage)
		{
			return;
		}
		let tmpGroupHash = tmpPageView.visibleGroups(tmpPage)[0];
		tmpDemo.EngineCompare = { Page: tmpPage.Hash, GroupHash: tmpGroupHash, Pending: true, Result: null, Error: null };
		tmpPageView.renderHead();
		this.pict.providers.Facet.compareEngines(tmpGroupHash,
			(pError, pResult) =>
			{
				tmpDemo.EngineCompare = { Page: tmpPage.Hash, GroupHash: tmpGroupHash, Pending: false, Result: pResult || null, Error: pError ? pError.message : null };
				tmpPageView.renderHead();
			});
	}

	/**
	 * Navigate (used by the nav links).
	 *
	 * @param {string} pRoute
	 */
	navigateTo(pRoute)
	{
		this.pict.providers.PictRouter.navigate(pRoute);
	}
}

module.exports = PictApplicationFacetingDemo;

module.exports.default_configuration =
	{
		Name: 'FacetingDemo',
		Hash: 'FacetingDemo',
		MainViewportViewIdentifier: 'FacetDemo-Layout',
		AutoRenderMainViewportViewAfterInitialize: false,
		// Settings for the pict instance Pict.safeLoadPictApplication creates (names the log lines).
		pict_configuration:
			{
				Product: 'FacetingDemo'
			}
	};
