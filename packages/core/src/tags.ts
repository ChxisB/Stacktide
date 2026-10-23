// No imports: the web app loads this file on its own (`@orch/core/tags`), so it stays out of the
// rest of core's graph.

export const MAX_TAGS = 8;
export const MAX_TAG = 24;
/** A tag: lower-case letters, digits and hyphens. The database check holds the same limits. */
export const TAG_PATTERN = new RegExp(`^[a-z0-9-]{1,${MAX_TAG}}$`);

/** One of each, in a fixed order: what is stored and what is compared. */
export const normalizeTags = (tags: readonly string[]): string[] => [...new Set(tags)].sort();

/** What a person typed in a "Tags" box: split on commas and spaces, lower-cased, not checked against the pattern. */
export const parseTags = (text: string): string[] =>
  normalizeTags(
    text
      .toLowerCase()
      .split(/[\s,]+/)
      .filter(Boolean),
  );
