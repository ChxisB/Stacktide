import { useId, useState } from "react";
/** Shown while a page's data loads: the words, announced politely, with two lines drawn under them (decoration). */
export function Loading({ what = "Loading" }: { what?: string }) {
  return (
    <div className="loading" role="status" aria-busy="true">
      <p className="muted">{what}…</p>
      <span className="skel" aria-hidden="true" />
      <span className="skel" aria-hidden="true" />
    </div>
  );
}

// The typed client turns an ISO timestamp into a Date although the type says string: take either.
export const stamp = (at: string | Date) => new Date(at).toISOString();
export const when = (at: string | Date) => `${stamp(at).slice(0, 16).replace("T", " ")} UTC`;

/** Where a sign-in through an organization's provider starts: a full page navigation, the API sends the browser on. */
export const ssoPath = (slug: string, query: string) =>
  `/auth/sso/${encodeURIComponent(slug.trim())}/login?${query}`;

/** The organization to sign in through, typed by its slug, and the link that goes there once one is. */
export function SsoEntry({ query, label }: { query: string; label: string }) {
  const [slug, setSlug] = useState("");
  const id = useId();
  return (
    <div className="stack">
      <div className="field">
        <label htmlFor={id}>Organization slug</label>
        <input
          id={id}
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          autoComplete="off"
          aria-describedby={`${id}-hint`}
        />
        <span className="hint" id={`${id}-hint`}>
          The slug your administrator set for your organization.
        </span>
      </div>
      {slug.trim() && (
        <a className="button" href={ssoPath(slug, query)}>
          {label}
        </a>
      )}
    </div>
  );
}
