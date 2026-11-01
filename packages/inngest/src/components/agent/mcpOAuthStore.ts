/**
 * @module
 * EXPERIMENTAL: `kvOAuthStore()`, the default place `tool.mcp()` keeps OAuth
 * tokens: the agents KV's store (Redis, D1 or the one `createAgents` was
 * given), with every value encrypted at rest using AES-256-GCM.
 *
 * It talks to the store directly, not through `kv`, because it runs inside the
 * step that makes a tool call, where a nested step is not allowed.
 */
import { getAsyncCtxSync } from "../execution/als.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import type { McpOAuthStore } from "../sandbox/mcpOAuth.ts";
import { Secret } from "../sandbox/secret.ts";
import { type KvAdapter, kvAdapterFor } from "./kv.ts";

const hash = "inngest:mcp-oauth";
const defaultKeyName = "MCP_OAUTH_ENCRYPTION_KEY";
const prefix = "v1.";

const bytesToBase64 = (bytes: Uint8Array): string => {
  let text = "";

  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }

  return btoa(text);
};

const base64ToBytes = (text: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
};

/**
 * Options for `kvOAuthStore()`.
 */
export interface KvOAuthStoreOptions {
  /**
   * The secret the values are encrypted with: any long random string, from
   * the environment or a secrets manager, as a `secret()`. Default `secret("MCP_OAUTH_ENCRYPTION_KEY")`.
   * Changing it makes stored tokens unreadable, and users connect again.
   */
  encryptionKey?: Secret;

  /**
   * The KV store to write to. Default: the app's store from
   * `createAgents(client, { store })`, else Redis at
   * `INNGEST_EXPERIMENTAL_KV_URL`.
   */
  adapter?: KvAdapter;

  /**
   * The app ID of the client, to find its store from a route outside a
   * function (inside one it is found by itself).
   */
  app?: string;
}

/**
 * EXPERIMENTAL: The default `McpOAuthStore`: the agents KV, encrypted. Build
 * it once and share it between `tool.mcp({ auth: { oauth: { store } } })` and
 * your callback route's `completeMcpAuthorization({ store })`.
 */
export const kvOAuthStore = (
  options: KvOAuthStoreOptions = {},
): McpOAuthStore => {
  const secret = options.encryptionKey ?? new Secret(defaultKeyName);
  let key: Promise<CryptoKey> | undefined;

  const adapter = (): KvAdapter => {
    return (
      options.adapter ??
      kvAdapterFor(
        options.app ??
          (getAsyncCtxSync()?.app as { id?: string } | undefined)?.id,
      )
    );
  };

  const cryptoKey = (): Promise<CryptoKey> => {
    key ??= (async () => {
      const material = new TextEncoder().encode(await secret.value());
      const digest = await globalThis.crypto.subtle.digest("SHA-256", material);

      return globalThis.crypto.subtle.importKey(
        "raw",
        digest,
        "AES-GCM",
        false,
        ["encrypt", "decrypt"],
      );
    })();
    key.catch(() => {
      key = undefined;
    });

    return key;
  };

  // Binds a value to its field, so one user's ciphertext can't be moved to
  // another's.
  const bound = (field: string) => {
    return new TextEncoder().encode(field);
  };

  const encrypt = async (field: string, plain: string): Promise<string> => {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const sealed = await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: bound(field) },
      await cryptoKey(),
      new TextEncoder().encode(plain),
    );

    return `${prefix}${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(sealed))}`;
  };

  // A value that can't be read (a changed key, a foreign value) reads as
  // absent: the user connects again.
  const decrypt = async (
    field: string,
    stored: string | null,
  ): Promise<string | null> => {
    if (stored === null || !stored.startsWith(prefix)) {
      return null;
    }

    const [iv, sealed] = stored.slice(prefix.length).split(".");

    if (!iv || !sealed) {
      return null;
    }

    try {
      const plain = await globalThis.crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: base64ToBytes(iv),
          additionalData: bound(field),
        },
        await cryptoKey(),
        base64ToBytes(sealed),
      );

      return new TextDecoder().decode(plain);
    } catch (error) {
      if (error instanceof NonRetriableError) {
        throw error;
      }

      return null;
    }
  };

  return {
    get: async (field) => {
      return decrypt(field, await adapter().get(hash, field));
    },
    compareAndSet: async (field, expected, next) => {
      const store = adapter();
      // The store compares the stored text, which is different each time it
      // is encrypted, so compare plaintext here and swap on the stored text.
      const stored = await store.get(hash, field);
      const current = await decrypt(field, stored);

      if (current !== expected) {
        return false;
      }

      return store.compareAndSet(
        hash,
        field,
        stored,
        await encrypt(field, next),
      );
    },
    delete: async (field) => {
      await adapter().delete(hash, field);
    },
  };
};
