import {
  InvokeCommand as _InvokeCommand,
  InvokeCommandInput,
  LambdaClient as _LambdaClient,
} from "@aws-sdk/client-lambda";
import {
  SFNClient as _SFNClient,
  StartSyncExecutionCommand as _StartSyncExecutionCommand,
  StartSyncExecutionCommandInput,
} from "@aws-sdk/client-sfn";
import {
  DynamoDBDocumentClient as _DynamoDBDocumentClient,
  UpdateCommand as _UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { AwsClientStub, mockClient } from "aws-sdk-client-mock";

// 型定義のためのインポート
import type { handler as HandlerType } from "./index";

describe("Trigger Function", () => {
  const ORIGINAL_ENV = process.env;
  let handler: typeof HandlerType;
  let sfnMock: AwsClientStub<_SFNClient>;
  let lambdaMock: AwsClientStub<_LambdaClient>;
  let docClientMock: AwsClientStub<_DynamoDBDocumentClient>;

  // 動的インポートしたクラスを保持する変数
  let StartSyncExecutionCommand: typeof _StartSyncExecutionCommand;
  let InvokeCommand: typeof _InvokeCommand;
  let UpdateCommand: typeof _UpdateCommand;

  beforeEach(async () => {
    jest.resetModules(); // モジュールキャッシュをクリア
    process.env = { ...ORIGINAL_ENV };
    process.env.AWS_REGION = "ap-northeast-1";

    // モジュールの再インポート (環境変数反映のため)
    const sfnModule = await import("@aws-sdk/client-sfn");
    const lambdaModule = await import("@aws-sdk/client-lambda");
    const ddbModule = await import("@aws-sdk/lib-dynamodb");
    const ddbClientModule = await import("@aws-sdk/client-dynamodb");

    const SFNClient = sfnModule.SFNClient;
    const LambdaClient = lambdaModule.LambdaClient;
    const DynamoDBDocumentClient = ddbModule.DynamoDBDocumentClient;
    const DynamoDBClient = ddbClientModule.DynamoDBClient;

    StartSyncExecutionCommand = sfnModule.StartSyncExecutionCommand;
    InvokeCommand = lambdaModule.InvokeCommand;
    UpdateCommand = ddbModule.UpdateCommand;

    // モックの作成
    sfnMock = mockClient(SFNClient) as unknown as AwsClientStub<_SFNClient>;
    lambdaMock = mockClient(
      LambdaClient
    ) as unknown as AwsClientStub<_LambdaClient>;
    docClientMock = mockClient(
      DynamoDBDocumentClient
    ) as unknown as AwsClientStub<_DynamoDBDocumentClient>;

    // createDynamoDBClient のモック
    // 実装ファイル内で import されているため、jest.doMock で差し替える
    // require() を回避するため、事前に import したクラスを使用する
    jest.doMock("../../shared/utils/dynamodb", () => {
      return {
        createDynamoDBClient: () =>
          DynamoDBDocumentClient.from(new DynamoDBClient({})),
      };
    });
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  // SQSイベント作成ヘルパー (Payloadは IngestMessage 形式)
  const createSQSEvent = (
    bucket: string,
    key: string,
    documentId: string
  ): SQSEvent => ({
    Records: [
      {
        messageId: "test-message-id",
        receiptHandle: "test-receipt-handle",
        body: JSON.stringify({ bucket, key, documentId }),
        attributes: {
          ApproximateReceiveCount: "1",
          SentTimestamp: "1234567890",
          SenderId: "test-sender",
          ApproximateFirstReceiveTimestamp: "1234567890",
        },
        messageAttributes: {},
        md5OfBody: "test-md5",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:ap-northeast-1:123456789012:test-queue",
        awsRegion: "ap-northeast-1",
      },
    ],
  });

  describe("AWS Environment (STATE_MACHINE_ARN is set)", () => {
    beforeEach(async () => {
      process.env.TABLE_NAME = "test-table";
      process.env.STATE_MACHINE_ARN =
        "arn:aws:states:ap-northeast-1:123:stateMachine:Test";

      // 環境変数を設定した後にモジュールを読み込む
      handler = (await import("./index")).handler;
    });

    it("should start Sync Step Functions execution successfully", async () => {
      sfnMock.on(StartSyncExecutionCommand).resolves({
        status: "SUCCEEDED",
        executionArn: "arn:execution",
        output: JSON.stringify({ result: "ok" }),
      });

      const event = createSQSEvent("test-bucket", "uploads/doc-123", "doc-123");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await handler(event, {} as any, () => {});

      expect(sfnMock.calls()).toHaveLength(1);
      const callArgs = sfnMock.call(0).args[0]
        .input as StartSyncExecutionCommandInput;

      expect(callArgs.stateMachineArn).toBe(process.env.STATE_MACHINE_ARN);
      expect(callArgs.name).toContain("ingest-doc-123-");

      const input = JSON.parse(callArgs.input || "{}");
      expect(input).toEqual({
        bucket: "test-bucket",
        key: "uploads/doc-123",
        documentId: "doc-123",
      });

      // 成功時はバッチ失敗リストは空
      const batchResponse = result as SQSBatchResponse;
      expect(batchResponse.batchItemFailures).toHaveLength(0);
    });

    it("should handle Step Functions execution failure (update status to FAILED)", async () => {
      // Step Functionsが失敗ステータスを返した場合
      sfnMock.on(StartSyncExecutionCommand).resolves({
        status: "FAILED",
        error: "SomeError",
        cause: "Something went wrong",
      });

      docClientMock.on(UpdateCommand).resolves({});

      const event = createSQSEvent(
        "test-bucket",
        "uploads/doc-fail",
        "doc-fail"
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await handler(event, {} as any, () => {});

      // SFN呼び出し確認
      expect(sfnMock.calls()).toHaveLength(1);

      // DynamoDB更新確認
      expect(docClientMock.calls()).toHaveLength(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updateArgs = docClientMock.call(0).args[0].input as any;
      expect(updateArgs.TableName).toBe("test-table");
      expect(updateArgs.Key).toEqual({ documentId: "doc-fail" });
      expect(updateArgs.ExpressionAttributeValues?.[":status"]).toBe("FAILED");
      expect(updateArgs.ExpressionAttributeValues?.[":error"]).toContain(
        "State Machine failed"
      );

      // ステータス更新に成功した(shouldRetry: false)ので、SQSリトライは不要
      const batchResponse = result as SQSBatchResponse;
      expect(batchResponse.batchItemFailures).toHaveLength(0);
    });

    it("should retry SQS message if Step Functions Start fails (Exception)", async () => {
      // API呼び出し自体が例外を投げた場合
      sfnMock.on(StartSyncExecutionCommand).rejects(new Error("Network Error"));

      const event = createSQSEvent(
        "test-bucket",
        "uploads/doc-error",
        "doc-error"
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await handler(event, {} as any, () => {});

      // Exception時は shouldRetry: true になるはず
      const batchResponse = result as SQSBatchResponse;
      expect(batchResponse.batchItemFailures).toHaveLength(1);
      expect(batchResponse.batchItemFailures[0].itemIdentifier).toBe(
        "test-message-id"
      );
    });
  });

  describe("Local Environment (STATE_MACHINE_ARN is unset)", () => {
    beforeEach(async () => {
      delete process.env.STATE_MACHINE_ARN;
      process.env.TABLE_NAME = "test-table";

      handler = (await import("./index")).handler;
    });

    it("should invoke Lambda directly in sequence", async () => {
      // Lambda Invokeのモックレスポンス設定
      const extractResult = {
        chunksS3Uri: "s3://test-bucket/chunks.json",
      };
      const payloadBuffer = Buffer.from(JSON.stringify(extractResult));

      lambdaMock.on(InvokeCommand).resolves({
        StatusCode: 200,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Payload: payloadBuffer as any,
      });

      const event = createSQSEvent("test-bucket", "uploads/local", "doc-local");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await handler(event, {} as any, () => {});

      // 4回呼ばれることを期待 (Update -> Extract -> Embed -> Update)
      expect(lambdaMock.calls()).toHaveLength(4);

      // Call 1: Update Status
      const call1Input = lambdaMock.call(0).args[0].input as InvokeCommandInput;
      const call1Payload = JSON.parse(
        Buffer.from(call1Input.Payload as Uint8Array).toString()
      );
      expect(call1Payload.action).toBe("updateStatus");
      expect(call1Payload.status).toBe("PROCESSING");

      // Call 2: Extract
      const call2Input = lambdaMock.call(1).args[0].input as InvokeCommandInput;
      const call2Payload = JSON.parse(
        Buffer.from(call2Input.Payload as Uint8Array).toString()
      );
      expect(call2Payload.action).toBe("extractAndChunk");

      // Call 3: Embed (Previous result used)
      const call3Input = lambdaMock.call(2).args[0].input as InvokeCommandInput;
      const call3Payload = JSON.parse(
        Buffer.from(call3Input.Payload as Uint8Array).toString()
      );
      expect(call3Payload.action).toBe("embedAndUpsert");
      expect(call3Payload.payload.chunksS3Uri).toBe(extractResult.chunksS3Uri);

      // Call 4: Complete
      const call4Input = lambdaMock.call(3).args[0].input as InvokeCommandInput;
      const call4Payload = JSON.parse(
        Buffer.from(call4Input.Payload as Uint8Array).toString()
      );
      expect(call4Payload.status).toBe("COMPLETED");
    });

    it("should update status to FAILED if local processing fails", async () => {
      // 2回目(Extract)で失敗させる
      lambdaMock
        .on(InvokeCommand)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .resolvesOnce({ StatusCode: 200, Payload: Buffer.from("{}") as any }) // 1回目 OK
        .rejectsOnce(new Error("Local Fail")) // 2回目 Error
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .resolves({ StatusCode: 200, Payload: Buffer.from("{}") as any }); // 3回目 (Backup/Fallback)

      const event = createSQSEvent("test-bucket", "uploads/fail", "doc-fail");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await handler(event, {} as any, () => {});

      // 呼び出し回数は3回 (Start -> Extract(Fail) -> Fail Update)
      expect(lambdaMock.calls()).toHaveLength(3);

      // 最後の呼び出しがFAILED更新であることを確認
      const finalCallInput = lambdaMock.call(2).args[0]
        .input as InvokeCommandInput;
      const finalCallPayload = JSON.parse(
        Buffer.from(finalCallInput.Payload as Uint8Array).toString()
      );
      expect(finalCallPayload.action).toBe("updateStatus");
      expect(finalCallPayload.status).toBe("FAILED");
      expect(finalCallPayload.error.message).toBe("Local Fail");

      // エラーハンドリング成功ならSQSリトライはしない
      const batchResponse = result as SQSBatchResponse;
      expect(batchResponse.batchItemFailures).toHaveLength(0);
    });
  });
});
