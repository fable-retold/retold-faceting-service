/**
 * Facet Contract - Clauses
 *
 * PURE: requires nothing outside source/contract/. Shared with pict-section-facet.
 *
 * Clause signatures and hashes, own-clause detection (D-05, internal-contracts §6.2), bucket →
 * clause synthesis and "which buckets are selected" (02 §5, internal-contracts §10.7 and §10.8).
 *
 * Milestone 2 (internal-contracts §29.3, §29.4): one-hop to-one path facets (K8) write
 * InternalJoin* clauses, bridge-form N:M facets (K9 over '<J.a >J.b' keyed by the target key)
 * write ExternalJoinSelectedValueList, and every other cross-entity bucket (ChildRollup,
 * ExistsSplit, multi-hop K8, other K9 paths, TuplePivot) is Selection-only (Clause null).  The
 * selected keys / ranges of a path facet are read from the owned join conjuncts (an Exists over
 * the facet's own path whose Where constrains the facet's field).
 *
 * @author Steven Velozo <steven@velozo.com>
 */

const libFacetBuckets = require('./Facet-Contract-Buckets.js');
const libFacetUtil = require('./Facet-Contract-Util.js');

// Folds whose buckets are ranges (Start / End) rather than terms.
const RANGE_FOLDS = Object.freeze([ 'DateHistogram', 'NumericHistogram', 'Ranges' ]);

// Folds whose buckets never carry a Clause in M2 (Selection only, internal-contracts §29.3).
const SELECTION_ONLY_FOLDS = Object.freeze([ 'ChildRollup', 'ExistsSplit' ]);

// FoldIR dimension kinds that are Selection-only (internal-contracts §24.3).
const SELECTION_ONLY_DIMENSIONS = Object.freeze([ 'ChildAgg', 'ExistsFlag' ]);

// A path step string: direction, entity, column.
const PATH_STEP_PATTERN = /^([<>=])([A-Za-z_][A-Za-z0-9_]{0,63})\.([A-Za-z_][A-Za-z0-9_]{0,63})$/;
const PATH_DIRECTIONS = Object.freeze({ '>': 'Forward', '<': 'Reverse', '=': 'CoReference' });

// A value that decodes (once more) to the meadow-filter separator '~'.  Such a value cannot be a
// clause value (the ClauseCompiler and the FilterValidator refuse it), so a Terms key holding one
// is an UnsafeKey (03 §6.1): its bucket keeps its Selection but gets no Clause.
const TILDE_PATTERN = /~|%7e/i;

// ---------------------------------------------------------------- Canonical JSON and hashing

/**
 * Deterministic JSON: object keys sorted, undefined members dropped, arrays in order.
 *
 * @param {any} pValue
 * @return {string}
 */
const canonicalJSON = (pValue) =>
{
	if ((pValue === null) || (typeof(pValue) === 'undefined'))
	{
		return 'null';
	}
	if (Array.isArray(pValue))
	{
		let tmpItems = [];
		for (let i = 0; i < pValue.length; i++)
		{
			tmpItems.push(canonicalJSON(pValue[i]));
		}
		return `[${tmpItems.join(',')}]`;
	}
	if (typeof(pValue) === 'object')
	{
		if (Object.prototype.toString.call(pValue) === '[object Date]')
		{
			return JSON.stringify(pValue);
		}
		let tmpKeys = Object.keys(pValue).sort();
		let tmpMembers = [];
		for (let i = 0; i < tmpKeys.length; i++)
		{
			let tmpMember = pValue[tmpKeys[i]];
			if ((typeof(tmpMember) === 'undefined') || (typeof(tmpMember) === 'function'))
			{
				continue;
			}
			tmpMembers.push(`${JSON.stringify(tmpKeys[i])}:${canonicalJSON(tmpMember)}`);
		}
		return `{${tmpMembers.join(',')}}`;
	}
	if (typeof(pValue) === 'bigint')
	{
		return pValue.toString();
	}
	if (typeof(pValue) === 'function')
	{
		return 'null';
	}
	return JSON.stringify(pValue);
};

/**
 * A short, deterministic, NON-cryptographic hash (two FNV-1a 32-bit lanes → 16 hex).  For clause
 * identity only; the service hashes Versions with crypto itself.
 *
 * @param {string} pText
 * @return {string}
 */
const shortHash = (pText) =>
{
	let tmpText = String(pText);
	let tmpLaneA = 0x811c9dc5;
	let tmpLaneB = 0x01000193 ^ 0x5bd1e995;
	for (let i = 0; i < tmpText.length; i++)
	{
		let tmpCode = tmpText.charCodeAt(i);
		tmpLaneA = Math.imul(tmpLaneA ^ tmpCode, 0x01000193) >>> 0;
		tmpLaneB = Math.imul(tmpLaneB ^ tmpCode ^ (i & 0xff), 0x01000193) >>> 0;
	}
	return tmpLaneA.toString(16).padStart(8, '0') + tmpLaneB.toString(16).padStart(8, '0');
};

/**
 * The column list a clause filters by (FilterByColumns, else FilterByColumn, else []).
 *
 * @param {Record<string, any>} pClause
 * @return {Array<string>}
 */
const clauseColumns = (pClause) =>
{
	if (Array.isArray(pClause.FilterByColumns))
	{
		return pClause.FilterByColumns.slice();
	}
	return (typeof(pClause.FilterByColumn) === 'string') ? [ pClause.FilterByColumn ] : [];
};

/**
 * A stable signature for a pict clause (used for ownership when a clause has no Hash):
 * Type + FilterKey + FilterByColumn(s).  Values are NOT part of it: two selections on the same
 * widget share a signature.
 *
 * @param {Record<string, any>} pClause
 * @return {string}
 */
const clauseSignature = (pClause) =>
{
	if ((typeof(pClause) !== 'object') || (pClause === null))
	{
		return '';
	}
	return `${pClause.Type || ''}|${pClause.FilterKey || ''}|${clauseColumns(pClause).join(',')}`;
};

/**
 * A deterministic content hash for a clause, in pict's '<FilterKey>-<ClauseKey>-<id>' shape
 * (pict stamps a UUID; this is a stable digest of the clause's meaning instead).  Two clauses with
 * the same type, key, columns, values and exclusivity flags hash the same.
 *
 * @param {Record<string, any>} pClause
 * @return {string} '' for a non-object
 */
