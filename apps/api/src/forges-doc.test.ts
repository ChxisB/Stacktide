import { expect, test } from "bun:test";

const root = `${import.meta.dir}/../../..`;
const read = (path: string) => Bun.file(`${root}/${path}`).text();
const exists = (path: string) => Bun.file(`${root}/${path}`).exists();

test("every test file and document docs/forges.md names exists, and the README and self-host link it", async () => {
  const doc = await read("docs/forges.md");
  const tests = [...doc.matchAll(/`((?:apps|packages)\/[\w./-]+\.test\.tsx?)`/g)].map(
    (m) => m[1] ?? "",
  );
  expect(tests.length).toBeGreaterThan(5);
  for (const path of tests) expect(await exists(path), path).toBe(true);
  const links = [...doc.matchAll(/\]\(((?!https?:)[\w./-]+\.md)[#)]/g)].map((m) => m[1] ?? "");
  expect(links.length).toBeGreaterThan(5);
  for (const link of links) expect(await exists(`docs/${link}`), link).toBe(true);
  expect(await read("README.md")).toContain("docs/forges.md");
  expect(await read("docs/self-host.md")).toContain("forges.md");
});
