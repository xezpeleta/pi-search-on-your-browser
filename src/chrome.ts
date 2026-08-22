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

class CDPClient {
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

// ── JavaScript extractors (ds4-agent style) ────────────────────────────────

// Backtick constant for building JS strings that contain backticks
const BT = "`";

const GOOGLE_CONSENT_JS =
  "(() => {" +
  'const clean=s=>(s||"").replace(/\\s+/g," ").trim();' +
  "const pats=[/accept all/i,/i agree/i,/agree/i,/accetta tutto/i,/tout accepter/i,/aceptar todo/i,/alle akzeptieren/i];" +
  'const els=[...document.querySelectorAll("button,[role=button],input[type=submit],a")];' +
  "for(const el of els){const t=clean(el.innerText||el.value||el.textContent);" +
  "if(!t)continue;if(pats.some(p=>p.test(t))){el.click();return'clicked '+t;}}" +
  'return"";' +
  "})()";

const GOOGLE_SEARCH_JS =
  "(() => {" +
  'const clean=s=>(s||"").replace(/\\s+/g," ").trim();' +
  'const esc=s=>clean(s).replace(/\\\\/g,"\\\\\\\\").replace(/\\[/g,"\\\\[").replace(/\\]/g,"\\\\]").replace(/\\n/g," ");' +
  'const visible=el=>{const r=el.getBoundingClientRect();const st=getComputedStyle(el);return r.width>0&&r.height>0&&st.display!=="none"&&st.visibility!=="hidden"&&st.opacity!=="0";};' +
  "const bad=h=>/(^|\\.)google\\./.test(h)||/(^|\\.)gstatic\\./.test(h)||/(^|\\.)googleusercontent\\./.test(h);" +
  'const lines=["# Google search results","","URL: "+location.href,"","## Visible links"];' +
  "const seen=new Set();" +
  'for(const a of document.querySelectorAll("a[href]")){' +
  "if(!visible(a))continue;let href=a.href||'';" +
  'try{const u=new URL(href);if(u.pathname==="/url"&&u.searchParams.get("q"))href=u.searchParams.get("q");}catch{}' +
  "let u;try{u=new URL(href)}catch{continue;}" +
  "if(!/^https?:$/.test(u.protocol))continue;" +
  "if(bad(u.hostname))continue;" +
  "const text=esc(a.innerText||a.textContent);if(text.length<3)continue;" +
  "if(seen.has(u.href))continue;seen.add(u.href);" +
  'lines.push("- ["+text.slice(0,180)+"]("+u.href+")");if(seen.size>=30)break;}' +
  'lines.push("","## Text snippet",clean(document.body.innerText).slice(0,1200));' +
  'return lines.join("\\n");' +
  "})()";

const EXTRACT_PAGE_JS =
  "(() => {" +
  'const clean=s=>(s||"").replace(/\\s+/g," ").trim();' +
  'const esc=s=>clean(s).replace(/\\\\/g,"\\\\\\\\").replace(/\\[/g,"\\\\[").replace(/\\]/g,"\\\\]").replace(/\\n/g," ");' +
  'const visible=el=>{const r=el.getBoundingClientRect();const st=getComputedStyle(el);return r.width>0&&r.height>0&&st.display!=="none"&&st.visibility!=="hidden"&&st.opacity!=="0";};' +
  "const inline=n=>{if(!n)return'';if(n.nodeType===3)return n.nodeValue;if(n.nodeType!==1)return'';const el=n;" +
  'if(el.tagName==="SCRIPT"||el.tagName==="STYLE"||el.tagName==="NOSCRIPT")return"";' +
  'if(el.tagName==="A"){const t=esc(el.innerText||el.textContent);const h=el.href||"";return t&&h?"["+t+"]("+h+")":t;}' +
  'if(el.tagName==="CODE")return"' + BT + '"+clean(el.innerText||el.textContent).replace(/`/g,"\\\\\\\\' + BT + '")+"' + BT + '";' +
  "return[...el.childNodes].map(inline).join('');};" +
  'const lines=["# "+(clean(document.title)||location.href),"","URL: "+location.href,"","## Content"];' +
  'const blocks=[...document.body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,td,th")];' +
  "const seen=new Set();" +
  "for(const el of blocks){" +
  'if(!visible(el))continue;let s="";const tag=el.tagName;' +
  'if(/^H[1-6]$/.test(tag)){s="#".repeat(Number(tag[1]))+" "+inline(el);}' +
  'else if(tag==="LI"){s="- "+inline(el);}' +
  'else if(tag==="PRE"){s="' + BT + BT + BT + '\\n"+(el.innerText||el.textContent||"").trimEnd()+"\\n' + BT + BT + BT + '";}' +
  'else if(tag==="BLOCKQUOTE"){s="> "+clean(el.innerText||el.textContent);}' +
  "else{s=inline(el);}" +
  "s=s.trim();if(!s||seen.has(s))continue;seen.add(s);" +
  'lines.push("",s);if(lines.join("\\n").length>90000){lines.push("","[Content truncated by browser extractor.]");break;}}' +
  'lines.push("","## Visible links");let n=0;const linkSeen=new Set();' +
  'for(const a of document.querySelectorAll("a[href]")){' +
  "if(!visible(a))continue;const t=esc(a.innerText||a.textContent);if(t.length<3)continue;" +
  "let u;try{u=new URL(a.href)}catch{continue;}" +
  "if(!/^https?:$/.test(u.protocol)||linkSeen.has(u.href))continue;linkSeen.add(u.href);" +
  'lines.push("- ["+t.slice(0,160)+"]("+u.href+")");if(++n>=80)break;}' +
  'return lines.join("\\n");' +
  "})()";

// ── X (Twitter) extractor ────────────────────────────────────────────────
// Search results, profiles, and individual tweets all render tweets as
// <article data-testid="tweet">. Written as a template literal for readability
// (no backticks needed inside), unlike the Google/generic extractors above.
//
// X virtualizes its timeline: only a window of tweets is mounted in the DOM at
// any time, and scrolling past evicts earlier ones. So this extractor is async
// and self-scrolling — it collects the currently-mounted tweets, scrolls to
// load more, and repeats, deduping by permalink. Tweets that get unmounted as
// we scroll past them are already captured in `seen`.
const X_EXTRACT_JS = `(async () => {
  const clean = s => (s||"").replace(/\\s+/g, " ").trim();
  const parseEng = s => {
    if (!s) return "";
    // aria-label looks like "48 Replies. Reply" / "1.2K Likes. Like" -> "48 replies"
    const idx = s.lastIndexOf(". ");
    const stats = (idx >= 0 ? s.slice(0, idx) : s).trim().toLowerCase();
    return /\\d/.test(stats) ? stats : "";
  };
  const titleFor = () => {
    try {
      const u = new URL(location.href);
      const p = u.pathname;
      if (p === "/search") return "X search: " + (u.searchParams.get("q") || "(no query)");
      const m = p.match(/^\\/([^/]+)\\/status\\/\\d+/);
      if (m) return "Tweet by @" + m[1];
      if (/^\\/[^/]+$/.test(p)) return "X profile: @" + p.slice(1);
    } catch {}
    return clean(document.title) || "X (Twitter)";
  };
  const collectTweet = art => {
    const text = clean(art.querySelector('[data-testid="tweetText"]')?.innerText || "");
    const userEl = art.querySelector('[data-testid="User-Name"]');
    let handle = "", name = "";
    if (userEl) {
      const links = [...userEl.querySelectorAll('a[href]')];
      const handleLink = links.find(a => /^\\/[^/]+$/.test(a.getAttribute("href")));
      if (handleLink) handle = handleLink.getAttribute("href").slice(1);
      name = clean(links[0]?.innerText || "");
    }
    const time = art.querySelector("time");
    let permalink = "";
    for (const a of art.querySelectorAll('a[href]')) {
      if (/\\/status\\/\\d+/.test(a.getAttribute("href"))) { permalink = a.getAttribute("href"); break; }
    }
    const reply = parseEng(art.querySelector('[data-testid="reply"]')?.getAttribute("aria-label") || "");
    const retweet = parseEng(art.querySelector('[data-testid="retweet"]')?.getAttribute("aria-label") || "");
    const like = parseEng(art.querySelector('[data-testid="like"]')?.getAttribute("aria-label") || "");
    return { handle, name, time: time?.getAttribute("datetime") || "", permalink, text, reply, retweet, like };
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const seen = new Map();
  let stale = 0;
  for (let i = 0; i < 12; i++) {
    let added = 0;
    for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
      const t = collectTweet(art);
      const key = t.permalink || (t.handle + "|" + t.text.slice(0, 40));
      if (!seen.has(key)) { seen.set(key, t); added++; }
    }
    if (seen.size >= 40) break;
    if (added === 0) { stale++; if (stale >= 2) break; } else { stale = 0; }
    window.scrollBy(0, Math.round(window.innerHeight * 1.5));
    await sleep(700);
  }
  window.scrollTo(0, 0);
  const tweets = [...seen.values()];
  const lines = ["# " + titleFor(), "", "URL: " + location.href, "", "## Tweets (" + tweets.length + ")", ""];
  if (tweets.length === 0) {
    lines.push("_No tweets found. The page may require login, or the search yielded no results._");
    return lines.join("\\n");
  }
  for (const t of tweets) {
    const link = t.permalink ? "https://x.com" + t.permalink : "";
    lines.push("### @" + t.handle + (t.name ? " — " + t.name : ""));
    const meta = [];
    if (t.time) meta.push(t.time);
    if (link) meta.push(link);
    if (meta.length) lines.push(meta.join(" · "));
    lines.push("");
    lines.push(t.text || "(no text)");
    lines.push("");
    const eng = [];
    if (t.reply) eng.push(t.reply);
    if (t.retweet) eng.push(t.retweet);
    if (t.like) eng.push(t.like);
    if (eng.length) lines.push("_" + eng.join(" · ") + "_");
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return lines.join("\\n");
})()`;

function isXUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "x.com" || host.endsWith(".x.com") ||
      host === "twitter.com" || host.endsWith(".twitter.com");
  } catch {
    return false;
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
  onStatus: (msg: string) => void;
}

