import {
  DynamoDBDocumentClient as _DynamoDBDocumentClient,
  QueryCommand as _QueryCommand,
  QueryCommandInput,
  UpdateCommand as _UpdateCommand,
  UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, Context } from "aws-lambda";
import { AwsClientStub, mockClient } from "aws-sdk-client-mock";

// 型定義のみインポート（実体は動的インポートで取得）
import type { handler as HandlerType } from "./index";

// awslambdaグローバルオブジェクトの型定義（モック用）
interface HttpResponseStream {
  _buffer: string;
  _statusCode: number;
  write(chunk: Uint8Array | string): void;
  end(): void;
}

interface HttpResponseStreamMetadata {
  statusCode?: number;
}

// モック用の型定義（実際のawslambda型とは異なるため、Partialを使用）
type AwslambdaMock = Partial<{
  streamifyResponse: (
    handler: (
      event: APIGatewayProxyEvent,
      responseStream: HttpResponseStream,
      context: Context
    ) => Promise<void>
  ) => (
    event: APIGatewayProxyEvent,
    context: Context
  ) => Promise<{ statusCode: number; body: string }>;
  HttpResponseStream: {
    from: (
      stream: HttpResponseStream,
      metadata: HttpResponseStreamMetadata
    ) => HttpResponseStream;
  };
}>;

