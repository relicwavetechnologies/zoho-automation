/**
 * Linking a WhatsApp number, from the web app.
 *
 * Urban Aura's people do this themselves and never see the gateway's own
 * dashboard, so the QR is proxied out through Divo. It rotates roughly every
 * twenty seconds, which is why this polls instead of fetching once — a saved
 * QR is stale before it can be scanned.
 *
 * The two-step shape is deliberate. Naming the number creates it on the gateway
 * *and registers Divo's webhook* before anything is scanned; a handset that
 * links while no subscription exists delivers its first messages into nothing,
 * and nothing later goes back for them.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, QrCode, TriangleAlert } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { notify } from '@/lib/notify'
import { usePairing, type PairingQr } from '../data/use-follow-ups'
import { Prompt } from '../ui'

/**
 * What the dialog says while it waits, keyed on what the poll last saw.
 *
 * Three seconds is a long time to look at an unchanging picture and wonder
 * whether anything is happening.
 */
const WAITING_LABEL: Record<string, string> = {
  pending: 'Waiting for you to scan…',
  // The scan landed and the handset is being brought up. Worth its own line:
  // it is the moment a person most wants to know something is happening.
  disconnected: 'Not connected yet — the code above is still live.',
  unknown: 'Waiting for the gateway…',
}

/** E.164, matched against the same rule the route enforces. */
const E164 = /^\+[1-9]\d{7,14}$/

