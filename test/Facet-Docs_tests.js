/**
 * Facet-Docs: the documentation check.  Every complete definitions file and every complete request
 * body shown in docs/ carries a marker comment on the line directly above its ```json fence, and
 * this suite proves each one against a real harness (the same retold-data-service + faceting boot
 * the other suites use):
 *
 *   <!-- docs-check: definitions Id=<id> Fixture=<Bookstore|Bookstore-Tenant|ProjectTrack|LabTrack> -->
 *       The block is a whole definitions file (FormatVersion 1).  It loads on the fixture's model
 *       (on top of the fixture's own definitions for ProjectTrack / LabTrack, minus any entry the
 *       block redefines) with ZERO disabled entries, and every alias, scope, facet and sibling it
 *       declares is served by the registry.
 *
 *   <!-- docs-check: request Fixture=<…> Entity=<Entity> [Route=Query|Records|Records/Count|Records/<b>/<c>|Keys]
 *                    [Scope=<Entity.Name>] [Definitions=<id>] [User=<n>] [Tenant=<n>] [Expect=<FACET_CODE>] -->
 *       The block is a whole request body.  It is POSTed to <RoutePrefix>/<Entity>[/Scope/<Scope>]/<Route>
 *       (Route defaults to Query) as the given test principal; Definitions=<id> loads that docs
 *       definitions block first.  Without Expect the answer is 200 with no per-facet Errors; with
 *       Expect it is that code, as a whole-request error or as a per-facet entry of Errors.
 *
 *   <!-- docs-check: skip <reason> -->
 *       A deliberate fragment; not checked.
 *
 * A further check fails on an UNMARKED json block that parses and looks like a whole definitions
 * file (a top-level FormatVersion) or a whole request body, so new examples cannot slip past.
 * docs/internal-contracts.md is the contributors' contract and is not scanned.
 *
 *   npx mocha --no-package --ui tdd --timeout 20000 test/Facet-Docs_tests.js
 *
 * Registry port: 19160 (the harnesses bind ephemeral ports; 19160 names the runs).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libFS = require('fs');
const libPath = require('path');

const libHarness = require('./support/Facet-Test-Harness.js');

const PORT = 19160;

const DOCS_ROOT = libPath.resolve(__dirname, '..', 'docs');

// Not user documentation (the builders' contract): never scanned.
const EXCLUDED_FILES = [ 'internal-contracts.md' ];

const FIXTURES = [ 'Bookstore', 'Bookstore-Tenant', 'ProjectTrack', 'LabTrack' ];

// The fixtures that ship their own definitions file (the seed module's FACETING_OPTIONS.Definitions).
const FIXTURE_SEEDS = (
	{
		ProjectTrack: require('./fixtures/ProjectTrack-Seed.js'),
		LabTrack: require('./fixtures/LabTrack-Seed.js')
	});

const ROUTE_PATTERN = /^(Query|Records|Records\/Count|Records\/[0-9]{1,9}\/[0-9]{1,9}|Keys)$/;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const QUALIFIED_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}\.[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const CODE_PATTERN = /^FACET_[A-Z_]+$/;

const MARKER_PATTERN = /^\s*<!--\s*docs-check:\s*(\S+)(.*?)-->\s*$/;
const MARKER_START_PATTERN = /<!--\s*docs-check:/;

// The attributes each marker kind takes (required first).
const MARKER_ATTRIBUTES = (
	{
		definitions: { Required: [ 'Id', 'Fixture' ], Optional: [] },
		request: { Required: [ 'Fixture', 'Entity' ], Optional: [ 'Route', 'Scope', 'Definitions', 'User', 'Tenant', 'Expect' ] }
	});

// Top-level keys a request body may carry (anything else means "not a request body").
const REQUEST_KEYS = [ 'Clauses', 'FilterString', 'Scopes', 'Params', 'Facets', 'Total', 'Records', 'Cap', 'Freshness', 'Engine', 'TimeoutMS', 'Experience' ];
// Keys that make a body a request (one of them must be present).
const REQUEST_SIGNAL_KEYS = [ 'Clauses', 'FilterString', 'Scopes', 'Facets' ];

/**
 * Every .md file under the docs root (sorted, recursive), minus the excluded ones.
 *
 * @param {string} pDirectory
 * @return {Array<string>} absolute paths
 */
