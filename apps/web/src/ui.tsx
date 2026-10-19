import { useState } from "react";
/** Shown while a page's data loads; announced politely to screen readers. */
export function Loading({ what = "Loading" }: { what?: string }) {
  return (
    <p className="muted" role="status" aria-busy="true">
      {what}…
    </p>
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
  return (
    <div className="stack">
      <label>
        Organization slug
        <input value={slug} onChange={(e) => setSlug(e.target.value)} autoComplete="off" />
      </label>
      {slug.trim() && (
        <a className="button" href={ssoPath(slug, query)}>
          {label}
        </a>
      )}
    </div>
  );
}
