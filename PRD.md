# Product Requirements Document

## Title
Multi-Department Agent Support on the Vercel AI SDK Path

## Status
Draft

## Owner
Internal Product / Engineering

## Date
2026-03-17

## 1. Overview

We need to extend the current company-level agent system into a department-aware system so one company can operate multiple specialized agents inside the same workspace. Each department should have its own agent behavior, prompt, skills, people, roles, and tool permissions, while still using the existing Vercel AI SDK pathway.

This work must ignore the Mastra and LangGraph pathways. The implementation target is the current Vercel desktop/runtime path and the current admin dashboard stack.

The goal is to let a company admin create departments such as Finance, HR, Sales, Operations, Support, and Legal, then delegate control of those departments to managers. Each department can configure its own agent instructions and tool access model. Users then chat with the department-specific agent using the configuration and permissions that apply to them in that department.

This is not a new orchestration system. It is a scoped extension of the current system.

## 2. Problem Statement

Today the system is mostly company-scoped:

- tool permissions are resolved at the company + role level
- AI roles are company-scoped
- users can have tool access based on their company role
- the Vercel runtime builds a dynamic tool registry per request

This is not sufficient for organizations where multiple departments need materially different agents.

Examples:

- Finance needs accounting workflows, spreadsheet-related tools, internal report guidance, and stricter access
- HR needs policy skills, people workflows, and different access boundaries
- Sales needs CRM and outreach-related tool access
- Support needs customer-facing workflows and troubleshooting skills

Without department support, there is no clean way to separate:

- department-specific system prompts
- department-specific `skills.md`
- department-specific tool permissions
- department-specific role models
- department-specific managers and members

## 3. Goals

- Allow company admins to create and manage departments
- Allow company admins to assign department managers
- Allow each department to define its own system prompt
- Allow each department to define its own `skills.md` content
- Allow each department to define its own role model
- Provide default department roles: `MANAGER` and `MEMBER`
- Allow managers to create custom department roles
- Allow managers to grant tool access by department role
- Allow per-user tool access overrides inside a department
- Allow users to log in, select a department they belong to, and chat with that department’s agent
- Ensure the Vercel agent uses the selected department’s system prompt and skills
- Ensure tools are dynamically exposed based on department and user access
- Keep the implementation aligned with the current Vercel AI SDK architecture

## 4. Non-Goals

- Rebuilding the orchestration system
- Supporting Mastra or LangGraph in this phase
- Making department a new core vector scope in Qdrant
- Letting managers create arbitrary new code-level tools in phase 1
- Replacing the global tool registry
- Implementing a separate department-specific knowledge base model in the first release

## 5. Current System Context

The proposed design must fit the current codebase.

### Existing strengths

- The Vercel runtime already supports dynamic tool registration per request
- The backend already computes `allowedToolIds` from company and role
- The admin UI already supports company-level tool permission management
- The admin UI already supports custom AI roles at the company level
- The desktop/Vercel runtime already resolves user/company/session context before model execution

### Important current limitation

The Vercel path computes `allowedToolIds`, but the current Vercel tool registry is not yet hard-filtered by that list. In other words, company-level RBAC exists conceptually, but tool exposure in the Vercel runtime is not fully enforced yet. This must be fixed as part of this initiative, because department-level access control will depend on correct runtime filtering.

### Existing code areas relevant to this work

- `backend/src/company/tools/tool-permission.service.ts`
- `backend/src/company/tools/tool-registry.ts`
- `backend/src/company/tools/ai-role.service.ts`
- `backend/src/modules/member-auth/member-auth.service.ts`
- `backend/src/modules/desktop-chat/vercel-desktop.engine.ts`
- `backend/src/company/orchestration/vercel/tools.ts`
- `admin/src/pages/ToolPermissionsPage.tsx`
- `admin/src/pages/MembersPage.tsx`

## 6. Product Vision

Each company can operate multiple department agents inside one workspace.

Each department agent has:

- its own system prompt
- its own `skills.md`
- its own members
- its own managers
- its own roles
- its own allowed tools

Each user interacts only with the department agent they have access to, and that agent behaves according to the department configuration plus the user’s effective permissions.

This gives one company multiple specialized AI workers while keeping one shared platform.

## 7. User Roles

### Company Admin

Responsibilities:

