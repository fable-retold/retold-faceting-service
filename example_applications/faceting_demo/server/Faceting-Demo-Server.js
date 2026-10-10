#!/usr/bin/env node
/**
 * Faceting-Demo-Server -- `npm start` (DEMO-SPEC §2.1).
 *
 *   1. read the environment: DEMO_PORT (19300; 19300-19310 only), DEMO_HOST (127.0.0.1), DEMO_SCALE
 *      (Small | Medium), DEMO_PG=1 (PostgreSQL in rfs-test-postgres; needs TZ=UTC and docker), DEMO_LOG_LEVEL,
 *      DEMO_CLICKHOUSE=1 (M5: every domain also materialized into the ClickHouse store in rfs-test-clickhouse;
 *      needs docker; the pages get the engine toggle: Auto / Live / Store (Fast) and "Live vs Store")
 *   2. boot the three domains (Faceting-Demo-Domains.start): seed, bind 127.0.0.1 + loopback guard before listen, renumber
 *   3. start the front server (Faceting-Demo-Front.create(...).listen(DEMO_PORT, DEMO_HOST))
 *   4. print the banner: the URL, each domain (fixture, provider, entities, live row counts, definitions),
 *      the personas, and the DEMO warning (principal chosen by a header the demo host resolves)
 *   5. SIGINT / SIGTERM: close the front server, stop the domains (drops a PostgreSQL database), exit 0
 *
 * startDemo() is the in-process API (no banner, no signals) the smoke test (Faceting-Demo-Smoke.js) boots.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libPath = require('node:path');

const libDomains = require('./Faceting-Demo-Domains.js');
const libFront = require('./Faceting-Demo-Front.js');
const libPersonas = require('./Faceting-Demo-Personas.js');

const DEFAULT_PORT = 19300;
const PORT_RANGE = [ 19300, 19310 ];
const DEFAULT_HOST = '127.0.0.1';
const SCALES = [ 'Small', 'Medium' ];
const LOG_LEVELS = [ 'trace', 'debug', 'info', 'warn', 'error', 'fatal' ];
const DIST_ROOT = libPath.resolve(__dirname, '..', 'dist');
const LOOPBACK_HOSTS = [ '127.0.0.1', 'localhost', '::1' ];

/**
 * node-postgres reads `timestamp` as local wall clock: only a UTC process is safe (internal-contracts §33.2).
 *
 * @return {boolean}
 */
const timeZoneIsUTC = () =>
{
	return (new Date(2020, 0, 1).getTimezoneOffset() === 0) && (new Date(2020, 6, 1).getTimezoneOffset() === 0);
};

/**
 * The demo options from an environment (throws a readable Error on a bad value).
 *
 * @param {Record<string, string|undefined>} pEnvironment - process.env
 * @return {{ Port: number, Host: string, Scale: string, Provider: string, LogLevel: string, Store: string|null }}
 */
