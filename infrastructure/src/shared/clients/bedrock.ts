// src/shared/clients/bedrock.ts

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION });

/**
 * テキスト配列をベクトル化する (Titan Embeddings)
 * Pinecone検索用・S3 Trigger用
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const embeddings: number[][] = [];
  const BATCH_SIZE = 5;

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async (text) => {
        const command = new InvokeModelCommand({
          modelId: process.env.EMBEDDING_MODEL_ID,
          contentType: "application/json",
          body: JSON.stringify({
            inputText: text,
          }),
        });

        const response = await client.send(command);
        const responseBody = JSON.parse(
          new TextDecoder().decode(response.body)
        );
        return responseBody.embedding as number[];
      })
    );

    embeddings.push(...batchResults);
  }

  return embeddings;
}

/**
 * Claude モデルを呼び出し（ストリーミング）
 */
export async function* invokeClaudeStream(
  prompt: string,
  maxTokens: number = 1024
): AsyncGenerator<string, void, unknown> {
  const command = new InvokeModelWithResponseStreamCommand({
    modelId: process.env.CHAT_MODEL_ID,
    contentType: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const response = await client.send(command);

  if (response.body) {
    for await (const chunk of response.body) {
      if (chunk.chunk?.bytes) {
        const decoded = JSON.parse(new TextDecoder().decode(chunk.chunk.bytes));
        if (decoded.type === "content_block_delta" && decoded.delta?.text) {
          yield decoded.delta.text;
        }
      }
    }
  }
}
