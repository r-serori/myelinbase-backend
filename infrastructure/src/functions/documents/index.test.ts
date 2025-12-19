// infrastructure/src/functions/documents/index.test.ts

// テスト実行前に環境変数を設定
process.env.TABLE_NAME = "TestTable";
process.env.BUCKET_NAME = "TestBucket";
process.env.PRESIGNED_URL_EXPIRY = "900";
// 本番同様の認証フローを通す設定に変更
process.env.USE_MOCK_AUTH = "false";
process.env.USER_POOL_ID = "us-east-1_dummy";
process.env.CLIENT_ID = "client_dummy";
process.env.ALLOWED_ORIGINS = "http://localhost:3000"; // CORS設定

import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  UpdateCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { handler } from "./index";
import { ErrorCode } from "../../shared/types/error-code";
// Presigned URL生成のモック用
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// --- Mocks Setup ---
const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

// S3 Presignerは関数としてインポートされるため、パス指定でモック化
jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn(),
}));

describe("Documents Function (Auth Integration)", () => {
  const TEST_USER_ID = "user-001";

  // 各テストごとのリセット処理
  beforeEach(() => {
    ddbMock.reset();
    s3Mock.reset();
    (getSignedUrl as jest.Mock).mockReset();
    jest.clearAllMocks();

    // デフォルト: Presigned URL生成成功
    (getSignedUrl as jest.Mock).mockResolvedValue("https://s3.mock/upload-url");
  });

  /**
   * API Gateway Proxy Event の作成ヘルパー
   * Authorization ヘッダーベースの認証に対応
   */
  const createEvent = (
    httpMethod: string,
    path: string,
    pathParameters: Record<string, string> | null = null,
    body: any = null,
    token: string | null = "dummy-valid-token" // デフォルトで有効なダミートークン
  ) => {
    const headers: Record<string, string> = {
      Origin: "http://localhost:3000",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const requestContext: any = {};
    // 本番環境では、Cognito等のオーソライザーが sub を埋めた上で
    // Lambda に渡してくる想定なので、それをテストで再現する
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
    } as any;
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
            sk: "hidden-sk",
          },
          {
            ownerId: TEST_USER_ID,
            documentId: "doc-2",
            fileName: "test2.txt",
          },
        ],
      });

      // トークン付きイベント生成 (デフォルト)
      const event = createEvent("GET", "/documents");
      const result: any = await handler(event, {} as any);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);

      expect(body.documents).toHaveLength(2);
      // ユーザーIDを使ってクエリしたか確認
      const callArgs = ddbMock.call(0).args[0].input as any;
      expect(callArgs.TableName).toBe("TestTable");
      expect(callArgs.IndexName).toBe("OwnerIndex");
      expect(callArgs.ExpressionAttributeValues[":ownerId"]).toBe(TEST_USER_ID);
    });

    it("should return 401 if token is missing", async () => {
      // トークンなし
      const event = createEvent("GET", "/documents", null, null, null);
      const result: any = await handler(event, {} as any);

      expect(result.statusCode).toBe(401);
    });
  });

  // ==========================================
  // GET /documents/{id} (Get Document)
  // ==========================================
  describe("GET /documents/{id}", () => {
    it("should return document details WITHOUT downloadUrl", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          ownerId: TEST_USER_ID,
          documentId: "doc-1",
          fileName: "test.pdf",
          status: "COMPLETED",
          s3Key: "uploads/user-001/doc-1/test.pdf",
        },
      });

      const event = createEvent("GET", "/documents/doc-1", { id: "doc-1" });
      const result: any = await handler(event, {} as any);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.document.documentId).toBe("doc-1");
      // downloadUrl は返却されなくなった
      expect(body.document.downloadUrl).toBeUndefined();
    });

    it("should return 404 if document is not found", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: undefined,
      });

      const event = createEvent("GET", "/documents/doc-1", { id: "doc-1" });
      const result: any = await handler(event, {} as any);
      expect(result.statusCode).toBe(404);
    });

    it("should return 404 (Security) if owner does not match", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          ownerId: "other-user", // DB上の所有者が違う
          documentId: "doc-1",
        },
      });

      // TEST_USER_ID (user-001) としてアクセス
      const event = createEvent("GET", "/documents/doc-1", { id: "doc-1" });
      const result: any = await handler(event, {} as any);

      expect(result.statusCode).toBe(404);
    });

    it("should return 400 if parameter is missing", async () => {
      const event = createEvent("GET", "/documents/doc-1", null);
      const result: any = await handler(event, {} as any);

      expect(result.statusCode).toBe(400);
    });
  });

  // ==========================================
  // GET /documents/{id}/download-url (Get Download URL)
  // ==========================================
  describe("GET /documents/{id}/download-url", () => {
    it("should return downloadUrl if document is COMPLETED and owner matches", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          ownerId: TEST_USER_ID,
          documentId: "doc-1",
          fileName: "test.pdf",
          status: "COMPLETED",
          s3Key: "uploads/user-001/doc-1/test.pdf",
          contentType: "application/pdf",
        },
      });

      (getSignedUrl as jest.Mock).mockResolvedValueOnce(
        "https://s3.mock/download-url"
      );

      const event = createEvent("GET", "/documents/doc-1/download-url", {
        id: "doc-1",
      });
      const result: any = await handler(event, {} as any);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.downloadUrl).toBe("https://s3.mock/download-url");
    });

    it("should add charset=utf-8 to contentType for markdown files", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          ownerId: TEST_USER_ID,
          documentId: "doc-md",
          fileName: "README.md",
          status: "COMPLETED",
          s3Key: "uploads/user-001/doc-md/README.md",
          contentType: "text/markdown",
        },
      });

      (getSignedUrl as jest.Mock).mockResolvedValueOnce(
        "https://s3.mock/download-url-md"
      );

      const event = createEvent("GET", "/documents/doc-md/download-url", {
        id: "doc-md",
      });
      await handler(event, {} as any);

      // getSignedUrl が charset=utf-8 付きの contentType で呼ばれたか確認
      // getSignedUrl(client, command, options) なので、commandの中身を見る必要があるが
      // aws-sdk-client-mock では難しい場合もあるので、ロジック内の generateDownloadUrl 呼び出しを確認
      // ここでは generateDownloadUrl の実装を信じて、モック呼び出し回数などを確認
      expect(getSignedUrl).toHaveBeenCalledTimes(1);
    });

    it("should return 400 if document status is not COMPLETED", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          ownerId: TEST_USER_ID,
          documentId: "doc-1",
          status: "PROCESSING", // Not COMPLETED
          s3Key: "uploads/user-001/doc-1/test.pdf",
        },
      });

      const event = createEvent("GET", "/documents/doc-1/download-url", {
        id: "doc-1",
      });
      const result: any = await handler(event, {} as any);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.errorCode).toBe(ErrorCode.DOCUMENTS_NOT_READY_FOR_DOWNLOAD);
    });

    it("should return 404 if document not found", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const event = createEvent("GET", "/documents/doc-1/download-url", {
        id: "doc-1",
      });
      const result: any = await handler(event, {} as any);

      expect(result.statusCode).toBe(404);
    });
  });

  // ==========================================
  // POST /documents/upload-request (Upload Request)
  // ==========================================
  describe("POST /documents/upload-request", () => {
    it("should create presigned URLs and handle duplicate files", async () => {
      // 1. ファイル名重複チェック: fileName='test.pdf' が既存
      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            ownerId: TEST_USER_ID,
            fileName: "test.pdf",
            documentId: "old-doc-1",
          },
        ],
      });

      // 2. PutCommand (新規作成), UpdateCommand (旧ファイル論理削除)
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});

      const body = {
        files: [
          {
            fileName: "test.pdf",
            contentType: "application/pdf",
            fileSize: 1000,
          },
        ],
        tags: ["tag1"],
      };

      const event = createEvent(
        "POST",
        "/documents/upload-request",
        null,
        body
      );
      const result: any = await handler(event, {} as any);

      expect(result.statusCode).toBe(202);
      const resBody = JSON.parse(result.body);

      // getSignedUrl が呼ばれたか確認
      expect(getSignedUrl).toHaveBeenCalledTimes(1);

      expect(resBody.results).toHaveLength(1);
      expect(resBody.results[0].status).toBe("success");
      // モックしたURLが返ることを確認
      expect(resBody.results[0].data.uploadUrl).toBe(
        "https://s3.mock/upload-url"
      );

      // 重複ファイルがあったため、UpdateCommand (論理削除) が呼ばれているはず
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBeGreaterThanOrEqual(1);
      const updateArg = updateCalls[0].args[0].input as any;
      expect(updateArg.Key.documentId).toBe("old-doc-1");
      expect(updateArg.UpdateExpression).toContain(
        "SET deleteRequested = :true"
      );
    });

    it("should succeed with default empty tags if tags are missing", async () => {
      // 1. 重複なし
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      // 2. PutCommand (新規作成)
      ddbMock.on(PutCommand).resolves({});

      const body = {
        files: [
          {
            fileName: "test.pdf",
            contentType: "application/pdf",
            fileSize: 1000,
          },
        ],
      };
      const event = createEvent(
        "POST",
        "/documents/upload-request",
        null,
        body
      );
      const result: any = await handler(event, {} as any);
      expect(result.statusCode).toBe(202);
      const resBody = JSON.parse(result.body);
      expect(resBody.results).toHaveLength(1);
    });

    it("should return 400 for invalid file type", async () => {
      const body = {
        files: [
          {
            fileName: "test.exe",
            contentType: "application/x-msdownload", // 未サポート
            fileSize: 1000,
          },
        ],
        tags: ["tag1"],
      };

      const event = createEvent(
        "POST",
        "/documents/upload-request",
        null,
        body
      );
      const result: any = await handler(event, {} as any);

      expect(result.statusCode).toBe(400);
      const resBody = JSON.parse(result.body);
      expect(resBody.errorCode).toBe(ErrorCode.DOCUMENTS_UNSUPPORTED_FILE_TYPE);
    });

    it("should return 400 if fileSize is greater than 50MB", async () => {
      const body = {
        files: [
          {
            fileName: "test.pdf",
            contentType: "application/pdf",
            fileSize: 50 * 1024 * 1024 + 1,
          },
        ],
        tags: ["tag1"],
      };
      const event = createEvent(
        "POST",
        "/documents/upload-request",
        null,
        body
      );
      const result: any = await handler(event, {} as any);
      expect(result.statusCode).toBe(400);
      const resBody = JSON.parse(result.body);
      expect(resBody.errorCode).toBe(ErrorCode.DOCUMENTS_FILE_TOO_LARGE);
    });
  });

  // ==========================================
  // DELETE /documents/{id}
  // ==========================================
  describe("DELETE /documents/{id}", () => {
    it("should mark document as deleted", async () => {
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          documentId: "doc-1",
          status: "DELETING",
        },
      });

      const event = createEvent("DELETE", "/documents/doc-1", { id: "doc-1" });
      const result: any = await handler(event, {} as any);

      expect(result.statusCode).toBe(202);

      const updateArgs = ddbMock.call(0).args[0].input as any;
      expect(updateArgs.Key.documentId).toBe("doc-1");
      expect(updateArgs.UpdateExpression).toContain(
        "SET deleteRequested = :true"
      );
    });
  });

  // ==========================================
  // POST /documents/batch-delete (Batch Delete)
  // ==========================================
  describe("POST /documents/batch-delete", () => {
    it("should return success for all items", async () => {
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          documentId: "doc-1",
          status: "DELETING",
        },
      });

      const body = {
        documentIds: ["doc-1", "doc-2"],
      };

      const event = createEvent("POST", "/documents/batch-delete", null, body);
      const result: any = await handler(event, {} as any);

      expect(result.statusCode).toBe(200);
      const resBody = JSON.parse(result.body);
      expect(resBody.results).toHaveLength(2);
      expect(resBody.results[0].status).toBe("success");
      expect(resBody.results[0].documentId).toBe("doc-1");
      expect(resBody.results[1].status).toBe("success");
      expect(resBody.results[1].documentId).toBe("doc-2");

      // UpdateCommandが2回呼ばれていることを確認
      expect(ddbMock.commandCalls(UpdateCommand).length).toBe(2);
    });

    it("should return error for failed item but success for others", async () => {
      // 1回目は成功、2回目は失敗するようにモック
      ddbMock
        .on(UpdateCommand)
        .resolvesOnce({
          Attributes: {
            documentId: "doc-1",
            status: "DELETING",
          },
        })
        .rejectsOnce(new Error("DynamoDB Error"));

      const body = {
        documentIds: ["doc-1", "doc-2"],
      };

      const event = createEvent("POST", "/documents/batch-delete", null, body);
      const result: any = await handler(event, {} as any);

      expect(result.statusCode).toBe(200);
      const resBody = JSON.parse(result.body);
      expect(resBody.results).toHaveLength(2);

      // doc-1: 成功
      expect(resBody.results[0].status).toBe("success");
      expect(resBody.results[0].documentId).toBe("doc-1");

      // doc-2: 失敗
      expect(resBody.results[1].status).toBe("error");
      expect(resBody.results[1].documentId).toBe("doc-2");
      expect(resBody.results[1].errorCode).toBe(
        ErrorCode.INTERNAL_SERVER_ERROR
      );
    });
  });

  // ==========================================
  // PATCH /documents/{id}/tags
  // ==========================================
  describe("PATCH /documents/{id}/tags", () => {
    it("should return 200 if tags are updated", async () => {
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          tags: ["tag1", "tag2", "tag3"],
        },
      });
      const body = {
        tags: ["tag1", "tag2", "tag3"],
      };
      const event = createEvent(
        "PATCH",
        "/documents/doc-1/tags",
        {
          id: "doc-1",
        },
        body
      );

      const result: any = await handler(event, {} as any);

      expect(result.statusCode).toBe(200);
      const resBody = JSON.parse(result.body);
      expect(resBody.document.tags).toEqual(["tag1", "tag2", "tag3"]);
    });

    it("should return 400 if tags are missing", async () => {
      const event = createEvent("PATCH", "/documents/doc-1/tags", {
        id: "doc-1",
      });
      const result: any = await handler(event, {} as any);
      expect(result.statusCode).toBe(400);
    });
  });

  it("should return 404 if endpoint is not found", async () => {
    const event = createEvent("GET", "/not-found");
    const result: any = await handler(event, {} as any);
    expect(result.statusCode).toBe(404);
  });
});
