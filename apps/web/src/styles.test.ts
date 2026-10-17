import { expect, test } from "bun:test";
import { join } from "node:path";

const css = await Bun.file(join(import.meta.dir, "styles.css")).text();
const names = (block: string) => [...block.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]);
const light = css.match(/:root\s*{([^}]*)}/)?.[1] ?? "";
const dark = css.match(/prefers-color-scheme:\s*dark\)\s*{\s*:root\s*{([^}]*)}/)?.[1] ?? "";

test("a dark set overrides only tokens the light set defines, and every colour token has one", () => {
  const colours = names(light).filter((n) =>
    /#[0-9a-f]{3,8}\b/i.test(light.match(new RegExp(`${n}\\s*:\\s*([^;]*);`))?.[1] ?? ""),
  );
  expect(colours.length).toBeGreaterThan(5);
  expect(names(dark).length).toBeGreaterThan(0);
  for (const name of names(dark)) expect(names(light)).toContain(name);
  for (const name of colours) expect(names(dark)).toContain(name);
});

test("every var() names a token, and colours are written only in the token sets", () => {
  const defined = new Set(names(light));
  for (const [, used] of css.matchAll(/var\((--[\w-]+)\)/g))
    expect(defined.has(used ?? "")).toBe(true);
  const rest = css.replace(light, "").replace(dark, "");
  expect(rest.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
});

/** WCAG relative luminance contrast of two #rrggbb colours. */
function contrast(a: string, b: string) {
  const lum = (hex: string) => {
    const [r = 0, g = 0, bl = 0] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}
const value = (block: string, name: string) =>
  block.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-f]{6})`, "i"))?.[1] ?? "";

test("text, muted text, accent buttons and status colours are readable in both sets (WCAG AA, 4.5:1)", () => {
  for (const set of [light, `${light}${dark}`]) {
    // the dark set is read after the light one, so its values win
    const v = (name: string) => {
      const all = [...set.matchAll(new RegExp(`${name}\\s*:\\s*(#[0-9a-f]{6})`, "gi"))];
      return all.at(-1)?.[1] ?? "";
    };
    for (const [fg, bg] of [
      ["--text", "--bg"],
      ["--text", "--surface"],
      ["--muted", "--surface"],
      ["--muted", "--bg"],
      ["--accent-text", "--accent"],
      ["--accent", "--surface"],
      ["--danger", "--surface"],
      ["--ok", "--surface"],
      ["--warn", "--surface"],
    ] as const) {
      expect(contrast(v(fg ?? ""), v(bg ?? ""))).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect(value(light, "--text")).not.toBe("");
});
