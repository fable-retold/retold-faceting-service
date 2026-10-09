/**
 * FacetDemo-Change -- the "Make a change" panel of each page (internal-contracts §47.4): a REAL write through the
 * domain's stock meadow-endpoints CRUD route (through the front proxy's write allowlist), as the demo principal;
 * the affected cards then update through the SSE-triggered refetch alone (no manual reload).  Demo-specific (not
 * lifted).
 *
 *   ProjectStatus    Projects for me         PUT  /api/ProjectTrack/1.0/Project       { IDProject, Status }        (+ Undo)
 *   DocumentAdd      Documents by form type  POST /api/ProjectTrack/1.0/Document      { Title, Status, DocumentDate, IDFormType, IDProject }
 *                                            DELETE …/1.0/Document/<ID>, GET …/1.0/Document/Undelete/<ID>
 *   LabFormComplete  Lab forms (A)           PUT  /api/LabTrack/1.0/LabForm           { IDLabForm, Status, CompletedDate }   (Complete / Re-open)
 *                                            the form: a Pending LabForm of mine for a Started work-list row, found
 *                                            through POST …/1.0/Facet/LabForm/Records/0/1
 *   ReviewAdd        Bookstore explorer      POST /api/Bookstore/1.0/Review           { IDBook, Rating: 5, Text }; DELETE …/1.0/Review/<ID>
 *                                            the book: the first listed book that has no 5-star review yet (its
 *                                            reviews read through the faceting Records route of Review, a Lookup),
 *                                            so the 5-star counts visibly move; the first listed book when all have one
 *
 * A panel entry in FacetDemo-Pages: { Widget: 'Change', Group, Action }.  Writes go through provider.write (logged
 * as inspector exchanges of kind 'Write'); the panel shows the write's status and what changed.  The panel never
 * refreshes a group while the domain's change stream is open: the counts move because the server's change stream
 * says the entity changed.  Without a stream (a host without M4, the anonymous persona) it refreshes the group
 * itself and says so.  Panel state (what was written, so it can be undone) lives at AppData.FacetDemo.Change[Action]
 * and is dropped when the persona changes.
 *
 * Contract: internal-contracts §47.4 (DEMO-SPEC §12).  Owner: builder D (M4).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libPictView = require('pict-view');

const libFacetSelection = require('../providers/Facet-Selection.js');
const libFacetDisplay = require('../providers/Facet-Display.js');
const libFacetLookup = require('../providers/Facet-Lookup.js');
const libFacetChanges = require('../providers/Facet-Changes.js');

const VIEW_IDENTIFIER = 'FacetDemo-Change';

const PROJECT_STATUSES = [ 'Active', 'AtRisk', 'OnHold', 'Done' ];
const PROJECT_STATUS_LABELS = { Active: 'Active', AtRisk: 'At risk', OnHold: 'On hold', Done: 'Done' };

// The date of a demo document (inside the Documents page's initial January–June 2026 range).
const DOCUMENT_DATE = '2026-03-15 00:00:00';

const REVIEW_TEXT = 'Five stars, from the faceting demo.';

const _ViewConfiguration =
	{
		ViewIdentifier: VIEW_IDENTIFIER,
		DefaultRenderable: 'FacetDemo-Change-Panel',
		DefaultDestinationAddress: '#FD-Top',
		AutoRender: false,

		CSS: /*css*/`
			.fd-card-Change { padding: 10px 14px; border-style: dashed; border-color: var(--fd-demo, #c2410c); }
			.fd-change-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; margin-bottom: 8px; }
			.fd-change-title { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fd-demo, #c2410c); }
			.fd-change-who { font-size: 12px; color: var(--fd-text-muted, #5d6878); }
			.fd-change-spacer { flex: 1 1 auto; }
			.fd-change-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; }
			.fd-change-what { font-size: 13px; color: var(--fd-text, #1b2230); min-width: 0; }
			.fd-change-select { max-width: 100%; padding: 4px 8px; border-radius: var(--fd-radius-sm, 6px); border: 1px solid var(--fd-border, #dfe3e9); font: inherit; font-size: 12px;
				color: var(--fd-text, #1b2230); background-color: var(--fd-surface, #ffffff); }
			.fd-change-select:focus-visible { outline: 2px solid var(--fd-accent, #3b5bdb); outline-offset: 1px; }
			.fd-change-btn-undo { border-style: dashed; }
			.fd-change-status { margin-top: 8px; font-size: 12px; line-height: 1.45; color: var(--fd-text-muted, #5d6878); font-variant-numeric: tabular-nums; }
			.fd-change-status-ok { color: var(--fd-ok, #2b8a3e); }
			.fd-change-status-warn { color: var(--fd-warn, #a8620a); }
			.fd-change-status-error { color: var(--fd-error, #c92a2a); }
			.fd-change-status code { font-family: var(--fd-mono, ui-monospace, Menlo, monospace); font-size: 11.5px; }
			.fd-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
		`,

		Templates:
			[
				{
					Hash: 'FacetDemo-Change-Panel-Template',
					Template: /*html*/`
<div class="fd-change" role="group" aria-label="Make a change" data-change-action="{~D:Record.Action~}">
	<div class="fd-change-head">
		<span class="fd-change-title">{~I:Warning~} Make a change</span>
		<span class="fd-change-who">{~D:Record.Who~}</span>
		<span class="fd-change-spacer"></span>
		<span class="fd-chip fd-chip-{~D:Record.StreamTone~}" title="{~D:Record.StreamTip~}">{~D:Record.StreamText~}</span>
	</div>
	<div class="fd-change-row">
		<span class="fd-change-what">{~D:Record.What~}</span>
		{~TS:FacetDemo-Change-Select-Template:Record.Selects~}
		{~TS:FacetDemo-Change-Button-Template:Record.Buttons~}
	</div>
	{~TS:FacetDemo-Change-Status-Template:Record.StatusSlot~}
</div>`
				},
				{
					Hash: 'FacetDemo-Change-Select-Template',
					Template: /*html*/`<label><span class="fd-visually-hidden">{~D:Record.Label~}</span><select class="fd-change-select" data-focus-key="change-select-{~D:Record.Action~}" onchange="{~P~}.views['${VIEW_IDENTIFIER}'].choose('{~D:Record.Group~}', '{~D:Record.Action~}', this.value)">{~TS:FacetDemo-Change-Option-Template:Record.Options~}</select></label>`
				},
				{
					Hash: 'FacetDemo-Change-Option-Template',
					Template: /*html*/`<option value="{~D:Record.Value~}" {~D:Record.SelectedAttr~}>{~D:Record.Text~}</option>`
				},
				{
					Hash: 'FacetDemo-Change-Button-Template',
					Template: /*html*/`<button type="button" class="facet-btn fd-change-btn {~D:Record.Class~}" data-change-op="{~D:Record.Op~}" data-focus-key="change-{~D:Record.Action~}-{~D:Record.Op~}" title="{~D:Record.Tip~}" {~D:Record.DisabledAttr~} onclick="{~P~}.views['${VIEW_IDENTIFIER}'].act('{~D:Record.Group~}', '{~D:Record.Action~}', '{~D:Record.Op~}')">{~D:Record.Text~}</button>`
				},
				{
					Hash: 'FacetDemo-Change-Status-Template',
					Template: /*html*/`<div class="fd-change-status fd-change-status-{~D:Record.Tone~}" role="status" aria-live="polite">{~D:Record.Text~}</div>`
				}
			],

		Renderables:
			[
				{
					RenderableHash: 'FacetDemo-Change-Panel',
					TemplateHash: 'FacetDemo-Change-Panel-Template',
					DestinationAddress: '#FD-Top'
				}
			]
	};

