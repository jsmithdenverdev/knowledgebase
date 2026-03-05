# knowledgebase

POC TypeScript Bedrock chat stack that exposes a single chat completion endpoint through API Gateway + Lambda. The interface is intentionally aligned with the OpenAI Chat Completions API so frontend vendors can reuse their existing clients with minimal changes.

## Chat API

- **Endpoint:** `POST /chat`
- **Protocol:** API Gateway streaming (server-sent events). `stream` must be `true` (default) and the backend always returns SSE chunks that mirror `chat.completion.chunk` objects.
- **Model selection:** the Lambda enforces a single Bedrock model defined by `CHAT_MODEL_ID`. Any `model` field supplied by the caller is ignored.

### Request Body (subset of OpenAI spec)

```json
{
  "messages": [
    { "role": "user", "content": "Summarize the attached policy." },
    { "role": "assistant", "content": "Here's the current summary..." },
    { "role": "user", "content": "Tighten that to one paragraph." }
  ]
}
```

Contract constraints:

- `messages` is the **only** accepted field; requests containing `model`, `temperature`, `tools`, etc. are rejected with an OpenAI-style `invalid_request_error`.
- Each message must use the OpenAI `user` or `assistant` role (no client-provided `system` role) with plain string content; the backend injects the canonical system prompt via `CHAT_SYSTEM_PROMPT`.
- The final message must be a `user` turn so the agent always responds to an explicit customer input.
- Whitespace-only content is rejected to avoid empty turns.

### Streaming Response

```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1710000000,"model":"anthropic.claude","system_fingerprint":"bedrock:anthropic.claude","choices":[{"index":0,"delta":{"role":"assistant","content":[{"type":"text","text":"Hello"}]},"finish_reason":null}]}

...

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1710000000,"model":"anthropic.claude","system_fingerprint":"bedrock:anthropic.claude","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### Error Format

Non-2xx responses and SSE error events follow the OpenAI error envelope:

```json
{
  "error": {
    "message": "frequency_penalty is not supported.",
    "type": "invalid_request_error",
    "param": null,
    "code": null
  }
}
```

## Development

Install dependencies and run tests just like any TypeScript CDK repo:

```bash
npm install
npm run build
npm run test
```

### CLI Chat Utility

Use the Node-based streaming helper to manually exercise the API Gateway endpoint:

```bash
npm run chat -- "Summarize our SOC 2 controls"

# or point at a different stage/stack
CHAT_API_URL="https://example.execute-api.us-east-1.amazonaws.com/prod/chat" npm run chat -- "Hello"
```

The script sends a minimal OpenAI-style request (`{ messages: [{ role: "user", content: "..." }] }`) and prints streamed chunks as they arrive, plus any OpenAI-formatted errors.
