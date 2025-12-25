import { z } from "zod";

import {
  DynamoDBKeysSchema,
  GSI1KeysSchema,
  OwnerSchema,
} from "../common/base";
import { FEEDBACK_TYPE } from "../common/constans";

// =================================================================
// 内部用 Entity（DB保存用）- OpenAPIには公開しない
// =================================================================

export const SourceDocumentSchema = z.object({
  fileName: z.string(),
  score: z.number().optional(),
  text: z.string().optional(),
  documentId: z.string().optional(),
});

export type SourceDocumentEntity = z.infer<typeof SourceDocumentSchema>;

export const FeedbackTypeSchema = z.enum(FEEDBACK_TYPE);
export type FeedbackTypeEntity = z.infer<typeof FeedbackTypeSchema>;

// ChatSession Entity（DB保存用）
export const ChatSessionEntitySchema = DynamoDBKeysSchema.merge(GSI1KeysSchema)
  .merge(OwnerSchema)
  .extend({
    sessionId: z.string(),
    sessionName: z.string(),
    createdAt: z.string().datetime(),
    lastMessageAt: z.string().datetime(),
    updatedAt: z.string().datetime().optional(),
  });

export type ChatSessionEntity = z.infer<typeof ChatSessionEntitySchema>;

// ChatMessage Entity（DB保存用）
export const ChatMessageEntitySchema = DynamoDBKeysSchema.merge(
  OwnerSchema
).extend({
  historyId: z.string(),
  sessionId: z.string(),
  userQuery: z.string(),
  aiResponse: z.string(),
  sourceDocuments: z.array(SourceDocumentSchema),
  feedback: FeedbackTypeSchema,
  feedbackComment: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
});

export type ChatMessageEntity = z.infer<typeof ChatMessageEntitySchema>;
