/**
 * Faceting-Demo-Domains -- boot the three seeded domains (DEMO-SPEC §2.2).
 *
 * Each domain is one test-harness instance (test/support/Facet-Test-Harness.js start()): its own fable, an
 * in-memory SQLite (or, with DEMO_PG=1, a throwaway rfs_* database in the rfs-test-postgres container),
 * the seed, a plain retold-data-service with the policy behaviors of internal-contracts §31.2, and faceting
 * attached Embedded through installOnRetoldDataService with the domain's definitions.  The harness binds an
 * EPHEMERAL port (its Port option is only a registry tag, 19196-19198 here); the front server proxies to
 * harness.baseURL (127.0.0.1:<ephemeral>).
 *
 *   ProjectTrack   Fixture 'ProjectTrack'      Definitions 'Auto' (ProjectTrack-Definitions.json)
 *   LabTrack       Fixture 'LabTrack'          Definitions 'Auto' (LabTrack-Definitions.json)
 *   Bookstore      Fixture 'Bookstore-Tenant'  Definitions [ definitions/Bookstore-Demo-Definitions.json ]
 *
 * Each domain server is private to this machine twice over: the harness binds it to 127.0.0.1 only (its Host
 * option; Orator itself has no host option and would listen on every interface), and the loopback guard (a
 * restify pre() answering 403 DEMO_LOOPBACK_ONLY to any non-loopback client) is installed through the
 * harness's BeforeListen hook, i.e. before the server accepts its first connection.  The harness's test
 * session headers (x-facet-test-*) must only ever come from the front server.  After each boot: renumber the
 * story principals (Faceting-Demo-Personas.RENUMBER), then install the write guards (Faceting-Demo-Writes,
 * internal-contracts §47.5).
 *
 * M4: every domain runs faceting with FACETING_OPTIONS (Cache.Enabled: true -- the result cache, the generation
 * Version and the 304 short-circuit; the change intake and GET /1.0/Facet/Changes run with their defaults: every
 * demo domain has a scope policy, so SSE.Enabled 'Auto' mounts the stream).  The demo may enable the cache because
 * every write reaches the intake and runs in this one process: the only writes are the "Make a change" calls
 * through the stock CRUD routes, whose behavior dispatcher and DAL writes the interim intake wraps.
 *
 * M5: with DEMO_CLICKHOUSE=1 (Store 'ClickHouse') every domain also materializes every entity into the ClickHouse
 * store (the throwaway rfs-test-clickhouse container, started if needed; database rfs_demo_<port>_<pid>_<domain>, dropped and
 * backfilled at every boot; ExposeReasons on, so the inspector shows why a facet stayed Live).  The renumbering
 * is a raw SQL write the intake cannot see, so it is reported like any raw writer's (notify with no IDs: a
 * whole-entity re-read) and the domain is ready once the store has applied it.  With the store the result cache
 * is off: a cache entry only ever holds a Live answer (store answers are never cached, internal-contracts §62.4),
 * and a Bounded / Fast request takes an entry before it is routed, so the cache would hide the store the demo is
 * showing.  Without the variable the demo is exactly M4.
 *
 * Demo-only switches (a showcase on one loopback machine, never a multi-tenant deployment): Cache.ExposeStatus
 * (the X-Retold-Facet-Cache / -Freshness headers the inspector shows), Freshness.SeqHeader and SSE.IncludeSeq
 * (the Seq the MinSeq / read-your-writes flow shows).  Their defaults keep all three away from clients on a policy
 * host (the node-wide Seq reveals other tenants' write volume; the cache status reveals a colleague's query); the
 * client then refetches an SSE-triggered group with Freshness.Mode 'Exact' instead of a MinSeq.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libPath = require('node:path');

const libHarness = require('../../../test/support/Facet-Test-Harness.js');
const libPersonas = require('./Faceting-Demo-Personas.js');
const libWrites = require('./Faceting-Demo-Writes.js');

// The RetoldFaceting options every demo domain adds over its fixture's (internal-contracts §47.5).
const FACETING_OPTIONS = Object.freeze({ Cache: { Enabled: true, ExposeStatus: true }, Freshness: { SeqHeader: true }, SSE: { IncludeSeq: true } });

const DOMAINS =
	[
		{ Domain: 'ProjectTrack', Fixture: 'ProjectTrack', RegistryPort: 19196, Definitions: 'Auto' },
		{ Domain: 'LabTrack', Fixture: 'LabTrack', RegistryPort: 19197, Definitions: 'Auto' },
		{ Domain: 'Bookstore', Fixture: 'Bookstore-Tenant', RegistryPort: 19198, Definitions: [ libPath.join(__dirname, 'definitions', 'Bookstore-Demo-Definitions.json') ] }
	];

// Remote addresses a domain server accepts (the front server always connects over IPv4 loopback).
const LOOPBACK_ADDRESSES = [ '127.0.0.1', '::1', '::ffff:127.0.0.1' ];

const GUARD_ERROR_CODE = 'DEMO_LOOPBACK_ONLY';

// The address every domain server binds (the front server connects to harness.baseURL = 127.0.0.1:<port>).
const BIND_HOST = '127.0.0.1';

// The entities the banner names per domain (the full lists are in GET /api/Demo/Status).
const BANNER_ENTITIES =
{
	ProjectTrack: [ 'Project', 'Document', 'Task', 'ProjectMembership' ],
	LabTrack: [ 'MaterialIntake', 'MaterialIntakeRequirement', 'MaterialTypeFormRequirement', 'LabForm' ],
	Bookstore: [ 'Book', 'Review', 'Author' ]
};

/**
 * Run SQL statements against a harness database, in order: SQLite through node:sqlite (one transaction),
 * PostgreSQL through the harness pool (sequential).  Each statement is { SQL, Binds, Kind: 'run' | 'get' };
 * a 'get' returns its first row's N.
 *
 * @param {Record<string, any>} pHarness
 * @param {Array<{ SQL: string, Binds: Array<any>, Kind: string }>} pStatements
 * @param {(pError?: Error, pResults?: Array<any>) => void} fCallback
 */
