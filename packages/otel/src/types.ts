export type MaybeError<T> = Error | T;

export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