const markdownFiles = (pDirectory) =>
{
	let tmpFiles = [];
	if (!libFS.existsSync(pDirectory))
	{
		return tmpFiles;
	}
	libFS.readdirSync(pDirectory).sort().forEach(
		(pName) =>
		{
			let tmpPath = libPath.join(pDirectory, pName);
			let tmpStat = libFS.statSync(tmpPath);
			if (tmpStat.isDirectory())
			{
				tmpFiles = tmpFiles.concat(markdownFiles(tmpPath));
			}
			else if (/\.md$/i.test(pName) && (EXCLUDED_FILES.indexOf(pName) < 0))
			{
				tmpFiles.push(tmpPath);
			}
		});
	return tmpFiles;
};

/**
 * Parse the attribute text of a marker ('Id=E1 Fixture=ProjectTrack') into an object.
 *
 * @param {string} pText
 * @return {{ Attributes: Record<string, string>, Problems: Array<string> }}
 */
const parseAttributes = (pText) =>
{
	let tmpAttributes = {};
	let tmpProblems = [];
	pText.trim().split(/\s+/).filter((pToken) => { return pToken.length > 0; }).forEach(
		(pToken) =>
		{
			let tmpMatch = /^([A-Za-z]+)=(\S+)$/.exec(pToken);
			if (!tmpMatch)
			{
				tmpProblems.push(`attribute "${pToken}" is not Key=Value`);
				return;
			}
			if (Object.prototype.hasOwnProperty.call(tmpAttributes, tmpMatch[1]))
			{
				tmpProblems.push(`attribute ${tmpMatch[1]} is given twice`);
				return;
			}
			tmpAttributes[tmpMatch[1]] = tmpMatch[2];
		});
	return { Attributes: tmpAttributes, Problems: tmpProblems };
};

/**
 * Check one marker's attributes; returns the problems found (empty when well formed).
 *
 * @param {string} pKind - 'definitions' | 'request'
 * @param {Record<string, string>} pAttributes
 * @return {Array<string>}
 */
const markerProblems = (pKind, pAttributes) =>
{
	let tmpProblems = [];
	let tmpSpec = MARKER_ATTRIBUTES[pKind];
	tmpSpec.Required.forEach((pName) => { if (typeof(pAttributes[pName]) !== 'string') { tmpProblems.push(`${pKind} marker needs ${pName}=`); } });
	Object.keys(pAttributes).forEach(
		(pName) =>
		{
			if ((tmpSpec.Required.indexOf(pName) < 0) && (tmpSpec.Optional.indexOf(pName) < 0))
			{
				tmpProblems.push(`${pKind} marker does not take ${pName}=`);
			}
		});
	if ((typeof(pAttributes.Fixture) === 'string') && (FIXTURES.indexOf(pAttributes.Fixture) < 0))
	{
		tmpProblems.push(`Fixture must be one of ${FIXTURES.join(' | ')}`);
	}
	if ((typeof(pAttributes.Id) === 'string') && !ID_PATTERN.test(pAttributes.Id))
	{
		tmpProblems.push('Id must be 1 to 64 letters, digits, "_", "-" or "."');
	}
	if ((typeof(pAttributes.Definitions) === 'string') && !ID_PATTERN.test(pAttributes.Definitions))
	{
		tmpProblems.push('Definitions must name a definitions block Id');
	}
	if ((typeof(pAttributes.Entity) === 'string') && !IDENTIFIER_PATTERN.test(pAttributes.Entity))
	{
		tmpProblems.push('Entity must be an identifier');
	}
	if ((typeof(pAttributes.Route) === 'string') && !ROUTE_PATTERN.test(pAttributes.Route))
	{
		tmpProblems.push('Route must be Query, Records, Records/Count, Records/<Begin>/<Cap> or Keys');
	}
	if ((typeof(pAttributes.Scope) === 'string') && !QUALIFIED_PATTERN.test(pAttributes.Scope))
	{
		tmpProblems.push('Scope must be <Entity>.<Name>');
	}
	[ 'User', 'Tenant' ].forEach(
		(pName) =>
		{
			if ((typeof(pAttributes[pName]) === 'string') && !/^[1-9][0-9]{0,8}$/.test(pAttributes[pName]))
			{
				tmpProblems.push(`${pName} must be a positive integer`);
			}
		});
	if ((typeof(pAttributes.Expect) === 'string') && !CODE_PATTERN.test(pAttributes.Expect))
	{
		tmpProblems.push('Expect must be a FACET_ error code');
	}
	return tmpProblems;
};

