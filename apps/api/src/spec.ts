import { createLogger } from "@orch/core";
import type { Db } from "@orch/db";
import { createApp } from "./app";
import { devPrincipal } from "./principal";

/** The app with no database behind it: routes only touch `db` inside handlers. */
export const specApp = () =>
  createApp({
    logger: createLogger({ write: () => {} }),
    db: undefined as unknown as Db,
    principal: devPrincipal,
    ready: async () => {},
  });

/** The OpenAPI document as served at `/openapi/json`. */
export async function buildSpec(): Promise<string> {
  const res = await specApp().handle(new Request("http://localhost/openapi/json"));
  if (!res.ok) throw new Error(`OpenAPI document failed (${res.status})`);
  return `${JSON.stringify(await res.json(), null, 2)}\n`;
}
