import AES from "crypto-js/aes.js";
import CryptoJSUtf8 from "crypto-js/enc-utf8.js";
import type { EncryptionService } from "../middleware";

/**
 * The AES encryption service used by the encryption middleware.
 *
 * This service uses AES encryption to encrypt and decrypt data. It supports
 * multiple keys, so that you can rotate keys without breaking existing
 * encrypted data.
 *
 * It was the method used before the default encryption service using LibSodium
 * was added, and is still used internally for decrypting data to ensure
 * compatibility with older versions.
 */
export class AESEncryptionService implements EncryptionService {
  private readonly keys: [string, ...string[]];

  public identifier = "inngest/aes";

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

    this.keys = keys as [string, ...string[]];
  }

  encrypt(value: unknown): string {
    return AES.encrypt(JSON.stringify(value), this.keys[0]).toString();
  }

  decrypt(value: string): unknown {
    let err: unknown;

    for (const key of this.keys) {
      try {
        const decrypted = AES.decrypt(value, key).toString(CryptoJSUtf8);
        return JSON.parse(decrypted);
      } catch (decryptionError) {
        err = decryptionError;
        continue;
      }
    }

    throw (
      err ||
      new Error("Unable to decrypt value; no keys were able to decrypt it")
    );
  }
}
