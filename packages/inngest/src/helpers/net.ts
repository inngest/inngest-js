import canonicalize from "canonicalize";
import hashjs from "hash.js";

const { hmac, sha256 } = hashjs;

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

export function signDataWithKey(
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
