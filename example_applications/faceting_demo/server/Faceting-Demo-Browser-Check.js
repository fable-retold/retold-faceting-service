#!/usr/bin/env node
/**
 * Faceting-Demo-Browser-Check -- `npm run check:browser`: drive the BUILT single-page app in a real headless
 * Chrome (puppeteer, resolved from the retold umbrella node_modules; it is not a dependency of the demo) and
 * prove the end-to-end promise of every page: a gesture on a widget sends ONE coalesced Query POST, the page
 * Total becomes the bucket's count, and "Verify with Records/Count" (POST …/Records/Count with the same
 * filter) agrees with it.  Screenshots of each state land in screenshots/.
 *
 *   Projects   load 6 (one Describe GET + one Query POST) · OnHold -> 7 (Status counts unchanged) ·
 *              drag Feb–Jul -> 5 · reset · pivot cell Active × Iris Media -> 2 · single Started bar ->
 *              its count · repeat state -> 304
 *   Requests   three changes in one tick -> one POST · keyboard Enter on a bar · offline -> DEMO_NETWORK,
 *              back online + Reset recovers
 *   Documents  load 41 · Form G -> 58 (every form count unchanged) · single month bar -> its count ·
 *              interval "day" -> inline 422 + "Use week"
 *   Lab forms  A 237 · Lab Form H -> 41 · Physics -> 84 · + week drag 0..4 -> 8 · tab B 224 + Compare
 *   Bookstore  1436 · Well reviewed -> 1250 · drag 2000–2019 -> 614 · Genre bucket -> its count
 *   Principals user81: Projects 1, Books 81 · user43 empty state · no roles -> FACET_PARAM_INVALID ·
 *              anonymous -> FACET_UNAUTHENTICATED
 *   Inspector  open drawer, Envelope tab, Escape closes it, the page keeps room for it; the bar names the page
 *              and says "kept" when a page is shown again without a new request
 *   Review     the histogram readout says the clause span and the page Total (week interval: partial edge
 *              bars, Total unchanged) · a count verdict is dropped when the principal changes · a principal
 *              switch on page 2 goes back to page 1 · focus stays on a bar after Enter · the work list shows
 *              the looked-up intake fields · user44's empty Lab forms state names the reason
 *   Layout     the other theme · 800px and 390px wide without horizontal scroll · a #/Bookstore deep link
 *   Console    no page errors
 *
 * Boots the demo in-process on DEMO_CHECK_PORT (19302) unless DEMO_URL points at a running host.  Needs
 * dist/ (npm run build).  Exit 0 when every check passes.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFS = require('node:fs');
const libPath = require('node:path');

const EXAMPLE_ROOT = libPath.resolve(__dirname, '..');
const SCREENSHOT_ROOT = libPath.join(EXAMPLE_ROOT, 'screenshots');
const CHECK_PORT = parseInt(process.env.DEMO_CHECK_PORT || '19302', 10);
const VIEWPORT = { width: 1360, height: 1000 };

let libPuppeteer = null;
try
{
	libPuppeteer = require('puppeteer');
}
catch (pError)
{
	console.error('Faceting-Demo-Browser-Check: puppeteer is not resolvable from here (it lives in the retold umbrella node_modules, not in this example).');
	process.exit(2);
}

let _Checks = 0;
let _Failures = [];
let _Shots = [];

const check = (pCondition, pLabel) =>
{
	_Checks++;
	if (!pCondition)
	{
		_Failures.push(pLabel);
		console.log(`    FAIL ${pLabel}`);
	}
	return !!pCondition;
};

const sleep = (pMS) => { return new Promise((fResolve) => { setTimeout(fResolve, pMS); }); };

/**
 * Track facet requests the page sends (method + path), so a gesture can be checked for "one POST".
 */
class NetworkLog
{
	constructor(pPage)
	{
		this.InFlight = 0;
		this.Entries = [];
		pPage.on('request', (pRequest) =>
			{
				if (pRequest.url().indexOf('/api/') < 0)
				{
					return;
				}
				this.InFlight++;
				this.Entries.push({ Method: pRequest.method(), URL: pRequest.url(), Status: null });
			});
		const fDone = (pRequest, pStatus) =>
			{
				if (pRequest.url().indexOf('/api/') < 0)
				{
					return;
				}
				this.InFlight = Math.max(0, this.InFlight - 1);
				let tmpEntry = this.Entries.slice().reverse().find((pEntry) => { return (pEntry.URL === pRequest.url()) && (pEntry.Status === null); });
				if (tmpEntry)
				{
					tmpEntry.Status = pStatus;
				}
			};
		pPage.on('requestfinished', (pRequest) => { fDone(pRequest, pRequest.response() ? pRequest.response().status() : 0); });
		pPage.on('requestfailed', (pRequest) => { fDone(pRequest, 'failed'); });
	}

	mark()
	{
		this._Mark = this.Entries.length;
	}

	since()
	{
		return this.Entries.slice(this._Mark || 0);
	}

	queryPosts()
	{
		return this.since().filter((pEntry) => { return (pEntry.Method === 'POST') && /\/Query$/.test(pEntry.URL); });
	}
}

/**
 * Wait until the network is quiet and every visible group has settled (no coalesce timer, no Loading).
 */
const settle = async (pPage, pNetwork) =>
{
	let tmpQuietSince = 0;
	for (let i = 0; i < 200; i++)
	{
		let tmpBusy = await pPage.evaluate(
			() =>
			{
				if (!window._Pict || !_Pict.AppData.FacetDemo || !_Pict.AppData.FacetDemo.Ready)
				{
					return true;
				}
				let tmpProvider = _Pict.providers.Facet;
				let tmpTimers = tmpProvider._CoalesceTimers || {};
				if (Object.keys(tmpTimers).some((pKey) => { return !!tmpTimers[pKey]; }))
				{
					return true;
				}
				let tmpGroups = _Pict.AppData.Facet.Groups;
				return Object.keys(tmpGroups).some(
					(pKey) =>
					{
						let tmpState = tmpGroups[pKey];
						return (tmpState.Status === 'Loading') || (tmpState.RecordsPage && (tmpState.RecordsPage.Status === 'Loading')) || (tmpState.RecordsPage && tmpState.RecordsPage.Lookup && (tmpState.RecordsPage.Lookup.Status === 'Loading')) || (tmpState.CountCheck && (tmpState.CountCheck.Status === 'Loading'));
					}) || !!(_Pict.AppData.FacetDemo.CompareBreakdown && (_Pict.AppData.FacetDemo.CompareBreakdown.Status === 'Loading'));
			});
		if (tmpBusy || (pNetwork.InFlight > 0))
		{
			tmpQuietSince = 0;
		}
		else if (!tmpQuietSince)
		{
			tmpQuietSince = Date.now();
		}
		else if ((Date.now() - tmpQuietSince) > 120)
		{
			return;
		}
		await sleep(20);
	}
	throw new Error('the page did not settle within 4 s');
};