const clauseHash = (pClause) =>
{
	if ((typeof(pClause) !== 'object') || (pClause === null))
	{
		return '';
	}
	let tmpColumns = clauseColumns(pClause);
	let tmpFilterKey = pClause.FilterKey || ((tmpColumns.length === 1) ? tmpColumns[0] : tmpColumns.join('+'));
	let tmpContent = canonicalJSON(
		{
			Type: pClause.Type,
			FilterKey: tmpFilterKey,
			Columns: tmpColumns,
			Values: pClause.Values,
			Value: pClause.Value,
			Filter: pClause.Filter,
			StartExclusive: (pClause.StartExclusive === true) || undefined,
			EndExclusive: (pClause.EndExclusive === true) || undefined,
			ExactMatch: pClause.ExactMatch
		});
	return `${tmpFilterKey}-${pClause.ClauseKey || pClause.Type || 'Clause'}-${shortHash(tmpContent).slice(0, 12)}`;
};

// ---------------------------------------------------------------- Ownership (D-05, internal-contracts §6.2)

/**
 * Why facet pFacetSpec owns conjunct pConjunct, or null.  Matching order: the conjunct's Origin.Hash
 * or Id is listed in an explicit Exclude array → 'Explicit'; Origin.FilterKey equals the facet's
 * FilterKey → 'FilterKey'; every conjunct field is in OwnedFields → 'Fields'.
 *
 * @param {{ OwnedFields: Array<string>, FilterKey?: string|null, Exclude?: any }} pFacetSpec
 * @param {Record<string, any>} pConjunct - internal-contracts §4.2
 * @return {'Explicit'|'FilterKey'|'Fields'|null}
 */
const ownership = (pFacetSpec, pConjunct) =>
{
	if (!pFacetSpec || !pConjunct)
	{
		return null;
	}
	let tmpOrigin = pConjunct.Origin || {};
	if (Array.isArray(pFacetSpec.Exclude))
	{
		if (((typeof(tmpOrigin.Hash) === 'string') && (pFacetSpec.Exclude.indexOf(tmpOrigin.Hash) >= 0))
			|| ((typeof(pConjunct.Id) === 'string') && (pFacetSpec.Exclude.indexOf(pConjunct.Id) >= 0)))
		{
			return 'Explicit';
		}
	}
	if ((typeof(pFacetSpec.FilterKey) === 'string') && (pFacetSpec.FilterKey.length > 0)
		&& (typeof(tmpOrigin.FilterKey) === 'string') && (tmpOrigin.FilterKey === pFacetSpec.FilterKey))
	{
		return 'FilterKey';
	}
	let tmpOwnedFields = Array.isArray(pFacetSpec.OwnedFields) ? pFacetSpec.OwnedFields : [];
	let tmpFields = Array.isArray(pConjunct.Fields) ? pConjunct.Fields : [];
	if ((tmpFields.length > 0) && tmpFields.every((pField) => { return tmpOwnedFields.indexOf(pField) >= 0; }))
	{
		return 'Fields';
	}
	return null;
};

/**
 * A mixed conjunct: not owned, but its fields intersect the facet's OwnedFields.
 *
 * @param {{ OwnedFields: Array<string> }} pFacetSpec
 * @param {Record<string, any>} pConjunct
 * @return {boolean}
 */
const isMixed = (pFacetSpec, pConjunct) =>
{
	if (!pFacetSpec || !pConjunct || (ownership(pFacetSpec, pConjunct) !== null))
	{
		return false;
	}
	let tmpOwnedFields = Array.isArray(pFacetSpec.OwnedFields) ? pFacetSpec.OwnedFields : [];
	let tmpFields = Array.isArray(pConjunct.Fields) ? pConjunct.Fields : [];
	return tmpFields.some((pField) => { return tmpOwnedFields.indexOf(pField) >= 0; });
};

/**
 * The full per-facet exclusion decision of internal-contracts §6.2 (pure; the DisjunctivePlanner
 * groups facets with equal Kept lists into Variants).
 *
 * @param {{ Key?: string, OwnedFields: Array<string>, FilterKey?: string|null, Exclude?: any }} pFacetSpec - Exclude: 'Self' | 'None' | [ids/hashes] (null → 'Self')
 * @param {Array<Record<string, any>>} pConjuncts - FilterAST.Conjuncts, in order
 * @return {{ Mode: string, Owned: Array<string>, Excluded: Array<string>, ExcludedHashes: Array<string|null>, KeptMixed: Array<string>, Kept: Array<string> }}
 */
const exclusionFor = (pFacetSpec, pConjuncts) =>
{
	let tmpPolicy = (pFacetSpec && ((pFacetSpec.Exclude === 'None') || Array.isArray(pFacetSpec.Exclude))) ? pFacetSpec.Exclude : 'Self';
	let tmpResult = { Mode: 'Exact', Owned: [], Excluded: [], ExcludedHashes: [], KeptMixed: [], Kept: [] };
	let tmpConjuncts = Array.isArray(pConjuncts) ? pConjuncts : [];
	for (let i = 0; i < tmpConjuncts.length; i++)
	{
		let tmpConjunct = tmpConjuncts[i];
		let tmpReason = ownership(pFacetSpec, tmpConjunct);
		if (tmpReason !== null)
		{
			tmpResult.Owned.push(tmpConjunct.Id);
		}
		if ((tmpPolicy !== 'None') && (tmpReason !== null) && (tmpConjunct.NeverExclude !== true))
		{
			tmpResult.Excluded.push(tmpConjunct.Id);
			tmpResult.ExcludedHashes.push(((tmpConjunct.Origin || {}).Hash) || null);
			continue;
		}
		tmpResult.Kept.push(tmpConjunct.Id);
		if ((tmpPolicy !== 'None') && (((tmpReason !== null) && (tmpConjunct.NeverExclude === true)) || isMixed(pFacetSpec, tmpConjunct)))
		{
			tmpResult.KeptMixed.push(tmpConjunct.Id);
		}
	}
	tmpResult.Mode = (tmpPolicy === 'None') ? 'NotApplicable' : ((tmpResult.KeptMixed.length > 0) ? 'Partial' : 'Exact');
	return tmpResult;
};

// ---------------------------------------------------------------- Bucket → clause (02 §5, internal-contracts §10.7)

const isPresent = libFacetUtil.isPresent;

/**
 * Can this Terms key be written back as a clause value?
 *
 * @param {any} pKey
 * @return {boolean}
 */
const isClauseSafeKey = (pKey) =>
{
	return !((typeof(pKey) === 'string') && TILDE_PATTERN.test(pKey));
};

/**
 * The signature of a path in any of its forms: a PathPlan (its Signature, else its step Raw
 * strings), a JSON array of step strings / step objects, or the space-separated string sugar.
 *
 * @param {any} pPath
 * @return {string|null}
 */
