// infrastructure/src/shared/utils/s3.ts

import {
  DeleteObjectCommand,
  S3Client,
  S3ClientConfig,
} from "@aws-sdk/client-s3";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const IS_LOCAL_STAGE = process.env.STAGE === "local";

/**
 * S3 Client を作成
 */
export function createS3Client(): S3Client {
  const config: S3ClientConfig = {
    region: process.env.AWS_REGION || "us-east-1",
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: IS_LOCAL_STAGE,
  };

  if (IS_LOCAL_STAGE) {
    config.requestChecksumCalculation = "WHEN_REQUIRED";
    config.responseChecksumValidation = "WHEN_REQUIRED";
  }

  return new S3Client(config);
}

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

export function parseS3Uri(uri: string): { bucket: string; key: string } {
  const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid S3 URI: ${uri}`);
  }
  return {
    bucket: match[1],
    key: match[2],
  };
}

export function buildS3Uri(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}

/**
 * S3オブジェクトを削除
 */
export async function deleteS3Object(
  s3Client: S3Client,
  bucket: string,
  key: string
): Promise<void> {
  const command = new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  await s3Client.send(command);
}
