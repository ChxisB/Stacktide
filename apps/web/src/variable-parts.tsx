import type { Client } from "@orch/api-client";
import type { VariableKind, VariableLevel } from "@orch/core";
import { ROOT } from "@orch/core/folders";
import { MAX_TAG, MAX_TAGS, parseTags, TAG_PATTERN } from "@orch/core/tags";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ApiError, call, useClient } from "./api";
import { useInDrawer } from "./components";

// What the variables screens share: the shapes, the route for a level, the form and the write hook.

export type Level = VariableLevel;
export type Kind = VariableKind;

export interface Env {
  id: string;
  name: string;
  slug: string;
  /** Its variables change only through a change request: the environments list says so. */
  protected?: boolean;
}

/** What an environment sees of one key: the variable that wins there, never a secret's value. */
export interface Cell {
  id: string;
  level: Level;
  key: string;
  kind: Kind;
  tainted: boolean;
  tags: string[];
  value: string | null;
}

/** What a value is called when it is a column heading or a tag. */
export const LEVEL_NAME: Record<Level, string> = {
  organization: "Organization",
  project: "Project",
  environment: "Environment",
};
export const MASK = "••••••••";

export const SOURCE: Record<Level, string> = {
  organization: "the organization",
  project: "the project",
  environment: "this environment",
};
/** The level an "Applies to" choice means: a project, the organization, or else an environment's id. */
export const levelOf = (scope: string): Level =>
  scope === "project" || scope === "organization" ? scope : "environment";

/** The variables of one level; the three levels answer alike, so the screen treats them alike. */
export function variablesAt(
  client: Client,
  orgId: string,
  projectId: string,
  level: Level,
  envId: string | undefined,
) {
  const org = client.organizations({ orgId });
  if (level === "organization") return org.variables;
  const project = org.projects({ projectId });
  if (level === "project") return project.variables;
  if (!envId) throw new Error("An environment is needed for a value that applies to one.");
  return project.environments({ envId }).variables;
}

/** A secret's or file's value (or an earlier version's), read on request (the API audits every read). */
export async function readValue(
  client: Client,
  orgId: string,
  projectId: string,
  cell: Cell,
  env: Env,
  version?: number,
) {
  const read = await call(() =>
    variablesAt(
      client,
      orgId,
      projectId,
      cell.level,
      env.id,
    )({ varId: cell.id }).value.get({
      query: version === undefined ? {} : { version },
    }),
  );
  return read.value;
}

/** How long "Copied" stays on the screen. */
export const COPIED_MS = 3000;

/** A value onto the clipboard, never into the page: undefined when it got there, else what to tell the person. */
export async function toClipboard(read: () => Promise<string>): Promise<string | undefined> {
  let text: string;
  try {
    text = await read();
  } catch (e) {
    return e instanceof ApiError && e.status === 403
      ? "You cannot reveal values here"
      : e instanceof Error
        ? e.message
        : "Could not read the value.";
  }
  try {
    if (!navigator.clipboard) throw new Error();
    await navigator.clipboard.writeText(text);
  } catch (e) {
    return `Could not copy the value${e instanceof Error && e.message ? `: ${e.message}` : "."}`;
  }
  return undefined;
}

export function Form({
  title,
  onSubmit,
  error,
  pending,
  submit,
  onCancel,
  disabled,
  children,
}: {
  title: string;
  onSubmit: () => void;
  error: string | undefined;
  pending: boolean;
  submit: string;
  onCancel: () => void;
  /** Nothing to send yet: the submit button waits, and does not say Saving. */
  disabled?: boolean;
  children?: ReactNode;
}) {
  const inDrawer = useInDrawer();
  const send = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <form onSubmit={send} className="stack card" aria-label={title}>
      {!inDrawer && <h2>{title}</h2>}
      {children}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="drawer-foot">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={pending || disabled}>
          {pending ? "Saving…" : submit}
        </button>
      </div>
    </form>
  );
}

