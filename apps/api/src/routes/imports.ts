import { DomainError, detectProjectTypes, type Logger } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import { importProject, linkedProjects, pgConstraint } from "@orch/db";
import type { Forge } from "@orch/forge";
import { GitlabError, type GitlabErrorKind, type Project } from "@orch/gitlab";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { forgeFor, GITHUB_WHY, openAnyConnection, WHY } from "../connections";
import { guardPlugin } from "../guard";
import { projectDto, projectSchema } from "./projects";
import {
  defaultBranch,
  gitlabId,
  name,
  paged,
  problemSchema,
  type RouteDeps,
  readErrors,
  writeErrors,
} from "./shared";

/** At most this many projects per import: each costs GitLab calls while the caller waits. */
const MAX_IMPORT = 25;
/** Projects read from GitLab at once. */
const READ_BATCH = 5;
/**
 * The most tree entries read per scan (the top level, then everything below it). shortcut: past
 * that a monorepo is judged by its first entries (GitLab lists in path order), so a marker deep
 * in it can be missed, which the import reports as `truncated`; look for the markers by name
 * when that matters.
 */
const MAX_TREE_ENTRIES = 5000;

const discovered = z.object({
  gitlabProjectId: z.number().int(),
  /** Full path, `group/sub/repo`: what the project is named here when imported. */
  path: z.string(),
  defaultBranch: z.string().nullable(),
  archived: z.boolean(),
  /** The project of this organization it was imported as, if it was. */
  projectId: z.uuid().nullable(),
});

type Found = z.infer<typeof discovered>;

const outcome = z.discriminatedUnion("outcome", [
  z.object({
    gitlabProjectId: z.number().int(),
    outcome: z.enum(["created", "updated"]),
    project: projectSchema,
    /** The repository was too big to scan whole: its types may be incomplete. */
    truncated: z.boolean(),
  }),
  z.object({
    gitlabProjectId: z.number().int(),
    outcome: z.literal("failed"),
    reason: z.enum(["not_found", "forbidden", "unsupported", "name_taken"]),
    message: z.string(),
  }),
]);

const params = z.object({ orgId: z.uuid(), connectionId: z.uuid() });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(300).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  archived: z.enum(["true", "false"]).optional(),
});
const importBody = z.strictObject({
  gitlabProjectIds: z.array(gitlabId).min(1).max(MAX_IMPORT),
});
const gitlabDown = { ...readErrors, 502: problemSchema } as const;

type Failed = "not_found" | "forbidden" | "unsupported" | "name_taken";

const SYSTEM = { gitlab: "GitLab", github: "GitHub" } as const;
const failedText = (forge: Forge, reason: Failed) =>
  ({
    not_found: `${SYSTEM[forge.kind]} has no such project, or the token cannot see it.`,
    forbidden: `${SYSTEM[forge.kind]} refused the token for this project.`,
    unsupported: "The project's path or default branch is not one this platform accepts.",
    name_taken: "Another project of this organization already has this name.",
  })[reason];

/** What the forge said that is about one project, not about the connection. */
const aboutProject = (kind: GitlabErrorKind): Failed | undefined =>
  kind === "not_found" ? "not_found" : kind === "forbidden" ? "forbidden" : undefined;

const unreachable = (e: unknown, forge: Forge) =>
  e instanceof GitlabError && !aboutProject(e.kind)
    ? new DomainError("gitlab_failed", 502, (forge.kind === "github" ? GITHUB_WHY : WHY)[e.kind])
    : e;

type Detected = Awaited<ReturnType<typeof detect>>;
type Read = { project: Project; scan: Detected } | { failed: Failed };

/**
 * Type tags from the file paths of the default branch (no file is opened); none for an empty
 * repository. The top level is read first, so the markers that matter most are found however big
 * the rest is; `truncated` says a scan hit the entry cap and the tags may be incomplete.
 */
async function detect(api: Pick<Forge, "repository">, project: Project) {
  const ref = project.defaultBranch;
  const paths = new Set<string>();
  let truncated = false;
  if (!ref) return { types: [], truncated };
  try {
    for (const recursive of [false, true]) {
      let seen = 0;
      for await (const e of api.repository.tree(project.id, { ref, recursive })) {
        if (++seen > MAX_TREE_ENTRIES) {
          truncated = true;
          break;
        }
        if (e.type === "blob") paths.add(e.path);
      }
      if (truncated && !recursive) break; // a top level that big has nothing more to tell
    }
  } catch (e) {
    // A branch GitLab lists but has no tree for is an empty repository (not_found), not a failure.
    if (!(e instanceof GitlabError && e.kind === "not_found")) throw e;
  }
  return { types: detectProjectTypes([...paths]), truncated };
}

/**
 * Discovery and import of projects through a connection (GL-7), a GitLab or a GitHub one (FRG-15; the routes and the
 * body keep their GitLab names, and a GitHub repository's id is the number). The connection's token is
 * opened for the call and never leaves it; only paths, ids and tags come back. Re-importing a
 * project refreshes it. Org admins only.
 */
