/**
 * Facet-Generations: the generation table, key grammar, bumps, GenVector and eviction floors.
 *
 * Owner: builder A (M4).  Obligations: internal-contracts §41, §49.1.  Registry port: 19130 (only if it
 * boots a server — it does not: a tiny host over a hand-built model drives every scope kind).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libBuilders = require('./support/Facet-Test-Builders.js');
const libGenerations = require('../source/cache/Retold-Faceting-Generations.js');
const libHostBase = require('../source/host/Retold-Faceting-Host-Base.js');

// ---------------------------------------------------------------------------------- a tiny host

const columns = (pNames) => { return pNames.map((pName) => { return { Column: pName }; }); };

// Every scope kind of internal-contracts §41.2 over one model:
//   Project      Tenant    (policy column IDCustomer; IDRegion is a Required column)
//   LabForm      Personal  (tenant + PersonalScopes OwnerIDUser)
//   Note         Personal  without a tenant column ('#none')
//   FormType     Global    (Excluded)
//   Region       Global    (no tenant column)
const TINY_MODEL = (
	{
		Tables:
			{
				Project: { Columns: columns([ 'IDProject', 'IDCustomer', 'IDRegion', 'Name', 'Status', 'Title', 'UpdateDate', 'UpdatingIDUser', 'Deleted' ]) },
				LabForm: { Columns: columns([ 'IDLabForm', 'IDCustomer', 'OwnerIDUser', 'Status', 'CompletedDate', 'Deleted' ]) },
				Note: { Columns: columns([ 'IDNote', 'OwnerIDUser', 'Body', 'Deleted' ]) },
				FormType: { Columns: columns([ 'IDFormType', 'IDCustomer', 'Name' ]) },
				Region: { Columns: columns([ 'IDRegion', 'Name' ]) }
			}
	});

const TINY_SCOPE = (
	{
		Policy:
			{
				Column: 'IDCustomer',
				SessionField: 'CustomerID',
				Exclude: [ 'FormType' ],
				PersonalScopes:
					{
						LabForm: { Column: 'OwnerIDUser', SessionField: 'UserID' },
						Note: { Column: 'OwnerIDUser', SessionField: 'UserID' }
					}
			},
		Required: { Project: [ { Column: 'IDRegion', From: '$Scope.IDRegion' } ] }
	});

class TinyHost extends libHostBase
{
	getModelSync()
	{
		return TINY_MODEL;
	}

	getScopePolicy()
	{
		return this.buildScopePolicy(this.options.Scope, (pEntity, pColumn) => { return this.entityHasColumn(pEntity, pColumn); });
	}

	getDeleteColumn(pEntity)
	{
		return this.entityHasColumn(pEntity, 'Deleted') ? 'Deleted' : null;
	}

	getPrimaryKey(pEntity)
	{
		return `ID${pEntity}`;
	}
}

/**
 * A Generations service over the tiny host (pScope false: no policy, every entity Unscoped).
 *
 * @param {Record<string, any>} [pOptions] - extra RetoldFaceting options (Cache bounds, granularity)
 * @param {Record<string, any>|false} [pScope]
 * @return {libGenerations}
 */
const newGenerations = (pOptions, pScope) =>
{
	let tmpFable = libBuilders.newFable('RetoldFacetingGenerationsTest');
	let tmpOptions = Object.assign({}, pOptions || {});
	let tmpHost = new TinyHost(tmpFable, { Scope: (pScope === false) ? {} : (pScope || TINY_SCOPE) });
	tmpFable.RetoldFacetingService = { Host: tmpHost };
	return new libGenerations(tmpFable, tmpOptions);
};

/**
 * A ChangeEvent (internal-contracts §39.2) with defaults.
 *
 * @param {Record<string, any>} pFields
 * @return {Record<string, any>}
 */
let _Seq = 0;
const event = (pFields) =>
{
	_Seq++;
	return Object.assign(
		{
			ChangeID: `ch:${_Seq}`, Source: 'Interim', Entity: 'Project', Operation: 'Update', IDs: [ 1 ],
			Tenants: [ 7 ], Owners: null, ChangedColumns: null, KeyImages: {}, Filter: null,
			Actor: { PrincipalKey: null, UserID: 0, Verb: 'Update' }, Timestamp: Date.now(), Epoch: 'e:00000000', Seq: `e:00000000:${_Seq}`
		}, pFields);
};

/**
 * The sorted keys of a bump.
 *
 * @param {Record<string, any>} pBump
 * @return {Array<string>}
 */
const keysOf = (pBump) => { return pBump.Keys.slice().sort(); };

/**
 * Every GenKey of an entity over tenant keys × columns, sorted.
 *
 * @param {string} pEntity
 * @param {Array<string>} pTenantKeys
 * @param {Array<string>} pColumns
 * @return {Array<string>}
 */
const product = (pEntity, pTenantKeys, pColumns) =>
{
	let tmpKeys = [];
	pTenantKeys.forEach((pTenant) => { pColumns.forEach((pColumn) => { tmpKeys.push(`${pEntity}|${pTenant}|${pColumn}`); }); });
	return tmpKeys.sort();
};

const principal = (pTenant, pOwner) =>
{
	return { Kind: 'User', IDUser: pOwner, IDCustomer: pTenant, ScopeValues: { IDCustomer: pTenant, OwnerIDUser: pOwner, IDRegion: 3 }, RoleSetHash: '' };
};

