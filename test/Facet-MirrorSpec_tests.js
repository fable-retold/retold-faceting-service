/**
 * Facet-MirrorSpec (internal-contracts §55, §66.2; owner: builder A; port 19140 — no server: every
 * environment here is a Graph + Catalog + DefinitionRegistry over a domain model and a minimal host).
 *
 * Proves: the Materialize schema (built-in validator == ajv on fixtures and negative cases); every
 * compilation rule of §55.2 on the three domains (columns Auto / explicit / Include / Exclude, never
 * Sensitive / Text / long String / GUID, scope + delete + Join always, sort keys per Kind,
 * TrackedKeyColumns, KeymapColumns, SpecHash stable and sensitive to type / column / sort-key changes);
 * invalid entries disabled per entity with reasons, nothing partial; Unsupported warnings; covers()
 * (DepSet within the spec, a missing entity, a missing column, filling columns); ClosureIncomplete
 * warnings; the additive vs non-additive change classification of §55.4.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libOptions = require('../source/Retold-Faceting-Service-Options.js');
const libRetoldFacetingGraph = require('../source/catalog/Retold-Faceting-Graph.js');
const libRetoldFacetingCatalog = require('../source/catalog/Retold-Faceting-Catalog.js');
const libRetoldFacetingDefinitionRegistry = require('../source/catalog/Retold-Faceting-DefinitionRegistry.js');
const libRetoldFacetingClauseCompiler = require('../source/request/Retold-Faceting-ClauseCompiler.js');
const libRetoldFacetingHostBase = require('../source/host/Retold-Faceting-Host-Base.js');
const libRetoldFacetingMirrorSpec = require('../source/persistence/Retold-Faceting-MirrorSpec.js');
const libDDL = require('../source/store/clickhouse/ClickHouse-DDL.js');
const libTypeMap = require('../source/store/clickhouse/ClickHouse-TypeMap.js');

const libBuilders = require('./support/Facet-Test-Builders.js');
const libSupport = require('./support/Facet-ClickHouse-Support.js');
const libProjectTrackSeed = require('./fixtures/ProjectTrack-Seed.js');
const libLabTrackSeed = require('./fixtures/LabTrack-Seed.js');
const libBookstoreSeed = require('./fixtures/Bookstore-Seed.js');

const MATERIALIZE_SCHEMA = libRetoldFacetingMirrorSpec.MATERIALIZE_SCHEMA;

// ajv 6 (umbrella node_modules, test-only) cross-checks the built-in validator; skipped when absent.
const AJV_AVAILABLE = (() =>
{
	try
	{
		require.resolve('ajv');
		return true;
	}
	catch (pError)
	{
		return false;
	}
})();

let _AJV = null;

/**
 * @param {any} pValue
 * @param {string} [pRef]
 * @return {boolean}
 */
const ajvValid = (pValue, pRef) =>
{
	if (!_AJV)
	{
		const libAjv = require('ajv');
		_AJV = new libAjv({ allErrors: false });
		_AJV.addSchema(MATERIALIZE_SCHEMA);
	}
	return _AJV.validate({ $ref: MATERIALIZE_SCHEMA.$id + (pRef || '#') }, pValue);
};

/**
 * A minimal host over a model: the policy, entityScopeColumns, a DAL per table.
 */
class TinyHost extends libRetoldFacetingHostBase
{
	constructor(pFable, pOptions, pModel, pPolicy, pFacetable)
	{
		super(pFable, pOptions);
		this._Model = pModel;
		this._Policy = pPolicy;
		this._Facetable = pFacetable;
	}

	getModelSync()
	{
		return this._Model;
	}

	getScopePolicy()
	{
		return this._Policy;
	}

	getDeleteColumn(pEntity)
	{
		return this.entityHasColumn(pEntity, 'Deleted') ? 'Deleted' : null;
	}

	getPrimaryKey(pEntity)
	{
		let tmpTable = this.getEntityModel(pEntity);
		let tmpSchema = (tmpTable && tmpTable.MeadowSchema && Array.isArray(tmpTable.MeadowSchema.Schema)) ? tmpTable.MeadowSchema.Schema : [];
		let tmpIdentity = tmpSchema.find((pEntry) => { return pEntry && (pEntry.Type === 'AutoIdentity'); });
		return tmpIdentity ? tmpIdentity.Column : `ID${pEntity}`;
	}

	getDAL(pEntity)
	{
		return this.getEntityModel(pEntity) ? { Entity: pEntity } : null;
	}

	isFacetable(pEntity)
	{
		return this._Facetable(pEntity);
	}
}

/**
 * A Graph + Catalog + DefinitionRegistry (loaded with the domain's definitions) + MirrorSpec on one
 * fable for a domain model.
 *
 * @param {string} pFixture - 'ProjectTrack' | 'LabTrack' | 'Bookstore'
 * @param {{ Faceting?: Record<string, any>, Model?: Function, Definitions?: boolean }} [pOptions]
 * @return {Record<string, any>}
 */
