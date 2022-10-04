import { useMemo } from "preact/hooks";
import { useIntrospect } from "../hooks/useFnIntrospect";
import { globalConfigErrors } from "./ConfigErrors";
import { Wrapper } from "./Container";
import { FunctionBlock } from "./FunctionBlock";
import { Spinner } from "./Loading";

/**
 * A messy catch-all component to render almost the entire landing page.
 */
export const Content = () => {
  const { loading, value: fns, retry: refresh } = useIntrospect();

  /**
   * Figure out if we have errors based on the latest fetched functions.
   */
  const hasErrors = useMemo(() => {
    return fns?.functions.some((fn) => fn.errors?.size) || false;
  }, [fns?.functions]);

  /**
   * Figure out if we have any global errors.
   */
  const hasGlobalErrors = useMemo(() => {
    return Boolean(fns?.globalErrors.size);
  }, [fns?.globalErrors]);

  /**
   * Memoise a set of quick-start cards. They're memoised so that we can adjust
   * them in the future based on the above fetched config.
   */
  const quickStartCards = useMemo(() => {
    return [
      {
        title: "🧑‍💻 Writing functions",
        description:
          "Get started writing your serverless background functions and scheduled tasks.",
        href: "https://www.inngest.com/docs/functions",
      },
      {
        title: "📢 Sending events",
        description:
          "Learn how to trigger your functions by sending events from your code.",
        href: "https://www.inngest.com/docs/events",
      },
      {
        title: "🚢 Deploying",
        description: "Deploy functions to your platform of choice.",
        href: "https://www.inngest.com/docs/deploy",
      },
    ];
  }, []);

  if (loading) {
    return <Spinner class="h-8 w-8" />;
  }

  return (
    <>
      <div class="flex flex-col gap-4 py-20 bg-gray-100">
        <Wrapper>
          <div class="text-3xl">
            {hasErrors
              ? "❌ Your functions are not set up correctly"
              : fns?.functions.length
              ? "✅ Your functions are set up correctly"
              : "❎ No functions detected"}
          </div>
          <div class="ml-12 opacity-75">
            <code>inngest-{fns?.sdk}</code>
          </div>
        </Wrapper>
      </div>
      <div>
        <Wrapper>
          <div class="w-full grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 py-4 gap-4">
            {quickStartCards.map((card) => (
              <a
                href={card.href}
                target="_blank"
                class="bg-white rounded border-1 border-black shadow-xl p-4 flex flex-col space-y-2 transition-all hover:scale-105 hover:shadow-2xl no-underline"
              >
                <div class="font-semibold text-lg">{card.title}</div>
                <div class="text-sm">{card.description}</div>
                <div class="flex-1" />
                <div class="text-right font-semibold text-purple-500">
                  Explore →
                </div>
              </a>
            ))}
          </div>
        </Wrapper>
      </div>
      {hasGlobalErrors ? (
        <div class="mt-8">
          <Wrapper>
            <div class="w-full p-4 rounded bg-yellow-400/30 flex flex-col space-y-2">
              <div class="font-semibold text-yellow-700 text-lg">
                Your handler configuration might be missing some options
              </div>
              {Array.from(fns?.globalErrors ?? []).map((err) => (
                <div class="bg-yellow-100 border border-yellow-400 rounded p-2 text-yellow-800">
                  {globalConfigErrors[err]}
                </div>
              ))}
            </div>
          </Wrapper>
        </div>
      ) : null}
      <div class="w-full flex items-center justify-center mt-8 p-4">
        <Wrapper>
          <div class="flex flex-row justify-between">
            <div class="flex flex-row space-x-2 items-center justify-center">
              <div class="font-semibold">
                Found {fns?.functions.length || 0} functions
              </div>
              <div>
                <div
                  class="bg-gray-100 rounded px-1 py-0.5 hover:cursor-pointer text-sm uppercase"
                  onClick={() => refresh()}
                >
                  Refresh
                </div>
              </div>
            </div>
            <a class="mb-8" href="#">
              Don't see your function?
            </a>
          </div>

          {fns?.functions.length ? (
            <div class="flex flex-col">
              <div class="w-full grid grid-cols-[1fr_1fr_1fr] font-semibold border-b-2 border-slate-300 pb-1">
                <div>Name</div>
                <div>ID</div>
                <div>Event / Cron</div>
              </div>
              {fns?.functions.map((fn, i) => (
                <FunctionBlock config={fn} altBg={i % 2 === 0} />
              ))}
            </div>
          ) : (
            <div class="bg-gray-100 rounded-lg flex flex-col space-y-2 items-center justify-center p-20">
              <div class="font-semibold">No functions found</div>
              <div class="opacity-75 text-center">
                We found your handler, but couldn't see any exported functions.
                <br />
                Check out the{" "}
                <a href="https://www.inngest.com/docs/functions">
                  Writing functions
                </a>{" "}
                guide to get started.
              </div>
            </div>
          )}
        </Wrapper>
      </div>
    </>
  );
};
