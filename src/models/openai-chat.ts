import { z } from 'zod';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';

const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});

const chatCompletionRequestSchema = z
  .object({
    messages: z.array(chatMessageSchema).min(1, 'messages must include at least one entry'),
  })
  .strict();

export type SupportedChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;

export const parseChatRequest = (payload: unknown): SupportedChatCompletionRequest =>
  chatCompletionRequestSchema.parse(payload);

export type NormalizedChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export const normalizeMessages = (
  messages: SupportedChatCompletionRequest['messages']
): NormalizedChatMessage[] =>
  messages.map((message) => {
    const trimmed = message.content.trim();
    if (!trimmed) {
      throw new Error('Message content must include at least one non-whitespace character');
    }

    return {
      role: message.role,
      content: trimmed,
    };
  });

export type OpenAIStreamChunk = ChatCompletionChunk;

export const openAiErrorPayload = (
  message: string,
  type: string,
  code?: string | null,
  param?: string | null
) => ({
  error: {
    message,
    type,
    param: param ?? null,
    code: code ?? null,
  },
});
