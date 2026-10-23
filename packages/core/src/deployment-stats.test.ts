import { describe, expect, test } from "bun:test";
import {
  deploymentStats,
  type EnvironmentStats,
  restoreText,
  type StatsRow,
  statsLine,
} from "./deployment-stats";

const DAY = 86_400_000;
const NOW = new Date(Date.UTC(2026, 9, 21, 12));
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const row = (environment: string, status: string, at: Date): StatsRow => ({
  environment,
  status,
  at,
});
const stats = (rows: StatsRow[], over: { days?: number; environments?: string[] } = {}) =>
  deploymentStats(rows, { now: NOW, days: 14, ...over });
const only = (rows: StatsRow[], over?: { days?: number; environments?: string[] }) =>
  stats(rows, over)[0];

describe("deployment numbers", () => {
  test("successes are counted, and per week is the count over the weeks in the window", () => {
    const r = only([
      row("staging", "success", ago(1 * DAY)),
      row("staging", "success", ago(3 * DAY)),
    ]);
    expect(r).toMatchObject({ environment: "staging", deployments: 2, failed: 0, perWeek: 1 });
    expect(only([row("staging", "success", ago(DAY))], { days: 7 })?.perWeek).toBe(1);
    expect(only([row("staging", "success", ago(DAY))], { days: 28 })?.perWeek).toBe(0.25);
  });

  test("the failure rate is failed over success plus failed; none failed is 0 and nothing at all is null", () => {
    const r = only([
      row("p", "success", ago(5 * DAY)),
      row("p", "success", ago(4 * DAY)),
      row("p", "success", ago(3 * DAY)),
      row("p", "failed", ago(2 * DAY)),
    ]);
    expect(r?.failureRate).toBe(0.25);
    expect(only([row("p", "success", ago(DAY))])?.failureRate).toBe(0);
    expect(only([], { environments: ["p"] })?.failureRate).toBeNull();
  });

  test("a failure then a success gives the time between them", () => {
    const r = only([row("p", "failed", ago(2 * DAY)), row("p", "success", ago(2 * DAY - 600_000))]);
    expect(r?.medianRestoreSeconds).toBe(600);
  });

  test("two failures before one success count from the first", () => {
    const r = only([
      row("p", "failed", ago(2 * DAY)),
      row("p", "failed", ago(2 * DAY - 300_000)),
      row("p", "success", ago(2 * DAY - 900_000)),
    ]);
    expect(r?.medianRestoreSeconds).toBe(900);
    expect(r?.failed).toBe(2);
  });

  test("a failure nobody has fixed yet is no restore, and a new failure after a success starts again", () => {
    expect(only([row("p", "failed", ago(DAY))])?.medianRestoreSeconds).toBeNull();
    const r = only([
      row("p", "failed", ago(5 * DAY)),
      row("p", "success", ago(5 * DAY - 60_000)),
      row("p", "failed", ago(3 * DAY)),
      row("p", "success", ago(3 * DAY - 180_000)),
      row("p", "failed", ago(DAY)),
    ]);
    expect(r?.medianRestoreSeconds).toBe(120); // 60 and 180 seconds: the unfixed failure counts for nothing
  });

  test("the median of an even number is the mean of the middle two, and is whole seconds", () => {
    const fixed = (start: number, seconds: number) => [
      row("p", "failed", ago(start)),
      row("p", "success", ago(start - seconds * 1000)),
    ];
    expect(only([...fixed(5 * DAY, 60), ...fixed(4 * DAY, 61)])?.medianRestoreSeconds).toBe(61);
    expect(
      only([...fixed(5 * DAY, 10), ...fixed(4 * DAY, 500), ...fixed(3 * DAY, 20)])
        ?.medianRestoreSeconds,
    ).toBe(20);
  });

  test("no failures: rate 0 and no restore time", () => {
    const r = only([row("p", "success", ago(DAY))]);
    expect(r).toMatchObject({ failureRate: 0, medianRestoreSeconds: null, failed: 0 });
  });

  test("an empty window gives nulls, with a zero count, for each environment asked about, in that order", () => {
    expect(stats([], { environments: ["staging", "production"] })).toEqual([
      {
        environment: "staging",
        deployments: 0,
        failed: 0,
        perWeek: null,
        failureRate: null,
        medianRestoreSeconds: null,
      },
      {
        environment: "production",
        deployments: 0,
        failed: 0,
        perWeek: null,
        failureRate: null,
        medianRestoreSeconds: null,
      },
    ]);
    expect(stats([])).toEqual([]);
  });

  test("an environment with only failures has a zero a week, a rate of 1 and no restore", () => {
    expect(only([row("p", "failed", ago(DAY))])).toMatchObject({
      deployments: 0,
      perWeek: 0,
      failureRate: 1,
      medianRestoreSeconds: null,
    });
  });

  test("the window's edges: a deployment at its start or at now is in; just before the start or after now is out", () => {
    const edges = [
      row("p", "success", ago(14 * DAY)), // exactly the start
      row("p", "success", NOW), // exactly now
      row("p", "success", ago(14 * DAY + 1)),
      row("p", "success", new Date(NOW.getTime() + 1)),
    ];
    expect(only(edges)?.deployments).toBe(2);
  });

  test("states that are not an outcome do not count, and environments do not borrow from each other", () => {
    const r = stats(
      [
        row("a", "running", ago(DAY)),
        row("a", "canceled", ago(DAY)),
        row("a", "created", ago(DAY)),
        row("a", "failed", ago(3 * DAY)),
        row("b", "success", ago(2 * DAY)),
      ],
      { environments: ["a", "b"] },
    );
    expect(r.map((e) => [e.environment, e.deployments, e.failed, e.medianRestoreSeconds])).toEqual([
      ["a", 0, 1, null],
      ["b", 1, 0, null],
    ]);
  });

  test("rows in any order give the same answer, and an environment nobody listed follows the listed ones by name", () => {
    const ordered = [
      row("p", "failed", ago(2 * DAY)),
      row("p", "success", ago(2 * DAY - 600_000)),
      row("z", "success", ago(DAY)),
      row("m", "success", ago(DAY)),
    ];
    const shuffled = [ordered[3], ordered[1], ordered[2], ordered[0]] as StatsRow[];
    expect(stats(shuffled, { environments: ["z"] })).toEqual(
      stats(ordered, { environments: ["z"] }),
    );
    expect(stats(ordered, { environments: ["z"] }).map((e) => e.environment)).toEqual([
      "z",
      "m",
      "p",
    ]);
  });

  test("a window of nothing is refused, not divided by", () => {
    for (const days of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => stats([], { days })).toThrow();
    }
  });
});

