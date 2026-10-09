# Faceting Demo — build spec (Milestones 3 and 4)

> **Done means:** `cd example_applications/faceting_demo && npm start` boots ONE user-facing server on `127.0.0.1:19300`, prints the URL, and the browser shows a polished pict SPA with four pages (Projects for me, Documents by form type, Lab forms I still have to fill out, Bookstore explorer), a DEMO "Signed in as" switcher that visibly changes counts, a request/envelope inspector, and honest empty and error states. Every facet click writes back a Clause the server put on a bucket, so the list total and the clicked bucket always agree.

Everything in this file was measured against the M2 code (752/929 green) on the Small seed: the request bodies in §6 are what `Facet-Selection.buildQueryBody` produces from `source/pages/FacetDemo-Pages.js`, and the expected numbers are real answers, after the renumbering of §2.3.

Design references: `02-api.md` §6, §7, §13; `08-worked-examples.md` §2–§4; `10-modules-and-roadmap.md` §1.2; `docs/internal-contracts.md` §10, §28–§31. Prior art for the histogram: `modules/private/sluice/source/web/client/views/PictView-Sluice-Filter-Histogram.js`.

---

## 0. File ownership (two parallel builders)

Paths are relative to `example_applications/faceting_demo/`.

| File | State now | Owner |
|---|---|---|
| `DEMO-SPEC.md` | this spec | spec |
| `package.json` | **done** (scripts, copyFiles, deps) | SERVER |
| `server/Faceting-Demo-Server.js` | skeleton | SERVER |
| `server/Faceting-Demo-Domains.js` | skeleton | SERVER |
| `server/Faceting-Demo-Front.js` | skeleton | SERVER |
| `server/Faceting-Demo-Smoke.js` | skeleton | SERVER |
| `server/Faceting-Demo-Personas.js` | **done** (personas, header, renumber map) | SERVER |
| `server/definitions/Bookstore-Demo-Definitions.json` | **done, validated** (3 facets, 1 scope, 0 disabled) | SERVER |
| `server/Copy-Pict.js`, `server/Ensure-Built.js` | **done** | SERVER |
| `README.md` | skeleton | SERVER |
| module `docs/internal-contracts.md` §14.4 port rows, module `README.md` "Demo" paragraph | to add | SERVER |
| `source/Pict-Application-FacetingDemo.js` | skeleton (registrations + router wired, boots) | CLIENT |
| `source/providers/Pict-Provider-Facet.js` | skeleton (API + state shape) | CLIENT |
| `source/views/PictView-Facet-{Scope,Terms,Histogram,Pivot,Records,Inspector}.js` | skeletons | CLIENT |
| `source/views/PictView-FacetDemo-{Layout,Page,Compare}.js` | skeletons | CLIENT |
| `html/index.html` | **done** | CLIENT |
| `css/faceting-demo.css` | **done** (tokens light/dark, base, example header) | CLIENT |
| `source/Facet-Contract.js` | **done** (the one deep-require shim) | **frozen** |
| `source/providers/Facet-Selection.js` | **done, validated** (bodies, routes, write-back helpers) | **frozen** |
| `source/pages/FacetDemo-Pages.js` | **done, validated** (groups, initial state, layouts, expected totals) | **frozen** |
| module `package.json` `"example": "npx quack examples"`, module `.gitignore` (quack build files) | **done** | — |

**Frozen** = the shared contract between the builders: the SERVER smoke test imports these three files to build the exact browser bodies. The CLIENT may ADD exports or page/panel fields (e.g. new panel options), but must not change an existing export's signature, the bodies `buildQueryBody` / `buildRecordsBody` produce for the existing groups, `routePath`, or `EXPECTED_INITIAL_TOTALS`.

Rules for both: tabs, Allman braces, `pVariable` / `tmpVariable` / `libX`; no `npm install` (everything resolves from `/Users/steven/Code/retold/node_modules`: pict 1.0.394, pict-view 1.0.68, pict-application 1.0.34, pict-provider 1.0.13, pict-router 1.0.10 + navigo, quackage 1.3.0); nothing outside the module; never git add/commit/push; ports 19300–19310 only.

The skeleton already builds (`npm run build`, 3.6 s) and boots in a browser: providers `Facet`, `PictRouter`; all nine views; the five groups defined in `AppData.Facet.Groups`; `#/Documents` reaches `showPage('Documents')`.

---

## 1. Directory layout

```
faceting_demo/
  package.json                    name retold-faceting-service-example-faceting-demo
                                  bundle  dist/retold-faceting-service-example-faceting-demo.compatible.min.js
                                  global  RetoldFacetingServiceExampleFacetingDemo
  DEMO-SPEC.md  README.md
  html/index.html                 -> dist/index.html (theme set before first paint)
  css/faceting-demo.css           -> dist/faceting-demo.css (tokens + base + .pict-example-header)
  server/                         the demo HOST (node only, never bundled)
    Faceting-Demo-Server.js       npm start
    Faceting-Demo-Domains.js      three harness domains, renumbering, loopback guard
    Faceting-Demo-Front.js        node:http on 19300: static dist/ + /api/Demo/* + the facet proxy
    Faceting-Demo-Personas.js     DEMO principal table
    Faceting-Demo-Smoke.js        npm test (port 19301)
    Ensure-Built.js               prestart: build once if dist/ lacks the bundle
    Copy-Pict.js                  build step: pict.min.js -> dist/
    definitions/Bookstore-Demo-Definitions.json
  source/                         the browser app (bundled; liftable into pict-section-facet)
    Pict-Application-FacetingDemo.js
    Facet-Contract.js             ../../../source/contract/* (the only reach into the service)
    pages/FacetDemo-Pages.js      the four pages as data
    providers/Pict-Provider-Facet.js
    providers/Facet-Selection.js  pure: bodies, routes, write-back
    views/PictView-FacetDemo-{Layout,Page,Compare}.js     demo shell (not lifted)
    views/PictView-Facet-{Scope,Terms,Histogram,Pivot,Records,Inspector}.js   liftable widgets
```

Deviation from `CLAUDE-ExampleApplicationInstructions.md`: the host lives in `server/`, not `source/server/`, so `source/**` is exactly the liftable client tree. `npx quack examples` (module level) serves the static shell only; the facet API needs `npm start`. The example is not docs-stageable (`"Stage": false`) for that reason.

Build: `npm run build` = `npx quack build && npx quack copy && node server/Copy-Pict.js`. quack copy cannot copy `./node_modules/pict/dist/*` (the example has no node_modules), so Copy-Pict resolves `pict/dist/pict.min.js` with `require.resolve` and copies it to the dist root.

---

## 2. Server (SERVER builder)

### 2.1 Entry: `server/Faceting-Demo-Server.js`

| Env | Default | Meaning |
|---|---|---|
| `DEMO_PORT` | `19300` | front server port; refuse anything outside 19300–19310 |
| `DEMO_HOST` | `127.0.0.1` | front server bind address (loopback by default: the principal header must not be reachable from a network) |
| `DEMO_SCALE` | `Small` | harness `Scale` (`Small` \| `Medium` ×4) |
| `DEMO_PG` | unset | `1`: every domain on PostgreSQL in `rfs-test-postgres` (harness `Provider: 'PostgreSQL'`; sets `RFS_TEST_POSTGRES=1`; requires `TZ=UTC` in the environment and docker; refuse with a clear message otherwise). Optional; SQLite is the demo. |
| `DEMO_LOG_LEVEL` | `error` | harness `LogLevel` |
| `DEMO_SKIP_BUILD` | unset | `1`: prestart does not build |

Export `startDemo({ Port, Host, Scale, Provider, LogLevel }, fCallback(pError, { URL, Front, Domains, stop(fDone) }))` and keep `main()` a thin wrapper (env → startDemo → banner → signals), so the smoke test boots in-process. Sequence: boot domains (§2.2, in order, each renumbered and guarded) → create the front server (§2.4) → `listen(DEMO_PORT, DEMO_HOST)` (EADDRINUSE → "port 19300 is busy; set DEMO_PORT=19302", exit 1) → banner → SIGINT/SIGTERM close everything (`harness.stop` drops a PG database), exit 0.

Banner (exact wording free; content required):

```
Retold Faceting demo  http://127.0.0.1:19300/
  ProjectTrack  SQLite Small  Project 60 · Document 800 · Task 600 …   definitions 4 facets / 5 scopes   (upstream 127.0.0.1:53112)
  LabTrack      SQLite Small  MaterialIntakeRequirement … · LabForm …   definitions 9 facets / 2 scopes
  Bookstore     SQLite Small  Book 1436 (tenant 7) …                    definitions 3 facets / 1 scope
  Personas: user42 (tenant 7, user 42) · user43 · user44 · user81 (tenant 8) · anonymous
  DEMO ONLY: the principal comes from the X-Retold-Facet-Demo-Principal header, resolved by this host. Never deploy it.
```

### 2.2 Domains: `server/Faceting-Demo-Domains.js`

Reuse the M2 test harness whole (`test/support/Facet-Test-Harness.js` `start()`), one instance per domain: it seeds an in-memory SQLite, boots a plain retold-data-service, installs the §31.2 tenancy / owner behaviors, and attaches faceting **Embedded** via `installOnRetoldDataService` with the domain's `FACETING_OPTIONS` and definitions. It is the most robust layout available: every piece is exercised by the 752 tests.

| Domain | `Fixture` | `Definitions` | registry tag `Port` | Faceting policy |
|---|---|---|---|---|
| ProjectTrack | `'ProjectTrack'` | `'Auto'` (ProjectTrack-Definitions.json) | 19196 | `IDCustomer` ← `CustomerID`; FormType global |
| LabTrack | `'LabTrack'` | `'Auto'` (LabTrack-Definitions.json) | 19197 | `IDCustomer`; LabForm owner `OwnerIDUser` ← `UserID`; LabFormType global |
| Bookstore | `'Bookstore-Tenant'` | `[ server/definitions/Bookstore-Demo-Definitions.json ]` | 19198 | `IDTenant` ← `IDTenant` |

