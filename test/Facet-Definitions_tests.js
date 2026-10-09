/**
 * Definitions tests (internal-contracts §20, §21, §29, §30.1, §34): the DefinitionRegistry
 * (schema vs ajv, every load-time reason, disabled dependents, nothing partial, canonical E1 / E3A /
 * E3B forms, CheckParent forcing, hashes, PathAuto), Graph.resolvePath, the Catalog's
 * ModelVersion / Describe additions, and the §29 post-processing as pure functions.
 *
 * Pure in-process: no server (registry port 19120 is reserved for this file but unused).  The
 * domains are the ProjectTrack / LabTrack models with their seed modules' scope policies, applied
 * through a minimal host (isFacetable + getScopePolicy).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;
const libPath = require('path');

// ajv 6 from the umbrella node_modules (a test-only cross-check of the built-in schema validator) is
// required lazily: the umbrella only has it transitively, and its absence must not abort `npm test`.
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

const libOptions = require('../source/Retold-Faceting-Service-Options.js');
const libRetoldFacetingGraph = require('../source/catalog/Retold-Faceting-Graph.js');
const libRetoldFacetingCatalog = require('../source/catalog/Retold-Faceting-Catalog.js');
const libRetoldFacetingDefinitionRegistry = require('../source/catalog/Retold-Faceting-DefinitionRegistry.js');
const libRetoldFacetingClauseCompiler = require('../source/request/Retold-Faceting-ClauseCompiler.js');
const libRetoldFacetingHostBase = require('../source/host/Retold-Faceting-Host-Base.js');
const libFacetEnvelope = require('../source/contract/Facet-Contract-Envelope.js');
const libFacetBuckets = require('../source/contract/Facet-Contract-Buckets.js');
const libFacetClauses = require('../source/contract/Facet-Contract-Clauses.js');

const libBuilders = require('./support/Facet-Test-Builders.js');
const libProjectTrackSeed = require('./fixtures/ProjectTrack-Seed.js');
const libLabTrackSeed = require('./fixtures/LabTrack-Seed.js');

const DEFINITION_SCHEMA = libRetoldFacetingDefinitionRegistry.DEFINITION_SCHEMA;
const DIRECTORY_FIXTURE = libPath.resolve(__dirname, 'fixtures', 'Definitions-Dir-Fixture');

const newFable = () => { return libBuilders.newFable('RetoldFacetingDefinitionsTests'); };

/**
 * A Graph + Catalog + ClauseCompiler + DefinitionRegistry on one fable, for a domain seed module:
 * the seed's FACETING_OPTIONS (deep-merged with pOptions.Faceting), its scope policy through a
 * minimal host, the model (optionally mutated by pOptions.Model).  The registry is NOT loaded.
 *
 * @param {Record<string, any>} pSeed - ProjectTrack-Seed / LabTrack-Seed
 * @param {{ Faceting?: Record<string, any>, Model?: function, NoHost?: boolean }} [pOptions]
 * @return {Record<string, any>}
 */
const domainEnvironment = (pSeed, pOptions) =>
{
	let tmpOptionsIn = pOptions || {};
	let tmpOptions = libOptions.resolve(libOptions.deepMerge(pSeed.FACETING_OPTIONS, tmpOptionsIn.Faceting || {}));
	let tmpFable = newFable();
	let tmpLogged = [];
	tmpFable.log.error = (pMessage) => { tmpLogged.push(String(pMessage)); };
	let tmpModel = pSeed.model();
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
	let tmpHost = tmpOptionsIn.NoHost ? null : (
		{
			isFacetable: (pEntity) => { return tmpPolicy.isScoped(pEntity) || (tmpGlobal.indexOf(pEntity) >= 0); },
			getScopePolicy: () => { return tmpPolicy; }
		});
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
	return (
		{
			fable: tmpFable, options: tmpOptions, model: tmpModel, policy: tmpPolicy, host: tmpHost, logged: tmpLogged,
			graph: tmpFable.RetoldFacetingGraph, catalog: tmpFable.RetoldFacetingCatalog, registry: tmpFable.RetoldFacetingDefinitionRegistry
		});
};

/**
 * A domain environment whose registry loaded only these definitions objects.
 *
 * @param {Record<string, any>} pSeed
 * @param {Array<Record<string, any>>} pObjects
 * @param {Record<string, any>} [pOptions]
 * @return {Record<string, any>} the environment plus .result (the load result)
 */
const loadObjects = (pSeed, pObjects, pOptions) =>
{
	let tmpEnvironment = domainEnvironment(pSeed, pOptions);
	tmpEnvironment.result = tmpEnvironment.registry.load({ Path: false, Files: [], Objects: pObjects });
	return tmpEnvironment;
};

/**
 * The domain environment with the domain's own definitions file loaded (FACETING_OPTIONS.Definitions).
 *
 * @param {Record<string, any>} pSeed
 * @param {Record<string, any>} [pOptions]
 * @return {Record<string, any>}
 */
const loadDomain = (pSeed, pOptions) =>
{
	let tmpEnvironment = domainEnvironment(pSeed, pOptions);
	tmpEnvironment.result = tmpEnvironment.registry.load(tmpEnvironment.options.Definitions);
	return tmpEnvironment;
};

/**
 * The disabled entry named pName (null when not disabled).
 *
 * @param {Record<string, any>} pEnvironment
 * @param {string} pName
 * @return {Record<string, any>|null}
 */
const disabledEntry = (pEnvironment, pName) =>
{
	return pEnvironment.registry.disabled().find((pEntry) => { return pEntry.Name === pName; }) || null;
};

/**
 * Expect pName disabled with pReason (and optionally the pointer and the logged line).
 *
 * @param {Record<string, any>} pEnvironment
 * @param {string} pName
 * @param {string} pReason
 * @param {Record<string, any>} [pMore] - more error fields to match (Pointer, DependsOn, Step, Field, Entity)
 * @return {Record<string, any>} the error
 */
const expectDisabled = (pEnvironment, pName, pReason, pMore) =>
{
	let tmpEntry = disabledEntry(pEnvironment, pName);
	Expect(tmpEntry, `${pName} should be disabled`).to.be.an('object');
	Expect(tmpEntry.Errors[0].Code).to.equal('FACET_DEFINITION_INVALID');
	Expect(tmpEntry.Errors[0].Reason, `${pName} reason`).to.equal(pReason);
	if (pMore)
	{
		Expect(tmpEntry.Errors[0]).to.include(pMore);
	}
	// Logged once, with the reason and never a value.
	Expect(pEnvironment.logged.filter((pLine) => { return (pLine.indexOf(JSON.stringify(pName)) >= 0) && (pLine.indexOf(pReason) >= 0); }).length, `${pName} logged`).to.equal(1);
	return tmpEntry.Errors[0];
};

/**
 * A PathPlan reduced to its step strings (for compact expectations).
 *
 * @param {Record<string, any>} pPlan
 * @return {Array<string>}
 */
const stepsOf = (pPlan) =>
{
	return pPlan.Steps.map((pStep) => { return pStep.Raw; });
};

/**
 * A copy of a canonical predicate with every PathPlan replaced by its Signature and step flags
 * (CheckParent, TenantOnly, step Where), so expectations stay readable.
 *
 * @param {any} pValue
 * @return {any}
 */
const compact = (pValue) =>
{
	return JSON.parse(JSON.stringify(pValue,
		(pKey, pEntry) =>
		{
			if ((pEntry !== null) && (typeof(pEntry) === 'object') && !Array.isArray(pEntry) && Array.isArray(pEntry.Steps) && (typeof(pEntry.Signature) === 'string'))
			{
				let tmpFlags = [];
				pEntry.Steps.forEach(
					(pStep) =>
					{
						if (pStep.CheckParent)
						{
							tmpFlags.push(`${pStep.Index}:CheckParent`);
						}
						if (pStep.Scope === 'TenantOnly')
						{
							tmpFlags.push(`${pStep.Index}:TenantOnly`);
						}
						if (pStep.Where)
						{
							tmpFlags.push(`${pStep.Index}:Where=${JSON.stringify(pStep.Where)}`);
						}
					});
				return (tmpFlags.length > 0) ? `${pEntry.Signature} [${tmpFlags.join(' ')}]` : pEntry.Signature;
			}
			return pEntry;
		}));
};

/**
 * One definitions object holding one facet.
 *
 * @param {Record<string, any>} pFacet
 * @param {Record<string, any>} [pMore] - other sections (Scopes, Aliases)
 * @return {Record<string, any>}
 */
const facetFile = (pFacet, pMore) =>
{
	return Object.assign({ FormatVersion: 1, Facets: [ Object.assign({ Version: 1 }, pFacet) ] }, pMore || {});
};

/**
 * One definitions object holding scopes.
 *
 * @param {Record<string, any>} pScopes
 * @param {Record<string, any>} [pMore]
 * @return {Record<string, any>}
 */
const scopeFile = (pScopes, pMore) =>
{
	return Object.assign({ FormatVersion: 1, Scopes: pScopes }, pMore || {});
};

/**
 * A simple Project scope Where (one leaf) used as a valid baseline.
 */
const ACTIVE_WHERE = [ { Field: 'Status', Op: 'EQ', Value: 'Active' } ];

// ---------------------------------------------------------------- ajv

let _AJV = null;

/**
 * ajv's verdict for a value against the root schema or one '#/definitions/X' (only called by the
 * cross-check tests, which skip themselves when ajv is not installed).
 *
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
		_AJV.addSchema(DEFINITION_SCHEMA);
	}
	return _AJV.validate({ $ref: DEFINITION_SCHEMA.$id + (pRef || '#') }, pValue);
};

/**
 * Skip an ajv cross-check test (with its reason) when ajv is not installed.
 *
 * @param {any} pTest - mocha's this
 */
const requireAjv = (pTest) =>
{
	if (!AJV_AVAILABLE)
	{
		// eslint-disable-next-line no-console
		console.log('      (ajv is not installed in the umbrella node_modules: the cross-check is skipped; the built-in validator is still tested below)');
		pTest.skip();
	}
};

