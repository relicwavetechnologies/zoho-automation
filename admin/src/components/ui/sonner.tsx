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
    /*
     * Bottom, not top.
     *
     * Top-right sat directly over Cancel and Turn it on — the two controls a
     * message about the form is almost always about — so the answer covered the
     * question. Down here it is out of the way of every header in the app and
     * still in the corner the eye goes to after pressing something.
     */
    position="bottom-right"
    offset={20}
    gap={10}
    {...props}
  />
)

export { Toaster }
