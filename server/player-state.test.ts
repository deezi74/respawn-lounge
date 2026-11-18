import { describe, expect, it } from "vitest";
import {
  localDateTime,
  sourceTime,
  trimmedCaptions,
} from "../client/src/lib/player-state";

describe("connected player state", () => {
  it("maps clip playhead to original source time", () =>
    expect(sourceTime(5, 120)).toBe(125));
  it("keeps original video playhead unchanged", () =>
    expect(sourceTime(12)).toBe(12));
  it("clamps negative positions", () => expect(sourceTime(-1)).toBe(0));
  it("drops captions wholly outside the shortened clip", () =>
    expect(
      trimmedCaptions([{ start: 8, end: 10, text: "late" }], 0, 0, 5)
    ).toEqual([]));
  it("shifts captions when trimming the start and clamps overlaps", () =>
    expect(
      trimmedCaptions(
        [
          { start: 1, end: 4, text: "first" },
          { start: 4, end: 8, text: "next" },
        ],
        10,
        12,
        16
      )
    ).toEqual([
      { start: 0, end: 2, text: "first" },
      { start: 2, end: 4, text: "next" },
    ]));
  it("formats local datetime without repeated timezone drift", () => {
    const before = process.env.TZ;
    process.env.TZ = "America/Chicago";
    try {
      const source = "2026-11-18T22:00:00.000Z";
      expect(localDateTime(source)).toBe("2026-11-18T16:00");
      expect(new Date(localDateTime(source)).toISOString()).toBe(source);
    } finally {
      process.env.TZ = before;
    }
  });
  it("handles invalid schedule input gracefully", () =>
    expect(localDateTime("invalid")).toBe(""));
});
