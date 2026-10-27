import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { call, useClient } from "./api";
import type { Delivery as Form, Mode, Registry } from "./pipeline-parts";
import { Loading } from "./ui";

const MODES: [Mode, string, string][] = [
  ["inline", "Inline", "The whole pipeline is written into the file. Nothing else to maintain."],
  [
    "include",
    "Include",
    "The file includes the template from a templates project, which can change it later.",
  ],
  [
    "component",
    "Component",
    "The file uses the template as a CI/CD component of a catalog project, at a release you choose.",
  ],
];

/** What a mode is called on its card, and in the stepper once it is chosen. */
export const modeName = (mode: Mode) => MODES.find(([m]) => m === mode)?.[1] ?? mode;

/** What the catalog project publishes, read when asked: it uses the connection to read another repository. */
function Releases({
  orgId,
  connectionId,
  project,
  template,
  pick,
}: {
  orgId: string;
  connectionId: string | undefined;
  project: string;
  template: string;
  pick: (release: string) => void;
}) {
  const client = useClient();
  const id = useId();
  // the project looked up is the one asked for, not the one being typed
  const [asked, setAsked] = useState<string>();
  const registry = useQuery({
    queryKey: ["template-registry", orgId, connectionId, asked],
    enabled: asked !== undefined && connectionId !== undefined,
    retry: false,
    queryFn: (): Promise<Registry> =>
      call(() =>
        client.organizations({ orgId })["template-registry"].get({
          query: { project: asked ?? "", connectionId: connectionId ?? "" },
        }),
      ),
  });
  // what was found is for `asked`: once the field says something else it is not an answer to it
  const current = asked !== undefined && asked === project.trim();
  const found = current ? registry.data : undefined;
  return (
    <div className="stack">
      <div className="row">
        <button
          type="button"
          disabled={!project.trim() || !connectionId || registry.isFetching}
          onClick={() => {
            setAsked(project.trim());
            if (asked === project.trim()) void registry.refetch();
          }}
        >
          Look up releases
        </button>
      </div>
      {current && registry.isFetching && <Loading what="Looking up releases" />}
      {current && !registry.isFetching && registry.error && (
        <p role="alert" className="error">
          {registry.error instanceof Error ? registry.error.message : "That did not work."} You can
          still type a release.
        </p>
      )}
      {found && found.releases.length === 0 && (
        <p role="status" className="warn">
          This project has no releases yet. A component needs one: tag a release such as 1.0.0 in
          GitLab, then look up again.
        </p>
      )}
      {found && found.releases.length > 0 && (
        <div className="field">
          <label htmlFor={id}>
            Releases of{" "}
            {found.releases.length === 1 ? "this project" : "this project, newest first"}
          </label>
          <select id={id} value="" onChange={(e) => e.target.value && pick(e.target.value)}>
            <option value="">Pick a release</option>
            {found.releases.map((r) => (
              <option key={r} value={r}>
                {r}
                {r === found.latest ? " (latest)" : ""}
              </option>
            ))}
          </select>
        </div>
      )}
      {found && found.releases.length > 0 && !found.components.some((c) => c.name === template) && (
        <p role="status" className="warn">
          This project publishes no component called {template}, so GitLab's lint will refuse the
          pipeline.
        </p>
      )}
    </div>
  );
}

/** The mode selector of the parameters step, and for include and component the project and the release. */
export function Delivery({
  orgId,
  connectionId,
  template,
  value,
  set,
}: {
  orgId: string;
  connectionId: string | undefined;
  template: string;
  value: Form;
  set: (next: Form) => void;
}) {
  const project = useId();
  const ref = useId();
  const catalog = value.mode === "component";
  return (
    <>
      <fieldset className="list cards">
        <legend className="visually-hidden">How the pipeline is delivered</legend>
        {MODES.map(([mode, label, hint]) => (
          <label key={mode} className="item">
            <input
              type="radio"
              name="delivery"
              checked={value.mode === mode}
              onChange={() => set({ ...value, mode })}
            />
            <span className="stack">
              <strong>{label}</strong>
              <span className="muted">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {value.mode !== "inline" && (
        <>
          <div className="field">
            <label htmlFor={project}>{catalog ? "Catalog project" : "Templates project"}</label>
            <input
              id={project}
              value={value.project}
              required
              maxLength={255}
              autoComplete="off"
              spellCheck={false}
              placeholder="group/ci-templates"
              onChange={(e) => set({ ...value, project: e.target.value })}
            />
            <small className="muted">
              The path of the GitLab project that holds the templates. It must be on the same GitLab
              as this project.
            </small>
          </div>
          <div className="field">
            <label htmlFor={ref}>{catalog ? "Release" : "Ref (optional)"}</label>
            <input
              id={ref}
              value={value.ref}
              required={catalog}
              maxLength={100}
              autoComplete="off"
              spellCheck={false}
              placeholder={catalog ? "1.0.0" : "main"}
              onChange={(e) => set({ ...value, ref: e.target.value })}
            />
            <small className="muted">
              {catalog
                ? "A release such as 1.2.3, a partial one (1.2 or 1, which follows the newest match) or a commit SHA. A branch or ~latest is refused."
                : "A tag, branch or commit. Leave it empty for the default branch."}
            </small>
          </div>
          {catalog && (
            <Releases
              orgId={orgId}
              connectionId={connectionId}
              project={value.project}
              template={template}
              pick={(release) => set({ ...value, ref: release })}
            />
          )}
        </>
      )}
    </>
  );
}
