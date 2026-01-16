// src/shared/prompts/rag-prompt-builder.test.ts

import {
  buildRAGPrompt,
  ContextDocument,
  extractAnswerFromStream,
  extractCitedReferences,
  isNoRelevantInfoResponse,
  parseThinkingResponse,
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
    it("should use citations prompt by default", () => {
      const { systemPrompt, userPrompt } = buildRAGPrompt({
        documents: sampleDocs,
        query: sampleQuery,
      });

      expect(systemPrompt).toBe(SYSTEM_PROMPT_RAG_CITATIONS);
      expect(userPrompt).toContain("<documents>");
      expect(userPrompt).toContain('source="overview.pdf"');
      expect(userPrompt).toContain('index="1"');
      expect(userPrompt).toContain('index="2"');
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

    it("should handle empty documents array", () => {
      const { systemPrompt, userPrompt } = buildRAGPrompt({
        documents: [],
        query: sampleQuery,
      });

      expect(systemPrompt).toBe(SYSTEM_PROMPT_RAG_CITATIONS);
      expect(userPrompt).toContain("<documents>");
      expect(userPrompt).toContain("<empty>No documents available.</empty>");
    });

    it("should escape XML special characters in document text", () => {
      const docsWithSpecialChars: ContextDocument[] = [
        {
          text: "Text with <tags> & special chars",
          fileName: "test.xml",
          documentId: "doc-001",
          score: 0.9,
        },
      ];

      const { userPrompt } = buildRAGPrompt({
        documents: docsWithSpecialChars,
        query: sampleQuery,
      });

      expect(userPrompt).toContain("&lt;tags&gt;");
      expect(userPrompt).toContain("&amp;");
      expect(userPrompt).not.toContain("<tags>");
    });

    it("should escape XML special characters in fileName", () => {
      const docsWithSpecialChars: ContextDocument[] = [
        {
          text: "Content",
          fileName: 'file with "quotes" & <tags>.pdf',
          documentId: "doc-001",
          score: 0.9,
        },
      ];

      const { userPrompt } = buildRAGPrompt({
        documents: docsWithSpecialChars,
        query: sampleQuery,
      });

      expect(userPrompt).toContain("&quot;");
      expect(userPrompt).toContain("&amp;");
      expect(userPrompt).toContain("&lt;");
    });

    it("should include score in document attributes", () => {
      const { userPrompt } = buildRAGPrompt({
        documents: sampleDocs,
        query: sampleQuery,
      });

      expect(userPrompt).toContain('score="0.95"');
      expect(userPrompt).toContain('score="0.88"');
    });

    it("should include question in user prompt", () => {
      const { userPrompt } = buildRAGPrompt({
        documents: sampleDocs,
        query: sampleQuery,
      });

      expect(userPrompt).toContain("<question>");
      expect(userPrompt).toContain(sampleQuery);
      expect(userPrompt).toContain("</question>");
    });
  });

  describe("parseThinkingResponse", () => {
    it("should parse both thinking and answer", () => {
      const response = "<thinking>Analysis here</thinking><answer>Answer here</answer>";
      const result = parseThinkingResponse(response);

      expect(result.thinking).toBe("Analysis here");
      expect(result.answer).toBe("Answer here");
    });

    it("should return null thinking if thinking tag is missing", () => {
      const response = "<answer>Answer only</answer>";
      const result = parseThinkingResponse(response);

      expect(result.thinking).toBeNull();
      expect(result.answer).toBe("Answer only");
    });

    it("should return full response as answer if answer tag is missing", () => {
      const response = "<thinking>Analysis only</thinking>";
      const result = parseThinkingResponse(response);

      expect(result.thinking).toBe("Analysis only");
      expect(result.answer).toBe(response.trim());
    });

    it("should return full response if both tags are missing", () => {
      const response = "Plain text response";
      const result = parseThinkingResponse(response);

      expect(result.thinking).toBeNull();
      expect(result.answer).toBe("Plain text response");
    });

    it("should trim whitespace from thinking and answer", () => {
      const response = "<thinking>  Analysis  </thinking><answer>  Answer  </answer>";
      const result = parseThinkingResponse(response);

      expect(result.thinking).toBe("Analysis");
      expect(result.answer).toBe("Answer");
    });

    it("should handle multiline thinking and answer", () => {
      const response = `<thinking>
Line 1
Line 2
</thinking>
<answer>
Answer Line 1
Answer Line 2
</answer>`;
      const result = parseThinkingResponse(response);

      expect(result.thinking).toContain("Line 1");
      expect(result.thinking).toContain("Line 2");
      expect(result.answer).toContain("Answer Line 1");
      expect(result.answer).toContain("Answer Line 2");
    });

    it("should handle nested tags in content", () => {
      const response = "<thinking>Think about <tags></thinking><answer>Answer with <tags></answer>";
      const result = parseThinkingResponse(response);

      expect(result.thinking).toContain("<tags>");
      expect(result.answer).toContain("<tags>");
    });
  });

  describe("extractAnswerFromStream", () => {
    it("should extract answer content from complete tags", () => {
      const fullText = "Some prefix <answer>Answer content</answer> Some suffix";
      const result = extractAnswerFromStream(fullText);

      expect(result).toBe("Answer content");
    });

    it("should return empty string if answer tag is missing", () => {
      const fullText = "No answer tag here";
      const result = extractAnswerFromStream(fullText);

      expect(result).toBe("");
    });

    it("should return content after answer tag if closing tag is missing", () => {
      const fullText = "Prefix <answer>Answer content without closing tag";
      const result = extractAnswerFromStream(fullText);

      expect(result).toBe("Answer content without closing tag");
    });

    it("should handle multiline answer content", () => {
      const fullText = `<answer>
Line 1
Line 2
Line 3
</answer>`;
      const result = extractAnswerFromStream(fullText);

      expect(result).toContain("Line 1");
      expect(result).toContain("Line 2");
      expect(result).toContain("Line 3");
    });

    it("should extract only first answer if multiple answer tags exist", () => {
      const fullText = "<answer>First answer</answer> <answer>Second answer</answer>";
      const result = extractAnswerFromStream(fullText);

      expect(result).toBe("First answer");
    });

    it("should handle empty answer content", () => {
      const fullText = "<answer></answer>";
      const result = extractAnswerFromStream(fullText);

      expect(result).toBe("");
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

    it("should handle comma separators", () => {
      const text = "[出典1: file1.pdf, file2.pdf]";
      const refs = extractCitedReferences(text);
      expect(refs).toEqual([
        { index: 1, text: "file1.pdf" },
        { index: 1, text: "file2.pdf" },
      ]);
    });

    it("should handle full-width comma separators", () => {
      const text = "[出典1: file1.pdf，file2.pdf]";
      const refs = extractCitedReferences(text);
      expect(refs).toEqual([
        { index: 1, text: "file1.pdf" },
        { index: 1, text: "file2.pdf" },
      ]);
    });

    it("should skip empty parts after splitting", () => {
      const text = "[出典1: file1.pdf, , file2.pdf]";
      const refs = extractCitedReferences(text);
      expect(refs).toEqual([
        { index: 1, text: "file1.pdf" },
        { index: 1, text: "file2.pdf" },
      ]);
    });

    it("should return empty array for text without citations", () => {
      const text = "No citations here";
      const refs = extractCitedReferences(text);
      expect(refs).toEqual([]);
    });

    it("should handle citations with spaces in filename", () => {
      const text = "[出典1: file name with spaces.pdf]";
      const refs = extractCitedReferences(text);
      expect(refs).toEqual([
        { index: 1, text: "file name with spaces.pdf" },
      ]);
    });

    it("should handle large index numbers", () => {
      const text = "[出典99: large-index.pdf]";
      const refs = extractCitedReferences(text);
      expect(refs).toEqual([
        { index: 99, text: "large-index.pdf" },
      ]);
    });
  });

  describe("isNoRelevantInfoResponse", () => {
    it("should return true for standard no-info pattern", () => {
      const text = "この質問に関連する情報はアップロードされたドキュメントには見つかりませんでした。";
      expect(isNoRelevantInfoResponse(text)).toBe(true);
    });

    it("should return true for alternative no-info pattern", () => {
      const text = "アップロードされたドキュメントには関連する情報が見つかりませんでした。";
      expect(isNoRelevantInfoResponse(text)).toBe(true);
    });

    it("should return true for apology pattern", () => {
      const text = "申し訳ありませんが、ドキュメントには見つかりませんでした。";
      expect(isNoRelevantInfoResponse(text)).toBe(true);
    });

    it("should return true for document-specific pattern", () => {
      const text = "ドキュメントにはこの情報に関する情報が見つかりませんでした。";
      expect(isNoRelevantInfoResponse(text)).toBe(true);
    });

    it("should return true for general no-info pattern", () => {
      const text = "関連する情報がありませんでした。";
      expect(isNoRelevantInfoResponse(text)).toBe(true);
    });

    it("should return true for matching pattern", () => {
      const text = "該当する情報が見つかりませんでした。";
      expect(isNoRelevantInfoResponse(text)).toBe(true);
    });

    it("should return false for text with relevant information", () => {
      const text = "Myelin Baseはドキュメント管理プラットフォームです。";
      expect(isNoRelevantInfoResponse(text)).toBe(false);
    });

    it("should return false for text with citations", () => {
      const text = "これは重要です [出典1: manual.pdf]";
      expect(isNoRelevantInfoResponse(text)).toBe(false);
    });

    it("should return false for empty string", () => {
      expect(isNoRelevantInfoResponse("")).toBe(false);
    });

    it("should handle partial matches correctly", () => {
      // パターンに完全にマッチしない場合は false
      const text = "情報が見つかりました。";
      expect(isNoRelevantInfoResponse(text)).toBe(false);
    });
  });
});

