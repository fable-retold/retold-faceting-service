/**
 * Facet-ChangeIntake: the interim intake over every write path, notify / notifyByFilter, the Seq clock and the Bus seam.
 *
 * Owner: builder B (M4).  Obligations: internal-contracts §39, §40, §49.1.  Registry port: 19133.
 *
 *   - Seq clock, ingest normalization, freezing and synchronous delivery (no server);
 *   - changeFromRows / notify / notifyByFilter / the settle re-delivery over a tiny host (no server);
 *   - the §40.2 wrapping rules on a stand-alone controller (meadow-endpoints' own BehaviorInjection);
 *   - the Bus adapter against a fake bus, and source selection;
 *   - every write path over HTTP on ProjectTrack, LabTrack (owner-qualified) and Bookstore-Tenant,
 *     incl. behaviors installed before and after the intake, erroring / throwing previous behaviors,
 *     a throwing subscriber, DAL-direct writes (not seen) and a model reload (no double events).
 *
 * The HTTP harnesses start with ChangeCapture.Intake 'None' so a "previous" behavior can be installed
 * before the intake wraps (exactly as a host behavior installed before attach), whether or not attach
 * already installs the intake; the suite then switches to 'Interim' and calls install() itself.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libBehaviorInjection = require('meadow-endpoints/source/controller/components/Meadow-Endpoints-Controller-BehaviorInjection.js');

const libBuilders = require('./support/Facet-Test-Builders.js');
const libHarness = require('./support/Facet-Test-Harness.js');
const libProviders = require('./support/Facet-Harness-Providers.js');
const libChangeIntake = require('../source/change/Retold-Faceting-ChangeIntake.js');
const libChangeIntakeInterim = require('../source/change/Change-Intake-Interim.js');
const libChangeIntakeBus = require('../source/change/Change-Intake-Bus.js');
const libHostBase = require('../source/host/Retold-Faceting-Host-Base.js');
const libOptions = require('../source/Retold-Faceting-Service-Options.js');
const libUtil = require('../source/Retold-Faceting-Util.js');

const PORT = 19133;
const POSTGRES = libProviders.available('PostgreSQL');
const SLOTS = [ 'Create-PostOperation', 'Update-PostOperation', 'Delete-PostOperation', 'Undelete-PostOperation' ];

// ---------------------------------------------------------------- a tiny host (no server)

/**
 * @param {Array<string>} pNames
 * @return {Array<{ Column: string }>}
 */
const columns = (pNames) =>
{
	return pNames.map((pName) => { return { Column: pName }; });
};

const UNIT_MODEL = (
	{
		Tables:
			{
				Project: { Columns: columns([ 'IDProject', 'IDCustomer', 'Name', 'Status', 'StartDate', 'UpdateDate', 'UpdatingIDUser', 'Deleted' ]) },
				LabForm: { Columns: columns([ 'IDLabForm', 'IDCustomer', 'OwnerIDUser', 'Status', 'UpdateDate', 'UpdatingIDUser', 'Deleted' ]) },
				FormType: { Columns: columns([ 'IDFormType', 'Name' ]) },
				Note: { Columns: columns([ 'IDNote', 'OwnerIDUser', 'Body' ]) }
			}
	});

const UNIT_SCOPE = (
	{
		Policy:
			{
				Column: 'IDCustomer',
				SessionField: 'CustomerID',
				Exclude: [ 'FormType' ],
				PersonalScopes: { LabForm: { Column: 'OwnerIDUser', SessionField: 'UserID' }, Note: { Column: 'OwnerIDUser', SessionField: 'UserID' } }
			},
		Guard: 'Strict'
	});

class TinyHost extends libHostBase
{
	constructor(pFable, pOptions, pModel)
	{
		super(pFable, pOptions);
		this._Model = pModel;
		this._Policy = null;
		this.Controllers = {};
	}

	getModelSync()
	{
		return this._Model;
	}

	getScopePolicy()
	{
		if (!this._Policy)
		{
			this._Policy = this.buildScopePolicy(this.options.Scope, (pEntity, pColumn) => { return this.entityHasColumn(pEntity, pColumn); });
		}
		return this._Policy;
	}

	getDeleteColumn(pEntity)
	{
		return this.entityHasColumn(pEntity, 'Deleted') ? 'Deleted' : null;
	}

	getPrimaryKey(pEntity)
	{
		return `ID${pEntity}`;
	}

	getDAL(pEntity)
	{
		return this.getEntityModel(pEntity) ? { scope: pEntity } : null;
	}

	getRouteBoundController(pEntity)
	{
		return Object.prototype.hasOwnProperty.call(this.Controllers, pEntity) ? this.Controllers[pEntity] : null;
	}
}

/**
 * A ChangeIntake over the tiny host, with a recording subscriber and a warn-log spy.
 *
 * @param {Record<string, any>} [pOptions] - RetoldFaceting options merged over the unit defaults
 * @param {{ NoHost?: boolean }} [pFlags]
 * @return {{ fable: any, host: any, intake: any, events: Array<any>, warnings: Array<string> }}
 */
const newUnit = (pOptions, pFlags) =>
{
	let tmpFlags = pFlags || {};
	let tmpFable = libBuilders.newFable('RetoldFacetingChangeIntakeTest');
	let tmpOptions = libOptions.resolve(libOptions.deepMerge({ Scope: UNIT_SCOPE, ChangeCapture: { NotifySettleMS: 0 } }, pOptions || {}));
	let tmpUnit = { fable: tmpFable, host: null, intake: null, events: [], warnings: [] };
	if (!tmpFlags.NoHost)
	{
		tmpUnit.host = new TinyHost(tmpFable, tmpOptions, UNIT_MODEL);
		tmpFable.RetoldFacetingService = { Host: tmpUnit.host };
		tmpFable.RetoldFacetingCatalog = { entities: () => { return Object.keys(UNIT_MODEL.Tables); } };
	}
	tmpFable.log.warn = (pMessage) => { tmpUnit.warnings.push(String(pMessage)); };
	tmpUnit.intake = new libChangeIntake(tmpFable, tmpOptions);
	tmpUnit.intake.subscribe('Test', (pEvent) => { tmpUnit.events.push(pEvent); });
	return tmpUnit;
};

/**
 * A stand-alone controller with meadow-endpoints' own BehaviorInjection (runBehavior semantics).
 *
 * @param {string} pName
 * @return {any}
 */
const newController = (pName) =>
{
	let tmpController = { Name: pName };
	tmpController.BehaviorInjection = new libBehaviorInjection(tmpController);
	return tmpController;
};

/**
 * Run a slot the way meadow-endpoints does (runBehavior, controller as this).
 *
 * @param {any} pController
 * @param {string} pSlot
 * @param {Record<string, any>} pRequestState
 * @param {(pError?: any) => void} fCallback
 */
const runSlot = (pController, pSlot, pRequestState, fCallback) =>
{
	return pController.BehaviorInjection.runBehavior(pSlot, pController, { UserSession: null }, pRequestState, fCallback);
};

/**
 * The event without its per-delivery stamps (for deep equality).
 *
 * @param {Record<string, any>} pEvent
 * @return {Record<string, any>}
 */
const facts = (pEvent) =>
{
	let tmpFacts = JSON.parse(JSON.stringify(pEvent));
	delete tmpFacts.ChangeID;
	delete tmpFacts.Timestamp;
	delete tmpFacts.Epoch;
	delete tmpFacts.Seq;
	return tmpFacts;
};

/**
 * A meadow-endpoints error body without its debug Stack (whose frames name every function on the
 * path, a wrapper included); the first line of the stack is kept.
 *
 * @param {Record<string, any>} pBody
 * @return {Record<string, any>}
 */
const withoutStack = (pBody) =>
{
	let tmpBody = Object.assign({}, pBody);
	if (typeof(tmpBody.Stack) === 'string')
	{
		tmpBody.Stack = tmpBody.Stack.split('\n')[0];
	}
	return tmpBody;
};

/**
 * Wait until pCondition() holds (polling), then call fDone; fail after pTimeoutMS.
 *
 * @param {() => boolean} pCondition
 * @param {number} pTimeoutMS
 * @param {(pError?: Error) => void} fDone
 */
const waitFor = (pCondition, pTimeoutMS, fDone) =>
{
	let tmpStart = Date.now();
	let fPoll = () =>
	{
		if (pCondition())
		{
			return fDone();
		}
		if ((Date.now() - tmpStart) > pTimeoutMS)
		{
			return fDone(new Error(`condition not met within ${pTimeoutMS} ms`));
		}
		setTimeout(fPoll, 5);
	};
	fPoll();
};

