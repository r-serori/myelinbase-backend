import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import { ErrorCode } from "../../types/error-code";

extendZodWithOpenApi(z);

export interface StreamWriter {
  write: (chunk: string) => void;
  end: () => void;
}

export const FEEDBACK_TYPE = ["NONE", "GOOD", "BAD"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPE)[number];

export const FeedbackTypeSchema = z.enum(FEEDBACK_TYPE).openapi("FeedbackType");

// =================================================================
// SourceDocument (共通)
// =================================================================

export const SourceDocumentSchema = z
  .object({
    text: z.string(),
    fileName: z.string(),
    documentId: z.string(),
    score: z.number(),
  })
  .openapi("SourceDocument");

export type SourceDocumentDto = z.infer<typeof SourceDocumentSchema>;

export const ChatSessionSchema = z
  .object({
    sessionId: z.string(),
    sessionName: z.string(),
    createdAt: z.string(),
    lastMessageAt: z.string(),
    updatedAt: z.string().optional(),
  })
  .openapi("ChatSession");

export type ChatSessionDto = z.infer<typeof ChatSessionSchema>;

export const ChatMessageSchema = z
  .object({
    historyId: z.string(),
    sessionId: z.string(),
    userQuery: z.string(),
    aiResponse: z.string(),
    sourceDocuments: z.array(SourceDocumentSchema),
    feedback: FeedbackTypeSchema,
    createdAt: z.string(),
    updatedAt: z.string().optional(),
  })
  .openapi("ChatMessage");

export type ChatMessageDto = z.infer<typeof ChatMessageSchema>;

export const TextUIPartSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .openapi("TextUIPart");

export type TextUIPartDto = z.infer<typeof TextUIPartSchema>;

export const SourceDocumentUIPartSchema = z
  .object({
    type: z.literal("source-document"),
    sourceId: z.string(),
    mediaType: z.string(),
    title: z.string(),
    filename: z.string().optional(),
  })
  .openapi("SourceDocumentUIPart");

export const UIMessagePartSchema = z
  .discriminatedUnion("type", [TextUIPartSchema, SourceDocumentUIPartSchema])
  .openapi("UIMessagePart");

export const UIMessageSchema = z
  .object({
    id: z.string().optional(),
    role: z.enum(["user", "assistant"]),
    parts: z.array(UIMessagePartSchema),
  })
  .openapi("UIMessage");

export const ChatStreamRequestSchema = z
  .object({
    messages: z.array(UIMessageSchema),
    sessionId: z.string().max(100).openapi({ example: "session-123" }),
    redoHistoryId: z
      .string()
      .max(100)
      .optional()
      .openapi({ example: "msg-123" }),
  })
  .openapi("ChatStreamRequest");

export type ChatStreamRequestDto = z.infer<typeof ChatStreamRequestSchema>;

// =================================================================
// AI SDK 6+ UI Message Stream Protocol (SSE)
// https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
//
// Format: Server-Sent Events (SSE)
// - Each chunk: data: {json}\n\n
// - Stream terminator: data: [DONE]\n\n
// =================================================================

/**
 * テキストデルタチャンク
 * SSE形式: data: {"type":"text-delta","textDelta":"..."}\n\n
 */
export const TextDeltaChunkSchema = z
  .object({
    type: z.literal("text-delta"),
    textDelta: z.string(),
  })
  .openapi("TextDeltaChunk");

export type TextDeltaChunkDto = z.infer<typeof TextDeltaChunkSchema>;

/**
 * ソースチャンク
 * SSE形式: data: {"type":"source","source":{...}}\n\n
 */
export const SourceChunkSchema = z
  .object({
    type: z.literal("source"),
    source: z.object({
      sourceId: z.string(),
      url: z.string(),
      title: z.string(),
    }),
  })
  .openapi("SourceChunk");

export type SourceChunkDto = z.infer<typeof SourceChunkSchema>;

