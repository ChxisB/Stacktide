import { Component, type ErrorInfo, type ReactNode, useEffect, useRef, useState } from "react";
import { ErrorPanel, useMe, useSignOut } from "./auth";
import { ThemeToggle, Toaster, useModal } from "./components";
import { OrgSwitcher } from "./org";
import { href, useRoute } from "./router";

// 24px outline icons (stroke paths); a page picks one by name, and a page with none shows no icon.
const ICONS = {
  grid: "M4 4h6v8H4zM14 4h6v5h-6zM14 13h6v7h-6zM4 16h6v4H4z",
  flow: "M6 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM18 15.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8.5 6H12a4 4 0 0 1 4 4v5.5",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  tmpl: "M4 5h16v14H4zM4 10h16M9 10v9",
  db: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6",
  sync: "M20 11a8 8 0 0 0-14-4M4 13a8 8 0 0 0 14 4M6 3v4h4M18 21v-4h-4",
  sliders: "M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM12 8v5M12 16.5h.01",
  users:
    "M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM20 20v-1.5a3.5 3.5 0 0 0-2.5-3.3M15.5 5.2a3.5 3.5 0 0 1 0 6.6",
  gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8",
};
export type IconName = keyof typeof ICONS;

export interface Page {
  path: string;
  label: string;
  /** The heading it is listed under in the sidebar; pages with none share one list with no heading, where the first of them appears. */
  group?: string;
  icon?: IconName;
  element: ReactNode;
}

/** A screen that throws shows the error where it was, and the rest of the shell keeps working. */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | undefined }
> {
  override state = { error: undefined as Error | undefined };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }
  override render() {
    const { error } = this.state;
    return error ? (
      <ErrorPanel error={error} retry={() => this.setState({ error: undefined })} />
    ) : (
      this.props.children
    );
  }
}

/** The pages by heading, each heading in the order it first appears and each page in the order given. */
function grouped(pages: readonly Page[]) {
  const groups = new Map<string, Page[]>();
  for (const p of pages) groups.set(p.group ?? "", [...(groups.get(p.group ?? "") ?? []), p]);
  return [...groups];
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");

/** The layout of a signed-in user: sidebar with navigation and sign-out, a top bar, and the current page. */
export function Shell({ pages }: { pages: readonly Page[] }) {
  const me = useMe();
  const route = useRoute();
  const signOut = useSignOut();
  const [home] = pages;
  const page = pages.find((p) => p.path === route) ?? home;
  // the page the app opens on is already there and does not enter; every page reached after it does (adjusting state while rendering)
  const [opened, setOpened] = useState(page?.path);
  const [moved, setMoved] = useState(false);
  // below 900 px the sidebar is a menu, and a modal while it is open; any route change closes it
  const [menu, setMenu] = useState(false);
  const side = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  if (page?.path !== opened) {
    setOpened(page?.path);
    setMoved(true);
    setMenu(false);
  }
  const closeMenu = () => setMenu(false);
  useModal(side, closeMenu, menu);
  // it opens onto Close (the modal hook has already noted the button that opened it, to give the focus back)
  useEffect(() => {
    if (menu) closeButton.current?.focus();
  }, [menu]);
  // a window made wider than the phone layout while the menu is open would leave a modal on a desktop page
  useEffect(() => {
    if (!menu) return;
    const narrow = window.matchMedia?.("(max-width: 900px)");
    const widened = () => {
      if (!narrow?.matches) setMenu(false);
    };
    narrow?.addEventListener("change", widened);
    return () => narrow?.removeEventListener("change", widened);
  }, [menu]);
  return (
    <Toaster>
      {/* a button, not a #main link: the hash is the route */}
      <button
        type="button"
        className="skip"
        onClick={() => document.getElementById("main")?.focus()}
      >
        Skip to content
      </button>
      <div className="app">
        {menu && (
          <button
            type="button"
            className="drawer-scrim menu-scrim"
            tabIndex={-1}
            aria-hidden="true"
            onClick={closeMenu}
          />
        )}
        <aside
          ref={side}
          className={menu ? "side open" : "side"}
          {...(menu
            ? { role: "dialog", "aria-modal": true, "aria-label": "Menu", tabIndex: -1 }
            : {})}
        >
          <div className="side-head">
            <a className="brandrow" href={href("")} onClick={closeMenu}>
              <svg className="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
                <circle cx="16" cy="16" r="14" />
                <circle cx="16" cy="16" r="8" />
                <circle className="dot" cx="16" cy="16" r="3" />
              </svg>
              <span className="wordmark">
                Stacktide<small>Control plane</small>
              </span>
            </a>
            <button
              ref={closeButton}
              type="button"
              className="icon quiet menu-close"
              aria-label="Close menu"
              onClick={closeMenu}
            >
              <svg className="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <OrgSwitcher />
          <nav aria-label="Main" className="navwrap">
            {grouped(pages).map(([group, list]) => (
              <div key={group} className="nav">
                {group && <p className="nav-label">{group}</p>}
                {list.map((p) => (
                  <a
                    key={p.path}
                    className="nav-item"
                    href={href(p.path)}
                    // the current page's link is no route change, and the menu closes all the same
                    onClick={closeMenu}
                    aria-current={p.path === page?.path ? "page" : undefined}
                  >
                    {p.icon && (
                      <svg className="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path d={ICONS[p.icon]} />
                      </svg>
                    )}
                    {p.label}
                  </a>
                ))}
              </div>
            ))}
          </nav>
          <div className="side-foot">
            <div className="me">
              <span className="av" aria-hidden="true">
                {initials(me.name)}
              </span>
              <span className="trunc">{me.name}</span>
            </div>
            <button
              type="button"
              className="quiet"
              onClick={() => signOut.mutate()}
              disabled={signOut.isPending}
            >
              Sign out
            </button>
          </div>
        </aside>
        <div className="content">
          <header className="topbar">
            <button
              type="button"
              className="icon quiet menu-btn"
              aria-label="Open menu"
              aria-haspopup="dialog"
              aria-expanded={menu}
              onClick={() => setMenu(true)}
            >
              <svg className="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
            <nav aria-label="Breadcrumb">
              <ol className="crumbs">
                {page?.group && <li>{page.group}</li>}
                {page && <li aria-current="page">{page.label}</li>}
              </ol>
            </nav>
            <ThemeToggle />
          </header>
          <main id="main" tabIndex={-1}>
            {signOut.error && (
              <p role="alert" className="error">
                {signOut.error.message}
              </p>
            )}
            {/* new on each route, so the page enters once per route change and a data refresh, which re-renders it in place, does not */}
            <div key={page?.path} className={moved ? "page-enter" : undefined}>
              <ErrorBoundary>{page?.element}</ErrorBoundary>
            </div>
          </main>
        </div>
      </div>
    </Toaster>
  );
}