const groupState = async (pPage, pGroup) =>
{
	return pPage.evaluate(
		(pGroupHash) =>
		{
			let tmpState = _Pict.AppData.Facet.Groups[pGroupHash];
			let tmpEnvelope = tmpState.Envelope;
			return (
				{
					Status: tmpState.Status,
					Total: (tmpEnvelope && (typeof(tmpEnvelope.Total) === 'number')) ? tmpEnvelope.Total : null,
					ErrorCode: tmpState.Error ? tmpState.Error.Code : null,
					Rows: (tmpState.RecordsPage && Array.isArray(tmpState.RecordsPage.Rows)) ? tmpState.RecordsPage.Rows.length : null,
					CountCheck: tmpState.CountCheck,
					Facets: tmpEnvelope && tmpEnvelope.Facets ? Object.keys(tmpEnvelope.Facets).reduce(
						(pMap, pKey) =>
						{
							let tmpFacet = tmpEnvelope.Facets[pKey];
							pMap[pKey] = Array.isArray(tmpFacet.Buckets) ? tmpFacet.Buckets.map((pBucket) => { return { Key: pBucket.Key, Count: pBucket.Count, Selected: !!pBucket.Selected }; }) : null;
							return pMap;
						}, {}) : {}
				});
		}, pGroup);
};

const domTotal = async (pPage) =>
{
	return pPage.evaluate(
		() =>
		{
			let tmpElement = document.querySelector('#FD-Page-Head .fd-total');
			return tmpElement ? parseInt(tmpElement.textContent.replace(/[^0-9]/g, ''), 10) : null;
		});
};

const domRowCount = async (pPage, pPanelID) =>
{
	return pPage.evaluate((pID) => { let tmpRoot = document.getElementById(pID); return tmpRoot ? tmpRoot.querySelectorAll('tbody tr').length : null; }, pPanelID);
};

const domRange = async (pPage, pPanelID) =>
{
	return pPage.evaluate((pID) => { let tmpRoot = document.getElementById(pID); let tmpRange = tmpRoot ? tmpRoot.querySelector('.facet-rec-range') : null; return tmpRange ? tmpRange.textContent.trim() : null; }, pPanelID);
};

/**
 * A whole-page screenshot: the viewport grows to the document height first, so the fixed inspector bar
 * sits at the bottom of the image (a fullPage capture would paint it mid-page).
 */
const shot = async (pPage, pName) =>
{
	let tmpPath = libPath.join(SCREENSHOT_ROOT, `${pName}.png`);
	// Park the pointer off the widgets so a hover readout does not replace the selection readout.
	await pPage.mouse.move(2, 2);
	let tmpViewport = pPage.viewport();
	let tmpHeight = await pPage.evaluate(() => { return Math.ceil(document.documentElement.scrollHeight); });
	let tmpScrollY = await pPage.evaluate(() => { return window.scrollY; });
	if (tmpHeight > tmpViewport.height)
	{
		await pPage.setViewport({ width: tmpViewport.width, height: Math.min(tmpHeight, 6000) });
		await sleep(150);
	}
	await pPage.screenshot({ path: tmpPath });
	if (tmpHeight > tmpViewport.height)
	{
		await pPage.setViewport(tmpViewport);
		await pPage.evaluate((pY) => { window.scrollTo(0, pY); }, tmpScrollY);
		await sleep(50);
	}
	_Shots.push(tmpPath);
	console.log(`    screenshot ${libPath.relative(EXAMPLE_ROOT, tmpPath)}`);
};

/**
 * Find a terms bucket element (checklist row, chip or bar row) by its label inside a panel; return its
 * count text and a click target selector-free handle.
 */
const findTerm = async (pPage, pPanelID, pLabel) =>
{
	let tmpHandle = await pPage.evaluateHandle(
		(pID, pText) =>
		{
			let tmpRoot = document.getElementById(pID);
			if (!tmpRoot)
			{
				return null;
			}
			let tmpElements = tmpRoot.querySelectorAll('.facet-check-row, button.facet-chip, button.facet-bar-row');
			for (let i = 0; i < tmpElements.length; i++)
			{
				let tmpLabel = tmpElements[i].querySelector('.facet-check-label, .facet-chip-label, .facet-bar-row-label');
				if (tmpLabel && (tmpLabel.textContent.trim() === pText))
				{
					return tmpElements[i];
				}
			}
			return null;
		}, pPanelID, pLabel);
	let tmpElement = tmpHandle.asElement();
	if (!tmpElement)
	{
		throw new Error(`no bucket labelled [${pLabel}] in #${pPanelID}`);
	}
	let tmpCount = await tmpElement.evaluate((pElement) => { let tmpCount = pElement.querySelector('.facet-check-count, .facet-chip-count, .facet-bar-count'); return tmpCount ? parseInt(tmpCount.textContent.replace(/[^0-9]/g, ''), 10) : null; });
	// A real mouse click at the bucket's center (the checkbox row is a <label>: the click toggles its input).
	const fClick = async () =>
	{
		let tmpPoint = await tmpElement.evaluate((pElement) => { pElement.scrollIntoView({ block: 'center' }); let tmpBox = pElement.getBoundingClientRect(); return { X: tmpBox.left + Math.min(40, tmpBox.width / 2), Y: tmpBox.top + (tmpBox.height / 2) }; });
		await pPage.mouse.click(tmpPoint.X, tmpPoint.Y);
	};
	return { Element: tmpElement, Count: tmpCount, click: fClick };
};

/**
 * Click the first element matching a selector whose text contains pText, the way a user does: scroll it
 * into view, then a real mouse click at its center (a widget may re-render between the lookup and the
 * click; the control is still under the pointer, an element handle would be detached).
 */
