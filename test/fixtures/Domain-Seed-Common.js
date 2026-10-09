/**
 * Domain-Seed-Common — the helpers the ProjectTrack and LabTrack seed modules share (internal-contracts
 * §31): deterministic row building (one PRNG stream per table, Bookstore-Seed.stream), the standard
 * audit columns, generic insert / count over any model and tenant column, and the build() result.
 *
 * Every helper is generic over the model; nothing here knows a domain.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libBookstoreSeed = require('./Bookstore-Seed.js');

// Epoch-second windows of the audit columns (UTC; dates are naive wall clock, D-22).
const AUDIT_EPOCH_START = Date.UTC(2023, 0, 1) / 1000;
const AUDIT_EPOCH_END = Date.UTC(2025, 11, 1) / 1000;

// The audit / delete columns every soft-deletable fixture table carries.
const AUDIT_COLUMNS = Object.freeze([ 'CreateDate', 'CreatingIDUser', 'UpdateDate', 'UpdatingIDUser', 'Deleted', 'DeleteDate', 'DeletingIDUser' ]);

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
 * A UTC wall-clock instant → epoch seconds.
 *
 * @param {number} pYear
 * @param {number} pMonth - 1-based
 * @param {number} pDay
 * @param {number} [pHour]
 * @param {number} [pMinute]
 * @param {number} [pSecond]
 * @return {number}
 */
const epoch = (pYear, pMonth, pDay, pHour, pMinute, pSecond) =>
{
	return Date.UTC(pYear, pMonth - 1, pDay, pHour || 0, pMinute || 0, pSecond || 0) / 1000;
};

/**
 * A random 'YYYY-MM-DD HH:mm:ss' in [pLoEpoch, pHiEpoch).
 *
 * @param {Record<string, Function>} pRandom - a Bookstore-Seed.stream
 * @param {number} pLoEpoch
 * @param {number} pHiEpoch
 * @return {string}
 */
const randomDate = (pRandom, pLoEpoch, pHiEpoch) =>
{
	return formatEpoch(pLoEpoch + Math.floor(pRandom.next() * (pHiEpoch - pLoEpoch)));
};

/**
 * A deterministic 36-character GUID (8-4-4-4-12 hex) from a stream.
 *
 * @param {Record<string, Function>} pRandom
 * @return {string}
 */
const guid = (pRandom) =>
{
	return `${pRandom.hex(8)}-${pRandom.hex(4)}-${pRandom.hex(4)}-${pRandom.hex(4)}-${pRandom.hex(12)}`;
};

/**
 * Fill the audit columns of a row.  pDeleted: true / false forces the soft delete; undefined rolls
 * pDeletedRate (default 3 %).
 *
 * @param {Record<string, any>} pRow
 * @param {Record<string, Function>} pRandom
 * @param {Array<number>} pUserIDs - the users of the row's tenant (audit user columns)
 * @param {boolean} [pDeleted]
 * @param {number} [pDeletedRate]
 * @return {Record<string, any>} pRow
 */
const audit = (pRow, pRandom, pUserIDs, pDeleted, pDeletedRate) =>
{
	let tmpCreate = AUDIT_EPOCH_START + Math.floor(pRandom.next() * (AUDIT_EPOCH_END - AUDIT_EPOCH_START));
	pRow.CreateDate = formatEpoch(tmpCreate);
	pRow.CreatingIDUser = pRandom.pick(pUserIDs);
	pRow.UpdateDate = formatEpoch(tmpCreate + pRandom.int(0, 86400 * 30));
	pRow.UpdatingIDUser = pRandom.pick(pUserIDs);
	let tmpDeleted = (typeof(pDeleted) === 'boolean') ? pDeleted : pRandom.chance((typeof(pDeletedRate) === 'number') ? pDeletedRate : 0.03);
	pRow.Deleted = tmpDeleted ? 1 : 0;
	pRow.DeleteDate = tmpDeleted ? formatEpoch(tmpCreate + pRandom.int(86400, 86400 * 60)) : null;
	pRow.DeletingIDUser = tmpDeleted ? pRandom.pick(pUserIDs) : 0;
	return pRow;
};

/**
 * Mark a row soft-deleted (keeps its other values).
 *
 * @param {Record<string, any>} pRow
 * @return {Record<string, any>}
 */
const softDelete = (pRow) =>
{
	pRow.Deleted = 1;
	pRow.DeleteDate = pRow.UpdateDate || '2025-06-01 00:00:00';
	pRow.DeletingIDUser = pRow.UpdatingIDUser || 1;
	return pRow;
};

/**
 * Column names of a model table.
 *
 * @param {Record<string, any>} pModel
 * @param {string} pTable
 * @return {Array<string>}
 */
const columnsOf = (pModel, pTable) =>
{
	return pModel.Tables[pTable].Columns.map((pColumn) => { return pColumn.Column; });
};

