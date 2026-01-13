import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import { ErrorCode } from "../types/error-code";

// DTOのみインポート（Entityはインポートしない）
import * as ChatDTO from "./dto/chat.dto";
import * as DocumentDTO from "./dto/document.dto";

export const registry = new OpenAPIRegistry();

// セキュリティ設定
const bearerAuth = registry.registerComponent("securitySchemes", "BearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

const ErrorCodeSchema = z.nativeEnum(ErrorCode).openapi("ErrorCode");
registry.register("ErrorCode", ErrorCodeSchema);

const ErrorResponseSchema = z
  .object({
    errorCode: ErrorCodeSchema,
  })
  .openapi("ErrorResponse");
registry.register("ErrorResponse", ErrorResponseSchema);

registry.register("SourceDocument", ChatDTO.SourceDocumentSchema);
registry.register("FeedbackType", ChatDTO.FeedbackTypeSchema);
registry.register("ChatSession", ChatDTO.ChatSessionSchema);
registry.register("ChatMessage", ChatDTO.ChatMessageSchema);
registry.register("ChatStreamRequest", ChatDTO.ChatStreamRequestSchema);
registry.register("SubmitFeedbackRequest", ChatDTO.SubmitFeedbackRequestSchema);
registry.register(
  "UpdateSessionNameRequest",
  ChatDTO.UpdateSessionNameRequestSchema
);
registry.register(
  "GetSessionMessagesQueryParams",
  ChatDTO.GetSessionMessagesQueryParamsSchema
);
registry.register("SessionSummary", ChatDTO.SessionSummarySchema);
registry.register("MessageSummary", ChatDTO.MessageSummarySchema);
registry.register("GetSessionsResponse", ChatDTO.GetSessionsResponseSchema);
registry.register(
  "GetSessionMessagesResponse",
  ChatDTO.GetSessionMessagesResponseSchema
);
registry.register(
  "ChatStreamErrorResponse",
  ChatDTO.ChatStreamErrorResponseSchema
);
registry.register(
  "SubmitFeedbackErrorResponse",
  ChatDTO.SubmitFeedbackErrorResponseSchema
);
registry.register(
  "UpdateSessionNameErrorResponse",
  ChatDTO.UpdateSessionNameErrorResponseSchema
);
registry.register(
  "GetSessionMessagesErrorResponse",
  ChatDTO.GetSessionMessagesErrorResponseSchema
);
registry.register(
  "DeleteSessionErrorResponse",
  ChatDTO.DeleteSessionErrorResponseSchema
);

registry.register("TextUIPart", ChatDTO.TextUIPartSchema);
registry.register("SourceDocumentUIPart", ChatDTO.SourceDocumentUIPartSchema);
registry.register("UIMessagePart", ChatDTO.UIMessagePartSchema);
registry.register("UIMessage", ChatDTO.UIMessageSchema);

registry.register("TextDeltaChunk", ChatDTO.TextDeltaChunkSchema);
registry.register("SourceChunk", ChatDTO.SourceChunkSchema);
registry.register("ErrorChunk", ChatDTO.ErrorChunkSchema);
registry.register("FinishChunk", ChatDTO.FinishChunkSchema);
registry.register("DataChunk", ChatDTO.DataChunkSchema);
registry.register("UIMessageChunk", ChatDTO.UIMessageChunkSchema);
registry.register("SessionInfoPayload", ChatDTO.SessionInfoPayloadSchema);
registry.register("CitationsPayload", ChatDTO.CitationsPayloadSchema);

registry.register("DocumentStatus", DocumentDTO.DocumentStatusSchema);
registry.register("DocumentResponse", DocumentDTO.DocumentResponseSchema);
registry.register("FileMetadata", DocumentDTO.FileMetadataSchema);
registry.register(
  "UploadRequestRequest",
  DocumentDTO.UploadRequestRequestSchema
);
registry.register("UpdateTagsRequest", DocumentDTO.UpdateTagsRequestSchema);
registry.register("BatchDeleteRequest", DocumentDTO.BatchDeleteRequestSchema);
registry.register(
  "GetDocumentsResponse",
  DocumentDTO.GetDocumentsResponseSchema
);
registry.register("GetDocumentResponse", DocumentDTO.GetDocumentResponseSchema);
registry.register(
  "GetDocumentDownloadUrlResponse",
  DocumentDTO.GetDocumentDownloadUrlResponseSchema
);
registry.register("UploadRequestResult", DocumentDTO.UploadRequestResultSchema);
registry.register(
  "UploadRequestFileResult",
  DocumentDTO.UploadRequestFileResultSchema
);
registry.register(
  "UploadRequestResponse",
  DocumentDTO.UploadRequestResponseSchema
);
registry.register(
  "DeleteDocumentResponse",
  DocumentDTO.DeleteDocumentResponseSchema
);
registry.register("BatchDeleteResult", DocumentDTO.BatchDeleteResultSchema);
registry.register("BatchDeleteResponse", DocumentDTO.BatchDeleteResponseSchema);
registry.register(
  "UploadRequestErrorResponse",
  DocumentDTO.UploadRequestErrorResponseSchema
);
registry.register(
  "UpdateTagsErrorResponse",
  DocumentDTO.UpdateTagsErrorResponseSchema
);
registry.register(
  "BatchDeleteErrorResponse",
  DocumentDTO.BatchDeleteErrorResponseSchema
);
registry.register(
  "GetDocumentErrorResponse",
  DocumentDTO.GetDocumentErrorResponseSchema
);
registry.register(
  "GetDocumentDownloadUrlErrorResponse",
  DocumentDTO.GetDocumentDownloadUrlErrorResponseSchema
);
registry.register(
  "DeleteDocumentErrorResponse",
  DocumentDTO.DeleteDocumentErrorResponseSchema
);

registry.registerPath({
  method: "post",
  path: "/chat/stream",
  summary: "Chat Streaming",
  description:
    "Send messages and receive a streaming response using AI SDK 6+ UI Message Stream Protocol (SSE format).",
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: ChatDTO.ChatStreamRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description:
        "Successful stream response (Server-Sent Events). Each event is a UIMessageChunk object prefixed with 'data: ' and terminated with '\\n\\n'. Stream ends with 'data: [DONE]\\n\\n'.",
      content: {
        "text/event-stream": {
          schema: z.string().openapi({
            description:
              "SSE stream of UIMessageChunk objects. Format: data: {json}\\n\\n",
            example:
              'data: {"type":"text-delta","textDelta":"Hello"}\\n\\ndata: {"type":"source","source":{"sourceId":"src-1","title":"Doc","url":""}}\\n\\ndata: {"type":"data","data":[{"type":"session_info","sessionId":"...","historyId":"...","createdAt":"..."}]}\\n\\ndata: {"type":"finish","finishReason":"stop"}\\n\\ndata: [DONE]\\n\\n',
          }),
        },
      },
      headers: z.object({
        "X-Accel-Buffering": z
          .literal("no")
          .openapi({ description: "Disable proxy buffering" }),
        "Cache-Control": z
          .literal("no-cache")
          .openapi({ description: "Disable caching" }),
      }),
    },
    400: {
      description: "Bad Request",
      content: {
        "application/json": { schema: ChatDTO.ChatStreamErrorResponseSchema },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
    },
    403: {
      description: "Forbidden",
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
    },
    500: {
      description: "Internal Server Error",
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/chat/feedback",
  summary: "Submit Feedback",
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: ChatDTO.SubmitFeedbackRequestSchema },
      },
    },
  },
  responses: {
    204: {
      description: "Feedback submitted successfully",
    },
    400: {
      description: "Bad Request",
      content: {
        "application/json": {
          schema: ChatDTO.SubmitFeedbackErrorResponseSchema,
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
    },
    500: {
      description: "Internal Server Error",
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/chat/sessions",
  summary: "List Sessions",
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: {
      description: "List of chat sessions",
      content: {
        "application/json": { schema: ChatDTO.GetSessionsResponseSchema },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
    },
    500: {
      description: "Internal Server Error",
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/chat/sessions/{sessionId}",
  summary: "Get Session Messages",
  security: [{ [bearerAuth.name]: [] }],
  request: {
    params: z.object({ sessionId: z.string() }),
    query: ChatDTO.GetSessionMessagesQueryParamsSchema,
  },
  responses: {
    200: {
      description: "Session messages",
      content: {
        "application/json": {
          schema: ChatDTO.GetSessionMessagesResponseSchema,
        },
      },
    },
    400: {
      description: "Bad Request",
      content: {
        "application/json": {
          schema: ChatDTO.GetSessionMessagesErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Not Found",
      content: {
        "application/json": {
          schema: ChatDTO.GetSessionMessagesErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Internal Server Error",
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/chat/sessions/{sessionId}",
  summary: "Update Session Name",
  security: [{ [bearerAuth.name]: [] }],
  request: {
    params: z.object({ sessionId: z.string() }),
    body: {
      content: {
        "application/json": { schema: ChatDTO.UpdateSessionNameRequestSchema },
      },
    },
  },
  responses: {
    204: {
      description: "Session name updated successfully",
    },
    400: {
      description: "Bad Request",
      content: {
        "application/json": {
          schema: ChatDTO.UpdateSessionNameErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Not Found",
      content: {
        "application/json": {
          schema: ChatDTO.UpdateSessionNameErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Internal Server Error",
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/chat/sessions/{sessionId}",
  summary: "Delete Session",
  security: [{ [bearerAuth.name]: [] }],
  request: {
    params: z.object({ sessionId: z.string() }),
  },
  responses: {
    204: {
      description: "Session deleted successfully",
    },
    404: {
      description: "Not Found",
      content: {
        "application/json": {
          schema: ChatDTO.DeleteSessionErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Internal Server Error",
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/documents",
  summary: "List Documents",
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: {
      description: "List of documents",
      content: {
        "application/json": { schema: DocumentDTO.GetDocumentsResponseSchema },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
    },
    500: {
      description: "Internal Server Error",
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/documents/upload",
  summary: "Request Upload URL",
  description: "S3への署名付きアップロードURLを発行します。",
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: DocumentDTO.UploadRequestRequestSchema },
      },
    },
  },
  responses: {
    202: {
      description: "Upload URL generated",
      content: {
        "application/json": { schema: DocumentDTO.UploadRequestResponseSchema },
      },
    },
    400: {
      description: "Bad Request",
      content: {
        "application/json": {
          schema: DocumentDTO.UploadRequestErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Internal Server Error",
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/documents/batch-delete",
  summary: "Batch Delete Documents",
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: DocumentDTO.BatchDeleteRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Batch delete completed",
      content: {
        "application/json": { schema: DocumentDTO.BatchDeleteResponseSchema },
      },
    },
    400: {
      description: "Bad Request",
      content: {
        "application/json": {
          schema: DocumentDTO.BatchDeleteErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Internal Server Error",
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/documents/{id}",
  summary: "Get Document",
  security: [{ [bearerAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Document details",
      content: {
        "application/json": { schema: DocumentDTO.GetDocumentResponseSchema },
      },
    },
    400: {
      description: "Bad Request",
      content: {
        "application/json": {
          schema: DocumentDTO.GetDocumentErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Not Found",
      content: {
        "application/json": {
          schema: DocumentDTO.GetDocumentErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Internal Server Error",
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/documents/{id}/download-url",
  summary: "Get Document Download URL",
  security: [{ [bearerAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Download URL",
      content: {
        "application/json": {
          schema: DocumentDTO.GetDocumentDownloadUrlResponseSchema,
        },
      },
    },
    400: {
      description: "Bad Request",
      content: {
        "application/json": {
          schema: DocumentDTO.GetDocumentDownloadUrlErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Not Found",
      content: {
        "application/json": {
          schema: DocumentDTO.GetDocumentDownloadUrlErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Internal Server Error",
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/documents/{id}",
  summary: "Delete Document",
  security: [{ [bearerAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    202: {
      description: "Document deleted",
      content: {
        "application/json": {
          schema: DocumentDTO.DeleteDocumentResponseSchema,
        },
      },
    },
    400: {
      description: "Bad Request",
      content: {
        "application/json": {
          schema: DocumentDTO.DeleteDocumentErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Not Found",
      content: {
        "application/json": {
          schema: DocumentDTO.DeleteDocumentErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Internal Server Error",
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/documents/{id}/tags",
  summary: "Update Tags",
  security: [{ [bearerAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": { schema: DocumentDTO.UpdateTagsRequestSchema },
      },
    },
  },
  responses: {
    204: {
      description: "Tags updated successfully",
    },
    400: {
      description: "Bad Request",
      content: {
        "application/json": {
          schema: DocumentDTO.UpdateTagsErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Not Found",
      content: {
        "application/json": {
          schema: DocumentDTO.UpdateTagsErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Internal Server Error",
      content: {
        "application/json": { schema: ErrorResponseSchema },
      },
    },
  },
});
