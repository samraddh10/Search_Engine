# Search Engine — Project Plan

A from-scratch search engine in a Node.js + TypeScript monorepo (npm workspaces).
Custom Information-Retrieval core (crawler, inverted index, BM25); Postgres for durable
index/document storage; Redis for the crawl frontier only (a local, offline crawl job —
never part of the hosted deployment); in-process memory for the search-result cache and
autocomplete; React + TypeScript + Tailwind frontend.

## Status

- **Phase 0.1 (Layout) — done.** `server/src/{crawler,processing,indexer,ranking,search,api,db}`
  created (empty, `.gitkeep`-marked); the original health-check server was split into
  `server/src/api/server.ts` (builds the Express `app`, exports it) and `server/src/index.ts`
  (thin bootstrap — imports `app` + `config`, calls `app.listen`).
- **Phase 0.2 (Shared kernel) — done, with two deviations from the plan below:**
  - Cross-workspace contract types/constants live in a **root `shared/` npm workspace**
    (`shared/src/types.ts`, `shared/src/constants.ts`, barrel `shared/src/index.ts`) — a
    real workspace, not a folder inside `server/src`, so `client` can import the same
    types later. `server/package.json` and `client/package.json` both depend on `"shared": "*"`.
    Root `package.json` builds it first (`postinstall` + explicit `build:shared` before
    `build:server`/`build:client`).
  - Zod-validated env config landed at **`server/src/config.ts`** (flat, not
    `server/src/shared/config.ts`) — the `shared/` subfolder name was dropped entirely to
    avoid colliding with the root `shared/` workspace name. Only one `shared` exists in the
    repo now.
  - `shared/utils.ts` (mentioned in the original 0.2 subphase) was **not** created — no
    concrete cross-workspace helper exists yet; add it when one is actually needed (e.g.
    Phase 1 URL normalization or Phase 3 snippet helpers), not speculatively.
- **Phase 0.3 (Connections) — done.** `docker-compose.yml` at repo root runs
  `postgres:17-alpine` and `redis:8-alpine` (pinned, named volumes, healthchecks).
  `server/src/db/pg.ts` exports a `pg` `Pool` + `checkPgHealth()`/`closePg()`;
  `server/src/db/redis.ts` exports an `ioredis` client (lazy-connect) +
  `checkRedisHealth()`/`closeRedis()`/`connectRedis()`. `server/src/index.ts` connects
  Redis on startup *when configured* and closes both on `SIGINT`/`SIGTERM`.
  `GET /api/health` pings Postgres plus Redis-if-configured, returning `503`/`degraded`
  when Postgres is down or a configured Redis is unreachable.
- **Phase 0.3 amended (Redis made optional).** Driven by the hosting decision below:
  - `REDIS_URL` is now `.optional()` in `server/src/config.ts`; `db/redis.ts` exports
    `redisClient: Redis | null` (null = not configured) and `checkRedisHealth()` returns
    `boolean | "not_configured"`. `/api/health` treats `"not_configured"` as healthy but
    still fails a Redis that *was* configured and is unreachable, so Postgres remains the
    only hard dependency.
  - Fixed a latent startup bug found here: `lazyConnect: true` had been commented out in
    `db/redis.ts` along with the comment explaining it, so the client connected eagerly at
    import — which made `index.ts`'s explicit `redisClient.connect()` reject with "Redis is
    already connecting/connected" and kill startup. The option is restored and the connect
    call moved behind `connectRedis()`.
- **Phase 0.4 (Schema + migrations) — done.** `node-pg-migrate` v9 with migrations in
  **`server/db/migrations/`** (raw SQL via `pgm.sql()`, so the DDL stays readable and
  parallel to `schema.sql`). Scripts: `npm run migrate` / `migrate:down` /
  `migrate:create` / `seed`, exposed at the repo root too. `server/db/schema.sql` is a
  readable snapshot (migrations remain the source of truth); `server/db/seed.sql` is a
  re-runnable 3-document fixture corpus, applied by `server/src/db/seed.ts` (reads the
  `.sql` through the existing pool, so no `psql` needed on Windows). Verified: up → seed
  → down → up → seed round-trips cleanly, and the single-row `corpus_stats` CHECK rejects
  a second row.
  - **SQL and migrations live in `server/db/`, not `server/src/`** — `tsc` only emits
    `.ts`, so a `seed.sql` sitting next to `seed.ts` would never be copied into `dist/`
    and the built script failed with `ENOENT`; migration `.js` files under `src/` were
    likewise dropped from the build, meaning a deployed artifact could not migrate its own
    database. `seed.ts` resolves `../../db/seed.sql`, which is correct from both `src/db/`
    (via tsx) and `dist/db/` (after a build).
  - **`terms.surface_form` — resolved, column added.** Stems live in `terms.term`,
    display spellings in `terms.surface_form` (nullable until the Phase 2 indexer fills
    it); autocomplete reads `COALESCE(surface_form, term)`. *(Superseded by 3.3 decision 6:
    the `COALESCE` fallback surfaces a bare stem to a human, which is the exact breakage this
    column was added to prevent, so 3.3 filters `surface_form IS NOT NULL` instead.)* The seed fixture demonstrates
    it: `crawl`→`crawler`, `index`→`indexing`, `rank`→`ranking`. Every number in the
    fixture is derived from the actual `content_text` — `token_count`, `tf`, `doc_freq`
    and especially `positions`, which Phase 3.2 slices snippets from, so a decorative
    fixture would make snippet tests silently wrong.
  - **No index on `postings.term_id`** — the PK is `(term_id, doc_id)`, whose btree
    already serves leading-column lookups, so the plan's original "index on `term_id`"
    would have been redundant. Added `postings_doc_id_idx` instead, for the reverse
    direction (delete/reindex a single document).
- **Server module system — resolved: ESM, and `shared` too.** `server/package.json` and
  `shared/package.json` both have `"type": "module"`, their tsconfigs use
  `module`/`moduleResolution: NodeNext`, and relative imports carry explicit `.js`
  extensions. `ioredis` must be imported as `{ Redis }` — its CJS `export =` shape gives
  no constructable default under NodeNext. Converting `shared` also removed the client's
  CJS-interop penalty: the bundle used to reference `g.SUGGESTION_LIMIT` through a runtime
  namespace object (untree-shakeable) and now inlines the literal `8`. The client remains
  the only workspace on bundler resolution, which is correct for Vite.
- **Phase 0.5 (Test harness) — done.** Vitest 4 in the server workspace
  (`server/vitest.config.ts`), `npm test` at both the workspace and repo root, plus
  `test:watch`. 10 tests across 3 files, all passing.
  - **Test-DB strategy — resolved: a separate `search_engine_test` database** in the same
    docker-compose Postgres (chosen over an ephemeral schema or Testcontainers: fastest,
    no extra tooling, and the suite runs against the *real* migrated DDL rather than a
    mock that could drift). `server/test/globalSetup.ts` creates the database if missing
    and applies migrations via node-pg-migrate's programmatic `runner()`.
  - **Guard against nuking dev data:** globalSetup refuses to run unless the database name
    ends in `_test`, and `src/db/pg.test.ts` asserts `current_database() = 'search_engine_test'`.
    Verified by pointing `.env.test` at the dev database — the run aborts.
  - **Env wiring:** `server/.env.test` is committed (local-only credentials) and injected
    two ways — Vitest's `test.env` for workers, and `DOTENV_CONFIG_PATH` so `config.ts`'s
    `import "dotenv/config"` reads it instead of the development `.env`. Without the
    second, `REDIS_URL` would leak in from `.env` and the "no Redis" tests would be
    meaningless.
  - **Coverage so far:** Postgres health + schema presence + the `corpus_stats` single-row
    CHECK; both Redis branches (`"not_configured"` vs. a live client, the latter via
    `vi.resetModules()` + `vi.stubEnv`, which also regression-tests the `lazyConnect` bug);
    and `GET /api/health` through `supertest` — the payoff for the `app`/`listen` split
    made back in 0.1.
  - **Tests are excluded from the build** (`tsconfig.json`) but type-checked via a new
    `tsconfig.test.json`, which `npm run typecheck` now targets so `test/` and
    `vitest.config.ts` are covered too.
- **Phase 0 complete.**
- **Phase 1.1 (Fetcher) — done.** `server/src/crawler/fetcher.ts` exports `fetchPage(url,
  options)`; 24 tests in `fetcher.test.ts` run against a real `node:http` fixture server
  (a mocked `fetch` would only assert our own assumptions about the transport back at us).
  No new dependencies — native `fetch`/undici per the phase's key decision.
  - **Failures are returned, not thrown.** `FetchResult` is a discriminated union, and
    every failure carries `retryable`. 1.5 has to tell "this URL is dead, drop it" apart
    from "the host was briefly unhappy, requeue it", and an exception can only carry that
    in ad-hoc properties the caller has to sniff. Reasons: `invalid-url`, `timeout`,
    `network`, `http-error`, `too-many-redirects`, `too-large`,
    `unsupported-content-type`, `aborted`.
  - **Three guards beyond the plan's one-line scope**, added because this is the only
    layer holding the raw response and nothing downstream could add them later: a byte cap
    enforced *while streaming* (Content-Length is advisory — absent on chunked responses
    and free to lie), a content-type allowlist checked on headers before the body is read,
    and a redirect cap.
  - **Manual redirect following** (`redirect: "manual"`), not fetch's default. Two reasons:
    fetch follows up to 20 hops with no way to lower that, and following them ourselves is
    what lets a `Location` pointing at `ftp:`/`file:` be rejected instead of followed. The
    result reports the **final** URL separately from `requestedUrl` — that final URL is the
    page's identity, or three URLs redirecting to one page become three `documents` rows.
  - **Charset deferred to 1.3, deliberately.** Bodies are decoded UTF-8. The parser has to
    read `<meta charset>` out of the markup anyway, so splitting charset detection across
    two layers would be the worse design.
  - **A missing `Content-Type` is treated as unsupported**, not assumed-HTML: guessing
    wrong streams an arbitrary binary into the Phase 2 tokenizer.
  - **`Retry-After` is capped** (30s) **and surfaced**. Honouring a literal
    `Retry-After: 3600` would park a worker for an hour; past the cap the attempt ends as
    retryable and the frontier reschedules whenever it likes. The value itself rides out on
    `FetchFailure.retryAfterMs` — **1.5 must read it before requeuing**, or the polite local
    refusal to block becomes a globally rude immediate retry against a host that asked for
    an hour. Backoff is exponential with half-jitter — without jitter a worker pool retries
    a struggling host in lockstep and re-breaks it.
  - **Backoff is cancellable.** The inter-attempt sleep watches the caller's `AbortSignal`,
    so a shutdown doesn't have to sit through up to `maxBackoffMs` before the next attempt
    notices. The timer is deliberately *not* `unref`'d: an unref'd backoff would let a
    process whose only pending work is that sleep exit silently with the fetch unresolved.
    1.7's SIGINT handler should therefore abort a controller rather than rely on the event
    loop draining.
  - **Known limitation:** `elapsedMs` is wall-clock for the whole call, so it includes
    backoff sleeps — a page that succeeded on attempt 3 can report seconds while each
    request took milliseconds. Fine for the timeout/cancellation assertions that use it;
    **not** a latency metric. 5.4 needs on-the-wire timing if it wants one.
  - **501 is excluded from the retryable 5xx range** — an unimplemented method stays
    unimplemented. A caller's `AbortSignal` is reported as `aborted`/non-retryable, distinct
    from our own timeout, so a shutdown doesn't requeue everything in flight.
  - **Tuning knobs are module constants** (`FETCH_DEFAULTS`), overridable per call, *not*
    env vars. Revisit in 1.5, when there's an actual crawl job with knobs worth turning.
  - Note: the fetcher needs no database, but `vitest.config.ts`'s `globalSetup` provisions
    the test DB for the whole run, so `npm test` still requires docker-compose Postgres up.
- **Phase 1.2 (robots) — done.** `server/src/crawler/robots.ts` exports
  `checkRobots(url, options)` → `{ allowed, crawlDelayMs?, sitemaps, outcome, source }`, plus
  `clearRobotsCache()`. 27 tests in `robots.test.ts`, again against a real `node:http`
  fixture server. One new dependency: `robots-parser` v3.
  - **Two-layer cache, not Redis-only.** An in-process `Map<origin, RobotsEntry>` holds the
    *parsed* object; Redis holds a JSON envelope with the raw text. A `Robot` has methods, so
    it can't be serialized — a Redis hit can only ever return text that must be re-parsed.
    Redis-only would therefore have cost a network round-trip *and* a re-parse per URL to
    answer a question whose answer never changes, and would have forced the crawler to
    hard-require `REDIS_URL` against `db/redis.ts`'s deliberate nullable design. `redisClient
    === null` simply skips layer 2; both Redis helpers swallow their errors, so a dead Redis
    degrades the crawl to "fetch robots.txt more often" rather than breaking it.
  - **The cache key is the *origin*** (`robots:https://example.com:8443`), not the hostname.
    `http://`/`https://` and `www`/apex each serve their own robots.txt, so a hostname key
    would apply one site's rules to another.
  - **Negative results are cached too** — that's why the Redis value is an envelope rather
    than bare text. Without it, a site with no robots.txt gets re-fetched once per URL, which
    is the exact impoliteness the cache exists to prevent. TTLs: 24h for rules *and* for
    "no robots.txt"; 5 min for "unreachable", short because that blocks the whole host.
  - **The failure policy keys off the fetcher's `retryable` flag**, not a re-derived status
    list — 1.1 already draws the line between "the host is having a moment" and "this is a
    settled answer". Retryable (5xx, timeout, network, 429) → **disallow-all** per RFC 9309
    §2.3.1.4; non-retryable (404/410, and `unsupported-content-type`, which is how a soft-404
    HTML error page arrives) → **allow-all**, the RFC's reading of "no rules exist".
    Two deliberate exceptions: `too-large` → disallow-all (the rules exist, we just couldn't
    read them, so allow would be guessing in the dangerous direction), and `aborted` → block
    but **cache nothing**, since our own Ctrl-C is not evidence about the host.
  - **In-flight deduplication** (`Map<origin, Promise<…>>`). 1.5's worker pool will pop
    several URLs for one host simultaneously and they'd otherwise all miss the still-empty
    cache together. Costs ~6 lines; test 20 pins it.
  - **`crawlDelayMs` is `undefined` when the site named no `Crawl-delay`** — deliberately not
    defaulted to a polite value here. **1.5 must supply its own default**, because it needs to
    tell "this host asked for 2s" from "nobody asked, so we chose 2s", and collapsing them at
    this layer destroys that distinction permanently. An explicit `Crawl-delay: 0` survives as
    `0`, still distinct from `undefined`. Values are capped at 30s: unlike `Retry-After` (one
    request, once) a crawl delay applies to *every* request, so a typo'd `3600` compounds
    across the whole crawl.
  - **Sitemaps are surfaced, not followed.** `robots-parser` has already parsed the
    `Sitemap:` lines by the time we ask, so `getSitemaps()` is free; 1.4/1.7 decide whether to
    seed from them. Actually fetching them would need XML parsing, sitemap-*index* handling
    and `.xml.gz` — a subphase, not a footnote.
  - **`fetchPage` gained `allowedContentTypes`** (default still the HTML pair, now exported as
    `HTML_CONTENT_TYPES`). Required: 1.1's allowlist is HTML-only, so it rejected every
    `robots.txt` — they're `text/plain`. The robots fetch also accepts `""` (no `Content-Type`
    at all), which 1.1 refuses for pages: minimal servers omit it, and the downside is bounded
    here because a non-robots file simply yields no directives. HTML is *not* accepted, so a
    soft-404 error page is never parsed as rules.
  - **`USER_AGENT_TOKEN` is now exported and `USER_AGENT` is built from it.** robots.txt
    groups name the bare token (`User-agent: SearchEngine2Bot`); matching against the full
    header string would silently fall through to `*` — which, on a site whose `*` group is
    `Disallow: /`, means quietly blocking a site that had explicitly allowed us.
  - **Known wart:** `robots-parser`'s `index.d.ts` mixes a shorthand `declare module` with an
    `export default`, which NodeNext resolution reads as the module namespace, so the import
    types as non-callable even though `module.exports` *is* the function at runtime. The
    `Robot` interface is mirrored locally and one documented cast corrects it.
  - `robots.txt` is exempt from its own rules — nothing calls `checkRobots` on the robots
    fetch, or it would recurse forever. The frontier should likewise not enqueue `/robots.txt`.
- **Phase 1.3 (Parser) — done.** Three modules, not one: `crawler/parser.ts`
  (`parseHtml(html, pageUrl, options)` → `ParsedPage`), `crawler/url.ts`
  (`normalizeUrl`/`parseHttpUrl`/`isTrackingParam`) and `crawler/charset.ts` (`decodeBody`).
  60 new tests across three files, plus 2 added to `fetcher.test.ts`; 151 pass overall.
  One new dependency: `cheerio` v1.2.
  - **Charset could not live in the parser, and the plan's reason is why.** 1.1 deferred it
    on the grounds that one layer should own the decision — but 1.1 also did
    `new TextDecoder("utf-8").decode(bytes)`, and that is lossy and one-way. By the time a
    windows-1252 page reached `parseHtml` every non-ASCII byte was already U+FFFD, so
    "the parser owns it" was unimplementable as written. Detection therefore lives in
    `charset.ts` and the **fetcher calls it**, which satisfies the actual requirement (one
    module decides) while keeping a single copy of the body — the alternative, passing raw
    bytes downstream, makes every consumer carry both a `Uint8Array` and its decoded string.
    `FetchSuccess` gained `charset`.
  - **No alias table.** Node's `TextDecoder` already implements the WHATWG Encoding
    Standard's label list — it maps `iso-8859-1` and `ascii` to windows-1252, `sjis` to
    shift_jis, `gb2312` to gbk — and throws `RangeError` on labels it doesn't know. That
    throw *is* the fallback chain: an unknown label falls through to the next rule rather
    than failing the fetch, because a page with a typo'd charset is still worth indexing.
  - **Precedence is BOM > HTTP header > `<meta>` > UTF-8.** The BOM wins because it is
    in-band and unambiguous; a contradicting header is simply misconfigured. The header
    beats `<meta>` because the header was chosen by whatever served the file, while the
    `<meta>` may be a leftover from the template the page was built from. The BOM must be
    detected by hand: a decoder only strips a mark matching its *own* encoding, so
    `TextDecoder("windows-1252")` renders a UTF-8 BOM as the visible text `ï»¿`, which then
    becomes the document's first token.
  - **`url.ts` is a separate module because 1.4 needs the same function.** The canonical
    form is the frontier's dedup key (`frontier:seen`), and 1.3 canonicalizes every
    extracted link — if those two disagreed by a trailing slash the crawler would re-fetch
    pages forever. It also absorbed the near-identical private `parseHttpUrl` that
    `fetcher.ts` and `robots.ts` had each grown. **1.4 must key the frontier on
    `normalizeUrl`, not on a rule of its own.**
  - **`normalizeUrl` deliberately does NOT unify `http`/`https` or `www`/apex**, and no
    later phase should teach it to. Both look like safe rewrites and neither is: forcing
    https breaks http-only sites outright, and `www.example.com`/`example.com` are two
    different DNS names that nothing requires to resolve to the same host — or to resolve
    at all. The asymmetry decides it. A wrong unification is *unrecoverable* (the page is
    never fetched and we never find out); a duplicate is *recoverable*, and three existing
    mechanisms recover it, in order: **redirect following** (1.1 — nearly every site 301s
    one spelling to the other, and `FetchSuccess.url` reports where it landed),
    **`rel=canonical`** (1.3 — the site naming its own preferred spelling), and
    **`content_hash`** (1.6 — the backstop for a site that serves 200 on both). Same
    reasoning as the conservative tracking-param list above.
  - **1.4 must mark BOTH the requested URL and the fetcher's final URL as seen.** This is
    the gap the rule above leaves open: without it `http://example.com/page` stays
    permanently absent from `frontier:seen`, so every link using that spelling re-enters the
    queue, re-fetches, eats the redirect, and lands on a page we already have. Correctness
    survives (`content_hash` catches the duplicate) — we just pay one wasted request per
    occurrence, forever. Cheap in 1.4, invisible if missed. Note this also constrains the
    open **crawl-scope** decision: a host allowlist has to contain both `example.com` and
    `www.example.com`, or the redirect lands out of scope and the page is silently dropped.
  - **Query parameters are sorted; that is the load-bearing choice.** `?a=1&b=2` and
    `?b=2&a=1` are one page to every server worth crawling but two strings, and two strings
    means two frontier entries and two `documents` rows. Accepted risk: a server that
    treats parameter order positionally. Tracking parameters (`utm_*`, `gclid`, `fbclid`, …)
    are stripped, but the list is deliberately conservative — `ref`, `source`, `id`, `q` and
    `page` are **not** on it, because wrongly stripping one merges genuinely distinct pages
    into a single frontier entry, a silent loss of coverage that costs far more than a stray
    campaign tag. Fragments and credentials are dropped. The **trailing slash is deliberately
    left alone** (`/docs` stays distinct from `/docs/`): servers answer one with a 301 and
    the other with a 404 often enough that collapsing them would cost real pages.
    `MAX_URL_LENGTH` is 2048, re-checked *after* normalization since form-urlencoding can
    triple a value's length (`!` → `%21`).
  - **Links are extracted before pruning, and the order is the whole point.** Text
    extraction removes `<nav>`, `<header>` and `<footer>` — correct for text, catastrophic
    for links, since site navigation is precisely how a crawler reaches the rest of a site.
    Pruning first would have left the frontier with only the links inside body copy. Test
    "collects links from chrome that text extraction throws away" pins it.
  - **Self-links are dropped** by pre-seeding the dedup set with the page's own URL. Every
    `href="#top"` resolves to the page itself once the fragment is stripped, and a template's
    "back to this article" link does too; neither tells the frontier anything, and both would
    appear as self-loops in any later link-graph work.
  - **Content scope: exactly-one `<main>`/`[role=main]`, else exactly-one `<article>`, else
    `<body>`.** "Exactly one" matters for `<article>` — a blog index is a list of many, so
    taking the first would index one teaser and discard the page. `<header>`/`<footer>` are
    stripped **only** in the `<body>` fallback: a page that marked up `<main>` already
    answered the question, and a `<header>` inside an `<article>` is usually the headline.
  - **Block-level tags emit a separator.** cheerio's `.text()` concatenates raw text nodes
    with nothing between them, so `<p>Apples</p><p>Oranges</p>` becomes the single token
    `ApplesOranges` — which Phase 2 would faithfully index. Inline elements deliberately get
    no separator, since `<span>a</span><span>b</span>` really does render as `ab`. NBSP,
    soft hyphens and zero-width characters are normalized here rather than left to 2.1's
    NFKC pass, because they otherwise sit in `content_text`, the column 3.2 slices snippets
    from. Known tradeoff: whitespace inside `<pre>` is collapsed too.
  - **`nofollow` is applied, `noindex` and `canonicalUrl` are only reported.** Dropping a
    link is unambiguous, so the parser does it. Whether to store a page and whether to trust
    its self-reported canonical are storage decisions about a URL we may never have fetched
    — **1.6's call**, so `ParsedPage` keeps `url` and `canonicalUrl` separate rather than
    substituting one for the other. A `<meta>` directive naming `SearchEngine2Bot` overrides
    the generic `robots` one, since naming a bot is how a site grants it an exception.
  - `lang` is stored whole (`pt-br`, not `pt`) and shape-checked against BCP-47 — the
    attribute is author-supplied and routinely holds template junk like `{{locale}}`, which
    would otherwise land in `documents.lang` and be consulted by Phase 2 when picking a
    stopword list.
- **Phase 1.4 (Frontier) — done**, implementing the agreed design recorded under *Phase 1.4
  — Frontier: agreed design* (see Phase 1 for the reasoning behind each choice). Two
  modules: `crawler/frontier.ts` (the `Frontier` class — policy) and
  `crawler/frontierStore.ts` (`FrontierStore` interface + `MemoryFrontierStore` +
  `RedisFrontierStore`). 38 new tests; 189 pass overall. No new dependencies.
  - **Public surface:** `addSeed`/`add`/`requeue` → `AddResult` (a discriminated union with
    a `reason`), `markSeen`/`hasSeen`, `next`/`popBatch`, `size`/`seenCount`/`clear`, and a
    `stats` getter returning a *copy* of the per-reason counters for 1.7's crawl summary.
    Plus `hostsFromSeeds(seeds)`, so 1.7 can build the allowlist from the seeds it already
    has instead of hand-writing one.
  - **`ZADD NX`, chosen so the two stores agree *exactly* rather than approximately.** Redis
    collapses a re-add of a queued member into a score update where an array would grow a
    second copy. Pinning both to "ignore the repeat" is what lets the policy suite run
    entirely on memory and still prove something about a real crawl; without it a test could
    pass on memory and fail only in production. The store conformance suite runs the same
    assertions against both implementations for this reason.
  - **Check order in `add()` is load-bearing twice over.** Every pure check (parse, depth,
    robots.txt, scope) runs before any I/O, so the common rejections cost nothing. More
    importantly the **queue-full check sits before `markSeen`**: a URL turned away for lack
    of room must not be marked, or the cap would delete it from the crawl permanently
    instead of deferring it. Test "rejects once full without marking the URL seen" pins it.
  - **`canonicalHost` collapses `www` onto the apex — for *scope only*, and the asymmetry
    with 1.3 is deliberate.** `normalizeUrl` refuses to unify www/apex because a wrong
    unification is unrecoverable (the page is never fetched and we never find out). Scope is
    the mirror image: nearly every site 301s one spelling to the other, so an allowlist
    naming only one sends the redirect target out of scope and drops the page without a
    trace. Unifying here costs at most crawling a `www` alias nobody named. Other subdomains
    are **not** implied — `docs.example.com` is a different site's worth of content.
    An omitted `allowedHosts` means no host restriction (an open-web crawl); 1.7 should
    always pass one.
  - **Test infrastructure:** the `RedisFrontierStore` suite runs against a real Redis at
    `redis://127.0.0.1:6379/1` — a different logical database from the dev default — under a
    per-pid key prefix, and **skips itself when no Redis is reachable**, since Redis is a
    docker-compose dev dependency rather than a hard requirement of `npm test` the way
    Postgres is. `.env.test` is untouched, so 0.5's "no Redis configured" tests stay
    meaningful. The store takes an already-constructed client rather than importing
    `db/redis.js`, which both avoids the `vi.resetModules()` dance and forces the
    `redisClient === null` check to happen once, at the crawl entry point, where the error
    message can say what to do about it. Consequence to keep in mind: a machine without
    Redis running silently gets less coverage here.
  - **Constraints this hands forward to 1.5** (same shape as the ones 1.3 wrote for 1.4 —
    each is cheap to honour now and invisible if missed):
    - **Mark both URLs seen.** `add()` marks the requested URL; 1.5 must call
      `markSeen(finalUrl)` with `FetchSuccess.url` after every redirect.
    - **Drain the `popBatch` buffer on shutdown.** Popped URLs are already marked seen but
      no longer queued, so dropping the buffer removes them from the crawl for good —
      `requeue()` them before exiting.
    - **Honour `retryAfterMs` yourself.** The frontier has no notion of time; `requeue()`
      makes a URL immediately poppable again.
    - **Supply a default crawl delay.** Still 1.2's open item: `crawlDelayMs` is `undefined`
      when the site named none, deliberately not defaulted at that layer.
