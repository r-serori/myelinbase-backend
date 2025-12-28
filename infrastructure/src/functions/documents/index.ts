import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";

import {
  BatchDeleteRequestDto,
  BatchDeleteRequestSchema,
  BatchDeleteResponseDto,
  BatchDeleteResultDto,
  DeleteDocumentResponseDto,
  DocumentResponseDto,
  FileMetadataDto,
  GetDocumentResponseDto,
  GetDocumentsResponseDto,
  ResultStatusSchema,
  UpdateTagsRequestDto,
  UpdateTagsRequestSchema,
  UpdateTagsResponseDto,
  UploadRequestFileResultDto,
  UploadRequestRequestDto,
  UploadRequestRequestSchema,
  UploadRequestResponseDto,
  UploadRequestResultDto,
} from "../../shared/schemas/dto/document.dto";
import {
  DocumentEntity,
  DocumentStatusSchema,
} from "../../shared/schemas/entities/document.entity";
import { ErrorCode } from "../../shared/types/error-code";
import {
  apiHandler,
  AppError,
  logger,
  validateJson,
} from "../../shared/utils/api-handler";
import { toDocumentDTO } from "../../shared/utils/dto-mapper";
import { createDynamoDBClient } from "../../shared/utils/dynamodb";
import {
  buildS3Uri,
  createS3Client,
  generateDownloadUrl,
  generateUploadUrl,
} from "../../shared/utils/s3";

const TABLE_NAME = process.env.TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;
const PRESIGNED_URL_EXPIRY = parseInt(
  process.env.PRESIGNED_URL_EXPIRY || "900",
  10
);
const IS_LOCAL_STAGE = process.env.STAGE! === "local";
const DOCUMENT_TTL_SECONDS = 24 * 60 * 60;

const docClient = createDynamoDBClient();
const s3Client = createS3Client();

export const handler = apiHandler(async (event) => {
  const { httpMethod, path, pathParameters } = event;
  const ownerId = extractOwnerId(event);

  if (httpMethod === "GET" && path === "/documents") {
    const response = await getDocuments(ownerId);
    return response;
  }

  if (
    httpMethod === "GET" &&
    path.startsWith("/documents/") &&
    path.endsWith("/download-url")
  ) {
    const documentId = pathParameters?.id;
    if (!documentId) throw new AppError(400, ErrorCode.MISSING_PARAMETER);

    const response = await getDownloadUrl(documentId, ownerId);
    return response;
  }

  if (httpMethod === "GET" && path.startsWith("/documents/")) {
    const documentId = pathParameters?.id;
    if (!documentId) throw new AppError(400, ErrorCode.MISSING_PARAMETER);

    const response = await getDocumentById(documentId, ownerId);
    return response;
  }

  if (httpMethod === "POST" && path === "/documents/upload") {
    const body = validateJson(event.body, UploadRequestRequestSchema);
    const response = await uploadRequest(body, ownerId);
    return { statusCode: 202, body: response };
  }

  if (httpMethod === "DELETE" && path.startsWith("/documents/")) {
    const documentId = pathParameters?.id;
    if (!documentId) throw new AppError(400, ErrorCode.MISSING_PARAMETER);

    const response = await deleteDocument(documentId, ownerId);
    return { statusCode: 202, body: response };
  }

  if (httpMethod === "POST" && path === "/documents/batch-delete") {
    const body = validateJson(event.body, BatchDeleteRequestSchema);
    const response = await batchDeleteDocuments(body, ownerId);
    return { statusCode: 200, body: response };
  }

  if (httpMethod === "PATCH" && path.endsWith("/tags")) {
    const documentId = pathParameters?.id;
    if (!documentId) throw new AppError(400, ErrorCode.MISSING_PARAMETER);

    const body = validateJson(event.body, UpdateTagsRequestSchema);
    const response = await updateTags(documentId, body, ownerId);
    return response;
  }

  throw new AppError(404);
});

