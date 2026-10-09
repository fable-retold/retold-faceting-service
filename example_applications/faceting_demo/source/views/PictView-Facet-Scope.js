/**
 * Facet-Scope -- the named-scope bar of a group (DEMO-SPEC §7.3).  Liftable (pict-section-facet:
 * PRSP-FilterType-FacetScope).
 *
 * Driven by Describe: AppData.FacetCapabilities[<Domain>].Entities[<Entity>].Scopes ([ { Scope, Description,
 * Params, Relaxed } ]) merged with the group's ScopeState (state order first, then any other scope Describe
 * offers; a state scope Describe does not list for this principal is not shown; panel.Hide drops scopes that
 * are not part of the page's question).  One switch per scope: label = panel.Labels[Scope], else the scope name
 * after the entity, de-camel-cased; under it a short audience-facing line, panel.Descriptions[Scope], else
 * Describe's Description.  An ON scope with declared Params shows its param chips:
 *   EnumList  multi-select chips over Values (the declared Default when the state has none, or an empty list)
 * Write-back: provider.setScope(Group, Scope, On, Params).  Deselecting the last Roles chip is allowed on
 * purpose: the server's 400 FACET_PARAM_INVALID banner is one of the demo's error states; turning the scope off
 * and on again restores the Default.  Relaxed scopes say so once, in the page head (the badge here is an
 * internal, shown with "Show internals").
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libPictView = require('pict-view');

const libFacetSelection = require('../providers/Facet-Selection.js');
const libFacetDisplay = require('../providers/Facet-Display.js');

const VIEW_IDENTIFIER = 'Facet-Scope';

const _ViewConfiguration =
	{
		ViewIdentifier: VIEW_IDENTIFIER,
		DefaultRenderable: 'Facet-Scope-Panel',
		DefaultDestinationAddress: '#FD-Top',
		AutoRender: false,

		CSS: /*css*/`
			.facet-scopes { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 18px; }
			.facet-scopes-title { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--facet-text-faint, #8a94a3); margin-right: 2px; }
			.facet-scope-item { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
			.facet-scope { display: inline-flex; align-items: center; gap: 8px; margin: 0; padding: 4px 8px 4px 4px; border: 0; border-radius: var(--facet-radius-sm, 6px);
				background: none; font: inherit; font-size: 13px; color: var(--facet-text, #1b2230); text-align: left; cursor: pointer; transition: background-color 100ms; }
			.facet-scope-text { display: inline-flex; flex-direction: column; line-height: 1.25; }
			.facet-scope-desc { font-size: 11px; color: var(--facet-text-faint, #8a94a3); }
			.facet-scope:hover { background: var(--facet-surface-2, #f0f2f5); }
			.facet-scope:focus-visible { outline: 2px solid var(--facet-accent, #3b5bdb); outline-offset: 1px; }
			.facet-switch { position: relative; flex: 0 0 auto; width: 28px; height: 16px; border-radius: 999px; background: var(--facet-bar-zero, #e4e8ef);
				border: 1px solid var(--facet-border, #dfe3e9); transition: background-color 120ms, border-color 120ms; }
			.facet-switch-knob { position: absolute; top: 1px; left: 1px; width: 12px; height: 12px; border-radius: 50%; background: var(--facet-surface, #ffffff); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3); }
			.facet-scope-on .facet-switch { background: var(--facet-accent, #3b5bdb); border-color: var(--facet-accent, #3b5bdb); }
			.facet-scope-on .facet-switch-knob { left: 13px; }
			.facet-scope-off .facet-scope-label { color: var(--facet-text-muted, #5d6878); }
			.facet-scope-params { display: inline-flex; gap: 4px; flex-wrap: wrap; }
			.facet-param { margin: 0; padding: 1px 9px; border-radius: 999px; border: 1px solid var(--facet-border, #dfe3e9); background: var(--facet-surface, #ffffff);
				font: inherit; font-size: 11px; line-height: 18px; color: var(--facet-text-muted, #5d6878); cursor: pointer; transition: background-color 100ms, border-color 100ms, color 100ms; }
			.facet-param:hover { border-color: var(--facet-accent, #3b5bdb); color: var(--facet-accent, #3b5bdb); }
			.facet-param:focus-visible { outline: 2px solid var(--facet-accent, #3b5bdb); outline-offset: 1px; }
			.facet-param-on { background: var(--facet-accent, #3b5bdb); border-color: var(--facet-accent, #3b5bdb); color: var(--facet-accent-text, #ffffff); }
			.facet-param-on:hover { color: var(--facet-accent-text, #ffffff); }
			.facet-param-empty { font-size: 11px; color: var(--facet-error, #c92a2a); }
		`,

		Templates:
			[
				{
					Hash: 'Facet-Scope-Panel-Template',
					Template: /*html*/`
<div class="facet-scopes {~D:Record.CardClass~}" role="group" aria-label="Named scopes">
	<span class="facet-scopes-title">Scopes</span>
	{~TS:Facet-Scope-Item-Template:Record.Scopes~}
	{~TS:Facet-Scope-Note-Template:Record.NoteSlot~}
</div>`
				},
				{
					Hash: 'Facet-Scope-Item-Template',
					Template: /*html*/`
<span class="facet-scope-item">
	<button type="button" role="switch" aria-checked="{~D:Record.Checked~}" class="facet-scope {~D:Record.OnClass~}" title="{~D:Record.Tip~}" data-focus-key="scope-{~D:Record.Scope~}" onclick="{~P~}.views['{~D:Record.ViewHash~}'].toggleScope('{~D:Record.Group~}', '{~D:Record.Scope~}')">
		<span class="facet-switch"><span class="facet-switch-knob"></span></span>
		<span class="facet-scope-text"><span class="facet-scope-label">{~D:Record.Label~}</span>{~TS:Facet-Scope-Desc-Template:Record.DescSlot~}</span>
	</button>
	{~TS:Facet-Badge-Template:Record.Badges~}
	{~TS:Facet-Scope-Param-Template:Record.Params~}
</span>`
				},
				{
					Hash: 'Facet-Scope-Desc-Template',
					Template: /*html*/`<span class="facet-scope-desc">{~D:Record.Text~}</span>`
				},
				{
					Hash: 'Facet-Scope-Param-Template',
					Template: /*html*/`<span class="facet-scope-params" role="group" aria-label="{~D:Record.Param~}">{~TS:Facet-Scope-Param-Value-Template:Record.Values~}{~TS:Facet-Scope-Param-Empty-Template:Record.EmptySlot~}</span>`
				},
				{
					Hash: 'Facet-Scope-Param-Value-Template',
					Template: /*html*/`<button type="button" class="facet-param {~D:Record.OnClass~}" aria-pressed="{~D:Record.Pressed~}" title="{~D:Record.Param~}: {~D:Record.Label~}" data-focus-key="param-{~D:Record.Scope~}-{~D:Record.Param~}-{~D:Record.Index~}" onclick="{~P~}.views['{~D:Record.ViewHash~}'].toggleParamValue('{~D:Record.Group~}', '{~D:Record.Scope~}', '{~D:Record.Param~}', {~D:Record.Index~})">{~D:Record.Label~}</button>`
				},
				{
					Hash: 'Facet-Scope-Param-Empty-Template',
					Template: /*html*/`<span class="facet-param-empty">{~D:Record.Text~}</span>`
				},
				{
					Hash: 'Facet-Scope-Note-Template',
					Template: /*html*/`<span class="facet-note">{~D:Record.Text~}</span>`
				}
			],

		Renderables:
			[
				{
					RenderableHash: 'Facet-Scope-Panel',
					TemplateHash: 'Facet-Scope-Panel-Template',
					ContentDestinationAddress: '#FD-Top',
					RenderMethod: 'replace'
				}
			]
	};

