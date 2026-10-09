/**
 * Facet-Lookup -- related-row lookups for the Records list, pure (no DOM, no pict, no fetch; the provider does
 * the transport, the node smoke test reuses the same functions).
 *
 * A facet list holds the rows of ONE entity (MaterialIntakeRequirement: IDMaterialIntake, IDLabFormType).  The
 * facets above it bucket on related fields (the intake's received date and queue, the form type's discipline),
 * so the list shows those too: a column names a Lookup, the provider reads the related rows by key through the
 * faceting Records route of the related entity (POST /1.0/Facet/<Entity>/Records/<Begin>/<Cap> with a key-list
 * clause; the same tenancy and personal scopes as every facet), caches them per principal, and the cell reads
 * them.  Lookups are display only: they never change a group's filter, Total or counts.
 *
 * Column (FacetDemo-Pages Records panel):
 *   { Field: 'IDMaterialIntake', Label: 'Queue',
 *     Lookup: { Entity: 'MaterialIntake', Key?: 'IDMaterialIntake', Show: 'IDLabQueue',
 *               Then: { Entity: 'LabQueue', Show: 'Name' } } }                       (a chain of single rows)
 *   { Field: 'IDMaterialIntake', Label: 'Started',
 *     Lookup: { Entity: 'LabForm', Key: 'IDMaterialIntake', Many: true, Match: { IDLabFormType: 'IDLabFormType' },
 *               Exists: { Field: 'Status', NotNull: true, NotEqual: 'Complete' }, Yes: 'Started', No: 'Not started' } }
 *   Show may be an array of fields (joined with a space); Key defaults to 'ID<Entity>'.
 *
 *   chains(pColumns)                         [ [ step, step… ] ] one chain per lookup column
 *   keyFieldOf(pStep)                        pStep.Key || 'ID' + pStep.Entity
 *   keysOf(pRows, pField)                    distinct non-null values of a field (first-seen order)
 *   chunk(pList, pSize)                      [ [..pSize], … ]
 *   requestBody(pKeyField, pKeys)            { Clauses: [ key-list clause ] }
 *   indexRows(pRows, pKeyField, pKeys)       { '<key>': [ rows ] } with [] for every requested key not found
 *   cellValue(pColumn, pRow, fRowsFor, pContext)
 *                                            { Text, Tip, Muted, Pending } (raw text; escape before display)
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFacetSelection = require('./Facet-Selection.js');

// Rows per lookup page (the service's default MaxRecordsPage) and keys per request (an IN list).
const PAGE_SIZE = 500;
const KEYS_PER_REQUEST = 200;

/**
 * @param {Record<string, any>} pStep
 * @return {string}
 */
const keyFieldOf = (pStep) =>
{
	return (pStep && (typeof(pStep.Key) === 'string') && (pStep.Key.length > 0)) ? pStep.Key : `ID${pStep ? pStep.Entity : ''}`;
};

/**
 * The lookup chains of a column list (one per Lookup column; a chain follows Then).
 *
 * @param {Array<Record<string, any>>} pColumns
 * @return {Array<Array<Record<string, any>>>}
 */
const chains = (pColumns) =>
{
	let tmpChains = [];
	(Array.isArray(pColumns) ? pColumns : []).forEach(
		(pColumn) =>
		{
			if (!pColumn || !pColumn.Lookup || (typeof(pColumn.Lookup.Entity) !== 'string'))
			{
				return;
			}
			let tmpChain = [ Object.assign({ From: pColumn.Field }, pColumn.Lookup) ];
			let tmpStep = pColumn.Lookup;
			while (tmpStep.Then && (typeof(tmpStep.Then.Entity) === 'string'))
			{
				tmpChain.push(Object.assign({ From: tmpStep.Show }, tmpStep.Then));
				tmpStep = tmpStep.Then;
			}
			tmpChains.push(tmpChain);
		});
	return tmpChains;
};

/**
 * Distinct non-null, non-empty values of a field, first-seen order.
 *
 * @param {Array<Record<string, any>>} pRows
 * @param {string} pField
 * @return {Array<any>}
 */
