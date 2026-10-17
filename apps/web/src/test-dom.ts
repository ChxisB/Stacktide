import { GlobalRegistrator } from "@happy-dom/global-registrator";

// A DOM for component tests. The web-standard classes stay Bun's own: the API runs in this process
// (the tests use the real app), and its Request/Response/URL must not be happy-dom's look-alikes.
const keep = [
  "fetch",
  "Request",
  "Response",
  "Headers",
  "FormData",
  "Blob",
  "File",
  "URL",
  "URLSearchParams",
  "AbortController",
  "AbortSignal",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "TextEncoder",
  "TextDecoder",
] as const;
const native = Object.fromEntries(keep.map((name) => [name, Reflect.get(globalThis, name)]));
GlobalRegistrator.register({ url: "http://localhost/" });
Object.assign(globalThis, native);
