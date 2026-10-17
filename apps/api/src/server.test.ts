import { expect, test } from "bun:test";
import { createLogger } from "@orch/core";
import { createDb } from "@orch/db";
import { createApp } from "./app";
import { devPrincipal } from "./principal";

test("stop() lets an in-flight request finish and then refuses new connections", async () => {
  const app = createApp({
    logger: createLogger({ write: () => {} }),
    db: createDb("postgres://unused:unused@127.0.0.1:1/unused", 1),
    principal: devPrincipal,
    ready: async () => {},
  })
    .get("/slow", async () => {
      await Bun.sleep(300);
      return { done: true };
    })
    .listen({ hostname: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${app.server?.port}`;

  const inFlight = fetch(`${base}/slow`);
  await Bun.sleep(50);
  const stopped = app.stop();

  const res = await inFlight;
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ done: true });
  await stopped;
  await expect(fetch(`${base}/health`)).rejects.toThrow();
});
