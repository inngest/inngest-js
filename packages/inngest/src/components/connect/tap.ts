/**
 * Live Tap: let a local Connect worker take real traffic for chosen
 * functions.
 *
 * Tap mode is switched on by environment variables (set by `inngest tap`), so
 * the user's `connect()` call is unchanged. This module owns every tap
 * decision: reading the settings, choosing which requests to take, shaping the
 * reply (NACK, shadow, sticky) and reporting what happened. Connect plugs in at
 * three places only: {@link createTap} while preparing the config, the
 * handshake (which sends {@link Tap.config}) and the same-thread strategy
 * (which binds close and calls {@link Tap.drain}).
 *
 * Matching beyond the function list is done by the server (CEL filter). A tap
 * that does not want a request replies NACKED, which makes the server route it
 * to someone else without spending a retry.
 *
 * @module
 */

import { envKeys } from "../../helpers/consts.ts";
import { getProcessEnv, type Mode } from "../../helpers/env.ts";
import { getRunUrl } from "../../helpers/url.ts";
import {
  type GatewayExecutorRequestData,
  SDKResponse,
  SDKResponseStatus,
  type TapConfig,
} from "../../proto/src/components/connect/protobuf/connect.ts";
import type { FunctionConfig } from "../../types.ts";
import { onShutdown } from "./os.ts";
import type { RequestHandler } from "./strategies/index.ts";
import {
  createReporter,
  detectOutput,
  isOn,
  type TapOutput,
} from "./tapOutput.ts";

export interface TapSettings {
  /** Function IDs or full slugs the tap wants. */
  functions: string[];
  filter?: string;
  once: boolean;
  shadow: boolean;
  sticky: boolean;
  label: string;
  output: TapOutput;
}

interface TapOptions {
  settings: TapSettings;
  mode: Mode;
  baseUrl: string;
  env?: string;

  /** Where output lines go. Defaults to stderr. */
  write?: (line: string) => void;

  /** Called on the second shutdown signal. Defaults to `process.exit`. */
  exit?: (code: number) => void;
}

type TapEvent = "taken" | "nacked" | "done" | "error";

/**
 * Read the tap settings from the environment. Returns `undefined` when tap mode
 * is off, which is the case unless `INNGEST_TAP_FUNCTIONS` is set.
 */
export const readTapSettings = (
  env: Record<string, string | undefined> = getProcessEnv(),
): TapSettings | undefined => {
  const functions = (env[envKeys.InngestTapFunctions] ?? "")
    .split(",")
    .map((fn) => {
      return fn.trim();
    })
    .filter(Boolean);

  if (functions.length === 0) {
    return undefined;
  }

  return {
    functions,
    filter: env[envKeys.InngestTapFilter] || undefined,
    once: isOn(env[envKeys.InngestTapOnce]),
    shadow: isOn(env[envKeys.InngestTapShadow]),
    sticky: isOn(env[envKeys.InngestTapSticky]),
    label: env[envKeys.InngestTapLabel] ?? "",
    output: detectOutput(env),
  };
};

/**
 * Create the tap for this process, or `undefined` when tap mode is off.
 */
export const createTap = (opts: {
  mode: Mode;
  baseUrl: string;
  env?: string;
}): Tap | undefined => {
  const settings = readTapSettings();
  if (!settings) {
    return undefined;
  }

  return new Tap({ settings, ...opts });
};

/**
 * Whether a function reply says the new code no longer has the step prod asked
 * for. That is the one signal of a changed step graph visible in the reply.
 */
const hasStepNotFound = (response: SDKResponse): boolean => {
  try {
    const ops = JSON.parse(new TextDecoder().decode(response.body));

    return (
      Array.isArray(ops) &&
      ops.some((op) => {
        return op?.op === "StepNotFound";
      })
    );
  } catch {
    return false;
  }
};

/**
 * Whether this reply finishes the run, so nothing more will be routed to us.
 */
const endsRun = (response: SDKResponse): boolean => {
  return (
    response.status === SDKResponseStatus.DONE ||
    (response.status === SDKResponseStatus.ERROR && response.noRetry)
  );
};

export class Tap {
  private readonly settings: TapSettings;

  /** Selected function slug to the requested name it satisfied. */
  private readonly selected = new Map<string, string>();
  private readonly options: TapOptions;
  private readonly reporter;
  private stopping = false;
  private onceRun: string | undefined;
  private close: (() => Promise<void>) | undefined;

  constructor(options: TapOptions) {
    this.options = options;
    this.settings = options.settings;
    this.reporter = createReporter(options.settings.output, options.write);
  }

  /** What the gateway needs to know at handshake. */
  get config(): TapConfig {
    return {
      functions: this.settings.functions,
      filter: this.settings.filter,
      once: this.settings.once,
      shadow: this.settings.shadow,
      label: this.settings.label,
    };
  }

  /**
   * Keep only the wanted functions of one app. Remembers their slugs so the
   * requests for anything else are NACKed.
   */
  select(appId: string, configs: FunctionConfig[]): FunctionConfig[] {
    return configs.filter((config) => {
      const wanted = this.settings.functions.find((fn) => {
        return config.id === fn || config.id === `${appId}-${fn}`;
      });

      if (wanted) {
        this.selected.set(config.id, wanted);
      }

      return Boolean(wanted);
    });
  }

