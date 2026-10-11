/**
 * Retold Faceting - Installers
 *
 * How the service is mounted into a host (design 07 §2.1 path 3, "Today"): call
 * installOnRetoldDataService inside the RetoldDataService initializeService callback.
 *
 * On a retold-application-foundation-server (RAFS) app, foundationHookInstaller and
 * foundationRouteInstaller are boot steps in RAFS's own step convention (design 07 §3.1,
 * internal-contracts Part V §73): the hook phase registers the service on pServer.fable and binds the
 * RetoldFacetingHostApplicationServer after tenancy / entitlements / membership are installed (catalog,
 * change capture, stores; in-process queries work from here), the route phase captures late mounts and
 * mounts the facet routes before listen.  Any failure fails the RAFS boot (never a silent no-op).
 *
 * Later milestones add createStandaloneServer and mountFacetProxy.
 *
 * Contract: internal-contracts §12.3, §73, §77.4.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libOptions = require('./Retold-Faceting-Service-Options.js');
const libFacetErrors = require('./contract/Facet-Contract-Errors.js');
const libFacetUtil = require('./contract/Facet-Contract-Util.js');
const libRetoldFacetingHostApplicationServer = require('./host/Retold-Faceting-Host-ApplicationServer.js');

// The two RAFS boot phases (internal-contracts §73.1).
const FOUNDATION_PHASES = Object.freeze([ 'Hook', 'Routes' ]);

// Where foundation options came from (internal-contracts §73.2), in precedence order.
const FOUNDATION_OPTION_SOURCES = Object.freeze([ 'Explicit', 'ServerOptions', 'Manifest', 'Defaults' ]);

// Defaults that differ on a RAFS host (internal-contracts §73.2), applied under the chosen source:
// open change streams re-read their session through Host.revalidatePrincipal (cheap, no reconnect), so
// they are re-checked every minute instead of every five (a logout reaches an open stream within ~60 s).
const FOUNDATION_DEFAULTS = Object.freeze({ SSE: Object.freeze({ RevalidateMS: 60000 }) });

// How many differing option paths a refusal names (the rest are counted).
const MAX_DIFFERENCES_NAMED = 8;

// Phase → [ installer name, the RAFS hook method that returns its step ] (for usage errors).
const FOUNDATION_PHASE_NAMES = Object.freeze(
	{
		Hook: Object.freeze([ 'foundationHookInstaller', 'hookInstallers' ]),
		Routes: Object.freeze([ 'foundationRouteInstaller', 'routeInstallers' ])
	});

/**
 * Install the faceting service (Role 'Embedded') on an initialized RetoldDataService:
 *   1. fable.addServiceType('RetoldFacetingService', …) + instantiateServiceProvider(resolve(pOptions))
 *   2. RetoldFacetingService.attach({ RetoldDataService }, …) — host bind, catalog build, routes
 *
 * Refuses (callback error, nothing mounted) when: the RDS is not usable, the role is not
 * 'Embedded' (M1), or the service is already attached on this fable; attach() itself refuses an
 * entity named like a facet route segment (D-17, Host.reservedEntityNames — the one check).
 * pOptions defaults to fable.settings.RetoldFaceting.
 *
 * @param {any} pRetoldDataService - fable.RetoldDataService (after initializeService)
 * @param {Record<string, any>} [pOptions] - RetoldFaceting options (partial)
 * @param {(pError?: Error, pService?: any) => void} fCallback
 */
