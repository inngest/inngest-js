# @inngest/middleware-encryption

This package provides an encryption middleware for Inngest, enabling secure handling of sensitive data. It encrypts data being sent to and from Inngest, ensuring plaintext data never leaves your server.

## Features

- **Data Encryption:** Encrypts step and event data, with support for multiple encryption keys.
- **Customizable Encryption Service:** Allows use of a custom encryption service or the default AES-based service.

## Installation

```sh
npm install @inngest/middleware-encryption
```

> [!NOTE]
> Requires TypeScript SDK v3+

## Usage

To use the encryption middleware, import and initialize it with your encryption key(s). You can optionally provide a custom encryption service.

By default, the following will be encrypted:

- All step data
- Event data placed inside `data.encrypted`

```ts
import { encryptionMiddleware } from "@inngest/middleware-encryption";

// Initialize the middleware
const mw = encryptionMiddleware({
  key: "your-encryption-key",
});

// Use the middleware with Inngest
const inngest = new Inngest({
  id: "my-app",
  middleware: [mw],
});
```



## Customizing event encryption

Only select pieces of event data are encrypted. By default, only the `data.encrypted` field.

This can be customized using the `eventEncryptionField` setting

- `string` - Encrypt fields matching this name
- `string[]` - Encrypt fields matching these names
- `(field: string) => boolean` - Provide a function to decide whether to encrypt a field
- `false` - Disable all event encryption

## Rotating encryption keys

Provide an `Array<string>` when providing your `key` to support rotating encryption keys.

The first key is always used to encrypt, but decryption will be attempted with all keys.

## Implementing your own encryption

To create a custom encryption service, you need to implement the abstract `EncryptionService` class provided by the package. Your custom service must implement two core methods: `encrypt` and `decrypt`.

```ts
export abstract class EncryptionService {
  public abstract encrypt(value: unknown): string;
  public abstract decrypt(value: string): unknown;
}
```

For example, here's how you might define, instantiate, and use a custom encryption service:

```ts
import { EncryptionService } from "@inngest/middleware-encryption";

class CustomEncryptionService implements EncryptionService {
  constructor(/* custom parameters */) {
    // Initialization code here
  }

  encrypt(value: unknown): string {
    // Implement your custom encryption logic here
    // Example: return CustomEncryptLib.encrypt(JSON.stringify(value), this.customKey);
  }

  decrypt(value: string): unknown {
    // Implement your custom decryption logic here
    // Example: return JSON.parse(CustomEncryptLib.decrypt(value, this.customKey));
  }
}
```

You can then pass it to the `encryptionMiddleware` function like so:

```ts
const customService = new CustomEncryptionService(/* custom parameters */);

const mw = encryptionMiddleware({
  encryptionService: customService,
});

// Use the middleware with Inngest
const inngest = new Inngest({
  id: "my-app",
  middleware: [mw],
});
```
