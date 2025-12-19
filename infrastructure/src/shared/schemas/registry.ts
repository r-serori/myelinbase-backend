import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import * as ChatSchemas from "./chat";
import * as DocumentSchemas from "./document";

export const registry = new OpenAPIRegistry();

// セキュリティ設定
const bearerAuth = registry.registerComponent("securitySchemes", "BearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

// =================================================================
// スキーマ登録 (Schemas)
// =================================================================

// Chat
registry.register("ChatSession", ChatSchemas.ChatSessionSchema);
registry.register("ChatMessage", ChatSchemas.ChatMessageSchema);
registry.register("ChatStreamRequest", ChatSchemas.ChatStreamRequestSchema);
registry.register(
  "SubmitFeedbackRequest",
  ChatSchemas.SubmitFeedbackRequestSchema
);
registry.register(
  "UpdateSessionNameRequest",
  ChatSchemas.UpdateSessionNameRequestSchema
);
registry.register("SessionSummary", ChatSchemas.SessionSummarySchema);
registry.register("MessageSummary", ChatSchemas.MessageSummarySchema);

// Document
registry.register("Document", DocumentSchemas.DocumentSchema);
registry.register(
  "UploadRequestRequest",
  DocumentSchemas.UploadRequestRequestSchema
);
registry.register("UpdateTagsRequest", DocumentSchemas.UpdateTagsRequestSchema);
registry.register("DocumentResponse", DocumentSchemas.DocumentResponseSchema);

// =================================================================
// パス定義 (Chat API)
// =================================================================

registry.registerPath({
  method: "post",
  path: "/chat/stream",
  summary: "チャットストリーミング",
  description: "AIとのチャットを行い、Server-Sent Events (SSE) で回答を受信します。",
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: ChatSchemas.ChatStreamRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "ストリーミングレスポンス",
      content: {
        "text/event-stream": {
          schema: z.string(),
        },
      },
    },
    400: { description: "Invalid Parameter" },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "post",
  path: "/chat/feedback",
  summary: "フィードバック送信",
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: ChatSchemas.SubmitFeedbackRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": {
          schema: ChatSchemas.SubmitFeedbackResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/chat/sessions",
  summary: "セッション一覧取得",
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: {
      description: "Session List",
      content: {
        "application/json": {
          schema: ChatSchemas.GetSessionsResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/chat/sessions/{sessionId}",
  summary: "セッションメッセージ取得",
  security: [{ [bearerAuth.name]: [] }],
  request: {
    params: z.object({ sessionId: z.string() }),
    query: ChatSchemas.GetSessionMessagesQueryParamsSchema,
  },
  responses: {
    200: {
      description: "Messages",
      content: {
        "application/json": {
          schema: ChatSchemas.GetSessionMessagesResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/chat/sessions/{sessionId}",
  summary: "セッション名更新",
  security: [{ [bearerAuth.name]: [] }],
  request: {
    params: z.object({ sessionId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: ChatSchemas.UpdateSessionNameRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": {
          schema: ChatSchemas.UpdateSessionNameResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/chat/sessions/{sessionId}",
  summary: "セッション削除",
  security: [{ [bearerAuth.name]: [] }],
  request: {
    params: z.object({ sessionId: z.string() }),
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": {
          schema: ChatSchemas.DeleteSessionResponseSchema,
        },
      },
    },
  },
});

// =================================================================
// パス定義 (Document API)
// =================================================================

registry.registerPath({
  method: "get",
  path: "/documents",
  summary: "ドキュメント一覧取得",
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: {
      description: "Document List",
      content: {
        "application/json": {
          schema: DocumentSchemas.GetDocumentsResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/documents/upload-request",
  summary: "アップロードリクエスト作成",
  description: "S3への署名付きアップロードURLを発行します。",
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: DocumentSchemas.UploadRequestRequestSchema,
        },
      },
    },
  },
  responses: {
    202: {
      description: "Accepted",
      content: {
        "application/json": {
          schema: DocumentSchemas.UploadRequestResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/documents/{id}",
  summary: "ドキュメント削除",
  security: [{ [bearerAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    202: {
      description: "Accepted",
      content: {
        "application/json": {
          schema: DocumentSchemas.DeleteDocumentResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/documents/{id}/tags",
  summary: "ドキュメントタグ更新",
  security: [{ [bearerAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: DocumentSchemas.UpdateTagsRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": {
          schema: DocumentSchemas.UpdateTagsResponseSchema,
        },
      },
    },
  },
});

