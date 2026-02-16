import type { fetch } from "cross-fetch";
import { z } from "zod/v3";
import type { ExecutionVersion } from "../helpers/consts.ts";
import type { Mode } from "../helpers/env.ts";
import { getErrorMessage } from "../helpers/errors.ts";
import { fetchWithAuthFallback } from "../helpers/net.ts";
import { hashSigningKey } from "../helpers/strings.ts";
import { resolveApiBaseUrl } from "../helpers/url.ts";
import {
  type APIStepPayload,
  err,
  type MetadataTarget,
  type OutgoingOp,
  ok,
  type Result,
} from "../types.ts";
import {
  type BatchResponse,
  batchSchema,
  type ErrorResponse,
  errorSchema,
  type StepsResponse,
  stepsSchemas,
} from "./schema.ts";

type FetchT = typeof fetch;

const realtimeSubscriptionTokenSchema = z.object({
  jwt: z.string(),
});

const sendSignalSuccessResponseSchema = z.object({
  data: z.object({
    run_id: z.string().min(1),
  }),
});

const checkpointNewRunResponseSchema = z.object({
  data: z.object({
    fn_id: z.string().min(1),
    app_id: z.string().min(1),
    run_id: z.string().min(1),
    token: z.string().min(1).optional(),
  }),
});

export namespace InngestApi {
  export interface Options {
    baseUrl?: string;
    signingKey: string;
    signingKeyFallback: string | undefined;
    fetch: FetchT;
    mode: Mode;
  }

  export interface Subscription {
    topics: string[];
    channel: string;
  }

  export interface PublishOptions extends Subscription {
    runId?: string;
  }

  export interface SendSignalOptions {
    signal: string;
    data?: unknown;
  }

  export interface SendSignalResponse {
    /**
     * The ID of the run that was signaled.
     *
     * If this is undefined, the signal could not be matched to a run.
     */
    runId: string | undefined;
  }
}

export class InngestApi {
  public apiBaseUrl?: string;
  private signingKey: string;
  private signingKeyFallback: string | undefined;
  private readonly fetch: FetchT;
  private mode: Mode;

  constructor({
    baseUrl,
    signingKey,
    signingKeyFallback,
    fetch,
    mode,
  }: InngestApi.Options) {
    this.apiBaseUrl = baseUrl;
    this.signingKey = signingKey;
    this.signingKeyFallback = signingKeyFallback;
    this.fetch = fetch;
    this.mode = mode;
  }

  private get hashedKey(): string {
    return hashSigningKey(this.signingKey);
  }

  private get hashedFallbackKey(): string | undefined {
    if (!this.signingKeyFallback) {
      return;
    }

    return hashSigningKey(this.signingKeyFallback);
  }

  // set the signing key in case it was not instantiated previously
  setSigningKey(key: string | undefined) {
    if (typeof key === "string" && this.signingKey === "") {
      this.signingKey = key;
    }
  }

  setSigningKeyFallback(key: string | undefined) {
    if (typeof key === "string" && !this.signingKeyFallback) {
      this.signingKeyFallback = key;
    }
  }

  private async getTargetUrl(path: string): Promise<URL> {
    const baseUrl = await resolveApiBaseUrl({
      apiBaseUrl: this.apiBaseUrl,
      mode: this.mode,
      fetch: this.fetch,
    });

    return new URL(path, baseUrl);
  }

  private async req(
    url: string | URL,
    options?: RequestInit,
  ): Promise<Result<Response, unknown>> {
    const finalUrl: URL =
      typeof url === "string" ? await this.getTargetUrl(url) : url;

    try {
      const res = await fetchWithAuthFallback({
        authToken: this.hashedKey,
        authTokenFallback: this.hashedFallbackKey,
        fetch: this.fetch,
        url: finalUrl,
        options: {
          ...options,
          headers: {
            "Content-Type": "application/json",
            ...options?.headers,
          },
        },
      });

      return ok(res);
    } catch (error) {
      return err(error);
    }
  }

  async getRunSteps(
    runId: string,
    version: ExecutionVersion,
  ): Promise<Result<StepsResponse, ErrorResponse>> {
    const result = await this.req(`/v0/runs/${runId}/actions`);
    if (result.ok) {
      const res = result.value;
      const data: unknown = await res.json();

      if (res.ok) {
        return ok(stepsSchemas[version].parse(data));
      }

      return err(errorSchema.parse(data));
    }

    return err({
      error: getErrorMessage(
        result.error,
        "Unknown error retrieving step data",
      ),
      status: 500,
    });
  }

