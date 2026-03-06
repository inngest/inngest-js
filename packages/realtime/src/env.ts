export type EnvValue = string | undefined;
export type Env = Record<string, EnvValue>;

export type ExpectedEnv = {
  INNGEST_DEV: string | undefined;
  NODE_ENV: string | undefined;
  INNGEST_BASE_URL: string | undefined;
  INNGEST_API_BASE_URL: string | undefined;
  INNGEST_SIGNING_KEY: string | undefined;
  INNGEST_SIGNING_KEY_FALLBACK: string | undefined;
};

/**
 * The environment variables that we wish to access in the environment.
 *
 * Due to the way that some environment variables are exposed across different
 * runtimes and bundling tools, we need to be careful about how we access them.
 *
 * The most basic annoyance is that environment variables are exposed in
 * different locations (e.g. `process.env`, `Deno.env`, `Netlify.env`,
 * `import.meta.env`).
 *
 * Bundling can be more disruptive though, where some will literally
 * find/replace `process.env.MY_VAR` with the value of `MY_VAR` at build time,
 * which requires us to ensure that the full env var is used in code instead of
 * dynamically building it.
 */
const env: ExpectedEnv | undefined = (() => {
  // Pure vite
  try {
    // @ts-expect-error - import.meta only available in some environments
    const viteEnv = import.meta.env;

    if (viteEnv) {
      return {
        INNGEST_DEV: viteEnv.INNGEST_DEV ?? viteEnv.VITE_INNGEST_DEV,
        NODE_ENV: viteEnv.NODE_ENV,
        INNGEST_BASE_URL:
          viteEnv.INNGEST_BASE_URL ?? viteEnv.VITE_INNGEST_BASE_URL,
        INNGEST_API_BASE_URL:
          viteEnv.INNGEST_API_BASE_URL ?? viteEnv.VITE_INNGEST_API_BASE_URL,
        INNGEST_SIGNING_KEY: viteEnv.INNGEST_SIGNING_KEY,
        INNGEST_SIGNING_KEY_FALLBACK: viteEnv.INNGEST_SIGNING_KEY_FALLBACK,
      };
    }
  } catch {
    // noop
  }

  try {
    // Node-like environments (sometimes polyfilled Vite)
    if (process.env) {
      return {
        INNGEST_DEV:
          process.env.INNGEST_DEV ??
          process.env.NEXT_PUBLIC_INNGEST_DEV ??
          process.env.REACT_APP_INNGEST_DEV ??
          process.env.NUXT_PUBLIC_INNGEST_DEV ??
          process.env.VUE_APP_INNGEST_DEV ??
          process.env.VITE_INNGEST_DEV,

        NODE_ENV:
          process.env.NODE_ENV ??
          process.env.NEXT_PUBLIC_NODE_ENV ??
          process.env.REACT_APP_NODE_ENV ??
          process.env.NUXT_PUBLIC_NODE_ENV ??
          process.env.VUE_APP_NODE_ENV ??
          process.env.VITE_NODE_ENV ??
          process.env.VITE_MODE,

        INNGEST_BASE_URL:
          process.env.INNGEST_BASE_URL ??
          process.env.NEXT_PUBLIC_INNGEST_BASE_URL ??
          process.env.REACT_APP_INNGEST_BASE_URL ??
          process.env.NUXT_PUBLIC_INNGEST_BASE_URL ??
          process.env.VUE_APP_INNGEST_BASE_URL ??
          process.env.VITE_INNGEST_BASE_URL,

        INNGEST_API_BASE_URL:
          process.env.INNGEST_API_BASE_URL ??
          process.env.NEXT_PUBLIC_INNGEST_API_BASE_URL ??
          process.env.REACT_APP_INNGEST_API_BASE_URL ??
          process.env.NUXT_PUBLIC_INNGEST_API_BASE_URL ??
          process.env.VUE_APP_INNGEST_API_BASE_URL ??
          process.env.VITE_INNGEST_API_BASE_URL,

        INNGEST_SIGNING_KEY: process.env.INNGEST_SIGNING_KEY,

        INNGEST_SIGNING_KEY_FALLBACK: process.env.INNGEST_SIGNING_KEY_FALLBACK,
      };
    }
  } catch {
    // noop
  }

  // Deno
  try {
    const denoEnv = Deno.env.toObject();

    if (denoEnv) {
      return {
        INNGEST_DEV: denoEnv.INNGEST_DEV,
        NODE_ENV: denoEnv.NODE_ENV,
        INNGEST_BASE_URL: denoEnv.INNGEST_BASE_URL,
        INNGEST_API_BASE_URL: denoEnv.INNGEST_API_BASE_URL,
        INNGEST_SIGNING_KEY: denoEnv.INNGEST_SIGNING_KEY,
        INNGEST_SIGNING_KEY_FALLBACK: denoEnv.INNGEST_SIGNING_KEY_FALLBACK,
      };
    }
  } catch {
    // noop
  }

  // Netlify
  try {
    const netlifyEnv = Netlify.env.toObject();

    if (netlifyEnv) {
      return {
        INNGEST_DEV: netlifyEnv.INNGEST_DEV,
        NODE_ENV: netlifyEnv.NODE_ENV,
        INNGEST_BASE_URL: netlifyEnv.INNGEST_BASE_URL,
        INNGEST_API_BASE_URL: netlifyEnv.INNGEST_API_BASE_URL,
        INNGEST_SIGNING_KEY: netlifyEnv.INNGEST_SIGNING_KEY,
        INNGEST_SIGNING_KEY_FALLBACK: netlifyEnv.INNGEST_SIGNING_KEY_FALLBACK,
      };
    }
  } catch {
    // noop
  }
})();

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
 * Given a `key`, get the environment variable under that key.
 */
export const getEnvVar = (key: keyof ExpectedEnv): string | undefined => {
  return env?.[key];
};
