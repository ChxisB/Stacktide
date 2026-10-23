// No imports: the web app loads this file on its own (`@orch/core/folders`), so it stays out of the
// rest of core's graph.

/** A project's variables sit in folders; the root holds the ones that name none. */
export const ROOT = "/";
/** How many folders a path may go down. The database check holds the same limit. */
export const MAX_DEPTH = 5;
/** One folder name: lower-case letters, digits, hyphens and underscores. The database check holds the same. */
export const FOLDER_PATTERN = /^[a-z0-9_-]{1,32}$/;

/** `/` or `/a/b`: names from the root down, each a valid name, at most `MAX_DEPTH` of them. */
export function isFolderPath(path: string): boolean {
  if (path === ROOT) return true;
  if (!path.startsWith("/")) return false;
  const names = path.slice(1).split("/");
  return names.length <= MAX_DEPTH && names.every((n) => FOLDER_PATTERN.test(n));
}

/**
 * Where a variable lives: `/KEY` at the root, `/db/URL` in `/db`. No folder is the root. A folder
 * that cannot exist throws: the database refuses it too, so one here is a bug in the caller.
 */
export function address(folder: string | undefined, key: string): string {
  const at = folder ?? ROOT;
  if (!isFolderPath(at)) throw new Error(`not a folder path: ${JSON.stringify(at)}`);
  return at === ROOT ? `/${key}` : `${at}/${key}`;
}

/** The folder and the key of an address made by `address`. */
export function splitAddress(addr: string): { folder: string; key: string } {
  const cut = addr.lastIndexOf("/");
  return { folder: cut === 0 ? ROOT : addr.slice(0, cut), key: addr.slice(cut + 1) };
}
