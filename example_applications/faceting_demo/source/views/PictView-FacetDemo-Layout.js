/**
 * FacetDemo-Layout -- the shell (DEMO-SPEC §7.1, §8.1): app header (nav to the four pages, the DEMO
 * "Signed in as" principal switcher, the theme toggle), the page slot, the footer and the inspector drawer slot.
 *
 *   #FacetingDemo-Application-Container
 *     #FD-Header      nav + switcher + theme toggle          (this view, renderable FacetDemo-Header)
 *     #FD-Page        the active page                         (FacetDemo-Page; or the boot error card)
 *     #FD-Footer      "3 domains · SQLite · Small seed · …"  (this view, renderable FacetDemo-Footer)
 *     #FD-Inspector   the request / envelope drawer           (Facet-Inspector)
 *
 * Header model (AppData.FacetDemo): Nav, PersonaOptions, PersonaNote, ThemeLabel (+ HeaderSlot, empty on a boot error),
 * prepared by prepareHeader().
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libPictView = require('pict-view');

const libFacetDemoPages = require('../pages/FacetDemo-Pages.js');
const libFacetDisplay = require('../providers/Facet-Display.js');

const DEMO_TOOLTIP = 'Demo only: this host resolves the header to a test session. A real app resolves the principal from its own session.';

const _ViewConfiguration =
	{
		ViewIdentifier: 'FacetDemo-Layout',
		DefaultRenderable: 'FacetDemo-Layout-Shell',
		DefaultDestinationAddress: '#FacetingDemo-Application-Container',
		AutoRender: false,

		CSS: /*css*/`
			.fd-shell { max-width: 1440px; margin: 0 auto; padding: 0 24px 72px; }
			.fd-header { position: sticky; top: 0; z-index: 40; margin: 0 -24px; padding: 10px 24px; background: var(--fd-surface, #ffffff);
				border-bottom: 1px solid var(--fd-border, #dfe3e9); box-shadow: var(--fd-shadow, 0 1px 2px rgba(16, 24, 40, 0.06)); }
			.fd-header-inner { display: flex; align-items: center; gap: 16px; }
			.fd-nav { display: flex; flex-wrap: wrap; gap: 4px; flex: 1 1 auto; min-width: 0; }
			.fd-nav-pill { flex: 0 0 auto; padding: 7px 14px; border-radius: 999px; font-size: 13px; font-weight: 500; white-space: nowrap; text-decoration: none;
				color: var(--fd-text-muted, #5d6878); transition: background-color 100ms, color 100ms; }
			.fd-nav-pill:hover { background: var(--fd-surface-2, #f0f2f5); color: var(--fd-text, #1b2230); }
			.fd-nav-pill:focus-visible { outline: 2px solid var(--fd-accent, #3b5bdb); outline-offset: 1px; }
			.fd-nav-active, .fd-nav-active:hover { background: var(--fd-accent-soft, #e8edfd); color: var(--fd-accent, #3b5bdb); font-weight: 600; }
			.fd-switcher { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
			.fd-switcher-row { display: flex; align-items: center; gap: 8px; }
			.fd-demo-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 4px; font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
				text-transform: uppercase; color: var(--fd-demo, #c2410c); background: var(--fd-demo-soft, #fff1e6); border: 1px solid var(--fd-demo, #c2410c); cursor: help; }
			.fd-switcher-label { font-size: 12px; color: var(--fd-text-muted, #5d6878); white-space: nowrap; }
			.fd-select { padding: 5px 28px 5px 10px; border-radius: var(--fd-radius-sm, 6px); border: 1px solid var(--fd-demo, #c2410c); font: inherit; font-size: 13px;
				color: var(--fd-text, #1b2230); background-color: var(--fd-surface, #ffffff); cursor: pointer; }
			.fd-select:focus-visible { outline: 2px solid var(--fd-demo, #c2410c); outline-offset: 1px; }
			.fd-switcher-note { max-width: 460px; font-size: 11px; line-height: 1.35; color: var(--fd-text-muted, #5d6878); text-align: right; }
			.fd-theme-btn { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: var(--fd-radius-sm, 6px); border: 1px solid var(--fd-border, #dfe3e9);
				background: var(--fd-surface, #ffffff); font: inherit; font-size: 12px; color: var(--fd-text, #1b2230); cursor: pointer; transition: border-color 100ms, color 100ms; }
			.fd-theme-btn:hover { border-color: var(--fd-accent, #3b5bdb); color: var(--fd-accent, #3b5bdb); }
			.fd-theme-btn:focus-visible { outline: 2px solid var(--fd-accent, #3b5bdb); outline-offset: 1px; }
			.fd-page { padding-bottom: 56px; }
			/* While the inspector drawer is open the page can still scroll its last rows above it. */
			html[data-facet-inspector="open"] .fd-page { padding-bottom: calc(45vh + 24px); }
			.fd-footer { margin-top: 24px; font-size: 12px; color: var(--fd-text-faint, #8a94a3); text-align: center; }
			.fd-boot-error { max-width: 640px; margin: 48px auto; padding: 24px 28px; border-radius: var(--fd-radius, 10px); background: var(--fd-surface, #ffffff);
				border: 1px solid var(--fd-error, #c92a2a); box-shadow: var(--fd-shadow-raised, 0 8px 24px rgba(16, 24, 40, 0.14)); }
			.fd-boot-error h2 { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 18px; color: var(--fd-error, #c92a2a); }
			.fd-boot-error p { margin: 6px 0; color: var(--fd-text-muted, #5d6878); }
			.fd-boot-error code { font-family: var(--fd-mono, ui-monospace, Menlo, monospace); padding: 1px 6px; border-radius: 4px; background: var(--fd-code-bg, #f3f5f8); color: var(--fd-code-text, #24292f); }
			@media (max-width: 960px)
			{
				.fd-shell { padding: 0 14px 72px; }
				.fd-header { margin: 0 -14px; padding: 8px 14px; }
				.fd-header-inner { flex-direction: column; align-items: stretch; gap: 8px; }
				.fd-switcher { align-items: flex-start; }
				.fd-switcher-row { flex-wrap: wrap; }
				.fd-switcher-note { text-align: left; max-width: none; }
				html[data-facet-inspector="open"] .fd-page { padding-bottom: calc(70vh + 24px); }
			}
		`,

		Templates:
			[
				{
					Hash: 'FacetDemo-Layout-Shell-Template',
					Template: /*html*/`
<div class="fd-shell">
	<header id="FD-Header" class="fd-header"></header>
	<main id="FD-Page" class="fd-page"></main>
	<footer id="FD-Footer" class="fd-footer"></footer>
</div>
<aside id="FD-Inspector" class="fd-inspector" aria-label="Request and envelope inspector"></aside>`
				},
				{
					Hash: 'FacetDemo-Header-Template',
					Template: /*html*/`{~TS:FacetDemo-Header-Body-Template:Record.HeaderSlot~}`
				},
				{
					Hash: 'FacetDemo-Header-Body-Template',
					Template: /*html*/`
<div class="fd-header-inner">
	<nav class="fd-nav" aria-label="Demo pages">{~TS:FacetDemo-Nav-Item-Template:Record.Nav~}</nav>
	<div class="fd-switcher">
		<div class="fd-switcher-row">
			<span class="fd-demo-badge" title="${DEMO_TOOLTIP}">{~I:Warning~} Demo</span>
			<label class="fd-switcher-label" for="FD-Principal">Signed in as</label>
			<select id="FD-Principal" class="fd-select" title="${DEMO_TOOLTIP}" onchange="{~P~}.PictApplication.setPrincipal(this.value)">{~TS:FacetDemo-Persona-Option-Template:Record.PersonaOptions~}</select>
			<button type="button" class="fd-theme-btn" title="Switch the color theme" onclick="{~P~}.PictApplication.toggleTheme()">{~I:Eye~} {~D:Record.ThemeLabel~}</button>
		</div>
		<div class="fd-switcher-note" title="{~D:Record.PersonaNote~}">{~D:Record.PersonaNote~}</div>
	</div>
</div>`
				},
				{
					Hash: 'FacetDemo-Nav-Item-Template',
					Template: /*html*/`<a class="fd-nav-pill {~D:Record.ActiveClass~}" href="#{~D:Record.Route~}" aria-current="{~D:Record.Current~}" onclick="{~P~}.PictApplication.navigateTo('{~D:Record.Route~}'); return false;">{~D:Record.Label~}</a>`
				},
				{
					Hash: 'FacetDemo-Persona-Option-Template',
					Template: /*html*/`<option value="{~D:Record.Key~}" {~D:Record.SelectedAttr~}>{~D:Record.Text~}</option>`
				},
				{
					Hash: 'FacetDemo-Footer-Template',
					Template: /*html*/`{~D:Record.FooterText~}`
				},
				{
					Hash: 'FacetDemo-Boot-Error-Template',
					Template: /*html*/`
<div class="fd-boot-error" role="alert">
	<h2>{~I:Error~} The demo host is not answering</h2>
	<p>Run <code>npm start</code> in <code>example_applications/faceting_demo</code>, then reload this page.</p>
	<p>{~D:Record.Code~}: {~D:Record.Message~}</p>
</div>`
				}
			],

		Renderables:
			[
				{
					RenderableHash: 'FacetDemo-Layout-Shell',
					TemplateHash: 'FacetDemo-Layout-Shell-Template',
					ContentDestinationAddress: '#FacetingDemo-Application-Container',
					RenderMethod: 'replace'
				},
				{
					RenderableHash: 'FacetDemo-Header',
					TemplateHash: 'FacetDemo-Header-Template',
					ContentDestinationAddress: '#FD-Header',
					DefaultTemplateRecordAddress: 'AppData.FacetDemo',
					RenderMethod: 'replace'
				},
				{
					RenderableHash: 'FacetDemo-Footer',
					TemplateHash: 'FacetDemo-Footer-Template',
					ContentDestinationAddress: '#FD-Footer',
					DefaultTemplateRecordAddress: 'AppData.FacetDemo',
					RenderMethod: 'replace'
				},
				{
					RenderableHash: 'FacetDemo-Boot-Error',
					TemplateHash: 'FacetDemo-Boot-Error-Template',
					ContentDestinationAddress: '#FD-Page',
					DefaultTemplateRecordAddress: 'AppData.FacetDemo.BootErrorView',
					RenderMethod: 'replace'
				}
			]
	};

