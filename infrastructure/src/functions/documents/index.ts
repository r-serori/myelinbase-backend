// src/functions/documents/index.ts

import {
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { createDynamoDBClient } from "../../shared/utils/dynamodb";
import {
  createS3Client,
  generateUploadUrl,
  generateDownloadUrl,
  buildS3Uri,
} from "../../shared/utils/s3";
import {
  FileMetadata,
  DocumentResponse,
  GetDocumentsResponse,
  GetDocumentResponse,
  UploadRequestRequest,
  UploadRequestRequestSchema,
  UploadRequestResponse,
  UploadRequestFileResult,
  DeleteDocumentResponse,
  UpdateTagsRequest,
  UpdateTagsRequestSchema,
  UpdateTagsResponse,
  BatchDeleteRequest,
  BatchDeleteRequestSchema,
  BatchDeleteResponse,
  BatchDeleteResult,
} from "../../shared/types/document";
import { ErrorCode } from "../../shared/types/error-code";
import {
  apiHandler,
  AppError,
  logger,
  validateJson,
} from "../../shared/utils/api-handler";
import { randomUUID } from "crypto";

const TABLE_NAME = process.env.TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;
const PRESIGNED_URL_EXPIRY = parseInt(
  process.env.PRESIGNED_URL_EXPIRY || "900",
  10
);
const USE_MOCK_AUTH = process.env.USE_MOCK_AUTH === "true";

const docClient = createDynamoDBClient();
const s3Client = createS3Client();

export const handler = apiHandler(async (event) => {
  const { httpMethod, path, pathParameters } = event;
  const ownerId = extractOwnerId(event);

  if (httpMethod === "GET" && path === "/documents") {
    const response: GetDocumentsResponse = await getDocuments(ownerId);
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

    const response: GetDocumentResponse = await getDocumentById(
      documentId,
      ownerId
    );
    return response;
  }

  if (httpMethod === "POST" && path === "/documents/upload-request") {
    const body = validateJson(event.body, UploadRequestRequestSchema);
    const response: UploadRequestResponse = await uploadRequest(body, ownerId);
    return { statusCode: 202, body: response };
  }

  if (httpMethod === "DELETE" && path.startsWith("/documents/")) {
    const documentId = pathParameters?.id;
    if (!documentId) throw new AppError(400, ErrorCode.MISSING_PARAMETER);

    const response: DeleteDocumentResponse = await deleteDocument(
      documentId,
      ownerId
    );
    return { statusCode: 202, body: response };
  }

  if (httpMethod === "POST" && path === "/documents/batch-delete") {
    const body = validateJson(event.body, BatchDeleteRequestSchema);
    const response: BatchDeleteResponse = await batchDeleteDocuments(
      body,
      ownerId
    );
    return { statusCode: 200, body: response };
  }

  if (httpMethod === "PATCH" && path.endsWith("/tags")) {
    const documentId = pathParameters?.id;
    if (!documentId) throw new AppError(400, ErrorCode.MISSING_PARAMETER);

    const body = validateJson(event.body, UpdateTagsRequestSchema);
    const response: UpdateTagsResponse = await updateTags(
      documentId,
      body,
      ownerId
    );
    return response;
  }

  throw new AppError(404);
});

function extractOwnerId(event: any): string {
  if (USE_MOCK_AUTH) {
    const authHeader =
      event.headers?.Authorization || event.headers?.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      return "user-001";
    }
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
async function getDocuments(ownerId: string): Promise<GetDocumentsResponse> {
  const command = new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: "OwnerIndex",
    KeyConditionExpression: "#owner = :ownerId",
    ExpressionAttributeNames: { "#owner": "ownerId" },
    ExpressionAttributeValues: { ":ownerId": ownerId },
    ScanIndexForward: false,
  });

  const response = await docClient.send(command);
  const documents = (response.Items || []).map(
    excludeInternalFields
  ) as DocumentResponse[];
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
  const item = response.Item;

  if (!item) throw new AppError(404, ErrorCode.DOCUMENTS_NOT_FOUND);

  if (item.ownerId !== ownerId) {
    logger("WARN", "Access attempt to document by non-owner", {
      documentId,
      ownerId,
      actualOwnerId: item.ownerId,
    });
    throw new AppError(404);
  }

  if (item.status !== "COMPLETED" || !item.s3Key) {
    throw new AppError(400, ErrorCode.DOCUMENTS_NOT_READY_FOR_DOWNLOAD);
  }

  let responseContentType = item.contentType;

  const TEXT_TYPES = ["text/markdown", "text/x-markdown", "text/plain"];

  if (
    TEXT_TYPES.includes(item.contentType) ||
    item.fileName.toLowerCase().endsWith(".md")
  ) {
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
): Promise<GetDocumentResponse> {
  const command = new GetCommand({
    TableName: TABLE_NAME,
    Key: { documentId },
  });

  const response = await docClient.send(command);
  const item = response.Item;

  if (!item) throw new AppError(404, ErrorCode.DOCUMENTS_NOT_FOUND);

  if (item.ownerId !== ownerId) {
    logger("WARN", "Access attempt to document by non-owner", {
      documentId,
      ownerId,
      actualOwnerId: item.ownerId,
    });
    throw new AppError(404);
  }

  const document = excludeInternalFields(item) as DocumentResponse;

  return { document };
}

/**
 * ドキュメント削除 DELETE /documents/{documentId}
 */
async function deleteDocument(
  documentId: string,
  ownerId: string
): Promise<DeleteDocumentResponse> {
  const command = new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { documentId },
    ConditionExpression: "attribute_exists(documentId) AND ownerId = :ownerId",
    UpdateExpression:
      "SET deleteRequested = :true, #status = :deleting, updatedAt = :updatedAt, processingStatus = :active",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":true": true,
      ":deleting": "DELETING",
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

  const document = excludeInternalFields(
    response.Attributes
  ) as DocumentResponse;
  return { document };
}

/**
 * ドキュメント一括削除 POST /documents/batch-delete
 */
async function batchDeleteDocuments(
  body: BatchDeleteRequest,
  ownerId: string
): Promise<BatchDeleteResponse> {
  const { documentIds } = body;

  const results: BatchDeleteResult[] = await Promise.all(
    documentIds.map(async (documentId) => {
      try {
        await deleteDocument(documentId, ownerId);
        return {
          documentId,
          status: "success",
        };
      } catch (error) {
        logger("ERROR", "Failed to delete document in batch", {
          documentId,
          ownerId,
          error,
        });
        return {
          documentId,
          status: "error",
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
  body: UpdateTagsRequest,
  ownerId: string
): Promise<UpdateTagsResponse> {
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
  if (!response.Attributes) {
    throw new AppError(500, ErrorCode.INTERNAL_SERVER_ERROR, {
      documentId,
      ownerId,
      response,
      error: new Error("DynamoDB update succeeded but returned no attributes"),
    });
  }
  const document = excludeInternalFields(
    response.Attributes
  ) as DocumentResponse;
  return { document };
}

/**
 * ドキュメントアップロードリクエスト POST /documents/upload-request
 */
async function uploadRequest(
  body: UploadRequestRequest,
  ownerId: string
): Promise<UploadRequestResponse> {
  const { files, tags } = body;

  const sanitizedTags = sanitizeTags(tags);

  const results: UploadRequestFileResult[] = await Promise.all(
    files.map(async (file: FileMetadata, index: number) => {
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
            },
          })
        );

        if (duplicateDocs.Items && duplicateDocs.Items.length > 0) {
          const oldDoc = duplicateDocs.Items[0];
          await markDocumentForDeletion(oldDoc.documentId, ownerId);
        }

        const uploadData = await createUploadRequest(
          file,
          sanitizedTags,
          ownerId
        );

        return {
          status: "success" as const,
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
          status: "error" as const,
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
 * ドキュメントを削除リクエストにする
 */
async function markDocumentForDeletion(documentId: string, ownerId: string) {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { documentId },
      ConditionExpression: "ownerId = :ownerId",
      UpdateExpression:
        "SET deleteRequested = :true, #status = :deleting, updatedAt = :now, processingStatus = :active",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":true": true,
        ":deleting": "DELETING",
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
  file: FileMetadata,
  tags: string[],
  ownerId: string
) {
  const documentId = randomUUID();
  const s3Key = `uploads/${ownerId}/${documentId}/${file.fileName}`;
  const s3Path = buildS3Uri(BUCKET_NAME, s3Key);
  const now = new Date().toISOString();

  const item = {
    documentId,
    status: "PENDING_UPLOAD",
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
 * 内部フィールドを除外
 */
function excludeInternalFields(item: Record<string, any>): DocumentResponse {
  const { ownerId, ...rest } = item;
  return rest as DocumentResponse;
}

/**
 * タグを正規化
 */
function sanitizeTags(tags: string[]): string[] {
  return tags.map((t) => t.trim()).filter((t) => t.length > 0);
}
