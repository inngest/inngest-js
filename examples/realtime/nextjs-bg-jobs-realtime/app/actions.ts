"use server";

import { inngest } from "@/lib/inngest";
import { campaignSendChannel } from "@/src/inngest/functions";
import { getSubscriptionToken } from "inngest/react";

export const fetchSubscriptionToken = async (campaignId: string) => {
  const token = await getSubscriptionToken(inngest, {
    channel: campaignSendChannel({ campaignId }),
    topics: ["progress"],
  });

  if (!token.key) {
    throw new Error("No realtime subscription token key returned");
  }

  return token;
};
