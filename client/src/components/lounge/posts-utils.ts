import { POST_LIMITS, type RegularPost } from "@shared/post-types";

export const POST_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

export function postPhotoError(
  files: ReadonlyArray<Pick<File, "name" | "type" | "size">>,
  existingCount = 0
): string | null {
  if (existingCount + files.length > POST_LIMITS.photos)
    return `Choose up to ${POST_LIMITS.photos} photos per post. Remove a photo before adding more.`;
  for (const file of files) {
    if (!POST_PHOTO_TYPES.includes(file.type.toLowerCase()))
      return `${file.name}: choose a JPEG, PNG or WebP image.`;
    if (file.size === 0)
      return `${file.name}: this file is empty. Choose another photo.`;
    if (file.size > POST_LIMITS.photoBytes)
      return `${file.name}: each photo must be 8 MiB or smaller.`;
  }
  return null;
}

export function buildPostForm(
  text: string,
  destination: "profile" | "lounge",
  loungeId: string,
  photos: ReadonlyArray<File>
): FormData {
  // Authorization metadata must arrive before any photo bytes.
  const form = new FormData();
  form.append("text", text);
  form.append("destination", destination);
  if (destination === "lounge") form.append("loungeId", loungeId);
  form.append("confirmed", "true");
  photos.forEach(photo => form.append("photos", photo));
  return form;
}

/** Never render arbitrary remote image URLs, storage URLs, data URLs or redirects. */
export function postPhotoUrl(
  postId: string,
  photoId: string,
  value: string,
  origin: string
): string | null {
  try {
    const url = new URL(value, origin);
    const expected = `/api/media/post-photo/${encodeURIComponent(postId)}/${encodeURIComponent(photoId)}`;
    if (
      !value ||
      url.origin !== new URL(origin).origin ||
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== expected
    )
      return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

export function postAudienceLabel(
  post: Pick<RegularPost, "destination" | "audience" | "loungeName">
): string {
  if (post.destination === "profile") return "Public · Profile";
  const name = post.loungeName || "Lounge";
  return post.audience === "public"
    ? `Public Lounge · ${name}`
    : `Private Lounge · ${name}`;
}

export function formatPostTime(value: string, locale?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function filterPosts(posts: RegularPost[], search = ""): RegularPost[] {
  const query = search.trim().toLocaleLowerCase();
  return query
    ? posts.filter(post =>
        `${post.text} ${post.ownerName}`.toLocaleLowerCase().includes(query)
      )
    : posts;
}