/** Runs a write, says why it failed, and does not keep what was typed once it worked. */
export function useWrite(run: () => Promise<unknown>, done: () => Promise<void>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const go = async () => {
    setPending(true);
    setError(undefined);
    try {
      await run();
      await done();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setPending(false);
    }
  };
  return { go, pending, error, clear: () => setError(undefined) };
}

/** What a request adds to be in a folder: nothing at the root, so a request there is as it was before folders. */
export const inFolder = (folder: string) => (folder === ROOT ? {} : { folder });

/** The folder a variable is in, for a panel about it: nothing at the root, where every variable was before folders. */
export const InFolder = ({ folder }: { folder: string }) =>
  folder === ROOT ? null : (
    <p className="muted">
      In folder <code>{folder}</code>
    </p>
  );

/** The key a variable may have: the form's own pattern, so the row and the form agree. */
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;

/**
 * A last row for a quick secret: a name and a value, and Enter makes it in the open environment, or in each one
 * shown, one create each, stopping at the first refusal (what was made stays, and a retry makes only the rest). A
 * secret, because nothing is made readable on a guess; another kind or another level is the Add a variable form's.
 */
export function QuickAdd({
  orgId,
  projectId,
  envs,
  folder,
  done,
}: {
  orgId: string;
  projectId: string;
  envs: Env[];
  /** The folder the secret is made in. */
  folder: string;
  done: () => Promise<void>;
}) {
  const client = useClient();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string>();
  const nameBox = useRef<HTMLInputElement>(null);
  const valueBox = useRef<HTMLInputElement>(null);
  // the environments still to make it in, after one was refused
  const [rest, setRest] = useState<string[]>();
  const targets = rest ? envs.filter((e) => rest.includes(e.id)) : envs;
  const many = envs.length > 1;
  const write = useWrite(
    async () => {
      for (const [i, env] of targets.entries()) {
        try {
          await call(() =>
            variablesAt(client, orgId, projectId, "environment", env.id).post({
              key,
              kind: "secret",
              value,
              ...inFolder(folder),
            }),
          );
        } catch (e) {
          // the first refused: nothing new was made, so the row is as it was
          if (i === 0) throw e;
          const made = targets.slice(0, i).map((x) => x.name);
          setRest(targets.slice(i).map((x) => x.id));
          await done();
          throw new Error(
            `${made.join(", ")} ${made.length === 1 ? "was" : "were"} created; ${env.name} was not: ${e instanceof Error ? e.message : "that did not work."}`,
          );
        }
      }
    },
    async () => {
      setRest(undefined);
      setKey("");
      setValue("");
      await done();
      nameBox.current?.focus();
    },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (write.pending) return;
    setProblem(undefined);
    if (!KEY.test(key)) {
      setProblem(
        "A name starts with a letter or an underscore, then holds letters, digits and underscores",
      );
      nameBox.current?.focus();
    } else if (!value) valueBox.current?.focus();
    else void write.go();
  };
  const error = problem ?? write.error;
  return (
    <>
      <form className="quick-add" aria-label="Quick add" onSubmit={submit}>
        <input
          ref={nameBox}
          aria-label="Add a variable name"
          placeholder="Add a variable name"
          value={key}
          onChange={(e) => {
            // another name is another variable: nothing is left over from the one that was half made
            setRest(undefined);
            setKey(e.target.value);
          }}
          maxLength={255}
          autoComplete="off"
          spellCheck={false}
        />
        <input
          ref={valueBox}
          type="password"
          aria-label={many ? "Add a variable value (applies to all)" : "Add a variable value"}
          placeholder={many ? "Value (applies to all)" : "Value"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" disabled={write.pending}>
          Add
        </button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </>
  );
}

/** A random value for a new secret: 32 URL-safe characters (192 bits from the browser's own generator), sent nowhere until the form is. */
export function generate(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  // 24 bytes are 32 base64 characters with no padding; the two that a URL or a shell would trip on are swapped
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** A value box that fits its kind: a secret is typed masked, a file or a plain value can be several lines. With `onGenerate`, a button beside it makes a value. */
export function ValueField({
  kind,
  value,
  onChange,
  label,
  onGenerate,
}: {
  kind: Kind;
  value: string;
  onChange: (value: string) => void;
  label: string;
  onGenerate?: () => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="with-action">
        {kind === "secret" ? (
          <input
            id={id}
            type="password"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
        ) : (
          <textarea
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={3}
            spellCheck={false}
            // a plain value may be empty (a flag set to nothing); a masked one cannot be
            required={kind !== "plain"}
          />
        )}
        {onGenerate && (
          <button type="button" onClick={onGenerate}>
            Generate
          </button>
        )}
      </div>
      <p className="muted">
        <code>{`\${KEY}`}</code> reads a variable of this folder, <code>{`\${/folder/KEY}`}</code>{" "}
        one of another folder.
      </p>
    </div>
  );
}

/** The tags a form's text holds, or an error that names the one that is not a tag: the API refuses the same, but only says the request was invalid. */
export function formTags(text: string): string[] {
  const tags = parseTags(text);
  if (tags.length > MAX_TAGS) throw new Error(`At most ${MAX_TAGS} tags`);
  const bad = tags.find((t) => !TAG_PATTERN.test(t));
  if (bad !== undefined) {
    throw new Error(
      `Tag “${bad}” may hold lower-case letters, digits and hyphens, up to ${MAX_TAG} characters`,
    );
  }
  return tags;
}

/** Tags typed as text, comma or space separated. */
export function TagsField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="backend, eu"
        autoComplete="off"
        spellCheck={false}
      />
    </label>
  );
}

