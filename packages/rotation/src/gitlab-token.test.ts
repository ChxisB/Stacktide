import { describe, expect, test } from "bun:test";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { RotationError } from "./errors";
import { type GitlabTokenDeps, gitlabTokenRotator } from "./gitlab-token";
import { runRotatorConformance } from "./testing";

const CONNECTION = "0190f5a0-0000-7000-8000-00000000c0de";
const ORG = "org-1";

/** A mock GitLab with a project and a live token, and the provider over it. */
async function setup(over: Partial<GitlabTokenDeps> = {}) {
  const mock = createMockGitlab();
  const project = mock.addProject({ path: "platform/api" });
  const api = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  const token = await api.accessTokens.create(project.id, {
    name: "deploy",
    scopes: ["api"],
    expiresAt: "2999-01-01",
  });
  const opened: { organizationId: string; connectionId: string }[] = [];
  const rotator = gitlabTokenRotator({
    open: async (organizationId, connectionId) => {
      opened.push({ organizationId, connectionId });
      return api;
    },
    ...over,
  });
  const config = { connectionId: CONNECTION, projectId: project.id, tokenId: token.id };
  return { mock, api, project, token, rotator, config, opened };
}

runRotatorConformance("gitlab-token on the GitLab mock", async () => {
  const s = await setup();
  return { rotator: s.rotator, config: s.config, stop: s.mock.stop };
});

