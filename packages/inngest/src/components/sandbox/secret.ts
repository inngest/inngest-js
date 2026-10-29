/**
 * @module
 * EXPERIMENTAL: `secret()`, a reference to a credential that is read where it
 * is used and nowhere else. Step outputs are stored and shown in traces, so a
 * credential must only exist inside the call that needs it; a `Secret` is
 * what you hold in a definition instead of the value.
 */
import { NonRetriableError } from "../NonRetriableError.ts";

/**
 * Where a secret's value comes from: the name of an environment variable, or
 * a function that returns the value (for a token that depends on the tenant).
 */
export type SecretSource = string | (() => string | Promise<string>);

const secretValue = new WeakMap<Secret, SecretSource>();

/**
 * A credential that is not read until a call needs it. It never becomes text
 * by accident: printing it, logging it or putting it in JSON gives its label.
 */
export class Secret {
  readonly label: string;

  constructor(source: SecretSource) {
    this.label = typeof source === "string" ? source : "function";
    secretValue.set(this, source);
  }

  /**
   * Reads the value. Call it inside the step that uses it, never in a step's
   * return value.
   */
  async value(): Promise<string> {
    const source = secretValue.get(this) as SecretSource;
    const value =
      typeof source === "string"
        ? (globalThis as { process?: { env?: Record<string, string> } })
            .process?.env?.[source]
        : await source();

    if (typeof value !== "string" || value === "") {
      throw new SecretMissingError(this.label);
    }

    return value;
  }

  toString(): string {
    return `[secret ${this.label}]`;
  }

  toJSON(): string {
    return this.toString();
  }
}

/**
 * Thrown when a secret has no value. A retry can't fix it.
 */
export class SecretMissingError extends NonRetriableError {
  constructor(label: string) {
    super(
      label === "function"
        ? "A secret resolver returned no value"
        : `Secret ${label} is not set: set the environment variable ${label}`,
    );
    this.name = "SecretMissingError";
  }
}

/**
 * EXPERIMENTAL: Refers to a credential without holding it. Pass the name of an
 * environment variable, or a function for a value that depends on the caller.
 * It is read inside the call that uses it, so it never reaches a step output,
 * a trace, the model or a sandbox.
 *
 * @example
 * ```ts
 * tool.mcp({
 *   url: "https://app.hex.tech/mcp",
 *   auth: { bearer: secret("HEX_TOKEN") },
 * });
 * ```
 */
export const secret = (
  /**
   * The environment variable's name, or a function that returns the value.
   */
  source: SecretSource,
): Secret => {
  return new Secret(source);
};

/**
 * Whether `value` is a `Secret`.
 */
export const isSecret = (value: unknown): value is Secret => {
  return value instanceof Secret;
};

/**
 * Replaces every occurrence of the values in `text`, so a message that
 * echoes a credential doesn't carry it on.
 */
export const redact = (text: string, values: readonly string[]): string => {
  let out = text;

  for (const value of values) {
    if (value.length >= 4) {
      out = out.split(value).join("[redacted]");
    }
  }

  return out;
};
