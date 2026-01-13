// src/shared/prompts/rag-prompt-builder.test.ts

import {
  buildRAGPrompt,
  ContextDocument,
  extractAnswerFromStream,
  extractCitedFileNames,
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
    it("SYSTEM_PROMPT_RAG_CITATIONS should include citation format", () => {
      expect(SYSTEM_PROMPT_RAG_CITATIONS).toContain("[出典:");
      expect(SYSTEM_PROMPT_RAG_CITATIONS).toContain("cite sources");
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
      expect(userPrompt).toContain("[出典:");
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

    it("should use thinking prompt", () => {
      const { systemPrompt } = buildRAGPrompt({
        documents: sampleDocs,
        query: sampleQuery,
        enableThinking: true,
      });

      expect(systemPrompt).toBe(SYSTEM_PROMPT_RAG_THINKING);
    });

    it("should escape XML special characters", () => {
      const docsWithSpecialChars: ContextDocument[] = [
        {
          text: 'Test <script> & "quotes"',
          fileName: "test.pdf",
          documentId: "1",
          score: 0.9,
        },
      ];

      const { userPrompt } = buildRAGPrompt({
        documents: docsWithSpecialChars,
        query: sampleQuery,
      });

      expect(userPrompt).toContain("&lt;script&gt;");
      expect(userPrompt).toContain("&amp;");
      expect(userPrompt).toContain("&quot;quotes&quot;");
    });

    it("should include score in documents XML", () => {
      const { userPrompt } = buildRAGPrompt({
        documents: sampleDocs,
        query: sampleQuery,
      });

      expect(userPrompt).toContain('score="0.95"');
      expect(userPrompt).toContain('score="0.88"');
    });
  });

  describe("parseThinkingResponse", () => {
    it("should parse complete thinking/answer response", () => {
      const response = `<thinking>
Analyzing document 1...
Found relevant info about features.
</thinking>

<answer>
Myelin Baseはドキュメント管理プラットフォームです。
</answer>`;

      const { thinking, answer } = parseThinkingResponse(response);

      expect(thinking).toContain("Analyzing document 1");
      expect(answer).toContain("ドキュメント管理プラットフォーム");
    });

    it("should return raw response when no tags present", () => {
      const response = "Plain response without tags.";
      const { thinking, answer } = parseThinkingResponse(response);

      expect(thinking).toBeNull();
      expect(answer).toBe(response);
    });

    it("should handle response with only answer tag", () => {
      const response = "<answer>Just the answer.</answer>";
      const { thinking, answer } = parseThinkingResponse(response);

      expect(thinking).toBeNull();
      expect(answer).toBe("Just the answer.");
    });

    it("should trim whitespace", () => {
      const response = `<thinking>
  Analysis here  
</thinking>

<answer>
  Answer here  
</answer>`;

      const { thinking, answer } = parseThinkingResponse(response);

      expect(thinking).toBe("Analysis here");
      expect(answer).toBe("Answer here");
    });
  });

  describe("extractAnswerFromStream", () => {
    it("should return empty before answer tag", () => {
      const result = extractAnswerFromStream("<thinking>Analyzing...");
      expect(result).toBe("");
    });

    it("should extract partial answer while streaming", () => {
      const text = "<thinking>Done</thinking>\n<answer>Partial response";
      const result = extractAnswerFromStream(text);
      expect(result).toBe("Partial response");
    });

    it("should extract complete answer when closed", () => {
      const text =
        "<thinking>Done</thinking>\n<answer>Complete answer.</answer>";
      const result = extractAnswerFromStream(text);
      expect(result).toBe("Complete answer.");
    });

    it("should handle answer immediately after thinking", () => {
      const text = "<thinking>Analysis</thinking><answer>Result";
      const result = extractAnswerFromStream(text);
      expect(result).toBe("Result");
    });
  });

  describe("extractCitedFileNames", () => {
    it("should extract simple file citation", () => {
      const text = "これは重要です [出典: manual.pdf]";
      const files = extractCitedFileNames(text);
      expect(files).toEqual(["manual.pdf"]);
    });

    it("should extract multiple files separated by comma", () => {
      const text = "複数の出典があります [出典: doc1.pdf, doc2.txt]";
      const files = extractCitedFileNames(text);
      expect(files).toEqual(["doc1.pdf", "doc2.txt"]);
    });

    it("should extract Japanese filenames with symbols", () => {
      const text =
        "ハラスメントの禁止、副業・兼業の条件などについても就業規則で定められています。[出典: 情報セキュリティ・コンプライアンスガイドライン.pdf]";
      const files = extractCitedFileNames(text);
      expect(files).toEqual([
        "情報セキュリティ・コンプライアンスガイドライン.pdf",
      ]);
    });

    it("should handle Japanese separators (、)", () => {
      const text = "参照: [出典: file1.pdf、file2.pdf]";
      const files = extractCitedFileNames(text);
      expect(files).toEqual(["file1.pdf", "file2.pdf"]);
    });

    it("should handle multiple citation tags", () => {
      const text = "[出典: a.pdf] によると... また、[出典: b.pdf] によると...";
      const files = extractCitedFileNames(text);
      expect(files).toEqual(["a.pdf", "b.pdf"]);
    });

    it("should ignore duplicates", () => {
      const text = "[出典: a.pdf] ... [出典: a.pdf]";
      const files = extractCitedFileNames(text);
      expect(files).toEqual(["a.pdf"]);
    });
  });
});
