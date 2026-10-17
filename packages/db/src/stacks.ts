import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "./repo";
import { projects, stacks } from "./schema";

export type StackRow = typeof stacks.$inferSelect;
export type NewStack = Pick<
  StackRow,
  "name" | "path" | "tool" | "version" | "tags" | "dependsOn" | "watch" | "applyOn" | "backend"
>;

/** The project's stacks, by directory. */
export async function listStacks(db: Executor, organizationId: string, projectId: string) {
  return db
    .select()
    .from(stacks)
    .where(and(eq(stacks.projectId, projectId), eq(stacks.organizationId, organizationId)))
    .orderBy(asc(stacks.path), asc(stacks.name));
}

/**
 * Brings the project's stacks up to `input`: new ones are added and known ones (by name) are updated
 * and keep their id; one that is unchanged is not written. With `prune`, a stack not in `input` is
 * deleted, which is only right when `input` is every stack of the repository (a scan that left one
 * out because it failed to read is not that), so it is always the caller's explicit choice. The
 * project's row is locked meanwhile, so two scans of one project take turns. Returns the names
 * added and removed.
 */
export async function syncStacks(
  db: Executor,
  organizationId: string,
  projectId: string,
  input: NewStack[],
  options: { prune: boolean },
) {
  const names = new Set(input.map((s) => s.name));
  const paths = new Set(input.map((s) => s.path));
  if (names.size !== input.length || paths.size !== input.length) {
    throw new Error("two stacks share a name or a directory");
  }
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
      .for("update");
    if (!project) throw new Error("project not found in the organization");

    const before = await tx
      .select({ name: stacks.name })
      .from(stacks)
      .where(eq(stacks.projectId, projectId));
    const known = new Set(before.map((s) => s.name));
    const removed = options.prune ? [...known].filter((n) => !names.has(n)) : [];
    if (removed.length > 0) {
      await tx
        .delete(stacks)
        .where(and(eq(stacks.projectId, projectId), inArray(stacks.name, removed)));
    }
    if (input.length > 0) {
      // no constraint on `path` being unique: two stacks may swap directories in one scan
      const fields = [
        "path",
        "tool",
        "version",
        "tags",
        "dependsOn",
        "watch",
        "applyOn",
        "backend",
      ] as const;
      // the column names of `fields` are fixed here, so the raw SQL takes nothing from a caller
      const take = (c: (typeof fields)[number]) =>
        sql.raw(`excluded.${c.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)}`);
      await tx
        .insert(stacks)
        .values(input.map((s) => ({ organizationId, projectId, ...s })))
        .onConflictDoUpdate({
          target: [stacks.projectId, stacks.name],
          set: Object.fromEntries(fields.map((c) => [c, take(c)])),
          // an unchanged stack is not written, so `updated_at` still says when it last changed
          setWhere: sql`(${sql.join(
            fields.map((c) => stacks[c]),
            sql`, `,
          )}) is distinct from (${sql.join(fields.map(take), sql`, `)})`,
        });
    }
    return { added: input.filter((s) => !known.has(s.name)).map((s) => s.name), removed };
  });
}