const optionsFromEnvironment = (pEnvironment) =>
{
	let tmpEnvironment = pEnvironment || {};
	let tmpPort = DEFAULT_PORT;
	if ((typeof(tmpEnvironment.DEMO_PORT) === 'string') && (tmpEnvironment.DEMO_PORT.length > 0))
	{
		tmpPort = Number(tmpEnvironment.DEMO_PORT);
		if (!Number.isInteger(tmpPort) || (tmpPort < PORT_RANGE[0]) || (tmpPort > PORT_RANGE[1]))
		{
			throw new Error(`DEMO_PORT must be an integer in ${PORT_RANGE[0]}-${PORT_RANGE[1]} (got [${tmpEnvironment.DEMO_PORT}]).`);
		}
	}
	let tmpHost = ((typeof(tmpEnvironment.DEMO_HOST) === 'string') && (tmpEnvironment.DEMO_HOST.length > 0)) ? tmpEnvironment.DEMO_HOST : DEFAULT_HOST;
	let tmpScale = ((typeof(tmpEnvironment.DEMO_SCALE) === 'string') && (tmpEnvironment.DEMO_SCALE.length > 0)) ? tmpEnvironment.DEMO_SCALE : 'Small';
	if (SCALES.indexOf(tmpScale) < 0)
	{
		throw new Error(`DEMO_SCALE must be one of ${SCALES.join(' | ')} (got [${tmpScale}]).`);
	}
	let tmpLogLevel = ((typeof(tmpEnvironment.DEMO_LOG_LEVEL) === 'string') && (tmpEnvironment.DEMO_LOG_LEVEL.length > 0)) ? tmpEnvironment.DEMO_LOG_LEVEL : 'error';
	if (LOG_LEVELS.indexOf(tmpLogLevel) < 0)
	{
		throw new Error(`DEMO_LOG_LEVEL must be one of ${LOG_LEVELS.join(' | ')} (got [${tmpLogLevel}]).`);
	}
	let tmpProvider = 'SQLite';
	if (tmpEnvironment.DEMO_PG === '1')
	{
		tmpProvider = 'PostgreSQL';
	}
	// M5: DEMO_CLICKHOUSE=1 adds the ClickHouse store (anything else: exactly the M4 demo).
	let tmpStore = (tmpEnvironment.DEMO_CLICKHOUSE === '1') ? 'ClickHouse' : null;
	return { Port: tmpPort, Host: tmpHost, Scale: tmpScale, Provider: tmpProvider, LogLevel: tmpLogLevel, Store: tmpStore };
};

/**
 * Prepare the process for the ClickHouse store (DEMO_CLICKHOUSE=1): turn the harness gate on (the dedicated
 * rfs-test-clickhouse container, started if needed), unless RFS_TEST_CLICKHOUSE_URL names another server.
 */
const prepareClickHouse = () =>
{
	if ((process.env.RFS_TEST_CLICKHOUSE !== '1') && !process.env.RFS_TEST_CLICKHOUSE_URL)
	{
		process.env.RFS_TEST_CLICKHOUSE = '1';
	}
};

/**
 * Prepare the process for PostgreSQL (DEMO_PG=1): refuse without TZ=UTC, turn the harness gate on.
 *
 * @return {Error|null}
 */
const preparePostgres = () =>
{
	if (!timeZoneIsUTC())
	{
		return new Error('DEMO_PG=1 needs the process time zone to be UTC (node-postgres reads timestamps as local time). Start with: TZ=UTC DEMO_PG=1 npm start');
	}
	if ((process.env.RFS_TEST_POSTGRES !== '1') && !process.env.RFS_TEST_POSTGRES_URL)
	{
		// The harness provider hook's gate (the throwaway rfs-test-postgres container, started if needed).
		process.env.RFS_TEST_POSTGRES = '1';
	}
	return null;
};

/**
 * The GET /api/Demo/Status body.
 *
 * @param {Record<string, any>} pDemo - { Options, StartedAt, Domains }
 * @return {Record<string, any>}
 */
const statusOf = (pDemo) =>
{
	let tmpDomains = {};
	Object.keys(pDemo.Domains || {}).forEach(
		(pDomain) =>
		{
			tmpDomains[pDomain] = libDomains.describeDomain(pDomain, pDemo.Domains[pDomain]);
		});
	return (
		{
			Provider: pDemo.Options.Provider,
			Scale: pDemo.Options.Scale,
			StartedAt: pDemo.StartedAt,
			Milestone: pDemo.Options.Store ? 'retold-faceting-service M5' : 'retold-faceting-service M4',
			// M5: 'ClickHouse' with DEMO_CLICKHOUSE=1 (each domain's Store block says how current it is), else null.
			Store: pDemo.Options.Store || null,
			Personas: libPersonas.PERSONAS.map((pPersona) => { return pPersona.Key; }),
			Domains: tmpDomains
		});
};

