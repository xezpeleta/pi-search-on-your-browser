import { test } from "node:test";
import assert from "node:assert/strict";
import { runInPageSession, type CDPLike, type RunInPageOptions } from "../../src/chrome.ts";

// ── Fake CDP ───────────────────────────────────────────────────────────────
// Implements CDPLike so runInPageSession can be exercised without a real
// browser or WebSocket. Records every call/evaluate for assertions.

class FakeCDP implements CDPLike {
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  evaluations: string[] = [];
  /** What waitForSelector polls return: "true" (found) or "false" (absent). */
  selectorFound = false;
  /** What the final extractor evaluate returns. */
  extractionResult = "extracted content";
  private loadHandlers: Array<(params: unknown) => void> = [];

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "Page.navigate") {
      // Fire load handlers synchronously (registered before navigate).
      for (const h of this.loadHandlers) h({});
    }
    return {};
  }

  async evaluate(expression: string): Promise<string> {
    this.evaluations.push(expression);
    // waitForSelector polls look like: document.querySelector("...") !== null
    // cdp.evaluate stringifies the boolean → "true" / "false" (the bug source).
    if (expression.startsWith("document.querySelector")) {
      return this.selectorFound ? "true" : "false";
    }
    return this.extractionResult;
  }

  onEvent(method: string, handler: (params: unknown) => void): void {
    if (method === "Page.loadEventFired") this.loadHandlers.push(handler);
  }

  disconnect(): void {}
}

function baseOpts(overrides: Partial<RunInPageOptions> = {}): RunInPageOptions {
  return {
    url: "https://example.com/page",
    js: "extractor()",
    onStatus: () => {},
    ...overrides,
  };
}

// ── The regression test ────────────────────────────────────────────────────
// This is the exact bug fixed in v0.5.1: cdp.evaluate() stringifies its return
// value via String(value), so the boolean false became the string "false" —
// which is TRUTHY. The old code did `if (found) break`, breaking on the first
// poll regardless of whether the selector existed. Fix: `if (found === "true")`.

test("waitForSelector does NOT break on first poll when selector absent (v0.5.1 regression)", async () => {
  const fake = new FakeCDP();
  fake.selectorFound = false; // simulate selector not in DOM

  await runInPageSession(fake, baseOpts({
    waitForSelector: "article",
    waitForTimeoutMs: 1000,
    waitForSelectorPollMs: 50,
  }));

  const selectorPolls = fake.evaluations.filter((e) =>
    e.startsWith("document.querySelector"),
  ).length;

  // With the old buggy code, found = "false" (truthy) → break after 1 poll.
  // The fix (found === "true") keeps polling → multiple polls.
  assert.ok(
    selectorPolls > 1,
    `expected multiple selector polls (bug would give 1), got ${selectorPolls}`,
  );
});

test("waitForSelector breaks after first poll when selector is found", async () => {
  const fake = new FakeCDP();
  fake.selectorFound = true;

  const t0 = Date.now();
  await runInPageSession(fake, baseOpts({
    waitForSelector: "article",
    waitForTimeoutMs: 5000,
    waitForSelectorPollMs: 50,
  }));
  const elapsed = Date.now() - t0;

  const selectorPolls = fake.evaluations.filter((e) =>
    e.startsWith("document.querySelector"),
  ).length;

  assert.equal(selectorPolls, 1, `should break after first poll, got ${selectorPolls}`);
  assert.ok(elapsed < 500, `should break fast, took ${elapsed}ms`);
});

test("waitForSelector times out (and keeps polling) when selector never appears", async () => {
  const fake = new FakeCDP();
  fake.selectorFound = false;

  const t0 = Date.now();
  await runInPageSession(fake, baseOpts({
    waitForSelector: "article",
    waitForTimeoutMs: 200,
    waitForSelectorPollMs: 50,
  }));
  const elapsed = Date.now() - t0;

  // Should wait roughly the full timeout, not break early.
  assert.ok(elapsed >= 150, `should wait ~timeout duration, took ${elapsed}ms`);
});

// ── Navigation & extraction ────────────────────────────────────────────────

test("navigation calls Page.enable, Runtime.enable, Page.navigate in order", async () => {
  const fake = new FakeCDP();
  await runInPageSession(fake, baseOpts());

  const methods = fake.calls.map((c) => c.method);
  assert.deepEqual(
    methods.slice(0, 3),
    ["Page.enable", "Runtime.enable", "Page.navigate"],
  );
  const nav = fake.calls.find((c) => c.method === "Page.navigate");
  assert.equal(nav?.params?.url, "https://example.com/page");
});

test("extraction runs the provided JS and returns the evaluated result", async () => {
  const fake = new FakeCDP();
  fake.extractionResult = "## Extracted\n\nSome content";

  const result = await runInPageSession(fake, baseOpts({
    js: "myExtractor()",
  }));

  assert.equal(result, "## Extracted\n\nSome content");
  assert.equal(fake.evaluations.at(-1), "myExtractor()");
});

test("dynamicScroll issues scroll evaluations", async () => {
  const fake = new FakeCDP();
  await runInPageSession(fake, baseOpts({
    dynamicScroll: true,
    scrollCount: 3,
    scrollDelayMs: 1,
  }));

  const scrolls = fake.evaluations.filter((e) => e.includes("window.scrollTo"));
  // 3 scroll-downs + 1 scroll-to-top = 4
  assert.equal(scrolls.length, 4, `expected 4 scroll evaluations, got ${scrolls.length}`);
});

test("result is truncated at MAX_RESULT_BYTES (1MB)", async () => {
  const fake = new FakeCDP();
  fake.extractionResult = "x".repeat(2_000_000);

  const result = await runInPageSession(fake, baseOpts());

  assert.ok(result.length < 2_000_000, "should be truncated");
  assert.ok(result.includes("[Content truncated at 1MB]"), "should have truncation marker");
});
