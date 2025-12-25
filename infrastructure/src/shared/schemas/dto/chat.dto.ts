import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import { ErrorCode } from "../../types/error-code";
import { FEEDBACK_TYPE } from "../common/constans";

extendZodWithOpenApi(z);

// =================================================================
// API公開用 DTO
// =================================================================

// 基本型（API公開用）

export const SourceDocumentSchema = z
  .object({
    fileName: z.string().openapi({ example: "document.pdf" }),
    score: z.number().optional().openapi({ example: 0.95 }),
    text: z.string().optional(),
    documentId: z.string().optional(),
  })
  .openapi("SourceDocument");

export type SourceDocumentDto = z.infer<typeof SourceDocumentSchema>;

export const FeedbackTypeSchema = z.enum(FEEDBACK_TYPE).openapi("FeedbackType");

export type FeedbackTypeDto = z.infer<typeof FeedbackTypeSchema>;

export const ChatSessionSchema = z
  .object({
    sessionId: z.string().openapi({ example: "session-123" }),
    sessionName: z.string().openapi({ example: "My Session" }),
    createdAt: z.string().datetime(),
    lastMessageAt: z.string().datetime(),
    updatedAt: z.string().datetime().optional(),
  })
  .openapi("ChatSession");

export type ChatSessionDto = z.infer<typeof ChatSessionSchema>;

export const ChatMessageSchema = z
  .object({
    historyId: z.string().openapi({ example: "msg-123" }),
    sessionId: z.string(),
    userQuery: z.string(),
    aiResponse: z.string(),
    sourceDocuments: z.array(SourceDocumentSchema),
    feedback: FeedbackTypeSchema,
    feedbackComment: z.string().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime().optional(),
  })
  .openapi("ChatMessage");

export type ChatMessageDto = z.infer<typeof ChatMessageSchema>;

// =================================================================
// Vercel AI SDK v3.x - UI Message Stream Protocol
// =================================================================

export const TextUIPartSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .openapi("TextUIPart");

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

export type UIMessagePartDto = z.infer<typeof UIMessagePartSchema>;

export const UIMessageSchema = z
  .object({
    id: z.string().optional(),
    role: z.enum(["user", "assistant"]),
    parts: z.array(UIMessagePartSchema),
  })
  .openapi("UIMessage");

export type UIMessageDto = z.infer<typeof UIMessageSchema>;

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
// UI Message Stream Protocol - レスポンスチャンク型
// =================================================================

export const TextStartChunkSchema = z
  .object({
    type: z.literal("text-start"),
    id: z.string(),
  })
  .openapi("TextStartChunk");

export const TextDeltaChunkSchema = z
  .object({
    type: z.literal("text-delta"),
    id: z.string(),
    delta: z.string(),
  })
  .openapi("TextDeltaChunk");

export const TextEndChunkSchema = z
  .object({
    type: z.literal("text-end"),
    id: z.string(),
  })
  .openapi("TextEndChunk");

export const SourceDocumentChunkSchema = z
  .object({
    type: z.literal("source-document"),
    sourceId: z.string(),
    mediaType: z.string(),
    title: z.string(),
    filename: z.string().optional(),
  })
  .openapi("SourceDocumentChunk");

export const ErrorChunkSchema = z
  .object({
    type: z.literal("error"),
    errorText: z.string(),
  })
  .openapi("ErrorChunk");

// =================================================================
// ★ Stream Data Payloads - Orvalで型生成される
// =================================================================

/**
 * セッション情報ペイロード
 * ストリーミング完了時にフロントエンドへ送信される
 * フロントエンドでキャッシュを直接更新するために使用
 */
export const SessionInfoPayloadSchema = z
  .object({
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
 * 引用情報ペイロード
 */
export const CitationsPayloadSchema = z
  .object({
    citations: z.array(SourceDocumentSchema),
  })
  .openapi("CitationsPayload");

export type CitationsPayloadDto = z.infer<typeof CitationsPayloadSchema>;

// =================================================================
// ★ 型付きデータチャンク - Orvalで型生成される
// =================================================================

/**
 * セッション情報データチャンク
 */
export const SessionInfoDataChunkSchema = z
  .object({
    type: z.literal("data-session_info"),
    id: z.string().optional(),
    data: SessionInfoPayloadSchema,
  })
  .openapi("SessionInfoDataChunk");

export type SessionInfoDataChunkDto = z.infer<
  typeof SessionInfoDataChunkSchema
>;

/**
 * 引用情報データチャンク
 */
export const CitationsDataChunkSchema = z
  .object({
    type: z.literal("data-citations"),
    id: z.string().optional(),
    data: CitationsPayloadSchema,
  })
  .openapi("CitationsDataChunk");

export type CitationsDataChunkDto = z.infer<typeof CitationsDataChunkSchema>;

/**
 * 汎用データチャンク（後方互換性・拡張用）
 */
export const DataChunkSchema = z
  .object({
    type: z.string().regex(/^data-.+$/),
    id: z.string().optional(),
    data: z.unknown(),
  })
  .openapi("DataChunk");

export type DataChunkDto = z.infer<typeof DataChunkSchema>;

/**
 * UIメッセージチャンク（全種類の union）
 * SessionInfoDataChunk, CitationsDataChunk を明示的に含める
 */
export const UIMessageChunkSchema = z
  .union([
    TextStartChunkSchema,
    TextDeltaChunkSchema,
    TextEndChunkSchema,
    SourceDocumentChunkSchema,
    ErrorChunkSchema,
    SessionInfoDataChunkSchema,
    CitationsDataChunkSchema,
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

// =================================================================
// レスポンス型定義
// =================================================================

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

export type MessageSummaryDto = z.infer<typeof MessageSummarySchema>;

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
    status: z.literal("success"),
    session: ChatSessionSchema,
  })
  .openapi("UpdateSessionNameResponse");

export type UpdateSessionNameResponseDto = z.infer<
  typeof UpdateSessionNameResponseSchema
>;

export const DeleteSessionResponseSchema = z
  .object({
    status: z.literal("success"),
  })
  .openapi("DeleteSessionResponse");

export type DeleteSessionResponseDto = z.infer<
  typeof DeleteSessionResponseSchema
>;

export const SubmitFeedbackResponseSchema = z
  .object({
    status: z.literal("success"),
    item: ChatMessageSchema,
  })
  .openapi("SubmitFeedbackResponse");

export type SubmitFeedbackResponseDto = z.infer<
  typeof SubmitFeedbackResponseSchema
>;

// =================================================================
// Stream Writer インターフェース
// =================================================================

export interface StreamWriter {
  write: (data: string) => void;
  end: () => void;
}

// =================================================================
// エラーレスポンス定義
// =================================================================

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
