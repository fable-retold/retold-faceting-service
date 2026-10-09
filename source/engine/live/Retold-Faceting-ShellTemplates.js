/**
 * Retold Faceting - Shell Templates registry
 *
 * The only hand-written SQL (03 §3.4).  Loads the per-dialect shell modules, scans every
 * template for '<%' tags outside the allowed slots (_Params.SR<n>, _Params.D<n>, _Params.JOINS,
 * _Params.WHERE, _Params.P<n>) and any '<% %>' code block, and renders the shell for an Agg.
 * Shells never bind JS arrays; values are scalar 'f*' parameters only.
 *
 * render() returns everything EngineLive splices into the pivot query: the template text, the
 * structural slot text (D0/D1 dimension expressions built only from catalog identifiers quoted per
 * dialect, plus any SR/JOINS/WHERE slots passed in), the scalar bound values and, for MSSQL, their
 * parameterTypes.
 *
 * Every grouped shell returns a BOUNDED number of rows to Node (a high-cardinality column can never
 * be pulled whole onto the event loop, T7 / R-09):
 *   - Terms: the groups ranked within Top + 1 by count (ties at the cut included, the canonical
 *     tie-break happens in JS), capped at max(Top + 1, Limits.MaxTermsGroups) rows in SQL key order,
 *     plus the selected keys (bound one scalar each, fS<n>, through the P0 slot);
 *   - DateHistogram: at most Limits.MaxDateBuckets + 2 key rows (more is FACET_INTERVAL_TOO_FINE
 *     whatever the rest holds);
 *   - Pivot: at most Limits.CubeMaxGroups + 1 cells (more is 422 FACET_TOO_LARGE);
 *   - NumericHistogram / Ranges are bounded by their geometry (≤ MaxBuckets + 2).
 *
 * Contract: internal-contracts §7.4.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');
const libFoxHound = require('foxhound');

const libOptions = require('../../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../../contract/Facet-Contract-Errors.js');
const libFacetRequest = require('../../contract/Facet-Contract-Request.js');
const libFacetBuckets = require('../../contract/Facet-Contract-Buckets.js');
const libRetoldFacetingUtil = require('../../Retold-Faceting-Util.js');
// Static dialect data only (quote characters); the Dialects SERVICE is never constructed here.
const libDialectsStatic = require('./Retold-Faceting-Dialects.js');

const hasOwn = libRetoldFacetingUtil.hasOwn;

const libShellTemplatesSQLite = require('./Shell-Templates-SQLite.js');
const libShellTemplatesPostgreSQL = require('./Shell-Templates-PostgreSQL.js');
const libShellTemplatesMySQL = require('./Shell-Templates-MySQL.js');
const libShellTemplatesMSSQL = require('./Shell-Templates-MSSQL.js');

// Template tags a shell may contain (L5).
const ALLOWED_SLOT_PATTERN = /^<%=\s*_Params\.(SR[0-9]+[a-z]?|D[0-9]+|P[0-9]+|JOINS|WHERE|AND_WHERE)\s*%>$/;

// Structural slots a caller may pass through render() (everything else in pSlots is an option).
const PASS_THROUGH_SLOT_PATTERN = /^(SR[0-9]+[a-z]?|P[0-9]+|JOINS|WHERE|AND_WHERE)$/;

// Every dialect module must provide these (internal-contracts §15.1; the M2 block §26.4).
const M1_TEMPLATES = Object.freeze([ 'Count', 'Terms', 'DateHistogram', 'NumericBounds', 'NumericHistogram', 'Ranges', 'Stats', 'DistinctCount', 'Missing', 'Pivot' ]);

const M2_TEMPLATES = Object.freeze([ 'KeyGroups', 'MultiTerms', 'MultiCovered', 'Cube', 'RecordKeys', 'Keys', 'StagedKeys' ]);

const REQUIRED_TEMPLATES = Object.freeze(M1_TEMPLATES.concat(M2_TEMPLATES));

const REQUIRED_EXPRESSIONS = Object.freeze(
	[
		'dateKey', 'numericIndex', 'dateCanonical', 'dateValue', 'dateBucket', 'numericValue', 'valueKey', 'sumUnits', 'edgesIndex', 'rangeIndex',
		// M2
		'bandIndex', 'dateBound', 'stagedBindNames', 'stagedBindValues', 'stagedMembership'
	]);

const INTERVALS = libFacetRequest.INTERVALS;

// Agg Kind → template (NumericHistogram's first pass is the explicit 'NumericBounds' shell).
const SHELL_FOR_KIND = Object.freeze(
	{
		Count: 'Count',
		Terms: 'Terms',
		DateHistogram: 'DateHistogram',
		NumericHistogram: 'NumericHistogram',
		Ranges: 'Ranges',
		Stats: 'Stats',
		DistinctCount: 'DistinctCount',
		Missing: 'Missing',
		Pivot: 'Pivot',
		// M2: per-row keys grouped (band index / exists flag)
		ChildRollup: 'KeyGroups',
		ExistsSplit: 'KeyGroups'
	});

// The fallback row bound of a Terms statement when Limits.MaxTermsGroups is not configured.
const DEFAULT_MAX_TERMS_GROUPS = 10000;

// MSSQL parameter types of the shell binds (by name; prefixed pivot names end the same way).
const MSSQL_BIND_TYPES = (
	[
		[ /TopPlusOne$/, 'Int' ],
		[ /MaxGroups$/, 'Int' ],
		[ /LastIndex$/, 'Int' ],
		[ /(Factor|LoUnits|WidthUnits)$/, 'BigInt' ],
		[ /(Cap|Begin|CapPlusOne)$/, 'Int' ],
		[ /(E[0-9]+|R[0-9]+From|R[0-9]+To)$/, 'Float' ]
	]);

const DATE_TYPES = libFacetBuckets.DATE_TYPES;

// A minimal Agg per template for the dry-build (identifiers are syntactically valid placeholders).
const DRY_BUILD_AGGS = Object.freeze(
	{
		Count: { Agg: { Kind: 'Count', Dimensions: [] }, Slots: {} },
		Terms: { Agg: { Kind: 'Terms', Top: 20, Order: 'CountDesc', SelectedKeys: [ 'DryKey' ], Dimensions: [ { Kind: 'Column', Field: 'DryColumn', DataType: 'String' } ] }, Slots: {} },
		DateHistogram: { Agg: { Kind: 'DateHistogram', Dimensions: [ { Kind: 'DateBucket', Field: 'DryDate', Interval: 'month' } ] }, Slots: {} },
		NumericBounds: { Agg: { Kind: 'NumericHistogram', Dimensions: [ { Kind: 'NumericBucket', Field: 'DryNumber', Mode: 'Nice', Buckets: 10, Scale: 2 } ] }, Slots: { Shell: 'NumericBounds' } },
		NumericHistogram: { Agg: { Kind: 'NumericHistogram', Dimensions: [ { Kind: 'NumericBucket', Field: 'DryNumber', Mode: 'Nice', Buckets: 10, Scale: 2 } ] }, Slots: { Geometry: { Mode: 'Nice', Factor: 100, LoUnits: 0, WidthUnits: 100, N: 10 } } },
		Ranges: { Agg: { Kind: 'Ranges', Dimensions: [ { Kind: 'Range', Field: 'DryNumber', Ranges: [ { Key: 'low', From: null, To: 3 }, { Key: 'high', From: 3, To: null } ] } ] }, Slots: {} },
		Stats: { Agg: { Kind: 'Stats', Field: 'DryNumber', FieldInfo: { DataType: 'Decimal', Scale: 2 }, Dimensions: [] }, Slots: {} },
		DistinctCount: { Agg: { Kind: 'DistinctCount', Field: 'DryColumn', FieldInfo: { DataType: 'String', Scale: 0 }, Dimensions: [] }, Slots: {} },
		Missing: { Agg: { Kind: 'Missing', Field: 'DryColumn', FieldInfo: { DataType: 'String', Scale: 0 }, Dimensions: [] }, Slots: {} },
		Pivot: { Agg: { Kind: 'Pivot', Dimensions: [ { Kind: 'Column', Field: 'DryColumn', DataType: 'String' }, { Kind: 'DateBucket', Field: 'DryDate', Interval: 'quarter' } ] }, Slots: {} },
		// M2
		KeyGroups: { Agg: { Kind: 'ChildRollup', Dimensions: [ { Kind: 'ChildAgg', Field: 'DryNumber', Edges: [ 1, 3, 10 ] } ] }, Slots: {} },
		MultiTerms: { Agg: { Kind: 'Terms', Top: 20, SelectedKeys: [ 7 ], Dimensions: [ { Kind: 'Multi', KeyField: 'DryKey', DataType: 'Numeric', Chain: [ { Rel: { As: 'm1' } } ] } ] }, Slots: { Shell: 'MultiTerms', PrimaryKey: 'DryColumn', JOINS: '', AND_WHERE: '' } },
		MultiCovered: { Agg: { Kind: 'Terms', Dimensions: [ { Kind: 'Multi', KeyField: 'DryKey', DataType: 'String', Chain: [ { Rel: { As: 'm1' } } ] } ] }, Slots: { Shell: 'MultiCovered', PrimaryKey: 'DryColumn', JOINS: '', AND_WHERE: '' } },
		Cube: { Agg: { Kind: 'Count', Dimensions: [] }, Slots: { Shell: 'Cube', Cube: { Dims: [ { Column: 'd1', Dim: { Kind: 'Column', Field: 'DryColumn', DataType: 'String' } }, { Column: 'd2', Dim: { Kind: 'DateBucket', Field: 'DryDate', Interval: 'month' } } ], Flags: [ 'b1' ], Bounds: [ { Lo: 'lo2', Hi: 'hi2', Dim: 'd2' } ] } } },
		RecordKeys: { Agg: { Kind: 'Count', Dimensions: [] }, Slots: { Shell: 'RecordKeys', PrimaryKey: 'DryColumn', Sort: [ { Field: 'DryDate', Dir: 'DESC' } ], Cap: 50, Begin: 0 } },
		Keys: { Agg: { Kind: 'Count', Dimensions: [] }, Slots: { Shell: 'Keys', PrimaryKey: 'DryColumn', Cap: 100 } },
		StagedKeys: { Agg: { Kind: 'Count', Dimensions: [] }, Slots: { Shell: 'StagedKeys', KeyColumns: [ 'DryColumn', 'DryKey' ], Cap: 50000 } }
	});

/**
 * Is this a bindable scalar (finite number, string, or null)?
 *
 * @param {any} pValue
 * @return {boolean}
 */
