import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createLogger } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  claimDue,
  createConnection,
  createEnvironment,
  createOrganization,
  createProject,
  createVariable,
  getRotation,
  revealVariable,
  setRotation,
  variableRotations,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab, type MockGitlab } from "@orch/gitlab/mock";
import { RotationError } from "@orch/rotation";
import { rotateVariable } from "./rotate";
import { builtInRotators } from "./rotators";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const DAY = 86_400_000;
const actor = { kind: "user", id: "u1" };

let t: TestDb;
let mock: MockGitlab;
let lines: string[];
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  // claimDue takes whatever is due: rows of an earlier test must not be handed to this one
  await t.db.delete(variableRotations);
  mock?.stop();
  mock = createMockGitlab();
  lines = [];
});

let n = 0;
const deps = () => {
  const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
  return {
    db: t.db,
    keys,
    logger,
    rotators: builtInRotators({ db: t.db, keys, logger }),
  };
};

/** An organization with a GitLab connection to the mock, a project on it with a live token, and a secret that rotates it. */
async function world(
  opts: { protectedEnv?: boolean; connection?: "other-org" | "not-gitlab" } = {},
) {
  const org = await createOrganization(t.db, { slug: `r${++n}`, name: "R" });
  const stranger = await createOrganization(t.db, { slug: `s${n}`, name: "S" });
  const project = await createProject(t.db, { organizationId: org.id, name: `p${n}` });
  const env = await createEnvironment(t.db, {
    organizationId: org.id,
    projectId: project.id,
    name: "Dev",
    slug: "dev",
    protected: opts.protectedEnv ?? false,
  });
  const connection = await createConnection(t.db, keys, {
    organizationId: opts.connection === "other-org" ? stranger.id : org.id,
    type: opts.connection === "not-gitlab" ? "other" : "gitlab",
    name: "live",
    config: { baseUrl: mock.url },
    token: mock.token,
  });
  const gl = mock.addProject({ path: `platform/p${n}` });
  const api = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  const live = await api.accessTokens.create(gl.id, {
    name: "deploy",
    scopes: ["api"],
    expiresAt: "2999-01-01",
  });
  const scope = { organizationId: org.id, projectId: project.id, environmentId: env.id };
  const variable = await createVariable(t.db, keys, {
    ...scope,
    key: "DEPLOY_TOKEN",
    kind: "secret",
    value: live.token as string,
    actor,
  });
  const now = new Date();
  const set = await setRotation(t.db, {
    organizationId: org.id,
    variableId: variable.id,
    provider: "gitlab-token",
    config: { connectionId: connection.id, projectId: gl.id, tokenId: live.id },
    intervalDays: 30,
    graceDays: 0,
    now,
  });
  if ("error" in set) throw new Error(set.error);
  const claim = async () => {
    const found = (
      await claimDue(t.db, { now: new Date(now.getTime() + 31 * DAY), limit: 50 })
    ).find((r) => r.id === set.row.id);
    if (!found) throw new Error("not claimed");
    return found;
  };
  return { org, scope, variable, live, gl, claim, rotation: set.row };
}

const requests = () => mock.requests.map((r) => `${r.method} ${r.path}`);

describe("the gitlab-token provider in the rotation engine", () => {
  test("the new token exists only as the variable's new version; the old one is dead", async () => {
    const w = await world();
    const out = await rotateVariable(deps(), await w.claim());
    expect(out).toEqual({ result: "rotated", version: 2 });

    const revealed = (await revealVariable(t.db, keys, w.scope, w.variable.id))?.value as string;
    expect(revealed).toMatch(/^glpat-/);
    expect(revealed).not.toBe(w.live.token as string);
    // GitLab honours the new token and no longer the old one
    expect(mock.accessTokenValid(revealed)).toBe(true);
    expect(mock.accessTokenValid(w.live.token as string)).toBe(false);

    // the rotation now points at the new token, and has no replaced credential to revoke
    const row = await getRotation(t.db, w.org.id, w.variable.id);
    const newId = (await rotatedId(w)) as number;
    expect(row).toMatchObject({
      handle: String(newId),
      previousHandle: null,
      lastStatus: "ok",
      config: { tokenId: newId },
    });

    // canary: the token is in the sealed version and in no row, audit event or log line
    const rows = JSON.stringify(await t.db.select().from(variableRotations));
    const audits = JSON.stringify(await t.db.select().from(auditEvents));
    for (const [where, text] of [
      ["rotation rows", rows],
      ["audit events", audits],
      ["log", lines.join("\n")],
    ] as const) {
      expect([where, text.includes(revealed)]).toEqual([where, false]);
      expect([where, text.includes(w.live.token as string)]).toEqual([where, false]);
    }
  });

  test("another organization's connection, or one that is not GitLab's, is refused before GitLab is asked", async () => {
    for (const connection of ["other-org", "not-gitlab"] as const) {
      const w = await world({ connection });
      mock.requests.splice(0);
      const error = await rotateVariable(deps(), await w.claim()).catch((e) => e);
      expect(error).toBeInstanceOf(RotationError);
      expect((error as RotationError).kind).toBe("denied");
      expect((error as RotationError).message).not.toContain(mock.token);
      expect(requests()).toEqual([]);
      expect(mock.accessTokenValid(w.live.token as string)).toBe(true);
    }
  });

  test("a protected environment is refused before the token is rotated", async () => {
    const w = await world({ protectedEnv: true });
    mock.requests.splice(0);
    await expect(rotateVariable(deps(), await w.claim())).rejects.toMatchObject({ kind: "denied" });
    expect(requests().filter((r) => r.includes("access_tokens"))).toEqual([]);
    expect(mock.accessTokenValid(w.live.token as string)).toBe(true);
  });

  test("a rotation GitLab refuses leaves the variable and the live token alone", async () => {
    const w = await world();
    mock.inject({ method: "POST", path: /\/rotate$/, status: 500 });
    await expect(rotateVariable(deps(), await w.claim())).rejects.toMatchObject({ kind: "failed" });
    expect((await revealVariable(t.db, keys, w.scope, w.variable.id))?.value).toBe(
      w.live.token as string,
    );
    expect(mock.accessTokenValid(w.live.token as string)).toBe(true);
    // not retried: a rotation GitLab did carry out, sent again, would aim at the token it just ended
    expect(requests().filter((r) => r.endsWith("/rotate"))).toHaveLength(1);
  });
});

/** The id GitLab gave the new token: the one that is valid now. */
async function rotatedId(w: Awaited<ReturnType<typeof world>>) {
  const row = await getRotation(t.db, w.org.id, w.variable.id);
  return Number((row?.config as { tokenId?: number } | undefined)?.tokenId);
}
