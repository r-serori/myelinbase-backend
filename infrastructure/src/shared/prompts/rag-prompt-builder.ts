/**
 * RAG Prompt Builder
 *
 * @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags
 */

/**
 * RAG検索結果のドキュメント
 */
export interface ContextDocument {
  /** ドキュメントのテキスト内容 */
  text: string;
  /** ファイル名 */
  fileName: string;
  /** ドキュメントID */
  documentId: string;
  /** 類似度スコア (0-1) */
  score: number;
}

/**
 * プロンプト生成オプション
 */
export interface PromptOptions {
  /** 検索結果のコンテキストドキュメント */
  documents: ContextDocument[];
  /** ユーザーの質問 */
  query: string;
  /** 思考プロセス表示を有効にするか (default: false) */
  enableThinking?: boolean;
}

/**
 * 生成されたプロンプトペア
 */
export interface PromptPair {
  /** System Prompt（Bedrock APIのsystemパラメータ） */
  systemPrompt: string;
  /** User Prompt（messagesに渡す） */
  userPrompt: string;
}

/**
 * 引用追跡対応 System Prompt
 * インデックス番号付きの出典形式を指定
 *
 * 【変更点】
 * 無理やり<br>を入れさせるのではなく、Markdownのリスト（箇条書き）形式での出力を強制します。
 * これにより、どのようなMarkdownビューワーでも確実に改行されて表示されます。
 */
export const SYSTEM_PROMPT_RAG_CITATIONS = `You are a helpful AI assistant for Myelin Base, a document management and RAG platform.

<role>
You help users find information from their documents with proper source citations.
</role>

<rules>
1. Base answers ONLY on the provided content within the <documents> XML tags.
2. ALWAYS cite sources using format: [出典index: filename]
   Example: [出典1: manual.pdf]
3. Use the "index" attribute specified in the <document> tag.
4. If no relevant information exists, state:
   "この質問に関連する情報はアップロードされたドキュメントには見つかりませんでした。"
5. NEVER fabricate information
6. Use Markdown formatting to improve readability:
   - Use headers (###) for sections.
   - Use bold (**text**) for important terms.
   - Use lists (-) for itemized information.
7. CITATION FORMATTING (CRITICAL):
   - Do NOT put citations inline with the text.
   - List ALL citations at the very end of your answer using bullet points.
   - Format:
     - [出典1: document.pdf]
     - [出典2: manual.pdf]
</rules>

<output>
- ALWAYS respond in Japanese (日本語で回答)
- Citations must be a bulleted list at the end
- Use markdown formatting when appropriate
</output>`;

/**
 * 思考プロセス表示対応 System Prompt
 */
export const SYSTEM_PROMPT_RAG_THINKING = `You are a helpful AI assistant for Myelin Base, a document management and RAG platform.

<role>
You analyze documents methodically and provide well-reasoned answers.
</role>

<rules>
1. First, analyze the context in <thinking> tags
2. Identify which documents contain relevant information
3. Provide your final answer in <answer> tags
4. If no relevant information exists, state this in <answer>
5. NEVER fabricate information
6. Use Markdown formatting in <answer>:
   - Use headers (###) for sections.
   - Use bold (**text**) for important terms.
   - Use lists (-) for itemized information.
7. CITATIONS IN <answer>:
   - List citations at the bottom of the <answer> block.
   - Use bullet points (-) for each citation.
   - Format: [出典index: filename]
</rules>

<format>
<thinking>
[Analysis: which documents are relevant and why]
</thinking>

<answer>
[Final answer in Japanese]

### 参照元
- [出典1: file.pdf]
- [出典2: another_file.pdf]
</answer>
</format>

<output>
- <thinking> can be in English or Japanese
- <answer> MUST be in Japanese (日本語)
</output>`;

/**
 * ドキュメントをXML形式にフォーマット
 */
function formatDocumentsXml(documents: ContextDocument[]): string {
  if (documents.length === 0) {
    return `<documents>
  <empty>No documents available.</empty>
</documents>`;
  }

  const docs = documents
    .map(
      (
        doc,
        i
      ) => `  <document index="${i + 1}" source="${escapeXml(doc.fileName)}" score="${doc.score.toFixed(2)}">
${escapeXml(doc.text)}
  </document>`
    )
    .join("\n");

  return `<documents>
${docs}
</documents>`;
}

