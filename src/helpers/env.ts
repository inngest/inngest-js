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

export const isProd = (): boolean => {
  const values = [
    processEnv("NODE_ENV"),
    processEnv("VERCEL_ENV"),
    processEnv("CONTEXT"),
  ];

  return values.includes("production");
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
