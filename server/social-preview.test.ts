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
const state = vi.hoisted(() => ({ profileError: false }));
vi.mock("wouter", () => ({
  Link: ({
    children,
    ...props
  }: {
    children?: React.ReactNode;
    href: string;
  }) => React.createElement("a", props, children),
}));
vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 1 }, loading: false }),
}));
vi.mock("@/const", () => ({ startLogin: vi.fn() }));
vi.mock("@/lib/app-api", () => ({
  useData: (path: string) => ({
    data: path.includes("/profiles/")
      ? {
          displayName: "Currently readable gamer",
          avatarEmoji: "🎮",
          media: {},
        }
      : path.endsWith("/social")
        ? {
            reactions: [],
            myReaction: null,
            commentsCount: 0,
            canComment: true,
            canReact: true,
          }
        : [
            {
              id: "post-one",
              ownerId: 1,
              ownerName: "Post name",
              text: "An actual post preview",
              audience: "public",
              photos: [],
              createdAt: "2026-11-19T00:00:00.000Z",
            },
          ],
    error:
      path.includes("/profiles/") && state.profileError
        ? new Error("Profile not found")
        : null,
    isPending: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useRefresh: () => vi.fn(),
  api: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  errorMessage: (error: Error) => error.message,
}));
import { PostFeed } from "../client/src/components/lounge/Posts";
import { MemberName } from "../client/src/components/lounge/MemberName";
beforeAll(() => vi.stubGlobal("React", React));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  state.profileError = false;
});
describe("local profile preview is not a social publishing surface", () => {
  it("renders post content but no edit/delete/reaction/create actions in read-only previews", () => {
    const html = renderToStaticMarkup(
      createElement(PostFeed, { ownerId: 1, readOnly: true, onCreate: vi.fn() })
    );
    expect(html).toContain("An actual post preview");
    expect(html).toContain("Read-only post preview");
    expect(html).not.toContain("Edit your post");
    expect(html).not.toContain("Delete your post");
    expect(html).not.toContain("React to this post");
    expect(html).not.toContain("Create post");
  });
  it("preserves real editing and social actions on normal post feeds", () => {
    const html = renderToStaticMarkup(createElement(PostFeed, { ownerId: 1 }));
    expect(html).toContain("Edit your post");
    expect(html).toContain("Delete your post");
    expect(html).toContain("React to this post");
  });
  it("falls back to the post identity when cached profile data is no longer readable", () => {
    expect(
      renderToStaticMarkup(
        createElement(MemberName, { userId: 1, fallback: "Post name" })
      )
    ).toBe("Currently readable gamer");
    state.profileError = true;
    expect(
      renderToStaticMarkup(
        createElement(MemberName, { userId: 1, fallback: "Post name" })
      )
    ).toBe("Post name");
  });
});
