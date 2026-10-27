import {
  type ComponentProps,
  createContext,
  type KeyboardEvent as ReactKeyEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { type Theme, useTheme } from "./theme";

// 24px outline icons (stroke paths) for buttons whose name is their `aria-label` and `title`, not a word beside them
const ICONS = {
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  filter: "M4 6h16M7 12h10M10 18h4",
  download: "M12 4v11M7 11l5 5 5-5M5 20h14",
  down: "M6 9l6 6 6-6",
  next: "M9 6l6 6-6 6",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  key: "M8 11a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM11 12l9-9M17 6l3 3M14 9l2 2",
  copy: "M9 9h11v11H9zM5 15V4h11",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  close: "M6 6l12 12M18 6L6 18",
  tick: "M5 12.5l4.5 4.5L19 7.5",
  circle: "M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z",
  edit: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  "eye-off":
    "M3 3l18 18M10.6 6.1A9.7 9.7 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.1 3.7M6.6 7.6C3.9 9.3 2 12 2 12s4 7 10 7c1.5 0 2.9-.4 4.1-1M9.9 9.9a3 3 0 0 0 4.2 4.2",
  restore: "M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4",
  clock: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4l3 2",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 7.5v.1",
  success: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12.4l2.7 2.7L16 9.6",
  warning: "M12 3.5l9 15.5H3zM12 10v4M12 16.5v.1",
  error: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5v5M12 16v.1",
};

/** A decorative icon: a screen reader gets the name of the button around it, never the picture. */
export function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} />
    </svg>
  );
}

const THEMES: { theme: Theme; label: string }[] = [
  { theme: "dark", label: "Dark" },
  { theme: "light", label: "Light" },
];

/** Dark or light, as two toggle buttons: one is always pressed, so the control never reads as unset. */
export function ThemeToggle() {
  const { theme, choose } = useTheme();
  return (
    <fieldset className="seg">
      <legend className="visually-hidden">Colour theme</legend>
      {THEMES.map((t) => (
        <button
          key={t.theme}
          type="button"
          aria-pressed={theme === t.theme}
          onClick={() => choose(t.theme)}
        >
          {t.label}
        </button>
      ))}
    </fieldset>
  );
}

/** The top of a page: the page's one `<h1>`, with a lede below and actions beside it. */
export function PageHead(props: { title: string; lede?: string; actions?: ReactNode }) {
  return (
    <header className="head">
      <div>
        <h1>{props.title}</h1>
        {props.lede && <p className="lede">{props.lede}</p>}
      </div>
      {props.actions && <div className="actions">{props.actions}</div>}
    </header>
  );
}

/** A panel. With a title it is a region named by it (so a screen reader can jump to it); `label` names it when the title alone is not the name. */
export function Card(props: {
  title?: string;
  label?: string;
  sub?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section
      className="card card-flow"
      aria-label={props.label}
      aria-labelledby={props.title && !props.label ? id : undefined}
    >
      {props.title && (
        <div className="card-head">
          <div>
            <h2 id={id}>{props.title}</h2>
            {props.sub && <p className="card-sub">{props.sub}</p>}
          </div>
          {props.actions && <div className="actions">{props.actions}</div>}
        </div>
      )}
      {props.children}
    </section>
  );
}

export type Tone = "ok" | "bad" | "warn" | "active" | "manual" | "quiet";
// One shape per tone, so colour is never the only signal.
const GLYPH: Record<Tone, { half?: string; mark?: string }> = {
  ok: { mark: "M5.4 9.3l2.4 2.3 4.7-5" },
  bad: { mark: "M6.2 6.2l5.6 5.6M11.8 6.2l-5.6 5.6" },
  warn: { mark: "M9 5v5M9 12.6h.01" },
  active: { half: "M9 1.4a7.6 7.6 0 0 1 0 15.2z" },
  manual: { mark: "M7 6.4v5.2M11 6.4v5.2" },
  quiet: { mark: "M5.8 9h6.4" },
};

/** The shape of a tone on its own, for a list that carries its words elsewhere. Decoration only. */
export function Glyph({ tone }: { tone: Tone }) {
  const g = GLYPH[tone];
  return (
    <svg className="glyph" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <circle className="g-ring" cx="9" cy="9" r="8" />
      {g.half && <path className="g-half" d={g.half} />}
      {g.mark && <path className="g-mark" d={g.mark} />}
    </svg>
  );
}

export type CalloutTone = "info" | "ok" | "warn" | "bad";
const CALLOUT_ICON = { info: "info", ok: "success", warn: "warning", bad: "error" } as const;

