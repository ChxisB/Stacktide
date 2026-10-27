import { useIsFetching, useQuery } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { allPages, call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { Callout, Card, Empty, Icon } from "./components";
import { ProjectPicker } from "./projects";
import { Loading, stamp, when } from "./ui";

// the same shape the API and the table hold a stack name to
const STACK = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

interface Version {
  serial: number;
  sizeBytes: number;
  createdBy: string;
  createdAt: string | Date;
}
interface Resource {
  address: string;
  type: string;
  provider: string;
  module: string | null;
}

function Stack({ orgId, projectId, stack }: { orgId: string; projectId: string; stack: string }) {
  const client = useClient();
  const at = client.organizations({ orgId }).projects({ projectId }).state({ stack });
  const versions = useQuery({
    queryKey: ["state-versions", orgId, projectId, stack],
    queryFn: (): Promise<Version[]> => call(() => at.versions.get()),
  });
  const resources = useQuery({
    queryKey: ["state-resources", orgId, projectId, stack],
    queryFn: (): Promise<Resource[]> =>
      allPages((cursor) => at.resources.get({ query: { limit: 100, cursor } })),
  });

  if (versions.error)
    return <ErrorPanel error={versions.error} retry={() => void versions.refetch()} />;
  if (!versions.data) return <Loading what="Loading state" />;
  if (versions.data.length === 0)
    return (
      <Card title="State versions">
        <Empty
          title={`No state for ${stack}`}
          text="Nothing is stored under that name in this project. Check the spelling of the stack."
        />
      </Card>
    );
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  return (
    <>
      <Card
        title="State versions"
        sub={`${count(versions.data.length, "version")} of ${stack}, newest first.`}
      >
        <table>
          <caption className="visually-hidden">State versions</caption>
          <thead>
            <tr>
              <th scope="col">Serial</th>
              <th scope="col">Written</th>
              <th scope="col" className="num">
                Size
              </th>
              <th scope="col">By</th>
            </tr>
          </thead>
          <tbody>
            {versions.data.map((v) => (
              <tr key={v.serial}>
                <th scope="row">{v.serial}</th>
                <td>
                  <time dateTime={stamp(v.createdAt)}>{when(v.createdAt)}</time>
                </td>
                <td className="num">{v.sizeBytes} bytes</td>
                <td>
                  <code>{v.createdBy}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {resources.error ? (
        <ErrorPanel error={resources.error} retry={() => void resources.refetch()} />
      ) : !resources.data ? (
        <Loading what="Loading resources" />
      ) : resources.data.length === 0 ? (
        <Card title="Resources in the newest version">
          <Empty
            title="The newest version holds no resources"
            text="A stack with no resources has nothing to list here."
          />
        </Card>
      ) : (
        <Card
          title="Resources in the newest version"
          sub={`${count(resources.data.length, "resource")} in version ${versions.data[0]?.serial}.`}
        >
          <table>
            <caption className="visually-hidden">Resources in the newest version</caption>
            <thead>
              <tr>
                <th scope="col">Address</th>
                <th scope="col">Type</th>
                <th scope="col">Provider</th>
                <th scope="col">Module</th>
              </tr>
            </thead>
            <tbody>
              {resources.data.map((r) => (
                <tr key={r.address}>
                  <th scope="row">
                    <code>{r.address}</code>
                  </th>
                  <td>{r.type}</td>
                  <td>
                    <code>{r.provider}</code>
                  </td>
                  <td>{r.module ?? "root"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function Look({ orgId, projectId }: { orgId: string; projectId: string }) {
  const [draft, setDraft] = useState("");
  const [stack, setStack] = useState<string>();
  const id = useId();
  const reading = useIsFetching({ queryKey: ["state-versions", orgId, projectId] }) > 0;
  const invalid = draft !== "" && !STACK.test(draft);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!reading && STACK.test(draft)) setStack(draft);
  };
  return (
    <div className="stack wide">
      <Card
        title="Look up a stack"
        sub="What the platform holds for a stack, by name: who wrote each version and the resources in the newest one."
      >
        <form className="stack" onSubmit={submit}>
          <div className="field">
            <label htmlFor={id}>Stack</label>
            <div className="row">
              <input
                id={id}
                value={draft}
                maxLength={63}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={invalid || undefined}
                aria-describedby={`${id}-line`}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button
                type="submit"
                className="primary"
                aria-busy={reading || undefined}
                disabled={!STACK.test(draft) || reading}
              >
                {reading ? "Reading…" : "Show state"}
              </button>
            </div>
            {invalid ? (
              <span className="error" id={`${id}-line`}>
                <Icon name="error" />
                Use lowercase letters, digits and dashes. Start and end with a letter or digit.
              </span>
            ) : (
              <span className="hint" id={`${id}-line`}>
                Lowercase letters, digits and dashes, up to 63 characters.
              </span>
            )}
          </div>
          <Callout tone="info">
            Never the state itself: outputs and attribute values are not shown, and nothing here
            changes it. The newest 20 versions are kept.
          </Callout>
        </form>
      </Card>
      {stack && <Stack orgId={orgId} projectId={projectId} stack={stack} />}
    </div>
  );
}

/** The Terraform state the platform keeps (STATE-10): versions and resource names of one stack, read-only. */
export function StatePage({ orgId }: { orgId: string }) {
  return (
    <ProjectPicker orgId={orgId}>
      {(project) => <Look key={project.id} orgId={orgId} projectId={project.id} />}
    </ProjectPicker>
  );
}
