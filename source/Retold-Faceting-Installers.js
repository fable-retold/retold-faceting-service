/**
 * Retold Faceting - Installers
 *
 * How the service is mounted into a host (design 07 §2.1 path 3, "Today"): call
 * installOnRetoldDataService inside the RetoldDataService initializeService callback.
 * Later milestones add foundationHookInstaller / foundationRouteInstaller (RAFS),
 * createStandaloneServer and mountFacetProxy.
 *
 * Contract: internal-contracts §12.3.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libOptions = require('./Retold-Faceting-Service-Options.js');
const libFacetErrors = require('./contract/Facet-Contract-Errors.js');

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

module.exports = (
	{
		installOnRetoldDataService: installOnRetoldDataService
	});
