import {
  CitationsPayloadDto,
  DataChunkDto,
  ErrorChunkDto,
  FinishChunkDto,
  SessionInfoPayloadDto,
  SourceChunkDto,
  SourceDocumentDto,
  StreamWriter,
  TextDeltaChunkDto,
  UIMessageChunkDto,
} from "../schemas/dto/chat.dto";

// ============================================
// AI SDK 6+ UI Message Stream Protocol (SSE)
// https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
// ============================================

/**
 * SSE形式でチャンクをフォーマット
 * Format: data: {json}\n\n
 */
function formatSSE(chunk: UIMessageChunkDto): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * テキストデルタを送信
 */
export function streamTextDelta(writer: StreamWriter, textDelta: string): void {
  const chunk: TextDeltaChunkDto = { type: "text-delta", textDelta };
  writer.write(formatSSE(chunk));
}

/**
 * ソースを送信
 */
export function streamSource(
  writer: StreamWriter,
  sourceId: string,
  title: string,
  url: string = ""
): void {
  const chunk: SourceChunkDto = {
    type: "source",
    source: { sourceId, title, url },
  };
  writer.write(formatSSE(chunk));
}

/**
 * 引用情報を送信
 */
export function streamCitations(
  writer: StreamWriter,
  citations: SourceDocumentDto[]
): void {
  // 各引用を source として送信
  citations.forEach((citation, index) => {
    streamSource(writer, `source-${index}`, citation.text || "");
  });

  // 詳細データを data 配列として送信
  const payload: CitationsPayloadDto = { type: "citations", citations };
  const chunk: DataChunkDto = {
    type: "data",
    data: [payload],
  };
  writer.write(formatSSE(chunk));
}

/**
 * セッション情報を送信
 */
export function streamSessionInfo(
  writer: StreamWriter,
  sessionId: string,
  historyId: string,
  createdAt: string
): void {
  const payload: SessionInfoPayloadDto = {
    type: "session_info",
    sessionId,
    historyId,
    createdAt,
  };
  const chunk: DataChunkDto = {
    type: "data",
    data: [payload],
  };
  writer.write(formatSSE(chunk));
}

/**
 * ストリーム終了を送信
 */
export function streamFinish(
  writer: StreamWriter,
  finishReason: "stop" | "error" | "length" = "stop"
): void {
  const chunk: FinishChunkDto = { type: "finish", finishReason };
  writer.write(formatSSE(chunk));
}

/**
 * エラーを送信
 */
export function streamError(writer: StreamWriter, errorText: string): void {
  const chunk: ErrorChunkDto = { type: "error", errorText };
  writer.write(formatSSE(chunk));
}

/**
 * ストリーム終了マーカー [DONE] を送信
 * AI SDK 6+ 必須
 */
export function streamDone(writer: StreamWriter): void {
  writer.write("data: [DONE]\n\n");
}

/**
 * AI SDK 6+ SSE Content-Type
 */
export const UI_MESSAGE_STREAM_CONTENT_TYPE = "text/event-stream";
