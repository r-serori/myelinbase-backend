// infrastructure/src/shared/clients/pinecone.ts
// Pinecone クライアントユーティリティ

import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { Pinecone, RecordMetadata } from "@pinecone-database/pinecone";

import { DocumentMetadataEntity } from "../schemas/entities/document.entity";
import { ErrorCode } from "../types/error-code";
import { PineconeVector, VectorSearchResult } from "../types/pinecone";
import { AppError } from "../utils/api-handler";

const ssmClient = new SSMClient({});
let cachedPineconeApiKey: string | null = null;

const pineconeIndexName = process.env.PINECONE_INDEX_NAME!;

/**
 * SSM Parameter StoreからPinecone APIキーを取得 (キャッシュ付き)
 */
export async function getPineconeApiKey(): Promise<string> {
  if (cachedPineconeApiKey) return cachedPineconeApiKey;

  const response = await ssmClient.send(
    new GetParameterCommand({
      Name: process.env.PINECONE_API_KEY_PARAMETER_NAME,
      WithDecryption: true,
    })
  );

  const apiKey = response.Parameter?.Value;

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
 *
 * Serverless Indexではmetadata filterによる削除がサポートされていないため、
 * IDプレフィックスを使用してベクターIDをリストし、それらを削除する
 *
 * @see https://docs.pinecone.io/guides/data/delete-data
 */
export async function deleteDocumentVectors(
  client: Pinecone,
  documentId: string
): Promise<void> {
  const index = client.index(pineconeIndexName);

  const prefix = `${documentId}#`;
  const allVectorIds: string[] = [];

  let paginationToken: string | undefined;

  do {
    const response = await index.listPaginated({
      prefix,
      ...(paginationToken && { paginationToken }),
    });

    if (response.vectors) {
      const ids = response.vectors.map((v) => v.id ?? "");
      allVectorIds.push(...ids);
    }

    paginationToken = response.pagination?.next;
  } while (paginationToken);

  if (allVectorIds.length === 0) {
    return;
  }

  const DELETE_BATCH_SIZE = 1000;
  for (let i = 0; i < allVectorIds.length; i += DELETE_BATCH_SIZE) {
    const batch = allVectorIds.slice(i, i + DELETE_BATCH_SIZE);
    await index.deleteMany(batch);
  }
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
      metadata: match.metadata as unknown as DocumentMetadataEntity,
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