function extractOwnerId(event: any): string {
  if (IS_LOCAL_STAGE) {
    return "user-001";
  }

  const claims = event.requestContext?.authorizer?.claims;
  const ownerId = claims?.sub;

  if (!ownerId) throw new AppError(401, ErrorCode.PERMISSION_DENIED);

  return ownerId;
}

// =================================================================
// ビジネスロジック関数
// =================================================================

/**
 * ドキュメント一覧取得 GET /documents
 */
async function getDocuments(ownerId: string): Promise<GetDocumentsResponseDto> {
  const command = new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: "OwnerIndex",
    FilterExpression: "#status <> :deleted",
    KeyConditionExpression: "#owner = :ownerId",
    ExpressionAttributeNames: { "#owner": "ownerId", "#status": "status" },
    ExpressionAttributeValues: {
      ":ownerId": ownerId,
      ":deleted": DocumentStatusSchema.enum.DELETED,
    },
    ScanIndexForward: false,
  });

  const response = await docClient.send(command);
  const entities = (response.Items || []) as DocumentEntity[];
  const documents: DocumentResponseDto[] = entities.map(toDocumentDTO);
  return { documents };
}

/**
 * ダウンロードURL取得 GET /documents/{documentId}/download-url
 */
async function getDownloadUrl(
  documentId: string,
  ownerId: string
): Promise<{ downloadUrl: string }> {
  const command = new GetCommand({
    TableName: TABLE_NAME,
    Key: { documentId },
  });

  const response = await docClient.send(command);
  const item = response.Item as DocumentEntity;

  if (!item) throw new AppError(404, ErrorCode.DOCUMENTS_NOT_FOUND);

  if (item.ownerId !== ownerId) {
    logger("WARN", "Access attempt to document by non-owner", {
      documentId,
      ownerId,
      actualOwnerId: item.ownerId,
    });
    // セキュリティ上の理由で404を返すが、エラーコードでPERMISSION_DENIEDを明示
    throw new AppError(404, ErrorCode.PERMISSION_DENIED);
  }

  if (item.status === DocumentStatusSchema.enum.DELETED) {
    throw new AppError(404, ErrorCode.DOCUMENTS_NOT_FOUND);
  }

  if (item.status !== DocumentStatusSchema.enum.COMPLETED || !item.s3Key) {
    throw new AppError(400, ErrorCode.DOCUMENTS_NOT_READY_FOR_DOWNLOAD);
  }

  let responseContentType = item.contentType;

  const TEXT_TYPES = ["text/markdown", "text/x-markdown", "text/plain"];

  if (TEXT_TYPES.includes(item.contentType)) {
    if (!responseContentType.includes("charset")) {
      responseContentType = `${responseContentType}; charset=utf-8`;
    }
  }

  const downloadUrl = await generateDownloadUrl(
    s3Client,
    BUCKET_NAME,
    item.s3Key,
    responseContentType,
    3600
  );
  return { downloadUrl };
}

/**
 * ドキュメント詳細取得 GET /documents/{documentId}
 */
async function getDocumentById(
  documentId: string,
  ownerId: string
): Promise<GetDocumentResponseDto> {
  const command = new GetCommand({
    TableName: TABLE_NAME,
    Key: { documentId },
  });

  const response = await docClient.send(command);
  const item = response.Item as DocumentEntity;

  if (!item) throw new AppError(404, ErrorCode.DOCUMENTS_NOT_FOUND);

  if (item.ownerId !== ownerId) {
    logger("WARN", "Access attempt to document by non-owner", {
      documentId,
      ownerId,
      actualOwnerId: item.ownerId,
    });
    // セキュリティ上の理由で404を返すが、エラーコードでPERMISSION_DENIEDを明示
    throw new AppError(404, ErrorCode.PERMISSION_DENIED);
  }

  if (item.status === DocumentStatusSchema.enum.DELETED) {
    throw new AppError(404, ErrorCode.DOCUMENTS_NOT_FOUND);
  }

  const document = toDocumentDTO(item);

  return { document };
}

