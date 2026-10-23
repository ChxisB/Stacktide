import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import { type Backend, mount, startBackend } from "./testing";

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());

const region = (name: string) => screen.findByRole("region", { name }, { timeout: 5000 });

describe("settings and organizations layout", () => {
  test("every section of the settings page is a card", async () => {
    window.location.hash = "#/settings";
    const org = await backend.organization("Cards");
    const owner = await backend.signIn("owner of cards", {
      orgRoles: { [org.id]: "owner" },
      projectRoles: {},
    });
    mount(owner.client);
    for (const name of [
      "Your access",
      "Connections",
      "Worker pools",
      "Single sign-on",
      "Sign-in methods",
      "Your API tokens",
    ]) {
      expect((await region(name)).classList.contains("card")).toBe(true);
    }
    // the connections and pools are tables, so the cards take the whole page
    expect((await region("Connections")).closest(".stack")?.classList.contains("wide")).toBe(true);
  });

  test("the organization, its members and creating one are cards", async () => {
    window.location.hash = "#/organizations";
    const org = await backend.organization("Cards two");
    const platform = await backend.signIn("platform of cards", {
      orgRoles: { [org.id]: "owner" },
      projectRoles: {},
    });
    backend.makePlatformAdmin(platform.user.gitlabId ?? 0);
    mount(platform.client);
    for (const name of ["Create an organization", "This organization", "Members"]) {
      expect((await region(name)).classList.contains("card")).toBe(true);
    }
    expect((await region("Members")).closest(".stack")?.classList.contains("wide")).toBe(true);
  });
});
