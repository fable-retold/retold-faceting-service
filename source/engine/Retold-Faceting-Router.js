/**
 * Retold Faceting - Router
 *
 * Chooses the engine for a request's Aggs (03 §10).  Milestone 1: pContext.ForceEngine when set
 * (the Reference oracle, in-process only), otherwise the first registered engine whose
 * capable() accepts every Agg (Live).  Cache, stores, Pushdown and FanOut are later.
 *
 * Contract: internal-contracts §9.4.
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');
const libFacetErrors = require('../contract/Facet-Contract-Errors.js');

class RetoldFacetingRouter extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash]
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingRouter';

		// Ordered list of engines (registration order is preference order)
		this._Engines = [];
	}

	/**
	 * Register an engine (anything implementing the EngineBase contract).
	 *
	 * @param {any} pEngine
	 * @return {boolean}
	 */
	register(pEngine)
	{
		if (!pEngine || (typeof(pEngine.execute) !== 'function'))
		{
			return false;
		}
		this._Engines.push(pEngine);
		return true;
	}

	/**
	 * The registered engine with this EngineName, or null.
	 *
	 * @param {string} pEngineName
	 * @return {any|null}
	 */
	engine(pEngineName)
	{
		for (let i = 0; i < this._Engines.length; i++)
		{
			if (this._Engines[i].EngineName === pEngineName)
			{
				return this._Engines[i];
			}
		}
		return null;
	}

	/**
	 * Route and execute.
	 *
	 * @param {Array<Record<string, any>>} pAggs
	 * @param {Record<string, any>} pContext
	 * @param {(pError?: Error, pExecution?: Record<string, any>) => void} fCallback
	 */
	route(pAggs, pContext, fCallback)
	{
		let tmpAggs = Array.isArray(pAggs) ? pAggs : [];
		let tmpEngine = null;
		if (pContext && (typeof(pContext.ForceEngine) === 'string') && (pContext.ForceEngine.length > 0))
		{
			// In-process only (tests, fixture CLI): never reachable from a client.
			tmpEngine = this.engine(pContext.ForceEngine);
			if (!tmpEngine)
			{
				return fCallback(libFacetErrors.create('FACET_INTERNAL', 'The forced engine is not registered.'));
			}
		}
		else
		{
			// Cache and store engines are later milestones: the first registered engine that accepts
			// every Agg answers the whole request.
			for (let i = 0; (i < this._Engines.length) && !tmpEngine; i++)
			{
				let tmpCandidate = this._Engines[i];
				let tmpAllCapable = true;
				for (let j = 0; j < tmpAggs.length; j++)
				{
					let tmpCapable = tmpCandidate.capable(tmpAggs[j], pContext);
					if (!tmpCapable || !tmpCapable.Capable)
					{
						tmpAllCapable = false;
						break;
					}
				}
				if (tmpAllCapable)
				{
					tmpEngine = tmpCandidate;
				}
			}
			if (!tmpEngine)
			{
				// No engine takes every Agg: the Live engine reports the ones it refuses per facet.
				tmpEngine = this.engine('Live');
			}
			if (!tmpEngine)
			{
				return fCallback(libFacetErrors.create('FACET_INTERNAL', 'No facet engine is registered.'));
			}
		}
		let tmpCalledBack = false;
		try
		{
			return tmpEngine.execute(pContext, tmpAggs,
				(pError, pExecution) =>
				{
					if (tmpCalledBack)
					{
						this.fable.log.error(`RetoldFaceting Router: engine ${tmpEngine.EngineName} called back more than once.`);
						return;
					}
					tmpCalledBack = true;
					return fCallback(pError, pExecution);
				});
		}
		catch (pExecuteError)
		{
			if (tmpCalledBack)
			{
				// Thrown by our caller's own continuation: not ours to swallow.
				throw pExecuteError;
			}
			tmpCalledBack = true;
			this.fable.log.error(`RetoldFaceting Router: engine ${tmpEngine.EngineName} threw: ${pExecuteError.message}`);
			return fCallback(libFacetErrors.isFacetError(pExecuteError) ? pExecuteError : libFacetErrors.create('FACET_INTERNAL'));
		}
	}
}

module.exports = RetoldFacetingRouter;
module.exports.serviceType = 'RetoldFacetingRouter';