const keysOf = (pRows, pField) =>
{
	let tmpSeen = {};
	let tmpKeys = [];
	(Array.isArray(pRows) ? pRows : []).forEach(
		(pRow) =>
		{
			let tmpValue = pRow ? pRow[pField] : null;
			if ((tmpValue === null) || (typeof(tmpValue) === 'undefined') || (tmpValue === '') || (typeof(tmpValue) === 'object'))
			{
				return;
			}
			let tmpToken = `${typeof(tmpValue)}:${tmpValue}`;
			if (!tmpSeen[tmpToken])
			{
				tmpSeen[tmpToken] = true;
				tmpKeys.push(tmpValue);
			}
		});
	return tmpKeys;
};

/**
 * @param {Array<any>} pList
 * @param {number} pSize
 * @return {Array<Array<any>>}
 */
const chunk = (pList, pSize) =>
{
	let tmpChunks = [];
	let tmpList = Array.isArray(pList) ? pList : [];
	let tmpSize = Math.max(1, pSize || KEYS_PER_REQUEST);
	for (let i = 0; i < tmpList.length; i += tmpSize)
	{
		tmpChunks.push(tmpList.slice(i, i + tmpSize));
	}
	return tmpChunks;
};

/**
 * The body of one lookup request: the related rows whose pKeyField is one of pKeys.
 *
 * @param {string} pKeyField
 * @param {Array<any>} pKeys
 * @return {Record<string, any>}
 */
const requestBody = (pKeyField, pKeys) =>
{
	return { Clauses: [ libFacetSelection.lookupClause(pKeyField, pKeys) ] };
};

/**
 * Index looked-up rows by their key field; every requested key gets an entry ([] when no visible row has it).
 *
 * @param {Array<Record<string, any>>} pRows
 * @param {string} pKeyField
 * @param {Array<any>} pKeys - the keys that were requested
 * @return {Record<string, Array<Record<string, any>>>}
 */
const indexRows = (pRows, pKeyField, pKeys) =>
{
	let tmpIndex = {};
	(Array.isArray(pKeys) ? pKeys : []).forEach((pKey) => { tmpIndex[String(pKey)] = []; });
	(Array.isArray(pRows) ? pRows : []).forEach(
		(pRow) =>
		{
			let tmpKey = String(pRow ? pRow[pKeyField] : '');
			if (!tmpIndex[tmpKey])
			{
				tmpIndex[tmpKey] = [];
			}
			tmpIndex[tmpKey].push(pRow);
		});
	return tmpIndex;
};

/**
 * The value a step shows from one related row.
 *
 * @param {Record<string, any>} pStep
 * @param {Record<string, any>} pRow
 * @return {any}
 */
const shownValue = (pStep, pRow) =>
{
	if (Array.isArray(pStep.Show))
	{
		let tmpParts = pStep.Show.map((pField) => { return pRow[pField]; }).filter((pValue) => { return (pValue !== null) && (typeof(pValue) !== 'undefined') && (pValue !== ''); });
		return (tmpParts.length > 0) ? tmpParts.join(' ') : null;
	}
	return pRow[pStep.Show];
};

/**
 * 'MaterialType' -> 'Material type' (names a missing related row).
 *
 * @param {string} pEntity
 * @return {string}
 */
