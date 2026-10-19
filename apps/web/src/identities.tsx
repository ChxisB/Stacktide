import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { Loading, stamp, when } from "./ui";

/**
 * The person's own ways to sign in (SSO-7, ADR-0016). The GitLab one is the account's own and stays; an SSO one can be
 * given up while another way in is left, and the role it gave goes with it. Linking another sends the browser through
 * that organization's provider and back here.
 */
export function SignInMethods() {
  const client = useClient();
  const queries = useQueryClient();
  const [confirming, setConfirming] = useState<string>();
  const list = useQuery({
    queryKey: ["identities"],
    queryFn: () => call(() => client.auth.identities.get()),
  });
  const unlink = useMutation({
    mutationFn: (id: string) => call(() => client.auth.identities({ id }).delete()),
    // a role went with it: what the person may see in each organization is read again
    onSuccess: () => {
      setConfirming(undefined);
      return queries.invalidateQueries();
    },
  });
  const identities = list.data;
  return (
    <section className="stack" aria-labelledby="identities-title">
      <h2 id="identities-title">Sign-in methods</h2>
      <p className="muted">
        The ways you can sign in. Giving up a single sign-on one ends the role it gave you; GitLab
        is your account's own and stays.
      </p>
      {list.isPending && <Loading what="Loading sign-in methods" />}
      {list.error && identities === undefined && (
        <ErrorPanel error={list.error} retry={() => void list.refetch()} />
      )}
      {identities && (
        <table>
          <caption className="visually-hidden">Your sign-in methods</caption>
          <thead>
            <tr>
              <th scope="col">Method</th>
              <th scope="col">Email</th>
              <th scope="col">Added</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {identities.map((i) => (
              <tr key={i.id}>
                <td>
                  {i.kind === "gitlab" ? (
                    "GitLab"
                  ) : (
                    <>
                      Single sign-on: {i.organizationName}{" "}
                      <span className="muted">({i.organizationSlug})</span>
                    </>
                  )}
                </td>
                <td>{i.email ?? <span className="muted">None</span>}</td>
                <td>
                  <time dateTime={stamp(i.createdAt)}>{when(i.createdAt)}</time>
                </td>
                <td>
                  {i.kind === "sso" &&
                    identities.length > 1 &&
                    (confirming === i.id ? (
                      <div className="row">
                        <button
                          type="button"
                          className="danger"
                          disabled={unlink.isPending}
                          onClick={() => unlink.mutate(i.id)}
                        >
                          {unlink.isPending ? "Unlinking…" : "Unlink"}
                        </button>
                        <button
                          type="button"
                          disabled={unlink.isPending}
                          onClick={() => {
                            unlink.reset();
                            setConfirming(undefined);
                          }}
                        >
                          Keep
                        </button>
                      </div>
                    ) : (
                      <button type="button" onClick={() => setConfirming(i.id)}>
                        Unlink…
                      </button>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {unlink.error && (
        <p role="alert" className="error">
          {unlink.error.message}
        </p>
      )}
      <LinkAnother />
    </section>
  );
}

/**
 * Adds an organization's provider as another way in. The API starts it (a POST, so no other site can start one in this
 * browser) and says where to go; the person signs in there once and comes back to this page.
 */
function LinkAnother() {
  const client = useClient();
  const [slug, setSlug] = useState("");
  const start = useMutation({
    mutationFn: async () =>
      (
        await call(() =>
          client.auth.sso({ slug: slug.trim() }).link.post(undefined, {
            query: { return_to: "/#/settings" },
          }),
        )
      ).location,
    onSuccess: (location) => window.location.assign(location),
  });
  return (
    <>
      <h3>Link another</h3>
      <p className="muted">
        Type the slug of an organization with single sign-on. You sign in there once, and it is then
        another way into this account. Link only a provider you trust: whoever runs it can sign in
        as you.
      </p>
      <div className="stack">
        <label>
          Organization slug
          <input value={slug} onChange={(e) => setSlug(e.target.value)} autoComplete="off" />
        </label>
        {slug.trim() && (
          <button type="button" disabled={start.isPending} onClick={() => start.mutate()}>
            Link with single sign-on
          </button>
        )}
      </div>
      {start.error && (
        <p role="alert" className="error">
          {start.error.message}
        </p>
      )}
    </>
  );
}
