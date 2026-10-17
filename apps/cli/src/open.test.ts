import { expect, test } from "bun:test";
import { openCommand } from "./open";

test("the browser is opened with the platform's own launcher", () => {
  expect(openCommand("darwin")).toEqual(["open"]);
  expect(openCommand("win32")).toEqual(["rundll32", "url.dll,FileProtocolHandler"]);
  expect(openCommand("linux")).toEqual(["xdg-open"]);
});
