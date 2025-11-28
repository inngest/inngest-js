import { headerKeys } from "../../helpers/consts.ts";
import type { Inngest } from "../Inngest.ts";
import { createStartRequest, parseStartResponse } from "./messages.ts";
import { AuthError, ConnectionLimitError, ReconnectError } from "./util";

export async function sendStartRequest({
  excludeGateways,
  signingKey,
  env,
  inngest,
}: {
  inngest: Inngest.Any;
  excludeGateways: string[];
  signingKey?: string;
  env?: string;
}) {
  const msg = createStartRequest(excludeGateways);

  const headers: Record<string, string> = {
    "Content-Type": "application/protobuf",
    ...(signingKey ? { Authorization: `Bearer ${signingKey}` } : {}),
  };

  if (env) {
    headers[headerKeys.Environment] = env;
  }

  // refactor this to a more universal spot
  const targetUrl =
    await inngest["inngestApi"]["getTargetUrl"]("/v0/connect/start");

  let resp;
  try {
    resp = await fetch(targetUrl, {
      method: "POST",
      body: new Uint8Array(msg),
      headers: headers,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    throw new ReconnectError(
      `Failed initial API handshake request to ${targetUrl.toString()}, ${errMsg}`,
    );
  }

  if (!resp.ok) {
    if (resp.status === 401) {
      throw new AuthError(
        `Failed initial API handshake request to ${targetUrl.toString()}${
          env ? ` (env: ${env})` : ""
        }, ${await resp.text()}`,
      );
    }

    if (resp.status === 429) {
      throw new ConnectionLimitError();
    }

    throw new ReconnectError(
      `Failed initial API handshake request to ${targetUrl.toString()}, ${await resp.text()}`,
    );
  }

  const startResp = await parseStartResponse(resp);

  return startResp;
}
