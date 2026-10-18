/** How long an organization may keep its audit events before the purge job may delete them. Shorter is refused: a typo must not empty the log. */
export const AUDIT_RETENTION_MIN_DAYS = 30;
export const AUDIT_RETENTION_MAX_DAYS = 3650;