/**
 * ドキュメント削除 (論理削除 + TTL) DELETE /documents/{documentId}
 */
async function deleteDocument(
  documentId: string,
  ownerId: string
): Promise<DeleteDocumentResponseDto> {
  const ttl = Math.floor(Date.now() / 1000) + DOCUMENT_TTL_SECONDS;

  const command = new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { documentId },
    ConditionExpression: "attribute_exists(documentId) AND ownerId = :ownerId",
    UpdateExpression:
      "SET #status = :deleted, ttl = :ttl, updatedAt = :updatedAt, processingStatus = :active",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":deleted": DocumentStatusSchema.enum.DELETED,
      ":ttl": ttl,
      ":updatedAt": new Date().toISOString(),
      ":ownerId": ownerId,
      ":active": "ACTIVE",
    },
    ReturnValues: "ALL_NEW",
  });

  const response = await docClient.send(command);

  if (!response.Attributes) {
    throw new AppError(500, ErrorCode.INTERNAL_SERVER_ERROR, {
      documentId,
      ownerId,
      response,
      error: new Error("DynamoDB update succeeded but returned no attributes"),
    });
  }

  const document = toDocumentDTO(response.Attributes as DocumentEntity);
  return { document };
}

/**
 * ドキュメント一括削除 POST /documents/batch-delete
 */
async function batchDeleteDocuments(
  body: BatchDeleteRequestDto,
  ownerId: string
): Promise<BatchDeleteResponseDto> {
  const { documentIds } = body;

  const results: BatchDeleteResultDto[] = await Promise.all(
    documentIds.map(async (documentId) => {
      try {
        await deleteDocument(documentId, ownerId);
        return {
          documentId,
          status: ResultStatusSchema.enum.success,
        };
      } catch (error) {
        logger("ERROR", "Failed to delete document in batch", {
          documentId,
          ownerId,
          error,
        });
        return {
          documentId,
          status: ResultStatusSchema.enum.error,
          errorCode: ErrorCode.INTERNAL_SERVER_ERROR,
        };
      }
    })
  );

  return { results };
}

/**
 * ドキュメントタグ更新 PATCH /documents/{documentId}/tags
 */
async function updateTags(
  documentId: string,
  body: UpdateTagsRequestDto,
  ownerId: string
): Promise<UpdateTagsResponseDto> {
  const { tags } = body;

  const sanitizedTags = sanitizeTags(tags);

  const command = new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { documentId },
    ConditionExpression: "attribute_exists(documentId) AND ownerId = :ownerId",
    UpdateExpression:
      "SET #tags = :tags, tagUpdatedAt = :updatedAt, updatedAt = :updatedAt",
    ExpressionAttributeNames: { "#tags": "tags" },
    ExpressionAttributeValues: {
      ":tags": sanitizedTags,
      ":updatedAt": new Date().toISOString(),
      ":ownerId": ownerId,
    },
    ReturnValues: "ALL_NEW",
  });

  const response = await docClient.send(command);
  const item = response.Attributes as DocumentEntity;
  if (!item) {
    throw new AppError(500, ErrorCode.INTERNAL_SERVER_ERROR, {
      documentId,
      ownerId,
      response,
      error: new Error("DynamoDB update succeeded but returned no attributes"),
    });
  }
  const document = toDocumentDTO(item);
  return { document };
}

/**
 * ドキュメントアップロードリクエスト POST /documents/upload
 */
