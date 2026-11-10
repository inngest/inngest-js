import { afterEach, describe, expect, test, vi } from "vitest";
import { envKeys } from "../../helpers/consts.ts";
import { Inngest } from "../Inngest.ts";
import { connect } from "./index.ts";
import { getHostname } from "./os.ts";
import { createStrategy } from "./strategies/index.ts";

vi.mock("./strategies/index.ts", () => ({
  createStrategy: vi.fn(async () => ({
    connect: async () => {},
    close: async () => {},
  })),
}));

const createClient = (id = "test-app") => {
  const headers: Headers[] = [];
  const fetchMock: typeof fetch = vi.fn(async (_input, init) => {
    headers.push(new Headers(init?.headers));
    return new Response(null, { status: 200 });
  });
  const client = new Inngest({
    id,
    isDev: true,
    fetch: fetchMock,
  });

  const checkpoint = () =>
    client["inngestApi"].checkpointSteps({
      runId: "run-id",
      fnId: "fn-id",
      appId: "app-id",
      steps: [],
    });

  return { client, headers, checkpoint };
};

describe("connect instance ID on checkpoint requests", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(createStrategy).mockClear();
  });

  test("sends the instanceId passed to connect", async () => {
    vi.stubEnv(envKeys.InngestConnectInstanceId, "instance-from-env");
    const { client, headers, checkpoint } = createClient();

    await connect({
      apps: [{ client }],
      instanceId: "instance-from-option",
    });
    await checkpoint();

    expect(headers[0]?.get("x-inngest-instance-id")).toBe(
      "instance-from-option",
    );
  });

  test("uses INNGEST_CONNECT_INSTANCE_ID when connect has no instanceId", async () => {
    vi.stubEnv(envKeys.InngestConnectInstanceId, "instance-from-env");
    const { client, headers, checkpoint } = createClient();

    await connect({ apps: [{ client }] });
    await checkpoint();

    expect(headers[0]?.get("x-inngest-instance-id")).toBe("instance-from-env");
    expect(vi.mocked(createStrategy).mock.calls[0]?.[1].instanceId).toBe(
      "instance-from-env",
    );
  });

  test("sends the hostname when no instance ID is set", async () => {
    vi.stubEnv(envKeys.InngestConnectInstanceId, "");
    const { client, headers, checkpoint } = createClient();

    await connect({ apps: [{ client }] });
    await checkpoint();

    expect(headers[0]?.get("x-inngest-instance-id")).toBe(await getHostname());
  });

  test("sends the instance ID for every connected app", async () => {
    const first = createClient("first-app");
    const second = createClient("second-app");

    await connect({
      apps: [{ client: first.client }, { client: second.client }],
      instanceId: "shared-instance",
    });
    await first.checkpoint();
    await second.checkpoint();

    expect(first.headers[0]?.get("x-inngest-instance-id")).toBe(
      "shared-instance",
    );
    expect(second.headers[0]?.get("x-inngest-instance-id")).toBe(
      "shared-instance",
    );
  });
});
