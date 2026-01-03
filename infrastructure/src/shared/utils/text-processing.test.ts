import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SdkStream } from "@aws-sdk/types";
import { mockClient } from "aws-sdk-client-mock";
import { Readable } from "stream";

import {
  createDocumentMetadata,
  createSmallToBigChunks,
  extractTextFromS3,
  splitTextIntoChunks,
} from "./text-processing";

// pdf-parse のモック
// 動的インポートに対応するため、__esModule: true を設定
jest.mock("pdf-parse", () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => {
      return {
        text: "Extracted PDF Text",
        numpages: 1,
        info: {},
        metadata: {},
        version: "1.0.0",
      };
    }),
  };
});

const s3Mock = mockClient(S3Client);

// ストリーム作成ヘルパー - AWS SDK互換のSdkStreamを返す
const createStream = (text: string): SdkStream<Readable> => {
  const stream = new Readable();
  stream.push(text);
  stream.push(null);

  // SdkStream互換のメソッドを追加
  const sdkStream = stream as SdkStream<Readable>;
  sdkStream.transformToByteArray = async () =>
    Promise.resolve(Buffer.from(text));
  sdkStream.transformToString = async () => Promise.resolve(text);
  sdkStream.transformToWebStream = () => {
    throw new Error("Not implemented");
  };

  return sdkStream;
};

