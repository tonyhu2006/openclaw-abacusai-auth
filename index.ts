import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { emptyPluginConfigSchema, fetchWithSsrFGuard } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ABACUS_API = "https://api.abacus.ai/api/v0";
const ROUTELLM_BASE = "https://routellm.abacus.ai/v1";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8192;

// Proxy configuration
const PROXY_HOST = "127.0.0.1";
// Fixed port for the proxy so the baseUrl saved at auth time always works
const PROXY_PORT_DEFAULT = 18862;
let proxyPort = PROXY_PORT_DEFAULT;

// Models available on AbacusAI RouteLLM endpoint (OpenAI-compatible, with
// function calling support). Verified 2026-02.
const DEFAULT_MODEL_IDS = [
  // Google Gemini
  "gemini-3-flash-preview",
  "gemini-3-pro-preview",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  // OpenAI GPT
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5",
  "gpt-5-codex",
  "gpt-5-mini",
  "gpt-5-nano",
  // OpenAI o-series (reasoning)
  "o3-pro",
  "o3",
  "o3-mini",
  "o4-mini",
  // Anthropic Claude
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-6",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-20250514",
  "claude-haiku-4-5-20251001",
  // DeepSeek
  "deepseek-ai/DeepSeek-V3.2",
  "deepseek-ai/DeepSeek-V3.1-Terminus",
  "deepseek-ai/DeepSeek-R1",
  // xAI Grok
  "grok-4-0709",
  "grok-4-1-fast-non-reasoning",
  "grok-4-fast-non-reasoning",
  "grok-code-fast-1",
  // Meta Llama
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
  "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo",
  "llama-3.3-70b-versatile",
  // Qwen
  "qwen3-max",
  "Qwen/Qwen3-235B-A22B-Instruct-2507",
  "Qwen/Qwen3-32B",
  "qwen/qwen3-coder-480b-a35b-instruct",
  // Moonshot Kimi
  "kimi-k2.5",
  "kimi-k2-turbo-preview",
  // Z.AI GLM
  "zai-org/glm-4.7",
  "zai-org/glm-4.6",
  // Other
  "openai/gpt-oss-120b",
  // AbacusAI auto-router
  "route-llm",
];

// ---------------------------------------------------------------------------
// Credential detection (Code Mode / env / manual)
// ---------------------------------------------------------------------------

const CODE_MODE_CREDENTIAL_PATHS = {
  win32: [
    join(homedir(), "AppData", "Roaming", "AbacusAI", "User", "globalStorage", "credentials.json"),
    join(
      homedir(),
      "AppData",
      "Roaming",
      "AbacusAI Code Mode",
      "User",
      "globalStorage",
      "credentials.json",
    ),
    join(homedir(), ".abacusai", "credentials.json"),
    join(homedir(), ".abacusai", "config.json"),
  ],
  darwin: [
    join(
      homedir(),
      "Library",
      "Application Support",
      "AbacusAI",
      "User",
      "globalStorage",
      "credentials.json",
    ),
    join(
      homedir(),
      "Library",
      "Application Support",
      "AbacusAI Code Mode",
      "User",
      "globalStorage",
      "credentials.json",
    ),
    join(homedir(), ".abacusai", "credentials.json"),
    join(homedir(), ".abacusai", "config.json"),
  ],
  linux: [
    join(homedir(), ".config", "AbacusAI", "User", "globalStorage", "credentials.json"),
    join(homedir(), ".config", "AbacusAI Code Mode", "User", "globalStorage", "credentials.json"),
    join(homedir(), ".abacusai", "credentials.json"),
    join(homedir(), ".abacusai", "config.json"),
  ],
};

type CredentialFile = {
  apiKey?: string;
  api_key?: string;
  token?: string;
  accessToken?: string;
  access_token?: string;
};

