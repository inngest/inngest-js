import fetch from 'cross-fetch';

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
}

type WorkspaceResponse = {
  signingKey: string;
  eventKeys: Array<{
    name: string;
    key: string;
  }>
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
  }
}

type Function = {
  id: string;
};

const envVars = [
  "NODE_ENV",   // express slash standard.
  "VERCEL_ENV", // vercel
  "CONTEXT",    // netlify
];

export const available = async (): Promise<boolean> => {
  if (isProd()) {
    return false;
  }

  try {
    const result = await fetch(url());
    await result.json();
    return true;
  } catch(e) {}

  return false;
}

// isProd compares any supported standard env variable for "production",
// returning true on first match. 
export const isProd = (): boolean => {
  return !!envVars.find(e => process.env[e] === "production");
}

// url returns the dev server URL, overriding to use the INNGEST_DEVSERVER_URL
// env var if provided.
export const url = (): string => {
  let host = process.env.INNGEST_DEVSERVER_URL
  if (!host) {
    // Use the default.
    return `http://127.0.0.1:8223/x/devserver`;
  }

  // Normalize the URL to be friendly here.  If the user hasn't added a scheme,
  // default to http.
  if (host.indexOf("://") === -1) {
    host = `http://${host}`;
  }

  // Ensure the pathname is set correctly.  This lets people set the env var
  // to eg. INNGEST_DEVSERVER_URL=127.0.0.1:9123
  const parsed = new URL(host);
  parsed.pathname = "/x/devserver";
  return parsed.toString();
}
