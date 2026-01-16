// infrastructure/src/functions/cleanup/index.ts

import { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { DynamoDBStreamEvent } from "aws-lambda";

import { logger } from "../../shared/utils/api-handler";
import { createS3Client, deleteS3Object } from "../../shared/utils/s3";

const BUCKET_NAME = process.env.BUCKET_NAME!;

const s3Client = createS3Client();

interface CleanupDocumentData {
  documentId?: string;
  s3Key?: string;
}

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  for (const record of event.Records) {
    if (record.eventName !== "REMOVE") {
      continue;
    }

    if (!record.dynamodb?.OldImage) {
      continue;
    }

    const oldImage = unmarshall(
      record.dynamodb.OldImage as Record<string, AttributeValue>
    ) as CleanupDocumentData;
    const { documentId, s3Key } = oldImage;

    // S3からファイルを削除
    if (s3Key) {
      try {
        await deleteS3Object(s3Client, BUCKET_NAME, s3Key);
      } catch (err: unknown) {
        logger("ERROR", "Failed to delete S3 object", {
          documentId,
          s3Key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      logger("WARN", "No s3Key found for document cleanup", {
        documentId,
      });
    }
  }
};
