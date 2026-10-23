import { expect, test } from "bun:test";
import { createGithubClient } from "@orch/github";
import { createGitlab } from "@orch/gitlab";
import { githubForge } from "./github";
import { gitlabForge } from "./gitlab";
import { CAPABILITY_FLAGS, capabilitiesOf, type Forge } from "./index";

const forge = gitlabForge(
  createGitlab({
    baseUrl: "http://127.0.0.1:1",
    auth: { type: "private-token", token: "not-a-real-token" },
  }),
);

test("the GitLab adapter reports every capability, and exactly the ones the table names", () => {
  expect(Object.keys(forge.capabilities).sort()).toEqual([...CAPABILITY_FLAGS].sort());
  for (const flag of CAPABILITY_FLAGS) expect(forge.capabilities[flag], flag).toBe(true);
  expect(forge.kind).toBe("gitlab");
});

test("an operation outside the table is neither typed nor there", () => {
  // @ts-expect-error `groups` is not in the table: nothing the platform runs calls it
  void forge.groups;
  // @ts-expect-error nor is an operation nobody named
  void forge.projects.archive;
  expect("groups" in forge).toBe(false);
  const typed: Forge = forge; // the adapter is a `Forge` as it stands
  expect(typed.kind).toBe("gitlab");
});

test("a capability the table does not name does not compile", () => {
  // @ts-expect-error a flag missing from `capabilities` is a compile error for every adapter
  const incomplete: Forge["capabilities"] = { tokenScopes: true };
  expect(incomplete.tokenScopes).toBe(true);
});

test("what a screen is told of a forge is what its adapter says (FRG-24)", () => {
  expect(capabilitiesOf("gitlab")).toEqual(forge.capabilities);
  expect(capabilitiesOf("github")).toEqual(
    githubForge(
      createGithubClient({
        baseUrl: "http://127.0.0.1:1",
        allowInsecureHttp: true,
        token: "not-a-real-token",
      }),
    ).capabilities,
  );
  // GitHub says yes to the one flag it has, so a screen shows "approvalState" as there on both
  expect(capabilitiesOf("github").ciLint).toBe(false);
  expect(capabilitiesOf("github").approvalState).toBe(true);
});
