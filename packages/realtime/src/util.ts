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
  authToken: string;
  authTokenFallback: string | undefined;
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

const publicEnvVarPrefixes = [
  "", // Also search for the env var itself
  "PUBLIC_",
  "NEXT_PUBLIC_",
  "REACT_APP_",
  "NUXT_PUBLIC_",
  "VUE_APP_",
];

/**
 * Given a `key`, get the environment variable under that key.
 */
export const getEnvVar = (key: string): string | undefined => {
  return allProcessEnv()[key];
};

/**
 * Given a `key`, get the environment variable under that key or a
 * public-prefixed version of it, such as `NEXT_PUBLIC_${key}`.
 */
export const getPublicEnvVar = (key: string): string | undefined => {
  const env = allProcessEnv();

  for (const prefix of publicEnvVarPrefixes) {
    const envVar = env[prefix + key];

    if (envVar !== undefined) {
      return envVar;
    }
  }
};

export type EnvValue = string | undefined;
export type Env = Record<string, EnvValue>;

/**
 * The Deno environment, which is not always available.
 */
declare const Deno: {
  env: { toObject: () => Env };
};

/**
 * The Netlify environment, which is not always available.
 */
declare const Netlify: {
  env: { toObject: () => Env };
};

/**
 * allProcessEnv returns the current process environment variables, or an empty
 * object if they cannot be read, making sure we support environments other than
 * Node such as Deno, too.
 *
 * Using this ensures we don't dangerously access `process.env` in environments
 * where it may not be defined, such as Deno or the browser.
 */
export const allProcessEnv = (): Env => {
  // Node, Bun, or Node-like environments
  try {
    if (process.env) {
      return process.env;
    }
  } catch (_err) {
    // noop
  }

  // Deno
  try {
    const env = Deno.env.toObject();

    if (env) {
      return env;
    }
  } catch (_err) {
    // noop
  }

  // Netlify
  try {
    const env = Netlify.env.toObject();

    if (env) {
      return env;
    }
  } catch (_err) {
    // noop
  }

  return {};
};
