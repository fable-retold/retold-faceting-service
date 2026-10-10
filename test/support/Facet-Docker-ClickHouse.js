/**
 * Facet-Docker-ClickHouse — the DEDICATED ClickHouse container for the faceting store tests
 * (internal-contracts §69).
 *
 *   container  rfs-test-clickhouse        (the ONLY ClickHouse container this module may create, start, stop or remove)
 *   image      clickhouse/clickhouse-server:24.8
 *   port       127.0.0.1:18123 → 8123     (HTTP interface only; the native port is not published)
 *   user       rfs_test, password RFS_TEST_CLICKHOUSE_PASSWORD, else the throwaway THROWAWAY_PASSWORD
 *              below (never a real secret); CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 so a test may create
 *              its own reader user / row policy inside its own database
 *   data       a tmpfs at /var/lib/clickhouse (no docker volume is ever created)
 *
 *   ensure(pOptions, (pError, pConnectionInfo) => …)   start or reuse the container, wait until it answers
 *                                                        /ping and an authenticated SELECT, drop leftover
 *                                                        rfs_<pid>_<n> databases of dead processes
 *   connectionInfo()                                     { URL, Host, Port, User, Password, Source }
 *   query(pInfo, pSQL, fCallback)                        one authenticated statement (support only; the
 *                                                        service has its own client, source/store/clickhouse/)
 *   stop(fCallback)                                      docker stop + rm -v rfs-test-clickhouse (never anything else)
 *   status(fCallback)                                    (pError, 'absent' | 'running' | 'exited' | …)
 *   dropLeftoverDatabases(pInfo, pKeep, fCallback)      DROP every rfs_<pid>_<n> (and demo rfs_demo_<port>_<pid>_<domain>)
 *                                                        database whose process is gone
 *
 * RFS_TEST_CLICKHOUSE_URL (http://user:password@host:port) bypasses docker entirely: ensure() only waits
 * for that server and never sweeps it (a shared server: local pid liveness proves nothing there).
 *
 * Safety: every docker invocation is built here from the constant container name (execFile, never a
 * shell); `ps` filters on `name=^/rfs-test-clickhouse$`; an existing container of that name built from
 * another image is refused rather than touched.  Nothing here may touch rfs-test-postgres, a Sluice
 * ClickHouse, or any other container, image, volume or network.
 *
 * CLI:  node test/support/Facet-Docker-ClickHouse.js ensure | stop | status | ping
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChildProcess = require('child_process');
const libHttp = require('http');
const libHttps = require('https');

const CONTAINER_NAME = 'rfs-test-clickhouse';
const CONTAINER_FILTER = `name=^/${CONTAINER_NAME}$`;
const IMAGE = 'clickhouse/clickhouse-server:24.8';
const HOST_PORT = 18123;
const USER = 'rfs_test';
const THROWAWAY_PASSWORD = 'rfs-ch-throwaway-test-only';
const DATA_DIRECTORY = '/var/lib/clickhouse';

// The per-store database names the tests create (internal-contracts §69.3): rfs_<pid>_<n>.
const DATABASE_NAME_PATTERN = /^rfs_([0-9]+)_([0-9]+)$/;
// The demo's (DEMO_CLICKHOUSE=1): rfs_demo_<front port>_<pid>_<domain>.
const DEMO_DATABASE_PATTERN = /^rfs_demo_([0-9]+)_([0-9]+)_([a-z0-9_]+)$/;

const DEFAULT_TIMEOUT_MS = 90000;
const POLL_INTERVAL_MS = 400;
const DOCKER_TIMEOUT_MS = 180000;
const HTTP_TIMEOUT_MS = 10000;

/**
 * Where the tests' ClickHouse lives: RFS_TEST_CLICKHOUSE_URL when set, else the container.
 *
 * @return {{ URL: string, Host: string, Port: number, Protocol: string, User: string, Password: string, Source: string }}
 */
