/**
 * Chrome DevTools Protocol (CDP) client — Node.js built-in WebSocket.
 *
 * Same approach as ds4-agent (@antirez): visible Chrome (not headless),
 * CDP WebSocket navigation, inline JavaScript extractors in the page.
 *
 * Reference: https://x.com/antirez/status/2066233392916525379
 *
 * Profile at ~/.pi-search-browser/ — dedicated, like ds4-agent's ~/.ds4/browser.
 * Cookies and sessions persist across calls.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  GOOGLE_CONSENT_JS,
  GOOGLE_SEARCH_JS,
  EXTRACT_PAGE_JS,
  X_EXTRACT_JS,
  REDDIT_EXTRACT_JS,
  AMAZON_PRODUCT_JS,
  AMAZON_SEARCH_JS,
  SCHOLAR_EXTRACT_JS,
  DEFUDDLE_DRIVER_JS,
  getDefuddleBundle,
  isXUrl,
  isRedditPostUrl,
  isAmazonProductUrl,
  isAmazonSearchUrl,
  isScholarSearchUrl,
} from "./extractors.ts";

const PROFILE_DIR = join(homedir(), ".pi-search-browser");
const CDP_PORT = 9322;
const CDP_TIMEOUT_MS = 30_000;
const MAX_RESULT_BYTES = 1_048_576; // 1 MB

// ── Utilities ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function findChrome(): string {
  const paths = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const p of paths) {
    if (p && existsSync(p)) return p;
  }
  return "google-chrome";
}

// ── CDP over WebSocket ────────────────────────────────────────────────────

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** Minimal CDP interface used by runInPageSession. CDPClient implements this;
 *  tests pass a fake so the navigate/waitForSelector/extract logic can be
 *  exercised without a real browser or WebSocket. */
interface CDPLike {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  evaluate(expression: string): Promise<string>;
  onEvent(method: string, handler: (params: unknown) => void): void;
  disconnect(): void;
}

class CDPClient implements CDPLike {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private connectPromise: Promise<void> | null = null;
  private eventHandlers = new Map<string, Array<(params: unknown) => void>>();

  async connect(wsUrl: string): Promise<void> {
    this.connectPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`WebSocket connect timeout`));
      }, CDP_TIMEOUT_MS);

      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };

      ws.onmessage = (event) => {
        let msg: { id?: number; method?: string; result?: unknown; error?: { message: string }; params?: unknown };
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }
        // Events (no id field) — dispatch to handlers
        if (msg.id === undefined || msg.id === null) {
          if (msg.method) {
            const handlers = this.eventHandlers.get(msg.method);
            if (handlers) {
              for (const h of handlers) h(msg.params);
            }
          }
          return;
        }
        const cb = this.pending.get(msg.id);
        if (!cb) return;
        this.pending.delete(msg.id);
        if (msg.error) {
          cb.reject(new Error(`CDP error: ${msg.error.message || JSON.stringify(msg.error)}`));
        } else {
          cb.resolve(msg.result);
        }
      };

      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("WebSocket connection error"));
      };
    });
    await this.connectPromise;
  }

  onEvent(method: string, handler: (params: unknown) => void) {
    const handlers = this.eventHandlers.get(method) || [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP not connected");
    }
    const id = this.nextId++;
    const msg = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP call timeout: ${method}`));
      }, CDP_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws!.send(msg);
    });
  }

  async evaluate(expression: string): Promise<string> {
    const result = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const r = result as { result?: { value?: unknown; description?: string } };
    if (r.result?.value !== undefined) return String(r.result.value);
    return r.result?.description ?? "";
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ── Chrome process management ─────────────────────────────────────────────

let chromeProcess: ChildProcess | null = null;

async function isChromeAlive(): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    return resp.ok;
  } catch {
    return false;
  }
}

async function launchChrome(): Promise<void> {
  mkdirSync(PROFILE_DIR, { recursive: true });

  const chromePath = findChrome();

  console.error(`[pi-search] Launching visible Chrome at ${chromePath}`);

  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--password-store=basic",
    "--mute-audio",
    "about:blank",
  ];

  chromeProcess = spawn(chromePath, args, {
    stdio: ["ignore", "ignore", "ignore"],
    detached: false,
  });

  chromeProcess.on("exit", (code) => {
    console.error(`[pi-search] Chrome exited with code ${code}`);
    chromeProcess = null;
  });

  // Wait for CDP to become available
  for (let i = 0; i < 60; i++) {
    if (await isChromeAlive()) {
      console.error("[pi-search] Chrome is ready");
      return;
    }
    await sleep(500);
  }
  throw new Error("Chrome did not become ready within 30s");
}

async function ensureChrome(): Promise<void> {
  if (await isChromeAlive()) return;
  if (chromeProcess) {
    chromeProcess.kill();
    chromeProcess = null;
    await sleep(500);
  }
  await launchChrome();
}

// ── Page operations ──────────────────────────────────────────────────────

interface CDPTab {
  wsUrl: string;
  targetId: string;
}

async function getBrowserWSUrl(): Promise<string> {
  const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const data = (await resp.json()) as { webSocketDebuggerUrl: string };
  return data.webSocketDebuggerUrl;
}

async function openTab(): Promise<CDPTab> {
  const browserUrl = await getBrowserWSUrl();
  const browserCdp = new CDPClient();
  await browserCdp.connect(browserUrl);

  const result = (await browserCdp.call("Target.createTarget", {
    url: "about:blank",
    background: true,
    newWindow: false,
  })) as { targetId: string };

  browserCdp.disconnect();

  const wsUrl = `ws://127.0.0.1:${CDP_PORT}/devtools/page/${result.targetId}`;
  return { wsUrl, targetId: result.targetId };
}

