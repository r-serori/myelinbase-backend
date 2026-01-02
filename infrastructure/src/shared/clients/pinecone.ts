// infrastructure/src/shared/clients/pinecone.ts
// Pinecone クライアントユーティリティ

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { Pinecone, RecordMetadata } from "@pinecone-database/pinecone";

import { ErrorCode } from "../types/error-code";
import {
  PineconeVector,
  VectorSearchMetadata,
  VectorSearchResult,
} from "../types/pinecone";
import { AppError } from "../utils/api-handler";

const secretsClient = new SecretsManagerClient({});
let cachedPineconeApiKey: string | null = null;

const pineconeIndexName = process.env.PINECONE_INDEX_NAME!;

/**
 * Secrets ManagerからPinecone APIキーを取得 (キャッシュ付き)
 */
export async function getPineconeApiKey(): Promise<string> {
  if (cachedPineconeApiKey) return cachedPineconeApiKey;

  const response = await secretsClient.send(
    new GetSecretValueCommand({
      SecretId: process.env.PINECONE_API_KEY_SECRET_NAME,
    })
  );

  const secret = JSON.parse(response.SecretString || "{}");
  const apiKey = secret.apiKey || secret.PINECONE_API_KEY;

  cachedPineconeApiKey = apiKey || null;
  if (!cachedPineconeApiKey) {
    throw new AppError(500, ErrorCode.INTERNAL_SERVER_ERROR, {
      message: "Pinecone API key not found",
    });
  }
  return cachedPineconeApiKey;
}

/**
 * Pineconeクライアントを作成
 */
export function createPineconeClient(apiKey: string): Pinecone {
  return new Pinecone({
    apiKey,
  });
}

/**
 * ベクターIDを生成
 */
export function generateVectorId(
  documentId: string,
  chunkIndex: number
): string {
  return `${documentId}#${chunkIndex}`;
}

/**
 * ドキュメントのベクターをPineconeにアップサート
 */
export async function upsertDocumentVectors(
  client: Pinecone,
  vectors: PineconeVector[]
): Promise<void> {
  const index = client.index<RecordMetadata>(pineconeIndexName);

  const BATCH_SIZE = 100;
  for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
    const batch = vectors.slice(i, i + BATCH_SIZE);
    // DocumentMetadataはRecordMetadataと互換性があるため、型アサーションを使用
    await index.upsert(
      batch as Array<{ id: string; values: number[]; metadata: RecordMetadata }>
    );
  }
}

/**
 * ドキュメントのベクターをPineconeから削除
 */
export async function deleteDocumentVectors(
  client: Pinecone,
  documentId: string
): Promise<void> {
  const index = client.index(pineconeIndexName);

  await index.deleteMany({
    filter: {
      documentId: { $eq: documentId },
    },
  });
}

/**
 * Pineconeで検索
 */
export async function searchVectors(
  client: Pinecone,
  queryVector: number[],
  topK: number = 5,
  filter?: Record<string, unknown>
): Promise<VectorSearchResult[]> {
  const index = client.index<RecordMetadata>(pineconeIndexName);

  const response = await index.query({
    vector: queryVector,
    topK,
    filter,
    includeMetadata: true,
  });

  return (
    response.matches?.map((match) => ({
      id: match.id,
      score: match.score || 0,
      metadata: match.metadata as unknown as VectorSearchMetadata,
    })) || []
  );
}

/**
 * Pineconeで特定のユーザーのドキュメントを検索
 */
export async function searchVectorsByOwner(
  client: Pinecone,
  queryVector: number[],
  ownerId: string,
  topK: number = 5
): Promise<VectorSearchResult[]> {
  return searchVectors(client, queryVector, topK, {
    ownerId: { $eq: ownerId },
  });
}
