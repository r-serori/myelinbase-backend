import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import unusedImports from "eslint-plugin-unused-imports";

/** @type {import('eslint').Linter.Config[]} */
export default tseslint.config(
  // 1. 基本設定 (対象ファイルとグローバル変数)
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    languageOptions: {
      globals: {
        ...globals.node, // Node.js 環境 (process, console等)
        ...globals.jest, // テスト環境 (必要に応じて)
      },
    },
  },

  // 2. 推奨ルールの適用 (JS + TS)
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  // TypeScript ファイル用の型情報付き設定
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: true, // 各ファイルに最も近い tsconfig.json を自動検出
      },
    },
  },

  // 3. Prettier との競合解決
  eslintConfigPrettier,

  // 4. カスタムルール (フロントエンドの設定を移植)
  {
    plugins: {
      "simple-import-sort": simpleImportSort,
      "unused-imports": unusedImports,
    },
    rules: {
      // --- Import Sort (フロントエンドと統一) ---
      "simple-import-sort/exports": "error",
      "simple-import-sort/imports": [
        "error",
        {
          groups: [
            // 1. Node.js built-ins, External libraries
            ["^node:", "^@?\\w"],
            // 2. Internal packages (エイリアスを使っている場合)
            // Lambdaでパスエイリアスを使っていない場合は相対パスのみになるが、入れておいて損はない
            ["^@/models/.*", "^@/services/.*", "^@/utils/.*", "^@/lib/.*"],
            // 3. Side effect imports
            ["^\\u0000"],
            // 4. Parent imports (../../)
            ["^\\.\\.(?!/?$)", "^\\.\\./?$"],
            // 5. Other relative imports (./)
            ["^\\./(?=.*/)(?!/?$)", "^\\.(?!/?$)", "^\\./?$"],
          ],
        },
      ],

      // --- Unused Imports (自動削除) ---
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],

      // --- Lambda & TS Best Practices ---

      // Lambdaでは console.log はログ出力として正当な手段なので許可する
      "no-console": "off",

      // any型の使用を警告 (厳しくするなら error)
      "@typescript-eslint/no-explicit-any": "error",

      // 非同期関数の await 忘れ防止 (重要)
      "@typescript-eslint/require-await": "error",
    },
  },

  // 5. 除外ファイル
  {
    ignores: [
      "dist/**",
      "built/**",
      ".aws-sam/**", // SAMのビルドアーティファクト
      "node_modules/**",
      "coverage/**",
      "*.config.js",
      "*.config.mjs",
    ],
  }
);
