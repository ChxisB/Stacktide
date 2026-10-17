import { afterEach } from "bun:test";
import { cleanup } from "@testing-library/react";

// A separate preload, run after test-dom.ts: testing-library reads `document` when it is first
// imported, so the DOM must exist by then.
afterEach(() => {
  cleanup();
  window.location.hash = "";
});
