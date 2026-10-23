import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ApiError, call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { Card } from "./components";
import { Loading, stamp, when } from "./ui";

type Role = "viewer" | "member" | "admin" | "owner";
const ROLES = ["viewer", "member", "admin", "owner"] as const satisfies readonly Role[];

interface Rule {
  claim: string;
  value: string;
  role: Role;
}
interface Provider {
  issuer: string;
  clientId: string;
  emailDomains: string[];
  roleMap: Rule[];
  enabled: boolean;
  updatedAt: string | Date;
}

/** `null` is an organization with none: the API answers 404, which here is an answer, not a failure. */
const useProvider = (orgId: string) => {
  const client = useClient();
  return useQuery({
    queryKey: ["sso", orgId],
    queryFn: async (): Promise<Provider | null> => {
      try {
        return await call(() => client.organizations({ orgId }).sso.get());
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
  });
};

const domainsOf = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((d) => d.trim())
    .filter(Boolean);

/**
 * Sets a provider up or changes it. The client secret is typed here and goes nowhere else: it lives in this form's
 * state, which goes with the form once the call is made (the mutation takes no variables, so the cache holds none),
 * and a change leaves it blank to keep the stored one.
 * The issuer is the provider's name for itself and is not changed: another one is another provider.
 */
function ProviderForm({
  orgId,
  existing,
  onDone,
}: {
  orgId: string;
  existing?: Provider | undefined;
  onDone: () => void;
}) {
  const client = useClient();
  const queries = useQueryClient();
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState(existing?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [domains, setDomains] = useState(existing?.emailDomains.join("\n") ?? "");
  const [rules, setRules] = useState<Rule[]>(
    existing?.roleMap ?? [{ claim: "groups", value: "", role: "viewer" }],
  );
  const save = useMutation({
    mutationFn: () => {
      const at = client.organizations({ orgId }).sso;
      const shared = { clientId, emailDomains: domainsOf(domains), roleMap: rules };
      return call(() =>
        existing
          ? at.patch({ ...shared, ...(secret && { clientSecret: secret }) })
          : at.put({ ...shared, issuer: issuer.trim(), clientSecret: secret }),
      );
    },
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: ["sso", orgId] });
      onDone();
    },
  });
  const edit = (i: number, change: Partial<Rule>) =>
    setRules((all) => all.map((r, j) => (j === i ? { ...r, ...change } : r)));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="stack" aria-label="Identity provider">
      {existing ? (
        <p>
          Issuer: <strong>{existing.issuer}</strong>{" "}
          <span className="muted">
            It cannot be changed. For another one, delete this provider and set up a new one.
          </span>
        </p>
      ) : (
        <label>
          Issuer
          <input
            type="url"
            value={issuer}
            onChange={(e) => setIssuer(e.target.value)}
            required
            maxLength={256}
            placeholder="https://idp.example.com/realms/acme"
          />
        </label>
      )}
      <label>
        Client ID
        <input
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          required
          maxLength={255}
        />
      </label>
      <label>
        Client secret
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          required={!existing}
          maxLength={1024}
          autoComplete="off"
          spellCheck={false}
          placeholder={existing ? "Leave empty to keep the stored secret" : ""}
        />
      </label>
      <label>
        Email domains
        <textarea
          value={domains}
          onChange={(e) => setDomains(e.target.value)}
          rows={3}
          placeholder="acme.example"
        />
      </label>
      <p className="muted">
        One per line. Only people whose verified email is at one of these domains can sign in.
      </p>
      <fieldset className="stack">
        <legend>Role rules</legend>
        <p className="muted">
          A rule gives a role to everyone whose sign-in carries the claim with that value (a group
          name, say). The highest role of the rules that match is the one they get; no match, no
          sign-in.
        </p>
        {rules.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own; they are edited in place
          <div className="row" key={i}>
            <label>
              Claim
              <input
                value={r.claim}
                onChange={(e) => edit(i, { claim: e.target.value })}
                required
                maxLength={100}
                aria-label={`Rule ${i + 1} claim`}
              />
            </label>
            <label>
              Value
              <input
                value={r.value}
                onChange={(e) => edit(i, { value: e.target.value })}
                required
                maxLength={200}
                aria-label={`Rule ${i + 1} value`}
              />
            </label>
            <label>
              Role
              <select
                value={r.role}
                onChange={(e) => edit(i, { role: e.target.value as Role })}
                aria-label={`Rule ${i + 1} role`}
              >
                {ROLES.map((role) => (
                  <option key={role}>{role}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => setRules((all) => all.filter((_, j) => j !== i))}
              aria-label={`Remove rule ${i + 1}`}
            >
              Remove
            </button>
          </div>
        ))}
        <div className="row">
          <button
            type="button"
            disabled={rules.length >= 50}
            onClick={() =>
              setRules((all) => [...all, { claim: "groups", value: "", role: "viewer" }])
            }
          >
            Add rule
          </button>
        </div>
      </fieldset>
      {save.error && (
        <p role="alert" className="error">
          {save.error.message}
        </p>
      )}
      <div className="row">
        <button type="submit" className="primary" disabled={save.isPending}>
          {save.isPending ? "Saving…" : existing ? "Save changes" : "Set up"}
        </button>
        <button type="button" disabled={save.isPending} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** What an owner can do with a provider: try it, turn it on or off, change it, delete it. */
function Controls({ orgId, provider }: { orgId: string; provider: Provider }) {
  const client = useClient();
  const queries = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const at = () => client.organizations({ orgId }).sso;
  const refresh = () => queries.invalidateQueries({ queryKey: ["sso", orgId] });
  const test = useMutation({ mutationFn: () => call(() => at().test.post()) });
  const turn = useMutation({
    mutationFn: () => call(() => (provider.enabled ? at().disable.post() : at().enable.post())),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: () => call(() => at().delete()), onSuccess: refresh });
  const result = test.data;
  const failed = turn.error ?? remove.error ?? test.error;
  if (editing) {
    return <ProviderForm orgId={orgId} existing={provider} onDone={() => setEditing(false)} />;
  }
  return (
    <div className="stack">
      {confirming ? (
        <div className="row">
          <button
            type="button"
            className="danger"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? "Deleting…" : "Delete provider"}
          </button>
          <button
            type="button"
            disabled={remove.isPending}
            onClick={() => {
              remove.reset();
              setConfirming(false);
            }}
          >
            Keep
          </button>
        </div>
      ) : (
        <div className="row">
          <button type="button" disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? "Testing…" : "Test"}
          </button>
          <button type="button" disabled={turn.isPending} onClick={() => turn.mutate()}>
            {provider.enabled ? "Turn off" : "Turn on"}
          </button>
          <button type="button" onClick={() => setEditing(true)}>
            Edit…
          </button>
          <button
            type="button"
            onClick={() => {
              test.reset();
              setConfirming(true);
            }}
          >
            Delete…
          </button>
        </div>
      )}
      {confirming && (
        <p className="muted">
          People who can only sign in through it keep their accounts, with no way in. Its stored
          client secret is deleted.
        </p>
      )}
      {result?.ok && <p role="status">The provider answers: {result.keys} signing key(s) found.</p>}
      {result && !result.ok && (
        <p role="alert" className="error">
          {result.message}
        </p>
      )}
      {failed && (
        <p role="alert" className="error">
          {failed.message}
        </p>
      )}
    </div>
  );
}

