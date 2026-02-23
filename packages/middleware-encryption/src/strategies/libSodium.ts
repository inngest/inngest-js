import sodium from "libsodium-wrappers";
import type { EncryptionService } from "../middleware";

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
  private readonly keys: Promise<Uint8Array[]>;

  public identifier = "inngest/libsodium";

  constructor(key: string | string[] | undefined) {
    if (!key) {
      throw new Error("Missing encryption key(s) in encryption middleware");
    }

    const keys = (Array.isArray(key) ? key : [key])
      .map((s) => s.trim())
      .filter(Boolean);

    if (!keys.length) {
      throw new Error("Missing encryption key(s) in encryption middleware");
    }

    /**
     * Ensure we pre-hash the keys to the correct length before using them, and
     * also always wait for sodium to be ready. Accessing keys in other
     * functions always requires awaiting this value, so we can never skip this
     * readiness check.
     */
    this.keys = sodium.ready.then(() => {
      return keys.map((k) => {
        return sodium.crypto_generichash(sodium.crypto_secretbox_KEYBYTES, k);
      });
    });
  }

  async encrypt(value: unknown): Promise<string> {
    const keys = await this.keys;

    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const message = sodium.from_string(JSON.stringify(value));
    const ciphertext = sodium.crypto_secretbox_easy(message, nonce, keys[0]);

    const combined = new Uint8Array(nonce.length + ciphertext.length);
    combined.set(nonce);
    combined.set(ciphertext, nonce.length);

    return sodium.to_base64(combined, sodium.base64_variants.ORIGINAL);
  }

  async decrypt(value: string): Promise<unknown> {
    const keys = await this.keys;

    let err: unknown;

    for (const key of keys) {
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
