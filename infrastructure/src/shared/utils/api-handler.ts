import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import { ZodType } from "zod";

import { ErrorCode } from "../types/error-code";

import { CorsHeaders, getCorsHeaders } from "./response";

interface LambdaStreamMetadata {
  statusCode: number;
  headers?: Record<string, string | boolean>;
}

interface LambdaWritableStream {
  write: (chunk: string | Uint8Array) => void;
  end: () => void;
}

declare const awslambda: {
  streamifyResponse: (
    handler: (
      event: APIGatewayProxyEvent,
      responseStream: LambdaWritableStream,
      context: Context
    ) => Promise<void>
  ) => (
    event: APIGatewayProxyEvent,
    context: Context
  ) => Promise<APIGatewayProxyResult>;
  HttpResponseStream: {
    from: (
      stream: LambdaWritableStream,
      metadata: LambdaStreamMetadata
    ) => LambdaWritableStream;
  };
};

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public errorCode?: ErrorCode,
    public details?: Record<string, unknown>
  ) {
    super(errorCode || `HTTP_${statusCode}`);
    this.name = "AppError";
  }
}

function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  // Error型のインスタンスかチェック
  if (error instanceof Error) {
    if (error.name === "ConditionalCheckFailedException") {
      return new AppError(404, ErrorCode.RESOURCE_NOT_FOUND);
    }
    const unknownError = new AppError(500, ErrorCode.INTERNAL_SERVER_ERROR);
    unknownError.stack = error.stack;
    unknownError.message = error.message;
    return unknownError;
  }

  // Error型でない場合
  const unknownError = new AppError(500, ErrorCode.INTERNAL_SERVER_ERROR);
  unknownError.message = String(error);
  return unknownError;
}

export function logger(
  level: "WARN" | "ERROR",
  message: string,
  context: Record<string, unknown> = {}
) {
  const logPayload = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...context,
  };

  if (level === "ERROR") {
    console.error(JSON.stringify(logPayload));
  }
  if (level === "WARN") {
    console.warn(JSON.stringify(logPayload));
  }
}

function logApiError(
  error: unknown,
  event: APIGatewayProxyEvent,
  statusCode: number,
  errorCode?: string
) {
  const level = statusCode >= 500 ? "ERROR" : "WARN";
  const details = error instanceof AppError ? error.details : {};

  logger(level, error instanceof Error ? error.message : "API Error", {
    path: event.path,
    method: event.httpMethod,
    statusCode,
    errorCode,
    errorName: error instanceof Error ? error.name : "UnknownError",
    stack:
      statusCode >= 500 && error instanceof Error ? error.stack : undefined,
    requestId: event.requestContext?.requestId,
    ...details,
  });
}

export function validateJson<T>(body: string | null, schema: ZodType<T>): T {
  if (!body) {
    throw new AppError(400, ErrorCode.MISSING_PARAMETER);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AppError(400, ErrorCode.INVALID_PARAMETER);
  }

  const result = schema.safeParse(parsed);

  if (!result.success) {
    const errorCode = result.error.issues[0].message;
    const finalErrorCode = (Object.values(ErrorCode) as string[]).includes(
      errorCode
    )
      ? (errorCode as ErrorCode)
      : ErrorCode.VALIDATION_FAILED;

    const error = new AppError(400, finalErrorCode);
    if (finalErrorCode === ErrorCode.VALIDATION_FAILED) {
      error.message = errorCode;
    }
    throw error;
  }

  return result.data;
}

interface ApiHandlerResult {
  statusCode?: number;
  body?: unknown;
}

type LogicFunction = (
  event: APIGatewayProxyEvent,
  context: Context
) => Promise<ApiHandlerResult | Record<string, unknown> | unknown>;

export const apiHandler = (logic: LogicFunction) => {
  return async (
    event: APIGatewayProxyEvent,
    context: Context
  ): Promise<APIGatewayProxyResult> => {
    const origin = event.headers?.origin || event.headers?.Origin || "";
    const corsHeaders = getCorsHeaders(origin);

    if (!corsHeaders) {
      return {
        statusCode: 403,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "null",
        },
        body: JSON.stringify({
          message: "Forbidden",
          errorCode: "CORS_FORBIDDEN",
        }),
      };
    }

    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
          "Access-Control-Max-Age": "86400",
        },
        body: JSON.stringify({}),
      };
    }

    try {
      const result = (await logic(event, context)) as ApiHandlerResult | null;
      return {
        statusCode: result?.statusCode || 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
        body: JSON.stringify(result?.body || result || {}),
      };
    } catch (rawError: unknown) {
      const error = normalizeError(rawError);
      logApiError(error, event, error.statusCode, error.errorCode);

      const errorHeaders: Record<string, string | boolean> = {
        "Content-Type": "application/json",
        ...corsHeaders,
      };

      return {
        statusCode: error.statusCode,
        headers: errorHeaders,
        body: JSON.stringify({
          errorCode: error.errorCode,
        }),
      };
    }
  };
};

export interface StreamWriter {
  write: (chunk: string | Uint8Array) => void;
  end: () => void;
}

export interface StreamHelper {
  init: (statusCode?: number, contentType?: string) => StreamWriter;
}

type StreamLogicFunction = (
  event: APIGatewayProxyEvent,
  streamHelper: StreamHelper,
  context: Context
) => Promise<void>;