const connectionInfo = () =>
{
	let tmpURL = process.env.RFS_TEST_CLICKHOUSE_URL;
	if ((typeof(tmpURL) === 'string') && (tmpURL.length > 0))
	{
		let tmpParsed;
		try
		{
			tmpParsed = new URL(tmpURL);
		}
		catch (pParseError)
		{
			throw new Error('RFS_TEST_CLICKHOUSE_URL is not a URL (expected http://user:password@host:port).');
		}
		if ((tmpParsed.protocol !== 'http:') && (tmpParsed.protocol !== 'https:'))
		{
			throw new Error('RFS_TEST_CLICKHOUSE_URL must use the http:// or https:// scheme.');
		}
		let tmpPort = tmpParsed.port ? parseInt(tmpParsed.port, 10) : ((tmpParsed.protocol === 'https:') ? 8443 : 8123);
		return (
			{
				URL: `${tmpParsed.protocol}//${tmpParsed.hostname}:${tmpPort}`,
				Host: tmpParsed.hostname,
				Port: tmpPort,
				Protocol: tmpParsed.protocol,
				User: decodeURIComponent(tmpParsed.username || 'default'),
				Password: decodeURIComponent(tmpParsed.password || ''),
				Source: 'URL'
			});
	}
	return (
		{
			URL: `http://127.0.0.1:${HOST_PORT}`,
			Host: '127.0.0.1',
			Port: HOST_PORT,
			Protocol: 'http:',
			User: USER,
			Password: process.env.RFS_TEST_CLICKHOUSE_PASSWORD || THROWAWAY_PASSWORD,
			Source: 'Container'
		});
};

/**
 * Refuse any docker command that does not target exactly this module's ClickHouse container.
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
				throw new Error('Facet-Docker-ClickHouse: docker ps must filter on the test container name.');
			}
			return;
		case 'run':
			if ((pArgs.indexOf('--name') < 0) || (pArgs[pArgs.indexOf('--name') + 1] !== CONTAINER_NAME))
			{
				throw new Error('Facet-Docker-ClickHouse: docker run must name the test container.');
			}
			return;
		case 'start':
		case 'stop':
		case 'unpause':
			if ((pArgs.length !== 2) || (pArgs[1] !== CONTAINER_NAME))
			{
				throw new Error(`Facet-Docker-ClickHouse: docker ${tmpVerb} may only target ${CONTAINER_NAME}.`);
			}
			return;
		case 'rm':
			if ((pArgs.length !== 3) || (pArgs[1] !== '-v') || (pArgs[2] !== CONTAINER_NAME))
			{
				throw new Error(`Facet-Docker-ClickHouse: docker rm may only target ${CONTAINER_NAME}.`);
			}
			return;
		default:
			throw new Error(`Facet-Docker-ClickHouse: docker ${tmpVerb} is not allowed.`);
	}
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
				return fCallback(new Error(`Facet-Docker-ClickHouse: docker is not available (${pError.message}).`));
			}
			let tmpLines = pStdout.split('\n').map((pLine) => { return pLine.trim(); }).filter((pLine) => { return pLine.length > 0; });
			for (let i = 0; i < tmpLines.length; i++)
			{
				let tmpParts = tmpLines[i].split('|');
				if (tmpParts[0] === CONTAINER_NAME)
				{
					if (tmpParts[2] !== IMAGE)
					{
						return fCallback(new Error(`Facet-Docker-ClickHouse: a container named ${CONTAINER_NAME} exists but runs ${tmpParts[2]}, not ${IMAGE}; refusing to touch it.`));
					}
					return fCallback(null, tmpParts[1]);
				}
			}
			return fCallback(null, 'absent');
		});
};

/**
 * The exact `docker run` arguments (also printed by the CLI `args` command, internal-contracts §69.1).
 *
 * @return {Array<string>}
 */
