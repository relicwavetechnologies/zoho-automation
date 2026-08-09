/**
 * Divo's toaster.
 *
 * `richColors` is off on purpose: it paints the whole card by intent, which
 * announced a refusal in the same red as an outage. The intent lives in one
 * coloured dot (see `.ws` toast rules in workspace.css) so the words carry the
 * meaning, and the card stays Divo's own surface in both themes.
 *
 * What a toast says is decided in `lib/notify.ts`, not here.
 */
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => (
  <Sonner
    className="cur-toast toaster group"
    // Below the header rather than over it: a notice that covers the control
    // you just pressed hides the thing it is talking about.
    position="top-right"
    offset={16}
    gap={10}
    {...props}
  />
)

export { Toaster }
