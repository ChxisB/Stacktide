import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { parseDotenv } from "@orch/core";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, clientVia, mount, pathOf, startBackend } from "./testing";
import { openSecrets, SECRET, scene as sceneOn, showSecrets } from "./variables.fixture";

// VWS-8: Download .env reads the environment's values from the audited export route, builds the
// file in memory, hands it to the browser and keeps nothing.

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());

/** The browser's side of a download: the blobs made, what was revoked, and the files that were clicked. */
const made: { blob: Blob; url: string }[] = [];
const revoked: string[] = [];
const clicked: { href: string; name: string }[] = [];
const real = {
  create: URL.createObjectURL,
  revoke: URL.revokeObjectURL,
  click: HTMLAnchorElement.prototype.click,
};
beforeEach(() => {
  window.location.hash = "#/variables";
  made.length = revoked.length = clicked.length = 0;
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    const url = `blob:test/${made.length}`;
    made.push({ blob: blob as Blob, url });
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
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
const FILE = "-----BEGIN-----\nfile-body-5e8a\n-----END-----";
const download = () => screen.getByRole("button", { name: "Download .env" });

async function withValues() {
  const s = await scene();
  await s.put.project("REGION", "eu");
  await s.put.project("API_KEY", SECRET, true);
  await s.put.env("dev", "GREETING", "hello world");
  await s.scope.variables.post({ key: "CERT", kind: "file", value: FILE });
  await s.put.env("staging", "STAGING_ONLY", "staging-secret-3b9", true);
  return s;
}

describe("Download .env", () => {
  test("one file of the environment's values, named for the project and environment, and nothing kept", async () => {
    const s = await withValues();
    const shown = mount(s.client);
    await openSecrets();
    expect(document.body.textContent).toContain("secrets included");
    await userEvent.setup().click(download());
    await screen.findByText(/Downloaded acme-web-dev\.env/);
    expect(clicked).toEqual([{ href: "blob:test/0", name: "acme-web-dev.env" }]);
    const text = await made[0]?.blob.text();
    const parsed = parseDotenv(text ?? "");
    expect(parsed.issues).toEqual([]);
    // sorted by key; plain, secret and file alike; another environment's secret is not in it
    expect(parsed.entries).toEqual([
      { key: "API_KEY", value: SECRET },
      { key: "CERT", value: FILE },
      { key: "GREETING", value: "hello world" },
      { key: "REGION", value: "eu" },
    ]);
    expect(text?.endsWith("\n")).toBe(true);
    expect(text).not.toContain("staging-secret-3b9");
    // the browser was handed the blob and the address was dropped; the page and the cache hold no value
    expect(revoked).toEqual(["blob:test/0"]);
    const page = document.body.textContent ?? "";
    for (const value of [SECRET, "file-body-5e8a", "staging-secret-3b9"])
      expect(page).not.toContain(value);
    expect(
      JSON.stringify(
        shown.queries
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(SECRET);
    expect(clicked[0]?.name).not.toContain(SECRET);
  });

  test("the page says what the file holds, without a value", async () => {
    const s = await withValues();
    mount(s.client);
    await openSecrets();
    await userEvent.setup().click(download());
    const note = await screen.findByText(/Downloaded acme-web-dev\.env/);
    expect(note.textContent).toBe(
      "Downloaded acme-web-dev.env: 4 variables, including 2 secret or file values.",
    );
  });

  test("the only request it makes is the values route, which writes its audit rows", async () => {
    const s = await withValues();
    const paths: string[] = [];
    const client = clientVia(backend.api, s.cookie, (request, send) => {
      paths.push(`${request.method} ${pathOf(request)}`);
      return send();
    });
    mount(client);
    await openSecrets();
    const before = paths.length;
    await userEvent.setup().click(download());
    await screen.findByText(/Downloaded/);
    expect(paths.slice(before)).toEqual([
      `GET /organizations/${s.org.id}/projects/${s.project.id}/environments/${s.envs.dev}/resolved-variables/values`,
    ]);
    expect(await s.audit("variable.reveal")).toHaveLength(2);
    expect(await s.audit("variable.export")).toHaveLength(1);
  });

  test("a key that does not resolve is left out, and the page says so", async () => {
    const s = await withValues();
    await s.put.project("BROKEN", `\${NOWHERE}`);
    mount(s.client);
    await openSecrets();
    await userEvent.setup().click(download());
    const note = await screen.findByText(/Downloaded/);
    expect(note.textContent).toBe(
      "Downloaded acme-web-dev.env: 4 variables, including 2 secret or file values; 1 did not resolve and is not in it.",
    );
    expect(await made[0]?.blob.text()).not.toContain("BROKEN");
  });

  test("a value a .env file cannot carry is refused, naming the key, and nothing is downloaded", async () => {
    const s = await scene();
    await s.put.project("BAD", "a\0b", true);
    mount(s.client);
    await openSecrets();
    await userEvent.setup().click(download());
    expect((await screen.findByRole("alert")).textContent).toBe(
      "BAD holds a NUL character, which a .env file cannot carry",
    );
    expect(made).toEqual([]);
    expect(clicked).toEqual([]);
  });

  test("without the right to reveal nothing is downloaded and the page says so", async () => {
    const s = await scene({ reporter: true });
    await s.put.project("API_KEY", SECRET, true);
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    await user.click(download());
    expect((await screen.findByRole("alert")).textContent).toBe("You cannot download values here");
    expect(made).toEqual([]);
    expect(clicked).toEqual([]);
    expect(document.body.textContent).not.toContain(SECRET);
    expect((download() as HTMLButtonElement).disabled).toBe(false);
    expect(await s.audit("variable.export")).toHaveLength(0);
  });

  test("an answer that arrives after another environment was chosen downloads nothing", async () => {
    const s = await withValues();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = clientVia(backend.api, s.cookie, async (request, send) => {
      const answer = await send();
      if (pathOf(request).endsWith("/values")) await gate;
      return answer;
    });
    mount(client);
    await openSecrets();
    const user = userEvent.setup();
    await user.click(download());
    await showSecrets("staging");
    await screen.findByRole("table", { name: "Variables in staging" });
    release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(made).toEqual([]);
    expect(clicked).toEqual([]);
  });
});