const pathSignatureOf = (pPath) =>
{
	if (typeof(pPath) === 'string')
	{
		let tmpParts = pPath.trim().split(/\s+/).filter((pPart) => { return pPart.length > 0; });
		return (tmpParts.length > 0) ? tmpParts.join(' ') : null;
	}
	if (Array.isArray(pPath))
	{
		if (pPath.length < 1)
		{
			return null;
		}
		let tmpParts = pPath.map(
			(pStep) =>
			{
				if (typeof(pStep) === 'string')
				{
					return pStep;
				}
				if (libFacetUtil.isPlainObject(pStep))
				{
					return (typeof(pStep.Raw) === 'string') ? pStep.Raw : ((typeof(pStep.Step) === 'string') ? pStep.Step : null);
				}
				return null;
			});
		return tmpParts.every((pPart) => { return typeof(pPart) === 'string'; }) ? tmpParts.join(' ') : null;
	}
	if (libFacetUtil.isPlainObject(pPath))
	{
		if ((typeof(pPath.Signature) === 'string') && (pPath.Signature.length > 0))
		{
			return pPath.Signature;
		}
		if (Array.isArray(pPath.Steps))
		{
			return pathSignatureOf(pPath.Steps);
		}
	}
	return null;
};

/**
 * The steps of a facet's dimension path in one shape, from the dimension's PathPlan when it carries
 * one, else from the Agg's Path step strings plus the On pairs of the FoldIR Dim's Via links (K8) or
 * Multi Chain (K9) (internal-contracts §24.3, §24.8):
 *
 *   [ { Direction, Entity, Column, To, FromColumn, ToColumn } ]   ('E.c' of the walked edge; [ FromColumn, ToColumn ] = the step's On pair)
 *
 * @param {any} pPath - Agg.Path (step strings) or a PathPlan
 * @param {Record<string, any>|null} pDimension - the FoldIR Dim (or a CanonicalDim)
 * @return {Array<Record<string, any>>|null}
 */
const pathStepsOf = (pPath, pDimension) =>
{
	let tmpDimension = libFacetUtil.isPlainObject(pDimension) ? pDimension : {};
	let tmpPlan = libFacetUtil.isPlainObject(tmpDimension.Path) ? tmpDimension.Path : (libFacetUtil.isPlainObject(pPath) ? pPath : null);
	if (tmpPlan && Array.isArray(tmpPlan.Steps))
	{
		return tmpPlan.Steps.map(
			(pStep) =>
			{
				let tmpEdge = (typeof(pStep.Edge) === 'string') ? pStep.Edge.split('.') : [ null, null ];
				let tmpOn = (Array.isArray(pStep.On) && Array.isArray(pStep.On[0])) ? pStep.On[0] : [ null, null ];
				return { Direction: pStep.Direction || null, Entity: tmpEdge[0], Column: tmpEdge[1], To: pStep.To || null, FromColumn: tmpOn[0], ToColumn: tmpOn[1] };
			});
	}
	let tmpRaw = Array.isArray(pPath) ? pPath : ((typeof(pPath) === 'string') ? pPath.trim().split(/\s+/) : null);
	if (!tmpRaw || (tmpRaw.length < 1))
	{
		return null;
	}
	let tmpLinks = Array.isArray(tmpDimension.Via) ? tmpDimension.Via : (Array.isArray(tmpDimension.Chain) ? tmpDimension.Chain : []);
	return tmpRaw.map(
		(pRawStep, pIndex) =>
		{
			let tmpText = (typeof(pRawStep) === 'string') ? pRawStep : (libFacetUtil.isPlainObject(pRawStep) ? (pRawStep.Raw || pRawStep.Step) : null);
			let tmpMatch = (typeof(tmpText) === 'string') ? PATH_STEP_PATTERN.exec(tmpText) : null;
			let tmpLink = libFacetUtil.isPlainObject(tmpLinks[pIndex]) ? tmpLinks[pIndex] : null;
			let tmpOn = (tmpLink && Array.isArray(tmpLink.On) && libFacetUtil.isPlainObject(tmpLink.On[0])) ? tmpLink.On[0] : null;
			return (
				{
					Direction: tmpMatch ? PATH_DIRECTIONS[tmpMatch[1]] : null,
					Entity: tmpMatch ? tmpMatch[2] : null,
					Column: tmpMatch ? tmpMatch[3] : null,
					To: (tmpLink && libFacetUtil.isPlainObject(tmpLink.Rel)) ? (tmpLink.Rel.Entity || null) : null,
					FromColumn: (tmpOn && libFacetUtil.isPlainObject(tmpOn.Outer)) ? (tmpOn.Outer.Field || null) : null,
					ToColumn: tmpOn ? (tmpOn.Inner || null) : null
				});
		});
};

/**
 * Does a facet measure a dimension path (K8 / K9)?
 *
 * @param {Record<string, any>} pFacetMeta
 * @return {boolean}
 */
const hasDimensionPath = (pFacetMeta) =>
{
	if (Array.isArray(pFacetMeta.Path) && (pFacetMeta.Path.length > 0))
	{
		return true;
	}
	let tmpDimension = libFacetUtil.isPlainObject(pFacetMeta.Dimension) ? pFacetMeta.Dimension : null;
	return !!(tmpDimension && ((libFacetUtil.isPlainObject(tmpDimension.Path) && Array.isArray(tmpDimension.Path.Steps))
		|| (tmpDimension.Kind === 'Multi') || (Array.isArray(tmpDimension.Via) && (tmpDimension.Via.length > 0))));
};

/**
 * Does a path dimension restrict its hops beyond the bare edges (internal-contracts §29.3)?  A step
 * Where, a TenantOnly step, a CheckParent co-reference, or a dimension Where narrows which related
 * rows count; the pict InternalJoin* / ExternalJoin* clauses carry only the edges, so such a bucket
 * has no standard Clause (it would select more rows than the bucket counted: I4 / O2).
 *
 * Reads either form of the dimension: a CanonicalDim (Path a PathPlan with step Where / Scope /
 * CheckParent, Where) or a lowered FoldIR Dim (Via / Chain links whose Rel carries the step's column
 * Where and Scope, Multi.Where for the rest).
 *
 * @param {Record<string, any>|null} pDimension
 * @param {Record<string, any>|null} [pPathPlan] - the canonical PathPlan, when the caller has it
 * @return {boolean}
 */
