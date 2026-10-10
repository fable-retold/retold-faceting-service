/**
 * Retold Faceting - WriterClock
 *
 * The monotonic version source of one store (design 04 §6.1 step 1; internal-contracts §58.4):
 * next() = max(Date.now() × 1000, last + 1) in microseconds, assigned BEFORE every fresh read, so a
 * higher _Version always carries an equal or newer source state.  seed(pFloor) raises the floor; the
 * Materializer seeds it with Store.maxVersion() at start, so a restart, a restore or wall-clock skew
 * can never go backwards (no _rfs_clock table, §68 #7).
 *
 * Constructed by the Materializer (one per store), never registered.  The contracts pass implemented
 * it (it is tiny and every builder's tests depend on it); builder B owns it.
 *
 * Contract: internal-contracts §58.4.  Owner: builder B (M5).
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libOptions = require('../Retold-Faceting-Service-Options.js');

class RetoldFacetingWriterClock extends libFableServiceProviderBase
{
	/**
	 * @param {import('fable')} pFable
	 * @param {Record<string, any>} [pOptions] - RetoldFaceting options
	 * @param {string} [pServiceHash] - the store name
	 */
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, libOptions.resolve(pOptions), pServiceHash);

		this.serviceType = 'RetoldFacetingWriterClock';

		this._Last = 0;
	}

	/**
	 * The last version handed out (0 before any).
	 *
	 * @return {number}
	 */
	get Last()
	{
		return this._Last;
	}

	/**
	 * The next version: strictly greater than every earlier one and every seeded floor.
	 *
	 * @return {number}
	 */
	next()
	{
		let tmpNow = Date.now() * 1000;
		this._Last = (tmpNow > this._Last) ? tmpNow : (this._Last + 1);
		return this._Last;
	}

	/**
	 * Raise the floor (never lowers it).
	 *
	 * @param {number} pFloor
	 * @return {number} the floor now in force
	 */
	seed(pFloor)
	{
		let tmpFloor = Number(pFloor);
		if (Number.isSafeInteger(tmpFloor) && (tmpFloor > this._Last))
		{
			this._Last = tmpFloor;
		}
		return this._Last;
	}
}

module.exports = RetoldFacetingWriterClock;
module.exports.serviceType = 'RetoldFacetingWriterClock';
