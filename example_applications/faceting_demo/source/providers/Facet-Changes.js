/**
 * Facet-Changes -- the client half of GET /1.0/Facet/Changes, pure (no DOM, no pict, no fetch; the provider does
 * the transport, the node smoke test reuses the same functions).  Liftable into pict-section-facet.
 *
 *   createParser(fEvent)                     an incremental text/event-stream parser (the HTML "server-sent events"
 *                                            interpretation rules): feed(pChunkText) calls fEvent({ Event, Data
 *                                            (parsed JSON or null), Raw, ID, Retry }) once per event; comment lines
 *                                            (': hb') are skipped; CRLF / LF / CR line ends, also split across
 *                                            chunks; a leading BOM is dropped; a block without data lines is not
 *                                            an event (its retry: still counts: Retry is the latest value the
 *                                            stream announced, ID the last event ID, both kept across events);
 *                                            flush() ends the stream (an unterminated block is discarded)
 *   groupsToRefetch(pGroups, pDomain, pEntity)   the group hashes of pDomain whose last envelope's DependsOn
 *                                            includes pEntity (internal-contracts §47.2), sorted.  A group whose
 *                                            answer has no DependsOn (a server without it) cannot rule anything out:
 *                                            it is refetched for any change of its domain once it has asked
 *   backoffMS(pAttempt, pRetryMS, pRandom)   reconnect delay: pRetryMS doubled per attempt, capped at 30 000,
 *                                            jittered to [ ½, 1 ] of it
 *   parseSeq / laterSeq / shortSeq           the Seq grammar 'e:<8 hex>:<n>' (§39.1): only Seqs of one epoch
 *                                            compare; laterSeq keeps the later one (another epoch: the newer
 *                                            arrival); shortSeq('e:4f0c2b9e:15') = 'e:…:15'
 *   triggerText(pEntity, pSeq)               'Live update: Project @ e:…:15' (the inspector and the page strip)
 *   streamLabel(pChangeState)                { Text, Tone, Tip } for the stream status chip (Live / Reconnecting / Off)
 *
 * Contract: internal-contracts §46.2 (events), §47.1–§47.2 (subscribe, coalesced refetch).  Owner: builder D (M4).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */

// The longest reconnect delay.
const MAX_BACKOFF_MS = 30000;

// The server's retry: when it said nothing.
const DEFAULT_RETRY_MS = 3000;

// internal-contracts §39.1 (the client keeps its own copy: it never requires the service's Util).
const SEQ_PATTERN = /^e:[0-9a-f]{8}:(0|[1-9][0-9]{0,14})$/;

// The event types the stream sends (§46.2).
const EVENT_TYPES = Object.freeze([ 'ready', 'generation', 'model', 'closed' ]);

/**
 * An incremental SSE parser.
 *
 * @param {(pEvent: { Event: string, Data: any, Raw: string, ID: string|null, Retry: number|null }) => void} fEvent
 * @return {{ feed: (pText: string) => void, flush: () => void }}
 */
