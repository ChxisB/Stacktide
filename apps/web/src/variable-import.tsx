import { useRef, useState } from "react";
import { call, useClient } from "./api";
import { AppliesTo, type Env, levelOf, variablesAt } from "./variable-parts";

type Format = "dotenv" | "json";
interface Run {
  dryRun: boolean;
  changes: { change: keyof typeof CHANGE; key: string; kind: string; applied: boolean }[];
  skipped: { reason: string; key?: string | undefined; line?: number | undefined }[];
}

// The API's limit on a text, in characters; a file is held to it in bytes, which is never looser.
// shortcut: pasted text is not checked here (the API answers with its own message), add a check if that proves unclear.
const MAX_BYTES = 1_048_576;

const CHANGE = {
  create: ["New", "Created"],
  update: ["Will change", "Changed"],
  unchanged: ["Same value", "Same value"],
  conflict: ["Exists with a different value (kept)", "Exists with a different value (kept)"],
  kind_mismatch: ["Exists as a different kind (kept)", "Exists as a different kind (kept)"],
} as const;
const SKIPPED: Record<string, string> = {
  syntax: "not a NAME=value line",
  bad_key: "the name is not allowed",
  bad_value: "the value is too large or not text",
  unclosed_quote: "a quote is never closed",
  duplicate: "the name appears more than once (the last one counts)",
};

/**
 * Variables from a pasted or uploaded `.env` or JSON text. Nothing is written until the preview of
 * the same text and options has been seen; the preview names keys and what would happen to each,
 * never a value. The text lives in this component only, and is dropped once it has been applied.
 */
export function Import({
  orgId,
  projectId,
  envs,
  reload,
  close,
}: {
  orgId: string;
  projectId: string;
  envs: Env[];
  reload: () => Promise<void>;
  close: () => void;
}) {
  const client = useClient();
  const [format, setFormat] = useState<Format>("dotenv");
  const [kind, setKind] = useState<"secret" | "plain">("secret");
  const [scope, setScope] = useState("project");
  const [overwrite, setOverwrite] = useState(false);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState<"preview" | "apply">();
  const [error, setError] = useState<string>();
  const [shown, setShown] = useState<Run>();
  // a reply to an earlier text must not be taken for this one
  const edits = useRef(0);

  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      edits.current += 1;
      set(value);
      setShown(undefined);
      setError(undefined);
    };

  const send = async (dryRun: boolean) => {
    const seen = edits.current;
    setBusy(dryRun ? "preview" : "apply");
    setError(undefined);
    try {
      const result = await call(() =>
        variablesAt(client, orgId, projectId, levelOf(scope), scope).import.post({
          source: format,
          content,
          kind,
          overwrite,
          dryRun,
        }),
      );
      if (seen !== edits.current) return;
      if (!dryRun) {
        setContent("");
        // the grid is fresh before the summary appears, so neither tells the other's story
        await reload();
      }
      setShown(result);
    } catch (e) {
      if (seen === edits.current) setError(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(undefined);
    }
  };

  const choose = async (file: File | undefined) => {
    if (!file) return;
    // what was typed or pasted stays when a file is refused
    if (file.size > MAX_BYTES) {
      setError("That file is larger than 1 MiB.");
      return;
    }
    try {
      const text = await file.text();
      edit(setFormat)(file.name.toLowerCase().endsWith(".json") ? "json" : "dotenv");
      setContent(text);
    } catch {
      setError("That file could not be read.");
    }
  };

  const pending = shown?.dryRun === true;
  const worth = shown?.changes.some((c) => c.change === "create" || c.change === "update");
  const count = (what: string) => shown?.changes.filter((c) => c.change === what).length ?? 0;
  return (
    <form
      className="stack card"
      aria-label="Import variables"
      onSubmit={(e) => {
        e.preventDefault();
        void send(true);
      }}
    >
      <h2>Import variables</h2>
      <p className="muted">
        Paste a <code>.env</code> file or JSON, or choose a file. You see what would happen to each
        name before anything is saved.
      </p>
      {/* nothing can be changed while an import is being saved: the text, the options and the file are what is being written */}
      <fieldset className="bare stack" disabled={busy === "apply"}>
        <label>
          Format
          <select value={format} onChange={(e) => edit(setFormat)(e.target.value as Format)}>
            <option value="dotenv">.env (NAME=value lines)</option>
            <option value="json">JSON ({'{"NAME": "value"}'})</option>
          </select>
        </label>
        <label>
          Kind of every value
          <select
            value={kind}
            onChange={(e) => edit(setKind)(e.target.value as "secret" | "plain")}
          >
            <option value="secret">Secret (masked, shown only on request)</option>
            <option value="plain">Plain (shown to everyone who can see the project)</option>
          </select>
        </label>
        <AppliesTo envs={envs} value={scope} onChange={edit(setScope)} />
        <label>
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(e) => edit(setOverwrite)(e.target.checked)}
          />{" "}
          Replace values that differ
        </label>
        <label>
          Text to import
          <textarea
            value={content}
            onChange={(e) => edit(setContent)(e.target.value)}
            rows={8}
            spellCheck={false}
            autoComplete="off"
            required
          />
        </label>
        <label>
          Or choose a file
          <input
            type="file"
            accept=".env,.json,text/plain,application/json"
            onChange={(e) => {
              void choose(e.target.files?.[0]);
              // the same file chosen again must be read again
              e.target.value = "";
            }}
          />
        </label>
      </fieldset>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {shown && (
        <div className="stack" role="status" aria-label="Import result">
          <h3>{pending ? "Preview" : "Imported"}</h3>
          {pending ? (
            <p>Nothing has been saved yet.</p>
          ) : (
            <p>
              {count("create")} created, {count("update")} changed, {count("unchanged")} the same,{" "}
              {count("conflict") + count("kind_mismatch")} kept.
            </p>
          )}
          {shown.changes.length > 0 && (
            <table>
              <caption className="visually-hidden">What happens to each name</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {shown.changes.map((c) => (
                  <tr key={c.key}>
                    <th scope="row">
                      <code>{c.key}</code>
                    </th>
                    <td>{c.kind}</td>
                    <td>{CHANGE[c.change][pending ? 0 : 1]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {shown.skipped.length > 0 && (
            <>
              <h4>Left out</h4>
              <ul>
                {shown.skipped.map((s, i) => (
                  // a line can be reported more than once; the position is all that tells them apart
                  // biome-ignore lint/suspicious/noArrayIndexKey: the list is read only and never reordered
                  <li key={i}>
                    {s.line ? `Line ${s.line}` : "Entry"}
                    {s.key ? (
                      <>
                        {" "}
                        (<code>{s.key}</code>)
                      </>
                    ) : null}
                    : {SKIPPED[s.reason] ?? s.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
          {pending && !worth && <p>Nothing would change.</p>}
        </div>
      )}
      <div className="row">
        <button type="submit" disabled={busy !== undefined || content === ""}>
          {busy === "preview" ? "Checking…" : "Preview"}
        </button>
        {pending && worth && (
          <button
            type="button"
            className="primary"
            disabled={busy !== undefined}
            onClick={() => void send(false)}
          >
            {busy === "apply" ? "Saving…" : "Apply import"}
          </button>
        )}
        <button type="button" onClick={close}>
          {shown && !pending ? "Close" : "Cancel"}
        </button>
      </div>
    </form>
  );
}