/**
 * エラーチャンク
 * SSE形式: data: {"type":"error","errorText":"..."}\n\n
 */
export const ErrorChunkSchema = z
  .object({
    type: z.literal("error"),
    errorText: z.string(),
  })
  .openapi("ErrorChunk");

export type ErrorChunkDto = z.infer<typeof ErrorChunkSchema>;

/**
 * 終了チャンク
 * SSE形式: data: {"type":"finish","finishReason":"stop"|"error"|"length"}\n\n
 */
export const FinishChunkSchema = z
  .object({
    type: z.literal("finish"),
    finishReason: z.enum(["stop", "error", "length"]),
  })
  .openapi("FinishChunk");

export type FinishChunkDto = z.infer<typeof FinishChunkSchema>;

/**
 * データチャンク（カスタムデータ用）
 * SSE形式: data: {"type":"data","data":[...]}\n\n
 */
export const DataChunkSchema = z
  .object({
    type: z.literal("data"),
    data: z.array(z.unknown()),
  })
  .openapi("DataChunk");

export type DataChunkDto = z.infer<typeof DataChunkSchema>;

/**
 * セッション情報ペイロード (data チャンク内)
 */
export const SessionInfoPayloadSchema = z
  .object({
    type: z.literal("session_info").optional(),
    sessionId: z.string().openapi({ example: "session-123" }),
    historyId: z.string().openapi({ example: "msg-456" }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2024-01-01T00:00:00Z" }),
  })
  .openapi("SessionInfoPayload");

export type SessionInfoPayloadDto = z.infer<typeof SessionInfoPayloadSchema>;

/**
 * 引用情報ペイロード (data チャンク内)
 */
export const CitationsPayloadSchema = z
  .object({
    type: z.literal("citations").optional(),
    citations: z.array(SourceDocumentSchema),
  })
  .openapi("CitationsPayload");

export type CitationsPayloadDto = z.infer<typeof CitationsPayloadSchema>;

/**
 * UIメッセージチャンク（全種類の union）
 * AI SDK 6+ UI Message Stream Protocol (SSE) 準拠
 */
export const UIMessageChunkSchema = z
  .union([
    TextDeltaChunkSchema,
    SourceChunkSchema,
    ErrorChunkSchema,
    FinishChunkSchema,
    DataChunkSchema,
  ])
  .openapi("UIMessageChunk");

export type UIMessageChunkDto = z.infer<typeof UIMessageChunkSchema>;

// =================================================================
// その他リクエスト型定義
// =================================================================

export const SubmitFeedbackRequestSchema = z
  .object({
    sessionId: z.string().max(100),
    historyId: z.string().max(100),
    createdAt: z.string(),
    evaluation: z.enum(FEEDBACK_TYPE),
    comment: z.string().max(1000, ErrorCode.CHAT_COMMENT_TOO_LONG).optional(),
    reasons: z
      .array(z.string().max(50))
      .max(10, ErrorCode.CHAT_FEEDBACK_REASONS_INVALID)
      .optional(),
  })
  .openapi("SubmitFeedbackRequest");

export type SubmitFeedbackRequestDto = z.infer<
  typeof SubmitFeedbackRequestSchema
>;

export const UpdateSessionNameRequestSchema = z
  .object({
    sessionName: z
      .string()
      .min(1, ErrorCode.CHAT_SESSION_NAME_EMPTY)
      .max(100, ErrorCode.CHAT_SESSION_NAME_TOO_LONG),
  })
  .openapi("UpdateSessionNameRequest");

export type UpdateSessionNameRequestDto = z.infer<
  typeof UpdateSessionNameRequestSchema
>;

export const GetSessionMessagesQueryParamsSchema = z
  .object({
    limit: z.string().optional(),
    cursor: z.string().optional(),
    order: z.string().optional(),
  })
  .openapi("GetSessionMessagesQueryParams");

export type GetSessionMessagesQueryParamsDto = z.infer<
  typeof GetSessionMessagesQueryParamsSchema
>;

export const SessionSummarySchema = z
  .object({
    sessionId: z.string(),
    sessionName: z.string(),
    createdAt: z.string(),
    lastMessageAt: z.string(),
  })
  .openapi("SessionSummary");

export type SessionSummaryDto = z.infer<typeof SessionSummarySchema>;

export const MessageSummarySchema = z
  .object({
    historyId: z.string(),
    userQuery: z.string(),
    aiResponse: z.string(),
    sourceDocuments: z.array(SourceDocumentSchema),
    feedback: FeedbackTypeSchema,
    createdAt: z.string(),
  })
  .openapi("MessageSummary");

export const GetSessionsResponseSchema = z
  .object({
    sessions: z.array(ChatSessionSchema),
  })
  .openapi("GetSessionsResponse");

export type GetSessionsResponseDto = z.infer<typeof GetSessionsResponseSchema>;

export const GetSessionMessagesResponseSchema = z
  .object({
    sessionId: z.string(),
    messages: z.array(MessageSummarySchema),
    nextCursor: z.string().optional(),
  })
  .openapi("GetSessionMessagesResponse");

export type GetSessionMessagesResponseDto = z.infer<
  typeof GetSessionMessagesResponseSchema
>;

export const UpdateSessionNameResponseSchema = z
  .object({
    session: ChatSessionSchema,
  })
  .openapi("UpdateSessionNameResponse");

export const DeleteSessionResponseSchema = z
  .object({
    sessionId: z.string(),
  })
  .openapi("DeleteSessionResponse");

export const SubmitFeedbackResponseSchema = z
  .object({
    item: ChatMessageSchema,
  })
  .openapi("SubmitFeedbackResponse");

export const ChatStreamErrorResponseSchema = z
  .object({
    errorCode: z.enum([
      ErrorCode.MISSING_PARAMETER,
      ErrorCode.VALIDATION_FAILED,
      ErrorCode.INVALID_PARAMETER,
    ]),
  })
  .openapi("ChatStreamErrorResponse");

export const SubmitFeedbackErrorResponseSchema = z
  .object({
    errorCode: z.enum([
      ErrorCode.CHAT_COMMENT_TOO_LONG,
      ErrorCode.CHAT_FEEDBACK_REASONS_INVALID,
      ErrorCode.VALIDATION_FAILED,
      ErrorCode.INVALID_PARAMETER,
    ]),
  })
  .openapi("SubmitFeedbackErrorResponse");

export const UpdateSessionNameErrorResponseSchema = z
  .object({
    errorCode: z.enum([
      ErrorCode.MISSING_PARAMETER,
      ErrorCode.CHAT_SESSION_NAME_EMPTY,
      ErrorCode.CHAT_SESSION_NAME_TOO_LONG,
      ErrorCode.RESOURCE_NOT_FOUND,
      ErrorCode.PERMISSION_DENIED,
      ErrorCode.VALIDATION_FAILED,
      ErrorCode.INVALID_PARAMETER,
    ]),
  })
  .openapi("UpdateSessionNameErrorResponse");

export const GetSessionMessagesErrorResponseSchema = z
  .object({
    errorCode: z.enum([
      ErrorCode.MISSING_PARAMETER,
      ErrorCode.RESOURCE_NOT_FOUND,
      ErrorCode.PERMISSION_DENIED,
    ]),
  })
  .openapi("GetSessionMessagesErrorResponse");

export const DeleteSessionErrorResponseSchema = z
  .object({
    errorCode: z.enum([
      ErrorCode.MISSING_PARAMETER,
      ErrorCode.RESOURCE_NOT_FOUND,
      ErrorCode.PERMISSION_DENIED,
    ]),
  })
  .openapi("DeleteSessionErrorResponse");
