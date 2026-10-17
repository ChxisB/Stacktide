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
