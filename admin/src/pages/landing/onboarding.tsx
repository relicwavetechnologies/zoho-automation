/**
 * The wall between a typed sentence and an answer, made as short as it can be.
 *
 * It opens over the landing rather than replacing it, and it keeps the sentence
 * they typed at the top of every card. That is the whole design. Somebody who
 * types "pull last month's invoices into a sheet" and gets bounced to a signup
 * form has been told the thing they wanted is not what this is for; somebody
 * who sees their own sentence sitting above four short questions has been told
 * it is waiting.
 *
 * The questions live in `signup.ts`. This draws them.
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Loader2, Mail, X } from 'lucide-react'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { DivoMark } from '@/components/admin/divo-mark'
import { Showcase } from './showcase.view'
import { api } from '@/lib/api'
import {
  EMPTY_DRAFT, FIRST_STEP, MIN_PASSWORD, TOTAL_STEPS, advance, answered,
  companyFromEmail, problem, retreat, stepIndex,
  type Draft, type Role, type Step,
} from './signup'
import './landing.css'

export function Onboarding({ prompt, onClose, onDone }: {
  /** What they typed before they had an account. Shown, never sent from here. */
  prompt: string
  onClose: () => void
  /** Signed in. The caller is what actually runs the prompt. */
  onDone: () => void
}) {
  const { loginWithPassword } = useAdminAuth()
  const [step, setStep] = useState<Step>(FIRST_STEP)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const set = (patch: Partial<Draft>): void => {
    setFailure(null)
    setDraft((was) => ({ ...was, ...patch }))
  }

  const forward = (): void => {
    const next = advance(step, draft)
    if (next === step) return
    if (next === 'submit') { void create(); return }
    /* The company card arrives pre-filled from the domain, and only ever the
       first time it is reached — overwriting an edited name every time somebody
       steps back and forward again is the field fighting the person in it. */
    if (next === 'company' && !draft.company) {
      set({ company: companyFromEmail(draft.email) })
    }
    setStep(next)
  }

  const create = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    try {
      await api.post('/api/admin/auth/signup/company-admin', {
        companyName: draft.company.trim(),
        name: draft.name.trim(),
        email: draft.email.trim(),
        password: draft.password,
      })
      /* Signing straight in with what they just chose, rather than handing them
         to /login. Being asked to type the password you invented ten seconds
         ago is the app admitting it did not keep anything. */
      await loginWithPassword(draft.email.trim(), draft.password)
      onDone()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'That did not go through.')
      setBusy(false)
    }
  }

  const back = (): void => {
    const previous = retreat(step)
    if (!previous) { onClose(); return }
    setFailure(null)
    setStep(previous)
  }

  /* Escape closes, which it must: a modal that opens on a keystroke and cannot
     be dismissed by one is a trap dressed as an invitation. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const note = problem(step, draft)
  const ready = answered(step, draft)

  return (
    <>
      <div className="ws-scrim" onClick={busy ? undefined : onClose} />
      <div className="lp-modal-wrap">
        <div className="lp-modal" role="dialog" aria-modal="true" aria-label="Create your workspace">

          {/*
           * One rail across the top, carrying the three things that are true of
           * every step: where you are, whose product this is, and the way out.
           *
           * It used to sit inside the questions column, which put the back
           * arrow and the close button at opposite ends of one half while the
           * other half had its own edge — and on the first step, where there is
           * nothing to go back to, the arrow became a second X sitting a few
           * hundred pixels from the first. Two identical close buttons is not a
           * layout problem, it is the reader asking which one is the real one.
           */}
          <header className="lp-modal-top">
            <div className="lp-modal-id">
              {retreat(step) ? (
                <button type="button" className="lp-icon-btn" onClick={back} disabled={busy} aria-label="Back">
                  <ArrowLeft size={15} />
                </button>
              ) : null}
              <span className="lp-modal-mark"><DivoMark size={15} /></span>
              <b className="display">Divo</b>
            </div>
            <div className="lp-modal-id">
              {step === 'invite' ? null : (
                <span className="lp-step-count">Step {stepIndex(step) + 1} of {TOTAL_STEPS}</span>
              )}
              <button type="button" className="lp-icon-btn" onClick={onClose} disabled={busy} aria-label="Close">
                <X size={15} />
              </button>
            </div>
          </header>

          <div className="lp-modal-body">
            {/*
             * Questions first, on the left, where reading starts.
             *
             * The reel was on this side and it had the argument backwards: the
             * thing you have to do was the thing you reached second. Now the
             * column you act in is the one your eye lands on, and the product
             * runs beside it as evidence rather than as an obstacle.
             */}
            <div className="lp-ask">
              <div className="lp-ask-body">
                {/* Their sentence, held where they can see it. The one thing
                    here that is not a question. */}
                {prompt ? (
                  <div className="lp-held">
                    <span className="lp-held-tag">Waiting to run</span>
                    <p>{prompt}</p>
                  </div>
                ) : null}

                <div className="lp-card">
                  <Card step={step} draft={draft} set={set} onEnter={forward} />
                  {note ? <p className="lp-note">{note}</p> : null}
                  {failure ? <p className="lp-fail">{failure}</p> : null}
                </div>
              </div>

              {/* Anchored to the bottom of its own column rather than floating
                  under whichever card happens to be showing. The action is in
                  the same place on all five steps, so it stops being something
                  to look for. */}
              <footer className="lp-modal-foot">
                {step === 'invite' ? (
                  <Link className="lp-go" to="/login">
                    Go to sign in
                    <ArrowRight size={14} />
                  </Link>
                ) : (
                  <button type="button" className="lp-go" onClick={forward} disabled={!ready || busy}>
                    {busy ? <Loader2 size={14} className="ws-spin" /> : null}
                    {busy ? 'Creating your workspace' : step === 'password' ? 'Create workspace and run it' : 'Continue'}
                    {busy ? null : <ArrowRight size={14} />}
                  </button>
                )}
                <p className="lp-foot-note">
                  {step === 'invite' ? (
                    'Nothing has been created.'
                  ) : (
                    <>Already have an account? <Link to="/login">Sign in</Link></>
                  )}
                </p>
              </footer>
            </div>

            {/* Divo working, beside the reason somebody is being asked to sign
                up for it. Four short runs, three of which stop — because what a
                buyer cannot tell from a happy-path demo is whether the thing
                will quietly email a customer. Hidden on a narrow screen, where
                there is room for one column and the questions are the one that
                has to be there. */}
            <Showcase />
          </div>
        </div>
      </div>
    </>
  )
}

