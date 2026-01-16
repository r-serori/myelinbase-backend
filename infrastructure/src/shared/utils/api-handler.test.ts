import { APIGatewayProxyEvent, Context } from "aws-lambda";
import { z } from "zod";

import { ErrorCode } from "../types/error-code";

import {
  apiHandler,
  AppError,
  logger,
  streamApiHandler,
  StreamHelper,
  validateJson,
} from "./api-handler";

// テスト用の環境変数設定
process.env.ALLOWED_ORIGINS = "http://localhost:3000";
// streamApiHandlerのローカルモードテストのためにSTAGEを設定
process.env.STAGE = "local";

// api-handler内での process.env 読み込みタイミングの問題を回避するために
// response.ts をモック化して getCorsHeaders の挙動を制御します。
jest.mock("./response", () => {
  return {
    getCorsHeaders: (origin: string) => {
      if (origin === "http://localhost:3000") {
        return {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        };
      }
      return undefined;
    },
  };
});

describe("API Handler Utils", () => {
  const mockContext: Context = {
    callbackWaitsForEmptyEventLoop: false,
    functionName: "test",
    functionVersion: "1",
    invokedFunctionArn:
      "arn:aws:lambda:ap-northeast-1:123456789012:function:test",
    memoryLimitInMB: "128",
    awsRequestId: "test-request-id",
    logGroupName: "/aws/lambda/test",
    logStreamName: "2021/01/01/[$LATEST]test",
    getRemainingTimeInMillis: () => 30000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };

  // モックイベント作成ヘルパー
  const createEvent = (
    method: string = "GET",
    headers: Record<string, string> = {}
  ): APIGatewayProxyEvent =>
    ({
      httpMethod: method,
      path: "/test",
      headers: {
        origin: "http://localhost:3000",
        ...headers,
      },
      requestContext: { requestId: "req-123" },
      body: null,
      isBase64Encoded: false,
      pathParameters: null,
      queryStringParameters: null,
      multiValueHeaders: {},
      multiValueQueryStringParameters: null,
      stageVariables: null,
      resource: "",
    }) as unknown as APIGatewayProxyEvent;

  describe("apiHandler (Standard)", () => {
    it("should return 200 with formatted body on success", async () => {
      const logic = () => Promise.resolve({ body: { message: "success" } });
      const wrappedHandler = apiHandler(logic);

      const response = await wrappedHandler(createEvent(), mockContext);

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ message: "success" });
      expect(response.headers?.["Access-Control-Allow-Origin"]).toBe(
        "http://localhost:3000"
      );
    });

    it("should handle AppError correctly (Client Error)", async () => {
      const logic = () =>
        Promise.reject(new AppError(400, ErrorCode.INVALID_PARAMETER));
      const wrappedHandler = apiHandler(logic);

      const response = await wrappedHandler(createEvent(), mockContext);

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.errorCode).toBe(ErrorCode.INVALID_PARAMETER);
    });

    it("should handle unexpected errors as 500 (Server Error)", async () => {
      const logic = () =>
        Promise.reject(new Error("Unexpected database failure"));
      const wrappedHandler = apiHandler(logic);

      const response = await wrappedHandler(createEvent(), mockContext);

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body);
      expect(body.errorCode).toBe(ErrorCode.INTERNAL_SERVER_ERROR);
    });

    it("should return 403 for CORS error if origin is not allowed", async () => {
      const logic = () => Promise.resolve({});
      const wrappedHandler = apiHandler(logic);

      const event = createEvent();
      event.headers.origin = "http://evil.com";

      const response = await wrappedHandler(event, mockContext);

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).message).toBe("Forbidden");
    });

    it("should handle OPTIONS request (CORS Preflight)", async () => {
      const logic = () => Promise.resolve({});
      const wrappedHandler = apiHandler(logic);

      const event = createEvent("OPTIONS");
      const response = await wrappedHandler(event, mockContext);

      expect(response.statusCode).toBe(200);
      expect(response.headers?.["Access-Control-Allow-Methods"]).toBeDefined();
    });

    it("should return empty object body when logic returns null", async () => {
      const logic = () => Promise.resolve(null);
      const wrappedHandler = apiHandler(logic);

      const response = await wrappedHandler(createEvent(), mockContext);

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(JSON.stringify({}));
    });

    it("should map ConditionalCheckFailedException to RESOURCE_NOT_FOUND", async () => {
      const error = new Error("Conditional failed");
      error.name = "ConditionalCheckFailedException";

      const logic = () => Promise.reject(error);
      const wrappedHandler = apiHandler(logic);

      const res = await wrappedHandler(createEvent(), mockContext);
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.errorCode).toBe(ErrorCode.RESOURCE_NOT_FOUND);
    });
  });

  describe("streamApiHandler (Streaming - Local Mode)", () => {
    // ローカルモードのテスト (process.env.STAGE = "local" 前提)

    it("should return buffered response with Vercel AI SDK headers in local mode", async () => {
      const logic = (
        _event: APIGatewayProxyEvent,
        streamHelper: StreamHelper
      ) => {
        // デフォルトのcontentType等はinitで設定される
        const stream = streamHelper.init();
        stream.write("Hello");
        stream.write(" ");
        stream.write("World");
        stream.end();
        return Promise.resolve();
      };

      // TypeScriptがAWS Lambdaのストリーミング型（3引数）と推論してしまう場合があるため、
      // ローカルPolyfillの型（2引数）に明示的にキャストします。
      type LocalHandler = (
        event: APIGatewayProxyEvent,
        context: Context
      ) => Promise<{
        statusCode: number;
        headers: Record<string, string>;
        body: string;
      }>;

      const wrappedHandler = streamApiHandler(logic) as LocalHandler;
      const response = await wrappedHandler(createEvent(), mockContext);

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("Hello World");

      expect(response.headers?.["Content-Type"]).toBe("text/event-stream");
      expect(response.headers?.["Cache-Control"]).toBe("no-cache");
      expect(response.headers?.["Connection"]).toBe("keep-alive");
    });

    it("should NOT include streaming headers for application/json responses", async () => {
      const logic = (
        _event: APIGatewayProxyEvent,
        streamHelper: StreamHelper
      ) => {
        // JSON レスポンスの場合
        const stream = streamHelper.init(200, "application/json");
        stream.write(JSON.stringify({ sessions: [] }));
        stream.end();
        return Promise.resolve();
      };

      type LocalHandler = (
        event: APIGatewayProxyEvent,
        context: Context
      ) => Promise<{
        statusCode: number;
        headers: Record<string, string | boolean>;
        body: string;
      }>;

      const wrappedHandler = streamApiHandler(logic) as LocalHandler;
      const response = await wrappedHandler(createEvent(), mockContext);

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ sessions: [] });

      // JSON レスポンスの場合はストリーミングヘッダーが含まれないことを確認
      expect(response.headers?.["Content-Type"]).toBe("application/json");
      expect(
        response.headers?.["X-Vercel-AI-UI-Message-Stream"]
      ).toBeUndefined();
      expect(response.headers?.["X-Accel-Buffering"]).toBeUndefined();
      expect(response.headers?.["Cache-Control"]).toBeUndefined();
      expect(response.headers?.["Connection"]).toBeUndefined();

      // CORS ヘッダーは含まれることを確認
      expect(response.headers?.["Access-Control-Allow-Origin"]).toBe(
        "http://localhost:3000"
      );
    });

    it("should handle errors in streaming logic", async () => {
      const logic = () =>
        Promise.reject(new AppError(400, ErrorCode.INVALID_PARAMETER));

      type LocalHandler = (
        event: APIGatewayProxyEvent,
        context: Context
      ) => Promise<{ statusCode: number; body: string }>;

      const wrappedHandler = streamApiHandler(logic) as LocalHandler;
      const response = await wrappedHandler(createEvent(), mockContext);

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.errorCode).toBe(ErrorCode.INVALID_PARAMETER);
    });

    it("should return 403 for CORS error in streaming", async () => {
      const logic = () => Promise.resolve(undefined);

      type LocalHandler = (
        event: APIGatewayProxyEvent,
        context: Context
      ) => Promise<{ statusCode: number; body: string }>;

      const wrappedHandler = streamApiHandler(logic) as LocalHandler;

      const event = createEvent();
      event.headers.origin = "http://evil.com";

      const response = await wrappedHandler(event, mockContext);

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.errorCode).toBe("CORS_FORBIDDEN");
    });
  });

  describe("validateJson", () => {
    it("should parse and validate JSON body with schema", () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });

      const result = validateJson('{"name":"Alice","age":30}', schema);
      expect(result).toEqual({ name: "Alice", age: 30 });
    });

    it("should throw AppError with MISSING_PARAMETER when body is null", () => {
      const schema = z.object({ value: z.string() });

      expect(() => validateJson(null, schema)).toThrow(AppError);
      try {
        validateJson(null, schema);
      } catch (err) {
        const appError = err as AppError;
        expect(appError.statusCode).toBe(400);
        expect(appError.errorCode).toBe(ErrorCode.MISSING_PARAMETER);
      }
    });

    it("should throw AppError with INVALID_PARAMETER for invalid JSON", () => {
      const schema = z.object({ value: z.string() });

      expect(() => validateJson("invalid-json", schema)).toThrow(AppError);
      try {
        validateJson("invalid-json", schema);
      } catch (err) {
        const appError = err as AppError;
        expect(appError.statusCode).toBe(400);
        expect(appError.errorCode).toBe(ErrorCode.INVALID_PARAMETER);
      }
    });

    it("should throw AppError with schema-specified error code if it matches ErrorCode", () => {
      const schema = z.object({
        value: z.string().min(1, ErrorCode.INVALID_PARAMETER),
      });

      expect(() => validateJson('{"value":""}', schema)).toThrow(AppError);
      try {
        validateJson('{"value":""}', schema);
      } catch (err) {
        const appError = err as AppError;
        expect(appError.statusCode).toBe(400);
        expect(appError.errorCode).toBe(ErrorCode.INVALID_PARAMETER);
      }
    });

    it("should use VALIDATION_FAILED when schema message is not a known ErrorCode", () => {
      const schema = z.object({
        value: z.string().min(1, "CUSTOM_MESSAGE"),
      });

      expect(() => validateJson('{"value":""}', schema)).toThrow(AppError);
      try {
        validateJson('{"value":""}', schema);
      } catch (err) {
        const appError = err as AppError;
        expect(appError.statusCode).toBe(400);
        expect(appError.errorCode).toBe(ErrorCode.VALIDATION_FAILED);
        expect(appError.message).toBe("CUSTOM_MESSAGE");
      }
    });
  });

  describe("logger", () => {
    const originalError = console.error;
    const originalWarn = console.warn;

    beforeEach(() => {
      console.error = jest.fn();
      console.warn = jest.fn();
    });

    afterEach(() => {
      console.error = originalError;
      console.warn = originalWarn;
    });

    it("should log ERROR level with JSON payload", () => {
      logger("ERROR", "Something went wrong", { foo: "bar" });

      expect(console.error).toHaveBeenCalledTimes(1);
      const logged = (console.error as jest.Mock).mock.calls[0][0];
      const parsed = JSON.parse(logged);
      expect(parsed.level).toBe("ERROR");
      expect(parsed.message).toBe("Something went wrong");
      expect(parsed.foo).toBe("bar");
      expect(typeof parsed.timestamp).toBe("string");
    });

    it("should log WARN level with JSON payload", () => {
      logger("WARN", "Be careful", { context: "test" });

      expect(console.warn).toHaveBeenCalledTimes(1);
      const logged = (console.warn as jest.Mock).mock.calls[0][0];
      const parsed = JSON.parse(logged);
      expect(parsed.level).toBe("WARN");
      expect(parsed.message).toBe("Be careful");
      expect(parsed.context).toBe("test");
      expect(typeof parsed.timestamp).toBe("string");
    });
  });
});