/**
 * The organization's identity provider (SSO-5, ADR-0016): admins read it, owners set it up. The client secret is
 * stored encrypted and is never shown, so there is nowhere on this page it could be.
 */
export function SingleSignOn({ orgId, actions }: { orgId: string; actions: readonly string[] }) {
  const provider = useProvider(orgId);
  const [setting, setSetting] = useState(false);
  const owner = actions.includes("sso.manage");
  const found = provider.data;
  return (
    <Card title="Single sign-on">
      <p className="muted">
        Lets people of this organization sign in with its OpenID Connect provider instead of GitLab.
        What they may do here comes from the role rules below, and is decided again at each sign-in.
        {!owner && " Only an owner can change it."}
      </p>
      {provider.isPending && <Loading what="Loading single sign-on" />}
      {provider.error && provider.data === undefined && (
        <ErrorPanel error={provider.error} retry={() => void provider.refetch()} />
      )}
      {found === null &&
        (setting ? (
          <ProviderForm orgId={orgId} onDone={() => setSetting(false)} />
        ) : (
          <>
            <p>No identity provider yet.</p>
            {owner && (
              <div className="row">
                <button type="button" onClick={() => setSetting(true)}>
                  Set up…
                </button>
              </div>
            )}
          </>
        ))}
      {found && (
        <>
          <dl>
            <dt>Issuer</dt>
            <dd>{found.issuer}</dd>
            <dt>Client ID</dt>
            <dd>{found.clientId}</dd>
            <dt>Client secret</dt>
            <dd className="muted">Stored encrypted, never shown</dd>
            <dt>Email domains</dt>
            <dd>{found.emailDomains.join(", ") || <span className="muted">None</span>}</dd>
            <dt>State</dt>
            <dd>{found.enabled ? "On" : "Off"}</dd>
            <dt>Changed</dt>
            <dd>
              <time dateTime={stamp(found.updatedAt)}>{when(found.updatedAt)}</time>
            </dd>
          </dl>
          <table>
            <caption className="visually-hidden">Role rules</caption>
            <thead>
              <tr>
                <th scope="col">Claim</th>
                <th scope="col">Value</th>
                <th scope="col">Role</th>
              </tr>
            </thead>
            <tbody>
              {found.roleMap.map((r) => (
                <tr key={`${r.claim}=${r.value}=${r.role}`}>
                  <td>{r.claim}</td>
                  <td>{r.value}</td>
                  <td>{r.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {owner && <Controls orgId={orgId} provider={found} />}
        </>
      )}
    </Card>
  );
}