const runStatements = (pHarness, pStatements, fCallback) =>
{
	let tmpResults = [];
	if (pHarness.db)
	{
		let tmpDB = pHarness.db;
		try
		{
			tmpDB.exec('BEGIN');
			for (let i = 0; i < pStatements.length; i++)
			{
				let tmpStatement = tmpDB.prepare(pStatements[i].SQL);
				if (pStatements[i].Kind === 'get')
				{
					let tmpRow = tmpStatement.get(...pStatements[i].Binds);
					tmpResults.push(tmpRow ? Number(tmpRow.N) : 0);
				}
				else
				{
					let tmpRun = tmpStatement.run(...pStatements[i].Binds);
					tmpResults.push(tmpRun ? Number(tmpRun.changes) : 0);
				}
			}
			tmpDB.exec('COMMIT');
		}
		catch (pError)
		{
			try
			{
				tmpDB.exec('ROLLBACK');
			}
			catch (pRollbackError)
			{
				// Nothing to roll back
			}
			return fCallback(pError);
		}
		return fCallback(null, tmpResults);
	}
	let tmpPool = (pHarness.connection && pHarness.connection.pool) ? pHarness.connection.pool : null;
	if (!tmpPool)
	{
		return fCallback(new Error('Faceting-Demo-Domains: the harness has neither a SQLite db nor a PostgreSQL pool.'));
	}
	let fNext = (pIndex) =>
	{
		if (pIndex >= pStatements.length)
		{
			return fCallback(null, tmpResults);
		}
		let tmpStatement = pStatements[pIndex];
		// $1, $2, ... for PostgreSQL
		let tmpBindIndex = 0;
		let tmpSQL = tmpStatement.SQL.replace(/\?/g, () => { tmpBindIndex++; return `$${tmpBindIndex}`; });
		tmpPool.query(tmpSQL, tmpStatement.Binds)
			.then(
				(pResult) =>
				{
					if (tmpStatement.Kind === 'get')
					{
						tmpResults.push((pResult.rows && pResult.rows[0]) ? Number(pResult.rows[0].N) : 0);
					}
					else
					{
						tmpResults.push(Number(pResult.rowCount) || 0);
					}
					setImmediate(() => { fNext(pIndex + 1); });
				},
				(pError) =>
				{
					setImmediate(() => { fCallback(pError); });
				});
	};
	return fNext(0);
};

/**
 * The (table, column, map) triples a renumbering touches.  Kind names the ID space ('Tenants' | 'Users'):
 * every column of one kind is renumbered with the same map, so foreign keys stay consistent.
 *
 * @param {Record<string, any>} pModel - harness.model
 * @param {Record<string, any>} pRenumber
 * @return {Array<{ Table: string, Column: string, Kind: string, Map: Record<string, number> }>}
 */