/**
 * Boot the domains and the front server (no banner, no signals): the smoke test calls this in-process.
 *
 * @param {{ Port?: number, Host?: string, Scale?: string, Provider?: string, LogLevel?: string, Store?: string|null, DistRoot?: string, onDomain?: Function }} pOptions
 * @param {(pError?: Error, pDemo?: { URL: string, Front: import('node:http').Server, Domains: Record<string, any>, Status: () => Record<string, any>, Options: Record<string, any>, stop: (fDone: () => void) => void }) => void} fCallback
 */
const startDemo = (pOptions, fCallback) =>
{
	let tmpOptions = Object.assign({ Port: DEFAULT_PORT, Host: DEFAULT_HOST, Scale: 'Small', Provider: 'SQLite', LogLevel: 'error', Store: null, DistRoot: DIST_ROOT }, pOptions || {});
	if (!Number.isInteger(tmpOptions.Port) || (tmpOptions.Port < PORT_RANGE[0]) || (tmpOptions.Port > PORT_RANGE[1]))
	{
		return setImmediate(() => { fCallback(new Error(`The demo port must be in ${PORT_RANGE[0]}-${PORT_RANGE[1]} (got ${tmpOptions.Port}).`)); });
	}
	if (tmpOptions.Provider === 'PostgreSQL')
	{
		let tmpPGError = preparePostgres();
		if (tmpPGError)
		{
			return setImmediate(() => { fCallback(tmpPGError); });
		}
	}
	if (tmpOptions.Store === 'ClickHouse')
	{
		prepareClickHouse();
	}
	let tmpDemo = (
		{
			URL: null,
			Front: null,
			Domains: {},
			Options: tmpOptions,
			StartedAt: new Date().toISOString(),
			Status: null,
			stop: null
		});
	tmpDemo.Status = () => { return statusOf(tmpDemo); };
	let tmpStopped = false;
	tmpDemo.stop = (fDone) =>
	{
		let fFinish = (typeof(fDone) === 'function') ? fDone : () => {};
		if (tmpStopped)
		{
			return fFinish();
		}
		tmpStopped = true;
		let fStopDomains = () => { libDomains.stop(tmpDemo.Domains, () => { return fFinish(); }); };
		if (!tmpDemo.Front || !tmpDemo.Front.listening)
		{
			return fStopDomains();
		}
		tmpDemo.Front.close(() => { fStopDomains(); });
		// Keep-alive browser connections would hold close() open.
		if (typeof(tmpDemo.Front.closeAllConnections) === 'function')
		{
			tmpDemo.Front.closeAllConnections();
		}
	};

	libDomains.start({ Provider: tmpOptions.Provider, Scale: tmpOptions.Scale, LogLevel: tmpOptions.LogLevel, Store: tmpOptions.Store, FrontPort: tmpOptions.Port, onDomain: tmpOptions.onDomain },
		(pDomainsError, pDomains) =>
		{
			if (pDomainsError)
			{
				return fCallback(pDomainsError);
			}
			tmpDemo.Domains = pDomains;
			let tmpLoopback = (LOOPBACK_HOSTS.indexOf(tmpOptions.Host) >= 0);
			tmpDemo.Front = libFront.create({ DistRoot: tmpOptions.DistRoot, Domains: pDomains, Status: tmpDemo.Status, LoopbackOnly: tmpLoopback });
			let fOnListenError = (pListenError) =>
			{
				let tmpError = pListenError;
				if (pListenError && (pListenError.code === 'EADDRINUSE'))
				{
					let tmpNext = (tmpOptions.Port < PORT_RANGE[1]) ? (tmpOptions.Port + 2) : PORT_RANGE[0];
					tmpError = new Error(`port ${tmpOptions.Port} is busy; set DEMO_PORT=${Math.min(tmpNext, PORT_RANGE[1])} (any free port in ${PORT_RANGE[0]}-${PORT_RANGE[1]}).`);
					tmpError.code = 'EADDRINUSE';
				}
				libDomains.stop(pDomains, () => { return fCallback(tmpError); });
			};
			tmpDemo.Front.once('error', fOnListenError);
			tmpDemo.Front.listen(tmpOptions.Port, tmpOptions.Host,
				() =>
				{
					tmpDemo.Front.removeListener('error', fOnListenError);
					tmpDemo.Front.on('error', (pError) => { console.error(`Faceting demo front server error: ${pError.message}`); });
					let tmpURLHost = (tmpOptions.Host.indexOf(':') >= 0) ? `[${tmpOptions.Host}]` : tmpOptions.Host;
					tmpDemo.URL = `http://${tmpURLHost}:${tmpOptions.Port}/`;
					return fCallback(null, tmpDemo);
				});
		});
};