async function closeTab(targetId: string): Promise<void> {
  try {
    await fetch(
      `http://127.0.0.1:${CDP_PORT}/json/close/${encodeURIComponent(targetId)}`
    );
  } catch {
    // best effort
  }
}

interface RunInPageOptions {
  url: string;
  js: string;
  clickConsent?: boolean;
  dynamicScroll?: boolean;
  scrollCount?: number;
  scrollDelayMs?: number;
  initialWaitMs?: number;
  waitForSelector?: string;
  waitForTimeoutMs?: number;
  /** Poll interval for waitForSelector (ms). Default 400. */
  waitForSelectorPollMs?: number;
  /** Optional fallback JS to run in the SAME tab if the primary `js` returns
   *  an error marker or very short content. Avoids a second navigation when
   *  the primary extractor (e.g. Defuddle) fails on a page. */
  fallbackJs?: string;
  onStatus: (msg: string) => void;
}

/** Session logic: navigate, wait, scroll, extract — all against a connected
 *  CDP client. Split out from runInPage so it can be tested with a fake
 *  CDPLike (no real Chrome, no WebSocket). */
async function runInPageSession(cdp: CDPLike, opts: RunInPageOptions): Promise<string> {
  const {
    url,
    js,
    clickConsent = false,
    dynamicScroll = false,
    scrollCount = 3,
    scrollDelayMs = 300,
    initialWaitMs = 0,
    waitForSelector,
    waitForTimeoutMs = 8000,
    waitForSelectorPollMs = 400,
    onStatus,
  } = opts;

  onStatus(`Navigating to ${new URL(url).hostname}...`);

  await cdp.call("Page.enable");
  await cdp.call("Runtime.enable");

  // Capture the main document's HTTP response status so we can surface 4xx/5xx
  // errors (e.g. a 404 on a dead Cloudflare blog link) instead of silently
  // extracting the error page's content. We listen for the FIRST Document-type
  // response, which is the navigation itself (after any redirects).
  //
  // A const container (rather than a let variable) is used because TypeScript's
  // control-flow analysis can't prove the onEvent closure actually ran, so a
  // `let x = null` would stay narrowed to `null` at the check below. Mutating
  // properties on a const object is tracked correctly through closures.
  const docResponse = { status: 0, statusText: "" };
  let gotDocResponse = false;
  cdp.onEvent("Network.responseReceived", (params) => {
    const p = params as {
      type?: string;
      response?: { url?: string; status?: number; statusText?: string };
    };
    if (p.type === "Document" && p.response && !gotDocResponse) {
      docResponse.status = p.response.status ?? 0;
      docResponse.statusText = p.response.statusText ?? "";
      gotDocResponse = true;
    }
  });
  await cdp.call("Network.enable");

  const loaded = new Promise<void>((resolve) => {
    cdp.onEvent("Page.loadEventFired", () => resolve());
  });
  let loadTimer!: ReturnType<typeof setTimeout>;
  const loadTimeout = new Promise<void>((resolve) => { loadTimer = setTimeout(resolve, 10_000); });

  await cdp.call("Page.navigate", { url });
  await Promise.race([loaded, loadTimeout]);
  clearTimeout(loadTimer);

  // If the server returned an HTTP error (4xx/5xx), don't bother running the
  // extractor on the error page — return a clear marker so visitPage can
  // surface it to the LLM as an error result. This prevents the model from
  // receiving "Page Not Found" gibberish as if it were page content.
  if (gotDocResponse && docResponse.status >= 400) {
    onStatus(`HTTP ${docResponse.status} ${docResponse.statusText}`.trim());
    return `__HTTP_ERROR__: ${docResponse.status} ${docResponse.statusText}`.trim();
  }

  if (clickConsent) {
    const clicked = await cdp.evaluate(GOOGLE_CONSENT_JS);
    if (clicked) {
      onStatus(`Consent: ${clicked}`);
      const consentLoaded = new Promise<void>((resolve) => {
        cdp.onEvent("Page.loadEventFired", () => resolve());
      });
      let consentTimer!: ReturnType<typeof setTimeout>;
      const consentTimeout = new Promise<void>((resolve) => { consentTimer = setTimeout(resolve, 5_000); });
      await Promise.race([consentLoaded, consentTimeout]);
      clearTimeout(consentTimer);
    }
  }

  if (initialWaitMs > 0) {
    onStatus("Waiting for page to render...");
    await sleep(initialWaitMs);
  }

  if (waitForSelector) {
    onStatus(`Waiting for ${waitForSelector}...`);
    const deadline = Date.now() + waitForTimeoutMs;
    while (Date.now() < deadline) {
      // cdp.evaluate stringifies the return value (String(value)), so the
      // boolean false becomes "false" (a truthy string). Compare explicitly
      // to "true" instead of relying on truthiness.
      const found = await cdp.evaluate(
        `document.querySelector(${JSON.stringify(waitForSelector)}) !== null`
      );
      if (found === "true") break;
      await sleep(waitForSelectorPollMs);
    }
  }

  if (dynamicScroll) {
    onStatus("Scrolling for dynamic content...");
    for (let i = 0; i < scrollCount; i++) {
      await cdp.evaluate("window.scrollTo(0, document.body.scrollHeight)");
      await sleep(scrollDelayMs);
    }
    await cdp.evaluate("window.scrollTo(0, 0)");
    await sleep(200);
  }

  onStatus("Extracting content...");
  let result = await cdp.evaluate(js);

  // Fallback: if the primary extractor returned an error marker or nothing
  // useful, run the fallback JS in the same tab (no re-navigation).
  if (opts.fallbackJs && (result.startsWith("__DEFUDDLE_ERROR__") || result.trim().length < 50)) {
    onStatus("Clean extraction yielded no content — falling back to generic extractor...");
    result = await cdp.evaluate(opts.fallbackJs);
  }

  // Truncate
  if (result.length > MAX_RESULT_BYTES) {
    return result.slice(0, MAX_RESULT_BYTES) + "\n\n[Content truncated at 1MB]";
  }
  return result;
}