const runArguments = () =>
{
	return (
		[
			'run', '-d',
			'--name', CONTAINER_NAME,
			'--label', 'com.retold.faceting.test=1',
			'-e', 'CLICKHOUSE_USER',
			'-e', 'CLICKHOUSE_PASSWORD',
			'-e', 'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1',
			'-p', `127.0.0.1:${HOST_PORT}:8123`,
			'--ulimit', 'nofile=262144:262144',
			'--tmpfs', `${DATA_DIRECTORY}:rw`,
			IMAGE
		]);
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
	docker(runArguments(), { Env: { CLICKHOUSE_USER: tmpInfo.User, CLICKHOUSE_PASSWORD: tmpInfo.Password } }, fRan);
};

/**
 * One HTTP request to the server (support only).
 *
 * @param {Record<string, any>} pInfo - connectionInfo()
 * @param {string} pMethod
 * @param {string} pPath
 * @param {string|null} pBody
 * @param {boolean} pAuthenticate
 * @param {(pError?: Error, pResponse?: { Status: number, Text: string }) => void} fCallback
 */
const httpRequest = (pInfo, pMethod, pPath, pBody, pAuthenticate, fCallback) =>
{
	let tmpLib = (pInfo.Protocol === 'https:') ? libHttps : libHttp;
	let tmpHeaders = {};
	if (pAuthenticate)
	{
		tmpHeaders['X-ClickHouse-User'] = pInfo.User;
		if (pInfo.Password)
		{
			tmpHeaders['X-ClickHouse-Key'] = pInfo.Password;
		}
	}
	let tmpBuffer = (typeof(pBody) === 'string') ? Buffer.from(pBody) : null;
	if (tmpBuffer)
	{
		tmpHeaders['Content-Length'] = tmpBuffer.length;
	}
	let tmpDone = false;
	let fFinish = (pError, pResponse) =>
	{
		if (tmpDone)
		{
			return;
		}
		tmpDone = true;
		return fCallback(pError || null, pResponse);
	};
	let tmpRequest = tmpLib.request({ host: pInfo.Host, port: pInfo.Port, method: pMethod, path: pPath, headers: tmpHeaders, timeout: HTTP_TIMEOUT_MS },
		(pResponse) =>
		{
			let tmpChunks = [];
			pResponse.on('data', (pChunk) => { tmpChunks.push(pChunk); });
			pResponse.on('end', () => { return fFinish(null, { Status: pResponse.statusCode, Text: Buffer.concat(tmpChunks).toString('utf8') }); });
			pResponse.on('error', (pError) => { return fFinish(pError); });
		});
	tmpRequest.on('error', (pError) => { return fFinish(pError); });
	tmpRequest.on('timeout', () => { tmpRequest.destroy(new Error(`ClickHouse request timed out after ${HTTP_TIMEOUT_MS}ms.`)); });
	if (tmpBuffer)
	{
		tmpRequest.write(tmpBuffer);
	}
	tmpRequest.end();
};

/**
 * GET /ping → true when the server answers "Ok.".
 *
 * @param {Record<string, any>} pInfo
 * @param {(pError?: Error, pUp?: boolean) => void} fCallback
 */
const ping = (pInfo, fCallback) =>
{
	httpRequest(pInfo, 'GET', '/ping', null, false,
		(pError, pResponse) =>
		{
			if (pError)
			{
				return fCallback(pError, false);
			}
			return fCallback(null, (pResponse.Status === 200) && (pResponse.Text.indexOf('Ok') >= 0));
		});
};

/**
 * One authenticated statement (FORMAT JSON for a SELECT): (pError, { Status, Text, Rows }).
 *
 * @param {Record<string, any>} pInfo
 * @param {string} pSQL
 * @param {(pError?: Error, pResult?: { Status: number, Text: string, Rows: Array<any>|null }) => void} fCallback
 */
