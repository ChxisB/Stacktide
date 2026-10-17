/**
 * An expected failure the API reports to the client as-is. `code` is the stable machine-readable
 * identifier and `message` is shown to the client, so it must never contain a secret or a
 * submitted value: use ids and key names.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(`DomainError status must be 4xx or 5xx, got ${status}`);
    }
  }
}
