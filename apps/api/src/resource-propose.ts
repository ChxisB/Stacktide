import {
  APP_NAME,
  type Blueprint,
  type BlueprintInput,
  BlueprintSchema,
  DomainError,
} from "@orch/core";
import type { Forge } from "@orch/forge";
import type { ProjectRef } from "@orch/gitlab";
import { blueprintCatalog, renderBlueprint, STACK_WORKFLOW_FILE } from "@orch/iac";
import { gitlabProblem, notFound } from "./pipeline-apply";

/** Where in the project's own repository the files go (SPEC open question 6, the recommended answer). */
export const RESOURCE_ROOT = "infra";
/** One branch for each resource, so a repeat finds the request it opened. */
export const resourceBranch = (stack: string) => `${APP_NAME}/resource-${stack}`;

const clip = (s: string) => s.slice(0, 200);

/** The refusal a person can act on: each key, and why. Messages name keys and never carry a submitted value. */
function invalid(errors: string[]) {
  const shown = errors.slice(0, 10).map(clip);
  const list = shown.map((e) => {
    const m = /^([\w.]+): ([\s\S]*)$/.exec(e);
    return { path: m?.[1] ?? "", message: m?.[2] ?? e };
  });
  return new DomainError(
    "invalid_resource",
    422,
    `The resource is not valid: ${shown.join("; ")}`,
    {
      errors: list,
    },
  );
}

/**
 * Whether the blueprint is one the platform will write: the closed schema, then what `uses` needs of the
 * project's other resources. Pure, so a request that cannot succeed is refused before the connection's token
 * is opened. The forge only changes the stack manifest's state key, not the verdict.
 */
export function checkResource(input: unknown, others: readonly Blueprint[]) {
  const r = renderBlueprint(input, "gitlab", RESOURCE_ROOT, others);
  if (!r.ok) throw invalid(r.errors);
  // the paths are the same on both forges; only the stack manifest's text differs
  return {
    blueprint: BlueprintSchema.parse(input),
    stack: r.stack,
    path: r.dir,
    files: r.files.map((f) => f.path),
  };
}

export interface ProposalInput {
  blueprint: BlueprintInput | unknown;
  /** The project's other resources, already parsed: what this one uses must be among them. */
  others: readonly Blueprint[];
  verb: "add" | "change";
}

export interface Proposed {
  /** `opened` a request, `updated` the open one, `unchanged` (nothing to do), `in_place` (the default branch already has these files). */
  outcome: "opened" | "updated" | "unchanged" | "in_place";
  /** A commit was made on the branch this time. */
  committed: boolean;
  mr: { iid: number; url: string } | null;
  /** Every file of the proposal, the vendored module included. */
  files: string[];
}

/** The request's text. The same inputs give the same text, so a re-run changes nothing. */
function describe(
  b: Blueprint,
  dir: string,
  moduleDir: string,
  differing: string[],
  noWorkflow: boolean,
  verb: ProposalInput["verb"],
) {
  const idle = blueprintCatalog()
    .kinds.find((k) => k.kind === b.kind)
    ?.clouds.find((c) => c.cloud === b.cloud)?.idleCost;
  const lines = [
    `Proposed by ${APP_NAME}: a \`${b.kind}\` named \`${b.name}\` in \`${b.environment}\` on \`${b.cloud}\` (profile \`${b.profile}\`).`,
    "",
    `Merging ${verb === "add" ? "adds" : "changes"} the stack in \`${dir}\`. The project's own pipeline plans it and applies it; ${APP_NAME} makes no call to the cloud, and nothing exists there until it is applied.`,
    "",
    `Idle cost: ${idle ?? "not stated"}`,
    "",
    b.uses.length > 0 ? `Uses ${b.uses.map((u) => `\`${u}\``).join(", ")}.` : "Uses nothing.",
    "",
    `The shipped module is vendored in \`${moduleDir}\`. A copy already there is never rewritten, so a module change is a deliberate commit.`,
  ];
  for (const path of differing) {
    lines.push(
      "",
      `**\`${path}\` differs from the shipped module.** It was left as it is; read it before merging.`,
    );
  }
  if (noWorkflow) {
    lines.push(
      "",
      `**\`${STACK_WORKFLOW_FILE}\` is not in this repository**, so GitHub will not plan or apply this stack. Set up the project's pipeline again from ${APP_NAME} to add it.`,
    );
  }
  return lines.join("\n");
}

