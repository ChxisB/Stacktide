import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { parseDotenv } from "@orch/core";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, clientVia, mount, pathOf, startBackend } from "./testing";
import { must, SECRET, scene as sceneOn, showCompare, withClipboard } from "./variables.fixture";

// VUI-16: each environment's column head in the All environments matrix has a menu: copy the slug, download that
// environment's .env (the same audited export as the list's) and open its changes.

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());

const made: Blob[] = [];
const clicked: { href: string; name: string }[] = [];
const real = {
  create: URL.createObjectURL,
  revoke: URL.revokeObjectURL,
  click: HTMLAnchorElement.prototype.click,
};
beforeEach(() => {
  window.location.hash = "#/variables";
  made.length = clicked.length = 0;
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    made.push(blob as Blob);
    return `blob:test/${made.length - 1}`;
  };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, name: this.download });
  };
});
afterEach(() => {
  URL.createObjectURL = real.create;
  URL.revokeObjectURL = real.revoke;
  HTMLAnchorElement.prototype.click = real.click;
});

const scene = (options?: { reporter?: boolean }) => sceneOn(backend, options);

async function withValues(options?: { reporter?: boolean }) {
  const s = await scene(options);
  await s.put.project("REGION", "eu");
  await s.put.env("dev", "API_KEY", SECRET, true);
  await s.put.env("staging", "STAGING_ONLY", "staging-secret-3b9", true);
  return s;
}
/** The matrix, with the menu of one environment's column head open. */
async function menuOf(env: string) {
  await showCompare();
  await screen.findByRole("table", { name: "Variables by environment" });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: `Options for ${env}` }));
  return user;
}

describe("the column menu", () => {
  test("each environment's head has one, with the three items", async () => {
    const s = await withValues();
    mount(s.client);
    await menuOf("staging");
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Copy environment slug",
      "Download .env",
      "View changes",
    ]);
    expect(screen.getByRole("button", { name: "Options for dev" })).toBeTruthy();
  });

  test("Copy environment slug puts the slug, not the name, on the clipboard", async () => {
    const s = await withValues();
    must(await s.scope.environments.post({ name: "Prod EU", slug: "prod-eu" }));
    mount(s.client);
    // opened first: showCompare sets up a user-event of its own, which would replace the clipboard
    await showCompare();
    await screen.findByRole("table", { name: "Variables by environment" });
    await withClipboard("keeps", async (written, user) => {
      await user.click(await screen.findByRole("button", { name: "Options for Prod EU" }));
      await user.click(screen.getByRole("menuitem", { name: "Copy environment slug" }));
      await waitFor(() => expect(written).toEqual(["prod-eu"]));
      expect((await screen.findByRole("status")).textContent).toBe("Copied the slug of Prod EU");
    });
  });

  test("a clipboard that refuses is said in words", async () => {
    const s = await withValues();
    mount(s.client);
    await showCompare();
    await screen.findByRole("table", { name: "Variables by environment" });
    await withClipboard("refuses", async (_written, user) => {
      await user.click(screen.getByRole("button", { name: "Options for dev" }));
      await user.click(screen.getByRole("menuitem", { name: "Copy environment slug" }));
      expect((await screen.findByRole("alert")).textContent).toBeTruthy();
      expect(screen.queryByRole("status")).toBeNull();
    });
  });

  test("Download .env is one file of that environment, from one export read, named for it", async () => {
    const s = await withValues();
    const reads: string[] = [];
    const client = clientVia(backend.api, s.cookie, async (request, send) => {
      if (pathOf(request).endsWith("/values")) reads.push(pathOf(request));
      return send();
    });
    mount(client);
    const user = await menuOf("staging");
    await user.click(screen.getByRole("menuitem", { name: "Download .env" }));
    await screen.findByText(/Downloaded acme-web-staging\.env/);
    expect(reads).toHaveLength(1);
    expect(clicked).toEqual([{ href: "blob:test/0", name: "acme-web-staging.env" }]);
    const parsed = parseDotenv((await made[0]?.text()) ?? "");
    expect(parsed.entries).toEqual([
      { key: "REGION", value: "eu" },
      { key: "STAGING_ONLY", value: "staging-secret-3b9" },
    ]);
    expect(await s.audit("variable.export")).toHaveLength(1);
    // the secret of the other environment is nowhere in it, and nothing is on the page
    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.body.textContent).not.toContain("staging-secret-3b9");
  });

  test("View changes opens the feed of that environment", async () => {
    const s = await withValues();
    mount(s.client);
    const user = await menuOf("staging");
    await user.click(screen.getByRole("menuitem", { name: "View changes" }));
    const drawer = await screen.findByRole("dialog", { name: "Changes in staging" });
    // the feed is of staging alone: its key is in it and dev's is not
    expect(await within(drawer).findByText(/STAGING_ONLY/)).toBeTruthy();
    expect(within(drawer).queryByText(/API_KEY/)).toBeNull();
    expect(document.body.textContent).not.toContain("staging-secret-3b9");
  });

  test("without the right to reveal nothing is downloaded and the page says so", async () => {
    const s = await withValues({ reporter: true });
    mount(s.client);
    const user = await menuOf("dev");
    await user.click(screen.getByRole("menuitem", { name: "Download .env" }));
    expect((await screen.findByRole("alert")).textContent).toBe("You cannot download values here");
    expect(made).toEqual([]);
    expect(clicked).toEqual([]);
    expect(await s.audit("variable.export")).toHaveLength(0);
    expect(document.body.textContent).not.toContain(SECRET);
  });
});
