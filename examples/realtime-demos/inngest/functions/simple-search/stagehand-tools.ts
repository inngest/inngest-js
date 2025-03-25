import { z } from "zod";
import { stringToZodSchema, getStagehand } from "./utils";
import { createTool } from "@inngest/agent-kit";
import { inngest } from "@/inngest/client";


export const stagehandAction = inngest.createFunction({
    id: "stagehand-action",
  },{
    event: "app/simple-search-agent.action",
  },
  async ({ publish, event, step }) => {
    const { browserbaseSessionID, uuid, action, args } = event.data;
    
    const stagehand = await getStagehand(browserbaseSessionID);
    if (action === "navigate") {
      await publish({
        channel: `simple-search.${uuid}`,
        topic: "updates",
        data: `Navigating to ${args.url}`,
      });
      return await step.run("navigate", async () => {  
        await stagehand.page.goto(args.url);
        return `Navigated to ${args.url}.`;
      });
    } else if (action === "extract") {
      const zodSchema = stringToZodSchema(args.schema);
      await publish({
        channel: `simple-search.${uuid}`,
        topic: "updates",
        data: `${args.instruction}`,
      });
      return await step.run("extract", async () => {
        return await stagehand.page.extract({
          instruction: args.instruction,
          schema: zodSchema,
        });
      });
    } else if (action === "act") {
      await publish({
        channel: `simple-search.${uuid}`,
        topic: "updates",
        data: `Performing action: ${args.action}`,
      });
      return await step.run("act", async () => {
        return await stagehand.page.act(args);
      });
    } else if (action === "observe") {
      await publish({
        channel: `simple-search.${uuid}`,
        topic: "updates",
        data: `Observing ${args.instruction}`,
      });
      return await step.run("observe", async () => {
        return await stagehand.page.observe(args);
      });
    }
  },
);

export const navigate = createTool({
  name: "navigate",
  description: "Navigate to a given URL",
  parameters: z.object({
    url: z.string().describe("the URL to navigate to"),
  }),
  handler: async ({ url }, { step, network }) => {
    return await step?.invoke('navigate', {
      function: stagehandAction,
      data: {
        action: "navigate",
        browserbaseSessionID: network?.state.kv.get("browserbaseSessionID")!,
        args: {
          url,
        },
        uuid: network?.state.kv.get("session-uuid")!,
      },
    });
  },
});

export const extract = createTool({
  name: "extract",
  description: "Extract data from the page",
  parameters: z.object({
    instruction: z
      .string()
      .describe("Instructions for what data to extract from the page"),
    schema: z
      .string()
      .describe(
        "A string representing the properties and types of data to extract, for example: '{ name: string, age: number }'"
      ),
  }),
  handler: async ({ instruction, schema }, { step, network }) => {
    return await step?.invoke('extract', {
      function: stagehandAction,
      data: {
        action: "extract",
        browserbaseSessionID: network?.state.kv.get("browserbaseSessionID")!,
        args: {
          instruction,
          schema,
        },
        uuid: network?.state.kv.get("session-uuid")!,
      },
    });
  },
});

export const act = createTool({
  name: "act",
  description: "Perform an action on the page",
  parameters: z.object({
    action: z
      .string()
      .describe("The action to perform (e.g. 'click the login button')"),
  }),
  handler: async ({ action }, { step, network }) => {
    return await step?.invoke('act', {
      function: stagehandAction,
      data: {
        action: "act",
        browserbaseSessionID: network?.state.kv.get("browserbaseSessionID")!,
        args: {
          action,
        },
        uuid: network?.state.kv.get("session-uuid")!,
      },
    });
  },
});

export const observe = createTool({
  name: "observe",
  description: "Observe the page",
  parameters: z.object({
    instruction: z
      .string()
      .describe("Specific instruction for what to observe on the page"),
  }),
  handler: async ({ instruction }, { step, network }) => {
    return await step?.invoke('observe', {
      function: stagehandAction,
      data: {
        action: "observe",
        browserbaseSessionID: network?.state.kv.get("browserbaseSessionID")!,
        args: {
          instruction,
        },
        uuid: network?.state.kv.get("session-uuid")!,
      },
    });
  },
});
