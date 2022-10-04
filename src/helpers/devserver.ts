import type { FunctionConfig } from "../types";
import { defaultDevServerHost } from "./consts";

/**
 * A simple type map that we can transparently use `fetch` later without having
 * to fall in to the self-referencing `const fetch: typeof fetch = ...` which
 * fails.
 */
type FetchT = typeof fetch;

/**
 * Attempts to contact the dev server, returning a boolean indicating whether or
 * not it was successful.
 */
export const devServerAvailable = async (
  /**
   * The host of the dev server. You should pass in an environment variable as
   * this parameter.
   */
  host = defaultDevServerHost,

  /**
   * The fetch implementation to use to communicate with the dev server.
   */
  fetch: FetchT
): Promise<boolean> => {
  try {
    const url = devServerUrl(host, "/dev");
    const result = await fetch(url.toString());
    await result.json();

    return true;
  } catch (e) {
    return false;
  }
};

export const devServerUrl = (
  host = defaultDevServerHost,
  pathname = ""
): URL => {
  return new URL(pathname, host.includes("://") ? host : `http://${host}`);
};

// InfoResponse is the API response for the dev server's /dev endpoint.
export type InfoResponse = {
  version: string; // Version of the dev server
  startOpts: {
    sdkURLs: string[]; // URLs the dev server was started with
  };
  // Account helpers
  authed: boolean; // Are we logged in?
  workspaces: {
    prod: WorkspaceResponse; // To validate keys in test & prod.
    test: WorkspaceResponse;
  };
  // SDK registration helpers
  functions: FunctionConfig[];
  handlers: SDKHandler[];
};

type WorkspaceResponse = {
  signingKey: string;
  eventKeys: Array<{
    name: string;
    key: string;
  }>;
};

type SDKHandler = {
  functionIDs: Array<string>;
  createdAt: string;
  updatedAt: string;
  errors: Array<string>; // A list of errors from eg. function validation, or key validation.
  sdk: {
    url: string;
    language: string;
    version: string;
    framework?: string;
    app: string; // app name
  };
};
