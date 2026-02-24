"use server";

import { getInngestApp } from "@/inngest";
import { helloChannel } from "@/inngest/channels";
import { getSubscriptionToken } from "inngest/react";

export const fetchRealtimeSubscriptionToken = async () => {
  const token = await getSubscriptionToken(getInngestApp(), {
    channel: helloChannel,
    topics: ["logs"],
  });

  return token;
};

export const pause = async () => {
  const inngest = getInngestApp();
  await inngest.send({ name: "test/cancel.signal" });
};

export const resume = async () => {
  const inngest = getInngestApp();
  await inngest.send({ name: "test/hello.world" });
};
