import { expect, test } from "bun:test";
import { dayLabel, sameDay } from "../src/lib/format";

test("chat date separators", () => {
  const now = new Date(2026, 10, 23, 15, 0); // Mon 23 Nov 2026
  expect(dayLabel(new Date(2026, 10, 23, 1, 0).toISOString(), now)).toBe("Today");
  expect(dayLabel(new Date(2026, 10, 22, 23, 59).toISOString(), now)).toBe("Yesterday");
  expect(dayLabel(new Date(2026, 10, 19, 12, 0).toISOString(), now)).toMatch(/Thursday/);
  expect(dayLabel(new Date(2026, 9, 2, 12, 0).toISOString(), now)).toMatch(/2/);
  expect(dayLabel(new Date(2025, 9, 2, 12, 0).toISOString(), now)).toMatch(/2025/);
  expect(sameDay(new Date(2026, 10, 23, 0, 1).toISOString(), new Date(2026, 10, 23, 23, 59).toISOString())).toBe(true);
});
