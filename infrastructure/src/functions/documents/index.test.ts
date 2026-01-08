import { S3Client as _S3Client } from "@aws-sdk/client-s3";
import {
  DynamoDBDocumentClient as _DynamoDBDocumentClient,
  GetCommand as _GetCommand,
  PutCommand as _PutCommand,
  QueryCommand as _QueryCommand,
  QueryCommandInput,
  UpdateCommand as _UpdateCommand,
  UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import { AwsClientStub, mockClient } from "aws-sdk-client-mock";

import { ErrorCode } from "../../shared/types/error-code";

// 型定義のみインポート（実体は動的インポートで取得）
import type { handler as HandlerType } from "./index";

// リクエストボディの型定義
interface UploadRequestBody {
  files: Array<{
    fileName: string;
    contentType: string;
    fileSize: number;
    fileHash?: string; // ハッシュ値による重複チェック用に追加
  }>;
  tags?: string[];
}

interface BatchDeleteBody {
  documentIds: string[];
}

interface UpdateTagsBody {
  tags: string[];
}

describe("Documents Function (Auth Integration)", () => {
  const ORIGINAL_ENV = process.env;
  const TEST_USER_ID = "user-001";

  let handler: typeof HandlerType;
  let ddbMock: AwsClientStub<_DynamoDBDocumentClient>;
  let s3Mock: AwsClientStub<_S3Client>;

  // コマンドクラスの参照を保持（動的に取得するため変数化）
  let GetCommand: typeof _GetCommand;
  let PutCommand: typeof _PutCommand;
  let QueryCommand: typeof _QueryCommand;
  let UpdateCommand: typeof _UpdateCommand;

  // モック関数への参照
  let mockGenerateUploadUrl: jest.Mock;
  let mockGenerateDownloadUrl: jest.Mock;

  beforeEach(async () => {
    // 1. モジュールキャッシュのリセット
    jest.resetModules();

    // 2. 環境変数の設定
    process.env = { ...ORIGINAL_ENV };
    process.env.TABLE_NAME = "TestTable";
    process.env.BUCKET_NAME = "TestBucket";
    process.env.PRESIGNED_URL_EXPIRY = "900";
    process.env.STAGE = "prod";
    process.env.USE_MOCK_AUTH = "false";
    process.env.USER_POOL_ID = "ap-northeast-1_dummy";
    process.env.CLIENT_ID = "client_dummy";
    process.env.ALLOWED_ORIGINS = "http://localhost:3000";
    process.env.AWS_REGION = "ap-northeast-1";

    // 3. AWS SDKの動的インポートとモック作成
    const ddbModule = await import("@aws-sdk/lib-dynamodb");
    const s3Module = await import("@aws-sdk/client-s3");

    // クラス参照の更新
    GetCommand = ddbModule.GetCommand;
    PutCommand = ddbModule.PutCommand;
    QueryCommand = ddbModule.QueryCommand;
    UpdateCommand = ddbModule.UpdateCommand;

    // 型不整合回避のためのキャスト
    ddbMock = mockClient(
      ddbModule.DynamoDBDocumentClient
    ) as unknown as AwsClientStub<_DynamoDBDocumentClient>;
    s3Mock = mockClient(
      s3Module.S3Client
    ) as unknown as AwsClientStub<_S3Client>;

    // 4. 外部モジュールのモック (jest.doMockを使用)
    mockGenerateUploadUrl = jest.fn();
    mockGenerateDownloadUrl = jest.fn();

    jest.doMock("../../shared/utils/s3", () => ({
      createS3Client: jest.fn().mockReturnValue({}),
      generateUploadUrl: mockGenerateUploadUrl,
      generateDownloadUrl: mockGenerateDownloadUrl,
      buildS3Uri: jest.fn(
        (bucket: string, key: string) => `s3://${bucket}/${key}`
      ),
    }));

    jest.doMock("../../shared/clients/pinecone", () => ({
      getPineconeApiKey: jest.fn().mockResolvedValue("mock-api-key"),
      createPineconeClient: jest.fn().mockReturnValue({}),
      deleteDocumentVectors: jest.fn().mockResolvedValue(undefined),
    }));

    // デフォルトのモック動作: Presigned URL生成成功
    mockGenerateUploadUrl.mockResolvedValue("https://s3.mock/upload-url");
    mockGenerateDownloadUrl.mockResolvedValue("https://s3.mock/download-url");

    // 5. ハンドラーの動的インポート
    const indexModule = await import("./index");
    handler = indexModule.handler;
  });

  afterEach(() => {
    // 各テスト後にモックをリセット
    jest.clearAllMocks();
    ddbMock.reset();
    s3Mock.reset();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  /**
   * API Gateway Proxy Event の作成ヘルパー
   */
  const createEvent = (
    httpMethod: string,
    path: string,
    pathParameters: Record<string, string> | null = null,
    body: UploadRequestBody | BatchDeleteBody | UpdateTagsBody | null = null,
    token: string | null = "dummy-valid-token"
  ): APIGatewayProxyEvent => {
    const headers: Record<string, string> = {
      Origin: "http://localhost:3000",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    // requestContextの構築
    const requestContext: Record<string, unknown> = {
      requestId: "test-request-id",
      stage: "test",
      httpMethod,
      path,
      identity: { sourceIp: "127.0.0.1" },
    };

    if (token) {
      requestContext.authorizer = {
        claims: {
          sub: TEST_USER_ID,
        },
      };
    }

    return {
      httpMethod,
      path,
      pathParameters,
      headers,
      body: body ? JSON.stringify(body) : null,
      requestContext,
      isBase64Encoded: false,
      queryStringParameters: null,
      multiValueHeaders: {},
      multiValueQueryStringParameters: null,
      stageVariables: null,
      resource: path,
      accountId: "123456789012",
      apiId: "test-api",
      authorizer: {
        claims: {
          sub: TEST_USER_ID,
        },
      },
      protocol: "HTTP/1.1",
      requestTimeEpoch: Date.now(),
    } as unknown as APIGatewayProxyEvent;
  };

  /**
   * ハンドラー実行ヘルパー
   */
  const invokeHandler = async (
    event: APIGatewayProxyEvent
  ): Promise<APIGatewayProxyResult> => {
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
    return handler(event, mockContext);
  };

  // ==========================================
  // GET /documents (List Documents)
  // ==========================================
  describe("GET /documents", () => {
    it("should return a list of documents for the owner", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            ownerId: TEST_USER_ID,
            documentId: "doc-1",
            fileName: "test1.pdf",
            status: "COMPLETED",
          },
          {
            ownerId: TEST_USER_ID,
            documentId: "doc-2",
            fileName: "test2.txt",
            status: "PENDING_UPLOAD",
          },
        ],
      });

      const event = createEvent("GET", "/documents");
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.documents).toHaveLength(2);

      const callArgs = ddbMock.call(0).args[0].input as QueryCommandInput;
      expect(callArgs.IndexName).toBe("OwnerIndex");
      expect(callArgs.ExpressionAttributeValues?.[":ownerId"]).toBe(
        TEST_USER_ID
      );
    });
  });

  // ==========================================
  // GET /documents/{id} (Get Document)
  // ==========================================
  describe("GET /documents/{id}", () => {
    it("should return document details", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          ownerId: TEST_USER_ID,
          documentId: "doc-1",
          fileName: "test.pdf",
          status: "COMPLETED",
        },
      });

      const event = createEvent("GET", "/documents/doc-1", { id: "doc-1" });
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.document.documentId).toBe("doc-1");
    });
  });

  // ==========================================
  // GET /documents/{id}/download-url
  // ==========================================
  describe("GET /documents/{id}/download-url", () => {
    it("should return downloadUrl if document is COMPLETED", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          ownerId: TEST_USER_ID,
          documentId: "doc-1",
          fileName: "test.pdf",
          status: "COMPLETED",
          s3Key: "uploads/key",
          contentType: "application/pdf",
        },
      });

      const event = createEvent("GET", "/documents/doc-1/download-url", {
        id: "doc-1",
      });
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.downloadUrl).toBe("https://s3.mock/download-url");

      // generateDownloadUrl が正しく呼ばれたか確認
      expect(mockGenerateDownloadUrl).toHaveBeenCalledTimes(1);
      expect(mockGenerateDownloadUrl).toHaveBeenCalledWith(
        expect.anything(), // s3Client
        "TestBucket",
        "uploads/key",
        "application/pdf",
        3600
      );
    });
  });

  // ==========================================
  // POST /documents/upload (Upload Request)
  // ==========================================
  describe("POST /documents/upload", () => {
    it("should fail with DUPLICATE_CONTENT if fileHash exists in DB", async () => {
      // 1. FileHashIndex で重複が見つかるようにモック
      ddbMock.on(QueryCommand, { IndexName: "FileHashIndex" }).resolves({
        Items: [{ documentId: "existing-hash-doc" }],
      });

      const body: UploadRequestBody = {
        files: [
          {
            fileName: "duplicate.pdf",
            contentType: "application/pdf",
            fileSize: 1000,
            fileHash: "a".repeat(64), // SHA-256ハッシュは64文字
          },
        ],
      };

      const event = createEvent("POST", "/documents/upload", null, body);
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(202);
      const resBody = JSON.parse(result.body);

      // エラーチェック
      expect(resBody.results[0].status).toBe("error");
      expect(resBody.results[0].errorCode).toBe(
        ErrorCode.DOCUMENTS_DUPLICATE_CONTENT
      );

      // fileNameIndex の検索や PutCommand は実行されていないはず
      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls.length).toBe(0);
    });

    it("should succeed if fileHash is provided but no duplicate found (save hash to DB)", async () => {
      // 1. FileHashIndex: 重複なし
      ddbMock
        .on(QueryCommand, { IndexName: "FileHashIndex" })
        .resolves({ Items: [] });

      // 2. FileNameIndex: 重複なし
      ddbMock
        .on(QueryCommand, { IndexName: "FileNameIndex" })
        .resolves({ Items: [] });

      // 3. PutCommand: 成功
      ddbMock.on(PutCommand).resolves({});

      const body: UploadRequestBody = {
        files: [
          {
            fileName: "new_unique.pdf",
            contentType: "application/pdf",
            fileSize: 1000,
            fileHash: "b".repeat(64), // SHA-256ハッシュは64文字
          },
        ],
        tags: ["tagA"],
      };

      const event = createEvent("POST", "/documents/upload", null, body);
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(202);
      const resBody = JSON.parse(result.body);
      expect(resBody.results[0].status).toBe("success");

      // PutCommand の引数を検証（fileHashが含まれているか）
      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls.length).toBe(1);
      const putItem = putCalls[0].args[0].input.Item;
      expect(putItem?.fileName).toBe("new_unique.pdf");
      expect(putItem?.fileHash).toBe("b".repeat(64));
      expect(putItem?.tags).toEqual(["tagA"]);

      // generateUploadUrl が正しく呼ばれたか確認
      expect(mockGenerateUploadUrl).toHaveBeenCalledTimes(1);
      expect(mockGenerateUploadUrl).toHaveBeenCalledWith(
        expect.anything(), // s3Client
        "TestBucket",
        expect.stringMatching(/^uploads\/user-001\/[a-f0-9-]+$/), // documentId は UUID
        "application/pdf",
        900
      );
    });

    it("should handle duplicate filename (replace existing)", async () => {
      // 1. FileNameIndex で重複が見つかる
      ddbMock.on(QueryCommand, { IndexName: "FileNameIndex" }).resolves({
        Items: [
          {
            ownerId: TEST_USER_ID,
            fileName: "test.pdf",
            documentId: "old-doc-1",
          },
        ],
      });

      // ハッシュなしの場合は FileHashIndex クエリは走らない

      ddbMock.on(UpdateCommand).resolves({}); // 古いファイルの論理削除
      ddbMock.on(PutCommand).resolves({}); // 新しいファイルの作成

      const body: UploadRequestBody = {
        files: [
          {
            fileName: "test.pdf",
            contentType: "application/pdf",
            fileSize: 1000,
            // fileHash なし
          },
        ],
      };

      const event = createEvent("POST", "/documents/upload", null, body);
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(202);
      const resBody = JSON.parse(result.body);
      expect(resBody.results[0].status).toBe("success");

      // UpdateCommand (論理削除) が呼ばれたか確認
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBeGreaterThan(0);
      const delCall = updateCalls.find((call) => {
        const input = call.args[0].input as UpdateCommandInput;
        return (
          input.Key?.documentId === "old-doc-1" &&
          input.UpdateExpression?.includes("SET #status = :deleted")
        );
      });
      expect(delCall).toBeDefined();

      // generateUploadUrl が正しく呼ばれたか確認
      expect(mockGenerateUploadUrl).toHaveBeenCalledTimes(1);
    });

    it("should handle multiple files with mixed results", async () => {
      // File 1: ハッシュ重複あり (Error)
      // File 2: 正常 (Success)

      // mock の挙動を呼び出し順などで制御するのは複雑なため、
      // mockClient の filter 機能を使うのが確実だが、
      // 今回は同じ IndexName ("FileHashIndex") に対する異なる入力値(fileHash)での分岐が必要。
      // aws-sdk-client-mock では入力値の深い比較での分岐は少し複雑になるため、
      // 簡易的に resolvesOnce() チェーンで対応するか、実装のループ順序に依存させる。

      // 順序: File 1 (Hash Check) -> File 2 (Hash Check -> Name Check -> Put)

      ddbMock
        .on(QueryCommand, { IndexName: "FileHashIndex" })
        .resolvesOnce({ Items: [{ documentId: "dup-doc" }] }) // 1ファイル目: 重複あり
        .resolvesOnce({ Items: [] }); // 2ファイル目: 重複なし

      ddbMock
        .on(QueryCommand, { IndexName: "FileNameIndex" })
        .resolves({ Items: [] }); // 名前重複なし

      ddbMock.on(PutCommand).resolves({});

      const body: UploadRequestBody = {
        files: [
          {
            fileName: "duplicate.pdf",
            contentType: "pdf",
            fileSize: 100,
            fileHash: "c".repeat(64), // SHA-256ハッシュは64文字
          },
          {
            fileName: "good.pdf",
            contentType: "pdf",
            fileSize: 100,
            fileHash: "d".repeat(64), // SHA-256ハッシュは64文字
          },
        ],
      };

      const event = createEvent("POST", "/documents/upload", null, body);
      const result = await invokeHandler(event);

      const resBody = JSON.parse(result.body);
      expect(resBody.results).toHaveLength(2);
      expect(resBody.results[0].status).toBe("error");
      expect(resBody.results[0].errorCode).toBe(
        ErrorCode.DOCUMENTS_DUPLICATE_CONTENT
      );
      expect(resBody.results[1].status).toBe("success");

      // generateUploadUrl は2つ目のファイル（成功したファイル）に対してのみ呼ばれる
      expect(mockGenerateUploadUrl).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================
  // DELETE /documents/{id}
  // ==========================================
  describe("DELETE /documents/{id}", () => {
    it("should mark document as deleted", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const event = createEvent("DELETE", "/documents/doc-1", { id: "doc-1" });
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(202);

      const updateArgs = ddbMock.call(0).args[0].input as UpdateCommandInput;
      expect(updateArgs.Key?.documentId).toBe("doc-1");
      expect(updateArgs.UpdateExpression).toContain("SET #status = :deleted");
    });
  });

  // ==========================================
  // POST /documents/batch-delete
  // ==========================================
  describe("POST /documents/batch-delete", () => {
    it("should process batch deletion", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const body: BatchDeleteBody = { documentIds: ["doc-1", "doc-2"] };
      const event = createEvent("POST", "/documents/batch-delete", null, body);
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(200);
      const resBody = JSON.parse(result.body);
      expect(resBody.results).toHaveLength(2);
      expect(ddbMock.commandCalls(UpdateCommand).length).toBe(2);
    });
  });

  // ==========================================
  // PATCH /documents/{id}/tags
  // ==========================================
  describe("PATCH /documents/{id}/tags", () => {
    it("should update tags and return updated document", async () => {
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          documentId: "doc-1",
          ownerId: TEST_USER_ID,
          tags: ["new-tag", "tag2"],
          updatedAt: "2023-01-01T00:00:00Z",
        },
      });

      const body: UpdateTagsBody = { tags: [" new-tag ", "tag2", ""] }; // 空文字やスペースあり
      const event = createEvent(
        "PATCH",
        "/documents/doc-1/tags",
        { id: "doc-1" },
        body
      );

      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(200); // 戻り値は { document: ... } なので通常 apiHandler が 200 を返す
      const resBody = JSON.parse(result.body);
      expect(resBody.document.tags).toEqual(["new-tag", "tag2"]);

      // UpdateCommand の検証
      const updateArgs = ddbMock.call(0).args[0].input as UpdateCommandInput;
      expect(updateArgs.Key?.documentId).toBe("doc-1");
      expect(updateArgs.ExpressionAttributeValues?.[":tags"]).toEqual([
        "new-tag",
        "tag2",
      ]); // サニタイズされていること
      expect(updateArgs.ReturnValues).toBe("ALL_NEW");
    });

    it("should return error response if update fails (e.g. document doesn't exist)", async () => {
      // DynamoDBの条件付き書き込み失敗などをシミュレート
      ddbMock
        .on(UpdateCommand)
        .rejects(new Error("ConditionalCheckFailedException"));

      const body: UpdateTagsBody = { tags: ["tag1"] };
      const event = createEvent(
        "PATCH",
        "/documents/doc-1/tags",
        { id: "doc-1" },
        body
      );

      // apiHandler がエラーをキャッチしてレスポンスを整形する想定
      const result = await invokeHandler(event);

      // apiHandler がエラーをキャッチしてエラーレスポンスを返す
      expect(result.statusCode).toBeGreaterThanOrEqual(400);
    });
  });
});
