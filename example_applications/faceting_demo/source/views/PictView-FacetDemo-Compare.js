/**
 * FacetDemo-Compare -- E3 variant A vs variant B, form type by form type (DEMO-SPEC §6.3, §7.9).  Demo-specific
 * (not lifted).
 *
 * The two variants ask the same question from two sources of truth: A counts stored MaterialIntakeRequirement
 * rows (LabFormsA.ToDo, CountMode Rows); B derives (intake, form type) pairs from the material-type
 * configuration, MaterialTypeFormRequirement (LabFormsB.ToDo, a TuplePivot, CountMode KeyDistinct).  They agree
 * wherever the stored rows match the configuration, and the panel leads with that agreement:
 *
 *   In both          A − stored-only  (= B − configured-only): the pairs both variants count
 *   Stored only (A)  A's work-list rows whose (material type, form type) no Required configuration row asks for
 *                    (read from A's list rows, the intakes' material types and the configuration rows)
 *   Configured only  B − in both: configured pairs with no live stored requirement row (TuplePivot records are
 *   (B)              not listable yet, so this column is computed, not listed)
 *
 * The seed plants both kinds of mismatch on purpose (random extra forms on intakes whose type requires fewer
 * than three; soft-deleted requirement rows), and the callout above the table says so with the counts.
 *
 * Data: preparePanel() (never renderPanel) fetches what the breakdown needs once per (principal, A answer,
 * B answer): every A list row (provider.fetchAllRecords: POST …/ToDoForMe/Records/0/500), the material type of
 * those intakes and the Required configuration rows (provider.fetchLookup).  They show in the inspector as Lookup
 * exchanges.  The A column uses the LabFormsA envelope only while variant A has no selections (otherwise:
 * "Clear the variant A filters to compare like for like" + a Clear button).  Both groups are loaded by the
 * application's loadPage (the LabForms page refreshes both); this view never refreshes a group.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libPictView = require('pict-view');

const libFacetDisplay = require('../providers/Facet-Display.js');
const libFacetLookup = require('../providers/Facet-Lookup.js');

const VIEW_IDENTIFIER = 'FacetDemo-Compare';

const NOTE = 'A = stored MaterialIntakeRequirement rows (counts rows). B = distinct (intake, form type) pairs implied by MaterialTypeFormRequirement (counts KeyDistinct tuples). "Stored only" is counted from A\'s list rows checked against the Required configuration; "Configured only" is B minus the shared pairs.';

const _ViewConfiguration =
	{
		ViewIdentifier: VIEW_IDENTIFIER,
		DefaultRenderable: 'FacetDemo-Compare-Panel',
		DefaultDestinationAddress: '#FD-Main',
		AutoRender: false,

		CSS: /*css*/`
			.fd-compare-callout { display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px; margin-bottom: 12px; border-radius: var(--fd-radius-sm, 6px);
				background: var(--fd-info-soft, #e7f1fb); color: var(--fd-text, #1b2230); font-size: 12.5px; line-height: 1.5; }
			.fd-compare-callout .pict-icon { flex: 0 0 auto; margin-top: 2px; color: var(--fd-info, #1c64b0); }
			.fd-compare-headline { font-size: 14px; font-weight: 600; }
			.fd-compare-table-wrap { overflow-x: auto; }
			.fd-compare-table { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
			.fd-compare-table th { text-align: left; font-weight: 600; color: var(--fd-text-muted, #5d6878); padding: 6px 10px; border-bottom: 1px solid var(--fd-border, #dfe3e9); white-space: nowrap; }
			.fd-compare-table td { padding: 6px 10px; border-bottom: 1px solid var(--fd-border, #dfe3e9); white-space: nowrap; }
			.fd-compare-table .fd-num { text-align: right; }
			.fd-compare-table .fd-both { font-weight: 600; color: var(--fd-text, #1b2230); }
			.fd-compare-table tfoot td { font-weight: 700; border-bottom: 0; border-top: 2px solid var(--fd-border-strong, #c5ccd6); }
			.fd-compare-agree { display: inline-flex; align-items: center; gap: 4px; color: var(--fd-ok, #2b8a3e); font-weight: 600; }
			.fd-compare-off { color: var(--fd-warn, #a8620a); }
			.fd-compare-zero { color: var(--fd-text-faint, #8a94a3); }
			.fd-compare-note { margin-top: 10px; font-size: 11.5px; line-height: 1.5; color: var(--fd-text-faint, #8a94a3); }
			.fd-compare-needs { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 12px; margin-bottom: 10px; border-radius: var(--fd-radius-sm, 6px);
				background: var(--fd-warn-soft, #fdf3e1); color: var(--fd-warn, #a8620a); font-size: 12px; }
			.fd-compare-muted { color: var(--fd-text-faint, #8a94a3); }
		`,

		Templates:
			[
				{
					Hash: 'FacetDemo-Compare-Panel-Template',
					Template: /*html*/`
<div class="facet-card fd-compare {~D:Record.CardClass~}">
	<header class="facet-card-head">
		<h3 class="facet-card-title">{~D:Record.Title~}</h3>
		<span class="facet-card-badges">{~TS:Facet-Badge-Template:Record.Badges~}</span>
	</header>
	{~TS:FacetDemo-Compare-Needs-Clear-Template:Record.NeedsClearSlot~}
	{~TS:FacetDemo-Compare-Callout-Template:Record.CalloutSlot~}
	{~TS:Facet-Unavailable-Template:Record.UnavailableSlot~}
	{~TS:Facet-Empty-Template:Record.EmptySlot~}
	{~TS:FacetDemo-Compare-Table-Template:Record.TableSlot~}
	<div class="fd-compare-note">{~D:Record.Note~}</div>
</div>`
				},
				{
					Hash: 'FacetDemo-Compare-Needs-Clear-Template',
					Template: /*html*/`<div class="fd-compare-needs">{~I:Info~} Clear the variant A filters to compare like for like. <button type="button" class="facet-btn" onclick="{~P~}.views['{~D:Record.ViewHash~}'].clearVariantA()">Clear variant A filters</button></div>`
				},
				{
					Hash: 'FacetDemo-Compare-Callout-Template',
					Template: /*html*/`<div class="fd-compare-callout" role="note">{~I:Info~}<div><div class="fd-compare-headline">{~D:Record.Headline~}</div><div>{~D:Record.Text~}</div></div></div>`
				},
				{
					Hash: 'FacetDemo-Compare-Table-Template',
					Template: /*html*/`
<div class="fd-compare-table-wrap">
	<table class="fd-compare-table">
		<thead><tr><th>Form type</th><th class="fd-num" title="Pairs both variants count">In both</th><th class="fd-num" title="Stored requirement rows no Required configuration row asks for">Stored only (A)</th><th class="fd-num" title="Configured pairs with no live stored requirement row: B minus In both">Configured only (B)</th><th class="fd-num">A · stored</th><th class="fd-num">B · implied</th><th></th></tr></thead>
		<tbody>{~TS:FacetDemo-Compare-Row-Template:Record.Rows~}</tbody>
		<tfoot><tr><td>Total</td><td class="fd-num">{~D:Record.Both~}</td><td class="fd-num">{~D:Record.AOnly~}</td><td class="fd-num">{~D:Record.BOnly~}</td><td class="fd-num">{~D:Record.A~}</td><td class="fd-num">{~D:Record.B~}</td><td></td></tr></tfoot>
	</table>
</div>`
				},
				{
					Hash: 'FacetDemo-Compare-Row-Template',
					Template: /*html*/`<tr><td class="{~D:Record.LabelClass~}">{~D:Record.Label~}</td><td class="fd-num fd-both">{~D:Record.Both~}</td><td class="fd-num {~D:Record.AOnlyClass~}">{~D:Record.AOnly~}</td><td class="fd-num {~D:Record.BOnlyClass~}">{~D:Record.BOnly~}</td><td class="fd-num">{~D:Record.A~}</td><td class="fd-num">{~D:Record.B~}</td><td>{~TS:FacetDemo-Compare-Agree-Template:Record.AgreeSlot~}</td></tr>`
				},
				{
					Hash: 'FacetDemo-Compare-Agree-Template',
					Template: /*html*/`<span class="fd-compare-agree" title="A and B count exactly the same pairs">{~I:Check~} same</span>`
				}
			],

		Renderables:
			[
				{
					RenderableHash: 'FacetDemo-Compare-Panel',
					TemplateHash: 'FacetDemo-Compare-Panel-Template',
					ContentDestinationAddress: '#FD-Main',
					RenderMethod: 'replace'
				}
			]
	};

