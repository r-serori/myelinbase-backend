import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as YAML from "yaml";

// Import schemas
import * as ChatSchemas from "../src/shared/schemas/chat";
import * as DocumentSchemas from "../src/shared/schemas/document";
import { ErrorCode } from "../src/shared/types/error-code";

const registry = new OpenAPIRegistry();

// Security Scheme
registry.registerComponent("securitySchemes", "BearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

// =================================================================
// Common Definitions (Errors)
// =================================================================

// ErrorCode EnumをSchemaとして登録
const ErrorCodeSchema = z.nativeEnum(ErrorCode).openapi("ErrorCode");

// 共通エラーレスポンスSchema
const ErrorResponseSchema = z
  .object({
    errorCode: ErrorCodeSchema,
  })
  .openapi("ErrorResponse");

registry.register("ErrorCode", ErrorCodeSchema);
registry.register("ErrorResponse", ErrorResponseSchema);

// =================================================================
// Schema Registration
// =================================================================

function registerSchemas(schemas: any) {
  for (const [key, value] of Object.entries(schemas)) {
    if (value instanceof z.ZodType) {
      const name = key.replace(/Schema$/, "");
      registry.register(name, value);
    }
  }
}

registerSchemas(ChatSchemas);
registerSchemas(DocumentSchemas);

// =================================================================
// Helper for Error Responses
// =================================================================

const commonErrorResponses = {
  400: {
    description: "Bad Request",
    content: {
      "application/json": {
        schema: ErrorResponseSchema,
      },
    },
  },
  401: {
    description: "Unauthorized",
    content: {
      "application/json": {
        schema: ErrorResponseSchema,
      },
    },
  },
  403: {
    description: "Forbidden",
    content: {
      "application/json": {
        schema: ErrorResponseSchema,
      },
    },
  },
  404: {
    description: "Not Found",
    content: {
      "application/json": {
        schema: ErrorResponseSchema,
      },
    },
  },
  500: {
    description: "Internal Server Error",
    content: {
      "application/json": {
        schema: ErrorResponseSchema,
      },
    },
  },
};

// =================================================================
// Path Definitions (Chat)
// =================================================================

registry.registerPath({
  method: "post",
  path: "/chat/stream",
  summary: "Chat Streaming",
  description: "Send a query and receive a streaming response.",
  security: [{ BearerAuth: [] }],
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
      description: "Successful stream response (SSE)",
      content: {
        "text/event-stream": {
          schema: z.string().openapi({
            description:
              "Server-Sent Events stream. Events: 'citations', 'text', 'done', 'error'",
          }),
        },
      },
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/chat/feedback",
  summary: "Submit Feedback",
  security: [{ BearerAuth: [] }],
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
      description: "Feedback submitted",
      content: {
        "application/json": {
          schema: ChatSchemas.SubmitFeedbackResponseSchema,
        },
      },
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/chat/sessions",
  summary: "List Sessions",
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      description: "List of chat sessions",
      content: {
        "application/json": {
          schema: ChatSchemas.GetSessionsResponseSchema,
        },
      },
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/chat/sessions/{sessionId}",
  summary: "Get Session Messages",
  security: [{ BearerAuth: [] }],
  request: {
    params: z.object({
      sessionId: z.string(),
    }),
    query: ChatSchemas.GetSessionMessagesQueryParamsSchema,
  },
  responses: {
    200: {
      description: "Session messages",
      content: {
        "application/json": {
          schema: ChatSchemas.GetSessionMessagesResponseSchema,
        },
      },
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "patch",
  path: "/chat/sessions/{sessionId}",
  summary: "Update Session Name",
  security: [{ BearerAuth: [] }],
  request: {
    params: z.object({
      sessionId: z.string(),
    }),
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
      description: "Session updated",
      content: {
        "application/json": {
          schema: ChatSchemas.UpdateSessionNameResponseSchema,
        },
      },
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/chat/sessions/{sessionId}",
  summary: "Delete Session",
  security: [{ BearerAuth: [] }],
  request: {
    params: z.object({
      sessionId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Session deleted",
      content: {
        "application/json": {
          schema: ChatSchemas.DeleteSessionResponseSchema,
        },
      },
    },
    ...commonErrorResponses,
  },
});

// =================================================================
// Path Definitions (Documents)
// =================================================================

registry.registerPath({
  method: "post",
  path: "/documents/upload-request",
  summary: "Request Upload URL",
  security: [{ BearerAuth: [] }],
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
      description: "Upload URL generated",
      content: {
        "application/json": {
          schema: DocumentSchemas.UploadRequestResponseSchema,
        },
      },
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/documents",
  summary: "List Documents",
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      description: "List of documents",
      content: {
        "application/json": {
          schema: DocumentSchemas.GetDocumentsResponseSchema,
        },
      },
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/documents/{id}",
  summary: "Get Document",
  security: [{ BearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Document details",
      content: {
        "application/json": {
          schema: DocumentSchemas.GetDocumentResponseSchema,
        },
      },
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/documents/{id}",
  summary: "Delete Document",
  security: [{ BearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    202: {
      description: "Document deleted",
      content: {
        "application/json": {
          schema: DocumentSchemas.DeleteDocumentResponseSchema,
        },
      },
    },
    ...commonErrorResponses,
  },
});

registry.registerPath({
  method: "patch",
  path: "/documents/{id}/tags",
  summary: "Update Tags",
  security: [{ BearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string(),
    }),
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
      description: "Tags updated",
      content: {
        "application/json": {
          schema: DocumentSchemas.UpdateTagsResponseSchema,
        },
      },
    },
    ...commonErrorResponses,
  },
});

// =================================================================
// Generation
// =================================================================

const generator = new OpenApiGeneratorV3(registry.definitions);

const document = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "Myelin Base RAG API",
    version: "1.0.0",
    description: "API documentation for Myelin Base RAG backend",
  },
  servers: [{ url: "/api" }],
});

// Output
const outputPath = path.resolve(__dirname, "../../doc/openapi.yaml");

const dir = path.dirname(outputPath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

fs.writeFileSync(outputPath, YAML.stringify(document));
console.log(`Generated OpenAPI document at: ${outputPath}`);
