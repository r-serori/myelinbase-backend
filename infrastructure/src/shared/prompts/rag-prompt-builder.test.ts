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
      expect(SYSTEM_PROMPT_RAG_CITATIONS).toContain("[出典index: filename]");
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
    it("should extract new format citation [出典N: ...]", () => {
      const text = "これは重要です [出典1: manual.pdf]";
      const refs = extractCitedReferences(text);
      expect(refs).toEqual([
        {
          index: 1,
          text: "manual.pdf",
        },
      ]);
    });

    it("should extract multiple citations in new format", () => {
      const text = "複数の出典 [出典1: doc1.pdf] そして [出典2: doc2.txt]";
      const refs = extractCitedReferences(text);
      expect(refs).toEqual([
        { index: 1, text: "doc1.pdf" },
        { index: 2, text: "doc2.txt" },
      ]);
    });

    it("should fallback to old format [出典: N. ...]", () => {
      const text = "古い形式: [出典: 1. legacy.pdf]";
      const refs = extractCitedReferences(text);
      expect(refs).toEqual([{ index: 1, text: "legacy.pdf" }]);
    });

    it("should fallback to text only if no index found in old format", () => {
      const text = "インデックスなし: [出典: legacy.pdf]";
      const refs = extractCitedReferences(text);
      expect(refs).toEqual([
        { text: "legacy.pdf" }, // index is undefined
      ]);
    });

    it("should handle mixed formats in one text", () => {
      const text = "[出典1: good.pdf] と [出典: 2. old.pdf]";
      const refs = extractCitedReferences(text);
      expect(refs).toEqual([
        { index: 1, text: "good.pdf" },
        { index: 2, text: "old.pdf" },
      ]);
    });

    it("should handle Japanese separators in new format", () => {
      // 本来はタグを分けるべきだが、万が一 [出典1: fileA, fileB] となった場合
      const text = "[出典1: file1.pdf、file2.pdf]";
      const refs = extractCitedReferences(text);
      expect(refs).toEqual([
        { index: 1, text: "file1.pdf" },
        { index: 1, text: "file2.pdf" }, // 同じインデックスが適用される
      ]);
    });
  });
});
