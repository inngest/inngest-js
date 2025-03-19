/** @type {import('ts-jest/dist/types').InitialOptionsTsJest} */
module.exports = {
  preset: "ts-jest",
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
};
