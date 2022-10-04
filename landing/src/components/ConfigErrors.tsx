import { ConfigErr } from "../types";

/**
 * A map of config errors to static rendered JSX elements. These errors will be
 * rendered when showing erroring functions in the list.
 */
export const configErrors: Record<ConfigErr, JSX.Element> = {
  [ConfigErr.EmptyTrigger]: (
    <>
      One or more triggers seems invalid; it has no event or cron definition.
      Make sure you've correctly used the function creation methods.
    </>
  ),
  [ConfigErr.NoTriggers]: (
    <>
      Can't find any triggers for this function, such as an event or a cron
      definition. Make sure you've correctly used the function creation methods.
    </>
  ),
};
