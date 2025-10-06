import { headerKeys } from "../../helpers/consts.ts";
import {
  FlushResponse,
  SDKResponse,
} from "../../proto/src/components/connect/protobuf/connect.ts";
import type { Inngest } from "../Inngest.ts";
import { expBackoff } from "./util.ts";
import type { Logger } from "../../middleware/logger.ts";

export class MessageBuffer {
  private buffered: Record<string, SDKResponse> = {};
  private pending: Record<string, SDKResponse> = {};

  constructor(
    private inngest: Inngest.Any,
    private logger: Logger
  ) {}

  public append(response: SDKResponse) {
    this.buffered[response.requestId] = response;
    delete this.pending[response.requestId];
  }

  public addPending(response: SDKResponse, deadline: number) {
    this.pending[response.requestId] = response;
    setTimeout(() => {
      if (this.pending[response.requestId]) {
        this.logger.warn(
          "Message not acknowledged in time",
          response.requestId
        );
        this.append(response);
      }
    }, deadline);
  }

  public acknowledgePending(requestId: string) {
    delete this.pending[requestId];
  }

  private async sendFlushRequest(
    hashedSigningKey: string | undefined,
    msg: SDKResponse
  ) {
    const headers: Record<string, string> = {
      "Content-Type": "application/protobuf",
      ...(hashedSigningKey
        ? { Authorization: `Bearer ${hashedSigningKey}` }
        : {}),
    };

    if (this.inngest.env) {
      headers[headerKeys.Environment] = this.inngest.env;
    }

    const resp = await fetch(
      // refactor this to a more universal spot
      await this.inngest["inngestApi"]["getTargetUrl"]("/v0/connect/flush"),
      {
        method: "POST",
        body: new Uint8Array(SDKResponse.encode(msg).finish()),
        headers: headers,
      }
    );

    if (!resp.ok) {
      this.logger.error("Failed to flush messages", await resp.text());
      throw new Error("Failed to flush messages");
    }

    const flushResp = FlushResponse.decode(
      new Uint8Array(await resp.arrayBuffer())
    );

    return flushResp;
  }

  public async flush(hashedSigningKey: string | undefined) {
    if (Object.keys(this.buffered).length === 0) {
      return;
    }

    this.logger.info(`Flushing ${Object.keys(this.buffered).length} messages`);

    const maxAttempts = 5;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      for (const [k, v] of Object.entries(this.buffered)) {
        try {
          await this.sendFlushRequest(hashedSigningKey, v);
          delete this.buffered[k];
        } catch (err) {
          this.logger.error("Failed to flush message", k, err);
          break;
        }
      }

      if (Object.keys(this.buffered).length === 0) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, expBackoff(attempt)));
    }

    this.debug(`Failed to flush messages after max attempts`, { maxAttempts });
  }
}