- **Phase 1.5 (Scheduler) — done**, implementing the agreed design recorded under *Phase 1.5
  — Scheduler: agreed design*. Two modules: `crawler/hostScheduler.ts` (the `HostScheduler`
  class — politeness policy) and `crawler/scheduler.ts` (`crawl(options)` — the loop and the
  wiring). 29 new tests; 218 pass overall. **No new dependencies — `p-limit` was never
  installed and is no longer needed.**
  - **`p-limit` dropped, and the reason generalizes.** It is a semaphore over tasks you have
    already ordered; it has no way to express "skip this one, that host is cooling, take the
    next", which is the whole problem. Pre-interleaving the batch only half-works (the tail of
    a batch dominated by one host still saturates), and a worker that sleeps out a crawl-delay
    *inside its slot* holds a slot it isn't using — with one-in-flight-per-host, N−1 slots can
    end up asleep on one host and an 8-wide pool does one request per `crawlDelayMs`. Replaced
    by a **single dispatcher loop** with in-flight capped by a counter. One loop rather than N
    workers because the runtime is single-threaded (N loops buy only shared mutable state) and
    because termination — "the queue is empty" is only true if nothing in flight can still
    discover links — is far easier to get right in one place.
  - **`HostScheduler.next()` returns a four-way discriminated union**, not `QueuedUrl | null`:
    `ready` | `wait{waitMs}` | `blocked` | `empty`. The distinction that earns its keep is
    `wait` vs. `blocked` — "a timer will fix this" vs. "only an in-flight completion will".
    Collapsing them into `null` makes the caller either sleep when it should race (stalling)
    or race when it should sleep (spinning). `wait` is reported ahead of `blocked` when both
    apply, since a timer is actionable information and a completion is not.
  - **`canonicalHost` moved from `frontier.ts` to `url.ts`** (joined by `hostOf`), so scope and
    politeness share one definition. Politeness is about not overloading a *machine*: `http`/
    `https` on one host share a bucket and `www` collapses onto the apex. Note this is
    deliberately **not** the robots.txt key, which stays per-*origin* — different question,
    1.2's key is unchanged.
  - **The cooldown is measured from request *completion*, not start**, so a slow response is
    never followed immediately by the next hit on that host. Test "counts the cooldown from
    release" pins it by advancing the fake clock mid-request.
  - **`Retry-After` is applied to the host, not the URL.** The rejected alternative — an
    in-memory pending-retry list with per-URL timers — is both more machinery and less correct:
    a 503 saying "wait a second" is a statement about the host, so hitting a *sibling* URL
    immediately is exactly as rude as retrying the same one. Folding the wait into the ready-time
    map that the rotation already needs means **no second buffer for shutdown to drain** — which
    matters because the one buffer we do have deletes URLs permanently if dropped.
  - **`FETCH_FAILURE_REASONS` was added to `fetcher.ts`** and `FetchFailureReason` is now derived
    from it. The summary tallies failures per reason and has to enumerate them; a hand-copied
    list here would silently miss any reason added there — the tally would just never count it.
  - **Robots-blocked URLs release the host with zero cooldown** unless `robots.source ===
    "network"`. 1.2 surfacing *where* the answer came from turns out to pay off here: a
    disallow-all host costs no requests at all after the first, so charging every blocked URL a
    full crawl-delay would trickle them out at one per second for nothing.
  - **`onPage` is a callback, so 1.5 does not depend on 1.6**, and `crawl()` takes an
    already-constructed `Frontier` — so `scheduler.ts` imports neither `db/redis.js` nor
    `config.ts`, and 1.7 stays the one place "is Redis configured?" is answered. Tuning knobs are
    `CrawlOptions`/`CRAWL_DEFAULTS`, deliberately **not** env vars: `config.ts` is env for the
    hosted API, which never runs the crawl, and 1.7's `--max`/`--depth` flags would otherwise
    shadow them.
  - **Test infrastructure:** the politeness policy is tested entirely against an injected fake
    clock — no servers, no timers, no sleeps — which is the payoff for splitting it out. The
    `crawl()` tests run against a real `node:http` fixture site. One consequence worth knowing:
    every fixture server binds `127.0.0.1`, so they all share a single politeness bucket, and
    the crawl tests pass `defaultCrawlDelayMs: 0` to avoid serializing the suite behind it.
    Round-robin across hosts is therefore proven in the `HostScheduler` suite, not end-to-end.
  - **Known wart, fixed but unasserted:** the `wait` branch races the timer against an
    in-flight completion, and the timer must be cancelled whichever side wins — it is not
    `unref`'d, so a stray one would hold the process open after the crawl ended, for up to
    `maxRetryAfterMs` (30s). `countdown()` returns a `cancel()` for this. Reproducing it in a
    test needs two hosts cooling independently, which the single-bucket fixture setup above
    cannot express, so this one rests on reasoning rather than a test.
  - **Constraints this hands forward to 1.6/1.7:**
    - **1.7 must abort an `AbortController`, not just stop the loop** — 1.1's backoff timer is
      deliberately not `unref`'d, and the SIGINT path relies on the signal to cut in-flight work
      short. `crawl()` requeues both the popped buffer and any in-flight URL that aborts.
    - **1.6 gets `noindex` and `canonicalUrl` unfiltered.** 1.3 reports them and 1.5 passes them
      through untouched; whether to store a page and whether to trust its self-reported canonical
      remain 1.6's call, exactly as 1.3 specified.
    - **`maxPages` counts successful fetches, not stored pages**, so 1.6's `content_hash` dedup
      can drop duplicates without silently shortening the crawl.
- **Phase 1.6 (Persistence) — done.** One module, `crawler/store.ts` (the `DocumentStore`
  class + `contentHash()`), one migration (`crawl_errors` table, `documents.canonical_url`
  column), and one addition to `scheduler.ts` (`onFailure`). 30 new tests; 248 pass overall.
  No new dependencies.
  - **The document's identity is the parser's normalized final URL** — `ParsedPage.url`, not
    `CrawledPage.url`. The fetcher's final URL is raw; the parser's has been through
    `normalizeUrl`, which is the same string the frontier marked seen. Storing the raw one
    would let a re-crawl that normalizes differently insert a sibling row for a page we
    already hold, and `documents.url` is UNIQUE so the two would never reconcile.
  - **`rel=canonical` is recorded, never obeyed.** 1.3 and 1.5 both deferred "whether to
    trust its self-reported canonical" to here; the answer is no. A template emitting
    `<link rel="canonical" href="/">` on every page — a common CMS misconfiguration — would
    collapse an entire site into one row, silently and unrecoverably. That is the same
    asymmetry that made 1.3 refuse http/https unification: duplicates are recoverable and
    `content_hash` already recovers them. The value is still written to a new
    `documents.canonical_url`, because it exists only while the crawl is running.
  - **`noindex` pages are not stored, and an existing row for one is deleted.** Honouring the
    directive at the storage boundary means it cannot leak into results if Phase 2 or 3
    forgets to filter. The delete is the half that is easy to miss: a page that has *added*
    the directive since the last crawl has to leave the corpus, not merely stop being
    refreshed. Links are still followed — the parser applies `nofollow` separately.
  - **Dedup is one SQL statement, not a SELECT then an INSERT.** `INSERT … SELECT … WHERE
    EXISTS(url) OR NOT EXISTS(content_hash) … ON CONFLICT (url) DO UPDATE`. The `EXISTS(url)`
    half is load-bearing: without it a *known* URL whose new content happens to match another
    document would be turned away as a duplicate and keep serving stale text forever. The
    `xmax = 0` trick distinguishes insert from update for the counters, and is advisory only
    — nothing branches on it. Residual race: two concurrent inserts of different URLs sharing
    a *new* hash both land. Harmless, and the index is deliberately not UNIQUE.
  - **`token_count` resets to 0 only when `content_hash` changed.** Stale postings describe
    text that is gone, so a rewritten page must look unindexed to Phase 2 — but resetting
    unconditionally would drop the entire corpus out of the index on every re-crawl of
    unchanged pages.
  - **`crawl_errors` keyed by URL, upserted, and deleted on a later success.** The table
    describes the *current gaps* in the corpus rather than a history, so a later run can
    re-seed exactly what broke; a summary that only lives in memory loses that at exit.
    `attempts` accumulates across runs, `depth` keeps the shallowest discovery (the frontier
    pops in depth order, so that is the depth a re-seed should use), `first_seen_at` survives
    while the reason and `last_seen_at` refresh. Clearing covers both the pre- and
    post-redirect spellings. A `crawl_runs` table was considered and rejected: run lifecycle
    is 1.7's to own, and timestamps already answer "what broke last night".
  - **`scheduler.ts` gained `onFailure`, and what it stays quiet about is the design.** It
    fires once per URL and only when the crawl has *given up* — a retryable failure with
    requeues left is not a failure yet, `aborted` is our own Ctrl-C rather than evidence about
    the host, and **robots-blocked URLs are never reported**, since a disallow-all host would
    otherwise write thousands of rows that record policy working correctly. `CrawlFailure`
    carries `rounds` (scheduling rounds, read *before* `bumpRequeues` mutates the tally) which
    is distinct from `FetchFailure.attempts` (HTTP requests inside one `fetchPage` call).
  - **`parse-failed` is reachable, barely, and the test that proves it is the interesting
    one.** `parseHtml` returns null only when `normalizeUrl` rejects its page URL, and the
    fetcher has already accepted that URL — so the only gap is a URL under `MAX_URL_LENGTH`
    on the wire that exceeds it once form-urlencoding re-encodes the query (`!` → `%21`),
    arriving as a redirect target the frontier never checked.
  - **`DocumentStore` takes a `Queryable`** (the two-method slice of `pg.Pool` it actually
    uses), not `pgPool`. Importing `db/pg.js` would drag in `config.ts`, and 1.7 stays the
    single place that owns connections — the same rule `scheduler.ts` follows for Redis.
    Tests run against the real migrated test DB: the bugs worth catching here are in the SQL
    itself, which a mocked client can only assert back at us.
- **Phase 1.7 (Entry) — done.** Two modules: `crawler/cliArgs.ts` (`parseCrawlArgs(argv)` —
  pure) and `crawler/cli.ts` (the composition root). `npm run crawl` wired at both the
  workspace and repo root. 12 new tests; 260 pass overall. **No new dependencies** —
  `node:util`'s `parseArgs` plus the `zod` already in the tree.
  - **The frontier resumes by default; `--fresh` clears it.** With `REDIS_URL` set,
    `frontier:seen` outlives the process, so repeating a command legitimately fetches
    nothing. Auto-clearing on startup would make that confusion go away — and would also
    discard an interrupted crawl's state on the *next* invocation, which is precisely what
    1.4's `requeue()`-on-shutdown and 1.5's popped-buffer drain exist to protect. Same
    asymmetry the plan keeps landing on: a wrongly-cleared queue is unrecoverable (nothing
    can reconstruct which URLs were pending), a confusing zero-page run is one flag away
    from fixed. `clear()` runs *before* `crawl()`, which seeds the frontier itself.
    Note the seen-set is **not** the corpus — `documents` rows survive `--fresh`, and
    `DocumentStore`'s upsert is keyed on `url`, so `--fresh` costs bandwidth, not data
    (verified: a re-crawl of 30 fixture pages produced 30 updates and 0 inserts).
    **Amended 2026-08-22:** resuming by default turns out to be the wrong default for the
    *multi-seed* case, which this subphase never exercised. A second crawl with a different
    seed both inherits the previous crawl's leftover queue and finds its own seed already
    marked seen — two separate failures, both silent, both fixed by `--fresh`. The operating
    rule is now **`--fresh` on every crawl after the first** unless you deliberately mean to
    continue the previous one. See *Phase 1 — two scope gaps* above for the evidence.
  - **A configured-but-unreachable Redis is fatal, deliberately unlike 1.2.** There Redis is
    a cache and losing it costs politeness, so the robots layer swallows its errors. Here it
    is the crawl's memory: falling back to a memory store would re-fetch everything while a
    stale seen-set sat in Redis waiting to mislead the next run. The message names both
    exits — start Docker, or unset `REDIS_URL` to choose memory deliberately.
  - **The resume hint reads `seenCount()` *before* the crawl**, and the first version didn't
    — which is the bug the fixture run caught. Asked afterwards, the count cannot tell "the
    frontier was already full from last night" from "this run marked its own seed seen and
    then got nowhere", so the hint fired on a `--fresh` crawl whose only seed was
    robots-blocked.
  - **Progress → stderr, summary → stdout.** A hundred pages at 1 req/s/host runs for
    minutes and silence is indistinguishable from a hang, so per-page progress is a
    requirement rather than a nicety; splitting the streams keeps `npm run crawl > report.txt`
    a clean artifact. Robots-blocked URLs are **counted, not printed** — the same reasoning
    that kept them out of `onFailure` in 1.6. `linksDiscovered` is labelled "links queued",
    not "found": it counts links the frontier *accepted*, so it reads against the frontier's
    rejection counters rather than against the per-page link counts on the progress lines.
  - **Exit codes: 0 drained/max-pages, 130 aborted (128+SIGINT), 1 for bad flags or
    unreachable infrastructure.** A crawl that stored nothing because robots.txt disallowed
    everything exits **0** — that is policy working, not failure. Postgres health is checked
    before the first fetch, since discovering it is down after 60 pages throws all of them
    away.
  - **`parseArgs` + zod, split into its own module for one reason:** it is the only part of
    1.7 testable without infrastructure, the rest being connection lifecycle and signal
    handling. `parseArgs` alone would let `--max abc` through as `NaN`; zod supplies coercion
    and bounds, used exactly as `config.ts` uses it. Parsing is `strict` with
    `allowPositionals: false` — a typo'd flag that parsed silently would run the crawl with
    the limit the user believed they had overridden. Seeds are validated with the crawler's
    own `parseHttpUrl`, not zod's `.url()`, which accepts `ftp:`. Defaults are *imported*
    from `CRAWL_DEFAULTS`/`FRONTIER_DEFAULTS` rather than restated, for the same reason 1.5
    derived `FetchFailureReason` from `FETCH_FAILURE_REASONS`.
  - **Known wrinkle, environmental:** `npm` intercepts `--help`/`-h` before the script sees
    them, so the usage text says to run `npm run crawl` with no flags instead (which prints
    usage and exits 1). Worse on Windows: **PowerShell strips the `--` separator**, so
    `npm run crawl -- --seed …` reaches npm without it and npm eats every flag as its own
    config, leaving the seed as a stray positional. Use Git Bash, or PowerShell's `--%`
    stop-parsing token. This is a shell/npm interaction, not a code defect.
  - **Not verified: the SIGINT path.** The handler aborts an `AbortController` on the first
    signal and hard-exits 130 on the second, per 1.5's constraint that stopping the loop is
    not enough (1.1's backoff timer is deliberately not `unref`'d). The abort *mechanics* —
    requeuing the popped buffer and in-flight URLs — are covered by 1.5's suite; what is
    unproven is only the ~6 lines of signal wiring, because delivering a real SIGINT to a
    Node process from a non-console parent on Windows is unreliable. `returnedToFrontier` was
    exercised via the `max-pages` stop instead, which drains the same buffer.
- **Phase 1 complete.** Verified end-to-end against a real site (`example.com` — 1 page
  stored, its one outbound link correctly rejected `out-of-scope`) and against a 200-page
  local fixture tree (30 pages at `--depth 4`, 30 rejected `too-deep`, 30 rows inserted,
  then 30 updated on re-crawl).
