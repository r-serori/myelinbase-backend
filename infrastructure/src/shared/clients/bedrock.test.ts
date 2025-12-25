import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { mockClient } from "aws-sdk-client-mock";

import { generateEmbeddings, invokeClaudeStream } from "./bedrock";

const bedrockMock = mockClient(BedrockRuntimeClient);

describe("Bedrock Client", () => {
  beforeEach(() => {
    bedrockMock.reset();
  });

  describe("generateEmbeddings", () => {
    it("should batch requests and return embeddings", async () => {
      bedrockMock.on(InvokeModelCommand).resolves({
        body: new TextEncoder().encode(
          JSON.stringify({ embedding: [0.1, 0.2, 0.3] })
        ) as any,
      });

      const texts = ["text1", "text2", "text3", "text4", "text5", "text6"]; // 6 items (batch size 5 + 1)
      const embeddings = await generateEmbeddings(texts);

      expect(embeddings).toHaveLength(6);
      expect(embeddings[0]).toEqual([0.1, 0.2, 0.3]);

      // 6回呼ばれているはず (5件 + 1件でBatch処理されているが、内部で並列mapしているためAPIコールは個数分走る)
      // generateEmbeddingsの実装を確認すると、batch.map(...) で InvokeModelCommand を発行しているため
      // APIコールの総数はテキストの総数と同じになる。
      // batch処理の意図は、並列実行数の制限（ここではBATCH_SIZE=5）にある。
      expect(bedrockMock.calls()).toHaveLength(6);
    });
  });

  describe("invokeClaudeStream", () => {
    it("should yield text chunks from stream", async () => {
      // ストリームのチャンクを模倣
      const mockStream = {
        [Symbol.asyncIterator]: function* () {
          yield {
            chunk: {
              bytes: new TextEncoder().encode(
                JSON.stringify({
                  type: "content_block_delta",
                  delta: { text: "Hello" },
                })
              ),
            },
          };
          yield {
            chunk: {
              bytes: new TextEncoder().encode(
                JSON.stringify({
                  type: "content_block_delta",
                  delta: { text: " World" },
                })
              ),
            },
          };
        },
      };

      bedrockMock.on(InvokeModelWithResponseStreamCommand).resolves({
        body: mockStream as any,
      });

      const chunks: string[] = [];
      for await (const chunk of invokeClaudeStream("prompt")) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual(["Hello", " World"]);
    });
  });
});
