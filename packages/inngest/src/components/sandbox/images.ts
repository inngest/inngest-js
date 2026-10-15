import { z } from "zod/v3";
import type { SandboxClientConfig } from "./client.ts";
import { SandboxValidationError } from "./types.ts";
import { canonicalUuidSchema, parseWithSchema } from "./validation.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().nonnegative().safe());
const nameSchema = z
  .string()
  .regex(/^(?:inngest\/)?[a-z0-9][a-z0-9._-]{0,62}$/);
const tagSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const stringMap = z.record(z.string());

const configSchema = z.object({
  entrypoint: z.array(z.string()).optional(),
  cmd: z.array(z.string()).optional(),
  env: stringMap.optional(),
  workingDir: z.string().optional(),
  user: z.string().optional(),
  stopSignal: z.string().optional(),
  labels: stringMap.optional(),
  exposedPorts: z.array(z.string()).optional(),
  volumes: z.array(z.string()).optional(),
});
const recipeSchema = z.object({
  dockerfile: z
    .string()
    .min(1)
    .max(256 * 1024),
  target: z.string().optional(),
  buildArgs: stringMap.optional(),
  useCache: z.boolean().optional(),
  cacheEpoch: z.string().optional(),
  secrets: z.array(z.string()).optional(),
  registryAuth: stringMap.optional(),
});
const tagResponseSchema = z.object({
  name: tagSchema,
  digest: digest.nullish(),
  architecture: z.enum(["amd64", "arm64"]),
  immutable: z.boolean().default(false),
  deleted: z.boolean().default(false),
  generation: count,
});
const imageSchema = z.object({
  id: canonicalUuidSchema,
  name: nameSchema,
  scope: z.enum(["public", "workspace"]),
  createdAt: z.string(),
  tags: z.array(tagResponseSchema).default([]),
  artifacts: z
    .array(
      z.object({
        digest,
        state: z.string(),
        createdAt: z.string(),
        manifest: z.object({
          manifestVersion: z.number(),
          os: z.string(),
          architecture: z.string(),
          variant: z.string().optional(),
          rootfsSha256: digest,
          sizeBytes: count,
          config: configSchema.default({}),
          builder: z.string(),
        }),
      }),
    )
    .default([]),
  nextArtifactCursor: digest.nullish(),
});
const buildSchema = z.object({
  id: canonicalUuidSchema,
  sourceId: canonicalUuidSchema,
  state: z.enum([
    "queued",
    "running",
    "publishing",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  attemptCount: z.number().int().nonnegative().default(0),
  artifactDigest: digest.nullish(),
  cacheHit: z.boolean().default(false),
  tagUpdated: z.boolean().default(false),
  logs: z.string().default(""),
  errorMessage: z.string().default(""),
  status: z.enum(["pending", "uploaded", "ready", "failed"]),
  imageId: canonicalUuidSchema,
  architecture: z.enum(["amd64", "arm64"]),
  sourceType: z.enum([
    "docker_export",
    "dockerfile",
    "sdk_builder",
    "docker_registry",
  ]),
  config: configSchema.default({}),
  uploadSizeBytes: count,
  builderWorkloadId: canonicalUuidSchema.nullish(),
  executionMilliseconds: count.default(0),
  createdAt: z.string(),
  name: nameSchema,
  tag: tagSchema,
  imageRef: z.string().default(""),
});
const grantSchema = z.object({
  uploadId: canonicalUuidSchema,
  url: z.string().default(""),
  expiresAt: z.string(),
  headers: stringMap.default({}),
  alreadyUploaded: z.boolean().default(false),
  parts: z
    .array(
      z.object({
        number: z.number().int().positive(),
        offset: count.default(0),
        sizeBytes: count,
        url: z.string().url(),
        headers: stringMap.default({}),
      }),
    )
    .max(205)
    .default([]),
});
const usageSchema = z.object({
  storedBytes: count.default(0),
  uploadBytes: count.default(0),
  buildMilliseconds: count.default(0),
  conversionMilliseconds: count.default(0),
  activeBuilds: z.number().int().nonnegative().default(0),
});
const uploadSchema = z
  .object({
    id: canonicalUuidSchema,
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/),
    tag: tagSchema,
    expectedGeneration: count,
    immutableTag: z.boolean().optional(),
    sourceType: z
      .enum(["docker_export", "dockerfile", "sdk_builder"])
      .optional(),
    format: z.enum(["rootfs.tar.gz", "context.tar.gz"]),
    sha256: digest,
    sizeBytes: z
      .number()
      .int()
      .positive()
      .safe()
      .max(10 * 1024 ** 3),
    platform: z.literal("linux/amd64").default("linux/amd64"),
    config: configSchema.optional(),
    recipe: recipeSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.format === "context.tar.gz") !== Boolean(value.recipe)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Only context archives require a build recipe",
      });
    }
  });