/**
 * Scan the docs: every ```json block (marked or not), every marker, and the problems found.
 *
 * @return {{ Blocks: Array<Record<string, any>>, Problems: Array<string> }}
 */
const scanDocs = () =>
{
	let tmpBlocks = [];
	let tmpProblems = [];
	markdownFiles(DOCS_ROOT).forEach(
		(pFile) =>
		{
			let tmpRelative = libPath.relative(libPath.resolve(DOCS_ROOT, '..'), pFile);
			let tmpLines = libFS.readFileSync(pFile, 'utf8').split(/\r?\n/);
			let tmpInFence = false;
			let tmpFenceStart = -1;
			for (let i = 0; i < tmpLines.length; i++)
			{
				let tmpLine = tmpLines[i];
				let tmpFence = /^\s*```(\S*)\s*$/.exec(tmpLine);
				if (tmpInFence)
				{
					if (tmpFence && (tmpFence[1] === ''))
					{
						tmpInFence = false;
					}
					continue;
				}
				if (tmpFence)
				{
					tmpInFence = true;
					tmpFenceStart = i;
					if (tmpFence[1] !== 'json')
					{
						continue;
					}
					// A ```json block: collect it and its marker (the line directly above).
					let tmpEnd = i + 1;
					while ((tmpEnd < tmpLines.length) && !/^\s*```\s*$/.test(tmpLines[tmpEnd]))
					{
						tmpEnd++;
					}
					let tmpBlock = (
						{
							File: tmpRelative,
							Line: i + 1,
							Text: tmpLines.slice(i + 1, tmpEnd).join('\n'),
							Kind: null,
							Attributes: {},
							Reason: null,
							Body: undefined,
							ParseError: null
						});
					let tmpMarker = (i > 0) ? MARKER_PATTERN.exec(tmpLines[i - 1]) : null;
					if (tmpMarker)
					{
						tmpBlock.Kind = tmpMarker[1];
						if (tmpBlock.Kind === 'skip')
						{
							tmpBlock.Reason = tmpMarker[2].trim();
							if (tmpBlock.Reason.length < 1)
							{
								tmpProblems.push(`${tmpRelative}:${i} skip marker needs a reason`);
							}
						}
						else if (Object.prototype.hasOwnProperty.call(MARKER_ATTRIBUTES, tmpBlock.Kind))
						{
							let tmpParsed = parseAttributes(tmpMarker[2]);
							tmpBlock.Attributes = tmpParsed.Attributes;
							tmpParsed.Problems.concat(markerProblems(tmpBlock.Kind, tmpParsed.Attributes)).forEach(
								(pProblem) => { tmpProblems.push(`${tmpRelative}:${i} ${pProblem}`); });
						}
						else
						{
							tmpProblems.push(`${tmpRelative}:${i} unknown docs-check kind "${tmpBlock.Kind}" (definitions | request | skip)`);
						}
					}
					try
					{
						tmpBlock.Body = JSON.parse(tmpBlock.Text);
					}
					catch (pParseError)
					{
						tmpBlock.ParseError = pParseError.message;
						if ((tmpBlock.Kind === 'definitions') || (tmpBlock.Kind === 'request'))
						{
							tmpProblems.push(`${tmpRelative}:${i + 1} the marked ${tmpBlock.Kind} block is not valid JSON (${pParseError.message})`);
						}
					}
					tmpBlocks.push(tmpBlock);
					continue;
				}
				if (MARKER_START_PATTERN.test(tmpLine))
				{
					// A marker must sit directly above a ```json fence.
					let tmpNext = (i + 1 < tmpLines.length) ? tmpLines[i + 1] : '';
					if (!/^\s*```json\s*$/.test(tmpNext))
					{
						tmpProblems.push(`${tmpRelative}:${i + 1} a docs-check marker must be on the line directly above a \`\`\`json fence`);
					}
					else if (!MARKER_PATTERN.test(tmpLine))
					{
						tmpProblems.push(`${tmpRelative}:${i + 1} a docs-check marker must be one whole line: <!-- docs-check: <kind> … -->`);
					}
				}
			}
			if (tmpInFence)
			{
				tmpProblems.push(`${tmpRelative}:${tmpFenceStart + 1} a code fence is never closed`);
			}
		});

	// Ids are unique; Definitions= names an existing definitions block of the same fixture.
	let tmpIds = {};
	tmpBlocks.filter((pBlock) => { return pBlock.Kind === 'definitions'; }).forEach(
		(pBlock) =>
		{
			let tmpId = pBlock.Attributes.Id;
			if (typeof(tmpId) !== 'string')
			{
				return;
			}
			if (Object.prototype.hasOwnProperty.call(tmpIds, tmpId))
			{
				tmpProblems.push(`${pBlock.File}:${pBlock.Line} definitions Id=${tmpId} is already used at ${tmpIds[tmpId].File}:${tmpIds[tmpId].Line}`);
				return;
			}
			tmpIds[tmpId] = pBlock;
		});
	tmpBlocks.filter((pBlock) => { return (pBlock.Kind === 'request') && (typeof(pBlock.Attributes.Definitions) === 'string'); }).forEach(
		(pBlock) =>
		{
			let tmpDefinitions = tmpIds[pBlock.Attributes.Definitions];
			if (!tmpDefinitions)
			{
				tmpProblems.push(`${pBlock.File}:${pBlock.Line} Definitions=${pBlock.Attributes.Definitions} names no definitions block`);
			}
			else if (tmpDefinitions.Attributes.Fixture !== pBlock.Attributes.Fixture)
			{
				tmpProblems.push(`${pBlock.File}:${pBlock.Line} Definitions=${pBlock.Attributes.Definitions} is a ${tmpDefinitions.Attributes.Fixture} block, the request is on ${pBlock.Attributes.Fixture}`);
			}
		});
	return { Blocks: tmpBlocks, Problems: tmpProblems, DefinitionsById: tmpIds };
};

