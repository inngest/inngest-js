/**
 * The checks for every package besides `inngest`. Those that only need
 * installed dependencies start from `base`; those that import built packages
 * start from `build`.
 *
 * @module
 */

import { $ } from "@inngest/ci";

import { ci } from "../client.ts";
import { source } from "./base.ts";

export const audit = ci.job({ id: "audit", from: source }, async () => {
  await $`pnpm audit --audit-level=critical --prod --no-optional --ignore-registry-errors`;
});

export const eslintPlugin = ci.job(
  { id: "eslint-plugin", from: source },
  async () => {
    await $`pnpm --filter @inngest/eslint-plugin test`;
  },
);

export const middlewareEncryption = ci.job(
  { id: "middleware-encryption", from: source },
  async () => {
    await $`pnpm --filter @inngest/middleware-encryption test`;
  },
);

export const middlewareValidation = ci.job(
  { id: "middleware-validation", from: source },
  async () => {
    await $`pnpm --filter @inngest/middleware-validation test`;
  },
);

export const realtime = ci.job({ id: "realtime", from: source }, async () => {
  await $`pnpm --filter @inngest/realtime test`;
});

export const testPackage = ci.job(
  { id: "test-package", from: source },
  async () => {
    await $`pnpm --filter @inngest/test test`;
  },
);

export const middlewareSentry = ci.job(
  { id: "middleware-sentry", from: source },
  async () => {
    await $`pnpm --filter @inngest/middleware-sentry run test:integration`;
  },
);

export const otel = ci.job({ id: "otel", from: source }, async () => {
  await $`pnpm --filter @inngest/otel run type-check`;

  await $`pnpm --filter @inngest/otel run lint`;

  await $`pnpm --filter @inngest/otel run format:check`;

  await $`pnpm --filter @inngest/otel run test`;

  await $`pnpm --filter @inngest/otel run build`;
});

export const ciPackage = ci.job(
  { id: "ci-package", from: source },
  async () => {
    await $`pnpm --filter @inngest/ci run type-check`;

    await $`pnpm --filter @inngest/ci run lint`;

    await $`pnpm --filter @inngest/ci run format:check`;

    await $`pnpm --filter @inngest/ci run test`;

    await $`pnpm --filter @inngest/ci run build`;
  },
);
