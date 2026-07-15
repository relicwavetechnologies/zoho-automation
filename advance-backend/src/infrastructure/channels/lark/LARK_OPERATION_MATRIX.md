# Lark operation matrix

Divo owns connection selection, token encryption and refresh, grants, RBAC,
approval policy, and audit records. The Lark SDK is only the provider transport.
No desktop or Pi process receives an OAuth refresh token or Lark app secret.

| Divo capability | Lark API family | Token mode | Required Lark permissions (minimum) | SDK path |
| --- | --- | --- | --- | --- |
| `larkMessaging` (managed connection) | IM v1 messages, replies, reactions | User access token from resolved `IntegrationConnection` | `im:message`, `im:message.send_as_user`, `im:message:readonly`, user group/P2P history scopes, and `im:chat:read` | SDK `request` fallback until each existing operation is converted to the generated method |
| Bot replies, cards, webhook follow-up | IM v1 | Installed app tenant token | Bot/IM permissions configured for the company app | Generated `im.v1.message` for direct bot sends; SDK `request` for legacy adapter operations |
| `larkCalendar` | Calendar v4 | User access token | event create/read/update/delete, calendar read, and free/busy read matching action | SDK `request` fallback |
| `larkMeeting` | Video Conferencing v1 | User access token | `vc:meeting.search:read`, `vc:meeting.meetingevent:read`, `vc:record:readonly` | SDK `request` fallback; read-only search/detail/recording |
| `larkTask` | Task v2 | User access token | task read/write plus tasklist read/write matching action | SDK `request` fallback |
| `larkDoc`, files and Drive content | Docx / Drive v1 | User access token | docs/drive read or write matching action | Generated IM file download where supported; SDK `request` fallback otherwise |
| `larkBase` | Bitable v1 | User access token | `bitable:app` for current read/write record operations | SDK `request` fallback |
| `larkContacts` | Contact v3 | Installed app tenant token | tenant-approved contact permissions | SDK `request` fallback |
| `larkApproval` | Approval v4 | Installed app tenant token | approval instance/definition permissions | SDK `request` fallback |
| OAuth identity and token lifecycle | Authen / OAuth | OAuth user access token | Explicit Divo user scope set: identity, `contact:contact.base:readonly` (Contact API access), `contact:user.email:readonly`, `contact:user.employee:readonly` (for `enterprise_email`), Calendar, Contacts, Docx/Drive, Tasks, and `offline_access` (also enabled and published in the Lark app) | Generated `accessToken`, `authen.userInfo`, and `contact.v3.user` clients |
| Event verification and attachment download | IM v1 | Installed app tenant token | event subscription and IM resource permissions | Generated `im.v1.message` / `messageResource` clients |

`request` is the official SDK's documented low-level capability. It is used only
where the current operation has not yet been mapped to a generated SDK method;
custom `fetch` is prohibited in Lark runtime code. New Lark operations must
prefer generated semantic methods and add their endpoint, scope, token mode, and
Divo tool action to this matrix.

User-resource actions may execute only after Divo resolves a requested
`connectionId` through ownership or a grant. If no ID is supplied, Divo accepts
exactly one accessible Lark connection; otherwise it returns a structured
connection-selection result. Tenant-only capabilities are company-governed and
are never represented as a shareable personal account.
