import { mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { CliError, fieldsOf } from "./cli";

/** What `orch` keeps for the user between runs. The token is a secret: the file is mode 0600. */
const configSchema = z.strictObject({
  apiUrl: z.url().optional(),
  token: z.string().min(1).optional(),
});
export type Config = z.infer<typeof configSchema>;

/** `$ORCH_CONFIG`, else `$XDG_CONFIG_HOME/orch/config.json`, else `~/.config/orch/config.json`. */
export function configPath(env: Record<string, string | undefined>, home = homedir()) {
  if (env.ORCH_CONFIG) return env.ORCH_CONFIG;
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "orch", "config.json");
}

/**
 * Reads the config file; a missing file is an empty config. A file that other users can read or write,
 * or that another user owns, is refused, as ssh does for a private key: the token in it would be theirs
 * too. The checks and the read use one open file, so the file cannot be swapped between them.
 * `uid` is the user the file must belong to (`process.getuid()`; none on Windows).
 * shortcut: the mode and owner checks are POSIX only (the binaries are for darwin and linux), upgrade with Windows support.
 */
export async function loadConfig(path: string, uid = process.getuid?.()): Promise<Config> {
  let text: string;
  try {
    const file = await open(path, "r");
    try {
      const { mode, uid: owner } = await file.stat();
      if ((mode & 0o077) !== 0) {
        throw new CliError(
          `${path} can be read by other users (mode ${(mode & 0o777).toString(8)}); run: chmod 600 ${path}`,
        );
      }
      if (uid !== undefined && owner !== uid) throw new CliError(`${path} belongs to another user`);
      text = await file.readFile("utf8");
    } finally {
      await file.close();
    }
  } catch (e) {
    if (e instanceof CliError) throw e;
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new CliError(`cannot read ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CliError(`${path} is not valid JSON`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new CliError(`${path} is not valid: ${fieldsOf(parsed.error)}`);
  return parsed.data;
}

/**
 * Writes the config with mode 0600 in a 0700 directory, through a temporary file so a crash never leaves
 * half of one. The temporary file is made new (anything of that name is removed first, a link included),
 * so the token is never written into a file somebody else made, and it is removed if the write fails.
 */
export async function saveConfig(path: string, config: Config): Promise<void> {
  const data = `${JSON.stringify(configSchema.parse(config), null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await rm(tmp, { force: true });
  try {
    const file = await open(tmp, "wx", 0o600);
    try {
      await file.writeFile(data);
    } finally {
      await file.close();
    }
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
