import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POST_LIMITS } from "../shared/post-types";

const read = (path: string) => readFileSync(path, "utf8");
describe("regular post shell integration", () => {
  it("exposes regular posting on desktop, phone, profile and joined Lounges", () => {
    const home = read("client/src/pages/Home.tsx");
    expect(home).toContain("Create Post");
    expect(home).toContain("post-mobile-create");
    expect(home).toContain("Post to Lounge");
    expect(home).toContain("initialLoungeId={composer.loungeId}");
    expect(home).toContain("ownerId={userId}");
    expect(home).toContain("loungeId={l.id}");
    expect(home).toContain("setComposer(null)");
    expect(home).toContain("<UploadDialog");
  });
  it("declares a real shareable post route", () => {
    const manifest = JSON.parse(read("client/public/manus-routes.json"));
    expect(manifest.routes).toContainEqual({
      path: "/post/:id",
      title: "Community Post",
    });
    expect(read("client/src/App.tsx")).toContain('"/post/:id"');
    expect(read("client/src/pages/Home.tsx")).toContain(
      "<PostPage id={postParams.id}"
    );
  });
  it("does not put user posts or photos in the service worker cache", () => {
    const worker = read("client/public/sw.js");
    expect(worker).toContain("url.pathname.startsWith('/api/')");
    expect(worker).toContain("url.pathname.startsWith('/manus-storage/')");
    const assets =
      worker.match(/const PUBLIC_ASSETS = (\[[^;]+\])/s)?.[1] || "";
    expect(assets).not.toContain("/post");
    expect(assets).not.toContain("/api");
  });
  it("shares the same concrete composer and server limits", () => {
    expect(POST_LIMITS.text).toBe(5000);
    expect(POST_LIMITS.photos).toBe(4);
    expect(POST_LIMITS.photoBytes).toBe(8 * 1024 * 1024);
  });
  it("registers post and photo routes in the real server before static serving", () => {
    const server = read("server/_core/index.ts");
    expect(server).toContain(
      'import { registerPostRoutes } from "../features/posts"'
    );
    expect(server).toContain("registerPostRoutes(app)");
    expect(server.indexOf("registerPostRoutes(app)")).toBeLessThan(
      server.indexOf("serveStatic(app)")
    );
  });
});
