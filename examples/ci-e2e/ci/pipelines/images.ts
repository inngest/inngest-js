import { $, image } from "@inngest/ci";

import { ci, inngest, trigger } from "../client.ts";

/** Captures the snapshot `e2e-img`, with a marker file in it. */
export const imageCapture = ci.pipeline(
  { id: "image-capture", on: trigger("image-capture") },
  async () => {
    const sandbox = await inngest.sandboxes.create({
      name: `e2e-img-capture-${Date.now()}`,
      vcpu: 1,
      memoryMb: 1024,
    });

    try {
      await sandbox.commands.run(["/bin/sh", "-c", "echo e2e > /e2e-marker"]);
      await sandbox.snapshot({ name: "e2e-img" });
    } finally {
      await sandbox.destroy();
    }
  },
);

const fromImage = ci.job(
  { id: "from-image", from: image.snapshot("e2e-img") },
  async () => {
    await $`test -f /e2e-marker`;
  },
);

/** A job that starts from the snapshot `e2e-img`: run `image-capture` first. */
export const imageStart = ci.pipeline(
  { id: "image-start", on: trigger("image-start") },
  async () => {
    await fromImage();
  },
);

const fromMissingImage = ci.job(
  { id: "from-missing-image", from: image.snapshot("e2e-does-not-exist") },
  async () => {
    await $`echo unreachable`;
  },
);

/** A snapshot name that doesn't exist: expect an error naming it. */
export const imageMissing = ci.pipeline(
  { id: "image-missing", on: trigger("image-missing") },
  async () => {
    await fromMissingImage();
  },
);
