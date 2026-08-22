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

// NOTE: deliberately does NOT match <a> tags. Clicking an anchor navigates
// away from the target page. Cookie-consent "accept" buttons are always
// <button>/<input>/[role=button], never <a>. Patterns are anchored (^...$)
// so e.g. /^agree$/i does not match "Service Level Agreement" in a footer.
const GOOGLE_CONSENT_JS =
  "(() => {" +
  'const clean=s=>(s||"").replace(/\\s+/g," ").trim();' +
  "const pats=[/^accept all$/i,/^accept$/i,/^i agree$/i,/^agree$/i,/^allow all$/i,/^got it$/i,/^accetta tutto$/i,/^tout accepter$/i,/^aceptar todo$/i,/^alle akzeptieren$/i];" +
  'const els=[...document.querySelectorAll("button,[role=button],input[type=submit]")];' +
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
    const bodyText = (document.body.innerText || "").slice(0, 2000);
    if (/something went wrong|try reloading|algo sali/i.test(bodyText)) {
      lines.push("_X returned an error (\\"Something went wrong. Try reloading.\\"). This is usually a transient rate-limit — wait a minute and retry, or open the URL in the visible Chrome window and reload._");
    } else if (/log in|iniciar sesi|connexion/i.test(bodyText)) {
      lines.push("_No tweets found — the page is showing a login wall. Log in to X in the visible Chrome window (profile at ~/.pi-search-browser/) and retry._");
    } else {
      lines.push("_No tweets found. The search may have yielded no results, or the page failed to render._");
    }
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

// ── Reddit extractor ─────────────────────────────────────────────────────
// Post + comment pages render the post as <shreddit-post> and each comment as
// <shreddit-comment>, which carries author/depth/score/created as attributes.
// The generic extractor misses these (no <p>/<li> structure) and flattens
// comments into an unattributed wall of text. Reddit lazy-loads comments on
// scroll, so this is async + self-scrolling and dedupes by `thingid`, like the
// X extractor. Only post/comment pages (path has /comments/) are routed here;
// subreddit listings and user pages use the generic extractor.
const REDDIT_EXTRACT_JS = `(async () => {
  const clean = s => (s||"").replace(/\\s+/g, " ").trim();
  const cleanMulti = s => (s||"").replace(/[ \\t]+/g, " ").replace(/\\n{3,}/g, "\\n\\n").trim();
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── Post ──
  const post = document.querySelector('shreddit-post, [data-testid="post-container"]');
  const titleEl = post ? post.querySelector('[slot="title"], h1, [data-testid="post-title"]') : null;
  const title = clean(titleEl ? titleEl.innerText : document.title);
  const author = (post && post.getAttribute('author')) || "";
  let subreddit = "";
  const sm = location.pathname.match(/^\\/r\\/([^/]+)/);
  if (sm) subreddit = sm[1];
  const postScore = (post && post.getAttribute('score')) || "";
  const postBodyEl = post ? post.querySelector('[slot="text-body"], .md, [data-testid="post-text"]') : null;
  const postBody = cleanMulti(postBodyEl ? postBodyEl.innerText : "");

  // ── Comments (incremental scroll, dedup by thingid) ──
  const seen = new Map();
  let stale = 0;
  for (let i = 0; i < 10; i++) {
    let added = 0;
    for (const c of document.querySelectorAll('shreddit-comment, [id^="comment-tree-comment-node"]')) {
      const id = c.getAttribute('thingid') || c.id;
      if (!id || seen.has(id)) continue;
      const cAuthor = c.getAttribute('author') || "";
      const depth = parseInt(c.getAttribute('depth') || '0', 10);
      const cScore = c.getAttribute('score') || "";
      const created = c.getAttribute('created') || (c.querySelector('time') ? c.querySelector('time').getAttribute('datetime') : "");
      const isOp = c.hasAttribute('is-op');
      const bodyEl = c.querySelector('[slot="comment"], .md');
      const cBody = cleanMulti(bodyEl ? bodyEl.innerText : "");
      seen.set(id, { author: cAuthor, depth, score: cScore, created, isOp, body: cBody });
      added++;
    }
    if (seen.size >= 80) break;
    if (added === 0) { stale++; if (stale >= 2) break; } else { stale = 0; }
    window.scrollBy(0, Math.round(window.innerHeight * 1.2));
    await sleep(650);
  }
  window.scrollTo(0, 0);

  // ── Build markdown ──
  const lines = [];
  lines.push("# " + (title || "Reddit post"));
  lines.push("");
  lines.push("URL: " + location.href);
  const pm = [];
  if (subreddit) pm.push("r/" + subreddit);
  if (author) pm.push("u/" + author);
  if (postScore) pm.push(postScore + " points");
  if (pm.length) { lines.push(""); lines.push(pm.join(" · ")); }
  if (postBody) { lines.push(""); lines.push(postBody); }
  lines.push("");
  lines.push("## Comments (" + seen.size + ")");
  lines.push("");
  for (const c of seen.values()) {
    const indent = "  ".repeat(Math.min(c.depth, 8));
    const who = "u/" + c.author + (c.isOp ? " (OP)" : "");
    const csm = [];
    if (c.score) csm.push(c.score + " pts");
    lines.push(indent + "- **" + who + "**" + (csm.length ? " _" + csm.join(", ") + "_" : ""));
    if (c.body) {
      const ind = indent + "  ";
      lines.push(c.body.split("\\n").map(l => ind + l).join("\\n"));
    }
    lines.push("");
  }
  if (seen.size === 0) {
    lines.push("_No comments found or extracted. The page may require login, or comments may not have loaded._");
  }
  return lines.join("\\n");
})()`;

