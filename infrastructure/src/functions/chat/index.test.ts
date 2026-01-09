import {
  DynamoDBDocumentClient as _DynamoDBDocumentClient,
  GetCommand as _GetCommand,
  PutCommand as _PutCommand,
  PutCommandInput,
  UpdateCommand as _UpdateCommand,
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
  let GetCommand: typeof _GetCommand;
  let PutCommand: typeof _PutCommand;
  let UpdateCommand: typeof _UpdateCommand;

  // 共有モジュールのモック関数への参照
  let mockGenerateEmbeddings: jest.Mock;
  let mockInvokeClaudeStream: jest.Mock;
  let mockCreatePineconeClient: jest.Mock;
  let mockGetPineconeApiKey: jest.Mock;
  let mockSearchVectorsByOwner: jest.Mock;
  let mockVerify: jest.Mock;

  beforeEach(async () => {
    // 1. モジュールキャッシュのリセット
    // これにより、テストごとにクリーンな環境でモジュールをロードできます
    jest.resetModules();

    // ------------------------------------------------------------------
    // AWS Lambda Response Streaming (awslambda) のモック設定
    // ------------------------------------------------------------------
    // process.env.STAGE = 'prod' の場合、api-handler内で awslambda.streamifyResponse が呼ばれます。
    // テスト環境には awslambda グローバルオブジェクトが存在しないため、ここでモックします。
    // また、テストの利便性のために、ストリームへの書き込みをキャプチャして
    // 通常の { statusCode, body } 形式のオブジェクトとして返すようにラップします。
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

          // ハンドラー実行（ストリームへの書き込みが行われる）
          await handler(event, responseStreamMock, context);

          // テストでの検証用に、蓄積したバッファとステータスコードを返す
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
    process.env.STAGE = "prod";
    process.env.USE_MOCK_AUTH = "false";
    process.env.USE_BEDROCK = "true";
    process.env.USER_POOL_ID = "ap-northeast-1_dummy";
    process.env.CLIENT_ID = "client_dummy";
    process.env.ALLOWED_ORIGINS = "http://localhost:3000";
    process.env.AWS_REGION = "ap-northeast-1"; // Region missingエラー回避

    // 3. AWS SDKの動的インポートとモック作成
    // resetModules後はSDKのクラスも新しくなるため、テスト内で再importしてクラスを取得します
    const ddbModule = await import("@aws-sdk/lib-dynamodb");
    const { DynamoDBDocumentClient } = ddbModule;
    GetCommand = ddbModule.GetCommand;
    PutCommand = ddbModule.PutCommand;
    UpdateCommand = ddbModule.UpdateCommand;

    // 型不整合回避のためのキャスト（テストコードの堅牢性向上）
    ddbMock = mockClient(
      DynamoDBDocumentClient
    ) as unknown as AwsClientStub<_DynamoDBDocumentClient>;

    // 4. 共有モジュールのモック定義 (jest.doMockを使用)
    // resetModules後なので、jest.mockではなくjest.doMockで動的にモックします
    mockGenerateEmbeddings = jest.fn();
    mockInvokeClaudeStream = jest.fn();
    mockCreatePineconeClient = jest.fn();
    mockGetPineconeApiKey = jest.fn();
    mockSearchVectorsByOwner = jest.fn();
    mockVerify = jest.fn();

    jest.doMock("../../shared/clients/bedrock", () => ({
      generateEmbeddings: mockGenerateEmbeddings,
      invokeClaudeStream: mockInvokeClaudeStream,
    }));

    jest.doMock("../../shared/clients/pinecone", () => ({
      createPineconeClient: mockCreatePineconeClient,
      getPineconeApiKey: mockGetPineconeApiKey,
      searchVectorsByOwner: mockSearchVectorsByOwner,
    }));

    jest.doMock("aws-jwt-verify", () => ({
      CognitoJwtVerifier: {
        create: jest.fn().mockReturnValue({
          verify: mockVerify,
        }),
      },
    }));

    // 5. ハンドラーの動的インポート
    // モック設定後にインポートすることで、モックが適用された依存関係を持つハンドラーを取得します
    const indexModule = await import("./index");
    handler = indexModule.handler;

    // 共通モックのデフォルト動作設定
    mockVerify.mockResolvedValue({ sub: "user-123" });
    mockGetPineconeApiKey.mockResolvedValue("mock-pinecone-key");
    mockGenerateEmbeddings.mockResolvedValue([[0.1, 0.2, 0.3]]);
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (global as any).awslambda; // モックのクリーンアップ
  });

  /**
   * イベント作成ヘルパー
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
      } as APIGatewayProxyEvent["requestContext"],
      isBase64Encoded: false,
      multiValueHeaders: {},
      multiValueQueryStringParameters: null,
      stageVariables: null,
      resource: path,
    };
  };

  /**
   * Vercel AI SDK形式のメッセージ作成ヘルパー
   */
  const createMessageBody = (
    query: string,
    sessionId: string,
    redoHistoryId?: string
  ) => {
    return {
      messages: [
        {
          role: "user",
          parts: [{ type: "text", text: query }],
        },
      ],
      sessionId,
      redoHistoryId,
    };
  };

  /**
   * ハンドラー実行ヘルパー
   * ラムダハンドラーをローカル実行用にキャストして呼び出します
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
  // POST /chat/stream
  // ==========================================
  describe("POST /chat/stream", () => {
    it("should process chat stream with RAG and Small-to-Big deduplication", async () => {
      // 1. Pinecone検索モック (Small to Big: 同じ親を持つチャイルドがヒットしたケース)
      mockSearchVectorsByOwner.mockResolvedValue([
        {
          score: 0.95,
          metadata: {
            documentId: "doc-1",
            fileName: "manual.pdf",
            text: "Parent Content A", // 同じ親
          },
        },
        {
          score: 0.9,
          metadata: {
            documentId: "doc-1",
            fileName: "manual.pdf",
            text: "Parent Content A", // 重複する親 (Deduplication対象)
          },
        },
        {
          score: 0.85,
          metadata: {
            documentId: "doc-2",
            fileName: "specs.pdf",
            text: "Parent Content B", // 別の親
          },
        },
      ]);

      // 2. Claude Stream モック
      mockInvokeClaudeStream.mockImplementation(function* (prompt: string) {
        // プロンプトに重複排除されたコンテキストが含まれているか確認
        const countA = (prompt.match(/Parent Content A/g) || []).length;
        const countB = (prompt.match(/Parent Content B/g) || []).length;

        if (countA === 1 && countB === 1) {
          yield "Hello, ";
          yield "World!";
        } else {
          yield `Error: Duplication Check Failed (A=${countA}, B=${countB})`;
        }
      });

      // 3. DynamoDB モック (セッションヘッダー更新 + 履歴保存)
      ddbMock.on(GetCommand).resolves({}); // セッション初回作成
      ddbMock.on(PutCommand).resolves({}); // 保存成功
      ddbMock.on(UpdateCommand).resolves({}); // 更新成功

      // 実行
      const event = createEvent(
        "POST",
        "/chat/stream",
        createMessageBody("Tell me about specs", "session-1")
      );

      const result = await invokeHandler(event);

      // 検証
      expect(result.statusCode).toBe(200);
      const body = result.body;

      // レスポンスボディ (NDJSON / Vercel AI SDK v3) の検証
      expect(body).toContain('"type":"text-delta"');
      expect(body).toContain('"type":"finish"');
      expect(body).toContain("Hello, ");
      expect(body).toContain("World!");

      // 認証の検証
      expect(mockVerify).toHaveBeenCalledWith("valid-token");

      // DynamoDB保存の検証
      // 修正: 実装では UpdateCommand(Session) と PutCommand(Message) が各1回実行される
      const putCalls = ddbMock.commandCalls(PutCommand);
      const updateCalls = ddbMock.commandCalls(UpdateCommand);

      expect(putCalls.length).toBeGreaterThanOrEqual(1);
      expect(updateCalls.length).toBeGreaterThanOrEqual(1);

      // メッセージ保存の中身確認
      const msgSaveCall = putCalls.find((call) => {
        const input = call.args[0].input as PutCommandInput;
        return (
          input.Item?.sk &&
          typeof input.Item.sk === "string" &&
          input.Item.sk.startsWith("MSG#")
        );
      });
      expect(msgSaveCall).toBeDefined();
      const savedItem = (msgSaveCall!.args[0].input as PutCommandInput).Item;
      expect(savedItem).toBeDefined();
      expect(savedItem?.userQuery).toBe("Tell me about specs");
      expect(savedItem?.aiResponse).toBe("Hello, World!");
    });

    it("should use redoHistoryId if provided", async () => {
      // Pinecone & Claude mocks
      mockSearchVectorsByOwner.mockResolvedValue([]);
      mockInvokeClaudeStream.mockImplementation(function* () {
        yield "Redo Response";
      });
      ddbMock.on(GetCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});

      const redoId = "existing-msg-id";
      const event = createEvent(
        "POST",
        "/chat/stream",
        createMessageBody("Redo this", "session-redo", redoId)
      );

      const result = await invokeHandler(event);
      expect(result.statusCode).toBe(200);

      // DynamoDB保存時に redoHistoryId が使われたか確認
      const putCalls = ddbMock.commandCalls(PutCommand);
      const msgSaveCall = putCalls.find((call) => {
        const input = call.args[0].input as PutCommandInput;
        return (
          input.Item?.sk &&
          typeof input.Item.sk === "string" &&
          input.Item.sk.startsWith("MSG#")
        );
      });
      const savedItem = (msgSaveCall!.args[0].input as PutCommandInput).Item;
      expect(savedItem).toBeDefined();
      expect(savedItem?.historyId).toBe(redoId);
      expect(savedItem?.aiResponse).toBe("Redo Response");
    });

    it("should save partial history when error occurs during streaming", async () => {
      // console.errorを一時的に抑制（意図的なエラーのログ出力を抑制）
      const consoleErrorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});

      try {
        // 1. Pinecone OK
        mockSearchVectorsByOwner.mockResolvedValue([]);

        // 2. Claude Stream fails midway
        mockInvokeClaudeStream.mockImplementation(function* () {
          yield "Part 1";
          throw new Error("Stream Error");
        });

        ddbMock.on(GetCommand).resolves({});
        ddbMock.on(PutCommand).resolves({});

        const event = createEvent(
          "POST",
          "/chat/stream",
          createMessageBody("Error test", "session-error")
        );

        const result = await invokeHandler(event);

        // SSEとしてはエラーイベントを流して終了するが、statusは200
        expect(result.statusCode).toBe(200);
        const body = result.body;

        // エラーイベント確認
        expect(body).toContain('"type":"error"');

        // 部分保存の確認 (Part 1 までが保存されているべき)
        const putCalls = ddbMock.commandCalls(PutCommand);
        const msgSaveCall = putCalls.find((call) => {
          const input = call.args[0].input as PutCommandInput;
          return (
            input.Item?.sk &&
            typeof input.Item.sk === "string" &&
            input.Item.sk.startsWith("MSG#")
          );
        });
        // エラー時でも saveHistoryWithNoEvent が呼ばれるはず
        expect(msgSaveCall).toBeDefined();
        const savedItem = (msgSaveCall!.args[0].input as PutCommandInput).Item;
        expect(savedItem).toBeDefined();
        expect(savedItem?.aiResponse).toBe("Part 1");
      } finally {
        // console.errorのモックを復元
        consoleErrorSpy.mockRestore();
      }
    });
  });
});
