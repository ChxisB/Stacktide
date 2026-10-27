import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { allPages, call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import {
  Callout,
  Card,
  Confirm,
  Empty,
  Named,
  StatusBadge,
  type Tone,
  useToast,
} from "./components";
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
type State = "Active" | "Expired" | "Revoked";
const stateOf = (t: Token, now: number): State =>
  t.revokedAt ? "Revoked" : new Date(t.expiresAt).getTime() <= now ? "Expired" : "Active";
const TONE: Record<State, Tone> = { Active: "ok", Expired: "warn", Revoked: "quiet" };

/** A token shown in full: this once, and held only by this component, never by the query cache. */
function Fresh({ name, token, done }: { name: string; token: string; done: () => void }) {
  const [copied, setCopied] = useState<boolean>();
  const field = useRef<HTMLInputElement>(null);
  const said = useId();
  // the form that had the focus is gone: the token has it, selected and ready to copy
  useEffect(() => field.current?.focus(), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section className="fresh-token" aria-label="New token" aria-describedby={said}>
      <p id={said}>
        <strong>Copy the token for {name} now.</strong> It is shown this once: only a fingerprint of
        it is kept, so it cannot be shown again.
      </p>
      <input
        ref={field}
        className="token-value"
        readOnly
        value={token}
        aria-label="Token"
        onFocus={(e) => e.currentTarget.select()}
        spellCheck={false}
      />
      <div className="row middle">
        <button type="button" onClick={() => void copy()}>
          Copy
        </button>
        <button type="button" className="primary" onClick={done}>
          I have copied it
        </button>
        {/* there before its words, so a screen reader hears them */}
        <span role="status" className="muted">
          {copied ? "Copied." : ""}
        </span>
      </div>
      {copied === false && (
        <Callout tone="bad">Could not copy: select the token and copy it.</Callout>
      )}
    </section>
  );
}

function CreateToken({
  onCreated,
  focusName,
}: {
  onCreated: (made: { name: string; token: string }) => void;
  /** The form is back after a token was let go: the next one starts in its first field. */
  focusName: boolean;
}) {
  const client = useClient();
  const queries = useQueryClient();
  const nameField = useRef<HTMLInputElement>(null);
  const scopesId = useId();
  const hintId = useId();
  useEffect(() => {
    if (focusName) nameField.current?.focus();
  }, [focusName]);
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
      <div className="token-form">
        <label>
          Name
          <input
            ref={nameField}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
          />
        </label>
        <div className="field">
          <label htmlFor={scopesId}>Scopes</label>
          <input
            id={scopesId}
            aria-describedby={hintId}
            value={scopes}
            onChange={(e) => setScopes(e.target.value)}
            required
            spellCheck={false}
            placeholder="variable.read project.read"
          />
          <span id={hintId} className="hint">
            What the token may do, separated by spaces: an action such as <code>variable.read</code>
            , a family such as <code>variable.*</code>, or <code>*</code> for everything you may do.
          </span>
        </div>
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
      </div>
      {create.error && <Callout tone="bad">{create.error.message}</Callout>}
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
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: () => call(() => client.tokens({ tokenId: token.id }).delete()),
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: ["tokens"] });
      setConfirming(false);
      toast(`Revoked ${token.name}.`);
    },
  });
  const keep = () => {
    revoke.reset();
    setConfirming(false);
  };
  const state = stateOf(token, now);
  return (
    <tr>
      <th scope="row">{token.name}</th>
      <td>
        <code>{token.prefix}…</code>
      </td>
      <td className="scopes">
        <code>{token.scopes.join(" ")}</code>
      </td>
      <td>
        <StatusBadge tone={TONE[state]}>{state}</StatusBadge>
      </td>
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
        {state === "Active" && (
          <button type="button" className="danger" onClick={() => setConfirming(true)}>
            <Named word="Revoke…" name={token.name} />
          </button>
        )}
        {confirming && (
          <Confirm
            title={`Revoke ${token.name}`}
            warn="Anything using this token stops working at once. This cannot be undone."
            go={`Revoke ${token.name}`}
            busy={revoke.isPending}
            error={revoke.error?.message}
            onConfirm={() => revoke.mutate()}
            close={keep}
          />
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
  // the form came back after a token was let go, not just now with the page
  const [returned, setReturned] = useState(false);
  // a token that has just run out is shown as expired on the next look, which is soon enough
  const now = Date.now();
  return (
    <Card
      title="Your API tokens"
      sub="A token acts as you, limited to its scopes, for the command line and for scripts. It always expires. Tokens are yours, not the organization's."
    >
      {fresh && (
        <Fresh
          {...fresh}
          done={() => {
            setFresh(undefined);
            setReturned(true);
          }}
        />
      )}
      {tokens.isPending && <Loading what="Loading tokens" />}
      {tokens.error && !tokens.data && (
        <ErrorPanel error={tokens.error} retry={() => void tokens.refetch()} />
      )}
      {tokens.data &&
        (tokens.data.length === 0 ? (
          <Empty
            title="You have no tokens"
            text="Create one below to use the command line or a script."
          />
        ) : (
          <div className="scroll">
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
          </div>
        ))}
      {/* while a token is on show the form is away: a second one would take its place, and the first could not be had again */}
      {!fresh && <CreateToken onCreated={setFresh} focusName={returned} />}
    </Card>
  );
}
