import { type fetch } from "cross-fetch";
import { type ExecutionVersion } from "../components/execution/InngestExecution";
import { getFetch } from "../helpers/env";
import { getErrorMessage } from "../helpers/errors";
import { hashSigningKey } from "../helpers/strings";
import { err, ok, type Result } from "../types";
import {
  batchSchema,
  errorSchema,
  stepsSchemas,
  type BatchResponse,
  type ErrorResponse,
  type StepsResponse,
} from "./schema";
import { fetchWithAuthFallback } from "inngest/helpers/net";

type FetchT = typeof fetch;

interface InngestApiConstructorOpts {
  baseUrl?: string;
  signingKey: string;
  signingKeyFallback: string | undefined;
  fetch?: FetchT;
}

export class InngestApi {
  public readonly baseUrl: string;
  private signingKey: string;
  private signingKeyFallback: string | undefined;
  private readonly fetch: FetchT;

  constructor({
    baseUrl = "https://api.inngest.com",
    signingKey,
    signingKeyFallback,
    fetch,
  }: InngestApiConstructorOpts) {
    this.baseUrl = baseUrl;
    this.signingKey = signingKey;
    this.signingKeyFallback = signingKeyFallback;
    this.fetch = getFetch(fetch);
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

  async getRunSteps(
    runId: string,
    version: ExecutionVersion
  ): Promise<Result<StepsResponse, ErrorResponse>> {
    const url = new URL(`/v0/runs/${runId}/actions`, this.baseUrl);

    return fetchWithAuthFallback({
      authToken: this.hashedKey,
      authTokenFallback: this.hashedFallbackKey,
      fetch: this.fetch,
      url,
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
    const url = new URL(`/v0/runs/${runId}/batch`, this.baseUrl);

    return fetchWithAuthFallback({
      authToken: this.hashedKey,
      authTokenFallback: this.hashedFallbackKey,
      fetch: this.fetch,
      url,
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
