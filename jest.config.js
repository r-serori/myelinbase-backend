export const preset = "ts-jest";
export const testEnvironment = "node";
export const testMatch = ["**/*.test.ts"];
export const transform = {
  "^.+\\.tsx?$": "ts-jest",
};
// メモリ使用量を削減するため、ワーカー数を制限
export const maxWorkers = "50%";
// ワーカーのアイドル時のメモリ制限を設定（MB）
export const workerIdleMemoryLimit = "512MB";