  /** Fail early if a requested function exists in none of the apps. */
  assertAllFound(): void {
    const found = new Set(this.selected.values());

    for (const fn of this.settings.functions) {
      if (!found.has(fn)) {
        throw new Error(`Tap function "${fn}" not found in the connected apps`);
      }
    }
  }

  /** Give the tap a way to close the connection (used by `once`). */
  bind(close: () => Promise<void>): void {
    this.close = close;
    this.reporter.guide();
  }

  /**
   * Stop taking requests. Requests still running reply `sticky=false`; idle
   * sticky runs lapse by TTL on the server. A second shutdown signal drops
   * everything immediately. Calling it again does nothing.
   *
   * @returns Removes the second-signal handler.
   */
  drain(): () => void {
    if (this.stopping) {
      return () => {};
    }

    this.stopping = true;
    this.reporter.emit(
      "draining",
      "tap: draining, no new requests. Ctrl-C again to drop everything.",
    );

    return onShutdown(["SIGINT", "SIGTERM"], () => {
      this.reporter.emit(
        "dropped",
        "tap: second signal, exiting without draining",
      );

      (this.options.exit ?? process.exit)(130);
    });
  }

  /**
   * Wrap a request handler with the tap decisions.
   *
   * Shadow and mismatch replies are produced here, before the strategy buffers
   * the response, so a real result can never reach the server by the buffered
   * HTTP fallback.
   */
  wrap(handler: RequestHandler): RequestHandler {
    return async (msg) => {
      if (!this.admit(msg)) {
        this.report("nacked", msg, "not taken");

        return this.nack(msg);
      }

      let response: SDKResponse;
      try {
        response = await handler(msg);
      } catch (err) {
        this.report("error", msg, String(err));

        this.finishOnce();

        if (this.settings.shadow) {
          return this.nack(msg);
        }

        throw err;
      }

      this.finishOnce(response);

      if (this.settings.shadow) {
        this.report("done", msg, "shadow, result discarded");

        return this.nack(msg);
      }

      return this.settle(msg, response);
    };
  }

  private admit(msg: GatewayExecutorRequestData): boolean {
    if (this.stopping || !this.selected.has(msg.functionSlug)) {
      return false;
    }

    if (this.settings.once) {
      if (this.onceRun && this.onceRun !== msg.runId) {
        return false;
      }

      this.onceRun = msg.runId;
    }

    return true;
  }

  /**
   * Close after the one run `once` allows: right away, unless the run is held
   * sticky, in which case when its last reply is out. Without a response (the
   * handler threw) it closes too.
   */
  private finishOnce(response?: SDKResponse): void {
    const holding = this.settings.sticky && !this.settings.shadow;
    const finished = !response || !holding || endsRun(response);

    if (this.settings.once && finished) {
      void this.close?.();
    }
  }

  /**
   * Decide the sticky flag for a takeover reply, and refuse to stick when the
   * step graph differs from what prod recorded.
   *
   * Limits: the check only sees what the reply shows, i.e. a requested step
   * that the local code no longer has (`StepNotFound`). A step inserted or
   * reordered while the memoized ones still resolve cannot be seen. The code
   * has already run by the time this is known, so side effects of that run
   * are real.
   */
  private settle(
    msg: GatewayExecutorRequestData,
    response: SDKResponse,
  ): SDKResponse {
    if (!this.settings.sticky) {
      this.report("done", msg);

      return response;
    }

    if (hasStepNotFound(response)) {
      this.report("nacked", msg, "step graph differs from prod, not sticking");

      return this.nack(msg);
    }

    const sticky = !(this.stopping || endsRun(response));
    this.report("done", msg, sticky ? "sticky" : "released");

    return SDKResponse.create({ ...response, sticky });
  }

  private nack(msg: GatewayExecutorRequestData): SDKResponse {
    return SDKResponse.create({
      requestId: msg.requestId,
      accountId: msg.accountId,
      envId: msg.envId,
      appId: msg.appId,
      status: SDKResponseStatus.NACKED,
      runId: msg.runId,
      systemTraceCtx: msg.systemTraceCtx,
      userTraceCtx: msg.userTraceCtx,
    });
  }

  private report(
    event: TapEvent,
    msg: GatewayExecutorRequestData,
    detail?: string,
  ): void {
    const traceUrl = getRunUrl({
      runId: msg.runId,
      mode: this.options.mode,
      baseUrl: this.options.baseUrl,
      env: this.options.env,
    });
    const step = msg.stepId ? ` step=${msg.stepId}` : "";
    const note = detail ? ` (${detail})` : "";

    this.reporter.emit(
      event,
      `tap ${event} ${msg.functionSlug}${step} ${traceUrl}${note}`,
      {
        runId: msg.runId,
        fn: msg.functionSlug,
        step: msg.stepId ?? null,
        traceUrl,
        detail,
      },
    );
  }
}