const installOnRetoldDataService = (pRetoldDataService, pOptions, fCallback) =>
{
	let tmpCalledBack = false;
	let fDone = (pError, pService) =>
	{
		if (tmpCalledBack)
		{
			return;
		}
		tmpCalledBack = true;
		if (typeof(fCallback) === 'function')
		{
			return fCallback(pError, pService);
		}
		if (pError && pRetoldDataService && pRetoldDataService.fable && pRetoldDataService.fable.log)
		{
			pRetoldDataService.fable.log.error(`RetoldFaceting install failed: ${pError.message}`);
		}
	};

	if (!pRetoldDataService || (typeof(pRetoldDataService) !== 'object') || !pRetoldDataService.fable)
	{
		return fDone(libFacetErrors.create('FACET_INTERNAL', 'installOnRetoldDataService needs an initialized RetoldDataService.'));
	}
	let tmpFable = pRetoldDataService.fable;
	if (!tmpFable.OratorServiceServer)
	{
		return fDone(libFacetErrors.create('FACET_INTERNAL', 'installOnRetoldDataService needs the RetoldDataService Orator service server.'));
	}
	let tmpPartialOptions = ((typeof(pOptions) === 'object') && (pOptions !== null)) ? pOptions
		: (tmpFable.settings && (typeof(tmpFable.settings.RetoldFaceting) === 'object') && (tmpFable.settings.RetoldFaceting !== null)) ? tmpFable.settings.RetoldFaceting
		: {};
	let tmpOptions = libOptions.resolve(tmpPartialOptions);

	if (tmpOptions.Role !== 'Embedded')
	{
		return fDone(libFacetErrors.create('FACET_INTERNAL', `installOnRetoldDataService supports Role 'Embedded' only in this milestone (got '${tmpOptions.Role}').`));
	}
	let tmpExisting = tmpFable.RetoldFacetingService;
	if (tmpExisting && tmpExisting._Attached)
	{
		return fDone(libFacetErrors.create('FACET_INTERNAL', 'The faceting service is already installed on this RetoldDataService.'));
	}
	if (pRetoldDataService.serviceInitialized === false)
	{
		tmpFable.log.warn('RetoldFaceting: installing on a RetoldDataService that has not finished initializeService; install inside its callback.');
	}

	let tmpService = null;
	try
	{
		// Late require: Retold-Faceting-Service.js re-exports this module's function.
		let libRetoldFacetingService = require('./Retold-Faceting-Service.js');
		if (tmpExisting)
		{
			// Registered (not attached) by the application: attach that instance.
			tmpService = tmpExisting;
		}
		else
		{
			if (!tmpFable.servicesMap || !Object.prototype.hasOwnProperty.call(tmpFable.servicesMap, 'RetoldFacetingService'))
			{
				tmpFable.addServiceType('RetoldFacetingService', libRetoldFacetingService);
			}
			tmpService = tmpFable.instantiateServiceProvider('RetoldFacetingService', tmpOptions);
		}
		tmpService.attach({ RetoldDataService: pRetoldDataService },
			(pAttachError) =>
			{
				if (pAttachError)
				{
					return fDone(pAttachError);
				}
				return fDone(null, tmpService);
			});
	}
	catch (pInstallError)
	{
		if (tmpCalledBack)
		{
			// Thrown by the caller's own callback (attach called back synchronously): not ours to swallow.
			throw pInstallError;
		}
		tmpFable.log.error(`RetoldFaceting install threw: ${pInstallError.message}`);
		return fDone(libFacetErrors.isFacetError(pInstallError) ? pInstallError : libFacetErrors.create('FACET_INTERNAL', `Faceting install failed: ${pInstallError.message}`));
	}
};

/**
 * The Faceting block of the app manifest the server class was built from (RetoldApplicationServer
 * .fromManifest stamps the class with .manifest, Retold-Application-Server.js:945): Options.Faceting
 * today, a top-level Faceting once [UPSTREAM RAFS-4] adds it to the manifest key list.
 *
 * @param {any} pServer
 * @return {Record<string, any>|null}
 */
const manifestFacetingOptions = (pServer) =>
{
	let tmpManifest = (pServer && pServer.constructor && libFacetUtil.isPlainObject(pServer.constructor.manifest)) ? pServer.constructor.manifest : null;
	if (!tmpManifest)
	{
		return null;
	}
	if (libFacetUtil.isPlainObject(tmpManifest.Options) && libFacetUtil.isPlainObject(tmpManifest.Options.Faceting))
	{
		return tmpManifest.Options.Faceting;
	}
	return libFacetUtil.isPlainObject(tmpManifest.Faceting) ? tmpManifest.Faceting : null;
};

/**
 * Resolve the RetoldFaceting options of a RAFS install (internal-contracts §73.2): the FIRST plain
 * object of explicit pOptions > pServer.options.Faceting > the manifest's Faceting block is used
 * whole (sources are never merged with one another), then resolved against FOUNDATION_DEFAULTS and the
 * defaults.  The tenancy policy is never read from here (§75.3).
 *
 * @param {any} pServer - a RetoldApplicationServer
 * @param {Record<string, any>} [pOptions] - explicit RetoldFaceting options (partial)
 * @return {{ Source: string, Options: Record<string, any> }}
 */