/**
 * Does a model table have a column?
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
 * Complete every row with the table's columns (absent → null) and refuse a key the model does not
 * have (a generator bug would otherwise silently drop data).
 *
 * @param {Record<string, any>} pModel
 * @param {Record<string, Array<Record<string, any>>>} pRows
 */
const completeRows = (pModel, pRows) =>
{
	let tmpTables = Object.keys(pRows);
	for (let i = 0; i < tmpTables.length; i++)
	{
		let tmpTable = tmpTables[i];
		if (!pModel.Tables[tmpTable])
		{
			throw new Error(`Domain seed: rows for an unknown table [${tmpTable}].`);
		}
		let tmpColumns = columnsOf(pModel, tmpTable);
		let tmpKnown = new Set(tmpColumns);
		for (let j = 0; j < pRows[tmpTable].length; j++)
		{
			let tmpRow = pRows[tmpTable][j];
			let tmpKeys = Object.keys(tmpRow);
			for (let k = 0; k < tmpKeys.length; k++)
			{
				if (!tmpKnown.has(tmpKeys[k]))
				{
					throw new Error(`Domain seed: ${tmpTable} row ${j} has a column the model does not [${tmpKeys[k]}].`);
				}
			}
			for (let k = 0; k < tmpColumns.length; k++)
			{
				if (typeof(tmpRow[tmpColumns[k]]) === 'undefined')
				{
					tmpRow[tmpColumns[k]] = null;
				}
			}
		}
	}
};

/**
 * Insert the rows of every table in pOrder (one transaction; node:sqlite).
 *
 * @param {any} pDB - node:sqlite DatabaseSync
 * @param {Record<string, any>} pModel
 * @param {Record<string, Array<Record<string, any>>>} pRows
 * @param {Array<string>} pOrder - parents first
 */
