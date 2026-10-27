import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { ApiError, call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { Callout, Card, Confirm, Drawer, Empty, StatusBadge, useToast } from "./components";
import { Loading, stamp, when } from "./ui";

type Role = "viewer" | "member" | "admin" | "owner";
const ROLES = ["viewer", "member", "admin", "owner"] as const satisfies readonly Role[];

/** Each rule is a card of its own, and a drawer of more than four is a long scroll; the API takes 50. */
const MAX_RULES = 4;

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
 * Sets a provider up or changes it, in a drawer. The client secret is typed here and goes nowhere else: it lives in
 * this form's state, which goes with the form once the call is made (the mutation takes no variables, so the cache
 * holds none), and a change leaves it blank to keep the stored one.
 * The issuer is the provider's name for itself and is not changed: another one is another provider.
 */
function ProviderDrawer({
  orgId,
  existing,
  close,
}: {
  orgId: string;
  existing?: Provider | undefined;
  close: () => void;
}) {
  const client = useClient();
  const queries = useQueryClient();
  const toast = useToast();
  const hint = useId();
  const add = useRef<HTMLButtonElement>(null);
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState(existing?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [domains, setDomains] = useState(existing?.emailDomains.join("\n") ?? "");
  const [rules, setRules] = useState<Rule[]>(
    existing?.roleMap ?? [{ claim: "groups", value: "", role: "viewer" }],
  );
  // the button that was pressed to remove a rule is gone: focus goes to the one beside the list
  const [removed, setRemoved] = useState(0);
  useEffect(() => {
    if (removed) add.current?.focus();
  }, [removed]);
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
      close();
      toast(existing ? "Saved the identity provider." : "Set up the identity provider.");
    },
  });
  const edit = (i: number, change: Partial<Rule>) =>
    setRules((all) => all.map((r, j) => (j === i ? { ...r, ...change } : r)));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };
  return (
    <Drawer
      title={existing ? "Edit the identity provider" : "Set up an identity provider"}
      sub="OpenID Connect"
      close={save.isPending ? () => {} : close}
    >
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
        <div className="field">
          <label>
            Email domains
            <textarea
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              rows={3}
              placeholder="acme.example"
              aria-describedby={hint}
            />
          </label>
          <span className="hint" id={hint}>
            One per line. Only people whose verified email is at one of these domains can sign in.
          </span>
        </div>
        <fieldset className="bare stack">
          <legend>Role rules</legend>
          <p className="muted">
            A rule gives a role to everyone whose sign-in carries the claim with that value (a group
            name, say). The highest role of the rules that match is the one they get; no match, no
            sign-in.
          </p>
          {rules.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own; they are edited in place
            <div className="rule-card" key={i}>
              <div className="rule-card-head">
                <b>Rule {i + 1}</b>
                <button
                  type="button"
                  className="quiet small"
                  onClick={() => {
                    setRules((all) => all.filter((_, j) => j !== i));
                    setRemoved((n) => n + 1);
                  }}
                  aria-label={`Remove rule ${i + 1}`}
                >
                  Remove
                </button>
              </div>
              <div className="rule-card-cols">
                <label>
                  Claim
                  <input
                    value={r.claim}
                    onChange={(e) => edit(i, { claim: e.target.value })}
                    required
                    maxLength={100}
                    spellCheck={false}
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
                    spellCheck={false}
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
              </div>
            </div>
          ))}
          <div>
            <button
              type="button"
              ref={add}
              className="small"
              disabled={rules.length >= MAX_RULES}
              onClick={() =>
                setRules((all) => [...all, { claim: "groups", value: "", role: "viewer" }])
              }
            >
              Add rule
            </button>
          </div>
        </fieldset>
        {save.error && <Callout tone="bad">{save.error.message}</Callout>}
        <div className="drawer-foot">
          <button type="button" disabled={save.isPending} onClick={close}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={save.isPending}>
            {save.isPending ? "Saving…" : existing ? "Save changes" : "Set up"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}