export const importRoutes = ({
  db,
  principal,
  keys,
  logger,
}: RouteDeps & { keys?: KeyProvider; logger: Logger }) =>
  new Elysia({ prefix: "/organizations/:orgId/connections/:connectionId" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "/gitlab-projects",
      async ({ params: { orgId, connectionId }, query, set }) => {
        const opened = await openAnyConnection(
          { db, keys, logger },
          orgId,
          connectionId,
          set.headers["x-request-id"],
        );
        const api = forgeFor(opened.connection, opened.token);
        return paged(query, {
          key: z.tuple([gitlabId]),
          keyOf: (p: Found) => [p.gitlabProjectId],
          fetch: async (after, limit): Promise<Found[]> => {
            const found: Project[] = [];
            try {
              const list = api.projects.list({
                idAfter: after?.[0],
                search: query.search,
                archived: query.archived === undefined ? undefined : query.archived === "true",
              });
              for await (const p of list) {
                found.push(p);
                if (found.length >= limit) break;
              }
            } catch (e) {
              throw unreachable(e, api);
            }
            const linked = new Map(
              (
                await linkedProjects(
                  db,
                  orgId,
                  found.map((p) => p.id),
                  connectionId,
                )
              ).map((l) => [l.gitlabProjectId, l.id]),
            );
            return found.map((p) => ({
              gitlabProjectId: p.id,
              path: p.path,
              defaultBranch: p.defaultBranch,
              archived: p.archived,
              projectId: linked.get(p.id) ?? null,
            }));
          },
          dto: (row) => row,
        });
      },
      {
        params,
        query: listQuery,
        response: {
          200: z.object({ items: z.array(discovered), nextCursor: z.string().nullable() }),
          ...gitlabDown,
          503: problemSchema,
        },
        guard: "project.import",
      },
    )
    .post(
      "/imports",
      async ({ params: { orgId, connectionId }, body, audit, set }) => {
        const { connection, token } = await openAnyConnection(
          { db, keys, logger },
          orgId,
          connectionId,
          set.headers["x-request-id"],
        );
        const api = forgeFor(connection, token, {
          timeoutMs: 15_000,
          maxRetries: 1,
          maxRetryDelayMs: 2_000,
        });
        // Everything GitLab has to say first, so no transaction is held open while we wait on it.
        const ids = [...new Set(body.gitlabProjectIds)];
        const read = new Map<number, Read>();
        const readOne = async (id: number) => {
          try {
            const project = await api.projects.get(id);
            const fine =
              name.safeParse(project.path).success &&
              (project.defaultBranch === null ||
                defaultBranch.safeParse(project.defaultBranch).success);
            read.set(
              id,
              fine ? { project, scan: await detect(api, project) } : { failed: "unsupported" },
            );
          } catch (e) {
            const failed = e instanceof GitlabError ? aboutProject(e.kind) : undefined;
            if (!failed) throw unreachable(e, api);
            read.set(id, { failed });
          }
        };
        for (let i = 0; i < ids.length; i += READ_BATCH) {
          await Promise.all(ids.slice(i, i + READ_BATCH).map(readOne));
        }

        const results = await db.transaction(async (tx) => {
          const out: z.infer<typeof outcome>[] = [];
          const touched = {
            created: [] as string[],
            updated: [] as string[],
            failed: [] as number[],
          };
          const fail = (id: number, reason: Failed) => {
            touched.failed.push(id);
            out.push({
              gitlabProjectId: id,
              outcome: "failed",
              reason,
              message: failedText(api, reason),
            });
          };
          for (const id of ids) {
            const r = read.get(id);
            if (!r || "failed" in r) {
              fail(id, r?.failed ?? "not_found");
              continue;
            }
            // A savepoint per project: a name collision spoils that project, not the others.
            const done = await tx
              .transaction((sp) =>
                importProject(sp, {
                  organizationId: orgId,
                  connectionId,
                  gitlabProjectId: id,
                  name: r.project.path,
                  defaultBranch: r.project.defaultBranch,
                  types: r.scan.types,
                }),
              )
              .catch((e) => {
                if (pgConstraint(e) === "projects_org_name_key") return undefined;
                throw e;
              });
            if (!done) {
              fail(id, "name_taken");
              continue;
            }
            const kind = done.created ? "created" : "updated";
            touched[kind].push(done.project.id);
            out.push({
              gitlabProjectId: id,
              outcome: kind,
              project: projectDto(done.project, api.kind),
              truncated: r.scan.truncated,
            });
          }
          // One row for the whole import: the projects it touched are listed by id.
          await audit(tx, {
            action: "project.import",
            resourceType: "connection",
            resourceId: connection.id,
            organizationId: orgId,
            metadata: { requested: ids.length, ...touched },
          });
          return out;
        });
        return { results };
      },
      {
        params,
        body: importBody,
        parse: "json",
        response: {
          200: z.object({ results: z.array(outcome) }),
          ...writeErrors,
          502: problemSchema,
          503: problemSchema,
        },
        audit: "project.import",
        guard: "project.import",
      },
    );
