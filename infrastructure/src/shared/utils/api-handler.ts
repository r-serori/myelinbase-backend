import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import { ZodSchema } from "zod";
import { getCorsHeaders } from "./response";
import { ErrorCode } from "../types/error-code";

export class AppError extends Error {
  // detailsを追加: ログに出したい追加情報（ownerIdなど）をここに詰める
  constructor(
    public statusCode: number,
    public errorCode?: ErrorCode,
    public details?: Record<string, any>
  ) {
    super(errorCode || `HTTP_${statusCode}`);
    this.name = "AppError";
  }
}

// =================================================================
// 共通ロガー (Structured Logger)
// =================================================================

function normalizeError(error: any): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error.name === "ConditionalCheckFailedException") {
    return new AppError(404, ErrorCode.RESOURCE_NOT_FOUND);
  }

  const unknownError = new AppError(500, ErrorCode.INTERNAL_SERVER_ERROR);
  unknownError.stack = error.stack;
  unknownError.message = error.message;
  return unknownError;
}

/**
 * 構造化ログを出力するヘルパー
 * @param level ログレベル
 * @param message ログメッセージ（定型文推奨）
 * @param context 変動する値（ownerId, fileName, errorオブジェクトなど）
 */
export function logger(
  level: "WARN" | "ERROR",
  message: string,
  context: Record<string, any> = {}
) {
  const logPayload = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...context, // contextを展開してフラットなJSONにする
  };

  if (level === "ERROR") {
    console.error(JSON.stringify(logPayload));
  }
  if (level === "WARN") {
    console.warn(JSON.stringify(logPayload));
  }
}

// apiHandler内部で使うエラーロガー
function logApiError(
  error: any,
  event: any,
  statusCode: number,
  errorCode?: string
) {
  const level = statusCode >= 500 ? "ERROR" : "WARN";

  // AppErrorがdetails（ownerIdなど）を持っていればログに含める
  const details = error instanceof AppError ? error.details : {};

  logger(level, error.message || "API Error", {
    path: event.path,
    method: event.httpMethod,
    statusCode,
    errorCode,
    errorName: error.name,
    stack: statusCode >= 500 ? error.stack : undefined, // 500系のみスタックトレース
    requestId: event.requestContext?.requestId,
    ...details, // ここで ownerId などを展開
  });
}

// =================================================================
// バリデーションヘルパー
// =================================================================

export function validateJson<T>(body: string | null, schema: ZodSchema<T>): T {
  if (!body) {
    throw new AppError(400, ErrorCode.MISSING_PARAMETER);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new AppError(400, ErrorCode.INVALID_PARAMETER);
  }

  const result = schema.safeParse(parsed);

  if (!result.success) {
    // 最初のイシューのメッセージ（= ErrorCode）を取得
    const errorCode = result.error.issues[0].message;

    logger("WARN", "Validation Error", {
      errors: result.error.format(),
      errorCode,
    });

    // メッセージがErrorCode Enumに含まれるかチェック、またはそのまま渡す
    // バリデーションエラーとして扱うが、具体的なErrorCodeをメッセージとして使う
    // ここでは、ZodのメッセージをそのままErrorCodeとして扱う
    const finalErrorCode = Object.values(ErrorCode).includes(errorCode as any)
      ? (errorCode as ErrorCode)
      : ErrorCode.VALIDATION_FAILED;

    const error = new AppError(400, finalErrorCode);
    if (finalErrorCode === ErrorCode.VALIDATION_FAILED) {
      error.message = errorCode; // ErrorCode定義外のメッセージの場合はそのままメッセージとして設定
    }
    throw error;
  }

  return result.data;
}

// =================================================================
// 標準 API Handler
// =================================================================

type LogicFunction = (
  event: APIGatewayProxyEvent,
  context: Context
) => Promise<any>;