const resolveFoundationOptions = (pServer, pOptions) =>
{
	let fResolve = (pSource) => { return libOptions.resolve(libOptions.deepMerge(FOUNDATION_DEFAULTS, pSource)); };
	if (libFacetUtil.isPlainObject(pOptions))
	{
		return { Source: 'Explicit', Options: fResolve(pOptions) };
	}
	if (pServer && libFacetUtil.isPlainObject(pServer.options) && libFacetUtil.isPlainObject(pServer.options.Faceting))
	{
		return { Source: 'ServerOptions', Options: fResolve(pServer.options.Faceting) };
	}
	let tmpManifestOptions = manifestFacetingOptions(pServer);
	if (tmpManifestOptions)
	{
		return { Source: 'Manifest', Options: fResolve(tmpManifestOptions) };
	}
	return { Source: 'Defaults', Options: fResolve({}) };
};

/**
 * Resolved options with the RAFS default admin authorizer (internal-contracts §77.4) when the app gave
 * none.  A copy: the input is never mutated.
 *
 * @param {Record<string, any>} pResolved
 * @return {Record<string, any>}
 */
const withPlatformAdmin = (pResolved) =>
{
	if (libFacetUtil.isPlainObject(pResolved.Admin) && (typeof(pResolved.Admin.authorize) === 'function'))
	{
		return pResolved;
	}
	return libOptions.resolve(libOptions.deepMerge(pResolved, { Admin: { authorize: platformAdminAuthorize } }));
};

/**
 * The option paths where two resolved option objects differ.  Plain objects compare key by key, arrays
 * element by element; functions are equal when identical or when their source text is identical (two
 * inline arrow functions written the same way); anything else by ===.  Pure.
 *
 * @param {any} pLeft
 * @param {any} pRight
 * @param {Array<string>} [pIgnore] - top-level keys to skip
 * @return {Array<string>}
 */
const optionDifferences = (pLeft, pRight, pIgnore) =>
{
	let tmpDifferences = [];
	let tmpIgnore = Array.isArray(pIgnore) ? pIgnore : [];
	let fCompare = (pA, pB, pPath, pDepth) =>
	{
		if (pA === pB)
		{
			return;
		}
		if ((typeof(pA) === 'function') && (typeof(pB) === 'function'))
		{
			if (Function.prototype.toString.call(pA) !== Function.prototype.toString.call(pB))
			{
				tmpDifferences.push(pPath || '(root)');
			}
			return;
		}
		if (Array.isArray(pA) && Array.isArray(pB))
		{
			if (pA.length !== pB.length)
			{
				tmpDifferences.push(pPath);
				return;
			}
			for (let i = 0; i < pA.length; i++)
			{
				fCompare(pA[i], pB[i], `${pPath}[${i}]`, pDepth + 1);
			}
			return;
		}
		if (libFacetUtil.isPlainObject(pA) && libFacetUtil.isPlainObject(pB) && (pDepth < 32))
		{
			let tmpKeys = Array.from(new Set(Object.keys(pA).concat(Object.keys(pB)))).sort();
			for (let i = 0; i < tmpKeys.length; i++)
			{
				if ((pDepth === 0) && (tmpIgnore.indexOf(tmpKeys[i]) >= 0))
				{
					continue;
				}
				fCompare(pA[tmpKeys[i]], pB[tmpKeys[i]], pPath ? `${pPath}.${tmpKeys[i]}` : tmpKeys[i], pDepth + 1);
			}
			return;
		}
		tmpDifferences.push(pPath || '(root)');
	};
	fCompare(pLeft, pRight, '', 0);
	return tmpDifferences;
};

/**
 * The default admin-route authorizer on RAFS (internal-contracts §77.4): only a platform principal
 * (Membership SystemAdminField === SystemAdminValue on the session UserRecord) passes.  Admin.Routes
 * stays false unless the app turns it on; Platform never widens a query.
 *
 * @param {any} pRequest
 * @param {Record<string, any>} pPrincipal
 * @return {boolean}
 */
const platformAdminAuthorize = (pRequest, pPrincipal) =>
{
	return !!pPrincipal && (pPrincipal.Platform === true);
};

/**
 * Run one RAFS boot phase (internal-contracts §73.3 / §73.4): validate the server and the options,
 * register the service on pServer.fable (the first phase that runs; the hook phase normally), then
 * RetoldFacetingService.attach({ ApplicationServer: pServer, Phase }).
 *
 * @param {string} pPhase - 'Hook' | 'Routes'
 * @param {any} pServer
 * @param {Record<string, any>} [pOptions]
 * @param {(pError?: Error, pService?: any) => void} fDone
 */
