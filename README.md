# knowledgebase

POC TypeScript Bedrock chat stack that exposes a single chat completion endpoint through API Gateway + Lambda. The interface is intentionally aligned with the OpenAI Chat Completions API so frontend vendors can reuse their existing clients with minimal changes.

## Chat API

- **Endpoint:** `POST /chat`
- **Protocol:** API Gateway streaming (server-sent events). `stream` must be `true` (default) and the backend always returns SSE chunks that mirror `chat.completion.chunk` objects.
- **Agent orchestration:** all traffic routes through the Bedrock agent provisioned by CDK. Clients cannot select alternate models; the agent references a single Bedrock foundation model defined by the stack.

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
- Each message must use the OpenAI `user` or `assistant` role (no client-provided `system` role) with plain string content; the backend injects the canonical agent instructions configured via CDK.
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

### Infrastructure Parameters

- `AgentSystemPrompt` (CDK parameter): optional override for the agent's instruction block. If omitted, the stack uses the repo default prompt (`You are an enterprise knowledge base assistant...`). Supply a new prompt at deploy time via `cdk deploy -c AgentSystemPrompt="Your instructions"` (quote to preserve whitespace).

### CLI Chat Utility

Use the Node-based streaming helper to manually exercise the API Gateway endpoint:

```bash
npm run chat -- "Summarize our SOC 2 controls"

# or point at a different stage/stack
CHAT_API_URL="https://example.execute-api.us-east-1.amazonaws.com/prod/chat" npm run chat -- "Hello"
```

The script sends a minimal OpenAI-style request (`{ messages: [{ role: "user", content: "..." }] }`) and prints streamed chunks as they arrive, plus any OpenAI-formatted errors.

## MVP Deployment Flow

1. `cdk deploy` the stack. Deployment outputs now include `ChatAgentId`, which is the value you will pass to Bedrock runtime and preparedness APIs.
2. After each deploy (or any change to prompts/knowledge-base wiring) run `aws bedrock-agent prepare-agent --agentId <ChatAgentId>` so the agent’s `DRAFT` build reflects the latest configuration. You can use the console “Prepare” button if you prefer clicks.
3. The chat Lambda always invokes the built-in Bedrock alias `TSTALIASID`, which automatically points at the prepared draft. No manual alias or version management is required for this thin-slice MVP.

Once you need stricter version gating, reintroduce an explicit `AWS::Bedrock::AgentAlias` resource and feed it a published version; the chat Lambda simply needs the alias ID updated in its environment variables.