const renumberTargets = (pModel, pRenumber) =>
{
	let tmpTargets = [];
	let tmpTables = (pModel && pModel.Tables) ? pModel.Tables : {};
	Object.keys(tmpTables).forEach(
		(pTable) =>
		{
			let tmpColumns = Array.isArray(tmpTables[pTable].Columns) ? tmpTables[pTable].Columns : [];
			tmpColumns.forEach(
				(pColumn) =>
				{
					let tmpName = pColumn.Column;
					if ((tmpName === pRenumber.TenantColumn) && (Object.keys(pRenumber.Tenants || {}).length > 0))
					{
						tmpTargets.push({ Table: pTable, Column: tmpName, Kind: 'Tenants', Map: pRenumber.Tenants });
					}
					else if ((pRenumber.UserColumnPattern instanceof RegExp) && pRenumber.UserColumnPattern.test(tmpName) && (Object.keys(pRenumber.Users || {}).length > 0))
					{
						tmpTargets.push({ Table: pTable, Column: tmpName, Kind: 'Users', Map: pRenumber.Users });
					}
				});
		});
	return tmpTargets;
};

/**
 * Renumber a seeded domain in place (SQLite: harness.db; PostgreSQL: harness.connection.pool).
 *
 * Every column named pRenumber.TenantColumn maps Tenants, every column matching UserColumnPattern maps
 * Users: UPDATE "T" SET "C" = new WHERE "C" = old.  A target ID the seed already uses (the Small seeds use
 * users 1..36 and tenants 1, 2, so none; Medium has more users) is first RELOCATED out of the way, in every
 * column of its kind, to <max ID of that kind> + <ID>, so two principals are never merged and foreign keys
 * stay consistent.  The source IDs are never targets, so the order of the main updates does not matter.
 *
 * @param {Record<string, any>} pHarness
 * @param {Record<string, any>} pRenumber - Faceting-Demo-Personas.RENUMBER[<Domain>]
 * @param {(pError?: Error, pSummary?: { Statements: number, Rows: number, Relocated: Record<string, Record<string, number>> }) => void} fCallback
 */
const renumber = (pHarness, pRenumber, fCallback) =>
{
	if (!pRenumber)
	{
		return fCallback(null, { Statements: 0, Rows: 0, Relocated: {} });
	}
	let tmpTargets = renumberTargets(pHarness.model, pRenumber);
	let tmpKinds = {};
	for (let i = 0; i < tmpTargets.length; i++)
	{
		let tmpTarget = tmpTargets[i];
		if (tmpKinds[tmpTarget.Kind])
		{
			continue;
		}
		let tmpMap = tmpTarget.Map;
		let tmpSources = Object.keys(tmpMap).map((pOld) => { return parseInt(pOld, 10); });
		let tmpNew = tmpSources.map((pOld) => { return tmpMap[String(pOld)]; });
		if (tmpNew.some((pValue) => { return tmpSources.indexOf(pValue) >= 0; }))
		{
			return fCallback(new Error(`Faceting-Demo-Domains.renumber: a ${tmpTarget.Kind} target is also a source (${JSON.stringify(tmpMap)}).`));
		}
		tmpKinds[tmpTarget.Kind] = { Map: tmpMap, New: tmpNew, Max: 0, InUse: {} };
	}

	// 1. Probe: the largest ID of each kind, and which target IDs are already in use.
	let tmpProbes = [];
	tmpTargets.forEach(
		(pTarget) =>
		{
			tmpProbes.push({ SQL: `SELECT max("${pTarget.Column}") AS "N" FROM "${pTarget.Table}"`, Binds: [], Kind: 'get', Probe: 'Max', Target: pTarget });
			tmpKinds[pTarget.Kind].New.forEach(
				(pValue) =>
				{
					tmpProbes.push({ SQL: `SELECT count(*) AS "N" FROM "${pTarget.Table}" WHERE "${pTarget.Column}" = ?`, Binds: [ pValue ], Kind: 'get', Probe: 'InUse', Value: pValue, Target: pTarget });
				});
		});
	runStatements(pHarness, tmpProbes,
		(pProbeError, pProbeResults) =>
		{
			if (pProbeError)
			{
				return fCallback(pProbeError);
			}
			for (let i = 0; i < tmpProbes.length; i++)
			{
				let tmpKind = tmpKinds[tmpProbes[i].Target.Kind];
				if (tmpProbes[i].Probe === 'Max')
				{
					tmpKind.Max = Math.max(tmpKind.Max, Number(pProbeResults[i]) || 0);
				}
				else if (pProbeResults[i] > 0)
				{
					tmpKind.InUse[tmpProbes[i].Value] = true;
				}
			}
			// 2. Relocations (only for target IDs in use), then the renumbering itself.
			let tmpRelocated = {};
			let tmpUpdates = [];
			Object.keys(tmpKinds).forEach(
				(pKindName) =>
				{
					let tmpKind = tmpKinds[pKindName];
					Object.keys(tmpKind.InUse).forEach(
						(pValue) =>
						{
							let tmpOld = parseInt(pValue, 10);
							tmpRelocated[pKindName] = tmpRelocated[pKindName] || {};
							tmpRelocated[pKindName][tmpOld] = tmpKind.Max + tmpOld;
						});
				});
			tmpTargets.forEach(
				(pTarget) =>
				{
					let tmpRelocation = tmpRelocated[pTarget.Kind] || {};
					Object.keys(tmpRelocation).forEach(
						(pOld) =>
						{
							tmpUpdates.push({ SQL: `UPDATE "${pTarget.Table}" SET "${pTarget.Column}" = ? WHERE "${pTarget.Column}" = ?`, Binds: [ tmpRelocation[pOld], parseInt(pOld, 10) ], Kind: 'run' });
						});
				});
			tmpTargets.forEach(
				(pTarget) =>
				{
					Object.keys(pTarget.Map).forEach(
						(pOld) =>
						{
							tmpUpdates.push({ SQL: `UPDATE "${pTarget.Table}" SET "${pTarget.Column}" = ? WHERE "${pTarget.Column}" = ?`, Binds: [ pTarget.Map[pOld], parseInt(pOld, 10) ], Kind: 'run' });
						});
				});
			runStatements(pHarness, tmpUpdates,
				(pUpdateError, pUpdateResults) =>
				{
					if (pUpdateError)
					{
						return fCallback(pUpdateError);
					}
					let tmpRows = pUpdateResults.reduce((pSum, pCount) => { return pSum + pCount; }, 0);
					return fCallback(null, { Statements: tmpUpdates.length, Rows: tmpRows, Relocated: tmpRelocated });
				});
		});
};

