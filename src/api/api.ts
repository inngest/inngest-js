import { fetch } from "cross-fetch";
import { type Result, ok, err } from "../types";
import { hashSigningKey } from "../helpers/strings";
import {
  ErrorSchema,
  type ErrorResponse,
  StepsSchema,
  type StepsResponse,
  BatchSchema,
  type BatchResponse,
} from "./schema";

interface InngestApiConstructorOpts {
  baseUrl?: string;
  signingKey: string;
}

export class InngestApi {
  public readonly baseUrl: string;
  private signingKey: string;

  constructor({
    baseUrl = "https://api.inngest.com",
    signingKey,
  }: InngestApiConstructorOpts) {
    this.baseUrl = baseUrl;
    this.signingKey = signingKey;
  }

  private get hashedKey(): string {
    return hashSigningKey(this.signingKey);
  }

  // set the signing key in case it was not instantiated previously
  setSigningKey(key: string | undefined) {
    if (typeof key === "string" && this.signingKey === "") {
      this.signingKey = key;
    }
  }

  async getRunSteps(
    runId: string
  ): Promise<Result<StepsResponse, ErrorResponse>> {
    const url = new URL(`/v0/runs/${runId}/actions`, this.baseUrl);

    return fetch(url, {
      headers: { Authorization: `Bearer ${this.hashedKey}` },
    })
      .then(async (resp) => {
        const data: unknown = await resp.json();

        if (resp.ok) {
          return ok(StepsSchema.parse(data));
        } else {
          return err(ErrorSchema.parse(data));
        }
      })
      .catch((error) => {
        return err({ error: error as string, status: 500 });
      });
  }

  async getRunBatch(
    runId: string
  ): Promise<Result<BatchResponse, ErrorResponse>> {
    const url = new URL(`/v0/runs/${runId}/batch`, this.baseUrl);

    return fetch(url, {
      headers: { Authorization: `Bearer ${this.hashedKey}` },
    })
      .then(async (resp) => {
        const data: unknown = await resp.json();

        if (resp.ok) {
          return ok(BatchSchema.parse(data));
        } else {
          return err(ErrorSchema.parse(data));
        }
      })
      .catch((error) => {
        return err({ error: error as string, status: 500 });
      });
  }
}
