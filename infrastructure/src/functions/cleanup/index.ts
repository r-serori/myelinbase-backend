// infrastructure/src/functions/cleanup/index.ts

import { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { DynamoDBStreamEvent } from "aws-lambda";

import {
  createPineconeClient,
  deleteDocumentVectors,
  getPineconeApiKey,
} from "../../shared/clients/pinecone";
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

    const promises: Promise<void>[] = [];

    if (s3Key) {
      promises.push(
        deleteS3Object(s3Client, BUCKET_NAME, s3Key)
          .then(() => {})
          .catch((err: unknown) => {
            logger("ERROR", "Failed to delete S3 object", {
              documentId,
              s3Key,
              error: err instanceof Error ? err.message : String(err),
            });
          })
      );
    }

    promises.push(
      (async () => {
        try {
          const apiKey = await getPineconeApiKey();
          const pinecone = createPineconeClient(apiKey);
          if (documentId) {
            await deleteDocumentVectors(pinecone, documentId);
          }
        } catch (err: unknown) {
          logger("ERROR", "Failed to delete Pinecone vectors", {
            documentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })()
    );

    await Promise.all(promises);
  }
};
