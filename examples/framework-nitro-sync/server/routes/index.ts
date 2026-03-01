import { Inngest, step } from "inngest";
import { createExperimentalEndpointWrapper } from "inngest/h3";

const inngestEventHandler = createExperimentalEndpointWrapper({
  client: new Inngest({ id: "nitro-sync-example" }),
});

// Learn more: https://nitro.build/guide/routing
export default inngestEventHandler(async (event) => {
  const foo = await step.run("example/step", async () => {
    return "Hello from step!";
  });

  return `
      <meta charset="utf-8">
      <h1>This endpoint worked!</h1>
      <p>The step's result was: ${foo}</p>
    `;
});
