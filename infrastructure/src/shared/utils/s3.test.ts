import { buildS3Uri, parseS3Uri } from "./s3";

describe("S3 Utils", () => {
  describe("parseS3Uri", () => {
    it("should parse valid s3 uri", () => {
      const uri = "s3://my-bucket/path/to/file.pdf";
      const result = parseS3Uri(uri);

      expect(result).toEqual({
        bucket: "my-bucket",
        key: "path/to/file.pdf",
      });
    });

    it("should throw error for invalid uri", () => {
      const invalidUri = "https://s3.amazonaws.com/bucket/key";
      expect(() => parseS3Uri(invalidUri)).toThrow("Invalid S3 URI");
    });
  });

  describe("buildS3Uri", () => {
    it("should build correct s3 uri", () => {
      const bucket = "test-bucket";
      const key = "folder/image.png";
      const uri = buildS3Uri(bucket, key);

      expect(uri).toBe("s3://test-bucket/folder/image.png");
    });
  });
});
