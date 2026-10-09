/**
 * Bookstore-Seed — deterministic fixture generator (D-21, internal-contracts §14.2)
 *
 * Builds the bookstore schema into a test-owned SQLite (normally :memory:) from the model itself
 * (a copy of the retold-harness MeadowModel-Extended.json kept in test/fixtures/Bookstore-Model.json,
 * so the module tests stand alone and the fixture never drifts with the harness), and fills it
 * from a fixed-seed PRNG (mulberry32; one independent stream per table, so a change to one
 * table's generator never shifts another table's rows).
 *
 *   let tmpSeed = libBookstoreSeed.build(tmpDB, { Fixture: 'Bookstore', Seed: 20261008, Scale: 'Small' });
 *   // → { Fixture, Seed, Scale, Model, Counts, LiveCounts, Tenants, TenantCounts, TenantLiveCounts, Traps }
 *
 * Data shape (08 §5):
 *   - soft-deleted rows (~3 %, at least one) in every table with a Deleted column;
 *   - NULL dates and NULL numbers, '' strings (Book.Language, Book.Genre, BookStore.State,
 *     BookStoreSale.PaymentMethod) and a few '' dates (BookPrice.EndDate — Missing, §16.11);
 *   - skewed categories (Review.Rating, BookStoreSale.PaymentMethod, Book.Language, Book.Genre);
 *   - decimals with exactly the column scale (generated from integer cents);
 *   - DateTime values as 'YYYY-MM-DD HH:mm:ss';
 *   - BookStoreSale.SaleDate spanning 2020-12-31 … 2024-12-30 (the first month is a single day),
 *     TotalAmount with a high outlier, sales at soft-deleted and at missing stores;
 *   - Book.PublicationYear with a negative outlier (-1750);
 *   - a non-empty BookStoreCatalogJoin;
 *   - fixed TRAPS (specific rows, applied after generation so no PRNG stream shifts): a TotalAmount
 *     with more decimals than its Scale just below a Nice edge (499.996), SaleDates stored as
 *     'YYYY-MM-DD', 'YYYY-MM-DD HH:mm' and a 'T' form exactly on month / quarter / year boundaries,
 *     Book.Genre values holding '~' (UnsafeKey), and '' / ' ' text in the integer
 *     BookStoreInventory.BookCount column (Missing on every engine).
 *
 * 'Bookstore-Tenant' adds an IDTenant column to EVERY table: tenant 1 = the base data, tenant 2 =
 * a ~5 % clone with distinct IDs and the same value distributions; a few tenant-2 clones keep
 * their tenant-1 parent and a few tenant-1 rows are pointed at tenant-2 parents (cross-tenant
 * references, F20).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libPath = require('path');
const libCrypto = require('crypto');

const libRetoldFacetingGraph = require('../../source/catalog/Retold-Faceting-Graph.js');

const BOOKSTORE_MODEL_PATH = libPath.resolve(__dirname, 'Bookstore-Model.json');

const DEFAULT_SEED = 20261008;

const FIXTURES = [ 'Bookstore', 'Bookstore-Tenant' ];

const TENANT_COLUMN = 'IDTenant';

// Row-count multiplier per scale.
const SCALES = { Small: 1, Medium: 4 };

// Base (Small) sizes.  Join/child tables not listed here are derived from their parents.
const BASE_SIZES = (
	{
		User: 240,
		Customer: 120,
		Author: 400,
		Book: 1500,
		BookStore: 40,
		BookStoreEmployee: 120,
		BookStoreInventory: 1600,
		Review: 6000,
		BookStoreSale: 3000,
		BookStoreCatalogJoin: 420
	});

// Parents first (FK targets are generated before the rows that reference them).
const GENERATION_ORDER = (
	[
		'User', 'Customer', 'Author', 'Book', 'BookAuthorJoin', 'BookPrice', 'BookStore',
		'BookStoreEmployee', 'BookStoreInventory', 'Review', 'BookStoreSale', 'BookStoreSaleItem',
		'BookStoreCatalogJoin'
	]);

// Epoch-second windows (UTC; dates are naive wall clock in StorageTimeZone UTC, D-22).
const EPOCH_2019 = Date.UTC(2019, 0, 1) / 1000;
const EPOCH_2021 = Date.UTC(2021, 0, 1) / 1000;
const EPOCH_2024_END = Date.UTC(2024, 11, 30, 21, 0, 0) / 1000;
const EPOCH_2025 = Date.UTC(2025, 0, 1) / 1000;

const FIRST_SALE_DATE = '2020-12-31 09:33:32';
const LAST_SALE_DATE = '2024-12-30 21:55:33';
const PUBLICATION_YEAR_OUTLIER = -1750;
const TOTAL_AMOUNT_OUTLIER_CENTS = 487550;
const MISSING_STORE_ID_BASE = 90000;

// Fixed traps (row IDs → values), applied after generation.
const TRAP_SUB_SCALE_AMOUNT = { IDBookStoreSale: 12, TotalAmount: 499.996 };
const TRAP_SALE_DATES = Object.freeze(
	[
		{ IDBookStoreSale: 13, SaleDate: '2023-04-01' },
		{ IDBookStoreSale: 14, SaleDate: '2023-07-01 00:00' },
		{ IDBookStoreSale: 15, SaleDate: '2022-01-01T00:00:00' }
	]);
const TRAP_UNSAFE_GENRE = { IDBooks: [ 16, 17, 18 ], Genre: 'Sci~Fi' };
const TRAP_TEXT_BOOK_COUNTS = Object.freeze([ { IDBookStoreInventory: 5, BookCount: '' }, { IDBookStoreInventory: 6, BookCount: ' ' } ]);

const FIRST_NAMES = [ 'James', 'Mary', 'Robert', 'Patricia', 'John', 'Jennifer', 'Michael', 'Linda', 'David', 'Elizabeth', 'William', 'Barbara', 'Richard', 'Susan', 'Joseph', 'Jessica', 'Thomas', 'Sarah', 'Charles', 'Karen', 'Ngozi', 'Haruki', 'Ursula', 'Octavia' ];
const LAST_NAMES = [ 'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Le Guin', 'Butler', 'Adichie', 'Murakami' ];
const TITLE_WORDS_A = [ 'The', 'A', 'Our', 'Their', 'Every', 'No' ];
const TITLE_WORDS_B = [ 'Silent', 'Hidden', 'Last', 'Bright', 'Broken', 'Golden', 'Distant', 'Quiet', 'Burning', 'Winter', 'Paper', 'Iron' ];
const TITLE_WORDS_C = [ 'River', 'Garden', 'Kingdom', 'Letter', 'Harbor', 'Mountain', 'Library', 'Orchard', 'Station', 'Promise', 'Island', 'Clock' ];
const CITIES = [ 'Seattle', 'Portland', 'Austin', 'Denver', 'Boston', 'Chicago', 'Atlanta', 'Phoenix', 'Madison', 'Tucson', 'Spokane', 'Eugene' ];
const STORE_TITLES = [ [ 'Clerk', 50 ], [ 'Assistant Manager', 15 ], [ 'Manager', 10 ], [ 'Buyer', 8 ], [ 'Barista', 5 ], [ '', 2 ] ];

// Skewed categorical distributions ([ value, weight ]; null = SQL NULL).
const RATING_WEIGHTS = [ [ 1, 5 ], [ 2, 10 ], [ 3, 20 ], [ 4, 35 ], [ 5, 29.5 ], [ null, 0.5 ] ];
const PAYMENT_WEIGHTS = [ [ 'Credit', 43 ], [ 'Debit', 26 ], [ 'Cash', 17 ], [ 'Online', 13 ], [ '', 0.6 ], [ null, 0.4 ] ];
const LANGUAGE_WEIGHTS = [ [ 'eng', 60 ], [ 'en-US', 20 ], [ 'en-GB', 3 ], [ 'spa', 2.5 ], [ 'fre', 2 ], [ 'ger', 1.5 ], [ 'ita', 0.7 ], [ 'jpn', 0.6 ], [ 'por', 0.4 ], [ '', 7 ], [ null, 2.3 ] ];
const GENRE_WEIGHTS = [ [ 'Fiction', 30 ], [ 'Mystery', 15 ], [ 'Romance', 12 ], [ 'Science Fiction', 10 ], [ 'Fantasy', 9 ], [ 'Biography', 6 ], [ 'History', 5 ], [ 'Young Adult', 4 ], [ 'Horror', 3 ], [ 'Poetry', 2 ], [ 'Travel', 1 ], [ 'Cooking', 1 ], [ '', 1 ], [ null, 1 ] ];
const TYPE_WEIGHTS = [ [ 'Book', 80 ], [ 'eBook', 12 ], [ 'Audiobook', 6 ], [ '', 2 ] ];
const STATE_WEIGHTS = [ [ 'CA', 25 ], [ 'TX', 15 ], [ 'NY', 12 ], [ 'WA', 10 ], [ 'OR', 6 ], [ 'FL', 6 ], [ 'IL', 5 ], [ 'CO', 4 ], [ '', 15 ], [ null, 2 ] ];
const COUNTRY_WEIGHTS = [ [ 'USA', 90 ], [ 'CAN', 10 ] ];

/**
 * mulberry32 — the only randomness source for fixtures.
 *
 * @param {number} pSeed
 * @return {() => number} a function returning floats in [0, 1)
 */
