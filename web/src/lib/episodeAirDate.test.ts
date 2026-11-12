import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { episodeAirDateLabel } from "./episodeAirDate";

const validDates = [
  "2022-10-09", "2022-01-01", "2021-12-31", "1999-12-31",
  "2000-02-29", "2024-02-29", "2024-03-01", "2024-03-10", "2024-11-03",
];

function inTimeZone(timeZone: string, locale?: string) {
  const modulePath = fileURLToPath(new URL("./episodeAirDate.ts", import.meta.url));
  const script = `
    import { pathToFileURL } from 'node:url';
    const NativeDateTimeFormat = Intl.DateTimeFormat;
    const locale = ${JSON.stringify(locale)};
    // Simulate only the default locale; Windows ICU ignores POSIX locale variables.
    if (locale !== undefined) {
      Intl.DateTimeFormat = new Proxy(NativeDateTimeFormat, {
        construct(Target, args) {
          return Reflect.construct(Target, [args[0] === undefined ? locale : args[0], args[1]]);
        },
      });
    }
    const { episodeAirDateLabel } = await import(pathToFileURL(${JSON.stringify(modulePath)}));
    const dates = ${JSON.stringify(validDates)};
    const options = { month: 'short', day: 'numeric', year: 'numeric' };
    const formatter = new NativeDateTimeFormat(locale, { ...options, timeZone: 'UTC' });
    const actual = dates.map(episodeAirDateLabel);
    const expected = dates.map((value) => {
      const [year, month, day] = value.split('-').map(Number);
      return formatter.format(new Date(Date.UTC(year, month - 1, day, 12)));
    });
    const predecessorControl = new Intl.DateTimeFormat(undefined, options)
      .format(new Date('2022-10-09T00:00:00Z'));
    console.log(JSON.stringify({ actual, expected, predecessorControl,
      zone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: new Intl.DateTimeFormat().resolvedOptions().locale }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, TZ: timeZone },
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    actual: string[]; expected: string[]; predecessorControl: string; zone: string; locale: string;
  };
}

describe("episodeAirDateLabel", () => {
  // Actual fresh Node processes control the default zone, including on UTC CI.
  it.each(["UTC", "America/Halifax", "America/Los_Angeles", "Pacific/Kiritimati"])(
    "preserves calendar, leap and year boundaries under default time zone %s",
    (zone) => {
      const result = inTimeZone(zone);
      expect(result.zone).toBe(zone);
      expect(result.actual).toEqual(result.expected);
      if (zone === "America/Halifax" || zone === "America/Los_Angeles") {
        expect(result.predecessorControl).not.toBe(result.expected[0]);
      } else {
        expect(result.predecessorControl).toBe(result.expected[0]);
      }
    },
  );

  it.each(["fr-CA", "ja-JP"])("retains the default locale %s", (locale) => {
    const result = inTimeZone("America/Halifax", locale);
    expect(result.actual).toEqual(result.expected);
    expect(result.locale).toBe(locale);
  });

  it.each([
    null, undefined, "", " ", "not-a-date", "2022-10-09T00:00:00Z",
    "2024-2-09", "2024-02-9", "2024-01-01junk", "2024-00-01", "2024-13-01",
    "2024-01-00", "2024-01-32", "2024-04-31", "2024-02-30", "2023-02-29", "1900-02-29",
  ])("omits missing, malformed or impossible calendar date %s", (value) => {
    expect(episodeAirDateLabel(value)).toBeNull();
  });
});
