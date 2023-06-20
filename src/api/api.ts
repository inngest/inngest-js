import { fetch } from "cross-fetch";

interface InngestAPIConstructorOpts {
  baseUrl?: string;
  eventKey: string;
}

type ErrorResponse = {
  error: string;
  status: number;
};

type StepsResponse = {
  step: unknown;
};

type BatchResponse = [unknown];

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

  async getRunSteps(runId: string): Promise<StepsResponse | ErrorResponse> {
    const url = `${this.baseUrl}/v0/runs/${runId}/actions`;

    return fetch(url, {
      headers: { Authorization: `Bearer ${this.eventKey}` },
    })
      .then(async (resp) => {
        if (!resp.ok) {
          const msg = await resp.text();
          throw new Error(msg);
        }

        return resp.json() as Promise<StepsResponse>;
      })
      .catch((error: Error) => {
        return JSON.parse(error.message) as ErrorResponse;
      });
  }

  async getRunBatch(runId: string): Promise<BatchResponse | ErrorResponse> {
    const url = `${this.baseUrl}/v0/runs/${runId}/batch`;

    return fetch(url, {
      headers: { Authorization: `Bearer ${this.eventKey}` },
    })
      .then(async (resp) => {
        if (!resp.ok) {
          const msg = await resp.text();
          throw new Error(msg);
        }

        return resp.json() as Promise<BatchResponse>;
      })
      .catch((error: Error) => {
        return JSON.parse(error.message) as ErrorResponse;
      });
  }
}
