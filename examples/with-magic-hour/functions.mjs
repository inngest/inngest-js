import { Inngest, NonRetriableError } from "inngest";
import { Client } from "magic-hour";

export const inngest = new Inngest({ id: "magic-hour-media-example" });
const requestOptions = { timeout: 20_000, retries: { maxRetries: 0 } };

function client() {
  const token = process.env.MAGIC_HOUR_API_KEY;
  if (!token) {
    throw new NonRetriableError("Set MAGIC_HOUR_API_KEY on the app process.");
  }
  return new Client({ token, baseUrl: "https://api.magichour.ai" });
}

function kind(value) {
  if (value !== "image" && value !== "video") {
    throw new NonRetriableError("kind must be image or video.");
  }
  return value;
}

function projectId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new NonRetriableError("Provide an accepted Magic Hour project ID.");
  }
  return value;
}

async function request(call, message) {
  try {
    return await call();
  } catch {
    // SDK errors can contain request/response data. Do not log or attach them.
    throw new NonRetriableError(message);
  }
}

async function readProject(mediaKind, id) {
  const api = client();
  const project = await request(
    () =>
      (mediaKind === "image" ? api.v1.imageProjects : api.v1.videoProjects).get(
        { id },
        requestOptions,
      ),
    "Project retrieval failed. Send another recovery event with the same ID.",
  );
  if (project.id !== id) {
    throw new NonRetriableError("Magic Hour returned a different project ID.");
  }
  return project;
}

export const createMedia = inngest.createFunction(
  {
    id: "magic-hour-create-media",
    retries: 0,
    triggers: { event: "magichour/media.create" },
  },
  async ({ event, step }) => {
    const mediaKind = kind(event.data.kind);
    const prompt = event.data.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new NonRetriableError("Provide a nonempty image or motion prompt.");
    }
    const sourceId =
      mediaKind === "video" ? projectId(event.data.imageProjectId) : null;
    const accepted = await step.run("create-one-project", async () => {
      const api = client();
      let response;
      const unknown =
        "Creation acceptance is unknown. Check Magic Hour projects before creating again; recover a known ID instead.";
      if (mediaKind === "image") {
        response = await request(
          () =>
            api.v1.aiImageGenerator.create(
              {
                imageCount: 1,
                model: "z-image-turbo",
                resolution: "640px",
                aspectRatio: "1:1",
                style: { prompt, tool: "general" },
              },
              requestOptions,
            ),
          unknown,
        );
      } else {
        const image = await readProject("image", sourceId);
        const imageUrl = image.downloads?.[0]?.url;
        if (
          image.status !== "complete" ||
          typeof imageUrl !== "string" ||
          !imageUrl.startsWith("https://")
        ) {
          throw new NonRetriableError(
            "The source image is not ready. Recover it before creating a video.",
          );
        }
        response = await request(
          () =>
            api.v1.imageToVideo.create(
              {
                assets: { imageFilePath: imageUrl },
                model: "ltx-2.5",
                resolution: "480p",
                endSeconds: 3,
                audio: false,
                style: { prompt },
              },
              requestOptions,
            ),
          unknown,
        );
      }
      if (
        typeof response.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(response.id)
      ) {
        throw new NonRetriableError(unknown);
      }
      return {
        kind: mediaKind,
        projectId: response.id,
        creditsCharged: response.creditsCharged,
      };
    });
    // The accepted ID is checkpointed before the read-only workflow is triggered.
    await step.sendEvent("recover-accepted-project", {
      name: "magichour/media.recover",
      data: accepted,
    });
    return accepted;
  },
);

export const recoverMedia = inngest.createFunction(
  {
    id: "magic-hour-recover-media",
    retries: 0,
    triggers: { event: "magichour/media.recover" },
  },
  async ({ event, step }) => {
    const mediaKind = kind(event.data.kind);
    const id = projectId(event.data.projectId);
    let result;
    for (let attempt = 0; attempt < 24; attempt++) {
      result = await step.run(`read-project-${attempt}`, async () => {
        const project = await readProject(mediaKind, id);
        return {
          kind: mediaKind,
          projectId: id,
          status: project.status,
          creditsCharged: project.creditsCharged,
          downloads: project.status === "complete" ? project.downloads : [],
          errorCode: project.error?.code ?? null,
        };
      });
      if (
        result.status !== "queued" &&
        result.status !== "rendering" &&
        result.status !== "draft"
      ) {
        return result;
      }
      if (attempt < 23) {
        await step.sleep(`wait-for-project-${attempt}`, "5s");
      }
    }
    return { ...result, pending: true };
  },
);

export const functions = [createMedia, recoverMedia];
