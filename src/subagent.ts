/**
 * Subagent — delegates page-content Q&A to a text model.
 *
 * Mirrors the vision-tool extension's approach: a model is resolved from Pi's
 * registry and called via a direct OpenAI-compatible /chat/completions request
 * using Pi's already-configured auth (no separate API keys). By default the
 * subagent reuses the current session model (ctx.model); an explicit
 * provider/model can be pinned via /browse to use a cheaper/faster model.
 *
 * Only the model's answer comes back to the chat context — the full page
 * markdown is consumed by the subagent internally but never enters the
 * conversation. This keeps visit_page results small when a `query` is supplied.
 *
 * This module is deliberately free of `@earendil-works/*` imports so it stays
 * type-checkable under `tsc --noEmit` (which only resolves Node built-ins for
 * src/). The real `Model<Api>` from the registry is structurally compatible
 * with `SubagentModel` and is passed in from index.ts.
 *
 * Config is persisted to <agent-dir>/pi-search-on-your-browser.json (set via
 * setConfigDir(getAgentDir()) on session_start) and managed via /browse.
 *
 * Env-var fallbacks (optional overrides; else current model is used):
 * PI_BROWSE_PROVIDER, PI_BROWSE_MODEL, PI_BROWSE_MAX_TOKENS,
 * PI_BROWSE_REASONING_EFFORT.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Reasoning effort levels
// ---------------------------------------------------------------------------
const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

// ---------------------------------------------------------------------------
// Minimal structural subset of pi's Model<Api> used by the subagent.
// The real Model object from ctx.modelRegistry satisfies this shape.
// ---------------------------------------------------------------------------
export interface SubagentModel {
  id: string;
  baseUrl: string;
  reasoning: boolean;
  contextWindow: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: { thinkingFormat?: string };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export interface SubagentConfig {
  provider?: string;
  model?: string;
  maxTokens: number;
  defaultReasoningEffort: ReasoningLevel;
  enabled: boolean;
}

const DEFAULT_MAX_TOKENS = parseInt(process.env.PI_BROWSE_MAX_TOKENS ?? "2048", 10);

const DEFAULT_CONFIG: SubagentConfig = {
  maxTokens: DEFAULT_MAX_TOKENS,
  defaultReasoningEffort: "off",
  enabled: true,
};

/** Live config singleton. Mutated in place by /browse and session_start. */
export const config: SubagentConfig = { ...DEFAULT_CONFIG };

// Config file path. Overridden by index.ts via setConfigDir(getAgentDir()) so
// PI_AGENT_DIR / custom config dirs are respected. Falls back to ~/.pi/agent.
let configDir: string | null = null;

export function setConfigDir(dir: string): void {
  configDir = dir;
}

function defaultConfigDir(): string {
  return join(homedir(), ".pi", "agent");
}

export function configPath(): string {
  return join(configDir ?? defaultConfigDir(), "pi-search-on-your-browser.json");
}

// ---------------------------------------------------------------------------
// System prompt for the subagent
// ---------------------------------------------------------------------------
export const SUBAGENT_SYSTEM_PROMPT = [
  "You are an expert web research assistant.",
  "You are given the markdown content of a web page and a user's question about it.",
  "",
  "Guidelines:",
  "- Answer the user's question using ONLY the provided page content.",
  "- If the answer is not present in the content, say so explicitly and briefly.",
  "- Be concise and factual. Do not pad with filler or repeat the question.",
  "- Preserve specific details that matter: numbers, names, dates, prices, code, URLs.",
  "- Quote or paraphrase the relevant snippets rather than summarizing vaguely.",
  "- Preserve code blocks, tables, or lists when they are directly relevant.",
  "- Use markdown formatting when it aids clarity.",
  "- Do not mention that you were given page content or that you are a subagent — just answer.",
].join("\n");

