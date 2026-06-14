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

import type { ExtensionAPI, ToolResult } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { googleSearch, visitPage, shutdownChrome } from "./src/chrome.js";

type RenderArgs = { query?: string; url?: string };
type RenderState = { expanded?: boolean; isPartial?: boolean };
type ToolTheme = {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
  dim: (text: string) => string;
};

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
    async execute(_toolCallId, params, _signal, onUpdate) {
      const { query } = params;
      if (!query || !query.trim()) {
        return {
          content: [{ type: "text" as const, text: "Tool error: google_search requires a query." }],
          details: {},
        };
      }

      try {
        const started = Date.now();
        const result = await googleSearch(query.trim(), (msg) => {
          onUpdate?.({
            content: [{ type: "text", text: msg }],
            details: { _progress: true },
          });
        });
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);

        return {
          content: [{ type: "text" as const, text: result.markdown }],
          details: { url: result.url, elapsed: `${elapsed}s`, chars: result.markdown.length },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`google_search failed: ${message}`);
      }
    },

    renderCall(args: Partial<RenderArgs>, theme: ToolTheme) {
      const q = (args.query || "").slice(0, 60);
      const trunc = q.length < (args.query || "").length ? "..." : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("google_search"))} "${theme.fg("accent", q + trunc)}"`,
        0,
        0,
      );
    },

    renderResult(result: ToolResult, { expanded, isPartial }: RenderState, theme: ToolTheme) {
      if (isPartial) {
        const progress = result.content.find((c) => c.type === "text")?.text ?? "Searching...";
        return new Text(theme.fg("warning", progress), 0, 0);
      }

      const details = result.details as { url?: string; elapsed?: string; chars?: number } | undefined;
      if (!expanded) {
        const parts: string[] = [];
        if (details?.chars) parts.push(`${details.chars.toLocaleString()} chars`);
        if (details?.elapsed) parts.push(details.elapsed);
        if (details?.url) parts.push(new URL(details.url).hostname);
        return new Text(theme.fg("muted", ` → ${parts.join(" · ")}`), 0, 0);
      }

      const text = result.content.find((c) => c.type === "text")?.text ?? "";
      return new Text(`\n${text.split("\n").map((l) => theme.fg("toolOutput", l)).join("\n")}`, 0, 0);
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
    async execute(_toolCallId, params, _signal, onUpdate) {
      const { url } = params;
      if (!url || !url.trim()) {
        return {
          content: [{ type: "text" as const, text: "Tool error: visit_page requires a URL." }],
          details: {},
        };
      }

      let targetUrl: string;
      try {
        targetUrl = new URL(url.trim()).toString();
      } catch {
        return {
          content: [{ type: "text" as const, text: `Tool error: visit_page: invalid URL: ${url}` }],
          details: {},
        };
      }

      try {
        const started = Date.now();
        const result = await visitPage(targetUrl, (msg) => {
          onUpdate?.({
            content: [{ type: "text", text: msg }],
            details: { _progress: true },
          });
        });
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);

        return {
          content: [{ type: "text" as const, text: result.markdown }],
          details: { url: result.url, elapsed: `${elapsed}s`, chars: result.markdown.length },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`visit_page failed: ${message}`);
      }
    },

    renderCall(args: Partial<RenderArgs>, theme: ToolTheme) {
      const u = args.url || "";
      const hostname = (() => { try { return new URL(u).hostname; } catch { return u; } })();
      return new Text(
        `${theme.fg("toolTitle", theme.bold("visit_page"))} ${theme.fg("accent", hostname)}`,
        0,
        0,
      );
    },

    renderResult(result: ToolResult, { expanded, isPartial }: RenderState, theme: ToolTheme) {
      if (isPartial) {
        const progress = result.content.find((c) => c.type === "text")?.text ?? "Loading...";
        return new Text(theme.fg("warning", progress), 0, 0);
      }

      const details = result.details as { url?: string; elapsed?: string; chars?: number } | undefined;
      if (!expanded) {
        const parts: string[] = [];
        if (details?.chars) parts.push(`${details.chars.toLocaleString()} chars`);
        if (details?.elapsed) parts.push(details.elapsed);
        if (details?.url) {
          try { parts.push(new URL(details.url).hostname); } catch { /* */ }
        }
        return new Text(theme.fg("muted", ` → ${parts.join(" · ")}`), 0, 0);
      }

      const text = result.content.find((c) => c.type === "text")?.text ?? "";
      return new Text(`\n${text.split("\n").map((l) => theme.fg("toolOutput", l)).join("\n")}`, 0, 0);
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
}
