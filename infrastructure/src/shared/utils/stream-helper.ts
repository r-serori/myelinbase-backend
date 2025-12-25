import {
  CitationsDataChunkDto,
  CitationsPayloadDto,
  SessionInfoDataChunkDto,
  SessionInfoPayloadDto,
  SourceDocumentDto,
  StreamWriter,
  UIMessageChunkDto,
} from "../schemas/dto/chat.dto";

/**
 * UIMessageChunk を NDJSON 形式でフォーマット
 */
function formatChunk(chunk: UIMessageChunkDto): string {
  return JSON.stringify(chunk) + "\n";
}

/**
 * テキストストリームを開始
 */
export function streamTextStart(writer: StreamWriter, textId: string): void {
  writer.write(formatChunk({ type: "text-start", id: textId }));
}

/**
 * テキストチャンクを送信
 */
export function streamTextDelta(
  writer: StreamWriter,
  textId: string,
  delta: string
): void {
  writer.write(formatChunk({ type: "text-delta", id: textId, delta }));
}

/**
 * テキストストリームを終了
 */
export function streamTextEnd(writer: StreamWriter, textId: string): void {
  writer.write(formatChunk({ type: "text-end", id: textId }));
}

/**
 * ソースドキュメント（引用）を送信
 */
export function streamSourceDocument(
  writer: StreamWriter,
  sourceId: string,
  title: string,
  filename?: string,
  mediaType: string = "application/pdf"
): void {
  writer.write(
    formatChunk({
      type: "source-document",
      sourceId,
      mediaType,
      title,
      filename,
    })
  );
}

/**
 * 引用情報を送信（ヘルパー）
 * 型安全: CitationsDataChunkDto を使用
 */
export function streamCitations(
  writer: StreamWriter,
  citations: SourceDocumentDto[]
): void {
  // 1. 各引用を source-document として送信
  citations.forEach((citation, index) => {
    streamSourceDocument(
      writer,
      `source-${index}`,
      citation.text || "",
      citation.fileName,
      "application/pdf"
    );
  });

  // 2. 型安全なデータチャンクとして送信
  const payload: CitationsPayloadDto = { citations };
  const chunk: CitationsDataChunkDto = {
    type: "data-citations",
    data: payload,
  };
  writer.write(formatChunk(chunk));
}

/**
 * セッション情報を送信（ヘルパー）
 * 型安全: SessionInfoDataChunkDto を使用
 * ストリーミング完了時にフロントエンドがキャッシュを直接更新できるよう、
 * 必要な全ての情報を含める
 */
export function streamSessionInfo(
  writer: StreamWriter,
  sessionId: string,
  historyId: string,
  createdAt: string
): void {
  const payload: SessionInfoPayloadDto = { sessionId, historyId, createdAt };
  const chunk: SessionInfoDataChunkDto = {
    type: "data-session_info",
    data: payload,
  };
  writer.write(formatChunk(chunk));
}

/**
 * エラーを送信
 */
export function streamError(writer: StreamWriter, errorText: string): void {
  writer.write(formatChunk({ type: "error", errorText }));
}

export const UI_MESSAGE_STREAM_CONTENT_TYPE = "text/plain; charset=utf-8";
