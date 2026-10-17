import { describe, expect, test } from "bun:test";
import type { GitlabClient } from "./client";
import { membersApi } from "./members";

// What GitLab says is the mock's business; this is how the client reads an answer that leaves fields out.
const answering = (body: unknown) =>
  membersApi({ request: async () => body } as unknown as GitlabClient).members;

describe("a member answer with fields missing", () => {
  test("a GitLab that does not send membership_state has no awaiting invites", async () => {
    expect(
      await answering({ access_level: 40, state: "active" }).accessLevel({ group: 1 }, 7),
    ).toBe(40);
  });

  test("an answer that does not say the account is active grants nothing", async () => {
    expect(await answering({ access_level: 40 }).accessLevel({ group: 1 }, 7)).toBe(0);
    expect(
      await answering({ access_level: 40, membership_state: "active" }).accessLevel(
        { group: 1 },
        7,
      ),
    ).toBe(0);
  });

  test("an answer that is not a member at all is refused, not read as no access", async () => {
    await expect(answering({ nope: 1 }).accessLevel({ group: 1 }, 7)).rejects.toThrow();
  });
});
