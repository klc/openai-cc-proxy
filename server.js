#!/usr/bin/env node

/**
 * Anthropic -> OpenCode Go API Proxy
 *
 * Claude Code sends Anthropic Messages API requests; this proxy converts them
 * to OpenCode Go's OpenAI-compatible chat/completions API.
 *
 * Claude Code usage:
 *   export ANTHROPIC_BASE_URL="http://localhost:<PORT>"
 *   export ANTHROPIC_API_KEY="<opencode-go-api-key>"
 *   export ANTHROPIC_MODEL="kimi-k2.6"
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
const OPENCODE_API_URL = process.env.OPENCODE_API_URL || "https://opencode.ai/zen/go/v1";
const OPENCODE_API_KEY = process.env.OPENCODE_API_KEY || "";
const OPUS_MODEL = process.env.OPENCODE_OPUS_MODEL || process.env.OPENCODE_DEFAULT_MODEL || "glm-5.1";
const SONNET_MODEL = process.env.OPENCODE_SONNET_MODEL || process.env.OPENCODE_DEFAULT_MODEL || "kimi-k2.6";
const HAIKU_MODEL = process.env.OPENCODE_HAIKU_MODEL || process.env.OPENCODE_SMALL_FAST_MODEL || "deepseek-v4-flash";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 600000);

// [FIX #9] Read allowed origins from env; default to localhost-only for security.
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
  : null; // null means localhost-only (wildcard disabled by default)

const upstreamUrl = new URL(OPENCODE_API_URL);
const UPSTREAM_BASE = upstreamUrl.pathname.replace(/\/$/, "");
const UPSTREAM_CLIENT = upstreamUrl.protocol === "http:" ? http : https;

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

// [FIX #5] Removed static MODEL_MAP — family-based matching below is sufficient
// and avoids stale hardcoded version strings.
function mapModel(model) {
  if (!model) return SONNET_MODEL;
  if (model.startsWith("opencode-go/")) return model.slice("opencode-go/".length);

  const normalized = model.toLowerCase();
  if (normalized.includes("opus")) return OPUS_MODEL;
  if (normalized.includes("sonnet")) return SONNET_MODEL;
  if (normalized.includes("haiku")) return HAIKU_MODEL;

  // Unknown model passed through as-is (e.g. a direct OpenCode Go model name)
  return model;
}

function extractApiKey(req) {
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.trim()) return xApiKey.trim();

  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();

  return OPENCODE_API_KEY;
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

function requestUpstream(method, apiPath, body, apiKey, handlers = {}) {
  const bodyStr = body === undefined ? "" : JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };
  if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);

  const options = {
    protocol: upstreamUrl.protocol,
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || undefined,
    path: `${UPSTREAM_BASE}${apiPath}`,
    method,
    headers,
    timeout: REQUEST_TIMEOUT_MS,
  };

  const upstreamReq = UPSTREAM_CLIENT.request(options, upstreamRes => {
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
      description: tool.description || "",
      parameters: tool.input_schema || { type: "object", properties: {} },
    },
  }));
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

function convertAnthropicRequestToOpenAI(body) {
  const openaiBody = {
    model: mapModel(body.model),
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

function proxyModels(req, res, apiKey) {
  requestUpstream("GET", "/models", undefined, apiKey, {
    onEnd: (raw, statusCode) => {
      if (statusCode >= 200 && statusCode < 300) {
        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(raw);
        return;
      }

      jsonResponse(res, 200, {
        object: "list",
        data: LOCAL_MODELS.map(id => ({
          id,
          type: "model",
          display_name: id,
          created_at: "2026-05-12T00:00:00Z",
        })),
      });
    },
    onError: () => {
      jsonResponse(res, 200, {
        object: "list",
        data: LOCAL_MODELS.map(id => ({
          id,
          type: "model",
          display_name: id,
          created_at: "2026-05-12T00:00:00Z",
        })),
      });
    },
  });
}

function handleMessages(req, res, body, apiKey) {
  const requestedModel = body.model || SONNET_MODEL;
  const openaiBody = convertAnthropicRequestToOpenAI(body);
  const streaming = body.stream === true;

  console.log(`[${new Date().toISOString()}] ${requestedModel} -> ${openaiBody.model} (stream: ${streaming})`);

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
      outputTokens: 0,
      stopReason: "end_turn",
    };
    let buffer = "";

    // [FIX #2] Check the HTTP status code only once (on the first data event).
    // Subsequent onData calls for the same response always share the same status,
    // but guarding with a flag makes the intent explicit and avoids redundant work.
    let statusChecked = false;
    let upstreamFailed = false;

    requestUpstream("POST", "/chat/completions", openaiBody, apiKey, {
      onData: (chunk, statusCode) => {
        if (upstreamFailed) return;

        if (!statusChecked) {
          statusChecked = true;
          if (statusCode < 200 || statusCode >= 300) {
            upstreamFailed = true;
            console.error(`[upstream ${statusCode}] ${chunk.toString("utf8")}`);
            writeSse(res, "error", anthropicError(statusCode, chunk.toString("utf8"), "api_error"));
            res.end();
            return;
          }
        }

        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          convertOpenAIStreamLine(line.trimEnd(), res, state, requestedModel);
        }
      },
      onEnd: (raw, statusCode) => {
        if (upstreamFailed || res.writableEnded) return;
        if (statusCode < 200 || statusCode >= 300) {
          console.error(`[upstream ${statusCode}] ${raw || "Upstream API error"}`);
          writeSse(res, "error", anthropicError(statusCode, raw || "Upstream API error", "api_error"));
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
      },
      onError: err => {
        if (res.writableEnded) return;
        writeSse(res, "error", anthropicError(500, err.message, "api_error"));
        res.end();
      },
    });
    return;
  }

  requestUpstream("POST", "/chat/completions", openaiBody, apiKey, {
    onEnd: (raw, statusCode) => {
      let data;
      try {
        data = JSON.parse(raw);
      } catch (err) {
        jsonResponse(res, 502, anthropicError(502, `Failed to parse upstream response: ${err.message}`, "api_error"));
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        console.error(`[upstream ${statusCode}] ${raw}`);
        jsonResponse(res, statusCode, anthropicError(
          statusCode,
          data.error?.message || "OpenCode Go API error",
          data.error?.type || "api_error",
        ));
        return;
      }

      jsonResponse(res, 200, convertOpenAIResponseToAnthropic(data, requestedModel));
    },
    onError: err => {
      jsonResponse(res, 500, anthropicError(500, err.message, "api_error"));
    },
  });
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
    textParts.push(tool.description || "");
    textParts.push(JSON.stringify(tool.input_schema || {}));
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
      message: "Anthropic -> OpenCode Go proxy running",
      upstream: OPENCODE_API_URL,
      models: {
        opus: OPUS_MODEL,
        sonnet: SONNET_MODEL,
        haiku: HAIKU_MODEL,
      },
    });
    return;
  }

  const apiKey = extractApiKey(req);
  if (!apiKey && ["/v1/messages", "/v1/messages/count_tokens", "/v1/models"].includes(pathname)) {
    jsonResponse(res, 401, anthropicError(401, "Missing API key", "authentication_error"));
    return;
  }

  if (pathname === "/v1/models" && req.method === "GET") {
    proxyModels(req, res, apiKey);
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

    jsonResponse(res, 200, { input_tokens: estimateInputTokens(body) });
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

    handleMessages(req, res, body, apiKey);
    return;
  }

  jsonResponse(res, 404, anthropicError(404, "Endpoint not found", "not_found_error"));
});

server.listen(PORT, () => {
  console.log(`
Anthropic -> OpenCode Go Proxy
Listening : http://localhost:${PORT}
Endpoint  : /v1/messages
Models    : /v1/models
Upstream  : ${OPENCODE_API_URL}
Opus      : ${OPUS_MODEL}
Sonnet    : ${SONNET_MODEL}
Haiku     : ${HAIKU_MODEL}
API Key   : ${OPENCODE_API_KEY ? "set via env" : "expected from Claude Code x-api-key / Authorization header"}
CORS      : ${ALLOWED_ORIGINS ? ALLOWED_ORIGINS.join(", ") : "localhost only (set ALLOWED_ORIGINS=* to allow all)"}

Claude Code example:
  export ANTHROPIC_BASE_URL="http://localhost:${PORT}"
  export ANTHROPIC_API_KEY="<opencode-go-api-key>"
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
