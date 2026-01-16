// src/functions/trigger/index.ts

import {
  InvocationType,
  InvokeCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";
import { SFNClient, StartSyncExecutionCommand } from "@aws-sdk/client-sfn";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchItemFailure, SQSEvent, SQSHandler } from "aws-lambda";

import { logger } from "../../shared/utils/api-handler";
import { createDynamoDBClient } from "../../shared/utils/dynamodb";

const TABLE_NAME = process.env.TABLE_NAME!;
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;
const isLocal = !STATE_MACHINE_ARN;

const sfnClient = new SFNClient({});
const lambdaClient = new LambdaClient({});
const docClient = createDynamoDBClient();

/**
 * S3イベント通知の形式
 */
interface S3EventNotification {
  Records: Array<{
    s3: {
      bucket: {
        name: string;
      };
      object: {
        key: string;
      };
    };
  }>;
}

/**
 * 処理結果の型
 */
interface ProcessingResult {
  success: boolean;
  shouldRetry: boolean;
  error?: string;
}

/**
 * S3キーからdocumentIdを抽出
 * キー形式: uploads/{ownerId}/{documentId}
 */
function extractDocumentIdFromKey(key: string): string | null {
  const decodedKey = decodeURIComponent(key);
  const parts = decodedKey.split("/");

  // uploads/{ownerId}/{documentId} の形式
  // parts[0] = "uploads"
  // parts[1] = ownerId
  // parts[2] = documentId
  if (parts.length >= 3 && parts[0] === "uploads") {
    return parts[2];
  }

  return null;
}

/**
 * SQSイベントハンドラー
 */
export const handler: SQSHandler = async (event: SQSEvent) => {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      const s3Event: S3EventNotification = JSON.parse(record.body);

      if (!s3Event.Records || s3Event.Records.length === 0) {
        continue;
      }

      for (const s3Record of s3Event.Records) {
        const bucket = s3Record.s3?.bucket?.name;
        const key = s3Record.s3?.object?.key;

        if (!bucket || !key) {
          logger("WARN", "Missing bucket or key in S3 record", {
            bucket,
            key,
            record: s3Record,
          });
          continue;
        }

        const documentId = extractDocumentIdFromKey(key);

        if (!documentId) {
          logger("ERROR", "Could not extract documentId from key", {
            key,
            bucket,
          });
          continue;
        }

        let result: ProcessingResult;

        if (isLocal) {
          result = await processLocally(bucket, key, documentId);
        } else {
          result = await startStepFunctions(bucket, key, documentId);
        }

        if (result.shouldRetry) {
          batchItemFailures.push({ itemIdentifier: record.messageId });
          break;
        }
      }
    } catch (error) {
      logger("ERROR", "Unexpected error in document ingestion", {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};

/**
 * AWS環境用: Step Functionsを開始
 */
async function startStepFunctions(
  bucket: string,
  key: string,
  documentId: string
): Promise<ProcessingResult> {
  const input = { bucket, key, documentId };

  try {
    const result = await sfnClient.send(
      new StartSyncExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN!,
        name: `ingest-${documentId}-${Date.now()}`,
        input: JSON.stringify(input),
      })
    );

    if (result.status === "SUCCEEDED") {
      return { success: true, shouldRetry: false };
    }

    const errorMessage =
      result.status === "TIMED_OUT"
        ? "State Machine timed out after maximum execution time."
        : `State Machine failed: ${result.error || result.cause || "Unknown error"}`;

    logger("ERROR", `Step Functions ${result.status}`, {
      documentId,
      status: result.status,
      error: result.error,
      cause: result.cause,
    });

    const updated = await updateDocumentStatusToFailed(
      documentId,
      errorMessage
    );

    if (updated) {
      return {
        success: false,
        shouldRetry: false,
        error: errorMessage,
      };
    } else {
      return {
        success: false,
        shouldRetry: true,
        error: `${errorMessage} (Failed to update status)`,
      };
    }
  } catch (error) {
    logger("ERROR", "Failed to start Step Functions", {
      documentId,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      shouldRetry: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * ドキュメントステータスをFAILEDに更新
 */
async function updateDocumentStatusToFailed(
  documentId: string,
  errorMessage: string
): Promise<boolean> {
  const now = new Date().toISOString();

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { documentId },
        UpdateExpression:
          "SET #status = :status, #error = :error, #updatedAt = :updatedAt",
        ExpressionAttributeNames: {
          "#status": "status",
          "#error": "error",
          "#updatedAt": "updatedAt",
        },
        ExpressionAttributeValues: {
          ":status": "FAILED",
          ":error": errorMessage,
          ":updatedAt": now,
        },
      })
    );

    return true;
  } catch (updateError) {
    logger("ERROR", "Failed to update document status to FAILED", {
      documentId,
      error:
        updateError instanceof Error
          ? updateError.message
          : String(updateError),
    });

    return false;
  }
}

/**
 * ローカル環境用: Lambda関数を直接呼び出し
 */
async function processLocally(
  bucket: string,
  key: string,
  documentId: string
): Promise<ProcessingResult> {
  try {
    // Step 1: Update status to PROCESSING
    await invokeLambda({
      action: "updateStatus",
      status: "PROCESSING",
      payload: { documentId },
    });

    // Step 2: Extract and Chunk
    const extractResult = await invokeLambda({
      action: "extractAndChunk",
      payload: { documentId, bucket, key },
    });
    const chunksS3Uri = extractResult?.chunksS3Uri;

    // Step 3: Embed and Upsert
    await invokeLambda({
      action: "embedAndUpsert",
      payload: { documentId, chunksS3Uri },
    });

    // Step 4: Update status to COMPLETED
    await invokeLambda({
      action: "updateStatus",
      status: "COMPLETED",
      payload: { documentId },
    });

    return { success: true, shouldRetry: false };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger("ERROR", "[LOCAL] Processing failed, updating status to FAILED", {
      documentId,
      error: errorMessage,
    });

    try {
      await invokeLambda({
        action: "updateStatus",
        status: "FAILED",
        payload: { documentId },
        error: { message: errorMessage },
      });

      return {
        success: false,
        shouldRetry: false,
        error: errorMessage,
      };
    } catch (updateError) {
      logger("ERROR", "[LOCAL] Failed to update status to FAILED", {
        error:
          updateError instanceof Error
            ? updateError.message
            : String(updateError),
      });

      return {
        success: false,
        shouldRetry: true,
        error: errorMessage,
      };
    }
  }
}

/**
 * Lambda関数を呼び出し
 */
async function invokeLambda(
  payload: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const result = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: "myelinbase-local-processor",
      InvocationType: InvocationType.RequestResponse,
      Payload: JSON.stringify(payload),
    })
  );

  if (result.FunctionError) {
    const errorPayload = result.Payload
      ? JSON.parse(Buffer.from(result.Payload).toString())
      : {};
    throw new Error(errorPayload.errorMessage || result.FunctionError);
  }

  if (result.Payload) {
    return JSON.parse(Buffer.from(result.Payload).toString());
  }

  return undefined;
}