/**
 * Does an unmarked, parsed block look like a whole definitions file or a whole request body?
 *
 * @param {any} pBody
 * @return {string|null} 'definitions' | 'request' | null
 */
const looksCheckable = (pBody) =>
{
	if ((typeof(pBody) !== 'object') || (pBody === null) || Array.isArray(pBody))
	{
		return null;
	}
	if (Object.prototype.hasOwnProperty.call(pBody, 'FormatVersion'))
	{
		return 'definitions';
	}
	let tmpKeys = Object.keys(pBody);
	if ((tmpKeys.length > 0)
		&& tmpKeys.every((pKey) => { return REQUEST_KEYS.indexOf(pKey) >= 0; })
		&& tmpKeys.some((pKey) => { return REQUEST_SIGNAL_KEYS.indexOf(pKey) >= 0; })
		&& (!Object.prototype.hasOwnProperty.call(pBody, 'Facets') || Array.isArray(pBody.Facets)))
	{
		return 'request';
	}
	return null;
};

/**
 * The names a definitions object declares.
 *
 * @param {Record<string, any>} pDefinitions
 * @return {{ Aliases: Array<string>, Scopes: Array<string>, Facets: Array<string>, Siblings: Array<string> }}
 */
const declaredNames = (pDefinitions) =>
{
	let tmpNames = { Aliases: [], Scopes: [], Facets: [], Siblings: [] };
	let tmpObject = ((typeof(pDefinitions) === 'object') && (pDefinitions !== null)) ? pDefinitions : {};
	if ((typeof(tmpObject.Aliases) === 'object') && (tmpObject.Aliases !== null))
	{
		tmpNames.Aliases = Object.keys(tmpObject.Aliases);
	}
	if ((typeof(tmpObject.Scopes) === 'object') && (tmpObject.Scopes !== null))
	{
		tmpNames.Scopes = Object.keys(tmpObject.Scopes);
	}
	if (Array.isArray(tmpObject.Facets))
	{
		tmpObject.Facets.forEach(
			(pFacet) =>
			{
				if (pFacet && (typeof(pFacet.Facet) === 'string'))
				{
					tmpNames.Facets.push(pFacet.Facet);
					if ((typeof(pFacet.Siblings) === 'object') && (pFacet.Siblings !== null))
					{
						Object.keys(pFacet.Siblings).forEach((pSibling) => { tmpNames.Siblings.push(`${pFacet.Facet}/${pSibling}`); });
					}
				}
			});
	}
	return tmpNames;
};

