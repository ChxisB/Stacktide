/** What a lease may be, fixed by ADR-0014: a change here is a change to that decision. */
export const LEASE_TTL_SECONDS = { min: 60, default: 3600, max: 86_400 } as const;
/** Live leases one principal may hold at a time, so a loop in a pipeline cannot mint without end. */
export const LEASES_PER_PRINCIPAL = 20;
/** Read-only, and the only scopes a lease can carry: the request cannot widen what the connection mints. */
export const LEASE_SCOPES = ["read_api", "read_repository", "read_registry"] as const;
export type LeaseScope = (typeof LEASE_SCOPES)[number];
/** GitLab's Reporter level: enough to read and pull, nothing that writes. */
export const LEASE_ACCESS_LEVEL = 20;
