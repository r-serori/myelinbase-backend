// src/functions/trigger/index.ts
import { S3Event } from "aws-lambda";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;
const sfnClient = new SFNClient({});

export const handler = async (event: S3Event) => {
  await Promise.all(
    event.Records.map(async (record) => {
      const bucket = record.s3.bucket.name;
      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

      // uploads/ownerId/documentId/filename.ext から documentId を抽出
      const match = key.match(/uploads\/[^\/]+\/([^\/]+)\//);
      const documentId = match ? match[1] : null;

      if (!documentId) {
        console.warn("Could not extract documentId from key:", key);
        return;
      }

      const input = {
        bucket,
        key,
        documentId,
      };

      await sfnClient.send(
        new StartExecutionCommand({
          stateMachineArn: STATE_MACHINE_ARN,
          name: `ingest-${documentId}-${Date.now()}`, // ユニークな実行名
          input: JSON.stringify(input),
        })
      );
    })
  );
};