async function runInPage(opts: RunInPageOptions): Promise<string> {
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
    onStatus,
  } = opts;
  await ensureChrome();

  const tab = await openTab();

  const cdp = new CDPClient();
  await cdp.connect(tab.wsUrl);

  onStatus(`Navigating to ${new URL(url).hostname}...`);

  try {
    await cdp.call("Page.enable");
    await cdp.call("Runtime.enable");

    const loaded = new Promise<void>((resolve) => {
      cdp.onEvent("Page.loadEventFired", () => resolve());
    });
    const loadTimeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000));

    await cdp.call("Page.navigate", { url });
    await Promise.race([loaded, loadTimeout]);

    if (clickConsent) {
      const clicked = await cdp.evaluate(GOOGLE_CONSENT_JS);
      if (clicked) {
        onStatus(`Consent: ${clicked}`);
        const consentLoaded = new Promise<void>((resolve) => {
          cdp.onEvent("Page.loadEventFired", () => resolve());
        });
        const consentTimeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
        await Promise.race([consentLoaded, consentTimeout]);
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
        const found = await cdp.evaluate(
          `document.querySelector(${JSON.stringify(waitForSelector)}) !== null`
        );
        if (found) break;
        await sleep(400);
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
    const result = await cdp.evaluate(js);

    // Truncate
    if (result.length > MAX_RESULT_BYTES) {
      return result.slice(0, MAX_RESULT_BYTES) + "\n\n[Content truncated at 1MB]";
    }
    return result;
  } finally {
    cdp.disconnect();
    await closeTab(tab.targetId);
  }
}