const query = (pInfo, pSQL, fCallback) =>
{
	httpRequest(pInfo, 'POST', '/?default_format=JSON&output_format_json_quote_64bit_integers=0', pSQL, true,
		(pError, pResponse) =>
		{
			if (pError)
			{
				return fCallback(pError);
			}
			if ((pResponse.Status < 200) || (pResponse.Status >= 300))
			{
				let tmpError = new Error(`ClickHouse ${pResponse.Status}: ${pResponse.Text.slice(0, 400)}`);
				tmpError.Status = pResponse.Status;
				// Authentication failures never heal by waiting (code 516 AUTHENTICATION_FAILED).
				tmpError.Fatal = /AUTHENTICATION_FAILED|Code: 516/.test(pResponse.Text);
				return fCallback(tmpError);
			}
			let tmpRows = null;
			try
			{
				let tmpParsed = JSON.parse(pResponse.Text);
				tmpRows = Array.isArray(tmpParsed.data) ? tmpParsed.data : null;
			}
			catch (pParseError)
			{
				tmpRows = null;
			}
			return fCallback(null, { Status: pResponse.Status, Text: pResponse.Text, Rows: tmpRows });
		});
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
 * Wait until the server answers /ping and an authenticated SELECT.
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
			ping(pInfo,
				(pPingError, pUp) =>
				{
					if (pPingError || !pUp)
					{
						return fDone(pPingError || new Error('ping did not answer Ok.'));
					}
					query(pInfo, 'SELECT 1 AS Ready', (pQueryError) => { return fDone(pQueryError); });
				});
		},
		(pError) =>
		{
			if (pError)
			{
				let tmpHint = (pError.Fatal === true)
					? ' (the container was created with another password: run `npm run test:ch:down` and try again)'
					: '';
				return fCallback(new Error(`Facet-Docker-ClickHouse: ClickHouse at ${pInfo.URL} did not answer: ${pError.message}${tmpHint}`));
			}
			return fCallback();
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
 * Drop leftover per-store test databases: names rfs_<pid>_<n> only, whose creating process is gone
 * (a concurrent run's fresh database is never dropped), never one in pKeep, never on a URL server.
 *
 * @param {Record<string, any>} pInfo
 * @param {Array<string>} pKeep - database names this process still uses
 * @param {(pError?: Error, pDropped?: Array<string>) => void} fCallback
 */
const dropLeftoverDatabases = (pInfo, pKeep, fCallback) =>
{
	if (pInfo.Source === 'URL')
	{
		return fCallback(null, []);
	}
	let tmpKeep = Array.isArray(pKeep) ? pKeep : [];
	query(pInfo, "SELECT name AS Name FROM system.databases WHERE name LIKE 'rfs\\_%'",
		(pError, pResult) =>
		{
			if (pError)
			{
				return fCallback(pError);
			}
			let tmpCandidates = (pResult.Rows || []).map((pRow) => { return pRow.Name; }).filter(
				(pName) =>
				{
					if (tmpKeep.indexOf(pName) >= 0)
					{
						return false;
					}
					let tmpMatch = DATABASE_NAME_PATTERN.exec(pName);
					let tmpDemo = DEMO_DATABASE_PATTERN.exec(pName);
					if (!tmpMatch && !tmpDemo)
					{
						return false;
					}
					let tmpPID = parseInt(tmpMatch ? tmpMatch[1] : tmpDemo[2], 10);
					return (tmpPID !== process.pid) && !processAlive(tmpPID);
				});
			let tmpDropped = [];
			let fNext = (pIndex) =>
			{
				if (pIndex >= tmpCandidates.length)
				{
					return fCallback(null, tmpDropped);
				}
				// The name matched DATABASE_NAME_PATTERN / DEMO_DATABASE_PATTERN, so it is safe to quote.
				query(pInfo, `DROP DATABASE IF EXISTS \`${tmpCandidates[pIndex]}\` SYNC`,
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
 * Start (or reuse) the test container — or the RFS_TEST_CLICKHOUSE_URL server — and wait until it
 * answers; then drop leftover rfs_<pid>_<n> databases (container only).
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
					return fReady();
				case 'absent':
					return runContainer((pRunError) => { return pRunError ? fCallback(pRunError) : fReady(); });
				case 'paused':
					return docker([ 'unpause', CONTAINER_NAME ], {}, (pError) => { return pError ? fCallback(pError) : fReady(); });
				default:
					// exited / created / dead: start it again (its tmpfs data is gone; the entrypoint re-creates the user)
					return docker([ 'start', CONTAINER_NAME ], {}, (pError) => { return pError ? fCallback(pError) : fReady(); });
			}
		});
};

/**
 * Stop and remove the test container (only rfs-test-clickhouse, with its anonymous volumes if any).
 *
 * @param {(pError?: Error) => void} fCallback
 */
const stop = (fCallback) =>
{
	if (connectionInfo().Source === 'URL')
	{
		// Never stop a server this module did not start.
		return fCallback();
	}
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

/**
 * Is the ClickHouse gate on?  (RFS_TEST_CLICKHOUSE=1 → the container; RFS_TEST_CLICKHOUSE_URL → that server.)
 *
 * @return {boolean}
 */
const gateOn = () =>
{
	return (process.env.RFS_TEST_CLICKHOUSE === '1')
		|| ((typeof(process.env.RFS_TEST_CLICKHOUSE_URL) === 'string') && (process.env.RFS_TEST_CLICKHOUSE_URL.length > 0));
};

module.exports = (
	{
		CONTAINER_NAME: CONTAINER_NAME,
		CONTAINER_FILTER: CONTAINER_FILTER,
		IMAGE: IMAGE,
		HOST_PORT: HOST_PORT,
		USER: USER,
		THROWAWAY_PASSWORD: THROWAWAY_PASSWORD,
		DATABASE_NAME_PATTERN: DATABASE_NAME_PATTERN,
		DEMO_DATABASE_PATTERN: DEMO_DATABASE_PATTERN,
		connectionInfo: connectionInfo,
		runArguments: runArguments,
		assertOwnContainer: assertOwnContainer,
		gateOn: gateOn,
		ping: ping,
		query: query,
		dropLeftoverDatabases: dropLeftoverDatabases,
		status: status,
		ensure: ensure,
		stop: stop
	});

// CLI: node test/support/Facet-Docker-ClickHouse.js ensure | stop | status | ping | args
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
					return fExit(pError, pInfo ? `ClickHouse ready at ${pInfo.URL} (${pInfo.Source === 'URL' ? 'RFS_TEST_CLICKHOUSE_URL' : CONTAINER_NAME}).` : null);
				});
			break;
		case 'stop':
			stop((pError) => { return fExit(pError, `${CONTAINER_NAME} removed (if it existed).`); });
			break;
		case 'status':
			status((pError, pState) => { return fExit(pError, `${CONTAINER_NAME}: ${pState}`); });
			break;
		case 'ping':
			{
				let tmpInfo = connectionInfo();
				ping(tmpInfo,
					(pPingError, pUp) =>
					{
						if (pPingError || !pUp)
						{
							return fExit(pPingError || new Error(`ClickHouse at ${tmpInfo.URL} did not answer /ping.`));
						}
						query(tmpInfo, 'SELECT version() AS Version, 1 + 1 AS Two',
							(pQueryError, pResult) =>
							{
								return fExit(pQueryError, pResult ? `ping Ok; ${JSON.stringify(pResult.Rows)}` : null);
							});
					});
			}
			break;
		case 'args':
			fExit(null, `docker ${runArguments().join(' ')}`);
			break;
		default:
			fExit(new Error('Usage: node test/support/Facet-Docker-ClickHouse.js ensure | stop | status | ping | args'));
	}
}
