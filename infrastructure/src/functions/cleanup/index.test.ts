import { DynamoDBStreamEvent } from "aws-lambda";

// 型定義のみインポート
import type { handler as HandlerType } from "./index";

describe("Cleanup Function (DynamoDB Stream)", () => {
  const ORIGINAL_ENV = process.env;

  let handler: typeof HandlerType;

  // モック関数
  let mockDeleteS3Object: jest.Mock;
  let mockCreateS3Client: jest.Mock;
  let mockUnmarshall: jest.Mock;
  let mockCreatePineconeClient: jest.Mock;
  let mockGetPineconeApiKey: jest.Mock;
  let mockDeleteDocumentVectors: jest.Mock;
  let mockLogger: jest.Mock;

  beforeEach(async () => {
    jest.resetModules();

    process.env = { ...ORIGINAL_ENV };
    process.env.BUCKET_NAME = "test-bucket";

    // 1. 各モック関数の定義
    mockDeleteS3Object = jest.fn().mockResolvedValue(undefined);
    mockCreateS3Client = jest.fn().mockReturnValue({}); // 空のクライアントオブジェクト

    mockUnmarshall = jest
      .fn()
      .mockImplementation((input: Record<string, unknown>) => {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(input)) {
          if (value && typeof value === "object" && "S" in value) {
            result[key] = (value as { S: string }).S;
          } else if (value && typeof value === "object" && "N" in value) {
            result[key] = Number((value as { N: string }).N);
          } else {
            result[key] = value;
          }
        }
        return result;
      });

    mockCreatePineconeClient = jest.fn().mockReturnValue({});
    mockGetPineconeApiKey = jest.fn().mockResolvedValue("mock-api-key");
    mockDeleteDocumentVectors = jest.fn().mockResolvedValue(undefined);

    mockLogger = jest.fn();

    // 2. モジュールごとのモック適用 (jest.doMock)

    // AWS SDK Utils
    jest.doMock("@aws-sdk/util-dynamodb", () => ({
      unmarshall: mockUnmarshall,
    }));

    // Shared S3 Utils
    jest.doMock("../../shared/utils/s3", () => ({
      createS3Client: mockCreateS3Client,
      deleteS3Object: mockDeleteS3Object,
    }));

    // Shared Pinecone Client
    jest.doMock("../../shared/clients/pinecone", () => ({
      createPineconeClient: mockCreatePineconeClient,
      getPineconeApiKey: mockGetPineconeApiKey,
      deleteDocumentVectors: mockDeleteDocumentVectors,
    }));

    // Shared API Handler (Logger)
    jest.doMock("../../shared/utils/api-handler", () => ({
      logger: mockLogger,
    }));

    // 3. ハンドラーの動的インポート
    const indexModule = await import("./index");
    handler = indexModule.handler;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  /**
   * DynamoDB Stream Event 作成ヘルパー
   * unmarshallをモックしているので、OldImageは通常のJSオブジェクトとして渡せます
   */
  const createStreamEvent = (
    eventName: "INSERT" | "MODIFY" | "REMOVE",
    oldImage: Record<string, unknown> | null | undefined
  ): DynamoDBStreamEvent => {
    type StreamRecord = NonNullable<
      DynamoDBStreamEvent["Records"][0]["dynamodb"]
    >;
    return {
      Records: [
        {
          eventName,
          dynamodb: {
            OldImage: (oldImage ?? undefined) as StreamRecord["OldImage"],
          },
        },
      ],
    };
  };

  it("should process REMOVE event and delete resources from S3 and Pinecone", async () => {
    const event = createStreamEvent("REMOVE", {
      documentId: "doc-123",
      s3Key: "uploads/doc-123.pdf",
    });

    await handler(event);

    // S3削除が呼ばれたか
    expect(mockDeleteS3Object).toHaveBeenCalledTimes(1);
    expect(mockDeleteS3Object).toHaveBeenCalledWith(
      expect.anything(), // s3Client
      "test-bucket",
      "uploads/doc-123.pdf"
    );

    // Pinecone削除が呼ばれたか
    expect(mockGetPineconeApiKey).toHaveBeenCalled();
    expect(mockCreatePineconeClient).toHaveBeenCalledWith("mock-api-key");
    expect(mockDeleteDocumentVectors).toHaveBeenCalledTimes(1);
    expect(mockDeleteDocumentVectors).toHaveBeenCalledWith(
      expect.anything(), // pineconeClient
      "doc-123"
    );

    // エラーログが出ていないこと
    expect(mockLogger).not.toHaveBeenCalledWith(
      "ERROR",
      expect.anything(),
      expect.anything()
    );
  });

  it("should ignore events other than REMOVE", async () => {
    const event = createStreamEvent("INSERT", {
      documentId: "doc-123",
      s3Key: "uploads/doc-123.pdf",
    });

    await handler(event);

    expect(mockDeleteS3Object).not.toHaveBeenCalled();
    expect(mockDeleteDocumentVectors).not.toHaveBeenCalled();
  });

  it("should ignore REMOVE events without OldImage", async () => {
    const event = createStreamEvent("REMOVE", null);

    await handler(event);

    expect(mockDeleteS3Object).not.toHaveBeenCalled();
    expect(mockDeleteDocumentVectors).not.toHaveBeenCalled();
  });

  it("should skip S3 deletion if s3Key is missing, but proceed with Pinecone", async () => {
    const event = createStreamEvent("REMOVE", {
      documentId: "doc-123",
      // s3Key missing
    });

    await handler(event);

    expect(mockDeleteS3Object).not.toHaveBeenCalled();

    // Pinecone削除は呼ばれるべき
    expect(mockDeleteDocumentVectors).toHaveBeenCalledWith(
      expect.anything(),
      "doc-123"
    );
  });

  it("should log error if S3 deletion fails, but continue to Pinecone deletion", async () => {
    // S3削除でエラー発生
    mockDeleteS3Object.mockRejectedValue(new Error("S3 Error"));

    const event = createStreamEvent("REMOVE", {
      documentId: "doc-123",
      s3Key: "uploads/doc-123.pdf",
    });

    await handler(event);

    // エラーログが出力されていること
    expect(mockLogger).toHaveBeenCalledWith(
      "ERROR",
      "Failed to delete S3 object",
      expect.objectContaining({
        error: "S3 Error",
        documentId: "doc-123",
      })
    );

    // Pinecone削除は呼ばれるべき (Promise.allで並列実行されるため)
    expect(mockDeleteDocumentVectors).toHaveBeenCalled();
  });

  it("should log error if Pinecone deletion fails, but allow S3 deletion to complete", async () => {
    // Pinecone削除でエラー発生
    mockDeleteDocumentVectors.mockRejectedValue(new Error("Pinecone Error"));

    const event = createStreamEvent("REMOVE", {
      documentId: "doc-123",
      s3Key: "uploads/doc-123.pdf",
    });

    await handler(event);

    // エラーログが出力されていること
    expect(mockLogger).toHaveBeenCalledWith(
      "ERROR",
      "Failed to delete Pinecone vectors",
      expect.objectContaining({
        error: "Pinecone Error",
        documentId: "doc-123",
      })
    );

    // S3削除は呼ばれるべき
    expect(mockDeleteS3Object).toHaveBeenCalled();
  });

  it("should handle multiple records in one event", async () => {
    type StreamRecord = NonNullable<
      DynamoDBStreamEvent["Records"][0]["dynamodb"]
    >;
    const event: DynamoDBStreamEvent = {
      Records: [
        {
          eventName: "REMOVE",
          dynamodb: {
            OldImage: {
              documentId: { S: "doc-1" },
              s3Key: { S: "key-1" },
            } as StreamRecord["OldImage"],
          },
        },
        {
          eventName: "INSERT", // 無視されるべき
          dynamodb: {
            NewImage: {
              documentId: { S: "doc-2" },
            } as StreamRecord["NewImage"],
          },
        },
        {
          eventName: "REMOVE",
          dynamodb: {
            OldImage: {
              documentId: { S: "doc-3" },
              s3Key: { S: "key-3" },
            } as StreamRecord["OldImage"],
          },
        },
      ],
    };

    await handler(event);

    // doc-1 と doc-3 に対して処理が走る
    expect(mockDeleteS3Object).toHaveBeenCalledTimes(2);
    expect(mockDeleteDocumentVectors).toHaveBeenCalledTimes(2);

    // 呼び出し引数の検証
    expect(mockDeleteS3Object).toHaveBeenCalledWith(
      expect.anything(),
      "test-bucket",
      "key-1"
    );
    expect(mockDeleteS3Object).toHaveBeenCalledWith(
      expect.anything(),
      "test-bucket",
      "key-3"
    );
  });
});
