export const DOCUMENT_STATUS = [
  "PENDING_UPLOAD",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "DELETING",
  "DELETED",
  "DELETE_FAILED",
] as const;

export const FEEDBACK_TYPE = ["NONE", "GOOD", "BAD"] as const;

export const RESULT_STATUS = ["success", "error"] as const;