async function runInPage(opts: RunInPageOptions): Promise<string> {
  await ensureChrome();

  const tab = await openTab();

  const cdp = new CDPClient();
  await cdp.connect(tab.wsUrl);

  try {
    return await runInPageSession(cdp, opts);
  } finally {
    cdp.disconnect();
    await closeTab(tab.targetId);
  }
}

// ── Public API ────────────────────────────────────────────────────────────

export interface SearchResult {
  markdown: string;
  url: string;
  /** HTTP status of the main document response, when captured. Set (with an
   *  empty `markdown`) when the server returned a 4xx/5xx error, so the tool
   *  layer can surface it as an error instead of extracting the error page. */
  httpStatus?: number;
  httpStatusText?: string;
}

export interface VisitPageOptions {
  onStatus?: (msg: string) => void;
  /** When true, generic (non-specialized) pages are extracted with Defuddle —
   *  a reader-mode-style article extractor that drops navigation, sidebars,
   *  ads, and footers, returning clean Markdown. Far better than the default
   *  block-walker for articles, docs, and blog posts. If Defuddle fails or
   *  returns nothing, falls back to the generic extractor automatically.
   *
   *  Specialized pages (X, Reddit, Amazon, Scholar) always use their
   *  purpose-built extractors, which already produce clean compact Markdown —
   *  `clean` has no additional effect on them. */
  clean?: boolean;
}

/** Run an extractor in a fresh tab, then resolve HTTP errors. Wraps the
 *  common pattern shared by every visitPage path and googleSearch: navigate,
 *  (optionally) wait for a selector, extract, resolve. Defaults match the
 *  specialized extractors (no consent click, no dynamic scroll, 500ms render
 *  wait, 10s selector timeout) — callers override only what differs. */
async function extractVia(
  url: string,
  status: (msg: string) => void,
  msg: string,
  js: string,
  opts: {
    waitForSelector?: string;
    waitForTimeoutMs?: number;
    clickConsent?: boolean;
    dynamicScroll?: boolean;
    initialWaitMs?: number;
    fallbackJs?: string;
  } = {},
): Promise<SearchResult> {
  if (msg) status(msg);
  const markdown = await runInPage({
    url,
    js,
    clickConsent: opts.clickConsent ?? false,
    dynamicScroll: opts.dynamicScroll ?? false,
    initialWaitMs: opts.initialWaitMs ?? 500,
    waitForSelector: opts.waitForSelector,
    waitForTimeoutMs: opts.waitForTimeoutMs ?? 10_000,
    fallbackJs: opts.fallbackJs,
    onStatus: status,
  });
  return resolveHttpError(markdown, url);
}

