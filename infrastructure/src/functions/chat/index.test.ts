// src/functions/chat/index.test.ts

// 1. 環境変数の設定 (インポート前に設定が必要)
process.env.TABLE_NAME = "ChatHistoryTable";
process.env.PINECONE_INDEX_NAME = "documents";
process.env.STAGE = "local"; // streamApiHandler がバッファリングモードで動作するように設定
process.env.USE_MOCK_AUTH = "false"; // 実際の認証ロジックをテスト
process.env.USER_POOL_ID = "us-east-1_dummy";
process.env.CLIENT_ID = "client_dummy";
process.env.USE_MOCK_BEDROCK = "false"; // 実ロジックフロー(モック使用)を通す
process.env.ALLOWED_ORIGINS = "http://localhost:3000"; // CORS設定

import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { handler } from "./index";
import { CognitoJwtVerifier } from "aws-jwt-verify";

// 2. モックの定義
const ddbMock = mockClient(DynamoDBDocumentClient);

// Shared Clients / Utils のモック
jest.mock("../../shared/clients/bedrock", () => ({
  generateEmbeddings: jest.fn(),
  invokeClaudeStream: jest.fn(),
}));

jest.mock("../../shared/clients/pinecone", () => ({
  createPineconeClient: jest.fn(),
  getPineconeApiKey: jest.fn(),
  searchVectorsByOwner: jest.fn(),
}));

// aws-jwt-verify のモック
jest.mock("aws-jwt-verify", () => {
  return {
    CognitoJwtVerifier: {
      create: jest.fn().mockReturnValue({
        verify: jest.fn(),
      }),
    },
  };
});

// モック関数のインポート (実装をテスト内で定義するため)
import {
  generateEmbeddings,
  invokeClaudeStream,
} from "../../shared/clients/bedrock";
import {
  searchVectorsByOwner,
  getPineconeApiKey,
} from "../../shared/clients/pinecone";

describe("Chat Function Integration Tests", () => {
  const TEST_USER_ID = "user-123";
  let mockVerifier: any;

  beforeEach(() => {
    // モックのリセット
    ddbMock.reset();
    jest.clearAllMocks();

    // 認証モックの設定: 常に成功して TEST_USER_ID を返す
    mockVerifier = CognitoJwtVerifier.create({} as any);
    (mockVerifier.verify as jest.Mock).mockResolvedValue({
      sub: TEST_USER_ID,
    });

    // 共通モックのデフォルト動作
    (getPineconeApiKey as jest.Mock).mockResolvedValue("mock-pinecone-key");
    (generateEmbeddings as jest.Mock).mockResolvedValue([[0.1, 0.2, 0.3]]); // Query Vector
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

  // ==========================================
  // POST /chat/stream
  // ==========================================
  describe("POST /chat/stream", () => {
    it("should process chat stream with RAG and Small-to-Big deduplication", async () => {
      // 1. Pinecone検索モック (Small to Big: 同じ親を持つチャイルドがヒットしたケース)
      (searchVectorsByOwner as jest.Mock).mockResolvedValue([
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
      (invokeClaudeStream as jest.Mock).mockImplementation(async function* (
        prompt: string
      ) {
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
      const event = createEvent("POST", "/chat/stream", {
        query: "Tell me about specs",
        sessionId: "session-1",
      });

      const result: any = await handler(event, {} as any, {} as any);

      // 検証
      expect(result.statusCode).toBe(200);
      const body = result.body;

      // レスポンスボディ (SSE) の検証
      expect(body).toContain('type":"citations"');
      expect(body).toContain('type":"text"');
      expect(body).toContain('type":"done"');
      expect(body).toContain("Hello, ");
      expect(body).toContain("World!");

      // 認証の検証
      expect(mockVerifier.verify).toHaveBeenCalledWith("valid-token");

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
      (searchVectorsByOwner as jest.Mock).mockResolvedValue([]);
      (invokeClaudeStream as jest.Mock).mockImplementation(async function* () {
        yield "Redo Response";
      });
      ddbMock.on(GetCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});

      const redoId = "existing-msg-id";
      const event = createEvent("POST", "/chat/stream", {
        query: "Redo this",
        sessionId: "session-redo",
        redoHistoryId: redoId,
      });

      const result: any = await handler(event, {} as any, {} as any);
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
      // 1. Pinecone OK
      (searchVectorsByOwner as jest.Mock).mockResolvedValue([]);

      // 2. Claude Stream fails midway
      (invokeClaudeStream as jest.Mock).mockImplementation(async function* () {
        yield "Part 1";
        throw new Error("Stream Error");
      });

      ddbMock.on(GetCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});

      const event = createEvent("POST", "/chat/stream", {
        query: "Error test",
        sessionId: "session-error",
      });

      const result: any = await handler(event, {} as any, {} as any);

      // SSEとしてはエラーイベントを流して終了するが、statusは200
      expect(result.statusCode).toBe(200);
      const body = result.body;

      // エラーイベント確認
      expect(body).toContain('type":"error"');
      expect(body).toContain("Stream Error");

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
    });
  });

  // ==========================================
  // POST /chat/feedback
  // ==========================================
  describe("POST /chat/feedback", () => {
    it("should update feedback successfully", async () => {
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          feedback: "GOOD",
          historyId: "msg-1",
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
      const result: any = await handler(event, {} as any, {} as any);

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
      const result: any = await handler(event, {} as any, {} as any);

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
      const result: any = await handler(event, {} as any, {} as any);

      expect(result.statusCode).toBe(200);
      const resBody = JSON.parse(result.body);
      expect(resBody.sessions).toHaveLength(1);
      expect(resBody.sessions[0].sessionId).toBe("s1");

      const callArgs = ddbMock.call(0).args[0].input as any;
      expect(callArgs.IndexName).toBe("GSI1");
      expect(callArgs.ExpressionAttributeValues[":userKey"]).toBe(
        `USER#${TEST_USER_ID}`
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
            historyId: "msg-1",
            ownerId: TEST_USER_ID,
            userQuery: "Hi",
            aiResponse: "Hello",
            createdAt: "2024-01-01",
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

      const result: any = await handler(event, {} as any, {} as any);

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
      const result: any = await handler(event, {} as any, {} as any);

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
      const result: any = await handler(event, {} as any, {} as any);

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
      const result: any = await handler(event, {} as any, {} as any);

      expect(result.statusCode).toBe(200);

      // Verify Soft Delete (TTL set, deletedAt set, GSI keys removed)
      const callArgs = ddbMock.call(0).args[0].input as any;
      expect(callArgs.UpdateExpression).toContain("SET deletedAt = :now");
      expect(callArgs.UpdateExpression).toContain("REMOVE gsi1pk, gsi1sk");
    });
  });
});
