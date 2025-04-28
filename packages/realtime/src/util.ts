type DeferredPromiseReturn<T> = {
  promise: Promise<T>;
  resolve: (value: T) => DeferredPromiseReturn<T>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reject: (reason: any) => DeferredPromiseReturn<T>;
};

/**
 * Creates and returns Promise that can be resolved or rejected with the
 * returned `resolve` and `reject` functions.
 *
 * Resolving or rejecting the function will return a new set of Promise control
 * functions. These can be ignored if the original Promise is all that's needed.
 */
export const createDeferredPromise = <T>(): DeferredPromiseReturn<T> => {
  let resolve: DeferredPromiseReturn<T>["resolve"];
  let reject: DeferredPromiseReturn<T>["reject"];

  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = (value: T) => {
      _resolve(value);
      return createDeferredPromise<T>();
    };

    reject = (reason) => {
      _reject(reason);
      return createDeferredPromise<T>();
    };
  });

  return { promise, resolve: resolve!, reject: reject! };
};

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
  authToken: string | undefined;
  authTokenFallback: string | undefined;
  fetch: TFetch;
  options?: Parameters<TFetch>[1];
  url: URL | string;
}): Promise<Response> {
  let res = await fetch(url, {
    ...options,
    headers: {
      ...options?.headers,
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
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

/**
 * Given an unknown value, try to parse it as a `boolean`. Useful for parsing
 * environment variables that could be a selection of different values such as
 * `"true"`, `"1"`.
 *
 * If the value could not be confidently parsed as a `boolean` or was seen to be
 * `undefined`, this function returns `undefined`.
 */
export const parseAsBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Boolean(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();

    if (trimmed === "undefined") {
      return undefined;
    }

    if (["true", "1"].includes(trimmed)) {
      return true;
    }

    return false;
  }

  return undefined;
};