class PictViewFacetScope extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this._Panels = {};
	}

	/**
	 * The scope list a group shows: state order first, then any other scope Describe offers.  Only scopes the
	 * current principal's Describe lists.
	 *
	 * @param {Record<string, any>} pState
	 * @return {Array<Record<string, any>>|null} Describe scope entries, or null when Describe is not available
	 */
	_describedScopes(pState, pHide)
	{
		let tmpCapabilities = this.pict.providers.Facet.entityCapabilities(pState.Domain, pState.Entity);
		if (!tmpCapabilities)
		{
			return null;
		}
		let tmpHide = Array.isArray(pHide) ? pHide : [];
		let tmpDescribed = (Array.isArray(tmpCapabilities.Scopes) ? tmpCapabilities.Scopes : []).filter((pScope) => { return tmpHide.indexOf(pScope.Scope) < 0; });
		let tmpByName = {};
		tmpDescribed.forEach((pScope) => { tmpByName[pScope.Scope] = pScope; });
		let tmpOrdered = [];
		Object.keys(pState.ScopeState).forEach(
			(pName) =>
			{
				if (tmpByName[pName])
				{
					tmpOrdered.push(tmpByName[pName]);
				}
			});
		tmpDescribed.forEach(
			(pScope) =>
			{
				if (tmpOrdered.indexOf(pScope) < 0)
				{
					tmpOrdered.push(pScope);
				}
			});
		return tmpOrdered;
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
		this._Panels[pPanel.Group] = pPanel;
		let tmpLabels = pPanel.Labels || {};
		let tmpDescriptions = pPanel.Descriptions || {};
		let tmpInternals = tmpProvider.showInternals();
		let tmpScopes = this._describedScopes(tmpState, pPanel.Hide);
		let tmpModel = { ViewHash: VIEW_IDENTIFIER, Group: pPanel.Group, CardClass: '', Scopes: [], NoteSlot: [] };

		if (!tmpScopes)
		{
			let tmpError = tmpProvider.describeError(tmpState.Domain);
			tmpModel.NoteSlot = [ { Text: tmpError ? libFacetDisplay.text(`Scopes unavailable for this principal (${tmpError.Code}).`) : 'Loading scopes…' } ];
		}
		else if (tmpScopes.length < 1)
		{
			tmpModel.NoteSlot = [ { Text: 'No named scopes on this entity for this principal.' } ];
		}
		else
		{
			tmpModel.Scopes = tmpScopes.map(
				(pScope) =>
				{
					let tmpEntry = tmpState.ScopeState[pScope.Scope] || { On: false, Params: {} };
					let tmpOn = (tmpEntry.On === true);
					let tmpShort = String(pScope.Scope).split('.').pop();
					let tmpBadges = [];
					if (tmpInternals && (pScope.Relaxed === true))
					{
						tmpBadges.push({ Text: 'Relaxed', Tone: 'internal', Tip: 'Relaxed: a TenantOnly hop counts matches anywhere in my tenant.' });
					}
					let tmpParams = [];
					let tmpDescription = tmpDescriptions[pScope.Scope] || pScope.Description || '';
					if (tmpOn && pScope.Params && (typeof(pScope.Params) === 'object'))
					{
						Object.keys(pScope.Params).forEach(
							(pParam) =>
							{
								let tmpDeclared = pScope.Params[pParam] || {};
								if (!Array.isArray(tmpDeclared.Values))
								{
									return;
								}
								let tmpChosen = Array.isArray(tmpEntry.Params ? tmpEntry.Params[pParam] : null) ? tmpEntry.Params[pParam] : [];
								let tmpValues = tmpDeclared.Values.map(
									(pValue, pIndex) =>
									{
										let tmpPicked = tmpChosen.some((pChosen) => { return libFacetSelection.sameKey(pChosen, pValue); });
										return (
											{
												ViewHash: VIEW_IDENTIFIER,
												Group: pPanel.Group,
												Scope: libFacetDisplay.text(pScope.Scope),
												Param: libFacetDisplay.text(pParam),
												Index: pIndex,
												Label: libFacetDisplay.text(pValue),
												OnClass: tmpPicked ? 'facet-param-on' : '',
												Pressed: tmpPicked ? 'true' : 'false'
											});
									});
								tmpParams.push(
									{
										Param: libFacetDisplay.text(pParam),
										Values: tmpValues,
										EmptySlot: (tmpChosen.length < 1) ? [ { Text: libFacetDisplay.text(`pick a ${pParam.replace(/s$/, '').toLowerCase()}`) } ] : []
									});
							});
					}
					return (
						{
							ViewHash: VIEW_IDENTIFIER,
							Group: pPanel.Group,
							Scope: libFacetDisplay.text(pScope.Scope),
							Label: libFacetDisplay.text(tmpLabels[pScope.Scope] || libFacetDisplay.deCamel(tmpShort)),
							DescSlot: tmpDescription ? [ { Text: libFacetDisplay.text(tmpDescription) } ] : [],
							Tip: libFacetDisplay.text(tmpInternals ? `${pScope.Scope}${pScope.Description ? `: ${pScope.Description}` : ''}` : (tmpOn ? 'On: click to turn this scope off' : 'Off: click to turn this scope on')),
							OnClass: tmpOn ? 'facet-scope-on' : 'facet-scope-off',
							Checked: tmpOn ? 'true' : 'false',
							Badges: tmpBadges,
							Params: tmpParams
						});
				});
		}

		tmpState.Widgets.Scope = tmpModel;
		let tmpFocus = tmpProvider.captureFocus(pPanel.PanelID);
		this.render('Facet-Scope-Panel', `#${pPanel.PanelID}`, `AppData.Facet.Groups.${pPanel.Group}.Widgets.Scope`);
		tmpProvider.restoreFocus(pPanel.PanelID, tmpFocus);
	}

	/**
	 * The Describe entry of a scope for the group's entity.
	 *
	 * @param {Record<string, any>} pState
	 * @param {string} pScope
	 * @return {Record<string, any>|null}
	 */
	_described(pState, pScope)
	{
		let tmpScopes = this._describedScopes(pState) || [];
		return tmpScopes.find((pCandidate) => { return pCandidate.Scope === pScope; }) || null;
	}

	/**
	 * @param {string} pGroupHash
	 * @param {string} pScope
	 */
	toggleScope(pGroupHash, pScope)
	{
		let tmpProvider = this.pict.providers.Facet;
		let tmpState = tmpProvider.group(pGroupHash);
		if (!tmpState)
		{
			return false;
		}
		let tmpEntry = tmpState.ScopeState[pScope] || { On: false, Params: {} };
		let tmpTurningOn = !(tmpEntry.On === true);
		let tmpParams = libFacetSelection.cloneJSON(tmpEntry.Params || {});
		let tmpDescribed = this._described(tmpState, pScope);
		if (tmpTurningOn && tmpDescribed && tmpDescribed.Params)
		{
			// Fill declared defaults for params the state has no value for (an emptied list counts as none: the
			// switch is the way back out of the FACET_PARAM_INVALID state).
			Object.keys(tmpDescribed.Params).forEach(
				(pParam) =>
				{
					let tmpDefault = tmpDescribed.Params[pParam] ? tmpDescribed.Params[pParam].Default : undefined;
					let tmpMissing = (typeof(tmpParams[pParam]) === 'undefined') || (tmpParams[pParam] === null) || (Array.isArray(tmpParams[pParam]) && (tmpParams[pParam].length < 1));
					if (tmpMissing && (typeof(tmpDefault) !== 'undefined'))
					{
						tmpParams[pParam] = libFacetSelection.cloneJSON(tmpDefault);
					}
				});
		}
		return tmpProvider.setScope(pGroupHash, pScope, tmpTurningOn, tmpParams);
	}

	/**
	 * @param {string} pGroupHash
	 * @param {string} pScope
	 * @param {string} pParam
	 * @param {number} pValueIndex - index into the param's declared Values
	 */
	toggleParamValue(pGroupHash, pScope, pParam, pValueIndex)
	{
		let tmpProvider = this.pict.providers.Facet;
		let tmpState = tmpProvider.group(pGroupHash);
		let tmpDescribed = tmpState ? this._described(tmpState, pScope) : null;
		let tmpDeclared = (tmpDescribed && tmpDescribed.Params) ? tmpDescribed.Params[pParam] : null;
		if (!tmpDeclared || !Array.isArray(tmpDeclared.Values) || (typeof(tmpDeclared.Values[pValueIndex]) === 'undefined'))
		{
			return false;
		}
		let tmpEntry = tmpState.ScopeState[pScope] || { On: true, Params: {} };
		let tmpParams = libFacetSelection.cloneJSON(tmpEntry.Params || {});
		let tmpChosen = Array.isArray(tmpParams[pParam]) ? tmpParams[pParam] : [];
		let tmpValue = tmpDeclared.Values[pValueIndex];
		let tmpPicked = tmpChosen.some((pChosen) => { return libFacetSelection.sameKey(pChosen, tmpValue); });
		let tmpNext = tmpPicked ? tmpChosen.filter((pChosen) => { return !libFacetSelection.sameKey(pChosen, tmpValue); }) : tmpChosen.concat([ tmpValue ]);
		// Declared order, so the same set always sends the same body (and hits the same Version).
		tmpParams[pParam] = tmpDeclared.Values.filter((pDeclared) => { return tmpNext.some((pChosen) => { return libFacetSelection.sameKey(pChosen, pDeclared); }); });
		return tmpProvider.setScope(pGroupHash, pScope, true, tmpParams);
	}

	onAfterRender(pRenderable, pRenderDestinationAddress, pRecord, pContent)
	{
		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pRenderDestinationAddress, pRecord, pContent);
	}
}

module.exports = PictViewFacetScope;
module.exports.default_configuration = _ViewConfiguration;
