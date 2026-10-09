/**
 * Facet-Docker-Postgres — the DEDICATED PostgreSQL container for the faceting tests
 * (internal-contracts §33.1).
 *
 *   container  rfs-test-postgres          (the ONLY container this module may create, start, stop or remove)
 *   image      postgres:16-alpine
 *   port       127.0.0.1:15433 → 5432
 *   password   RFS_TEST_POSTGRES_PASSWORD, else the throwaway THROWAWAY_PASSWORD below (never a real secret)
 *   data       a tmpfs at /var/lib/postgresql/data (no docker volume is ever created), fsync off
 *
 *   ensure(pOptions, (pError, pConnectionInfo) => …)   start or reuse the container, wait until it accepts
 *                                                        connections, drop leftover rfs_* databases
 *   connectionInfo()                                     { host, port, user, password, database, Source }
 *   stop(fCallback)                                      docker stop + rm -v rfs-test-postgres (never anything else)
 *   status(fCallback)                                    (pError, 'absent' | 'running' | 'exited' | …)
 *   dropLeftoverDatabases(pInfo, pKeep, fCallback)      DROP every rfs_<pid>_<n> database with no connections
 *                                                        whose process is gone (never another database)
 *
 * RFS_TEST_POSTGRES_URL (postgres://user:password@host:port/database) bypasses docker entirely: ensure()
 * only waits for that server and cleans its leftover rfs_* databases.
 *
 * Safety: every docker invocation is built here from the constant container name (execFile, never a
 * shell); `ps` filters on `name=^/rfs-test-postgres$`; an existing container of that name built from
 * another image is refused rather than touched.  Nothing here may touch sluice-dev-postgres or any
 * other container, image, volume or network.
 *
 * CLI:  node test/support/Facet-Docker-Postgres.js ensure | stop | status
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChildProcess = require('child_process');

const CONTAINER_NAME = 'rfs-test-postgres';
const CONTAINER_FILTER = `name=^/${CONTAINER_NAME}$`;
const IMAGE = 'postgres:16-alpine';
const HOST_PORT = 15433;
const THROWAWAY_PASSWORD = 'rfs-throwaway-test-only';
const DATA_DIRECTORY = '/var/lib/postgresql/data';

// The per-harness database names the provider hook creates (internal-contracts §33.3).
const DATABASE_NAME_PATTERN = /^rfs_([0-9]+)_([0-9]+)$/;

const DEFAULT_TIMEOUT_MS = 60000;
const POLL_INTERVAL_MS = 400;
const DOCKER_TIMEOUT_MS = 120000;

/**
 * The pg module, loaded lazily (only PostgreSQL runs need it; the umbrella node_modules has it).
 *
 * @return {any}
 */
const pg = () =>
{
	return require('pg');
};

/**
 * Where the tests' PostgreSQL lives: RFS_TEST_POSTGRES_URL when set, else the container.
 *
 * @return {{ host: string, port: number, user: string, password: string, database: string, Source: string }}
 */
