// infrastructure/src/functions/processor/index.test.ts
process.env.TABLE_NAME = "TestTable";
process.env.BUCKET_NAME = "TestBucket";

import { S3Client } from "@aws-sdk/client-s3";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { handler } from "./index";

// Mock modules
jest.mock("../../shared/clients/bedrock");
// pineconeの関数を個別にモック化する
jest.mock("../../shared/clients/pinecone", () => {
  const original = jest.requireActual("../../shared/clients/pinecone");
  return {
    ...original,
    createPineconeClient: jest.fn(),
    getPineconeApiKey: jest.fn(),
    upsertDocumentVectors: jest.fn(),
    // generateVectorId は実際の関数を使用（モック不要）
  };
});

// src/shared/utils/text-processing は一部のみモック化（Small to Bigロジックは実体を使う）
jest.mock("../../shared/utils/text-processing", () => {
  const original = jest.requireActual("../../shared/utils/text-processing");
  return {
    ...original,
    extractTextFromS3: jest.fn(),
    // PDFパースは外部依存なので、extractTextFromS3の内部呼び出しもモック化
    // ここでは extractTextFromS3 自体をモック化しているので、内部の extractTextFromPdf のモックは不要だが
    // もしテスト対象コードでインポートエラーになる場合は考慮が必要
  };
});

// モックのインポート
import { generateEmbeddings } from "../../shared/clients/bedrock";
import {
  createPineconeClient,
  getPineconeApiKey,
  upsertDocumentVectors,
} from "../../shared/clients/pinecone";
import {
  ChunkData,
  EmbedAndUpsertResponse,
  ExtractAndChunkResponse,
  ProcessorEvent,
} from "../../shared/types/processor";
import { extractTextFromS3 } from "../../shared/utils/text-processing";

// --- AWS Client Mocks ---
const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

