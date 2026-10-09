/**
 * Facet-Pivot -- a 2-D Pivot grid (DEMO-SPEC §7.6).  Liftable.
 *
 * Rows = FacetResult.RowKeys, columns = ColumnKeys, cells from Cells[] ({ K1, K2, Count }), marginals from
 * Marginals.Rows / .Columns / .Total.  Header labels come from the 1-D facets named by the panel
 * (RowFacet / ColumnFacet: their buckets' Labels, e.g. client 9 -> "Iris Media"), else the raw key.
 * Cell shading: rgba(var(--facet-heat), 0.08 + 0.6 × Count / max).  Zero cells show a faint dot.
 * Pivot buckets carry no Clause; a cell click writes back the two 1-D facets' own bucket Clauses
 * (Facet-Selection.pivotCellSelections -> provider.setSelections, one POST); row / column header clicks
 * select just that facet's key.  Without both 1-D facets in the envelope the grid is display-only.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libPictView = require('pict-view');

const libFacetSelection = require('../providers/Facet-Selection.js');
const libFacetDisplay = require('../providers/Facet-Display.js');

const VIEW_IDENTIFIER = 'Facet-Pivot';

const _ViewConfiguration =
	{
		ViewIdentifier: VIEW_IDENTIFIER,
		DefaultRenderable: 'Facet-Pivot-Panel',
		DefaultDestinationAddress: '#FD-Main',
		AutoRender: false,

		CSS: /*css*/`
			.facet-pivot-wrap { overflow-x: auto; }
			.facet-pivot { border-collapse: separate; border-spacing: 3px; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--facet-text, #1b2230); }
			.facet-pivot th, .facet-pivot td { padding: 0; text-align: center; vertical-align: middle; }
			.facet-pivot-corner { padding: 4px 10px 4px 0; text-align: left; white-space: nowrap; font-weight: 500; color: var(--facet-text-faint, #8a94a3); }
			.facet-pivot-head { white-space: nowrap; font-weight: 600; }
			.facet-pivot-rowhead { text-align: left; }
			.facet-pivot-head-btn { display: inline-block; max-width: 180px; overflow: hidden; text-overflow: ellipsis; padding: 4px 8px; margin: 0; border: 0; border-bottom: 2px solid transparent;
				border-radius: 4px 4px 0 0; background: none; font: inherit; color: inherit; cursor: pointer; transition: background-color 100ms, color 100ms; }
			.facet-pivot-head-btn:hover { background: var(--facet-surface-2, #f0f2f5); color: var(--facet-accent, #3b5bdb); }
			.facet-pivot-head-btn:focus-visible { outline: 2px solid var(--facet-accent, #3b5bdb); outline-offset: 1px; }
			.facet-pivot-head-static { display: inline-block; padding: 4px 8px; border-bottom: 2px solid transparent; }
			.facet-pivot-head-selected .facet-pivot-head-btn, .facet-pivot-head-selected .facet-pivot-head-static { border-bottom-color: var(--facet-accent, #3b5bdb); color: var(--facet-accent, #3b5bdb); }
			.facet-pivot-cell { min-width: 64px; border-radius: 6px; }
			.facet-pivot-cell-btn { display: block; width: 100%; min-height: 34px; margin: 0; padding: 0 10px; border: 1px solid transparent; border-radius: 6px; background: transparent;
				font: inherit; font-weight: 600; color: inherit; cursor: pointer; transition: border-color 100ms; }
			.facet-pivot-cell-btn:hover { border-color: var(--facet-accent, #3b5bdb); }
			.facet-pivot-cell-btn:focus-visible { outline: 2px solid var(--facet-accent, #3b5bdb); outline-offset: 1px; }
			.facet-pivot-cell-static { display: flex; align-items: center; justify-content: center; min-height: 34px; padding: 0 10px; font-weight: 600; }
			.facet-pivot-zero .facet-pivot-cell-btn, .facet-pivot-zero .facet-pivot-cell-static { font-weight: 400; color: var(--facet-text-faint, #8a94a3); }
			.facet-pivot-marginal { padding: 4px 10px; border-radius: 6px; background: var(--facet-surface-2, #f0f2f5); color: var(--facet-text-muted, #5d6878); }
			.facet-pivot-total-head { padding: 4px 8px; font-weight: 500; color: var(--facet-text-faint, #8a94a3); white-space: nowrap; }
			.facet-pivot-grand { padding: 4px 10px; border-radius: 6px; background: var(--facet-surface-2, #f0f2f5); font-weight: 700; }
		`,

		Templates:
			[
				{
					Hash: 'Facet-Pivot-Panel-Template',
					Template: /*html*/`
<div class="facet-card facet-pivot-card {~D:Record.CardClass~}">
	<header class="facet-card-head">
		<h3 class="facet-card-title">{~D:Record.Title~}</h3>
		<span class="facet-card-badges">{~TS:Facet-Badge-Template:Record.Badges~}</span>
	</header>
	{~TS:Facet-Unavailable-Template:Record.UnavailableSlot~}
	{~TS:Facet-Inline-Error-Template:Record.ErrorSlot~}
	{~TS:Facet-Empty-Template:Record.EmptySlot~}
	{~TS:Facet-Pivot-Grid-Template:Record.GridSlot~}
	{~TS:Facet-Footer-Template:Record.FooterSlot~}
</div>`
				},
				{
					Hash: 'Facet-Pivot-Grid-Template',
					Template: /*html*/`
<div class="facet-pivot-wrap">
	<table class="facet-pivot">
		<thead>
			<tr>
				<th class="facet-pivot-corner" scope="col">{~D:Record.Corner~}</th>
				{~TS:Facet-Pivot-Column-Header-Template:Record.ColumnHeaders~}
				<th class="facet-pivot-total-head" scope="col">Total</th>
			</tr>
		</thead>
		<tbody>{~TS:Facet-Pivot-Row-Template:Record.Rows~}</tbody>
		<tfoot>
			<tr>
				<th class="facet-pivot-total-head facet-pivot-rowhead" scope="row">Total</th>
				{~TS:Facet-Pivot-Column-Total-Template:Record.ColumnTotals~}
				<td class="facet-pivot-grand" title="Pivot Total">{~D:Record.GrandTotal~}</td>
			</tr>
		</tfoot>
	</table>
</div>`
				},
				{
					Hash: 'Facet-Pivot-Column-Header-Template',
					Template: /*html*/`<th class="facet-pivot-head {~D:Record.HeaderClass~}" scope="col">{~TS:Facet-Pivot-Header-Button-Template:Record.ClickableSlot~}{~TS:Facet-Pivot-Header-Static-Template:Record.StaticSlot~}</th>`
				},
				{
					Hash: 'Facet-Pivot-Row-Template',
					Template: /*html*/`<tr>{~TS:Facet-Pivot-Row-Header-Template:Record.HeaderSlot~}{~TS:Facet-Pivot-Cell-Template:Record.Cells~}<td class="facet-pivot-marginal">{~D:Record.TotalText~}</td></tr>`
				},
				{
					Hash: 'Facet-Pivot-Row-Header-Template',
					Template: /*html*/`<th class="facet-pivot-head facet-pivot-rowhead {~D:Record.HeaderClass~}" scope="row">{~TS:Facet-Pivot-Header-Button-Template:Record.ClickableSlot~}{~TS:Facet-Pivot-Header-Static-Template:Record.StaticSlot~}</th>`
				},
				{
					Hash: 'Facet-Pivot-Header-Button-Template',
					Template: /*html*/`<button type="button" class="facet-pivot-head-btn {~D:Record.LabelClass~}" title="{~D:Record.Tip~}" data-focus-key="head-{~D:Record.Axis~}-{~D:Record.Index~}" onclick="{~P~}.views['{~D:Record.ViewHash~}'].pickHeader('{~D:Record.Group~}', '{~D:Record.Key~}', '{~D:Record.Axis~}', {~D:Record.Index~})">{~D:Record.LabelText~}</button>`
				},
				{
					Hash: 'Facet-Pivot-Header-Static-Template',
					Template: /*html*/`<span class="facet-pivot-head-static {~D:Record.LabelClass~}" title="{~D:Record.Tip~}">{~D:Record.LabelText~}</span>`
				},
				{
					Hash: 'Facet-Pivot-Cell-Template',
					Template: /*html*/`<td class="facet-pivot-cell {~D:Record.CellClass~}" style="background-color: rgba(var(--facet-heat, 59, 91, 219), {~D:Record.HeatAlpha~})">{~TS:Facet-Pivot-Cell-Button-Template:Record.ClickableSlot~}{~TS:Facet-Pivot-Cell-Static-Template:Record.StaticSlot~}</td>`
				},
				{
					Hash: 'Facet-Pivot-Cell-Button-Template',
					Template: /*html*/`<button type="button" class="facet-pivot-cell-btn" aria-label="{~D:Record.Aria~}" title="{~D:Record.Aria~}" data-focus-key="cell-{~D:Record.RowIndex~}-{~D:Record.ColumnIndex~}" onclick="{~P~}.views['{~D:Record.ViewHash~}'].pickCell('{~D:Record.Group~}', '{~D:Record.Key~}', {~D:Record.RowIndex~}, {~D:Record.ColumnIndex~})">{~D:Record.Text~}</button>`
				},
				{
					Hash: 'Facet-Pivot-Cell-Static-Template',
					Template: /*html*/`<span class="facet-pivot-cell-static" title="{~D:Record.Aria~}">{~D:Record.Text~}</span>`
				},
				{
					Hash: 'Facet-Pivot-Column-Total-Template',
					Template: /*html*/`<td class="facet-pivot-marginal">{~D:Record.Text~}</td>`
				}
			],

		Renderables:
			[
				{
					RenderableHash: 'Facet-Pivot-Panel',
					TemplateHash: 'Facet-Pivot-Panel-Template',
					ContentDestinationAddress: '#FD-Main',
					RenderMethod: 'replace'
				}
			]
	};

