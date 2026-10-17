/** Shown while a page's data loads; announced politely to screen readers. */
export function Loading({ what = "Loading" }: { what?: string }) {
  return (
    <p className="muted" role="status" aria-busy="true">
      {what}…
    </p>
  );
}
