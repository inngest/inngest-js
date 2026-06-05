const { context, trace } = require("@opentelemetry/api");
const {
  AsyncHooksContextManager,
} = require("@opentelemetry/context-async-hooks");
const { registerInstrumentations } = require("@opentelemetry/instrumentation");
const {
  OpenAIInstrumentation,
} = require("@opentelemetry/instrumentation-openai");
const { BasicTracerProvider } = require("@opentelemetry/sdk-trace-base");

const provider = new BasicTracerProvider();

trace.setGlobalTracerProvider(provider);
context.setGlobalContextManager(new AsyncHooksContextManager().enable());

registerInstrumentations({
  instrumentations: [new OpenAIInstrumentation()],
});
