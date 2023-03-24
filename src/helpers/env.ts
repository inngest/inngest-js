// This file exists to help normalize process.env amongst the backend
// and frontend.  Many frontends (eg. Next, CRA) utilize webpack's DefinePlugin
// along with prefixes, meaning we have to explicitly use the full `process.env.FOO`
// string in order to read variables.

import { envKeys } from "./consts";

/**
 * devServerHost returns the dev server host by searching for the INNGEST_DEVSERVER_URL
 * environment variable (plus project prefixces for eg. react, such as REACT_APP_INNGEST_DEVSERVER_URL).
 *
 * If not found this returns undefined, indicating that the env var has not been set.
 *
 * @example devServerHost()
 */
export const devServerHost = (): string | undefined => {
  // devServerKeys are the env keys we search for to discover the dev server
  // URL.  This includes the standard key first, then includes prefixed keys
  // for use within common frameworks (eg. CRA, next).
  //
  // We have to fully write these using process.env as they're typically
  // processed using webpack's DefinePlugin, which is dumb and does a straight
  // text replacement instead of actually understanding the AST, despite webpack
  // being fully capable of understanding the AST.
  const values = [
    processEnv(envKeys.DevServerUrl),
    processEnv("REACT_APP_INNGEST_DEVSERVER_URL"),
    processEnv("NEXT_PUBLIC_INNGEST_DEVSERVER_URL"),
  ];

  return values.find((a) => !!a);
};

const prodCheckFns = (<
  T extends Record<
    string,
    (actual: string | undefined, expected: string | undefined) => boolean
  >
>(
  checks: T
): T => checks)({
  equals: (actual, expected) => actual === expected,
  "starts with": (actual, expected) =>
    expected ? actual?.startsWith(expected) ?? false : false,
  "is truthy": (actual) => Boolean(actual),
});

const prodChecks: [
  key: string,
  customCheck: keyof typeof prodCheckFns,
  value?: string
][] = [
  ["CF_PAGES", "equals", "1"],
  ["CONTEXT", "starts with", "prod"],
  ["ENVIRONMENT", "starts with", "prod"],
  ["NODE_ENV", "starts with", "prod"],
  ["VERCEL_ENV", "starts with", "prod"],
  ["DENO_DEPLOYMENT_ID", "is truthy"],
];

/**
 * Returns `true` if we believe the current environment is production based on
 * either passed environment variables or `process.env`.
 */
export const isProd = (
  /**
   * The optional environment variables to use instead of `process.env`.
   */
  env: Record<string, unknown> = allProcessEnv()
): boolean => {
  return prodChecks.some(([key, checkKey, expected]) => {
    return prodCheckFns[checkKey](env[key]?.toString(), expected);
  });
};

const hasProcessEnv = (): boolean => {
  return typeof process !== "undefined" && "env" in process;
};

export const processEnv = (key: string): string | undefined => {
  return allProcessEnv()[key];
};

export const allProcessEnv = (): Record<string, string | undefined> => {
  if (hasProcessEnv()) {
    // eslint-disable-next-line @inngest/process-warn
    return process.env;
  }

  return {};
};
