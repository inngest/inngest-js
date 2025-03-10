"use server";

import { getInngestApp } from "@/inngest";
import { helloChannel } from "@/inngest/functions/helloWorld";
import { type Realtime } from "inngest/experimental";

export type HelloToken = Realtime.Token<typeof helloChannel, ["logs"]>;

export async function invoke(): Promise<HelloToken> {
  const app = getInngestApp();

  const token = await app.getSubscriptionToken({
    channel: helloChannel(),
    topics: ["logs"],
  });

  return token;
}
