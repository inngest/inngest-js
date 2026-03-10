/**
 * While developers can often use `instanceof` to check if an object is a class
 * instance, this is not always reliable, especially when dealing with objects
 * that may have been created in different execution contexts or across
 * different versions of the library.
 *
 * This module provides a set of type guards that use `*.Like` interfaces to
 * recognize the objects instead of any other typing.
 *
 * These can be used internally and externally.
 *
 * @module
 */

import { Inngest } from "../components/Inngest.ts";
import { InngestEndpointAdapter } from "../components/InngestEndpointAdapter.ts";
import { InngestFunction } from "../components/InngestFunction.ts";
import { InngestMiddleware } from "../components/InngestMiddleware.ts";
import { headerKeys } from "./consts.ts";

/**
 * Asserts that the given `input` is an `Inngest` object.
 */
export const isInngest = (
  /**
   * The input to check.
   */
  input: unknown,
): input is Inngest.Any => {
  // biome-ignore lint/suspicious/noExplicitAny: we're happy that it could be anything here
  return (input as any)[Symbol.toStringTag] === Inngest.Tag;
};

/**
 * Asserts that the given `input` is an `InngestFunction` object.
 */
export const isInngestFunction = (
  /**
   * The input to check.
   */
  input: unknown,
): input is InngestFunction.Any => {
  // biome-ignore lint/suspicious/noExplicitAny: we're happy that it could be anything here
  return (input as any)[Symbol.toStringTag] === InngestFunction.Tag;
};

/**
 * Asserts that the given `input` is an `InngestMiddleware` object.
 */
export const isInngestMiddleware = (
  /**
   * The input to check.
   */
  input: unknown,
): input is InngestMiddleware.Any => {
  // biome-ignore lint/suspicious/noExplicitAny: we're happy that it could be anything here
  return (input as any)[Symbol.toStringTag] === InngestMiddleware.Tag;
};

/**
 * Asserts that the given `input` is a request originating from Inngest.
 */
export const isInngestRequest = (
  /**
   * The input to check.
   */
  input: unknown,
): boolean => {
  try {
    const runId = (input as Request).headers.get(headerKeys.InngestRunId);
    const signature = (input as Request).headers.get(headerKeys.Signature);

    // Note that the signature just has to be present; in Dev it'll be empty,
    // but still set to `""`.
    return Boolean(runId && typeof signature === "string");
  } catch {
    return false;
  }
};

/**
 * Asserts that the given `input` is an `InngestEndpointAdapter` object.
 */
export const isInngestEndpointAdapter = (
  /**
   * The input to check.
   */
  input: unknown,
): input is InngestEndpointAdapter.Like => {
  // biome-ignore lint/suspicious/noExplicitAny: we're happy that it could be anything here
  return (input as any)[Symbol.toStringTag] === InngestEndpointAdapter.Tag;
};
