// src/shared/prompts/rag-prompt-builder.test.ts

import {
  buildRAGPrompt,
  ContextDocument,
  extractCitedReferences,
  SYSTEM_PROMPT_RAG_CITATIONS,
  SYSTEM_PROMPT_RAG_THINKING,
} from "./rag-prompt-builder";

// ============================================
// Test Data
// ============================================

const sampleDocs: ContextDocument[] = [
  {
    text: "Myelin Baseはドキュメント管理とRAGを統合したプラットフォームです。",
    fileName: "overview.pdf",
    documentId: "doc-001",
    score: 0.95,
  },
  {
    text: "PDF、Word、テキストファイルをアップロードできます。",
    fileName: "features.pdf",
    documentId: "doc-002",
    score: 0.88,
  },
];

const sampleQuery = "Myelin Baseの機能は？";

// ============================================
// Tests
// ============================================

describe("RAG Prompt Builder", () => {
  describe("System Prompts", () => {
    it("SYSTEM_PROMPT_RAG_CITATIONS should include index citation format", () => {
      expect(SYSTEM_PROMPT_RAG_CITATIONS).toContain("[出典: index. filename]");
      expect(SYSTEM_PROMPT_RAG_CITATIONS).toContain('"index" attribute');
    });

    it("SYSTEM_PROMPT_RAG_THINKING should include format tags", () => {
      expect(SYSTEM_PROMPT_RAG_THINKING).toContain("<thinking>");
      expect(SYSTEM_PROMPT_RAG_THINKING).toContain("<answer>");
      expect(SYSTEM_PROMPT_RAG_THINKING).toContain("<format>");
    });
  });

  describe("buildRAGPrompt", () => {
    it("should use citations prompt", () => {
      const { systemPrompt, userPrompt } = buildRAGPrompt({
        documents: sampleDocs,
        query: sampleQuery,
      });

      expect(systemPrompt).toBe(SYSTEM_PROMPT_RAG_CITATIONS);
      expect(userPrompt).toContain("<documents>");
      expect(userPrompt).toContain('source="overview.pdf"');
      expect(userPrompt).toContain('index="1"');
      expect(userPrompt).toContain("[出典: index. filename]");
    });

    it("should use thinking prompt when enableThinking is true", () => {
      const { systemPrompt, userPrompt } = buildRAGPrompt({
        documents: sampleDocs,
        query: sampleQuery,
        enableThinking: true,
      });

      expect(systemPrompt).toBe(SYSTEM_PROMPT_RAG_THINKING);
      expect(userPrompt).toContain("<documents>");
      expect(userPrompt.trim()).toMatch(/<thinking>$/);
    });
  });

  describe("extractCitedReferences", () => {
    it("should extract indexed citation", () => {
      const text = "これは重要です [出典: 1. manual.pdf]";
      const refs = extractCitedReferences(text);
      expect(refs).toEqual([
        {
          index: 1,
          text: "manual.pdf",
        },
      ]);
    });

    it("should extract multiple indexed citations", () => {
      const text = "複数の出典 [出典: 1. doc1.pdf, 2. doc2.txt]";
      const refs = extractCitedReferences(text);
      expect(refs).toEqual([
        { index: 1, text: "doc1.pdf" },
        { index: 2, text: "doc2.txt" },
      ]);
    });

    it("should handle Japanese separators (、)", () => {
      const text = "参照: [出典: 1. file1.pdf、2. file2.pdf]";
      const refs = extractCitedReferences(text);
      expect(refs).toEqual([
        { index: 1, text: "file1.pdf" },
        { index: 2, text: "file2.pdf" },
      ]);
    });

    it("should fallback to text only if no index found", () => {
      const text = "古い形式: [出典: legacy.pdf]";
      const refs = extractCitedReferences(text);
      expect(refs).toEqual([
        { text: "legacy.pdf" }, // index is undefined
      ]);
    });

    it("should handle mixed formats", () => {
      const text = "[出典: 1. good.pdf, bad.pdf]";
      const refs = extractCitedReferences(text);
      expect(refs).toEqual([
        { index: 1, text: "good.pdf" },
        { text: "bad.pdf" },
      ]);
    });
  });
});
