import { GitlabError } from "@orch/gitlab";

/** The refusal of something the GitHub adapter does not do yet; it names the thing so a message can say what is missing. */
export const unbuiltError = (what: string) =>
  new GitlabError("invalid", `${what} is not available for GitHub yet`);

/**
 * A group of operations nothing has built yet: every operation throws `unbuiltError`. The throw is synchronous on
 * purpose, so a `for await` over a list and an `await` of a call fail the same way.
 */
export function unbuilt<T extends object>(group: string): T {
  return new Proxy({} as T, {
    get(_, op) {
      // not a thenable, not a JSON value: only a named operation throws when called
      if (typeof op !== "string" || op === "then" || op === "toJSON") return undefined;
      return () => {
        throw unbuiltError(`${group}.${op}`);
      };
    },
  });
}