/** Where a value applies: the whole project, one environment, or the organization. */
export function AppliesTo({
  envs,
  value,
  onChange,
  organization = true,
}: {
  envs: Env[];
  value: string;
  onChange: (value: string) => void;
  /** An organization's variables sit at the root, so inside a folder the choice is not there. */
  organization?: boolean;
}) {
  return (
    <label>
      Applies to
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="project">Every environment of this project</option>
        {envs.map((e) => (
          <option key={e.id} value={e.id}>
            Only {e.name}
          </option>
        ))}
        {organization && <option value="organization">Every project of the organization</option>}
      </select>
    </label>
  );
}

/** A value that is not shown: a fixed mask, whatever the value, and words for assistive technology. */
export const Hidden = () => (
  <>
    <span className="mask" aria-hidden="true">
      {MASK}
    </span>
    <span className="visually-hidden">Hidden value</span>
  </>
);

/** A secret's value on request: audited by the API, held by the caller only, and hidden again after `ms`. */
export function useReveal(fetchValue: () => Promise<string>, ms: number) {
  const [shown, setShown] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (shown === undefined) return;
    const timer = setTimeout(() => setShown(undefined), ms);
    return () => clearTimeout(timer);
  }, [shown, ms]);
  const show = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setShown(await fetchValue());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the value.");
    } finally {
      setBusy(false);
    }
  };
  return { shown, busy, error, show, hide: () => setShown(undefined) };
}

export function Reveal({
  fetchValue,
  ms,
  label,
}: {
  fetchValue: () => Promise<string>;
  ms: number;
  label: string;
}) {
  const { shown, busy, error, show, hide } = useReveal(fetchValue, ms);
  return (
    <>
      {shown === undefined ? <Hidden /> : <code className="revealed">{shown}</code>}
      {shown === undefined ? (
        <button
          type="button"
          className="small"
          disabled={busy}
          onClick={show}
          aria-label={`Reveal ${label}`}
        >
          Reveal
        </button>
      ) : (
        <button type="button" className="small" onClick={hide} aria-label={`Hide ${label}`}>
          Hide
        </button>
      )}
      {error && (
        <span role="alert" className="error">
          {error}
        </span>
      )}
    </>
  );
}
