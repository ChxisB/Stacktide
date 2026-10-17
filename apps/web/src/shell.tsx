import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorPanel, useMe, useSignOut } from "./auth";
import { href, useRoute } from "./router";

export interface Page {
  path: string;
  label: string;
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

/** The layout of a signed-in user: bar with navigation and sign-out, and the current page. */
export function Shell({ pages }: { pages: readonly Page[] }) {
  const me = useMe();
  const route = useRoute();
  const signOut = useSignOut();
  const [home] = pages;
  const page = pages.find((p) => p.path === route) ?? home;
  return (
    <>
      {/* a button, not a #main link: the hash is the route */}
      <button
        type="button"
        className="skip"
        onClick={() => document.getElementById("main")?.focus()}
      >
        Skip to content
      </button>
      <header className="shell-bar">
        <span className="brand">Orchastrature</span>
        <nav aria-label="Main">
          {pages.map((p) => (
            <a
              key={p.path}
              href={href(p.path)}
              aria-current={p.path === page?.path ? "page" : undefined}
            >
              {p.label}
            </a>
          ))}
        </nav>
        <div className="who">
          <span>{me.name}</span>
          <button type="button" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
            Sign out
          </button>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {signOut.error && (
          <p role="alert" className="error">
            {signOut.error.message}
          </p>
        )}
        <ErrorBoundary key={page?.path}>{page?.element}</ErrorBoundary>
      </main>
    </>
  );
}
