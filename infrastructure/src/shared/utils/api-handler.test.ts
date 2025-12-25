import { ErrorCode } from "../types/error-code";

import { apiHandler, AppError, streamApiHandler } from "./api-handler";

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
  const mockContext = {} as any;

  // モックイベント作成ヘルパー
  const createEvent = (
    method: string = "GET",
    headers: Record<string, string> = {}
  ) =>
    ({
      httpMethod: method,
      path: "/test",
      headers: {
        origin: "http://localhost:3000",
        ...headers,
      },
      requestContext: { requestId: "req-123" },
    }) as any;

  describe("apiHandler (Standard)", () => {
    it("should return 200 with formatted body on success", async () => {
      const logic = () => Promise.resolve({ message: "success" });
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
      event.headers.origin = "http://evil.com"; // 許可されていないオリジン

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
  });

  describe("streamApiHandler (Streaming - Local Mode)", () => {
    // ローカルモードのテスト (process.env.STAGE = "local" 前提)

    it("should return buffered response with Vercel AI SDK headers in local mode", async () => {
      const logic = (event: any, streamHelper: any) => {
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
      const wrappedHandler = streamApiHandler(logic) as (
        event: any,
        context: any
      ) => Promise<any>;
      const response = await wrappedHandler(createEvent(), mockContext);

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("Hello World");

      // Vercel AI SDK v3 用のヘッダーを確認
      expect(response.headers?.["Content-Type"]).toBe(
        "text/plain; charset=utf-8"
      );
      expect(response.headers?.["X-Vercel-AI-UI-Message-Stream"]).toBe("v1");
      expect(response.headers?.["Cache-Control"]).toBe("no-cache");
      expect(response.headers?.["Connection"]).toBe("keep-alive");
    });

    it("should handle errors in streaming logic", async () => {
      const logic = () =>
        Promise.reject(new AppError(400, ErrorCode.INVALID_PARAMETER));

      const wrappedHandler = streamApiHandler(logic) as (
        event: any,
        context: any
      ) => Promise<any>;
      const response = await wrappedHandler(createEvent(), mockContext);

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.errorCode).toBe(ErrorCode.INVALID_PARAMETER);
    });

    it("should return 403 for CORS error in streaming", async () => {
      const logic = () => Promise.resolve(undefined);
      const wrappedHandler = streamApiHandler(logic) as (
        event: any,
        context: any
      ) => Promise<any>;

      const event = createEvent();
      event.headers.origin = "http://evil.com";

      const response = await wrappedHandler(event, mockContext);

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.errorCode).toBe("CORS_FORBIDDEN");
    });
  });
});
