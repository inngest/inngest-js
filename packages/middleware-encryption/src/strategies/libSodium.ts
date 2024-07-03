import sodium from "libsodium-wrappers";
import { EncryptionService } from "../middleware";

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
export class LibSodiumEncryptionService extends EncryptionService {
  private readonly keys: [string, ...string[]];

  public identifier = "libsodium";

  constructor(key: string | string[] | undefined) {
    super();

    if (!key) {
      throw new Error("Missing encryption key(s) in encryption middleware");
    }

    const keys = (Array.isArray(key) ? key : [key])
      .map((s) => s.trim())
      .filter(Boolean);

    if (!keys.length) {
      throw new Error("Missing encryption key(s) in encryption middleware");
    }

    this.keys = keys as [string, ...string[]];
  }

  encrypt(value: unknown): string {
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const message = sodium.from_string(JSON.stringify(value));
    const ciphertext = sodium.crypto_secretbox_easy(
      message,
      nonce,
      sodium.from_hex(this.keys[0])
    );

    const combined = new Uint8Array(nonce.length + ciphertext.length);
    combined.set(nonce);
    combined.set(ciphertext, nonce.length);

    return sodium.to_base64(combined, sodium.base64_variants.ORIGINAL);
  }

  decrypt(value: string): unknown {
    let err: unknown;

    for (const key of this.keys) {
      try {
        const combined = sodium.from_base64(
          value,
          sodium.base64_variants.ORIGINAL
        );
        const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
        const ciphertext = combined.slice(sodium.crypto_secretbox_NONCEBYTES);

        const decrypted = sodium.crypto_secretbox_open_easy(
          ciphertext,
          nonce,
          sodium.from_hex(key)
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
