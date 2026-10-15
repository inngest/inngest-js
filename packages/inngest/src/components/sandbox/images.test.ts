import { createSandboxClient } from "./client.ts";
import { createImageClient, defineImage, ImageError } from "./images.ts";
import { parseSandboxOperation } from "./protocol.ts";
import { normalizeSandboxCreateOptions } from "./validation.ts";

const id = "22222222-2222-4222-8222-222222222222";
const workspace = "11111111-1111-4111-8111-111111111111";
const sha = "a".repeat(64);
const now = "2026-10-01T00:00:00Z";
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const setup = () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const config = {
    baseUrl: () => "https://api.example.test/",
    apiKey: () => "api-secret",
    headers: () => ({ "x-inngest-env": "test" }),
    fetch: () => fetch,
  };
  return { fetch, config, images: createImageClient(config) };
};
const build = {
  id,
  imageId: id,
  status: "ready",
  architecture: "amd64",
  sourceType: "docker_export",
  uploadSizeBytes: "128",
  artifactDigest: sha,
  sourceId: id,
  name: "app",
  tag: "latest",
  state: "succeeded",
  createdAt: now,
  imageRef: `app@sha256:${sha}`,
};

describe("image client", () => {
  test("multipart upload sends exact byte ranges and completed retries skip storage", async () => {
    const { images, fetch } = setup();
    const grant = {
      uploadId: id,
      url: "",
      expiresAt: now,
      headers: {},
      alreadyUploaded: false,
      parts: [
        {
          number: 1,
          offset: 0,
          sizeBytes: 3,
          url: "https://storage.test/part1",
          headers: {},
        },
        {
          number: 2,
          offset: 3,
          sizeBytes: 2,
          url: "https://storage.test/part2",
          headers: {},
        },
      ],
    };
    fetch.mockResolvedValue(new Response(null, { status: 200 }));
    await images.uploadArchive(grant, new Blob(["abcde"]));
    expect(await (fetch.mock.calls[0]?.[1]?.body as Blob).text()).toBe("abc");
    expect(await (fetch.mock.calls[1]?.[1]?.body as Blob).text()).toBe("de");
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({});
    await images.uploadArchive(
      { ...grant, alreadyUploaded: true },
      new Blob(["abcde"]),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(
      images.uploadArchive(
        { ...grant, parts: [grant.parts[1]!] },
        new Blob(["abcde"]),
      ),
    ).rejects.toThrow("byte ranges");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  test("uses lazy credentials and preserves tag generations and immutable identities", async () => {
    const { images, fetch } = setup();
    fetch.mockResolvedValueOnce(
      json({
        data: {
          id,
          name: "app",
          scope: "workspace",
          createdAt: now,
          tags: [
            {
              name: "latest",
              digest: sha,
              architecture: "amd64",
              immutable: false,
              deleted: false,
              generation: "7",
            },
          ],
        },
      }),
    );
    expect((await images.get("app"))?.tags[0]?.generation).toBe(7);
    fetch.mockResolvedValueOnce(
      json({
        data: {
          name: "latest",
          generation: "8",
          digest: sha,
          architecture: "amd64",
          immutable: false,
          deleted: false,
        },
      }),
    );
    await images.setTag("app", "latest", sha, 7);
    expect(fetch.mock.calls[1]?.[0].toString()).toBe(
      "https://api.example.test/v2/images/app/tags/latest",
    );
    expect(JSON.parse(fetch.mock.calls[1]?.[1]?.body as string)).toEqual({
      digest: sha,
      expectedGeneration: 7,
    });
    fetch.mockResolvedValueOnce(json({ data: build }));
    expect((await images.builds.get(id)).imageRef).toBe(`app@sha256:${sha}`);
  });

  test("uploads with storage headers and without API credentials, then seals the upload", async () => {
    const { images, fetch } = setup();
    const grant = {
      uploadId: id,
      alreadyUploaded: false,
      parts: [],
      url: "https://storage.example.test/blob?signed=grant",
      expiresAt: now,
      headers: { "If-None-Match": "*" },
    };
    fetch
      .mockResolvedValueOnce(json({ data: grant }))
      .mockResolvedValueOnce(new Response(null, { status: 412 }))
      .mockResolvedValueOnce(json({ buildId: id }));
    expect(
      await images.build({
        id,
        name: "app",
        recipe: defineImage({ from: "scratch" }),
      }),
    ).toBe(id);
    const request = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string);
    expect(request).toMatchObject({
      name: "app",
      platform: "linux/amd64",
      format: "context.tar.gz",
      recipe: { dockerfile: "FROM scratch\n" },
    });
    const upload = fetch.mock.calls[1]?.[1];
    expect(upload?.headers).toEqual({ "If-None-Match": "*" });
    expect(upload?.credentials).toBe("omit");
    expect(upload?.redirect).toBe("error");
    const archive = upload?.body as Blob;
    const actualHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", await archive.arrayBuffer()),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    expect(request.sha256).toBe(actualHash);
    expect(request.sizeBytes).toBe(archive.size);
  });

  test("a repeated ID validates the complete input before completing", async () => {
    const { images, fetch } = setup();
    fetch.mockResolvedValueOnce(
      json(
        {
          errors: [{ code: "image_conflict", message: "Upload input changed" }],
        },
        409,
      ),
    );
    await expect(
      images.build({
        id,
        name: "changed",
        recipe: { dockerfile: "FROM scratch" },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      "https://api.example.test/v2/image-uploads",
    );
  });

  test.each(["failed", "cancelled"])(
    "does not wait forever for a %s build",
    async (state) => {
      const { images, fetch } = setup();
      fetch.mockResolvedValueOnce(
        json({ data: { ...build, state, status: "failed" } }),
      );
      await expect(images.builds.waitUntilReady(id)).rejects.toBeInstanceOf(
        ImageError,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  test("rejects unsafe input before making a request", async () => {
    const { images, fetch } = setup();
    await expect(images.get("../another/path")).rejects.toThrow();
    await expect(images.setTag("app", "../other", id, 0)).rejects.toThrow();
    await expect(
      images.uploadArchive(
        {
          uploadId: id,
          alreadyUploaded: false,
          parts: [],
          url: "http://storage.test/blob",
          expiresAt: now,
          headers: {},
        },
        new Blob([]),
      ),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("canonical DSL is stable across map ordering and rejects instruction injection", () => {
    const a = defineImage({
      from: "debian@sha256:abc",
      steps: [
        { env: { Z: "last", A: "first" } },
        { run: ["/bin/echo", "hello"] },
      ],
    });
    const b = defineImage({
      from: "debian@sha256:abc",
      steps: [
        { env: { A: "first", Z: "last" } },
        { run: ["/bin/echo", "hello"] },
      ],
    });
    expect(a).toEqual(b);
    expect(() => defineImage({ from: "scratch\nRUN malicious" })).toThrow();
    expect(() =>
      defineImage({ from: "scratch", steps: [{ user: "root\nRUN unwanted" }] }),
    ).toThrow();
  });
});

describe("sandbox image selection", () => {
  const options = {
    name: "custom",
    vcpu: 2,
    memoryMb: 1024,
    image: `app@sha256:${sha}`,
    imageOptions: {
      startupMode: "image" as const,
      entrypoint: [],
      cmd: ["/app"],
      user: "1000",
      workingDir: "/work",
    },
    runningTimeout: false as const,
  };

  test.each(["PENDING", "STARTING"])(
    "preserves image options and identity while %s",
    async (status) => {
      const { config, fetch } = setup();
      fetch.mockResolvedValueOnce(
        json(
          {
            data: {
              id,
              name: "custom",
              status,
              vpcId: workspace,
              imageRef: options.image,
              resolvedImageRef: options.image,
              imageDigest: sha,
              imageStartupMode: "image",
              resources: { vcpu: 2, memoryMb: 1024 },
              createdAt: now,
            },
          },
          202,
        ),
      );
      const sandbox = await createSandboxClient(config).create(options);
      expect(sandbox.status).toBe(status);
      expect(sandbox.imageDigest).toBe(sha);
      expect(sandbox.resolvedImageRef).toBe(options.image);
      expect(
        JSON.parse(fetch.mock.calls[0]?.[1]?.body as string).imageOptions,
      ).toEqual({
        startupMode: "image",
        entrypoint: { argv: [] },
        cmd: { argv: ["/app"] },
        user: "1000",
        workingDir: "/work",
      });
      const normalized = normalizeSandboxCreateOptions(options);
      expect(
        parseSandboxOperation({
          protocolVersion: 1,
          action: "create",
          input: [normalized],
        }).input,
      ).toEqual([normalized]);
    },
  );

  test.each([
    { ...options, image: undefined },
    { name: "clone", snapshotId: id, image: "app" },
    { ...options, image: "app@sha256:invalid" },
  ])("rejects conflicting image options", (value) => {
    expect(() =>
      normalizeSandboxCreateOptions(value as typeof options),
    ).toThrow();
  });
});
