"use server";

import { getInngestApp } from "@/inngest";
import { helloChannel } from "@/inngest/functions/helloWorld";
import { getSubscriptionToken, Realtime } from "@inngest/realtime";

export type HelloToken = Realtime.Token<typeof helloChannel, ["logs"]>;

export async function invoke(): Promise<HelloToken> {
  const token = await getSubscriptionToken(getInngestApp(), {
    channel: helloChannel(),
    topics: ["logs"],
  });

  return token;
}