const createParser = (fEvent) =>
{
	let tmpPartial = '';
	let tmpPendingCR = false;
	let tmpStarted = false;
	let tmpEventName = '';
	let tmpData = [];
	let tmpLastID = null;
	let tmpRetry = null;

	let fReset = () =>
	{
		tmpEventName = '';
		tmpData = [];
	};

	let fDispatch = () =>
	{
		if (tmpData.length < 1)
		{
			// No data: not an event (the HTML rules); the event name is dropped with it.
			fReset();
			return;
		}
		let tmpRaw = tmpData.join('\n');
		let tmpParsed = null;
		try
		{
			tmpParsed = JSON.parse(tmpRaw);
		}
		catch (pError)
		{
			tmpParsed = null;
		}
		let tmpEvent = { Event: (tmpEventName.length > 0) ? tmpEventName : 'message', Data: tmpParsed, Raw: tmpRaw, ID: tmpLastID, Retry: tmpRetry };
		fReset();
		if (typeof(fEvent) === 'function')
		{
			fEvent(tmpEvent);
		}
	};

	let fLine = (pLine) =>
	{
		if (pLine.length < 1)
		{
			return fDispatch();
		}
		if (pLine.charAt(0) === ':')
		{
			// A comment (the heartbeat).
			return;
		}
		let tmpColon = pLine.indexOf(':');
		let tmpField = (tmpColon < 0) ? pLine : pLine.slice(0, tmpColon);
		let tmpValue = (tmpColon < 0) ? '' : pLine.slice(tmpColon + 1);
		if (tmpValue.charAt(0) === ' ')
		{
			tmpValue = tmpValue.slice(1);
		}
		switch (tmpField)
		{
			case 'event':
				tmpEventName = tmpValue;
				break;
			case 'data':
				tmpData.push(tmpValue);
				break;
			case 'id':
				if (tmpValue.indexOf('\u0000') < 0)
				{
					tmpLastID = tmpValue;
				}
				break;
			case 'retry':
				if (/^[0-9]+$/.test(tmpValue))
				{
					tmpRetry = parseInt(tmpValue, 10);
				}
				break;
			default:
				// Unknown fields are ignored.
				break;
		}
	};

	let fFeed = (pText) =>
	{
		let tmpText = (typeof(pText) === 'string') ? pText : ((pText === null) || (typeof(pText) === 'undefined') ? '' : String(pText));
		if (tmpText.length < 1)
		{
			return;
		}
		if (!tmpStarted)
		{
			tmpStarted = true;
			if (tmpText.charCodeAt(0) === 0xFEFF)
			{
				tmpText = tmpText.slice(1);
			}
		}
		if (tmpPendingCR)
		{
			// The previous chunk ended in CR: a LF right here belongs to that line end.
			tmpPendingCR = false;
			if (tmpText.charAt(0) === '\n')
			{
				tmpText = tmpText.slice(1);
			}
		}
		let tmpStart = 0;
		for (let i = 0; i < tmpText.length; i++)
		{
			let tmpCharacter = tmpText.charAt(i);
			if ((tmpCharacter !== '\r') && (tmpCharacter !== '\n'))
			{
				continue;
			}
			let tmpLine = tmpPartial + tmpText.slice(tmpStart, i);
			tmpPartial = '';
			if (tmpCharacter === '\r')
			{
				if (i + 1 < tmpText.length)
				{
					if (tmpText.charAt(i + 1) === '\n')
					{
						i++;
					}
				}
				else
				{
					tmpPendingCR = true;
				}
			}
			tmpStart = i + 1;
			fLine(tmpLine);
		}
		tmpPartial += tmpText.slice(tmpStart);
	};

	let fFlush = () =>
	{
		// End of stream: an unterminated block is discarded (the HTML rules).
		tmpPartial = '';
		tmpPendingCR = false;
		fReset();
	};

	return { feed: fFeed, flush: fFlush };
};

/**
 * The groups of a domain to refetch for a change of an entity.
 *
 * @param {Record<string, any>} pGroups - AppData.Facet.Groups
 * @param {string} pDomain
 * @param {string} pEntity
 * @return {Array<string>}
 */
const groupsToRefetch = (pGroups, pDomain, pEntity) =>
{
	let tmpGroups = (pGroups && (typeof(pGroups) === 'object')) ? pGroups : {};
	return Object.keys(tmpGroups).sort().filter(
		(pGroupHash) =>
		{
			let tmpState = tmpGroups[pGroupHash];
			if (!tmpState || (tmpState.Domain !== pDomain) || (typeof(pEntity) !== 'string'))
			{
				return false;
			}
			let tmpDependsOn = null;
			if (Array.isArray(tmpState.DependsOn))
			{
				tmpDependsOn = tmpState.DependsOn;
			}
			else if (tmpState.Envelope && Array.isArray(tmpState.Envelope.DependsOn))
			{
				tmpDependsOn = tmpState.Envelope.DependsOn;
			}
			if (tmpDependsOn)
			{
				return (tmpDependsOn.indexOf(pEntity) >= 0);
			}
			// A server without DependsOn: any change of the domain may matter (a join, a label), once the group has asked.
			return (tmpState.Status !== 'Idle');
		});
};

/**
 * The reconnect delay: the server's retry: doubled per attempt, capped, then jittered to between half and all
 * of it (streams cut together — a deploy — must not reconnect, and refetch, together).
 *
 * @param {number} pAttempt - 0 for the first reconnect
 * @param {number} [pRetryMS] - the server's retry: (default 3000)
 * @param {number} [pRandom] - a number in [0, 1] (default Math.random(); 1 = the full delay)
 * @return {number}
 */
const backoffMS = (pAttempt, pRetryMS, pRandom) =>
{
	let tmpBase = ((typeof(pRetryMS) === 'number') && (pRetryMS > 0)) ? pRetryMS : DEFAULT_RETRY_MS;
	let tmpDelay = Math.min(MAX_BACKOFF_MS, tmpBase * Math.pow(2, Math.max(0, pAttempt || 0)));
	let tmpRandom = ((typeof(pRandom) === 'number') && (pRandom >= 0) && (pRandom <= 1)) ? pRandom : Math.random();
	return Math.round(tmpDelay * (0.5 + (0.5 * tmpRandom)));
};

