#!/usr/bin/env node
/**
 * test-server -- the server smoke test at the example root: `node test-server.js` (the same run as
 * `npm test`, which calls server/Faceting-Demo-Smoke.js directly).
 *
 * Boots the whole demo in-process on 127.0.0.1:19301 (three seeded domains, faceting Embedded, the front
 * server), calls Describe / Query / Records / Records/Count for every page's request bodies through the
 * front server (bodies built by the frozen client contract, source/providers/Facet-Selection.js and
 * source/pages/FacetDemo-Pages.js), asserts the 200s, the expected totals per persona and that
 * Records/Count equals each envelope Total, then exits 0 (1 with the failed checks listed).
 *
 * @license MIT
 *
 * @author Steven Velozo <steven@velozo.com>
 */
require('./server/Faceting-Demo-Smoke.js').run();
