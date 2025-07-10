export const debugPrefix = "inngest:otel";

export enum TraceStateKey {
  AppId = "inngest@app",
  FunctionId = "inngest@fn",
}

export enum Attribute {
  InngestTraceparent = "inngest.traceparent",
  InngestRunId = "sdk.run.id",
  InngestAppId1 = "sdk.app.id",
  InngestAppId2 = "sys.app.id",
  InngestFunctionId = "sys.function.id",
}
