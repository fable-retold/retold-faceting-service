/**
 * Request-phase tests: RequestNormalizer, FilterValidator, ClauseCompiler, FilterAST,
 * DisjunctivePlanner (internal-contracts §3, §4, §6).
 *
 * No server, no port: the SQL oracle runs on an in-memory node:sqlite database built here from the
 * bookstore model (Book + BookStoreSale) with a fixed-seed PRNG, through a real meadow DAL.  Every
 * filter is executed four ways and must select the same rows:
 *   1. FilterAST.applyToQuery inside a fence           (the Scoped Relation path)
 *   2. meadow-filter parsing the client string, fenced  (the list's own semantics)
 *   3. meadow-filter parsing FilterAST.toFilterString   (the harness list oracle)
 *   4. a JS evaluator of the Pred with SQL NULL / affinity / LIKE semantics
 * plus 5. build(toFilterString(…, { Encode: true })) round-tripping through the validator.
 * (2 and 3 are skipped for NULL predicates: FoxHound's SQLite dialect has no IS NULL branch, FH-2.)
 *
 * The catalog is a local stub implementing the §11.1 ColumnInfo subset these services read
 * (column(): null for unknown / Sensitive, DataType, IsDeleteColumn); a second suite repeats the
 * whitelist checks against the real RetoldFacetingCatalog when it can be built from the model.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libFable = require('fable');
const libFableServiceProviderBase = require('fable-serviceproviderbase');
const libMeadow = require('meadow');
const libMeadowFilter = require('meadow-filter');
const libMeadowConnectionSQLite = require('meadow-connection-sqlite');

const libRequestNormalizer = require('../source/request/Retold-Faceting-RequestNormalizer.js');
const libFilterValidator = require('../source/request/Retold-Faceting-FilterValidator.js');
const libClauseCompiler = require('../source/request/Retold-Faceting-ClauseCompiler.js');
const libFilterAST = require('../source/request/Retold-Faceting-FilterAST.js');
const libDisjunctivePlanner = require('../source/request/Retold-Faceting-DisjunctivePlanner.js');
const libFacetErrors = require('../source/contract/Facet-Contract-Errors.js');

const libBuilders = require('./support/Facet-Test-Builders.js');

const SENSITIVE_PATTERN = libBuilders.SENSITIVE_PATTERN;
const SEED = 20261008;

const REQUEST_SERVICES = (
	[
		[ 'RetoldFacetingRequestNormalizer', libRequestNormalizer ],
		[ 'RetoldFacetingFilterValidator', libFilterValidator ],
		[ 'RetoldFacetingClauseCompiler', libClauseCompiler ],
		[ 'RetoldFacetingFilterAST', libFilterAST ],
		[ 'RetoldFacetingDisjunctivePlanner', libDisjunctivePlanner ]
	]);

/**
 * A deep clone of the bookstore model (never the live harness DB).
 *
 * @return {Record<string, any>}
 */
const bookstoreModel = () =>
{
	return libBuilders.bookstoreModel('Bookstore');
};

/**
 * Test-local catalog: the §11.1 ColumnInfo subset the request services read.
 */
class TestCatalog extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);
		this.serviceType = 'RetoldFacetingCatalog';
		this.model = bookstoreModel();
	}

	column(pEntity, pColumn)
	{
		let tmpTable = this.model.Tables.hasOwnProperty(pEntity) ? this.model.Tables[pEntity] : null;
		if (!tmpTable || SENSITIVE_PATTERN.test(pColumn))
		{
			return null;
		}
		let tmpColumn = tmpTable.Columns.find((pEntry) => { return pEntry.Column === pColumn; });
		if (!tmpColumn)
		{
			return null;
		}
		let tmpSchema = tmpTable.MeadowSchema.Schema.find((pEntry) => { return pEntry.Column === pColumn; }) || {};
		return (
			{
				Entity: pEntity,
				Column: pColumn,
				DataType: tmpColumn.Join ? 'ForeignKey' : tmpColumn.DataType,
				MeadowType: tmpSchema.Type,
				IsDeleteColumn: (tmpSchema.Type === 'Deleted'),
				Sensitive: false,
				Filterable: true
			});
	}
}

/**
 * A fable with the request services (and a catalog) registered the way the main service does.
 *
 * @param {Record<string, any>} [pFacetingOptions]
 * @param {Function} [pCatalogClass]
 * @return {any}
 */
const newFable = (pFacetingOptions, pCatalogClass) =>
{
	let tmpFable = new libFable({ Product: 'RetoldFacetingFilterASTTests', LogStreams: [ { streamtype: 'console', level: 'fatal' } ] });
	tmpFable.addServiceType('RetoldFacetingCatalog', pCatalogClass || TestCatalog);
	tmpFable.instantiateServiceProvider('RetoldFacetingCatalog', pFacetingOptions || {});
	for (let i = 0; i < REQUEST_SERVICES.length; i++)
	{
		tmpFable.addServiceType(REQUEST_SERVICES[i][0], REQUEST_SERVICES[i][1]);
		tmpFable.instantiateServiceProvider(REQUEST_SERVICES[i][0], pFacetingOptions || {});
	}
	return tmpFable;
};

/**
 * Run a function and return the FacetError it throws (fails the test when it does not throw).
 *
 * @param {Function} fRun
 * @return {Error}
 */
const facetError = (fRun) =>
{
	try
	{
		fRun();
	}
	catch (pError)
	{
		Expect(libFacetErrors.isFacetError(pError), `expected a FacetError, got ${pError && pError.stack}`).to.equal(true);
		return pError;
	}
	throw new Error('Expected a FacetError to be thrown.');
};

// ---------------------------------------------------------------- the SQL oracle database

// mulberry32 (the fixture PRNG, owned by Bookstore-Seed).
const prng = libBuilders.prng;

const NUMERIC_TYPES = [ 'ID', 'Numeric', 'Boolean', 'Decimal', 'ForeignKey' ];

/**
 * Build Book + BookStoreSale in an in-memory SQLite with deterministic rows.
 *
 * @param {any} pDB - node:sqlite DatabaseSync
 * @param {Record<string, any>} pModel
 * @return {Record<string, Array<Record<string, any>>>} the inserted rows per entity
 */
const seedOracleDatabase = (pDB, pModel) =>
{
	let fRandom = prng(SEED);
	let fPick = (pList) => { return pList[Math.floor(fRandom() * pList.length)]; };
	let tmpRows = { Book: [], BookStoreSale: [] };

	let tmpEntities = Object.keys(tmpRows);
	for (let e = 0; e < tmpEntities.length; e++)
	{
		let tmpColumns = pModel.Tables[tmpEntities[e]].Columns.map(
			(pColumn) =>
			{
				if (pColumn.DataType === 'ID')
				{
					return `"${pColumn.Column}" INTEGER PRIMARY KEY AUTOINCREMENT`;
				}
				let tmpType = (pColumn.DataType === 'Decimal') ? 'REAL' : (NUMERIC_TYPES.indexOf(pColumn.DataType) >= 0) ? 'INTEGER' : 'TEXT';
				return `"${pColumn.Column}" ${tmpType}` + ((pColumn.Column === 'Deleted') ? ' DEFAULT 0' : '');
			});
		pDB.exec(`CREATE TABLE "${tmpEntities[e]}" (${tmpColumns.join(', ')})`);
	}

	let tmpWords = [ 'The', 'Silent', 'Sea', 'Garden', 'of', 'Stone', 'Night', 'Under', 'River', 'Atlas', 'the', 'Glass', 'apple', 'Tower', '50% Off', 'A_B' ];
	let tmpInsertBook = pDB.prepare('INSERT INTO Book (GUIDBook, Deleted, Title, Genre, Language, PublicationYear, Type) VALUES (?, ?, ?, ?, ?, ?, ?)');
	for (let i = 0; i < 90; i++)
	{
		let tmpBook = (
			{
				IDBook: i + 1,
				GUIDBook: `book-${i + 1}`,
				Deleted: (fRandom() < 0.12) ? 1 : 0,
				Title: [ fPick(tmpWords), fPick(tmpWords), fPick(tmpWords) ].join(' '),
				Genre: fPick([ 'Fiction', 'Fiction', 'Fiction', 'Poetry', 'History', 'Science', null ]),
				Language: fPick([ 'English', 'English', 'English', 'English', 'French', 'German', '', null ]),
				PublicationYear: (fRandom() < 0.1) ? null : 1900 + Math.floor(fRandom() * 126),
				Type: fPick([ 'Paperback', 'Hardcover', 'Ebook' ])
			});
		tmpInsertBook.run(tmpBook.GUIDBook, tmpBook.Deleted, tmpBook.Title, tmpBook.Genre, tmpBook.Language, tmpBook.PublicationYear, tmpBook.Type);
		tmpRows.Book.push(tmpBook);
	}

	let tmpInsertSale = pDB.prepare('INSERT INTO BookStoreSale (GUIDBookStoreSale, Deleted, SaleDate, TotalAmount, PaymentMethod, IDBookStore) VALUES (?, ?, ?, ?, ?, ?)');
	let fPad = (pNumber) => { return (pNumber < 10) ? '0' + pNumber : String(pNumber); };
	for (let i = 0; i < 120; i++)
	{
		let tmpSaleDate = null;
		if (fRandom() > 0.08)
		{
			tmpSaleDate = `${2024 + Math.floor(fRandom() * 3)}-${fPad(1 + Math.floor(fRandom() * 12))}-${fPad(1 + Math.floor(fRandom() * 28))} ${fPad(Math.floor(fRandom() * 24))}:${fPad(Math.floor(fRandom() * 60))}:00`;
		}
		let tmpSale = (
			{
				IDBookStoreSale: i + 1,
				GUIDBookStoreSale: `sale-${i + 1}`,
				Deleted: (fRandom() < 0.1) ? 1 : 0,
				SaleDate: tmpSaleDate,
				TotalAmount: (fRandom() < 0.07) ? null : Math.round(fRandom() * 20000) / 100,
				PaymentMethod: fPick([ 'Credit', 'Credit', 'Credit', 'Cash', 'Cash', 'Check', '', null ]),
				IDBookStore: 1 + Math.floor(fRandom() * 4)
			});
		tmpInsertSale.run(tmpSale.GUIDBookStoreSale, tmpSale.Deleted, tmpSale.SaleDate, tmpSale.TotalAmount, tmpSale.PaymentMethod, tmpSale.IDBookStore);
		tmpRows.BookStoreSale.push(tmpSale);
	}
	return tmpRows;
};

// ---------------------------------------------------------------- the JS oracle (SQLite semantics)

/**
 * SQLite comparison of a stored value and a bound value under the column's affinity.
 * Returns null when either side is NULL.
 *
 * @param {any} pStored
 * @param {any} pBound
 * @param {boolean} pNumericAffinity
 * @return {number|null} <0, 0, >0
 */
const sqliteCompare = (pStored, pBound, pNumericAffinity) =>
{
	if ((pStored === null) || (pBound === null) || (typeof(pBound) === 'undefined'))
	{
		return null;
	}
	let tmpBound = pBound;
	if (pNumericAffinity && (typeof(tmpBound) === 'string') && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(tmpBound))
	{
		tmpBound = Number(tmpBound);
	}
	if (!pNumericAffinity && (typeof(tmpBound) === 'number'))
	{
		tmpBound = String(tmpBound);
	}
	let tmpStoredIsNumber = (typeof(pStored) === 'number');
	let tmpBoundIsNumber = (typeof(tmpBound) === 'number');
	if (tmpStoredIsNumber && tmpBoundIsNumber)
	{
		return pStored - tmpBound;
	}
	if (tmpStoredIsNumber !== tmpBoundIsNumber)
	{
		// numbers sort before text
		return tmpStoredIsNumber ? -1 : 1;
	}
	return (pStored < tmpBound) ? -1 : (pStored > tmpBound) ? 1 : 0;
};

/**
 * SQLite LIKE (ASCII case-insensitive, % and _ wildcards, no escape).
 *
 * @param {any} pStored
 * @param {string} pPattern
 * @return {boolean|null}
 */
const sqliteLike = (pStored, pPattern) =>
{
	if (pStored === null)
	{
		return null;
	}
	let tmpRegex = '^' + String(pPattern).split('').map(
		(pChar) =>
		{
			if (pChar === '%')
			{
				return '[\\s\\S]*';
			}
			if (pChar === '_')
			{
				return '[\\s\\S]';
			}
			return pChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		}).join('') + '$';
	return new RegExp(tmpRegex, 'i').test(String(pStored));
};

/**
 * Evaluate a Pred against a row (true only when SQL would select it; no NOT, so NULL ≡ false).
 *
 * @param {Record<string, any>} pPred
 * @param {Record<string, any>} pRow
 * @param {(pField: string) => boolean} fNumeric
 * @return {boolean}
 */
const evaluatePred = (pPred, pRow, fNumeric) =>
{
	if (Array.isArray(pPred.And))
	{
		return pPred.And.every((pChild) => { return evaluatePred(pChild, pRow, fNumeric); });
	}
	if (Array.isArray(pPred.Or))
	{
		return pPred.Or.some((pChild) => { return evaluatePred(pChild, pRow, fNumeric); });
	}
	let tmpStored = pRow[pPred.Field];
	let tmpNumeric = fNumeric(pPred.Field);
	switch (pPred.Op)
	{
		case 'NULL':
			return (tmpStored === null);
		case 'NOTNULL':
			return (tmpStored !== null);
		case 'LK':
			return sqliteLike(tmpStored, pPred.Value) === true;
		case 'NLK':
			return sqliteLike(tmpStored, pPred.Value) === false;
		case 'IN':
			return pPred.Value.some((pValue) => { return sqliteCompare(tmpStored, pValue, tmpNumeric) === 0; });
		case 'NIN':
			return (tmpStored !== null) && pPred.Value.every((pValue) => { return sqliteCompare(tmpStored, pValue, tmpNumeric) !== 0; });
		default:
		{
			let tmpCompare = sqliteCompare(tmpStored, pPred.Value, tmpNumeric);
			if (tmpCompare === null)
			{
				return false;
			}
			switch (pPred.Op)
			{
				case 'EQ': return tmpCompare === 0;
				case 'NE': return tmpCompare !== 0;
				case 'GT': return tmpCompare > 0;
				case 'GE': return tmpCompare >= 0;
				case 'LT': return tmpCompare < 0;
				case 'LE': return tmpCompare <= 0;
			}
			throw new Error(`oracle: unknown op ${pPred.Op}`);
		}
	}
};

/**
 * Does any leaf use a NULL predicate (unrenderable by the stock SQLite list, FH-2)?
 *
 * @param {Array<Record<string, any>>} pConjuncts
 * @return {boolean}
 */