const numbers = (over: Partial<EnvironmentStats> = {}): EnvironmentStats => ({
  environment: "staging",
  deployments: 11,
  failed: 1,
  perWeek: 4,
  failureRate: 1 / 12,
  medianRestoreSeconds: 480,
  ...over,
});

describe("the numbers in words", () => {
  test("a line says how often, how many failed of how many, and how long a fix took, each with its unit", () => {
    expect(statsLine(numbers())).toBe("4 deployments a week · 1 failed in 12 · back in 8 min");
  });

  test("one a week is singular; a fraction has one decimal; ten or more are whole; none is zero", () => {
    expect(statsLine(numbers({ perWeek: 1 }))).toStartWith("1 deployment a week ·");
    expect(statsLine(numbers({ perWeek: 2.5667 }))).toStartWith("2.6 deployments a week ·");
    expect(statsLine(numbers({ perWeek: 12.4 }))).toStartWith("12 deployments a week ·");
    expect(statsLine(numbers({ perWeek: 0.04 }))).toStartWith("0 deployments a week ·");
    expect(statsLine(numbers({ deployments: 0, failed: 2, perWeek: 0 }))).toBe(
      "0 deployments a week · 2 failed in 2 · back in 8 min",
    );
  });

  test("nothing failed is said as nothing failed, and a failure never fixed has no time to be back in", () => {
    expect(statsLine(numbers({ failed: 0, deployments: 5, medianRestoreSeconds: null }))).toBe(
      "4 deployments a week · 0 failed in 5 · back in -",
    );
  });

  test("no deployment at all is a dash, whether the environment is unknown or has no outcome", () => {
    const none = numbers({
      deployments: 0,
      failed: 0,
      perWeek: null,
      failureRate: null,
      medianRestoreSeconds: null,
    });
    expect(statsLine(none)).toBe("-");
    expect(statsLine(undefined)).toBe("-");
  });

  test("a time to restore is in seconds, minutes, hours or days, whichever reads best", () => {
    expect(
      [0, 45, 59, 60, 90, 480, 3_569, 3_580, 3_600, 5_400, 43_200, 172_799, 172_800, 259_200].map(
        restoreText,
      ),
    ).toEqual([
      "0 s",
      "45 s",
      "59 s",
      "1 min",
      "2 min",
      "8 min",
      "59 min",
      "1 h",
      "1 h",
      "1.5 h",
      "12 h",
      "2 d",
      "2 d",
      "3 d",
    ]);
  });
});