describe("Chat Function Integration Tests", () => {
  const ORIGINAL_ENV = process.env;
  let handler: typeof HandlerType;
  let ddbMock: AwsClientStub<_DynamoDBDocumentClient>;

  // コマンドクラスの参照を保持（動的に取得するため変数化）
  let QueryCommand: typeof _QueryCommand;
  let UpdateCommand: typeof _UpdateCommand;

  beforeEach(async () => {
    // 1. モジュールキャッシュのリセット
    jest.resetModules();

    // ------------------------------------------------------------------
    // AWS Lambda Response Streaming (awslambda) のモック設定
    // ------------------------------------------------------------------
    const awslambdaMock: AwslambdaMock = {
      streamifyResponse: (
        handler: (
          event: APIGatewayProxyEvent,
          responseStream: HttpResponseStream,
          context: Context
        ) => Promise<void>
      ) => {
        return async (event: APIGatewayProxyEvent, context: Context) => {
          const responseStreamMock: HttpResponseStream = {
            _buffer: "",
            _statusCode: 200,
            write: function (chunk: Uint8Array | string) {
              const text =
                chunk instanceof Uint8Array
                  ? new TextDecoder().decode(chunk)
                  : chunk.toString();
              this._buffer += text;
            },
            end: function () {},
          };

          await handler(event, responseStreamMock, context);

          return {
            statusCode: responseStreamMock._statusCode,
            body: responseStreamMock._buffer,
          };
        };
      },
      HttpResponseStream: {
        from: (
          stream: HttpResponseStream,
          metadata: HttpResponseStreamMetadata
        ) => {
          if (metadata && metadata.statusCode) {
            stream._statusCode = metadata.statusCode;
          }
          return stream;
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).awslambda = awslambdaMock;

    // 2. 環境変数の設定
    process.env = { ...ORIGINAL_ENV };
    process.env.TABLE_NAME = "ChatHistoryTable";
    process.env.STAGE = "prod"; // 'prod' にすることで IS_LOCAL_STAGE が false になり、認証ロジックが走る
    process.env.USE_MOCK_AUTH = "false";
    process.env.ALLOWED_ORIGINS = "http://localhost:3000";
    process.env.AWS_REGION = "ap-northeast-1";

    // 3. AWS SDKの動的インポートとモック作成
    const ddbModule = await import("@aws-sdk/lib-dynamodb");
    const { DynamoDBDocumentClient } = ddbModule;
    QueryCommand = ddbModule.QueryCommand;
    UpdateCommand = ddbModule.UpdateCommand;

    ddbMock = mockClient(
      DynamoDBDocumentClient
    ) as unknown as AwsClientStub<_DynamoDBDocumentClient>;

    // 5. ハンドラーの動的インポート
    const indexModule = await import("./index");
    handler = indexModule.handler;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (global as any).awslambda;
  });

  /**
   * イベント作成ヘルパー
   * 修正点: requestContextにauthorizerを追加し、認証情報を模倣する
   */
  const createEvent = (
    method: string,
    path: string,
    body: Record<string, unknown> | null = null,
    pathParams: Record<string, string> | null = null,
    queryParams: Record<string, string> | null = null
  ): APIGatewayProxyEvent => {
    return {
      httpMethod: method,
      path: path,
      pathParameters: pathParams,
      queryStringParameters: queryParams,
      headers: {
        Authorization: "Bearer valid-token",
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
      },
      body: body ? JSON.stringify(body) : null,
      requestContext: {
        requestId: "req-123",
        accountId: "123456789012",
        apiId: "test-api",
        stage: "test",
        resourceId: "test-resource",
        resourcePath: path,
        httpMethod: method,
        // ここが重要: 認証情報を追加
        authorizer: {
          claims: {
            sub: "user-123", // テストで使用するデフォルトのオーナーID
            email: "test@example.com",
          },
        },
        identity: {
          sourceIp: "127.0.0.1",
          userAgent: "test-agent",
          accessKey: null,
          accountId: null,
          apiKey: null,
          apiKeyId: null,
          caller: null,
          clientCert: null,
          cognitoAuthenticationProvider: null,
          cognitoAuthenticationType: null,
          cognitoIdentityId: null,
          cognitoIdentityPoolId: null,
          principalOrgId: null,
          user: null,
          userArn: null,
        },
        path,
        protocol: "HTTP/1.1",
        requestTimeEpoch: Date.now(),
      } as APIGatewayProxyEvent["requestContext"], // 型アサーションで無理やり合わせる場合あり（Lambdaの型定義による）
      isBase64Encoded: false,
      multiValueHeaders: {},
      multiValueQueryStringParameters: null,
      stageVariables: null,
      resource: path,
    };
  };

  /**
   * ハンドラー実行ヘルパー
   */
  const invokeHandler = async (
    event: APIGatewayProxyEvent
  ): Promise<{ statusCode: number; body: string }> => {
    const localHandler = handler as unknown as (
      event: APIGatewayProxyEvent,
      context: Context
    ) => Promise<{ statusCode: number; body: string }>;
    const context: Context = {
      callbackWaitsForEmptyEventLoop: false,
      functionName: "test-function",
      functionVersion: "1",
      invokedFunctionArn:
        "arn:aws:lambda:ap-northeast-1:123456789012:function:test",
      memoryLimitInMB: "128",
      awsRequestId: "test-request-id",
      logGroupName: "/aws/lambda/test",
      logStreamName: "test-stream",
      getRemainingTimeInMillis: () => 30000,
      done: () => {},
      fail: () => {},
      succeed: () => {},
    };
    return localHandler(event, context);
  };

  // ==========================================
  // POST /chat/feedback
  // ==========================================
  describe("POST /chat/feedback", () => {
    it("should update feedback successfully", async () => {
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          pk: "SESSION#session-1",
          sk: "MSG#2024-01-01T00:00:00Z",
          historyId: "msg-1",
          sessionId: "session-1",
          ownerId: "user-123",
          userQuery: "Test query",
          aiResponse: "Test response",
          sourceDocuments: [],
          feedback: "GOOD",
          createdAt: "2024-01-01T00:00:00Z",
        },
      });

      const body = {
        sessionId: "session-1",
        historyId: "msg-1",
        createdAt: "2024-01-01T00:00:00Z",
        evaluation: "GOOD",
        comment: "Nice",
      };

      const event = createEvent("POST", "/chat/feedback", body);
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(204);
      expect(result.body).toBe("{}");

      // DynamoDB Update確認
      const callArgs = ddbMock.call(0).args[0].input as UpdateCommandInput;
      expect(callArgs.Key?.pk).toBe("SESSION#session-1");
      expect(callArgs.Key?.sk).toBe("MSG#2024-01-01T00:00:00Z");
      expect(callArgs.ExpressionAttributeValues?.[":evaluation"]).toBe("GOOD");
    });
  });

  // ==========================================
  // GET /chat/sessions
  // ==========================================
  describe("GET /chat/sessions", () => {
    it("should return list of sessions", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            sessionId: "s1",
            sessionName: "Session 1",
            createdAt: "2024-01-01",
            lastMessageAt: "2024-01-02",
          },
        ],
      });

      const event = createEvent("GET", "/chat/sessions");
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(200);
      const resBody = JSON.parse(result.body);
      expect(resBody.sessions).toHaveLength(1);
      expect(resBody.sessions[0].sessionId).toBe("s1");

      const callArgs = ddbMock.call(0).args[0].input as QueryCommandInput;
      expect(callArgs.IndexName).toBe("GSI1");
      expect(callArgs.ExpressionAttributeValues?.[":userKey"]).toBe(
        "USER#user-123"
      );
    });
  });

  // ==========================================
  // GET /chat/sessions/{sessionId} (Messages)
  // ==========================================
  describe("GET /chat/sessions/{sessionId}", () => {
    it("should return messages with pagination cursor", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            pk: "SESSION#session-1",
            sk: "MSG#2024-01-01T00:00:00Z",
            historyId: "msg-1",
            sessionId: "session-1",
            ownerId: "user-123",
            userQuery: "Hi",
            aiResponse: "Hello",
            sourceDocuments: [],
            feedback: "NONE",
            createdAt: "2024-01-01T00:00:00Z",
          },
        ],
        LastEvaluatedKey: { pk: "key", sk: "key" },
      });

      // Test with limit and cursor
      const validCursor = Buffer.from(
        JSON.stringify({ pk: "key", sk: "key" })
      ).toString("base64");
      const event = createEvent(
        "GET",
        "/chat/sessions/session-1",
        null,
        { sessionId: "session-1" },
        { limit: "10", cursor: validCursor }
      );

      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(200);
      const resBody = JSON.parse(result.body);
      expect(resBody.sessionId).toBe("session-1");
      expect(resBody.messages).toHaveLength(1);
      expect(resBody.nextCursor).toBeDefined();

      // DynamoDB Query args verification
      const callArgs = ddbMock.call(0).args[0].input as QueryCommandInput;
      expect(callArgs.Limit).toBe(10);
      expect(callArgs.ExclusiveStartKey).toBeDefined(); // cursor is decoded
    });

    it("should return 404 if accessing other user's session", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            historyId: "msg-1",
            ownerId: "other-user", // Owner mismatch
          },
        ],
      });

      const event = createEvent("GET", "/chat/sessions/session-1", null, {
        sessionId: "session-1",
      });
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(404);
    });
  });

  // ==========================================
  // PATCH /chat/sessions/{sessionId} (Rename)
  // ==========================================
  describe("PATCH /chat/sessions/{sessionId}", () => {
    it("should update session name", async () => {
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          sessionId: "session-1",
          sessionName: "New Name",
        },
      });

      const body = { sessionName: "New Name" };
      const event = createEvent("PATCH", "/chat/sessions/session-1", body, {
        sessionId: "session-1",
      });
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(204);
      expect(result.body).toBe("{}");
    });
  });

  // ==========================================
  // DELETE /chat/sessions/{sessionId}
  // ==========================================
  describe("DELETE /chat/sessions/{sessionId}", () => {
    it("should logically delete session", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const event = createEvent("DELETE", "/chat/sessions/session-1", null, {
        sessionId: "session-1",
      });
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(204);
      expect(result.body).toBe("{}");

      // Verify Soft Delete (TTL set, deletedAt set, GSI keys removed)
      const callArgs = ddbMock.call(0).args[0].input as UpdateCommandInput;
      expect(callArgs.UpdateExpression).toContain("SET deletedAt = :now");
      expect(callArgs.UpdateExpression).toContain("REMOVE gsi1pk, gsi1sk");
    });
  });
});
