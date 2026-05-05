import { AlertCircle } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"

type ErrorCalloutProps = {
  message: string | null
}

export function ErrorCallout({ message }: ErrorCalloutProps) {
  if (!message) return null
  return (
    <Card className="border-destructive/30 bg-destructive/5">
      <CardContent className="flex items-start gap-3 p-4 text-sm text-destructive">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p>{message}</p>
      </CardContent>
    </Card>
  )
}
