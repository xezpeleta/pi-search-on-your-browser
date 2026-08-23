import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateReasoningLevel,
  buildReasoningParams,
  truncateForContext,
  buildMessages,
  configSummary,
  config as __config,
  reloadConfig,
  SUBAGENT_SYSTEM_PROMPT,
  type SubagentModel,
} from "../../src/subagent.ts";

// Minimal model fixtures. truncateForContext / buildReasoningParams only read
// the fields below, so a partial object is sufficient.
function model(overrides: Partial<SubagentModel> = {}): SubagentModel {
  return {
    id: "test-model",
    baseUrl: "https://api.example.com/v1",
    reasoning: false,
    contextWindow: 8000,
    ...overrides,
  };
}

// ── validateReasoningLevel ────────────────────────────────────────────────

test("validateReasoningLevel: accepts all valid levels (case-insensitive)", () => {
  for (const lvl of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
    assert.equal(validateReasoningLevel(lvl), lvl);
    assert.equal(validateReasoningLevel(lvl.toUpperCase()), lvl);
  }
});

test("validateReasoningLevel: rejects unknown and empty", () => {
  assert.equal(validateReasoningLevel(undefined), undefined);
  assert.equal(validateReasoningLevel(""), undefined);
  assert.equal(validateReasoningLevel("max"), undefined);
  assert.equal(validateReasoningLevel("ultra"), undefined);
});

// ── buildReasoningParams ──────────────────────────────────────────────────

test("buildReasoningParams: returns undefined for non-reasoning model", () => {
  assert.equal(buildReasoningParams(model({ reasoning: false }), "high"), undefined);
});

test("buildReasoningParams: default format uses reasoning_effort", () => {
  const params = buildReasoningParams(model({ reasoning: true }), "high");
  assert.deepEqual(params, { reasoning_effort: "high" });
});

test("buildReasoningParams: openrouter format uses reasoning.effort", () => {
  const params = buildReasoningParams(
    model({ reasoning: true, compat: { thinkingFormat: "openrouter" } }),
    "medium",
  );
  assert.deepEqual(params, { reasoning: { effort: "medium" } });
});

test("buildReasoningParams: qwen format uses enable_thinking boolean", () => {
  const on = buildReasoningParams(
    model({ reasoning: true, compat: { thinkingFormat: "qwen" } }),
    "high",
  );
  assert.deepEqual(on, { enable_thinking: true });

  const off = buildReasoningParams(
    model({ reasoning: true, compat: { thinkingFormat: "qwen" } }),
    "off",
  );
  assert.deepEqual(off, { enable_thinking: false });
});

test("buildReasoningParams: thinkingLevelMap null skips params entirely", () => {
  // Some providers mark certain levels as unsupported via null.
  const params = buildReasoningParams(
    model({ reasoning: true, thinkingLevelMap: { high: null } }),
    "high",
  );
  assert.equal(params, undefined);
});

test("buildReasoningParams: thinkingLevelMap remaps level", () => {
  const params = buildReasoningParams(
    model({ reasoning: true, thinkingLevelMap: { high: "max" } }),
    "high",
  );
  assert.deepEqual(params, { reasoning_effort: "max" });
});

// ── truncateForContext ────────────────────────────────────────────────────

test("truncateForContext: returns content unchanged when it fits", () => {
  const m = model({ contextWindow: 8000 }); // ~lots of room
  const content = "x".repeat(1000);
  const out = truncateForContext(content, "what?", m, 2048);
  assert.equal(out.truncated, false);
  assert.equal(out.content, content);
  assert.equal(out.originalChars, 1000);
});

test("truncateForContext: truncates when content exceeds context window", () => {
  // Tiny context window forces truncation.
  const m = model({ contextWindow: 500 });
  const content = "x".repeat(10_000);
  const out = truncateForContext(content, "summarize", m, 256);
  assert.equal(out.truncated, true);
  assert.equal(out.originalChars, 10_000);
  assert.ok(out.content.length < 10_000, "truncated content should be smaller");
  assert.ok(
    out.content.includes("truncated to fit"),
    "should append a truncation notice",
  );
});

test("truncateForContext: reserves room for maxTokens", () => {
  // Same content + context window, but larger maxTokens → less room for content.
  const m = model({ contextWindow: 4000 });
  const content = "y".repeat(20_000);
  const small = truncateForContext(content, "q", m, 256);
  const large = truncateForContext(content, "q", m, 3000);
  // Larger maxTokens reservation → smaller available content budget.
  assert.ok(
    large.content.length <= small.content.length,
    `larger maxTokens should leave less room (got ${large.content.length} vs ${small.content.length})`,
  );
});

test("truncateForContext: empty content passes through untouched", () => {
  const out = truncateForContext("", "q", model({ contextWindow: 1000 }), 100);
  assert.equal(out.truncated, false);
  assert.equal(out.content, "");
  assert.equal(out.originalChars, 0);
});

// ── buildMessages ─────────────────────────────────────────────────────────

test("buildMessages: produces system + user messages with URL, content, and query", () => {
  const msgs = buildMessages("https://example.com/page", "Hello world", "What does it say?");
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[0].content, SUBAGENT_SYSTEM_PROMPT);
  assert.equal(msgs[1].role, "user");
  assert.ok(msgs[1].content.includes("https://example.com/page"));
  assert.ok(msgs[1].content.includes("Hello world"));
  assert.ok(msgs[1].content.includes("What does it say?"));
  assert.ok(msgs[1].content.includes("PAGE CONTENT"));
  assert.ok(msgs[1].content.includes("Question:"));
});

test("buildMessages: content is wrapped between delimiters", () => {
  const msgs = buildMessages("https://ex.com", "BODY", "Q");
  const user = msgs[1].content;
  const before = user.indexOf("---\n");
  const after = user.indexOf("\n---", before + 1);
  assert.ok(before >= 0, "opening delimiter missing");
  assert.ok(after > before, "closing delimiter missing");
  assert.ok(user.slice(before + 4, after).includes("BODY"), "content not between delimiters");
});

// ── configSummary: current-model fallback ─────────────────────────────────
// The key behavior change in v0.7: when no provider/model is pinned, the
// subagent reuses the current session model — configSummary should make that
// visible instead of showing "(not set)".

test("configSummary: shows current model when no override is configured", () => {
  __config.provider = undefined;
  __config.model = undefined;
  reloadConfig();
  const summary = configSummary({ provider: "openai", id: "gpt-4o", name: "GPT-4o" });
  assert.ok(summary.includes("openai/gpt-4o"), "should show current model");
  assert.ok(summary.includes("current model"), "should label it as the current model");
  assert.ok(!summary.includes("(not set)"), "should not say not-set when a current model exists");
});

test("configSummary: shows pinned override when provider+model are configured", () => {
  __config.provider = "anthropic";
  __config.model = "claude-3-5-haiku";
  const summary = configSummary({ provider: "openai", id: "gpt-4o" });
  // The Model line should show the override, not the current model.
  const modelLine = summary.split("\n").find((l) => l.includes("Model:"));
  assert.ok(modelLine?.includes("anthropic/claude-3-5-haiku"), `model line should show override: ${modelLine}`);
  assert.ok(!modelLine?.includes("current model"), "override should not be labeled current");
  // cleanup
  __config.provider = undefined;
  __config.model = undefined;
});

test("configSummary: shows (none) when no override and no current model", () => {
  __config.provider = undefined;
  __config.model = undefined;
  reloadConfig();
  const summary = configSummary(undefined);
  assert.ok(summary.includes("(none"), "should indicate no model available");
});
