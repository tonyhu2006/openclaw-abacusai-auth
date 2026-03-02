# AbacusAI Auth (OpenClaw Plugin)

Third-party provider plugin that integrates **AbacusAI** models into OpenClaw via
**direct connection** to AbacusAI's **RouteLLM** endpoint. The plugin configures
core compatibility options (`requiresAdditionalPropertiesFalse`, `supportsStrictMode`)
so that the OpenClaw Agent can use AbacusAI-hosted models (Claude, Gemini, GPT,
DeepSeek, Qwen, Grok, Kimi, Llama, and more) with full **multi-tool calling** support.

| Field           | Value                                       |
| --------------- | ------------------------------------------- |
| **Package**     | `openclaw-abacusai-auth`                    |
| **Entry**       | `./index.ts`                                |
| **Provider ID** | `abacusai`                                  |
| **Aliases**     | `abacus`, `abacus-ai`, `abacusai-code-mode` |
| **API style**   | `openai-completions` (direct connection)    |
| **Upstream**    | `https://routellm.abacus.ai/v1`             |

---

## Installation

### Option 1: Install from npm (recommended)

```bash
openclaw plugins install openclaw-abacusai-auth
```

### Option 2: Manual installation

1. Clone this repository:
```bash
git clone https://github.com/tonyhu2006/openclaw-abacusai-auth.git ~/.openclaw/extensions/abacusai-auth
```

2. Install dependencies:
```bash
cd ~/.openclaw/extensions/abacusai-auth
npm install
```

3. Enable the plugin:
```bash
openclaw plugins enable abacusai-auth
```

---

## Quick Start

### 1. Authenticate

```bash
openclaw models auth login --provider abacusai --set-default
```

The interactive login flow will:

1. Attempt to **auto-detect** credentials from a local AbacusAI Code Mode installation.
2. Fall back to the `ABACUSAI_API_KEY` environment variable.
3. Prompt for **manual entry** if neither is found.
4. **Validate** the API key against `https://api.abacus.ai/api/v0/describeUser`.
5. Let you select which models to register (defaults to all supported models).
6. Write the provider config to `openclaw.json` with compat options.

### 2. Restart the Gateway

```bash
openclaw gateway run
```

### 3. Use AbacusAI models

```bash
openclaw send "Hello" --model abacusai/gemini-3-flash-preview
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  OpenClaw Agent (Pi Agent)                                       │
│  Sends standard OpenAI-compatible requests                       │
│  (POST /v1/chat/completions with tools[])                        │
└──────────────┬───────────────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────────┐
│  Local Proxy (http://127.0.0.1:<dynamic-port>)                   │
│                                                                  │
│  Schema Normalization:                                           │
│  1. Removes `strict` field from tool definitions                 │
│  2. Removes unsupported keywords (patternProperties, $ref, etc.) │
│  3. Adds `additionalProperties: false` to object schemas         │
│  4. Normalizes SSE responses (adds missing id/object fields)     │
└──────────────┬───────────────────────────────────────────────────┘
               │ https://routellm.abacus.ai/v1
               ▼
┌──────────────────────────────────────────────────────────────────┐
│  AbacusAI RouteLLM Endpoint                                      │
│  OpenAI-compatible API with function calling                     │
│  Routes to Claude, Gemini, GPT, DeepSeek, Llama, etc.           │
└──────────────────────────────────────────────────────────────────┘
```

**Security:** The local proxy uses a dynamic port assigned by the OS at startup,
avoiding port conflicts and improving security.

**Why a local proxy?** AbacusAI's RouteLLM is _mostly_ OpenAI-compatible but has
strict schema requirements that OpenClaw's default tool schemas don't meet:

1. Rejects the `strict` field in tool schemas
2. Rejects `patternProperties` and other advanced JSON Schema keywords
3. Requires `additionalProperties: false` in object schemas

The local proxy handles all schema normalization internally, making the plugin
fully self-contained and compatible with any OpenClaw version

---

## Supported Models

The following models are registered by default (verified February 2026):

| Model ID                      | Family               |
| ----------------------------- | -------------------- |
| `gemini-3-flash-preview`      | Google Gemini        |
| `gemini-3-pro-preview`        | Google Gemini        |
| `gemini-2.5-flash`            | Google Gemini        |
| `gemini-2.5-pro`              | Google Gemini        |
| `gpt-5.2`                     | OpenAI GPT           |
| `gpt-5.1`                     | OpenAI GPT           |
| `gpt-5-mini`                  | OpenAI GPT           |
| `claude-sonnet-4-5-20250929`  | Anthropic Claude     |
| `claude-opus-4-6`             | Anthropic Claude     |
| `claude-haiku-4-5-20251001`   | Anthropic Claude     |
| `deepseek-ai/DeepSeek-V3.2`   | DeepSeek             |
| `deepseek-ai/DeepSeek-R1`     | DeepSeek             |
| `kimi-k2.5`                   | Moonshot Kimi        |
| `qwen3-max`                   | Alibaba Qwen         |
| `grok-4-1-fast-non-reasoning` | xAI Grok             |
| `route-llm`                   | AbacusAI Auto-Router |

All models are configured with:

- **Context window**: 200,000 tokens
- **Max output tokens**: 8,192 tokens
- **Input modalities**: text, image
- **API**: `openai-completions`

