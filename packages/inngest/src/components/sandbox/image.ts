/**
 * `image`: the images a Sandbox can start from, passed as `from` to
 * `sandboxes.create()` and `step.sandbox.create()`. Each helper only names an
 * image; Create resolves it to the wire `image` string and validates it.
 *
 * @module
 */

/**
 * An image for a Sandbox to start from, made by `image.inngest()` or
 * `image.custom()`.
 */
export interface SandboxImage {
  readonly kind: "inngest/sandbox.image";
  /** The catalog reference sent as the Create `image`. */
  readonly ref: string;
}

/** Whether a value is a {@link SandboxImage}. */
export const isSandboxImage = (value: unknown): value is SandboxImage => {
  return (value as SandboxImage | undefined)?.kind === "inngest/sandbox.image";
};

const make = (ref: string): SandboxImage => {
  return Object.freeze({ kind: "inngest/sandbox.image", ref });
};

export const image = {
  /**
   * An image Inngest maintains, such as `image.inngest("base")`. Omit `from`
   * to use the default.
   */
  inngest: (
    /** The image's name in Inngest's catalog. */
    name: string,
  ): SandboxImage => {
    return make(`inngest/${name}`);
  },

  /**
   * An image published to your workspace: `"my-image"`, `"my-image:v1"`, or
   * `"my-image@sha256:<hex>"`.
   */
  custom: (
    /** The image reference, validated when the Sandbox is created. */
    ref: string,
  ): SandboxImage => {
    return make(ref);
  },
};
