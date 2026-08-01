import { Link } from "react-router-dom"
import { MessageSquare, Monitor } from "lucide-react"
import { AuthCard } from "@/components/admin/auth-card"

/**
 * Reached by anyone who followed a member link into the admin host. There is no
 * member session here, so the only useful thing this page can do is say where
 * Divo actually lives and send them there.
 */
export function MemberLoginPage() {
  return (
    <AuthCard
      title="There is nothing to sign into here"
      description="This console is for company admins. As a member you use Divo in Lark or in the desktop app."
    >
      <div className="ws-auth-form">
        <div className="ws-auth-list" style={{ marginTop: 0 }}>
          <div>
            <MessageSquare size={15} />
            <div>
              <b>In Lark</b>
              <p>Message Divo directly, or mention it in any group you are already in.</p>
            </div>
          </div>
          <div>
            <Monitor size={15} />
            <div>
              <b>In the desktop app</b>
              <p>Sign in with the same work account. Anything you connect there follows you into Lark.</p>
            </div>
          </div>
        </div>
        <Link className="btn" to="/login" style={{ justifyContent: "center" }}>Admin sign in</Link>
      </div>
    </AuthCard>
  )
}
