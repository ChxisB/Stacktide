import type { Client } from "@orch/api-client";
import type { VariableKind, VariableLevel } from "@orch/core";
import { type FormEvent, type ReactNode, useId, useState } from "react";

// What the variables screens share: the shapes, the route for a level, the form and the write hook.

export type Level = VariableLevel;
export type Kind = VariableKind;

export interface Env {
  id: string;
  name: string;
  slug: string;
}

/** What an environment sees of one key: the variable that wins there, never a secret's value. */
export interface Cell {
  id: string;
  level: Level;
  key: string;
  kind: Kind;
  tainted: boolean;
  value: string | null;
}

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

export function Form({
  title,
  onSubmit,
  error,
  pending,
  submit,
  onCancel,
  children,
}: {
  title: string;
  onSubmit: () => void;
  error: string | undefined;
  pending: boolean;
  submit: string;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const send = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <form onSubmit={send} className="stack card" aria-label={title}>
      <h2>{title}</h2>
      {children}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit" className="primary" disabled={pending}>
          {pending ? "Saving…" : submit}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
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
  return { go, pending, error };
}

/** A value box that fits its kind: a secret is typed masked, a file or a plain value can be several lines. */
export function ValueField({
  kind,
  value,
  onChange,
  label,
}: {
  kind: Kind;
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
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
    </div>
  );
}

/** Where a value applies: the whole project, one environment, or the organization. */
export function AppliesTo({
  envs,
  value,
  onChange,
}: {
  envs: Env[];
  value: string;
  onChange: (value: string) => void;
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
        <option value="organization">Every project of the organization</option>
      </select>
    </label>
  );
}