/**
 * The startup banner (DEMO-SPEC §2.1).
 *
 * @param {Record<string, any>} pDemo
 * @return {string}
 */
const bannerText = (pDemo) =>
{
	let tmpStatus = pDemo.Status();
	let tmpLines = [];
	tmpLines.push('');
	tmpLines.push(`Retold Faceting demo  ${pDemo.URL}`);
	let tmpPad = (pText, pWidth) => { let tmpText = String(pText); return (tmpText.length >= pWidth) ? `${tmpText} ` : tmpText + ' '.repeat(pWidth - tmpText.length); };
	let tmpPlural = (pCount, pNoun) => { return `${pCount} ${pNoun}${(pCount === 1) ? '' : 's'}`; };
	Object.keys(tmpStatus.Domains).forEach(
		(pDomain) =>
		{
			let tmpDomain = tmpStatus.Domains[pDomain];
			let tmpFirstTenant = (Array.isArray(tmpDomain.Tenants) && (tmpDomain.Tenants.length > 0)) ? tmpDomain.Tenants[0] : null;
			let tmpCounts = ((tmpFirstTenant !== null) && tmpDomain.TenantLiveCounts[tmpFirstTenant]) ? tmpDomain.TenantLiveCounts[tmpFirstTenant] : tmpDomain.LiveCounts;
			let tmpEntities = (libDomains.BANNER_ENTITIES[pDomain] || []).filter((pEntity) => { return typeof(tmpCounts[pEntity]) === 'number'; });
			let tmpCountText = tmpEntities.map((pEntity) => { return `${pEntity} ${tmpCounts[pEntity]}`; }).join(' · ');
			let tmpDefinitions = tmpDomain.Definitions || {};
			let tmpHarness = pDemo.Domains[pDomain];
			tmpLines.push(`  ${tmpPad(pDomain, 14)}${tmpPad(`${tmpDomain.Provider} ${tmpDomain.Scale}`, 14)}${tmpCountText}  (tenant ${tmpFirstTenant}, live rows)`);
			tmpLines.push(`  ${tmpPad('', 14)}${tmpPad('', 14)}definitions ${tmpPlural(tmpDefinitions.Facets, 'facet')} / ${tmpPlural(tmpDefinitions.Scopes, 'scope')} (${tmpDefinitions.Disabled} disabled, ${tmpPlural(tmpDefinitions.Warnings, 'warning')}) · ${tmpDomain.ModelVersion} · upstream ${tmpHarness.baseURL.replace(/^http:\/\//, '')}, ${tmpDomain.LoopbackOnly ? 'loopback only' : 'ALL INTERFACES'}, guard ${tmpDomain.LoopbackGuard ? 'on' : 'OFF'}`);
			if (tmpDomain.Store)
			{
				let tmpLive = Object.keys(tmpDomain.Store.Entities).filter((pEntity) => { return tmpDomain.Store.Entities[pEntity].State === 'Live'; }).length;
				tmpLines.push(`  ${tmpPad('', 14)}${tmpPad('', 14)}ClickHouse ${tmpDomain.Store.Database}: ${tmpDomain.Store.Available ? 'available' : `unavailable (${tmpDomain.Store.Reason})`}, ${tmpLive} of ${Object.keys(tmpDomain.Store.Entities).length} entities Live`);
			}
		});
	let tmpPersonas = libPersonas.PERSONAS.map(
		(pPersona) =>
		{
			let tmpWho = (typeof(pPersona.Tenant) === 'number') ? `tenant ${pPersona.Tenant}, user ${pPersona.User}` : 'no session';
			return `${pPersona.Key}${(pPersona.Key === libPersonas.DEFAULT_PERSONA) ? '*' : ''} (${tmpWho})`;
		});
	tmpLines.push(`  Personas: ${tmpPersonas.join(' · ')}`);
	tmpLines.push(`  DEMO ONLY: the principal comes from the ${libPersonas.HEADER} header, resolved by this host. Never deploy it.`);
	if (LOOPBACK_HOSTS.indexOf(pDemo.Options.Host) < 0)
	{
		tmpLines.push(`  WARNING: bound to ${pDemo.Options.Host}, not loopback: anyone who can reach this port can pick any persona.`);
	}
	if (!require('node:fs').existsSync(libPath.join(pDemo.Options.DistRoot, 'index.html')))
	{
		tmpLines.push('  dist/ is not built: the page says "run npm run build" (the API works). Run npm run build, then reload.');
	}
	tmpLines.push('  Ctrl-C stops everything.');
	tmpLines.push('');
	return tmpLines.join('\n');
};

