#!/usr/bin/env node

/**
 * Anthropic -> OpenAI-compatible API Proxy
 *
 * Claude Code sends Anthropic Messages API requests; this proxy converts them
 * to provider-specific OpenAI-compatible chat/completions APIs.
 *
 * Claude Code usage:
 *   export ANTHROPIC_BASE_URL="http://localhost:<PORT>"
 *   export ANTHROPIC_API_KEY="<provider-api-key>"
 *   export ANTHROPIC_MODEL="claude-sonnet-4-5"
 *   claude
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

function loadEnv(filePath = path.join(__dirname, ".env")) {
  if (!fs.existsSync(filePath)) {
    console.warn(`[.env] ${filePath} not found, using environment variables only.`);
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
  console.log(`[.env] Loaded ${filePath}`);
}

loadEnv();

const PORT = Number(process.env.PORT || 3100);
const REQUESTED_DEFAULT_PROVIDER = (process.env.DEFAULT_PROVIDER || "opencode").toLowerCase();
const SETTINGS_PATH = path.join(__dirname, "settings.json");
const OPENCODE_API_URL = process.env.OPENCODE_API_URL || "https://opencode.ai/zen/go/v1";
const OPENCODE_API_KEY = process.env.OPENCODE_API_KEY || "";
const OPENROUTER_API_URL = process.env.OPENROUTER_API_URL || "https://openrouter.ai/api/v1";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL || "";
const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || "openai-cc-proxy";
const OPUS_MODEL = process.env.OPUS_MODEL || process.env.OPENCODE_OPUS_MODEL || process.env.OPENCODE_DEFAULT_MODEL || "opencode/glm-5.1";
const SONNET_MODEL = process.env.SONNET_MODEL || process.env.OPENCODE_SONNET_MODEL || process.env.OPENCODE_DEFAULT_MODEL || "opencode/kimi-k2.6";
const HAIKU_MODEL = process.env.HAIKU_MODEL || process.env.OPENCODE_HAIKU_MODEL || process.env.OPENCODE_SMALL_FAST_MODEL || "opencode/deepseek-v4-flash";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 600000);
const TOKEN_DEBUG = parseBoolEnv(process.env.TOKEN_DEBUG, false);
const TOOL_RESULT_MAX_CHARS = parseIntEnv(process.env.TOOL_RESULT_MAX_CHARS, 0);
const TOOL_RESULT_HEAD_LINES = parseIntEnv(process.env.TOOL_RESULT_HEAD_LINES, 80);
const TOOL_RESULT_TAIL_LINES = parseIntEnv(process.env.TOOL_RESULT_TAIL_LINES, 80);
const TOOL_RESULT_DEDUPE = parseBoolEnv(process.env.TOOL_RESULT_DEDUPE, false);
const TOOL_SCHEMA_STRIP_DESCRIPTIONS = parseBoolEnv(process.env.TOOL_SCHEMA_STRIP_DESCRIPTIONS, false);

function parseBoolEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function parseIntEnv(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function createProviderConfig(name, apiUrl, apiKey, extraHeaders = {}) {
  const url = new URL(apiUrl);
  return {
    name,
    apiKey,
    url,
    basePath: url.pathname.replace(/\/$/, ""),
    client: url.protocol === "http:" ? http : https,
    extraHeaders,
  };
}

function normalizeProviderName(name) {
  return String(name || "").trim().toLowerCase();
}

function loadSettingsProviders(filePath = SETTINGS_PATH) {
  if (!fs.existsSync(filePath)) return {};

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`[settings] Failed to parse ${filePath}: ${err.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`[settings] ${filePath} must contain an object keyed by provider name.`);
  }

  const providers = {};
  for (const [rawName, config] of Object.entries(parsed)) {
    const name = normalizeProviderName(rawName);
    if (!name) {
      console.warn(`[settings] Ignoring provider with empty name in ${filePath}`);
      continue;
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      console.warn(`[settings] Ignoring provider "${rawName}": config must be an object.`);
      continue;
    }
    if (!config.url || typeof config.url !== "string") {
      console.warn(`[settings] Ignoring provider "${rawName}": missing string url.`);
      continue;
    }

    const headers = config.headers && typeof config.headers === "object" && !Array.isArray(config.headers)
      ? config.headers
      : {};
    providers[name] = createProviderConfig(
      name,
      config.url,
      typeof config.token === "string" ? config.token : (typeof config.apiKey === "string" ? config.apiKey : ""),
      headers,
    );
  }

  console.log(`[settings] Loaded ${Object.keys(providers).length} provider(s) from ${filePath}`);
  return providers;
}

function buildProviders() {
  const legacyProviders = {
    opencode: createProviderConfig("opencode", OPENCODE_API_URL, OPENCODE_API_KEY),
    openrouter: createProviderConfig("openrouter", OPENROUTER_API_URL, OPENROUTER_API_KEY, {
      ...(OPENROUTER_SITE_URL ? { "HTTP-Referer": OPENROUTER_SITE_URL } : {}),
      ...(OPENROUTER_APP_NAME ? { "X-Title": OPENROUTER_APP_NAME } : {}),
    }),
  };

  return {
    ...legacyProviders,
    ...loadSettingsProviders(),
  };
}

const PROVIDERS = buildProviders();
const DEFAULT_PROVIDER = PROVIDERS[REQUESTED_DEFAULT_PROVIDER]
  ? REQUESTED_DEFAULT_PROVIDER
  : (PROVIDERS.opencode ? "opencode" : providerNames()[0]);
if (REQUESTED_DEFAULT_PROVIDER && REQUESTED_DEFAULT_PROVIDER !== DEFAULT_PROVIDER) {
  console.warn(`[config] Unknown DEFAULT_PROVIDER "${REQUESTED_DEFAULT_PROVIDER}", using "${DEFAULT_PROVIDER}".`);
}

function providerNames() {
  return Object.keys(PROVIDERS);
}

function parseProviderModelPrefix(value, separator) {
  const index = value.indexOf(separator);
  if (index <= 0) return null;
  const provider = normalizeProviderName(value.slice(0, index));
  const model = value.slice(index + 1).trim();
  if (!model) return null;
  if (!PROVIDERS[provider]) {
    console.warn(`[config] Unknown provider "${provider}" in model spec "${value}". Known providers: ${providerNames().join(", ")}`);
    return { provider, model, unknownProvider: true };
  }
  return { provider, model };
}

function parseModelSpec(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;

  if (value.startsWith("opencode-go/")) {
    return { provider: "opencode", model: value.slice("opencode-go/".length) };
  }

  const colonSpec = parseProviderModelPrefix(value, ":");
  if (colonSpec) return colonSpec;

  const slashSpec = parseProviderModelPrefix(value, "/");
  if (slashSpec) return slashSpec;

  return { provider: DEFAULT_PROVIDER, model: value };
}

function formatModelSpec(spec) {
  if (!spec) return "";
  return `${spec.provider}/${spec.model}`;
}

function unknownProviderError(modelLease) {
  if (!modelLease?.unknownProvider) return null;
  return `Unknown provider "${modelLease.provider}" in model mapping. Known providers: ${providerNames().join(", ")}`;
}

function parseModelList(raw) {
  const models = raw.split(",").map(parseModelSpec).filter(Boolean);
  return models.length > 0 ? models : [];
}

const OPUS_MODELS = parseModelList(OPUS_MODEL);
const SONNET_MODELS = parseModelList(SONNET_MODEL);
const HAIKU_MODELS = parseModelList(HAIKU_MODEL);
const FAMILY_MODEL_POOLS = {
  opus: OPUS_MODELS,
  sonnet: SONNET_MODELS,
  haiku: HAIKU_MODELS,
};
const activeFamilySlots = {
  opus: Array(OPUS_MODELS.length).fill(0),
  sonnet: Array(SONNET_MODELS.length).fill(0),
  haiku: Array(HAIKU_MODELS.length).fill(0),
};

// [FIX #9] Read allowed origins from env; default to localhost-only for security.
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
  : null; // null means localhost-only (wildcard disabled by default)

const LOCAL_MODELS = [
  "glm-5.1",
  "glm-5",
  "kimi-k2.5",
  "kimi-k2.6",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "minimax-m2.7",
  "minimax-m2.5",
  "qwen3.6-plus",
  "qwen3.5-plus",
];

function modelFamily(model) {
  if (!model) return "sonnet";
  const normalized = model.toLowerCase();
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("sonnet")) return "sonnet";
  if (normalized.includes("haiku")) return "haiku";
  return null;
}

function selectFamilySlot(family, excludedSlots = new Set()) {
  const slots = activeFamilySlots[family];

  for (let i = 0; i < slots.length; i++) {
    if (excludedSlots.has(i)) continue;
    if (slots[i] === 0) return i;
  }

  let selected = null;
  for (let i = 0; i < slots.length; i++) {
    if (excludedSlots.has(i)) continue;
    if (selected === null) {
      selected = i;
      continue;
    }
    if (slots[i] < slots[selected]) selected = i;
  }
  return selected;
}

function reserveModel(model, excludedSlots = new Set()) {
  const family = modelFamily(model);
  if (!family) {
    // Unknown model passed through as-is using either an explicit provider prefix
    // (openrouter:model, openrouter/model, opencode/model) or DEFAULT_PROVIDER.
    const spec = parseModelSpec(model);
    return { ...spec, family: "direct", slot: null, release: () => {} };
  }

  const slot = selectFamilySlot(family, excludedSlots);
  if (slot === null) return null;

  activeFamilySlots[family][slot] += 1;
  let released = false;

  return {
    ...FAMILY_MODEL_POOLS[family][slot],
    family,
    slot,
    release: () => {
      if (released) return;
      released = true;
      activeFamilySlots[family][slot] = Math.max(0, activeFamilySlots[family][slot] - 1);
    },
  };
}

function shouldRetryWithFallback(statusCode, modelLease, triedSlots) {
  return (
    statusCode === 429 &&
    modelLease &&
    modelLease.family !== "direct" &&
    triedSlots.size < FAMILY_MODEL_POOLS[modelLease.family].length
  );
}

function extractRequestApiKey(req) {
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.trim()) return xApiKey.trim();

  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();

  return "";
}

function extractApiKey(req, providerName) {
  const provider = PROVIDERS[providerName];
  return provider?.apiKey || extractRequestApiKey(req);
}

function hasAnyApiKey(req) {
  if (extractRequestApiKey(req)) return true;
  return Object.values(PROVIDERS).some(provider => Boolean(provider.apiKey));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function jsonResponse(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function anthropicError(statusCode, message, type = "api_error") {
  return {
    type: "error",
    error: { type, message },
  };
}

function requestUpstream(providerName, method, apiPath, body, apiKey, handlers = {}) {
  const provider = PROVIDERS[providerName];
  if (!provider) {
    if (handlers.onError) handlers.onError(new Error(`Unknown provider: ${providerName}`));
    return null;
  }

  const bodyStr = body === undefined ? "" : JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
    ...provider.extraHeaders,
  };
  if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);

  const options = {
    protocol: provider.url.protocol,
    hostname: provider.url.hostname,
    port: provider.url.port || undefined,
    path: `${provider.basePath}${apiPath}`,
    method,
    headers,
    timeout: REQUEST_TIMEOUT_MS,
  };

  const upstreamReq = provider.client.request(options, upstreamRes => {
    let raw = "";
    upstreamRes.on("data", chunk => {
      raw += chunk.toString("utf8");
      if (handlers.onData) handlers.onData(chunk, upstreamRes.statusCode, upstreamRes.headers);
    });
    upstreamRes.on("end", () => {
      if (handlers.onEnd) handlers.onEnd(raw, upstreamRes.statusCode, upstreamRes.headers);
    });
  });

  upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("Upstream request timed out")));
  upstreamReq.on("error", err => {
    if (handlers.onError) handlers.onError(err);
  });
  if (bodyStr) upstreamReq.write(bodyStr);
  upstreamReq.end();
  return upstreamReq;
}

function contentToText(content) {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);

  return content
    .filter(part => part.type === "text")
    .map(part => part.text || "")
    .join("\n");
}

function approxTokens(chars) {
  return Math.max(0, Math.ceil(chars / 4));
}

function addStat(stats, key, value) {
  const chars = String(value || "").length;
  stats[key] = (stats[key] || 0) + chars;
}

function analyzeTokenSections(body) {
  const stats = {
    system: 0,
    message_text: 0,
    assistant_thinking: 0,
    tool_results: 0,
    tools: 0,
    images: 0,
  };

  addStat(stats, "system", contentToText(body.system));

  for (const message of body.messages || []) {
    const content = message.content;
    if (typeof content === "string") {
      addStat(stats, "message_text", content);
      continue;
    }
    if (!Array.isArray(content)) {
      addStat(stats, "message_text", content || "");
      continue;
    }

    for (const block of content) {
      if (block.type === "text") {
        addStat(stats, "message_text", block.text || "");
      } else if (block.type === "thinking") {
        addStat(stats, "assistant_thinking", block.thinking || block.text || "");
      } else if (block.type === "tool_result") {
        addStat(stats, "tool_results", contentToText(block.content) || JSON.stringify(block.content || ""));
      } else if (block.type === "image") {
        stats.images += 1600 * 4;
      }
    }
  }

  for (const tool of body.tools || []) {
    addStat(stats, "tools", tool.name || "");
    addStat(stats, "tools", tool.description || "");
    addStat(stats, "tools", JSON.stringify(tool.input_schema || {}));
  }

  const total = Object.values(stats).reduce((sum, value) => sum + value, 0);
  return { ...stats, total };
}

function bodyForTokenAnalysis(body) {
  if (!TOOL_SCHEMA_STRIP_DESCRIPTIONS || !Array.isArray(body.tools)) return body;
  return {
    ...body,
    tools: body.tools.map(tool => ({
      ...tool,
      description: "",
      input_schema: stripSchemaDescriptions(tool.input_schema || {}),
    })),
  };
}

function formatTokenStats(stats) {
  const keys = ["system", "message_text", "assistant_thinking", "tool_results", "tools", "images", "total"];
  return keys
    .map(key => `${key}=${approxTokens(stats[key] || 0)}t/${stats[key] || 0}c`)
    .join(" ");
}

function logTokenDebug(label, body, extra = {}) {
  if (!TOKEN_DEBUG) return;
  const stats = analyzeTokenSections(bodyForTokenAnalysis(body));
  const prefix = extra.requestedModel ? `[token-debug] ${label} model=${extra.requestedModel}` : `[token-debug] ${label}`;
  console.log(`${prefix} ${formatTokenStats(stats)}`);
}

function logUpstreamUsage(label, usage, extra = {}) {
  if (!TOKEN_DEBUG || !usage) return;
  const input = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const output = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const total = usage.total_tokens ?? (input + output);
  const model = extra.model ? ` model=${extra.model}` : "";
  const provider = extra.provider ? ` provider=${extra.provider}` : "";
  console.log(`[token-debug] ${label}${provider}${model} upstream_usage=input=${input} output=${output} total=${total}`);
}

function dedupeRepeatedLines(text) {
  const lines = String(text || "").split("\n");
  if (lines.length < 2) return text;

  const deduped = [];
  let previous = null;
  let count = 0;

  const flush = () => {
    if (previous === null) return;
    deduped.push(previous);
    if (count > 1) deduped.push(`[repeated ${count - 1} more times]`);
  };

  for (const line of lines) {
    if (line === previous) {
      count += 1;
      continue;
    }
    flush();
    previous = line;
    count = 1;
  }
  flush();

  const result = deduped.join("\n");
  return result.length < String(text || "").length ? result : text;
}

function truncateText(text, maxChars, headLines, tailLines) {
  const value = String(text || "");
  if (!maxChars || value.length <= maxChars) return value;

  const lines = value.split("\n");
  const head = lines.slice(0, Math.max(0, headLines)).join("\n");
  const tail = lines.slice(Math.max(0, lines.length - Math.max(0, tailLines))).join("\n");
  const marker = "\n[truncated]\n";
  if (maxChars <= marker.length) return value.slice(0, maxChars);

  const candidate = `${head}${marker}${tail}`.trim();

  if (candidate.length <= maxChars) return candidate;

  const headBudget = Math.max(0, Math.floor((maxChars - marker.length) * 0.6));
  const tailBudget = Math.max(0, maxChars - marker.length - headBudget);
  return `${value.slice(0, headBudget)}${marker}${value.slice(-tailBudget)}`;
}

function optimizeToolResultText(text) {
  let value = String(text || "");
  if (TOOL_RESULT_DEDUPE) value = dedupeRepeatedLines(value);
  if (TOOL_RESULT_MAX_CHARS > 0) {
    value = truncateText(value, TOOL_RESULT_MAX_CHARS, TOOL_RESULT_HEAD_LINES, TOOL_RESULT_TAIL_LINES);
  }
  return value;
}

function optimizeToolResultContent(content) {
  if (typeof content === "string") return optimizeToolResultText(content);
  if (!Array.isArray(content)) return content;

  let changed = false;
  const optimized = content.map(part => {
    if (!part || part.type !== "text" || typeof part.text !== "string") return part;
    const text = optimizeToolResultText(part.text);
    if (text !== part.text) changed = true;
    return changed ? { ...part, text } : part;
  });

  return changed ? optimized : content;
}

function optimizeAnthropicBody(body) {
  if (!TOOL_RESULT_DEDUPE && TOOL_RESULT_MAX_CHARS <= 0) return body;
  if (!Array.isArray(body.messages)) return body;

  let changed = false;
  const messages = body.messages.map(message => {
    if (!Array.isArray(message.content)) return message;

    let messageChanged = false;
    const content = message.content.map(block => {
      if (!block || block.type !== "tool_result") return block;
      const optimizedContent = optimizeToolResultContent(block.content);
      if (optimizedContent === block.content) return block;
      messageChanged = true;
      return { ...block, content: optimizedContent };
    });

    if (!messageChanged) return message;
    changed = true;
    return { ...message, content };
  });

  return changed ? { ...body, messages } : body;
}

function dataUrlFromAnthropicImage(block) {
  const source = block.source || {};
  if (source.type === "base64") {
    return `data:${source.media_type || "image/jpeg"};base64,${source.data || ""}`;
  }
  if (source.type === "url") return source.url || "";
  return "";
}

function convertAnthropicContentToOpenAI(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");

  const parts = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text || "" });
    } else if (block.type === "image") {
      parts.push({ type: "image_url", image_url: { url: dataUrlFromAnthropicImage(block) } });
    }
  }

  if (parts.length === 0) return "";
  if (parts.every(part => part.type === "text")) {
    return parts.map(part => part.text).join("\n");
  }
  return parts;
}

function convertAnthropicMessagesToOpenAI(messages = [], system) {
  const openaiMessages = [];

  const systemText = contentToText(system);
  if (systemText) {
    openaiMessages.push({ role: "system", content: systemText });
  }

  for (const message of messages) {
    const content = message.content;

    if (typeof content === "string" || !Array.isArray(content)) {
      openaiMessages.push({ role: message.role, content: content || "" });
      continue;
    }

    if (message.role === "assistant") {
      const textBlocks = [];
      const thinkingBlocks = [];
      const toolCalls = [];

      for (const block of content) {
        if (block.type === "text") {
          textBlocks.push(block.text || "");
        } else if (block.type === "thinking") {
          thinkingBlocks.push(block.thinking || block.text || "");
        } else if (block.type === "redacted_thinking") {
          // redacted_thinking is intentionally dropped — upstream providers do not
          // support this Anthropic-specific block type.
          thinkingBlocks.push("[redacted thinking]");
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          });
        }
      }

      const openaiMessage = {
        role: "assistant",
        content: textBlocks.join("") || null,
      };
      if (thinkingBlocks.length > 0) {
        openaiMessage.reasoning_content = thinkingBlocks.join("\n\n");
      }
      if (toolCalls.length > 0) {
        openaiMessage.tool_calls = toolCalls;
        if (!openaiMessage.reasoning_content) {
          openaiMessage.reasoning_content = " ";
        }
      }
      openaiMessages.push(openaiMessage);
      continue;
    }

    const normalBlocks = [];
    const toolResults = [];
    for (const block of content) {
      if (block.type === "tool_result") {
        toolResults.push(block);
      } else {
        normalBlocks.push(block);
      }
    }

    for (const result of toolResults) {
      openaiMessages.push({
        role: "tool",
        tool_call_id: result.tool_use_id,
        content: contentToText(result.content) || JSON.stringify(result.content || ""),
      });
    }

    if (normalBlocks.length > 0) {
      openaiMessages.push({
        role: message.role,
        content: convertAnthropicContentToOpenAI(normalBlocks),
      });
    }
  }

  return repairOpenAIToolMessageOrder(openaiMessages);
}

// [FIX #1] Rewritten to avoid mutating the input array.
// Original used messages.splice() which caused side effects on the caller's array.
// Now we work entirely on the output (repaired) array using index tracking.
function repairOpenAIToolMessageOrder(messages) {
  const repaired = [];
  // Track which indices have already been placed so we can skip them in the main loop.
  const placed = new Set();

  for (let i = 0; i < messages.length; i++) {
    if (placed.has(i)) continue;

    const message = messages[i];
    repaired.push(message);
    placed.add(i);

    if (
      message.role !== "assistant" ||
      !Array.isArray(message.tool_calls) ||
      message.tool_calls.length === 0
    ) {
      continue;
    }

    const pendingIds = new Set(
      message.tool_calls.map(tc => tc.id).filter(Boolean)
    );
    if (pendingIds.size === 0) continue;

    // Scan the rest of the array for matching tool results and pull them forward.
    for (let j = i + 1; j < messages.length && pendingIds.size > 0; j++) {
      if (placed.has(j)) continue;
      const candidate = messages[j];
      if (candidate.role === "tool" && pendingIds.has(candidate.tool_call_id)) {
        repaired.push(candidate);
        placed.add(j);
        pendingIds.delete(candidate.tool_call_id);
      }
    }

    if (pendingIds.size > 0) {
      console.warn(`[tool-order] Missing tool_result for call IDs: ${Array.from(pendingIds).join(", ")}`);
    }
  }

  return repaired;
}

function convertAnthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  return tools.map(tool => ({
    type: "function",
    function: {
      name: tool.name,
      description: TOOL_SCHEMA_STRIP_DESCRIPTIONS ? "" : (tool.description || ""),
      parameters: TOOL_SCHEMA_STRIP_DESCRIPTIONS
        ? stripSchemaDescriptions(tool.input_schema || { type: "object", properties: {} })
        : (tool.input_schema || { type: "object", properties: {} }),
    },
  }));
}

function stripSchemaDescriptions(value) {
  if (Array.isArray(value)) return value.map(stripSchemaDescriptions);
  if (!value || typeof value !== "object") return value;

  const stripped = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "description") continue;
    stripped[key] = stripSchemaDescriptions(nested);
  }
  return stripped;
}

function convertAnthropicToolChoiceToOpenAI(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool") {
    return { type: "function", function: { name: toolChoice.name } };
  }
  return undefined;
}

function convertAnthropicRequestToOpenAI(body, model) {
  const openaiBody = {
    model,
    messages: convertAnthropicMessagesToOpenAI(body.messages || [], body.system),
    stream: body.stream === true,
  };

  if (body.max_tokens !== undefined) openaiBody.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) openaiBody.temperature = body.temperature;
  if (body.top_p !== undefined) openaiBody.top_p = body.top_p;
  if (body.stop_sequences !== undefined) openaiBody.stop = body.stop_sequences;

  const tools = convertAnthropicToolsToOpenAI(body.tools);
  if (tools) openaiBody.tools = tools;

  const toolChoice = convertAnthropicToolChoiceToOpenAI(body.tool_choice);
  if (toolChoice) openaiBody.tool_choice = toolChoice;

  return openaiBody;
}

function parseToolArguments(args) {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return { _raw: args };
  }
}

function openAIStopToAnthropic(finishReason) {
  const map = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    content_filter: "stop_sequence",
  };
  return map[finishReason] || "end_turn";
}

function convertOpenAIResponseToAnthropic(openaiResp, requestedModel) {
  const choice = openaiResp.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];

  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "text") content.push({ type: "text", text: part.text || "" });
    }
  }

  for (const toolCall of message.tool_calls || []) {
    content.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.function?.name || "tool",
      input: parseToolArguments(toolCall.function?.arguments),
    });
  }

  return {
    id: openaiResp.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: openAIStopToAnthropic(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0,
    },
  };
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function convertOpenAIStreamLine(line, res, state, requestedModel) {
  if (!line.startsWith("data: ")) return;

  const payload = line.slice(6).trim();
  if (!payload) return;
  if (payload === "[DONE]") {
    closeOpenBlocks(res, state);
    writeSse(res, "message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: state.stopReason || "end_turn",
        stop_sequence: null,
      },
      usage: {
        output_tokens: state.outputTokens,
      },
    });
    writeSse(res, "message_stop", { type: "message_stop" });
    res.end();
    return;
  }

  let chunk;
  try {
    chunk = JSON.parse(payload);
  } catch {
    return;
  }

  if (!state.started) {
    state.started = true;
    state.id = chunk.id || state.id;
    writeSse(res, "message_start", {
      type: "message_start",
      message: {
        id: state.id,
        type: "message",
        role: "assistant",
        model: requestedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
    });
  }

  const choice = chunk.choices?.[0] || {};
  const delta = choice.delta || {};

  if (typeof delta.content === "string" && delta.content.length > 0) {
    ensureTextBlock(res, state);
    // [FIX #8] Use upstream usage.completion_tokens when available.
    // Fall back to character-based estimation (÷4) only when the chunk has no usage.
    if (chunk.usage?.completion_tokens != null) {
      state.outputTokens = chunk.usage.completion_tokens;
    } else {
      state.outputTokens += Math.ceil(delta.content.length / 4) || 1;
    }
    writeSse(res, "content_block_delta", {
      type: "content_block_delta",
      index: state.textBlockIndex,
      delta: { type: "text_delta", text: delta.content },
    });
  }

  for (const toolCall of delta.tool_calls || []) {
    ensureToolBlock(res, state, toolCall);
    if (toolCall.function?.arguments) {
      writeSse(res, "content_block_delta", {
        type: "content_block_delta",
        index: state.toolBlocks.get(toolCall.index).blockIndex,
        delta: { type: "input_json_delta", partial_json: toolCall.function.arguments },
      });
    }
  }

  if (choice.finish_reason) {
    state.stopReason = openAIStopToAnthropic(choice.finish_reason);
  }

  if (chunk.usage?.prompt_tokens != null) {
    state.inputTokens = chunk.usage.prompt_tokens;
  }
  if (chunk.usage?.completion_tokens != null) {
    state.outputTokens = chunk.usage.completion_tokens;
  }
}

function ensureTextBlock(res, state) {
  if (state.textBlockOpen) return;
  state.textBlockOpen = true;
  state.textBlockIndex = state.nextBlockIndex++;
  writeSse(res, "content_block_start", {
    type: "content_block_start",
    index: state.textBlockIndex,
    content_block: { type: "text", text: "" },
  });
}

// [FIX #4] Tool name and id are now buffered and the content_block_start event
// is deferred until we have a non-empty name. This prevents emitting a block
// with name: "" when the name arrives in a later streaming chunk.
function ensureToolBlock(res, state, toolCall) {
  const index = toolCall.index ?? 0;
  const existing = state.toolBlocks.get(index);

  if (existing) {
    // Update id/name from later chunks if we haven't emitted the block_start yet.
    if (toolCall.id) existing.id = toolCall.id;
    if (toolCall.function?.name) {
      if (!existing.started) {
        existing.name = toolCall.function.name;
      }
    }
    // Emit the deferred block_start once we have a name.
    if (!existing.started && existing.name) {
      existing.started = true;
      writeSse(res, "content_block_start", {
        type: "content_block_start",
        index: existing.blockIndex,
        content_block: {
          type: "tool_use",
          id: existing.id,
          name: existing.name,
          input: {},
        },
      });
    }
    return;
  }

  const name = toolCall.function?.name || "";
  const block = {
    blockIndex: state.nextBlockIndex++,
    id: toolCall.id || `toolu_${Date.now()}_${index}`,
    name,
    started: false, // block_start not yet emitted
  };
  state.toolBlocks.set(index, block);

  // Only emit block_start immediately if the name is already known.
  if (name) {
    block.started = true;
    writeSse(res, "content_block_start", {
      type: "content_block_start",
      index: block.blockIndex,
      content_block: {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: {},
      },
    });
  }
}

function closeOpenBlocks(res, state) {
  if (state.closed) return;
  state.closed = true;

  if (state.textBlockOpen) {
    writeSse(res, "content_block_stop", {
      type: "content_block_stop",
      index: state.textBlockIndex,
    });
  }

  for (const block of state.toolBlocks.values()) {
    // Flush any blocks that were created but whose block_start was still deferred.
    if (!block.started) {
      block.started = true;
      writeSse(res, "content_block_start", {
        type: "content_block_start",
        index: block.blockIndex,
        content_block: {
          type: "tool_use",
          id: block.id,
          name: block.name || "tool",
          input: {},
        },
      });
    }
    writeSse(res, "content_block_stop", {
      type: "content_block_stop",
      index: block.blockIndex,
    });
  }
}

function configuredModelIds() {
  const configured = [
    ...OPUS_MODELS,
    ...SONNET_MODELS,
    ...HAIKU_MODELS,
  ].map(formatModelSpec);

  const defaults = LOCAL_MODELS.map(model => `${DEFAULT_PROVIDER}/${model}`);
  return Array.from(new Set([...configured, ...defaults])).filter(Boolean);
}

function proxyModels(req, res) {
  jsonResponse(res, 200, {
    object: "list",
    data: configuredModelIds().map(id => ({
      id,
      type: "model",
      display_name: id,
      created_at: "2026-05-12T00:00:00Z",
    })),
  });
}

function handleMessages(req, res, body) {
  const requestedModel = body.model || "(default sonnet)";
  const streaming = body.stream === true;
  const optimizedBody = optimizeAnthropicBody(body);
  logTokenDebug("request", body, { requestedModel });
  if (optimizedBody !== body) {
    logTokenDebug("optimized_request", optimizedBody, { requestedModel });
  }
  const triedSlots = new Set();
  let currentLease = null;

  const releaseCurrentModel = () => {
    if (!currentLease) return;
    currentLease.release();
    currentLease = null;
  };
  const reserveNextModel = () => {
    const modelLease = reserveModel(body.model, triedSlots);
    if (!modelLease) return null;
    currentLease = modelLease;
    if (modelLease.slot !== null) triedSlots.add(modelLease.slot);
    return modelLease;
  };
  const logAttempt = modelLease => {
    console.log(`[${new Date().toISOString()}] ${requestedModel} -> ${formatModelSpec(modelLease)} (stream: ${streaming}, pool: ${modelLease.family}${modelLease.slot === null ? "" : `#${modelLease.slot + 1}`})`);
  };

  res.on("close", releaseCurrentModel);

  if (streaming) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    const state = {
      id: `msg_${Date.now()}`,
      started: false,
      closed: false,
      nextBlockIndex: 0,
      textBlockOpen: false,
      textBlockIndex: null,
      toolBlocks: new Map(),
      inputTokens: 0,
      outputTokens: 0,
      stopReason: "end_turn",
    };

    const startStreamingAttempt = () => {
      const modelLease = reserveNextModel();
      if (!modelLease) {
        writeSse(res, "error", anthropicError(429, "All fallback models failed or were unavailable", "rate_limit_error"));
        res.end();
        return;
      }

      const providerError = unknownProviderError(modelLease);
      if (providerError) {
        releaseCurrentModel();
        writeSse(res, "error", anthropicError(400, providerError, "invalid_request_error"));
        res.end();
        return;
      }

      const apiKey = extractApiKey(req, modelLease.provider);
      if (!apiKey) {
        releaseCurrentModel();
        writeSse(res, "error", anthropicError(401, `Missing API key for provider: ${modelLease.provider}`, "authentication_error"));
        res.end();
        return;
      }

      const openaiBody = convertAnthropicRequestToOpenAI(optimizedBody, modelLease.model);
      let buffer = "";
      let errorRaw = "";
      logAttempt(modelLease);

      requestUpstream(modelLease.provider, "POST", "/chat/completions", openaiBody, apiKey, {
        onData: (chunk, statusCode) => {
          if (statusCode < 200 || statusCode >= 300) {
            errorRaw += chunk.toString("utf8");
            return;
          }

          buffer += chunk.toString("utf8");
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            convertOpenAIStreamLine(line.trimEnd(), res, state, requestedModel);
          }
        },
        onEnd: (raw, statusCode) => {
          releaseCurrentModel();
          if (res.writableEnded) {
            logUpstreamUsage("stream_response", {
              prompt_tokens: state.inputTokens,
              completion_tokens: state.outputTokens,
            }, { provider: modelLease.provider, model: modelLease.model });
            return;
          }
          if (statusCode < 200 || statusCode >= 300) {
            const errorBody = errorRaw || raw || "Upstream API error";
            console.error(`[upstream ${statusCode}] ${errorBody}`);
            if (shouldRetryWithFallback(statusCode, modelLease, triedSlots)) {
              console.warn(`[fallback] ${formatModelSpec(modelLease)} returned ${statusCode}; trying next ${modelLease.family} model`);
              startStreamingAttempt();
              return;
            }
            writeSse(res, "error", anthropicError(statusCode, errorBody, "api_error"));
            res.end();
            return;
          }

          if (buffer.trim()) {
            convertOpenAIStreamLine(buffer.trim(), res, state, requestedModel);
          }
          if (!res.writableEnded) {
            closeOpenBlocks(res, state);
            writeSse(res, "message_delta", {
              type: "message_delta",
              delta: { stop_reason: state.stopReason, stop_sequence: null },
              usage: { output_tokens: state.outputTokens },
            });
            writeSse(res, "message_stop", { type: "message_stop" });
            res.end();
          }
          logUpstreamUsage("stream_response", {
            prompt_tokens: state.inputTokens,
            completion_tokens: state.outputTokens,
          }, { provider: modelLease.provider, model: modelLease.model });
        },
        onError: err => {
          releaseCurrentModel();
          if (res.writableEnded) return;
          writeSse(res, "error", anthropicError(500, err.message, "api_error"));
          res.end();
        },
      });
    };

    startStreamingAttempt();
    return;
  }

  const startNonStreamingAttempt = () => {
    const modelLease = reserveNextModel();
    if (!modelLease) {
      jsonResponse(res, 429, anthropicError(429, "All fallback models failed or were unavailable", "rate_limit_error"));
      return;
    }

    const providerError = unknownProviderError(modelLease);
    if (providerError) {
      releaseCurrentModel();
      jsonResponse(res, 400, anthropicError(400, providerError, "invalid_request_error"));
      return;
    }

    const apiKey = extractApiKey(req, modelLease.provider);
    if (!apiKey) {
      releaseCurrentModel();
      jsonResponse(res, 401, anthropicError(401, `Missing API key for provider: ${modelLease.provider}`, "authentication_error"));
      return;
    }

    const openaiBody = convertAnthropicRequestToOpenAI(optimizedBody, modelLease.model);
    logAttempt(modelLease);

    requestUpstream(modelLease.provider, "POST", "/chat/completions", openaiBody, apiKey, {
      onEnd: (raw, statusCode) => {
        releaseCurrentModel();
        let data;
        try {
          data = JSON.parse(raw);
        } catch (err) {
          jsonResponse(res, 502, anthropicError(502, `Failed to parse upstream response: ${err.message}`, "api_error"));
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          console.error(`[upstream ${statusCode}] ${raw}`);
          if (shouldRetryWithFallback(statusCode, modelLease, triedSlots)) {
            console.warn(`[fallback] ${formatModelSpec(modelLease)} returned ${statusCode}; trying next ${modelLease.family} model`);
            startNonStreamingAttempt();
            return;
          }
          jsonResponse(res, statusCode, anthropicError(
            statusCode,
            data.error?.message || `${modelLease.provider} API error`,
            data.error?.type || "api_error",
          ));
          return;
        }

        logUpstreamUsage("response", data.usage, { provider: modelLease.provider, model: modelLease.model });
        jsonResponse(res, 200, convertOpenAIResponseToAnthropic(data, requestedModel));
      },
      onError: err => {
        releaseCurrentModel();
        jsonResponse(res, 500, anthropicError(500, err.message, "api_error"));
      },
    });
  };

  startNonStreamingAttempt();
}

// [FIX #3] Improved token estimation that accounts for tools and image blocks.
// Tool definitions are large and significantly affect the input budget.
function estimateInputTokens(body) {
  const textParts = [contentToText(body.system)];

  for (const message of body.messages || []) {
    const content = message.content;
    if (typeof content === "string") {
      textParts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text") {
          textParts.push(block.text || "");
        } else if (block.type === "tool_result") {
          textParts.push(contentToText(block.content));
        } else if (block.type === "image") {
          // Images contribute a fixed overhead (~1600 tokens for a typical vision image).
          // We add a placeholder string to the running total rather than a magic number.
          textParts.push(" ".repeat(1600 * 4));
        }
      }
    }
  }

  // Tool definitions are serialized and included in the prompt by the provider.
  for (const tool of body.tools || []) {
    textParts.push(tool.name || "");
    if (!TOOL_SCHEMA_STRIP_DESCRIPTIONS) textParts.push(tool.description || "");
    textParts.push(JSON.stringify(
      TOOL_SCHEMA_STRIP_DESCRIPTIONS
        ? stripSchemaDescriptions(tool.input_schema || {})
        : (tool.input_schema || {})
    ));
  }

  const totalChars = textParts.join("\n").length;
  return Math.max(1, Math.ceil(totalChars / 4));
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;

  // [FIX #9] Restrict CORS to configured origins; fall back to wildcard only when
  // ALLOWED_ORIGINS is explicitly set to "*" in the environment.
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS === null) {
    // Default: allow only same-origin / no-origin (localhost) requests.
    // Do not set Access-Control-Allow-Origin so browsers block cross-origin calls.
  } else if (ALLOWED_ORIGINS.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key, Anthropic-Version, Anthropic-Beta");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if ((pathname === "/" || pathname === "/health") && req.method === "GET") {
    jsonResponse(res, 200, {
      status: "ok",
      message: "Anthropic -> OpenAI-compatible proxy running",
      default_provider: DEFAULT_PROVIDER,
      providers: Object.fromEntries(providerNames().map(name => [name, PROVIDERS[name].url.toString().replace(/\/$/, "")])),
      models: {
        opus: OPUS_MODELS.map(formatModelSpec),
        sonnet: SONNET_MODELS.map(formatModelSpec),
        haiku: HAIKU_MODELS.map(formatModelSpec),
      },
    });
    return;
  }

  if (!hasAnyApiKey(req) && ["/v1/messages", "/v1/messages/count_tokens", "/v1/models"].includes(pathname)) {
    jsonResponse(res, 401, anthropicError(401, "Missing API key", "authentication_error"));
    return;
  }

  if (pathname === "/v1/models" && req.method === "GET") {
    proxyModels(req, res);
    return;
  }

  if (pathname === "/v1/messages/count_tokens" && req.method === "POST") {
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw || "{}");
    } catch {
      jsonResponse(res, 400, anthropicError(400, "Invalid JSON", "invalid_request_error"));
      return;
    }

    const optimizedBody = optimizeAnthropicBody(body);
    logTokenDebug("count_tokens_request", body, { requestedModel: body.model || "(count_tokens)" });
    if (optimizedBody !== body) {
      logTokenDebug("count_tokens_optimized_request", optimizedBody, { requestedModel: body.model || "(count_tokens)" });
    }
    jsonResponse(res, 200, { input_tokens: estimateInputTokens(optimizedBody) });
    return;
  }

  if (pathname === "/v1/messages" && req.method === "POST") {
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw || "{}");
    } catch {
      jsonResponse(res, 400, anthropicError(400, "Invalid JSON", "invalid_request_error"));
      return;
    }

    handleMessages(req, res, body);
    return;
  }

  jsonResponse(res, 404, anthropicError(404, "Endpoint not found", "not_found_error"));
});

server.listen(PORT, () => {
  console.log(`
Anthropic -> OpenAI-compatible Proxy
Listening : http://localhost:${PORT}
Endpoint  : /v1/messages
Models    : /v1/models
Providers : ${providerNames().map(name => `${name}=${PROVIDERS[name].url.toString().replace(/\/$/, "")}`).join(", ")}
Default   : ${DEFAULT_PROVIDER}
Opus      : ${OPUS_MODELS.map(formatModelSpec).join(", ")}
Sonnet    : ${SONNET_MODELS.map(formatModelSpec).join(", ")}
Haiku     : ${HAIKU_MODELS.map(formatModelSpec).join(", ")}
API Key   : ${providerNames().map(name => `${name}:${PROVIDERS[name].apiKey ? "env" : "request"}`).join(", ")}
CORS      : ${ALLOWED_ORIGINS ? ALLOWED_ORIGINS.join(", ") : "localhost only (set ALLOWED_ORIGINS=* to allow all)"}
Token Opt : debug=${TOKEN_DEBUG ? "on" : "off"}, tool_result_max=${TOOL_RESULT_MAX_CHARS || "off"}, dedupe=${TOOL_RESULT_DEDUPE ? "on" : "off"}, strip_tool_descriptions=${TOOL_SCHEMA_STRIP_DESCRIPTIONS ? "on" : "off"}

Claude Code example:
  export ANTHROPIC_BASE_URL="http://localhost:${PORT}"
  export ANTHROPIC_API_KEY="<provider-api-key>"
  export ANTHROPIC_MODEL="claude-sonnet-4-5"
  claude
`);
});

server.on("error", err => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Change the PORT env variable.`);
  } else {
    console.error("Server error:", err);
  }
  process.exit(1);
});