export type ImageConfig = z.infer<typeof configSchema>;
export type ImageBuildRecipe = z.infer<typeof recipeSchema>;
export type Image = z.infer<typeof imageSchema>;
export type ImageTag = z.infer<typeof tagResponseSchema>;
export type ImageBuild = z.infer<typeof buildSchema>;
export type ImageUploadGrant = z.infer<typeof grantSchema>;
export type ImageUsage = z.infer<typeof usageSchema>;
export type ImageUploadRequest = z.input<typeof uploadSchema>;
export interface ImagePage<T> {
  items: T[];
  nextCursor?: string;
}
export interface ImageListOptions {
  cursor?: string;
  limit?: number;
}
export interface ImageBuildOptions {
  /** tar.gz build context. Omit for a Dockerfile that does not COPY local files. */
  context?: Blob;
  sourceType?: "dockerfile" | "sdk_builder";
  recipe: ImageBuildRecipe;
  name: string;
  tag?: string;
  /** Current generation, or zero for a new tag. Publication never overwrites a newer tag. */
  expectedGeneration?: number;
  immutableTag?: boolean;
  /** Keep this UUID when retrying an interrupted upload. */
  id?: string;
  signal?: AbortSignal;
}

export class ImageError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ImageError";
  }
}

export interface ImageClient {
  list(options?: ImageListOptions): Promise<ImagePage<Image>>;
  get(
    name: string,
    options?: { artifactCursor?: string },
  ): Promise<Image | null>;
  setTag(
    name: string,
    tag: string,
    digest: string,
    expectedGeneration: number,
    options?: { immutable?: boolean },
  ): Promise<ImageTag>;
  deleteTag(
    name: string,
    tag: string,
    expectedGeneration: number,
  ): Promise<ImageTag>;
  usage(): Promise<ImageUsage>;
  prepareUpload(request: ImageUploadRequest): Promise<ImageUploadGrant>;
  /** Sends only the storage grant headers, never Inngest API credentials. */
  uploadArchive(
    grant: ImageUploadGrant,
    archive: Blob,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  completeUpload(uploadId: string): Promise<string>;
  /** Uploads a context and queues a remote build; returns without waiting for it. */
  build(options: ImageBuildOptions): Promise<string>;
  builds: {
    list(options?: ImageListOptions): Promise<ImagePage<ImageBuild>>;
    get(buildId: string): Promise<ImageBuild>;
    cancel(buildId: string): Promise<ImageBuild>;
    waitUntilReady(
      buildId: string,
      options?: { timeoutMs?: number; signal?: AbortSignal },
    ): Promise<ImageBuild>;
  };
}

const imagePath = (name: string) =>
  `/v2/images/${parseWithSchema(nameSchema, name, "image name").split("/").map(encodeURIComponent).join("/")}`;
const buildPath = (id: string) =>
  `/v2/image-builds/${parseWithSchema(canonicalUuidSchema, id, "build ID")}`;
const pageQuery = (options: ImageListOptions = {}) => {
  const parsed = parseWithSchema(
    z
      .object({
        cursor: canonicalUuidSchema.optional(),
        limit: z.number().int().min(1).max(250).default(50),
      })
      .strict(),
    options,
    "image list options",
  );
  return new URLSearchParams({
    limit: `${parsed.limit}`,
    ...(parsed.cursor && { cursor: parsed.cursor }),
  });
};

export const createImageClient = (config: SandboxClientConfig): ImageClient => {
  const request = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> => {
    const key = config.apiKey()?.trim();
    if (!key && !config.isDev?.())
      throw new SandboxValidationError(
        "An API or signing key is required to use images",
      );
    let response: Response;
    try {
      response = await config.fetch()(new URL(path, config.baseUrl()), {
        method,
        redirect: "error",
        headers: {
          ...config.headers(),
          ...(key && { Authorization: `Bearer ${key}` }),
          ...(body !== undefined && { "Content-Type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ImageError(
        "Image API response was not confirmed; retry with the same upload ID or tag generation",
      );
    }
    if (!response.ok) {
      const envelope = z
        .object({
          errors: z.array(z.object({ code: z.string(), message: z.string() })),
        })
        .safeParse(await response.json().catch(() => null));
      const error = envelope.success ? envelope.data.errors[0] : undefined;
      throw new ImageError(
        error?.message ?? "Image API request failed",
        response.status,
        error?.code,
      );
    }
    return parseWithSchema(
      z.record(z.unknown()),
      await response.json(),
      "image API response",
    );
  };
  const page = async <T, Input>(
    path: string,
    schema: z.ZodType<T, z.ZodTypeDef, Input>,
    options?: ImageListOptions,
  ): Promise<ImagePage<T>> => {
    const response = await request("GET", `${path}?${pageQuery(options)}`);
    const parsed = parseWithSchema(
      z.object({
        data: z.array(schema).default([]),
        nextCursor: canonicalUuidSchema.nullish(),
      }),
      response,
      "image page",
    );
    return {
      items: parsed.data,
      ...(parsed.nextCursor && { nextCursor: parsed.nextCursor }),
    };
  };
  const client: ImageClient = {
    list: (options) => page("/v2/images", imageSchema, options),
    get: async (name, options) => {
      const cursor = options?.artifactCursor;
      const query = cursor
        ? `?artifactCursor=${parseWithSchema(digest, cursor, "artifact cursor")}`
        : "";
      try {
        return parseWithSchema(
          imageSchema,
          (await request("GET", `${imagePath(name)}${query}`)).data,
          "image",
        );
      } catch (error) {
        if (error instanceof ImageError && error.status === 404) return null;
        throw error;
      }
    },
    setTag: async (name, tag, artifactDigest, expectedGeneration, options) => {
      const body = parseWithSchema(
        z.object({
          digest,
          expectedGeneration: count,
          immutable: z.boolean().optional(),
        }),
        {
          digest: artifactDigest,
          expectedGeneration,
          immutable: options?.immutable,
        },
        "image tag",
      );
      return parseWithSchema(
        tagResponseSchema,
        (
          await request(
            "PUT",
            `${imagePath(name)}/tags/${parseWithSchema(tagSchema, tag, "tag")}`,
            body,
          )
        ).data,
        "image tag",
      );
    },
    deleteTag: async (name, tag, expectedGeneration) =>
      parseWithSchema(
        tagResponseSchema,
        (
          await request(
            "DELETE",
            `${imagePath(name)}/tags/${parseWithSchema(tagSchema, tag, "tag")}?expectedGeneration=${parseWithSchema(count, expectedGeneration, "tag generation")}`,
          )
        ).data,
        "image tag",
      ),
    usage: async () =>
      parseWithSchema(
        usageSchema,
        (await request("GET", "/v2/image-usage")).data,
        "image usage",
      ),
    prepareUpload: async (input) => {
      const grant = parseWithSchema(
        grantSchema,
        (
          await request(
            "POST",
            "/v2/image-uploads",
            parseWithSchema(uploadSchema, input, "image upload"),
          )
        ).data,
        "upload grant",
      );
      if (grant.uploadId !== input.id)
        throw new SandboxValidationError(
          "Image API returned a different upload ID",
        );
      return grant;
    },
    uploadArchive: async (input, archive, options) => {
      const grant = parseWithSchema(grantSchema, input, "upload grant");
      if (grant.alreadyUploaded) return;
      const multipart = grant.parts.length > 0;
      const parts = multipart
        ? grant.parts
        : [
            {
              number: 1,
              offset: 0,
              sizeBytes: archive.size,
              url: grant.url,
              headers: grant.headers,
            },
          ];
      let offset = 0;
      for (const [index, part] of parts.entries()) {
        if (
          part.number !== index + 1 ||
          part.offset !== offset ||
          part.sizeBytes <= 0 ||
          part.sizeBytes > archive.size - offset
        )
          throw new SandboxValidationError("Invalid image upload byte ranges");
        offset += part.sizeBytes;
      }
      if (offset !== archive.size)
        throw new SandboxValidationError(
          "Image upload ranges do not cover the archive",
        );
      for (const part of parts) {
        const url = new URL(part.url);
        if (url.protocol !== "https:" || url.username || url.password)
          throw new SandboxValidationError(
            "Image uploads require an HTTPS storage grant",
          );
        let response: Response;
        try {
          response = await config.fetch()(url, {
            method: "PUT",
            body: archive.slice(part.offset, part.offset + part.sizeBytes),
            headers: part.headers,
            redirect: "error",
            credentials: "omit",
            signal: options?.signal,
          });
        } catch {
          throw new ImageError(
            "Image upload response was not confirmed; retry this upload or complete it with the same ID",
          );
        }
        // The write-once object may already exist after an ambiguous response.
        // Completion seals it; workers verify the declared length and checksum.
        if (!response.ok && !(response.status === 412 && !multipart))
          throw new ImageError("Image archive upload failed", response.status);
      }
    },
    completeUpload: async (id) =>
      parseWithSchema(
        canonicalUuidSchema,
        (
          await request(
            "POST",
            `/v2/image-uploads/${parseWithSchema(canonicalUuidSchema, id, "upload ID")}/complete`,
            {},
          )
        ).buildId,
        "build ID",
      ),
    build: async (options) => {
      // Browser-compatible, bounded convenience path. For larger contexts use
      // the CLI or prepareUpload with a streaming checksum calculated by caller.
      const archive = options.context ?? (await emptyContext());
      if (archive.size > 64 * 1024 ** 2)
        throw new SandboxValidationError(
          "Use the CLI or prepareUpload for contexts larger than 64 MiB",
        );
      options.signal?.throwIfAborted();
      const bytes = await archive.arrayBuffer();
      const sha256 = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      const id = options.id ?? crypto.randomUUID();
      const upload = {
        id,
        name: options.name,
        tag: options.tag ?? "latest",
        expectedGeneration: options.expectedGeneration ?? 0,
        immutableTag: options.immutableTag,
        sourceType: options.sourceType ?? "dockerfile",
        format: "context.tar.gz" as const,
        sha256,
        sizeBytes: archive.size,
        recipe: options.recipe,
      };
      const grant = await client.prepareUpload(upload);
      await client.uploadArchive(grant, archive, { signal: options.signal });
      return client.completeUpload(id);
    },
    builds: {
      list: (options) => page("/v2/image-builds", buildSchema, options),
      get: async (id) =>
        parseWithSchema(
          buildSchema,
          (await request("GET", buildPath(id))).data,
          "image build",
        ),
      cancel: async (id) =>
        parseWithSchema(
          buildSchema,
          (await request("POST", `${buildPath(id)}/cancel`, {})).data,
          "image build",
        ),
      waitUntilReady: async (id, options = {}) => {
        const timeout = parseWithSchema(
          z
            .number()
            .int()
            .min(1)
            .max(4 * 60 * 60_000),
          options.timeoutMs ?? 40 * 60_000,
          "image build timeout",
        );
        const deadline = Date.now() + timeout;
        for (;;) {
          options.signal?.throwIfAborted();
          const build = await client.builds.get(id);
          if (build.state === "succeeded") return build;
          if (build.state === "failed" || build.state === "cancelled")
            throw new ImageError(
              build.errorMessage || `Image build ${build.state}`,
            );
          if (Date.now() >= deadline)
            throw new ImageError(
              "Timed out waiting for the image build; it continues in the background",
            );
          await sleep(Math.min(2000, deadline - Date.now()), options.signal);
        }
      },
    },
  };
  return client;
};

const emptyContext = async (): Promise<Blob> => {
  const stream = new Blob([new Uint8Array(1024)])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      signal.removeEventListener("abort", abort);
      abort();
    }
  });

export interface ImageDefinition {
  from: string;
  steps?: (
    | { run: string[] }
    | { copy: [string, string] }
    | { env: Record<string, string> }
    | { workdir: string }
    | { user: string }
  )[];
  entrypoint?: string[];
  cmd?: string[];
}

/** Deterministic Dockerfile DSL. Cache identity also includes context bytes,
 * builder version and recipe options; a DSL hash alone is never a cache key. */
export const defineImage = (definition: ImageDefinition): ImageBuildRecipe => {
  const from = parseWithSchema(
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/),
    definition.from,
    "base image",
  );
  const lineValue = (value: string) =>
    parseWithSchema(
      z
        .string()
        .min(1)
        .refine((value) => !value.includes("\0") && !/[\r\n]/.test(value)),
      value,
      "Dockerfile value",
    );
  const argv = (value: string[]) =>
    parseWithSchema(
      z.array(z.string().refine((value) => !value.includes("\0"))).min(1),
      value,
      "image command",
    );
  const lines = [`FROM ${from}`];
  for (const instruction of definition.steps ?? []) {
    if ("run" in instruction)
      lines.push(`RUN ${JSON.stringify(argv(instruction.run))}`);
    else if ("copy" in instruction)
      lines.push(`COPY ${JSON.stringify(instruction.copy.map(lineValue))}`);
    else if ("workdir" in instruction)
      lines.push(`WORKDIR ${JSON.stringify(lineValue(instruction.workdir))}`);
    else if ("user" in instruction)
      lines.push(`USER ${lineValue(instruction.user)}`);
    else if ("env" in instruction)
      for (const key of Object.keys(instruction.env).sort()) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
          throw new SandboxValidationError("Invalid image environment name");
        lines.push(
          `ENV ${key}=${JSON.stringify(lineValue(instruction.env[key] ?? ""))}`,
        );
      }
  }
  if (definition.entrypoint !== undefined)
    lines.push(`ENTRYPOINT ${JSON.stringify(definition.entrypoint)}`);
  if (definition.cmd !== undefined)
    lines.push(`CMD ${JSON.stringify(definition.cmd)}`);
  return { dockerfile: `${lines.join("\n")}\n` };
};