// ── Amazon extractor ─────────────────────────────────────────────────────
// Amazon product pages are extremely noisy: the generic extractor pulls
// ~110KB of nav, keyboard-shortcut help, and category links before reaching
// the actual product data (and truncates at 90KB, often losing specs). This
// dedicated extractor pulls structured fields (title, price, availability,
// brand, rating, bullets, tech specs, ASIN) into ~2-3KB of clean markdown.
// Reviews are lazy-loaded near the bottom, so this is async and self-scrolls
// a few times to try to capture a few top reviews (best-effort).
const AMAZON_PRODUCT_JS = `(async () => {
  const clean = s => (s||"").replace(/\\s+/g, " ").trim();
  const txt = sel => { const el = document.querySelector(sel); return el ? clean(el.innerText) : null; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const title = txt("#productTitle") || txt("#titleSection");
  const price = txt("#corePrice_feature_div .a-offscreen") || txt(".a-price .a-offscreen");
  const listPrice = txt("#corePrice_feature_div .a-text-price .a-offscreen") || txt(".a-price.a-text-price .a-offscreen");
  const availability = txt("#availability span") || txt("#availability");
  let brand = txt("#bylineInfo") || "";
  brand = brand.replace(/^Brand:\\s*/i, "").replace(/\\s*Visit the .* Store$/i, "").trim();
  const rating = txt('span[data-hook="rating-out-of-text"]') || txt(".a-icon-star .a-icon-alt");
  let reviewCount = txt("#acrCustomerReviewText") || "";
  reviewCount = reviewCount.replace(/[()]/g, "").trim();
  const asinM = location.pathname.match(/\\/dp\\/([A-Z0-9]{10})/);
  const asin = asinM ? asinM[1] : null;

  // Feature bullets — deduped (Amazon sometimes repeats them)
  const bset = new Set(); const bullets = [];
  for (const el of document.querySelectorAll("#feature-bullets ul li span.a-list-item")) {
    const t = clean(el.innerText); if (!t || bset.has(t)) continue; bset.add(t); bullets.push(t);
  }
  // Tech specs — prefer the table, fall back to detail bullets
  const specs = []; const sset = new Set();
  for (const tr of document.querySelectorAll("#productDetails_techSpec_section_1 tr, #techSpecTable tr")) {
    const th = tr.querySelector("th"); const td = tr.querySelector("td");
    if (th && td) { const s = clean(th.innerText) + " :: " + clean(td.innerText); if (!sset.has(s)) { sset.add(s); specs.push(s); } }
  }
  if (specs.length === 0) {
    for (const li of document.querySelectorAll("#detailBulletsWrapper_feature_div li")) {
      const s = clean(li.innerText); if (!sset.has(s)) { sset.add(s); specs.push(s); }
    }
  }
  const description = txt("#productDescription");

  // Reviews are lazy-loaded near the bottom — best-effort scroll to find a few
  let reviews = [];
  for (let i = 0; i < 4; i++) {
    const els = [...document.querySelectorAll('[data-hook="review-body"] span')];
    if (els.length > 0) { reviews = els.slice(0, 5).map(el => clean(el.innerText).slice(0, 400)); break; }
    window.scrollBy(0, Math.round(window.innerHeight * 1.5));
    await sleep(700);
  }
  window.scrollTo(0, 0);

  // CAPTCHA / bot-check guard: if no title and no ASIN, the page is likely a
  // "Enter the characters you see below" interstitial.
  if (!title && !asin) {
    const cap = ["# Amazon (no product data found)", "", "URL: " + location.href, "", "_The page may be a CAPTCHA / bot-check interstitial, or the product is no longer available._"];
    return cap.join("\\n");
  }

  const lines = [];
  lines.push("# " + (title || "Amazon product"));
  lines.push("");
  lines.push("URL: " + location.href);
  if (asin) lines.push("ASIN: " + asin);
  lines.push("");
  const meta = [];
  if (price) meta.push("Price: " + price);
  if (listPrice) meta.push("List price: " + listPrice);
  if (availability) meta.push("Availability: " + availability);
  if (brand) meta.push("Brand: " + brand);
  if (rating) meta.push("Rating: " + rating + (reviewCount ? " (" + reviewCount + " reviews)" : ""));
  for (const m of meta) lines.push("- " + m);
  if (bullets.length) {
    lines.push("");
    lines.push("## About this item");
    for (const b of bullets) lines.push("- " + b);
  }
  if (specs.length) {
    lines.push("");
    lines.push("## Technical specifications");
    for (const s of specs) lines.push("- " + s);
  }
  if (description) {
    lines.push("");
    lines.push("## Description");
    lines.push(description);
  }
  if (reviews.length) {
    lines.push("");
    lines.push("## Top reviews");
    for (const r of reviews) lines.push("> " + r.replace(/\\n/g, " "));
  }
  return lines.join("\\n");
})()`;