/** A message in a box: a glyph and words in one of four tones, and under them the button that answers it (`action`). Only a bad one is announced at once (`role="alert"`). */
export function Callout(props: {
  tone: CalloutTone;
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={`callout callout-${props.tone}`}
      role={props.tone === "bad" ? "alert" : undefined}
    >
      <Icon name={CALLOUT_ICON[props.tone]} />
      <div>
        {props.title && (
          <>
            <b>{props.title}</b>{" "}
          </>
        )}
        {props.children}
        {props.action && <div className="callout-action">{props.action}</div>}
      </div>
    </div>
  );
}

/** A place with nothing in it, or that failed (`tone="bad"`, announced): what belongs here and the button that fixes it. */
export function Empty(props: { title: string; text: ReactNode; action?: ReactNode; tone?: "bad" }) {
  const bad = props.tone === "bad";
  return (
    <div className={bad ? "empty empty-bad" : "empty"} role={bad ? "alert" : undefined}>
      <div className="orb">
        <Icon name={bad ? "error" : "folder"} />
      </div>
      <h3 className="empty-title">{props.title}</h3>
      <p>{props.text}</p>
      {props.action && <div className="empty-action">{props.action}</div>}
    </div>
  );
}

/** A state in words with a shape beside it. The words are always there; the shape is decoration. */
export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`st st-${tone}`}>
      <Glyph tone={tone} />
      {children}
    </span>
  );
}

/** A short word for people, the whole name for assistive technology: "Retry" beside a row that already says which. */
export function Named({ word, name }: { word: string; name: string }) {
  return (
    <>
      {word}
      <span className="visually-hidden"> {name}</span>
    </>
  );
}

/** One figure with its label, and a foot line that is a link when `footHref` is given. shortcut: no trend or meter, as no screen has a history to draw from. */
export function Kpi(props: {
  label: string;
  value: string | number;
  unit?: string;
  foot?: string;
  footHref?: string;
}) {
  return (
    <div className="kpi">
      <span className="kpi-label">{props.label}</span>
      <span className="kpi-value">
        {props.value}
        {props.unit && (
          <>
            {" "}
            <small>{props.unit}</small>
          </>
        )}
      </span>
      {props.foot && (
        <span className="kpi-foot">
          {props.footHref ? <a href={props.footHref}>{props.foot}</a> : props.foot}
        </span>
      )}
    </div>
  );
}

/** A filter: a group of toggle buttons with one pressed. The parent owns the chosen key. */
export function Chips(props: {
  label: string;
  items: { key: string; label: string; n?: number }[];
  value: string;
  pick: (key: string) => void;
}) {
  return (
    <fieldset className="chips">
      <legend className="visually-hidden">{props.label}</legend>
      {props.items.map((i) => (
        <button
          key={i.key}
          type="button"
          className="chip"
          aria-pressed={i.key === props.value}
          onClick={() => props.pick(i.key)}
        >
          {i.label}
          {i.n !== undefined && (
            <>
              {" "}
              <span className="n">{i.n}</span>
            </>
          )}
        </button>
      ))}
    </fieldset>
  );
}

/** While `open`, Esc closes it with focus back on `button`, and so does a press anywhere outside `box`. */
function useDismiss(
  open: boolean,
  box: RefObject<HTMLElement | null>,
  button: RefObject<HTMLElement | null>,
  setOpen: (open: boolean) => void,
) {
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open, box, button, setOpen]);
}

/**
 * A button that opens a small panel under it. Esc closes it, with focus back on the button, and so does a press anywhere outside. `count` (above zero) shows beside the label.
 * With `shown` the button reads as the choice made in it ("dev" for an Environment menu): that is its text, and its name is the label and the choice.
 * The panel may be a function of `close`, which closes it with the focus back on the button, for a panel that opens something else.
 */
