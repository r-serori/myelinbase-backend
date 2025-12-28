import { unmarshall } from "@aws-sdk/util-dynamodb";
import { DynamoDBStreamEvent } from "aws-lambda";

import {
  createPineconeClient,
  deleteDocumentVectors,
  getPineconeApiKey,
} from "../../shared/clients/pinecone";
import { createS3Client, deleteS3Object } from "../../shared/utils/s3";

const s3Client = createS3Client();
const BUCKET_NAME = process.env.BUCKET_NAME!;

export const handler = async (event: DynamoDBStreamEvent) => {
  for (const record of event.Records) {
    if (record.eventName === "REMOVE") {
      try {
        const oldImage = unmarshall(record.dynamodb?.OldImage as any);
        const { documentId, s3Key, ownerId } = oldImage;

        console.log(`[Cleanup] Processing removal for document: ${documentId}`);

        const promises: Promise<void>[] = [];

        // 1. S3からファイル削除
        if (s3Key) {
          promises.push(
            deleteS3Object(s3Client, BUCKET_NAME, s3Key)
              .then(() => console.log(`[Cleanup] S3 object deleted: ${s3Key}`))
              .catch((err) =>
                console.error(
                  `[Cleanup] Failed to delete S3 object: ${s3Key}`,
                  err
                )
              )
          );
        }

        // 2. Pineconeからベクトル削除
        // Pinecone API呼び出しはコストがかかる可能性があるため、
        // ベクトルが存在しない可能性がある場合(PENDING_UPLOADなど)のエラーハンドリングを考慮
        promises.push(
          (async () => {
            try {
              const apiKey = await getPineconeApiKey();
              const pinecone = createPineconeClient(apiKey);
              await deleteDocumentVectors(pinecone, documentId);
              console.log(
                `[Cleanup] Pinecone vectors deleted for: ${documentId}`
              );
            } catch (err) {
              console.error(
                `[Cleanup] Failed to delete Pinecone vectors for: ${documentId}`,
                err
              );
            }
          })()
        );

        await Promise.all(promises);
      } catch (error) {
        console.error("[Cleanup] Error processing stream record:", error);
        // Stream Lambdaでのエラーは、リトライループを引き起こす可能性があるため、
        // ログに出力して正常終了させるのが一般的（DLQを設定する場合を除く）
      }
    }
  }
};
