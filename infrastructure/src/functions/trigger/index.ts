// src/functions/trigger/index.ts
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { S3Event } from "aws-lambda";

const IS_LOCAL = process.env.STAGE === "local";

const sfnClient = new SFNClient({});
const lambdaClient = IS_LOCAL
  ? new LambdaClient({
      endpoint: process.env.LOCALSTACK_ENDPOINT,
      region: "us-east-1",
    })
  : new LambdaClient({});

export const handler = async (event: S3Event) => {
  await Promise.all(
    event.Records.map(async (record) => {
      const bucket = record.s3.bucket.name;
      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

      // uploads/ownerId/documentId の形式からdocumentIdを抽出
      const match = key.match(/^uploads\/([^/]+)\/([^/]+)$/);
      const documentId = match ? match[2] : null;

      if (!documentId) {
        console.warn("Could not extract documentId from key:", key);
        console.warn("Expected format: uploads/{ownerId}/{documentId}");
        return;
      }

      if (IS_LOCAL) {
        // ローカル環境: 直接Processorを呼び出す（Step Functions不要）
        await invokeProcessorDirectly(bucket, key, documentId);
      } else {
        // 本番環境: Step Functionsを使用
        await startStepFunctions(bucket, key, documentId);
      }
    })
  );
};

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
          documentId,
          status: "PROCESSING",
        }),
      })
    );

    // Step 2: テキスト抽出とチャンク分割
    const extractResponse = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: processorFunctionName,
        Payload: JSON.stringify({
          action: "extractAndChunk",
          documentId,
          bucket,
          key,
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
          documentId,
          chunks: extractResult.chunks,
        }),
      })
    );

    // Step 4: ステータスをCOMPLETEDに更新
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: processorFunctionName,
        Payload: JSON.stringify({
          action: "updateStatus",
          documentId,
          status: "COMPLETED",
        }),
      })
    );
  } catch (error) {
    console.error("[LOCAL] Processing failed:", error);

    // エラー時はステータスをFAILEDに更新
    try {
      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: processorFunctionName,
          Payload: JSON.stringify({
            action: "updateStatus",
            documentId,
            status: "FAILED",
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        })
      );
    } catch (updateError) {
      console.error("[LOCAL] Failed to update status to FAILED:", updateError);
    }
  }
}

/**
 * 本番環境用: Step Functionsを開始
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