  async getRunBatch(
    runId: string,
  ): Promise<Result<BatchResponse, ErrorResponse>> {
    const result = await this.req(`/v0/runs/${runId}/batch`);
    if (result.ok) {
      const res = result.value;
      const data: unknown = await res.json();

      if (res.ok) {
        return ok(batchSchema.parse(data));
      }

      return err(errorSchema.parse(data));
    }

    return err({
      error: getErrorMessage(
        result.error,
        "Unknown error retrieving event batch",
      ),
      status: 500,
    });
  }

  async publish(
    publishOptions: InngestApi.PublishOptions,
    // biome-ignore lint/suspicious/noExplicitAny: anything is acceptable
    data: any,
  ): Promise<Result<void, ErrorResponse>> {
    // todo it may not be a "text/stream"
    const isStream = data instanceof ReadableStream;

    const url = await this.getTargetUrl("/v1/realtime/publish");
    url.searchParams.set("channel", publishOptions.channel || "");
    if (publishOptions.runId) {
      url.searchParams.set("run_id", publishOptions.runId);
    }
    for (const topic of publishOptions.topics) {
      url.searchParams.append("topic", topic);
    }

    const result = await this.req(url, {
      body: isStream
        ? data
        : typeof data === "string"
          ? data
          : JSON.stringify(data),
      method: "POST",
      headers: {
        "Content-Type": isStream ? "text/stream" : "application/json",
      },
      ...(isStream ? { duplex: "half" } : {}),
    });
    if (result.ok) {
      const res = result.value;
      if (!res.ok) {
        throw new Error(
          `Failed to publish event: ${res.status} ${res.statusText}`,
        );
      }

      return ok<void>(undefined);
    }

    return err({
      error: getErrorMessage(result.error, "Unknown error publishing event"),
      status: 500,
    });
  }

