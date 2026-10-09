/**
 * Facet-Live-M2 tests (Builder C): the Live engine's cross-entity folds against DIRECT SQL over the
 * fixture database, on hand-lowered FoldIR (internal-contracts §24), on both domains:
 *
 *   - K8 PathTerms (Via, 1 and 2 hops, DateHistogram through a hop, a global lookup target);
 *   - K9 BridgeTerms (Multi: two-level distinct, MissingCount = pivot rows without a key, a
 *     Multi.Where evaluated through flags of the chain's last relation);
 *   - K10 PathSemiJoin (multi-hop EXISTS chains, as a definition Where and as a Variant PathPred);
 *   - K11 AntiPath with composite correlation, Inherit (owner scope: "no related row VISIBLE to
 *     me") vs TenantOnly (any technician in my lab);
 *   - K12 ChildRollup (bands; the correlated and the pivot-restricted forms agree);
 *   - K18 TuplePivot (expected-minus-actual, distinct Key tuples: the duplicate type requirement);
 *   - K19 HavingCount (CountCmp), K20 ExistsSplit;
 *   - E1 (column conjuncts + join conjunct + three named scopes), E2 (join to a global lookup),
 *     E3 variants A and B, exactly as 08 §2–§4 describe them;
 *   - per-hop scope: two tenants, soft-deleted hops, cross-tenant references both ways;
 *   - Records / Count / Keys statements (§26.5);
 *   - the PredicateCompiler, StagedKeys and shell-registry units; relaxPersonalScope;
 *   - O9: the M2 statement goldens on every dialect (SQLite goldens executed).
 *
 * Goldens: test/goldens/Facet-Live-M2-Goldens.json (regenerate with FACET_UPDATE_GOLDENS=1, then
 * REVIEW the diff).
 *
 * Port 19122 (internal-contracts §32.4; the bench binds an ephemeral port).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libFS = require('fs');
const libPath = require('path');

const libKit = require('./support/Facet-Live-M2-Kit.js');
const F = require('./support/Facet-Live-M2-FoldIR.js');
const libBuilders = require('./support/Facet-Test-Builders.js');
const libOptions = require('../source/Retold-Faceting-Service-Options.js');

const libRetoldFacetingScopeCapture = require('../source/security/Retold-Faceting-ScopeCapture.js');
const libRetoldFacetingScopeGuard = require('../source/security/Retold-Faceting-ScopeGuard.js');
const libRetoldFacetingShellTemplates = require('../source/engine/live/Retold-Faceting-ShellTemplates.js');
const libRetoldFacetingStagedKeys = require('../source/engine/live/Retold-Faceting-StagedKeys.js');
const libRetoldFacetingPredicateCompiler = require('../source/engine/live/Retold-Faceting-PredicateCompiler.js');
const libRetoldFacetingDialects = require('../source/engine/live/Retold-Faceting-Dialects.js');

const libShellSQLite = require('../source/engine/live/Shell-Templates-SQLite.js');
const libShellPostgreSQL = require('../source/engine/live/Shell-Templates-PostgreSQL.js');
const libShellMySQL = require('../source/engine/live/Shell-Templates-MySQL.js');
const libShellMSSQL = require('../source/engine/live/Shell-Templates-MSSQL.js');

const PORT = 19122;

const DIALECTS = [ 'SQLite', 'PostgreSQL', 'MySQL', 'MSSQL' ];

const GOLDEN_FILE = libPath.join(__dirname, 'goldens', 'Facet-Live-M2-Goldens.json');
const UPDATE_GOLDENS = (process.env.FACET_UPDATE_GOLDENS === '1');

const newFable = () => { return libBuilders.newFable('RetoldFacetingLiveM2'); };

/**
 * The context, then execute, then hand the execution to the test (errors fail the test).
 */
const run = (K, pEntity, pPrincipal, pOverrides, pAggs, fCallback) =>
{
	K.context(pEntity, pPrincipal, pOverrides,
		(pContextError, pContext) =>
		{
			if (pContextError)
			{
				return fCallback(pContextError);
			}
			K.execute(K.fable.RetoldFacetingEngineLive, pContext, pAggs,
				(pError, pExecution) =>
				{
					return fCallback(pError, pExecution, pContext);
				});
		});
};

/**
 * A single-Variant (empty filter) context override.
 *
 * @param {string} pEntity
 * @return {Record<string, any>}
 */
const emptyVariants = (pEntity) =>
{
	return { Variants: { v0: F.variant('v0', pEntity, [], null), vt: F.variant('vt', pEntity, [], null) } };
};

/**
 * Assert a raw Terms / DateHistogram result against oracle rows.
 *
 * @param {Record<string, any>} pRaw
 * @param {Array<{ Key: any, N: number }>} pRows
 * @param {string} pLabel
 */
const expectGroups = (pRaw, pRows, pLabel) =>
{
	Expect(pRaw, pLabel).to.be.an('object');
	// (ExistsSplit always reports both keys; a zero group is never an oracle row)
	Expect(F.groupList(pRaw.Groups.filter((pGroup) => { return pGroup.Count > 0; })), `${pLabel} groups`).to.deep.equal(F.oracleList(pRows));
	Expect(pRaw.MissingCount, `${pLabel} missing`).to.equal(F.oracleMissing(pRows));
	Expect(pRaw.Total, `${pLabel} total`).to.equal(F.oracleTotal(pRows));
};