describe("gitlab-token provider", () => {
  test("ends the old token at once, hands back the new one, and moves the config to it", async () => {
    const s = await setup();
    const config = s.rotator.validate(s.config);
    const minted = await s.rotator.rotate({ config, key: "DEPLOY_TOKEN", organizationId: ORG });
    expect(s.rotator).toMatchObject({ external: true, endsReplaced: true });
    expect(s.mock.accessTokenValid(s.token.token as string)).toBe(false);
    expect(s.mock.accessTokenValid(minted.value)).toBe(true);
    expect(minted.handle).not.toBeNull();
    expect(minted.handle).not.toContain(minted.value);
    // ids and a lifetime only, no secret
    expect(minted.config).toEqual({ ...config, tokenId: Number(minted.handle) });
    expect(JSON.stringify(minted.config)).not.toContain(minted.value);
    // the next rotation starts from that config
    const again = await s.rotator.rotate({
      config: s.rotator.validate(minted.config),
      key: "DEPLOY_TOKEN",
      organizationId: ORG,
    });
    expect(s.mock.accessTokenValid(minted.value)).toBe(false);
    expect(s.mock.accessTokenValid(again.value)).toBe(true);
    s.mock.stop();
  });

  test("asks for a date that never ends the token before the lifetime the config names", async () => {
    // GitLab ends a token at 00:00 UTC of its date: the date a day on keeps it from dying early
    for (const [now, ends] of [
      ["2030-03-01T12:00:00Z", "2030-04-01"],
      ["2030-03-01T23:59:59Z", "2030-04-01"],
      ["2030-03-01T00:00:00Z", "2030-04-01"],
    ] as const) {
      const s = await setup({ now: () => new Date(now) });
      const config = s.rotator.validate({ ...s.config, expiresInDays: 30 });
      const minted = await s.rotator.rotate({ config, key: "K", organizationId: ORG });
      const read = await s.api.accessTokens.get(s.project.id, Number(minted.handle));
      expect(read.expiresAt).toBe(ends);
      expect(Date.parse(`${read.expiresAt}T00:00:00Z`) - Date.parse(now)).toBeGreaterThanOrEqual(
        30 * 86_400_000,
      );
      s.mock.stop();
    }
  });

  test("states the lifetime a rotation interval has to stay under", async () => {
    const { rotator, config } = await setup();
    expect(rotator.lifetimeDays?.(rotator.validate(config))).toBe(90);
    expect(rotator.lifetimeDays?.(rotator.validate({ ...config, expiresInDays: 7 }))).toBe(7);
  });

  test("opens the connection for the organization of the rotation, on rotate and on revoke", async () => {
    const s = await setup();
    const config = s.rotator.validate(s.config);
    const minted = await s.rotator.rotate({ config, key: "K", organizationId: "org-A" });
    await s.rotator.revoke(config, minted.handle as string, { organizationId: "org-B" });
    expect(s.opened).toEqual([
      { organizationId: "org-A", connectionId: CONNECTION },
      { organizationId: "org-B", connectionId: CONNECTION },
    ]);
    s.mock.stop();
  });

  test("a connection that cannot be opened stops the rotation before GitLab is asked", async () => {
    const refused = new RotationError("denied", "no such connection");
    const s = await setup({
      open: async () => {
        throw refused;
      },
    });
    const config = s.rotator.validate(s.config);
    await expect(s.rotator.rotate({ config, key: "K", organizationId: ORG })).rejects.toBe(refused);
    // the token is still the live one
    expect(s.mock.accessTokenValid(s.token.token as string)).toBe(true);
    s.mock.stop();
  });

  test("maps what GitLab says to a kind, and never carries its text or a token", async () => {
    const s = await setup();
    const config = s.rotator.validate(s.config);
    const kindOf = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        expect(e).toBeInstanceOf(RotationError);
        expect((e as RotationError).message).not.toContain(s.mock.token);
        expect((e as RotationError).message).not.toContain("glpat");
        return (e as RotationError).kind;
      }
      throw new Error("expected a failure");
    };
    const rotate = () => s.rotator.rotate({ config, key: "K", organizationId: ORG });
    for (const [status, kind] of [
      [401, "denied"],
      [403, "denied"],
      [404, "invalid_config"],
      [400, "failed"],
      [500, "failed"],
    ] as const) {
      s.mock.inject({ method: "POST", path: /\/rotate$/, status });
      expect(await kindOf(rotate())).toBe(kind);
    }
    // a failed call changed nothing at GitLab
    expect(s.mock.accessTokenValid(s.token.token as string)).toBe(true);
    // an old id GitLab has already revoked is refused (no silent success)
    await s.rotator.rotate({ config, key: "K", organizationId: ORG });
    expect(await kindOf(rotate())).toBe("failed");
    s.mock.stop();
  });

  test("revoking ends the token; one that is gone, or a handle that is no token id, is done", async () => {
    const s = await setup();
    const config = s.rotator.validate(s.config);
    await s.rotator.revoke(config, String(s.token.id), { organizationId: ORG });
    expect(s.mock.accessTokenValid(s.token.token as string)).toBe(false);
    await s.rotator.revoke(config, "2000000000", { organizationId: ORG });
    const before = s.opened.length;
    for (const handle of ["", "abc", "0", "-3", "1.5"]) {
      await s.rotator.revoke(config, handle, { organizationId: ORG });
    }
    expect(s.opened.length).toBe(before);
    // other failures are not swallowed
    s.mock.inject({ method: "DELETE", status: 403 });
    await expect(
      s.rotator.revoke(config, String(s.token.id), { organizationId: ORG }),
    ).rejects.toMatchObject({ kind: "denied" });
    s.mock.stop();
  });

  test("validates ids and the lifetime, applies the default, and echoes none of what it refuses", async () => {
    const { rotator, config } = await setup();
    expect(rotator.validate(config)).toEqual({ ...config, expiresInDays: 90 });
    expect(rotator.validate({ ...config, expiresInDays: 365 }).expiresInDays).toBe(365);
    const CANARY = "canary-6b1d";
    for (const bad of [
      { ...config, connectionId: CANARY },
      { ...config, connectionId: undefined },
      { ...config, projectId: 0 },
      { ...config, projectId: "7" },
      { ...config, tokenId: 1.5 },
      { ...config, tokenId: undefined },
      { ...config, expiresInDays: 0 },
      { ...config, expiresInDays: 366 },
      { ...config, expiresInDays: "30" },
      { ...config, [CANARY]: CANARY },
    ]) {
      let error: unknown;
      try {
        rotator.validate(bad);
      } catch (e) {
        error = e;
      }
      expect((error as RotationError).kind).toBe("invalid_config");
      expect((error as RotationError).message).not.toContain(CANARY);
    }
  });
});
