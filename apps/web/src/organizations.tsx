import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ComponentProps, type FormEvent, useId, useState } from "react";
import { allPages, call, useClient } from "./api";
import { ErrorPanel, useMe } from "./auth";
import { Callout, Card, Dialog, Empty, Icon, Named, useToast } from "./components";
import { type Org, RequireOrg } from "./org";
import { type Project, useProjects } from "./projects";
import { href } from "./router";
import { useAccess } from "./settings";
import { Loading, stamp, when } from "./ui";

interface Member {
  id: string;
  username: string;
  name: string;
  role: string;
  expiresAt: string;
}

// the API's rule for a slug: words of lower-case letters and digits joined by single dashes
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A labelled input with its line underneath: the hint, or, when `wrong` says something, that instead. */
function Field({
  label,
  hint,
  wrong,
  ...input
}: { label: string; hint?: string; wrong?: string } & ComponentProps<"input">) {
  const id = useId();
  const line = wrong ?? hint;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        {...input}
        id={id}
        aria-invalid={wrong ? true : undefined}
        aria-describedby={line ? `${id}-line` : undefined}
      />
      {wrong ? (
        <span className="error" id={`${id}-line`}>
          <Icon name="error" />
          {wrong}
        </span>
      ) : (
        hint && (
          <span className="hint" id={`${id}-line`}>
            {hint}
          </span>
        )
      )}
    </div>
  );
}

/**
 * For a platform admin: makes an organization and links it to a GitLab group, a GitHub organization or both, which
 * cannot be changed afterwards. The API accepts none, but then nobody holds a role in it (only an owner can set a
 * provider up), so the form asks for one.
 */
