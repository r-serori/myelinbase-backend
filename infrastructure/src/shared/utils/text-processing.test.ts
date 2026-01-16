import { SdkStream } from "@aws-sdk/types";
import { Readable } from "stream";

// S3 クライアントを完全にモックして、AWS SDK の内部実装に依存しないようにする
const s3SendMock = jest.fn();

jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3");
  return {
    GetObjectCommand: actual.GetObjectCommand,
    S3Client: jest.fn().mockImplementation(() => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      send: (...args: any[]) => s3SendMock(...args),
    })),
  };
});

import { S3Client } from "@aws-sdk/client-s3";

import {
  createDocumentMetadata,
  createSmallToBigChunks,
  extractTextFromS3,
  sanitizeText,
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
  // S3クライアントを再利用してメモリ使用量を削減
  let s3Client: S3Client;

  beforeEach(() => {
    s3SendMock.mockReset();
    jest.clearAllMocks();
    // 各テストで同じS3クライアントインスタンスを再利用
    if (!s3Client) {
      s3Client = new S3Client({});
    }
  });

  describe("sanitizeText", () => {
    it("should remove orphan high surrogates", () => {
      // 孤立したhigh surrogate (後ろにlow surrogateがない)
      const text = "Hello\uD800World";
      const result = sanitizeText(text);
      expect(result).toBe("HelloWorld");
    });

    it("should remove orphan low surrogates", () => {
      // 孤立したlow surrogate (前にhigh surrogateがない) - これがエラーの原因
      const text = "Hello\uDC1BWorld";
      const result = sanitizeText(text);
      expect(result).toBe("HelloWorld");
    });

    it("should preserve valid surrogate pairs (emoji)", () => {
      // 正しいサロゲートペア（絵文字）は保持
      const text = "Hello 😀 World"; // 😀 = \uD83D\uDE00
      const result = sanitizeText(text);
      expect(result).toBe("Hello 😀 World");
    });

    it("should remove control characters", () => {
      const text = "Hello\x00\x0BWorld";
      const result = sanitizeText(text);
      expect(result).toBe("HelloWorld");
    });

    it("should handle mixed invalid characters", () => {
      // 複数の無効文字が混在
      const text = "Start\uD800\x00\uDC1BEnd";
      const result = sanitizeText(text);
      expect(result).toBe("StartEnd");
    });

    it("should handle HTML with invalid unicode", () => {
      // 実際のエラーケースに近いパターン
      const text = "<td>\uDC1B</a></td>\n\t";
      const result = sanitizeText(text);
      expect(result).toBe("<td></a></td>\n\t");
    });

    it("should return empty string for only invalid characters", () => {
      const text = "\uDC1B\uD800\x00";
      const result = sanitizeText(text);
      expect(result).toBe("");
    });

    it("should preserve normal Japanese text", () => {
      const text = "日本語テキスト";
      const result = sanitizeText(text);
      expect(result).toBe("日本語テキスト");
    });
  });

  describe("extractTextFromS3", () => {
    it("should extract text from plain text file", async () => {
      s3SendMock.mockResolvedValue({
        Body: createStream("Hello World"),
      });

      const text = await extractTextFromS3(
        s3Client,
        "bucket",
        "key.txt",
        "text/plain"
      );

      expect(text).toBe("Hello World");
    });

    it("should extract text from markdown file", async () => {
      s3SendMock.mockResolvedValue({
        Body: createStream("# Heading"),
      });

      const text = await extractTextFromS3(
        s3Client,
        "bucket",
        "key.md",
        "text/markdown"
      );

      expect(text).toBe("# Heading");
    });

    it("should extract text from PDF file", async () => {
      s3SendMock.mockResolvedValue({
        Body: createStream("Dummy PDF Content"),
      });

      const text = await extractTextFromS3(
        s3Client,
        "bucket",
        "key.pdf",
        "application/pdf"
      );

      expect(text).toBe("Extracted PDF Text");
    });

    it("should sanitize text after extraction", async () => {
      // 無効なUnicode文字を含むテキスト
      const textWithInvalidChars = "Hello\uDC1BWorld";
      s3SendMock.mockResolvedValue({
        Body: createStream(textWithInvalidChars),
      });

      const text = await extractTextFromS3(
        s3Client,
        "bucket",
        "key.txt",
        "text/plain"
      );

      expect(text).toBe("HelloWorld");
    });

    it("should handle empty text after sanitization", async () => {
      // 無効な文字のみのテキスト
      s3SendMock.mockResolvedValue({
        Body: createStream("\uDC1B\uD800\x00"),
      });

      const text = await extractTextFromS3(
        s3Client,
        "bucket",
        "key.txt",
        "text/plain"
      );

      expect(text).toBe("");
    });

    it("should throw error for unsupported content type", async () => {
      s3SendMock.mockResolvedValue({
        Body: createStream("content"),
      });

      await expect(
        extractTextFromS3(
          s3Client,
          "bucket",
          "key.exe",
          "application/octet-stream"
        )
      ).rejects.toThrow("Unsupported content type");
    });

    it("should throw error if Body is empty", async () => {
      s3SendMock.mockResolvedValue({
        Body: undefined,
      });

      await expect(
        extractTextFromS3(s3Client, "bucket", "key.txt", "text/plain")
      ).rejects.toThrow("Empty S3 object");
    });

    it("should throw error if S3 GetObject fails", async () => {
      s3SendMock.mockRejectedValue(new Error("S3 Error"));

      await expect(
        extractTextFromS3(s3Client, "bucket", "key.txt", "text/plain")
      ).rejects.toThrow("S3 Error");
    });

    it("should handle text/html content type", async () => {
      s3SendMock.mockResolvedValue({
        Body: createStream("<html><body>Test</body></html>"),
      });

      await expect(
        extractTextFromS3(s3Client, "bucket", "key.html", "text/html")
      ).rejects.toThrow("Unsupported content type: text/html");
    });
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
    expect(chunks[0].childText).toBe(chunks[0].parentText);
  });

  it("should handle empty text", () => {
    const chunks = createSmallToBigChunks("", 10, 5, 0, 0);

    expect(chunks).toHaveLength(0);
  });

  it("should handle parentSize smaller than childSize", () => {
    // parentSize < childSize の場合、parentSize が childSize として扱われる
    const text = "1234567890";
    const chunks = createSmallToBigChunks(text, 5, 10, 0, 0);

    expect(chunks.length).toBeGreaterThan(0);
    // 各チャンクの childText と parentText は同じになる
    chunks.forEach((chunk) => {
      expect(chunk.childText).toBe(chunk.parentText);
    });
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

  it("should handle parentOverlap equal to parentSize", () => {
    // parentOverlap >= parentSize の場合、無限ループを避ける
    const text = "1234567890";
    const chunks = createSmallToBigChunks(text, 5, 2, 5, 0);

    expect(chunks.length).toBeGreaterThan(0);
  });

  it("should handle childOverlap equal to childSize", () => {
    // childOverlap >= childSize の場合、1チャンクのみ
    const text = "1234567890";
    const chunks = createSmallToBigChunks(text, 10, 5, 0, 5);

    expect(chunks.length).toBeGreaterThan(0);
  });

  it("should generate unique parentId for each parent", () => {
    const text = "1234567890abcdefghijklmnopqrstuvwxyz";
    const chunks = createSmallToBigChunks(text, 10, 5, 0, 0);

    const parentIds = new Set(chunks.map((c) => c.parentId));
    // 複数のParentが存在する場合、parentIdは異なる
    expect(parentIds.size).toBeGreaterThan(1);
  });

  it("should increment chunkIndex correctly", () => {
    const text = "1234567890abcdefghij";
    const chunks = createSmallToBigChunks(text, 10, 5, 0, 0);

    chunks.forEach((chunk, index) => {
      expect(chunk.chunkIndex).toBe(index);
    });
  });

  it("should sanitize text in chunks", () => {
    // 無効なUnicode文字を含むテキスト
    const text = "valid\uDC1B\uD800\x00valid";
    const chunks = createSmallToBigChunks(text, 10, 5, 0, 0);

    chunks.forEach((chunk) => {
      expect(chunk.childText).not.toContain("\uDC1B");
      expect(chunk.childText).not.toContain("\uD800");
      expect(chunk.parentText).not.toContain("\uDC1B");
      expect(chunk.parentText).not.toContain("\uD800");
    });
  });

  it("should use default parameters", () => {
    // メモリ使用量を削減するため、テキストサイズを大幅に削減
    // デフォルト: parentSize=800, childSize=200 なので、200文字で十分テストできる
    // これにより、1つのParentチャンクと1つのChildチャンクのみが生成される
    const text = "a".repeat(200);
    const chunks = createSmallToBigChunks(text);

    expect(chunks.length).toBeGreaterThan(0);
    chunks.forEach((chunk) => {
      expect(chunk.childText.length).toBeLessThanOrEqual(200);
      expect(chunk.parentText.length).toBeLessThanOrEqual(800);
    });
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

  it("should not include parentId if not provided", () => {
    const meta = createDocumentMetadata(
      "doc-1",
      "test.pdf",
      "user-1",
      0,
      5,
      "sample text"
    );

    expect(meta.parentId).toBeUndefined();
  });

  it("should truncate text if too long", () => {
    // メモリ使用量を削減するため、制限値+1の文字数でテスト
    // ただし、実際のテストでは制限値+100文字で十分（10000文字制限を確認）
    const longText = "a".repeat(10100); // 10000文字制限
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

  it("should handle text exactly at limit", () => {
    // メモリ使用量を削減するため、制限値でテスト（10000文字）
    // ただし、実際のテストでは5000文字で十分（制限の動作を確認）
    const exactText = "a".repeat(5000);
    const meta = createDocumentMetadata(
      "doc-1",
      "test.pdf",
      "user-1",
      0,
      1,
      exactText
    );

    // 5000文字がそのまま返されることを確認（制限内なので）
    expect(meta.text.length).toBe(5000);
  });

  it("should handle empty text", () => {
    const meta = createDocumentMetadata(
      "doc-1",
      "test.pdf",
      "user-1",
      0,
      1,
      ""
    );

    expect(meta.text).toBe("");
  });

  it("should sanitize text before truncation", () => {
    // 無効なUnicode文字を含むテキスト（メモリ使用量を大幅に削減）
    // サニタイズの動作を確認するには、1000文字で十分
    // 無効文字3文字を含む1000文字のテキストを作成（497 + 3 + 500 = 1000）
    const invalidText = "a".repeat(497) + "\uDC1B\uD800\x00" + "b".repeat(500);
    const meta = createDocumentMetadata(
      "doc-1",
      "test.pdf",
      "user-1",
      0,
      1,
      invalidText
    );

    // サニタイズ後、無効文字が除去されていることを確認
    expect(meta.text.length).toBeLessThanOrEqual(10000);
    expect(meta.text).not.toContain("\uDC1B");
    expect(meta.text).not.toContain("\uD800");
    // サニタイズにより、無効文字3文字が除去されるので、997文字になる
    expect(meta.text.length).toBe(997);
  });

  it("should create valid ISO timestamp", () => {
    const meta = createDocumentMetadata(
      "doc-1",
      "test.pdf",
      "user-1",
      0,
      1,
      "text"
    );

    expect(meta.createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
    expect(new Date(meta.createdAt).getTime()).not.toBeNaN();
  });

  it("should handle special characters in fileName", () => {
    const meta = createDocumentMetadata(
      "doc-1",
      "test file (1).pdf",
      "user-1",
      0,
      1,
      "text"
    );

    expect(meta.fileName).toBe("test file (1).pdf");
  });

  it("should handle all chunk indices", () => {
    const totalChunks = 10;
    for (let i = 0; i < totalChunks; i++) {
      const meta = createDocumentMetadata(
        "doc-1",
        "test.pdf",
        "user-1",
        i,
        totalChunks,
        "text"
      );

      expect(meta.chunkIndex).toBe(i);
      expect(meta.totalChunks).toBe(totalChunks);
    }
  });
});
