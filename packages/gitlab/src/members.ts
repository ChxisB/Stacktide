import { z } from "zod";
import type { GitlabClient } from "./client";
import { decode } from "./decode";
import { GitlabError } from "./errors";
import { gitlabUser } from "./oauth";
import { type ProjectRef, projectPath } from "./projects";

/** Whose members: a project's or a group's. */
export type MemberOwner = { project: ProjectRef } | { group: number | string };

// `state` is the account's, `membership_state` the membership's (an invite awaiting approval).
const member = z.object({
  access_level: z.number().int(),
  state: z.string().optional(),
  membership_state: z.string().optional(),
});

// A personal, project or group access token describing itself; GitLab sends `expires_at` as a date or null.
const tokenSelf = z.object({ scopes: z.array(z.string()), expires_at: z.string().nullish() });

export function membersApi(client: GitlabClient) {
  return {
    users: {
      /** The user the token belongs to. */
      async current() {
        return decode(gitlabUser, await client.request("GET", "/user"), "user");
      },
      /** What the token says about itself (`GET /personal_access_tokens/self`): its scopes and its expiry date, `null` for none. */
      async tokenInfo() {
        const t = decode(
          tokenSelf,
          await client.request("GET", "/personal_access_tokens/self"),
          "token",
        );
        return { scopes: t.scopes, expiresAt: t.expires_at ?? null };
      },
    },
    members: {
      /**
       * A user's GitLab access level on a project or group, inherited and invited membership
       * included (`members/all`); 0 when the user is not a member, the project or group is not
       * visible to the token, or the account or membership is not active. Any other failure
       * throws: a lookup that did not finish must not read as "no access".
       */
      async accessLevel(owner: MemberOwner, userId: number) {
        const base =
          "project" in owner
            ? projectPath(owner.project)
            : `/groups/${encodeURIComponent(String(owner.group))}`;
        let raw: unknown;
        try {
          raw = await client.request("GET", `${base}/members/all/${userId}`);
        } catch (error) {
          if (error instanceof GitlabError && error.kind === "not_found") return 0;
          throw error;
        }
        const m = decode(member, raw, "member");
        // Required, not defaulted: an answer that does not say the account is active grants nothing.
        const active = m.state === "active" && (m.membership_state ?? "active") === "active";
        return active ? m.access_level : 0;
      },
    },
  };
}