You can customize the model list during the interactive login flow.

---

## Credential Resolution

The plugin resolves API keys using a multi-tier fallback strategy, checked in order:

### During Login (`openclaw models auth login`)

1. **Local AbacusAI Code Mode installation** — scans platform-specific paths:
   - **Windows**: `%APPDATA%\AbacusAI\User\globalStorage\credentials.json`,
     `%APPDATA%\AbacusAI Code Mode\User\globalStorage\credentials.json`,
     `%USERPROFILE%\.abacusai\credentials.json`, `%USERPROFILE%\.abacusai\config.json`
   - **macOS**: `~/Library/Application Support/AbacusAI/...`, `~/.abacusai/...`
   - **Linux**: `~/.config/AbacusAI/...`, `~/.abacusai/...`
   - Accepts fields: `apiKey`, `api_key`, `token`, `accessToken`, `access_token`
2. **Environment variable** — `ABACUSAI_API_KEY`
3. **Manual entry** — interactive prompt

---

## Core Compatibility Options

This plugin configures two core `ModelCompatConfig` options that are essential
for AbacusAI RouteLLM compatibility:

### `requiresAdditionalPropertiesFalse`

AbacusAI RouteLLM requires `additionalProperties: false` in tool parameter schemas.
When this option is set to `true`, the `normalizeToolParameters` function in
`pi-tools.schema.ts` sets `additionalProperties: false` instead of the default `true`.

### `supportsStrictMode`

AbacusAI RouteLLM rejects the `strict` field in tool definitions. When this option
is set to `false`, the pi-ai library omits the `strict` field from tool definitions.

### Provider Configuration

The plugin configures the AbacusAI provider to use the local proxy:

```json
{
  "baseUrl": "http://127.0.0.1:<dynamic-port>",
  "api": "openai-completions",
  "auth": "token",
  "compat": {
    "requiresAdditionalPropertiesFalse": true,
    "supportsStrictMode": false
  }
}
```

The local proxy automatically starts when the plugin loads with a dynamic port
assigned by the OS, and handles all schema normalization before forwarding
requests to `https://routellm.abacus.ai/v1`.

---

## Configuration Reference

After login, the plugin writes the following to `~/.openclaw/openclaw.json`:

```jsonc
{
  "models": {
    "providers": {
      "abacusai": {
        "baseUrl": "http://127.0.0.1:<dynamic-port>",
        "api": "openai-completions",
        "auth": "token",
        "compat": {
          "requiresAdditionalPropertiesFalse": true,
          "supportsStrictMode": false,
        },
        "models": [
          {
            "id": "gemini-3-flash-preview",
            "name": "gemini-3-flash-preview",
            "api": "openai-completions",
            "reasoning": false,
            "input": ["text", "image"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 200000,
            "maxTokens": 8192,
          },
          // ... other models
        ],
      },
    },
  },
}
```

Credentials are stored separately in `~/.openclaw/agents/<agent>/agent/auth-profiles.json`:

```jsonc
{
  "profiles": {
    "abacusai:<email-or-default>": {
      "type": "token",
      "provider": "abacusai",
      "token": "<api-key>",
    },
  },
}
```

### Environment Variables

| Variable             | Description                                                    |
| -------------------- | -------------------------------------------------------------- |
| `ABACUSAI_API_KEY`   | API key fallback (used if no saved profile is found)           |
| `OPENCLAW_STATE_DIR` | Override the OpenClaw state directory (default: `~/.openclaw`) |

---

## Troubleshooting

### Tool calling not working

If tool calls fail with schema-related errors, ensure the provider has the
correct compat options configured:

```json
"compat": {
  "requiresAdditionalPropertiesFalse": true,
  "supportsStrictMode": false
}
```

### API key validation failed

Your API key may have been revoked or expired. Generate a new one at
<https://abacus.ai/app/profile/apikey> and re-authenticate:

```bash
openclaw models auth login --provider abacusai --set-default
```

### Plugin not found

If AbacusAI models are not available, ensure the plugin is installed:

```bash
openclaw plugins install openclaw-abacusai-auth
```

---

## Getting an API Key

1. Sign in at <https://abacus.ai>
2. Navigate to **Profile → API Keys** (<https://abacus.ai/app/profile/apikey>)
3. Click **Generate new API Key**
4. Copy the key (starts with `s2_...`)

---

## File Structure

```
openclaw-abacusai-auth/
├── index.ts              # Plugin source (auth, credential detection, model definitions)
├── package.json          # Package metadata
├── openclaw.plugin.json  # Plugin manifest
└── README.md             # This file
```

## Key Constants

| Constant                 | Value                           | Description                            |
| ------------------------ | ------------------------------- | -------------------------------------- |
| `ROUTELLM_BASE`          | `https://routellm.abacus.ai/v1` | Upstream RouteLLM endpoint             |
| `ABACUS_API`             | `https://api.abacus.ai/api/v0`  | AbacusAI REST API (for key validation) |
| `DEFAULT_CONTEXT_WINDOW` | 200,000                         | Default context window for all models  |
| `DEFAULT_MAX_TOKENS`     | 8,192                           | Default max output tokens              |

---

## License

MIT

## Author

[tonyhu2006](https://github.com/tonyhu2006)

## Contributing

Issues and PRs welcome at <https://github.com/tonyhu2006/openclaw-abacusai-auth>