class PictViewFacetDemoCompare extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this._LastPanel = null;
	}

	/**
	 * @param {Record<string, any>} pPanel
	 * @return {{ A: Record<string, any>|null, B: Record<string, any>|null }}
	 */
	_states(pPanel)
	{
		let tmpProvider = this.pict.providers.Facet;
		return { A: tmpProvider.group(pPanel.CompareGroup || 'LabFormsA'), B: tmpProvider.group(pPanel.Group) };
	}

	/**
	 * @param {Record<string, any>} pState
	 * @return {boolean}
	 */
	_hasSelections(pState)
	{
		return Object.keys(pState.Selections || {}).some((pKey) => { return !!pState.Selections[pKey]; });
	}

	/**
	 * Fetch what the breakdown needs (see the header), once per (principal, A answer, B answer).
	 *
	 * @param {Record<string, any>} pPanel
	 */
	preparePanel(pPanel)
	{
		let tmpProvider = this.pict.providers.Facet;
		let tmpStates = this._states(pPanel);
		let tmpA = tmpStates.A;
		let tmpB = tmpStates.B;
		let tmpPrincipal = tmpProvider.principalKey();
		if (!tmpA || !tmpB || (tmpA.Status !== 'Ready') || (tmpB.Status !== 'Ready') || (tmpA.PrincipalKey !== tmpPrincipal) || (tmpB.PrincipalKey !== tmpPrincipal) || this._hasSelections(tmpA))
		{
			return;
		}
		let tmpKey = `${tmpPrincipal}|${tmpA.AnswerSeq}|${tmpB.AnswerSeq}`;
		let tmpCurrent = this.pict.AppData.FacetDemo.CompareBreakdown;
		if (tmpCurrent && (tmpCurrent.Key === tmpKey))
		{
			return;
		}
		let tmpBreakdown = { Key: tmpKey, Status: 'Loading', AOnly: {}, Rows: 0, Error: null };
		this.pict.AppData.FacetDemo.CompareBreakdown = tmpBreakdown;
		let tmpDomain = tmpA.Domain;
		let fDone = (pError) =>
		{
			if (this.pict.AppData.FacetDemo.CompareBreakdown !== tmpBreakdown)
			{
				return;
			}
			if (pError)
			{
				tmpBreakdown.Status = 'Error';
				tmpBreakdown.Error = pError.message;
			}
			let tmpPageView = this.pict.views['FacetDemo-Page'];
			if (tmpPageView)
			{
				tmpPageView.renderPanels({ Widgets: [ 'Compare' ] });
			}
		};
		tmpProvider.fetchAllRecords(tmpA.Hash,
			(pRowsError, pRows) =>
			{
				if (pRowsError)
				{
					return fDone(pRowsError);
				}
				let tmpRows = pRows || [];
				let tmpIntakes = libFacetLookup.keysOf(tmpRows, 'IDMaterialIntake');
				tmpProvider.fetchLookup(tmpDomain, 'MaterialIntake', 'IDMaterialIntake', tmpIntakes, { GroupHash: tmpB.Hash },
					(pIntakeError) =>
					{
						if (pIntakeError)
						{
							return fDone(pIntakeError);
						}
						tmpProvider.fetchLookup(tmpDomain, 'MaterialTypeFormRequirement', 'Required', [ 1 ], { GroupHash: tmpB.Hash },
							(pConfigurationError) =>
							{
								if (pConfigurationError)
								{
									return fDone(pConfigurationError);
								}
								let tmpConfigured = {};
								(tmpProvider.lookupRows(tmpDomain, 'MaterialTypeFormRequirement', 'Required', 1) || []).forEach(
									(pRequirement) =>
									{
										tmpConfigured[`${pRequirement.IDMaterialType}|${pRequirement.IDLabFormType}`] = true;
									});
								tmpRows.forEach(
									(pRow) =>
									{
										let tmpIntake = (tmpProvider.lookupRows(tmpDomain, 'MaterialIntake', 'IDMaterialIntake', pRow.IDMaterialIntake) || [])[0] || null;
										let tmpType = tmpIntake ? tmpIntake.IDMaterialType : null;
										if (!tmpConfigured[`${tmpType}|${pRow.IDLabFormType}`])
										{
											let tmpForm = String(pRow.IDLabFormType);
											tmpBreakdown.AOnly[tmpForm] = (tmpBreakdown.AOnly[tmpForm] || 0) + 1;
										}
									});
								tmpBreakdown.Rows = tmpRows.length;
								tmpBreakdown.Status = 'Ready';
								return fDone(null);
							});
					});
			});
	}

	/**
	 * @param {Record<string, any>} pPanel - layout entry + PanelID (Group = B, CompareGroup = A)
	 */
	renderPanel(pPanel)
	{
		let tmpProvider = this.pict.providers.Facet;
		let tmpStates = this._states(pPanel);
		let tmpStateA = tmpStates.A;
		let tmpStateB = tmpStates.B;
		if (!tmpStateB || !tmpStateA)
		{
			return;
		}
		this._LastPanel = pPanel;
		let tmpKeyB = pPanel.FacetKey || 'ToDo';
		let tmpKeyA = pPanel.CompareFacetKey || tmpKeyB;
		let tmpFacetB = (tmpStateB.Envelope && tmpStateB.Envelope.Facets) ? tmpStateB.Envelope.Facets[tmpKeyB] : null;
		let tmpFacetA = (tmpStateA.Envelope && tmpStateA.Envelope.Facets) ? tmpStateA.Envelope.Facets[tmpKeyA] : null;
		let tmpASelected = this._hasSelections(tmpStateA);
		let tmpBreakdown = this.pict.AppData.FacetDemo.CompareBreakdown;
		let tmpKey = `${tmpProvider.principalKey()}|${tmpStateA.AnswerSeq}|${tmpStateB.AnswerSeq}`;
		let tmpReady = !!tmpBreakdown && (tmpBreakdown.Key === tmpKey) && (tmpBreakdown.Status === 'Ready');
		let tmpModel =
			{
				ViewHash: VIEW_IDENTIFIER,
				Title: libFacetDisplay.text(pPanel.Title || 'Variant A and variant B'),
				CardClass: ((tmpStateA.Status === 'Loading') || (tmpStateB.Status === 'Loading')) ? 'facet-loading-dim' : '',
				Badges: tmpProvider.showInternals() ? [ { Text: 'A: Rows', Tone: 'internal', Tip: 'A counts stored requirement rows.' }, { Text: 'B: KeyDistinct', Tone: 'internal', Tip: libFacetDisplay.text('B counts distinct (intake, form type) tuples.') } ] : [],
				NeedsClearSlot: [],
				CalloutSlot: [],
				UnavailableSlot: [],
				EmptySlot: [],
				TableSlot: [],
				Note: libFacetDisplay.text(NOTE)
			};

		if (tmpASelected)
		{
			tmpModel.NeedsClearSlot = [ { ViewHash: VIEW_IDENTIFIER } ];
		}
		if (!tmpFacetB || (!tmpASelected && !tmpFacetA))
		{
			let tmpErrored = (tmpStateB.Status === 'Error') || (tmpStateA.Status === 'Error');
			tmpModel.UnavailableSlot = [ { Text: tmpErrored ? 'Unavailable' : 'Loading…' } ];
		}
		else if (!tmpASelected)
		{
			let tmpRows = {};
			let fAdd = (pFacet, pColumn) =>
			{
				(Array.isArray(pFacet.Buckets) ? pFacet.Buckets : []).forEach(
					(pBucket) =>
					{
						let tmpRowKey = String(pBucket.Key);
						if (!tmpRows[tmpRowKey])
						{
							let tmpLabel = libFacetDisplay.bucketLabel(pFacet, pBucket);
							tmpRows[tmpRowKey] = { Key: tmpRowKey, Label: tmpLabel.Text, LabelClass: tmpLabel.Muted ? 'fd-compare-muted' : '', A: 0, B: 0 };
						}
						else if (tmpRows[tmpRowKey].LabelClass && (pBucket.LabelResolved !== false))
						{
							let tmpLabel = libFacetDisplay.bucketLabel(pFacet, pBucket);
							tmpRows[tmpRowKey].Label = tmpLabel.Text;
							tmpRows[tmpRowKey].LabelClass = tmpLabel.Muted ? 'fd-compare-muted' : '';
						}
						tmpRows[tmpRowKey][pColumn] += (typeof(pBucket.Count) === 'number') ? pBucket.Count : 0;
					});
			};
			fAdd(tmpFacetA, 'A');
			fAdd(tmpFacetB, 'B');
			let tmpList = Object.keys(tmpRows).map(
				(pKey) =>
				{
					let tmpRow = tmpRows[pKey];
					tmpRow.AOnly = tmpReady ? (tmpBreakdown.AOnly[pKey] || 0) : null;
					tmpRow.Both = tmpReady ? (tmpRow.A - tmpRow.AOnly) : null;
					tmpRow.BOnly = tmpReady ? (tmpRow.B - tmpRow.Both) : null;
					tmpRow.Same = tmpReady ? ((tmpRow.AOnly === 0) && (tmpRow.BOnly === 0)) : (tmpRow.A === tmpRow.B);
					return tmpRow;
				});
			// The agreement first (the rows both variants count identically), then the mismatches, largest first.
			tmpList.sort((pLeft, pRight) => { return ((pRight.Same ? 1 : 0) - (pLeft.Same ? 1 : 0)) || ((pLeft.Same ? 0 : (((pRight.AOnly || 0) + (pRight.BOnly || 0)) - ((pLeft.AOnly || 0) + (pLeft.BOnly || 0))))) || (pRight.A - pLeft.A) || String(pLeft.Label).localeCompare(String(pRight.Label)); });
			if (tmpList.length < 1)
			{
				tmpModel.EmptySlot = [ { Text: 'No forms to do for this user in either variant' } ];
			}
			else
			{
				let tmpTotalA = (tmpStateA.Envelope && (typeof(tmpStateA.Envelope.Total) === 'number')) ? tmpStateA.Envelope.Total : tmpFacetA.Total;
				let tmpTotalB = (typeof(tmpFacetB.Total) === 'number') ? tmpFacetB.Total : 0;
				let tmpAOnly = tmpReady ? tmpList.reduce((pSum, pRow) => { return pSum + pRow.AOnly; }, 0) : null;
				let tmpBoth = tmpReady ? (tmpTotalA - tmpAOnly) : null;
				let tmpBOnly = tmpReady ? (tmpTotalB - tmpBoth) : null;
				let tmpSame = tmpList.filter((pRow) => { return pRow.Same; }).length;
				let fCell = (pValue) => { return (typeof(pValue) === 'number') ? libFacetDisplay.count(pValue) : '…'; };
				let fClass = (pValue) => { return (typeof(pValue) !== 'number') ? 'fd-compare-zero' : ((pValue === 0) ? 'fd-compare-zero' : 'fd-compare-off'); };
				if (tmpReady)
				{
					tmpModel.CalloutSlot =
						[
							{
								Headline: libFacetDisplay.text(`${libFacetDisplay.count(tmpBoth)} forms to do in both variants; ${tmpSame} of ${tmpList.length} form types match exactly.`),
								Text: libFacetDisplay.text(`The rest is the seed's planted mismatches, nothing else: A adds ${libFacetDisplay.count(tmpAOnly)} stored requirement${(tmpAOnly === 1) ? '' : 's'} that no material-type configuration asks for (random extra forms on intakes whose type requires fewer than three), and B adds ${libFacetDisplay.count(tmpBOnly)} configured pair${(tmpBOnly === 1) ? '' : 's'} whose stored requirement row is gone (soft-deleted). ${libFacetDisplay.count(tmpTotalA)} − ${libFacetDisplay.count(tmpAOnly)} = ${libFacetDisplay.count(tmpTotalB)} − ${libFacetDisplay.count(tmpBOnly)}.`)
							}
						];
				}
				else
				{
					let tmpFailed = !!tmpBreakdown && (tmpBreakdown.Key === tmpKey) && (tmpBreakdown.Status === 'Error');
					tmpModel.CalloutSlot = [ { Headline: libFacetDisplay.text(tmpFailed ? 'Could not check which pairs the variants share' : 'Checking which pairs the two variants share…'), Text: libFacetDisplay.text(tmpFailed ? tmpBreakdown.Error : 'Reading variant A\'s work list and the material-type configuration (Lookup exchanges in the inspector).') } ];
				}
				tmpModel.TableSlot =
					[
						{
							Rows: tmpList.map(
								(pRow) =>
								{
									return (
										{
											Label: pRow.Label,
											LabelClass: pRow.LabelClass,
											Both: fCell(pRow.Both),
											AOnly: fCell(pRow.AOnly),
											AOnlyClass: fClass(pRow.AOnly),
											BOnly: fCell(pRow.BOnly),
											BOnlyClass: fClass(pRow.BOnly),
											A: libFacetDisplay.count(pRow.A),
											B: libFacetDisplay.count(pRow.B),
											AgreeSlot: (tmpReady && pRow.Same) ? [ {} ] : []
										});
								}),
							Both: fCell(tmpBoth),
							AOnly: fCell(tmpAOnly),
							BOnly: fCell(tmpBOnly),
							A: libFacetDisplay.count(tmpTotalA),
							B: libFacetDisplay.count(tmpTotalB)
						}
					];
			}
		}

		tmpStateB.Widgets.Compare = tmpModel;
		this.render('FacetDemo-Compare-Panel', `#${pPanel.PanelID}`, `AppData.Facet.Groups.${pPanel.Group}.Widgets.Compare`);
	}

	/**
	 * Inline handler: clear variant A's selections (then refresh A).
	 */
	clearVariantA()
	{
		let tmpCompareGroup = (this._LastPanel && this._LastPanel.CompareGroup) ? this._LastPanel.CompareGroup : 'LabFormsA';
		return this.pict.providers.Facet.clearSelections(tmpCompareGroup);
	}

	onAfterRender(pRenderable, pRenderDestinationAddress, pRecord, pContent)
	{
		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pRenderDestinationAddress, pRecord, pContent);
	}
}

module.exports = PictViewFacetDemoCompare;
module.exports.default_configuration = _ViewConfiguration;
