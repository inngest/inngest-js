#!/usr/bin/env node

import path from "path";
import { InngestStep } from "./index";

/**
 * Init initializes the context for running the function.  This calls
 * start() when
 */
async function init() {
  const [, , fnPath, rawContext] = process.argv;

  // We pass the event in as an argument to the node function.  Running
  // npx ts-node "./foo.bar" means we have 2 arguments prior to the event.
  // We'll also be adding stdin and lambda compatibility soon.
  const context = JSON.parse(rawContext);

  if (!context) {
    throw new Error("unable to parse context");
  }

  // Import this asynchronously, such that any top-level
  // errors in user code are caught.
  const { run } = (await import(
    path.join(process.cwd(), fnPath)
  )) as unknown as {
    run: InngestStep<any>;
  };

  const result = await run(context);

  /**
   * We could also validate the response format (status code required) here and
   * throw an error if it's not there?
   */
  return result;
}

init()
  .then((body) => {
    if (typeof body === "string") {
      console.log(JSON.stringify({ body }));
      return;
    }
    console.log(JSON.stringify(body));
  })
  .catch((e: Error) => {
    // TODO: Log error and stack trace.
    console.log(
      JSON.stringify({
        error: e.stack || e.message,
        status: 500,
      })
    );
    process.exit(1);
  });