async function uploadRequest(
  body: UploadRequestRequestDto,
  ownerId: string
): Promise<UploadRequestResponseDto> {
  const { files, tags } = body;

  const sanitizedTags = sanitizeTags(tags);

  const results: UploadRequestFileResultDto[] = await Promise.all(
    files.map(async (file: FileMetadataDto) => {
      try {
        const duplicateDocs = await docClient.send(
          new QueryCommand({
            TableName: TABLE_NAME,
            IndexName: "FileNameIndex",
            KeyConditionExpression:
              "ownerId = :ownerId AND fileName = :fileName",
            ExpressionAttributeValues: {
              ":ownerId": ownerId,
              ":fileName": file.fileName,
              ":deleted": DocumentStatusSchema.enum.DELETED,
            },
            FilterExpression: "#status <> :deleted",
            ExpressionAttributeNames: { "#status": "status" },
          })
        );

        if (duplicateDocs.Items && duplicateDocs.Items.length > 0) {
          const activeDocs = duplicateDocs.Items as DocumentEntity[];

          await Promise.all(
            activeDocs.map((oldDoc) =>
              markDocumentForDeletion(oldDoc.documentId, ownerId)
            )
          );
        }

        const uploadData = await createUploadRequest(
          file,
          sanitizedTags,
          ownerId
        );

        return {
          status: ResultStatusSchema.enum.success,
          fileName: file.fileName,
          data: uploadData,
        };
      } catch (error) {
        logger("ERROR", "Failed to process document upload", {
          fileName: file.fileName,
          fileSize: file.fileSize,
          ownerId: ownerId,
          error: error,
        });
        return {
          status: ResultStatusSchema.enum.error,
          fileName: file.fileName,
          errorCode: ErrorCode.DOCUMENTS_UPLOAD_FAILED,
        };
      }
    })
  );

  return { results };
}

// =================================================================
// ヘルパー
// =================================================================

/**
 * ドキュメントを削除リクエストにする (同名ファイルアップロード時の置換用)
 * こちらもTTLロジックに合わせる
 */
async function markDocumentForDeletion(documentId: string, ownerId: string) {
  const ttl = Math.floor(Date.now() / 1000) + DOCUMENT_TTL_SECONDS;

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { documentId },
      ConditionExpression: "ownerId = :ownerId",
      UpdateExpression:
        "SET #status = :deleted, ttl = :ttl, updatedAt = :now, processingStatus = :active",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":deleted": DocumentStatusSchema.enum.DELETED,
        ":ttl": ttl,
        ":now": new Date().toISOString(),
        ":ownerId": ownerId,
        ":active": "ACTIVE",
      },
    })
  );
}

/**
 * ドキュメントアップロードリクエストを作成
 */
async function createUploadRequest(
  file: FileMetadataDto,
  tags: string[],
  ownerId: string
): Promise<UploadRequestResultDto> {
  const documentId = randomUUID();
  const s3Key = `uploads/${ownerId}/${documentId}`;
  const s3Path = buildS3Uri(BUCKET_NAME, s3Key);
  const now = new Date().toISOString();

  const item: DocumentEntity = {
    documentId,
    status: DocumentStatusSchema.enum.PENDING_UPLOAD,
    processingStatus: "ACTIVE",
    fileName: file.fileName,
    contentType: file.contentType,
    fileSize: file.fileSize,
    s3Path,
    s3Key,
    ownerId: ownerId,
    createdAt: now,
    updatedAt: now,
    tags: tags,
    uploadUrlExpiresAt: new Date(
      Date.now() + PRESIGNED_URL_EXPIRY * 1000
    ).toISOString(),
  };

  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  const uploadUrl = await generateUploadUrl(
    s3Client,
    BUCKET_NAME,
    s3Key,
    file.contentType,
    PRESIGNED_URL_EXPIRY
  );

  return {
    documentId,
    fileName: file.fileName,
    uploadUrl,
    expiresIn: PRESIGNED_URL_EXPIRY,
    s3Key,
  };
}

/**
 * タグを正規化
 */
function sanitizeTags(tags: string[]): string[] {
  return tags.map((t) => t.trim()).filter((t) => t.length > 0);
}
