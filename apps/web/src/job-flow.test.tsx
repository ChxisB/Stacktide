import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { type FlowJob, type FlowLane, JobFlow } from "./job-flow";
import { HEAD, layout, NODE } from "./job-flow-layout";

const job = (id: number, stage: string, over: Partial<FlowJob> = {}): FlowJob => ({
  id,
  name: `job-${id}`,
  stage,
  status: "success",
  label: "Passed",
  tone: "ok",
  took: null,
  reason: null,
  url: `https://gitlab.example/jobs/${id}`,
  ...over,
});
const items = (root: HTMLElement) => [...root.querySelectorAll(".job-flow .jobs-list li")];
const texts = (root: HTMLElement) => items(root).map((li) => li.textContent);

describe("JobFlow (NOD-2)", () => {
  test("every state shows its word and its mark", () => {
    const states = [
      ["Passed", "ok"],
      ["Failed", "bad"],
      ["Running", "active"],
      ["Waiting for a manual step", "manual"],
      ["Skipped", "quiet"],
      ["Failed, allowed", "quiet"],
    ] as const;
    const { container } = render(
      <JobFlow jobs={states.map(([label, tone], i) => job(i + 1, "test", { label, tone }))} />,
    );
    const badges = [...container.querySelectorAll(".jobs-list .st")];
    expect(badges.map((b) => b.textContent)).toEqual(states.map(([label]) => label));
    expect(badges.map((b) => b.className)).toEqual(states.map(([, tone]) => `st st-${tone}`));
    for (const b of badges) expect(b.querySelector("svg.glyph")).not.toBeNull();
  });

  test("a node reads its state, name, time, reason and link in that order", () => {
    const { container } = render(
      <JobFlow
        jobs={[
          job(1, "build", { name: "unit", label: "Failed", tone: "bad", took: "5s" }),
          job(2, "build", { name: "lint", reason: "Script failure", took: "1m 12s" }),
        ]}
      />,
    );
    expect(texts(container)).toEqual([
      "Failedunit5sOpen job unit",
      "Passedlint1m 12sScript failureOpen job lint",
    ]);
  });

  test("a failed job's reason is in red and a job without one has none", () => {
    const { container } = render(
      <JobFlow
        jobs={[
          job(1, "a", { label: "Failed", tone: "bad", reason: "Runner system failure" }),
          job(2, "a"),
        ]}
      />,
    );
    const [failed, passed] = items(container);
    expect(failed?.querySelector(".error")?.textContent).toBe("Runner system failure");
    expect(passed?.querySelector(".error")).toBeNull();
  });

  test("a job links to GitLab only when its address is a web address", () => {
    const { container } = render(
      <JobFlow
        jobs={[
          job(1, "a", { name: "good", url: "https://gitlab.example/jobs/1" }),
          job(2, "a", { name: "evil", url: "javascript:alert(1)" }),
          job(3, "a", { name: "none", url: "" }),
        ]}
      />,
    );
    const links = [...container.querySelectorAll("a")];
    expect(
      links.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("rel")]),
    ).toEqual([["Open job good", "https://gitlab.example/jobs/1", "noreferrer"]]);
    expect(links[0]?.getAttribute("target")).toBe("_blank");
  });

  test("the stages are lists under a heading each, in the order the pipeline runs them", () => {
    const { container } = render(
      <JobFlow jobs={[job(3, "deploy"), job(1, "build"), job(2, "test"), job(4, "test")]} />,
    );
    const stages = [...container.querySelectorAll(".job-stage")];
    expect(stages.map((s) => s.querySelector("h3.jobs-stage")?.textContent)).toEqual([
      "build",
      "test",
      "deploy",
    ]);
    expect(stages.map((s) => s.querySelectorAll("ul.jobs-list > li").length)).toEqual([1, 2, 1]);
  });

  test("a name of 120 characters is whole in the page and in its title, and is clamped by the style", () => {
    const name = "x".repeat(120);
    const { container } = render(<JobFlow jobs={[job(1, "a", { name })]} />);
    const code = container.querySelector("code");
    expect(code?.textContent).toBe(name);
    expect(code?.getAttribute("title")).toBe(name);
  });

  test("the nodes sit where the layout puts them, at the size it assumes", () => {
    const jobs = [job(1, "build"), job(2, "test"), job(3, "test")];
    const d = layout(jobs);
    const { container } = render(<JobFlow jobs={jobs} />);
    const canvas = container.querySelector<HTMLElement>(".job-flow-canvas");
    expect([canvas?.style.width, canvas?.style.height]).toEqual([`${d.width}px`, `${d.height}px`]);
    const stages = [...container.querySelectorAll<HTMLElement>(".job-stage")];
    expect(stages.map((s) => s.style.left)).toEqual(d.columns.map((c) => `${c.x}px`));
    expect(stages.map((s) => s.style.width)).toEqual(d.columns.map(() => `${NODE.w}px`));
    for (const li of items(container)) expect((li as HTMLElement).style.height).toBe(`${NODE.h}px`);
    for (const h of container.querySelectorAll<HTMLElement>("h3"))
      expect(h.style.height).toBe(`${HEAD}px`);
  });

  test("the lines are under the nodes, hidden from a screen reader, and only those into a job have an arrow", () => {
    const jobs = [job(1, "build"), job(2, "test"), job(3, "test"), job(4, "deploy")];
    const d = layout(jobs);
    const { container } = render(<JobFlow jobs={jobs} />);
    const svg = container.querySelector("svg.job-flow-edges");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    const paths = [...container.querySelectorAll("path.job-flow-edge")];
    expect(paths.map((p) => p.getAttribute("d"))).toEqual(d.edges.map((e) => e.d));
    expect(paths.map((p) => p.hasAttribute("marker-end"))).toEqual(d.edges.map((e) => e.arrow));
    expect(container.querySelectorAll("circle.job-flow-junction")).toHaveLength(d.junctions.length);
    // the arrowhead is the marker the lines point at
    const id = paths.find((p) => p.hasAttribute("marker-end"))?.getAttribute("marker-end");
    const marker = container.querySelector("marker");
    expect(id).toBe(`url(#${marker?.id})`);
  });

  test("two drawings on one page do not share an arrowhead", () => {
    const jobs = [job(1, "a"), job(2, "b")];
    const { container } = render(
      <>
        <JobFlow jobs={jobs} />
        <JobFlow jobs={jobs} />
      </>,
    );
    const ids = [...container.querySelectorAll("marker")].map((m) => m.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  test("the same jobs in another order draw the same nodes", () => {
    const jobs = [job(1, "build"), job(2, "test"), job(3, "test")];
    const once = texts(render(<JobFlow jobs={jobs} />).container);
    expect(texts(render(<JobFlow jobs={[...jobs].reverse()} />).container)).toEqual(once);
  });

  test("no jobs draw nothing", () => {
    const { container } = render(<JobFlow jobs={[]} />);
    expect(container.innerHTML).toBe("");
  });
});

// NOD-7: a trigger is a node that says so, and what it started is a lane of its own to the right
const trigger = (id: number, stage: string, over: Partial<FlowJob> = {}) =>
  job(id, stage, { kind: "trigger", name: "launch", ...over });
const lane = (
  id: string,
  from: number,
  jobs: FlowJob[],
  title = `Child pipeline #${id}`,
): FlowLane => ({
  id,
  from,
  title,
  jobs,
});
const groups = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".job-flow section")];

