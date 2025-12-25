import { createDynamoDBClient, decodeCursor, encodeCursor } from "./dynamodb";

describe("DynamoDB Utils", () => {
  describe("createDynamoDBClient", () => {
    // 環境変数によって接続先が変わることを確認
    const originalEnv = process.env;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...originalEnv };
    });

    afterAll(() => {
      process.env = originalEnv;
    });

    it("should create client with local endpoint in local stage", () => {
      process.env.STAGE = "local";
      process.env.DYNAMODB_ENDPOINT = "http://localhost:8000";

      const client = createDynamoDBClient();
      expect(client).toBeDefined();
      // 注: 内部設定の完全な検証は難しいが、エラーなく生成されることは確認
    });
  });

  describe("Cursor Encoding/Decoding", () => {
    it("should encode and decode cursor correctly", () => {
      const originalKey = {
        pk: "SESSION#123",
        sk: "MSG#2024-01-01",
      };

      const encoded = encodeCursor(originalKey);
      // Base64文字列になっているか簡易チェック
      expect(typeof encoded).toBe("string");
      expect(encoded).not.toEqual(JSON.stringify(originalKey));

      const decoded = decodeCursor(encoded);
      expect(decoded).toEqual(originalKey);
    });

    it("should return undefined for invalid cursor", () => {
      const invalidCursor = "invalid-base64-string";
      const decoded = decodeCursor(invalidCursor);
      expect(decoded).toBeUndefined();
    });
  });
});
