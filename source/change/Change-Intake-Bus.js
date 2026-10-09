/**
 * Change-Intake-Bus -- the seam for the upstream MeadowChangeBus (design 05 §3, [UPSTREAM M-1 / ME-3]).
 *
 * When fable has a MeadowChangeBus with subscribe(), install() subscribes under 'RetoldFaceting' with
 * { onChangeSync: (e) => intake.ingestBusEvent(e), onBatch: (b, f) => f() }; the intake then maps each
 * bus ChangeEvent (05 §3.3) onto its own shape and the interim wrappers are not installed.  No bus
 * exists in M4: available() is false and install() is a no-op returning false.
 *
 * A plain class (an intake adapter, internal-contracts §38.3): constructed by the ChangeIntake service
 * with itself, never registered on fable.
 *
 * Contract: internal-contracts §40.6.  Owner: builder B (M4).
 *
 * @author Steven Velozo <steven@velozo.com>
 */

// The subscriber name on the bus.
const SUBSCRIBER_NAME = 'RetoldFaceting';

class ChangeIntakeBus
{
	/**
	 * @param {any} pIntake - the RetoldFacetingChangeIntake service that owns this adapter
	 */
	constructor(pIntake)
	{
		this.Intake = pIntake;
		this.fable = pIntake ? pIntake.fable : null;
		this._Installed = false;
		this._Bus = null;
	}

	/**
	 * @return {boolean} fable has a MeadowChangeBus this adapter can subscribe to
	 */
	available()
	{
		let tmpBus = this.fable ? this.fable.MeadowChangeBus : null;
		return !!(tmpBus && (typeof(tmpBus.subscribe) === 'function'));
	}

	/**
	 * @return {boolean} subscribed to the bus now
	 */
	isInstalled()
	{
		return this._Installed;
	}

	/**
	 * Subscribe to the bus (idempotent).  The synchronous hook feeds the intake (generations bump at
	 * emit time, 05 §3.2); the batch hook acknowledges at once (M4 has no batch consumer).
	 *
	 * @return {boolean} true when subscribed
	 */
	install()
	{
		if (!this.available())
		{
			return false;
		}
		let tmpBus = this.fable.MeadowChangeBus;
		if (this._Installed && (this._Bus === tmpBus))
		{
			return true;
		}
		let tmpIntake = this.Intake;
		try
		{
			tmpBus.subscribe(SUBSCRIBER_NAME,
				{
					onChangeSync: (pChangeEvent) =>
					{
						// ingestBusEvent never throws (the bus requires onChangeSync never to throw).
						tmpIntake.ingestBusEvent(pChangeEvent);
					},
					onBatch: (pChangeBatch, fDone) =>
					{
						if (typeof(fDone) === 'function')
						{
							return fDone();
						}
					}
				});
		}
		catch (pSubscribeError)
		{
			if (this.fable && this.fable.log)
			{
				this.fable.log.warn(`RetoldFaceting change intake: subscribing to the MeadowChangeBus failed: ${pSubscribeError.message}`);
			}
			return false;
		}
		this._Installed = true;
		this._Bus = tmpBus;
		return true;
	}

	/**
	 * Unsubscribe from the bus.
	 */
	uninstall()
	{
		if (this._Installed && this._Bus && (typeof(this._Bus.unsubscribe) === 'function'))
		{
			try
			{
				this._Bus.unsubscribe(SUBSCRIBER_NAME);
			}
			catch (pUnsubscribeError)
			{
				if (this.fable && this.fable.log)
				{
					this.fable.log.warn(`RetoldFaceting change intake: unsubscribing from the MeadowChangeBus failed: ${pUnsubscribeError.message}`);
				}
			}
		}
		this._Installed = false;
		this._Bus = null;
	}
}

module.exports = ChangeIntakeBus;
module.exports.SUBSCRIBER_NAME = SUBSCRIBER_NAME;
