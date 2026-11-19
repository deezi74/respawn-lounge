import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "wouter";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Globe2,
  ImageOff,
  ImagePlus,
  Link2,
  Loader2,
  LockKeyhole,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Shield,
  Trash2,
  X,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { api, errorMessage, patch, useData, useRefresh } from "@/lib/app-api";
import type { Lounge } from "@shared/app-types";
import {
  POST_LIMITS,
  type PostPhoto,
  type RegularPost,
} from "@shared/post-types";
import {
  buildPostForm,
  filterPosts,
  formatPostTime,
  POST_PHOTO_TYPES,
  postAudienceLabel,
  postPhotoError,
  postPhotoUrl,
} from "./posts-utils";
import "./posts.css";

type ComposerProps = {
  lounges: Lounge[];
  userName?: string;
  initialLoungeId?: string;
  onClose: () => void;
  onCreated?: (post: RegularPost) => void;
};
type FeedProps = {
  ownerId?: number;
  loungeId?: string;
  search?: string;
  title?: string;
  onCreate?: () => void;
  compact?: boolean;
};
type DraftPhoto = { id: string; file: File; url: string };
type RefreshPosts = () => Promise<unknown>;

let openPostDialogs = 0;
let previousBodyOverflow = "";

/** Native modal dialogs provide focus containment, Escape, and an inert background. */
function PostDialog({
  title,
  subtitle,
  busy = false,
  onClose,
  children,
  photo = false,
  onKeyDown,
}: {
  title: string;
  subtitle?: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  photo?: boolean;
  onKeyDown?: (event: KeyboardEvent<HTMLDialogElement>) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previousFocus = document.activeElement;
    if (openPostDialogs++ === 0) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    element.showModal();
    return () => {
      element.close();
      if (--openPostDialogs === 0)
        document.body.style.overflow = previousBodyOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, []);
  if (typeof document === "undefined") return null;
  return createPortal(
    <dialog
      ref={dialog}
      className={`post-dialog${photo ? " post-dialog-photo" : ""}`}
      aria-labelledby={titleId}
      aria-describedby={subtitle ? descriptionId : undefined}
      aria-busy={busy}
      onCancel={event => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onKeyDown={onKeyDown}
      onClick={event => {
        if (event.target !== event.currentTarget || busy) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }}
    >
      <div className="post-dialog-inner">
        <header className="post-dialog-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p id={descriptionId}>{subtitle}</p>}
          </div>
          <button
            type="button"
            className="post-icon-button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close dialog"
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </dialog>,
    document.body
  );
}

function PostError({ children }: { children: ReactNode }) {
  return (
    <div className="post-error" role="alert">
      {children}
    </div>
  );
}

function DiscardDraft({
  onKeep,
  onDiscard,
}: {
  onKeep: () => void;
  onDiscard: () => void;
}) {
  return (
    <PostDialog title="Discard your changes?" onClose={onKeep}>
      <p className="post-dialog-copy">
        Your unsaved text and photo changes will be lost. Nothing else will be
        published.
      </p>
      <div className="post-dialog-actions">
        <button type="button" className="post-button" onClick={onKeep}>
          Keep editing
        </button>
        <button
          type="button"
          className="post-button post-button-danger"
          onClick={onDiscard}
        >
          Discard changes
        </button>
      </div>
    </PostDialog>
  );
}

export function PostPrompt({
  onCreate,
  userName,
}: {
  onCreate: () => void;
  userName?: string;
}) {
  return (
    <button type="button" className="post-prompt" onClick={onCreate}>
      <span className="post-avatar" aria-hidden="true">
        {userName?.trim().slice(0, 1).toLocaleUpperCase() || (
          <MessageSquare size={20} />
        )}
      </span>
      <span className="post-prompt-copy">
        <strong>
          {userName
            ? `What’s happening, ${userName}?`
            : "What’s happening in your world?"}
        </strong>
        <span>Share a thought or up to 4 photos. You choose the audience.</span>
      </span>
      <ImagePlus size={22} aria-hidden="true" />
    </button>
  );
}

export function PostComposer(props: ComposerProps) {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <PostDialog title="Create a post" onClose={props.onClose}>
        <PostLoading />
      </PostDialog>
    );
  return (
    <ComposerDialog
      key={user?.id ?? "anonymous"}
      {...props}
      userId={user?.id}
    />
  );
}

function ComposerDialog({
  lounges,
  userName,
  initialLoungeId,
  onClose,
  onCreated,
  userId,
}: ComposerProps & { userId?: number }) {
  const [text, setText] = useState("");
  const [destination, setDestination] = useState<"profile" | "lounge">(
    initialLoungeId ? "lounge" : "profile"
  );
  const [loungeId, setLoungeId] = useState(initialLoungeId || "");
  const [photos, setPhotos] = useState<DraftPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const [published, setPublished] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const serial = useRef(0);
  const objectUrls = useRef(new Set<string>());
  const submitting = useRef(false);
  const createdPost = useRef<RegularPost | null>(null);
  const refresh = useRefresh();
  const joined = lounges.filter(
    lounge =>
      userId !== undefined &&
      (lounge.ownerId === userId || lounge.members.includes(userId))
  );
  const selectedLounge = joined.find(lounge => lounge.id === loungeId);
  const dirty = text.length > 0 || photos.length > 0;
  const validDestination = destination === "profile" || Boolean(selectedLounge);
  const disabled = busy || published;
  const canPost =
    Boolean(userId) &&
    validDestination &&
    Boolean(text.trim() || photos.length) &&
    text.length <= POST_LIMITS.text;
  const textId = useId();
  const counterId = useId();

  useEffect(
    () => () => {
      objectUrls.current.forEach(url => URL.revokeObjectURL(url));
      objectUrls.current.clear();
    },
    []
  );

  function requestClose() {
    if (submitting.current) return;
    if (dirty && !createdPost.current) setDiscard(true);
    else onClose();
  }

  function addPhotos(files: File[]) {
    if (disabled || submitting.current) return;
    const problem = postPhotoError(files, photos.length);
    if (problem) {
      setFileError(problem);
      return;
    }
    const added: DraftPhoto[] = [];
    try {
      for (const file of files) {
        const url = URL.createObjectURL(file);
        objectUrls.current.add(url);
        added.push({ id: String(++serial.current), file, url });
      }
      setPhotos(previous => [...previous, ...added]);
      setFileError(null);
    } catch {
      added.forEach(photo => {
        URL.revokeObjectURL(photo.url);
        objectUrls.current.delete(photo.url);
      });
      setFileError(
        "These photos could not be previewed. Please choose them again."
      );
    }
  }

  function removePhoto(photo: DraftPhoto) {
    if (disabled || submitting.current) return;
    URL.revokeObjectURL(photo.url);
    objectUrls.current.delete(photo.url);
    setPhotos(previous => previous.filter(item => item.id !== photo.id));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || (!createdPost.current && !canPost)) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!createdPost.current) {
        const problem = postPhotoError(photos.map(photo => photo.file));
        if (problem) throw new Error(problem);
        createdPost.current = await api<RegularPost>("/posts", {
          method: "POST",
          body: buildPostForm(
            text,
            destination,
            loungeId,
            photos.map(photo => photo.file)
          ),
        });
        setPublished(true);
      }
      // If refreshing ever fails, a retry finishes this operation without publishing twice.
      await refresh();
      await onCreated?.(createdPost.current);
      onClose();
    } catch (cause) {
      setError(
        createdPost.current
          ? `Your post was published. Finishing the refresh failed: ${errorMessage(cause)} Retry below; your post will not be published again.`
          : errorMessage(cause)
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <PostDialog
        title="Create a post"
        subtitle={
          userName
            ? `A little update from ${userName}.`
            : "Your thoughts, your photos, your people."
        }
        busy={busy}
        onClose={requestClose}
      >
        <form className="post-form" onSubmit={submit}>
          {!userId && (
            <PostError>
              Sign in before publishing a post. Your draft stays here until you
              close it.
            </PostError>
          )}
          <div className="post-field">
            <label htmlFor={textId}>What would you like to share?</label>
            <textarea
              id={textId}
              rows={5}
              value={text}
              maxLength={POST_LIMITS.text}
              disabled={disabled}
              placeholder="A thought, an update, a moment worth sharing…"
              aria-describedby={counterId}
              onChange={event => setText(event.target.value)}
            />
            <span
              id={counterId}
              className={`post-counter${text.length >= POST_LIMITS.text ? " post-counter-limit" : ""}`}
            >
              {text.length.toLocaleString()} /{" "}
              {POST_LIMITS.text.toLocaleString()} characters
            </span>
          </div>
          {photos.length > 0 && (
            <div className="post-draft-grid" aria-label="Selected photos">
              {photos.map((photo, index) => (
                <div className="post-draft-photo" key={photo.id}>
                  <LocalPhoto photo={photo} index={index} />
                  <button
                    type="button"
                    className="post-photo-remove"
                    disabled={disabled}
                    onClick={() => removePhoto(photo)}
                    aria-label={`Remove photo ${index + 1}: ${photo.file.name}`}
                  >
                    <X size={17} />
                  </button>
                  <span className="post-photo-filename" title={photo.file.name}>
                    {photo.file.name}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="post-upload-row">
            <input
              ref={input}
              type="file"
              hidden
              multiple
              accept={POST_PHOTO_TYPES.join(",")}
              disabled={disabled || photos.length >= POST_LIMITS.photos}
              onChange={event => {
                const files = Array.from(event.currentTarget.files || []);
                event.currentTarget.value = "";
                if (files.length) addPhotos(files);
              }}
            />
            <button
              type="button"
              className="post-button"
              disabled={disabled || photos.length >= POST_LIMITS.photos}
              onClick={() => input.current?.click()}
            >
              <ImagePlus size={18} /> Add photos
            </button>
            <span>
              {photos.length} / {POST_LIMITS.photos} · JPEG, PNG, WebP
              <br />8 MiB each · text optional with a photo
            </span>
          </div>
          {fileError && <PostError>{fileError}</PostError>}
          <label className="post-field">
            <span>Post to</span>
            <select
              value={destination}
              disabled={disabled}
              onChange={event =>
                setDestination(event.target.value as "profile" | "lounge")
              }
            >
              <option value="profile">My profile · Public</option>
              <option value="lounge">A Lounge I’ve joined</option>
            </select>
          </label>
          {destination === "lounge" && (
            <label className="post-field">
              <span>Choose your Lounge</span>
              <select
                value={loungeId}
                disabled={disabled}
                required
                onChange={event => setLoungeId(event.target.value)}
              >
                <option value="">Choose a joined Lounge</option>
                {loungeId && !selectedLounge && (
                  <option value={loungeId} disabled>
                    This Lounge is no longer available
                  </option>
                )}
                {joined.map(lounge => (
                  <option key={lounge.id} value={lounge.id}>
                    {lounge.name} ·{" "}
                    {lounge.privacy === "private" ? "Private" : "Public"}
                  </option>
                ))}
              </select>
              {!joined.length && (
                <small>
                  Join a Lounge before posting there, or explicitly choose your
                  public profile.
                </small>
              )}
            </label>
          )}
          <div
            className={`post-audience-note${destination === "lounge" && selectedLounge?.privacy !== "public" ? " post-audience-private" : ""}`}
          >
            {destination === "lounge" &&
            selectedLounge?.privacy !== "public" ? (
              <LockKeyhole size={18} />
            ) : (
              <Globe2 size={18} />
            )}
            <span>
              {destination === "profile" ? (
                <>
                  <strong>Public profile post.</strong> Anyone can view your
                  text and photos.
                </>
              ) : selectedLounge ? (
                selectedLounge.privacy === "private" ? (
                  <>
                    <strong>Private · {selectedLounge.name}.</strong> Only you
                    and current Lounge members can view. Sharing a link does not
                    grant access.
                  </>
                ) : (
                  <>
                    <strong>Public Lounge · {selectedLounge.name}.</strong>{" "}
                    Anyone can view while the Lounge is public. Access follows
                    its current privacy.
                  </>
                )
              ) : (
                <>
                  <strong>No Lounge selected.</strong> Choose an available
                  joined Lounge before posting.
                </>
              )}
            </span>
          </div>
          {error && <PostError>{error}</PostError>}
          <div className="post-dialog-actions">
            <button
              type="button"
              className="post-button"
              disabled={busy}
              onClick={requestClose}
            >
              {published ? "Close" : "Cancel"}
            </button>
            <button
              type="submit"
              className="post-button post-button-primary"
              disabled={busy || (!published && !canPost)}
            >
              {busy ? (
                <Loader2 size={18} className="post-spin" />
              ) : (
                <Send size={18} />
              )}
              {busy
                ? published
                  ? "Finishing…"
                  : "Posting…"
                : published
                  ? "Finish refresh"
                  : "Post"}
            </button>
          </div>
        </form>
      </PostDialog>
      {discard && (
        <DiscardDraft onKeep={() => setDiscard(false)} onDiscard={onClose} />
      )}
    </>
  );
}

function LocalPhoto({ photo, index }: { photo: DraftPhoto; index: number }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <div className="post-image-fallback">
      <ImageOff size={23} />
      <span>Preview unavailable</span>
    </div>
  ) : (
    <img
      src={photo.url}
      alt={`Selected photo ${index + 1}: ${photo.file.name}`}
      onError={() => setFailed(true)}
    />
  );
}

function PostLoading() {
  return (
    <div className="post-state" role="status">
      <Loader2 size={22} className="post-spin" />
      <span>Loading posts…</span>
    </div>
  );
}

function PostQueryError({
  error,
  onRetry,
  retrying = false,
  single = false,
}: {
  error: unknown;
  onRetry: () => void;
  retrying?: boolean;
  single?: boolean;
}) {
  return (
    <div className="post-query-error" role="alert">
      <Shield size={24} />
      <h3>
        {single ? "This post isn’t available" : "Posts couldn’t be loaded"}
      </h3>
      <p>{errorMessage(error)}</p>
      {single && (
        <p>
          It may have been deleted, or your account may not have access. Private
          Lounge posts still require membership.
        </p>
      )}
      <button
        type="button"
        className="post-button"
        onClick={onRetry}
        disabled={retrying}
      >
        <RefreshCw size={17} className={retrying ? "post-spin" : undefined} />
        {retrying ? "Retrying…" : "Try again"}
      </button>
    </div>
  );
}

export function PostFeed({
  ownerId,
  loungeId,
  search = "",
  title,
  onCreate,
  compact = false,
}: FeedProps) {
  const { user, loading } = useAuth();
  const params = new URLSearchParams();
  if (ownerId !== undefined) params.set("ownerId", String(ownerId));
  if (loungeId) params.set("loungeId", loungeId);
  const path = `/posts${params.size ? `?${params.toString()}` : ""}`;
  const query = useData<RegularPost[]>(path);
  const posts = filterPosts(query.data || [], search);
  const heading =
    title ||
    (ownerId !== undefined
      ? ownerId === user?.id
        ? "Your posts"
        : "Profile posts"
      : loungeId
        ? "Lounge posts"
        : "Community posts");
  return (
    <section
      className={`post-feed${compact ? " post-feed-compact" : ""}`}
      aria-label={heading}
    >
      <div className="post-feed-head">
        <div>
          <h2>{heading}</h2>
          {!compact && (
            <p>
              {ownerId !== undefined
                ? "Profile and Lounge updates, each with its own audience."
                : "Thoughts, photos, and moments between matches."}
            </p>
          )}
        </div>
        {onCreate && (
          <button
            type="button"
            className="post-button post-button-primary"
            onClick={onCreate}
          >
            <Plus size={17} />
            Create post
          </button>
        )}
      </div>
      {loading || query.isPending ? (
        <PostLoading />
      ) : query.error ? (
        <PostQueryError
          error={query.error}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      ) : posts.length ? (
        <div className="post-list">
          {posts.map(post => (
            <PostCard
              key={`${user?.id ?? "anonymous"}:${post.id}`}
              post={post}
              userId={user?.id}
              refreshPhotos={() => query.refetch()}
            />
          ))}
        </div>
      ) : (
        <div className="post-empty">
          <MessageSquare size={28} />
          <h3>
            {search.trim()
              ? "No matching posts"
              : ownerId === user?.id && user
                ? "Your next update starts here"
                : "No posts yet"}
          </h3>
          <p>
            {search.trim()
              ? "Try another word from the post or the author’s name."
              : "Text, photos, or a little of both. Share when you’re ready."}
          </p>
          {onCreate && !search.trim() && (
            <button type="button" className="post-button" onClick={onCreate}>
              <Pencil size={17} />
              Write a post
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function PostPage({ id }: { id: string }) {
  const { user, loading } = useAuth();
  return (
    <PostPageContent
      key={`${user?.id ?? "anonymous"}:${id}`}
      id={id}
      userId={user?.id}
      authLoading={loading}
    />
  );
}

function PostPageContent({
  id,
  userId,
  authLoading,
}: {
  id: string;
  userId?: number;
  authLoading: boolean;
}) {
  const query = useData<RegularPost>(
    `/posts/${encodeURIComponent(id)}`,
    Boolean(id)
  );
  const [deleted, setDeleted] = useState(false);
  return (
    <section className="post-page">
      <Link href="/" className="post-back">
        <ArrowLeft size={17} />
        Back to Discover
      </Link>
      <div className="post-page-heading">
        <span className="post-eyebrow">FROM THE COMMUNITY</span>
        <h1>A shared moment.</h1>
      </div>
      {deleted ? (
        <div className="post-empty" role="status">
          <Check size={28} />
          <h2>Post deleted</h2>
          <p>Your text and photos are no longer available through this post.</p>
        </div>
      ) : authLoading || query.isPending ? (
        <PostLoading />
      ) : query.error ? (
        <PostQueryError
          single
          error={query.error}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      ) : query.data ? (
        <PostCard
          post={query.data}
          userId={userId}
          refreshPhotos={() => query.refetch()}
          onDeleted={() => setDeleted(true)}
        />
      ) : null}
    </section>
  );
}

function PostCard({
  post,
  userId,
  refreshPhotos,
  onDeleted,
}: {
  post: RegularPost;
  userId?: number;
  refreshPhotos: RefreshPosts;
  onDeleted?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const author = userId !== undefined && post.ownerId === userId;
  const isPrivate = post.audience !== "public";
  const selectedIndex = post.photos.findIndex(
    photo => photo.id === selectedPhoto
  );
  const postPath = `/post/${encodeURIComponent(post.id)}`;
  if (deleted) return null;
  return (
    <article
      className="regular-post-card"
      aria-label={`Post by ${post.ownerName}`}
    >
      <header className="regular-post-header">
        <span className="post-avatar" aria-hidden="true">
          {post.ownerName.trim().slice(0, 1).toLocaleUpperCase() || (
            <MessageSquare size={18} />
          )}
        </span>
        <div className="regular-post-author">
          <strong>{post.ownerName}</strong>
          <div className="regular-post-time">
            <Link
              className="regular-post-permalink"
              href={postPath}
              aria-label={`View post by ${post.ownerName}, ${formatPostTime(post.createdAt)}`}
            >
              <time
                dateTime={
                  Number.isNaN(new Date(post.createdAt).getTime())
                    ? undefined
                    : post.createdAt
                }
              >
                {formatPostTime(post.createdAt)}
              </time>
            </Link>
            {post.updatedAt && post.updatedAt !== post.createdAt && (
              <span title={`Edited ${formatPostTime(post.updatedAt)}`}>
                · edited
              </span>
            )}
          </div>
        </div>
      </header>
      <div
        className={`regular-post-audience${isPrivate ? " regular-post-private" : ""}`}
      >
        {isPrivate ? <LockKeyhole size={13} /> : <Globe2 size={13} />}
        <span>{postAudienceLabel(post)}</span>
      </div>
      {post.text && <p className="regular-post-text">{post.text}</p>}
      {post.photos.length > 0 && (
        <div
          className={`regular-post-photos regular-post-photos-${Math.min(post.photos.length, 4)}`}
          aria-label="Post photos"
        >
          {post.photos.slice(0, 4).map((photo, index) => (
            <button
              type="button"
              className="regular-post-photo"
              key={photo.id}
              onClick={() => setSelectedPhoto(photo.id)}
              aria-label={`Enlarge photo ${index + 1} of ${post.photos.length} by ${post.ownerName}`}
            >
              <PostImage
                postId={post.id}
                photo={photo}
                alt={`Photo ${index + 1} of ${post.photos.length} shared by ${post.ownerName}`}
                onRefresh={refreshPhotos}
              />
            </button>
          ))}
        </div>
      )}
      <footer className="regular-post-actions">
        <button
          type="button"
          className="post-action"
          onClick={() => setSharing(true)}
        >
          <Link2 size={17} />
          Share link
        </button>
        {author && (
          <div className="regular-post-owner-actions">
            <button
              type="button"
              className="post-action"
              onClick={() => setEditing(true)}
              aria-label="Edit your post"
            >
              <Pencil size={16} />
              Edit
            </button>
            <button
              type="button"
              className="post-action post-action-danger"
              onClick={() => setDeleting(true)}
              aria-label="Delete your post"
            >
              <Trash2 size={16} />
              <span className="post-delete-label">Delete</span>
            </button>
          </div>
        )}
      </footer>
      {sharing && <SharePost post={post} onClose={() => setSharing(false)} />}
      {editing && author && (
        <EditPost
          post={post}
          onRefreshPhotos={refreshPhotos}
          onClose={() => setEditing(false)}
        />
      )}
      {deleting && author && (
        <DeletePost
          post={post}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setDeleted(true);
            onDeleted?.();
          }}
        />
      )}
      {selectedIndex >= 0 && (
        <PostDialog
          photo
          title={`Photo ${selectedIndex + 1} of ${post.photos.length}`}
          subtitle={`Shared by ${post.ownerName} · ${postAudienceLabel(post)}`}
          onClose={() => setSelectedPhoto(null)}
          onKeyDown={event => {
            if (post.photos.length < 2) return;
            if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
              event.preventDefault();
              const direction = event.key === "ArrowRight" ? 1 : -1;
              setSelectedPhoto(
                post.photos[
                  (selectedIndex + direction + post.photos.length) %
                    post.photos.length
                ].id
              );
            }
          }}
        >
          <div className="post-photo-viewer">
            <PostImage
              key={post.photos[selectedIndex].id}
              large
              postId={post.id}
              photo={post.photos[selectedIndex]}
              alt={`Enlarged photo ${selectedIndex + 1} of ${post.photos.length} shared by ${post.ownerName}`}
              onRefresh={refreshPhotos}
            />
          </div>
          {post.photos.length > 1 && (
            <div className="post-photo-navigation">
              <button
                type="button"
                className="post-button"
                onClick={() =>
                  setSelectedPhoto(
                    post.photos[
                      (selectedIndex - 1 + post.photos.length) %
                        post.photos.length
                    ].id
                  )
                }
              >
                <ChevronLeft size={18} />
                Previous
              </button>
              <span aria-live="polite">
                {selectedIndex + 1} / {post.photos.length}
              </span>
              <button
                type="button"
                className="post-button"
                onClick={() =>
                  setSelectedPhoto(
                    post.photos[(selectedIndex + 1) % post.photos.length].id
                  )
                }
              >
                Next
                <ChevronRight size={18} />
              </button>
            </div>
          )}
          <p className="post-photo-privacy">
            <Shield size={14} />
            Enlarging or sharing this post never changes its audience.
          </p>
        </PostDialog>
      )}
    </article>
  );
}

/** One immediate refetch/retry per failure; normal 10-second queries also rotate tickets. */
function PostImage({
  postId,
  photo,
  alt,
  onRefresh,
  large = false,
}: {
  postId: string;
  photo: PostPhoto;
  alt: string;
  onRefresh: RefreshPosts;
  large?: boolean;
}) {
  const candidateUrl = postPhotoUrl(
    postId,
    photo.id,
    photo.url,
    typeof window === "undefined"
      ? "https://invalid.local"
      : window.location.origin
  );
  // Polls rotate private tickets, not image contents. Keep a loaded photo stable until it needs recovery.
  const [url, setUrl] = useState(candidateUrl);
  const [rotateUrl, setRotateUrl] = useState(false);
  useEffect(() => {
    if (rotateUrl || !url) setUrl(candidateUrl);
  }, [candidateUrl, rotateUrl, url]);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retried = useRef(false);
  const refreshingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function recover() {
    if (refreshingRef.current) return;
    setFailedUrl(url);
    setRotateUrl(true);
    if (retried.current || !url) return;
    retried.current = true;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await onRefresh();
    } catch {
      /* The query panel reports access/network errors; the tile stays safe. */
    } finally {
      refreshingRef.current = false;
      if (mounted.current) {
        setFailedUrl(null);
        setAttempt(value => value + 1);
        setRefreshing(false);
      }
    }
  }
  const failed = !url || failedUrl === url;
  return (
    <>
      {url && !failed && !refreshing && (
        <img
          key={`${url}:${attempt}`}
          className={`regular-post-image${large ? " regular-post-image-large" : ""}`}
          src={url}
          alt={alt}
          width={photo.width || undefined}
          height={photo.height || undefined}
          loading={large ? "eager" : "lazy"}
          decoding="async"
          referrerPolicy="same-origin"
          onError={() => void recover()}
          onLoad={() => {
            retried.current = false;
            setRotateUrl(false);
            setFailedUrl(null);
          }}
        />
      )}
      {(failed || refreshing) && (
        <span
          className="post-image-fallback"
          role="img"
          aria-label={
            refreshing ? `Refreshing ${alt}` : `${alt}. Image unavailable.`
          }
        >
          {refreshing ? (
            <Loader2 size={23} className="post-spin" />
          ) : (
            <ImageOff size={23} />
          )}
          <span>{refreshing ? "Refreshing photo…" : "Photo unavailable"}</span>
          {!refreshing && (
            <small>It may have been removed or access may have changed.</small>
          )}
        </span>
      )}
    </>
  );
}

function SharePost({
  post,
  onClose,
}: {
  post: RegularPost;
  onClose: () => void;
}) {
  const link = `${window.location.origin}/post/${encodeURIComponent(post.id)}`;
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const fieldId = useId();
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setCopyError(null);
    } catch {
      setCopyError(
        "Automatic copying isn’t available. Select the link below to copy it manually."
      );
    }
  }
  return (
    <PostDialog title="Share this post" onClose={onClose}>
      <div className="post-audience-note">
        <Shield size={19} />
        <span>
          <strong>{postAudienceLabel(post)}.</strong> A link does not change
          access. Private Lounge posts still require current membership; deleted
          posts cannot be opened.
        </span>
      </div>
      <label className="post-field post-share-field" htmlFor={fieldId}>
        <span>Post link</span>
        <input
          id={fieldId}
          readOnly
          value={link}
          onFocus={event => event.currentTarget.select()}
        />
      </label>
      {copyError && <PostError>{copyError}</PostError>}
      {copied && (
        <p className="post-copy-status" role="status">
          <Check size={17} />
          Link copied. The original audience still applies.
        </p>
      )}
      <div className="post-dialog-actions">
        <button type="button" className="post-button" onClick={onClose}>
          Done
        </button>
        <button
          type="button"
          className="post-button post-button-primary"
          onClick={() => void copy()}
        >
          {copied ? <Check size={17} /> : <Link2 size={17} />}
          {copied ? "Copy again" : "Copy link"}
        </button>
      </div>
    </PostDialog>
  );
}

function EditPost({
  post,
  onClose,
  onRefreshPhotos,
}: {
  post: RegularPost;
  onClose: () => void;
  onRefreshPhotos: RefreshPosts;
}) {
  const [original] = useState(post);
  const [text, setText] = useState(post.text);
  const [keepIds, setKeepIds] = useState(post.photos.map(photo => photo.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const submitting = useRef(false);
  const refresh = useRefresh();
  const dirty =
    text !== original.text || keepIds.length !== original.photos.length;
  const valid =
    Boolean(text.trim() || keepIds.length) && text.length <= POST_LIMITS.text;
  const textId = useId();
  const counterId = useId();
  function requestClose() {
    if (submitting.current) return;
    if (dirty) setDiscard(true);
    else onClose();
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !valid || !dirty) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await patch<RegularPost>(`/posts/${encodeURIComponent(post.id)}`, {
        text,
        keepPhotoIds: keepIds,
        confirmed: true,
      });
      await refresh();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <PostDialog
        title="Edit your post"
        subtitle="Update the text or remove photos. The destination and audience cannot be changed here."
        busy={busy}
        onClose={requestClose}
      >
        <form className="post-form" onSubmit={save}>
          <div className="post-field">
            <label htmlFor={textId}>Post text</label>
            <textarea
              id={textId}
              rows={5}
              maxLength={POST_LIMITS.text}
              value={text}
              disabled={busy}
              aria-describedby={counterId}
              onChange={event => setText(event.target.value)}
            />
            <span
              className={`post-counter${text.length >= POST_LIMITS.text ? " post-counter-limit" : ""}`}
              id={counterId}
            >
              {text.length.toLocaleString()} /{" "}
              {POST_LIMITS.text.toLocaleString()} characters
            </span>
          </div>
          {keepIds.length > 0 && (
            <div className="post-draft-grid" aria-label="Photos to keep">
              {original.photos
                .filter(photo => keepIds.includes(photo.id))
                .map((photo, index) => (
                  <div className="post-draft-photo" key={photo.id}>
                    <PostImage
                      postId={post.id}
                      photo={
                        post.photos.find(current => current.id === photo.id) ||
                        photo
                      }
                      alt={`Photo ${index + 1} to keep`}
                      onRefresh={onRefreshPhotos}
                    />
                    <button
                      type="button"
                      className="post-photo-remove"
                      disabled={busy}
                      onClick={() =>
                        setKeepIds(ids => ids.filter(id => id !== photo.id))
                      }
                      aria-label={`Remove photo ${index + 1} from post`}
                    >
                      <X size={18} />
                    </button>
                  </div>
                ))}
            </div>
          )}
          {keepIds.length !== original.photos.length && (
            <button
              type="button"
              className="post-button post-restore"
              disabled={busy}
              onClick={() => setKeepIds(original.photos.map(photo => photo.id))}
            >
              <RefreshCw size={16} />
              Restore removed photos
            </button>
          )}
          {!valid && (
            <p className="post-validation">
              Keep some text or at least one photo. To remove everything, delete
              the post instead.
            </p>
          )}
          <div className="post-audience-note">
            <Shield size={17} />
            <span>
              Audience unchanged: <strong>{postAudienceLabel(post)}</strong>.
            </span>
          </div>
          {error && <PostError>{error}</PostError>}
          <div className="post-dialog-actions">
            <button
              type="button"
              className="post-button"
              disabled={busy}
              onClick={requestClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="post-button post-button-primary"
              disabled={busy || !valid || !dirty}
            >
              {busy ? (
                <Loader2 size={17} className="post-spin" />
              ) : (
                <Check size={17} />
              )}
              {busy ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </PostDialog>
      {discard && (
        <DiscardDraft onKeep={() => setDiscard(false)} onDiscard={onClose} />
      )}
    </>
  );
}

function DeletePost({
  post,
  onClose,
  onDeleted,
}: {
  post: RegularPost;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const deleted = useRef(false);
  const refresh = useRefresh();
  async function remove() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!deleted.current) {
        await api(`/posts/${encodeURIComponent(post.id)}`, {
          method: "DELETE",
          body: JSON.stringify({ confirmed: true }),
        });
        deleted.current = true;
      }
      await refresh();
      onDeleted();
      onClose();
    } catch (cause) {
      setError(
        deleted.current
          ? `Your post was deleted, but refreshing failed: ${errorMessage(cause)} Retry to finish without deleting again.`
          : errorMessage(cause)
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <PostDialog
      title="Delete your post?"
      subtitle="This action cannot be undone."
      busy={busy}
      onClose={() => {
        if (!submitting.current) onClose();
      }}
    >
      <p className="post-dialog-copy">
        Your post’s text and photos will no longer be available, including
        through previously shared links.
      </p>
      {error && <PostError>{error}</PostError>}
      <div className="post-dialog-actions">
        <button
          type="button"
          className="post-button"
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="post-button post-button-danger"
          disabled={busy}
          onClick={() => void remove()}
        >
          {busy ? (
            <Loader2 size={17} className="post-spin" />
          ) : (
            <Trash2 size={17} />
          )}
          {busy
            ? "Deleting…"
            : deleted.current
              ? "Finish refresh"
              : "Delete post"}
        </button>
      </div>
    </PostDialog>
  );
}
