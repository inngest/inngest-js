import { CiNotSupportedError } from "./errors.ts";
import { requireJobScope } from "./scope.ts";
import type { Command, Duration } from "./types.ts";
import { warnOnce } from "./util.ts";

/**
 * @deprecated Not yet supported by Inngest Sandboxes: there's no interactive
 * exec, so a machine can't be attached to. Throws `CiNotSupportedError`.
 *
 * Open a shell on a run's machine.
 */
export const shell = (
  _runId: string,
  _opts?: { at?: string },
): Promise<never> => {
  throw new CiNotSupportedError(
    "shell",
    "Interactive exec isn't supported by Inngest Sandboxes yet, so `shell()` can't attach to a machine. Use `keepOnFailure` and inspect the snapshot instead.",
  );
};

export interface ShardOptions {
  total: number;
  /**
   * How to split the work. `"count"` splits evenly.
   *
   * @deprecated `by: "timing"` is not yet supported: there's no timing history
   * to split on. It falls back to `"count"` with a warning.
   */
  by?: "count" | "timing";
}

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Split a list of files across shards and run one of them.
 *
 * `by: "count"` works. `by: "timing"` needs run history the platform doesn't
 * expose yet, and falls back to `"count"`.
 */
export const shard = async <T>(
  opts: ShardOptions & { index: number; files: string[] },
  run: (files: string[]) => Promise<T>,
): Promise<T> => {
  const scope = requireJobScope("shard");

  if (opts.by === "timing") {
    warnOnce(
      scope.run.ci.logger,
      "ci:shard.timing",
      '`shard({ by: "timing" })` fell back to `by: "count"`: there\'s no timing history to split on yet.',
    );
  }

  const shardFiles = opts.files.filter(
    (_file, index) => index % opts.total === opts.index,
  );

  return run(shardFiles);
};

/**
 * @deprecated Not yet supported by Inngest Sandboxes: there's no OIDC issuer.
 * Throws `CiNotSupportedError`.
 */
export const oidc = {
  aws: (_opts: { role: string }): Promise<never> => {
    throw new CiNotSupportedError(
      "oidc.aws",
      "There's no OIDC issuer yet, so `oidc.aws()` can't mint credentials. Pass a secret with `withSecret()` for now.",
    );
  },
  gcp: (_opts: {
    workloadIdentityProvider: string;
    serviceAccount?: string;
  }): Promise<never> => {
    throw new CiNotSupportedError(
      "oidc.gcp",
      "There's no OIDC issuer yet, so `oidc.gcp()` can't mint credentials. Pass a secret with `withSecret()` for now.",
    );
  },
};

/**
 * @deprecated Out of scope for this prototype. Throws `CiNotSupportedError`.
 */
export const vercel = {
  waitForDeployment: (_opts: {
    sha?: string;
    timeout?: Duration;
  }): Promise<never> => {
    throw new CiNotSupportedError(
      "vercel.waitForDeployment",
      '`vercel.waitForDeployment()` isn\'t part of this prototype. Use `github.waitForChecks({ names: ["vercel"] })`.',
    );
  },
};

/**
 * The extra command methods the docs describe but the prototype can't do yet.
 * They're attached to commands so the shape is right in an editor.
 */
export interface UnsupportedCommandMethods {
  /**
   * @deprecated Not yet implemented: there's no JUnit parser. Throws
   * `CiNotSupportedError`.
   */
  junit(path: string): Command;
  /**
   * @deprecated Not yet implemented: rerunning only failed tests needs the
   * JUnit parser. Throws `CiNotSupportedError`.
   */
  retryFailed(count: number): Command;
}

export const unsupportedCommandMethods: UnsupportedCommandMethods = {
  junit: () => {
    throw new CiNotSupportedError(
      "Command.junit",
      "`$.junit()` isn't implemented in this prototype: there's no JUnit parser. Read the file with a command and call `report.annotate()`.",
    );
  },
  retryFailed: () => {
    throw new CiNotSupportedError(
      "Command.retryFailed",
      "`$.retryFailed()` isn't implemented in this prototype: it needs the JUnit parser. Use `.retries(n)` to rerun the whole command.",
    );
  },
};

/**
 * @deprecated Not yet supported: rerunning a pipeline from the job that failed
 * needs REST API support for rerun-from-step. Throws `CiNotSupportedError`
 * when set.
 */
export const rerunFromFailedJob = (): never => {
  throw new CiNotSupportedError(
    "rerunFromFailedJob",
    "Rerunning from the failed job needs rerun-from-step support in the Inngest REST API. The whole pipeline is rerun instead.",
  );
};
