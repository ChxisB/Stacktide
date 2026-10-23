import { expect, test } from "bun:test";

const root = `${import.meta.dir}/../../..`;
const read = (path: string) => Bun.file(`${root}/${path}`).text();

test("every `bun run` command in the demo doc is a script of the root package.json, and the README links the doc", async () => {
  const doc = await read("docs/demo.md");
  const scripts = Object.keys(JSON.parse(await read("package.json")).scripts);
  const used = [...doc.matchAll(/bun run ([\w:-]+)/g)].map((m) => m[1] ?? "");
  expect(used).toContain("demo");
  expect(used).toContain("demo:shots");
  for (const name of used) expect(scripts).toContain(name);
  expect(await read("README.md")).toContain("docs/demo.md");
});
