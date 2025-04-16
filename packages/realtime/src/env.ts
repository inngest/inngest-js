export type EnvValue = string | undefined;
export type Env = Record<string, EnvValue>;

let env: Env;

/**
 * Given a `key`, get the environment variable under that key.
 */
export const getEnvVar = (key: string): string | undefined => {
  return env[key];
};

try {
  // Nodeish
  env = {
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
} catch {
  // Vite, Deno, Netlify, others...
  // import.meta.env, Deno.env...
}
