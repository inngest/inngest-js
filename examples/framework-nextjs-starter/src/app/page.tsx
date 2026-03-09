/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";
import Image from "next/image";
import Link from "next/link";
import { BookOpen, BookMarked, VideoIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Highlight, Language, PrismTheme, Token } from "prism-react-renderer";
import {
  Carousel,
  CarouselApi,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import { useToast } from "@/components/hooks/use-toast";

// duotoneLight theme as a direct object (fallback if import fails)
const duotoneLight: PrismTheme = {
  plain: {
    color: "#403f53",
    backgroundColor: "#faf8f5",
  },
  styles: [
    {
      types: ["comment", "prolog", "doctype", "cdata"],
      style: {
        color: "#b6ad9a",
        fontStyle: "italic",
      },
    },
    {
      types: ["punctuation", "operator"],
      style: {
        color: "#6c6783",
      },
    },
    {
      types: [
        "property",
        "tag",
        "boolean",
        "number",
        "constant",
        "symbol",
        "deleted",
      ],
      style: {
        color: "#e09142",
      },
    },
    {
      types: ["selector", "attr-name", "string", "char", "builtin", "inserted"],
      style: {
        color: "#286983",
      },
    },
    {
      types: ["function", "class-name"],
      style: {
        color: "#286983",
      },
    },
    {
      types: ["keyword"],
      style: {
        color: "#7c6f64",
        fontStyle: "italic",
      },
    },
  ],
};

const steps = [
  {
    title: "Trigger your first Inngest function",
    description:
      "Welcome to the Inngest Tour! Inngest enables you to write Inngest functions, trigger by events. \n Trigger your first function below and see its output.",
  },
  {
    title: "Multi-Step Inngest Function and Streaming",
    description:
      "Inngest Functions can be divided into multiple fault-tolerant steps, removing most Serverless timeouts and enabling streaming updates to the UI.",
  },
  {
    title: "Fault Tolerance with retries",
    description:
      "Things can fail and retries can help with that. \n Trigger a function that fails and inspect retries happening in the Inngest Dev Server.",
  },
  {
    title: "Flow Control: Throttling and more",
    description:
      "Inngest functions can be made to run in parallel, or one after the other, or with a delay. You can control how functions are executed by using Inngest's flow control features. Let's look at the Throttling feature in action.",
  },
  {
    title: "You're all set!",
    description: "",
  },
];

function Step1({ onNext }: { onNext: () => void }) {
  const [status, setStatus] = useState<string | null>(null);
  const [output, setOutput] = useState<{ message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const { toast } = useToast();

  const codeSample = `await inngest.send({\n  name: \"demo/simple.sleep\",\n  data: {},\n});`;

  async function trigger() {
    setLoading(true);
    setStatus(null);
    setOutput(null);
    setError(null);
    try {
      const res = await fetch("/api/trigger-simple", { method: "POST" });
      const data = await res.json();
      setStatus("Pending...");
      setTimeout(
        () => {
          pollStatus(data.eventId);
        },
        process.env.NEXT_PUBLIC_VERCEL_ENV ? 3000 : 500
      );
    } catch {
      setError("Failed to trigger function");
      setLoading(false);
    }
  }

  async function pollStatus(eventId: string) {
    let done = false;
    while (!done) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch(`/api/simple-status?eventId=${eventId}`);
      const data = await res.json();
      setStatus(data.status);
      setOutput(data.output);
      if (data.error) {
        if (process.env.NEXT_PUBLIC_VERCEL_ENV) {
          if (res.status !== 404) {
            setError(data.error);
            done = true;
            setLoading(false);
          }
        } else {
          setError("Failed to trigger function");
          done = true;
          setLoading(false);
        }
      }
      if (
        data.status === "completed" ||
        data.status === "failed" ||
        data.status === "cancelled"
      ) {
        done = true;
        setLoading(false);
      }
    }
  }

  const copyDevServerCmd = useCallback(() => {
    navigator.clipboard.writeText("npx inngest-cli@latest dev");
    toast({
      title: "Command copied to clipboard!",
      description: "You can now paste it into your terminal.",
    });
  }, [toast]);

  return (
    <div className="flex flex-col items-start gap-8 w-full">
      {process.env.NEXT_PUBLIC_VERCEL_ENV ? null : (
        <>
          <div className="flex-1 flex flex-row items-center">
            <div
              className={`rounded-full w-8 h-8 mr-2 flex items-center justify-center font-bold text-white shadow bg-gray-300`}
            >
              1
            </div>
            <span className="text-sm text-center text-gray-700 font-medium">
              Start your Inngest Dev Server
            </span>
          </div>
          <Alert className="w-full bg-blue-50 border-blue-200">
            <AlertTitle className="text-blue-900">
              Start the Inngest Dev Server
            </AlertTitle>
            <AlertDescription>
              <div className="flex flex-row gap-2 mt-2 items-center">
                <code
                  onClick={copyDevServerCmd}
                  className="cursor-pointer bg-blue-100 px-2 py-1 rounded text-blue-800 font-mono text-sm"
                >
                  npx inngest-cli@latest dev
                </code>
                <span className="text-xs font-thin text-blue-700">
                  (Click to copy)
                </span>
              </div>
            </AlertDescription>
          </Alert>
        </>
      )}
      <div className="flex-1 flex flex-row items-center">
        <div
          className={`rounded-full w-8 h-8 mr-2 flex items-center justify-center font-bold text-white shadow bg-gray-300`}
        >
          {process.env.NEXT_PUBLIC_VERCEL_ENV ? 1 : 2}
        </div>
        <span className="text-sm text-center text-gray-700 font-medium">
          Trigger a function
        </span>
      </div>
      <div className="w-full">
        <div className="mb-2 font-medium text-gray-700">How this works:</div>
        <Highlight
          theme={duotoneLight}
          code={codeSample}
          language={"typescript" as Language}
        >
          {({
            className,
            style,
            tokens,
            getLineProps,
            getTokenProps,
          }: {
            className: string;
            style: React.CSSProperties;
            tokens: Token[][];
            getLineProps: (input: {
              line: Token[];
              key: number;
            }) => React.HTMLAttributes<HTMLDivElement>;
            getTokenProps: (input: {
              token: Token;
              key: number;
            }) => React.HTMLAttributes<HTMLSpanElement>;
          }) => (
            <pre
              className={
                "rounded-lg p-4 text-xs overflow-x-auto border border-gray-200 font-mono " +
                className
              }
              style={{ ...style, background: "#faf8f5" }}
            >
              {tokens.map((line, i) => (
                <div key={i} {...getLineProps({ line, key: i })}>
                  {line.map((token, key) => (
                    <span key={key} {...getTokenProps({ token, key })} />
                  ))}
                </div>
              ))}
            </pre>
          )}
        </Highlight>
      </div>
      <Button
        onClick={trigger}
        disabled={loading}
        className="w-full max-w-xs mx-auto mt-2"
      >
        {loading ? status : "Trigger the Inngest function"}
      </Button>
      <div className="flex flex-col items-center gap-2 w-full mt-2">
        {output && (
          <div className="flex items-center gap-2">
            <Badge className="bg-gray-600 text-white" variant="default">
              Output
            </Badge>
            <span className="text-gray-700 font-medium">
              &quot;{output.message}&quot;
            </span>
          </div>
        )}
        {output && (
          <>
            <div className="flex items-center gap-2 mt-10">
              <Button onClick={onNext}>Go to next example</Button>
            </div>
            <div className="mt-10 w-full">
              <h3 className="text-lg font-semibold mb-2 text-gray-900">
                Learn more
              </h3>
              <ul className="list-disc text-gray-900">
                <li className="flex items-center gap-2 mt-2">
                  <BookMarked className="w-4 h-4 mr-1" />
                  <a href="https://www.inngest.com/docs/learn/how-functions-are-executed?ref=nextjs-starter-template">
                    Learn how Inngest interacts with your Next.js application
                  </a>
                </li>
                <li className="flex items-center gap-2 mt-2">
                  <BookMarked className="w-4 h-4 mr-1" />
                  <a href="https://www.inngest.com/docs/features/events-triggers?ref=nextjs-starter-template">
                    Inngest Events 101
                  </a>
                </li>
              </ul>
            </div>
          </>
        )}
        {error && (
          <div className="flex items-center gap-2">
            <Badge variant="destructive">Error</Badge>
            <span className="text-red-600 font-medium">{error}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Step2({ onNext }: { onNext: () => void }) {
  const [status, setStatus] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [updates, setUpdates] = useState<string[]>([]);

  async function trigger() {
    setLoading(true);
    setStatus(null);
    setResult(null);
    setUpdates([]);
    // Trigger the function
    const response = await fetch("/api/trigger-multistep", { method: "POST" });
    const reader = response.body?.getReader();
    if (!reader) {
      return;
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const text = new TextDecoder().decode(value);
      const data = JSON.parse(text).data;
      if (data.message) {
        setUpdates((prev) => [...prev, data.message]);
      }
      if (data.done) {
        setLoading(false);
        break;
      }
    }
  }

  return (
    <div className="flex flex-col items-center gap-6 w-full">
      <Button
        onClick={trigger}
        disabled={loading || status === "pending"}
        className="w-full max-w-xs mx-auto"
      >
        {loading
          ? "Starting..."
          : status === "pending"
          ? "Running..."
          : "Start the multi-Step function"}
      </Button>
      <div className="w-full flex flex-col gap-2 mt-4">
        {(updates || []).map((update, i) => {
          return (
            <div key={i} className="flex items-center gap-3">
              <div className={`flex items-center justify-center `}>
                <Badge className="bg-gray-600 text-white" variant="default">
                  Live message #{i + 1}
                </Badge>
              </div>
              <span className="text-gray-400">{`"${update}"`}</span>
            </div>
          );
        })}
      </div>
      {result && (
        <div className="mt-4 text-green-700 font-semibold">{result}</div>
      )}
      {updates.length > 0 && !loading && (
        <>
          <div className="flex items-center gap-2 mt-10">
            <Button onClick={onNext}>Go to next example</Button>
          </div>
          <div className="mt-10 w-full">
            <h3 className="text-lg font-semibold mb-2 text-gray-900">
              Learn more
            </h3>
            <ul className="list-disc text-gray-900">
              <li className="flex items-center gap-2 mt-2">
                <BookMarked className="w-4 h-4 mr-1" />
                <a href="https://www.inngest.com/docs/guides/multi-step-functions?ref=nextjs-starter-template">
                  Implementing Multi-Step Functions
                </a>
              </li>
              <li className="flex items-center gap-2 mt-2">
                <BookMarked className="w-4 h-4 mr-1" />
                <a href="https://www.inngest.com/docs/guides/multi-step-functions?ref=nextjs-starter-template">
                  Streaming Updates with <code>@inngest/realtime</code>
                </a>
              </li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function Step3({ onNext }: { onNext: () => void }) {
  const [triggered, setTriggered] = useState(false);
  const [loading, setLoading] = useState(false);

  // Example code for a function with a failing step
  const codeSample = `import { inngest } from "./client";

export const failingFunction = inngest.createFunction(
  { id: "demo/failing-step", retries: 1, triggers: [{ event: "demo/failing.step" }] },
  async ({ step }) => {
    await step.run("First step", async () => {
      // This step succeeds
      return "ok";
    });
    await step.run("Failing step", async () => {
      throw new Error("This step always fails!");
    });
    return "done";
  }
);`;

  async function trigger() {
    setLoading(true);
    await fetch("/api/trigger-failing", { method: "POST" });
    setLoading(false);
    setTriggered(true);
  }

  return (
    <div className="flex flex-col items-center gap-8 w-full">
      <div className="w-full">
        <h3 className="text-lg font-semibold mb-2 text-gray-900">
          The culprit
        </h3>
        <p className="text-gray-600 mb-4 text-xs">
          {"This function's second step will always fail:"}
        </p>
        <Highlight
          theme={duotoneLight}
          code={codeSample}
          language={"typescript" as Language}
        >
          {({
            className,
            style,
            tokens,
            getLineProps,
            getTokenProps,
          }: {
            className: string;
            style: React.CSSProperties;
            tokens: Token[][];
            getLineProps: (input: {
              line: Token[];
              key: number;
            }) => React.HTMLAttributes<HTMLDivElement>;
            getTokenProps: (input: {
              token: Token;
              key: number;
            }) => React.HTMLAttributes<HTMLSpanElement>;
          }) => (
            <pre
              className={
                "rounded-lg p-4 text-xs overflow-x-auto border border-gray-200 font-mono " +
                className
              }
              style={{ ...style, background: "#faf8f5" }}
            >
              {tokens.map((line, i) => (
                <div key={i} {...getLineProps({ line, key: i })}>
                  {line.map((token, key) => (
                    <span key={key} {...getTokenProps({ token, key })} />
                  ))}
                </div>
              ))}
            </pre>
          )}
        </Highlight>
      </div>
      <Button
        onClick={trigger}
        disabled={loading}
        className="w-full max-w-xs mx-auto mt-2"
      >
        {loading ? "Triggering..." : "Trigger the failing function"}
      </Button>
      {triggered && (
        <>
          <Alert className="w-full bg-blue-50 border-blue-200">
            <AlertTitle className="text-blue-900 text-base">
              Inspect the run in the DevServer
            </AlertTitle>
            <AlertDescription>
              <div className="mt-2 text-sm">
                Open your DevServer at{" "}
                <a
                  href="http://127.0.0.1:3000"
                  target="_blank"
                  className="text-blue-500 hover:underline"
                >
                  127.0.0.1:3000
                </a>{" "}
                to see the failing step retrying. <br />
                <br />
                Expand the second step to see the initial run and following
                retry.
              </div>
            </AlertDescription>
          </Alert>
          <div className="flex items-center gap-2 mt-4">
            <Button onClick={onNext}>Go to next example</Button>
          </div>
          <div className="mt-4 w-full">
            <h3 className="text-lg font-semibold mb-2 text-gray-900">
              Learn more
            </h3>

            <ul className="list-disc text-gray-900">
              <li className="flex items-center gap-2 mt-2">
                <BookMarked className="w-4 h-4 mr-1" />
                <a href="https://www.inngest.com/docs/local-development?ref=nextjs-starter-template">
                  Inngest DevServer 101
                </a>
              </li>
              <li className="flex items-center gap-2 mt-2">
                <BookMarked className="w-4 h-4 mr-1" />
                <a href="https://www.inngest.com/docs/guides/error-handling?ref=nextjs-starter-template">
                  Configuring Retries on Inngest Functions
                </a>
              </li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function Step4({ onNext }: { onNext: () => void }) {
  const [loading, setLoading] = useState(false);
  const [runs, setRuns] = useState<any[]>([]);

  const codeSample = `import { inngest } from "./client";

export const throttledFunction = inngest.createFunction(
  { id: "demo/throttled-function", throttle: { limit: 2, period: "2s" }, triggers: [{ event: "demo/throttled.function" }] },
  async ({ step }) => {
    // ...
  }
);`;

  async function pollStatus(startAt: string) {
    let done = false;
    while (!done) {
      await new Promise((r) => setTimeout(r, 300));
      const res = await fetch(
        `/api/multiple-events-status?receivedAfter=${startAt}`
      );
      const data = await res.json();

      const runs = data.runs.filter((run: any) => !!run.eventId);

      setRuns(runs);

      if (
        runs.length === 10 &&
        runs.every((run: any) => run.status === "completed")
      ) {
        done = true;
        setLoading(false);
      }
    }
  }

  async function trigger() {
    setLoading(true);
    pollStatus(new Date().toISOString());
    await fetch("/api/trigger-throttled", { method: "POST" });
  }

  return (
    <div className="min-h-[120px] flex flex-col items-start  text-gray-400">
      <div className="flex-1 flex flex-row items-center justify-start mb-2">
        <div
          className={`rounded-full w-8 h-8 mr-2 flex items-center justify-center font-bold text-white shadow bg-gray-300`}
        >
          1
        </div>
        <span className="text-sm text-center text-gray-700 font-medium">
          What is Throttling?
        </span>
      </div>
      <div className="text-sm text-gray-700">
        Throttling is a way to limit the rate at which a function can run. For
        example, it is useful for preventing a function from hitting a third
        party API rate limit.
      </div>
      <div className="w-full mt-2">
        <div className="mb-2 text-sm text-gray-700">
          The below function has a <code>throttle</code> property that limits it
          to 2 runs per 2 seconds:
        </div>
        <Highlight
          theme={duotoneLight}
          code={codeSample}
          language={"typescript" as Language}
        >
          {({
            className,
            style,
            tokens,
            getLineProps,
            getTokenProps,
          }: {
            className: string;
            style: React.CSSProperties;
            tokens: Token[][];
            getLineProps: (input: {
              line: Token[];
              key: number;
            }) => React.HTMLAttributes<HTMLDivElement>;
            getTokenProps: (input: {
              token: Token;
              key: number;
            }) => React.HTMLAttributes<HTMLSpanElement>;
          }) => (
            <pre
              className={
                "rounded-lg p-4 text-xs overflow-x-auto border border-gray-200 font-mono " +
                className
              }
              style={{ ...style, background: "#faf8f5" }}
            >
              {tokens.map((line, i) => (
                <div key={i} {...getLineProps({ line, key: i })}>
                  {line.map((token, key) => (
                    <span key={key} {...getTokenProps({ token, key })} />
                  ))}
                </div>
              ))}
            </pre>
          )}
        </Highlight>
      </div>
      <div className="flex-1 flex flex-row items-center justify-start mt-6 mb-2">
        <div
          className={`rounded-full w-8 h-8 mr-2 flex items-center justify-center font-bold text-white shadow bg-gray-300`}
        >
          2
        </div>
        <span className="text-sm text-center text-gray-700 font-medium">
          Throttling in action
        </span>
      </div>
      <div className="text-sm text-gray-700">
        Click the button below to trigger a function 10 times in a row.
        You&apos;ll see that only 2 will run at a time.
      </div>
      <div className="w-full flex justify-center mt-6">
        <Button onClick={trigger} disabled={loading}>
          Trigger 10 runs of the throttled function
        </Button>
      </div>
      {runs.length > 0 && (
        <div className="w-full flex-col justify-center mt-6">
          <div className="text-sm text-gray-700 mb-4">
            <code>throttled-function</code> runs:
          </div>
          <div className="flex flex-row gap-2">
            {runs
              .sort((a, b) => a.eventReceivedAt - b.eventReceivedAt)
              .map((run) => (
                <span
                  className={`w-8 h-8 rounded-sm flex items-center justify-center ${
                    run.status === "Running" ? "bg-gray-300" : "bg-emerald-500"
                  }`}
                  key={run.runId}
                >
                  {" "}
                </span>
              ))}
          </div>
        </div>
      )}
      {runs.length === 10 &&
        runs.every((run) => run.status === "Completed") && (
          <>
            <div className="w-full flex justify-center mt-10">
              <Button onClick={onNext}>Complete the Inngest tour</Button>
            </div>
            <div className="mt-4 w-full">
              <h3 className="text-lg font-semibold mb-2 text-gray-900">
                Learn more
              </h3>
              <ul className="list-disc text-gray-900">
                <li className="flex items-center gap-2 mt-2">
                  <BookMarked className="w-4 h-4 mr-1" />
                  <a href="https://www.inngest.com/docs/guides/throttling?ref=nextjs-starter-template">
                    Throttling documentation
                  </a>
                </li>
                <li className="flex items-center gap-2 mt-2">
                  <BookMarked className="w-4 h-4 mr-1" />
                  <a href="https://www.inngest.com/docs/guides/flow-control?ref=nextjs-starter-template">
                    Flow Control: Concurrency, Throttling, Debouncing and more
                  </a>
                </li>
              </ul>
            </div>
          </>
        )}
    </div>
  );
}

export default function Home() {
  const [api, setApi] = useState<CarouselApi>();

  const onNext = useCallback(() => {
    api?.scrollNext();
  }, [api]);

  return (
    <main className="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-4">
      {/* Header */}
      <div className="w-full max-w-xl flex items-center justify-between mb-8 px-2">
        <div className="flex items-center gap-2">
          <Image
            src="/inngest-logo.svg"
            alt="Inngest Logo"
            className="invert"
            width={120}
            height={36}
            priority
          />
        </div>
        <Link
          href="https://www.inngest.com/docs"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Button variant="outline" className="font-semibold cursor-pointer">
            <BookOpen className="w-4 h-4 mr-2" />
            Docs
          </Button>
        </Link>
      </div>
      <div className="w-full max-w-xl space-y-6">
        <Carousel setApi={setApi}>
          <CarouselContent>
            <CarouselItem>
              <Card className="p-8 space-y-6 border border-gray-200 bg-white">
                <h2 className="text-2xl font-bold text-gray-900 mb-2">
                  {steps[0].title}
                </h2>
                <p className="text-gray-600 mb-4">{steps[0].description}</p>
                <div className="min-h-[120px] flex items-center justify-center text-gray-400">
                  <Step1 onNext={onNext} />
                </div>
              </Card>
            </CarouselItem>
            <CarouselItem>
              <Card className="p-8 space-y-6 border border-gray-200 bg-white">
                <h2 className="text-2xl font-bold text-gray-900 mb-2">
                  {steps[1].title}
                </h2>
                <p className="text-gray-600 mb-4">{steps[1].description}</p>
                <div className="min-h-[120px] flex items-center justify-center text-gray-400">
                  <Step2 onNext={onNext} />
                </div>
              </Card>
            </CarouselItem>
            {!process.env.NEXT_PUBLIC_VERCEL_ENV && (
              <CarouselItem>
                <Card className="p-8 space-y-6 border border-gray-200 bg-white">
                  <h2 className="text-2xl font-bold text-gray-900 mb-2">
                    {steps[2].title}
                  </h2>
                  <p className="text-gray-600 mb-4">{steps[2].description}</p>
                  <div className="min-h-[120px] flex items-center justify-center text-gray-400">
                    <Step3 onNext={onNext} />
                  </div>
                </Card>
              </CarouselItem>
            )}
            <CarouselItem>
              <Card className="p-8 space-y-6 border border-gray-200 bg-white">
                <h2 className="text-2xl font-bold text-gray-900 mb-2">
                  {steps[3].title}
                </h2>
                <p className="text-gray-600 mb-0">{steps[3].description}</p>
                <Step4 onNext={onNext} />
              </Card>
            </CarouselItem>
            <CarouselItem>
              <Card className="p-8 space-y-6 border border-gray-200 bg-white">
                <h2 className="text-2xl font-bold text-gray-900 mb-2">
                  {steps[4].title}
                </h2>
                <p className="text-gray-600 mb-0">
                  {"You've now seen the main features of Inngest. "}
                  <a
                    href="https://www.inngest.com/docs"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-500 hover:underline"
                  >
                    Check out the docs
                  </a>{" "}
                  to learn more about Inngest and how to use it in your project.
                </p>
                <div className="flex flex-col items-start justify-center mt-2">
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">
                    Check out some project examples
                  </h3>
                  <p className="text-gray-600 mb-2">
                    Check out the following video tutorials showcasing how to
                    build Next.js projects with Inngest:
                  </p>
                  <ul>
                    <li className="flex items-center gap-2 mt-2">
                      <VideoIcon className="w-4 h-4 mr-1" />
                      <a
                        href="https://www.youtube.com/watch?v=egS6fnZAdzk&t=2647s"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Build a AI Finance Platform with Inngest and Next.js
                      </a>
                    </li>
                    <li className="flex items-center gap-2 mt-2">
                      <VideoIcon className="w-4 h-4 mr-1" />
                      <a
                        href="https://www.youtube.com/watch?v=nxK_TCt2pKw"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Build a E-Commerce App with Inngest and Next.js
                      </a>
                    </li>
                    <li className="flex items-center gap-2 mt-2">
                      <VideoIcon className="w-4 h-4 mr-1" />
                      <a
                        href="https://www.youtube.com/watch?v=VSrcC0y0umc"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Build a Perplexity Clone with Inngest and Next.js
                      </a>
                    </li>
                  </ul>
                </div>
              </Card>
            </CarouselItem>
          </CarouselContent>
          <CarouselPrevious />
          <CarouselNext />
        </Carousel>
      </div>
    </main>
  );
}
