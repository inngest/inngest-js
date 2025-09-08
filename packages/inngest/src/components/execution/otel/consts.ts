export const debugPrefix = "inngest:otel";

export enum TraceStateKey {
  AppId = "inngest@app",
  FunctionId = "inngest@fn",
  TraceRef = "inngest@traceref",
}

export enum Attribute {
  InngestTraceparent = "inngest.traceparent",
  InngestTraceRef = "inngest.traceref",
  InngestRunId = "sdk.run.id",
  InngestAppId1 = "sdk.app.id",
  InngestAppId2 = "sys.app.id",
  InngestFunctionId = "sys.function.id",
}