const usesNullPredicate = (pConjuncts) =>
{
	let fWalk = (pPred) =>
	{
		if (Array.isArray(pPred.And))
		{
			return pPred.And.some(fWalk);
		}
		if (Array.isArray(pPred.Or))
		{
			return pPred.Or.some(fWalk);
		}
		return (pPred.Op === 'NULL');
	};
	return pConjuncts.some((pConjunct) => { return fWalk(pConjunct.Pred); });
};

suite
(
	'Facet-FilterAST',
	() =>
	{
		let _Fable = null;
		let _AST = null;
		let _Validator = null;
		let _Compiler = null;
		let _Normalizer = null;
		let _Planner = null;

		setup(
			() =>
			{
				_Fable = newFable();
				_AST = _Fable.RetoldFacetingFilterAST;
				_Validator = _Fable.RetoldFacetingFilterValidator;
				_Compiler = _Fable.RetoldFacetingClauseCompiler;
				_Normalizer = _Fable.RetoldFacetingRequestNormalizer;
				_Planner = _Fable.RetoldFacetingDisjunctivePlanner;
			});

		suite
		(
			'FilterValidator (L2)',
			() =>
			{
				test('tokenizes allowlisted stanzas into quads with offsets',
					() =>
					{
						let tmpResult = _Validator.validate('Book', 'FBV~Language~EQ~English~FBL~Genre~INN~Fiction,Poetry~FBVOR~PublicationYear~GE~2000', { AllowDeleteColumn: true });
						Expect(tmpResult.Warnings).to.deep.equal([]);
						Expect(tmpResult.Stanzas.length).to.equal(3);
						Expect(tmpResult.Stanzas[0]).to.deep.equal({ Instruction: 'FBV', Field: 'Language', Operator: 'EQ', Value: 'English', Offset: 0 });
						Expect(tmpResult.Stanzas[1].Values).to.deep.equal([ 'Fiction', 'Poetry' ]);
						Expect(tmpResult.Stanzas[2].Offset).to.equal(2);
					});

				test('decodes exactly once',
					() =>
					{
						let tmpResult = _Validator.validate('Book', 'FBV~Title~LK~%25Sea%25~FBV~Language~EQ~%2525', {});
						Expect(tmpResult.Stanzas[0].Value).to.equal('%Sea%');
						// '%2525' decodes once to '%25' (not twice to '%')
						Expect(tmpResult.Stanzas[1].Value).to.equal('%25');
					});

				test('empty / null filter strings yield no stanzas',
					() =>
					{
						Expect(_Validator.validate('Book', '', {}).Stanzas).to.deep.equal([]);
						Expect(_Validator.validate('Book', null, {}).Stanzas).to.deep.equal([]);
					});

				test('strips FSF with a single FACET_SORT_IGNORED warning',
					() =>
					{
						let tmpResult = _Validator.validate('Book', 'FSF~Title~ASC~0~FBV~Genre~EQ~Fiction~FSF~PublicationYear~DESC~0', {});
						Expect(tmpResult.Stanzas.length).to.equal(1);
						Expect(tmpResult.Stanzas[0].Offset).to.equal(1);
						Expect(tmpResult.Warnings).to.deep.equal([ { Code: 'FACET_SORT_IGNORED', Detail: 'FSF stanzas do not affect facets.' } ]);
					});

				test('tolerates exactly one trailing "~" and rejects other partial quads',
					() =>
					{
						Expect(_Validator.validate('Book', 'FBV~Genre~EQ~Fiction~', {}).Stanzas.length).to.equal(1);
						let tmpError = facetError(() => { _Validator.validate('Book', 'FBV~Genre~EQ', {}); });
						Expect(tmpError.Code).to.equal('FACET_FILTER_INVALID');
						Expect(tmpError.Detail.Offset).to.equal(0);
						tmpError = facetError(() => { _Validator.validate('Book', 'FBV~Genre~EQ~Fiction~FBV~Title', {}); });
						Expect(tmpError.Detail.Offset).to.equal(1);
						facetError(() => { _Validator.validate('Book', 'FBV~Genre~EQ~Fiction~~', {}); });
					});

				test('rejects malformed percent-escapes and control characters',
					() =>
					{
						Expect(facetError(() => { _Validator.validate('Book', 'FBV~Title~EQ~%E0%A4%A', {}); }).Detail.Reason).to.equal('MalformedEscape');
						Expect(facetError(() => { _Validator.validate('Book', 'FBV~Title~EQ~a%0Ab', {}); }).Detail.Reason).to.equal('ControlCharacter');
						Expect(facetError(() => { _Validator.validate('Book', 'FBV~Title~EQ~a\u0000b', {}); }).Code).to.equal('FACET_FILTER_INVALID');
					});

				test('rejects every non-allowlisted instruction with its offset and token',
					() =>
					{
						let tmpInstructions = [ 'FBD', 'FBDOR', 'FBJV', 'FBJVOR', 'FBJL', 'FBJLOR', 'FBJD', 'FSJF', 'FDST', 'XYZ', 'fbv' ];
						tmpInstructions.forEach(
							(pInstruction) =>
							{
								let tmpError = facetError(() => { _Validator.validate('Book', `FBV~Genre~EQ~Fiction~${pInstruction}~Title~EQ~x`, {}); });
								Expect(tmpError.Code, pInstruction).to.equal('FACET_FILTER_INVALID');
								Expect(tmpError.Status).to.equal(400);
								Expect(tmpError.Detail.Offset).to.equal(1);
								Expect(tmpError.Detail.Token).to.equal(pInstruction);
							});
					});

				test('whitelists fields: unknown, Sensitive, wrong case and dotted JSON paths are FACET_UNKNOWN_FIELD',
					() =>
					{
						let tmpCases = (
							[
								[ 'Book', 'FBV~Nope~EQ~1' ],
								[ 'Book', 'FBV~title~EQ~1' ],
								[ 'Book', 'FBV~Title.Sub~EQ~1' ],
								[ 'User', 'FBV~Password~EQ~x' ],
								[ 'BookPrice', 'FBV~CouponCode~EQ~x' ],
								[ 'Book', 'FBV~Title`) OR 1=1 --~EQ~x' ],
								[ 'Book', 'FBV~Title"~EQ~x' ],
								[ 'NoSuchEntity', 'FBV~Title~EQ~x' ]
							]);
						tmpCases.forEach(
							(pCase) =>
							{
								let tmpError = facetError(() => { _Validator.validate(pCase[0], pCase[1], { AllowDeleteColumn: true }); });
								Expect(tmpError.Code, pCase[1]).to.equal('FACET_UNKNOWN_FIELD');
								Expect(tmpError.Status).to.equal(400);
							});
					});

				test('the delete column is legal only with AllowDeleteColumn',
					() =>
					{
						Expect(facetError(() => { _Validator.validate('Book', 'FBL~Deleted~INN~0,1', {}); }).Detail.Reason).to.equal('DeleteColumnNotAllowed');
						Expect(_Validator.validate('Book', 'FBL~Deleted~INN~0,1', { AllowDeleteColumn: true }).Stanzas.length).to.equal(1);
					});

				test('operators: allowlist, list instructions take only list operators and vice versa',
					() =>
					{
						Expect(facetError(() => { _Validator.validate('Book', 'FBV~Genre~XX~a', {}); }).Detail.Reason).to.equal('UnsupportedOperator');
						Expect(facetError(() => { _Validator.validate('Book', 'FBV~Genre~INN~a,b', {}); }).Detail.Reason).to.equal('ListOperatorNeedsListInstruction');
						Expect(facetError(() => { _Validator.validate('Book', 'FBVOR~Genre~NIN~a', {}); }).Code).to.equal('FACET_FILTER_INVALID');
						Expect(facetError(() => { _Validator.validate('Book', 'FBL~Genre~EQ~a,b', {}); }).Detail.Reason).to.equal('ListInstructionNeedsListOperator');
						Expect(facetError(() => { _Validator.validate('Book', 'FBL~Genre~IN~a', {}); }).Code).to.equal('FACET_FILTER_INVALID');
						Expect(facetError(() => { _Validator.validate('Book', 'FBL~Genre~INN~a,,b', {}); }).Detail.Reason).to.equal('EmptyListItem');
						Expect(facetError(() => { _Validator.validate('Book', 'FBL~Genre~INN~', {}); }).Detail.Reason).to.equal('EmptyListItem');
						// every allowlisted value operator passes
						[ 'EQ', 'NE', 'GT', 'GE', 'LT', 'LE', 'LK', 'NLK', 'IN', 'NN' ].forEach(
							(pOperator) =>
							{
								Expect(_Validator.validate('Book', `FBV~Genre~${pOperator}~x`, {}).Stanzas[0].Operator).to.equal(pOperator);
							});
					});

				test('parens: one nesting level, balanced, never empty',
					() =>
					{
						Expect(facetError(() => { _Validator.validate('Book', 'FBV~Genre~EQ~a~FOP~0~(~0~FOP~0~(~0~FBV~Genre~EQ~b~FCP~0~)~0~FCP~0~)~0', {}); }).Detail.Reason).to.equal('NestedGroup');
						Expect(facetError(() => { _Validator.validate('Book', 'FOP~0~(~0~FBV~Genre~EQ~b~FBV~Title~EQ~a', {}); }).Detail.Reason).to.equal('UnbalancedParens');
						Expect(facetError(() => { _Validator.validate('Book', 'FBV~Genre~EQ~b~FCP~0~)~0', {}); }).Detail.Reason).to.equal('UnbalancedParens');
						Expect(facetError(() => { _Validator.validate('Book', 'FBV~Genre~EQ~b~FOP~0~(~0~FCP~0~)~0', {}); }).Detail.Reason).to.equal('EmptyGroup');
						Expect(facetError(() => { _Validator.validate('Book', 'FOP~0~(~0~FCP~0~)~0', {}); }).Detail.Reason).to.equal('EmptyGroup');
					});

				test('a whole-string fence is unwrapped once (then one nesting level applies inside)',
					() =>
					{
						let tmpResult = _Validator.validate('Book', 'FOP~0~(~0~FBV~Genre~EQ~a~FOP~0~(~0~FBV~Language~EQ~b~FBVOR~Language~EQ~c~FCP~0~)~0~FCP~0~)~0', {});
						Expect(tmpResult.Stanzas.map((pStanza) => { return pStanza.Instruction; })).to.deep.equal([ 'FBV', 'FOP', 'FBV', 'FBVOR', 'FCP' ]);
						// two separate groups are not a whole-string fence
						tmpResult = _Validator.validate('Book', 'FOP~0~(~0~FBV~Genre~EQ~a~FCP~0~)~0~FOP~0~(~0~FBV~Genre~EQ~b~FCP~0~)~0', {});
						Expect(tmpResult.Stanzas.length).to.equal(6);
						// only once: a doubly fenced group still has its inner group
						tmpResult = _Validator.validate('Book', 'FOP~0~(~0~FOP~0~(~0~FBV~Genre~EQ~a~FCP~0~)~0~FCP~0~)~0', {});
						Expect(tmpResult.Stanzas.map((pStanza) => { return pStanza.Instruction; })).to.deep.equal([ 'FOP', 'FBV', 'FCP' ]);
					});

				test('values: no "~" smuggled through %7E, bounded length',
					() =>
					{
						Expect(facetError(() => { _Validator.validate('Book', 'FBV~Title~EQ~a%257Eb', {}); }).Detail.Reason).to.equal('TildeInValue');
						Expect(facetError(() => { _Validator.validate('Book', 'FBL~Genre~INN~a,b%257e', {}); }).Detail.Reason).to.equal('TildeInValue');
						Expect(facetError(() => { _Validator.validate('Book', 'FBV~Title~EQ~' + 'x'.repeat(1025), {}); }).Detail.Reason).to.equal('ValueTooLong');
						// a %7E decoded ONCE is a separator, exactly as the list sees it
						Expect(facetError(() => { _Validator.validate('Book', 'FBV~Title~EQ~a%7Eb', {}); }).Code).to.equal('FACET_FILTER_INVALID');
					});

				test('values are data: template-looking and quote-laden values pass through untouched',
					() =>
					{
						let tmpValue = '<%= _Params.SR0 %> {-D:Record.Secret-} $CurrentUser.IDUser \' " ; DROP TABLE Book';
						let tmpResult = _Validator.validate('Book', `FBV~Title~EQ~${encodeURIComponent(tmpValue)}`, {});
						Expect(tmpResult.Stanzas[0].Value).to.equal(tmpValue);
					});
			}
		);

		suite
		(
			'FilterAST from meadow-filter strings (SQL precedence, 01 §8.2)',
			() =>
			{
				test('contract fixture 1: A AND B OR C is ONE conjunct Or[And(A,B), C]',
					() =>
					{
						let tmpAST = _AST.build('Book', { FilterString: 'FBV~Title~EQ~1~FBV~Genre~EQ~2~FBVOR~Language~EQ~3' });
						Expect(tmpAST.Conjuncts.length).to.equal(1);
						Expect(tmpAST.Conjuncts[0].Pred).to.deep.equal(
							{
								Or:
									[
										{ And: [ { Field: 'Title', Op: 'EQ', Value: '1' }, { Field: 'Genre', Op: 'EQ', Value: '2' } ] },
										{ Field: 'Language', Op: 'EQ', Value: '3' }
									]
							});
						Expect(tmpAST.Conjuncts[0].Fields).to.deep.equal([ 'Genre', 'Language', 'Title' ]);
						Expect(tmpAST.Conjuncts[0].Id).to.equal('c1');
						Expect(tmpAST.Conjuncts[0].Origin).to.deep.equal({ Kind: 'String', Hash: null, FilterKey: null, ClauseType: null, Index: 0 });
						Expect(tmpAST.Conjuncts[0].Fence).to.equal(true);
						Expect(tmpAST.Conjuncts[0].NeverExclude).to.equal(false);
					});

				test('contract fixture 2: A AND (B OR C) is two conjuncts',
					() =>
					{
						let tmpAST = _AST.build('Book', { FilterString: 'FBV~Title~EQ~1~FOP~0~(~0~FBV~Genre~EQ~2~FBVOR~Language~EQ~3~FCP~0~)~0' });
						Expect(tmpAST.Conjuncts.map((pConjunct) => { return pConjunct.Pred; })).to.deep.equal(
							[
								{ Field: 'Title', Op: 'EQ', Value: '1' },
								{ Or: [ { Field: 'Genre', Op: 'EQ', Value: '2' }, { Field: 'Language', Op: 'EQ', Value: '3' } ] }
							]);
						Expect(tmpAST.Conjuncts.map((pConjunct) => { return pConjunct.Id; })).to.deep.equal([ 'c1', 'c2' ]);
						Expect(tmpAST.Conjuncts[1].Origin.Index).to.equal(1);
						Expect(tmpAST.Conjuncts[1].Fields).to.deep.equal([ 'Genre', 'Language' ]);
					});

				test('AND-only strings: one conjunct per depth-0 term',
					() =>
					{
						let tmpAST = _AST.build('Book', { FilterString: 'FBV~Genre~EQ~Fiction~FBL~Language~INN~English,French~FBV~PublicationYear~GE~1990~FOP~0~(~0~FBV~Title~LK~%25Sea%25~FBV~Type~NE~Ebook~FCP~0~)~0' });
						Expect(tmpAST.Conjuncts.length).to.equal(4);
						Expect(tmpAST.Conjuncts[1].Pred).to.deep.equal({ Field: 'Language', Op: 'IN', Value: [ 'English', 'French' ] });
						Expect(tmpAST.Conjuncts[3].Pred).to.deep.equal({ And: [ { Field: 'Title', Op: 'LK', Value: '%Sea%' }, { Field: 'Type', Op: 'NE', Value: 'Ebook' } ] });
						Expect(tmpAST.Conjuncts.map((pConjunct) => { return pConjunct.Origin.Index; })).to.deep.equal([ 0, 1, 2, 3 ]);
					});

				test('a depth-0 FOPOR group binds everything before it into one conjunct',
					() =>
					{
						let tmpAST = _AST.build('Book', { FilterString: 'FBV~Genre~EQ~Fiction~FOP~0~(~0~FBV~Language~EQ~English~FCP~0~)~0~FOPOR~0~(~0~FBV~PublicationYear~LT~1950~FBV~Type~EQ~Ebook~FCP~0~)~0' });
						Expect(tmpAST.Conjuncts.length).to.equal(1);
						Expect(tmpAST.Conjuncts[0].Pred).to.deep.equal(
							{
								Or:
									[
										{ And: [ { Field: 'Genre', Op: 'EQ', Value: 'Fiction' }, { Field: 'Language', Op: 'EQ', Value: 'English' } ] },
										{ And: [ { Field: 'PublicationYear', Op: 'LT', Value: '1950' }, { Field: 'Type', Op: 'EQ', Value: 'Ebook' } ] }
									]
							});
					});

				test('the first term\'s connector is ignored (FoxHound emits none there)',
					() =>
					{
						let tmpAST = _AST.build('Book', { FilterString: 'FBVOR~Genre~EQ~Fiction~FBV~Language~EQ~English' });
						Expect(tmpAST.Conjuncts.length).to.equal(2);
						tmpAST = _AST.build('Book', { FilterString: 'FOPOR~0~(~0~FBVOR~Genre~EQ~Fiction~FBV~Language~EQ~English~FCP~0~)~0~FBV~Type~EQ~Ebook' });
						Expect(tmpAST.Conjuncts.length).to.equal(2);
						Expect(tmpAST.Conjuncts[0].Pred).to.deep.equal({ And: [ { Field: 'Genre', Op: 'EQ', Value: 'Fiction' }, { Field: 'Language', Op: 'EQ', Value: 'English' } ] });
					});

				test('NULL / NOTNULL / IN / NIN operator mapping (meadow-filter IN means IS NULL)',
					() =>
					{
						let tmpAST = _AST.build('Book', { FilterString: 'FBV~Language~IN~0~FBV~Genre~NN~whatever~FBL~Type~NIN~Ebook~FBV~Title~NLK~A%25' });
						Expect(tmpAST.Conjuncts.map((pConjunct) => { return pConjunct.Pred; })).to.deep.equal(
							[
								{ Field: 'Language', Op: 'NULL' },
								{ Field: 'Genre', Op: 'NOTNULL' },
								{ Field: 'Type', Op: 'NIN', Value: [ 'Ebook' ] },
								{ Field: 'Title', Op: 'NLK', Value: 'A%' }
							]);
					});

				test('Show-deleted (the delete column in a FilterString) sets NamesDeleted / IncludesDeleted',
					() =>
					{
						let tmpAST = _AST.build('Book', { FilterString: 'FBL~Deleted~INN~0,1~FBV~Genre~EQ~Fiction' });
						Expect(tmpAST.Conjuncts[0].NamesDeleted).to.equal(true);
						Expect(tmpAST.Conjuncts[1].NamesDeleted).to.equal(false);
						Expect(tmpAST.IncludesDeleted).to.equal(true);
						Expect(_AST.build('Book', { FilterString: 'FBV~Genre~EQ~Fiction' }).IncludesDeleted).to.equal(false);
					});

				test('build reads only Clauses and FilterString; empty input is an empty AST',
					() =>
					{
						let tmpAST = _AST.build('Book', {});
						// M2 (internal-contracts §23.3): the FilterAST also lists the non-root entities its conjuncts read.
						Expect(tmpAST).to.deep.equal({ Entity: 'Book', Conjuncts: [], IncludesDeleted: false, Applied: [], Warnings: [], Entities: [] });
						Expect(_AST.build('Book', { FilterString: null, Facets: 'ignored', Clauses: [] }).Conjuncts).to.deep.equal([]);
						Expect(facetError(() => { _AST.build('Book', { FilterString: 42 }); }).Code).to.equal('FACET_FILTER_INVALID');
						// fail closed: an unreadable filter input is never an unfiltered answer
						Expect(facetError(() => { _AST.build('Book', { Clauses: { Type: 'RawFilter', Value: 'FBV~Genre~EQ~x' } }); }).Detail.Reason).to.equal('ClausesNotArray');
					});

				test('fieldsOf collects every field, sorted and unique',
					() =>
					{
						Expect(_AST.fieldsOf({ Or: [ { Field: 'b', Op: 'EQ', Value: 1 }, { And: [ { Field: 'a', Op: 'NULL' }, { Field: 'b', Op: 'GT', Value: 2 } ] } ] })).to.deep.equal([ 'a', 'b' ]);
					});
			}
		);

		suite
		(
			'ClauseCompiler (pict clause types, L3)',
			() =>
			{
				test('DistinctSelectedValueList → IN; nulls skipped; numbers coerced; deduplicated; FilterKey defaults to the column',
					() =>
					{
						let tmpResult = _Compiler.compile('Book',
							[
								{ Type: 'DistinctSelectedValueList', FilterByColumn: 'PublicationYear', Values: [ '1999', 2001, null, 1999 ], Hash: 'PublicationYear-DSVL-1' },
								{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Language', Values: [ 'English', '' ], FilterKey: 'Lang' }
							]);
						Expect(tmpResult.Warnings).to.deep.equal([]);
						Expect(tmpResult.Conjuncts[0].Pred).to.deep.equal({ Field: 'PublicationYear', Op: 'IN', Value: [ 1999, 2001 ] });
						Expect(tmpResult.Conjuncts[0].Origin).to.deep.equal({ Kind: 'Clause', Hash: 'PublicationYear-DSVL-1', FilterKey: 'PublicationYear', ClauseType: 'DistinctSelectedValueList', Index: 0 });
						Expect(tmpResult.Conjuncts[1].Pred).to.deep.equal({ Field: 'Language', Op: 'IN', Value: [ 'English', '' ] });
						Expect(tmpResult.Conjuncts[1].Origin.FilterKey).to.equal('Lang');
					});

				test('DistinctSelectedValueList on several columns → Or of IN, no default FilterKey',
					() =>
					{
						let tmpResult = _Compiler.compile('Book', [ { Type: 'DistinctSelectedValueList', FilterByColumns: [ 'Genre', 'Type' ], Values: [ 'Fiction' ] } ]);
						Expect(tmpResult.Conjuncts[0].Pred).to.deep.equal({ Or: [ { Field: 'Genre', Op: 'IN', Value: [ 'Fiction' ] }, { Field: 'Type', Op: 'IN', Value: [ 'Fiction' ] } ] });
						Expect(tmpResult.Conjuncts[0].Origin.FilterKey).to.equal(null);
						Expect(tmpResult.Conjuncts[0].Fields).to.deep.equal([ 'Genre', 'Type' ]);
					});

				test('empty clauses are ignored with FACET_CLAUSE_EMPTY',
					() =>
					{
						let tmpResult = _Compiler.compile('Book',
							[
								{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre', Values: [ null ], Hash: 'h0' },
								{ Type: 'NumericRange', FilterByColumn: 'PublicationYear', Values: { Start: null, End: '' }, Hash: 'h1' },
								{ Type: 'DateRange', FilterByColumn: 'CreateDate', Values: { Start: '0', End: 0 }, Hash: 'h2' },
								{ Type: 'StringMatch', FilterByColumn: 'Title', Values: [], Hash: 'h3' },
								{ Type: 'RawFilter', Value: '', Hash: 'h4' },
								{ Type: 'RawFilter', Value: 'FSF~Title~ASC~0', Hash: 'h5' }
							]);
						Expect(tmpResult.Conjuncts).to.deep.equal([]);
						Expect(tmpResult.Warnings.filter((pWarning) => { return pWarning.Code === 'FACET_CLAUSE_EMPTY'; }).map((pWarning) => { return pWarning.Detail.Hash; })).to.deep.equal([ 'h0', 'h1', 'h2', 'h3', 'h4', 'h5' ]);
						Expect(tmpResult.Warnings.filter((pWarning) => { return pWarning.Code === 'FACET_SORT_IGNORED'; }).length).to.equal(1);
					});

				test('DateRange → canonical bounds; StartExclusive / EndExclusive; one bound alone',
					() =>
					{
						let tmpResult = _Compiler.compile('BookStoreSale',
							[
								{ Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { Start: '2025-01-01', End: '2025-07-01T00:00:00Z' }, EndExclusive: true },
								{ Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { Start: '2025-01-01 10:00' }, StartExclusive: true },
								{ Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { End: '2026-01-01' } }
							]);
						// A midnight GE / LT bound binds date-only (it sorts before every same-day text form, so
						// the comparison agrees with canonical bucketing); GT / LE keep the canonical value.
						Expect(tmpResult.Conjuncts[0].Pred).to.deep.equal({ And: [ { Field: 'SaleDate', Op: 'GE', Value: '2025-01-01' }, { Field: 'SaleDate', Op: 'LT', Value: '2025-07-01' } ] });
						Expect(tmpResult.Conjuncts[1].Pred).to.deep.equal({ Field: 'SaleDate', Op: 'GT', Value: '2025-01-01 10:00:00' });
						Expect(tmpResult.Conjuncts[2].Pred).to.deep.equal({ Field: 'SaleDate', Op: 'LE', Value: '2026-01-01 00:00:00' });
						Expect(_Compiler.compile('BookStoreSale', [ { Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { Start: '2025-01-01 10:00' } } ]).Conjuncts[0].Pred)
							.to.deep.equal({ Field: 'SaleDate', Op: 'GE', Value: '2025-01-01 10:00:00' });
						Expect(facetError(() => { _Compiler.compile('BookStoreSale', [ { Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { Start: 'yesterday' } } ]); }).Detail.Reason).to.equal('InvalidDateTime');
					});

				test('NumericRange: numeric 0 IS a bound (deviation from pict); decimals coerced; several columns ANDed',
					() =>
					{
						let tmpResult = _Compiler.compile('BookStoreSale',
							[
								{ Type: 'NumericRange', FilterByColumn: 'TotalAmount', Values: { Start: 0, End: '8.40' }, EndExclusive: true },
								{ Type: 'NumericRange', FilterByColumns: [ 'TotalAmount', 'IDBookStore' ], Values: { Start: 1 } }
							]);
						Expect(tmpResult.Conjuncts[0].Pred).to.deep.equal({ And: [ { Field: 'TotalAmount', Op: 'GE', Value: 0 }, { Field: 'TotalAmount', Op: 'LT', Value: 8.4 } ] });
						Expect(tmpResult.Conjuncts[1].Pred).to.deep.equal({ And: [ { Field: 'TotalAmount', Op: 'GE', Value: 1 }, { Field: 'IDBookStore', Op: 'GE', Value: 1 } ] });
						Expect(facetError(() => { _Compiler.compile('BookStoreSale', [ { Type: 'NumericRange', FilterByColumn: 'TotalAmount', Values: { Start: 'ten' } } ]); }).Detail.Reason).to.equal('InvalidNumber');
						Expect(facetError(() => { _Compiler.compile('BookStoreSale', [ { Type: 'NumericRange', FilterByColumn: 'TotalAmount', Values: [ 1, 2 ] } ]); }).Detail.Reason).to.equal('RangeValuesNotObject');
					});

				test('NumericRange on an INTEGER column binds integer-equivalent bounds (GE / LT ceil, GT / LE floor); decimals keep theirs',
					() =>
					{
						let tmpResult = _Compiler.compile('Book',
							[
								{ Type: 'NumericRange', FilterByColumn: 'PublicationYear', Values: { Start: 1999.5, End: 2010.2 }, EndExclusive: true },
								{ Type: 'NumericRange', FilterByColumn: 'PublicationYear', Values: { Start: '1999.5', End: 2010.2 }, StartExclusive: true },
								{ Type: 'NumericRange', FilterByColumn: 'PublicationYear', Values: { Start: -0.5, End: 2000 } }
							]);
						Expect(tmpResult.Conjuncts[0].Pred).to.deep.equal({ And: [ { Field: 'PublicationYear', Op: 'GE', Value: 2000 }, { Field: 'PublicationYear', Op: 'LT', Value: 2011 } ] });
						Expect(tmpResult.Conjuncts[1].Pred).to.deep.equal({ And: [ { Field: 'PublicationYear', Op: 'GT', Value: 1999 }, { Field: 'PublicationYear', Op: 'LE', Value: 2010 } ] });
						Expect(tmpResult.Conjuncts[2].Pred).to.deep.equal({ And: [ { Field: 'PublicationYear', Op: 'GE', Value: 0 }, { Field: 'PublicationYear', Op: 'LE', Value: 2000 } ] });
						let tmpDecimal = _Compiler.compile('BookStoreSale', [ { Type: 'NumericRange', FilterByColumn: 'TotalAmount', Values: { Start: 0.5, End: 2.25 } } ]);
						Expect(tmpDecimal.Conjuncts[0].Pred).to.deep.equal({ And: [ { Field: 'TotalAmount', Op: 'GE', Value: 0.5 }, { Field: 'TotalAmount', Op: 'LE', Value: 2.25 } ] });
					});

				test('Match family: LK %v% by default, EQ when ExactMatch (or Numeric/DateMatch by default)',
					() =>
					{
						let tmpResult = _Compiler.compile('Book',
							[
								{ Type: 'StringMatch', FilterByColumn: 'Title', Values: [ 'Sea', 'Glass' ] },
								{ Type: 'StringMatch', FilterByColumn: 'Title', Value: 'The Sea', ExactMatch: true },
								{ Type: 'NumericMatch', FilterByColumn: 'PublicationYear', Values: [ '2001' ] },
								{ Type: 'NumericMatch', FilterByColumn: 'PublicationYear', Values: [ 20 ], ExactMatch: false },
								{ Type: 'Match', FilterByColumn: 'Genre', Value: 0 }
							]);
						Expect(tmpResult.Conjuncts[0].Pred).to.deep.equal({ Or: [ { Field: 'Title', Op: 'LK', Value: '%Sea%' }, { Field: 'Title', Op: 'LK', Value: '%Glass%' } ] });
						Expect(tmpResult.Conjuncts[1].Pred).to.deep.equal({ Field: 'Title', Op: 'EQ', Value: 'The Sea' });
						Expect(tmpResult.Conjuncts[2].Pred).to.deep.equal({ Field: 'PublicationYear', Op: 'EQ', Value: 2001 });
						Expect(tmpResult.Conjuncts[3].Pred).to.deep.equal({ Field: 'PublicationYear', Op: 'LK', Value: '%20%' });
						Expect(tmpResult.Conjuncts[4].Pred).to.deep.equal({ Field: 'Genre', Op: 'LK', Value: '%0%' });
					});

				test('RawFilter: the FilterString path, ONE NeverExclude conjunct, may name the delete column',
					() =>
					{
						let tmpResult = _Compiler.compile('Book',
							[
								{ Type: 'RawFilter', Value: 'FBV~Genre~EQ~Fiction~FBV~Language~EQ~English', Hash: 'raw-1', FilterKey: 'Genre' },
								{ Type: 'RawFilter', Filter: 'FBL~Deleted~INN~0,1' }
							]);
						Expect(tmpResult.Conjuncts.length).to.equal(2);
						Expect(tmpResult.Conjuncts[0].Pred).to.deep.equal({ And: [ { Field: 'Genre', Op: 'EQ', Value: 'Fiction' }, { Field: 'Language', Op: 'EQ', Value: 'English' } ] });
						Expect(tmpResult.Conjuncts[0].NeverExclude).to.equal(true);
						Expect(tmpResult.Conjuncts[0].Origin).to.deep.equal({ Kind: 'RawFilter', Hash: 'raw-1', FilterKey: 'Genre', ClauseType: 'RawFilter', Index: 0 });
						Expect(tmpResult.Conjuncts[1].NamesDeleted).to.equal(true);
						// an invalid RawFilter fails closed, naming the clause
						let tmpError = facetError(() => { _Compiler.compile('Book', [ { Type: 'RawFilter', Value: 'FBJV~Title.x~EQ~1' } ]); });
						Expect(tmpError.Code).to.equal('FACET_FILTER_INVALID');
						Expect(tmpError.Detail.ClauseIndex).to.equal(0);
					});

				test('unsupported clause types fail closed; NamedScope is FACET_UNKNOWN_SCOPE',
					() =>
					{
						[ 'FacetSelection', 'None', 'Bogus' ].forEach(
							(pType) =>
							{
								let tmpError = facetError(() => { _Compiler.compile('Book', [ { Type: pType, FilterByColumn: 'Genre', Values: [ 'x' ] } ]); });
								Expect(tmpError.Code, pType).to.equal('FACET_FILTER_INVALID');
								Expect(tmpError.Detail.ClauseType).to.equal(pType);
								Expect(tmpError.Detail.Reason).to.equal('UnsupportedClauseType');
							});
						// M2 (internal-contracts §23.4): join clauses compile, but only along a declared graph edge.
						[ 'InternalJoinSelectedValueList', 'ExternalJoinMatch' ].forEach(
							(pType) =>
							{
								let tmpError = facetError(() => { _Compiler.compile('Book', [ { Type: pType, FilterByColumn: 'Genre', Values: [ 'x' ] } ]); });
								Expect(tmpError.Code, pType).to.equal('FACET_FILTER_INVALID');
								Expect(tmpError.Detail.ClauseType).to.equal(pType);
								Expect(tmpError.Detail.Reason).to.equal('UndeclaredJoin');
							});
						Expect(facetError(() => { _Compiler.compile('Book', [ { Type: 'NamedScope', Scope: 'Book.Mine' } ]); }).Code).to.equal('FACET_UNKNOWN_SCOPE');
						Expect(facetError(() => { _Compiler.compile('Book', [ 'FBV~Genre~EQ~x' ]); }).Detail.Reason).to.equal('MalformedClause');
					});

				test('clause columns are whitelisted; the delete column is refused in clauses',
					() =>
					{
						Expect(facetError(() => { _Compiler.compile('User', [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Password', Values: [ 'x' ] } ]); }).Code).to.equal('FACET_UNKNOWN_FIELD');
						Expect(facetError(() => { _Compiler.compile('Book', [ { Type: 'DistinctSelectedValueList', FilterByColumns: [ 'Genre', 'Nope' ], Values: [ 'x' ] } ]); }).Detail.Field).to.equal('Nope');
						Expect(facetError(() => { _Compiler.compile('Book', [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre;--', Values: [ 'x' ] } ]); }).Code).to.equal('FACET_UNKNOWN_FIELD');
						Expect(facetError(() => { _Compiler.compile('Book', [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Deleted', Values: [ 1 ] } ]); }).Detail.Reason).to.equal('DeleteColumnNotAllowed');
						// pict's fallback column is 'Name' — still whitelisted (Book has none)
						Expect(facetError(() => { _Compiler.compile('Book', [ { Type: 'StringMatch', Values: [ 'x' ] } ]); }).Detail.Field).to.equal('Name');
						Expect(_Compiler.compile('Author', [ { Type: 'StringMatch', Values: [ 'x' ] } ]).Conjuncts[0].Pred).to.deep.equal({ Field: 'Name', Op: 'LK', Value: '%x%' });
					});

				test('values are data: "~" (or %7E) rejected, non-scalars rejected, templates untouched',
					() =>
					{
						Expect(facetError(() => { _Compiler.compile('Book', [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre', Values: [ 'a~b' ] } ]); }).Detail.Reason).to.equal('TildeInValue');
						Expect(facetError(() => { _Compiler.compile('Book', [ { Type: 'StringMatch', FilterByColumn: 'Title', Values: [ 'a%7eb' ] } ]); }).Detail.Reason).to.equal('TildeInValue');
						Expect(facetError(() => { _Compiler.compile('Book', [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre', Values: [ { $gt: 1 } ] } ]); }).Detail.Reason).to.equal('NonScalarValue');
						let tmpResult = _Compiler.compile('Book', [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre', Values: [ '{~D:AppData.Secret~}'.replace(/~/g, '-'), '$CurrentUser.IDUser' ] } ]);
						Expect(tmpResult.Conjuncts[0].Pred.Value).to.deep.equal([ '{-D:AppData.Secret-}', '$CurrentUser.IDUser' ]);
					});

				test('Enabled:false clauses are skipped (pict skips them)',
					() =>
					{
						let tmpResult = _Compiler.compile('Book', [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre', Values: [ 'x' ], Enabled: false }, { Type: 'Bogus', Enabled: false } ]);
						Expect(tmpResult.Conjuncts).to.deep.equal([]);
						Expect(tmpResult.Warnings).to.deep.equal([]);
					});

				test('GUIDGroup + Junction OR → ONE conjunct (first clause\'s Hash, union of fields); AND groups stay separate',
					() =>
					{
						let tmpResult = _Compiler.compile('Book',
							[
								{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Type', Values: [ 'Ebook' ], Hash: 'solo' },
								{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre', Values: [ 'Fiction' ], GUIDGroup: 'g1', Hash: 'g1-a' },
								{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Language', Values: [ 'French' ], GUIDGroup: 'g1', Junction: 'OR', Hash: 'g1-b' },
								{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre', Values: [ 'Poetry' ], GUIDGroup: 'g2', Hash: 'g2-a' },
								{ Type: 'NumericRange', FilterByColumn: 'PublicationYear', Values: { Start: 1990 }, GUIDGroup: 'g2', Hash: 'g2-b' }
							]);
						Expect(tmpResult.Conjuncts.length).to.equal(4);
						Expect(tmpResult.Conjuncts[0].Origin.Hash).to.equal('solo');
						Expect(tmpResult.Conjuncts[1].Pred).to.deep.equal({ Or: [ { Field: 'Genre', Op: 'IN', Value: [ 'Fiction' ] }, { Field: 'Language', Op: 'IN', Value: [ 'French' ] } ] });
						Expect(tmpResult.Conjuncts[1].Origin.Hash).to.equal('g1-a');
						Expect(tmpResult.Conjuncts[1].Origin.Hashes).to.deep.equal([ 'g1-a', 'g1-b' ]);
						Expect(tmpResult.Conjuncts[1].Origin.FilterKey).to.equal(null);
						Expect(tmpResult.Conjuncts[1].Fields).to.deep.equal([ 'Genre', 'Language' ]);
						Expect(tmpResult.Conjuncts[2].Origin.Hash).to.equal('g2-a');
						Expect(tmpResult.Conjuncts[3].Origin.Hash).to.equal('g2-b');
					});

				test('a top-level clause with Junction OR binds the clause units into ONE conjunct (pict FOPOR semantics), the RawFilter included',
					() =>
					{
						// pict's string: FBV~Type~EQ~Ebook~FOP(Genre)~FOP(Language)~FOPOR(Genre) — the RawFilter
						// stanzas come first, unwrapped, so SQL precedence binds them into the OR's first branch.
						let tmpResult = _Compiler.compile('Book',
							[
								{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre', Values: [ 'Fiction' ], Hash: 'a' },
								{ Type: 'RawFilter', Value: 'FBV~Type~EQ~Ebook', Hash: 'raw' },
								{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Language', Values: [ 'French' ], Hash: 'b' },
								{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre', Values: [ 'Poetry' ], Junction: 'OR', Hash: 'c' }
							]);
						Expect(tmpResult.Conjuncts.length).to.equal(1);
						Expect(tmpResult.Conjuncts[0].Pred).to.deep.equal(
							{
								Or:
									[
										{ And: [ { Field: 'Type', Op: 'EQ', Value: 'Ebook' }, { Field: 'Genre', Op: 'IN', Value: [ 'Fiction' ] }, { Field: 'Language', Op: 'IN', Value: [ 'French' ] } ] },
										{ Field: 'Genre', Op: 'IN', Value: [ 'Poetry' ] }
									]
							});
						// Members are listed in clause array order (envelope Filter.Applied).
						Expect(tmpResult.Conjuncts[0].Origin.Hashes).to.deep.equal([ 'a', 'raw', 'b', 'c' ]);
						Expect(tmpResult.Conjuncts[0].Origin.Kinds).to.deep.equal([ 'Clause', 'RawFilter', 'Clause', 'Clause' ]);
						// It holds a RawFilter: never excluded.
						Expect(tmpResult.Conjuncts[0].NeverExclude).to.equal(true);
						// Without any OR, the RawFilter stays its own (NeverExclude) conjunct.
						let tmpApart = _Compiler.compile('Book',
							[
								{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre', Values: [ 'Fiction' ], Hash: 'a' },
								{ Type: 'RawFilter', Value: 'FBV~Type~EQ~Ebook', Hash: 'raw' }
							]);
						Expect(tmpApart.Conjuncts.map((pConjunct) => { return pConjunct.Origin.Kind; })).to.deep.equal([ 'Clause', 'RawFilter' ]);
					});

				test('coerceValue by DataType',
					() =>
					{
						let fColumn = (pDataType) => { return { Column: 'X', DataType: pDataType }; };
						Expect(_Compiler.coerceValue(fColumn('Numeric'), ' 42 ')).to.equal(42);
						Expect(_Compiler.coerceValue(fColumn('Decimal'), '-1.25')).to.equal(-1.25);
						Expect(_Compiler.coerceValue(fColumn('ForeignKey'), 7)).to.equal(7);
						Expect(_Compiler.coerceValue(fColumn('ID'), '1e3')).to.equal(1000);
						Expect(facetError(() => { _Compiler.coerceValue(fColumn('Numeric'), true); }).Detail.Reason).to.equal('InvalidNumber');
						Expect(facetError(() => { _Compiler.coerceValue(fColumn('Numeric'), ''); }).Detail.Reason).to.equal('InvalidNumber');
						Expect(facetError(() => { _Compiler.coerceValue(fColumn('Numeric'), '0x10'); }).Detail.Reason).to.equal('InvalidNumber');
						Expect([ true, 'true', 1, '1' ].map((pValue) => { return _Compiler.coerceValue(fColumn('Boolean'), pValue); })).to.deep.equal([ 1, 1, 1, 1 ]);
						Expect([ false, 'false', 0, '0' ].map((pValue) => { return _Compiler.coerceValue(fColumn('Boolean'), pValue); })).to.deep.equal([ 0, 0, 0, 0 ]);
						Expect(facetError(() => { _Compiler.coerceValue(fColumn('Boolean'), 'yes'); }).Detail.Reason).to.equal('InvalidBoolean');
						Expect(_Compiler.coerceValue(fColumn('DateTime'), '2026-03-02T04:05:06.789Z')).to.equal('2026-03-02 04:05:06');
						Expect(facetError(() => { _Compiler.coerceValue(fColumn('DateTime'), 1700000000); }).Detail.Reason).to.equal('InvalidDateTime');
						Expect(_Compiler.coerceValue(fColumn('String'), 12)).to.equal('12');
						Expect(_Compiler.coerceValue(fColumn('Text'), false)).to.equal('false');
						Expect(facetError(() => { _Compiler.coerceValue(fColumn('String'), null); }).Detail.Reason).to.equal('NonScalarValue');
					});
			}
		);

		suite
		(
			'FilterAST.build — clauses then string, Ids, Applied, Warnings',
			() =>
			{
				test('conjunct order, Ids, Applied entries and deduplicated warnings',
					() =>
					{
						let tmpAST = _AST.build('BookStoreSale',
							{
								Clauses:
									[
										{ Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Credit', 'Cash' ], Hash: 'PaymentMethod-DistinctSelectedValueList-3b1f' },
										{ Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [], Hash: 'empty' },
										{ Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { Start: '2025-01-01', End: '2025-07-01' }, EndExclusive: true },
										{ Type: 'RawFilter', Value: 'FBV~TotalAmount~GE~1~FSF~SaleDate~ASC~0', Hash: 'raw' }
									],
								FilterString: 'FBV~IDBookStore~EQ~2~FBV~TotalAmount~LT~100~FSF~TotalAmount~DESC~0'
							});
						Expect(tmpAST.Conjuncts.map((pConjunct) => { return pConjunct.Id; })).to.deep.equal([ 'c1', 'c2', 'c3', 'c4', 'c5' ]);
						Expect(tmpAST.Conjuncts.map((pConjunct) => { return pConjunct.Origin.Kind; })).to.deep.equal([ 'Clause', 'Clause', 'RawFilter', 'String', 'String' ]);
						Expect(tmpAST.Applied).to.deep.equal([ { Hash: 'PaymentMethod-DistinctSelectedValueList-3b1f' }, { Hash: null, Index: 2 }, { RawFilter: 'raw' }, { String: true } ]);
						Expect(tmpAST.Warnings).to.deep.equal(
							[
								{ Code: 'FACET_CLAUSE_EMPTY', Detail: { Index: 1, Hash: 'empty', ClauseType: 'DistinctSelectedValueList' } },
								{ Code: 'FACET_SORT_IGNORED', Detail: 'FSF stanzas do not affect facets.' }
							]);
						Expect(tmpAST.IncludesDeleted).to.equal(false);
					});
			}
		);

		suite
		(
			'Rendering: applyToQuery (SQLite execution vs three oracles) and toFilterString',
			() =>
			{
				let _OracleFable = null;
				let _OracleRows = null;
				let _DAL = {};
				let _Model = null;

				suiteSetup(
					(fDone) =>
					{
						_Model = bookstoreModel();
						_OracleFable = new libFable({ Product: 'RetoldFacetingFilterASTOracle', SQLite: { SQLiteFilePath: ':memory:' }, LogStreams: [ { streamtype: 'console', level: 'fatal' } ] });
						_OracleFable.serviceManager.addServiceType('MeadowSQLiteProvider', libMeadowConnectionSQLite);
						_OracleFable.serviceManager.instantiateServiceProvider('MeadowSQLiteProvider');
						_OracleFable.MeadowSQLiteProvider.connectAsync(
							(pError) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								_OracleRows = seedOracleDatabase(_OracleFable.MeadowSQLiteProvider.db, _Model);
								let tmpMeadow = libMeadow.new(_OracleFable);
								[ 'Book', 'BookStoreSale' ].forEach(
									(pEntity) =>
									{
										_DAL[pEntity] = tmpMeadow.loadFromPackageObject(_Model.Tables[pEntity].MeadowSchema);
										_DAL[pEntity].setProvider('SQLite');
									});
								return fDone();
							});
					});

				suiteTeardown(
					() =>
					{
						if (_OracleFable && _OracleFable.MeadowSQLiteProvider && _OracleFable.MeadowSQLiteProvider.db)
						{
							_OracleFable.MeadowSQLiteProvider.db.close();
						}
					});

				/**
				 * Read the IDs a fenced filter selects through the real DAL (FoxHound adds the
				 * implicit Deleted = 0 unless a filter names the delete column, exactly as the list).
				 */
				let fReadIDs = (pEntity, fFilter, fCallback) =>
				{
					let tmpQuery = _DAL[pEntity].query;
					tmpQuery.addFilter('', '', '(', 'AND', 'FacetFenceOpen');
					fFilter(tmpQuery);
					tmpQuery.addFilter('', '', ')', 'AND', 'FacetFenceClose');
					_DAL[pEntity].doReads(tmpQuery,
						(pError, pQuery, pRecords) =>
						{
							if (pError)
							{
								return fCallback(new Error(`${pError} :: ${pQuery && pQuery.query && pQuery.query.body}`));
							}
							return fCallback(null, pRecords.map((pRecord) => { return pRecord['ID' + pEntity]; }).sort((pA, pB) => { return pA - pB; }));
						});
				};

				let fOracleIDs = (pEntity, pAST) =>
				{
					let fNumeric = (pField) =>
					{
						let tmpColumn = _Model.Tables[pEntity].Columns.find((pEntry) => { return pEntry.Column === pField; });
						return NUMERIC_TYPES.indexOf(tmpColumn.DataType) >= 0;
					};
					return _OracleRows[pEntity].filter(
						(pRow) =>
						{
							if (!pAST.IncludesDeleted && (pRow.Deleted !== 0))
							{
								return false;
							}
							return pAST.Conjuncts.every((pConjunct) => { return evaluatePred(pConjunct.Pred, pRow, fNumeric); });
						}).map((pRow) => { return pRow['ID' + pEntity]; });
				};

				/**
				 * Check one request input four (or five) ways.
				 */
				let fCheck = (pEntity, pInput, fDone, pExpectSome) =>
				{
					let tmpAST = _AST.build(pEntity, pInput);
					let tmpExpected = fOracleIDs(pEntity, tmpAST);
					let tmpHasNull = usesNullPredicate(tmpAST.Conjuncts);
					fReadIDs(pEntity, (pQuery) => { _AST.applyToQuery(tmpAST.Conjuncts, pQuery, { Dialect: 'SQLite' }); },
						(pError, pAppliedIDs) =>
						{
							if (pError)
							{
								return fDone(pError);
							}
							Expect(pAppliedIDs, 'applyToQuery vs JS oracle').to.deep.equal(tmpExpected);
							if (pExpectSome !== false)
							{
								Expect(tmpExpected.length, 'fixture selects something').to.be.greaterThan(0);
								Expect(tmpExpected.length, 'fixture does not select everything').to.be.lessThan(_OracleRows[pEntity].length);
							}
							// 5. round trip through toFilterString(Encode) → validator → build
							let tmpRoundTrip = _AST.build(pEntity, { FilterString: _AST.toFilterString(tmpAST.Conjuncts, { Encode: true }) });
							Expect(fOracleIDs(pEntity, tmpRoundTrip), 'toFilterString(Encode) round trip').to.deep.equal(tmpExpected);
							if (tmpHasNull)
							{
								// FH-2: the stock SQLite list cannot render IS NULL; oracles 2 and 3 do not apply.
								return fDone();
							}
							// 3. the harness list oracle: meadow-filter over toFilterString (raw; already fenced)
							fReadIDs(pEntity, (pQuery) => { libMeadowFilter.parse(_AST.toFilterString(tmpAST.Conjuncts), pQuery); },
								(pListError, pListIDs) =>
								{
									if (pListError)
									{
										return fDone(pListError);
									}
									Expect(pListIDs, 'meadow-filter(toFilterString) vs JS oracle').to.deep.equal(tmpExpected);
									if ((typeof(pInput.FilterString) !== 'string') || Array.isArray(pInput.Clauses))
									{
										return fDone();
									}
									// 2. the client string itself through meadow-filter, fenced (decoded once, as meadow-endpoints does)
									fReadIDs(pEntity, (pQuery) => { libMeadowFilter.parse(decodeURIComponent(pInput.FilterString), pQuery); },
										(pRawError, pRawIDs) =>
										{
											if (pRawError)
											{
												return fDone(pRawError);
											}
											Expect(pRawIDs, 'meadow-filter(client string) vs JS oracle').to.deep.equal(tmpExpected);
											return fDone();
										});
								});
						});
				};

				let FILTER_STRINGS = (
					[
						[ 'Book', 'FBV~Language~EQ~English' ],
						[ 'Book', 'FBV~Language~EQ~English~FBVOR~Language~EQ~French' ],
						[ 'Book', 'FBV~Genre~EQ~Fiction~FBV~Language~EQ~English~FBVOR~PublicationYear~GT~2000' ],
						[ 'Book', 'FBV~Genre~EQ~Fiction~FOP~0~(~0~FBV~Language~EQ~English~FBVOR~PublicationYear~GT~2000~FCP~0~)~0' ],
						[ 'Book', 'FOP~0~(~0~FBV~Genre~EQ~Fiction~FBV~Language~EQ~English~FCP~0~)~0~FOPOR~0~(~0~FBV~PublicationYear~LT~1950~FCP~0~)~0' ],
						[ 'Book', 'FBVOR~Genre~EQ~Fiction~FBV~Language~EQ~English' ],
						[ 'Book', 'FBL~Language~INN~English,French~FBV~PublicationYear~GE~1990' ],
						[ 'Book', 'FBL~Genre~NIN~Fiction,Poetry' ],
						[ 'Book', 'FBV~Title~LK~%25the%25' ],
						[ 'Book', 'FBV~Title~NLK~%25Sea%25~FBV~Type~NE~Ebook' ],
						[ 'Book', 'FBV~Title~LK~%2550%25%25' ],
						[ 'Book', 'FBV~Language~NN~0~FBV~Genre~EQ~History' ],
						[ 'Book', 'FBV~PublicationYear~NE~2001~FBVOR~Genre~EQ~Poetry~FBV~Language~EQ~' ],
						[ 'Book', 'FBL~Deleted~INN~0,1~FBV~Genre~EQ~Fiction' ],
						[ 'Book', 'FBV~Deleted~EQ~1' ],
						[ 'Book', 'FBV~Genre~EQ~Fiction~FSF~Title~ASC~0' ],
						[ 'Book', 'FOP~0~(~0~FBV~Genre~EQ~Fiction~FBVOR~Genre~EQ~Poetry~FCP~0~)~0' ],
						[ 'Book', 'FBV~Language~IN~0' ],
						[ 'Book', 'FBV~Language~IN~0~FBVOR~Language~EQ~' ],
						[ 'Book', 'FBV~Genre~EQ~Fiction~FBVOR~Language~IN~0~FBV~PublicationYear~LE~1960' ],
						[ 'BookStoreSale', 'FBV~TotalAmount~GE~50.5~FBV~TotalAmount~LT~120' ],
						[ 'BookStoreSale', 'FBV~SaleDate~GE~2025-01-01 00:00:00~FBV~SaleDate~LT~2025-07-01 00:00:00' ],
						[ 'BookStoreSale', 'FBL~PaymentMethod~INN~Credit,Check~FBVOR~TotalAmount~LT~10' ],
						[ 'BookStoreSale', 'FBV~PaymentMethod~EQ~~FBVOR~SaleDate~IN~0' ]
					]);

				FILTER_STRINGS.forEach(
					(pCase) =>
					{
						test(`${pCase[0]}: ${pCase[1]}`,
							(fDone) =>
							{
								fCheck(pCase[0], { FilterString: pCase[1] }, fDone);
							});
					});

				let CLAUSE_SETS = (
					[
						[ 'Book', 'DSVL with an empty-string value and a null', [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Language', Values: [ 'French', '', null ] } ] ],
						[ 'Book', 'DSVL on a numeric column with string values', [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'PublicationYear', Values: Array.from({ length: 40 }, (pValue, pIndex) => { return String(1960 + pIndex); }) } ] ],
						[ 'Book', 'NumericRange half-open with a zero-free bound', [ { Type: 'NumericRange', FilterByColumn: 'PublicationYear', Values: { Start: 1950, End: 2000 }, EndExclusive: true } ] ],
						[ 'Book', 'StringMatch (LK) on two values', [ { Type: 'StringMatch', FilterByColumn: 'Title', Values: [ 'sea', 'Glass' ] } ] ],
						[ 'Book', 'GUIDGroup OR across fields', [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre', Values: [ 'History' ], GUIDGroup: 'g' }, { Type: 'DistinctSelectedValueList', FilterByColumn: 'Language', Values: [ 'French' ], GUIDGroup: 'g', Junction: 'OR' } ] ],
						[ 'Book', 'RawFilter OR plus a clause', [ { Type: 'RawFilter', Value: 'FBV~Genre~EQ~Fiction~FBVOR~Genre~EQ~Poetry' }, { Type: 'DistinctSelectedValueList', FilterByColumn: 'Language', Values: [ 'English' ] } ] ],
						[ 'Book', 'Show-deleted RawFilter', [ { Type: 'RawFilter', Value: 'FBL~Deleted~INN~0,1' }, { Type: 'DistinctSelectedValueList', FilterByColumn: 'Type', Values: [ 'Ebook' ] } ] ],
						[ 'BookStoreSale', 'DateRange (canonicalized) + DSVL', [ { Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { Start: '2025-03-01', End: '2026-03-01T00:00:00Z' }, EndExclusive: true }, { Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Cash', '' ] } ] ],
						[ 'BookStoreSale', 'NumericRange on a decimal with a 0 start', [ { Type: 'NumericRange', FilterByColumn: 'TotalAmount', Values: { Start: 0, End: '33.30' } } ] ],
						[ 'BookStoreSale', 'multi-column Or of IN inside an And context', [ { Type: 'DistinctSelectedValueList', FilterByColumns: [ 'IDBookStore', 'IDCustomer' ], Values: [ 2 ] }, { Type: 'NumericRange', FilterByColumn: 'TotalAmount', Values: { Start: 20 } } ] ]
					]);

				CLAUSE_SETS.forEach(
					(pCase) =>
					{
						test(`${pCase[0]} clauses: ${pCase[1]}`,
							(fDone) =>
							{
								fCheck(pCase[0], { Clauses: pCase[2] }, fDone);
							});
					});

				test('clauses and a FilterString together (each fenced on its own, all ANDed)',
					(fDone) =>
					{
						fCheck('Book', { Clauses: [ { Type: 'RawFilter', Value: 'FBV~Genre~EQ~Fiction~FBVOR~Genre~EQ~Poetry' } ], FilterString: 'FBV~Language~EQ~English~FBVOR~PublicationYear~LT~1930' }, fDone);
					});

				test('applyToQuery parameter names and fence placement (SQLite)',
					() =>
					{
						let tmpAST = _AST.build('Book', { FilterString: 'FBV~Genre~EQ~Fiction~FBL~Language~INN~English,French~FBV~Type~IN~0' });
						let tmpQuery = _DAL.Book.query;
						tmpQuery.addFilter('', '', '(', 'AND', 'FacetFenceOpen');
						_AST.applyToQuery(tmpAST.Conjuncts.slice(1), tmpQuery, { Dialect: 'SQLite' });
						tmpQuery.addFilter('', '', ')', 'AND', 'FacetFenceClose');
						tmpQuery.setDialect('SQLite').buildReadQuery();
						let tmpSQL = tmpQuery.query.body;
						Expect(tmpSQL).to.contain('WHERE ( `Language` IN ( :c2_Language_w1_0, :c2_Language_w1_1 ) AND `Type` IS :c3_Type_w2 )');
						Expect(tmpQuery.query.parameters.c3_Type_w2).to.equal(null);
						Expect(tmpQuery.query.parameters.c2_Language_w1_1).to.equal('French');
						// the implicit soft-delete term sits OUTSIDE the fence
						Expect(tmpSQL).to.match(/\) AND `Book`\.`Deleted` = :Deleted_w4|\) AND `Deleted` = :Deleted_w4/);
						// ParameterPrefix
						let tmpPrefixed = _DAL.Book.query;
						_AST.applyToQuery(tmpAST.Conjuncts, tmpPrefixed, { Dialect: 'SQLite', ParameterPrefix: 'p' });
						tmpPrefixed.setDialect('SQLite').buildReadQuery();
						Expect(tmpPrefixed.query.parameters).to.have.property('p1_Genre_w0');
						Expect(facetError(() => { _AST.applyToQuery(tmpAST.Conjuncts, _DAL.Book.query, {}); }).Code).to.equal('FACET_INTERNAL');
						Expect(facetError(() => { _AST.applyToQuery(tmpAST.Conjuncts, _DAL.Book.query, { Dialect: 'SQLite', ParameterPrefix: 'x;' }); }).Code).to.equal('FACET_INTERNAL');
					});

				test('applyToQuery never lets FoxHound silently drop a malformed leaf (that would widen the filter)',
					() =>
					{
						let fApply = (pPred) => { return facetError(() => { _AST.applyToQuery([ { Id: 'c1', Pred: pPred } ], _DAL.Book.query, { Dialect: 'SQLite' }); }); };
						Expect(fApply({ Field: 'Genre', Op: 'EQ' }).Code).to.equal('FACET_INTERNAL');
						Expect(fApply({ Field: 'Genre', Op: 'EQ', Value: null }).Code).to.equal('FACET_INTERNAL');
						Expect(fApply({ Field: 'Genre', Op: 'EQ', Value: { a: 1 } }).Code).to.equal('FACET_INTERNAL');
						Expect(fApply({ Field: 'Genre', Op: 'IN', Value: [] }).Code).to.equal('FACET_INTERNAL');
						Expect(fApply({ Field: 'Genre', Op: 'constructor', Value: 'x' }).Code).to.equal('FACET_INTERNAL');
						Expect(fApply({ Field: 'Genre`', Op: 'EQ', Value: 'x' }).Code).to.equal('FACET_INTERNAL');
						Expect(fApply({ Or: [] }).Code).to.equal('FACET_INTERNAL');
						Expect(facetError(() => { _AST.toFilterString([ { Pred: { Field: 'Genre', Op: 'constructor', Value: 'x' } } ]); }).Code).to.equal('FACET_INTERNAL');
						Expect(facetError(() => { _AST.fromStanzas('Book', [ { Instruction: 'FBV', Field: 'Genre', Operator: 'constructor', Value: 'x', Offset: 0 } ], { Kind: 'String' }); }).Code).to.equal('FACET_FILTER_INVALID');
					});

				test('applyToQuery dry-builds on PostgreSQL / MySQL / MSSQL with IS NULL and groups',
					() =>
					{
						let tmpAST = _AST.build('Book', { FilterString: 'FBV~Genre~EQ~Fiction~FBV~Language~EQ~English~FBVOR~Type~IN~0' });
						[ 'PostgreSQL', 'MySQL', 'MSSQL' ].forEach(
							(pDialect) =>
							{
								let tmpQuery = _DAL.Book.query;
								tmpQuery.addFilter('', '', '(', 'AND', 'FacetFenceOpen');
								_AST.applyToQuery(tmpAST.Conjuncts, tmpQuery, { Dialect: pDialect });
								tmpQuery.addFilter('', '', ')', 'AND', 'FacetFenceClose');
								tmpQuery.setDialect(pDialect).buildReadQuery();
								let tmpSQL = tmpQuery.query.body;
								Expect(tmpSQL, pDialect).to.be.a('string');
								Expect(tmpSQL, pDialect).to.match(/IS NULL/);
								Expect(tmpSQL, pDialect).to.match(/WHERE \( \( .*Genre.* AND .*Language.* OR .*Type.* IS NULL \) \)/);
								Expect(tmpSQL, pDialect).to.not.match(/IS :|IS @|IS \$/);
							});
					});

				test('toFilterString: fenced, minimal nesting, raw vs encoded',
					() =>
					{
						let tmpAST = _AST.build('Book',
							{
								Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Language', Values: [ 'English', '' ] }, { Type: 'NumericRange', FilterByColumn: 'PublicationYear', Values: { Start: 1950, End: 2000 } } ],
								FilterString: 'FBV~Title~LK~%2550%25%20Off%25~FBV~Genre~EQ~Fiction~FBVOR~Type~IN~0'
							});
						Expect(_AST.toFilterString([])).to.equal('');
						Expect(_AST.toFilterString(tmpAST.Conjuncts)).to.equal(
							'FOP~0~(~0'
							+ '~FOP~0~(~0~FBV~Language~EQ~English~FBVOR~Language~EQ~~FCP~0~)~0'
							+ '~FOP~0~(~0~FBV~PublicationYear~GE~1950~FBV~PublicationYear~LE~2000~FCP~0~)~0'
							+ '~FOP~0~(~0~FBV~Title~LK~%50% Off%~FBV~Genre~EQ~Fiction~FBVOR~Type~IN~0~FCP~0~)~0'
							+ '~FCP~0~)~0');
						Expect(_AST.toFilterString(tmpAST.Conjuncts, { Encode: true })).to.contain('FBV~Title~LK~%2550%25%20Off%25');
						Expect(_AST.toFilterString(_AST.build('Book', { FilterString: 'FBL~Genre~NIN~a,b~FBV~Language~NN~0' }).Conjuncts)).to.equal('FOP~0~(~0~FBL~Genre~NIN~a,b~FBV~Language~NN~0~FCP~0~)~0');
						// values the list syntax cannot carry
						// A list item holding ',' (FBL splits on it) is written as EQ-Or leaves instead.
						Expect(_AST.toFilterString([ { Pred: { Field: 'Genre', Op: 'IN', Value: [ 'a,b', 'c' ] } } ])).to.equal('FOP~0~(~0~FOP~0~(~0~FBV~Genre~EQ~a,b~FBVOR~Genre~EQ~c~FCP~0~)~0~FCP~0~)~0');
						Expect(facetError(() => { _AST.toFilterString([ { Pred: { Field: 'Genre', Op: 'EQ', Value: 'a~b' } } ]); }).Detail.Reason).to.equal('TildeInValue');
					});
			}
		);

		suite
		(
			'DisjunctivePlanner (01 §8.3, D-05)',
			() =>
			{
				let fAST = () =>
				{
					return _AST.build('BookStoreSale',
						{
							Clauses:
								[
									{ Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Credit' ], Hash: 'PaymentMethod-DSVL-1' },
									{ Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { Start: '2025-01-01', End: '2025-07-01' }, EndExclusive: true, Hash: 'SaleDate-DateRange-7a01' },
									{ Type: 'RawFilter', Value: 'FBV~IDBookStore~GE~1', Hash: 'raw' },
									{ Type: 'NumericRange', FilterByColumn: 'TotalAmount', Values: { Start: 5 }, Hash: 'TotalAmount-NR-1', FilterKey: 'Amount' }
								],
							FilterString: 'FBV~PaymentMethod~EQ~Cash~FBVOR~TotalAmount~GT~100'
						});
				};

				test('v0 is always the full filter; Self facets exclude what they own; equal kept sets share a Variant',
					() =>
					{
						let tmpAST = fAST();
						let tmpPlan = _Planner.variants(tmpAST,
							[
								{ Key: 'ByPayment', OwnedFields: [ 'PaymentMethod' ], FilterKey: 'PaymentMethod', Exclude: 'Self' },
								{ Key: 'ByMonth', OwnedFields: [ 'SaleDate' ], FilterKey: 'SaleDate', Exclude: 'Self' },
								{ Key: 'ByMonthAgain', OwnedFields: [ 'SaleDate' ], FilterKey: 'SaleDate', Exclude: 'Self' },
								{ Key: 'Amounts', OwnedFields: [ 'TotalAmount' ], FilterKey: 'TotalAmount', Exclude: 'None' },
								{ Key: 'ByCustomer', OwnedFields: [ 'IDCustomer' ], FilterKey: 'IDCustomer', Exclude: 'Self' },
								{ Key: '#Total', OwnedFields: [], FilterKey: null, Exclude: 'None' }
							]);
						Expect(Object.keys(tmpPlan.Variants)).to.deep.equal([ 'v0', 'v1', 'v2' ]);
						let tmpV0 = tmpPlan.Variants.v0;
						Expect(tmpV0.Hash).to.equal('c1,c2,c3,c4,c5');
						Expect(tmpV0.ExcludedIds).to.deep.equal([]);
						Expect(tmpV0.Facets).to.deep.equal([ 'Amounts', 'ByCustomer', '#Total' ]);
						Expect(tmpV0.Conjuncts[0]).to.equal(tmpAST.Conjuncts[0]);
						Expect(tmpPlan.Variants.v1.Hash).to.equal('c2,c3,c4,c5');
						Expect(tmpPlan.Variants.v1.Facets).to.deep.equal([ 'ByPayment' ]);
						Expect(tmpPlan.Variants.v2.Hash).to.equal('c1,c3,c4,c5');
						Expect(tmpPlan.Variants.v2.Facets).to.deep.equal([ 'ByMonth', 'ByMonthAgain' ]);
						Expect(tmpPlan.Variants.v2.ExcludedIds).to.deep.equal([ 'c2' ]);
						Expect(tmpPlan.Variants.v2.Entity).to.equal('BookStoreSale');
						// the FilterString's (PaymentMethod OR TotalAmount) conjunct is mixed for ByPayment → Partial
						Expect(tmpPlan.Facets.ByPayment).to.deep.equal({ VariantId: 'v1', Mode: 'Partial', Excluded: [ 'c1' ], ExcludedHashes: [ 'PaymentMethod-DSVL-1' ], KeptMixed: [ 'c5' ], Owned: [ 'c1' ] });
						Expect(tmpPlan.Facets.ByMonth).to.deep.equal({ VariantId: 'v2', Mode: 'Exact', Excluded: [ 'c2' ], ExcludedHashes: [ 'SaleDate-DateRange-7a01' ], KeptMixed: [], Owned: [ 'c2' ] });
						// None: conjunctive, but Owned is still reported (Selected is derived from it); FilterKey 'Amount' ≠ 'TotalAmount' yet Fields ⊆ OwnedFields
						Expect(tmpPlan.Facets.Amounts).to.deep.equal({ VariantId: 'v0', Mode: 'NotApplicable', Excluded: [], ExcludedHashes: [], KeptMixed: [], Owned: [ 'c4' ] });
						// a Self facet that owns nothing shares v0
						Expect(tmpPlan.Facets.ByCustomer.VariantId).to.equal('v0');
						Expect(tmpPlan.Facets.ByCustomer.Mode).to.equal('Exact');
					});

				test('RawFilter (NeverExclude) conjuncts are kept even when owned → Partial',
					() =>
					{
						let tmpPlan = _Planner.variants(fAST(), [ { Key: 'ByStore', OwnedFields: [ 'IDBookStore' ], FilterKey: 'IDBookStore', Exclude: 'Self' } ]);
						Expect(tmpPlan.Facets.ByStore).to.deep.equal({ VariantId: 'v0', Mode: 'Partial', Excluded: [], ExcludedHashes: [], KeptMixed: [ 'c3' ], Owned: [ 'c3' ] });
					});

				test('FilterKey ownership; explicit Exclude arrays by Hash or Id add to ownership',
					() =>
					{
						let tmpPlan = _Planner.variants(fAST(),
							[
								{ Key: 'ByAmountKey', OwnedFields: [ 'IDCustomer' ], FilterKey: 'Amount', Exclude: 'Self' },
								{ Key: 'Explicit', OwnedFields: [ 'PaymentMethod' ], FilterKey: 'PaymentMethod', Exclude: [ 'SaleDate-DateRange-7a01', 'c4' ] },
								{ Key: 'ExplicitString', OwnedFields: [ 'IDUser' ], FilterKey: null, Exclude: [ 'c5' ] }
							]);
						Expect(tmpPlan.Facets.ByAmountKey.Excluded).to.deep.equal([ 'c4' ]);
						Expect(tmpPlan.Facets.Explicit.Excluded).to.deep.equal([ 'c1', 'c2', 'c4' ]);
						Expect(tmpPlan.Facets.Explicit.ExcludedHashes).to.deep.equal([ 'PaymentMethod-DSVL-1', 'SaleDate-DateRange-7a01', 'TotalAmount-NR-1' ]);
						// ExcludedHashes falls back to the conjunct Id when there is no clause Hash
						Expect(tmpPlan.Facets.ExplicitString).to.deep.equal({ VariantId: 'v3', Mode: 'Exact', Excluded: [ 'c5' ], ExcludedHashes: [ 'c5' ], KeptMixed: [], Owned: [ 'c5' ] });
					});

				test('a null Exclude resolves to the per-fold default when a Fold is given; unsupported policies fail',
					() =>
					{
						let tmpPlan = _Planner.variants(fAST(),
							[
								{ Key: 'T', OwnedFields: [ 'PaymentMethod' ], FilterKey: 'PaymentMethod', Exclude: null, Fold: 'Terms' },
								{ Key: 'S', OwnedFields: [ 'PaymentMethod' ], FilterKey: 'PaymentMethod', Exclude: null, Fold: 'Stats' },
								{ Key: 'U', OwnedFields: [ 'PaymentMethod' ], FilterKey: 'PaymentMethod' }
							]);
						Expect(tmpPlan.Facets.T.VariantId).to.equal('v1');
						Expect(tmpPlan.Facets.S.Mode).to.equal('NotApplicable');
						Expect(tmpPlan.Facets.U.Mode).to.equal('NotApplicable');
						Expect(facetError(() => { _Planner.variants(fAST(), [ { Key: 'G', OwnedFields: [], FilterKey: null, Exclude: 'Group:a' } ]); }).Code).to.equal('FACET_FOLD_UNSUPPORTED');
					});

				test('a Pivot owns both axes; IncludesDeleted follows the kept conjuncts; the empty filter has v0 only',
					() =>
					{
						let tmpAST = _AST.build('Book', { FilterString: 'FBL~Deleted~INN~0,1~FBV~Genre~EQ~Fiction~FBV~Language~EQ~English' });
						let tmpPlan = _Planner.variants(tmpAST,
							[
								{ Key: 'GenreByLanguage', OwnedFields: [ 'Genre', 'Language' ], FilterKey: null, Exclude: 'Self' },
								{ Key: 'Pivot', OwnedFields: [ 'Genre', 'Language' ], FilterKey: null, Exclude: 'None' }
							]);
						Expect(tmpPlan.Facets.GenreByLanguage.Excluded).to.deep.equal([ 'c2', 'c3' ]);
						Expect(tmpPlan.Variants.v1.IncludesDeleted).to.equal(true);
						Expect(tmpPlan.Facets.Pivot.Owned).to.deep.equal([ 'c2', 'c3' ]);
						let tmpEmpty = _Planner.variants(_AST.build('Book', {}), [ { Key: 'X', OwnedFields: [ 'Genre' ], FilterKey: 'Genre', Exclude: 'Self' } ]);
						Expect(Object.keys(tmpEmpty.Variants)).to.deep.equal([ 'v0' ]);
						Expect(tmpEmpty.Variants.v0.Hash).to.equal('');
						Expect(tmpEmpty.Facets.X.Mode).to.equal('Exact');
					});

				test('hostile Hash / Key strings cannot reach object prototypes',
					() =>
					{
						let tmpAST = _AST.build('Book', { Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre', Values: [ 'x' ], Hash: 'constructor' } ] });
						let tmpPlan = _Planner.variants(tmpAST, [ { Key: 'A', OwnedFields: [ 'Type' ], FilterKey: null, Exclude: [ 'toString' ] } ]);
						Expect(tmpPlan.Facets.A.Excluded).to.deep.equal([]);
						Expect(facetError(() => { _Planner.variants(tmpAST, [ { Key: '__proto__', OwnedFields: [], FilterKey: null, Exclude: 'None' } ]); }).Code).to.equal('FACET_INTERNAL');
					});
			}
		);

		suite
		(
			'RequestNormalizer (internal-contracts §3, L1)',
			() =>
			{
				test('defaults for a minimal body',
					() =>
					{
						let tmpRequest = _Normalizer.normalize('BookStoreSale', { Facets: [ { Facet: 'BookStoreSale.SaleDate' } ] });
						Expect(tmpRequest).to.deep.equal(
							{
								Entity: 'BookStoreSale',
								Mode: 'Query',
								Clauses: [],
								FilterString: null,
								Scopes: [],
								Params: {},
								Facets:
									[
										{
											Key: 'BookStoreSale.SaleDate', FacetIDs: [ 'BookStoreSale.SaleDate' ], Fold: null, Interval: null, TimeZone: null,
											Top: null, Order: null, Missing: true, Buckets: null, Mode: null, Edges: null, OpenEnded: false, Ranges: null,
											Exclude: null, CountMode: null, Labels: null, Chart: false, EmptyBuckets: true
										}
									],
								Total: true,
								Records: null,
								Cap: null,
								TimeoutMS: 10000,
								// M4 (internal-contracts §44.2): the normalized Freshness.
								Freshness: { Mode: 'Exact', MaxLagMS: 5000, MinSeq: null },
								// M5 (internal-contracts §62.2): the request Engine.
								Engine: 'Auto',
								Warnings: []
							});
					});

				test('a full facet entry; clauses shallow-copied; FilterString kept raw',
					() =>
					{
						let tmpClause = { Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Credit' ], Hash: 'h' };
						let tmpRequest = _Normalizer.normalize('BookStoreSale',
							{
								Clauses: [ tmpClause ],
								FilterString: 'FBV~TotalAmount~GE~10%2E5',
								Facets:
									[
										{ Key: 'ByMonth', Facet: 'BookStoreSale.SaleDate', Fold: 'DateHistogram', Interval: 'month', TimeZone: 'UTC', EmptyBuckets: false, Chart: true },
										{ Key: 'Amounts', Facet: 'BookStoreSale.TotalAmount', Fold: 'NumericHistogram', Edges: [ 0, 10, 50.5 ], OpenEnded: true },
										{ Key: 'Bands', Facet: 'BookStoreSale.TotalAmount', Fold: 'Ranges', Ranges: [ { Key: 'low', To: 10, Label: 'Low' }, { Key: 'high', From: 10 } ] },
										{ Facet: [ 'BookStoreSale.PaymentMethod', 'BookStoreSale.IDBookStore' ], Fold: 'Pivot', Top: 5, Exclude: [ 'h' ], CountMode: 'Rows', Labels: true, Order: 'KeyAsc', Missing: false }
									],
								Total: false,
								TimeoutMS: 99999,
								Freshness: { Mode: 'Bounded' },
								Scopes: [],
								Selections: [],
								Params: {}
							});
						Expect(tmpRequest.Clauses[0]).to.deep.equal(tmpClause);
						Expect(tmpRequest.Clauses[0]).to.not.equal(tmpClause);
						Expect(tmpRequest.FilterString).to.equal('FBV~TotalAmount~GE~10%2E5');
						Expect(tmpRequest.Total).to.equal(false);
						Expect(tmpRequest.TimeoutMS).to.equal(10000);
						// M4 (internal-contracts §44.2): Freshness is normalized and carried, no longer ignored.
						Expect(tmpRequest.Freshness).to.deep.equal({ Mode: 'Bounded', MaxLagMS: 5000, MinSeq: null });
						Expect(tmpRequest.Facets[0]).to.include({ Key: 'ByMonth', Fold: 'DateHistogram', Interval: 'month', TimeZone: 'UTC', EmptyBuckets: false, Chart: true });
						Expect(tmpRequest.Facets[1]).to.include({ Mode: 'Edges', OpenEnded: true });
						Expect(tmpRequest.Facets[1].Edges).to.deep.equal([ 0, 10, 50.5 ]);
						Expect(tmpRequest.Facets[2].Ranges).to.deep.equal([ { Key: 'low', From: null, To: 10, Label: 'Low' }, { Key: 'high', From: 10, To: null, Label: null } ]);
						Expect(tmpRequest.Facets[3]).to.include({ Key: 'BookStoreSale.PaymentMethod|BookStoreSale.IDBookStore', Fold: 'Pivot', Top: 5, CountMode: 'Rows', Labels: true, Order: 'KeyAsc', Missing: false });
						Expect(tmpRequest.Facets[3].FacetIDs).to.deep.equal([ 'BookStoreSale.PaymentMethod', 'BookStoreSale.IDBookStore' ]);
						Expect(tmpRequest.Facets[3].Exclude).to.deep.equal([ 'h' ]);
						Expect(_Normalizer.normalize('Book', { FilterString: '', Facets: [ { Facet: 'Book.Genre' } ] }).FilterString).to.equal(null);
					});

				test('Top is clamped silently with a FACET_TOP_CLAMPED warning; invalid Top is refused',
					() =>
					{
						let tmpRequest = _Normalizer.normalize('Book', { Facets: [ { Key: 'G', Facet: 'Book.Genre', Top: 100000 } ] });
						Expect(tmpRequest.Facets[0].Top).to.equal(500);
						Expect(tmpRequest.Warnings).to.deep.equal([ { Code: 'FACET_TOP_CLAMPED', Detail: { Key: 'G', Requested: 100000, Applied: 500 } } ]);
						[ 0, -1, 2.5, '20' ].forEach(
							(pTop) =>
							{
								Expect(facetError(() => { _Normalizer.normalize('Book', { Facets: [ { Facet: 'Book.Genre', Top: pTop } ] }); }).Code).to.equal('FACET_REQUEST_INVALID');
							});
					});

				test('Facet / Fold / Key shape rules',
					() =>
					{
						let fCode = (pFacets) => { return facetError(() => { _Normalizer.normalize('Book', { Facets: pFacets }); }).Code; };
						Expect(fCode([ { Facet: [ 'Book.Genre', 'Book.Language' ] } ])).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode([ { Facet: [ 'Book.Genre' ], Fold: 'Pivot' } ])).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode([ { Facet: 'Book.Genre', Fold: 'Pivot' } ])).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode([ { Facet: 'Book.Genre', Fold: 'Terms; DROP' } ])).to.equal('FACET_UNKNOWN_FOLD');
						Expect(fCode([ { Facet: 'Book.Genre', Fold: 'Cardinality' } ])).to.equal('FACET_UNKNOWN_FOLD');
						Expect(fCode([ { Facet: 'Book.Genre', Fold: 'PathTerms' } ])).to.equal('FACET_FOLD_UNSUPPORTED');
						Expect(fCode([ { Facet: 'Book.Genre', Fold: 7 } ])).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode([ { Facet: 'Book' } ])).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode([ { Facet: 'Book.Gen re' } ])).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode([ {} ])).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode([ 'Book.Genre' ])).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode([ { Facet: 'Book.Genre' }, { Facet: 'Book.Genre' } ])).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode([ { Facet: 'Book.Genre', Key: '#Total' } ])).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode([ { Facet: 'Book.Genre', Key: '#Mine' } ])).to.equal('FACET_REQUEST_INVALID');
						// server-only guard: '__proto__' would vanish from every plain-object map downstream
						Expect(fCode([ { Facet: 'Book.Genre', Key: '__proto__' } ])).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode([ { Facet: 'Book.Genre', Key: '' } ])).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode([ { Facet: 'Book.Genre', Interval: 'fortnight' } ])).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode([ { Facet: 'Book.Genre', Order: 'Random' } ])).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode([ { Facet: 'Book.Genre', Missing: 'yes' } ])).to.equal('FACET_REQUEST_INVALID');
						// well-formed but unknown FacetIDs and path / declared syntax pass (per-facet errors later)
						let tmpRequest = _Normalizer.normalize('Book', { Facets: [ { Facet: 'Book.NoSuchColumn' }, { Facet: 'Review.IDBook>Book.Genre' }, { Facet: 'Book.ByAuthor/Top' } ] });
						Expect(tmpRequest.Facets.map((pFacet) => { return pFacet.Key; })).to.deep.equal([ 'Book.NoSuchColumn', 'Review.IDBook>Book.Genre', 'Book.ByAuthor/Top' ]);
					});

				test('numeric histogram and range options',
					() =>
					{
						let fCode = (pFacet) => { return facetError(() => { _Normalizer.normalize('Book', { Facets: [ Object.assign({ Facet: 'Book.PublicationYear' }, pFacet) ] }); }); };
						Expect(fCode({ Mode: 'Log' }).Code).to.equal('FACET_FOLD_UNSUPPORTED');
						Expect(fCode({ Mode: 'Log' }).Detail).to.include({ Feature: 'LogMode', Milestone: 2 });
						Expect(fCode({ Mode: 'Edges' }).Code).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode({ Mode: 'Nice', Edges: [ 1, 2 ] }).Code).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode({ Mode: 'Wavy' }).Code).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode({ Edges: [ 1 ] }).Code).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode({ Edges: [ 1, 1 ] }).Code).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode({ Edges: [ 2, 1 ] }).Code).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode({ Edges: [ 1, '2' ] }).Code).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode({ Buckets: 0 }).Code).to.equal('FACET_REQUEST_INVALID');
						let tmpClamped = _Normalizer.normalize('Book', { Facets: [ { Key: 'Y', Facet: 'Book.PublicationYear', Buckets: 501 } ] });
						Expect(tmpClamped.Facets[0].Buckets).to.equal(500);
						Expect(tmpClamped.Warnings).to.deep.equal([ { Code: 'FACET_BUCKETS_CLAMPED', Detail: { Key: 'Y', Requested: 501, Applied: 500 } } ]);
						Expect(fCode({ Ranges: [] }).Code).to.equal('FACET_REQUEST_INVALID');
						// an unbounded range is a catch-all for non-null values (both bounds null)
						Expect(_Normalizer.normalize('Book', { Facets: [ { Facet: 'Book.PublicationYear', Ranges: [ { Key: 'all' } ] } ] }).Facets[0].Ranges).to.deep.equal([ { Key: 'all', From: null, To: null, Label: null } ]);
						Expect(fCode({ Ranges: [ { Key: 'a', From: 5, To: 5 } ] }).Code).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode({ Ranges: [ { Key: 'a', To: 5 }, { Key: 'a', From: 5 } ] }).Code).to.equal('FACET_REQUEST_INVALID');
						Expect(fCode({ Ranges: [ { Key: 'a', To: 5, Label: 3 } ] }).Code).to.equal('FACET_REQUEST_INVALID');
						Expect(_Normalizer.normalize('Book', { Facets: [ { Facet: 'Book.PublicationYear', Buckets: 500, Mode: 'Nice' } ] }).Facets[0]).to.include({ Buckets: 500, Mode: 'Nice' });
					});

				test('Exclude / CountMode / TimeZone / Definition',
					() =>
					{
						let fError = (pFacet) => { return facetError(() => { _Normalizer.normalize('Book', { Facets: [ Object.assign({ Facet: 'Book.Genre' }, pFacet) ] }); }); };
						Expect(fError({ Exclude: 'Group:Cascade' }).Code).to.equal('FACET_FOLD_UNSUPPORTED');
						Expect(fError({ Exclude: 'Group:Cascade' }).Status).to.equal(422);
						Expect(fError({ Exclude: 'Everything' }).Code).to.equal('FACET_REQUEST_INVALID');
						Expect(fError({ Exclude: [ 'h', 3 ] }).Code).to.equal('FACET_REQUEST_INVALID');
						Expect(fError({ CountMode: 'PivotDistinct' }).Code).to.equal('FACET_FOLD_UNSUPPORTED');
						Expect(fError({ CountMode: 'PivotDistinct' }).Detail).to.include({ Feature: 'CountMode', Milestone: 2 });
						Expect(fError({ TimeZone: 'America/Los_Angeles' }).Code).to.equal('FACET_TIMEZONE_UNSUPPORTED');
						Expect(fError({ TimeZone: 'America/Los_Angeles' }).Status).to.equal(422);
						Expect(fError({ Definition: { Fold: 'Terms' } }).Code).to.equal('FACET_ADHOC_FORBIDDEN');
						Expect(fError({ Definition: { Fold: 'Terms' } }).Status).to.equal(403);
						Expect(_Normalizer.normalize('Book', { Facets: [ { Facet: 'Book.Genre', Exclude: 'None' } ] }).Facets[0].Exclude).to.equal('None');
					});

				test('inputs that are later milestones are refused, never ignored',
					() =>
					{
						let fError = (pBody) => { return facetError(() => { _Normalizer.normalize('Book', Object.assign({ Facets: [ { Facet: 'Book.Genre' } ] }, pBody)); }); };
						[ [ 'Selections', [ { Facet: 'Book.Genre', Keys: [ 'x' ] } ] ], [ 'FilterExperience', 'H4sIAAAA' ] ].forEach(
							(pCase) =>
							{
								let tmpBody = {};
								tmpBody[pCase[0]] = pCase[1];
								let tmpError = fError(tmpBody);
								Expect(tmpError.Code, pCase[0]).to.equal('FACET_FOLD_UNSUPPORTED');
								Expect(tmpError.Detail).to.deep.equal({ Feature: pCase[0], Milestone: 2 });
							});
						Expect(fError({ Scopes: 'Book.Mine' }).Code).to.equal('FACET_REQUEST_INVALID');
						// M2: Scopes / NamedScope clauses / Params / Records are accepted by the normalizer
						// (their meaning is the FilterAST's, the Binder's and the service's).
						let tmpAccepted = _Normalizer.normalize('Book', { Facets: [ { Facet: 'Book.Genre' } ], Scopes: [ { Scope: 'Book.Mine' } ], Clauses: [ { Type: 'NamedScope', Scope: 'Book.Mine' } ], Params: { Roles: [ 'x' ] }, Records: { Begin: 0, Cap: 10 } });
						Expect(tmpAccepted.Scopes).to.deep.equal([ { Scope: 'Book.Mine', Params: {} } ]);
						Expect(tmpAccepted.Records).to.deep.equal({ Begin: 0, Cap: 10, Sort: [] });
						Expect(_Normalizer.normalize('Book', { Records: {} }, 'Records').Mode).to.equal('Records');
					});

				test('body shape: Facets required and bounded; types checked',
					() =>
					{
						Expect(facetError(() => { _Normalizer.normalize('Book', null); }).Code).to.equal('FACET_REQUEST_INVALID');
						Expect(facetError(() => { _Normalizer.normalize('Book', [ { Facet: 'Book.Genre' } ]); }).Code).to.equal('FACET_REQUEST_INVALID');
						Expect(facetError(() => { _Normalizer.normalize('Book', {}); }).Code).to.equal('FACET_REQUEST_INVALID');
						Expect(facetError(() => { _Normalizer.normalize('Book', { Facets: [] }); }).Code).to.equal('FACET_REQUEST_INVALID');
						let tmpFacets = [];
						for (let i = 0; i < 21; i++)
						{
							tmpFacets.push({ Key: 'k' + i, Facet: 'Book.Genre' });
						}
						let tmpError = facetError(() => { _Normalizer.normalize('Book', { Facets: tmpFacets }); });
						Expect(tmpError.Code).to.equal('FACET_TOO_MANY_FACETS');
						Expect(tmpError.Status).to.equal(400);
						Expect(facetError(() => { _Normalizer.normalize('Book', { Facets: [ { Facet: 'Book.Genre' } ], Total: 'yes' }); }).Code).to.equal('FACET_REQUEST_INVALID');
						Expect(facetError(() => { _Normalizer.normalize('Book', { Facets: [ { Facet: 'Book.Genre' } ], FilterString: [ 'FBV' ] }); }).Code).to.equal('FACET_REQUEST_INVALID');
						Expect(facetError(() => { _Normalizer.normalize('Book', { Facets: [ { Facet: 'Book.Genre' } ], Clauses: { Type: 'RawFilter' } }); }).Code).to.equal('FACET_REQUEST_INVALID');
						Expect(facetError(() => { _Normalizer.normalize('Book', { Facets: [ { Facet: 'Book.Genre' } ], Clauses: [ { Values: [] } ] }); }).Code).to.equal('FACET_REQUEST_INVALID');
						Expect(facetError(() => { _Normalizer.normalize('Book', { Facets: [ { Facet: 'Book.Genre' } ], TimeoutMS: 0 }); }).Code).to.equal('FACET_REQUEST_INVALID');
						Expect(_Normalizer.normalize('Book', { Facets: [ { Facet: 'Book.Genre' } ], TimeoutMS: 250 }).TimeoutMS).to.equal(250);
					});

				test('L1 limits (06 §8): body bytes, depth, clause count, string bytes, array length',
					() =>
					{
						let fLimit = (pBody) => { let tmpError = facetError(() => { _Normalizer.normalize('Book', pBody); }); Expect(tmpError.Code).to.equal('FACET_REQUEST_INVALID'); return tmpError.Detail.Limit; };
						let tmpFacets = [ { Facet: 'Book.Genre' } ];
						let tmpDeep = { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } };
						Expect(fLimit({ Facets: tmpFacets, Extra: tmpDeep })).to.equal('MaxJSONDepth');
						let tmpClauses = [];
						for (let i = 0; i < 101; i++)
						{
							tmpClauses.push({ Type: 'RawFilter', Value: 'FBV~Genre~EQ~x' });
						}
						Expect(fLimit({ Facets: tmpFacets, Clauses: tmpClauses })).to.equal('MaxClauses');
						Expect(fLimit({ Facets: tmpFacets, Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre', Values: [ 'x'.repeat(1025) ] } ] })).to.equal('MaxValueBytes');
						Expect(fLimit({ Facets: tmpFacets, Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Genre', Values: new Array(1001).fill('x') } ] })).to.equal('MaxInList');
						let tmpBig = [];
						for (let i = 0; i < 300; i++)
						{
							tmpBig.push('y'.repeat(1000));
						}
						Expect(fLimit({ Facets: tmpFacets, Padding: tmpBig })).to.equal('MaxBodyBytes');
						Expect(fLimit({ Facets: [ { Facet: 'Book.Genre', Key: 'k'.repeat(1025) } ] })).to.equal('MaxValueBytes');
						// meadow-filter texts may exceed the per-value limit (their values are bounded after decoding)
						let tmpLongFilter = new Array(60).fill('FBV~Genre~EQ~Fiction').join('~');
						Expect(tmpLongFilter.length).to.be.greaterThan(1024);
						Expect(_Normalizer.normalize('Book', { Facets: tmpFacets, FilterString: tmpLongFilter }).FilterString).to.equal(tmpLongFilter);
						Expect(_Normalizer.normalize('Book', { Facets: tmpFacets, Clauses: [ { Type: 'RawFilter', Value: tmpLongFilter } ] }).Clauses.length).to.equal(1);
						Expect(fLimit({ Facets: tmpFacets, FilterString: 'x'.repeat(270000) })).to.equal('MaxBodyBytes');
					});

				test('the configured Limits and StorageTimeZone reach the shared contract normalizer',
					() =>
					{
						let tmpFable = newFable({ Limits: { MaxFacets: 2, MaxTop: 7, MaxClauses: 1, MaxValueBytes: 12 } });
						let tmpNormalizer = tmpFable.RetoldFacetingRequestNormalizer;
						Expect(facetError(() => { tmpNormalizer.normalize('Book', { Facets: [ { Key: 'a', Facet: 'Book.Genre' }, { Key: 'b', Facet: 'Book.Genre' }, { Key: 'c', Facet: 'Book.Genre' } ] }); }).Code).to.equal('FACET_TOO_MANY_FACETS');
						Expect(tmpNormalizer.normalize('Book', { Facets: [ { Key: 'a', Facet: 'Book.Genre', Top: 8 } ] }).Facets[0].Top).to.equal(7);
						Expect(facetError(() => { tmpNormalizer.normalize('Book', { Facets: [ { Key: 'a', Facet: 'Book.Genre' } ], Clauses: [ { Type: 'RawFilter' }, { Type: 'RawFilter' } ] }); }).Detail.Limit).to.equal('MaxClauses');
						Expect(facetError(() => { tmpFable.RetoldFacetingFilterValidator.validate('Book', 'FBV~Genre~EQ~1234567890123', {}); }).Detail.Reason).to.equal('ValueTooLong');
						let tmpLocal = newFable({ Time: { StorageTimeZone: 'America/Chicago' } }).RetoldFacetingRequestNormalizer;
						Expect(tmpLocal.normalize('Book', { Facets: [ { Facet: 'Book.CreateDate', TimeZone: 'America/Chicago' } ] }).Facets[0].TimeZone).to.equal('America/Chicago');
						Expect(facetError(() => { tmpLocal.normalize('Book', { Facets: [ { Facet: 'Book.CreateDate', TimeZone: 'UTC' } ] }); }).Code).to.equal('FACET_TIMEZONE_UNSUPPORTED');
						// the legacy payload stays refused in M1 (normalizeLegacy is the seam)
						Expect(facetError(() => { _Normalizer.normalize('Book', { Fields: [ 'Genre' ] }); }).Code).to.equal('FACET_REQUEST_INVALID');
						Expect(_Normalizer.normalizeLegacy('Book', { Fields: [ 'Genre' ] })).to.equal(null);
					});
			}
		);

		suite
		(
			'Request pipeline (Normalizer → FilterAST.build → DisjunctivePlanner)',
			() =>
			{
				test('a pict recordset body end to end',
					() =>
					{
						let tmpRequest = _Normalizer.normalize('BookStoreSale',
							{
								Clauses:
									[
										{ Type: 'DistinctSelectedValueList', FilterByColumn: 'PaymentMethod', Values: [ 'Credit', 'Cash' ], FilterKey: 'PaymentMethod', ClauseKey: 'DistinctSelectedValueList', Hash: 'PaymentMethod-DistinctSelectedValueList-3b1f' },
										{ Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { Start: '2025-07-01 00:00:00', End: '2026-07-01 00:00:00' }, EndExclusive: true, FilterKey: 'SaleDate', Hash: 'SaleDate-DateRange-7a01' }
									],
								FilterString: 'FOP~0~(~0~FBV~TransactionID~LK~%25A1%25~FBVOR~PaymentMethod~EQ~Check~FCP~0~)~0',
								Facets:
									[
										{ Key: 'ByMonth', Facet: 'BookStoreSale.SaleDate', Fold: 'DateHistogram', Interval: 'month' },
										{ Key: 'ByPayment', Facet: 'BookStoreSale.PaymentMethod', Top: 10 },
										{ Key: 'Amounts', Facet: 'BookStoreSale.TotalAmount', Fold: 'Stats' }
									]
							});
						let tmpAST = _AST.build(tmpRequest.Entity, tmpRequest);
						// the whole-string fence is unwrapped: the FilterString is ONE Or conjunct
						Expect(tmpAST.Conjuncts.length).to.equal(3);
						Expect(tmpAST.Conjuncts[2].Pred).to.deep.equal({ Or: [ { Field: 'TransactionID', Op: 'LK', Value: '%A1%' }, { Field: 'PaymentMethod', Op: 'EQ', Value: 'Check' } ] });
						let tmpPlan = _Planner.variants(tmpAST,
							[
								{ Key: 'ByMonth', OwnedFields: [ 'SaleDate' ], FilterKey: 'SaleDate', Exclude: tmpRequest.Facets[0].Exclude, Fold: 'DateHistogram' },
								{ Key: 'ByPayment', OwnedFields: [ 'PaymentMethod' ], FilterKey: 'PaymentMethod', Exclude: tmpRequest.Facets[1].Exclude, Fold: 'Terms' },
								{ Key: 'Amounts', OwnedFields: [ 'TotalAmount' ], FilterKey: 'TotalAmount', Exclude: tmpRequest.Facets[2].Exclude, Fold: 'Stats' },
								{ Key: '#Total', OwnedFields: [], FilterKey: null, Exclude: 'None', Fold: 'Count' }
							]);
						Expect(tmpPlan.Facets.ByMonth).to.deep.equal({ VariantId: 'v1', Mode: 'Exact', Excluded: [ 'c2' ], ExcludedHashes: [ 'SaleDate-DateRange-7a01' ], KeptMixed: [], Owned: [ 'c2' ] });
						Expect(tmpPlan.Facets.ByPayment).to.deep.equal({ VariantId: 'v2', Mode: 'Partial', Excluded: [ 'c1' ], ExcludedHashes: [ 'PaymentMethod-DistinctSelectedValueList-3b1f' ], KeptMixed: [ 'c3' ], Owned: [ 'c1' ] });
						Expect(tmpPlan.Facets.Amounts.VariantId).to.equal('v0');
						Expect(tmpPlan.Variants.v0.Facets).to.deep.equal([ 'Amounts', '#Total' ]);
					});
			}
		);

		suite
		(
			'Against the real RetoldFacetingCatalog',
			() =>
			{
				let _RealFable = null;

				suiteSetup(
					function ()
					{
						try
						{
							let libCatalog = require('../source/catalog/Retold-Faceting-Catalog.js');
							let libGraph = require('../source/catalog/Retold-Faceting-Graph.js');
							let tmpFable = new libFable({ Product: 'RetoldFacetingFilterASTRealCatalog', LogStreams: [ { streamtype: 'console', level: 'fatal' } ] });
							tmpFable.addServiceType('RetoldFacetingGraph', libGraph);
							tmpFable.instantiateServiceProvider('RetoldFacetingGraph', {});
							tmpFable.addServiceType('RetoldFacetingCatalog', libCatalog);
							tmpFable.instantiateServiceProvider('RetoldFacetingCatalog', {});
							for (let i = 0; i < REQUEST_SERVICES.length; i++)
							{
								tmpFable.addServiceType(REQUEST_SERVICES[i][0], REQUEST_SERVICES[i][1]);
								tmpFable.instantiateServiceProvider(REQUEST_SERVICES[i][0], {});
							}
							let tmpModel = bookstoreModel();
							if (typeof(tmpFable.RetoldFacetingGraph.rebuild) === 'function')
							{
								tmpFable.RetoldFacetingGraph.rebuild(tmpModel);
							}
							tmpFable.RetoldFacetingCatalog.rebuild(tmpModel, null);
							Expect(tmpFable.RetoldFacetingCatalog.column('Book', 'Title'), 'the real catalog builds from the model').to.be.an('object');
							_RealFable = tmpFable;
						}
						catch (pError)
						{
							// A real-catalog regression is a failure, never a pending suite.
							throw pError;
						}
					});

				test('whitelist, Sensitive columns and the delete column behave the same',
					() =>
					{
						let tmpValidator = _RealFable.RetoldFacetingFilterValidator;
						Expect(tmpValidator.validate('Book', 'FBV~Title~EQ~x~FBL~Deleted~INN~0,1', { AllowDeleteColumn: true }).Stanzas.length).to.equal(2);
						Expect(facetError(() => { tmpValidator.validate('User', 'FBV~Password~EQ~x', { AllowDeleteColumn: true }); }).Code).to.equal('FACET_UNKNOWN_FIELD');
						Expect(facetError(() => { tmpValidator.validate('Book', 'FBV~Nope~EQ~x', { AllowDeleteColumn: true }); }).Code).to.equal('FACET_UNKNOWN_FIELD');
						Expect(facetError(() => { tmpValidator.validate('Book', 'FBL~Deleted~INN~0,1', {}); }).Detail.Reason).to.equal('DeleteColumnNotAllowed');
						let tmpAST = _RealFable.RetoldFacetingFilterAST.build('BookStoreSale',
							{
								Clauses: [ { Type: 'DateRange', FilterByColumn: 'SaleDate', Values: { Start: '2025-01-01' } }, { Type: 'DistinctSelectedValueList', FilterByColumn: 'IDBookStore', Values: [ '2' ] } ],
								FilterString: 'FBL~Deleted~INN~0,1'
							});
						Expect(tmpAST.Conjuncts[0].Pred).to.deep.equal({ Field: 'SaleDate', Op: 'GE', Value: '2025-01-01' });
						Expect(tmpAST.Conjuncts[1].Pred).to.deep.equal({ Field: 'IDBookStore', Op: 'IN', Value: [ 2 ] });
						Expect(tmpAST.IncludesDeleted).to.equal(true);
					});
			}
		);
	}
);
