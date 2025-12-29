import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import { ErrorCode } from "../../types/error-code";
import { DOCUMENT_STATUS, RESULT_STATUS } from "../common/constans";

extendZodWithOpenApi(z);

// =================================================================
// 定数定義
// =================================================================

export const ALLOWED_EXTENSIONS = [".pdf", ".txt", ".md", ".markdown"];
export const MAX_FILES = 20;
export const MAX_FILE_SIZE = 50 * 1024 * 1024;
export const MAX_TAGS = 20;

export const TEXT_TYPES = ["text/markdown", "text/x-markdown", "text/plain"];

// =================================================================
// API公開用 DTO（Entityから派生）
// =================================================================

export const DocumentStatusSchema = z
  .enum(DOCUMENT_STATUS)
  .openapi("DocumentStatus");

export type DocumentStatusDto = z.infer<typeof DocumentStatusSchema>;

// Document DTO（独立定義、内部フィールドなし）
export const DocumentResponseSchema = z
  .object({
    documentId: z.string(),
    fileName: z.string(),
    contentType: z.string(),
    fileSize: z.number(),
    tags: z.array(z.string()),
    status: DocumentStatusSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    tagUpdatedAt: z.string().datetime().optional(),
    processingStatus: z.string().optional(),
    errorMessage: z.string().optional(),
    downloadUrl: z.string().optional(),
  })
  .openapi("DocumentResponse");

export type DocumentResponseDto = z.infer<typeof DocumentResponseSchema>;

// FileMetadata
export const FileMetadataSchema = z
  .object({
    fileName: z
      .string()
      .min(1, ErrorCode.DOCUMENTS_FILENAME_EMPTY)
      .max(255, ErrorCode.DOCUMENTS_INVALID_FILENAME_LENGTH_LIMIT)
      .refine(
        (name) =>
          ALLOWED_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)),
        { message: ErrorCode.DOCUMENTS_UNSUPPORTED_FILE_TYPE }
      ),
    contentType: z.string(),
    fileSize: z
      .number()
      .min(0)
      .max(MAX_FILE_SIZE, ErrorCode.DOCUMENTS_FILE_TOO_LARGE),
  })
  .openapi("FileMetadata");

export type FileMetadataDto = z.infer<typeof FileMetadataSchema>;
// =================================================================
// リクエスト型定義
// =================================================================

export const UploadRequestRequestSchema = z
  .object({
    files: z
      .array(FileMetadataSchema)
      .min(1, ErrorCode.DOCUMENTS_SELECTION_EMPTY)
      .max(MAX_FILES, ErrorCode.DOCUMENTS_SELECTION_TOO_MANY),
    tags: z
      .array(z.string().max(50, ErrorCode.DOCUMENTS_TAG_LENGTH_LIMIT))
      .max(MAX_TAGS, ErrorCode.DOCUMENTS_TAGS_TOO_MANY)
      .optional()
      .default([]),
  })
  .openapi("UploadRequestRequest");

export type UploadRequestRequestDto = z.infer<
  typeof UploadRequestRequestSchema
>;

export const UpdateTagsRequestSchema = z
  .object({
    tags: z
      .array(z.string().max(50, ErrorCode.DOCUMENTS_TAG_LENGTH_LIMIT))
      .max(MAX_TAGS, ErrorCode.DOCUMENTS_TAGS_TOO_MANY),
  })
  .openapi("UpdateTagsRequest");

export type UpdateTagsRequestDto = z.infer<typeof UpdateTagsRequestSchema>;

export const BatchDeleteRequestSchema = z
  .object({
    documentIds: z
      .array(z.string().max(100))
      .min(1, ErrorCode.DOCUMENTS_SELECTION_EMPTY)
      .max(100, ErrorCode.INVALID_PARAMETER),
  })
  .openapi("BatchDeleteRequest");

export type BatchDeleteRequestDto = z.infer<typeof BatchDeleteRequestSchema>;

// =================================================================
// レスポンス型定義
// =================================================================

export const GetDocumentsResponseSchema = z
  .object({
    documents: z.array(DocumentResponseSchema),
  })
  .openapi("GetDocumentsResponse");

export type GetDocumentsResponseDto = z.infer<
  typeof GetDocumentsResponseSchema
>;

export const GetDocumentResponseSchema = z
  .object({
    document: DocumentResponseSchema,
  })
  .openapi("GetDocumentResponse");

export type GetDocumentResponseDto = z.infer<typeof GetDocumentResponseSchema>;

export const GetDocumentDownloadUrlResponseSchema = z
  .object({
    downloadUrl: z.string(),
  })
  .openapi("GetDocumentDownloadUrlResponse");

export type GetDocumentDownloadUrlResponseDto = z.infer<
  typeof GetDocumentDownloadUrlResponseSchema
>;

export const UploadRequestResultSchema = z
  .object({
    documentId: z.string(),
    fileName: z.string(),
    uploadUrl: z.string(),
    expiresIn: z.number(),
    s3Key: z.string(),
  })
  .openapi("UploadRequestResult");

