#!/usr/bin/env node

/**
 * Anthropic -> OpenCode Go API Proxy
 *
 * Claude Code'un Anthropic Messages API isteklerini OpenCode Go'nun
 * OpenAI-compatible chat/completions API'sine cevirir.
 *
 * Claude Code:
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
    console.warn(`[.env] ${filePath} bulunamadi, sadece ortam degiskenleri kullanilacak.`);
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
  console.log(`[.env] ${filePath} yuklendi.`);
}

loadEnv();

const PORT = Number(process.env.PORT || 3100);
const OPENCODE_API_URL = process.env.OPENCODE_API_URL || "https://opencode.ai/zen/go/v1";
const OPENCODE_API_KEY = process.env.OPENCODE_API_KEY || "";
const OPUS_MODEL = process.env.OPENCODE_OPUS_MODEL || process.env.OPENCODE_DEFAULT_MODEL || "glm-5.1";
const SONNET_MODEL = process.env.OPENCODE_SONNET_MODEL || process.env.OPENCODE_DEFAULT_MODEL || "kimi-k2.6";
const HAIKU_MODEL = process.env.OPENCODE_HAIKU_MODEL || process.env.OPENCODE_SMALL_FAST_MODEL || "deepseek-v4-flash";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 600000);

const upstreamUrl = new URL(OPENCODE_API_URL);
const UPSTREAM_BASE = upstreamUrl.pathname.replace(/\/$/, "");
const UPSTREAM_CLIENT = upstreamUrl.protocol === "http:" ? http : https;

const MODEL_MAP = {
  "claude-opus-4-5": OPUS_MODEL,
  "claude-opus-4-1-20250805": OPUS_MODEL,
  "claude-sonnet-4-5": SONNET_MODEL,
  "claude-sonnet-4-6": SONNET_MODEL,
  "claude-3-5-sonnet-latest": SONNET_MODEL,
  "claude-3-7-sonnet-latest": SONNET_MODEL,
  "claude-sonnet-4-5-20250929": SONNET_MODEL,
  "claude-haiku-4-5-20251001": HAIKU_MODEL,
  "claude-3-5-haiku-latest": HAIKU_MODEL,
};

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

function mapModel(model) {
  if (!model) return SONNET_MODEL;
  if (model.startsWith("opencode-go/")) return model.slice("opencode-go/".length);

  const mappedModel = MODEL_MAP[model];
  if (mappedModel) return mappedModel;

  const normalized = model.toLowerCase();
  if (normalized.includes("opus")) return OPUS_MODEL;
  if (normalized.includes("sonnet")) return SONNET_MODEL;
  if (normalized.includes("haiku")) return HAIKU_MODEL;

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

function repairOpenAIToolMessageOrder(messages) {
  const repaired = [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    repaired.push(message);

    if (message.role !== "assistant" || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
      continue;
    }

    const pendingIds = new Set(message.tool_calls.map(toolCall => toolCall.id).filter(Boolean));
    if (pendingIds.size === 0) continue;

    let cursor = index + 1;
    while (cursor < messages.length && pendingIds.size > 0) {
      const next = messages[cursor];
      if (next.role === "tool" && pendingIds.has(next.tool_call_id)) {
        repaired.push(next);
        pendingIds.delete(next.tool_call_id);
        messages.splice(cursor, 1);
        continue;
      }

      cursor++;
    }

    if (pendingIds.size > 0) {
      console.warn(`[tool-order] Eksik tool_result bulundu: ${Array.from(pendingIds).join(", ")}`);
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
    state.outputTokens += 1;
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

function ensureToolBlock(res, state, toolCall) {
  const index = toolCall.index || 0;
  const existing = state.toolBlocks.get(index);
  if (existing) {
    if (toolCall.id) existing.id = toolCall.id;
    if (toolCall.function?.name) existing.name = toolCall.function.name;
    return;
  }

  const block = {
    blockIndex: state.nextBlockIndex++,
    id: toolCall.id || `toolu_${Date.now()}_${index}`,
    name: toolCall.function?.name || "tool",
  };
  state.toolBlocks.set(index, block);
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
    let failed = false;

    requestUpstream("POST", "/chat/completions", openaiBody, apiKey, {
      onData: (chunk, statusCode) => {
        if (failed) return;
        if (statusCode < 200 || statusCode >= 300) {
          failed = true;
          console.error(`[upstream ${statusCode}] ${chunk.toString("utf8")}`);
          writeSse(res, "error", anthropicError(statusCode, chunk.toString("utf8"), "api_error"));
          res.end();
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
        if (failed || res.writableEnded) return;
        if (statusCode < 200 || statusCode >= 300) {
          console.error(`[upstream ${statusCode}] ${raw || "Upstream API hatasi"}`);
          writeSse(res, "error", anthropicError(statusCode, raw || "Upstream API hatasi", "api_error"));
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
        jsonResponse(res, 502, anthropicError(502, `Upstream yaniti parse edilemedi: ${err.message}`, "api_error"));
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        console.error(`[upstream ${statusCode}] ${raw}`);
        jsonResponse(res, statusCode, anthropicError(
          statusCode,
          data.error?.message || "OpenCode Go API hatasi",
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

function estimateInputTokens(body) {
  const text = [
    contentToText(body.system),
    ...(body.messages || []).map(message => contentToText(message.content)),
  ].join("\n");

  return Math.max(1, Math.ceil(text.length / 4));
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
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
      message: "Anthropic -> OpenCode Go proxy calisiyor",
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
    jsonResponse(res, 401, anthropicError(401, "API anahtari eksik", "authentication_error"));
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
      jsonResponse(res, 400, anthropicError(400, "Gecersiz JSON", "invalid_request_error"));
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
      jsonResponse(res, 400, anthropicError(400, "Gecersiz JSON", "invalid_request_error"));
      return;
    }

    handleMessages(req, res, body, apiKey);
    return;
  }

  jsonResponse(res, 404, anthropicError(404, "Endpoint bulunamadi", "not_found_error"));
});

server.listen(PORT, () => {
  console.log(`
Anthropic -> OpenCode Go Proxy
Dinleniyor : http://localhost:${PORT}
Endpoint   : /v1/messages
Models     : /v1/models
Upstream   : ${OPENCODE_API_URL}
Opus      : ${OPUS_MODEL}
Sonnet    : ${SONNET_MODEL}
Haiku     : ${HAIKU_MODEL}
API Key    : ${OPENCODE_API_KEY ? "env ile ayarli" : "Claude Code x-api-key/Authorization header bekleniyor"}
Mapping    : claude-*opus* -> Opus, claude-*sonnet* -> Sonnet, claude-*haiku* -> Haiku

Claude Code ornegi:
  export ANTHROPIC_BASE_URL="http://localhost:${PORT}"
  export ANTHROPIC_API_KEY="<opencode-go-api-key>"
  export ANTHROPIC_MODEL="claude-sonnet-4-5"
  claude
`);
});

server.on("error", err => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} kullanimda. PORT env degiskenini degistirin.`);
  } else {
    console.error("Sunucu hatasi:", err);
  }
  process.exit(1);
});
