// src/functions/processor/index.ts
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { generateEmbeddings } from "../../shared/clients/bedrock";
import {
  createPineconeClient,
  generateVectorId,
  getPineconeApiKey,
  upsertDocumentVectors,
} from "../../shared/clients/pinecone";
import { DocumentStatusSchema } from "../../shared/schemas/entities/document.entity";
import {
  ChunkData,
  EmbedAndUpsertResponse,
  ExtractAndChunkResponse,
  ProcessorError,
  ProcessorEvent,
  UpdateStatusResponse,
} from "../../shared/types/processor";
import { logger } from "../../shared/utils/api-handler";
import { createDynamoDBClient } from "../../shared/utils/dynamodb";
import { createS3Client } from "../../shared/utils/s3";
import {
  createDocumentMetadata,
  createSmallToBigChunks,
  extractTextFromS3,
} from "../../shared/utils/text-processing";

const TABLE_NAME = process.env.TABLE_NAME!;

const docClient = createDynamoDBClient();
const s3Client = createS3Client();

export const handler = async (event: ProcessorEvent) => {
  const input = event.payload || event;
  const documentId = input.documentId;
  try {
    if (!documentId) {
      throw new Error("documentId is required");
    }

    switch (event.action) {
      case "updateStatus":
        if (!event.status) {
          throw new Error("status is required for updateStatus action");
        }
        return await handleUpdateStatus(documentId, event.status, event.error);

      case "extractAndChunk":
        if (!input.bucket || !input.key) {
          throw new Error(
            "bucket and key are required for extractAndChunk action"
          );
        }
        return await handleExtractAndChunk(input.bucket, input.key, documentId);

      case "embedAndUpsert":
        if (!input.chunks) {
          throw new Error("chunks are required for embedAndUpsert action");
        }
        return await handleEmbedAndUpsert(documentId, input.chunks);

      default:
        throw new Error(`Unknown action: ${event.action}`);
    }
  } catch (error) {
    logger("ERROR", "Processor error", {
      documentId,
      action: event.action,
      error,
    });
    throw error;
  }
};

async function handleUpdateStatus(
  documentId: string,
  status: string,
  error?: ProcessorError
): Promise<UpdateStatusResponse> {
  const now = new Date().toISOString();
  const updateExpr = error
    ? "SET #status = :status, errorMessage = :error, updatedAt = :now"
    : "SET #status = :status, updatedAt = :now";

  const attrValues: Record<string, string> = {
    ":status": status,
    ":now": now,
  };

  if (error) {
    attrValues[":error"] = JSON.stringify(error).substring(0, 1000);
  }

  let finalExpr = updateExpr;
  if (
    status === DocumentStatusSchema.enum.COMPLETED ||
    status === DocumentStatusSchema.enum.FAILED
  ) {
    finalExpr += " REMOVE processingStatus";
  } else {
    finalExpr += ", processingStatus = :active";
    attrValues[":active"] = "ACTIVE";
  }

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { documentId },
      UpdateExpression: finalExpr,
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: attrValues,
    })
  );

  return { documentId, status };
}

async function handleExtractAndChunk(
  bucket: string,
  key: string,
  documentId: string
): Promise<ExtractAndChunkResponse> {
  const doc = await docClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { documentId } })
  );
  if (!doc.Item) throw new Error(`Document ${documentId} not found`);

  const { contentType, fileName, ownerId } = doc.Item;

  const text = await extractTextFromS3(s3Client, bucket, key, contentType);
  if (!text) throw new Error("Extracted text is empty");

  const chunks: ChunkData[] = createSmallToBigChunks(text, 800, 200, 100, 50);

  return {
    documentId,
    bucket,
    key,
    ownerId,
    fileName,
    contentType,
    text: "",
    chunks,
  };
}

async function handleEmbedAndUpsert(
  documentId: string,
  chunks: ChunkData[]
): Promise<EmbedAndUpsertResponse> {
  const doc = await docClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { documentId } })
  );
  const { fileName, ownerId } = doc.Item!;

  const childTexts = chunks.map((c) => c.childText);
  const embeddings = await generateEmbeddings(childTexts);

  const apiKey = await getPineconeApiKey();
  const pinecone = createPineconeClient(apiKey);

  const vectors = chunks.map((chunk, index) => ({
    id: generateVectorId(documentId, index),
    values: embeddings[index],
    metadata: createDocumentMetadata(
      documentId,
      fileName,
      ownerId,
      index,
      chunks.length,
      chunk.parentText,
      chunk.parentId
    ),
  }));

  await upsertDocumentVectors(pinecone, vectors);

  return { documentId, vectorCount: vectors.length };
}
