// What the pipeline wizard knows of the API's answers, and the pure parts of it: the form a template
// asks for, the request the form makes, and the line diff of the file.

export interface Param {
  type: "string" | "number" | "integer" | "boolean";
  description?: string | undefined;
  default?: string | number | boolean | undefined;
  enum?: (string | number)[] | undefined;
  pattern?: string | undefined;
  maxLength?: number | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
}
export interface TemplateInfo {
  name: string;
  version: string;
  description: string;
  params: { properties: Record<string, Param>; required: string[] };
  requiresVariables: string[];
}
export interface Config {
  connectionId: string;
  template: string;
  version: string;
  params: Record<string, unknown>;
  mode: "inline" | "include";
  mrIid: number | null;
  mrUrl: string | null;
  updatedAt: string | Date;
}
export interface Recommendation {
  template: string;
  version: string;
  confidence: "high" | "medium";
  reason: string;
}
export interface Overview {
  config: Config | null;
  recommendations: Recommendation[];
  templates: TemplateInfo[];
}

export type Existing = "none" | "identical" | "generated" | "hand-written";
export interface Preview {
  text: string;
  existing: Existing;
  validation: {
    lint: { valid: boolean; errors: string[]; warnings: string[] };
    missingVariables: { environment: string | null; keys: string[] }[];
    violations: { rule: string; message: string }[];
  };
  current: string | null;
}
export interface Applied {
  outcome: "opened" | "updated" | "unchanged" | "in_place";
  mr: { iid: number; url: string } | null;
}
/** What a preview and the apply after it both send: the apply sends what was reviewed. */
export interface Request {
  connectionId: string;
  template: string;
  version: string;
  params: Record<string, unknown>;
}

/** A form field's value: text for everything but a flag. */
export type Values = Record<string, string | boolean>;

/** The form's starting values: what the project was set up with when it was this template, else the defaults. */
export function initialValues(t: TemplateInfo, given: Record<string, unknown> = {}): Values {
  return Object.fromEntries(
    Object.entries(t.params.properties).map(([name, p]) => {
      const v = given[name] ?? p.default;
      return [name, p.type === "boolean" ? v === true : v === undefined ? "" : String(v)];
    }),
  );
}

/** The `params` of a request: only what differs from the template's default, in the type the template declares. */
export function paramsOf(t: TemplateInfo, values: Values): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(t.params.properties)) {
    const v = values[name];
    const required = t.params.required.includes(name);
    if (p.type === "boolean") {
      if (typeof v === "boolean" && (required || v !== (p.default ?? false))) out[name] = v;
    } else if (typeof v === "string" && v !== "") {
      if (!required && p.default !== undefined && v === String(p.default)) continue;
      out[name] = p.type === "string" ? v : Number(v);
    }
  }
  return out;
}

/** The address of a merge request when it is a web address, which is all a link may point to. */
export function webUrl(url: string): string | undefined {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export interface Line {
  kind: "same" | "add" | "del";
  text: string;
}
const MAX_CELLS = 1_000_000;
const lines = (text: string) => (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
const as = (kind: Line["kind"]) => (text: string) => ({ kind, text });

/** The lines between two texts: what is kept, removed and added, in the order of the new text. */
export function lineDiff(before: string | null, after: string): Line[] {
  const b = lines(after);
  if (before === null) return b.map(as("add"));
  const a = lines(before);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length;
  let tailB = b.length;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) {
    tailA--;
    tailB--;
  }
  return [
    ...a.slice(0, head).map(as("same")),
    ...between(a.slice(head, tailA), b.slice(head, tailB)),
    ...a.slice(tailA).map(as("same")),
  ];
}

/** The longest common subsequence of the lines that differ at the ends. */
function between(a: string[], b: string[]): Line[] {
  const n = a.length;
  const m = b.length;
  // shortcut: past a million cells the middle is shown as all removed, then all added (correct, but longer); upgrade to a Myers diff if a pipeline file ever gets that big
  if (n * m > MAX_CELLS) return [...a.map(as("del")), ...b.map(as("add"))];
  const w = m + 1;
  const table = new Uint32Array((n + 1) * w);
  const at = (i: number, j: number) => table[i * w + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] ?? "" });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ kind: "del", text: a[i] ?? "" });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] ?? "" });
      j++;
    }
  }
  for (; i < n; i++) out.push({ kind: "del", text: a[i] ?? "" });
  for (; j < m; j++) out.push({ kind: "add", text: b[j] ?? "" });
  return out;
}