/**
 * The definitions objects a harness for (pFixture, pBlockDefinitions) loads: the fixture's own
 * definitions file without the entries the docs block redefines, then the docs block.  'Auto'
 * (the fixture's own) when there is no docs block.
 *
 * @param {string} pFixture
 * @param {Record<string, any>|null} pBlockDefinitions
 * @return {'Auto'|Array<Record<string, any>>}
 */
const harnessDefinitions = (pFixture, pBlockDefinitions) =>
{
	if (!pBlockDefinitions)
	{
		return 'Auto';
	}
	let tmpObjects = [];
	let tmpSeed = FIXTURE_SEEDS[pFixture];
	let tmpFiles = (tmpSeed && tmpSeed.FACETING_OPTIONS && tmpSeed.FACETING_OPTIONS.Definitions && Array.isArray(tmpSeed.FACETING_OPTIONS.Definitions.Files))
		? tmpSeed.FACETING_OPTIONS.Definitions.Files : [];
	let tmpRedefined = declaredNames(pBlockDefinitions);
	tmpFiles.forEach(
		(pFile) =>
		{
			let tmpFixtureDefinitions = JSON.parse(libFS.readFileSync(pFile, 'utf8'));
			if ((typeof(tmpFixtureDefinitions.Aliases) === 'object') && (tmpFixtureDefinitions.Aliases !== null))
			{
				tmpRedefined.Aliases.forEach((pName) => { delete tmpFixtureDefinitions.Aliases[pName]; });
			}
			if ((typeof(tmpFixtureDefinitions.Scopes) === 'object') && (tmpFixtureDefinitions.Scopes !== null))
			{
				tmpRedefined.Scopes.forEach((pName) => { delete tmpFixtureDefinitions.Scopes[pName]; });
			}
			if (Array.isArray(tmpFixtureDefinitions.Facets))
			{
				tmpFixtureDefinitions.Facets = tmpFixtureDefinitions.Facets.filter((pFacet) => { return !pFacet || (tmpRedefined.Facets.indexOf(pFacet.Facet) < 0); });
			}
			tmpObjects.push(tmpFixtureDefinitions);
		});
	tmpObjects.push(pBlockDefinitions);
	return tmpObjects;
};

/**
 * One line per disabled entry (for assertion messages).
 *
 * @param {Array<Record<string, any>>} pDisabled
 * @return {string}
 */
const describeDisabled = (pDisabled) =>
{
	return pDisabled.map(
		(pEntry) =>
		{
			let tmpError = (Array.isArray(pEntry.Errors) && pEntry.Errors[0]) ? pEntry.Errors[0] : {};
			return `${pEntry.Kind} ${pEntry.Name}: ${tmpError.Reason} at ${tmpError.Pointer}${tmpError.Field ? ` (${tmpError.Entity}.${tmpError.Field})` : ''}${tmpError.DependsOn ? ` depends on ${tmpError.DependsOn}` : ''}`;
		}).join('; ');
};

const SCAN = scanDocs();