/** What an owner can do with a provider: try it, turn it on or off, change it, delete it. */
function Controls({ orgId, provider }: { orgId: string; provider: Provider }) {
  const client = useClient();
  const queries = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const at = () => client.organizations({ orgId }).sso;
  const refresh = () => queries.invalidateQueries({ queryKey: ["sso", orgId] });
  const test = useMutation({ mutationFn: () => call(() => at().test.post()) });
  const turn = useMutation({
    mutationFn: () => call(() => (provider.enabled ? at().disable.post() : at().enable.post())),
    onSuccess: async () => {
      await refresh();
      toast(provider.enabled ? "Turned off single sign-on." : "Turned on single sign-on.");
    },
  });
  const remove = useMutation({
    mutationFn: () => call(() => at().delete()),
    onSuccess: async () => {
      await refresh();
      toast("Deleted the identity provider.");
    },
  });
  const result = test.data;
  const failed = test.error ?? turn.error;
  const keep = () => {
    remove.reset();
    setConfirming(false);
  };
  return (
    <>
      {result?.ok && (
        <div role="status">
          <Callout tone="ok">The provider answers: {result.keys} signing key(s) found.</Callout>
        </div>
      )}
      {result && !result.ok && <Callout tone="bad">{result.message}</Callout>}
      {failed && <Callout tone="bad">{failed.message}</Callout>}
      <div className="card-foot detail-actions">
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
          className="danger"
          onClick={() => {
            test.reset();
            setConfirming(true);
          }}
        >
          Delete…
        </button>
      </div>
      {editing && (
        <ProviderDrawer orgId={orgId} existing={provider} close={() => setEditing(false)} />
      )}
      {confirming && (
        <Confirm
          title="Delete the identity provider"
          warn="People who can only sign in through it keep their accounts, with no way in. Its stored client secret is deleted."
          go="Delete provider"
          busy={remove.isPending}
          error={remove.error?.message}
          onConfirm={() => remove.mutate()}
          close={keep}
        />
      )}
    </>
  );
}

/**
 * The organization's identity provider (SSO-5, ADR-0016): admins read it, owners set it up. The client secret is
 * stored encrypted and is never shown, so there is nowhere on this page it could be.
 */
export function SingleSignOn({ orgId, actions }: { orgId: string; actions: readonly string[] }) {
  const provider = useProvider(orgId);
  const rules = useId();
  const [setting, setSetting] = useState(false);
  const owner = actions.includes("sso.manage");
  const found = provider.data;
  return (
    <Card
      title="Single sign-on"
      sub={
        <>
          Lets people of this organization sign in with its OpenID Connect provider instead of
          GitLab. What they may do here comes from the role rules below, and is decided again at
          each sign-in.
          {!owner && " Only an owner can change it."}
        </>
      }
    >
      {provider.isPending && <Loading what="Loading single sign-on" />}
      {provider.error && provider.data === undefined && (
        <ErrorPanel error={provider.error} retry={() => void provider.refetch()} />
      )}
      {found === null && (
        <>
          <Empty
            title="No identity provider yet"
            text={
              owner
                ? "Set one up so people can sign in with your OpenID Connect provider."
                : "An owner can set one up."
            }
            action={
              owner && (
                <button type="button" className="primary" onClick={() => setSetting(true)}>
                  Set up…
                </button>
              )
            }
          />
          {setting && <ProviderDrawer orgId={orgId} close={() => setSetting(false)} />}
        </>
      )}
      {found && (
        <>
          <dl>
            <dt>Issuer</dt>
            <dd>
              <code>{found.issuer}</code>
            </dd>
            <dt>Client ID</dt>
            <dd>
              <code>{found.clientId}</code>
            </dd>
            <dt>Client secret</dt>
            <dd>Stored encrypted, never shown</dd>
            <dt>Email domains</dt>
            <dd>{found.emailDomains.join(", ") || <span className="muted">None</span>}</dd>
            <dt>State</dt>
            <dd>
              <StatusBadge tone={found.enabled ? "ok" : "quiet"}>
                {found.enabled ? "On" : "Off"}
              </StatusBadge>
            </dd>
            <dt>Changed</dt>
            <dd>
              <time dateTime={stamp(found.updatedAt)}>{when(found.updatedAt)}</time>
            </dd>
          </dl>
          <h3 id={rules}>Role rules</h3>
          <div className="scroll">
            <table aria-labelledby={rules}>
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
                    <th scope="row">
                      <code>{r.claim}</code>
                    </th>
                    <td>
                      <code>{r.value}</code>
                    </td>
                    <td>
                      <span className="tag">{r.role}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {owner && <Controls orgId={orgId} provider={found} />}
        </>
      )}
    </Card>
  );
}