const entityNoun = (pEntity) =>
{
	let tmpWords = String(pEntity || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ');
	return tmpWords.map((pWord, pIndex) => { return (pIndex === 0) ? pWord : pWord.toLowerCase(); }).join(' ');
};

/**
 * One list cell of a Lookup column.
 *
 * @param {Record<string, any>} pColumn - { Field, Lookup, KeyNoun?, MarkCurrentUser? }
 * @param {Record<string, any>} pRow - the list row
 * @param {(pEntity: string, pKeyField: string, pKey: any) => Array<Record<string, any>>|undefined} fRowsFor - cached rows (undefined = not loaded yet)
 * @param {{ CurrentUser?: number|null, Failed?: boolean }} [pContext]
 * @return {{ Text: string, Tip: string, Muted: boolean, Pending: boolean }}
 */
const cellValue = (pColumn, pRow, fRowsFor, pContext) =>
{
	let tmpContext = pContext || {};
	let tmpLookup = pColumn.Lookup;
	let tmpKey = pRow ? pRow[pColumn.Field] : null;
	if ((tmpKey === null) || (typeof(tmpKey) === 'undefined') || (tmpKey === ''))
	{
		return { Text: '—', Tip: '', Muted: true, Pending: false };
	}
	let tmpPending = { Text: tmpContext.Failed ? '?' : '…', Tip: tmpContext.Failed ? 'The lookup failed (see the inspector).' : `Looking up ${tmpLookup.Entity} ${tmpKey}`, Muted: true, Pending: !tmpContext.Failed };

	// Exists: does any related row (matching the row on Match) satisfy the predicate?
	if (tmpLookup.Exists)
	{
		let tmpRows = fRowsFor(tmpLookup.Entity, keyFieldOf(tmpLookup), tmpKey);
		if (!Array.isArray(tmpRows))
		{
			return tmpPending;
		}
		let tmpMatch = tmpLookup.Match || {};
		let tmpPredicate = tmpLookup.Exists;
		let tmpFound = tmpRows.some(
			(pRelated) =>
			{
				let tmpMatches = Object.keys(tmpMatch).every((pRelatedField) => { return libFacetSelection.sameKey(pRelated[pRelatedField], pRow[tmpMatch[pRelatedField]]); });
				if (!tmpMatches)
				{
					return false;
				}
				let tmpValue = pRelated[tmpPredicate.Field];
				if (tmpPredicate.NotNull && ((tmpValue === null) || (typeof(tmpValue) === 'undefined')))
				{
					return false;
				}
				if ((typeof(tmpPredicate.NotEqual) !== 'undefined') && (tmpValue === tmpPredicate.NotEqual))
				{
					return false;
				}
				return true;
			});
		return { Text: tmpFound ? (tmpLookup.Yes || 'Yes') : (tmpLookup.No || 'No'), Tip: tmpLookup.Tip || '', Muted: !tmpFound, Pending: false };
	}

	// A chain of single rows: key -> row -> Show (-> Then …).
	let tmpStep = tmpLookup;
	let tmpValue = tmpKey;
	let tmpTrail = [];
	while (tmpStep)
	{
		let tmpRows = fRowsFor(tmpStep.Entity, keyFieldOf(tmpStep), tmpValue);
		if (!Array.isArray(tmpRows))
		{
			return tmpPending;
		}
		if (tmpRows.length < 1)
		{
			// Name the row that is missing: the column's own key (KeyNoun), or a later step's entity.
			let tmpNoun = (tmpStep === tmpLookup) ? (pColumn.KeyNoun || '') : entityNoun(tmpStep.Entity);
			return { Text: `${tmpNoun ? `${tmpNoun} ` : ''}#${tmpValue} (no name)`, Tip: `No ${tmpStep.Entity} row with ${keyFieldOf(tmpStep)} ${tmpValue} is visible to this principal (deleted, or another tenant's).${(tmpStep === tmpLookup) ? ' The key still filters.' : ''}`, Muted: true, Pending: false };
		}
		tmpTrail.push(`${tmpStep.Entity} ${tmpValue}`);
		tmpValue = shownValue(tmpStep, tmpRows[0]);
		if ((tmpValue === null) || (typeof(tmpValue) === 'undefined') || (tmpValue === ''))
		{
			return { Text: '—', Tip: `${tmpTrail.join(' → ')}: no value`, Muted: true, Pending: false };
		}
		tmpStep = (tmpStep.Then && (typeof(tmpStep.Then.Entity) === 'string')) ? tmpStep.Then : null;
	}
	let tmpText = String(tmpValue);
	if (pColumn.MarkCurrentUser && (tmpContext.CurrentUser !== null) && (typeof(tmpContext.CurrentUser) !== 'undefined') && libFacetSelection.sameKey(tmpKey, tmpContext.CurrentUser))
	{
		tmpText = `${tmpText} (you)`;
	}
	return { Text: tmpText, Tip: `${pColumn.Field} ${tmpKey}${(tmpTrail.length > 1) ? ` · ${tmpTrail.join(' → ')}` : ''}`, Muted: false, Pending: false };
};

module.exports = (
	{
		PAGE_SIZE: PAGE_SIZE,
		KEYS_PER_REQUEST: KEYS_PER_REQUEST,
		keyFieldOf: keyFieldOf,
		chains: chains,
		keysOf: keysOf,
		chunk: chunk,
		requestBody: requestBody,
		indexRows: indexRows,
		shownValue: shownValue,
		entityNoun: entityNoun,
		cellValue: cellValue
	});
