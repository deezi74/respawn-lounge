import { describe, expect, it } from "vitest";
import { POST_LIMITS, type RegularPost } from "../shared/post-types";
import {
  buildPostForm,
  filterPosts,
  formatPostTime,
  postAudienceLabel,
  postPhotoError,
  postPhotoUrl,
} from "../client/src/components/lounge/posts-utils";

const photo = { name: "photo.jpg", type: "image/jpeg", size: 1024 };

describe("regular posts UI guards", () => {
  it("accepts the exact photo count and 8 MiB boundary", () => {
    expect(
      postPhotoError([{ ...photo, size: POST_LIMITS.photoBytes }], 3)
    ).toBeNull();
    expect(postPhotoError([photo], 4)).toContain("up to 4");
    expect(
      postPhotoError([{ ...photo, size: POST_LIMITS.photoBytes + 1 }])
    ).toContain("8 MiB");
  });

  it("only accepts nonempty JPEG, PNG and WebP files", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp"])
      expect(postPhotoError([{ ...photo, type }])).toBeNull();
    for (const type of ["image/svg+xml", "image/gif", "text/html", ""])
      expect(postPhotoError([{ ...photo, type }])).toContain(
        "JPEG, PNG or WebP"
      );
    expect(postPhotoError([{ ...photo, size: 0 }])).toContain("empty");
  });

  it("puts all Lounge authorization metadata ahead of photo bytes", () => {
    const image = new File(["photo"], "one.png", { type: "image/png" });
    const form = buildPostForm("A message", "lounge", "lounge-1", [
      image,
      image,
    ]);
    expect([...form.keys()]).toEqual([
      "text",
      "destination",
      "loungeId",
      "confirmed",
      "photos",
      "photos",
    ]);
    expect(form.get("confirmed")).toBe("true");
    expect(form.get("loungeId")).toBe("lounge-1");
    expect(form.getAll("photos")).toHaveLength(2);
  });

  it("does not send a stale Lounge destination on a public profile post", () => {
    const form = buildPostForm("", "profile", "old-private-lounge", []);
    expect([...form.keys()]).toEqual(["text", "destination", "confirmed"]);
    expect(form.has("loungeId")).toBe(false);
  });

  it("preserves the exact protected image resource and fresh media ticket", () => {
    const path =
      "/api/media/post-photo/post-1/photo-1?mediaTicket=signed&ticketUser=12";
    expect(postPhotoUrl("post-1", "photo-1", path, "https://app.example")).toBe(
      path
    );
    expect(
      postPhotoUrl(
        "post-1",
        "photo-1",
        `https://app.example${path}`,
        "https://app.example"
      )
    ).toBe(path);
  });

  it("rejects foreign images, raw storage URLs and other application resources", () => {
    const origin = "https://app.example";
    for (const value of [
      "https://foreign.example/api/media/post-photo/post-1/photo-1",
      "//foreign.example/image.webp",
      "javascript:alert(1)",
      "data:image/svg+xml,test",
      "blob:https://app.example/local",
      "/manus-storage/raw-private-photo",
      "/api/media/post-photo/post-2/photo-1",
      "/api/media/post-photo/post-1/photo-2",
      "https://user:password@app.example/api/media/post-photo/post-1/photo-1",
      "",
    ])
      expect(postPhotoUrl("post-1", "photo-1", value, origin)).toBeNull();
  });

  it("labels public profile, public Lounge and private Lounge audiences explicitly", () => {
    expect(
      postAudienceLabel({ destination: "profile", audience: "public" })
    ).toBe("Public · Profile");
    expect(
      postAudienceLabel({
        destination: "lounge",
        audience: "public",
        loungeName: "Crew",
      })
    ).toBe("Public Lounge · Crew");
    expect(
      postAudienceLabel({
        destination: "lounge",
        audience: "lounge",
        loungeName: "Crew",
      })
    ).toBe("Private Lounge · Crew");
  });

  it("searches text and author, ignoring case and outer whitespace", () => {
    const posts = [
      { id: "1", text: "Great match", ownerName: "Nia" },
      { id: "2", text: "New setup", ownerName: "Rowan" },
    ] as RegularPost[];
    expect(filterPosts(posts, " MATCH ").map(post => post.id)).toEqual(["1"]);
    expect(filterPosts(posts, "rOwAn").map(post => post.id)).toEqual(["2"]);
    expect(filterPosts(posts, "no result")).toEqual([]);
    expect(filterPosts(posts, " ")).toBe(posts);
  });

  it("formats real timestamps with a locale formatter and handles invalid input", () => {
    const value = "2026-11-18T20:00:00.000Z";
    expect(formatPostTime(value, "en-US")).toBe(
      new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    );
    expect(formatPostTime("not a date")).toBe("Date unavailable");
  });
});
