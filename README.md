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

## Commands

- `/google-search-kill` — Kill the Chrome browser

## Requirements

- **Google Chrome or Chromium** installed (Firefox is not currently supported — see below)
- Node.js 20+

### Why Chrome only?

Firefox uses the [WebDriver BiDi protocol](https://w3c.github.io/webdriver-bidi) for remote control, not the Chrome DevTools Protocol (CDP). While both use WebSocket, Firefox's BiDi server requires a manual WebSocket handshake with specific header handling (no `Origin` header). Node.js's built-in `WebSocket` doesn't expose custom headers, and adding a full WebSocket library like `ws` would break the zero-dependency constraint of this package. Pull requests welcome if you can solve this without dependencies.

## Comparison with ds4-agent

| | pi-search-on-your-browser | ds4-agent |
|---|---|---|
| Language | TypeScript (Node.js) | C |
| Chrome connection | CDP WebSocket (manual RFC 6455) | CDP WebSocket (manual RFC 6455) |
| Profile | `~/.pi-search-browser/` | `~/.ds4/browser` |
| Google consent | Auto-click "Accept all" (multi-language) | Auto-click "Accept all" (multi-language) |
| Page extraction | Same JS extractors, ported to TS | Inline JS in C |
| Dependencies | Zero npm deps (just Node.js built-ins) | Zero deps (just POSIX) |

## License

MIT
