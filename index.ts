import { readFileSync, readdirSync } from "node:fs";
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
const PROXY_PORT = 18790;
const PROXY_HOST = "127.0.0.1";

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
 * Normalize SSE chunk to add missing id and object fields
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
    return `data: ${JSON.stringify(json)}`;
  } catch {
    return line;
  }
}

/**
 * Strip `strict` field from tools - RouteLLM doesn't support it
 */
function stripStrictFromTools(tools: unknown[]): unknown[] {
  return tools.map((t) => {
    if (!t || typeof t !== "object") {
      return t;
    }
    const copy = { ...(t as Record<string, unknown>) };
    delete copy.strict;
    if (copy.function && typeof copy.function === "object") {
      const fn = { ...(copy.function as Record<string, unknown>) };
      delete fn.strict;
      copy.function = fn;
    }
    return copy;
  });
}

async function handleProxyRequest(req: IncomingMessage, res: ServerResponse) {
  const path = req.url ?? "/";
  const target = `${ROUTELLM_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${proxyApiKey}`,
    "Content-Type": "application/json",
  };

  let body: string | undefined;
  if (req.method === "POST") {
    const raw = await readBody(req);
    const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
    // Strip `strict` field from tools - RouteLLM doesn't support it
    if (Array.isArray(parsed.tools)) {
      parsed.tools = stripStrictFromTools(parsed.tools);
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
      for (;;) {
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
    // Non-streaming response - add id and object fields
    const data = await upstream.text();
    await release();
    try {
      const json = JSON.parse(data) as Record<string, unknown>;
      if (!("id" in json)) {
        json.id = chunkId;
      }
      if (!("object" in json)) {
        json.object = "chat.completion";
      }
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
    proxyServer.listen(PROXY_PORT, PROXY_HOST, () => {
      console.log(`[abacusai] proxy listening on http://${PROXY_HOST}:${PROXY_PORT}`);
      resolve();
    });
    proxyServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Port already in use, assume proxy is already running
        proxyServer = null;
        resolve();
      } else {
        reject(err);
      }
    });
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
// Plugin
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
  id: "abacusai-auth",
  name: "AbacusAI Auth",
  description: "AbacusAI RouteLLM provider plugin with direct connection and schema normalization",
  configSchema: emptyPluginConfigSchema(),
  register(api: unknown) {
    const pluginApi = api as {
      registerProvider: (config: unknown) => void;
      config?: {
        models?: { providers?: { abacusai?: { compat?: { supportsStrictMode?: boolean } } } };
      };
    };

    // Direct connection mode - no proxy needed
    // Core code handles schema cleaning via requiresCleanSchema compat option

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
                        baseUrl: ROUTELLM_BASE,
                        api: "openai-completions",
                        auth: "token",
                        models: modelIds.map((id) => buildModelDefinition(id)),
                        compat: {
                          requiresAdditionalPropertiesFalse: true,
                          supportsStrictMode: false,
                          requiresCleanSchema: true,
                        },
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
                  "Direct connection to AbacusAI RouteLLM with schema normalization.",
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
