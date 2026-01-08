import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import * as fs from "fs";
import * as path from "path";
import * as YAML from "yaml";

/**
 * OpenAPI生成スクリプト
 *
 * ✅ Source of Truth は `src/shared/schemas/registry.ts`
 * - schemas / paths / securitySchemes などの定義は registry 側に集約する
 * - ここでは「registryからOpenAPIドキュメントを生成してYAMLとして書き出す」だけを行う
 */
import { registry } from "../src/shared/schemas/registry";

// =================================================================
// Generation
// =================================================================

const generator = new OpenApiGeneratorV3(registry.definitions);

const document = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "Myelin Base RAG API",
    version: "1.0.0",
    description: "API documentation for Myelin Base RAG backend",
  },
  servers: [{ url: "/api" }],
});

// Output
const outputPath = path.resolve(__dirname, "../../doc/openapi.yaml");

const dir = path.dirname(outputPath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

fs.writeFileSync(outputPath, YAML.stringify(document));
console.log(`Generated OpenAPI document at: ${outputPath}`);