function tryReadLocalCredential(): string | null {
  const platform = process.platform as "win32" | "darwin" | "linux";
  const paths = CODE_MODE_CREDENTIAL_PATHS[platform] ?? CODE_MODE_CREDENTIAL_PATHS.linux;
  for (const credPath of paths) {
    try {
      const raw = readFileSync(credPath, "utf8");
      const data = JSON.parse(raw) as CredentialFile;
      const key =
        data.apiKey?.trim() ||
        data.api_key?.trim() ||
        data.token?.trim() ||
        data.accessToken?.trim() ||
        data.access_token?.trim();
      if (key) {
        return key;
      }
    } catch {
      // not found — try next
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Saved credential recovery (for proxy auto-restart after reboot)
// ---------------------------------------------------------------------------

function resolveOpenClawStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return override;
  }
  return join(homedir(), ".openclaw");
}

function tryRecoverApiKey(): string | null {
  const stateDir = resolveOpenClawStateDir();

  // Helper: extract abacusai API key from an auth-profiles.json file
  function extractFromAuthFile(authPath: string): string | null {
    try {
      const raw = JSON.parse(readFileSync(authPath, "utf8")) as {
        profiles?: Record<string, { token?: string; key?: string; provider?: string }>;
      };
      if (raw.profiles) {
        for (const [id, profile] of Object.entries(raw.profiles)) {
          if (!id.startsWith("abacusai:")) {
            continue;
          }
          // Credentials may use "token" or "key" field depending on auth flow
          const secret = profile.token?.trim() || profile.key?.trim();
          if (secret) {
            return secret;
          }
        }
      }
    } catch {
      // file not found or unreadable
    }
    return null;
  }

  // Primary: search agents/*/agent/auth-profiles.json (actual storage location)
  try {
    const agentsDir = join(stateDir, "agents");
    for (const agentName of readdirSync(agentsDir)) {
      const authPath = join(agentsDir, agentName, "agent", "auth-profiles.json");
      const key = extractFromAuthFile(authPath);
      if (key) {
        return key;
      }
    }
  } catch {
    // agents dir not found
  }

  // Fallback: try root-level auth-profiles.json (legacy or future layout)
  const rootKey = extractFromAuthFile(join(stateDir, "auth-profiles.json"));
  if (rootKey) {
    return rootKey;
  }

  // Fallback: try environment variable
  const envKey = process.env.ABACUSAI_API_KEY?.trim();
  if (envKey) {
    return envKey;
  }
  // Fallback: try local Code Mode credentials
  return tryReadLocalCredential();
}

// ---------------------------------------------------------------------------
// AbacusAI API helpers
// ---------------------------------------------------------------------------

async function validateApiKey(
  apiKey: string,
): Promise<{ valid: boolean; email?: string; error?: string }> {
  try {
    const { response: r, release } = await fetchWithSsrFGuard({
      url: `${ABACUS_API}/describeUser`,
      init: {
        method: "GET",
        headers: { apiKey, "Content-Type": "application/json" },
      },
      timeoutMs: 15_000,
    });
    try {
      if (!r.ok) {
        return { valid: false, error: r.status === 403 ? "Invalid API key" : `HTTP ${r.status}` };
      }
      const d = (await r.json()) as { success?: boolean; result?: { email?: string } };
      if (!d.success) {
        return { valid: false, error: "API returned unsuccessful response" };
      }
      return { valid: true, email: d.result?.email?.trim() };
    } finally {
      await release();
    }
  } catch (err) {
    return {
      valid: false,
      error: `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Local proxy for RouteLLM response normalization
// ---------------------------------------------------------------------------
// RouteLLM responses are missing `id` and `object` fields that OpenAI SDK expects.
// This proxy adds those fields to ensure compatibility.

let proxyServer: ReturnType<typeof createServer> | null = null;
let proxyApiKey = "";
let activeProxyRequests = 0;
let proxyShuttingDown = false;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJsonResponse(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function generateChunkId(): string {
  return `chatcmpl-${crypto.randomUUID()}`;
}

/**
 * Normalize SSE chunk to add missing id and object fields,
 * and normalize any tool_calls in delta to standard OpenAI format.
 */
function normalizeSseChunk(line: string, chunkId: string): string {
  if (!line.startsWith("data: ") || line === "data: [DONE]") {
    return line;
  }
  try {
    const json = JSON.parse(line.slice(6)) as Record<string, unknown>;
    if (!("id" in json)) {
      json.id = chunkId;
    }
    if (!("object" in json)) {
      json.object = "chat.completion.chunk";
    }
    // Normalize tool_calls in streaming delta
    if (Array.isArray(json.choices)) {
      json.choices = (json.choices as unknown[]).map((c) => {
        if (!c || typeof c !== "object") return c;
        const choice = c as Record<string, unknown>;
        const delta = choice.delta;
        if (delta && typeof delta === "object") {
          const d = delta as Record<string, unknown>;
          if (Array.isArray(d.tool_calls)) {
            d.tool_calls = (d.tool_calls as unknown[]).map((tc) => {
              if (!tc || typeof tc !== "object") return tc;
              const call = tc as Record<string, unknown>;
              // If flat format (name at top level, no function), convert
              if (call.name && !call.function) {
                const args = call.arguments ?? call.parameters ?? "";
                return {
                  index: call.index,
                  id: call.id ?? call.call_id ?? `call_${crypto.randomUUID()}`,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: typeof args === "string" ? args : JSON.stringify(args),
                  },
                };
              }
              return call;
            });
          }
        }
        return choice;
      });
    }
    return `data: ${JSON.stringify(json)}`;
  } catch {
    return line;
  }
}

/**
 * Keywords not supported by AbacusAI RouteLLM that must be removed from schemas
 */
const UNSUPPORTED_SCHEMA_KEYWORDS = [
  "patternProperties",
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "if",
  "then",
  "else",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "contentMediaType",
  "contentEncoding",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$comment",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependentRequired",
  "dependentSchemas",
  "propertyNames",
  "contains",
  "minContains",
  "maxContains",
  "prefixItems",
];

/**
 * Recursively clean a JSON schema by removing unsupported keywords
 * and ensuring additionalProperties: false is set
 */
function cleanSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }

  const obj = schema as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Skip unsupported keywords
    if (UNSUPPORTED_SCHEMA_KEYWORDS.includes(key)) {
      continue;
    }

    // Recursively clean nested objects
    if (key === "properties" && value && typeof value === "object") {
      const props: Record<string, unknown> = {};
      for (const [propKey, propValue] of Object.entries(value as Record<string, unknown>)) {
        props[propKey] = cleanSchema(propValue);
      }
      cleaned[key] = props;
    } else if (key === "items" && value && typeof value === "object") {
      cleaned[key] = cleanSchema(value);
    } else if (key === "additionalProperties" && value && typeof value === "object") {
      cleaned[key] = cleanSchema(value);
    } else {
      cleaned[key] = value;
    }
  }

  // Ensure additionalProperties: false for object types
  if (obj.type === "object" && !("additionalProperties" in cleaned)) {
    cleaned.additionalProperties = false;
  }

  return cleaned;
}

/**
 * Strip `strict` field from tools, clean schemas, and promote name/parameters
 * to the top level of each tool object for RouteLLM compatibility.
 * RouteLLM expects `name` and `parameters` accessible at the tool level,
 * not only nested under `function`.
 */
function normalizeToolsForRouteLLM(tools: unknown[]): unknown[] {
  return tools.map((t) => {
    if (!t || typeof t !== "object") {
      return t;
    }
    const copy = { ...(t as Record<string, unknown>) };
    delete copy.strict;

    if (copy.function && typeof copy.function === "object") {
      const fn = { ...(copy.function as Record<string, unknown>) };
      delete fn.strict;

      // Clean the parameters schema
      if (fn.parameters && typeof fn.parameters === "object") {
        fn.parameters = cleanSchema(fn.parameters);
      }

      // RouteLLM REQUIRES every tool to have a `parameters` field.
      // If a tool has no parameters (e.g. cognitive_assess, flare_plan),
      // add a default empty object schema.
      if (!fn.parameters) {
        fn.parameters = { type: "object", properties: {} };
      }

      copy.function = fn;

      // Promote name and parameters to top level for RouteLLM
      if (fn.name && !copy.name) {
        copy.name = fn.name;
      }
      if (fn.parameters !== undefined && copy.parameters === undefined) {
        copy.parameters = fn.parameters;
      }
      if (fn.description && !copy.description) {
        copy.description = fn.description;
      }
    }

    return copy;
  });
}

/**
 * Normalize tool_calls in request messages for RouteLLM.
 * RouteLLM expects `name` and `parameters` at the top level of each tool_call,
 * but OpenClaw sends them nested under `function` (OpenAI standard format).
 */
function normalizeMessagesForRouteLLM(messages: unknown[]): unknown[] {
  return messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    const m = msg as Record<string, unknown>;

    // Handle assistant tool calls
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) return msg;

    const normalized = { ...m };
    normalized.tool_calls = (m.tool_calls as unknown[]).map((tc) => {
      if (!tc || typeof tc !== "object") return tc;
      const call = { ...(tc as Record<string, unknown>) };

      // Extract name from function.name if not already at top level
      if (!call.name && call.function && typeof call.function === "object") {
        const fn = call.function as Record<string, unknown>;
        call.name = fn.name;
      }

      // Extract parameters from function.arguments if not already at top level
      if (call.parameters === undefined && call.function && typeof call.function === "object") {
        const fn = call.function as Record<string, unknown>;
        const args = fn.arguments;
        if (typeof args === "string") {
          try { call.parameters = JSON.parse(args); } catch { call.parameters = args; }
        } else if (args !== undefined) {
          call.parameters = args;
        }
      }

      return call;
    });
    return normalized;
  });
}

/**
 * Flatten multi-turn conversation history for OpenAI models routed via RouteLLM.
 *
 * ROOT CAUSE:  RouteLLM internally converts Chat Completions → OpenAI Responses
 * API for newer OpenAI models (GPT-4o, GPT-5, o-series, etc.).  Its converter
 * incorrectly maps ALL message content blocks to `type: "input_text"`, but
 * OpenAI's Responses API requires `type: "output_text"` for assistant/model
 * output messages.  This causes HTTP 400 on ANY multi-turn conversation.
 *
 * WORKAROUND:  Embed the entire conversation history as plain text inside the
 * system prompt, so the final payload contains ONLY `system` + `user` messages.
 * With no `role: "assistant"` messages, RouteLLM's converter never produces the
 * invalid `output_text` blocks.  The model's current-turn tool definitions
 * remain intact.
 *
 * This is only applied to OpenAI models; other providers (Claude, Gemini, etc.)
 * pass through unchanged.
 */
function flattenHistoryForOpenAIModels(messages: unknown[], model: string): unknown[] {
  // Only apply to OpenAI models that hit the Responses API path in RouteLLM
  const isOpenAIModel = /^(gpt-|o1-|o3-|o4-|chatgpt-)/i.test(model);
  if (!isOpenAIModel) return messages;

  const msgs = messages as Array<Record<string, unknown>>;

  // Separate system messages from conversation
  const systemMsgs = msgs.filter((m) => m.role === "system");
  const convMsgs = msgs.filter((m) => m.role !== "system");

  // If there are no assistant messages, nothing to flatten
  const hasAssistant = convMsgs.some((m) => m.role === "assistant");
  if (!hasAssistant) return messages;

  // Find the LAST user message – this becomes the sole user message
  let lastUserIdx = -1;
  for (let i = convMsgs.length - 1; i >= 0; i--) {
    if (convMsgs[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return messages; // No user message, pass through

  // Build textual history from all messages BEFORE the last user message
  const historyParts: string[] = [];
  for (let i = 0; i < lastUserIdx; i++) {
    const m = convMsgs[i];
    const role = m.role === "assistant" ? "Assistant" : m.role === "tool" ? "Tool-Result" : "User";
    let content: string;
    if (typeof m.content === "string") {
      content = m.content;
    } else if (m.content) {
      content = JSON.stringify(m.content);
    } else if (Array.isArray(m.tool_calls)) {
      const calls = (m.tool_calls as Array<Record<string, unknown>>).map((tc) => {
        const fn = tc.function as Record<string, unknown> | undefined;
        return fn ? `${fn.name}(${fn.arguments || "{}"})` : JSON.stringify(tc);
      });
      content = `[Called tools: ${calls.join(", ")}]`;
    } else {
      content = "(empty)";
    }
    // Truncate very long messages
    if (content.length > 3000) {
      content = content.slice(0, 3000) + "... [truncated]";
    }
    historyParts.push(`${role}: ${content}`);
  }

  // Build the flattened system prompt
  const originalSystem = systemMsgs.map((m) =>
    typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")
  ).join("\n\n");

  const historyBlock = historyParts.length > 0
    ? "\n\n<conversation_history>\n" + historyParts.join("\n\n") + "\n</conversation_history>"
    : "";

  const lastUserContent = typeof convMsgs[lastUserIdx].content === "string"
    ? convMsgs[lastUserIdx].content as string
    : JSON.stringify(convMsgs[lastUserIdx].content ?? "");

  return [
    { role: "system", content: originalSystem + historyBlock },
    { role: "user", content: lastUserContent },
  ];
}

/**
 * Normalize a single tool_call from RouteLLM response to OpenAI standard format.
 * RouteLLM may return tool_calls with flat `name`/`parameters` instead of nested `function`.
 */
function normalizeResponseToolCall(tc: Record<string, unknown>): Record<string, unknown> {
  // Already in standard format
  if (tc.function && typeof tc.function === "object") {
    return tc;
  }
  // Flat format: { name, parameters/arguments } → { function: { name, arguments } }
  if (tc.name) {
    const args = tc.arguments ?? tc.parameters ?? "{}";
    const argsStr = typeof args === "string" ? args : JSON.stringify(args);
    return {
      id: tc.id ?? tc.call_id ?? `call_${crypto.randomUUID()}`,
      type: "function",
      function: { name: tc.name, arguments: argsStr },
    };
  }
  return tc;
}

/**
 * Normalize tool_calls in a parsed response JSON (non-streaming).
 */
function normalizeResponseToolCalls(json: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(json.choices)) return json;
  json.choices = (json.choices as unknown[]).map((c) => {
    if (!c || typeof c !== "object") return c;
    const choice = { ...(c as Record<string, unknown>) };
    const message = choice.message;
    if (message && typeof message === "object") {
      const msg = { ...(message as Record<string, unknown>) };
      if (Array.isArray(msg.tool_calls)) {
        msg.tool_calls = (msg.tool_calls as unknown[]).map((tc) =>
          tc && typeof tc === "object" ? normalizeResponseToolCall(tc as Record<string, unknown>) : tc
        );
      }
      choice.message = msg;
    }
    return choice;
  });
  return json;
}

async function handleProxyRequest(req: IncomingMessage, res: ServerResponse) {
  if (proxyShuttingDown) {
    sendJsonResponse(res, 503, { error: { message: "Proxy is shutting down", type: "service_unavailable" } });
    return;
  }
  activeProxyRequests++;
  try {
    await handleProxyRequestInner(req, res);
  } finally {
    activeProxyRequests--;
  }
}

async function handleProxyRequestInner(req: IncomingMessage, res: ServerResponse) {
  const path = req.url ?? "/";

  if (path === "/__kill") {
    console.log("[abacusai] Received /__kill command, stopping zombie proxy...");
    sendJsonResponse(res, 200, { success: true });
    // Execute stop proxy asynchronously after sending response
    setTimeout(() => {
      stopProxy().catch(() => process.exit(0));
    }, 100);
    return;
  }

  let targetPath = path === "/" ? "" : path;
  if (targetPath.startsWith("/v1/")) {
    targetPath = targetPath.slice(3); // e.g., "/v1/models" -> "/models"
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${proxyApiKey}`,
    "Content-Type": "application/json",
  };

  // Intercept /models requests to return standard OpenAI format
  if (targetPath === "/models") {
    try {
      const { response: upstream, release } = await fetchWithSsrFGuard({
        url: `${ROUTELLM_BASE}/models`,
        init: { method: "GET", headers },
        timeoutMs: 30_000,
      });
      const data = await upstream.text();
      await release();

      let json;
      try {
        json = JSON.parse(data);
      } catch (e) {
        sendJsonResponse(res, 500, { error: { message: "Invalid JSON from RouteLLM /models" } });
        return;
      }

      // Ensure it has { object: "list", data: [...] } where each model has { object: "model" }
      const models = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
      const normalizedModels = models.map((m: any) => ({
        ...m,
        object: "model"
      }));

      sendJsonResponse(res, 200, {
        object: "list",
        data: normalizedModels
      });
    } catch (err: any) {
      sendJsonResponse(res, 500, { error: { message: `Failed to fetch models: ${err.message}` } });
    }
    return;
  }

   const target = `${ROUTELLM_BASE}${targetPath}`;
  let body: string | undefined;
  if (req.method === "POST") {
    const raw = await readBody(req);
    const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
    // Normalize tools for RouteLLM: remove `strict` field, clean schemas
    // (remove patternProperties, add additionalProperties: false, etc.)

    // Log the request for debugging
    try {
      const logEntry = `[${new Date().toISOString()}] ${req.method} ${targetPath} model=${parsed.model || "?"}\n`;
      appendFileSync("C:/tmp/proxy-requests.log", logEntry);
    } catch (e) { /* ignore */ }

    if (Array.isArray(parsed.tools)) {
      parsed.tools = normalizeToolsForRouteLLM(parsed.tools);
    }
    // Normalize tool_calls in messages: add top-level name/parameters for RouteLLM
    if (Array.isArray(parsed.messages)) {
      // Log message roles BEFORE transformation
      const rolesBefore = (parsed.messages as any[]).map((m: any) => m?.role || "?").join(",");
      
      parsed.messages = normalizeMessagesForRouteLLM(parsed.messages);
      // Flatten conversation history for OpenAI models to work around
      // RouteLLM's buggy Chat Completions → Responses API converter
      const modelName = typeof parsed.model === "string" ? parsed.model : "";
      parsed.messages = flattenHistoryForOpenAIModels(parsed.messages as unknown[], modelName);
      
      // Log message roles AFTER transformation
      const rolesAfter = (parsed.messages as any[]).map((m: any) => m?.role || "?").join(",");
      const hasAssistant = (parsed.messages as any[]).some((m: any) => m?.role === "assistant");
      try {
        appendFileSync("C:/tmp/proxy-requests.log",
          `  BEFORE: ${rolesBefore}\n  AFTER:  ${rolesAfter}\n  hasAssistant=${hasAssistant} model=${modelName}\n`);
      } catch (e) { /* ignore */ }
    }
    body = JSON.stringify(parsed);
  }

  const { response: upstream, release } = await fetchWithSsrFGuard({
    url: target,
    init: {
      method: req.method ?? "GET",
      headers: body ? headers : { Authorization: headers.Authorization },
      body: body ?? undefined,
    },
    timeoutMs: 180_000,
  });

  // Detect expired/revoked API key at runtime
  if (upstream.status === 401 || upstream.status === 403) {
    const errBody = await upstream.text().catch(() => "");
    await release();
    console.error(
      `[abacusai] Upstream returned ${upstream.status} — API key may be expired or revoked.`,
    );
    sendJsonResponse(res, upstream.status, {
      error: {
        message: `AbacusAI API key expired or invalid (HTTP ${upstream.status}).`,
        type: "auth_expired",
        upstream_body: errBody.slice(0, 500),
      },
    });
    return;
  }

  const ct = upstream.headers.get("content-type") ?? "application/json";
  const chunkId = generateChunkId();

  // Stream SSE response with normalization
  if (ct.includes("text/event-stream") && upstream.body) {
    res.writeHead(upstream.status, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const pump = async () => {
      for (; ;) {
        const { done, value } = await reader.read();
        if (done) {
          // Process any remaining buffer
          if (buffer.trim()) {
            const normalized = normalizeSseChunk(buffer.trim(), chunkId);
            res.write(normalized + "\n\n");
          }
          res.end();
          await release();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) {
            const normalized = normalizeSseChunk(line, chunkId);
            res.write(normalized + "\n");
          } else {
            res.write("\n");
          }
        }
      }
    };
    pump().catch(async () => {
      res.end();
      await release();
    });
  } else {
    // Non-streaming response - add id and object fields, normalize tool_calls
    const data = await upstream.text();
    await release();
    try {
      let json = JSON.parse(data) as Record<string, unknown>;
      if (!("id" in json)) {
        json.id = chunkId;
      }
      if (!("object" in json)) {
        json.object = "chat.completion";
      }
      // Normalize tool_calls to standard OpenAI format
      json = normalizeResponseToolCalls(json);
      res.writeHead(upstream.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    } catch {
      res.writeHead(upstream.status, { "Content-Type": ct });
      res.end(data);
    }
  }
}

function startProxy(apiKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (proxyServer) {
      proxyApiKey = apiKey;
      resolve();
      return;
    }
    proxyApiKey = apiKey;
    proxyServer = createServer((req, res) => {
      handleProxyRequest(req, res).catch((err) => {
        console.error("[abacusai] proxy error:", err);
        sendJsonResponse(res, 500, { error: { message: String(err) } });
      });
    });

    let killAttempts = 0;
    const tryListen = (port: number) => {
      proxyServer!.listen(port, PROXY_HOST, () => {
        proxyPort = port;
        console.log(`[abacusai] proxy listening on http://${PROXY_HOST}:${proxyPort}`);
        resolve();
      });
      proxyServer!.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.log(`[abacusai] port ${port} in use. Attempting to kill zombie proxy...`);
          killAttempts++;
          if (killAttempts > 5) {
            console.error("[abacusai] Could not kill zombie proxy after multiple attempts.");
            reject(new Error("EADDRINUSE on port 18862 and cannot kill zombie proxy."));
            return;
          }
          proxyServer!.removeAllListeners("error");

          // Try to kill the zombie proxy by sending it the /__kill command
          const { request } = require("node:http");
          const req = request(`http://${PROXY_HOST}:${port}/__kill`, { method: 'GET' }, (res: IncomingMessage) => {
            res.resume();
          });
          req.on('error', () => { }); // Ignore network errors
          req.end();

          console.log(`[abacusai] Waiting 1s for port ${port} to free up...`);
          setTimeout(() => {
            // Create fresh proxyServer to avoid closed state issues
            proxyServer = createServer((req, res) => {
              handleProxyRequest(req, res).catch((e) => {
                console.error("[abacusai] proxy error:", e);
                sendJsonResponse(res, 500, { error: { message: String(e) } });
              });
            });
            tryListen(port);
          }, 1000);
        } else {
          reject(err);
        }
      });
    };

    tryListen(PROXY_PORT_DEFAULT);
  });
}

