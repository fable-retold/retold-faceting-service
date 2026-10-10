/**
 * debug/m5-keymap-bench.js — the keymap point read at scale (M5 review, perf-ops: readKeys used FINAL).
 *
 * Builds a scratch keymap of KEYMAP_ROWS rows (default 10 000 000: ~95 % live keys, ~3 % moved IDs with a
 * retired old key, ~2 % hard-deleted IDs) in two layouts — index_granularity 8192 (the old DDL) and 256
 * (the new keymap DDL) — inside the throwaway rfs-test-clickhouse container, then times the readKeys
 * shapes for random batches of KEYMAP_BATCH IDs (default 2000; a write-path cycle of a steady stream is
 * nearer 50):
 *
 *   FINAL + `_IsDeleted` = 0          (the M5 build)
 *   no FINAL, latest version in JS    (the review fix: StoreClickHouse._liveKeyEntries)
 *
 * and reports wall time and the rows ClickHouse read (system.query_log).  The scratch database is
 * rfs_<pid>_9999 (the test container's leftover sweep drops it if this script dies) and is dropped at
 * the end.
 *
 *   node debug/m5-keymap-bench.js            # KEYMAP_ROWS=2000000 for a quick run; KEYMAP_BATCH=50 for small cycles
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libSupport = require('../test/support/Facet-ClickHouse-Support.js');
const libClickHouseClient = require('../source/store/clickhouse/ClickHouse-Client.js');

const ROWS = Math.max(100000, parseInt(process.env.KEYMAP_ROWS || '10000000', 10));
const BATCH = Math.max(1, parseInt(process.env.KEYMAP_BATCH || '2000', 10));
const ROUNDS = 12;
const DATABASE = `rfs_${process.pid}_9999`;

let _Client = null;

const run = (pSQL, pSettings) =>
{
	return new Promise((fResolve, fReject) => { _Client.command(pSQL, null, pSettings || null, (pError) => { return pError ? fReject(pError) : fResolve(); }); });
};

const rows = (pSQL, pParams, pSettings) =>
{
	return new Promise((fResolve, fReject) => { _Client.query(pSQL, pParams || null, pSettings || null, (pError, pRows) => { return pError ? fReject(pError) : fResolve(pRows); }); });
};

const keymapDDL = (pTable, pGranularity) =>
{
	return `CREATE TABLE \`${DATABASE}\`.\`${pTable}\` (\`IDTask\` Int64, \`IDCustomer\` Int64, \`IDProject\` Nullable(Int64), \`UpdateDate\` Nullable(DateTime64(3, 'UTC')), \`_Version\` UInt64, \`_IsDeleted\` UInt8) `
		+ `ENGINE = ReplacingMergeTree(\`_Version\`, \`_IsDeleted\`) ORDER BY (\`IDTask\`, \`IDCustomer\`) SETTINGS index_granularity = ${pGranularity}`;
};

const fill = async (pTable) =>
{
	// Every ID: a live key at tenant 1 + (n % 7).  3 %: moved — the old key retired, a new key live.  2 %:
	// hard-deleted — the only key retired.
	await run(`INSERT INTO \`${DATABASE}\`.\`${pTable}\` SELECT number + 1, 1 + (number % 7), number % 1000, now64(3), 1, 0 FROM numbers(${ROWS})`, { max_insert_threads: 4 });
	await run(`INSERT INTO \`${DATABASE}\`.\`${pTable}\` SELECT number + 1, 1 + (number % 7), number % 1000, now64(3), 2, 1 FROM numbers(${ROWS}) WHERE (number % 100) < 5`);
	await run(`INSERT INTO \`${DATABASE}\`.\`${pTable}\` SELECT number + 1, 9, number % 1000, now64(3), 2, 0 FROM numbers(${ROWS}) WHERE (number % 100) < 3`);
	await run(`OPTIMIZE TABLE \`${DATABASE}\`.\`${pTable}\``).catch(() => { return null; });
};

const randomIDs = () =>
{
	let tmpIDs = new Set();
	while (tmpIDs.size < BATCH)
	{
		tmpIDs.add(1 + Math.floor(Math.random() * ROWS));
	}
	return Array.from(tmpIDs);
};

const measure = async (pLabel, pSQL) =>
{
	let tmpTimes = [];
	let tmpTag = `rfs-bench-${process.pid}-${pLabel.replace(/[^a-z0-9]/gi, '-')}`;
	for (let i = 0; i < ROUNDS; i++)
	{
		let tmpStart = process.hrtime.bigint();
		await rows(pSQL, { ids: randomIDs() }, { log_comment: tmpTag });
		tmpTimes.push(Number(process.hrtime.bigint() - tmpStart) / 1e6);
	}
	await run('SYSTEM FLUSH LOGS').catch(() => { return null; });
	let tmpLog = await rows("SELECT avg(read_rows) AS R, avg(query_duration_ms) AS D FROM system.query_log WHERE type = 'QueryFinish' AND log_comment = {tag:String}", { tag: tmpTag }).catch(() => { return [ {} ]; });
	tmpTimes.sort((pA, pB) => { return pA - pB; });
	let tmpMedian = tmpTimes[Math.floor(tmpTimes.length / 2)];
	console.log(`  ${pLabel.padEnd(34)} median ${tmpMedian.toFixed(1).padStart(7)} ms (server ${Number(tmpLog[0].D || 0).toFixed(0).padStart(4)} ms), rows read ${Math.round(Number(tmpLog[0].R || 0)).toLocaleString()}`);
	return { Label: pLabel, MedianMS: tmpMedian, ReadRows: Number(tmpLog[0].R || 0) };
};

const main = async () =>
{
	await new Promise((fResolve, fReject) => { libSupport.ensure((pError) => { return pError ? fReject(pError) : fResolve(); }); });
	let tmpInfo = libSupport.connectionInfo();
	_Client = new libClickHouseClient({ URL: tmpInfo.URL, User: tmpInfo.User, Password: tmpInfo.Password, Database: null, TimeoutMS: 600000 });
	console.log(`m5-keymap-bench: ${ROWS.toLocaleString()} keymap rows per layout, batches of ${BATCH} random IDs, ${ROUNDS} rounds each (database ${DATABASE}).`);
	await run(`DROP DATABASE IF EXISTS \`${DATABASE}\` SYNC`);
	await run(`CREATE DATABASE \`${DATABASE}\` ENGINE = Atomic`);
	try
	{
		for (let tmpGranularity of [ 8192, 256 ])
		{
			let tmpTable = `_rfs_keys_Task_g${tmpGranularity}`;
			let tmpStart = Date.now();
			await run(keymapDDL(tmpTable, tmpGranularity));
			await fill(tmpTable);
			console.log(`index_granularity ${tmpGranularity} (filled in ${((Date.now() - tmpStart) / 1000).toFixed(1)} s):`);
			let tmpQualified = `\`${DATABASE}\`.\`${tmpTable}\``;
			await measure(`FINAL, _IsDeleted = 0 (g${tmpGranularity})`, `SELECT IDTask, IDCustomer, IDProject, UpdateDate, _Version FROM ${tmpQualified} FINAL WHERE _IsDeleted = 0 AND IDTask IN {ids:Array(Int64)}`);
			await measure(`no FINAL, latest in JS (g${tmpGranularity})`, `SELECT IDTask, IDCustomer, IDProject, UpdateDate, _Version, _IsDeleted FROM ${tmpQualified} WHERE IDTask IN {ids:Array(Int64)}`);
		}
	}
	finally
	{
		await run(`DROP DATABASE IF EXISTS \`${DATABASE}\` SYNC`).catch(() => { return null; });
		_Client.close();
	}
};

main().then(() => { process.exit(0); }, (pError) => { console.error(`m5-keymap-bench failed: ${pError.message}`); process.exit(1); });
