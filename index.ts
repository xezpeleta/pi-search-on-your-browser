/**
 * pi-search-on-your-browser — exact same approach as ds4-agent, for Pi
 *
 * @antirez's ds4-agent strategy:
 *   https://x.com/antirez/status/2066233392916525379
 *   https://github.com/antirez/ds4
 *
 * Same approach: visible Chrome (not headless), CDP WebSocket, inline JS
 * extractors. No API keys, no headless detection.
 *
 * Registered tools:
 *   - google_search   — Search Google in a visible Chrome browser, returns markdown links + snippet
 *   - visit_page      — Visit a URL in a visible Chrome browser, returns rendered page as markdown
 *
 * Registered commands:
 *   - /google-search-kill  — Kill the Chrome process
 *
 * Chrome runs in a visible window (not headless) with a dedicated profile at
 * ~/.pi-search-browser/ — cookies and sessions persist across calls.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { googleSearch, visitPage, shutdownChrome } from "./src/chrome.js";

export default function searchOnYourBrowser(pi: ExtensionAPI) {
  // ── google_search tool ───────────────────────────────────────────────────

  pi.registerTool({
    name: "google_search",
    label: "Google Search",
    description:
      "Search Google in your visible Chrome browser and return compact Markdown links. Uses your real browser fingerprint — no API keys, no headless detection.",
    promptSnippet: "google_search: search Google in your visible browser, returns markdown links",
    promptGuidelines: [
      "Use google_search to find web pages when you need real-time information. Results include clickable markdown links.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query to send to Google" }),
    }),
    async execute(_toolCallId, params) {
      const { query } = params;
      if (!query || !query.trim()) {
        return {
          content: [{ type: "text" as const, text: "Tool error: google_search requires a query." }],
          details: {},
        };
      }

      try {
        const result = await googleSearch(query.trim());
        return {
          content: [{ type: "text" as const, text: result.markdown }],
          details: {},
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Tool error: google_search failed: ${message}` }],
          details: {},
        };
      }
    },
  });

  // ── visit_page tool ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "visit_page",
    label: "Visit Page",
    description:
      "Open a URL in your visible Chrome browser and return the rendered page as Markdown. Works with authenticated sites, paywalls, and JavaScript-heavy pages.",
    promptSnippet: "visit_page: visit a URL in your visible browser, returns rendered markdown",
    promptGuidelines: [
      "Use visit_page to read a web page you found via google_search. It opens in your visible Chrome so authenticated/paywalled sites work.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Full URL to visit" }),
    }),
    async execute(_toolCallId, params) {
      const { url } = params;
      if (!url || !url.trim()) {
        return {
          content: [{ type: "text" as const, text: "Tool error: visit_page requires a URL." }],
          details: {},
        };
      }

      // Basic URL validation
      let targetUrl: string;
      try {
        const parsed = new URL(url.trim());
        targetUrl = parsed.toString();
      } catch {
        return {
          content: [{ type: "text" as const, text: `Tool error: visit_page: invalid URL: ${url}` }],
          details: {},
        };
      }

      try {
        const result = await visitPage(targetUrl);
        return {
          content: [{ type: "text" as const, text: result.markdown }],
          details: {},
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Tool error: visit_page failed: ${message}` }],
          details: {},
        };
      }
    },
  });

  // ── Commands ─────────────────────────────────────────────────────────────

  pi.registerCommand("google-search-kill", {
    description: "Kill the Google Search Chrome browser process",
    handler: async (_args, ctx) => {
      shutdownChrome();
      ctx.ui.notify("Google Search Chrome killed.", "info");
    },
  });

  // ── Startup notification ─────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      "pi-search-on-your-browser loaded — /google-search-kill to stop Chrome",
      "info"
    );
  });

  // ── Cleanup on shutdown ──────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    // Don't kill Chrome — keep it alive for faster subsequent calls (like ds4-agent)
    // User can manually kill with /google-search-kill
  });
}
