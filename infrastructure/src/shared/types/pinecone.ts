// infrastructure/src/shared/types/pinecone.ts
// Pinecone型定義

import type { DocumentMetadataEntity } from "../schemas/entities/document.entity";

/**
 * Pineconeベクター検索結果型
 */
export interface VectorSearchResult {
  id: string;
  score: number;
  metadata: DocumentMetadataEntity;
}

/**
 * Pineconeベクター型
 */
export interface PineconeVector {
  id: string;
  values: number[];
  metadata: DocumentMetadataEntity;
}