const runFoundationPhase = (pPhase, pServer, pOptions, fDone) =>
{
	if (!libRetoldFacetingHostApplicationServer.isApplicationServer(pServer))
	{
		let tmpNames = FOUNDATION_PHASE_NAMES[pPhase];
		return fDone(libFacetErrors.create('FACET_INTERNAL', `${tmpNames[0]} needs the RetoldApplicationServer whose boot reached this step: put ${tmpNames[0]}(this, options) in the array ${tmpNames[1]}() returns.`));
	}
	let tmpResolved = resolveFoundationOptions(pServer, pOptions);
	if (tmpResolved.Options.Role !== 'Embedded')
	{
		return fDone(libFacetErrors.create('FACET_INTERNAL', `The foundation installers support Role 'Embedded' only in this release (got '${tmpResolved.Options.Role}').`));
	}
	let tmpFable = pServer.fable;
	// Late require: Retold-Faceting-Service.js re-exports this module's functions.
	let libRetoldFacetingService = require('./Retold-Faceting-Service.js');
	let tmpService = (tmpFable.RetoldFacetingService && (typeof(tmpFable.RetoldFacetingService.attach) === 'function')) ? tmpFable.RetoldFacetingService : null;
	if (tmpService)
	{
		// Registered by the hook phase (or by the application): attach that instance with its own options.
		if (tmpService._Attached && tmpService.Host
			&& ((typeof(tmpService.Host.getApplicationServer) !== 'function') || (tmpService.Host.getApplicationServer() !== pServer)))
		{
			return fDone(libFacetErrors.create('FACET_INTERNAL', 'The faceting service on this fable is already attached to a different host.'));
		}
		if (tmpService.options.Role !== 'Embedded')
		{
			return fDone(libFacetErrors.create('FACET_INTERNAL', `The foundation installers support Role 'Embedded' only in this release (got '${tmpService.options.Role}').`));
		}
		if (libFacetUtil.isPlainObject(pOptions))
		{
			// Options handed to this installer must be the ones the running service uses: a stricter object
			// given only to the route installer (NeverFacet, RequireAction, Scope …) must never be dropped.
			// Materialize 'All' is expanded in place by the store install (§54.2), so it is compared as given.
			let tmpIgnore = (tmpService._MaterializeAll && (tmpResolved.Options.Materialize === 'All')) ? [ 'Materialize' ] : [];
			let tmpDifferences = optionDifferences(withPlatformAdmin(tmpResolved.Options), withPlatformAdmin(tmpService.options), tmpIgnore);
			if (tmpDifferences.length > 0)
			{
				let tmpNamed = tmpDifferences.slice(0, MAX_DIFFERENCES_NAMED).join(', ') + ((tmpDifferences.length > MAX_DIFFERENCES_NAMED) ? ` and ${tmpDifferences.length - MAX_DIFFERENCES_NAMED} more` : '');
				return fDone(libFacetErrors.create('FACET_INTERNAL', `${FOUNDATION_PHASE_NAMES[pPhase][0]} was given options that differ from the ones the faceting service on this fable runs with ([${tmpNamed}]); pass the same options object to both installers, or omit it from the second one.`));
			}
		}
	}
	else
	{
		// A copy when the admin authorizer is added: the caller's options object is never mutated.
		let tmpOptions = withPlatformAdmin(tmpResolved.Options);
		if (!tmpFable.servicesMap || !Object.prototype.hasOwnProperty.call(tmpFable.servicesMap, 'RetoldFacetingService'))
		{
			tmpFable.addServiceType('RetoldFacetingService', libRetoldFacetingService);
		}
		tmpService = tmpFable.instantiateServiceProvider('RetoldFacetingService', tmpOptions);
		tmpFable.log.info(`RetoldFaceting: installing on the RetoldApplicationServer (${pPhase} phase; options from ${tmpResolved.Source}).`);
	}
	tmpService.attach({ ApplicationServer: pServer, Phase: pPhase },
		(pAttachError) =>
		{
			if (pAttachError)
			{
				return fDone(libFacetErrors.isFacetError(pAttachError) ? pAttachError : libFacetErrors.create('FACET_INTERNAL', `Faceting ${pPhase} install failed: ${pAttachError.message}`));
			}
			return fDone(null, tmpService);
		});
};

