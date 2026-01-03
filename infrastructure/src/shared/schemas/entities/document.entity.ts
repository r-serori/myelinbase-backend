import { z } from "zod";

import { OwnerSchema } from "../common/base";
import { DOCUMENT_STATUS } from "../common/constans";

export const DocumentStatusSchema = z.enum(DOCUMENT_STATUS);

export type DocumentStatusEntity = z.infer<typeof DocumentStatusSchema>;

// Document Entity（DB保存用）
export const DocumentEntitySchema = OwnerSchema.extend({
  documentId: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  fileSize: z.number(),
  tags: z.array(z.string()),
  status: DocumentStatusSchema,
  // 内部フィールド
  s3Key: z.string(),
  s3Path: z.string(),
  // タイムスタンプ
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  tagUpdatedAt: z.string().datetime().optional(),
  processingStatus: z.string().optional(),
});

export type DocumentEntity = z.infer<typeof DocumentEntitySchema>;

// Pineconeメタデータ（内部用）
export const DocumentMetadataEntitySchema = z
  .object({
    documentId: z.string(),
    fileName: z.string(),
    ownerId: z.string(),
    chunkIndex: z.number(),
    totalChunks: z.number(),
    text: z.string(),
    createdAt: z.string(),
  })
  .catchall(
    z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
  );

export type DocumentMetadataEntity = z.infer<
  typeof DocumentMetadataEntitySchema
>;
