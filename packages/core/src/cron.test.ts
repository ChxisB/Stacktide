import { describe, expect, test } from "bun:test";
import { nextCronRun, parseCron } from "./cron";

const d = (iso: string) => new Date(iso);
const next = (expr: string, after: string) => nextCronRun(expr, d(after)).toISOString();

describe("nextCronRun", () => {
  test("is strictly after the given time, on whole minutes, in UTC", () => {
    expect(next("* * * * *", "2030-01-01T10:07:30Z")).toBe("2030-01-01T10:08:00.000Z");
    expect(next("* * * * *", "2030-01-01T10:07:00Z")).toBe("2030-01-01T10:08:00.000Z");
    expect(next("7 10 * * *", "2030-01-01T10:07:00Z")).toBe("2030-01-02T10:07:00.000Z");
  });

  test("lists, ranges, steps", () => {
    expect(next("*/15 * * * *", "2030-01-01T10:07:00Z")).toBe("2030-01-01T10:15:00.000Z");
    expect(next("*/15 * * * *", "2030-01-01T10:45:00Z")).toBe("2030-01-01T11:00:00.000Z");
    expect(next("10-30/10 * * * *", "2030-01-01T10:11:00Z")).toBe("2030-01-01T10:20:00.000Z");
    expect(next("5,50 1,13 * * *", "2030-01-01T13:05:00Z")).toBe("2030-01-01T13:50:00.000Z");
  });

  test("rolls over hours, days, months and years", () => {
    expect(next("0 0 1 1 *", "2030-06-15T00:00:00Z")).toBe("2031-01-01T00:00:00.000Z");
    expect(next("30 23 * * *", "2030-12-31T23:30:00Z")).toBe("2031-01-01T23:30:00.000Z");
    expect(next("0 0 31 * *", "2030-04-01T00:00:00Z")).toBe("2030-05-31T00:00:00.000Z"); // April has 30
  });

  test("day of week: 0 and 7 are Sunday, weekdays skip the weekend", () => {
    // 2030-01-01 is a Tuesday.
    expect(next("0 9 * * 1-5", "2030-01-04T09:00:00Z")).toBe("2030-01-07T09:00:00.000Z"); // Fri -> Mon
    expect(next("0 0 * * 0", "2030-01-01T00:00:00Z")).toBe("2030-01-06T00:00:00.000Z");
    expect(next("0 0 * * 7", "2030-01-01T00:00:00Z")).toBe("2030-01-06T00:00:00.000Z");
  });

  test("when both day of month and day of week are restricted, either may match (as in cron)", () => {
    // The 13th, or any Friday. 2030-01-01 is a Tuesday: the first hit is Friday the 4th.
    expect(next("0 0 13 * 5", "2030-01-01T00:00:00Z")).toBe("2030-01-04T00:00:00.000Z");
    expect(next("0 0 13 * 5", "2030-01-12T00:00:00Z")).toBe("2030-01-13T00:00:00.000Z");
  });

  test("leap days are found", () => {
    expect(next("0 0 29 2 *", "2030-01-01T00:00:00Z")).toBe("2032-02-29T00:00:00.000Z");
  });

  test("an expression that can never fire throws instead of looping", () => {
    expect(() => nextCronRun("0 0 30 2 *", d("2030-01-01T00:00:00Z"))).toThrow(/never fires/);
    expect(() => nextCronRun("0 0 31 4,6,9,11 *", d("2030-01-01T00:00:00Z"))).toThrow(
      /never fires/,
    );
  });
});

describe("parseCron", () => {
  test("rejects malformed expressions", () => {
    const bad = [
      "",
      "* * * *",
      "* * * * * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * 32 * *",
      "* * * 13 *",
      "* * * * 8",
      "*/0 * * * *",
      "5-1 * * * *",
      "a * * * *",
      "1,,2 * * * *",
      "1- * * * *",
      "5/10 * * * *",
      "* * * JAN *",
      "* * * * MON",
      "-1 * * * *",
      "1.5 * * * *",
    ];
    for (const expr of bad) expect(() => parseCron(expr), expr).toThrow(TypeError);
  });

  test("tolerates extra whitespace and says what is wrong without echoing a long input", () => {
    expect(() => parseCron("  0   0  * *  *  ")).not.toThrow();
    expect(() => parseCron(`${"9".repeat(500)} * * * *`)).toThrow(/minute/);
    try {
      parseCron(`${"9".repeat(500)} * * * *`);
    } catch (e) {
      expect(String(e).length).toBeLessThan(200);
    }
  });
});