- The harness `Port` must be in 19100–19199 and is only a registry label: without `FixedPort` the server binds an **ephemeral** port; the front server proxies to `harness.baseURL`. Only 19300 (19301 for the smoke) is user-facing. Add rows `19196–19198 | example_applications/faceting_demo (registry tags; binds ephemeral)` to `docs/internal-contracts.md` §14.4.
- Pass `Provider`, `Scale`, `LogLevel` from §2.1. Keep the harness defaults otherwise (`TenancyBehavior: 'Auto'`).
- **Loopback guard:** after boot, `harness.fable.OratorServiceServer.pre(...)` answering `403 { Error: { Code: 'DEMO_LOOPBACK_ONLY' } }` (and `fNext(false)`) to any client whose `pRequest.socket.remoteAddress` is not `127.0.0.1` / `::1` / `::ffff:127.0.0.1`. The harness's test session shim (`x-facet-test-tenant` / `x-facet-test-user`) must only ever be reached through the front server. Verify a `pre()` added after `listen` takes effect (restify appends to the pre chain); if not, document the limitation in README.
- Bookstore definitions load clean (validated: `{"Facets":3,"Scopes":1,"Aliases":0,"Disabled":0,"Warnings":0}`). ProjectTrack: `{"Facets":4,"Scopes":5,"Disabled":0,"Warnings":0}`; LabTrack: `{"Facets":9,"Scopes":2,"Disabled":0,"Warnings":2}` (the 2 warnings are expected: `Ignored:Records`, `CountModeCanonicalized`).

### 2.3 Renumbering (so the demo reads like design 08)

The seeds' story principal is user 1 of tenant 1. Right after each domain boots, apply `Faceting-Demo-Personas.RENUMBER[<Domain>]` to the live database (the faceting service caches no data, so renumbering after attach is safe — `debug/m2-smoke.js` does the same):

```
ProjectTrack, LabTrack   every column named IDCustomer: 1 -> 7, 2 -> 8
                         every column matching /IDUser$/ (IDUser, OwnerIDUser, AssignedIDUser, Creating/Updating/DeletingIDUser): 1 -> 42, 2 -> 43, 3 -> 44, 31 -> 81
Bookstore                every column named IDTenant: 1 -> 7, 2 -> 8   (users untouched: not principals there)
```

`UPDATE "<Table>" SET "<Column>" = ? WHERE "<Column>" = ?` per (table, column, pair), iterating `harness.model.Tables[*].Columns`. SQLite: `harness.db.prepare(sql).run(new, old)`; PostgreSQL: `harness.connection.pool.query(sql with $1/$2, [new, old])`. Before renumbering, assert the targets are unused (`User.IDUser`, `Customer.IDCustomer` / distinct `IDTenant`); the seeds use users 1..36 and tenants 1, 2, so 42/43/44/81 and 7/8 are free. Validated: the expected totals in §3.3 were measured after exactly this renumbering.

### 2.4 Front server: `server/Faceting-Demo-Front.js` (plain `node:http`, like `Sharp-API-Server.js`)

| Method + path | Answer |
|---|---|
| `GET /` | `dist/index.html` |
| `GET /<file>` | `dist/<file>`; MIME by extension (`.html .js .css .json .map .svg .png .ico`); `path.resolve` must stay inside `dist/` (else 404); `/pict.min.js` falls back to `require.resolve('pict/dist/pict.min.js')`; dist/ missing → a small HTML page "Run `npm run build`" (status 503) |
| `GET /api/Demo/Principals` | `Personas.publicList()` → `{ Header, Default, Warning, Personas: [ { Key, Label, Tenant, User, Summary, Domains: { ProjectTrack, LabTrack, Bookstore } } ] }` |
| `GET /api/Demo/Status` | `{ Provider, Scale, StartedAt, Domains: { <Domain>: { Fixture, Entities: [ … ], LiveCounts: { … }, Definitions: registry.status() } } }` |
| `GET\|POST /api/<Domain>/1.0/Facet/<rest>` | proxied to `<harness.baseURL>/1.0/Facet/<rest>` (query string kept). `<Domain>` ∈ ProjectTrack, LabTrack, Bookstore, else 404 `DEMO_UNKNOWN_DOMAIN`. Other methods 405 `DEMO_METHOD_NOT_ALLOWED`. |
| anything else under `/api/` | 404 `{ Error: { Code: 'DEMO_NOT_FOUND', Status: 404, Message } }` |

Proxy rules:

- **Request headers forwarded:** `content-type`, `accept`, `if-none-match` only. Body read fully (≤ 256 KiB, else 413 `DEMO_BODY_TOO_LARGE`) and re-sent with its `content-length`.
- **Principal:** read `x-retold-facet-demo-principal`; `Personas.personaFor(key)`; a persona with a `Tenant` adds upstream `x-facet-test-tenant: <Tenant>` and `x-facet-test-user: <User>`; an unknown key, `anonymous` or no header forwards **no** session. Browser-supplied `x-facet-test-*` headers are dropped, never forwarded.
- **Response:** status and body passed through (304 with no body); headers kept: `content-type`, `etag`, `cache-control`, `vary`, every `x-retold-facet-*`; added: `X-Retold-Facet-Demo-Upstream: <METHOD> /1.0/Facet/<rest>`, `X-Retold-Facet-Demo-Session: tenant=7; user=42` (or `anonymous`), `Server-Timing: upstream;dur=<ms, 1 decimal>`.
- Upstream connection error → 502 `{ Error: { Code: 'DEMO_UPSTREAM_UNAVAILABLE', Status: 502, Message } }`.
- No CORS: the browser only talks to this origin.

Every JSON error the demo host itself produces uses the service's error shape `{ Error: { Code, Status, Message, Detail? } }` so the client renders demo and service errors the same way.

### 2.5 Smoke: `server/Faceting-Demo-Smoke.js` (`npm test`)

Boot everything with `DEMO_PORT=19301` in-process (reuse `main`-level functions, not a child process) and drive it **through the front server** with `fetch`, importing the frozen `Facet-Selection.js` and `FacetDemo-Pages.js`:

1. Static: `/`, `/pict.min.js`, `/<bundle>.compatible.min.js` → 200 (when dist/ is built; else print "skipped: run npm run build").
2. `/api/Demo/Principals` lists 5 personas; `/api/Demo/Status` lists 3 domains.
3. `GET /api/<Domain>/1.0/Facet/Describe` as user42: Project has scopes MyProjects (Params.Roles EnumList), HasMyOverdue, Unblocked, ManyOverdue; Book has scope `Book.WellReviewed` and declared `Book.ReviewRating` (MultiValued), `Book.ReviewCount`, `Book.HasFiveStar`; MaterialIntakeRequirement has scope `…ToDoForMe` (Relaxed).
4. Every group × every persona: `POST /api/<Domain>` + `routePath(state, 'Query')` with `buildQueryBody(initialGroupState(def))` → `EXPECTED_INITIAL_TOTALS` (LabFormsB: `Facets.ToDo.Total`); anonymous → 401 `FACET_UNAUTHENTICATED` on every group.
5. Repeat one Query with `If-None-Match: <etag>` → 304.
6. Records agree: `routePath(state,'Count')` + `buildRecordsBody` → `{ Count }` == envelope Total for Projects, Documents, LabFormsA, Books; `routePath(state,'Records',25,25)` returns `max(0, min(25, Total − 25))` rows (Projects: 0, LabFormsA: 25).
7. Write-back round trips (user42): Projects `toggleTermsKey` OnHold → Total 7 == Records/Count; Projects `rangeClause(Started, 2, 7)` → buckets Feb–Jul 2026 come back `Selected`; `pivotCellSelections('Status','Client','Active',9)` → Total 2; LabFormsA `rangeClause(Week,0,4)` + `toggleTermsKey(Discipline, null, 0)` → Total == Records/Count (8); Books `toggleTermsKey(Language)` on the `''` bucket + `rangeClause(Year,5,6)` → Total 57 == Records/Count.
8. Forged header: persona `anonymous` + browser header `x-facet-test-tenant: 7` → still 401.
9. Documents with `Facets[ByMonth].Interval = 'day'` → 200 with `Errors.ByMonth.Code === 'FACET_INTERVAL_TOO_FINE'`, `Detail.Suggest.Interval === 'week'`.
10. `DEMO_LOOPBACK_ONLY` cannot be exercised from loopback; assert the guard is installed (a flag the Domains module sets).

Exit 0 on success, 1 with a readable diff otherwise; always stop the domains.

---

## 3. The DEMO principal mechanism

### 3.1 Wire

```
browser ──X-Retold-Facet-Demo-Principal: user42──▶ front server (19300)
            personaFor('user42') = { Tenant: 7, User: 42 }
        ──x-facet-test-tenant: 7, x-facet-test-user: 42──▶ domain server (loopback, ephemeral)
            harness session shim → UserSession { LoggedIn, UserID: 42, IDUser: 42, CustomerID: 7, IDTenant: 7 }
            → retold-faceting PrincipalResolver (unset → 401) → ScopeGuard on every hop
```

The browser can only pick among server-side personas; it never sends IDs. The header name, the persona table and the session shim are demo-only and live outside `source/` of the service. The UI labels the switcher **DEMO** in the warning color, and its tooltip says "Demo only: this host resolves the header to a test session. A real app resolves the principal from its own session."

### 3.2 Personas (`server/Faceting-Demo-Personas.js`)

| Key | Label | Tenant / user | ProjectTrack | LabTrack | Bookstore |
|---|---|---|---|---|---|
| `user42` (default) | User 42 | 7 / 42 | Lena Lead (Owner/Lead, overdue tasks in every band) | Tess Tech (queues 1, 2) | tenant 7 |
| `user43` | User 43 | 7 / 43 | Mo Member (Member/Reviewer only) | Cole Colleague (queues 1, 6) | tenant 7 |
| `user44` | User 44 | 7 / 44 | Otto Outsider (nothing) | Nia Newbie (no queue) | tenant 7 |
| `user81` | User 81 | 8 / 81 | Edsger Turing (tenant 8 lead) | Margaret Backus (tenant 8 tech) | tenant 8 (5 % clone) |
| `anonymous` | Anonymous | — | 401 | 401 | 401 |

### 3.3 Expected answers of the initial state (Small seed, after renumbering)

| Persona | Projects Total | Documents Total | Lab forms A Total | Lab forms B ToDo.Total | Books Total |
|---|---|---|---|---|---|
| user42 | 6 | 41 | 237 | 224 | 1436 |
| user43 | 0 (Roles Owner+Lead; add "Member" **and** switch "Has my overdue tasks" off → 2; Member alone stays 0) | 41 | 172 | 157 | 1436 |
| user44 | 0 | 41 | 0 | 0 | 1436 |
| user81 | 1 | 9 | 60 | 34 | 81 |
| anonymous | 401 FACET_UNAUTHENTICATED | 401 | 401 | 401 | 401 |

The same request, different principal, different counts: that is the switcher's lesson. user43/user44 give the empty states for free.

### 3.4 Switching (client)

