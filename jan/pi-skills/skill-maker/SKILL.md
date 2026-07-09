---
name: skill-maker
description: Use when the user wants to create, save, update, or package a reusable local Divo/Pi skill from chat learning, repeated workflow instructions, domain knowledge, or tool usage patterns, and optionally share it to a department or company through backend skillPublishing.
---

# Skill Maker

Create private reusable skills locally first. Backend sharing is a separate explicit publish step controlled by the Divo gateway.

## Storage

Write private skills under the writable user skill directory:

1. Split `DIVO_SKILL_DIRS` by the platform path delimiter.
2. Prefer the entry ending in `skills/user`.
3. If no such entry exists, use `$DIVO_HOME/skills/user` when `DIVO_HOME` is set.
4. Otherwise use `~/.divo/skills/user`.

Create one directory per skill:

```text
<user-skill-dir>/<slug>/SKILL.md
```

Never write new private skills into `skills/company`, Jan bundled resources, backend seed files, or admin routes.

## Local Skill Workflow

1. Capture the reusable behavior from the current chat or user-provided notes.
2. Choose a lowercase hyphenated slug under 64 characters.
3. If the target skill already exists, read the current `SKILL.md` before editing it.
4. Write a complete `SKILL.md` with frontmatter:

```markdown
---
name: skill-slug
description: Use when ...
---
```

5. Keep the body concise and procedural. Include only durable workflow, constraints, examples, and tool contracts another agent needs.
6. Do not store secrets, access tokens, personal credentials, transient chat logs, or one-off scratch notes in the skill.
7. Validate before finishing:
   - `name` matches the folder slug.
   - `description` clearly says when to use the skill.
   - Markdown is complete enough for a fresh agent.
   - Any backend tool ids mentioned are canonical ids from `tools.list` or `capabilities.get`.

## Sharing Check

After creating or updating the local skill, check whether sharing is available before offering it:

```json
{
  "op": "tools.invoke",
  "departmentId": "active department id when present",
  "payload": {
    "toolId": "skillPublishing",
    "args": {
      "operation": "check_authority"
    }
  }
}
```

If the backend returns no allowed scope, tell the user the skill was saved locally and do not offer backend sharing.

If `canPublishCompany` or `canPublishDepartment` is true, ask one direct question about whether and where to share it. Do not publish from implication, role guesses, chat text, or local files.

## Publishing

Publish only after explicit user confirmation. Send the complete `SKILL.md` markdown:

```json
{
  "op": "tools.invoke",
  "departmentId": "required for department sharing when not already active",
  "payload": {
    "toolId": "skillPublishing",
    "args": {
      "operation": "publish",
      "scope": "company",
      "name": "Skill Name",
      "slug": "skill-slug",
      "summary": "Short summary under 1024 characters.",
      "markdown": "<complete SKILL.md>",
      "toolIds": ["canonicalBackendToolId"],
      "tags": ["optional", "short", "tags"]
    }
  }
}
```

For department sharing, use `"scope": "department"` and include the resolved `departmentId` when needed.

`toolIds` must contain real backend tool ids. Use `tools.list` or `capabilities.get` if the ids are uncertain. Do not publish a purely local skill with fake tool ids; keep it local until the backend supports that shape.

## Failure Rules

- `permission_denied`: keep the skill local and explain that backend sharing is not allowed for this user or scope.
- `approval_required`: tell the user approval is pending. Retry only the exact same publish call after approval.
- `approval_rejected`: do not retry the same publish payload. Ask what should change.
- `invalid_args` or `bad_request`: inspect the schema, markdown size, summary length, scope, department id, and canonical `toolIds` before retrying.
- Unknown tool ids: call `tools.list` or `capabilities.get`, then correct the publish payload.
