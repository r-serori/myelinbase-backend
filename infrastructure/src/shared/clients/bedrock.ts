// src/shared/clients/bedrock.ts

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION });

/**
 * リトライ設定
 */
const RETRY_CONFIG = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
} as const;

/**
 * 指数バックオフ + ジッター付きリトライ
 *
 * @param fn - リトライ対象の関数
 * @param maxRetries - 最大リトライ回数
 * @param baseDelayMs - 基本待機時間（ミリ秒）
 * @returns 関数の実行結果
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = RETRY_CONFIG.maxRetries,
  baseDelayMs: number = RETRY_CONFIG.baseDelayMs
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // ThrottlingExceptionの場合のみリトライ
      const isThrottling =
        lastError.name === "ThrottlingException" ||
        lastError.message.includes("Too many requests") ||
        lastError.message.includes("ThrottlingException");

      if (!isThrottling || attempt >= maxRetries) {
        throw lastError;
      }

      // 指数バックオフ + ジッター（Full Jitter戦略）
      const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
      const cappedDelay = Math.min(exponentialDelay, RETRY_CONFIG.maxDelayMs);
      const jitter = Math.random() * cappedDelay;
      const delay = jitter;

      console.log(
        `[Bedrock] ThrottlingException detected. Retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError ?? new Error("Max retries exceeded");
}

/**
 * 単一テキストのエンベディング生成（リトライ付き）
 *
 * @param text - エンベディング対象のテキスト
 * @returns エンベディングベクトル
 */
async function generateSingleEmbedding(text: string): Promise<number[]> {
  return retryWithBackoff(async () => {
    const command = new InvokeModelCommand({
      modelId: process.env.EMBEDDING_MODEL_ID,
      contentType: "application/json",
      body: JSON.stringify({
        inputText: text,
      }),
    });

    const response = await client.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    return responseBody.embedding as number[];
  });
}

/**
 * テキスト配列をベクトル化する (Titan Embeddings)
 * Pinecone検索用・S3 Trigger用
 *
 * バッチ処理 + 指数バックオフリトライでThrottlingに対応
 *
 * @param texts - エンベディング対象のテキスト配列
 * @returns エンベディングベクトルの配列
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const embeddings: number[][] = [];

  // バッチサイズを小さめに設定（同時実行数を抑制）
  const BATCH_SIZE = 3;

  // バッチ間の待機時間（ミリ秒）- Throttling防止
  const BATCH_DELAY_MS = 100;

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    // バッチ内は並列実行（リトライ付き）
    const batchResults = await Promise.all(
      batch.map((text) => generateSingleEmbedding(text))
    );

    embeddings.push(...batchResults);

    // 次のバッチまで少し待機（最終バッチ以外）
    if (i + BATCH_SIZE < texts.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  return embeddings;
}

/**
 * Claude モデルを呼び出し（ストリーミング）
 *
 * @param prompt - ユーザープロンプト
 * @param maxTokens - 最大トークン数
 * @yields ストリーミングテキストチャンク
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
