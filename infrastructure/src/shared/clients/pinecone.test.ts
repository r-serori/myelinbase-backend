// 環境変数の設定
process.env.PINECONE_API_KEY_PARAMETER_NAME = "/test/pinecone-api-key";

import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { Pinecone } from "@pinecone-database/pinecone";
import { mockClient } from "aws-sdk-client-mock";

import {
  createPineconeClient,
  deleteDocumentVectors,
  generateVectorId,
  getPineconeApiKey,
  searchVectors,
  searchVectorsByOwner,
  upsertDocumentVectors,
} from "../../../src/shared/clients/pinecone";

// --- Mocks Setup ---

// 1. AWS SSM Mock
const ssmMock = mockClient(SSMClient);

// 2. Pinecone Mock
// index() メソッドが返すオブジェクト（操作用メソッドを持つ）を定義
// listPaginated を追加
const mockIndex = {
  upsert: jest.fn(),
  deleteMany: jest.fn(),
  query: jest.fn(),
  listPaginated: jest.fn(),
};

// Pinecone クラス自体のモック
// new Pinecone() されたときに、index() メソッドを持つオブジェクトを返すようにする
jest.mock("@pinecone-database/pinecone", () => {
  return {
    Pinecone: jest.fn().mockImplementation(() => ({
      index: jest.fn().mockReturnValue(mockIndex),
    })),
  };
});

