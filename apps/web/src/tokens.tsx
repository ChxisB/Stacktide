import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { allPages, call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { Loading, stamp, when } from "./ui";

/** How long a new token lasts, in days; the API's own cap is a year. */
const LIFETIMES = [7, 30, 90, 365] as const;

const words = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))];

interface Token {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | Date;
  lastUsedAt: string | Date | null;
  revokedAt: string | Date | null;
}
const stateOf = (t: Token, now: number) =>
  t.revokedAt ? "Revoked" : new Date(t.expiresAt).getTime() <= now ? "Expired" : "Active";

/** A token shown in full: this once, and held only by this component, never by the query cache. */
function Fresh({ name, token, done }: { name: string; token: string; done: () => void }) {
  const [copied, setCopied] = useState<boolean>();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section className="card stack" aria-label="New token">
      <p>
        <strong>Copy the token for {name} now.</strong> It is shown this once: only a fingerprint of
        it is kept, so it cannot be shown again.
      </p>
      <input
        readOnly
        value={token}
        aria-label="Token"
        onFocus={(e) => e.currentTarget.select()}
        spellCheck={false}
      />
      <div className="row">
        <button type="button" onClick={() => void copy()}>
          Copy
        </button>
        <button type="button" className="primary" onClick={done}>
          I have copied it
        </button>
      </div>
      {copied === true && <p role="status">Copied.</p>}
      {copied === false && (
        <p role="alert" className="error">
          Could not copy: select the token and copy it.
        </p>
      )}
    </section>
  );
}

function CreateToken({
  onCreated,
}: {
  onCreated: (made: { name: string; token: string }) => void;
}) {
  const client = useClient();
  const queries = useQueryClient();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState("");
  const [days, setDays] = useState<number>(30);
  const create = useMutation({
    // gcTime 0, and the token is moved out of the mutation at once: the cache must not keep it
    gcTime: 0,
    mutationFn: () =>
      call(() => client.tokens.post({ name, scopes: words(scopes), expiresInDays: days })),
    onSuccess: async ({ token, name: made }) => {
      onCreated({ name: made, token });
      setName("");
      setScopes("");
      create.reset();
      await queries.invalidateQueries({ queryKey: ["tokens"] });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  return (
    <form onSubmit={submit} className="stack" aria-label="Create a token">
      <h3>Create a token</h3>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
      </label>
      <label>
        Scopes
        <input
          value={scopes}
          onChange={(e) => setScopes(e.target.value)}
          required
          spellCheck={false}
          placeholder="variable.read project.read"
        />
      </label>
      <p className="muted">
        What the token may do, separated by spaces: an action such as <code>variable.read</code>, a
        family such as <code>variable.*</code>, or <code>*</code> for everything you may do.
      </p>
      <label>
        Lasts
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {LIFETIMES.map((d) => (
            <option key={d} value={d}>
              {d} days
            </option>
          ))}
        </select>
      </label>
      {create.error && (
        <p role="alert" className="error">
          {create.error.message}
        </p>
      )}
      <div className="row">
        <button type="submit" className="primary" disabled={create.isPending}>
          {create.isPending ? "Creating…" : "Create token"}
        </button>
      </div>
    </form>
  );
}

function Row({ token, now }: { token: Token; now: number }) {
  const client = useClient();
  const queries = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: () => call(() => client.tokens({ tokenId: token.id }).delete()),
    onSuccess: async () => {
      setConfirming(false);
      await queries.invalidateQueries({ queryKey: ["tokens"] });
    },
  });
  const state = stateOf(token, now);
  return (
    <tr>
      <th scope="row">{token.name}</th>
      <td>
        <code>{token.prefix}…</code>
      </td>
      <td>
        <code>{token.scopes.join(" ")}</code>
      </td>
      <td>{state}</td>
      <td>
        <time dateTime={stamp(token.expiresAt)}>{when(token.expiresAt)}</time>
      </td>
      <td>
        {token.lastUsedAt ? (
          <time dateTime={stamp(token.lastUsedAt)}>{when(token.lastUsedAt)}</time>
        ) : (
          "Never"
        )}
      </td>
      <td>
        {state === "Active" &&
          (confirming ? (
            <div className="row">
              <button
                type="button"
                className="danger"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate()}
              >
                {revoke.isPending ? "Revoking…" : `Revoke ${token.name}`}
              </button>
              <button
                type="button"
                disabled={revoke.isPending}
                onClick={() => setConfirming(false)}
              >
                Keep
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirming(true)}>
              Revoke…
            </button>
          ))}
        {revoke.error && (
          <p role="alert" className="error">
            {revoke.error.message}
          </p>
        )}
      </td>
    </tr>
  );
}

/** The signed-in person's own API tokens: listed, created (the value shown once) and revoked. */
export function Tokens() {
  const client = useClient();
  const tokens = useQuery({
    queryKey: ["tokens"],
    queryFn: () => allPages((cursor) => client.tokens.get({ query: { limit: 100, cursor } })),
  });
  const [fresh, setFresh] = useState<{ name: string; token: string }>();
  // a token that has just run out is shown as expired on the next look, which is soon enough
  const now = Date.now();
  return (
    <section className="stack" aria-labelledby="tokens-title">
      <h2 id="tokens-title">Your API tokens</h2>
      <p className="muted">
        A token acts as you, limited to its scopes, for the command line and for scripts. It always
        expires. Tokens are yours, not the organization's.
      </p>
      {fresh && <Fresh {...fresh} done={() => setFresh(undefined)} />}
      {tokens.isPending && <Loading what="Loading tokens" />}
      {tokens.error && !tokens.data && (
        <ErrorPanel error={tokens.error} retry={() => void tokens.refetch()} />
      )}
      {tokens.data &&
        (tokens.data.length === 0 ? (
          <p>You have no tokens.</p>
        ) : (
          <table>
            <caption className="visually-hidden">Your API tokens</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Starts with</th>
                <th scope="col">Scopes</th>
                <th scope="col">State</th>
                <th scope="col">Expires</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tokens.data.map((t) => (
                <Row key={t.id} token={t} now={now} />
              ))}
            </tbody>
          </table>
        ))}
      {/* while a token is on show the form is away: a second one would take its place, and the first could not be had again */}
      {!fresh && <CreateToken onCreated={setFresh} />}
    </section>
  );
}
