import type { ItemRef } from "./types";

/** An item as an error names it: the key and the scope, cut short, never a value. */
export const label = ({ key, scope }: ItemRef) =>
  `${JSON.stringify(key.slice(0, 64))} (${scope.slice(0, 64)})`;

/** One string per item, to key a map by. */
export const refId = ({ key, scope }: ItemRef) => JSON.stringify([scope, key]);

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The order a target reads in and a plan lists in: key, then scope, by UTF-16 code unit (not locale). */
export const byKeyThenScope = (a: ItemRef, b: ItemRef) =>
  compare(a.key, b.key) || compare(a.scope, b.scope);