- create departments
- archive departments
- assign managers to departments
- view department settings and membership
- optionally intervene in department permissions

### Department Manager

Responsibilities:

- edit department system prompt
- edit department `skills.md`
- create custom department roles
- assign members to roles
- manage tool permissions for roles in that department
- manage per-user tool overrides in that department

The term `manager` should be used in product language instead of `department admin`, because it is more intuitive.

### Department Member

Responsibilities:

- use the department agent
- use only the tools they are allowed to use
- access only the department experiences and capabilities assigned to them

## 8. Core User Stories

### Company Admin

- As a company admin, I can create a department from the admin dashboard
- As a company admin, I can assign one or more managers to a department
- As a company admin, I can see which users belong to which departments
- As a company admin, I can inspect a department’s prompt, skills, and role model

### Department Manager

- As a manager, I can define the department’s system prompt
- As a manager, I can paste and edit the department’s `skills.md`
- As a manager, I can configure which tools the department can use
- As a manager, I can create new custom roles beyond `MANAGER` and `MEMBER`
- As a manager, I can assign users to roles inside the department
- As a manager, I can set tool access by role
- As a manager, I can set specific user-level tool overrides

### End User

- As a user, I can log in and see the departments I belong to
- As a user, I can choose a department and chat with its agent
- As a user, I get the prompt, skills, and tools that apply to my department and role
- As a user, I cannot use tools that my role does not allow

## 9. Scope of the First Release

Phase 1 must support:

- department creation and management
- manager assignment
- department system prompt
- department `skills.md`
- department membership
- department roles
- department role-based tool permissions
- per-user overrides inside a department
- department selection in the chat flow
- Vercel runtime integration with department-aware prompt and tool filtering

Phase 1 should not include:

- department as a Qdrant vector scope
- a department-specific vector index layer
- manager-created arbitrary new executable tools
- thread migration between departments

## 10. Information Architecture

### Company

Top-level workspace boundary.

### Department

A specialized sub-organization within a company. Examples:

- Finance
- HR
- Sales
- Operations

### Department Agent Configuration

Defines how the department agent behaves.

Fields:

- `systemPrompt`
- `skillsMarkdown`
- optional display metadata
- status

### Department Role

A department-scoped role such as:

- `MANAGER`
- `MEMBER`
- `ANALYST`
- `REVIEWER`
- `APPROVER`

### Department Membership

Links a user to a department and a role within that department.

### Department Tool Permission

Maps a department role to allowed tools for that department.

### Department User Tool Override

Allows exceptions for a specific user within a department.

## 11. Proposed Data Model

This should be implemented as department-scoped entities, not by overloading the existing company-scoped role tables immediately.

### Department

- `id`
- `companyId`
- `name`
- `slug`
- `description`
- `status`
- `createdAt`
- `updatedAt`

### DepartmentAgentConfig

- `id`
- `departmentId`
- `systemPrompt`
- `skillsMarkdown`
- `isActive`
- `createdBy`
- `updatedBy`
- `createdAt`
- `updatedAt`

### DepartmentRole

- `id`
- `departmentId`
- `name`
- `slug`
- `isSystem`
- `isDefault`
- `createdAt`
- `updatedAt`

System defaults:

- `MANAGER`
- `MEMBER`

### DepartmentMembership

- `id`
- `departmentId`
- `userId`
- `roleId`
- `status`
- `createdAt`
- `updatedAt`

### DepartmentToolPermission

- `id`
- `departmentId`
- `roleId`
- `toolId`
- `allowed`
- `updatedBy`
- `updatedAt`

### DepartmentUserToolOverride

- `id`
- `departmentId`
- `userId`
- `toolId`
- `allowed`
- `updatedBy`
- `updatedAt`

## 12. Permission Model

### Guiding principle

Department should be an application-layer scope, not a new vector-layer scope in phase 1.

This keeps retrieval and permission logic manageable. Company and personal vector scopes stay as they are. Department is enforced before runtime execution, not inside Qdrant filtering.

### Effective permission resolution

Tool access should be resolved in this order:

1. authenticated company user
2. selected department
3. department membership
4. department role permissions
5. per-user tool overrides in that department

This means the same user can have different permissions in different departments.

Example:

- user is `MEMBER` in the company
- user is `MANAGER` in Finance
- user is `ANALYST` in Sales

