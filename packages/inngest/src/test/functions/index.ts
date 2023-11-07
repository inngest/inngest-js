import helloWorld from "./hello-world";
import parallelReduce from "./parallel-reduce";
import parallelWork from "./parallel-work";
import polling from "./polling";
import promiseAll from "./promise-all";
import promiseRace from "./promise-race";
import sendEvent from "./send-event";
import sequentialReduce from "./sequential-reduce";
import undefinedData from "./undefined-data";

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
];

export { inngest } from "./client";
