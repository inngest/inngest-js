import debug, { type Debugger } from "debug";
import { headerKeys } from "../../helpers/consts.ts";
import { FlushResponse } from "../../proto/src/components/connect/protobuf/connect.ts";
import { expBackoff } from "./util.ts";

export class MessageBuffer {
  private buffered: Record<string, Uint8Array> = {};
  private pending: Record<string, Uint8Array> = {};
  private getApiBaseUrl: () => Promise<string>;
  private debug: Debugger;
  private envName: string | undefined;

  constructor({
    envName,
    getApiBaseUrl,
  }: { envName: string | undefined; getApiBaseUrl: () => Promise<string> }) {
    this.envName = envName;
    this.getApiBaseUrl = getApiBaseUrl;
    this.debug = debug("inngest:connect:message-buffer");
  }

  public append(requestId: string, responseBytes: Uint8Array) {
    this.buffered[requestId] = responseBytes;
    delete this.pending[requestId];
  }

  public addPending(
    requestId: string,
    responseBytes: Uint8Array,
    deadline: number,
  ) {
    this.pending[requestId] = responseBytes;
    setTimeout(() => {
      if (this.pending[requestId]) {
        this.debug("Message not acknowledged in time", requestId);
        this.append(requestId, this.pending[requestId]!);
      }
    }, deadline);
  }

  public acknowledgePending(requestId: string) {
    delete this.pending[requestId];
  }

  private async sendFlushRequest(
    hashedSigningKey: string | undefined,
    responseBytes: Uint8Array,
  ) {
    const headers: Record<string, string> = {
      "Content-Type": "application/protobuf",
      ...(hashedSigningKey
        ? { Authorization: `Bearer ${hashedSigningKey}` }
        : {}),
    };

    if (this.envName) {
      headers[headerKeys.Environment] = this.envName;
    }

    // protobuf's `finish()` is typed as `Uint8Array<ArrayBufferLike>` (could be
    // SharedArrayBuffer-backed), but it actually creates a regular ArrayBuffer.
    // Cast to satisfy fetch's stricter type requirement.
    // const body = responseBytes as Uint8Array<ArrayBuffer>;
    if (!isUnsharedArrayBuffer(responseBytes)) {
      throw new Error("Unreachable: response bytes are not an ArrayBuffer");
    }

    const resp = await fetch(
      // refactor this to a more universal spot
      new URL("/v0/connect/flush", await this.getApiBaseUrl()),
      {
        method: "POST",
        body: responseBytes,
        headers: headers,
      },
    );

    if (!resp.ok) {
      this.debug("Failed to flush messages", await resp.text());
      throw new Error("Failed to flush messages");
    }

    const flushResp = FlushResponse.decode(
      new Uint8Array(await resp.arrayBuffer()),
    );

    return flushResp;
  }

  public async flush(hashedSigningKey: string | undefined) {
    if (Object.keys(this.buffered).length === 0) {
      return;
    }

    this.debug(`Flushing ${Object.keys(this.buffered).length} messages`);

    const maxAttempts = 5;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      for (const [k, v] of Object.entries(this.buffered)) {
        try {
          await this.sendFlushRequest(hashedSigningKey, v);
          delete this.buffered[k];
        } catch (err) {
          this.debug("Failed to flush message", k, err);
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

function isUnsharedArrayBuffer(
  value: Uint8Array<ArrayBufferLike>,
): value is Uint8Array<ArrayBuffer> {
  if (typeof SharedArrayBuffer === "undefined") {
    // `SharedArrayBuffer` may not exist at runtime. Some runtimes removed it
    // for security reasons (Spectre-like attacks).
    //
    // If it doesn't exist then we know value is an `ArrayBuffer`.
    return true;
  }

  return value.buffer instanceof ArrayBuffer;
}
