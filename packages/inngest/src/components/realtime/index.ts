import { channel } from "./channel.ts";

export { channel } from "./channel.ts";
export { TopicDefinitionImpl, topic } from "./topic.ts";
export { Realtime } from "./types.ts";

export const realtime = {
  channel,
} as const;