const isBindableScalar = (pValue) =>
{
	if (pValue === null)
	{
		return true;
	}
	if (typeof(pValue) === 'string')
	{
		return true;
	}
	return (typeof(pValue) === 'number') && Number.isFinite(pValue);
};

class RetoldFacetingShellTemplates extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingShellTemplates';

		// Dialect name → shell module { Dialect, Templates, Expressions }
		this._Dialects = {};
		this._Dialects[libShellTemplatesSQLite.Dialect] = libShellTemplatesSQLite;
		this._Dialects[libShellTemplatesPostgreSQL.Dialect] = libShellTemplatesPostgreSQL;
		this._Dialects[libShellTemplatesMySQL.Dialect] = libShellTemplatesMySQL;
		this._Dialects[libShellTemplatesMSSQL.Dialect] = libShellTemplatesMSSQL;
	}

	/**
	 * The shell module for a dialect.
	 *
	 * @param {string} pDialectName
	 * @return {{ Dialect: string, Templates: Record<string, string>, Expressions: Record<string, Function> }|null}
	 */
	dialect(pDialectName)
	{
		return hasOwn(this._Dialects, pDialectName) ? this._Dialects[pDialectName] : null;
	}

	/**
	 * Quote an identifier for a dialect (catalog identifiers only; throws on anything else).
	 *
	 * @param {string} pDialectName
	 * @param {string} pIdentifier
	 * @return {string}
	 */
	quote(pDialectName, pIdentifier)
	{
		let tmpProfile = libDialectsStatic.DIALECT_PROFILES[pDialectName];
		if (!tmpProfile)
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'Unknown SQL dialect.');
		}
		if ((typeof(pIdentifier) !== 'string') || !libDialectsStatic.IDENTIFIER_PATTERN.test(pIdentifier))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'Refusing to quote an invalid identifier.');
		}
		return `${tmpProfile.QuoteOpen}${pIdentifier}${tmpProfile.QuoteClose}`;
	}

	/**
	 * An alias-qualified, quoted column reference.
	 *
	 * @param {string} pDialectName
	 * @param {string} pAlias
	 * @param {string} pColumn
	 * @return {string}
	 */
	qualify(pDialectName, pAlias, pColumn)
	{
		return `${this.quote(pDialectName, pAlias)}.${this.quote(pDialectName, pColumn)}`;
	}

	/**
	 * Render the shell for an Agg.
	 *
	 * pSlots carries render options and pass-through structural slots:
	 *   - Shell: an explicit template name (e.g. 'NumericBounds'); default from pAgg.Kind
	 *   - Geometry: the numeric geometry for the NumericHistogram bucket pass
	 *       Nice  { Mode: 'Nice', Factor, LoUnits, WidthUnits, N }
	 *       Edges { Mode: 'Edges', Edges: [ … ], OpenEnded }
	 *   - Alias: the pivot alias (default 'p'; the templates are written for 'p')
	 *   - SR<n>, JOINS, WHERE, AND_WHERE, P<n>: structural text, passed through into Slots
	 *
	 * @param {string} pDialectName
	 * @param {Record<string, any>} pAgg - internal-contracts §5.1
	 * @param {Record<string, any>} pSlots - structural slot text keyed by slot name (SR0, D0, WHERE, …)
	 * @return {{ Name: string, Template: string, Slots: Record<string, string>, Bound: Record<string, any>, ParamTypes: Record<string, string> }}
	 */
	render(pDialectName, pAgg, pSlots)
	{
		let tmpModule = this.dialect(pDialectName);
		if (!tmpModule)
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'Unknown SQL dialect for shell templates.');
		}
		if ((typeof(pAgg) !== 'object') || (pAgg === null))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'A shell needs an Agg.');
		}
		let tmpSlotsIn = ((typeof(pSlots) === 'object') && (pSlots !== null)) ? pSlots : {};
		let tmpName = (typeof(tmpSlotsIn.Shell) === 'string') ? tmpSlotsIn.Shell : SHELL_FOR_KIND[pAgg.Kind];
		if ((typeof(tmpName) !== 'string') || !hasOwn(tmpModule.Templates, tmpName))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'No shell template for this fold.');
		}
		let tmpAlias = (typeof(tmpSlotsIn.Alias) === 'string') ? tmpSlotsIn.Alias : 'p';
		let tmpExpressions = tmpModule.Expressions;

		let tmpResult = { Name: tmpName, Template: tmpModule.Templates[tmpName], Slots: {}, Bound: {}, ParamTypes: {} };

		let tmpSlotNames = Object.keys(tmpSlotsIn);
		for (let i = 0; i < tmpSlotNames.length; i++)
		{
			if (PASS_THROUGH_SLOT_PATTERN.test(tmpSlotNames[i]))
			{
				tmpResult.Slots[tmpSlotNames[i]] = String(tmpSlotsIn[tmpSlotNames[i]]);
			}
		}

		let tmpDimensions = Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions : [];
		let fColumn = (pField) =>
		{
			return this.qualify(pDialectName, tmpAlias, pField);
		};
		let fNumeric = (pField) =>
		{
			return fRequire(tmpExpressions.numericValue(fColumn(pField)));
		};
		let fDimension = (pIndex) =>
		{
			let tmpDimension = tmpDimensions[pIndex];
			if (!tmpDimension || (typeof(tmpDimension.Field) !== 'string'))
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'The fold is missing a dimension.');
			}
			return tmpDimension;
		};
		let fRequire = (pSQL) =>
		{
			if ((typeof(pSQL) !== 'string') || (pSQL.length < 1))
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'The dialect cannot express this dimension.');
			}
			return pSQL;
		};
		let fFieldInfo = () =>
		{
			return ((typeof(pAgg.FieldInfo) === 'object') && (pAgg.FieldInfo !== null)) ? pAgg.FieldInfo : {};
		};
		// A Terms / Pivot-Column key: numeric DataTypes through numericValue (a non-number is
		// Missing on every engine), everything else through the dialect's valueKey.
		let fValueKey = (pField, pDataType) =>
		{
			if (libFacetBuckets.isNumericType(pDataType))
			{
				return fNumeric(pField);
			}
			return fRequire(tmpExpressions.valueKey(fColumn(pField), pDataType));
		};
		let tmpLimits = (this.options && this.options.Limits) ? this.options.Limits : {};
		let fPositive = (pValue, pDefault) =>
		{
			return ((typeof(pValue) === 'number') && Number.isFinite(pValue) && (pValue >= 1)) ? Math.floor(pValue) : pDefault;
		};
		let fNonNegative = (pValue, pName) =>
		{
			if ((typeof(pValue) !== 'number') || !Number.isSafeInteger(pValue) || (pValue < 0))
			{
				throw libFacetErrors.create('FACET_INTERNAL', `The shell needs a non-negative integer ${pName}.`);
			}
			return pValue;
		};
		// Terms ranking binds (Terms and K9 MultiTerms): the kept set is always the top groups by
		// count (Order only re-sorts it for display, internal-contracts §10.4), so every Order ranks
		// by count; selected keys come back with their real counts even when they rank below Top:
		// one scalar bind per key (shells never bind arrays), OR-ed into the row filter.
		let fTermsRanking = () =>
		{
			let tmpTop = fPositive(pAgg.Top, fPositive(tmpLimits.DefaultTop, libFacetRequest.LIMIT_DEFAULTS.DefaultTop));
			tmpResult.Bound.fTopPlusOne = tmpTop + 1;
			tmpResult.Bound.fMaxGroups = Math.max(tmpTop + 1, fPositive(tmpLimits.MaxTermsGroups, DEFAULT_MAX_TERMS_GROUPS));
			let tmpSelected = (Array.isArray(pAgg.SelectedKeys) ? pAgg.SelectedKeys : []).filter(
				(pKey) => { return (typeof(pKey) === 'string') || ((typeof(pKey) === 'number') && Number.isFinite(pKey)); });
			let tmpSelectedNames = tmpSelected.map(
				(pKey, pIndex) =>
				{
					tmpResult.Bound[`fS${pIndex}`] = pKey;
					return `${tmpModule.Sigil}fS${pIndex}`;
				});
			tmpResult.Slots.P0 = (tmpSelectedNames.length > 0) ? ` OR ${this.qualify(pDialectName, 'r', 'Key')} IN (${tmpSelectedNames.join(', ')})` : '';
		};
		let fMeasureField = () =>
		{
			let tmpField = (typeof(pAgg.Field) === 'string') ? pAgg.Field : (tmpDimensions[0] ? tmpDimensions[0].Field : null);
			if (typeof(tmpField) !== 'string')
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'The fold is missing its field.');
			}
			return tmpField;
		};

		switch (tmpName)
		{
			case 'Count':
				break;

			case 'Terms':
				{
					let tmpDimension = fDimension(0);
					tmpResult.Slots.D0 = fValueKey(tmpDimension.Field, tmpDimension.DataType);
					fTermsRanking();
				}
				break;

			// M2 ----------------------------------------------------------------------------------

			case 'KeyGroups':
				tmpResult.Slots.D0 = this.dimensionExpression(pDialectName, fDimension(0), tmpAlias, 'f', tmpResult.Bound);
				break;

			case 'MultiTerms':
			case 'MultiCovered':
				{
					// K9 (internal-contracts §26.4): D0 = the key on the chain's last relation, D1 = the
					// pivot's primary key; JOINS / AND_WHERE are the chain (always set, '' when empty).
					let tmpDimension = Array.isArray(pAgg.Dimensions) ? pAgg.Dimensions[0] : null;
					if (!tmpDimension || (tmpDimension.Kind !== 'Multi') || (typeof(tmpDimension.KeyField) !== 'string'))
					{
						throw libFacetErrors.create('FACET_INTERNAL', 'A multi-valued fold needs its Multi dimension.');
					}
					let tmpChain = Array.isArray(tmpDimension.Chain) ? tmpDimension.Chain : [];
					let tmpKeyAlias = (typeof(tmpSlotsIn.KeyAlias) === 'string') ? tmpSlotsIn.KeyAlias
						: ((tmpChain.length > 0) && tmpChain[tmpChain.length - 1].Rel) ? tmpChain[tmpChain.length - 1].Rel.As
						: null;
					if ((typeof(tmpKeyAlias) !== 'string') || (typeof(tmpSlotsIn.PrimaryKey) !== 'string'))
					{
						throw libFacetErrors.create('FACET_INTERNAL', 'A multi-valued fold needs its key alias and the pivot key.');
					}
					let tmpKeyColumn = this.qualify(pDialectName, tmpKeyAlias, tmpDimension.KeyField);
					tmpResult.Slots.D0 = libFacetBuckets.isNumericType(tmpDimension.DataType)
						? fRequire(tmpExpressions.numericValue(tmpKeyColumn))
						: fRequire(tmpExpressions.valueKey(tmpKeyColumn, tmpDimension.DataType));
					tmpResult.Slots.D1 = this.qualify(pDialectName, tmpAlias, tmpSlotsIn.PrimaryKey);
					tmpResult.Slots.JOINS = hasOwn(tmpResult.Slots, 'JOINS') ? tmpResult.Slots.JOINS : '';
					tmpResult.Slots.AND_WHERE = hasOwn(tmpResult.Slots, 'AND_WHERE') ? tmpResult.Slots.AND_WHERE : '';
					if (tmpName === 'MultiTerms')
					{
						fTermsRanking();
					}
				}
				break;

			case 'Cube':
				this._renderCube(pDialectName, tmpExpressions, tmpSlotsIn.Cube, tmpAlias, tmpResult);
				tmpResult.Bound.fMaxGroups = fPositive(tmpSlotsIn.MaxGroups, fPositive(tmpLimits.CubeMaxGroups, 100000)) + 1;
				break;

			case 'RecordKeys':
				{
					let tmpPrimaryKey = this.qualify(pDialectName, tmpAlias, tmpSlotsIn.PrimaryKey);
					let tmpSort = Array.isArray(tmpSlotsIn.Sort) ? tmpSlotsIn.Sort : [];
					let tmpOrder = [];
					for (let i = 0; i < tmpSort.length; i++)
					{
						let tmpDirection = tmpSort[i] ? tmpSort[i].Dir : null;
						if ((tmpDirection !== 'ASC') && (tmpDirection !== 'DESC'))
						{
							throw libFacetErrors.create('FACET_INTERNAL', 'A records sort needs ASC or DESC.');
						}
						let tmpColumn = this.qualify(pDialectName, tmpAlias, tmpSort[i].Field);
						// NULLs last in both directions on every dialect (internal-contracts §26.5).
						tmpOrder.push(`CASE WHEN ${tmpColumn} IS NULL THEN 1 ELSE 0 END`);
						tmpOrder.push(`${tmpColumn} ${tmpDirection}`);
					}
					tmpOrder.push(`${tmpPrimaryKey} ASC`);
					tmpResult.Slots.D0 = tmpOrder.join(', ');
					tmpResult.Slots.D1 = tmpPrimaryKey;
					tmpResult.Bound.fCap = fNonNegative(tmpSlotsIn.Cap, 'Cap');
					tmpResult.Bound.fBegin = fNonNegative(tmpSlotsIn.Begin, 'Begin');
				}
				break;

			case 'Keys':
				tmpResult.Slots.D1 = this.qualify(pDialectName, tmpAlias, tmpSlotsIn.PrimaryKey);
				tmpResult.Bound.fCapPlusOne = fNonNegative(tmpSlotsIn.Cap, 'Cap') + 1;
				break;

			case 'StagedKeys':
				{
					let tmpKeyColumns = Array.isArray(tmpSlotsIn.KeyColumns) ? tmpSlotsIn.KeyColumns : [];
					if (tmpKeyColumns.length < 1)
					{
						throw libFacetErrors.create('FACET_INTERNAL', 'A staged key set needs its key columns.');
					}
					tmpResult.Slots.D0 = tmpKeyColumns.map((pColumn, pIndex) => { return `${this.qualify(pDialectName, tmpAlias, pColumn)} AS ${this.quote(pDialectName, `K${pIndex}`)}`; }).join(', ');
					tmpResult.Bound.fCapPlusOne = fNonNegative(tmpSlotsIn.Cap, 'Cap') + 1;
				}
				break;

			case 'DateHistogram':
				{
					let tmpDimension = fDimension(0);
					tmpResult.Slots.D1 = fRequire(tmpExpressions.dateValue(fColumn(tmpDimension.Field)));
					tmpResult.Slots.D0 = fRequire(tmpExpressions.dateBucket(this.qualify(pDialectName, 'v', 'Value'), tmpDimension.Interval));
					// One NULL-key row plus one key past the limit: anything more is TOO_FINE anyway.
					tmpResult.Bound.fMaxGroups = fPositive(tmpLimits.MaxDateBuckets, libFacetRequest.LIMIT_DEFAULTS.MaxDateBuckets) + 2;
				}
				break;

			case 'NumericBounds':
				tmpResult.Slots.D0 = fNumeric(fMeasureField());
				break;

			case 'NumericHistogram':
				{
					let tmpField = fMeasureField();
					let tmpGeometry = tmpSlotsIn.Geometry;
					if ((typeof(tmpGeometry) !== 'object') || (tmpGeometry === null))
					{
						throw libFacetErrors.create('FACET_INTERNAL', 'The numeric histogram needs its geometry.');
					}
					tmpResult.Slots.D1 = fNumeric(tmpField);
					if (tmpGeometry.Mode === 'Edges')
					{
						let tmpEdges = Array.isArray(tmpGeometry.Edges) ? tmpGeometry.Edges : [];
						let tmpNames = [];
						for (let i = 0; i < tmpEdges.length; i++)
						{
							tmpNames.push(`fE${i}`);
							tmpResult.Bound[`fE${i}`] = tmpEdges[i];
						}
						tmpResult.Slots.D0 = fRequire(tmpExpressions.edgesIndex(fNumeric(tmpField), tmpNames, !!tmpGeometry.OpenEnded));
					}
					else
					{
						tmpResult.Slots.D0 = fRequire(tmpExpressions.numericIndex(fNumeric(tmpField)));
						tmpResult.Bound.fFactor = tmpGeometry.Factor;
						tmpResult.Bound.fLoUnits = tmpGeometry.LoUnits;
						tmpResult.Bound.fWidthUnits = tmpGeometry.WidthUnits;
						tmpResult.Bound.fLastIndex = tmpGeometry.N - 1;
						if (!(tmpGeometry.WidthUnits > 0) || !(tmpGeometry.N >= 1))
						{
							throw libFacetErrors.create('FACET_INTERNAL', 'Invalid numeric geometry.');
						}
					}
				}
				break;

			case 'Ranges':
				{
					let tmpDimension = fDimension(0);
					tmpResult.Slots.D0 = fRequire(tmpExpressions.rangeIndex(fNumeric(tmpDimension.Field), this._rangeNames(tmpDimension.Ranges, 'f', tmpResult.Bound)));
				}
				break;

			case 'Stats':
				{
					let tmpField = fMeasureField();
					let tmpInfo = fFieldInfo();
					if (DATE_TYPES.indexOf(tmpInfo.DataType) >= 0)
					{
						tmpResult.Slots.D0 = fRequire(tmpExpressions.dateCanonical(fColumn(tmpField)));
						tmpResult.Slots.D1 = 'NULL';
					}
					else
					{
						tmpResult.Slots.D0 = fNumeric(tmpField);
						tmpResult.Slots.D1 = fRequire(tmpExpressions.sumUnits(fNumeric(tmpField)));
						tmpResult.Bound.fFactor = Math.pow(10, (typeof(tmpInfo.Scale) === 'number') ? tmpInfo.Scale : 0);
					}
				}
				break;

			case 'DistinctCount':
				{
					let tmpInfo = fFieldInfo();
					tmpResult.Slots.D0 = (DATE_TYPES.indexOf(tmpInfo.DataType) >= 0)
						? fRequire(tmpExpressions.dateCanonical(fColumn(fMeasureField())))
						: fValueKey(fMeasureField(), tmpInfo.DataType);
				}
				break;

			case 'Missing':
				{
					let tmpInfo = fFieldInfo();
					tmpResult.Slots.D0 = (DATE_TYPES.indexOf(tmpInfo.DataType) >= 0)
						? fRequire(tmpExpressions.dateCanonical(fColumn(fMeasureField())))
						: libFacetBuckets.isNumericType(tmpInfo.DataType)
							? fNumeric(fMeasureField())
							: fColumn(fMeasureField());
				}
				break;

			case 'Pivot':
				tmpResult.Slots.D0 = this._axisExpression(pDialectName, tmpExpressions, fDimension(0), fColumn, 'f', tmpResult.Bound);
				tmpResult.Slots.D1 = this._axisExpression(pDialectName, tmpExpressions, fDimension(1), fColumn, 'fD1', tmpResult.Bound);
				// One cell past the limit tells the engine the cube is too large (422).
				tmpResult.Bound.fMaxGroups = fPositive(tmpLimits.CubeMaxGroups, 100000) + 1;
				break;

			default:
				throw libFacetErrors.create('FACET_INTERNAL', 'No shell template for this fold.');
		}

		// Shells never bind JS arrays (03 §3.4) — nor objects, NaN or Infinity.
		let tmpBoundNames = Object.keys(tmpResult.Bound);
		for (let i = 0; i < tmpBoundNames.length; i++)
		{
			if (!/^f[A-Za-z0-9_]*$/.test(tmpBoundNames[i]) || !isBindableScalar(tmpResult.Bound[tmpBoundNames[i]]))
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'A shell bind must be a scalar f* parameter.');
			}
			if (pDialectName === 'MSSQL')
			{
				tmpResult.ParamTypes[tmpBoundNames[i]] = this._mssqlBindType(tmpBoundNames[i], tmpResult.Bound[tmpBoundNames[i]]);
			}
		}

		return tmpResult;
	}

	/**
	 * Bind names (and values) for declared ranges.
	 *
	 * @param {Array<{ From: number|null, To: number|null }>} pRanges
	 * @param {string} pPrefix - 'f' or 'fD<k>'
	 * @param {Record<string, any>} pBound - receives the values
	 * @return {Array<{ From: string|null, To: string|null }>}
	 */
	_rangeNames(pRanges, pPrefix, pBound)
	{
		let tmpRanges = Array.isArray(pRanges) ? pRanges : [];
		if (tmpRanges.length < 1)
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'A ranges fold needs at least one range.');
		}
		let tmpNames = [];
		for (let i = 0; i < tmpRanges.length; i++)
		{
			let tmpEntry = { From: null, To: null };
			if ((tmpRanges[i].From !== null) && (typeof(tmpRanges[i].From) !== 'undefined'))
			{
				tmpEntry.From = `${pPrefix}R${i}From`;
				pBound[tmpEntry.From] = tmpRanges[i].From;
			}
			if ((tmpRanges[i].To !== null) && (typeof(tmpRanges[i].To) !== 'undefined'))
			{
				tmpEntry.To = `${pPrefix}R${i}To`;
				pBound[tmpEntry.To] = tmpRanges[i].To;
			}
			tmpNames.push(tmpEntry);
		}
		return tmpNames;
	}

	/**
	 * One pivot axis key expression (M1 axes: Column, DateBucket, Range).
	 *
	 * @param {string} pDialectName
	 * @param {Record<string, Function>} pExpressions
	 * @param {Record<string, any>} pDimension
	 * @param {(pField: string) => string} fColumn
	 * @param {string} pPrefix
	 * @param {Record<string, any>} pBound
	 * @return {string}
	 */
	_axisExpression(pDialectName, pExpressions, pDimension, fColumn, pPrefix, pBound)
	{
		let tmpSQL = null;
		switch (pDimension.Kind)
		{
			case 'Column':
				tmpSQL = libFacetBuckets.isNumericType(pDimension.DataType)
					? pExpressions.numericValue(fColumn(pDimension.Field))
					: pExpressions.valueKey(fColumn(pDimension.Field), pDimension.DataType);
				break;
			case 'DateBucket':
				tmpSQL = pExpressions.dateKey(fColumn(pDimension.Field), pDimension.Interval);
				break;
			case 'Range':
				tmpSQL = pExpressions.rangeIndex(pExpressions.numericValue(fColumn(pDimension.Field)), this._rangeNames(pDimension.Ranges, pPrefix, pBound));
				break;
			default:
				throw libFacetErrors.create('FACET_FOLD_UNSUPPORTED', 'This pivot axis is not supported.', { Feature: `PivotAxis:${pDimension.Kind}`, Milestone: 2 });
		}
		if ((typeof(tmpSQL) !== 'string') || (tmpSQL.length < 1))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'The dialect cannot express this pivot axis.');
		}
		return tmpSQL;
	}

	/**
	 * The per-row key expression of one (single-valued) dimension on an alias, as the matching
	 * single-dimension shell computes it: Column (numericValue / valueKey), DateBucket (dateKey),
	 * Range (rangeIndex: -1 NULL, -2 no range), NumericBucket with Edges (edgesIndex, NULL outside),
	 * ChildAgg (bandIndex over the computed aggregate column) and ExistsFlag (the 0/1 column).
	 * Bound values (edges, ranges) go into pBound under pPrefix (an f* prefix unique per statement).
	 *
	 * @param {string} pDialectName
	 * @param {Record<string, any>} pDimension - a Dim whose Field names a column of pAlias
	 * @param {string} pAlias
	 * @param {string} pPrefix - 'f' or 'fd<n>'
	 * @param {Record<string, any>} pBound
	 * @return {string}
	 */
	dimensionExpression(pDialectName, pDimension, pAlias, pPrefix, pBound)
	{
		let tmpModule = this.dialect(pDialectName);
		if (!tmpModule)
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'Unknown SQL dialect for shell templates.');
		}
		if (!pDimension || (typeof(pDimension.Field) !== 'string'))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'The fold is missing a dimension.');
		}
		if (!/^f[A-Za-z0-9]*$/.test(pPrefix))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'A shell bind prefix must be f*.');
		}
		let tmpExpressions = tmpModule.Expressions;
		let fColumn = (pField) => { return this.qualify(pDialectName, pAlias, pField); };
		let tmpSQL = null;
		switch (pDimension.Kind)
		{
			case 'Column':
			case 'DateBucket':
			case 'Range':
				return this._axisExpression(pDialectName, tmpExpressions, pDimension, fColumn, pPrefix, pBound);
			case 'NumericBucket':
				{
					if ((pDimension.Mode !== 'Edges') || !Array.isArray(pDimension.Edges) || (pDimension.Edges.length < 2))
					{
						throw libFacetErrors.create('FACET_INTERNAL', 'Only an Edges numeric dimension has a per-row key.');
					}
					let tmpNames = pDimension.Edges.map(
						(pEdge, pIndex) =>
						{
							pBound[`${pPrefix}E${pIndex}`] = pEdge;
							return `${pPrefix}E${pIndex}`;
						});
					tmpSQL = tmpExpressions.edgesIndex(tmpExpressions.numericValue(fColumn(pDimension.Field)), tmpNames, !!pDimension.OpenEnded);
				}
				break;
			case 'ChildAgg':
				{
					let tmpEdges = Array.isArray(pDimension.Edges) ? pDimension.Edges : [];
					if (tmpEdges.length < 1)
					{
						throw libFacetErrors.create('FACET_INTERNAL', 'A child rollup needs its band edges.');
					}
					let tmpNames = tmpEdges.map(
						(pEdge, pIndex) =>
						{
							pBound[`${pPrefix}E${pIndex}`] = pEdge;
							return `${pPrefix}E${pIndex}`;
						});
					tmpSQL = tmpExpressions.bandIndex(fColumn(pDimension.Field), tmpNames);
				}
				break;
			case 'ExistsFlag':
				tmpSQL = fColumn(pDimension.Field);
				break;
			default:
				throw libFacetErrors.create('FACET_FOLD_UNSUPPORTED', 'This dimension has no per-row key.', { Feature: `Dimension:${pDimension.Kind}`, Milestone: 2 });
		}
		if ((typeof(tmpSQL) !== 'string') || (tmpSQL.length < 1))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'The dialect cannot express this dimension.');
		}
		return tmpSQL;
	}

	/**
	 * The structural slots of the conditional disjunctive scan (internal-contracts §25.3):
	 *   D0  per-row: every dimension key AS "d<n>", every flag "p"."b<n>" / "p"."w<n>", every bound
	 *       value AS "v<n>", and a constant "z" (so the GROUP BY is never empty);
	 *   D2  per group: the grouped columns plus min / max (and count for numeric values) of each value;
	 *   D3  the GROUP BY list; D1 the outer select list (… , "N").
	 *
	 * @param {string} pDialectName
	 * @param {Record<string, Function>} pExpressions
	 * @param {{ Dims: Array<{ Column: string, Dim: Record<string, any> }>, Flags: Array<string>, Values?: Array<{ Column: string, Dim: Record<string, any>, Kind: string }> }} pCube
	 * @param {string} pAlias
	 * @param {Record<string, any>} pResult - render result (Slots / Bound receive the text)
	 */
	_renderCube(pDialectName, pExpressions, pCube, pAlias, pResult)
	{
		if ((typeof(pCube) !== 'object') || (pCube === null))
		{
			throw libFacetErrors.create('FACET_INTERNAL', 'The cube shell needs its grain.');
		}
		let fQuote = (pName) => { return this.quote(pDialectName, pName); };
		let fGrain = (pName) => { return this.qualify(pDialectName, 'g', pName); };
		let fOuter = (pName) => { return this.qualify(pDialectName, 'c', pName); };
		let tmpRow = [];
		let tmpGroup = [];
		let tmpGrouped = [];
		let tmpOuter = [];
		let tmpDims = Array.isArray(pCube.Dims) ? pCube.Dims : [];
		for (let i = 0; i < tmpDims.length; i++)
		{
			let tmpColumn = tmpDims[i].Column;
			tmpRow.push(`${this.dimensionExpression(pDialectName, tmpDims[i].Dim, pAlias, `fd${i}`, pResult.Bound)} AS ${fQuote(tmpColumn)}`);
			tmpGroup.push(`${fGrain(tmpColumn)} AS ${fQuote(tmpColumn)}`);
			tmpGrouped.push(fGrain(tmpColumn));
			tmpOuter.push(`${fOuter(tmpColumn)} AS ${fQuote(tmpColumn)}`);
		}
		let tmpFlags = Array.isArray(pCube.Flags) ? pCube.Flags : [];
		for (let i = 0; i < tmpFlags.length; i++)
		{
			tmpRow.push(`${this.qualify(pDialectName, pAlias, tmpFlags[i])} AS ${fQuote(tmpFlags[i])}`);
			tmpGroup.push(`${fGrain(tmpFlags[i])} AS ${fQuote(tmpFlags[i])}`);
			tmpGrouped.push(fGrain(tmpFlags[i]));
			tmpOuter.push(`${fOuter(tmpFlags[i])} AS ${fQuote(tmpFlags[i])}`);
		}
		let tmpValues = Array.isArray(pCube.Values) ? pCube.Values : [];
		for (let i = 0; i < tmpValues.length; i++)
		{
			let tmpValue = tmpValues[i];
			let tmpColumnSQL = this.qualify(pDialectName, pAlias, tmpValue.Dim.Field);
			let tmpSuffix = tmpValue.Column.replace(/^v/, '');
			let tmpLo = (typeof(tmpValue.Lo) === 'string') ? tmpValue.Lo : `lo${tmpSuffix}`;
			let tmpHi = (typeof(tmpValue.Hi) === 'string') ? tmpValue.Hi : `hi${tmpSuffix}`;
			let tmpNonNull = (typeof(tmpValue.NonNull) === 'string') ? tmpValue.NonNull : `nn${tmpSuffix}`;
			if (tmpValue.Kind === 'Date')
			{
				tmpRow.push(`${pExpressions.dateValue(tmpColumnSQL)} AS ${fQuote(tmpValue.Column)}`);
				tmpGroup.push(`${pExpressions.dateBound('min', fGrain(tmpValue.Column))} AS ${fQuote(tmpLo)}`);
				tmpGroup.push(`${pExpressions.dateBound('max', fGrain(tmpValue.Column))} AS ${fQuote(tmpHi)}`);
				tmpOuter.push(`${fOuter(tmpLo)} AS ${fQuote(tmpLo)}`, `${fOuter(tmpHi)} AS ${fQuote(tmpHi)}`);
			}
			else
			{
				tmpRow.push(`${pExpressions.numericValue(tmpColumnSQL)} AS ${fQuote(tmpValue.Column)}`);
				tmpGroup.push(`min(${fGrain(tmpValue.Column)}) AS ${fQuote(tmpLo)}`);
				tmpGroup.push(`max(${fGrain(tmpValue.Column)}) AS ${fQuote(tmpHi)}`);
				tmpGroup.push(`count(${fGrain(tmpValue.Column)}) AS ${fQuote(tmpNonNull)}`);
				tmpOuter.push(`${fOuter(tmpLo)} AS ${fQuote(tmpLo)}`, `${fOuter(tmpHi)} AS ${fQuote(tmpHi)}`, `${fOuter(tmpNonNull)} AS ${fQuote(tmpNonNull)}`);
			}
		}
		// Single-row aggregate members (Stats, Missing) as per-group measures: count / min / max / the
		// integer-unit sum of the measured value, marginalized like the counts (§25.3).
		let tmpMeasures = Array.isArray(pCube.Measures) ? pCube.Measures : [];
		for (let i = 0; i < tmpMeasures.length; i++)
		{
			let tmpMeasure = tmpMeasures[i];
			if ((typeof(tmpMeasure.Column) !== 'string') || !/^m[0-9]+$/.test(tmpMeasure.Column) || (typeof(tmpMeasure.Field) !== 'string'))
			{
				throw libFacetErrors.create('FACET_INTERNAL', 'Malformed cube measure.');
			}
			let tmpColumnSQL = this.qualify(pDialectName, pAlias, tmpMeasure.Field);
			let tmpIsDate = (DATE_TYPES.indexOf(tmpMeasure.DataType) >= 0);
			let tmpValue = tmpIsDate ? pExpressions.dateCanonical(tmpColumnSQL)
				: (libFacetBuckets.isNumericType(tmpMeasure.DataType) ? pExpressions.numericValue(tmpColumnSQL) : tmpColumnSQL);
			let tmpNames = { NonNull: `${tmpMeasure.Column}nn`, Min: `${tmpMeasure.Column}lo`, Max: `${tmpMeasure.Column}hi`, Sum: `${tmpMeasure.Column}su` };
			tmpRow.push(`${tmpValue} AS ${fQuote(tmpMeasure.Column)}`);
			tmpGroup.push(`count(${fGrain(tmpMeasure.Column)}) AS ${fQuote(tmpNames.NonNull)}`);
			tmpOuter.push(`${fOuter(tmpNames.NonNull)} AS ${fQuote(tmpNames.NonNull)}`);
			if (tmpMeasure.Kind === 'Stats')
			{
				tmpGroup.push(`min(${fGrain(tmpMeasure.Column)}) AS ${fQuote(tmpNames.Min)}`, `max(${fGrain(tmpMeasure.Column)}) AS ${fQuote(tmpNames.Max)}`);
				tmpOuter.push(`${fOuter(tmpNames.Min)} AS ${fQuote(tmpNames.Min)}`, `${fOuter(tmpNames.Max)} AS ${fQuote(tmpNames.Max)}`);
				if (!tmpIsDate)
				{
					let tmpFactorBind = `f${tmpMeasure.Column}Factor`;
					tmpGroup.push(`${pExpressions.sumUnits(fGrain(tmpMeasure.Column), tmpFactorBind)} AS ${fQuote(tmpNames.Sum)}`);
					tmpOuter.push(`${fOuter(tmpNames.Sum)} AS ${fQuote(tmpNames.Sum)}`);
					pResult.Bound[tmpFactorBind] = Math.pow(10, (typeof(tmpMeasure.Scale) === 'number') ? tmpMeasure.Scale : 0);
				}
			}
		}
		tmpRow.push(`0 AS ${fQuote('z')}`);
		tmpGrouped.push(fGrain('z'));
		tmpOuter.push(`${fOuter('N')} AS ${fQuote('N')}`);
		pResult.Slots.D0 = tmpRow.join(', ');
		pResult.Slots.D2 = tmpGroup.concat([ `${fGrain('z')} AS ${fQuote('z')}` ]).join(', ');
		pResult.Slots.D3 = tmpGrouped.join(', ');
		pResult.Slots.D1 = tmpOuter.join(', ');
	}

	/**
	 * MSSQL parameter type of one shell bind.
	 *
	 * @param {string} pName
	 * @param {any} pValue
	 * @return {string}
	 */
	_mssqlBindType(pName, pValue)
	{
		for (let i = 0; i < MSSQL_BIND_TYPES.length; i++)
		{
			if (MSSQL_BIND_TYPES[i][0].test(pName))
			{
				return MSSQL_BIND_TYPES[i][1];
			}
		}
		return (typeof(pValue) === 'number') ? 'Float' : 'VarChar';
	}

	/**
	 * Splice a rendered shell into a FoxHound query (relations first, then slots, binds and the
	 * override).  Shared by EngineLive and the dry-build so both compose identically.
	 *
	 * @param {any} pQuery - a FoxHound query with no filters (delete tracking disabled by the caller)
	 * @param {{ Template: string, Slots: Record<string, string>, Bound: Record<string, any>, ParamTypes: Record<string, string> }} pShell
	 * @return {any} pQuery
	 */
	applyToQuery(pQuery, pShell)
	{
		let tmpSlotNames = Object.keys(pShell.Slots || {});
		for (let i = 0; i < tmpSlotNames.length; i++)
		{
			pQuery.parameters[tmpSlotNames[i]] = pShell.Slots[tmpSlotNames[i]];
		}
		Object.assign(pQuery.query.parameters, pShell.Bound || {});
		let tmpTypeNames = Object.keys(pShell.ParamTypes || {});
		if (tmpTypeNames.length > 0)
		{
			if ((typeof(pQuery.query.parameterTypes) !== 'object') || (pQuery.query.parameterTypes === null))
			{
				pQuery.query.parameterTypes = {};
			}
			for (let i = 0; i < tmpTypeNames.length; i++)
			{
				pQuery.query.parameterTypes[tmpTypeNames[i]] = pShell.ParamTypes[tmpTypeNames[i]];
			}
		}
		pQuery.parameters.queryOverride = pShell.Template;
		return pQuery;
	}

	/**
	 * Tag-scan every template of every dialect, check every required template and expression exists,
	 * and dry-build each shell (render + FoxHound build, no provider) against every dialect.
	 *
	 * @return {{ Errors: Array<{ Dialect: string, Template: string, Tag: string }> }}
	 */
	validateAll()
	{
		let tmpErrors = [];
		let tmpDialectNames = Object.keys(this._Dialects);
		for (let i = 0; i < tmpDialectNames.length; i++)
		{
			let tmpDialectName = tmpDialectNames[i];
			let tmpModule = this._Dialects[tmpDialectName];
			let tmpTemplates = tmpModule.Templates || {};
			let tmpTemplateNames = Object.keys(tmpTemplates);
			for (let j = 0; j < tmpTemplateNames.length; j++)
			{
				let tmpTags = String(tmpTemplates[tmpTemplateNames[j]]).match(/<%[\s\S]*?%>/g) || [];
				for (let k = 0; k < tmpTags.length; k++)
				{
					if (!ALLOWED_SLOT_PATTERN.test(tmpTags[k]))
					{
						tmpErrors.push({ Dialect: tmpDialectName, Template: tmpTemplateNames[j], Tag: tmpTags[k] });
					}
				}
			}
			for (let j = 0; j < REQUIRED_TEMPLATES.length; j++)
			{
				if (!hasOwn(tmpTemplates, REQUIRED_TEMPLATES[j]))
				{
					tmpErrors.push({ Dialect: tmpDialectName, Template: REQUIRED_TEMPLATES[j], Tag: '(missing template)' });
				}
			}
			let tmpExpressions = tmpModule.Expressions || {};
			for (let j = 0; j < REQUIRED_EXPRESSIONS.length; j++)
			{
				if (typeof(tmpExpressions[REQUIRED_EXPRESSIONS[j]]) !== 'function')
				{
					tmpErrors.push({ Dialect: tmpDialectName, Template: `Expressions.${REQUIRED_EXPRESSIONS[j]}`, Tag: '(missing expression)' });
				}
			}
			if (typeof(tmpExpressions.dateKey) === 'function')
			{
				for (let j = 0; j < INTERVALS.length; j++)
				{
					let tmpKeySQL = tmpExpressions.dateKey(this.qualify(tmpDialectName, 'p', 'DryDate'), INTERVALS[j]);
					if ((typeof(tmpKeySQL) !== 'string') || (tmpKeySQL.length < 1) || (tmpKeySQL.indexOf('<%') >= 0))
					{
						tmpErrors.push({ Dialect: tmpDialectName, Template: `Expressions.dateKey(${INTERVALS[j]})`, Tag: '(no expression)' });
					}
				}
			}
			let tmpDryNames = Object.keys(DRY_BUILD_AGGS);
			for (let j = 0; j < tmpDryNames.length; j++)
			{
				if (!hasOwn(tmpTemplates, tmpDryNames[j]))
				{
					continue;
				}
				let tmpBody = this._dryBuild(tmpDialectName, DRY_BUILD_AGGS[tmpDryNames[j]].Agg, DRY_BUILD_AGGS[tmpDryNames[j]].Slots);
				if (tmpBody.Error)
				{
					tmpErrors.push({ Dialect: tmpDialectName, Template: tmpDryNames[j], Tag: `(dry-build: ${tmpBody.Error})` });
				}
			}
		}
		return { Errors: tmpErrors };
	}

	/**
	 * Render and build one shell against a dummy relation, with no provider.
	 *
	 * @param {string} pDialectName
	 * @param {Record<string, any>} pAgg
	 * @param {Record<string, any>} pSlots
	 * @return {{ SQL?: string, Error?: string }}
	 */
	_dryBuild(pDialectName, pAgg, pSlots)
	{
		let tmpShell;
		try
		{
			tmpShell = this.render(pDialectName, pAgg, Object.assign({ SR0: 'SELECT 1 AS DryColumn' }, pSlots));
		}
		catch (pRenderError)
		{
			return { Error: `render: ${pRenderError.message}` };
		}
		let tmpQuery = libFoxHound.new(this.fable).setScope('FacetDryBuild');
		tmpQuery.setDisableDeleteTracking(true);
		this.applyToQuery(tmpQuery, tmpShell);
		try
		{
			tmpQuery.setDialect(pDialectName).buildReadQuery();
		}
		catch (pBuildError)
		{
			return { Error: `build: ${pBuildError.message}` };
		}
		let tmpBody = tmpQuery.query.body;
		if ((typeof(tmpBody) !== 'string') || (tmpBody.length < 1))
		{
			return { Error: 'empty body' };
		}
		if ((tmpBody.indexOf('<%') >= 0) || (tmpBody.indexOf('%>') >= 0))
		{
			return { Error: 'unrendered tag' };
		}
		return { SQL: tmpBody };
	}
}

module.exports = RetoldFacetingShellTemplates;
module.exports.serviceType = 'RetoldFacetingShellTemplates';
module.exports.ALLOWED_SLOT_PATTERN = ALLOWED_SLOT_PATTERN;
module.exports.REQUIRED_TEMPLATES = REQUIRED_TEMPLATES;
module.exports.M1_TEMPLATES = M1_TEMPLATES;
module.exports.M2_TEMPLATES = M2_TEMPLATES;
module.exports.REQUIRED_EXPRESSIONS = REQUIRED_EXPRESSIONS;
module.exports.SHELL_FOR_KIND = SHELL_FOR_KIND;
module.exports.DEFAULT_MAX_TERMS_GROUPS = DEFAULT_MAX_TERMS_GROUPS;