/**
 * Lands a resource as a request in the project's repository (BLP-16): the stack's files and the vendored module
 * are committed to the branch `orch/resource-<stack>` (made from the default branch when it is not there) and one
 * merge or pull request from it is opened, or edited when one is open. Nothing is committed to the default branch,
 * a vendored module that is already in the repository is left as it is, and the same inputs again make no commit and
 * change nothing. The caller has run `checkResource`; this renders again for the forge it was given.
 */
export async function proposeResource(
  api: Forge,
  ref: ProjectRef,
  { blueprint, others, verb }: ProposalInput,
): Promise<Proposed> {
  const rendered = renderBlueprint(blueprint, api.kind, RESOURCE_ROOT, others);
  if (!rendered.ok) throw invalid(rendered.errors);
  const b = BlueprintSchema.parse(blueprint);
  const branch = resourceBranch(rendered.stack);
  const files = rendered.files.map((f) => f.path);
  const vendored = (path: string) => path.startsWith(`${rendered.moduleDir}/`);
  try {
    const base = (await api.projects.get(ref)).defaultBranch;
    if (!base) {
      throw new DomainError("no_default_branch", 422, "The repository has no default branch yet");
    }
    const onDefault = new Map<string, string | null>();
    for (const f of rendered.files) {
      onDefault.set(
        f.path,
        (await notFound(api.repository.getFile(ref, f.path, base)))?.content ?? null,
      );
    }
    // a vendored file of any text counts as in place: it is never rewritten
    const settled = rendered.files.every((f) => {
      const there = onDefault.get(f.path) ?? null;
      return there === f.content || (vendored(f.path) && there !== null);
    });
    if (settled) return { outcome: "in_place", committed: false, mr: null, files };

    const onBranch = await notFound(api.repository.getBranch(ref, branch));
    const changes: { action: "create" | "update"; path: string; content: string }[] = [];
    const differing: string[] = [];
    for (const f of rendered.files) {
      // what the file holds where the commit will land: the branch if it is there, else the default branch it starts from
      const now = onBranch
        ? ((await notFound(api.repository.getFile(ref, f.path, branch)))?.content ?? null)
        : (onDefault.get(f.path) ?? null);
      if (vendored(f.path) && now !== null) {
        if (now !== f.content) differing.push(f.path);
      } else if (now !== f.content) {
        changes.push({
          action: now === null ? "create" : "update",
          path: f.path,
          content: f.content,
        });
      }
    }
    const noWorkflow =
      api.kind === "github" &&
      (await notFound(api.repository.getFile(ref, STACK_WORKFLOW_FILE, base))) === null;

    const title = `${verb === "add" ? "Add" : "Change"} ${b.kind} ${b.name} ${verb === "add" ? "to" : "in"} ${b.environment} on ${b.cloud}`;
    const committed = changes.length > 0;
    if (committed) {
      await api.repository.commitFiles(
        ref,
        { branch, message: title, ...(onBranch ? {} : { startBranch: base }) },
        changes,
      );
    }
    const description = describe(b, rendered.dir, rendered.moduleDir, differing, noWorkflow, verb);
    let open: Awaited<ReturnType<Forge["mergeRequests"]["get"]>> | undefined;
    for await (const mr of api.mergeRequests.list(ref, {
      sourceBranch: branch,
      targetBranch: base,
      state: "opened",
    })) {
      open = mr;
      break;
    }
    if (!open) {
      const mr = await api.mergeRequests.create(ref, {
        sourceBranch: branch,
        targetBranch: base,
        title,
        description,
        removeSourceBranch: true,
      });
      return { outcome: "opened", committed, mr: { iid: mr.iid, url: mr.webUrl }, files };
    }
    // the forge may store the text with other line endings or trimmed: only a real difference is an edit
    const same = (a: string, c: string) => a.replaceAll("\r\n", "\n").trim() === c.trim();
    const edited = open.title !== title || !same(open.description, description);
    const mr = edited
      ? await api.mergeRequests.update(ref, open.iid, { title, description })
      : open;
    return {
      outcome: committed || edited ? "updated" : "unchanged",
      committed,
      mr: { iid: mr.iid, url: mr.webUrl },
      files,
    };
  } catch (e) {
    throw gitlabProblem(e, api.kind);
  }
}
