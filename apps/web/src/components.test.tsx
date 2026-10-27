import { describe, expect, jest, mock, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import {
  Callout,
  Card,
  Chips,
  Confirm,
  Dialog,
  Drawer,
  Empty,
  Kpi,
  Named,
  PageHead,
  Popover,
  RowMenu,
  StatusBadge,
  Toaster,
  type Tone,
  useInDrawer,
  useToast,
} from "./components";
import { visibleText } from "./testing";
import { Loading } from "./ui";

// UXR-2: busy is a state of any button; the spinner is CSS (styles.test.ts), so what a test can hold to is the markup: the
// label stays, and so does the name it is found by
describe("a busy button", () => {
  test("keeps its label as its name, says it is busy, and cannot be pressed again", async () => {
    const press = mock(() => {});
    render(
      <button type="button" className="primary" aria-busy="true" disabled onClick={press}>
        Checking…
      </button>,
    );
    const button = screen.getByRole("button", { name: "Checking…" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    await userEvent.click(button);
    fireEvent.keyDown(button, { key: "Enter" });
    expect(press).not.toHaveBeenCalled();
  });
});

// UXR-3: no screen has a field with an error of its own yet (a form's error is one line under the form); the State
// screen's stack input is the first (UXR-22). This holds the markup those screens follow: the control says it is invalid
// and is described by its error line, which the field's CSS then shows under it
describe("an invalid field", () => {
  test("is found by its label, says it is invalid, and has its error as its description", () => {
    render(
      <div className="field">
        <label htmlFor="name">Name</label>
        <input
          id="name"
          defaultValue="database url"
          aria-invalid="true"
          aria-describedby="name-error"
        />
        <p id="name-error" className="error">
          Use capitals and underscores, like DATABASE_URL.
        </p>
      </div>,
    );
    const input = screen.getByRole("textbox", {
      name: "Name",
      description: "Use capitals and underscores, like DATABASE_URL.",
    });
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("PageHead", () => {
  test("is the page's heading, with the lede and actions around it", () => {
    render(
      <PageHead
        title="Pipeline"
        lede="Set up CI for a project."
        actions={<button type="button">Open merge request</button>}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Pipeline" })).toBeTruthy();
    expect(screen.getByText("Set up CI for a project.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open merge request" })).toBeTruthy();
  });

  test("needs only a title", () => {
    const { container } = render(<PageHead title="Home" />);
    expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
    expect(container.querySelector(".lede, .actions")).toBeNull();
  });
});

describe("Card", () => {
  test("is a region named by its title, with a sub-line and actions", () => {
    render(
      <Card title="Members" sub="Who can change this" actions={<button type="button">Add</button>}>
        <p>body</p>
      </Card>,
    );
    const card = screen.getByRole("region", { name: "Members" });
    expect(card.textContent).toContain("Who can change this");
    expect(card.textContent).toContain("body");
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
  });

  test("two cards do not share a heading id", () => {
    render(
      <>
        <Card title="One">a</Card>
        <Card title="Two">b</Card>
      </>,
    );
    expect(screen.getByRole("region", { name: "One" }).textContent).toContain("a");
    expect(screen.getByRole("region", { name: "Two" }).textContent).toContain("b");
  });

  test("a label names the region in place of its title", () => {
    render(
      <Card label="Getting started" title="You are set up">
        <p>body</p>
      </Card>,
    );
    const card = screen.getByRole("region", { name: "Getting started" });
    expect(card.querySelector("h2")?.textContent).toBe("You are set up");
    expect(card.getAttribute("aria-labelledby")).toBeNull();
  });

  test("without a title it is a plain box", () => {
    const { container } = render(<Card>just content</Card>);
    expect(container.querySelector("h2")).toBeNull();
    expect(container.textContent).toBe("just content");
  });
});

describe("StatusBadge", () => {
  const tones: Tone[] = ["ok", "bad", "warn", "active", "manual", "quiet"];

  test.each(tones)("%s shows its words and hides its shape from assistive technology", (tone) => {
    const { container } = render(<StatusBadge tone={tone}>Words for {tone}</StatusBadge>);
    expect(screen.getByText(`Words for ${tone}`)).toBeTruthy();
    const glyph = container.querySelector("svg");
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
    expect(glyph?.getAttribute("focusable")).toBe("false");
    // read as one string, the badge is just its words
    expect(container.textContent).toBe(`Words for ${tone}`);
  });

  test("every tone has its own shape, so colour is never the only signal", () => {
    const shapes = tones.map((tone) => {
      const { container, unmount } = render(<StatusBadge tone={tone}>x</StatusBadge>);
      const html = container.querySelector("svg")?.innerHTML ?? "";
      unmount();
      return html;
    });
    expect(new Set(shapes).size).toBe(tones.length);
  });
});

describe("Kpi", () => {
  test("shows the label, the figure, its unit and a foot line", () => {
    const { container } = render(
      <Kpi label="Open findings" value="3" unit="of 12" foot="by severity" />,
    );
    expect(screen.getByText("Open findings")).toBeTruthy();
    expect(container.textContent).toContain("3 of 12");
    expect(screen.getByText("by severity")).toBeTruthy();
  });

  test("a figure of zero is shown, not left out", () => {
    const { container } = render(<Kpi label="Projects" value={0} />);
    expect(container.querySelector(".kpi-value")?.textContent).toBe("0");
  });

  test("a foot with a link is a link, named by the foot's words", () => {
    render(<Kpi label="Open findings" value="5" foot="2 are high" footHref="#/findings" />);
    const link = screen.getByRole("link", { name: "2 are high" });
    expect(link.getAttribute("href")).toBe("#/findings");
  });

  test("a foot without a link is words only, and no foot leaves no line", () => {
    const { container, rerender } = render(
      <Kpi label="Open findings" value="5" foot="2 are high" />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector(".kpi-foot")?.textContent).toBe("2 are high");
    rerender(<Kpi label="Open findings" value="5" />);
    expect(container.querySelector(".kpi-foot")).toBeNull();
  });
});

// UXR-5: a message in a box (a callout), a place with nothing in it (empty, or failed) and the shape of what is on its way
describe("Callout", () => {
  const tones = ["info", "ok", "warn", "bad"] as const;

  test.each(tones)("%s shows its words beside a glyph hidden from assistive technology", (tone) => {
    const { container } = render(
      <Callout tone={tone} title="Heads up.">
        Check the connection.
      </Callout>,
    );
    expect(container.textContent).toBe("Heads up. Check the connection.");
    expect(screen.getByText("Heads up.").tagName).toBe("B");
    const glyph = container.querySelector("svg");
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
    expect(glyph?.getAttribute("focusable")).toBe("false");
  });

  test("only a bad one interrupts a screen reader; the others are read in their turn", () => {
    for (const tone of tones) {
      const { unmount } = render(<Callout tone={tone}>Words for {tone}</Callout>);
      expect(screen.queryByRole("alert") === null).toBe(tone !== "bad");
      unmount();
    }
  });

  test("every tone has its own glyph, so colour is never the only signal", () => {
    const shapes = tones.map((tone) => {
      const { container, unmount } = render(<Callout tone={tone}>x</Callout>);
      const html = container.querySelector("svg")?.innerHTML ?? "";
      unmount();
      return html;
    });
    expect(new Set(shapes).size).toBe(tones.length);
  });

  test("its action is a button inside the box, so it is read with the words", () => {
    render(
      <Callout tone="bad" title="Down." action={<button type="button">Try again</button>}>
        Cannot reach it.
      </Callout>,
    );
    const alert = screen.getByRole("alert");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(alert.textContent).toBe("Down. Cannot reach it.Try again");
  });

  test("without a title it is its words only, and a link in it stays a link", () => {
    render(
      <Callout tone="warn">
        2 variables differ. <a href="#/sync">Open Sync</a>
      </Callout>,
    );
    expect(screen.queryByText("2 variables differ.", { selector: "b" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open Sync" }).getAttribute("href")).toBe("#/sync");
  });
});

describe("Empty", () => {
  test("says what belongs here and gives the button that puts something here", () => {
    render(
      <Empty
        title="No projects yet"
        text="Connect GitLab and choose the projects to manage."
        action={<button type="button">Connect GitLab</button>}
      />,
    );
    expect(screen.getByRole("heading", { level: 3, name: "No projects yet" })).toBeTruthy();
    expect(screen.getByText("Connect GitLab and choose the projects to manage.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect GitLab" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("without an action it is words only", () => {
    render(<Empty title="No findings" text="Nothing was found in the last scan." />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("a failed one is announced, with its fix beside it and its glyph hidden", () => {
    const { container } = render(
      <Empty
        tone="bad"
        title="Something went wrong"
        text="We could not load pipelines."
        action={<button type="button">Retry</button>}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(within(alert).getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("Loading", () => {
  test("is a busy status that still says what is loading, with the shape of lines drawn under it", () => {
    const { container } = render(<Loading what="Loading pipelines" />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.textContent).toBe("Loading pipelines…");
    expect(screen.getByText("Loading pipelines…")).toBeTruthy();
    // the lines are decoration: a screen reader hears the words once
    const lines = [...container.querySelectorAll(".skel")];
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(line.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("Chips", () => {
  const items = [
    { key: "all", label: "All", n: 5 },
    { key: "failed", label: "Failed", n: 2 },
    { key: "passed", label: "Passed" },
  ];

  test("one chip is pressed, and counts are shown", () => {
    render(<Chips label="Filter by result" items={items} value="failed" pick={() => {}} />);
    const group = screen.getByRole("group", { name: "Filter by result" });
    expect(group).toBeTruthy();
    const on = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(on.map((b) => b.textContent)).toEqual(["Failed 2"]);
    expect(screen.getByRole("button", { name: "All 5" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Passed" }).textContent).toBe("Passed");
  });

  test("picks with a click, Enter and Space, and tells the parent the key", async () => {
    const pick = mock((_key: string) => {});
    render(<Chips label="Filter by result" items={items} value="all" pick={pick} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Failed 2" }));
    await user.tab(); // from the clicked chip to the next one
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Passed" }));
    await user.keyboard("{Enter}");
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "All 5" }));
    await user.keyboard(" ");
    expect(pick.mock.calls.map((c) => c[0])).toEqual(["failed", "passed", "all"]);
  });
});

describe("Named", () => {
  test("shows one word and keeps the whole name for assistive technology", () => {
    render(
      <button type="button">
        <Named word="Retry" name="feature/billing" />
      </button>,
    );
    const button = screen.getByRole("button", { name: "Retry feature/billing" });
    expect(visibleText(button)).toBe("Retry");
    expect(button.querySelector(".visually-hidden")?.textContent).toBe(" feature/billing");
  });
});

describe("Popover", () => {
  const mounted = () =>
    render(
      <>
        <Popover label="Filter" icon="filter" count={0}>
          <label>
            Tag
            <select>
              <option>All tags</option>
            </select>
          </label>
        </Popover>
        <button type="button">Elsewhere</button>
      </>,
    );

  test("a button names it and says whether it is open; the panel is not on the page until it is", async () => {
    mounted();
    const button = screen.getByRole("button", { name: "Filter" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("group", { name: "Filter" })).toBeNull();
    expect(screen.queryByLabelText("Tag")).toBeNull();

    const user = userEvent.setup();
    await user.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const panel = screen.getByRole("group", { name: "Filter" });
    expect(button.getAttribute("aria-controls")).toBe(panel.id);
    expect(screen.getByLabelText("Tag")).toBeTruthy();

    await user.click(button);
    expect(screen.queryByRole("group", { name: "Filter" })).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  test("Esc closes it from the button or from inside it, and focus is back on the button", async () => {
    mounted();
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Filter" });
    await user.click(button);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Filter" })).toBeNull();
    expect(document.activeElement).toBe(button);

    await user.click(button);
    screen.getByLabelText("Tag").focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Filter" })).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  test("a press outside closes it, and a press inside does not", async () => {
    mounted();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Filter" }));
    await user.click(screen.getByLabelText("Tag"));
    expect(screen.getByRole("group", { name: "Filter" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("group", { name: "Filter" })).toBeNull();
  });

  test("a count beside the label shows when it is above zero, and is part of the name", () => {
    const { rerender } = render(
      <Popover label="Filter" count={1}>
        x
      </Popover>,
    );
    expect(screen.getByRole("button", { name: "Filter 1" })).toBeTruthy();
    rerender(
      <Popover label="Filter" count={0}>
        x
      </Popover>,
    );
    expect(screen.getByRole("button", { name: "Filter" }).textContent).toBe("Filter");
  });

  test("its icon is not read out", () => {
    mounted();
    const icon = screen.getByRole("button", { name: "Filter" }).querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("focusable")).toBe("false");
  });
});

// VUI-4: the ⋯ menu of a row. The keyboard map is the menu button pattern: arrows move, Home and End jump, Esc and Tab leave.
describe("RowMenu", () => {
  const mounted = (run = mock(() => {})) => {
    render(
      <>
        <button type="button">Before</button>
        <RowMenu
          label="More actions for DB_URL"
          items={[
            { label: "Edit details", run },
            { label: "Version history", run },
            { label: "Delete", run, danger: true },
          ]}
        />
        <button type="button">Elsewhere</button>
      </>,
    );
    return { run, trigger: screen.getByRole("button", { name: "More actions for DB_URL" }) };
  };
  const names = () => screen.getAllByRole("menuitem").map((i) => i.textContent);

  test("a button names it and says it opens a menu; the menu is not on the page until it is open", async () => {
    const { trigger } = mounted();
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("title")).toBe("More actions for DB_URL");
    expect(trigger.textContent).toBe("");
    expect(screen.queryByRole("menu")).toBeNull();

    await userEvent.setup().click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu", { name: "More actions for DB_URL" });
    expect(trigger.getAttribute("aria-controls")).toBe(menu.id);
    expect(names()).toEqual(["Edit details", "Version history", "Delete"]);
    expect(screen.getByRole("menuitem", { name: "Delete" }).className).toContain("danger");
  });

  test("opening puts focus on the first item, and only that item can be reached by Tab (roving focus)", async () => {
    const { trigger } = mounted();
    await userEvent.setup().click(trigger);
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0] as HTMLElement);
    expect(items.map((i) => i.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
  });

  test("arrow keys move down and up and wrap; Home and End jump", async () => {
    const { trigger } = mounted();
    const user = userEvent.setup();
    await user.click(trigger);
    const [first, second, last] = screen.getAllByRole("menuitem") as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(second);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(last);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(first);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(last);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(first);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(last);
    // the item with focus is the one a Tab stop would land on
    expect(last.getAttribute("tabindex")).toBe("0");
    expect(first.getAttribute("tabindex")).toBe("-1");
  });

  test("ArrowDown on the closed button opens the menu on its first item", async () => {
    const { trigger } = mounted();
    const user = userEvent.setup();
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0] as HTMLElement);
  });

  test("Esc closes it with focus back on the button, and runs nothing", async () => {
    const { trigger, run } = mounted();
    const user = userEvent.setup();
    await user.click(trigger);
    await user.keyboard("{ArrowDown}{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(run).not.toHaveBeenCalled();
  });

  test("Tab closes it and moves on, in the page's order, and runs nothing", async () => {
    const { trigger, run } = mounted();
    const user = userEvent.setup();
    await user.click(trigger);
    await user.keyboard("{Tab}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Elsewhere" }));
  });

  test("a press outside closes it, and a press on the menu itself does not", async () => {
    const { trigger } = mounted();
    const user = userEvent.setup();
    await user.click(trigger);
    await user.click(screen.getByRole("menu"));
    expect(screen.getByRole("menu")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  test("choosing an item (by click, Enter or Space) closes the menu, puts focus back on the button, and runs it once", async () => {
    const { trigger, run } = mounted();
    const user = userEvent.setup();
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Version history" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await user.click(trigger);
    await user.keyboard("{Enter}");
    expect(run).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(trigger);
    await user.keyboard("{ArrowDown} ");
    expect(run).toHaveBeenCalledTimes(3);
  });

  test("a scroll of anything (a table scrolls inside its card) or a resize closes it, as it is placed where the button was", async () => {
    const { trigger } = mounted();
    const user = userEvent.setup();
    await user.click(trigger);
    fireEvent.scroll(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(trigger);
    fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("it is placed at the button: under it and right-aligned, or over it when the page ends first", async () => {
    const { trigger } = mounted();
    const user = userEvent.setup();
    const at = (rect: Partial<DOMRect>) => {
      trigger.getBoundingClientRect = () =>
        ({ top: 100, bottom: 132, right: 500, ...rect }) as DOMRect;
    };
    window.innerWidth = 1000;
    window.innerHeight = 800;
    at({});
    await user.click(trigger);
    let menu = screen.getByRole("menu") as HTMLElement;
    expect(menu.style.top).toBe("136px");
    expect(menu.style.right).toBe("500px");
    expect(menu.style.bottom).toBe("");
    await user.keyboard("{Escape}");

    at({ top: 750, bottom: 782 });
    await user.click(trigger);
    menu = screen.getByRole("menu") as HTMLElement;
    expect(menu.style.bottom).toBe("54px");
    expect(menu.style.top).toBe("");
  });

  test("it pops from the button: its origin is the corner nearest the button, under it or over it", async () => {
    const { trigger } = mounted();
    const user = userEvent.setup();
    window.innerWidth = 1000;
    window.innerHeight = 800;
    trigger.getBoundingClientRect = () => ({ top: 100, bottom: 132, right: 500 }) as DOMRect;
    await user.click(trigger);
    expect((screen.getByRole("menu") as HTMLElement).style.transformOrigin).toBe("top right");
    await user.keyboard("{Escape}");

    trigger.getBoundingClientRect = () => ({ top: 750, bottom: 782, right: 500 }) as DOMRect;
    await user.click(trigger);
    expect((screen.getByRole("menu") as HTMLElement).style.transformOrigin).toBe("bottom right");
  });

  test("it moves toward the button as it opens: from below when under it, from above when over it", async () => {
    const { trigger } = mounted();
    const user = userEvent.setup();
    window.innerWidth = 1000;
    window.innerHeight = 800;
    trigger.getBoundingClientRect = () => ({ top: 100, bottom: 132, right: 500 }) as DOMRect;
    await user.click(trigger);
    expect((screen.getByRole("menu") as HTMLElement).style.getPropertyValue("--menu-dir")).toBe("");
    await user.keyboard("{Escape}");

    trigger.getBoundingClientRect = () => ({ top: 750, bottom: 782, right: 500 }) as DOMRect;
    await user.click(trigger);
    expect((screen.getByRole("menu") as HTMLElement).style.getPropertyValue("--menu-dir")).toBe(
      "-1",
    );
  });

  test("the button toggles it, and a second row's menu closes the first (a press outside the first)", async () => {
    render(
      <>
        <RowMenu label="More actions for A" items={[{ label: "One", run: () => {} }]} />
        <RowMenu label="More actions for B" items={[{ label: "Two", run: () => {} }]} />
      </>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More actions for A" }));
    await user.click(screen.getByRole("button", { name: "More actions for A" }));
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(screen.getByRole("button", { name: "More actions for A" }));
    await user.click(screen.getByRole("button", { name: "More actions for B" }));
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menu", { name: "More actions for B" })).toBeTruthy();
  });

  test("its icon is not read out", () => {
    const { trigger } = mounted();
    const icon = trigger.querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });
});

// VUI-6: a panel from the right edge. A dialog: named, modal, focus goes in and comes back, Tab stays inside, Esc and the
// scrim close it, and the page behind does not scroll while it is open.
// UXR-9: a result is reported, then leaves. One at a time, 5 s, a live region that was there before the words.
describe("Toaster", () => {
  function Reports(props: { text: string }) {
    const toast = useToast();
    return (
      <button type="button" onClick={() => toast(props.text)}>
        Report {props.text}
      </button>
    );
  }
  const shown = () => screen.getByRole("status").textContent;

  test("a status region is there before any toast, empty, with nothing to dismiss", () => {
    render(
      <Toaster>
        <Reports text="Saved." />
      </Toaster>,
    );
    expect(shown()).toBe("");
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  test("the words arrive in that region, with a Dismiss button, and the focus stays where it was", async () => {
    const user = userEvent.setup();
    render(
      <Toaster>
        <Reports text="Variable deleted." />
      </Toaster>,
    );
    const opener = screen.getByRole("button", { name: "Report Variable deleted." });
    await user.click(opener);
    expect(shown()).toBe("Variable deleted.");
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    expect(document.activeElement).toBe(opener);
  });

  test("Dismiss removes it, and the region stays", async () => {
    const user = userEvent.setup();
    render(
      <Toaster>
        <Reports text="Saved." />
      </Toaster>,
    );
    await user.click(screen.getByRole("button", { name: "Report Saved." }));
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(shown()).toBe("");
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  // UXR-18: "Started … open the pipeline" is a result with a link in it
  test("the words may carry a link, in the same region", async () => {
    const user = userEvent.setup();
    function Links() {
      const toast = useToast();
      return (
        <button
          type="button"
          onClick={() =>
            toast(
              <>
                Started <code>bbbbbbbb</code>:{" "}
                <a href="https://gitlab.example/p/-/pipelines/7">open the pipeline</a>.
              </>,
            )
          }
        >
          Start
        </button>
      );
    }
    render(
      <Toaster>
        <Links />
      </Toaster>,
    );
    await user.click(screen.getByRole("button", { name: "Start" }));
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("Started bbbbbbbb: open the pipeline.");
    expect(
      within(region).getByRole("link", { name: "open the pipeline" }).getAttribute("href"),
    ).toBe("https://gitlab.example/p/-/pipelines/7");
  });

  // UXR-17: a screen starting a new action takes the news of the last one away before it knows the new result
  test("asking with no words takes the toast away, and the region stays", async () => {
    const user = userEvent.setup();
    function Clears() {
      const toast = useToast();
      return (
        <button type="button" onClick={() => toast()}>
          Clear
        </button>
      );
    }
    render(
      <Toaster>
        <Reports text="Saved." />
        <Clears />
      </Toaster>,
    );
    await user.click(screen.getByRole("button", { name: "Report Saved." }));
    expect(shown()).toBe("Saved.");
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(shown()).toBe("");
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  test("it goes by itself after 5 s, and not before", () => {
    jest.useFakeTimers();
    try {
      render(
        <Toaster>
          <Reports text="Saved." />
        </Toaster>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Report Saved." }));
      act(() => jest.advanceTimersByTime(4999));
      expect(shown()).toBe("Saved.");
      act(() => jest.advanceTimersByTime(1));
      expect(shown()).toBe("");
    } finally {
      jest.useRealTimers();
    }
  });

  test("it waits while the pointer is over it or the focus is in it, then has its whole 5 s again", () => {
    jest.useFakeTimers();
    try {
      render(
        <Toaster>
          <Reports text="Saved." />
        </Toaster>,
      );
      const box = () => screen.getByRole("status").parentElement as HTMLElement;
      for (const [hold, release] of [
        [() => fireEvent.mouseEnter(box()), () => fireEvent.mouseLeave(box())],
        [
          () => fireEvent.focus(screen.getByRole("button", { name: "Dismiss" })),
          () => fireEvent.blur(screen.getByRole("button", { name: "Dismiss" })),
        ],
      ] as const) {
        fireEvent.click(screen.getByRole("button", { name: "Report Saved." }));
        act(() => jest.advanceTimersByTime(4000));
        act(() => hold());
        act(() => jest.advanceTimersByTime(60000));
        expect(shown()).toBe("Saved.");
        act(() => release());
        act(() => jest.advanceTimersByTime(4999));
        expect(shown()).toBe("Saved.");
        act(() => jest.advanceTimersByTime(1));
        expect(shown()).toBe("");
      }
    } finally {
      jest.useRealTimers();
    }
  });

  test("a second toast replaces the first and has its own 5 s", () => {
    jest.useFakeTimers();
    try {
      render(
        <Toaster>
          <Reports text="One." />
          <Reports text="Two." />
        </Toaster>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Report One." }));
      act(() => jest.advanceTimersByTime(3000));
      fireEvent.click(screen.getByRole("button", { name: "Report Two." }));
      expect(shown()).toBe("Two.");
      expect(screen.getAllByRole("button", { name: "Dismiss" })).toHaveLength(1);
      // the first one's 5 s would be up now; the second one's are not
      act(() => jest.advanceTimersByTime(2000));
      expect(shown()).toBe("Two.");
      act(() => jest.advanceTimersByTime(3000));
      expect(shown()).toBe("");
    } finally {
      jest.useRealTimers();
    }
  });

  test("a toast asked for outside a Toaster does nothing instead of throwing", () => {
    render(<Reports text="Saved." />);
    fireEvent.click(screen.getByRole("button", { name: "Report Saved." }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

// UXR-8: one question, two answers. It shares the drawer's modal behaviour (focus in and back, Tab kept inside, Esc and the
// scrim close it, the page does not scroll); what is its own is the heading, the footer, the error line and the busy state.
describe("Dialog", () => {
  function Host(props: {
    destructive?: boolean;
    field?: boolean;
    busy?: boolean;
    disabled?: boolean;
    error?: string;
    onConfirm?: () => void;
    closed?: () => void;
  }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open it
        </button>
        {open && (
          <Dialog
            title="Delete DATABASE_URL?"
            sub="It is removed from dev and from 2 sync targets."
            cancel="Keep it"
            confirm={props.destructive ? "Delete variable" : "Promote"}
            destructive={props.destructive}
            busy={props.busy}
            disabled={props.disabled}
            error={props.error}
            onConfirm={props.onConfirm ?? (() => {})}
            close={() => {
              props.closed?.();
              setOpen(false);
            }}
          >
            {props.field && (
              <label>
                Type the name
                <input />
              </label>
            )}
          </Dialog>
        )}
      </>
    );
  }
  const opened = async (props: Parameters<typeof Host>[0] = {}) => {
    const user = userEvent.setup();
    const view = render(<Host {...props} />);
    const opener = screen.getByRole("button", { name: "Open it" });
    await user.click(opener);
    return { user, opener, view };
  };
  const scrim = () => document.querySelector(".drawer-scrim") as HTMLElement;

  test("is a modal dialog named by its heading and described by its line", async () => {
    await opened();
    const dialog = screen.getByRole("dialog", { name: "Delete DATABASE_URL?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const heading = screen.getByRole("heading", { name: "Delete DATABASE_URL?" });
    expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(
      document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe("It is removed from dev and from 2 sync targets.");
  });

  test("a destructive one is an alert dialog, and its confirm is the solid danger button", async () => {
    await opened({ destructive: true });
    expect(screen.getByRole("alertdialog", { name: "Delete DATABASE_URL?" })).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Delete variable" });
    expect(confirm.className).toBe("danger solid");
    expect(screen.getByRole("button", { name: "Keep it" }).className).toBe("quiet");
  });

  test("a consequential one is a dialog, and its confirm is the primary button, after Cancel", async () => {
    await opened();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const [cancel, confirm] = within(screen.getByRole("dialog")).getAllByRole("button");
    expect(cancel?.textContent).toBe("Keep it");
    expect(confirm?.textContent).toBe("Promote");
    expect(confirm?.className).toBe("primary");
  });

  test("Cancel reads Cancel unless the caller says what it keeps", () => {
    render(
      <Dialog title="Leave?" confirm="Leave" onConfirm={() => {}} close={() => {}}>
        {null}
      </Dialog>,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  test("focus starts on Cancel for a destructive one, on the first field for a form, else on the dialog", async () => {
    const destructive = await opened({ destructive: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep it" }));
    destructive.view.unmount();
    const form = await opened({ destructive: true, field: true });
    // destructive wins over a field: the safe button first, even when there is something to type
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep it" }));
    form.view.unmount();
    const typed = await opened({ field: true });
    expect(document.activeElement).toBe(screen.getByLabelText("Type the name"));
    typed.view.unmount();
    await opened();
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  test("Tab from the last button goes to the first control, and Shift+Tab from it goes back", async () => {
    const { user } = await opened({ field: true });
    const field = screen.getByLabelText("Type the name");
    const confirm = screen.getByRole("button", { name: "Promote" });
    confirm.focus();
    await user.tab();
    expect(document.activeElement).toBe(field);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(confirm);
  });

  test("Esc, the scrim and Cancel each close it, and focus is back on the button that opened it", async () => {
    const closed = mock(() => {});
    const first = await opened({ closed });
    await first.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(first.opener);
    first.view.unmount();
    const second = await opened({ closed });
    await second.user.click(scrim());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(second.opener);
    second.view.unmount();
    const third = await opened({ closed });
    await third.user.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(third.opener);
    expect(closed).toHaveBeenCalledTimes(3);
  });

  test("when what opened it is gone with what it did, focus goes to the page's main and not to nowhere", async () => {
    function Gone() {
      const [rows, setRows] = useState(["a"]);
      const [open, setOpen] = useState(false);
      return (
        <main id="main" tabIndex={-1}>
          {rows.map((r) => (
            <div key={r}>
              <button type="button" onClick={() => setOpen(true)}>
                Open it
              </button>
              {open && (
                <Dialog
                  title="Remove it?"
                  confirm="Remove"
                  onConfirm={() => setRows([])}
                  close={() => setOpen(false)}
                />
              )}
            </div>
          ))}
        </main>
      );
    }
    const user = userEvent.setup();
    render(<Gone />);
    await user.click(screen.getByRole("button", { name: "Open it" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open it" })).toBeNull();
    expect(document.activeElement).toBe(document.getElementById("main"));
  });

  test("the confirm button runs it once, and so does Enter in a field", async () => {
    const onConfirm = mock(() => {});
    const { user } = await opened({ field: true, onConfirm });
    await user.click(screen.getByRole("button", { name: "Promote" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await user.type(screen.getByLabelText("Type the name"), "x{Enter}");
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  test("answering it does not submit the form it was opened from: React bubbles a portal's events to its parent", async () => {
    const outer = mock((e: { preventDefault: () => void }) => e.preventDefault());
    const onConfirm = mock(() => {});
    const user = userEvent.setup();
    render(
      <form onSubmit={outer}>
        <Dialog title="Leave?" confirm="Leave" onConfirm={onConfirm} close={() => {}} />
      </form>,
    );
    await user.click(screen.getByRole("button", { name: "Leave" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  test("busy: both buttons are disabled and the confirm says so, so it cannot be pressed again", async () => {
    const onConfirm = mock(() => {});
    const { user, view } = await opened({ onConfirm });
    view.rerender(<Host busy onConfirm={onConfirm} />);
    const confirm = screen.getByRole("button", { name: "Promote" }) as HTMLButtonElement;
    const cancel = screen.getByRole("button", { name: "Keep it" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect(cancel.getAttribute("aria-busy")).toBeNull();
    await user.click(confirm);
    fireEvent.keyDown(confirm, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // UXR-18: an answer that is not yet possible (the dry run has not come back) is shut, but nothing is under way
  test("disabled: the answer is shut without saying it is busy, and Cancel and Esc still work", async () => {
    const onConfirm = mock(() => {});
    const closed = mock(() => {});
    const { user } = await opened({ disabled: true, field: true, onConfirm, closed });
    const confirm = screen.getByRole("button", { name: "Promote" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(confirm.getAttribute("aria-busy")).toBeNull();
    expect((screen.getByRole("button", { name: "Keep it" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    await user.click(confirm);
    // the browser does not submit by Enter when the answer is shut; a form submitted any other way is held too
    fireEvent.submit(screen.getByRole("dialog").querySelector("form") as HTMLFormElement);
    expect(onConfirm).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(closed).toHaveBeenCalledTimes(1);
  });

  test("busy: Esc and the scrim do not close it either, so the answer is not lost mid-request", async () => {
    const closed = mock(() => {});
    const { user, view } = await opened({ closed });
    view.rerender(<Host busy closed={closed} />);
    await user.keyboard("{Escape}");
    await user.click(scrim());
    expect(closed).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    view.rerender(<Host closed={closed} />);
    await user.keyboard("{Escape}");
    expect(closed).toHaveBeenCalledTimes(1);
  });

  test("opened over a drawer, Esc closes only the dialog, the one on top", async () => {
    const drawerClosed = mock(() => {});
    const dialogClosed = mock(() => {});
    function Over() {
      const [open, setOpen] = useState(false);
      return (
        <Drawer title="Edit DATABASE_URL" close={drawerClosed}>
          <button type="button" onClick={() => setOpen(true)}>
            Ask
          </button>
          {open && (
            <Dialog title="Delete it?" confirm="Delete" onConfirm={() => {}} close={dialogClosed} />
          )}
        </Drawer>
      );
    }
    const user = userEvent.setup();
    const view = render(<Over />);
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await user.keyboard("{Escape}");
    expect(dialogClosed).toHaveBeenCalledTimes(1);
    expect(drawerClosed).not.toHaveBeenCalled();
    // both go at once (a delete answered in the dialog closes the drawer too): the page scrolls again
    view.unmount();
    expect(document.body.style.overflow).toBe("");
  });

  test("an error is an alert in the dialog, and when the work stops the focus is back on the confirm button", async () => {
    const { view } = await opened();
    expect(screen.queryByRole("alert")).toBeNull();
    view.rerender(<Host busy />);
    // a disabled button loses the focus; the keyboard is not left on the page behind the scrim
    (document.activeElement as HTMLElement).blur();
    view.rerender(<Host error="It is used by 2 sync targets. Remove them first." />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("It is used by 2 sync targets. Remove them first.");
    expect(screen.getByRole("dialog").contains(alert)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Promote" }));
  });
});

// UXR-26: the one delete question of the Settings screens (a connection, a provider, a sign-in method, a token)
describe("Confirm", () => {
  test("asks with the cost as a warning, what blocks it as a note, Keep, and the answer named for what it does", async () => {
    const onConfirm = mock(() => {});
    const close = mock(() => {});
    const user = userEvent.setup();
    const view = render(
      <Confirm
        title="Delete Mock GitLab"
        warn="Its stored token is deleted."
        note="One that sync targets still use cannot be deleted."
        go="Delete Mock GitLab"
        onConfirm={onConfirm}
        close={close}
      />,
    );
    const box = screen.getByRole("alertdialog", { name: "Delete Mock GitLab" });
    // a warning is read in turn, not announced as a failure: only a refusal is an alert
    expect(
      within(box).getByText("Its stored token is deleted.").closest(".callout"),
    ).not.toBeNull();
    expect(within(box).queryByRole("alert")).toBeNull();
    expect(
      within(box).getByText("One that sync targets still use cannot be deleted."),
    ).toBeDefined();
    expect(document.activeElement).toBe(within(box).getByRole("button", { name: "Keep" }));
    await user.click(within(box).getByRole("button", { name: "Keep" }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(within(box).getByRole("button", { name: "Delete Mock GitLab" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // a refusal stays in the dialog, as an alert
    view.rerender(
      <Confirm
        title="Delete Mock GitLab"
        warn="Its stored token is deleted."
        go="Delete Mock GitLab"
        error="Sync targets still use this connection."
        onConfirm={onConfirm}
        close={close}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("Sync targets still use this connection.");
    expect(box.contains(screen.getByRole("alert"))).toBe(true);
  });
});

describe("Drawer", () => {
  function Host({ closed = mock(() => {}) }: { closed?: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open it
        </button>
        {open && (
          <Drawer
            title="COLOR in dev"
            close={() => {
              closed();
              setOpen(false);
            }}
          >
            <button type="button">First</button>
            <input aria-label="Middle" />
            <button type="button">Last</button>
          </Drawer>
        )}
      </>
    );
  }
  const opened = async (closed = mock(() => {})) => {
    const user = userEvent.setup();
    render(<Host closed={closed} />);
    const opener = screen.getByRole("button", { name: "Open it" });
    await user.click(opener);
    return { user, opener, closed, dialog: screen.getByRole("dialog", { name: "COLOR in dev" }) };
  };
  const scrim = () => document.querySelector(".drawer-scrim") as HTMLElement;

  test("is a modal dialog named by its title, which is not a second heading on the page", async () => {
    const { dialog } = await opened();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.queryByRole("heading")).toBeNull();
    // the name is the title's own text, by reference
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent).toBe(
      "COLOR in dev",
    );
  });

  test("is not on the page until it is opened", () => {
    render(<Host />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  test("focus goes into it when it opens", async () => {
    const { dialog } = await opened();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  test("Tab from the last control goes to the first, and Shift+Tab from the first goes to the last", async () => {
    const { user, dialog } = await opened();
    const close = screen.getByRole("button", { name: "Close drawer" });
    const last = screen.getByRole("button", { name: "Last" });
    last.focus();
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
    // in between, the order is the page's own
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  test("Tab from the dialog itself, before anything is focused in it, goes to its first control", async () => {
    const { user, dialog } = await opened();
    dialog.focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close drawer" }));
  });

  test("Esc closes it, and focus is back on the button that opened it", async () => {
    const { user, opener, closed } = await opened();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  test("the close button closes it, and focus goes back", async () => {
    const { user, opener, closed } = await opened();
    await user.click(screen.getByRole("button", { name: "Close drawer" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  test("a press on the scrim closes it; a press inside does not", async () => {
    const { user, dialog, closed } = await opened();
    await user.click(screen.getByRole("button", { name: "Last" }));
    await user.click(dialog);
    expect(closed).toHaveBeenCalledTimes(0);
    expect(scrim()).toBeTruthy();
    await user.click(scrim());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  // VUI-18: the header is the title, a line saying what the drawer is for, and the one Close
  test("its header holds the title, a line for what it is for and the one Close; neither line is a heading", () => {
    render(
      <Drawer title="COLOR in dev" sub="Audit its history" close={() => {}}>
        <button type="button">First</button>
      </Drawer>,
    );
    const dialog = screen.getByRole("dialog", { name: "COLOR in dev" });
    const head = dialog.querySelector(".drawer-head") as HTMLElement;
    const sub = within(head).getByText("Audit its history");
    expect(sub.classList.contains("drawer-sub")).toBe(true);
    expect(head.contains(within(head).getByText("COLOR in dev"))).toBe(true);
    expect(
      within(head)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Close drawer"]);
    expect(screen.queryByRole("heading")).toBeNull();
    // the line is the dialog's description, by reference
    expect(dialog.getAttribute("aria-describedby")).toBe(sub.id);
    expect(sub.id).not.toBe("");
  });

  test("without a sub there is no empty line and no description", () => {
    render(
      <Drawer title="COLOR in dev" close={() => {}}>
        <button type="button">First</button>
      </Drawer>,
    );
    expect(document.querySelector(".drawer-sub")).toBeNull();
    expect(screen.getByRole("dialog").hasAttribute("aria-describedby")).toBe(false);
  });

  test("what it holds can tell that it is in a drawer, and what is outside one can tell that it is not", () => {
    const Where = () => <span>{useInDrawer() ? "in a drawer" : "on the page"}</span>;
    render(
      <>
        <Where />
        <Drawer title="COLOR in dev" close={() => {}}>
          <Where />
        </Drawer>
      </>,
    );
    expect(screen.getByText("on the page")).toBeTruthy();
    expect(within(screen.getByRole("dialog")).getByText("in a drawer")).toBeTruthy();
  });

  test("the scrim is no stop for the keyboard and is not read out", async () => {
    await opened();
    expect(scrim().getAttribute("aria-hidden")).toBe("true");
    expect(scrim().getAttribute("tabindex")).toBe("-1");
  });

  test("the page behind does not scroll while it is open, and does again after, whatever it was before", async () => {
    document.body.style.overflow = "auto";
    try {
      const { user } = await opened();
      expect(document.body.style.overflow).toBe("hidden");
      await user.keyboard("{Escape}");
      expect(document.body.style.overflow).toBe("auto");
    } finally {
      document.body.style.overflow = "";
    }
  });

  test("the page scrolls again when the drawer goes away without being closed (the page it was on changed)", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Host />);
    await user.click(screen.getByRole("button", { name: "Open it" }));
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
  });

  test("Esc does nothing once it is closed (no key handler is left behind)", async () => {
    const { user, closed } = await opened();
    await user.keyboard("{Escape}");
    await user.keyboard("{Escape}");
    expect(closed).toHaveBeenCalledTimes(1);
  });

  test("an opener that is gone by the time it closes is not an error, and focus is left where it is", async () => {
    function Gone() {
      const [step, setStep] = useState<"idle" | "open" | "closed">("idle");
      return (
        <>
          {step === "idle" && (
            <button type="button" onClick={() => setStep("open")}>
              Open it
            </button>
          )}
          {step === "open" && (
            <Drawer title="COLOR in dev" close={() => setStep("closed")}>
              <button type="button">First</button>
            </Drawer>
          )}
        </>
      );
    }
    const user = userEvent.setup();
    render(<Gone />);
    await user.click(screen.getByRole("button", { name: "Open it" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});
