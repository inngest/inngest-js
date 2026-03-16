"use server";

import { getInngestApp } from "@/inngest";
import { helloChannel } from "@/inngest/functions/helloWorld";
import { getSubscriptionToken, Realtime } from "@inngest/realtime";

export type HelloToken = Realtime.Token<typeof helloChannel, ["logs"]>;

export async function fetchRealtimeSubscriptionToken(): Promise<HelloToken> {
  const token = await getSubscriptionToken(getInngestApp(), {
    channel: helloChannel(),
    topics: ["logs"],
  });

  return token;
}

export async function pause(): Promise<void> {
  const inngest = getInngestApp();
  await inngest.send({
    name: "test/cancel.signal",
  });
}

export async function resume(): Promise<void> {
  const inngest = getInngestApp();
  await inngest.send({
    name: "test/hello.world",
  });
}
