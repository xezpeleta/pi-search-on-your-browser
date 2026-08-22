# pi-search-on-your-browser

Search Google in your **own visible Chrome browser** — the [ds4-agent](https://github.com/antirez/ds4) style by @antirez.

> "If you need AI to do a search for you in the real world, ds4-agent is basically SOTA, because it can access the web sites without any limitations given that it uses your local Chrome browser (no, not in headless mode, that's the trick...)"
> — [@antirez on X](https://x.com/antirez/status/2066233392916525379), 2026-06-14

**This Pi package uses exactly the same approach:** launches your visible Chrome (not headless), navigates to google.com via CDP, runs JavaScript extractors in the page, and returns compact Markdown results. No API keys. No headless detection. Your real browser fingerprint, cookies, and login sessions.

## How it works

When you call `google_search` or `visit_page`:

1. A **visible Chrome window** opens (not headless) with a dedicated profile at `~/.pi-search-browser/`
2. Chrome DevTools Protocol (CDP) is used to navigate and extract content
3. JavaScript runs in the page to extract readable markdown
4. Chrome stays alive between calls for speed (kill with `/google-search-kill`)

This means you're authenticated everywhere — paywalled sites, Twitter, GitHub, Google — because it's **your real browser**.

## Install

```bash
pi install npm:pi-search-on-your-browser
```

Or from git:

```bash
pi install git:github.com/xezpeleta/pi-search-on-your-browser@v0.1.0
```

## Tools

### `google_search`

Search Google and get compact markdown links + text snippet.

```
google_search({ query: "TypeScript 5.7 release notes" })
```

### `visit_page`

Visit any URL and get the page content as markdown.

```
visit_page({ url: "https://example.com/article" })
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

## Commands

- `/google-search-kill` — Kill the Chrome browser

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

Three layers of tests:

- **`tests/unit/urls.test.ts`** — table-driven tests for the URL classifiers (`isXUrl`, `isRedditPostUrl`, `isAmazonProductUrl`, `isAmazonSearchUrl`, `isScholarSearchUrl`).
- **`tests/unit/extractors-parse.test.ts`** — validates every extractor JS string (`X_EXTRACT_JS`, `REDDIT_EXTRACT_JS`, etc.) parses as valid JavaScript via `new Function()`. Catches template-literal escaping bugs (the `\n` vs real-newline class of errors) without a browser.
- **`tests/unit/cdp-client.test.ts`** — tests `runInPageSession` (the navigate/waitForSelector/scroll/extract logic) against a fake `CDPLike` implementation. Includes the **regression test for the v0.5.1 bug**: `cdp.evaluate()` stringifies return values, so `String(false)` → `"false"` (truthy); the test asserts `waitForSelector` does *not* break on the first poll when the selector is absent.

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
