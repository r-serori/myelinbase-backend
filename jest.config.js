export const preset = 'ts-jest';
export const testEnvironment = 'node';
export const testMatch = ['**/*.test.ts'];
export const transform = {
  '^.+\\.tsx?$': 'ts-jest',
};
export const moduleNameMapper = {
  '^@myelinbase-backend/shared/(.*)$': '<rootDir>/infrastructure/src/shared/$1',
};