/**
 * @param {any} pSeq
 * @return {{ Epoch: string, N: number }|null}
 */
const parseSeq = (pSeq) =>
{
	if ((typeof(pSeq) !== 'string') || !SEQ_PATTERN.test(pSeq))
	{
		return null;
	}
	let tmpLast = pSeq.lastIndexOf(':');
	return { Epoch: pSeq.slice(0, tmpLast), N: parseInt(pSeq.slice(tmpLast + 1), 10) };
};

/**
 * The later of two Seqs (either may be null).  Seqs of one epoch compare by their counter; a Seq of another
 * epoch (the server restarted) wins as the newer arrival.  Malformed values never win over a valid one.
 *
 * @param {string|null} pCurrent
 * @param {string|null} pArrived
 * @return {string|null}
 */
const laterSeq = (pCurrent, pArrived) =>
{
	let tmpCurrent = parseSeq(pCurrent);
	let tmpArrived = parseSeq(pArrived);
	if (!tmpArrived)
	{
		return tmpCurrent ? pCurrent : null;
	}
	if (!tmpCurrent || (tmpCurrent.Epoch !== tmpArrived.Epoch))
	{
		return pArrived;
	}
	return (tmpArrived.N > tmpCurrent.N) ? pArrived : pCurrent;
};

/**
 * 'e:4f0c2b9e:15' -> 'e:…:15'
 *
 * @param {any} pSeq
 * @return {string}
 */
const shortSeq = (pSeq) =>
{
	let tmpSeq = parseSeq(pSeq);
	return tmpSeq ? `e:…:${tmpSeq.N}` : '';
};

/**
 * The trigger an SSE-driven refetch records ("Live update: Project @ e:…:15").
 *
 * @param {string} pEntity
 * @param {string|null} [pSeq]
 * @return {string}
 */
const triggerText = (pEntity, pSeq) =>
{
	let tmpShort = shortSeq(pSeq);
	return `Live update: ${pEntity || 'change'}${(tmpShort.length > 0) ? ` @ ${tmpShort}` : ''}`;
};

/**
 * The stream status chip (AppData.Facet.Changes[<Domain>]): Live (Open), Reconnecting (Connecting / Error with a
 * reconnect pending), Off (Closed, or never opened).
 *
 * @param {Record<string, any>|null} pChangeState
 * @return {{ Text: string, Tone: string, Tip: string }}
 */
const streamLabel = (pChangeState) =>
{
	let tmpState = pChangeState || null;
	if (!tmpState)
	{
		return { Text: 'Live: off', Tone: 'neutral', Tip: 'No change stream is open for this domain.' };
	}
	let tmpSeq = tmpState.LastSeq ? ` Last change ${tmpState.LastSeq}.` : '';
	switch (tmpState.Status)
	{
		case 'Open':
			return { Text: 'Live', Tone: 'ok', Tip: `GET /1.0/Facet/Changes is open: a change to an entity this page depends on refetches the affected cards (${tmpState.Events || 0} event${(tmpState.Events === 1) ? '' : 's'} so far).${tmpSeq}` };
		case 'Connecting':
			return { Text: (tmpState.Reconnects > 0) ? 'Live: reconnecting' : 'Live: connecting', Tone: 'warn', Tip: 'Opening GET /1.0/Facet/Changes.' };
		case 'Error':
			return { Text: 'Live: reconnecting', Tone: 'warn', Tip: `The change stream broke off${tmpState.Error ? ` (${tmpState.Error.Code})` : ''}; reconnecting with backoff.` };
		default:
			return { Text: 'Live: off', Tone: 'neutral', Tip: `No change stream${tmpState.Reason ? ` (${tmpState.Reason}${tmpState.Error ? `: ${tmpState.Error.Code}` : ''})` : ''}. Answers are still correct; they only refresh on the next request.` };
	}
};

module.exports = (
	{
		MAX_BACKOFF_MS: MAX_BACKOFF_MS,
		DEFAULT_RETRY_MS: DEFAULT_RETRY_MS,
		SEQ_PATTERN: SEQ_PATTERN,
		EVENT_TYPES: EVENT_TYPES,
		createParser: createParser,
		groupsToRefetch: groupsToRefetch,
		backoffMS: backoffMS,
		parseSeq: parseSeq,
		laterSeq: laterSeq,
		shortSeq: shortSeq,
		triggerText: triggerText,
		streamLabel: streamLabel
	});