function CreateOrganization() {
  const client = useClient();
  const queries = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [group, setGroup] = useState("");
  const [hub, setHub] = useState("");
  const create = useMutation({
    mutationFn: () =>
      call(() =>
        client.organizations.post({
          name: name.trim(),
          slug,
          ...(group && { gitlabGroupId: Number(group) }),
          ...(hub && { githubOrgId: Number(hub) }),
        }),
      ),
    onSuccess: async () => {
      setName("");
      setSlug("");
      setGroup("");
      setHub("");
      await queries.invalidateQueries({ queryKey: ["orgs"] });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  const slugWrong =
    slug !== "" && !SLUG.test(slug)
      ? "Use lowercase letters and digits, separated by single dashes."
      : undefined;
  return (
    <Card
      title="Create an organization"
      sub="An organization is linked to a GitLab group, a GitHub organization or both: its members get their roles from there, and an owner can then add an identity provider for more. The slug and the links cannot be changed afterwards."
    >
      <form onSubmit={submit} className="stack" aria-label="New organization">
        <div className="fields">
          <Field
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
            autoComplete="off"
          />
          <Field
            label="Slug"
            hint="Lowercase letters, digits and dashes. Cannot be changed afterwards."
            wrong={slugWrong}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            required
            maxLength={63}
            placeholder="acme"
            autoComplete="off"
            spellCheck={false}
          />
          <Field
            label="GitLab group ID"
            hint="Cannot be changed afterwards."
            type="number"
            min={1}
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            required={!hub}
          />
          <Field
            label="GitHub organization ID"
            hint="Cannot be changed afterwards."
            type="number"
            min={1}
            value={hub}
            onChange={(e) => setHub(e.target.value)}
            required={!group}
          />
        </div>
        {create.error && <Callout tone="bad">{create.error.message}</Callout>}
        {create.data && (
          <div role="status">
            <Callout tone="ok">
              Created {create.data.name}. It shows here, and in the switcher, once you hold a role
              in it: roles come from its GitLab group or GitHub organization, so be a member of one,
              and allow a few minutes.
            </Callout>
          </div>
        )}
        <div className="row">
          <button
            type="submit"
            className="primary"
            aria-busy={create.isPending || undefined}
            disabled={create.isPending || slugWrong !== undefined}
          >
            {create.isPending ? "Creating…" : "Create organization"}
          </button>
        </div>
      </form>
    </Card>
  );
}

function Rename({ org }: { org: Org }) {
  const client = useClient();
  const queries = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(org.name);
  const rename = useMutation({
    mutationFn: (next: string) =>
      call(() => client.organizations({ orgId: org.id }).patch({ name: next })),
    onSuccess: async (_org, next) => {
      await queries.invalidateQueries({ queryKey: ["orgs"] });
      toast(`Renamed the organization to ${next}.`);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    rename.mutate(name.trim());
  };
  return (
    <form onSubmit={submit} className="stack" aria-label="Rename organization">
      <Field
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        maxLength={100}
        autoComplete="off"
      />
      {rename.error && (
        <p role="alert" className="error">
          {rename.error.message}
        </p>
      )}
      <div className="row">
        <button
          type="submit"
          aria-busy={rename.isPending || undefined}
          disabled={rename.isPending || name.trim() === org.name}
        >
          {rename.isPending ? "Renaming…" : "Rename"}
        </button>
      </div>
    </form>
  );
}

/** Deleting asks for the slug in a dialog, and says what goes with the organization and what keeps it from being deleted. */
function Delete({ org }: { org: Org }) {
  const client = useClient();
  const queries = useQueryClient();
  const toast = useToast();
  const typedId = useId();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const remove = useMutation({
    mutationFn: () => call(() => client.organizations({ orgId: org.id }).delete()),
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: ["orgs"] });
      toast(`Deleted ${org.name}.`);
    },
  });
  const close = () => {
    remove.reset();
    setTyped("");
    setConfirming(false);
  };
  return (
    <>
      <button type="button" className="danger" onClick={() => setConfirming(true)}>
        Delete organization…
      </button>
      {confirming && (
        <Dialog
          title={`Delete ${org.name}`}
          cancel="Keep"
          confirm="Delete organization"
          destructive
          busy={remove.isPending}
          disabled={typed !== org.slug}
          error={remove.error?.message}
          onConfirm={() => remove.mutate()}
          close={close}
        >
          <Callout tone="warn">
            Deleting removes the organization's variables, worker pools, cost limits and policy
            sets. Its audit trail keeps its record.
          </Callout>
          <p>
            It cannot be deleted while it still has projects, connections, notification sinks or an
            identity provider: remove those first.
          </p>
          <div className="field">
            <label htmlFor={typedId}>Type {org.slug} to confirm</label>
            <input
              id={typedId}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </Dialog>
      )}
    </>
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
    <Card
      title="Members"
      sub="People who signed in through the organization's identity provider, with the role that sign-in gave them until it ends. People who hold a role through the organization's GitLab group are not listed here: GitLab lists them."
    >
      {members.isPending && <Loading what="Loading members" />}
      {members.error && !members.data && (
        <ErrorPanel error={members.error} retry={() => void members.refetch()} />
      )}
      {members.data &&
        (members.data.length === 0 ? (
          <Empty
            title="Nobody holds a role through the identity provider right now"
            text="People appear here once they sign in through the identity provider."
          />
        ) : (
          <div className="scroll">
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
          </div>
        ))}
    </Card>
  );
}

// the shapes the API and the table hold a zone and a stack name to
const ZONE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const STACK = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

interface Zone {
  id: string;
  projectId: string;
  zone: string;
  stack: string;
  createdAt: string | Date;
}

/** One claim. Releasing asks first, in a dialog, and says what it does and what it leaves alone. */
function ZoneRow({
  orgId,
  zone,
  project,
  canRelease,
}: {
  orgId: string;
  zone: Zone;
  project: string;
  canRelease: boolean;
}) {
  const client = useClient();
  const queries = useQueryClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const release = useMutation({
    mutationFn: () =>
      call(() => client.organizations({ orgId }).dns.zones({ zoneId: zone.id }).delete()),
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: ["dns-zones", orgId] });
      toast(`Released ${zone.zone}.`);
    },
  });
  const close = () => {
    release.reset();
    setConfirming(false);
  };
  return (
    <tr>
      <th scope="row">{zone.zone}</th>
      <td>{project}</td>
      <td>
        <code>{zone.stack}</code>
      </td>
      <td>
        <time dateTime={stamp(zone.createdAt)}>{when(zone.createdAt)}</time>
      </td>
      {canRelease && (
        <td>
          <button type="button" onClick={() => setConfirming(true)}>
            <Named word="Release…" name={zone.zone} />
          </button>
          {confirming && (
            <Dialog
              title={`Release ${zone.zone}`}
              cancel="Keep"
              confirm={`Release ${zone.zone}`}
              destructive
              busy={release.isPending}
              error={release.error?.message}
              onConfirm={() => release.mutate()}
              close={close}
            >
              <Callout tone="warn">
                The zone stops being managed by this stack: a plan that changes it is refused until
                it is claimed again. Its records at the provider are not touched.
              </Callout>
            </Dialog>
          )}
        </td>
      )}
    </tr>
  );
}

