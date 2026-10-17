import { createApp } from "@orch/api";
import { callerPrincipal } from "@orch/api/credentials";
import { hashToken, randomToken } from "@orch/api/tokens";
import { createClient } from "@orch/api-client";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import { createOrganization, createSession, upsertUser } from "@orch/db";
import { createTestDb } from "@orch/db/testing";
import { createMockGitlab } from "@orch/gitlab/mock";
import { render, waitFor } from "@testing-library/react";
import { App, newQueryClient } from "./app";

type Roles = Pick<Subject, "orgRoles" | "projectRoles">;

/**
 * The real API on a real port over a fresh test database, so a screen is tested against what the
 * server really answers. Sessions are made in the database, as a sign-in would.
 */
export async function startBackend() {
  const t = await createTestDb();
  const keys = envKeyProvider(`k1:${Buffer.alloc(32, 9).toString("base64")}`);
  const roles = new Map<number, Roles>();
  const app = createApp({
    logger: createLogger({ level: "error", write: () => {} }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roles.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys,
    // the mock GitLab is on loopback, which the API refuses for a real connection
    loopbackConnections: true,
  }).listen({ port: 0, hostname: "127.0.0.1" });
  const api = `http://127.0.0.1:${app.server?.port}`;

  let gitlabId = 1000;
  let orgs = 0;
  const mocks: ReturnType<typeof createMockGitlab>[] = [];
  return {
    api,
    t,
    keys,
    /** A client without a session. */
    anonymous: () => createClient(api),
    /** A user with a live session, and a client that sends its cookie. */
    async signIn(name: string, held: Roles = { orgRoles: {}, projectRoles: {} }) {
      const user = await upsertUser(t.db, {
        gitlabId: ++gitlabId,
        username: name.toLowerCase().replaceAll(" ", "-"),
        name,
      });
      roles.set(user.gitlabId, held);
      const token = randomToken();
      await createSession(t.db, { userId: user.id, tokenHash: hashToken(token), ttlMs: 3_600_000 });
      const cookie = `orch_session=${token}`;
      return { user, cookie, client: createClient(api, { headers: { cookie } }) };
    },
    /** A new organization, for a test of its own. */
    organization: (name = "Acme") => createOrganization(t.db, { slug: `org-${++orgs}`, name }),
    /** A mock GitLab that sees what the test adds to it, and is stopped with the backend. */
    gitlab(maxPerPage?: number) {
      const mock = createMockGitlab({
        scopes: ["read_api"],
        ...(maxPerPage ? { maxPerPage } : {}),
      });
      mocks.push(mock);
      return mock;
    },
    /** Roles of a user already signed in (the API reads them at each request). */
    setRoles: (gitlabUserId: number, held: Roles) => roles.set(gitlabUserId, held),
    async stop() {
      for (const mock of mocks) mock.stop();
      await app.stop(true);
      await t.drop();
    },
  };
}
export type Backend = Awaited<ReturnType<typeof startBackend>>;

export const mount = (client: ReturnType<typeof createClient>, queries = newQueryClient()) => ({
  queries,
  /** Resolves when nothing is being fetched, so a test does not end with an update on its way. */
  settled: () =>
    waitFor(() => {
      if (queries.isFetching() > 0) throw new Error("still fetching");
    }),
  ...render(<App client={client} queries={queries} />),
});

/** A client for a session whose requests pass through `handle`, which may answer in place of the server. */
export function clientVia(
  api: string,
  cookie: string,
  handle: (request: Request, send: () => Promise<Response>) => Promise<Response>,
) {
  const fetcher = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      return handle(request, () => fetch(request.clone()));
    },
    { preconnect: fetch.preconnect },
  );
  return createClient(api, { headers: { cookie }, fetcher });
}

/** A 500 in the API's own problem format, for a handler of `clientVia` to answer with. */
export const down = (detail: string) =>
  Response.json(
    { type: "x", title: "Oops", status: 500, code: "internal", detail },
    { status: 500 },
  );

export const pathOf = (request: Request) => new URL(request.url).pathname;