const connectionInfo = () =>
{
	let tmpURL = process.env.RFS_TEST_POSTGRES_URL;
	if ((typeof(tmpURL) === 'string') && (tmpURL.length > 0))
	{
		let tmpParsed;
		try
		{
			tmpParsed = new URL(tmpURL);
		}
		catch (pParseError)
		{
			throw new Error('RFS_TEST_POSTGRES_URL is not a URL (expected postgres://user:password@host:port/database).');
		}
		if ((tmpParsed.protocol !== 'postgres:') && (tmpParsed.protocol !== 'postgresql:'))
		{
			throw new Error('RFS_TEST_POSTGRES_URL must use the postgres:// scheme.');
		}
		let tmpDatabase = decodeURIComponent((tmpParsed.pathname || '').replace(/^\//, ''));
		return (
			{
				host: tmpParsed.hostname,
				port: tmpParsed.port ? parseInt(tmpParsed.port, 10) : 5432,
				user: decodeURIComponent(tmpParsed.username || 'postgres'),
				password: decodeURIComponent(tmpParsed.password || ''),
				database: (tmpDatabase.length > 0) ? tmpDatabase : 'postgres',
				Source: 'URL'
			});
	}
	return (
		{
			host: '127.0.0.1',
			port: HOST_PORT,
			user: 'postgres',
			password: process.env.RFS_TEST_POSTGRES_PASSWORD || THROWAWAY_PASSWORD,
			database: 'postgres',
			Source: 'Container'
		});
};

/**
 * pg client settings for the maintenance database (never one of the test databases).
 *
 * @param {Record<string, any>} pInfo - connectionInfo()
 * @param {string} [pDatabase]
 * @return {Record<string, any>}
 */
const clientConfig = (pInfo, pDatabase) =>
{
	return (
		{
			host: pInfo.host,
			port: pInfo.port,
			user: pInfo.user,
			password: pInfo.password,
			database: pDatabase || pInfo.database,
			connectionTimeoutMillis: 5000
		});
};

/**
 * Run one docker command built from the fixed container name (execFile: no shell).
 *
 * @param {Array<string>} pArgs
 * @param {Record<string, any>} pOptions - { Env?, TimeoutMS? }
 * @param {(pError?: Error, pStdout?: string, pStderr?: string) => void} fCallback
 */
const docker = (pArgs, pOptions, fCallback) =>
{
	let tmpOptions = pOptions || {};
	assertOwnContainer(pArgs);
	libChildProcess.execFile('docker', pArgs,
		{
			timeout: tmpOptions.TimeoutMS || DOCKER_TIMEOUT_MS,
			maxBuffer: 4 * 1024 * 1024,
			env: Object.assign({}, process.env, tmpOptions.Env || {})
		},
		(pError, pStdout, pStderr) =>
		{
			if (pError)
			{
				let tmpError = new Error(`docker ${pArgs[0]} failed: ${String(pStderr || pError.message).trim()}`);
				tmpError.Code = pError.code;
				return fCallback(tmpError, String(pStdout || ''), String(pStderr || ''));
			}
			return fCallback(null, String(pStdout || ''), String(pStderr || ''));
		});
};

/**
 * Refuse any docker command that does not target exactly this module's container.
 *
 * @param {Array<string>} pArgs
 */
const assertOwnContainer = (pArgs) =>
{
	let tmpVerb = pArgs[0];
	switch (tmpVerb)
	{
		case 'ps':
			if (pArgs.indexOf(CONTAINER_FILTER) < 0)
			{
				throw new Error('Facet-Docker-Postgres: docker ps must filter on the test container name.');
			}
			return;
		case 'run':
			if ((pArgs.indexOf('--name') < 0) || (pArgs[pArgs.indexOf('--name') + 1] !== CONTAINER_NAME))
			{
				throw new Error('Facet-Docker-Postgres: docker run must name the test container.');
			}
			return;
		case 'start':
		case 'stop':
		case 'unpause':
			if ((pArgs.length !== 2) || (pArgs[1] !== CONTAINER_NAME))
			{
				throw new Error(`Facet-Docker-Postgres: docker ${tmpVerb} may only target ${CONTAINER_NAME}.`);
			}
			return;
		case 'rm':
			if ((pArgs.length !== 3) || (pArgs[1] !== '-v') || (pArgs[2] !== CONTAINER_NAME))
			{
				throw new Error(`Facet-Docker-Postgres: docker rm may only target ${CONTAINER_NAME}.`);
			}
			return;
		case 'exec':
			// The container is the first positional argument after the verb (no exec flags are used),
			// so a command that merely MENTIONS the name ('exec other sh -c "echo rfs-test-postgres"') is refused.
			if ((pArgs.length < 3) || (pArgs[1] !== CONTAINER_NAME))
			{
				throw new Error(`Facet-Docker-Postgres: docker exec may only target ${CONTAINER_NAME}.`);
			}
			return;
		default:
			throw new Error(`Facet-Docker-Postgres: docker ${tmpVerb} is not allowed.`);
	}
};

/**
 * The container's state: 'absent', or docker's State ('running', 'exited', 'created', 'paused', …).
 *
 * @param {(pError?: Error, pState?: string) => void} fCallback
 */
const status = (fCallback) =>
{
	docker([ 'ps', '-a', '--filter', CONTAINER_FILTER, '--format', '{{.Names}}|{{.State}}|{{.Image}}' ], {},
		(pError, pStdout) =>
		{
			if (pError)
			{
				return fCallback(new Error(`Facet-Docker-Postgres: docker is not available (${pError.message}).`));
			}
			let tmpLines = pStdout.split('\n').map((pLine) => { return pLine.trim(); }).filter((pLine) => { return pLine.length > 0; });
			for (let i = 0; i < tmpLines.length; i++)
			{
				let tmpParts = tmpLines[i].split('|');
				if (tmpParts[0] === CONTAINER_NAME)
				{
					if (tmpParts[2] !== IMAGE)
					{
						return fCallback(new Error(`Facet-Docker-Postgres: a container named ${CONTAINER_NAME} exists but runs ${tmpParts[2]}, not ${IMAGE}; refusing to touch it.`));
					}
					return fCallback(null, tmpParts[1]);
				}
			}
			return fCallback(null, 'absent');
		});
};

/**
 * Create and start the container (tmpfs data directory: no volume is created).
 *
 * @param {(pError?: Error) => void} fCallback
 */
const runContainer = (fCallback) =>
{
	let tmpInfo = connectionInfo();
	let fRan = (pError, pStdout, pStderr) =>
	{
		if (pError && /Conflict|already in use/i.test(`${pError.message} ${pStderr || ''}`))
		{
			// Another run created it between our status() and run(): use theirs (still ours by name and image).
			return status((pStatusError, pState) =>
			{
				if (pStatusError)
				{
					return fCallback(pStatusError);
				}
				if (pState === 'running')
				{
					return fCallback();
				}
				return docker([ 'start', CONTAINER_NAME ], {}, (pStartError) => { return fCallback(pStartError || null); });
			});
		}
		return fCallback(pError || null);
	};
	docker(
		[
			'run', '-d',
			'--name', CONTAINER_NAME,
			'--label', 'com.retold.faceting.test=1',
			'-e', 'POSTGRES_PASSWORD',
			'-p', `127.0.0.1:${HOST_PORT}:5432`,
			'--tmpfs', `${DATA_DIRECTORY}:rw`,
			IMAGE,
			'postgres', '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'max_connections=200'
		],
		{ Env: { POSTGRES_PASSWORD: tmpInfo.password } },
		fRan);
};

/**
 * Call fTry until it succeeds or the deadline passes.
 *
 * @param {number} pDeadline - epoch ms
 * @param {(fDone: (pError?: Error) => void) => void} fTry
 * @param {(pError?: Error) => void} fCallback
 */
const poll = (pDeadline, fTry, fCallback) =>
{
	fTry(
		(pError) =>
		{
			if (!pError)
			{
				return fCallback();
			}
			if ((Date.now() > pDeadline) || (pError.Fatal === true))
			{
				return fCallback(pError);
			}
			setTimeout(() => { poll(pDeadline, fTry, fCallback); }, POLL_INTERVAL_MS);
		});
};

/**
 * One maintenance query on a short-lived client.
 *
 * @param {Record<string, any>} pInfo
 * @param {string} pSQL
 * @param {Array<any>} pValues
 * @param {(pError?: Error, pResult?: any) => void} fCallback
 */
const adminQuery = (pInfo, pSQL, pValues, fCallback) =>
{
	let tmpClient = new (pg().Client)(clientConfig(pInfo));
	let tmpDone = false;
	let fFinish = (pError, pResult) =>
	{
		if (tmpDone)
		{
			return;
		}
		tmpDone = true;
		tmpClient.end(() => { return fCallback(pError || null, pResult); });
	};
	tmpClient.on('error', (pError) => { fFinish(pError); });
	tmpClient.connect(
		(pConnectError) =>
		{
			if (pConnectError)
			{
				return fFinish(pConnectError);
			}
			tmpClient.query(pSQL, pValues || [], (pQueryError, pResult) => { return fFinish(pQueryError, pResult); });
		});
};

/**
 * Is a local process alive?  (Leftover databases of live processes are never dropped.)
 *
 * @param {number} pPID
 * @return {boolean}
 */
const processAlive = (pPID) =>
{
	try
	{
		process.kill(pPID, 0);
		return true;
	}
	catch (pError)
	{
		return (pError && (pError.code === 'EPERM'));
	}
};

/**
 * Drop leftover per-harness databases: names rfs_<pid>_<n> only, with no open connections, whose
 * creating process is gone (a concurrent run's fresh database is never dropped), never one in pKeep.
 *
 * @param {Record<string, any>} pInfo
 * @param {Array<string>} pKeep - database names this process still uses
 * @param {(pError?: Error, pDropped?: Array<string>) => void} fCallback
 */
const dropLeftoverDatabases = (pInfo, pKeep, fCallback) =>
{
	let tmpKeep = Array.isArray(pKeep) ? pKeep : [];
	adminQuery(pInfo,
		'SELECT "d"."datname" AS "Name", (SELECT count(*) FROM pg_stat_activity "a" WHERE "a"."datname" = "d"."datname") AS "Connections"'
		+ ' FROM pg_database "d" WHERE "d"."datname" LIKE \'rfs\\_%\' ESCAPE \'\\\'', [],
		(pError, pResult) =>
		{
			if (pError)
			{
				return fCallback(pError);
			}
			let tmpCandidates = pResult.rows.filter(
				(pRow) =>
				{
					let tmpMatch = DATABASE_NAME_PATTERN.exec(pRow.Name);
					if (!tmpMatch || (tmpKeep.indexOf(pRow.Name) >= 0) || (Number(pRow.Connections) > 0))
					{
						return false;
					}
					let tmpPID = parseInt(tmpMatch[1], 10);
					return (tmpPID !== process.pid) && !processAlive(tmpPID);
				}).map((pRow) => { return pRow.Name; });
			let tmpDropped = [];
			let fNext = (pIndex) =>
			{
				if (pIndex >= tmpCandidates.length)
				{
					return fCallback(null, tmpDropped);
				}
				// The name matched DATABASE_NAME_PATTERN, so it is safe to quote.
				adminQuery(pInfo, `DROP DATABASE IF EXISTS "${tmpCandidates[pIndex]}"`, [],
					(pDropError) =>
					{
						if (!pDropError)
						{
							tmpDropped.push(tmpCandidates[pIndex]);
						}
						return fNext(pIndex + 1);
					});
			};
			return fNext(0);
		});
};

/**
 * Wait until the server answers a real query from this host.
 *
 * @param {Record<string, any>} pInfo
 * @param {number} pDeadline
 * @param {(pError?: Error) => void} fCallback
 */
const waitForServer = (pInfo, pDeadline, fCallback) =>
{
	poll(pDeadline,
		(fDone) =>
		{
			adminQuery(pInfo, 'SELECT 1 AS "Ready"', [],
				(pError) =>
				{
					if (pError && ((pError.code === '28P01') || /password authentication failed/i.test(String(pError.message))))
					{
						// A wrong password never heals by waiting: stop polling now.
						pError.Fatal = true;
					}
					return fDone(pError);
				});
		},
		(pError) =>
		{
			if (pError)
			{
				let tmpHint = /password authentication failed/i.test(String(pError.message))
					? ' (the container was created with another password: run `npm run test:pg:down` and try again)'
					: '';
				return fCallback(new Error(`Facet-Docker-Postgres: PostgreSQL at ${pInfo.host}:${pInfo.port} did not accept connections: ${pError.message}${tmpHint}`));
			}
			return fCallback();
		});
};

/**
 * Start (or reuse) the test container — or the RFS_TEST_POSTGRES_URL server — and wait until it
 * accepts connections; then drop leftover rfs_* databases.
 *
 * @param {{ TimeoutMS?: number, Keep?: Array<string> }} pOptions
 * @param {(pError?: Error, pConnectionInfo?: Record<string, any>) => void} fCallback
 */
const ensure = (pOptions, fCallback) =>
{
	let tmpOptions = pOptions || {};
	let tmpDeadline = Date.now() + ((typeof(tmpOptions.TimeoutMS) === 'number') ? tmpOptions.TimeoutMS : DEFAULT_TIMEOUT_MS);
	let tmpInfo;
	try
	{
		tmpInfo = connectionInfo();
	}
	catch (pInfoError)
	{
		return fCallback(pInfoError);
	}

	let fReady = () =>
	{
		waitForServer(tmpInfo, tmpDeadline,
			(pWaitError) =>
			{
				if (pWaitError)
				{
					return fCallback(pWaitError);
				}
				if (tmpInfo.Source === 'URL')
				{
					// A shared server: a leftover rfs_<pid>_<n> may belong to a live process on ANOTHER
					// host (local pid liveness proves nothing), so never sweep there.
					return fCallback(null, tmpInfo);
				}
				dropLeftoverDatabases(tmpInfo, tmpOptions.Keep || [],
					(pDropError) =>
					{
						// A failed cleanup never blocks a run (the leftovers are harmless).
						return fCallback(null, tmpInfo);
					});
			});
	};

	if (tmpInfo.Source === 'URL')
	{
		return fReady();
	}

	let fWaitForContainer = () =>
	{
		// pg_isready over TCP inside the container: the image's init server listens on the socket only,
		// so this is not fooled by the first (temporary) start.
		poll(tmpDeadline,
			(fDone) =>
			{
				docker([ 'exec', CONTAINER_NAME, 'pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres' ], { TimeoutMS: 10000 }, (pError) => { return fDone(pError); });
			},
			(pError) =>
			{
				if (pError)
				{
					return fCallback(new Error(`Facet-Docker-Postgres: ${CONTAINER_NAME} did not become ready: ${pError.message}`));
				}
				return fReady();
			});
	};

	status(
		(pStatusError, pState) =>
		{
			if (pStatusError)
			{
				return fCallback(pStatusError);
			}
			switch (pState)
			{
				case 'running':
					return fWaitForContainer();
				case 'absent':
					return runContainer((pRunError) => { return pRunError ? fCallback(pRunError) : fWaitForContainer(); });
				case 'paused':
					return docker([ 'unpause', CONTAINER_NAME ], {}, (pError) => { return pError ? fCallback(pError) : fWaitForContainer(); });
				default:
					// exited / created / dead: start it again (its tmpfs data is gone; initdb runs again)
					return docker([ 'start', CONTAINER_NAME ], {}, (pError) => { return pError ? fCallback(pError) : fWaitForContainer(); });
			}
		});
};

/**
 * Stop and remove the test container (only rfs-test-postgres, with its anonymous volumes if any).
 *
 * @param {(pError?: Error) => void} fCallback
 */
const stop = (fCallback) =>
{
	status(
		(pStatusError, pState) =>
		{
			if (pStatusError)
			{
				return fCallback(pStatusError);
			}
			if (pState === 'absent')
			{
				return fCallback();
			}
			let fRemove = () =>
			{
				docker([ 'rm', '-v', CONTAINER_NAME ], {}, (pRemoveError) => { return fCallback(pRemoveError || null); });
			};
			if ((pState === 'running') || (pState === 'paused') || (pState === 'restarting'))
			{
				return docker([ 'stop', CONTAINER_NAME ], {}, (pStopError) => { return pStopError ? fCallback(pStopError) : fRemove(); });
			}
			return fRemove();
		});
};

module.exports = (
	{
		CONTAINER_NAME: CONTAINER_NAME,
		CONTAINER_FILTER: CONTAINER_FILTER,
		IMAGE: IMAGE,
		HOST_PORT: HOST_PORT,
		THROWAWAY_PASSWORD: THROWAWAY_PASSWORD,
		DATABASE_NAME_PATTERN: DATABASE_NAME_PATTERN,
		connectionInfo: connectionInfo,
		clientConfig: clientConfig,
		adminQuery: adminQuery,
		assertOwnContainer: assertOwnContainer,
		dropLeftoverDatabases: dropLeftoverDatabases,
		status: status,
		ensure: ensure,
		stop: stop
	});

// CLI: node test/support/Facet-Docker-Postgres.js ensure | stop | status
if (require.main === module)
{
	let tmpCommand = process.argv[2];
	let fExit = (pError, pMessage) =>
	{
		if (pError)
		{
			console.error(pError.message);
			process.exit(1);
		}
		if (pMessage)
		{
			console.log(pMessage);
		}
		process.exit(0);
	};
	switch (tmpCommand)
	{
		case 'ensure':
			ensure({},
				(pError, pInfo) =>
				{
					return fExit(pError, pInfo ? `PostgreSQL ready at ${pInfo.host}:${pInfo.port} (${pInfo.Source === 'URL' ? 'RFS_TEST_POSTGRES_URL' : CONTAINER_NAME}).` : null);
				});
			break;
		case 'stop':
			stop((pError) => { return fExit(pError, `${CONTAINER_NAME} removed (if it existed).`); });
			break;
		case 'status':
			status((pError, pState) => { return fExit(pError, `${CONTAINER_NAME}: ${pState}`); });
			break;
		default:
			fExit(new Error('Usage: node test/support/Facet-Docker-Postgres.js ensure | stop | status'));
	}
}
