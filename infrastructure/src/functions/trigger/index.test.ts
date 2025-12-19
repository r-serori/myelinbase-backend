// テスト実行前の環境変数設定
process.env.STATE_MACHINE_ARN =
  "arn:aws:states:us-east-1:123456789012:stateMachine:TestStateMachine";

import { mockClient } from "aws-sdk-client-mock";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { handler } from "./index";
import { S3Event } from "aws-lambda";

// --- Mocks ---
const sfnMock = mockClient(SFNClient);

describe("Trigger Function", () => {
  beforeEach(() => {
    sfnMock.reset();
    jest.clearAllMocks();
  });

  // ヘルパー: S3イベント作成
  const createS3Event = (
    key: string,
    bucket: string = "test-bucket"
  ): S3Event => ({
    Records: [
      {
        s3: {
          bucket: { name: bucket },
          object: { key: key }, // URLエンコードされていない想定（AWS SDK v3 S3Eventの型定義上はstring）
          // 実際にはS3からはURLエンコードされてくることがあるため、テストデータもそれに合わせる
        },
      } as any,
    ],
  });

  it("should start Step Functions execution for valid S3 key", async () => {
    sfnMock
      .on(StartExecutionCommand)
      .resolves({ executionArn: "arn:execution" });

    // キー: uploads/ownerId/documentId/filename.pdf
    const validKey = "uploads/user-123/doc-456/test.pdf";
    const event = createS3Event(validKey);

    await handler(event);

    expect(sfnMock.calls()).toHaveLength(1);
    const callArgs = sfnMock.call(0).args[0].input as any;

    expect(callArgs.stateMachineArn).toBe(process.env.STATE_MACHINE_ARN);

    // 入力パラメータの検証
    const input = JSON.parse(callArgs.input);
    expect(input).toEqual({
      bucket: "test-bucket",
      key: validKey,
      documentId: "doc-456",
    });

    // 実行名の検証 (プレフィックスが含まれているか)
    expect(callArgs.name).toContain("ingest-doc-456-");
  });

  it("should handle URL-encoded keys correctly", async () => {
    sfnMock.on(StartExecutionCommand).resolves({});

    // "test file.pdf" -> "test+file.pdf" (S3イベントの仕様)
    const encodedKey = "uploads/user-123/doc-789/test+file.pdf";
    const event = createS3Event(encodedKey);

    await handler(event);

    expect(sfnMock.calls()).toHaveLength(1);
    const callArgs = sfnMock.call(0).args[0].input as any;
    const input = JSON.parse(callArgs.input);

    // デコードされたキーが渡されていること
    expect(input.key).toBe("uploads/user-123/doc-789/test file.pdf");
    expect(input.documentId).toBe("doc-789");
  });

  it("should ignore keys that do not match the expected pattern", async () => {
    // 誤ったプレフィックスや階層構造
    const invalidKey = "other-prefix/test.pdf";
    const event = createS3Event(invalidKey);

    await handler(event);

    // Step Functionsは呼ばれないはず
    expect(sfnMock.calls()).toHaveLength(0);
  });

  it("should throw error if Step Functions fails", async () => {
    sfnMock.on(StartExecutionCommand).rejects(new Error("SFN Error"));

    const validKey = "uploads/user-123/doc-fail/test.pdf";
    const event = createS3Event(validKey);

    // Promise.all 内のエラーは伝播するため、handler呼び出し自体がrejectされることを期待
    await expect(handler(event)).rejects.toThrow("SFN Error");
  });
});
