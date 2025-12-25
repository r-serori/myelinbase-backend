// infrastructure/src/shared/types/processor.ts
// Processor型定義

import type { DocumentStatusDto } from "../schemas/dto/document.dto";

/**
 * Small to Big アルゴリズム用のチャンクデータ構造
 */
export interface ChunkData {
  childText: string; // ベクトル化対象（Small）
  parentText: string; // LLMコンテキスト対象（Big）
  chunkIndex: number;
  parentId: string; // 親チャンクのID（重複排除用）
}

/**
 * Processorのペイロード型（State Machineから渡されるデータ）
 */
export interface ProcessorPayload {
  documentId: string;
  bucket?: string;
  key?: string;
  ownerId?: string;
  fileName?: string;
  contentType?: string;
  text?: string;
  // chunks?: string[]; // 旧仕様
  chunks?: ChunkData[]; // 新仕様: Small to Big対応
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
  // State Machineからの直接入力（後方互換性のため）
  documentId?: string;
  bucket?: string;
  key?: string;
  ownerId?: string;
  fileName?: string;
  contentType?: string;
  text?: string;
  chunks?: ChunkData[];
}

// =================================================================
// レスポンス型定義
// =================================================================

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
  bucket: string;
  key: string;
  ownerId: string;
  fileName: string;
  contentType: string;
  text: string;
  chunks: ChunkData[];
}

/**
 * Embedding・Pinecone登録レスポンス
 */
export interface EmbedAndUpsertResponse {
  documentId: string;
  vectorCount: number;
}