class PictViewFacetPivot extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this._Panels = {};
	}

	/**
	 * The bucket of a 1-D facet for a key (sameKey: 9 and '9' match).
	 *
	 * @param {Record<string, any>|null} pFacet
	 * @param {any} pKey
	 * @return {Record<string, any>|null}
	 */
	_bucket(pFacet, pKey)
	{
		let tmpBuckets = (pFacet && Array.isArray(pFacet.Buckets)) ? pFacet.Buckets : [];
		for (let i = 0; i < tmpBuckets.length; i++)
		{
			if (libFacetSelection.sameKey(tmpBuckets[i].Key, pKey))
			{
				return tmpBuckets[i];
			}
		}
		return null;
	}

	/**
	 * A row or column header record.
	 *
	 * @param {Record<string, any>} pBase
	 * @param {string} pAxis - 'Row' | 'Column'
	 * @param {number} pIndex
	 * @param {any} pKey
	 * @param {Record<string, any>|null} pAxisFacet - the 1-D facet the axis is drawn from
	 * @return {Record<string, any>}
	 */
	_header(pBase, pAxis, pIndex, pKey, pAxisFacet, pKeyNoun)
	{
		let tmpBucket = this._bucket(pAxisFacet, pKey);
		let tmpLabel = tmpBucket ? libFacetDisplay.bucketLabel(pAxisFacet, tmpBucket, { KeyNoun: pKeyNoun }) : libFacetDisplay.bucketLabel(null, { Key: pKey, Label: (pKey === null) ? null : String(pKey) });
		let tmpClickable = !!tmpBucket && libFacetSelection.isSelectable(pAxisFacet, tmpBucket);
		let tmpHeader = Object.assign({}, pBase,
			{
				Axis: pAxis,
				Index: pIndex,
				LabelText: tmpLabel.Text,
				LabelClass: `${tmpLabel.Muted ? 'facet-label-muted' : ''} ${tmpLabel.Blank ? 'facet-label-blank' : ''}`.trim(),
				HeaderClass: (tmpBucket && (tmpBucket.Selected === true)) ? 'facet-pivot-head-selected' : '',
				Tip: tmpLabel.Unresolved ? tmpLabel.Tip : libFacetDisplay.text(`Select only ${tmpBucket ? (tmpBucket.Label || tmpBucket.Key) : pKey}`),
				ClickableSlot: [],
				StaticSlot: []
			});
		if (tmpClickable)
		{
			tmpHeader.ClickableSlot = [ Object.assign({}, tmpHeader, { ClickableSlot: [], StaticSlot: [] }) ];
		}
		else
		{
			tmpHeader.StaticSlot = [ Object.assign({}, tmpHeader, { ClickableSlot: [], StaticSlot: [] }) ];
		}
		return tmpHeader;
	}

	/**
	 * @param {Record<string, any>} pPanel - layout entry + PanelID
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
		let tmpFacets = (tmpEnvelope && tmpEnvelope.Facets) ? tmpEnvelope.Facets : {};
		let tmpFacet = tmpFacets[tmpKey] || null;
		let tmpFacetError = (tmpEnvelope && tmpEnvelope.Errors) ? (tmpEnvelope.Errors[tmpKey] || null) : null;
		let tmpRowFacet = pPanel.RowFacet ? (tmpFacets[pPanel.RowFacet] || null) : null;
		let tmpColumnFacet = pPanel.ColumnFacet ? (tmpFacets[pPanel.ColumnFacet] || null) : null;
		let tmpBase = { ViewHash: VIEW_IDENTIFIER, Group: pPanel.Group, Key: tmpKey };

		let tmpModel =
			{
				ViewHash: VIEW_IDENTIFIER,
				Group: pPanel.Group,
				Key: tmpKey,
				Title: libFacetDisplay.text(pPanel.Title || (tmpFacet ? tmpFacet.DisplayName : tmpKey)),
				CardClass: (tmpState.Status === 'Loading') ? 'facet-loading-dim' : '',
				Badges: [],
				UnavailableSlot: [],
				ErrorSlot: [],
				EmptySlot: [],
				GridSlot: [],
				FooterSlot: []
			};

		if (tmpFacetError)
		{
			tmpModel.ErrorSlot = [ { Code: libFacetDisplay.text(tmpFacetError.Code), Status: libFacetDisplay.text(tmpFacetError.Status), Message: libFacetDisplay.text(tmpFacetError.Message), SuggestSlot: [] } ];
		}
		else if (!tmpFacet)
		{
			tmpModel.UnavailableSlot = [ { Text: (tmpState.Status === 'Error') ? 'Unavailable' : (tmpEnvelope ? 'Not in this answer' : 'Loading…') } ];
		}
		else
		{
			let tmpInteractive = !!tmpRowFacet && !!tmpColumnFacet;
			tmpModel.Badges = [];
			if (this.pict.providers.Facet.showInternals())
			{
				tmpModel.Badges.push({ Text: 'Pivot', Tone: 'internal', Tip: libFacetDisplay.text('Fold: Pivot. Cells write back the two 1-D facets\' own bucket Clauses (one POST).') });
			}
			if (!tmpInteractive)
			{
				tmpModel.Badges.push({ Text: 'Read-only', Tone: 'muted', Tip: libFacetDisplay.text(libFacetDisplay.SELECTION_ONLY_TIP) });
			}
			if (tmpFacet.Truncated === true)
			{
				tmpModel.Badges.push({ Text: 'Truncated', Tone: 'neutral', Tip: libFacetDisplay.text('Some keys were cut by Top; OtherCount holds the rest.') });
			}
			this._buildGrid(tmpModel, tmpFacet, tmpRowFacet, tmpColumnFacet, pPanel, tmpBase, tmpEnvelope);
			tmpModel.FooterSlot = libFacetDisplay.facetFooter(tmpFacet, pPanel.Noun);
		}

		tmpState.Widgets[tmpKey] = tmpModel;
		let tmpFocus = this.pict.providers.Facet.captureFocus(pPanel.PanelID);
		this.render('Facet-Pivot-Panel', `#${pPanel.PanelID}`, `AppData.Facet.Groups.${pPanel.Group}.Widgets.${tmpKey}`);
		this.pict.providers.Facet.restoreFocus(pPanel.PanelID, tmpFocus);
	}

	/**
	 * @param {Record<string, any>} pModel
	 * @param {Record<string, any>} pFacet - the Pivot FacetResult
	 * @param {Record<string, any>|null} pRowFacet
	 * @param {Record<string, any>|null} pColumnFacet
	 * @param {Record<string, any>} pPanel
	 * @param {Record<string, any>} pBase
	 * @param {Record<string, any>} pEnvelope
	 */
	_buildGrid(pModel, pFacet, pRowFacet, pColumnFacet, pPanel, pBase, pEnvelope)
	{
		let tmpRowKeys = Array.isArray(pFacet.RowKeys) ? pFacet.RowKeys : [];
		let tmpColumnKeys = Array.isArray(pFacet.ColumnKeys) ? pFacet.ColumnKeys : [];
		let tmpCells = Array.isArray(pFacet.Cells) ? pFacet.Cells : [];
		if ((tmpRowKeys.length < 1) || (tmpColumnKeys.length < 1) || (tmpCells.length < 1))
		{
			pModel.EmptySlot = [ { Text: 'No values under this filter' } ];
			return;
		}
		let tmpCounts = {};
		let tmpMax = 1;
		tmpCells.forEach(
			(pCell) =>
			{
				tmpCounts[JSON.stringify([ pCell.K1, pCell.K2 ])] = pCell.Count;
				tmpMax = Math.max(tmpMax, (typeof(pCell.Count) === 'number') ? pCell.Count : 0);
			});
		let fMarginal = (pList, pKey) =>
		{
			let tmpEntry = (Array.isArray(pList) ? pList : []).find((pCandidate) => { return libFacetSelection.sameKey(pCandidate.Key, pKey); });
			return tmpEntry ? tmpEntry.Count : null;
		};
		let tmpMarginals = pFacet.Marginals || {};
		let tmpColumnHeaders = tmpColumnKeys.map((pKey, pIndex) => { return this._header(pBase, 'Column', pIndex, pKey, pColumnFacet, pPanel.KeyNoun); });

		let tmpRows = tmpRowKeys.map(
			(pRowKey, pRowIndex) =>
			{
				let tmpRowHeader = this._header(pBase, 'Row', pRowIndex, pRowKey, pRowFacet, pPanel.RowKeyNoun);
				let tmpRowCells = tmpColumnKeys.map(
					(pColumnKey, pColumnIndex) =>
					{
						let tmpCount = tmpCounts[JSON.stringify([ pRowKey, pColumnKey ])];
						tmpCount = (typeof(tmpCount) === 'number') ? tmpCount : 0;
						let tmpClickable = (tmpCount > 0) && !!pRowFacet && !!pColumnFacet && !!libFacetSelection.pivotCellSelections(pEnvelope, pPanel.RowFacet, pPanel.ColumnFacet, pRowKey, pColumnKey);
						let tmpCell = Object.assign({}, pBase,
							{
								RowIndex: pRowIndex,
								ColumnIndex: pColumnIndex,
								Text: (tmpCount > 0) ? libFacetDisplay.count(tmpCount) : '·',
								HeatAlpha: (tmpCount > 0) ? Math.round((0.08 + (0.6 * (tmpCount / tmpMax))) * 1000) / 1000 : 0,
								CellClass: (tmpCount > 0) ? '' : 'facet-pivot-zero',
								Aria: `${tmpRowHeader.LabelText} × ${tmpColumnHeaders[pColumnIndex].LabelText}: ${libFacetDisplay.count(tmpCount)}`,
								ClickableSlot: [],
								StaticSlot: []
							});
						if (tmpClickable)
						{
							tmpCell.ClickableSlot = [ Object.assign({}, tmpCell, { ClickableSlot: [], StaticSlot: [] }) ];
						}
						else
						{
							tmpCell.StaticSlot = [ Object.assign({}, tmpCell, { ClickableSlot: [], StaticSlot: [] }) ];
						}
						return tmpCell;
					});
				return { HeaderSlot: [ tmpRowHeader ], Cells: tmpRowCells, TotalText: libFacetDisplay.count(fMarginal(tmpMarginals.Rows, pRowKey)) };
			});

		let tmpRowName = pRowFacet ? (pRowFacet.DisplayName || pPanel.RowFacet) : (pPanel.RowFacet || 'Rows');
		let tmpColumnName = pColumnFacet ? (pColumnFacet.DisplayName || pPanel.ColumnFacet) : (pPanel.ColumnFacet || 'Columns');
		pModel.GridSlot =
			[
				{
					Corner: libFacetDisplay.text(`${tmpRowName} \\ ${tmpColumnName}`),
					ColumnHeaders: tmpColumnHeaders,
					Rows: tmpRows,
					ColumnTotals: tmpColumnKeys.map((pKey) => { return { Text: libFacetDisplay.count(fMarginal(tmpMarginals.Columns, pKey)) }; }),
					GrandTotal: libFacetDisplay.count((typeof(tmpMarginals.Total) === 'number') ? tmpMarginals.Total : pFacet.Total)
				}
			];
	}

	/**
	 * Is the group's selection for a facet exactly [pKey]?
	 *
	 * @param {Record<string, any>} pState
	 * @param {string} pFacetKey
	 * @param {any} pKey
	 * @return {boolean}
	 */
	_selectedOnly(pState, pFacetKey, pKey)
	{
		let tmpKeys = libFacetSelection.selectedKeysOf(pState.Selections[pFacetKey] || null);
		return (tmpKeys.length === 1) && libFacetSelection.sameKey(tmpKeys[0], pKey);
	}

	/**
	 * @param {string} pGroupHash
	 * @param {string} pFacetKey - the pivot facet key
	 * @param {number} pRowIndex - index into RowKeys
	 * @param {number} pColumnIndex - index into ColumnKeys
	 */
	pickCell(pGroupHash, pFacetKey, pRowIndex, pColumnIndex)
	{
		let tmpProvider = this.pict.providers.Facet;
		let tmpState = tmpProvider.group(pGroupHash);
		let tmpPanel = this._Panels[`${pGroupHash}-${pFacetKey}`];
		let tmpFacet = (tmpState && tmpState.Envelope && tmpState.Envelope.Facets) ? tmpState.Envelope.Facets[pFacetKey] : null;
		if (!tmpPanel || !tmpFacet || !Array.isArray(tmpFacet.RowKeys) || !Array.isArray(tmpFacet.ColumnKeys))
		{
			return false;
		}
		let tmpRowKey = tmpFacet.RowKeys[pRowIndex];
		let tmpColumnKey = tmpFacet.ColumnKeys[pColumnIndex];
		let tmpSelections = libFacetSelection.pivotCellSelections(tmpState.Envelope, tmpPanel.RowFacet, tmpPanel.ColumnFacet, tmpRowKey, tmpColumnKey);
		if (!tmpSelections)
		{
			return false;
		}
		if (this._selectedOnly(tmpState, tmpPanel.RowFacet, tmpRowKey) && this._selectedOnly(tmpState, tmpPanel.ColumnFacet, tmpColumnKey))
		{
			// The cell is already exactly the selection: clicking it again clears both facets (still one POST).
			tmpSelections[tmpPanel.RowFacet] = null;
			tmpSelections[tmpPanel.ColumnFacet] = null;
		}
		return tmpProvider.setSelections(pGroupHash, tmpSelections);
	}

	/**
	 * @param {string} pGroupHash
	 * @param {string} pFacetKey
	 * @param {string} pAxis - 'Row' | 'Column'
	 * @param {number} pIndex
	 */
	pickHeader(pGroupHash, pFacetKey, pAxis, pIndex)
	{
		let tmpProvider = this.pict.providers.Facet;
		let tmpState = tmpProvider.group(pGroupHash);
		let tmpPanel = this._Panels[`${pGroupHash}-${pFacetKey}`];
		let tmpFacets = (tmpState && tmpState.Envelope && tmpState.Envelope.Facets) ? tmpState.Envelope.Facets : null;
		let tmpFacet = tmpFacets ? tmpFacets[pFacetKey] : null;
		if (!tmpPanel || !tmpFacet)
		{
			return false;
		}
		let tmpAxisFacetKey = (pAxis === 'Row') ? tmpPanel.RowFacet : tmpPanel.ColumnFacet;
		let tmpKeys = (pAxis === 'Row') ? tmpFacet.RowKeys : tmpFacet.ColumnKeys;
		let tmpKey = Array.isArray(tmpKeys) ? tmpKeys[pIndex] : undefined;
		let tmpAxisFacet = tmpFacets[tmpAxisFacetKey] || null;
		let tmpBucket = this._bucket(tmpAxisFacet, tmpKey);
		if (!tmpBucket || !libFacetSelection.isSelectable(tmpAxisFacet, tmpBucket))
		{
			return false;
		}
		let tmpClause = this._selectedOnly(tmpState, tmpAxisFacetKey, tmpKey) ? null : libFacetSelection.termsClause(tmpBucket.Clause, [ tmpBucket.Key ]);
		return tmpProvider.setSelection(pGroupHash, tmpAxisFacetKey, tmpClause);
	}

	onAfterRender(pRenderable, pRenderDestinationAddress, pRecord, pContent)
	{
		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pRenderDestinationAddress, pRecord, pContent);
	}
}

module.exports = PictViewFacetPivot;
module.exports.default_configuration = _ViewConfiguration;