`PictApplication.setPrincipal(key)`: persist to `localStorage['retold-faceting-demo-principal']` (try/catch), `AppData.FacetDemo.PrincipalKey = key`, `Facet.setPrincipalKey(key)`, re-render the header, `Facet.describe(<domain>)` for the active page's domains, `Facet.refresh(<group>)` for the active page's groups (and the visible tab's). Other pages refresh when shown (their `state.PrincipalKey !== current`). Selections are kept across principals (same request, different answer).

---

## 4. Client architecture (CLIENT builder)

### 4.1 Boot

1. Constructor (done): `RouterSkipRouteResolveOnAdd`, providers `PictRouter` (routes from `FacetDemo-Pages.Pages[].Route` → `{~LV:Pict.PictApplication.showPage(\`<Hash>\`)~}`) and `Facet`, the nine views.
2. `onAfterInitializeAsync` (partly done): `AppData.FacetDemo`, endpoint prefix `/api/<Domain>`, request-header hook (the DEMO header), `defineGroup` for every group. **To do:** `fetch('/api/Demo/Principals')` and `/api/Demo/Status` → `AppData.FacetDemo.Personas` / `.Status`, choose the saved persona or `Default`, `setPrincipalKey`, then render `FacetDemo-Layout`. A failed fetch sets `AppData.FacetDemo.BootError` (rendered as a full-page error card: "The demo host is not answering: run `npm start` in example_applications/faceting_demo").
3. Layout `onAfterRender` (shell): render header + inspector, resolve the router once; empty hash → `navigateTo('/Projects')`.
4. `showPage(hash)`: `ActivePage = hash`, header re-render (nav highlight), render `FacetDemo-Page`, describe the page's domains (once per principal), refresh the page's visible groups that never loaded or loaded for another principal.

### 4.2 AppData

```
AppData.FacetDemo = { Ready, ActivePage, ActiveTab: { LabForms: 'A' }, Personas: [ … ], PrincipalKey, PrincipalHeader,
                      Theme, Status: <GET /api/Demo/Status>, BootError }
AppData.FacetCapabilities[<Domain>] = <GET /1.0/Facet/Describe body for the current principal>   (Sluice's address, design 02 §13)
AppData.Facet =
{
	PrincipalKey: 'user42',
	Groups:
	{
		<GroupHash>:                                  // Facet-Selection.initialGroupState + runtime
		{
			Hash, Domain, Entity, RouteScope, Total,
			Facets: [ <spec> ],                           // verbatim on the wire; setFacetOption edits Interval here
			BaseClauses: [ ],
			ScopeState: { '<Scope>': { On, Params } },    // insertion order = body order
			Selections: { '<FacetKey>': <Clause> },       // a facet's write-back; absent/null = no selection
			Records: { Begin, Cap, Sort: [ { Field, Dir } ] } | null,
			Status: 'Idle' | 'Loading' | 'Ready' | 'Error',
			Seq, PrincipalKey,                            // the Seq / principal of the last applied answer
			Envelope: <last applied 200 envelope> | null,
			Error: { Code, Status, Message, Detail } | null,          // whole-request failure (HTTP status ≠ 200)
			RecordsPage: { Begin, Cap, Rows: [ … ], Status, Error } | null,
			CountCheck: { Status, Count, Total, Agrees, Error } | null,
			LastExchangeID,
			Widgets: { '<FacetKey>' | 'Scope' | 'Records' | 'Compare': <display model written by the widget view> }
		}
	},
	Log: [ <Exchange> ],                              // newest first, ≤ MaxLog (30)
	LogSeq,
	Inspector: { Open: false, SelectedID: null, Tab: 'Envelope' }
}
```

Exchange (one per HTTP call; the inspector's data):

```
{ ID, At, GroupHash | null, Kind: 'Describe' | 'Query' | 'Records' | 'Count',
  Domain, Method, URL: '/api/ProjectTrack/1.0/Facet/Project/Query', UpstreamPath: '/1.0/Facet/Project/Query',
  RequestHeaders: { 'X-Retold-Facet-Demo-Principal': 'user42', 'If-None-Match': 'W/"fv1:…"' }, Body,
  Status, NotModified, Superseded, Aborted, ElapsedMS /* performance.now round trip */,
  ResponseHeaders: { ETag, X-Retold-Facet-Contract, X-Retold-Facet-Scope-Repaired, X-Retold-Facet-Records-Dropped,
                     X-Retold-Facet-Demo-Upstream, X-Retold-Facet-Demo-Session, Server-Timing },
  Response /* parsed JSON, or the cached body on a 304 */,
  Summary: { Engine, Exact, Version, ModelVersion, ServerElapsedMS, Total, Records: n,
             Facets: [ { Key, Fold, Disjunctive, Excluded, KeptMixed, CountMode, Total, SumOfCounts, MissingCount,
                         OtherCount, Truncated, MultiValued, Relaxed, Semantics, Error } ],
             FilterApplied, Warnings, Errors } | null,
  Error: { Code, Status, Message, Detail } | null }
```

### 4.3 `Pict-Provider-Facet` (liftable; `pict.providers.Facet`)

Signatures are in the skeleton; semantics:

- **Wiring:** `setEndpointPrefix(fn(domain))` (demo: `/api/<Domain>`), `setRequestHeaders(fn)` (demo: the DEMO header), `setPrincipalKey(key)` (partitions cache + Describe; no implicit refresh).
- **Groups:** `defineGroup(def, reset?)`, `group(hash)`, `subscribe(hash, fn(state, reason)) → unsubscribe`; reasons `Loading | Ready | Error | Records | Count | State`.
- **State writes, each followed by ONE coalesced refresh:** `setSelection(g, key, clause|null)`, `setSelections(g, { key: clause|null })` (pivot: two facets, one POST), `setScope(g, scope, on, params?)`, `setFacetOption(g, key, { Interval })`, `setRecordsSort(g, field)` (same field toggles ASC/DESC, new field ASC), `clearSelections(g)`. Every filter write resets `Records.Begin = 0` and `CountCheck = null`.
- **Coalescing (design 02 §13):** `refresh(g, cb?)` and `query(g, extraSpecs?, cb?)` push onto the group's pending list and arm one `setTimeout(CoalesceMS = 10)`; the flush sends ONE `POST <prefix> + routePath(state,'Query')` with `buildQueryBody(state)` (extra specs from `query()` merged by `Key`); every pending callback gets that answer. So a pivot cell, a scope toggle + param chip in quick succession, or N widgets asking at once all cost one POST. The inspector proves it.
- **Superseding:** each flush `state.Seq++`; an answer whose Seq is not the current one is logged `Superseded: true` and never applied; abort the older fetch with `AbortController` (logged `Aborted`).
- **Apply:** 200 → `Envelope`, `Status 'Ready'`, `Error null`, `PrincipalKey`, `RecordsPage = { Begin, Cap, Rows: Envelope.Records }` (when the body asked for Records); non-200 → `Status 'Error'`, `Error = body.Error` (or a synthetic `{ Code: 'DEMO_NETWORK', Status: 0 }` on a network failure), `Envelope = null` (a stale answer for another principal or filter must not stay on screen), notify.
- **Records paging:** `loadRecordsPage(g, begin)` → `POST routePath(state,'Records',begin,cap)` with `buildRecordsBody(state)` → `RecordsPage` (bare array). Not a facet request; does not touch `Envelope`. `X-Retold-Facet-Records-Dropped` shown when present.
- **Count check:** `verifyCount(g)` → `POST routePath(state,'Count')` → `CountCheck = { Count, Total: Envelope.Total, Agrees: Count === Total }`.
- **Describe:** `describe(domain, cb)` → `GET <prefix>/1.0/Facet/Describe`, single-flight per `(domain, principal)` → `AppData.FacetCapabilities[domain]`; errors are reported, not cached.
- **Version cache (never caches errors):** key `Facet-Selection.requestKey(domain, principal, method, path, body)` → `{ ETag, Body }` (Map, LRU `MaxCache` 60). A request whose key is cached sends `If-None-Match: <ETag>`; a **304** returns the cached body (`NotModified: true`); a **200** replaces the entry; any other status **deletes** it. The server's Version hashes the computed answer, the principal's scope values and BindHash, so a 304 is never stale or cross-principal. Applies to Query, Records and Describe (Count too).
- **Log:** every call appends an Exchange (§4.2) and bounds the list.

### 4.4 Routing and pages

Hash routes `#/Projects`, `#/Documents`, `#/LabForms`, `#/Bookstore` (pict-router, wired). The LabForms A/B tabs are page state (`AppData.FacetDemo.ActiveTab.LabForms`), not routes. Default `#/Projects`.

### 4.5 Views

| View id (file) | Renders into | Model | Handlers (inline, `_Pict.views['<id>'].…`) |
|---|---|---|---|
| `FacetDemo-Layout` | `#FacetingDemo-Application-Container` (shell), `#FD-Header` (renderable `FacetDemo-Header`) | `AppData.FacetDemo` | `Pict.PictApplication.navigateTo(route)`, `.setPrincipal(key)` (select `onchange`), `.toggleTheme()` |
| `FacetDemo-Page` | `#FD-Page` → `#FD-Page-Head`, `#FD-Tabs`, `#FD-Top`, `#FD-Rail`, `#FD-Main`, one `<section class="fd-card" id="FD-P-<Group>-<FacetKey or Widget>">` per panel | page def + group states | `selectTab(hash)` |
| `Facet-Scope` | its panel | `Groups[g].Widgets.Scope` | `toggleScope(g, scope)`, `toggleParamValue(g, scope, param, valueIndex)` |
| `Facet-Terms` | its panel | `Groups[g].Widgets[key]` | `toggleBucket(g, key, index)`, `clear(g, key)`, `toggleExpanded(g, key)` |
| `Facet-Histogram` | its panel | `Groups[g].Widgets[key]` | `beginDrag(event, g, key, index)` (pointerdown), `hover(g, key, index)`, `setInterval(g, key, interval)`, `clear(g, key)` |
| `Facet-Pivot` | its panel | `Groups[g].Widgets[key]` | `pickCell(g, key, rowIndex, columnIndex)`, `pickHeader(g, key, 'Row'\|'Column', index)` |
| `Facet-Records` | its panel | `Groups[g].Widgets.Records` | `page(g, -1\|1)`, `sortBy(g, columnIndex)`, `verifyCount(g)` |
| `Facet-Inspector` | `#FD-Inspector` | `AppData.Facet.Log`, `.Inspector` | `toggleOpen()`, `select(id)`, `selectTab(tab)` |
| `FacetDemo-Compare` | its panel | `Groups.LabFormsB.Widgets.Compare` | `clearVariantA()` |

Each widget view exposes `renderPanel(pPanel)` (`pPanel` = the layout entry + `PanelID`): build the display model at its address, then `this.render('<id>-Panel', '#' + PanelID, '<the model address>')`. Handlers pass **bucket indices**, never keys (keys are typed: `9` vs `'9'`, `''`), and re-read the bucket from `state.Envelope`. The page view calls `renderPanel` for every panel after it renders and on every `subscribe` notification of its groups. Pict rules apply: templates in `Templates`, iteration with `{~TS:~}`, conditionals as one-or-zero element arrays, no HTML in AppData, inline handlers, `ContentAssignment` for DOM, `injectCSS()` in `onAfterRender`, `{~I:Name~}` icons (no inline SVG, no emoji, no unicode arrows; available: Check, Close, ChevronUp/Down/Left/Right, ArrowUp/Down, Info, Warning, Error, Success, Refresh, Search, User, Lock, Eye, Code, Copy, More…). The one allowed `addEventListener` is the histogram drag (window `pointermove` / `pointerup`, added on pointerdown, removed on pointerup), as in the Sluice widget.

---

## 5. Client contract: bodies and write-back

### 5.1 Bodies (`Facet-Selection.js`, frozen)

- `buildQueryBody(state)` → `{ Scopes?, Clauses, Facets, Total, Records? }`: Scopes = the ON scopes in insertion order (`Params` only when non-empty); Clauses = `BaseClauses` then each facet's selection in `Facets` order, each stamped `Hash: '<Group>-<FacetKey>'` (so `Filter.Applied` and every facet's `Excluded` name the selection, e.g. `Excluded: ["Projects-Status"]`); Facets verbatim; `Total` from the group; `Records: { Begin, Cap, Sort? }`.
- `buildRecordsBody(state)` → `{ Scopes?, Clauses, Records?: { Sort }, Experience: {} }` (the recordset's `FilterEndpointOverride` body plus the faceting filter inputs).
- `routePath(state, 'Query' | 'Records' | 'Count', begin?, cap?)` → `/1.0/Facet/<Entity>[/Scope/<RouteScope>]/Query | /Records/<b>/<c> | /Records/Count`. The browser prefixes `/api/<Domain>`.

### 5.2 Write-back (why the list and the bucket agree)

A widget never invents a clause. It copies the `Clause` the server put on a bucket of the **current** envelope and changes only its `Values`:

| Widget gesture | Helper | New selection |
|---|---|---|
| Terms row / chip toggle | `toggleTermsKey(facet, current, index)` | the clicked bucket's Clause, `Values` = the selected keys in bucket order (works for `DistinctSelectedValueList`, `InternalJoinSelectedValueList`, `InternalJoinMatch` — compiled as OR of EQ —, `ExternalJoinSelectedValueList`); empty → `null` |
| Histogram bar click | `rangeClause(facet, i, i)` | bucket i's own Clause (`DateRange`, `NumericRange`, `InternalJoinDateRange`, `InternalJoinNumericRange`); clicking the only selected bar again → `null` |
| Histogram drag i..j | `rangeClause(facet, i, j)` | bucket min(i,j)'s Clause with `Values { Start: first.Start, End: last.End }`, last bucket's `EndExclusive` |
| Pivot cell | `pivotCellSelections(env, rowFacet, colFacet, K1, K2)` | the two 1-D facets' own single-key bucket Clauses, via `setSelections` (one POST) |
| Pivot row/column header | `termsClause(bucket.Clause, [key])` of that 1-D facet | that facet only |
| Clear | — | `null` |

The facet then excludes its own selection (`Exclude: 'Self'`, the default for Terms and histograms), so a checked box never drives its siblings to zero, and the server marks the selected buckets `Selected: true` (the widget highlights from `Selected`; local state only during a drag). Selected keys that fall out of `Top` come back as selected-zero buckets (`Count: 0, Selected: true`) and stay listed. Validated round trips: §2.5 item 7.

### 5.3 Selection-only buckets

`Clause: null` on a bucket (Projects `MyOverdue` ChildRollup bands, LabFormsA `Queue` (2-hop path) and `Started` (ExistsSplit), every LabFormsB facet (TuplePivot), Books `ReviewRating` (multi-valued K9), `ReviewCount`, `FiveStar`; the Pivot fold itself) means the count is not a count of route-entity rows a list clause can select. Selections (`FacetSelection`) are not in M2 (422), so these render **display-only**: no pointer cursor, no hover lift, a muted "Selection-only" pill in the card header with the tooltip "No list clause can select exactly these rows (Clause: null). Selections arrive in a later milestone."

### 5.4 Errors

| Where | Shape | UI |
|---|---|---|
| whole request (HTTP ≠ 200) | `{ Error: { Code, Status, Message, Detail } }` | page banner (error tone): `Code · Status`, Message, `Detail` as compact JSON, a hint; widgets show "Unavailable"; records empty |
| one facet | `Envelope.Errors[Key] = { Code, Status, Message, Detail? }` | inline in that card: code + message; `FACET_INTERVAL_TOO_FINE` shows a button "Use <Detail.Suggest.Interval>" → `setFacetOption` |
| demo host | `DEMO_UPSTREAM_UNAVAILABLE` (502), `DEMO_NOT_FOUND`, `DEMO_NETWORK` (fetch failed) | same banner |

Hints by code: `FACET_UNAUTHENTICATED` → "No session. Pick a signed-in user in the DEMO switcher (top right)."; `FACET_PARAM_INVALID` → "A scope parameter is invalid (Detail names it). For My projects, pick at least one role."; `FACET_FORBIDDEN` → "This principal may not facet an entity the request reads."; `FACET_UNKNOWN_SCOPE` → "The scope is unknown or not visible to this principal."; default → the Message. Real examples:

```json
{ "Error": { "Code": "FACET_UNAUTHENTICATED", "Status": 401, "Message": "Authentication required." } }
{ "Error": { "Code": "FACET_PARAM_INVALID", "Status": 400, "Message": "A parameter is invalid.", "Detail": { "Scope": "Project.MyProjects", "Param": "Roles", "Reason": "Type" } } }
"Errors": { "ByMonth": { "Code": "FACET_INTERVAL_TOO_FINE", "Status": 422, "Message": "The interval produces too many buckets.", "Detail": { "Interval": "day", "MaxDateBuckets": 400, "Suggest": { "Interval": "week" } } } }
```

Deliberate error states reachable from the UI: Anonymous (401 everywhere); deselect the last Roles chip (400 `FACET_PARAM_INVALID`); Documents interval "day" (per-facet 422 with the suggestion button).

Empty states: Total 0 → the summary says "0 projects", Records shows "No projects match this filter" + "Try removing a filter, adding a role, or switching user"; a facet with no buckets shows "No values under this filter"; user44 produces both everywhere except Documents and Books.

---

## 6. The four pages (exact requests)

Initial bodies as built by `buildQueryBody(initialGroupState(Groups.<G>))`. Facet specs and initial selections live in `FacetDemo-Pages.js`.

### 6.1 Projects for me (E1, ProjectTrack, group `Projects`)

```
POST /api/ProjectTrack/1.0/Facet/Project/Query
{
	"Scopes": [ { "Scope": "Project.MyProjects", "Params": { "Roles": [ "Owner", "Lead" ] } }, { "Scope": "Project.HasMyOverdue" }, { "Scope": "Project.Unblocked" } ],
	"Clauses":
	[
		{ "Type": "DistinctSelectedValueList", "FilterByColumn": "Status", "Values": [ "Active", "AtRisk" ], "FilterKey": "Status", "ClauseKey": "DistinctSelectedValueList", "Hash": "Projects-Status" },
		{ "Type": "DistinctSelectedValueList", "FilterByColumn": "IDClient", "Values": [ 3, 9 ], "FilterKey": "IDClient", "ClauseKey": "DistinctSelectedValueList", "Hash": "Projects-Client" },
		{ "Type": "DateRange", "FilterByColumn": "StartDate", "Values": { "Start": "2026-01-01 00:00:00", "End": "2027-01-01 00:00:00" }, "EndExclusive": true, "FilterKey": "StartDate", "ClauseKey": "DateRange", "Hash": "Projects-Started" }
	],
	"Facets":
	[
		{ "Key": "Status", "Facet": "Project.Status", "Top": 10 },
		{ "Key": "Client", "Facet": "Project.IDClient", "Top": 20 },
		{ "Key": "Started", "Facet": "Project.StartDate", "Interval": "month" },
		{ "Key": "MyOverdue", "Facet": "Project.MyOverdueBand" },
		{ "Key": "StatusByClient", "Facet": [ "Project.Status", "Project.IDClient" ], "Fold": "Pivot", "Top": 10 }
	],
	"Total": true,
	"Records": { "Begin": 0, "Cap": 25, "Sort": [ { "Field": "StartDate", "Dir": "DESC" } ] }
}
→ 200  Total 6 · Status 7 (Active 4*, AtRisk 2*, OnHold 1) · Client 8 (Cobalt Works 3*, Iris Media 3*, 11: 1, 13: 1) · Started 8 (13 month buckets, Missing 1) · MyOverdue bands None 0, 1–2 3, 3–9 2, 10+ 1 · pivot 4 cells · 6 records
```

(08 §2.2 writes the Client clause as `InternalJoinSelectedValueList`; the demo starts from the bucket-shaped `DistinctSelectedValueList` the Client widget writes back. Both are owned by FilterKey `IDClient`; the answer is the same here.)

| Panel | Widget | Gesture → write-back |
|---|---|---|
| Top | Scope: MyProjects (Roles chips Owner / Lead / Member / Reviewer), HasMyOverdue, Unblocked, ManyOverdue (from Describe; ManyOverdue off) | `setScope` |
| Rail | Terms Checklist `Status` | DSVL on Status |
| Rail | Terms Checklist `Client` (labels: Cobalt Works, Iris Media; unresolved `11`, `13` shown muted "#11") | DSVL on IDClient |
| Rail | Terms Bars `MyOverdue` "My overdue tasks" (ChildRollup; Selection-only) | — |
| Main | Histogram `Started` (month; intervals week/month/quarter/year) | DateRange (click / drag) |
| Main | Pivot `StatusByClient` (rows Status, columns Client labels, heat cells, marginals) | cell → Status + Client |
| Main | Records (Project, Status, Start date, Client [label], Owner, ID), sorted StartDate DESC | sort / page / verify |

Teaching moments: toggling OnHold moves Total 6 → 7 while the Status card's own counts do not change (disjunctive; `Excluded: ["Projects-Status"]`); switching to user43 shows 0 until the "Member" role chip is added and "Has my overdue tasks" is switched off (2; Member alone stays 0: Mo has no overdue tasks on those projects); switching to user81 shows tenant 8's single project.

### 6.2 Documents by form type (E2, ProjectTrack, group `Documents`)

```
POST /api/ProjectTrack/1.0/Facet/Document/Query
{
	"Clauses":
	[
		{ "Type": "DistinctSelectedValueList", "FilterByColumn": "IDFormType", "Values": [ 4 ], "FilterKey": "IDFormType", "ClauseKey": "DistinctSelectedValueList", "Hash": "Documents-ByForm" },
		{ "Type": "DateRange", "FilterByColumn": "DocumentDate", "Values": { "Start": "2026-01-01 00:00:00", "End": "2026-07-01 00:00:00" }, "EndExclusive": true, "FilterKey": "DocumentDate", "ClauseKey": "DateRange", "Hash": "Documents-ByMonth" }
	],
	"Facets": [ { "Key": "ByForm", "Facet": "Document.IDFormType", "Top": 20 }, { "Key": "ByMonth", "Facet": "Document.DocumentDate", "Interval": "month" }, { "Key": "Status", "Facet": "Document.Status" } ],
	"Total": true,
	"Records": { "Begin": 0, "Cap": 25, "Sort": [ { "Field": "DocumentDate", "Dir": "DESC" } ] }
}
→ 200  Total 41 · ByForm 194 over 13 buckets (Form D 41* first, Form G 17, …; Excluded ["Documents-ByForm"]) · ByMonth 154 over 24 months (Jan–Jun 2026 Selected) · Status 41 (Final 22, Draft 10, Archived 8, '' 1)
```

| Panel | Widget | Gesture → write-back |
|---|---|---|
| Rail | Terms Checklist `ByForm` "Form type" (labels Form A…L; dangling `99` muted) | DSVL on IDFormType — selecting Form D keeps every other form's count (disjunctive) |
| Rail | Terms Chips `Status` (`''` shown "(blank)") | DSVL on Status |
| Main | Histogram `ByMonth` "Document date": click a month, drag a range; intervals day/week/month/quarter/year | DateRange; "day" → per-facet 422 + "Use week" |
| Main | Records (Title, Date, Status, Form type [label], Project, ID) | sort / page / verify |

### 6.3 Lab forms I still have to fill out (E3, LabTrack, groups `LabFormsA` / `LabFormsB`)

Tab **A — stored requirements** (default; the work list's named scope as a ROUTE scope, so `Total == ToDo.Total == Records/Count`):

```
POST /api/LabTrack/1.0/Facet/MaterialIntakeRequirement/Scope/MaterialIntakeRequirement.ToDoForMe/Query
{
	"Clauses": [],
	"Facets":
	[
		{ "Key": "ToDo", "Facet": "MaterialIntakeRequirement.MyFormsToDo", "Top": 20 },
		{ "Key": "Queue", "Facet": "MaterialIntakeRequirement.MyFormsToDo/ByQueue" },
		{ "Key": "Week", "Facet": "MaterialIntakeRequirement.MyFormsToDo/ByWeek" },
		{ "Key": "Discipline", "Facet": "MaterialIntakeRequirement.MyFormsToDo/ByDiscipline" },
		{ "Key": "Started", "Facet": "MaterialIntakeRequirement.MyFormsToDo/Started" }
	],
	"Total": true,
	"Records": { "Begin": 0, "Cap": 25, "Sort": [ { "Field": "IDMaterialIntake", "Dir": "ASC" } ] }
}
→ 200  Total 237 · ToDo 11 form types (Lab Form H 41, B 40, E 33, …) · Queue Receiving 136 / Wet Lab 101 · Week 40 weekly buckets · Discipline Physics 84, Chemistry 47, Biology 46, Materials 44, '' 16 · Started 47 / Not started 190
Later pages:  POST …/Scope/MaterialIntakeRequirement.ToDoForMe/Records/<Begin>/25   { "Clauses": [ … ], "Records": { "Sort": … }, "Experience": {} }
              = the pict-section-recordset FilterEndpointOverride 'Facet/MaterialIntakeRequirement/Scope/MaterialIntakeRequirement.ToDoForMe/Records'
```

Bucket clauses as the server sends them (every A facet is `Relaxed: true`, `Semantics: 'NoVisibleMatch'` — show a "Relaxed" badge with the tooltip "A form completed by any technician in my lab counts (TenantOnly hop)"):

```json
ToDo:       { "Type": "DistinctSelectedValueList", "FilterByColumn": "IDLabFormType", "Values": [ 8 ], "FilterKey": "IDLabFormType", "ClauseKey": "DistinctSelectedValueList" }
Discipline: { "Type": "InternalJoinMatch", "RemoteTable": "LabFormType", "JoinInternalConnectionColumn": "IDLabFormType", "JoinExternalConnectionColumn": "IDLabFormType", "ExternalFilterByColumns": [ "Discipline" ], "ExactMatch": true, "Values": [ "Physics" ], "FilterKey": "MaterialIntakeRequirement.MyFormsToDo/ByDiscipline", "ClauseKey": "InternalJoinMatch" }
Week:       { "Type": "InternalJoinDateRange", "RemoteTable": "MaterialIntake", "JoinInternalConnectionColumn": "IDMaterialIntake", "JoinExternalConnectionColumn": "IDMaterialIntake", "ExternalFilterByColumns": [ "ReceivedDate" ], "Values": { "Start": "2025-12-29 00:00:00", "End": "2026-01-05 00:00:00" }, "EndExclusive": true, "FilterKey": "MaterialIntakeRequirement.MyFormsToDo/ByWeek", "ClauseKey": "InternalJoinDateRange" }
Queue, Started: Clause null (Selection-only)
```

| Panel | Widget | Gesture |
|---|---|---|
| Rail | Terms Checklist `ToDo` "Form type" | DSVL on IDLabFormType (click Lab Form H → Total 41, Records/Count 41) |
| Rail | Terms Chips `Discipline` | InternalJoinMatch (Physics → 84 == Records/Count) |
| Rail | Terms Bars `Queue` (Selection-only) | — |
| Rail | Terms Split `Started` (Started / Not started stacked bar; Selection-only) | — |
| Main | Histogram `Week` (week buckets; axis labels `MM-DD`, tooltip "Week of 2026-01-05 · 8") | InternalJoinDateRange click / drag (weeks 0..4 + Physics → 8 == Records/Count) |
| Main | Records "My work list" (Requirement, Intake, Form type [label from ToDo], Created) | page / sort / verify |

Tab **B — implied by configuration (TuplePivot)**:

```
POST /api/LabTrack/1.0/Facet/MaterialIntake/Query
{ "Clauses": [], "Facets": [ { "Key": "ToDo", "Facet": "MaterialIntake.FormsToDo", "Top": 20 }, { "Key": "Queue", "Facet": "MaterialIntake.FormsToDo/ByQueue" }, { "Key": "Week", "Facet": "MaterialIntake.FormsToDo/ByWeek" } ], "Total": false }
→ 200  (no envelope Total) · ToDo 224 (CountMode KeyDistinct: distinct (intake, form type) tuples) · Queue Receiving 125 / Wet Lab 99 · Week 40 buckets · every bucket Clause null
```

B is display-only (TuplePivot facets have no list clause and TuplePivot Records are a later milestone). The page summary shows `ToDo.Total` ("224 forms to do") with a `KeyDistinct` badge. Main shows **Compare** (A vs B by form type: Label, A, B, Δ = B − A, a check where they agree, a totals row 237 vs 224) and the B week histogram; Rail shows B's ToDo and Queue as bars. Note under the table: "A counts stored requirement rows; B derives the same question from the material type configuration (MaterialTypeFormRequirement). They agree where the stored rows match the configuration; this seed diverges on purpose in places, so Δ is not always zero." (Measured: user42 A 237 / B 224, user43 172 / 157, user81 60 / 34; per form type some rows agree exactly, e.g. Lab Form F 26 / 26.) The A column uses `Groups.LabFormsA.Envelope` only when A has no selections (else "Clear the variant A filters to compare like for like" + button); if A never loaded for this principal, Compare calls `Facet.refresh('LabFormsA')`.

### 6.4 Bookstore explorer (Bookstore-Tenant + demo definitions, group `Books`)

```
POST /api/Bookstore/1.0/Facet/Book/Query
{
	"Clauses": [],
	"Facets":
	[
		{ "Key": "Genre", "Facet": "Book.Genre", "Top": 20 },
		{ "Key": "Language", "Facet": "Book.Language", "Top": 12 },
		{ "Key": "Type", "Facet": "Book.Type" },
		{ "Key": "Year", "Facet": "Book.PublicationYear", "Fold": "NumericHistogram", "Mode": "Edges", "Edges": [ 1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020, 2030 ] },
		{ "Key": "ReviewRating", "Facet": "Book.ReviewRating" },
		{ "Key": "ReviewCount", "Facet": "Book.ReviewCount" },
		{ "Key": "FiveStar", "Facet": "Book.HasFiveStar" }
	],
	"Total": true,
	"Records": { "Begin": 0, "Cap": 25, "Sort": [ { "Field": "Title", "Dir": "ASC" } ] }
}
→ 200  Total 1436 (tenant 8: 81) · Genre 14 · Language 10 (eng 862, en-US 271, '' 108, …; Missing 27) · Type 4 · Year 8 decade buckets (1950–1959 92 … 2010–2019 477, 2020–2029 0; Other 41, Missing 33)
       ReviewRating MultiValued PivotDistinct (4: 988, 5: 931, 3: 723, 2: 427, 1: 239; Σ 3308 > Total; Missing 65) · ReviewCount None 65, 1–2 467, 3–4 463, 5–9 380, 10+ 61 · FiveStar 931 / 505
Scope toggle on:  "Scopes": [ { "Scope": "Book.WellReviewed" } ]  → Total 1250
```

"From Describe": card titles and fold badges come from `AppData.FacetCapabilities.Bookstore.Entities.Book.Facets` (auto facets: `DisplayName`; declared: `Title`), the scope bar from `…Book.Scopes`. Why Edges for the year: the fixture has a −1750 outlier that stretches Nice buckets to 200 years; the card shows "Other 41 (outside 1950–2030) · Missing 33".

| Panel | Widget | Gesture |
|---|---|---|
| Top | Scope: Book.WellReviewed | `setScope` |
| Rail | Terms Checklist `Genre`; Chips `Language` (`''` = "(blank)"); Chips `Type` | DSVL |
| Rail | Terms Bars `ReviewRating` (badge "Multi-valued: a book counts once per distinct rating; Σ may exceed the total"), Bars `ReviewCount`, Split `FiveStar` — all Selection-only | — |
| Main | Histogram `Year` (Edges; numeric labels "1950–1959") | NumericRange click / drag (2000–2019 + WellReviewed → 614) |
| Main | Records (Title, Genre, Language, Type, Year, ID) | sort / page / verify |

Stretch (P2, only after everything else): an "Add facet" select listing the Book facets Describe offers that the group lacks (CreateDate, UpdateDate, ISBN): appends `{ Key: <Field>, Facet }` (default fold / interval) through a new provider method `addFacet(g, spec)` and a panel (Terms → Rail Checklist, histogram folds → Main) in `AppData.FacetDemo.ExtraPanels.Bookstore`.

---

## 7. Widget specs

### 7.1 Layout + header

Sticky app header under the static `.pict-example-header`: left, four nav pills (`NavLabel`; active = filled accent-soft with accent text); right, the switcher block: a small uppercase **DEMO** badge (`--fd-demo` on `--fd-demo-soft`, tooltip §3.1), "Signed in as", a `<select>` of personas ("User 42 · tenant 7"), and under it the persona's note for the active page's domain (e.g. "Lena Lead: Owner / Lead on the story projects…"); then the theme toggle button ("Dark" / "Light" text + `{~I:Eye~}`). Footer line in the page (muted): "3 domains · SQLite · Small seed · retold-faceting-service M2" from `/api/Demo/Status`.

### 7.2 Page head

Title (22px semibold), the question (muted, italic), the design reference (faint, small). The **summary strip**: the Total in 28px tabular numerals + noun ("6 projects"; LabForms B: ToDo.Total), then chips: `Live` (Engine), `Exact` (check icon) or `Approximate`, `14 ms server · 22 ms round trip`, `ETag fv1:85dd…` (monospace, first 8 hex), `304 from cache` when NotModified, `1 POST` (the exchange count for the last filter change). Loading: a 2px indeterminate accent bar on top of the head and cards at 60 % opacity (keep the previous envelope visible while Loading; on Error clear it). Error: the banner of §5.4 replaces the strip.

### 7.3 Facet-Scope

A horizontal row of toggle chips (a switch track + label "My projects", "Has my overdue tasks", "Unblocked", "Many overdue", "Well reviewed": the scope name after the dot, de-camel-cased, or a `Labels` map on the panel if you prefer); Description as the tooltip; a "Relaxed" badge when Describe says so. An ON scope with `Params` shows its EnumList values as small chips right after it (selected = filled). Scope missing from Describe for this principal → hidden.

### 7.4 Facet-Terms

Card: header = title (panel `Title` else FacetResult `DisplayName`), badges (fold when not Terms, "Selection-only", "Multi-valued", "Relaxed", "KeyDistinct"/"PivotDistinct", "Top 20 of 31" when `Truncated`), a "Clear" link when the facet has a selection. Body by Display:

- **Checklist:** one row per bucket: checkbox (accent when checked), label (ellipsis; `''` → "(blank)" italic; unresolved FK label → "#11" muted), right-aligned count (tabular numerals, `toLocaleString`), a 3px bar under the label proportional to `Count / max` (accent-soft; selected rows accent). Zero-count rows muted; selected-zero rows checked and muted. Collapse after `Collapse` rows with "Show all 14" / "Show fewer".
- **Chips:** wrap of pills "Label  count"; selected pills filled accent with accent-text.
- **Bars:** label left (120px), bar (flex, ∝ count), count right; clickable only if the bucket has a Clause.
- **Split:** one 14px stacked bar (first bucket accent, second bar color) with a two-item legend "Started 47 · Not started 190".

Footer (small, muted): "Missing 3 · Other 0" when non-zero; "Σ 3308 across 1436 books" for MultiValued.

### 7.5 Facet-Histogram

Card header: title, badges, interval segmented control (panel `Intervals`, current = spec Interval), Clear. Chart: 140px bar area, bars as flex children (gap 2px; 1px above 60 bars; 0 above 150), each a full-height transparent hit column (`<button>`, aria-label "Mar 2026: 12") with the colored bar at the bottom (height ∝ Count / max, min 2px when Count > 0; zero buckets show a 1px `--facet-bar-zero` baseline). Colors: unselected `--facet-bar`, hover `--facet-bar-hover`, `Selected` `--facet-bar-selected`, drag preview `--facet-bar-preview`, Selection-only `--facet-bar-disabled` (no hover). Axis under the bars: first, last and every k-th label (k = ceil(N / 8)): month → server `Label` ("Mar 2026"), week → `Start` as `MM-DD`, day → `MM-DD`, quarter/year/numeric → `Label`. Readout line above the chart: hovered bucket "Week of 2026-01-05 · 8", else the selection "Selected Jan 2026 – Jun 2026 · 41" or "Click a bar, or drag across bars to select a range". Footer: "Missing 1 · Other 0". Drag: pointerdown on bar i records it, window pointermove maps clientX to a bar index (preview classes, no re-render), pointerup writes `rangeClause(i, j)` (or toggles a single bar). Touch works through pointer events (`touch-action: none` on the bar area).

### 7.6 Facet-Pivot

Table: corner "Status \ Client", column headers (Client labels from the Client facet), row headers (Status), cells with `rgba(var(--facet-heat), 0.08 + 0.6 × count / max)` background and the count (zero → faint "·"), a marginal column ("Total") and row, the grand total in the corner cell. Clickable cells and headers per §5.2 (hover outline accent). Selected row/column keys (from the 1-D facets' Selected) get an accent underline.

### 7.7 Facet-Records

Card header: title + "1–25 of 237" + "Verify with Records/Count" button → badge "Records/Count 237 = Total" (ok tone, `{~I:Check~}`) or "Records/Count 236 ≠ Total 237" (error tone). Table: sticky header (click sorts; current sort shows `{~I:ChevronUp~}` / `{~I:ChevronDown~}`), zebra rows, `Format: 'DateTime'` → `YYYY-MM-DD HH:mm`, null → "—", `LabelFacet` → "Iris Media · 9", `Align: 'Right'` + tabular numerals. Pager: Prev / Next (disabled at the ends; `Begin + Cap ≥ Total`). A small note: "Rows come from POST …/Records with the same filter as the facets: one compiler, so the list and the counts agree." Empty: §5.4.

### 7.8 Facet-Inspector

Bottom drawer, fixed, full width. Collapsed 40px bar: `{~I:Code~}` "Request / envelope" + the last exchange summary "POST /1.0/Facet/Project/Query · 200 · 22 ms · fv1:85dd…" + chevron. Open: 45vh, two panes: left list (newest first; kind badge, group, status chip colored by class, `304`, `superseded`, ms), right detail with tabs **Request** (method + browser URL, upstream path, headers, body via `{~JSV:~}`), **Envelope** (status, ETag/Version, ModelVersion, Engine, Exact, client ms / server ElapsedMS / proxy Server-Timing, demo session, a facet table: Key · Fold · Disjunctive · Excluded · KeptMixed · CountMode · Total · Σ · Missing · Other · flags · error; Filter.Applied; Warnings; Errors), **Raw** (`{~JSV:~}` of the response; long bucket arrays are fine). Monospace blocks on `--facet-code-bg`. The page gets `padding-bottom: 56px` so the collapsed bar never covers content.

### 7.9 FacetDemo-Compare

§6.3. A compact table (Label, A, B, Δ) with Δ colored (0 ok-tone check, ≠ 0 muted signed number), sorted by A desc; totals row; the explanatory note.

---

## 8. Visual design

### 8.1 Layout

```
┌ .pict-example-header (static) ───────────────────────────────────────────────────────────────┐
├ app header (sticky): [Projects for me][Documents by form type][Lab forms…][Bookstore]   DEMO  Signed in as [User 42 · tenant 7 ▾]  [Dark] │
│                                                                              Lena Lead: Owner / Lead…                     │
├ page head: Projects for me — question — ref     [ 6 projects ] Live · Exact · 14 ms · ETag fv1:85dd… · 1 POST              │
├ scope bar: (●) My projects [Owner][Lead][Member][Reviewer]  (●) Has my overdue tasks  (●) Unblocked  ( ) Many overdue      │
├──────────── rail 320px ────────┬──────────────────── main (1fr) ──────────────────────────────────────────────────────────┤
│ Status        Clear            │ Start date by month           [week|month|quarter|year]  Clear                           │
│ [x] Active ▬▬▬▬▬ 4             │  ▂ ▁ ▃ ▅ ▂ ▇ ▁ …  (140px bars)                                                            │
│ [x] AtRisk ▬▬ 2                │  Dec 2025            …            Dec 2026                                               │
│ [ ] OnHold ▬ 1                 ├───────────────────────────────────────────────────────────────────────────────────────────┤
│ Client                         │ Status × Client   (heat grid with marginals)                                              │
│ My overdue tasks  Selection-only├───────────────────────────────────────────────────────────────────────────────────────────┤
│ None ░ 0 · 1–2 ███ 3 · …       │ Projects   1–6 of 6        [Verify with Records/Count]                                     │
│                                │ table …                                                       [Prev][Next]               │
└────────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────────┘
└ inspector bar (fixed bottom): Request / envelope · POST /1.0/Facet/Project/Query · 200 · 22 ms · fv1:85dd…            ▴ ┘
```

Shell max-width 1440px, side padding 24px, gap 16px; cards `--fd-surface`, 1px `--fd-border`, radius 10px, padding 14px 16px, `--fd-shadow`; card titles 13px semibold, `--fd-text`; meta 12px `--fd-text-muted`. Below 960px: one column (scope bar wraps, rail above main, header nav scrolls horizontally, the switcher drops under the nav).

### 8.2 Tokens (in `css/faceting-demo.css`, done)

`--fd-*` for the shell, `--facet-*` for widgets (every widget CSS rule reads only `--facet-*`, each with a hard fallback, e.g. `background: var(--facet-bar-selected, #3b5bdb)`, so the widgets lift unchanged and pict-section-facet maps `--facet-*` onto `--theme-color-*`). Light accent indigo `#3b5bdb`, dark `#7c93ff`; bars `#b4c2ea` / `#34416a`; ok/warn/error greens/ambers/reds with soft backgrounds; DEMO orange `#c2410c` / `#fb923c`; pivot heat as an RGB triplet `--facet-heat`. Typography: system UI 14px, tabular numerals (`font-variant-numeric: tabular-nums`) for every count, monospace for ETags, paths and JSON.

### 8.3 Light / dark

`index.html` sets `:root[data-fd-theme]` from `localStorage['retold-faceting-demo-theme']` before first paint; with no saved value `prefers-color-scheme` decides (the CSS handles both). `toggleTheme()` flips the attribute and persists (try/catch). No JS reads colors; everything is tokens.

### 8.4 Interaction polish

Hover states on every clickable thing (rows, chips, bars, cells, headers); focus-visible outlines (2px accent); `<button>` / `<input type=checkbox>` for every control (keyboard works; Space/Enter toggles); `cursor: default` and no hover on Selection-only buckets; transitions ≤ 120ms on color/opacity only (no layout animation on re-render). Counts never jump layout: fixed-width tabular count columns.

---

## 9. Verification

SERVER: `npm test` (§2.5) green; `npm start` prints the banner; `curl -s 127.0.0.1:19300/api/Demo/Principals`.

CLIENT (manual, in the browser at `http://127.0.0.1:19300/`, light and dark, and at 800px wide):

1. Projects loads with Total 6, Status Active/AtRisk checked, Client Cobalt Works / Iris Media checked, Jan–Dec 2026 highlighted, band None 0 / 1–2 3 / 3–9 2 / 10+ 1, pivot 4 cells, 6 records; the inspector shows exactly one Describe GET and one Query POST.
2. Check OnHold → one POST, Total 7, Status counts unchanged, "Verify" → 7 = 7. Then (OnHold still checked) drag Feb–Jul → Total 5 and those bars highlighted (from the initial state the same drag gives 4). Click the Active × Iris Media cell → Total 2. Repeat a previous state → the inspector shows `304`.
3. Switch to user43 → 0 + empty states; add the Member chip and switch "Has my overdue tasks" off → 2 projects (Member alone stays 0); deselect every role → `FACET_PARAM_INVALID` banner. Anonymous → `FACET_UNAUTHENTICATED` banner on every page. user81 → Projects 1, Books 81.
4. Documents: 41; uncheck nothing and check Form G → Form D's and every other form's counts stay (disjunctive); interval "day" → inline 422 with "Use week".
5. Lab forms A: 237; Lab Form H → 41 = Verify; Physics + a week drag → Verify agrees; Queue/Started not clickable with the Selection-only pill; tab B: 224 with KeyDistinct, Compare table A vs B with Δ.
6. Bookstore: 1436; Well reviewed → 1250; Year 2000–2019 drag → 614 with the scope on; Language "(blank)" works; ReviewRating shows the Multi-valued note.
7. No console errors; no `addEventListener` outside the histogram drag; no inline SVG / emoji in templates.

Definition-of-done mapping: one server + URL (§2.1) · four pages via nav (§4.4, §6) · scopes with param chips (§7.3) · terms with counts and selected-zero (§7.4) · clickable month histogram + drag (§7.5) · band facet (§6.1) · pivot (§7.6) · paged Records agreeing with Total (§7.7) · disjunctive Form type (§6.2) · E3 A + B (§6.3) · Describe-driven bookstore incl. numeric histogram and review rating (§6.4) · DEMO principal switcher changing counts (§3) · inspector (§7.8) · empty/error states with codes (§5.4) · one POST per filter change (§4.3) · bucket-Clause write-back (§5.2).

---

## 10. Out of scope / known limits (say so in the UI where relevant)

- Selections (`FacetSelection`, 422 in M2): Selection-only buckets are display-only (§5.3).
- TuplePivot Records (variant B has no list), keyset paging (Begin ≤ 10 000), Explain, SSE `/Changes`, read-your-writes: not in M2; the demo is read-only.
- `Freshness` / `Exact: false` never happens on the Live engine; the strip still renders the flag.
- The domain servers are the test harness: they trust `x-facet-test-*` headers. The loopback guard + the loopback-bound front server keep them private; never expose the demo on a network.
- PostgreSQL (`DEMO_PG=1`) is optional and uses the throwaway `rfs-test-postgres` container exactly as `npm run test:pg` does.

---

## 11. Polish round (after the UX and correctness review)

These rules supersede the earlier sections where they differ.

- **E3 variant B agreement (an intended change to the definition of done).** The seed does not let B reproduce A row for row, and the demo does not hide that. It leads with what the two variants agree on. Tab B's Compare panel splits every form type into *In both* (A − stored-only), *Stored only (A)* (A's work-list rows whose (material type, form type) no Required `MaterialTypeFormRequirement` row asks for) and *Configured only (B)* (B − In both). A callout states the totals (user42: 219 in both, 18 stored only, 5 configured only; 237 − 18 = 224 − 5) and names the two planted causes: random extra forms on intakes whose type requires fewer than three, and soft-deleted requirement rows. The breakdown's inputs (every A list row, the intakes' material types and the configuration) are read in `preparePanel`, never in `renderPanel`. The LabForms page loads both groups, so both tab counts show at once.
- **Histogram selection = the clause.** Each bar is classified against the selection's span (`Facet-Selection.bucketCoverage`): Full (drawn selected; it equals the server's `Selected`), Partial (hatched), or None. The readout gives the clause's span with an inclusive end, written the way the axis writes dates (`Facet-Display.rangeText`: "Jan – Jun 2026", "2026", "2000–2019"), plus the envelope Total. An interval change keeps the selection as it is. A click clears the selection only when the bar's own Clause *is* the selection (`sameRange`). The axis keeps the union of contiguous buckets seen for (principal, facet, interval), padded with zero bars that keep their server Clause. Ticks carry the year where it changes; minor ticks hide on a narrow card; counts show on the bars up to 24 bars, and a dashed max line shows beyond that.
- **Query bodies always ask for page 1** (`buildQueryBody` → `Records.Begin: 0`). The paging cursor lives only in `RecordsPage`, and `RecordsPage.Source` ('Query' | 'Records') drives the list footer.
- **The count check belongs to one answer.** `AnswerSeq` is the Seq of the applied flight. `CountCheck.AnswerSeq` is the answer whose Total it compared against. Any new Query clears the check. A Verify click while a Query is loading or coalescing waits for that Query (`_VerifyAfter`). A superseded count never leaves "Counting…" behind.
- **Lookups** (`Facet-Lookup.js`, provider `lookupForRows` / `fetchLookup` / `lookupRows`): related-row columns read through `POST /1.0/Facet/<Entity>/Records/<Begin>/500` with a key-list clause, under the same tenancy and personal scopes as the facets. They are display only, cached per principal, never cache errors, and are logged as `Lookup` exchanges. The LabForms work list shows intake, material, received date, queue, form type, discipline and Started; Started uses the Started facet's rule, and the smoke test proves that for every row. Projects shows client and owner names ("(you)" via `setPrincipalInfo`); Documents shows form type and project names.
- **Bookstore facets come from Describe** (`FacetsFrom: 'Describe'`, `FacetDemo-Pages.describedFacets`). The rules are Order, Skip, SkipAuditDates and Overrides (Edges for PublicationYear, `SortBy: 'KeyDesc'` for Review rating). The page head names what Describe offered but the page skipped.
- **Page head.** The question reads as the literal query. The design reference becomes a muted tooltip. Active-filter chips are removable. A "Try" line, a per-page `EmptyHint` and a `Note` (LabForms says Relaxed once, in info tone) complete it. "Show internals" toggles the contract vocabulary on the cards. The cards themselves show only reader-facing badges: Multi-select, Read-only, Overlapping, and Top n of m.
- **Inspector.** `setContext({ Label, Groups, Domains })` on every route and tab change. The drawer lists the page's exchanges, with an "All pages" toggle. The bar names the page's latest answer and marks it "kept" when the page was shown from state. Escape closes the drawer. `html[data-facet-inspector="open"]` gives the page bottom room. The Server-Timing header is parsed into a stacked bar; for a 304 it carries no service time.
- **Focus** survives re-renders (`data-focus-key` + provider `captureFocus` / `restoreFocus`).
- **Domain servers** listen on 127.0.0.1 only and get the loopback guard before they listen, through the harness's new `Host` and `BeforeListen` options. The boot window from §2.2 is gone.

## 12. Live changes (M4)

These rules extend the earlier sections; the contract is `docs/internal-contracts.md` §47 (and §39–§46 for the service side).

### 12.1 What the reader sees

Every page gets a dashed **Make a change** card under its scope bar. Each card makes one real write through the domain's stock meadow-endpoints CRUD route, as the persona. The page then updates itself: the server's change stream (`GET /1.0/Facet/Changes`) says the entity changed, and the provider refetches the cards that depend on it. There is no reload and no refresh after the write.

| Page | Card | Request (browser → front proxy → domain) | What moves (user42, Small seed) |
|---|---|---|---|
| Projects for me | Set the status of a listed project (Active / At risk / On hold / Done), Undo | `PUT /api/ProjectTrack/1.0/Project { IDProject, Status }` | the first listed project, Active → On hold: Total 6 → 5, Status Active −1, OnHold +1. Undo → 6 |
| Documents by form type | Add document (Draft, the first selected form type, dated 2026-03-15, the first listed document's project), Delete it, Undelete it | `POST …/1.0/Document`, `DELETE …/1.0/Document/<ID>`, `GET …/1.0/Document/Undelete/<ID>` | 41 → 42 (March +1, Draft +1); delete → 41; undelete → 42 |
| Lab forms (tab A) | Complete a started form, Re-open it | `PUT /api/LabTrack/1.0/LabForm { IDLabForm, Status: 'Complete', CompletedDate }`, then `{ Status: 'Pending', CompletedDate: null }` | the row leaves the work list: 237 → 236, Started −1; re-open → 237 |
| Bookstore explorer | Add a 5-star review, Remove it | `POST /api/Bookstore/1.0/Review { IDBook, Rating: 5, Text }`, `DELETE …/1.0/Review/<ID>` | 5-star books 931 → 932, one book moves from "No 5-star review" to "Has a 5-star review"; Total stays 1436 |

- **The started form.** The card looks for a Pending LabForm of the persona's that matches a work-list row (same intake and form type), so that row counts as Started. It checks the rows on screen first and then every row of the list, reading forms through the work list's own `LabForm` lookup. It then reads the form once more through `POST /1.0/Facet/LabForm/Records/0/1`, filtered on that intake, that form type and Status Pending. The personal scope makes that read return only the persona's own forms.
- **The reviewed book** is the first listed book that has no 5-star review yet. The card reads the listed books' reviews through the faceting Records route of `Review` (a Lookup exchange). The contract says only "the first listed book"; with this rule the 5-star counts always move. If every listed book already has a 5-star review, the card uses the first listed book. On the Small seed the first two books share a title ("A Bright Clock"); #1103 has a 5-star review and #1314 does not, so the review goes to #1314.
- **Without a stream** the card refetches its page's groups itself and says so. This happens on a host without M4, or when the stream was refused, for example for the anonymous persona.
- The card's head shows the stream status chip (Live / Reconnecting / Off), the same chip as the summary strip.

### 12.2 Provider (liftable, `Pict-Provider-Facet.js` + pure `Facet-Changes.js`)

- **`subscribeChanges(Domain)`** opens one stream per domain for the current principal; a second call reuses it. `loadPage` subscribes to every domain of the page. A principal switch calls `closeChanges()` first, so streams always belong to the persona on screen.
- **Transport.** The demo uses `fetch()` with a stream reader (`ChangesTransport: 'Fetch'`), because the persona travels in `X-Retold-Facet-Demo-Principal` and `EventSource` cannot send headers. `Facet-Changes.createParser` parses the stream. It handles chunk splits and CR / LF / CRLF line ends, skips comments, keeps `retry:` and `id:`, and drops data-less blocks the way the HTML rules do. A cookie-session host gets `EventSource` with `'Auto'`. No persona or ID ever goes into a URL.
- **Reconnects.** The stream reconnects with jittered backoff: the server's `retry:` (itself jittered) doubled per attempt, at most 30 s, then × [½, 1], so streams cut together do not come back together. A `closed` event reconnects too: `Revalidate` (the server ends every stream at its revalidation time so the client re-authenticates) at once, `Shutdown` with backoff. Some answers stop it until the next principal change: 401 / 403 / 429, or 404 / 405 / 501 (no stream on this host). An SSE-triggered refetch first waits a random 0–150 ms (`ChangeJitterMS`). `AppData.Facet.Changes[Domain]` records `{ Status, PrincipalKey, LastSeq, LastEventAt, Events, Reconnects, Reason, Error, NodeEpoch, Transport }`.
- **`generation(Entity, Seq)`** first drops the principal's lookup rows of that entity. It then refetches every group of the domain whose last envelope's `DependsOn` names the entity (`groupsToRefetch`). A group whose answer has no `DependsOn` is refetched for any change of its domain, because it cannot rule anything out. A group that is on screen (`setGroupVisibility`: the active page's groups, both LabForms tabs) is refetched through the usual per-group coalescing: one POST per group per tick, `If-None-Match` from the Version cache, `Freshness.MinSeq: Seq`, and the trigger `"Live update: Project @ e:…:15"` on the exchange. A group of another page is marked (`ChangedSince`, so `isStale` is true) and refetched with that MinSeq when it is shown.
- **`ready` and `model`.** A `ready` after the first one (a reconnect; events are not replayed) refetches every group of the domain, and so does `model`. Every event is logged as an exchange of Kind `Change`.
- **Freshness.** Every Query sends `Freshness: { Mode: 'Bounded', MaxLagMS: 5000 }` (`Facet-Selection.DEFAULT_FRESHNESS`). `Freshness` is not part of the client's Version-cache key, matching the server, so an SSE refetch revalidates the answer it replaces.
- **Stale answers.** An answer that comes back `Stale: true` is fetched once more after `StaleRefetchMS` (1 s), at most 3 times in a row, so the page converges without an event. This covers, for example, user43 opening Documents right after user42's write.
- **`write(Domain, Method, Path, Body)`** is a host write. It is logged as an exchange of Kind `Write`, never cached, and Ok for any 2xx.

### 12.3 Page and inspector

- **Summary strip.** The strip shows "Stale · 1.2 s old" instead of Exact for a Stale answer. It also shows `Cache: Hit | Miss | Stale | NotModified | Bypass | Off` (the `X-Retold-Facet-Cache` header), the freshness the server applied (`Exact ↑ MinSeq`, `Exact ↑ ReadYourWrites`), the trigger chip ("Live update: Project"), and the stream chip. The `X-Retold-Facet-Seq` chip appears with "Show internals". 304s keep "304 from cache".
- **Inspector list.** It holds `Change` exchanges (event, entity, which groups it refetched or marked) and `Write` exchanges. A refetch has a `live` flag and the cache header as a flag.
- **Envelope tab.** Adds Cached, Stale (+ LagMS), AsOf, DependsOn, the three `X-Retold-Facet-*` headers and the trigger. For a `Change` it shows the event data, which is only `{ Entity, Generation, Seq }`.
- **Inspector bar.** Names the stream state of the page's domains ("stream: Bookstore live").

### 12.4 Host

- **Domain options.** Every domain runs with `Faceting: { Cache: { Enabled: true, ExposeStatus: true }, Freshness: { SeqHeader: true }, SSE: { IncludeSeq: true } }` (`Faceting-Demo-Domains.FACETING_OPTIONS`); the change intake and the rest of the stream use their defaults. The demo may turn the cache on because every write reaches the intake in this one process: the only writes are the cards' CRUD calls, whose behavior dispatcher and DAL writes the interim intake wraps. `ExposeStatus`, `SeqHeader` and `IncludeSeq` are demo-only (the inspector shows the cache status and the Seq); a multi-tenant deployment keeps their defaults, which hide both on a policy host.
- **Write guards.** `Faceting-Demo-Writes.installWriteGuards` runs after boot and chain-wraps through `harness.installBehavior`, on every entity:
  - `Create-PreOperation` stamps the tenant column (`IDCustomer`, or `IDTenant` for the Bookstore), and `OwnerIDUser` on LabForm, from the session, and refuses with 403 a body that names another tenant or owner.
  - `Create-PreOperation` also reads every foreign key (`ID<Table>` of another table: `IDProject`, `IDBook`, `IDFormType`, …) and refuses with 403 one whose row is not in the session's tenant (a shared lookup: does not exist).
  - `Update-`, `Delete-` and `Undelete-PreOperation` refuse with 403 a row outside the session's tenant (or owner, on LabForm), an update that would move a row out of them, and a row the persona does not own (`OWNERSHIP_RULES`): a Project it is not an active member of, a Document it neither wrote nor is an active member of the project of, a Review it did not write.
  - Global entities are not writable (403). No session is 401.
  - The intake wraps the behavior dispatcher and the DAL writes, never a slot: the guards and the intake never touch each other.
- **Front server.** Two additions:
  - `GET /api/<Domain>/1.0/Facet/Changes` is proxied as a stream. The persona resolves as for other facet calls, and only Accept and Last-Event-ID are forwarded. Headers are flushed at once, chunks are piped with backpressure, Nagle is off, and there is no timeout. The browser leaving aborts the upstream request; the upstream ending ends the browser's response. Refusals (401, 429, 404) are relayed whole.
  - The write allowlist is exactly the requests of §12.1: method + path pattern + permitted body keys, JSON only, ≤ 16 KiB. The checked object, not the raw body, is what goes upstream. An answer other than 2xx becomes `{ Error: { Code: DEMO_WRITE_REFUSED | DEMO_WRITE_NOT_FOUND | DEMO_WRITE_FAILED, Status, Message } }`, never the meadow error body with its record or query.

  New demo errors: `DEMO_UNAUTHENTICATED` (401, a write without a persona), `DEMO_WRITE_INVALID` (400), and `DEMO_BODY_TOO_LARGE` for a write over 16 KiB.
- **`/api/Demo/Status`.** Each domain adds `WriteGuard { Installed, Entities, Refused }`, `Writes` (the allowlist) and `Live { Cache, Changes, SSE, Generations, ReadYourWrites }`: the service's own `status()` counters, never keys or values.

### 12.5 Checks and measured numbers

- **`npm test`** (smoke, 19301), section 12, needs no M4 server. It checks:
  - the parser;
  - refetch selection, Seqs, backoff and freshness;
  - the allowlist, through `matchWrite` / `checkBody`;
  - the stream proxy against a stub upstream: streamed not buffered; persona resolved, forged session headers dropped; Set-Cookie not relayed; the upstream aborted when the client leaves; the 401 relayed; 405 for POST.
- **Section 13** checks the allowlist and the guards end to end: 404 / 401 / 400 / 413, and 403 across tenants and owners, for a foreign key into another tenant's data, a colleague's document and a project the persona is not a member of, both through the proxy and straight at a domain server. Nothing a refused write asked for happens.
- **Section 14** runs every card's write as user42 and checks:
  - the 2xx;
  - a `generation` event on user42's stream within 2 s, carrying only `{ Entity, Generation, Seq }`, with nothing on user81's;
  - the dependent refetch with its pre-write ETag: 200, the exact delta, `Miss`, `Exact; upgraded=MinSeq`, the Seq header and `DependsOn`;
  - a repeat `Hit`, the ETag changed once and then stable;
  - an unaffected group's old ETag answering 304 `NotModified`;
  - user43's E2 request right after user42's delete answering `Stale: true` (the shared key), then fresh with `Hit`;
  - undo restoring every count.
- **Section 15** runs the browser's provider in node against the demo. It checks the Freshness body, one stream per domain, a write refetching Documents by itself (If-None-Match + MinSeq + trigger), an off-screen group marked and refetched when shown, a 401 stream stopping, `closeChanges`, and, with the cache, the Stale follow-up.
- Each M4 capability is probed separately: the stream, the result cache (`X-Retold-Facet-Cache`) and the wired pipeline (`Describe.Changes`, `DependsOn`). A missing one skips its own checks with a note. `DEMO_REQUIRE_LIVE=1` turns those skips into failures. The writes, deltas and undo always run, and the smoke leaves every count as it found it.
- **`npm run check:browser`** (19302) runs every page's card with real clicks. After each write the affected card updates with no gesture: a new answer arrives, its trigger is "Live update: …", and there is at most one Query POST per group. Undo restores the counts. The Live chip, the inspector's Cached / Stale / Version / `X-Retold-Facet-Cache` rows, the Write exchange and the `generation` exchange are checked. Screenshots: `28-live-projects-onhold`, `29-live-documents-added`, `30-live-labforms-completed`, `31-live-bookstore-review-inspector`. The change stream is excluded from the "one POST" and "settled" bookkeeping.
- **Measured** on SQLite, Small, against the wired M4 service (intake, generations, result cache, SSE; the demo's `Cache.Enabled: true`), with `DEMO_REQUIRE_LIVE=1` (no skips):
  - every write's `generation` event reached user42 in 162–253 ms, within `SSE.CoalesceMS` (250);
  - user81 received nothing;
  - smoke: 575 checks in 7.4 s; ProjectTrack's cache after it: 23 hits, 24 misses, 1 stale;
  - browser check: 208 checks in 32 s (the pivot cell is centered before its click, so the fixed inspector bar never takes it);
  - PostgreSQL smoke (`TZ=UTC DEMO_PG=1`): 575 checks in 37 s.

  Before the wiring pass (history): with builder B's intake and C's stream wired by hand and no cache stage, smoke 520 / browser check 207; with no stream at all, smoke 475 in 1.3 s and browser check 183, the cards refreshing their page themselves.