function Card({ step, draft, set, onEnter }: {
  step: Step
  draft: Draft
  set: (patch: Partial<Draft>) => void
  onEnter: () => void
}) {
  /* Focus follows the card, because a card that arrives without the caret in it
     asks somebody to click the only field on screen. */
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => { first.current?.focus() }, [step])

  const enter = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    onEnter()
  }

  if (step === 'email') {
    return (
      <>
        <h2>What is your work email?</h2>
        <p className="lp-sub">This becomes your sign-in, here and in Lark. It is the only thing you cannot change later.</p>
        <input
          ref={first}
          className="lp-input"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          value={draft.email}
          onChange={(e) => set({ email: e.target.value })}
          onKeyDown={enter}
        />
      </>
    )
  }

  if (step === 'role') {
    return (
      <>
        <h2>Which one are you?</h2>
        {/* Said plainly, because it is true and because a role picker that
            quietly means nothing is worse than no role picker at all. */}
        <p className="lp-sub">
          This is not a permission level. It decides whether you are starting a workspace or joining one that already exists.
        </p>
        <div className="lp-choices">
          <Choice
            value="founder"
            picked={draft.role}
            onPick={(role) => set({ role })}
            title="I run the company, or part of it"
            body="You create the workspace and become its first admin. Divo starts with your department and you approve what it does in it."
          />
          <Choice
            value="member"
            picked={draft.role}
            onPick={(role) => set({ role })}
            title="I am joining my team"
            body="Somebody at your company sets Divo up and lets you in. Your access comes from the department they put you in."
          />
        </div>
      </>
    )
  }

  if (step === 'company') {
    return (
      <>
        <h2>Who is this for?</h2>
        <p className="lp-sub">The company name is what everyone sees, in the app and in Lark. We guessed it from your email.</p>
        <label className="lp-lbl" htmlFor="lp-company">Company name</label>
        <input
          ref={first}
          id="lp-company"
          className="lp-input"
          value={draft.company}
          onChange={(e) => set({ company: e.target.value })}
          onKeyDown={enter}
          placeholder="Acme Technologies"
        />
        <label className="lp-lbl" htmlFor="lp-name">Your name</label>
        <input
          id="lp-name"
          className="lp-input"
          autoComplete="name"
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
          onKeyDown={enter}
          placeholder="Abhishek Verma"
        />
      </>
    )
  }

  if (step === 'password') {
    return (
      <>
        <h2>Pick a password.</h2>
        <p className="lp-sub">{MIN_PASSWORD} characters or more. One account covers the web app, Lark and the desktop.</p>
        <input
          ref={first}
          className="lp-input"
          type="password"
          autoComplete="new-password"
          value={draft.password}
          onChange={(e) => set({ password: e.target.value })}
          onKeyDown={enter}
          placeholder="At least 8 characters"
        />
      </>
    )
  }

  /* The member path ends here. Not an error — Divo genuinely cannot do
     anything for them until somebody lets them in, and saying so beats
     letting them create a second, empty company with their colleagues in it. */
  return (
    <>
      <div className="lp-stop-ic"><Mail size={18} /></div>
      <h2>You need an invite.</h2>
      <p className="lp-sub">
        Your company&rsquo;s workspace belongs to whoever set it up, and only they can add you to it.
        Ask them to invite <b>{draft.email.trim() || 'your work address'}</b>, then open the link they send you.
      </p>
      <p className="lp-sub">
        We have not created anything, and your question is still here. Come back to it once you are in.
      </p>
    </>
  )
}

function Choice({ value, picked, onPick, title, body }: {
  value: Role
  picked: Role | null
  onPick: (role: Role) => void
  title: string
  body: string
}) {
  return (
    <button
      type="button"
      className="lp-choice"
      data-on={picked === value ? 'true' : undefined}
      onClick={() => onPick(value)}
    >
      <span className="lp-choice-t">{title}</span>
      <span className="lp-choice-b">{body}</span>
    </button>
  )
}