describe("Pinecone Client Utility", () => {
  beforeEach(() => {
    ssmMock.reset();
    jest.clearAllMocks();

    // モックのデフォルト戻り値設定
    mockIndex.upsert.mockResolvedValue({});
    mockIndex.deleteMany.mockResolvedValue({});
    mockIndex.query.mockResolvedValue({ matches: [] });
    mockIndex.listPaginated.mockResolvedValue({ vectors: [] });
  });

  // ==========================================
  // getPineconeApiKey
  // ==========================================
  describe("getPineconeApiKey", () => {
    it("should fetch API key from SSM Parameter Store and cache it", async () => {
      // 1回目の呼び出し: SSM Parameter Storeから取得
      ssmMock.on(GetParameterCommand).resolves({
        Parameter: { Value: "test-api-key" },
      });

      // 注: モジュールレベルの変数(cachedPineconeApiKey)の状態に依存するため、
      // テストの実行順序によってはキャッシュが残っている可能性があります。
      const apiKey1 = await getPineconeApiKey();
      expect(apiKey1).toBe("test-api-key");
      expect(ssmMock.calls()).toHaveLength(1);

      // 2回目の呼び出し: キャッシュが使われるはず
      const apiKey2 = await getPineconeApiKey();
      expect(apiKey2).toBe("test-api-key");
      expect(ssmMock.calls()).toHaveLength(1); // 呼び出し回数が増えていないこと
    });
  });

  // ==========================================
  // createPineconeClient
  // ==========================================
  describe("createPineconeClient", () => {
    it("should create a Pinecone instance with the provided API key", () => {
      const apiKey = "test-key";
      const client = createPineconeClient(apiKey);

      expect(Pinecone).toHaveBeenCalledWith({ apiKey });
      expect(client).toBeDefined();
    });
  });

  // ==========================================
  // generateVectorId
  // ==========================================
  describe("generateVectorId", () => {
    it("should generate correct vector ID", () => {
      const id = generateVectorId("doc-123", 5);
      expect(id).toBe("doc-123#5");
    });
  });

  // ==========================================
  // upsertDocumentVectors
  // ==========================================
  describe("upsertDocumentVectors", () => {
    it("should upsert vectors in batches", async () => {
      const client = new Pinecone({ apiKey: "dummy" });

      // 150個のベクターを用意 (バッチサイズ100の境界テスト)
      const vectors = Array.from({ length: 150 }, (_, i) => ({
        id: `vec-${i}`,
        values: [0.1, 0.2, 0.3],
        metadata: {
          text: `text-${i}`,
          documentId: "doc-dummy",
          fileName: "dummy.txt",
          ownerId: "user-test",
          chunkIndex: i,
          totalChunks: 150,
          createdAt: "2024-01-01",
        },
      }));

      await upsertDocumentVectors(client, vectors);

      // 150件なので、100件 + 50件 の2回呼ばれるはず
      expect(mockIndex.upsert).toHaveBeenCalledTimes(2);

      // 1回目の呼び出し引数検証
      const firstCallArgs = mockIndex.upsert.mock.calls[0][0];
      expect(firstCallArgs).toHaveLength(100);
      expect(firstCallArgs[0].id).toBe("vec-0");

      // 2回目の呼び出し引数検証
      const secondCallArgs = mockIndex.upsert.mock.calls[1][0];
      expect(secondCallArgs).toHaveLength(50);
      expect(secondCallArgs[0].id).toBe("vec-100");
    });
  });

  // ==========================================
  // deleteDocumentVectors (Updated)
  // ==========================================
  describe("deleteDocumentVectors", () => {
    const documentId = "doc-123";
    const prefix = `${documentId}#`;

    it("should list vectors by prefix and delete them", async () => {
      const client = new Pinecone({ apiKey: "dummy" });

      // listPaginated のモックレスポンス設定
      mockIndex.listPaginated.mockResolvedValueOnce({
        vectors: [{ id: "doc-123#0" }, { id: "doc-123#1" }],
        pagination: undefined, // 次のページなし
      });

      await deleteDocumentVectors(client, documentId);

      // 1. listPaginated が正しい prefix で呼ばれたか確認
      expect(mockIndex.listPaginated).toHaveBeenCalledWith({
        prefix,
      });

      // 2. 取得したIDリストで deleteMany が呼ばれたか確認
      expect(mockIndex.deleteMany).toHaveBeenCalledWith([
        "doc-123#0",
        "doc-123#1",
      ]);
    });

    it("should handle pagination when listing vectors", async () => {
      const client = new Pinecone({ apiKey: "dummy" });

      // 1回目の呼び出し: page 1
      mockIndex.listPaginated.mockResolvedValueOnce({
        vectors: [{ id: "doc-123#0" }, { id: "doc-123#1" }],
        pagination: { next: "next-token-123" },
      });

      // 2回目の呼び出し: page 2 (最後)
      mockIndex.listPaginated.mockResolvedValueOnce({
        vectors: [{ id: "doc-123#2" }],
        pagination: undefined,
      });

      await deleteDocumentVectors(client, documentId);

      // listPaginated が2回呼ばれたか
      expect(mockIndex.listPaginated).toHaveBeenCalledTimes(2);

      // 2回目の呼び出しに paginationToken が含まれているか
      expect(mockIndex.listPaginated).toHaveBeenLastCalledWith({
        prefix,
        paginationToken: "next-token-123",
      });

      // 全てのID (0, 1, 2) が削除対象になったか
      expect(mockIndex.deleteMany).toHaveBeenCalledWith([
        "doc-123#0",
        "doc-123#1",
        "doc-123#2",
      ]);
    });

    it("should batch delete requests if vectors exceed DELETE_BATCH_SIZE (1000)", async () => {
      const client = new Pinecone({ apiKey: "dummy" });

      // 1200個のIDを生成して返すようにモック
      const manyVectors = Array.from({ length: 1200 }, (_, i) => ({
        id: `${prefix}${i}`,
      }));

      mockIndex.listPaginated.mockResolvedValueOnce({
        vectors: manyVectors,
      });

      await deleteDocumentVectors(client, documentId);

      // deleteMany は (1000件 + 200件) で2回呼ばれるはず
      expect(mockIndex.deleteMany).toHaveBeenCalledTimes(2);

      // 1回目は1000件
      expect(mockIndex.deleteMany.mock.calls[0][0]).toHaveLength(1000);
      // 2回目は200件
      expect(mockIndex.deleteMany.mock.calls[1][0]).toHaveLength(200);
    });

    it("should not call deleteMany if no vectors are found", async () => {
      const client = new Pinecone({ apiKey: "dummy" });

      // ベクターが見つからない場合
      mockIndex.listPaginated.mockResolvedValueOnce({
        vectors: [],
      });

      await deleteDocumentVectors(client, documentId);

      expect(mockIndex.listPaginated).toHaveBeenCalledWith({ prefix });
      expect(mockIndex.deleteMany).not.toHaveBeenCalled();
    });
  });

  // ==========================================
  // searchVectors / searchVectorsByOwner
  // ==========================================
  describe("searchVectors", () => {
    it("should query vectors and return formatted results", async () => {
      const client = new Pinecone({ apiKey: "dummy" });
      const queryVector = [0.1, 0.2];

      // Pineconeからのレスポンスをモック
      mockIndex.query.mockResolvedValue({
        matches: [
          {
            id: "vec-1",
            score: 0.95,
            metadata: { text: "match1", page: 1 },
          },
          {
            id: "vec-2",
            score: 0.88,
            metadata: { text: "match2", page: 2 },
          },
        ],
      });

      const results = await searchVectors(client, queryVector);

      expect(mockIndex.query).toHaveBeenCalledWith({
        vector: queryVector,
        topK: 5, // デフォルト値
        filter: undefined,
        includeMetadata: true,
      });

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe("vec-1");
      expect(results[0].metadata.text).toBe("match1");
    });

    it("should handle empty matches", async () => {
      mockIndex.query.mockResolvedValue({ matches: [] });
      const client = new Pinecone({ apiKey: "dummy" });
      const results = await searchVectors(client, [0.1]);
      expect(results).toEqual([]);
    });
  });

  describe("searchVectorsByOwner", () => {
    it("should add ownerId filter to the query", async () => {
      const client = new Pinecone({ apiKey: "dummy" });
      const queryVector = [0.1, 0.2];
      const ownerId = "user-001";

      await searchVectorsByOwner(client, queryVector, ownerId, 10);

      expect(mockIndex.query).toHaveBeenCalledWith({
        vector: queryVector,
        topK: 10,
        includeMetadata: true,
        filter: {
          ownerId: { $eq: ownerId },
        },
      });
    });
  });
});