The active department determines which permissions apply.

### Default policy

- `MANAGER` gets all department-available tools by default
- `MEMBER` gets only `webSearch` by default
- company admin can intervene if needed

## 13. Tool Model

The global tool registry should remain centralized.

We should not create separate code-level tool registries per department. Instead:

- keep one master registry
- compute allowed tools for the current department and user
- expose only that filtered subset to the Vercel runtime

This fits the current architecture better and keeps tool management maintainable.

### Important implementation rule

The Vercel path must be changed from “compute `allowedToolIds` but still expose all tools” to “compute `allowedToolIds` and expose only those tools”.

This is mandatory for department support.

## 14. Prompt Model

The final prompt for a department chat should be composed from:

1. global system/base instruction layer
2. department system prompt
3. department `skills.md`
4. optional user/session context

This keeps company safety/infrastructure rules separate from department specialization.

### Why store `skills.md` in the database

For this feature, `skills.md` should be stored as editable department configuration, not as a filesystem dependency.

Reasons:

- managers need to edit it in the dashboard
- it must be versionable through the app
- it should be easy to load at runtime
- it avoids unnecessary file-management complexity

## 15. Skill Search Requirement

Department configuration should not depend forever on one giant static `skills.md` dump.

We should introduce a department-scoped skill search capability as part of this design direction.

### Goal

The agent should be able to search among the skills visible to the selected department and retrieve the most relevant procedural guidance.

### Recommended phase 1.5 behavior

- keep `core skills` in `skillsMarkdown`
- also support a department skill library in the database
- add a `skillSearch` tool to the Vercel registry
- ensure `skillSearch` only sees skills available to that department

### Important complexity decision

Do not add department as a new core vector scope in phase 1.

Instead:

- enforce department visibility in SQL/app logic first
- search within already-approved department skill records
- if the skill library stays small, use DB search first
- only add vector retrieval for skills later if scale justifies it

This keeps the vector model simple:

- personal scope stays personal
- company scope stays company
- department remains an application-layer concept

## 16. Chat and Thread Behavior

### Department selection

Before starting a chat, the user should select one of the departments they belong to.

### Thread scoping

Each chat thread must be pinned to one department.

Reason:

- prompt context must remain stable
- tool permissions must remain stable
- manager-defined skills must remain stable
- follow-up turns should not accidentally change departments

### Mid-thread switching

Not supported in phase 1.

If the user wants a different department, they should start a new thread in that department.

## 17. Dashboard Requirements

### Company Admin Dashboard

New capabilities:

- department list
- create department
- archive department
- assign managers
- inspect department settings
- inspect department members

### Department Manager Dashboard

New capabilities:

- edit department profile
- edit department system prompt
- edit department `skills.md`
- manage roles
- manage member assignments
- manage tool permissions by role
- manage user-specific overrides

### Existing UI that can be reused

- `ToolPermissionsPage.tsx` for permission matrix patterns
- `MembersPage.tsx` for membership/invite patterns

## 18. Backend Service Requirements

New service layer should likely include:

- `department.service`
- `department-agent-config.service`
- `department-role.service`
- `department-membership.service`
- `department-tool-permission.service`
- `department-user-tool-override.service`

### Runtime resolution service

We should also introduce a department runtime resolver responsible for:

- validating selected department
- validating the user belongs to it
- loading agent config
- loading department role
- computing effective allowed tools

This should happen before calling the Vercel model.

## 19. Vercel Runtime Integration

This feature must integrate directly into the current Vercel runtime.

### Request flow

1. user authenticates
2. user selects department
3. frontend sends `departmentId`
4. backend resolves department membership and role
5. backend loads department prompt and skills
6. backend computes effective allowed tools
7. backend filters the Vercel tool registry to that allowed set
8. backend calls the Vercel model with department-aware system prompt

### Required runtime fields

The Vercel runtime context should be extended with:

- `departmentId`
- `departmentRoleSlug`
- possibly `departmentName`
- effective `allowedToolIds`

### Key implementation note

`createVercelDesktopTools(...)` should accept the resolved allowed tool list and return only the allowed tool map.

## 20. Search and Knowledge Behavior

Department support should not change the core vector strategy immediately.

### Recommended behavior

- personal memory remains personal
- company knowledge remains company-scoped
- department prompt and skill selection happen in application logic

