import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { allPages, call, useClient } from "./api";
import { ErrorPanel } from "./auth";
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
  if (versions.data.length === 0) return <p>No state for {stack} in this project.</p>;
  return (
    <>
      <table>
        <caption>State versions</caption>
        <thead>
          <tr>
            <th scope="col">Serial</th>
            <th scope="col">Written</th>
            <th scope="col">Size</th>
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
              <td>{v.sizeBytes} bytes</td>
              <td>
                <code>{v.createdBy}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {resources.error ? (
        <ErrorPanel error={resources.error} retry={() => void resources.refetch()} />
      ) : !resources.data ? (
        <Loading what="Loading resources" />
      ) : resources.data.length === 0 ? (
        <p>The newest version holds no resources.</p>
      ) : (
        <table>
          <caption>Resources in the newest version</caption>
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
      )}
    </>
  );
}

function Look({ orgId, projectId }: { orgId: string; projectId: string }) {
  const [draft, setDraft] = useState("");
  const [stack, setStack] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setStack(draft);
  };
  return (
    <div className="stack">
      <p className="muted">
        What the platform holds for a stack, by name: who wrote each version and the resources in
        the newest one. Never the state itself: outputs and attribute values are not shown, and
        nothing here changes it. The newest 20 versions are kept.
      </p>
      <form className="row" onSubmit={submit}>
        <label>
          Stack
          <input value={draft} maxLength={63} onChange={(e) => setDraft(e.target.value)} />
        </label>
        <button type="submit" disabled={!STACK.test(draft)}>
          Show state
        </button>
      </form>
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