/**
 * 'YYYY-MM-DD HH:mm:ss' of now (local wall clock, the shape the fixtures store).
 *
 * @return {string}
 */
const nowStamp = () =>
{
	let tmpNow = new Date();
	let fPad = (pValue) => { return String(pValue).padStart(2, '0'); };
	return `${tmpNow.getFullYear()}-${fPad(tmpNow.getMonth() + 1)}-${fPad(tmpNow.getDate())} ${fPad(tmpNow.getHours())}:${fPad(tmpNow.getMinutes())}:${fPad(tmpNow.getSeconds())}`;
};

class PictViewFacetDemoChange extends libPictView
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		// Group|Action -> the panel entry it was last drawn with (writes re-render through it).
		this._Panels = {};
	}

	/**
	 * The panel state of an action for the current persona (reset when the persona changed).
	 *
	 * @param {string} pAction
	 * @return {Record<string, any>}
	 */
	_panelState(pAction)
	{
		let tmpDemo = this.pict.AppData.FacetDemo;
		if (!tmpDemo.Change)
		{
			tmpDemo.Change = {};
		}
		let tmpPrincipal = this.pict.providers.Facet.principalKey();
		let tmpState = tmpDemo.Change[pAction];
		if (!tmpState || (tmpState.PrincipalKey !== tmpPrincipal))
		{
			tmpState = { PrincipalKey: tmpPrincipal, Status: 'Idle', Tone: 'muted', Message: '', Busy: false, Selected: null, Last: null };
			tmpDemo.Change[pAction] = tmpState;
		}
		return tmpState;
	}

	/**
	 * The rows of the group's list on screen (page 1 comes inside the Query envelope).
	 *
	 * @param {Record<string, any>} pState
	 * @return {Array<Record<string, any>>}
	 */
	_rows(pState)
	{
		return (pState && pState.RecordsPage && Array.isArray(pState.RecordsPage.Rows)) ? pState.RecordsPage.Rows : [];
	}

	/**
	 * @param {Record<string, any>} pPanel
	 */
	renderPanel(pPanel)
	{
		let tmpProvider = this.pict.providers.Facet;
		let tmpState = tmpProvider.group(pPanel.Group);
		if (!tmpState)
		{
			return;
		}
		this._Panels[`${pPanel.Group}|${pPanel.Action}`] = pPanel;
		let tmpPanelState = this._panelState(pPanel.Action);
		let tmpInfo = tmpProvider.principalInfo() || {};
		let tmpStream = libFacetChanges.streamLabel(tmpProvider.changeState(tmpState.Domain));
		let tmpModel =
			{
				Action: libFacetDisplay.text(pPanel.Action),
				Who: libFacetDisplay.text(`A real write through ${tmpState.Domain}'s stock CRUD route, as ${tmpInfo.Label || 'this persona'}. ${(tmpStream.Tone === 'ok') ? 'The cards follow the change stream: no reload.' : 'No change stream: the page refreshes itself after a write.'}`),
				StreamText: libFacetDisplay.text(tmpStream.Text),
				StreamTone: tmpStream.Tone,
				StreamTip: libFacetDisplay.text(tmpStream.Tip),
				What: '',
				Selects: [],
				Buttons: [],
				StatusSlot: (tmpPanelState.Message.length > 0) ? [ { Tone: tmpPanelState.Tone, Text: tmpPanelState.Message } ] : []
			};
		let fButton = (pOp, pText, pEnabled, pTip, pClass) =>
		{
			return (
				{
					Group: libFacetDisplay.text(pPanel.Group),
					Action: libFacetDisplay.text(pPanel.Action),
					Op: libFacetDisplay.text(pOp),
					Text: libFacetDisplay.text(pText),
					Tip: libFacetDisplay.text(pTip || ''),
					Class: pClass || '',
					DisabledAttr: (pEnabled && !tmpPanelState.Busy) ? '' : 'disabled'
				});
		};
		let tmpReady = (tmpState.Status === 'Ready') && (tmpState.PrincipalKey === tmpProvider.principalKey());
		switch (pPanel.Action)
		{
			case 'ProjectStatus':
			{
				let tmpRows = this._rows(tmpState).filter((pRow) => { return typeof(pRow.IDProject) === 'number'; });
				let tmpSelected = tmpRows.find((pRow) => { return pRow.IDProject === tmpPanelState.Selected; }) || tmpRows[0] || null;
				tmpModel.What = tmpRows.length ? 'Set the status of' : 'No project is listed: widen the filters to pick one.';
				if (tmpRows.length)
				{
					tmpModel.Selects.push(
						{
							Group: libFacetDisplay.text(pPanel.Group),
							Action: libFacetDisplay.text(pPanel.Action),
							Label: 'Project',
							Options: tmpRows.map(
								(pRow) =>
								{
									return { Value: pRow.IDProject, Text: libFacetDisplay.text(`${pRow.Name || `Project #${pRow.IDProject}`} (${PROJECT_STATUS_LABELS[pRow.Status] || pRow.Status || 'no status'})`), SelectedAttr: (tmpSelected && (pRow.IDProject === tmpSelected.IDProject)) ? 'selected' : '' };
								})
						});
				}
				PROJECT_STATUSES.forEach(
					(pStatus) =>
					{
						tmpModel.Buttons.push(fButton(`Set-${pStatus}`, PROJECT_STATUS_LABELS[pStatus], tmpReady && !!tmpSelected && (tmpSelected.Status !== pStatus), tmpSelected ? `PUT /1.0/Project { IDProject: ${tmpSelected.IDProject}, Status: '${pStatus}' }` : ''));
					});
				let tmpLast = tmpPanelState.Last;
				let tmpUndoable = !!tmpLast && (PROJECT_STATUSES.indexOf(tmpLast.From) >= 0);
				tmpModel.Buttons.push(fButton('Undo', 'Undo', tmpUndoable, tmpLast ? `Set "${tmpLast.Name}" back to ${PROJECT_STATUS_LABELS[tmpLast.From] || tmpLast.From}` : 'Nothing to undo yet', 'fd-change-btn-undo'));
				break;
			}
			case 'DocumentAdd':
			{
				let tmpTarget = this._documentTarget(tmpState);
				let tmpDoc = tmpPanelState.Last;
				tmpModel.What = libFacetDisplay.text(tmpTarget ? `Add a Draft "${tmpTarget.FormName}" document dated Mar 15, 2026 to ${tmpTarget.ProjectName}` : 'No document is listed to borrow a project from: widen the filters.');
				tmpModel.Buttons.push(fButton('Add', 'Add document', tmpReady && !!tmpTarget, tmpTarget ? `POST /1.0/Document { Status: 'Draft', DocumentDate: '${DOCUMENT_DATE}', IDFormType: ${tmpTarget.IDFormType}, IDProject: ${tmpTarget.IDProject} }` : ''));
				tmpModel.Buttons.push(fButton('Delete', 'Delete it', !!tmpDoc && tmpDoc.Live, tmpDoc ? `DELETE /1.0/Document/${tmpDoc.ID}` : 'Add a document first'));
				tmpModel.Buttons.push(fButton('Undelete', 'Undelete it', !!tmpDoc && !tmpDoc.Live, tmpDoc ? `GET /1.0/Document/Undelete/${tmpDoc.ID}` : 'Delete the added document first', 'fd-change-btn-undo'));
				break;
			}
			case 'LabFormComplete':
			{
				let tmpForm = tmpPanelState.Last;
				tmpModel.What = libFacetDisplay.text(tmpForm ? `${tmpForm.Completed ? 'Completed' : 'Re-opened'} my ${tmpForm.FormName} form for intake #${tmpForm.Intake}` : 'Complete one of my started forms (a Pending lab form of mine for a work-list row)');
				tmpModel.Buttons.push(fButton('Complete', tmpForm ? 'Complete another' : 'Complete a started form', tmpReady && !(tmpForm && tmpForm.Completed), 'Finds a Pending LabForm of mine for a Started work-list row (POST /1.0/Facet/LabForm/Records/0/1), then PUT /1.0/LabForm { Status: \'Complete\' }'));
				tmpModel.Buttons.push(fButton('Reopen', 'Re-open it', !!tmpForm && tmpForm.Completed, tmpForm ? `PUT /1.0/LabForm { IDLabForm: ${tmpForm.ID}, Status: 'Pending', CompletedDate: null }` : 'Complete a form first', 'fd-change-btn-undo'));
				break;
			}
			case 'ReviewAdd':
			{
				let tmpBook = this._reviewTarget(tmpState);
				let tmpReview = tmpPanelState.Last;
				tmpModel.What = libFacetDisplay.text((tmpReview && tmpReview.Live) ? `Added a 5-star review to "${tmpReview.Title}"` : (tmpBook ? `Add a 5-star review to "${tmpBook.Title}" (the first listed book without one)` : 'No book is listed: widen the filters.'));
				tmpModel.Buttons.push(fButton('Add', 'Add a 5-star review', tmpReady && !!tmpBook && !(tmpReview && tmpReview.Live), tmpBook ? `POST /1.0/Review { IDBook: ${tmpBook.IDBook}, Rating: 5 }` : ''));
				tmpModel.Buttons.push(fButton('Remove', 'Remove it', !!tmpReview && tmpReview.Live, tmpReview ? `DELETE /1.0/Review/${tmpReview.ID}` : 'Add a review first', 'fd-change-btn-undo'));
				break;
			}
			default:
				tmpModel.What = libFacetDisplay.text(`Unknown change [${pPanel.Action}].`);
				break;
		}
		tmpState.Widgets.Change = tmpModel;
		let tmpFocus = tmpProvider.captureFocus(pPanel.PanelID);
		this.render('FacetDemo-Change-Panel', `#${pPanel.PanelID}`, `AppData.Facet.Groups.${pPanel.Group}.Widgets.Change`);
		tmpProvider.restoreFocus(pPanel.PanelID, tmpFocus);
	}

	/**
	 * The book a demo review goes to: the first listed book with no 5-star review (from the Review lookup rows, when
	 * they are loaded), else the first listed book.
	 *
	 * @param {Record<string, any>} pState - the Books group
	 * @return {Record<string, any>|null}
	 */
	_reviewTarget(pState)
	{
		let tmpProvider = this.pict.providers.Facet;
		let tmpRows = this._rows(pState).filter((pRow) => { return typeof(pRow.IDBook) === 'number'; });
		let tmpBook = tmpRows.find(
			(pRow) =>
			{
				let tmpReviews = tmpProvider.lookupRows(pState.Domain, 'Review', 'IDBook', pRow.IDBook);
				return Array.isArray(tmpReviews) && !tmpReviews.some((pReview) => { return Number(pReview.Rating) === 5; });
			});
		return tmpBook || tmpRows[0] || null;
	}

	/**
	 * Data a panel needs before it draws (called by the page view after the group answered): the listed books'
	 * reviews for ReviewAdd.  Cached per principal by the provider; a change event of Review drops them.
	 *
	 * @param {Record<string, any>} pPanel
	 */
	preparePanel(pPanel)
	{
		if (pPanel.Action !== 'ReviewAdd')
		{
			return;
		}
		let tmpProvider = this.pict.providers.Facet;
		let tmpState = tmpProvider.group(pPanel.Group);
		if (!tmpState || (tmpState.Status !== 'Ready') || (tmpState.PrincipalKey !== tmpProvider.principalKey()))
		{
			return;
		}
		let tmpKeys = libFacetLookup.keysOf(this._rows(tmpState), 'IDBook');
		let tmpMissing = tmpKeys.filter((pKey) => { return typeof(tmpProvider.lookupRows(tmpState.Domain, 'Review', 'IDBook', pKey)) === 'undefined'; });
		if (tmpMissing.length < 1)
		{
			return;
		}
		tmpProvider.fetchLookup(tmpState.Domain, 'Review', 'IDBook', tmpMissing, { GroupHash: tmpState.Hash }, () => { this._rerender(); });
	}

	/**
	 * The form type and project a demo document gets: the first selected form type (else the first listed one) and
	 * the project of the first listed document.
	 *
	 * @param {Record<string, any>} pState - the Documents group
	 * @return {{ IDFormType: number, FormName: string, IDProject: number, ProjectName: string }|null}
	 */
	_documentTarget(pState)
	{
		let tmpProvider = this.pict.providers.Facet;
		let tmpSelected = libFacetSelection.selectedKeysOf(pState.Selections ? pState.Selections.ByForm : null);
		let tmpFormType = (tmpSelected.length > 0) ? tmpSelected[0] : null;
		if ((tmpFormType === null) && pState.Envelope && pState.Envelope.Facets && pState.Envelope.Facets.ByForm && Array.isArray(pState.Envelope.Facets.ByForm.Buckets) && pState.Envelope.Facets.ByForm.Buckets[0])
		{
			tmpFormType = pState.Envelope.Facets.ByForm.Buckets[0].Key;
		}
		let tmpRow = this._rows(pState).find((pCandidate) => { return typeof(pCandidate.IDProject) === 'number'; }) || null;
		if ((typeof(tmpFormType) !== 'number') || !tmpRow)
		{
			return null;
		}
		let tmpLabel = tmpProvider.labelOf(pState.Hash, 'ByForm', tmpFormType);
		let tmpProject = (tmpProvider.lookupRows(pState.Domain, 'Project', 'IDProject', tmpRow.IDProject) || [])[0] || null;
		return (
			{
				IDFormType: tmpFormType,
				FormName: (tmpLabel && tmpLabel.Label) ? String(tmpLabel.Label) : `form type #${tmpFormType}`,
				IDProject: tmpRow.IDProject,
				ProjectName: (tmpProject && tmpProject.Name) ? `"${tmpProject.Name}"` : `project #${tmpRow.IDProject}`
			});
	}

	/**
	 * Re-render the change panels of the page on screen.
	 */
	_rerender()
	{
		let tmpPageView = this.pict.views['FacetDemo-Page'];
		if (tmpPageView)
		{
			tmpPageView.renderPanels({ Widgets: [ 'Change' ] });
		}
	}

	/**
	 * Inline handler: the project select.
	 *
	 * @param {string} pGroupHash
	 * @param {string} pAction
	 * @param {string} pValue
	 */
	choose(pGroupHash, pAction, pValue)
	{
		let tmpPanelState = this._panelState(pAction);
		let tmpID = parseInt(pValue, 10);
		tmpPanelState.Selected = isNaN(tmpID) ? null : tmpID;
		this._rerender();
	}

	/**
	 * One write through the provider (logged as a 'Write' exchange).  Without an open change stream the group is
	 * refreshed directly (and the status says so); with one, nothing is refreshed here.
	 *
	 * @param {string} pGroupHash
	 * @param {string} pAction
	 * @param {{ Method: string, Path: string, Body: any, Done: string }} pWrite - Done: what the status says on success
	 * @param {(pError: Error|null, pResponse?: Record<string, any>) => void} fCallback
	 */
	_write(pGroupHash, pAction, pWrite, fCallback)
	{
		let tmpProvider = this.pict.providers.Facet;
		let tmpState = tmpProvider.group(pGroupHash);
		let tmpPanelState = this._panelState(pAction);
		tmpPanelState.Busy = true;
		tmpPanelState.Status = 'Writing';
		tmpPanelState.Tone = 'muted';
		tmpPanelState.Message = libFacetDisplay.text(`${pWrite.Method} ${pWrite.Path} …`);
		this._rerender();
		tmpProvider.write(tmpState.Domain, pWrite.Method, pWrite.Path, pWrite.Body, { GroupHash: pGroupHash },
			(pError, pResponse) =>
			{
				tmpPanelState.Busy = false;
				let tmpResponse = pResponse || {};
				if (!tmpResponse.Ok)
				{
					let tmpError = tmpResponse.Error || { Code: 'DEMO_NETWORK', Message: 'No answer.' };
					tmpPanelState.Status = 'Error';
					tmpPanelState.Tone = 'error';
					tmpPanelState.Message = libFacetDisplay.text(`${pWrite.Method} ${pWrite.Path} → ${tmpResponse.Status || 'network'} ${tmpError.Code}: ${tmpError.Message}`);
					this._rerender();
					return fCallback(new Error(tmpError.Code));
				}
				let tmpStream = tmpProvider.changeState(tmpState.Domain);
				let tmpLive = !!tmpStream && (tmpStream.Status === 'Open');
				tmpPanelState.Status = 'Done';
				tmpPanelState.Tone = 'ok';
				tmpPanelState.Message = libFacetDisplay.text(`${pWrite.Method} ${pWrite.Path} → ${tmpResponse.Status}. ${pWrite.Done} ${tmpLive ? 'The cards update when the change stream reports it.' : 'No change stream is open: the page refreshed itself.'}`);
				if (!tmpLive)
				{
					// No change stream (a host without M4, a stream that was refused): refetch the domain's groups on this
					// page (Exact: no cached answer from before the write) and mark the others, as an event would.
					tmpProvider.refetchDomain(tmpState.Domain, null, 'Refreshed after my write (no change stream)');
				}
				this._rerender();
				return fCallback(null, tmpResponse);
			});
	}

	/**
	 * Report a problem without writing.
	 *
	 * @param {string} pAction
	 * @param {string} pMessage
	 */
	_fail(pAction, pMessage)
	{
		let tmpPanelState = this._panelState(pAction);
		tmpPanelState.Busy = false;
		tmpPanelState.Status = 'Error';
		tmpPanelState.Tone = 'warn';
		tmpPanelState.Message = libFacetDisplay.text(pMessage);
		this._rerender();
	}

	/**
	 * Inline handler: a panel button.
	 *
	 * @param {string} pGroupHash
	 * @param {string} pAction
	 * @param {string} pOp
	 * @param {(pError: Error|null) => void} [fCallback] - (tests) when the write finished
	 */
	act(pGroupHash, pAction, pOp, fCallback)
	{
		let fDone = (typeof(fCallback) === 'function') ? fCallback : () => {};
		let tmpProvider = this.pict.providers.Facet;
		let tmpState = tmpProvider.group(pGroupHash);
		let tmpPanelState = this._panelState(pAction);
		if (!tmpState || tmpPanelState.Busy)
		{
			return fDone(new Error('busy'));
		}
		switch (pAction)
		{
			case 'ProjectStatus':
				return this._actProjectStatus(tmpState, tmpPanelState, pOp, fDone);
			case 'DocumentAdd':
				return this._actDocument(tmpState, tmpPanelState, pOp, fDone);
			case 'LabFormComplete':
				return this._actLabForm(tmpState, tmpPanelState, pOp, fDone);
			case 'ReviewAdd':
				return this._actReview(tmpState, tmpPanelState, pOp, fDone);
			default:
				return fDone(new Error(`unknown action ${pAction}`));
		}
	}

	_actProjectStatus(pState, pPanelState, pOp, fDone)
	{
		let tmpRows = this._rows(pState).filter((pRow) => { return typeof(pRow.IDProject) === 'number'; });
		if (pOp === 'Undo')
		{
			let tmpLast = pPanelState.Last;
			if (!tmpLast || (PROJECT_STATUSES.indexOf(tmpLast.From) < 0))
			{
				return fDone(new Error('nothing to undo'));
			}
			return this._write(pState.Hash, 'ProjectStatus', { Method: 'PUT', Path: '/1.0/Project', Body: { IDProject: tmpLast.ID, Status: tmpLast.From }, Done: `"${tmpLast.Name}" is ${PROJECT_STATUS_LABELS[tmpLast.From]} again.` },
				(pError) =>
				{
					if (!pError)
					{
						pPanelState.Last = null;
						pPanelState.Selected = tmpLast.ID;
						this._rerender();
					}
					return fDone(pError);
				});
		}
		let tmpStatus = pOp.replace(/^Set-/, '');
		let tmpRow = tmpRows.find((pRow) => { return pRow.IDProject === pPanelState.Selected; }) || tmpRows[0] || null;
		if (!tmpRow || (PROJECT_STATUSES.indexOf(tmpStatus) < 0))
		{
			return fDone(new Error('no project'));
		}
		let tmpName = tmpRow.Name || `Project #${tmpRow.IDProject}`;
		return this._write(pState.Hash, 'ProjectStatus', { Method: 'PUT', Path: '/1.0/Project', Body: { IDProject: tmpRow.IDProject, Status: tmpStatus }, Done: `"${tmpName}" is now ${PROJECT_STATUS_LABELS[tmpStatus]} (was ${PROJECT_STATUS_LABELS[tmpRow.Status] || tmpRow.Status || 'no status'}).` },
			(pError) =>
			{
				if (!pError)
				{
					// Undo goes back to the status it had before the FIRST change since the last undo.
					let tmpFrom = (pPanelState.Last && (pPanelState.Last.ID === tmpRow.IDProject)) ? pPanelState.Last.From : tmpRow.Status;
					pPanelState.Last = { ID: tmpRow.IDProject, Name: tmpName, From: tmpFrom, To: tmpStatus };
					pPanelState.Selected = tmpRow.IDProject;
					this._rerender();
				}
				return fDone(pError);
			});
	}

	_actDocument(pState, pPanelState, pOp, fDone)
	{
		let tmpDoc = pPanelState.Last;
		if (pOp === 'Delete')
		{
			if (!tmpDoc || !tmpDoc.Live)
			{
				return fDone(new Error('nothing to delete'));
			}
			return this._write(pState.Hash, 'DocumentAdd', { Method: 'DELETE', Path: `/1.0/Document/${tmpDoc.ID}`, Body: null, Done: `Document #${tmpDoc.ID} is deleted (soft: it can be undeleted).` },
				(pError) => { if (!pError) { tmpDoc.Live = false; this._rerender(); } return fDone(pError); });
		}
		if (pOp === 'Undelete')
		{
			if (!tmpDoc || tmpDoc.Live)
			{
				return fDone(new Error('nothing to undelete'));
			}
			return this._write(pState.Hash, 'DocumentAdd', { Method: 'GET', Path: `/1.0/Document/Undelete/${tmpDoc.ID}`, Body: null, Done: `Document #${tmpDoc.ID} is back.` },
				(pError) => { if (!pError) { tmpDoc.Live = true; this._rerender(); } return fDone(pError); });
		}
		let tmpTarget = this._documentTarget(pState);
		if (!tmpTarget)
		{
			return fDone(new Error('no target'));
		}
		let tmpTitle = `Demo document ${nowStamp().slice(11)}`;
		return this._write(pState.Hash, 'DocumentAdd',
			{
				Method: 'POST', Path: '/1.0/Document',
				Body: { Title: tmpTitle, Status: 'Draft', DocumentDate: DOCUMENT_DATE, IDFormType: tmpTarget.IDFormType, IDProject: tmpTarget.IDProject },
				Done: `Added "${tmpTitle}" (${tmpTarget.FormName}, Mar 15, 2026).`
			},
			(pError, pResponse) =>
			{
				if (!pError && pResponse && pResponse.Body && (typeof(pResponse.Body.IDDocument) === 'number'))
				{
					pPanelState.Last = { ID: pResponse.Body.IDDocument, Title: tmpTitle, Live: true };
					this._rerender();
				}
				return fDone(pError);
			});
	}

	/**
	 * A Pending LabForm of mine for a work-list row (that row is Started; completing the form takes it off the
	 * list): the rows on screen first, else every row of the list; confirmed through POST
	 * /1.0/Facet/LabForm/Records/0/1 (personal scope: only my forms).
	 *
	 * @param {Record<string, any>} pState - LabFormsA
	 * @param {(pError: Error|null, pForm?: Record<string, any>) => void} fCallback
	 */
	_findStartedForm(pState, fCallback)
	{
		let tmpProvider = this.pict.providers.Facet;
		let tmpDomain = pState.Domain;
		let fPick = (pRows, fNext) =>
		{
			let tmpIntakes = libFacetLookup.keysOf(pRows, 'IDMaterialIntake');
			tmpProvider.fetchLookup(tmpDomain, 'LabForm', 'IDMaterialIntake', tmpIntakes, { GroupHash: pState.Hash },
				(pLookupError) =>
				{
					if (pLookupError)
					{
						return fNext(pLookupError);
					}
					for (let i = 0; i < pRows.length; i++)
					{
						let tmpForms = tmpProvider.lookupRows(tmpDomain, 'LabForm', 'IDMaterialIntake', pRows[i].IDMaterialIntake) || [];
						let tmpForm = tmpForms.find((pForm) => { return libFacetSelection.sameKey(pForm.IDLabFormType, pRows[i].IDLabFormType) && (pForm.Status === 'Pending'); });
						if (tmpForm)
						{
							return fNext(null, pRows[i]);
						}
					}
					return fNext(null, null);
				});
		};
		let fConfirm = (pRow) =>
		{
			let tmpBody = { Clauses: [ libFacetSelection.lookupClause('IDMaterialIntake', [ pRow.IDMaterialIntake ]), libFacetSelection.lookupClause('IDLabFormType', [ pRow.IDLabFormType ]), libFacetSelection.lookupClause('Status', [ 'Pending' ]) ] };
			tmpProvider.request(tmpDomain, 'POST', '/1.0/Facet/LabForm/Records/0/1', tmpBody, { GroupHash: pState.Hash, Kind: 'Lookup' },
				(pError, pResponse) =>
				{
					let tmpForm = (pResponse && pResponse.Ok && Array.isArray(pResponse.Body)) ? pResponse.Body[0] : null;
					if (!tmpForm || (typeof(tmpForm.IDLabForm) !== 'number'))
					{
						return fCallback(new Error('The started form is gone (someone completed it): try again.'));
					}
					return fCallback(null, tmpForm);
				});
		};
		fPick(this._rows(pState),
			(pError, pRow) =>
			{
				if (pError)
				{
					return fCallback(pError);
				}
				if (pRow)
				{
					return fConfirm(pRow);
				}
				tmpProvider.fetchAllRecords(pState.Hash,
					(pRowsError, pRows) =>
					{
						if (pRowsError)
						{
							return fCallback(pRowsError);
						}
						fPick(pRows || [],
							(pPickError, pAnyRow) =>
							{
								if (pPickError)
								{
									return fCallback(pPickError);
								}
								if (!pAnyRow)
								{
									return fCallback(new Error('No started form of mine is on the work list.'));
								}
								return fConfirm(pAnyRow);
							});
					});
			});
	}

	_actLabForm(pState, pPanelState, pOp, fDone)
	{
		let tmpProvider = this.pict.providers.Facet;
		let tmpForm = pPanelState.Last;
		if (pOp === 'Reopen')
		{
			if (!tmpForm || !tmpForm.Completed)
			{
				return fDone(new Error('nothing to re-open'));
			}
			return this._write(pState.Hash, 'LabFormComplete', { Method: 'PUT', Path: '/1.0/LabForm', Body: { IDLabForm: tmpForm.ID, Status: 'Pending', CompletedDate: null }, Done: `${tmpForm.FormName} for intake #${tmpForm.Intake} is Pending again: back on the list.` },
				(pError) => { if (!pError) { tmpForm.Completed = false; this._rerender(); } return fDone(pError); });
		}
		pPanelState.Busy = true;
		pPanelState.Tone = 'muted';
		pPanelState.Message = 'Looking for a started form of mine …';
		this._rerender();
		this._findStartedForm(pState,
			(pError, pFound) =>
			{
				pPanelState.Busy = false;
				if (pError)
				{
					this._fail('LabFormComplete', pError.message);
					return fDone(pError);
				}
				let tmpType = (tmpProvider.lookupRows(pState.Domain, 'LabFormType', 'IDLabFormType', pFound.IDLabFormType) || [])[0] || null;
				let tmpLabel = tmpProvider.labelOf(pState.Hash, 'ToDo', pFound.IDLabFormType);
				let tmpName = (tmpType && tmpType.Name) ? tmpType.Name : ((tmpLabel && tmpLabel.Label) ? tmpLabel.Label : `form type #${pFound.IDLabFormType}`);
				return this._write(pState.Hash, 'LabFormComplete', { Method: 'PUT', Path: '/1.0/LabForm', Body: { IDLabForm: pFound.IDLabForm, Status: 'Complete', CompletedDate: nowStamp() }, Done: `Completed my ${tmpName} form for intake #${pFound.IDMaterialIntake}: it leaves the work list.` },
					(pWriteError) =>
					{
						if (!pWriteError)
						{
							pPanelState.Last = { ID: pFound.IDLabForm, Intake: pFound.IDMaterialIntake, FormType: pFound.IDLabFormType, FormName: tmpName, Completed: true };
							this._rerender();
						}
						return fDone(pWriteError);
					});
			});
	}

	_actReview(pState, pPanelState, pOp, fDone)
	{
		let tmpReview = pPanelState.Last;
		if (pOp === 'Remove')
		{
			if (!tmpReview || !tmpReview.Live)
			{
				return fDone(new Error('nothing to remove'));
			}
			return this._write(pState.Hash, 'ReviewAdd', { Method: 'DELETE', Path: `/1.0/Review/${tmpReview.ID}`, Body: null, Done: `The review of "${tmpReview.Title}" is removed.` },
				(pError) => { if (!pError) { tmpReview.Live = false; this._rerender(); } return fDone(pError); });
		}
		if (tmpReview && tmpReview.Live)
		{
			return fDone(new Error('a review is already added'));
		}
		let tmpProvider = this.pict.providers.Facet;
		tmpProvider.fetchLookup(pState.Domain, 'Review', 'IDBook', libFacetLookup.keysOf(this._rows(pState), 'IDBook'), { GroupHash: pState.Hash },
			() =>
			{
				let tmpBook = this._reviewTarget(pState);
				if (!tmpBook)
				{
					return fDone(new Error('no book'));
				}
				return this._write(pState.Hash, 'ReviewAdd', { Method: 'POST', Path: '/1.0/Review', Body: { IDBook: tmpBook.IDBook, Rating: 5, Text: REVIEW_TEXT }, Done: `"${tmpBook.Title}" (#${tmpBook.IDBook}) has a new 5-star review.` },
					(pError, pResponse) =>
					{
						if (!pError && pResponse && pResponse.Body && (typeof(pResponse.Body.IDReview) === 'number'))
						{
							pPanelState.Last = { ID: pResponse.Body.IDReview, IDBook: tmpBook.IDBook, Title: tmpBook.Title, Live: true };
							this._rerender();
						}
						return fDone(pError);
					});
			});
	}

	onAfterRender(pRenderable, pRenderDestinationAddress, pRecord, pContent)
	{
		this.pict.CSSMap.injectCSS();
		return super.onAfterRender(pRenderable, pRenderDestinationAddress, pRecord, pContent);
	}
}

module.exports = PictViewFacetDemoChange;
module.exports.default_configuration = _ViewConfiguration;
module.exports.PROJECT_STATUSES = PROJECT_STATUSES;
module.exports.DOCUMENT_DATE = DOCUMENT_DATE;
module.exports.REVIEW_TEXT = REVIEW_TEXT;
