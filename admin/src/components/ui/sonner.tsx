/**
 * Divo's toaster.
 *
 * Carries `cur` itself. The design tokens are declared on `.cur` and
 * `.dark .cur`, and this renders at the root of the app outside every shell —
 * so `var(--cur-surface)` resolved to nothing and the toast came out with no
 * background at all, legible only against whatever happened to be behind it.
 *
 * `richColors` stays off: it paints the whole card by intent, which announced a
 * refusal as loudly as an outage. The intent is one coloured dot instead, so
 * the words carry the meaning.
 *
 * What a toast says is decided in `lib/notify.ts`, not here.
 */
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => (
  <Sonner
    className="cur cur-toast toaster group"
    /*
     * Bottom centre.
     *
     * Top-right sat over Cancel and Turn it on — the two controls a message
     * about a form is almost always about. Bottom centre is out of every
     * header's way and on the axis the eye is already on after pressing
     * something in the middle of a page.
     */
    position="bottom-center"
    offset={24}
    gap={10}
    {...props}
  />
)

export { Toaster }