// Amazon search results (/s?k=...). Each result is a card with
// data-component-type="s-search-result" and data-asin. Results are paginated
// via infinite scroll, so this is async + self-scrolling and dedupes by ASIN,
// like the X/Reddit extractors.
const AMAZON_SEARCH_JS = `(async () => {
  const clean = s => (s||"").replace(/\\s+/g, " ").trim();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden"; };

  const seen = new Map();
  let stale = 0;
  for (let i = 0; i < 10; i++) {
    let added = 0;
    for (const c of document.querySelectorAll('[data-component-type="s-search-result"]')) {
      if (!visible(c)) continue;
      const asin = c.getAttribute("data-asin");
      if (!asin || seen.has(asin)) continue;
      const h2 = c.querySelector("h2");
      const title = h2 ? clean(h2.innerText) : null;
      const priceEl = c.querySelector(".a-price .a-offscreen");
      const price = priceEl ? clean(priceEl.innerText) : null;
      let rating = null;
      for (const ia of c.querySelectorAll(".a-icon-alt")) {
        const t = clean(ia.innerText); if (/out of 5/i.test(t)) { rating = t; break; }
      }
      const sponsored = !!c.querySelector(".puis-label-popover-default, [aria-label*='Sponsored' i]");
      if (!title && !price) continue;
      seen.set(asin, { title: title ? title.slice(0, 220) : null, price, rating, sponsored, url: "https://" + location.host + "/dp/" + asin });
      added++;
    }
    if (seen.size >= 40) break;
    if (added === 0) { stale++; if (stale >= 2) break; } else { stale = 0; }
    window.scrollBy(0, Math.round(window.innerHeight * 1.5));
    await sleep(700);
  }
  window.scrollTo(0, 0);

  const query = new URLSearchParams(location.search).get("k") || clean(document.title).replace(/\\s*[|:]\\s*Amazon.*$/i, "");
  const lines = ["# Amazon search: " + (query || "(no query)"), "", "URL: " + location.href, "", "## Results (" + seen.size + ")", ""];
  if (seen.size === 0) {
    lines.push("_No results found or extracted. The page may be a CAPTCHA / bot-check interstitial._");
    return lines.join("\\n");
  }
  for (const r of seen.values()) {
    const parts = [];
    if (r.price) parts.push(r.price);
    if (r.rating) parts.push(r.rating);
    lines.push("- **" + (r.title || "(no title)") + (r.sponsored ? " [Sponsored]" : "") + "**" + (parts.length ? " — " + parts.join(" | ") : ""));
    lines.push("  " + r.url);
  }
  return lines.join("\\n");
})()`;

