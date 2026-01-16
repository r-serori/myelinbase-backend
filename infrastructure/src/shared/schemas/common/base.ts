import { z } from "zod";

// DynamoDB共通キー
export const DynamoDBKeysSchema = z.object({
  pk: z.string(),
  sk: z.string(),
});

export const GSI1KeysSchema = z.object({
  gsi1pk: z.string(),
  gsi1sk: z.string(),
});

// オーナー情報
export const OwnerSchema = z.object({
  ownerId: z.string(),
});

// タイムスタンプ
export const TimestampsSchema = z.object({
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
});
