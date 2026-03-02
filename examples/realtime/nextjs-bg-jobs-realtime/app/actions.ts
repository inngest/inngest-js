"use server";

import { inngest } from "@/lib/inngest";
import { campaignSendChannel } from "@/src/inngest/functions";
import { getSubscriptionToken } from "inngest/react";

export const fetchSubscriptionToken = async (campaignId: string) => {
  const token = await getSubscriptionToken(inngest, {
    // biome-ignore lint/suspicious/noExplicitAny: v2 channel typing is in flux on this branch
    channel: campaignSendChannel({ campaignId }) as any,
    topics: ["progress"],
  });

  if (!token.key) {
    throw new Error("No realtime subscription token key returned");
  }

  return token;
};
