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

      const isThrottling =
        lastError.name === "ThrottlingException" ||
        lastError.message.includes("Too many requests") ||
        lastError.message.includes("ThrottlingException");

      if (!isThrottling || attempt >= maxRetries) {
        throw lastError;
      }

      const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
      const cappedDelay = Math.min(exponentialDelay, RETRY_CONFIG.maxDelayMs);
      const delay = Math.random() * cappedDelay;

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
      body: JSON.stringify({ inputText: text }),
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
  const BATCH_SIZE = 3;
  const BATCH_DELAY_MS = 100;

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((text) => generateSingleEmbedding(text))
    );
    embeddings.push(...batchResults);

    if (i + BATCH_SIZE < texts.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  return embeddings;
}

/**
 * Claude 呼び出しオプション
 */
export interface ClaudeOptions {
  /** User Prompt */
  prompt: string;
  /** System Prompt（英語推奨） */
  systemPrompt?: string;
  /** 最大トークン数
   * @default 2048
   */
  maxTokens?: number;
  /** Temperature 0-1
   * RAGのベストプラクティス: 0.0 (事実重視)
   * クリエイティブ用途: 0.7 - 1.0
   * @default 0.0 (RAGにおけるハルシネーション防止のためデフォルトを低く設定)
   */
  temperature?: number;
  /** Top P nucleus sampling */
  topP?: number;
  /** Stop sequences */
  stopSequences?: string[];
}

// ============================================
// Claude Streaming
// ============================================

/**
 * Claude モデルをストリーミング呼び出し
 *
 * - System Prompt（英語）で指示を明確化
 * - User Prompt（コンテキスト言語）でデータを渡す
 * - XMLタグ構造化に対応
 */
export async function* invokeClaudeStream(
  options: ClaudeOptions
): AsyncGenerator<string, void, unknown> {
  const {
    prompt,
    systemPrompt,
    maxTokens = 2048,
    temperature = 0.0,
    topP,
    stopSequences,
  } = options;

  const requestBody: Record<string, unknown> = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens,
    temperature,
    messages: [{ role: "user", content: prompt }],
  };

  if (systemPrompt) {
    requestBody.system = systemPrompt;
  }
  if (topP !== undefined) {
    requestBody.top_p = topP;
  }
  if (stopSequences && stopSequences.length > 0) {
    requestBody.stop_sequences = stopSequences;
  }

  const command = new InvokeModelWithResponseStreamCommand({
    modelId: process.env.CHAT_MODEL_ID,
    contentType: "application/json",
    body: JSON.stringify(requestBody),
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

/**
 * Claude モデルを非ストリーミング呼び出し
 */
export async function invokeClaude(options: ClaudeOptions): Promise<string> {
  const {
    prompt,
    systemPrompt,
    maxTokens = 2048,
    temperature = 0.0,
    topP,
    stopSequences,
  } = options;

  const requestBody: Record<string, unknown> = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens,
    temperature,
    messages: [{ role: "user", content: prompt }],
  };

  if (systemPrompt) {
    requestBody.system = systemPrompt;
  }
  if (topP !== undefined) {
    requestBody.top_p = topP;
  }
  if (stopSequences && stopSequences.length > 0) {
    requestBody.stop_sequences = stopSequences;
  }

  const command = new InvokeModelCommand({
    modelId: process.env.CHAT_MODEL_ID,
    contentType: "application/json",
    body: JSON.stringify(requestBody),
  });

  const response = await client.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));

  if (responseBody.content && Array.isArray(responseBody.content)) {
    return responseBody.content
      .filter((block: { type: string }) => block.type === "text")
      .map((block: { text: string }) => block.text)
      .join("");
  }

  return "";
}