/**
 * ストリーミング用ヘッダーを生成
 * Content-Type が application/json の場合はストリーミング関連ヘッダーを除外
 */
function buildStreamHeaders(
  corsHeaders: CorsHeaders,
  contentType: string
): Record<string, string | boolean> {
  const isJsonResponse = contentType.includes("application/json");

  // JSON レスポンスの場合はストリーミング関連ヘッダーを除外
  if (isJsonResponse) {
    return {
      ...corsHeaders,
      "Content-Type": contentType,
    };
  }

  // ストリーミングレスポンス（text/plain 等）の場合は v3.x ヘッダーを含める
  return {
    ...corsHeaders,
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // v3.x で必要なヘッダー
    "X-Vercel-AI-UI-Message-Stream": "v1",
    "X-Accel-Buffering": "no",
  };
}

export const streamApiHandler = (logic: StreamLogicFunction) => {
  const IS_LOCAL_STAGE = process.env.STAGE === "local";

  if (!IS_LOCAL_STAGE) {
    // AWS Lambda Response Streaming
    return awslambda.streamifyResponse(
      async (
        event: APIGatewayProxyEvent,
        responseStream: LambdaWritableStream,
        context: Context
      ) => {
        let isHeadersSent = false;
        let currentStream: LambdaWritableStream = responseStream;

        const origin = event.headers?.origin || event.headers?.Origin || "";
        const corsHeaders = getCorsHeaders(origin);

        if (!corsHeaders) {
          currentStream = awslambda.HttpResponseStream.from(responseStream, {
            statusCode: 403,
          });
          currentStream.write(JSON.stringify({ message: "Forbidden" }));
          currentStream.end();
          return;
        }

        const streamHelper: StreamHelper = {
          init: (
            statusCode = 200,
            contentType = "text/plain; charset=utf-8"
          ): StreamWriter => {
            if (isHeadersSent) return currentStream;

            const metadata: LambdaStreamMetadata = {
              statusCode,
              headers: buildStreamHeaders(corsHeaders, contentType),
            };

            currentStream = awslambda.HttpResponseStream.from(
              responseStream,
              metadata
            );
            isHeadersSent = true;
            return currentStream;
          },
        };

        try {
          if (event.httpMethod === "OPTIONS") {
            streamHelper.init(200);
            currentStream.end();
            return;
          }

          await logic(event, streamHelper, context);
        } catch (rawError: unknown) {
          const error = normalizeError(rawError);
          logApiError(error, event, error.statusCode, error.errorCode);

          if (isHeadersSent) {
            // 既にヘッダー送信済みの場合は、v3.x 形式でエラーを送信
            // { "type": "error", "errorText": "..." }
            try {
              currentStream.write(
                JSON.stringify({
                  type: "error",
                  errorText: error.errorCode || "UNKNOWN_ERROR",
                }) + "\n"
              );
            } catch {
              // 書き込み失敗時は無視
            }
            currentStream.end();
            return;
          }

          try {
            const metadata: LambdaStreamMetadata = {
              statusCode: error.statusCode,
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
              },
            };
            currentStream = awslambda.HttpResponseStream.from(
              responseStream,
              metadata
            );
            currentStream.write(
              JSON.stringify({ errorCode: error.errorCode || "UNKNOWN_ERROR" })
            );
            currentStream.end();
          } catch {
            responseStream.end();
          }
        }
      }
    );
  }

  // Local Polyfill
  return async (
    event: APIGatewayProxyEvent,
    context: Context
  ): Promise<APIGatewayProxyResult> => {
    let responseBuffer = "";
    let responseStatusCode = 200;
    let responseHeaders: Record<string, string | boolean> = {};
    let isInit = false;

    const origin = event.headers?.origin || event.headers?.Origin || "";
    const corsHeaders = getCorsHeaders(origin);

    if (!corsHeaders) {
      return {
        statusCode: 403,
        headers: { "Access-Control-Allow-Origin": "null" },
        body: JSON.stringify({ errorCode: "CORS_FORBIDDEN" }),
      };
    }

    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
        body: JSON.stringify({}),
      };
    }

    const mockStream: StreamWriter = {
      write: (chunk: string | Uint8Array) => {
        const text =
          chunk instanceof Uint8Array
            ? new TextDecoder().decode(chunk)
            : chunk.toString();
        responseBuffer += text;
      },
      end: () => {
        /* noop */
      },
    };

    const streamHelper: StreamHelper = {
      init: (
        statusCode = 200,
        contentType = "text/plain; charset=utf-8"
      ): StreamWriter => {
        if (isInit) return mockStream;
        responseStatusCode = statusCode;
        // Content-Type に応じてヘッダーを構築
        // 型アサーションを追加: CorsHeaders を Record<string, string | boolean> として扱う
        responseHeaders = buildStreamHeaders(
          corsHeaders as CorsHeaders,
          contentType
        );
        isInit = true;
        return mockStream;
      },
    };

    try {
      await logic(event, streamHelper, context);
      return {
        statusCode: responseStatusCode,
        headers: responseHeaders,
        body: responseBuffer,
      };
    } catch (rawError: unknown) {
      const error = normalizeError(rawError);
      return {
        statusCode: error.statusCode,
        headers: { "Content-Type": "application/json", ...corsHeaders },
        body: JSON.stringify({ errorCode: error.errorCode }),
      };
    }
  };
};
