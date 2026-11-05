import type Sodium from "libsodium-wrappers";
import type { EncryptionService } from "../middleware";

interface LoadedSodium {
  sodium: typeof Sodium;
  hashedKeys: Uint8Array[];
}

/**
 * The default encryption service used by the encryption middleware.
 *
 * This service uses LibSodium to encrypt and decrypt data. It supports multiple
 * keys, so that you can rotate keys without breaking existing encrypted data.
 *
 * An option is also provided to encrypt with a previous methodology, allowing
 * you to transition all services to using this new strategy before removing the
 * flag.
 */
export class LibSodiumEncryptionService implements EncryptionService {
  private readonly keys: string[];
  private loading: Promise<LoadedSodium> | undefined;

  public identifier = "inngest/libsodium";

  constructor(key: string | string[] | undefined) {
    if (!key) {
      throw new Error("Missing encryption key(s) in encryption middleware");
    }

    this.keys = (Array.isArray(key) ? key : [key])
      .map((s) => s.trim())
      .filter(Boolean);

    if (!this.keys.length) {
      throw new Error("Missing encryption key(s) in encryption middleware");
    }
  }

  /**
   * Loaded on first use: libsodium calls `crypto.getRandomValues` on load,
   * which Cloudflare Workers forbid at global scope.
   */
  private load(): Promise<LoadedSodium> {
    this.loading ??= import("libsodium-wrappers")
      .then(async ({ default: sodium }) => {
        await sodium.ready;
        return {
          sodium,
          hashedKeys: this.keys.map((k) =>
            sodium.crypto_generichash(sodium.crypto_secretbox_KEYBYTES, k),
          ),
        };
      })
      .catch((err: unknown) => {
        this.loading = undefined;
        throw err;
      });

    return this.loading;
  }

  async encrypt(value: unknown): Promise<string> {
    const { sodium, hashedKeys } = await this.load();

    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const message = sodium.from_string(JSON.stringify(value));
    const ciphertext = sodium.crypto_secretbox_easy(
      message,
      nonce,
      hashedKeys[0],
    );

    const combined = new Uint8Array(nonce.length + ciphertext.length);
    combined.set(nonce);
    combined.set(ciphertext, nonce.length);

    return sodium.to_base64(combined, sodium.base64_variants.ORIGINAL);
  }

  async decrypt(value: string): Promise<unknown> {
    const { sodium, hashedKeys } = await this.load();

    let err: unknown;

    for (const key of hashedKeys) {
      try {
        const combined = sodium.from_base64(
          value,
          sodium.base64_variants.ORIGINAL,
        );
        const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
        const ciphertext = combined.slice(sodium.crypto_secretbox_NONCEBYTES);

        const decrypted = sodium.crypto_secretbox_open_easy(
          ciphertext,
          nonce,
          key,
        );

        const decoder = new TextDecoder("utf8");

        return JSON.parse(decoder.decode(decrypted));
      } catch (decryptionError) {
        err = decryptionError;
      }
    }

    throw (
      err ||
      new Error("Unable to decrypt value; no keys were able to decrypt it")
    );
  }
}
