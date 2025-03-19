import { type fetch } from "cross-fetch";
import { z } from "zod";
import { type ExecutionVersion } from "../components/execution/InngestExecution.js";
import {
  defaultDevServerHost,
  defaultInngestApiBaseUrl,
} from "../helpers/consts.js";
import { devServerAvailable } from "../helpers/devserver.js";
import { type Mode } from "../helpers/env.js";
import { getErrorMessage } from "../helpers/errors.js";
import { fetchWithAuthFallback } from "../helpers/net.js";
import { hashSigningKey } from "../helpers/strings.js";
import { err, ok, type Result } from "../types.js";
import {
  batchSchema,
  errorSchema,
  stepsSchemas,
  type BatchResponse,
  type ErrorResponse,
  type StepsResponse,
} from "./schema.js";

type FetchT = typeof fetch;

const realtimeSubscriptionTokenSchema = z.object({
  jwt: z.string(),
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
    if (this.apiBaseUrl) {
      return new URL(path, this.apiBaseUrl);
    }

    let url = new URL(path, defaultInngestApiBaseUrl);

    if (this.mode.isDev && this.mode.isInferred && !this.apiBaseUrl) {
      const devAvailable = await devServerAvailable(
        defaultDevServerHost,
        this.fetch
      );

      if (devAvailable) {
        url = new URL(path, defaultDevServerHost);
      }
    }

    return url;
  }

  async getRunSteps(
    runId: string,
    version: ExecutionVersion
  ): Promise<Result<StepsResponse, ErrorResponse>> {
    return fetchWithAuthFallback({
      authToken: this.hashedKey,
      authTokenFallback: this.hashedFallbackKey,
      fetch: this.fetch,
      url: await this.getTargetUrl(`/v0/runs/${runId}/actions`),
    })
      .then(async (resp) => {
        const data: unknown = await resp.json();

        if (resp.ok) {
          return ok(stepsSchemas[version].parse(data));
        } else {
          return err(errorSchema.parse(data));
        }
      })
      .catch((error) => {
        return err({
          error: getErrorMessage(error, "Unknown error retrieving step data"),
          status: 500,
        });
      });
  }

  async getRunBatch(
    runId: string
  ): Promise<Result<BatchResponse, ErrorResponse>> {
    return fetchWithAuthFallback({
      authToken: this.hashedKey,
      authTokenFallback: this.hashedFallbackKey,
      fetch: this.fetch,
      url: await this.getTargetUrl(`/v0/runs/${runId}/batch`),
    })
      .then(async (resp) => {
        const data: unknown = await resp.json();

        if (resp.ok) {
          return ok(batchSchema.parse(data));
        } else {
          return err(errorSchema.parse(data));
        }
      })
      .catch((error) => {
        return err({
          error: getErrorMessage(error, "Unknown error retrieving event batch"),
          status: 500,
        });
      });
  }

  async publish(
    subscription: InngestApi.Subscription,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: any
  ): Promise<Result<void, ErrorResponse>> {
    // todo it may not be a "text/stream"
    const isStream = data instanceof ReadableStream;
    const url = await this.getTargetUrl("/v1/realtime/publish");

    url.searchParams.set("channel", subscription.channel || "");

    subscription.topics.forEach((topic) => {
      url.searchParams.append("topic", topic);
    });

    return fetchWithAuthFallback({
      authToken: this.hashedKey,
      authTokenFallback: this.hashedFallbackKey,
      fetch: this.fetch,
      url,
      options: {
        method: "POST",
        body: isStream
          ? data
          : typeof data === "string"
            ? data
            : JSON.stringify(data),
        headers: {
          "Content-Type": isStream ? "text/stream" : "application/json",
        },
        ...(isStream ? { duplex: "half" } : {}),
      },
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(
            `Failed to publish event: ${res.status} ${res.statusText}`
          );
        }

        return ok<void>(undefined);
      })
      .catch((error) => {
        return err({
          error: getErrorMessage(error, "Unknown error publishing event"),
          status: 500,
        });
      });
  }

  async getSubscriptionToken(
    channel: string,
    topics: string[]
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
            } - ${await res.text()}`
          );
        }

        const data = realtimeSubscriptionTokenSchema.parse(await res.json());

        return data.jwt;
      })
      .catch((error) => {
        throw new Error(
          getErrorMessage(error, "Unknown error getting subscription token")
        );
      });
  }
}