suite
(
	'Facet-ChangeIntake',
	() =>
	{
		// ================================================================ Seq clock, ingest, delivery
		suite
		(
			'Seq clock, ingest and delivery (internal-contracts §39)',
			() =>
			{
				test('a fresh epoch starts at 0; ingest assigns one Seq per event, synchronously and in order',
					() =>
					{
						let U = newUnit({}, { NoHost: true });
						let tmpIntake = U.intake;
						Expect(tmpIntake.NodeEpoch).to.match(libUtil.NODE_EPOCH_PATTERN);
						Expect(tmpIntake.currentSeq()).to.equal(`${tmpIntake.NodeEpoch}:0`);
						Expect(new libChangeIntake(libBuilders.newFable()).NodeEpoch).to.not.equal(tmpIntake.NodeEpoch);
						let tmpSeqs = [];
						for (let i = 0; i < 12; i++)
						{
							let tmpEvent = tmpIntake.ingest({ Entity: 'Project', Operation: 'Create', IDs: [ i + 1 ] });
							Expect(tmpEvent.Seq).to.match(libUtil.SEQ_PATTERN);
							Expect(tmpEvent.Epoch).to.equal(tmpIntake.NodeEpoch);
							Expect(tmpIntake.currentSeq()).to.equal(tmpEvent.Seq);
							tmpSeqs.push(libUtil.parseSeq(tmpEvent.Seq).N);
						}
						Expect(tmpSeqs).to.deep.equal([ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 ]);
						Expect(U.events.map((pEvent) => { return pEvent.ChangeID; }).slice(0, 2)).to.deep.equal([ 'ch:000001', 'ch:000002' ]);
						Expect(tmpIntake.stats()).to.include({ Events: 12, Invalid: 0, LastSeq: `${tmpIntake.NodeEpoch}:12` });
						Expect(tmpIntake.stats().ByOperation).to.deep.equal({ Create: 12 });
						Expect(tmpIntake.stats().BySource).to.deep.equal({ Notify: 12 });
					});

				test('invalid raw changes are refused (null, logged, counted), never throw and take no Seq',
					() =>
					{
						let U = newUnit({}, { NoHost: true });
						let tmpThrowing = {};
						Object.defineProperty(tmpThrowing, 'Entity', { enumerable: true, get: () => { throw new Error('getter boom'); } });
						let tmpBad =
							[
								null, undefined, 7, 'Project', [ { Entity: 'Project' } ],
								{}, { Entity: '' }, { Entity: 42, Operation: 'Create' },
								{ Entity: 'Project' }, { Entity: 'Project', Operation: 'Upsert' },
								{ Entity: 'Project', Operation: 'Create', Source: 'DAL' },
								{ Entity: 'Project', Operation: 'Create', IDs: '1' },
								{ Entity: 'Project', Operation: 'Create', Tenants: 7 },
								{ Entity: 'Project', Operation: 'Create', Owners: {} },
								{ Entity: 'Project', Operation: 'Create', Owners: [ 7 ] },
								{ Entity: 'Project', Operation: 'Update', ChangedColumns: 'Status' },
								{ Entity: 'Project', Operation: 'Update', ChangedColumns: [ 'Status', 7 ] },
								tmpThrowing
							];
						tmpBad.forEach(
							(pRaw, pIndex) =>
							{
								Expect(U.intake.ingest(pRaw), `raw #${pIndex}`).to.equal(null);
							});
						Expect(U.events.length).to.equal(0);
						Expect(U.intake.stats().Invalid).to.equal(tmpBad.length);
						Expect(U.intake.currentSeq()).to.equal(`${U.intake.NodeEpoch}:0`);
						Expect(U.warnings.length).to.equal(tmpBad.length);
					});

				test('normalization without a host (Unscoped): Tenants [*], Owners null, ids normalized, columns sorted, Filter only on EntityDirty',
					() =>
					{
						let U = newUnit({}, { NoHost: true });
						let tmpEvent = U.intake.ingest(
							{
								Source: 'Interim', Entity: 'Project', Operation: 'Update',
								IDs: [ '12', 12, ' 13 ', null, '', 'g-1' ],
								Tenants: [ 7 ], Owners: [ { Tenant: 7, Owner: 42 } ],
								ChangedColumns: [ 'Status', 'Name', 'Status' ],
								KeyImages: { '12': { B: { IDCustomer: '7' }, A: { IDCustomer: 7 }, Via: { IDCustomer: [ 7 ] } }, '13': 'nope' },
								Filter: 'FBV~Status~EQ~Active',
								Actor: { PrincipalKey: 'pk:0123456789abcdef', UserID: '42', Verb: 'Update' }
							});
						Expect(facts(tmpEvent)).to.deep.equal(
							{
								Source: 'Interim', Entity: 'Project', Operation: 'Update',
								IDs: [ 12, 13, 'g-1' ],
								Tenants: [ '*' ], Owners: null,
								ChangedColumns: [ 'Name', 'Status' ],
								KeyImages: { '12': { B: { IDCustomer: 7 }, A: { IDCustomer: 7 } } },
								Filter: null,
								Actor: { PrincipalKey: 'pk:0123456789abcdef', UserID: 42, Verb: 'Update' }
							});
						Expect(tmpEvent.ChangeID).to.match(/^ch:[0-9]{6}$/);
						Expect(tmpEvent.Timestamp).to.be.a('number');
						// Defaults: no Actor, a Create's ChangedColumns are null whatever was sent, a bad PrincipalKey is dropped.
						let tmpCreate = U.intake.ingest({ Entity: 'Project', Operation: 'Create', ChangedColumns: [ 'X' ], Actor: { PrincipalKey: 'session-123' } });
						Expect(tmpCreate.ChangedColumns).to.equal(null);
						Expect(tmpCreate.Actor).to.deep.equal({ PrincipalKey: null, UserID: 0, Verb: 'Notify' });
						Expect(tmpCreate.IDs).to.deep.equal([]);
						Expect(tmpCreate.KeyImages).to.deep.equal({});
						// EntityDirty carries its filter (string or a private copy of an array).
						let tmpFilter = [ { Column: 'IDSource', Operator: '=', Value: 12 } ];
						let tmpDirty = U.intake.ingest({ Entity: 'Project', Operation: 'EntityDirty', Filter: tmpFilter });
						tmpFilter[0].Value = 13;
						Expect(tmpDirty.Filter).to.deep.equal([ { Column: 'IDSource', Operator: '=', Value: 12 } ]);
						Expect(Object.isFrozen(tmpFilter)).to.equal(false);
					});

				test('the event is frozen to the leaves; the caller\'s own objects are never frozen or shared',
					() =>
					{
						'use strict';
						let U = newUnit();
						let tmpIDs = [ 5 ];
						let tmpRaw = { Entity: 'LabForm', Operation: 'Update', IDs: tmpIDs, Tenants: [ 1 ], Owners: [ { Tenant: 1, Owner: 9 } ], ChangedColumns: [ 'Status' ], KeyImages: { '5': { B: { IDCustomer: 1, OwnerIDUser: 9 } } }, Actor: { UserID: 9 } };
						let tmpEvent = U.intake.ingest(tmpRaw);
						[ tmpEvent, tmpEvent.IDs, tmpEvent.Tenants, tmpEvent.Owners, tmpEvent.Owners[0], tmpEvent.ChangedColumns, tmpEvent.KeyImages, tmpEvent.KeyImages['5'], tmpEvent.KeyImages['5'].B, tmpEvent.Actor ].forEach(
							(pPart) =>
							{
								Expect(Object.isFrozen(pPart)).to.equal(true);
							});
						Expect(() => { tmpEvent.IDs.push(6); }).to.throw();
						Expect(() => { tmpEvent.Entity = 'Other'; }).to.throw();
						Expect(Object.isFrozen(tmpIDs)).to.equal(false);
						Expect(Object.isFrozen(tmpRaw.Owners[0])).to.equal(false);
						Expect(tmpEvent.IDs).to.not.equal(tmpIDs);
					});

				test('subscribers run synchronously in subscription order; same name replaces in place; unsubscribe; a throwing subscriber is isolated and counted',
					() =>
					{
						let U = newUnit();
						let tmpOrder = [];
						U.intake.subscribe('A', () => { tmpOrder.push('A1'); });
						U.intake.subscribe('Thrower', () => { tmpOrder.push('T'); throw new Error('subscriber boom'); });
						U.intake.subscribe('B', () => { tmpOrder.push('B'); });
						U.intake.subscribe('A', () => { tmpOrder.push('A2'); });
						U.intake.subscribe('NotAFunction', 7);
						let tmpEvent = U.intake.ingest({ Entity: 'Project', Operation: 'Create', IDs: [ 1 ], Tenants: [ 1 ] });
						Expect(tmpEvent).to.be.an('object');
						Expect(tmpOrder).to.deep.equal([ 'A2', 'T', 'B' ]);
						Expect(U.events.length).to.equal(1);
						Expect(U.intake.stats().SubscriberErrors).to.equal(1);
						Expect(U.warnings.some((pMessage) => { return pMessage.indexOf('"Thrower"') >= 0; })).to.equal(true);

						// A subscriber that unsubscribes another during delivery does not disturb this round.
						U.intake.unsubscribe('Thrower');
						U.intake.subscribe('Remover', () => { tmpOrder.push('R'); U.intake.unsubscribe('B'); });
						U.intake.subscribe('C', () => { tmpOrder.push('C'); });
						tmpOrder = [];
						U.intake.ingest({ Entity: 'Project', Operation: 'Create' });
						Expect(tmpOrder).to.deep.equal([ 'A2', 'B', 'R', 'C' ]);
						tmpOrder = [];
						U.intake.ingest({ Entity: 'Project', Operation: 'Create' });
						Expect(tmpOrder).to.deep.equal([ 'A2', 'R', 'C' ]);
						Expect(U.intake.stats().SubscriberErrors).to.equal(1);
					});
			}
		);

		// ================================================================ derivation and notify
		suite
		(
			'changeFromRows, notify and notifyByFilter over a tiny host (internal-contracts §40.3, §40.5)',
			() =>
			{
				test('Create / Delete / Undelete on a Tenant entity: ids, tenants, KeyImages sides, no ChangedColumns',
					() =>
					{
						let U = newUnit();
						let tmpRow = { IDProject: 7, IDCustomer: 1, Name: 'P', Status: 'Active', Decoration: { X: 1 } };
						Expect(U.intake.changeFromRows('Project', 'Create', null, tmpRow, { Source: 'Interim' })).to.deep.include(
							{ Source: 'Interim', Entity: 'Project', Operation: 'Create', IDs: [ 7 ], Tenants: [ 1 ], Owners: null, ChangedColumns: null, KeyImages: { '7': { A: { IDCustomer: 1 } } }, Filter: null });
						Expect(U.intake.changeFromRows('Project', 'Delete', tmpRow, null, { Source: 'Interim', FallbackIDs: [ '99' ] })).to.deep.include(
							{ IDs: [ 7 ], Tenants: [ 1 ], ChangedColumns: null, KeyImages: { '7': { B: { IDCustomer: 1 } } } });
						// The IDRecord fallback is used only when no row names the id.
						Expect(U.intake.changeFromRows('Project', 'Delete', { IDCustomer: 2 }, null, { Source: 'Interim', FallbackIDs: [ '99' ] })).to.deep.include(
							{ IDs: [ 99 ], Tenants: [ 2 ], KeyImages: { '99': { B: { IDCustomer: 2 } } } });
						Expect(U.intake.changeFromRows('Project', 'Undelete', tmpRow, null, { Source: 'Interim' })).to.deep.include(
							{ Operation: 'Undelete', IDs: [ 7 ], Tenants: [ 1 ], KeyImages: { '7': { B: { IDCustomer: 1 } } } });
					});

				test('Update: the model-column diff (decorations ignored, Dates by instant) ∪ the audit columns; a no-op update is still an event',
					() =>
					{
						let U = newUnit();
						let tmpBefore = { IDProject: 7, IDCustomer: 1, Name: 'P', Status: 'Active', StartDate: new Date('2026-01-01T00:00:00Z'), UpdateDate: '2026-10-01 10:00:00', UpdatingIDUser: 3, Decoration: 1 };
						let tmpAfter = { IDProject: 7, IDCustomer: 1, Name: 'P', Status: 'Done', StartDate: new Date('2026-01-01T00:00:00Z'), UpdateDate: '2026-10-09 10:00:00', UpdatingIDUser: 3, Decoration: 2 };
						let tmpRaw = U.intake.changeFromRows('Project', 'Update', tmpBefore, tmpAfter, { Source: 'Interim', Submitted: { IDProject: 7, Status: 'Done' } });
						Expect(tmpRaw).to.deep.include({ IDs: [ 7 ], Tenants: [ 1 ], ChangedColumns: [ 'Status', 'UpdateDate', 'UpdatingIDUser' ], KeyImages: { '7': { B: { IDCustomer: 1 }, A: { IDCustomer: 1 } } } });
						// Nothing but the audit columns: still emitted (meadow stamps UpdateDate; an UpdateDate facet must see it).
						let tmpNoOp = U.intake.changeFromRows('Project', 'Update', tmpBefore, Object.assign({}, tmpBefore), { Source: 'Interim' });
						Expect(tmpNoOp.ChangedColumns).to.deep.equal([ 'UpdateDate', 'UpdatingIDUser' ]);
						Expect(U.intake.ingest(tmpNoOp)).to.be.an('object');
						// An entity without the audit columns does not get them; a column present on one side only changed.
						Expect(U.intake.changeFromRows('FormType', 'Update', { IDFormType: 4, Name: 'A' }, { IDFormType: 4, Name: 'A', Extra: 1 }, {}).ChangedColumns).to.deep.equal([]);
						Expect(U.intake.changeFromRows('Project', 'Update', { IDProject: 7 }, { IDProject: 7, Name: 'N' }, {}).ChangedColumns).to.deep.equal([ 'Name', 'UpdateDate', 'UpdatingIDUser' ]);
						// Binary values compare by their bytes.
						Expect(U.intake.changeFromRows('Project', 'Update', { IDProject: 7, Name: Buffer.from('ab') }, { IDProject: 7, Name: Buffer.from('ab') }, {}).ChangedColumns).to.deep.equal([ 'UpdateDate', 'UpdatingIDUser' ]);
						Expect(U.intake.changeFromRows('Project', 'Update', { IDProject: 7, Name: Buffer.from('ab') }, { IDProject: 7, Name: Buffer.from('ac') }, {}).ChangedColumns).to.deep.equal([ 'Name', 'UpdateDate', 'UpdatingIDUser' ]);
					});

				test('Update move: both tenants, both images; no pre-image: the submitted columns (not the identity), and \'*\' when the tenant column was submitted',
					() =>
					{
						let U = newUnit();
						Expect(U.intake.changeFromRows('Project', 'Update', { IDProject: 7, IDCustomer: 1 }, { IDProject: 7, IDCustomer: 2 }, {})).to.deep.include(
							{ IDs: [ 7 ], Tenants: [ 1, 2 ], ChangedColumns: [ 'IDCustomer', 'UpdateDate', 'UpdatingIDUser' ], KeyImages: { '7': { B: { IDCustomer: 1 }, A: { IDCustomer: 2 } } } });
						Expect(U.intake.changeFromRows('Project', 'Update', null, { IDProject: 7, IDCustomer: 1, Status: 'Done' }, { Submitted: { IDProject: 7, Status: 'Done', Decoration: 1 } })).to.deep.include(
							{ IDs: [ 7 ], Tenants: [ 1 ], ChangedColumns: [ 'Status', 'UpdateDate', 'UpdatingIDUser' ], KeyImages: { '7': { A: { IDCustomer: 1 } } } });
						Expect(U.intake.changeFromRows('Project', 'Update', null, { IDProject: 7, IDCustomer: 2 }, { Submitted: { IDProject: 7, IDCustomer: 2 } })).to.deep.include(
							{ Tenants: [ 2, '*' ], ChangedColumns: [ 'IDCustomer', 'UpdateDate', 'UpdatingIDUser' ] });
						// No image at all, only the submitted record: the id and the columns from it, the tenant unknown.
						Expect(U.intake.changeFromRows('Project', 'Update', null, null, { Submitted: { IDProject: '8', Status: 'X' } })).to.deep.include(
							{ IDs: [ 8 ], Tenants: [ '*' ], ChangedColumns: [ 'Status', 'UpdateDate', 'UpdatingIDUser' ], KeyImages: {} });
						// Nothing at all: unknown everything.
						Expect(U.intake.changeFromRows('Project', 'Update', null, null, {})).to.deep.include({ IDs: [], Tenants: [ '*' ], ChangedColumns: null });
					});

				test('unset tenant values (0, \'\', null, missing, Scope.UnsetValues) are unknown: \'*\'',
					() =>
					{
						let U = newUnit({ Scope: { UnsetValues: [ 0, '', null, -1 ] } });
						[ 0, '', null, '0', ' ', -1, '-1' ].forEach(
							(pValue) =>
							{
								Expect(U.intake.changeFromRows('Project', 'Create', null, { IDProject: 1, IDCustomer: pValue }, {}).Tenants, String(pValue)).to.deep.equal([ '*' ]);
							});
						Expect(U.intake.changeFromRows('Project', 'Create', null, { IDProject: 1 }, {}).Tenants).to.deep.equal([ '*' ]);
						Expect(U.intake.changeFromRows('Project', 'Create', null, { IDProject: 1, IDCustomer: ' 7' }, {}).Tenants).to.deep.equal([ 7 ]);
					});

				test('Personal entities: one owner pair per distinct (tenant, owner); an owner move; an unknown owner; no tenant column → \'#none\'',
					() =>
					{
						let U = newUnit();
						Expect(U.intake.changeFromRows('LabForm', 'Update', { IDLabForm: 3, IDCustomer: 1, OwnerIDUser: 42, Status: 'Pending' }, { IDLabForm: 3, IDCustomer: 1, OwnerIDUser: 42, Status: 'Complete' }, {})).to.deep.include(
							{ Tenants: [ 1 ], Owners: [ { Tenant: 1, Owner: 42 } ], ChangedColumns: [ 'Status', 'UpdateDate', 'UpdatingIDUser' ], KeyImages: { '3': { B: { IDCustomer: 1, OwnerIDUser: 42 }, A: { IDCustomer: 1, OwnerIDUser: 42 } } } });
						Expect(U.intake.changeFromRows('LabForm', 'Update', { IDLabForm: 3, IDCustomer: 1, OwnerIDUser: 42 }, { IDLabForm: 3, IDCustomer: 1, OwnerIDUser: 43 }, {})).to.deep.include(
							{ Tenants: [ 1 ], Owners: [ { Tenant: 1, Owner: 42 }, { Tenant: 1, Owner: 43 } ], ChangedColumns: [ 'OwnerIDUser', 'UpdateDate', 'UpdatingIDUser' ] });
						// No pre-image and the owner column submitted: the old owner is unknown.
						Expect(U.intake.changeFromRows('LabForm', 'Update', null, { IDLabForm: 3, IDCustomer: 1, OwnerIDUser: 43 }, { Submitted: { IDLabForm: 3, OwnerIDUser: 43 } })).to.deep.include(
							{ Tenants: [ 1 ], Owners: [ { Tenant: 1, Owner: 43 }, { Tenant: 1, Owner: '*' } ] });
						// An unset owner value is unknown.
						Expect(U.intake.changeFromRows('LabForm', 'Create', null, { IDLabForm: 4, IDCustomer: 1, OwnerIDUser: 0 }, {}).Owners).to.deep.equal([ { Tenant: 1, Owner: '*' } ]);
						// Personal without a tenant column.
						Expect(U.intake.changeFromRows('Note', 'Create', null, { IDNote: 1, OwnerIDUser: 42 }, {})).to.deep.include(
							{ Tenants: [ '*' ], Owners: [ { Tenant: '#none', Owner: 42 } ], KeyImages: { '1': { A: { OwnerIDUser: 42 } } } });
						let tmpEvent = U.intake.ingest(U.intake.changeFromRows('Note', 'Create', null, { IDNote: 1, OwnerIDUser: 42 }, {}));
						Expect(tmpEvent.Owners).to.deep.equal([ { Tenant: '#none', Owner: 42 } ]);
					});

				test('Global and Unscoped entities: Tenants [*], no owners, no KeyImages',
					() =>
					{
						let U = newUnit();
						Expect(U.intake.scopeColumns('FormType').Kind).to.equal('Global');
						Expect(U.intake.changeFromRows('FormType', 'Update', { IDFormType: 4, Name: 'A' }, { IDFormType: 4, Name: 'B' }, { Tenants: [ 7 ] })).to.deep.include(
							{ IDs: [ 4 ], Tenants: [ '*' ], Owners: null, ChangedColumns: [ 'Name' ], KeyImages: {} });
						let tmpEvent = U.intake.ingest({ Entity: 'FormType', Operation: 'Update', Tenants: [ 7 ], Owners: [ { Tenant: 7, Owner: 1 } ] });
						Expect(tmpEvent.Tenants).to.deep.equal([ '*' ]);
						Expect(tmpEvent.Owners).to.equal(null);
						let N = newUnit({ Scope: { Policy: false } });
						Expect(N.intake.scopeColumns('Project').Kind).to.equal('Unscoped');
						Expect(N.intake.changeFromRows('Project', 'Create', null, { IDProject: 1, IDCustomer: 1 }, {})).to.deep.include({ Tenants: [ '*' ], Owners: null, KeyImages: {} });
					});

				test('notify: shapes (Records, Before, explicit ids / tenants / owners / columns, principal), Seq returned',
					() =>
					{
						let U = newUnit();
						let tmpSeq = U.intake.notify('Project', { IDs: [ 1, 2 ], Tenants: [ 7 ], ChangedColumns: [ 'Status' ] });
						Expect(tmpSeq).to.match(libUtil.SEQ_PATTERN);
						Expect(U.events.length).to.equal(1);
						Expect(U.events[0].Seq).to.equal(tmpSeq);
						Expect(facts(U.events[0])).to.deep.equal(
							{ Source: 'Notify', Entity: 'Project', Operation: 'Update', IDs: [ 1, 2 ], Tenants: [ 7 ], Owners: null, ChangedColumns: [ 'Status' ], KeyImages: {}, Filter: null, Actor: { PrincipalKey: null, UserID: 0, Verb: 'Notify' } });
						// Defaults: Update, every tenant, unknown columns.
						U.intake.notify('Project');
						Expect(U.events[1]).to.deep.include({ Operation: 'Update', Tenants: [ '*' ], ChangedColumns: null, IDs: [] });
						// Records (+ Before): ids, tenants (both on a move) and KeyImages from the rows; columns stay unknown
						// unless stated, so a record without its pre-image also adds the unknown old tenant.
						U.intake.notify('Project', { Records: [ { IDProject: 5, IDCustomer: 2 }, { IDProject: 6, IDCustomer: 1 } ], Before: [ { IDProject: 5, IDCustomer: 1 } ] });
						Expect(facts(U.events[2])).to.deep.include(
							{ IDs: [ 5, 6 ], Tenants: [ 1, 2, '*' ], ChangedColumns: null, KeyImages: { '5': { B: { IDCustomer: 1 }, A: { IDCustomer: 2 } }, '6': { A: { IDCustomer: 1 } } } });
						U.intake.notify('Project', { Records: [ { IDProject: 5, IDCustomer: 2 } ], Before: [ { IDProject: 5, IDCustomer: 1 } ], ChangedColumns: [ 'IDCustomer' ] });
						Expect(facts(U.events[3])).to.deep.include({ Tenants: [ 1, 2 ], ChangedColumns: [ 'IDCustomer' ] });
						U.events.splice(3, 1);
						// Records without Before and with unknown columns: the old tenant is unknown too.
						U.intake.notify('Project', { Records: [ { IDProject: 6, IDCustomer: 1 } ] });
						Expect(U.events[3].Tenants).to.deep.equal([ 1, '*' ]);
						U.intake.notify('Project', { Operation: 'Delete', Records: [], Before: [ { IDProject: 6, IDCustomer: 1 } ] });
						Expect(U.events[4]).to.deep.include({ Operation: 'Delete', ChangedColumns: null });
						Expect(facts(U.events[4]).Tenants).to.deep.equal([ 1 ]);
						// Owners on a Personal entity; a principal (read-your-writes) by object or by key.
						let tmpPrincipal = U.host.buildPrincipal({ LoggedIn: true, UserID: 42, CustomerID: 1 }, null);
						U.intake.notify('LabForm', { IDs: [ 3 ], Tenants: [ 1 ], Owners: [ { Tenant: 1, Owner: 42 } ], ChangedColumns: [ 'Status' ], Principal: tmpPrincipal });
						Expect(facts(U.events[5])).to.deep.include({ Owners: [ { Tenant: 1, Owner: 42 } ], Actor: { PrincipalKey: libUtil.principalKey(tmpPrincipal), UserID: 42, Verb: 'Notify' } });
						U.intake.notify('LabForm', { Operation: 'Touch', Tenants: [ 1 ], PrincipalKey: 'pk:00000000000000aa' });
						Expect(U.events[6]).to.deep.include({ Operation: 'Touch', Owners: null });
						Expect(U.events[6].Actor.PrincipalKey).to.equal('pk:00000000000000aa');
						Expect(U.intake.notifyChanged('Project', { IDs: [ 1 ] })).to.match(libUtil.SEQ_PATTERN);
						Expect(U.intake.stats().BySource.Notify).to.equal(9);
					});

				test('notify / notifyByFilter validation: null + a warn naming only the entity and the reason, never throws, never a value',
					() =>
					{
						let U = newUnit();
						let tmpThrowing = {};
						Object.defineProperty(tmpThrowing, 'Operation', { enumerable: true, get: () => { throw new Error('getter boom'); } });
						let tmpCases =
							[
								[ 'NoSuchEntity', { IDs: [ 1 ] } ],
								[ 42, {} ],
								[ 'Project', 'SECRET-7' ],
								[ 'Project', [ 'SECRET-7' ] ],
								[ 'Project', { Operation: 'Upsert' } ],
								[ 'Project', { IDs: 'SECRET-7' } ],
								[ 'Project', { Records: { IDProject: 1 } } ],
								[ 'Project', { Before: 'SECRET-7' } ],
								[ 'Project', { Tenants: 'SECRET-7' } ],
								[ 'Project', { Owners: [ 'SECRET-7' ] } ],
								[ 'Project', { ChangedColumns: 'SECRET-7' } ],
								[ 'Project', { ChangedColumns: [ '' ] } ],
								[ 'Project', { PrincipalKey: 'SECRET-7' } ],
								[ 'Project', { Principal: 'SECRET-7' } ],
								[ 'Project', tmpThrowing ]
							];
						tmpCases.forEach(
							(pCase, pIndex) =>
							{
								let tmpResult;
								Expect(() => { tmpResult = U.intake.notify(pCase[0], pCase[1]); }, `notify #${pIndex}`).to.not.throw();
								Expect(tmpResult, `notify #${pIndex}`).to.equal(null);
							});
						let tmpFilterCases =
							[
								[ 'NoSuchEntity', 'FBV~X~EQ~1', {} ],
								[ 'Project', '', {} ],
								[ 'Project', 7, {} ],
								[ 'Project', { Column: 'X' }, {} ],
								[ 'Project', 'FBV~X~EQ~1', 'SECRET-7' ],
								[ 'Project', 'FBV~X~EQ~1', { Tenants: 'SECRET-7' } ],
								[ 'Project', 'FBV~X~EQ~1', { Owners: [ 7 ] } ],
								[ 'Project', 'FBV~X~EQ~1', { PrincipalKey: 'SECRET-7' } ]
							];
						tmpFilterCases.forEach(
							(pCase, pIndex) =>
							{
								let tmpResult;
								Expect(() => { tmpResult = U.intake.notifyByFilter(pCase[0], pCase[1], pCase[2]); }, `notifyByFilter #${pIndex}`).to.not.throw();
								Expect(tmpResult, `notifyByFilter #${pIndex}`).to.equal(null);
							});
						Expect(U.events.length).to.equal(0);
						Expect(U.intake.stats().Invalid).to.equal(tmpCases.length + tmpFilterCases.length);
						Expect(U.warnings.length).to.equal(tmpCases.length + tmpFilterCases.length);
						U.warnings.forEach((pMessage) => { Expect(pMessage).to.not.contain('SECRET-7'); });
						// Without a host nothing is known: refused.
						let N = newUnit({}, { NoHost: true });
						Expect(N.intake.notify('Project', {})).to.equal(null);
					});

				test('notifyByFilter: an EntityDirty event carrying the pre-write predicate (never parsed), tenants from the options else every tenant',
					() =>
					{
						let U = newUnit();
						let tmpSeq = U.intake.notifyByFilter('Project', 'FBV~IDClient~EQ~12', { Tenants: [ 7 ], PrincipalKey: 'pk:00000000000000bb' });
						Expect(tmpSeq).to.match(libUtil.SEQ_PATTERN);
						Expect(facts(U.events[0])).to.deep.equal(
							{ Source: 'Notify', Entity: 'Project', Operation: 'EntityDirty', IDs: [], Tenants: [ 7 ], Owners: null, ChangedColumns: null, KeyImages: {}, Filter: 'FBV~IDClient~EQ~12', Actor: { PrincipalKey: 'pk:00000000000000bb', UserID: 0, Verb: 'Notify' } });
						let tmpFilter = [ { Column: 'IDClient', Operator: '=', Value: 12, Connector: 'AND' } ];
						U.intake.notifyByFilter('LabForm', tmpFilter);
						tmpFilter.push({ Column: 'Injected' });
						Expect(U.events[1]).to.deep.include({ Operation: 'EntityDirty', Owners: null });
						Expect(facts(U.events[1]).Tenants).to.deep.equal([ '*' ]);
						Expect(facts(U.events[1]).Filter).to.deep.equal([ { Column: 'IDClient', Operator: '=', Value: 12, Connector: 'AND' } ]);
						Expect(Object.isFrozen(U.events[1].Filter[0])).to.equal(true);
						Expect(U.intake.notifyByFilter('LabForm', [], { Owners: [ { Tenant: 1, Owner: 42 } ] })).to.match(libUtil.SEQ_PATTERN);
						Expect(facts(U.events[2]).Owners).to.deep.equal([ { Tenant: 1, Owner: 42 } ]);
					});

				test('settle (05 §5): every Notify event is delivered once more after NotifySettleMS (new Seq, same facts); 0 disables; shutdown clears; interim events never settle',
					(fDone) =>
					{
						let U = newUnit({ ChangeCapture: { NotifySettleMS: 15 } });
						let tmpSeq = U.intake.notify('Project', { IDs: [ 1 ], Tenants: [ 7 ], ChangedColumns: [ 'Status' ] });
						U.intake.notifyByFilter('Project', 'FBV~Status~EQ~Active', { Tenants: [ 7 ] });
						U.intake.ingest({ Source: 'Interim', Entity: 'Project', Operation: 'Create', IDs: [ 9 ], Tenants: [ 7 ] });
						Expect(U.events.length).to.equal(3);
						waitFor(() => { return U.events.length >= 5; }, 2000,
							(pWaitError) =>
							{
								Expect(pWaitError).to.not.exist;
								let tmpSettled = U.events.slice(3);
								Expect(tmpSettled.map((pEvent) => { return pEvent.ChangeID; }).sort()).to.deep.equal([ `${U.events[0].ChangeID}~settle`, `${U.events[1].ChangeID}~settle` ].sort());
								let tmpFirst = tmpSettled.filter((pEvent) => { return pEvent.ChangeID === `${U.events[0].ChangeID}~settle`; })[0];
								Expect(facts(tmpFirst)).to.deep.equal(facts(U.events[0]));
								Expect(libUtil.parseSeq(tmpFirst.Seq).N).to.be.above(libUtil.parseSeq(tmpSeq).N);
								Expect(Object.isFrozen(tmpFirst)).to.equal(true);
								Expect(U.intake._SettleTimers.size).to.equal(0);

								// shutdown clears pending settles; later notifies arm none.
								U.intake.notify('Project', { IDs: [ 2 ] });
								Expect(U.intake._SettleTimers.size).to.equal(1);
								U.intake.shutdown();
								Expect(U.intake._SettleTimers.size).to.equal(0);
								U.intake.notify('Project', { IDs: [ 3 ] });
								Expect(U.intake._SettleTimers.size).to.equal(0);
								let tmpCount = U.events.length;
								let Z = newUnit({ ChangeCapture: { NotifySettleMS: 0 } });
								Z.intake.notify('Project', { IDs: [ 1 ] });
								Expect(Z.intake._SettleTimers.size).to.equal(0);
								setTimeout(
									() =>
									{
										Expect(U.events.length).to.equal(tmpCount);
										Expect(Z.events.length).to.equal(1);
										return fDone();
									}, 40);
							});
					});

				test('settles coalesce per (Entity, Operation) within one window: an importer notifying per row costs ONE re-delivery, with the union of ids, tenants and columns (unknown wins)',
					(fDone) =>
					{
						let U = newUnit({ ChangeCapture: { NotifySettleMS: 20 } });
						for (let i = 0; i < 50; i++)
						{
							U.intake.notify('Project', { IDs: [ i + 1 ], Tenants: [ (i % 2) ? 7 : 8 ], ChangedColumns: [ (i % 3) ? 'Status' : 'Name' ] });
						}
						U.intake.notify('LabForm', { IDs: [ 1 ], Tenants: [ 7 ], Owners: [ { Tenant: 7, Owner: 42 } ], ChangedColumns: null });
						Expect(U.intake._SettleTimers.size, 'one timer per (Entity, Operation)').to.equal(2);
						waitFor(() => { return U.events.length >= 53; }, 2000,
							(pWaitError) =>
							{
								Expect(pWaitError).to.not.exist;
								setTimeout(
									() =>
									{
										let tmpSettled = U.events.slice(51);
										Expect(tmpSettled.length).to.equal(2);
										let tmpProject = tmpSettled.find((pEvent) => { return pEvent.Entity === 'Project'; });
										Expect(tmpProject.ChangeID).to.equal(`${U.events[0].ChangeID}~settle`);
										Expect(tmpProject.IDs.length).to.equal(50);
										Expect(tmpProject.Tenants.slice().sort()).to.deep.equal([ 7, 8 ]);
										Expect(tmpProject.ChangedColumns).to.deep.equal([ 'Name', 'Status' ]);
										Expect(tmpProject.KeyImages).to.deep.equal({});
										let tmpLabForm = tmpSettled.find((pEvent) => { return pEvent.Entity === 'LabForm'; });
										Expect(tmpLabForm.ChangedColumns).to.equal(null);
										Expect(U.intake._SettleTimers.size).to.equal(0);
										return fDone();
									}, 40);
							});
					});

				test('notify stays linear on large batches (50 000 ids, records with 20 000 owners) and caps what an event carries (ids → unknown, owners → unknown)',
					function ()
					{
						this.timeout(20000);
						let U = newUnit();
						let tmpIDs = [];
						for (let i = 0; i < 50000; i++)
						{
							tmpIDs.push(i + 1);
						}
						let tmpStart = process.hrtime.bigint();
						Expect(U.intake.notify('Project', { IDs: tmpIDs, Tenants: [ 7 ], ChangedColumns: [ 'Status' ] })).to.match(libUtil.SEQ_PATTERN);
						let tmpIDsMS = Number(process.hrtime.bigint() - tmpStart) / 1e6;
						Expect(tmpIDsMS, `${tmpIDsMS.toFixed(1)} ms`).to.be.below(500);
						Expect(U.events[0].IDs, 'above MaxEventIDs: unknown').to.deep.equal([]);
						let tmpRecords = [];
						for (let i = 0; i < 20000; i++)
						{
							tmpRecords.push({ IDLabForm: i + 1, IDCustomer: 7, OwnerIDUser: 1000 + i });
						}
						tmpStart = process.hrtime.bigint();
						U.intake.notify('LabForm', { Operation: 'Create', Records: tmpRecords });
						let tmpRecordsMS = Number(process.hrtime.bigint() - tmpStart) / 1e6;
						Expect(tmpRecordsMS, `${tmpRecordsMS.toFixed(1)} ms`).to.be.below(1500);
						Expect(U.events[1].Owners, 'above MaxEventOwners: unknown owners (Part/* per tenant)').to.equal(null);
						Expect(U.events[1].Tenants).to.deep.equal([ 7 ]);
						Expect(U.intake.stats().Capped).to.be.at.least(2);
						// Under the caps nothing is dropped.
						U.intake.notify('Project', { IDs: [ 1, 2, 2, '3' ], Tenants: [ 7 ] });
						Expect(U.events[2].IDs).to.deep.equal([ 1, 2, 3 ]);
					});

				test('a notify of a tenant-scoped entity that names no tenant is counted (UnknownTenant) and warned about once a minute; RequireNotifyTenants refuses it',
					() =>
					{
						let U = newUnit();
						U.intake.notify('Project', { IDs: [ 1 ] });
						U.intake.notify('Project', { IDs: [ 2 ] });
						U.intake.notifyByFilter('Project', 'FBV~Status~EQ~Active');
						U.intake.notify('FormType', { IDs: [ 1 ] });
						U.intake.notify('Project', { IDs: [ 3 ], Tenants: [ 7 ] });
						Expect(U.intake.stats().UnknownTenant).to.equal(3);
						Expect(U.warnings.filter((pMessage) => { return pMessage.indexOf('named no tenant') >= 0; }).length).to.equal(1);
						let V = newUnit({ ChangeCapture: { RequireNotifyTenants: true } });
						Expect(V.intake.notify('Project', { IDs: [ 1 ] })).to.equal(null);
						Expect(V.intake.notifyByFilter('Project', 'FBV~Status~EQ~Active')).to.equal(null);
						Expect(V.intake.notify('Project', { Records: [ { IDProject: 1, IDCustomer: 7 } ] })).to.match(libUtil.SEQ_PATTERN);
						Expect(V.intake.notify('Project', { IDs: [ 1 ], Tenants: [ 7 ] })).to.match(libUtil.SEQ_PATTERN);
						Expect(V.intake.notify('FormType', { IDs: [ 1 ] }), 'a global lookup has no tenant to name').to.match(libUtil.SEQ_PATTERN);
						Expect(V.warnings.some((pMessage) => { return pMessage.indexOf('RequireNotifyTenants') >= 0; })).to.equal(true);
					});

				test('coverage: Bus and None cover every entity; Interim covers a wrapped controller, never a controller-less entity, unless ChangeCapture.NotifyManaged names it',
					() =>
					{
						let U = newUnit({ ChangeCapture: { Intake: 'Interim' } });
						U.host.Controllers.Project = newController('Project');
						U.intake.install();
						Expect(U.intake.covers('Project')).to.equal(true);
						Expect(U.intake.covers('LabForm')).to.equal(false);
						Expect(U.intake.uncovered([ 'Project', 'LabForm', 'Note' ])).to.deep.equal([ 'LabForm', 'Note' ]);
						Expect(U.warnings.some((pMessage) => { return pMessage.indexOf('no route-bound controller') >= 0; })).to.equal(true);
						U.intake.options.ChangeCapture.NotifyManaged = [ 'LabForm' ];
						Expect(U.intake.uncovered([ 'Project', 'LabForm', 'Note' ])).to.deep.equal([ 'Note' ]);
						U.intake.options.ChangeCapture.NotifyManaged = true;
						Expect(U.intake.uncovered([ 'Note' ])).to.deep.equal([]);
						let V = newUnit({ ChangeCapture: { Intake: 'None' } });
						V.intake.install();
						Expect(V.intake.covers('Note')).to.equal(true);
					});
			}
		);

		// ================================================================ the wrapping rules
		suite
		(
			'Interim wrapping rules on a stand-alone controller (internal-contracts §40.1, §40.2)',
			() =>
			{
				/**
				 * A unit intake whose host has one controller for Project, installed.
				 *
				 * @param {(pController: any) => void} [fBeforeInstall]
				 * @return {Record<string, any>}
				 */
				let fInstalled = (fBeforeInstall) =>
				{
					let U = newUnit({ ChangeCapture: { Intake: 'Interim' } });
					U.controller = newController('Project');
					U.host.Controllers.Project = U.controller;
					if (fBeforeInstall)
					{
						fBeforeInstall(U.controller);
					}
					U.install = U.intake.install();
					return U;
				};
				let fUpdateState = () =>
				{
					return (
						{
							Verb: 'doUpdate',
							ParentRequestState: { Verb: 'Update' },
							SessionData: { LoggedIn: true, UserID: 42, CustomerID: 1 },
							OriginalRecord: { IDProject: 7, IDCustomer: 1, Status: 'Active' },
							Record: { IDProject: 7, IDCustomer: 1, Status: 'Done' },
							RecordToModify: { IDProject: 7, Status: 'Done' }
						});
				};

				test('install wraps the behavior dispatcher of every catalog entity\'s route-bound controller (never a slot), idempotently, with a non-enumerable marker',
					() =>
					{
						let tmpBulk = function (pRequest, pRequestState, fCallback) { return fCallback(); };
						let U = fInstalled((pController) => { pController.BehaviorInjection.setBehavior('CreateBulk-PostOperation', tmpBulk); });
						Expect(U.install).to.deep.equal({ Source: 'Interim', Entities: [ 'Project' ] });
						Expect(U.intake.stats()).to.include({ Source: 'Interim', Entities: 1 });
						// The host's slots are untouched: a later plain setBehavior can never clobber the intake.
						let tmpFunctions = U.controller.BehaviorInjection._BehaviorFunctions;
						Expect(Object.keys(tmpFunctions)).to.deep.equal([ 'CreateBulk-PostOperation' ]);
						Expect(tmpFunctions['CreateBulk-PostOperation']).to.equal(tmpBulk);
						Expect(U.intake.Interim.wrappedSlots(U.controller).sort()).to.deep.equal(SLOTS.slice().sort());
						let tmpInjection = U.controller.BehaviorInjection;
						let fDispatcher = tmpInjection.runBehavior;
						Expect(Object.prototype.hasOwnProperty.call(tmpInjection, 'runBehavior')).to.equal(true);
						Expect(Object.keys(tmpInjection)).to.not.include('runBehavior');
						Expect(Object.getOwnPropertyDescriptor(fDispatcher, libChangeIntakeInterim.INTAKE_MARKER).enumerable).to.equal(false);
						Expect(U.intake.Interim.isCovered(U.controller)).to.equal(true);
						Expect(U.intake.install()).to.deep.equal({ Source: 'Interim', Entities: [ 'Project' ] });
						Expect(U.intake.Interim.wrapController('Project', U.controller)).to.equal(false);
						Expect(tmpInjection.runBehavior).to.equal(fDispatcher);
						// A controller-less entity and a controller without BehaviorInjection are skipped.
						U.host.Controllers.LabForm = { Name: 'NoInjection' };
						Expect(U.intake.install().Entities).to.deep.equal([ 'Project' ]);
						Expect(U.intake.Interim.wrapController('X', null)).to.equal(false);
					});

				test('the event is ingested AT ENTRY (the row is committed), then the slot\'s behavior runs with the controller as this; the original callback gets its answer unchanged',
					(fDone) =>
					{
						let tmpOrder = [];
						let tmpThis = null;
						let U = fInstalled(
							(pController) =>
							{
								pController.BehaviorInjection.setBehavior('Update-PostOperation',
									function (pRequest, pRequestState, fCallback)
									{
										tmpThis = this;
										tmpOrder.push('previous');
										return fCallback();
									});
							});
						U.intake.subscribe('Order', () => { tmpOrder.push('event'); });
						runSlot(U.controller, 'Update-PostOperation', fUpdateState(),
							(pError) =>
							{
								tmpOrder.push('callback');
								Expect(pError).to.equal(undefined);
								Expect(tmpThis).to.equal(U.controller);
								Expect(tmpOrder).to.deep.equal([ 'event', 'previous', 'callback' ]);
								Expect(U.events.length).to.equal(1);
								Expect(facts(U.events[0])).to.deep.equal(
									{
										Source: 'Interim', Entity: 'Project', Operation: 'Update', IDs: [ 7 ], Tenants: [ 1 ], Owners: null,
										ChangedColumns: [ 'Status', 'UpdateDate', 'UpdatingIDUser' ],
										KeyImages: { '7': { B: { IDCustomer: 1 }, A: { IDCustomer: 1 } } }, Filter: null,
										Actor: { PrincipalKey: libUtil.principalKey(U.host.buildPrincipal({ LoggedIn: true, UserID: 42, CustomerID: 1 }, null)), UserID: 42, Verb: 'Update' }
									});
								return fDone();
							});
					});

				test('a previous behavior that errors (sync or async) still yields exactly one event; its error reaches the callback unchanged',
					(fDone) =>
					{
						let tmpError = new Error('previous refused');
						let tmpAsync = false;
						let U = fInstalled(
							(pController) =>
							{
								pController.BehaviorInjection.setBehavior('Update-PostOperation',
									function (pRequest, pRequestState, fCallback)
									{
										if (tmpAsync)
										{
											return setImmediate(() => { fCallback(tmpError); });
										}
										return fCallback(tmpError);
									});
							});
						runSlot(U.controller, 'Update-PostOperation', fUpdateState(),
							(pError) =>
							{
								Expect(pError).to.equal(tmpError);
								Expect(U.events.length).to.equal(1);
								tmpAsync = true;
								runSlot(U.controller, 'Update-PostOperation', fUpdateState(),
									(pAsyncError) =>
									{
										Expect(pAsyncError).to.equal(tmpError);
										Expect(U.events.length).to.equal(2);
										return fDone();
									});
							});
					});

				test('a previous behavior that throws before calling back: one event, the callback gets the thrown error once (what runBehavior would do); a throw from the continuation is rethrown',
					() =>
					{
						let tmpThrown = new Error('previous threw');
						let U = fInstalled(
							(pController) =>
							{
								pController.BehaviorInjection.setBehavior('Delete-PostOperation', function () { throw tmpThrown; });
							});
						let tmpCalls = [];
						runSlot(U.controller, 'Delete-PostOperation', { Verb: 'Delete', OriginalRecord: { IDProject: 9, IDCustomer: 2 }, IDRecord: '9' }, (pError) => { tmpCalls.push(pError); });
						Expect(tmpCalls).to.deep.equal([ tmpThrown ]);
						Expect(U.events.length).to.equal(1);
						Expect(facts(U.events[0])).to.deep.include({ Operation: 'Delete', IDs: [ 9 ], Tenants: [ 2 ] });

						// The previous behavior calls back, then the continuation throws: the dispatcher behaves exactly
						// like meadow-endpoints' own runBehavior (whatever that does with it); still one event.
						let fCallbacks = (pController) =>
						{
							let tmpSeen = [];
							pController.BehaviorInjection.runBehavior('Delete-PostOperation', pController, {}, { OriginalRecord: { IDProject: 3, IDCustomer: 1 } },
								(pError) =>
								{
									tmpSeen.push(pError ? pError.message : 'ok');
									if (!pError)
									{
										throw new Error('continuation threw');
									}
								});
							return tmpSeen;
						};
						let V = fInstalled((pController) => { pController.BehaviorInjection.setBehavior('Delete-PostOperation', function (pRequest, pRequestState, fCallback) { return fCallback(); }); });
						let tmpBare = newController('Project');
						tmpBare.BehaviorInjection.setBehavior('Delete-PostOperation', function (pRequest, pRequestState, fCallback) { return fCallback(); });
						Expect(fCallbacks(V.controller)).to.deep.equal(fCallbacks(tmpBare));
						Expect(V.events.length).to.equal(1);
					});

				test('the change is captured at entry: a previous behavior that decorates or mutates the record cannot change it',
					(fDone) =>
					{
						let U = fInstalled(
							(pController) =>
							{
								pController.BehaviorInjection.setBehavior('Create-PostOperation',
									function (pRequest, pRequestState, fCallback)
									{
										pRequestState.Record.IDCustomer = 999;
										pRequestState.Record.Decorated = true;
										return fCallback();
									});
							});
						runSlot(U.controller, 'Create-PostOperation', { Verb: 'doCreate', ParentRequestState: { Verb: 'CreateBulk' }, Record: { IDProject: 11, IDCustomer: 1 }, RecordToCreate: { IDCustomer: 1 } },
							() =>
							{
								Expect(facts(U.events[0])).to.deep.include({ Operation: 'Create', IDs: [ 11 ], Tenants: [ 1 ], KeyImages: { '11': { A: { IDCustomer: 1 } } } });
								Expect(U.events[0].Actor.Verb).to.equal('CreateBulk');
								return fDone();
							});
					});

				test('a capture failure never fails the write and fails CLOSED: an EntityDirty of every tenant, WrapperErrors and FailClosed counted, the callback runs without an error; no previous behavior → the callback directly',
					(fDone) =>
					{
						let U = fInstalled();
						let tmpState = { Verb: 'Update' };
						Object.defineProperty(tmpState, 'OriginalRecord', { enumerable: true, get: () => { throw new Error('state getter boom'); } });
						runSlot(U.controller, 'Update-PostOperation', tmpState,
							(pError) =>
							{
								Expect(pError).to.equal(undefined);
								Expect(U.events.length).to.equal(1);
								Expect(facts(U.events[0])).to.deep.include({ Entity: 'Project', Operation: 'EntityDirty', IDs: [], Tenants: [ '*' ], ChangedColumns: null });
								Expect(U.intake.stats()).to.include({ WrapperErrors: 1, FailClosed: 1 });
								Expect(U.warnings.some((pMessage) => { return pMessage.indexOf('"Project"') >= 0; })).to.equal(true);
								runSlot(U.controller, 'Undelete-PostOperation', { Verb: 'Undelete', OriginalRecord: { IDProject: 4, IDCustomer: 1, Deleted: 1 } },
									(pUndeleteError) =>
									{
										Expect(pUndeleteError).to.equal(undefined);
										Expect(facts(U.events[1])).to.deep.include({ Operation: 'Undelete', IDs: [ 4 ], Tenants: [ 1 ] });
										return fDone();
									});
							});
					});

				test('a behavior chain-wrapped AFTER the intake still runs (event → previous → after); a plain setBehavior after the install cannot remove the intake',
					(fDone) =>
					{
						let tmpOrder = [];
						let U = fInstalled(
							(pController) =>
							{
								pController.BehaviorInjection.setBehavior('Update-PostOperation', function (pRequest, pRequestState, fCallback) { tmpOrder.push('previous'); return fCallback(); });
							});
						U.intake.subscribe('Order', () => { tmpOrder.push('event'); });
						libHarness.installBehavior(U.controller, 'Update-PostOperation',
							function (pRequest, pRequestState, fCallback)
							{
								tmpOrder.push(this === U.controller ? 'after' : 'after(wrong this)');
								return fCallback();
							});
						runSlot(U.controller, 'Update-PostOperation', fUpdateState(),
							() =>
							{
								Expect(tmpOrder).to.deep.equal([ 'event', 'previous', 'after' ]);
								// The documented single-slot API, used the ordinary way: the slot is replaced, the intake stays.
								U.controller.BehaviorInjection.setBehavior('Update-PostOperation', function (pRequest, pRequestState, fCallback) { tmpOrder.push('replaced'); return fCallback(); });
								tmpOrder = [];
								runSlot(U.controller, 'Update-PostOperation', fUpdateState(),
									() =>
									{
										Expect(tmpOrder).to.deep.equal([ 'event', 'replaced' ]);
										Expect(U.events.length).to.equal(2);
										return fDone();
									});
							});
					});

				test('ME-1 (addBehavior, no dispatcher): the capture and the snapshots at the LOWEST order, the arms at the highest; never replacing a slot',
					(fDone) =>
					{
						let U = newUnit({ ChangeCapture: { Intake: 'Interim' } });
						let tmpAdded = [];
						let tmpController = { BehaviorInjection: { addBehavior: (pSlot, fBehavior, pOptions) => { tmpAdded.push([ pSlot, fBehavior, pOptions ]); }, setBehavior: () => { throw new Error('setBehavior must not be used'); } } };
						U.host.Controllers.Project = tmpController;
						Expect(U.intake.install().Entities).to.deep.equal([ 'Project' ]);
						let tmpLowest = { Name: 'Faceting', Order: -1000 };
						let tmpHighest = { Name: 'FacetingArm', Order: 1000 };
						Expect(tmpAdded.map((pEntry) => { return [ pEntry[0], pEntry[2] ]; })).to.deep.equal(
							SLOTS.map((pSlot) => { return [ pSlot, tmpLowest ]; })
								.concat([ 'Update-PreOperation', 'Delete-PreOperation', 'Undelete-PreOperation' ].map((pSlot) => { return [ pSlot, tmpLowest ]; }))
								.concat([ 'Create-QueryConfiguration', 'Update-QueryConfiguration', 'Delete-PreOperation', 'Undelete-PreOperation' ].map((pSlot) => { return [ pSlot, tmpHighest ]; })));
						Expect(U.intake.Interim.isCovered(tmpController)).to.equal(true);
						U.intake.install();
						Expect(tmpAdded.length).to.equal(11);
						// The snapshot (lowest order) runs before a host behavior mutates the shared record; the capture
						// at PostOperation then sees the true pre-image.
						let tmpState = fUpdateState();
						tmpState.OriginalRecord = tmpState.Record = { IDProject: 7, IDCustomer: 1, Status: 'Active' };
						tmpAdded[4][1].call(tmpController, {}, tmpState, () => {});
						tmpState.Record = { IDProject: 7, IDCustomer: 1, Status: 'Done' };
						tmpState.OriginalRecord.Status = 'Done';
						tmpAdded[1][1].call(tmpController, {}, tmpState,
							(pError) =>
							{
								Expect(pError).to.equal(undefined);
								Expect(U.events.length).to.equal(1);
								Expect(U.events[0].Operation).to.equal('Update');
								Expect(U.events[0].ChangedColumns).to.deep.equal([ 'Status', 'UpdateDate', 'UpdatingIDUser' ]);
								return fDone();
							});
					});

				test('source selection: \'None\' wraps nothing; wrappers stay but go inert once the source is no longer the interim one',
					(fDone) =>
					{
						let U = newUnit({ ChangeCapture: { Intake: 'None' } });
						U.controller = newController('Project');
						U.host.Controllers.Project = U.controller;
						Expect(U.intake.install()).to.deep.equal({ Source: 'None', Entities: [] });
						Expect(U.controller.BehaviorInjection._BehaviorFunctions).to.deep.equal({});
						U.intake.options.ChangeCapture.Intake = 'Interim';
						Expect(U.intake.install().Source).to.equal('Interim');
						U.intake.options.ChangeCapture.Intake = 'None';
						Expect(U.intake.install()).to.deep.equal({ Source: 'None', Entities: [] });
						Expect(U.intake.Interim.wrappedSlots(U.controller).length).to.equal(4);
						runSlot(U.controller, 'Update-PostOperation', fUpdateState(),
							(pError) =>
							{
								Expect(pError).to.equal(undefined);
								Expect(U.events.length).to.equal(0);
								// notify still works under 'None'.
								Expect(U.intake.notify('Project', { IDs: [ 1 ] })).to.match(libUtil.SEQ_PATTERN);
								return fDone();
							});
					});

				test('an armed write whose DAL call fails (an error, or Create / Update without a record) ingests ONE conservative event: the snapshot pre-image\'s and the submitted tenant, \'#all\'; an unarmed (DAL-direct) write passes through untouched',
					(fDone) =>
					{
						let U = newUnit({ ChangeCapture: { Intake: 'Interim' } });
						let tmpDAL = (
							{
								Result: { Error: null, Record: null },
								doUpdate: function (pQuery, fCallback) { return fCallback(this.Result.Error, pQuery, null, this.Result.Record); },
								doCreate: function (pQuery, fCallback) { return fCallback(this.Result.Error, pQuery, null, this.Result.Record); }
							});
						U.controller = newController('Project');
						U.controller.DAL = tmpDAL;
						U.host.Controllers.Project = U.controller;
						U.intake.install();
						let tmpQuery = { query: { records: [ { IDProject: 7, IDCustomer: 2 } ] } };
						let tmpState = { Verb: 'doUpdate', ParentRequestState: { Verb: 'Update' }, SessionData: { UserID: 42, CustomerID: 1 }, Query: tmpQuery };
						tmpState.OriginalRecord = tmpState.Record = { IDProject: 7, IDCustomer: 1, Status: 'Active' };
						runSlot(U.controller, 'Update-PreOperation', tmpState, () => {});
						// A host behavior mutating the shared row after the snapshot.
						tmpState.Record.IDCustomer = 2;
						runSlot(U.controller, 'Update-QueryConfiguration', tmpState, () => {});
						tmpDAL.doUpdate(tmpQuery,
							(pError) =>
							{
								Expect(pError).to.equal(null);
								Expect(U.events.length).to.equal(1);
								Expect(facts(U.events[0])).to.deep.include({ Operation: 'Update', IDs: [ 7 ], Tenants: [ 1, 2 ], ChangedColumns: null });
								Expect(U.intake.stats().UnconfirmedWrites).to.equal(1);
								// The same request state never yields a second event (no PostOperation double).
								runSlot(U.controller, 'Update-PostOperation', tmpState,
									() =>
									{
										Expect(U.events.length).to.equal(1);
										// A DAL-direct write (no armed query) passes through: nothing.
										tmpDAL.doCreate({ query: { records: [ { IDCustomer: 1 } ] } },
											() =>
											{
												Expect(U.events.length).to.equal(1);
												// An armed Create that errors: one Create of the submitted row's tenant.
												let tmpCreateQuery = { query: { records: [ { Name: 'x', IDCustomer: 3 } ] } };
												let tmpCreateState = { Verb: 'doCreate', SessionData: {}, Query: tmpCreateQuery };
												runSlot(U.controller, 'Create-QueryConfiguration', tmpCreateState, () => {});
												tmpDAL.Result.Error = new Error('No record found after create.');
												tmpDAL.doCreate(tmpCreateQuery,
													(pCreateError) =>
													{
														Expect(pCreateError.message).to.equal('No record found after create.');
														Expect(facts(U.events[1])).to.deep.include({ Operation: 'Create', Tenants: [ 3 ] });
														// A successful armed write ingests nothing here (its PostOperation does).
														tmpDAL.Result = { Error: null, Record: { IDProject: 8, IDCustomer: 1 } };
														let tmpOkQuery = { query: { records: [ { IDProject: 8, Status: 'Done' } ] } };
														runSlot(U.controller, 'Update-QueryConfiguration', { SessionData: {}, Query: tmpOkQuery }, () => {});
														tmpDAL.doUpdate(tmpOkQuery,
															() =>
															{
																Expect(U.events.length).to.equal(2);
																return fDone();
															});
													});
											});
									});
							});
					});

				test('a replaced dispatcher is detected (ensureCovered): wrapped again, warned, and its entity invalidated with an EntityDirty of every tenant',
					() =>
					{
						let U = newUnit({ ChangeCapture: { Intake: 'Interim' } });
						U.controller = newController('Project');
						U.host.Controllers.Project = U.controller;
						U.intake.install();
						Expect(U.intake.Interim.ensureCovered('Project')).to.equal(true);
						Expect(U.events.length).to.equal(0);
						let tmpInjection = U.controller.BehaviorInjection;
						let fPrototype = Object.getPrototypeOf(tmpInjection).runBehavior;
						Object.defineProperty(tmpInjection, 'runBehavior', { value: function (...pArguments) { return fPrototype.apply(this, pArguments); }, configurable: true, writable: true });
						Expect(U.intake.Interim.isCovered(U.controller)).to.equal(false);
						Expect(U.intake.covers('Project')).to.equal(true);
						Expect(U.intake.Interim.isCovered(U.controller)).to.equal(true);
						Expect(facts(U.events[0])).to.deep.include({ Entity: 'Project', Operation: 'EntityDirty', Tenants: [ '*' ] });
						Expect(U.intake.stats()).to.include({ Rewraps: 1 });
						Expect(U.warnings.some((pMessage) => { return pMessage.indexOf('wrapped again') >= 0; })).to.equal(true);
						// Covered now: no second invalidation.
						Expect(U.intake.covers('Project')).to.equal(true);
						Expect(U.events.length).to.equal(1);
					});

				test('verbOf walks ParentRequestState to the endpoint verb; actorOf survives a principal that cannot be built',
					() =>
					{
						let U = newUnit();
						let tmpInterim = U.intake.Interim;
						Expect(tmpInterim.verbOf({ Verb: 'doCreate', ParentRequestState: { Verb: 'Upsert', ParentRequestState: { Verb: 'UpsertBulk' } } })).to.equal('UpsertBulk');
						Expect(tmpInterim.verbOf({ Verb: 'Delete' })).to.equal('Delete');
						Expect(tmpInterim.verbOf(null)).to.equal('Unknown');
						U.host.buildPrincipal = () => { throw new Error('no principal'); };
						Expect(tmpInterim.actorOf({}, { Verb: 'Update', SessionData: {} })).to.deep.equal({ PrincipalKey: null, UserID: 0, Verb: 'Update' });
						Expect(tmpInterim.captureChange('Project', 'Nope-PostOperation', {}, {})).to.equal(null);
					});
			}
		);

		// ================================================================ the Bus seam
		suite
		(
			'Bus adapter and source selection (internal-contracts §40.1, §40.6)',
			() =>
			{
				/**
				 * @return {Record<string, any>} a fake MeadowChangeBus recording its subscribers
				 */
				let fFakeBus = () =>
				{
					let tmpBus = { Subscribers: {}, Unsubscribed: [] };
					tmpBus.subscribe = (pHash, pSubscriber) => { tmpBus.Subscribers[pHash] = pSubscriber; };
					tmpBus.unsubscribe = (pHash) => { tmpBus.Unsubscribed.push(pHash); delete tmpBus.Subscribers[pHash]; };
					return tmpBus;
				};

				test('no bus: available() is false, install() is a no-op; \'Bus\' mode without a bus installs nothing (warn); unknown modes fall back to Auto',
					() =>
					{
						let U = newUnit({ ChangeCapture: { Intake: 'Bus' } });
						Expect(U.intake.Bus.available()).to.equal(false);
						Expect(U.intake.Bus.install()).to.equal(false);
						Expect(U.intake.install()).to.deep.equal({ Source: 'None', Entities: [] });
						Expect(U.warnings.some((pMessage) => { return pMessage.indexOf('MeadowChangeBus') >= 0; })).to.equal(true);
						U.intake.options.ChangeCapture.Intake = 'Sideways';
						Expect(U.intake.install().Source).to.equal('Interim');
						Expect(libChangeIntakeBus.SUBSCRIBER_NAME).to.equal('RetoldFaceting');
					});

				test('Auto with a bus: subscribes once under RetoldFaceting (onChangeSync + onBatch), installs no interim wrappers; uninstall unsubscribes',
					() =>
					{
						let U = newUnit();
						let tmpBus = fFakeBus();
						U.fable.MeadowChangeBus = tmpBus;
						U.controller = newController('Project');
						U.host.Controllers.Project = U.controller;
						Expect(U.intake.install()).to.deep.equal({ Source: 'Bus', Entities: Object.keys(UNIT_MODEL.Tables) });
						Expect(Object.keys(tmpBus.Subscribers)).to.deep.equal([ 'RetoldFaceting' ]);
						Expect(tmpBus.Subscribers.RetoldFaceting.onChangeSync).to.be.a('function');
						Expect(U.intake.Interim.wrappedSlots(U.controller)).to.deep.equal([]);
						Expect(U.intake.install().Source).to.equal('Bus');
						let tmpDone = 0;
						tmpBus.Subscribers.RetoldFaceting.onBatch({ Entity: 'Project' }, () => { tmpDone++; });
						Expect(tmpDone).to.equal(1);
						// 'Interim' with a bus present: the interim intake (no subscription).
						let V = newUnit({ ChangeCapture: { Intake: 'Interim' } });
						let tmpOtherBus = fFakeBus();
						V.fable.MeadowChangeBus = tmpOtherBus;
						Expect(V.intake.install().Source).to.equal('Interim');
						Expect(Object.keys(tmpOtherBus.Subscribers)).to.deep.equal([]);
						U.intake.Bus.uninstall();
						Expect(tmpBus.Unsubscribed).to.deep.equal([ 'RetoldFaceting' ]);
						Expect(U.intake.Bus.isInstalled()).to.equal(false);
					});

				test('a bus event maps onto the ChangeEvent: Images dropped, KeyImages reduced to the policy columns, Owners derived, the bus Seq kept when well-formed',
					() =>
					{
						let U = newUnit();
						U.fable.MeadowChangeBus = fFakeBus();
						U.intake.install();
						let fSync = U.fable.MeadowChangeBus.Subscribers.RetoldFaceting.onChangeSync;
						fSync(
							{
								ChangeID: 'c-7b0e', Source: 'DAL', Entity: 'LabForm', Operation: 'Update', IDs: [ 1201 ], Tenants: [ 7 ],
								ChangedColumns: [ 'OwnerIDUser', 'Status', 'UpdateDate', 'UpdatingIDUser' ],
								KeyImages: { '1201': { B: { IDCustomer: 7, OwnerIDUser: 42, IDMaterialIntake: 3 }, A: { IDCustomer: 7, OwnerIDUser: 43, IDMaterialIntake: 5 }, Via: { IDMaterialIntake: [ 3, 5 ] } } },
								Images: { '1201': { Before: { Secret: 'row data' }, After: { Secret: 'row data' } } },
								Actor: { UserID: 31, Verb: 'UpdateBulk', Session: { LoggedIn: true, UserID: 31, CustomerID: 7 } },
								Filter: null, Timestamp: 1791472445120, Epoch: 'e:4f0c2b9e', Seq: 'e:4f0c2b9e:88121'
							});
						Expect(U.events.length).to.equal(1);
						let tmpEvent = U.events[0];
						Expect(facts(tmpEvent)).to.deep.equal(
							{
								Source: 'Bus', Entity: 'LabForm', Operation: 'Update', IDs: [ 1201 ], Tenants: [ 7 ],
								Owners: [ { Tenant: 7, Owner: 42 }, { Tenant: 7, Owner: 43 } ],
								ChangedColumns: [ 'OwnerIDUser', 'Status', 'UpdateDate', 'UpdatingIDUser' ],
								KeyImages: { '1201': { B: { IDCustomer: 7, OwnerIDUser: 42 }, A: { IDCustomer: 7, OwnerIDUser: 43 } } },
								Filter: null,
								Actor: { PrincipalKey: libUtil.principalKey(U.host.buildPrincipal({ LoggedIn: true, UserID: 31, CustomerID: 7 }, null)), UserID: 31, Verb: 'UpdateBulk' }
							});
						Expect(tmpEvent).to.include({ Seq: 'e:4f0c2b9e:88121', Epoch: 'e:4f0c2b9e', Timestamp: 1791472445120 });
						Expect(JSON.stringify(tmpEvent)).to.not.contain('row data');
						Expect(U.intake.currentSeq()).to.equal(`${U.intake.NodeEpoch}:0`);
						// A malformed bus Seq gets a local one; DeleteByFilter folds into EntityDirty.
						let tmpDirty = U.intake.ingestBusEvent({ Entity: 'Project', Operation: 'DeleteByFilter', Filter: 'FBV~IDClient~EQ~3', Tenants: [ 7 ], Seq: 'c:1' });
						Expect(tmpDirty).to.deep.include({ Operation: 'EntityDirty', Filter: 'FBV~IDClient~EQ~3', Seq: `${U.intake.NodeEpoch}:1`, Source: 'Bus' });
						// An invalid bus event is refused, never thrown.
						Expect(U.intake.ingestBusEvent(null)).to.equal(null);
						Expect(U.intake.ingestBusEvent({ Entity: 'Project', Operation: 'Merge' })).to.equal(null);
						Expect(U.intake.stats().BySource).to.deep.equal({ Bus: 2 });
					});
			}
		);

		// ================================================================ over HTTP: ProjectTrack
		suite
		(
			'Interim intake over HTTP: ProjectTrack (internal-contracts §40.2, §40.3)',
			() =>
			{
				let H = null;
				let I = null;
				let tmpEvents = [];
				let tmpOrder = [];
				let tmpBaseline = {};
				let tmpLeadKey = null;
				let LEAD = { Tenant: 1, User: 1 };

				/**
				 * One HTTP write as Lead (default); calls back with the response and the events it produced.
				 */
				let fWrite = (pMethod, pPath, pBody, pWho, fCallback) =>
				{
					let tmpFrom = tmpEvents.length;
					H.request(pMethod, pPath, pBody, pWho || LEAD,
						(pError, pResponse) =>
						{
							Expect(pError).to.not.exist;
							return fCallback(pResponse, tmpEvents.slice(tmpFrom));
						});
				};
				let fRow = (pSQL, pParams) =>
				{
					return H.db.prepare(pSQL).get(...(pParams || []));
				};
				let fExpectSeqs = (pEvents) =>
				{
					let tmpLast = -1;
					pEvents.forEach(
						(pEvent) =>
						{
							let tmpSeq = libUtil.parseSeq(pEvent.Seq);
							Expect(tmpSeq.Epoch).to.equal(I.NodeEpoch);
							Expect(tmpSeq.N).to.equal(tmpLast < 0 ? tmpSeq.N : tmpLast + 1);
							tmpLast = tmpSeq.N;
						});
				};

				suiteSetup(
					(fDone) =>
					{
						H = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Faceting: { ChangeCapture: { Intake: 'None', NotifySettleMS: 0 } } },
							(pError) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								I = H.fable.RetoldFacetingChangeIntake;
								// A host behavior that exists before the intake wraps (as one installed before attach).
								H.installBehavior('Document', 'Create-PostOperation',
									function (pRequest, pRequestState, fCallback)
									{
										tmpOrder.push((this === H.faceting.Host.getRouteBoundController('Document')) ? 'pre' : 'pre(wrong this)');
										let tmpTitle = (pRequestState.RecordToCreate && (typeof(pRequestState.RecordToCreate.Title) === 'string')) ? pRequestState.RecordToCreate.Title : '';
										if (tmpTitle.indexOf('ERR ') === 0)
										{
											return fCallback(this.ErrorHandler.getError('Faceting test refusal', 409));
										}
										if (tmpTitle.indexOf('THROW ') === 0)
										{
											throw new Error('Faceting test throw');
										}
										return fCallback();
									});
								// Baselines: the same failing writes before any intake wraps the slot.
								fWrite('POST', '/1.0/Document', { Title: 'ERR baseline', IDCustomer: 1 }, null,
									(pErrResponse) =>
									{
										tmpBaseline.Err = pErrResponse;
										fWrite('POST', '/1.0/Document', { Title: 'THROW baseline', IDCustomer: 1 }, null,
											(pThrowResponse) =>
											{
												tmpBaseline.Throw = pThrowResponse;
												I.options.ChangeCapture.Intake = 'Interim';
												let tmpInstall = I.install();
												Expect(tmpInstall.Source).to.equal('Interim');
												Expect(tmpInstall.Entities).to.include.members([ 'Project', 'Document', 'FormType', 'Task', 'Issue', 'Client' ]);
												H.installBehavior('Document', 'Create-PostOperation',
													function (pRequest, pRequestState, fCallback)
													{
														tmpOrder.push((this === H.faceting.Host.getRouteBoundController('Document')) ? 'after' : 'after(wrong this)');
														return fCallback();
													});
												I.subscribe('Recorder', (pEvent) => { tmpOrder.push('event'); tmpEvents.push(pEvent); });
												H.faceting.Host.resolvePrincipal(libHarness.syntheticRequest('Document', LEAD),
													(pPrincipalError, pPrincipal) =>
													{
														tmpLeadKey = libUtil.principalKey(pPrincipal);
														return fDone(pPrincipalError);
													});
											});
									});
							});
					});
				suiteTeardown((fDone) => { H.stop(fDone); });

				test('single Create: one event (§40.3 Create row), Actor = the read principal\'s key, delivered before the client sees the response; event → previous → after, controller as this',
					(fDone) =>
					{
						tmpOrder = [];
						fWrite('POST', '/1.0/Document', { Title: 'Intake create', Status: 'Draft', DocumentDate: '2026-03-15', IDFormType: 4, IDProject: 1, IDCustomer: 1 }, null,
							(pResponse, pNew) =>
							{
								Expect(pResponse.Status).to.equal(200);
								let tmpID = pResponse.Body.IDDocument;
								Expect(tmpID).to.be.a('number');
								// Already delivered when the response callback runs (synchronous at the PostOperation).
								Expect(pNew.length).to.equal(1);
								Expect(facts(pNew[0])).to.deep.equal(
									{
										Source: 'Interim', Entity: 'Document', Operation: 'Create', IDs: [ tmpID ], Tenants: [ 1 ], Owners: null,
										ChangedColumns: null, KeyImages: { [String(tmpID)]: { A: { IDCustomer: 1 } } }, Filter: null,
										Actor: { PrincipalKey: tmpLeadKey, UserID: 1, Verb: 'Create' }
									});
								Expect(tmpLeadKey).to.match(/^pk:[0-9a-f]{16}$/);
								Expect(pNew[0].Seq).to.match(libUtil.SEQ_PATTERN);
								Expect(pNew[0].Epoch).to.equal(I.NodeEpoch);
								// Ingested at entry (the row is committed), before the host's own PostOperation behaviors.
								Expect(tmpOrder).to.deep.equal([ 'event', 'pre', 'after' ]);
								return fDone();
							});
					});

				test('bulk Create (POST /1.0/Documents): one event per record, consecutive Seqs, each row\'s own tenant (never the session\'s)',
					(fDone) =>
					{
						fWrite('POST', '/1.0/Documents', [ { Title: 'Bulk A', IDCustomer: 1 }, { Title: 'Bulk B', IDCustomer: 2 }, { Title: 'Bulk C', IDCustomer: 1 } ], null,
							(pResponse, pNew) =>
							{
								Expect(pResponse.Status).to.equal(200);
								Expect(pNew.length).to.equal(3);
								Expect(pNew.map((pEvent) => { return pEvent.Operation; })).to.deep.equal([ 'Create', 'Create', 'Create' ]);
								Expect(pNew.map((pEvent) => { return pEvent.IDs[0]; })).to.deep.equal(pResponse.Body.map((pRecord) => { return pRecord.IDDocument; }));
								Expect(pNew.map((pEvent) => { return facts(pEvent).Tenants; })).to.deep.equal([ [ 1 ], [ 2 ], [ 1 ] ]);
								pNew.forEach((pEvent) => { Expect(pEvent.Actor).to.deep.equal({ PrincipalKey: tmpLeadKey, UserID: 1, Verb: 'CreateBulk' }); });
								fExpectSeqs(pNew);
								return fDone();
							});
					});

				test('Update (PUT /1.0/Document, PUT and PATCH /1.0/Document/:IDRecord): the exact column diff ∪ the audit columns',
					(fDone) =>
					{
						let tmpRow = fRow('SELECT IDDocument, Status FROM Document WHERE IDCustomer = 1 AND Deleted = 0 AND Status <> ? ORDER BY IDDocument LIMIT 1', [ 'Final' ]);
						let tmpID = tmpRow.IDDocument;
						fWrite('PUT', '/1.0/Document', { IDDocument: tmpID, Status: 'Final' }, null,
							(pPut, pPutEvents) =>
							{
								Expect(pPut.Status).to.equal(200);
								Expect(pPutEvents.length).to.equal(1);
								Expect(facts(pPutEvents[0])).to.deep.equal(
									{
										Source: 'Interim', Entity: 'Document', Operation: 'Update', IDs: [ tmpID ], Tenants: [ 1 ], Owners: null,
										ChangedColumns: [ 'Status', 'UpdateDate', 'UpdatingIDUser' ],
										KeyImages: { [String(tmpID)]: { B: { IDCustomer: 1 }, A: { IDCustomer: 1 } } }, Filter: null,
										Actor: { PrincipalKey: tmpLeadKey, UserID: 1, Verb: 'Update' }
									});
								fWrite('PUT', `/1.0/Document/${tmpID}`, { Title: 'Renamed by id' }, null,
									(pPutByID, pByIDEvents) =>
									{
										Expect(pPutByID.Status).to.equal(200);
										Expect(pByIDEvents.length).to.equal(1);
										Expect(facts(pByIDEvents[0])).to.deep.include({ Operation: 'Update', IDs: [ tmpID ], ChangedColumns: [ 'Title', 'UpdateDate', 'UpdatingIDUser' ] });
										fWrite('PATCH', `/1.0/Document/${tmpID}`, { Summary: 'Patched', Status: tmpRow.Status }, null,
											(pPatch, pPatchEvents) =>
											{
												Expect(pPatch.Status).to.equal(200);
												Expect(pPatchEvents.length).to.equal(1);
												Expect(facts(pPatchEvents[0]).ChangedColumns).to.deep.equal([ 'Status', 'Summary', 'UpdateDate', 'UpdatingIDUser' ]);
												return fDone();
											});
									});
							});
					});

				test('bulk Update (PUT /1.0/Documents): one event per record',
					(fDone) =>
					{
						let tmpRows = H.db.prepare('SELECT IDDocument FROM Document WHERE IDCustomer = 1 AND Deleted = 0 ORDER BY IDDocument LIMIT 2 OFFSET 5').all();
						fWrite('PUT', '/1.0/Documents', tmpRows.map((pRow) => { return { IDDocument: pRow.IDDocument, Summary: 'Bulk edited' }; }), null,
							(pResponse, pNew) =>
							{
								Expect(pResponse.Status).to.equal(200);
								Expect(pNew.length).to.equal(2);
								Expect(pNew.map((pEvent) => { return pEvent.IDs[0]; })).to.deep.equal(tmpRows.map((pRow) => { return pRow.IDDocument; }));
								pNew.forEach(
									(pEvent) =>
									{
										Expect(facts(pEvent)).to.deep.include({ Operation: 'Update', Tenants: [ 1 ], ChangedColumns: [ 'Summary', 'UpdateDate', 'UpdatingIDUser' ] });
										Expect(pEvent.Actor.Verb).to.equal('UpdateBulk');
									});
								fExpectSeqs(pNew);
								return fDone();
							});
					});

				test('Upsert (create and update paths), Upserts and Upserts/Detailed: one event per record with the path\'s Operation',
					(fDone) =>
					{
						fWrite('PUT', '/1.0/Document/Upsert', { Title: 'Upsert new', Status: 'Draft', IDCustomer: 1 }, null,
							(pCreate, pCreateEvents) =>
							{
								Expect(pCreate.Status).to.equal(200);
								let tmpID = pCreate.Body.IDDocument;
								Expect(pCreateEvents.length).to.equal(1);
								Expect(facts(pCreateEvents[0])).to.deep.include({ Operation: 'Create', IDs: [ tmpID ], Tenants: [ 1 ], ChangedColumns: null });
								Expect(pCreateEvents[0].Actor.Verb).to.equal('Upsert');
								fWrite('PUT', '/1.0/Document/Upsert', { IDDocument: tmpID, Status: 'Archived' }, null,
									(pUpdate, pUpdateEvents) =>
									{
										Expect(pUpdate.Status).to.equal(200);
										Expect(pUpdateEvents.length).to.equal(1);
										// The pre-image is the row the upsert read (the cached record).
										Expect(facts(pUpdateEvents[0])).to.deep.include(
											{ Operation: 'Update', IDs: [ tmpID ], Tenants: [ 1 ], ChangedColumns: [ 'Status', 'UpdateDate', 'UpdatingIDUser' ], KeyImages: { [String(tmpID)]: { B: { IDCustomer: 1 }, A: { IDCustomer: 1 } } } });
										fWrite('PUT', '/1.0/Document/Upserts', [ { Title: 'Upserts new', IDCustomer: 2 }, { IDDocument: tmpID, Status: 'Draft' } ], null,
											(pBulk, pBulkEvents) =>
											{
												Expect(pBulk.Status).to.equal(200);
												Expect(pBulkEvents.map((pEvent) => { return pEvent.Operation; })).to.deep.equal([ 'Create', 'Update' ]);
												Expect(facts(pBulkEvents[0]).Tenants).to.deep.equal([ 2 ]);
												Expect(pBulkEvents[1].IDs).to.deep.equal([ tmpID ]);
												pBulkEvents.forEach((pEvent) => { Expect(pEvent.Actor.Verb).to.equal('UpsertBulk'); });
												fExpectSeqs(pBulkEvents);
												fWrite('PUT', '/1.0/Document/Upserts/Detailed', [ { IDDocument: tmpID, Summary: 'Detailed' } ], null,
													(pDetailed, pDetailedEvents) =>
													{
														Expect(pDetailed.Status).to.equal(200);
														Expect(pDetailedEvents.length).to.equal(1);
														Expect(facts(pDetailedEvents[0])).to.deep.include({ Operation: 'Update', IDs: [ tmpID ], ChangedColumns: [ 'Summary', 'UpdateDate', 'UpdatingIDUser' ] });
														Expect(pDetailedEvents[0].Actor.Verb).to.equal('UpsertBulkDetailed');
														return fDone();
													});
											});
									});
							});
					});

				test('Delete (DELETE /1.0/Document/:IDRecord) and Undelete (GET /1.0/Document/Undelete/:IDRecord): one event each, the pre-image\'s tenant',
					(fDone) =>
					{
						let tmpID = fRow('SELECT IDDocument FROM Document WHERE IDCustomer = 2 AND Deleted = 0 ORDER BY IDDocument LIMIT 1').IDDocument;
						fWrite('DELETE', `/1.0/Document/${tmpID}`, null, null,
							(pDelete, pDeleteEvents) =>
							{
								Expect(pDelete.Status).to.equal(200);
								Expect(pDeleteEvents.length).to.equal(1);
								Expect(facts(pDeleteEvents[0])).to.deep.equal(
									{
										Source: 'Interim', Entity: 'Document', Operation: 'Delete', IDs: [ tmpID ], Tenants: [ 2 ], Owners: null, ChangedColumns: null,
										KeyImages: { [String(tmpID)]: { B: { IDCustomer: 2 } } }, Filter: null,
										Actor: { PrincipalKey: tmpLeadKey, UserID: 1, Verb: 'Delete' }
									});
								fWrite('GET', `/1.0/Document/Undelete/${tmpID}`, null, null,
									(pUndelete, pUndeleteEvents) =>
									{
										Expect(pUndelete.Status).to.equal(200);
										Expect(pUndeleteEvents.length).to.equal(1);
										Expect(facts(pUndeleteEvents[0])).to.deep.include({ Operation: 'Undelete', IDs: [ tmpID ], Tenants: [ 2 ], KeyImages: { [String(tmpID)]: { B: { IDCustomer: 2 } } } });
										Expect(pUndeleteEvents[0].Actor.Verb).to.equal('Undelete');
										// A failing delete (no such record) reaches no PostOperation: no event.
										fWrite('DELETE', '/1.0/Document/987654', null, null,
											(pMissing, pMissingEvents) =>
											{
												Expect(pMissing.Status).to.equal(404);
												Expect(pMissingEvents.length).to.equal(0);
												return fDone();
											});
									});
							});
					});

				test('a tenant move (IDCustomer 1 → 2 and back): both tenants and both key images',
					(fDone) =>
					{
						let tmpID = fRow('SELECT IDProject FROM Project WHERE IDCustomer = 1 AND Deleted = 0 ORDER BY IDProject DESC LIMIT 1').IDProject;
						fWrite('PUT', '/1.0/Project', { IDProject: tmpID, IDCustomer: 2 }, null,
							(pMove, pMoveEvents) =>
							{
								Expect(pMove.Status).to.equal(200);
								Expect(facts(pMoveEvents[0])).to.deep.include(
									{ Entity: 'Project', Operation: 'Update', IDs: [ tmpID ], Tenants: [ 1, 2 ], ChangedColumns: [ 'IDCustomer', 'UpdateDate', 'UpdatingIDUser' ], KeyImages: { [String(tmpID)]: { B: { IDCustomer: 1 }, A: { IDCustomer: 2 } } } });
								fWrite('PUT', '/1.0/Project', { IDProject: tmpID, IDCustomer: 1 }, null,
									(pBack, pBackEvents) =>
									{
										Expect(pBack.Status).to.equal(200);
										Expect(facts(pBackEvents[0]).Tenants).to.deep.equal([ 2, 1 ]);
										return fDone();
									});
							});
					});

				test('a behavior that drops (or rewrites) the OriginalRecord alias cannot hide the pre-image: the snapshot taken at Update-PreOperation entry gives the exact diff and the old tenant',
					(fDone) =>
					{
						// On Task only: its Update-PreOperation drops the OriginalRecord alias (an endpoint version
						// without it looks the same at PostOperation).
						H.installBehavior('Task', 'Update-PreOperation', function (pRequest, pRequestState, fCallback) { delete pRequestState.OriginalRecord; return fCallback(); });
						let tmpID = fRow('SELECT IDTask FROM Task WHERE IDCustomer = 1 AND Deleted = 0 ORDER BY IDTask LIMIT 1').IDTask;
						fWrite('PUT', '/1.0/Task', { IDTask: tmpID, Status: 'Blocked' }, null,
							(pPlain, pPlainEvents) =>
							{
								Expect(pPlain.Status).to.equal(200);
								Expect(facts(pPlainEvents[0])).to.deep.include(
									{ Entity: 'Task', IDs: [ tmpID ], Tenants: [ 1 ], ChangedColumns: [ 'Status', 'UpdateDate', 'UpdatingIDUser' ], KeyImages: { [String(tmpID)]: { B: { IDCustomer: 1 }, A: { IDCustomer: 1 } } } });
								fWrite('PUT', '/1.0/Task', { IDTask: tmpID, IDCustomer: 1, Status: 'Open' }, null,
									(pTenant, pTenantEvents) =>
									{
										Expect(pTenant.Status).to.equal(200);
										// The tenant column was submitted but did not change: the snapshot proves it.
										Expect(facts(pTenantEvents[0])).to.deep.include({ Tenants: [ 1 ], ChangedColumns: [ 'Status', 'UpdateDate', 'UpdatingIDUser' ] });
										return fDone();
									});
							});
					});

				test('a global lookup (FormType, excluded from the policy): Tenants [*], no owners, no key images',
					(fDone) =>
					{
						let tmpRow = fRow('SELECT IDFormType, Name FROM FormType ORDER BY IDFormType LIMIT 1');
						fWrite('PUT', '/1.0/FormType', { IDFormType: tmpRow.IDFormType, Name: `${tmpRow.Name} (edited)` }, null,
							(pResponse, pNew) =>
							{
								Expect(pResponse.Status).to.equal(200);
								Expect(facts(pNew[0])).to.deep.include({ Entity: 'FormType', Operation: 'Update', IDs: [ tmpRow.IDFormType ], Tenants: [ '*' ], Owners: null, ChangedColumns: [ 'Name' ], KeyImages: {} });
								fWrite('PUT', '/1.0/FormType', { IDFormType: tmpRow.IDFormType, Name: tmpRow.Name }, null, () => { return fDone(); });
							});
					});

				test('a previous behavior that errors or throws: exactly one event, and the client response is identical to the one without the intake',
					(fDone) =>
					{
						Expect(tmpBaseline.Err.Status).to.equal(409);
						Expect(tmpBaseline.Throw.Status).to.equal(500);
						fWrite('POST', '/1.0/Document', { Title: 'ERR baseline', IDCustomer: 1 }, null,
							(pErr, pErrEvents) =>
							{
								Expect(pErr.Status).to.equal(tmpBaseline.Err.Status);
								Expect(withoutStack(pErr.Body)).to.deep.equal(withoutStack(tmpBaseline.Err.Body));
								Expect(pErrEvents.length).to.equal(1);
								Expect(pErrEvents[0].Operation).to.equal('Create');
								fWrite('POST', '/1.0/Document', { Title: 'THROW baseline', IDCustomer: 1 }, null,
									(pThrow, pThrowEvents) =>
									{
										Expect(pThrow.Status).to.equal(tmpBaseline.Throw.Status);
										Expect(withoutStack(pThrow.Body)).to.deep.equal(withoutStack(tmpBaseline.Throw.Body));
										Expect(pThrowEvents.length).to.equal(1);
										Expect(I.stats().WrapperErrors).to.equal(0);
										return fDone();
									});
							});
					});

				test('a throwing subscriber leaves the 2xx response and the other subscribers intact',
					(fDone) =>
					{
						let tmpErrors = I.stats().SubscriberErrors;
						I.subscribe('Thrower', () => { throw new Error('subscriber boom'); });
						fWrite('POST', '/1.0/Document', { Title: 'Despite a throwing subscriber', IDCustomer: 1 }, null,
							(pResponse, pNew) =>
							{
								I.unsubscribe('Thrower');
								Expect(pResponse.Status).to.equal(200);
								Expect(pResponse.Body.Title).to.equal('Despite a throwing subscriber');
								Expect(pNew.length).to.equal(1);
								Expect(pNew[0].IDs).to.deep.equal([ pResponse.Body.IDDocument ]);
								Expect(I.stats().SubscriberErrors).to.equal(tmpErrors + 1);
								return fDone();
							});
					});

				test('writes the interim intake cannot see (DAL-direct) produce nothing; notify / notifyByFilter through the real host do',
					(fDone) =>
					{
						let tmpFrom = tmpEvents.length;
						let tmpDAL = H.fable.DAL.Document;
						let tmpID = fRow('SELECT IDDocument FROM Document WHERE IDCustomer = 1 AND Deleted = 0 ORDER BY IDDocument LIMIT 1').IDDocument;
						let tmpQuery = tmpDAL.query.addRecord({ IDDocument: tmpID, Summary: 'DAL-direct' });
						tmpDAL.doUpdate(tmpQuery,
							(pError) =>
							{
								Expect(pError).to.not.exist;
								Expect(fRow('SELECT Summary FROM Document WHERE IDDocument = ?', [ tmpID ]).Summary).to.equal('DAL-direct');
								Expect(tmpEvents.length).to.equal(tmpFrom);
								let tmpSeq = H.faceting.fable.RetoldFacetingChangeIntake.notify('Document', { IDs: [ tmpID ], Tenants: [ 1 ], ChangedColumns: [ 'Summary' ] });
								Expect(tmpSeq).to.match(libUtil.SEQ_PATTERN);
								Expect(facts(tmpEvents[tmpFrom])).to.deep.include({ Source: 'Notify', Entity: 'Document', IDs: [ tmpID ], Tenants: [ 1 ], ChangedColumns: [ 'Summary' ] });
								Expect(I.notify('Gizmo', { IDs: [ 1 ] })).to.equal(null);
								Expect(I.notifyByFilter('Document', 'FBV~IDProject~EQ~3', { Tenants: [ 1 ] })).to.match(libUtil.SEQ_PATTERN);
								Expect(tmpEvents[tmpFrom + 1]).to.deep.include({ Operation: 'EntityDirty', Filter: 'FBV~IDProject~EQ~3' });
								return fDone();
							});
					});
			}
		);

		// ================================================================ over HTTP: LabTrack (Personal)
		suite
		(
			'Interim intake over HTTP: LabTrack (owner-qualified LabForm)',
			() =>
			{
				let H = null;
				let I = null;
				let tmpEvents = [];
				let TECH = null;

				let fWrite = (pMethod, pPath, pBody, pWho, fCallback) =>
				{
					let tmpFrom = tmpEvents.length;
					H.request(pMethod, pPath, pBody, pWho || TECH,
						(pError, pResponse) =>
						{
							Expect(pError).to.not.exist;
							return fCallback(pResponse, tmpEvents.slice(tmpFrom));
						});
				};

				suiteSetup(
					(fDone) =>
					{
						H = libHarness.start({ Port: PORT, Fixture: 'LabTrack', Faceting: { ChangeCapture: { Intake: 'Interim', NotifySettleMS: 0 } } },
							(pError) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								I = H.fable.RetoldFacetingChangeIntake;
								Expect(I.install().Entities).to.include.members([ 'LabForm', 'LabFormType', 'MaterialIntake' ]);
								I.subscribe('Recorder', (pEvent) => { tmpEvents.push(pEvent); });
								TECH = H.as('Tech');
								return fDone();
							});
					});
				suiteTeardown((fDone) => { H.stop(fDone); });

				test('an owner\'s LabForm update: owner pairs and both policy columns in the key images; Actor = the read principal\'s key',
					(fDone) =>
					{
						let tmpRow = H.db.prepare('SELECT IDLabForm, Status FROM LabForm WHERE IDCustomer = 1 AND OwnerIDUser = ? AND Deleted = 0 ORDER BY IDLabForm LIMIT 1').get(TECH.User);
						H.faceting.Host.resolvePrincipal(libHarness.syntheticRequest('LabForm', TECH),
							(pPrincipalError, pPrincipal) =>
							{
								Expect(pPrincipalError).to.not.exist;
								fWrite('PUT', '/1.0/LabForm', { IDLabForm: tmpRow.IDLabForm, Status: (tmpRow.Status === 'Complete') ? 'Pending' : 'Complete', CompletedDate: '2026-03-15' }, null,
									(pResponse, pNew) =>
									{
										Expect(pResponse.Status).to.equal(200);
										Expect(pNew.length).to.equal(1);
										Expect(facts(pNew[0])).to.deep.equal(
											{
												Source: 'Interim', Entity: 'LabForm', Operation: 'Update', IDs: [ tmpRow.IDLabForm ], Tenants: [ 1 ],
												Owners: [ { Tenant: 1, Owner: TECH.User } ],
												ChangedColumns: [ 'CompletedDate', 'Status', 'UpdateDate', 'UpdatingIDUser' ].filter((pColumn) => { return (pColumn !== 'CompletedDate') || (pNew[0].ChangedColumns.indexOf('CompletedDate') >= 0); }),
												KeyImages: { [String(tmpRow.IDLabForm)]: { B: { IDCustomer: 1, OwnerIDUser: TECH.User }, A: { IDCustomer: 1, OwnerIDUser: TECH.User } } },
												Filter: null,
												Actor: { PrincipalKey: libUtil.principalKey(pPrincipal), UserID: TECH.User, Verb: 'Update' }
											});
										Expect(pNew[0].ChangedColumns).to.include('Status');
										return fDone();
									});
							});
					});

				test('an owner move: both (tenant, owner) pairs; a new form: its owner pair',
					(fDone) =>
					{
						let COLLEAGUE = H.as('Colleague');
						let tmpID = H.db.prepare('SELECT IDLabForm FROM LabForm WHERE IDCustomer = 1 AND OwnerIDUser = ? AND Deleted = 0 ORDER BY IDLabForm DESC LIMIT 1').get(TECH.User).IDLabForm;
						fWrite('PUT', '/1.0/LabForm', { IDLabForm: tmpID, OwnerIDUser: COLLEAGUE.User }, null,
							(pMove, pMoveEvents) =>
							{
								Expect(pMove.Status).to.equal(200);
								Expect(facts(pMoveEvents[0])).to.deep.include(
									{ Tenants: [ 1 ], Owners: [ { Tenant: 1, Owner: TECH.User }, { Tenant: 1, Owner: COLLEAGUE.User } ], ChangedColumns: [ 'OwnerIDUser', 'UpdateDate', 'UpdatingIDUser' ] });
								fWrite('PUT', '/1.0/LabForm', { IDLabForm: tmpID, OwnerIDUser: TECH.User }, null,
									() =>
									{
										fWrite('POST', '/1.0/LabForm', { IDCustomer: 1, OwnerIDUser: TECH.User, Status: 'Pending', IDLabFormType: 1, IDMaterialIntake: 1 }, null,
											(pCreate, pCreateEvents) =>
											{
												Expect(pCreate.Status).to.equal(200);
												Expect(facts(pCreateEvents[0])).to.deep.include(
													{ Operation: 'Create', IDs: [ pCreate.Body.IDLabForm ], Tenants: [ 1 ], Owners: [ { Tenant: 1, Owner: TECH.User } ], KeyImages: { [String(pCreate.Body.IDLabForm)]: { A: { IDCustomer: 1, OwnerIDUser: TECH.User } } } });
												fWrite('DELETE', `/1.0/LabForm/${pCreate.Body.IDLabForm}`, null, null,
													(pDelete, pDeleteEvents) =>
													{
														Expect(pDelete.Status).to.equal(200);
														Expect(facts(pDeleteEvents[0])).to.deep.include({ Operation: 'Delete', Owners: [ { Tenant: 1, Owner: TECH.User } ] });
														return fDone();
													});
											});
									});
							});
					});

				test('the global LabFormType: Tenants [*], no owners',
					(fDone) =>
					{
						let tmpRow = H.db.prepare('SELECT IDLabFormType, Name FROM LabFormType ORDER BY IDLabFormType LIMIT 1').get();
						fWrite('PUT', '/1.0/LabFormType', { IDLabFormType: tmpRow.IDLabFormType, Name: `${tmpRow.Name}!` }, null,
							(pResponse, pNew) =>
							{
								Expect(pResponse.Status).to.equal(200);
								Expect(facts(pNew[0])).to.deep.include({ Entity: 'LabFormType', Tenants: [ '*' ], Owners: null, KeyImages: {}, ChangedColumns: [ 'Name' ] });
								return fDone();
							});
					});
			}
		);

		// ================================================================ over HTTP: Bookstore-Tenant + reload
		suite
		(
			'Interim intake over HTTP: Bookstore-Tenant; install is idempotent across a model reload',
			() =>
			{
				let H = null;
				let I = null;
				let tmpEvents = [];
				let ONE = { Tenant: 1, User: 5 };

				let fWrite = (pMethod, pPath, pBody, pWho, fCallback) =>
				{
					let tmpFrom = tmpEvents.length;
					H.request(pMethod, pPath, pBody, pWho || ONE,
						(pError, pResponse) =>
						{
							Expect(pError).to.not.exist;
							return fCallback(pResponse, tmpEvents.slice(tmpFrom));
						});
				};

				suiteSetup(
					(fDone) =>
					{
						H = libHarness.start({ Port: PORT, Fixture: 'Bookstore-Tenant', Faceting: { ChangeCapture: { NotifySettleMS: 0 }, Catalog: { GlobalEntities: [ 'Gadget' ] } } },
							(pError) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								I = H.fable.RetoldFacetingChangeIntake;
								Expect(I.install().Source).to.equal('Interim');
								I.subscribe('Recorder', (pEvent) => { tmpEvents.push(pEvent); });
								return fDone();
							});
					});
				suiteTeardown((fDone) => { H.stop(fDone); });

				test('the IDTenant policy: the row\'s tenant; an unset tenant value (0) is unknown (*); never the writer\'s session',
					(fDone) =>
					{
						fWrite('POST', '/1.0/Review', { IDBook: 1, Rating: 5, Text: 'Tenant two', IDTenant: 2 }, null,
							(pTwo, pTwoEvents) =>
							{
								Expect(pTwo.Status).to.equal(200);
								Expect(facts(pTwoEvents[0])).to.deep.include({ Entity: 'Review', Operation: 'Create', IDs: [ pTwo.Body.IDReview ], Tenants: [ 2 ], KeyImages: { [String(pTwo.Body.IDReview)]: { A: { IDTenant: 2 } } } });
								fWrite('POST', '/1.0/Review', { IDBook: 1, Rating: 4, Text: 'No tenant' }, null,
									(pNone, pNoneEvents) =>
									{
										Expect(pNone.Status).to.equal(200);
										Expect(pNone.Body.IDTenant).to.equal(0);
										Expect(facts(pNoneEvents[0]).Tenants).to.deep.equal([ '*' ]);
										return fDone();
									});
							});
					});

				test('install() again, a reload of the same model and a new entity: every write still yields exactly one event; the new entity is wrapped',
					(fDone) =>
					{
						let tmpController = H.faceting.Host.getRouteBoundController('Review');
						let tmpWrappers = SLOTS.map((pSlot) => { return tmpController.BehaviorInjection._BehaviorFunctions[pSlot]; });
						I.install();
						H.rds.loadModel('Bookstore', JSON.parse(JSON.stringify(H.model)), 'SQLite',
							(pReloadError) =>
							{
								Expect(pReloadError).to.not.exist;
								H.db.exec('CREATE TABLE Gadget (IDGadget INTEGER PRIMARY KEY AUTOINCREMENT, Deleted INTEGER NOT NULL DEFAULT 0, Color TEXT)');
								let tmpGadget =
									{
										TableName: 'Gadget',
										Columns: [ { Column: 'IDGadget', DataType: 'ID' }, { Column: 'Deleted', DataType: 'Boolean' }, { Column: 'Color', DataType: 'String', Size: '16' } ],
										MeadowSchema:
											{
												Scope: 'Gadget',
												DefaultIdentifier: 'IDGadget',
												Schema: [ { Column: 'IDGadget', Type: 'AutoIdentity', Size: 'Default' }, { Column: 'Deleted', Type: 'Deleted', Size: 'Default' }, { Column: 'Color', Type: 'String', Size: '16' } ],
												DefaultObject: { IDGadget: 0, Deleted: false, Color: '' },
												JsonSchema: { title: 'Gadget', type: 'object', properties: {}, required: [] }
											}
									};
								H.rds.loadModel('Gadget', { Tables: { Gadget: tmpGadget } }, 'SQLite',
									(pLoadError) =>
									{
										Expect(pLoadError).to.not.exist;
										let tmpInstall = I.install();
										I.install();
										Expect(tmpInstall.Entities).to.include.members([ 'Review', 'Book', 'Gadget' ]);
										Expect(H.faceting.Host.getRouteBoundController('Review')).to.equal(tmpController);
										SLOTS.forEach((pSlot, pIndex) => { Expect(tmpController.BehaviorInjection._BehaviorFunctions[pSlot]).to.equal(tmpWrappers[pIndex]); });
										fWrite('PUT', '/1.0/Review', { IDReview: 1, Text: 'After the reload' }, null,
											(pUpdate, pUpdateEvents) =>
											{
												Expect(pUpdate.Status).to.equal(200);
												Expect(pUpdateEvents.length).to.equal(1);
												Expect(facts(pUpdateEvents[0])).to.deep.include({ Entity: 'Review', Operation: 'Update', IDs: [ 1 ], ChangedColumns: [ 'Text', 'UpdateDate', 'UpdatingIDUser' ] });
												fWrite('POST', '/1.0/Gadget', { Color: 'red' }, null,
													(pGadget, pGadgetEvents) =>
													{
														Expect(pGadget.Status).to.equal(200);
														Expect(pGadgetEvents.length).to.equal(1);
														// No IDTenant column: Global under the policy.
														Expect(facts(pGadgetEvents[0])).to.deep.include({ Entity: 'Gadget', Operation: 'Create', IDs: [ pGadget.Body.IDGadget ], Tenants: [ '*' ], Owners: null, KeyImages: {} });
														return fDone();
													});
											});
									});
							});
					});
			}
		);
		// ================================================================ over HTTP: PostgreSQL (gated)
		(POSTGRES.Available ? suite : suite.skip)
		(
			`Interim intake over HTTP on PostgreSQL: driver types never pollute the column diff${POSTGRES.Available ? '' : ` (skipped: ${POSTGRES.Reason})`}`,
			() =>
			{
				let H = null;
				let I = null;
				let tmpEvents = [];
				let LEAD = { Tenant: 1, User: 1 };

				let fWrite = (pMethod, pPath, pBody, fCallback) =>
				{
					let tmpFrom = tmpEvents.length;
					H.request(pMethod, pPath, pBody, LEAD,
						(pError, pResponse) =>
						{
							Expect(pError).to.not.exist;
							return fCallback(pResponse, tmpEvents.slice(tmpFrom));
						});
				};
				let fRow = (pSQL, fCallback) =>
				{
					H.connection.pool.query(pSQL, [], (pError, pResult) => { setImmediate(() => { Expect(pError).to.not.exist; return fCallback(pResult.rows[0]); }); });
				};

				suiteSetup(
					(fDone) =>
					{
						H = libHarness.start({ Port: PORT, Fixture: 'ProjectTrack', Provider: 'PostgreSQL', Faceting: { ChangeCapture: { Intake: 'Interim', NotifySettleMS: 0 } } },
							(pError) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								I = H.fable.RetoldFacetingChangeIntake;
								Expect(I.install().Source).to.equal('Interim');
								I.subscribe('Recorder', (pEvent) => { tmpEvents.push(pEvent); });
								return fDone();
							});
					});
				suiteTeardown((fDone) => { H.stop(fDone); });

				test('Update: timestamps (Date objects) and other unchanged columns stay out of the diff; a changed date is in it',
					(fDone) =>
					{
						fRow('SELECT "IDDocument", "Status" FROM "Document" WHERE "IDCustomer" = 1 AND "Deleted" = 0 AND "Status" <> \'Final\' ORDER BY "IDDocument" LIMIT 1',
							(pRow) =>
							{
								fWrite('PUT', '/1.0/Document', { IDDocument: pRow.IDDocument, Status: 'Final' },
									(pStatus, pStatusEvents) =>
									{
										Expect(pStatus.Status).to.equal(200);
										Expect(pStatusEvents.length).to.equal(1);
										Expect(facts(pStatusEvents[0])).to.deep.include(
											{ Entity: 'Document', Operation: 'Update', IDs: [ pRow.IDDocument ], Tenants: [ 1 ], ChangedColumns: [ 'Status', 'UpdateDate', 'UpdatingIDUser' ], KeyImages: { [String(pRow.IDDocument)]: { B: { IDCustomer: 1 }, A: { IDCustomer: 1 } } } });
										fWrite('PUT', `/1.0/Document/${pRow.IDDocument}`, { DocumentDate: '2026-03-15T00:00:00.000Z', Status: pRow.Status },
											(pDate, pDateEvents) =>
											{
												Expect(pDate.Status).to.equal(200);
												Expect(facts(pDateEvents[0]).ChangedColumns).to.deep.equal([ 'DocumentDate', 'Status', 'UpdateDate', 'UpdatingIDUser' ]);
												return fDone();
											});
									});
							});
					});

				test('Create, Delete and Undelete: one event each with numeric ids and the row\'s tenant',
					(fDone) =>
					{
						fWrite('POST', '/1.0/Document', { Title: 'PG intake', Status: 'Draft', IDFormType: 4, IDProject: 1, IDCustomer: 2 },
							(pCreate, pCreateEvents) =>
							{
								Expect(pCreate.Status).to.equal(200);
								let tmpID = pCreate.Body.IDDocument;
								Expect(facts(pCreateEvents[0])).to.deep.include({ Operation: 'Create', IDs: [ Number(tmpID) ], Tenants: [ 2 ] });
								fWrite('DELETE', `/1.0/Document/${tmpID}`, null,
									(pDelete, pDeleteEvents) =>
									{
										Expect(pDelete.Status).to.equal(200);
										Expect(facts(pDeleteEvents[0])).to.deep.include({ Operation: 'Delete', IDs: [ Number(tmpID) ], Tenants: [ 2 ] });
										fWrite('GET', `/1.0/Document/Undelete/${tmpID}`, null,
											(pUndelete, pUndeleteEvents) =>
											{
												Expect(pUndelete.Status).to.equal(200);
												Expect(pUndeleteEvents.length).to.equal(1);
												Expect(facts(pUndeleteEvents[0])).to.deep.include({ Operation: 'Undelete', IDs: [ Number(tmpID) ], Tenants: [ 2 ] });
												return fDone();
											});
									});
							});
					});
			}
		);
	}
);
