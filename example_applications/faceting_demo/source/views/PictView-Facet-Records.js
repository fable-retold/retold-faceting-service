/**
 * Facet-Records -- the paged list a facet panel agrees with (DEMO-SPEC §7.7).  Liftable.
 *
 * Rows: state.RecordsPage.Rows.  Page 1 arrives inside the Query envelope (its Records block); later pages come
 * from POST …/Records/:Begin/:Cap (the pict-section-recordset FilterEndpointOverride contract).  The footer says
 * which one the page on screen came from.
 * Header: "1–25 of <Envelope.Total>" (the list total IS the facet Total), "Verify with Records/Count"
 * (provider.verifyCount -> "Records/Count 237 = Total").  The verdict belongs to the answer it was asked about
 * (CountCheck.AnswerSeq): a new answer drops it, and while a Query is on its way the button waits for it.
 * Columns from the panel: { Field, Label, Format: 'Date' | 'DateTime' | 'Key', Align: 'Right', Muted, Blank,
 * Lookup, KeyNoun, MarkCurrentUser, LabelFacet }:
 *   Lookup      a related row's field through Facet-Lookup (the intake's received date, the client's name):
 *               resolved by preparePanel() after the page arrives, cached per principal; the cell shows the
 *               label alone, the key is in its tooltip
 *   LabelFacet  the label a facet of the group gave the key (provider.labelOf: every answer seen, not only the
 *               current buckets)
 * Header click sorts (provider.setRecordsSort) on the row's own fields; Lookup columns do not sort.
 * Empty state: "No <noun> match this filter" + the page's hint + what the host knows about the principal.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libPictView = require('pict-view');

const libFacetDisplay = require('../providers/Facet-Display.js');
const libFacetLookup = require('../providers/Facet-Lookup.js');

const VIEW_IDENTIFIER = 'Facet-Records';

const _ViewConfiguration =
	{
		ViewIdentifier: VIEW_IDENTIFIER,
		DefaultRenderable: 'Facet-Records-Panel',
		DefaultDestinationAddress: '#FD-Main',
		AutoRender: false,

		CSS: /*css*/`
			.facet-records { container-type: inline-size; }
			.facet-rec-range { font-size: 12px; color: var(--facet-text-muted, #5d6878); font-variant-numeric: tabular-nums; }
			.facet-rec-check { display: inline-flex; align-items: center; gap: 4px; }
			.facet-rec-wrap { max-height: 560px; overflow: auto; border: 1px solid var(--facet-border, #dfe3e9); border-radius: var(--facet-radius-sm, 6px); }
			.facet-rec-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
			.facet-rec-table th { position: sticky; top: 0; z-index: 1; padding: 0; text-align: left; font-weight: 600; white-space: nowrap;
				background: var(--facet-surface-2, #f0f2f5); border-bottom: 1px solid var(--facet-border, #dfe3e9); }
			.facet-rec-sort { display: inline-flex; align-items: center; gap: 4px; width: 100%; padding: 7px 10px; margin: 0; border: 0; background: none;
				font: inherit; font-weight: 600; color: var(--facet-text, #1b2230); text-align: inherit; cursor: pointer; transition: color 100ms; }
			.facet-rec-sort:hover { color: var(--facet-accent, #3b5bdb); }
			.facet-rec-sort:focus-visible { outline: 2px solid var(--facet-accent, #3b5bdb); outline-offset: -2px; }
			.facet-rec-sort-active { color: var(--facet-accent, #3b5bdb); }
			.facet-rec-head-static { display: inline-block; padding: 7px 10px; font-weight: 600; color: var(--facet-text, #1b2230); cursor: help; }
			.facet-rec-right .facet-rec-sort { justify-content: flex-end; }
			.facet-rec-table td { padding: 6px 10px; border-bottom: 1px solid var(--facet-border, #dfe3e9); color: var(--facet-text, #1b2230); white-space: nowrap;
				max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
			.facet-rec-table tbody tr:last-child td { border-bottom: 0; }
			.facet-rec-zebra td { background: var(--facet-surface-2, #f0f2f5); }
			.facet-rec-table tbody tr:hover td { background: var(--facet-accent-soft, #e8edfd); }
			.facet-rec-right { text-align: right; font-variant-numeric: tabular-nums; }
			.facet-rec-table td.facet-rec-null, .facet-rec-table td.facet-rec-muted { color: var(--facet-text-faint, #8a94a3); }
			.facet-rec-pager { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
			.facet-rec-pager-text { font-size: 12px; color: var(--facet-text-muted, #5d6878); font-variant-numeric: tabular-nums; white-space: nowrap; }
			.facet-rec-note { flex: 1 1 260px; text-align: right; font-size: 11px; line-height: 1.4; color: var(--facet-text-faint, #8a94a3); }
			.facet-rec-note code { font-family: var(--facet-mono, ui-monospace, Menlo, monospace); font-size: 10.5px; }
			.facet-rec-empty { padding: 28px 12px; text-align: center; border: 1px dashed var(--facet-border, #dfe3e9); border-radius: var(--facet-radius-sm, 6px); }
			.facet-rec-empty-title { font-weight: 600; color: var(--facet-text, #1b2230); margin-bottom: 4px; }
			.facet-rec-empty-hint { font-size: 12px; color: var(--facet-text-muted, #5d6878); }
			.facet-rec-empty-note { margin-top: 6px; font-size: 12px; color: var(--facet-text-faint, #8a94a3); }
			.facet-rec-dropped { margin-bottom: 8px; }
			@container (max-width: 560px)
			{
				.facet-rec-note { flex-basis: 100%; text-align: left; }
			}
		`,

		Templates:
			[
				{
					Hash: 'Facet-Records-Panel-Template',
					Template: /*html*/`
<div class="facet-card facet-records {~D:Record.CardClass~}">
	<header class="facet-card-head">
		<h3 class="facet-card-title">{~D:Record.Title~}</h3>
		<span class="facet-rec-range">{~D:Record.RangeText~}</span>
		<span class="facet-card-spacer"></span>
		{~TS:Facet-Records-Count-Ok-Template:Record.CountOkSlot~}
		{~TS:Facet-Records-Count-Bad-Template:Record.CountBadSlot~}
		{~TS:Facet-Records-Count-Pending-Template:Record.CountPendingSlot~}
		{~TS:Facet-Records-Verify-Template:Record.VerifySlot~}
	</header>
	{~TS:Facet-Records-Dropped-Template:Record.DroppedSlot~}
	{~TS:Facet-Unavailable-Template:Record.UnavailableSlot~}
	{~TS:Facet-Inline-Error-Template:Record.ErrorSlot~}
	{~TS:Facet-Records-Empty-Template:Record.EmptySlot~}
	{~TS:Facet-Records-Table-Template:Record.TableSlot~}
	{~TS:Facet-Records-Pager-Template:Record.PagerSlot~}
</div>`
				},
				{
					Hash: 'Facet-Records-Verify-Template',
					Template: /*html*/`<button type="button" class="facet-btn" {~D:Record.DisabledAttr~} data-focus-key="verify" title="{~D:Record.Tip~}" onclick="{~P~}.views['{~D:Record.ViewHash~}'].verifyCount('{~D:Record.Group~}')">{~I:Check~} Verify with Records/Count</button>`
				},
				{
					Hash: 'Facet-Records-Count-Ok-Template',
					Template: /*html*/`<span class="facet-badge facet-badge-ok facet-rec-check" title="The list route and the facet envelope agree.">{~I:Check~} {~D:Record.Text~}</span>`
				},
				{
					Hash: 'Facet-Records-Count-Bad-Template',
					Template: /*html*/`<span class="facet-badge facet-badge-error facet-rec-check" title="{~D:Record.Tip~}">{~I:Warning~} {~D:Record.Text~}</span>`
				},
				{
					Hash: 'Facet-Records-Count-Pending-Template',
					Template: /*html*/`<span class="facet-badge facet-rec-check">{~D:Record.Text~}</span>`
				},
				{
					Hash: 'Facet-Records-Dropped-Template',
					Template: /*html*/`<div class="facet-badge facet-badge-warn facet-rec-dropped" title="X-Retold-Facet-Records-Dropped">{~I:Info~} {~D:Record.Text~}</div>`
				},
				{
					Hash: 'Facet-Records-Empty-Template',
					Template: /*html*/`<div class="facet-rec-empty"><div class="facet-rec-empty-title">{~D:Record.Title~}</div><div class="facet-rec-empty-hint">{~D:Record.Hint~}</div>{~TS:Facet-Records-Empty-Note-Template:Record.NoteSlot~}</div>`
				},
				{
					Hash: 'Facet-Records-Empty-Note-Template',
					Template: /*html*/`<div class="facet-rec-empty-note">{~I:User~} {~D:Record.Text~}</div>`
				},
				{
					Hash: 'Facet-Records-Table-Template',
					Template: /*html*/`
<div class="facet-rec-wrap">
	<table class="facet-rec-table">
		<thead><tr>{~TS:Facet-Records-Header-Template:Record.Headers~}</tr></thead>
		<tbody>{~TS:Facet-Records-Row-Template:Record.Rows~}</tbody>
	</table>
</div>`
				},
				{
					Hash: 'Facet-Records-Header-Template',
					Template: /*html*/`<th class="{~D:Record.AlignClass~}" scope="col" aria-sort="{~D:Record.AriaSort~}">{~TS:Facet-Records-Header-Sort-Template:Record.SortableSlot~}{~TS:Facet-Records-Header-Static-Template:Record.StaticSlot~}</th>`
				},
				{
					Hash: 'Facet-Records-Header-Sort-Template',
					Template: /*html*/`<button type="button" class="facet-rec-sort {~D:Record.ActiveClass~}" title="Sort by {~D:Record.Label~}" data-focus-key="sort-{~D:Record.Index~}" onclick="{~P~}.views['{~D:Record.ViewHash~}'].sortBy('{~D:Record.Group~}', {~D:Record.Index~})">{~D:Record.Label~}{~TS:Facet-Records-Sort-Up-Template:Record.SortUpSlot~}{~TS:Facet-Records-Sort-Down-Template:Record.SortDownSlot~}</button>`
				},
				{
					Hash: 'Facet-Records-Header-Static-Template',
					Template: /*html*/`<span class="facet-rec-head-static" title="{~D:Record.Tip~}">{~D:Record.Label~}</span>`
				},
				{
					Hash: 'Facet-Records-Sort-Up-Template',
					Template: /*html*/`{~I:ChevronUp~}`
				},
				{
					Hash: 'Facet-Records-Sort-Down-Template',
					Template: /*html*/`{~I:ChevronDown~}`
				},
				{
					Hash: 'Facet-Records-Row-Template',
					Template: /*html*/`<tr class="{~D:Record.ZebraClass~}">{~TS:Facet-Records-Cell-Template:Record.Cells~}</tr>`
				},
				{
					Hash: 'Facet-Records-Cell-Template',
					Template: /*html*/`<td class="{~D:Record.CellClass~}" title="{~D:Record.Tip~}">{~D:Record.Text~}</td>`
				},
				{
					Hash: 'Facet-Records-Pager-Template',
					Template: /*html*/`
<div class="facet-rec-pager">
	<button type="button" class="facet-btn" {~D:Record.PrevDisabledAttr~} data-focus-key="prev" onclick="{~P~}.views['{~D:Record.ViewHash~}'].page('{~D:Record.Group~}', -1)">{~I:ChevronLeft~} Prev</button>
	<button type="button" class="facet-btn" {~D:Record.NextDisabledAttr~} data-focus-key="next" onclick="{~P~}.views['{~D:Record.ViewHash~}'].page('{~D:Record.Group~}', 1)">Next {~I:ChevronRight~}</button>
	<span class="facet-rec-pager-text">{~D:Record.PageText~}</span>
	<span class="facet-rec-note">{~D:Record.NoteHTML~}</span>
</div>`
				}
			],

		Renderables:
			[
				{
					RenderableHash: 'Facet-Records-Panel',
					TemplateHash: 'Facet-Records-Panel-Template',
					ContentDestinationAddress: '#FD-Main',
					RenderMethod: 'replace'
				}
			]
	};

