import fetch from "cross-fetch";
import { envKeys, prodEnvKeys } from "./consts";

export const available = async (): Promise<boolean> => {
  if (isProd()) {
    return false;
  }

  try {
    const url = devserverURL("/dev");
    const result = await fetch(url.toString());
    await result.json();
    return true;
  } catch (e) {
    return false;
  }
};

// isProd compares any supported standard env variable for "production",
// returning true on first match.
export const isProd = (): boolean => {
  return !!Object.values(prodEnvKeys).find((e) => process.env[e] === "production");
};

// url returns the dev server URL, overriding to use the INNGEST_DEVSERVER_URL
// env var if provided.
export const devserverURL = (pathname?: string): URL => {
  let host = process.env[envKeys.DevServerURL];
  if (!host) {
    // Use the default.
    const url = new URL(`http://127.0.0.1:8288/`);
    url.pathname = pathname || "";
    return url;
  }

  // Normalize the URL to be friendly here.  If the user hasn't added a scheme,
  // default to http.
  if (host.indexOf("://") === -1) {
    host = `http://${host}`;
  }

  const url = new URL(host);
  url.pathname = pathname || "";
  return url;
};

// InfoResponse is the API response for the dev server's /dev endpoint.
type InfoResponse = {
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
  functions: Function[];
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

type Function = {
  id: string;
};
