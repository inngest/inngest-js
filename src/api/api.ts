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
  eventKey: string;
}

export class InngestAPI {
  public readonly baseUrl: string;
  private eventKey: string;

  constructor({
    baseUrl = "https://api.inngest.com",
    eventKey,
  }: InngestAPIConstructorOpts) {
    this.baseUrl = baseUrl;
    this.eventKey = eventKey;
  }

  async getRunSteps(
    runId: string
  ): Promise<Result<StepsResponse, ErrorResponse>> {
    const url = `${this.baseUrl}/v0/runs/${runId}/actions`;

    return fetch(url, {
      headers: { Authorization: `Bearer ${this.eventKey}` },
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
      headers: { Authorization: `Bearer ${this.eventKey}` },
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
