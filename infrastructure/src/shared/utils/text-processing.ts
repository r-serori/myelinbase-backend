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

  const parentStep = Math.max(1, parentSize - parentOverlap);
  const childStep = Math.max(1, childSize - childOverlap);

  // 1. Parentループ
  while (parentStart < text.length) {
    const parentEnd = Math.min(parentStart + parentSize, text.length);
    const rawParentText = text.substring(parentStart, parentEnd);
    const parentText = sanitizeText(rawParentText).trim();
    const parentId = randomUUID(); // Parent識別用

    if (parentText.length === 0) {
      // 親テキストが空の場合でも無限ループ防止のために進める
      if (parentSize <= parentOverlap) break;
      parentStart += parentStep;
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

        const childText = parentText
          .substring(childRelativeStart, childRelativeEnd)
          .trim();

        if (childText.length > 0) {
          chunks.push({
            childText: childText,
            parentText: parentText,
            chunkIndex: globalChunkIndex++,
            parentId: parentId,
          });
        }

        if (childSize <= childOverlap) break;

        childRelativeStart += childStep;
      }
    }

    if (parentSize <= parentOverlap) break;
    parentStart += parentStep;
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
 * * 修正: 配列操作によるメモリ肥大化を防ぐため、正規表現による置換に変更
 */
export function sanitizeText(text: string): string {
  // 高速化: 正規表現で一括置換
  // \uFFFD (Replacement Character) も削除対象に追加
  return text.replace(
    // 1. 有効なサロゲートペア (High + Low) -> そのまま保持 (キャプチャグループ1)
    // 2. 孤立した High Surrogate -> 削除
    // 3. 孤立した Low Surrogate -> 削除
    // 4. 制御文字 (NULL, BEL, BSなど。ただしTab, LF, CRは除く) -> 削除
    // 5. 置換文字 (U+FFFD) -> 削除 (Buffer変換時に発生する場合があるため)
    // eslint-disable-next-line no-control-regex
    /([\uD800-\uDBFF][\uDC00-\uDFFF])|[\uD800-\uDBFF]|[\uDC00-\uDFFF]|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]|\uFFFD/g,
    (match, validPair) => {
      // 有効なペアがマッチした場合は、そのペアを返す（削除しない）
      if (validPair) {
        return validPair;
      }
      // それ以外（孤立サロゲート、制御文字、置換文字）は空文字に置換（削除）
      return "";
    }
  );
}
