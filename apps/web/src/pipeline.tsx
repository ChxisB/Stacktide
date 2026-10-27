import type { Client } from "@orch/api-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { Callout, Icon, StatusBadge } from "./components";
import { Delivery, modeName } from "./pipeline-delivery";
import {
  type Applied,
  type Config,
  type Delivery as DeliveryForm,
  deliveryOf,
  initialValues,
  type Line,
  lineDiff,
  type Overview,
  type Param,
  type Preview,
  paramsOf,
  type Request,
  startDelivery,
  type TemplateInfo,
  type Values,
  webUrl,
} from "./pipeline-parts";
import {
  FORGES,
  type Forge,
  lacks,
  type Project,
  ProjectPicker,
  Types,
  useConnections,
} from "./projects";
import { href } from "./router";
import { Loading, when } from "./ui";

const at = (client: Client, orgId: string, projectId: string) =>
  client.organizations({ orgId }).projects({ projectId }).pipeline;

type Step = "detect" | "select" | "params" | "review" | "done";
const STEPS = [
  ["detect", "Detect"],
  ["select", "Template"],
  ["params", "Parameters"],
  ["review", "Review"],
] as const;

const message = (e: unknown) => (e instanceof Error ? e.message : "That did not work.");

function MergeRequest({ iid, url }: { iid: number; url: string | null }) {
  const safe = url ? webUrl(url) : undefined;
  return safe ? (
    <a href={safe} target="_blank" rel="noreferrer">
      merge request !{iid}
    </a>
  ) : (
    <>merge request !{iid}</>
  );
}

