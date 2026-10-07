import canonicalize from "canonicalize";
import hashjs from "hash.js";
import type { Logger } from "../middleware/logger.ts";
import { logOnce } from "./log.ts";
import { removeSigningKeyPrefix } from "./strings.ts";

const { hmac, sha256 } = hashjs;

/**
 * The most bytes of a stream body that are kept for a retry with the fallback
 * signing key. Once a request sends more than this, the retry is skipped and
 * the original response is returned.
 */
const MAX_REPLAY_BYTES = 4 * 1024 * 1024;

/**
 * Split a stream body into one stream to send now and one to send on a retry.
 * Chunks are recorded only as the first request reads them, up to
 * `MAX_REPLAY_BYTES`, so nothing is buffered beyond what is sent. The retry
 * stream replays the recorded chunks, then reads the rest from the source.
 */
function replayableStream(source: ReadableStream) {
  const reader = source.getReader();
  const recorded: unknown[] = [];
  let recordedBytes = 0;
  let overflowed = false;
  let inflight: Promise<unknown> = Promise.resolve();
  let retrying = false;

  const first = new ReadableStream({
    pull(controller) {
      // Once the retry starts, it is the only reader of the source.
      if (retrying) {
        controller.close();
        return;
      }
      const read = reader.read().then(({ done, value }) => {
        if (done) {
          controller.close();
          return;
        }
        if (!overflowed) {
          recordedBytes += (value as { byteLength?: number })?.byteLength ?? 0;
          if (recordedBytes > MAX_REPLAY_BYTES) {
            overflowed = true;
            recorded.length = 0;
          } else {
            recorded.push(value);
          }
        }
        controller.enqueue(value);
      });
      inflight = read.catch(() => {});
      return read.catch((err) => controller.error(err));
    },
    // The retry stream still needs the source, so leave it open here.
  });

  const canReplay = () => !overflowed;

  const retry = () => {
    retrying = true;
    let index = 0;
    return new ReadableStream({
      async pull(controller) {
        await inflight;
        if (index < recorded.length) {
          controller.enqueue(recorded[index++]);
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  };

  return {
    first,
    canReplay,
    retry,
    cancel: () => reader.cancel().catch(() => {}),
  };
}

/**
 * Send an HTTP request with the given signing key. If the response is a 401 or
 * 403, then try again with the fallback signing key
 */
export async function fetchWithAuthFallback<TFetch extends typeof fetch>({
  authToken,
  authTokenFallback,
  fetch,
  options,
  url,
}: {
  authToken?: string;
  authTokenFallback?: string;
  fetch: TFetch;
  options?: Parameters<TFetch>[1];
  url: URL | string;
}): Promise<Response> {
  // A stream body can only be sent once, so keep the sent chunks for the retry.
  const replay =
    authTokenFallback && options?.body instanceof ReadableStream
      ? replayableStream(options.body)
      : undefined;

  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      ...(replay ? { body: replay.first } : {}),
      headers: {
        ...options?.headers,
        Authorization: `Bearer ${authToken}`,
      },
    });
  } catch (err) {
    void replay?.cancel();
    throw err;
  }

  if (
    [401, 403].includes(res.status) &&
    authTokenFallback &&
    (!replay || replay.canReplay())
  ) {
    try {
      res = await fetch(url, {
        ...options,
        ...(replay ? { body: replay.retry() } : {}),
        headers: {
          ...options?.headers,
          Authorization: `Bearer ${authTokenFallback}`,
        },
      });
    } finally {
      void replay?.cancel();
    }
  } else {
    void replay?.cancel();
  }

  return res;
}

export function signWithHashJs(
  data: unknown,
  signingKey: string,
  ts: string,
): string {
  // Calculate the HMAC of the request body ourselves.
  // We make the assumption here that a stringified body is the same as the
  // raw bytes; it may be pertinent in the future to always parse, then
  // canonicalize the body to ensure it's consistent.
  const encoded = typeof data === "string" ? data : canonicalize(data);
  // biome-ignore lint/suspicious/noExplicitAny: intentional
  const mac = hmac(sha256 as any, removeSigningKeyPrefix(signingKey))
    .update(encoded)
    .update(ts)
    .digest("hex");

  return mac;
}

// Cache for CryptoKeys to avoid repeated importKey calls
const cryptoKeyCache = new Map<string, CryptoKey>();

async function signWithNative(
  subtle: SubtleCrypto,
  data: unknown,
  signingKey: string,
  ts: string,
): Promise<string> {
  const encoded = typeof data === "string" ? data : canonicalize(data);
  const key = removeSigningKeyPrefix(signingKey);

  let cryptoKey = cryptoKeyCache.get(key);
  if (!cryptoKey) {
    cryptoKey = await subtle.importKey(
      "raw",
      new TextEncoder().encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    cryptoKeyCache.set(key, cryptoKey);
  }

  const signature = await subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(encoded + ts),
  );

  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Sign data with a signing key using HMAC-SHA256.
 * Uses native crypto.subtle when available, falls back to hash.js.
 */
export async function signDataWithKey(
  data: unknown,
  signingKey: string,
  ts: string,
  logger: Logger,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;

  logOnce(
    logger,
    "debug",
    "crypto-implementation",
    subtle
      ? "Using native Web Crypto for request signing"
      : "Using hash.js fallback for request signing (native crypto unavailable)",
  );

  if (subtle) {
    try {
      return await signWithNative(subtle, data, signingKey, ts);
    } catch (err) {
      logger.debug({ err }, "Native crypto failed, falling back to hash.js");
    }
  }
  return signWithHashJs(data, signingKey, ts);
}
