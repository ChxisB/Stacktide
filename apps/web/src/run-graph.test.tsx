import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { RunGraph } from "./run-graph";

const node = (
  name: string,
  wave: number,
  dependsOn: string[] = [],
  over: { label?: string; tone?: "ok" | "quiet" | "bad"; dns?: boolean } = {},
) => ({ name, wave, dependsOn, label: "Planned", tone: "quiet" as const, dns: false, ...over });

const chain = [node("vpc", 0), node("db", 1, ["vpc"]), node("app", 2, ["db"])];
const boxes = (root: HTMLElement) => [...root.querySelectorAll(".run-graph-box")];
const edges = (root: HTMLElement) => [...root.querySelectorAll("path.run-graph-edge")];

describe("RunGraph (FLW-3)", () => {
  test("a chain is three boxes and two lines, each box with its name and its state in words", () => {
    const { container } = render(
      <RunGraph
        stacks={[
          node("vpc", 0, [], { label: "Applied", tone: "ok" }),
          node("db", 1, ["vpc"], { label: "Failed", tone: "bad" }),
          node("app", 2, ["db"]),
        ]}
      />,
    );
    expect(boxes(container).map((b) => b.textContent)).toEqual([
      "vpcApplied",
      "dbFailed",
      "appPlanned",
    ]);
    expect(edges(container)).toHaveLength(2);
  });

  test("the drawing is hidden from a screen reader, and a list says who waits for whom", () => {
    const { container } = render(<RunGraph stacks={chain} />);
    expect(container.querySelector(".run-graph-canvas")?.getAttribute("aria-hidden")).toBe("true");
    const said = [...container.querySelectorAll(".visually-hidden li")].map((li) => li.textContent);
    expect(said).toEqual(["app waits for db", "db waits for vpc"]);
    // a name is plain text, so a test or a reader looking for a stack's <code> finds the stack list's
    expect(container.querySelector("code")).toBeNull();
  });

  test("a DNS zone is tagged and another stack is not", () => {
    const { container } = render(
      <RunGraph stacks={[node("zone", 0, [], { dns: true }), node("net", 0)]} />,
    );
    const [net, zone] = boxes(container);
    expect(zone?.textContent).toContain("DNS zone");
    expect(net?.textContent).not.toContain("DNS zone");
  });

  test("a state the page does not know still draws, in the words it came with", () => {
    const { container } = render(
      <RunGraph stacks={[node("vpc", 0), node("db", 1, ["vpc"], { label: "Rebasing" })]} />,
    );
    expect(boxes(container).map((b) => b.textContent)).toEqual(["vpcPlanned", "dbRebasing"]);
  });

  test("a stack alone is a box with no line and nothing to read out", () => {
    const { container } = render(<RunGraph stacks={[node("solo", 0)]} />);
    expect(boxes(container)).toHaveLength(1);
    expect(edges(container)).toHaveLength(0);
    expect(container.querySelectorAll(".visually-hidden li")).toHaveLength(0);
  });
});