// ── Public API ────────────────────────────────────────────────────────────

export interface SearchResult {
  markdown: string;
  url: string;
}

export async function googleSearch(
  query: string,
  onStatus?: (msg: string) => void
): Promise<SearchResult> {
  const status = onStatus ?? (() => {});
  status(`Searching Google for: ${query}`);

  const encodedQuery = encodeURIComponent(query);
  const url = `https://www.google.com/search?q=${encodedQuery}`;

  const markdown = await runInPage({
    url,
    js: GOOGLE_SEARCH_JS,
    clickConsent: true,
    dynamicScroll: false,
    onStatus: status,
  });
  return { markdown, url };
}

export async function visitPage(
  url: string,
  onStatus?: (msg: string) => void
): Promise<SearchResult> {
  const status = onStatus ?? (() => {});
  status(`Visiting: ${url}`);

  if (isXUrl(url)) {
    status("Detected X (Twitter) — using tweet extractor...");
    const markdown = await runInPage({
      url,
      js: X_EXTRACT_JS,
      clickConsent: false,
      dynamicScroll: false,
      initialWaitMs: 500,
      waitForSelector: 'article[data-testid="tweet"]',
      waitForTimeoutMs: 10_000,
      onStatus: status,
    });
    return { markdown, url };
  }

  const markdown = await runInPage({
    url,
    js: EXTRACT_PAGE_JS,
    clickConsent: true,
    dynamicScroll: true,
    onStatus: status,
  });
  return { markdown, url };
}

export function shutdownChrome() {
  if (chromeProcess) {
    chromeProcess.kill();
    chromeProcess = null;
  }
}
