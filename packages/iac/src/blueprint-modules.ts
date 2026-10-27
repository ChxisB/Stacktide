import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where the shipped Terraform lives: `<cloud>/<kind>/*.tf` (ADR-0024). */
export const BLUEPRINTS_DIR = join(import.meta.dir, "..", "blueprints");

/** Every `<cloud>/<kind>` directory that has been written so far. */
export const listModules = (): { cloud: string; kind: string; dir: string }[] =>
  readdirSync(BLUEPRINTS_DIR, { withFileTypes: true })
    .filter((c) => c.isDirectory())
    .flatMap((c) =>
      readdirSync(join(BLUEPRINTS_DIR, c.name), { withFileTypes: true })
        .filter((k) => k.isDirectory())
        .map((k) => ({ cloud: c.name, kind: k.name, dir: join(BLUEPRINTS_DIR, c.name, k.name) })),
    );

/** A module's files, as the renderer vendors them: the module is one flat directory. */
export const readModule = (cloud: string, kind: string): { name: string; content: string }[] => {
  const dir = join(BLUEPRINTS_DIR, cloud, kind);
  return readdirSync(dir)
    .sort()
    .map((name) => ({ name, content: readFileSync(join(dir, name), "utf8") }));
};
