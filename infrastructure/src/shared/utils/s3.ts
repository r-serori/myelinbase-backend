// infrastructure/src/shared/utils/s3.ts
// S3 ユーティリティ

import { S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

/**
 * S3 Client を作成
 * ローカル環境とAWS環境で自動切り替え
 */
export function createS3Client(): S3Client {
  const config: S3ClientConfig = {
    region: process.env.AWS_REGION || "us-east-1",
  };

  if (process.env.STAGE === "local") {
    config.credentials = {
      accessKeyId: "local",
      secretAccessKey: "local",
    };
    config.endpoint = "http://localhost:4566";
    config.forcePathStyle = true; // LocalStack用
    // LocalStackはチェックサム機能を完全にサポートしていないため、必須でない限り計算しない
    config.requestChecksumCalculation = "WHEN_REQUIRED";
    config.responseChecksumValidation = "WHEN_REQUIRED";
  }

  return new S3Client(config);
}

/**
 * アップロード用署名付きURLを生成
 */
export async function generateUploadUrl(
  s3Client: S3Client,
  bucket: string,
  key: string,
  contentType: string,
  expiresIn: number = 900
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });

  return await getSignedUrl(s3Client, command, { expiresIn });
}

/**
 * ダウンロード用署名付きURLを生成
 */
export async function generateDownloadUrl(
  s3Client: S3Client,
  bucket: string,
  key: string,
  contentType: string | undefined,
  expiresIn: number = 3600
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentType: contentType,
  });

  return await getSignedUrl(s3Client, command, { expiresIn });
}

/**
 * S3 URIをパース
 * 例: s3://bucket-name/path/to/file → { bucket: 'bucket-name', key: 'path/to/file' }
 */
export function parseS3Uri(uri: string): { bucket: string; key: string } {
  const match = uri.match(/^s3:\/\/([^\/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid S3 URI: ${uri}`);
  }
  return {
    bucket: match[1],
    key: match[2],
  };
}

/**
 * S3 URIを生成
 */
export function buildS3Uri(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}