const clickByText = async (pPage, pSelector, pText, pWithin) =>
{
	let tmpPoint = await pPage.evaluate(
		(pSel, pLabel, pRootID) =>
		{
			let tmpRoot = pRootID ? document.getElementById(pRootID) : document;
			let tmpElements = tmpRoot ? tmpRoot.querySelectorAll(pSel) : [];
			for (let i = 0; i < tmpElements.length; i++)
			{
				if (tmpElements[i].textContent.replace(/\s+/g, ' ').trim().indexOf(pLabel) >= 0)
				{
					tmpElements[i].scrollIntoView({ block: 'center' });
					let tmpBox = tmpElements[i].getBoundingClientRect();
					return { X: tmpBox.left + (tmpBox.width / 2), Y: tmpBox.top + (tmpBox.height / 2) };
				}
			}
			return null;
		}, pSelector, pText, pWithin || null);
	if (!tmpPoint)
	{
		throw new Error(`no [${pSelector}] containing [${pText}]${pWithin ? ` in #${pWithin}` : ''}`);
	}
	await pPage.mouse.click(tmpPoint.X, tmpPoint.Y);
};

const histogramBars = async (pPage, pBarsID) =>
{
	return pPage.evaluate(
		(pID) =>
		{
			let tmpRoot = document.getElementById(pID);
			if (!tmpRoot)
			{
				return [];
			}
			return Array.prototype.map.call(tmpRoot.querySelectorAll('.facet-hist-col'),
				(pColumn) =>
				{
					let tmpBox = pColumn.getBoundingClientRect();
					return { Index: parseInt(pColumn.getAttribute('data-index'), 10), Label: pColumn.getAttribute('aria-label') || pColumn.getAttribute('title'), X: tmpBox.left + (tmpBox.width / 2), Y: tmpBox.top + (tmpBox.height / 2), Selected: /selected/.test(pColumn.className) };
				});
		}, pBarsID);
};

const dragBars = async (pPage, pBarsID, pFrom, pTo) =>
{
	await pPage.evaluate((pID) => { document.getElementById(pID).scrollIntoView({ block: 'center' }); }, pBarsID);
	let tmpBars = await histogramBars(pPage, pBarsID);
	let tmpA = tmpBars.find((pBar) => { return pBar.Index === pFrom; });
	let tmpB = tmpBars.find((pBar) => { return pBar.Index === pTo; });
	await pPage.mouse.move(tmpA.X, tmpA.Y);
	await pPage.mouse.down();
	let tmpSteps = 8;
	for (let i = 1; i <= tmpSteps; i++)
	{
		await pPage.mouse.move(tmpA.X + ((tmpB.X - tmpA.X) * i / tmpSteps), tmpA.Y);
		await sleep(10);
	}
	await pPage.mouse.up();
};

const clickBar = async (pPage, pBarsID, pIndex) =>
{
	await pPage.evaluate((pID) => { document.getElementById(pID).scrollIntoView({ block: 'center' }); }, pBarsID);
	let tmpBars = await histogramBars(pPage, pBarsID);
	let tmpBar = tmpBars.find((pBar) => { return pBar.Index === pIndex; });
	await pPage.mouse.click(tmpBar.X, tmpBar.Y);
	return tmpBar;
};

const verifyRecords = async (pPage, pNetwork, pGroup, pPanelID, pLabel) =>
{
	await clickByText(pPage, 'button.facet-btn', 'Verify with Records/Count', pPanelID);
	await settle(pPage, pNetwork);
	let tmpState = await groupState(pPage, pGroup);
	let tmpCheck = tmpState.CountCheck || {};
	check(tmpCheck.Status === 'Ready' && tmpCheck.Agrees === true && (tmpCheck.Count === tmpState.Total), `${pLabel}: Records/Count ${tmpCheck.Count} == Total ${tmpState.Total}`);
	let tmpBadge = await pPage.evaluate((pID) => { let tmpBadge = document.querySelector(`#${pID} .facet-rec-check`); return tmpBadge ? tmpBadge.textContent.replace(/\s+/g, ' ').trim() : null; }, pPanelID);
	check(tmpBadge && (tmpBadge.indexOf(String(tmpState.Total.toLocaleString('en-US'))) >= 0 || tmpBadge.indexOf(String(tmpState.Total)) >= 0), `${pLabel}: the verify badge shows the count [${tmpBadge}]`);
	let tmpRows = await domRowCount(pPage, pPanelID);
	check(tmpRows === Math.min(25, tmpState.Total), `${pLabel}: the list shows ${tmpRows} rows == min(25, ${tmpState.Total})`);
	let tmpRange = await domRange(pPage, pPanelID);
	check(tmpRange && (new RegExp(`of ${tmpState.Total.toLocaleString('en-US')}$`).test(tmpRange) || (tmpState.Total === 0)), `${pLabel}: the list header says [${tmpRange}]`);
	console.log(`    ${pLabel}: Total ${tmpState.Total} · Records/Count ${tmpCheck.Count} · rows ${tmpRows} · [${tmpRange}]`);
	return tmpState;
};

/**
 * One gesture: mark the network, run it, settle, and check exactly one Query POST went out.
 */
const gesture = async (pPage, pNetwork, pLabel, fAction, pExpectPosts) =>
{
	pNetwork.mark();
	await fAction();
	await settle(pPage, pNetwork);
	let tmpPosts = pNetwork.queryPosts();
	let tmpExpect = (typeof(pExpectPosts) === 'number') ? pExpectPosts : 1;
	check(tmpPosts.length === tmpExpect, `${pLabel}: ${tmpPosts.length} Query POST(s) (expected ${tmpExpect})`);
	return tmpPosts;
};

const navigate = async (pPage, pNetwork, pRoute) =>
{
	await pPage.evaluate((pPath) => { _Pict.PictApplication.navigateTo(pPath); }, pRoute);
	await settle(pPage, pNetwork);
	await pPage.evaluate(() => { window.scrollTo(0, 0); });
};

const setPersona = async (pPage, pNetwork, pKey) =>
{
	await pPage.select('#FD-Principal', pKey);
	await settle(pPage, pNetwork);
};

const resetPage = async (pPage, pNetwork) =>
{
	await clickByText(pPage, 'button.fd-reset', 'Reset');
	await settle(pPage, pNetwork);
};

const runProjects = async (pPage, pNetwork) =>
{
	console.log('  Projects for me');
	await navigate(pPage, pNetwork, '/Projects');
	let tmpState = await groupState(pPage, 'Projects');
	check(tmpState.Total === 6 && (await domTotal(pPage)) === 6, `Projects: initial Total 6 (got ${tmpState.Total})`);
	let tmpBands = (tmpState.Facets.MyOverdue || []).map((pBucket) => { return pBucket.Count; }).join(',');
	check(tmpBands === '0,3,2,1', `Projects: overdue bands 0,3,2,1 (got ${tmpBands})`);
	await shot(pPage, '01-projects-initial');

	let tmpStatusBefore = JSON.stringify(tmpState.Facets.Status.map((pBucket) => { return pBucket.Count; }));
	let tmpOnHold = await findTerm(pPage, 'FD-P-Projects-Status', 'OnHold');
	await gesture(pPage, pNetwork, 'Projects + OnHold', async () => { await tmpOnHold.click(); });
	tmpState = await groupState(pPage, 'Projects');
	check(tmpState.Total === 7, `Projects + OnHold: Total 7 = 6 + OnHold ${tmpOnHold.Count} (got ${tmpState.Total})`);
	check(JSON.stringify(tmpState.Facets.Status.map((pBucket) => { return pBucket.Count; })) === tmpStatusBefore, 'Projects + OnHold: Status counts unchanged (disjunctive)');
	await verifyRecords(pPage, pNetwork, 'Projects', 'FD-P-Projects-Records', 'Projects + OnHold');
	await shot(pPage, '02-projects-onhold');

	// Drag Feb..Jul 2026 on the month bars (buckets start Dec 2025: index 2..7).
	let tmpBars = await histogramBars(pPage, 'FD-P-Projects-Started-Bars');
	let tmpFeb = tmpBars.findIndex((pBar) => { return /Feb 2026/.test(pBar.Label); });
	let tmpJul = tmpBars.findIndex((pBar) => { return /Jul 2026/.test(pBar.Label); });
	await gesture(pPage, pNetwork, 'Projects drag Feb–Jul', async () => { await dragBars(pPage, 'FD-P-Projects-Started-Bars', tmpBars[tmpFeb].Index, tmpBars[tmpJul].Index); });
	tmpState = await groupState(pPage, 'Projects');
	check(tmpState.Total === 5, `Projects + OnHold + drag Feb–Jul: Total 5 (got ${tmpState.Total})`);
	tmpBars = await histogramBars(pPage, 'FD-P-Projects-Started-Bars');
	let tmpSelected = tmpBars.filter((pBar) => { return pBar.Selected; }).map((pBar) => { return pBar.Index; });
	check(JSON.stringify(tmpSelected) === JSON.stringify([ 2, 3, 4, 5, 6, 7 ]), `Projects drag: bars Feb–Jul highlighted (got ${JSON.stringify(tmpSelected)})`);
	await verifyRecords(pPage, pNetwork, 'Projects', 'FD-P-Projects-Records', 'Projects + OnHold + Feb–Jul');
	await shot(pPage, '03-projects-drag-feb-jul');

	// Pivot cell from the initial state.
	await resetPage(pPage, pNetwork);
	tmpState = await groupState(pPage, 'Projects');
	check(tmpState.Total === 6, `Projects reset: Total 6 (got ${tmpState.Total})`);
	let tmpCellCount = await pPage.evaluate(() => { let tmpCell = document.querySelector('#FD-P-Projects-StatusByClient button.facet-pivot-cell-btn[aria-label^="Active × Iris Media"]'); return tmpCell ? parseInt(tmpCell.textContent.replace(/[^0-9]/g, ''), 10) : null; });
	await gesture(pPage, pNetwork, 'Projects pivot Active × Iris Media', async () => { await pPage.click('#FD-P-Projects-StatusByClient button.facet-pivot-cell-btn[aria-label^="Active × Iris Media"]'); });
	tmpState = await groupState(pPage, 'Projects');
	check((tmpState.Total === 2) && (tmpCellCount === 2), `Projects pivot cell: Total ${tmpState.Total} == cell count ${tmpCellCount} == 2`);
	await verifyRecords(pPage, pNetwork, 'Projects', 'FD-P-Projects-Records', 'Projects pivot Active × Iris Media');
	await shot(pPage, '04-projects-pivot-cell');

	// A single month bar from the initial selections: the Total becomes that bar's count.
	await resetPage(pPage, pNetwork);
	tmpBars = await histogramBars(pPage, 'FD-P-Projects-Started-Bars');
	let tmpTarget = tmpBars.find((pBar) => { return /Nov 2026/.test(pBar.Label); }) || tmpBars[tmpBars.length - 2];
	let tmpBarCount = parseInt(String(tmpTarget.Label).split(':').pop().replace(/[^0-9]/g, ''), 10);
	await gesture(pPage, pNetwork, `Projects click bar [${tmpTarget.Label}]`, async () => { await clickBar(pPage, 'FD-P-Projects-Started-Bars', tmpTarget.Index); });
	tmpState = await groupState(pPage, 'Projects');
	check(tmpState.Total === tmpBarCount, `Projects one bar: Total ${tmpState.Total} == bar count ${tmpBarCount}`);
	await verifyRecords(pPage, pNetwork, 'Projects', 'FD-P-Projects-Records', `Projects bar [${tmpTarget.Label}]`);

	// Back to the initial state: the same request again revalidates (304) unless the clock moved the ETag.
	await resetPage(pPage, pNetwork);
	let tmp304 = pNetwork.since().filter((pEntry) => { return /\/Query$/.test(pEntry.URL) && (pEntry.Status === 304); }).length;
	console.log(`    Projects reset after a change: ${tmp304 ? '304 from cache' : '200 (the Projects ETag tracks "now")'}`);
};

const runRequestHandling = async (pPage, pNetwork) =>
{
	console.log('  Request handling (coalescing, keyboard, network failure)');
	await navigate(pPage, pNetwork, '/Projects');
	// Three gestures in the same tick (two checkboxes and a scope switch) -> one POST.
	await gesture(pPage, pNetwork, 'three changes in one tick',
		async () =>
		{
			await pPage.evaluate(
				() =>
				{
					let tmpRows = Array.prototype.slice.call(document.querySelectorAll('#FD-P-Projects-Status .facet-check-row, #FD-P-Projects-Client .facet-check-row'));
					let tmpOnHold = tmpRows.find((pRow) => { return pRow.textContent.indexOf('OnHold') >= 0; });
					let tmpClient = tmpRows.find((pRow) => { return pRow.textContent.indexOf('#11') >= 0; });
					tmpOnHold.querySelector('input').click();
					tmpClient.querySelector('input').click();
					let tmpScope = Array.prototype.slice.call(document.querySelectorAll('button.facet-scope')).find((pButton) => { return pButton.textContent.indexOf('Unblocked') >= 0; });
					tmpScope.click();
				});
		});
	let tmpState = await groupState(pPage, 'Projects');
	await verifyRecords(pPage, pNetwork, 'Projects', 'FD-P-Projects-Records', 'Projects OnHold + #11 + Unblocked off');
	let tmpPostChip = await pPage.evaluate(() => { let tmpChips = Array.prototype.map.call(document.querySelectorAll('#FD-Page-Head .fd-chip'), (pChip) => { return pChip.textContent.trim(); }); return tmpChips.find((pText) => { return /POST/.test(pText); }) || null; });
	check(tmpPostChip === '1 POST', `three changes in one tick: the page says [${tmpPostChip}]`);

	// Keyboard: focus a bar and press Enter -> it toggles (the bar's own clause).
	await resetPage(pPage, pNetwork);
	let tmpBars = await histogramBars(pPage, 'FD-P-Projects-Started-Bars');
	let tmpTarget = tmpBars.find((pBar) => { return /Mar 2026/.test(pBar.Label); });
	await gesture(pPage, pNetwork, 'keyboard Enter on a bar',
		async () =>
		{
			await pPage.focus(`#FD-P-Projects-Started-Bars .facet-hist-col[data-index="${tmpTarget.Index}"]`);
			await pPage.keyboard.press('Enter');
		});
	tmpState = await groupState(pPage, 'Projects');
	let tmpBarCount = parseInt(String(tmpTarget.Label).split(':').pop().replace(/[^0-9]/g, ''), 10);
	check(tmpState.Total === tmpBarCount, `keyboard Enter on [${tmpTarget.Label}]: Total ${tmpState.Total} == ${tmpBarCount}`);
	let tmpFocused = await pPage.evaluate(() => { return document.activeElement ? document.activeElement.getAttribute('data-focus-key') : null; });
	check(tmpFocused === 'bar-2026-03-01 00:00:00', `keyboard Enter: focus stays on the bar (${tmpFocused})`);
	await gesture(pPage, pNetwork, 'keyboard Enter again (the bar IS the selection: clears)', async () => { await pPage.keyboard.press('Enter'); });
	tmpState = await groupState(pPage, 'Projects');
	check(tmpState.Total === 8, `keyboard Enter again: the Started selection is cleared (Total ${tmpState.Total})`);

	// The network goes away: the page shows DEMO_NETWORK instead of hanging; back online, Reset recovers.
	await resetPage(pPage, pNetwork);
	await pPage.setOfflineMode(true);
	let tmpOnHold = await findTerm(pPage, 'FD-P-Projects-Status', 'OnHold');
	await tmpOnHold.click();
	await settle(pPage, pNetwork);
	let tmpBanner = await pPage.evaluate(() => { let tmpBanner = document.querySelector('#FD-Page-Head .fd-banner'); return tmpBanner ? tmpBanner.textContent.replace(/\s+/g, ' ') : ''; });
	check(/DEMO_NETWORK/.test(tmpBanner), `offline: DEMO_NETWORK banner [${tmpBanner.slice(0, 80)}]`);
	await shot(pPage, '24-offline-demo-network');
	await pPage.setOfflineMode(false);
	await resetPage(pPage, pNetwork);
	tmpState = await groupState(pPage, 'Projects');
	check((tmpState.Total === 6) && !tmpState.ErrorCode, `back online + Reset: Total 6 (got ${tmpState.Total} ${tmpState.ErrorCode || ''})`);
};

const runDocuments = async (pPage, pNetwork) =>
{
	console.log('  Documents by form type');
	await navigate(pPage, pNetwork, '/Documents');
	let tmpState = await groupState(pPage, 'Documents');
	check(tmpState.Total === 41, `Documents: initial Total 41 (got ${tmpState.Total})`);
	await shot(pPage, '05-documents-initial');

	let tmpFormsBefore = JSON.stringify(tmpState.Facets.ByForm.map((pBucket) => { return [ pBucket.Key, pBucket.Count ]; }));
	let tmpFormG = await findTerm(pPage, 'FD-P-Documents-ByForm', 'Form G');
	await gesture(pPage, pNetwork, 'Documents + Form G', async () => { await tmpFormG.click(); });
	tmpState = await groupState(pPage, 'Documents');
	check(tmpState.Total === (41 + tmpFormG.Count) && (tmpState.Total === 58), `Documents + Form G: Total ${tmpState.Total} == 41 + ${tmpFormG.Count} == 58`);
	check(JSON.stringify(tmpState.Facets.ByForm.map((pBucket) => { return [ pBucket.Key, pBucket.Count ]; })) === tmpFormsBefore, 'Documents + Form G: every form keeps its count (disjunctive)');
	await verifyRecords(pPage, pNetwork, 'Documents', 'FD-P-Documents-Records', 'Documents Form D + G');
	await shot(pPage, '06-documents-form-g');

	// Click one month bar (replaces the Jan–Jun range): Total == that bar's count.
	await resetPage(pPage, pNetwork);
	let tmpBars = await histogramBars(pPage, 'FD-P-Documents-ByMonth-Bars');
	let tmpTarget = tmpBars.find((pBar) => { return /Mar 2026/.test(pBar.Label); });
	let tmpBarCount = parseInt(String(tmpTarget.Label).split(':').pop().replace(/[^0-9]/g, ''), 10);
	await gesture(pPage, pNetwork, `Documents click bar [${tmpTarget.Label}]`, async () => { await clickBar(pPage, 'FD-P-Documents-ByMonth-Bars', tmpTarget.Index); });
	tmpState = await groupState(pPage, 'Documents');
	check(tmpState.Total === tmpBarCount, `Documents one month: Total ${tmpState.Total} == bar count ${tmpBarCount}`);
	await verifyRecords(pPage, pNetwork, 'Documents', 'FD-P-Documents-Records', `Documents bar [${tmpTarget.Label}]`);
	await shot(pPage, '07-documents-one-month');

	// Interval "week": the Jan–Jun selection stays, its edge weeks are partly inside (hatched), and the readout
	// says the clause span and the page Total (never a sum of highlighted bars).
	await resetPage(pPage, pNetwork);
	await gesture(pPage, pNetwork, 'Documents interval week', async () => { await clickByText(pPage, 'button.facet-hist-interval', 'week', 'FD-P-Documents-ByMonth'); });
	tmpState = await groupState(pPage, 'Documents');
	let tmpWeek = await pPage.evaluate(() => { return { Readout: document.getElementById('FD-P-Documents-ByMonth-Readout').textContent.replace(/\s+/g, ' ').trim(), Partial: document.querySelectorAll('#FD-P-Documents-ByMonth .facet-hist-partial').length, Ticks: Array.prototype.map.call(document.querySelectorAll('#FD-P-Documents-ByMonth .facet-hist-tick'), (pTick) => { return pTick.textContent; }) }; });
	check((tmpState.Total === 41) && /Selected Jan – Jun 2026 · 41 documents/.test(tmpWeek.Readout) && (tmpWeek.Partial === 2), `Documents week: Total ${tmpState.Total}, readout [${tmpWeek.Readout}], ${tmpWeek.Partial} partial bars`);
	check(/’\d\d$/.test(tmpWeek.Ticks[0] || '') && tmpWeek.Ticks.some((pTick, pIndex) => { return (pIndex > 0) && /’26$/.test(pTick); }), `Documents week: ticks carry the year where it changes [${tmpWeek.Ticks.join(' | ')}]`);
	await verifyRecords(pPage, pNetwork, 'Documents', 'FD-P-Documents-Records', 'Documents week interval');
	await shot(pPage, '25-documents-week-partial-edges');

	// Interval "day": the per-facet 422 is shown inline with a "Use week" suggestion.
	await resetPage(pPage, pNetwork);
	await gesture(pPage, pNetwork, 'Documents interval day', async () => { await clickByText(pPage, 'button.facet-hist-interval', 'day', 'FD-P-Documents-ByMonth'); });
	let tmpInline = await pPage.evaluate(() => { let tmpRoot = document.getElementById('FD-P-Documents-ByMonth'); return tmpRoot ? tmpRoot.textContent.replace(/\s+/g, ' ') : ''; });
	check(/FACET_INTERVAL_TOO_FINE/.test(tmpInline) && /Use week/.test(tmpInline), 'Documents interval day: inline FACET_INTERVAL_TOO_FINE with "Use week"');
	tmpState = await groupState(pPage, 'Documents');
	check(tmpState.Total === 41, `Documents interval day: the rest of the page still answers (Total ${tmpState.Total})`);
	await shot(pPage, '08-documents-interval-day-422');
	await gesture(pPage, pNetwork, 'Documents Use week', async () => { await clickByText(pPage, 'button', 'Use week', 'FD-P-Documents-ByMonth'); });
	let tmpWeekBars = await histogramBars(pPage, 'FD-P-Documents-ByMonth-Bars');
	check(tmpWeekBars.length > 24, `Documents Use week: ${tmpWeekBars.length} week bars`);
	await resetPage(pPage, pNetwork);
};

const runLabForms = async (pPage, pNetwork) =>
{
	console.log('  Lab forms I still have to fill out');
	await navigate(pPage, pNetwork, '/LabForms');
	let tmpState = await groupState(pPage, 'LabFormsA');
	check(tmpState.Total === 237, `LabForms A: initial Total 237 (got ${tmpState.Total})`);
	let tmpWorkList = await pPage.evaluate(() => { let tmpRows = Array.prototype.slice.call(document.querySelectorAll('#FD-P-LabFormsA-Records tbody tr')); let tmpHeaders = Array.prototype.map.call(document.querySelectorAll('#FD-P-LabFormsA-Records thead th'), (pHead) => { return pHead.textContent.trim(); }); let tmpQueue = tmpHeaders.indexOf('Queue'); return { Headers: tmpHeaders, Queues: tmpRows.map((pRow) => { return pRow.children[tmpQueue] ? pRow.children[tmpQueue].textContent.trim() : null; }) }; });
	check((tmpWorkList.Headers.join('|') === 'Intake|Material|Received|Queue|Form type|Discipline|Started') && tmpWorkList.Queues.length && tmpWorkList.Queues.every((pQueue) => { return (pQueue === 'Receiving') || (pQueue === 'Wet Lab'); }), `LabForms A: the work list shows the looked-up intake fields [${tmpWorkList.Headers.join(', ')}; queues ${Array.from(new Set(tmpWorkList.Queues)).join(', ')}]`);
	await shot(pPage, '09-labforms-a-initial');

	let tmpH = await findTerm(pPage, 'FD-P-LabFormsA-ToDo', 'Lab Form H');
	await gesture(pPage, pNetwork, 'LabForms A Lab Form H', async () => { await tmpH.click(); });
	tmpState = await groupState(pPage, 'LabFormsA');
	check((tmpState.Total === tmpH.Count) && (tmpState.Total === 41), `LabForms A Lab Form H: Total ${tmpState.Total} == bucket ${tmpH.Count} == 41`);
	await verifyRecords(pPage, pNetwork, 'LabFormsA', 'FD-P-LabFormsA-Records', 'LabForms A Lab Form H');
	await shot(pPage, '10-labforms-a-form-h');

	await resetPage(pPage, pNetwork);
	let tmpPhysics = await findTerm(pPage, 'FD-P-LabFormsA-Discipline', 'Physics');
	await gesture(pPage, pNetwork, 'LabForms A Physics', async () => { await tmpPhysics.click(); });
	tmpState = await groupState(pPage, 'LabFormsA');
	check((tmpState.Total === tmpPhysics.Count) && (tmpState.Total === 84), `LabForms A Physics: Total ${tmpState.Total} == bucket ${tmpPhysics.Count} == 84`);
	await gesture(pPage, pNetwork, 'LabForms A Physics + weeks 0..4', async () => { await dragBars(pPage, 'FD-P-LabFormsA-Week-Bars', 0, 4); });
	tmpState = await groupState(pPage, 'LabFormsA');
	check(tmpState.Total === 8, `LabForms A Physics + weeks 0..4: Total 8 (got ${tmpState.Total})`);
	await verifyRecords(pPage, pNetwork, 'LabFormsA', 'FD-P-LabFormsA-Records', 'LabForms A Physics + weeks 0..4');
	await shot(pPage, '11-labforms-a-physics-weeks');

	await resetPage(pPage, pNetwork);
	await clickByText(pPage, 'button.fd-tab', 'B');
	await settle(pPage, pNetwork);
	let tmpB = await pPage.evaluate(() => { let tmpState = _Pict.AppData.Facet.Groups.LabFormsB; let tmpToDo = tmpState.Envelope && tmpState.Envelope.Facets && tmpState.Envelope.Facets.ToDo; return { Total: tmpToDo ? tmpToDo.Total : null, CountMode: tmpToDo ? tmpToDo.CountMode : null }; });
	check((tmpB.Total === 224) && (tmpB.CountMode === 'KeyDistinct'), `LabForms B: ToDo.Total 224 KeyDistinct (got ${tmpB.Total} ${tmpB.CountMode})`);
	let tmpCompare = await pPage.evaluate(() => { let tmpTable = document.querySelector('.fd-compare-table'); return tmpTable ? tmpTable.textContent.replace(/\s+/g, ' ') : ''; });
	check(/237/.test(tmpCompare) && /224/.test(tmpCompare) && /219/.test(tmpCompare), 'LabForms B: the Compare table: 219 in both, totals 237 vs 224');
	let tmpCallout = await pPage.evaluate(() => { let tmpCallout = document.querySelector('.fd-compare-callout'); return tmpCallout ? tmpCallout.textContent.replace(/\s+/g, ' ') : ''; });
	check(/219 forms to do in both variants/.test(tmpCallout) && /237 − 18 = 224 − 5/.test(tmpCallout), `LabForms B: the callout leads with the agreement [${tmpCallout.slice(0, 90)}]`);
	check((await domTotal(pPage)) === 224, 'LabForms B: the summary shows 224');
	await shot(pPage, '12-labforms-b-compare');
	await clickByText(pPage, 'button.fd-tab', 'A');
	await settle(pPage, pNetwork);
};

const runBookstore = async (pPage, pNetwork) =>
{
	console.log('  Bookstore explorer');
	await navigate(pPage, pNetwork, '/Bookstore');
	let tmpState = await groupState(pPage, 'Books');
	check(tmpState.Total === 1436, `Books: initial Total 1436 (got ${tmpState.Total})`);
	await shot(pPage, '13-bookstore-initial');

	await gesture(pPage, pNetwork, 'Books Well reviewed', async () => { await clickByText(pPage, 'button.facet-scope', 'Well reviewed'); });
	tmpState = await groupState(pPage, 'Books');
	check(tmpState.Total === 1250, `Books Well reviewed: Total 1250 (got ${tmpState.Total})`);
	let tmpBars = await histogramBars(pPage, 'FD-P-Books-Year-Bars');
	let tmp2000 = tmpBars.find((pBar) => { return /^2000/.test(pBar.Label); });
	let tmp2010 = tmpBars.find((pBar) => { return /^2010/.test(pBar.Label); });
	await gesture(pPage, pNetwork, 'Books drag 2000–2019', async () => { await dragBars(pPage, 'FD-P-Books-Year-Bars', tmp2000.Index, tmp2010.Index); });
	tmpState = await groupState(pPage, 'Books');
	check(tmpState.Total === 614, `Books Well reviewed + 2000–2019: Total 614 (got ${tmpState.Total})`);
	await verifyRecords(pPage, pNetwork, 'Books', 'FD-P-Books-Records', 'Books Well reviewed + 2000–2019');
	await shot(pPage, '14-bookstore-wellreviewed-2000s');

	await resetPage(pPage, pNetwork);
	let tmpGenre = await pPage.evaluate(() => { let tmpRow = document.querySelector('#FD-P-Books-Genre .facet-check-row .facet-check-label'); return tmpRow ? tmpRow.textContent.trim() : null; });
	let tmpBucket = await findTerm(pPage, 'FD-P-Books-Genre', tmpGenre);
	await gesture(pPage, pNetwork, `Books Genre ${tmpGenre}`, async () => { await tmpBucket.click(); });
	tmpState = await groupState(pPage, 'Books');
	check(tmpState.Total === tmpBucket.Count, `Books Genre ${tmpGenre}: Total ${tmpState.Total} == bucket ${tmpBucket.Count}`);
	await verifyRecords(pPage, pNetwork, 'Books', 'FD-P-Books-Records', `Books Genre ${tmpGenre}`);
	let tmpBlank = await findTerm(pPage, 'FD-P-Books-Language', '(blank)');
	await gesture(pPage, pNetwork, 'Books Language (blank)', async () => { await tmpBlank.click(); });
	tmpState = await groupState(pPage, 'Books');
	check(tmpState.Total === tmpBlank.Count, `Books Genre ${tmpGenre} + Language (blank): Total ${tmpState.Total} == bucket ${tmpBlank.Count}`);
	await verifyRecords(pPage, pNetwork, 'Books', 'FD-P-Books-Records', `Books Genre ${tmpGenre} + Language (blank)`);
	await shot(pPage, '15-bookstore-genre-blank-language');

	// Next page of the full list.
	await resetPage(pPage, pNetwork);
	pNetwork.mark();
	await clickByText(pPage, 'button.facet-btn', 'Next', 'FD-P-Books-Records');
	await settle(pPage, pNetwork);
	let tmpRecords = pNetwork.since().filter((pEntry) => { return /\/Records\/25\/25$/.test(pEntry.URL); });
	let tmpRange = await domRange(pPage, 'FD-P-Books-Records');
	check((tmpRecords.length === 1) && /^26–50 of 1,436$/.test(tmpRange), `Books Next: one …/Records/25/25 and [${tmpRange}]`);
	await resetPage(pPage, pNetwork);
};

const runPrincipals = async (pPage, pNetwork) =>
{
	console.log('  DEMO principal switcher');
	// A count verdict belongs to the answer it was asked about; a principal switch on page 2 goes back to page 1.
	await navigate(pPage, pNetwork, '/Documents');
	await verifyRecords(pPage, pNetwork, 'Documents', 'FD-P-Documents-Records', 'Documents as user42');
	await clickByText(pPage, 'button.facet-btn', 'Next', 'FD-P-Documents-Records');
	await settle(pPage, pNetwork);
	await setPersona(pPage, pNetwork, 'user81');
	let tmpSwitched = await pPage.evaluate(() => { let tmpState = _Pict.AppData.Facet.Groups.Documents; let tmpBadge = document.querySelector('#FD-P-Documents-Records .facet-rec-check'); return { Total: tmpState.Envelope.Total, CountCheck: tmpState.CountCheck, Begin: tmpState.RecordsPage.Begin, Badge: tmpBadge ? tmpBadge.textContent.trim() : null, Range: document.querySelector('#FD-P-Documents-Records .facet-rec-range').textContent.trim() }; });
	check((tmpSwitched.Total === 9) && (tmpSwitched.CountCheck === null) && (tmpSwitched.Badge === null), `user81 Documents: the user42 count verdict is gone (Total ${tmpSwitched.Total}, badge ${tmpSwitched.Badge})`);
	check((tmpSwitched.Begin === 0) && (tmpSwitched.Range === '1–9 of 9'), `user81 Documents: back on page 1 [${tmpSwitched.Range}]`);
	await navigate(pPage, pNetwork, '/LabForms');
	await setPersona(pPage, pNetwork, 'user44');
	let tmpEmptyLab = await pPage.evaluate(() => { let tmpEmpty = document.querySelector('#FD-P-LabFormsA-Records .facet-rec-empty'); return tmpEmpty ? tmpEmpty.textContent.replace(/\s+/g, ' ').trim() : ''; });
	check(/in no lab queue/.test(tmpEmptyLab) && /Signed in as User 44/.test(tmpEmptyLab), `user44 Lab forms: the empty state says why [${tmpEmptyLab}]`);
	await shot(pPage, '26-labforms-user44-empty');
	await setPersona(pPage, pNetwork, 'user42');
	await navigate(pPage, pNetwork, '/Projects');
	await setPersona(pPage, pNetwork, 'user81');
	let tmpState = await groupState(pPage, 'Projects');
	check(tmpState.Total === 1, `user81 Projects: Total 1 (got ${tmpState.Total})`);
	await shot(pPage, '16-user81-projects');
	await navigate(pPage, pNetwork, '/Bookstore');
	tmpState = await groupState(pPage, 'Books');
	check(tmpState.Total === 81, `user81 Books: Total 81 (got ${tmpState.Total})`);

	await navigate(pPage, pNetwork, '/Projects');
	await setPersona(pPage, pNetwork, 'user43');
	tmpState = await groupState(pPage, 'Projects');
	check(tmpState.Total === 0, `user43 Projects: Total 0 (got ${tmpState.Total})`);
	let tmpEmpty = await pPage.evaluate(() => { return !!document.querySelector('#FD-P-Projects-Records .facet-rec-empty'); });
	check(tmpEmpty, 'user43 Projects: the list shows its empty state');
	await shot(pPage, '17-user43-projects-empty');
	await gesture(pPage, pNetwork, 'user43 + Member', async () => { await clickByText(pPage, 'button.facet-param', 'Member'); });
	await gesture(pPage, pNetwork, 'user43 Has my overdue tasks off', async () => { await clickByText(pPage, 'button.facet-scope', 'Has my overdue tasks'); });
	tmpState = await groupState(pPage, 'Projects');
	check(tmpState.Total === 2, `user43 + Member, overdue scope off: Total 2 (got ${tmpState.Total})`);
	await verifyRecords(pPage, pNetwork, 'Projects', 'FD-P-Projects-Records', 'user43 + Member');

	// Every role off -> FACET_PARAM_INVALID.
	await resetPage(pPage, pNetwork);
	await setPersona(pPage, pNetwork, 'user42');
	await clickByText(pPage, 'button.facet-param', 'Owner');
	await clickByText(pPage, 'button.facet-param', 'Lead');
	await settle(pPage, pNetwork);
	let tmpBanner = await pPage.evaluate(() => { let tmpBanner = document.querySelector('#FD-Page-Head .fd-banner'); return tmpBanner ? tmpBanner.textContent.replace(/\s+/g, ' ') : ''; });
	check(/FACET_PARAM_INVALID/.test(tmpBanner), `no roles: FACET_PARAM_INVALID banner [${tmpBanner.slice(0, 80)}]`);
	await shot(pPage, '18-no-roles-param-invalid');
	await resetPage(pPage, pNetwork);

	await setPersona(pPage, pNetwork, 'anonymous');
	tmpBanner = await pPage.evaluate(() => { let tmpBanner = document.querySelector('#FD-Page-Head .fd-banner'); return tmpBanner ? tmpBanner.textContent.replace(/\s+/g, ' ') : ''; });
	check(/FACET_UNAUTHENTICATED/.test(tmpBanner), 'anonymous Projects: FACET_UNAUTHENTICATED banner');
	await shot(pPage, '19-anonymous-unauthenticated');
	await navigate(pPage, pNetwork, '/Bookstore');
	tmpBanner = await pPage.evaluate(() => { let tmpBanner = document.querySelector('#FD-Page-Head .fd-banner'); return tmpBanner ? tmpBanner.textContent.replace(/\s+/g, ' ') : ''; });
	check(/FACET_UNAUTHENTICATED/.test(tmpBanner), 'anonymous Books: FACET_UNAUTHENTICATED banner');
	await setPersona(pPage, pNetwork, 'user42');
	await navigate(pPage, pNetwork, '/Projects');
};

const runInspector = async (pPage, pNetwork) =>
{
	console.log('  Request / envelope inspector');
	await clickByText(pPage, 'button.facet-insp-bar', 'Request / envelope');
	await sleep(150);
	await clickByText(pPage, 'button.facet-insp-tab', 'Envelope');
	await sleep(150);
	let tmpText = await pPage.evaluate(() => { let tmpRoot = document.getElementById('FD-Inspector'); return tmpRoot ? tmpRoot.textContent.replace(/\s+/g, ' ') : ''; });
	check(/Engine/.test(tmpText) && /Exact/.test(tmpText) && /Disjunctive/.test(tmpText) && /Excluded/.test(tmpText), 'inspector: the Envelope tab shows Engine, Exact, Disjunctive, Excluded');
	await pPage.screenshot({ path: libPath.join(SCREENSHOT_ROOT, '20-inspector-envelope.png') });
	_Shots.push(libPath.join(SCREENSHOT_ROOT, '20-inspector-envelope.png'));
	console.log('    screenshot screenshots/20-inspector-envelope.png');
	await clickByText(pPage, 'button.facet-insp-tab', 'Request');
	await sleep(150);
	await pPage.screenshot({ path: libPath.join(SCREENSHOT_ROOT, '21-inspector-request.png') });
	_Shots.push(libPath.join(SCREENSHOT_ROOT, '21-inspector-request.png'));
	console.log('    screenshot screenshots/21-inspector-request.png');
	await clickByText(pPage, 'button.facet-insp-bar', 'Request / envelope');
	await sleep(100);

	// Escape closes the drawer; while open, the page keeps room for it.
	await clickByText(pPage, 'button.facet-insp-bar', 'Request / envelope');
	await sleep(150);
	let tmpRoom = await pPage.evaluate(() => { return { Attribute: document.documentElement.getAttribute('data-facet-inspector'), Padding: parseInt(getComputedStyle(document.querySelector('.fd-page')).paddingBottom, 10) }; });
	check((tmpRoom.Attribute === 'open') && (tmpRoom.Padding > 300), `inspector open: the page keeps ${tmpRoom.Padding}px of room below`);
	await pPage.keyboard.press('Escape');
	await sleep(150);
	let tmpClosed = await pPage.evaluate(() => { return document.documentElement.getAttribute('data-facet-inspector'); });
	check(tmpClosed === 'closed', 'inspector: Escape closes it');

	// The bar follows the page: Bookstore, Projects, Bookstore again (no new request: "kept").
	await navigate(pPage, pNetwork, '/Bookstore');
	await navigate(pPage, pNetwork, '/Projects');
	await navigate(pPage, pNetwork, '/Bookstore');
	let tmpBar = await pPage.evaluate(() => { return document.querySelector('.facet-insp-bar').textContent.replace(/\s+/g, ' ').trim(); });
	check(/Bookstore explorer/.test(tmpBar) && /\/1\.0\/Facet\/Book\/Query/.test(tmpBar) && /kept/.test(tmpBar), `inspector bar on a page shown again [${tmpBar.slice(0, 120)}]`);
	await navigate(pPage, pNetwork, '/Projects');
};

const runLightAndNarrow = async (pPage, pNetwork) =>
{
	console.log('  Theme + narrow layout');
	let tmpTheme = await pPage.evaluate(() => { return document.documentElement.getAttribute('data-fd-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); });
	await clickByText(pPage, 'button.fd-theme-btn', tmpTheme === 'dark' ? 'Light' : 'Dark');
	await sleep(200);
	await shot(pPage, `22-projects-${tmpTheme === 'dark' ? 'light' : 'dark'}`);
	await clickByText(pPage, 'button.fd-theme-btn', tmpTheme === 'dark' ? 'Dark' : 'Light');
	await pPage.setViewport({ width: 800, height: 1000 });
	await sleep(300);
	let tmpOverflow = await pPage.evaluate(() => { return document.documentElement.scrollWidth - document.documentElement.clientWidth; });
	check(tmpOverflow <= 0, `800px wide: no horizontal page scroll (overflow ${tmpOverflow}px)`);
	await shot(pPage, '23-projects-800px');
	await pPage.setViewport({ width: 390, height: 900 });
	await sleep(300);
	let tmpNarrow = await pPage.evaluate(() => { let tmpTicks = Array.prototype.filter.call(document.querySelectorAll('#FD-P-Projects-Started .facet-hist-tick'), (pTick) => { return getComputedStyle(pTick).display !== 'none'; }).map((pTick) => { return pTick.getBoundingClientRect(); }); let tmpOverlap = tmpTicks.some((pBox, pIndex) => { return (pIndex > 0) && (pBox.left < tmpTicks[pIndex - 1].right); }); return { Overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, Overlap: tmpOverlap, Ticks: tmpTicks.length }; });
	check(tmpNarrow.Overflow <= 0, `390px wide: no horizontal page scroll (overflow ${tmpNarrow.Overflow}px)`);
	check(!tmpNarrow.Overlap, `390px wide: histogram tick labels do not overlap (${tmpNarrow.Ticks} shown)`);
	await shot(pPage, '27-projects-390px');
	await pPage.setViewport(VIEWPORT);
};

const run = async (pBaseURL) =>
{
	if (!libFS.existsSync(SCREENSHOT_ROOT))
	{
		libFS.mkdirSync(SCREENSHOT_ROOT, { recursive: true });
	}
	let tmpBrowser = await libPuppeteer.launch({ headless: true, args: [ '--no-sandbox' ] });
	let tmpPageErrors = [];
	try
	{
		let tmpPage = await tmpBrowser.newPage();
		await tmpPage.setViewport(VIEWPORT);
		await tmpPage.emulateMediaFeatures([ { name: 'prefers-color-scheme', value: process.env.DEMO_CHECK_THEME || 'dark' } ]);
		tmpPage.on('pageerror', (pError) => { tmpPageErrors.push(String(pError && pError.message ? pError.message : pError)); });
		tmpPage.on('console', (pMessage) => { if ((pMessage.type() === 'error') && !/status of 40[01]|Failed to load resource/.test(pMessage.text())) { tmpPageErrors.push(pMessage.text()); } });
		let tmpNetwork = new NetworkLog(tmpPage);
		await tmpPage.evaluateOnNewDocument(() => { try { window.localStorage.clear(); } catch (pError) { /* storage blocked */ } });
		await tmpPage.goto(`${pBaseURL}#/Projects`, { waitUntil: 'load' });
		await settle(tmpPage, tmpNetwork);
		let tmpBoot = tmpNetwork.since();
		let tmpDescribes = tmpBoot.filter((pEntry) => { return (pEntry.Method === 'GET') && /\/Describe/.test(pEntry.URL); }).length;
		check((tmpDescribes === 1) && (tmpNetwork.queryPosts().length === 1), `boot: one Describe GET (${tmpDescribes}) and one Query POST (${tmpNetwork.queryPosts().length})`);

		await runProjects(tmpPage, tmpNetwork);
		await runRequestHandling(tmpPage, tmpNetwork);
		await runDocuments(tmpPage, tmpNetwork);
		await runLabForms(tmpPage, tmpNetwork);
		await runBookstore(tmpPage, tmpNetwork);
		await runPrincipals(tmpPage, tmpNetwork);
		await runInspector(tmpPage, tmpNetwork);
		await runLightAndNarrow(tmpPage, tmpNetwork);

		// A deep link straight to a page (fresh tab): only that page's Describe + Query go out.
		console.log('  Deep link');
		let tmpDeep = await tmpBrowser.newPage();
		await tmpDeep.setViewport(VIEWPORT);
		tmpDeep.on('pageerror', (pError) => { tmpPageErrors.push(String(pError && pError.message ? pError.message : pError)); });
		let tmpDeepNetwork = new NetworkLog(tmpDeep);
		await tmpDeep.goto(`${pBaseURL}#/Bookstore`, { waitUntil: 'load' });
		await settle(tmpDeep, tmpDeepNetwork);
		let tmpDeepState = await groupState(tmpDeep, 'Books');
		let tmpDeepPosts = tmpDeepNetwork.queryPosts().map((pEntry) => { return pEntry.URL.replace(/^.*\/api\//, ''); });
		check((tmpDeepState.Total === 1436) && (tmpDeepPosts.length === 1) && /^Bookstore\//.test(tmpDeepPosts[0]), `#/Bookstore deep link: Total ${tmpDeepState.Total}, posts ${JSON.stringify(tmpDeepPosts)}`);
		await tmpDeep.close();

		check(tmpPageErrors.length === 0, `no page errors (${tmpPageErrors.slice(0, 3).join(' | ')})`);
	}
	finally
	{
		await tmpBrowser.close();
	}
};

const main = () =>
{
	let tmpStart = Date.now();
	const fFinish = (pError, pDemo) =>
	{
		const fExit = () =>
		{
			if (pError)
			{
				console.error(`Faceting-Demo-Browser-Check: ${pError.stack || pError.message}`);
				process.exit(1);
			}
			console.log(`\n${_Shots.length} screenshots in ${libPath.relative(process.cwd(), SCREENSHOT_ROOT) || SCREENSHOT_ROOT}`);
			if (_Failures.length > 0)
			{
				console.log(`Faceting-Demo-Browser-Check: ${_Failures.length} of ${_Checks} checks FAILED:\n  - ${_Failures.join('\n  - ')}`);
				process.exit(1);
			}
			console.log(`Faceting-Demo-Browser-Check: all ${_Checks} checks passed (${Date.now() - tmpStart} ms).`);
			process.exit(0);
		};
		if (pDemo && (typeof(pDemo.stop) === 'function'))
		{
			return pDemo.stop(fExit);
		}
		return fExit();
	};

	if (process.env.DEMO_URL)
	{
		console.log(`Faceting-Demo-Browser-Check against ${process.env.DEMO_URL}`);
		return run(process.env.DEMO_URL).then(() => { fFinish(null); }, (pError) => { fFinish(pError); });
	}
	let libServer = require('./Faceting-Demo-Server.js');
	libServer.startDemo({ Port: CHECK_PORT },
		(pError, pDemo) =>
		{
			if (pError)
			{
				return fFinish(pError);
			}
			console.log(`Faceting-Demo-Browser-Check against ${pDemo.URL} (in-process)`);
			run(pDemo.URL).then(() => { fFinish(null, pDemo); }, (pRunError) => { fFinish(pRunError, pDemo); });
		});
};

main();
