import { describe, expect, test } from "bun:test";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { RotationError } from "./errors";
import { gitlabLeaser } from "./gitlab-lease";

const CONNECTION = "0190f5a0-0000-7000-8000-00000000c0de";
const ORG = "org-1";

async function setup() {
  const mock = createMockGitlab();
  const project = mock.addProject({ path: "platform/api" });
  const api = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  const opened: { organizationId: string; connectionId: string }[] = [];
  const leaser = gitlabLeaser({
    open: async (organizationId, connectionId) => {
      opened.push({ organizationId, connectionId });
      return api;
    },
  });
  const request = (over: Partial<Parameters<typeof leaser.issue>[0]> = {}) => ({
    organizationId: ORG,
    target: { connectionId: CONNECTION, projectId: project.id },
    scopes: ["read_repository"],
    expiresAt: new Date("2030-03-01T12:00:00Z"),
    name: "orch-lease-1",
    ...over,
  });
  return { mock, api, project, leaser, request, opened };
}

describe("gitlab-token leases", () => {
  test("makes a read-only Reporter token that GitLab ends the day after the lease, and hands the value back once", async () => {
    const s = await setup();
    const made = await s.leaser.issue(s.request({ scopes: ["read_api", "read_repository"] }));
    expect(s.mock.accessTokenValid(made.value)).toBe(true);
    const read = await s.api.accessTokens.get(s.project.id, Number(made.handle));
    expect(read).toMatchObject({
      name: "orch-lease-1",
      scopes: ["read_api", "read_repository"],
      accessLevel: 20,
      expiresAt: "2030-03-02",
    });
    // the handle is an id, not the value, and GitLab never shows the value again
    expect(made.handle).not.toContain(made.value);
    expect(read.token).toBeNull();
    s.mock.stop();
  });

  test("the date a day on never falls before the lease, even at its last second", async () => {
    const s = await setup();
    const late = await s.leaser.issue(s.request({ expiresAt: new Date("2030-03-01T23:59:59Z") }));
    expect((await s.api.accessTokens.get(s.project.id, Number(late.handle))).expiresAt).toBe(
      "2030-03-02",
    );
    const early = await s.leaser.issue(s.request({ expiresAt: new Date("2030-03-01T00:00:00Z") }));
    expect((await s.api.accessTokens.get(s.project.id, Number(early.handle))).expiresAt).toBe(
      "2030-03-02",
    );
    s.mock.stop();
  });

  test("a scope that writes is refused before GitLab hears of it", async () => {
    const s = await setup();
    for (const scopes of [["api"], ["read_repository", "write_repository"], []]) {
      const e = await s.leaser.issue(s.request({ scopes })).catch((x) => x);
      expect(e).toBeInstanceOf(RotationError);
      expect(e.kind).toBe("invalid_config");
    }
    expect(s.opened).toEqual([]);
    s.mock.stop();
  });

  test("revoke ends the token, and revoking again or an unknown token is done, not an error", async () => {
    const s = await setup();
    const made = await s.leaser.issue(s.request());
    const scope = { organizationId: ORG };
    await s.leaser.revoke(s.request().target, made.handle, scope);
    expect(s.mock.accessTokenValid(made.value)).toBe(false);
    await s.leaser.revoke(s.request().target, made.handle, scope);
    await s.leaser.revoke(s.request().target, "999999", scope);
    // not an id: nothing to ask GitLab about
    const before = s.opened.length;
    await s.leaser.revoke(s.request().target, "../x", scope);
    expect(s.opened).toHaveLength(before);
    s.mock.stop();
  });

  test("opens the connection for the organization asking, on issue and on revoke", async () => {
    const s = await setup();
    const made = await s.leaser.issue(s.request({ organizationId: "org-A" }));
    await s.leaser.revoke(s.request().target, made.handle, { organizationId: "org-B" });
    expect(s.opened).toEqual([
      { organizationId: "org-A", connectionId: CONNECTION },
      { organizationId: "org-B", connectionId: CONNECTION },
    ]);
    s.mock.stop();
  });

  test("a project GitLab does not have is a refusal that names no value, and a token GitLab refuses is `denied`", async () => {
    const s = await setup();
    const gone = await s.leaser
      .issue(s.request({ target: { connectionId: CONNECTION, projectId: 987654 } }))
      .catch((x) => x);
    expect(gone).toBeInstanceOf(RotationError);
    expect(gone.kind).toBe("invalid_config");
    const none = await s.leaser
      .issue(s.request({ target: { connectionId: CONNECTION, projectId: 0 } }))
      .catch((x) => x);
    expect(none.kind).toBe("invalid_config");

    const refused = gitlabLeaser({
      open: async () => {
        throw new RotationError("denied", "the connection cannot be opened");
      },
    });
    const denied = await refused.issue(s.request()).catch((x) => x);
    expect(denied.kind).toBe("denied");
    s.mock.stop();
  });
});
