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
