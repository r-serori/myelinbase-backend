// src/shared/clients/bedrock.test.ts

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
  ResponseStream,
} from "@aws-sdk/client-bedrock-runtime";
import { mockClient } from "aws-sdk-client-mock";

import {
  generateEmbeddings,
  invokeClaude,
  invokeClaudeStream,
} from "./bedrock";

const bedrockMock = mockClient(BedrockRuntimeClient);

// ============================================
// Helpers
// ============================================

interface StreamChunk {
  chunk?: { bytes?: Uint8Array };
}

function createAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const item of items) {
        yield await item;
      }
    },
  };
}

function encodeStreamChunk(text: string): StreamChunk {
  return {
    chunk: {
      bytes: new TextEncoder().encode(
        JSON.stringify({ type: "content_block_delta", delta: { text } })
      ),
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function encodeResponse(body: unknown): any {
  return new TextEncoder().encode(JSON.stringify(body));
}

// ============================================
// Tests
// ============================================

describe("Bedrock Client", () => {
  beforeEach(() => {
    bedrockMock.reset();
  });

  describe("generateEmbeddings", () => {
    it("should generate embeddings for multiple texts", async () => {
      bedrockMock.on(InvokeModelCommand).resolves({
        body: encodeResponse({ embedding: [0.1, 0.2, 0.3] }),
      });

      const result = await generateEmbeddings(["text1", "text2", "text3"]);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual([0.1, 0.2, 0.3]);
      expect(bedrockMock.calls()).toHaveLength(3);
    });

    it("should batch requests correctly", async () => {
      bedrockMock.on(InvokeModelCommand).resolves({
        body: encodeResponse({ embedding: [0.5] }),
      });

      // 6 texts = 2 batches (3 + 3)
      await generateEmbeddings(["a", "b", "c", "d", "e", "f"]);

      expect(bedrockMock.calls()).toHaveLength(6);
    });

    it("should return empty array when texts list is empty", async () => {
      const result = await generateEmbeddings([]);
      expect(result).toEqual([]);
      expect(bedrockMock.calls()).toHaveLength(0);
    });

    it("should retry on throttling errors and eventually succeed", async () => {
      // 1回目: ThrottlingException, 2回目: Success
      bedrockMock
        .on(InvokeModelCommand)
        .rejectsOnce(
          Object.assign(new Error("ThrottlingException"), {
            name: "ThrottlingException",
          })
        )
        .resolves({
          body: encodeResponse({ embedding: [1, 2, 3] }),
        });

      // タイムアウトを延長（リトライの待機時間を考慮）
      const result = await generateEmbeddings(["text"]);

      expect(result).toEqual([[1, 2, 3]]);
      expect(bedrockMock.calls()).toHaveLength(2);
    }, 10000); // 10秒のタイムアウト

    it("should not retry on non-throttling errors", async () => {
      // 常に一般的なエラーを投げる
      bedrockMock.on(InvokeModelCommand).rejects(new Error("Some Error"));

      await expect(generateEmbeddings(["text"])).rejects.toThrow("Some Error");
      // リトライされず1回だけ呼ばれること
      expect(bedrockMock.calls()).toHaveLength(1);
    });
  });

  describe("invokeClaudeStream", () => {
    it("should yield text chunks from stream", async () => {
      const chunks = [
        encodeStreamChunk("Hello"),
        encodeStreamChunk(" "),
        encodeStreamChunk("World"),
      ];

      bedrockMock.on(InvokeModelWithResponseStreamCommand).resolves({
        body: createAsyncIterable(chunks) as AsyncIterable<ResponseStream>,
      });

      const result: string[] = [];
      for await (const chunk of invokeClaudeStream({ prompt: "Hi" })) {
        result.push(chunk);
      }

      expect(result).toEqual(["Hello", " ", "World"]);
    });

    it("should include system prompt in request", async () => {
      bedrockMock.on(InvokeModelWithResponseStreamCommand).resolves({
        body: createAsyncIterable([
          encodeStreamChunk("OK"),
        ]) as AsyncIterable<ResponseStream>,
      });

      const systemPrompt = "You are helpful.";
      for await (const _ of invokeClaudeStream({
        prompt: "Hello",
        systemPrompt,
        maxTokens: 1024,
      })) {
        // consume
      }

      const calls = bedrockMock.commandCalls(
        InvokeModelWithResponseStreamCommand
      );
      const body = JSON.parse(calls[0].args[0].input.body as string);

      expect(body.system).toBe(systemPrompt);
      expect(body.max_tokens).toBe(1024);
      expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);
    });

    it("should include optional parameters", async () => {
      bedrockMock.on(InvokeModelWithResponseStreamCommand).resolves({
        body: createAsyncIterable([
          encodeStreamChunk("OK"),
        ]) as AsyncIterable<ResponseStream>,
      });

      for await (const _ of invokeClaudeStream({
        prompt: "Hello",
        temperature: 0.5,
        topP: 0.9,
        stopSequences: ["</answer>"],
      })) {
        // consume
      }

      const calls = bedrockMock.commandCalls(
        InvokeModelWithResponseStreamCommand
      );
      const body = JSON.parse(calls[0].args[0].input.body as string);

      expect(body.temperature).toBe(0.5);
      expect(body.top_p).toBe(0.9);
      expect(body.stop_sequences).toEqual(["</answer>"]);
    });

    it("should use default values when not specified", async () => {
      bedrockMock.on(InvokeModelWithResponseStreamCommand).resolves({
        body: createAsyncIterable([
          encodeStreamChunk("OK"),
        ]) as AsyncIterable<ResponseStream>,
      });

      for await (const _ of invokeClaudeStream({ prompt: "Hi" })) {
        // consume
      }

      const calls = bedrockMock.commandCalls(
        InvokeModelWithResponseStreamCommand
      );
      const body = JSON.parse(calls[0].args[0].input.body as string);

      expect(body.max_tokens).toBe(2048);
      expect(body.temperature).toBe(0);
      expect(body.system).toBeUndefined();
    });
  });

  describe("invokeClaude (non-streaming)", () => {
    it("should return concatenated text from response", async () => {
      bedrockMock.on(InvokeModelCommand).resolves({
        body: encodeResponse({
          content: [
            { type: "text", text: "Hello, " },
            { type: "text", text: "World!" },
          ],
        }),
      });

      const result = await invokeClaude({ prompt: "Hi" });

      expect(result).toBe("Hello, World!");
    });

    it("should include system prompt in request", async () => {
      bedrockMock.on(InvokeModelCommand).resolves({
        body: encodeResponse({ content: [{ type: "text", text: "OK" }] }),
      });

      await invokeClaude({
        prompt: "Hello",
        systemPrompt: "Be brief.",
      });

      const calls = bedrockMock.commandCalls(InvokeModelCommand);
      const body = JSON.parse(calls[0].args[0].input.body as string);

      expect(body.system).toBe("Be brief.");
    });

    it("should return empty string for empty content", async () => {
      bedrockMock.on(InvokeModelCommand).resolves({
        body: encodeResponse({ content: [] }),
      });

      const result = await invokeClaude({ prompt: "Hi" });

      expect(result).toBe("");
    });
  });
});