const pathRestricted = (pDimension, pPathPlan) =>
{
	let fPresent = (pValue) =>
	{
		return (pValue !== null) && (typeof(pValue) !== 'undefined') && !(Array.isArray(pValue) && (pValue.length < 1));
	};
	let fStepRestricted = (pStep) =>
	{
		return libFacetUtil.isPlainObject(pStep)
			&& (fPresent(pStep.Where) || ((typeof(pStep.Scope) === 'string') && (pStep.Scope !== 'Inherit')) || (pStep.CheckParent === true));
	};
	let fLinkRestricted = (pLink) =>
	{
		let tmpRel = (libFacetUtil.isPlainObject(pLink) && libFacetUtil.isPlainObject(pLink.Rel)) ? pLink.Rel : null;
		return !!tmpRel && (fPresent(tmpRel.Where) || ((typeof(tmpRel.Scope) === 'string') && (tmpRel.Scope !== 'Inherit')));
	};
	let tmpPlans = [ pPathPlan ];
	let tmpDimension = libFacetUtil.isPlainObject(pDimension) ? pDimension : {};
	if (libFacetUtil.isPlainObject(tmpDimension.Path))
	{
		tmpPlans.push(tmpDimension.Path);
	}
	for (let i = 0; i < tmpPlans.length; i++)
	{
		if (libFacetUtil.isPlainObject(tmpPlans[i]) && Array.isArray(tmpPlans[i].Steps) && tmpPlans[i].Steps.some(fStepRestricted))
		{
			return true;
		}
	}
	if (fPresent(tmpDimension.Where))
	{
		return true;
	}
	let tmpLinks = [].concat(Array.isArray(tmpDimension.Via) ? tmpDimension.Via : [], Array.isArray(tmpDimension.Chain) ? tmpDimension.Chain : []);
	return tmpLinks.some(fLinkRestricted);
};

/**
 * The bucket clause of a path facet (internal-contracts §29.3): K8 over exactly one '>' step →
 * InternalJoin*; K9 over exactly '<J.a >J.b' keyed by the target key → ExternalJoinSelectedValueList;
 * anything else → null (Selection only).
 *
 * @param {Record<string, any>} pFacetMeta
 * @param {Record<string, any>} pBucket
 * @param {string} pFold
 * @return {Record<string, any>|null}
 */
const pathBucketClause = (pFacetMeta, pBucket, pFold) =>
{
	let tmpDimension = libFacetUtil.isPlainObject(pFacetMeta.Dimension) ? pFacetMeta.Dimension : {};
	if ((pFacetMeta.PathRestricted === true) || pathRestricted(tmpDimension, null))
	{
		// Step / dimension Wheres, TenantOnly, CheckParent: no pict clause carries them (Selection only).
		return null;
	}
	let tmpSteps = pathStepsOf(pFacetMeta.Path, tmpDimension);
	if (!tmpSteps || tmpSteps.some((pStep) => { return !pStep.Direction; }))
	{
		return null;
	}
	let tmpField = ((typeof(pFacetMeta.Field) === 'string') && (pFacetMeta.Field.length > 0)) ? pFacetMeta.Field
		: (tmpDimension.Field || tmpDimension.KeyField || null);
	let tmpFilterKey = ((typeof(pFacetMeta.FilterKey) === 'string') && (pFacetMeta.FilterKey.length > 0)) ? pFacetMeta.FilterKey : tmpField;
	let tmpMultiValued = (tmpDimension.Kind === 'Multi') || (pFacetMeta.MultiValued === true) || tmpSteps.some((pStep) => { return pStep.Direction !== 'Forward'; });

	if (tmpMultiValued)
	{
		// K9: only the bridge form '<J.a >J.b' ending at the target key.
		let tmpKeyField = tmpDimension.KeyField || tmpField;
		if ((pFold !== 'Terms') || (tmpSteps.length !== 2) || (tmpSteps[0].Direction !== 'Reverse') || (tmpSteps[1].Direction !== 'Forward')
			|| (tmpSteps[0].Entity !== tmpSteps[1].Entity) || !tmpSteps[0].FromColumn || !tmpSteps[1].To || !tmpSteps[1].ToColumn
			|| (tmpKeyField !== tmpSteps[1].ToColumn))
		{
			return null;
		}
		if (!isPresent(pBucket.Key) || !isClauseSafeKey(pBucket.Key))
		{
			return null;
		}
		return (
			{
				Type: 'ExternalJoinSelectedValueList',
				CoreConnectionColumn: tmpSteps[0].FromColumn,
				JoinTable: tmpSteps[0].Entity,
				JoinTableCoreConnectionColumn: tmpSteps[0].Column,
				JoinTableExternalConnectionColumn: tmpSteps[1].Column,
				ExternalFilterByTable: tmpSteps[1].To,
				ExternalFilterByTableConnectionColumn: tmpSteps[1].ToColumn,
				ExternalFilterTableLookupColumn: tmpKeyField,
				Values: [ pBucket.Key ],
				FilterKey: tmpFilterKey,
				ClauseKey: 'ExternalJoinSelectedValueList'
			});
	}

	// K8: exactly one '>' step (a longer to-one path has no standard clause).
	if ((tmpSteps.length !== 1) || !tmpSteps[0].To || !tmpSteps[0].ToColumn || !tmpField)
	{
		return null;
	}
	let tmpStep = tmpSteps[0];
	let tmpJoin =
		{
			RemoteTable: tmpStep.To,
			JoinInternalConnectionColumn: tmpStep.FromColumn || tmpStep.Column,
			JoinExternalConnectionColumn: tmpStep.ToColumn
		};
	switch (pFold)
	{
		case 'Terms':
			if (!isPresent(pBucket.Key) || !isClauseSafeKey(pBucket.Key))
			{
				return null;
			}
			if (tmpField === tmpStep.ToColumn)
			{
				return Object.assign({ Type: 'InternalJoinSelectedValueList' }, tmpJoin,
					{ ExternalFilterTableLookupColumn: tmpField, Values: [ pBucket.Key ], FilterKey: tmpFilterKey, ClauseKey: 'InternalJoinSelectedValueList' });
			}
			return Object.assign({ Type: 'InternalJoinMatch' }, tmpJoin,
				{ ExternalFilterByColumns: [ tmpField ], ExactMatch: true, Values: [ pBucket.Key ], FilterKey: tmpFilterKey, ClauseKey: 'InternalJoinMatch' });
		case 'DateHistogram':
			if (!isPresent(pBucket.Start) || !isPresent(pBucket.End))
			{
				return null;
			}
			return Object.assign({ Type: 'InternalJoinDateRange' }, tmpJoin,
				{ ExternalFilterByColumns: [ tmpField ], Values: { Start: pBucket.Start, End: pBucket.End }, EndExclusive: true, FilterKey: tmpFilterKey, ClauseKey: 'InternalJoinDateRange' });
		case 'NumericHistogram':
		case 'Ranges':
			{
				if (!isPresent(pBucket.Start) && !isPresent(pBucket.End))
				{
					return null;
				}
				let tmpValues = {};
				if (isPresent(pBucket.Start))
				{
					tmpValues.Start = pBucket.Start;
				}
				if (isPresent(pBucket.End))
				{
					tmpValues.End = pBucket.End;
				}
				return Object.assign({ Type: 'InternalJoinNumericRange' }, tmpJoin,
					{ ExternalFilterByColumns: [ tmpField ], Values: tmpValues, EndExclusive: (pBucket.EndExclusive !== false), FilterKey: tmpFilterKey, ClauseKey: 'InternalJoinNumericRange' });
			}
		default:
			return null;
	}
};

