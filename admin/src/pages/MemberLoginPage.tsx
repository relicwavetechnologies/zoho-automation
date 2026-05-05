import { Link } from "react-router-dom"
import { AuthCard } from "@/components/admin/auth-card"
import { Button } from "@/components/ui/button"

export function MemberLoginPage() {
  return (
    <AuthCard title="Member access" description="Member authentication remains handled by the desktop/member product surface.">
      <div className="space-y-4">
        <p className="text-sm leading-6 text-muted-foreground">
          This admin console is for company-admin and super-admin sessions. Use the member app for regular workspace login.
        </p>
        <Button asChild className="w-full rounded-full">
          <Link to="/login">Back to admin login</Link>
        </Button>
      </div>
    </AuthCard>
  )
}
