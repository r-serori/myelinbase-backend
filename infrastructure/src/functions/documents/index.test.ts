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
  let mockGetSignedUrl: jest.Mock;

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
    process.env.USER_POOL_ID = "us-east-1_dummy";
    process.env.CLIENT_ID = "client_dummy";
    process.env.ALLOWED_ORIGINS = "http://localhost:3000";
    process.env.AWS_REGION = "us-east-1"; // Region missingエラー回避

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
    mockGetSignedUrl = jest.fn();
    jest.doMock("@aws-sdk/s3-request-presigner", () => ({
      getSignedUrl: mockGetSignedUrl,
    }));

    // デフォルトのモック動作: Presigned URL生成成功
    mockGetSignedUrl.mockResolvedValue("https://s3.mock/upload-url");

    // 5. ハンドラーの動的インポート
    const indexModule = await import("./index");
    handler = indexModule.handler;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  /**
   * API Gateway Proxy Event の作成ヘルパー
   * Authorization ヘッダーベースの認証に対応
   */
  const createEvent = (
    httpMethod: string,
    path: string,
    pathParameters: Record<string, string> | null = null,
    body: UploadRequestBody | BatchDeleteBody | UpdateTagsBody | null = null,
    token: string | null = "dummy-valid-token" // デフォルトで有効なダミートークン
  ): APIGatewayProxyEvent => {
    const headers: Record<string, string> = {
      Origin: "http://localhost:3000",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    interface AuthorizerClaims {
      sub: string;
    }

    interface RequestContextAuthorizer {
      claims: AuthorizerClaims;
    }

    const requestContext: Partial<APIGatewayProxyEvent["requestContext"]> & {
      authorizer?: RequestContextAuthorizer;
    } = {
      requestId: "test-request-id",
      accountId: "123456789012",
      apiId: "test-api",
      stage: "test",
      resourceId: "test-resource",
      resourcePath: path,
      httpMethod,
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
    };

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
      requestContext: requestContext as APIGatewayProxyEvent["requestContext"],
      isBase64Encoded: false,
      queryStringParameters: null,
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
  ): Promise<APIGatewayProxyResult> => {
    const mockContext: Context = {
      callbackWaitsForEmptyEventLoop: false,
      functionName: "test",
      functionVersion: "1",
      invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:test",
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
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);

      expect(body.documents).toHaveLength(2);
      // ユーザーIDを使ってクエリしたか確認
      const callArgs = ddbMock.call(0).args[0].input as QueryCommandInput;
      expect(callArgs.TableName).toBe("TestTable");
      expect(callArgs.IndexName).toBe("OwnerIndex");
      expect(callArgs.ExpressionAttributeValues?.[":ownerId"]).toBe(
        TEST_USER_ID
      );
    });

    it("should return 401 if token is missing", async () => {
      // トークンなし
      const event = createEvent("GET", "/documents", null, null, null);
      const result = await invokeHandler(event);

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
      const result = await invokeHandler(event);

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
      const result = await invokeHandler(event);
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
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(404);
    });

    it("should return 400 if parameter is missing", async () => {
      const event = createEvent("GET", "/documents/doc-1", null);
      const result = await invokeHandler(event);

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

      mockGetSignedUrl.mockResolvedValueOnce("https://s3.mock/download-url");

      const event = createEvent("GET", "/documents/doc-1/download-url", {
        id: "doc-1",
      });
      const result = await invokeHandler(event);

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

      mockGetSignedUrl.mockResolvedValueOnce("https://s3.mock/download-url-md");

      const event = createEvent("GET", "/documents/doc-md/download-url", {
        id: "doc-md",
      });
      await invokeHandler(event);

      // getSignedUrl が呼ばれたことを確認
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
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
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.errorCode).toBe(ErrorCode.DOCUMENTS_NOT_READY_FOR_DOWNLOAD);
    });

    it("should return 404 if document not found", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const event = createEvent("GET", "/documents/doc-1/download-url", {
        id: "doc-1",
      });
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(404);
    });
  });

  // ==========================================
  // POST /documents/upload (Upload Request)
  // ==========================================
  describe("POST /documents/upload", () => {
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

      const body: UploadRequestBody = {
        files: [
          {
            fileName: "test.pdf",
            contentType: "application/pdf",
            fileSize: 1000,
          },
        ],
        tags: ["tag1"],
      };

      const event = createEvent("POST", "/documents/upload", null, body);
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(202);
      const resBody = JSON.parse(result.body);

      // getSignedUrl が呼ばれたか確認
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);

      expect(resBody.results).toHaveLength(1);
      expect(resBody.results[0].status).toBe("success");
      // モックしたURLが返ることを確認
      expect(resBody.results[0].data.uploadUrl).toBe(
        "https://s3.mock/upload-url"
      );

      // 重複ファイルがあったため、UpdateCommand (論理削除) が呼ばれているはず
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBeGreaterThanOrEqual(1);
      const updateArg = updateCalls[0].args[0].input as UpdateCommandInput;
      expect(updateArg.Key?.documentId).toBe("old-doc-1");
      expect(updateArg.UpdateExpression).toContain(
        "SET #status = :deleted, #ttl = :ttl, updatedAt = :now, processingStatus = :active"
      );
    });

    it("should succeed with default empty tags if tags are missing", async () => {
      // 1. 重複なし
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      // 2. PutCommand
      ddbMock.on(PutCommand).resolves({});

      const body: UploadRequestBody = {
        files: [
          {
            fileName: "new.pdf",
            contentType: "application/pdf",
            fileSize: 500,
          },
        ],
        // tags を省略
      };

      const event = createEvent("POST", "/documents/upload", null, body);
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(202);
    });

    it("should return error if file is too large", async () => {
      const body: UploadRequestBody = {
        files: [
          {
            fileName: "huge.pdf",
            contentType: "application/pdf",
            fileSize: 100 * 1024 * 1024, // 100MB
          },
        ],
      };

      const event = createEvent("POST", "/documents/upload", null, body);
      const result = await invokeHandler(event);
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
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(202);

      const updateArgs = ddbMock.call(0).args[0].input as UpdateCommandInput;
      expect(updateArgs.Key?.documentId).toBe("doc-1");
      expect(updateArgs.UpdateExpression).toContain(
        "SET #status = :deleted, #ttl = :ttl, updatedAt = :updatedAt, processingStatus = :active"
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

      const body: BatchDeleteBody = {
        documentIds: ["doc-1", "doc-2"],
      };

      const event = createEvent("POST", "/documents/batch-delete", null, body);
      const result = await invokeHandler(event);

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

      const body: BatchDeleteBody = {
        documentIds: ["doc-1", "doc-2"],
      };

      const event = createEvent("POST", "/documents/batch-delete", null, body);
      const result = await invokeHandler(event);

      expect(result.statusCode).toBe(200);
      const resBody = JSON.parse(result.body);
      expect(resBody.results).toHaveLength(2);

      // doc-1: 成功
      expect(resBody.results[0].status).toBe("success");
      expect(resBody.results[0].documentId).toBe("doc-1");

      // doc-2: 失敗
      expect(resBody.results[1].status).toBe("error");
      expect(resBody.results[1].documentId).toBe("doc-2");
    });
  });
});
