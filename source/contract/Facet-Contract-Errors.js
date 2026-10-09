/**
 * Facet Contract - Errors
 *
 * PURE: zero requires. Shared with pict-section-facet.
 *
 * Every client-visible error is built here (02 §9, internal-contracts §13).
 *   - Whole-request failure: HTTP <Status> with { Error: { Code, Status, Message, Detail } }
 *   - Per-facet failure:     envelope.Errors[Key] = { Code, Status, Message }
 *
 * Server errors (Status >= 500) never echo internals (06 §11): their client form always carries
 * the code's canonical Message and no Detail; the specific message and Detail stay on the Error
 * object for the server log and in-process callers.
 *
 * @author Steven Velozo <steven@velozo.com>
 */

const CODES = Object.freeze(
	{
		FACET_UNAUTHENTICATED: Object.freeze({ Status: 401, Message: 'Authentication required.' }),
		FACET_SERVICE_AUTH_INVALID: Object.freeze({ Status: 401, Message: 'Service authentication failed.' }),
		FACET_FORBIDDEN: Object.freeze({ Status: 403, Message: 'Forbidden.' }),
		FACET_FORBIDDEN_UPSTREAM: Object.freeze({ Status: 403, Message: 'The upstream service refused the request.' }),
		FACET_ADHOC_FORBIDDEN: Object.freeze({ Status: 403, Message: 'Inline facet definitions are not permitted.' }),
		FACET_UNKNOWN_ENTITY: Object.freeze({ Status: 404, Message: 'Unknown entity.' }),
		FACET_UNKNOWN_FACET: Object.freeze({ Status: 400, Message: 'Unknown facet.' }),
		FACET_UNKNOWN_FIELD: Object.freeze({ Status: 400, Message: 'Unknown field.' }),
		FACET_UNKNOWN_SCOPE: Object.freeze({ Status: 400, Message: 'Unknown scope.' }),
		FACET_UNKNOWN_FOLD: Object.freeze({ Status: 400, Message: 'Unknown or unavailable fold for this facet.' }),
		FACET_FILTER_INVALID: Object.freeze({ Status: 400, Message: 'The filter is invalid.' }),
		FACET_PARAM_INVALID: Object.freeze({ Status: 400, Message: 'A parameter is invalid.' }),
		// Milestone 1 addition (internal-contracts §16.7): request body shape and L1 limits.
		FACET_REQUEST_INVALID: Object.freeze({ Status: 400, Message: 'The request is invalid.' }),
		FACET_TOO_MANY_FACETS: Object.freeze({ Status: 400, Message: 'Too many facets in one request.' }),
		FACET_PATH_TOO_DEEP: Object.freeze({ Status: 400, Message: 'The path is too deep.' }),
		FACET_MODEL_MISMATCH: Object.freeze({ Status: 409, Message: 'The model version does not match.' }),
		FACET_SPEC_UNKNOWN: Object.freeze({ Status: 409, Message: 'Unknown materialize spec.' }),
		FACET_INTERVAL_TOO_FINE: Object.freeze({ Status: 422, Message: 'The interval produces too many buckets.' }),
		FACET_PATH_TOO_BROAD: Object.freeze({ Status: 422, Message: 'The path matches too many keys.' }),
		FACET_REQUIRES_AGENT: Object.freeze({ Status: 422, Message: 'This facet requires an Agent.' }),
		FACET_FOLD_UNSUPPORTED: Object.freeze({ Status: 422, Message: 'This fold or feature is not supported here.' }),
		FACET_COMPUTED_TOO_LARGE: Object.freeze({ Status: 422, Message: 'The computed dimension is too large.' }),
		FACET_TOO_LARGE: Object.freeze({ Status: 422, Message: 'The request is too large to compute.' }),
		FACET_RESPONSE_TOO_LARGE: Object.freeze({ Status: 422, Message: 'The response is too large.' }),
		FACET_TIMEZONE_UNSUPPORTED: Object.freeze({ Status: 422, Message: 'Only the storage time zone is supported.' }),
		FACET_RATE_LIMITED: Object.freeze({ Status: 429, Message: 'Too many requests.' }),
		FACET_SCOPE_POLICY_VIOLATION: Object.freeze({ Status: 500, Message: 'The scope policy could not be verified.' }),
		// Milestone 2 (internal-contracts §20.4): a definition that failed load validation.  Boot log,
		// RetoldFacetingDefinitionRegistry.disabled() and Status only; never a request error (a request
		// naming a disabled definition gets FACET_UNKNOWN_FACET / FACET_UNKNOWN_SCOPE).
		FACET_DEFINITION_INVALID: Object.freeze({ Status: 500, Message: 'A facet definition is invalid.' }),
		FACET_INTERNAL: Object.freeze({ Status: 500, Message: 'Internal error.' }),
		FACET_UPSTREAM_UNAVAILABLE: Object.freeze({ Status: 502, Message: 'The upstream service is unavailable.' }),
		FACET_BUSY: Object.freeze({ Status: 503, Message: 'The facet service is busy.' }),
		FACET_ENGINE_UNAVAILABLE: Object.freeze({ Status: 503, Message: 'No engine can answer this facet right now.' }),
		FACET_MODEL_RELOADING: Object.freeze({ Status: 503, Message: 'The model is reloading.' }),
		FACET_TIMEOUT: Object.freeze({ Status: 504, Message: 'Facet exceeded its deadline.' })
	});

