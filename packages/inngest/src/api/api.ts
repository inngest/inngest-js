import { type fetch } from "cross-fetch";
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

export namespace InngestApi {
  export interface Options {
    baseUrl?: string;
    signingKey: string;
    signingKeyFallback: string | undefined;
    fetch: FetchT;
    mode: Mode;
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
}
