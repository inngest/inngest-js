/**
 * Keys for accessing query parameters included in requests from Inngest to run
 * functions.
 *
 * Used internally to create handlers using `InngestCommHandler`, but can be
 * imported to be used if creating a custom handler outside of the package.
 *
 * @public
 */
export enum queryKeys {
  FnId = "fnId",
  StepId = "stepId",
  Introspect = "introspect",
  DeployId = "deployId",
}

export enum envKeys {
  SigningKey = "INNGEST_SIGNING_KEY",
  EventKey = "INNGEST_EVENT_KEY",
  LandingPage = "INNGEST_LANDING_PAGE",
  DevServerUrl = "INNGEST_DEVSERVER_URL",
}

export enum prodEnvKeys {
  NodeEnvKey = "NODE_ENV",
  VercelEnvKey = "VERCEL_ENV",
  NetlifyEnvKey = "CONTEXT",
}

/**
 * Keys for accessing headers included in requests from Inngest to run
 * functions.
 *
 * Used internally to create handlers using `InngestCommHandler`, but can be
 * imported to be used if creating a custom handler outside of the package.
 *
 * @public
 */
export enum headerKeys {
  Signature = "x-inngest-signature",
  SdkVersion = "x-inngest-sdk",
}

export const defaultDevServerHost = "http://127.0.0.1:8288/";
