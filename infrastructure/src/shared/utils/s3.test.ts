import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { mockClient } from "aws-sdk-client-mock";

import {
  buildS3Uri,
  createS3Client,
  deleteS3Object,
  generateDownloadUrl,
  generateUploadUrl,
  parseS3Uri,
} from "./s3";

// getSignedUrl をモック化
jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn(),
}));

const s3Mock = mockClient(S3Client);
const mockGetSignedUrl = getSignedUrl as jest.MockedFunction<
  typeof getSignedUrl
>;

describe("S3 Utils", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    s3Mock.reset();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("createS3Client", () => {
    it("should create client with default region", () => {
      delete process.env.STAGE;
      delete process.env.S3_ENDPOINT;
      process.env.AWS_REGION = "ap-northeast-1";

      const client = createS3Client();
      expect(client).toBeDefined();
    });

    it("should create client with local endpoint in local stage", () => {
      process.env.STAGE = "local";
      process.env.S3_ENDPOINT = "http://localhost:4566";
      process.env.AWS_REGION = "ap-northeast-1";

      const client = createS3Client();
      expect(client).toBeDefined();
    });

    it("should create client with custom region", () => {
      delete process.env.STAGE;
      delete process.env.S3_ENDPOINT;
      process.env.AWS_REGION = "us-east-1";

      const client = createS3Client();
      expect(client).toBeDefined();
    });
  });

  describe("parseS3Uri", () => {
    it("should parse valid s3 uri with simple path", () => {
      const uri = "s3://my-bucket/path/to/file.pdf";
      const result = parseS3Uri(uri);

      expect(result).toEqual({
        bucket: "my-bucket",
        key: "path/to/file.pdf",
      });
    });

    it("should parse valid s3 uri with root key", () => {
      const uri = "s3://my-bucket/file.pdf";
      const result = parseS3Uri(uri);

      expect(result).toEqual({
        bucket: "my-bucket",
        key: "file.pdf",
      });
    });

    it("should parse valid s3 uri with nested path", () => {
      const uri = "s3://my-bucket/folder1/folder2/folder3/file.pdf";
      const result = parseS3Uri(uri);

      expect(result).toEqual({
        bucket: "my-bucket",
        key: "folder1/folder2/folder3/file.pdf",
      });
    });

    it("should parse valid s3 uri with special characters in key", () => {
      const uri = "s3://my-bucket/path/to/file%20with%20spaces.pdf";
      const result = parseS3Uri(uri);

      expect(result).toEqual({
        bucket: "my-bucket",
        key: "path/to/file%20with%20spaces.pdf",
      });
    });

    it("should throw error for invalid uri format (https)", () => {
      const invalidUri = "https://s3.amazonaws.com/bucket/key";
      expect(() => parseS3Uri(invalidUri)).toThrow("Invalid S3 URI");
    });

    it("should throw error for invalid uri format (missing s3://)", () => {
      const invalidUri = "my-bucket/path/to/file.pdf";
      expect(() => parseS3Uri(invalidUri)).toThrow("Invalid S3 URI");
    });

    it("should throw error for invalid uri format (missing bucket)", () => {
      const invalidUri = "s3:///path/to/file.pdf";
      expect(() => parseS3Uri(invalidUri)).toThrow("Invalid S3 URI");
    });

    it("should throw error for empty string", () => {
      expect(() => parseS3Uri("")).toThrow("Invalid S3 URI");
    });
  });

  describe("buildS3Uri", () => {
    it("should build correct s3 uri with simple path", () => {
      const bucket = "test-bucket";
      const key = "folder/image.png";
      const uri = buildS3Uri(bucket, key);

      expect(uri).toBe("s3://test-bucket/folder/image.png");
    });

    it("should build correct s3 uri with root key", () => {
      const bucket = "test-bucket";
      const key = "file.pdf";
      const uri = buildS3Uri(bucket, key);

      expect(uri).toBe("s3://test-bucket/file.pdf");
    });

    it("should build correct s3 uri with nested path", () => {
      const bucket = "test-bucket";
      const key = "folder1/folder2/file.txt";
      const uri = buildS3Uri(bucket, key);

      expect(uri).toBe("s3://test-bucket/folder1/folder2/file.txt");
    });

    it("should build correct s3 uri with special characters", () => {
      const bucket = "test-bucket";
      const key = "path/to/file%20with%20spaces.pdf";
      const uri = buildS3Uri(bucket, key);

      expect(uri).toBe("s3://test-bucket/path/to/file%20with%20spaces.pdf");
    });

    it("should handle round-trip parse/build", () => {
      const originalUri = "s3://my-bucket/path/to/file.pdf";
      const { bucket, key } = parseS3Uri(originalUri);
      const rebuiltUri = buildS3Uri(bucket, key);

      expect(rebuiltUri).toBe(originalUri);
    });
  });

  describe("generateUploadUrl", () => {
    it("should generate presigned upload URL", async () => {
      const mockUrl = "https://s3.amazonaws.com/bucket/key?signature=xyz";
      mockGetSignedUrl.mockResolvedValue(mockUrl);

      const s3Client = createS3Client();
      const url = await generateUploadUrl(
        s3Client,
        "test-bucket",
        "uploads/file.pdf",
        "application/pdf",
        900
      );

      expect(url).toBe(mockUrl);
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
      // getSignedUrl(s3Client, command, options) の順序
      const command = mockGetSignedUrl.mock.calls[0][1];
      expect(command).toBeInstanceOf(PutObjectCommand);
    });

    it("should use default expiry time when not provided", async () => {
      const mockUrl = "https://s3.amazonaws.com/bucket/key?signature=xyz";
      mockGetSignedUrl.mockResolvedValue(mockUrl);

      const s3Client = createS3Client();
      await generateUploadUrl(
        s3Client,
        "test-bucket",
        "uploads/file.pdf",
        "application/pdf"
      );

      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { expiresIn: 900 }
      );
    });

    it("should use custom expiry time", async () => {
      const mockUrl = "https://s3.amazonaws.com/bucket/key?signature=xyz";
      mockGetSignedUrl.mockResolvedValue(mockUrl);

      const s3Client = createS3Client();
      await generateUploadUrl(
        s3Client,
        "test-bucket",
        "uploads/file.pdf",
        "application/pdf",
        3600
      );

      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { expiresIn: 3600 }
      );
    });
  });

  describe("generateDownloadUrl", () => {
    it("should generate presigned download URL", async () => {
      const mockUrl = "https://s3.amazonaws.com/bucket/key?signature=xyz";
      mockGetSignedUrl.mockResolvedValue(mockUrl);

      const s3Client = createS3Client();
      const url = await generateDownloadUrl(
        s3Client,
        "test-bucket",
        "uploads/file.pdf",
        "application/pdf",
        3600
      );

      expect(url).toBe(mockUrl);
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
      // getSignedUrl(s3Client, command, options) の順序
      const command = mockGetSignedUrl.mock.calls[0][1];
      expect(command).toBeInstanceOf(GetObjectCommand);
    });

    it("should use default expiry time when not provided", async () => {
      const mockUrl = "https://s3.amazonaws.com/bucket/key?signature=xyz";
      mockGetSignedUrl.mockResolvedValue(mockUrl);

      const s3Client = createS3Client();
      await generateDownloadUrl(
        s3Client,
        "test-bucket",
        "uploads/file.pdf",
        "application/pdf"
      );

      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { expiresIn: 3600 }
      );
    });

    it("should handle undefined contentType", async () => {
      const mockUrl = "https://s3.amazonaws.com/bucket/key?signature=xyz";
      mockGetSignedUrl.mockResolvedValue(mockUrl);

      const s3Client = createS3Client();
      await generateDownloadUrl(
        s3Client,
        "test-bucket",
        "uploads/file.pdf",
        undefined,
        3600
      );

      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
    });
  });

  describe("deleteS3Object", () => {
    it("should delete S3 object successfully", async () => {
      s3Mock.on(DeleteObjectCommand).resolves({});

      const s3Client = createS3Client();
      await deleteS3Object(s3Client, "test-bucket", "uploads/file.pdf");

      expect(s3Mock.calls()).toHaveLength(1);
      const command = s3Mock.call(0).args[0];
      expect(command).toBeInstanceOf(DeleteObjectCommand);
      expect(command.input).toEqual({
        Bucket: "test-bucket",
        Key: "uploads/file.pdf",
      });
    });

    it("should throw error if deletion fails", async () => {
      s3Mock.on(DeleteObjectCommand).rejects(new Error("S3 Error"));

      const s3Client = createS3Client();
      await expect(
        deleteS3Object(s3Client, "test-bucket", "uploads/file.pdf")
      ).rejects.toThrow("S3 Error");
    });
  });
});