/**
 * The standard pict clause that selects exactly this bucket (or null when none expresses it:
 * Stats/DistinctCount/Missing/Pivot, a null Terms key, a key holding '~' (UnsafeKey), an unbounded
 * range bucket, and the Selection-only M2 buckets).
 *
 *   Terms                       { Type: 'DistinctSelectedValueList', FilterByColumn, Values: [ Key ], FilterKey, ClauseKey }
 *   DateHistogram               { Type: 'DateRange', FilterByColumn, Values: { Start, End }, EndExclusive: true, FilterKey, ClauseKey }
 *   NumericHistogram / Ranges   { Type: 'NumericRange', FilterByColumn, Values: { Start?, End? }, EndExclusive, FilterKey, ClauseKey }
 *   path facets (M2)            pathBucketClause (internal-contracts §29.3)
 *
 * pFacetMeta may carry, besides { Fold, Field, FilterKey, DataType }: Path (Agg.Path step strings),
 * Dimension (the FoldIR Dim), Tuple (Agg.Tuple: no clause), MultiValued.
 *
 * @param {{ Fold?: string, Kind?: string, Field?: string, FilterKey?: string, DataType?: string, Path?: any, Dimension?: Record<string, any>, Tuple?: any, MultiValued?: boolean }} pFacetMeta - a FacetResult or an Agg
 * @param {{ Key: any, Start?: any, End?: any, EndExclusive?: boolean }} pBucket
 * @return {Record<string, any>|null}
 */
const bucketClause = (pFacetMeta, pBucket) =>
{
	if (!pFacetMeta || !pBucket)
	{
		return null;
	}
	let tmpFold = pFacetMeta.Fold || pFacetMeta.Kind;
	if (pFacetMeta.Tuple || (SELECTION_ONLY_FOLDS.indexOf(tmpFold) >= 0))
	{
		// A tuple count is not a count of route-entity rows; rollup / exists bands have no standard clause.
		return null;
	}
	if (libFacetUtil.isPlainObject(pFacetMeta.Dimension) && (SELECTION_ONLY_DIMENSIONS.indexOf(pFacetMeta.Dimension.Kind) >= 0))
	{
		return null;
	}
	if (hasDimensionPath(pFacetMeta))
	{
		return pathBucketClause(pFacetMeta, pBucket, tmpFold);
	}
	if ((typeof(pFacetMeta.Field) !== 'string') || (pFacetMeta.Field.length < 1))
	{
		return null;
	}
	let tmpField = pFacetMeta.Field;
	let tmpFilterKey = ((typeof(pFacetMeta.FilterKey) === 'string') && (pFacetMeta.FilterKey.length > 0)) ? pFacetMeta.FilterKey : tmpField;
	switch (tmpFold)
	{
		case 'Terms':
			if (!isPresent(pBucket.Key) || !isClauseSafeKey(pBucket.Key))
			{
				return null;
			}
			return (
				{
					Type: 'DistinctSelectedValueList',
					FilterByColumn: tmpField,
					Values: [ pBucket.Key ],
					FilterKey: tmpFilterKey,
					ClauseKey: 'DistinctSelectedValueList'
				});
		case 'DateHistogram':
			if (!isPresent(pBucket.Start) || !isPresent(pBucket.End))
			{
				return null;
			}
			return (
				{
					Type: 'DateRange',
					FilterByColumn: tmpField,
					Values: { Start: pBucket.Start, End: pBucket.End },
					EndExclusive: true,
					FilterKey: tmpFilterKey,
					ClauseKey: 'DateRange'
				});
		case 'NumericHistogram':
		case 'Ranges':
			{
				if (!isPresent(pBucket.Start) && !isPresent(pBucket.End))
				{
					return null;
				}
				let tmpValues = {};
				if (isPresent(pBucket.Start))
				{
					tmpValues.Start = pBucket.Start;
				}
				if (isPresent(pBucket.End))
				{
					tmpValues.End = pBucket.End;
				}
				return (
					{
						Type: 'NumericRange',
						FilterByColumn: tmpField,
						Values: tmpValues,
						EndExclusive: (pBucket.EndExclusive !== false),
						FilterKey: tmpFilterKey,
						ClauseKey: 'NumericRange'
					});
			}
		default:
			return null;
	}
};

// ---------------------------------------------------------------- Selection (internal-contracts §10.8)

/**
 * The dimension a bucketed Agg measures.
 *
 * @param {Record<string, any>} pAgg
 * @return {Record<string, any>|null}
 */
const primaryDimension = (pAgg) =>
{
	return (pAgg && Array.isArray(pAgg.Dimensions) && pAgg.Dimensions.length > 0) ? pAgg.Dimensions[0] : null;
};

/**
 * The key DataType of an Agg's first dimension.
 *
 * @param {Record<string, any>} pAgg
 * @return {string|null}
 */
const dimensionDataType = (pAgg) =>
{
	let tmpDimension = primaryDimension(pAgg);
	if (tmpDimension && (typeof(tmpDimension.DataType) === 'string'))
	{
		return tmpDimension.DataType;
	}
	if (pAgg && pAgg.FieldInfo && (typeof(pAgg.FieldInfo.DataType) === 'string'))
	{
		return pAgg.FieldInfo.DataType;
	}
	return (pAgg && (typeof(pAgg.DataType) === 'string')) ? pAgg.DataType : null;
};

/**
 * Union of key lists (by compareKeys equality).
 *
 * @param {Array<any>} pA
 * @param {Array<any>} pB
 * @return {Array<any>}
 */
const unionKeys = (pA, pB) =>
{
	let tmpResult = pA.slice();
	for (let i = 0; i < pB.length; i++)
	{
		if (!tmpResult.some((pKey) => { return libFacetBuckets.compareKeys(pKey, pB[i]) === 0; }))
		{
			tmpResult.push(pB[i]);
		}
	}
	return tmpResult;
};

/**
 * Intersection of key lists (by compareKeys equality).
 *
 * @param {Array<any>} pA
 * @param {Array<any>} pB
 * @return {Array<any>}
 */
const intersectKeys = (pA, pB) =>
{
	return pA.filter((pKey) => { return pB.some((pOther) => { return libFacetBuckets.compareKeys(pKey, pOther) === 0; }); });
};

/**
 * The field an owned existence node constrains for this facet, or null when the node is not a
 * selection of the facet (internal-contracts §29.4): for a path facet, an Exists over the facet's
 * own path (same signature, no Correlate, no From, no step Where) constrains the facet's field; for
 * a pivot-column FK facet (L3), an Exists over the single step '>Pivot.Field' constrains that
 * step's target key column.
 *
 * @param {Record<string, any>} pAgg
 * @return {(function(Record<string, any>): (string|null))|null}
 */
