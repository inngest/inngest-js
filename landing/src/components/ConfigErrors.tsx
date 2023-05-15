import { FunctionConfigErr, GlobalConfigErr } from "../types";

/**
 * A map of config errors to static rendered JSX elements. These errors will be
 * rendered when showing erroring functions in the list.
 */
export const configErrors: Record<FunctionConfigErr, JSX.Element> = {
  [FunctionConfigErr.EmptyTrigger]: (
    <>
      One or more triggers seems invalid; it has no event or cron definition.
      Make sure you've correctly used the function creation methods.
    </>
  ),
  [FunctionConfigErr.NoTriggers]: (
    <>
      Can't find any triggers for this function, such as an event or a cron
      definition. Make sure you've correctly used the function creation methods.
    </>
  ),
};

/**
 * A map of global config errors to static rendered JSX elements. These errors
 * will be rendered when showing an erroring handler.
 */
export const globalConfigErrors: Record<GlobalConfigErr, JSX.Element> = {
  [GlobalConfigErr.NoSigningKey]: (
    <div class="flex flex-col space-y-2">
      <div class="font-semibold">Could not find signing key</div>
      <div>
        A signing key is required to communicate with Inngest securely. We
        weren't passed one when calling <code>serve()</code> and couldn't find
        it in the recommended <code>INNGEST_SIGNING_KEY</code> environment
        variable.
      </div>
      <div>
        You can find your signing key in the{" "}
        <a
          href="https://app.inngest.com/env/production/manage/signing-key"
          target="_blank"
        >
          Inngest Cloud - Manage section.
        </a>
      </div>
    </div>
  ),
};