suite
(
	'Facet-Generations',
	() =>
	{
		suite
		(
			'Key grammar (internal-contracts §41.1)',
			() =>
			{
				test('tenantKey / genKey / encodePart: unknown → *, owners, #none, Part/*, encoding never collides with the markers',
					() =>
					{
						Expect(libGenerations.tenantKey(7)).to.equal('7');
						Expect(libGenerations.tenantKey('7')).to.equal('7');
						Expect(libGenerations.tenantKey(' 07 ')).to.equal('7');
						Expect(libGenerations.tenantKey(true)).to.equal('1');
						Expect(libGenerations.tenantKey('acme')).to.equal('acme');
						// Unknown tenants: '*', null, undefined, unset values.
						[ '*', null, undefined, 0, '0', '', '  ', NaN, false ].forEach((pUnset) => { Expect(libGenerations.tenantKey(pUnset), String(pUnset)).to.equal('*'); });
						Expect(libGenerations.tenantKey(-1, undefined, [ -1 ])).to.equal('*');
						// Owners.
						Expect(libGenerations.tenantKey(7, 42)).to.equal('7/42');
						Expect(libGenerations.tenantKey(7, '42')).to.equal('7/42');
						Expect(libGenerations.tenantKey(7, '*')).to.equal('7/*');
						Expect(libGenerations.tenantKey(7, null)).to.equal('7/*');
						Expect(libGenerations.tenantKey(7, 0)).to.equal('7/*');
						Expect(libGenerations.tenantKey('*', 42)).to.equal('*');
						Expect(libGenerations.tenantKey(null, 42)).to.equal('*');
						Expect(libGenerations.tenantKey('#none')).to.equal('#none');
						Expect(libGenerations.tenantKey('#none', 42)).to.equal('#none/42');
						Expect(libGenerations.tenantKey('#none', null)).to.equal('#none/*');
						// Encoding: '*', '#', '/', '|' never appear raw inside a Part or an Owner.
						Expect(libGenerations.tenantKey('a/b*|c')).to.equal('a%2Fb%2A%7Cc');
						Expect(libGenerations.tenantKey('#any')).to.equal('%23any');
						Expect(libGenerations.tenantKey('#none ')).to.equal('%23none');
						Expect(libGenerations.tenantKey('**')).to.equal('%2A%2A');
						Expect(libGenerations.tenantKey(7, '*/x')).to.equal('7/%2A%2Fx');
						Expect(libGenerations.encodePart('a b')).to.equal('a%20b');
						Expect(libGenerations.genKey('Project', '7', '#row')).to.equal('Project|7|#row');
						Expect(libGenerations.genKey('Project', '#any', 'Status')).to.equal('Project|#any|Status');
						Expect(libGenerations.floorKeyOf('Project|7/42|Status')).to.equal('Project|7/42');
						Expect(libGenerations.floorKeyOf('Project|7|odd|column')).to.equal('Project|7');
						Expect(libGenerations.floorKeyOf('broken')).to.equal(null);
						Expect([ libGenerations.ROW, libGenerations.ALL, libGenerations.COLS, libGenerations.GLOBAL, libGenerations.ANY, libGenerations.NO_TENANT ])
							.to.deep.equal([ '#row', '#all', '#cols', '*', '#any', '#none' ]);
					});

				test('the instance tenantKey honours Scope.UnsetValues; the service constructs empty with a boot epoch',
					() =>
					{
						let tmpGenerations = newGenerations({ Scope: { UnsetValues: [ 0, '', null, 'nobody' ] } });
						Expect(tmpGenerations.tenantKey('nobody')).to.equal('*');
						Expect(tmpGenerations.tenantKey(7, 'nobody')).to.equal('7/*');
						Expect(tmpGenerations.BootEpoch).to.match(/^g:[0-9a-f]{8}$/);
						Expect(newGenerations().BootEpoch).to.not.equal(tmpGenerations.BootEpoch);
						Expect(tmpGenerations.stats()).to.deep.equal(
							{
								Keys: 0, Groups: 0, PinnedKeys: 0, Floors: 0, EntityFloors: 0, GlobalFloor: 0, GlobalTick: 0, Bumps: 0, Evictions: 0,
								GroupEvictions: 0, FloorRaises: 0, EntityFloorRaises: 0, ApplyErrors: 0, MaxKeys: 200000, ApproxBytes: 0
							});
						Expect(tmpGenerations.GlobalTick).to.equal(0);
					});

				test('scopeColumns: the host\'s entityScopeColumns, or Unscoped without a host',
					() =>
					{
						let tmpGenerations = newGenerations();
						Expect(tmpGenerations.scopeColumns('Project')).to.deep.include({ Kind: 'Tenant', TenantColumn: 'IDCustomer', OwnerColumn: null });
						Expect(tmpGenerations.scopeColumns('Project').RowColumns).to.deep.equal([ 'Deleted', 'IDCustomer', 'IDProject', 'IDRegion' ]);
						Expect(tmpGenerations.scopeColumns('LabForm').Kind).to.equal('Personal');
						Expect(tmpGenerations.scopeColumns('Note')).to.deep.include({ Kind: 'Personal', TenantColumn: null, OwnerColumn: 'OwnerIDUser' });
						Expect(tmpGenerations.scopeColumns('FormType').Kind).to.equal('Global');
						Expect(tmpGenerations.scopeColumns('Region').Kind).to.equal('Global');
						let tmpBare = new libGenerations(libBuilders.newFable('RetoldFacetingGenerationsBare'));
						Expect(tmpBare.scopeColumns('Project')).to.deep.include({ Kind: 'Unscoped', RowColumns: [] });
					});
			}
		);

		suite
		(
			'applyChange: Operation × Kind (internal-contracts §41.2, §41.3)',
			() =>
			{
				test('Tenant: Create / Delete / Undelete bump #row on the tenant and #any',
					() =>
					{
						[ 'Create', 'Delete', 'Undelete' ].forEach(
							(pOperation) =>
							{
								let tmpGenerations = newGenerations();
								let tmpBump = tmpGenerations.applyChange(event({ Operation: pOperation, Tenants: [ 7 ] }));
								Expect(keysOf(tmpBump), pOperation).to.deep.equal(product('Project', [ '#any', '7' ], [ '#row' ]));
								Expect(tmpBump).to.deep.include({ Entity: 'Project', Tick: 1, Operation: pOperation, Source: 'Interim' });
								Expect(tmpBump.TenantKeys).to.deep.equal([ '#any', '7' ]);
								Expect(tmpBump.Columns).to.deep.equal([ '#row' ]);
								Expect(tmpBump.Seq).to.match(/^e:00000000:\d+$/);
							});
					});

				test('Tenant: Update with a column list bumps each column (column precision) plus #cols; never another tenant',
					() =>
					{
						let tmpGenerations = newGenerations();
						let tmpBump = tmpGenerations.applyChange(event({ Operation: 'Update', Tenants: [ 7 ], ChangedColumns: [ 'Status', 'UpdateDate', 'UpdatingIDUser' ] }));
						Expect(keysOf(tmpBump)).to.deep.equal(product('Project', [ '#any', '7' ], [ '#cols', 'Status', 'UpdateDate', 'UpdatingIDUser' ]));
						Expect(tmpBump.Keys.some((pKey) => { return pKey.indexOf('|8|') >= 0 || pKey.indexOf('|*|') >= 0; })).to.equal(false);
						// Touch is a column change too.
						let tmpTouch = tmpGenerations.applyChange(event({ Operation: 'Touch', Tenants: [ 7 ], ChangedColumns: [ 'Title' ] }));
						Expect(keysOf(tmpTouch)).to.deep.equal(product('Project', [ '#any', '7' ], [ '#cols', 'Title' ]));
					});

				test('Tenant: a delete / tenant / identity / Required column change bumps #row; a move bumps the old and the new tenant',
					() =>
					{
						let tmpGenerations = newGenerations();
						[ 'Deleted', 'IDCustomer', 'IDProject', 'IDRegion' ].forEach(
							(pColumn) =>
							{
								let tmpBump = tmpGenerations.applyChange(event({ Operation: 'Update', Tenants: [ 7 ], ChangedColumns: [ pColumn, 'UpdateDate' ] }));
								Expect(tmpBump.Columns, pColumn).to.deep.equal([ '#cols', '#row', 'UpdateDate' ]);
							});
						let tmpMove = tmpGenerations.applyChange(event({ Operation: 'Update', Tenants: [ 7, 8 ], ChangedColumns: [ 'IDCustomer', 'UpdateDate' ] }));
						Expect(tmpMove.TenantKeys).to.deep.equal([ '#any', '7', '8' ]);
						Expect(keysOf(tmpMove)).to.deep.equal(product('Project', [ '#any', '7', '8' ], [ '#cols', '#row', 'UpdateDate' ]));
					});

				test('Tenant: unknown columns → #all; unknown tenant ("*", empty, missing) → "*"',
					() =>
					{
						let tmpGenerations = newGenerations();
						Expect(keysOf(tmpGenerations.applyChange(event({ Operation: 'Update', Tenants: [ 7 ], ChangedColumns: null })))).to.deep.equal(product('Project', [ '#any', '7' ], [ '#all' ]));
						Expect(keysOf(tmpGenerations.applyChange(event({ Operation: 'Touch', Tenants: [ 7 ], ChangedColumns: undefined })))).to.deep.equal(product('Project', [ '#any', '7' ], [ '#all' ]));
						Expect(tmpGenerations.applyChange(event({ Operation: 'Update', Tenants: [ 7, '*' ], ChangedColumns: [ 'Status' ] })).TenantKeys).to.deep.equal([ '#any', '*', '7' ]);
						Expect(tmpGenerations.applyChange(event({ Operation: 'Create', Tenants: [] })).TenantKeys).to.deep.equal([ '#any', '*' ]);
						Expect(tmpGenerations.applyChange(event({ Operation: 'Create', Tenants: undefined })).TenantKeys).to.deep.equal([ '#any', '*' ]);
						Expect(tmpGenerations.applyChange(event({ Operation: 'Create', Tenants: [ 0 ] })).TenantKeys).to.deep.equal([ '#any', '*' ]);
						Expect(tmpGenerations.applyChange(event({ Operation: 'Create', Tenants: [ '#none' ] })).TenantKeys, 'a #none marker on a tenant entity is unknown').to.deep.equal([ '#any', '*' ]);
						// Bad column entries are skipped, the list still counts as known.
						Expect(tmpGenerations.applyChange(event({ Operation: 'Update', Tenants: [ 7 ], ChangedColumns: [ 'Status', null, 4, '' ] })).Columns).to.deep.equal([ '#cols', 'Status' ]);
					});

				test('EntityDirty (notifyByFilter) and any other operation bump #all on the given tenants',
					() =>
					{
						let tmpGenerations = newGenerations();
						Expect(keysOf(tmpGenerations.applyChange(event({ Operation: 'EntityDirty', IDs: [], Tenants: [ '*' ], Filter: 'FBV~Status~EQ~Open' })))).to.deep.equal(product('Project', [ '#any', '*' ], [ '#all' ]));
						Expect(keysOf(tmpGenerations.applyChange(event({ Operation: 'EntityDirty', IDs: [], Tenants: [ 7 ] })))).to.deep.equal(product('Project', [ '#any', '7' ], [ '#all' ]));
						Expect(tmpGenerations.applyChange(event({ Operation: 'Mystery', Tenants: [ 7 ], ChangedColumns: [ 'Status' ] })).Columns).to.deep.equal([ '#all' ]);
					});

				test('Global (an Excluded lookup, an entity without the tenant column) and Unscoped: every write bumps "*" and #any',
					() =>
					{
						let tmpGenerations = newGenerations();
						Expect(keysOf(tmpGenerations.applyChange(event({ Entity: 'FormType', Operation: 'Update', Tenants: [ 7 ], ChangedColumns: [ 'Name' ] }))))
							.to.deep.equal(product('FormType', [ '#any', '*' ], [ '#cols', 'Name' ]));
						Expect(keysOf(tmpGenerations.applyChange(event({ Entity: 'Region', Operation: 'Create', Tenants: [ '*' ] }))))
							.to.deep.equal(product('Region', [ '#any', '*' ], [ '#row' ]));
						let tmpUnscoped = newGenerations({}, false);
						Expect(tmpUnscoped.scopeColumns('Project').Kind).to.equal('Unscoped');
						Expect(keysOf(tmpUnscoped.applyChange(event({ Entity: 'Project', Operation: 'Update', Tenants: [ 7 ], ChangedColumns: [ 'Status' ] }))))
							.to.deep.equal(product('Project', [ '#any', '*' ], [ '#cols', 'Status' ]));
					});

				test('Personal: owner-qualified keys plus the tenant-wide key; unknown owners → Part/*; both owners on a move',
					() =>
					{
						let tmpGenerations = newGenerations();
						let tmpCreate = tmpGenerations.applyChange(event({ Entity: 'LabForm', Operation: 'Create', Tenants: [ 7 ], Owners: [ { Tenant: 7, Owner: 42 } ] }));
						Expect(tmpCreate.TenantKeys).to.deep.equal([ '#any', '7', '7/42' ]);
						Expect(keysOf(tmpCreate)).to.deep.equal(product('LabForm', [ '#any', '7', '7/42' ], [ '#row' ]));

						let tmpUnknownOwner = tmpGenerations.applyChange(event({ Entity: 'LabForm', Operation: 'Update', Tenants: [ 7 ], Owners: [ { Tenant: 7, Owner: '*' } ], ChangedColumns: [ 'Status' ] }));
						Expect(tmpUnknownOwner.TenantKeys).to.deep.equal([ '#any', '7', '7/*' ]);
						Expect(tmpUnknownOwner.Columns).to.deep.equal([ '#cols', 'Status' ]);

						let tmpNoOwners = tmpGenerations.applyChange(event({ Entity: 'LabForm', Operation: 'Update', Tenants: [ 7, 8 ], Owners: null, ChangedColumns: [ 'Status' ] }));
						Expect(tmpNoOwners.TenantKeys, 'Owners null → Part/* for each known tenant').to.deep.equal([ '#any', '7', '7/*', '8', '8/*' ]);
						Expect(tmpGenerations.applyChange(event({ Entity: 'LabForm', Operation: 'Delete', Tenants: [ 7 ], Owners: [] })).TenantKeys).to.deep.equal([ '#any', '7', '7/*' ]);

						let tmpMove = tmpGenerations.applyChange(event({ Entity: 'LabForm', Operation: 'Update', Tenants: [ 7 ], Owners: [ { Tenant: 7, Owner: 42 }, { Tenant: 7, Owner: 43 } ], ChangedColumns: [ 'OwnerIDUser', 'UpdateDate' ] }));
						Expect(tmpMove.TenantKeys).to.deep.equal([ '#any', '7', '7/42', '7/43' ]);
						Expect(tmpMove.Columns, 'the owner column is a row column').to.deep.equal([ '#cols', '#row', 'UpdateDate' ]);

						let tmpTenantMove = tmpGenerations.applyChange(event({ Entity: 'LabForm', Operation: 'Update', Tenants: [ 7, 8 ], Owners: [ { Tenant: 7, Owner: 42 }, { Tenant: 8, Owner: 42 } ], ChangedColumns: [ 'IDCustomer' ] }));
						Expect(tmpTenantMove.TenantKeys).to.deep.equal([ '#any', '7', '7/42', '8', '8/42' ]);

						// An unknown tenant cannot qualify an owner: '*' covers it (every fold reads '*').
						let tmpUnknownTenant = tmpGenerations.applyChange(event({ Entity: 'LabForm', Operation: 'Update', Tenants: [ '*' ], Owners: [ { Tenant: '*', Owner: 42 } ], ChangedColumns: [ 'Status' ] }));
						Expect(tmpUnknownTenant.TenantKeys).to.deep.equal([ '#any', '*' ]);
						// A pair whose tenant is missing from Tenants still bumps that tenant's wide key.
						Expect(tmpGenerations.applyChange(event({ Entity: 'LabForm', Operation: 'Create', Tenants: [ 7 ], Owners: [ { Tenant: 9, Owner: 5 } ] })).TenantKeys).to.deep.equal([ '#any', '7', '9', '9/5' ]);
						// A malformed pair degrades to Part/* for every known tenant.
						Expect(tmpGenerations.applyChange(event({ Entity: 'LabForm', Operation: 'Create', Tenants: [ 7 ], Owners: [ null ] })).TenantKeys).to.deep.equal([ '#any', '7', '7/*' ]);
					});

				test('Personal without a tenant column: Part is #none',
					() =>
					{
						let tmpGenerations = newGenerations();
						let tmpBump = tmpGenerations.applyChange(event({ Entity: 'Note', Operation: 'Create', Tenants: [ '*' ], Owners: [ { Tenant: '#none', Owner: 42 } ] }));
						Expect(tmpBump.TenantKeys).to.deep.equal([ '#any', '#none', '#none/42' ]);
						Expect(tmpGenerations.applyChange(event({ Entity: 'Note', Operation: 'Update', Tenants: [ '*' ], Owners: null, ChangedColumns: [ 'Body' ] })).TenantKeys).to.deep.equal([ '#any', '#none', '#none/*' ]);
					});

				test('granularity Entity: every column bump but #row becomes #all',
					() =>
					{
						let tmpGenerations = newGenerations({ Cache: { GenerationGranularity: 'Entity' } });
						Expect(tmpGenerations.applyChange(event({ Operation: 'Update', Tenants: [ 7 ], ChangedColumns: [ 'Status', 'UpdateDate' ] })).Columns).to.deep.equal([ '#all' ]);
						Expect(tmpGenerations.applyChange(event({ Operation: 'Update', Tenants: [ 7 ], ChangedColumns: [ 'IDCustomer', 'Status' ] })).Columns).to.deep.equal([ '#all', '#row' ]);
						Expect(tmpGenerations.applyChange(event({ Operation: 'Create', Tenants: [ 7 ] })).Columns).to.deep.equal([ '#row' ]);
						Expect(tmpGenerations.applyChange(event({ Operation: 'Update', Tenants: [ 7 ], ChangedColumns: null })).Columns).to.deep.equal([ '#all' ]);
					});

				test('one tick per event, stamped on every key of the bump; invalid events bump nothing and never throw',
					() =>
					{
						let tmpGenerations = newGenerations();
						let tmpBefore = Date.now();
						let tmpFirst = tmpGenerations.applyChange(event({ Operation: 'Update', Tenants: [ 7, 8 ], ChangedColumns: [ 'Status', 'Title' ] }));
						Expect(tmpFirst.Tick).to.equal(1);
						Expect(tmpFirst.At).to.be.at.least(tmpBefore);
						tmpFirst.Keys.forEach((pKey) => { Expect(tmpGenerations.read(pKey)).to.deep.equal({ Tick: 1, At: tmpFirst.At }); });
						let tmpSecond = tmpGenerations.applyChange(event({ Operation: 'Create', Tenants: [ 7 ] }));
						Expect(tmpSecond.Tick).to.equal(2);
						Expect(tmpGenerations.GlobalTick).to.equal(2);
						Expect(tmpGenerations.stats()).to.include({ Bumps: 2, GlobalTick: 2, Keys: tmpFirst.Keys.length + tmpSecond.Keys.length });
						// The bump is frozen.
						Expect(Object.isFrozen(tmpFirst)).to.equal(true);
						Expect(Object.isFrozen(tmpFirst.Keys)).to.equal(true);

						let tmpThrowing = new Proxy({}, { get: () => { throw new Error('boom'); } });
						[ null, undefined, 42, 'Project', {}, { Entity: '' }, { Entity: 7 }, tmpThrowing ].forEach(
							(pBad) =>
							{
								Expect(tmpGenerations.applyChange(pBad)).to.equal(null);
							});
						Expect(tmpGenerations.GlobalTick, 'nothing ticked').to.equal(2);
						Expect(tmpGenerations.stats().Bumps).to.equal(2);
					});

				test('bumpEntity bumps (E, "*", #all) and (E, #any, #all), visible to every fold of E',
					() =>
					{
						let tmpGenerations = newGenerations();
						let tmpDependencies = [ { Entity: 'Project', TenantKeys: tmpGenerations.foldTenantKeys(principal(7, 42), 'Project'), Columns: [ '#all', '#row', 'Status' ] } ];
						let tmpBefore = tmpGenerations.vector(tmpDependencies).Hash;
						let tmpBump = tmpGenerations.bumpEntity('Project', 'ModelReload');
						Expect(keysOf(tmpBump)).to.deep.equal([ 'Project|#any|#all', 'Project|*|#all' ]);
						Expect(tmpBump).to.deep.include({ Entity: 'Project', Tick: 1, Operation: 'EntityDirty', Reason: 'ModelReload' });
						Expect(tmpGenerations.vector(tmpDependencies).Hash).to.not.equal(tmpBefore);
						Expect(tmpGenerations.bumpEntity('')).to.equal(null);
						Expect(tmpGenerations.bumpEntity(null)).to.equal(null);
					});
			}
		);

		suite
		(
			'Reads: foldTenantKeys, principalTenantKeys (internal-contracts §41.2, §46.4)',
			() =>
			{
				test('foldTenantKeys per kind: Tenant, Personal (owner-qualified or tenant-wide under TenantOnly), Global, Unscoped, unset values',
					() =>
					{
						let tmpGenerations = newGenerations();
						let tmpTech = principal(7, 42);
						Expect(tmpGenerations.foldTenantKeys(tmpTech, 'Project')).to.deep.equal([ '*', '7' ]);
						Expect(tmpGenerations.foldTenantKeys(tmpTech, 'LabForm')).to.deep.equal([ '*', '7/*', '7/42' ]);
						Expect(tmpGenerations.foldTenantKeys(tmpTech, 'LabForm', true)).to.deep.equal([ '*', '7' ]);
						Expect(tmpGenerations.foldTenantKeys(tmpTech, 'Note')).to.deep.equal([ '#none/*', '#none/42', '*' ]);
						Expect(tmpGenerations.foldTenantKeys(tmpTech, 'Note', true)).to.deep.equal([ '#none', '*' ]);
						Expect(tmpGenerations.foldTenantKeys(tmpTech, 'FormType')).to.deep.equal([ '*' ]);
						Expect(tmpGenerations.foldTenantKeys(tmpTech, 'Region')).to.deep.equal([ '*' ]);
						// No captured tenant: '#any' (moved by every write of the entity).
						Expect(tmpGenerations.foldTenantKeys(principal(0, 42), 'Project')).to.deep.equal([ '#any', '*' ]);
						Expect(tmpGenerations.foldTenantKeys(principal(0, 42), 'LabForm')).to.deep.equal([ '#any', '*' ]);
						Expect(tmpGenerations.foldTenantKeys(null, 'Project')).to.deep.equal([ '#any', '*' ]);
						// No owner: tenant-wide.
						Expect(tmpGenerations.foldTenantKeys(principal(7, 0), 'LabForm')).to.deep.equal([ '*', '7' ]);
						Expect(newGenerations({}, false).foldTenantKeys(tmpTech, 'Project')).to.deep.equal([ '*' ]);
					});

				test('principalTenantKeys: Tenant → own key, Personal → own owner keys only, Global / Unscoped → "*", unset → []',
					() =>
					{
						let tmpGenerations = newGenerations();
						let tmpTech = principal(7, 42);
						Expect(tmpGenerations.principalTenantKeys(tmpTech, 'Project')).to.deep.equal([ '7' ]);
						Expect(tmpGenerations.principalTenantKeys(tmpTech, 'LabForm')).to.deep.equal([ '7/*', '7/42' ]);
						Expect(tmpGenerations.principalTenantKeys(tmpTech, 'Note')).to.deep.equal([ '#none/*', '#none/42' ]);
						Expect(tmpGenerations.principalTenantKeys(tmpTech, 'FormType')).to.deep.equal([ '*' ]);
						Expect(tmpGenerations.principalTenantKeys(principal(0, 42), 'Project')).to.deep.equal([]);
						Expect(tmpGenerations.principalTenantKeys(principal(7, 0), 'LabForm')).to.deep.equal([]);
						Expect(tmpGenerations.principalTenantKeys(null, 'LabForm')).to.deep.equal([]);
						Expect(newGenerations({}, false).principalTenantKeys(null, 'Project')).to.deep.equal([ '*' ]);
					});

				test('read: the table value (LRU-refreshed), else the floor with At null — nothing is inserted',
					() =>
					{
						let tmpGenerations = newGenerations();
						Expect(tmpGenerations.read('Project|7|Status')).to.deep.equal({ Tick: 0, At: null });
						Expect(tmpGenerations.read('garbage')).to.deep.equal({ Tick: 0, At: null });
						Expect(tmpGenerations.stats().Keys).to.equal(0);
					});
			}
		);

		suite
		(
			'GenVector (internal-contracts §41.5)',
			() =>
			{
				test('deterministic: same dependencies → same Hash, whatever the order; entries sorted and deduplicated',
					() =>
					{
						let tmpGenerations = newGenerations();
						tmpGenerations.applyChange(event({ Operation: 'Update', Tenants: [ 7 ], ChangedColumns: [ 'Status' ] }));
						let tmpA = [ { Entity: 'Project', TenantKeys: [ '7', '*' ], Columns: [ 'Status', '#row', '#all' ] }, { Entity: 'FormType', TenantKeys: [ '*' ], Columns: [ '#row', '#all', 'Name' ] } ];
						let tmpB = [ { Entity: 'FormType', TenantKeys: [ '*' ], Columns: [ 'Name', '#all', '#row' ] }, { Entity: 'Project', TenantKeys: [ '*', '7' ], Columns: [ '#all', 'Status', '#row', 'Status' ] } ];
						let tmpVectorA = tmpGenerations.vector(tmpA);
						let tmpVectorB = tmpGenerations.vector(tmpB);
						Expect(tmpVectorA.Hash).to.match(/^g:[0-9a-f]{16}$/);
						Expect(tmpVectorA).to.deep.equal(tmpVectorB);
						Expect(tmpVectorA.Entries.map((pEntry) => { return pEntry[0]; })).to.deep.equal(tmpVectorA.Entries.map((pEntry) => { return pEntry[0]; }).slice().sort());
						Expect(tmpVectorA.Entries.length).to.equal(9);
						Expect(tmpVectorA.Entries).to.deep.include([ 'Project|7|Status', 1 ]);
						Expect(tmpVectorA.MaxTick).to.equal(1);
						Expect(tmpGenerations.vector([]).MaxTick).to.equal(0);
						Expect(tmpGenerations.vector(null).Entries).to.deep.equal([]);
						// The boot epoch is part of the hash: another process never matches.
						Expect(newGenerations().vector(tmpA).Entries.map((pEntry) => { return pEntry[0]; })).to.deep.equal(tmpVectorA.Entries.map((pEntry) => { return pEntry[0]; }));
						Expect(newGenerations().vector([ { Entity: 'Project', TenantKeys: [ '7' ], Columns: [ '#row' ] } ]).Hash)
							.to.not.equal(newGenerations().vector([ { Entity: 'Project', TenantKeys: [ '7' ], Columns: [ '#row' ] } ]).Hash);
					});

				test('sensitivity: a bump inside the dependencies changes the hash; outside (another tenant, column, entity, owner, #any) it does not',
					() =>
					{
						let tmpGenerations = newGenerations();
						let tmpTech = principal(7, 42);
						let tmpDependencies =
							[
								{ Entity: 'Project', TenantKeys: tmpGenerations.foldTenantKeys(tmpTech, 'Project'), Columns: [ '#all', '#row', 'Status' ] },
								{ Entity: 'LabForm', TenantKeys: tmpGenerations.foldTenantKeys(tmpTech, 'LabForm'), Columns: [ '#all', '#row', 'Status' ] },
								{ Entity: 'FormType', TenantKeys: tmpGenerations.foldTenantKeys(tmpTech, 'FormType'), Columns: [ '#all', '#row', 'Name' ] }
							];
						let fHash = () => { return tmpGenerations.vector(tmpDependencies).Hash; };
						let tmpHash = fHash();
						let fUnchanged = (pEvent, pWhy) =>
						{
							tmpGenerations.applyChange(event(pEvent));
							Expect(fHash(), pWhy).to.equal(tmpHash);
						};
						let fChanged = (pEvent, pWhy) =>
						{
							tmpGenerations.applyChange(event(pEvent));
							let tmpNext = fHash();
							Expect(tmpNext, pWhy).to.not.equal(tmpHash);
							tmpHash = tmpNext;
						};
						fUnchanged({ Entity: 'Project', Operation: 'Update', Tenants: [ 8 ], ChangedColumns: [ 'Status' ] }, 'another tenant');
						fUnchanged({ Entity: 'Project', Operation: 'Create', Tenants: [ 8 ] }, 'another tenant\'s create');
						fUnchanged({ Entity: 'Project', Operation: 'Update', Tenants: [ 7 ], ChangedColumns: [ 'Title', 'UpdateDate' ] }, 'a column the fold does not read');
						fUnchanged({ Entity: 'Region', Operation: 'Update', Tenants: [ '*' ], ChangedColumns: [ 'Name' ] }, 'another entity');
						fUnchanged({ Entity: 'LabForm', Operation: 'Update', Tenants: [ 7 ], Owners: [ { Tenant: 7, Owner: 43 } ], ChangedColumns: [ 'Status' ] }, 'a colleague\'s private write');
						fUnchanged({ Entity: 'LabForm', Operation: 'Update', Tenants: [ 8 ], Owners: [ { Tenant: 8, Owner: 42 } ], ChangedColumns: [ 'Status' ] }, 'the same owner id in another tenant');
						fChanged({ Entity: 'Project', Operation: 'Update', Tenants: [ 7 ], ChangedColumns: [ 'Status' ] }, 'a column the fold reads');
						fChanged({ Entity: 'Project', Operation: 'Create', Tenants: [ 7 ] }, 'a row in the tenant');
						fChanged({ Entity: 'Project', Operation: 'Update', Tenants: [ 7 ], ChangedColumns: null }, 'unknown columns');
						fChanged({ Entity: 'Project', Operation: 'Update', Tenants: [ 8, 7 ], ChangedColumns: [ 'IDCustomer' ] }, 'a move into the tenant');
						fUnchanged({ Entity: 'Project', Operation: 'Update', Tenants: [ '*' ], ChangedColumns: [ 'Title' ] }, 'an unknown tenant, but a column the fold does not read');
						fChanged({ Entity: 'Project', Operation: 'Delete', Tenants: [ '*' ] }, 'an unknown tenant\'s delete');
						fChanged({ Entity: 'LabForm', Operation: 'Update', Tenants: [ 7 ], Owners: [ { Tenant: 7, Owner: 42 } ], ChangedColumns: [ 'Status' ] }, 'my own private write');
						fChanged({ Entity: 'LabForm', Operation: 'Update', Tenants: [ 7 ], Owners: [ { Tenant: 7, Owner: '*' } ], ChangedColumns: [ 'Status' ] }, 'an unknown owner in my tenant');
						fChanged({ Entity: 'FormType', Operation: 'Update', Tenants: [ 8 ], ChangedColumns: [ 'Name' ] }, 'a global lookup, whoever wrote it');
						fChanged({ Entity: 'Project', Operation: 'EntityDirty', IDs: [], Tenants: [ '*' ] }, 'notifyByFilter');
					});

				test('a TenantOnly fold reads the tenant-wide key: a colleague\'s private write does change it',
					() =>
					{
						let tmpGenerations = newGenerations();
						let tmpDependencies = [ { Entity: 'LabForm', TenantKeys: tmpGenerations.foldTenantKeys(principal(7, 42), 'LabForm', true), Columns: [ '#all', '#row', 'Status' ] } ];
						let tmpHash = tmpGenerations.vector(tmpDependencies).Hash;
						tmpGenerations.applyChange(event({ Entity: 'LabForm', Operation: 'Update', Tenants: [ 7 ], Owners: [ { Tenant: 7, Owner: 43 } ], ChangedColumns: [ 'Status' ] }));
						Expect(tmpGenerations.vector(tmpDependencies).Hash).to.not.equal(tmpHash);
						tmpHash = tmpGenerations.vector(tmpDependencies).Hash;
						tmpGenerations.applyChange(event({ Entity: 'LabForm', Operation: 'Update', Tenants: [ 8 ], Owners: [ { Tenant: 8, Owner: 43 } ], ChangedColumns: [ 'Status' ] }));
						Expect(tmpGenerations.vector(tmpDependencies).Hash, 'another tenant still never moves it').to.equal(tmpHash);
					});

				test('a fold with no captured tenant reads #any: every write of the entity moves it',
					() =>
					{
						let tmpGenerations = newGenerations();
						let tmpDependencies = [ { Entity: 'Project', TenantKeys: tmpGenerations.foldTenantKeys(principal(0, 0), 'Project'), Columns: [ '#all', '#row', 'Status' ] } ];
						let tmpHash = tmpGenerations.vector(tmpDependencies).Hash;
						tmpGenerations.applyChange(event({ Entity: 'Project', Operation: 'Update', Tenants: [ 8 ], ChangedColumns: [ 'Status' ] }));
						Expect(tmpGenerations.vector(tmpDependencies).Hash).to.not.equal(tmpHash);
					});
			}
		);

		suite
		(
			'Eviction floors (internal-contracts §41.6)',
			() =>
			{
				test('no ABA: an entry that saw an evicted key\'s last bump stays valid, an older one is invalid',
					() =>
					{
						let tmpGenerations = newGenerations({ Cache: { MaxGenerationKeys: 4 } });
						let tmpDependencies = [ { Entity: 'Project', TenantKeys: [ '7' ], Columns: [ 'Status' ] } ];
						let tmpBeforeBump = tmpGenerations.vector(tmpDependencies);
						let tmpBump = tmpGenerations.applyChange(event({ Entity: 'Project', Operation: 'Update', Tenants: [ 7 ], ChangedColumns: [ 'Status' ] }));
						let tmpAfterBump = tmpGenerations.vector(tmpDependencies);
						Expect(tmpAfterBump.Entries).to.deep.equal([ [ 'Project|7|Status', tmpBump.Tick ] ]);
						// Push the group out with other tenants' bumps (a global lookup's '*' / '#any' groups are
						// pinned and never press anything out).
						tmpGenerations.applyChange(event({ Entity: 'Region', Operation: 'Update', Tenants: [ '*' ], ChangedColumns: [ 'Name' ] }));
						for (let i = 0; i < 6; i++)
						{
							tmpGenerations.applyChange(event({ Entity: 'Project', Operation: 'Update', Tenants: [ 100 + i ], ChangedColumns: [ 'Name' ] }));
						}
						Expect(tmpGenerations._Groups.has('Project|7'), 'evicted (the whole (Entity, TenantKey) group)').to.equal(false);
						Expect(tmpGenerations._Pinned.has('Region|*'), 'the \'*\' and \'#any\' groups are pinned').to.equal(true);
						Expect(tmpGenerations.stats().Evictions).to.be.above(0);
						Expect(tmpGenerations.stats().Floors).to.be.at.least(1);
						Expect(tmpGenerations.read('Project|7|Status')).to.deep.equal({ Tick: tmpBump.Tick, At: null });
						Expect(tmpGenerations.vector(tmpDependencies).Hash, 'saw the last bump: still valid').to.equal(tmpAfterBump.Hash);
						Expect(tmpGenerations.vector(tmpDependencies).Hash, 'predates the bump: invalid').to.not.equal(tmpBeforeBump.Hash);
						// A sibling key of the same (Entity, TenantKey) evicted with a later tick raises the floor:
						// the key reads higher (invalidates more, never less).
						let tmpSibling = tmpGenerations.applyChange(event({ Entity: 'Project', Operation: 'Update', Tenants: [ 7 ], ChangedColumns: [ 'Title' ] }));
						for (let i = 0; i < 6; i++)
						{
							tmpGenerations.applyChange(event({ Entity: 'Project', Operation: 'Update', Tenants: [ 200 + i ], ChangedColumns: [ 'Name' ] }));
						}
						Expect(tmpGenerations.read('Project|7|Status').Tick).to.equal(tmpSibling.Tick);
						Expect(tmpGenerations.vector(tmpDependencies).Hash).to.not.equal(tmpAfterBump.Hash);
						Expect(tmpGenerations.stats().FloorRaises).to.be.at.least(2);
					});

				test('per-tenant isolation: one tenant\'s cache pressure never raises another tenant\'s floor',
					() =>
					{
						let tmpGenerations = newGenerations({ Cache: { MaxGenerationKeys: 3 } });
						let tmpTenant7 = [ { Entity: 'Project', TenantKeys: [ '7' ], Columns: [ 'Status', '#row', '#all' ] } ];
						let tmpHash7 = tmpGenerations.vector(tmpTenant7).Hash;
						for (let i = 0; i < 20; i++)
						{
							// A different tenant each time: tenant groups pile up and are evicted, whole.
							tmpGenerations.applyChange(event({ Entity: 'Project', Operation: 'Update', Tenants: [ 100 + i ], ChangedColumns: [ 'Status', 'Title' ] }));
						}
						Expect(tmpGenerations.stats().Evictions).to.be.above(10);
						Expect(tmpGenerations.read('Project|7|Status').Tick).to.equal(0);
						Expect(tmpGenerations.vector(tmpTenant7).Hash).to.equal(tmpHash7);
					});

				test('floor-map overflow folds into the ENTITY\'s floor (only invalidates more, never another entity), recency follows reads',
					() =>
					{
						let tmpGenerations = newGenerations({ Cache: { MaxGenerationKeys: 1, MaxGenerationFloors: 2 } });
						// Each bump writes a tenant group into a 1-key budget: the tenant groups are evicted and floors pile up.
						let tmpTicks = [];
						[ 1, 2, 3, 4 ].forEach((pTenant) => { tmpTicks.push(tmpGenerations.applyChange(event({ Entity: 'Project', Operation: 'Create', Tenants: [ pTenant ] })).Tick); });
						let tmpStats = tmpGenerations.stats();
						Expect(tmpStats.Floors).to.be.at.most(2);
						Expect(tmpStats.EntityFloors).to.equal(1);
						Expect(tmpStats.GlobalFloor, 'no global floor: overflow never moves another entity').to.equal(0);
						// A key whose floor was folded reads at least that floor (never back to 0) …
						Expect(tmpGenerations.read('Project|1|#row').Tick).to.be.at.least(tmpTicks[0]);
						// … but another entity's keys are untouched.
						Expect(tmpGenerations.read('Never|1|#row').Tick).to.equal(0);

						// Recency: a read refreshes a group, so the least recently used one is evicted.
						let tmpLRU = newGenerations({ Cache: { MaxGenerationKeys: 2 } });
						tmpLRU.applyChange(event({ Entity: 'Project', Operation: 'Create', Tenants: [ 7 ] }));    // Project|7|#row
						tmpLRU.applyChange(event({ Entity: 'Project', Operation: 'Create', Tenants: [ 8 ] }));    // Project|8|#row
						tmpLRU.read('Project|7|#row');
						tmpLRU.applyChange(event({ Entity: 'Project', Operation: 'Create', Tenants: [ 9 ] }));    // evicts Project|8 (least recently used)
						Expect(tmpLRU._Groups.has('Project|7')).to.equal(true);
						Expect(tmpLRU._Groups.has('Project|8')).to.equal(false);
						Expect(tmpLRU._Groups.has('Project|9')).to.equal(true);
					});

				test('churn on entity B never moves entity A\'s vectors, even after the floor map overflowed (pinned \'*\' / \'#any\', entity floors)',
					() =>
					{
						let tmpGenerations = newGenerations({ Cache: { MaxGenerationKeys: 40, MaxGenerationFloors: 5 } });
						tmpGenerations.applyChange(event({ Entity: 'Project', Operation: 'Update', Tenants: [ 1 ], ChangedColumns: [ 'Status' ] }));
						let tmpProject = [ { Entity: 'Project', TenantKeys: tmpGenerations.foldTenantKeys(principal(1, 42), 'Project'), Columns: [ 'Status', '#row', '#all' ] } ];
						let tmpHash = tmpGenerations.vector(tmpProject).Hash;
						for (let i = 0; i < 500; i++)
						{
							tmpGenerations.applyChange(event({ Entity: 'LabForm', Operation: 'Update', Tenants: [ 1000 + i ], Owners: [ { Tenant: 1000 + i, Owner: 1 } ], ChangedColumns: [ 'Status', 'CompletedDate' ] }));
						}
						let tmpStats = tmpGenerations.stats();
						Expect(tmpStats.GroupEvictions).to.be.above(100);
						Expect(tmpStats.EntityFloorRaises, 'the floor map overflowed').to.be.above(0);
						Expect(tmpGenerations.vector(tmpProject).Hash, 'another entity\'s churn').to.equal(tmpHash);
						// Even a tenant of the SAME entity whose idle group is evicted keeps its hash (while its floor
						// is kept) unless its own group's last bump is newer than every key it depends on.
						tmpGenerations = newGenerations({ Cache: { MaxGenerationKeys: 40, MaxGenerationFloors: 1000 } });
						let tmpMine = [ { Entity: 'Project', TenantKeys: tmpGenerations.foldTenantKeys(principal(5, 42), 'Project'), Columns: [ 'Status', '#row', '#all' ] } ];
						tmpGenerations.applyChange(event({ Entity: 'Project', Operation: 'Update', Tenants: [ 5 ], ChangedColumns: [ 'Status' ] }));
						let tmpMineHash = tmpGenerations.vector(tmpMine).Hash;
						for (let i = 0; i < 200; i++)
						{
							tmpGenerations.applyChange(event({ Entity: 'Project', Operation: 'Update', Tenants: [ 5000 + i ], ChangedColumns: [ 'Name' ] }));
						}
						Expect(tmpGenerations._Groups.has('Project|5'), 'tenant 5\'s idle group was evicted').to.equal(false);
						Expect(tmpGenerations.vector(tmpMine).Hash, 'its last bump is the newest key it reads: the hash holds').to.equal(tmpMineHash);
					});

				test('the hot path never re-inserts keys: 50k bumps of hot keys against a full 200k-key table stay fast (P3)',
					function ()
					{
						this.timeout(20000);
						let tmpGenerations = newGenerations({ Cache: { MaxGenerationKeys: 200000 } });
						// Fill: 100k tenant groups × 2 columns.
						for (let i = 0; i < 100000; i++)
						{
							tmpGenerations.applyChange(event({ Entity: 'Project', Operation: 'Update', Tenants: [ i + 1 ], ChangedColumns: [ 'Title' ] }));
						}
						Expect(tmpGenerations.stats().Keys).to.be.at.least(199000);
						let tmpStart = process.hrtime.bigint();
						for (let i = 0; i < 50000; i++)
						{
							tmpGenerations.applyChange(event({ Entity: 'Project', Operation: 'Update', Tenants: [ 7 ], ChangedColumns: [ 'Status' ] }));
						}
						let tmpBumpUS = Number(process.hrtime.bigint() - tmpStart) / 1000 / 50000;
						tmpStart = process.hrtime.bigint();
						let tmpDependencies = [ { Entity: 'Project', TenantKeys: [ '7', '*' ], Columns: [ 'Status', 'Title', '#row', '#all', '#cols' ] } ];
						for (let i = 0; i < 5000; i++)
						{
							tmpGenerations.vector(tmpDependencies);
						}
						let tmpVectorUS = Number(process.hrtime.bigint() - tmpStart) / 1000 / 5000;
						// Generous bounds (CI noise); the measured values are ~5 µs and ~20 µs.
						Expect(tmpBumpUS, `bump ${tmpBumpUS.toFixed(1)} µs`).to.be.below(100);
						Expect(tmpVectorUS, `vector ${tmpVectorUS.toFixed(1)} µs`).to.be.below(400);
					});

				test('\'Auto\' sizes the key budget from Cache.MaxBytes; stats report approximate bytes',
					() =>
					{
						Expect(newGenerations().stats().MaxKeys).to.equal(200000);
						Expect(newGenerations({ Cache: { MaxBytes: 8388608 } }).stats().MaxKeys).to.equal(Math.floor(8388608 / 320));
						Expect(newGenerations({ Cache: { MaxBytes: 1024 } }).stats().MaxKeys).to.equal(4096);
						Expect(newGenerations({ Cache: { MaxGenerationKeys: 77 } }).stats().MaxKeys).to.equal(77);
						let tmpGenerations = newGenerations();
						tmpGenerations.applyChange(event({ Entity: 'Project', Operation: 'Update', Tenants: [ 7 ], ChangedColumns: [ 'Status' ] }));
						Expect(tmpGenerations.stats().ApproxBytes).to.be.above(0);
					});

				test('fail closed: an event that breaks half way through still bumps its whole entity (\'*\' / \'#any\' on \'#all\')',
					() =>
					{
						let tmpGenerations = newGenerations();
						let tmpBroken = { Entity: 'Project', Operation: 'Update', ChangedColumns: [ 'Status' ] };
						Object.defineProperty(tmpBroken, 'Tenants', { enumerable: true, get: () => { throw new Error('half way'); } });
						let tmpDependencies = [ { Entity: 'Project', TenantKeys: tmpGenerations.foldTenantKeys(principal(7, 42), 'Project'), Columns: [ 'Status', '#row', '#all' ] } ];
						let tmpHash = tmpGenerations.vector(tmpDependencies).Hash;
						let tmpBump = tmpGenerations.applyChange(tmpBroken);
						Expect(tmpBump).to.include({ Entity: 'Project', Operation: 'EntityDirty', Reason: 'ApplyError' });
						Expect(tmpBump.Keys).to.deep.equal([ 'Project|#any|#all', 'Project|*|#all' ]);
						Expect(tmpGenerations.stats().ApplyErrors).to.equal(1);
						Expect(tmpGenerations.vector(tmpDependencies).Hash).to.not.equal(tmpHash);
					});

				test('clear(): the tick never goes backwards and no vector read before it matches one read after a later bump',
					() =>
					{
						let tmpGenerations = newGenerations();
						let tmpDependencies = [ { Entity: 'Project', TenantKeys: [ '7' ], Columns: [ 'Status' ] } ];
						let tmpBefore = tmpGenerations.vector(tmpDependencies).Hash;
						tmpGenerations.applyChange(event({ Entity: 'Project', Operation: 'Update', Tenants: [ 7 ], ChangedColumns: [ 'Status' ] }));
						tmpGenerations.clear();
						Expect(tmpGenerations.stats()).to.include({ Keys: 0, Floors: 0, GlobalTick: 1, GlobalFloor: 1 });
						Expect(tmpGenerations.vector(tmpDependencies).Hash, 'the pre-bump vector never comes back').to.not.equal(tmpBefore);
						Expect(tmpGenerations.applyChange(event({ Operation: 'Create', Tenants: [ 7 ] })).Tick).to.equal(2);
					});
			}
		);

		suite
		(
			'Bump listeners (internal-contracts §41.7)',
			() =>
			{
				test('listeners run synchronously in order, isolated by try/catch; replace / unsubscribe by name',
					() =>
					{
						let tmpGenerations = newGenerations();
						let tmpSeen = [];
						tmpGenerations.subscribe('First', () => { tmpSeen.push('First'); throw new Error('listener bug'); });
						tmpGenerations.subscribe('SSE', (pBump) => { tmpSeen.push(`SSE:${pBump.Entity}:${pBump.Tick}`); });
						tmpGenerations.subscribe('Bad', 'not a function');
						let tmpBump = tmpGenerations.applyChange(event({ Operation: 'Create', Tenants: [ 7 ] }));
						Expect(tmpBump).to.not.equal(null);
						Expect(tmpSeen).to.deep.equal([ 'First', 'SSE:Project:1' ]);
						tmpGenerations.subscribe('SSE', (pBump) => { tmpSeen.push(`SSE2:${pBump.Tick}`); });
						tmpGenerations.unsubscribe('First');
						tmpGenerations.bumpEntity('Project', 'Test');
						Expect(tmpSeen).to.deep.equal([ 'First', 'SSE:Project:1', 'SSE2:2' ]);
						tmpGenerations.unsubscribe('SSE');
						tmpGenerations.applyChange(event({ Operation: 'Create', Tenants: [ 7 ] }));
						Expect(tmpSeen.length).to.equal(3);
						// An invalid event reaches no listener.
						tmpGenerations.subscribe('Count', () => { tmpSeen.push('Count'); });
						tmpGenerations.applyChange({ Entity: '' });
						Expect(tmpSeen.length).to.equal(3);
					});
			}
		);
	}
);
