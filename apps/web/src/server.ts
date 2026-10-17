import index from "../index.html";

const HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length"];

/**
 * The app and the API on one origin: `/` is the page, everything else goes to the API, so the
 * session cookie and the GitLab sign-in redirect work without CORS. Redirects pass through as they
 * are (the browser follows them), and nothing is cached or rewritten.
 */
export function startWeb({
  api,
  port = 0,
  hostname = "127.0.0.1",
  development = false,
}: {
  api: string;
  port?: number;
  hostname?: string;
  development?: boolean;
}) {
  return Bun.serve({
    port,
    hostname,
    development,
    routes: { "/": index },
    async fetch(request) {
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      for (const name of HOP) headers.delete(name);
      // only the path and query come from the request: `new URL("//evil.test/x", api)` would be another host
      const target = new URL(api);
      target.pathname = url.pathname;
      target.search = url.search;
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        body: request.body,
        signal: request.signal,
        redirect: "manual",
      }).catch(() => undefined);
      if (!upstream) return new Response("The API cannot be reached.", { status: 502 });
      const out = new Headers(upstream.headers);
      // fetch has already decoded the body
      out.delete("content-encoding");
      out.delete("content-length");
      return new Response(upstream.body, { status: upstream.status, headers: out });
    },
  });
}

if (import.meta.main) {
  const port = Number(process.env.WEB_PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("WEB_PORT must be a port number, 1 to 65535");
  }
  const server = startWeb({
    api: process.env.ORCH_API_URL ?? "http://127.0.0.1:3000",
    port,
    development: process.env.NODE_ENV !== "production",
  });
  console.log(`web on http://${server.hostname}:${server.port}`);
}
