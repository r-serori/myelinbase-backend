import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { ErrorCode } from "../types/error-code";

extendZodWithOpenApi(z);

// =================================================================
// 基本型定義
// =================================================================

export const SourceDocumentSchema = z
  .object({
    fileName: z.string().openapi({ example: "document.pdf" }),
    score: z.number().optional().openapi({ example: 0.95 }),
    text: z.string().optional(),
    documentId: z.string().optional(),
  })
  .openapi("SourceDocument");

export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

export const FeedbackTypeSchema = z
  .enum(["NONE", "GOOD", "BAD"])
  .openapi("FeedbackType");
export type FeedbackType = z.infer<typeof FeedbackTypeSchema>;

export const ChatSessionSchema = z
  .object({
    pk: z.string(),
    sk: z.string(),
    gsi1pk: z.string(),
    gsi1sk: z.string(),
    sessionId: z.string().openapi({ example: "session-123" }),
    ownerId: z.string(),
    sessionName: z.string().openapi({ example: "My Session" }),
    createdAt: z.string().datetime(),
    lastMessageAt: z.string().datetime(),
    updatedAt: z.string().datetime().optional(),
  })
  .openapi("ChatSession");

export type ChatSession = z.infer<typeof ChatSessionSchema>;

export const ChatMessageSchema = z
  .object({
    pk: z.string(),
    sk: z.string(),
    historyId: z.string().openapi({ example: "msg-123" }),
    sessionId: z.string(),
    ownerId: z.string(),
    userQuery: z.string(),
    aiResponse: z.string(),
    sourceDocuments: z.array(SourceDocumentSchema),
    feedback: FeedbackTypeSchema,
    feedbackComment: z.string().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime().optional(),
  })
  .openapi("ChatMessage");

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// =================================================================
// リクエスト型定義
// =================================================================

/**
 * チャットストリーミングリクエスト POST /chat/stream
 */
export const ChatStreamRequestSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(20000, ErrorCode.CHAT_QUERY_TOO_LONG)
      .openapi({ example: "こんにちは" }),
    sessionId: z.string().max(100).openapi({ example: "session-123" }), // クライアント生成のUUIDを必須とする
    redoHistoryId: z
      .string()
      .max(100)
      .optional()
      .openapi({ example: "msg-123" }),
  })
  .openapi("ChatStreamRequest");

export type ChatStreamRequest = z.infer<typeof ChatStreamRequestSchema>;

/**
 * フィードバック送信リクエスト POST /chat/feedback
 */
export const SubmitFeedbackRequestSchema = z
  .object({
    sessionId: z.string().max(100),
    historyId: z.string().max(100),
    createdAt: z.string(), // ISO string check?
    evaluation: z.enum(["GOOD", "BAD"]),
    comment: z.string().max(1000, ErrorCode.CHAT_COMMENT_TOO_LONG).optional(),
    reasons: z
      .array(z.string().max(50))
      .max(10, ErrorCode.CHAT_FEEDBACK_REASONS_INVALID)
      .optional(),
  })
  .openapi("SubmitFeedbackRequest");

export type SubmitFeedbackRequest = z.infer<typeof SubmitFeedbackRequestSchema>;

/**
 * セッション名更新リクエスト PATCH /chat/sessions/{sessionId}
 */
export const UpdateSessionNameRequestSchema = z
  .object({
    sessionName: z
      .string()
      .min(1)
      .max(100, ErrorCode.CHAT_SESSION_NAME_TOO_LONG),
  })
  .openapi("UpdateSessionNameRequest");

export type UpdateSessionNameRequest = z.infer<
  typeof UpdateSessionNameRequestSchema
>;

/**
 * セッションメッセージ取得クエリパラメータ GET /chat/sessions/{sessionId}
 */
export const GetSessionMessagesQueryParamsSchema = z
  .object({
    limit: z.string().optional(), // Query params are strings
    cursor: z.string().optional(),
    order: z.string().optional(),
  })
  .openapi("GetSessionMessagesQueryParams");

export type GetSessionMessagesQueryParams = z.infer<
  typeof GetSessionMessagesQueryParamsSchema
>;

// =================================================================
// レスポンス型定義
// =================================================================

/**
 * セッションサマリー（一覧表示用）
 */
export const SessionSummarySchema = z
  .object({
    sessionId: z.string(),
    sessionName: z.string(),
    createdAt: z.string(),
    lastMessageAt: z.string(),
  })
  .openapi("SessionSummary");

export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/**
 * メッセージサマリー（一覧表示用）
 */
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

export type MessageSummary = z.infer<typeof MessageSummarySchema>;

/**
 * セッション一覧取得レスポンス GET /chat/sessions
 */
export const GetSessionsResponseSchema = z
  .object({
    sessions: z.array(SessionSummarySchema),
  })
  .openapi("GetSessionsResponse");

export type GetSessionsResponse = z.infer<typeof GetSessionsResponseSchema>;

/**
 * セッションメッセージ取得レスポンス GET /chat/sessions/{sessionId}
 */
export const GetSessionMessagesResponseSchema = z
  .object({
    sessionId: z.string(),
    messages: z.array(MessageSummarySchema),
    nextCursor: z.string().optional(),
  })
  .openapi("GetSessionMessagesResponse");

export type GetSessionMessagesResponse = z.infer<
  typeof GetSessionMessagesResponseSchema
>;

/**
 * セッション名更新レスポンス PATCH /chat/sessions/{sessionId}
 */
export const UpdateSessionNameResponseSchema = z
  .object({
    status: z.literal("success"),
    session: ChatSessionSchema,
  })
  .openapi("UpdateSessionNameResponse");

export type UpdateSessionNameResponse = z.infer<
  typeof UpdateSessionNameResponseSchema
>;

/**
 * セッション削除レスポンス DELETE /chat/sessions/{sessionId}
 */
export const DeleteSessionResponseSchema = z
  .object({
    status: z.literal("success"),
  })
  .openapi("DeleteSessionResponse");

export type DeleteSessionResponse = z.infer<typeof DeleteSessionResponseSchema>;

/**
 * フィードバック送信レスポンス POST /chat/feedback
 */
export const SubmitFeedbackResponseSchema = z
  .object({
    status: z.literal("success"),
    item: ChatMessageSchema,
  })
  .openapi("SubmitFeedbackResponse");

export type SubmitFeedbackResponse = z.infer<
  typeof SubmitFeedbackResponseSchema
>;

// ChatStreamEventはUnion型なので別途定義が必要だが、今回は省略（型定義のまま残すか、anyで逃げるか）
// 一旦Type Aliasとして定義
export type ChatStreamEvent =
  | {
      type: "citations";
      citations: SourceDocument[];
    }
  | {
      type: "text";
      text: string;
    }
  | {
      type: "done";
      sessionId: string;
      historyId: string;
      aiResponse: string;
      citations: SourceDocument[];
    }
  | {
      type: "error";
      errorCode: string;
      message: string;
    };