export function Popover(props: {
  label: string;
  icon?: keyof typeof ICONS;
  count?: number;
  shown?: string;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useDismiss(open, box, button, setOpen);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  return (
    <div className="popover" ref={box}>
      <button
        type="button"
        ref={button}
        aria-label={props.shown === undefined ? undefined : `${props.label}: ${props.shown}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {props.icon && <Icon name={props.icon} />}
        {props.shown === undefined ? (
          props.label
        ) : (
          <>
            <span className="shown">{props.shown}</span>
            <Icon name="down" />
          </>
        )}
        {props.count ? <span className="n">{props.count}</span> : null}
      </button>
      {open && (
        <fieldset id={id} className="popover-panel">
          <legend className="visually-hidden">{props.label}</legend>
          {typeof props.children === "function" ? props.children(close) : props.children}
        </fieldset>
      )}
    </div>
  );
}

const ITEM_HEIGHT = 36;
const itemsOf = (list: HTMLElement | null) => [
  ...(list?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
];

/**
 * A ⋯ button that opens a menu of actions (the menu button pattern): arrows, Home and End move, Esc and a press outside close, Tab moves on.
 * The menu is `position: fixed` at the button, because the table around it scrolls and would cut it off; scrolling or resizing closes it.
 * shortcut: no type-ahead (first letter), no sub-menus; add them when a menu has more than a handful of items.
 */
export function RowMenu(props: {
  label: string;
  /** Shows `label` as the button's text, in the action colour with an arrow, in place of a ⋯ icon. */
  labelled?: boolean;
  items: { label: string; run: () => void; danger?: boolean }[];
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{
    top?: number;
    bottom?: number;
    right: number;
    transformOrigin?: string;
    /** -1 when the menu is over its button: the pop-in keyframe moves it toward the button either way. */
    "--menu-dir"?: number;
  }>({ right: 0 });
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useDismiss(open, box, button, setOpen);
  useEffect(() => {
    if (!open) return;
    itemsOf(list.current)[0]?.focus({ preventScroll: true });
    const close = () => setOpen(false);
    // Tab to something outside closes it, the focus already on its way there (a press that focuses nothing is `useDismiss`'s)
    const left = (e: FocusEvent) => {
      if (!box.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("focusin", left);
    // capture: a scroll of the table's own box does not bubble
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("focusin", left);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  const show = () => {
    const r = button.current?.getBoundingClientRect();
    if (r) {
      const high = props.items.length * ITEM_HEIGHT + 10;
      const below = window.innerHeight - r.bottom;
      // under the button, or over it when the page ends before the menu does; it pops from the corner by the button
      setAt({
        right: window.innerWidth - r.right,
        ...(below < high && r.top > below
          ? {
              bottom: window.innerHeight - r.top + 4,
              transformOrigin: "bottom right",
              "--menu-dir": -1,
            }
          : { top: r.bottom + 4, transformOrigin: "top right" }),
      });
    }
    setActive(0);
    setOpen(true);
  };
  const choose = (run: () => void) => {
    setOpen(false);
    button.current?.focus();
    run();
  };
  const key = (e: ReactKeyEvent) => {
    const nodes = itemsOf(list.current);
    const now = nodes.indexOf(document.activeElement as HTMLElement);
    const to = {
      ArrowDown: (now + 1) % nodes.length,
      ArrowUp: (now - 1 + nodes.length) % nodes.length,
      Home: 0,
      End: nodes.length - 1,
    }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    nodes[to]?.focus({ preventScroll: true });
  };
  return (
    <div className="row-menu" ref={box}>
      <button
        type="button"
        className={props.labelled ? "primary" : "icon quiet"}
        ref={button}
        aria-label={props.labelled ? undefined : props.label}
        title={props.labelled ? undefined : props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open && e.key === "ArrowDown") {
            e.preventDefault();
            show();
          }
        }}
      >
        {props.labelled ? (
          <>
            {props.label}
            <Icon name="down" />
          </>
        ) : (
          <Icon name="more" />
        )}
      </button>
      {open && (
        <div
          id={id}
          className="menu"
          role="menu"
          aria-label={props.label}
          ref={list}
          style={at}
          onKeyDown={key}
        >
          {props.items.map((item, i) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? "danger" : undefined}
              tabIndex={i === active ? 0 : -1}
              onFocus={() => setActive(i)}
              onClick={() => choose(item.run)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const InDrawer = createContext(false);
/** True under a `Drawer`: what it holds drops the heading its header already gives. */
export const useInDrawer = () => useContext(InDrawer);

/** The boxes of the modals that are open, the last one on top. */
let openModals: HTMLElement[] = [];
let pageOverflow = "";

/**
 * What a modal does around its box, for `Drawer` and `Dialog` alike: focus goes in and comes back to what opened it, Tab
 * stays inside, Esc closes it, and the page behind does not scroll. `on` is false while the box is not a modal (the shell's
 * sidebar is one only as the phone menu, and is always mounted).
 * shortcut: the page behind is covered, not `inert`, so a screen reader's own virtual cursor can still leave it; add `inert` to the app root if that matters.
 */
export function useModal(box: RefObject<HTMLElement | null>, close: () => void, on = true) {
  useEffect(() => {
    if (!on) return;
    // what had the focus before it moved in: the button that opened this
    const opener = document.activeElement;
    const mine = box.current;
    // the page's own overflow is kept by the first modal and given back by the last, in whatever order they go
    if (openModals.length === 0) pageOverflow = document.body.style.overflow;
    if (mine) openModals = [...openModals, mine];
    document.body.style.overflow = "hidden";
    box.current?.focus();
    return () => {
      openModals = openModals.filter((m) => m !== mine);
      if (openModals.length === 0) document.body.style.overflow = pageOverflow;
      // what opened it may be gone with what it did (a row deleted): then the page's main, not the body
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      else document.getElementById("main")?.focus();
    };
  }, [box, on]);
  useEffect(() => {
    if (!on) return;
    const keys = (e: KeyboardEvent) => {
      // a dialog over a drawer: Esc and Tab are the one on top's alone
      if (openModals.at(-1) !== box.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const all = [...(box.current?.querySelectorAll<HTMLElement>(TABBABLE) ?? [])];
      const [first, last] = [all[0], all.at(-1)];
      // at either end, the other end: so Tab never reaches the page behind
      if (
        e.shiftKey &&
        (document.activeElement === first || document.activeElement === box.current)
      ) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  }, [box, close, on]);
}

/**
 * A panel from the right edge, as a modal dialog: named by `title` (a line, not a heading: what it holds brings its own),
 * focus goes in and comes back to what opened it, Tab stays inside, Esc and the scrim close it, and the page behind does
 * not scroll. It is drawn on the body, so no card or table around its caller can cut it off or sit over it.
 */
export function Drawer(props: {
  title: string;
  /** One line under the title for what the drawer is for; the dialog's description. */
  sub?: string;
  close: () => void;
  /** In the middle of the screen, as a box, for a form of a field or two. */
  centered?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const subId = useId();
  const box = useRef<HTMLDialogElement>(null);
  const { close } = props;
  useModal(box, close);
  return createPortal(
    <div className="drawer-layer">
      <button
        type="button"
        className="drawer-scrim"
        tabIndex={-1}
        aria-hidden="true"
        onClick={close}
      />
      <dialog
        open
        ref={box}
        tabIndex={-1}
        className={props.centered ? "drawer centered" : "drawer"}
        aria-modal="true"
        aria-labelledby={id}
        aria-describedby={props.sub ? subId : undefined}
      >
        <div className="drawer-head">
          <div>
            <p id={id} className="drawer-title">
              {props.title}
            </p>
            {props.sub && (
              <p id={subId} className="drawer-sub">
                {props.sub}
              </p>
            )}
          </div>
          <button
            type="button"
            className="icon quiet"
            aria-label="Close drawer"
            title="Close drawer"
            onClick={close}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="drawer-body">
          <InDrawer.Provider value={true}>{props.children}</InDrawer.Provider>
        </div>
      </dialog>
    </div>,
    document.body,
  );
}

const FIELDS = "input:not([disabled]), select:not([disabled]), textarea:not([disabled])";

/**
 * One question with two answers, as a modal: a heading, what it means, the fields it needs (`children`), an error line,
 * and Cancel then the answer. A destructive one is an alert dialog, its answer is the solid danger button and the focus
 * starts on Cancel; one with fields starts on the first. While `busy` both buttons are disabled and the answer says so, and
 * when the work stops (the error says why) the focus is back on the answer. Enter in a field answers it.
 * `children` are fields, not a form: the dialog is the form. Under 600px it is a sheet on the bottom edge.
 */
export function Dialog(props: {
  title: string;
  /** What it means, in one line; the dialog's description. */
  sub?: string;
  /** The answer that closes it without doing anything; "Cancel" unless the caller says what it keeps. */
  cancel?: string;
  /** The answer that does it, named for what it does ("Delete variable"), never "OK". */
  confirm: string;
  destructive?: boolean;
  busy?: boolean;
  /** The answer cannot be given yet (what it would do is not known): shut, but nothing is under way, so nothing says busy. */
  disabled?: boolean;
  error?: string;
  onConfirm: () => void;
  close: () => void;
  children?: ReactNode;
}) {
  const id = useId();
  const subId = useId();
  const box = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const wasBusy = useRef(false);
  const { busy, destructive } = props;
  // in the middle of the work, Esc and the scrim wait as the Cancel button does: the answer would be lost
  const close = busy ? () => {} : props.close;
  useModal(box, close);
  // after the modal's own focus move, which also took the opener to give it back to
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the first render decides where the focus starts
  useEffect(() => {
    (destructive ? cancel.current : box.current?.querySelector<HTMLElement>(FIELDS))?.focus();
  }, []);
  useEffect(() => {
    if (wasBusy.current && !busy) confirm.current?.focus();
    wasBusy.current = !!busy;
  }, [busy]);
  return createPortal(
    <div className="drawer-layer">
      <button
        type="button"
        className="drawer-scrim"
        tabIndex={-1}
        aria-hidden="true"
        onClick={close}
      />
      <dialog
        open
        ref={box}
        tabIndex={-1}
        className="dialog"
        role={destructive ? "alertdialog" : undefined}
        aria-modal="true"
        aria-labelledby={id}
        aria-describedby={props.sub ? subId : undefined}
      >
        <form
          className="dialog-form"
          onSubmit={(e) => {
            e.preventDefault();
            // React bubbles a portal's events to its parent: without this, answering from inside a form would submit that form too
            e.stopPropagation();
            if (!busy && !props.disabled) props.onConfirm();
          }}
        >
          <div className="dialog-body">
            <h2 id={id} className="dialog-title">
              {props.title}
            </h2>
            {props.sub && (
              <p id={subId} className="dialog-sub">
                {props.sub}
              </p>
            )}
            {props.children}
            {props.error && <Callout tone="bad">{props.error}</Callout>}
          </div>
          <div className="dialog-foot">
            <button
              type="button"
              ref={cancel}
              className="quiet"
              disabled={busy}
              onClick={props.close}
            >
              {props.cancel ?? "Cancel"}
            </button>
            <button
              type="submit"
              ref={confirm}
              className={destructive ? "danger solid" : "primary"}
              disabled={busy || props.disabled}
              aria-busy={busy || undefined}
            >
              {props.confirm}
            </button>
          </div>
        </form>
      </dialog>
    </div>,
    document.body,
  );
}

/**
 * The one delete question of the Settings screens: what it costs as a warning, what blocks it as a note, "Keep", and the
 * answer named for what it does (`go`). A refusal (`error`) is said in the dialog, which stays.
 */
export function Confirm({
  warn,
  note,
  go,
  ...rest
}: Omit<ComponentProps<typeof Dialog>, "confirm" | "cancel" | "destructive" | "children"> & {
  warn: ReactNode;
  note?: ReactNode;
  go: string;
}) {
  return (
    <Dialog {...rest} cancel="Keep" confirm={go} destructive>
      <Callout tone="warn">{warn}</Callout>
      {note && <p className="muted">{note}</p>}
    </Dialog>
  );
}

const ToastContext = createContext<(text?: ReactNode) => void>(() => {});
/**
 * Report the result of an action: `const toast = useToast(); toast("Variable deleted.")`; `toast()` takes the one on screen away.
 * Does nothing outside a `Toaster`. The words may carry a link, but a toast is gone in 5 s: keep the link somewhere that stays too.
 */
export const useToast = () => useContext(ToastContext);

const TOAST_MS = 5000;

/**
 * Where results are reported, mounted once in the shell. One toast at a time: a new one replaces the one on screen, and it
 * leaves after 5 s or on Dismiss. The words go to a live region that is there before them, so a screen reader hears them;
 * a toast never takes the focus.
 * shortcut: the same words twice in a row are announced once (the region does not change); key the text if that matters.
 */
export function Toaster(props: { children: ReactNode }) {
  const [toast, setToast] = useState<{ text: ReactNode; held?: boolean }>();
  const show = useCallback((text?: ReactNode) => setToast(text ? { text } : undefined), []);
  // while the pointer is on it or the focus is in it the 5 s wait, and start again whole when it leaves
  const hold = (held: boolean) => setToast((t) => t && { ...t, held });
  useEffect(() => {
    if (!toast || toast.held) return;
    const timer = setTimeout(() => setToast(undefined), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <ToastContext.Provider value={show}>
      {props.children}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: it only tells the timer whether the pointer or focus is on the toast */}
      <div
        className={toast ? "toasts on" : "toasts"}
        onMouseEnter={() => hold(true)}
        onMouseLeave={() => hold(false)}
        onFocus={() => hold(true)}
        onBlur={() => hold(false)}
      >
        {toast && <Icon name="success" />}
        <p role="status" className="toast-text">
          {toast?.text}
        </p>
        {toast && (
          <button type="button" className="quiet small" onClick={() => setToast(undefined)}>
            Dismiss
          </button>
        )}
      </div>
    </ToastContext.Provider>
  );
}
