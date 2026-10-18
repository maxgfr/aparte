# Streaming fixtures

HTTP answers of the model providers, byte for byte as they arrive, for the adapters of the web app
(`web/src/core/ai/adapters.ts`) and the CLI to parse without a network or a key. Each file is a response body;
[index.json](index.json) gives, per file, the provider, the endpoint, the HTTP status and content type to serve it
with, the model it answers for, and what the adapter must yield from it (`expect`, in the `ChatEvent` terms of
`web/src/core/contracts/ai.ts`: the concatenated text, the reasoning blocks with their `providerMeta`, the stop reason
and its raw value, the usage, or the error; for a tool fixture, `toolCalls` with their `callId` when the provider names
one, the `toolCallMeta` of the call, the `sources` and the `type` of each `providerBlocks` entry; `webSearch: true` marks
a fixture that answers a request declaring the provider's web search).

The bodies follow the providers' documented streaming formats. Ids, signatures and token counts are synthetic; a
signature is an opaque string to the client, and the tests check that it is replayed unchanged, not that it verifies.

| File | Provider and format | What it covers |
|---|---|---|
| `anthropic-text.sse` | Anthropic Messages, `stream: true` | `message_start`, a text block, a `ping`, `message_delta` with `stop_reason: "end_turn"` and the usage, `message_stop` |
| `anthropic-thinking.sse` | Anthropic Messages, adaptive thinking with `display: "summarized"` | a `thinking` block (summary deltas, then one `signature_delta`) followed by a text block: the signature must be kept as `providerMeta.anthropic` and replayed byte for byte |
| `anthropic-refusal.sse` | Anthropic Messages | partial text, then `message_delta` with `stop_reason: "refusal"` and `stop_details` (`category: "cyber"`): the partial output is discarded, the turn is committed as refused |
| `anthropic-error.sse` | Anthropic Messages | partial text, then an `error` event (`overloaded_error`) mid-stream, without `message_stop` |
| `anthropic-auth-error.json` | Anthropic Messages, HTTP 401 | the JSON error body of a refused key (`authentication_error`) |
| `openai-compatible-text.sse` | OpenAI chat completions (`/chat/completions`, `stream: true`, `stream_options: {"include_usage": true}`) | content deltas, `finish_reason: "stop"`, then the usage chunk (`choices: []`), then `data: [DONE]` |
| `openai-compatible-reasoning.sse` | OpenAI-compatible chat completions with `reasoning_content` (DeepSeek's format, also used by other servers) | reasoning deltas, then content deltas, then the usage chunk with `completion_tokens_details.reasoning_tokens` |
| `gemini-text.sse` | Gemini `streamGenerateContent?alt=sse` | three `GenerateContentResponse` chunks separated by CRLF, the last with `finishReason: "STOP"`; `thoughtsTokenCount` counts hidden thinking |
| `anthropic-tool-call.sse` | Anthropic Messages | a signed `thinking` block, a text block, then a `tool_use` block whose input arrives as `input_json_delta` pieces, and `stop_reason: "tool_use"`: one client call of `calculator` |
| `anthropic-web-search.sse` | Anthropic Messages with the `web_search` server tool | a `server_tool_use` block (the query as `input_json_delta`), a `web_search_tool_result` block with two results and their `encrypted_content`, a text block with a `citations_delta`, `stop_reason: "end_turn"`: both server blocks are kept and replayed verbatim, the results become sources |
| `openai-tool-call.sse` | OpenAI Responses (`/responses`, `store: false`) | a reasoning item with `encrypted_content`, then a `function_call` item whose arguments arrive as `response.function_call_arguments.delta` events, then `response.completed` |
| `openai-compatible-tool-call.sse` | OpenAI chat completions | `delta.tool_calls` pieces of one function call, `finish_reason: "tool_calls"`, the usage chunk and `[DONE]` |
| `gemini-tool-call.sse` | Gemini `streamGenerateContent?alt=sse` | one chunk whose part is a `functionCall` with a `thoughtSignature` (kept as `providerMeta.google`), `finishReason: "STOP"`; Gemini gives calls no id, so the adapter makes one |

Usage in `expect` uses the AI SDK's totals: `input` counts every input token (cached or not), `output` every output
token including reasoning, and `cacheRead`, `cacheWrite` and `reasoning` are the parts of those totals.

The Gemini file uses CRLF line endings, as the API sends them; the others use LF. Keep the bytes as they are: a parser
must accept both. Like every fixture of `spec/`, these files are never edited once `aparte/1` is frozen; a new case is
a new file.
