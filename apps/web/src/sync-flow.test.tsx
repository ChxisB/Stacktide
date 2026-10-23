import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { SyncFlow } from "./sync-flow";

const target = { name: "acme-web-ci", type: "GitLab CI/CD variables" };
const two = { staging: "staging", dev: "development" };
const lines = (...l: [scope: string, action: string][]) =>
  l.map(([scope, action]) => ({ scope, action }));
const rows = (root: HTMLElement) =>
  [...root.querySelectorAll(".sync-lines li")].map((li) => li.textContent);

describe("SyncFlow (FLW-5)", () => {
  test("is the project's variables, a line for each mapped environment in words, and the target", () => {
    const { container } = render(<SyncFlow project="acme/web" target={target} mapping={two} />);
    expect(container.textContent).toContain("Variablesacme/web");
    expect(container.textContent).toContain("GitLab CI/CD variablesacme-web-ci");
    // by name, whatever order the API listed them in
    expect(rows(container)).toEqual(["dev → development", "staging → staging"]);
  });

  test("with no plan open it shows no counts, because the drift totals are on the card already", () => {
    const { container } = render(<SyncFlow project="acme/web" target={target} mapping={two} />);
    expect(container.textContent).not.toMatch(/to create|to change|to delete|Nothing to change/);
  });

  test("with a plan open each environment line carries the counts of its own scope", () => {
    const { container } = render(
      <SyncFlow
        project="acme/web"
        target={target}
        mapping={two}
        lines={lines(
          ["development", "create"],
          ["development", "create"],
          ["development", "update"],
          ["staging", "delete"],
          ["*", "create"],
        )}
      />,
    );
    expect(rows(container)).toEqual([
      "All environments1 to create",
      "dev → development2 to create, 1 to change",
      "staging → staging1 to delete",
    ]);
  });

  test("a line with nothing to do says so; a line that already matches or is left alone is not counted", () => {
    const { container } = render(
      <SyncFlow
        project="acme/web"
        target={target}
        mapping={two}
        lines={lines(["development", "noop"], ["staging", "adopt"])}
      />,
    );
    // no plan line is for every environment, so there is no line for that
    expect(rows(container)).toEqual([
      "dev → developmentNothing to change",
      "staging → stagingNothing to change",
    ]);
  });

  test("a plan line for a scope that is not mapped is counted on the target, not lost", () => {
    const { container } = render(
      <SyncFlow
        project="acme/web"
        target={target}
        mapping={{ dev: "development" }}
        lines={lines(["qa", "delete"], ["qa", "delete"], ["development", "create"])}
      />,
    );
    expect(container.querySelector(".sync-target")?.textContent).toContain(
      "Other scopes: 2 to delete",
    );
    expect(rows(container)).toContain("dev → development1 to create");
  });

  test("a target with no mapping shows no strip", () => {
    const { container } = render(<SyncFlow project="acme/web" target={target} mapping={{}} />);
    expect(container.innerHTML).toBe("");
  });

  test("the connectors are decoration: they are not in the page's text or tree", () => {
    const { container } = render(<SyncFlow project="acme/web" target={target} mapping={two} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
});