const domainEnvironment = (pFixture, pOptions) =>
{
	let tmpOptionsIn = pOptions || {};
	let tmpSeedOptions = (pFixture === 'ProjectTrack') ? libProjectTrackSeed.FACETING_OPTIONS : (pFixture === 'LabTrack') ? libLabTrackSeed.FACETING_OPTIONS : {};
	let tmpOptions = libOptions.resolve(libOptions.deepMerge(tmpSeedOptions, tmpOptionsIn.Faceting || {}));
	let tmpFable = libBuilders.newFable('RetoldFacetingMirrorSpecTests');
	let tmpLogged = [];
	tmpFable.log.error = (pMessage) => { tmpLogged.push(String(pMessage)); };
	tmpFable.log.warn = (pMessage) => { tmpLogged.push(String(pMessage)); };
	let tmpModel = (pFixture === 'ProjectTrack') ? libProjectTrackSeed.model() : (pFixture === 'LabTrack') ? libLabTrackSeed.model() : libBookstoreSeed.model('Bookstore');
	if (typeof(tmpOptionsIn.Model) === 'function')
	{
		tmpOptionsIn.Model(tmpModel);
	}
	let fHasColumn = (pEntity, pColumn) =>
	{
		let tmpTable = tmpModel.Tables[pEntity];
		return !!tmpTable && tmpTable.Columns.some((pEntry) => { return pEntry.Column === pColumn; });
	};
	let tmpPolicy = new libRetoldFacetingHostBase(tmpFable, tmpOptions).buildScopePolicy(tmpOptions.Scope, fHasColumn);
	let tmpGlobal = tmpOptions.Catalog.GlobalEntities || [];
	let tmpHost = new TinyHost(tmpFable, tmpOptions, tmpModel, tmpPolicy,
		(pEntity) => { return (tmpPolicy.Kind !== 'Policy') || tmpPolicy.isScoped(pEntity) || (tmpGlobal.indexOf(pEntity) >= 0); });
	[
		[ 'RetoldFacetingGraph', libRetoldFacetingGraph ],
		[ 'RetoldFacetingCatalog', libRetoldFacetingCatalog ],
		[ 'RetoldFacetingClauseCompiler', libRetoldFacetingClauseCompiler ],
		[ 'RetoldFacetingDefinitionRegistry', libRetoldFacetingDefinitionRegistry ]
	].forEach(
		(pEntry) =>
		{
			tmpFable.addServiceType(pEntry[0], pEntry[1]);
			tmpFable.instantiateServiceProvider(pEntry[0], tmpOptions);
		});
	tmpFable.RetoldFacetingGraph.rebuild(tmpModel);
	tmpFable.RetoldFacetingCatalog.rebuild(tmpModel, tmpHost);
	if (tmpOptionsIn.Definitions !== false)
	{
		tmpFable.RetoldFacetingDefinitionRegistry.load(tmpOptions.Definitions, { Policy: tmpPolicy });
	}
	let tmpMirrorSpec = new libRetoldFacetingMirrorSpec(tmpFable, tmpOptions);
	let tmpEnvironment = { Catalog: tmpFable.RetoldFacetingCatalog, Host: tmpHost, Registry: tmpFable.RetoldFacetingDefinitionRegistry, Options: tmpOptions, Stores: [ 'ClickHouse' ] };
	return (
		{
			fable: tmpFable, options: tmpOptions, model: tmpModel, policy: tmpPolicy, host: tmpHost, logged: tmpLogged,
			catalog: tmpFable.RetoldFacetingCatalog, registry: tmpFable.RetoldFacetingDefinitionRegistry, mirrorSpec: tmpMirrorSpec, environment: tmpEnvironment,
			compile: (pMaterialize, pStores) => { return tmpMirrorSpec.compile(pMaterialize, Object.assign({}, tmpEnvironment, pStores ? { Stores: pStores } : {})); }
		});
};

/**
 * @param {Record<string, any>} pSpec
 * @return {Array<string>}
 */
const columnNames = (pSpec) =>
{
	return pSpec.Columns.map((pColumn) => { return pColumn.Column; });
};

/**
 * @param {Array<Record<string, any>>} pDisabled
 * @param {string} pEntity
 * @return {Record<string, any>|undefined}
 */
const disabledFor = (pDisabled, pEntity) =>
{
	return pDisabled.find((pEntry) => { return pEntry.Entity === pEntity; });
};