suite
(
	'Facet-Docs',
	() =>
	{
		// Fixture|DefinitionsId → { Harness, Error, Waiting: [ callbacks ] } (started on first use, stopped at the end).
		let _Harnesses = {};

		/**
		 * The harness for a fixture and an optional docs definitions block (shared by every block that asks).
		 *
		 * @param {string} pFixture
		 * @param {string|null} pDefinitionsId
		 * @param {(pError?: Error, pHarness?: Record<string, any>) => void} fCallback
		 */
		let fHarness = (pFixture, pDefinitionsId, fCallback) =>
		{
			let tmpKey = `${pFixture}|${pDefinitionsId || ''}`;
			let tmpEntry = _Harnesses[tmpKey];
			if (tmpEntry)
			{
				if (tmpEntry.Ready)
				{
					return fCallback(tmpEntry.Error, tmpEntry.Harness);
				}
				tmpEntry.Waiting.push(fCallback);
				return;
			}
			let tmpBlock = pDefinitionsId ? SCAN.DefinitionsById[pDefinitionsId] : null;
			tmpEntry = { Ready: false, Error: null, Harness: null, Waiting: [ fCallback ] };
			_Harnesses[tmpKey] = tmpEntry;
			tmpEntry.Harness = libHarness.start(
				{
					Port: PORT,
					Fixture: pFixture,
					Definitions: harnessDefinitions(pFixture, tmpBlock ? tmpBlock.Body : null)
				},
				(pError) =>
				{
					tmpEntry.Ready = true;
					tmpEntry.Error = pError || null;
					let tmpWaiting = tmpEntry.Waiting;
					tmpEntry.Waiting = [];
					tmpWaiting.forEach((fWaiting) => { fWaiting(tmpEntry.Error, tmpEntry.Harness); });
				});
		};

		suiteTeardown
		(
			(fDone) =>
			{
				let tmpEntries = Object.keys(_Harnesses).map((pKey) => { return _Harnesses[pKey]; });
				let fNext = () =>
				{
					let tmpEntry = tmpEntries.shift();
					if (!tmpEntry)
					{
						return fDone();
					}
					if (!tmpEntry.Harness || (typeof(tmpEntry.Harness.stop) !== 'function'))
					{
						return fNext();
					}
					tmpEntry.Harness.stop(() => { return fNext(); });
				};
				fNext();
			}
		);

		test
		(
			'every docs-check marker is well formed and every marked block parses',
			() =>
			{
				Expect(SCAN.Problems, SCAN.Problems.join('\n')).to.deep.equal([]);
			}
		);

		test
		(
			'every complete definitions file and request body in the docs carries a docs-check marker',
			() =>
			{
				let tmpUnmarked = SCAN.Blocks.filter((pBlock) => { return (pBlock.Kind === null) && (pBlock.ParseError === null) && (looksCheckable(pBlock.Body) !== null); })
					.map((pBlock) => { return `${pBlock.File}:${pBlock.Line} looks like a whole ${looksCheckable(pBlock.Body)} block: add a docs-check marker (or "docs-check: skip <reason>")`; });
				Expect(tmpUnmarked, tmpUnmarked.join('\n')).to.deep.equal([]);
			}
		);

		suite
		(
			'Definitions blocks load with zero disabled entries',
			() =>
			{
				SCAN.Blocks.filter((pBlock) => { return (pBlock.Kind === 'definitions') && (pBlock.ParseError === null); }).forEach(
					(pBlock) =>
					{
						test
						(
							`${pBlock.File}:${pBlock.Line} Id=${pBlock.Attributes.Id} on ${pBlock.Attributes.Fixture}`,
							(fDone) =>
							{
								Expect(pBlock.Body.FormatVersion, 'a definitions block is a whole file (FormatVersion 1)').to.equal(1);
								fHarness(pBlock.Attributes.Fixture, pBlock.Attributes.Id,
									(pError, pHarness) =>
									{
										if (pError)
										{
											return fDone(pError);
										}
										try
										{
											let tmpRegistry = pHarness.fable.RetoldFacetingDefinitionRegistry;
											let tmpDisabled = tmpRegistry.disabled();
											Expect(tmpDisabled.length, `disabled: ${describeDisabled(tmpDisabled)}`).to.equal(0);
											let tmpNames = declaredNames(pBlock.Body);
											tmpNames.Aliases.forEach((pName) => { Expect(tmpRegistry.alias(pName), `alias ${pName} is served`).to.not.equal(null); });
											tmpNames.Scopes.forEach((pName) => { Expect(tmpRegistry.scope(pName), `scope ${pName} is served`).to.not.equal(null); });
											tmpNames.Facets.concat(tmpNames.Siblings).forEach((pName) => { Expect(tmpRegistry.facet(pName), `facet ${pName} is served`).to.not.equal(null); });
										}
										catch (pAssertion)
										{
											return fDone(pAssertion);
										}
										return fDone();
									});
							}
						);
					});
			}
		);

		suite
		(
			'Request blocks are accepted',
			() =>
			{
				SCAN.Blocks.filter((pBlock) => { return (pBlock.Kind === 'request') && (pBlock.ParseError === null); }).forEach(
					(pBlock) =>
					{
						let tmpAttributes = pBlock.Attributes;
						let tmpRoute = tmpAttributes.Route || 'Query';
						let tmpPath = `/1.0/Facet/${tmpAttributes.Entity}${tmpAttributes.Scope ? `/Scope/${tmpAttributes.Scope}` : ''}/${tmpRoute}`;
						test
						(
							`${pBlock.File}:${pBlock.Line} POST ${tmpPath} on ${tmpAttributes.Fixture}${tmpAttributes.Expect ? ` → ${tmpAttributes.Expect}` : ''}`,
							(fDone) =>
							{
								let tmpDefinitionsId = (typeof(tmpAttributes.Definitions) === 'string') ? tmpAttributes.Definitions : null;
								if (tmpDefinitionsId && !SCAN.DefinitionsById[tmpDefinitionsId])
								{
									return fDone(new Error(`Definitions=${tmpDefinitionsId} names no definitions block`));
								}
								fHarness(tmpAttributes.Fixture, tmpDefinitionsId,
									(pError, pHarness) =>
									{
										if (pError)
										{
											return fDone(pError);
										}
										let tmpOptions = {};
										if (tmpAttributes.Tenant)
										{
											tmpOptions.Tenant = parseInt(tmpAttributes.Tenant, 10);
										}
										if (tmpAttributes.User)
										{
											tmpOptions.User = parseInt(tmpAttributes.User, 10);
										}
										pHarness.request('POST', tmpPath, pBlock.Body, tmpOptions,
											(pRequestError, pResponse) =>
											{
												if (pRequestError)
												{
													return fDone(pRequestError);
												}
												try
												{
													let tmpBody = pResponse.Body;
													let tmpSummary = `${pResponse.Status} ${JSON.stringify(tmpBody).substring(0, 600)}`;
													if (tmpAttributes.Expect)
													{
														let tmpCodes = [];
														if (tmpBody && tmpBody.Error && (typeof(tmpBody.Error.Code) === 'string'))
														{
															tmpCodes.push(tmpBody.Error.Code);
														}
														if (tmpBody && (typeof(tmpBody.Errors) === 'object') && (tmpBody.Errors !== null))
														{
															Object.keys(tmpBody.Errors).forEach((pKey) => { tmpCodes.push(tmpBody.Errors[pKey].Code); });
														}
														Expect(tmpCodes, `expected ${tmpAttributes.Expect}: ${tmpSummary}`).to.include(tmpAttributes.Expect);
														return fDone();
													}
													Expect(pResponse.Status, tmpSummary).to.equal(200);
													if (tmpRoute === 'Query')
													{
														Expect(tmpBody.Errors, tmpSummary).to.deep.equal({});
														Expect(Object.keys(tmpBody.Facets).length, tmpSummary).to.equal(Array.isArray(pBlock.Body.Facets) ? pBlock.Body.Facets.length : 0);
													}
													else if (tmpRoute === 'Records/Count')
													{
														Expect(tmpBody.Count, tmpSummary).to.be.a('number');
													}
													else if (tmpRoute === 'Keys')
													{
														Expect(tmpBody.Keys, tmpSummary).to.be.an('array');
													}
													else
													{
														Expect(tmpBody, tmpSummary).to.be.an('array');
													}
												}
												catch (pAssertion)
												{
													return fDone(pAssertion);
												}
												return fDone();
											});
									});
							}
						);
					});
			}
		);
	}
);