const insertRows = (pDB, pModel, pRows, pOrder) =>
{
	pDB.exec('BEGIN');
	try
	{
		for (let i = 0; i < pOrder.length; i++)
		{
			let tmpTable = pOrder[i];
			let tmpColumns = columnsOf(pModel, tmpTable);
			let tmpStatement = pDB.prepare(`INSERT INTO "${tmpTable}" (${tmpColumns.map((pColumn) => { return `"${pColumn}"`; }).join(', ')}) VALUES (${tmpColumns.map(() => { return '?'; }).join(', ')})`);
			let tmpTableRows = pRows[tmpTable] || [];
			for (let j = 0; j < tmpTableRows.length; j++)
			{
				let tmpRow = tmpTableRows[j];
				tmpStatement.run(...tmpColumns.map((pColumn) => { return (typeof(tmpRow[pColumn]) === 'undefined') ? null : tmpRow[pColumn]; }));
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
 * Row counts (all rows, non-deleted rows) per table, optionally for one tenant (tables without the
 * tenant column are global: counted whole for every tenant).
 *
 * @param {any} pDB
 * @param {Record<string, any>} pModel
 * @param {string} pTenantColumn
 * @param {number} [pTenant]
 * @return {{ Counts: Record<string, number>, LiveCounts: Record<string, number> }}
 */
const countRows = (pDB, pModel, pTenantColumn, pTenant) =>
{
	let tmpCounts = {};
	let tmpLiveCounts = {};
	let tmpTables = Object.keys(pModel.Tables);
	for (let i = 0; i < tmpTables.length; i++)
	{
		let tmpTable = tmpTables[i];
		let tmpTerms = [];
		let tmpBinds = [];
		if ((typeof(pTenant) === 'number') && hasColumn(pModel, tmpTable, pTenantColumn))
		{
			tmpTerms.push(`"${pTenantColumn}" = ?`);
			tmpBinds.push(pTenant);
		}
		let tmpWhere = (tmpTerms.length > 0) ? ` WHERE ${tmpTerms.join(' AND ')}` : '';
		tmpCounts[tmpTable] = Number(pDB.prepare(`SELECT count(*) AS N FROM "${tmpTable}"${tmpWhere}`).get(...tmpBinds).N);
		if (hasColumn(pModel, tmpTable, 'Deleted'))
		{
			tmpLiveCounts[tmpTable] = Number(pDB.prepare(`SELECT count(*) AS N FROM "${tmpTable}" WHERE ${tmpTerms.concat([ '"Deleted" = 0' ]).join(' AND ')}`).get(...tmpBinds).N);
		}
		else
		{
			tmpLiveCounts[tmpTable] = tmpCounts[tmpTable];
		}
	}
	return { Counts: tmpCounts, LiveCounts: tmpLiveCounts };
};

/**
 * Row counts from generated rows (no database): the same shape as countRows.
 *
 * @param {Record<string, any>} pModel
 * @param {Record<string, Array<Record<string, any>>>} pRows
 * @param {string} pTenantColumn
 * @param {number} [pTenant]
 * @return {{ Counts: Record<string, number>, LiveCounts: Record<string, number> }}
 */
const countGenerated = (pModel, pRows, pTenantColumn, pTenant) =>
{
	let tmpCounts = {};
	let tmpLiveCounts = {};
	let tmpTables = Object.keys(pModel.Tables);
	for (let i = 0; i < tmpTables.length; i++)
	{
		let tmpTable = tmpTables[i];
		let tmpRows = pRows[tmpTable] || [];
		if ((typeof(pTenant) === 'number') && hasColumn(pModel, tmpTable, pTenantColumn))
		{
			tmpRows = tmpRows.filter((pRow) => { return pRow[pTenantColumn] === pTenant; });
		}
		tmpCounts[tmpTable] = tmpRows.length;
		tmpLiveCounts[tmpTable] = hasColumn(pModel, tmpTable, 'Deleted') ? tmpRows.filter((pRow) => { return pRow.Deleted === 0; }).length : tmpRows.length;
	}
	return { Counts: tmpCounts, LiveCounts: tmpLiveCounts };
};

/**
 * The build() result over a generate() result: createTables + insert + counts (internal-contracts §31.6).
 * Rows are kept on the result (the harness's tenant-isolation oracle reads them).
 *
 * @param {any} pDB - node:sqlite DatabaseSync
 * @param {Record<string, any>} pGenerated - a domain generate() result
 * @return {Record<string, any>}
 */
const buildFromGenerated = (pDB, pGenerated) =>
{
	let tmpModel = pGenerated.Model;
	libBookstoreSeed.createTables(pDB, tmpModel);
	insertRows(pDB, tmpModel, pGenerated.Rows, pGenerated.Order);
	libBookstoreSeed.createIndexes(pDB, tmpModel);

	let tmpAll = countRows(pDB, tmpModel, pGenerated.TenantColumn);
	let tmpTenantCounts = {};
	let tmpTenantLiveCounts = {};
	for (let i = 0; i < pGenerated.Tenants.length; i++)
	{
		let tmpCounted = countRows(pDB, tmpModel, pGenerated.TenantColumn, pGenerated.Tenants[i]);
		tmpTenantCounts[pGenerated.Tenants[i]] = tmpCounted.Counts;
		tmpTenantLiveCounts[pGenerated.Tenants[i]] = tmpCounted.LiveCounts;
	}
	return (
		{
			Fixture: pGenerated.Fixture,
			Seed: pGenerated.Seed,
			Scale: pGenerated.Scale,
			Model: tmpModel,
			Counts: tmpAll.Counts,
			LiveCounts: tmpAll.LiveCounts,
			Tenants: pGenerated.Tenants.slice(),
			TenantColumn: pGenerated.TenantColumn,
			TenantCounts: tmpTenantCounts,
			TenantLiveCounts: tmpTenantLiveCounts,
			Traps: pGenerated.Traps,
			Principals: pGenerated.Principals,
			Rows: pGenerated.Rows,
			Order: pGenerated.Order.slice()
		});
};

/**
 * Resolve { Seed, Scale } with the domain defaults.
 *
 * @param {Record<string, any>} pOptions
 * @param {number} pDefaultSeed
 * @param {Record<string, number>} pScales
 * @return {{ Seed: number, Scale: string, Multiplier: number }}
 */
const resolveOptions = (pOptions, pDefaultSeed, pScales) =>
{
	let tmpOptions = pOptions || {};
	let tmpSeed = (typeof(tmpOptions.Seed) === 'number') ? tmpOptions.Seed : pDefaultSeed;
	let tmpScale = tmpOptions.Scale || 'Small';
	if (!Object.prototype.hasOwnProperty.call(pScales, tmpScale))
	{
		throw new Error(`Unknown fixture scale [${tmpScale}] (${Object.keys(pScales).join(' | ')}).`);
	}
	return { Seed: tmpSeed, Scale: tmpScale, Multiplier: pScales[tmpScale] };
};

/**
 * Inclusive integer list [pLo … pHi].
 *
 * @param {number} pLo
 * @param {number} pHi
 * @return {Array<number>}
 */
const range = (pLo, pHi) =>
{
	let tmpList = [];
	for (let i = pLo; i <= pHi; i++)
	{
		tmpList.push(i);
	}
	return tmpList;
};

module.exports = (
	{
		AUDIT_COLUMNS: AUDIT_COLUMNS,
		stream: libBookstoreSeed.stream,
		prng: libBookstoreSeed.prng,
		createTables: libBookstoreSeed.createTables,
		formatEpoch: formatEpoch,
		epoch: epoch,
		randomDate: randomDate,
		guid: guid,
		audit: audit,
		softDelete: softDelete,
		columnsOf: columnsOf,
		hasColumn: hasColumn,
		completeRows: completeRows,
		insertRows: insertRows,
		countRows: countRows,
		countGenerated: countGenerated,
		buildFromGenerated: buildFromGenerated,
		resolveOptions: resolveOptions,
		range: range
	});