/**
 * Gracefully stop the RouteLLM proxy server.
 * 1. Stop accepting new connections
 * 2. Wait for all in-flight requests to complete (up to 10s timeout)
 * 3. Close the server and release the port
 */
function stopProxy(): Promise<void> {
  return new Promise((resolve) => {
    if (!proxyServer) {
      resolve();
      return;
    }

    proxyShuttingDown = true;
    console.log(`[abacusai] Proxy shutting down (${activeProxyRequests} active requests)...`);

    // Stop accepting new connections immediately
    proxyServer.close(() => {
      console.log("[abacusai] Proxy server closed, port released.");
      proxyServer = null;
      proxyShuttingDown = false;
      activeProxyRequests = 0;
      resolve();
    });

    // Force-close after 10s if requests don't drain
    const forceTimeout = setTimeout(() => {
      console.warn(`[abacusai] Force-closing proxy (${activeProxyRequests} requests still active after 10s).`);
      proxyServer?.closeAllConnections?.();
    }, 10_000);

    // Poll for active requests to finish, resolve early if all done
    const drainInterval = setInterval(() => {
      if (activeProxyRequests <= 0) {
        clearInterval(drainInterval);
        clearTimeout(forceTimeout);
        // server.close callback will resolve
      }
    }, 200);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseModelIds(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(/[\n,]/)
        .map((m) => m.trim())
        .filter(Boolean),
    ),
  );
}

function buildModelDefinition(modelId: string) {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

// ---------------------------------------------------------------------------
// Dynamic baseUrl updater — keep config in sync with current proxy port
// ---------------------------------------------------------------------------

/**
 * Update the `models.providers.abacusai.baseUrl` in openclaw.json to match
 * the current proxy port. This is necessary because the proxy uses port 0
 * (OS-assigned random port) and gets a new port every time the gateway starts,
 * but the config still stores the port from when `openclaw models auth login`
 * was first run.
 */
function updateBaseUrlInConfig(pluginApi: any): void {
  if (!proxyPort) return;
  const newBaseUrl = `http://${PROXY_HOST}:${proxyPort}`;
  try {
    const stateDir =
      process.env.OPENCLAW_STATE_DIR ||
      process.env.CLAWDBOT_STATE_DIR ||
      join(homedir(), ".openclaw");
    const configPath = join(stateDir, "openclaw.json");

    // 1. Update in-memory OpenClaw config if available (so it works immediately and saves correctly)
    let inMemoryUpdated = false;
    if (pluginApi?.config?.models?.providers?.abacusai) {
      if (pluginApi.config.models.providers.abacusai.baseUrl !== newBaseUrl) {
        pluginApi.config.models.providers.abacusai.baseUrl = newBaseUrl;
        inMemoryUpdated = true;
      }
    }

    // 2. Fallback to writing the disk file directly if needed
    if (existsSync(configPath)) {
      let raw = readFileSync(configPath, "utf-8");
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      const config = JSON.parse(raw);
      const currentUrl = config?.models?.providers?.abacusai?.baseUrl;

      if (currentUrl !== newBaseUrl && config.models?.providers?.abacusai) {
        config.models.providers.abacusai.baseUrl = newBaseUrl;
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
        console.log(`[abacusai] Updated config baseUrl on disk: ${currentUrl} → ${newBaseUrl}`);
      } else if (inMemoryUpdated) {
        console.log(`[abacusai] Updated in-memory baseUrl to ${newBaseUrl}`);
      }
    }
  } catch (err) {
    console.error("[abacusai] Failed to update baseUrl in config:", err);
  }
}

// ---------------------------------------------------------------------------
// Dynamic Model Updater
// ---------------------------------------------------------------------------

async function updateRouteLlmModels(pluginApi: any): Promise<string> {
  try {
    const res = await fetch("https://routellm.abacus.ai/v1/models");
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`);
    }
    const data = await res.json();
    if (!data.data || !Array.isArray(data.data)) {
      throw new Error("Invalid response format from RouteLLM");
    }

    const fetchedModelIds = data.data.map((m: any) => m.id);
    const newModels = fetchedModelIds.map(buildModelDefinition);

    // 1. Update in-memory configuration
    if (pluginApi.config?.models?.providers?.abacusai) {
      pluginApi.config.models.providers.abacusai.models = newModels;
    }

    // 2. Persist to openclaw.json
    const stateDir = process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
    const configPath = join(stateDir, "openclaw.json");
    if (existsSync(configPath)) {
      const configStr = readFileSync(configPath, "utf8");
      const configObj = JSON.parse(configStr);
      let updatedConfig = false;

      if (configObj.models?.providers?.abacusai) {
        configObj.models.providers.abacusai.models = newModels;
        updatedConfig = true;
      }

      // Sync with agents.defaults.models so they appear in chat dropdown immediately
      if (configObj.agents?.defaults) {
        if (!configObj.agents.defaults.models) {
          configObj.agents.defaults.models = {};
        }

        const prefixedFetchedIds = fetchedModelIds.map((id: string) => `abacusai/${id}`);

        // 2a. Purge outdated models
        const existingAgentModels = Object.keys(configObj.agents.defaults.models);
        for (const modelId of existingAgentModels) {
          if (modelId.startsWith("abacusai/") && !prefixedFetchedIds.includes(modelId)) {
            delete configObj.agents.defaults.models[modelId];
            updatedConfig = true;
          }
        }

        // 2b. Add new models
        for (const modelId of prefixedFetchedIds) {
          if (!configObj.agents.defaults.models[modelId]) {
            configObj.agents.defaults.models[modelId] = {};
            updatedConfig = true;
          }
        }
      }

      if (updatedConfig) {
        writeFileSync(configPath, JSON.stringify(configObj, null, 2), "utf8");

        // Tell OpenClaw to hot-reload the configuration so the model list reflects in the UI 
        if (typeof (pluginApi as any).reloadConfig === "function") {
          (pluginApi as any).reloadConfig();
        }
      }
    }
    return `✅ Successfully fetched and updated ${newModels.length} models from AbacusAI RouteLLM.`;
  } catch (err: any) {
    console.error("[abacusai] Failed to update models:", err);
    return `❌ Failed to update models: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Plugin Entry Point
// ---------------------------------------------------------------------------

// Type definitions for plugin API
interface PluginPrompter {
  progress: (msg: string) => { update: (msg: string) => void; stop: (msg: string) => void };
  confirm: (opts: { message: string; initialValue: boolean }) => Promise<boolean>;
  text: (opts: {
    message: string;
    placeholder?: string;
    initialValue?: string;
    validate?: (v: string) => string | undefined;
  }) => Promise<string>;
}

interface PluginAuthContext {
  prompter: PluginPrompter;
}

const abacusaiPlugin = {
  id: "openclaw-abacusai-auth",
  name: "AbacusAI Auth",
  description: "AbacusAI RouteLLM provider plugin with direct connection and schema normalization",
  configSchema: emptyPluginConfigSchema(),
  register(api: unknown) {
    const pluginApi = api as {
      registerProvider: (config: unknown) => void;
      registerHook?: (events: string | string[], handler: Function, opts?: { name?: string }) => void;
      config?: {
        models?: { providers?: { abacusai?: { compat?: { supportsStrictMode?: boolean } } } };
      };
      registerCommand?: (command: { name: string; description: string; handler: Function; execute?: Function }) => void;
    };

    // ================================================================
    // Register gateway_stop hook for graceful proxy shutdown
    // ================================================================
    if (typeof pluginApi.registerHook === "function") {
      pluginApi.registerHook("gateway_stop", async () => {
        console.log("[abacusai] gateway_stop hook triggered, stopping proxy gracefully...");
        await stopProxy();
      });
    }

    // ================================================================
    // Register chat command for updating models
    // ================================================================
    if (typeof pluginApi.registerCommand === "function") {
      try {
        pluginApi.registerCommand({
          name: "abacusai",
          description: "AbacusAI utilities (e.g. /abacusai pull-models)",
          // OpenClaw SDK typically accepts a handler function for the command
          handler: async (ctx: any) => {
            // Fallback string matching to capture args
            const contentStr = (ctx?.content || "").trim();
            const argsStr = ctx?.args ? ctx.args.join(" ") : contentStr;
            const isPull = argsStr === "pull-models" || argsStr === "" || argsStr.includes("pull-models");

            // Dump api keys for debugging
            try {
              writeFileSync("C:/tmp/api-keys.txt", Object.keys(pluginApi).join(", "), "utf8");
            } catch (e) { }

            if (isPull) {
              const res = await updateRouteLlmModels(pluginApi);
              try { appendFileSync("C:/tmp/abacus-update.log", res + "\n"); } catch (e) { }
              return { text: res };
            }
            return { text: `Unknown subcommand: ${argsStr}. Usage: /abacusai pull-models` };
          },
          // Just in case it's named 'execute' or 'run' in different SDK versions
          execute: async (ctx: any) => {
            const contentStr = (ctx?.content || "").trim();
            const argsStr = ctx?.args ? ctx.args.join(" ") : contentStr;
            const isPull = argsStr === "pull-models" || argsStr === "" || argsStr.includes("pull-models");

            if (isPull) {
              const res = await updateRouteLlmModels(pluginApi);
              try { appendFileSync("C:/tmp/abacus-update.log", res + "\n"); } catch (e) { }
              return { text: res };
            }
            return { text: `Unknown subcommand: ${argsStr}. Usage: /abacusai pull-models` };
          }
        });
      } catch (e) {
        console.error("[abacusai] Error registering command:", e);
      }
    }

    // ================================================================
    // Process signal handlers for fallback proxy shutdown
    // ================================================================
    const shutdownHandler = () => {
      stopProxy().then(() => process.exit(0));
    };
    process.once("SIGTERM", shutdownHandler);
    process.once("SIGINT", shutdownHandler);

    // Use local proxy mode to handle schema cleaning internally
    // This is required because OpenClaw core may not support requiresCleanSchema yet
    // The proxy normalizes tool schemas before forwarding to RouteLLM

    // Auto-start proxy if we have a saved API key
    const savedKey = tryRecoverApiKey();
    if (savedKey) {
      startProxy(savedKey)
        .then(() => {
          // Update baseUrl in config to match the new proxy port
          // (The proxy gets a new random port each time the gateway starts,
          // but the config still has the port from when auth was first run)
          updateBaseUrlInConfig(pluginApi);
        })
        .catch((err) => {
          console.error("[abacusai] Failed to auto-start proxy:", err);
        });
    }

    pluginApi.registerProvider({
      id: "abacusai",
      label: "AbacusAI",
      docsPath: "/providers/models",
      aliases: ["abacus", "abacus-ai", "abacusai-code-mode"],
      envVars: ["ABACUSAI_API_KEY"],
      auth: [
        {
          id: "api-key",
          label: "AbacusAI API key",
          hint: "Enter your AbacusAI API key or auto-detect from Code Mode",
          kind: "custom",
          run: async (ctx: PluginAuthContext) => {
            const spin = ctx.prompter.progress("Setting up AbacusAI…");

            try {
              // --- Credential resolution (3-tier) ---
              const localKey = tryReadLocalCredential();
              let apiKey = "";

              if (localKey) {
                spin.update("Found local AbacusAI credentials…");
                const useLocal = await ctx.prompter.confirm({
                  message: `Found AbacusAI credentials locally (${localKey.slice(0, 8)}…). Use them?`,
                  initialValue: true,
                });
                if (useLocal) {
                  apiKey = localKey;
                }
              }

              if (!apiKey) {
                const envKey = process.env.ABACUSAI_API_KEY?.trim();
                if (envKey) {
                  spin.update("Found ABACUSAI_API_KEY environment variable…");
                  const useEnv = await ctx.prompter.confirm({
                    message: "Found ABACUSAI_API_KEY in environment. Use it?",
                    initialValue: true,
                  });
                  if (useEnv) {
                    apiKey = envKey;
                  }
                }
              }

              if (!apiKey) {
                const input = await ctx.prompter.text({
                  message: "AbacusAI API key",
                  placeholder: "Paste your API key from https://abacus.ai/app/profile/apikey",
                  validate: (value: string) => {
                    const t = value.trim();
                    if (!t) {
                      return "API key is required";
                    }
                    if (t.length < 10) {
                      return "API key looks too short";
                    }
                    return undefined;
                  },
                });
                apiKey = String(input).trim();
              }

              if (!apiKey) {
                throw new Error("No API key provided");
              }

              // --- Validate ---
              spin.update("Validating API key…");
              const validation = await validateApiKey(apiKey);
              if (!validation.valid) {
                spin.stop("API key validation failed");
                const saveAnyway = await ctx.prompter.confirm({
                  message: `Validation failed: ${validation.error}\nSave this key anyway? (You can re-authenticate later)`,
                  initialValue: false,
                });
                if (!saveAnyway) {
                  throw new Error("Aborted: API key validation failed");
                }
              }

              // --- Start local proxy for schema normalization ---
              spin.update("Starting local proxy for schema normalization…");
              await startProxy(apiKey);

              // --- Model selection ---
              const modelInput = await ctx.prompter.text({
                message: "Model IDs (comma-separated)",
                initialValue: DEFAULT_MODEL_IDS.join(", "),
                validate: (v: string) =>
                  parseModelIds(v).length > 0 ? undefined : "Enter at least one model id",
              });
              const modelIds = parseModelIds(modelInput);
              const defaultModelId = modelIds[0] ?? DEFAULT_MODEL_IDS[0];
              const defaultModelRef = `abacusai/${defaultModelId}`;

              const profileId = `abacusai:${validation.email ?? "default"}`;
              spin.stop("AbacusAI configured");

              return {
                profiles: [
                  {
                    profileId,
                    credential: {
                      type: "api_key",
                      provider: "abacusai",
                      key: apiKey,
                      ...(validation.email ? { email: validation.email } : {}),
                    },
                  },
                ],
                configPatch: {
                  models: {
                    providers: {
                      abacusai: {
                        // Use local proxy for schema normalization
                        // The proxy handles: removing `strict`, `patternProperties`,
                        // and adding `additionalProperties: false`
                        baseUrl: `http://${PROXY_HOST}:${proxyPort}`,
                        api: "openai-completions",
                        apiKey: "abacusai-proxy",
                        models: modelIds.map((id) => buildModelDefinition(id)),
                      },
                    },
                  },
                  agents: {
                    defaults: {
                      models: Object.fromEntries(modelIds.map((id) => [`abacusai/${id}`, {}])),
                    },
                  },
                },
                defaultModel: defaultModelRef,
                notes: [
                  "Local proxy mode: schema normalization handled by plugin proxy.",
                  "Proxy uses dynamic port and forwards to RouteLLM.",
                  "Full OpenAI function-calling support is enabled.",
                  "Manage your API keys at https://abacus.ai/app/profile/apikey",
                ],
              };
            } catch (err) {
              spin.stop("AbacusAI setup failed");
              throw err;
            }
          },
        },
      ],
    });
  },
};

export default abacusaiPlugin;

