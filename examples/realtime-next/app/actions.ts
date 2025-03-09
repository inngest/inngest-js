"use server";

import { getInngestApp } from "@/inngest";
import { helloChannel } from "@/inngest/functions/helloWorld";
import { typeOnlyChannel } from "inngest/components/realtime/channel";

export async function invoke() {
  "use server";

  const app = getInngestApp();

  // let's say we invoke a fn here

  const token = await app.getSubscriptionToken({
    channel: typeOnlyChannel<typeof helloChannel>("hello-world"),
    topics: ["logs"],
  });

  console.log("created token:", token);

  return token;
}
