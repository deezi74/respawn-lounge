import { useQuery, useQueryClient } from "@tanstack/react-query";
import { COOKIE_NAME } from "@shared/const";
import { useAuth } from "@/_core/hooks/useAuth";

export function authHeaders(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem("manus-cookie");
    const prefix = `${COOKIE_NAME}=`;
    const token = raw
      ?.split(";")
      .find(x => x.trim().startsWith(prefix))
      ?.trim()
      .slice(prefix.length);
    if (token) return { Authorization: `Bearer ${token}` };
  } catch {
    /* cookie-based login remains available */
  }
  return {};
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const form = init.body instanceof FormData;
  const response = await fetch(
    path.startsWith("/api/") ? path : `/api/app${path}`,
    {
      credentials: "include",
      ...init,
      headers: {
        ...authHeaders(),
        ...(!form && init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    }
  );
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: `Request failed (${response.status})` }));
    throw new Error(
      error.error || error.message || `Request failed (${response.status})`
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
export const post = <T>(path: string, data: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(data) });
export const patch = <T>(path: string, data: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(data) });
export function useData<T>(path: string, enabled = true) {
  const { user, loading } = useAuth();
  return useQuery({
    queryKey: ["app", user?.id ?? "anonymous", path],
    queryFn: () => api<T>(path),
    enabled: enabled && !loading,
    refetchInterval: 10000,
    retry: false,
  });
}
export function useRefresh() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ["app"] });
}
export function seconds(value: number) {
  const n = Math.max(0, Math.floor(value));
  return `${Math.floor(n / 60)
    .toString()
    .padStart(2, "0")}:${(n % 60).toString().padStart(2, "0")}`;
}
export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