class PictViewFacetRecords extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this._Panels = {};
	}

	/**
	 * A plain field value as text (Format, Blank).
	 *
	 * @param {Record<string, any>} pColumn
	 * @param {any} pValue
	 * @return {string} raw text
	 */
	_formatValue(pColumn, pValue)
	{
		if (pColumn.Format === 'Date')
		{
			let tmpParts = libFacetDisplay.dateParts(String(pValue));
			return tmpParts ? `${libFacetDisplay.MONTHS[tmpParts.Month - 1]} ${tmpParts.Day}, ${tmpParts.Year}` : String(pValue);
		}
		if (pColumn.Format === 'DateTime')
		{
			let tmpText = String(pValue).replace('T', ' ');
			return (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(tmpText)) ? tmpText.slice(0, 16) : tmpText;
		}
		if (pColumn.Format === 'Key')
		{
			return `#${pValue}`;
		}
		if (typeof(pValue) === 'object')
		{
			try
			{
				return JSON.stringify(pValue);
			}
			catch (pError)
			{
				return '';
			}
		}
		return String(pValue);
	}

	/**
	 * One cell's display text, tooltip and class.
	 *
	 * @param {Record<string, any>} pColumn - { Field, Label, Format, Align, Muted, Blank, Lookup, KeyNoun, MarkCurrentUser, LabelFacet }
	 * @param {Record<string, any>} pRow
	 * @param {Record<string, any>} pContext - { State, LookupFailed }
	 * @return {{ Text: string, Tip: string, CellClass: string }}
	 */
	_cell(pColumn, pRow, pContext)
	{
		let tmpProvider = this.pict.providers.Facet;
		let tmpState = pContext.State;
		let tmpValue = pRow ? pRow[pColumn.Field] : null;
		let tmpClasses = [ (pColumn.Align === 'Right') ? 'facet-rec-right' : '', pColumn.Muted ? 'facet-rec-muted' : '' ];
		let fCell = (pText, pTip, pMuted) =>
		{
			return { Text: libFacetDisplay.text(pText), Tip: libFacetDisplay.text(pTip || pText), CellClass: tmpClasses.concat(pMuted ? [ 'facet-rec-null' ] : []).join(' ').trim() };
		};
		if (pColumn.Lookup)
		{
			let tmpInfo = tmpProvider.principalInfo();
			let tmpLookup = libFacetLookup.cellValue(pColumn, pRow,
				(pEntity, pKeyField, pKey) => { return tmpProvider.lookupRows(tmpState.Domain, pEntity, pKeyField, pKey); },
				{ CurrentUser: (typeof(tmpInfo.User) !== 'undefined') ? tmpInfo.User : null, Failed: pContext.LookupFailed });
			let tmpText = tmpLookup.Text;
			if ((tmpText === '—') && pColumn.Blank && !tmpLookup.Pending)
			{
				tmpText = pColumn.Blank;
			}
			else if (!tmpLookup.Muted && !tmpLookup.Pending && (pColumn.Format === 'Date'))
			{
				tmpText = this._formatValue(pColumn, tmpText);
			}
			return fCell(tmpText, tmpLookup.Tip, tmpLookup.Muted);
		}
		if ((tmpValue === null) || (typeof(tmpValue) === 'undefined') || (tmpValue === ''))
		{
			return fCell(((tmpValue === '') && pColumn.Blank) ? pColumn.Blank : '—', (tmpValue === '') ? 'An empty string value' : 'No value', true);
		}
		if (pColumn.LabelFacet)
		{
			let tmpLabel = tmpProvider.labelOf(tmpState.Hash, pColumn.LabelFacet, tmpValue);
			if (tmpLabel && tmpLabel.LabelResolved && (typeof(tmpLabel.Label) === 'string') && (tmpLabel.Label.length > 0))
			{
				return fCell(tmpLabel.Label, `${pColumn.Field} ${tmpValue}`, false);
			}
			if (tmpLabel && !tmpLabel.LabelResolved)
			{
				return fCell(`${pColumn.KeyNoun ? `${pColumn.KeyNoun} ` : ''}#${tmpValue} (no name)`, libFacetDisplay.UNRESOLVED_TIP, true);
			}
		}
		let tmpText = this._formatValue(pColumn, tmpValue);
		return fCell(tmpText, (pColumn.Format === 'Date') ? String(tmpValue) : tmpText, false);
	}

	/**
	 * Side effects that belong to the data, not the drawing: once a page of rows is on screen, resolve its
	 * Lookup columns (provider.lookupForRows, cached per principal).  Idempotent per RecordsPage; the page view
	 * calls it after the group events that can bring a new page.
	 *
	 * @param {Record<string, any>} pPanel
	 */
	preparePanel(pPanel)
	{
		let tmpProvider = this.pict.providers.Facet;
		let tmpState = tmpProvider.group(pPanel.Group);
		let tmpPage = tmpState ? tmpState.RecordsPage : null;
		let tmpColumns = Array.isArray(pPanel.Columns) ? pPanel.Columns : [];
		if (!tmpPage || (tmpPage.Status !== 'Ready') || !Array.isArray(tmpPage.Rows) || (tmpPage.Rows.length < 1) || tmpPage.Lookup)
		{
			return;
		}
		if (!tmpColumns.some((pColumn) => { return !!pColumn.Lookup; }))
		{
			return;
		}
		tmpPage.Lookup = { Status: 'Loading', Error: null };
		let tmpSynchronous = true;
		tmpProvider.lookupForRows(pPanel.Group, tmpPage.Rows, tmpColumns,
			(pError) =>
			{
				tmpPage.Lookup = { Status: pError ? 'Error' : 'Ready', Error: pError ? pError.message : null };
				if (!tmpSynchronous && (tmpState.RecordsPage === tmpPage))
				{
					tmpProvider.notify(pPanel.Group, 'Records');
				}
			});
		tmpSynchronous = false;
	}

	/**
	 * @param {Record<string, any>} pPanel - layout entry + PanelID (+ Noun, NounOne, EmptyHint from the page)
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
		let tmpEnvelope = tmpState.Envelope;
		let tmpPage = tmpState.RecordsPage;
		let tmpTotal = (tmpEnvelope && (typeof(tmpEnvelope.Total) === 'number')) ? tmpEnvelope.Total : null;
		let tmpBase = { ViewHash: VIEW_IDENTIFIER, Group: pPanel.Group };
		let tmpNoun = pPanel.Noun || 'rows';
		let tmpColumns = Array.isArray(pPanel.Columns) ? pPanel.Columns : [];
		let tmpLoading = (tmpState.Status === 'Loading');

		let tmpModel =
			{
				ViewHash: VIEW_IDENTIFIER,
				Group: pPanel.Group,
				Title: libFacetDisplay.text(pPanel.Title || 'Records'),
				CardClass: (tmpLoading || (tmpPage && (tmpPage.Status === 'Loading'))) ? 'facet-loading-dim' : '',
				RangeText: '',
				VerifySlot: [],
				CountOkSlot: [],
				CountBadSlot: [],
				CountPendingSlot: [],
				DroppedSlot: [],
				UnavailableSlot: [],
				ErrorSlot: [],
				EmptySlot: [],
				TableSlot: [],
				PagerSlot: []
			};

		if (!tmpEnvelope)
		{
			tmpModel.UnavailableSlot = [ { Text: (tmpState.Status === 'Error') ? 'Unavailable' : 'Loading…' } ];
			this._render(pPanel, tmpState, tmpModel);
			return;
		}

		// Count check (the list route vs the envelope Total) -- only a verdict about the answer on screen.
		let tmpCheck = tmpState.CountCheck;
		let tmpCurrentCheck = !!tmpCheck && ((tmpCheck.Status === 'Loading') || (tmpCheck.AnswerSeq === tmpState.AnswerSeq));
		if (tmpCurrentCheck && (tmpCheck.Status === 'Loading'))
		{
			tmpModel.CountPendingSlot = [ { Text: tmpCheck.Waiting ? 'Waiting for the answer…' : 'Counting…' } ];
		}
		else if (tmpCurrentCheck && (tmpCheck.Status === 'Ready') && tmpCheck.Agrees)
		{
			tmpModel.CountOkSlot = [ { Text: libFacetDisplay.text(`Records/Count ${libFacetDisplay.count(tmpCheck.Count)} = Total`) } ];
		}
		else if (tmpCurrentCheck && (tmpCheck.Status === 'Ready'))
		{
			tmpModel.CountBadSlot = [ { Text: libFacetDisplay.text(`Records/Count ${libFacetDisplay.count(tmpCheck.Count)} ≠ Total ${libFacetDisplay.count(tmpCheck.Total)}`), Tip: 'The list and the envelope disagree: report this.' } ];
		}
		else if (tmpCurrentCheck && (tmpCheck.Status === 'Error'))
		{
			tmpModel.CountBadSlot = [ { Text: libFacetDisplay.text(`Records/Count failed: ${tmpCheck.Error ? tmpCheck.Error.Code : 'error'}`), Tip: libFacetDisplay.text(tmpCheck.Error ? tmpCheck.Error.Message : '') } ];
		}
		if (!tmpCurrentCheck || (tmpCheck.Status !== 'Loading'))
		{
			tmpModel.VerifySlot = [ Object.assign({}, tmpBase,
				{
					DisabledAttr: tmpLoading ? 'disabled' : '',
					Tip: tmpLoading ? 'A new answer is on its way: verify it once it arrives' : 'POST …/Records/Count with the same filter, compared with the Total of the answer on screen'
				}) ];
		}

		let tmpDropped = tmpPage && (typeof(tmpPage.Dropped) === 'number') ? tmpPage.Dropped : 0;
		if (tmpDropped > 0)
		{
			tmpModel.DroppedSlot = [ { Text: libFacetDisplay.text(`${tmpDropped} record(s) dropped by read behaviors`) } ];
		}

		if (tmpTotal === 0)
		{
			let tmpInfo = tmpProvider.principalInfo();
			let tmpNote = (tmpInfo && tmpInfo.Notes && tmpInfo.Notes[tmpState.Domain]) ? `Signed in as ${tmpInfo.Label || 'this user'} · ${tmpInfo.Notes[tmpState.Domain]}` : null;
			tmpModel.RangeText = `0 ${libFacetDisplay.text(tmpNoun)}`;
			tmpModel.EmptySlot = [ { Title: libFacetDisplay.text(`No ${tmpNoun} match this filter`), Hint: libFacetDisplay.text(pPanel.EmptyHint || 'Try removing a filter.'), NoteSlot: tmpNote ? [ { Text: libFacetDisplay.text(tmpNote) } ] : [] } ];
			this._render(pPanel, tmpState, tmpModel);
			return;
		}

		if (tmpPage && (tmpPage.Status === 'Error'))
		{
			let tmpError = tmpPage.Error || {};
			tmpModel.ErrorSlot = [ { Code: libFacetDisplay.text(tmpError.Code), Status: libFacetDisplay.text(tmpError.Status), Message: libFacetDisplay.text(tmpError.Message), SuggestSlot: [] } ];
		}

		let tmpRows = (tmpPage && Array.isArray(tmpPage.Rows)) ? tmpPage.Rows : [];
		let tmpBegin = tmpPage ? (tmpPage.Begin || 0) : 0;
		let tmpCap = (tmpPage && tmpPage.Cap) ? tmpPage.Cap : ((tmpState.Records && tmpState.Records.Cap) ? tmpState.Records.Cap : 25);
		let tmpEnd = tmpBegin + tmpRows.length;
		tmpModel.RangeText = (tmpRows.length > 0) ? libFacetDisplay.text(`${libFacetDisplay.count(tmpBegin + 1)}–${libFacetDisplay.count(tmpEnd)} of ${libFacetDisplay.count(tmpTotal)}`) : libFacetDisplay.text(`${libFacetDisplay.count(tmpTotal)} ${tmpNoun}`);

		let tmpSort = (tmpState.Records && Array.isArray(tmpState.Records.Sort) && tmpState.Records.Sort.length > 0) ? tmpState.Records.Sort[0] : null;
		let tmpHeaders = tmpColumns.map(
			(pColumn, pIndex) =>
			{
				let tmpActive = !!tmpSort && !pColumn.Lookup && (tmpSort.Field === pColumn.Field);
				let tmpHeader = Object.assign({}, tmpBase,
					{
						Index: pIndex,
						Label: libFacetDisplay.text(pColumn.Label || pColumn.Field),
						AlignClass: (pColumn.Align === 'Right') ? 'facet-rec-right' : '',
						ActiveClass: tmpActive ? 'facet-rec-sort-active' : '',
						AriaSort: tmpActive ? ((tmpSort.Dir === 'DESC') ? 'descending' : 'ascending') : 'none',
						SortUpSlot: (tmpActive && (tmpSort.Dir !== 'DESC')) ? [ {} ] : [],
						SortDownSlot: (tmpActive && (tmpSort.Dir === 'DESC')) ? [ {} ] : [],
						Tip: pColumn.Lookup ? libFacetDisplay.text(`Looked up from ${pColumn.Lookup.Entity}${pColumn.Lookup.Then ? ` → ${pColumn.Lookup.Then.Entity}` : ''} (display only: the list sorts on its own fields)`) : '',
						SortableSlot: [],
						StaticSlot: []
					});
				if (pColumn.Lookup)
				{
					tmpHeader.StaticSlot = [ Object.assign({}, tmpHeader, { SortableSlot: [], StaticSlot: [] }) ];
				}
				else
				{
					tmpHeader.SortableSlot = [ Object.assign({}, tmpHeader, { SortableSlot: [], StaticSlot: [] }) ];
				}
				return tmpHeader;
			});
		let tmpContext = { State: tmpState, LookupFailed: !!(tmpPage && tmpPage.Lookup && (tmpPage.Lookup.Status === 'Error')) };
		let tmpRowModels = tmpRows.map(
			(pRow, pIndex) =>
			{
				return { ZebraClass: ((pIndex % 2) === 1) ? 'facet-rec-zebra' : '', Cells: tmpColumns.map((pColumn) => { return this._cell(pColumn, pRow, tmpContext); }) };
			});
		if (tmpRowModels.length > 0)
		{
			tmpModel.TableSlot = [ { Headers: tmpHeaders, Rows: tmpRowModels } ];
		}
		else if (!tmpModel.ErrorSlot.length)
		{
			tmpModel.UnavailableSlot = [ { Text: (tmpPage && tmpPage.Status === 'Loading') ? 'Loading…' : 'No rows on this page' } ];
		}

		let tmpPageNumber = Math.floor(tmpBegin / tmpCap) + 1;
		let tmpPageCount = Math.max(1, Math.ceil((tmpTotal || 0) / tmpCap));
		let tmpSource = (tmpPage && (tmpPage.Source === 'Records'))
			? `This page: <code>POST …/Records/${libFacetDisplay.text(tmpBegin)}/${libFacetDisplay.text(tmpCap)}</code>.`
			: 'This page came inside the Query envelope (its <code>Records</code>); later pages come from <code>POST …/Records/:Begin/:Cap</code>.';
		tmpModel.PagerSlot =
			[
				Object.assign({}, tmpBase,
					{
						PrevDisabledAttr: (tmpBegin <= 0) ? 'disabled' : '',
						NextDisabledAttr: ((tmpTotal === null) || ((tmpBegin + tmpCap) >= tmpTotal)) ? 'disabled' : '',
						PageText: libFacetDisplay.text(`Page ${tmpPageNumber} of ${tmpPageCount}`),
						NoteHTML: `${tmpSource} Same filter, one compiler: the list and the counts agree.`
					})
			];

		this._render(pPanel, tmpState, tmpModel);
	}

	/**
	 * @param {Record<string, any>} pPanel
	 * @param {Record<string, any>} pState
	 * @param {Record<string, any>} pModel
	 */
	_render(pPanel, pState, pModel)
	{
		pState.Widgets.Records = pModel;
		let tmpFocus = this.pict.providers.Facet.captureFocus(pPanel.PanelID);
		this.render('Facet-Records-Panel', `#${pPanel.PanelID}`, `AppData.Facet.Groups.${pPanel.Group}.Widgets.Records`);
		this.pict.providers.Facet.restoreFocus(pPanel.PanelID, tmpFocus);
	}

	/**
	 * @param {string} pGroupHash
	 * @param {number} pDirection - -1 | 1
	 */
	page(pGroupHash, pDirection)
	{
		let tmpProvider = this.pict.providers.Facet;
		let tmpState = tmpProvider.group(pGroupHash);
		if (!tmpState || !tmpState.Records)
		{
			return false;
		}
		let tmpCap = tmpState.Records.Cap || 25;
		let tmpBegin = (tmpState.RecordsPage && (typeof(tmpState.RecordsPage.Begin) === 'number')) ? tmpState.RecordsPage.Begin : 0;
		let tmpTotal = (tmpState.Envelope && (typeof(tmpState.Envelope.Total) === 'number')) ? tmpState.Envelope.Total : 0;
		let tmpNext = tmpBegin + ((pDirection < 0) ? -tmpCap : tmpCap);
		if ((tmpNext < 0) || (tmpNext >= tmpTotal))
		{
			return false;
		}
		tmpProvider.loadRecordsPage(pGroupHash, tmpNext);
		return true;
	}

	/**
	 * @param {string} pGroupHash
	 * @param {number} pColumnIndex
	 */
	sortBy(pGroupHash, pColumnIndex)
	{
		let tmpPanel = this._Panels[pGroupHash];
		let tmpColumn = (tmpPanel && Array.isArray(tmpPanel.Columns)) ? tmpPanel.Columns[pColumnIndex] : null;
		if (!tmpColumn || tmpColumn.Lookup)
		{
			return false;
		}
		return this.pict.providers.Facet.setRecordsSort(pGroupHash, tmpColumn.Field);
	}

	/**
	 * @param {string} pGroupHash
	 */
	verifyCount(pGroupHash)
	{
		return this.pict.providers.Facet.verifyCount(pGroupHash);
	}

	onAfterRender(pRenderable, pRenderDestinationAddress, pRecord, pContent)
	{
		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pRenderDestinationAddress, pRecord, pContent);
	}
}

module.exports = PictViewFacetRecords;
module.exports.default_configuration = _ViewConfiguration;
