# pi-search-on-your-browser

Search Google and browse the web in your **own visible Chrome browser** — no API keys, no headless detection, your real cookies and login sessions. A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that gives your coding agent two tools: `google_search` and `visit_page`.

## Highlights

- **Google search** via your real browser — returns compact markdown links + snippets
- **`visit_page`** fetches any URL as markdown using your visible Chrome (authenticated everywhere — paywalled sites, X, Reddit, Amazon, GitHub)
- **`clean` extraction** — reader-mode markdown via [Defuddle](https://github.com/kepano/defuddle) (the Obsidian Web Clipper library); drops nav/sidebars/ads, ~47% fewer tokens on docs pages
- **`query` subagent** — pass a question, get only the concise answer back (the full page never enters your chat context); reuses your current Pi model by default, **no setup needed**
- **HTTP error detection** — dead links return a clear `isError` with status-specific hints instead of error-page gibberish
- **Site-specific extractors** — X/Twitter (structured tweets), Reddit (posts + threaded comments), Amazon (products + search), Google Scholar (papers)
- **Zero API keys, zero runtime npm dependencies** — uses your existing browser; nothing to sign up for

> "If you need AI to do a search for you in the real world, ds4-agent is basically SOTA, because it can access the web sites without any limitations given that it uses your local Chrome browser (no, not in headless mode, that's the trick...)"
> — [@antirez on X](https://x.com/antirez/status/2066233392916525379), 2026-06-14

Inspired by the [ds4-agent](https://github.com/antirez/ds4) approach by @antirez: a visible Chrome window (not headless) driven via the Chrome DevTools Protocol, so you're authenticated everywhere — paywalled sites, Twitter, GitHub, Google — because it's **your real browser**.

## How it works

When you call `google_search` or `visit_page`:

1. A **visible Chrome window** opens (not headless) with a dedicated profile at `~/.pi-search-browser/`
2. Chrome DevTools Protocol (CDP) is used to navigate and extract content
3. JavaScript runs in the page to extract readable markdown — site-specific extractors for X, Reddit, Amazon, Scholar; [Defuddle](https://github.com/kepano/defuddle) reader-mode for `clean`; generic block-walker as fallback
4. Chrome stays alive between calls for speed (kill with `/google-search-kill`)

## Install

```bash
pi install npm:pi-search-on-your-browser
```

Or from git:

```bash
pi install git:github.com/xezpeleta/pi-search-on-your-browser@v0.7.0
```

## Tools

### `google_search`

Search Google and get compact markdown links + text snippet.

```
google_search({ query: "TypeScript 5.7 release notes" })
```

### `visit_page`

Visit any URL and get the page content as markdown. Two optional parameters keep large pages from filling your conversation:

- **`query`** — delegate to a subagent model that returns only a concise answer (the raw page never enters your context; reuses your current model by default). [See below.](#optional-query--keep-your-chat-context-small)
- **`clean`** — extract with Defuddle reader-mode (drops nav/sidebars/ads; ~47% fewer tokens). [See below.](#optional-clean--clean-article-markdown-via-defuddle)

```
visit_page({ url: "https://example.com/article" })
visit_page({ url: "https://react.dev/reference/react/useState", query: "What is the return shape of useState?" })
visit_page({ url: "https://react.dev/reference/react/useState", clean: true })
```

**X (Twitter) support:** Any `x.com` / `twitter.com` URL — a search results
page, a profile, or an individual tweet — is extracted as structured tweets
(handle, text, timestamp, permalink, engagement). This works because the
dedicated Chrome profile carries your X login. X virtualizes its timeline, so
the extractor scrolls and collects tweets incrementally, deduping by permalink.

```
visit_page({ url: "https://x.com/search?q=0x%20alpha&f=top" })   // top results
visit_page({ url: "https://x.com/search?q=0x%20alpha&f=live" })  // latest
visit_page({ url: "https://x.com/xezpeleta" })                   // a profile's tweets
```

**Reddit support:** Any `reddit.com` post URL (a path containing `/comments/`)
is extracted as the post (title, author, score, self-text) plus threaded
comments — each with author, score, OP marking, and depth-indented replies.
Reddit lazy-loads comments on scroll, so the extractor scrolls and collects
incrementally, deduping by comment id. Subreddit listings and user pages fall
through to the generic extractor.

```
visit_page({ url: "https://www.reddit.com/r/programming/comments/.../" })
```

**Amazon support:** Any `amazon.*` product page (`/dp/ASIN`, `/gp/product/ASIN`)
or search page (`/s?k=...`) gets a dedicated extractor. Product pages return
structured data — title, price, list price, availability, brand, rating,
review count, feature bullets, technical specifications, ASIN, and top reviews
(best-effort) — instead of the ~110 KB of navigation noise the generic
extractor would pull. Search pages return a clean listing of products with
title, price, rating, ASIN, and link, scrolling to collect more results.

```
visit_page({ url: "https://www.amazon.es/s?k=E220-900T22D" })                       // search
visit_page({ url: "https://www.amazon.es/-/en/.../dp/B097GZBZ9Y" })                  // product
```

Other Amazon pages (category, seller, etc.) fall through to the generic
extractor.

**Google Scholar support:** Any `scholar.google.com` URL is extracted as
structured paper results — title, authors/venue/year, citation count, abstract
snippet, and PDF link — instead of the flat H3 headers the generic extractor
produces (which drops all the academic metadata). Scholar paginates 10 results
per page (not infinite scroll), so the extractor returns the current page;
for more results, visit the next page URL (`&start=10`, `&start=20`, etc.).
Citation counts are parsed locale-agnostically ("Cited by 1108" / "Cité 1108
fois" / "Citado por 1108" / "Zitiert von 1108").

```
visit_page({ url: "https://scholar.google.com/scholar?q=transformer+attention+is+all+you+need" })
```

### Optional `query` — keep your chat context small

By default, `visit_page` returns the full rendered page as markdown. For large
pages this can dump tens of thousands of characters into your conversation.
Pass an optional **`query`** and the full page content is instead read by a
configurable **subagent model** (a separate, cheap LLM call) that returns only
the concise answer. The raw page markdown never enters your chat context —
only the subagent's answer does.

```
visit_page({
  url: "https://react.dev/reference/react/useState",
  query: "What is the exact return value shape of useState?",
})
```

- The page is fetched exactly as usual (your visible Chrome, all the
  site-specific extractors above still run); only the *return value* changes.
- The subagent **reuses your current Pi model by default** (no API keys to
  set up — Pi's already-configured auth is used). Pin a different model with
  `/browse` if you want a cheaper/faster one for summarization.
- The footer shows a `🌐 model` indicator (the current or pinned model) and an
  animated spinner while the subagent is answering.
- The collapsed tool result shows the context savings, e.g.
  `→ 92,340→1,187 chars · openai/gpt-4o-mini · 3.2s · react.dev`.

This mirrors the subagent pattern from the
[pi-vision-tool](https://github.com/xezpeleta/pi-vision-tool) extension.

### Optional `clean` — clean article Markdown via Defuddle

By default, `visit_page` on a generic (non-specialized) page uses a naive
block-walker that includes navigation, sidebars, up to 80 "visible links",
and truncates at 90 KB — noisy and token-heavy. Pass **`clean: true`** and the
page is instead extracted with [**Defuddle**](https://github.com/kepano/defuddle)
(the same library the [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper)
uses): a reader-mode-style article extractor that drops navigation, sidebars,
ads, and footers, returning only the main article content as clean Markdown.

```
visit_page({
  url: "https://react.dev/reference/react/useState",
  clean: true,
})
```

- Best for **articles, docs, and blog posts** — cleaner output and far fewer
  tokens than the default.
- **No effect on X, Reddit, Amazon, or Google Scholar URLs** — those already
  use purpose-built extractors that produce clean compact Markdown.
- If Defuddle fails or returns nothing (e.g. on a SPA with no article content),
  it automatically falls back to the generic extractor in the same page load.
- Combine with `query` for the best of both: `clean: true` gives the subagent
  clean article text to read, and `query` returns only its concise answer —
  ideal for large articles where you need just a fact or two.

The Defuddle bundle (~500 KB, MIT-licensed, with Turndown bundled in) is
vendored at `src/vendor/defuddle-browser.js` and injected into the page via a
single CDP `Runtime.evaluate` call before the extraction driver runs. See
[`src/vendor/README.md`](src/vendor/README.md) for build provenance.

```
visit_page({
  url: "https://react.dev/reference/react/useState",
  clean: true,
  query: "What is the exact return value shape of useState?",
})
```

### HTTP error detection (4xx / 5xx)

`visit_page` monitors the page's HTTP response status via the CDP `Network`
domain. When the server returns a **4xx or 5xx** status (e.g. a `404 Not Found`
on a dead or renamed link — a common occurrence with Cloudflare blog posts,
relocated docs, or hallucinated URLs), the tool returns an **`isError` result**
with a clear message instead of silently extracting the error page's content:

```
HTTP 404 Not Found — The page does not exist at this URL — the content may
have been moved, removed, or the URL may be incorrect. Try a different URL
or search for the content.
```

This tells the model the URL is dead so it can try a different one or search
again, rather than receiving "Page Not Found" gibberish as if it were page
content. The collapsed tool result shows the status code, e.g.
`→ HTTP 404 · 1.2s · blog.cloudflare.com`.

Status-specific hints:

| Status | Hint |
|---|---|
| **404** | Page doesn't exist — try a different URL or search |
| **403** | Access denied — may be bot protection, auth, or paywall |
| **429** | Rate limited — wait and retry |
| **5xx** | Server error — retry shortly or try a different URL |

## Commands

- `/browse` — Configure the `visit_page` subagent (see below).
- `/google-search-kill` — Kill the Chrome browser.

### `/browse` — subagent configuration

`visit_page`'s `query` mode uses a **subagent model** to read the page and
return only a concise answer, keeping your chat context small. The subagent
is a normal model from your Pi model registry (the same providers/models you
already use), called via its OpenAI-compatible API using **Pi's already-
configured auth** — no separate API keys to set up.

**By default the subagent reuses your current session model** (the one you're
chatting with). So `query` mode works with zero configuration. Use `/browse`
only if you want to pin a different (e.g. cheaper/faster) model:

```
/browse                          # show current config
/browse on                       # enable (default)
/browse off                      # disable (query → error until re-enabled)
/browse provider openai          # pin a provider (overrides current model)
/browse model gpt-4o-mini        # pin a model (overrides current model)
/browse max-tokens 2048          # max output tokens for the answer
/browse reasoning-effort low     # off|minimal|low|medium|high|xhigh
/browse clear                    # unpin → back to current model
```

Shorthand: `/browse provider openai` and `/browse model gpt-4o-mini` work
without the `config` prefix.

When no provider/model is pinned, the footer shows `🌐 <current-model>`;
when pinned, it shows `🌐 provider/model`. Run `/browse` with no arguments
to see the resolved configuration.

Configuration is persisted to `~/.pi/agent/pi-search-on-your-browser.json` and
also recorded in the session file, so changes survive across sessions and are
restored when you reopen one.

Environment variables (optional — override the current-model default at
startup; the config file wins over these once set):

| Variable | Default | Meaning |
|---|---|---|
| `PI_BROWSE_PROVIDER` | — | pin a subagent provider (else: current model) |
| `PI_BROWSE_MODEL` | — | pin a subagent model (else: current model) |
| `PI_BROWSE_MAX_TOKENS` | `2048` | max output tokens for the answer |
| `PI_BROWSE_REASONING_EFFORT` | `off` | thinking level for reasoning models |

## Requirements

- **Google Chrome or Chromium** installed (Firefox is not currently supported — see below)
- Node.js 20+ (tests require Node.js 22.6+ for native TypeScript stripping)

### Why Chrome only?

Firefox uses the [WebDriver BiDi protocol](https://w3c.github.io/webdriver-bidi) for remote control, not the Chrome DevTools Protocol (CDP). While both use WebSocket, Firefox's BiDi server requires a manual WebSocket handshake with specific header handling (no `Origin` header). Node.js's built-in `WebSocket` doesn't expose custom headers, and adding a full WebSocket library like `ws` would break the zero-dependency constraint of this package. Pull requests welcome if you can solve this without dependencies.

## Development

### Tests

The test suite runs without a browser, without a network, and with **zero runtime dependencies** — only Node.js's built-in test runner and native TypeScript type-stripping (Node 22.6+, unflagged in Node 24).

```bash
npm test
```

Four layers of tests (58 total):

- **`tests/unit/urls.test.ts`** — table-driven tests for the URL classifiers (`isXUrl`, `isRedditPostUrl`, `isAmazonProductUrl`, `isAmazonSearchUrl`, `isScholarSearchUrl`).
- **`tests/unit/extractors-parse.test.ts`** — validates every extractor JS string (`X_EXTRACT_JS`, `REDDIT_EXTRACT_JS`, etc.) parses as valid JavaScript via `new Function()`. Catches template-literal escaping bugs (the `\n` vs real-newline class of errors) without a browser.
- **`tests/unit/cdp-client.test.ts`** — tests `runInPageSession` (the navigate/waitForSelector/scroll/extract logic) against a fake `CDPLike` implementation. Includes the **regression test for the v0.5.1 bug**: `cdp.evaluate()` stringifies return values, so `String(false)` → `"false"` (truthy); the test asserts `waitForSelector` does *not* break on the first poll when the selector is absent. Also tests the `fallbackJs` path (Defuddle → generic extractor fallback), HTTP error detection (4xx/5xx → `__HTTP_ERROR__` marker, extraction skipped, no fallback), and the vendored Defuddle bundle (non-empty, UMD, no Node-only deps, cached).
- **`tests/unit/subagent.test.ts`** — tests the subagent layer used by `visit_page`'s `query` mode: config load/save/resolve, reasoning-level validation, reasoning-param building (mirrors the vision tool), context-window truncation with token-budget reservation, and message construction. No network calls — `callSubagentModel` is exercised indirectly via its pure helpers.

### Type-checking

```bash
npm run typecheck
```

Uses `tsc --strict` (the `typescript` and `@types/node` devDependencies). Note: `index.ts` imports pi's own types (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) which are provided by the pi runtime — it is type-checked by pi at load time. The `tsconfig.json` scopes `tsc` to `src/` and `tests/` (which only use Node built-ins).

### Why no test framework?

The project uses `node:test` + `node:assert/strict` (built into Node.js) and native TypeScript stripping — no jest, vitest, mocha, or even `tsx`. This aligns with the zero-dependency ethos: the only devDependencies are `typescript` (for `tsc`) and `@types/node` (for type definitions), neither of which is installed by consumers.

## Comparison with ds4-agent

| | pi-search-on-your-browser | ds4-agent |
|---|---|---|
| Language | TypeScript (Node.js) | C |
| Chrome connection | CDP WebSocket (manual RFC 6455) | CDP WebSocket (manual RFC 6455) |
| Profile | `~/.pi-search-browser/` | `~/.ds4/browser` |
| Google consent | Auto-click "Accept all" (multi-language) | Auto-click "Accept all" (multi-language) |
| Page extraction | Same JS extractors, ported to TS | Inline JS in C |
| Dependencies | Zero npm deps (just Node.js built-ins) | Zero deps (just POSIX) |

## Changelog

### v0.7.2

- **Fix: subagent `query` mode crashed on reasoning-enabled models with HTTP 400.** `buildReasoningParams` sent `{ reasoning_effort: "off" }` as a literal string when reasoning was disabled (the default), but many APIs (vLLM, OpenAI) reject `"off"` — they expect `"none"`/`"minimal"`/... or no param at all. Now mirrors pi's behavior: the default format omits `reasoning_effort` entirely when the level is `"off"`/`"none"` (pi only sends it when truthy); the OpenRouter format sends `effort: "none"`. This was the most impactful bug in v0.7.0 — it made `query` mode unusable with any reasoning-capable model (e.g. GLM-5.2 served via vLLM).

### v0.7.1

- **Internal refactor: split extractors into `src/extractors.ts`.** All JavaScript extractor strings (`X_EXTRACT_JS`, `REDDIT_EXTRACT_JS`, `AMAZON_PRODUCT_JS`, etc.), URL classifiers (`isXUrl`, `isRedditPostUrl`, etc.), and the Defuddle bundle/driver moved from `chrome.ts` (1214 lines) into a dedicated `extractors.ts` (608 lines). `chrome.ts` drops to 615 lines of pure CDP plumbing + public API. This isolates the high-churn site-specific code (which changes whenever a site redesigns its DOM) from the stable CDP infrastructure. Zero behavior change.
- **Deduplicated `visitPage` dispatch.** The 8 repeated `runInPage` + `resolveHttpError` blocks (one per specialized extractor + clean + generic) collapsed into a single `extractVia()` helper. `visitPage` is now a clean dispatch table — each path is one `return extractVia(...)` line instead of an 8-line block. `googleSearch` uses the same helper.

### v0.7.0

- **New: `visit_page` optional `clean` parameter.** Pass `clean: true` and generic (non-specialized) pages are extracted with [Defuddle](https://github.com/kepano/defuddle) (the same library the [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper) uses) — a reader-mode-style article extractor that drops navigation, sidebars, ads, and footers, returning only the main article content as clean Markdown. Far cleaner output and far fewer tokens than the default block-walker fallback. No effect on X/Reddit/Amazon/Scholar URLs (already clean). Falls back to the generic extractor automatically if Defuddle fails. Combine with `query` for the best of both: clean article text → subagent → concise answer.
- **New: HTTP error detection.** `visit_page` now monitors the page's HTTP response status via the CDP `Network` domain. When the server returns a 4xx/5xx status (e.g. a `404` on a dead or renamed link — common with Cloudflare blog posts, relocated docs, or hallucinated URLs), the tool returns an `isError` result with a clear, status-specific hint instead of silently extracting the error page's content. Extraction is skipped entirely on HTTP errors (no wasted work, no fallback trigger). The collapsed tool result shows the status code (e.g. `→ HTTP 404 · 1.2s · blog.cloudflare.com`).
- Vendored `src/vendor/defuddle-browser.js` (~500 KB, MIT-licensed, with Turndown bundled in) — a slim build of Defuddle without the `temml`/`mathml-to-latex` math libs (~300 KB saved). Injected into the page via a single CDP `Runtime.evaluate` call. See `src/vendor/README.md` for build provenance.
- Added `fallbackJs` option to `runInPageSession` (same-tab fallback when the primary extractor returns an error marker or empty content — no second navigation).
- **New: `visit_page` optional `query` parameter.** Pass a `query` and the full page content is read by a **subagent model** that returns only a concise answer — the raw page markdown never enters your chat context. Keeps large pages (docs, articles, product pages) from filling the conversation. Mirrors the subagent pattern from [pi-vision-tool](https://github.com/xezpeleta/pi-vision-tool). The page is still fetched with your visible Chrome (all site-specific extractors run); only the return value changes. **The subagent reuses your current Pi model by default** (via Pi's already-configured auth — no API keys to set up); pin a different model with `/browse provider`/`/browse model` if desired.
- **New: `/browse` command** to configure the subagent (`provider`, `model`, `max-tokens`, `reasoning-effort`, `on`/`off`, `clear`, `show`). Config persists to `~/.pi/agent/pi-search-on-your-browser.json` and the session file. Footer shows a `🌐 provider/model` indicator and an animated spinner during subagent calls.
- New env vars: `PI_BROWSE_PROVIDER`, `PI_BROWSE_MODEL`, `PI_BROWSE_MAX_TOKENS`, `PI_BROWSE_REASONING_EFFORT`.
- New `src/subagent.ts` module (config management, reasoning-param building, context truncation, OpenAI-compatible model call) with a structural `SubagentModel` interface so it type-checks under the `src/`-scoped `tsconfig` without importing pi packages.
- Added `tests/unit/subagent.test.ts` (17 tests) and 15 new tests in `tests/unit/cdp-client.test.ts` (fallbackJs path, HTTP error detection, Defuddle driver parse, vendored bundle integrity). Total test count: 58.
- **Subagent uses the current Pi model by default** — `query` mode works with zero configuration: no `/browse provider`/`/browse model` setup, no separate API keys (Pi's already-configured auth is reused via `ctx.modelRegistry.getApiKeyAndHeaders()`, mirroring pi-vision-tool). `/browse` is now optional and only needed to pin a cheaper/faster model. `/browse` with no args shows the resolved model (current or pinned).

### v0.6.0

- Added a test suite (`tests/unit/`) with 26 tests covering URL classifiers, extractor JS parse-validity, and CDP session logic (including a regression test for the v0.5.1 `waitForSelector` bug). Runs with `npm test` using Node's built-in test runner + native TypeScript stripping — zero runtime dependencies.
- Refactored `runInPage` to extract `runInPageSession(cdp, opts)` so the navigate/waitForSelector/scroll/extract logic is testable with a fake CDP client (no browser needed).
- Added `CDPLike` interface and exported testable internals (URL classifiers, extractor constants, `runInPageSession`).
- Added `waitForSelectorPollMs` option to `RunInPageOptions` (default 400ms).
- Fixed dangling `loadTimeout`/`consentTimeout` timers (now cleared after `Promise.race`).
- Added `tsconfig.json` (scoped to `src/` + `tests/`) and devDependencies (`typescript`, `@types/node`).

### v0.5.1

- **Critical fix**: `waitForSelector` was broken — `cdp.evaluate()` stringifies return values (`String(false)` → `"false"`, which is truthy), so the `if (found) break` check always broke on the first poll. This meant extractors ran **before** the target selector appeared in the DOM, causing flaky 0-result extractions (X ~60% failure rate). Fixed to compare `found === "true"`. Affects all extractors using `waitForSelector`: X, Reddit, Amazon (product + search), and Google Scholar.
- X extractor now detects X's "Something went wrong. Try reloading." error state (transient rate-limit) and reports it clearly, instead of the misleading "may require login" message. Also detects login walls.

### v0.5.0

- Added Google Scholar search extraction (`scholar.google.com/scholar?q=...`). Synchronous extractor (Scholar paginates 10/page, not infinite scroll) that extracts title, authors/venue/year, citation count (locale-agnostic), snippet, article link, and PDF link.

### v0.4.0

- Added Amazon product page extraction (`amazon.*/dp/ASIN`, `/gp/product/ASIN`, `/gp/aw/d/ASIN`). Async self-scrolling extractor for lazy-loaded reviews. Extracts title, price, list price, availability, brand, rating, review count, feature bullets, tech specs, ASIN, and best-effort top reviews.
- Added Amazon search results extraction (`amazon.*/s?k=...`). Async self-scrolling listing extractor, dedupes by ASIN.

### v0.3.0

- Added Reddit post + comment extraction (URLs containing `/comments/`). Async self-scrolling extractor with threaded comments (by `depth` attribute), dedupes by `thingid`, stale-break after 2 idle rounds.

### v0.2.0

- Added X (Twitter) extraction for search, profile, and individual tweet URLs. Async self-scrolling IIFE handles X's DOM virtualization, dedupes by permalink.

### v0.3.1

- Fixed Google consent auto-clicker: selector included `a` tags (consent buttons are never `<a>`) and regex patterns were unanchored (matched "Service Level Agreement" footer). Patterns now anchored with `^...$`, selector limited to `button,[role=button],input[type=submit]`.

## License

MIT
