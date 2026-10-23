import { isFolderPath, ROOT } from "@orch/core";
import { SyncError } from "@orch/sync";

/**
 * A target's config holds, besides what its type defines, the `folder` of the project's variables it
 * syncs: the root when it has none. The type's parser is strict, so the folder is taken out before
 * the type sees the config. A folder that cannot be one is the config's fault (`invalid_config`).
 */
export function splitConfig(config: Record<string, unknown>): {
  folder: string;
  rest: Record<string, unknown>;
} {
  const { folder = ROOT, ...rest } = config;
  if (typeof folder !== "string" || !isFolderPath(folder)) {
    throw new SyncError("invalid_config", "the folder is / or the path of a folder, such as /pay");
  }
  return { folder, rest };
}
