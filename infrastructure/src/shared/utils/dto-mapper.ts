// utils/dto-mapper.ts

import { ChatMessageDto, ChatSessionDto } from "../schemas/dto/chat.dto";
import { DocumentResponseDto } from "../schemas/dto/document.dto";
import {
  ChatMessageEntity,
  ChatSessionEntity,
} from "../schemas/entities/chat.entity";
import { DocumentEntity } from "../schemas/entities/document.entity";

export function toSessionDTO(entity: ChatSessionEntity): ChatSessionDto {
  const { pk, sk, gsi1pk, gsi1sk, ownerId, ...dto } = entity;
  return dto;
}

export function toMessageDTO(entity: ChatMessageEntity): ChatMessageDto {
  const { pk, sk, ownerId, sourceDocuments, feedbackComment, ...dto } = entity;
  return {
    ...dto,
    sourceDocuments: sourceDocuments.map((sourceDocument) => ({
      fileName: sourceDocument.fileName,
      score: sourceDocument.score ?? 0,
      text: sourceDocument.text ?? "",
      documentId: sourceDocument.documentId ?? "",
    })),
  };
}

export function toDocumentDTO(entity: DocumentEntity): DocumentResponseDto {
  const { ownerId, s3Key, s3Path, ...dto } = entity;
  return dto;
}
