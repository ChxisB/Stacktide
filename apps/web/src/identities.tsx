import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { Callout, Card, Confirm, Named, useToast } from "./components";
import { Loading, stamp, when } from "./ui";

const FORGE_NAME = { gitlab: "GitLab", github: "GitHub" };

/** The question and the doing of giving up one single sign-on method; the role it gave goes with it. */
function Unlink({ id, organization }: { id: string; organization: string }) {
  const client = useClient();
  const queries = useQueryClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const unlink = useMutation({
    mutationFn: () => call(() => client.auth.identities({ id }).delete()),
    // a role went with it: what the person may see in each organization is read again
    onSuccess: async () => {
      await queries.invalidateQueries();
      toast(`Unlinked single sign-on: ${organization}.`);
    },
  });
  const keep = () => {
    unlink.reset();
    setConfirming(false);
  };
  return (
    <>
      <button type="button" className="danger" onClick={() => setConfirming(true)}>
        <Named word="Unlink…" name={organization} />
      </button>
      {confirming && (
        <Confirm
          title={`Unlink single sign-on: ${organization}`}
          warn="Giving up a single sign-on method ends the role it gave you. GitLab or GitHub is your account's own and stays."
          go="Unlink"
          busy={unlink.isPending}
          error={unlink.error?.message}
          onConfirm={() => unlink.mutate()}
          close={keep}
        />
      )}
    </>
  );
}

/**
 * The person's own ways to sign in (SSO-7, ADR-0016). The GitLab or GitHub one is the account's own and stays; an SSO one can be
 * given up while another way in is left, and the role it gave goes with it. Linking another sends the browser through
 * that organization's provider and back here.
 */
export function SignInMethods() {
  const client = useClient();
  const list = useQuery({
    queryKey: ["identities"],
    queryFn: () => call(() => client.auth.identities.get()),
  });
  const identities = list.data;
  return (
    <Card
      title="Sign-in methods"
      sub="The ways you can sign in. Giving up a single sign-on one ends the role it gave you; GitLab or GitHub is your account's own and stays."
    >
      {list.isPending && <Loading what="Loading sign-in methods" />}
      {list.error && identities === undefined && (
        <ErrorPanel error={list.error} retry={() => void list.refetch()} />
      )}
      {identities && (
        <div className="scroll">
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
                  <th scope="row">
                    {i.kind === "sso" ? (
                      <>
                        Single sign-on: {i.organizationName}{" "}
                        <span className="muted">({i.organizationSlug})</span>
                      </>
                    ) : (
                      FORGE_NAME[i.kind]
                    )}
                  </th>
                  <td>{i.email ?? <span className="muted">None</span>}</td>
                  <td>
                    <time dateTime={stamp(i.createdAt)}>{when(i.createdAt)}</time>
                  </td>
                  <td>
                    {i.kind === "sso" && identities.length > 1 && (
                      <Unlink
                        id={i.id}
                        organization={i.organizationName ?? i.organizationSlug ?? "this provider"}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <LinkAnother />
    </Card>
  );
}

/**
 * Adds an organization's provider as another way in. The API starts it (a POST, so no other site can start one in this
 * browser) and says where to go; the person signs in there once and comes back to this page.
 */
function LinkAnother() {
  const client = useClient();
  const heading = useId();
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
  const submit = (event: FormEvent) => {
    event.preventDefault();
    // Enter in an empty field would otherwise ask the API about no organization at all
    if (slug.trim() && !start.isPending) start.mutate();
  };
  return (
    <form className="stack" aria-labelledby={heading} onSubmit={submit}>
      <h3 id={heading}>Link another</h3>
      <p className="muted">
        Type the slug of an organization with single sign-on. You sign in there once, and it is then
        another way into this account.
      </p>
      <Callout tone="warn">
        Link only a provider you trust: whoever runs it can sign in as you.
      </Callout>
      <div className="row link-row">
        <label>
          Organization slug
          <input value={slug} onChange={(e) => setSlug(e.target.value)} autoComplete="off" />
        </label>
        {slug.trim() && (
          <button type="submit" className="primary" disabled={start.isPending}>
            Link with single sign-on
          </button>
        )}
      </div>
      {start.error && <Callout tone="bad">{start.error.message}</Callout>}
    </form>
  );
}