/**
 * The renumbering of a booted domain: Faceting-Demo-Personas.RENUMBER[<Domain>] with its Users map derived
 * from the seed's named principals (Lead -> user42's ID, ... OtherLead -> user81's), so every scale renumbers
 * the right users.  A seed principal whose tenant is not in the Tenants map is an error (the persona table and
 * the seed disagree).
 *
 * @param {string} pDomain
 * @param {Record<string, any>} pHarness
 * @return {Record<string, any>|Error|null}
 */
const effectiveRenumber = (pDomain, pHarness) =>
{
	let tmpBase = libPersonas.RENUMBER[pDomain];
	if (!tmpBase)
	{
		return null;
	}
	let tmpRoles = libPersonas.SEED_PRINCIPALS[pDomain];
	let tmpPrincipals = (pHarness && pHarness.principals) ? pHarness.principals : {};
	if (!tmpRoles || (Object.keys(tmpPrincipals).length < 1))
	{
		return tmpBase;
	}
	let tmpUsers = {};
	let tmpRoleNames = Object.keys(tmpRoles);
	for (let i = 0; i < tmpRoleNames.length; i++)
	{
		let tmpSeed = tmpPrincipals[tmpRoleNames[i]];
		let tmpPersona = libPersonas.personaFor(tmpRoles[tmpRoleNames[i]]);
		if (!tmpSeed || !tmpPersona)
		{
			return new Error(`Faceting-Demo-Domains: ${pDomain} has no seed principal [${tmpRoleNames[i]}] for persona [${tmpRoles[tmpRoleNames[i]]}].`);
		}
		if (tmpBase.Tenants[String(tmpSeed.Tenant)] !== tmpPersona.Tenant)
		{
			return new Error(`Faceting-Demo-Domains: ${pDomain} principal ${tmpRoleNames[i]} is in seed tenant ${tmpSeed.Tenant}, which does not renumber to persona ${tmpPersona.Key}'s tenant ${tmpPersona.Tenant}.`);
		}
		tmpUsers[String(tmpSeed.User)] = tmpPersona.User;
	}
	return Object.assign({}, tmpBase, { Users: tmpUsers });
};

/**
 * M5: the renumbering (raw SQL) reported to the faceting service like any raw writer's: one notify per entity
 * naming no IDs (a whole-entity re-read in the store; every cached answer of the entity goes), with every tenant
 * the renumbering touched.  Then wait until the store applied it (Materializer.quiesce).
 *
 * @param {Record<string, any>} pHarness
 * @param {Record<string, any>|null} pRenumber
 * @param {(pError?: Error) => void} fCallback
 */
