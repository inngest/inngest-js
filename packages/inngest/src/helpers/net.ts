import canonicalize from "canonicalize";
import hashjs from "hash.js";

const { hmac, sha256 } = hashjs;

let hasLoggedCryptoImplementation = false;

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
  let res = await fetch(url, {
    ...options,
    headers: {
      ...options?.headers,
      Authorization: `Bearer ${authToken}`,
    },
  });

  if ([401, 403].includes(res.status) && authTokenFallback) {
    res = await fetch(url, {
      ...options,
      headers: {
        ...options?.headers,
        Authorization: `Bearer ${authTokenFallback}`,
      },
    });
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
  // Remove the `/signkey-[test|prod]-/` prefix from our signing key to calculate the HMAC.
  const key = signingKey.replace(/signkey-\w+-/, "");
  // biome-ignore lint/suspicious/noExplicitAny: intentional
  const mac = hmac(sha256 as any, key)
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
  const key = signingKey.replace(/signkey-\w+-/, "");

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
): Promise<string> {
  const subtle = globalThis.crypto?.subtle;

  if (!hasLoggedCryptoImplementation) {
    hasLoggedCryptoImplementation = true;
    if (subtle) {
      console.debug("[inngest] Using native Web Crypto for request signing");
    } else {
      console.debug(
        "[inngest] Using hash.js fallback for request signing (native crypto unavailable)",
      );
    }
  }

  if (subtle) {
    try {
      return await signWithNative(subtle, data, signingKey, ts);
    } catch (error) {
      console.debug(
        "[inngest] Native crypto failed, falling back to hash.js:",
        error,
      );
    }
  }
  return signWithHashJs(data, signingKey, ts);
}
