import type { Inngest } from "./Inngest.ts";
import type {
  SyncAdapterOptions,
  SyncHandlerOptions,
} from "./InngestCommHandler.ts";

export namespace InngestEndpointAdapter {
  export const Tag = "Inngest.EndpointAdapter" as const;

  /**
   * Options passed to the durable endpoint proxy handler factory.
   */
  export interface ProxyHandlerOptions {
    /**
     * The Inngest client to use for API requests and middleware.
     */
    client: Inngest.Like;
  }

  // biome-ignore lint/suspicious/noExplicitAny: we don't care about the return
  export type Fn = (options: SyncHandlerOptions) => any;

  // biome-ignore lint/suspicious/noExplicitAny: we don't care about the return
  export type ProxyFn = (options: ProxyHandlerOptions) => any;

  export interface Like extends Fn {
    readonly [Symbol.toStringTag]: typeof Tag;
    withOptions: (options: SyncAdapterOptions) => Like;

    /**
     * Creates a proxy handler for fetching durable endpoint results from Inngest.
     *
     * This is used by `inngest.endpointProxy()` to create framework-specific
     * handlers that can poll for and decrypt results.
     */
    createProxyHandler?: ProxyFn;
  }

  export const create = <TFn extends Fn, TProxyFn extends ProxyFn | undefined>(
    rawFn: TFn,
    proxyFn?: TProxyFn,
  ): TFn &
    Like &
    (TProxyFn extends ProxyFn ? { createProxyHandler: TProxyFn } : object) => {
    const scopedOptions: SyncAdapterOptions = {};
    const fn: Fn = (options) => rawFn({ ...scopedOptions, ...options });

    const properties: PropertyDescriptorMap = {
      [Symbol.toStringTag]: { value: Tag },

      withOptions: {
        value: (options: SyncAdapterOptions) => {
          Object.assign(scopedOptions, options);
          return fn;
        },
      },
    };

    if (proxyFn) {
      properties["createProxyHandler"] = { value: proxyFn };
    }

    return Object.defineProperties(fn, properties) as TFn &
      Like &
      (TProxyFn extends ProxyFn ? { createProxyHandler: TProxyFn } : object);
  };
}
