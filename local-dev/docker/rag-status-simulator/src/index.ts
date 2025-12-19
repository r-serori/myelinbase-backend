/**
 * RAG Status Simulator
 *
 * ローカル開発用: Step Functionsの代役。
 * DocumentTableをポーリングし、status="PROCESSING" のものを見つけたら
 * 数秒後に "COMPLETED" に更新します。
 * これにより、フロントエンドの「処理中...」→「完了」のUI確認が可能です。
 */

import {
  DynamoDBClient,
  ScanCommand,
  DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const CONFIG = {
  dynamodbEndpoint: process.env.DYNAMODB_ENDPOINT || "http://localhost:8000",
  tableName: process.env.TABLE_NAME || "DocumentTable",
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "3000", 10),
  region: process.env.AWS_REGION || "us-east-1",
};

const dynamoDBClient = new DynamoDBClient({
  endpoint: CONFIG.dynamodbEndpoint,
  region: CONFIG.region,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});

const docClient = DynamoDBDocumentClient.from(dynamoDBClient);

async function main() {
  console.log("🚀 RAG Status Simulator Started");
  console.log(`Target Table: ${CONFIG.tableName}`);

  await waitForTable();

  while (true) {
    try {
      await processPendingDocs();
    } catch (error: any) {
      console.error("Error:", error.message);
    }
    await sleep(CONFIG.pollIntervalMs);
  }
}

async function waitForTable() {
  process.stdout.write("Waiting for DynamoDB...");
  while (true) {
    try {
      const { Table } = await dynamoDBClient.send(
        new DescribeTableCommand({ TableName: CONFIG.tableName })
      );
      if (Table?.TableStatus === "ACTIVE") {
        console.log(" Ready!");
        return;
      }
    } catch (e) {
      process.stdout.write(".");
    }
    await sleep(2000);
  }
}

async function processPendingDocs() {
  // PROCESSING ステータスのドキュメントを検索
  // (実運用ではScanは避けるべきだが、ローカルシミュレータなのでOK)
  const result = await docClient.send(
    new ScanCommand({
      TableName: CONFIG.tableName,
      FilterExpression: "#status = :processing",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":processing": { S: "PROCESSING" } },
    })
  );

  if (!result.Items || result.Items.length === 0) return;

  for (const item of result.Items) {
    const documentId = item.documentId.S;
    console.log(`Found PROCESSING doc: ${documentId} -> Simulating RAG...`);

    // 疑似的な処理時間
    await sleep(2000);

    // COMPLETEDに更新 (ついでに processingStatus を削除)
    await docClient.send(
      new UpdateCommand({
        TableName: CONFIG.tableName,
        Key: { documentId },
        UpdateExpression:
          "SET #status = :completed, updatedAt = :now REMOVE processingStatus",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":completed": "COMPLETED",
          ":now": new Date().toISOString(),
        },
      })
    );

    console.log(`✅ Doc ${documentId} is now COMPLETED`);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();