const existsMatcher = (pAgg) =>
{
	let tmpDimension = primaryDimension(pAgg) || {};
	let tmpPathSignature = pathSignatureOf(pAgg.Path) || pathSignatureOf(tmpDimension.Path);
	let fPlain = (pBody) =>
	{
		if (!libFacetUtil.isPlainObject(pBody) || isPresent(pBody.From) || (Array.isArray(pBody.Correlate) && (pBody.Correlate.length > 0)))
		{
			return false;
		}
		let tmpSteps = (libFacetUtil.isPlainObject(pBody.Path) && Array.isArray(pBody.Path.Steps)) ? pBody.Path.Steps : [];
		return !tmpSteps.some((pStep) => { return pStep && isPresent(pStep.Where); });
	};
	if (tmpPathSignature)
	{
		let tmpField = tmpDimension.KeyField || tmpDimension.Field || pAgg.Field || null;
		if (!tmpField)
		{
			return null;
		}
		return (pBody) =>
		{
			return (fPlain(pBody) && (pathSignatureOf(pBody.Path) === tmpPathSignature)) ? tmpField : null;
		};
	}
	let tmpField = tmpDimension.Field || pAgg.Field || null;
	if (!tmpField || (typeof(pAgg.Pivot) !== 'string'))
	{
		return null;
	}
	let tmpStepText = `>${pAgg.Pivot}.${tmpField}`;
	return (pBody) =>
	{
		if (!fPlain(pBody) || (pathSignatureOf(pBody.Path) !== tmpStepText))
		{
			return null;
		}
		let tmpSteps = pathStepsOf(pBody.Path, null);
		if (tmpSteps && (tmpSteps.length === 1) && tmpSteps[0].ToColumn)
		{
			return tmpSteps[0].ToColumn;
		}
		// A step written as a string carries no On pair: the FK label lookup knows the target key.
		if (libFacetUtil.isPlainObject(pAgg.LabelLookup) && (typeof(pAgg.LabelLookup.KeyColumn) === 'string'))
		{
			return pAgg.LabelLookup.KeyColumn;
		}
		return tmpField;
	};
};

/**
 * The non-null keys a predicate selects on pField, or null when it does not constrain pField in
 * a way a key list expresses (other fields, LK/NE/range operators, an Or that reaches another field).
 * An Exists node constrains the field fExists names for it (a selection of the facet through its
 * own path), else nothing.
 *
 * @param {Record<string, any>} pPred
 * @param {string|null} pField - null: plain leaves never match (path facets)
 * @param {string|null} pDataType
 * @param {(function(Record<string, any>): (string|null))|null} [fExists]
 * @return {Array<any>|null}
 */
const keysOf = (pPred, pField, pDataType, fExists) =>
{
	if (!pPred || (typeof(pPred) !== 'object'))
	{
		return null;
	}
	if (libFacetUtil.isPlainObject(pPred.Exists))
	{
		let tmpInnerField = (typeof(fExists) === 'function') ? fExists(pPred.Exists) : null;
		return tmpInnerField ? keysOf(pPred.Exists.Where, tmpInnerField, pDataType, null) : null;
	}
	if (Array.isArray(pPred.Or))
	{
		let tmpUnion = [];
		for (let i = 0; i < pPred.Or.length; i++)
		{
			let tmpKeys = keysOf(pPred.Or[i], pField, pDataType, fExists);
			if (tmpKeys === null)
			{
				return null;
			}
			tmpUnion = unionKeys(tmpUnion, tmpKeys);
		}
		return tmpUnion;
	}
	if (Array.isArray(pPred.And))
	{
		let tmpIntersection = null;
		for (let i = 0; i < pPred.And.length; i++)
		{
			let tmpKeys = keysOf(pPred.And[i], pField, pDataType, fExists);
			if (tmpKeys !== null)
			{
				tmpIntersection = (tmpIntersection === null) ? tmpKeys : intersectKeys(tmpIntersection, tmpKeys);
			}
		}
		return tmpIntersection;
	}
	if ((typeof(pField) !== 'string') || (pPred.Field !== pField) || isPresent(pPred.Alias))
	{
		return null;
	}
	switch (pPred.Op)
	{
		case 'EQ':
			return isPresent(pPred.Value) ? [ libFacetBuckets.normalizeKey(pPred.Value, pDataType) ] : [];
		case 'IN':
			return Array.isArray(pPred.Value) ? unionKeys([], pPred.Value.filter(isPresent).map((pValue) => { return libFacetBuckets.normalizeKey(pValue, pDataType); })) : null;
		case 'NULL':
			// Selects only missing rows: no non-null key.
			return [];
		default:
			return null;
	}
};

/**
 * Integer columns: turn an exclusive integer Lo into an inclusive Lo+1 and an inclusive integer Hi
 * into an exclusive Hi+1, so [10, 20) and [10, 19] compare equal.
 *
 * @param {Record<string, any>} pInterval
 * @param {boolean} pIsInteger
 * @return {Record<string, any>}
 */
const normalizeInterval = (pInterval, pIsInteger) =>
{
	if (!pIsInteger)
	{
		return pInterval;
	}
	let tmpInterval = Object.assign({}, pInterval);
	if ((typeof(tmpInterval.Lo) === 'number') && Number.isInteger(tmpInterval.Lo) && !tmpInterval.LoInclusive)
	{
		tmpInterval.Lo = tmpInterval.Lo + 1;
		tmpInterval.LoInclusive = true;
	}
	if ((typeof(tmpInterval.Hi) === 'number') && Number.isInteger(tmpInterval.Hi) && tmpInterval.HiInclusive)
	{
		tmpInterval.Hi = tmpInterval.Hi + 1;
		tmpInterval.HiInclusive = false;
	}
	return tmpInterval;
};

/**
 * Intersect two interval lists (each a union of intervals).
 *
 * @param {Array<Record<string, any>>} pA
 * @param {Array<Record<string, any>>} pB
 * @return {Array<Record<string, any>>}
 */
