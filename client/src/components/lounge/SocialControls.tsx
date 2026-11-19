import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link } from "wouter";
import {
  Check,
  Loader2,
  MessageCircle,
  Send,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { api, errorMessage, post, useData } from "@/lib/app-api";
import { startLogin } from "@/const";
import {
  REACTION_EMOJIS,
  type FollowSummary,
  type PostComment,
  type PostSocial,
  type ReactionEmoji,
} from "@shared/social-types";
import { EmojiPicker } from "./EmojiPicker";
import { formatPostTime } from "./posts-utils";
import { insertEmoji } from "./emoji-utils";
import { MemberName } from "./MemberName";
import { MemberAvatar } from "./MemberAvatar";
import "./social.css";

export function FollowControls({ ownerId }: { ownerId: number }) {
  const { user } = useAuth();
  const q = useData<FollowSummary>(
    `/profiles/${ownerId}/social`,
    Number.isSafeInteger(ownerId) && ownerId > 0
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  useEffect(() => {
    setError(null);
  }, [ownerId, user?.id]);
  async function toggle() {
    if (!user) {
      startLogin();
      return;
    }
    if (sending.current || !q.data) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await post(`/profiles/${ownerId}/follow`, {
        following: !q.data.following,
        confirmed: true,
      });
      await q.refetch();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  if (q.isPending)
    return (
      <span className="social-note" role="status">
        Loading connections…
      </span>
    );
  if (q.error)
    return <span className="social-note">Connections unavailable.</span>;
  const info = q.data;
  if (!info) return null;
  return (
    <div className="social-follow">
      {info.followers !== undefined && (
        <span className="social-follow-counts">
          {info.followers.toLocaleString()}{" "}
          {info.followers === 1 ? "follower" : "followers"}
          {info.followingCount !== undefined &&
            ` · ${info.followingCount.toLocaleString()} following`}
        </span>
      )}
      {user?.id !== ownerId && (info.canFollow || info.following || !user) && (
        <button
          type="button"
          className={`social-button ${info.following ? "" : "social-button-primary"}`}
          disabled={busy}
          aria-pressed={info.following}
          onClick={() => void toggle()}
        >
          {busy ? (
            <Loader2 size={16} className="social-spin" />
          ) : info.following ? (
            <Check size={16} />
          ) : (
            <UserPlus size={16} />
          )}{" "}
          {info.following ? "Following · Unfollow" : "Follow"}
        </button>
      )}
      {error && (
        <p className="social-error social-follow-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function PostSocialControls({ postId }: { postId: string }) {
  const { user } = useAuth();
  const [expanded, setExpanded] = useState(false),
    [text, setText] = useState(""),
    [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [deleting, setDeleting] = useState<string | null>(null);
  const summary = useData<PostSocial>(
    `/posts/${encodeURIComponent(postId)}/social`
  );
  const comments = useData<PostComment[]>(
    `/posts/${encodeURIComponent(postId)}/comments`,
    expanded
  );
  const lock = useRef(false),
    inputId = useId();
  useEffect(() => {
    setText("");
    setError(null);
    setDeleting(null);
    setExpanded(false);
  }, [user?.id, postId]);
  async function act(kind: string, operation: () => Promise<unknown>) {
    if (!user) {
      startLogin();
      return;
    }
    if (lock.current) return;
    lock.current = true;
    setBusy(kind);
    setError(null);
    try {
      await operation();
      await summary.refetch();
      if (expanded) await comments.refetch();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }
  async function react(emoji: ReactionEmoji) {
    await act("reaction", () =>
      post(`/posts/${encodeURIComponent(postId)}/reaction`, {
        emoji: summary.data?.myReaction === emoji ? null : emoji,
        confirmed: true,
      })
    );
  }
  async function comment(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || text.length > 1000) return;
    await act("comment", async () => {
      await post(`/posts/${encodeURIComponent(postId)}/comments`, {
        text,
        confirmed: true,
      });
      setText("");
    });
  }
  if (summary.isPending)
    return (
      <div className="social-note" role="status">
        Loading reactions…
      </div>
    );
  if (summary.error)
    return (
      <div className="social-note">
        Reactions and comments are unavailable.{" "}
        <button
          type="button"
          className="social-button"
          onClick={() => void summary.refetch()}
        >
          Retry
        </button>
      </div>
    );
  const info = summary.data;
  if (!info) return null;
  return (
    <div className="social-controls">
      <div className="social-reactions" aria-label="React to this post">
        {REACTION_EMOJIS.map(emoji => {
          const count =
            info.reactions.find(item => item.emoji === emoji)?.count || 0;
          return (
            <button
              type="button"
              className="social-reaction"
              key={emoji}
              aria-label={`${emoji} reaction, ${count}${info.myReaction === emoji ? ", your reaction" : ""}`}
              aria-pressed={info.myReaction === emoji}
              disabled={
                busy !== null ||
                (!!user && !info.canReact && info.myReaction !== emoji)
              }
              title={
                !info.canReact && user && info.myReaction !== emoji
                  ? "Reactions are turned off by the author"
                  : `React ${emoji}`
              }
              onClick={() => void react(emoji)}
            >
              <span aria-hidden="true">{emoji}</span>
              {count > 0 && (
                <span className="social-reaction-count">
                  {count.toLocaleString()}
                </span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          className="social-button social-comment-toggle"
          aria-expanded={expanded}
          aria-controls={`${inputId}-thread`}
          onClick={() => setExpanded(value => !value)}
        >
          <MessageCircle size={17} />
          {info.commentsCount.toLocaleString()}{" "}
          {info.commentsCount === 1 ? "comment" : "comments"}
        </button>
      </div>
      {error && (
        <p role="alert" className="social-error">
          {error}
        </p>
      )}
      {expanded && (
        <section
          className="social-thread"
          id={`${inputId}-thread`}
          aria-label="Post comments"
        >
          {comments.isPending ? (
            <p className="social-note" role="status">
              Loading comments…
            </p>
          ) : comments.error ? (
            <p className="social-error" role="alert">
              {errorMessage(comments.error)}{" "}
              <button
                type="button"
                className="social-button"
                onClick={() => void comments.refetch()}
              >
                Retry
              </button>
            </p>
          ) : comments.data?.length ? (
            <div>
              {comments.data.map(item => (
                <article key={item.id} className="social-comment">
                  <div className="social-comment-head">
                    <Link href={`/u/${item.ownerId}`}>
                      <MemberAvatar
                        userId={item.ownerId}
                        name={item.ownerName}
                        className="social-comment-avatar"
                      />
                      <MemberName
                        userId={item.ownerId}
                        fallback={item.ownerName}
                      />
                    </Link>
                    <time dateTime={item.createdAt}>
                      {formatPostTime(item.createdAt)}
                    </time>
                  </div>
                  <p className="social-comment-text">{item.text}</p>
                  {item.canDelete && (
                    <button
                      type="button"
                      className="social-comment-delete"
                      disabled={busy !== null}
                      onClick={() => setDeleting(item.id)}
                    >
                      <Trash2
                        size={12}
                        style={{ display: "inline", marginRight: 4 }}
                      />
                      Remove comment
                    </button>
                  )}
                  {deleting === item.id && (
                    <section
                      className="social-delete-confirm"
                      aria-label="Confirm removing comment"
                    >
                      <p>Remove this comment? This cannot be undone.</p>
                      <div>
                        <button
                          type="button"
                          className="social-button"
                          disabled={busy !== null}
                          onClick={() => setDeleting(null)}
                        >
                          Keep
                        </button>
                        <button
                          type="button"
                          className="social-button"
                          disabled={busy !== null}
                          onClick={() =>
                            void act("delete", async () => {
                              await api(
                                `/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(item.id)}`,
                                {
                                  method: "DELETE",
                                  body: JSON.stringify({ confirmed: true }),
                                }
                              );
                              setDeleting(null);
                            })
                          }
                        >
                          {busy === "delete" ? "Removing…" : "Remove comment"}
                        </button>
                      </div>
                    </section>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <p className="social-note">
              No comments yet. Start the conversation.
            </p>
          )}
          {!user ? (
            <button
              type="button"
              className="social-button"
              onClick={startLogin}
            >
              Sign in to comment
            </button>
          ) : info.canComment ? (
            <form className="social-comment-form" onSubmit={comment}>
              <label htmlFor={inputId} className="social-comment-label">
                Add to the conversation
              </label>
              <textarea
                id={inputId}
                maxLength={1000}
                value={text}
                disabled={busy !== null}
                placeholder="Keep it friendly. Keep it gaming."
                onChange={event => setText(event.target.value)}
              />
              <div className="social-comment-tools">
                <EmojiPicker
                  disabled={busy !== null}
                  onSelect={emoji =>
                    setText(
                      value =>
                        insertEmoji(
                          value,
                          emoji,
                          value.length,
                          value.length,
                          1000
                        ).value
                    )
                  }
                />
                <div className="social-comment-submit">
                  <small>{text.length} / 1,000</small>
                  <button
                    type="submit"
                    className="social-button social-button-primary"
                    disabled={busy !== null || !text.trim()}
                  >
                    {busy === "comment" ? (
                      <Loader2 size={16} className="social-spin" />
                    ) : (
                      <Send size={16} />
                    )}
                    Comment
                  </button>
                </div>
              </div>
              <p className="social-note">
                Your comment uses the post’s existing audience.
              </p>
            </form>
          ) : (
            <p className="social-note">
              The author has turned off new comments.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
