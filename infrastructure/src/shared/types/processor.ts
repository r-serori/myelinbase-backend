// infrastructure/src/shared/types/processor.ts
// Processor型定義

import type { DocumentStatusDto } from "../schemas/dto/document.dto";

/**
 * Small to Big アルゴリズム用のチャンクデータ構造
 */
export interface ChunkData {
  childText: string;
  parentText: string;
  chunkIndex: number;
  parentId: string;
}

/**
 * Processorのペイロード型（State Machineから渡されるデータ）
 */
export interface ProcessorPayload {
  documentId: string;
  bucket?: string;
  key?: string;
  chunksS3Uri?: string;
}

/**
 * Processorエラーの型
 */
export interface ProcessorError {
  message: string;
  code?: string;
  stack?: string;
}

/**
 * Processorイベント型（State Machineから渡される）
 */
export interface ProcessorEvent {
  action: "updateStatus" | "extractAndChunk" | "embedAndUpsert";
  status?: DocumentStatusDto;
  payload?: ProcessorPayload;
  error?: ProcessorError;
}

/**
 * ステータス更新レスポンス
 */
export interface UpdateStatusResponse {
  documentId: string;
  status: string;
}

/**
 * テキスト抽出・チャンク分割レスポンス
 */
export interface ExtractAndChunkResponse {
  documentId: string;
  chunksS3Uri: string;
  chunkCount: number;
}

/**
 * Embedding・Pinecone登録レスポンス
 */
export interface EmbedAndUpsertResponse {
  documentId: string;
  vectorCount: number;
}