export async function googleSearch(
  query: string,
  onStatus?: (msg: string) => void
): Promise<SearchResult> {
  const status = onStatus ?? (() => {});
  const encodedQuery = encodeURIComponent(query);
  const url = `https://www.google.com/search?q=${encodedQuery}`;
  return extractVia(url, status, `Searching Google for: ${query}`,
    GOOGLE_SEARCH_JS, { clickConsent: true, initialWaitMs: 0 });
}

// If the extraction returned an HTTP-error marker (set by runInPageSession
// when the server responded 4xx/5xx), convert it to a SearchResult that
// carries the status — so the tool layer can surface it as an error instead
// of returning the error-page content as if it were the page itself.
function resolveHttpError(markdown: string, url: string): SearchResult {
  const httpErr = markdown.match(/^__HTTP_ERROR__: (\d{3})\s*(.*)$/);
  if (httpErr) {
    return {
      markdown: "",
      url,
      httpStatus: Number(httpErr[1]),
      httpStatusText: httpErr[2].trim(),
    };
  }
  return { markdown, url };
}

export async function visitPage(
  url: string,
  options?: VisitPageOptions
): Promise<SearchResult> {
  const status = options?.onStatus ?? (() => {});
  const clean = options?.clean ?? false;
  status(`Visiting: ${url}`);

  if (isXUrl(url)) {
    return extractVia(url, status, "Detected X (Twitter) \u2014 using tweet extractor...",
      X_EXTRACT_JS, { waitForSelector: 'article[data-testid="tweet"]' });
  }

  if (isRedditPostUrl(url)) {
    return extractVia(url, status, "Detected Reddit post \u2014 using comment extractor...",
      REDDIT_EXTRACT_JS, { waitForSelector: "shreddit-comment, shreddit-post" });
  }

  if (isAmazonProductUrl(url)) {
    return extractVia(url, status, "Detected Amazon product page \u2014 using product extractor...",
      AMAZON_PRODUCT_JS, { waitForSelector: "#productTitle, #titleSection" });
  }

  if (isAmazonSearchUrl(url)) {
    return extractVia(url, status, "Detected Amazon search \u2014 using listing extractor...",
      AMAZON_SEARCH_JS, { waitForSelector: '[data-component-type="s-search-result"]' });
  }

  if (isScholarSearchUrl(url)) {
    return extractVia(url, status, "Detected Google Scholar \u2014 using academic extractor...",
      SCHOLAR_EXTRACT_JS, { waitForSelector: ".gs_r, .gs_ri" });
  }

  // Generic page. When `clean` is requested, use Defuddle (reader-mode article
  // extraction) for far cleaner Markdown than the block-walker fallback. If
  // Defuddle fails or returns nothing, the fallbackJs runs in the same tab.
  if (clean) {
    return extractVia(url, status, "Using Defuddle for clean article extraction...",
      getDefuddleBundle() + "\n;" + DEFUDDLE_DRIVER_JS,
      { clickConsent: true, fallbackJs: EXTRACT_PAGE_JS });
  }

  return extractVia(url, status, "", EXTRACT_PAGE_JS,
    { clickConsent: true, dynamicScroll: true, initialWaitMs: 0 });
}

export function shutdownChrome() {
  if (chromeProcess) {
    chromeProcess.kill();
    chromeProcess = null;
  }
}

// Exported for testing — internal API, not part of the extension's tool surface
// (index.ts only re-exports googleSearch, visitPage, shutdownChrome).
// Extractor JS strings + URL classifiers are re-exported from ./extractors.ts
// so existing test imports from chrome.ts keep working.
export {
  type CDPLike,
  type RunInPageOptions,
  runInPageSession,
};
export {
  isXUrl,
  isRedditPostUrl,
  isAmazonProductUrl,
  isAmazonSearchUrl,
  isScholarSearchUrl,
  GOOGLE_CONSENT_JS,
  GOOGLE_SEARCH_JS,
  EXTRACT_PAGE_JS,
  X_EXTRACT_JS,
  REDDIT_EXTRACT_JS,
  AMAZON_PRODUCT_JS,
  AMAZON_SEARCH_JS,
  SCHOLAR_EXTRACT_JS,
  DEFUDDLE_DRIVER_JS,
  getDefuddleBundle,
} from "./extractors.ts";
