#!/usr/bin/env node

import readline from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';

const DEFAULT_CHAT_URL = 'https://o9cd6p8cr8.execute-api.us-east-1.amazonaws.com/prod/chat';
const CHAT_API_URL = process.env.CHAT_API_URL?.trim() || DEFAULT_CHAT_URL;

const HELP_TEXT = `Usage:
  node scripts/chat-stream.mjs "Prompt text"
  echo "Prompt" | node scripts/chat-stream.mjs

Environment overrides:
  CHAT_API_URL   Override the deployed chat endpoint
`;

const args = process.argv.slice(2);

if (args.includes('-h') || args.includes('--help')) {
  stdout.write(HELP_TEXT);
  process.exit(0);
}

const collectPrompt = async () => {
  if (args.length > 0) {
    return args.join(' ').trim();
  }

  if (stdin.isTTY) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    const answer = await rl.question('Enter prompt: ');
    rl.close();
    return answer.trim();
  }

  let data = '';
  for await (const chunk of stdin) {
    data += chunk;
  }
  return data.trim();
};

const extractTextDelta = (chunk) => {
  const choice = chunk?.choices?.[0];
  if (!choice) {
    return '';
  }

  const contentParts = choice.delta?.content;
  if (!Array.isArray(contentParts)) {
    return '';
  }

  return contentParts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
};

const handleErrorPayload = (payload) => {
  try {
    const parsed = JSON.parse(payload);
    if (parsed?.error?.message) {
      stderr.write(`\n[error] ${parsed.error.message}\n`);
      return;
    }
  } catch {}
  stderr.write(`\n[error] ${payload}\n`);
};

const streamCompletion = async (body) => {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finishReason;
  let doneSignal = false;

  const currentEvent = { event: undefined, data: [] };

  const handleEvent = (eventName, data) => {
    if (!data) {
      return;
    }

    if (eventName === 'error') {
      handleErrorPayload(data);
      return;
    }

    if (data === '[DONE]') {
      doneSignal = true;
      stdout.write('\n\n[done]\n');
      return;
    }

    try {
      const parsed = JSON.parse(data);
      const textDelta = extractTextDelta(parsed);
      if (textDelta) {
        stdout.write(textDelta);
      }

      const chunkFinish = parsed?.choices?.[0]?.finish_reason;
      if (chunkFinish) {
        finishReason = chunkFinish;
      }
    } catch (error) {
      stderr.write(`\n[warn] Unable to parse chunk: ${error.message ?? error}\n`);
      stderr.write(`${data}\n`);
    }
  };

  const flushEvent = () => {
    if (!currentEvent.data.length) {
      currentEvent.event = undefined;
      return;
    }
    const payload = currentEvent.data.join('\n');
    handleEvent(currentEvent.event ?? 'message', payload);
    currentEvent.event = undefined;
    currentEvent.data = [];
  };

  const handleLine = (line) => {
    if (!line) {
      flushEvent();
      return;
    }

    if (line.startsWith(':')) {
      return;
    }

    if (line.startsWith('event:')) {
      currentEvent.event = line.slice(6).trim();
      return;
    }

    if (line.startsWith('data:')) {
      currentEvent.data.push(line.slice(5).trimStart());
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      handleLine(line);
      if (doneSignal) {
        return { finishReason };
      }
    }
  }

  if (buffer.length) {
    handleLine(buffer.replace(/\r$/, ''));
  }

  flushEvent();
  return { finishReason };
};

const main = async () => {
  const prompt = await collectPrompt();
  if (!prompt) {
    stderr.write('Prompt cannot be empty.\n');
    process.exit(1);
  }

  stdout.write(`\n> ${prompt}\n\n`);

  const response = await fetch(CHAT_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${errorText}`);
  }

  if (!response.body) {
    throw new Error('Response body is empty');
  }

  const { finishReason } = await streamCompletion(response.body);
  if (finishReason) {
    stdout.write(`\n[finish reason: ${finishReason}]\n`);
  }
};

main().catch((error) => {
  stderr.write(`\n[error] ${error.message || error}\n`);
  process.exit(1);
});