describe("Text Processing Utils", () => {
  beforeEach(() => {
    s3Mock.reset();
    jest.clearAllMocks();
  });

  describe("extractTextFromS3", () => {
    it("should extract text from plain text file", async () => {
      s3Mock.on(GetObjectCommand).resolves({
        Body: createStream("Hello World"),
      });

      const text = await extractTextFromS3(
        new S3Client({}),
        "bucket",
        "key.txt",
        "text/plain"
      );

      expect(text).toBe("Hello World");
    });

    it("should extract text from markdown file", async () => {
      s3Mock.on(GetObjectCommand).resolves({
        Body: createStream("# Heading"),
      });

      const text = await extractTextFromS3(
        new S3Client({}),
        "bucket",
        "key.md",
        "text/markdown"
      );

      expect(text).toBe("# Heading");
    });

    it("should extract text from PDF file", async () => {
      s3Mock.on(GetObjectCommand).resolves({
        Body: createStream("Dummy PDF Content"),
      });

      const text = await extractTextFromS3(
        new S3Client({}),
        "bucket",
        "key.pdf",
        "application/pdf"
      );

      expect(text).toBe("Extracted PDF Text");
    });

    it("should throw error for unsupported content type", async () => {
      s3Mock.on(GetObjectCommand).resolves({
        Body: createStream("content"),
      });

      await expect(
        extractTextFromS3(
          new S3Client({}),
          "bucket",
          "key.exe",
          "application/octet-stream"
        )
      ).rejects.toThrow("Unsupported content type");
    });

    it("should throw error if Body is empty", async () => {
      s3Mock.on(GetObjectCommand).resolves({
        Body: undefined,
      });

      await expect(
        extractTextFromS3(new S3Client({}), "bucket", "key.txt", "text/plain")
      ).rejects.toThrow("Empty S3 object");
    });
  });

  describe("splitTextIntoChunks", () => {
    it("should split text into chunks with overlap", () => {
      // 10文字ごとに分割、オーバーラップ2文字
      const text = "1234567890abcdefghij";
      const chunks = splitTextIntoChunks(text, 10, 2);

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toBe("1234567890"); // 0-10
      expect(chunks[1]).toBe("90abcdefgh"); // 8-18 (90がオーバーラップ)
      expect(chunks[2]).toBe("ghij"); // 16-20 (ghがオーバーラップ)
    });

    it("should handle empty text", () => {
      const chunks = splitTextIntoChunks("", 100, 20);
      expect(chunks).toEqual([]);
    });

    it("should handle text shorter than chunk size", () => {
      const text = "short";
      const chunks = splitTextIntoChunks(text, 100, 20);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe("short");
    });

    it("should trim whitespace from chunks", () => {
      const text = "aaaaa     bbbbb";
      const chunks = splitTextIntoChunks(text, 5, 0);

      expect(chunks[0]).toBe("aaaaa");
      // 空白のみのチャンクはフィルタされる
      expect(chunks[1]).toBe("bbbbb");
    });
  });

  describe("createSmallToBigChunks", () => {
    it("should create Parent-Child structure chunks", () => {
      const text = "1234567890abcdefghij";
      // Parent: 10, Child: 5, P-Overlap: 0, C-Overlap: 0
      // P1: 1234567890
      //   C1: 12345
      //   C2: 67890
      // P2: abcdefghij
      //   C3: abcde
      //   C4: fghij

      const chunks = createSmallToBigChunks(text, 10, 5, 0, 0);

      expect(chunks).toHaveLength(4);

      // Check P1 children
      expect(chunks[0].childText).toBe("12345");
      expect(chunks[0].parentText).toBe("1234567890");
      expect(chunks[0].chunkIndex).toBe(0);

      expect(chunks[1].childText).toBe("67890");
      expect(chunks[1].parentText).toBe("1234567890");
      expect(chunks[1].chunkIndex).toBe(1);

      // Same Parent ID check
      expect(chunks[0].parentId).toBe(chunks[1].parentId);

      // Check P2 children
      expect(chunks[2].childText).toBe("abcde");
      expect(chunks[2].parentText).toBe("abcdefghij");
      expect(chunks[2].chunkIndex).toBe(2);

      expect(chunks[3].childText).toBe("fghij");
      expect(chunks[3].parentText).toBe("abcdefghij");
      expect(chunks[3].chunkIndex).toBe(3);

      // Different Parent ID check
      expect(chunks[1].parentId).not.toBe(chunks[2].parentId);
    });

    it("should handle text smaller than child size", () => {
      const text = "small";
      // Parent: 10, Child: 10
      const chunks = createSmallToBigChunks(text, 10, 10, 0, 0);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].childText).toBe("small");
      expect(chunks[0].parentText).toBe("small");
    });

    it("should respect overlaps", () => {
      const text = "1234567890";
      // Parent: 6, Child: 4, P-Overlap: 0, C-Overlap: 2
      // P1: 123456
      //   C1: 1234 (0-4) next=2
      //   C2: 3456 (2-6) next=4
      //   C3: 56   (4-6) next=6 (remaining part)
      // P2: 7890 (6-10)
      //   C4: 7890

      const chunks = createSmallToBigChunks(text, 6, 4, 0, 2);

      expect(chunks).toHaveLength(4);
      expect(chunks[0].childText).toBe("1234");
      expect(chunks[1].childText).toBe("3456");
      expect(chunks[2].childText).toBe("56");
      expect(chunks[3].childText).toBe("7890");
    });
  });

  describe("createDocumentMetadata", () => {
    it("should create correct metadata object", () => {
      const meta = createDocumentMetadata(
        "doc-1",
        "test.pdf",
        "user-1",
        0,
        5,
        "sample text"
      );

      expect(meta).toEqual({
        documentId: "doc-1",
        fileName: "test.pdf",
        ownerId: "user-1",
        chunkIndex: 0,
        totalChunks: 5,
        text: "sample text",
        createdAt: expect.any(String),
      });
    });

    it("should include parentId if provided", () => {
      const meta = createDocumentMetadata(
        "doc-1",
        "test.pdf",
        "user-1",
        0,
        5,
        "sample text",
        "parent-123"
      );

      expect(meta.parentId).toBe("parent-123");
    });

    it("should truncate text if too long", () => {
      const longText = "a".repeat(20000); // 10000文字制限
      const meta = createDocumentMetadata(
        "doc-1",
        "test.pdf",
        "user-1",
        0,
        1,
        longText
      );

      // 10000文字に制限されていることを確認
      expect(meta.text.length).toBe(10000);
    });
  });
});
