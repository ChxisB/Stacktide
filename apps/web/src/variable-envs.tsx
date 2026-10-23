import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { call, useClient } from "./api";
import { Drawer, Popover } from "./components";
import { type Env, Form, useWrite } from "./variable-parts";

// The environments a project's variables are shown for: a menu of checkboxes, and the dialog that makes another.

/** What an environment is called in a URL and a pipeline: lower case, letters and digits joined by one dash. */
const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** What the menu holds; it is its own component so that a closed menu forgets what was typed in its filter. */
function Choices({
  envs,
  selected,
  choose,
  add,
}: {
  envs: Env[];
  selected: Env[];
  choose: (next: Env[]) => void;
  add: () => void;
}) {
  const [find, setFind] = useState("");
  const ticked = new Set(selected.map((e) => e.id));
  const all = ticked.size === envs.length;
  const text = find.trim().toLowerCase();
  const matching = envs.filter((e) => e.name.toLowerCase().includes(text));
  // the environments' own order, whichever was ticked first; the last one ticked is disabled, so there is never none
  const toggle = (env: Env) => choose(envs.filter((e) => ticked.has(e.id) !== (e.id === env.id)));
  return (
    <div className="env-menu">
      <input
        type="search"
        aria-label="Filter environments"
        placeholder="Filter environments"
        value={find}
        onChange={(e) => setFind(e.target.value)}
      />
      <label className="tick">
        <input
          type="checkbox"
          checked={all}
          disabled={envs.length === 1}
          onChange={() => choose(all ? envs.slice(0, 1) : envs)}
        />
        All environments
      </label>
      {matching.map((e) => (
        <label key={e.id} className="tick">
          <input
            type="checkbox"
            checked={ticked.has(e.id)}
            disabled={ticked.size === 1 && ticked.has(e.id)}
            onChange={() => toggle(e)}
          />
          {e.name}
        </label>
      ))}
      {matching.length === 0 && <p className="hint">No environment matches.</p>}
      <button type="button" className="quiet" onClick={add}>
        <span aria-hidden="true">+ </span>Add environment
      </button>
      <p className="hint">Use the checkboxes to select multiple environments.</p>
    </div>
  );
}

/** One environment's list, or the matrix of several: `selected` is what is ticked, `choose` gets the new set, `add` opens the dialog. */
export function EnvMenu(props: {
  envs: Env[];
  selected: Env[];
  choose: (next: Env[]) => void;
  add: () => void;
}) {
  const everything = props.selected.length === props.envs.length && props.envs.length > 1;
  return (
    <Popover
      label="Environment"
      shown={everything ? "All environments" : props.selected.map((e) => e.name).join(", ")}
    >
      {(close) => (
        <Choices
          {...props}
          add={() => {
            // closed first, with the focus on the button, so that is what the dialog gives it back to
            close();
            props.add();
          }}
        />
      )}
    </Popover>
  );
}

/** The form that makes an environment, in a dialog: the name decides the slug, and a name that leaves none is not sent. */
export function AddEnvironment({
  orgId,
  projectId,
  close,
}: {
  orgId: string;
  projectId: string;
  close: () => void;
}) {
  const client = useClient();
  const queries = useQueryClient();
  const [name, setName] = useState("");
  const slug = slugOf(name);
  const write = useWrite(
    () =>
      call(() =>
        client.organizations({ orgId }).projects({ projectId }).environments.post({ name, slug }),
      ),
    async () => {
      await queries.invalidateQueries({ queryKey: ["environments", orgId, projectId] });
      close();
    },
  );
  return (
    <Drawer title="Add environment" centered close={close}>
      <Form
        title="Add an environment"
        submit="Add environment"
        onSubmit={() => void write.go()}
        error={write.error}
        pending={write.pending}
        disabled={slug === ""}
        onCancel={close}
      >
        <label>
          New environment
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
            placeholder="staging"
          />
        </label>
      </Form>
    </Drawer>
  );
}
