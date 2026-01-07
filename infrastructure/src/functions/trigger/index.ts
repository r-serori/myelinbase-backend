// src/functions/trigger/index.ts
// SQS経由でS3イベントを受信し、Step Functionsを起動する

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import {
  S3Event,
  SQSBatchItemFailure,
  SQSBatchResponse,
  SQSEvent,
} from "aws-lambda";

import { logger } from "../../shared/utils/api-handler";

import { logger } from "../../shared/utils/api-handler";

const IS_LOCAL = process.env.STAGE === "local";

const sfnClient = new SFNClient({});
const lambdaClient = IS_LOCAL
  ? new LambdaClient({
      endpoint: process.env.LOCALSTACK_ENDPOINT,
      region: "ap-northeast-1",
    })
  : new LambdaClient({});

/**
 * メインハンドラー
 * - ローカル環境: S3Event を直接処理
 * - AWS環境: SQSEvent を処理（S3 → SQS → Lambda）
 */
export const handler = async (
  event: SQSEvent | S3Event
): Promise<SQSBatchResponse | void> => {
  // ローカル環境の場合は従来のS3イベント処理
  if (
    IS_LOCAL &&
    "Records" in event &&
    event.Records[0]?.eventSource === "aws:s3"
  ) {
    await handleS3EventLocal(event as S3Event);
    return;
  }

  // AWS環境: SQSイベントを処理
  return handleSQSEvent(event as SQSEvent);
};

/**
 * SQS経由でS3イベントを受信し、Step Functionsを起動
 */
async function handleSQSEvent(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      // SQSメッセージからS3イベントをパース
      const s3Event = JSON.parse(record.body);

      // S3イベント通知の場合、Records配列に入っている
      const s3Records = s3Event.Records || [s3Event];

      for (const s3Record of s3Records) {
        const bucket = s3Record.s3?.bucket?.name;
        const key = decodeURIComponent(
          (s3Record.s3?.object?.key || "").replace(/\+/g, " ")
        );

        // uploads/ownerId/documentId の形式からdocumentIdを抽出
        const match = key.match(/^uploads\/([^/]+)\/([^/]+)$/);
        const documentId = match ? match[2] : null;

        if (!documentId) {
          logger("WARN", "Could not extract documentId from key", {
            key,
            expectedFormat: "uploads/{ownerId}/{documentId}",
          });
          continue;
        }

        await startStepFunctions(bucket, key, documentId);
      }
    } catch (error) {
      logger("ERROR", "Failed to process SQS message", {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : String(error),
      });

      // 失敗したメッセージをレポート（SQSが再試行する）
      batchItemFailures.push({
        itemIdentifier: record.messageId,
      });
    }
  }

  return { batchItemFailures };
}

/**
 * ローカル環境用: S3Eventを直接処理
 */
async function handleS3EventLocal(event: S3Event): Promise<void> {
  await Promise.all(
    event.Records.map(async (record) => {
      const bucket = record.s3.bucket.name;
      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

      // uploads/ownerId/documentId の形式からdocumentIdを抽出
      const match = key.match(/^uploads\/([^/]+)\/([^/]+)$/);
      const documentId = match ? match[2] : null;

      if (!documentId) {
        logger("WARN", "Could not extract documentId from key", {
          key,
          expectedFormat: "uploads/{ownerId}/{documentId}",
        });
        return;
      }

      await invokeProcessorDirectly(bucket, key, documentId);
    })
  );
}

/**
 * ローカル環境用: Processor Lambdaを直接呼び出す
 */
async function invokeProcessorDirectly(
  bucket: string,
  key: string,
  documentId: string
): Promise<void> {
  const processorFunctionName =
    process.env.PROCESSOR_FUNCTION_NAME || "myelinbase-local-doc-processor";

  try {
    // Step 1: ステータスをPROCESSINGに更新
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: processorFunctionName,
        Payload: JSON.stringify({
          action: "updateStatus",
          status: "PROCESSING",
          payload: { documentId },
        }),
      })
    );

    // Step 2: テキスト抽出とチャンク分割
    const extractResponse = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: processorFunctionName,
        Payload: JSON.stringify({
          action: "extractAndChunk",
          payload: {
            documentId,
            bucket,
            key,
          },
        }),
      })
    );

    const extractResult = JSON.parse(
      new TextDecoder().decode(extractResponse.Payload)
    );

    if (extractResult.errorMessage) {
      throw new Error(extractResult.errorMessage);
    }

    // Step 3: Embedding生成とPinecone登録
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: processorFunctionName,
        Payload: JSON.stringify({
          action: "embedAndUpsert",
          payload: {
            documentId,
            chunksS3Uri: extractResult.chunksS3Uri,
          },
        }),
      })
    );

    // Step 4: ステータスをCOMPLETEDに更新
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: processorFunctionName,
        Payload: JSON.stringify({
          action: "updateStatus",
          status: "COMPLETED",
          payload: { documentId },
        }),
      })
    );
  } catch (error) {
    logger("ERROR", "[LOCAL] Processing failed", {
      documentId,
      error: error instanceof Error ? error.message : String(error),
    });

    // エラー時はステータスをFAILEDに更新
    try {
      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: processorFunctionName,
          Payload: JSON.stringify({
            action: "updateStatus",
            status: "FAILED",
            payload: { documentId },
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        })
      );
    } catch (updateError) {
      logger("ERROR", "[LOCAL] Failed to update status to FAILED", {
        error:
          updateError instanceof Error
            ? updateError.message
            : String(updateError),
      });
    }
  }
}

/**
 * AWS環境用: Step Functionsを開始
 */
async function startStepFunctions(
  bucket: string,
  key: string,
  documentId: string
): Promise<void> {
  const input = {
    bucket,
    key,
    documentId,
  };

  await sfnClient.send(
    new StartExecutionCommand({
      stateMachineArn: process.env.STATE_MACHINE_ARN!,
      name: `ingest-${documentId}-${Date.now()}`,
      input: JSON.stringify(input),
    })
  );
}
