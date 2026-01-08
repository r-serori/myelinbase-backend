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

    // モジュールの再インポート
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

  // SQSイベント作成ヘルパー (S3 Event Notification 形式をBodyに含む)
  const createSQSEventWithS3Body = (bucket: string, key: string): SQSEvent => {
    const s3Event = {
      Records: [
        {
          s3: {
            bucket: { name: bucket },
            object: { key: key },
          },
        },
      ],
    };

    return {
      Records: [
        {
          messageId: "test-message-id",
          receiptHandle: "test-receipt-handle",
          body: JSON.stringify(s3Event),
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
    };
  };

  describe("AWS Environment (STATE_MACHINE_ARN is set)", () => {
    beforeEach(async () => {
      process.env.TABLE_NAME = "test-table";
      process.env.STATE_MACHINE_ARN =
        "arn:aws:states:ap-northeast-1:123:stateMachine:Test";

      handler = (await import("./index")).handler;
    });

    it("should start Sync Step Functions execution for valid key", async () => {
      sfnMock.on(StartSyncExecutionCommand).resolves({
        status: "SUCCEEDED",
        executionArn: "arn:execution",
        output: JSON.stringify({ result: "ok" }),
      });

      // Valid key format: uploads/{ownerId}/{documentId}
      const event = createSQSEventWithS3Body(
        "test-bucket",
        "uploads/user-123/doc-456"
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await handler(event, {} as any, () => {});

      expect(sfnMock.calls()).toHaveLength(1);
      const callArgs = sfnMock.call(0).args[0]
        .input as StartSyncExecutionCommandInput;

      expect(callArgs.stateMachineArn).toBe(process.env.STATE_MACHINE_ARN);

      const input = JSON.parse(callArgs.input || "{}");
      expect(input).toEqual({
        bucket: "test-bucket",
        key: "uploads/user-123/doc-456",
        documentId: "doc-456", // Extracted correctly
      });

      const batchResponse = result as SQSBatchResponse;
      expect(batchResponse.batchItemFailures).toHaveLength(0);
    });

    it("should handle URL encoded keys correctly", async () => {
      sfnMock.on(StartSyncExecutionCommand).resolves({
        status: "SUCCEEDED",
      });

      // "uploads/user 123/doc 456" (Space -> %20)
      const encodedKey = "uploads/user%20123/doc%20456";
      const event = createSQSEventWithS3Body("test-bucket", encodedKey);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await handler(event, {} as any, () => {});

      const callArgs = sfnMock.call(0).args[0]
        .input as StartSyncExecutionCommandInput;
      const input = JSON.parse(callArgs.input || "{}");

      expect(input.documentId).toBe("doc 456"); // Decoded
      expect(input.key).toBe(encodedKey); // Original key passed
    });

    it("should skip processing for invalid key format (no StartExecution)", async () => {
      // Invalid format: not starting with uploads/
      const event = createSQSEventWithS3Body("test-bucket", "images/pic.jpg");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await handler(event, {} as any, () => {});

      expect(sfnMock.calls()).toHaveLength(0); // SFN not started

      // Skipped means success for SQS (no retry)
      const batchResponse = result as SQSBatchResponse;
      expect(batchResponse.batchItemFailures).toHaveLength(0);
    });

    it("should handle Step Functions failure (FAILED status)", async () => {
      sfnMock.on(StartSyncExecutionCommand).resolves({
        status: "FAILED",
        error: "SomeError",
        cause: "Something went wrong",
      });

      docClientMock.on(UpdateCommand).resolves({});

      const event = createSQSEventWithS3Body(
        "test-bucket",
        "uploads/u/doc-fail"
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await handler(event, {} as any, () => {});

      expect(docClientMock.calls()).toHaveLength(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updateArgs = docClientMock.call(0).args[0].input as any;
      expect(updateArgs.Key).toEqual({ documentId: "doc-fail" });
      expect(updateArgs.ExpressionAttributeValues?.[":status"]).toBe("FAILED");
    });

    it("should retry SQS message if SFN throws Exception", async () => {
      sfnMock.on(StartSyncExecutionCommand).rejects(new Error("Net Error"));

      const event = createSQSEventWithS3Body(
        "test-bucket",
        "uploads/u/doc-error"
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await handler(event, {} as any, () => {});

      const batchResponse = result as SQSBatchResponse;
      expect(batchResponse.batchItemFailures).toHaveLength(1);
    });
  });

  describe("Local Environment (STATE_MACHINE_ARN is unset)", () => {
    beforeEach(async () => {
      delete process.env.STATE_MACHINE_ARN;
      process.env.TABLE_NAME = "test-table";

      handler = (await import("./index")).handler;
    });

    it("should invoke Lambda directly in sequence", async () => {
      const extractResult = { chunksS3Uri: "s3://b/c.json" };
      const payloadBuffer = Buffer.from(JSON.stringify(extractResult));

      lambdaMock.on(InvokeCommand).resolves({
        StatusCode: 200,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Payload: payloadBuffer as any,
      });

      const event = createSQSEventWithS3Body(
        "test-bucket",
        "uploads/local/doc-local"
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await handler(event, {} as any, () => {});

      expect(lambdaMock.calls()).toHaveLength(4);

      // Verify extract payload
      const call2Input = lambdaMock.call(1).args[0].input as InvokeCommandInput;
      const call2Payload = JSON.parse(
        Buffer.from(call2Input.Payload as Uint8Array).toString()
      );
      expect(call2Payload.payload).toEqual({
        documentId: "doc-local",
        bucket: "test-bucket",
        key: "uploads/local/doc-local",
      });
    });

    it("should update status to FAILED if local processing fails", async () => {
      lambdaMock
        .on(InvokeCommand)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .resolvesOnce({ StatusCode: 200, Payload: Buffer.from("{}") as any })
        .rejectsOnce(new Error("Local Fail"))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .resolves({ StatusCode: 200, Payload: Buffer.from("{}") as any });

      const event = createSQSEventWithS3Body(
        "test-bucket",
        "uploads/fail/doc-fail"
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await handler(event, {} as any, () => {});

      expect(lambdaMock.calls()).toHaveLength(3);

      const finalCallInput = lambdaMock.call(2).args[0]
        .input as InvokeCommandInput;
      const finalCallPayload = JSON.parse(
        Buffer.from(finalCallInput.Payload as Uint8Array).toString()
      );
      expect(finalCallPayload.status).toBe("FAILED");
      expect(finalCallPayload.payload.documentId).toBe("doc-fail");
    });
  });
});
