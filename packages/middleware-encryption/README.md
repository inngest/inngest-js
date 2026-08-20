# @inngest/middleware-encryption

This package provides an encryption middleware for Inngest, enabling secure
handling of sensitive data. It encrypts data being sent to and from Inngest,
ensuring plaintext data never leaves your server.

- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [Rotating encryption keys](#rotating-encryption-keys)
- [Implementing your own encryption](#implementing-your-own-encryption)

## Features

- **Data Encryption:** Encrypts step and event data, with support for multiple encryption keys.
- **Customizable Encryption Service:** Allows use of a custom encryption service or defaults to using [Sodium](https://doc.libsodium.org/).

## Installation

```sh
npm install @inngest/middleware-encryption
```

> [!NOTE]
> Requires TypeScript SDK v4+
>
> Upgrading from v0.x.x of this package? See [MIGRATION.md](./MIGRATION.md).

## Usage

To use the encryption middleware, import and initialize it with your encryption key(s). You can optionally provide a custom encryption service.

By default, the following will be encrypted:

- All step data
- All function output
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

This can be customized using the `eventEncryptionField` setting:

- `string` - Encrypts the top-level field matching this name

## Rotating encryption keys

The `key` will always be used to encrypt. You can also specify
`fallbackDecryptionKeys` to be used to attempt decryption if the primary key
fails.

The rollout of a new key would be as follows:

```ts
// start out with the current key
encryptionMiddleware({
  key: "current",
});

// deploy all services with the new key as a decryption fallback
encryptionMiddleware({
  key: "current",
  fallbackDecryptionKeys: ["new"],
});

// deploy all services using the new key for encryption
encryptionMiddleware({
  key: "new",
  fallbackDecryptionKeys: ["current"],
});

// once you are sure all data using the "current" key has passed, phase it out
encryptionMiddleware({
  key: "new",
});
```

## Implementing your own encryption

To create a custom encryption service, you need to implement the abstract
`EncryptionService` class provided by the package. Your custom service must
implement an `identifier` and two core methods: `encrypt` and `decrypt`.

```ts
export abstract class EncryptionService {
  public abstract identifier: string;
  public abstract encrypt(value: unknown): MaybePromise<string>;
  public abstract decrypt(value: string): MaybePromise<unknown>;
}
```

> [!TIP]
> Notice that the return values of these functions can be synchronous or return
> promises. In the latter case, encryption/decryption will happen in parallel
> for every relevant step and event. In practice, this also allows you to mimic
> [dataloader](https://github.com/graphql/dataloader)-like behaviour by
> collecting all encryption/decryption requests during one tick and choosing how
> to process them all at once.
>
> This could be useful for a service which stores state in a remote store like
> S3, for example.

For example, here's how you might define, instantiate, and use a custom encryption service:

```ts
import { EncryptionService } from "@inngest/middleware-encryption";

class CustomEncryptionService implements EncryptionService {
  public identifier = "my-custom-strategy";

  constructor(/* custom parameters */) {
    // Initialization code here
  }

  encrypt(value: unknown): MaybePromise<string> {
    // Implement your custom encryption logic here
    // Example: return CustomEncryptLib.encrypt(JSON.stringify(value), this.customKey);
  }

  decrypt(value: string): MaybePromise<unknown> {
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