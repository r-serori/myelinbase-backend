// infrastructure/src/shared/types/pinecone.ts
// Pinecone型定義

import { DocumentMetadata } from "./document";

/**
 * Pineconeベクター検索結果のメタデータ型
 */
export interface VectorSearchMetadata extends DocumentMetadata {
  bucket: string;
  key: string;
}

/**
 * Pineconeベクター検索結果型
 */
export interface VectorSearchResult {
  id: string;
  score: number;
  metadata: VectorSearchMetadata;
}

/**
 * Pineconeベクター型
 */
export interface PineconeVector {
  id: string;
  values: number[];
  metadata: DocumentMetadata;
}
