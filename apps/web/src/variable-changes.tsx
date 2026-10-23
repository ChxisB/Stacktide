import { ROOT } from "@orch/core/folders";
import { useInfiniteQuery } from "@tanstack/react-query";
import { call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { Loading, stamp, when } from "./ui";
import { LEVEL_NAME } from "./variable-parts";

const PAGE = 20;

/**
 * Who changed which variable reaching the environment, and when, newest first: the project's changes
 * feed, which carries names, versions and people and never a value. It fills a drawer that is titled for the
 * environment. `opens` says whether a key of a folder has a row in the list to open (a key that does not
 * resolve has none, and neither has one of a folder other than the open one). A change of a folder says which,
 * next to its key; the root's says nothing.
 */
export function Changes({
  orgId,
  projectId,
  envId,
  opens,
  open,
}: {
  orgId: string;
  projectId: string;
  envId: string;
  opens: (key: string, folder: string) => boolean;
  open: (key: string) => void;
}) {
  const client = useClient();
  const feed = useInfiniteQuery({
    // under ["variables", orgId], so a write's reload reads it again
    queryKey: ["variables", orgId, "changes", projectId, envId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call(() =>
        client
          .organizations({ orgId })
          .projects({ projectId })
          ["variable-changes"].get({
            query: {
              limit: PAGE,
              environmentId: envId,
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = feed.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <p className="muted">Who changed which variable, and when. Values are not shown here.</p>
      {feed.error ? (
        <ErrorPanel error={feed.error} retry={() => void feed.refetch()} />
      ) : !feed.data ? (
        <Loading what="Loading changes" />
      ) : rows.length === 0 ? (
        <p>No changes yet.</p>
      ) : (
        <ul className="changes">
          {rows.map((c) => (
            <li key={c.id}>
              <span>
                {c.actorKind} {c.actorId.slice(0, 8)} changed{" "}
                {opens(c.key, c.folder) ? (
                  <button type="button" className="quiet" onClick={() => open(c.key)}>
                    <code>{c.key}</code>
                  </button>
                ) : (
                  <code>{c.key}</code>
                )}{" "}
                {c.folder !== ROOT && (
                  <>
                    in <code>{c.folder}</code>{" "}
                  </>
                )}
                to version {c.version}
              </span>{" "}
              <time dateTime={stamp(c.createdAt)}>{when(c.createdAt)}</time>{" "}
              <span className="tag">{LEVEL_NAME[c.level]}</span>
              {c.reason && <span className="muted"> “{c.reason}”</span>}
            </li>
          ))}
        </ul>
      )}
      {feed.hasNextPage && (
        <div className="row">
          <button
            type="button"
            disabled={feed.isFetchingNextPage}
            onClick={() => void feed.fetchNextPage()}
          >
            Load more
          </button>
        </div>
      )}
    </>
  );
}
