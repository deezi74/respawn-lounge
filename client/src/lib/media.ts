import { api, authHeaders } from "./app-api";

export async function refreshMedia(resource: string) {
  return api<{ url: string; expiresIn: number }>("/media-ticket", {
    method: "POST",
    body: JSON.stringify({ resource }),
  });
}
export async function downloadClip(
  id: string,
  title: string,
  progress: (percent: number) => void
) {
  const { url } = await refreshMedia(`download/${id}`);
  const chunks: BlobPart[] = [];
  let offset = 0,
    total = 0;
  do {
    const res = await fetch(url, {
      credentials: "include",
      headers: {
        ...authHeaders(),
        Range: `bytes=${offset}-${offset + 8 * 1024 * 1024 - 1}`,
      },
    });
    if (!res.ok)
      throw new Error(
        "Clip download failed. Access or download permission may have changed."
      );
    const range = res.headers.get("Content-Range");
    if (range) {
      const match = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
      if (!match) throw new Error("Invalid media range response.");
      total = Number(match[3]);
    }
    const bytes = await res.arrayBuffer();
    if (!bytes.byteLength)
      throw new Error("Clip download stopped unexpectedly.");
    chunks.push(bytes);
    offset += bytes.byteLength;
    if (!range) total = offset;
    progress(Math.min(100, Math.round((offset / total) * 100)));
  } while (offset < total);
  const blob = new Blob(chunks, { type: "video/mp4" });
  const objectUrl = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = objectUrl;
  a.download =
    (title.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 80) || "respawn-clip") +
    ".mp4";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
}
