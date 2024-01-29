import handlingStepErrors from "./handling-step-errors";
import helloWorld from "./hello-world";
import parallelReduce from "./parallel-reduce";
import parallelWork from "./parallel-work";
import polling from "./polling";
import promiseAll from "./promise-all";
import promiseRace from "./promise-race";
import sendEvent from "./send-event";
import sequentialReduce from "./sequential-reduce";
import stepInvokeFunctions from "./step-invoke";
import stepInvokeNotFound from "./step-invoke-not-found";
import undefinedData from "./undefined-data";
import unhandledStepErrors from "./unhandled-step-errors";

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
];

export { inngest } from "./client";
