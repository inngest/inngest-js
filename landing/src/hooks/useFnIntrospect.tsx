import { useAsyncRetry } from "react-use";
import { ConfigErr, ExpectedIntrospection } from "../types";

/**
 * Introspect the local SDK handler and return config and errors.
 */
export const useFnIntrospect = () => {
  const state = useAsyncRetry(async () => {
    const url = new URL(window.location.href);
    url.searchParams.set("introspect", "true");

    const res = await fetch(url);
    const result: ExpectedIntrospection = await res.json();

    result.functions = result.functions
      .map((fn) => {
        const errs = new Set<ConfigErr>();

        if (fn.triggers?.length < 1) {
          errs.add(ConfigErr.NoTriggers);
        } else {
          const hasBadTrigger = fn.triggers.some((trigger: any) => {
            return !trigger?.event && !trigger?.cron;
          });

          if (hasBadTrigger) {
            errs.add(ConfigErr.EmptyTrigger);
          }
        }

        if (errs.size) {
          fn.errors = errs;
        }

        return fn;
      })
      .sort((a, b) => {
        const aHasErrs = Boolean(a.errors?.size);
        const bHasErrors = Boolean(b.errors?.size);

        if (aHasErrs !== bHasErrors) {
          return aHasErrs ? -1 : 1;
        }

        return a.name.localeCompare(b.name);
      });

    return result;
  });

  return state;
};
