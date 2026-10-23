import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import {
  Card,
  Chips,
  Drawer,
  Kpi,
  Named,
  PageHead,
  Popover,
  RowMenu,
  StatusBadge,
  type Tone,
  useInDrawer,
} from "./components";
import { visibleText } from "./testing";

describe("PageHead", () => {
  test("is the page's heading, with the eyebrow, lede and actions around it", () => {
    render(
      <PageHead
        eyebrow="Delivery"
        title="Pipeline"
        lede="Set up CI for a project."
        actions={<button type="button">Open merge request</button>}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Pipeline" })).toBeTruthy();
    expect(screen.getByText("Delivery")).toBeTruthy();
    expect(screen.getByText("Set up CI for a project.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open merge request" })).toBeTruthy();
  });

  test("needs only a title", () => {
    const { container } = render(<PageHead title="Home" />);
    expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
    expect(container.querySelector(".eyebrow, .lede, .actions")).toBeNull();
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