const reportRenumber = (pHarness, pRenumber, fCallback) =>
{
	if (!pHarness.store || !pRenumber)
	{
		return fCallback();
	}
	let tmpTenants = [];
	Object.keys(pRenumber.Tenants || {}).forEach((pOld) => { tmpTenants.push(parseInt(pOld, 10), pRenumber.Tenants[pOld]); });
	let tmpTables = (pHarness.model && pHarness.model.Tables) ? Object.keys(pHarness.model.Tables) : [];
	tmpTables.forEach((pEntity) => { pHarness.faceting.notify(pEntity, { Operation: 'Update', IDs: [], Tenants: tmpTenants }); });
	return pHarness.quiesce((pError) => { return fCallback(pError || null); }, 120000);
};

/**
 * M5: the store view of a domain for GET /api/Demo/Status (no tenant data): availability and, per mirrored
 * entity, its state, lag and whether it is exact.
 *
 * @param {Record<string, any>} pHarness
 * @return {Record<string, any>|null}
 */
const describeStore = (pHarness) =>
{
	if (!pHarness || !pHarness.store || !pHarness.faceting)
	{
		return null;
	}
	let tmpAvailability = pHarness.faceting.storeAvailability();
	let tmpFreshness = pHarness.fable.RetoldFacetingFreshness;
	let tmpMaterializer = pHarness.fable.RetoldFacetingMaterializer;
	let tmpStatus = tmpMaterializer ? tmpMaterializer.status() : { Stores: {} };
	let tmpStore = (tmpStatus.Stores && tmpStatus.Stores.ClickHouse) ? tmpStatus.Stores.ClickHouse : { Entities: {} };
	let tmpEntities = {};
	Object.keys(tmpStore.Entities || {}).sort().forEach(
		(pEntity) =>
		{
			let tmpEntity = tmpFreshness ? tmpFreshness.entityFreshness('ClickHouse', pEntity, Date.now()) : { State: 'Absent', LagMS: null, Exact: false };
			tmpEntities[pEntity] = { State: tmpEntity.State, LagMS: Number.isFinite(tmpEntity.LagMS) ? tmpEntity.LagMS : null, Exact: (tmpEntity.Exact === true), Rows: tmpStore.Entities[pEntity].Rows };
		});
	return { Name: 'ClickHouse', Configured: tmpAvailability.Configured, Available: tmpAvailability.Available, Reason: tmpAvailability.Reason, Database: pHarness.storeDatabase || null, Entities: tmpEntities };
};

/**
 * Is a socket remote address loopback?
 *
 * @param {string|undefined|null} pAddress
 * @return {boolean}
 */
const isLoopbackAddress = (pAddress) =>
{
	return (typeof(pAddress) === 'string') && (LOOPBACK_ADDRESSES.indexOf(pAddress) >= 0);
};

/**
 * Does the domain server listen on a loopback address only?
 *
 * @param {Record<string, any>} pHarness
 * @return {boolean}
 */
const isBoundToLoopback = (pHarness) =>
{
	let tmpServiceServer = (pHarness && pHarness.fable) ? pHarness.fable.OratorServiceServer : null;
	let tmpRestify = tmpServiceServer ? tmpServiceServer.server : null;
	let tmpAddress = (tmpRestify && (typeof(tmpRestify.address) === 'function')) ? tmpRestify.address() : null;
	return !!tmpAddress && (typeof(tmpAddress.address) === 'string') && isLoopbackAddress(tmpAddress.address);
};

/**
 * Install the loopback guard on a domain server: a restify pre() that answers 403 DEMO_LOOPBACK_ONLY (and
 * stops the chain) for any client that is not on loopback.  Sets pHarness.DemoLoopbackGuard.
 *
 * @param {Record<string, any>} pHarness
 */
