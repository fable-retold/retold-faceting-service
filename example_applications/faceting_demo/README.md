# Faceting Demo

The three motivating questions of retold-faceting-service, plus a Describe-driven bookstore explorer, as a pict single-page app over three seeded retold-data-service domains.

```
cd example_applications/faceting_demo
npm start              # builds dist/ when needed, boots the domains, serves http://127.0.0.1:19300/
npm test               # the end-to-end server smoke (port 19301); same as `node test-server.js`
npm run check:browser  # the built page in headless Chrome: every page's gestures + screenshots/ (port 19302)
```

No `npm install`: every dependency resolves from the retold umbrella `node_modules`.

## What each page shows

Every page also has a dashed **Make a change** card (M4, see [Live changes](#live-changes-m4)): one real write through the domain's CRUD route, after which the cards update by themselves through the server's change stream.

Every page head states its question as a literal query, lists the **active filters** as removable chips (scopes with their parameters, then every selection, named the way the cards name them), and has a one-line "Try" hint. The design reference sits next to the title as a small tooltip. The summary strip on the right shows the Total, `Engine: Live`, `Exact`, the server and round-trip times, the answer's ETag, `304 from cache` when it revalidated, and how many Query POSTs the last change took (always 1).

| Page | Request it sends | What it teaches | What to try |
|---|---|---|---|
| **Projects for me** (`#/Projects`) | ProjectTrack, `POST /1.0/Facet/Project/Query` (design 08 §2, E1): the scopes My projects (`Roles` parameter chips), Has my overdue tasks and Unblocked, three clauses (Status Active + AtRisk, Client Cobalt Works + Iris Media, Start date 2026), five facets and the first records page, in one POST | Disjunctive terms (a card's counts ignore its own selection), a month histogram, a ChildRollup band ("My overdue tasks per project", read-only), a Status × Client pivot whose cells write back the two 1-D clauses, and a list whose Client and Owner columns are looked up (`Lena Lead (you)`) | Tick OnHold: Total 6 → 7 while the Status counts stay. Drag Feb–Jul on the start-date bars: 5. Reset, click the Active × Iris Media cell: 2. "Client #11 (no name)" and "#13" are a deleted and another tenant's client: no name, still filterable. |
| **Documents by form type** (`#/Documents`) | ProjectTrack, `POST /1.0/Facet/Document/Query` (E2): Form D and January–June 2026, by month | The form-type checklist keeps every count when you add a form; the histogram readout says the selection as a span ("Selected Jan – Jun 2026 · 41 documents"); after an interval change the edge bars that are only partly inside are hatched and the Total does not move | Tick Form G: 58. Switch to "week": two hatched edge weeks, still 41. Switch to "day": a per-facet 422 `FACET_INTERVAL_TOO_FINE` with a "Use week" button. |
| **Lab forms I still have to fill out** (`#/LabForms`) | LabTrack. Variant A (tab A): `POST /1.0/Facet/MaterialIntakeRequirement/Scope/MaterialIntakeRequirement.ToDoForMe/Query`, the work list's named scope as a route scope. Variant B (tab B): `POST /1.0/Facet/MaterialIntake/Query`, a TuplePivot over the material-type configuration. The page loads both, so both tab counts show at once. | The work list shows what the facets bucket on, looked up from the related rows: intake, material, received date (the histogram axis), queue, form type, discipline and Started (the Started card's rule). Tab B leads with the agreement: "219 forms to do in both variants", then the planted mismatches as columns | Tick Lab Form H, then Verify: 41 = 41. Physics + drag five weeks: 8. Open tab B: In both 219, Stored only (A) 18, Configured only (B) 5; 237 − 18 = 224 − 5. As User 44 the empty state says the user is in no lab queue. |
| **Bookstore explorer** (`#/Bookstore`) | Bookstore-Tenant + `server/definitions/Bookstore-Demo-Definitions.json`. First `GET /1.0/Facet/Describe`, then `POST /1.0/Facet/Book/Query` with the facets Describe offered | The facet cards are built from Describe (`FacetDemo-Pages.describedFacets`): auto Terms for Genre, Language and Type, the PublicationYear numeric histogram (Edges override, decades), and the declared Book ← Review facets. The head names what Describe offered but the page skips (ISBN, the audit dates). Review rating reads 5 → 1. | Well reviewed: 1250. Drag 2000–2019 on the year bars: 614. Language "(blank)" + 2000–2019: 57. |

Tab B is read-only on purpose: its TuplePivot buckets carry no list clause, so its cards cannot filter and it has no work list. Variants A and B do **not** agree to the row in this seed, and the demo shows why instead of hiding it: A adds stored requirements that no Required configuration row asks for (the seed gives intakes whose material type requires fewer than three forms random extra forms), and B adds configured pairs whose stored requirement row was soft-deleted. "Stored only" is counted from A's list rows checked against the configuration; "Configured only" is B minus the shared pairs (TuplePivot records are not listable yet). Two of eleven form types match exactly.

### The list always agrees with the counts

- Page 1 of every list arrives inside the Query envelope (its `Records` block); later pages come from `POST …/Records/:Begin/:Cap` (the pict-section-recordset `FilterEndpointOverride` shape). The footer says which one the page on screen came from. Any new answer (a filter, another user, a retry) starts the list at page 1.
- "Verify with Records/Count" posts `…/Records/Count` with the same filter and compares it with the Total of the answer on screen. The verdict belongs to that answer: a new answer drops it, and a click while a Query is on its way waits for that Query.
- The histogram readout's count is the envelope Total, never a sum of highlighted bars. Clicking the bar whose clause IS the selection clears it; any other bar writes its own clause.
- Lookup columns (Facet-Lookup.js) read related rows through the faceting Records route of the related entity (`POST /1.0/Facet/<Entity>/Records/0/500` with a key-list clause), under the same tenancy and personal scopes as the facets. They are display only and cached per user. They show in the inspector as `Lookup` exchanges.

### The Request / envelope inspector

The bottom drawer follows the page: it lists only the current page's exchanges (its groups' Query, Records, Count and Lookup calls and its domains' Describe), with an "All pages" toggle. The bar names the page and its latest answer, and says "kept (no new request)" when a page is shown again from state. Tabs: **Request** (browser URL, upstream path, headers including the DEMO principal header and `If-None-Match`, the JSON body), **Envelope** (status, ETag / Version, ModelVersion, Engine, Exact, a stacked bar of where the time went: the faceting service's `ElapsedMS`, the proxy's `Server-Timing: upstream`, the browser round trip; the demo session; one row per facet with Fold, Disjunctive, Excluded, KeptMixed, CountMode, Total / Σ / Missing / Other; Filter.Applied, Warnings, Errors) and **Raw**. Escape closes it, and while it is open the page keeps room so the last list rows can scroll above it.

The cards show only reader-facing badges ("Multi-select", "Read-only", "Overlapping", "Top n of m"). "Show internals" in the page head adds the contract vocabulary (Fold, CountMode, Relaxed, Disjunctive) to the cards; the inspector always has it. The LabTrack scope is Relaxed on purpose (a form completed by any technician in my lab counts), and the page says so once, in its head.

## Layout

```
browser ──▶ front server 127.0.0.1:19300 (server/Faceting-Demo-Front.js, plain node:http)
              /                      dist/ (index.html, the bundle, pict.min.js, faceting-demo.css)
              /api/Demo/Principals   the DEMO persona table
              /api/Demo/Status       provider, scale, each domain's entities, live counts, definitions
              /api/<Domain>/1.0/Facet/Changes  (M4) the change stream, proxied as a stream
              /api/<Domain>/1.0/<allowlisted write>  (M4) the "Make a change" CRUD calls
              /api/<Domain>/1.0/Facet/*  ──proxy──▶ <Domain> server 127.0.0.1:<ephemeral>
                                                    (test/support/Facet-Test-Harness.js: seeded in-memory
                                                     SQLite, retold-data-service, faceting Embedded)
```

`<Domain>` is `ProjectTrack`, `LabTrack` or `Bookstore`. Each domain is one run of the module's test harness (`start()`), so every piece the demo uses is exercised by the module's test suite. After seeding, tenant 1 → 7, tenant 2 → 8, and the seed's story principals (ProjectTrack Lead / Member / Outsider / OtherLead, LabTrack Tech / Colleague / Newbie / OtherTech: users 1 / 2 / 3 / 31 at Small) → 42 / 43 / 44 / 81, so the demo reads like design 08. A seed ID that already holds a target (Medium has more than 42 users) is moved out of the way first; `GET /api/Demo/Status` shows the maps under `Domains.<Domain>.Renumbered`. The harness `Port` (19196–19198) is only a registry label: the domain servers bind ephemeral ports, and only the front server is user-facing.

The browser part lives in `source/` and is structured to lift into a future `pict-section-facet`:

| File | Role |
|---|---|
| `providers/Pict-Provider-Facet.js` | describe / query / records / count / lookups, per-group coalescing (one POST per tick), the Version cache (never caches errors), the count check, focus capture and restore; M4: the change stream per domain (`subscribeChanges` / `closeChanges` / `changeState`), coalesced refetch on change events, Freshness, the Stale follow-up, `write` |
| `providers/Facet-Changes.js` | M4, pure: the SSE parser, which groups a change refetches, Seq ordering, backoff, the stream chip |
| `providers/Facet-Selection.js` | the pure contract: request bodies, write-back clauses, range coverage (`Full` / `Partial` / `None`), `sameRange` |
| `providers/Facet-Display.js` | pure display helpers: labels, range text ("Jan – Jun 2026"), axis ticks with the year where it changes, badges, Server-Timing |
| `providers/Facet-Lookup.js` | pure lookup helpers for related-row columns |
| `views/PictView-Facet-*.js` | Scope, Terms, Histogram, Pivot, Records, Inspector |
| `pages/FacetDemo-Pages.js`, `views/PictView-FacetDemo-*.js` | the demo's pages as data, the layout, the page head, the A/B Compare panel and (M4) the "Make a change" card (not lifted) |

The host lives in `server/` (not `source/server/`), so `source/` is exactly the liftable tree.

## The DEMO principal switcher (never deploy this)

The "Signed in as" switcher sends `X-Retold-Facet-Demo-Principal: user42`. The front server looks the key up in its fixed persona table (`server/Faceting-Demo-Personas.js`) and forwards the test harness's session headers (`x-facet-test-tenant` / `x-facet-test-user`) upstream. The browser never sends IDs, and any `x-facet-test-*` header it sends is dropped. An unknown key, `anonymous` or no header forwards no session (401 `FACET_UNAUTHENTICATED`).

| Persona | Tenant / user | Initial totals: Projects · Documents · Lab forms A · B · Books |
|---|---|---|
| `user42` (default) | 7 / 42 | 6 · 41 · 237 · 224 · 1436 |
| `user43` | 7 / 43 | 0 · 41 · 172 · 157 · 1436 |
| `user44` | 7 / 44 | 0 · 41 · 0 · 0 · 1436 |
| `user81` | 8 / 81 | 1 · 9 · 60 · 34 · 81 |
| `anonymous` | none | 401 everywhere |

(user43 sees projects once the Member role is added **and** "Has my overdue tasks" is off: 2.)

This mechanism is demo-only. A real host resolves the principal from its own session (retold-data-service / RAFS). What keeps the demo private:

- The front server binds **127.0.0.1** by default and, on a loopback bind, only answers loopback `Host` names (`127.0.0.1`, `localhost`, `[::1]`). A page on another origin cannot DNS-rebind to it and pick a persona (421 `DEMO_HOST_NOT_ALLOWED`).
- The domain servers are the test harness, which trusts `x-facet-test-*` headers. They **listen on 127.0.0.1 only** (the harness's `Host` option; Orator itself has no host option), and each one also gets a restify `pre()` **loopback guard** (403 `DEMO_LOOPBACK_ONLY` to any non-loopback client), installed through the harness's `BeforeListen` hook, so it is in place before the first connection. `npm test` checks the bind address and, when the machine has a LAN address, that a request to a domain server from it is refused.
- The proxy forwards only `GET` / `POST` under `/1.0/Facet/`, only the `content-type`, `accept` and `if-none-match` request headers, bodies up to 256 KiB, and refuses dot segments and encoded slashes. (The list lookups use the faceting Records route, not the CRUD API.)
- The CRUD API of the domain servers is reachable only for the M4 "Make a change" writes. These follow an **allowlist**, `server/Faceting-Demo-Writes.js` `WRITE_ROUTES`: exactly seven method + path pairs, each with its permitted body keys, JSON only, ≤ 16 KiB. They need a signed-in persona. Anything else under `/api/<Domain>/1.0/` is 404.
- Each domain also has **write guards** (PreOperation behaviors). A create is stamped with the session's tenant (and owner, on LabForm). A body naming another tenant or owner, a foreign key into another tenant's data (a document on another tenant's project, a review of another tenant's book, a form type that does not exist), a change to a row outside the persona's tenant, and a change to a row that is not the persona's (a project it is not an active member of, a document it neither wrote nor is a member of the project of, a review it did not write) are refused with 403. These guards apply even to a loopback client that bypasses the proxy.

`DEMO_HOST=0.0.0.0` exposes the switcher to the network (the banner warns); do not.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `DEMO_PORT` | `19300` | front server port; only 19300–19310 are accepted (19301 is the smoke test's, 19302 the browser check's) |
| `DEMO_HOST` | `127.0.0.1` | front server bind address |
| `DEMO_SCALE` | `Small` | fixture scale, `Small` or `Medium` (×4 rows; the expected totals above are Small's) |
| `DEMO_PG` | unset | `1`: every domain on PostgreSQL in the throwaway `rfs-test-postgres` container, exactly as `npm run test:pg` (needs docker and `TZ=UTC`: `TZ=UTC DEMO_PG=1 npm start`; also works for `npm test`) |
| `DEMO_LOG_LEVEL` | `error` | the domains' log level |
| `DEMO_SKIP_BUILD` | unset | `1`: `npm start` does not build (the page asks for `npm run build` when `dist/` is missing) |

`npm start` runs `server/Ensure-Built.js` first: it builds when `dist/` lacks the bundle or when `source/`, `html/`, `css/` or the service's `source/contract/` changed since the last build. `npm run build` = `npx quack build && npx quack copy && node server/Copy-Pict.js` (Copy-Pict resolves `pict/dist/pict.min.js` from the umbrella, because this example has no `node_modules` of its own).

## Errors you can reach on purpose

| Gesture | Answer |
|---|---|
| Anonymous persona | 401 `FACET_UNAUTHENTICATED` on every page |
| Deselect every role chip of My projects | 400 `FACET_PARAM_INVALID` (`Detail.Param: "Roles"`); switching My projects off and on restores the default roles |
| Documents interval "day" | 200 with `Errors.ByMonth` = 422 `FACET_INTERVAL_TOO_FINE`, `Detail.Suggest.Interval: "week"` |
| Stop the server while the page is open | `DEMO_NETWORK` (the fetch fails) |

The demo host's own errors use the service's error shape, `{ "Error": { "Code", "Status", "Message", "Detail"? } }`: `DEMO_NOT_FOUND`, `DEMO_UNKNOWN_DOMAIN`, `DEMO_METHOD_NOT_ALLOWED`, `DEMO_BODY_TOO_LARGE` (413), `DEMO_BAD_PATH`, `DEMO_HOST_NOT_ALLOWED` (421), `DEMO_UPSTREAM_UNAVAILABLE` (502). The writes (M4) add four more:

- `DEMO_UNAUTHENTICATED` (401): a write without a persona.
- `DEMO_WRITE_INVALID` (400): a key the allowlist does not permit, a missing or malformed value, or a body that is not JSON.
- `DEMO_WRITE_REFUSED` (401 / 403): the domain's write guard said no.
- `DEMO_WRITE_NOT_FOUND` / `DEMO_WRITE_FAILED`.

A refused write never relays meadow's error body with its record or query.

## `npx quack examples`

`npm run example` at the module root (`npx quack examples`) serves the static shell only. The facet API exists only under `npm start`, so the pages show "The demo host is not answering". For the same reason the example is not staged into the docs (`"Stage": false`).

## The browser check and the screenshots

`npm run check:browser` (`server/Faceting-Demo-Browser-Check.js`) boots the demo in-process on 19302 (or uses `DEMO_URL=http://127.0.0.1:19300/` against a running `npm start`). It opens the **built** page in headless Chrome through puppeteer (resolved from the retold umbrella `node_modules`; the example does not depend on it) and drives every page with real mouse and keyboard gestures. After each gesture it checks that exactly one Query POST went out, that the page Total is the clicked bucket's count, and that "Verify with Records/Count" agrees with it (and the list shows `min(25, Total)` rows, "… of Total"). It also checks the review fixes: the week readout and hatched edges, the year on the axis ticks, the count verdict dropped on a principal switch, page 1 after a switch on page 2, focus staying on a bar after Enter, the work-list lookups, the A/B callout, the user44 empty state, the inspector's page context, Escape and bottom room, and 800px and 390px layouts.

Since M4 it also clicks every page's "Make a change" card. After each write, the affected card must update with no gesture: the change stream's event, one refetch per group, the "Live update" trigger. Undo restores the counts, and the inspector shows Cached / Stale / Version.

Against the wired M4 service it runs 208 checks in about 34 s; without a change stream the cards refresh their page themselves (and `DEMO_REQUIRE_LIVE=1` fails the live checks instead of skipping them). Needs `dist/` (`npm run build`).

Screenshots of each state are written to a scratch directory (the OS temp dir, or `DEMO_SCREENSHOT_DIR`), so a verification run never rewrites the tracked files; `DEMO_UPDATE_SCREENSHOTS=1 npm run check:browser` refreshes `screenshots/`:

| | |
|---|---|
| `01`–`04` | Projects: initial, + OnHold, + Feb–Jul drag, a pivot cell |
| `05`–`08`, `25` | Documents: initial, + Form G, one month, interval "day" (422), interval "week" (hatched edge weeks) |
| `09`–`12`, `26` | Lab forms: A initial, Lab Form H, Physics + weeks, tab B (Compare), user44's empty state |
| `13`–`15` | Bookstore: initial, Well reviewed + 2000–2019, Fiction + "(blank)" language |
| `16`–`19` | user81, user43 empty, no roles (400), anonymous (401) |
| `20`–`21` | the inspector (Envelope, Request) |
| `22`–`24`, `27` | the other theme, 800px, offline (`DEMO_NETWORK`), 390px |
| `28`–`31` | M4 live changes: Projects after "On hold", Documents after "Add document", Lab forms after "Complete a started form", Bookstore after "Add a 5-star review" with the inspector on the stream-triggered refetch |

## Live changes (M4)

Every domain runs faceting with the result cache on (`Cache.Enabled: true`), the interim change intake and `GET /1.0/Facet/Changes` (mounted because every demo domain has a scope policy). The page opens one change stream per domain for the persona, through the front proxy, which relays it as a stream. A write anywhere then reaches every page that depends on it:

1. The intake wraps the controller's behavior dispatcher and its DAL writes (never a behavior slot, so the demo's own write guards and the intake never touch). The change is taken at the write's PostOperation, from the row as it was before any PreOperation behavior ran; a write that commits but fails afterwards is still taken, conservatively.
2. It bumps the generations of what the write touched, before the write's response leaves.
3. The stream tells each principal who can see that data which entity changed. It sends `{ Entity, Generation, Seq }` and nothing else: no tenant, row or count. One shared timer coalesces the events (one per entity per 250 ms).
4. The provider waits a random 0–150 ms (so pages that heard the same event do not all ask at once), then refetches the groups whose envelope `DependsOn` names that entity. It sends `If-None-Match` and `Freshness.MinSeq`, so the server answers Exact or 304.

If the stream is cut — a server restart, a deploy — the provider reconnects with jittered backoff and refetches what is on screen. The server also ends every stream at its revalidation time (5 minutes, jittered) with `closed { Reason: 'Revalidate' }`; the provider reconnects at once, through the persona's session again, so a sign-out or a persona switch takes effect on the stream too.

**Demo-only settings.** The demo's domains set three switches a multi-tenant deployment leaves at their defaults: `Cache.ExposeStatus: true` (the `X-Retold-Facet-Cache` / `-Freshness` headers the inspector shows, and a truthful `Cached` on an answer another persona computed), and `Freshness.SeqHeader: true` / `SSE.IncludeSeq: true` (the node-wide `Seq` on answers and events, which makes the MinSeq flow visible). On a host with a scope policy their defaults keep the cache status and the Seq away from clients: the Seq counts every tenant's writes, and the cache status tells a user that a colleague ran the same query. Without a Seq on the event the provider refetches with `Freshness.Mode: 'Exact'` instead of a MinSeq, with the same result.

| Card | Write | What to watch |
|---|---|---|
| Projects for me | set a listed project's status (Undo) | Active → On hold: 6 → 5, the Status counts move, the strip says "Live update: Project", the cache says Miss then Hit |
| Documents by form type | add a Draft Form D document dated 2026-03-15; delete; undelete | 41 → 42 → 41 → 42; switch to User 43 right after a write: the shared answer comes back marked "Stale · n s old" and the page asks again by itself |
| Lab forms (A) | complete one of my started forms; re-open | 237 → 236 (the row leaves the work list) → 237 |
| Bookstore explorer | a 5-star review on the first listed book without one; remove | 5-star books +1, the five-star split moves one book |

As User 81, nothing of tenant 7's activity arrives. The stream chip (Live / Reconnecting / Off) is on the card and in the summary strip. The inspector lists the stream's events (`Change`) and the writes (`Write`), and shows Cached / Stale / LagMS / DependsOn and the `X-Retold-Facet-Cache` / `-Seq` / `-Freshness` headers of every answer. Queries ask for `Freshness: Bounded` (5 s); after my own write (read-your-writes) or with an event's MinSeq the server answers Exact. Without a stream, for example on a host without M4, a card refreshes its page itself and says so. DEMO-SPEC §12 has the details and the measured numbers.

## The smoke test

`npm test` (or `node test-server.js`) boots everything in-process on 19301 and drives it through the front server with bodies built by the client contract (`source/providers/Facet-Selection.js`, `source/pages/FacetDemo-Pages.js`). Since M4 it also checks the following:

- The live-change client contract: the SSE parser, refetch selection, Seqs and Freshness.
- The write allowlist, and the stream proxy against a stub upstream.
- The write guards, including 403 across tenants and owners, for a foreign key into another tenant's data, a colleague's document and a project the persona is not a member of.
- Every card's write as User 42: the event on User 42's stream and none on User 81's, the dependent refetch with its exact delta (Miss, then Hit), an unaffected group's 304, User 43's Stale answer right after a write, and the undo.
- The browser's provider itself, run in node against the demo.

Each M4 capability (stream, cache, wired pipeline) is probed separately. A missing one is skipped with a note, or fails with `DEMO_REQUIRE_LIVE=1`.

It covers static files (skipped when `dist/` is not built), the demo endpoints, Describe (and the Books facet list derived from it), every group × every persona against the expected totals, a 304 revalidation, `Records/Count == Total` and paging for every list, a write-back round trip per widget kind, forged headers, the per-facet interval error, the domain servers' loopback bind and guard, and the host's own errors. Section 11 checks the client's display logic against real answers: the client's `Full` coverage equals the server's `Selected` flags at every interval (with 2 partial weeks and 1 partial year for the Documents range, Total unchanged), the work list's Started column equals the Started facet for every row, and the A/B breakdown holds for user42, user43 and user81. Against the wired M4 service it runs 583 checks in about 7 s on SQLite (most of it waiting for coalesced events) and in about 37 s on PostgreSQL (`TZ=UTC DEMO_PG=1`); a service without the stream, the cache or the wired pipeline skips those checks with a note.
