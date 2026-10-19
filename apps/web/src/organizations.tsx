import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { allPages, call, useClient } from "./api";
import { ErrorPanel, useMe } from "./auth";
import { type Org, RequireOrg } from "./org";
import { useAccess } from "./settings";
import { Loading, stamp, when } from "./ui";

interface Member {
  id: string;
  username: string;
  name: string;
  role: string;
  expiresAt: string;
}

/**
 * For a platform admin: makes an organization and links it to a GitLab group, which cannot be changed afterwards. The
 * API accepts none, but then nobody holds a role in it (only an owner can set a provider up), so the form asks for one.
 */
function CreateOrganization() {
  const client = useClient();
  const queries = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [group, setGroup] = useState("");
  const create = useMutation({
    mutationFn: () =>
      call(() =>
        client.organizations.post({ name: name.trim(), slug, gitlabGroupId: Number(group) }),
      ),
    onSuccess: async () => {
      setName("");
      setSlug("");
      setGroup("");
      await queries.invalidateQueries({ queryKey: ["orgs"] });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  return (
    <section className="stack" aria-labelledby="create-org-title">
      <h2 id="create-org-title">Create an organization</h2>
      <p className="muted">
        An organization is linked to a GitLab group: its members get their roles from that group,
        and an owner can then add an identity provider for more. The slug and the group cannot be
        changed afterwards.
      </p>
      <form onSubmit={submit} className="stack" aria-label="New organization">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        </label>
        <label>
          Slug
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            required
            maxLength={63}
            placeholder="acme"
          />
        </label>
        <label>
          GitLab group ID
          <input
            type="number"
            min={1}
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            required
          />
        </label>
        {create.error && (
          <p role="alert" className="error">
            {create.error.message}
          </p>
        )}
        {create.data && (
          <p role="status">
            Created {create.data.name}. It shows here, and in the switcher, once you hold a role in
            it: roles come from its GitLab group, so be a member of that group, and allow a few
            minutes.
          </p>
        )}
        <div className="row">
          <button type="submit" className="primary" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create organization"}
          </button>
        </div>
      </form>
    </section>
  );
}

function Rename({ org }: { org: Org }) {
  const client = useClient();
  const queries = useQueryClient();
  const [name, setName] = useState(org.name);
  const rename = useMutation({
    mutationFn: () =>
      call(() => client.organizations({ orgId: org.id }).patch({ name: name.trim() })),
    onSuccess: () => queries.invalidateQueries({ queryKey: ["orgs"] }),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    rename.mutate();
  };
  return (
    <form onSubmit={submit} className="stack" aria-label="Rename organization">
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
      </label>
      {rename.error && (
        <p role="alert" className="error">
          {rename.error.message}
        </p>
      )}
      <div className="row">
        <button type="submit" disabled={rename.isPending || name.trim() === org.name}>
          {rename.isPending ? "Renaming…" : "Rename"}
        </button>
      </div>
    </form>
  );
}

/** Deleting asks for the slug, and says what goes with the organization and what keeps it from being deleted. */
function Delete({ org }: { org: Org }) {
  const client = useClient();
  const queries = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const remove = useMutation({
    mutationFn: () => call(() => client.organizations({ orgId: org.id }).delete()),
    onSuccess: () => queries.invalidateQueries({ queryKey: ["orgs"] }),
  });
  if (!confirming) {
    return (
      <div className="row">
        <button type="button" onClick={() => setConfirming(true)}>
          Delete organization…
        </button>
      </div>
    );
  }
  return (
    <div className="stack">
      <p className="muted">
        Deleting removes the organization's variables, worker pools, cost limits and policy sets.
        Its audit trail keeps its record. It cannot be deleted while it still has projects,
        connections, notification sinks or an identity provider: remove those first.
      </p>
      <label>
        Type {org.slug} to confirm
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {remove.error && (
        <p role="alert" className="error">
          {remove.error.message}
        </p>
      )}
      <div className="row">
        <button
          type="button"
          className="danger"
          disabled={typed !== org.slug || remove.isPending}
          onClick={() => remove.mutate()}
        >
          {remove.isPending ? "Deleting…" : "Delete organization"}
        </button>
        <button
          type="button"
          disabled={remove.isPending}
          onClick={() => {
            remove.reset();
            setTyped("");
            setConfirming(false);
          }}
        >
          Keep
        </button>
      </div>
    </div>
  );
}

/** Who holds a role through the organization's identity provider; the GitLab group's members are GitLab's to list. */
function Members({ orgId }: { orgId: string }) {
  const client = useClient();
  const members = useQuery({
    queryKey: ["members", orgId],
    queryFn: () =>
      allPages<Member>((cursor) =>
        client.organizations({ orgId }).members.get({ query: { limit: 100, cursor } }),
      ),
  });
  return (
    <section className="stack" aria-labelledby="members-title">
      <h2 id="members-title">Members</h2>
      <p className="muted">
        People who signed in through the organization's identity provider, with the role that
        sign-in gave them until it ends. People who hold a role through the organization's GitLab
        group are not listed here: GitLab lists them.
      </p>
      {members.isPending && <Loading what="Loading members" />}
      {members.error && !members.data && (
        <ErrorPanel error={members.error} retry={() => void members.refetch()} />
      )}
      {members.data &&
        (members.data.length === 0 ? (
          <p>Nobody holds a role through the identity provider right now.</p>
        ) : (
          <table>
            <caption className="visually-hidden">Members</caption>
            <thead>
              <tr>
                <th scope="col">Username</th>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col">Until</th>
              </tr>
            </thead>
            <tbody>
              {members.data.map((m) => (
                <tr key={m.id}>
                  <th scope="row">{m.username}</th>
                  <td>{m.name}</td>
                  <td>{m.role}</td>
                  <td>
                    <time dateTime={stamp(m.expiresAt)}>{when(m.expiresAt)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </section>
  );
}

/** The chosen organization: what it is for everyone in it, and what an admin or an owner may do with it. */
function ThisOrganization({ org }: { org: Org }) {
  const access = useAccess(org.id);
  if (access.isPending) return <Loading what="Loading the organization" />;
  if (!access.data) return <ErrorPanel error={access.error} retry={() => void access.refetch()} />;
  const { role, actions } = access.data;
  return (
    <>
      <section className="stack" aria-labelledby="this-org-title">
        <h2 id="this-org-title">This organization</h2>
        <dl>
          <dt>Name</dt>
          <dd>{org.name}</dd>
          <dt>Slug</dt>
          <dd>{org.slug}</dd>
          <dt>GitLab group</dt>
          <dd>{org.gitlabGroupId ?? "None"}</dd>
          <dt>Your role</dt>
          <dd>{role}</dd>
        </dl>
        {actions.includes("organization.update") && <Rename org={org} />}
        {actions.includes("organization.delete") && <Delete org={org} />}
      </section>
      {actions.includes("member.read") && <Members orgId={org.id} />}
    </>
  );
}

/** Organizations (SSO-6): a platform admin makes them; the people in one see it, and its admins and owners manage it. */
export function OrganizationsPage() {
  const me = useMe();
  return (
    <div className="stack">
      {me.platformAdmin && <CreateOrganization />}
      <RequireOrg>{(org) => <ThisOrganization key={org.id} org={org} />}</RequireOrg>
    </div>
  );
}
