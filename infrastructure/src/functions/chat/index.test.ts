import {
  DynamoDBDocumentClient as _DynamoDBDocumentClient,
  GetCommand as _GetCommand,
  PutCommand as _PutCommand,
  QueryCommand as _QueryCommand,
  UpdateCommand as _UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { AwsClientStub, mockClient } from "aws-sdk-client-mock";

// 型定義のみインポート（実体は動的インポートで取得）
import type { handler as HandlerType } from "./index";

describe("Chat Function Integration Tests", () => {
  const ORIGINAL_ENV = process.env;
  let handler: typeof HandlerType;
  let ddbMock: AwsClientStub<_DynamoDBDocumentClient>;

  // コマンドクラスの参照を保持（動的に取得するため変数化）
  let GetCommand: typeof _GetCommand;
  let PutCommand: typeof _PutCommand;
  let QueryCommand: typeof _QueryCommand;
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
    (global as any).awslambda = {
      streamifyResponse: (
        handler: (
          event: any,
          responseStream: any,
          context: any
        ) => Promise<void>
      ) => {
        return async (event: any, context: any) => {
          const responseStreamMock = {
            _buffer: "",
            _statusCode: 200,
            write: function (chunk: any) {
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
        from: (stream: any, metadata: any) => {
          if (metadata && metadata.statusCode) {
            stream._statusCode = metadata.statusCode;
          }
          return stream;
        },
      },
    };

    // 2. 環境変数の設定
    process.env = { ...ORIGINAL_ENV };
    process.env.TABLE_NAME = "ChatHistoryTable";
    process.env.STAGE = "prod";
    process.env.USE_MOCK_AUTH = "false";
    process.env.USE_BEDROCK = "true";
    process.env.USER_POOL_ID = "us-east-1_dummy";
    process.env.CLIENT_ID = "client_dummy";
    process.env.ALLOWED_ORIGINS = "http://localhost:3000";
    process.env.AWS_REGION = "us-east-1"; // Region missingエラー回避

    // 3. AWS SDKの動的インポートとモック作成
    // resetModules後はSDKのクラスも新しくなるため、テスト内で再importしてクラスを取得します
    const ddbModule = await import("@aws-sdk/lib-dynamodb");
    const { DynamoDBDocumentClient } = ddbModule;
    GetCommand = ddbModule.GetCommand;
    PutCommand = ddbModule.PutCommand;
    QueryCommand = ddbModule.QueryCommand;
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
    delete (global as any).awslambda; // モックのクリーンアップ
  });

  /**
   * イベント作成ヘルパー
   */
  const createEvent = (
    method: string,
    path: string,
    body: any = null,
    pathParams: any = null,
    queryParams: any = null
  ) => {
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
      },
    } as any;
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
  const invokeHandler = async (event: any) => {
    const localHandler = handler as unknown as (
      event: any,
      context: any
    ) => Promise<any>;
    return localHandler(event, {} as any);
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
      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls.length).toBeGreaterThanOrEqual(2);

      // メッセージ保存の中身確認
      const msgSaveCall = putCalls.find((call) => {
        const item = (call.args[0].input as any).Item;
        return item.sk && item.sk.startsWith("MSG#");
      });
      expect(msgSaveCall).toBeDefined();
      const savedItem = (msgSaveCall!.args[0].input as any).Item;
      expect(savedItem.userQuery).toBe("Tell me about specs");
      expect(savedItem.aiResponse).toBe("Hello, World!");
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
        const item = (call.args[0].input as any).Item;
        return item.sk && item.sk.startsWith("MSG#");
      });
      const savedItem = (msgSaveCall!.args[0].input as any).Item;
      expect(savedItem.historyId).toBe(redoId);
      expect(savedItem.aiResponse).toBe("Redo Response");
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
          const item = (call.args[0].input as any).Item;
          return item.sk && item.sk.startsWith("MSG#");
        });
        // エラー時でも saveHistoryWithNoEvent が呼ばれるはず
        expect(msgSaveCall).toBeDefined();
        const savedItem = (msgSaveCall!.args[0].input as any).Item;
        expect(savedItem.aiResponse).toBe("Part 1");
      } finally {
        // console.errorのモックを復元
        consoleErrorSpy.mockRestore();
      }
    });
  });

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

      expect(result.statusCode).toBe(200);
      const resBody = JSON.parse(result.body);
      expect(resBody.status).toBe("success");
      expect(resBody.item.feedback).toBe("GOOD");

      // DynamoDB Update確認
      const callArgs = ddbMock.call(0).args[0].input as any;
      expect(callArgs.Key.pk).toBe("SESSION#session-1");
      expect(callArgs.Key.sk).toBe("MSG#2024-01-01T00:00:00Z");
      expect(callArgs.ExpressionAttributeValues[":evaluation"]).toBe("GOOD");
    });

    it("should return 400 if BAD evaluation is missing reasons", async () => {
      const body = {
        sessionId: "session-1",
        historyId: "msg-1",
        createdAt: "2024-01-01T00:00:00Z",
        evaluation: "BAD",
        // reasons missing
      };

      const event = createEvent("POST", "/chat/feedback", body);
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(400);
      const resBody = JSON.parse(result.body);
      expect(resBody.errorCode).toBe("CHAT_FEEDBACK_REASONS_EMPTY");
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

      const callArgs = ddbMock.call(0).args[0].input as any;
      expect(callArgs.IndexName).toBe("GSI1");
      expect(callArgs.ExpressionAttributeValues[":userKey"]).toBe(
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
      const callArgs = ddbMock.call(0).args[0].input as any;
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

      expect(result.statusCode).toBe(200);
      const resBody = JSON.parse(result.body);
      expect(resBody.session.sessionName).toBe("New Name");
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

      expect(result.statusCode).toBe(200);

      // Verify Soft Delete (TTL set, deletedAt set, GSI keys removed)
      const callArgs = ddbMock.call(0).args[0].input as any;
      expect(callArgs.UpdateExpression).toContain("SET deletedAt = :now");
      expect(callArgs.UpdateExpression).toContain("REMOVE gsi1pk, gsi1sk");
    });
  });
});
