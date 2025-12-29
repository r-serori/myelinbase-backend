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

// =================================================================
// Vercel AI SDK v3.x UI Message Stream Protocol 準拠
// https://sdk.vercel.ai/docs/ai-sdk-ui/stream-protocol#ui-message-stream-protocol
// =================================================================

/**
 * UIMessageChunk を NDJSON 形式でフォーマット
 */
function formatChunk(chunk: UIMessageChunkDto): string {
  return JSON.stringify(chunk) + "\n";
}

/**
 * テキストデルタを送信
 */
export function streamTextDelta(writer: StreamWriter, textDelta: string): void {
  const chunk: TextDeltaChunkDto = { type: "text-delta", textDelta };
  writer.write(formatChunk(chunk));
}

/**
 * ソースを送信
 * UI Message Stream Protocol: {"type":"source","source":{...}}
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
  writer.write(formatChunk(chunk));
}

/**
 * 引用情報を送信
 * 1. 各引用を source として送信
 * 2. 詳細データを data 配列として送信
 */
export function streamCitations(
  writer: StreamWriter,
  citations: SourceDocumentDto[]
): void {
  // 1. 各引用を source として送信
  citations.forEach((citation, index) => {
    streamSource(writer, `source-${index}`, citation.text || "");
  });

  // 2. 詳細データを data 配列として送信
  const payload: CitationsPayloadDto = { type: "citations", citations };
  const chunk: DataChunkDto = {
    type: "data",
    data: [payload],
  };
  writer.write(formatChunk(chunk));
}

/**
 * セッション情報を送信
 * UI Message Stream Protocol: {"type":"data","data":[...]}
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
  writer.write(formatChunk(chunk));
}

/**
 * ストリーム終了を送信
 */
export function streamFinish(
  writer: StreamWriter,
  finishReason: "stop" | "error" | "length" = "stop"
): void {
  const chunk: FinishChunkDto = { type: "finish", finishReason };
  writer.write(formatChunk(chunk));
}

/**
 * エラーを送信
 */
export function streamError(writer: StreamWriter, errorText: string): void {
  const chunk: ErrorChunkDto = { type: "error", errorText };
  writer.write(formatChunk(chunk));
}

export const UI_MESSAGE_STREAM_CONTENT_TYPE = "text/plain; charset=utf-8";