const prng = (pSeed) =>
{
	let tmpState = (pSeed >>> 0);
	return () =>
	{
		tmpState = (tmpState + 0x6D2B79F5) >>> 0;
		let tmpT = tmpState;
		tmpT = Math.imul(tmpT ^ (tmpT >>> 15), tmpT | 1);
		tmpT ^= tmpT + Math.imul(tmpT ^ (tmpT >>> 7), tmpT | 61);
		return ((tmpT ^ (tmpT >>> 14)) >>> 0) / 4294967296;
	};
};

/**
 * FNV-1a (32 bit) of a string — derives independent per-table PRNG streams from one seed.
 *
 * @param {string} pString
 * @return {number}
 */
const hashString = (pString) =>
{
	let tmpHash = 0x811C9DC5;
	for (let i = 0; i < pString.length; i++)
	{
		tmpHash ^= pString.charCodeAt(i);
		tmpHash = Math.imul(tmpHash, 0x01000193) >>> 0;
	}
	return tmpHash >>> 0;
};

/**
 * A random helper bound to one named stream of a seed.
 *
 * @param {number} pSeed
 * @param {string} pStreamName
 * @return {Record<string, Function>}
 */
const stream = (pSeed, pStreamName) =>
{
	let fNext = prng((pSeed ^ hashString(pStreamName)) >>> 0);
	let tmpRandom = (
		{
			next: fNext,
			// Inclusive integer range
			int: (pLo, pHi) =>
			{
				return pLo + Math.floor(fNext() * (pHi - pLo + 1));
			},
			chance: (pProbability) =>
			{
				return fNext() < pProbability;
			},
			pick: (pArray) =>
			{
				return pArray[Math.floor(fNext() * pArray.length)];
			},
			// [ [ value, weight ], … ]
			weighted: (pPairs) =>
			{
				let tmpTotal = 0;
				for (let i = 0; i < pPairs.length; i++)
				{
					tmpTotal += pPairs[i][1];
				}
				let tmpRoll = fNext() * tmpTotal;
				for (let i = 0; i < pPairs.length; i++)
				{
					tmpRoll -= pPairs[i][1];
					if (tmpRoll < 0)
					{
						return pPairs[i][0];
					}
				}
				return pPairs[pPairs.length - 1][0];
			},
			// Power-law-ish pick of a 1-based ID in [1, pCount] (low IDs are popular)
			skewedID: (pCount, pExponent) =>
			{
				let tmpExponent = (typeof(pExponent) === 'number') ? pExponent : 2;
				return 1 + Math.min(pCount - 1, Math.floor(pCount * Math.pow(fNext(), tmpExponent)));
			},
			// 'YYYY-MM-DD HH:mm:ss' uniformly in [pLoEpoch, pHiEpoch)
			date: (pLoEpoch, pHiEpoch) =>
			{
				return formatEpoch(pLoEpoch + Math.floor(fNext() * (pHiEpoch - pLoEpoch)));
			},
			hex: (pLength) =>
			{
				let tmpOut = '';
				for (let i = 0; i < pLength; i++)
				{
					tmpOut += Math.floor(fNext() * 16).toString(16);
				}
				return tmpOut;
			}
		});
	return tmpRandom;
};

/**
 * Epoch seconds → 'YYYY-MM-DD HH:mm:ss' (UTC).
 *
 * @param {number} pEpochSeconds
 * @return {string}
 */
