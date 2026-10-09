/**
 * Facet-ResultCache: the LRU, the freshness lookup, single-flight refresh and metrics.
 *
 * Owner: builder A (M4).  Obligations: internal-contracts §43, §49.1.  Registry port: 19131 (only if it
 * boots a server — it does not).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
const libChai = require('chai');
const Expect = libChai.expect;

const libBuilders = require('./support/Facet-Test-Builders.js');
const libResultCache = require('../source/cache/Retold-Faceting-ResultCache.js');

const OVERHEAD = libResultCache.ENTRY_OVERHEAD_BYTES;

/**
 * A cache with test bounds.
 *
 * @param {Record<string, any>} [pCache] - Cache options
 * @param {Record<string, any>} [pFreshness] - Freshness options
 * @return {libResultCache}
 */
const newCache = (pCache, pFreshness) =>
{
	let tmpOptions = { Cache: Object.assign({}, pCache || {}) };
	if (pFreshness)
	{
		tmpOptions.Freshness = pFreshness;
	}
	return new libResultCache(libBuilders.newFable('RetoldFacetingResultCacheTest'), tmpOptions);
};

/**
 * An entry (internal-contracts §43.1).
 *
 * @param {string} pKey
 * @param {Record<string, any>} [pFields]
 * @return {Record<string, any>}
 */
const entry = (pKey, pFields) =>
{
	let tmpFields = pFields || {};
	let tmpEnvelope = { Entity: 'Project', Version: null, ElapsedMS: 0, Total: tmpFields.Total || 3, Facets: {}, Errors: {}, Padding: tmpFields.Padding || '' };
	return Object.assign(
		{
			Key: pKey,
			GenVectorHash: 'g:0000000000000001',
			MaxTick: 1,
			SeqAtCompute: 'e:00000000:1',
			Body: JSON.stringify(tmpEnvelope),
			CreatedAt: Date.now(),
			AsOf: new Date().toISOString(),
			Engine: 'Live',
			Meta: { DependsOn: [ 'Project' ], ScopeRepaired: false, RecordsDropped: 0, Statements: 1, BindHash: 'b:x' }
		}, tmpFields.Entry || {});
};

/**
 * Body bytes that make an entry exactly pBytes long (Body + overhead).
 *
 * @param {number} pBytes
 * @return {string}
 */
const paddingFor = (pBytes) =>
{
	let tmpBase = Buffer.byteLength(entry('k').Body) + OVERHEAD;
	return 'x'.repeat(Math.max(0, pBytes - tmpBase));
};

const FRESH = { Hash: 'g:0000000000000001', MaxTick: 1 };
const MOVED = { Hash: 'g:0000000000000002', MaxTick: 2 };