/** An admin's form: which project's stack manages a zone. Without a project there is nothing to claim it for. */
function ClaimZone({ orgId, projects }: { orgId: string; projects: Project[] }) {
  const client = useClient();
  const queries = useQueryClient();
  const toast = useToast();
  const projectField = useId();
  const [zone, setZone] = useState("");
  const [stack, setStack] = useState("");
  const [projectId, setProjectId] = useState<string>();
  const project = projects.find((p) => p.id === projectId) ?? projects[0];
  const claim = useMutation({
    mutationFn: () =>
      call(() =>
        client
          .organizations({ orgId })
          .dns.zones.post({ zone, projectId: project?.id ?? "", stack }),
      ),
    onSuccess: async () => {
      setZone("");
      setStack("");
      await queries.invalidateQueries({ queryKey: ["dns-zones", orgId] });
      toast(`Claimed ${zone}.`);
    },
  });
  if (!project) {
    return (
      <p>
        A zone is claimed for a project's stack. <a href={href("projects")}>Import a project</a>{" "}
        first.
      </p>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    claim.mutate();
  };
  const zoneWrong =
    zone !== "" && !ZONE.test(zone)
      ? "Enter a domain such as example.com: lowercase letters, digits and dashes, with at least one dot."
      : undefined;
  const stackWrong =
    stack !== "" && !STACK.test(stack)
      ? "Use lowercase letters, digits and dashes. Start and end with a letter or digit."
      : undefined;
  return (
    <form onSubmit={submit} className="stack" aria-label="Claim a zone">
      <h3>Claim a zone</h3>
      <div className="fields">
        <Field
          label="Zone"
          hint="The domain the stack manages."
          wrong={zoneWrong}
          value={zone}
          onChange={(e) => setZone(e.target.value)}
          maxLength={253}
          placeholder="example.com"
          autoComplete="off"
          spellCheck={false}
        />
        <div className="field">
          <label htmlFor={projectField}>Project</label>
          <select
            id={projectField}
            value={project.id}
            onChange={(e) => setProjectId(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Stack"
          hint="Lowercase letters, digits and dashes, up to 63 characters."
          wrong={stackWrong}
          value={stack}
          onChange={(e) => setStack(e.target.value)}
          maxLength={63}
          placeholder="example-com"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {claim.error && <Callout tone="bad">{claim.error.message}</Callout>}
      <div className="row">
        <button
          type="submit"
          className="primary"
          aria-busy={claim.isPending || undefined}
          disabled={claim.isPending || !ZONE.test(zone) || !STACK.test(stack)}
        >
          {claim.isPending ? "Claiming…" : "Claim zone"}
        </button>
      </div>
    </form>
  );
}

/**
 * The DNS zones the organization has claimed (DNS-15), for anyone in it to read; an admin claims and releases. A claim
 * is a guard against a project managing a zone by mistake: what a zone's token may change is the real boundary.
 */
function Zones({ orgId, actions }: { orgId: string; actions: string[] }) {
  const client = useClient();
  const projects = useProjects(orgId);
  const zones = useQuery({
    queryKey: ["dns-zones", orgId],
    queryFn: () =>
      allPages<Zone>((cursor) =>
        client.organizations({ orgId }).dns.zones.get({ query: { limit: 100, cursor } }),
      ),
  });
  const nameOf = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? id;
  const canRelease = actions.includes("dns.zone.delete");
  return (
    <Card
      title="DNS zones"
      sub="A claim says which project's stack may manage a DNS zone with DNSControl. It is a guard, not a wall: the token the stack applies with decides what can really change, so scope it to the zone."
    >
      {zones.isPending && <Loading what="Loading zones" />}
      {zones.error && !zones.data && (
        <ErrorPanel error={zones.error} retry={() => void zones.refetch()} />
      )}
      {zones.data &&
        (zones.data.length === 0 ? (
          <Empty
            title="No zone is claimed yet"
            text={
              actions.includes("dns.zone.create")
                ? "Claim a zone below to say which project's stack may manage it."
                : "An admin can claim a zone for a project's stack."
            }
          />
        ) : (
          <div className="scroll">
            <table>
              <caption className="visually-hidden">DNS zones</caption>
              <thead>
                <tr>
                  <th scope="col">Zone</th>
                  <th scope="col">Project</th>
                  <th scope="col">Stack</th>
                  <th scope="col">Claimed</th>
                  {canRelease && <th scope="col">Release</th>}
                </tr>
              </thead>
              <tbody>
                {zones.data.map((z) => (
                  <ZoneRow
                    key={z.id}
                    orgId={orgId}
                    zone={z}
                    project={nameOf(z.projectId)}
                    canRelease={canRelease}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ))}
      {actions.includes("dns.zone.create") &&
        (projects.error ? (
          <ErrorPanel error={projects.error} retry={() => void projects.refetch()} />
        ) : projects.data ? (
          <ClaimZone orgId={orgId} projects={projects.data} />
        ) : (
          <Loading what="Loading projects" />
        ))}
    </Card>
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
      <Card title="This organization">
        <div className="fields">
          <dl>
            <dt>Name</dt>
            <dd>{org.name}</dd>
            <dt>Slug</dt>
            <dd>{org.slug}</dd>
            <dt>GitLab group</dt>
            <dd>{org.gitlabGroupId ?? "None"}</dd>
            <dt>GitHub organization</dt>
            <dd>{org.githubOrgId ?? "None"}</dd>
            <dt>Your role</dt>
            <dd>{role}</dd>
          </dl>
          {actions.includes("organization.update") && <Rename org={org} />}
        </div>
        {actions.includes("organization.delete") && (
          <div className="card-foot">
            <Delete org={org} />
          </div>
        )}
      </Card>
      {actions.includes("member.read") && <Members orgId={org.id} />}
      {actions.includes("dns.zone.read") && <Zones orgId={org.id} actions={actions} />}
    </>
  );
}

/** Organizations (SSO-6): a platform admin makes them; the people in one see it, and its admins and owners manage it. */
export function OrganizationsPage() {
  const me = useMe();
  return (
    <div className="stack wide">
      {me.platformAdmin && <CreateOrganization />}
      <RequireOrg>{(org) => <ThisOrganization key={org.id} org={org} />}</RequireOrg>
    </div>
  );
}
