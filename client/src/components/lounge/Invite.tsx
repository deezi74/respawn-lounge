import { useState } from "react";
import { Link } from "wouter";
import { Shield, Users, ArrowUpRight, Check } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import { post, useRefresh } from "@/lib/app-api";
import { Confirm } from "./Controls";
export default function Invite({ id }: { id: string }) {
  const { user } = useAuth();
  const refresh = useRefresh();
  const [confirm, setConfirm] = useState(false),
    [sent, setSent] = useState(false);
  return (
    <div className="invite-page">
      <div className="invite-symbol">
        <Users size={34} />
      </div>
      <span className="eyebrow">YOUR PEOPLE ARE ONE REQUEST AWAY</span>
      <h1>A place in the Lounge.</h1>
      <p>
        This link lets you request membership. Private videos, clips and member
        details stay hidden until the owner approves you.
      </p>
      <div className="inline-note">
        <Shield size={16} />
        An invite is not a public-access link.
      </div>
      {sent ? (
        <div className="invite-sent">
          <Check size={20} />
          <strong>Request sent.</strong>
          <p>
            The owner can approve you in My Lounges. Your private content access
            begins after approval.
          </p>
          <Link className="btn" href="/lounges">
            My Lounges
            <ArrowUpRight size={16} />
          </Link>
        </div>
      ) : (
        <button
          className="btn primary"
          onClick={() => {
            if (user) setConfirm(true);
            else {
              sessionStorage.setItem("respawn-pending-invite", id);
              startLogin();
            }
          }}
        >
          {user ? "Request to join" : "Sign in to request membership"}
          <ArrowUpRight size={16} />
        </button>
      )}
      {confirm && (
        <Confirm
          title="Send a Lounge join request?"
          description="Your name and request will be sent to this Lounge’s owner. The link does not grant access until they approve membership."
          label="Send request"
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            await post(`/lounges/${encodeURIComponent(id)}/join`, {
              confirmed: true,
            });
            await refresh();
            setSent(true);
            toast.success("Membership request sent.");
          }}
        />
      )}
    </div>
  );
}