const installLoopbackGuard = (pHarness) =>
{
	let tmpServiceServer = (pHarness && pHarness.fable) ? pHarness.fable.OratorServiceServer : null;
	if (!tmpServiceServer || (typeof(tmpServiceServer.pre) !== 'function'))
	{
		throw new Error('Faceting-Demo-Domains.installLoopbackGuard: the harness has no Orator service server.');
	}
	let tmpGuard = { Installed: true, Allowed: LOOPBACK_ADDRESSES.slice(), Rejected: 0, LastRejected: null };
	tmpServiceServer.pre(
		(pRequest, pResponse, fNext) =>
		{
			let tmpAddress = (pRequest.socket && pRequest.socket.remoteAddress) ? pRequest.socket.remoteAddress : null;
			if (isLoopbackAddress(tmpAddress))
			{
				return fNext();
			}
			tmpGuard.Rejected++;
			tmpGuard.LastRejected = tmpAddress;
			pResponse.send(403, { Error: { Code: GUARD_ERROR_CODE, Status: 403, Message: 'This demo domain server only answers the demo front server (loopback).' } });
			return fNext(false);
		});
	pHarness.DemoLoopbackGuard = tmpGuard;
};

/**
 * The renumbered tenant of a seed tenant.
 *
 * @param {string} pDomain
 * @param {any} pTenant
 * @return {any}
 */
const renumberedTenant = (pDomain, pTenant) =>
{
	let tmpRenumber = libPersonas.RENUMBER[pDomain];
	if (tmpRenumber && tmpRenumber.Tenants && Object.prototype.hasOwnProperty.call(tmpRenumber.Tenants, String(pTenant)))
	{
		return tmpRenumber.Tenants[String(pTenant)];
	}
	return pTenant;
};

/**
 * A browser-safe description of one booted domain (GET /api/Demo/Status, the banner).  No upstream
 * address: the browser only ever talks to the front server.
 *
 * @param {string} pDomain
 * @param {Record<string, any>} pHarness
 * @return {Record<string, any>}
 */
const describeDomain = (pDomain, pHarness) =>
{
	let tmpSeed = pHarness.seed || {};
	let tmpTenantLiveCounts = {};
	Object.keys(tmpSeed.TenantLiveCounts || {}).forEach(
		(pTenant) =>
		{
			tmpTenantLiveCounts[renumberedTenant(pDomain, pTenant)] = Object.assign({}, tmpSeed.TenantLiveCounts[pTenant]);
		});
	let tmpRegistry = pHarness.fable ? pHarness.fable.RetoldFacetingDefinitionRegistry : null;
	let tmpDefinitions = (tmpRegistry && (typeof(tmpRegistry.status) === 'function')) ? tmpRegistry.status() : null;
	if (tmpDefinitions && Array.isArray(tmpDefinitions.Files))
	{
		tmpDefinitions.Files = tmpDefinitions.Files.map((pFile) => { return libPath.basename(String(pFile)); });
	}
	let tmpFaceting = (pHarness.faceting && (typeof(pHarness.faceting.status) === 'function')) ? pHarness.faceting.status() : null;
	// M4: the cache / change-capture / stream statistics (counts only, no keys or values), when the service has them.
	let tmpLive = {};
	[ 'Cache', 'Changes', 'SSE', 'Generations', 'ReadYourWrites' ].forEach(
		(pKey) =>
		{
			if (tmpFaceting && tmpFaceting[pKey] && (typeof(tmpFaceting[pKey]) === 'object'))
			{
				tmpLive[pKey] = JSON.parse(JSON.stringify(tmpFaceting[pKey]));
			}
		});
	return (
		{
			Fixture: pHarness.options ? pHarness.options.Fixture : null,
			Provider: pHarness.provider,
			Scale: tmpSeed.Scale || (pHarness.options ? pHarness.options.Scale : null),
			Seed: (typeof(tmpSeed.Seed) !== 'undefined') ? tmpSeed.Seed : null,
			TenantColumn: (libPersonas.RENUMBER[pDomain] || {}).TenantColumn || null,
			Tenants: (Array.isArray(tmpSeed.Tenants) ? tmpSeed.Tenants : []).map((pTenant) => { return renumberedTenant(pDomain, pTenant); }),
			Entities: Object.keys((pHarness.model && pHarness.model.Tables) ? pHarness.model.Tables : {}),
			LiveCounts: Object.assign({}, tmpSeed.LiveCounts || {}),
			TenantLiveCounts: tmpTenantLiveCounts,
			Definitions: tmpDefinitions,
			ModelVersion: tmpFaceting ? tmpFaceting.ModelVersion : null,
			// Seed ID -> demo ID (DEMO-SPEC §2.3), and any seed IDs moved out of the way first.
			Renumbered: pHarness.DemoRenumberMap ? { Tenants: Object.assign({}, pHarness.DemoRenumberMap.Tenants || {}), Users: Object.assign({}, pHarness.DemoRenumberMap.Users || {}), Relocated: (pHarness.DemoRenumber && pHarness.DemoRenumber.Relocated) ? pHarness.DemoRenumber.Relocated : {} } : null,
			LoopbackGuard: !!(pHarness.DemoLoopbackGuard && pHarness.DemoLoopbackGuard.Installed),
			// M5: the ClickHouse store (null without DEMO_CLICKHOUSE).
			Store: describeStore(pHarness),
			LoopbackOnly: isBoundToLoopback(pHarness),
			// M4: the write guards and the live statistics.
			WriteGuard: pHarness.DemoWriteGuard ? { Installed: !!pHarness.DemoWriteGuard.Installed, Entities: pHarness.DemoWriteGuard.Entities.length, Refused: pHarness.DemoWriteGuard.Refused } : null,
			Writes: libWrites.WRITE_ROUTES.filter((pRoute) => { return pRoute.Domain === pDomain; }).map((pRoute) => { return `${pRoute.Method} ${pRoute.Path}`; }),
			Live: tmpLive
		});
};

