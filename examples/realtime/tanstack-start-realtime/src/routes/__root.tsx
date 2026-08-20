/// <reference types="vite/client" />
import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import type * as React from "react";
import appCss from "~/styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "AI Blog Post Generator — Inngest Realtime" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  notFoundComponent: () => <div className="p-8 text-gray-500">Not found</div>,
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="bg-gray-50 text-gray-900 antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