describe("JobFlow, triggers and child pipelines (NOD-7)", () => {
  test("a trigger is a node with its own ring, 'Triggers' and its name; another job has none of that", () => {
    const { container } = render(
      <JobFlow jobs={[job(1, "build", { name: "compile" }), trigger(2, "deploy")]} />,
    );
    const [plain, trig] = items(container);
    expect(plain?.classList.contains("job-trigger")).toBe(false);
    expect(plain?.querySelector(".job-kind")).toBeNull();
    expect(trig?.classList.contains("job-trigger")).toBe(true);
    expect(trig?.querySelector(".job-kind")?.textContent).toBe("Triggers");
    expect(trig?.textContent).toBe("PassedTriggerslaunchOpen job launch");
  });

  test("a trigger into another project says so with the state, and has no link when it has no address", () => {
    const { container } = render(
      <JobFlow
        jobs={[
          trigger(1, "deploy", {
            label: "Running",
            tone: "active",
            url: "",
            note: "Pipeline in another project: running",
          }),
          trigger(2, "deploy", { name: "plain", note: null }),
        ]}
      />,
    );
    const [other, plain] = items(container);
    expect(other?.querySelector(".job-note")?.textContent).toBe(
      "Pipeline in another project: running",
    );
    expect(other?.querySelector("a")).toBeNull();
    expect(plain?.querySelector(".job-note")).toBeNull();
  });

  test("a trigger that started nothing is a node alone: no lane, no extra line", () => {
    const jobs = [job(1, "build"), trigger(2, "deploy")];
    const { container } = render(<JobFlow jobs={jobs} lanes={[]} />);
    expect(groups(container)).toHaveLength(0);
    expect(items(container)).toHaveLength(2);
    expect(container.querySelectorAll("path.job-flow-edge")).toHaveLength(
      layout(jobs).edges.length,
    );
  });

  test("a child pipeline is a lane under its own heading, with the stages of its own, drawn with the lines from the trigger", () => {
    const jobs = [job(1, "build"), job(2, "deploy", { name: "ship" }), trigger(3, "deploy")];
    const lanes = [
      lane(
        "c9",
        3,
        [
          job(10, "test", { name: "unit" }),
          job(11, "test", { name: "lint" }),
          job(12, "deploy", { name: "release" }),
        ],
        "Child pipeline #9",
      ),
    ];
    const { container } = render(<JobFlow jobs={jobs} lanes={lanes} />);
    const [g] = groups(container);
    expect(groups(container)).toHaveLength(1);
    const title = g?.querySelector("h3.job-lane-title");
    expect(title?.textContent).toBe("Child pipeline #9");
    expect(g?.getAttribute("aria-labelledby")).toBe(title?.id);
    expect([...(g?.querySelectorAll("h4.jobs-stage") ?? [])].map((h) => h.textContent)).toEqual([
      "test",
      "deploy",
    ]);
    expect([...(g?.querySelectorAll("ul.jobs-list") ?? [])].map((u) => u.children.length)).toEqual([
      2, 1,
    ]);
    expect([...(g?.querySelectorAll(".jobs-list li") ?? [])].map((li) => li.textContent)).toEqual([
      "PassedunitOpen job unit",
      "PassedlintOpen job lint",
      "PassedreleaseOpen job release",
    ]);
    // the pipeline's own stages are not the lane's
    expect(
      [...container.querySelectorAll(".job-flow-canvas > .job-stage h3.jobs-stage")].map(
        (h) => h.textContent,
      ),
    ).toEqual(["build", "deploy"]);
  });

  test("the lane sits where the layout puts it, and the canvas holds it with its lines and junctions", () => {
    const jobs = [job(1, "build"), trigger(2, "deploy")];
    const lanes = [lane("c9", 2, [job(10, "test"), job(11, "deploy")])];
    const d = layout(jobs, lanes);
    const placed = d.lanes?.[0];
    if (!placed) throw new Error("the layout drew no lane");
    const { container } = render(<JobFlow jobs={jobs} lanes={lanes} />);
    const canvas = container.querySelector<HTMLElement>(".job-flow-canvas");
    expect([canvas?.style.width, canvas?.style.height]).toEqual([`${d.width}px`, `${d.height}px`]);
    const [head, ...columns] = [
      ...(groups(container)[0]?.querySelectorAll<HTMLElement>(".job-stage") ?? []),
    ];
    expect([head?.style.left, head?.style.top, head?.style.width]).toEqual([
      `${placed.x}px`,
      `${placed.y}px`,
      `${placed.width}px`,
    ]);
    expect(columns.map((c) => [c.style.left, c.style.top, c.style.width])).toEqual(
      placed.columns.map((c) => [`${c.x}px`, `${placed.top}px`, `${NODE.w}px`]),
    );
    expect(
      [...container.querySelectorAll("path.job-flow-edge")].map((p) => p.getAttribute("d")),
    ).toEqual(d.edges.map((e) => e.d));
    expect(container.querySelectorAll("circle.job-flow-junction")).toHaveLength(d.junctions.length);
  });

  test("two lanes are two groups, each named by its own heading, and a lane nobody started or with no jobs is not drawn", () => {
    const jobs = [job(1, "deploy"), trigger(2, "deploy")];
    const { container } = render(
      <JobFlow
        jobs={jobs}
        lanes={[
          lane("c1", 2, [job(10, "test")], "Child pipeline #1"),
          lane("c2", 2, [job(20, "test")], "Child pipeline #2"),
          lane("c3", 999, [job(30, "test")], "Child pipeline #3"),
          lane("c4", 2, [], "Child pipeline #4"),
        ]}
      />,
    );
    const gs = groups(container);
    expect(gs.map((g) => g.querySelector("h3")?.textContent)).toEqual([
      "Child pipeline #1",
      "Child pipeline #2",
    ]);
    const ids = gs.map((g) => g.getAttribute("aria-labelledby"));
    expect(new Set(ids).size).toBe(2);
    expect(container.textContent).not.toContain("#3");
  });

  test("a state the page does not know still draws, in its own words", () => {
    const { container } = render(
      <JobFlow
        jobs={[trigger(1, "deploy", { label: "waiting for callback", tone: "quiet" })]}
        lanes={[lane("c1", 1, [job(5, "test", { label: "invented later", tone: "quiet" })])]}
      />,
    );
    expect(texts(container)).toEqual([
      "waiting for callbackTriggerslaunchOpen job launch",
      "invented laterjob-5Open job job-5",
    ]);
  });
});