function Detect({
  project,
  overview,
  next,
}: {
  project: Project;
  overview: Overview;
  next: () => void;
}) {
  const { config, recommendations } = overview;
  return (
    <section className="stack card" aria-label="Step 1: Detect">
      <h2>What this project is</h2>
      <p>
        Detected: <Types types={project.types} />
      </p>
      {config ? (
        <Callout tone={config.mrIid !== null ? "info" : "ok"}>
          Set up with <strong>{config.template}</strong> {config.version} on{" "}
          {when(config.updatedAt)}.{" "}
          {config.mrIid !== null ? (
            <>
              Proposed in <MergeRequest iid={config.mrIid} url={config.mrUrl} />.
            </>
          ) : (
            <>It is on the default branch.</>
          )}
        </Callout>
      ) : (
        <Callout tone="info">No pipeline has been set up from here yet.</Callout>
      )}
      {recommendations.length > 0 ? (
        <>
          <h3>Suggested templates</h3>
          <ul>
            {recommendations.map((r) => (
              <li key={r.template}>
                <strong>{r.template}</strong> {r.version}: {r.confidence} confidence, because{" "}
                {r.reason}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <Callout tone="info">
          No template is a clear fit for what was detected. You can still choose any of them.
        </Callout>
      )}
      <div className="row">
        <button type="button" className="primary" onClick={next}>
          Choose a template
        </button>
      </div>
    </section>
  );
}

function Select({
  overview,
  chosen,
  choose,
  back,
  next,
}: {
  overview: Overview;
  chosen: string | undefined;
  choose: (name: string) => void;
  back: () => void;
  next: () => void;
}) {
  const { recommendations, templates } = overview;
  const fit = new Map(recommendations.map((r, i) => [r.template, { rank: i, ...r }]));
  // the suggested ones first, in the order of the suggestions
  const sorted = [...templates].sort(
    (a, b) =>
      (fit.get(a.name)?.rank ?? Number.POSITIVE_INFINITY) -
        (fit.get(b.name)?.rank ?? Number.POSITIVE_INFINITY) || a.name.localeCompare(b.name),
  );
  return (
    <section className="stack card" aria-label="Step 2: Template">
      <h2>Choose a template</h2>
      {sorted.length === 0 ? (
        <p>There are no templates to choose from.</p>
      ) : (
        <fieldset className="list cards">
          <legend className="visually-hidden">Template</legend>
          {sorted.map((t) => (
            <label key={t.name} className="item">
              <input
                type="radio"
                name="template"
                checked={chosen === t.name}
                onChange={() => choose(t.name)}
              />
              <span className="stack">
                <span>
                  <strong>{t.name}</strong> {t.version}{" "}
                  {fit.has(t.name) && <StatusBadge tone="ok">Recommended</StatusBadge>}
                </span>
                <span className="muted">{t.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="row">
        <button type="button" onClick={back}>
          Back
        </button>
        <button type="button" className="primary" disabled={!chosen} onClick={next}>
          Next
        </button>
      </div>
    </section>
  );
}

function Field({
  name,
  p,
  required,
  value,
  onChange,
}: {
  name: string;
  p: Param;
  required: boolean;
  value: string | boolean;
  onChange: (value: string | boolean) => void;
}) {
  const id = useId();
  const hint = `${id}-hint`;
  const text = typeof value === "string" ? value : "";
  const hints = [
    p.description,
    required ? "Required." : undefined,
    p.default !== undefined ? `Default: ${String(p.default)}.` : undefined,
  ].filter(Boolean);
  let control: ReactNode;
  if (p.type === "boolean") {
    control = (
      <input
        id={id}
        type="checkbox"
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={hint}
      />
    );
  } else if (p.enum) {
    control = (
      <select
        id={id}
        value={text}
        required={required}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={hint}
      >
        {!required && p.default === undefined && <option value="">Not set</option>}
        {p.enum.map((v) => (
          <option key={String(v)} value={String(v)}>
            {String(v)}
          </option>
        ))}
      </select>
    );
  } else if (p.type === "string") {
    control = (
      <input
        id={id}
        value={text}
        required={required}
        maxLength={p.maxLength}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={hint}
      />
    );
  } else {
    control = (
      <input
        id={id}
        type="number"
        value={text}
        required={required}
        min={p.minimum}
        max={p.maximum}
        step={p.type === "integer" ? 1 : "any"}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={hint}
      />
    );
  }
  return (
    <div className="field">
      <label htmlFor={id}>{name}</label>
      {control}
      <small id={hint} className="muted">
        {hints.join(" ")}
        {p.pattern && (
          <>
            {" "}
            Must match <code>{p.pattern}</code>.
          </>
        )}
      </small>
    </div>
  );
}

function Parameters({
  orgId,
  forge,
  template,
  values,
  set,
  connectionId,
  setConnection,
  delivery,
  setDelivery,
  busy,
  error,
  back,
  submit,
}: {
  orgId: string;
  forge: Forge;
  template: TemplateInfo;
  values: Values;
  set: (name: string, value: string | boolean) => void;
  connectionId: string | undefined;
  setConnection: (id: string) => void;
  delivery: DeliveryForm;
  setDelivery: (next: DeliveryForm) => void;
  busy: boolean;
  error: string | undefined;
  back: () => void;
  submit: () => void;
}) {
  const connections = useConnections(orgId, forge);
  const system = FORGES[forge].name;
  const names = Object.keys(template.params.properties);
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };
  return (
    <form className="stack card" aria-label="Step 3: Parameters" onSubmit={onSubmit}>
      <h2>Parameters for {template.name}</h2>
      <Callout tone="info">
        What you enter is written into the merge request, where everyone who can read the project
        sees it. Do not put a secret here: keep those in variables.
      </Callout>
      <fieldset className="bare stack" disabled={busy}>
        {connections.error ? (
          <ErrorPanel error={connections.error} retry={() => void connections.refetch()} />
        ) : !connections.data ? (
          <Loading what="Loading connections" />
        ) : connections.data.length === 0 ? (
          <Callout tone="warn">
            This organization has no {system} connection yet. <a href={href("projects")}>Add one</a>{" "}
            to create a merge request.
          </Callout>
        ) : (
          <div className="field">
            <label htmlFor="pipeline-connection">{system} connection</label>
            <select
              id="pipeline-connection"
              value={connectionId ?? ""}
              onChange={(e) => setConnection(e.target.value)}
            >
              {connections.data.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <small className="muted">The connection that reaches this project in {system}.</small>
          </div>
        )}
        <Delivery
          orgId={orgId}
          connectionId={connectionId}
          template={template.name}
          value={delivery}
          set={setDelivery}
        />
        {names.length === 0 && <p>This template has no parameters.</p>}
        {names.map((name) => {
          const p = template.params.properties[name];
          return p ? (
            <Field
              key={name}
              name={name}
              p={p}
              required={template.params.required.includes(name)}
              value={values[name] ?? ""}
              onChange={(v) => set(name, v)}
            />
          ) : null;
        })}
      </fieldset>
      {error && <Callout tone="bad">{error}</Callout>}
      <div className="row">
        <button type="button" onClick={back} disabled={busy}>
          Back
        </button>
        <button type="submit" className="primary" disabled={busy || !connectionId}>
          {busy ? "Checking…" : "Preview pipeline"}
        </button>
      </div>
    </form>
  );
}

/** GitLab may say the same thing for two jobs; once is enough. */
const unique = (messages: string[]) => [...new Set(messages)];

const MARK: Record<Line["kind"], string> = { same: "  ", add: "+ ", del: "- " };

function Diff({ before, after, file }: { before: string | null; after: string; file: string }) {
  const lines = lineDiff(before, after);
  const added = lines.filter((l) => l.kind === "add").length;
  const removed = lines.filter((l) => l.kind === "del").length;
  return (
    <figure className="stack changes" aria-label={`Changes to ${file}`}>
      <figcaption>
        {added + removed === 0 ? "No changes." : `${added} added, ${removed} removed.`}
      </figcaption>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a box that scrolls takes the keyboard's focus, or only a pointer can read the rest of a long line */}
      {/* biome-ignore lint/a11y/useSemanticElements: the lines are the pre's own text; a section round it would be one more box */}
      <pre className="diff" role="region" aria-label={`Lines of ${file}`} tabIndex={0}>
        {lines.map((l, i) => (
          // the same line can appear twice; the position is all that tells them apart
          // biome-ignore lint/suspicious/noArrayIndexKey: the list is read only and never reordered
          <span key={i} className={`diff-${l.kind}`}>
            {MARK[l.kind]}
            {l.text}
            {"\n"}
          </span>
        ))}
      </pre>
    </figure>
  );
}

const existingNote = (file: string): Record<Preview["existing"], string> => ({
  none: `The default branch has no ${file}. The merge request adds it.`,
  identical: `The default branch already has exactly this ${file}, so there is nothing to merge. Saving records that the project was set up from this template.`,
  generated: `The default branch has an earlier ${file} generated from a template. The merge request updates it.`,
  "hand-written": `The default branch has a ${file} written by hand. The merge request replaces it. Its content is not shown here: read the diff in the merge request before merging.`,
});

function Review({
  reviewed,
  project,
  config,
  busy,
  error,
  back,
  create,
}: {
  reviewed: { request: Request; preview: Preview };
  project: Project;
  config: Config | null;
  busy: boolean;
  error: string | undefined;
  back: () => void;
  create: () => void;
}) {
  const { request, preview } = reviewed;
  const { lint, missingVariables, violations } = preview.validation;
  const file = FORGES[project.forge].file;
  const unlinted = lacks(project, "ciLint");
  return (
    <section className="stack card" aria-label="Step 4: Review">
      <h2>
        Review {file} from {request.template} {request.version}
      </h2>
      <Callout tone={preview.existing === "hand-written" ? "warn" : "info"}>
        {existingNote(file)[preview.existing]}
      </Callout>
      {request.include && (
        <Callout tone="info">
          The merge request writes a short {file} that{" "}
          {request.mode === "component" ? "uses" : "includes"} {request.template} from{" "}
          <code>{request.include.project}</code>
          {request.include.ref ? ` at ${request.include.ref}` : ""}.
        </Callout>
      )}
      {config && config.mode !== "inline" && !request.mode && (
        <Callout tone="warn">
          This project{" "}
          {config.mode === "component"
            ? "uses its template as a component of"
            : "includes its template from"}{" "}
          another project. Creating this merge request writes the whole pipeline into {file}{" "}
          instead.
        </Callout>
      )}
      {!lint.valid && (
        <section aria-label="Lint errors">
          <Callout tone="bad" title={`${FORGES[project.forge].name}'s lint refuses this pipeline`}>
            <ul>
              {unique(lint.errors).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
            <p>No merge request can be created until the errors are gone. Change the parameters.</p>
          </Callout>
        </section>
      )}
      {violations.length > 0 && (
        <section aria-label="Guardrails">
          <Callout tone="bad" title="This pipeline breaks a guardrail">
            <ul>
              {violations.map((v) => (
                <li key={`${v.rule}:${v.message}`}>
                  {v.rule}: {v.message}
                </li>
              ))}
            </ul>
            <p>
              No merge request can be created until the targets protect their variables: set
              protected to true in the target's config.
            </p>
          </Callout>
        </section>
      )}
      {unlinted && <Callout tone="info">{unlinted}</Callout>}
      {lint.warnings.length > 0 && (
        <section aria-label="Lint warnings">
          <Callout
            tone="warn"
            title={unlinted ? "Notes" : `${FORGES[project.forge].name}'s lint warns`}
          >
            <ul>
              {unique(lint.warnings).map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Callout>
        </section>
      )}
      {missingVariables.length > 0 && (
        <section aria-label="Missing variables">
          <Callout tone="warn" title="Variables the pipeline needs">
            <ul>
              {missingVariables.map((m) => (
                <li key={m.environment ?? "\u0000"}>
                  Not set {m.environment ? `for ${m.environment}` : "for the project"}:{" "}
                  {m.keys.join(", ")}
                </li>
              ))}
            </ul>
            <p>
              The merge request can be created anyway; the pipeline fails until they exist.{" "}
              <a href={href("variables")}>Set them on the Variables page</a>.
            </p>
          </Callout>
        </section>
      )}
      <Diff before={preview.current} after={preview.text} file={file} />
      {error && <Callout tone="bad">{error}</Callout>}
      <div className="row">
        <button type="button" onClick={back} disabled={busy}>
          Back to parameters
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !lint.valid || violations.length > 0}
          onClick={create}
        >
          {busy
            ? "Working…"
            : preview.existing === "identical"
              ? "Save without a merge request"
              : "Create merge request"}
        </button>
      </div>
    </section>
  );
}

const VERB = { opened: "Opened", updated: "Updated", unchanged: "Nothing changed in" } as const;

function Done({ applied, restart }: { applied: Applied; restart: () => void }) {
  const { mr, outcome } = applied;
  return (
    <section className="stack card" aria-label="Result">
      <h2>Done</h2>
      <div role="status">
        <Callout tone="ok">
          {mr && outcome !== "in_place" ? (
            <>
              {VERB[outcome]} <MergeRequest iid={mr.iid} url={mr.url} />.
              {outcome === "updated" && " It is the same merge request as before."}
              {outcome === "unchanged" && " It already has this pipeline."}
            </>
          ) : (
            "The default branch already has this pipeline, so there is nothing to merge. The setup is saved."
          )}
        </Callout>
      </div>
      {mr && <p className="muted">Nothing was written to the default branch.</p>}
      <div className="row">
        <button type="button" onClick={restart}>
          Start over
        </button>
      </div>
    </section>
  );
}

/** The template a wizard starts on: the one the project was set up with, else the surest suggestion. */
const startTemplate = ({ config, recommendations, templates }: Overview) =>
  config && templates.some((t) => t.name === config.template)
    ? config.template
    : recommendations[0]?.template;

function Wizard({
  orgId,
  project,
  overview,
}: {
  orgId: string;
  project: Project;
  overview: Overview;
}) {
  const client = useClient();
  const queries = useQueryClient();
  const connections = useConnections(orgId, project.forge);
  const { config, templates } = overview;
  const start = () => {
    const name = startTemplate(overview);
    const t = templates.find((x) => x.name === name);
    return {
      name,
      values: t ? initialValues(t, config && config.template === name ? config.params : {}) : {},
    };
  };
  const [step, setStep] = useState<Step>("detect");
  const [first] = useState(start);
  const [name, setName] = useState(first.name);
  const [values, setValues] = useState<Values>(first.values);
  const [picked, setConnection] = useState<string>();
  const [delivery, setDelivery] = useState<DeliveryForm>(() => startDelivery(config));
  const [reviewed, setReviewed] = useState<{ request: Request; preview: Preview }>();
  const [applied, setApplied] = useState<Applied>();
  const [busy, setBusy] = useState<"preview" | "apply">();
  const [error, setError] = useState<string>();

  const template = templates.find((t) => t.name === name);
  const known = connections.data ?? [];
  const connectionId =
    known.find((c) => c.id === picked)?.id ??
    known.find((c) => c.id === config?.connectionId)?.id ??
    known[0]?.id;

  const choose = (next: string) => {
    if (next === name) return;
    const t = templates.find((x) => x.name === next);
    setName(next);
    setValues(t ? initialValues(t, config && config.template === next ? config.params : {}) : {});
  };
  const go = (to: Step) => {
    setError(undefined);
    setStep(to);
  };
  const preview = async () => {
    if (!template || !connectionId) return;
    const request: Request = {
      connectionId,
      template: template.name,
      version: template.version,
      params: paramsOf(template, values),
      ...deliveryOf(delivery),
    };
    setBusy("preview");
    setError(undefined);
    try {
      const found = await call(() => at(client, orgId, project.id).preview.post(request));
      setReviewed({ request, preview: found });
      setStep("review");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  };
  const create = async () => {
    if (!reviewed) return;
    setBusy("apply");
    setError(undefined);
    try {
      // what was reviewed is what is sent, whatever the form holds now
      const done = await call(() => at(client, orgId, project.id).post(reviewed.request));
      await queries.invalidateQueries({ queryKey: ["pipeline", orgId, project.id] });
      setApplied(done);
      setStep("done");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  };
  const restart = () => {
    const again = start();
    setName(again.name);
    setValues(again.values);
    setReviewed(undefined);
    setApplied(undefined);
    setDelivery(startDelivery(config));
    go("detect");
  };

  // the steps before this one are done; once the result is shown, all of them are
  const reached = step === "done" ? STEPS.length : STEPS.findIndex(([key]) => key === step);
  // what each finished step settled, said under its name
  const opened = applied?.mr && applied.outcome !== "in_place" ? applied.mr : undefined;
  const settled = [
    project.types.map((t) => t.tag).join(", ") || "none detected",
    template ? `${template.name} ${template.version}` : name,
    modeName(delivery.mode),
    opened ? `!${opened.iid}` : "Saved",
  ];
  return (
    <div className="stack wide">
      <ol className="steps" aria-label="Steps">
        {STEPS.map(([key, label], i) => {
          const done = i < reached;
          return (
            <li
              key={key}
              className={done ? "done" : undefined}
              aria-current={key === step ? "step" : undefined}
            >
              <span className="name">
                {done && <Icon name="success" />}
                {i + 1}. {label}
                {done && <span className="visually-hidden"> (done)</span>}
              </span>
              {done && <span className="cap">{settled[i]}</span>}
            </li>
          );
        })}
      </ol>
      {step === "detect" && (
        <Detect project={project} overview={overview} next={() => go("select")} />
      )}
      {step === "select" && (
        <Select
          overview={overview}
          chosen={name}
          choose={choose}
          back={() => go("detect")}
          next={() => go("params")}
        />
      )}
      {step === "params" && !template && (
        <div className="stack card">
          <Callout tone="bad">The template {name} is no longer offered. Choose another.</Callout>
          <div className="row">
            <button type="button" onClick={() => go("select")}>
              Back
            </button>
          </div>
        </div>
      )}
      {step === "params" && template && (
        <Parameters
          orgId={orgId}
          forge={project.forge}
          template={template}
          values={values}
          set={(n, v) => setValues((old) => ({ ...old, [n]: v }))}
          connectionId={connectionId}
          setConnection={setConnection}
          delivery={delivery}
          setDelivery={setDelivery}
          busy={busy === "preview"}
          error={error}
          back={() => go("select")}
          submit={() => void preview()}
        />
      )}
      {step === "review" && reviewed && (
        <Review
          reviewed={reviewed}
          project={project}
          config={config}
          busy={busy === "apply"}
          error={error}
          back={() => go("params")}
          create={() => void create()}
        />
      )}
      {step === "done" && applied && <Done applied={applied} restart={restart} />}
    </div>
  );
}

function ProjectPipeline({ orgId, project }: { orgId: string; project: Project }) {
  const client = useClient();
  const overview = useQuery({
    queryKey: ["pipeline", orgId, project.id],
    queryFn: (): Promise<Overview> => call(() => at(client, orgId, project.id).get()),
  });
  // a failed look again keeps what was loaded: the wizard may be half way through
  if (!overview.data) {
    return overview.error ? (
      <ErrorPanel error={overview.error} retry={() => void overview.refetch()} />
    ) : (
      <Loading what="Loading pipeline" />
    );
  }
  return <Wizard orgId={orgId} project={project} overview={overview.data} />;
}

/**
 * Sets a project's CI pipeline up from a template: what it is, which template, its parameters, and
 * a review of the file (the diff, GitLab's lint, the variables it needs) before one merge request is
 * created. Nothing is written until the review has been seen, and never to the default branch.
 */
export function PipelinePage({ orgId }: { orgId: string }) {
  return (
    <ProjectPicker orgId={orgId}>
      {(project) => <ProjectPipeline key={project.id} orgId={orgId} project={project} />}
    </ProjectPicker>
  );
}