/**
 * Create a facet error.
 *
 * @param {string} pCode - a key of CODES (an unknown code becomes FACET_INTERNAL)
 * @param {string} [pMessage] - client-safe message (defaults to the code's message); never include bound values
 * @param {Record<string, any>} [pDetail] - client-safe detail (e.g. { Offset, Token } or { Feature, Milestone })
 * @return {Error} an Error with FacetError === true, Code, Status, Detail
 */
const create = (pCode, pMessage, pDetail) =>
{
	let tmpCode = Object.prototype.hasOwnProperty.call(CODES, pCode) ? pCode : 'FACET_INTERNAL';
	let tmpDefinition = CODES[tmpCode];
	let tmpMessage = ((typeof(pMessage) === 'string') && (pMessage.length > 0)) ? pMessage : tmpDefinition.Message;
	let tmpError = new Error(tmpMessage);
	tmpError.FacetError = true;
	tmpError.Code = tmpCode;
	tmpError.Status = tmpDefinition.Status;
	tmpError.Detail = ((typeof(pDetail) === 'object') && (pDetail !== null)) ? pDetail : undefined;
	return tmpError;
};

/**
 * Is this an error built by create()?
 *
 * @param {any} pError
 * @return {boolean}
 */
const isFacetError = (pError) =>
{
	return (typeof(pError) === 'object') && (pError !== null) && (pError.FacetError === true) && Object.prototype.hasOwnProperty.call(CODES, pError.Code);
};

/**
 * The client-safe { Code, Status, Message, Detail? } of an error: a non-facet error is
 * FACET_INTERNAL; a server error (Status >= 500) keeps only its code's canonical Message.
 *
 * @param {any} pError
 * @return {{ Code: string, Status: number, Message: string, Detail?: Record<string, any> }}
 */
const clientForm = (pError) =>
{
	let tmpError = isFacetError(pError) ? pError : create('FACET_INTERNAL');
	if (tmpError.Status >= 500)
	{
		return { Code: tmpError.Code, Status: tmpError.Status, Message: CODES[tmpError.Code].Message };
	}
	let tmpForm = { Code: tmpError.Code, Status: tmpError.Status, Message: tmpError.message };
	if (tmpError.Detail)
	{
		tmpForm.Detail = tmpError.Detail;
	}
	return tmpForm;
};

/**
 * Map the error a host behavior (Reads-QueryConfiguration and friends) called back with, the same
 * way on every engine: a facet error passes through; an HTTP status of 401 (number or numeric
 * string, on StatusCode / statusCode / Status / status) is FACET_UNAUTHENTICATED; anything else is
 * FACET_INTERNAL (the caller logs it; its text is never echoed).
 *
 * @param {any} pError
 * @return {Error}
 */
const fromBehaviorError = (pError) =>
{
	if (isFacetError(pError))
	{
		return pError;
	}
	let tmpStatus = ((typeof(pError) === 'object') && (pError !== null))
		? (pError.StatusCode || pError.statusCode || pError.Status || pError.status)
		: null;
	if (Number(tmpStatus) === 401)
	{
		return create('FACET_UNAUTHENTICATED');
	}
	return create('FACET_INTERNAL');
};

/**
 * Map any error to the whole-request response.  Non-facet errors become FACET_INTERNAL; server
 * errors carry only their canonical message (the caller logs the original).
 *
 * @param {any} pError
 * @return {{ Status: number, Body: { Error: { Code: string, Status: number, Message: string, Detail?: Record<string, any> } } }}
 */
const toResponse = (pError) =>
{
	let tmpForm = clientForm(pError);
	return { Status: tmpForm.Status, Body: { Error: tmpForm } };
};

/**
 * Map any error to a per-facet envelope.Errors entry (same client-safe form as toResponse).
 *
 * @param {any} pError
 * @return {{ Code: string, Status: number, Message: string, Detail?: Record<string, any> }}
 */
const toEntry = (pError) =>
{
	return clientForm(pError);
};

module.exports = (
	{
		CODES: CODES,
		create: create,
		isFacetError: isFacetError,
		fromBehaviorError: fromBehaviorError,
		toResponse: toResponse,
		toEntry: toEntry
	});