// ---------------------------------------------------------------------------
// Coercion helpers (config file is arbitrary JSON)
// ---------------------------------------------------------------------------
type RawConfig = Record<string, unknown>;

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asNumber(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

export function validateReasoningLevel(value: string | undefined): ReasoningLevel | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if ((REASONING_LEVELS as readonly string[]).includes(normalized)) {
    return normalized as ReasoningLevel;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

/** Load config from the JSON file. Returns null if missing or unparseable. */
export function loadConfigFile(): RawConfig | null {
  try {
    const path = configPath();
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (raw && typeof raw === "object") return raw as RawConfig;
    return null;
  } catch {
    return null;
  }
}

/** Save current config to the JSON file. */
export function saveConfigFile(): void {
  try {
    const path = configPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  } catch {
    // best effort — directory not writable, etc.
  }
}

/**
 * Resolve config with priority:
 *   1. Config file (<agent-dir>/pi-search-on-your-browser.json)
 *   2. Environment variables (PI_BROWSE_PROVIDER, PI_BROWSE_MODEL, etc.)
 *   3. Built-in defaults
 *
 * The file wins over env vars so /browse config changes are sticky.
 */
export function resolveConfig(): SubagentConfig {
  const file = loadConfigFile();
  const envReasoning = validateReasoningLevel(process.env.PI_BROWSE_REASONING_EFFORT);
  const fileReasoning = validateReasoningLevel(asString(file?.defaultReasoningEffort));
  const fileEnabled = asBool(file?.enabled);
  return {
    provider: asString(file?.provider) || process.env.PI_BROWSE_PROVIDER || undefined,
    model: asString(file?.model) || process.env.PI_BROWSE_MODEL || undefined,
    maxTokens:
      file?.maxTokens !== undefined
        ? asNumber(file.maxTokens, DEFAULT_CONFIG.maxTokens)
        : parseInt(process.env.PI_BROWSE_MAX_TOKENS ?? String(DEFAULT_MAX_TOKENS), 10),
    defaultReasoningEffort: fileReasoning ?? envReasoning ?? "off",
    enabled: fileEnabled !== false,
  };
}

/** Reload config from file/env into the live singleton. */
export function reloadConfig(): void {
  Object.assign(config, resolveConfig());
}

/** Human-readable config summary for the /browse command.
 *
 *  `currentModel` (the active session model, from ctx.model) is shown so the
 *  user knows what query mode will use when no explicit provider/model is
 *  configured — by default the subagent reuses the current Pi model and its
 *  already-configured auth, so no separate API key setup is needed. */
export function configSummary(
  currentModel?: { provider: string; id: string; name?: string },
): string {
  const file = loadConfigFile();
  const src = file
    ? "config file"
    : process.env.PI_BROWSE_PROVIDER
      ? "env vars"
      : "default (current model)";
  const override = config.provider && config.model;
  const modelLine = override
    ? `${config.provider}/${config.model}`
    : currentModel
      ? `${currentModel.provider}/${currentModel.id} (current model)`
      : "(none — no current model)";
  return [
    `Browse subagent configuration (source: ${src})`,
    `  Model:             ${modelLine}`,
    `  Max tokens:        ${config.maxTokens}`,
    `  Reasoning effort:  ${config.defaultReasoningEffort}`,
    `  Enabled:           ${config.enabled ? "yes" : "no"}`,
    ``,
    `Config file: ${configPath()}`,
    ``,
    "When visit_page is called with a `query`, the page content is sent to this",
    "model and only its answer is returned to the chat context (the full page",
    "markdown is discarded). Without a `query`, visit_page behaves as before.",
    ``,
    "By default the subagent reuses your current Pi model (shown above) with its",
    "already-configured auth — no API keys to set up. To pin a different model:",
    "  /browse provider <provider>   /browse model <model-id>",
    "Other settings: max-tokens, reasoning-effort. Use /browse on|off to toggle.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Token budget / truncation
// ---------------------------------------------------------------------------

/**
 * Truncate page content so the subagent request fits within the model's
 * context window. Tokens are estimated at 4 chars each (rough but safe).
 * Room is reserved for the system prompt, the query, and max output tokens.
 */
export function truncateForContext(
  content: string,
  query: string,
  model: SubagentModel,
  maxTokens: number,
): { content: string; truncated: boolean; originalChars: number } {
  const originalChars = content.length;
  const TOKEN_CHARS = 4;
  const reservedTokens =
    Math.ceil(SUBAGENT_SYSTEM_PROMPT.length / TOKEN_CHARS) +
    Math.ceil(query.length / TOKEN_CHARS) +
    maxTokens +
    500; // safety buffer for URL, wrappers, message overhead
  const availableTokens = Math.max(0, model.contextWindow - reservedTokens);
  const maxChars = Math.max(0, availableTokens * TOKEN_CHARS);

  if (originalChars <= maxChars) {
    return { content, truncated: false, originalChars };
  }

  const NOTICE =
    "\n\n[... page content truncated to fit the subagent model's context window ...]";
  const slice = content.slice(0, Math.max(0, maxChars - NOTICE.length));
  return { content: slice + NOTICE, truncated: true, originalChars };
}

// ---------------------------------------------------------------------------
// Message building
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/** Build the OpenAI chat-completions messages for the subagent call. */
export function buildMessages(url: string, content: string, query: string): ChatMessage[] {
  const userContent =
    `URL: ${url}\n\n` +
    `PAGE CONTENT (markdown):\n` +
    `---\n${content}\n---\n\n` +
    `Question: ${query}`;
  return [
    { role: "system", content: SUBAGENT_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
}

// ---------------------------------------------------------------------------
// Reasoning params (mirrors vision-tool's buildReasoningParams)
// ---------------------------------------------------------------------------

/**
 * Build the reasoning/thinking parameters for the API request.
 *
 * Only sends reasoning params when the model has `reasoning: true`.
 * Respects the model's `thinkingLevelMap` (null = level unsupported → skip)
 * and `compat.thinkingFormat` for provider-specific formats:
 * - qwen / qwen-chat-template: enable_thinking: boolean
 * - deepseek / openrouter:     reasoning: { effort }
 * - together:                  reasoning: { enabled } + reasoning_effort
 * - default (OpenAI):          reasoning_effort
 */
export function buildReasoningParams(
  model: SubagentModel,
  level: ReasoningLevel,
): Record<string, unknown> | undefined {
  if (!model.reasoning) return undefined;

  const levelMap = model.thinkingLevelMap;
  let effectiveLevel: string | null = level;

  if (levelMap) {
    const mapped = levelMap[level];
    if (mapped === null) {
      // Level explicitly unsupported — skip reasoning params entirely.
      return undefined;
    }
    if (mapped !== undefined) {
      effectiveLevel = mapped;
    }
  }

  const format = model.compat?.thinkingFormat;

  if (format === "qwen" || format === "qwen-chat-template") {
    const enable = effectiveLevel !== "off" && effectiveLevel !== "none";
    if (format === "qwen-chat-template") {
      return { chat_template_kwargs: { enable_thinking: enable } };
    }
    return { enable_thinking: enable };
  }

  if (format === "deepseek" || format === "openrouter") {
    // Mirror pi: OpenRouter sends effort: "none" when reasoning is off.
    if (effectiveLevel === "off" || effectiveLevel === "none") {
      return { reasoning: { effort: "none" } };
    }
    return { reasoning: { effort: effectiveLevel } };
  }

  if (format === "together") {
    const enabled = effectiveLevel !== "off" && effectiveLevel !== "none";
    if (!enabled) {
      return { reasoning: { enabled: false } };
    }
    return { reasoning: { enabled: true }, reasoning_effort: effectiveLevel };
  }

  // Default: standard OpenAI reasoning_effort.
  // Mirror pi: when reasoning is "off", don't send the param at all (pi only
  // sends reasoning_effort when the value is truthy). Sending "off" causes
  // HTTP 400 on APIs (e.g. vLLM) that accept "none"/"minimal"/... but not "off".
  if (effectiveLevel === "off" || effectiveLevel === "none") {
    return undefined;
  }
  return { reasoning_effort: effectiveLevel };
}

// ---------------------------------------------------------------------------
// The model call
// ---------------------------------------------------------------------------

/**
 * Call the subagent model with the page content + query and return its answer.
 *
 * Makes a direct OpenAI-compatible POST to `${baseUrl}/chat/completions`.
 * The configured model's baseUrl must therefore be OpenAI-compatible (this is
 * the same constraint as the vision tool — most providers qualify, including
 * OpenAI, OpenRouter, Together, Groq, DeepSeek, Mistral, and local
 * Ollama / LM Studio).
 */
export async function callSubagentModel(
  model: SubagentModel,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  url: string,
  content: string,
  query: string,
  signal: AbortSignal | undefined,
  reasoningLevel: ReasoningLevel,
  maxTokens: number,
): Promise<string> {
  const baseUrl = model.baseUrl.replace(/\/+$/, "");
  const messages = buildMessages(url, content, query);
  const reasoningParams = buildReasoningParams(model, reasoningLevel);

  const body: Record<string, unknown> = {
    model: model.id,
    messages,
    max_tokens: maxTokens,
    temperature: 0,
  };
  if (reasoningParams) Object.assign(body, reasoningParams);

  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(headers ?? {}),
  };
  if (apiKey && !reqHeaders.Authorization) {
    reqHeaders.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: reqHeaders,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(`Subagent model returned ${response.status}: ${errBody.slice(0, 500)}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
  };
  const msg = json.choices?.[0]?.message;
  return msg?.content || msg?.reasoning_content || "(no response from subagent model)";
}