export function LinkNumberDialog({ numberId, label, token, onClose, onLinked }: {
  numberId: string
  label: string
  token?: string
  onClose: () => void
  onLinked: () => void
}) {
  const { pairing, error, linked, requestCode } = usePairing(numberId, token)

  // Refresh the list the moment the link lands, not when the dialog is
  // dismissed. Otherwise the row behind still reads "waiting to be linked"
  // while the dialog in front says it is linked — and whichever one a person
  // believes, the page has told them two different things.
  useEffect(() => { if (linked) onLinked() }, [linked, onLinked])
  const [phone, setPhone] = useState('')
  const [codeError, setCodeError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)

  const askForCode = async () => {
    if (!E164.test(phone.trim())) {
      setCodeError('Write the number in full, starting with the country code — +919876543210.')
      return
    }
    setAsking(true)
    setCodeError(null)
    try {
      await requestCode(phone.trim())
    } catch {
      setCodeError('The gateway would not issue a code for that number.')
    } finally {
      setAsking(false)
    }
  }

  const done = () => onClose()

  return (
    <>
      <div className="ws-scrim" onClick={linked ? done : onClose} />
      <div className="ws-modal-wrap">
        <div className="ws-modal" role="dialog" aria-label={`Link ${label}`}>
          <div className="ws-modal-h">
            <h2>{linked ? `${label} is linked` : `Link ${label}`}</h2>
            <p>
              {linked
                ? 'Divo is reading this number now. Its conversations appear under Chats within a few minutes.'
                : 'On the phone: WhatsApp → Settings → Linked devices → Link a device, then scan this.'}
            </p>
          </div>

          <div className="ws-modal-b">
            {linked ? (
              <div className="ws-ceiling" role="status">
                <Check size={14} aria-hidden />
                <div>
                  <b>Scanned.</b> Leave the phone online and connected — Divo reads through it,
                  so a handset that is switched off stops producing follow-ups.
                </div>
              </div>
            ) : null}

            {/*
              Fail Loudly: a dialog that just sits there empty is read as "still
              loading", and somebody waits out a gateway that is never going to
              answer.
            */}
            {!linked && error ? (
              <div className="ws-ceiling" role="alert">
                <TriangleAlert size={14} aria-hidden />
                <div><b>{error}</b> The number is saved — reopen this once the gateway is back.</div>
              </div>
            ) : null}

            {!linked && !error ? (
              <>
                <QrPanel qr={pairing?.qr} />
                {/*
                  Says what the poll is seeing, every three seconds.
                  Without it the dialog is a static picture for however long the
                  scan takes, and there is no way to tell "waiting for you" from
                  "stuck" — which is exactly the moment somebody gives up and
                  reloads, losing the QR they were part-way through scanning.
                */}
                <p className="ws-lbl" style={{ marginTop: 12, textAlign: 'center' }} role="status">
                  {WAITING_LABEL[pairing?.status ?? 'unknown'] ?? WAITING_LABEL.unknown}
                </p>
              </>
            ) : null}

            {/*
              The pairing code is not a hidden fallback. A QR that will not take
              is the common failure on a handset with a dim screen or an old
              camera, and hunting for the alternative is where people give up.
            */}
            {!linked ? (
              <div style={{ marginTop: 18 }}>
                {pairing?.pairingCode ? (
                  <>
                    <div className="ws-lbl">Type this code on the phone</div>
                    <div className="raw" style={{ marginTop: 8 }}>
                      <pre>{pairing.pairingCode}</pre>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="ws-lbl">Camera not cooperating? Get a code instead</div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <input
                        className="input"
                        value={phone}
                        placeholder="+919876543210"
                        onChange={(e) => { setPhone(e.target.value); setCodeError(null) }}
                        onKeyDown={(e) => { if (e.key === 'Enter') void askForCode() }}
                        style={{ flex: 1 }}
                      />
                      <button
                        type="button"
                        className="btn"
                        disabled={asking || !phone.trim()}
                        onClick={() => void askForCode()}
                      >
                        {asking ? 'Asking…' : 'Get code'}
                      </button>
                    </div>
                    {codeError ? <p className="ws-lbl" style={{ marginTop: 8 }}>{codeError}</p> : null}
                  </>
                )}
              </div>
            ) : null}
          </div>

          <div className="ws-modal-f">
            {linked ? (
              <button type="button" className="btn primary" onClick={done}>Done</button>
            ) : (
              <button type="button" className="btn" onClick={onClose}>Close</button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

/**
 * The QR itself, or an honest account of why there is not one.
 *
 * The `payload` case is the one worth having: some gateways return the string a
 * QR encodes rather than a rendered image, and putting that into an `<img src>`
 * draws a broken image. A broken image reads as "linking is broken", which is
 * the wrong conclusion and the wrong next action.
 */
function QrPanel({ qr }: { qr?: PairingQr }) {
  if (!qr) {
    return (
      <p className="ws-lbl" role="status">
        Waiting for the gateway to produce a code…
      </p>
    )
  }

  if (qr.kind === 'image') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <img
          src={qr.src}
          alt="WhatsApp linking QR code"
          width={220}
          height={220}
          style={{ imageRendering: 'pixelated' }}
        />
      </div>
    )
  }

  return (
    <div className="ws-ceiling" role="status">
      <QrCode size={14} aria-hidden />
      <div>
        <b>This gateway returns a QR this screen cannot draw.</b>{' '}
        Use a pairing code below — it links the same handset the same way.
      </div>
    </div>
  )
}

/**
 * Name it, then link it.
 *
 * Kept beside the dialog rather than in the screen because the two steps are one
 * decision: a number that is named but never linked is a row that does nothing,
 * and the person who created it is the only one who knows what it was for.
 */
export function LinkNumberFlow({ token, onCreate, onLinked, onClose }: {
  token?: string
  onCreate: (label: string) => Promise<string>
  onLinked: () => void
  onClose: () => void
}) {
  const [created, setCreated] = useState<{ id: string; label: string } | null>(null)
  // `Prompt` closes itself once `onConfirm` resolves, and here resolving means
  // "move to step two" rather than "we are finished". Without this the dialog
  // would name a number and then vanish before anybody could scan for it.
  const advanced = useRef(false)

  if (created) {
    return (
      <LinkNumberDialog
        numberId={created.id}
        label={created.label}
        token={token}
        onClose={onClose}
        onLinked={onLinked}
      />
    )
  }

  return (
    <Prompt
      title="Link a WhatsApp number"
      description="Name the handset first — this registers it with the gateway and points its webhook at Divo, which has to happen before anything is scanned."
      label="What is this number for?"
      placeholder="Bookings desk"
      confirm="Continue"
      onConfirm={async (label) => {
        try {
          const id = await onCreate(label)
          advanced.current = true
          setCreated({ id, label })
        } catch (e) {
          // Caught rather than thrown so `Prompt` still closes. Left uncaught it
          // would leave the dialog stuck on a spinner with no explanation.
          const isRefusal =
            e instanceof ApiError &&
            ((e.status === 403 && e.code === 'not_permitted') ||
              (e.status === 503 && e.code === 'permission_unavailable') ||
              (e.status === 409 && e.code === 'no_active_department'))
          notify.failed(
            'Could not register the number',
            isRefusal && e instanceof Error && e.message
              ? e.message
              : 'The WhatsApp gateway did not answer, so nothing was created.',
          )
        }
      }}
      onClose={() => { if (!advanced.current) onClose() }}
    />
  )
}