suite
(
	'Facet-MirrorSpec',
	() =>
	{
		test('the modules load and the ClickHouse gate answers',
			() =>
			{
				Expect(libRetoldFacetingMirrorSpec.serviceType).to.equal('RetoldFacetingMirrorSpec');
				Expect(new libRetoldFacetingMirrorSpec(libBuilders.newFable()).serviceType).to.equal('RetoldFacetingMirrorSpec');
				Expect(libSupport.available()).to.have.property('Available');
				Expect(libRetoldFacetingMirrorSpec.UNSUPPORTED_KEYS).to.deep.equal([ 'PathColumns', 'RelationFields', 'Rollups', 'Aggregates', 'Dictionary' ]);
				// Nothing compiled yet: no specs, nothing covered.
				let tmpEmpty = new libRetoldFacetingMirrorSpec(libBuilders.newFable());
				Expect(tmpEmpty.entities('ClickHouse')).to.deep.equal([]);
				Expect(tmpEmpty.spec('ClickHouse', 'Project')).to.equal(null);
				Expect(tmpEmpty.covers('ClickHouse', { Project: [ 'IDProject' ] })).to.deep.equal({ Covered: false, Reason: 'NotMirrored:Project' });
			});

		suite
		(
			'Materialize schema',
			() =>
			{
				const VALID = (
					[
						{},
						{ Document: { Store: [ 'ClickHouse' ] } },
						{ Document: { Store: [ 'ClickHouse' ], Columns: 'Auto', IncludeColumns: [ 'GUIDDocument' ], ExcludeColumns: [ 'Title' ], SortKey: 'Auto', Watermark: 'UpdateDate', Mutability: 'Mutable' } },
						{ Document: { Store: [ 'ClickHouse', 'Solr' ], Columns: [ 'Status' ], Watermark: false, Mutability: 'AppendOnly' } },
						{ Document: { Store: [ 'ClickHouse' ], PathColumns: { X: { Path: [ '>Document.IDProject' ] } }, RelationFields: {}, Rollups: {}, Aggregates: {}, Dictionary: true } },
						{ _Ok: { Store: [ 'OpenSearch' ] } }
					]);
				const INVALID = (
					[
						[],
						'Document',
						{ Document: {} },
						{ Document: { Store: [] } },
						{ Document: { Store: 'ClickHouse' } },
						{ Document: { Store: [ 'Postgres' ] } },
						{ Document: { Store: [ 'ClickHouse' ], Columns: 'All' } },
						{ Document: { Store: [ 'ClickHouse' ], Columns: [ 'bad-name' ] } },
						{ Document: { Store: [ 'ClickHouse' ], IncludeColumns: 'Title' } },
						{ Document: { Store: [ 'ClickHouse' ], SortKey: [ 'IDCustomer', 'IDDocument' ] } },
						{ Document: { Store: [ 'ClickHouse' ], Watermark: true } },
						{ Document: { Store: [ 'ClickHouse' ], Watermark: 'CreateDate' } },
						{ Document: { Store: [ 'ClickHouse' ], Mutability: 'Immutable' } },
						{ Document: { Store: [ 'ClickHouse' ], Dictionary: 'yes' } },
						{ Document: { Store: [ 'ClickHouse' ], Unknown: 1 } },
						{ 'Bad-Entity': { Store: [ 'ClickHouse' ] } },
						{ Document: null }
					]);

				test('the built-in validator accepts the valid fixtures and refuses the negative cases',
					() =>
					{
						VALID.forEach((pValue) => { Expect(libRetoldFacetingMirrorSpec.validateSchema(pValue), JSON.stringify(pValue)).to.equal(null); });
						INVALID.forEach((pValue) => { Expect(libRetoldFacetingMirrorSpec.validateSchema(pValue), JSON.stringify(pValue)).to.not.equal(null); });
						// Per entry, as compile applies it (the pointer names the entry).
						let tmpError = libRetoldFacetingMirrorSpec.validateSchema({ Store: [ 'ClickHouse' ], Columns: 'All' }, '#/definitions/EntityDeclaration', '/Document');
						Expect(tmpError.Pointer).to.match(/^\/Document/);
					});

				test('the built-in validator agrees with ajv on every fixture (cross-check)',
					function ()
					{
						if (!AJV_AVAILABLE)
						{
							this.skip();
						}
						VALID.concat(INVALID).forEach(
							(pValue) =>
							{
								Expect(libRetoldFacetingMirrorSpec.validateSchema(pValue) === null, JSON.stringify(pValue)).to.equal(ajvValid(pValue));
							});
						[ { Store: [ 'ClickHouse' ] }, { Store: [] }, { Store: [ 'ClickHouse' ], Watermark: false }, { Store: [ 'ClickHouse' ], Columns: [] } ].forEach(
							(pEntry) =>
							{
								Expect(libRetoldFacetingMirrorSpec.validateSchema(pEntry, '#/definitions/EntityDeclaration') === null, JSON.stringify(pEntry)).to.equal(ajvValid(pEntry, '#/definitions/EntityDeclaration'));
							});
					});
			}
		);

		suite
		(
			'compilation rules (§55.2)',
			() =>
			{
				test('LabTrack LabForm (Personal): the contract example — columns, roles, types, sort key, keymap, tracked keys',
					() =>
					{
						let tmpEnvironment = domainEnvironment('LabTrack');
						let tmpResult = tmpEnvironment.compile({ LabForm: { Store: [ 'ClickHouse' ] } });
						Expect(tmpResult.Disabled).to.deep.equal([]);
						let tmpSpec = tmpEnvironment.mirrorSpec.spec('ClickHouse', 'LabForm');
						Expect(tmpSpec).to.include({ Entity: 'LabForm', Store: 'ClickHouse', Identity: 'IDLabForm', Kind: 'Personal', TenantColumn: 'IDCustomer', OwnerColumn: 'OwnerIDUser', DeleteColumn: 'Deleted', Watermark: null });
						Expect(tmpSpec.SortKey).to.deep.equal([ 'IDCustomer', 'OwnerIDUser', 'IDLabForm' ]);
						Expect(columnNames(tmpSpec)).to.deep.equal([ 'IDLabForm', 'IDCustomer', 'OwnerIDUser', 'CreateDate', 'CreatingIDUser', 'UpdateDate', 'UpdatingIDUser', 'Deleted', 'DeleteDate', 'DeletingIDUser', 'IDMaterialIntake', 'IDLabFormType', 'Status', 'CompletedDate' ]);
						Expect(tmpSpec.Columns[0]).to.include({ Column: 'IDLabForm', DataType: 'ID', Mirror: 'Int64', Role: 'Identity' });
						Expect(tmpSpec.Columns[1]).to.include({ Column: 'IDCustomer', Mirror: 'Int64', Role: 'Tenant' });
						Expect(tmpSpec.Columns[2]).to.include({ Column: 'OwnerIDUser', Mirror: 'Nullable(Int64)', Role: 'Owner', Join: 'IDUser' });
						Expect(libTypeMap.specColumn(tmpSpec, 'Deleted')).to.include({ Mirror: 'Nullable(UInt8)', Role: 'Delete' });
						Expect(libTypeMap.specColumn(tmpSpec, 'UpdateDate')).to.include({ Mirror: "Nullable(DateTime64(3, 'UTC'))" });
						Expect(libTypeMap.specColumn(tmpSpec, 'IDMaterialIntake')).to.include({ Mirror: 'Nullable(Int64)', Role: 'FK', Join: 'IDMaterialIntake' });
						Expect(libTypeMap.specColumn(tmpSpec, 'Status')).to.include({ Mirror: 'Nullable(String)', Role: 'Column' });
						// GUIDs are never mirrored by 'Auto'.
						Expect(libTypeMap.specColumn(tmpSpec, 'GUIDLabForm')).to.equal(null);
						Expect(tmpSpec.TrackedKeyColumns).to.deep.equal([ 'IDCustomer', 'OwnerIDUser', 'IDMaterialIntake', 'IDLabFormType' ]);
						Expect(tmpSpec.KeymapColumns).to.deep.equal([ 'IDLabForm', 'IDCustomer', 'OwnerIDUser', 'IDMaterialIntake', 'IDLabFormType', 'UpdateDate' ]);
						Expect(tmpSpec.ColumnNames).to.deep.equal(columnNames(tmpSpec).slice().sort());
						Expect(tmpSpec.SourceColumns).to.deep.equal(columnNames(tmpSpec));
						Expect(tmpSpec.SpecHash).to.match(/^ms:[0-9a-f]{8}$/);
						Expect(tmpSpec.UnsetValues).to.deep.equal([ 0, '', null ]);
						Expect(tmpSpec.Warnings).to.deep.equal([ 'NoWatermark' ]);
						// A spec is frozen.
						Expect(Object.isFrozen(tmpSpec) && Object.isFrozen(tmpSpec.Columns[0])).to.equal(true);
						// And the DDL accepts it (the §56.2 example layout).
						Expect(libDDL.mirrorDDL('rfs_main', tmpSpec)).to.contain('ORDER BY (`IDCustomer`, `OwnerIDUser`, `IDLabForm`)');
						Expect(libDDL.keymapDDL('rfs_main', tmpSpec)).to.contain('ORDER BY (`IDLabForm`, `IDCustomer`, `OwnerIDUser`)');
					});

				test('sort keys per Kind: Tenant, Personal, Global, Unscoped, and a tenant column that is the identity',
					() =>
					{
						let tmpLab = domainEnvironment('LabTrack');
						tmpLab.compile(tmpLab.mirrorSpec.declareAll([ 'ClickHouse' ], tmpLab.environment));
						Expect(tmpLab.mirrorSpec.entities('ClickHouse')).to.deep.equal([ 'Customer', 'LabForm', 'LabFormType', 'LabQueue', 'LabQueueMember', 'MaterialIntake', 'MaterialIntakeRequirement', 'MaterialType', 'MaterialTypeFormRequirement', 'User' ]);
						Expect(tmpLab.mirrorSpec.spec('ClickHouse', 'MaterialIntake')).to.include({ Kind: 'Tenant' });
						Expect(tmpLab.mirrorSpec.spec('ClickHouse', 'MaterialIntake').SortKey).to.deep.equal([ 'IDCustomer', 'IDMaterialIntake' ]);
						Expect(tmpLab.mirrorSpec.spec('ClickHouse', 'LabFormType')).to.include({ Kind: 'Global', TenantColumn: null, DeleteColumn: null });
						Expect(tmpLab.mirrorSpec.spec('ClickHouse', 'LabFormType').SortKey).to.deep.equal([ 'IDLabFormType' ]);
						Expect(tmpLab.mirrorSpec.spec('ClickHouse', 'LabFormType').KeymapColumns).to.deep.equal([ 'IDLabFormType' ]);
						// Customer: the tenant column IS the identity — one sort-key column, still named as the tenant.
						Expect(tmpLab.mirrorSpec.spec('ClickHouse', 'Customer')).to.include({ Kind: 'Tenant', TenantColumn: 'IDCustomer', Identity: 'IDCustomer' });
						Expect(tmpLab.mirrorSpec.spec('ClickHouse', 'Customer').SortKey).to.deep.equal([ 'IDCustomer' ]);
						Expect(tmpLab.mirrorSpec.spec('ClickHouse', 'Customer').TrackedKeyColumns).to.deep.equal([]);
						Expect(libTypeMap.specColumn(tmpLab.mirrorSpec.spec('ClickHouse', 'Customer'), 'IDCustomer')).to.include({ Role: 'Identity', Mirror: 'Int64' });

						let tmpBook = domainEnvironment('Bookstore');
						tmpBook.compile(tmpBook.mirrorSpec.declareAll([ 'ClickHouse' ], tmpBook.environment));
						let tmpSale = tmpBook.mirrorSpec.spec('ClickHouse', 'BookStoreSale');
						Expect(tmpSale).to.include({ Kind: 'Unscoped', TenantColumn: null });
						Expect(tmpSale.SortKey).to.deep.equal([ 'IDBookStoreSale' ]);
						// The FK IDCustomer is an FK here (no policy), tracked, Nullable.
						Expect(libTypeMap.specColumn(tmpSale, 'IDCustomer')).to.include({ Role: 'FK', Mirror: 'Nullable(Int64)' });
						Expect(libTypeMap.specColumn(tmpSale, 'TotalAmount')).to.include({ Mirror: 'Nullable(Float64)', DataType: 'Decimal', Scale: 2 });
						Expect(libDDL.mirrorDDL('rfs_main', tmpSale)).to.not.contain('allow_nullable_key');

						let tmpProject = domainEnvironment('ProjectTrack');
						tmpProject.compile({ Project: { Store: [ 'ClickHouse' ] }, FormType: { Store: [ 'ClickHouse' ] } });
						Expect(tmpProject.mirrorSpec.spec('ClickHouse', 'Project').SortKey).to.deep.equal([ 'IDCustomer', 'IDProject' ]);
						// Project's OwnerIDUser is not a personal scope in ProjectTrack: an FK.
						Expect(libTypeMap.specColumn(tmpProject.mirrorSpec.spec('ClickHouse', 'Project'), 'OwnerIDUser')).to.include({ Role: 'FK' });
						Expect(tmpProject.mirrorSpec.spec('ClickHouse', 'FormType').Kind).to.equal('Global');
					});

				test('never Sensitive / Text / long String / GUID under Auto; IncludeColumns opts a GUID or a long String in; ExcludeColumns drops',
					() =>
					{
						let tmpBook = domainEnvironment('Bookstore');
						tmpBook.compile({ Customer: { Store: [ 'ClickHouse' ] }, Review: { Store: [ 'ClickHouse' ] }, User: { Store: [ 'ClickHouse' ] } });
						let tmpCustomer = tmpBook.mirrorSpec.spec('ClickHouse', 'Customer');
						// Text (Description) and Sensitive (ContactEmail, ContactPhone) never; GUIDCustomer never under Auto.
						[ 'Description', 'ContactEmail', 'ContactPhone', 'GUIDCustomer' ].forEach((pColumn) => { Expect(columnNames(tmpCustomer), pColumn).to.not.include(pColumn); });
						Expect(columnNames(tmpCustomer)).to.include.members([ 'IDCustomer', 'Name', 'ContactName', 'Active', 'Deleted', 'UpdateDate', 'CreateDate' ]);
						Expect(columnNames(tmpBook.mirrorSpec.spec('ClickHouse', 'Review'))).to.not.include('Text');
						// User.Password is Sensitive; GUIDUser (Numeric) is a GUID by name.
						Expect(columnNames(tmpBook.mirrorSpec.spec('ClickHouse', 'User'))).to.not.include.members([ 'Password', 'GUIDUser' ]);

						let tmpProject = domainEnvironment('ProjectTrack');
						tmpProject.compile({ Document: { Store: [ 'ClickHouse' ] } });
						// Document.Summary is a String(1024): above 256, not mirrored by Auto.
						Expect(columnNames(tmpProject.mirrorSpec.spec('ClickHouse', 'Document'))).to.not.include('Summary');
						tmpProject.compile({ Document: { Store: [ 'ClickHouse' ], IncludeColumns: [ 'Summary', 'GUIDDocument' ], ExcludeColumns: [ 'Title', 'IDFormType' ] } });
						let tmpDocument = tmpProject.mirrorSpec.spec('ClickHouse', 'Document');
						Expect(columnNames(tmpDocument)).to.include.members([ 'Summary', 'GUIDDocument' ]);
						Expect(libTypeMap.specColumn(tmpDocument, 'GUIDDocument')).to.include({ Mirror: 'Nullable(String)' });
						Expect(columnNames(tmpDocument)).to.not.include.members([ 'Title', 'IDFormType' ]);
						Expect(tmpDocument.TrackedKeyColumns).to.not.include('IDFormType');
					});

				test('an explicit Columns list is that list plus the always-added scope / identity / delete / UpdateDate / Join columns',
					() =>
					{
						let tmpLab = domainEnvironment('LabTrack');
						tmpLab.compile({ LabForm: { Store: [ 'ClickHouse' ], Columns: [ 'Status' ] } });
						let tmpSpec = tmpLab.mirrorSpec.spec('ClickHouse', 'LabForm');
						Expect(columnNames(tmpSpec)).to.deep.equal([ 'IDLabForm', 'IDCustomer', 'OwnerIDUser', 'UpdateDate', 'Deleted', 'IDMaterialIntake', 'IDLabFormType', 'Status' ]);
						// CreateDate is added by 'Auto' only.
						Expect(columnNames(tmpSpec)).to.not.include('CreateDate');
					});

				test('Watermark: Auto only when UpdateDate is indexed; UpdateDate explicitly; false; a missing UpdateDate disables',
					() =>
					{
						let tmpPlain = domainEnvironment('ProjectTrack');
						tmpPlain.compile({ Task: { Store: [ 'ClickHouse' ] }, Issue: { Store: [ 'ClickHouse' ], Watermark: 'UpdateDate' }, Client: { Store: [ 'ClickHouse' ], Watermark: false } });
						Expect(tmpPlain.mirrorSpec.spec('ClickHouse', 'Task').Watermark).to.equal(null);
						Expect(tmpPlain.mirrorSpec.spec('ClickHouse', 'Issue').Watermark).to.equal('UpdateDate');
						Expect(libTypeMap.specColumn(tmpPlain.mirrorSpec.spec('ClickHouse', 'Issue'), 'UpdateDate').Role).to.equal('Watermark');
						Expect(tmpPlain.mirrorSpec.spec('ClickHouse', 'Client').Watermark).to.equal(null);

						let tmpIndexed = domainEnvironment('ProjectTrack',
							{
								Model: (pModel) =>
								{
									pModel.Tables.Task.Columns.find((pColumn) => { return pColumn.Column === 'UpdateDate'; }).Indexed = true;
									pModel.Tables.Issue.Indices = [ { Name: 'IX_Issue_UpdateDate', Columns: [ 'UpdateDate', 'IDIssue' ] } ];
								}
							});
						tmpIndexed.compile({ Task: { Store: [ 'ClickHouse' ] }, Issue: { Store: [ 'ClickHouse' ] } });
						Expect(tmpIndexed.mirrorSpec.spec('ClickHouse', 'Task').Watermark).to.equal('UpdateDate');
						Expect(tmpIndexed.mirrorSpec.spec('ClickHouse', 'Issue').Watermark).to.equal('UpdateDate');
						Expect(tmpIndexed.mirrorSpec.spec('ClickHouse', 'Task').Warnings).to.not.include('NoWatermark');

						let tmpResult = tmpPlain.compile({ FormType: { Store: [ 'ClickHouse' ], Watermark: 'UpdateDate' } });
						Expect(disabledFor(tmpResult.Disabled, 'FormType')).to.include({ Reason: 'NoWatermarkColumn', Store: 'ClickHouse' });
					});

				test('SpecHash: stable across compiles and environments, sensitive to a column, a type and a sort-key change',
					() =>
					{
						let tmpA = domainEnvironment('LabTrack');
						let tmpB = domainEnvironment('LabTrack');
						let tmpHashA = tmpA.compile({ LabForm: { Store: [ 'ClickHouse' ] } }).Specs.ClickHouse.LabForm.SpecHash;
						Expect(tmpB.compile({ LabForm: { Store: [ 'ClickHouse' ] } }).Specs.ClickHouse.LabForm.SpecHash).to.equal(tmpHashA);
						Expect(tmpA.compile({ LabForm: { Store: [ 'ClickHouse' ] } }).Specs.ClickHouse.LabForm.SpecHash).to.equal(tmpHashA);
						// Pinned (the canonical material of §55.2 rule 4 at TYPE_MAP_VERSION 1 / DDL_VERSION 1).
						Expect(tmpHashA).to.equal('ms:4b918da5');
						// A column fewer.
						let tmpFewer = tmpA.compile({ LabForm: { Store: [ 'ClickHouse' ], ExcludeColumns: [ 'Status' ] } }).Specs.ClickHouse.LabForm.SpecHash;
						Expect(tmpFewer).to.not.equal(tmpHashA);
						// A retyped column (CompletedDate as a String in the model).
						let tmpRetyped = domainEnvironment('LabTrack', { Model: (pModel) => { let tmpColumn = pModel.Tables.LabForm.Columns.find((pColumn) => { return pColumn.Column === 'CompletedDate'; }); tmpColumn.DataType = 'String'; tmpColumn.Size = '32'; } });
						Expect(tmpRetyped.compile({ LabForm: { Store: [ 'ClickHouse' ] } }).Specs.ClickHouse.LabForm.SpecHash).to.not.equal(tmpHashA);
						// A different sort key (LabForm without its personal scope: Tenant).
						let tmpTenantOnly = domainEnvironment('LabTrack', { Faceting: { Scope: { Policy: { PersonalScopes: { LabForm: null } } } } });
						let tmpTenantSpec = tmpTenantOnly.compile({ LabForm: { Store: [ 'ClickHouse' ] } }).Specs.ClickHouse.LabForm;
						Expect(tmpTenantSpec.SortKey).to.deep.equal([ 'IDCustomer', 'IDLabForm' ]);
						Expect(tmpTenantSpec.SpecHash).to.not.equal(tmpHashA);
						Expect(libRetoldFacetingMirrorSpec.specHash(tmpTenantSpec.Columns, [ 'IDCustomer', 'OwnerIDUser', 'IDLabForm' ], tmpTenantSpec.KeymapColumns)).to.not.equal(tmpTenantSpec.SpecHash);
					});
			}
		);

		suite
		(
			'invalid entries (§55.1)',
			() =>
			{
				test('each invalid entry disables that entity in that store with its reason; the others load; nothing partial; logged once',
					() =>
					{
						let tmpLab = domainEnvironment('LabTrack');
						let tmpResult = tmpLab.compile(
							{
								LabForm: { Store: [ 'ClickHouse' ] },
								NoSuchEntity: { Store: [ 'ClickHouse' ] },
								LabQueue: { Store: [ 'ClickHouse' ], IncludeColumns: [ 'NoSuchColumn' ] },
								LabQueueMember: { Store: [ 'ClickHouse' ], ExcludeColumns: [ 'IDCustomer' ] },
								MaterialType: { Store: [ 'ClickHouse' ], ExcludeColumns: [ 'Deleted' ] },
								MaterialIntake: { Store: [ 'ClickHouse' ], Columns: 'Everything' },
								MaterialIntakeRequirement: { Store: [ 'ClickHouse', 'Solr' ] },
								_rfs_entity_state: { Store: [ 'ClickHouse' ] },
								User: { Store: [ 'ClickHouse' ], IncludeColumns: [ 'GUIDUser' ], ExcludeColumns: [ 'IDUser' ] }
							});
						let fReason = (pEntity, pStore) => { let tmpEntry = tmpResult.Disabled.find((pItem) => { return (pItem.Entity === pEntity) && (!pStore || (pItem.Store === pStore)); }); return tmpEntry ? tmpEntry.Reason : null; };
						Expect(fReason('NoSuchEntity')).to.equal('UnknownEntity');
						Expect(fReason('LabQueue')).to.equal('UnknownColumn');
						Expect(tmpResult.Disabled.find((pItem) => { return pItem.Entity === 'LabQueue'; })).to.include({ Column: 'NoSuchColumn', Pointer: '/LabQueue/IncludeColumns/0', Code: 'FACET_DEFINITION_INVALID', Kind: 'Materialize' });
						Expect(fReason('LabQueueMember')).to.equal('ExcludeRequired');
						Expect(fReason('MaterialType')).to.equal('ExcludeRequired');
						Expect(fReason('MaterialIntake')).to.equal('Schema');
						Expect(fReason('_rfs_entity_state')).to.equal('ReservedName');
						Expect(fReason('User')).to.equal('ExcludeRequired');
						// Solr is not configured: disabled there only; the ClickHouse spec loads.
						Expect(fReason('MaterialIntakeRequirement', 'Solr')).to.equal('StoreNotConfigured');
						Expect(fReason('MaterialIntakeRequirement', 'ClickHouse')).to.equal(null);
						Expect(tmpLab.mirrorSpec.entities('ClickHouse')).to.deep.equal([ 'LabForm', 'MaterialIntakeRequirement' ]);
						// Nothing partial: a disabled entity has no spec at all.
						[ 'LabQueue', 'LabQueueMember', 'MaterialType', 'MaterialIntake', 'User' ].forEach((pEntity) => { Expect(tmpLab.mirrorSpec.spec('ClickHouse', pEntity), pEntity).to.equal(null); });
						Expect(tmpLab.mirrorSpec.disabled()).to.deep.equal(tmpResult.Disabled);
						// Logged once each, never a value.
						Expect(tmpLab.logged.filter((pLine) => { return /Materialize entry disabled/.test(pLine); })).to.have.length(tmpResult.Disabled.length);
					});

				test('a Sensitive column gets the same answer as an unknown one; Text cannot be included; a store must be configured',
					() =>
					{
						let tmpBook = domainEnvironment('Bookstore');
						let tmpResult = tmpBook.compile(
							{
								User: { Store: [ 'ClickHouse' ], IncludeColumns: [ 'Password' ] },
								Customer: { Store: [ 'ClickHouse' ], Columns: [ 'NoSuchColumn' ] },
								Review: { Store: [ 'ClickHouse' ], IncludeColumns: [ 'Text' ] },
								Book: { Store: [ 'ClickHouse' ] }
							});
						Expect(disabledFor(tmpResult.Disabled, 'User')).to.include({ Reason: 'UnknownColumn', Column: 'Password' });
						Expect(disabledFor(tmpResult.Disabled, 'Customer')).to.include({ Reason: 'UnknownColumn' });
						Expect(disabledFor(tmpResult.Disabled, 'Review')).to.include({ Reason: 'ColumnNotMirrorable', Column: 'Text' });
						Expect(tmpBook.mirrorSpec.entities('ClickHouse')).to.deep.equal([ 'Book' ]);
						// No configured store at all.
						let tmpNone = tmpBook.compile({ Book: { Store: [ 'ClickHouse' ] } }, []);
						Expect(tmpNone.Disabled[0]).to.include({ Reason: 'StoreNotConfigured', Store: 'ClickHouse', Entity: 'Book' });
						Expect(tmpBook.mirrorSpec.entities('ClickHouse')).to.deep.equal([]);
						// The default environment reads configured stores from Options.Stores.
						let tmpDefault = new libRetoldFacetingMirrorSpec(tmpBook.fable, libOptions.resolve({ Stores: { ClickHouse: { URL: 'http://127.0.0.1:1' } } }));
						let tmpDefaultResult = tmpDefault.compile({ Book: { Store: [ 'ClickHouse' ] } }, { Catalog: tmpBook.catalog, Host: tmpBook.host, Registry: null });
						Expect(tmpDefaultResult.Disabled).to.deep.equal([]);
						Expect(tmpDefault.entities('ClickHouse')).to.deep.equal([ 'Book' ]);
						// A non-object declaration.
						Expect(tmpBook.compile([ 'Book' ]).Disabled[0]).to.include({ Reason: 'Schema' });
						Expect(tmpBook.compile(null).Disabled).to.deep.equal([]);
					});

				test('a model column named like a meta column disables the entity',
					() =>
					{
						let tmpLab = domainEnvironment('LabTrack', { Model: (pModel) => { pModel.Tables.LabQueue.Columns.push({ Column: '_Version', DataType: 'Numeric', Size: 'int' }); } });
						let tmpResult = tmpLab.compile({ LabQueue: { Store: [ 'ClickHouse' ] }, LabForm: { Store: [ 'ClickHouse' ] } });
						Expect(disabledFor(tmpResult.Disabled, 'LabQueue')).to.include({ Reason: 'MetaColumnName', Column: '_Version' });
						Expect(tmpLab.mirrorSpec.entities('ClickHouse')).to.deep.equal([ 'LabForm' ]);
					});

				test('validate() reports without changing the stored specs',
					() =>
					{
						let tmpLab = domainEnvironment('LabTrack');
						tmpLab.compile({ LabForm: { Store: [ 'ClickHouse' ] } });
						let tmpVerdict = tmpLab.mirrorSpec.validate({ LabQueue: { Store: [ 'ClickHouse' ], ExcludeColumns: [ 'IDCustomer' ] } }, tmpLab.environment);
						Expect(tmpVerdict.Valid).to.equal(false);
						Expect(tmpVerdict.Errors[0]).to.include({ Reason: 'ExcludeRequired' });
						Expect(tmpLab.mirrorSpec.validate({ LabQueue: { Store: [ 'ClickHouse' ] } }, tmpLab.environment).Valid).to.equal(true);
						Expect(tmpLab.mirrorSpec.entities('ClickHouse')).to.deep.equal([ 'LabForm' ]);
					});
			}
		);

		suite
		(
			'warnings',
			() =>
			{
				test('Unsupported:<Key> for the design keys M5 ignores, AppendOnly treated as Mutable; the spec still loads',
					() =>
					{
						let tmpProject = domainEnvironment('ProjectTrack');
						let tmpResult = tmpProject.compile(
							{
								Document:
									{
										Store: [ 'ClickHouse' ], Mutability: 'AppendOnly', Dictionary: true,
										PathColumns: { Project__Status: { Path: [ '>Document.IDProject' ], Column: 'Status', Mode: 'Denormalize' } },
										RelationFields: { X: { Shape: 'RelatedKeys' } }, Rollups: { R: {} }, Aggregates: { A: {} }
									},
								Project: { Store: [ 'ClickHouse' ], PathColumns: {}, Dictionary: false }
							});
						let tmpCodes = tmpResult.Warnings.filter((pWarning) => { return pWarning.Entity === 'Document'; }).map((pWarning) => { return pWarning.Code; });
						Expect(tmpCodes).to.include.members([ 'Unsupported:PathColumns', 'Unsupported:RelationFields', 'Unsupported:Rollups', 'Unsupported:Aggregates', 'Unsupported:Dictionary', 'AppendOnlyTreatedAsMutable' ]);
						// Empty sections / false are not warnings.
						Expect(tmpResult.Warnings.filter((pWarning) => { return (pWarning.Entity === 'Project') && /^Unsupported/.test(pWarning.Code); })).to.deep.equal([]);
						let tmpDocument = tmpProject.mirrorSpec.spec('ClickHouse', 'Document');
						Expect(tmpDocument.Mutability).to.equal('Mutable');
						Expect(tmpDocument.Warnings).to.include('Unsupported:PathColumns');
						// No derived column ever lands in the spec.
						Expect(columnNames(tmpDocument)).to.not.include('Project__Status');
					});

				test('ClosureIncomplete: a declared facet / scope whose entities are not all mirrored (never auto-enabled)',
					() =>
					{
						let tmpProject = domainEnvironment('ProjectTrack');
						let tmpResult = tmpProject.compile({ Project: { Store: [ 'ClickHouse' ] } });
						let tmpClosure = tmpResult.Warnings.filter((pWarning) => { return pWarning.Code === 'ClosureIncomplete'; });
						Expect(tmpClosure.length).to.be.above(0);
						Expect(tmpClosure.every((pWarning) => { return (pWarning.Store === 'ClickHouse') && (pWarning.Entity === 'Project') && (pWarning.Missing.length > 0); })).to.equal(true);
						// The definitions that read memberships / tasks list them as missing.
						let tmpMissing = new Set();
						tmpClosure.forEach((pWarning) => { pWarning.Missing.forEach((pEntity) => { tmpMissing.add(pEntity); }); });
						Expect(Array.from(tmpMissing)).to.include.members([ 'ProjectMembership', 'Task' ]);
						// Never auto-enabled.
						Expect(tmpProject.mirrorSpec.entities('ClickHouse')).to.deep.equal([ 'Project' ]);
						Expect(tmpProject.mirrorSpec.warnings()).to.deep.equal(tmpResult.Warnings);
						// Mirroring everything clears them.
						let tmpAll = tmpProject.compile(tmpProject.mirrorSpec.declareAll([ 'ClickHouse' ], tmpProject.environment));
						Expect(tmpAll.Warnings.filter((pWarning) => { return pWarning.Code === 'ClosureIncomplete'; })).to.deep.equal([]);
					});
			}
		);

		suite
		(
			'the closure rule: covers() (§55.3)',
			() =>
			{
				test('covered within the spec; NotMirrored for a missing entity, a missing column, a filling column; pseudo-fields ignored',
					() =>
					{
						let tmpProject = domainEnvironment('ProjectTrack');
						tmpProject.compile({ Project: { Store: [ 'ClickHouse' ] }, Task: { Store: [ 'ClickHouse' ] } });
						let tmpMirror = tmpProject.mirrorSpec;
						Expect(tmpMirror.covers('ClickHouse', { Project: [ 'IDProject', 'Deleted', 'IDCustomer', 'Status' ], Task: [ 'IDTask', 'IDProject', 'DueDate' ] })).to.deep.equal({ Covered: true, Reason: null });
						Expect(tmpMirror.covers('ClickHouse', { Project: [ 'IDProject', '@scope:Project.MyProjects' ] })).to.deep.equal({ Covered: true, Reason: null });
						// The object form FoldIR builds internally.
						Expect(tmpMirror.covers('ClickHouse', { Project: { IDProject: true, Status: true } }).Covered).to.equal(true);
						Expect(tmpMirror.covers('ClickHouse', { Project: [ 'IDProject' ], ProjectMembership: [ 'IDProject' ] })).to.deep.equal({ Covered: false, Reason: 'NotMirrored:ProjectMembership' });
						Expect(tmpMirror.covers('ClickHouse', { Project: [ 'IDProject', 'GUIDProject' ] })).to.deep.equal({ Covered: false, Reason: 'NotMirrored:Project.GUIDProject' });
						Expect(tmpMirror.covers('ClickHouse', { Project: [ 'IDProject', 'Status' ] }, { Project: [ 'Status' ] })).to.deep.equal({ Covered: false, Reason: 'NotMirrored:Project.Status' });
						Expect(tmpMirror.covers('ClickHouse', { Project: [ 'IDProject', 'Status' ] }, { Task: [ 'Status' ] }).Covered).to.equal(true);
						Expect(tmpMirror.covers('Solr', { Project: [ 'IDProject' ] })).to.deep.equal({ Covered: false, Reason: 'NotMirrored:Project' });
						Expect(tmpMirror.covers('ClickHouse', {})).to.deep.equal({ Covered: true, Reason: null });
						// The first failing entity / column in sorted order is the reason (deterministic).
						Expect(tmpMirror.covers('ClickHouse', { Zeta: [ 'A' ], Project: [ 'Zz', 'Aa' ] }).Reason).to.equal('NotMirrored:Project.Aa');
						Expect(tmpMirror.column('ClickHouse', 'Task', 'DueDate')).to.include({ Mirror: "Nullable(DateTime64(3, 'UTC'))" });
						Expect(tmpMirror.column('ClickHouse', 'Task', 'Nope')).to.equal(null);
						Expect(tmpMirror.column('ClickHouse', 'Nope', 'DueDate')).to.equal(null);
						Expect(tmpMirror.stores()).to.deep.equal([ 'ClickHouse' ]);
						Expect(Object.keys(tmpMirror.specs('ClickHouse')).sort()).to.deep.equal([ 'Project', 'Task' ]);
					});
			}
		);

		suite
		(
			'spec changes (§55.4): classifyChange',
			() =>
			{
				/**
				 * The ensureSchema report of live tables built from a spec.
				 *
				 * @param {Record<string, any>} pSpec
				 * @return {Record<string, any>}
				 */
				const reportOf = (pSpec) =>
				{
					let tmpTypes = {};
					pSpec.Columns.forEach((pColumn) => { tmpTypes[pColumn.Column] = pColumn.Mirror; });
					let tmpKeymapTypes = {};
					libDDL.keymapColumns(pSpec).forEach((pColumn) => { tmpKeymapTypes[pColumn.Column] = pColumn.Mirror; });
					return (
						{
							MirrorExists: true, KeymapExists: true, SpecHash: pSpec.SpecHash, KeymapSpecHash: pSpec.SpecHash,
							Columns: Object.keys(tmpTypes), ColumnTypes: tmpTypes, SortKey: pSpec.SortKey.slice(),
							KeymapColumns: Object.keys(tmpKeymapTypes), KeymapColumnTypes: tmpKeymapTypes, KeymapSortKey: libDDL.keymapOrder(pSpec)
						});
				};

				test('Absent, Same, Additive (columns and a tracked keymap column added), Rebuild (removed, retyped, sort key)',
					() =>
					{
						let tmpLab = domainEnvironment('LabTrack');
						let tmpNarrow = tmpLab.compile({ LabForm: { Store: [ 'ClickHouse' ], Columns: [ 'Status' ], ExcludeColumns: [ 'IDLabFormType' ] } }).Specs.ClickHouse.LabForm;
						let tmpWide = tmpLab.compile({ LabForm: { Store: [ 'ClickHouse' ] } }).Specs.ClickHouse.LabForm;
						let tmpMirror = tmpLab.mirrorSpec;
						Expect(tmpMirror.classifyChange(null, tmpWide).Kind).to.equal('Absent');
						Expect(tmpMirror.classifyChange({ MirrorExists: true, KeymapExists: false }, tmpWide)).to.include({ Kind: 'Absent', Reason: 'NoKeymap' });
						Expect(tmpMirror.classifyChange(reportOf(tmpWide), tmpWide)).to.deep.equal({ Kind: 'Same', Added: [], KeymapAdded: [], Reason: null });
						// The wide spec over the narrow tables: additive (CreateDate, CompletedDate, …; the FK IDLabFormType also in the keymap).
						let tmpAdditive = tmpMirror.classifyChange(reportOf(tmpNarrow), tmpWide);
						Expect(tmpAdditive.Kind).to.equal('Additive');
						Expect(tmpAdditive.Added).to.include.members([ 'CreateDate', 'CompletedDate', 'IDLabFormType' ]);
						Expect(tmpAdditive.KeymapAdded).to.deep.equal([ 'IDLabFormType' ]);
						// The narrow spec over the wide tables: a removed column → rebuild.
						Expect(tmpMirror.classifyChange(reportOf(tmpWide), tmpNarrow)).to.include({ Kind: 'Rebuild' });
						Expect(tmpMirror.classifyChange(reportOf(tmpWide), tmpNarrow).Reason).to.match(/^RemovedColumn:/);
						// A retyped column.
						let tmpRetyped = reportOf(tmpWide);
						tmpRetyped.SpecHash = 'ms:00000000';
						tmpRetyped.ColumnTypes.Status = 'Nullable(Int64)';
						Expect(tmpMirror.classifyChange(tmpRetyped, tmpWide)).to.include({ Kind: 'Rebuild', Reason: 'RetypedColumn:Status' });
						// A sort-key change.
						let tmpSorted = reportOf(tmpWide);
						tmpSorted.SpecHash = 'ms:00000000';
						tmpSorted.SortKey = [ 'IDCustomer', 'IDLabForm' ];
						Expect(tmpMirror.classifyChange(tmpSorted, tmpWide)).to.include({ Kind: 'Rebuild', Reason: 'SortKey' });
						// Same columns under another hash (a version bump): rebuild, never a silent resume.
						let tmpBumped = reportOf(tmpWide);
						tmpBumped.SpecHash = 'ms:00000000';
						Expect(tmpMirror.classifyChange(tmpBumped, tmpWide)).to.include({ Kind: 'Rebuild', Reason: 'SpecHash' });
					});
			}
		);
	}
);
