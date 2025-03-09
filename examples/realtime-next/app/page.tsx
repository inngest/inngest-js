"use client";

import { useInngestSubscription } from "@/hooks/useInngestSubscription";
import { getInngestApp } from "@/inngest";
import Image from "next/image";
import { useCallback, useMemo, useState } from "react";
import { invoke } from "./actions";

export default function Home() {
  const [token, setToken] = useState<Awaited<ReturnType<typeof invoke>> | null>(
    null
  );

  const buttonHandler = useCallback(async () => {
    if (token) {
      return;
    }

    console.log("buttonHandler is calling invoke");

    const t = await invoke();
    console.log(t);
    setToken(t);
  }, [token]);
  const app = useMemo(getInngestApp, []);

  const { data, error } = useInngestSubscription({
    app,
    enabled: Boolean(token),
    ...(token as Awaited<ReturnType<typeof invoke>>),
  });

  return (
    <div className="grid grid-rows-[20px_1fr_20px] items-center justify-items-center min-h-screen p-8 pb-20 gap-16 sm:p-20 font-[family-name:var(--font-geist-sans)]">
      <main className="flex flex-col gap-8 row-start-2 items-center sm:items-start">
        <Image
          className="dark:invert"
          src="/next.svg"
          alt="Next.js logo"
          width={180}
          height={38}
          priority
        />
        <div className="flex gap-4 items-center flex-col sm:flex-row">
          <a
            className="rounded-full border border-solid border-transparent transition-colors flex items-center justify-center bg-foreground text-background gap-2 hover:bg-[#383838] dark:hover:bg-[#ccc] text-sm sm:text-base h-10 sm:h-12 px-4 sm:px-5"
            onClick={buttonHandler}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Image
              className="dark:invert"
              src="/vercel.svg"
              alt="Vercel logomark"
              width={20}
              height={20}
            />
            Invoke function {error?.message}
          </a>
        </div>

        <ol className="list-inside list-decimal text-sm text-center sm:text-left font-[family-name:var(--font-geist-mono)]">
          {data?.map((message, i) => (
            <li key={i}>
              {message.channel}/${message.topic}: {JSON.stringify(message.data)}
            </li>
          ))}
        </ol>
      </main>
    </div>
  );
}