const formatEpoch = (pEpochSeconds) =>
{
	return new Date(pEpochSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
};

/**
 * Integer cents → a decimal with exactly two places.
 *
 * @param {number} pCents
 * @return {number}
 */
const fromCents = (pCents) =>
{
	return Number((pCents / 100).toFixed(2));
};

/**
 * A deep clone of the bookstore model for a fixture.
 *
 * @param {string} [pFixture] - 'Bookstore' (default) | 'Bookstore-Tenant'
 * @return {Record<string, any>}
 */
const model = (pFixture) =>
{
	let tmpFixture = pFixture || 'Bookstore';
	if (FIXTURES.indexOf(tmpFixture) < 0)
	{
		throw new Error(`Unknown fixture [${tmpFixture}].`);
	}
	// require() caches; clone so callers can mutate freely.
	let tmpModel = JSON.parse(JSON.stringify(require(BOOKSTORE_MODEL_PATH)));
	if (tmpFixture === 'Bookstore-Tenant')
	{
		let tmpTables = Object.keys(tmpModel.Tables);
		for (let i = 0; i < tmpTables.length; i++)
		{
			let tmpTable = tmpModel.Tables[tmpTables[i]];
			tmpTable.Columns.push({ Column: TENANT_COLUMN, DataType: 'Numeric', Size: 'int' });
			if (tmpTable.MeadowSchema)
			{
				tmpTable.MeadowSchema.Schema.push({ Column: TENANT_COLUMN, Type: 'Integer', Size: 'int' });
				if (tmpTable.MeadowSchema.DefaultObject)
				{
					tmpTable.MeadowSchema.DefaultObject[TENANT_COLUMN] = 0;
				}
				if (tmpTable.MeadowSchema.JsonSchema && tmpTable.MeadowSchema.JsonSchema.properties)
				{
					tmpTable.MeadowSchema.JsonSchema.properties[TENANT_COLUMN] = { type: 'integer', size: 'int' };
				}
			}
		}
	}
	return tmpModel;
};

/**
 * SQLite column type for a Stricture DataType.
 *
 * @param {string} pDataType
 * @return {string}
 */
const sqliteType = (pDataType) =>
{
	switch (pDataType)
	{
		case 'ID':
			return 'INTEGER PRIMARY KEY AUTOINCREMENT';
		case 'Numeric':
		case 'ForeignKey':
		case 'Boolean':
			return 'INTEGER';
		case 'Decimal':
			return 'REAL';
		default:
			return 'TEXT';
	}
};

/**
 * CREATE TABLE for every model table (no column defaults: NULLs are real NULLs).
 *
 * @param {any} pDB - node:sqlite DatabaseSync
 * @param {Record<string, any>} pModel
 */
const createTables = (pDB, pModel) =>
{
	let tmpTables = Object.keys(pModel.Tables);
	for (let i = 0; i < tmpTables.length; i++)
	{
		let tmpTable = pModel.Tables[tmpTables[i]];
		let tmpColumns = tmpTable.Columns.map((pColumn) => { return `"${pColumn.Column}" ${sqliteType(pColumn.DataType)}`; });
		pDB.exec(`CREATE TABLE IF NOT EXISTS "${tmpTables[i]}" (${tmpColumns.join(', ')});`);
	}
};

// Policy columns every scoped read filters on (tenancy and owner scopes of the fixtures).
const POLICY_INDEX_COLUMNS = Object.freeze([ 'IDCustomer', 'IDTenant', 'OwnerIDUser' ]);

/**
 * The columns of a model table that get an index (as meadow's createTables indexes ForeignKey and GUID
 * columns): every Join / ForeignKey column (each FacetGraph edge's On / Correlate column, so every
 * correlated EXISTS / NOT EXISTS / ExistsSplit probe of a hop is an index search, never a scan), every
 * GUID column, and the tenancy / owner policy columns.
 *
 * @param {Record<string, any>} pTable - model table ({ Columns: [ … ] })
 * @return {Array<string>}
 */
const indexColumns = (pTable) =>
{
	let tmpColumns = [];
	(Array.isArray(pTable.Columns) ? pTable.Columns : []).forEach(
		(pColumn) =>
		{
			if (!pColumn || (typeof(pColumn.Column) !== 'string') || (pColumn.DataType === 'ID'))
			{
				return;
			}
			let tmpIndexed = ((typeof(pColumn.Join) === 'string') && (pColumn.Join.length > 0)) || (pColumn.DataType === 'ForeignKey')
				|| (pColumn.DataType === 'GUID') || (POLICY_INDEX_COLUMNS.indexOf(pColumn.Column) >= 0);
			if (tmpIndexed && (tmpColumns.indexOf(pColumn.Column) < 0))
			{
				tmpColumns.push(pColumn.Column);
			}
		});
	return tmpColumns;
};

/**
 * CREATE INDEX for every indexColumns() column of every model table (run after the rows are in).
 *
 * @param {any} pDB - node:sqlite DatabaseSync
 * @param {Record<string, any>} pModel
 */
const createIndexes = (pDB, pModel) =>
{
	let tmpTables = Object.keys(pModel.Tables);
	for (let i = 0; i < tmpTables.length; i++)
	{
		indexColumns(pModel.Tables[tmpTables[i]]).forEach(
			(pColumn) =>
			{
				pDB.exec(`CREATE INDEX IF NOT EXISTS "IX_${tmpTables[i]}_${pColumn}" ON "${tmpTables[i]}" ("${pColumn}");`);
			});
	}
	// Statistics, so the planner picks the selective correlation index (not the tenancy one) for a hop.
	pDB.exec('ANALYZE;');
};

/**
 * The primary key column (DataType 'ID') of a model table.
 *
 * @param {Record<string, any>} pModel
 * @param {string} pTable
 * @return {string|null}
 */
const primaryKeyOf = (pModel, pTable) =>
{
	// The source's one model-level primary-key rule.
	return libRetoldFacetingGraph.primaryKeyOf(pModel.Tables[pTable]);
};

/**
 * FK columns of a table: [ { Column, Target } ] (Target = the table whose PK is the Join column).
 *
 * @param {Record<string, any>} pModel
 * @param {string} pTable
 * @return {Array<{ Column: string, Target: string }>}
 */
const foreignKeysOf = (pModel, pTable) =>
{
	let tmpPKIndex = {};
	let tmpTables = Object.keys(pModel.Tables);
	for (let i = 0; i < tmpTables.length; i++)
	{
		let tmpPK = primaryKeyOf(pModel, tmpTables[i]);
		if (tmpPK)
		{
			tmpPKIndex[tmpPK] = tmpTables[i];
		}
	}
	let tmpForeignKeys = [];
	let tmpColumns = pModel.Tables[pTable].Columns;
	for (let i = 0; i < tmpColumns.length; i++)
	{
		if (tmpColumns[i].Join && tmpPKIndex.hasOwnProperty(tmpColumns[i].Join))
		{
			tmpForeignKeys.push({ Column: tmpColumns[i].Column, Target: tmpPKIndex[tmpColumns[i].Join] });
		}
	}
	return tmpForeignKeys;
};

/**
 * Does the table have a column?
 *
 * @param {Record<string, any>} pModel
 * @param {string} pTable
 * @param {string} pColumn
 * @return {boolean}
 */
const hasColumn = (pModel, pTable, pColumn) =>
{
	return pModel.Tables[pTable].Columns.some((pEntry) => { return pEntry.Column === pColumn; });
};

/**
 * Fill the standard audit columns (CreateDate … DeletingIDUser) for row i of a table.
 *
 * @param {Record<string, any>} pRow
 * @param {Record<string, Function>} pRandom
 * @param {number} pUserCount
 * @param {number} [pDeletedRate]
 */
const auditColumns = (pRow, pRandom, pUserCount, pDeletedRate) =>
{
	let tmpCreateEpoch = EPOCH_2019 + Math.floor(pRandom.next() * (EPOCH_2025 - EPOCH_2019 - 86400 * 30));
	pRow.CreateDate = formatEpoch(tmpCreateEpoch);
	pRow.CreatingIDUser = pRandom.int(1, pUserCount);
	pRow.UpdateDate = formatEpoch(tmpCreateEpoch + pRandom.int(0, 86400 * 30));
	pRow.UpdatingIDUser = pRandom.int(1, pUserCount);
	let tmpDeleted = pRandom.chance((typeof(pDeletedRate) === 'number') ? pDeletedRate : 0.03);
	pRow.Deleted = tmpDeleted ? 1 : 0;
	pRow.DeleteDate = tmpDeleted ? formatEpoch(tmpCreateEpoch + pRandom.int(86400, 86400 * 60)) : null;
	pRow.DeletingIDUser = tmpDeleted ? pRandom.int(1, pUserCount) : 0;
};

/**
 * Make sure a soft-deletable table has at least one deleted row (small tables could miss the 3 %).
 *
 * @param {Array<Record<string, any>>} pRows
 */
const ensureDeleted = (pRows) =>
{
	if ((pRows.length < 2) || !pRows[0].hasOwnProperty('Deleted'))
	{
		return;
	}
	if (pRows.some((pRow) => { return pRow.Deleted === 1; }))
	{
		return;
	}
	let tmpRow = pRows[Math.floor(pRows.length / 2)];
	tmpRow.Deleted = 1;
	tmpRow.DeleteDate = tmpRow.UpdateDate;
	tmpRow.DeletingIDUser = tmpRow.UpdatingIDUser;
};

/**
 * Generate the base (tenant 1) rows of every table.
 *
 * @param {number} pSeed
 * @param {number} pMultiplier
 * @return {Record<string, Array<Record<string, any>>>}
 */
const generateBase = (pSeed, pMultiplier) =>
{
	let tmpSize = (pTable) => { return BASE_SIZES[pTable] * pMultiplier; };
	let tmpRows = {};

	// ---- User (no audit columns)
	let tmpRandom = stream(pSeed, 'User');
	tmpRows.User = [];
	for (let i = 1; i <= tmpSize('User'); i++)
	{
		let tmpFirst = tmpRandom.pick(FIRST_NAMES);
		let tmpLast = tmpRandom.pick(LAST_NAMES);
		tmpRows.User.push(
			{
				IDUser: i, GUIDUser: 100000 + i, LoginID: `user${i}`, Password: `pw-${tmpRandom.hex(12)}`,
				NameFirst: tmpFirst, NameLast: tmpLast, FullName: `${tmpFirst} ${tmpLast}`, Config: '{}'
			});
	}
	let tmpUserCount = tmpRows.User.length;

	// ---- Customer
	tmpRandom = stream(pSeed, 'Customer');
	tmpRows.Customer = [];
	for (let i = 1; i <= tmpSize('Customer'); i++)
	{
		let tmpRow = { IDCustomer: i, GUIDCustomer: `cust-${String(i).padStart(6, '0')}-${tmpRandom.hex(8)}` };
		auditColumns(tmpRow, tmpRandom, tmpUserCount);
		let tmpContact = `${tmpRandom.pick(FIRST_NAMES)} ${tmpRandom.pick(LAST_NAMES)}`;
		Object.assign(tmpRow,
			{
				Name: `${tmpRandom.pick(LAST_NAMES)} ${tmpRandom.pick([ 'Books', 'Readers', 'Library', 'School', 'Club' ])} ${i}`,
				Description: tmpRandom.chance(0.2) ? null : `Customer account ${i}.`,
				ContactName: tmpContact,
				ContactEmail: `contact${i}@example.test`,
				ContactPhone: `555-${String(1000 + i).slice(-4)}`,
				Address: `${tmpRandom.int(1, 9999)} ${tmpRandom.pick(TITLE_WORDS_C)} St`,
				City: tmpRandom.pick(CITIES),
				State: tmpRandom.weighted(STATE_WEIGHTS),
				Postal: String(tmpRandom.int(10000, 99999)),
				Country: tmpRandom.weighted(COUNTRY_WEIGHTS),
				Active: tmpRandom.chance(0.85) ? 1 : 0
			});
		tmpRows.Customer.push(tmpRow);
	}
	let tmpCustomerCount = tmpRows.Customer.length;

	// ---- Author
	tmpRandom = stream(pSeed, 'Author');
	tmpRows.Author = [];
	for (let i = 1; i <= tmpSize('Author'); i++)
	{
		let tmpRow = { IDAuthor: i, GUIDAuthor: `auth-${String(i).padStart(6, '0')}-${tmpRandom.hex(8)}` };
		auditColumns(tmpRow, tmpRandom, tmpUserCount);
		tmpRow.Name = `${tmpRandom.pick(FIRST_NAMES)} ${tmpRandom.pick(LAST_NAMES)}`;
		tmpRow.IDUser = tmpRandom.chance(0.3) ? tmpRandom.int(1, tmpUserCount) : null;
		tmpRows.Author.push(tmpRow);
	}
	let tmpAuthorCount = tmpRows.Author.length;

	// ---- Book
	tmpRandom = stream(pSeed, 'Book');
	tmpRows.Book = [];
	for (let i = 1; i <= tmpSize('Book'); i++)
	{
		let tmpRow = { IDBook: i, GUIDBook: `book-${String(i).padStart(6, '0')}-${tmpRandom.hex(8)}` };
		auditColumns(tmpRow, tmpRandom, tmpUserCount);
		let tmpYear;
		if (i === 7)
		{
			tmpYear = PUBLICATION_YEAR_OUTLIER;
		}
		else if (tmpRandom.chance(0.02))
		{
			tmpYear = null;
		}
		else if (tmpRandom.chance(0.03))
		{
			tmpYear = tmpRandom.int(1800, 1949);
		}
		else
		{
			// Skewed toward recent years
			tmpYear = 2017 - Math.floor(67 * Math.pow(tmpRandom.next(), 2));
		}
		Object.assign(tmpRow,
			{
				Title: `${tmpRandom.pick(TITLE_WORDS_A)} ${tmpRandom.pick(TITLE_WORDS_B)} ${tmpRandom.pick(TITLE_WORDS_C)}`,
				Type: tmpRandom.weighted(TYPE_WEIGHTS),
				Genre: tmpRandom.weighted(GENRE_WEIGHTS),
				ISBN: `978${String(tmpRandom.int(0, 9999999999)).padStart(10, '0')}`,
				Language: tmpRandom.weighted(LANGUAGE_WEIGHTS),
				ImageURL: `https://images.example.test/book/${i}.jpg`,
				PublicationYear: tmpYear
			});
		tmpRows.Book.push(tmpRow);
	}
	let tmpBookCount = tmpRows.Book.length;

	// ---- BookAuthorJoin (no Deleted column): 1–3 authors per book, prolific authors skewed
	tmpRandom = stream(pSeed, 'BookAuthorJoin');
	tmpRows.BookAuthorJoin = [];
	for (let i = 1; i <= tmpBookCount; i++)
	{
		let tmpAuthorsForBook = tmpRandom.weighted([ [ 1, 65 ], [ 2, 26 ], [ 3, 9 ] ]);
		let tmpSeen = {};
		for (let j = 0; j < tmpAuthorsForBook; j++)
		{
			let tmpAuthor = tmpRandom.skewedID(tmpAuthorCount, 2);
			if (tmpSeen[tmpAuthor])
			{
				continue;
			}
			tmpSeen[tmpAuthor] = true;
			let tmpID = tmpRows.BookAuthorJoin.length + 1;
			tmpRows.BookAuthorJoin.push(
				{
					IDBookAuthorJoin: tmpID, GUIDBookAuthorJoin: `baj-${String(tmpID).padStart(6, '0')}-${tmpRandom.hex(8)}`,
					IDBook: i, IDAuthor: tmpAuthor, IDCustomer: null
				});
		}
	}

	// ---- BookPrice: one per book (10 % have two); EndDate NULL / '' / a later date
	tmpRandom = stream(pSeed, 'BookPrice');
	tmpRows.BookPrice = [];
	for (let i = 1; i <= tmpBookCount; i++)
	{
		let tmpPrices = tmpRandom.chance(0.1) ? 2 : 1;
		for (let j = 0; j < tmpPrices; j++)
		{
			let tmpID = tmpRows.BookPrice.length + 1;
			let tmpRow = { IDBookPrice: tmpID, GUIDBookPrice: `bp-${String(tmpID).padStart(6, '0')}-${tmpRandom.hex(8)}` };
			auditColumns(tmpRow, tmpRandom, tmpUserCount);
			let tmpStart = EPOCH_2019 + Math.floor(tmpRandom.next() * (EPOCH_2024_END - EPOCH_2019));
			let tmpEndRoll = tmpRandom.next();
			Object.assign(tmpRow,
				{
					Price: fromCents(tmpRandom.int(499, 5999)),
					StartDate: formatEpoch(tmpStart),
					EndDate: (tmpEndRoll < 0.6) ? null : ((tmpEndRoll < 0.65) ? '' : formatEpoch(tmpStart + tmpRandom.int(86400, 86400 * 400))),
					Discountable: tmpRandom.chance(0.3) ? 1 : 0,
					CouponCode: tmpRandom.chance(0.8) ? '' : `SAVE${tmpRandom.int(5, 30)}`,
					IDBook: i
				});
			tmpRows.BookPrice.push(tmpRow);
		}
	}
	let tmpBookPriceCount = tmpRows.BookPrice.length;

	// ---- BookStore
	tmpRandom = stream(pSeed, 'BookStore');
	tmpRows.BookStore = [];
	for (let i = 1; i <= tmpSize('BookStore'); i++)
	{
		let tmpRow = { IDBookStore: i, GUIDBookStore: `bs-${String(i).padStart(6, '0')}-${tmpRandom.hex(8)}` };
		auditColumns(tmpRow, tmpRandom, tmpUserCount, 0.05);
		Object.assign(tmpRow,
			{
				Name: `${tmpRandom.pick(TITLE_WORDS_B)} ${tmpRandom.pick(TITLE_WORDS_C)} Books #${i}`,
				Address: `${tmpRandom.int(1, 9999)} ${tmpRandom.pick(TITLE_WORDS_C)} Ave`,
				City: tmpRandom.pick(CITIES),
				State: tmpRandom.weighted(STATE_WEIGHTS),
				Postal: String(tmpRandom.int(10000, 99999)),
				Country: tmpRandom.weighted(COUNTRY_WEIGHTS)
			});
		tmpRows.BookStore.push(tmpRow);
	}
	let tmpStoreCount = tmpRows.BookStore.length;

	// ---- BookStoreEmployee
	tmpRandom = stream(pSeed, 'BookStoreEmployee');
	tmpRows.BookStoreEmployee = [];
	for (let i = 1; i <= tmpSize('BookStoreEmployee'); i++)
	{
		let tmpRow = { IDBookStoreEmployee: i, GUIDBookStoreEmployee: `bse-${String(i).padStart(6, '0')}-${tmpRandom.hex(8)}` };
		auditColumns(tmpRow, tmpRandom, tmpUserCount);
		let tmpActive = tmpRandom.chance(0.8);
		let tmpHire = EPOCH_2019 + Math.floor(tmpRandom.next() * (EPOCH_2024_END - EPOCH_2019));
		Object.assign(tmpRow,
			{
				Title: tmpRandom.weighted(STORE_TITLES),
				HireDate: formatEpoch(tmpHire),
				TerminationDate: tmpActive ? null : formatEpoch(Math.min(tmpHire + tmpRandom.int(86400 * 30, 86400 * 900), EPOCH_2025 - 1)),
				IsActive: tmpActive ? 1 : 0,
				IDUser: tmpRandom.int(1, tmpUserCount),
				IDBookStore: tmpRandom.int(1, tmpStoreCount),
				IDCustomer: null
			});
		tmpRows.BookStoreEmployee.push(tmpRow);
	}

	// ---- BookStoreInventory
	tmpRandom = stream(pSeed, 'BookStoreInventory');
	tmpRows.BookStoreInventory = [];
	for (let i = 1; i <= tmpSize('BookStoreInventory'); i++)
	{
		let tmpRow = { IDBookStoreInventory: i, GUIDBookStoreInventory: `bsi-${String(i).padStart(6, '0')}-${tmpRandom.hex(8)}` };
		auditColumns(tmpRow, tmpRandom, tmpUserCount);
		let tmpCount = tmpRandom.chance(0.01) ? null : Math.floor(50 * Math.pow(tmpRandom.next(), 1.5));
		Object.assign(tmpRow,
			{
				StockDate: tmpRandom.chance(0.02) ? null : tmpRandom.date(EPOCH_2021, EPOCH_2024_END),
				BookCount: tmpCount,
				AggregateBookCount: (tmpCount === null) ? null : tmpCount + tmpRandom.int(0, 200),
				IDBook: tmpRandom.skewedID(tmpBookCount, 1.5),
				IDBookStore: tmpRandom.int(1, tmpStoreCount),
				IDBookPrice: tmpRandom.int(1, tmpBookPriceCount),
				StockingAssociate: tmpRandom.chance(0.05) ? null : tmpRandom.int(1, tmpUserCount)
			});
		tmpRows.BookStoreInventory.push(tmpRow);
	}

	// ---- Review: skewed Rating (and a few NULL ratings)
	tmpRandom = stream(pSeed, 'Review');
	tmpRows.Review = [];
	for (let i = 1; i <= tmpSize('Review'); i++)
	{
		let tmpRow = { IDReview: i, GUIDReview: `rev-${String(i).padStart(6, '0')}-${tmpRandom.hex(8)}` };
		auditColumns(tmpRow, tmpRandom, tmpUserCount);
		let tmpRating = tmpRandom.weighted(RATING_WEIGHTS);
		Object.assign(tmpRow,
			{
				Text: (tmpRating === null) ? null : `${tmpRandom.pick([ 'Loved', 'Liked', 'Hated', 'Finished', 'Skimmed' ])} it.`,
				Rating: tmpRating,
				IDBook: tmpRandom.skewedID(tmpBookCount, 1.7),
				IDUser: tmpRandom.int(1, tmpUserCount)
			});
		tmpRows.Review.push(tmpRow);
	}

	// ---- BookStoreSale: SaleDate 2020-12-31 … 2024-12-30, TotalAmount outlier, missing stores
	tmpRandom = stream(pSeed, 'BookStoreSale');
	tmpRows.BookStoreSale = [];
	let tmpSaleCount = tmpSize('BookStoreSale');
	for (let i = 1; i <= tmpSaleCount; i++)
	{
		let tmpRow = { IDBookStoreSale: i, GUIDBookStoreSale: `sale-${String(i).padStart(6, '0')}-${tmpRandom.hex(8)}` };
		auditColumns(tmpRow, tmpRandom, tmpUserCount);
		let tmpSaleDate;
		if (i === 1)
		{
			tmpSaleDate = FIRST_SALE_DATE;
		}
		else if (i === tmpSaleCount)
		{
			tmpSaleDate = LAST_SALE_DATE;
		}
		else if (tmpRandom.chance(0.01))
		{
			tmpSaleDate = null;
		}
		else
		{
			tmpSaleDate = tmpRandom.date(EPOCH_2021, EPOCH_2024_END);
		}
		let tmpAmount;
		if (i === 11)
		{
			tmpAmount = fromCents(TOTAL_AMOUNT_OUTLIER_CENTS);
		}
		else if (tmpRandom.chance(0.005))
		{
			tmpAmount = null;
		}
		else
		{
			// Roughly bell-shaped between 8.49 and 291.21
			tmpAmount = fromCents(849 + Math.floor(((tmpRandom.next() + tmpRandom.next() + tmpRandom.next()) / 3) * (29121 - 849)));
		}
		let tmpStore = tmpRandom.chance(0.03) ? (MISSING_STORE_ID_BASE + tmpRandom.int(1, 50)) : tmpRandom.skewedID(tmpStoreCount, 1.3);
		Object.assign(tmpRow,
			{
				SaleDate: tmpSaleDate,
				TotalAmount: tmpAmount,
				PaymentMethod: tmpRandom.weighted(PAYMENT_WEIGHTS),
				TransactionID: `TX${tmpRandom.hex(16)}`,
				IDBookStore: tmpStore,
				IDUser: tmpRandom.int(1, tmpUserCount),
				IDCustomer: tmpRandom.chance(0.3) ? null : tmpRandom.int(1, tmpCustomerCount)
			});
		tmpRows.BookStoreSale.push(tmpRow);
	}

	// ---- BookStoreSaleItem: 1–3 per sale, LineTotal exact from cents
	tmpRandom = stream(pSeed, 'BookStoreSaleItem');
	tmpRows.BookStoreSaleItem = [];
	for (let i = 0; i < tmpRows.BookStoreSale.length; i++)
	{
		let tmpSale = tmpRows.BookStoreSale[i];
		let tmpItems = tmpRandom.weighted([ [ 1, 55 ], [ 2, 30 ], [ 3, 15 ] ]);
		for (let j = 0; j < tmpItems; j++)
		{
			let tmpID = tmpRows.BookStoreSaleItem.length + 1;
			let tmpRow = { IDBookStoreSaleItem: tmpID, GUIDBookStoreSaleItem: `item-${String(tmpID).padStart(6, '0')}-${tmpRandom.hex(8)}` };
			auditColumns(tmpRow, tmpRandom, tmpUserCount);
			let tmpQuantity = tmpRandom.weighted([ [ 1, 60 ], [ 2, 22 ], [ 3, 10 ], [ 4, 5 ], [ 5, 3 ] ]);
			let tmpUnitCents = tmpRandom.int(499, 5999);
			Object.assign(tmpRow,
				{
					Quantity: tmpQuantity,
					UnitPrice: fromCents(tmpUnitCents),
					LineTotal: fromCents(tmpQuantity * tmpUnitCents),
					IDBookStoreSale: tmpSale.IDBookStoreSale,
					IDBook: tmpRandom.skewedID(tmpBookCount, 1.5),
					IDBookPrice: tmpRandom.int(1, tmpBookPriceCount),
					IDCustomer: tmpSale.IDCustomer
				});
			tmpRows.BookStoreSaleItem.push(tmpRow);
		}
	}

	// ---- BookStoreCatalogJoin (no Deleted column): unique (IDBook, IDBookStore) pairs
	tmpRandom = stream(pSeed, 'BookStoreCatalogJoin');
	tmpRows.BookStoreCatalogJoin = [];
	let tmpPairs = {};
	let tmpAttempts = 0;
	while ((tmpRows.BookStoreCatalogJoin.length < tmpSize('BookStoreCatalogJoin')) && (tmpAttempts < tmpSize('BookStoreCatalogJoin') * 20))
	{
		tmpAttempts++;
		let tmpBook = tmpRandom.skewedID(tmpBookCount, 1.3);
		let tmpStore = tmpRandom.int(1, tmpStoreCount);
		let tmpPairKey = `${tmpBook}:${tmpStore}`;
		if (tmpPairs[tmpPairKey])
		{
			continue;
		}
		tmpPairs[tmpPairKey] = true;
		let tmpID = tmpRows.BookStoreCatalogJoin.length + 1;
		tmpRows.BookStoreCatalogJoin.push(
			{
				IDBookStoreCatalogJoin: tmpID, GUIDBookStoreCatalogJoin: `bscj-${String(tmpID).padStart(6, '0')}-${tmpRandom.hex(8)}`,
				IDBook: tmpBook, IDBookStore: tmpStore
			});
	}

	// ---- Traps: fixed rows, live (never soft-deleted), so default queries see them
	let fLive = (pRow) =>
	{
		pRow.Deleted = 0;
		pRow.DeleteDate = null;
		pRow.DeletingIDUser = 0;
		return pRow;
	};
	fLive(tmpRows.BookStoreSale[TRAP_SUB_SCALE_AMOUNT.IDBookStoreSale - 1]).TotalAmount = TRAP_SUB_SCALE_AMOUNT.TotalAmount;
	TRAP_SALE_DATES.forEach((pTrap) => { fLive(tmpRows.BookStoreSale[pTrap.IDBookStoreSale - 1]).SaleDate = pTrap.SaleDate; });
	TRAP_UNSAFE_GENRE.IDBooks.forEach((pID) => { fLive(tmpRows.Book[pID - 1]).Genre = TRAP_UNSAFE_GENRE.Genre; });
	TRAP_TEXT_BOOK_COUNTS.forEach((pTrap) => { fLive(tmpRows.BookStoreInventory[pTrap.IDBookStoreInventory - 1]).BookCount = pTrap.BookCount; });

	for (let i = 0; i < GENERATION_ORDER.length; i++)
	{
		ensureDeleted(tmpRows[GENERATION_ORDER[i]]);
	}

	return tmpRows;
};

/**
 * Bookstore-Tenant: stamp tenant 1 on the base rows, append the tenant-2 clone (~5 % of every
 * table, distinct IDs, FKs remapped into tenant 2) and seed cross-tenant references.
 *
 * @param {Record<string, Array<Record<string, any>>>} pRows - base rows (mutated)
 * @param {Record<string, any>} pModel
 * @param {number} pSeed
 */
const addSecondTenant = (pRows, pModel, pSeed) =>
{
	let tmpTables = GENERATION_ORDER;
	for (let i = 0; i < tmpTables.length; i++)
	{
		for (let j = 0; j < pRows[tmpTables[i]].length; j++)
		{
			pRows[tmpTables[i]][j][TENANT_COLUMN] = 1;
		}
	}

	// Tenant-1 ID → tenant-2 clone ID, per table; and the tenant-2 IDs of each table
	let tmpCloneMap = {};
	let tmpTenantTwoIDs = {};
	for (let i = 0; i < tmpTables.length; i++)
	{
		let tmpTable = tmpTables[i];
		let tmpRandom = stream(pSeed, `Tenant2:${tmpTable}`);
		let tmpPK = primaryKeyOf(pModel, tmpTable);
		let tmpForeignKeys = foreignKeysOf(pModel, tmpTable);
		let tmpBaseRows = pRows[tmpTable];
		let tmpNextID = tmpBaseRows.reduce((pMax, pRow) => { return Math.max(pMax, pRow[tmpPK]); }, 0) + 1;
		tmpCloneMap[tmpTable] = {};
		tmpTenantTwoIDs[tmpTable] = [];
		let tmpClones = [];
		for (let j = 0; j < tmpBaseRows.length; j++)
		{
			// ~5 %, plus the first and the middle row so even tiny tables have a tenant-2 copy
			if (!(tmpRandom.chance(0.05) || (j === 0) || (j === Math.floor(tmpBaseRows.length / 2))))
			{
				continue;
			}
			let tmpSource = tmpBaseRows[j];
			let tmpClone = Object.assign({}, tmpSource);
			tmpClone[tmpPK] = tmpNextID++;
			tmpClone[TENANT_COLUMN] = 2;
			let tmpGUIDColumn = pModel.Tables[tmpTable].Columns.find((pColumn) => { return pColumn.DataType === 'GUID'; });
			if (tmpGUIDColumn)
			{
				tmpClone[tmpGUIDColumn.Column] = `t2-${tmpSource[tmpGUIDColumn.Column]}`;
			}
			tmpCloneMap[tmpTable][tmpSource[tmpPK]] = tmpClone[tmpPK];
			tmpTenantTwoIDs[tmpTable].push(tmpClone[tmpPK]);
			tmpClones.push({ Row: tmpClone, KeepParent: tmpRandom.chance(0.05) });
		}
		// Remap FKs into tenant 2 (a few clones keep their tenant-1 parent: cross-tenant references)
		for (let j = 0; j < tmpClones.length; j++)
		{
			let tmpClone = tmpClones[j].Row;
			for (let k = 0; k < tmpForeignKeys.length; k++)
			{
				let tmpColumn = tmpForeignKeys[k].Column;
				let tmpTarget = tmpForeignKeys[k].Target;
				let tmpValue = tmpClone[tmpColumn];
				if ((tmpValue === null) || (typeof(tmpValue) === 'undefined') || tmpClones[j].KeepParent || !tmpCloneMap[tmpTarget])
				{
					continue;
				}
				if (tmpCloneMap[tmpTarget].hasOwnProperty(tmpValue))
				{
					tmpClone[tmpColumn] = tmpCloneMap[tmpTarget][tmpValue];
				}
				else if (tmpTenantTwoIDs[tmpTarget].length > 0)
				{
					tmpClone[tmpColumn] = tmpRandom.pick(tmpTenantTwoIDs[tmpTarget]);
				}
			}
			pRows[tmpTable].push(tmpClone);
		}
	}

	// A few tenant-1 rows pointed at tenant-2 parents
	let tmpRandom = stream(pSeed, 'Tenant1:CrossReferences');
	let tmpCrossTargets = [ [ 'Review', 'IDBook', 'Book' ], [ 'BookStoreSale', 'IDBookStore', 'BookStore' ], [ 'BookAuthorJoin', 'IDAuthor', 'Author' ] ];
	for (let i = 0; i < tmpCrossTargets.length; i++)
	{
		let tmpTable = tmpCrossTargets[i][0];
		let tmpTargetIDs = tmpTenantTwoIDs[tmpCrossTargets[i][2]];
		let tmpTenantOneRows = pRows[tmpTable].filter((pRow) => { return pRow[TENANT_COLUMN] === 1; });
		for (let j = 0; (j < 5) && (tmpTargetIDs.length > 0); j++)
		{
			let tmpRow = tmpRandom.pick(tmpTenantOneRows);
			tmpRow[tmpCrossTargets[i][1]] = tmpRandom.pick(tmpTargetIDs);
		}
	}
};

/**
 * Insert every generated row (one transaction).
 *
 * @param {any} pDB
 * @param {Record<string, any>} pModel
 * @param {Record<string, Array<Record<string, any>>>} pRows
 */
const insertRows = (pDB, pModel, pRows) =>
{
	pDB.exec('BEGIN');
	try
	{
		for (let i = 0; i < GENERATION_ORDER.length; i++)
		{
			let tmpTable = GENERATION_ORDER[i];
			let tmpColumns = pModel.Tables[tmpTable].Columns.map((pColumn) => { return pColumn.Column; });
			let tmpStatement = pDB.prepare(`INSERT INTO "${tmpTable}" (${tmpColumns.map((pColumn) => { return `"${pColumn}"`; }).join(', ')}) VALUES (${tmpColumns.map(() => { return '?'; }).join(', ')})`);
			let tmpTableRows = pRows[tmpTable] || [];
			for (let j = 0; j < tmpTableRows.length; j++)
			{
				let tmpRow = tmpTableRows[j];
				tmpStatement.run(...tmpColumns.map(
					(pColumn) =>
					{
						return (tmpRow.hasOwnProperty(pColumn) && (typeof(tmpRow[pColumn]) !== 'undefined')) ? tmpRow[pColumn] : null;
					}));
			}
		}
		pDB.exec('COMMIT');
	}
	catch (pError)
	{
		pDB.exec('ROLLBACK');
		throw pError;
	}
};

/**
 * Row counts (all rows, and non-deleted rows) per table, optionally restricted to one tenant.
 *
 * @param {any} pDB
 * @param {Record<string, any>} pModel
 * @param {number} [pTenant]
 * @return {{ Counts: Record<string, number>, LiveCounts: Record<string, number> }}
 */
const countRows = (pDB, pModel, pTenant) =>
{
	let tmpCounts = {};
	let tmpLiveCounts = {};
	let tmpTables = Object.keys(pModel.Tables);
	for (let i = 0; i < tmpTables.length; i++)
	{
		let tmpTable = tmpTables[i];
		let tmpTerms = [];
		let tmpBinds = [];
		if (typeof(pTenant) === 'number')
		{
			tmpTerms.push(`"${TENANT_COLUMN}" = ?`);
			tmpBinds.push(pTenant);
		}
		let tmpWhere = (tmpTerms.length > 0) ? ` WHERE ${tmpTerms.join(' AND ')}` : '';
		tmpCounts[tmpTable] = Number(pDB.prepare(`SELECT count(*) AS N FROM "${tmpTable}"${tmpWhere}`).get(...tmpBinds).N);
		if (hasColumn(pModel, tmpTable, 'Deleted'))
		{
			let tmpLiveWhere = ` WHERE ${tmpTerms.concat([ '"Deleted" = 0' ]).join(' AND ')}`;
			tmpLiveCounts[tmpTable] = Number(pDB.prepare(`SELECT count(*) AS N FROM "${tmpTable}"${tmpLiveWhere}`).get(...tmpBinds).N);
		}
		else
		{
			tmpLiveCounts[tmpTable] = tmpCounts[tmpTable];
		}
	}
	return { Counts: tmpCounts, LiveCounts: tmpLiveCounts };
};

/**
 * A content fingerprint of the whole database (sha256 over every table's rows in PK order).
 * Same seed → same fingerprint (the determinism test).
 *
 * @param {any} pDB
 * @param {Record<string, any>} pModel
 * @return {string}
 */
const fingerprint = (pDB, pModel) =>
{
	let tmpHash = libCrypto.createHash('sha256');
	let tmpTables = Object.keys(pModel.Tables).sort();
	for (let i = 0; i < tmpTables.length; i++)
	{
		let tmpPK = primaryKeyOf(pModel, tmpTables[i]);
		let tmpRows = pDB.prepare(`SELECT * FROM "${tmpTables[i]}" ORDER BY "${tmpPK}"`).all();
		tmpHash.update(tmpTables[i]);
		for (let j = 0; j < tmpRows.length; j++)
		{
			tmpHash.update(JSON.stringify(Object.assign({}, tmpRows[j])));
		}
	}
	return tmpHash.digest('hex');
};

/**
 * The traps tests can rely on (values, not row positions).
 *
 * @return {Record<string, any>}
 */
const traps = () =>
{
	return (
		{
			FirstSaleDate: FIRST_SALE_DATE,
			LastSaleDate: LAST_SALE_DATE,
			PublicationYearOutlier: PUBLICATION_YEAR_OUTLIER,
			TotalAmountOutlier: fromCents(TOTAL_AMOUNT_OUTLIER_CENTS),
			MissingStoreIDBase: MISSING_STORE_ID_BASE,
			SubScaleAmount: TRAP_SUB_SCALE_AMOUNT.TotalAmount,
			BoundarySaleDates: TRAP_SALE_DATES.map((pTrap) => { return pTrap.SaleDate; }),
			UnsafeGenre: TRAP_UNSAFE_GENRE.Genre,
			TextBookCounts: TRAP_TEXT_BOOK_COUNTS.map((pTrap) => { return pTrap.BookCount; })
		});
};

/**
 * Generate the deterministic rows WITHOUT touching a database (internal-contracts §31.6): the
 * provider hook inserts the same rows into PostgreSQL (test/support/Facet-Harness-Providers.js).
 *
 * @param {{ Fixture?: string, Seed?: number, Scale?: string }} [pOptions]
 * @return {{ Fixture: string, Seed: number, Scale: string, Model: Record<string, any>, Rows: Record<string, Array<Record<string, any>>>, Order: Array<string>, Tenants: Array<number>, TenantColumn: string|null, Traps: Record<string, any> }}
 */
const generate = (pOptions) =>
{
	let tmpOptions = pOptions || {};
	let tmpFixture = tmpOptions.Fixture || 'Bookstore';
	let tmpSeed = (typeof(tmpOptions.Seed) === 'number') ? tmpOptions.Seed : DEFAULT_SEED;
	let tmpScale = tmpOptions.Scale || 'Small';
	if (!SCALES.hasOwnProperty(tmpScale))
	{
		throw new Error(`Unknown fixture scale [${tmpScale}] (Small | Medium).`);
	}
	let tmpModel = model(tmpFixture);
	let tmpIsTenant = (tmpFixture === 'Bookstore-Tenant');
	let tmpRows = generateBase(tmpSeed, SCALES[tmpScale]);
	if (tmpIsTenant)
	{
		addSecondTenant(tmpRows, tmpModel, tmpSeed);
	}
	return (
		{
			Fixture: tmpFixture,
			Seed: tmpSeed,
			Scale: tmpScale,
			Model: tmpModel,
			Rows: tmpRows,
			Order: GENERATION_ORDER.slice(),
			Tenants: tmpIsTenant ? [ 1, 2 ] : [],
			TenantColumn: tmpIsTenant ? TENANT_COLUMN : null,
			Traps: traps()
		});
};

/**
 * Create the tables and generate the deterministic rows.
 *
 * @param {any} pDB - node:sqlite DatabaseSync
 * @param {{ Fixture?: string, Seed?: number, Scale?: string }} [pOptions]
 * @return {{ Fixture: string, Seed: number, Scale: string, Model: Record<string, any>, Counts: Record<string, number>, LiveCounts: Record<string, number>, Tenants: Array<number>, TenantCounts: Record<string, any>, TenantLiveCounts: Record<string, any>, Traps: Record<string, any> }}
 */
const build = (pDB, pOptions) =>
{
	let tmpGenerated = generate(pOptions);
	let tmpFixture = tmpGenerated.Fixture;
	let tmpSeed = tmpGenerated.Seed;
	let tmpScale = tmpGenerated.Scale;
	let tmpModel = tmpGenerated.Model;

	createTables(pDB, tmpModel);
	insertRows(pDB, tmpModel, tmpGenerated.Rows);
	createIndexes(pDB, tmpModel);

	let tmpAll = countRows(pDB, tmpModel);
	let tmpTenantCounts = {};
	let tmpTenantLiveCounts = {};
	let tmpTenants = tmpGenerated.Tenants;
	for (let i = 0; i < tmpTenants.length; i++)
	{
		let tmpCounted = countRows(pDB, tmpModel, tmpTenants[i]);
		tmpTenantCounts[tmpTenants[i]] = tmpCounted.Counts;
		tmpTenantLiveCounts[tmpTenants[i]] = tmpCounted.LiveCounts;
	}

	return (
		{
			Fixture: tmpFixture,
			Seed: tmpSeed,
			Scale: tmpScale,
			Model: tmpModel,
			Counts: tmpAll.Counts,
			LiveCounts: tmpAll.LiveCounts,
			Tenants: tmpTenants,
			TenantCounts: tmpTenantCounts,
			TenantLiveCounts: tmpTenantLiveCounts,
			// The fixed traps tests can rely on (values, not row positions)
			Traps: tmpGenerated.Traps
		});
};

module.exports = (
	{
		BOOKSTORE_MODEL_PATH: BOOKSTORE_MODEL_PATH,
		DEFAULT_SEED: DEFAULT_SEED,
		FIXTURES: FIXTURES,
		SCALES: SCALES,
		TENANT_COLUMN: TENANT_COLUMN,
		prng: prng,
		stream: stream,
		model: model,
		sqliteType: sqliteType,
		createTables: createTables,
		indexColumns: indexColumns,
		createIndexes: createIndexes,
		primaryKeyOf: primaryKeyOf,
		foreignKeysOf: foreignKeysOf,
		fingerprint: fingerprint,
		GENERATION_ORDER: GENERATION_ORDER,
		generate: generate,
		insertRows: insertRows,
		countRows: countRows,
		build: build
	});
