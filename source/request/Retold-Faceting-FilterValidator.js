/**
 * Retold Faceting - Filter Validator
 *
 * The meadow-filter validator (06 §8 L2): decodes a FilterString exactly once, tokenizes it with
 * its own quad splitter, and accepts only allowlisted instructions/operators and whitelisted
 * fields.  Never hands a raw string to meadow-filter.  Output feeds FilterAST.fromStanzas.
 *
 * Rules (internal-contracts §4.4):
 *   - decode once with decodeURIComponent (a malformed escape is FACET_FILTER_INVALID);
 *   - no control characters anywhere in the decoded string;
 *   - split on '~' into quads; a trailing partial quad is an error (a single trailing '~' is the
 *     one tolerated artifact, because meadow-filter itself ignores it and the list accepts it);
 *   - instructions FBV FBVOR FBL FBLOR FOP FOPOR FCP; FSF is stripped with FACET_SORT_IGNORED;
 *     everything else (FBD FBDOR FBJ* FSJF FDST, unknown) is rejected;
 *   - operators EQ NE GT GE LT LE LK NLK IN NN INN NIN; FBL/FBLOR accept only INN/NIN (value split
 *     on ',', empty items rejected); FBV/FBVOR refuse INN/NIN (meadow-filter would bind a string
 *     to an IN list);
 *   - fields: exact, case-sensitive filterable columns from the catalog whitelist; unknown and
 *     Sensitive → FACET_UNKNOWN_FIELD; the delete column only with AllowDeleteColumn;
 *   - parens: one nesting level, balanced, never empty;
 *   - values: never containing '~' or something that decodes to it ('%7E'), bounded length.
 *
 * Synchronous; throws FacetErrors (FACET_FILTER_INVALID with { Offset, Token }, FACET_UNKNOWN_FIELD).
 * Contract: internal-contracts §4.4.  The instruction sets below are exported: FilterAST reads them.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');
const libFacetRequest = require('../contract/Facet-Contract-Request.js');
const libFacetClauses = require('../contract/Facet-Contract-Clauses.js');
const libFacetUtil = require('../contract/Facet-Contract-Util.js');
const libFacetBuckets = require('../contract/Facet-Contract-Buckets.js');

// A numeric literal (the contract's rule) — an integer column checks its range on these.
const NUMERIC_LITERAL_PATTERN = libFacetUtil.NUMERIC_LITERAL_PATTERN;

// Value stanzas (the ones that become predicates).
const VALUE_INSTRUCTIONS = Object.freeze([ 'FBV', 'FBVOR', 'FBL', 'FBLOR' ]);
// List instructions only take list operators, and vice versa.
const LIST_INSTRUCTIONS = Object.freeze([ 'FBL', 'FBLOR' ]);
const LIST_OPERATORS = Object.freeze([ 'INN', 'NIN' ]);
// Paren instructions.
const OPEN_INSTRUCTIONS = Object.freeze([ 'FOP', 'FOPOR' ]);
const CLOSE_INSTRUCTION = 'FCP';
// Instructions whose connector to the previous term is OR.
const OR_INSTRUCTIONS = Object.freeze([ 'FBVOR', 'FBLOR', 'FOPOR' ]);

// Anything that decodes (once more) to '~'.  Values are data and must never carry the separator.
const TILDE_PATTERN = libFacetClauses.TILDE_PATTERN;
// C0 controls and DEL.
const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;

const SORT_WARNING = Object.freeze({ Code: 'FACET_SORT_IGNORED', Detail: 'FSF stanzas do not affect facets.' });

class RetoldFacetingFilterValidator extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingFilterValidator';
	}

	/**
	 * Throw a FACET_FILTER_INVALID at a quad offset.
	 *
	 * @param {number} pOffset - the quad index
	 * @param {string} pToken - the offending token (instruction, operator or a reason word); never a value
	 * @param {string} pReason
	 */
	_invalid(pOffset, pToken, pReason)
	{
		throw libFacetErrors.create('FACET_FILTER_INVALID', 'The filter string is invalid.', { Offset: pOffset, Token: pToken, Reason: pReason });
	}

	/**
	 * The catalog (the identifier whitelist).
	 *
	 * @return {any}
	 */
	_catalog()
	{
		let tmpCatalog = this.fable.RetoldFacetingCatalog;
		if (!tmpCatalog || (typeof(tmpCatalog.column) !== 'function'))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'RetoldFacetingFilterValidator needs the RetoldFacetingCatalog service.');
		}
		return tmpCatalog;
	}

	/**
	 * Resolve a filter field against the whitelist.
	 *
	 * @param {string} pEntity
	 * @param {string} pField
	 * @param {number} pOffset
	 * @param {boolean} pAllowDeleteColumn
	 * @return {Record<string, any>} ColumnInfo
	 */
	_column(pEntity, pField, pOffset, pAllowDeleteColumn)
	{
		let tmpColumn = libFacetRequest.IDENTIFIER_PATTERN.test(pField) ? this._catalog().column(pEntity, pField) : null;
		if (!tmpColumn || (tmpColumn.Filterable === false) || (tmpColumn.Sensitive === true))
		{
			throw libFacetErrors.create('FACET_UNKNOWN_FIELD', 'The filter names an unknown field.', { Field: pField.substring(0, 64), Offset: pOffset });
		}
		if ((tmpColumn.IsDeleteColumn === true) && !pAllowDeleteColumn)
		{
			this._invalid(pOffset, pField, 'DeleteColumnNotAllowed');
		}
		return tmpColumn;
	}

	/**
	 * Check one (decoded) value.
	 *
	 * @param {string} pValue
	 * @param {number} pOffset
	 */
	_checkValue(pValue, pOffset, pColumn)
	{
		if (TILDE_PATTERN.test(pValue))
		{
			this._invalid(pOffset, 'Value', 'TildeInValue');
		}
		if (Buffer.byteLength(pValue, 'utf8') > this.options.Limits.MaxValueBytes)
		{
			this._invalid(pOffset, 'Value', 'ValueTooLong');
		}
		if (pColumn && (pColumn.IsInteger === true) && NUMERIC_LITERAL_PATTERN.test(pValue.trim()))
		{
			// A number an integer column cannot hold (1e300, 99999999999999999999, past 32 bits) is a
			// client error on every dialect; the value itself is never rewritten (list parity).
			let tmpNumber = Number(pValue.trim());
			let tmpRange = libFacetBuckets.integerRange(pColumn);
			if (!Number.isFinite(tmpNumber) || (tmpNumber < tmpRange.Min) || (tmpNumber > tmpRange.Max))
			{
				this._invalid(pOffset, 'Value', 'InvalidNumber');
			}
		}
	}

	/**
	 * Validate a meadow-filter string against an entity's filterable columns.
	 *
	 * @param {string} pEntity
	 * @param {string} pFilterString - raw (decoded once here)
	 * @param {{ AllowDeleteColumn?: boolean }} [pOptions] - true for the pivot's FilterString / RawFilter
	 * @return {{ Stanzas: Array<{ Instruction: string, Field: string, Operator: string, Value: string, Values?: Array<string>, Offset: number }>, Warnings: Array<{ Code: string, Detail: any }> }}
	 */
	validate(pEntity, pFilterString, pOptions)
	{
		let tmpOptions = (typeof(pOptions) === 'object') && (pOptions !== null) ? pOptions : {};
		let tmpAllowDeleteColumn = (tmpOptions.AllowDeleteColumn === true);
		let tmpResult = { Stanzas: [], Warnings: [] };

		if ((pFilterString === null) || (typeof(pFilterString) === 'undefined') || (pFilterString === ''))
		{
			return tmpResult;
		}
		if (typeof(pFilterString) !== 'string')
		{
			throw libFacetErrors.create('FACET_FILTER_INVALID', 'The filter string must be a string.', { Offset: 0, Token: 'FilterString', Reason: 'NotAString' });
		}

		// Decode exactly once (the way meadow-endpoints decodes it).
		let tmpDecoded;
		try
		{
			tmpDecoded = decodeURIComponent(pFilterString);
		}
		catch (pError)
		{
			throw libFacetErrors.create('FACET_FILTER_INVALID', 'The filter string has a malformed percent-escape.', { Offset: 0, Token: 'Encoding', Reason: 'MalformedEscape' });
		}
		if (CONTROL_PATTERN.test(tmpDecoded))
		{
			throw libFacetErrors.create('FACET_FILTER_INVALID', 'The filter string contains control characters.', { Offset: 0, Token: 'Encoding', Reason: 'ControlCharacter' });
		}

		let tmpTerms = tmpDecoded.split('~');
		// The one tolerated artifact: a single trailing '~' (meadow-filter ignores the empty stanza).
		if (((tmpTerms.length % 4) === 1) && (tmpTerms.length > 1) && (tmpTerms[tmpTerms.length - 1] === ''))
		{
			tmpTerms.pop();
		}
		if ((tmpTerms.length % 4) !== 0)
		{
			this._invalid(Math.floor(tmpTerms.length / 4), 'PartialStanza', 'PartialStanza');
		}

		// Quads, with FSF stripped (sorting does not affect a facet; warned once).
		let tmpQuads = [];
		let tmpQuadCount = tmpTerms.length / 4;
		for (let i = 0; i < tmpQuadCount; i++)
		{
			let tmpQuad = { Instruction: tmpTerms[(i * 4)], Field: tmpTerms[(i * 4) + 1], Operator: tmpTerms[(i * 4) + 2], Value: tmpTerms[(i * 4) + 3], Offset: i };
			if (libFacetRequest.FILTER_STRIPPED_INSTRUCTIONS.indexOf(tmpQuad.Instruction) >= 0)
			{
				if (tmpResult.Warnings.length < 1)
				{
					tmpResult.Warnings.push({ Code: SORT_WARNING.Code, Detail: SORT_WARNING.Detail });
				}
				continue;
			}
			if (libFacetRequest.FILTER_INSTRUCTIONS.indexOf(tmpQuad.Instruction) < 0)
			{
				this._invalid(i, tmpQuad.Instruction.substring(0, 16), 'UnsupportedInstruction');
			}
			tmpQuads.push(tmpQuad);
		}

		// One whole-string fence (FOP … FCP around everything) is redundant — the service fences
		// the client filter anyway — so it is unwrapped once; this is the shape toFilterString
		// emits.  The group nesting rule then applies to what is inside.
		if ((tmpQuads.length >= 2) && (OPEN_INSTRUCTIONS.indexOf(tmpQuads[0].Instruction) >= 0) && (tmpQuads[tmpQuads.length - 1].Instruction === CLOSE_INSTRUCTION))
		{
			let tmpLevel = 0;
			let tmpMatch = -1;
			for (let i = 0; i < tmpQuads.length; i++)
			{
				if (OPEN_INSTRUCTIONS.indexOf(tmpQuads[i].Instruction) >= 0)
				{
					tmpLevel++;
				}
				else if (tmpQuads[i].Instruction === CLOSE_INSTRUCTION)
				{
					tmpLevel--;
					if (tmpLevel === 0)
					{
						tmpMatch = i;
						break;
					}
				}
			}
			if (tmpMatch === (tmpQuads.length - 1))
			{
				if (tmpQuads.length === 2)
				{
					this._invalid(tmpQuads[1].Offset, CLOSE_INSTRUCTION, 'EmptyGroup');
				}
				tmpQuads = tmpQuads.slice(1, tmpQuads.length - 1);
			}
		}

		let tmpDepth = 0;
		let tmpGroupSize = 0;
		let tmpOpenOffset = -1;

		for (let q = 0; q < tmpQuads.length; q++)
		{
			let tmpInstruction = tmpQuads[q].Instruction;
			let tmpField = tmpQuads[q].Field;
			let tmpOperator = tmpQuads[q].Operator;
			let tmpValue = tmpQuads[q].Value;
			let i = tmpQuads[q].Offset;

			if (OPEN_INSTRUCTIONS.indexOf(tmpInstruction) >= 0)
			{
				if (tmpDepth > 0)
				{
					this._invalid(i, tmpInstruction, 'NestedGroup');
				}
				tmpDepth = 1;
				tmpGroupSize = 0;
				tmpOpenOffset = i;
				tmpResult.Stanzas.push({ Instruction: tmpInstruction, Field: '', Operator: '(', Value: '', Offset: i });
				continue;
			}
			if (tmpInstruction === CLOSE_INSTRUCTION)
			{
				if (tmpDepth < 1)
				{
					this._invalid(i, tmpInstruction, 'UnbalancedParens');
				}
				if (tmpGroupSize < 1)
				{
					this._invalid(i, tmpInstruction, 'EmptyGroup');
				}
				tmpDepth = 0;
				tmpResult.Stanzas.push({ Instruction: tmpInstruction, Field: '', Operator: ')', Value: '', Offset: i });
				continue;
			}

			// A value stanza.
			if (VALUE_INSTRUCTIONS.indexOf(tmpInstruction) < 0)
			{
				this._invalid(i, tmpInstruction, 'UnsupportedInstruction');
			}
			if (!libFacetUtil.hasOwn(libFacetRequest.FILTER_OPERATOR_MAP, tmpOperator))
			{
				this._invalid(i, tmpOperator.substring(0, 16), 'UnsupportedOperator');
			}
			let tmpIsList = (LIST_INSTRUCTIONS.indexOf(tmpInstruction) >= 0);
			let tmpIsListOperator = (LIST_OPERATORS.indexOf(tmpOperator) >= 0);
			if (tmpIsList !== tmpIsListOperator)
			{
				this._invalid(i, tmpOperator, tmpIsList ? 'ListInstructionNeedsListOperator' : 'ListOperatorNeedsListInstruction');
			}
			let tmpColumn = this._column(pEntity, tmpField, i, tmpAllowDeleteColumn);

			let tmpStanza = { Instruction: tmpInstruction, Field: tmpField, Operator: tmpOperator, Value: tmpValue, Offset: i };
			let tmpPredOp = libFacetRequest.FILTER_OPERATOR_MAP[tmpOperator];
			if (tmpIsList)
			{
				let tmpItems = tmpValue.split(',');
				if (tmpItems.length > this.options.Limits.MaxInList)
				{
					this._invalid(i, 'Value', 'ListTooLong');
				}
				for (let j = 0; j < tmpItems.length; j++)
				{
					if (tmpItems[j].length < 1)
					{
						this._invalid(i, 'Value', 'EmptyListItem');
					}
					this._checkValue(tmpItems[j], i, tmpColumn);
				}
				tmpStanza.Values = tmpItems;
			}
			else if ((tmpPredOp !== 'NULL') && (tmpPredOp !== 'NOTNULL'))
			{
				this._checkValue(tmpValue, i, tmpColumn);
			}

			if (tmpDepth > 0)
			{
				tmpGroupSize++;
			}
			tmpResult.Stanzas.push(tmpStanza);
		}

		if (tmpDepth !== 0)
		{
			this._invalid(tmpOpenOffset, 'FOP', 'UnbalancedParens');
		}

		return tmpResult;
	}
}

module.exports = RetoldFacetingFilterValidator;
module.exports.serviceType = 'RetoldFacetingFilterValidator';
module.exports.SORT_WARNING = SORT_WARNING;
module.exports.VALUE_INSTRUCTIONS = VALUE_INSTRUCTIONS;
module.exports.LIST_INSTRUCTIONS = LIST_INSTRUCTIONS;
module.exports.LIST_OPERATORS = LIST_OPERATORS;
module.exports.OPEN_INSTRUCTIONS = OPEN_INSTRUCTIONS;
module.exports.OR_INSTRUCTIONS = OR_INSTRUCTIONS;
module.exports.CLOSE_INSTRUCTION = CLOSE_INSTRUCTION;
