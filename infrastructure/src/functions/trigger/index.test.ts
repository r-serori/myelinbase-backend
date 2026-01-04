import {
  InvokeCommand as _InvokeCommand,
  InvokeCommandInput,
  LambdaClient as _LambdaClient,
} from "@aws-sdk/client-lambda";
import {
  SFNClient as _SFNClient,
  StartExecutionCommand as _StartExecutionCommand,
  StartExecutionCommandInput,
} from "@aws-sdk/client-sfn";
import { S3Event, S3EventRecord } from "aws-lambda";
import { AwsClientStub, mockClient } from "aws-sdk-client-mock";

// 型定義のためのインポート（実行時のインポートは動的importで行う）
import type { handler as HandlerType } from "./index";

describe("Trigger Function", () => {
  const ORIGINAL_ENV = process.env;
  let handler: typeof HandlerType;
  let sfnMock: AwsClientStub<_SFNClient>;
  let lambdaMock: AwsClientStub<_LambdaClient>;

  // 動的インポートしたクラスを保持する変数
  // jest.resetModules()を使用するため、テストごとに新しいクラスインスタンスを取得する必要がある
  let StartExecutionCommand: typeof _StartExecutionCommand;
  let InvokeCommand: typeof _InvokeCommand;

  beforeEach(async () => {
    jest.resetModules(); // モジュールキャッシュをクリア（環境変数の反映のため）
    process.env = { ...ORIGINAL_ENV }; // 環境変数をリセット
    process.env.AWS_REGION = "ap-northeast-1"; // Region missingエラーを回避

    // resetModules後はSDKのクラスも新しくなるため、テスト内で再importしてクラスを取得する
    // これにより、ハンドラーが読み込むSDKクラスとモック設定に使うクラスが一致する
    const sfnModule = await import("@aws-sdk/client-sfn");
    const lambdaModule = await import("@aws-sdk/client-lambda");

    const SFNClient = sfnModule.SFNClient;
    const LambdaClient = lambdaModule.LambdaClient;
    StartExecutionCommand = sfnModule.StartExecutionCommand;
    InvokeCommand = lambdaModule.InvokeCommand;

    // 型不整合エラーを回避するためにキャストを使用
    sfnMock = mockClient(SFNClient) as unknown as AwsClientStub<_SFNClient>;
    lambdaMock = mockClient(
      LambdaClient
    ) as unknown as AwsClientStub<_LambdaClient>;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  // S3イベント作成ヘルパー
  const createS3Event = (
    key: string,
    bucket: string = "test-bucket"
  ): S3Event => ({
    Records: [
      {
        eventVersion: "2.1",
        eventSource: "aws:s3",
        awsRegion: "ap-northeast-1",
        eventTime: new Date().toISOString(),
        eventName: "ObjectCreated:Put",
        userIdentity: { principalId: "test" },
        requestParameters: { sourceIPAddress: "127.0.0.1" },
        responseElements: {
          "x-amz-request-id": "test",
          "x-amz-id-2": "test",
        },
        s3: {
          s3SchemaVersion: "1.0",
          configurationId: "test",
          bucket: {
            name: bucket,
            ownerIdentity: { principalId: "test" },
            arn: `arn:aws:s3:::${bucket}`,
          },
          object: {
            key: key,
            size: 1024,
            eTag: "test-etag",
            sequencer: "test-sequencer",
          },
        },
      } as S3EventRecord,
    ],
  });

  describe("Production Environment (STAGE != local)", () => {
    beforeEach(async () => {
      process.env.STAGE = "production";
      process.env.STATE_MACHINE_ARN =
        "arn:aws:states:ap-northeast-1:123:stateMachine:Test";

      // 環境変数を設定した後にモジュールを読み込む
      handler = (await import("./index")).handler;
    });

    it("should start Step Functions execution for valid S3 key", async () => {
      sfnMock
        .on(StartExecutionCommand)
        .resolves({ executionArn: "arn:execution" });

      // 実装の正規表現 ^uploads\/([^/]+)\/([^/]+)$ にマッチするキー
      // uploads/{ownerId}/{documentId}
      const validKey = "uploads/user-123/doc-456";
      const event = createS3Event(validKey);

      await handler(event);

      expect(sfnMock.calls()).toHaveLength(1);
      const callArgs = sfnMock.call(0).args[0]
        .input as StartExecutionCommandInput;

      expect(callArgs.stateMachineArn).toBe(process.env.STATE_MACHINE_ARN);

      const input = JSON.parse(callArgs.input || "{}");
      expect(input).toEqual({
        bucket: "test-bucket",
        key: validKey,
        documentId: "doc-456",
      });

      expect(callArgs.name).toContain("ingest-doc-456-");
    });

    it("should handle URL-encoded keys correctly", async () => {
      sfnMock.on(StartExecutionCommand).resolves({});

      // "uploads/user-123/doc 789" -> エンコード
      const encodedKey = "uploads/user-123/doc%20789";
      const event = createS3Event(encodedKey);

      await handler(event);

      expect(sfnMock.calls()).toHaveLength(1);
      const callArgs = sfnMock.call(0).args[0]
        .input as StartExecutionCommandInput;
      const input = JSON.parse(callArgs.input || "{}");

      expect(input.key).toBe("uploads/user-123/doc 789");
      expect(input.documentId).toBe("doc 789");
    });

    it("should ignore keys that do not match the expected pattern", async () => {
      // 階層が深い場合（例: ファイル名がついている）は実装の正規表現にマッチしないため無視される
      const invalidKey = "uploads/user-123/doc-456/file.pdf";
      const event = createS3Event(invalidKey);

      await handler(event);

      expect(sfnMock.calls()).toHaveLength(0);
    });

    it("should throw error if Step Functions fails", async () => {
      sfnMock.on(StartExecutionCommand).rejects(new Error("SFN Error"));

      const validKey = "uploads/user-123/doc-fail";
      const event = createS3Event(validKey);

      await expect(handler(event)).rejects.toThrow("SFN Error");
    });
  });

  describe("Local Environment (STAGE = local)", () => {
    beforeEach(async () => {
      process.env.STAGE = "local";
      process.env.PROCESSOR_FUNCTION_NAME = "local-processor";
      process.env.LOCALSTACK_ENDPOINT = "http://localhost:4566";

      handler = (await import("./index")).handler;
    });

    it("should invoke Lambda directly in sequence", async () => {
      // Lambda Invokeのモックレスポンス設定
      // Step 2のExtract結果のみ Payload を返す必要がある
      const extractResult = {
        chunks: ["chunk1", "chunk2"],
      };

      const payloadBytes = new TextEncoder().encode(
        JSON.stringify(extractResult)
      );
      // Uint8ArrayBlobAdapter互換のオブジェクトを作成
      const payload = Object.assign(payloadBytes, {
        transformToString: async () =>
          Promise.resolve(new TextDecoder().decode(payloadBytes)),
      });

      lambdaMock.on(InvokeCommand).resolves({
        Payload: payload as unknown as typeof payload & {
          transformToString: () => string;
        },
        StatusCode: 200,
      });

      const validKey = "uploads/user-local/doc-local";
      const event = createS3Event(validKey);

      await handler(event);

      // 4回呼ばれることを期待 (Status Update -> Extract -> Embed -> Status Update)
      expect(lambdaMock.calls()).toHaveLength(4);

      // Step 1: Update status to PROCESSING
      const call1Input = lambdaMock.call(0).args[0].input as InvokeCommandInput;
      const call1 = JSON.parse((call1Input.Payload as string) || "{}");
      expect(call1).toEqual({
        action: "updateStatus",
        documentId: "doc-local",
        status: "PROCESSING",
      });

      // Step 2: Extract and Chunk
      const call2Input = lambdaMock.call(1).args[0].input as InvokeCommandInput;
      const call2 = JSON.parse((call2Input.Payload as string) || "{}");
      expect(call2).toEqual({
        action: "extractAndChunk",
        documentId: "doc-local",
        bucket: "test-bucket",
        key: validKey,
      });

      // Step 3: Embed and Upsert (前のステップの結果を使う)
      const call3Input = lambdaMock.call(2).args[0].input as InvokeCommandInput;
      const call3 = JSON.parse((call3Input.Payload as string) || "{}");
      expect(call3).toEqual({
        action: "embedAndUpsert",
        documentId: "doc-local",
        chunks: ["chunk1", "chunk2"],
      });

      // Step 4: Update status to COMPLETED
      const call4Input = lambdaMock.call(3).args[0].input as InvokeCommandInput;
      const call4 = JSON.parse((call4Input.Payload as string) || "{}");
      expect(call4).toEqual({
        action: "updateStatus",
        documentId: "doc-local",
        status: "COMPLETED",
      });
    });

    it("should update status to FAILED if processing throws error", async () => {
      // 2回目のExtract呼び出しでエラーを発生させる
      lambdaMock
        .on(InvokeCommand)
        .resolvesOnce({ StatusCode: 200 }) // Step 1 OK
        .rejects(new Error("Extraction Failed")); // Step 2 Error

      const validKey = "uploads/user-local/doc-error";
      const event = createS3Event(validKey);

      await handler(event);

      // 呼び出し回数は3回 (Start -> Extract(Fail) -> Fail Update)
      expect(lambdaMock.calls()).toHaveLength(3);

      // 最後がFAILED更新であることを確認
      const finalCallInput = lambdaMock.call(2).args[0]
        .input as InvokeCommandInput;
      const finalCall = JSON.parse((finalCallInput.Payload as string) || "{}");
      expect(finalCall).toMatchObject({
        action: "updateStatus",
        documentId: "doc-error",
        status: "FAILED",
        error: {
          message: "Extraction Failed",
        },
      });
    });
  });
});
