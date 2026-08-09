/**
 * One message thread, reached from exactly one place.
 *
 * This is **not** an inbox and there is deliberately no list in front of it.
 * A member already has Gmail open; a second, worse mail client inside Divo
 * would lose that comparison on day one and would promise search, reply,
 * archive and threading that will never be built.
 *
 * What it is instead: the landing page for a link. Every row in Caught and
 * every line in the brief says something about a message, and a claim you
 * cannot open is a claim you have to take on faith. So the reader exists to
 * answer one question — *show me the mail you are talking about* — and it
 * carries nothing that is not in service of that.
 *
 * Nothing here defends you from the sender either. Image blocking, beacon
 * counting and link-destination warnings were drawn and then cut: they are a
 * security feature nobody asked for, on a screen that is open for ten seconds,
 * and dressing this up as a safe-mail-viewer would have been the prototype
 * arguing for a product nobody is buying.
 */
import { useState } from 'react'
import { ChevronDown, ExternalLink, FileSpreadsheet, FileText, Image as ImageIcon, Reply } from 'lucide-react'
import { GmailMark } from '@/pages/workspace/brand'
import { Note, initialsOf } from './kit'
import type { Attachment, Message, Thread } from './data'

const AttachIcon = ({ kind }: { kind: Attachment['kind'] }) =>
  kind === 'pdf' ? <FileText size={14} /> : kind === 'xlsx' ? <FileSpreadsheet size={14} /> : <ImageIcon size={14} />

function MessageBlock({ m }: { m: Message }) {
  return (
    <div className="mp-msg">
      <div className="mp-msg-h">
        <span className="mp-av">{initialsOf(m.fromName)}</span>
        <div className="mp-msg-who">
          <b>{m.fromName}</b>
          <span>{m.fromEmail}</span>
        </div>
        <span className="mp-msg-at">{m.at}</span>
      </div>

      <div className="mp-msg-b">
        {m.body.map((p, i) => <p key={i}>{p}</p>)}

        {m.links?.length ? (
          <div className="mp-links">
            {m.links.map((l) => (
              <a key={l.href} className="mp-link" href="#" onClick={(e) => e.preventDefault()}>
                <ExternalLink size={13} />
                <span className="t">{l.text}</span>
                <span className="h">{l.href}</span>
              </a>
            ))}
          </div>
        ) : null}

        {m.attachments?.length ? (
          <div className="mp-atts">
            {m.attachments.map((a) => (
              <div className="mp-att" key={a.name}>
                <span className="ic"><AttachIcon kind={a.kind} /></span>
                <b>{a.name}</b>
                <span className="sz">{a.size}</span>
                <button type="button" className="btn" onClick={(e) => e.preventDefault()}>Preview</button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function ThreadReader({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const [expanded, setExpanded] = useState(false)

  const earlier = thread.messages.slice(0, -1)
  const latest = thread.messages[thread.messages.length - 1]

  return (
    <div className="mp-reader">
      <div className="mp-reader-h">
        <div style={{ minWidth: 0 }}>
          <h1>{thread.subject}</h1>
          <p>{thread.messages.length} message{thread.messages.length === 1 ? '' : 's'} · {thread.at}</p>
        </div>
        <div className="mp-reader-act">
          <button type="button" className="btn" onClick={onClose}>Back</button>
          <a className="btn" href="#" onClick={(e) => e.preventDefault()}>
            <GmailMark size={13} /> Open in Gmail
          </a>
        </div>
      </div>

      {/*
        Why Divo is in this thread at all. Without it the page is just a worse
        Gmail; with it, it is the receipt for a decision made on the member's
        behalf, which is the only reason they clicked through.
      */}
      {thread.handledBy ? (
        <div className="mp-handled" data-tone={thread.handledBy.tone}>
          <span className="mp-handled-r">{thread.handledBy.rule}</span>
          <span>{thread.handledBy.outcome}</span>
        </div>
      ) : null}

      <Note n={1} title="No list in front of this">
        The only ways in are a row in Caught and a line in the brief. Divo does not compete with the
        Gmail tab already open next door, and the moment this grows a message list it starts
        promising search, archive and reply that will never exist.
      </Note>

      {earlier.length ? (
        <button type="button" className="mp-earlier" onClick={() => setExpanded((v) => !v)} data-open={expanded}>
          <ChevronDown size={14} />
          {expanded ? 'Hide' : 'Show'} {earlier.length} earlier message{earlier.length === 1 ? '' : 's'}
        </button>
      ) : null}

      {expanded ? earlier.map((m) => <MessageBlock key={m.id} m={m} />) : null}

      <MessageBlock m={latest} />

      {/*
        No reply box.
        Divo has no send capability on this path, and a composer that greys out
        when you press Send is worse than no composer — it advertises a feature
        and then blames you for reaching for it.
      */}
      <div className="mp-noreply">
        <Reply size={14} />
        <div>
          <b>Replying happens in Gmail</b>
          <p>Divo shows you this thread. It does not write or send on your behalf here, so there is no draft box to mislead you.</p>
        </div>
        <a className="btn" href="#" onClick={(e) => e.preventDefault()}>Reply in Gmail</a>
      </div>
    </div>
  )
}
