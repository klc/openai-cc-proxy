# OpenAI CC Proxy

Anthropic-compatible proxy for using OpenAI-compatible APIs with Claude Code.

This project exposes the Anthropic Messages API surface expected by Claude Code and forwards requests to one or more OpenAI-compatible providers.

## What It Does

Claude Code sends requests to:

```text
POST /v1/messages
```

This proxy converts those requests into:

```text
POST <provider-api-url>/chat/completions
```

It also converts OpenAI-compatible responses and streaming chunks back into Anthropic Messages API responses.

## Supported Endpoints

- `GET /health`
- `GET /v1/models`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`

## Requirements

- Node.js 18+
- At least one OpenAI-compatible provider API key

No npm dependencies are required.

## Setup

Copy the example environment file:

```sh
cp .env.example .env
```

Edit `.env`:

```env
PORT=3100
DEFAULT_PROVIDER=opencode
OPENCODE_API_KEY=
OPENROUTER_API_KEY=
OPENCODE_API_URL=https://opencode.ai/zen/go/v1
OPENROUTER_API_URL=https://openrouter.ai/api/v1
OPUS_MODEL=opencode/kimi-k2.6
SONNET_MODEL=openrouter/deepseek-v4-pro
HAIKU_MODEL=opencode/deepseek-v4-flash
REQUEST_TIMEOUT_MS=600000
```

You can either set provider-specific keys in `.env`, or leave them empty and let Claude Code pass one key through `ANTHROPIC_API_KEY`. For mixed providers, set `OPENCODE_API_KEY` and `OPENROUTER_API_KEY` separately so each upstream receives the right key.

## Token Optimization

Token optimization is controlled by environment flags. By default, lossy changes
are disabled and the proxy preserves the request body.

```env
TOKEN_DEBUG=1
TOOL_RESULT_DEDUPE=1
TOOL_RESULT_MAX_CHARS=12000
TOOL_RESULT_HEAD_LINES=80
TOOL_RESULT_TAIL_LINES=80
TOOL_SCHEMA_STRIP_DESCRIPTIONS=0
```

- `TOKEN_DEBUG=1` logs approximate request token sections and upstream usage when available.
- `TOOL_RESULT_DEDUPE=1` collapses consecutive repeated lines in tool results.
- `TOOL_RESULT_MAX_CHARS` truncates large tool results while preserving head and tail context. `0` disables truncation.
- `TOOL_RESULT_HEAD_LINES` and `TOOL_RESULT_TAIL_LINES` control how much line context is kept around truncation.
- `TOOL_SCHEMA_STRIP_DESCRIPTIONS=1` removes tool and schema `description` fields before forwarding upstream. This can reduce input tokens, but it may reduce tool-call quality, so enable it only after checking `TOKEN_DEBUG` logs.

These settings reduce tokens only when they change the actual text sent to the
provider. HTTP compression such as gzip can reduce bandwidth, but not billable
prompt or completion tokens.

## Run

```sh
node server.js
```

The proxy listens on:

```text
http://localhost:3100
```

## Claude Code Usage

The most reliable setup is to configure Claude Code through `~/.claude/settings.json`.

Add the proxy environment values to the `env` section:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3100",
    "ANTHROPIC_API_KEY": "<opencode-go-api-key>"
  }
}
```

Replace `<opencode-go-api-key>` with your provider API key if you only use one provider through `ANTHROPIC_API_KEY`. For mixed providers, put keys in `.env` instead.

You can also use shell exports for a single terminal session:

```sh
export ANTHROPIC_BASE_URL="http://localhost:3100"
export ANTHROPIC_API_KEY="<opencode-go-api-key>"
export ANTHROPIC_MODEL="claude-sonnet-4-5"
claude
```

If Claude Code shows an auth conflict warning, sign out from the Claude.ai token flow:

```sh
claude /logout
```

Then start Claude Code again with `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` set.

## Model Mapping

Claude Code may send changing Claude model names such as `claude-opus-4-7`. The proxy maps model families by name:

- Any Claude model containing `opus` maps to `OPUS_MODEL`
- Any Claude model containing `sonnet` maps to `SONNET_MODEL`
- Any Claude model containing `haiku` maps to `HAIKU_MODEL`

Each model entry can include a provider prefix:

```env
OPUS_MODEL=opencode/kimi-k2.6
SONNET_MODEL=openrouter/deepseek-v4-pro
HAIKU_MODEL=opencode/deepseek-v4-flash
```

The proxy also accepts `provider:model`, which is useful when the provider model name itself contains `/`:

```env
SONNET_MODEL=openrouter:deepseek/deepseek-chat-v3.1
```

Currently configured providers are:

- `opencode` via `OPENCODE_API_URL` and `OPENCODE_API_KEY`
- `openrouter` via `OPENROUTER_API_URL` and `OPENROUTER_API_KEY`

For concurrent requests, each family setting can be a comma-separated model pool:

```env
SONNET_MODEL=openrouter/deepseek-v4-pro,opencode/qwen3.6-plus
```

The first model remains the primary. If there is only one active Sonnet request,
it is sent to `openrouter/deepseek-v4-pro`. When another Sonnet request arrives while the
first is still active, it is sent to `opencode/qwen3.6-plus`. If all configured slots are
busy, the proxy picks the least-busy slot.

If an upstream model returns HTTP 429, the proxy retries the same request with
the next configured model in that family before returning the error to Claude
Code. This handles provider-side/global concurrency limits where the proxy only
sees one local request at a time.

You can also bypass family mapping by sending a provider model directly:

```sh
export ANTHROPIC_MODEL="openrouter/deepseek-v4-pro"
```

or with the colon form:

```sh
export ANTHROPIC_MODEL="openrouter:deepseek/deepseek-chat-v3.1"
```

For backward compatibility, `opencode-go/kimi-k2.6` still maps to `opencode/kimi-k2.6`.

## Tool Use

The proxy converts:

- Anthropic `tool_use` blocks to OpenAI `tool_calls`
- Anthropic `tool_result` blocks to OpenAI `role: tool` messages
- OpenAI tool calls back to Anthropic `tool_use` blocks

It also repairs tool-result ordering for providers that require every assistant tool call to be immediately followed by matching tool result messages.

## Streaming

Streaming is supported. OpenAI-compatible SSE chunks are converted into Anthropic SSE events:

- `message_start`
- `content_block_start`
- `content_block_delta`
- `content_block_stop`
- `message_delta`
- `message_stop`

## Troubleshooting

### Auth conflict in Claude Code

If you see:

```text
Auth conflict: Both a token (claude.ai) and an API key (ANTHROPIC_API_KEY) are set.
```

Claude Code has both a Claude.ai login token and an API key. For proxy usage, run:

```sh
claude /logout
```

Then restart Claude Code with:

```sh
export ANTHROPIC_BASE_URL="http://localhost:3100"
export ANTHROPIC_API_KEY="<opencode-go-api-key>"
claude
```

### Provider 400 errors

The proxy logs upstream provider errors as:

```text
[upstream 400] ...
```

Use that log line as the source of truth. It usually indicates a provider-specific validation issue, unsupported model, or tool-call history mismatch.

### Check the proxy

```sh
curl http://localhost:3100/health
```

Expected response:

```json
{
  "status": "ok"
}
```