suite
(
	'Facet-Definitions',
	() =>
	{
		suite
		(
			'Definitions schema: the built-in validator agrees with ajv',
			() =>
			{
				test('both domain definitions files are valid (whole file and every entry), on both validators',
					function ()
					{
						requireAjv(this);
						[ libProjectTrackSeed, libLabTrackSeed ].forEach(
							(pSeed) =>
							{
								let tmpFile = require(pSeed.DEFINITIONS_PATH);
								Expect(libRetoldFacetingDefinitionRegistry.validateSchema(tmpFile)).to.equal(null);
								Expect(ajvValid(tmpFile)).to.equal(true);
								Object.keys(tmpFile.Scopes || {}).forEach(
									(pName) =>
									{
										Expect(libRetoldFacetingDefinitionRegistry.validateSchema(tmpFile.Scopes[pName], '#/definitions/ScopeDefinition')).to.equal(null);
										Expect(ajvValid(tmpFile.Scopes[pName], '#/definitions/ScopeDefinition')).to.equal(true);
									});
								(tmpFile.Facets || []).forEach(
									(pFacet) =>
									{
										Expect(libRetoldFacetingDefinitionRegistry.validateSchema(pFacet, '#/definitions/FacetDefinition')).to.equal(null);
										Expect(ajvValid(pFacet, '#/definitions/FacetDefinition')).to.equal(true);
									});
								Object.keys(tmpFile.Aliases || {}).forEach(
									(pName) =>
									{
										Expect(libRetoldFacetingDefinitionRegistry.validateSchema(tmpFile.Aliases[pName], '#/definitions/Path')).to.equal(null);
										Expect(ajvValid(tmpFile.Aliases[pName], '#/definitions/Path')).to.equal(true);
									});
							});
					});

				test('negative probes: both validators refuse, and the built-in one names where',
					function ()
					{
						requireAjv(this);
						let tmpLeaf = (pPred) => { return { FormatVersion: 1, Scopes: { 'Project.X': { Entity: 'Project', Where: [ pPred ] } } }; };
						let tmpFacet = (pFacet) => { return { FormatVersion: 1, Facets: [ Object.assign({ Facet: 'Project.X', Version: 1, Dimensions: [ { Kind: 'Terms', Field: 'Status' } ] }, pFacet) ] }; };
						let tmpProbes =
							[
								[ {}, '' ],
								[ { FormatVersion: 2 }, '/FormatVersion' ],
								[ { FormatVersion: 1, Bogus: true }, '/Bogus' ],
								[ { FormatVersion: 1, Facets: [ { Facet: 'Project.X', Version: 1 } ] }, '/Facets/0' ],
								[ tmpFacet({ Dimensions: [ { Kind: 'Terms' }, { Kind: 'Terms' }, { Kind: 'Terms' } ] }), '/Facets/0/Dimensions' ],
								[ tmpFacet({ Dimensions: [ { Kind: 'Bogus' } ] }), '/Facets/0/Dimensions/0/Kind' ],
								[ tmpFacet({ Version: 0 }), '/Facets/0/Version' ],
								[ tmpFacet({ Facet: 'Project.Bad Name' }), '/Facets/0/Facet' ],
								[ tmpFacet({ Labels: true }), '/Facets/0/Labels' ],
								[ tmpFacet({ Exclude: 'Group:' }), '/Facets/0/Exclude' ],
								[ tmpFacet({ Params: { P: { Type: 'String', MaxLength: 2000 } } }), '/Facets/0/Params/P/MaxLength' ],
								[ tmpFacet({ Dimensions: [ { Kind: 'Ranges', Field: 'StartDate', Ranges: [ { Key: '' } ] } ] }), '/Facets/0/Dimensions/0/Ranges/0/Key' ],
								[ tmpFacet({ Pivot: { Tuple: { From: [ { As: 'i', Entity: 'Project' } ], On: [ [ 'i.IDProject', 'i.IDProject' ] ], Key: [ 'i.IDProject' ] } } }), '/Facets/0/Pivot' ],
								[ tmpFacet({ Pivot: { Tuple: { From: [ { As: 'Bad', Entity: 'Project' }, { As: 'r', Entity: 'Task' } ], On: [ [ 'Bad.IDProject', 'r.IDProject' ] ], Key: [ 'r.IDTask' ] } } }), '/Facets/0/Pivot' ],
								[ { FormatVersion: 1, Scopes: { 'Project.X': { Entity: 'Project', Where: [] } } }, '/Scopes/Project.X/Where' ],
								[ tmpLeaf({ Field: 'Status', Op: 'BOGUS', Value: 1 }), '/Scopes/Project.X/Where/0/Op' ],
								[ tmpLeaf({ Field: 'Status', Op: 'EQ', Value: 'A', And: [] }), '/Scopes/Project.X/Where/0' ],
								[ tmpLeaf({ Field: 'Status', Op: 'EQ', Value: { Nested: 1 } }), '/Scopes/Project.X/Where/0/Value' ],
								[ tmpLeaf({ Exists: { Path: [ '>Project' ] } }), '/Scopes/Project.X/Where/0/Exists/Path' ],
								[ tmpLeaf({ Exists: { Path: [ { Step: '>Project.IDClient', Bogus: 1 } ] } }), '/Scopes/Project.X/Where/0/Exists/Path' ],
								[ tmpLeaf({ Exists: { Path: [ '<Task.IDProject' ], Correlate: [ [ 'IDProject', 'IDProject', 'IDProject' ] ] } }), '/Scopes/Project.X/Where/0/Exists/Correlate/0' ],
								[ tmpLeaf({ HavingCount: { Path: [ '<Task.IDProject' ], Op: 'GE', Value: -1 } }), '/Scopes/Project.X/Where/0/HavingCount/Value' ],
								[ { FormatVersion: 1, Aliases: { 'bad name': [ '<Task.IDProject' ] } }, '/Aliases' ],
								[ { FormatVersion: 1, Scopes: { 'NoDot': { Entity: 'Project', Where: ACTIVE_WHERE } } }, '/Scopes' ]
							];
						tmpProbes.forEach(
							(pProbe, pIndex) =>
							{
								let tmpError = libRetoldFacetingDefinitionRegistry.validateSchema(pProbe[0]);
								Expect(tmpError, `probe ${pIndex}`).to.be.an('object');
								Expect(tmpError.Pointer.indexOf(pProbe[1]), `probe ${pIndex} pointer ${tmpError.Pointer}`).to.equal(0);
								Expect(ajvValid(pProbe[0]), `ajv probe ${pIndex}`).to.equal(false);
							});
					});

				test('positive variants: both validators accept every authoring form of 01 §4',
					function ()
					{
						requireAjv(this);
						let tmpFile =
							{
								FormatVersion: 1,
								Description: 'every form',
								Catalog: { Project: { Exclude: [ 'Name' ] } },
								Expressions: { 'Task.IsOverdue': { Op: 'lt', Args: [] } },
								Aliases: { A: '<Task.IDProject', B: [ '@A', { Step: '>Task.IDProject', Where: [ { Field: 'Status', Op: 'NE', Value: 'Done' } ], CheckParent: false, Elide: true } ] },
								Scopes:
									{
										'Project.All':
											{
												Entity: 'Project',
												Params: { R: { Type: 'EnumList', Values: [ 'a', 'b' ], Default: [ 'a' ] }, N: { Type: 'Integer', Min: 0, Max: 9 }, S: { Type: 'String', MaxLength: 10 }, B: { Type: 'Boolean' }, D: { Type: 'DateTime' } },
												Where:
													[
														{ Not: { Any: [ { Field: 'Status', Op: 'NULL' }, { Scope: 'Project.Other', Params: { X: 1 } } ] } },
														{ All: { Path: [ '<Task.IDProject' ], Where: [ { Field: 'Status', Op: 'EQ', Value: 'Done' } ] } },
														{ AllNonEmpty: { Path: '<Task.IDProject' } },
														{ Exists: { Path: [ { Via: 'Task.IDProject', To: 'Issue.IDProject', CheckParent: true, Scope: 'TenantOnly', ScopeReason: 'why' } ] } },
														{ HavingCount: { Path: [ '<Task.IDProject' ], Op: 'GE', Value: 0, Correlate: [ [ 'IDProject', 'IDProject' ] ] } },
														{ Expr: 'Task.IsOverdue', Op: 'EQ', Value: 1 },
														{ Field: 'Status', Op: 'IN', Value: [ 'a', null, 2, true ] }
													]
											}
									},
								Facets:
									[
										{
											Facet: 'Project.Every', Version: 3, Title: 't', Description: 'd', DisplayName: 'n', Pivot: 'Project', Home: 'Project',
											Where: [ { Scope: 'Project.All' } ],
											Dimensions: [ { Kind: 'Terms', Field: 'Status', Labels: false, Top: 5, Order: 'KeyAsc', Missing: false }, { Kind: 'DateHistogram', Field: 'StartDate', Interval: 'week', EmptyBuckets: false, Bounds: 'Data', TimeZone: 'UTC' } ],
											Siblings:
												{
													Band: { Kind: 'ChildRollup', Child: { Path: [ '<Task.IDProject' ], Agg: 'count', Where: [] }, Edges: [ 1, 2 ], Labels: { 0: 'none' } },
													Split: { Kind: 'ExistsSplit', Path: [ '<Issue.IDProject' ], Labels: { true: 'y', false: 'n' } },
													Hist: { Kind: 'NumericHistogram', Field: 'IDClient', Mode: 'Edges', Edges: [ 0, 1.5, 10 ], OpenEnded: true },
													Rng: { Kind: 'Ranges', Field: 'IDClient', Ranges: [ { Key: 'lo', To: 3, Label: 'Low' }, { Key: 'hi', From: 3, To: null } ] },
													Lbl: { Kind: 'Terms', Field: 'IDClient', Labels: { Path: [ '>Project.IDClient' ], Field: 'Name' } },
													Exp: { Kind: 'Terms', Expr: 'Project.Decade' }
												},
											Measures: [ { Op: 'count' } ], CountMode: 'Rows', Exclude: [ 'c1', 'Hash-1' ], FilterKey: 'Every', ClauseType: 'X', Selectable: true,
											Missing: { Values: [ null, '' ] }, Labels: { Path: '>Project.IDClient', Field: 'Name' }, Params: { P: { Type: 'Enum', Values: [ 1, 2 ] } },
											Engines: {}, Freshness: {}, Limits: {}, Visibility: {}, Records: {}
										},
										{ Facet: 'Project.Union', Version: 1, Pivot: { Union: [], MergeBy: 'Key' }, Dimensions: [ { Kind: 'Terms', Field: 'Status' } ], ExcludeGroup: 'G', Exclude: 'Group:G' }
									]
							};
						Expect(libRetoldFacetingDefinitionRegistry.validateSchema(tmpFile)).to.equal(null);
						Expect(ajvValid(tmpFile)).to.equal(true);
					});

				test('the envelope check alone (sections typed, entries validated one by one)',
					() =>
					{
						Expect(libRetoldFacetingDefinitionRegistry.validateEnvelope({ FormatVersion: 1, Facets: [ 42 ], Scopes: { x: 1 } })).to.equal(null);
						Expect(libRetoldFacetingDefinitionRegistry.validateEnvelope({ FormatVersion: 1, Facets: {} }).Pointer).to.equal('/Facets');
						Expect(libRetoldFacetingDefinitionRegistry.validateEnvelope([]).Keyword).to.equal('type');
					});
			}
		);

		suite
		(
			'Graph.resolvePath (internal-contracts §21)',
			() =>
			{
				let tmpLab = domainEnvironment(libLabTrackSeed);
				let tmpGraph = tmpLab.graph;

				test('forward, reverse and co-reference steps: On pairs, cardinality, signature',
					() =>
					{
						let tmpForward = tmpGraph.resolvePath('MaterialIntakeRequirement', [ '>MaterialIntakeRequirement.IDMaterialIntake', '>MaterialIntake.IDLabQueue' ]);
						Expect(tmpForward).to.include({ From: 'MaterialIntakeRequirement', To: 'LabQueue', Hops: 2, ToOne: true, Signature: '>MaterialIntakeRequirement.IDMaterialIntake >MaterialIntake.IDLabQueue' });
						Expect(tmpForward.Steps[1]).to.deep.equal(
							{
								Index: 1, Raw: '>MaterialIntake.IDLabQueue', Direction: 'Forward', Edge: 'MaterialIntake.IDLabQueue', From: 'MaterialIntake', To: 'LabQueue',
								On: [ [ 'IDLabQueue', 'IDLabQueue' ] ], Via: null, Parent: null, CheckParent: false, Cardinality: 'ToOne',
								Where: null, Scope: 'Inherit', ScopeReason: null, Elide: false, As: null
							});
						let tmpReverse = tmpGraph.resolvePath('LabQueue', [ '<LabQueueMember.IDLabQueue' ]);
						Expect(tmpReverse.Steps[0]).to.include({ Direction: 'Reverse', From: 'LabQueue', To: 'LabQueueMember', Cardinality: 'ToMany' });
						Expect(tmpReverse.Steps[0].On).to.deep.equal([ [ 'IDLabQueue', 'IDLabQueue' ] ]);
						Expect(tmpReverse.ToOne).to.equal(false);
						let tmpCoReference = tmpGraph.resolvePath('MaterialIntakeRequirement', [ { Step: '=LabForm.IDMaterialIntake', Scope: 'TenantOnly', ScopeReason: 'why', Where: [ { Field: 'Status' } ], As: 'f' } ]);
						Expect(tmpCoReference.Steps[0]).to.include(
							{
								Direction: 'CoReference', Edge: 'LabForm.IDMaterialIntake', From: 'MaterialIntakeRequirement', To: 'LabForm',
								Via: 'MaterialIntakeRequirement.IDMaterialIntake', Parent: 'MaterialIntake', CheckParent: false, Cardinality: 'ToMany',
								Scope: 'TenantOnly', ScopeReason: 'why', As: 'f'
							});
						// Step Where lists are carried as authored (the registry canonicalizes them).
						Expect(tmpCoReference.Steps[0].Where).to.deep.equal([ { Field: 'Status' } ]);
						Expect(tmpGraph.pathSignature(tmpCoReference)).to.equal('=LabForm.IDMaterialIntake');
						// The space-separated string is sugar for the array.
						Expect(tmpGraph.resolvePath('MaterialIntake', '>MaterialIntake.IDLabQueue  <LabQueueMember.IDLabQueue').Signature).to.equal('>MaterialIntake.IDLabQueue <LabQueueMember.IDLabQueue');
						// A self co-reference (sibling rows of the same parent).
						Expect(tmpGraph.resolvePath('LabForm', [ '=LabForm.IDMaterialIntake' ]).Steps[0].On).to.deep.equal([ [ 'IDMaterialIntake', 'IDMaterialIntake' ] ]);
						// CheckParent only means something on a co-reference.
						Expect(tmpGraph.resolvePath('MaterialIntake', [ { Step: '>MaterialIntake.IDLabQueue', CheckParent: true } ]).Steps[0].CheckParent).to.equal(false);
					});

				test('aliases: declared (Map or object), bridge, nested, unknown, cycle; MaxHops counts spliced steps',
					() =>
					{
						Expect(tmpGraph.alias('MaterialIntake~LabFormType')).to.deep.equal([ '<MaterialIntakeRequirement.IDMaterialIntake', '>MaterialIntakeRequirement.IDLabFormType' ]);
						Expect(stepsOf(tmpGraph.resolvePath('MaterialIntake', '@MaterialIntake~LabFormType'))).to.deep.equal([ '<MaterialIntakeRequirement.IDMaterialIntake', '>MaterialIntakeRequirement.IDLabFormType' ]);
						let tmpAliases = new Map([ [ 'Queue', [ '>MaterialIntake.IDLabQueue' ] ], [ 'QueueMembers', [ '@Queue', '<LabQueueMember.IDLabQueue' ] ] ]);
						Expect(stepsOf(tmpGraph.resolvePath('MaterialIntake', [ '@QueueMembers' ], { Aliases: tmpAliases }))).to.deep.equal([ '>MaterialIntake.IDLabQueue', '<LabQueueMember.IDLabQueue' ]);
						Expect(stepsOf(tmpGraph.resolvePath('MaterialIntake', [ '@Q' ], { Aliases: { Q: '>MaterialIntake.IDLabQueue' } }))).to.deep.equal([ '>MaterialIntake.IDLabQueue' ]);
						let fReason = (fCall) =>
						{
							try
							{
								fCall();
							}
							catch (pError)
							{
								Expect(pError.Code).to.equal('FACET_DEFINITION_INVALID');
								return pError.Detail;
							}
							return null;
						};
						Expect(fReason(() => { tmpGraph.resolvePath('MaterialIntake', [ '>MaterialIntake.IDLabQueue', '@Nope' ]); })).to.include({ Reason: 'UnknownAlias', Step: 1 });
						Expect(fReason(() => { tmpGraph.resolvePath('MaterialIntake', [ '@A' ], { Aliases: { A: [ '@B' ], B: [ '@A' ] } }); })).to.include({ Reason: 'AliasCycle' });
						Expect(fReason(() => { tmpGraph.resolvePath('MaterialIntake', [ '@QueueMembers', '@QueueMembers', '>LabQueueMember.IDLabQueue' ], { Aliases: tmpAliases }); })).to.include({ Reason: 'TooManyHops', Step: 4 });
						Expect(tmpGraph.resolvePath('MaterialIntake', [ '@QueueMembers', '>LabQueueMember.IDLabQueue', '<LabQueueMember.IDLabQueue' ], { Aliases: tmpAliases }).Hops).to.equal(4);
						Expect(fReason(() => { tmpGraph.resolvePath('MaterialIntake', [ '>MaterialIntake.IDLabQueue', '<LabQueueMember.IDLabQueue' ], { MaxHops: 1 }); })).to.include({ Reason: 'TooManyHops', Step: 1 });
					});

				test('structural errors carry the reason and the step index after splicing',
					() =>
					{
						let fReason = (pFrom, pSteps, pOptions) =>
						{
							try
							{
								tmpGraph.resolvePath(pFrom, pSteps, pOptions);
							}
							catch (pError)
							{
								return pError.Detail;
							}
							return null;
						};
						Expect(fReason('MaterialIntake', [ '<MaterialIntake.IDLabQueue' ])).to.include({ Reason: 'WrongStart', Step: 0 });
						Expect(fReason('MaterialIntake', [ '>MaterialIntake.IDLabQueue', '>MaterialIntake.IDLabQueue' ])).to.include({ Reason: 'WrongStart', Step: 1 });
						Expect(fReason('MaterialIntake', [ '>MaterialIntake.Nope' ])).to.include({ Reason: 'UnknownEdge', Step: 0 });
						Expect(fReason('MaterialIntake', [ '>Nope.IDLabQueue' ])).to.include({ Reason: 'UnknownEdge', Step: 0 });
						Expect(fReason('MaterialIntake', [ '>MaterialIntake.Status' ])).to.include({ Reason: 'NotAJoin', Step: 0 });
						Expect(fReason('LabQueue', [ '=LabForm.IDMaterialIntake' ])).to.include({ Reason: 'NotCoReferent', Step: 0 });
						Expect(fReason('MaterialIntake', [ 'bogus' ])).to.include({ Reason: 'InvalidStep', Step: 0 });
						Expect(fReason('MaterialIntake', 42)).to.include({ Reason: 'InvalidPath' });
						Expect(fReason('MaterialIntake', '   ')).to.include({ Reason: 'InvalidPath' });
						Expect(fReason('Nope', [ '>MaterialIntake.IDLabQueue' ])).to.include({ Reason: 'UnknownEntity' });
						Expect(fReason('MaterialIntake', [ { Via: 'LabForm.IDMaterialIntake', To: 'LabForm.IDMaterialIntake' } ])).to.include({ Reason: 'WrongStart' });
						Expect(fReason('MaterialIntakeRequirement', [ { Via: 'MaterialIntakeRequirement.IDLabFormType', To: 'LabForm.IDMaterialIntake' } ])).to.include({ Reason: 'NotCoReferent' });
					});

				test('an ambiguous co-reference needs the { Via, To } form',
					() =>
					{
						let tmpEnvironment = domainEnvironment(libProjectTrackSeed,
							{
								Model: (pModel) =>
								{
									pModel.Tables.Project.Columns.push({ Column: 'ReviewerIDUser', DataType: 'Numeric', Size: 'int', Join: 'IDUser' });
									pModel.Tables.Project.MeadowSchema.Schema.push({ Column: 'ReviewerIDUser', Type: 'Integer', Size: 'int' });
								}
							});
						let tmpProjectGraph = tmpEnvironment.graph;
						Expect(() => { tmpProjectGraph.coReferenceSource('Project', 'Task.AssignedIDUser'); }).to.throw().with.nested.property('Detail.Reason', 'AmbiguousCoReference');
						try
						{
							tmpProjectGraph.resolvePath('Project', [ '=Task.AssignedIDUser' ]);
							Expect.fail('ambiguous');
						}
						catch (pError)
						{
							Expect(pError.Detail).to.include({ Reason: 'AmbiguousCoReference', Step: 0 });
							Expect(pError.Detail.Candidates).to.deep.equal([ 'Project.OwnerIDUser', 'Project.ReviewerIDUser' ]);
						}
						let tmpPlan = tmpProjectGraph.resolvePath('Project', [ { Via: 'Project.ReviewerIDUser', To: 'Task.AssignedIDUser', CheckParent: true } ]);
						Expect(tmpPlan.Steps[0]).to.include({ Raw: '=Task.AssignedIDUser@Project.ReviewerIDUser', Via: 'Project.ReviewerIDUser', Parent: 'User', CheckParent: true });
						Expect(tmpPlan.Steps[0].On).to.deep.equal([ [ 'ReviewerIDUser', 'AssignedIDUser' ] ]);
						// Unambiguous: the explicit form spells the same step as the string form.
						Expect(tmpGraph.resolvePath('MaterialIntakeRequirement', [ { Via: 'MaterialIntakeRequirement.IDMaterialIntake', To: 'LabForm.IDMaterialIntake' } ]).Signature).to.equal('=LabForm.IDMaterialIntake');
						// Tenancy edges pair only with tenancy edges.
						Expect(tmpProjectGraph.coReferenceSource('Project', 'Task.IDCustomer')).to.equal('Project.IDCustomer');
						Expect(tmpProjectGraph.coReferenceSource('Client', 'Task.IDProject')).to.equal(null);
						Expect(tmpProjectGraph.coReferenceSource('Client', 'Nope.Nope')).to.equal(null);
					});
			}
		);

		suite
		(
			'The domain definitions load (internal-contracts §31.5)',
			() =>
			{
				test('ProjectTrack: every entry loads, none disabled, no warnings',
					() =>
					{
						let tmpProject = loadDomain(libProjectTrackSeed);
						Expect(tmpProject.result.Disabled).to.deep.equal([]);
						Expect(tmpProject.result.Warnings).to.deep.equal([]);
						Expect(tmpProject.result.Loaded).to.deep.equal({ Facets: 4, Scopes: 5, Aliases: 1 });
						Expect(tmpProject.result.DefinitionsHash).to.match(/^d:[0-9a-f]{12}$/);
						Expect(tmpProject.registry.status()).to.deep.equal({ Files: [ libProjectTrackSeed.DEFINITIONS_PATH ], Facets: 4, Scopes: 5, Aliases: 1, Disabled: 0, Warnings: 0 });
						Expect(tmpProject.registry.scopesFor('Project').map((pScope) => { return pScope.Scope; })).to.deep.equal([ 'Project.MyProjects', 'Project.HasMyOverdue', 'Project.Unblocked', 'Project.ManyOverdue' ]);
						Expect(tmpProject.registry.facetsFor('Project').map((pFacet) => { return pFacet.Facet; })).to.deep.equal([ 'Project.MyOverdueBand', 'Project.ByMember', 'Project.HasOpenIssues' ]);
						Expect(tmpProject.registry.alias('MemberOf')).to.deep.equal([ '<ProjectMembership.IDProject' ]);
						Expect(tmpProject.registry.alias('Nope')).to.equal(null);
						Expect(tmpProject.registry.expression('Anything')).to.equal(null);
						Expect(tmpProject.logged).to.deep.equal([]);
					});

				test('LabTrack: every entry loads, none disabled; Records is ignored with a warning',
					() =>
					{
						let tmpLab = loadDomain(libLabTrackSeed);
						Expect(tmpLab.result.Disabled).to.deep.equal([]);
						Expect(tmpLab.result.Loaded).to.deep.equal({ Facets: 9, Scopes: 2, Aliases: 1 });
						Expect(tmpLab.result.Warnings).to.deep.equal(
							[
								{ Code: 'Ignored:Records', Kind: 'Facet', Name: 'MaterialIntake.FormsToDo', Source: libLabTrackSeed.DEFINITIONS_PATH, Pointer: '/Facets/1/Records' },
								// 08 §4.3 declares the TuplePivot CountMode 'Rows': it counts distinct Key tuples, and says so.
								{ Code: 'CountModeCanonicalized', Kind: 'Facet', Name: 'MaterialIntake.FormsToDo', Source: libLabTrackSeed.DEFINITIONS_PATH, Pointer: '/Facets/1/CountMode' }
							]);
						Expect(tmpLab.registry.facetsFor('MaterialIntakeRequirement').map((pFacet) => { return pFacet.Facet; })).to.deep.equal(
							[
								'MaterialIntakeRequirement.MyFormsToDo', 'MaterialIntakeRequirement.MyFormsToDo/ByQueue', 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline',
								'MaterialIntakeRequirement.MyFormsToDo/ByWeek', 'MaterialIntakeRequirement.MyFormsToDo/Started'
							]);
					});

				test('canonical E1: the three named scopes (Any → Or, aliases spliced, $-tokens kept as Bind leaves)',
					() =>
					{
						let tmpRegistry = loadDomain(libProjectTrackSeed).registry;
						let tmpMyProjects = tmpRegistry.scope('Project.MyProjects');
						Expect(compact(tmpMyProjects)).to.deep.equal(
							{
								Scope: 'Project.MyProjects', Entity: 'Project', Description: 'Projects where I hold one of the given roles, or that I own',
								Params: { Roles: { Type: 'EnumList', Values: [ 'Owner', 'Lead', 'Member', 'Reviewer' ], Default: [ 'Owner', 'Lead', 'Member' ] } },
								Where:
									{
										Or:
											[
												{
													Exists:
														{
															From: null, Path: '<ProjectMembership.IDProject',
															Where: { And: [ { Field: 'IDUser', Op: 'EQ', Bind: '$CurrentUser.IDUser' }, { Field: 'Role', Op: 'IN', Bind: '$Param.Roles' }, { Field: 'Active', Op: 'EQ', Value: 1 } ] },
															Correlate: []
														}
												},
												{ Field: 'OwnerIDUser', Op: 'EQ', Bind: '$CurrentUser.IDUser' }
											]
									},
								Entities: [ 'Project', 'ProjectMembership' ],
								Binds: [ '$CurrentUser.IDUser', '$Param.Roles' ],
								Relaxed: false, Supported: true, Unsupported: null,
								DefinitionHash: tmpMyProjects.DefinitionHash, Source: libProjectTrackSeed.DEFINITIONS_PATH
							});
						Expect(tmpMyProjects.DefinitionHash).to.match(/^dh:[0-9a-f]{12}$/);
						Expect(tmpMyProjects.Where.Or[0].Exists.Path.Steps[0]).to.include({ Direction: 'Reverse', Edge: 'ProjectMembership.IDProject', Where: null });
						Expect(compact(tmpRegistry.scope('Project.HasMyOverdue').Where)).to.deep.equal(
							{
								Exists:
									{
										From: null, Path: '<Task.IDProject', Correlate: [],
										Where: { And: [ { Field: 'AssignedIDUser', Op: 'EQ', Bind: '$CurrentUser.IDUser' }, { Field: 'DueDate', Op: 'LT', Bind: '$Now' }, { Field: 'Status', Op: 'NE', Value: 'Done' } ] }
									}
							});
						Expect(tmpRegistry.scope('Project.HasMyOverdue').Binds).to.deep.equal([ '$CurrentUser.IDUser', '$Now' ]);
						Expect(compact(tmpRegistry.scope('Project.Unblocked').Where)).to.deep.equal(
							{ NotExists: { From: null, Path: '<Issue.IDProject', Correlate: [], Where: { And: [ { Field: 'Severity', Op: 'EQ', Value: 'Blocker' }, { Field: 'State', Op: 'EQ', Value: 'Open' } ] } } });
						Expect(tmpRegistry.scope('Project.Unblocked').Entities).to.deep.equal([ 'Project', 'Issue' ]);
						Expect(tmpRegistry.scope('Project.Unblocked').Binds).to.deep.equal([]);
						// Coverage: K19 and the two-hop K10 scope.
						Expect(compact(tmpRegistry.scope('Project.ManyOverdue').Where)).to.deep.equal(
							{ HavingCount: { From: null, Path: '<Task.IDProject', Correlate: [], Where: { And: [ { Field: 'DueDate', Op: 'LT', Bind: '$Now' }, { Field: 'Status', Op: 'NE', Value: 'Done' } ] }, Op: 'GE', Value: 2 } });
						let tmpInMyProjects = tmpRegistry.scope('Document.InMyProjects');
						Expect(compact(tmpInMyProjects.Where)).to.deep.equal(
							{ Exists: { From: null, Path: '>Document.IDProject <ProjectMembership.IDProject', Correlate: [], Where: { And: [ { Field: 'IDUser', Op: 'EQ', Bind: '$CurrentUser.IDUser' }, { Field: 'Active', Op: 'EQ', Value: 1 } ] } } });
						Expect(tmpInMyProjects.Entities).to.deep.equal([ 'Document', 'Project', 'ProjectMembership' ]);
					});

				test('canonical E1: MyOverdueBand (K12) and the coverage facets K9 / K20 / multi-hop K8',
					() =>
					{
						let tmpRegistry = loadDomain(libProjectTrackSeed).registry;
						let tmpBand = tmpRegistry.facet('Project.MyOverdueBand');
						Expect(tmpBand).to.include(
							{
								Facet: 'Project.MyOverdueBand', Origin: 'Declared', SiblingOf: null, Entity: 'Project', Version: 1, Title: 'My overdue tasks per project',
								Where: null, Fold: 'ChildRollup', CountMode: 'Rows', Exclude: 'None', FilterKey: 'Project.MyOverdueBand', Relaxed: false, Semantics: 'NoVisibleMatch',
								Supported: true, Unsupported: null, Path: null, MultiValued: false, Selectable: true, ClauseType: null, WhereScopes: null
							});
						Expect(tmpBand.Pivot).to.deep.equal({ Kind: 'Entity', Entity: 'Project' });
						Expect(tmpBand.Folds).to.deep.equal([ 'ChildRollup' ]);
						Expect(tmpBand.OwnedFields).to.deep.equal([]);
						Expect(tmpBand.Entities).to.deep.equal([ 'Project', 'Task' ]);
						Expect(tmpBand.Binds).to.deep.equal([ '$CurrentUser.IDUser', '$Now' ]);
						Expect(compact(tmpBand.Dimensions[0])).to.deep.equal(
							{
								Kind: 'ChildRollup', Field: null, Alias: null, Path: null, PathShape: null, KeyField: null, LabelLookup: null, Where: null, Correlate: null,
								Child:
									{
										Path: '<Task.IDProject', Agg: 'count', Field: null,
										Where: { And: [ { Field: 'AssignedIDUser', Op: 'EQ', Bind: '$CurrentUser.IDUser' }, { Field: 'DueDate', Op: 'LT', Bind: '$Now' }, { Field: 'Status', Op: 'NE', Value: 'Done' } ] }
									},
								Labels: null, Edges: [ 1, 3, 10 ], Top: null, Order: null, Missing: null, Interval: null, EmptyBuckets: null, Mode: null, Buckets: null, OpenEnded: null, Ranges: null,
								DataType: 'Numeric', IsInteger: true, Scale: 0
							});
						Expect(tmpBand.FoldHash).to.match(/^fh:[0-9a-f]{12}$/);

						let tmpByMember = tmpRegistry.facet('Project.ByMember');
						Expect(tmpByMember).to.include({ Fold: 'Terms', CountMode: 'PivotDistinct', MultiValued: true, Exclude: 'Self', FilterKey: 'Project.ByMember', ClauseType: null, Semantics: null });
						Expect(tmpByMember.Path).to.deep.equal([ '<ProjectMembership.IDProject' ]);
						Expect(tmpByMember.OwnedFields).to.deep.equal([ '@path:<ProjectMembership.IDProject#IDUser' ]);
						Expect(compact(tmpByMember.Dimensions[0])).to.include({ Kind: 'Terms', Field: null, KeyField: 'IDUser', Path: '<ProjectMembership.IDProject', PathShape: 'ToMany', Top: 25, DataType: 'Numeric' });
						Expect(tmpByMember.Dimensions[0].Where).to.deep.equal({ Field: 'Active', Op: 'EQ', Value: 1 });
						// KeyField is an FK: the catalog's label lookup of ProjectMembership.IDUser.
						Expect(tmpByMember.Dimensions[0].LabelLookup).to.deep.equal({ Entity: 'User', KeyColumn: 'IDUser', LabelColumn: 'NameFirst' });

						let tmpOpenIssues = tmpRegistry.facet('Project.HasOpenIssues');
						Expect(tmpOpenIssues).to.include({ Fold: 'ExistsSplit', Exclude: 'None', FilterKey: 'Project.HasOpenIssues', Semantics: 'NoVisibleMatch', ClauseType: null });
						Expect(compact(tmpOpenIssues.Dimensions[0])).to.include({ Kind: 'ExistsSplit', Path: '<Issue.IDProject', PathShape: 'ToMany', DataType: 'Boolean' });
						Expect(tmpOpenIssues.Dimensions[0].Labels).to.deep.equal({ true: 'Has open issues', false: 'No open issues' });
						Expect(tmpOpenIssues.Dimensions[0].Correlate).to.deep.equal([]);

						let tmpByClient = tmpRegistry.facet('Document.ByClient');
						Expect(tmpByClient).to.include({ Entity: 'Document', Fold: 'Terms', CountMode: 'Rows', MultiValued: false, FilterKey: 'Document.ByClient', ClauseType: null });
						Expect(tmpByClient.Path).to.deep.equal([ '>Document.IDProject', '>Project.IDClient' ]);
						Expect(tmpByClient.Entities).to.deep.equal([ 'Document', 'Project', 'Client' ]);
						Expect(compact(tmpByClient.Dimensions[0])).to.include({ Field: 'IDClient', Path: '>Document.IDProject >Project.IDClient', PathShape: 'ToOne', Top: 20, DataType: 'ID' });
						Expect(tmpByClient.Dimensions[0].LabelLookup).to.deep.equal({ Entity: 'Client', KeyColumn: 'IDClient', LabelColumn: 'Name' });
					});

				test('canonical E3A: ToDoForMe (inlined InMyQueues, TenantOnly co-reference, composite Correlate) and MyFormsToDo with its siblings',
					() =>
					{
						let tmpRegistry = loadDomain(libLabTrackSeed).registry;
						let tmpInMyQueuesWhere =
							{
								And:
									[
										{ Exists: { From: null, Path: '>MaterialIntake.IDLabQueue <LabQueueMember.IDLabQueue', Correlate: [], Where: { And: [ { Field: 'IDUser', Op: 'EQ', Bind: '$CurrentUser.IDUser' }, { Field: 'Active', Op: 'EQ', Value: 1 } ] } } },
										{ Field: 'Status', Op: 'IN', Value: [ 'Received', 'InProgress' ] }
									]
							};
						Expect(compact(tmpRegistry.scope('MaterialIntake.InMyQueues').Where)).to.deep.equal(tmpInMyQueuesWhere);
						let tmpToDoWhere =
							{
								And:
									[
										{ Exists: { From: null, Path: '>MaterialIntakeRequirement.IDMaterialIntake', Correlate: [], Where: tmpInMyQueuesWhere } },
										{
											NotExists:
												{
													From: null, Path: '=LabForm.IDMaterialIntake [0:TenantOnly]', Where: { Field: 'Status', Op: 'EQ', Value: 'Complete' },
													Correlate: [ { Outer: { Alias: null, Field: 'IDLabFormType' }, Inner: 'IDLabFormType' } ]
												}
										}
									]
							};
						let tmpToDo = tmpRegistry.scope('MaterialIntakeRequirement.ToDoForMe');
						Expect(compact(tmpToDo.Where)).to.deep.equal(tmpToDoWhere);
						// The co-reference skips its parent: the sibling Exists already requires a visible intake (no forcing).
						Expect(tmpToDo.Where.And[1].NotExists.Path.Steps[0]).to.include({ CheckParent: false, Via: 'MaterialIntakeRequirement.IDMaterialIntake', Parent: 'MaterialIntake', ScopeReason: 'A form completed by any technician in my lab satisfies the requirement.' });
						Expect(tmpToDo).to.include({ Relaxed: true, Supported: true });
						Expect(tmpToDo.Entities).to.deep.equal([ 'MaterialIntakeRequirement', 'MaterialIntake', 'LabQueue', 'LabQueueMember', 'LabForm' ]);
						Expect(tmpToDo.Binds).to.deep.equal([ '$CurrentUser.IDUser' ]);

						let tmpMain = tmpRegistry.facet('MaterialIntakeRequirement.MyFormsToDo');
						Expect(tmpMain).to.include(
							{
								Origin: 'Declared', Entity: 'MaterialIntakeRequirement', Fold: 'Terms', CountMode: 'Rows', Exclude: 'Self', FilterKey: 'IDLabFormType',
								Relaxed: true, Semantics: 'NoVisibleMatch', ClauseType: 'DistinctSelectedValueList', Path: null, MultiValued: false
							});
						Expect(compact(tmpMain.Where)).to.deep.equal(tmpToDoWhere);
						Expect(tmpMain.WhereScopes).to.deep.equal([ { Scope: 'MaterialIntakeRequirement.ToDoForMe', Params: {} } ]);
						Expect(tmpMain.OwnedFields).to.deep.equal([ 'IDLabFormType' ]);
						Expect(tmpMain.Dimensions[0]).to.include({ Kind: 'Terms', Field: 'IDLabFormType', DataType: 'Numeric' });
						Expect(tmpMain.Dimensions[0].LabelLookup).to.deep.equal({ Entity: 'LabFormType', KeyColumn: 'IDLabFormType', LabelColumn: 'Name' });
						// The label target is not part of the gate list.
						Expect(tmpMain.Entities).to.deep.equal([ 'MaterialIntakeRequirement', 'MaterialIntake', 'LabQueue', 'LabQueueMember', 'LabForm' ]);
						Expect(tmpMain.Siblings).to.deep.equal(
							[ 'MaterialIntakeRequirement.MyFormsToDo/ByQueue', 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline', 'MaterialIntakeRequirement.MyFormsToDo/ByWeek', 'MaterialIntakeRequirement.MyFormsToDo/Started' ]);

						let tmpByQueue = tmpRegistry.facet('MaterialIntakeRequirement.MyFormsToDo/ByQueue');
						Expect(tmpByQueue).to.include({ Origin: 'Sibling', SiblingOf: 'MaterialIntakeRequirement.MyFormsToDo', DisplayName: 'By Queue', Exclude: 'Self', FilterKey: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue', ClauseType: null, DefinitionHash: tmpMain.DefinitionHash });
						Expect(tmpByQueue.FoldHash).to.not.equal(tmpMain.FoldHash);
						Expect(tmpByQueue.Path).to.deep.equal([ '>MaterialIntakeRequirement.IDMaterialIntake', '>MaterialIntake.IDLabQueue' ]);
						Expect(tmpByQueue.OwnedFields).to.deep.equal([ '@path:>MaterialIntakeRequirement.IDMaterialIntake >MaterialIntake.IDLabQueue#IDLabQueue' ]);
						Expect(tmpByQueue.Dimensions[0].LabelLookup).to.deep.equal({ Entity: 'LabQueue', KeyColumn: 'IDLabQueue', LabelColumn: 'Name' });
						Expect(compact(tmpByQueue.Where)).to.deep.equal(tmpToDoWhere);
						Expect(tmpRegistry.facet('MaterialIntakeRequirement.MyFormsToDo/ByDiscipline')).to.include({ ClauseType: 'InternalJoinMatch', FilterKey: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline' });
						let tmpByWeek = tmpRegistry.facet('MaterialIntakeRequirement.MyFormsToDo/ByWeek');
						Expect(tmpByWeek).to.include({ Fold: 'DateHistogram', ClauseType: 'InternalJoinDateRange' });
						Expect(tmpByWeek.Dimensions[0]).to.include({ Kind: 'DateHistogram', Field: 'ReceivedDate', Interval: 'week', PathShape: 'ToOne', DataType: 'DateTime', LabelLookup: null });

						let tmpStarted = tmpRegistry.facet('MaterialIntakeRequirement.MyFormsToDo/Started');
						Expect(tmpStarted).to.include({ Fold: 'ExistsSplit', Exclude: 'None', FilterKey: 'MaterialIntakeRequirement.MyFormsToDo/Started', ClauseType: null, Semantics: 'NoVisibleMatch' });
						Expect(compact(tmpStarted.Dimensions[0])).to.include({ Path: '=LabForm.IDMaterialIntake', PathShape: 'ToMany' });
						Expect(tmpStarted.Dimensions[0].Where).to.deep.equal({ Field: 'Status', Op: 'NE', Value: 'Complete' });
						Expect(tmpStarted.Dimensions[0].Correlate).to.deep.equal([ { Outer: { Alias: null, Field: 'IDLabFormType' }, Inner: 'IDLabFormType' } ]);
						Expect(tmpStarted.Dimensions[0].Labels).to.deep.equal({ true: 'Started', false: 'Not started' });
						// Exempt from CheckParent by the facet Where's Exists(>MIR.IDMaterialIntake) sibling.
						Expect(tmpStarted.Dimensions[0].Path.Steps[0].CheckParent).to.equal(false);
					});

				test('canonical E3B: the TuplePivot (sides, On, Key, Home side), the anti-join From the home side with a cross-side Correlate',
					() =>
					{
						let tmpRegistry = loadDomain(libLabTrackSeed).registry;
						let tmpFacet = tmpRegistry.facet('MaterialIntake.FormsToDo');
						Expect(compact(tmpFacet.Pivot)).to.deep.equal(
							{
								Kind: 'Tuple',
								Sides:
									[
										{ Name: 'i', Entity: 'MaterialIntake', Where: compact(tmpRegistry.scope('MaterialIntake.InMyQueues').Where) },
										{ Name: 'r', Entity: 'MaterialTypeFormRequirement', Where: { Field: 'Required', Op: 'EQ', Value: 1 } }
									],
								On: [ { Left: { Name: 'i', Field: 'IDMaterialType' }, Right: { Name: 'r', Field: 'IDMaterialType' } } ],
								Key: [ { Name: 'i', Field: 'IDMaterialIntake' }, { Name: 'r', Field: 'IDLabFormType' } ],
								Home: 'i'
							});
						Expect(compact(tmpFacet.Where)).to.deep.equal(
							{
								NotExists:
									{
										From: 'i', Path: '<LabForm.IDMaterialIntake [0:TenantOnly]', Where: { Field: 'Status', Op: 'EQ', Value: 'Complete' },
										Correlate: [ { Outer: { Alias: 'r', Field: 'IDLabFormType' }, Inner: 'IDLabFormType' } ]
									}
							});
						Expect(tmpFacet).to.include({ Entity: 'MaterialIntake', Fold: 'Terms', CountMode: 'KeyDistinct', Exclude: 'None', FilterKey: 'MaterialIntake.FormsToDo', ClauseType: null, Relaxed: true, Semantics: 'NoVisibleMatch', Supported: true });
						Expect(tmpFacet.OwnedFields).to.deep.equal([]);
						Expect(tmpFacet.Entities).to.deep.equal([ 'MaterialIntake', 'MaterialTypeFormRequirement', 'LabQueue', 'LabQueueMember', 'LabForm' ]);
						Expect(tmpFacet.Dimensions[0]).to.include({ Kind: 'Terms', Field: 'IDLabFormType', Alias: 'r', Path: null, DataType: 'Numeric' });
						Expect(tmpFacet.Dimensions[0].LabelLookup).to.deep.equal({ Entity: 'LabFormType', KeyColumn: 'IDLabFormType', LabelColumn: 'Name' });
						let tmpByQueue = tmpRegistry.facet('MaterialIntake.FormsToDo/ByQueue');
						Expect(tmpByQueue.Dimensions[0]).to.include({ Field: 'IDLabQueue', Alias: 'i' });
						Expect(tmpByQueue.Dimensions[0].LabelLookup).to.deep.equal({ Entity: 'LabQueue', KeyColumn: 'IDLabQueue', LabelColumn: 'Name' });
						Expect(tmpByQueue).to.include({ CountMode: 'KeyDistinct', Exclude: 'None', ClauseType: null, FilterKey: 'MaterialIntake.FormsToDo/ByQueue' });
						Expect(tmpRegistry.facet('MaterialIntake.FormsToDo/ByWeek').Dimensions[0]).to.include({ Kind: 'DateHistogram', Field: 'ReceivedDate', Alias: 'i', Interval: 'week' });

						let tmpByForm = tmpRegistry.facet('MaterialIntake.ByRequiredForm');
						Expect(tmpByForm.Path).to.deep.equal([ '<MaterialIntakeRequirement.IDMaterialIntake', '>MaterialIntakeRequirement.IDLabFormType' ]);
						Expect(tmpByForm).to.include({ CountMode: 'PivotDistinct', MultiValued: true, ClauseType: 'ExternalJoinSelectedValueList' });
						Expect(tmpByForm.Dimensions[0]).to.include({ KeyField: 'IDLabFormType', DataType: 'ID', Top: 25 });
						Expect(tmpByForm.Dimensions[0].LabelLookup).to.deep.equal({ Entity: 'LabFormType', KeyColumn: 'IDLabFormType', LabelColumn: 'Name' });
					});

				test('canonical forms are frozen (consumers build new trees)',
					() =>
					{
						let tmpRegistry = loadDomain(libLabTrackSeed).registry;
						let tmpScope = tmpRegistry.scope('MaterialIntakeRequirement.ToDoForMe');
						Expect(Object.isFrozen(tmpScope)).to.equal(true);
						Expect(Object.isFrozen(tmpScope.Where.And[1].NotExists.Path.Steps[0])).to.equal(true);
						Expect(() => { 'use strict'; tmpScope.Where.And.push(1); }).to.throw(TypeError);
						Expect(Object.isFrozen(tmpRegistry.facet('MaterialIntake.FormsToDo').Pivot.Sides[0])).to.equal(true);
					});
			}
		);

		suite
		(
			'Validation reasons: the entry is disabled, logged once, dependents follow, nothing partial (§20.3, §20.4)',
			() =>
			{
				test('stage 1: schema failures disable the entry; a bad envelope disables the whole source',
					() =>
					{
						let tmpEnvironment = loadObjects(libProjectTrackSeed,
							[
								{ FormatVersion: 1, Facets: [ { Facet: 'Project.NoDimensions', Version: 1 } ], Scopes: { 'Project.Fine': { Entity: 'Project', Where: ACTIVE_WHERE }, 'Project.BadOp': { Entity: 'Project', Where: [ { Field: 'Status', Op: 'XX', Value: 1 } ] } }, Aliases: { 'Bad': [ 'nope' ] } },
								{ FormatVersion: 1, Bogus: true, Scopes: { 'Project.InBadFile': { Entity: 'Project', Where: ACTIVE_WHERE } } },
								scopeFile({ 'Project.UsesLost': { Entity: 'Project', Where: [ { Scope: 'Project.InBadFile' } ] } })
							]);
						expectDisabled(tmpEnvironment, 'Project.NoDimensions', 'Schema', { Pointer: '/Facets/0' });
						expectDisabled(tmpEnvironment, 'Project.BadOp', 'Schema', { Pointer: '/Scopes/Project.BadOp/Where/0/Op' });
						expectDisabled(tmpEnvironment, 'Bad', 'Schema');
						expectDisabled(tmpEnvironment, '#object1', 'Schema', { Pointer: '/Bogus' });
						Expect(disabledEntry(tmpEnvironment, '#object1').Kind).to.equal('File');
						expectDisabled(tmpEnvironment, 'Project.UsesLost', 'DependsOnDisabled', { DependsOn: 'Project.InBadFile' });
						Expect(tmpEnvironment.registry.scope('Project.InBadFile')).to.equal(null);
						Expect(tmpEnvironment.registry.scope('Project.Fine')).to.be.an('object');
						Expect(tmpEnvironment.registry.facet('Project.NoDimensions')).to.equal(null);
					});

				test('files: unreadable and invalid JSON sources are disabled as Kind File; Path loads *.json sorted, not recursive',
					() =>
					{
						let tmpEnvironment = domainEnvironment(libProjectTrackSeed);
						let tmpResult = tmpEnvironment.registry.load({ Path: DIRECTORY_FIXTURE, Files: [ 'A-Aliases.json', '/no/such/definitions.json' ], Objects: [] });
						Expect(tmpEnvironment.registry.status().Files).to.deep.equal(
							[ libPath.join(DIRECTORY_FIXTURE, 'A-Aliases.json'), libPath.join(DIRECTORY_FIXTURE, 'B-Scopes.json'), libPath.join(DIRECTORY_FIXTURE, 'C-Broken.json'), '/no/such/definitions.json' ]);
						expectDisabled(tmpEnvironment, libPath.join(DIRECTORY_FIXTURE, 'C-Broken.json'), 'InvalidJSON');
						expectDisabled(tmpEnvironment, '/no/such/definitions.json', 'Unreadable');
						Expect(tmpResult.Disabled.map((pEntry) => { return pEntry.Kind; })).to.deep.equal([ 'File', 'File' ]);
						// The alias of one file serves the scope of another (names are global).
						Expect(compact(tmpEnvironment.registry.scope('Project.HasOpenTasks').Where).Exists.Path).to.equal('<Task.IDProject');
						Expect(tmpEnvironment.registry.scope('Project.NeverLoaded')).to.equal(null);
						// Files relative to Path (A-Aliases.json was listed twice: it loads once).
						Expect(tmpEnvironment.registry.status().Aliases).to.equal(1);
						// No Path, no Files: nothing loads (a missing directory is not an error).
						Expect(tmpEnvironment.registry.load({ Path: libPath.join(DIRECTORY_FIXTURE, 'missing'), Files: [], Objects: [] }).Disabled).to.deep.equal([]);
						Expect(tmpEnvironment.registry.status().Facets + tmpEnvironment.registry.status().Scopes).to.equal(0);
					});

				test('stage 2: DuplicateName (both disabled, dependents too), AliasShadowsBridge, NameShadowsColumn, ScopeEntityMismatch, UnknownEntity, HomeMismatch, PivotMismatch',
					() =>
					{
						let tmpEnvironment = loadObjects(libLabTrackSeed,
							[
								scopeFile({ 'MaterialIntake.Twice': { Entity: 'MaterialIntake', Where: [ { Field: 'Status', Op: 'EQ', Value: 'Received' } ] } }),
								scopeFile({ 'MaterialIntake.Twice': { Entity: 'MaterialIntake', Where: [ { Field: 'Status', Op: 'EQ', Value: 'Complete' } ] } }),
								facetFile({ Facet: 'MaterialIntake.UsesTwice', Where: [ { Scope: 'MaterialIntake.Twice' } ], Dimensions: [ { Kind: 'Terms', Field: 'Status' } ] },
									{
										Aliases: { 'MaterialIntake~LabFormType': [ '<MaterialIntakeRequirement.IDMaterialIntake' ] },
										Scopes:
											{
												'MaterialIntake.WrongEntity': { Entity: 'LabForm', Where: [ { Field: 'Status', Op: 'EQ', Value: 'x' } ] },
												'Nope.Scope': { Entity: 'Nope', Where: [ { Field: 'Status', Op: 'EQ', Value: 'x' } ] }
											}
									}),
								facetFile({ Facet: 'MaterialIntake.Status', Dimensions: [ { Kind: 'Terms', Field: 'Priority' } ] }),
								facetFile({ Facet: 'Nope.Facet', Dimensions: [ { Kind: 'Terms', Field: 'Priority' } ] }),
								facetFile({ Facet: 'MaterialIntake.HomeElsewhere', Home: 'LabForm', Dimensions: [ { Kind: 'Terms', Field: 'Priority' } ] }),
								facetFile({ Facet: 'MaterialIntake.PivotElsewhere', Pivot: 'LabForm', Dimensions: [ { Kind: 'Terms', Field: 'Priority' } ] })
							]);
						let tmpTwice = tmpEnvironment.registry.disabled().filter((pEntry) => { return pEntry.Name === 'MaterialIntake.Twice'; });
						Expect(tmpTwice.map((pEntry) => { return [ pEntry.Source, pEntry.Errors[0].Reason ]; })).to.deep.equal([ [ '#object0', 'DuplicateName' ], [ '#object1', 'DuplicateName' ] ]);
						expectDisabled(tmpEnvironment, 'MaterialIntake.UsesTwice', 'DependsOnDisabled', { DependsOn: 'MaterialIntake.Twice', Pointer: '/Facets/0/Where/0' });
						expectDisabled(tmpEnvironment, 'MaterialIntake~LabFormType', 'AliasShadowsBridge');
						expectDisabled(tmpEnvironment, 'MaterialIntake.WrongEntity', 'ScopeEntityMismatch', { Pointer: '/Scopes/MaterialIntake.WrongEntity/Entity' });
						expectDisabled(tmpEnvironment, 'Nope.Scope', 'UnknownEntity');
						expectDisabled(tmpEnvironment, 'MaterialIntake.Status', 'NameShadowsColumn', { Field: 'Status' });
						expectDisabled(tmpEnvironment, 'Nope.Facet', 'UnknownEntity');
						expectDisabled(tmpEnvironment, 'MaterialIntake.HomeElsewhere', 'HomeMismatch');
						expectDisabled(tmpEnvironment, 'MaterialIntake.PivotElsewhere', 'PivotMismatch');
						// The bridge alias itself stays available.
						Expect(tmpEnvironment.graph.alias('MaterialIntake~LabFormType')).to.be.an('array');
					});

				test('stages 3 and 4: aliases (unknown, cycle, dependent) and every path reason with its step',
					() =>
					{
						let tmpEnvironment = loadObjects(libProjectTrackSeed,
							[
								{
									FormatVersion: 1,
									Aliases: { CycleA: [ '@CycleB' ], CycleB: [ '@CycleA' ], Self: [ '@Self' ], UnknownInside: [ '<Task.IDProject', '@Nope' ], Fine: [ '<Task.IDProject' ], BadStart: [ '>Project.IDClient', '>Project.IDClient' ] },
									Scopes:
										{
											'Project.ViaCycle': { Entity: 'Project', Where: [ { Exists: { Path: [ '@CycleA' ] } } ] },
											'Project.ViaFine': { Entity: 'Project', Where: [ { Exists: { Path: [ '@Fine' ] } } ] },
											'Project.UnknownAlias': { Entity: 'Project', Where: [ { Exists: { Path: [ '@Nope' ] } } ] },
											'Document.WrongStart': { Entity: 'Document', Where: [ { Exists: { Path: [ '>Document.IDProject', '<Issue.IDProject', '<Task.IDProject' ] } } ] },
											'Project.UnknownEdge': { Entity: 'Project', Where: [ { Exists: { Path: [ '>Project.Nope' ] } } ] },
											'Project.NotAJoin': { Entity: 'Project', Where: [ { Exists: { Path: [ '>Project.Status' ] } } ] },
											'Client.NotCoReferent': { Entity: 'Client', Where: [ { Exists: { Path: [ '=Issue.IDProject' ] } } ] },
											'Document.TooManyHops': { Entity: 'Document', Where: [ { Exists: { Path: '>Document.IDProject <Task.IDProject >Task.IDProject <Issue.IDProject >Issue.IDProject' } } ] },
											'Project.InvalidStep': { Entity: 'Project', Where: [ { Exists: { Path: '<Task.IDProject bogus' } } ] }
										}
								}
							]);
						expectDisabled(tmpEnvironment, 'CycleA', 'AliasCycle');
						expectDisabled(tmpEnvironment, 'CycleB', 'AliasCycle');
						expectDisabled(tmpEnvironment, 'Self', 'AliasCycle');
						expectDisabled(tmpEnvironment, 'UnknownInside', 'UnknownAlias', { Pointer: '/Aliases/UnknownInside/1', Step: 1 });
						expectDisabled(tmpEnvironment, 'BadStart', 'WrongStart', { Step: 1 });
						expectDisabled(tmpEnvironment, 'Project.ViaCycle', 'DependsOnDisabled', { DependsOn: 'CycleA' });
						Expect(tmpEnvironment.registry.scope('Project.ViaFine')).to.be.an('object');
						expectDisabled(tmpEnvironment, 'Project.UnknownAlias', 'UnknownAlias');
						expectDisabled(tmpEnvironment, 'Document.WrongStart', 'WrongStart', { Step: 2, Pointer: '/Scopes/Document.WrongStart/Where/0/Exists/Path/2' });
						expectDisabled(tmpEnvironment, 'Project.UnknownEdge', 'UnknownEdge', { Step: 0 });
						expectDisabled(tmpEnvironment, 'Project.NotAJoin', 'NotAJoin');
						expectDisabled(tmpEnvironment, 'Client.NotCoReferent', 'NotCoReferent');
						expectDisabled(tmpEnvironment, 'Document.TooManyHops', 'TooManyHops', { Step: 4 });
						expectDisabled(tmpEnvironment, 'Project.InvalidStep', 'InvalidStep', { Step: 1 });
					});

				test('stage 4: AmbiguousCoReference is a load error; the { Via, To } form loads',
					() =>
					{
						let tmpEnvironment = loadObjects(libProjectTrackSeed,
							[
								scopeFile(
									{
										'Project.Ambiguous': { Entity: 'Project', Where: [ { Exists: { Path: [ '=Task.AssignedIDUser' ] } } ] },
										'Project.Explicit': { Entity: 'Project', Where: [ { Exists: { Path: [ { Via: 'Project.ReviewerIDUser', To: 'Task.AssignedIDUser' } ] } } ] }
									})
							],
							{
								Model: (pModel) =>
								{
									pModel.Tables.Project.Columns.push({ Column: 'ReviewerIDUser', DataType: 'Numeric', Size: 'int', Join: 'IDUser' });
									pModel.Tables.Project.MeadowSchema.Schema.push({ Column: 'ReviewerIDUser', Type: 'Integer', Size: 'int' });
								}
							});
						expectDisabled(tmpEnvironment, 'Project.Ambiguous', 'AmbiguousCoReference', { Step: 0 });
						let tmpExplicit = tmpEnvironment.registry.scope('Project.Explicit');
						Expect(compact(tmpExplicit.Where).Exists.Path).to.equal('=Task.AssignedIDUser@Project.ReviewerIDUser [0:CheckParent]');
						// The parent (User: tenant-scoped, soft-deletable) is checked: no sibling visits it.
						Expect(tmpExplicit.Entities).to.deep.equal([ 'Project', 'Task', 'User' ]);
					});

				test('stage 5: predicate fields, values, tokens and params',
					() =>
					{
						let tmpEnvironment = loadObjects(libProjectTrackSeed,
							[
								scopeFile(
									{
										'Project.UnknownField': { Entity: 'Project', Where: [ { Field: 'Nope', Op: 'EQ', Value: 1 } ] },
										'Project.AliasField': { Entity: 'Project', Where: [ { Field: 'i.Status', Op: 'EQ', Value: 1 } ] },
										'Project.DeletedField': { Entity: 'Project', Where: [ { Field: 'Deleted', Op: 'EQ', Value: 0 } ] },
										'Project.PolicyField': { Entity: 'Project', Where: [ { Field: 'IDCustomer', Op: 'EQ', Value: 1 } ] },
										'Project.HopPolicyField': { Entity: 'Project', Where: [ { Exists: { Path: [ '<Task.IDProject' ], Where: [ { Field: 'IDCustomer', Op: 'EQ', Value: 1 } ] } } ] },
										'Project.BadDate': { Entity: 'Project', Where: [ { Field: 'StartDate', Op: 'GT', Value: 'not a date' } ] },
										'Project.BadNumber': { Entity: 'Project', Where: [ { Field: 'IDClient', Op: 'EQ', Value: 'seven' } ] },
										'Project.InScalar': { Entity: 'Project', Where: [ { Field: 'Status', Op: 'IN', Value: 'Active' } ] },
										'Project.InEmpty': { Entity: 'Project', Where: [ { Field: 'Status', Op: 'IN', Value: [] } ] },
										'Project.EqArray': { Entity: 'Project', Where: [ { Field: 'Status', Op: 'EQ', Value: [ 'Active' ] } ] },
										'Project.EqNull': { Entity: 'Project', Where: [ { Field: 'Status', Op: 'EQ', Value: null } ] },
										'Project.NullWithValue': { Entity: 'Project', Where: [ { Field: 'Status', Op: 'NULL', Value: 'x' } ] },
										'Project.NoValue': { Entity: 'Project', Where: [ { Field: 'Status', Op: 'EQ' } ] },
										'Project.Tilde': { Entity: 'Project', Where: [ { Field: 'Status', Op: 'EQ', Value: 'a~b' } ] },
										'Project.UnknownToken': { Entity: 'Project', Where: [ { Field: 'OwnerIDUser', Op: 'EQ', Value: '$CurrentUser.Bogus' } ] },
										'Project.BadToken': { Entity: 'Project', Where: [ { Field: 'OwnerIDUser', Op: 'EQ', Value: '$Whatever' } ] },
										'Project.ScopeToken': { Entity: 'Project', Where: [ { Field: 'OwnerIDUser', Op: 'EQ', Value: '$Scope.Nope' } ] },
										'Project.StartOfToken': { Entity: 'Project', Where: [ { Field: 'StartDate', Op: 'GE', Value: '$StartOf.decade' } ] },
										'Project.TokenInArray': { Entity: 'Project', Where: [ { Field: 'Status', Op: 'IN', Value: [ 'Active', '$Now' ] } ] },
										'Project.UndeclaredParam': { Entity: 'Project', Where: [ { Field: 'Status', Op: 'EQ', Value: '$Param.Missing' } ] },
										'Project.ListParamScalarOp': { Entity: 'Project', Params: { S: { Type: 'EnumList', Values: [ 'Active' ] } }, Where: [ { Field: 'Status', Op: 'EQ', Value: '$Param.S' } ] },
										'Project.IntegerParamInOp': { Entity: 'Project', Params: { N: { Type: 'Integer' } }, Where: [ { Field: 'IDClient', Op: 'IN', Value: '$Param.N' } ] },
										'Project.TokenUnderIn': { Entity: 'Project', Where: [ { Field: 'OwnerIDUser', Op: 'IN', Value: '$CurrentUser.IDUser' } ] },
										'Project.DateTokenOnString': { Entity: 'Project', Where: [ { Field: 'Status', Op: 'LT', Value: '$Now' } ] },
										'Project.UserTokenOnString': { Entity: 'Project', Where: [ { Field: 'Status', Op: 'EQ', Value: '$CurrentUser.IDUser' } ] },
										'Project.EnumParamOnNumber': { Entity: 'Project', Params: { E: { Type: 'Enum', Values: [ 'x' ] } }, Where: [ { Field: 'IDClient', Op: 'EQ', Value: '$Param.E' } ] },
										'Project.CorrelateType': { Entity: 'Project', Where: [ { Exists: { Path: [ '<Task.IDProject' ], Correlate: [ [ 'Status', 'IDProject' ] ] } } ] },
										'Project.CorrelateUnknown': { Entity: 'Project', Where: [ { Exists: { Path: [ '<Task.IDProject' ], Correlate: [ [ 'IDProject', 'Nope' ] ] } } ] },
										'Project.ParamSchemaEnum': { Entity: 'Project', Params: { E: { Type: 'Enum' } }, Where: ACTIVE_WHERE },
										'Project.ParamSchemaDefault': { Entity: 'Project', Params: { E: { Type: 'Enum', Values: [ 'a' ], Default: 'b' } }, Where: ACTIVE_WHERE },
										'Project.ParamSchemaRange': { Entity: 'Project', Params: { N: { Type: 'Integer', Min: 5, Max: 1 } }, Where: ACTIVE_WHERE },
										'Project.ParamSchemaMinOnString': { Entity: 'Project', Params: { S: { Type: 'String', Min: 1 } }, Where: ACTIVE_WHERE },
										'Project.FromOutsideTuple': { Entity: 'Project', Where: [ { Exists: { From: 'i', Path: [ '<Task.IDProject' ] } } ] }
									})
							]);
						let tmpExpectations =
							[
								[ 'Project.UnknownField', 'UnknownField', { Field: 'Nope', Entity: 'Project' } ],
								[ 'Project.AliasField', 'UnknownField' ],
								[ 'Project.DeletedField', 'DeletedField' ],
								[ 'Project.PolicyField', 'PolicyField', { Field: 'IDCustomer' } ],
								[ 'Project.HopPolicyField', 'PolicyField', { Entity: 'Task', Pointer: '/Scopes/Project.HopPolicyField/Where/0/Exists/Where/0/Field' } ],
								[ 'Project.BadDate', 'InvalidValue' ],
								[ 'Project.BadNumber', 'InvalidValue' ],
								[ 'Project.InScalar', 'InvalidValue' ],
								[ 'Project.InEmpty', 'InvalidValue' ],
								[ 'Project.EqArray', 'InvalidValue' ],
								[ 'Project.EqNull', 'InvalidValue' ],
								[ 'Project.NullWithValue', 'InvalidValue' ],
								[ 'Project.NoValue', 'InvalidValue' ],
								[ 'Project.Tilde', 'InvalidValue' ],
								[ 'Project.UnknownToken', 'UnknownToken' ],
								[ 'Project.BadToken', 'UnknownToken' ],
								[ 'Project.ScopeToken', 'UnknownToken' ],
								[ 'Project.StartOfToken', 'UnknownToken' ],
								[ 'Project.TokenInArray', 'UnknownToken' ],
								[ 'Project.UndeclaredParam', 'UndeclaredParam', { Field: 'Missing' } ],
								[ 'Project.ListParamScalarOp', 'ParamShape' ],
								[ 'Project.IntegerParamInOp', 'ParamShape' ],
								[ 'Project.TokenUnderIn', 'ParamShape' ],
								[ 'Project.DateTokenOnString', 'TokenType' ],
								[ 'Project.UserTokenOnString', 'TokenType' ],
								[ 'Project.EnumParamOnNumber', 'TokenType' ],
								[ 'Project.CorrelateType', 'CorrelateType' ],
								[ 'Project.CorrelateUnknown', 'UnknownField' ],
								[ 'Project.ParamSchemaEnum', 'ParamSchema' ],
								[ 'Project.ParamSchemaDefault', 'ParamSchema' ],
								[ 'Project.ParamSchemaRange', 'ParamSchema' ],
								[ 'Project.ParamSchemaMinOnString', 'ParamSchema' ],
								[ 'Project.FromOutsideTuple', 'TupleAlias' ]
							];
						tmpExpectations.forEach((pExpectation) => { expectDisabled(tmpEnvironment, pExpectation[0], pExpectation[1], pExpectation[2]); });
						Expect(tmpEnvironment.registry.disabled().length).to.equal(tmpExpectations.length);
						// No logged line carries a bound value.
						Expect(tmpEnvironment.logged.join('\n')).to.not.include('seven');
						Expect(tmpEnvironment.logged.join('\n')).to.not.include('not a date');
					});

				test('stage 5: literals are coerced by column type; params of every type validate and canonicalize their Defaults',
					() =>
					{
						let tmpEnvironment = loadObjects(libProjectTrackSeed,
							[
								scopeFile(
									{
										'Project.Coerced':
											{
												Entity: 'Project',
												Params:
													{
														E: { Type: 'Enum', Values: [ 'Active', 'Done' ], Default: 'Active' },
														L: { Type: 'IntegerList', Min: 1, Default: [ '3', 4 ] },
														B: { Type: 'Boolean', Default: 'true' },
														D: { Type: 'DateTime', Default: '2026-01-01T00:00:00Z' },
														S: { Type: 'String', MaxLength: 8, Default: 'abc' }
													},
												Where:
													[
														{ Field: 'IDClient', Op: 'IN', Value: [ '3', 9 ] },
														{ Field: 'StartDate', Op: 'GE', Value: '2026-01-01' },
														{ Field: 'Name', Op: 'LK', Value: '%Alpha%' },
														{ Field: 'Status', Op: 'IN', Value: '$Param.E' },
														{ Field: 'IDClient', Op: 'NIN', Value: '$Param.L' },
														{ Field: 'StartDate', Op: 'LT', Value: '$Param.D' },
														{ Field: 'Name', Op: 'NE', Value: '$Param.S' },
														{ Exists: { Path: [ '<ProjectMembership.IDProject' ], Where: [ { Field: 'Active', Op: 'EQ', Value: '$Param.B' } ] } },
														{ Field: 'StartDate', Op: 'GE', Value: '$StartOf.quarter' },
														{ Field: 'StartDate', Op: 'LE', Value: '$Today' }
													]
											}
									})
							]);
						Expect(tmpEnvironment.registry.disabled()).to.deep.equal([]);
						let tmpScope = tmpEnvironment.registry.scope('Project.Coerced');
						Expect(tmpScope.Params).to.deep.equal(
							{
								E: { Type: 'Enum', Values: [ 'Active', 'Done' ], Default: 'Active' },
								L: { Type: 'IntegerList', Min: 1, Default: [ 3, 4 ] },
								B: { Type: 'Boolean', Default: 1 },
								D: { Type: 'DateTime', Default: '2026-01-01 00:00:00' },
								S: { Type: 'String', MaxLength: 8, Default: 'abc' }
							});
						Expect(tmpScope.Where.And.slice(0, 3)).to.deep.equal(
							[ { Field: 'IDClient', Op: 'IN', Value: [ 3, 9 ] }, { Field: 'StartDate', Op: 'GE', Value: '2026-01-01 00:00:00' }, { Field: 'Name', Op: 'LK', Value: '%Alpha%' } ]);
						Expect(tmpScope.Where.And[3]).to.deep.equal({ Field: 'Status', Op: 'IN', Bind: '$Param.E' });
						Expect(tmpScope.Binds).to.deep.equal([ '$Param.E', '$Param.L', '$Param.D', '$Param.S', '$Param.B', '$StartOf.quarter', '$Today' ]);
					});

				test('stage 5: Not is pushed down (operator negation, De Morgan, Exists ↔ NotExists, HavingCount op negation)',
					() =>
					{
						let tmpEnvironment = loadObjects(libProjectTrackSeed,
							[
								scopeFile(
									{
										'Project.Negated':
											{
												Entity: 'Project',
												Where:
													[
														{
															Not:
																{
																	Any:
																		[
																			{ Field: 'Status', Op: 'IN', Value: [ 'Done' ] },
																			{ And: [ { Field: 'StartDate', Op: 'NULL' }, { Not: { Field: 'Name', Op: 'LK', Value: '%x%' } } ] },
																			{ Exists: { Path: [ '<Issue.IDProject' ] } },
																			{ HavingCount: { Path: [ '<Task.IDProject' ], Op: 'GE', Value: 3 } }
																		]
																}
														}
													]
											}
									})
							]);
						let tmpScope = tmpEnvironment.registry.scope('Project.Negated');
						Expect(compact(tmpScope.Where)).to.deep.equal(
							{
								And:
									[
										{ Field: 'Status', Op: 'NIN', Value: [ 'Done' ] },
										{ Or: [ { Field: 'StartDate', Op: 'NOTNULL' }, { Field: 'Name', Op: 'LK', Value: '%x%' } ] },
										{ NotExists: { From: null, Path: '<Issue.IDProject', Where: null, Correlate: [] } },
										{ HavingCount: { From: null, Path: '<Task.IDProject', Where: null, Correlate: [], Op: 'LT', Value: 3 } }
									]
							});
					});

				test('stage 6: scope references (unknown, disabled, wrong entity, params missing / invalid / defaulted / passed through, depth, cycles)',
					() =>
					{
						let tmpEnvironment = loadObjects(libProjectTrackSeed,
							[
								scopeFile(
									{
										'Project.Roles':
											{
												Entity: 'Project',
												Params: { R: { Type: 'EnumList', Values: [ 'Owner', 'Lead', 'Member' ], Default: [ 'Owner' ] }, N: { Type: 'Integer' } },
												Where: [ { Exists: { Path: [ '<ProjectMembership.IDProject' ], Where: [ { Field: 'Role', Op: 'IN', Value: '$Param.R' } ] } }, { Field: 'IDClient', Op: 'EQ', Value: '$Param.N' } ]
											},
										'Project.UnknownScope': { Entity: 'Project', Where: [ { Scope: 'Project.Nope' } ] },
										'Project.WrongEntity': { Entity: 'Project', Where: [ { Scope: 'Document.Base' } ] },
										'Document.Base': { Entity: 'Document', Where: [ { Field: 'Status', Op: 'EQ', Value: 'Final' } ] },
										'Project.ParamMissing': { Entity: 'Project', Where: [ { Scope: 'Project.Roles' } ] },
										'Project.ParamInvalid': { Entity: 'Project', Where: [ { Scope: 'Project.Roles', Params: { N: 1, R: [ 'Bogus' ] } } ] },
										'Project.ParamUnknown': { Entity: 'Project', Where: [ { Scope: 'Project.Roles', Params: { N: 1, Q: 2 } } ] },
										'Project.ParamLiteral': { Entity: 'Project', Where: [ { Scope: 'Project.Roles', Params: { N: '7' } } ] },
										'Project.ParamToken': { Entity: 'Project', Params: { Mine: { Type: 'EnumList', Values: [ 'Lead' ] }, C: { Type: 'Integer' } }, Where: [ { Scope: 'Project.Roles', Params: { R: '$Param.Mine', N: '$Param.C' } } ] },
										'Project.ParamTokenShape': { Entity: 'Project', Params: { One: { Type: 'Enum', Values: [ 'Lead' ] } }, Where: [ { Scope: 'Project.Roles', Params: { R: '$Param.One', N: 1 } } ] },
										'Project.ParamUserToken': { Entity: 'Project', Where: [ { Scope: 'Project.Roles', Params: { N: '$CurrentUser.IDUser' } } ] },
										'Project.NotScope': { Entity: 'Project', Where: [ { Not: { Scope: 'Project.Roles', Params: { N: 1 } } } ] },
										'Project.D1': { Entity: 'Project', Where: [ { Scope: 'Project.D2' } ] },
										'Project.D2': { Entity: 'Project', Where: [ { Scope: 'Project.D3' } ] },
										'Project.D3': { Entity: 'Project', Where: [ { Scope: 'Project.D4' } ] },
										'Project.D4': { Entity: 'Project', Where: [ { Scope: 'Project.D5' } ] },
										'Project.D5': { Entity: 'Project', Where: ACTIVE_WHERE },
										'Project.CycleA': { Entity: 'Project', Where: [ { Scope: 'Project.CycleB' } ] },
										'Project.CycleB': { Entity: 'Project', Where: [ { Any: [ { Scope: 'Project.CycleA' }, { Field: 'Status', Op: 'EQ', Value: 'x' } ] } ] },
										'Project.UsesCycle': { Entity: 'Project', Where: [ { Scope: 'Project.CycleA' } ] },
										'Project.SelfCycle': { Entity: 'Project', Where: [ { Scope: 'Project.SelfCycle' } ] }
									})
							]);
						expectDisabled(tmpEnvironment, 'Project.UnknownScope', 'UnknownScope', { Pointer: '/Scopes/Project.UnknownScope/Where/0' });
						expectDisabled(tmpEnvironment, 'Project.WrongEntity', 'ScopeEntityMismatch', { Entity: 'Document' });
						expectDisabled(tmpEnvironment, 'Project.ParamMissing', 'ScopeParamMissing', { Field: 'N' });
						expectDisabled(tmpEnvironment, 'Project.ParamInvalid', 'ScopeParamInvalid', { Field: 'R' });
						expectDisabled(tmpEnvironment, 'Project.ParamUnknown', 'ScopeParamInvalid', { Field: 'Q' });
						expectDisabled(tmpEnvironment, 'Project.ParamTokenShape', 'ScopeParamInvalid', { Field: 'R' });
						expectDisabled(tmpEnvironment, 'Project.D1', 'ScopeTooDeep');
						expectDisabled(tmpEnvironment, 'Project.CycleA', 'ScopeCycle');
						expectDisabled(tmpEnvironment, 'Project.CycleB', 'ScopeCycle');
						expectDisabled(tmpEnvironment, 'Project.SelfCycle', 'ScopeCycle');
						expectDisabled(tmpEnvironment, 'Project.UsesCycle', 'DependsOnDisabled', { DependsOn: 'Project.CycleA' });
						[ 'Project.D2', 'Project.D3', 'Project.D4', 'Project.D5' ].forEach((pName) => { Expect(tmpEnvironment.registry.scope(pName), pName).to.be.an('object'); });
						// A literal param is validated, coerced by the param type and by the column; the default fills the rest.
						Expect(compact(tmpEnvironment.registry.scope('Project.ParamLiteral').Where)).to.deep.equal(
							{ And: [ { Exists: { From: null, Path: '<ProjectMembership.IDProject', Correlate: [], Where: { Field: 'Role', Op: 'IN', Value: [ 'Owner' ] } } }, { Field: 'IDClient', Op: 'EQ', Value: 7 } ] });
						Expect(tmpEnvironment.registry.scope('Project.ParamLiteral').Binds).to.deep.equal([]);
						// A token passes through as the enclosing definition's Bind.
						let tmpThrough = tmpEnvironment.registry.scope('Project.ParamToken');
						Expect(tmpThrough.Where.And[0].Exists.Where).to.deep.equal({ Field: 'Role', Op: 'IN', Bind: '$Param.Mine' });
						Expect(tmpThrough.Where.And[1]).to.deep.equal({ Field: 'IDClient', Op: 'EQ', Bind: '$Param.C' });
						Expect(tmpThrough.Binds).to.deep.equal([ '$Param.Mine', '$Param.C' ]);
						Expect(tmpEnvironment.registry.scope('Project.ParamUserToken').Where.And[1]).to.deep.equal({ Field: 'IDClient', Op: 'EQ', Bind: '$CurrentUser.IDUser' });
						// Not over a scope reference negates the inlined tree.
						Expect(compact(tmpEnvironment.registry.scope('Project.NotScope').Where)).to.deep.equal(
							{ Or: [ { NotExists: { From: null, Path: '<ProjectMembership.IDProject', Correlate: [], Where: { Field: 'Role', Op: 'IN', Value: [ 'Owner' ] } } }, { Field: 'IDClient', Op: 'NE', Value: 1 } ] });
						// The referenced scope keeps its own canonical form (Binds of its params).
						Expect(tmpEnvironment.registry.scope('Project.Roles').Binds).to.deep.equal([ '$Param.R', '$Param.N' ]);
					});

				test('stage 7: ExistsTooDeep counts nested existence levels (steps, nested Wheres, parent checks)',
					() =>
					{
						let tmpEnvironment = loadObjects(libProjectTrackSeed,
							[
								scopeFile(
									{
										'Project.Four': { Entity: 'Project', Where: [ { Exists: { Path: [ '<Task.IDProject', '>Task.IDProject', '<Issue.IDProject', '>Issue.IDProject' ] } } ] },
										'Project.Five': { Entity: 'Project', Where: [ { Exists: { Path: [ '<Task.IDProject', '>Task.IDProject' ], Where: [ { Exists: { Path: [ '<Issue.IDProject', '>Issue.IDProject' ], Where: [ { Exists: { Path: [ '>Project.IDClient' ] } } ] } } ] } } ] },
										'Project.StepWhere': { Entity: 'Project', Where: [ { Exists: { Path: [ { Step: '<Task.IDProject', Where: [ { Exists: { Path: [ '>Task.IDProject', '<Issue.IDProject', '>Issue.IDProject', '>Project.IDClient' ] } } ] } ] } } ] }
									})
							]);
						Expect(tmpEnvironment.registry.scope('Project.Four')).to.be.an('object');
						expectDisabled(tmpEnvironment, 'Project.Five', 'ExistsTooDeep');
						expectDisabled(tmpEnvironment, 'Project.StepWhere', 'ExistsTooDeep');
					});

				test('stage 8: TenantOnly only on existence paths, with a reason, on a personally scoped entity',
					() =>
					{
						let tmpOnly = { Step: '<LabForm.IDMaterialIntake', Scope: 'TenantOnly', ScopeReason: 'any technician' };
						let tmpEnvironment = loadObjects(libLabTrackSeed,
							[
								facetFile({ Facet: 'MaterialIntake.DimensionTenantOnly', Dimensions: [ { Kind: 'Terms', Path: [ tmpOnly ], KeyField: 'IDLabFormType' } ] },
									{
										Scopes:
											{
												'MaterialIntake.NoReason': { Entity: 'MaterialIntake', Where: [ { Exists: { Path: [ { Step: '<LabForm.IDMaterialIntake', Scope: 'TenantOnly' } ] } } ] },
												'MaterialIntake.NoPolicy': { Entity: 'MaterialIntake', Where: [ { Exists: { Path: [ { Step: '<MaterialIntakeRequirement.IDMaterialIntake', Scope: 'TenantOnly', ScopeReason: 'x' } ] } } ] },
												'MaterialIntake.Fine': { Entity: 'MaterialIntake', Where: [ { NotExists: { Path: [ tmpOnly ] } }, { HavingCount: { Path: [ tmpOnly ], Op: 'LT', Value: 2 } } ] }
											}
									}),
								facetFile({ Facet: 'MaterialIntake.ChildTenantOnly', Dimensions: [ { Kind: 'ChildRollup', Child: { Path: [ tmpOnly ], Agg: 'count' }, Edges: [ 1 ] } ] }),
								facetFile({ Facet: 'LabForm.LabelTenantOnly', Dimensions: [ { Kind: 'Terms', Field: 'IDLabFormType', Labels: { Path: [ { Step: '>LabForm.IDLabFormType', Scope: 'TenantOnly', ScopeReason: 'x' } ], Field: 'Name' } } ] }),
								facetFile({ Facet: 'MaterialIntake.SplitTenantOnly', Dimensions: [ { Kind: 'ExistsSplit', Path: [ tmpOnly ] } ] })
							]);
						expectDisabled(tmpEnvironment, 'MaterialIntake.DimensionTenantOnly', 'TenantOnlyNotAllowed', { Step: 0 });
						expectDisabled(tmpEnvironment, 'MaterialIntake.ChildTenantOnly', 'TenantOnlyNotAllowed');
						expectDisabled(tmpEnvironment, 'LabForm.LabelTenantOnly', 'TenantOnlyNotAllowed');
						expectDisabled(tmpEnvironment, 'MaterialIntake.NoReason', 'TenantOnlyNeedsReason');
						expectDisabled(tmpEnvironment, 'MaterialIntake.NoPolicy', 'TenantOnlyNeedsPolicy', { Entity: 'MaterialIntakeRequirement' });
						Expect(tmpEnvironment.registry.scope('MaterialIntake.Fine').Relaxed).to.equal(true);
						Expect(tmpEnvironment.registry.facet('MaterialIntake.SplitTenantOnly').Relaxed).to.equal(true);
						// Without a personal-scope policy (no host) TenantOnly has nothing to relax.
						let tmpNoHost = loadObjects(libLabTrackSeed, [ scopeFile({ 'MaterialIntake.Fine': { Entity: 'MaterialIntake', Where: [ { NotExists: { Path: [ tmpOnly ] } } ] } }) ], { NoHost: true });
						expectDisabled(tmpNoHost, 'MaterialIntake.Fine', 'TenantOnlyNeedsPolicy');
					});

				test('stage 8: TenantOnly never crosses tenants — the relaxed entity must keep another required column (TenantOnlyNeedsTenant)',
					() =>
					{
						let tmpOnly = { Step: '<LabForm.IDMaterialIntake', Scope: 'TenantOnly', ScopeReason: 'any technician' };
						let tmpScopes = [ scopeFile({ 'MaterialIntake.Relaxed': { Entity: 'MaterialIntake', Where: [ { NotExists: { Path: [ tmpOnly ] } } ] } }) ];
						// LabForm excluded from the tenancy column: its ONLY required column is the owner.
						let tmpExcluded = loadObjects(libLabTrackSeed, tmpScopes, { Faceting: { Scope: { Policy: { Exclude: [ 'LabFormType', 'LabForm' ] } } } });
						expectDisabled(tmpExcluded, 'MaterialIntake.Relaxed', 'TenantOnlyNeedsTenant', { Entity: 'LabForm', Step: 0 });
						// The personal column IS the tenancy column.
						let tmpSameColumn = loadObjects(libLabTrackSeed, tmpScopes, { Faceting: { Scope: { Policy: { PersonalScopes: { LabForm: { Column: 'IDCustomer', SessionField: 'CustomerID' } } } } } });
						expectDisabled(tmpSameColumn, 'MaterialIntake.Relaxed', 'TenantOnlyNeedsTenant');
						// The personal column is also an explicit Required column of the entity.
						let tmpRequired = loadObjects(libLabTrackSeed, tmpScopes, { Faceting: { Scope: { Required: { LabForm: [ { Column: 'OwnerIDUser', From: '$CurrentUser.IDUser' } ] } } } });
						expectDisabled(tmpRequired, 'MaterialIntake.Relaxed', 'TenantOnlyNeedsTenant');
						// A table without the tenancy column.
						let tmpNoTenant = loadObjects(libLabTrackSeed, tmpScopes,
							{ Model: (pModel) => { pModel.Tables.LabForm.Columns = pModel.Tables.LabForm.Columns.filter((pColumn) => { return pColumn.Column !== 'IDCustomer'; }); } });
						expectDisabled(tmpNoTenant, 'MaterialIntake.Relaxed', 'TenantOnlyNeedsTenant');
						// The domain policy keeps IDCustomer on LabForm: it loads.
						Expect(loadObjects(libLabTrackSeed, tmpScopes).registry.scope('MaterialIntake.Relaxed').Relaxed).to.equal(true);
					});

				test('stage 8: no client $Param may be compared under a TenantOnly path (TenantOnlyParam)',
					() =>
					{
						let tmpOnly = { Step: '<LabForm.IDMaterialIntake', Scope: 'TenantOnly', ScopeReason: 'any technician' };
						let tmpEnvironment = loadObjects(libLabTrackSeed,
							[
								scopeFile(
									{
										'MaterialIntake.ProbeStatus': { Entity: 'MaterialIntake', Params: { S: { Type: 'String' } }, Where: [ { Exists: { Path: [ tmpOnly ], Where: [ { Field: 'Status', Op: 'LK', Value: '$Param.S' } ] } } ] },
										'MaterialIntake.ProbeStep': { Entity: 'MaterialIntake', Params: { S: { Type: 'String' } }, Where: [ { NotExists: { Path: [ Object.assign({ Where: [ { Field: 'Status', Op: 'EQ', Value: '$Param.S' } ] }, tmpOnly) ] } } ] },
										'MaterialIntake.ProbeNested': { Entity: 'MaterialIntake', Params: { T: { Type: 'Integer' } }, Where: [ { Exists: { Path: [ tmpOnly ], Where: [ { Exists: { Path: [ '>LabForm.IDLabFormType' ], Where: [ { Field: 'IDLabFormType', Op: 'EQ', Value: '$Param.T' } ] } } ] } } ] },
										'MaterialIntake.Tokens': { Entity: 'MaterialIntake', Where: [ { Exists: { Path: [ tmpOnly ], Where: [ { Field: 'Status', Op: 'EQ', Value: 'Complete' }, { Field: 'CompletedDate', Op: 'LT', Value: '$Now' } ] } } ] },
										'MaterialIntake.ParamOutside': { Entity: 'MaterialIntake', Params: { S: { Type: 'String' } }, Where: [ { Field: 'Status', Op: 'EQ', Value: '$Param.S' }, { NotExists: { Path: [ tmpOnly ] } } ] }
									})
							]);
						expectDisabled(tmpEnvironment, 'MaterialIntake.ProbeStatus', 'TenantOnlyParam');
						expectDisabled(tmpEnvironment, 'MaterialIntake.ProbeStep', 'TenantOnlyParam');
						expectDisabled(tmpEnvironment, 'MaterialIntake.ProbeNested', 'TenantOnlyParam');
						// Literals and server tokens are fine under it; a param outside the relaxed path is fine.
						Expect(tmpEnvironment.registry.scope('MaterialIntake.Tokens')).to.be.an('object');
						Expect(tmpEnvironment.registry.scope('MaterialIntake.ParamOutside')).to.be.an('object');
					});

				test('stage 10: dimension rules (shape, field type, foldable pivot columns, labels, CountMode, pivot axes)',
					() =>
					{
						let tmpEnvironment = loadObjects(libProjectTrackSeed,
							[
								{
									FormatVersion: 1,
									Facets:
										[
											{ Facet: 'Project.NoField', Version: 1, Dimensions: [ { Kind: 'Terms' } ] },
											{ Facet: 'Project.KeyFieldOnColumn', Version: 1, Dimensions: [ { Kind: 'Terms', Field: 'Status', KeyField: 'Status' } ] },
											{ Facet: 'Project.LabelFieldOnColumn', Version: 1, Dimensions: [ { Kind: 'Terms', Field: 'IDClient', LabelField: 'Name' } ] },
											{ Facet: 'Project.DateOnString', Version: 1, Dimensions: [ { Kind: 'DateHistogram', Field: 'Status' } ] },
											{ Facet: 'Project.NumericOnDate', Version: 1, Dimensions: [ { Kind: 'NumericHistogram', Field: 'StartDate' } ] },
											{ Facet: 'Project.PrimaryKey', Version: 1, Dimensions: [ { Kind: 'Terms', Field: 'IDProject' } ] },
											{ Facet: 'Project.GUID', Version: 1, Dimensions: [ { Kind: 'Terms', Field: 'GUIDProject' } ] },
											{ Facet: 'Document.LongString', Version: 1, Dimensions: [ { Kind: 'Terms', Field: 'Summary' } ] },
											{ Facet: 'Project.EdgesNotAscending', Version: 1, Dimensions: [ { Kind: 'NumericHistogram', Field: 'IDClient', Edges: [ 5, 1 ] } ] },
											{ Facet: 'Project.EdgesOnTerms', Version: 1, Dimensions: [ { Kind: 'Terms', Field: 'Status', Edges: [ 1, 2 ] } ] },
											{ Facet: 'Project.NoRanges', Version: 1, Dimensions: [ { Kind: 'Ranges', Field: 'IDClient' } ] },
											{ Facet: 'Project.DuplicateRangeKeys', Version: 1, Dimensions: [ { Kind: 'Ranges', Field: 'IDClient', Ranges: [ { Key: 'a', To: 3 }, { Key: 'a', From: 3 } ] } ] },
											{ Facet: 'Project.BackwardRange', Version: 1, Dimensions: [ { Kind: 'Ranges', Field: 'IDClient', Ranges: [ { Key: 'a', From: 5, To: 3 } ] } ] },
											{ Facet: 'Project.BandEdges', Version: 1, Dimensions: [ { Kind: 'ChildRollup', Child: { Path: [ '<Task.IDProject' ], Agg: 'count' }, Edges: [ 3, 1 ] } ] },
											{ Facet: 'Project.BandZeroEdge', Version: 1, Dimensions: [ { Kind: 'ChildRollup', Child: { Path: [ '<Task.IDProject' ], Agg: 'count' }, Edges: [ 0, 2 ] } ] },
											{ Facet: 'Project.SplitNoPath', Version: 1, Dimensions: [ { Kind: 'ExistsSplit' } ] },
											{ Facet: 'Project.ToManyHistogram', Version: 1, Dimensions: [ { Kind: 'DateHistogram', Path: [ '<Task.IDProject' ], Field: 'DueDate' } ] },
											{ Facet: 'Project.ToManyNoKeyField', Version: 1, Dimensions: [ { Kind: 'Terms', Path: [ '<Task.IDProject' ], Field: 'Status' } ] },
											{ Facet: 'Document.ToOneKeyField', Version: 1, Dimensions: [ { Kind: 'Terms', Path: [ '>Document.IDProject' ], KeyField: 'Status' } ] },
											{ Facet: 'Document.ToOneWhere', Version: 1, Dimensions: [ { Kind: 'Terms', Path: [ '>Document.IDProject' ], Field: 'Status', Where: ACTIVE_WHERE } ] },
											{ Facet: 'Document.PathFieldType', Version: 1, Dimensions: [ { Kind: 'DateHistogram', Path: [ '>Document.IDProject' ], Field: 'Status' } ] },
											{ Facet: 'Document.PathUnknownField', Version: 1, Dimensions: [ { Kind: 'Terms', Path: [ '>Document.IDProject' ], Field: 'Nope' } ] },
											{ Facet: 'Project.LabelsNotKeyed', Version: 1, Dimensions: [ { Kind: 'Terms', Field: 'Status', Labels: { Path: [ '>Project.IDClient' ], Field: 'Name' } } ] },
											{ Facet: 'Project.LabelsToMany', Version: 1, Dimensions: [ { Kind: 'Terms', Field: 'Status', Labels: { Path: [ '<Task.IDProject' ], Field: 'Status' } } ] },
											{ Facet: 'Project.LabelsUnknownField', Version: 1, Dimensions: [ { Kind: 'Terms', Field: 'IDClient', Labels: { Path: [ '>Project.IDClient' ], Field: 'Nope' } } ] },
											{ Facet: 'Project.LabelsOnDates', Version: 1, Dimensions: [ { Kind: 'DateHistogram', Field: 'StartDate', Labels: { Path: [ '>Project.IDClient' ], Field: 'Name' } } ] },
											{ Facet: 'Project.MembersAsRows', Version: 1, CountMode: 'Rows', Dimensions: [ { Kind: 'Terms', Path: [ '<ProjectMembership.IDProject' ], KeyField: 'IDUser' } ] },
											{ Facet: 'Project.PivotWithBand', Version: 1, Dimensions: [ { Kind: 'Terms', Field: 'Status' }, { Kind: 'ChildRollup', Child: { Path: [ '<Task.IDProject' ], Agg: 'count' }, Edges: [ 1 ] } ] },
											{ Facet: 'Project.PivotWithMulti', Version: 1, Dimensions: [ { Kind: 'Terms', Field: 'Status' }, { Kind: 'Terms', Path: [ '<ProjectMembership.IDProject' ], KeyField: 'IDUser' } ] },
											{ Facet: 'Project.Pivot', Version: 1, Dimensions: [ { Kind: 'Terms', Field: 'Status' }, { Kind: 'Terms', Field: 'IDClient' } ], Siblings: { Started: { Kind: 'DateHistogram', Field: 'StartDate', Interval: 'year' } } },
											{ Facet: 'Project.BadSibling', Version: 1, Dimensions: [ { Kind: 'Terms', Field: 'Status' } ], Siblings: { Fine: { Kind: 'Terms', Field: 'Name' }, Bad: { Kind: 'Terms', Field: 'Nope' } } },
											// Band 0 is "no visible child": a first edge above 1 would file count-1 parents under 'None'.
											{ Facet: 'Project.BandEdgesFromTwo', Version: 1, Dimensions: [ { Kind: 'ChildRollup', Child: { Path: [ '<Task.IDProject' ], Agg: 'count' }, Edges: [ 2, 5 ] } ] }
										]
								}
							]);
						let tmpExpectations =
							[
								[ 'Project.NoField', 'DimensionShape' ],
								[ 'Project.KeyFieldOnColumn', 'DimensionShape' ],
								[ 'Project.LabelFieldOnColumn', 'DimensionShape' ],
								[ 'Project.DateOnString', 'FieldType', { Field: 'Status' } ],
								[ 'Project.NumericOnDate', 'FieldType' ],
								[ 'Project.PrimaryKey', 'FieldNotFoldable' ],
								[ 'Project.GUID', 'FieldNotFoldable' ],
								[ 'Document.LongString', 'FieldNotFoldable' ],
								[ 'Project.EdgesNotAscending', 'DimensionShape' ],
								[ 'Project.EdgesOnTerms', 'DimensionShape' ],
								[ 'Project.NoRanges', 'DimensionShape' ],
								[ 'Project.DuplicateRangeKeys', 'DimensionShape' ],
								[ 'Project.BackwardRange', 'DimensionShape' ],
								[ 'Project.BandEdges', 'BandEdges' ],
								[ 'Project.BandEdgesFromTwo', 'BandEdges', { Pointer: '/Facets/31/Dimensions/0/Edges' } ],
								[ 'Project.BandZeroEdge', 'BandEdges' ],
								[ 'Project.SplitNoPath', 'DimensionShape' ],
								[ 'Project.ToManyHistogram', 'DimensionShape' ],
								[ 'Project.ToManyNoKeyField', 'DimensionShape' ],
								[ 'Document.ToOneKeyField', 'DimensionShape' ],
								[ 'Document.ToOneWhere', 'DimensionShape' ],
								[ 'Document.PathFieldType', 'FieldType' ],
								[ 'Document.PathUnknownField', 'UnknownField', { Entity: 'Project' } ],
								[ 'Project.LabelsNotKeyed', 'LabelsPath' ],
								[ 'Project.LabelsToMany', 'LabelsPath' ],
								[ 'Project.LabelsUnknownField', 'UnknownField', { Entity: 'Client' } ],
								[ 'Project.LabelsOnDates', 'DimensionShape' ],
								[ 'Project.MembersAsRows', 'CountModeRows', { Pointer: '/Facets/26/CountMode' } ],
								[ 'Project.PivotWithBand', 'PivotAxis', { Pointer: '/Facets/27/Dimensions/1' } ],
								[ 'Project.PivotWithMulti', 'PivotAxis' ],
								[ 'Project.BadSibling', 'UnknownField', { Pointer: '/Facets/30/Siblings/Bad/Field' } ]
							];
						tmpExpectations.forEach((pExpectation) => { expectDisabled(tmpEnvironment, pExpectation[0], pExpectation[1], pExpectation[2]); });
						Expect(tmpEnvironment.registry.disabled().length).to.equal(tmpExpectations.length);
						// Nothing partial: a disabled facet's valid siblings do not load either.
						Expect(tmpEnvironment.registry.facet('Project.BadSibling/Fine')).to.equal(null);
						// A declared 2-D Pivot over single-valued axes loads (Fold Pivot, not selectable, owns both columns).
						let tmpPivot = tmpEnvironment.registry.facet('Project.Pivot');
						Expect(tmpPivot).to.include({ Fold: 'Pivot', Selectable: false, ClauseType: null, Exclude: 'None', FilterKey: null });
						Expect(tmpPivot.OwnedFields).to.deep.equal([ 'Status', 'IDClient' ]);
						Expect(tmpPivot.Dimensions.map((pDimension) => { return pDimension.Field; })).to.deep.equal([ 'Status', 'IDClient' ]);
						Expect(tmpEnvironment.registry.facet('Project.Pivot/Started')).to.include({ Fold: 'DateHistogram', ClauseType: 'DateRange', FilterKey: 'StartDate', Exclude: 'Self' });
					});

				test('stage 11: TuplePivot rules (aliases, home side, On must be joined, dimensions keyed by the tuple, no paths)',
					() =>
					{
						let fTuple = (pName, pTuple, pDimensions, pMore) =>
						{
							return Object.assign(
								{
									Facet: `MaterialIntake.${pName}`, Version: 1,
									Pivot:
										{
											Tuple: Object.assign(
												{
													From: [ { As: 'i', Entity: 'MaterialIntake' }, { As: 'r', Entity: 'MaterialTypeFormRequirement' } ],
													On: [ [ 'i.IDMaterialType', 'r.IDMaterialType' ] ],
													Key: [ 'i.IDMaterialIntake', 'r.IDLabFormType' ]
												}, pTuple)
										},
									Dimensions: pDimensions || [ { Kind: 'Terms', Field: 'r.IDLabFormType' } ]
								}, pMore || {});
						};
						let tmpEnvironment = loadObjects(libLabTrackSeed,
							[
								{
									FormatVersion: 1,
									Facets:
										[
											fTuple('DuplicateAlias', { From: [ { As: 'i', Entity: 'MaterialIntake' }, { As: 'i', Entity: 'MaterialTypeFormRequirement' } ] }),
											fTuple('NoHomeSide', { From: [ { As: 'f', Entity: 'LabForm' }, { As: 'r', Entity: 'MaterialTypeFormRequirement' } ], On: [ [ 'f.IDLabFormType', 'r.IDLabFormType' ] ], Key: [ 'f.IDLabForm' ] }, [ { Kind: 'Terms', Field: 'f.Status' } ]),
											fTuple('NotJoined', { On: [ [ 'i.IDMaterialIntake', 'r.IDMaterialTypeFormRequirement' ] ] }),
											fTuple('UnknownSide', { On: [ [ 'x.IDMaterialType', 'r.IDMaterialType' ] ] }),
											fTuple('UnknownSideEntity', { From: [ { As: 'i', Entity: 'MaterialIntake' }, { As: 'r', Entity: 'Nope' } ] }),
											fTuple('NotKeyed', {}, [ { Kind: 'Terms', Field: 'r.IDMaterialType' } ]),
											fTuple('UnaliasedDimension', {}, [ { Kind: 'Terms', Field: 'IDLabQueue' } ]),
											fTuple('DimensionPath', {}, [ { Kind: 'Terms', Path: [ '>MaterialIntake.IDLabQueue' ], Field: 'Name' } ]),
											fTuple('BandOnTuple', {}, [ { Kind: 'ChildRollup', Child: { Path: [ '<LabForm.IDMaterialIntake' ], Agg: 'count' }, Edges: [ 1 ] } ]),
											fTuple('LeafOnUnknownSide', {}, null, { Where: [ { Field: 'x.Status', Op: 'EQ', Value: 'a' } ] }),
											// Every side must be reachable from the Home side through Join-related On pairs.
											fTuple('ThirdSideLoose', { From: [ { As: 'i', Entity: 'MaterialIntake' }, { As: 'r', Entity: 'MaterialTypeFormRequirement' }, { As: 'f', Entity: 'LabForm' } ], On: [ [ 'i.IDMaterialType', 'r.IDMaterialType' ], [ 'i.Status', 'f.Status' ] ] }),
											fTuple('ThirdSideNoPair', { From: [ { As: 'i', Entity: 'MaterialIntake' }, { As: 'r', Entity: 'MaterialTypeFormRequirement' }, { As: 'f', Entity: 'LabForm' } ] }),
											fTuple('HomeSecond', { From: [ { As: 'r', Entity: 'MaterialTypeFormRequirement' }, { As: 'i', Entity: 'MaterialIntake' } ] }),
											fTuple('ThreeJoined', { From: [ { As: 'r', Entity: 'MaterialTypeFormRequirement' }, { As: 'f', Entity: 'LabForm' }, { As: 'i', Entity: 'MaterialIntake' } ], On: [ [ 'f.IDMaterialIntake', 'i.IDMaterialIntake' ], [ 'i.IDMaterialType', 'r.IDMaterialType' ], [ 'f.IDLabFormType', 'r.IDLabFormType' ] ] }),
											fTuple('Fine', { On: [ [ 'i.IDMaterialType', 'r.IDMaterialType' ], [ 'i.IDLabQueue', 'r.IDLabFormType' ] ] }, [ { Kind: 'Terms', Field: 'i.IDLabQueue' } ],
												{ Where: [ { Field: 'Status', Op: 'NE', Value: 'Complete' }, { Field: 'r.Required', Op: 'EQ', Value: 1 }, { Exists: { From: 'r', Path: [ '>MaterialTypeFormRequirement.IDLabFormType' ], Where: [ { Field: 'Discipline', Op: 'EQ', Value: 'Chem' } ] } } ] })
										]
								}
							]);
						expectDisabled(tmpEnvironment, 'MaterialIntake.DuplicateAlias', 'TupleAlias');
						expectDisabled(tmpEnvironment, 'MaterialIntake.NoHomeSide', 'TupleHome');
						expectDisabled(tmpEnvironment, 'MaterialIntake.NotJoined', 'TupleOnNotJoined');
						expectDisabled(tmpEnvironment, 'MaterialIntake.UnknownSide', 'TupleAlias');
						expectDisabled(tmpEnvironment, 'MaterialIntake.UnknownSideEntity', 'UnknownEntity');
						expectDisabled(tmpEnvironment, 'MaterialIntake.NotKeyed', 'TupleDimensionNotKeyed');
						expectDisabled(tmpEnvironment, 'MaterialIntake.UnaliasedDimension', 'TupleAlias');
						expectDisabled(tmpEnvironment, 'MaterialIntake.DimensionPath', 'TuplePath');
						expectDisabled(tmpEnvironment, 'MaterialIntake.BandOnTuple', 'TuplePath');
						expectDisabled(tmpEnvironment, 'MaterialIntake.LeafOnUnknownSide', 'TupleAlias');
						expectDisabled(tmpEnvironment, 'MaterialIntake.ThirdSideLoose', 'TupleOnNotJoined', { Pointer: '/Facets/10/Pivot/Tuple/From/2' });
						expectDisabled(tmpEnvironment, 'MaterialIntake.ThirdSideNoPair', 'TupleOnNotJoined', { Pointer: '/Facets/11/Pivot/Tuple/From/2' });
						// The Home side may be declared anywhere; three sides joined in any declared order load.
						Expect(tmpEnvironment.registry.facet('MaterialIntake.HomeSecond').Pivot.Home).to.equal('i');
						Expect(tmpEnvironment.registry.facet('MaterialIntake.ThreeJoined').Pivot.Sides.map((pSide) => { return pSide.Name; })).to.deep.equal([ 'r', 'f', 'i' ]);
						let tmpFine = tmpEnvironment.registry.facet('MaterialIntake.Fine');
						// One On pair must be a join (here the co-referencing material type FKs); the others are plain equalities.
						Expect(tmpFine.Pivot.On.length).to.equal(2);
						Expect(compact(tmpFine.Where)).to.deep.equal(
							{
								And:
									[
										{ Alias: 'i', Field: 'Status', Op: 'NE', Value: 'Complete' },
										{ Alias: 'r', Field: 'Required', Op: 'EQ', Value: 1 },
										{ Exists: { From: 'r', Path: '>MaterialTypeFormRequirement.IDLabFormType', Where: { Field: 'Discipline', Op: 'EQ', Value: 'Chem' }, Correlate: [] } }
									]
							});
						// i.IDLabQueue is keyed through i's primary key in the Key.
						Expect(tmpFine.Dimensions[0]).to.include({ Field: 'IDLabQueue', Alias: 'i' });
					});

				test('an unexpected exception while compiling one entry disables only that entry (Internal, logged)',
					() =>
					{
						let tmpEnvironment = domainEnvironment(libProjectTrackSeed);
						let tmpCatalog = tmpEnvironment.catalog;
						// A catalog whose column lookup breaks for one field (any other method delegates).
						let tmpBroken = new Proxy(tmpCatalog,
							{
								get: (pTarget, pKey) =>
								{
									if (pKey === 'column')
									{
										return (pEntity, pColumn) =>
										{
											if (pColumn === 'Name')
											{
												throw new Error('catalog exploded');
											}
											return pTarget.column(pEntity, pColumn);
										};
									}
									let tmpValue = pTarget[pKey];
									return (typeof(tmpValue) === 'function') ? tmpValue.bind(pTarget) : tmpValue;
								}
							});
						let tmpResult = tmpEnvironment.registry.load({ Path: false, Objects: [ scopeFile({ 'Project.Breaks': { Entity: 'Project', Where: [ { Field: 'Name', Op: 'EQ', Value: 'x' } ] }, 'Project.Fine': { Entity: 'Project', Where: ACTIVE_WHERE } }) ] }, { Catalog: tmpBroken });
						expectDisabled(tmpEnvironment, 'Project.Breaks', 'Internal');
						Expect(tmpResult.Loaded.Scopes).to.equal(1);
						Expect(tmpEnvironment.logged.some((pLine) => { return pLine.indexOf('catalog exploded') >= 0; })).to.equal(true);
					});

				test('a reload re-validates dependents: a scope that becomes invalid disables what references it',
					() =>
					{
						let tmpEnvironment = domainEnvironment(libProjectTrackSeed);
						let tmpFacet = facetFile({ Facet: 'Project.Scoped', Where: [ { Scope: 'Project.Base' } ], Dimensions: [ { Kind: 'Terms', Field: 'Status' } ] });
						tmpEnvironment.registry.load({ Path: false, Objects: [ scopeFile({ 'Project.Base': { Entity: 'Project', Where: ACTIVE_WHERE } }), tmpFacet ] });
						Expect(tmpEnvironment.registry.facet('Project.Scoped')).to.be.an('object');
						tmpEnvironment.registry.load({ Path: false, Objects: [ scopeFile({ 'Project.Base': { Entity: 'Project', Where: [ { Field: 'Nope', Op: 'EQ', Value: 1 } ] } }), tmpFacet ] });
						Expect(tmpEnvironment.registry.facet('Project.Scoped')).to.equal(null);
						expectDisabled(tmpEnvironment, 'Project.Scoped', 'DependsOnDisabled', { DependsOn: 'Project.Base' });
						// A reload without sources re-validates the retained ones (and does not log again).
						tmpEnvironment.registry.load();
						Expect(tmpEnvironment.registry.disabled().map((pEntry) => { return pEntry.Name; })).to.deep.equal([ 'Project.Base', 'Project.Scoped' ]);
						Expect(tmpEnvironment.logged.length).to.equal(2);
					});
			}
		);

		suite
		(
			'Unsupported in M2: loads with Supported false and the Feature (stage 12); ignored keys warn (stage 13)',
			() =>
			{
				test('every unsupported feature, and propagation through a scope reference',
					() =>
					{
						let tmpEnvironment = loadObjects(libProjectTrackSeed,
							[
								{
									FormatVersion: 1,
									Catalog: { Project: { Exclude: [ 'Name' ] } },
									Expressions: { 'Project.Decade': { Op: 'floor' } },
									Scopes:
										{
											'Project.AllDone': { Entity: 'Project', Where: [ { All: { Path: [ '<Task.IDProject' ], Where: [ { Field: 'Status', Op: 'EQ', Value: 'Done' } ] } } ] },
											'Project.Computed': { Entity: 'Project', Where: [ { Expr: 'Project.Decade', Op: 'EQ', Value: 1 } ] },
											'Project.LongHaving': { Entity: 'Project', Where: [ { HavingCount: { Path: [ '<Task.IDProject', '>Task.IDProject' ], Op: 'GE', Value: 1 } } ] },
											'Project.UsesAllDone': { Entity: 'Project', Where: [ { Scope: 'Project.AllDone' } ] }
										},
									Facets:
										[
											{ Facet: 'Project.Union', Version: 1, Pivot: { Union: [ { Pivot: 'Project' } ] }, Dimensions: [ { Kind: 'Terms', Field: 'Status' } ] },
											{ Facet: 'Project.LogMode', Version: 1, Dimensions: [ { Kind: 'NumericHistogram', Field: 'IDClient', Mode: 'Log' } ] },
											{ Facet: 'Project.Approx', Version: 1, CountMode: 'Approx', Dimensions: [ { Kind: 'Terms', Field: 'Status' } ] },
											{ Facet: 'Project.KeyDistinct', Version: 1, CountMode: 'KeyDistinct', Dimensions: [ { Kind: 'Terms', Field: 'Status' } ] },
											{ Facet: 'Project.DistinctKey', Version: 1, DistinctKey: 'Name', Dimensions: [ { Kind: 'Terms', Field: 'Status' } ] },
											{ Facet: 'Project.Measures', Version: 1, Measures: [ { Op: 'sum', Field: 'IDClient' } ], Dimensions: [ { Kind: 'Terms', Field: 'Status' } ] },
											{ Facet: 'Project.CountMeasure', Version: 1, Measures: [ { Op: 'count' } ], Dimensions: [ { Kind: 'Terms', Field: 'Status' } ] },
											{ Facet: 'Project.SumBand', Version: 1, Dimensions: [ { Kind: 'ChildRollup', Child: { Path: [ '<Task.IDProject' ], Agg: 'sum', Field: 'IDTask' }, Edges: [ 1 ] } ] },
											{ Facet: 'Project.LongBand', Version: 1, Dimensions: [ { Kind: 'ChildRollup', Child: { Path: [ '<Task.IDProject', '>Task.IDProject' ], Agg: 'count' }, Edges: [ 1 ] } ] },
											{ Facet: 'Project.GroupExclude', Version: 1, Exclude: 'Group:Status', Dimensions: [ { Kind: 'Terms', Field: 'Status' } ] },
											{ Facet: 'Project.ExcludeGroup', Version: 1, ExcludeGroup: 'Status', Dimensions: [ { Kind: 'Terms', Field: 'Status' } ] },
											{ Facet: 'Document.LookupWhere', Version: 1, Dimensions: [ { Kind: 'Terms', Path: [ { Step: '>Document.IDProject', Where: [ { Exists: { Path: [ '<Task.IDProject' ] } } ] } ], Field: 'Status' } ] },
											{ Facet: 'Document.LookupColumnWhere', Version: 1, Dimensions: [ { Kind: 'Terms', Path: [ { Step: '>Document.IDProject', Where: ACTIVE_WHERE } ], Field: 'Status' } ] },
											{ Facet: 'Project.ExprDimension', Version: 1, Dimensions: [ { Kind: 'Terms', Expr: 'Project.Decade' } ] },
											{ Facet: 'Project.OtherZone', Version: 1, Dimensions: [ { Kind: 'DateHistogram', Field: 'StartDate', TimeZone: 'America/Chicago' } ] },
											{ Facet: 'Project.UsesComputed', Version: 1, Where: [ { Scope: 'Project.Computed' } ], Dimensions: [ { Kind: 'Terms', Field: 'Status' } ] },
											{
												Facet: 'MaterialIntake.Nope', Version: 1, Dimensions: [ { Kind: 'Terms', Field: 'Status' } ]
											}
										]
								},
								facetFile(
									{
										Facet: 'Task.TuplePivot', Home: 'Task',
										Pivot: { Tuple: { From: [ { As: 't', Entity: 'Task' }, { As: 'i', Entity: 'Issue' } ], On: [ [ 't.IDProject', 'i.IDProject' ] ], Key: [ 't.IDTask', 'i.IDIssue' ] } },
										Dimensions: [ { Kind: 'Terms', Field: 't.Status' }, { Kind: 'Terms', Field: 'i.State' } ]
									})
							]);
						let fUnsupported = (pName, pFeature, pScope) =>
						{
							let tmpEntry = pScope ? tmpEnvironment.registry.scope(pName) : tmpEnvironment.registry.facet(pName);
							Expect(tmpEntry, pName).to.be.an('object');
							Expect(tmpEntry.Supported, pName).to.equal(false);
							Expect(tmpEntry.Unsupported, pName).to.deep.equal({ Feature: pFeature, Milestone: 2 });
						};
						fUnsupported('Project.AllDone', 'Quantified', true);
						fUnsupported('Project.Computed', 'Computed', true);
						fUnsupported('Project.LongHaving', 'HavingCountPath', true);
						fUnsupported('Project.UsesAllDone', 'Quantified', true);
						fUnsupported('Project.Union', 'UnionOfSources');
						fUnsupported('Project.LogMode', 'LogMode');
						fUnsupported('Project.Approx', 'CountMode');
						fUnsupported('Project.KeyDistinct', 'CountMode');
						fUnsupported('Project.DistinctKey', 'CountMode');
						fUnsupported('Project.Measures', 'Measures');
						fUnsupported('Project.SumBand', 'ChildRollupAgg');
						fUnsupported('Project.LongBand', 'ChildRollupPath');
						fUnsupported('Project.GroupExclude', 'ExcludeGroup');
						fUnsupported('Project.ExcludeGroup', 'ExcludeGroup');
						fUnsupported('Document.LookupWhere', 'LookupPathWhere');
						fUnsupported('Project.ExprDimension', 'Computed');
						fUnsupported('Project.OtherZone', 'TimeZone');
						fUnsupported('Project.UsesComputed', 'Computed');
						fUnsupported('Task.TuplePivot', 'TuplePivotPivot');
						Expect(tmpEnvironment.registry.facet('Project.CountMeasure').Supported).to.equal(true);
						Expect(tmpEnvironment.registry.facet('Document.LookupColumnWhere').Supported).to.equal(true);
						Expect(compact(tmpEnvironment.registry.facet('Document.LookupColumnWhere').Dimensions[0].Path)).to.equal('>Document.IDProject [0:Where={"Field":"Status","Op":"EQ","Value":"Active"}]');
						// The only disabled entry: a facet homed on an entity this model does not have.
						Expect(tmpEnvironment.registry.disabled().map((pEntry) => { return pEntry.Name; })).to.deep.equal([ 'MaterialIntake.Nope' ]);
						Expect(tmpEnvironment.result.Warnings.filter((pWarning) => { return pWarning.Code === 'CatalogSectionIgnored'; })).to.deep.equal(
							[ { Code: 'CatalogSectionIgnored', Kind: 'File', Name: '#object0', Source: '#object0', Pointer: '/Catalog' } ]);
					});

				test('ignored keys warn (Engines, Freshness, Limits, Visibility, Records, Missing, ClauseType, Selectable, Elide, Bounds, value Labels on Terms)',
					() =>
					{
						let tmpEnvironment = loadObjects(libProjectTrackSeed,
							[
								facetFile(
									{
										Facet: 'Project.Busy', Engines: { Prefer: [ 'Live' ] }, Freshness: { MaxLagMS: 1 }, Limits: { Top: 1 }, Visibility: { Roles: [] }, Records: { Project: [] },
										Missing: { Values: [ null ] }, ClauseType: 'X', Selectable: false,
										Where: [ { Exists: { Path: [ { Step: '<Task.IDProject', Elide: true } ] } } ],
										Dimensions: [ { Kind: 'Terms', Field: 'Status', Labels: { Active: 'On' } } ],
										Siblings: { Started: { Kind: 'DateHistogram', Field: 'StartDate', Bounds: 'Data' } }
									})
							]);
						Expect(tmpEnvironment.registry.disabled()).to.deep.equal([]);
						Expect(tmpEnvironment.result.Warnings.map((pWarning) => { return `${pWarning.Code} ${pWarning.Pointer}`; })).to.deep.equal(
							[
								'Ignored:Engines /Facets/0/Engines', 'Ignored:Freshness /Facets/0/Freshness', 'Ignored:Limits /Facets/0/Limits', 'Ignored:Visibility /Facets/0/Visibility',
								'Ignored:Records /Facets/0/Records', 'Ignored:Missing /Facets/0/Missing', 'Ignored:ClauseType /Facets/0/ClauseType', 'Ignored:Selectable /Facets/0/Selectable',
								'ElideIgnored /Facets/0/Where/0/Exists/Path/0', 'Ignored:Labels /Facets/0/Dimensions/0/Labels', 'Ignored:Bounds /Facets/0/Siblings/Started/Bounds'
							]);
						// Elide never elides a hop in M2; the auto FK label still applies to IDClient-style columns (none here).
						Expect(tmpEnvironment.registry.facet('Project.Busy').Where.Exists.Path.Steps[0].Elide).to.equal(false);
						Expect(tmpEnvironment.registry.facet('Project.Busy').Dimensions[0].LabelLookup).to.equal(null);
					});
			}
		);

		suite
		(
			'CheckParent forcing (internal-contracts §21.4)',
			() =>
			{
				test('a co-reference over a soft-deletable, tenant-scoped parent is forced unless a sibling Exists visits the parent through the same FK',
					() =>
					{
						let tmpCoReference = { NotExists: { Path: [ '=LabForm.IDMaterialIntake' ], Where: [ { Field: 'Status', Op: 'EQ', Value: 'Complete' } ] } };
						let tmpEnvironment = loadObjects(libLabTrackSeed,
							[
								scopeFile(
									{
										'MaterialIntakeRequirement.Forced': { Entity: 'MaterialIntakeRequirement', Where: [ tmpCoReference ] },
										'MaterialIntakeRequirement.Exempt': { Entity: 'MaterialIntakeRequirement', Where: [ { Exists: { Path: [ '>MaterialIntakeRequirement.IDMaterialIntake' ] } }, tmpCoReference ] },
										'MaterialIntakeRequirement.NegatedSibling': { Entity: 'MaterialIntakeRequirement', Where: [ { NotExists: { Path: [ '>MaterialIntakeRequirement.IDMaterialIntake' ] } }, tmpCoReference ] },
										'MaterialIntakeRequirement.OtherFK': { Entity: 'MaterialIntakeRequirement', Where: [ { Exists: { Path: [ '>MaterialIntakeRequirement.IDLabFormType' ] } }, tmpCoReference ] },
										'MaterialIntakeRequirement.InsideOr': { Entity: 'MaterialIntakeRequirement', Where: [ { Exists: { Path: [ '>MaterialIntakeRequirement.IDMaterialIntake' ] } }, { Any: [ tmpCoReference, { Field: 'IDLabFormType', Op: 'EQ', Value: 1 } ] } ] },
										'MaterialIntakeRequirement.Declared': { Entity: 'MaterialIntakeRequirement', Where: [ { NotExists: { Path: [ { Step: '=LabForm.IDMaterialIntake', CheckParent: true } ] } } ] },
										'MaterialIntakeRequirement.GlobalParent': { Entity: 'MaterialIntakeRequirement', Where: [ { Exists: { Path: [ '=MaterialTypeFormRequirement.IDLabFormType' ] } } ] },
										'MaterialIntakeRequirement.ExemptByScope': { Entity: 'MaterialIntakeRequirement', Where: [ { Scope: 'MaterialIntakeRequirement.Exempt' } ] }
									})
							]);
						Expect(tmpEnvironment.registry.disabled()).to.deep.equal([]);
						let fStep = (pName, pPath) =>
						{
							let tmpWhere = tmpEnvironment.registry.scope(pName).Where;
							return pPath(tmpWhere).Path.Steps[0];
						};
						Expect(fStep('MaterialIntakeRequirement.Forced', (pWhere) => { return pWhere.NotExists; }).CheckParent).to.equal(true);
						Expect(tmpEnvironment.registry.scope('MaterialIntakeRequirement.Forced').Entities).to.deep.equal([ 'MaterialIntakeRequirement', 'LabForm', 'MaterialIntake' ]);
						Expect(fStep('MaterialIntakeRequirement.Exempt', (pWhere) => { return pWhere.And[1].NotExists; }).CheckParent).to.equal(false);
						Expect(tmpEnvironment.registry.scope('MaterialIntakeRequirement.Exempt').Entities).to.deep.equal([ 'MaterialIntakeRequirement', 'MaterialIntake', 'LabForm' ]);
						Expect(fStep('MaterialIntakeRequirement.NegatedSibling', (pWhere) => { return pWhere.And[1].NotExists; }).CheckParent).to.equal(true);
						Expect(fStep('MaterialIntakeRequirement.OtherFK', (pWhere) => { return pWhere.And[1].NotExists; }).CheckParent).to.equal(true);
						Expect(fStep('MaterialIntakeRequirement.InsideOr', (pWhere) => { return pWhere.And[1].Or[0].NotExists; }).CheckParent).to.equal(true);
						Expect(fStep('MaterialIntakeRequirement.Declared', (pWhere) => { return pWhere.NotExists; }).CheckParent).to.equal(true);
						Expect(fStep('MaterialIntakeRequirement.GlobalParent', (pWhere) => { return pWhere.Exists; }).CheckParent).to.equal(false);
						Expect(fStep('MaterialIntakeRequirement.ExemptByScope', (pWhere) => { return pWhere.And[1].NotExists; }).CheckParent).to.equal(false);
						Expect(tmpEnvironment.result.Warnings.filter((pWarning) => { return pWarning.Code === 'CheckParentForced'; }).map((pWarning) => { return `${pWarning.Name} ${pWarning.Pointer}`; })).to.deep.equal(
							[
								'MaterialIntakeRequirement.Forced /Scopes/MaterialIntakeRequirement.Forced/Where/NotExists/Path/0',
								'MaterialIntakeRequirement.NegatedSibling /Scopes/MaterialIntakeRequirement.NegatedSibling/Where/NotExists/Path/0',
								'MaterialIntakeRequirement.OtherFK /Scopes/MaterialIntakeRequirement.OtherFK/Where/NotExists/Path/0',
								'MaterialIntakeRequirement.InsideOr /Scopes/MaterialIntakeRequirement.InsideOr/Where/NotExists/Path/0'
							]);
					});

				test('facet dimensions are checked against the facet Where (ExistsSplit with and without the visiting sibling)',
					() =>
					{
						let tmpSplit = { Kind: 'ExistsSplit', Path: [ '=LabForm.IDMaterialIntake' ], Correlate: [ [ 'IDLabFormType', 'IDLabFormType' ] ] };
						let tmpEnvironment = loadObjects(libLabTrackSeed,
							[
								facetFile({ Facet: 'MaterialIntakeRequirement.SplitForced', Dimensions: [ tmpSplit ] }),
								facetFile({ Facet: 'MaterialIntakeRequirement.SplitExempt', Where: [ { Exists: { Path: [ '>MaterialIntakeRequirement.IDMaterialIntake' ] } } ], Dimensions: [ tmpSplit ] })
							]);
						let tmpForced = tmpEnvironment.registry.facet('MaterialIntakeRequirement.SplitForced');
						Expect(tmpForced.Dimensions[0].Path.Steps[0].CheckParent).to.equal(true);
						Expect(tmpForced.Entities).to.deep.equal([ 'MaterialIntakeRequirement', 'LabForm', 'MaterialIntake' ]);
						Expect(tmpEnvironment.registry.facet('MaterialIntakeRequirement.SplitExempt').Dimensions[0].Path.Steps[0].CheckParent).to.equal(false);
						Expect(tmpEnvironment.result.Warnings.map((pWarning) => { return `${pWarning.Code} ${pWarning.Name} ${pWarning.Pointer}`; })).to.deep.equal(
							[ 'CheckParentForced MaterialIntakeRequirement.SplitForced /Facets/0/Dimensions/0/Path/0' ]);
					});

				test('a forced parent check is one more existence level (ExistsTooDeep counts it)',
					() =>
					{
						let tmpEnvironment = loadObjects(libLabTrackSeed,
							[
								scopeFile(
									{
										'MaterialIntakeRequirement.Deep': { Entity: 'MaterialIntakeRequirement', Where: [ { Exists: { Path: [ '>MaterialIntakeRequirement.IDLabFormType', '<LabForm.IDLabFormType', '=LabForm.IDMaterialIntake' ] } } ] },
										'MaterialIntakeRequirement.Fits': { Entity: 'MaterialIntakeRequirement', Where: [ { Exists: { Path: [ '>MaterialIntakeRequirement.IDLabFormType', '<LabForm.IDLabFormType', '=LabForm.IDMaterialIntake' ] } } ] }
									})
							], { Faceting: { Limits: { MaxExistsDepth: 4 } } });
						// Steps 3 + the parent check inside the third = 4.
						Expect(tmpEnvironment.registry.scope('MaterialIntakeRequirement.Fits')).to.be.an('object');
						let tmpTight = loadObjects(libLabTrackSeed,
							[ scopeFile({ 'MaterialIntakeRequirement.Deep': { Entity: 'MaterialIntakeRequirement', Where: [ { Exists: { Path: [ '>MaterialIntakeRequirement.IDLabFormType', '<LabForm.IDLabFormType', '=LabForm.IDMaterialIntake' ] } } ] } }) ],
							{ Faceting: { Limits: { MaxExistsDepth: 3 } } });
						expectDisabled(tmpTight, 'MaterialIntakeRequirement.Deep', 'ExistsTooDeep');
						Expect(tmpEnvironment.registry.scope('MaterialIntakeRequirement.Deep').Where.Exists.Path.Steps[2].CheckParent).to.equal(true);
					});
			}
		);

		suite
		(
			'Hashes, ModelVersion, reload (internal-contracts §20.7, §30.2)',
			() =>
			{
				test('DefinitionHash / FoldHash / definitionsHash are stable and move with what they cover',
					() =>
					{
						let tmpFirst = loadDomain(libLabTrackSeed);
						let tmpSecond = loadDomain(libLabTrackSeed);
						let tmpMain = tmpFirst.registry.facet('MaterialIntakeRequirement.MyFormsToDo');
						Expect(tmpSecond.registry.facet('MaterialIntakeRequirement.MyFormsToDo').DefinitionHash).to.equal(tmpMain.DefinitionHash);
						Expect(tmpSecond.registry.facet('MaterialIntakeRequirement.MyFormsToDo').FoldHash).to.equal(tmpMain.FoldHash);
						Expect(tmpSecond.registry.definitionsHash()).to.equal(tmpFirst.registry.definitionsHash());
						// The hashes follow the documented formulas.
						let libCrypto = require('crypto');
						let fSha1 = (pText) => { return libCrypto.createHash('sha1').update(pText).digest('hex').substring(0, 12); };
						let tmpAuthored = require(libLabTrackSeed.DEFINITIONS_PATH).Facets[0];
						Expect(tmpMain.DefinitionHash).to.equal('dh:' + fSha1(libFacetClauses.canonicalJSON(tmpAuthored)));
						Expect(tmpMain.FoldHash).to.equal('fh:' + fSha1(`${tmpMain.DefinitionHash}|${tmpFirst.graph.graphHash()}`));
						Expect(tmpFirst.registry.facet('MaterialIntakeRequirement.MyFormsToDo/ByWeek').FoldHash).to.equal('fh:' + fSha1(`${tmpMain.DefinitionHash}/ByWeek|${tmpFirst.graph.graphHash()}`));
						let tmpContent = require('fs').readFileSync(libLabTrackSeed.DEFINITIONS_PATH, 'utf8');
						Expect(tmpFirst.registry.definitionsHash()).to.equal('d:' + fSha1(libFacetClauses.canonicalJSON({ Sources: [ { Source: 'LabTrack-Definitions.json', Hash: libCrypto.createHash('sha1').update(tmpContent).digest('hex') } ], Disabled: [] })));

						// A definitions change moves definitionsHash; a disabled entry is part of it too.
						let tmpObjects = (pValue) => { return { Path: false, Objects: [ scopeFile({ 'Project.X': { Entity: 'Project', Where: [ { Field: 'Status', Op: 'EQ', Value: pValue } ] } }) ] }; };
						let tmpEnvironment = domainEnvironment(libProjectTrackSeed);
						let tmpHashA = tmpEnvironment.registry.load(tmpObjects('A')).DefinitionsHash;
						let tmpScopeHashA = tmpEnvironment.registry.scope('Project.X').DefinitionHash;
						Expect(tmpEnvironment.registry.load(tmpObjects('A')).DefinitionsHash).to.equal(tmpHashA);
						Expect(tmpEnvironment.registry.load(tmpObjects('B')).DefinitionsHash).to.not.equal(tmpHashA);
						Expect(tmpEnvironment.registry.scope('Project.X').DefinitionHash).to.not.equal(tmpScopeHashA);
						Expect(tmpEnvironment.registry.load({ Path: false, Objects: [] }).DefinitionsHash).to.not.equal(tmpHashA);
					});

				test('Catalog.refreshModelVersion: ModelVersion covers the definitions; without a registry it is the M1 value',
					() =>
					{
						let tmpEnvironment = domainEnvironment(libProjectTrackSeed);
						let tmpBefore = tmpEnvironment.catalog.modelVersion();
						tmpEnvironment.registry.load({ Path: false, Objects: [ scopeFile({ 'Project.X': { Entity: 'Project', Where: ACTIVE_WHERE } }) ] });
						Expect(tmpEnvironment.catalog.modelVersion()).to.equal(tmpBefore);
						let tmpWithDefinitions = tmpEnvironment.catalog.refreshModelVersion();
						Expect(tmpWithDefinitions).to.match(/^m:[0-9a-f]{12}$/);
						Expect(tmpWithDefinitions).to.not.equal(tmpBefore);
						Expect(tmpEnvironment.catalog.modelVersion()).to.equal(tmpWithDefinitions);
						tmpEnvironment.registry.load({ Path: false, Objects: [ scopeFile({ 'Project.X': { Entity: 'Project', Where: [ { Field: 'Status', Op: 'EQ', Value: 'Done' } ] } }) ] });
						Expect(tmpEnvironment.catalog.refreshModelVersion()).to.not.equal(tmpWithDefinitions);
						tmpEnvironment.registry.load({ Path: false, Objects: [ scopeFile({ 'Project.X': { Entity: 'Project', Where: ACTIVE_WHERE } }) ] });
						Expect(tmpEnvironment.catalog.refreshModelVersion()).to.equal(tmpWithDefinitions);
						// A catalog on a fable without a registry keeps the M1 ModelVersion material.
						let tmpBare = new libRetoldFacetingCatalog(newFable(), {});
						tmpBare.rebuild(libProjectTrackSeed.model(), null);
						let tmpBareVersion = tmpBare.modelVersion();
						Expect(tmpBare.refreshModelVersion()).to.equal(tmpBareVersion);
						Expect(tmpBare.getHost()).to.equal(null);
					});

				test('atomic swap: a load that fails keeps the previous registry',
					() =>
					{
						let tmpEnvironment = domainEnvironment(libProjectTrackSeed);
						tmpEnvironment.registry.load({ Path: false, Objects: [ scopeFile({ 'Project.X': { Entity: 'Project', Where: ACTIVE_WHERE } }) ] });
						let tmpHash = tmpEnvironment.registry.definitionsHash();
						let tmpPoison = {};
						Object.defineProperty(tmpPoison, 'FormatVersion', { enumerable: true, get: () => { throw new Error('unreadable object'); } });
						let tmpResult = tmpEnvironment.registry.load({ Path: false, Objects: [ tmpPoison ] });
						Expect(tmpResult.Failed).to.equal(true);
						Expect(tmpEnvironment.registry.scope('Project.X')).to.be.an('object');
						Expect(tmpEnvironment.registry.definitionsHash()).to.equal(tmpHash);
						Expect(tmpEnvironment.logged.some((pLine) => { return pLine.indexOf('keeping the previous registry') >= 0; })).to.equal(true);
					});

				test('validate() reports without changing the registry',
					() =>
					{
						let tmpEnvironment = loadDomain(libProjectTrackSeed);
						let tmpHash = tmpEnvironment.registry.definitionsHash();
						let tmpReport = tmpEnvironment.registry.validate(scopeFile({ 'Project.Bad': { Entity: 'Project', Where: [ { Field: 'Nope', Op: 'EQ', Value: 1 } ] }, 'Project.Good': { Entity: 'Project', Where: ACTIVE_WHERE } }, { Aliases: { A: [ '<Task.IDProject' ] } }));
						Expect(tmpReport.Valid).to.equal(false);
						Expect(tmpReport.Errors).to.deep.equal(
							[ { Kind: 'Scope', Name: 'Project.Bad', Code: 'FACET_DEFINITION_INVALID', Reason: 'UnknownField', Pointer: '/Scopes/Project.Bad/Where/0/Field', Step: null, Entity: 'Project', Field: 'Nope', DependsOn: null } ]);
						Expect(tmpReport.Canonical.Scopes.map((pScope) => { return pScope.Scope; })).to.deep.equal([ 'Project.Good' ]);
						Expect(tmpReport.Canonical.Aliases).to.deep.equal({ A: [ '<Task.IDProject' ] });
						Expect(tmpEnvironment.registry.definitionsHash()).to.equal(tmpHash);
						Expect(tmpEnvironment.registry.scope('Project.Good')).to.equal(null);
						Expect(tmpEnvironment.registry.validate(require(libLabTrackSeed.DEFINITIONS_PATH), { Catalog: loadDomain(libLabTrackSeed).catalog }).Valid).to.equal(false);
						let tmpLab = domainEnvironment(libLabTrackSeed);
						let tmpLabReport = tmpLab.registry.validate(require(libLabTrackSeed.DEFINITIONS_PATH));
						Expect(tmpLabReport.Valid).to.equal(true);
						Expect(tmpLabReport.Canonical.Facets.length).to.equal(9);
					});
			}
		);

		suite
		(
			'PathAuto facets (internal-contracts §20.8)',
			() =>
			{
				test('one hop over a graph edge to a non-hub target with a bucketed descriptor',
					() =>
					{
						let tmpRegistry = loadDomain(libProjectTrackSeed).registry;
						let tmpStatus = tmpRegistry.resolveFacet('Document.IDProject>Project.Status');
						Expect(tmpStatus).to.include(
							{
								Facet: 'Document.IDProject>Project.Status', Origin: 'PathAuto', Entity: 'Document', Fold: 'Terms', CountMode: 'Rows', Exclude: 'Self',
								FilterKey: 'Document.IDProject>Project.Status', ClauseType: 'InternalJoinMatch', Selectable: true, MultiValued: false, Source: '#auto', DisplayName: 'Project Status'
							});
						Expect(tmpStatus.Folds).to.deep.equal([ 'Terms' ]);
						Expect(tmpStatus.Path).to.deep.equal([ '>Document.IDProject' ]);
						Expect(tmpStatus.Entities).to.deep.equal([ 'Document', 'Project' ]);
						Expect(tmpStatus.OwnedFields).to.deep.equal([ '@path:>Document.IDProject#Status' ]);
						Expect(compact(tmpStatus.Dimensions[0])).to.include({ Kind: 'Terms', Field: 'Status', Path: '>Document.IDProject', PathShape: 'ToOne', DataType: 'String', LabelLookup: null });
						let tmpStarted = tmpRegistry.resolveFacet('Document.IDProject>Project.StartDate');
						Expect(tmpStarted).to.include({ Fold: 'DateHistogram', ClauseType: 'InternalJoinDateRange' });
						Expect(tmpStarted.Folds).to.deep.equal([ 'DateHistogram' ]);
						Expect(tmpStarted.Dimensions[0].Interval).to.equal('month');
						// An FK target column keeps its label lookup.
						let tmpClient = tmpRegistry.resolveFacet('Document.IDProject>Project.IDClient');
						Expect(tmpClient.Dimensions[0].LabelLookup).to.deep.equal({ Entity: 'Client', KeyColumn: 'IDClient', LabelColumn: 'Name' });
						Expect(tmpClient.ClauseType).to.equal('InternalJoinMatch');
						// Memoized per load.
						Expect(tmpRegistry.resolveFacet('Document.IDProject>Project.Status')).to.equal(tmpStatus);
						Expect(Object.isFrozen(tmpStatus.Dimensions[0].Path)).to.equal(true);
					});

				test('never over tenancy or audit edges, into hubs, over more than one hop, or to an unfaceted column',
					() =>
					{
						let tmpRegistry = loadDomain(libProjectTrackSeed).registry;
						[
							'Project.IDCustomer>Customer.Name',
							'Project.OwnerIDUser>User.NameFirst',
							'Document.IDProject>Project.IDClient>Client.Name',
							'Task.IDProject>Project.IDProject',
							'Task.IDProject>Client.Name',
							'Task.Status>Project.Status',
							'Nope.IDProject>Project.Status',
							'Task.IDProject>Project.GUIDProject',
							'Task.IDProject>Project.Deleted'
						].forEach((pFacetID) => { Expect(tmpRegistry.resolveFacet(pFacetID), pFacetID).to.equal(null); });
						// Declared names win; auto column FacetIDs are the catalog's (null here).
						Expect(tmpRegistry.resolveFacet('Project.MyOverdueBand').Origin).to.equal('Declared');
						Expect(tmpRegistry.resolveFacet('Project.Status')).to.equal(null);
						Expect(tmpRegistry.resolveFacet(42)).to.equal(null);
						let tmpCatalog = tmpRegistry.fable.RetoldFacetingCatalog;
						// Every bucketed column of the target over every offered edge (Task.AssignedIDUser goes into the User hub; IDCustomer is tenancy).
						Expect(tmpCatalog.pathAutoFacets('Task').map((pEntry) => { return pEntry.Facet; })).to.deep.equal(
							[
								'Task.IDProject>Project.CreateDate', 'Task.IDProject>Project.UpdateDate', 'Task.IDProject>Project.Name', 'Task.IDProject>Project.Status',
								'Task.IDProject>Project.StartDate', 'Task.IDProject>Project.IDClient', 'Task.IDProject>Project.OwnerIDUser'
							]);
						Expect(tmpCatalog.pathAutoFacets('Nope')).to.deep.equal([]);
					});
			}
		);

		suite
		(
			'Describe pieces (internal-contracts §30.1)',
			() =>
			{
				test('scopes and declared facets whose every entity the principal may facet, after the auto facets',
					() =>
					{
						let tmpEnvironment = loadDomain(libProjectTrackSeed);
						let tmpDescribe = tmpEnvironment.catalog.describe('Project', null);
						Expect(tmpDescribe.Scopes).to.deep.equal(
							[
								{ Scope: 'Project.MyProjects', Description: 'Projects where I hold one of the given roles, or that I own', Params: { Roles: { Type: 'EnumList', Values: [ 'Owner', 'Lead', 'Member', 'Reviewer' ], Default: [ 'Owner', 'Lead', 'Member' ] } }, Relaxed: false },
								{ Scope: 'Project.HasMyOverdue', Description: 'Projects with at least one overdue task assigned to me', Params: {}, Relaxed: false },
								{ Scope: 'Project.Unblocked', Description: 'Projects with no open Blocker issue (NoVisibleMatch)', Params: {}, Relaxed: false },
								{ Scope: 'Project.ManyOverdue', Description: 'Coverage K19: projects with at least two overdue, unfinished tasks (anyone\'s)', Params: {}, Relaxed: false }
							]);
						let tmpDeclared = tmpDescribe.Facets.filter((pFacet) => { return pFacet.Declared === true; });
						Expect(tmpDeclared.map((pFacet) => { return pFacet.Facet; })).to.deep.equal([ 'Project.MyOverdueBand', 'Project.ByMember', 'Project.HasOpenIssues' ]);
						Expect(tmpDescribe.Facets[tmpDescribe.Facets.length - 3].Facet).to.equal('Project.MyOverdueBand');
						Expect(tmpDeclared[1]).to.deep.equal(
							{
								Facet: 'Project.ByMember', Declared: true, Title: 'Coverage K9: projects by active member (multi-valued)', Description: null,
								DisplayName: 'Coverage K9: projects by active member (multi-valued)', Folds: [ 'Terms' ], DefaultFold: 'Terms', Selectable: true,
								ClauseType: null, FilterKey: 'Project.ByMember', Path: [ '<ProjectMembership.IDProject' ], MultiValued: true, CountMode: 'PivotDistinct', Relaxed: false, Semantics: null,
								Params: {}, Engines: [ 'Live' ], Supported: true, Unsupported: null
							});
						// An entity the principal cannot read removes every scope and facet that reads it.
						let tmpNoTasks = tmpEnvironment.catalog.describe('Project', null, (pEntity) => { return pEntity !== 'Task'; });
						Expect(tmpNoTasks.Scopes.map((pScope) => { return pScope.Scope; })).to.deep.equal([ 'Project.MyProjects', 'Project.Unblocked' ]);
						Expect(tmpNoTasks.Facets.filter((pFacet) => { return pFacet.Declared; }).map((pFacet) => { return pFacet.Facet; })).to.deep.equal([ 'Project.ByMember', 'Project.HasOpenIssues' ]);
						// Describe output is a copy.
						tmpDescribe.Scopes[0].Params.Roles.Values.push('Bogus');
						Expect(tmpEnvironment.registry.scope('Project.MyProjects').Params.Roles.Values).to.deep.equal([ 'Owner', 'Lead', 'Member', 'Reviewer' ]);
					});

				test('unsupported scopes are not listed; ListOneHop lists the PathAuto facets (Declared false)',
					() =>
					{
						let tmpEnvironment = loadObjects(libProjectTrackSeed,
							[ scopeFile({ 'Task.AllDone': { Entity: 'Task', Where: [ { All: { Path: [ '>Task.IDProject' ] } } ] }, 'Task.Open': { Entity: 'Task', Where: [ { Field: 'Status', Op: 'NE', Value: 'Done' } ] } }) ],
							{ Faceting: { Catalog: { ListOneHop: true } } });
						let tmpDescribe = tmpEnvironment.catalog.describe('Task', null);
						Expect(tmpDescribe.Scopes.map((pScope) => { return pScope.Scope; })).to.deep.equal([ 'Task.Open' ]);
						let tmpPathAuto = tmpDescribe.Facets.filter((pFacet) => { return pFacet.Declared === false; });
						Expect(tmpPathAuto.map((pFacet) => { return pFacet.Facet; })).to.deep.equal(tmpEnvironment.catalog.pathAutoFacets('Task').map((pEntry) => { return pEntry.Facet; }));
						let tmpStatus = tmpPathAuto.find((pFacet) => { return pFacet.Facet === 'Task.IDProject>Project.Status'; });
						Expect(tmpStatus).to.include({ DefaultFold: 'Terms', ClauseType: 'InternalJoinMatch', FilterKey: 'Task.IDProject>Project.Status', MultiValued: false });
						Expect(tmpStatus.Path).to.deep.equal([ '>Task.IDProject' ]);
						// A hidden target hides its path facets.
						let tmpHidden = tmpEnvironment.catalog.describe('Task', null, (pEntity) => { return pEntity !== 'Project'; });
						Expect(tmpHidden.Facets.some((pFacet) => { return pFacet.Declared === false; })).to.equal(false);
						// Without ListOneHop they are resolvable but not listed.
						let tmpQuiet = loadObjects(libProjectTrackSeed, []);
						Expect(tmpQuiet.catalog.describe('Task', null).Facets.some((pFacet) => { return pFacet.Declared === false; })).to.equal(false);
					});
			}
		);

		suite
		(
			'§29 post-processing and clauses (pure contract functions)',
			() =>
			{
				let POST = { Engine: 'Live', AsOf: '2026-10-08T12:00:00.000Z', Exact: true, Limits: libOptions.DEFAULTS.Limits, StorageTimeZone: 'UTC', OwnedConjuncts: [] };

				test('ChildRollup bands: keys, labels, spans (Buckets helpers)',
					() =>
					{
						Expect(libFacetBuckets.isBandEdges([ 1, 3, 10 ])).to.equal(true);
						[ [], [ 0 ], [ 3, 1 ], [ 1, 1 ], [ 1.5 ], [ 2, 5 ], 'x', null ].forEach((pEdges) => { Expect(libFacetBuckets.isBandEdges(pEdges), JSON.stringify(pEdges)).to.equal(false); });
						let tmpEdges = [ 1, 3, 10 ];
						Expect([ null, undefined, '', 0, 1, 2, '3', 9, 10, 4000 ].map((pValue) => { return libFacetBuckets.bandKey(pValue, tmpEdges); })).to.deep.equal([ 0, 0, 0, 0, 1, 1, 2, 2, 3, 3 ]);
						Expect([ 0, 1, 2, 3 ].map((pBand) => { return libFacetBuckets.bandLabel(tmpEdges, pBand); })).to.deep.equal([ 'None', '1–2', '3–9', '10+' ]);
						Expect(libFacetBuckets.bandLabel([ 1, 2 ], 1)).to.equal('1');
						Expect(libFacetBuckets.bandLabel(tmpEdges, 0, { 0: 'No overdue' })).to.equal('No overdue');
						Expect(libFacetBuckets.bandLabel(tmpEdges, 3, { 3: 'Lots' })).to.equal('Lots');
						Expect(libFacetBuckets.bandBounds(tmpEdges, 0)).to.equal(null);
						Expect(libFacetBuckets.bandBounds(tmpEdges, 2)).to.deep.equal({ Start: 3, End: 10, EndExclusive: true });
						Expect(libFacetBuckets.bandBounds(tmpEdges, 3)).to.deep.equal({ Start: 10 });
						Expect(libFacetBuckets.existsSplitKey(true)).to.equal(1);
						Expect([ 1, '1', 'true', 0, '0', 'false', false, null, 'x', 2 ].map(libFacetBuckets.existsSplitKey)).to.deep.equal([ 1, 1, 1, 0, 0, 0, 0, null, null, null ]);
						Expect(libFacetBuckets.existsSplitLabel(1)).to.equal('Yes');
						Expect(libFacetBuckets.existsSplitLabel(0, { false: 'Never' })).to.equal('Never');
					});

				test('buildFacetResult: a ChildRollup facet zero-fills every band, Selection only, Declared fields present',
					() =>
					{
						let tmpAgg =
							{
								Key: 'MyOverdue', FacetID: 'Project.MyOverdueBand', FacetIDs: [ 'Project.MyOverdueBand' ], Kind: 'ChildRollup', Pivot: 'Project', Selectable: true,
								Origin: 'Declared', Definition: { Facet: 'Project.MyOverdueBand', Version: 1, DefinitionHash: 'dh:x', FoldHash: 'fh:x', SiblingOf: null },
								Semantics: 'NoVisibleMatch', Relaxed: false, CountMode: 'Rows', Path: null, Missing: true,
								Dimensions: [ { Kind: 'ChildAgg', Edges: [ 1, 3, 10 ], DataType: 'Numeric', IsInteger: true, Labels: { 0: 'No overdue tasks' } } ],
								Disjunctive: { Mode: 'NotApplicable', Excluded: [], ExcludedHashes: [], KeptMixed: [], Owned: [] }
							};
						let tmpResult = libFacetEnvelope.buildFacetResult(tmpAgg, { Total: 9, MissingCount: 0, Groups: [ { Key: 0, Count: 5 }, { Key: 2, Count: 3 }, { Key: '3', Count: 1 } ] }, POST);
						Expect(tmpResult.Fold).to.equal('ChildRollup');
						Expect(tmpResult.Buckets).to.deep.equal(
							[
								{ Key: 0, Label: 'No overdue tasks', Count: 5, Selected: false, Clause: null, Selection: { Facet: 'Project.MyOverdueBand', Key: 0 } },
								{ Key: 1, Label: '1–2', Count: 0, Selected: false, Start: 1, End: 3, EndExclusive: true, Clause: null, Selection: { Facet: 'Project.MyOverdueBand', Key: 1 } },
								{ Key: 2, Label: '3–9', Count: 3, Selected: false, Start: 3, End: 10, EndExclusive: true, Clause: null, Selection: { Facet: 'Project.MyOverdueBand', Key: 2 } },
								{ Key: 3, Label: '10+', Count: 1, Selected: false, Start: 10, Clause: null, Selection: { Facet: 'Project.MyOverdueBand', Key: 3 } }
							]);
						Expect(tmpResult).to.include({ Total: 9, SumOfCounts: 9, MissingCount: 0, OtherCount: 0, Declared: true, Relaxed: false, Semantics: 'NoVisibleMatch', MultiValued: false, CountMode: 'Rows', DataType: 'Numeric' });
						Expect(tmpResult.Definition).to.deep.equal({ Facet: 'Project.MyOverdueBand', Version: 1 });
						Expect(tmpResult.Path).to.equal(null);
						// The M2 fields sit right after CountMode.
						let tmpKeys = Object.keys(tmpResult);
						Expect(tmpKeys.slice(tmpKeys.indexOf('CountMode'), tmpKeys.indexOf('CountMode') + 6)).to.deep.equal([ 'CountMode', 'Declared', 'Definition', 'Path', 'Relaxed', 'Semantics' ]);
						// KeyDesc reverses the bands; a chart lists them.
						let tmpDescending = libFacetEnvelope.buildFacetResult(Object.assign({}, tmpAgg, { Order: 'KeyDesc', Chart: true }), { Total: 9, Groups: [ { Key: 0, Count: 9 } ] }, POST);
						Expect(tmpDescending.Buckets.map((pBucket) => { return pBucket.Key; })).to.deep.equal([ 3, 2, 1, 0 ]);
						Expect(tmpDescending.Chart.Labels).to.deep.equal([ '10+', '3–9', '1–2', 'No overdue tasks' ]);
						Expect(() => { libFacetEnvelope.buildFacetResult(Object.assign({}, tmpAgg, { Dimensions: [ { Kind: 'ChildAgg', Edges: [ 3, 1 ] } ] }), { Total: 1, Groups: [] }, POST); }).to.throw().with.property('Code', 'FACET_INTERNAL');
					});

				test('buildFacetResult: an ExistsSplit facet lists Key 1 then 0 with the definition labels',
					() =>
					{
						let tmpAgg =
							{
								Key: 'Started', FacetID: 'MaterialIntakeRequirement.MyFormsToDo/Started', Kind: 'ExistsSplit', Selectable: true, Origin: 'Sibling',
								Definition: { Facet: 'MaterialIntakeRequirement.MyFormsToDo', Version: 1 }, Relaxed: true, Semantics: 'NoVisibleMatch',
								Dimensions: [ { Kind: 'ExistsFlag', DataType: 'Boolean', IsInteger: true, Labels: { true: 'Started', false: 'Not started' } } ]
							};
						let tmpResult = libFacetEnvelope.buildFacetResult(tmpAgg, { Total: 10, Groups: [ { Key: 0, Count: 4 }, { Key: true, Count: 6 } ] }, POST);
						Expect(tmpResult.Buckets).to.deep.equal(
							[
								{ Key: 1, Label: 'Started', Count: 6, Selected: false, Clause: null, Selection: { Facet: 'MaterialIntakeRequirement.MyFormsToDo/Started', Key: 1 } },
								{ Key: 0, Label: 'Not started', Count: 4, Selected: false, Clause: null, Selection: { Facet: 'MaterialIntakeRequirement.MyFormsToDo/Started', Key: 0 } }
							]);
						Expect(tmpResult).to.include({ Declared: true, Relaxed: true, SumOfCounts: 10, OtherCount: 0, DataType: 'Boolean' });
						let tmpDefault = libFacetEnvelope.buildFacetResult(Object.assign({}, tmpAgg, { Dimensions: [ { Kind: 'ExistsFlag' } ] }), { Total: 0, Groups: [] }, POST);
						Expect(tmpDefault.Buckets.map((pBucket) => { return `${pBucket.Key}:${pBucket.Label}:${pBucket.Count}`; })).to.deep.equal([ '1:Yes:0', '0:No:0' ]);
					});

				test('buildFacetResult: a multi-valued (K9) Terms facet reports OtherCount null and may sum past Total',
					() =>
					{
						let tmpAgg =
							{
								Key: 'Members', FacetID: 'Project.ByMember', Kind: 'Terms', Selectable: true, Origin: 'Declared', MultiValued: true, CountMode: 'PivotDistinct', Top: 2,
								Path: [ '<ProjectMembership.IDProject' ], Definition: { Facet: 'Project.ByMember', Version: 1 },
								Dimensions: [ { Kind: 'Multi', KeyField: 'IDUser', DataType: 'Numeric', IsInteger: true, Chain: [] } ]
							};
						let tmpResult = libFacetEnvelope.buildFacetResult(tmpAgg, { Total: 10, MissingCount: 2, DistinctKeys: 3, Groups: [ { Key: 7, Count: 6 }, { Key: '8', Count: 5 }, { Key: 9, Count: 1 } ] }, POST);
						Expect(tmpResult).to.include({ MultiValued: true, CountMode: 'PivotDistinct', Total: 10, SumOfCounts: 11, MissingCount: 2, OtherCount: null, Truncated: true, DistinctCount: 3, Field: 'IDUser' });
						Expect(tmpResult.Path).to.deep.equal([ '<ProjectMembership.IDProject' ]);
						Expect(tmpResult.Buckets.map((pBucket) => { return [ pBucket.Key, pBucket.Count, pBucket.Clause ]; })).to.deep.equal([ [ 7, 6, null ], [ 8, 5, null ] ]);
						let tmpNoMissing = libFacetEnvelope.buildFacetResult(Object.assign({}, tmpAgg, { Missing: false }), { Total: 10, MissingCount: 2, Groups: [] }, POST);
						Expect(tmpNoMissing).to.include({ MissingCount: 0, OtherCount: null });
					});

				test('auto facets keep the M1 FacetResult shape; PathAuto facets are Declared false',
					() =>
					{
						let tmpAgg = { Key: 'Status', FacetID: 'Project.Status', Kind: 'Terms', Field: 'Status', Selectable: true, Dimensions: [ { Kind: 'Column', Field: 'Status', DataType: 'String' } ] };
						let tmpAuto = libFacetEnvelope.buildFacetResult(tmpAgg, { Total: 1, Groups: [ { Key: 'A', Count: 1 } ] }, POST);
						[ 'Declared', 'Definition', 'Path', 'Relaxed', 'Semantics' ].forEach((pField) => { Expect(tmpAuto).to.not.have.property(pField); });
						Expect(libFacetEnvelope.buildFacetResult(Object.assign({ Origin: 'Auto' }, tmpAgg), { Total: 1, Groups: [] }, POST)).to.not.have.property('Declared');
						let tmpPathAuto = libFacetEnvelope.buildFacetResult(Object.assign({}, tmpAgg, { Origin: 'PathAuto', Path: [ '>Document.IDProject' ] }), { Total: 1, Groups: [] }, POST);
						Expect(tmpPathAuto).to.include({ Declared: false, Definition: null, Relaxed: false, Semantics: null });
					});

				test('the §29.3 clause table: K8 one hop → InternalJoin*, K9 bridge form → ExternalJoinSelectedValueList, everything else Selection only',
					() =>
					{
						let fVia = (pEntity, pFrom, pTo) => { return [ { Rel: { Entity: pEntity, As: 'l1' }, On: [ { Outer: { Alias: 'p', Field: pFrom }, Inner: pTo } ] } ]; };
						let tmpDiscipline = { Fold: 'Terms', Field: 'Discipline', FilterKey: 'F/ByDiscipline', Path: [ '>MaterialIntakeRequirement.IDLabFormType' ], Dimension: { Kind: 'Column', Field: 'Discipline', Via: fVia('LabFormType', 'IDLabFormType', 'IDLabFormType') } };
						Expect(libFacetClauses.bucketClause(tmpDiscipline, { Key: 'Chem' })).to.deep.equal(
							{
								Type: 'InternalJoinMatch', RemoteTable: 'LabFormType', JoinInternalConnectionColumn: 'IDLabFormType', JoinExternalConnectionColumn: 'IDLabFormType',
								ExternalFilterByColumns: [ 'Discipline' ], ExactMatch: true, Values: [ 'Chem' ], FilterKey: 'F/ByDiscipline', ClauseKey: 'InternalJoinMatch'
							});
						Expect(libFacetClauses.bucketClause(Object.assign({}, tmpDiscipline, { Field: 'IDLabFormType', Dimension: { Kind: 'Column', Field: 'IDLabFormType', Via: fVia('LabFormType', 'IDLabFormType', 'IDLabFormType') } }), { Key: 3 })).to.deep.equal(
							{
								Type: 'InternalJoinSelectedValueList', RemoteTable: 'LabFormType', JoinInternalConnectionColumn: 'IDLabFormType', JoinExternalConnectionColumn: 'IDLabFormType',
								ExternalFilterTableLookupColumn: 'IDLabFormType', Values: [ 3 ], FilterKey: 'F/ByDiscipline', ClauseKey: 'InternalJoinSelectedValueList'
							});
						Expect(libFacetClauses.bucketClause(tmpDiscipline, { Key: 'a~b' })).to.equal(null);
						Expect(libFacetClauses.bucketClause(tmpDiscipline, { Key: null })).to.equal(null);
						let tmpWeek = { Fold: 'DateHistogram', Field: 'ReceivedDate', FilterKey: 'F/ByWeek', Path: [ '>MaterialIntakeRequirement.IDMaterialIntake' ], Dimension: { Kind: 'DateBucket', Field: 'ReceivedDate', Via: fVia('MaterialIntake', 'IDMaterialIntake', 'IDMaterialIntake') } };
						Expect(libFacetClauses.bucketClause(tmpWeek, { Key: '2026-03-02 00:00:00', Start: '2026-03-02 00:00:00', End: '2026-03-09 00:00:00' })).to.deep.equal(
							{
								Type: 'InternalJoinDateRange', RemoteTable: 'MaterialIntake', JoinInternalConnectionColumn: 'IDMaterialIntake', JoinExternalConnectionColumn: 'IDMaterialIntake',
								ExternalFilterByColumns: [ 'ReceivedDate' ], Values: { Start: '2026-03-02 00:00:00', End: '2026-03-09 00:00:00' }, EndExclusive: true, FilterKey: 'F/ByWeek', ClauseKey: 'InternalJoinDateRange'
							});
						let tmpAmount = { Fold: 'NumericHistogram', Field: 'Amount', FilterKey: 'Amount', Path: [ '>A.IDB' ], Dimension: { Kind: 'NumericBucket', Field: 'Amount', Via: fVia('B', 'IDB', 'IDB') } };
						Expect(libFacetClauses.bucketClause(tmpAmount, { Key: 4, Start: 40 })).to.deep.equal(
							{ Type: 'InternalJoinNumericRange', RemoteTable: 'B', JoinInternalConnectionColumn: 'IDB', JoinExternalConnectionColumn: 'IDB', ExternalFilterByColumns: [ 'Amount' ], Values: { Start: 40 }, EndExclusive: true, FilterKey: 'Amount', ClauseKey: 'InternalJoinNumericRange' });
						Expect(libFacetClauses.bucketClause(Object.assign({}, tmpAmount, { Fold: 'Ranges' }), { Key: 'lo', End: 3, EndExclusive: false }).Values).to.deep.equal({ End: 3 });
						Expect(libFacetClauses.bucketClause(tmpAmount, { Key: 0 })).to.equal(null);
						// A PathPlan on the dimension works as well as the step strings + Via.
						let tmpPlan = loadDomain(libLabTrackSeed).registry.facet('MaterialIntakeRequirement.MyFormsToDo/ByDiscipline').Dimensions[0];
						Expect(libFacetClauses.bucketClause({ Fold: 'Terms', Field: 'Discipline', FilterKey: 'X', Dimension: tmpPlan }, { Key: 'Chem' }).RemoteTable).to.equal('LabFormType');
						// K8 over two hops: Selection only.
						Expect(libFacetClauses.bucketClause({ Fold: 'Terms', Field: 'IDLabQueue', Path: [ '>MaterialIntakeRequirement.IDMaterialIntake', '>MaterialIntake.IDLabQueue' ], Dimension: { Kind: 'Column', Field: 'IDLabQueue', Via: [] } }, { Key: 1 })).to.equal(null);
						// K9: the bridge form ending at the target key, else nothing.
						let tmpBridge =
							{
								Fold: 'Terms', FilterKey: 'MaterialIntake.ByRequiredForm', MultiValued: true,
								Path: [ '<MaterialIntakeRequirement.IDMaterialIntake', '>MaterialIntakeRequirement.IDLabFormType' ],
								Dimension:
									{
										Kind: 'Multi', KeyField: 'IDLabFormType',
										Chain:
											[
												{ Rel: { Entity: 'MaterialIntakeRequirement', As: 'm1' }, On: [ { Outer: { Alias: 'p', Field: 'IDMaterialIntake' }, Inner: 'IDMaterialIntake' } ] },
												{ Rel: { Entity: 'LabFormType', As: 'm2' }, On: [ { Outer: { Alias: 'm1', Field: 'IDLabFormType' }, Inner: 'IDLabFormType' } ] }
											]
									}
							};
						Expect(libFacetClauses.bucketClause(tmpBridge, { Key: 3 })).to.deep.equal(
							{
								Type: 'ExternalJoinSelectedValueList', CoreConnectionColumn: 'IDMaterialIntake', JoinTable: 'MaterialIntakeRequirement',
								JoinTableCoreConnectionColumn: 'IDMaterialIntake', JoinTableExternalConnectionColumn: 'IDLabFormType', ExternalFilterByTable: 'LabFormType',
								ExternalFilterByTableConnectionColumn: 'IDLabFormType', ExternalFilterTableLookupColumn: 'IDLabFormType', Values: [ 3 ],
								FilterKey: 'MaterialIntake.ByRequiredForm', ClauseKey: 'ExternalJoinSelectedValueList'
							});
						let tmpRegistryBridge = loadDomain(libLabTrackSeed).registry.facet('MaterialIntake.ByRequiredForm').Dimensions[0];
						Expect(libFacetClauses.bucketClause({ Fold: 'Terms', FilterKey: 'X', Dimension: Object.assign({}, tmpRegistryBridge, { Kind: 'Multi' }) }, { Key: 3 }).ExternalFilterByTable).to.equal('LabFormType');
						Expect(libFacetClauses.bucketClause(Object.assign({}, tmpBridge, { Dimension: Object.assign({}, tmpBridge.Dimension, { KeyField: 'Name' }) }), { Key: 'x' })).to.equal(null);
						Expect(libFacetClauses.bucketClause({ Fold: 'Terms', FilterKey: 'X', MultiValued: true, Path: [ '<ProjectMembership.IDProject' ], Dimension: { Kind: 'Multi', KeyField: 'IDUser', Chain: [ { Rel: { Entity: 'ProjectMembership' }, On: [ { Outer: { Alias: 'p', Field: 'IDProject' }, Inner: 'IDProject' } ] } ] } }, { Key: 7 })).to.equal(null);
						// TuplePivot, ChildRollup, ExistsSplit: never a clause.
						Expect(libFacetClauses.bucketClause({ Fold: 'Terms', Field: 'IDLabFormType', Tuple: { Sides: [] } }, { Key: 3 })).to.equal(null);
						Expect(libFacetClauses.bucketClause({ Fold: 'ChildRollup', Field: 'X' }, { Key: 1, Start: 1, End: 3 })).to.equal(null);
						Expect(libFacetClauses.bucketClause({ Fold: 'ExistsSplit', Field: 'X' }, { Key: 1 })).to.equal(null);
						Expect(libFacetClauses.bucketClause({ Fold: 'Terms', Field: 'X', Dimension: { Kind: 'ExistsFlag' } }, { Key: 1 })).to.equal(null);
						// M1 unchanged.
						Expect(libFacetClauses.bucketClause({ Fold: 'Terms', Field: 'Status', FilterKey: 'Status' }, { Key: 'A' }).Type).to.equal('DistinctSelectedValueList');
						Expect(libFacetClauses.pathSignatureOf('  >A.b   <C.d ')).to.equal('>A.b <C.d');
						Expect(libFacetClauses.pathSignatureOf([ '>A.b', { Step: '<C.d' } ])).to.equal('>A.b <C.d');
						Expect(libFacetClauses.pathSignatureOf([ 42 ])).to.equal(null);
						Expect(libFacetClauses.pathSignatureOf(null)).to.equal(null);
					});

				test('buildFacetResult writes the path clauses through the FoldIR Dim (K8 one hop) and none for a W_def-free tuple',
					() =>
					{
						let tmpAgg =
							{
								Key: 'Discipline', FacetID: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline', Kind: 'Terms', Field: 'Discipline', Selectable: true, Origin: 'Sibling',
								FilterKey: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline', Path: [ '>MaterialIntakeRequirement.IDLabFormType' ],
								Dimensions: [ { Kind: 'Column', Field: 'Discipline', DataType: 'String', Via: [ { Rel: { Entity: 'LabFormType', As: 'l1' }, On: [ { Outer: { Alias: 'p', Field: 'IDLabFormType' }, Inner: 'IDLabFormType' } ] } ] } ]
							};
						let tmpResult = libFacetEnvelope.buildFacetResult(tmpAgg, { Total: 3, Groups: [ { Key: 'Chem', Count: 2 }, { Key: 'Bio', Count: 1 } ] }, POST);
						Expect(tmpResult.Buckets[0].Clause).to.include({ Type: 'InternalJoinMatch', RemoteTable: 'LabFormType', FilterKey: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline' });
						Expect(tmpResult.Buckets[0].Clause.Values).to.deep.equal([ 'Chem' ]);
						let tmpTuple = libFacetEnvelope.buildFacetResult(Object.assign({}, tmpAgg, { Tuple: { Sides: [] }, CountMode: 'KeyDistinct' }), { Total: 3, Groups: [ { Key: 'Chem', Count: 2 } ] }, POST);
						Expect(tmpTuple.Buckets[0].Clause).to.equal(null);
						Expect(tmpTuple.Buckets[0].Selection).to.deep.equal({ Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline', Key: 'Chem' });
					});

				test('§29.4 selected keys and ranges from owned join conjuncts (K8 path, K9 bridge, L3 FK form)',
					() =>
					{
						let tmpLab = loadDomain(libLabTrackSeed);
						let tmpPathPlan = tmpLab.graph.resolvePath('MaterialIntakeRequirement', [ '>MaterialIntakeRequirement.IDLabFormType' ]);
						let tmpDiscipline = { Kind: 'Terms', Pivot: 'MaterialIntakeRequirement', Path: [ '>MaterialIntakeRequirement.IDLabFormType' ], Dimensions: [ { Kind: 'Column', Field: 'Discipline', DataType: 'String' } ] };
						let fConjunct = (pPred) => { return libBuilders.conjunct('c1', { Field: '@', Op: 'EQ', Value: 1 }, { Pred: pPred, Fields: [ '@path' ] }); };
						let tmpOwned = fConjunct({ Exists: { From: null, Path: tmpPathPlan, Where: { Or: [ { Field: 'Discipline', Op: 'EQ', Value: 'Chem' }, { Field: 'Discipline', Op: 'IN', Value: [ 'Bio' ] } ] }, Correlate: [] } });
						Expect(libFacetClauses.selectedFrom(tmpDiscipline, [ tmpOwned ])).to.deep.equal({ Keys: [ 'Bio', 'Chem' ], Range: null, Ranges: [], Constrained: true });
						// The step-string form of the path (as a join clause compiles it) selects too.
						Expect(libFacetClauses.selectedFrom(tmpDiscipline, [ fConjunct({ Exists: { Path: [ '>MaterialIntakeRequirement.IDLabFormType' ], Where: { Field: 'Discipline', Op: 'IN', Value: [ 'Chem' ] } } }) ]).Keys).to.deep.equal([ 'Chem' ]);
						// Another path, a Correlate, a plain leaf of the same name, a NotExists: not a selection of this facet.
						Expect(libFacetClauses.selectedFrom(tmpDiscipline, [ fConjunct({ Exists: { Path: [ '>MaterialIntakeRequirement.IDMaterialIntake' ], Where: { Field: 'Discipline', Op: 'IN', Value: [ 'Chem' ] } } }) ]).Constrained).to.equal(false);
						Expect(libFacetClauses.selectedFrom(tmpDiscipline, [ fConjunct({ Exists: { From: null, Path: tmpPathPlan, Where: { Field: 'Discipline', Op: 'IN', Value: [ 'Chem' ] }, Correlate: [ { Outer: { Alias: null, Field: 'X' }, Inner: 'X' } ] } }) ]).Constrained).to.equal(false);
						Expect(libFacetClauses.selectedFrom(tmpDiscipline, [ fConjunct({ Field: 'Discipline', Op: 'IN', Value: [ 'Chem' ] }) ]).Constrained).to.equal(false);
						Expect(libFacetClauses.selectedFrom(tmpDiscipline, [ fConjunct({ NotExists: { Path: [ '>MaterialIntakeRequirement.IDLabFormType' ], Where: { Field: 'Discipline', Op: 'IN', Value: [ 'Chem' ] } } }) ]).Constrained).to.equal(false);
						// Date ranges through a to-one path.
						let tmpWeek = { Kind: 'DateHistogram', Pivot: 'MaterialIntakeRequirement', Path: [ '>MaterialIntakeRequirement.IDMaterialIntake' ], Dimensions: [ { Kind: 'DateBucket', Field: 'ReceivedDate', Interval: 'week' } ] };
						let tmpRange = libFacetClauses.selectedFrom(tmpWeek, [ fConjunct({ Exists: { Path: [ '>MaterialIntakeRequirement.IDMaterialIntake' ], Where: { And: [ { Field: 'ReceivedDate', Op: 'GE', Value: '2026-03-02 00:00:00' }, { Field: 'ReceivedDate', Op: 'LT', Value: '2026-03-16 00:00:00' } ] } } }) ]);
						Expect(tmpRange.Range).to.deep.equal({ Lo: '2026-03-02 00:00:00', LoInclusive: true, Hi: '2026-03-16 00:00:00', HiInclusive: false });
						Expect(libFacetClauses.bucketSelected(tmpWeek, tmpRange, { Key: '2026-03-09 00:00:00', Start: '2026-03-09 00:00:00', End: '2026-03-16 00:00:00' })).to.equal(true);
						// K9 bridge: the ExternalJoinSelectedValueList conjunct.
						let tmpBridge = { Kind: 'Terms', Pivot: 'MaterialIntake', MultiValued: true, Path: [ '<MaterialIntakeRequirement.IDMaterialIntake', '>MaterialIntakeRequirement.IDLabFormType' ], Dimensions: [ { Kind: 'Multi', KeyField: 'IDLabFormType', DataType: 'ID' } ] };
						Expect(libFacetClauses.selectedFrom(tmpBridge, [ fConjunct({ Exists: { Path: [ '<MaterialIntakeRequirement.IDMaterialIntake', '>MaterialIntakeRequirement.IDLabFormType' ], Where: { Field: 'IDLabFormType', Op: 'IN', Value: [ '3', 4 ] } } }) ]).Keys).to.deep.equal([ 3, 4 ]);
						// L3: an FK facet on a pivot column owns the InternalJoinSelectedValueList conjunct (E1's IDClient clause).
						let tmpProject = loadDomain(libProjectTrackSeed);
						let tmpClient = { Kind: 'Terms', Pivot: 'Project', Field: 'IDClient', LabelLookup: { Entity: 'Client', KeyColumn: 'IDClient', LabelColumn: 'Name' }, Dimensions: [ { Kind: 'Column', Field: 'IDClient', DataType: 'Numeric' } ] };
						let tmpL3Plan = tmpProject.graph.resolvePath('Project', [ '>Project.IDClient' ]);
						Expect(libFacetClauses.selectedFrom(tmpClient, [ fConjunct({ Exists: { From: null, Path: tmpL3Plan, Where: { Field: 'IDClient', Op: 'IN', Value: [ 3, 9 ] }, Correlate: [] } }) ]).Keys).to.deep.equal([ 3, 9 ]);
						Expect(libFacetClauses.selectedFrom(tmpClient, [ fConjunct({ Exists: { Path: [ '>Project.IDClient' ], Where: { Field: 'IDClient', Op: 'IN', Value: [ 9 ] } } }) ]).Keys).to.deep.equal([ 9 ]);
						// The plain column clause still selects (M1), and both intersect.
						Expect(libFacetClauses.selectedFrom(tmpClient, [ fConjunct({ Field: 'IDClient', Op: 'IN', Value: [ 3, 5 ] }), fConjunct({ Exists: { Path: [ '>Project.IDClient' ], Where: { Field: 'IDClient', Op: 'IN', Value: [ 3, 9 ] } } }) ]).Keys).to.deep.equal([ 3 ]);
						// TuplePivot and band facets select nothing.
						Expect(libFacetClauses.selectedFrom(Object.assign({ Tuple: {} }, tmpDiscipline), [ tmpOwned ]).Constrained).to.equal(false);
						Expect(libFacetClauses.selectedFrom({ Kind: 'ChildRollup', Dimensions: [ { Kind: 'ChildAgg', Field: 'X' } ] }, [ tmpOwned ]).Constrained).to.equal(false);
					});

				test('round trip with the ClauseCompiler: every path bucket clause compiles (§23.4) into a conjunct the facet owns and selects back',
					() =>
					{
						let tmpLab = loadDomain(libLabTrackSeed);
						let tmpProject = loadDomain(libProjectTrackSeed);
						let fCompiler = (pEnvironment) =>
						{
							[
								[ 'RetoldFacetingFilterValidator', require('../source/request/Retold-Faceting-FilterValidator.js') ],
								[ 'RetoldFacetingFilterAST', require('../source/request/Retold-Faceting-FilterAST.js') ]
							].forEach(
								(pEntry) =>
								{
									pEnvironment.fable.addServiceType(pEntry[0], pEntry[1]);
									pEnvironment.fable.instantiateServiceProvider(pEntry[0], pEnvironment.options);
								});
							return pEnvironment.fable.RetoldFacetingClauseCompiler;
						};
						let tmpCases =
							[
								[ tmpLab, 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline', { Key: 'Chem' } ],
								[ tmpLab, 'MaterialIntakeRequirement.MyFormsToDo/ByWeek', { Key: '2026-03-02 00:00:00', Start: '2026-03-02 00:00:00', End: '2026-03-09 00:00:00' } ],
								[ tmpLab, 'MaterialIntake.ByRequiredForm', { Key: 3 } ],
								[ tmpProject, 'Document.IDProject>Project.Status', { Key: 'Active' } ],
								[ tmpProject, 'Document.IDProject>Project.IDClient', { Key: 9 } ]
							];
						let tmpCompilers = new Map([ [ tmpLab, fCompiler(tmpLab) ], [ tmpProject, fCompiler(tmpProject) ] ]);
						tmpCases.forEach(
							(pCase) =>
							{
								let tmpFacet = pCase[0].registry.resolveFacet(pCase[1]);
								let tmpDimension = Object.assign({}, tmpFacet.Dimensions[0], { Kind: tmpFacet.MultiValued ? 'Multi' : ((tmpFacet.Fold === 'DateHistogram') ? 'DateBucket' : 'Column') });
								let tmpAgg = { Kind: tmpFacet.Fold, Pivot: tmpFacet.Entity, Field: tmpDimension.Field || tmpDimension.KeyField, FilterKey: tmpFacet.FilterKey, Path: tmpFacet.Path, MultiValued: tmpFacet.MultiValued, Dimensions: [ tmpDimension ] };
								let tmpClause = libFacetClauses.bucketClause({ Fold: tmpAgg.Kind, Field: tmpAgg.Field, FilterKey: tmpAgg.FilterKey, Path: tmpAgg.Path, Dimension: tmpDimension, MultiValued: tmpAgg.MultiValued }, pCase[2]);
								Expect(tmpClause, pCase[1]).to.be.an('object');
								Expect(tmpClause.Type, pCase[1]).to.equal(tmpFacet.ClauseType);
								let tmpCompiled = tmpCompilers.get(pCase[0]).compile(tmpFacet.Entity, [ tmpClause ], { Bind: {}, CanFacet: () => { return true; } });
								let tmpConjunct = Object.assign({ Id: 'c1' }, tmpCompiled.Conjuncts[0]);
								// Owned by the facet: by its FilterKey, and by its OwnedFields alone.
								Expect(libFacetClauses.ownership({ OwnedFields: tmpFacet.OwnedFields, FilterKey: tmpFacet.FilterKey }, tmpConjunct), pCase[1]).to.equal('FilterKey');
								Expect(libFacetClauses.ownership({ OwnedFields: tmpFacet.OwnedFields, FilterKey: null }, tmpConjunct), pCase[1]).to.equal('Fields');
								let tmpSelected = libFacetClauses.selectedFrom(tmpAgg, [ tmpConjunct ]);
								Expect(tmpSelected.Constrained, pCase[1]).to.equal(true);
								Expect(libFacetClauses.bucketSelected(tmpAgg, tmpSelected, pCase[2]), pCase[1]).to.equal(true);
							});
						// E1's IDClient join clause is owned by the auto FK facet (L3) and selects its keys.
						let tmpE1 = tmpCompilers.get(tmpProject).compile('Project',
							[ { Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', JoinExternalConnectionColumn: 'IDClient', Values: [ 3, 9 ], FilterKey: 'IDClient', Hash: 'IDClient-IJ-1' } ],
							{ Bind: {}, CanFacet: () => { return true; } });
						let tmpClientFacet = { Kind: 'Terms', Pivot: 'Project', Field: 'IDClient', LabelLookup: { Entity: 'Client', KeyColumn: 'IDClient', LabelColumn: 'Name' }, Dimensions: [ { Kind: 'Column', Field: 'IDClient', DataType: 'Numeric' } ] };
						Expect(libFacetClauses.ownership({ OwnedFields: [ 'IDClient' ], FilterKey: 'IDClient' }, Object.assign({ Id: 'c2' }, tmpE1.Conjuncts[0]))).to.equal('FilterKey');
						Expect(libFacetClauses.selectedFrom(tmpClientFacet, [ tmpE1.Conjuncts[0] ]).Keys).to.deep.equal([ 3, 9 ]);
					});

				test('buildEnvelope carries Records (kept by normalizeForComparison)',
					() =>
					{
						let tmpEnvelope = libFacetEnvelope.buildEnvelope({ Entity: 'Project', Facets: {}, Records: [ { IDProject: 1 } ], RecordsDropped: 2 });
						Expect(tmpEnvelope).to.include({ RecordShape: 'Entity', RecordsDropped: 2 });
						Expect(libFacetEnvelope.normalizeForComparison(tmpEnvelope).Records).to.deep.equal([ { IDProject: 1 } ]);
						Expect(libFacetEnvelope.buildEnvelope({ Entity: 'Project' })).to.not.have.property('Records');
					});
			}
		);
	}
);