// ── Google Scholar extractor ──────────────────────────────────────────────
// Scholar search pages (scholar.google.com/scholar?q=...) render results as
// .gs_r blocks, each with .gs_ri (info) containing .gs_rt (title+link), .gs_a
// (authors/year/venue), .gs_rs (snippet), and .gs_fl (footer links: Cited by,
// Related, Versions). The generic extractor flattens these into H3 headers and
// loses the authors, snippets, citation counts, and PDF links — the data that
// matters for academic search. Scholar paginates (10 results/page) rather than
// infinite-scrolling, so this is synchronous like GOOGLE_SEARCH_JS (no async
// scroll loop). The dedicated Chrome profile carries any locale setting, so
// the citation footer text varies ("Cited by 1108" / "Cité 1108 fois" /
// "Citado por 1108" / "Zitiert von 1108") — matched with a locale-agnostic
// regex.
const SCHOLAR_EXTRACT_JS = `(() => {
  const clean = s => (s||"").replace(/\\s+/g, " ").trim();
  const esc = s => clean(s).replace(/\\\\/g, "\\\\\\\\").replace(/\\[/g, "\\\\[").replace(/\\]/g, "\\\\]");
  const q = new URLSearchParams(location.search).get("q") || clean(document.title).replace(/\\s*-\\s*Google Scholar\\s*$/i, "");
  const results = [];
  const seen = new Set();
  for (const c of document.querySelectorAll(".gs_r")) {
    const ri = c.querySelector(".gs_ri");
    if (!ri) continue;
    const titleEl = ri.querySelector(".gs_rt");
    const titleA = titleEl ? titleEl.querySelector("a") : null;
    const title = titleEl ? clean(titleEl.innerText).replace(/^\\[PDF\\]\\s*/i, "").replace(/^\\[HTML\\]\\s*/i, "").replace(/^\\[CITATION\\]\\s*/i, "") : null;
    const href = titleA ? titleA.href : null;
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const meta = ri.querySelector(".gs_a") ? clean(ri.querySelector(".gs_a").innerText) : "";
    const snip = ri.querySelector(".gs_rs") ? clean(ri.querySelector(".gs_rs").innerText) : "";
    // Footer links: [Save, Cite, Cited by N, Related, Versions]
    const fl = ri.querySelector(".gs_fl");
    let cited = null;
    if (fl) {
      for (const a of fl.querySelectorAll("a")) {
        const t = clean(a.innerText);
        const m = t.match(/(\\d[\\d,]*)/);
        if (m && /cited|cit\\u00e9|citado|zitiert/i.test(t)) { cited = m[1].replace(/,/g, ""); break; }
      }
    }
    // PDF link (sidebar)
    const pdfEl = c.querySelector(".gs_or_ggsm a, .gs_ggsd a");
    const pdf = pdfEl ? pdfEl.href : null;
    results.push({ title, href, meta, snip, cited, pdf });
  }
  // CAPTCHA / bot-check guard
  if (results.length === 0 && /captcha|unusual traffic|automated queries/i.test(document.body.innerText)) {
    return "# Google Scholar (blocked)\\n\\nURL: " + location.href + "\\n\\n_Scholar returned a CAPTCHA / bot-check page. Try again later or solve it in the visible Chrome window._";
  }
  const lines = ["# Google Scholar: " + (q || "(no query)"), "", "URL: " + location.href, "", "## Results (" + results.length + ")", ""];
  if (results.length === 0) {
    lines.push("_No results found or extracted._");
    return lines.join("\\n");
  }
  let i = 0;
  for (const r of results) {
    i++;
    lines.push(i + ". **" + r.title + "**");
    if (r.meta) lines.push("   " + r.meta + (r.cited ? " · Cited by " + r.cited : ""));
    else if (r.cited) lines.push("   Cited by " + r.cited);
    if (r.snip) lines.push("   " + r.snip);
    const links = [];
    if (r.href) links.push("[Article](" + r.href + ")");
    if (r.pdf) links.push("[PDF](" + r.pdf + ")");
    if (links.length) lines.push("   " + links.join(" · "));
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

function isRedditPostUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const isReddit = host === "reddit.com" || host.endsWith(".reddit.com");
    // Only post/comment pages — listings and user pages use the generic extractor.
    return isReddit && u.pathname.includes("/comments/");
  } catch {
    return false;
  }
}

function isAmazonProductUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/(^|\.)amazon\./.test(u.hostname.toLowerCase())) return false;
    // /dp/ASIN, /gp/product/ASIN, /gp/aw/d/ASIN
    return /\/(dp|gp\/product|gp\/aw\/d)\/[A-Z0-9]{10}/.test(u.pathname);
  } catch {
    return false;
  }
}

function isAmazonSearchUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/(^|\.)amazon\./.test(u.hostname.toLowerCase())) return false;
    // Amazon search: /s?k=... (also /s/ on some locales)
    return (u.pathname === "/s" || u.pathname.startsWith("/s/")) && u.searchParams.has("k");
  } catch {
    return false;
  }
}

function isScholarSearchUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    // scholar.google.com (any TLD) — search and citation pages both use /scholar
    return host === "scholar.google.com" || host.endsWith(".scholar.google.com");
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
        // cdp.evaluate stringifies the return value (String(value)), so the
        // boolean false becomes "false" (a truthy string). Compare explicitly
        // to "true" instead of relying on truthiness.
        const found = await cdp.evaluate(
          `document.querySelector(${JSON.stringify(waitForSelector)}) !== null`
        );
        if (found === "true") break;
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

  if (isRedditPostUrl(url)) {
    status("Detected Reddit post — using comment extractor...");
    const markdown = await runInPage({
      url,
      js: REDDIT_EXTRACT_JS,
      clickConsent: false,
      dynamicScroll: false,
      initialWaitMs: 500,
      waitForSelector: 'shreddit-comment, shreddit-post',
      waitForTimeoutMs: 10_000,
      onStatus: status,
    });
    return { markdown, url };
  }

  if (isAmazonProductUrl(url)) {
    status("Detected Amazon product page — using product extractor...");
    const markdown = await runInPage({
      url,
      js: AMAZON_PRODUCT_JS,
      clickConsent: false,
      dynamicScroll: false,
      initialWaitMs: 500,
      waitForSelector: "#productTitle, #titleSection",
      waitForTimeoutMs: 10_000,
      onStatus: status,
    });
    return { markdown, url };
  }

  if (isAmazonSearchUrl(url)) {
    status("Detected Amazon search — using listing extractor...");
    const markdown = await runInPage({
      url,
      js: AMAZON_SEARCH_JS,
      clickConsent: false,
      dynamicScroll: false,
      initialWaitMs: 500,
      waitForSelector: '[data-component-type="s-search-result"]',
      waitForTimeoutMs: 10_000,
      onStatus: status,
    });
    return { markdown, url };
  }

  if (isScholarSearchUrl(url)) {
    status("Detected Google Scholar — using academic extractor...");
    const markdown = await runInPage({
      url,
      js: SCHOLAR_EXTRACT_JS,
      clickConsent: false,
      dynamicScroll: false,
      initialWaitMs: 500,
      waitForSelector: ".gs_r, .gs_ri",
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
