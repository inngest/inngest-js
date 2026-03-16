import handlingStepErrors from "./handling-step-errors";
import helloWorld from "./hello-world";
import multipleTriggers from "./multiple-triggers";
import parallelReduce from "./parallel-reduce";
import parallelWork from "./parallel-work";
import polling from "./polling";
import promiseAll from "./promise-all";
import promiseRace from "./promise-race";
import runPayloadSchema from "./run-payload-schema";
import runPayloadWildcardSchema from "./run-payload-wildcard-schema";
import sendEvent from "./send-event";
import sequentialReduce from "./sequential-reduce";
import stepInvokeFunctions from "./step-invoke";
import stepInvokeNotFound from "./step-invoke-not-found";
import undefinedData from "./undefined-data";
import unhandledStepErrors from "./unhandled-step-errors";
import waitPayloadSchema from "./wait-payload-schema";

export const functions = [
  helloWorld,
  promiseAll,
  promiseRace,
  parallelWork,
  parallelReduce,
  sequentialReduce,
  polling,
  sendEvent,
  undefinedData,
  ...stepInvokeFunctions,
  stepInvokeNotFound,
  handlingStepErrors,
  unhandledStepErrors,
  multipleTriggers,
  runPayloadSchema,
  runPayloadWildcardSchema,
  waitPayloadSchema,
];

export { inngest } from "./client";