const intersectIntervals = (pA, pB) =>
{
	let tmpResult = [];
	for (let i = 0; i < pA.length; i++)
	{
		for (let j = 0; j < pB.length; j++)
		{
			let tmpA = pA[i];
			let tmpB = pB[j];
			let tmpInterval = { Lo: null, LoInclusive: false, Hi: null, HiInclusive: false };
			if ((tmpA.Lo === null) || ((tmpB.Lo !== null) && (tmpB.Lo > tmpA.Lo)))
			{
				tmpInterval.Lo = tmpB.Lo;
				tmpInterval.LoInclusive = tmpB.LoInclusive;
			}
			else if ((tmpB.Lo === null) || (tmpA.Lo > tmpB.Lo))
			{
				tmpInterval.Lo = tmpA.Lo;
				tmpInterval.LoInclusive = tmpA.LoInclusive;
			}
			else
			{
				tmpInterval.Lo = tmpA.Lo;
				tmpInterval.LoInclusive = tmpA.LoInclusive && tmpB.LoInclusive;
			}
			if ((tmpA.Hi === null) || ((tmpB.Hi !== null) && (tmpB.Hi < tmpA.Hi)))
			{
				tmpInterval.Hi = tmpB.Hi;
				tmpInterval.HiInclusive = tmpB.HiInclusive;
			}
			else if ((tmpB.Hi === null) || (tmpA.Hi < tmpB.Hi))
			{
				tmpInterval.Hi = tmpA.Hi;
				tmpInterval.HiInclusive = tmpA.HiInclusive;
			}
			else
			{
				tmpInterval.Hi = tmpA.Hi;
				tmpInterval.HiInclusive = tmpA.HiInclusive && tmpB.HiInclusive;
			}
			let tmpEmpty = (tmpInterval.Lo !== null) && (tmpInterval.Hi !== null)
				&& ((tmpInterval.Lo > tmpInterval.Hi) || ((tmpInterval.Lo === tmpInterval.Hi) && !(tmpInterval.LoInclusive && tmpInterval.HiInclusive)));
			if (!tmpEmpty)
			{
				tmpResult.push(tmpInterval);
			}
		}
	}
	return tmpResult;
};

/**
 * The intervals (a union) a predicate selects on pField, or null when it does not constrain pField
 * in a way intervals express.
 *
 * @param {Record<string, any>} pPred
 * @param {string} pField
 * @param {function(any): (string|number|null)} fValue - value parser (canonical date / number)
 * @param {boolean} pIsInteger
 * @param {(function(Record<string, any>): (string|null))|null} [fExists] - as for keysOf
 * @return {Array<Record<string, any>>|null}
 */
const intervalsOf = (pPred, pField, fValue, pIsInteger, fExists) =>
{
	if (!pPred || (typeof(pPred) !== 'object'))
	{
		return null;
	}
	if (libFacetUtil.isPlainObject(pPred.Exists))
	{
		let tmpInnerField = (typeof(fExists) === 'function') ? fExists(pPred.Exists) : null;
		return tmpInnerField ? intervalsOf(pPred.Exists.Where, tmpInnerField, fValue, pIsInteger, null) : null;
	}
	if (Array.isArray(pPred.Or))
	{
		let tmpUnion = [];
		for (let i = 0; i < pPred.Or.length; i++)
		{
			let tmpIntervals = intervalsOf(pPred.Or[i], pField, fValue, pIsInteger, fExists);
			if (tmpIntervals === null)
			{
				return null;
			}
			tmpUnion = tmpUnion.concat(tmpIntervals);
		}
		return tmpUnion;
	}
	if (Array.isArray(pPred.And))
	{
		let tmpIntersection = null;
		for (let i = 0; i < pPred.And.length; i++)
		{
			let tmpIntervals = intervalsOf(pPred.And[i], pField, fValue, pIsInteger, fExists);
			if (tmpIntervals !== null)
			{
				tmpIntersection = (tmpIntersection === null) ? tmpIntervals : intersectIntervals(tmpIntersection, tmpIntervals);
			}
		}
		return tmpIntersection;
	}
	if ((typeof(pField) !== 'string') || (pPred.Field !== pField) || isPresent(pPred.Alias))
	{
		return null;
	}
	if (pPred.Op === 'NULL')
	{
		return [];
	}
	let tmpValues = (pPred.Op === 'IN') ? (Array.isArray(pPred.Value) ? pPred.Value : null) : [ pPred.Value ];
	if (tmpValues === null)
	{
		return null;
	}
	let tmpParsed = [];
	for (let i = 0; i < tmpValues.length; i++)
	{
		let tmpValue = fValue(tmpValues[i]);
		if (tmpValue === null)
		{
			return null;
		}
		tmpParsed.push(tmpValue);
	}
	let tmpIntervals = [];
	switch (pPred.Op)
	{
		case 'GE':
		case 'GT':
			tmpIntervals.push({ Lo: tmpParsed[0], LoInclusive: (pPred.Op === 'GE'), Hi: null, HiInclusive: false });
			break;
		case 'LE':
		case 'LT':
			tmpIntervals.push({ Lo: null, LoInclusive: false, Hi: tmpParsed[0], HiInclusive: (pPred.Op === 'LE') });
			break;
		case 'EQ':
		case 'IN':
			for (let i = 0; i < tmpParsed.length; i++)
			{
				tmpIntervals.push({ Lo: tmpParsed[i], LoInclusive: true, Hi: tmpParsed[i], HiInclusive: true });
			}
			break;
		default:
			return null;
	}
	return tmpIntervals.map((pInterval) => { return normalizeInterval(pInterval, pIsInteger); });
};

/**
 * A finite number from a clause value, or null.
 *
 * @param {any} pValue
 * @return {number|null}
 */
const toNumber = (pValue) =>
{
	if ((pValue === null) || (typeof(pValue) === 'undefined') || (typeof(pValue) === 'boolean') || ((typeof(pValue) === 'string') && (pValue.trim().length === 0)))
	{
		return null;
	}
	let tmpNumber = (typeof(pValue) === 'number') ? pValue : Number(pValue);
	return Number.isFinite(tmpNumber) ? tmpNumber : null;
};

/**
 * What the facet's own (owned) conjuncts select (internal-contracts §10.8).  NeverExclude conjuncts
 * (RawFilter) are not selections and are skipped; conjuncts are ANDed (key sets intersect).
 *
 *   Terms:        { Keys: [ … ] }   normalized keys from owned IN / EQ / Or-of-EQ predicates on the field
 *   Range folds:  { Range: { Lo, LoInclusive, Hi, HiInclusive } }   from owned GE/GT + LE/LT (and EQ/IN) on the field;
 *                 Ranges holds the full union when an Or selects several spans (Range is then null)
 *   Nothing owned (or nothing expressible) → { Keys: [], Range: null, Ranges: [] }
 *
 * M2 (§29.4): an owned join conjunct selects too — an Exists over the facet's own path (K8 / K9)
 * whose Where constrains the facet's field, or for a pivot-column FK facet the L3 form
 * Exists(>Pivot.Field, Where on the target key).  TuplePivot, ChildRollup and ExistsSplit facets
 * select nothing.
 *
 * @param {{ Kind: string, Field: string, Dimensions: Array<Record<string, any>>, Path?: any, Pivot?: string, Tuple?: any, LabelLookup?: Record<string, any> }} pAgg
 * @param {Array<Record<string, any>>} pOwnedConjuncts - FilterAST conjuncts (internal-contracts §4.2)
 * @return {{ Keys: Array<any>, Range: Record<string, any>|null, Ranges: Array<Record<string, any>>, Constrained: boolean }}
 */
