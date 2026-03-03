# Frontend Agent — Master Instructions

You are the **Frontend Agent** for building a production-grade AI chat application. Your job is to complete tasks 1 and 2 in order. Do not skip steps. Do not ask questions — all context you need is in this file and the task files.

---

## Stack

- **Framework**: Next.js 14 (App Router)
- **Package Manager**: pnpm
- **UI Components**: shadcn/ui — every single interactive component MUST come from shadcn. Do not build components from scratch if shadcn has them.
- **Styling**: Tailwind CSS (ships with shadcn)
- **Markdown**: `react-markdown` + `rehype-highlight` + `remark-gfm`
- **Icons**: `lucide-react`
- **Auth state**: React Context + JWT stored in `localStorage`
- **HTTP**: native `fetch` for REST, native `EventSource` for SSE streaming

---

## Step 0 — Reset the repo (do this FIRST)

```bash
# Inside the frontend repo root
git add -A
git stash
git checkout --orphan fresh-start
git rm -rf .
git stash drop 2>/dev/null || true
```

Then scaffold fresh:

```bash
pnpm create next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --no-git
pnpm dlx shadcn@latest init
```

When shadcn init asks style: choose **Default**. When it asks base color: choose **Zinc**.

Install all required shadcn components upfront:

```bash
pnpm dlx shadcn@latest add button input textarea label card dropdown-menu dialog sheet separator skeleton scroll-area tooltip avatar badge
```

Install additional deps:

```bash
pnpm add react-markdown rehype-highlight remark-gfm highlight.js lucide-react
```

---

## Design System

### Color Palette (neutral — works great in any ambient light)

Use these exact CSS variables in `globals.css`. This palette is NOT pure black/white — it uses warm neutrals that feel premium and are comfortable for both light and dark ambient environments.

```css
:root {
  /* Backgrounds */
  --bg-base: #0f0f0f;         /* main app background */
  --bg-surface: #1a1a1a;      /* sidebar, cards */
  --bg-elevated: #242424;     /* message bubbles, inputs */
  --bg-hover: #2e2e2e;        /* hover states */

  /* Borders */
  --border-subtle: #2a2a2a;
  --border-default: #333333;

  /* Text */
  --text-primary: #f0ede8;    /* warm white — easy on eyes */
  --text-secondary: #a8a49e;  /* muted labels */
  --text-tertiary: #6b6762;   /* placeholders, timestamps */

  /* Accent — Anthropic orange */
  --accent: #d97757;
  --accent-hover: #c4684a;
  --accent-subtle: rgba(217, 119, 87, 0.12);

  /* Status */
  --success: #6a9b6a;
  --error: #e05c5c;
}
```

Map these to Tailwind by adding a `tailwind.config.ts` extension:

```ts
extend: {
  colors: {
    base: 'var(--bg-base)',
    surface: 'var(--bg-surface)',
    elevated: 'var(--bg-elevated)',
    hover: 'var(--bg-hover)',
    accent: 'var(--accent)',
    'accent-hover': 'var(--accent-hover)',
    'accent-subtle': 'var(--accent-subtle)',
    primary: 'var(--text-primary)',
    secondary: 'var(--text-secondary)',
    tertiary: 'var(--text-tertiary)',
  }
}
```

Set `html` background to `--bg-base` so there's no flash.

### Typography

- Font: `Inter` from Google Fonts (already good, no install needed if using next/font)
- Body: 14px / 1.6 line-height
- Chat messages: 15px
- Code blocks: `JetBrains Mono` or `Fira Code` via next/font or CDN

### Spacing / Layout Rules (CRITICAL — this is where most chat apps fail)

- Sidebar width: `260px` expanded, `0px` collapsed (slide out, not icon mode)
- Chat area: fills remaining space after sidebar
- Message container: `max-width: 720px`, `margin: 0 auto`, `padding: 0 24px`
- User message: aligned right, max-width `80%`, bg `--bg-elevated`, rounded `12px`
- Assistant message: aligned left, no bubble bg (just text), full width within container
- Input area: fixed at bottom, same `max-width: 720px`, centered, floating above page bottom with `16px` padding

---

## API Contract

Backend runs at `http://localhost:8080`. All endpoints require `Authorization: Bearer <jwt>` except auth endpoints.

### Auth

```
POST /auth/register
Body: { first_name: string, last_name: string, email: string, password: string }
Response: { token: string, user: User }

POST /auth/login
Body: { email: string, password: string }
Response: { token: string, user: User }

GET /auth/me
Response: User
```

### Conversations

```
GET  /conversations
Response: Conversation[]

POST /conversations
Body: { title?: string, model: string, system_prompt?: string }
Response: Conversation

PATCH /conversations/:id/settings
Body: { model?: string, system_prompt?: string, temperature?: number }
Response: Conversation
```

### Messages + Streaming

```
GET /conversations/:id/messages
Response: Message[]

POST /conversations/:id/messages  (non-streaming, saves message to DB)
Body: { content: string }
Response: Message  (the user message saved)

GET /conversations/:id/stream?message=<encoded_content>
Response: SSE stream
  event types:
    { type: "token", data: "<chunk>" }
    { type: "done", data: "" }
    { type: "error", data: "<error_message>" }
```

### Models

```
GET /models
Response: { id: string, name: string }[]
```

### DTOs (TypeScript types — put in `@/types/index.ts`)

```ts
export interface User {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  created_at: string;
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  system_prompt: string | null;
  temperature: number;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface SSEEvent {
  type: 'token' | 'done' | 'error';
  data: string;
}

export interface Model {
  id: string;
  name: string;
}
```

---

## Environment Variables

Create `.env.local`:

```
NEXT_PUBLIC_API_URL=http://localhost:8080
```

---

## Folder Structure to follow

```
src/
  app/
    (auth)/
      login/page.tsx
      register/page.tsx
    (chat)/
      layout.tsx          ← sidebar + main shell
      page.tsx            ← new chat / empty state
      [id]/page.tsx       ← conversation view
    layout.tsx            ← root layout with fonts + providers
    globals.css
  components/
    layout/
      Sidebar.tsx
      TopBar.tsx
      AppShell.tsx
    chat/
      MessageList.tsx
      MessageBubble.tsx
      ChatInput.tsx
      StreamingMessage.tsx
      ThinkingLoader.tsx
      ToolExecutionCard.tsx   ← UI shell, not wired yet
    ui/                   ← shadcn components live here (auto-generated)
    shared/
      MarkdownRenderer.tsx
  context/
    AuthContext.tsx
    ChatContext.tsx
  hooks/
    useStream.ts
    useConversations.ts
    useMessages.ts
  lib/
    api.ts               ← all fetch wrappers
    auth.ts              ← token helpers
  types/
    index.ts
```

---

## Tasks to Complete (in order)

1. Read and complete **task1.md** fully before touching task2
2. Read and complete **task2.md**

Each task is self-contained with acceptance criteria. You are done when ALL criteria in both tasks pass visually and functionally.