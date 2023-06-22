import { fetch } from "cross-fetch";
import { type Result, Ok, Err } from "../types";
import {
  ErrorSchema,
  type ErrorResponse,
  StepsSchema,
  type StepsResponse,
  BatchSchema,
  type BatchResponse,
} from "./schema";

interface InngestAPIConstructorOpts {
  baseUrl?: string;
  signingKey: string;
}

export class InngestAPI {
  public readonly baseUrl: string;
  private signingKey: string;

  constructor({
    baseUrl = "https://api.inngest.com",
    signingKey,
  }: InngestAPIConstructorOpts) {
    this.baseUrl = baseUrl;
    this.signingKey = signingKey;
  }

  async getRunSteps(
    runId: string
  ): Promise<Result<StepsResponse, ErrorResponse>> {
    const url = `${this.baseUrl}/v0/runs/${runId}/actions`;

    return fetch(url, {
      headers: { Authorization: `Bearer ${this.signingKey}` },
    }).then(async (resp) => {
      const data: unknown = await resp.json();

      if (resp.ok) {
        return Ok(StepsSchema.parse(data));
      } else {
        return Err(ErrorSchema.parse(data));
      }
    });
  }

  async getRunBatch(
    runId: string
  ): Promise<Result<BatchResponse, ErrorResponse>> {
    const url = `${this.baseUrl}/v0/runs/${runId}/batch`;

    return fetch(url, {
      headers: { Authorization: `Bearer ${this.signingKey}` },
    }).then(async (resp) => {
      const data: unknown = await resp.json();

      if (resp.ok) {
        return Ok(BatchSchema.parse(data));
      } else {
        return Err(ErrorSchema.parse(data));
      }
    });
  }
}