  async sendSignal(
    signalOptions: InngestApi.SendSignalOptions,
    options?: {
      headers?: Record<string, string>;
    },
  ): Promise<Result<InngestApi.SendSignalResponse, ErrorResponse>> {
    const url = await this.getTargetUrl("/v1/signals");

    const body = {
      signal: signalOptions.signal,
      data: signalOptions.data,
    };

    return fetchWithAuthFallback({
      authToken: this.hashedKey,
      authTokenFallback: this.hashedFallbackKey,
      fetch: this.fetch,
      url,
      options: {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "Content-Type": "application/json",
          ...options?.headers,
        },
      },
    })
      .then(async (res) => {
        // A 404 is valid if the signal was not found.
        if (res.status === 404) {
          return ok<InngestApi.SendSignalResponse>({
            runId: undefined,
          });
        }

        // Save a clone of the response we can use to get the text of if we fail
        // to parse the JSON.
        const resClone = res.clone();

        // JSON!
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          // res.json() failed so not a valid JSON response
          return err({
            error: `Failed to send signal: ${res.status} ${
              res.statusText
            } - ${await resClone.text()}`,
            status: res.status,
          });
        }

        // If we're not 2xx, something went wrong.
        if (!res.ok) {
          try {
            return err(errorSchema.parse(json));
          } catch {
            // schema parse failed
            return err({
              error: `Failed to send signal: ${res.status} ${
                res.statusText
              } - ${await res.text()}`,
              status: res.status,
            });
          }
        }

        // If we are 2xx, we should have a run_id.
        const parseRes = sendSignalSuccessResponseSchema.safeParse(json);
        if (!parseRes.success) {
          return err({
            error: `Successfully sent signal, but response parsing failed: ${
              res.status
            } ${res.statusText} - ${await resClone.text()}`,
            status: res.status,
          });
        }

        return ok({
          runId: parseRes.data.data.run_id,
        });
      })
      .catch((error) => {
        // Catch-all if various things go wrong
        return err({
          error: getErrorMessage(error, "Unknown error sending signal"),
          status: 500,
        });
      });
  }

  async getSubscriptionToken(
    channel: string,
    topics: string[],
  ): Promise<string> {
    const url = await this.getTargetUrl("/v1/realtime/token");

    const body = topics.map((topic) => ({
      channel,
      name: topic,
      kind: "run",
    }));

    return fetchWithAuthFallback({
      authToken: this.hashedKey,
      authTokenFallback: this.hashedFallbackKey,
      fetch: this.fetch,
      url,
      options: {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "Content-Type": "application/json",
        },
      },
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(
            `Failed to get subscription token: ${res.status} ${
              res.statusText
            } - ${await res.text()}`,
          );
        }

        const data = realtimeSubscriptionTokenSchema.parse(await res.json());

        return data.jwt;
      })
      .catch((error) => {
        throw new Error(
          getErrorMessage(error, "Unknown error getting subscription token"),
        );
      });
  }

  async updateMetadata(
    args: {
      target: MetadataTarget;
      metadata: Array<{
        kind: string;
        op: string;
        values: Record<string, unknown>;
      }>;
    },
    options?: {
      headers?: Record<string, string>;
    },
  ): Promise<Result<void, ErrorResponse>> {
    const payload = { target: args.target, metadata: args.metadata };

    const result = await this.req(`/v1/runs/${args.target.run_id}/metadata`, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: options?.headers,
    });

    if (!result.ok) {
      return err({
        error: getErrorMessage(result.error, "Unknown error updating metadata"),
        status: 500,
      });
    }

    const res = result.value;
    if (res.ok) {
      return ok<void>(undefined);
    }

    const resClone = res.clone();

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return err({
        error: `Failed to update metadata: ${res.status} ${
          res.statusText
        } - ${await resClone.text()}`,
        status: res.status,
      });
    }

    try {
      return err(errorSchema.parse(json));
    } catch {
      return err({
        error: `Failed to update metadata: ${res.status} ${res.statusText}`,
        status: res.status,
      });
    }
  }

  /**
   * Start a new run, optionally passing in a number of steps to initialize the
   * run with.
   */
  async checkpointNewRun(args: {
    runId: string;
    event: APIStepPayload;
    executionVersion: ExecutionVersion;
    retries: number;
    steps?: OutgoingOp[];
  }): Promise<z.output<typeof checkpointNewRunResponseSchema>> {
    const body = JSON.stringify({
      run_id: args.runId,
      event: args.event,
      steps: args.steps,
      ts: new Date().valueOf(),
      request_version: args.executionVersion,
      retries: args.retries,
    });

    const result = await this.req("/v1/checkpoint", {
      method: "POST",
      body,
    });

    if (!result.ok) {
      throw new Error(
        getErrorMessage(result.error, "Unknown error checkpointing new run"),
      );
    }

    const res = result.value;
    if (res.ok) {
      const rawData: unknown = await res.json();
      const data = checkpointNewRunResponseSchema.parse(rawData);

      return data;
    }

    throw new Error(
      `Failed to checkpoint new run: ${res.status} ${
        res.statusText
      } - ${await res.text()}`,
    );
  }

  /**
   * Checkpoint steps for a given sync run.
   */
  async checkpointSteps(args: {
    runId: string;
    fnId: string;
    appId: string;
    steps: OutgoingOp[];
  }): Promise<void> {
    const body = JSON.stringify({
      fn_id: args.fnId,
      app_id: args.appId,
      run_id: args.runId,
      steps: args.steps,
      ts: new Date().valueOf(),
    });

    const result = await this.req(`/v1/checkpoint/${args.runId}/steps`, {
      method: "POST",
      body,
    });

    if (!result.ok) {
      throw new Error(
        getErrorMessage(result.error, "Unknown error checkpointing steps"),
      );
    }

    const res = result.value;
    if (!res.ok) {
      throw new Error(
        `Failed to checkpoint steps: ${res.status} ${
          res.statusText
        } - ${await res.text()}`,
      );
    }
  }

  /**
   * Checkpoint steps for a given async run.
   */
  async checkpointStepsAsync(args: {
    runId: string;
    fnId: string;
    queueItemId: string;
    steps: OutgoingOp[];
  }): Promise<void> {
    const body = JSON.stringify({
      run_id: args.runId,
      fn_id: args.fnId,
      qi_id: args.queueItemId,
      steps: args.steps,
      ts: new Date().valueOf(),
    });

    const result = await this.req(`/v1/checkpoint/${args.runId}/async`, {
      method: "POST",
      body,
    });

    if (!result.ok) {
      throw new Error(
        getErrorMessage(result.error, "Unknown error checkpointing async"),
      );
    }

    const res = result.value;
    if (!res.ok) {
      throw new Error(
        `Failed to checkpoint async: ${res.status} ${
          res.statusText
        } - ${await res.text()}`,
      );
    }
  }

  /**
   * Fetch the output of a completed run using a token.
   *
   * This uses token-based auth (not signing key) and is intended for use by
   * proxy endpoints that fetch results on behalf of users.
   *
   * @param runId - The ID of the run to fetch output for
   * @param token - The token used to authenticate the request
   * @returns The raw Response from the API
   */
  async getRunOutput(runId: string, token: string): Promise<Response> {
    const url = await this.getTargetUrl(`/v1/http/runs/${runId}/output`);
    url.searchParams.set("token", token);

    return this.fetch(url.toString(), {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
  }
}
