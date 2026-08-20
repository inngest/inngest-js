import { headerKeys } from "../../helpers/consts.ts";
import type { Logger } from "../../middleware/logger.ts";
import { FlushResponse } from "../../proto/src/components/connect/protobuf/connect.ts";
import { expBackoff } from "./util.ts";

export class MessageBuffer {
  private buffered: Record<string, Uint8Array> = {};
  private pending: Record<string, Uint8Array> = {};
  private getApiBaseUrl: () => Promise<string>;
  private logger: Logger;
  private envName: string | undefined;

  constructor({
    envName,
    getApiBaseUrl,
    logger,
  }: {
    envName: string | undefined;
    getApiBaseUrl: () => Promise<string>;
    logger: Logger;
  }) {
    this.envName = envName;
    this.getApiBaseUrl = getApiBaseUrl;
    this.logger = logger;
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
        this.logger.warn({ requestId }, "Message not acknowledged in time");
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
      this.logger.error(
        { body: await resp.text(), status: resp.status },
        "Failed to flush messages",
      );
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

    this.logger.info(
      { count: Object.keys(this.buffered).length },
      "Flushing messages",
    );

    const maxAttempts = 5;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      for (const [requestId, v] of Object.entries(this.buffered)) {
        try {
          await this.sendFlushRequest(hashedSigningKey, v);
          delete this.buffered[requestId];
        } catch (err) {
          this.logger.warn({ err, requestId }, "Failed to flush message");
          break;
        }
      }

      if (Object.keys(this.buffered).length === 0) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, expBackoff(attempt)));
    }

    this.logger.error(
      { maxAttempts },
      "Failed to flush messages after max attempts",
    );
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

/**
 * Throws an error if the value is not an unshared ArrayBuffer. This should be
 * safe because we shouldn't be using `SharedArrayBuffer` at runtime, but our
 * protobuf types have `Uint8Array` as the return type (no generic), which
 * effectively defaults to a union of `ArrayBuffer` and `SharedArrayBuffer`.
 */
export function ensureUnsharedArrayBuffer(
  value: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  if (!isUnsharedArrayBuffer(value)) {
    throw new Error("Unreachable: response bytes are not an ArrayBuffer");
  }
  return value;
}