/**
 * Silence the two warnings every boot would print (restify's process.binding deprecation, node:sqlite's
 * experimental notice); every other warning still prints.
 */
const quietKnownWarnings = () =>
{
	process.removeAllListeners('warning');
	process.on('warning',
		(pWarning) =>
		{
			if ((pWarning.name === 'DeprecationWarning') && (pWarning.code === 'DEP0111'))
			{
				return;
			}
			if ((pWarning.name === 'ExperimentalWarning') && /SQLite/i.test(pWarning.message))
			{
				return;
			}
			console.warn(`${pWarning.name}: ${pWarning.message}`);
		});
};

/**
 * npm start: environment -> startDemo -> banner -> SIGINT / SIGTERM.
 */
const main = () =>
{
	quietKnownWarnings();
	let tmpOptions = null;
	try
	{
		tmpOptions = optionsFromEnvironment(process.env);
	}
	catch (pError)
	{
		console.error(`Faceting demo: ${pError.message}`);
		process.exit(1);
	}
	console.log(`Faceting demo: booting ProjectTrack, LabTrack and Bookstore (${tmpOptions.Provider}, ${tmpOptions.Scale}${tmpOptions.Store ? `, ${tmpOptions.Store} store` : ''}) ...`);
	startDemo(tmpOptions,
		(pError, pDemo) =>
		{
			if (pError)
			{
				console.error(`Faceting demo: ${pError.message}`);
				process.exit(1);
			}
			console.log(bannerText(pDemo));
			let tmpStopping = false;
			let fShutdown = (pSignal) =>
			{
				if (tmpStopping)
				{
					// A second Ctrl-C: do not wait.
					process.exit(1);
				}
				tmpStopping = true;
				console.log(`\nFaceting demo: ${pSignal}, stopping ...`);
				// A hung database release must not keep the process alive.
				setTimeout(() => { process.exit(0); }, 10000).unref();
				pDemo.stop(() => { process.exit(0); });
			};
			process.on('SIGINT', () => { fShutdown('SIGINT'); });
			process.on('SIGTERM', () => { fShutdown('SIGTERM'); });
		});
};

if (require.main === module)
{
	main();
}

module.exports = (
	{
		DEFAULT_PORT: DEFAULT_PORT,
		PORT_RANGE: PORT_RANGE,
		DEFAULT_HOST: DEFAULT_HOST,
		DIST_ROOT: DIST_ROOT,
		optionsFromEnvironment: optionsFromEnvironment,
		prepareClickHouse: prepareClickHouse,
		statusOf: statusOf,
		bannerText: bannerText,
		quietKnownWarnings: quietKnownWarnings,
		startDemo: startDemo,
		main: main,
		Domains: libDomains,
		Front: libFront
	});