/**
 * 引用追跡対応User Prompt生成
 */
function buildCitationsUserPrompt(
  documents: ContextDocument[],
  query: string
): string {
  return `${formatDocumentsXml(documents)}

<question>
${query}
</question>

Answer in Japanese. List citations as bullet points at the end.`;
}

/**
 * 思考プロセス対応User Prompt生成（Prefillパターン）
 */
function buildThinkingUserPrompt(
  documents: ContextDocument[],
  query: string
): string {
  return `${formatDocumentsXml(documents)}

<question>
${query}
</question>

Analyze and answer using <thinking> and <answer> format.

<thinking>`;
}

/**
 * RAGプロンプトを生成
 */
export function buildRAGPrompt(options: PromptOptions): PromptPair {
  const { documents, query, enableThinking = false } = options;

  // System Prompt選択（thinking優先）
  let systemPrompt: string;
  let userPrompt: string;

  if (enableThinking) {
    systemPrompt = SYSTEM_PROMPT_RAG_THINKING;
    userPrompt = buildThinkingUserPrompt(documents, query);
  } else {
    systemPrompt = SYSTEM_PROMPT_RAG_CITATIONS;
    userPrompt = buildCitationsUserPrompt(documents, query);
  }

  return { systemPrompt, userPrompt };
}

/**
 * <thinking>/<answer>レスポンスをパース
 */
export function parseThinkingResponse(response: string): {
  thinking: string | null;
  answer: string;
} {
  const thinkingMatch = response.match(/<thinking>([\s\S]*?)<\/thinking>/);
  const answerMatch = response.match(/<answer>([\s\S]*?)<\/answer>/);

  return {
    thinking: thinkingMatch ? thinkingMatch[1].trim() : null,
    answer: answerMatch ? answerMatch[1].trim() : response.trim(),
  };
}

/**
 * ストリーミング中の<answer>部分を抽出
 */
export function extractAnswerFromStream(fullText: string): string {
  const answerStart = fullText.indexOf("<answer>");
  if (answerStart === -1) return "";

  const contentStart = answerStart + "<answer>".length;
  const answerEnd = fullText.indexOf("</answer>", contentStart);

  return answerEnd === -1
    ? fullText.substring(contentStart)
    : fullText.substring(contentStart, answerEnd);
}

/**
 * 引用情報の解析結果
 */
export interface CitationReference {
  index?: number; // ドキュメントのインデックス番号 (1-based)
  text: string; // ファイル名などのテキスト部分
}

/**
 * テキストから引用情報を抽出する
 * 対応フォーマット:
 * - [出典1: filename.pdf] (新形式・推奨)
 * - [出典: 1. filename.pdf] (旧形式・フォールバック)
 * - [出典: filename.pdf] (インデックスなし・フォールバック)
 */
export function extractCitedReferences(text: string): CitationReference[] {
  const references: CitationReference[] = [];
  // 正規表現: [出典(数字?): ... ] を検索
  // match[1]: インデックス番号 (あれば)
  // match[2]: コンテンツ部分
  const regex = /\[出典(\d*):\s*([^\]]+)\]/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const tagIndex = match[1] ? parseInt(match[1], 10) : undefined;
    const content = match[2];

    if (content) {
      // カンマ、読点、全角カンマで分割
      const parts = content.split(/[,、，]/).map((p) => p.trim());

      for (const part of parts) {
        if (!part) continue;

        if (tagIndex !== undefined) {
          // タグ自体にインデックスがある場合 ([出典1: ...])
          references.push({
            index: tagIndex,
            text: part,
          });
        } else {
          // タグにインデックスがない場合 ([出典: ...]) -> コンテンツ内を解析
          // "1. filename" のような形式を解析
          // 先頭の数字 + ドットまたは空白 を探す
          const indexMatch = part.match(/^(\d+)[.\s]+(.*)/);

          if (indexMatch) {
            references.push({
              index: parseInt(indexMatch[1], 10),
              text: indexMatch[2].trim(),
            });
          } else {
            // 数字がない場合はテキスト全体をファイル名として扱う
            references.push({
              text: part,
            });
          }
        }
      }
    }
  }

  return references;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
