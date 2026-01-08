// infrastructure/src/shared/utils/text-processing.ts

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import { Readable } from "stream";

import { TEXT_TYPES } from "../schemas/dto/document.dto";
import type { DocumentMetadataEntity } from "../schemas/entities/document.entity";
import { ChunkData } from "../types/processor";

/**
 * S3からファイルを取得してテキストを抽出
 */
export async function extractTextFromS3(
  s3Client: S3Client,
  bucket: string,
  key: string,
  contentType: string
): Promise<string> {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await s3Client.send(command);

  if (!response.Body) {
    throw new Error("Empty S3 object");
  }

  const buffer = await streamToBuffer(response.Body as Readable);

  let text: string;
  if (contentType === "application/pdf") {
    text = await extractTextFromPdf(buffer);
  } else if (TEXT_TYPES.includes(contentType)) {
    text = buffer.toString("utf-8");
  } else {
    throw new Error(`Unsupported content type: ${contentType}`);
  }

  // 無効なUnicode文字を除去してから返す
  return sanitizeText(text);
}

/**
 * PDFからテキストを抽出
 */
async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  // pdf-parseを使用してPDFからテキスト抽出（動的インポート）
  // pdf-parse は CommonJS モジュールなので、default プロパティまたは直接関数としてエクスポートされる
  const pdfParseModule = await import("pdf-parse");
  // CommonJS モジュールの場合、default プロパティにアクセスする

  const pdfParse =
    (
      pdfParseModule as {
        default?: (buffer: Buffer) => Promise<{ text: string }>;
      }
    ).default ||
    (pdfParseModule as any); /* eslint-disable-line @typescript-eslint/no-explicit-any */
  const data = await pdfParse(buffer);
  return data.text;
}

/**
 * 通常のチャンク分割（旧ロジック・バックアップ用）あとで削除する
 */
export function splitTextIntoChunks(
  text: string,
  chunkSize: number = 1000,
  overlap: number = 200
): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = sanitizeText(text.substring(start, end)).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    start += chunkSize - overlap;
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

/**
 * Small to Big アルゴリズム用のチャンク分割
 * Parent(Context)の中にChild(Vector Search Target)を含める構造を作成
 */
export function createSmallToBigChunks(
  text: string,
  parentSize: number = 800, // コンテキスト用（大きめ）
  childSize: number = 200, // 検索用（小さめ・高密度）
  parentOverlap: number = 100,
  childOverlap: number = 50
): ChunkData[] {
  const chunks: ChunkData[] = [];
  let parentStart = 0;
  let globalChunkIndex = 0;

  // 1. Parentループ
  while (parentStart < text.length) {
    const parentEnd = Math.min(parentStart + parentSize, text.length);
    const rawParentText = text.substring(parentStart, parentEnd);
    const parentText = sanitizeText(rawParentText).trim();
    const parentId = randomUUID(); // Parent識別用

    if (parentText.length === 0) {
      parentStart += parentSize - parentOverlap;
      continue;
    }

    // 2. Parent内でChildループ
    // 注意: ChildはParentのテキスト範囲内から生成する
    // Parentの文脈を失わないように、Parent内部でスライディングウィンドウを行う
    let childRelativeStart = 0;

    // ParentがChildより小さい場合は、Parent=Childとする
    if (parentText.length <= childSize) {
      chunks.push({
        childText: parentText,
        parentText: parentText,
        chunkIndex: globalChunkIndex++,
        parentId: parentId,
      });
    } else {
      while (childRelativeStart < parentText.length) {
        const childRelativeEnd = Math.min(
          childRelativeStart + childSize,
          parentText.length
        );
        const rawChildText = parentText.substring(
          childRelativeStart,
          childRelativeEnd
        );
        const childText = sanitizeText(rawChildText).trim();

        if (childText.length > 0) {
          chunks.push({
            childText: childText,
            parentText: parentText,
            chunkIndex: globalChunkIndex++,
            parentId: parentId,
          });
        }

        childRelativeStart += childSize - childOverlap;

        if (childSize <= childOverlap) break;
      }
    }

    parentStart += parentSize - parentOverlap;
  }

  return chunks;
}

/**
 * StreamをBufferに変換
 */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * ドキュメントメタデータを生成
 */
export function createDocumentMetadata(
  documentId: string,
  fileName: string,
  ownerId: string,
  chunkIndex: number,
  totalChunks: number,
  text: string,
  parentId?: string
): DocumentMetadataEntity {
  const truncatedText = sanitizeText(text.substring(0, 10000));
  const meta: DocumentMetadataEntity = {
    documentId,
    fileName,
    ownerId,
    chunkIndex,
    totalChunks,
    // Pineconeのメタデータ上限(40KB)を考慮しつつ、実用上切れないサイズに緩和
    // 日本語3万文字 ≒ 90KB (UTF-8 3byte) なので、安全を見て 10,000文字程度でも十分
    text: truncatedText,
    createdAt: new Date().toISOString(),
  };

  if (parentId) {
    meta.parentId = parentId;
  }

  return meta;
}

/**
 * 無効なUnicode文字（孤立したサロゲートペアなど）を除去
 * Pineconeは無効なUnicodeコードポイントを受け付けないため
 */
export function sanitizeText(text: string): string {
  let result = "";

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);

    // High surrogate (D800-DBFF)
    if (code >= 0xd800 && code <= 0xdbff) {
      // 次の文字がlow surrogateかチェック
      if (i + 1 < text.length) {
        const nextCode = text.charCodeAt(i + 1);
        if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
          // 有効なサロゲートペアなので両方追加
          result += text[i] + text[i + 1];
          i++; // 次の文字をスキップ
          continue;
        }
      }
      // 孤立したhigh surrogate - スキップ
      continue;
    }

    // Low surrogate (DC00-DFFF) - 前にhigh surrogateがなければここに来る
    if (code >= 0xdc00 && code <= 0xdfff) {
      // 孤立したlow surrogate - スキップ（これが \udc1b のケース）
      continue;
    }

    // 制御文字をスキップ (NULL, BEL, BS, etc.)
    if (
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    ) {
      continue;
    }

    result += text[i];
  }

  return result;
}