export const apiHandler = (logic: LogicFunction) => {
  return async (
    event: APIGatewayProxyEvent,
    context: Context
  ): Promise<APIGatewayProxyResult> => {
    const origin = event.headers?.origin || event.headers?.Origin || "";
    const corsHeaders = getCorsHeaders(origin);

    // CORS拒否時でも、ブラウザがエラーメッセージを表示できるようにCORSヘッダーを返す
    // ただし、Access-Control-Allow-Originは返さない（セキュリティのため）
    if (!corsHeaders) {
      logger("WARN", "CORS Forbidden", {
        origin,
        path: event.path,
        allowedOrigins: process.env.ALLOWED_ORIGINS,
      });
      return {
        statusCode: 403,
        headers: {
          "Content-Type": "application/json",
          // CORSエラーを明確にするため、最小限のCORSヘッダーのみ返す
          "Access-Control-Allow-Origin": "null",
        },
        body: JSON.stringify({
          message: "Forbidden",
          errorCode: "CORS_FORBIDDEN",
        }),
      };
    }

    if (event.httpMethod === "OPTIONS") {
      // プリフライトリクエスト: CORSヘッダーを確実に返す
      if (!corsHeaders) {
        logger("WARN", "CORS Forbidden (OPTIONS)", {
          origin,
          path: event.path,
          allowedOrigins: process.env.ALLOWED_ORIGINS,
        });
        return {
          statusCode: 403,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "null",
            "Access-Control-Allow-Methods": "OPTIONS,POST,GET,PATCH,DELETE",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
          },
          body: JSON.stringify({ errorCode: "CORS_FORBIDDEN" }),
        };
      }
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
          // プリフライトリクエストには追加のヘッダーも必要
          "Access-Control-Max-Age": "86400", // 24時間
        },
        body: JSON.stringify({}),
      };
    }

    try {
      const result = await logic(event, context);

      return {
        statusCode: result?.statusCode || 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
        body: JSON.stringify(result?.body || result || {}),
      };
    } catch (rawError: any) {
      const error = normalizeError(rawError);

      const statusCode = error.statusCode;
      const errorCode = error.errorCode;
      const message = error.message;

      logApiError(error, event, statusCode, errorCode);

      // エラー時でもCORSヘッダーを返す（corsHeadersがundefinedの場合でも）
      const errorHeaders: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (corsHeaders) {
        Object.assign(errorHeaders, corsHeaders);
      } else {
        // CORS拒否時でも、ブラウザがエラーメッセージを表示できるように最小限のヘッダーを返す
        errorHeaders["Access-Control-Allow-Origin"] = "null";
      }

      return {
        statusCode,
        headers: errorHeaders,
        body: JSON.stringify({ errorCode, message }),
      };
    }
  };
};

// =================================================================
// Streaming API Handler
// =================================================================

export interface StreamHelper {
  init: (statusCode?: number, contentType?: string) => any;
}

type StreamLogicFunction = (
  event: any,
  streamHelper: StreamHelper,
  context: Context
) => Promise<void>;

export const streamApiHandler = (logic: StreamLogicFunction) => {
  const IS_LOCAL =
    process.env.AWS_SAM_LOCAL === "true" || process.env.STAGE === "local";

  // [A] ローカル環境用ポリフィル
  if (IS_LOCAL) {
    return async (
      event: any,
      context: Context
    ): Promise<APIGatewayProxyResult> => {
      let responseBuffer = "";
      let responseStatusCode = 200;
      let responseHeaders: any = {};
      let isInit = false;

      const origin = event.headers?.origin || event.headers?.Origin || "";
      const corsHeaders = getCorsHeaders(origin);

      if (!corsHeaders) {
        logger("WARN", "CORS Forbidden (stream)", {
          origin,
          path: event.path,
          allowedOrigins: process.env.ALLOWED_ORIGINS,
        });
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
          headers: { "Content-Type": "application/json", ...corsHeaders },
          body: JSON.stringify({}),
        };
      }

      const mockStream = {
        write: (chunk: any) => {
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
        init: (statusCode = 200, contentType = "application/json") => {
          if (isInit) return mockStream;
          responseStatusCode = statusCode;
          responseHeaders = {
            ...corsHeaders,
            "Content-Type": contentType,
          };
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
      } catch (rawError: any) {
        const error = normalizeError(rawError);

        const statusCode = error.statusCode;
        const errorCode = error.errorCode;

        logApiError(error, event, statusCode, errorCode);

        return {
          statusCode,
          headers: { "Content-Type": "application/json", ...corsHeaders },
          body: JSON.stringify({ errorCode }),
        };
      }
    };
  }

  // [B] 本番環境用ストリーミング
  return awslambda.streamifyResponse(
    async (event: any, responseStream: any, context: Context) => {
      let isHeadersSent = false;
      let currentStream = responseStream;

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
        init: (statusCode = 200, contentType = "application/json") => {
          if (isHeadersSent) return currentStream;

          const metadata = {
            statusCode,
            headers: {
              ...corsHeaders,
              "Content-Type": contentType,
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
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
      } catch (rawError: any) {
        const error = normalizeError(rawError);

        const statusCode = error.statusCode;
        const errorCode = error.errorCode;

        logApiError(error, event, statusCode, errorCode);

        if (isHeadersSent) {
          currentStream.end();
          return;
        }

        try {
          const metadata = {
            statusCode: statusCode,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          };
          currentStream = awslambda.HttpResponseStream.from(
            responseStream,
            metadata
          );
          currentStream.write(
            JSON.stringify({ errorCode: errorCode || "UNKNOWN_ERROR" })
          );
          currentStream.end();
        } catch (streamError) {
          responseStream.end();
        }
      }
    }
  );
};
