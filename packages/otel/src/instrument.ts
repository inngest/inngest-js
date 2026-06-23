import { register } from "node:module";
import { context, trace } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { AnthropicInstrumentation } from "@traceloop/instrumentation-anthropic";
import { GenAIInstrumentation } from "@traceloop/instrumentation-google-generativeai";
import { OpenAIInstrumentation } from "@traceloop/instrumentation-openai";
import Debug from "debug";
import { type MaybeError, toError } from "./types.ts";

const debug = Debug("inngest:otel:instrumentTracing");

let isTraceInstrumentationHookRegistered = false;
let isTraceInstrumentationStarted = false;

/**
 * Installs supported trace instrumentations and ensures a process-global OTel
 * provider exists.
 *
 * If the app already configured a tracer provider, that provider is left in
 * place. Otherwise, this creates a basic provider so preloaded
 * instrumentations can emit spans.
 *
 * Call this before importing instrumented libraries.
 */
export function instrumentTracing(): void {
  if (isTraceInstrumentationStarted) {
    // Idempotency
    return;
  }
  isTraceInstrumentationStarted = true;

  const instrumented = registerTraceInstrumentations();
  if (instrumented instanceof Error) {
    isTraceInstrumentationStarted = false;
    debug("unable to register trace instrumentations", instrumented);
    return;
  }

  const provider = ensureTraceProvider();
  if (provider instanceof Error) {
    isTraceInstrumentationStarted = false;
    debug("unable to initialize provider", provider);
  }
}

/**
 * Registers OpenTelemetry's Node ESM instrumentation hook for future imports.
 * Call this from a preload before application modules are imported.
 */
export function registerNodeTraceInstrumentationHook(): void {
  if (isTraceInstrumentationHookRegistered) {
    // Idempotency
    return;
  }
  isTraceInstrumentationHookRegistered = true;

  try {
    // Register OTel's ESM loader hook before app modules load. CommonJS
    // packages can be patched through require-in-the-middle, but ESM imports
    // require this Node module hook so instrumentations can intercept future
    // imports.
    //
    // `module.register` was deprecated in Node v25.9.0 in favor of
    // `module.registerHooks` (added in v23.5.0 and v22.15.0), but OTel's hook
    // currently exports async loader hooks, so `module.registerHooks` is not a
    // drop-in replacement. See:
    // https://nodejs.org/api/module.html#customization-hooks
    register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
  } catch (e) {
    const err = toError(e);
    isTraceInstrumentationHookRegistered = false;
    debug("failed to register trace instrumentation hook:", err);
  }
}

function registerTraceInstrumentations(): MaybeError<void> {
  try {
    registerInstrumentations({
      instrumentations: [
        ...getNodeAutoInstrumentations(),
        new AnthropicInstrumentation(),
        new GenAIInstrumentation(),
        new OpenAIInstrumentation(),
      ],
    });
  } catch (e) {
    const err = toError(e);
    debug("failed to register trace instrumentations:", err);
    return err;
  }
}

function ensureTraceProvider(): MaybeError<void> {
  try {
    const provider = new BasicTracerProvider();
    if (!trace.setGlobalTracerProvider(provider)) {
      // Reachable when a provider already exists
      return;
    }

    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );
  } catch (e) {
    const err = toError(e);
    debug("failed to initialize provider:", err);
    return err;
  }
}
