import { serializePage, type PageObject, type RootView } from "@hono/inertia";
import { renderToString } from "react-dom/server";
import { Link, ReactRefresh, Script, ViteClient } from "vite-ssr-components/react";

function Document({ page }: { page: PageObject }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>wr</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <script
          dangerouslySetInnerHTML={{
            __html: `const theme=localStorage.getItem("wr-theme");document.documentElement.classList.toggle("dark",theme==="dark"||(theme===null&&matchMedia("(prefers-color-scheme: dark)").matches));`,
          }}
        />
        <ViteClient />
        <ReactRefresh />
        <Link href="/web/styles.css" rel="stylesheet" />
        <Script src="/web/main.tsx" />
      </head>
      <body>
        <script
          data-page="app"
          type="application/json"
          dangerouslySetInnerHTML={{ __html: serializePage(page) }}
        />
        <div id="app" />
      </body>
    </html>
  );
}

export const rootView: RootView = (page) =>
  `<!doctype html>${renderToString(<Document page={page} />)}`;
