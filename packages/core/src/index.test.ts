import { expect, test } from "bun:test";
import { APP_NAME } from "./index";

test("core package is wired into the workspace test run", () => {
  expect(APP_NAME).toBe("orch");
});
