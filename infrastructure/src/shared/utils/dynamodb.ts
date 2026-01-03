// infrastructure/src/shared/utils/dynamodb.ts
// DynamoDB ユーティリティ

import { DynamoDBClient, DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/**
 * DynamoDB Document Client を作成
 */
export function createDynamoDBClient(): DynamoDBDocumentClient {
  const config: DynamoDBClientConfig = {
    region: process.env.AWS_REGION || "us-east-1",
    endpoint: process.env.DYNAMODB_ENDPOINT,
  };

  const client = new DynamoDBClient(config);
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: {
      removeUndefinedValues: true,
      convertEmptyValues: false,
    },
    unmarshallOptions: {
      wrapNumbers: false,
    },
  });
}

/**
 * ページネーショントークンをエンコード
 */
export function encodeCursor(
  lastEvaluatedKey: Record<string, unknown>
): string {
  return Buffer.from(JSON.stringify(lastEvaluatedKey), "utf-8").toString(
    "base64"
  );
}

/**
 * ページネーショントークンをデコード
 */
export function decodeCursor(
  cursor: string
): Record<string, unknown> | undefined {
  try {
    return JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
  } catch {
    return undefined;
  }
}