class PictViewFacetDemoLayout extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this._RouterResolved = false;
	}

	/**
	 * The domain whose persona note the header shows: the active page's first group's domain.
	 *
	 * @return {string|null}
	 */
	_activeDomain()
	{
		let tmpDemo = this.pict.AppData.FacetDemo;
		let tmpPage = libFacetDemoPages.Pages.find((pPage) => { return pPage.Hash === tmpDemo.ActivePage; });
		let tmpGroup = tmpPage ? libFacetDemoPages.Groups[tmpPage.Groups[0]] : null;
		return tmpGroup ? tmpGroup.Domain : null;
	}

	/**
	 * Prepare the header display data on AppData.FacetDemo (Nav, PersonaOptions, PersonaNote, ThemeLabel, FooterText).
	 */
	prepareHeader()
	{
		let tmpDemo = this.pict.AppData.FacetDemo;
		tmpDemo.Nav = libFacetDemoPages.Pages.map(
			(pPage) =>
			{
				let tmpActive = (pPage.Hash === tmpDemo.ActivePage);
				return { Route: libFacetDisplay.text(pPage.Route), Label: libFacetDisplay.text(pPage.NavLabel), ActiveClass: tmpActive ? 'fd-nav-active' : '', Current: tmpActive ? 'page' : 'false' };
			});
		let tmpPersonas = Array.isArray(tmpDemo.Personas) ? tmpDemo.Personas : [];
		tmpDemo.PersonaOptions = tmpPersonas.map(
			(pPersona) =>
			{
				let tmpText = (typeof(pPersona.Tenant) === 'number') ? `${pPersona.Label} · tenant ${pPersona.Tenant}` : `${pPersona.Label} · no session`;
				return { Key: libFacetDisplay.text(pPersona.Key), Text: libFacetDisplay.text(tmpText), SelectedAttr: (pPersona.Key === tmpDemo.PrincipalKey) ? 'selected' : '' };
			});
		let tmpPersona = tmpPersonas.find((pCandidate) => { return pCandidate.Key === tmpDemo.PrincipalKey; }) || null;
		let tmpDomain = this._activeDomain();
		let tmpNote = '';
		if (tmpPersona)
		{
			tmpNote = (tmpDomain && tmpPersona.Domains && tmpPersona.Domains[tmpDomain]) ? `${tmpDomain}: ${tmpPersona.Domains[tmpDomain]}` : (tmpPersona.Summary || '');
		}
		tmpDemo.PersonaNote = libFacetDisplay.text(tmpNote);
		tmpDemo.ThemeLabel = (tmpDemo.Theme === 'dark') ? 'Light' : 'Dark';
		// No nav or switcher while the demo host is unreachable (the boot error card says what to do).
		tmpDemo.HeaderSlot = tmpDemo.BootError ? [] : [ { Nav: tmpDemo.Nav, PersonaOptions: tmpDemo.PersonaOptions, PersonaNote: tmpDemo.PersonaNote, ThemeLabel: tmpDemo.ThemeLabel } ];
		let tmpStatus = tmpDemo.Status || null;
		if (tmpStatus && tmpStatus.Domains)
		{
			let tmpCount = Object.keys(tmpStatus.Domains).length;
			tmpDemo.FooterText = libFacetDisplay.text(`${tmpCount} domain${(tmpCount === 1) ? '' : 's'} · ${tmpStatus.Provider || 'SQLite'} · ${tmpStatus.Scale || 'Small'} seed · retold-faceting-service faceting demo`);
		}
		else
		{
			tmpDemo.FooterText = 'retold-faceting-service faceting demo';
		}
	}

	/**
	 * Re-render only the header (nav highlight, principal label) and the footer.
	 */
	renderHeader()
	{
		this.prepareHeader();
		this.render('FacetDemo-Header');
		this.render('FacetDemo-Footer');
	}

	onAfterRender(pRenderable, pRenderDestinationAddress, pRecord, pContent)
	{
		this.pict.CSSMap.injectCSS();
		if (pRenderable && (pRenderable.RenderableHash === 'FacetDemo-Layout-Shell'))
		{
			this.renderHeader();
			let tmpDemo = this.pict.AppData.FacetDemo;
			if (tmpDemo.BootError)
			{
				tmpDemo.BootErrorView = { Code: libFacetDisplay.text(tmpDemo.BootError.Code), Message: libFacetDisplay.text(tmpDemo.BootError.Message) };
				this.render('FacetDemo-Boot-Error');
			}
			else
			{
				if (this.pict.views['Facet-Inspector'])
				{
					this.pict.views['Facet-Inspector'].attach();
				}
				if (!this._RouterResolved)
				{
					this._RouterResolved = true;
					let tmpHash = (typeof(window) !== 'undefined' && window.location) ? String(window.location.hash || '') : '';
					if ((tmpHash.length < 3) || (tmpHash === '#/'))
					{
						this.pict.PictApplication.navigateTo(`/${libFacetDemoPages.DefaultPage}`);
					}
					else
					{
						this.pict.providers.PictRouter.resolve();
						if (!tmpDemo.ActivePage)
						{
							// An unknown hash: fall back to the default page.
							this.pict.PictApplication.navigateTo(`/${libFacetDemoPages.DefaultPage}`);
						}
					}
				}
			}
		}
		return super.onAfterRender(pRenderable, pRenderDestinationAddress, pRecord, pContent);
	}
}

module.exports = PictViewFacetDemoLayout;
module.exports.default_configuration = _ViewConfiguration;
