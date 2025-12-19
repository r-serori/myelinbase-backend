import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { ErrorCode } from "../types/error-code";

extendZodWithOpenApi(z);

// =================================================================
// 定数定義
// =================================================================

export const ALLOWED_EXTENSIONS = [".pdf", ".txt", ".md", ".markdown", ".csv"];

// =================================================================
// 基本型定義
// =================================================================

export const DocumentStatusSchema = z
  .enum([
    "PENDING_UPLOAD",
    "PROCESSING",
    "COMPLETED",
    "FAILED",
    "DELETING",
    "DELETED",
    "DELETE_FAILED",
  ])
  .openapi("DocumentStatus");

export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

export const DocumentSchema = z
  .object({
    documentId: z.string(),
    fileName: z.string(),
    contentType: z.string(),
    fileSize: z.number(),
    tags: z.array(z.string()),
    status: DocumentStatusSchema,
    ownerId: z.string(),
    s3Key: z.string(),
    s3Path: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    tagUpdatedAt: z.string().datetime().optional(),
    uploadUrlExpiresAt: z.string().optional(),
    processingStatus: z.string().optional(),
    errorMessage: z.string().optional(),
    deleteRequested: z.boolean().optional(),
    downloadUrl: z.string().optional(),
  })
  .openapi("Document");

export type Document = z.infer<typeof DocumentSchema>;

export const DocumentResponseSchema = DocumentSchema.omit({
  ownerId: true,
}).openapi("DocumentResponse");

export type DocumentResponse = z.infer<typeof DocumentResponseSchema>;

export const FileMetadataSchema = z
  .object({
    fileName: z
      .string()
      .min(1)
      .max(255, ErrorCode.DOCUMENTS_INVALID_FILENAME_LENGTH_LIMIT)
      .refine(
        (name) =>
          ALLOWED_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)),
        {
          message: ErrorCode.DOCUMENTS_UNSUPPORTED_FILE_TYPE,
        }
      ),
    contentType: z.string(),
    fileSize: z
      .number()
      .min(0)
      .max(50 * 1024 * 1024, ErrorCode.DOCUMENTS_FILE_TOO_LARGE),
  })
  .openapi("FileMetadata");

export type FileMetadata = z.infer<typeof FileMetadataSchema>;

// =================================================================
// リクエスト型定義
// =================================================================

/**
 * アップロードリクエスト POST /documents/upload-request
 */
export const UploadRequestRequestSchema = z
  .object({
    files: z.array(FileMetadataSchema).min(1),
    tags: z
      .array(z.string().max(50, ErrorCode.DOCUMENTS_TAG_LENGTH_LIMIT))
      .max(20, ErrorCode.DOCUMENTS_TAGS_TOO_MANY)
      .optional()
      .default([]),
  })
  .openapi("UploadRequestRequest");

export type UploadRequestRequest = z.infer<typeof UploadRequestRequestSchema>;

/**
 * タグ更新リクエスト PATCH /documents/{id}/tags
 */
export const UpdateTagsRequestSchema = z
  .object({
    tags: z
      .array(z.string().max(50, ErrorCode.DOCUMENTS_TAG_LENGTH_LIMIT))
      .max(20, ErrorCode.DOCUMENTS_TAGS_TOO_MANY),
  })
  .openapi("UpdateTagsRequest");

export type UpdateTagsRequest = z.infer<typeof UpdateTagsRequestSchema>;

/**
 * 一括削除リクエスト POST /documents/batch-delete
 */
export const BatchDeleteRequestSchema = z
  .object({
    documentIds: z
      .array(z.string().max(100))
      .min(1)
      .max(100, ErrorCode.INVALID_PARAMETER), // 仮のエラーコード
  })
  .openapi("BatchDeleteRequest");

export type BatchDeleteRequest = z.infer<typeof BatchDeleteRequestSchema>;

// =================================================================
// レスポンス型定義
// =================================================================

/**
 * ドキュメント一覧取得レスポンス GET /documents
 */
export const GetDocumentsResponseSchema = z
  .object({
    documents: z.array(DocumentResponseSchema),
  })
  .openapi("GetDocumentsResponse");

export type GetDocumentsResponse = z.infer<typeof GetDocumentsResponseSchema>;

/**
 * ドキュメント詳細取得レスポンス GET /documents/{id}
 */
export const GetDocumentResponseSchema = z
  .object({
    document: DocumentResponseSchema,
  })
  .openapi("GetDocumentResponse");

export type GetDocumentResponse = z.infer<typeof GetDocumentResponseSchema>;

export const UploadRequestResultSchema = z
  .object({
    documentId: z.string(),
    fileName: z.string(),
    uploadUrl: z.string(),
    expiresIn: z.number(),
    s3Key: z.string(),
  })
  .openapi("UploadRequestResult");

export type UploadRequestResult = z.infer<typeof UploadRequestResultSchema>;

export const UploadRequestFileResultSchema = z
  .object({
    status: z.enum(["success", "error"]),
    fileName: z.string(),
    data: UploadRequestResultSchema.optional(),
    errorCode: z.string().optional(),
  })
  .openapi("UploadRequestFileResult");

export type UploadRequestFileResult = z.infer<
  typeof UploadRequestFileResultSchema
>;

/**
 * アップロードリクエストレスポンス POST /documents/upload-request
 */
export const UploadRequestResponseSchema = z
  .object({
    results: z.array(UploadRequestFileResultSchema),
  })
  .openapi("UploadRequestResponse");

export type UploadRequestResponse = z.infer<typeof UploadRequestResponseSchema>;

/**
 * ドキュメント削除レスポンス DELETE /documents/{id}
 */
export const DeleteDocumentResponseSchema = z
  .object({
    document: DocumentResponseSchema,
  })
  .openapi("DeleteDocumentResponse");

export type DeleteDocumentResponse = z.infer<
  typeof DeleteDocumentResponseSchema
>;

/**
 * 一括削除結果
 */
export const BatchDeleteResultSchema = z.object({
  documentId: z.string(),
  status: z.enum(["success", "error"]),
  errorCode: z.string().optional(),
});

export type BatchDeleteResult = z.infer<typeof BatchDeleteResultSchema>;

/**
 * 一括削除レスポンス POST /documents/batch-delete
 */
export const BatchDeleteResponseSchema = z
  .object({
    results: z.array(BatchDeleteResultSchema),
  })
  .openapi("BatchDeleteResponse");

export type BatchDeleteResponse = z.infer<typeof BatchDeleteResponseSchema>;

/**
 * タグ更新レスポンス PATCH /documents/{id}/tags
 */
export const UpdateTagsResponseSchema = z
  .object({
    document: DocumentResponseSchema,
  })
  .openapi("UpdateTagsResponse");

export type UpdateTagsResponse = z.infer<typeof UpdateTagsResponseSchema>;

// =================================================================
// メタデータ型定義
// =================================================================

/**
 * ドキュメントメタデータ型（Pineconeに保存される）
 */
export const DocumentMetadataSchema = z
  .object({
    documentId: z.string(),
    fileName: z.string(),
    ownerId: z.string(),
    chunkIndex: z.number(),
    totalChunks: z.number(),
    text: z.string(),
    createdAt: z.string(),
  })
  .catchall(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
  .openapi("DocumentMetadata");

export type DocumentMetadata = z.infer<typeof DocumentMetadataSchema>;
