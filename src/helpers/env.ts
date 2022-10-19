import { defaultDevServerHost, devServerKeys } from "./consts";

// This file exists to help

/**
 * devServerHost returns the dev server host by searching for the INNGEST_DEVSERVER_URL
 * environment variable (plus project prefixces for eg. react, such as REACT_APP_INNGEST_DEVSERVER_URL).
 *
 * If not found, this returns the default URL of "http://127.0.0.1:8288/"
 *
 * @example devServerHost(process.env)
 */
export const devServerHost = (): string => {
  // devServerKeys are the env keys we search for to discover the dev server
  // URL.  This includes the standard key first, then includes prefixed keys
  // for use within common frameworks (eg. CRA, next). 
  // 
  // We have to fully write these using process.env as they're typically
  // processed using webpack's DefinePlugin, which is dumb and does a straight
  // text replacement instead of actually understanding the AST, despite webpack
  // being fully capable of understanding the AST.
  const values = [
    process.env.INNGEST_DEVSERVER_URL,
    process.env.REACT_APP_INNGEST_DEVSERVER_URL,
    process.env.NEXT_PUBLIC_INNGEST_DEVSERVER_URL,
  ];

  return values.find(a => !!a) || defaultDevServerHost;
}

export const isProd = (): boolean => {
  const values = [
    process.env.NODE_ENV,
    process.env.VERCEL_ENV,
    process.env.CONTEXT,
  ]
  return !!values.find(v => v === "PRODUCTION");
}
