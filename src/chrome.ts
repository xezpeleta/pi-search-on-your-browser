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
  'else if(tag==="PRE"){s="' + BT + BT + BT + '\\\\n"+(el.innerText||el.textContent||"").trimEnd()+"\\\\n' + BT + BT + BT + '";}' +
  'else if(tag==="BLOCKQUOTE"){s="> "+clean(el.innerText||el.textContent);}' +
  "else{s=inline(el);}" +
  "s=s.trim();if(!s||seen.has(s))continue;seen.add(s);" +
  'lines.push("",s);if(lines.join("\\\\n").length>90000){lines.push("","[Content truncated by browser extractor.]");break;}}' +
  'lines.push("","## Visible links");let n=0;const linkSeen=new Set();' +
  'for(const a of document.querySelectorAll("a[href]")){' +
  "if(!visible(a))continue;const t=esc(a.innerText||a.textContent);if(t.length<3)continue;" +
  "let u;try{u=new URL(a.href)}catch{continue;}" +
  "if(!/^https?:$/.test(u.protocol)||linkSeen.has(u.href))continue;linkSeen.add(u.href);" +
  'lines.push("- ["+t.slice(0,160)+"]("+u.href+")");if(++n>=80)break;}' +
  'return lines.join("\\\\n");' +
  "})()";

async function runInPage(
  url: string,
  js: string,
  clickConsent: boolean,
  dynamicScroll: boolean,
  onStatus: (msg: string) => void
): Promise<string> {
  await ensureChrome();

  const tab = await openTab();

  const cdp = new CDPClient();
  await cdp.connect(tab.wsUrl);

  try {
    // Enable domains
    await cdp.call("Page.enable");
    await cdp.call("Runtime.enable");

    // Navigate and wait for load event (event-driven, no polling)
    const loaded = new Promise<void>((resolve) => {
      cdp.onEvent("Page.loadEventFired", () => resolve());
    });
    const loadTimeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000));

    onStatus(`Navigating to ${url}`);
    await cdp.call("Page.navigate", { url });

    // Wait for load event or timeout
    await Promise.race([loaded, loadTimeout]);

    // Handle consent
    if (clickConsent) {
      const clicked = await cdp.evaluate(GOOGLE_CONSENT_JS);
      if (clicked) {
        onStatus(`Consent: ${clicked}`);
        // Brief wait after consent click, with a shorter page-ready check
        const consentLoaded = new Promise<void>((resolve) => {
          cdp.onEvent("Page.loadEventFired", () => resolve());
        });
        const consentTimeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
        await Promise.race([consentLoaded, consentTimeout]);
      }
    }

    // Scroll for dynamic pages
    if (dynamicScroll) {
      onStatus("Scrolling for dynamic content...");
      for (let i = 0; i < 3; i++) {
        await cdp.evaluate("window.scrollTo(0, document.body.scrollHeight)");
        await sleep(300);
      }
      await cdp.evaluate("window.scrollTo(0, 0)");
      await sleep(200);
    }

    // Extract
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

  const markdown = await runInPage(url, GOOGLE_SEARCH_JS, true, false, status);
  return { markdown, url };
}

export async function visitPage(
  url: string,
  onStatus?: (msg: string) => void
): Promise<SearchResult> {
  const status = onStatus ?? (() => {});
  status(`Visiting: ${url}`);

  const markdown = await runInPage(url, EXTRACT_PAGE_JS, true, true, status);
  return { markdown, url };
}

export function shutdownChrome() {
  if (chromeProcess) {
    chromeProcess.kill();
    chromeProcess = null;
  }
}