export type UploadRequestResultDto = z.infer<typeof UploadRequestResultSchema>;

export const UploadRequestFileResultSchema = z
  .object({
    status: z.enum(RESULT_STATUS),
    fileName: z.string(),
    data: UploadRequestResultSchema.optional(),
    errorCode: z.string().optional(),
  })
  .openapi("UploadRequestFileResult");

export type UploadRequestFileResultDto = z.infer<
  typeof UploadRequestFileResultSchema
>;

export const UploadRequestResponseSchema = z
  .object({
    results: z.array(UploadRequestFileResultSchema),
  })
  .openapi("UploadRequestResponse");

export type UploadRequestResponseDto = z.infer<
  typeof UploadRequestResponseSchema
>;

export const DeleteDocumentResponseSchema = z
  .object({
    document: DocumentResponseSchema,
  })
  .openapi("DeleteDocumentResponse");

export type DeleteDocumentResponseDto = z.infer<
  typeof DeleteDocumentResponseSchema
>;

export const ResultStatusSchema = z.enum(RESULT_STATUS).openapi("ResultStatus");

export type ResultStatusDto = z.infer<typeof ResultStatusSchema>;

export const BatchDeleteResultSchema = z
  .object({
    documentId: z.string(),
    status: ResultStatusSchema,
    errorCode: z.string().optional(),
  })
  .openapi("BatchDeleteResult");

export type BatchDeleteResultDto = z.infer<typeof BatchDeleteResultSchema>;

export const BatchDeleteResponseSchema = z
  .object({
    results: z.array(BatchDeleteResultSchema),
  })
  .openapi("BatchDeleteResponse");

export type BatchDeleteResponseDto = z.infer<typeof BatchDeleteResponseSchema>;

export const UpdateTagsResponseSchema = z
  .object({
    document: DocumentResponseSchema,
  })
  .openapi("UpdateTagsResponse");

export type UpdateTagsResponseDto = z.infer<typeof UpdateTagsResponseSchema>;

// =================================================================
// エラーレスポンス定義
// =================================================================

export const UploadRequestErrorResponseSchema = z
  .object({
    errorCode: z.enum([
      ErrorCode.DOCUMENTS_SELECTION_EMPTY,
      ErrorCode.DOCUMENTS_TAG_LENGTH_LIMIT,
      ErrorCode.DOCUMENTS_TAGS_TOO_MANY,
      ErrorCode.DOCUMENTS_FILE_TOO_LARGE,
      ErrorCode.DOCUMENTS_INVALID_FILENAME_LENGTH_LIMIT,
      ErrorCode.DOCUMENTS_UNSUPPORTED_FILE_TYPE,
      ErrorCode.DOCUMENTS_FILENAME_EMPTY,
      ErrorCode.VALIDATION_FAILED,
      ErrorCode.INVALID_PARAMETER,
    ]),
  })
  .openapi("UploadRequestErrorResponse");

export const UpdateTagsErrorResponseSchema = z
  .object({
    errorCode: z.enum([
      ErrorCode.MISSING_PARAMETER,
      ErrorCode.DOCUMENTS_TAG_LENGTH_LIMIT,
      ErrorCode.DOCUMENTS_TAGS_TOO_MANY,
      ErrorCode.RESOURCE_NOT_FOUND,
      ErrorCode.PERMISSION_DENIED,
      ErrorCode.VALIDATION_FAILED,
      ErrorCode.INVALID_PARAMETER,
    ]),
  })
  .openapi("UpdateTagsErrorResponse");

export const BatchDeleteErrorResponseSchema = z
  .object({
    errorCode: z.enum([
      ErrorCode.DOCUMENTS_SELECTION_EMPTY,
      ErrorCode.VALIDATION_FAILED,
      ErrorCode.INVALID_PARAMETER,
    ]),
  })
  .openapi("BatchDeleteErrorResponse");

export const GetDocumentErrorResponseSchema = z
  .object({
    errorCode: z.enum([
      ErrorCode.MISSING_PARAMETER,
      ErrorCode.DOCUMENTS_NOT_FOUND,
      ErrorCode.PERMISSION_DENIED,
    ]),
  })
  .openapi("GetDocumentErrorResponse");

export const GetDocumentDownloadUrlErrorResponseSchema = z
  .object({
    errorCode: z.enum([
      ErrorCode.MISSING_PARAMETER,
      ErrorCode.DOCUMENTS_NOT_FOUND,
      ErrorCode.PERMISSION_DENIED,
      ErrorCode.DOCUMENTS_NOT_READY_FOR_DOWNLOAD,
    ]),
  })
  .openapi("GetDocumentDownloadUrlErrorResponse");

export const DeleteDocumentErrorResponseSchema = z
  .object({
    errorCode: z.enum([
      ErrorCode.MISSING_PARAMETER,
      ErrorCode.RESOURCE_NOT_FOUND,
      ErrorCode.PERMISSION_DENIED,
    ]),
  })
  .openapi("DeleteDocumentErrorResponse");