/**
 * The ClickHouse database of a domain: rfs_demo_<front port>_<pid>_<domain> — two demo processes (the
 * user's 19300 and a check on 19301-19305) never share (or drop) each other's databases, and the test
 * container's ensure() drops the ones whose process is gone.
 *
 * @param {number} pFrontPort
 * @param {string} pDomain
 * @return {string}
 */
const demoDatabase = (pFrontPort, pDomain) =>
{
	let tmpPort = (Number.isInteger(pFrontPort) && (pFrontPort > 0)) ? pFrontPort : 0;
	return `rfs_demo_${tmpPort}_${process.pid}_${String(pDomain).toLowerCase()}`;
};

/**
 * Boot one domain: harness start (bound to 127.0.0.1, loopback guard installed before listen) -> renumber
 * (M5, with a store: reported, then applied by the store before the domain is ready).
 *
 * @param {Record<string, any>} pDomain - a DOMAINS row
 * @param {{ Provider?: string, Scale?: string, LogLevel?: string, Store?: string|null }} pOptions
 * @param {(pError?: Error, pHarness?: Record<string, any>) => void} fCallback - the harness is returned on error too (so it can be stopped)
 */
const startDomain = (pDomain, pOptions, fCallback) =>
{
	let tmpHarness = null;
	let tmpStarted = Date.now();
	try
	{
		tmpHarness = libHarness.start(
			{
				Port: pDomain.RegistryPort,
				Fixture: pDomain.Fixture,
				Definitions: pDomain.Definitions,
				Provider: pOptions.Provider || 'SQLite',
				Scale: pOptions.Scale || 'Small',
				LogLevel: pOptions.LogLevel || 'error',
				// Loopback only, and the guard is in restify's pre chain before the first connection.
				Host: BIND_HOST,
				BeforeListen: installLoopbackGuard,
				// M5: the result cache off with the store (it would serve its Live entries before any routing).
				Faceting: (pOptions.Store === 'ClickHouse') ? Object.assign(JSON.parse(JSON.stringify(FACETING_OPTIONS)), { Cache: { Enabled: false, ExposeStatus: true } }) : JSON.parse(JSON.stringify(FACETING_OPTIONS)),
				// M5 (DEMO_CLICKHOUSE=1): every entity materialized into rfs_demo_<port>_<pid>_<domain> (fresh at every boot).
				Store: (pOptions.Store === 'ClickHouse') ? 'ClickHouse' : null,
				// The database carries the front port: a smoke or browser check on 19301-19305 never drops (or
				// materializes into) the databases of a ClickHouse-mode demo on 19300 (one materializer each).
				// ExposeFreshness: the inspector shows LagMS / AsOf and the freshness reasons (the demo hosts have
				// a scope policy, where 'Auto' hides them).
				StoreOptions: (pOptions.Store === 'ClickHouse')
					? { Materialize: 'All', Database: demoDatabase(pOptions.FrontPort, pDomain.Domain), DropFirst: true, Store: { ExposeReasons: true, ExposeFreshness: true }, QuiesceTimeoutMS: 120000 }
					: {}
			},
			(pStartError) =>
			{
				if (pStartError)
				{
					let tmpError = new Error(`${pDomain.Domain} (${pDomain.Fixture}, ${pOptions.Provider || 'SQLite'}) did not start: ${pStartError.message}`);
					tmpError.Skip = !!pStartError.Skip;
					return fCallback(tmpError, tmpHarness);
				}
				let tmpRenumber = effectiveRenumber(pDomain.Domain, tmpHarness);
				if (tmpRenumber instanceof Error)
				{
					return fCallback(tmpRenumber, tmpHarness);
				}
				renumber(tmpHarness, tmpRenumber,
					(pRenumberError, pSummary) =>
					{
						if (pRenumberError)
						{
							return fCallback(pRenumberError, tmpHarness);
						}
						tmpHarness.DemoDomain = pDomain.Domain;
						tmpHarness.DemoRenumberMap = tmpRenumber;
						tmpHarness.DemoRenumber = pSummary;
						try
						{
							// After boot (the faceting intake already wrapped the PostOperation slots; the guards take the PreOperation ones).
							libWrites.installWriteGuards(pDomain.Domain, tmpHarness);
						}
						catch (pGuardError)
						{
							return fCallback(pGuardError, tmpHarness);
						}
						reportRenumber(tmpHarness, tmpRenumber,
							(pReportError) =>
							{
								if (pReportError)
								{
									return fCallback(new Error(`${pDomain.Domain}: the ClickHouse store did not apply the renumbering: ${pReportError.message}`), tmpHarness);
								}
								tmpHarness.DemoBootMS = Date.now() - tmpStarted;
								return fCallback(null, tmpHarness);
							});
					});
			});
	}
	catch (pError)
	{
		return fCallback(pError, tmpHarness);
	}
};

