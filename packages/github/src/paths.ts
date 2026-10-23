import { GitlabError } from "@orch/gitlab";

const NAME = /^[A-Za-z0-9_.-]+$/;
const ok = (part: string) => NAME.test(part) && part !== "." && part !== "..";

/**
 * `owner/name` checked part by part: the ref goes into a URL, and `..` would walk out of `/repos/`.
 * Nothing is sent for a ref that fails.
 */
export function fullName(ref: string): string {
  const parts = ref.split("/");
  const [owner, name] = parts;
  if (parts.length !== 2 || !owner || !name || !ok(owner) || !ok(name)) {
    throw new GitlabError("invalid", "A GitHub repository is named owner/name");
  }
  return `${owner}/${name}`;
}

export function repositoryId(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) throw new GitlabError("invalid", "Not a repository id");
  return `/repositories/${id}`;
}

/** A branch, tag or file path for the middle of a URL: each part encoded, none of them empty, `.` or `..`. */
export function segments(path: string): string {
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new GitlabError(
      "invalid",
      `Not a name or path GitHub can be asked about: ${path.slice(0, 100)}`,
    );
  }
  return parts.map(encodeURIComponent).join("/");
}

/** One name for the middle of a URL (a login, an organization): `segments` without the slash. */
export function segment(name: string): string {
  if (name.includes("/")) {
    throw new GitlabError("invalid", `Not a name GitHub can be asked about: ${name.slice(0, 100)}`);
  }
  return segments(name);
}

/** A branch name without the `refs/heads/` some callers keep. */
export const branchName = (name: string) => name.replace(/^refs\/heads\//, "");

/** A pull request number or comment id for the middle of a URL. */
export function whole(n: number): number {
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new GitlabError("invalid", "Not a number GitHub can be asked about");
  return n;
}

/** The first line of a commit message: the title. */
export const firstLine = (message: string) => message.split("\n", 1)[0] ?? "";
