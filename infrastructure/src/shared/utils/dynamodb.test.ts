import { createDynamoDBClient, decodeCursor, encodeCursor } from "./dynamodb";

describe("DynamoDB Utils", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("createDynamoDBClient", () => {
    it("should create client with local endpoint in local stage", () => {
      process.env.STAGE = "local";
      process.env.DYNAMODB_ENDPOINT = "http://localhost:8000";
      process.env.AWS_REGION = "ap-northeast-1";

      const client = createDynamoDBClient();
      expect(client).toBeDefined();
      // 注: 内部設定の完全な検証は難しいが、エラーなく生成されることは確認
    });

    it("should create client with default region when AWS_REGION is not set", () => {
      delete process.env.STAGE;
      delete process.env.DYNAMODB_ENDPOINT;
      delete process.env.AWS_REGION;

      const client = createDynamoDBClient();
      expect(client).toBeDefined();
    });

    it("should create client with custom region", () => {
      delete process.env.STAGE;
      delete process.env.DYNAMODB_ENDPOINT;
      process.env.AWS_REGION = "us-east-1";

      const client = createDynamoDBClient();
      expect(client).toBeDefined();
    });

    it("should create client without endpoint in production stage", () => {
      delete process.env.STAGE;
      delete process.env.DYNAMODB_ENDPOINT;
      process.env.AWS_REGION = "ap-northeast-1";

      const client = createDynamoDBClient();
      expect(client).toBeDefined();
    });
  });

  describe("encodeCursor", () => {
    it("should encode simple key object", () => {
      const key = { pk: "SESSION#123", sk: "MSG#2024-01-01" };
      const encoded = encodeCursor(key);

      expect(typeof encoded).toBe("string");
      expect(encoded.length).toBeGreaterThan(0);
      // Base64文字列になっているか簡易チェック
      expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it("should encode empty object", () => {
      const key = {};
      const encoded = encodeCursor(key);

      expect(typeof encoded).toBe("string");
      const decoded = decodeCursor(encoded);
      expect(decoded).toEqual({});
    });

    it("should encode nested object", () => {
      const key = {
        pk: "SESSION#123",
        sk: "MSG#2024-01-01",
        nested: { foo: "bar", num: 42 },
      };
      const encoded = encodeCursor(key);
      const decoded = decodeCursor(encoded);

      expect(decoded).toEqual(key);
    });

    it("should encode object with special characters", () => {
      const key = {
        pk: "SESSION#123",
        sk: "MSG#日本語テスト",
        special: "!@#$%^&*()",
      };
      const encoded = encodeCursor(key);
      const decoded = decodeCursor(encoded);

      expect(decoded).toEqual(key);
    });

    it("should encode object with array values", () => {
      const key = {
        pk: "SESSION#123",
        items: ["item1", "item2", "item3"],
      };
      const encoded = encodeCursor(key);
      const decoded = decodeCursor(encoded);

      expect(decoded).toEqual(key);
    });

    it("should encode object with number values", () => {
      const key = {
        pk: "SESSION#123",
        timestamp: 1234567890,
        count: 42,
      };
      const encoded = encodeCursor(key);
      const decoded = decodeCursor(encoded);

      expect(decoded).toEqual(key);
    });
  });

  describe("decodeCursor", () => {
    it("should decode valid cursor correctly", () => {
      const originalKey = {
        pk: "SESSION#123",
        sk: "MSG#2024-01-01",
      };

      const encoded = encodeCursor(originalKey);
      const decoded = decodeCursor(encoded);

      expect(decoded).toEqual(originalKey);
    });

    it("should return undefined for invalid base64 string", () => {
      const invalidCursor = "invalid-base64-string!!!";
      const decoded = decodeCursor(invalidCursor);

      expect(decoded).toBeUndefined();
    });

    it("should return undefined for empty string", () => {
      const decoded = decodeCursor("");

      expect(decoded).toBeUndefined();
    });

    it("should return undefined for non-JSON base64 string", () => {
      // 有効なBase64だが、JSONとしてパースできない文字列
      const validBase64 = Buffer.from("not-json").toString("base64");
      const decoded = decodeCursor(validBase64);

      expect(decoded).toBeUndefined();
    });

    it("should handle round-trip encoding/decoding", () => {
      const testCases = [
        { pk: "SESSION#1", sk: "MSG#1" },
        { pk: "SESSION#2", sk: "MSG#2", extra: "data" },
        { pk: "SESSION#3", nested: { a: 1, b: "test" } },
        {},
      ];

      testCases.forEach((key) => {
        const encoded = encodeCursor(key);
        const decoded = decodeCursor(encoded);
        expect(decoded).toEqual(key);
      });
    });
  });
});