- **Phase 1 — two scope gaps found building the real corpus (2026-08-22), neither fixed.**
  Both were invisible in the fixture-tree verification above, because that crawl used a single
  seed on a single host. They only appear once you run *several* crawls with *different* seeds,
  which is what building a multi-site corpus is.
  - **A leftover frontier queue is drained by the next crawl, whatever its seed.** `add()`
    checks scope; `popBatch()` does not, and it has no reason to — the frontier is one queue,
    and by the time a URL is in it, it has already been judged in scope *by the crawl that
    enqueued it*. But `frontier:queue` outlives the process, so a crawl that stops at
    `maxPages` leaves hundreds of in-scope-for-it URLs behind, and the next crawl pops them
    ahead of its own seed's links.
    Observed: seeding `docs.python.org` after an MDN crawl that hit its cap produced
    **968 MDN pages, 190 Python, 1 React** across three crawls that asked for 480/480/200.
    The Python crawl's *first* fetch was an MDN CSS page. The ordering is not luck either —
    `ZPOPMIN` breaks score ties lexicographically, so at equal depth
    `developer.mozilla.org` < `docs.python.org` < `react.dev`, and MDN won every tie until
    its leftovers ran out.
    **Workaround, and the rule to follow: `--fresh` on every crawl after the first.** It
    clears the queue *and* the seen-set before seeding, which is what makes a new seed's
    links the only thing in the queue. Note this is a second, independent reason for
    `--fresh` beyond the one 1.7 documents (a seed already in `frontier:seen` is rejected as
    `duplicate` and never expanded — which is how an earlier attempt to add CSS to an MDN
    JavaScript corpus added *zero* CSS pages). Re-running the three crawls with `--fresh`
    gave 959/278/199, the intended shape.
    A fix, if one is ever wanted, would be to re-check scope in `popBatch` against the
    *current* crawl's `allowedHosts` rather than trusting the enqueuer — or to give
    `RedisFrontierStore`'s existing `keyPrefix` a CLI flag, so separate crawls can hold
    separate frontiers. The prefix already exists and is already used by the tests; only
    `cli.ts` hard-codes the default.
  - **A redirect target is never scope-checked.** `scheduler.ts:286` calls
    `markSeen(result.url)` when the fetcher reports a different final URL, and line 317
    stores the page under it — but nothing asks whether that host is in `allowedHosts`.
    `add()` is the only scope gate, and a redirect never goes through `add()`.
    Observed: one `18.react.dev` page (React's version-18 docs archive) in a crawl whose
    allowlist was `react.dev`. The leak is **bounded to one page per redirect**, because the
    links found *on* that page do go through `add()` and are rejected — which is why it is
    one row and not a second corpus. Recorded rather than fixed: at this rate it is noise,
    and the honest fix is a scope check at the same place 1.3's forward-constraint already
    asks for special handling of the final URL.
- **Phase 1 — corpus rebuilt on real sites (2026-08-22).** The 4-document fixture is gone from
  the dev database; the corpus is now **1,437 documents / 23,917 terms / 364,961 postings**,
  1.49M tokens, averaging 1,035 tokens per document — MDN JavaScript + CSS (959),
  the Python standard library (278) and react.dev (199), all `en-US`, one crawl error
  (`unsupported-content-type`, the allowlist working). Index rebuild takes 13.9s.
  - **This is the first corpus where IDF does anything.** At N=4 the plan noted `df > N/2` was
    the *common* case, which is why 2.4's `+ 1` was load-bearing; at N=1,437 term weights
    finally separate — `closur` (df 25) scores 2.93 against `scope` (df 87) at 1.70.
  - **Cross-corpus queries are the payoff, and they work:** `async await` returns 86 matches
    whose top three span react.dev *and* MDN, ranked against each other on BM25 alone with no
    per-site weighting. Query latency is **13–18 ms** over 365k postings.
  - **Consequence for this document: the canonical regression numbers are retired.**
    `documents containing` → **1.3765** / **0.1674** with `documentation` bracketed at 41–54 was
    derived from the deleted fixture, and it is quoted in 2.4, 3.1, 3.2, 3.5, 4.2, 4.3, 4.4 and
    4.5 as the check that each new layer changed no ranking. It can be reproduced any time with
    `npm run seed` into an empty corpus, and the **533 automated tests are unaffected** — they
    run against the separate `search_engine_test` database, which none of this touched.
- **Phase 2.1 (Processing pipeline) — done.** Five modules in `server/src/processing/`:
  `normalizer.ts`, `tokenizer.ts`, `stopwords.ts`, `stemmer.ts`, and `pipeline.ts`
  (`processText(input)` → `ProcessedToken[]`, `processQuery(input)` → `string[]`). 48 new
  tests; 308 pass overall. One new dependency: `stemmer` v2.
  - **`stemmer` instead of the plan's `natural` — a deliberate deviation.** Same Porter
    algorithm; 12.9 KB against 13.8 MB, zero dependencies against fourteen. `natural` would
    have installed `mongoose`, a second `redis` client and a second `pg` driver (^8.18
    alongside the repo's ^8.22) into a project that uses one of those and deliberately not
    the other two, and it is CommonJS, so it would have needed the same NodeNext import
    workaround already documented for `ioredis` and `robots-parser`. `stemmer` is native
    ESM and ships its own types. Phase 2.1's subphase text and the cross-cutting table have
    both been updated to match. Nothing imports `stemmer` outside `stemmer.ts` — an index
    built with one stemmer and queried with another silently returns nothing, so keeping
    one call site is what makes a future swap a one-line change plus a reindex.
  - **Normalization runs per *token*, not over the document, and that is load-bearing.**
    NFKC changes string length (`ﬁ` is one character, `fi` is two), so normalizing first
    shifts every offset after it and destroys the mapping back into `documents.content_text`
    — the string 3.2 slices snippets out of. So the tokenizer runs on the *raw* text and
    reports `start`/`end` against it, and each slice is normalized individually.
    `ProcessedToken` carries both, though `postings` stores only the ordinal: 3.2 re-runs
    `processText` over `content_text`, finds the token a posting names, and reads the window
    off these offsets. That works only because the function is deterministic.
  - **Positions are assigned over the full token stream, before stopwords are dropped, and
    never renumbered.** Numbering the survivors would make `search the engine` and
    `search engine` both read as positions 0 and 1, so a phrase query would match text that
    does not contain the phrase. A token that normalizes away to nothing does *not* consume
    a position — a hole in the numbering reads like a dropped stopword to an adjacency check.
  - **Stopwords are matched before stemming**, and the list is stored already-normalized
    (`dont`, not `don't`). Porter turns `does` into `doe` and `having` into `have`, so a
    list consulted after the stemmer would let inflections of its own entries through — the
    words most worth dropping would be exactly the ones that escaped. A test normalizes
    every entry and asserts it is unchanged, since a plausible-looking `don't` in the list
    would be silently dead weight that still looks correct in review.
  - **The diacritic strip is the U+0300–U+036F range, not `\p{M}`** — in Devanagari,
    Arabic and Hebrew the mark is part of the word rather than decoration on it. **A bug the
    test caught:** the final "strip what's left" pass was `[^\p{L}\p{N}]`, and marks are
    neither letters nor digits, so it removed every combining mark and silently undid the
    narrow range above it. The keep set is now `[^\p{L}\p{N}\p{M}]`.
  - **`toLowerCase`, never `toLocaleLowerCase`** — the locale-aware version maps `I` to the
    dotless `ı` under a Turkish locale, which would make the contents of the index depend on
    the machine that built it.
  - **`processQuery` is a thin wrapper over `processText`**, not its own sequence of calls.
    Reimplementing the four steps on the query side is exactly the drift this module exists
    to prevent, and it is the kind that typechecks perfectly and fails silently at runtime.
  - **`processText(...).length` is `documents.token_count`** — survivors, not the raw stream,
    so the length BM25 penalizes a document for is the length its postings actually represent
    (and what `corpus_stats.avg_doc_len` should average).
  - Decisions worth knowing, each pinned by a test: hyphens split (`state-of-the-art` → four
    tokens, recoverable by phrase query; keeping it whole would make the page unfindable by
    "art"), contractions stay whole (`don't` → `dont`, or a bare `t` becomes a term with a
    posting list in every document containing any contraction), digits are indexed, tokens
    over 64 characters are dropped, and an unspaced CJK run is one token — a documented
    non-goal, since proper support needs a dictionary-based segmenter.
  - Known limitations, deliberate: German `ß` survives, so `straße` does not match `strasse`
    (language-specific, and there is no `lang` signal at this layer); the stopword list is
    English-only, which for a French page means a slightly larger index rather than wrong
    results, since those terms are ranked down by their own IDF anyway; and Porter both
    understems (`crawlers`→`crawler` but `crawling`→`crawl`, so the noun and verb stay
    separate) and overstems (`university` and `universal` both → `univers`, which is why
    `terms.surface_form` exists).
  - No database and no fixture server — the whole phase is pure functions, so `npm test`
    still only needs docker-compose Postgres for the *other* suites' `globalSetup`.
- **Phase 2.2 (Inverted index) — done**, implementing the agreed design recorded under *Phase
  2.2 — Inverted index: agreed design*. Two modules in `server/src/indexer/`: `postings.ts`
  (`buildDocumentPostings`) and `invertedIndex.ts` (`buildIndex`/`pickSurfaceForm`), plus one
  new export from 2.1's `pipeline.ts` (`indexableText`). 29 new tests; 337 pass overall.
  **No new dependencies**, and no database — the whole phase is pure functions over an
  injected iterable.
  - **Titles are indexed, and the join is a shared function.** `indexableText({title,
    contentText})` returns `` `${title}\n\n${contentText}` ``, and **3.2 must call it rather
    than reading `content_text`** — it re-derives character offsets by re-running `processText`
    over the same string, so any disagreement about the join shifts every position in the
    document and every snippet quotes the wrong sentence. Test "stores positions that 3.2 can
    resolve back to the document text" pins the round-trip. Not indexing the title was the
    rejected alternative: a term appearing only there makes the page unmatchable by any query,
    which is the unrecoverable direction.
  - **Accepted costs of that join, both recoverable by a reindex:** title tokens count toward
    `token_count` (~10 against hundreds, so a small nudge to BM25's length normalization), and
    a phrase query can match across the title/body seam — a separator cannot burn a position,
    since `processText` skips tokens that normalize to nothing *without* consuming one. 3.2
    should also expect the occasional snippet window to land in the title region.
  - **`doc_freq` is `postings.length`, deliberately not a second field.** The schema stores
    both `tf` and `positions` because query time reads `tf` on every scored row and `positions`
    on almost none, so deriving `tf` with `array_length()` would charge every search for the
    cold path. No equivalent argument exists in memory for a count of an array already in hand
    — only the chance of the two disagreeing. A test asserts one posting per document, which is
    what makes the length a valid `df`.
  - **A repeated document id throws.** The input is an iterable the caller supplies; a duplicate
    would merge two documents' postings into one term entry while `docLengths` kept only the
    last. That is corruption no downstream test would trace back here, so it fails loudly at the
    source instead.
  - **`avgDocLen` is 0 on an empty corpus, never `NaN`** — a `NaN` propagates through every BM25
    score and yields an unranked result list with nothing raised to explain it. A document with
    no indexable tokens still counts toward `totalDocs`: BM25's `N` counts documents, not
    non-empty ones.
  - **Surface-form ties break by shortest, then lexicographic**, so the winner is a function of
    the corpus rather than of the order documents happened to arrive in — the same corpus
    indexed twice must not show a user different words. `pickSurfaceForm` is exported and tested
    directly; building text whose stems tie on count is a lot of indirection to express one Map.
  - **`buildIndex` accepts a sync *or* async iterable** (`for await` handles both), so 2.3 can
    stream from a `pg` cursor while tests pass array literals. `indexer/` imports no database —
    same rule `crawl()` follows for the frontier and `DocumentStore` for its `Queryable`.
  - **Gap this surfaced: Phase 2 has no composition root.** 1.7 exists because something must
    open connections and parse flags; the key decisions call for a batch reindex job
    (`npm run index`) but no subphase owned it. **Assigned to 2.3.**
- **Phase 2.3 (Persistence) — done**, implementing the agreed design recorded under *Phase 2.3
  — Persistence: agreed design*. Three modules in `server/src/indexer/`: `indexStore.ts`
  (`streamDocuments`/`writeIndex`/`readCorpusStats`), `indexArgs.ts` (`parseIndexArgs` — pure)
  and `cli.ts` (Phase 2's composition root). `npm run index` wired at both the workspace and
  repo root. 20 new tests; 357 pass overall. **One new dependency: `pg-copy-streams` v7**, which
  has no runtime dependencies of its own, plus `@types/pg-copy-streams` as a devDep.
  - **A full rebuild, not an upsert — revising the subphase text below.** `doc_freq` is a
    corpus-global count, which is exactly why 2.2 refused to flush in batches; merging a
    `BuiltIndex` into existing rows is that same rejected thing moved down to the SQL layer.
    Every term absent from the new build would keep a stale `doc_freq` and go on voting in
    IDF for a term that no longer exists. The one argument for upserting — preserving
    `terms.id` — turns out to have no claimant: `postings.term_id` is the only reference, and
    it is rewritten in the same transaction. 3.3's autocomplete reads `surface_form` and
    `doc_freq`; 3.1 looks terms up by stem. **Incremental reindex was left to 2.5**, which
    resolved it as unnecessary — the rebuild answers the `doc_freq` question by recomputing it.
  - **`DELETE`, not `TRUNCATE`, and the difference is not cosmetic.** Per the hosting model
    this job runs on a dev machine against the *same* Postgres the deployed API reads.
    `TRUNCATE` takes an ACCESS EXCLUSIVE lock, so every concurrent `/search` would block for
    the whole rebuild; `DELETE` takes ROW EXCLUSIVE and MVCC keeps readers serving the old
    index from their snapshot until the transaction commits. Same atomicity, no stall, one
    word of difference. Accepted cost: dead tuples for autovacuum to reclaim, noise at this
    corpus size. Escape hatch if it stops being noise — load into `terms_new`/`postings_new`
    and `ALTER TABLE … RENAME`, which changes nothing above `writeIndex`.
  - **`COPY` for `postings`, parameterized INSERT for `terms` — the split is about text, not
    speed.** `COPY`'s text format assigns meaning to tabs, newlines, backslashes and `\N`, all
    of which the producer has to escape. `postings` has no text column — it is
    `(int, int, int, int[])` — so every field serializes to digits, commas and braces and
    there is nothing left to escape, which is what makes `COPY` *safe* here and not merely
    fast. `terms` is the opposite: small (~10k rows) and holding text taken straight off a web
    page, so the driver owns the escaping. It also needs `RETURNING id, term` to build the
    `Map<stem, termId>` the postings load translates through, which `COPY` cannot give back.
    A test writes a stem containing a tab, a newline and a backslash, so a later "make it all
    `COPY` for speed" change has something to fail against.
  - **Keyset pagination, not `pg-cursor`.** A cursor needs its own client checked out for the
    whole build and leaks a connection if it is not closed on the error path; `documents.id`
    is a serial PK, so `WHERE id > $1 ORDER BY id LIMIT $2` in an async generator is ~10 lines,
    no dependency, and no lifecycle to get wrong. It also reads on a different connection from
    the write transaction, which is what we want while that transaction holds delete locks.
    Streaming earns its keep because `content_text` across a corpus is far larger than the
    index derived from it — 2.2 accepted holding the finished index in memory, not every
    page's prose at once.
  - **Batches pass arrays through `unnest`, not one placeholder per row.** `INSERT INTO terms
    … SELECT * FROM unnest($1::text[], $2::int[], $3::text[])` costs three parameters whatever
    the batch size, so Postgres's 65535-parameter ceiling never enters into it; the batch size
    bounds memory instead of dodging a limit. Same shape for the `token_count` writeback.
  - **The BIGINT conversion lives in `readCorpusStats`, once.** `corpus_stats.total_tokens` is
    BIGINT and node-postgres returns it as a *string*; `CorpusStats.totalTokens` is a JS
    number. A `Number(...)` at each call site is a `NaN` waiting for the one site that forgets,
    so there is exactly one. It is sent as a string on the way in for the same reason. The CLI
    prints the stats **read back** rather than the ones in memory — the only thing that
    actually proves the round trip, since a summary printed from `index.stats` looks identical
    either way.
  - **`token_count` writeback is the half that is easy to miss.** 1.6 zeroes the column
    whenever a page's `content_hash` changes — that is how a rewritten page signals "my
    postings describe text that is gone". 2.3 fills it back in, and BM25's length
    normalization divides by it, so a build that skipped it would leave every re-crawled
    document looking zero-length to 2.4.
  - **The whole write is one transaction**, with `ROLLBACK` on the error path and the original
    error re-thrown (a rollback that itself fails must not replace the error that caused it).
    A partial flush would leave the API serving an index whose postings and `doc_freq`s
    disagree, with nothing raised to say so. Test: a posting naming a nonexistent `doc_id`
    fails the FK *inside* the `COPY`, after the DELETEs and the term INSERT have run, and the
    previous index is still intact afterwards.
  - **`pg-copy-streams` imports cleanly under NodeNext** — `import { from as copyFrom }` works
    with no cast, unlike `ioredis` and `robots-parser`. Verified before committing to it.
    Backpressure is handled by `pipeline(Readable.from(rows), stream)` rather than a
    `stream.write()` loop, so a corpus with more postings than fit the socket buffer does not
    simply grow the buffer.
  - **Test infrastructure:** `indexArgs.test.ts` needs no infrastructure (the reason arg
    parsing is split out at all, exactly as 1.7 split `cliArgs.ts`); `indexStore.test.ts` runs
    against the real migrated test DB, because everything worth catching here is in the SQL,
    the `COPY` encoding and the transaction boundary. One wart: `Array.fromAsync` exists on
    Node 22 but not in the `ES2022` lib this project targets, so the test file has a
    four-line `collect()` helper rather than widening `lib` for the whole server.
  - **Verified end-to-end** against the dev corpus: 4 documents → 36 terms, 40 postings, 59
    tokens; `surface_form` populated as designed (`document`→`documents`,
    `build`→`building`, `contain`→`containing`); every `doc_freq` agrees with its posting
    count; a second run reproduces the same numbers.
  - **Constraints this hands forward to 2.4/2.5:**
    - **Read `corpus_stats` through `readCorpusStats`**, not with a raw query — it is the only
      place the BIGINT string is converted, and 2.4 needs `N` and `avgdl` on every score.
    - **`doc_freq` and `token_count` are only correct after an index run.** A corpus crawled
      but not indexed has `token_count = 0` on every re-crawled row, so 2.4 must not treat a
      zero length as a corpus-wide `avgdl` of zero.
    - **Incremental reindex and delete were handed to 2.5 — which resolved them as
      unnecessary.** `DELETE FROM documents` cascades to `postings`, and the next build
      recomputes every `doc_freq` from an unfiltered pass over `documents`, so there is nothing
      to maintain incrementally. See Phase 2.5 in Status.
- **Phase 2.4 (Ranking) — done**, implementing the agreed design recorded under *Phase 2.4 —
  Ranking: agreed design*. Five modules in `server/src/ranking/`: `bm25.ts` (`idf`/`tfWeight`/
  `bm25Score`), `scorer.ts` (`uniqueTerms`/`scoreDocuments`/`rankDocuments`), `searchStore.ts`
  (`fetchTermPostings`/`fetchDocuments`), `searchArgs.ts` (`parseSearchArgs` — pure) and
  `cli.ts`. `npm run search` wired at both the workspace and repo root. 54 new tests; 411 pass
  overall. **No new dependencies.**
  - **The `+ 1` in the IDF justified itself on the first real query, which is why it is worth
    recording rather than assuming.** In the dev corpus `document` has `df = 4` out of `N = 4`;
    the textbook Robertson–Spärck Jones form gives `ln(0.5 / 4.5) = −2.197`, so *every* result
    matching it would have carried a negative contribution and the ranking would have inverted —
    documents mentioning the query term most would have ranked last. With the `+ 1` it is
    `+0.1054`: near zero, contributing almost nothing, which is the correct answer for a word in
    every document. On a corpus this size `df > N/2` is the ordinary case, not an edge case.
  - **OR-with-summation behaves as designed, measurably.** `documents containing` scores the one
    page holding both stems at **1.3765** and the next at **0.1674** — an 8× gap produced purely
    by adding a second positive contribution, with no coordination bonus and no AND filter. That
    is the whole argument for OR over strict AND on a small corpus: precision arrives at the top
    of the list instead of by way of an empty page.
  - **`searchStore.ts` lands a phase earlier than the plan assigned it**, per decision 7. Without
    it 2.4 would ship two modules exercisable only by hand-written fixture numbers, and no query
    could run against the real corpus until Phase 3 — the same gap 2.3 closed by printing
    `corpus_stats` read back from Postgres. **3.1 must reuse `fetchTermPostings`/`fetchDocuments`
    rather than writing its own version of that join.** The split it establishes is the one 3.1
    wants anyway: score over the candidate set, then hydrate only the page being returned, since
    `documents` holds `content_text` and joining the corpus's prose into a query that produces
    four integers per row would make the expensive half of a search the half nobody reads.
  - **The dropped TF-IDF baseline is replaced by one test, not by nothing.** `b = 0` with
    `k1 = 1e9` collapses BM25's TF term to raw `tf`, so the formula degenerates to `tf × IDF` —
    and that is asserted. It checks the *shape* of the formula rather than one point on it, which
    is what catches an inverted term, a misplaced parenthesis or `b` applied to the numerator;
    hand-computed known-answer vectors (also present) can pass straight over all three.
  - **Three guards, each returning a neutral value rather than a `NaN`**, and the direction of
    failure is why they exist. A non-positive `token_count` substitutes `avgdl`, because length 0
    collapses the norm to `1 − b` and *inflates* the score — a stale document would rank above
    correctly-indexed ones. `doc_freq` is clamped to `total_docs`, or a negative numerator makes
    `Math.log` return `NaN` that then propagates through every score in the list with nothing
    raised to say where it came from. An empty corpus scores 0.
  - **Ties break by `docId`.** Phase 3 paginates by offset, so an ordering that is a function of
    evaluation order rather than of the corpus shows the same document on pages 1 and 2 and
    silently drops another. Scores are returned **raw** — unbounded and not comparable across
    queries, and normalizing to a percentage of the top hit would make the best result always
    100%.
  - **Duplicate query stems are deduped in `uniqueTerms`, at both the store and the scorer.**
    `processQuery` preserves duplicates deliberately, so `new york new york` would otherwise
    weight `york` double; the ordered multiset is left untouched for 3.2's highlighting.
    `scoreDocuments` throws on a repeated term for the same reason `buildIndex` throws on a
    repeated document id — it is corruption no downstream test would trace back here.
  - **Test infrastructure:** `bm25`, `scorer` and `searchArgs` need no infrastructure at all
    (44 of the 54 tests), which is the payoff for keeping the scorer pure and splitting flag
    parsing out exactly as 1.7 and 2.3 did. `searchStore.test.ts` runs against the real migrated
    test DB, because what is worth catching there is the three-table join, the
    `= ANY($1::text[])` binding and the regrouping of a flat row set into posting lists.
  - **Verified end-to-end** against the dev corpus (4 documents, 36 terms): the ranking above,
    plus `--explain` reporting per-term `df`/IDF/posting counts, a stopword-only query exiting 0
    with a message rather than returning the corpus, an unmatched query reporting no matches, and
    `--limit`/`--b` taking effect.
  - **Constraints this hands forward to 3.1/3.2:**
    - **Reuse `searchStore.ts`.** Two hand-written joins over the same three tables is the drift
      `processQuery` exists to prevent one layer up.
    - **`rankDocuments` does not paginate.** Ask for `offset + pageSize` as the `limit` and slice.
      *(Half-superseded by 3.1 decision 1: the "does not paginate" half stands, the `limit`
      advice does not — it makes `SearchResponse.total` unknowable and saves nothing, because
      `scoreDocuments` has already materialized the whole candidate set by then.)*
    - **`matchedTerms` is what 3.2 highlights from** — it records a match even when the term's IDF
      is zero, because the user can plainly see the word in the snippet.
- **Phase 2.5 (Maintenance) — resolved without implementation; 2.3's full rebuild subsumes it.**
  The subphase was scoped as reindex/delete handling plus recomputed stats. Checked against the
  code rather than against this plan's own narrative: `writeIndex` deletes *all* postings and
  *all* terms and rebuilds from `streamDocuments` — an unfiltered `SELECT … FROM documents ORDER
  BY id` — then rewrites every `token_count` and upserts `corpus_stats`, in one transaction. Every
  number is recomputed from whatever `documents` currently holds.
  - **Delete handling needs no code.** The only path that removes a document is 1.6's `noindex`
    delete in `crawler/store.ts`. A deleted row is simply not streamed on the next build, so its
    contribution to `doc_freq` and `corpus_stats` does not go stale — it ceases to exist. There is
    nothing left to recompute, which is what 2.3's forward-constraint assumed there would be.
  - **The staleness window is the workflow, not a defect.** It runs from a delete to the next
    index run — but 1.6 zeroes `token_count` whenever a page's `content_hash` changes, so a crawl
    *already* obligates a reindex in order to be correct. Deletes ride along on a pass that was
    required regardless.
  - **Incremental reindex is declined, not deferred.** It is a performance fix for a problem the
    corpus does not have (2.2 put the ceiling at tens of thousands of documents; the dev corpus is
    four), and it is the same shape of thing this plan has already rejected twice — 2.2 refused
    batched flushing and 2.3 refused upserts, both because `doc_freq` is corpus-global and
    unknowable until every document has been read. A third attempt would add a second way to
    produce an index, with the full rebuild as the only authority on which of the two is wrong:
    exactly the argument 2.4 used to drop the TF-IDF baseline. Revisit only on evidence — a
    rebuild slow enough to notice.
  - **What the subphase did surface is observability, and it belongs to Phase 3.** Nothing reports
    that the index is behind the corpus, and — the half that matters — nothing tells the *API*.
    3.3 refreshes its autocomplete index "on reindex" and 3.4 clears its cache "on reindex", but
    per the hosting model the index job runs locally while the API is a separate always-on
    instance that never observes the rebuild, so that hook had no mechanism. The signal already
    exists: `corpus_stats.updated_at`, written by `writeCorpusStats` on every run. Polling it
    gives 3.3/3.4 their trigger; comparing it against `max(documents.fetched_at)` gives 2.3's CLI
    a "the index is N documents behind" warning. Recorded against Phase 3 below.
- **Phase 2 complete.**
- **Phase 3.1 (Search service) — done**, implementing the agreed design recorded under *Phase 3.1
  — Search service: agreed design*. One module, `search/queryProcessor.ts` (`searchQuery`), plus
  the refactor of `ranking/cli.ts` onto it. 12 new tests; 423 pass overall. **No new
  dependencies.**
  - **`total` is the whole candidate set, amending 2.4's forward-constraint.** Following it
    literally — `limit: offset + pageSize` — would have made `SearchResponse.total` unknowable,
    and it saves nothing: `scoreDocuments` has already built its map over every posting of every
    term by the time `rankDocuments` sorts, so a limit spares one `Array.slice` and not one
    comparison. The CLI gained an ability from this on the spot — it can now print
    `4 results, showing 2`, which the truncated list could not express.
  - **Three statuses, and `stats` is `null` for one of them.** `ok` | `empty-index` |
    `no-searchable-terms`, with "no matches" deliberately being `ok` with `total: 0`. The
    stopword-only branch returns before any I/O, so it has no corpus stats to report — and
    returning zeros there would have made it indistinguishable from `empty-index` to anyone
    reading the numbers instead of the status. Typed as a discriminated union
    (`SearchedPage` | `UnsearchablePage`) so the narrowing is the compiler's job rather than a
    non-null assertion at each call site.
  - **`RankedResult`, not `shared`'s `SearchResult`.** The wire type requires `snippet` and
    `matches`, which are 3.2's; stubbing them would typecheck, look implemented, and ship if 3.2
    slipped.
  - **The CLI refactor is verified behaviour-preserving against the recorded numbers.**
    `documents containing` still scores **1.3765** and **0.1674** — the exact values 2.4 wrote
    into this plan — which is the only real evidence that moving the pipeline out of `cli.ts`
    changed nothing. `--explain` now reads its per-term `df`/IDF off the returned
    `TermPostings[]` instead of fetching them again.
  - **Two test assumptions were wrong and the code was right**, which is worth recording because
    the failure mode is a plausible-looking test: `crawler` stems to `crawler`, not `crawl` —
    2.1's documented Porter understemming. A test asserting `["crawl"]` for a query containing
    `crawler` looks correct in review and fails only against the real stemmer.
  - **One test stubs rather than using the pool**, and it is the one that cannot be reached
    through it: `fetchTermPostings` inner-joins `documents`, so every candidate had a row when it
    was scored, and only a delete landing between the ranking query and the hydration query can
    produce a missing one. The service drops it rather than emitting a placeholder URL into an
    API response; `total` transiently overstates by one, which the next query corrects.
  - **Constraints this hands forward to 3.2/3.4/3.5:**
    - **3.5 must not forward `k1`/`b` from the query string.** They are on `SearchOptions` for
      tests and the CLI. 3.4's cache key is *normalized query + page*, so a caller-supplied `k1`
      silently becomes a third key dimension and an unbounded way to fill the cache.
    - **3.5 owns `MAX_QUERY_LENGTH` and `MAX_PAGE_SIZE`.** `searchQuery` trusts its options and
      only applies defaults; the CLI's own bound (`--limit` up to 1000) is `parseSearchArgs`'s,
      and the two differing is decision 5 working rather than a disagreement.
    - **`GET /api/health` still echoes `defaultPageSize`**, a 0.2-era proof that the `shared`
      workspace resolves. It does not belong on a health check — remove it and its assertion in
      `api/server.test.ts` when the real endpoints land.
    - **`corpus_stats` is read per query and not memoized**, deliberately, so 3.4 can hoist it
      behind its own reindex poll if it wants to.
- **Phase 3.2 (Snippets + highlighting) — done**, implementing the agreed design recorded under
  *Phase 3.2 — Snippets + highlighting: agreed design*. One new module, `search/snippets.ts`
  (`buildSnippet`), plus `content_text` on `fetchDocuments`, `snippet`/`matches` on
  `RankedResult`, and bracket rendering in `ranking/cli.ts`. 17 new tests; 440 pass overall.
  **No new dependencies — `dompurify` was not installed.**
  - **`postings.positions` is still not read by anything, and that is the design.** Re-running
    `processText(indexableText(doc))` reproduces the stored ordinals *and* supplies the character
    offsets postings cannot hold, so the stored copy is the same fact minus the half a snippet
    needs. Verified on the dev corpus by the query `documents containing`, whose fourth result
    brackets **`documentation`** — the stem `document` located at a real offset inside a longer
    surface form, which is only possible from the re-run. Consequence recorded honestly: the
    column now has no reader in the codebase and stays justified by phrase queries, which have
    never been scheduled.
  - **Verified behaviour-preserving against the recorded numbers.** `documents containing` still
    scores **1.3765** and **0.1674** — the values 2.4 wrote into this plan and 3.1 re-confirmed —
    so widening the hydration query and adding a per-result pipeline pass changed no ranking.
  - **Distinct-terms-first window selection paid off on the first real query.** Result 1's
    snippet contains both `documents` *and* `containing`; a window scored by match count would
    have picked the denser run of `documents` alone and shown a snippet with no `containing` in
    it. A monotonic two-pointer, so a document with hundreds of matches costs one pass.
  - **The CLI renders through the offsets rather than re-finding the terms**, which is the only
    end-to-end proof that decision 4's arithmetic holds: an off-by-two from the `… ` prefix would
    print the bracket one word to the left, exactly as it would render in a browser.
  - **A test assumption was wrong and the code was right**, the same failure mode 3.1 hit: the
    first version of the distinct-terms test used the default 300-character budget on a body
    short enough that both clusters fit one window, so it asserted a choice the builder was never
    asked to make. Forcing the budget below the gap is what makes it a test.
  - **Two edge cases found by writing the guards rather than by a failing test**, both recorded
    in comments so a later simplification has something to fail against: clamping the snapped end
    to `min(clusterEnd, end)` rather than `clusterEnd`, or a cluster wider than the budget would
    grow the snippet past `maxLength` to restore a match the window never promised; and deciding
    the ellipses from the *window* bounds rather than the trimmed ones, or trimming a trailing
    newline off the last block would mark a complete snippet as truncated.
  - **Block separators become spaces, and equal length is what makes it safe** — 1.3 emits `\n`
    between blocks, and a one-character substitution leaves every offset computed above it
    untouched. Any collapsing transform would need a full index mapping to stay correct.
  - **Test infrastructure:** 15 of the 17 tests need no infrastructure at all — the payoff for
    keeping `snippets.ts` pure, the same split 2.4 made for `bm25`/`scorer`. The two in
    `queryProcessor.test.ts` run against the real migrated test DB and prove only the wiring:
    that `content_text` survives the hydration query and that the offsets reaching a caller index
    into the snippet they were built from.
  - **Constraints this hands forward to 3.4/3.5 and Phase 4:**
    - **The snippet is untrusted text and no HTML is produced.** 4.4 renders it as text nodes
      split at the offsets — never `dangerouslySetInnerHTML`. 5.6's XSS test targets the client's
      renderer, which is the only place an injection could land.
    - **Match offsets index into `snippet`, not into the document.** A client that adds a base of
      its own will highlight the wrong words.
    - **`RankedResult` is now structurally `shared`'s `SearchResult` plus `matchedTerms`**, so
      3.5's mapping to the wire type is a projection rather than a build step.
    - **Snippet building is per result and re-runs the pipeline over the document text** — an
      accepted cost, absorbed by 3.4's cache on repeat queries. Per-`docId` memoization is the
      escape hatch if 5.4 measures a reason for one.
- **Phase 3.3 (Autocomplete) — done**, implementing the agreed design recorded under *Phase 3.3
  — Autocomplete: agreed design*. One new module, `search/autocomplete.ts` (the `SuggestIndex`
  class), plus `updatedAt` on the corpus-stats read. 33 new tests; 473 pass overall. **No new
  dependencies.**
  - **`corpus_stats.updated_at` had a writer and no reader until now**, which is the gap 2.5
    handed to Phase 3 and the reason the "poll it" answer needed code rather than just a
    decision: `readCorpusStats` did not select the column and `CorpusStats` had no field for it.
    It is now returned as `PersistedCorpusStats` — a persistence-only supertype, deliberately
    **not** a field on `CorpusStats` itself, because that type is what `buildIndex` computes in
    memory (where no such timestamp exists) and what the pure scorer takes. Putting it there
    would force `buildIndex` to invent a value and make every ranking fixture carry a number it
    never reads.
  - **It is epoch milliseconds, and the `Date` version is a real trap rather than a style
    preference.** TIMESTAMPTZ comes back from node-postgres as a JS `Date`, and
    `new Date(x) !== new Date(x)` is *always* true — it compares object identity, not the
    instant. A poll holding the previous `Date` therefore detects a reindex on **every tick**,
    rebuilding the array forever and burning a query per keystroke, while reviewing as obviously
    correct. `indexStore.test.ts` gained a test that `writeIndex` moves the column and that it
    arrives as a number, since nothing read it before and a write that quietly stopped
    refreshing it would strand every API instance on a stale index with nothing raised.
  - **The typed prefix goes through `normalizeToken` alone — the first deliberate exception to
    "always reuse the pipeline."** `processQuery` is wrong here twice, and both failures return
    an *empty* list rather than a wrong one, so neither would announce itself: it stems, and the
    stem of a partial word matches nothing (`comp` stays `comp` while the array holds
    `computer`), and it drops stopwords, so typing `th` on the way to `throughput` would find
    nothing at all. `normalizeToken` is the one step that makes typed text comparable to a
    stored `surface_form`, because it is the step 2.1 used to produce those surfaces. Two tests
    pin each half.
  - **Sorted by surface, ranked by `doc_freq`, so the prefix range has to be scanned.** Two
    binary searches would find the range but cannot order it, since `doc_freq` is unordered
    within it — taking the first `limit` off the front returns alphabetical order wearing a
    ranking's clothes. Test "keeps the highest-weighted matches, not the first ones found" pins
    it. The scan is bounded by the vocabulary rather than the corpus (~10k terms → a few
    thousand entries on a one-character prefix), and the top-N cap stays the recorded escape
    hatch.
  - **The sort is in JS and deliberately not in SQL.** There is no `ORDER BY` on the terms
    query: the range walk continues while `startsWith` holds, which is valid only if the sort
    agrees with `startsWith` about ordering, and both `localeCompare` and a default Postgres
    collation can place `co-op` between `coa` and `cob` — the walk then stops early and silently
    drops suggestions. A test feeds rows in scrambled order to keep the module responsible for
    its own invariant.
  - **`surface_form IS NOT NULL` at the source, superseding 0.4's `COALESCE(surface_form,
    term)`.** The fallback surfaces a bare *stem* to a human, which is precisely what the Phase
    0 display-form decision spent a column to avoid; a suggestion that cannot be typed as a word
    is worse than one fewer suggestion. 2.3 populates the column for every term it writes, so
    the filter discards rows that should not exist, and the in-memory array carries no nullable
    field to re-check on the hot path.
  - **Ties break shortest-then-lexicographic**, the rule 2.2 set for `pickSurfaceForm` and 2.4
    for `docId`, in the third place it comes up — equal `doc_freq` is the common case on a small
    corpus, and an order falling out of however Postgres returned rows shows two users different
    suggestions over identical data. It is also the better answer for a person: `car` before
    `cardiovascular`.
  - **Multi-word input completes the last token and echoes the head verbatim** (`web cr` →
    `web crawler`), so the client never has to splice a fragment back onto the input. The split
    is on whitespace rather than through `tokenize`, because "what is the user still typing" is
    a cursor fact rather than a token fact — a tokenizer that splits `state-of-the-art` into
    four tokens would offer to complete `art` while the user is plainly mid-word. Trailing
    whitespace means nothing is being typed, so it returns `[]`.
  - **Staleness policy: opportunistic poll, injected clock, no `setInterval`.** The request that
    detects a version move waits for the rebuild (one indexed query); a request arriving while a
    rebuild is already in flight is answered from the current array, so a burst of keystrokes
    costs one rebuild rather than one each. A background interval inside a library module is a
    process that will not exit and a test that hangs with no indication why — 1.1's backoff
    timer and 1.5's `countdown` are both deliberately not `unref`'d for related reasons.
  - **Failure handling is asymmetric on purpose:** a poll that throws *after* a successful build
    is swallowed and the existing array served — 1.2's call for a dead Redis, degrade rather
    than stop — while one that throws with nothing built propagates, because a silent `[]` there
    is indistinguishable from an empty corpus. "Built and empty" is likewise kept distinct from
    "never built", or an unindexed corpus would re-query `terms` on every keystroke forever.
  - **A test deadlocked and the code was right**, the same failure mode 3.1 and 3.2 each hit
    once. The first version of the in-flight test issued two `suggest()` calls back to back;
    both passed the version check before either registered a rebuild, so the second correctly
    deduped onto the first's gated promise and waited. That is the desired behaviour — it is
    just not the behaviour under test, so the test now waits for the rebuild to register first.
  - **Test infrastructure:** 30 of the 33 tests need no infrastructure at all — the payoff for
    `SuggestIndex` taking a `Queryable` and a clock, the same split that let 44 of 2.4's 54
    tests run without a server. The prefix arithmetic, ranking order, staleness policy, failure
    handling and concurrency all run against a fake client with a gate that holds a query open.
    Three run against the real migrated DB, where what is worth catching lives: the `NOT NULL`
    filter and the `updated_at` round trip.
  - **Verified end-to-end** against the dev corpus (4 documents, 36 terms, 0 null surface
    forms): `doc` → `documents` (weight 4) — the surface form, not the stem `document`, which is
    the whole reason `terms.surface_form` exists; `c` → `crawler` then `containing`, equal
    `doc_freq` broken shortest-first; `documents c` → `documents crawler`, head preserved;
    `web ` and `zzz` → nothing.
  - **Constraints this hands forward to 3.4/3.5:**
    - **3.4 polls the same `updated_at` through `readCorpusStats`.** A second single-row query
      over `corpus_stats` is one more thing to reconcile — and 3.1 decision 6 left that read
      unmemoized *specifically* so the cache could hoist it behind its own poll.
    - **3.5 constructs one `SuggestIndex` for the process lifetime** and may call `refresh()`
      at startup **without awaiting it**, so the first person to type gets a warm index without
      `listen` waiting on Postgres.
    - **`SUGGESTION_LIMIT` is a default this module applies, not a bound it enforces.** Clamping
      a caller-supplied `limit` is 3.5's zod middleware's job, exactly as `MAX_QUERY_LENGTH` and
      `MAX_PAGE_SIZE` are per 3.1 decision 5.
    - **Suggestions are untrusted text**, taken from crawled pages via `surface_form`. The same
      obligation 3.2 recorded for snippets applies: 4.4 renders them as text nodes, never
      `dangerouslySetInnerHTML`.
- **Phase 3.4 (Result cache) — done**, implementing the agreed design recorded under *Phase 3.4
  — Result cache: agreed design*. Two new modules — `search/corpusVersion.ts` (the `CorpusVersion`
  watcher) and `search/cache.ts` (`ResultCache`, `cacheKey`, `toCachedPage`) — plus the refactor
  of `SuggestIndex` onto the shared watcher. 42 new tests; 515 pass overall. **One new
  dependency: `lru-cache` (11.5.2)**, the only one Phase 3 has added; the reasoning is under *the
  byte bound* below.
  - **The subphase is mostly a refactor, and that was the point.** Written as scoped, 3.4 was a
    second staleness policy: a throttle, an in-flight guard, a clock and a degrade rule already
    written once in 3.3, to be kept in agreement with the first copy forever. Extracting the poll
    into `CorpusVersion` made the cache itself a `Map` with two rules. Both new modules are
    smaller than any of 3.1's, 3.2's or 3.3's.
  - **`SuggestIndex` kept its reaction and lost only its poll.** The rebuild, the swap-as-a-unit
    and the `null`-means-never-built distinction are untouched; `#minPollIntervalMs`, `#now` and
    `#lastPollAt` are gone. The constructor still accepts `minPollIntervalMs`/`now` and forwards
    them to a watcher it builds itself, so a single-consumer caller and all 32 existing tests
    construct it unchanged, while 3.5 passes one shared `version` instead.
  - **The degrade rule moved with the poll and got simpler by being restated.** 3.3 expressed it
    over the array ("swallow if something is built, propagate if nothing is"); over the *read* it
    is "return the last version I read, throw only if I never read one", which is the same rule
    without reference to any one consumer's data — so the cache inherits it for free. `null` is
    deliberately distinct from `0` here: `readCorpusStats` returns `0` for an unindexed corpus,
    which is a real answer, and conflating the two would make a failure there propagate.
  - **A version read *after* the data it stamps is a silent staleness bug, and 3.3 had one.**
    `SuggestIndex.#rebuild` read `updated_at` after its rows in the branch `refresh()` takes,
    which stamps rows fetched before a reindex with the version written after it — the comparison
    then reports "unchanged" forever and the index stays stale until something unrelated moves the
    column. The comment above it described the opposite ordering as the broken one. Fixed to read
    first, where the failure mode inverts into a redundant rebuild that costs one query and
    corrects itself. The common path was never affected — `#maybeRefresh` already passed a version
    read first — so nothing failed, which is exactly why it survived 33 tests.
  - **A test assumption was wrong and the code was right**, the fourth time in Phase 3 (3.1, 3.2
    and 3.3 each hit it once). `does not start a second rebuild while one is running` released its
    gate synchronously, assuming the terms query is the first thing `refresh()` does; the version
    read now precedes it, so the gate fired before anything was holding it and the test deadlocked.
    It waits for the query to register, exactly as its sibling test already did. The dedup under
    test was never affected — `#rebuilding` is still set synchronously.
  - **The key is `JSON.stringify([stems, page, pageSize])`, not a joined string.** The first
    version joined on a space and was ambiguous: `["web", "crawler"]` and `["web crawler"]`
    produce the same key, so two different queries would share one entry with nothing to report
    it. That input cannot occur while 2.1's tokenizer splits on whitespace — which is the
    problem, because it makes this key's correctness a property of a module two phases away.
    Encoding removes the question. The test that caught it asserts an input that cannot happen,
    which is the only kind of test that would have.
  - **`terms` is excluded from the stored value because it is unbounded.**
    `TermPostings.postings` is the full posting list per query term, so a verbatim `SearchPage`
    entry's footprint scales with `doc_freq` — one common word caches every posting in the corpus,
    and an entry-counting LRU would bound the entry count while bounding nothing that matters.
    Without it an entry is one page of results and snippets capped at 300 characters: a few KB,
    so the 500-entry cap is single-digit MB and can be stated rather than guessed at.
  - **`query` is excluded because it is not a function of the key.** Keying on stems is what makes
    `Documents` and `documents` one entry; `SearchPage.query` echoes what was typed, so a shared
    entry would answer one caller with another's spelling. Excluding it makes the stored value
    genuinely a function of its key — the property that makes sharing safe — and 3.5 re-attaches
    the live query. `CachedPage` is a **distributive** `Omit`: a plain one collapses 3.1's
    discriminated union and would let `status: "ok"` pair with `stats: null`.
  - **The TTL is a backstop and says so.** Invalidation is exact — the version moves, the map
    clears — so a TTL adds nothing to correctness. It stays for the one case the version cannot
    cover: a signal that stops moving because the indexer died before writing `corpus_stats`,
    leaving a cache confidently serving a corpus that no longer exists. 5 minutes, 500 entries,
    LRU by last *read*.
  - **The byte bound is why `lru-cache` is a dependency, and the entry count was not enough.**
    This shipped first as a hand-rolled `Map` — insertion order is recency order, delete-then-set
    on a read promotes, `keys().next()` evicts — which was six correct lines and passed four
    tests. What it could not do is bound *memory*, only entries, and entries are not uniform:
    `pageSize` is part of the key, so a page of 50 results costs five times a page of 10 while
    counting the same. A 500-entry cap therefore covered anything from a few MB to a few dozen
    depending on what callers asked for, and the "single-digit MB" this plan claimed was true
    only at the default page size. `maxSize` with a `sizeCalculation` makes the bound the real
    quantity; `estimateSize` is the serialized length, an approximation that *tracks* the cost
    because a cached page is almost entirely snippet text. `max` stays as a secondary cap against
    many tiny entries. Everything else about the class — the version gate, the key, the
    projection — was unchanged by the swap, which is what made it a contained decision: the
    public surface is `get`/`set`/`clear`/`size`/`version`, so the internals were replaceable
    without touching a caller.
  - **Two tests failed on the swap, and both were pinning the old implementation rather than the
    contract.** `lru-cache` treats an entry as stale only once its age is *past* the TTL, where
    the hand-rolled version expired it at exactly the TTL; and it reclaims a stale entry lazily
    — under eviction pressure or an overwrite — rather than deleting it on the read that found
    it stale. Neither is observable through this module's contract, which is "an expired entry is
    never served", so the tests now assert that and note the boundary explicitly.
  - **A fake clock starting at zero silently disabled the TTL entirely.** `lru-cache` records an
    entry's start time and short-circuits its staleness check on `!!start`, so an entry written
    when the injected clock reads exactly `0` is treated as having no start time and never
    expires. Every TTL test had started its clock at `0`, so the whole block would have passed
    against a cache that never expired anything. They start at a realistic instant now. A real
    `performance.now()` is a float that is never exactly zero, so this is a testing hazard rather
    than a production one — but it is the kind that makes a green suite mean nothing.
  - **Test infrastructure: none, for either module.** All 39 tests run against fake clients and
    injected clocks — the payoff for `CorpusVersion` taking a `Queryable` and `ResultCache` taking
    no database at all. The single statement the watcher issues is already covered against the
    real migrated DB by 3.3's `updated_at` round trip in `indexStore.test.ts`, so a second
    integration test would have re-proven that and nothing else.
  - **Constraints this hands forward to 3.5:**
    - **3.5 constructs one `CorpusVersion` and passes it to both consumers.** Two watchers would
      double the poll and let the cache and the suggest index disagree about which corpus they
      describe.
    - **Read the version once per request, before calling `searchQuery`, and pass that same
      number to `get` and `set`.** A version read after the query stamps a pre-reindex page as
      fresh — the bug fixed in `#rebuild` above, in the place it would be easiest to reintroduce.
    - **`toCachedPage` on the way in, `query` re-attached on the way out.** The cached value has
      no `query` field by construction, so a controller that forwards it unmodified will fail to
      typecheck rather than echo the wrong spelling.
    - **Do not cache `no-searchable-terms`.** 3.1 returns it before any I/O, so there is nothing
      to pay back, and every stopword-only query has the same empty stems — they would collide
      onto one key while differing only in the field that is not stored.
    - **`RESULT_CACHE_DEFAULTS` are defaults this module applies, not bounds it enforces** — the
      same split `SUGGESTION_LIMIT`, `MAX_QUERY_LENGTH` and `MAX_PAGE_SIZE` are on. 3.5 still owns
      `MAX_PAGE_SIZE`, but it is no longer load-bearing for memory: `maxSizeBytes` bounds the
      cache whatever page size gets through.
- **Phase 3.5 (API layer) — done**, implementing the agreed design recorded under *Phase 3.5 —
  API layer: agreed design*, with two deviations noted below. Three new modules —
  `api/middleware.ts`, `api/routes.ts` and the rewrite of `api/server.ts` into a composition root
  — plus `status` on the wire and one line in `index.ts`. 18 new tests; 533 pass overall. **Two
  new dependencies: `helmet` (8.3.0) and `express-rate-limit` (8.6.2)**, both one-liners.
  - **Verified behaviour-preserving against the recorded numbers, through HTTP this time.**
    `GET /api/search?q=documents+containing` against the dev corpus returns **1.3765** and
    **0.1674** — the values 2.4 wrote into this plan and 3.1 and 3.2 each re-confirmed — so
    putting four layers of HTTP boundary in front of the pipeline changed no ranking. The fourth
    result still brackets **`documentation`** at offsets 41–54, which is 3.2's re-run of
    `processText` surviving the trip to the wire intact.
  - **Deviation 1: validation is `schema.parse(req.query)` inside the handler, not a `validate`
    middleware.** The design said `middleware.ts` holds "the validator", and a generic
    `validate(schema)` is the reflex — but in Express 4 it has nowhere type-safe to put its
    output. It must either write back to `req.query` (untyped, and a getter in Express 5, so the
    pattern has an expiry date) or stash the result on `res.locals`, where the handler reads it
    back as `any` and the schema's inferred type is lost at exactly the boundary it exists to
    establish. Parsing in the handler keeps the inference — `q`, `page` and `pageSize` arrive
    typed and defaulted — and costs one line per route. The thrown `ZodError` still lands in the
    one error handler, so the boundary rule is in one place either way. `middleware.ts` therefore
    holds the limiters, `asyncRoute` and `errorHandler`.
  - **Deviation 2: the handlers take an `ApiDeps` and `server.ts` builds it.** `createRouter(deps)`
    rather than `routes.ts` importing the singletons — those are constructed *in* `server.ts`,
    which imports `routes.ts`, so importing them back is a cycle. Injection also means a handler
    can be driven against a fake `Queryable` later without a pool, which is the same split that
    kept 30 of 3.3's 33 tests and all 39 of 3.4's off the database.
  - **The two-limiter split is visible in the response headers**, which is the cheapest possible
    confirmation it wired up: `/search` reports `RateLimit-Policy: 60;w=60`, `/suggestions`
    reports `300;w=60`, and `/health` reports none at all — the last being the one that matters,
    since a 429 on a platform's liveness probe reads as an unhealthy instance and gets the
    process restarted.
  - **The cache test deletes the corpus between two identical requests.** Asserting a hit by
    timing measures the machine, not the cache; truncating `documents` after the first request
    means the second can only be answered from memory, because a recompute now returns nothing.
    It is the same trick 3.3 used to prove its in-flight dedupe — make the wrong answer
    impossible rather than unlikely.
  - **`resultCache.clear()` in `beforeEach`, and the reason is `CorpusVersion`'s throttle.** The
    watcher polls at most every 30s, and a whole suite runs in ten — so truncating a table inside
    a test does *not* move the version the cache gates on, and one test's corpus would be served
    to the next. Correct in production (the poll is a throttle, not a subscription) and a leak in
    a test, so the test clears what the test dirtied.
  - **A test assumption was wrong and the code was right — the fifth time in Phase 3**, after
    3.1, 3.2, 3.3 and 3.4 each hit it once. This one was arithmetic: the `/statistics` test
    asserted `totalTokens: 17` and `avgDocLen: 8.5` for two eight-word fixture bodies. It now
    computes both from `BODIES` rather than hand-counting, the same way it already derived the
    stem from `processQuery` instead of writing `document` down — 3.1's lesson about
    `crawler`/`crawl` generalizes to any number a test states independently of the fixture that
    produces it.
  - **What came out, as promised:** `defaultPageSize` is off `/api/health`, and its assertion in
    `server.test.ts` is now the inverse — that the health check echoes no internal configuration.
    `express.json()` is gone too; every endpoint is a GET, so it parsed nothing and only widened
    what the API accepted.
  - **`SearchStatus` moved to `shared/types.ts`** and `queryProcessor` re-exports it, so the three
    empty-result cases 3.1 spent a discriminated union to keep distinct now survive the trip to
    the client. Confirmed on the dev corpus: `?q=the%20and` answers **200** with
    `status: "no-searchable-terms"` and `total: 0`, which is the case 4.4 needs in order to avoid
    rendering "no results for *the*".
  - **Constraints this hands forward to Phase 4:**
    - **`matchedTerms` is on the wire but not in `SearchResponse`.** `RankedResult` assigns to
      `SearchResult` structurally, so the field rides along undeclared. The client should not
      depend on it; highlighting uses `matches`, which is what 3.2 built for the purpose.
    - **`/suggestions` returns a bare `Suggestion[]`**, not an envelope, and takes only `q`.
    - **Snippets and suggestions are untrusted crawled text.** 4.4 splits `snippet` at the offsets
      and renders text nodes — never `dangerouslySetInnerHTML`. 5.6's XSS test targets that
      renderer, which is now the only place an injection could land.
    - **5.6 owns rate-limit edge tests**, and needs `resetKey` rather than larger numbers: the
      limiter stores are per-process and shared by every test in a file, so `routes.test.ts`
      deliberately stays well under 60 requests to `/search` and `/statistics` combined.
- **Phase 4.1 (Setup) — done.** Tailwind v4 and `react-router` wired into the client, plus the
  app shell: `main.tsx` (mounts `BrowserRouter`), `App.tsx` (the route table),
  `components/AppLayout.tsx`, `pages/SearchPage.tsx`, `pages/NotFoundPage.tsx`. Three new
  dependencies — `tailwindcss` + `@tailwindcss/vite` (dev) and `react-router` (runtime) —
  taken under the library-first build policy recorded in Phase 4's key decisions.
  - **Tailwind v4 configures in CSS, not `tailwind.config.js`.** v4 dropped the JS config and the
    PostCSS pipeline in favour of `@import "tailwindcss"` plus a first-party Vite plugin, so 4.1
    is two lines in `vite.config.ts` and a block in `index.css`. Worth stating because every v3
    tutorial prescribes files this setup does not have.
  - **The existing design tokens became `@theme` variables, and `static` is load-bearing.** The
    scaffold's `index.css` already carried a light/dark palette as bare custom properties;
    re-declaring them under `@theme` makes each one reachable as a utility (`bg-bg`,
    `text-heading`, `border-border`) instead of as hand-written `var()`. Tailwind tree-shakes
    theme variables no utility references, which would have deleted the base value of any token
    used only by the dark-mode block below — so the block is `@theme static`. Verified in the
    built CSS: all eight `--color-*` land in `:root`, including `--color-code-bg`, which nothing
    uses yet.
  - **Dark mode reassigns the tokens rather than restating the utilities**, so anything built from
    a token follows for free. The `@media (prefers-color-scheme: dark)` block is deliberately
    *unlayered*: `@theme` emits into Tailwind's `theme` layer, and an unlayered rule outranks a
    layered one regardless of source order, which makes the override independent of where the
    bundler happens to place it.
  - **One route, not a Home page plus a Search page.** The empty state and the results state are
    the same page told apart by `?q=`. Two routes would need the search box duplicated or lifted,
    and would put a navigation between typing a query and seeing results. The catch-all `*` exists
    so an unknown path renders an answer instead of an empty shell.
  - **`key={query}` on the input.** An uncontrolled input keeps its DOM value across a re-render,
    so a back navigation would move the results while leaving stale text in the box. Keying it to
    the URL query remounts it, which is the cheap fix and the reason the query lives in the URL at
    all.
  - **`MAX_QUERY_LENGTH` is imported from `shared` and enforced as `maxLength`** — the first use of
    the shared workspace from the client, and it turns a 400 the server would return into a
    non-event.
  - **Verification is static so far.** `tsc -b`, `vite build` and `oxlint` are clean, every module
    transforms through the dev server, and the built CSS was inspected for the tokens and
    utilities above — but the page has **not** been looked at in a browser yet. Phase 4 ships no
    tests by decision, so that visual pass is the verification, and it is outstanding.
  - **The input in `SearchPage` is a placeholder.** 4.4 replaces it with the real `SearchBox` and
    its Headless UI suggestion combobox; it exists now only so the shell and the URL round-trip
    can be exercised by hand.
- **Phase 4.2 (API client) — done.** Two new files, no new dependencies:
  `client/src/services/api.ts` (`search`, `fetchSuggestions`, `fetchStatistics`, plus the
  `ApiError` class and `NETWORK_ERROR_STATUS`) and `client/src/vite-env.d.ts`. Nothing imports
  it yet — 4.3's hooks are its first caller — so `vite build` tree-shakes it out entirely and the
  bundle is unchanged.
  - **Transport only, by decision.** No caching, no retry, no debounce, no request dedupe: all
    four are 4.3's, and a cache *underneath* TanStack Query would be the one layer nothing
    invalidates — it would keep serving a stale page to the cache that does get invalidated. What
    the module owns is URL construction, the non-2xx contract, and the single cast at the JSON
    boundary.
  - **`API_BASE_URL` is `import.meta.env.VITE_API_BASE_URL ?? "/api"`.** The default is right for
    two of the three deployments — the Vite proxy in dev, and a client served by the same Node
    instance — and the env var covers the third, a static client on a different host, which the
    free-tier model makes likely. No server change is needed for it because `server.ts` already
    runs `cors()` unrestricted.
  - **`vite-env.d.ts` exists because `vite/client` types unknown env keys as `any`** through an
    index signature, and `any ?? "/api"` is `any` — the base URL would have reached `fetch`
    unchecked. Merging one declaration into `ImportMetaEnv` narrows it to `string | undefined`.
    The index signature survives, so this types the declared key and not a misspelled one.
  - **An abort is not an `ApiError`, and that is the load-bearing rule in the module.** Fetch's
    `AbortError` propagates untouched, because that is what TanStack Query recognizes when it
    cancels a superseded request; wrapping it would render a cancellation as an error message —
    the exact out-of-order-response failure the data layer was chosen to prevent. The abort check
    is repeated around `response.json()`, since the body streams separately from the headers and
    a cancellation can land there instead.
  - **The body is read before `response.ok` is checked**, because the server's 400 puts the whole
    useful part of the failure in the body (`{"error": "q: required"}`) and nothing in the status
    line. A non-JSON body is a distinct `UNPARSEABLE` symbol rather than `undefined`, so a 200
    carrying a platform error page or a cold-start splash throws instead of being cast to
    `SearchResponse` and failing somewhere unrecognizable.
  - **The response cast is an assertion, not a validation, and it is deliberate.** Both sides
    build the body from the same `shared/` declaration, so a zod schema here would re-verify a
    type the compiler already agreed on across the boundary. It buys something only against a
    *different* server, which is not a deployment that exists. The comment marks the line where
    zod goes if that changes.
  - **Confirmed on the wire: `matchedTerms` really is there and really is undeclared.** The raw
    `/search` JSON shows it on every result, `SearchResult` does not declare it, and the module's
    doc comment says not to read it — highlighting uses `matches`. 3.5's warning survived contact.
  - **Verified against the live dev server, not just the compiler**, by loading the real module
    through Vite's `ssrLoadModule` (so `import.meta.env` and the client's resolution rules are the
    ones that actually ship) and driving it against `npm run dev:server`. 14 checks, all passing:
    the canonical `documents containing` query returns **1.3765** and **0.1674** with
    `documentation` bracketed at **41–54** — the same four numbers 2.4 recorded and 3.1, 3.2 and
    3.5 each re-confirmed, now with a fifth layer in front of them; `page`/`pageSize` forward and
    the server's default applies when omitted; `?q=the and` is a 200 with
    `no-searchable-terms`; `/suggestions` returns a bare array and `"doc "` (trailing space)
    returns `[]`, so the untrimmed pass-through works; both 400s arrive as `ApiError` carrying the
    server's flat string; a dead port gives `ApiError` with status `0`; an unmounted path gives
    `ApiError(404)` off Express's HTML body; and an aborted request throws `AbortError` that is
    not an `ApiError`. `tsc -b`, `oxlint` and `vite build` are clean.
  - **Constraint this hands to 4.3:** the hooks own "should we ask at all". `fetchSuggestions`
    does not guard an empty `q` — the server 400s it, and the hook is expected to gate on a
    non-empty query rather than have this layer turn a wrong call into a silent one. Same for
    `MAX_PAGE_SIZE`: the client does not duplicate the server's validation.
- **Phase 4.3 (Hooks) — done.** Four new modules — `services/queryClient.ts` and
  `hooks/{useSearchUrl,useSearch,useSuggestions,useStatistics}.ts` — plus the
  `QueryClientProvider` in `main.tsx` and the wiring of `SearchPage` onto all three data
  hooks. **Two new dependencies: `@tanstack/react-query` (5.101.4) and `use-debounce`
  (10.1.1)**, both named by Phase 4's build policy.
  - **The URL is state, and `useSearchUrl` is the only module that says what it means.** Not
    in the subphase list, and it is the piece that stops a bug 4.4 would otherwise ship:
    `SearchBox` writes `?q=` and `Pagination` writes `?page=`, and two independent writers
    are how a new search inherits page 3 of the old one — visible only on the second search,
    and only to someone who paginated first. `submitQuery` drops the page by building the
    params from scratch rather than mutating a copy, so a different query cannot carry the
    old query's offset. Page 1 is spelled by omission, so the URL shared after searching and
    the one shared after paging back to the start are the same string.
  - **`useSearch` is deliberately not debounced, and `useSuggestions` is.** They look like
    the same hook and are not: the search query comes from the URL, which only moves when
    someone submits the form or clicks a page — both explicit acts already waited on, so a
    debounce there adds delay to the one interaction in the app with no ambiguity about
    intent. Suggestions run off the live input, which is the only place in the client where
    a keystroke can reach the network.
  - **Trailing-edge debounce with no `maxWait`, which is what keeps 3.5's limiter honest.**
    `/suggestions` allows 300/minute; a `maxWait` would put a floor under the request rate
    that *scales with how long someone types*, which is the exact traffic shape the limiter
    exists to refuse. Without one, a continuous typist sends nothing until they pause.
    Measured in the harness below: three keystrokes 60ms apart produced **one** request, for
    the last of them.
  - **A cleared box clears the list immediately rather than one debounce later**
    (`input === "" ? "" : debounced`). Every other transition can afford to lag 200ms
    behind; this one is the user asking the suggestions to go away, and leaving them hanging
    under an empty input reads as broken rather than as slow.
  - **`placeholderData: keepPreviousData` is withdrawn when the query is disabled**, and
    that conditional is load-bearing in both hooks. Kept unconditionally it holds the last
    successful result across a key change — which is what stops paging from blanking the
    list, and also what would leave the previous search's results sitting under a box the
    user just emptied. The previous data is only a reasonable placeholder for a request that
    is actually being made.
  - **The retry policy is the one real decision in `queryClient.ts`, and 429 is why it
    exists.** TanStack retries three times by default. `express-rate-limit` counts per
    minute and TanStack's backoff tops out in seconds, so every retry of a 429 lands inside
    the same window, fails identically, and spends part of the next window's budget getting
    there — retrying a rate limit is how you stay rate-limited. A 400 is a malformed query
    and will be malformed again. What is left is `NETWORK_ERROR_STATUS` (nothing ever
    reached the server) and 5xx (the server saying the failure was its own), capped at two.
    A non-`ApiError` is a bug in our own code rather than a transport failure, so it is not
    retried either; aborts never arrive, since TanStack reports a cancelled query as
    cancelled — which is the whole reason 4.2 refused to wrap them.
  - **`staleTime` is 5 minutes because 3.4's server cache uses the same number.** The corpus
    only moves when the local index job runs, which a browser cannot observe, so client
    staleness is a guess — and picking a *different* guess from the one already recorded on
    the server would mean two answers to one question. `refetchOnWindowFocus` is off:
    results do not change because a tab regained focus, and `/statistics` shares the
    60-per-minute limiter with `/search`, so the default would spend the search budget on
    tab switches.
  - **`useStatistics` is a small addition beyond the subphase's two hooks**, so that 4.4's
    `StatsBar` contains no data-fetching decisions of its own. It sets no per-query options,
    and the comment says why rather than leaving the omission to be read as an oversight —
    the client-wide defaults above are already the right policy for an endpoint sitting on
    the search limiter.
  - **`SearchPage` is wired but still a readout, not a design.** Controlled input, a
    comma-separated suggestion list and a title/score list; 4.4 replaces all three with
    `SearchBox`, `Suggestions` and `ResultList`/`ResultItem` rendering highlighted snippets.
    4.1's `key={query}` remount trick had to go — it works only on an uncontrolled input,
    and the value has to be readable for suggestions — replaced by React's documented
    "adjust state during render" pattern, which resets the box on a back navigation without
    an effect and without painting the stale value.
  - **Verified by rendering the real app against the live dev server, not just by the
    compiler.** The Chrome extension was not connected, so the browser pass 4.1 still owes
    is *still* owed; instead the shipped modules were loaded through Vite's `ssrLoadModule`
    (so JSX, TS and `import.meta.env` behave exactly as they do in the bundle) into jsdom,
    mounted under the real `BrowserRouter` + `QueryClientProvider`, and driven against
    `npm run dev:server` with `fetch` instrumented. 25 checks, all passing, and the whole
    session cost **6 requests**: the empty state asks nothing; three keystrokes collapse to
    one `/suggestions?q=doc`; clearing the box asks nothing and hides the list within 50ms;
    submitting moves the URL to `?q=documents+containing` and issues exactly one `/search`,
    which renders **1.3765** and **0.1674** — the numbers 2.4 recorded and 3.1, 3.2, 3.5 and
    4.2 each re-confirmed, now with React in front of them; `?page=2` forwards `page=2` and
    returns nothing on a four-document corpus; **navigating back to page 1 issues no request
    at all** and re-renders from the client cache; and `?q=the+and` renders the stopword
    message rather than "0 results", which is `status` surviving from 3.1's discriminated
    union all the way to the DOM. The harness was deleted and its `jsdom` install reverted;
    `package-lock.json` gained only the two dependencies above.
  - **A `FormData` exception in the harness was an artifact and the code was right** — the
    same failure mode Phase 3 hit five times. React 19's submit listener builds a `FormData`
    from the form, and Node 22's global (undici) `FormData` cannot accept a jsdom form
    element; a browser has no such collision, and `client/src/` contains no `FormData` at
    all. Overriding the global with jsdom's cleared it, and the submit handler had run
    correctly regardless.
  - **Constraints this hands forward to 4.4:**
    - **Write the URL through `useSearchUrl`, never through `useSearchParams` directly.**
      `SearchBox` calls `submitQuery`, `Pagination` calls `goToPage`. That is the whole
      reason the module exists.
    - **A submitted query still feeds `useSuggestions`**, so one `/suggestions` request
      fires for the completed text after every submit — visible in the harness trace.
      Harmless and well inside the limiter, but 4.4's combobox should stop asking once it
      closes; "is the popover open" is `SearchBox` state, which is why it was not fixed here.
    - **`isLoading`, not `isPending`.** A disabled query is `pending` forever with
      `fetchStatus: "idle"`, so a spinner keyed on `isPending` renders on the empty state and
      never stops.
    - **Read `data.status` before `data.total`.** Three of the four empty outcomes are not
      "nothing matched", and only `status` tells them apart.
    - **`error` is an `ApiError`, so `.status` is available** — 429, `NETWORK_ERROR_STATUS`
      and 500 each need different words.
- **Phase 4.4 (Components) — done.** Nine new modules — `lib/splitSnippet.ts` and
  `components/{SearchBox,Suggestions,ResultList,ResultItem,Pagination,StatsBar,ResultsSkeleton,SearchError,EmptyResults}.tsx`
  — plus the rewrite of `SearchPage` from 4.3's readout into a composition of them. **One new
  dependency: `@headlessui/react` (2.2.10)**, named by Phase 4's build policy.
  - **The first option in the combobox is the text the user typed, and it is load-bearing.**
    Headless UI auto-activates the first option whenever the popover opens and offers no prop
    to turn that off — `openCombobox()` sets `defaultToFirstOption` and only an explicit arrow
    key clears it, verified in `combobox-machine.js`. So Enter on an open combobox always
    selects *something*, and if that something were the top suggestion, typing `crawl` and
    pressing Enter would search for `crawler`: the engine silently answering a question the
    user did not ask, with no way to submit the prefix they wanted. Making "what I typed" a
    real option turns that default from a bug into the correct behaviour, through the public
    API, without mirroring Headless UI's activation state in our own `useState`. It is also
    the browser-omnibox pattern, and it means the highlighted row is always what Enter will
    actually do — which is the half a screen reader can perceive.
  - **The bug the browser pass caught, and nothing else would have.** Headless UI opens the
    combobox when the user *types*, not when there is something to show. A query with no
    completions left — `documents containing`, once both words are whole — therefore leaves it
    open over an unrendered list, and its Enter handler runs the "open, nothing active" branch:
    `preventDefault()`, close, return. **The first Enter was swallowed and the search only ran
    on the second.** Every static check passed and the two-word case is the *common* one. The
    fix is an `onKeyDown` on the input that submits when `completions.length === 0`; preventing
    default there disables Headless UI's own handler, because `mergeProps` composes the
    caller's listener ahead of its own and stops at the first one that prevents the event.
    Filtering therefore lives in `SearchBox` and `Suggestions` takes the finished list — the
    count decides what a keystroke means, so two components cannot each compute it.
  - **The combobox's value is the typed text, which is what makes a controlled input safe
    here.** `ComboboxInput` writes `element.value = displayValue(value)` imperatively when the
    popover closes, behind React's back, so a controlled `value` prop cannot correct it on the
    next render. For a conventional combobox that is the feature — blurring reverts a
    half-typed word to the selected item — and for a search box it would throw away what the
    user typed. Holding the typed text *as* the value makes every one of those writes a no-op,
    and no `displayValue` is needed since a string value passes through unchanged.
  - **`modal={false}` on `ComboboxOptions`, which defaults to `true`.** The default locks body
    scroll and marks the rest of the page inert while open — right for a portalled dropdown,
    wrong for a suggestion list under a search box, where it makes the page unscrollable and
    shifts the layout by the scrollbar width on every keystroke.
  - **Known wart: `aria-expanded="true"` with no listbox.** Same root cause — open state is
    driven by typing, not by content — and it lasts only while typing a query with no
    completions. `aria-expanded` is a prop Headless UI controls, so it cannot be overridden
    from outside. The alternative was a permanently-rendered popover echoing the user's own
    text back at them on every keystroke, which is a worse page for the sake of a more truthful
    attribute. Recorded rather than fixed.
  - **`splitSnippet` is a pure function returning segments, not JSX**, so 5.6's XSS test can
    drive it with plain Vitest and string literals — no jsdom, no Testing Library. That is 3.2
    decision 8 discharged: the snippet is attacker-supplied text from a crawled page, and this
    is the last point where an injection could become markup, so it is split at the offsets and
    rendered as text nodes inside `<mark>`. **Its invariant is that the segments concatenate
    back to the input exactly** — no arrangement of offsets, overlapping, reversed, fractional
    or out of range, can drop or duplicate a character. A wrong highlight is cosmetic; eating
    text out of a snippet would be a correctness bug that looks like a rendering glitch. The
    clamping is not distrust of 3.2: a cached client outlives the server it was built against,
    and an index rebuilt under a changed snippet budget is exactly the skew that produces
    offsets past the end of a shorter string, which `slice` answers silently.
  - **The title is deliberately not highlighted.** 3.2 declined to send a second offset array
    and noted the client could match terms against a string it already has. It could — but only
    by matching *words*, while the server matches *stems*: `documentation` is a hit for
    `document` and no word-matcher on this side reproduces that. A title highlighter would mark
    a different set of words than the snippet does, in the same card, which reads as a bug in
    the highlighting rather than as a missing feature. Offsets or nothing.
  - **The BM25 score is on screen**, which makes the visual pass a check on the pipeline rather
    than only on the layout: `documents containing` renders **1.3765** and **0.1674** — the
    numbers 2.4 recorded and 3.1, 3.2, 3.5, 4.2 and 4.3 each re-confirmed — now in a real
    browser's DOM.
  - **`EmptyResults` holds all four reasons a list can be empty, and the fourth is not a
    status.** `?page=99` on a two-page result set is a 200 with a real `total` and an empty
    page; "no results" would be a lie, so it gets its own branch and a way back to page 1. The
    other three are 3.1's union arriving intact — read `status` before `total`, per 4.3.
  - **`StatsBar` renders on the empty state only, and says nothing when it fails.**
    `/statistics` shares the 60-per-minute limiter with `/search`, so the honest failure here is
    a 429 caused by *searching* — and an error about decoration, next to a working search box,
    reports a problem the user does not have. On a results page the useful number is "4 results,
    page 1 of 1" and corpus totals beside it are noise; on the empty state it is the only
    context a first visitor gets.
  - **The visual pass owed since 4.1 is done, and it found the Enter bug.** The Chrome
    extension was still not connected, so the page was driven through `puppeteer-core` against
    the *installed* Chrome — no browser download, and the whole harness lived outside the repo,
    so `package.json` and `package-lock.json` gained only Headless UI. 29 checks against
    `npm run dev:server` + `npm run dev:client`, all passing, with **no console errors or
    warnings**: five keystrokes collapse to one `/suggestions`; the popover is a wired ARIA
    combobox (`aria-expanded`, `aria-autocomplete="list"`, `aria-controls`,
    `aria-activedescendant`) whose active option is the typed text; Enter searches `docum`
    rather than `documents`, ArrowDown-then-Enter searches `documents`; a fully-typed query
    submits on the *first* Enter; no `/suggestions` request fires after a submit, which closes
    4.3's leftover; the four empty outcomes each render their own words; dark mode repaints
    from the tokens; and there is no horizontal overflow at 390px.
  - **Pagination was verified by forcing it, because the dev corpus cannot.** Four documents is
    one page, so the component would have shipped unlooked-at. A throwaway patch — `pageSize:
    1`, plus a query-param override for the page count — produced 4 real pages (Previous
    disabled on 1, `aria-current` tracking, Next issuing exactly one `/search`, **back issuing
    none at all** and re-rendering from the client cache) and then 12 fake ones to look at the
    elided form: `1 2 3 … 12`, `1 … 4 5 6 7 8 … 12`, `1 … 10 11 12`. A gap that would hide
    exactly one page renders that page instead, since `1 … 3` is the same width as `1 2 3` and
    says less. The patch was reverted and the suite re-run against the restored file.
  - **A dev-only artifact, chased down rather than assumed:** the empty state issues
    `/statistics` **twice**. It is React `StrictMode`'s double mount — a production build of the
    same code asks once, confirmed by building with `VITE_API_BASE_URL` pointed at the API and
    driving the preview server. No code change.
  - **Pre-existing and not 4.4's:** `npm audit` reports one high-severity advisory in
    `brace-expansion`, reached through `node-pg-migrate → glob → minimatch` in the *server*
    workspace. Unrelated to this phase's dependency; noted for 5.5.
  - **Constraints this hands forward:**
    - **5.6's XSS test targets `splitSnippet`**, which is the only place an injection could
      land, and the invariant to assert alongside the escaping is that the segments rejoin to
      the input string.
    - **4.5 owns the remaining polish**, not correctness: the ARIA combobox, the live region
      over the results section, `aria-current` on the pager and the 390px layout are all in
      place and verified.
    - **`useSearch` accepts a `pageSize` that nothing passes.** `SearchPage` lets the server
      default apply. If a page-size control is ever added it goes through `useSearchUrl`, like
      every other URL writer.
- **Phase 4.5 (Pages + polish) — done.** Two new modules — `hooks/useDocumentTitle.ts` and
  `lib/searchMessages.ts` — plus edits to `index.html`, `index.css`, `SearchPage`,
  `SearchBox`, `Suggestions`, `ResultItem`, `EmptyResults`, `SearchError` and `NotFoundPage`.
  **No new dependencies** — `package.json` and `package-lock.json` are untouched, and the
  server suite is unchanged at 533. Verified by 45 checks in a real browser.
  - **The live region was the one real defect, and it was 4.4's.** `SearchPage` wrapped the
    *whole* results section in `aria-live="polite"`, so every title, URL, snippet and score
    was queued to be read aloud on every search — and since `role="alert"` is itself a live
    region, `SearchError` nested inside it announced twice. A result list is something you
    navigate, not something that should be read at you. There is now exactly one live region
    in the app, a `role="status"` paragraph holding one *sentence* — "4 results, page 1 of 2",
    "Searching…", or the heading of whatever went wrong — asserted by counting every
    `[aria-live]`/`[role=status]`/`[role=alert]` node on the empty, results and error states
    and checking that none of them contains an `<li>`.
  - **It is always mounted and swaps its text, never conditionally rendered.** A live region
    has to be in the document *before* its contents change, or the change is the region
    appearing and screen readers may say nothing at all — the failure mode that makes an
    announcement look implemented and be silent. It is visible on the branch where the count
    is worth looking at and `sr-only` on the branches whose words are already on screen
    underneath it, which is a class swap rather than a remount.
  - **The announced sentences moved out of the components that display them.**
    `emptyResultsHeading` and `describeApiError` now live in `lib/searchMessages.ts`, called
    by both the status line and the component that renders the same words — a second copy is
    how a screen reader ends up hearing something the page does not say. It also cleared two
    `only-export-components` lint warnings: a component file exporting a plain function
    disables fast refresh for that file, so the module boundary the announcement needed and
    the one Vite needs turn out to be the same one. Same placement as `splitSnippet`.
  - **Paging moves focus, and that is a bug fix rather than a nicety.** Clicking `Next` onto
    the last page **disables the button under the cursor**, and a disabled element cannot
    hold focus — so a keyboard user is silently dropped to the top of the document, on the
    page they just asked to leave. Focus goes to the status line (`tabIndex={-1}`), which
    answers the click, puts the AT cursor at the head of the new results and scrolls them
    into view. The guard that keeps it honest is `if (next === page) return`: `Pagination`
    deliberately leaves the current page's button enabled, and without it that no-op click
    would arm a flag that an unrelated later render then consumes, stealing focus out of the
    search box mid-keystroke. Proven by forcing `pageSize: 1`, exactly as 4.4 forced
    pagination into existence, then reverting.
  - **One focus ring for the app, declared once in `@layer base` rather than as a utility per
    element.** A per-element class is a thing the next component can forget, and the failure
    is invisible to anyone using a mouse. This also found a live gap: `SearchBox`'s input set
    `outline-none` and replaced it with a *border-colour change*, which was the only cue a
    keyboard user got on the app's primary control. `outline-none` is gone, and the rule's
    standing consequence is that nothing may reintroduce it without supplying an indicator.
  - **A test assumption was wrong and the code was right — the sixth time in this project**,
    after five in Phase 3 and the `FormData` artifact in 4.3. Four ring assertions failed
    reporting the *text* colour, which looked like the rule not applying. It was sampling:
    Tailwind's `transition-colors` includes `outline-color`, so the ring eases in from
    `currentColor`, and `getComputedStyle` immediately after `focus()` reads the first frame
    of that transition rather than its target. Tabbing through and waiting 250ms shows
    `2px solid` in the accent on all seven stops, in both themes. Recorded because the
    animation is real and worth knowing about — the ring is at full width and contrast from
    frame one, only its hue settles — and because the naive assertion will look correct to
    whoever writes it next.
  - **The title now says which search it is.** The query has lived in the URL since 4.1 so
    results could be shared and the back button could step through searches — but browsers
    surface history *by title*, and with one static string every history entry, tab and
    bookmark read `Search Engine`. `useDocumentTitle` is a ten-line hook rather than a head
    manager: this app has no SSR and two pages that need a title. Its cleanup restores the
    site name rather than the previous value, so a page that unmounts alone cannot strand a
    stale query in the tab.
  - **`prefers-reduced-motion`, unlayered and `!important`**, because it has to beat
    `animate-pulse` and every `transition-*` utility including ones no later phase has written
    yet. Durations collapse to `0.01ms` rather than `none` on purpose: a `0s` transition never
    fires `transitionend`, so code that waits on one would hang for exactly the users who asked
    for less motion. Verified in both directions — `0.00001s` under `reduce`, `0.15s` without.
  - **The listbox had a bare `<div>` in it.** The divider between "search this text" and the
    suggestions is a child of `role="listbox"`, whose children are supposed to be options;
    some assistive technologies count it when reporting "2 of 9". It is `role="presentation"`
    and `aria-hidden` now — the one thing 4.5's brief explicitly owned that 4.4 had not
    already covered, found by enumerating the listbox's non-option children rather than by
    looking at it.
  - **`break-words` on the result title and snippet**, which the dev corpus cannot demonstrate:
    four pages of short prose never produce an unbroken token. A crawled title can be one
    300-character string, and nothing else in the card would break it. Checked by putting a
    300-character token into a rendered card at 390px and asserting the document still does not
    scroll sideways.
  - **`theme-color` and a description in `index.html`.** Without the first, a dark-mode phone
    renders a white address bar above a `#16171d` page; both are literals rather than `var()`
    because the meta tag is read before any stylesheet.
  - **Considered and declined: a skip link.** WCAG 2.4.1 is about bypassing *blocks* of
    repeated content, and this header contains exactly one link — the block it would skip is
    one tab press. Recorded as decided rather than left to read as an oversight.
  - **Verification: 45 checks, all passing, no console errors or warnings** — the single logged
    failure is the deliberate 400 the error-path test asks for, asserted as the only one.
    Driven through `puppeteer-core` against the installed Chrome from a harness outside the
    repo, the arrangement 4.4 established. Covered: one live region on three states; the title
    on all three pages including the reset on the way back; the accent ring on every tab stop
    in both themes; reduced motion on and off; no horizontal overflow at **320/390/768/1280**
    on both the empty and results states, plus the 300-character token; the combobox's
    `aria-expanded`/`aria-autocomplete`/`aria-controls`/`aria-activedescendant` with the typed
    text active and the divider excluded from the options; the error path carrying no
    `role="alert"`; and paging focus through four forced pages. The canonical numbers survive a
    seventh layer: `documents containing` renders **1.3765** and **0.1674** with
    **`documentation`** bracketed.
  - **Known wart, unchanged from 4.4:** `aria-expanded="true"` with no listbox while typing a
    query that has no completions left. Headless UI drives open state from typing rather than
    from content and controls that attribute itself, so it cannot be overridden from outside;
    the alternative is a permanently-rendered popover echoing the user's own text back at them.
    Still recorded rather than fixed.
- **Phase 4.6 (Empty state) — done.** The deferred "how does a visitor know what to search
  for" problem, which had been discussed since Phase 1 and never written down. One new client
  module (`components/ExampleQueries.tsx`), one new server read (`readCorpusSources`), one new
  field on the wire (`Statistics.sources`), and edits to `StatsBar` and `SearchPage`. 2 new
  tests; **535 pass overall.** No new dependencies.
  - **The problem is real and has nothing to do with corpus size.** A search box over an
    unknown corpus is a prompt with no context: a first-time visitor types something generic,
    matches nothing, and concludes the engine is broken rather than that they guessed outside
    it. Autocomplete does not rescue that — it helps only once you have typed a letter worth
    completing, and it cannot tell you the corpus is web and Python documentation. No amount
    of additional crawling fixes it either, which is why this was worth building and a fourth
    crawl was not.
  - **Five hardcoded example queries, and hardcoded is the decision.** A frequency-ranked term
    from the index would surface `content` or `value` — accurate and useless. Each of these is
    chosen to show the engine doing something specific: `closure scope` (the reference page for
    the concept ranks first), `async await` (one query answered across react.dev *and* MDN),
    `flexbox`, `asyncio`, `useEffect` (one per corpus). They call `submitQuery` through a prop
    rather than reaching for `useSearchUrl`, keeping 4.3's rule that one module writes the URL.
  - **`sources` is derived from `documents.url`, never configured.** `StatsBar` said "1,437
    documents indexed", which is a size and not an answer to "what is in here". It now names
    the hosts — and it reads them from the table rather than from a constant in a component,
    so the sentence cannot claim a site that was never crawled or go stale when the corpus
    changes. `split_part(url, '/', 3)` is safe because every stored URL has been through
    `normalizeUrl` and therefore always carries a scheme.
  - **`sources` and `totalDocs` can legitimately disagree, and a test pins it.** The totals
    come from `corpus_stats`, `sources` from `documents` — so a corpus that has been crawled
    but not yet indexed reports 0 documents *and* names its hosts. That is the correct answer
    for exactly the window this endpoint is most worth reading, and a `sources` that followed
    `corpus_stats` would go silent through all of it. The pre-existing `toEqual` assertion on
    the statistics body caught the new field, which is the test doing its job; it is now
    `toMatchObject` plus two tests that assert the new behaviour directly.
  - **The browser pass found something SQL had not.** With `sources` on screen, the stray
    `18.react.dev` page — the redirect-scope gap recorded under Phase 1 — stopped being a
    harmless row and became a *advertised source*, listed beside the three real ones in the
    corpus description. One page out of 1,437 is noise in a ranking and not noise in a
    sentence naming what you can search. Deleted; the corpus is now 1,436 documents / 23,916
    terms across three hosts. A minimum-page-count threshold was considered and rejected — it
    would hide a legitimately small source to paper over an artifact that should not exist.
  - **Verified: 13 browser checks, all passing, no console errors.** The stats line names all
    three hosts and keeps the totals; five chips render with descriptive accessible names;
    clicking `asyncio` moves the URL, updates the document title, returns 24 Python-docs
    results ranked `asyncio` first, and announces "24 results, page 1 of 3" through 4.5's
    live region; the chips are tabbable and show 4.5's focus ring; no horizontal overflow at
    320px or 390px.
- **Phase 4 complete.**
- Next up: **Phase 5** — tests + polish. 5.6 owns the XSS test against `splitSnippet` (3.2
  decision 8's obligation, and the invariant to assert beside the escaping is that the segments
  rejoin to the input string) and the rate-limit edges, which need `resetKey` rather than larger
  numbers. 5.5 inherits the `brace-expansion` advisory 4.4 found under `node-pg-migrate → glob →
  minimatch` in the *server* workspace, plus request logging, which 3.5 decision 8 deferred here.
  Then **Phase 6** — deployment, drafted below: one Node instance, one managed Postgres, no
  Redis, and a corpus still built locally.
- **Phase 6.1–6.3 (Deployment prep) — done.** Two files changed, 35 lines. No new dependencies.
  - **`migrate:deploy`** (`server/package.json`) is `migrate` without `--envPath .env`. There is
    no `.env` file on a host — the variables are real environment variables, and the existing
    script would have failed on the first deploy. `migrate`/`migrate:down` are untouched for
    local use.
  - **An unmatched `/api` path now answers JSON 404** before the SPA fallback. This is the whole
    reason the ordering is written down: a `Router` does not terminate paths it did not match, so
    mounting the fallback after the `/api` router is *not* enough — `/api/typo` would fall through
    and return `index.html` with a **200**, which is HTML where the client's `fetch` expects JSON
    and the one failure 4.2's `UNPARSEABLE` branch can only report as a shrug.
  - **The client bundle is served by the same Express process** (`express.static` + a `*` fallback
    to `index.html`), which is what keeps 4.2's `/api` default base URL correct and means there is
    no cross-origin story to configure at all.
  - **The path is resolved from `import.meta.url`, not `process.cwd()`**, which is whatever
    directory the process happened to start in. `../../../client/dist` is the same expression in
    both layouts — `server/src/api` under tsx and `server/dist/api` after a build — so one line
    serves dev and production. Verified both resolve to the same directory.
  - **The static block is behind an `existsSync` guard**, so `dev:server` (Vite serves the client)
    and a checkout that never built the client are unaffected; without it a missing `index.html`
    turns every unknown path into a 500. The tradeoff is that it fails *quietly* — if the client
    build ever does not run on the host, the API comes up fine and `/` returns 404 rather than the
    process refusing to start.
  - **Verified against the built server on :4100**, not just the compiler: `/api/health` 200 JSON,
    `/api/typo` **404 JSON**, `/` and `/search?q=flexbox` 200 `text/html`, `/favicon.svg` 200
    `image/svg+xml`, `/api/search?q=flexbox` 88 results. **535 tests still pass.**
  - **helmet's CSP was the risk worth checking and it is fine:** `default-src 'self'` /
    `script-src 'self'`, and the bundle loads only `/assets/index-*.js`, `/assets/index-*.css` and
    same-origin favicons with no inline scripts. `connect-src` falls back to `'self'`, so the
    same-origin API calls pass. Nothing needed loosening.
  - **Not verified: the app booting in a real browser from this origin.** The Chrome extension was
    not connected. What is confirmed is that the right bytes are served with the right content
    types and that CSP permits them.
- **Phase 6 — host chosen and corpus loaded (2026-08-22).** Both of the phase's open questions are
  resolved: **Render** (web service, free) + **Neon** (Postgres, free), both in **Singapore**,
  Postgres **17**, client served from the same instance.
  - **Neon rather than Render's own Postgres, and the reason is not performance.** Free Render
    databases *expire 30 days after creation* and are deleted 14 days later. The corpus costs
    hours of crawling to rebuild, so a 30-day timer was the one genuinely bad option available.
  - **Not a serverless host for the API.** The result cache, the suggest index and
    `express-rate-limit`'s store are all in-process and assume a warm, long-lived process;
    serverless gives every invocation its own copy. This is the same constraint that has been
    driving decisions since the 0.3 amendment, now applied to the host.
  - **Postgres 17 because `docker-compose.yml` pins `postgres:17-alpine`** (17.10 locally, 17.11
    on Neon — minor versions are dump- and wire-compatible). The corpus is moved by `pg_dump`, and
    dumping newer into older is unsupported; but the stronger reason is 0.5's test strategy, which
    runs the suite against `search_engine_test` in *the same* docker-compose Postgres precisely so
    the tests exercise real DDL. A production database on 18 would quietly weaken that guarantee.
    Nothing in the schema — btree PKs, `int[]` positions, one `BIGINT` — wants 18.
  - **Region is one decision, not two: the API and the database must be colocated.** Every search
    is several API→Postgres round trips, so a cross-region pair would add ~200ms to each one on
    top of a 13–18ms query. Singapore is also the closest Neon region to the machine that runs the
    crawl and index jobs, so for once there is no tradeoff to weigh.
  - **The corpus was moved by dump/restore, not re-crawled** — a fresh crawl would take hours and
    hit MDN again for pages already held. Both ends run *inside* the docker container
    (`docker compose exec -T postgres sh -c 'pg_dump … | psql "<neon-url>"'`), which keeps the
    bytes off the Windows filesystem: PowerShell's `>` writes UTF-8 **with a BOM**, and a BOM atop
    a `.sql` file makes `psql` choke on the first statement.
  - **`--no-owner --no-acl` is required, not cosmetic.** The local dump is owned by the role
    `postgres`, which does not exist on Neon (only `neondb_owner` does), so every
    `ALTER TABLE … OWNER TO postgres` would error. The tables would still be created — which is
    the dangerous part, since the restore *looks* broken while actually half-working, with any
    real failure buried in the noise.
  - **Verified by row counts on both sides, not by the exit code:** 1,846 documents / 26,478 terms
    / 441,647 postings, identical local and remote, with `corpus_stats.total_docs` agreeing and
    the 2 `pgmigrations` rows carried across — so `migrate:deploy` against Neon is now a clean
    no-op, which is the intended end state rather than something to work around. The real check
    was functional: the BM25 CLI run against Neon returns **88 results for `flexbox`**, the same
    count and the same top-ranked MDN page as the local API.
  - **Two numbers that look alarming and are not.** Query time against Neon is **293ms** versus
    13–18ms locally — that is the India→Singapore round trip *from a development machine*, and it
    disappears once the API runs colocated in Singapore; it measures home internet, not the search
    engine. And the database is **66 MB on Neon against 120 MB locally**, because the local copy
    carries dead tuples from 2.3's repeated `DELETE` + rebuild cycles while a fresh restore has
    none. 66 MB is 13% of Neon's 0.5 GB allowance.
  - **Still to do: Part D (the Render service itself) and Part E (verification).** Future schema
    changes are applied to Neon by running `migrate:deploy` from a development machine against the
    production connection string, deliberately *not* wired into the host's deploy — Render's
    pre-deploy hook is not reliably available on free instances.
- **Hosting decision (affects Phases 1 and 3).** Free-tier-only hosting: no hosted Redis.
  The search-result cache and autocomplete move from Redis to in-process memory; Redis
  survives as a local dev/crawl dependency for the frontier + robots cache. Rationale and
  the accepted tradeoffs are recorded under *Hosting model*, Phase 3's key decisions, and
  the cross-cutting table.

## Architecture at a glance

```
seed URLs
   │
   ▼
┌──────────┐   raw text + metadata   ┌───────────────┐
│ Crawler  │ ─────────────────────▶  │  Postgres     │
│ (Redis   │                         │  documents    │
│ frontier)│                         └───────────────┘
└──────────┘                                 │
                                             ▼
                                   ┌───────────────────┐
                                   │ Processing +      │  terms, postings,
                                   │ Inverted Indexer  │ ─ doc/corpus stats ─▶ Postgres
                                   └───────────────────┘
                                             │
   query ──▶ ┌────────────┐  postings  ┌─────────────┐  top-k docs
             │ Search svc │ ─────────▶ │ BM25 ranker │ ───────────┐
             │ (Express)  │ ◀───────── │  (custom)   │            │
             └────────────┘            └─────────────┘            ▼
                │   │  │                                   snippets + highlight
                │   │  └── autocomplete (in-memory) ───┐          │
                │   └────── result cache (in-proc LRU) ┤          ▼
                ▼                                       │   sanitized output
           React + TS + Tailwind frontend ◀────────────┴──── JSON API
```

**Request lifecycle (search):** `GET /search?q=` → validate (zod) → normalize query with
the *same* pipeline used at index time → cache lookup (in-process LRU) → on miss, fetch
posting lists (Postgres) → BM25 score + sort + paginate → build snippets + highlight
matches → sanitize → cache → respond.

## Data model

**Postgres (durable):**

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `documents` | one row per crawled page | `id`, `url` UNIQUE, `title`, `content_text`, `content_hash`, `http_status`, `fetched_at`, `token_count`, `lang`, `canonical_url` (recorded, never used as identity) |
| `terms` | dictionary | `id`, `term` UNIQUE (stem), `doc_freq`, `surface_form` (display spelling) |
| `postings` | the inverted index | PK(`term_id`,`doc_id`), `tf`, `positions int[]`; `postings_doc_id_idx` on **`doc_id`**. The "index on `term_id`" this row originally called for was rejected in 0.4 as redundant — the PK's btree already serves leading-column lookups; the reverse direction (delete/reindex one document) is the one that needed covering |
| `corpus_stats` | single-row global stats for BM25 (`id = 1`, CHECK-enforced) | `total_docs`, `total_tokens` (BIGINT — node-postgres returns it as a *string*), `avg_doc_len`, `updated_at` — the last is **Phase 3's reindex signal**, see 3.3/3.4 |
| `crawl_errors` | URLs the crawl gave up on, so a later run can re-seed them | `url` PK, `reason`, `http_status`, `detail`, `depth`, `attempts`, `first_seen_at`, `last_seen_at` |

**Redis (local crawl job only — *not* hosted, see Hosting model below):**

| Key pattern | Type | Purpose |
|-------------|------|---------|
| `frontier:queue` | ZSET | URLs to crawl, scored by priority/depth |
| `frontier:seen` | SET | visited-URL dedup (hash of normalized URL) |
| `robots:<origin>` | STRING | JSON envelope: raw robots.txt text, or a cached "no file"/"unreachable" verdict (per-outcome TTL). Keyed by origin — scheme + host + port — since each serves its own file |

**In-process memory (the hosted API's ephemeral state):**

| Structure | Purpose |
|-----------|---------|
| LRU + TTL map | search results keyed by normalized query + page |
| sorted term index | autocomplete prefix lookups (binary search or trie) |

Both are held in the Express process's own RAM, built/refreshed from Postgres, and are
fully expendable — a restart just rebuilds them. At this corpus size (~10k unique terms)
they cost single-digit MB, well inside a free tier's allowance, and avoid a network hop
per keystroke.

**Hosting model (drives several decisions below):** free tiers only — managed Postgres
(the one thing that must persist) plus a single always-on Node instance. No hosted Redis:
its free tiers meter *requests*, and autocomplete is the highest-volume endpoint in the
app, so putting it behind a metered service is both the costliest and the slowest option.
Redis remains a local dev/crawl dependency via `docker-compose`.

---

## Phase 0 — Foundations & Infrastructure

Everything depends on this; it is not optional even though it wasn't in the original
phase list.

- **Goal:** a runnable skeleton — shared types, config, DB/Redis connections, migrations,
  and a test harness — so later phases plug in cleanly.
- **Depends on:** the existing monorepo scaffold (root workspaces, `server/`, `client/`).
- **Subphases:**
  - **0.1 Layout** — create `server/src/{crawler,processing,indexer,ranking,search,api,db}`
    per `CLAUDE.md`; move the current `server/src/index.ts` health server into `api/server.ts`.
    (The `shared` subfolder this line originally listed was dropped entirely — the name collided
    with the root `shared/` workspace, and config landed flat at `server/src/config.ts`. See 0.2
    in Status.)
  - **0.2 Shared kernel** — `shared/types.ts` (Document, Token, Posting, SearchResult,
    Suggestion), `shared/constants.ts`, `shared/utils.ts`, and a zod-validated `config`
    loaded from `.env` (+ `.env.example`).
  - **0.3 Connections** — `db/pg.ts` (`pg` Pool) and a Redis client (`ioredis`) with
    lifecycle/health checks; `docker-compose.yml` for local Postgres + Redis.
  - **0.4 Schema + migrations** — `db/schema.sql`, `db/migrations/`, `db/seed.sql`; pick a
    runner and wire `npm run migrate`. **Settle the `terms` display-form question first**
    (key decisions below) — it changes this DDL.
  - **0.5 Test harness** — Vitest config for the server workspace + a test-DB strategy.
- **Key decisions:**
  - Source under `server/src/` (recommended, matches current tsconfig `rootDir`) vs. flat
    per the `CLAUDE.md` diagram → **`src/` chosen**, for clean `dist/` output.
    *(Resolved — done, see Status.)*
  - Migration tooling: `node-pg-migrate` vs. a hand-rolled SQL runner → **`node-pg-migrate` v9
    chosen**, with migrations in `server/db/migrations/`. *(Resolved — done, see 0.4 in Status.)*
  - Local infra via `docker-compose` vs. host installs → **docker-compose chosen**
    (`postgres:17-alpine` + `redis:8-alpine`, pinned). *(Resolved — done, see 0.3 in Status.)*
  - Server module system: keep CommonJS vs. move to ESM → **ESM chosen.**
    *(Resolved — done, see Status.)*
  - How the client obtains API types: a shared workspace vs. client-local copies →
    **recommend a small `shared` workspace** consumed by both. *(Resolved — done, see Status.)*
  - **`terms` display forms — RESOLVED (option 1 chosen, column added in 0.4).** Phase 2.1 stems before
    indexing, so `terms.term` holds *stems*: `comput`, `retriev`. Autocomplete (3.3) reads
    this table, so suggesting straight from it would surface `comput` instead of
    `computer` — visibly broken in the UI. Also note prefix matching must run against what
    the user *types* (a surface form), with the stem used only to carry `doc_freq` as the
    ranking weight. Options:
    1. **Add `surface_form TEXT` to `terms`** — the most frequently observed original
       spelling per stem, written by the indexer. One extra column, no join, and the
       suggest index becomes a flat `{surface, docFreq}` array sorted by surface.
       Limitation: one display form per stem, so `computing`/`computers` collapse to a
       single suggestion — which is arguably *desirable* for autocomplete.
    2. A separate `term_surfaces` table (`stem`, `surface`, `count`) — can suggest several
       variants per stem, at the cost of a join and many more rows.
    3. Build the suggest index from unstemmed document titles instead of `terms` — yields
       natural phrases but misses body-only vocabulary.
    → **Recommend option 1**, breaking ties on count by shortest-then-lexicographic so the
    choice is deterministic. Cheapest fix that removes the visible problem, and it keeps
    3.3's lookup a single in-memory binary search.

## Phase 1 — Crawler

- **Goal:** discover and download pages from seed URLs, politely and dedup'd, storing
  clean text + metadata.
- **Depends on:** Phase 0 (types, Postgres, Redis, config).
- **Subphases:**
  - **1.1 Fetcher** — HTTP GET with timeout, retry/backoff, custom User-Agent, gzip.
  - **1.2 robots** — `robots-parser` with per-**origin** caching; honor `Crawl-delay`. The cache
    ended up two-layer (in-process parsed `Robot`, plus *optional* Redis holding the raw text),
    since a `Robot` has methods and cannot be serialized — see 1.2 in Status.
  - **1.3 Parser** — `cheerio`: extract title + main text (strip script/style/nav),
    collect outbound links, resolve relative → absolute, canonicalize.
  - **1.4 Frontier** — Redis ZSET queue + SET visited; URL-normalization rules
    (lowercase host, strip fragments/tracking params, trailing-slash policy).
  - **1.5 Scheduler** — a single dispatcher loop capping global concurrency + per-host
    politeness; stop conditions (max pages / max depth). The `p-limit` worker pool this line
    originally called for was **dropped and never installed** — a semaphore cannot express
    "skip this one, that host is cooling"; see Phase 1.5's agreed design.
  - **1.6 Persistence** — upsert `documents` (dedup on `content_hash`), record crawl
    metadata/errors.
  - **1.7 Entry** — `npm run crawl -- --seed <url> --max <n> --depth <d>`.
- **Key decisions:**
  All five are **resolved** — Phase 1 is complete; kept here for the reasoning.
  - HTTP client: native `fetch`/undici (Node 22) vs. `axios` → **native fetch chosen**; no HTTP
    dependency was ever added. *(1.1.)*
  - Frontier structure: priority ZSET vs. simple FIFO list → **ZSET, scored by depth (BFS)**.
    Because `ZPOPMIN` pops in strict depth order, first discovery is already shortest-path
    discovery, so no re-scoring is needed. *(1.4.)*
  - Crawl scope: same-domain only vs. host allowlist vs. open web → **allowlist + depth cap**,
    built from the seeds by `hostsFromSeeds()`. `canonicalHost` collapses `www` onto the apex for
    scope, but other subdomains are not implied; an omitted `allowedHosts` means an open-web
    crawl, which 1.7 never does. *(1.4/1.7.)*
  - Dedup granularity: URL-only vs. URL + `content_hash` → **both**. URL identity is the
    parser's normalized final URL; `content_hash` is the backstop that recovers the duplicates
    1.3 deliberately declined to prevent. *(1.4/1.6.)*
  - Store raw HTML vs. extracted text only → **extracted text only** (`documents.content_text`;
    no raw-HTML column exists). *(1.6.)*

### Phase 1.4 — Frontier: agreed design (settled before implementation)

The frontier is the crawler's to-do list, and the first stateful piece in Phase 1 —
everything before it is single-URL and stateless. Two jobs: a **queue** that decides what
to fetch next (BFS by depth, so a capped crawl gets a broad slice of a site rather than
one deep tunnel), and a **seen-set** that stops the web's link cycles from looping forever.

**Inherited constraints** — decided by 1.3, not open here:

- The dedup key is `normalizeUrl`'s output. Not a rule re-derived in this module.
- Both the requested URL **and** the fetcher's final post-redirect URL get marked seen.
- A host allowlist must cover apex *and* `www`, since `normalizeUrl` deliberately unifies
  neither.
- `/robots.txt` is never enqueued — `checkRobots` would recurse on it.

**1. Seen-at-enqueue, via `SADD`'s return value.** ZSET members are unique, so `ZADD`
cannot produce a duplicate queue entry regardless of when we mark — the seen-set's real
job is blocking re-enqueue of URLs that have already been *popped*. Given that, enqueue-time
marking wins because `SADD` returns 1-if-new/0-if-existed, making check-and-mark a single
atomic op; a check-then-set at pop time leaves a window where two workers both claim the
same URL. Consequence worth noting: because the score is depth and `ZPOPMIN` pops in strict
depth order, **first discovery is already shortest-path discovery**, so no `ZADD LT` or
re-scoring is needed. Requires two escape hatches: `requeue()` (skips the duplicate check,
for 1.1's `retryable` failures) and `markSeen()` (writes the set without enqueueing, which
is how the post-redirect URL gets recorded).

**2. Policy split from storage; two stores.** The frontier is ~90% policy (normalize →
depth → scope → dedup → reason code) and ~10% storage (`SADD`/`ZADD`/`ZPOPMIN`). Interleaved,
testing the policy — where the bugs will be — would require Redis, which `.env.test`
deliberately does not configure. Split behind a small `FrontierStore` interface, the policy
is testable with zero infrastructure and a `MemoryFrontierStore` falls out in ~30 lines
(also making "crawl 20 pages without starting Docker" possible). **Safety rule: every key
carries a configurable prefix and `clear()` deletes only under that prefix — never
`FLUSHDB`**, so a test run can't wipe a real in-progress crawl. Redis-backed tests use the
`vi.resetModules()` + `vi.stubEnv` pattern already established by the Redis health tests.

**3. The seen-set stores raw normalized URLs, not hashes.** The memory argument doesn't
survive the numbers: 50k URLs at ~80 bytes is 4 MB, and hashing to 40-byte hex saves 2 MB.
What hashing costs is real — you can't `SSCAN frontier:seen *example.com*` to find out why
a host was skipped, which is exactly the debugging wanted mid-crawl. And a collision means
a page is silently never crawled: the unrecoverable direction, the same asymmetry that
rejected http/https unification in 1.3.

**4. The score is `depth`, full stop — 1.5 owns host scheduling.** Host interleaving cannot
live here: priority is fixed at insert time, but the correct ordering depends on which hosts
have been fetched *since*, and the frontier never learns when a fetch completes. So 1.4
supplies the tool, not the policy: `next()` plus `popBatch(n)` (`ZPOPMIN key n`), letting
1.5 group a batch by host and dispatch round-robin so one host's `Crawl-delay` doesn't idle
the pool. **Constraint this places on 1.5:** popped-but-unprocessed URLs live only in 1.5's
memory and are *already marked seen*, so a Ctrl-C that drops that buffer removes them from
the crawl permanently — they can never be re-enqueued. 1.5's shutdown path must `requeue()`
its buffer before exiting. Same shape of silent, invisible-if-missed bug as the
redirect-marking rule above.

**5. The queue is capped** (`maxQueueSize`, default 100k). `maxLinks` is 1000 per page, so
a 500-page crawl can discover half a million candidates, nearly all of which `maxPages`
guarantees will never be popped. A soft, counted rejection — the crawl is healthy, just
saturated — checked *before* the `SADD`, so a rejected URL isn't marked seen and can be
enqueued later when there's room.

**Through-line: `add()` returns a discriminated result with a reason**
(`enqueued` | `duplicate` | `out-of-scope` | `too-deep` | `invalid-url` | `queue-full` |
`excluded`), not a boolean — same reasoning as 1.1's `FetchResult`. 1.7's crawl summary
("312 out of scope, 88 duplicates, 4 malformed") is the difference between a crawl you can
debug and one you can only stare at.

### Phase 1.5 — Scheduler: agreed design (settled before implementation)

Everything in 1.1–1.4 is *passive*: `fetchPage`, `checkRobots`, `parseHtml` and `normalizeUrl`
each take one URL and return one answer, and `Frontier` is a data structure that answers
questions. Nothing runs. 1.5 is the piece that turns those five modules into a crawl — and
it is the first module in Phase 1 that is stateful **over time** rather than over data. 1.4
was stateful (a queue) but has no clock; 1.5 owns the clock, which is why three of the four
constraints it inherited are about time.

**Inherited constraints** — decided by 1.1/1.2/1.4, not open here:

- `markSeen(FetchSuccess.url)` after every redirect; `add()` only marked the requested URL.
- `requeue()` the popped-but-unprocessed buffer on shutdown — those URLs are already marked
  seen, so dropping them deletes them from the crawl permanently.
- Honour `FetchFailure.retryAfterMs` ourselves; the frontier has no notion of time.
- Supply a default crawl delay; 1.2 deliberately left `crawlDelayMs` undefined when the site
  named none.
- Shutdown aborts an `AbortController` rather than waiting for the event loop to drain —
  1.1's backoff timer is deliberately not `unref`'d.

**1. Ready-time dispatch, and `p-limit` is dropped.** The plan's original tooling doesn't fit
the requirement. `p-limit` is a semaphore over tasks you have *already ordered*: it runs them
in queue order and offers no way to say "skip this one, that host is cooling, take the next."
But choosing what to run next is the entire problem here, and the correct choice depends on
state that only exists at dispatch time — which hosts are in flight, which are cooling down.
Pre-interleaving the batch round-robin before handing it to `p-limit` only half-works: 40
`example.com` URLs and 10 `other.com` URLs interleave to ten alternating pairs followed by
thirty consecutive `example.com`, so the tail saturates anyway. And it does nothing about the
second failure — a worker that sleeps out a crawl-delay *inside its slot* is holding a slot it
isn't using, so with one-in-flight-per-host enforced, N−1 slots can end up asleep on the same
host and an 8-wide pool does one request per `crawlDelayMs`.

The replacement is a **single dispatcher loop** over a host-aware scheduler, with in-flight
capped by a counter rather than a semaphore library. One loop, not N worker loops: the runtime
is single-threaded, so N loops buy nothing but shared mutable state, and termination
("the queue is empty" is only true if nothing in flight can still discover links) is far
easier to get right in one place. No new dependency, matching 1.1 and 1.2.

**2. Policy split from mechanism, mirroring 1.4.** `crawler/hostScheduler.ts` holds the
politeness policy — round-robin host rotation, one-in-flight-per-host, per-host ready times —
as a pure, synchronous, clock-injected class with no I/O. `crawler/scheduler.ts` holds
`crawl()`: the loop, the wiring of robots→fetch→parse→frontier, stop conditions, shutdown and
the summary. Same reasoning that split `Frontier` from `FrontierStore`: the bugs will be in the
scheduling policy, and a pure class with an injectable `now()` tests that policy
deterministically with no servers, no timers and no Redis.

`crawl()` takes an already-constructed `Frontier`, exactly as `RedisFrontierStore` takes an
already-constructed client — so `scheduler.ts` never imports `db/redis.js` or `config.ts`, and
1.7 remains the single place where "is Redis configured?" is answered.

**3. The politeness key is the canonical host, not the origin.** `canonicalHost` moves from
`frontier.ts` into `url.ts` and both import it. Politeness is about not overloading a *machine*,
so `http://` and `https://` on one host share a bucket, and `www.example.com` collapses onto
the apex — the same collapse 1.4 already makes for scope, and for the same reason (nearly
every site 301s one spelling to the other, so treating them as two hosts would double the rate
we hit one server). Note this differs from `robots.txt` caching, which is correctly keyed by
*origin* — those are two different questions and 1.2's key stays as it is.

**4. Default crawl delay is 1000 ms, and an explicit `Crawl-delay: 0` is honoured.** 1s is the
conventional unnamed delay for a small crawler; with per-host serialization that caps us at
1 req/s/host while an 8-wide pool across 8 hosts still moves at 8 req/s. The `0` case matters
more than it looks: 1.2 went out of its way to keep an explicit `0` distinct from "nobody
asked", and that distinction only has value if some layer acts on it — 1.5 is the only layer
that ever will, so overriding it here would retroactively make 1.2's work pointless. The risk
is bounded because **one-in-flight-per-host is the real politeness floor** and applies
regardless of delay; the delay is spacing *on top of* serialization, not instead of it. The
delay is measured from request **completion**, not request start — stricter, and it means a
slow response is never followed immediately by the next hit on that host.

**5. Retries requeue to the frontier, and the wait goes on the *host*, not the URL.** The
tempting design — an in-memory pending-retry list with per-URL timers — is both more machinery
and less correct. `Retry-After` is a statement about the **host**: if `example.com` says "back
off 30s", fetching a *different* `example.com` URL immediately is exactly as rude as retrying
the same one. So a retryable failure sets that host's ready time to
`max(crawlDelay, retryAfterMs)` and hands the URL straight back with
`frontier.requeue(url, { depth })` — the host scheduler then declines to dispatch *anything*
for that host until it is ready. This reuses the ready-time map that decision 1 already
requires, and it means **no second buffer for shutdown to drain** — a real win given that the
one buffer we already have deletes URLs permanently if dropped.

Preserving the original `depth` on requeue is a one-liner that is easy to miss: `QueuedUrl`
carries it, and a retry that comes back at depth 0 jumps the BFS queue.

The attempt cap is the piece that cannot be skipped. `requeue()` bypasses the dedup check by
design, so without a tally a persistently-503ing URL cycles forever and the crawl never
terminates. A `Map<string, number>` keyed by URL, capped at **2** — `fetchPage` has already
burned its own 3 attempts with backoff before we ever see a retryable failure, so this is 2
more *scheduling rounds*, not 2 more requests. The map only holds URLs that have failed
retryably, so it stays small, and dropping it on shutdown is harmless.

**6. Tuning knobs are `CrawlOptions`, not env vars.** 1.1 asked to revisit `FETCH_DEFAULTS`
here. Having looked: nothing in it is a knob a CLI user would turn, so the byte cap, redirect
cap and backoff curve stay module constants. What *is* worth exposing — `concurrency`,
`maxPages`, `maxDepth`, `defaultCrawlDelayMs`, `batchSize` — goes in a `CrawlOptions` argument
defaulted from a `CRAWL_DEFAULTS` constant, which 1.7 fills from CLI flags. Deliberately **not**
`config.ts`: that is zod-validated env for the *hosted API*, and per the hosting model the crawl
never runs there. Putting crawler knobs in it would make the deployed server validate env vars
it never reads, and 1.7's `--max`/`--depth` flags would then shadow or fight them, giving two
sources of truth for one number.

**7. `onPage` is a callback, so 1.5 does not depend on 1.6.** The scheduler hands each
`ParsedPage` plus its fetch metadata to a caller-supplied sink. Persistence is 1.6's job; a
callback keeps 1.5 testable against the `node:http` fixture-server pattern the other four
modules use, and preserves the "crawl 20 pages without starting Docker" property that
`MemoryFrontierStore` was built for.

**8. `maxPages` counts successful fetches**, and reaching it stops *dispatch* while letting
in-flight requests finish. Counting *stored* pages would couple 1.5's stop condition to 1.6's
`content_hash` dedup decisions, and killing in-flight requests throws away work already paid
for on the network.

**Through-line: `crawl()` returns a summary, not `void`** — pages fetched, failures broken down
by `FetchFailureReason`, robots-blocked, parse failures, requeues, links discovered, why it
stopped, and the frontier's own reason counters. Same reasoning as 1.1's `FetchResult` and
1.4's `AddResult`: 1.7's CLI output is the difference between a crawl you can debug and one you
can only stare at.

## Phase 2 — Indexer + Ranking

- **Goal:** turn stored documents into a queryable inverted index and score them with a
  custom BM25 (the only scorer — see 2.4's agreed design for why the TF-IDF comparison
  baseline was dropped).
- **Depends on:** Phase 1 (documents in Postgres) + Phase 0.
- **Subphases:**
  - **2.1 Processing pipeline** — `normalizer.ts` (lowercase, Unicode NFKC, strip
    punctuation/diacritics), `tokenizer.ts` (tokens **with positions**, custom),
    `stopwords.ts` (custom list + filter), `stemmer.ts` (Porter via the **`stemmer`**
    package; `natural` was the original choice — see Phase 2.1 in Status for why it changed).
  - **2.2 Inverted index (the core "you wrote it" piece)** — `postings.ts` builds
    `term → [{docId, tf, positions}]`; `invertedIndex.ts` orchestrates, computes `doc_freq`
    per term and per-doc length.
  - **2.3 Persistence** — write `terms` (df), `postings` (tf, positions), and
    `corpus_stats` (N, avg_doc_len); bulk-load via `COPY`; **full rebuild in one
    transaction** (the "upsert strategy" this line originally called for was rejected — see
    Phase 2.3 in Status). Also Phase 2's composition root: `npm run index`.
  - **2.4 Ranking** — `bm25.ts` (IDF from df+N, TF saturation `k1`, length norm `b`,
    `avgdl`); `scorer.ts` (multi-term aggregation + top-k selection); `searchStore.ts` (the
    one query-side join) and `npm run search` as a debug entry point. The "TF-IDF baseline"
    this line originally called for was **dropped** — see Phase 2.4's agreed design.
  - **2.5 Maintenance** — reindex/delete handling; recompute stats. **Resolved as unnecessary
    rather than implemented — see Phase 2.5 in Status.** 2.3's full rebuild already recomputes
    `doc_freq`, `token_count` and `corpus_stats` from the current contents of `documents`,
    deletes included, and incremental reindex is declined rather than deferred. The one real gap
    it surfaced — a reindex is invisible to the running API — moves to 3.3/3.4.
- **Key decisions:**
  - Stemmer: `stemmer` (chosen in 2.1, replacing `natural`) vs. hand-rolled Porter (noted
    alternative — rejected because the IR content of this project is the inverted index and
    BM25, both hand-rolled, whereas Porter is a fixed table of suffix rewrites).
  - Store token **positions** (needed for phrase queries + good snippets) → **yes — done in
    2.2/2.3.** `postings.positions` holds 2.1's ordinals, assigned over the full token stream
    before stopwords were dropped and never renumbered, so 3.2 can resolve them back into the
    document text by re-running `processText` over `indexableText(...)`.
  - BM25 params `k1=1.2`, `b=0.75` (tunable). **BM25 is the only scorer — RESOLVED in 2.4**;
    the TF-IDF comparison baseline was dropped, keeping only the limiting-case test that was
    the one part of it with engineering value.
  - Default multi-term semantics: AND (precision) vs. OR (recall) → **OR with BM25 ranking,
    RESOLVED in 2.4.**
  - Batch (re)index job vs. index-on-crawl → **separate batch job — done in 2.3** (`npm run
    index`). Index-on-crawl is not merely inconvenient but incorrect for this design: `doc_freq`
    is corpus-global, so it cannot be known until every document has been read. Same reason 2.5
    declined an incremental reindexer.
  - Populating `terms.surface_form` (per the Phase 0 decision): 2.2 must track, per stem,
    which original spelling occurred most often — a `Map<stem, Map<surface, count>>`
    alongside the postings build — and 2.3 writes the winner. Cheap to do during the pass
    that already visits every token; expensive to backfill later.

### Phase 2.2 — Inverted index: agreed design (settled before implementation)

2.1 turned text into tokens; 2.2 is the first module that builds an *IR data structure*, and
it is the piece the whole project exists to hand-roll. It is also, deliberately, pure: no
SQL, no connections, no clock. Everything it produces is a value that 2.3 writes.

**Inherited constraints** — decided by 0.4 and 2.1, not open here:

- `terms.term` holds **stems**; the display spelling goes in `terms.surface_form`, which 2.2
  must supply because it is the only pass that sees `ProcessedToken.surface`.
- Positions are 2.1's ordinals, assigned over the full token stream before stopwords were
  dropped, and are never renumbered here.
- `documents.token_count` is `processText(...).length` — survivors, not the raw stream.
- `processText` must stay the single implementation of the four steps; 2.2 calls it rather
  than reaching for `tokenize`/`stem` directly.

**1. Titles are indexed, through one shared `indexableText()` helper.** Not indexing
`documents.title` loses pages *unrecoverably* — a term appearing only in a title means the
page never matches any query, and nothing downstream can recover it. The naive fix breaks
3.2: the snippet builder re-derives offsets by re-running `processText` over the document
text, so if 2.2 indexed a different string than 3.2 slices, every position would be shifted
and every snippet would be wrong. So the concatenation itself becomes the shared function —
`indexableText({ title, contentText })` lives in `processing/pipeline.ts` beside
`processText`, and both 2.2 and 3.2 call it. Positions align by construction rather than by
two modules agreeing to be careful, which is the same reasoning that made `processQuery` a
thin wrapper instead of its own sequence of calls.

Accepted costs, both small and both recoverable by a reindex: title tokens count toward
`token_count`, so they nudge BM25's length normalization (~10 tokens against hundreds); and
a phrase query can match across the title/body seam, since there is no way to burn a
position on a separator — `processText` skips tokens that normalize to nothing *without*
consuming a position, by design. 3.2 should also expect a snippet window to land in the
title region occasionally.

Explicitly **not** field weighting. A `field` column, or repeating the title N times to fake
a boost, is BM25F: a schema change and a ranking decision. If 2.4 finds titles need weight,
that is where it belongs.

**2. Documents are injected as an `AsyncIterable`, so `indexer/` imports no database.**
Same rule every stateful module in this repo already follows — `crawl()` takes a constructed
`Frontier`, `RedisFrontierStore` takes a constructed client, `DocumentStore` takes a
`Queryable` — so exactly one entry point owns connections. It also keeps the whole phase
testable against a hand-written fixture corpus with zero infrastructure, the property that
made 2.1's suite cheap. Async rather than sync so 2.3 can stream from a `pg` cursor later
without changing this signature; a test passes an array through a two-line generator.

**Gap this exposes: Phase 2 has no composition root.** 1.7 exists because something must open
connections, parse flags and handle signals. The key decisions above call for a batch reindex
job (`npm run index`) but no subphase owns it — **2.3 does**, by this decision.

**3. One in-memory build, single flush, with a documented ceiling.** Batched flushing would
write a `doc_freq` that is wrong until the final batch lands, since the count is only correct
once every document has been seen. Against that: the index job runs *locally* per the hosting
model — the free-tier instance never crawls or indexes — so the budget is a dev machine, not
a 512 MB dyno; and 2.3 wants one large `COPY` rather than many small ones anyway. A few
thousand documents at ~200 distinct terms each is a few hundred thousand posting entries,
tens of MB. It gets uncomfortable in the tens of thousands of documents.

Safe to defer because the escape hatch is recoverable: `doc_freq` is derivable from the
postings table in one statement (`SELECT term_id, count(*) FROM postings GROUP BY term_id`),
so if memory ever forces batching, correctness comes back with a query rather than a redesign.

**4. `doc_freq` is `postings.length` and is not stored twice.** The schema materializes both
`tf` and `positions` because query time reads `tf` on every scored row and `positions` on
almost none, so making the hot path call `array_length` would charge every query for the cold
path. No such argument exists in memory for `doc_freq`: it is the length of an array already
in hand, and a second copy is just a field that can drift from the array beside it.

**5. A repeated document id throws.** The input is an iterable someone else supplies, and a
duplicate would merge two documents' postings into one term entry while `docLengths` silently
kept only the last — corrupt in a way no test downstream would attribute back here. Loud beats
silent; the batch job is a local script and a thrown error is exactly the right outcome.

**6. Surface-form ties break by shortest, then lexicographic** (per the Phase 0 decision),
so the winner is a function of the corpus and not of the order documents happened to arrive
in. `avgDocLen` is `0` for an empty corpus rather than `NaN` — a `NaN` here propagates
silently through every BM25 score and produces an unranked result list with no error raised.

**Through-line: `buildIndex` returns one `BuiltIndex` value, not a stream of side effects.**
Everything 2.3 has to write — posting lists, surface forms, per-document lengths, corpus
totals — is a field on it, and everything on it is derived from the same single pass over
the token stream. Same shape as 1.1's `FetchResult` and 1.5's crawl summary: the module
computes, the caller decides what to do about it.

### Phase 2.3 — Persistence: agreed design (settled before implementation)

2.1 and 2.2 are pure functions over strings and iterables — nothing in Phase 2 has opened a
connection or run on its own. 2.3 is both halves of what that leaves missing: the SQL that
turns a `BuiltIndex` into rows, and the entry point that makes Phase 2 a program at all.

**Inherited constraints** — decided by 0.4, 1.6 and 2.2, not open here:

- `terms.term` holds stems, `terms.surface_form` the display spelling; `doc_freq` is the
  posting list's length and is never tracked as a second field.
- `corpus_stats.total_tokens` is BIGINT, which node-postgres returns as a *string*.
- 1.6 zeroes `documents.token_count` whenever a page's `content_hash` changes; something has
  to fill it back in.
- `indexer/` imports no database — `buildIndex` takes an iterable, so exactly one entry point
  owns connections.

**1. A full rebuild, not an upsert.** `doc_freq` is corpus-global: you cannot know how many
documents contain a stem until every document has been read. That is precisely the argument
2.2 used to reject batched flushing, and an upsert is the same thing one layer down — every
term absent from the new build keeps a stale `doc_freq` and goes on voting in IDF for
vocabulary that no longer exists. Fixing that means "delete everything not in the new set",
which is all of a rebuild's cost and none of its simplicity. The one thing an upsert would
buy, stable `terms.id`, has no claimant: `postings.term_id` is the only reference to it and
is rewritten in the same transaction.

**2. `DELETE`, not `TRUNCATE`.** Per the hosting model the index job runs locally against the
same managed Postgres the deployed API reads, so the rebuild is concurrent with live queries.
`TRUNCATE` takes an ACCESS EXCLUSIVE lock and would block every `/search` for the duration;
`DELETE` takes ROW EXCLUSIVE, and MVCC lets readers keep serving the old index from their
snapshot until commit. Identical atomicity, no stall. The cost is dead tuples, which is noise
at this corpus size — and the escape hatch (`terms_new`/`postings_new` plus
`ALTER TABLE … RENAME`) is a later change that nothing above `writeIndex` would notice.

**3. `COPY` for `postings`, parameterized INSERT for `terms`.** The usual objection to `COPY`
is that its text format makes the producer responsible for escaping tabs, newlines,
backslashes and `\N`. That objection is about *text*, and `postings` has none: it is
`(int, int, int, int[])`, so every field is digits, commas and braces. `COPY` is therefore
the safe choice for this table and not just the fast one. `terms` inverts every term of that
argument — it is small, it holds text lifted straight off a web page, and the postings load
needs the generated ids that only `RETURNING` can give back.

**4. Keyset pagination over the corpus, not a `pg` cursor.** Streaming is worth doing because
`content_text` across a corpus dwarfs the index derived from it; 2.2 accepted holding the
finished index in memory, not every page's prose at once. But a cursor wants its own client
held for the whole build and leaks a connection if the error path forgets it, whereas
`documents.id` is a serial PK and `WHERE id > $1 ORDER BY id LIMIT $2` is an index seek per
batch in ~10 lines with no dependency. It also reads on a separate connection from the write
transaction, which is correct while that transaction holds delete locks.

**5. Batches pass arrays through `unnest`.** One placeholder per column per row runs into
Postgres's 65535-parameter limit and makes the batch size a workaround for it; three array
parameters make batch size mean what it should — a bound on memory.

**Through-line: one transaction, and the summary is read back from Postgres.** A partial
flush leaves postings and `doc_freq`s disagreeing with nothing raised to say so, so the
DELETEs, the term INSERT, the `COPY`, the `token_count` writeback and `corpus_stats` all
commit together or not at all. And the CLI prints `corpus_stats` as re-read rather than as
computed, because that is the only version of the number that has actually survived the
BIGINT round trip.

### Phase 2.4 — Ranking: agreed design (settled before implementation)

Everything up to here can answer *"which documents contain this word?"* — that is what `terms`
and `postings` are. Nothing can answer *"which of them is the best answer?"*, and a search
engine that returns 400 matches in arbitrary order is not one. 2.4 is the module that turns a
set into a ranked list, and it is the last pure phase: no SQL in the scorer, no connections, no
clock, exactly like 2.1 and 2.2.

**Inherited constraints** — decided by 0.4, 1.6, 2.2 and 2.3, not open here:

- `terms.doc_freq` and `documents.token_count` are only correct *after* an index run. A corpus
  crawled but not indexed has zeroes, and a zero length must not be read as a corpus-wide
  `avgdl` of zero.
- `corpus_stats` is read through `readCorpusStats` — the single place the BIGINT string
  becomes a JS number.
- `processQuery` is the query-side entry point, and it deliberately preserves duplicates and
  the query's own ordering.
- `ranking/` imports no database, the same rule `indexer/` follows.
- `postings.positions` belongs to 3.2. The ranker reads `tf` on every scored row and positions
  on none — which is precisely why 2.2 stored both rather than deriving `tf` from
  `array_length()`.

**1. BM25 is the only scorer; the TF-IDF baseline is dropped.** The plan called for TF-IDF
alongside BM25 as a comparison. It was never wired to the API, so it was documentation written
in TypeScript — and a second scorer is a second thing to keep correct, with no authority to say
which of the two is wrong when they disagree. The one part of it with real engineering value
survives without it: setting `b = 0` and letting `k1 → ∞` collapses BM25's TF term to raw `tf`,
so the whole formula degenerates to `tf × IDF`, and that identity is asserted **as a test**.
It catches an entire class of bug — an inverted term, a misplaced parenthesis, `b` applied to
the numerator — that hand-computed known-answer vectors can pass straight over, because it
checks the *shape* of the formula rather than one point on it. What is genuinely given up is a
second opinion on real rankings; decision 7 is the replacement, and it is a better one, because
the corpus can be looked at directly instead of through a scorer with no claim to be right.

**2. The IDF variant is `ln(1 + (N − df + 0.5)/(df + 0.5))`, and the `+ 1` is load-bearing.**
The classic Robertson–Spärck Jones form goes *negative* once `df > N/2`, which means a document
is penalised for containing a word the user searched for. On a corpus this size that is not an
edge case — the dev corpus is four documents, so `df > N/2` is the common case, and a term in
three of four documents would actively push its own matches down the list. The `+ 1` floors IDF
at zero: a near-universal term stops contributing rather than counting against you. Pinned by a
test at `df = N`, so a later "simplification" back to the textbook form has something to fail
against.

**3. Multi-term semantics are OR, aggregated by summation, and duplicate query terms are
deduped.** The candidate set is the union of the query terms' posting lists; a document needs
only one. Per candidate, the scores of the terms it *does* contain are summed and missing terms
contribute zero rather than a penalty — which is what makes summation do AND's job without
AND's failure mode: a document matching all three terms accumulates three positive
contributions and floats above one matching a single term, so precision arrives at the top of
the list instead of by way of an empty results page. On a four-document corpus strict AND would
return nothing most of the time.

Duplicates are the wrinkle. `processQuery` preserves them on purpose, so `new york new york`
arrives as four stems and a naive sum weights `york` double. The scorer dedupes for scoring and
leaves the ordered multiset alone for 3.2's highlighting: on a one-to-five word query a repeat
is far more often a slip than an intent, and silently doubling a term's weight because of one
is a wrong answer with nothing raised to explain it. Reversible in either direction, unlike most
of the choices this plan keeps landing on, so it is decided on the cheap side.

**4. A zero document length is guarded, and the direction it fails is the whole reason.**
`token_count = 0` makes the length factor collapse to `(1 − b) = 0.25`, which *shrinks* the
denominator and **inflates** the score — a stale or unindexed document would rank above
correctly-indexed ones rather than below them. It should be unreachable: `writeTokenCounts` and
the `COPY` commit in the same transaction, so a document with `token_count = 0` has no postings
and can never enter a candidate set in the first place. "Unreachable barring corruption" plus
"fails by promoting garbage to rank 1" is exactly the combination that earns a guard, so a
non-positive length substitutes `avgdl` — neutral — with a comment recording why it should never
fire.

**5. Ties break by `docId`, and scores are returned raw.** Phase 3 paginates by offset, so two
documents with equal scores that can swap order between requests will show the same result on
pages 1 and 2 and silently drop another one. Deterministic secondary sort, same reasoning that
made 2.2's surface-form tie-break shortest-then-lexicographic — the output must be a function of
the corpus, not of evaluation order. Scores stay raw on the way out: BM25 scores are unbounded
and not comparable across queries, and normalising to a percentage of the top hit makes the best
result always 100%, which tells a user precisely nothing. What to expose over the API is 3.x's
call, and it can only make it if the raw number reaches it.

**6. No field weighting.** 2.2 explicitly deferred "do titles need weight?" to here; the answer
is no, recorded as decided rather than left open. The *unrecoverable* failure — a term appearing
only in a title making a page unmatchable by any query — is already solved, by `indexableText()`
indexing the title at all. Real BM25F is a `field` column, per-field lengths and a per-field `b`:
a schema change plus a full reindex, spent on no evidence. Revisit only if decision 7's CLI shows
titles actually losing to body-text noise.

**7. `searchStore.ts` and a debug CLI, one phase earlier than this plan originally put them.**
`bm25.ts` and `scorer.ts` stay strictly pure. Taken literally, though, the plan leaves the query
side entirely to 3.1 — which would mean 2.4 ships two modules exercisable only by hand-written
fixture numbers, and no query could be run against the real corpus until Phase 3. That sits badly
against how 2.3 finished: it prints `corpus_stats` *read back from Postgres* on the reasoning
that a summary printed from memory looks identical whether or not the round trip worked. Ranking
has the same gap — known-answer vectors prove the arithmetic, not that the orderings are sensible
on actual pages — and with decision 1 removing the second scorer, this is the only observability
before Phase 3.

So `ranking/searchStore.ts` owns the one join (`postings` × `terms` × `documents.token_count`),
taking a `Queryable` like every other module in the repo, and `ranking/cli.ts` gives
`npm run search -- "web crawler"`. **3.1 reuses `searchStore.ts` rather than writing its own
version of that join** — which is the second reason to do it here, since two hand-written joins
over the same three tables is exactly the drift `processQuery` exists to prevent one layer up.
Retrieval fetches the union of the posting lists and scores in memory; the escape hatch if the
corpus outgrows that is to score in SQL, which changes nothing above `searchStore`. Document
lengths come from the join rather than an in-process map — the map is a 3.x optimisation, and the
hosting model already has somewhere to put it.

**8. `k1` and `b` are `BM25_DEFAULTS`, overridable per call, not env vars.** Same placement as
`FETCH_DEFAULTS`, `CRAWL_DEFAULTS` and `INDEX_STORE_DEFAULTS`, and for the same reason: `config.ts`
is zod-validated env for the hosted API, and making the deployed server validate ranking
parameters gives two sources of truth for one number the moment a CLI flag wants to override it.

**Through-line: the ranker computes, the caller decides.** `scorer.ts` returns scored documents
with their scores and takes a `k`; it does not paginate, does not fetch, does not build snippets
and does not decide what a client sees. Same shape as 1.1's `FetchResult`, 1.4's `AddResult`,
1.5's crawl summary and 2.2's `BuiltIndex` — the module produces one value, and the layer that
owns the request works out what to do with it.

## Phase 3 — API + Caching

- **Goal:** expose the engine over a validated, rate-limited REST API with snippets,
  highlighting, autocomplete, and in-process caching.
- **Depends on:** Phase 2 (index queryable) + Phase 0.
- **Subphases:**
  - **3.1 Search service** — `queryProcessor.ts`: normalize query (shared pipeline) →
    fetch postings → rank → paginate.
  - **3.2 Snippets + highlight** — `snippets.ts`: best-window selection around matched
    term positions; emit match ranges. The `dompurify` sanitization this line called for was
    **not installed**: with offsets-not-HTML resolved, nothing produces HTML for it to guard —
    see Phase 3.2 in Status. Positions come from re-running `processText`, not from
    `postings.positions`.
  - **3.3 Autocomplete** — `search/autocomplete.ts`: **in-process** prefix lookups over a
    sorted term array (binary search for the prefix range; the trie alternative was
    rejected — see Phase 3.3's agreed design), built from the `terms` table at startup and
    refreshed on reindex (detected by polling `corpus_stats.updated_at` — see the key
    decision below); ranked by `doc_freq`. The **"+ popular queries"** this line originally
    called for was **dropped, not deferred** — nothing tracks queries, and neither way of
    starting to fits the hosting model; see Phase 3.3's agreed design.
    Match on `surface_form`, not the stem — see the Phase 0 display-form decision.
  - **3.4 Cache** — `cache.ts`: **in-process** LRU + TTL cache keyed by normalized query +
    page, cleared on reindex — same detection as 3.3, and literally the same poll: 3.4 extracts
    it into a shared `corpusVersion.ts` watcher rather than running a second one. Eviction is
    **`lru-cache`**, bounded by bytes (`maxSize` + `sizeCalculation`) rather than by entry count
    — the hand-rolled `Map` this first shipped as could only count entries, which is not a memory
    bound when `pageSize` is part of the key. The cached value is a projection of `SearchPage`
    (no `terms`), and the cache itself touches no database. See Phase 3.4's agreed design.
  - **3.5 API layer** — `server.ts` (express, cors, helmet, json), `middleware.ts` (zod
    validation, `express-rate-limit`, error handler, request logging), `routes.ts` +
    `controllers.ts` for `GET /search`, `GET /suggestions`, `GET /health`, `GET /statistics`.
- **Key decisions:**
  - Autocomplete backend: **in-process sorted term index (chosen)** vs. Redis ZSET
    (*rejected* — hosted Redis free tiers meter requests, and `/suggestions` fires per
    keystroke, making it simultaneously the most expensive and the slowest option; a local
    lookup skips the network hop entirely). Escape hatch if the vocabulary ever outgrows
    memory: cap the index to the top-N terms by `doc_freq`.
  - Result cache: **in-process LRU + TTL (chosen)** vs. Redis — same reasoning. Accepted
    tradeoffs: cache is cold after a restart, and nothing is shared across instances —
    both irrelevant to a single free-tier instance rebuilding from Postgres.
  - Highlight transport: server returns **plain snippet + match offsets**, client renders
    (no raw HTML injection) vs. server returns sanitized HTML → **recommend offsets** with
    `dompurify` as defense-in-depth.
  - Pagination: offset vs. cursor → **recommend offset** (simple; small corpus).
  - Cache TTL + invalidation trigger — **resolved in 3.4's agreed design:** invalidation is the
    `corpus_stats.updated_at` version, which is *exact*, so the TTL is only a backstop against a
    signal that stops moving. 5 minutes, 500 entries, LRU by last read. Rate-limit thresholds
    are **resolved in 3.5's agreed design:** two limiters, because one number cannot serve both a
    per-submit and a per-keystroke endpoint — 60/min for `/search` and `/statistics`, 300/min for
    `/suggestions`, and none at all on `/health`.
  - **Detecting a reindex — inherited from 2.5, and it needs a mechanism it did not have.** 3.3
    and 3.4 both say "on reindex", but per the hosting model the index job runs *locally* while
    the API is a separate always-on instance, so the API never observes the rebuild — there is no
    process boundary to fire an event across, and no shared Redis to publish it on. → **Poll
    `corpus_stats.updated_at`**, written by `writeCorpusStats` on every run: an indexed single-row
    read, cheap enough to check on a timer or opportunistically per request. When it moves, rebuild
    the suggest index and drop the result cache. Rejected alternatives: a restart (turns every
    reindex into downtime), a TTL alone on the suggest index (either stale for its whole window or
    re-querying `terms` for nothing), and an admin invalidation endpoint (an authenticated write
    surface added for one caller that already has database access). The same column gives 2.3's CLI
    an index-staleness warning when compared against `max(documents.fetched_at)`.
    *(**Built in 3.3.** `readCorpusStats` now returns `updatedAt` as epoch milliseconds — the
    column had a writer and no reader until then — and `SuggestIndex` polls it opportunistically
    behind a `minPollIntervalMs`. 3.4 shares that read rather than adding its own; see 3.3 in
    Status, including why it must not be compared as a `Date`.)*

### Phase 3.1 — Search service: agreed design (settled before implementation)

Everything Phase 2 built is either pure or a program. `bm25.ts`, `scorer.ts` and the whole of
`processing/` are functions over values; `ranking/cli.ts` is the only thing that runs a query
end to end, and it does so as a *process* — it imports `db/pg.js`, prints to stdout, returns
exit codes and closes the pool in a `finally`. None of that survives contact with a request.
3.1 is the same six steps extracted as a function that computes and returns a value, so that
3.5 can call it once per request and 3.4 can cache what it returns. It lives at
`search/queryProcessor.ts`, the first occupant of a directory created empty in 0.1.

Four of its six steps are calls into code that already exists and is tested. The new work is
almost entirely at the edges — pagination, the degenerate cases, and the shape of what comes
back.

**Inherited constraints** — decided by 0.2, 2.1, 2.2 and 2.4, not open here:

- **Reuse `ranking/searchStore.ts`.** Two hand-written joins over `postings × terms ×
  documents` is the drift `processQuery` exists to prevent one layer up.
- `processQuery` is the query-side entry point; it preserves duplicates and query order
  deliberately, and `uniqueTerms` is what collapses them for scoring.
- `corpus_stats` is read through `readCorpusStats` — the single place the BIGINT string
  becomes a JS number.
- `matchedTerms` is what 3.2 highlights from, and it records a match even at zero weight.
- `search/` imports no database. It takes a `Queryable`, exactly as `DocumentStore`,
  `indexStore` and `searchStore` do; 3.5 is the composition root.

**1. The full candidate set is scored, and `total` is its length.** 2.4's forward-constraint
said to ask for `offset + pageSize` as the `limit` and slice. Taken literally that makes
`SearchResponse.total` unknowable — `ranked.length` becomes `min(candidates, offset + pageSize)`
— and a frontend that cannot say "page 3 of 7" cannot render 4.4's `Pagination` at all. The
constraint costs nothing to drop, because `scoreDocuments` builds its `Map` over every posting
of every term and returns the whole thing before `rankDocuments` sorts and slices: passing
`limit` saves one `Array.slice` and not one comparison. So `rankDocuments` is called with no
limit, `total` is the length of what comes back, and the page is sliced from it.

Rejected alternatives, both more expensive than the thing they replace: a separate `COUNT`
query is a second round trip for a number already in memory, and calling `scoreDocuments`
directly to sort and slice by hand is a reimplementation of `rankDocuments`. Note what `total`
then means — documents containing **at least one** query stem, which is the honest count for
an OR engine. The escape hatch if candidate sets ever outgrow memory is the one 2.4 already
recorded: score in SQL, which changes nothing above `searchStore`.

**2. Zero results is three different situations, and the service says which.** A query of
nothing but stopwords, an empty index, and a real query nothing matches all produce an empty
list, and collapsing them into one makes the UI say "no results for *the*" when the honest
answer is that the query never reached the index. The CLI already distinguishes all three;
losing that in the extraction would be a regression rather than a simplification. So the return
value is a discriminated result carrying a reason — `no-searchable-terms`, `empty-index`, `ok`
— the same shape as 1.1's `FetchResult`, 1.4's `AddResult` and 1.5's crawl summary. All three
are HTTP 200 when 3.5 renders them: none is a client error, and a stopword-only query is a
well-formed request with a boring answer.

**3. The service returns a `search/`-local shape; `SearchResult` stays 3.2's to complete.**
`shared/types.ts`'s `SearchResult` requires `snippet` and `matches`, and 3.1 can produce
neither — the snippet builder is the next subphase. Filling them with `""` and `[]` would
typecheck, look implemented, and ship if 3.2 slipped. The rejected alternative is loosening the
wire type to make both optional, which is worse in the direction that lasts: `shared/` is the
contract the client is written against, so every consumer would handle `undefined` forever to
paper over a gap that closes in one subphase. 3.1 therefore returns `{ docId, url, title,
score, matchedTerms }` and 3.2 maps it up. The mapping being near-identity is the point — it is
the seam where the missing fields get added, not ceremony around them.

It also returns the `TermPostings[]` it already fetched. That is what lets decision 8 happen
without a second round trip, and 3.5 gets a debug view for free.

**4. Bounds come from `shared/constants.ts`, and there is no maximum offset.**
`DEFAULT_PAGE_SIZE = 10`, `MAX_PAGE_SIZE = 50` and `MAX_QUERY_LENGTH = 200` were written in 0.2
and are the numbers to use — they live in `shared/` precisely so the client's pagination
arithmetic and the server's agree, and a second set under `search/` would be the drift the
workspace exists to prevent. A maximum offset is deliberately **not** added: given decision 1
the full candidate set is scored regardless, so a large offset costs a slice that returns
empty. A cap with no cost behind it is a limit invented for the look of the thing; 5.6 can add
one on evidence.

Note for 3.5: `DEFAULT_PAGE_SIZE` is currently echoed by `GET /api/health`
(`api/server.ts`) as a 0.2-era proof that the `shared` workspace resolves. It does not belong
on a health check, and that field plus its assertion in `server.test.ts` should come out when
the real endpoints land.

**5. Options arrive already validated, and 3.1 does not re-validate them.** Boundary validation
has exactly two owners — `parseSearchArgs` for the CLI, 3.5's zod middleware for HTTP — and the
service trusts what it is handed, the same way `crawl()` trusts the `CrawlOptions` 1.7 built
and `writeIndex` trusts its `BuiltIndex`. A third copy of the rules inside the service is a
third place that can disagree about what `pageSize = 0` means. `MAX_QUERY_LENGTH` is therefore
3.5's to enforce, not 3.1's.

**6. `corpus_stats` is read on every query and not memoized here.** It is a single-row read on
a primary key. More to the point, that row's `updated_at` is the reindex signal 2.5 handed to
Phase 3, so caching it inside the query processor would build the exact staleness problem 3.4
exists to solve, one layer below where 3.4 can see it. If 3.4 later hoists the read behind its
own invalidation poll that is the cache's decision to make, and leaving it uncached here is
what keeps that decision available.

**7. `k1` and `b` are never caller-supplied over HTTP.** They stay on the function signature so
tests and the CLI can pass them, and 3.5 does not forward them from the query string. Two
reasons, the second decisive: a ranking knob in anonymous hands is a way to make results look
broken, and 3.4's cache key is *normalized query + page*, so a caller-supplied `k1` silently
becomes a third key dimension and an unbounded way to fill the cache. The asymmetry settles it
— exposing them later is easy, withdrawing them once public is not.

**8. `ranking/cli.ts` is refactored onto the service in the same change.** Otherwise there are
two orchestrations of the same six steps, which is precisely what `processQuery` and
`searchStore` were each created to prevent one layer down — and the CLI's copy is the one that
will quietly drift, because nothing but a human reading both files would notice. The CLI keeps
`formatResults` and `explainTerms`; it loses its copy of the pipeline and gains its per-term
`df`/IDF from decision 3's returned `TermPostings[]` rather than from a fetch of its own.

**Through-line: the service computes one value and the caller decides what it means.** It does
not build snippets, does not cache, does not know about HTTP status codes, and does not decide
whether an empty result is worth an error. Same shape as every module this plan has settled —
1.1's `FetchResult`, 1.4's `AddResult`, 2.2's `BuiltIndex`, 2.4's `ScoredDocument[]` — and the
reason 3.4 can wrap it without reaching inside.

### Phase 3.2 — Snippets + highlighting: agreed design (settled before implementation)

3.1 returns which documents won and why, and a result list of bare titles is a table of
contents rather than a search engine — the snippet is where the user decides whether a hit is
worth a click. It is also the first module to use the one thing every phase since 2.1 has been
careful to preserve and nothing has yet read: token **positions**. That makes 3.2 the test of
whether the offset discipline 2.1, 2.2 and `indexableText` were built around actually closes.

**Inherited constraints** — decided by 1.3, 2.1, 2.2, 2.4 and 3.1, not open here:

- **Rebuild the indexed string with `indexableText({ title, contentText })`, never
  `content_text` alone.** 2.2 indexed title-plus-body as one string; reading the body alone
  shifts every position by the title's token count and every snippet quotes the wrong sentence.
- Positions are recoverable only by re-running `processText` over that string — the pipeline is
  deterministic, and `ProcessedToken` carries `start`/`end` against the *raw* input because 2.1
  normalized per token specifically so those offsets would survive.
- `matchedTerms` is what to highlight from, and it records a match even where the term's IDF was
  zero — the user can plainly see the word.
- The transport is **plain snippet + match offsets**, client-rendered; no HTML crosses the wire.
- `search/` imports no database; 3.5 is the composition root.
- `content_text` was normalized in 1.3 — NBSP, soft hyphens and zero-width characters are
  already gone, precisely because this is the column snippets are sliced from.

**1. `positions` is not fetched; everything is derived from the re-run.** The obvious plumbing
job — widen `fetchTermPostings` to select `postings.positions` — turns out to be unnecessary and
slightly wrong. Re-running `processText(indexableText(doc))` reproduces the stored ordinals *and*
yields the character offsets postings cannot hold, so filtering that array by `matchedTerms` is
the whole answer; the stored copy is the same fact minus the half 3.2 needs. Two arguments beyond
one less column. It is the plan's standing objection to two sources of truth for one fact — 2.2
refused to store `doc_freq` beside the array it is the length of. And it fails in the
*recoverable* direction when the index is stale: a page re-crawled but not reindexed has fresh
text and old postings, and mixing stored ordinals with fresh text quotes a confidently wrong
sentence, where deriving both from one string is self-consistent and at worst highlights a term
BM25 scored against slightly different prose.

Consequence worth recording rather than hiding: `postings.positions` then has **no reader
anywhere in the codebase**. It stays justified by phrase queries, which this plan has never
scheduled. The column is already written and costs nothing to keep, but it is now speculative
storage and should be called that.

**2. `snippets.ts` is pure; `searchQuery` calls it.** `buildSnippet(text, matchedStems, options)`
→ `{ snippet, matches }`, with no `Queryable`, no I/O and no clock — the rule `bm25.ts`,
`scorer.ts` and all of `processing/` follow, and the reason 44 of 2.4's 54 tests need no
infrastructure. The window-selection arithmetic is where the bugs will be, and it should be
testable against string literals.

Snippets are built **inside** `searchQuery` rather than by a layer above it. 3.4 caches whatever
the service returns, and a two-step "search, then decorate" gives the cache a choice between
storing an incomplete value and reaching around the seam. So `RankedResult` gains `snippet` and
`matches` and becomes structurally `shared`'s `SearchResult` — which is exactly what 3.1 meant by
the mapping being near-identity: this is the seam where the missing fields get added.

**3. `content_text` rides on `fetchDocuments`, not a second query.** Adding it to the existing
`SELECT id, url, title` is the case 2.4's split was designed for — score over the candidate set,
hydrate only the page being returned — and the hydration query is already bounded by `pageSize`.
A second lookup over `documents` is the drift `searchStore` exists to prevent, and the reason 3.1
was told to reuse it rather than write its own join.

**4. Match offsets are snippet-relative, and are computed last.** `SearchMatch.start/end` index
into the returned `snippet` string. Document-relative offsets would hand the client a base it was
never given. The rule that keeps this honest is procedural: **assemble the final string —
ellipses included — and only then compute offsets against it.** A leading `… ` shifts every match
by two characters, which reviews as correct and highlights one word to the left in the browser.
Pinned by a test whose window starts mid-document.

**5. The window is a fixed character budget, and distinct terms win it.** ~300 characters, about
two lines in the result card; a small corpus benefits from more context than the ~160 a large one
would use. Selection is a sweep over the matched tokens, scoring each candidate window by
**distinct stems covered**, then total matches, then earliest — distinct-first being the
load-bearing half. For `documents containing`, a window holding one of each is a better answer
than one holding four `documents` and no `containing`, and a naive count picks the second. Edges
snap out to whitespace so no word is cut, and truncation is marked with `…`. The budget is a
`SNIPPET_DEFAULTS` module constant overridable per call — same placement as `FETCH_DEFAULTS`,
`CRAWL_DEFAULTS`, `INDEX_STORE_DEFAULTS` and `BM25_DEFAULTS`, and deliberately not in `shared/`,
since the client does no snippet arithmetic.

**6. The snippet never quotes the title.** Windows are restricted to the body region, whose start
offset `indexableText`'s `\n\n` join makes trivially computable. 2.2 warned that a window would
occasionally land in the title and treated it as an accepted cost; the reason to prevent it
instead is that the title is already rendered directly above the snippet, so a title-region
window prints the same words twice in a two-line card. Title *highlighting* is explicitly not
3.2's: a second offset array is a second contract for the client to honour, added on no evidence,
and 4.4 can match terms against a string it already has.

**7. No matches is a real branch, not an empty string.** Reachable two ways — a term occurring
only in the title (see 6), and index staleness — so the fallback returns the head of the body
with `matches: []`. It gets its own test, because a builder that returns `""` here ships a
results page of blank cards, which reads as a rendering failure rather than as a boring answer.

**8. No `dompurify`, and the replacement is a contract.** The subphase said "sanitize if any HTML
is produced"; with offsets-not-HTML resolved, nothing produces HTML, and the dependency would
guard a path that does not exist. `content_text` is already tag-stripped extracted text from 1.3
and a snippet is a substring of it. What ships instead is a documented obligation for Phase 4:
the snippet is untrusted text from a crawled page, and 4.4 renders it as text nodes split at the
offsets — never `dangerouslySetInnerHTML`. 5.6's XSS test then targets the client's renderer,
which is the only place an injection could land. `dompurify` stays in the cross-cutting table as
the backstop it is described as, to be added if a later phase genuinely emits markup.

**Through-line: the snippet is a view of the document, not a fact about it.** Nothing is stored,
nothing is cached here, and re-running the pipeline per result is accepted CPU rather than a
schema change — **an accepted cost recorded now rather than discovered in 5.4**: 3.4's cache
absorbs repeats, and per-`docId` memoization is the escape hatch if measurement ever justifies
it. Same shape as every module this plan has settled: 3.2 computes one value per result and the
layer that owns the request decides what to do with it.

### Phase 3.3 — Autocomplete: agreed design (settled before implementation)

3.1 and 3.2 answer a question the user has already finished asking. 3.3 is the first module
that runs *while they are still typing*, and that single difference drives every decision
below: it fires per keystroke, so it cannot touch the network, and it is the first thing in
this repo that holds state which goes **stale** — the corpus it describes is rebuilt by a job
in another process that it will never observe directly.

**Inherited constraints** — decided by 0.2, 0.4, 2.1, 2.3 and 2.5, not open here:

- Suggestions match **`surface_form`**, never `terms.term` — the latter holds stems, and
  suggesting `comput` for `comp` is the visible breakage the Phase 0 decision existed to
  prevent.
- The lookup is **in-process**. Hosted Redis free tiers meter requests and this is the
  highest-volume endpoint in the app, which made a ZSET simultaneously the slowest and the
  costliest option.
- The reindex signal is **`corpus_stats.updated_at`**, written by `writeCorpusStats` on every
  run. There is no process boundary to fire an event across — 2.5 handed this here.
- `SUGGESTION_LIMIT = 8` lives in `shared/constants.ts`, where the client can see it.
- `search/` imports no database; it takes a `Queryable` and 3.5 is the composition root.

**1. "Ranked by `doc_freq` + popular queries" loses its second half — dropped, not deferred.**
Nothing in this repo has ever recorded a query, and both ways of starting fail on the hosting
model rather than on effort. An in-process counter dies at every restart and is shared with
nobody, so the signal would always be colder than the cache it ranks; a `query_log` table puts a
**write** on the per-keystroke endpoint, which is the one place this plan has consistently
refused to spend. That leaves a ranking signal whose only claimant is the sentence proposing it
— the same shape of thing 2.4 dropped the TF-IDF baseline for and 2.5 declined an incremental
reindexer for. `doc_freq` alone, and popularity revisited on evidence: a query log is a Phase 5
observability feature, and if one ever lands it can re-rank suggestions as a second pass without
changing this module's interface.

**2. A sorted array with a binary search, and the scan is the part worth explaining.** The array
is sorted by **surface form**, so the terms starting with a prefix are a contiguous range found
by two binary searches. But the *ranking* is by `doc_freq`, which is unordered within that range
— so the top 8 cannot be read off the front, and the range has to be scanned. That is the real
cost, and it is bounded by the vocabulary rather than by the corpus: ~10k terms means a
one-character prefix scans a few thousand entries of a flat array, which is nothing against the
network round trip the request has already paid. A trie with a precomputed top-K per node
removes a cost that has not been measured to exist, and it is a second structure to keep
consistent with `terms`. The escape hatch is the one the key decisions already recorded — cap
the index to the top N terms by `doc_freq` — and it changes nothing above `suggest()`.

**3. The typed prefix goes through `normalizeToken` only, and this is a deliberate exception to
the reuse rule.** Everywhere else the query side calls `processQuery`, because a second copy of
the four steps is drift that typechecks and fails silently. Here `processQuery` is the wrong
function, in two ways that both return an empty list rather than a wrong one: it **stems**, and
the stem of a partial word matches nothing (`comp` stays `comp`, while the array holds
`computer`), and it **drops stopwords**, so typing `th` on the way to `throughput` would return
nothing at all. What autocomplete needs is exactly the one step that makes typed text comparable
to a stored `surface_form`, which is `normalizeToken` — the same function 2.1 applied to produce
those surfaces. Recorded loudly, because a reader who knows this plan's through-line will
otherwise read it as an oversight.

Multi-word input suggests on the **last token only**, with the completed portion carried through
untouched: `web cr` offers `web crawler`, not `crawler`. Anything else hands the client a
fragment it has to splice back onto the input, and the splice is where the off-by-one lives.

**4. A `SuggestIndex` class taking a `Queryable`, with an injected clock.** Same shape as
`Frontier`, `DocumentStore` and `crawl()` — 3.5 constructs it, so `search/` still imports no
connection. The clock is injected for the reason 1.5 injected one: the whole staleness policy is
time-dependent, and a suite that has to sleep to test it is a suite that gets deleted. It also
avoids `setInterval`, which this plan has been bitten by twice — 1.1's backoff timer and 1.5's
`countdown` are both deliberately not `unref`'d, and a background interval inside a library
module is a process that will not exit and a test that hangs with no indication why.

Polling is therefore **opportunistic**: a `suggest()` call checks whether `minPollIntervalMs`
has elapsed since the last check and, if so, re-reads `updated_at` before answering. No timer
exists when nobody is searching, which is the right behaviour for a free instance.

The request that *detects* a version move does wait for the rebuild — one indexed query over
`terms`, on the order of milliseconds, and waiting is what makes the next keystroke correct. A
request arriving while that rebuild is **already in flight** is answered from the current array
instead of queueing behind it, so a burst of keystrokes costs one rebuild and one wait rather
than one each. A suggestion one reindex out of date is invisible to a user; a row of stalled
keystrokes is not.

**5. A cold start serves, it does not block `listen`.** The build is one query over `terms`, and
it is fast — but making the server refuse connections until it finishes couples HTTP readiness
to a table that may legitimately be empty, and the honest answer for an unindexed corpus is "no
suggestions", not "the service is down". So nothing is built at construction time and the first
`suggest()` fills the array — which also keeps the build out of a constructor, where it would be
a promise nobody holds and a rejection nobody can attribute. `GET /health` stays meaningful
during a rebuild rather than merely delayed.

The one case that *does* wait is a cold index: with no array there is nothing to serve, and
returning `[]` would render as "no such term" — a wrong answer where a short wait is the right
one. That asymmetry also decides failure handling. A poll that throws **after** a successful
build is swallowed and the existing array served, the same call 1.2 made for a dead Redis
(degrade to fetching robots.txt more often, rather than stop); a poll that throws with nothing
built propagates, because there is no degraded mode to fall back to and a silent `[]` would be
indistinguishable from an empty corpus.

**6. Ties break shortest-then-lexicographic, and `NULL` surface forms are filtered out.** Equal
`doc_freq` is the common case on a small corpus, and an ordering that depends on the order
Postgres happened to return rows shows two users different suggestions for the same prefix over
the same data — the rule 2.2 set for `pickSurfaceForm` and 2.4 set for `docId` ties, applied to
the third place it comes up. Shortest-first is also the better UX: `car` before
`cardiovascular` when both are equally common.

On `NULL`: 0.4's status note says autocomplete reads `COALESCE(surface_form, term)`, and that is
wrong in the direction that matters. The fallback surfaces a bare **stem** to a human, which is
precisely what the Phase 0 display-form decision spent a column to avoid; a suggestion that
cannot be typed as a word is worse than one fewer suggestion. 2.3 populates `surface_form` for
every term it writes, so the filter discards rows that should not exist — the 0.4-era seed
fixture being the only known producer. `WHERE surface_form IS NOT NULL` at the source, so the
in-memory array carries no nullable field to re-check on the hot path.

**7. `readCorpusStats` is widened rather than given a second reader, and the `Date` comparison is
a trap worth naming.** `updated_at` has been written since 2.3 and read by **nothing** —
`readCorpusStats` did not select it and `CorpusStats` had no field for it. The alternative, a
`readIndexVersion()` owned by `search/`, was rejected because `queryProcessor` already imports
`readCorpusStats`, so there is no coupling to avoid, and because 3.1 decision 6 left that read
unmemoized *specifically* so 3.4 could hoist it behind its own poll: a second single-row query
over the same table is one more thing for 3.4 to reconcile.

It is exposed as **epoch milliseconds, not a `Date`**. TIMESTAMPTZ comes back from
node-postgres as a JS `Date`, and `new Date(x) !== new Date(x)` is *always* true — object
identity, not value — so a poll comparing `Date`s reports a reindex on every tick and rebuilds
the array forever, burning a query per keystroke while looking perfectly correct in review. A
number compares by value. Converted in the one place, for the same reason the BIGINT is.

**Through-line: the index is a cache of `terms`, and it says so.** It stores nothing that is not
derivable from a single query, it is rebuilt rather than mutated, and it is expendable — a
restart costs one query. Same shape as every module this plan has settled: `suggest()` computes
one value from state it owns, and 3.5 decides what a request does with it.

### Phase 3.4 — Result cache: agreed design (settled before implementation)

3.3 was the first module holding state that goes **stale**, and it answered that with a poll. 3.4
holds the same kind of state against the same signal, which makes the interesting question not
"how do I cache a search" but "how many things in this process are allowed to poll the same
column." The answer below is one, and that decision is what keeps this subphase small.

**Inherited constraints** — decided by 3.1, 3.2, 3.3 and the hosting model, not open here:

- The cache is **in-process**. Hosted Redis free tiers meter requests; a cold cache after a
  restart and nothing shared between instances are both accepted, and both are irrelevant to a
  single always-on instance that rebuilds from Postgres.
- The reindex signal is **`corpus_stats.updated_at`**, read as **epoch milliseconds** — 3.3
  decision 7 spells out why a `Date` comparison reports a reindex on every tick.
- **`k1`/`b` never reach the key.** 3.1 left them on `SearchOptions` for the CLI and tests; 3.5
  must not forward them from the query string, or they become a third key dimension and an
  unbounded way to fill memory.
- `search/` imports no database, and 3.5 is the composition root.
- 3.2 accepted per-result snippet rebuilding *on the promise of this cache*, so the repeat-query
  path is the one this module exists to pay back.

**1. The cache is pure, and does not poll.** The obvious build — a `ResultCache` that takes a
`Queryable` and checks `updated_at` on the way in — reproduces `SuggestIndex`'s throttle, its
in-flight dedupe, its injected clock and its asymmetric failure handling, and leaves two copies
of a staleness policy to keep in agreement. Instead the version is **passed in**:
`get(key, version)` and `set(key, version, value)`, where a `version` that disagrees with the one
the map was filled at clears the map and reports a miss. That is a comparison and a branch, not a
subsystem. It also means `cache.ts` touches no database, needs no test infrastructure, and is
testable the way `snippets.ts` and `bm25.ts` are — the split that let 30 of 3.3's 33 tests and 44
of 2.4's 54 run against no server at all.

**2. The poll is extracted into `search/corpusVersion.ts`, shared with 3.3.** A `CorpusVersion`
watcher owns exactly what both consumers need and nothing either one reacts with: the throttled
read of `readCorpusStats`, the in-flight dedupe so a burst of requests costs one single-row query,
and the injected clock. `current(): Promise<number>` is its whole surface. `SuggestIndex` keeps
its rebuild, its swap-as-a-unit and its `null`-means-never-built distinction, and loses only
`#lastPollAt`, `#now` and the throttle branch. This is a refactor of a module with 33 passing
tests, and it is the only part of this subphase that can go wrong quietly — do it first, on its
own, with the suite green before anything caches anything.

**The degrade rule moves into the watcher with the poll.** 3.3 put it in `#maybeRefresh`: swallow
a failed read if something is already built, propagate if nothing is. Stated over the *read*
rather than over the array, that is "return the last version I successfully read; throw only if I
have never read one" — the same rule, in one place, and both consumers inherit it. A cache
serving one reindex-old results because the version read blipped is 1.2's call for a dead Redis,
and a cache that fails a request because it could not confirm freshness has the priorities
backwards.

**3. What is cached is a projection, not a `SearchPage`.** `SearchPage.terms` is
`TermPostings[]`, and `TermPostings.postings` is the **full posting list** for each query term —
so a verbatim entry's footprint scales with `doc_freq`, and a one-term query on a common word
caches every posting in the corpus. An LRU that counts entries would bound the entry count while
bounding nothing that matters. The cached value is therefore `SearchPage` minus `terms`, which is
also — not by coincidence — what 3.5 puts on the wire; `terms` exists for the CLI's `--explain`,
and the CLI is not a cache client. With `terms` gone an entry is one page of results carrying
snippets capped at 300 characters: **~5 KB**, so a 500-entry cap is single-digit MB and can be
stated rather than guessed at.

**4. The key is the stems, and `query` is re-attached on the way out.** Keying on the raw string
makes `Documents`, `documents ` and `documents` three entries for one answer; the stems are what
the index was actually consulted with, so they are what identifies the result set. `stems.join(" ")
+ page + pageSize`, nothing else. But `SearchPage.query` echoes what the caller typed, and a hit
for `Documents` must not answer with a page saying `documents` — so `query` is **excluded from
the stored value** and re-attached from the live request. The stored value is then genuinely a
function of the key, which is the property that makes the sharing safe.

**Stopword-only queries are not cached.** 3.1 returns `no-searchable-terms` before any I/O, so
there is nothing to pay back, and their stems are empty — every one of them would collide onto
the same key while differing in the `query` field that is not stored.

**5. The version is read before the query, not after.** An entry stamped with a version read
*after* its results were computed can hold pre-reindex results wearing a post-reindex version,
which the comparison in decision 1 will never catch — stale until something unrelated moves the
column. Read first, stamp with that, and the failure mode inverts into a redundant miss.
*(**Checked and fixed.** `SuggestIndex.#rebuild`'s fallback branch did read the version after its
rows, and the comment above it described the opposite ordering as the broken one. The common path
was safe — `#maybeRefresh` passes `knownVersion`, read first — so only the startup `refresh()`
took it, and nothing failed, which is why it survived 33 tests. See 3.4 in Status.)*

**6. TTL is a backstop, not the invalidation mechanism.** Invalidation here is *exact*: the
version moves, the map clears. A TTL adds nothing to correctness and its usual job — bounding how
wrong a stale entry can get — is already done. It stays because it costs a timestamp per entry
and covers the one case the version cannot: a signal that silently stops moving, from an indexer
that failed to write, leaving a cache that is confidently serving a corpus that no longer exists.
**5 minutes, 8 MB, 500 entries, LRU by last read.**

*(Amended after implementation.* This first shipped hand-rolled over a `Map` — insertion order is
recency order, so delete-then-set on a read is the whole LRU — on the reasoning that `lru-cache`
was a dependency for six lines. That was right about the six lines and wrong about the bound: a
count of entries is not a bound on memory when `pageSize` is a key dimension, so the cache is
`lru-cache` with `maxSize` and a `sizeCalculation`, and **bytes are the real cap** with the entry
count kept as a secondary guard. The rest of the module was untouched by the swap. See 3.4 in
Status.)*

**Through-line: the cache knows nothing about search.** It stores values under keys, forgets them
on a version change, and is handed both the key and the version by its caller. The cache never
consults Postgres, `queryProcessor` never learns it is being cached, and 3.5 composes the three.
Same shape as everything else this plan has settled — and the reason a subphase that sounded like
"an LRU plus a poll" is an LRU, a shared watcher, and a projection.

### Phase 3.5 — API layer: agreed design (settled before implementation)

3.1 through 3.4 each computed a value and refused to say what it meant. 3.5 is where that gets
decided, and being the last subphase of the phase it attracts everything still unowned — logging,
metrics, an admin surface, a second set of knobs. The scope below is deliberately *smaller* than
the subphase line that opened Phase 3: four handlers, one schema each, one error handler, two rate
limiters, and one new field on the wire. Everything it declines is named in decision 8, with the
phase that already owns it.

**Inherited constraints** — decided by 3.1–3.4 and the hosting model, not open here:

- **One `CorpusVersion` for the process**, constructed here and passed to both consumers. Two
  watchers double the poll and let the cache and the suggest index disagree about which corpus
  they describe.
- **The version is read before `searchQuery`, and the same number goes to `get` and `set`.** A
  version read afterwards stamps a pre-reindex page as fresh — 3.4 decision 5, and the bug it
  found in `SuggestIndex.#rebuild`.
- **`k1`/`b` are never forwarded from the query string** (3.1 decision 7): a ranking knob in
  anonymous hands, and an unbounded third dimension on 3.4's cache key.
- **This layer owns the bounds** — `MAX_QUERY_LENGTH`, `MAX_PAGE_SIZE`, `SUGGESTION_LIMIT` — and
  takes their values from `shared/constants.ts`. The `search/` modules apply them as defaults and
  enforce nothing; a second copy of the numbers here is the drift the workspace exists to prevent.
- **All three search statuses are HTTP 200** (3.1 decision 2). None is a client error.
- **Snippets and suggestions are untrusted crawled text.** Offsets on the wire, no HTML, no
  `dompurify` (3.2).
- `search/` imports no database; **this is the composition root.**

**1. Three files, and the long-lived state is built in `server.ts`.** `server.ts` assembles the
app and constructs the three objects the process keeps — `new CorpusVersion(pool)`, then
`new SuggestIndex(pool, { version })` and `new ResultCache()` — at module scope, so there is
exactly one of each and `supertest` drives the same wiring production does. `routes.ts` holds the
four handlers and their zod schemas; `middleware.ts` holds the validator, the limiters and the
error handler. *(**Amended after implementation.** There is no `validate(schema)` middleware:
in Express 4 it has nowhere type-safe to put its output — `req.query` is untyped and becomes a
getter in Express 5, and `res.locals` hands the handler back an `any`, losing the schema's
inferred type at the exact boundary it exists to establish. The handlers call
`schema.parse(req.query)` themselves, one line each, and the `ZodError` still lands in the one
error handler. `routes.ts` also takes an injected `ApiDeps` rather than importing the singletons
`server.ts` constructs, which would be an import cycle. See 3.5 in Status.)* The plan's fourth file is dropped: a `routes.ts` whose entire content is four lines
naming handlers defined in `controllers.ts` is two files that must be read together to learn one
thing, and there are four handlers. `index.ts` keeps its 0.1 role and gains one line —
`suggestIndex.refresh()` fired **without** `await` and with a `.catch()`, per 3.3's handoff, so
the first person to type gets a warm index and `listen` never waits on Postgres.

**2. The handler computes the stems, and `searchQuery` computes them again.** 3.4 keys the cache
on stems, and the cache has to be consulted *before* the query that produces them — so the handler
calls `uniqueTerms(processQuery(q))` itself, builds the key, and on a miss hands the raw query to
`searchQuery`, which repeats those two pure calls. The duplication is a few tokens of CPU and no
I/O; both alternatives are worse in the direction that lasts — keying on the raw string was
rejected in 3.4 decision 4 (`Documents` and `documents` become two entries for one answer), and
splitting the stemming out of `searchQuery` so it can be passed back in turns 3.1's one function
into two that must be called in the right order. It also settles "do not cache
`no-searchable-terms`" for free: `stems.length === 0` is known before the cache is touched.

**3. `GET /search` is one fixed sequence.**

```
validate  → { q, page, pageSize }
stems     = uniqueTerms(processQuery(q))
if empty  → searchQuery (returns before any I/O) → 200, no cache read, no cache write
version   = await corpusVersion.current()          ← before the query, always
hit       = cache.get(cacheKey(stems, page, pageSize), version) → 200 { ...hit, query: q }
miss      → result = await searchQuery(pool, { query: q, page, pageSize })
            cache.set(key, version, toCachedPage(result))
            → 200
```

`empty-index` is cached like any other page rather than special-cased: it is version-invalidated
exactly as `ok` is, and the branch that would skip it costs more than the entry does. `query` is
re-attached from the live request on the way out, which is why `CachedPage` omits it — a handler
that forwards a hit unmodified fails to typecheck instead of answering one caller with another's
spelling.

**4. The schemas accept only what the client actually sends.** `/search` takes `q`
(1…`MAX_QUERY_LENGTH`), `page` (int ≥ 1, default 1) and `pageSize` (int 1…`MAX_PAGE_SIZE`,
default `DEFAULT_PAGE_SIZE`), coerced, since a query string is all strings. `/suggestions` takes
`q` and **nothing else** — no `limit`. 3.3 left clamping to this layer, but the simpler answer is
not to accept the parameter: no caller wants a number other than `SUGGESTION_LIMIT`, and 3.1
decision 7's asymmetry applies unchanged (exposing it later is easy, withdrawing it once public is
not). `k1` and `b` appear in no schema, which is where 3.1 decision 7 stops being a policy and
becomes code — an unrecognized query parameter is ignored, never forwarded. A validation failure
is `400 { error }`: one string, not zod's issue tree, which describes our schema to a stranger.

**5. Two rate limiters, `/health` has none, and `trust proxy` is set.** One shared limit cannot
serve both endpoints: `/suggestions` fires while someone types and `/search` fires when they stop,
so a limit low enough to protect search is spent on one word, and a limit loose enough for
keystrokes does not limit search at all. **`/search` and `/statistics`: 60/min per IP.
`/suggestions`: 300/min per IP.** `/health` is deliberately unlimited — the hosting platform pings
it, and a 429 there reads as an unhealthy instance and gets the process restarted.
`app.set("trust proxy", 1)` is required rather than optional: behind the host's proxy every
request carries the proxy's address, so without it the limiter puts every user in one bucket and
either does nothing or blocks all of them at once.

**6. `/statistics` returns the corpus row and nothing else.** `readCorpusStats` already exists and
already returns `updatedAt` (3.3 added the reader), so this is one indexed single-row query mapped
to `{ totalDocs, totalTokens, avgDocLen, updatedAt }` — `updatedAt` as an **ISO-8601 string, or
`null` when the corpus has never been indexed**, since `readCorpusStats` reports that as `0` and
`1970-01-01` on a stats bar is a wrong answer rather than a missing one. Rejected: cache hit
rates, suggest-index size, uptime — an observability surface built for a dashboard nobody has
asked for. 5.4 adds numbers once it has measured something.

**7. `status` joins `SearchResponse`, and that is the only wire-type change.** 3.1 decision 2
spent a discriminated union keeping three empty results distinct, and `shared`'s `SearchResponse`
has no field to carry the distinction — so today it dies at exactly the boundary it was built to
cross, and 4.4 cannot tell "no results for *the*" from an unindexed corpus. `SearchStatus` moves
to `shared/types.ts`, since it is a contract type now, and `queryProcessor` imports it the way it
already imports `SearchMatch`. `stems`, `terms` and `stats` are dropped on the way out.
`matchedTerms` is left on each result: `RankedResult[]` assigns to `SearchResult[]` structurally,
so it rides along undeclared, and stripping it would cost a per-result map for a field that is
real data and that the client is free to ignore.

**8. What 3.5 does not build, and who owns it instead.** Request logging is **5.5's** ("DX +
docs — logging"), and the error handler's own log is enough to diagnose a 500 until then; building
an access log here means building it twice. `express.json()` is **removed** — all four endpoints
are GET, so it parses nothing and only widens what the API accepts. `helmet` stays, because it is
one line. The one piece of debt this subphase does pay is 3.1's: `defaultPageSize` comes off
`/api/health` along with its assertion in `server.test.ts`, a 0.2-era proof that the `shared`
workspace resolves which has no business on a health check.

**9. Async handlers need a wrapper, because this is Express 4.** A rejected promise in an Express
4 handler is not forwarded to the error handler — the request hangs with no response until the
client gives up, which is worse than a 500 and invisible to any test that only asserts the happy
path. A five-line `asyncRoute(fn)` fixes it. Rejected: upgrading to Express 5, which forwards
rejections natively but turns `req.query` into a getter, changes path matching, and pulls in a new
`@types/express` major — a framework upgrade to avoid five lines, in the subphase whose whole job
is composition. The error handler answers `400 { error }` for a zod failure and
`500 { error: "Internal error" }` for everything else, logging the real one: a Postgres error
message on the wire describes the schema to an anonymous caller.

**New dependencies: two, both one-liners** — `helmet` and `express-rate-limit`. `cors`, `express`
and `zod` are already installed, and nothing else is added.

**Through-line: this layer decides what a value means, owns every boundary rule, and does nothing
else.** It validates, limits, composes, maps to the wire type and picks a status code. It computes
no ranking, holds no state beyond the three objects decision 1 constructs, and enforces no rule a
`search/` module could have enforced itself. The four handlers should each be under twenty lines,
which is the test of whether the previous four subphases returned the right values.

## Phase 4 — Frontend

- **Goal:** a responsive, accessible search UI with debounced input, autocomplete,
  highlighted snippets, and pagination.
- **Depends on:** Phase 3 API contracts (can start against a mocked client once the
  response types exist).
- **Subphases:**
  - **4.1 Setup** — add Tailwind to the Vite client; app shell + routing
    (`react-router` — no longer optional, see key decisions).
  - **4.2 API client** — `services/api.ts`: typed calls to `/search`, `/suggestions`,
    `/statistics` using shared types.
  - **4.3 Hooks** — `useSearch` / `useSuggestions` over TanStack Query, debounced input
    via `use-debounce`.
  - **4.4 Components** — `SearchBox`, `Suggestions` (keyboard-navigable combobox),
    `ResultList` / `ResultItem` (highlighted snippet), `Pagination`, `StatsBar`, and
    loading / empty / error states.
  - **4.6 Empty state** — not in the original list. Example-query chips and a corpus
    description on the empty state, closing the "how does a visitor know what to search for"
    problem that had been discussed since Phase 1 and never assigned. See Phase 4.6 in Status.
  - **4.5 Pages + polish** — Home/Search page; responsive layout; ARIA for the
    autocomplete combobox. The scope was wider than this line: 4.4 had already carried the
    combobox and the 390px layout, and what an accessibility pass actually turned up was a
    results section announced in full by a live region, an input whose only focus indicator
    was a border colour, and a page title that never named the search. See Phase 4.5 in
    Status.
- **Key decisions:**
  - **Build policy — resolved: prefer a maintained library over a hand-rolled
    implementation.** Phase 4 contains no Information-Retrieval work, and the project's
    from-scratch principle exists to make the IR core the thing that is actually learned — so
    it does not extend here. Where a library covers a Phase 4 concern, take the library;
    hand-roll only where none fits the Phase 3 contracts. **This reverses the three
    "recommend custom" defaults previously recorded in this block**, which are kept below as
    the rejected alternative in each case.
  - **Combobox / autocomplete → Headless UI (`@headlessui/react`).** The WAI-ARIA combobox
    pattern is the hardest thing in the phase and the easiest to ship subtly broken for a
    screen reader, which is precisely the failure a library amortizes. Headless UI is
    unstyled and comes from the Tailwind authors, so it composes with 4.1's styling decision
    rather than fighting it. Downshift is the fallback if React 19 support disappoints.
    *(Was: hand-roll against the WAI-ARIA APG.)*
  - **Data layer → TanStack Query**, not plain hooks + `fetch`. Beyond caching it settles the
    out-of-order-response race that debounced search creates — typing `cat` fires a request
    for `ca` and then for `cat`, and the slower one must not win — which plain hooks fix only
    by hand-rolling an `AbortController` per hook. `placeholderData` also keeps the previous
    page rendered while 4.4's `Pagination` fetches the next. *(Was: plain hooks, "keep light".)*
  - **Debounce → `use-debounce`**, not a custom `useDebounce` — a hook, not a generic
    utility that then has to be memoized and cancelled against the React lifecycle.
    *(Was: custom `useDebounce`; `lodash.debounce` was the other rejected option.)*
  - **URL state → `react-router`** (`useSearchParams`). This promotes 4.1's "(optional)
    routing" to required: without `?q=` in the address bar a search engine has no back button
    and no shareable result links.
  - **Highlighting → still offsets, still hand-rolled — the one exception the policy allows,
    because the library that exists solves a different problem.** `react-highlight-words`
    matches *words* against text, while the server sends explicit `{start, end}` offsets
    computed *after* stemming — which is why `documentation` is a match for the stem
    `document`, and why no word-matcher reproduces the result. Its `findChunks` escape hatch
    means writing the offset logic anyway and then wrapping it in a dependency. 3.2 decision
    8's obligation is unchanged: text nodes split at the offsets, never
    `dangerouslySetInnerHTML`, and `dompurify` stays out.
  - **`splitSnippet` stays a standalone pure function**, not inline JSX inside `ResultItem`, so
    5.6's XSS test can target it with plain Vitest — no jsdom, no Testing Library.
  - **Phase 4 ships no tests of its own.** The subphase list never scheduled any, `client/` has
    no test runner, and component tests of presentational React are largely tautological.
    5.6 owns the one client-facing test; 5.3's Playwright pass stays optional.

## Phase 5 — Tests + Polish

- **Goal:** confidence and production-inspired finish — unit + integration tests,
  performance tuning, docs, and hardening.
- **Depends on:** the relevant phase for each test target (runs incrementally, not just
  at the end).
- **Subphases:**
  - **5.1 Unit** — tokenizer, normalizer, stemmer, BM25 (known-answer tests), URL
    normalization, frontier dedup, snippet builder.
  - **5.2 Integration** — crawler against a **local fixture server**; indexer end-to-end
    on a tiny corpus; API tests with `supertest`; cache hit/miss.
  - **5.3 E2E (optional)** — Playwright for the search flow.
  - **5.4 Performance** — index-build timing, query latency, cache effectiveness; add DB
    indexes; `EXPLAIN ANALYZE` hot queries.
  - **5.5 DX + docs** — logging, `seed` script, `.env.example`, `docker-compose`, README
    run instructions.
  - **5.6 Hardening** — XSS test on highlighting, robots-compliance test, rate-limit and
    input-validation edges.
- **Key decisions:**
  - Test framework: **Vitest — resolved in 0.5** (Vitest 4 in the server workspace; `npm test`
    at both the workspace and repo root).
  - Test-DB strategy: ephemeral schema vs. Testcontainers vs. a dedicated docker test DB →
    **a separate `search_engine_test` database in the same docker-compose Postgres, resolved in
    0.5.** Fastest, no extra tooling, and the suite runs against the *real* migrated DDL rather
    than a mock that could drift. `globalSetup` refuses any database whose name does not end in
    `_test`.
  - Coverage targets and which paths are must-cover (ranking, tokenizer, snippet safety).

---

## Phase 6 — Deployment

- **Goal:** get the thing on the internet, on free tiers, with the smallest number of
  moving parts. Not a platform — one Node instance, one managed Postgres, one static
  bundle, and a documented way to refresh the corpus.
- **Depends on:** Phase 4 (a client to serve) and Phase 5.5 (`.env.example`, README run
  instructions — the same material a deploy needs).
- **Explicitly out of scope:** CI/CD, containers in production, autoscaling, metrics
  dashboards, blue/green. This is a portfolio deployment; anything that would need a
  second instance is a reason to *not* do it, not a reason to build for it.

### Subphases

- **6.1 Production build.** `npm run build` at the root already does the right thing —
  `postinstall` builds `shared`, then server (`tsc` → `server/dist`) and client
  (`vite build` → `client/dist`). Start command is `npm start --workspace=server`
  (`node dist/index.js`). The one trap: the build needs `devDependencies`
  (`typescript`, `vite`, `tsx`), so the host must **not** install with `--omit=dev`
  before building.
- **6.2 Serving the client.** Decide one of the two deployments 4.2 already anticipated,
  and record which. Default: **one Node instance serves both** — `express.static(client/dist)`
  plus a catch-all that returns `index.html` for client-side routes. Mounting it after the
  `/api` router is *not* enough on its own: the router doesn't terminate unmatched paths, so
  `/api/typo` would fall through and get the SPA shell — a 200 of HTML where the client
  expects JSON, which 4.2's `UNPARSEABLE` branch was written to catch but shouldn't have to.
  Add an explicit `/api` 404 (JSON) before the catch-all, or scope the catch-all to exclude
  `/api`. This keeps `API_BASE_URL`'s `/api` default correct and needs no CORS story at all.
- **6.3 Migrations on deploy.** `npm run migrate` hard-codes `--envPath .env`, and there is
  no `.env` file on a host — the variables are real environment variables. Add a
  `migrate:deploy` script without that flag and run it as the release/pre-start step.
  The migrations live in `server/db/`, outside `src/`, so they survive the build — that was
  0.4's reason for putting them there.
- **6.4 Production config.** `NODE_ENV=production`, `PORT` (usually assigned by the host),
  `DATABASE_URL` for the managed Postgres, and **`REDIS_URL` left unset** — 0.3-amended made
  that a valid production configuration, not a missing one. Managed Postgres normally
  requires TLS; confirm the connection string carries `?sslmode=require` (or whatever the
  provider issues) before assuming the pool is broken.
- **6.5 Getting data in.** The corpus is built **locally, against the managed Postgres**,
  not on the host: point a local `.env` at the production `DATABASE_URL` and run
  `migrate` → `crawl` (with `--fresh`, per Phase 1's frontier gap) → `index`. The API needs
  no restart afterwards — `CorpusVersion` polls `corpus_stats.updated_at` and both the
  result cache and the suggest index rebuild themselves. Redis is only needed on the
  machine running the crawl.
- **6.6 Verify.** Point the platform's health check at `GET /api/health` — it already
  returns 503 when Postgres is unreachable, which is exactly the semantics a health check
  wants. Then a manual smoke test: a search that returns results, a suggestion, the stats
  line naming the three hosts, and one cold start timed (the suggest index warms
  asynchronously, so the first request should not block on it).

### Key decisions

- **One instance, and the design already assumes it.** The result cache, the suggest index
  and `express-rate-limit`'s store are all in-process. A second instance would give each of
  them its own copy — two caches, two rate-limit buckets — so scaling out is a design change,
  not a config change. At this traffic it is the right call; it is recorded here so the
  assumption is visible rather than discovered.
- **The crawl and index jobs never run on the host.** They are long, they need Redis, and
  they would have to share the API's one instance. Running them locally is what let 2.3 choose
  `DELETE` over `TRUNCATE` — the rebuild is concurrent with live queries and must stay that way.
- **`trust proxy` is already `1`**, set in 3.5 for exactly this: behind the host's proxy every
  request otherwise carries the proxy's address and the rate limiter puts every user in one
  bucket.
- **Graceful shutdown is already handled** — `index.ts` drains on SIGTERM with a 10s force-exit,
  which is the contract hosting platforms actually use.
- **If the client is instead hosted separately** (a static host on its own domain), then
  `VITE_API_BASE_URL` must be set at *build* time — Vite inlines it into the bundle, so it
  cannot be configured after the fact — and `cors()`'s current unrestricted default should be
  narrowed to that origin.

### Open questions — both resolved (2026-08-22)

- **Which host → Render (web service) + Neon (Postgres), both Singapore, Postgres 17.**
  The requirement that decided it: an always-on Node process, *not* a serverless function, since
  the in-process cache and suggest index depend on a warm long-lived process. Neon rather than
  Render's own Postgres because free Render databases expire 30 days after creation. Rationale in
  full under Status.
- **Client ships from the same instance** — 6.2's default, implemented and verified.
- **Accepted cost, recorded because it is the one visible flaw:** a free Render service spins down
  after 15 minutes without traffic and takes ~1 minute to come back, so the first visitor after a
  quiet spell waits, and 4.5's empty state is what they wait on. No free tier avoids this. The
  suggest index warming asynchronously behind that first request is the existing design doing
  exactly what it was built for.

---

## Sequencing & dependencies

```
Phase 0 ─▶ Phase 1 ─▶ Phase 2 ─▶ Phase 3 ─▶ Phase 4 ─▶ Phase 6
   └───────────────── Phase 5 runs alongside every phase ─────────────┘
```

- **Hard order:** 0 → 1 → 2 → 3. Ranking needs an index; the API needs ranking.
- **Phase 6 is last** — it deploys what Phases 0–4 built, and leans on 5.5's docs/env work.
- **Parallelizable:** Phase 4 can begin once Phase 3's response types are fixed (mock the
  API). Phase 5 tests are written with each phase, not deferred to the end.
- **Shared contracts** (Phase 0.2 types) unblock both server and client early.

## Cross-cutting decisions (resolved defaults)

| Area | Default |
|------|---------|
| Monorepo | npm workspaces (existing) |
| IR core | custom crawler, inverted index, BM25, tokenizer |
| Stemming | Porter, via the `stemmer` package (was `natural` — see Phase 2.1 in Status) |
| Autocomplete | in-process sorted term index (built from `terms`) |
| Frontend CSS | Tailwind |
| Frontend libraries | **prefer a maintained library over hand-rolling** (Phase 4 policy): Headless UI combobox, TanStack Query, `use-debounce`, `react-router`. Offset-based highlighting is the sole hand-rolled exception |
| Durable store | Postgres (raw SQL via `pg`) |
| Ephemeral store | in-process LRU for the API cache; Redis (`ioredis`) for the local crawl frontier only |
| Hosting | free tiers only — managed Postgres + one always-on Node instance; **no hosted Redis** |
| Validation / limits | `zod` + `express-rate-limit` |
| Sanitization | offset-based highlight rendering; `dompurify` as backstop |
