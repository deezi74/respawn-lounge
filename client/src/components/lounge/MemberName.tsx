import { useData } from "@/lib/app-api";
import type { Profile } from "@shared/profile-types";
export function MemberName({
  userId,
  fallback,
}: {
  userId: number;
  fallback: string;
}) {
  const profile = useData<Profile>(
    `/profiles/${userId}`,
    Number.isSafeInteger(userId) && userId > 0
  );
  return <>{(!profile.error && profile.data?.displayName) || fallback}</>;
}
