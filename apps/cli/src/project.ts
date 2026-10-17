import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { CliError, fieldsOf } from "./cli";

/**
 * `.orch.json`, committed with the code: which organization, project and environment a directory is
 * about. It holds no secret, and it cannot name the API: a cloned repository must not be able to send
 * the user's token to another server.
 */
const projectFileSchema = z.strictObject({
  organization: z.string().min(1).max(200).optional(),
  project: z.string().min(1).max(200).optional(),
  environment: z.string().min(1).max(200).optional(),
});
export type ProjectFile = z.infer<typeof projectFileSchema>;

export const PROJECT_FILE = ".orch.json";

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const isFile = (path: string) =>
  stat(path).then(
    (s) => s.isFile(),
    () => false,
  );

/**
 * The nearest `.orch.json` from `start` upwards, or null. Inside a git repository the search ends at
 * its root (the directory holding `.git`), so a file above the repository is not picked up; outside one
 * it climbs to the filesystem root.
 */
export async function findProjectFile(
  start: string,
): Promise<{ path: string; config: ProjectFile } | null> {
  for (let dir = start; ; dir = dirname(dir)) {
    const path = join(dir, PROJECT_FILE);
    if (await isFile(path)) {
      let raw: unknown;
      try {
        raw = JSON.parse(await Bun.file(path).text());
      } catch {
        throw new CliError(`${path} is not valid JSON`);
      }
      const parsed = projectFileSchema.safeParse(raw);
      if (!parsed.success) {
        throw new CliError(`${path} is not valid: ${fieldsOf(parsed.error)}`);
      }
      return { path, config: parsed.data };
    }
    if ((await exists(join(dir, ".git"))) || dirname(dir) === dir) return null;
  }
}