const selectedFrom = (pAgg, pOwnedConjuncts) =>
{
	let tmpResult = { Keys: [], Range: null, Ranges: [], Constrained: false };
	if (!pAgg)
	{
		return tmpResult;
	}
	let tmpDimension = primaryDimension(pAgg);
	let tmpField = (tmpDimension && (tmpDimension.Field || tmpDimension.KeyField)) || pAgg.Field;
	let tmpKind = pAgg.Kind || pAgg.Fold;
	if (!tmpField || pAgg.Tuple || ((tmpKind !== 'Terms') && (RANGE_FOLDS.indexOf(tmpKind) < 0)))
	{
		// TuplePivot, ChildRollup and ExistsSplit facets select nothing in M2 (internal-contracts §29.4).
		return tmpResult;
	}
	// A path facet's field lives on the path's last entity: only an owned Exists over the facet's
	// own path selects (§29.4); a pivot-column facet also reads the L3 form of an FK facet.
	let tmpLeafField = (pathSignatureOf(pAgg.Path) || (tmpDimension && pathSignatureOf(tmpDimension.Path))) ? null : tmpField;
	let fExists = existsMatcher(pAgg);
	let tmpConjuncts = (Array.isArray(pOwnedConjuncts) ? pOwnedConjuncts : []).filter(
		(pConjunct) => { return pConjunct && pConjunct.Pred && (pConjunct.NeverExclude !== true); });

	if (tmpKind === 'Terms')
	{
		let tmpDataType = dimensionDataType(pAgg);
		let tmpKeys = null;
		for (let i = 0; i < tmpConjuncts.length; i++)
		{
			let tmpConjunctKeys = keysOf(tmpConjuncts[i].Pred, tmpLeafField, tmpDataType, fExists);
			if (tmpConjunctKeys !== null)
			{
				tmpKeys = (tmpKeys === null) ? tmpConjunctKeys : intersectKeys(tmpKeys, tmpConjunctKeys);
			}
		}
		if (tmpKeys !== null)
		{
			tmpResult.Constrained = true;
			tmpResult.Keys = tmpKeys.slice().sort(libFacetBuckets.compareKeys);
		}
		return tmpResult;
	}

	let tmpIsDate = (tmpKind === 'DateHistogram') || (tmpDimension && (tmpDimension.Kind === 'DateBucket'));
	let fValue = tmpIsDate ? libFacetBuckets.canonicalDateTime : toNumber;
	let tmpIsInteger = !tmpIsDate && !!(tmpDimension && tmpDimension.IsInteger);
	let tmpIntervals = null;
	for (let i = 0; i < tmpConjuncts.length; i++)
	{
		let tmpConjunctIntervals = intervalsOf(tmpConjuncts[i].Pred, tmpLeafField, fValue, tmpIsInteger, fExists);
		if (tmpConjunctIntervals !== null)
		{
			tmpIntervals = (tmpIntervals === null) ? tmpConjunctIntervals : intersectIntervals(tmpIntervals, tmpConjunctIntervals);
		}
	}
	if (tmpIntervals !== null)
	{
		tmpResult.Constrained = true;
		tmpResult.Ranges = tmpIntervals;
		tmpResult.Range = (tmpIntervals.length === 1) ? tmpIntervals[0] : null;
	}
	return tmpResult;
};

/**
 * Does the range bucket [Start, End) (or [Start, End] when EndExclusive is false) lie inside the interval?
 *
 * @param {Record<string, any>} pInterval
 * @param {Record<string, any>} pBucket
 * @return {boolean}
 */
const bucketInsideInterval = (pInterval, pBucket) =>
{
	let tmpHasStart = isPresent(pBucket.Start);
	let tmpHasEnd = isPresent(pBucket.End);
	if (pInterval.Lo !== null)
	{
		if (!tmpHasStart)
		{
			return false;
		}
		if (pInterval.LoInclusive ? (pBucket.Start < pInterval.Lo) : (pBucket.Start <= pInterval.Lo))
		{
			return false;
		}
	}
	if (pInterval.Hi !== null)
	{
		if (!tmpHasEnd)
		{
			return false;
		}
		if ((pBucket.EndExclusive !== false) || pInterval.HiInclusive)
		{
			return pBucket.End <= pInterval.Hi;
		}
		return pBucket.End < pInterval.Hi;
	}
	return true;
};

/**
 * Is this bucket selected by the facet's own clause?  Terms: its Key is a selected key.  Range
 * folds: [Start, End) lies inside one of the selected intervals.
 *
 * @param {{ Kind: string, Dimensions: Array<Record<string, any>> }} pAgg
 * @param {{ Keys: Array<any>, Ranges: Array<Record<string, any>>, Constrained: boolean }} pSelected - from selectedFrom
 * @param {Record<string, any>} pBucket
 * @return {boolean}
 */
const bucketSelected = (pAgg, pSelected, pBucket) =>
{
	if (!pAgg || !pSelected || !pSelected.Constrained || !pBucket)
	{
		return false;
	}
	let tmpKind = pAgg.Kind || pAgg.Fold;
	if (tmpKind === 'Terms')
	{
		return pSelected.Keys.some((pKey) => { return libFacetBuckets.compareKeys(pKey, pBucket.Key) === 0; });
	}
	if (RANGE_FOLDS.indexOf(tmpKind) < 0)
	{
		return false;
	}
	let tmpDimension = primaryDimension(pAgg);
	let tmpBucket = pBucket;
	if (tmpDimension && tmpDimension.IsInteger && (pBucket.EndExclusive === false) && (typeof(pBucket.End) === 'number') && Number.isInteger(pBucket.End))
	{
		// A closed integer bucket [a, b] is the half-open [a, b + 1).
		tmpBucket = Object.assign({}, pBucket, { End: pBucket.End + 1, EndExclusive: true });
	}
	let tmpRanges = Array.isArray(pSelected.Ranges) ? pSelected.Ranges : (pSelected.Range ? [ pSelected.Range ] : []);
	return tmpRanges.some((pInterval) => { return bucketInsideInterval(pInterval, tmpBucket); });
};

module.exports = (
	{
		TILDE_PATTERN: TILDE_PATTERN,
		canonicalJSON: canonicalJSON,
		shortHash: shortHash,
		isClauseSafeKey: isClauseSafeKey,
		clauseSignature: clauseSignature,
		clauseHash: clauseHash,
		ownership: ownership,
		isMixed: isMixed,
		exclusionFor: exclusionFor,
		bucketClause: bucketClause,
		selectedFrom: selectedFrom,
		bucketSelected: bucketSelected,
		// M2 (internal-contracts §29.3, §29.4)
		SELECTION_ONLY_FOLDS: SELECTION_ONLY_FOLDS,
		pathSignatureOf: pathSignatureOf,
		pathStepsOf: pathStepsOf,
		pathRestricted: pathRestricted
	});
