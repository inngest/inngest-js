import { channel } from "./channel.ts";
import type { Realtime } from "./types.ts";

export { channel } from "./channel.ts";
export { TopicDefinitionImpl, topic } from "./topic.ts";
export { Realtime } from "./types.ts";

//
// realtime.type<T>() returns a TopicConfig<T> with zero runtime cost.
// The type information exists only at compile time.
//
//
// Returns the narrow `{ __type?: TData }` branch (not the full TopicConfig union)
// so that InferTopicData can extract TData without union distribution issues.
//
const typeHelper = <TData>(): { __type?: TData } => {
  return {} as { __type?: TData };
};

export const realtime = {
  channel,
  type: typeHelper,
} as const;