suite
(
	'Facet-Live-M2',
	() =>
	{
		// ============================================================ units (no database)

		suite
		(
			'Shell registry (M2 block)',
			() =>
			{
				test('every dialect has every M2 template and expression, passes the tag scan and dry-builds',
					() =>
					{
						let tmpRegistry = new libRetoldFacetingShellTemplates(newFable());
						Expect(tmpRegistry.validateAll().Errors).to.deep.equal([]);
						[ libShellSQLite, libShellPostgreSQL, libShellMySQL, libShellMSSQL ].forEach(
							(pModule) =>
							{
								libRetoldFacetingShellTemplates.M2_TEMPLATES.forEach((pName) => { Expect(pModule.Templates, `${pModule.Dialect}.${pName}`).to.have.property(pName); });
								[ 'bandIndex', 'dateBound', 'stagedBindNames', 'stagedBindValues', 'stagedMembership' ].forEach((pName) => { Expect(pModule.Expressions[pName], `${pModule.Dialect}.${pName}`).to.be.a('function'); });
							});
						// Templates still reference only the allowed slots.
						libRetoldFacetingShellTemplates.M2_TEMPLATES.forEach(
							(pName) =>
							{
								let tmpTags = String(libShellSQLite.Templates[pName]).match(/<%[\s\S]*?%>/g) || [];
								tmpTags.forEach((pTag) => { Expect(libRetoldFacetingShellTemplates.ALLOWED_SLOT_PATTERN.test(pTag), pTag).to.equal(true); });
							});
					});

				test('band index: 0 for none / NULL, half-open bands, the last band open',
					() =>
					{
						Expect(libShellSQLite.Expressions.bandIndex('"p"."N"', [ 'fE0', 'fE1', 'fE2' ]))
							.to.equal('CASE WHEN "p"."N" IS NULL OR "p"."N" < :fE0 THEN 0 WHEN "p"."N" < :fE1 THEN 1 WHEN "p"."N" < :fE2 THEN 2 ELSE 3 END');
						Expect(libShellPostgreSQL.Expressions.bandIndex('"p"."N"', [ 'fE0' ])).to.equal('CASE WHEN "p"."N" IS NULL OR "p"."N" < CAST(:fE0 AS numeric) THEN 0 ELSE 1 END');
						Expect(libShellMSSQL.Expressions.bandIndex('[p].[N]', [ 'fE0', 'fE1' ])).to.equal('CASE WHEN [p].[N] IS NULL OR [p].[N] < @fE0 THEN 0 WHEN [p].[N] < @fE1 THEN 1 ELSE 2 END');
					});

				test('staged key sets bind ONE scalar per dialect form; anti-joins are NOT EXISTS',
					() =>
					{
						let tmpKeys = [ [ 7, 3 ], [ 8, 1 ] ];
						Expect(libShellSQLite.Expressions.stagedBindNames('h2', 2)).to.deep.equal([ 'h2_Keys' ]);
						Expect(libShellSQLite.Expressions.stagedBindValues(tmpKeys, 2)).to.deep.equal([ '[[7,3],[8,1]]' ]);
						Expect(libShellSQLite.Expressions.stagedBindValues([ [ 5 ], [ 9 ] ], 1)).to.deep.equal([ '[5,9]' ]);
						Expect(libShellPostgreSQL.Expressions.stagedBindNames('h2', 2)).to.deep.equal([ 'h2_K0', 'h2_K1' ]);
						Expect(libShellPostgreSQL.Expressions.stagedBindValues(tmpKeys, 2)).to.deep.equal([ '{7,8}', '{3,1}' ]);
						Expect(libShellSQLite.Expressions.stagedMembership([ '"p"."a"' ], [ 'h2_Keys' ], false)).to.equal('"p"."a" IN (SELECT "v"."value" FROM json_each(:h2_Keys) AS "v")');
						Expect(libShellSQLite.Expressions.stagedMembership([ '"p"."a"' ], [ 'h2_Keys' ], true)).to.equal('NOT EXISTS (SELECT 1 FROM json_each(:h2_Keys) AS "v" WHERE "v"."value" = "p"."a")');
						Expect(libShellSQLite.Expressions.stagedMembership([ '"p"."a"', '"p"."b"' ], [ 'h2_Keys' ], true))
							.to.equal('NOT EXISTS (SELECT 1 FROM json_each(:h2_Keys) AS "v" WHERE json_extract("v"."value", \'$[0]\') = "p"."a" AND json_extract("v"."value", \'$[1]\') = "p"."b")');
						Expect(libShellPostgreSQL.Expressions.stagedMembership([ '"p"."a"' ], [ 'h2_K0' ], false)).to.equal('"p"."a" = ANY(CAST(:h2_K0 AS bigint[]))');
						Expect(libShellPostgreSQL.Expressions.stagedMembership([ '"p"."a"', '"p"."b"' ], [ 'h2_K0', 'h2_K1' ], false))
							.to.equal('EXISTS (SELECT 1 FROM unnest(CAST(:h2_K0 AS bigint[]), CAST(:h2_K1 AS bigint[])) AS "v"("a0", "a1") WHERE "v"."a0" = "p"."a" AND "v"."a1" = "p"."b")');
						Expect(libShellMySQL.Expressions.stagedMembership([ '`p`.`a`' ], [ 'h2_Keys' ], false)).to.equal("`p`.`a` IN (SELECT `v`.`a0` FROM JSON_TABLE(:h2_Keys, '$[*]' COLUMNS (`a0` BIGINT PATH '$')) AS `v`)");
						Expect(libShellMSSQL.Expressions.stagedMembership([ '[p].[a]', '[p].[b]' ], [ 'h2_Keys' ], true))
							.to.equal("NOT EXISTS (SELECT 1 FROM OPENJSON(@h2_Keys) WITH ([a0] bigint '$[0]', [a1] bigint '$[1]') AS [v] WHERE [v].[a0] = [p].[a] AND [v].[a1] = [p].[b])");
					});

				test('staged keys are integers only, sorted and distinct; NULL tuples match nothing; over the cap is 422',
					() =>
					{
						let tmpFable = newFable();
						let tmpStaged = new libRetoldFacetingStagedKeys(tmpFable, libOptions.resolve({ Limits: { MaxStagedKeys: 4 } }));
						let tmpContext = { Options: libOptions.resolve({ Limits: { MaxStagedKeys: 4 } }) };
						let tmpRel = { Entity: 'LabForm', As: 'h2' };
						let tmpSet = tmpStaged._keySet(tmpContext, tmpRel, { Dialect: 'SQLite', Capture: null }, [ 'A', 'B' ], [ [ 8, 1 ], [ '7', 3 ], [ 8, 1 ], [ null, 2 ] ]);
						Expect(tmpSet.Keys).to.deep.equal([ [ 7, 3 ], [ 8, 1 ] ]);
						Expect(tmpSet.Count).to.equal(2);
						Expect(() => { tmpStaged._keySet(tmpContext, tmpRel, { Dialect: 'SQLite' }, [ 'A' ], [ [ 1.5 ] ]); }).to.throw().with.property('Code', 'FACET_INTERNAL');
						Expect(() => { tmpStaged._keySet(tmpContext, tmpRel, { Dialect: 'SQLite' }, [ 'A' ], [ [ 'x' ] ]); }).to.throw().with.property('Code', 'FACET_INTERNAL');
						let tmpTooBroad = null;
						try
						{
							// The capped read (MaxStagedKeys + 1 rows) came back full.
							tmpStaged._keySet(tmpContext, tmpRel, { Dialect: 'SQLite' }, [ 'A' ], [ [ 1 ], [ 2 ], [ 3 ], [ 4 ], [ 5 ] ]);
						}
						catch (pError)
						{
							tmpTooBroad = pError;
						}
						Expect(tmpTooBroad.Code).to.equal('FACET_PATH_TOO_BROAD');
						Expect(tmpTooBroad.Detail).to.deep.equal({ Limit: 'MaxStagedKeys', Max: 4, Suggest: { Engine: 'ClickHouse' } });
						Expect(libRetoldFacetingStagedKeys.integerKey(BigInt(12))).to.equal(12);
						Expect(libRetoldFacetingStagedKeys.integerKey(' 5 ')).to.equal(5);
						Expect(libRetoldFacetingStagedKeys.integerKey(true)).to.equal(null);
					});

				test('relaxPersonalScope removes exactly the principal\'s depth-0 owner entry, and refuses everything else',
					() =>
					{
						let fRelax = libRetoldFacetingScopeCapture.relaxPersonalScope;
						Expect(fRelax).to.equal(libRetoldFacetingScopeCapture.relaxPersonalScope);
						let tmpPolicy = { PersonalScopes: { LabForm: { Column: 'OwnerIDUser', SessionField: 'UserID' } } };
						let tmpPrincipal = { ScopeValues: { IDCustomer: 1, OwnerIDUser: 42 } };
						let E = (pColumn, pValue, pOperator, pConnector, pParameter) => { return { Column: pColumn, Value: pValue, Operator: pOperator || '=', Connector: pConnector || 'AND', Parameter: pParameter || pColumn }; };
						let OPEN = { Column: '', Value: '', Operator: '(', Connector: 'AND', Parameter: 'FacetFenceOpen' };
						let CLOSE = { Column: '', Value: '', Operator: ')', Connector: 'AND', Parameter: 'FacetFenceClose' };
						let tmpFilter = [ E('Status', 'Complete'), E('Deleted', 0), E('IDCustomer', 1), E('OwnerIDUser', 42) ];
						let tmpRelaxed = fRelax(tmpFilter, tmpPolicy, tmpPrincipal, 'LabForm');
						Expect(tmpRelaxed.Refused).to.equal(null);
						Expect(tmpRelaxed.Removed).to.deep.equal([ E('OwnerIDUser', 42) ]);
						Expect(tmpRelaxed.Filter).to.deep.equal([ E('Status', 'Complete'), E('Deleted', 0), E('IDCustomer', 1) ]);
						Expect(tmpFilter.length, 'the input is never mutated').to.equal(4);
						// Qualified, string-valued: still exact.
						Expect(fRelax([ E('IDCustomer', 1), E('"LabForm"."OwnerIDUser"', '42') ], tmpPolicy, tmpPrincipal, 'LabForm').Refused).to.equal(null);
						// Another table's column of that name (a joined table) is never this entity's personal scope.
						Expect(fRelax([ E('IDCustomer', 1), E('Other.OwnerIDUser', 42) ], tmpPolicy, tmpPrincipal, 'LabForm').Refused).to.equal('ColumnElsewhere');
						Expect(fRelax([ E('IDCustomer', 1), E('LabForm.OwnerIDUser', 42) ], tmpPolicy, tmpPrincipal, 'LabForm', 'LabForm').Refused).to.equal(null);
						// Refusals.
						Expect(fRelax(tmpFilter, tmpPolicy, tmpPrincipal, 'Task').Refused).to.equal('NoPersonalScope');
						Expect(fRelax([ E('IDCustomer', 1) ], tmpPolicy, tmpPrincipal, 'LabForm').Refused).to.equal('NotFound');
						Expect(fRelax([ E('IDCustomer', 1), E('OwnerIDUser', 42), E('OwnerIDUser', 42) ], tmpPolicy, tmpPrincipal, 'LabForm').Refused).to.equal('ColumnElsewhere');
						Expect(fRelax([ OPEN, E('OwnerIDUser', 42), CLOSE, E('IDCustomer', 1) ], tmpPolicy, tmpPrincipal, 'LabForm').Refused).to.equal('ColumnElsewhere');
						Expect(fRelax([ E('IDCustomer', 1), E('OwnerIDUser', [ 42 ], 'IN') ], tmpPolicy, tmpPrincipal, 'LabForm').Refused).to.equal('ColumnElsewhere');
						Expect(fRelax([ E('IDCustomer', 1), E('OwnerIDUser', 42, '=', 'OR') ], tmpPolicy, tmpPrincipal, 'LabForm').Refused).to.equal('ColumnElsewhere');
						Expect(fRelax([ E('OwnerIDUser', 42), E('IDCustomer', 1, '=', 'OR') ], tmpPolicy, tmpPrincipal, 'LabForm').Refused, 'an OR term after it').to.equal('ColumnElsewhere');
						Expect(fRelax([ E('IDCustomer', 1), E('OwnerIDUser', 41) ], tmpPolicy, tmpPrincipal, 'LabForm').Refused).to.equal('NotExact');
						Expect(fRelax([ E('IDCustomer', 1), E('OwnerIDUser', 42, '>=') ], tmpPolicy, tmpPrincipal, 'LabForm').Refused).to.equal('NotExact');
						Expect(fRelax([ E('IDCustomer', 1), E('OwnerIDUser', 42) ], tmpPolicy, { ScopeValues: { IDCustomer: 1 } }, 'LabForm').Refused).to.equal('NotExact');
					});

				test('ScopeGuard on a TenantOnly capture: the personal column is not required, and may not remain',
					() =>
					{
						let tmpGuard = new libRetoldFacetingScopeGuard(newFable());
						let tmpPolicy = (
							{
								Kind: 'Policy', Column: 'IDCustomer', PersonalScopes: { LabForm: { Column: 'OwnerIDUser' } }, UnsetValues: [ 0, '', null ], Guard: 'Strict',
								requiredFor: (pEntity, pPrincipal) => { return [ { Column: 'IDCustomer', Value: 1 }, { Column: 'OwnerIDUser', Value: 42 } ]; },
								isScoped: () => { return true; }
							});
						let tmpContext = { Host: { getScopePolicy: () => { return tmpPolicy; } }, Principal: { ScopeValues: { IDCustomer: 1, OwnerIDUser: 42 } }, Options: libOptions.resolve({}) };
						let fQuery = (pEntries) => { return { parameters: { filter: pEntries.map((pEntry) => { return { Column: pEntry[0], Value: pEntry[1], Operator: '=', Connector: 'AND', Parameter: pEntry[0] }; }) } }; };
						let tmpRelaxed = tmpGuard.assert(tmpContext, 'LabForm', fQuery([ [ 'IDCustomer', 1 ] ]), { ScopeMode: 'TenantOnly' });
						Expect(tmpRelaxed.Satisfied).to.equal(true);
						Expect(tmpRelaxed.Required).to.deep.equal([ { Column: 'IDCustomer', Value: 1 } ]);
						Expect(tmpRelaxed.Relaxed).to.equal(true);
						let tmpLeak = tmpGuard.assert(tmpContext, 'LabForm', fQuery([ [ 'IDCustomer', 1 ], [ 'OwnerIDUser', 7 ] ]), { ScopeMode: 'TenantOnly' });
						Expect(tmpLeak.Satisfied).to.equal(false);
						Expect(tmpLeak.Violations).to.deep.equal([ { Rule: 'PersonalColumnPresent', Column: 'OwnerIDUser' } ]);
						// Inherit still requires the owner column.
						let tmpInherit = tmpGuard.assert(tmpContext, 'LabForm', fQuery([ [ 'IDCustomer', 1 ] ]), { ScopeMode: 'Inherit' });
						Expect(tmpInherit.Violations).to.deep.equal([ { Rule: 'MissingPredicate', Column: 'OwnerIDUser' } ]);
						// Trusted opaque: no OpaqueUntrusted; a replaced query is STILL asserted on its filter
						// (the staged run then checks the rendered SQL too) — never deferred to a heuristic.
						let tmpReplacedEmpty = tmpGuard.assert(tmpContext, 'LabForm', fQuery([]), { Opaque: true, Trusted: true, Replaced: true });
						Expect(tmpReplacedEmpty.Satisfied).to.equal(false);
						Expect(tmpReplacedEmpty.Deferred).to.equal(true);
						Expect(tmpReplacedEmpty.Violations).to.deep.equal([ { Rule: 'MissingPredicate', Column: 'IDCustomer' }, { Rule: 'MissingPredicate', Column: 'OwnerIDUser' } ]);
						Expect(tmpGuard.assert(tmpContext, 'LabForm', fQuery([ [ 'IDCustomer', 1 ], [ 'OwnerIDUser', 42 ] ]), { Opaque: true, Trusted: true, Replaced: true }).Satisfied).to.equal(true);
						Expect(tmpGuard.assert(tmpContext, 'LabForm', fQuery([]), { Opaque: true, Trusted: false }).Violations.map((pViolation) => { return pViolation.Rule; })).to.include('OpaqueUntrusted');
						// A policy entry qualified by ANOTHER table never satisfies this entity's requirement.
						let fQualified = (pTable) => { return { parameters: { scope: 'LabForm', filter: [ { Column: `${pTable}.IDCustomer`, Value: 1, Operator: '=', Connector: 'AND', Parameter: 'T' }, { Column: 'OwnerIDUser', Value: 42, Operator: '=', Connector: 'AND', Parameter: 'O' } ] } }; };
						Expect(tmpGuard.assert(tmpContext, 'LabForm', fQualified('LabForm'), { ScopeMode: 'Inherit' }).Satisfied).to.equal(true);
						Expect(tmpGuard.assert(tmpContext, 'LabForm', fQualified('Other'), { ScopeMode: 'Inherit' }).Violations).to.deep.equal([ { Rule: 'MissingPredicate', Column: 'IDCustomer' } ]);
					});

				test('ScopeGuard on a TenantOnly capture fails closed when nothing but the personal column is required, and always checks depth-0 OR',
					() =>
					{
						let tmpGuard = new libRetoldFacetingScopeGuard(newFable());
						let tmpPersonalOnly = (
							{
								Kind: 'Policy', Column: 'IDCustomer', PersonalScopes: { LabForm: { Column: 'OwnerIDUser' } }, UnsetValues: [ 0, '', null ], Guard: 'Strict',
								requiredFor: (pEntity, pPrincipal) => { return [ { Column: 'OwnerIDUser', Value: 42 } ]; },
								isScoped: () => { return true; }
							});
						let tmpContext = { Host: { getScopePolicy: () => { return tmpPersonalOnly; } }, Principal: { ScopeValues: { IDCustomer: 1, OwnerIDUser: 42 } }, Options: libOptions.resolve({}) };
						let tmpUnscoped = tmpGuard.assert(tmpContext, 'LabForm', { parameters: { filter: [] } }, { ScopeMode: 'TenantOnly' });
						Expect(tmpUnscoped.Satisfied).to.equal(false);
						Expect(tmpUnscoped.Violations).to.deep.equal([ { Rule: 'TenantOnlyUnscoped' } ]);
						let tmpOr = tmpGuard.assert(tmpContext, 'LabForm',
							{ parameters: { filter: [ { Column: 'Status', Value: 'A', Operator: '=', Connector: 'AND', Parameter: 'S' }, { Column: 'Status', Value: 'B', Operator: '=', Connector: 'OR', Parameter: 'S2' } ] } },
							{ ScopeMode: 'TenantOnly' });
						Expect(tmpOr.Violations.map((pViolation) => { return pViolation.Rule; })).to.deep.equal([ 'TenantOnlyUnscoped', 'DepthZeroOr' ]);
					});
			}
		);

		// ============================================================ LabTrack

		suite
		(
			'LabTrack on SQLite (E3 variants A and B, coverage folds, per-hop scope)',
			() =>
			{
				let K = null;

				suiteSetup((fDone) => { K = libKit.start({ Domain: 'LabTrack' }, fDone); });
				suiteTeardown((fDone) => { K.stop(fDone); });

				test('E3A: ToDo and its siblings (K8 via one and two hops, a global lookup, a week histogram through a hop, K20) equal direct SQL',
					(fDone) =>
					{
						let tmpAggs = F.e3aAggs(1, 'TenantOnly');
						run(K, 'MaterialIntakeRequirement', 'Tech', emptyVariants('MaterialIntakeRequirement'), tmpAggs,
							(pError, pExecution) =>
							{
								Expect(pError).to.equal(null);
								Expect(pExecution.Errors).to.deep.equal({});
								let O = F.e3aOracle(K, 1, 1, true);
								Expect(O.Total).to.be.above(10);
								expectGroups(pExecution.Results.ToDo, O.ToDo, 'ToDo');
								expectGroups(pExecution.Results.Queue, O.Queue, 'Queue');
								expectGroups(pExecution.Results.Discipline, O.Discipline, 'Discipline');
								expectGroups(pExecution.Results.Week, O.Week, 'Week');
								Expect(pExecution.Results.Week.Bounds).to.be.an('object');
								let tmpStarted = pExecution.Results.Started;
								Expect(tmpStarted.Groups.map((pGroup) => { return pGroup.Key; })).to.deep.equal([ 1, 0 ]);
								expectGroups(tmpStarted, O.Started, 'Started');
								// The queue path drops the soft-deleted queue 5 (its intakes never count).
								Expect(pExecution.Results.Queue.Groups.map((pGroup) => { return pGroup.Key; })).to.not.include(5);
								// Every captured entity is recorded (pivot and hops; LabForm relaxed).
								Expect(Object.keys(pExecution.Captures).sort()).to.include.members([ 'MaterialIntakeRequirement', 'MaterialIntake', 'LabQueue', 'LabQueueMember', 'LabForm', 'LabFormType' ]);
								return fDone();
							});
					});

				test('K11: Inherit on the owner-scoped LabForm means "no completed form VISIBLE to me"; TenantOnly any technician; never another tenant',
					(fDone) =>
					{
						run(K, 'MaterialIntakeRequirement', 'Tech', emptyVariants('MaterialIntakeRequirement'), F.e3aAggs(1, 'Inherit').slice(0, 1),
							(pError, pInherit) =>
							{
								Expect(pError).to.equal(null);
								let tmpInheritOracle = F.e3aOracle(K, 1, 1, false);
								expectGroups(pInherit.Results.ToDo, tmpInheritOracle.ToDo, 'ToDo Inherit');
								let tmpRelaxedOracle = F.e3aOracle(K, 1, 1, true);
								// The colleague's completed forms are still "to do" for me without the relaxation.
								Expect(tmpInheritOracle.Total).to.be.above(tmpRelaxedOracle.Total);
								// The TenantOnly capture fingerprints differently from the Inherit one.
								run(K, 'MaterialIntakeRequirement', 'Tech', emptyVariants('MaterialIntakeRequirement'), F.e3aAggs(1, 'TenantOnly').slice(0, 1),
									(pRelaxedError, pRelaxed) =>
									{
										Expect(pRelaxedError).to.equal(null);
										Expect(pRelaxed.Results.ToDo.Total).to.equal(tmpRelaxedOracle.Total);
										Expect(pRelaxed.Captures.LabForm.Fingerprint).to.not.equal(pInherit.Captures.LabForm.Fingerprint);
										return fDone();
									});
							});
					});

				test('K8 through Via axes: Ranges, an Edges histogram (Missing = no visible queue), a Pivot; K17 an Or of two paths',
					(fDone) =>
					{
						run(K, 'MaterialIntakeRequirement', 'Tech', emptyVariants('MaterialIntakeRequirement'), F.e3aExtraAggs(1),
							(pError, pExecution) =>
							{
								Expect(pError).to.equal(null);
								Expect(pExecution.Errors).to.deep.equal({});
								let O = F.e3aExtraOracle(K, 1, 1);
								expectGroups(pExecution.Results.QueueRanges, O.QueueRanges, 'QueueRanges');
								let tmpEdges = pExecution.Results.QueueEdges;
								Expect(tmpEdges.MissingCount).to.equal(O.QueueEdgesMissing);
								Expect(F.groupList(tmpEdges.Groups)).to.deep.equal(F.oracleList(O.QueueEdges));
								Expect(tmpEdges.Geometry).to.include({ Mode: 'Edges' });
								let tmpCells = pExecution.Results.FormByQueue.Cells.map((pCell) => { return [ JSON.stringify(pCell.Keys), pCell.Count ]; }).sort();
								Expect(tmpCells).to.deep.equal(O.FormByQueue.map((pRow) => { return [ JSON.stringify([ pRow.K1, pRow.K2 ]), pRow.N ]; }).sort());
								Expect(pExecution.Results.AnyPath.Total).to.equal(O.AnyPath);
								Expect(O.AnyPath).to.be.above(0);
								return fDone();
							});
					});

				test('E3A for other principals: Colleague, Newbie (no queue) and tenant 2 (never a tenant-1 row)',
					(fDone) =>
					{
						let tmpCases = [ [ 'Colleague', 1, 2 ], [ 'Newbie', 1, 3 ], [ 'OtherTech', 2, 101 ] ];
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpCases.length)
							{
								return fDone();
							}
							let tmpCase = tmpCases[pIndex];
							run(K, 'MaterialIntakeRequirement', tmpCase[0], emptyVariants('MaterialIntakeRequirement'), F.e3aAggs(tmpCase[2], 'TenantOnly'),
								(pError, pExecution) =>
								{
									Expect(pError).to.equal(null);
									let O = F.e3aOracle(K, tmpCase[1], tmpCase[2], true);
									expectGroups(pExecution.Results.ToDo, O.ToDo, `${tmpCase[0]} ToDo`);
									expectGroups(pExecution.Results.Queue, O.Queue, `${tmpCase[0]} Queue`);
									expectGroups(pExecution.Results.Week, O.Week, `${tmpCase[0]} Week`);
									expectGroups(pExecution.Results.Started, O.Started, `${tmpCase[0]} Started`);
									if (tmpCase[0] === 'Newbie')
									{
										Expect(pExecution.Results.ToDo.Total).to.equal(0);
									}
									if (tmpCase[0] === 'OtherTech')
									{
										// Tenant 2's own work only; the tenant-2 requirement on a tenant-1 intake fails existence.
										let tmpTenant1Queues = [ 1, 2, 3, 4, 5, 6 ];
										pExecution.Results.Queue.Groups.forEach((pGroup) => { Expect(tmpTenant1Queues).to.not.include(pGroup.Key); });
									}
									return fNext(pIndex + 1);
								});
						};
						fNext(0);
					});

				test('E3B (TuplePivot K18): distinct (intake, form type) tuples, the duplicate type requirement counted once',
					(fDone) =>
					{
						let tmpAggs = F.e3bAggs(1);
						run(K, 'MaterialIntake', 'Tech', emptyVariants('MaterialIntake'), tmpAggs,
							(pError, pExecution) =>
							{
								Expect(pError).to.equal(null);
								Expect(pExecution.Errors).to.deep.equal({});
								let O = F.e3bOracle(K, 1, 1);
								Expect(O.Total).to.be.above(5);
								Expect(pExecution.Results.Total.Total).to.equal(O.Total);
								expectGroups(pExecution.Results.ToDo, O.ToDo, 'Tuple ToDo');
								expectGroups(pExecution.Results.Queue, O.Queue, 'Tuple Queue');
								expectGroups(pExecution.Results.Week, O.Week, 'Tuple Week');
								// Without DISTINCT the duplicate (type 1, form 2) requirement would double-count.
								let tmpRaw = K.sql(`SELECT count(*) AS N FROM MaterialIntake i JOIN MaterialTypeFormRequirement t ON t.IDMaterialType = i.IDMaterialType WHERE ${F.visible('i', 1)} AND ${F.visible('t', 1)} AND t.Required = 1 AND i.IDMaterialType = 1 AND t.IDLabFormType = 2`)[0].N;
								let tmpDistinct = K.sql(`SELECT count(DISTINCT i.IDMaterialIntake) AS N FROM MaterialIntake i WHERE ${F.visible('i', 1)} AND i.IDMaterialType = 1`)[0].N;
								Expect(tmpRaw).to.equal(2 * tmpDistinct);
								// The pivot side captured, the type-requirement side captured.
								Expect(pExecution.Captures).to.have.property('MaterialTypeFormRequirement');
								return fDone();
							});
					});

				test('K9 (Multi through the bridge): distinct pivot rows per key; MissingCount = intakes without a key; a Multi.Where through chain flags',
					(fDone) =>
					{
						let A = F.labCoverageAggs(1);
						run(K, 'MaterialIntake', 'Tech', emptyVariants('MaterialIntake'), [ A.ByRequiredForm, A.ByRequiredChemBio ],
							(pError, pExecution) =>
							{
								Expect(pError).to.equal(null);
								Expect(pExecution.Errors).to.deep.equal({});
								let O = F.labCoverageOracle(K, 1, 1);
								let tmpRaw = pExecution.Results.ByRequiredForm;
								Expect(tmpRaw.Total).to.equal(O.Intakes);
								Expect(tmpRaw.MissingCount).to.equal(O.Intakes - O.ByRequiredFormCovered);
								Expect(F.groupList(tmpRaw.Groups)).to.deep.equal(F.oracleList(O.ByRequiredForm));
								Expect(tmpRaw.DistinctKeys).to.equal(O.ByRequiredForm.length);
								// Multi-valued: the counts sum past the Total.
								Expect(F.oracleTotal(O.ByRequiredForm)).to.be.above(tmpRaw.Total - tmpRaw.MissingCount);
								let tmpChemBio = pExecution.Results.ByRequiredChemBio;
								Expect(F.groupList(tmpChemBio.Groups)).to.deep.equal(F.oracleList(O.ByRequiredChemBio));
								Expect(tmpChemBio.MissingCount).to.equal(O.Intakes - O.ByRequiredChemBioCovered);
								return fDone();
							});
					});

				test('K12 bands (correlated and pivot-restricted forms agree), K19 HavingCount, K10 as a definition Where',
					(fDone) =>
					{
						let A = F.labCoverageAggs(1);
						let tmpAggs = [ A.RequirementBands, A.ManyRequirements, A.InMyQueuesByStatus ];
						run(K, 'MaterialIntake', 'Tech', emptyVariants('MaterialIntake'), tmpAggs,
							(pError, pExecution) =>
							{
								Expect(pError).to.equal(null);
								Expect(pExecution.Errors).to.deep.equal({});
								let O = F.labCoverageOracle(K, 1, 1);
								expectGroups(pExecution.Results.RequirementBands, O.RequirementBands, 'Bands');
								Expect(pExecution.Results.ManyRequirements.Total).to.equal(O.ManyRequirements);
								expectGroups(pExecution.Results.InMyQueuesByStatus, O.InMyQueuesByStatus, 'InMyQueues');
								run(K, 'MaterialIntake', 'Tech', Object.assign(emptyVariants('MaterialIntake'), { PlanForm: { ChildAgg: 'Restricted' } }), [ A.RequirementBands ],
									(pRestrictedError, pRestricted) =>
									{
										Expect(pRestrictedError).to.equal(null);
										Expect(F.normalizeRaw(pRestricted.Results.RequirementBands)).to.deep.equal(F.normalizeRaw(pExecution.Results.RequirementBands));
										return fDone();
									});
							});
					});

				test('K10 as a Variant PathPred: the filter applies to every facet of the Variant, before its dimensions',
					(fDone) =>
					{
						let tmpPathPred = F.labQueuePath('p', 'h1', 'h2', 1);
						let tmpConjunct = F.conjunct('c1', { Exists: {} }, { Shape: 'Path', FoldPred: tmpPathPred, NeverExclude: true });
						let tmpStatus = F.conjunct('c2', { Field: 'Status', Op: 'IN', Value: F.OPEN_STATUSES }, { Fields: [ 'Status' ] });
						let tmpVariants = { v0: F.variant('v0', 'MaterialIntake', [ tmpConjunct, tmpStatus ], tmpPathPred) };
						let tmpAggs =
						[
							F.agg({ Key: '#Total', Kind: 'Count', Pivot: 'MaterialIntake' }),
							F.agg({ Key: 'ByQueue', Kind: 'Terms', Pivot: 'MaterialIntake', Dimensions: [ F.columnDim('IDLabQueue', 'Numeric') ] }),
							F.agg({ Key: 'ByWeek', Kind: 'DateHistogram', Pivot: 'MaterialIntake', Dimensions: [ F.dateDim('ReceivedDate', 'week') ] }),
							F.agg({ Key: 'Priority', Kind: 'Terms', Pivot: 'MaterialIntake', Dimensions: [ F.columnDim('Priority', 'String') ] })
						];
						run(K, 'MaterialIntake', 'Tech', { Variants: tmpVariants }, tmpAggs,
							(pError, pExecution) =>
							{
								Expect(pError).to.equal(null);
								Expect(pExecution.Errors).to.deep.equal({});
								let tmpWhere = `${F.visible('i', 1)} AND i.Status IN ('Received', 'InProgress') AND EXISTS (SELECT 1 FROM LabQueue q WHERE ${F.visible('q', 1)} AND q.IDLabQueue = i.IDLabQueue`
									+ ` AND EXISTS (SELECT 1 FROM LabQueueMember m WHERE ${F.visible('m', 1)} AND m.IDLabQueue = q.IDLabQueue AND m.IDUser = 1 AND m.Active = 1))`;
								Expect(pExecution.Results['#Total'].Total).to.equal(K.sql(`SELECT count(*) AS N FROM MaterialIntake i WHERE ${tmpWhere}`)[0].N);
								expectGroups(pExecution.Results.ByQueue, K.sql(`SELECT i.IDLabQueue AS Key, count(*) AS N FROM MaterialIntake i WHERE ${tmpWhere} GROUP BY 1`), 'ByQueue');
								expectGroups(pExecution.Results.ByWeek, K.sql(`SELECT strftime('%Y-%m-%d 00:00:00', i.ReceivedDate, '-6 days', 'weekday 1') AS Key, count(*) AS N FROM MaterialIntake i WHERE ${tmpWhere} GROUP BY 1`), 'ByWeek');
								expectGroups(pExecution.Results.Priority, K.sql(`SELECT i.Priority AS Key, count(*) AS N FROM MaterialIntake i WHERE ${tmpWhere} GROUP BY 1`), 'Priority');
								// Queues 1 and 2 only (3 inactive, 4 deleted membership, 5 deleted queue, tenant-2 membership invisible).
								Expect(pExecution.Results.ByQueue.Groups.map((pGroup) => { return pGroup.Key; }).sort()).to.deep.equal([ 1, 2 ]);
								return fDone();
							});
					});

				test('Staged hops (PlanForm Staged Always) equal the fused statements; Execution.Staged counts them',
					(fDone) =>
					{
						let tmpAggs = F.e3aAggs(1, 'TenantOnly');
						run(K, 'MaterialIntakeRequirement', 'Tech', Object.assign(emptyVariants('MaterialIntakeRequirement'), { PlanForm: { Staged: 'Always' } }), tmpAggs,
							(pError, pStaged) =>
							{
								Expect(pError).to.equal(null);
								Expect(pStaged.Staged.Relations).to.be.above(1);
								Expect(pStaged.Staged.Keys).to.be.above(10);
								run(K, 'MaterialIntakeRequirement', 'Tech', Object.assign(emptyVariants('MaterialIntakeRequirement'), { PlanForm: { Staged: 'Never' } }), tmpAggs,
									(pFusedError, pFused) =>
									{
										Expect(pFusedError).to.equal(null);
										Expect(pFused.Staged).to.deep.equal({ Relations: 0, Keys: 0 });
										tmpAggs.forEach((pAgg) => { Expect(F.normalizeRaw(pStaged.Results[pAgg.Key]), pAgg.Key).to.deep.equal(F.normalizeRaw(pFused.Results[pAgg.Key])); });
										return fDone();
									});
							});
					});

				test('Records / Count / Keys (§26.5): ordered keys (NULLs last, PK tie-break), a page, truncation, the full count',
					(fDone) =>
					{
						let tmpPathPred = F.toDoForMe(1, 'TenantOnly');
						let tmpBasePlan = { Pivot: 'MaterialIntakeRequirement', Variant: F.variant('v0', 'MaterialIntakeRequirement', [ F.conjunct('c1', { Exists: {} }, { Shape: 'Path' }) ], tmpPathPred) };
						let tmpEngine = K.fable.RetoldFacetingEngineLive;
						K.context('MaterialIntakeRequirement', 'Tech', {},
							(pContextError, pContext) =>
							{
								Expect(pContextError).to.equal(null);
								let tmpOracle = K.sql(`SELECT r.IDMaterialIntakeRequirement AS Key, r.IDLabFormType AS F FROM MaterialIntakeRequirement r WHERE ${F.toDoForMeSQL(1, 1, true)}`
									+ ' ORDER BY CASE WHEN r.IDLabFormType IS NULL THEN 1 ELSE 0 END, r.IDLabFormType DESC, r.IDMaterialIntakeRequirement ASC');
								tmpEngine.countBase(pContext, tmpBasePlan,
									(pCountError, pCount) =>
									{
										Expect(pCountError).to.equal(null);
										Expect(pCount).to.equal(tmpOracle.length);
										tmpEngine.recordKeys(pContext, tmpBasePlan, { Sort: [ { Field: 'IDLabFormType', Dir: 'DESC' } ], Begin: 3, Cap: 7 },
											(pKeysError, pPage) =>
											{
												Expect(pKeysError).to.equal(null);
												Expect(pPage.Keys).to.deep.equal(tmpOracle.slice(3, 10).map((pRow) => { return pRow.Key; }));
												Expect(pPage.Statements).to.equal(1);
												tmpEngine.keys(pContext, tmpBasePlan, { Cap: 5 },
													(pAllError, pAll) =>
													{
														Expect(pAllError).to.equal(null);
														let tmpByKey = tmpOracle.map((pRow) => { return pRow.Key; }).sort((pA, pB) => { return pA - pB; });
														Expect(pAll).to.include({ Count: tmpOracle.length, Truncated: true });
														Expect(pAll.Keys).to.deep.equal(tmpByKey.slice(0, 5));
														tmpEngine.keys(pContext, tmpBasePlan, { Cap: 5000 },
															(pWholeError, pWhole) =>
															{
																Expect(pWholeError).to.equal(null);
																Expect(pWhole.Truncated).to.equal(false);
																Expect(pWhole.Keys).to.deep.equal(tmpByKey);
																return fDone();
															});
													});
											});
									});
							});
					});

				test('capable(): TuplePivot Pivots, Multi / ChildAgg pivot axes and foreign CountModes are refused per facet',
					(fDone) =>
					{
						let tmpEngine = K.fable.RetoldFacetingEngineLive;
						let tmpTuple = F.e3bAggs(1)[0];
						Expect(tmpEngine.capable(tmpTuple, {})).to.deep.equal({ Capable: true });
						Expect(tmpEngine.capable(Object.assign({}, tmpTuple, { Kind: 'Pivot' }), {}).Reason).to.equal('TuplePivotPivot');
						Expect(tmpEngine.capable(Object.assign({}, tmpTuple, { CountMode: 'Rows' }), {}).Reason).to.equal('CountMode:Rows');
						let A = F.labCoverageAggs(1);
						Expect(tmpEngine.capable(A.ByRequiredForm, {})).to.deep.equal({ Capable: true });
						Expect(tmpEngine.capable(Object.assign({}, A.ByRequiredForm, { CountMode: 'Rows' }), {}).Capable).to.equal(false);
						Expect(tmpEngine.capable(A.RequirementBands, {})).to.deep.equal({ Capable: true });
						let tmpBadBands = JSON.parse(JSON.stringify(A.RequirementBands));
						tmpBadBands.Dimensions[0].Edges = [ 3, 2 ];
						Expect(tmpEngine.capable(tmpBadBands, {}).Capable).to.equal(false);
						let tmpPivot = F.agg({ Key: 'P', Kind: 'Pivot', Pivot: 'MaterialIntake', Dimensions: [ A.ByRequiredForm.Dimensions[0], F.columnDim('Status', 'String') ] });
						Expect(tmpEngine.capable(tmpPivot, {}).Reason).to.equal('PivotAxis:Multi');
						run(K, 'MaterialIntake', 'Tech', emptyVariants('MaterialIntake'), [ tmpPivot, A.ByRequiredForm ],
							(pError, pExecution) =>
							{
								Expect(pError).to.equal(null);
								Expect(pExecution.Errors.P).to.include({ Code: 'FACET_FOLD_UNSUPPORTED' });
								Expect(pExecution.Results.ByRequiredForm.Total).to.be.above(0);
								return fDone();
							});
					});
			}
		);

		// ============================================================ ProjectTrack

		suite
		(
			'ProjectTrack on SQLite (E1, E2, coverage folds)',
			() =>
			{
				let K = null;
				const CLIENTS = [ 1, 2, 3, 4, 5, 8, 101 ];

				suiteSetup((fDone) => { K = libKit.start({ Domain: 'ProjectTrack' }, fDone); });
				suiteTeardown((fDone) => { K.stop(fDone); });

				test('E1 per Variant (Cube Never): column conjuncts, the join conjunct, three named scopes, a child band and a pivot equal direct SQL',
					(fDone) =>
					{
						let P = F.e1Plan(1, CLIENTS);
						run(K, 'Project', 'Lead', { Variants: P.Variants, PlanForm: { Cube: 'Never' } }, P.Aggs,
							(pError, pExecution) =>
							{
								Expect(pError).to.equal(null);
								Expect(pExecution.Errors).to.deep.equal({});
								let O = F.e1Oracle(K, 1, 1, CLIENTS);
								Expect(O.Total).to.be.above(2);
								Expect(pExecution.Results['#Total'].Total).to.equal(O.Total);
								expectGroups(pExecution.Results.Status, O.Status, 'Status');
								expectGroups(pExecution.Results.Client, O.Client, 'Client');
								expectGroups(pExecution.Results.Started, O.Started, 'Started');
								expectGroups(pExecution.Results.MyOverdue, O.MyOverdue, 'MyOverdue');
								let tmpCells = pExecution.Results.StatusByClient.Cells.map((pCell) => { return [ JSON.stringify(pCell.Keys), pCell.Count ]; }).sort();
								let tmpOracleCells = O.StatusByClient.map((pRow) => { return [ JSON.stringify([ pRow.K1, pRow.K2 ]), pRow.N ]; }).sort();
								Expect(tmpCells).to.deep.equal(tmpOracleCells);
								// Deleted client 8 and tenant-2 client 101 fail the join conjunct's existence.
								let tmpClientKeys = pExecution.Results.Client.Groups.map((pGroup) => { return pGroup.Key; });
								Expect(tmpClientKeys).to.not.include(101);
								Expect(Object.keys(pExecution.Captures).sort()).to.deep.equal([ 'Client', 'Issue', 'Project', 'ProjectMembership', 'Task' ]);
								return fDone();
							});
					});

				test('E1 Records: the full-filter keys ordered by StartDate DESC (NULLs last) then the key; Count; Keys',
					(fDone) =>
					{
						let P = F.e1Plan(1, CLIENTS);
						let tmpEngine = K.fable.RetoldFacetingEngineLive;
						K.context('Project', 'Lead', { Variants: P.Variants },
							(pContextError, pContext) =>
							{
								let O = F.e1Oracle(K, 1, 1, CLIENTS);
								let tmpBasePlan = { Pivot: 'Project', Variant: P.Variants.v0 };
								tmpEngine.recordKeys(pContext, tmpBasePlan, { Sort: [ { Field: 'StartDate', Dir: 'DESC' } ], Begin: 0, Cap: 50 },
									(pError, pPage) =>
									{
										Expect(pError).to.equal(null);
										Expect(pPage.Keys).to.deep.equal(O.Keys.slice(0, 50));
										tmpEngine.countBase(pContext, tmpBasePlan,
											(pCountError, pCount) =>
											{
												Expect(pCount).to.equal(O.Total);
												return fDone();
											});
									});
							});
					});

				test('E2 (join to a global lookup; a dangling FK fails existence) equals direct SQL',
					(fDone) =>
					{
						let C = F.projectCoverage(1, 3);
						run(K, 'Document', 'Lead', { Variants: C.E2Variants }, C.E2Aggs,
							(pError, pExecution) =>
							{
								Expect(pError).to.equal(null);
								Expect(pExecution.Errors).to.deep.equal({});
								let O = F.projectCoverageOracle(K, 1, 1, 3).E2;
								Expect(pExecution.Results['#Total'].Total).to.equal(O.Total);
								expectGroups(pExecution.Results.ByMonth, O.ByMonth, 'ByMonth');
								expectGroups(pExecution.Results.ByForm, O.ByForm, 'ByForm');
								expectGroups(pExecution.Results.Status, O.Status, 'Status');
								Expect(pExecution.Results.ByForm.Groups.map((pGroup) => { return pGroup.Key; })).to.include(99);
								return fDone();
							});
					});

				test('Coverage: K8 two hops (invisible / deleted targets are Missing), K10 two hops, K9 over a payload table, K20, K19',
					(fDone) =>
					{
						let C = F.projectCoverage(1, 3);
						run(K, 'Document', 'Lead', emptyVariants('Document'), [ C.ByClient, C.InMyProjects ],
							(pError, pDocuments) =>
							{
								Expect(pError).to.equal(null);
								Expect(pDocuments.Errors).to.deep.equal({});
								let O = F.projectCoverageOracle(K, 1, 1, 3);
								expectGroups(pDocuments.Results.ByClient, O.ByClient, 'ByClient');
								Expect(pDocuments.Results.ByClient.MissingCount).to.be.above(0);
								expectGroups(pDocuments.Results.InMyProjects, O.InMyProjects, 'InMyProjects');
								run(K, 'Project', 'Lead', emptyVariants('Project'), [ C.ByMember, C.HasOpenIssues, C.ManyOverdue ],
									(pProjectError, pProjects) =>
									{
										Expect(pProjectError).to.equal(null);
										Expect(pProjects.Errors).to.deep.equal({});
										Expect(pProjects.Results.ByMember.Total).to.equal(O.Projects);
										Expect(pProjects.Results.ByMember.MissingCount).to.equal(O.Projects - O.ByMemberCovered);
										Expect(F.groupList(pProjects.Results.ByMember.Groups)).to.deep.equal(F.oracleList(O.ByMember));
										expectGroups(pProjects.Results.HasOpenIssues, O.HasOpenIssues, 'HasOpenIssues');
										expectGroups(pProjects.Results.ManyOverdue, O.ManyOverdue, 'ManyOverdue');
										return fDone();
									});
							});
					});

				test('Two-tenant isolation on every hop: tenant 2 sees its own rows only; the tenant-2 Blocker on a tenant-1 project never blocks',
					(fDone) =>
					{
						let P = F.e1Plan(101, [ 101, 102, 103, 1 ]);
						run(K, 'Project', 'OtherLead', { Variants: P.Variants, PlanForm: { Cube: 'Never' } }, P.Aggs,
							(pError, pExecution) =>
							{
								Expect(pError).to.equal(null);
								let O = F.e1Oracle(K, 2, 101, [ 101, 102, 103, 1 ]);
								Expect(pExecution.Results['#Total'].Total).to.equal(O.Total);
								expectGroups(pExecution.Results.Status, O.Status, 'T2 Status');
								expectGroups(pExecution.Results.Client, O.Client, 'T2 Client');
								pExecution.Results.Client.Groups.forEach((pGroup) => { Expect([ 101, 102, 103 ]).to.include(pGroup.Key); });
								// Project 6 (tenant 1) has only the invisible tenant-2 Blocker: Lead's Unblocked keeps it.
								let tmpUnblocked = K.sql(`SELECT count(*) AS N FROM Project pr WHERE pr.IDProject = 6 AND ${F.e1SQL(1, 1, CLIENTS).c6}`)[0].N;
								Expect(tmpUnblocked).to.equal(1);
								return fDone();
							});
					});
			}
		);

		// ============================================================ O9 goldens

		suite
		(
			'O9: M2 statement goldens on every dialect',
			() =>
			{
				let K = null;
				let L = null;
				let _Goldens = {};
				let _Fresh = {};

				suiteSetup(
					(fDone) =>
					{
						if (libFS.existsSync(GOLDEN_FILE))
						{
							_Goldens = JSON.parse(libFS.readFileSync(GOLDEN_FILE, 'utf8'));
						}
						K = libKit.start({ Domain: 'ProjectTrack' },
							(pError) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								L = libKit.start({ Domain: 'LabTrack' }, fDone);
							});
					});
				suiteTeardown(
					(fDone) =>
					{
						if (UPDATE_GOLDENS)
						{
							libFS.mkdirSync(libPath.dirname(GOLDEN_FILE), { recursive: true });
							let tmpOrdered = {};
							Object.keys(_Fresh).sort().forEach((pKey) => { tmpOrdered[pKey] = _Fresh[pKey]; });
							libFS.writeFileSync(GOLDEN_FILE, `${JSON.stringify(tmpOrdered, null, '\t')}\n`);
						}
						K.stop(() => { L.stop(fDone); });
					});

				// One statement form per K kind (plus the cube and a staged membership), per dialect.
				let tmpCases =
				[
					[ 'K8-PathTerms', 'LabTrack', 'MaterialIntakeRequirement', () => { return F.e3aAggs(1, 'TenantOnly')[1]; } ],
					[ 'K9-BridgeTerms', 'LabTrack', 'MaterialIntake', () => { return F.labCoverageAggs(1).ByRequiredChemBio; } ],
					[ 'K10-PathSemiJoin', 'LabTrack', 'MaterialIntake', () => { return F.labCoverageAggs(1).InMyQueuesByStatus; } ],
					[ 'K11-AntiPathComposite', 'LabTrack', 'MaterialIntakeRequirement', () => { return F.e3aAggs(1, 'TenantOnly')[0]; } ],
					[ 'K12-ChildRollup', 'LabTrack', 'MaterialIntake', () => { return F.labCoverageAggs(1).RequirementBands; } ],
					[ 'K18-TuplePivot', 'LabTrack', 'MaterialIntake', () => { return F.e3bAggs(1)[0]; } ],
					[ 'K19-HavingCount', 'ProjectTrack', 'Project', () => { return F.projectCoverage(1, 3).ManyOverdue; } ],
					[ 'K20-ExistsSplit', 'ProjectTrack', 'Project', () => { return F.projectCoverage(1, 3).HasOpenIssues; } ],
					[ 'Staged-Membership', 'LabTrack', 'MaterialIntakeRequirement', () => { return F.e3aAggs(1, 'TenantOnly')[0]; }, { Staged: 'Always' } ]
				];

				tmpCases.forEach(
					(pCase) =>
					{
						test(`${pCase[0]}: dry-built on every dialect, scalar binds only; SQLite executes to the live answer`,
							(fDone) =>
							{
								let tmpBench = (pCase[1] === 'LabTrack') ? L : K;
								let tmpPrincipal = (pCase[1] === 'LabTrack') ? 'Tech' : 'Lead';
								let tmpAgg = pCase[3]();
								// Staged key sets are READ (on the bench's SQLite) before the outer statement is
								// composed: the other dialects reuse the SQLite read's key sets (dry-build only).
								let tmpStagedMemo = null;
								let fDialect = (pIndex) =>
								{
									if (pIndex >= DIALECTS.length)
									{
										return fDone();
									}
									let tmpDialect = DIALECTS[pIndex];
									tmpBench.context(pCase[2], tmpPrincipal, Object.assign(emptyVariants(pCase[2]), { Dialect: tmpDialect, PlanForm: pCase[4] || {} }),
										(pContextError, pContext) =>
										{
											Expect(pContextError).to.equal(null);
											if (tmpStagedMemo)
											{
												pContext.Memo.Staged = tmpStagedMemo;
											}
											tmpBench.fable.RetoldFacetingEngineLive.compileComposedAgg(pContext, tmpAgg, {},
												(pError, pCompiled) =>
												{
													Expect(pError, `${pCase[0]} ${tmpDialect}`).to.equal(null);
													pCompiled.Statements.forEach(
														(pStatement) =>
														{
															Expect(pStatement.SQL).to.not.match(/<%|%>/);
															// Shell binds (f*) and staged key sets are always scalars (FoxHound's own IN
															// binds inside a relation may be arrays on PG / MySQL: the provider expands them).
															Object.keys(pStatement.Params).filter((pName) => { return /^f|_Keys$|_K[0-9]+$/.test(pName); }).forEach((pName) => { Expect(Array.isArray(pStatement.Params[pName]), `${pCase[0]} ${tmpDialect} ${pName}`).to.equal(false); });
														});
													if (pContext.Memo.Staged)
													{
														tmpStagedMemo = pContext.Memo.Staged;
													}
													let tmpKey = `${pCase[0]}|${tmpDialect}`;
													let tmpGolden = pCompiled.Statements.map((pStatement) => { return { Name: pStatement.Name, SQL: pStatement.SQL, Params: pStatement.Params, ParamTypes: pStatement.ParamTypes }; });
													_Fresh[tmpKey] = tmpGolden;
													if (!UPDATE_GOLDENS)
													{
														Expect(_Goldens, `golden ${tmpKey} missing: run with FACET_UPDATE_GOLDENS=1`).to.have.property(tmpKey);
														Expect(JSON.parse(JSON.stringify(tmpGolden)), tmpKey).to.deep.equal(_Goldens[tmpKey]);
													}
													if (tmpDialect !== 'SQLite')
													{
														return fDialect(pIndex + 1);
													}
													// Execute the SQLite golden directly and compare with the engine's own answer.
													let tmpFirst = pCompiled.Statements[0];
													let tmpParams = {};
													Object.keys(tmpFirst.Params).forEach((pName) => { if (new RegExp(`:${pName}(?![A-Za-z0-9_])`).test(tmpFirst.SQL)) { tmpParams[pName] = tmpFirst.Params[pName]; } });
													let tmpRows = tmpBench.db.prepare(tmpFirst.SQL).all(tmpParams);
													Expect(tmpRows.length).to.be.above(0);
													run(tmpBench, pCase[2], tmpPrincipal, Object.assign(emptyVariants(pCase[2]), { PlanForm: pCase[4] || {} }), [ tmpAgg ],
														(pRunError, pExecution) =>
														{
															Expect(pRunError).to.equal(null);
															Expect(pExecution.Errors).to.deep.equal({});
															let tmpSum = tmpRows.reduce((pSum, pRow) => { return pSum + Number(pRow.Count || pRow.Total || 0); }, 0);
															if (tmpFirst.Name !== 'MultiTerms')
															{
																Expect(tmpSum).to.equal(pExecution.Results[tmpAgg.Key].Total);
															}
															return fDialect(pIndex + 1);
														});
												});
										});
								};
								fDialect(0);
							});
					});

				test('Records / Keys: the E1 full-filter key statements dry-build on every dialect (NULLs last, PK tie-break, scalar page binds)',
					(fDone) =>
					{
						let P = F.e1Plan(1, [ 1, 2, 3, 4, 5, 8, 101 ]);
						let tmpEngine = K.fable.RetoldFacetingEngineLive;
						let fDialect = (pIndex) =>
						{
							if (pIndex >= DIALECTS.length)
							{
								return fDone();
							}
							let tmpDialect = DIALECTS[pIndex];
							K.context('Project', 'Lead', { Variants: P.Variants, Dialect: tmpDialect },
								(pContextError, pContext) =>
								{
									tmpEngine.composeBase(pContext, { Pivot: 'Project', Variant: P.Variants.v0 }, [ 'StartDate' ],
										(pError, pComposed) =>
										{
											Expect(pError).to.equal(null);
											let tmpAgg = { Key: '#Records', Kind: 'Count', Pivot: 'Project', Dimensions: [] };
											let tmpRecords = tmpEngine.compileStatement(pContext, tmpAgg, [ pComposed.Base ], tmpDialect, { Shell: 'RecordKeys', PrimaryKey: 'IDProject', Sort: [ { Field: 'StartDate', Dir: 'DESC' } ], Begin: 10, Cap: 50 });
											let tmpKeys = tmpEngine.compileStatement(pContext, tmpAgg, [ pComposed.Base ], tmpDialect, { Shell: 'Keys', PrimaryKey: 'IDProject', Cap: 1000 });
											Expect(tmpRecords.Params).to.include({ fCap: 50, fBegin: 10 });
											Expect(tmpKeys.Params).to.include({ fCapPlusOne: 1001 });
											Expect(tmpRecords.SQL).to.match(/CASE WHEN .*StartDate.* IS NULL THEN 1 ELSE 0 END, .*StartDate.* DESC, .*IDProject.* ASC/);
											let tmpGolden = [ tmpRecords, tmpKeys ].map((pStatement) => { return { Name: pStatement.Name, SQL: pStatement.SQL, Params: pStatement.Params, ParamTypes: pStatement.ParamTypes }; });
											let tmpKey = `Records-E1|${tmpDialect}`;
											_Fresh[tmpKey] = tmpGolden;
											if (!UPDATE_GOLDENS)
											{
												Expect(_Goldens, `golden ${tmpKey} missing: run with FACET_UPDATE_GOLDENS=1`).to.have.property(tmpKey);
												Expect(JSON.parse(JSON.stringify(tmpGolden))).to.deep.equal(_Goldens[tmpKey]);
											}
											return fDialect(pIndex + 1);
										});
								});
						};
						fDialect(0);
					});

				test('Cube: the E1 grain statement dry-builds on every dialect (one GROUP BY, flags b1-b3, the band, the month bounds)',
					(fDone) =>
					{
						let P = F.e1Plan(1, [ 1, 2, 3, 4, 5, 8, 101 ]);
						let fDialect = (pIndex) =>
						{
							if (pIndex >= DIALECTS.length)
							{
								return fDone();
							}
							let tmpDialect = DIALECTS[pIndex];
							K.context('Project', 'Lead', { Variants: P.Variants, Dialect: tmpDialect, Cubes: [ P.Cube ] },
								(pContextError, pContext) =>
								{
									let tmpExecutor = K.fable.RetoldFacetingCubeExecutor;
									let tmpEngine = K.fable.RetoldFacetingEngineLive;
									// Capture the statement instead of running it.
									let fRun = tmpEngine.runStatement;
									let tmpCaptured = null;
									tmpEngine.runStatement = function (pStatementContext, pExecution, pAgg, pRelation, pSlots, fStatementDone)
									{
										tmpCaptured = this.compileStatement(pStatementContext, pAgg, [ pRelation ], tmpDialect, pSlots);
										return fStatementDone(null, []);
									};
									tmpExecutor.execute(pContext, tmpEngine.newExecution(pContext), P.Cube, P.Aggs,
										(pError, pResult) =>
										{
											tmpEngine.runStatement = fRun;
											Expect(pError).to.equal(null);
											Expect(pResult.FellBack).to.equal(false);
											Expect(tmpCaptured.Name).to.equal('Cube');
											Expect(tmpCaptured.SQL.match(/GROUP BY/g).length, 'one plain GROUP BY (plus the band subquery, none)').to.equal(1);
											[ 'b1', 'b2', 'b3', 'd1', 'd2', 'd3', 'd4', 'lo3', 'hi3' ].forEach((pColumn) => { Expect(tmpCaptured.SQL).to.contain(pColumn); });
											Object.keys(tmpCaptured.Params).filter((pName) => { return /^f/.test(pName); }).forEach((pName) => { Expect(Array.isArray(tmpCaptured.Params[pName])).to.equal(false); });
											let tmpKey = `Cube-E1|${tmpDialect}`;
											let tmpGolden = [ { Name: tmpCaptured.Name, SQL: tmpCaptured.SQL, Params: tmpCaptured.Params, ParamTypes: tmpCaptured.ParamTypes } ];
											_Fresh[tmpKey] = tmpGolden;
											if (!UPDATE_GOLDENS)
											{
												Expect(_Goldens, `golden ${tmpKey} missing: run with FACET_UPDATE_GOLDENS=1`).to.have.property(tmpKey);
												Expect(JSON.parse(JSON.stringify(tmpGolden))).to.deep.equal(_Goldens[tmpKey]);
											}
											return fDialect(pIndex + 1);
										});
								});
						};
						fDialect(0);
					});
			}
		);

		// ============================================================ the Planner's FoldIR (integration)

		suite
		(
			'Integration: definitions (registry) → Binder / FilterAST / Planner lowering and CubePlan → Live == direct SQL',
			() =>
			{
				let P = null;
				let L = null;
				const libProjectTrackSeed = require('./fixtures/ProjectTrack-Seed.js');
				const libLabTrackSeed = require('./fixtures/LabTrack-Seed.js');

				suiteSetup(
					(fDone) =>
					{
						P = libKit.start({ Domain: 'ProjectTrack' },
							(pError) =>
							{
								if (pError)
								{
									return fDone(pError);
								}
								L = libKit.start({ Domain: 'LabTrack' },
									(pLabError) =>
									{
										if (pLabError)
										{
											return fDone(pLabError);
										}
										// The domain definitions files, loaded into the registry (no disabled entry).
										Expect(P.fable.RetoldFacetingDefinitionRegistry.load({ Path: false, Files: [ libProjectTrackSeed.DEFINITIONS_PATH ], Objects: [] }).Disabled).to.deep.equal([]);
										Expect(L.fable.RetoldFacetingDefinitionRegistry.load({ Path: false, Files: [ libLabTrackSeed.DEFINITIONS_PATH ], Objects: [] }).Disabled).to.deep.equal([]);
										return fDone();
									});
							});
					});
				suiteTeardown((fDone) => { P.stop(() => { L.stop(fDone); }); });

				/**
				 * Bind, build the FilterAST, plan, then execute the plan's Aggs (and Cubes) on Live.
				 */
				let fPipeline = (K, pEntity, pPrincipal, pBody, pPlanForm, fCallback) =>
				{
					K.context(pEntity, pPrincipal, { PlanForm: pPlanForm },
						(pContextError, pContext) =>
						{
							Expect(pContextError).to.equal(null);
							let tmpFable = K.fable;
							pContext.NormalizedRequest = (
								{
									Facets: pBody.Facets.map((pFacet) => { return Object.assign({ FacetIDs: Array.isArray(pFacet.Facet) ? pFacet.Facet : [ pFacet.Facet ], Fold: null, Top: null, Order: null, Exclude: null }, pFacet); }),
									Total: true, Clauses: pBody.Clauses || [], FilterString: null, Scopes: pBody.Scopes || [], Params: pBody.Params || {}
								});
							pContext.Bind = tmpFable.RetoldFacetingBinder.context(pContext);
							pContext.FilterAST = tmpFable.RetoldFacetingFilterAST.build(pEntity, { Clauses: pContext.NormalizedRequest.Clauses, FilterString: null, Scopes: pContext.NormalizedRequest.Scopes, Bind: pContext.Bind, CanFacet: null });
							tmpFable.RetoldFacetingPlanner.plan(pContext,
								(pPlanError, pPlan) =>
								{
									Expect(pPlanError).to.equal(null);
									Expect(pPlan.Errors).to.deep.equal({});
									pContext.Variants = pPlan.Variants;
									// (the wiring puts Plan.Cubes on the context for the engine)
									pContext.Cubes = pPlan.Cubes;
									K.execute(tmpFable.RetoldFacetingEngineLive, pContext, pPlan.Aggs,
										(pError, pExecution) =>
										{
											Expect(pError).to.equal(null);
											Expect(pExecution.Errors).to.deep.equal({});
											return fCallback(pPlan, pExecution);
										});
								});
						});
				};

				test('E1: three named scopes, a join clause, the cube (one statement) — every facet equals direct SQL',
					(fDone) =>
					{
						let tmpClients = [ 1, 2, 3, 4, 5, 8, 101 ];
						let tmpBody = (
							{
								Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: [ 'Owner', 'Lead' ] } }, { Scope: 'Project.HasMyOverdue' }, { Scope: 'Project.Unblocked' } ],
								Clauses:
								[
									{ Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active', 'AtRisk' ], FilterKey: 'Status', Hash: 'Status-DSVL-1' },
									{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', JoinExternalConnectionColumn: 'IDClient', Values: tmpClients, FilterKey: 'IDClient', Hash: 'IDClient-IJ-1' },
									{ Type: 'DateRange', FilterByColumn: 'StartDate', Values: { Start: '2024-06-01', End: '2027-01-01' }, EndExclusive: true, FilterKey: 'StartDate', Hash: 'StartDate-DR-1' }
								],
								Facets:
								[
									{ Key: 'Status', Facet: 'Project.Status' }, { Key: 'Client', Facet: 'Project.IDClient', Top: 20 }, { Key: 'Started', Facet: 'Project.StartDate', Interval: 'month' },
									{ Key: 'MyOverdue', Facet: 'Project.MyOverdueBand' }, { Key: 'StatusByClient', Facet: [ 'Project.Status', 'Project.IDClient' ], Fold: 'Pivot' }
								]
							});
						fPipeline(P, 'Project', 'Lead', tmpBody, {},
							(pPlan, pExecution) =>
							{
								Expect(pPlan.Cubes.length).to.equal(1);
								Expect(pExecution.CubeFallbacks).to.deep.equal([]);
								Expect(pExecution.Statements).to.equal(1);
								let O = F.e1Oracle(P, 1, 1, tmpClients);
								Expect(pExecution.Results['#Total'].Total).to.equal(O.Total);
								expectGroups(pExecution.Results.Status, O.Status, 'Status');
								expectGroups(pExecution.Results.Client, O.Client, 'Client');
								expectGroups(pExecution.Results.Started, O.Started, 'Started');
								expectGroups(pExecution.Results.MyOverdue, O.MyOverdue, 'MyOverdue');
								// And per Variant, without the cube.
								fPipeline(P, 'Project', 'Lead', tmpBody, { Cube: 'Never' },
									(pNoCubePlan, pPerVariant) =>
									{
										Expect(pNoCubePlan.Cubes).to.deep.equal([]);
										Object.keys(pExecution.Results).forEach((pKey) => { Expect(F.normalizeRaw(pPerVariant.Results[pKey]), pKey).to.deep.equal(F.normalizeRaw(pExecution.Results[pKey])); });
										return fDone();
									});
							});
					});

				test('E3A: MyFormsToDo and its siblings (co-reference anti-join, TenantOnly) in one cube — equal direct SQL',
					(fDone) =>
					{
						let tmpBody = (
							{
								Facets:
								[
									{ Key: 'ToDo', Facet: 'MaterialIntakeRequirement.MyFormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue' },
									{ Key: 'Week', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByWeek' }, { Key: 'Discipline', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByDiscipline' },
									{ Key: 'Started', Facet: 'MaterialIntakeRequirement.MyFormsToDo/Started' }
								]
							});
						fPipeline(L, 'MaterialIntakeRequirement', 'Tech', tmpBody, {},
							(pPlan, pExecution) =>
							{
								Expect(pExecution.CubeFallbacks).to.deep.equal([]);
								let O = F.e3aOracle(L, 1, 1, true);
								[ 'ToDo', 'Queue', 'Week', 'Discipline', 'Started' ].forEach((pKey) => { expectGroups(pExecution.Results[pKey], O[pKey], pKey); });
								return fDone();
							});
					});

				test('O1 at the raw level: the same plans through the Reference engine give identical RawFacetResults (E1, E3A, E3B, coverage)',
					(fDone) =>
					{
						let tmpClients = [ 1, 2, 3, 4, 5, 8, 101 ];
						let tmpCases =
						[
							[ P, 'Project', 'Lead', { Scopes: [ { Scope: 'Project.MyProjects', Params: { Roles: [ 'Owner', 'Lead' ] } }, { Scope: 'Project.HasMyOverdue' }, { Scope: 'Project.Unblocked' } ],
								Clauses: [ { Type: 'DistinctSelectedValueList', FilterByColumn: 'Status', Values: [ 'Active', 'AtRisk' ], FilterKey: 'Status', Hash: 'Status-DSVL-1' },
									{ Type: 'InternalJoinSelectedValueList', RemoteTable: 'Client', JoinInternalConnectionColumn: 'IDClient', JoinExternalConnectionColumn: 'IDClient', Values: tmpClients, FilterKey: 'IDClient', Hash: 'IDClient-IJ-1' } ],
								Facets: [ { Key: 'Status', Facet: 'Project.Status' }, { Key: 'Client', Facet: 'Project.IDClient' }, { Key: 'MyOverdue', Facet: 'Project.MyOverdueBand' }, { Key: 'StatusByClient', Facet: [ 'Project.Status', 'Project.IDClient' ], Fold: 'Pivot' } ] } ],
							[ P, 'Project', 'Lead', { Facets: [ { Key: 'ByMember', Facet: 'Project.ByMember' }, { Key: 'HasOpenIssues', Facet: 'Project.HasOpenIssues' } ] } ],
							// K19 and the two-hop K10 are named scopes (request Scopes → Variant path predicates).
							[ P, 'Project', 'Lead', { Scopes: [ { Scope: 'Project.ManyOverdue' } ], Facets: [ { Key: 'Status', Facet: 'Project.Status' }, { Key: 'ByMember', Facet: 'Project.ByMember' } ] } ],
							[ P, 'Document', 'Lead', { Scopes: [ { Scope: 'Document.InMyProjects' } ], Facets: [ { Key: 'Status', Facet: 'Document.Status' }, { Key: 'ByClient', Facet: 'Document.ByClient' } ] } ],
							[ L, 'MaterialIntakeRequirement', 'Tech', { Facets: [ { Key: 'ToDo', Facet: 'MaterialIntakeRequirement.MyFormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue' }, { Key: 'Started', Facet: 'MaterialIntakeRequirement.MyFormsToDo/Started' } ] } ],
							[ L, 'MaterialIntake', 'Tech', { Facets: [ { Key: 'ToDo', Facet: 'MaterialIntake.FormsToDo' }, { Key: 'Week', Facet: 'MaterialIntake.FormsToDo/ByWeek' }, { Key: 'ByRequiredForm', Facet: 'MaterialIntake.ByRequiredForm' } ] } ],
							[ L, 'MaterialIntakeRequirement', 'OtherTech', { Facets: [ { Key: 'ToDo', Facet: 'MaterialIntakeRequirement.MyFormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntakeRequirement.MyFormsToDo/ByQueue' } ] } ]
						];
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpCases.length)
							{
								return fDone();
							}
							let tmpCase = tmpCases[pIndex];
							fPipeline(tmpCase[0], tmpCase[1], tmpCase[2], tmpCase[3], {},
								(pPlan, pLive) =>
								{
									tmpCase[0].context(tmpCase[1], tmpCase[2], { Variants: pPlan.Variants, ForceEngine: 'Reference' },
										(pContextError, pContext) =>
										{
											pContext.FilterAST = { Conjuncts: [] };
											tmpCase[0].execute(tmpCase[0].fable.RetoldFacetingEngineReference, pContext, pPlan.Aggs,
												(pReferenceError, pReference) =>
												{
													Expect(pReferenceError).to.equal(null);
													Expect(pReference.Errors).to.deep.equal(pLive.Errors);
													Object.keys(pLive.Results).forEach((pKey) => { Expect(F.normalizeRaw(pReference.Results[pKey]), `${tmpCase[1]} ${pKey}`).to.deep.equal(F.normalizeRaw(pLive.Results[pKey])); });
													return fNext(pIndex + 1);
												});
										});
								});
						};
						fNext(0);
					});

				test('E3B (TuplePivot) and K9 through the bridge alias — equal direct SQL',
					(fDone) =>
					{
						let tmpBody = { Facets: [ { Key: 'ToDo', Facet: 'MaterialIntake.FormsToDo' }, { Key: 'Queue', Facet: 'MaterialIntake.FormsToDo/ByQueue' }, { Key: 'Week', Facet: 'MaterialIntake.FormsToDo/ByWeek' }, { Key: 'ByRequiredForm', Facet: 'MaterialIntake.ByRequiredForm' } ] };
						fPipeline(L, 'MaterialIntake', 'Tech', tmpBody, {},
							(pPlan, pExecution) =>
							{
								let O = F.e3bOracle(L, 1, 1);
								expectGroups(pExecution.Results.ToDo, O.ToDo, 'Tuple ToDo');
								expectGroups(pExecution.Results.Queue, O.Queue, 'Tuple Queue');
								expectGroups(pExecution.Results.Week, O.Week, 'Tuple Week');
								let C = F.labCoverageOracle(L, 1, 1);
								let tmpRaw = pExecution.Results.ByRequiredForm;
								Expect(F.groupList(tmpRaw.Groups)).to.deep.equal(F.oracleList(C.ByRequiredForm));
								Expect(tmpRaw.Total).to.equal(C.Intakes);
								Expect(tmpRaw.MissingCount).to.equal(C.Intakes - C.ByRequiredFormCovered);
								return fDone();
							});
					});
			}
		);

		// ============================================================ PostgreSQL (gated)

		suite
		(
			'Live on PostgreSQL == Live on SQLite (RFS_TEST_POSTGRES=1, TZ=UTC)',
			() =>
			{
				let tmpBenches = {};
				let tmpSkip = null;
				suiteSetup(
					(fDone) =>
					{
						let tmpOrder = [ [ 'SQLite', 'ProjectTrack' ], [ 'SQLite', 'LabTrack' ], [ 'PostgreSQL', 'ProjectTrack' ], [ 'PostgreSQL', 'LabTrack' ] ];
						let fNext = (pIndex) =>
						{
							if ((pIndex >= tmpOrder.length) || tmpSkip)
							{
								return fDone();
							}
							let tmpKey = `${tmpOrder[pIndex][0]}|${tmpOrder[pIndex][1]}`;
							tmpBenches[tmpKey] = libKit.start({ Domain: tmpOrder[pIndex][1], Provider: tmpOrder[pIndex][0] },
								(pError) =>
								{
									if (pError && pError.Skip)
									{
										tmpSkip = pError.message;
										return fDone();
									}
									if (pError)
									{
										return fDone(pError);
									}
									return fNext(pIndex + 1);
								});
						};
						fNext(0);
					});
				suiteTeardown(
					(fDone) =>
					{
						let tmpKeys = Object.keys(tmpBenches);
						let fNext = (pIndex) =>
						{
							if (pIndex >= tmpKeys.length)
							{
								return fDone();
							}
							tmpBenches[tmpKeys[pIndex]].stop(() => { return fNext(pIndex + 1); });
						};
						fNext(0);
					});
				setup(function () { if (tmpSkip) { this.skip(); } });

				let tmpCases =
				[
					[ 'E1 per Variant', 'ProjectTrack', 'Project', 'Lead', () => { return { Variants: F.e1Plan(1, [ 1, 2, 3, 8, 101 ]).Variants, PlanForm: { Cube: 'Never' } }; }, () => { return F.e1Plan(1, [ 1, 2, 3, 8, 101 ]).Aggs; } ],
					[ 'E1 cube', 'ProjectTrack', 'Project', 'Lead', () => { let P = F.e1Plan(1, [ 1, 2, 3, 8, 101 ]); return { Variants: P.Variants, Cubes: [ P.Cube ] }; }, () => { return F.e1Plan(1, [ 1, 2, 3, 8, 101 ]).Aggs; } ],
					[ 'E2', 'ProjectTrack', 'Document', 'Lead', () => { return { Variants: F.projectCoverage(1, 3).E2Variants }; }, () => { return F.projectCoverage(1, 3).E2Aggs; } ],
					[ 'Project coverage', 'ProjectTrack', 'Project', 'Lead', () => { return emptyVariants('Project'); }, () => { let C = F.projectCoverage(1, 3); return [ C.ByMember, C.HasOpenIssues, C.ManyOverdue ]; } ],
					[ 'Document coverage', 'ProjectTrack', 'Document', 'Lead', () => { return emptyVariants('Document'); }, () => { let C = F.projectCoverage(1, 3); return [ C.ByClient, C.InMyProjects ]; } ],
					[ 'E3A fused', 'LabTrack', 'MaterialIntakeRequirement', 'Tech', () => { return emptyVariants('MaterialIntakeRequirement'); }, () => { return F.e3aAggs(1, 'TenantOnly'); } ],
					[ 'E3A staged', 'LabTrack', 'MaterialIntakeRequirement', 'Tech', () => { return Object.assign(emptyVariants('MaterialIntakeRequirement'), { PlanForm: { Staged: 'Always' } }); }, () => { return F.e3aAggs(1, 'TenantOnly'); } ],
					[ 'E3B', 'LabTrack', 'MaterialIntake', 'Tech', () => { return emptyVariants('MaterialIntake'); }, () => { return F.e3bAggs(1); } ],
					[ 'Lab coverage', 'LabTrack', 'MaterialIntake', 'Tech', () => { return emptyVariants('MaterialIntake'); }, () => { return Object.values(F.labCoverageAggs(1)); } ],
					[ 'E3A as tenant 2', 'LabTrack', 'MaterialIntakeRequirement', 'OtherTech', () => { return emptyVariants('MaterialIntakeRequirement'); }, () => { return F.e3aAggs(101, 'TenantOnly'); } ]
				];
				tmpCases.forEach(
					(pCase) =>
					{
						test(`${pCase[0]}: every RawFacetResult equal on both providers`,
							(fDone) =>
							{
								run(tmpBenches[`SQLite|${pCase[1]}`], pCase[2], pCase[3], pCase[4](), pCase[5](),
									(pSQLiteError, pSQLite) =>
									{
										Expect(pSQLiteError).to.equal(null);
										run(tmpBenches[`PostgreSQL|${pCase[1]}`], pCase[2], pCase[3], pCase[4](), pCase[5](),
											(pPostgreSQLError, pPostgreSQL) =>
											{
												Expect(pPostgreSQLError).to.equal(null);
												Expect(pPostgreSQL.Errors).to.deep.equal(pSQLite.Errors);
												Expect(pPostgreSQL.CubeFallbacks).to.deep.equal(pSQLite.CubeFallbacks);
												Object.keys(pSQLite.Results).forEach((pKey) => { Expect(F.normalizeRaw(pPostgreSQL.Results[pKey]), pKey).to.deep.equal(F.normalizeRaw(pSQLite.Results[pKey])); });
												return fDone();
											});
									});
							});
					});

				test('Records / Count / Keys equal on both providers (ordering, NULLs last, truncation)',
					(fDone) =>
					{
						let P = F.e1Plan(1, [ 1, 2, 3, 8, 101 ]);
						let fRun = (pProvider, fRunDone) =>
						{
							let tmpBench = tmpBenches[`${pProvider}|ProjectTrack`];
							tmpBench.context('Project', 'Lead', { Variants: P.Variants },
								(pContextError, pContext) =>
								{
									let tmpEngine = tmpBench.fable.RetoldFacetingEngineLive;
									let tmpBasePlan = { Pivot: 'Project', Variant: F.variant('v0', 'Project', [], null) };
									tmpEngine.recordKeys(pContext, tmpBasePlan, { Sort: [ { Field: 'StartDate', Dir: 'DESC' }, { Field: 'Status', Dir: 'ASC' } ], Begin: 5, Cap: 20 },
										(pError, pPage) =>
										{
											tmpEngine.keys(pContext, tmpBasePlan, { Cap: 10 },
												(pKeysError, pKeys) =>
												{
													return fRunDone({ Page: pPage.Keys, Keys: pKeys.Keys, Count: pKeys.Count, Truncated: pKeys.Truncated });
												});
										});
								});
						};
						fRun('SQLite', (pSQLite) => { fRun('PostgreSQL', (pPostgreSQL) => { Expect(pPostgreSQL).to.deep.equal(pSQLite); Expect(pSQLite.Truncated).to.equal(true); return fDone(); }); });
					});
			}
		);

		// ============================================================ PredicateCompiler units

		suite
		(
			'PredicateCompiler',
			() =>
			{
				let K = null;
				suiteSetup((fDone) => { K = libKit.start({ Domain: 'ProjectTrack' }, fDone); });
				suiteTeardown((fDone) => { K.stop(fDone); });

				test('fragments are unqualified FoxHound renderings with q<n>_ binds; existence nodes compose by alias only',
					() =>
					{
						let tmpCompiler = K.fable.RetoldFacetingPredicateCompiler;
						let tmpContext = { Host: K.fable.RetoldFacetingHostDataService };
						let tmpFragment = tmpCompiler.fragment(tmpContext, 'Project', { Or: [ { Field: 'Status', Op: 'IN', Value: [ 'Active', 'AtRisk' ] }, { Field: 'IDClient', Op: 'NULL' } ] }, 'q4', 'SQLite');
						Expect(tmpFragment.SQL).to.equal('( `Status` IN ( :q4_Status_w1_0, :q4_Status_w1_1 ) OR `IDClient` IS :q4_IDClient_w2 )');
						Expect(tmpFragment.Params).to.deep.equal({ q4_Status_w1_0: 'Active', q4_Status_w1_1: 'AtRisk', q4_IDClient_w2: null });
						let tmpPG = tmpCompiler.fragment(tmpContext, 'Project', { Field: 'IDClient', Op: 'NULL' }, 'q1', 'PostgreSQL');
						Expect(tmpPG.SQL).to.match(/IS NULL/);
						Expect(() => { tmpCompiler.fragment(tmpContext, 'Project', { Field: 'Status', Op: 'EQ', Value: 'x' }, 'p1', 'SQLite'); }).to.throw().with.property('Code', 'FACET_INTERNAL');

						let tmpRelations =
						{
							p: { Entity: 'Project', SQL: 'SELECT "IDProject" FROM Project', Params: {}, ParamTypes: {} },
							h1: { Entity: 'Task', SQL: 'SELECT "IDProject" FROM Task WHERE `Status` = :h1_Status_w0', Params: { h1_Status_w0: 'Open' }, ParamTypes: {} }
						};
						let tmpPred = F.and(
							F.or(F.exists({ As: 'h1' }, [ F.on('p', 'IDProject', 'IDProject') ], F.cmp('h1', 'Status', 'NE', 'Done')), F.cmp('p', 'OwnerIDUser', 'EQ', 7)),
							F.countCmp({ As: 'h1' }, [ F.on('p', 'IDProject', 'IDProject') ], null, 'GE', 3));
						let tmpCompiled = tmpCompiler.compile(tmpContext, tmpPred, tmpRelations, 'SQLite', { Scope: [ 'p' ] });
						Expect(tmpCompiled.SQL).to.equal('((EXISTS (SELECT 1 FROM (SELECT "IDProject" FROM Task WHERE `Status` = :h1_Status_w0) "h1" WHERE "h1"."IDProject" = "p"."IDProject" AND (`Status` != :q1_Status_w0)) OR (`OwnerIDUser` = :q2_OwnerIDUser_w0))'
							+ ' AND (SELECT count(*) FROM (SELECT "IDProject" FROM Task WHERE `Status` = :h1_Status_w0) "h1" WHERE "h1"."IDProject" = "p"."IDProject") >= :q3_N)');
						Expect(tmpCompiled.Params).to.deep.equal({ h1_Status_w0: 'Open', q1_Status_w0: 'Done', q2_OwnerIDUser_w0: 7, q3_N: 3 });
						// Outside the sole scope a column subtree needs a flag of its wrapper alias.
						Expect(() => { tmpCompiler.compile(tmpContext, F.cmp('p', 'OwnerIDUser', 'EQ', 7), tmpRelations, 'SQLite', { Scope: [ 'p', 'u1' ] }); }).to.throw().with.property('Code', 'FACET_INTERNAL');
						let tmpFlagged = tmpCompiler.compile(tmpContext, F.cmp('p', 'OwnerIDUser', 'EQ', 7), tmpRelations, 'SQLite', { Scope: [ 'p', 'u1' ], Flag: () => { return 'q9'; } });
						Expect(tmpFlagged.SQL).to.equal('"p"."q9" = 1');
						// A relation that was never built, and malformed nodes, are internal errors.
						Expect(() => { tmpCompiler.compile(tmpContext, F.exists({ As: 'h7' }, [ F.on('p', 'IDProject', 'IDProject') ]), tmpRelations, 'SQLite', {}); }).to.throw().with.property('Code', 'FACET_INTERNAL');
						Expect(() => { tmpCompiler.compile(tmpContext, { Node: 'Not' }, tmpRelations, 'SQLite', {}); }).to.throw().with.property('Code', 'FACET_INTERNAL');
						Expect(() => { tmpCompiler.compile(tmpContext, F.countCmp({ As: 'h1' }, [ F.on('p', 'IDProject', 'IDProject') ], null, 'XX', 3), tmpRelations, 'SQLite', {}); }).to.throw().with.property('Code', 'FACET_INTERNAL');
						Expect(tmpCompiler.compile(tmpContext, null, tmpRelations, 'SQLite', {})).to.deep.equal({ SQL: '', Params: {}, ParamTypes: {} });
						Expect(tmpCompiler.compile(tmpContext, { Node: 'True' }, tmpRelations, 'SQLite', {}).SQL).to.equal('1 = 1');
						// MSSQL types the CountCmp bind.
						let tmpMSSQL = tmpCompiler.compile(tmpContext, F.countCmp({ As: 'h1' }, [ F.on('p', 'IDProject', 'IDProject') ], null, 'LT', 2),
							{ h1: { Entity: 'Task', SQL: 'SELECT [IDProject] FROM Task', Params: {}, ParamTypes: {} } }, 'MSSQL', {});
						Expect(tmpMSSQL.SQL).to.equal('(SELECT count(*) FROM (SELECT [IDProject] FROM Task) [h1] WHERE [h1].[IDProject] = [p].[IDProject]) < @q1_N');
						Expect(tmpMSSQL.ParamTypes).to.deep.equal({ q1_N: 'Int' });
						Expect(libRetoldFacetingPredicateCompiler.columnAlias(F.and(F.cmp('p', 'A', 'EQ', 1), F.cmp('p', 'B', 'EQ', 2)))).to.equal('p');
						Expect(libRetoldFacetingPredicateCompiler.columnAlias(F.and(F.cmp('p', 'A', 'EQ', 1), F.cmp('h1', 'B', 'EQ', 2)))).to.equal(null);
						Expect(libRetoldFacetingDialects.DIALECT_PROFILES.SQLite.Sigil).to.equal(':');
					});

				test('relations are memoized without the alias: the same hop under two aliases is one relation and one behavior run, harvested per alias',
					(fDone) =>
					{
						K.context('Project', 'Lead', {},
							(pContextError, pContext) =>
							{
								let tmpBuilder = K.fable.RetoldFacetingScopedRelationBuilder;
								let tmpRel = F.rel('Task', 'h1', [ 'IDTask', 'IDProject' ], { Where: { Field: 'Status', Op: 'NE', Value: 'Done' } });
								tmpBuilder.buildRelation(pContext, tmpRel,
									(pError, pFirst) =>
									{
										Expect(pError).to.equal(null);
										Expect(pContext.Counters).to.include({ Relations: 1, BehaviorRuns: 1 });
										Expect(pFirst.SQL).to.contain('FacetWhere'.length ? ':h1_w1_Status_w1' : '');
										tmpBuilder.buildRelation(pContext, Object.assign({}, tmpRel, { As: 'j7' }),
											(pSecondError, pSecond) =>
											{
												Expect(pSecondError).to.equal(null);
												Expect(pContext.Counters).to.include({ Relations: 1, BehaviorRuns: 1 });
												Expect(pSecond.SQL).to.equal(pFirst.SQL.replace(/:h1_/g, ':j7_'));
												Expect(Object.keys(pSecond.Params).every((pName) => { return /^j7_/.test(pName); })).to.equal(true);
												Expect(pSecond.Capture).to.equal(pFirst.Capture);
												// TenantOnly needs its reason; a path predicate never reaches a relation.
												tmpBuilder.buildRelation(pContext, Object.assign({}, tmpRel, { As: 'j8', Scope: 'TenantOnly', ScopeReason: null }),
													(pReasonError) =>
													{
														Expect(pReasonError.Code).to.equal('FACET_INTERNAL');
														tmpBuilder.buildRelation(pContext, Object.assign({}, tmpRel, { As: 'j9', Where: { Exists: {} } }),
															(pShapeError) =>
															{
																Expect(pShapeError.Code).to.equal('FACET_INTERNAL');
																return fDone();
															});
													});
											});
									});
							});
					});
			}
		);
	}
);
