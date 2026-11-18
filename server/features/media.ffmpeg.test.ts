import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  captionFile,
  command,
  extractClipAudioFile,
  probeFile,
  renderClipFile,
  type ClipRecord,
} from "./processing";

let directory = "",
  input = "";
const clip: ClipRecord = {
  id: "scratch-clip",
  ownerId: 1,
  ownerName: "Test",
  sourceId: "scratch-source",
  creatorId: 1,
  creatorName: "Test",
  title: "Scratch",
  game: "",
  start: 0,
  end: 2,
  crop: "original",
  cropX: 0.5,
  cropY: 0.5,
  captions: [],
  overlay: "",
  audience: "public",
  status: "queued",
  published: false,
  createdAt: new Date().toISOString(),
  renderVersion: 1,
};
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "respawn-test-"));
  input = path.join(directory, "test.mp4");
  await command("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100",
    "-t",
    "3",
    "-threads",
    "2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    input,
  ]);
}, 30_000);
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
describe("real FFmpeg scratch media (no production records or assets)", () => {
  it("probes actual duration, renders an accurate playable original cut, and creates a JPEG poster", async () => {
    expect(await probeFile(input)).toMatchObject({
      width: 320,
      height: 180,
      audio: true,
    });
    const result = await renderClipFile(
      input,
      { ...clip, start: 0.5, end: 2 },
      await mkdtemp(path.join(directory, "original-"))
    );
    expect(result.duration).toBeCloseTo(1.5, 1);
    expect(result.audio).toBe(true);
    expect((await readFile(result.output)).subarray(4, 8).toString()).toBe(
      "ftyp"
    );
    expect((await readFile(result.poster)).subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8])
    );
    expect((await stat(result.output)).size).toBeGreaterThan(1000);
  }, 30_000);
  it("renders vertical repositioning, timed captions, and an emoji overlay into actual video bytes", async () => {
    const result = await renderClipFile(
      input,
      {
        ...clip,
        crop: "vertical",
        cropX: 0.8,
        captions: [{ start: 0.25, end: 1.6, text: "A real timed caption" }],
        overlay: "🎮",
      },
      await mkdtemp(path.join(directory, "vertical-"))
    );
    expect(result).toMatchObject({ width: 720, height: 1280 });
    expect(result.duration).toBeCloseTo(2, 1);
    const output = await probeFile(result.output);
    expect(output.audio).toBe(true);
  }, 30_000);
  it("renders an actual square crop and rejects unavailable or too-long selections", async () => {
    const result = await renderClipFile(
      input,
      { ...clip, crop: "square", cropX: 1 },
      await mkdtemp(path.join(directory, "square-"))
    );
    expect(result).toMatchObject({ width: 720, height: 720 });
    await expect(
      renderClipFile(input, { ...clip, end: 30 }, directory)
    ).rejects.toMatchObject({ status: 422 });
  }, 30_000);
  it("extracts actual bounded mono clip audio and rejects missing audio or durations beyond 60 seconds", async () => {
    const cutDirectory = await mkdtemp(path.join(directory, "audio-cut-"));
    const rendered = await renderClipFile(input, clip, cutDirectory);
    const audio = await extractClipAudioFile(rendered.output, cutDirectory, 2);
    const audioInfo = await probeFile(audio);
    expect(audioInfo).toMatchObject({ audio: true, width: 0, height: 0 });
    expect(audioInfo.duration).toBeLessThan(2.25);
    expect((await stat(audio)).size).toBeLessThan(1024 * 1024);
    for (const duration of [61, 0, NaN])
      await expect(
        extractClipAudioFile(rendered.output, cutDirectory, duration)
      ).rejects.toMatchObject({ status: 422 });
    const silent = path.join(cutDirectory, "no-audio.mp4");
    await command("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-i",
      rendered.output,
      "-c:v",
      "copy",
      "-an",
      silent,
    ]);
    await expect(extractClipAudioFile(silent, cutDirectory, 2)).rejects.toThrow(
      "no audio track"
    );
  }, 30_000);
  it("escapes ASS formatting injection while preserving timed text", () => {
    const output = captionFile(
      {
        start: 0,
        end: 2,
        captions: [
          { start: 0.25, end: 1.5, text: "{\\pos(0,0)} safe\ncaption" },
        ],
        overlay: "🎮",
      },
      720,
      1280
    );
    expect(output).toContain("0:00:00.25,0:00:01.50");
    expect(output).not.toContain("{\\pos");
    expect(output).toContain("safe\\Ncaption");
  });
});