/**
 * A RAFS installer in RAFS's step convention (Retold-Application-Server.js:248, :296-299: the arrays
 * hookInstallers() / routeInstallers() return are pushed unbound and each is called with exactly one
 * callback by fable's Anticipate, which throws when a step calls back twice):
 *
 *   installer(pServer, pOptions)          → a step function (fStep) => void, run later by the boot
 *   installer(pServer, pOptions, fStep)   → runs now and calls fStep(pError?) exactly once
 *
 * fStep is always called on a later tick (setImmediate), never synchronously: Anticipate drops an
 * error a step reports synchronously before the boot's wait() is registered (its lastError is reset
 * by the same checkQueue), and an asynchronous callback also keeps the boot from recursing through
 * the rest of the step queue on our stack.  A throw from the caller's own fStep therefore surfaces on
 * that tick (it is never swallowed).  Used unbound as a raw step (the installer itself put in the
 * array), the "server" argument is the step callback: it is called back with a usage error instead
 * of hanging the boot.
 *
 * @param {string} pPhase - 'Hook' | 'Routes'
 * @param {any} pServer
 * @param {Record<string, any>} [pOptions]
 * @param {(pError?: Error) => void} [fStep]
 * @return {((fStep: (pError?: Error) => void) => void)|undefined}
 */
const foundationStep = (pPhase, pServer, pOptions, fStep) =>
{
	let fRun = (fStepCallback) =>
	{
		let tmpCalledBack = false;
		let fDone = (pError) =>
		{
			if (tmpCalledBack)
			{
				return;
			}
			tmpCalledBack = true;
			if (typeof(fStepCallback) === 'function')
			{
				setImmediate(() => { fStepCallback(pError || undefined); });
			}
		};
		try
		{
			runFoundationPhase(pPhase, pServer, pOptions, fDone);
		}
		catch (pInstallError)
		{
			if (tmpCalledBack)
			{
				// After the phase already called back: the boot has its answer, so the log is the only place left.
				if (pServer && pServer.fable && pServer.fable.log)
				{
					pServer.fable.log.error(`RetoldFaceting ${pPhase} install threw after it called back: ${pInstallError.message}`);
				}
				return;
			}
			fDone(libFacetErrors.isFacetError(pInstallError) ? pInstallError : libFacetErrors.create('FACET_INTERNAL', `Faceting ${pPhase} install failed: ${pInstallError.message}`));
		}
	};
	if ((typeof(pServer) === 'function') && (typeof(pOptions) === 'undefined') && (typeof(fStep) === 'undefined'))
	{
		// The installer itself was put in the step array: RAFS handed us its step callback.
		let tmpNames = FOUNDATION_PHASE_NAMES[pPhase];
		let fMisusedStep = pServer;
		setImmediate(() => { fMisusedStep(libFacetErrors.create('FACET_INTERNAL', `Put ${tmpNames[0]}(this, options) in the array ${tmpNames[1]}() returns, not the installer function itself.`)); });
		return undefined;
	}
	if (typeof(fStep) === 'function')
	{
		fRun(fStep);
		return undefined;
	}
	return fRun;
};

/**
 * RAFS hook phase (internal-contracts §73.3): from hookInstallers(), after tenancy / entitlements /
 * membership are installed: bind the host, build the catalog, install change capture and the stores.
 *
 * @param {any} pServer - the RetoldApplicationServer (`this` in hookInstallers())
 * @param {Record<string, any>} [pOptions] - RetoldFaceting options (§73.2 precedence)
 * @param {(pError?: Error) => void} [fStep]
 * @return {((fStep: (pError?: Error) => void) => void)|undefined} the step, when fStep is omitted
 */
const foundationHookInstaller = (pServer, pOptions, fStep) =>
{
	return foundationStep('Hook', pServer, pOptions, fStep);
};

/**
 * RAFS route phase (internal-contracts §73.4): LAST in routeInstallers(): capture late mounts, mount
 * the facet routes and the shutdown hook before _startOrator.  Runs the hook phase first when it did
 * not run (fail closed: §75.2).
 *
 * @param {any} pServer
 * @param {Record<string, any>} [pOptions]
 * @param {(pError?: Error) => void} [fStep]
 * @return {((fStep: (pError?: Error) => void) => void)|undefined}
 */
const foundationRouteInstaller = (pServer, pOptions, fStep) =>
{
	return foundationStep('Routes', pServer, pOptions, fStep);
};

module.exports = (
	{
		installOnRetoldDataService: installOnRetoldDataService,
		foundationHookInstaller: foundationHookInstaller,
		foundationRouteInstaller: foundationRouteInstaller,
		resolveFoundationOptions: resolveFoundationOptions,
		optionDifferences: optionDifferences,
		platformAdminAuthorize: platformAdminAuthorize,
		FOUNDATION_DEFAULTS: FOUNDATION_DEFAULTS,
		FOUNDATION_PHASES: FOUNDATION_PHASES,
		FOUNDATION_OPTION_SOURCES: FOUNDATION_OPTION_SOURCES
	});
