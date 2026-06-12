import {
  instrumentTracing,
  registerNodeTraceInstrumentationHook,
} from "./instrument.ts";

registerNodeTraceInstrumentationHook();
instrumentTracing();