### Why this is the right tradeoff now

Adding department as a third vector scope now would complicate:

- retrieval
- indexing
- payload filtering
- migration
- RBAC maintenance

This is not necessary for the first multi-department release.

## 21. API Requirements

Likely new backend APIs:

- create department
- update department
- list departments for company admin
- list departments for current user
- assign managers
- create department role
- update department role
- delete department role
- assign department membership
- update department membership
- update department prompt
- update department `skills.md`
- update department tool permissions
- update per-user tool overrides

Likely frontend additions:

- department list page
- create/edit department forms
- department settings page
- department roles page
- department members page
- department tool permissions page
- department selector in chat

## 22. Acceptance Criteria

### Department management

- company admin can create a department
- company admin can assign one or more managers
- company admin can archive a department

### Department configuration

- manager can edit system prompt
- manager can edit `skills.md`
- manager can create custom roles

### Department permissions

- manager can configure tools by role
- manager can override tools for a specific user
- a user cannot use a tool not allowed for their department role

### Chat behavior

- user can only access departments they belong to
- user can start a chat in an allowed department
- department prompt and skills are used in that chat
- tool registry is filtered to the user’s effective department permissions
- thread remains pinned to one department

## 23. Rollout Plan

### Phase 1

- schema additions
- backend department services
- basic admin UI for department creation and manager assignment
- basic manager UI for prompt, skills, roles, and permissions
- Vercel runtime department resolution
- Vercel tool filtering enforcement

### Phase 2

- improved manager dashboards
- analytics and audit logs
- richer role templates
- better skill library management

### Phase 3

- department `skillSearch`
- optional department knowledge sources
- optional more advanced approval or policy flows

## 24. Risks

### Risk 1: Permission model becomes messy

If department logic is mixed directly into existing company role logic too early, the access model will become hard to reason about.

Mitigation:

- keep department entities separate
- resolve effective permissions explicitly

### Risk 2: Vercel runtime remains weakly enforced

If we keep the current Vercel behavior where `allowedToolIds` is computed but not enforced, department RBAC will fail in practice.

Mitigation:

- hard-filter tools at registry creation time
- optionally add tool-level guards for defense in depth

### Risk 3: Department prompt bloat

If one giant `skills.md` is always stuffed into every request, prompt quality will degrade over time.

Mitigation:

- keep a small core prompt
- add skill retrieval later through `skillSearch`

### Risk 4: Overengineering vector scope

Adding department as a new vector scope now would increase complexity without enough immediate product value.

Mitigation:

- keep vector model at personal/company scope for now
- enforce department boundaries in app logic

## 25. Open Questions

- Can a user belong to multiple departments at once
- Can a user have different roles in different departments
- Should managers be able to enable only existing tools, or define new configurable tool instances
- Should department chats share one department-wide inbox or remain fully user-thread scoped
- Should company admins be able to impersonate/view department manager configuration screens
- Should department prompts support version history and rollback in phase 1 or later

Recommended answers:

- yes, users can belong to multiple departments
- yes, users can have different roles in different departments
- managers should enable existing tools first, not create arbitrary new code tools
- department chats should remain user-thread scoped
- company admins should have read/write override access
- version history can come after phase 1

## 26. Recommended Implementation Approach

Build department support as a scoped policy and configuration layer on top of the current Vercel architecture.

Specifically:

- keep the current global tool registry
- add department entities and manager workflows
- resolve department membership and role before every chat run
- compose department-specific prompt and skills into the Vercel system prompt
- filter tools to the effective department/user allowed set
- keep vector scope simple for now

This is the fastest path that matches the current codebase and avoids unnecessary architecture churn.

## 27. Success Metrics

- departments created per company
- percentage of active companies using at least one department
- percentage of chats started within a department
- number of managers actively configuring prompts/skills/tools
- reduction in cross-team prompt/tool conflicts
- rate of blocked disallowed-tool calls in the Vercel runtime after enforcement is added

## 28. Final Recommendation

Proceed with multi-department support on the Vercel AI SDK pathway by introducing department-scoped configuration, roles, membership, and tool permissions, while keeping vector retrieval scope at company and personal only for now.

The most important technical requirement is to make the Vercel runtime actually enforce allowed tool exposure. Without that change, department-level access control will not be trustworthy.