/**
 * Stop every started domain (closes the servers, drops a PostgreSQL database).  Never fails.
 *
 * @param {Record<string, Record<string, any>>} pDomains
 * @param {() => void} fCallback
 */
const stop = (pDomains, fCallback) =>
{
	let tmpHarnesses = Object.keys(pDomains || {}).map((pKey) => { return pDomains[pKey]; }).filter((pHarness) => { return !!pHarness && (typeof(pHarness.stop) === 'function'); });
	let fNext = (pIndex) =>
	{
		if (pIndex >= tmpHarnesses.length)
		{
			return fCallback();
		}
		try
		{
			tmpHarnesses[pIndex].stop(() => { setImmediate(() => { fNext(pIndex + 1); }); });
		}
		catch (pError)
		{
			setImmediate(() => { fNext(pIndex + 1); });
		}
	};
	return fNext(0);
};

/**
 * Boot every domain, in order.  On any failure the domains already started are stopped before the
 * callback.
 *
 * @param {{ Provider?: string, Scale?: string, LogLevel?: string, Store?: string|null, onDomain?: (pDomain: string, pHarness: Record<string, any>) => void }} pOptions
 * @param {(pError?: Error, pDomains?: Record<string, Record<string, any>>) => void} fCallback - { ProjectTrack: harness, … }
 */
const start = (pOptions, fCallback) =>
{
	let tmpOptions = pOptions || {};
	let tmpDomains = {};
	let fNext = (pIndex) =>
	{
		if (pIndex >= DOMAINS.length)
		{
			return fCallback(null, tmpDomains);
		}
		let tmpDomain = DOMAINS[pIndex];
		startDomain(tmpDomain, tmpOptions,
			(pError, pHarness) =>
			{
				if (pHarness)
				{
					tmpDomains[tmpDomain.Domain] = pHarness;
				}
				if (pError)
				{
					return stop(tmpDomains, () => { return fCallback(pError); });
				}
				if (typeof(tmpOptions.onDomain) === 'function')
				{
					tmpOptions.onDomain(tmpDomain.Domain, pHarness);
				}
				return setImmediate(() => { fNext(pIndex + 1); });
			});
	};
	return fNext(0);
};

module.exports = (
	{
		DOMAINS: DOMAINS,
		FACETING_OPTIONS: FACETING_OPTIONS,
		LOOPBACK_ADDRESSES: LOOPBACK_ADDRESSES,
		GUARD_ERROR_CODE: GUARD_ERROR_CODE,
		BIND_HOST: BIND_HOST,
		BANNER_ENTITIES: BANNER_ENTITIES,
		renumber: renumber,
		renumberTargets: renumberTargets,
		effectiveRenumber: effectiveRenumber,
		isLoopbackAddress: isLoopbackAddress,
		installLoopbackGuard: installLoopbackGuard,
		isBoundToLoopback: isBoundToLoopback,
		describeDomain: describeDomain,
		describeStore: describeStore,
		demoDatabase: demoDatabase,
		reportRenumber: reportRenumber,
		startDomain: startDomain,
		start: start,
		stop: stop,
		Harness: libHarness,
		Personas: libPersonas,
		Writes: libWrites
	});
