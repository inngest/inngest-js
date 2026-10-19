/**
 * The pull request checks for inngest-js: every check runs on a machine that
 * starts from a cached image, and every job reports its own result.
 *
 * @module
 */

import { github } from "@inngest/ci";

import { ci } from "../client.ts";
import { examples } from "../jobs/examples.ts";
import {
  composite,
  deps,
  dist,
  health,
  integration,
  lint,
  runtime,
  types,
} from "../jobs/inngest.ts";
import {
  audit,
  ciPackage,
  eslintPlugin,
  middlewareEncryption,
  middlewareSentry,
  middlewareValidation,
  otel,
  realtime,
  testPackage,
} from "../jobs/packages.ts";

export const pr = ci.pipeline(
  {
    id: "pr",
    on: github.pullRequest(),
    singleton: { key: "event.data.pull_request.number", mode: "cancel" },
  },
  async () => {
    const results = await Promise.allSettled([
      audit(),
      lint(),
      runtime(),
      types(),
      dist(),
      deps(),
      integration(),
      health(),
      composite(),
      eslintPlugin(),
      middlewareEncryption(),
      middlewareValidation(),
      middlewareSentry(),
      realtime(),
      testPackage(),
      otel(),
      ciPackage(),
      examples(),
    ]);

    const reasons = results.flatMap((result) => {
      return result.status === "rejected" ? [result.reason] : [];
    });

    if (reasons.length > 0) {
      throw new AggregateError(reasons, `${reasons.length} jobs failed`);
    }
  },
);