suite
(
	'Facet-ResultCache',
	() =>
	{
		suite
		(
			'Bounds and eviction (internal-contracts §43.2)',
			() =>
			{
				test('the service constructs empty, bounded by the Cache options',
					() =>
					{
						let tmpCache = newCache({ MaxEntries: 3 });
						Expect(tmpCache.stats()).to.include({ Entries: 0, Bytes: 0, MaxEntries: 3 });
						Expect(newCache().stats()).to.include({ MaxEntries: 5000, MaxBytes: 67108864 });
						Expect(libResultCache.LOOKUP_STATUSES).to.deep.equal([ 'Hit', 'Stale', 'Miss' ]);
					});

				test('LRU by entries: the least recently used entry goes first; get refreshes recency',
					() =>
					{
						let tmpCache = newCache({ MaxEntries: 3 });
						[ 'ck:a', 'ck:b', 'ck:c' ].forEach((pKey) => { Expect(tmpCache.set(pKey, entry(pKey))).to.equal(true); });
						Expect(tmpCache.get('ck:a')).to.not.equal(null);
						Expect(tmpCache.set('ck:d', entry('ck:d'))).to.equal(true);
						Expect(tmpCache.get('ck:b'), 'b was least recently used').to.equal(null);
						Expect(tmpCache.get('ck:a')).to.not.equal(null);
						Expect(tmpCache.get('ck:c')).to.not.equal(null);
						Expect(tmpCache.get('ck:d')).to.not.equal(null);
						Expect(tmpCache.stats()).to.include({ Entries: 3, Evictions: 1, Stores: 4 });
						// One entry per key: a replace does not grow the cache.
						Expect(tmpCache.set('ck:a', entry('ck:a', { Total: 9 }))).to.equal(true);
						Expect(tmpCache.stats().Entries).to.equal(3);
						Expect(JSON.parse(tmpCache.get('ck:a').Body).Total).to.equal(9);
					});

				test('LRU by bytes: entries are evicted until Bytes ≤ MaxBytes; Bytes = Body bytes + overhead',
					() =>
					{
						let tmpCache = newCache({ MaxBytes: 3000, MaxEntryBytes: 3000 });
						let tmpPadding = paddingFor(1000);
						[ 'ck:a', 'ck:b', 'ck:c' ].forEach((pKey) => { tmpCache.set(pKey, entry(pKey, { Padding: tmpPadding })); });
						Expect(tmpCache.stats()).to.include({ Entries: 3, Bytes: 3000 });
						Expect(tmpCache.get('ck:a').Bytes).to.equal(1000);
						tmpCache.set('ck:d', entry('ck:d', { Padding: paddingFor(1500) }));
						let tmpStats = tmpCache.stats();
						Expect(tmpStats.Bytes).to.be.at.most(3000);
						Expect(tmpStats.Entries).to.equal(2);
						Expect(tmpCache.get('ck:b'), 'b evicted').to.equal(null);
						Expect(tmpCache.get('ck:c'), 'c evicted').to.equal(null);
						Expect(tmpStats.Bytes).to.equal(2500);
						// Multi-byte characters count as bytes, not characters.
						let tmpUnicode = newCache();
						tmpUnicode.set('ck:u', entry('ck:u', { Entry: { Body: '"ééé"' } }));
						Expect(tmpUnicode.get('ck:u').Bytes).to.equal(Buffer.byteLength('"ééé"') + OVERHEAD);
						// delete / clear adjust the bytes.
						tmpCache.delete('ck:a');
						tmpCache.delete('ck:nope');
						Expect(tmpCache.stats().Bytes).to.equal(1500);
						tmpCache.clear();
						Expect(tmpCache.stats()).to.include({ Entries: 0, Bytes: 0 });
					});

				test('MaxEntryBytes: a larger entry is refused (Rejected) and never displaces anything',
					() =>
					{
						let tmpCache = newCache({ MaxEntryBytes: 2000 });
						tmpCache.set('ck:a', entry('ck:a'));
						Expect(tmpCache.set('ck:a', entry('ck:a', { Padding: paddingFor(2001) }))).to.equal(false);
						Expect(tmpCache.set('ck:big', entry('ck:big', { Padding: paddingFor(2001) }))).to.equal(false);
						Expect(tmpCache.set('ck:edge', entry('ck:edge', { Padding: paddingFor(2000) }))).to.equal(true);
						Expect(tmpCache.stats()).to.include({ Rejected: 2, Entries: 2 });
						Expect(JSON.parse(tmpCache.get('ck:a').Body).Padding).to.equal('');
					});

				test('MaxAgeMS: an older entry is expired (deleted and counted) on get and lookup',
					() =>
					{
						let tmpCache = newCache({ MaxAgeMS: 1000 });
						tmpCache.set('ck:old', entry('ck:old', { Entry: { CreatedAt: Date.now() - 1001 } }));
						tmpCache.set('ck:old2', entry('ck:old2', { Entry: { CreatedAt: Date.now() - 5000 } }));
						tmpCache.set('ck:new', entry('ck:new'));
						Expect(tmpCache.get('ck:old')).to.equal(null);
						Expect(tmpCache.lookup('ck:old2', FRESH, { Mode: 'Fast', MaxLagMS: 5000 }, Date.now())).to.deep.include({ Status: 'Miss', Entry: null });
						Expect(tmpCache.get('ck:new')).to.not.equal(null);
						Expect(tmpCache.stats()).to.include({ Expired: 2, Entries: 1 });
					});

				test('newer MaxTick wins: a slow compute never overwrites a newer answer (an expired one, or an equal tick, is replaced)',
					() =>
					{
						let tmpCache = newCache({ MaxAgeMS: 1000 });
						Expect(tmpCache.set('ck:a', entry('ck:a', { Total: 10, Entry: { MaxTick: 10, GenVectorHash: 'g:10' } }))).to.equal(true);
						Expect(tmpCache.set('ck:a', entry('ck:a', { Total: 5, Entry: { MaxTick: 5, GenVectorHash: 'g:5' } }))).to.equal(false);
						Expect(tmpCache.get('ck:a').MaxTick).to.equal(10);
						Expect(tmpCache.set('ck:a', entry('ck:a', { Total: 11, Entry: { MaxTick: 10, GenVectorHash: 'g:10b' } }))).to.equal(true);
						Expect(tmpCache.get('ck:a').GenVectorHash).to.equal('g:10b');
						Expect(tmpCache.set('ck:a', entry('ck:a', { Entry: { MaxTick: 12, GenVectorHash: 'g:12' } }))).to.equal(true);
						// An expired newer entry does not block a store.
						tmpCache.set('ck:b', entry('ck:b', { Entry: { MaxTick: 50, CreatedAt: Date.now() - 2000 } }));
						Expect(tmpCache.set('ck:b', entry('ck:b', { Entry: { MaxTick: 3 } }))).to.equal(true);
						Expect(tmpCache.get('ck:b').MaxTick).to.equal(3);
					});

				test('errors and malformed entries are never stored; a stored entry is frozen and its Body is a string (callers parse a copy)',
					() =>
					{
						let tmpCache = newCache();
						Expect(tmpCache.set('ck:e', new Error('boom'))).to.equal(false);
						Expect(tmpCache.set('ck:e', entry('ck:e', { Entry: { Error: { Code: 'FACET_INTERNAL' } } }))).to.equal(false);
						Expect(tmpCache.set('ck:e', entry('ck:e', { Entry: { Meta: { Errors: 1 } } }))).to.equal(false);
						Expect(tmpCache.set('ck:e', entry('ck:e', { Entry: { Body: { Not: 'a string' } } }))).to.equal(false);
						Expect(tmpCache.set('ck:e', entry('ck:e', { Entry: { GenVectorHash: null } }))).to.equal(false);
						Expect(tmpCache.set('', entry(''))).to.equal(false);
						Expect(tmpCache.set(null, entry('x'))).to.equal(false);
						Expect(tmpCache.set('ck:e', null)).to.equal(false);
						Expect(tmpCache.stats()).to.include({ Entries: 0, Stores: 0 });

						tmpCache.set('ck:ok', entry('ck:ok'));
						let tmpEntry = tmpCache.get('ck:ok');
						Expect(Object.isFrozen(tmpEntry)).to.equal(true);
						Expect(tmpEntry.Key).to.equal('ck:ok');
						Expect(tmpEntry.Body).to.be.a('string');
						let tmpCopy = JSON.parse(tmpEntry.Body);
						tmpCopy.Total = 999;
						Expect(JSON.parse(tmpCache.get('ck:ok').Body).Total).to.equal(3);
					});
			}
		);

		suite
		(
			'Freshness lookup (internal-contracts §43.3)',
			() =>
			{
				test('the table, for every mode: Miss / Hit / Stale within MaxLagMS / Stale (Fast only) beyond it',
					() =>
					{
						let tmpNow = Date.now();
						let tmpCache = newCache({ MaxAgeMS: 60000 });
						tmpCache.set('ck:young', entry('ck:young', { Entry: { CreatedAt: tmpNow - 1000 } }));
						tmpCache.set('ck:aged', entry('ck:aged', { Entry: { CreatedAt: tmpNow - 10000 } }));
						let fLookup = (pKey, pVector, pMode) => { return tmpCache.lookup(pKey, pVector, { Mode: pMode, MaxLagMS: 5000 }, tmpNow); };
						let tmpTable =
							[
								// key, vector, Exact, Bounded, Fast
								[ 'ck:none', FRESH, 'Miss', 'Miss', 'Miss' ],
								[ 'ck:young', FRESH, 'Hit', 'Hit', 'Hit' ],
								[ 'ck:aged', FRESH, 'Hit', 'Hit', 'Hit' ],
								[ 'ck:young', MOVED, 'Miss', 'Stale', 'Stale' ],
								[ 'ck:aged', MOVED, 'Miss', 'Miss', 'Stale' ]
							];
						tmpTable.forEach(
							(pRow) =>
							{
								[ 'Exact', 'Bounded', 'Fast' ].forEach(
									(pMode, pIndex) =>
									{
										let tmpResult = fLookup(pRow[0], pRow[1], pMode);
										Expect(tmpResult.Status, `${pRow[0]} ${pRow[1].Hash} ${pMode}`).to.equal(pRow[2 + pIndex]);
										Expect(tmpResult.Entry === null, `${pRow[0]} ${pMode} entry`).to.equal(tmpResult.Status === 'Miss');
										if (tmpResult.Status === 'Hit')
										{
											Expect(tmpResult.LagMS).to.equal(0);
										}
									});
							});
						// LagMS of a Stale answer is its age.
						Expect(fLookup('ck:young', MOVED, 'Bounded').LagMS).to.equal(1000);
						Expect(fLookup('ck:aged', MOVED, 'Fast').LagMS).to.equal(10000);
						// The boundary: age == MaxLagMS is still Stale for Bounded, one ms more is a Miss.
						Expect(tmpCache.lookup('ck:young', MOVED, { Mode: 'Bounded', MaxLagMS: 1000 }, tmpNow).Status).to.equal('Stale');
						Expect(tmpCache.lookup('ck:young', MOVED, { Mode: 'Bounded', MaxLagMS: 999 }, tmpNow).Status).to.equal('Miss');
						// MaxLagMS 0: Bounded behaves as Exact for any aged entry.
						Expect(tmpCache.lookup('ck:young', MOVED, { Mode: 'Bounded', MaxLagMS: 0 }, tmpNow).Status).to.equal('Miss');
						// Unknown modes are Exact; a missing MaxLagMS takes Freshness.MaxLagMS.
						Expect(tmpCache.lookup('ck:young', MOVED, { Mode: 'Whatever' }, tmpNow).Status).to.equal('Miss');
						Expect(tmpCache.lookup('ck:young', MOVED, null, tmpNow).Status).to.equal('Miss');
						Expect(tmpCache.lookup('ck:young', MOVED, { Mode: 'Bounded' }, tmpNow).Status, 'default MaxLagMS 5000').to.equal('Stale');
						let tmpShortLag = newCache({}, { MaxLagMS: 500 });
						tmpShortLag.set('ck:young', entry('ck:young', { Entry: { CreatedAt: tmpNow - 1000 } }));
						Expect(tmpShortLag.lookup('ck:young', MOVED, { Mode: 'Bounded' }, tmpNow).Status, 'default MaxLagMS 500').to.equal('Miss');
						Expect(tmpShortLag.lookup('ck:young', MOVED, { Mode: 'Bounded', MaxLagMS: 2000 }, tmpNow).Status).to.equal('Stale');
						// A vector without a hash never matches anything (and is never served stale).
						Expect(tmpCache.lookup('ck:young', null, { Mode: 'Fast' }, tmpNow).Status).to.equal('Miss');
						Expect(tmpCache.lookup('ck:young', { MaxTick: 1 }, { Mode: 'Fast' }, tmpNow).Status).to.equal('Miss');
						// A clock that went backwards is age 0.
						Expect(tmpCache.lookup('ck:young', MOVED, { Mode: 'Bounded', MaxLagMS: 5 }, tmpNow - 5000)).to.deep.include({ Status: 'Stale', LagMS: 0 });
					});

				test('Exact never returns a stale answer, whatever the age, lag or vector',
					() =>
					{
						let tmpNow = Date.now();
						let tmpCache = newCache({ MaxAgeMS: 600000 });
						for (let i = 0; i < 50; i++)
						{
							tmpCache.set(`ck:${i}`, entry(`ck:${i}`, { Entry: { CreatedAt: tmpNow - (i * 997), GenVectorHash: `g:${i % 3}` } }));
						}
						for (let i = 0; i < 50; i++)
						{
							[ 'g:0', 'g:1', 'g:2', 'g:x' ].forEach(
								(pHash) =>
								{
									[ 0, 1000, 600000 ].forEach(
										(pLag) =>
										{
											let tmpResult = tmpCache.lookup(`ck:${i}`, { Hash: pHash }, { Mode: 'Exact', MaxLagMS: pLag }, tmpNow);
											Expect(tmpResult.Status).to.not.equal('Stale');
											if (tmpResult.Status === 'Hit')
											{
												Expect(tmpResult.Entry.GenVectorHash).to.equal(pHash);
											}
										});
								});
						}
					});

				test('counters: Hits, StaleHits, Misses',
					() =>
					{
						let tmpNow = Date.now();
						let tmpCache = newCache();
						tmpCache.set('ck:a', entry('ck:a', { Entry: { CreatedAt: tmpNow } }));
						tmpCache.lookup('ck:a', FRESH, { Mode: 'Exact' }, tmpNow);
						tmpCache.lookup('ck:a', MOVED, { Mode: 'Exact' }, tmpNow);
						tmpCache.lookup('ck:a', MOVED, { Mode: 'Bounded', MaxLagMS: 1000 }, tmpNow);
						tmpCache.lookup('ck:zz', FRESH, { Mode: 'Fast' }, tmpNow);
						Expect(tmpCache.stats()).to.include({ Hits: 1, StaleHits: 1, Misses: 2 });
					});
			}
		);

		suite
		(
			'Single flight and background refresh (internal-contracts §43.4)',
			() =>
			{
				test('refresh: N concurrent stale lookups start ONE work run; the flag clears when it calls back',
					(fDone) =>
					{
						let tmpCache = newCache();
						let tmpRuns = 0;
						let tmpPendingDone = null;
						let fWork = (fWorkDone) => { tmpRuns++; tmpPendingDone = fWorkDone; };
						let tmpStarted = [];
						for (let i = 0; i < 10; i++)
						{
							tmpStarted.push(tmpCache.refresh('ck:a', fWork));
						}
						Expect(tmpStarted.filter((pStarted) => { return pStarted; }).length).to.equal(1);
						Expect(tmpCache.refreshing('ck:a')).to.equal(true);
						Expect(tmpRuns, 'the work runs on the next turn, after the stale answer is sent').to.equal(0);
						// Another key refreshes independently.
						Expect(tmpCache.refresh('ck:b', (fWorkDone) => { fWorkDone(); })).to.equal(true);
						setImmediate(
							() =>
							{
								Expect(tmpRuns).to.equal(1);
								Expect(tmpCache.refresh('ck:a', fWork), 'still in flight').to.equal(false);
								tmpPendingDone();
								tmpPendingDone();   // a second call is ignored
								Expect(tmpCache.refreshing('ck:a')).to.equal(false);
								Expect(tmpCache.refreshing('ck:b')).to.equal(false);
								Expect(tmpCache.refresh('ck:a', (fWorkDone) => { tmpRuns++; fWorkDone(); })).to.equal(true);
								setImmediate(
									() =>
									{
										Expect(tmpRuns).to.equal(2);
										Expect(tmpCache.stats()).to.include({ Refreshes: 3, RefreshErrors: 0 });
										Expect(tmpCache.refresh('ck:a', 'not a function')).to.equal(false);
										Expect(tmpCache.refresh(null, fWork)).to.equal(false);
										return fDone();
									});
							});
					});

				test('at most Cache.MaxConcurrentRefreshes background refreshes run at once: beyond that none starts (the stale answer keeps being served) until a slot frees',
					(fDone) =>
					{
						let tmpCache = newCache({ MaxConcurrentRefreshes: 2 });
						let tmpPending = [];
						let fWork = (fWorkDone) => { tmpPending.push(fWorkDone); };
						Expect(tmpCache.refresh('ck:a', fWork)).to.equal(true);
						Expect(tmpCache.refresh('ck:b', fWork)).to.equal(true);
						Expect(tmpCache.refresh('ck:c', fWork), 'the cap').to.equal(false);
						Expect(tmpCache.stats()).to.include({ Refreshes: 2, RefreshesSkipped: 1 });
						setImmediate(
							() =>
							{
								tmpPending[0]();
								Expect(tmpCache.refresh('ck:c', fWork), 'a slot freed').to.equal(true);
								return fDone();
							});
					});

				test('eviction is approximately LRU without re-inserting hot keys: a hot entry read 10 000 times among 4 000 survives the pressure',
					() =>
					{
						let tmpCache = newCache({ MaxEntries: 4000, MaxBytes: 1e9 });
						for (let i = 0; i < 4000; i++)
						{
							tmpCache.set(`ck:${i}`, entry(`ck:${i}`));
						}
						for (let i = 0; i < 10000; i++)
						{
							tmpCache.get('ck:0');
						}
						for (let i = 4000; i < 4010; i++)
						{
							tmpCache.set(`ck:${i}`, entry(`ck:${i}`));
						}
						Expect(tmpCache.get('ck:0'), 'the hot (oldest-inserted) entry').to.not.equal(null);
						Expect(tmpCache.stats().Evictions).to.equal(10);
					});

				test('refresh errors (called back or thrown) are counted and logged, never thrown, and free the key',
					(fDone) =>
					{
						let tmpCache = newCache();
						tmpCache.refresh('ck:a', (fWorkDone) => { fWorkDone(new Error('database down')); });
						tmpCache.refresh('ck:b', () => { throw new Error('bug'); });
						setImmediate(
							() =>
							{
								Expect(tmpCache.stats()).to.include({ Refreshes: 2, RefreshErrors: 2 });
								Expect(tmpCache.refreshing('ck:a')).to.equal(false);
								Expect(tmpCache.refreshing('ck:b')).to.equal(false);
								Expect(tmpCache.stats().Entries, 'nothing stored').to.equal(0);
								return fDone();
							});
					});

				test('a stalled refresh stops blocking its key; shutdown forgets in-flight refreshes',
					() =>
					{
						let tmpCache = newCache();
						tmpCache.refresh('ck:a', () => {});
						Expect(tmpCache.refreshing('ck:a')).to.equal(true);
						tmpCache._Refreshing.set('ck:a', Date.now() - 3600000);
						Expect(tmpCache.refreshing('ck:a')).to.equal(false);
						tmpCache.refresh('ck:b', () => {});
						tmpCache.shutdown();
						Expect(tmpCache.refreshing('ck:b')).to.equal(false);
					});

				test('flight: concurrent callers share one work run and all receive its result; joiners are Coalesced',
					(fDone) =>
					{
						let tmpCache = newCache();
						let tmpRuns = 0;
						let tmpFinish = null;
						let tmpResults = [];
						for (let i = 0; i < 5; i++)
						{
							tmpCache.flight('ck:a|g:1', (fWorkDone) => { tmpRuns++; tmpFinish = fWorkDone; },
								(pError, pResult, pCoalesced) => { tmpResults.push({ Error: pError, Result: pResult, Coalesced: pCoalesced }); });
						}
						Expect(tmpRuns).to.equal(1);
						Expect(tmpResults.length).to.equal(0);
						// Another flight key runs its own work.
						tmpCache.flight('ck:a|g:2', (fWorkDone) => { tmpRuns++; fWorkDone(null, 'other'); }, () => {});
						Expect(tmpRuns).to.equal(2);
						setImmediate(
							() =>
							{
								tmpFinish(null, { Total: 42 });
								Expect(tmpResults.length).to.equal(5);
								tmpResults.forEach((pResult) => { Expect(pResult.Result).to.deep.equal({ Total: 42 }); Expect(pResult.Error).to.equal(null); });
								Expect(tmpResults.map((pResult) => { return pResult.Coalesced; })).to.deep.equal([ false, true, true, true, true ]);
								Expect(tmpCache.stats().Flights).to.equal(2);
								// Nothing is retained: the next caller runs the work again.
								tmpCache.flight('ck:a|g:1', (fWorkDone) => { tmpRuns++; fWorkDone(null, 'again'); },
									(pError, pResult, pCoalesced) =>
									{
										Expect(pResult).to.equal('again');
										Expect(pCoalesced).to.equal(false);
										Expect(tmpRuns).to.equal(3);
										return fDone();
									});
							});
					});

				test('flight errors reach every waiter and are never retained; a work that throws errors every waiter',
					() =>
					{
						let tmpCache = newCache();
						let tmpFinish = null;
						let tmpErrors = [];
						tmpCache.flight('f', (fWorkDone) => { tmpFinish = fWorkDone; }, (pError) => { tmpErrors.push(pError); });
						tmpCache.flight('f', () => { throw new Error('never runs'); }, (pError) => { tmpErrors.push(pError); });
						tmpFinish(new Error('timeout'));
						Expect(tmpErrors.map((pError) => { return pError.message; })).to.deep.equal([ 'timeout', 'timeout' ]);
						let tmpRan = false;
						tmpCache.flight('f', (fWorkDone) => { tmpRan = true; fWorkDone(null, 1); }, (pError, pResult) => { Expect(pError).to.equal(null); Expect(pResult).to.equal(1); });
						Expect(tmpRan, 'the error was not cached').to.equal(true);

						let tmpThrown = [];
						tmpCache.flight('t', () => { throw new Error('bug'); }, (pError) => { tmpThrown.push(pError.message); });
						Expect(tmpThrown).to.deep.equal([ 'bug' ]);
						Expect(tmpCache._Flights.size).to.equal(0);
						Expect(tmpCache.stats().Entries).to.equal(0);
					});

				test('a waiter that throws never starves the others; its exception is rethrown to the work afterwards',
					() =>
					{
						let tmpCache = newCache();
						let tmpFinish = null;
						let tmpSeen = [];
						tmpCache.flight('w', (fWorkDone) => { tmpFinish = fWorkDone; }, () => { tmpSeen.push(1); throw new Error('assertion in a callback'); });
						tmpCache.flight('w', null, () => { tmpSeen.push(2); });
						Expect(() => { tmpFinish(null, 'x'); }).to.throw('assertion in a callback');
						Expect(tmpSeen).to.deep.equal([ 1, 2 ]);
						// A throw from a synchronous continuation (after the work called back) belongs to the caller.
						Expect(() =>
						{
							tmpCache.flight('s', (fWorkDone) => { fWorkDone(null, 1); }, () => { throw new Error('continuation'); });
						}).to.throw('continuation');
						Expect(tmpCache._Flights.size).to.equal(0);
					});

				test('shutdown clears flight bookkeeping: running work still calls its own waiters, new callers start fresh',
					() =>
					{
						let tmpCache = newCache();
						let tmpFinish = null;
						let tmpSeen = [];
						tmpCache.flight('f', (fWorkDone) => { tmpFinish = fWorkDone; }, (pError, pResult) => { tmpSeen.push(`old:${pResult}`); });
						tmpCache.shutdown();
						let tmpNewRuns = 0;
						tmpCache.flight('f', (fWorkDone) => { tmpNewRuns++; fWorkDone(null, 'new'); }, (pError, pResult) => { tmpSeen.push(`new:${pResult}`); });
						tmpFinish(null, 'old');
						Expect(tmpNewRuns).to.equal(1);
						Expect(tmpSeen).to.deep.equal([ 'new:new', 'old:old' ]);
					});
			}
		);

		suite
		(
			'Metrics (internal-contracts §43.5)',
			() =>
			{
				test('stats() carries every metric; note() counts NotModified and Bypass reasons',
					() =>
					{
						let tmpCache = newCache({ MaxEntries: 7, MaxBytes: 100000 });
						tmpCache.note('NotModified');
						tmpCache.note('NotModified');
						tmpCache.note('Bypass', 'Opaque');
						tmpCache.note('Bypass', 'Opaque');
						tmpCache.note('Bypass', 'Mode');
						tmpCache.note('Bypass');
						tmpCache.note('Bypass', 'x'.repeat(65));
						tmpCache.note('Unknown', 'Ignored');
						let tmpStats = tmpCache.stats();
						Expect(Object.keys(tmpStats).sort()).to.deep.equal(
							[ 'Bypass', 'Bytes', 'Entries', 'Evictions', 'Expired', 'Flights', 'Hits', 'MaxBytes', 'MaxEntries', 'Misses', 'NotModified',
								'Refreshes', 'RefreshErrors', 'RefreshesSkipped', 'Rejected', 'StaleHits', 'Stores' ].sort());
						Expect(tmpStats).to.include({ NotModified: 2, MaxEntries: 7, MaxBytes: 100000, Hits: 0, Misses: 0 });
						Expect(tmpStats.Bypass).to.deep.equal({ Opaque: 2, Mode: 1, Other: 2 });
						// stats() is a copy.
						tmpStats.Bypass.Opaque = 99;
						Expect(tmpCache.stats().Bypass.Opaque).to.equal(2);
					});
			}
		);
	}
);
