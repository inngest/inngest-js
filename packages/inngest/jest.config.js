/** @type {import('ts-jest/dist/types').JestConfigWithTsJest} */
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/**/*.test.ts", "!**/test/functions/**/*.test.ts"],
  roots: ["<rootDir>/src"],
  moduleNameMapper: {
    "(\\..+)\\.js": "$1",
    "^inngest$": "<rootDir>/src",
    "^@local$": "<rootDir>/src",
    "^@local/(.*)": "<rootDir>/src/$1",
    "^@local/(.*)\\.js": "<rootDir>/src/$1",
  },
  extensionsToTreatAsEsm: [".ts"],
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        useESM: true,
        isolatedModules: true,
      },
    ],
  },
};
