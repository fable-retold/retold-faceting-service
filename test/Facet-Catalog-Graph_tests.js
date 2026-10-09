/**
 * Catalog + Graph tests (internal-contracts §11): auto-derivation from the Stricture model,
 * Sensitive handling, overrides, ModelVersion, Describe blocks, and the FacetGraph (column-keyed
 * edges, PK-index resolution, structural bridges, hubs, GraphHash).
 *
 * Pure in-process: no server (port 19102 is reserved for this file but unused).  The bookstore
 * model is read straight from retold-harness; policy cases bind a real RetoldFacetingHostDataService
 * to a small fake RetoldDataService object.
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;


const libRetoldFacetingCatalog = require('../source/catalog/Retold-Faceting-Catalog.js');
const libRetoldFacetingGraph = require('../source/catalog/Retold-Faceting-Graph.js');
const libRetoldFacetingHostDataService = require('../source/host/Retold-Faceting-Host-DataService.js');

const libBuilders = require('./support/Facet-Test-Builders.js');

const newFable = () => { return libBuilders.newFable('RetoldFacetingCatalogTests'); };

/**
 * A deep clone of the retold-harness bookstore model.
 *
 * @return {Record<string, any>}
 */
const bookstoreModel = () =>
{
	return libBuilders.bookstoreModel('Bookstore');
};

/**
 * Add a column to a model table (Columns[] and MeadowSchema.Schema[]).
 */
const addColumn = (pModel, pTable, pColumn, pMeadowType) =>
{
	pModel.Tables[pTable].Columns.push(pColumn);
	pModel.Tables[pTable].MeadowSchema.Schema.push({ Column: pColumn.Column, Type: pMeadowType || 'Integer', Size: pColumn.Size || 'Default' });
	return pModel;
};

/**
 * A minimal model table.
 *
 * @param {string} pName
 * @param {Array<Record<string, any>>} pColumns - Columns[] entries after the ID column
 * @param {string} [pPK] - PK column (default 'ID' + name)
 */
const table = (pName, pColumns, pPK) =>
{
	let tmpPK = pPK || `ID${pName}`;
	let tmpColumns = [ { Column: tmpPK, DataType: 'ID' } ].concat(pColumns);
	return (
		{
			TableName: pName,
			Columns: tmpColumns,
			Indices: [],
			MeadowSchema:
			{
				Scope: pName,
				DefaultIdentifier: tmpPK,
				Schema: tmpColumns.map((pColumn) => { return { Column: pColumn.Column, Type: (pColumn.DataType === 'ID') ? 'AutoIdentity' : (pColumn.MeadowType || 'Integer'), Size: pColumn.Size || 'Default' }; })
			}
		});
};

/**
 * The bookstore model with an IDTenant column on every table except pSkip.
 */
const tenantModel = (pSkip) =>
{
	let tmpModel = bookstoreModel();
	Object.keys(tmpModel.Tables).forEach(
		(pTable) =>
		{
			if ((pSkip || []).indexOf(pTable) < 0)
			{
				addColumn(tmpModel, pTable, { Column: 'IDTenant', DataType: 'Numeric', Size: 'int' }, 'Integer');
			}
		});
	return tmpModel;
};

/**
 * A fake RetoldDataService just rich enough for RetoldFacetingHostDataService: fable.DAL,
 * fable.MeadowEndpoints (route-bound controllers), fullModel, and a loadModel that behaves like
 * RDS (new endpoint objects for every entity, routes kept on the first controller).
 */
const fakeRDS = (pFable, pModel) =>
{
	pFable.DAL = {};
	pFable.MeadowEndpoints = {};
	pFable.OratorServiceServer = { fake: true };
	let fPopulate = (pTables) =>
	{
		Object.keys(pTables).forEach(
			(pEntity) =>
			{
				let tmpMeadowSchema = pTables[pEntity].MeadowSchema;
				pFable.DAL[pEntity] = { scope: pEntity, providerName: 'SQLite', schema: tmpMeadowSchema.Schema, defaultIdentifier: tmpMeadowSchema.DefaultIdentifier };
				pFable.MeadowEndpoints[pEntity] = (
					{
						_EnabledBehaviorSets: { Reads: true },
						controller:
						{
							Entity: pEntity,
							settings: pFable.settings,
							initializeRequestState: (pRequest, pVerb) =>
							{
								return { Verb: pVerb, SessionData: Object.assign({ LoggedIn: false, UserID: 0, CustomerID: 0 }, pRequest.UserSession || {}) };
							}
						}
					});
			});
	};
	fPopulate(pModel.Tables);
	let tmpRDS = (
		{
			fable: pFable,
			fullModel: pModel,
			loadModel: function (pName, pModelObject, pProvider, fCallback)
			{
				fPopulate(pModelObject.Tables);
				this.fullModel = { Tables: Object.assign({}, this.fullModel.Tables, pModelObject.Tables) };
				return fCallback();
			}
		});
	return tmpRDS;
};

/**
 * A bound host + catalog on a fake RDS.
 */
const hostedCatalog = (pModel, pOptions, fCallback) =>
{
	let tmpFable = newFable();
	let tmpRDS = fakeRDS(tmpFable, pModel);
	let tmpHost = new libRetoldFacetingHostDataService(tmpFable, pOptions || {});
	let tmpCatalog = new libRetoldFacetingCatalog(tmpFable, pOptions || {});
	tmpHost.bind(tmpRDS,
		(pError) =>
		{
			if (pError)
			{
				return fCallback(pError);
			}
			tmpCatalog.rebuild(tmpHost.getModelSync(), tmpHost);
			return fCallback(null, { fable: tmpFable, rds: tmpRDS, host: tmpHost, catalog: tmpCatalog });
		});
};

const newGraph = (pModel, pOptions) =>
{
	let tmpGraph = new libRetoldFacetingGraph(newFable(), pOptions || {});
	return tmpGraph.rebuild(pModel);
};

const newCatalog = (pModel, pOptions) =>
{
	let tmpCatalog = new libRetoldFacetingCatalog(newFable(), pOptions || {});
	return tmpCatalog.rebuild(pModel, null);
};

