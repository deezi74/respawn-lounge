import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
beforeAll(() => vi.stubGlobal("React", React));
afterAll(() => vi.unstubAllGlobals());
const state = vi.hoisted(() => ({
  user: { id: 1 } as { id: number } | null,
  summary: {
    reactions: [] as { emoji: string; count: number }[],
    myReaction: null as string | null,
    commentsCount: 3,
    canComment: true,
    canReact: true,
  },
  follow: {
    following: false,
    followers: 2,
    followingCount: 1,
    canFollow: true,
  } as {
    following: boolean;
    followers?: number;
    followingCount?: number;
    canFollow: boolean;
  },
}));
vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({ user: state.user }),
}));
vi.mock("@/lib/app-api", () => ({
  useData: (path: string) => ({
    data: path.includes("/profiles/")
      ? state.follow
      : path.endsWith("/comments")
        ? []
        : state.summary,
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
  post: vi.fn(),
  api: vi.fn(),
  errorMessage: (error: Error) => error.message,
}));
vi.mock("@/const", () => ({ startLogin: vi.fn() }));
import {
  FollowControls,
  PostSocialControls,
} from "../client/src/components/lounge/SocialControls";
beforeEach(() => {
  state.user = { id: 1 };
  state.summary = {
    reactions: [],
    myReaction: null,
    commentsCount: 3,
    canComment: true,
    canReact: true,
  };
  state.follow = {
    following: false,
    followers: 2,
    followingCount: 1,
    canFollow: true,
  };
});
describe("rendered social-control contracts", () => {
  it("shows real counts and a follow action without inventing connections", () => {
    const html = renderToStaticMarkup(
      createElement(FollowControls, { ownerId: 2 })
    );
    expect(html).toContain("2 followers");
    expect(html).toContain("1 following");
    expect(html).toContain("Follow");
  });
  it("does not offer self-follow or disabled following", () => {
    expect(
      renderToStaticMarkup(createElement(FollowControls, { ownerId: 1 }))
    ).not.toContain("social-button-primary");
    state.follow.canFollow = false;
    expect(
      renderToStaticMarkup(createElement(FollowControls, { ownerId: 2 }))
    ).not.toContain("<button");
  });
  it("hides follower statistics when the API omits private counts", () => {
    state.follow = { following: false, canFollow: true };
    const html = renderToStaticMarkup(
      createElement(FollowControls, { ownerId: 2 })
    );
    expect(html).not.toContain("followers");
    expect(html).not.toContain("followingCount");
  });
  it("lets an existing follower revoke even after following is disabled", () => {
    state.follow.following = true;
    state.follow.canFollow = false;
    expect(
      renderToStaticMarkup(createElement(FollowControls, { ownerId: 2 }))
    ).toContain("Following · Unfollow");
  });
  it("renders eight real emoji reactions and keeps comment content collapsed initially", () => {
    const html = renderToStaticMarkup(
      createElement(PostSocialControls, { postId: "one" })
    );
    const buttons =
      html.match(/<button\b[^>]+class="social-reaction"[^>]*>/g) || [];
    expect(buttons).toHaveLength(8);
    expect(buttons.every(button => !button.includes("disabled"))).toBe(true);
    expect(html).not.toContain("<textarea");
    expect(html).toContain('aria-expanded="false"');
  });
  it("permits removing your own reaction when the author disables new reactions", () => {
    state.summary.canReact = false;
    state.summary.myReaction = "🔥";
    state.summary.reactions = [{ emoji: "🔥", count: 1 }];
    const html = renderToStaticMarkup(
      createElement(PostSocialControls, { postId: "one" })
    );
    const buttons =
      html.match(/<button\b[^>]+class="social-reaction"[^>]*>/g) || [];
    expect(buttons.filter(button => button.includes("disabled"))).toHaveLength(
      7
    );
    expect(
      buttons.find(button => button.includes('aria-pressed="true"'))
    ).not.toContain("disabled");
  });
});
