import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const client = new BedrockRuntimeClient({});

/** Single-turn Converse call; returns the text reply. Throws on any Bedrock error. */
export async function converse(system: string, user: string, maxTokens = 300): Promise<string> {
  const res = await client.send(
    new ConverseCommand({
      modelId: process.env.MODEL_ID!,
      system: [{ text: system }],
      messages: [{ role: 'user', content: [{ text: user }] }],
      inferenceConfig: { maxTokens, temperature: 0.2 },
    }),
  );
  const text = res.output?.message?.content?.map((c) => c.text ?? '').join('').trim();
  if (!text) throw new Error('Empty Bedrock response');
  return text;
}