describe("Processor Function", () => {
  beforeEach(() => {
    ddbMock.reset();
    s3Mock.reset();
    jest.clearAllMocks();

    // デフォルトのモック動作
    (extractTextFromS3 as jest.Mock).mockResolvedValue(
      "This is extracted text."
    );
    (generateEmbeddings as jest.Mock).mockResolvedValue([
      [0.1, 0.2, 0.3], // Chunk 1
      [0.4, 0.5, 0.6], // Chunk 2
    ]);
    (getPineconeApiKey as jest.Mock).mockResolvedValue("mock-api-key");
    (createPineconeClient as jest.Mock).mockReturnValue({});
    (upsertDocumentVectors as jest.Mock).mockResolvedValue(undefined);
  });

  // ==========================================
  // Action: updateStatus
  // ==========================================
  describe("action: updateStatus", () => {
    it("should update status to PROCESSING", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const event: ProcessorEvent = {
        action: "updateStatus",
        status: "PROCESSING",
        payload: { documentId: "doc-123" },
      };

      const result = await handler(event);

      expect(result).toEqual({ documentId: "doc-123", status: "PROCESSING" });

      expect(ddbMock.calls()).toHaveLength(1);
      const args = ddbMock.call(0).args[0].input as UpdateCommandInput;
      expect(args.Key?.documentId).toBe("doc-123");
      expect(args.ExpressionAttributeValues?.[":status"]).toBe("PROCESSING");
      expect(args.ExpressionAttributeValues?.[":active"]).toBe("ACTIVE");
    });

    it("should update status to COMPLETED and remove processingStatus", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const event: ProcessorEvent = {
        action: "updateStatus",
        status: "COMPLETED",
        payload: { documentId: "doc-123" },
      };

      await handler(event);

      const args = ddbMock.call(0).args[0].input as UpdateCommandInput;
      expect(args.ExpressionAttributeValues?.[":status"]).toBe("COMPLETED");
      expect(args.UpdateExpression).toContain("REMOVE processingStatus");
    });

    it("should include error message when status is FAILED", async () => {
      ddbMock.on(UpdateCommand).resolves({});

      const event: ProcessorEvent = {
        action: "updateStatus",
        status: "FAILED",
        payload: { documentId: "doc-123" },
        error: { message: "Something went wrong" },
      };

      await handler(event);

      const args = ddbMock.call(0).args[0].input as UpdateCommandInput;
      expect(args.ExpressionAttributeValues?.[":status"]).toBe("FAILED");
      expect(args.ExpressionAttributeValues?.[":error"]).toContain(
        "Something went wrong"
      );
    });
  });

  // ==========================================
  // Action: extractAndChunk
  // ==========================================
  describe("action: extractAndChunk", () => {
    it("should extract text and split into Small-to-Big chunks", async () => {
      // DBからメタデータ取得のモック
      ddbMock.on(GetCommand).resolves({
        Item: {
          documentId: "doc-123",
          contentType: "application/pdf",
          fileName: "test.pdf",
          ownerId: "user-1",
        },
      });

      // extractTextFromS3のモック（ある程度長いテキストを返す）
      // createSmallToBigChunksは実体が動くため、実際に分割される長さが必要
      // ParentSize=800 なので、それ以上の長さにする
      const longText = "A".repeat(1000);
      (extractTextFromS3 as jest.Mock).mockResolvedValue(longText);

      const event: ProcessorEvent = {
        action: "extractAndChunk",
        payload: {
          documentId: "doc-123",
          bucket: "my-bucket",
          key: "uploads/test.pdf",
        },
      };

      const result = (await handler(event)) as ExtractAndChunkResponse;

      // 結果の検証
      expect(result.documentId).toBe("doc-123");
      expect(result.text).toBe(""); // RawTextは空文字で返す仕様に変更済み

      // chunksの検証: ChunkData[] 型になっているか
      expect(result.chunks.length).toBeGreaterThan(0);
      const firstChunk = result.chunks[0];

      // Small to Big の構造を持っているか確認
      expect(firstChunk).toHaveProperty("childText");
      expect(firstChunk).toHaveProperty("parentText");
      expect(firstChunk).toHaveProperty("chunkIndex");
      expect(firstChunk).toHaveProperty("parentId");

      // ChildはParentに含まれているはず
      expect(firstChunk.parentText).toContain(firstChunk.childText);

      // 呼び出し検証
      expect(ddbMock.calls()).toHaveLength(1);
      expect(extractTextFromS3).toHaveBeenCalledWith(
        expect.anything(),
        "my-bucket",
        "uploads/test.pdf",
        "application/pdf"
      );
    });

    it("should throw error if document not found in DB", async () => {
      ddbMock.on(GetCommand).resolves({}); // Itemなし

      const event: ProcessorEvent = {
        action: "extractAndChunk",
        payload: {
          documentId: "doc-missing",
          bucket: "my-bucket",
          key: "key",
        },
      };

      await expect(handler(event)).rejects.toThrow(
        "Document doc-missing not found"
      );
    });
  });

  // ==========================================
  // Action: embedAndUpsert
  // ==========================================
  describe("action: embedAndUpsert", () => {
    it("should generate embeddings for CHILD text and upsert PARENT text to Pinecone", async () => {
      // DBからメタデータ取得のモック
      ddbMock.on(GetCommand).resolves({
        Item: {
          documentId: "doc-123",
          fileName: "test.pdf",
          ownerId: "user-1",
        },
      });

      // Small to Big 形式のチャンクデータ
      const chunks: ChunkData[] = [
        {
          childText: "child-1",
          parentText: "parent-1-content-is-long",
          chunkIndex: 0,
          parentId: "parent-id-1",
        },
        {
          childText: "child-2",
          parentText: "parent-1-content-is-long", // 同じ親を持つケース
          chunkIndex: 1,
          parentId: "parent-id-1",
        },
      ];

      const event: ProcessorEvent = {
        action: "embedAndUpsert",
        payload: {
          documentId: "doc-123",
          chunks,
        },
      };

      const result = (await handler(event)) as EmbedAndUpsertResponse;

      // 検証
      expect(result).toEqual({ documentId: "doc-123", vectorCount: 2 });

      // Embedding生成: "Child Text" が渡されていることを確認
      expect(generateEmbeddings).toHaveBeenCalledWith(["child-1", "child-2"]);

      // Pinecone保存
      expect(getPineconeApiKey).toHaveBeenCalled();
      expect(createPineconeClient).toHaveBeenCalled();
      expect(upsertDocumentVectors).toHaveBeenCalledTimes(1);

      // upsertDocumentVectorsの引数検証
      const upsertArgs = (upsertDocumentVectors as jest.Mock).mock.calls[0];
      const vectors = upsertArgs[1] as Array<{
        id: string;
        values: number[];
        metadata: { text: string; parentId: string };
      }>; // [0] = client, [1] = vectors
      expect(vectors).toHaveLength(2);

      // メタデータには "Parent Text" が保存されていることを確認
      expect(vectors[0].metadata.text).toBe("parent-1-content-is-long");
      expect(vectors[0].metadata.parentId).toBe("parent-id-1");

      // ID生成確認
      expect(vectors[0].id).toBe("doc-123#0");
    });
  });

  // ==========================================
  // Unknown Action
  // ==========================================
  it("should throw error for unknown action", async () => {
    const event = {
      action: "unknownAction" as ProcessorEvent["action"],
      payload: { documentId: "doc-123" },
    };

    await expect(handler(event as ProcessorEvent)).rejects.toThrow(
      "Unknown action: unknownAction"
    );
  });
});
