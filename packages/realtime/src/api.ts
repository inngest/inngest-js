import { z } from "zod";
import { getEnvVar } from "./env";
import { fetchWithAuthFallback, parseAsBoolean } from "./util";

const tokenSchema = z.object({ jwt: z.string() });

export const api = {
  async getSubscriptionToken({
    channel,
    topics,
    signingKey,
    signingKeyFallback,
    apiBaseUrl,
  }: {
    channel: string;
    topics: string[];
    signingKey: string | undefined;
    signingKeyFallback: string | undefined;
    apiBaseUrl: string | undefined;
  }): Promise<string> {
    let url: URL;
    const path = "/v1/realtime/token";
    const inputBaseUrl =
      apiBaseUrl ||
      getEnvVar("INNGEST_BASE_URL") ||
      getEnvVar("INNGEST_API_BASE_URL");

    const devEnvVar = getEnvVar("INNGEST_DEV");

    if (inputBaseUrl) {
      url = new URL(path, inputBaseUrl);
    } else if (devEnvVar) {
      try {
        const devUrl = new URL(devEnvVar);
        url = new URL(path, devUrl);
      } catch {
        if (parseAsBoolean(devEnvVar)) {
          url = new URL(path, "http://localhost:8288/");
        } else {
          url = new URL(path, "https://api.inngest.com/");
        }
      }
    } else {
      url = new URL(
        path,
        getEnvVar("NODE_ENV") === "production"
          ? "https://api.inngest.com/"
          : "http://localhost:8288/",
      );
    }

    const body = topics.map((topic) => ({
      channel,
      name: topic,
      kind: "run",
    }));

    const res = await fetchWithAuthFallback({
      authToken: signingKey,
      authTokenFallback: signingKeyFallback,
      fetch,
      url,
      options: {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "Content-Type": "application/json",
        },
      },
    });

    if (!res.ok) {
      throw new Error(
        `Failed to get subscription token: ${res.status} ${
          res.statusText
        } - ${await res.text()}`,
      );
    }

    const data = await res.json();
    return tokenSchema.parse(data).jwt;
  },
};