suite
(
	'Facet-Catalog-Graph',
	() =>
	{
		suite
		(
			'Graph',
			() =>
			{
				test('edges are keyed by (From, FromColumn) and resolve targets through the PK-column index',
					() =>
					{
						let tmpGraph = newGraph(bookstoreModel());
						let tmpEdge = tmpGraph.edge('Review.IDBook');
						Expect(tmpEdge).to.deep.equal({ Name: 'Review.IDBook', From: 'Review', FromColumn: 'IDBook', To: 'Book', ToColumn: 'IDBook', Cardinality: 'N:1', Audit: false, Tenant: false });
						// Not ID-prefix stripping: the column name says nothing about the target.
						Expect(tmpGraph.edge('BookStoreInventory.StockingAssociate').To).to.equal('User');
						Expect(tmpGraph.edge('Review.Rating')).to.equal(null);
						Expect(tmpGraph.edge('constructor')).to.equal(null);
						Expect(tmpGraph.edge('BookStoreSale.IDCustomer').Tenant).to.equal(true);
						Expect(tmpGraph.entityForKey('IDBookStore')).to.equal('BookStore');
						Expect(tmpGraph.primaryKey('Review')).to.equal('IDReview');
						Expect(tmpGraph.warnings()).to.deep.equal([]);
						Expect(tmpGraph.outgoing('Review').map((pEdge) => { return pEdge.Name; })).to.deep.equal([ 'Review.IDBook', 'Review.IDUser' ]);
						Expect(tmpGraph.incoming('BookStoreSale').map((pEdge) => { return pEdge.Name; })).to.deep.equal([ 'BookStoreSaleItem.IDBookStoreSale' ]);
						Expect(tmpGraph.incoming('User').map((pEdge) => { return pEdge.Name; })).to.include.members([ 'Author.IDUser', 'BookStoreInventory.StockingAssociate', 'Review.IDUser', 'BookStoreSale.IDUser' ]);
					});

				test('two FKs to the same table both survive; XID-style keys resolve',
					() =>
					{
						let tmpModel = { Tables: {} };
						tmpModel.Tables.Vision = table('Vision', [ { Column: 'Name', DataType: 'String', Size: '64' } ]);
						tmpModel.Tables.VisionVisionJoin = table('VisionVisionJoin',
							[
								{ Column: 'IDVisionSource', DataType: 'Numeric', Size: 'int', Join: 'IDVision' },
								{ Column: 'IDVisionTarget', DataType: 'Numeric', Size: 'int', Join: 'IDVision' }
							]);
						tmpModel.Tables.Person = table('Person', [ { Column: 'Name', DataType: 'String', Size: '64' } ], 'PersonID');
						tmpModel.Tables.Pet = table('Pet', [ { Column: 'OwnerPersonID', DataType: 'Numeric', Size: 'int', Join: 'PersonID' } ], 'PetID');
						let tmpGraph = newGraph(tmpModel);
						Expect(tmpGraph.edge('VisionVisionJoin.IDVisionSource').To).to.equal('Vision');
						Expect(tmpGraph.edge('VisionVisionJoin.IDVisionTarget').To).to.equal('Vision');
						Expect(tmpGraph.incoming('Vision').length).to.equal(2);
						Expect(tmpGraph.edge('Pet.OwnerPersonID')).to.include({ To: 'Person', ToColumn: 'PersonID' });
						// Both join the same table: a bridge Vision~Vision.
						Expect(tmpGraph.isBridge('VisionVisionJoin')).to.equal(true);
						Expect(tmpGraph.alias('Vision~Vision')).to.deep.equal([ '<VisionVisionJoin.IDVisionSource', '>VisionVisionJoin.IDVisionTarget' ]);
					});

				test('unresolved and ambiguous joins become warnings, not edges',
					() =>
					{
						let tmpModel = { Tables: {} };
						tmpModel.Tables.A = table('A', [ { Column: 'IDNowhere', DataType: 'Numeric', Size: 'int', Join: 'IDNowhere' } ]);
						tmpModel.Tables.B = table('B', [], 'SharedKey');
						tmpModel.Tables.C = table('C', [], 'SharedKey');
						tmpModel.Tables.D = table('D', [ { Column: 'Ref', DataType: 'Numeric', Size: 'int', Join: 'SharedKey' } ]);
						let tmpGraph = newGraph(tmpModel);
						Expect(tmpGraph.edges()).to.deep.equal([]);
						Expect(tmpGraph.entityForKey('SharedKey')).to.equal(null);
						Expect(tmpGraph.warnings().map((pWarning) => { return pWarning.Code; })).to.deep.equal([ 'JoinTargetUnresolved', 'JoinTargetAmbiguous' ]);
					});

				test('audit-user and tenancy edges are flagged',
					() =>
					{
						let tmpModel = bookstoreModel();
						tmpModel.Tables.Book.Columns.find((pColumn) => { return pColumn.Column === 'CreatingIDUser'; }).Join = 'IDUser';
						let tmpGraph = newGraph(tmpModel, { Scope: { Policy: { Column: 'IDTenantish' } } });
						Expect(tmpGraph.edge('Book.CreatingIDUser')).to.include({ To: 'User', Audit: true, Tenant: false });
						Expect(tmpGraph.edge('BookAuthorJoin.IDCustomer')).to.include({ Tenant: true, Audit: false });
						Expect(tmpGraph.tenantColumns()).to.deep.equal([ 'IDCustomer', 'IDTenant', 'IDTenantish' ]);
					});

				test('bridges are structural: two non-audit, non-tenant joins and no payload',
					() =>
					{
						let tmpGraph = newGraph(bookstoreModel());
						Expect(tmpGraph.bridges()).to.deep.equal([ 'BookAuthorJoin', 'BookStoreCatalogJoin' ]);
						Expect(tmpGraph.isBridge('BookAuthorJoin')).to.equal(true);
						Expect(tmpGraph.bridge('BookAuthorJoin')).to.deep.equal({ Entity: 'BookAuthorJoin', Edges: [ 'BookAuthorJoin.IDBook', 'BookAuthorJoin.IDAuthor' ], Alias: 'Book~Author', Tenant: true, Elidable: false });
						Expect(tmpGraph.bridge('BookStoreCatalogJoin').Tenant).to.equal(false);
						// A tenant-scoped join table may be spliced by its alias but is never elidable (01 §5.3).
						Expect(tmpGraph.bridge('BookStoreCatalogJoin').Elidable).to.equal(true);
						Expect(tmpGraph.isBridge('Review')).to.equal(false);
						Expect(tmpGraph.isBridge('BookStoreInventory')).to.equal(false);
						Expect(tmpGraph.isBridge('constructor')).to.equal(false);
						Expect(tmpGraph.alias('Book~Author')).to.deep.equal([ '<BookAuthorJoin.IDBook', '>BookAuthorJoin.IDAuthor' ]);
						Expect(tmpGraph.alias('Book~BookStore')).to.deep.equal([ '<BookStoreCatalogJoin.IDBook', '>BookStoreCatalogJoin.IDBookStore' ]);

						// Payload makes a regular entity (ProjectMembership.Role).
						let tmpModel = bookstoreModel();
						tmpModel.Tables.Project = table('Project', [ { Column: 'Name', DataType: 'String', Size: '64' } ]);
						tmpModel.Tables.ProjectMembership = table('ProjectMembership',
							[
								{ Column: 'IDProject', DataType: 'Numeric', Size: 'int', Join: 'IDProject' },
								{ Column: 'IDUser', DataType: 'Numeric', Size: 'int', Join: 'IDUser' },
								{ Column: 'Role', DataType: 'String', Size: '32' }
							]);
						// A second Book/Author bridge makes the synthetic alias ambiguous.
						tmpModel.Tables.BookAuthorJoin2 = JSON.parse(JSON.stringify(tmpModel.Tables.BookAuthorJoin));
						tmpModel.Tables.BookAuthorJoin2.Columns[0].Column = 'IDBookAuthorJoin2';
						tmpModel.Tables.BookAuthorJoin2.MeadowSchema.DefaultIdentifier = 'IDBookAuthorJoin2';
						let tmpOther = newGraph(tmpModel);
						Expect(tmpOther.isBridge('ProjectMembership')).to.equal(false);
						Expect(tmpOther.isBridge('BookAuthorJoin2')).to.equal(true);
						Expect(tmpOther.alias('Book~Author')).to.equal(null);
						Expect(tmpOther.bridge('BookAuthorJoin').Alias).to.equal(null);
						Expect(tmpOther.warnings().map((pWarning) => { return pWarning.Code; })).to.include('BridgeAliasAmbiguous');
					});

				test('hubs come from Catalog.HubEntities present in the model',
					() =>
					{
						Expect(newGraph(bookstoreModel()).hubs()).to.deep.equal([ 'User', 'Customer' ]);
						let tmpGraph = newGraph(bookstoreModel(), { Catalog: { HubEntities: [ 'Book', 'Nope' ] } });
						Expect(tmpGraph.hubs()).to.deep.equal([ 'Book' ]);
						Expect(tmpGraph.isHub('Book')).to.equal(true);
						Expect(tmpGraph.isHub('User')).to.equal(false);
					});

				test('GraphHash covers names, Columns[].{Column, DataType, Join, TableJoin} only',
					() =>
					{
						let tmpHash = newGraph(bookstoreModel()).graphHash();
						Expect(tmpHash).to.match(/^g:[0-9a-f]{12}$/);
						Expect(newGraph(bookstoreModel()).graphHash()).to.equal(tmpHash);

						let tmpDescribed = bookstoreModel();
						tmpDescribed.Tables.Book.Description = 'A different description';
						tmpDescribed.Tables.Book.Columns[10].Size = '99';
						Expect(newGraph(tmpDescribed).graphHash()).to.equal(tmpHash);

						let tmpRejoined = bookstoreModel();
						tmpRejoined.Tables.Review.Columns.find((pColumn) => { return pColumn.Column === 'IDUser'; }).Join = 'IDAuthor';
						Expect(newGraph(tmpRejoined).graphHash()).to.not.equal(tmpHash);

						let tmpRetyped = bookstoreModel();
						tmpRetyped.Tables.Book.Columns.find((pColumn) => { return pColumn.Column === 'Language'; }).DataType = 'Text';
						Expect(newGraph(tmpRetyped).graphHash()).to.not.equal(tmpHash);

						let tmpEmpty = newGraph(null);
						Expect(tmpEmpty.edges()).to.deep.equal([]);
						Expect(tmpEmpty.entities()).to.deep.equal([]);
						Expect(tmpEmpty.builtFrom()).to.equal(null);
					});
			}
		);

		suite
		(
			'Catalog derivation (bookstore, no host)',
			() =>
			{
				test('every model table is in the catalog; FacetIDs are Entity.Column',
					() =>
					{
						let tmpModel = bookstoreModel();
						let tmpCatalog = newCatalog(tmpModel);
						Expect(tmpCatalog.entities()).to.deep.equal(tmpModel.TablesSequence);
						Expect(tmpCatalog.facet('BookStoreSale.SaleDate').Facet).to.equal('BookStoreSale.SaleDate');
						Expect(tmpCatalog.facet('BookStoreSale.Nope')).to.equal(null);
						Expect(tmpCatalog.facet('__proto__')).to.equal(null);
						Expect(tmpCatalog.getFacetable('constructor')).to.equal(null);
						Expect(tmpCatalog.getFacetable('Nope')).to.equal(null);
						Expect(tmpCatalog.warnings()).to.deep.equal([]);
					});

				test('DateTime → DateHistogram, Stats, Missing (DateRange; intervals; DeleteDate excluded, audit dates included)',
					() =>
					{
						let tmpCatalog = newCatalog(bookstoreModel());
						Expect(tmpCatalog.facet('BookStoreSale.SaleDate')).to.deep.equal(
							{
								Facet: 'BookStoreSale.SaleDate', Entity: 'BookStoreSale', Field: 'SaleDate', DisplayName: 'Sale Date',
								DataType: 'DateTime', IsInteger: false, Scale: 0,
								Folds: [ 'DateHistogram', 'Stats', 'Missing' ], DefaultFold: 'DateHistogram',
								ClauseType: 'DateRange', FilterKey: 'SaleDate',
								Intervals: [ 'day', 'week', 'month', 'quarter', 'year' ], DefaultInterval: 'month',
								Target: null, LabelLookup: null, Labels: false, Selectable: true, Engines: [ 'Live' ], Auto: true
							});
						Expect(tmpCatalog.facet('Book.CreateDate').DefaultFold).to.equal('DateHistogram');
						Expect(tmpCatalog.facet('Book.UpdateDate')).to.not.equal(null);
						Expect(tmpCatalog.facet('Book.DeleteDate')).to.equal(null);
						Expect(tmpCatalog.column('Book', 'DeleteDate')).to.include({ IsAudit: true, Facetable: false, Filterable: true });
						Expect(tmpCatalog.column('Book', 'CreateDate')).to.include({ IsAudit: true, Facetable: true });
					});

				test('Numeric (integer) and Decimal columns',
					() =>
					{
						let tmpCatalog = newCatalog(bookstoreModel());
						Expect(tmpCatalog.facet('Review.Rating')).to.include({ DataType: 'Numeric', IsInteger: true, Scale: 0, DefaultFold: 'NumericHistogram', ClauseType: 'NumericRange' });
						Expect(tmpCatalog.facet('Review.Rating').Folds).to.deep.equal([ 'NumericHistogram', 'Terms', 'Ranges', 'Stats', 'DistinctCount', 'Missing' ]);
						Expect(tmpCatalog.facet('BookStoreSale.TotalAmount')).to.include({ DataType: 'Decimal', IsInteger: false, Scale: 2, DefaultFold: 'NumericHistogram' });
						Expect(tmpCatalog.facet('BookStoreSale.TotalAmount').Folds).to.deep.equal([ 'NumericHistogram', 'Ranges', 'Stats', 'Missing' ]);
						Expect(tmpCatalog.facet('BookStoreSale.TotalAmount').Intervals).to.equal(undefined);
						Expect(tmpCatalog.column('BookStoreSale', 'TotalAmount')).to.deep.equal(
							{
								Entity: 'BookStoreSale', Column: 'TotalAmount', DataType: 'Decimal', MeadowType: 'Decimal', Size: '10,2',
								IsInteger: false, Scale: 2, Join: null, JoinTarget: null,
								IsPK: false, IsDeleteColumn: false, IsAudit: false, IsPolicyColumn: false,
								Sensitive: false, Filterable: true, Facetable: true
							});
						Expect(tmpCatalog.facet('Book.PublicationYear').DefaultFold).to.equal('NumericHistogram');

						let tmpModel = bookstoreModel();
						addColumn(tmpModel, 'Book', { Column: 'Weight', DataType: 'Decimal', Size: '20' }, 'Decimal');
						addColumn(tmpModel, 'Book', { Column: 'Height', DataType: 'Decimal' }, 'Decimal');
						addColumn(tmpModel, 'Book', { Column: 'Depth', DataType: 'Decimal', Size: 'wide' }, 'Decimal');
						let tmpOther = newCatalog(tmpModel);
						Expect(tmpOther.column('Book', 'Weight').Scale).to.equal(0);
						Expect(tmpOther.column('Book', 'Height').Scale).to.equal(3);
						Expect(tmpOther.column('Book', 'Depth').Scale).to.equal(3);
						Expect(tmpOther.warnings()).to.deep.equal([ { Code: 'DecimalScaleAssumed', Entity: 'Book', Column: 'Depth' } ]);
					});

				test('Join columns → Terms on the FK with a label lookup descriptor',
					() =>
					{
						let tmpCatalog = newCatalog(bookstoreModel());
						let tmpFacet = tmpCatalog.facet('BookStoreSale.IDBookStore');
						Expect(tmpFacet).to.include({ DataType: 'Numeric', DisplayName: 'Book Store', DefaultFold: 'Terms', ClauseType: 'DistinctSelectedValueList', Target: 'BookStore', Labels: true, Selectable: true });
						Expect(tmpFacet.Folds).to.deep.equal([ 'Terms', 'Missing', 'DistinctCount' ]);
						Expect(tmpFacet.LabelLookup).to.deep.equal({ Entity: 'BookStore', KeyColumn: 'IDBookStore', LabelColumn: 'Name' });
						Expect(tmpCatalog.column('BookStoreSale', 'IDBookStore')).to.include({ Join: 'IDBookStore', JoinTarget: 'BookStore', IsInteger: true });
						Expect(tmpCatalog.facet('BookStoreInventory.StockingAssociate')).to.include({ Target: 'User', DisplayName: 'Stocking Associate' });
						// User: no Name/Title, FullName is 255 > 128 by the size rule but is a named candidate; LoginID never by default.
						Expect(tmpCatalog.facet('BookStoreInventory.StockingAssociate').LabelLookup.LabelColumn).to.equal('FullName');
						Expect(tmpCatalog.facet('Review.IDBook').LabelLookup.LabelColumn).to.equal('Title');

						let tmpModel = bookstoreModel();
						tmpModel.Tables.User.Columns = tmpModel.Tables.User.Columns.filter((pColumn) => { return pColumn.Column !== 'FullName'; });
						Expect(newCatalog(tmpModel).facet('Review.IDUser').LabelLookup.LabelColumn).to.equal('NameFirst');
						let tmpOverridden = newCatalog(bookstoreModel(), { Catalog: { User: { LabelColumn: 'LoginID' } } });
						Expect(tmpOverridden.facet('Review.IDUser').LabelLookup.LabelColumn).to.equal('LoginID');
					});

				test('Boolean, bounded String, Text, long String, GUID, PK, delete and audit columns',
					() =>
					{
						let tmpCatalog = newCatalog(bookstoreModel());
						Expect(tmpCatalog.facet('Customer.Active')).to.include({ DefaultFold: 'Terms', ClauseType: 'DistinctSelectedValueList', IsInteger: true });
						Expect(tmpCatalog.facet('Customer.Active').Folds).to.deep.equal([ 'Terms', 'Missing' ]);
						Expect(tmpCatalog.facet('BookStoreSale.PaymentMethod').Folds).to.deep.equal([ 'Terms', 'Missing', 'DistinctCount' ]);
						Expect(tmpCatalog.facet('Book.Language')).to.include({ DisplayName: 'Language', ClauseType: 'DistinctSelectedValueList' });
						Expect(tmpCatalog.facet('Book.Title')).to.equal(null);
						Expect(tmpCatalog.column('Book', 'Title')).to.include({ Filterable: true, Facetable: false });
						Expect(tmpCatalog.facet('Review.Text')).to.equal(null);
						Expect(tmpCatalog.column('Review', 'Text')).to.include({ DataType: 'Text', MeadowType: 'String', Filterable: true });
						Expect(tmpCatalog.facet('Book.IDBook')).to.equal(null);
						Expect(tmpCatalog.column('Book', 'IDBook')).to.include({ IsPK: true, Facetable: false });
						Expect(tmpCatalog.facet('Book.GUIDBook')).to.equal(null);
						// GUID by name: User.GUIDUser is Numeric / Integer in the bookstore model.
						Expect(tmpCatalog.facet('User.GUIDUser')).to.equal(null);
						Expect(tmpCatalog.column('User', 'GUIDUser')).to.not.equal(null);
						Expect(tmpCatalog.facet('Book.Deleted')).to.equal(null);
						Expect(tmpCatalog.column('Book', 'Deleted')).to.include({ IsDeleteColumn: true, Filterable: true, Facetable: false });
						Expect(tmpCatalog.facet('Book.CreatingIDUser')).to.equal(null);
						Expect(tmpCatalog.column('Book', 'CreatingIDUser')).to.include({ IsAudit: true, MeadowType: 'CreateIDUser' });
						let tmpBook = tmpCatalog.getFacetable('Book');
						Expect(tmpBook).to.include({ Entity: 'Book', DisplayName: 'Books', PK: 'IDBook', DeleteColumn: 'Deleted', ScopeAssurance: 'Unscoped', Bridge: false, SizeClass: 'Unknown' });
						Expect(tmpCatalog.getFacetable('BookAuthorJoin')).to.include({ DeleteColumn: null, Bridge: true, DisplayName: 'Book Author Joins' });
						Expect(tmpCatalog.getFacetable('BookStoreInventory').DisplayName).to.equal('Book Store Inventories');
						Expect(tmpBook.Dates).to.deep.equal([ 'CreateDate', 'UpdateDate' ]);
						Expect(tmpBook.Numeric).to.deep.equal([ 'PublicationYear' ]);
						Expect(tmpBook.Categorical).to.deep.equal([ 'Type', 'Genre', 'ISBN', 'Language' ]);
					});

				test('String size bound, unique indexes, JSON and ForeignKey-without-Join',
					() =>
					{
						let tmpModel = bookstoreModel();
						addColumn(tmpModel, 'Book', { Column: 'Code128', DataType: 'String', Size: '128' }, 'String');
						addColumn(tmpModel, 'Book', { Column: 'Code129', DataType: 'String', Size: '129' }, 'String');
						addColumn(tmpModel, 'Book', { Column: 'Sized', DataType: 'String' }, 'String');
						addColumn(tmpModel, 'Book', { Column: 'Unique1', DataType: 'String', Size: '32' }, 'String');
						addColumn(tmpModel, 'Book', { Column: 'Unique2', DataType: 'String', Size: '32', Indexed: 'unique' }, 'String');
						addColumn(tmpModel, 'Book', { Column: 'Indexed1', DataType: 'String', Size: '32', Indexed: true }, 'String');
						addColumn(tmpModel, 'Book', { Column: 'Extra', DataType: 'JSON' }, 'String');
						addColumn(tmpModel, 'Book', { Column: 'ExtraProxy', DataType: 'JSONProxy' }, 'String');
						addColumn(tmpModel, 'Book', { Column: 'IDLoose', DataType: 'ForeignKey' }, 'Integer');
						tmpModel.Tables.Book.Indices = [ { Name: 'AK_Unique1', Columns: [ 'Unique1' ], Unique: true }, { Name: 'IX_Code', Columns: [ 'Code128' ], Unique: false } ];
						let tmpCatalog = newCatalog(tmpModel);
						Expect(tmpCatalog.facet('Book.Code128')).to.not.equal(null);
						Expect(tmpCatalog.facet('Book.Code129')).to.equal(null);
						Expect(tmpCatalog.facet('Book.Sized')).to.not.equal(null);
						Expect(tmpCatalog.facet('Book.Unique1')).to.equal(null);
						Expect(tmpCatalog.facet('Book.Unique2')).to.equal(null);
						Expect(tmpCatalog.facet('Book.Indexed1')).to.not.equal(null);
						Expect(tmpCatalog.facet('Book.Extra')).to.equal(null);
						Expect(tmpCatalog.facet('Book.ExtraProxy')).to.equal(null);
						Expect(tmpCatalog.facet('Book.IDLoose')).to.equal(null);
						Expect(tmpCatalog.column('Book', 'IDLoose')).to.include({ IsInteger: true, Filterable: true });
						Expect(tmpCatalog.warnings()).to.deep.equal([ { Code: 'ForeignKeyWithoutJoin', Entity: 'Book', Column: 'IDLoose' } ]);
						// MaxTermsStringSize moves the bound.
						Expect(newCatalog(tmpModel, { Catalog: { MaxTermsStringSize: 200 } }).facet('Book.Code129')).to.not.equal(null);
					});

				test('Sensitive columns are never returned, filterable or described',
					() =>
					{
						let tmpCatalog = newCatalog(bookstoreModel());
						[ [ 'User', 'Password' ], [ 'Customer', 'ContactEmail' ], [ 'Customer', 'ContactPhone' ], [ 'BookPrice', 'CouponCode' ] ].forEach(
							(pPair) =>
							{
								Expect(tmpCatalog.isSensitive(pPair[0], pPair[1]), pPair.join('.')).to.equal(true);
								Expect(tmpCatalog.column(pPair[0], pPair[1]), pPair.join('.')).to.equal(null);
								Expect(tmpCatalog.facet(pPair.join('.')), pPair.join('.')).to.equal(null);
								Expect(tmpCatalog.filterableColumns(pPair[0])).to.not.include(pPair[1]);
								Expect(JSON.stringify(tmpCatalog.describe(pPair[0], null))).to.not.include(pPair[1]);
							});
						Expect(tmpCatalog.isSensitive('Customer', 'Name')).to.equal(false);
						Expect(tmpCatalog.filterableColumns('User')).to.deep.equal([ 'IDUser', 'GUIDUser', 'LoginID', 'NameFirst', 'NameLast', 'FullName', 'Config' ]);

						// Explicit entries (global 'E.C', bare 'C', per-entity) and IncludeSensitive.
						let tmpOverridden = newCatalog(bookstoreModel(),
							{
								Catalog:
								{
									Sensitive: [ 'Book.ISBN', 'Postal' ],
									Book: { Sensitive: [ 'Genre' ] },
									Customer: { IncludeSensitive: { ContactEmail: 'Customer emails are public in this demo.' } }
								}
							});
						Expect(tmpOverridden.column('Book', 'ISBN')).to.equal(null);
						Expect(tmpOverridden.column('Book', 'Genre')).to.equal(null);
						Expect(tmpOverridden.column('BookStore', 'Postal')).to.equal(null);
						Expect(tmpOverridden.column('Customer', 'Postal')).to.equal(null);
						Expect(tmpOverridden.column('Customer', 'ContactEmail')).to.include({ Filterable: true });
						Expect(tmpOverridden.facet('Customer.ContactEmail')).to.equal(null);
						Expect(tmpOverridden.isSensitive('Customer', 'ContactPhone')).to.equal(true);
					});

				test('structural columns (PK, delete column) are never Sensitive by name pattern',
					() =>
					{
						let tmpModel = { Tables: {} };
						tmpModel.Tables.AccessToken = table('AccessToken',
							[
								{ Column: 'Label', DataType: 'String', Size: '64' },
								{ Column: 'TokenHash', DataType: 'String', Size: '64' }
							]);
						let tmpCatalog = newCatalog(tmpModel);
						Expect(tmpCatalog.column('AccessToken', 'IDAccessToken')).to.include({ IsPK: true });
						Expect(tmpCatalog.column('AccessToken', 'TokenHash')).to.equal(null);
						Expect(tmpCatalog.getFacetable('AccessToken').PK).to.equal('IDAccessToken');
						// An explicit entry still wins.
						Expect(newCatalog(tmpModel, { Catalog: { AccessToken: { Sensitive: [ 'IDAccessToken' ] } } }).column('AccessToken', 'IDAccessToken')).to.equal(null);
					});

				test('column() is a whitelist safe against prototype names',
					() =>
					{
						let tmpCatalog = newCatalog(bookstoreModel());
						[ '__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'Book.Title', null, undefined, 42 ].forEach(
							(pName) =>
							{
								Expect(tmpCatalog.column('Book', pName), String(pName)).to.equal(null);
							});
						Expect(tmpCatalog.column('__proto__', 'Title')).to.equal(null);
						Expect(tmpCatalog.filterableColumns('__proto__')).to.deep.equal([]);
					});

				test('overrides: Exclude, Include, DisplayNames, DisplayName, Intervals, Cardinality, AutoDerive',
					() =>
					{
						let tmpCatalog = newCatalog(bookstoreModel(),
							{
								Catalog:
								{
									Exclude: [ 'Book.Language', 'Review.Nope' ],
									Include: [ 'Book.CreatingIDUser', 'Book.IDBook>BookStore.State' ],
									Book:
									{
										Exclude: [ 'ISBN' ],
										Include: [ 'Title' ],
										DisplayName: 'Library Books',
										DisplayNames: { PublicationYear: 'Published' },
										Intervals: { CreateDate: [ 'quarter', 'year', 'fortnight' ] },
										Cardinality: { Genre: 'Low' }
									}
								}
							});
						Expect(tmpCatalog.facet('Book.Language')).to.equal(null);
						Expect(tmpCatalog.column('Book', 'Language')).to.include({ Facetable: false, Filterable: true });
						Expect(tmpCatalog.facet('Book.ISBN')).to.equal(null);
						Expect(tmpCatalog.facet('Book.CreatingIDUser').Folds).to.deep.equal([ 'Terms', 'Missing', 'DistinctCount' ]);
						Expect(tmpCatalog.facet('Book.Title').DefaultFold).to.equal('Terms');
						Expect(tmpCatalog.getFacetable('Book').DisplayName).to.equal('Library Books');
						Expect(tmpCatalog.facet('Book.PublicationYear').DisplayName).to.equal('Published');
						Expect(tmpCatalog.facet('Book.CreateDate').Intervals).to.deep.equal([ 'quarter', 'year' ]);
						Expect(tmpCatalog.facet('Book.CreateDate').DefaultInterval).to.equal('quarter');
						Expect(tmpCatalog.facet('Book.UpdateDate').Intervals).to.deep.equal([ 'day', 'week', 'month', 'quarter', 'year' ]);
						Expect(tmpCatalog.facet('Book.Genre').Cardinality).to.equal('Low');
						Expect(tmpCatalog.describe('Book', null).Facets.find((pFacet) => { return pFacet.Field === 'Genre'; }).Cardinality).to.equal('Low');
						Expect(tmpCatalog.describe('Book', null).Facets.find((pFacet) => { return pFacet.Field === 'Type'; })).to.not.have.property('Cardinality');
						Expect(tmpCatalog.warnings()).to.deep.include({ Code: 'OverrideNotInMilestone', Entity: 'Book', List: 'Include', Entry: 'IDBook>BookStore.State' });
						Expect(tmpCatalog.warnings()).to.deep.include({ Code: 'ExcludeUnknownColumn', Entity: 'Review', Column: 'Nope' });

						let tmpManual = newCatalog(bookstoreModel(), { Catalog: { AutoDerive: false, Include: [ 'Book.Genre' ] } });
						Expect(tmpManual.getFacetable('Book').Facets.map((pFacet) => { return pFacet.Facet; })).to.deep.equal([ 'Book.Genre' ]);
						Expect(tmpManual.getFacetable('Review').Facets).to.deep.equal([]);
						Expect(tmpManual.column('Review', 'Rating')).to.include({ Filterable: true, Facetable: false });
					});

				test('illegal identifiers are refused and the previous catalog stays in place',
					() =>
					{
						let tmpCatalog = newCatalog(bookstoreModel());
						let tmpVersion = tmpCatalog.modelVersion();
						let tmpBadColumn = bookstoreModel();
						addColumn(tmpBadColumn, 'Book', { Column: 'Bad Name', DataType: 'String', Size: '12' }, 'String');
						let tmpError = null;
						try
						{
							tmpCatalog.rebuild(tmpBadColumn, null);
						}
						catch (pError)
						{
							tmpError = pError;
						}
						Expect(tmpError).to.not.equal(null);
						Expect(tmpError.Code).to.equal('FACET_INTERNAL');
						Expect(tmpCatalog.modelVersion()).to.equal(tmpVersion);
						Expect(tmpCatalog.facet('Book.Language')).to.not.equal(null);

						let tmpBadTable = bookstoreModel();
						tmpBadTable.Tables['Bad;Table'] = table('Bad;Table', []);
						Expect(() => { newCatalog(tmpBadTable); }).to.throw(/not a plain identifier/);
					});

				test('ModelVersion is deterministic and moves with the graph, the catalog options and the policy',
					() =>
					{
						let tmpVersion = newCatalog(bookstoreModel()).modelVersion();
						Expect(tmpVersion).to.match(/^m:[0-9a-f]{12}$/);
						Expect(newCatalog(bookstoreModel()).modelVersion()).to.equal(tmpVersion);
						Expect(newCatalog(bookstoreModel(), { Limits: { MaxTop: 5 } }).modelVersion()).to.equal(tmpVersion);
						Expect(newCatalog(bookstoreModel(), { Catalog: { Book: { Exclude: [ 'Genre' ] } } }).modelVersion()).to.not.equal(tmpVersion);
						let tmpRejoined = bookstoreModel();
						tmpRejoined.Tables.Review.Columns.find((pColumn) => { return pColumn.Column === 'IDUser'; }).Join = 'IDAuthor';
						Expect(newCatalog(tmpRejoined).modelVersion()).to.not.equal(tmpVersion);
					});

				test('the catalog registers and refreshes the Graph service it depends on',
					() =>
					{
						let tmpFable = newFable();
						let tmpCatalog = new libRetoldFacetingCatalog(tmpFable, {});
						Expect(tmpFable.RetoldFacetingGraph).to.equal(undefined);
						let tmpModel = bookstoreModel();
						tmpCatalog.rebuild(tmpModel, null);
						Expect(tmpFable.RetoldFacetingGraph).to.be.an('object');
						Expect(tmpFable.RetoldFacetingGraph.builtFrom()).to.equal(tmpModel);
						let tmpOther = bookstoreModel();
						tmpCatalog.rebuild(tmpOther, null);
						Expect(tmpFable.RetoldFacetingGraph.builtFrom()).to.equal(tmpOther);
						tmpCatalog.rebuild(null, null);
						Expect(tmpCatalog.entities()).to.deep.equal([]);
						Expect(tmpCatalog.describe('Book', null)).to.equal(null);
					});

				test('describe() returns the 02 §7 entity block without internal fields',
					() =>
					{
						let tmpCatalog = newCatalog(bookstoreModel());
						let tmpDescribe = tmpCatalog.describe('BookStoreSale', null);
						Expect(Object.keys(tmpDescribe)).to.deep.equal([ 'Entity', 'DisplayName', 'ScopeAssurance', 'Facets', 'Scopes', 'Dates', 'Numeric', 'Categorical' ]);
						Expect(tmpDescribe.DisplayName).to.equal('Book Store Sales');
						Expect(tmpDescribe.Scopes).to.deep.equal([]);
						Expect(tmpDescribe.Dates).to.deep.equal([ 'CreateDate', 'UpdateDate', 'SaleDate' ]);
						Expect(tmpDescribe.Numeric).to.deep.equal([ 'TotalAmount' ]);
						Expect(tmpDescribe.Categorical).to.deep.equal([ 'PaymentMethod', 'TransactionID', 'IDBookStore', 'IDUser', 'IDCustomer' ]);
						let tmpStore = tmpDescribe.Facets.find((pFacet) => { return pFacet.Facet === 'BookStoreSale.IDBookStore'; });
						Expect(tmpStore).to.deep.equal(
							{
								Facet: 'BookStoreSale.IDBookStore', Field: 'IDBookStore', DisplayName: 'Book Store', DataType: 'Numeric',
								Folds: [ 'Terms', 'Missing', 'DistinctCount' ], DefaultFold: 'Terms', ClauseType: 'DistinctSelectedValueList', FilterKey: 'IDBookStore',
								Target: 'BookStore', Labels: true, Selectable: true, Engines: [ 'Live' ], Auto: true
							});
						let tmpText = JSON.stringify(tmpDescribe);
						Expect(tmpText).to.not.include('LabelLookup');
						Expect(tmpText).to.not.include('SizeClass');
						// Describe output is a copy: mutating it never touches the catalog.
						tmpDescribe.Facets[0].Folds.push('Bogus');
						Expect(tmpCatalog.facet(tmpDescribe.Facets[0].Facet).Folds).to.not.include('Bogus');
						Expect(tmpCatalog.describe('Nope', null)).to.equal(null);
					});
			}
		);

		suite
		(
			'Catalog with a RetoldFacetingHostDataService',
			() =>
			{
				test('no policy: every routed entity is facetable and Unscoped',
					(fDone) =>
					{
						hostedCatalog(bookstoreModel(), {},
							(pError, pHosted) =>
							{
								Expect(pError).to.equal(null);
								Expect(pHosted.catalog.entities().length).to.equal(13);
								Expect(pHosted.catalog.getFacetable('Review').ScopeAssurance).to.equal('Unscoped');
								Expect(pHosted.catalog.column('Review', 'Deleted').IsDeleteColumn).to.equal(true);
								Expect(pHosted.catalog.getFacetable('Review').PK).to.equal('IDReview');
								return fDone();
							});
					});

				test('a tenancy policy: the policy column is filterable but never a facet; unscoped entities need GlobalEntities',
					(fDone) =>
					{
						let tmpOptions = { Scope: { Policy: { Column: 'IDTenant', SessionField: 'IDTenant' } } };
						hostedCatalog(tenantModel([ 'BookStoreCatalogJoin' ]), tmpOptions,
							(pError, pHosted) =>
							{
								Expect(pError).to.equal(null);
								let tmpCatalog = pHosted.catalog;
								Expect(tmpCatalog.entities()).to.not.include('BookStoreCatalogJoin');
								Expect(tmpCatalog.column('Book', 'IDTenant')).to.include({ IsPolicyColumn: true, Filterable: true, Facetable: false });
								Expect(tmpCatalog.facet('Book.IDTenant')).to.equal(null);
								Expect(tmpCatalog.getFacetable('Book').ScopeAssurance).to.equal('Guarded');
								// The tenancy column is structural: never Sensitive by pattern, never a Graph bridge payload.
								Expect(tmpCatalog.isSensitive('Book', 'IDTenant')).to.equal(false);
								Expect(pHosted.fable.RetoldFacetingGraph.isBridge('BookAuthorJoin')).to.equal(true);

								let tmpGlobalOptions = { Scope: { Policy: { Column: 'IDTenant', SessionField: 'IDTenant' } }, Catalog: { GlobalEntities: [ 'BookStoreCatalogJoin' ] } };
								hostedCatalog(tenantModel([ 'BookStoreCatalogJoin' ]), tmpGlobalOptions,
									(pGlobalError, pGlobalHosted) =>
									{
										Expect(pGlobalError).to.equal(null);
										Expect(pGlobalHosted.catalog.entities()).to.include('BookStoreCatalogJoin');
										Expect(pGlobalHosted.catalog.getFacetable('BookStoreCatalogJoin').ScopeAssurance).to.equal('Global');
										Expect(pGlobalHosted.catalog.modelVersion()).to.not.equal(tmpCatalog.modelVersion());
										return fDone();
									});
							});
					});

				test('PersonalScopes and Required columns are policy columns too',
					(fDone) =>
					{
						let tmpOptions = (
							{
								Scope:
								{
									Policy: { Column: 'IDTenant', SessionField: 'IDTenant', PersonalScopes: { Review: { Column: 'IDUser', SessionField: 'UserID' } } },
									Required: { BookStoreSale: [ { Column: 'IDCustomer', From: '$CurrentUser.IDCustomer' } ] }
								}
							});
						hostedCatalog(tenantModel(), tmpOptions,
							(pError, pHosted) =>
							{
								Expect(pError).to.equal(null);
								Expect(pHosted.catalog.facet('Review.IDUser')).to.equal(null);
								Expect(pHosted.catalog.column('Review', 'IDUser').IsPolicyColumn).to.equal(true);
								Expect(pHosted.catalog.facet('BookStoreSale.IDCustomer')).to.equal(null);
								// Only where the policy names them.
								Expect(pHosted.catalog.facet('BookStoreSale.IDUser')).to.not.equal(null);
								Expect(pHosted.catalog.facet('BookStoreEmployee.IDCustomer')).to.not.equal(null);
								return fDone();
							});
					});

				test('describe() hides entities and FK targets the principal cannot facet',
					(fDone) =>
					{
						hostedCatalog(bookstoreModel(), { Catalog: { NeverFacet: [ 'BookStore' ] } },
							(pError, pHosted) =>
							{
								Expect(pError).to.equal(null);
								let tmpCatalog = pHosted.catalog;
								Expect(tmpCatalog.getFacetable('BookStore')).to.equal(null);
								Expect(tmpCatalog.describe('BookStore', null)).to.equal(null);
								// The FK facet stays (its DepSet is the pivot only) but its Target is not disclosed.
								Expect(tmpCatalog.facet('BookStoreSale.IDBookStore').Target).to.equal('BookStore');
								let tmpFacet = tmpCatalog.describe('BookStoreSale', null).Facets.find((pEntry) => { return pEntry.Field === 'IDBookStore'; });
								Expect(tmpFacet).to.not.have.property('Target');
								Expect(tmpCatalog.describe('BookStoreSale', null).Facets.find((pEntry) => { return pEntry.Field === 'IDUser'; }).Target).to.equal('User');
								return fDone();
							});
					});

				test('a host model reload can drive a catalog rebuild (onModelChanged)',
					(fDone) =>
					{
						hostedCatalog(bookstoreModel(), {},
							(pError, pHosted) =>
							{
								Expect(pError).to.equal(null);
								let tmpBefore = pHosted.catalog.modelVersion();
								let tmpSeen = [];
								pHosted.host.onModelChanged(
									(pModel) =>
									{
										tmpSeen.push(Object.keys(pModel.Tables).length);
										pHosted.catalog.rebuild(pModel, pHosted.host);
									});
								let tmpExtra = { Tables: { Gadget: table('Gadget', [ { Column: 'Color', DataType: 'String', Size: '16' } ]) } };
								pHosted.rds.loadModel('Extra', tmpExtra, 'SQLite',
									(pLoadError) =>
									{
										Expect(pLoadError).to.equal(undefined);
										Expect(tmpSeen).to.deep.equal([ 14 ]);
										Expect(pHosted.catalog.facet('Gadget.Color')).to.not.equal(null);
										Expect(pHosted.catalog.modelVersion()).to.not.equal(tmpBefore);
										return fDone();
									});
							});
					});
			}
		);
	}
);
