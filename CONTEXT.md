# Divo domain context

## Knowledge and skills

- **Knowledge mutation** is the durable, versioned proposal to create, update, publish, or delete one knowledge resource. It stores the exact canonical content, content hash, policy snapshot, requester, scope, and current state.
- **Skill review** is the requester-owned lifecycle for one correction-driven skill mutation. It opens the mutation, asks the requester through a Decision, hands shared authority to the approval module when required, applies the mutation, and reports projection truthfully.
- **Requester review** confirms that the complete replacement content is exactly what the requester meant. It is not authority to publish outside the requester's scope.
- **Authority decision** is the manager or administrator decision required by the mutation's policy. Department managers may confirm their own department skill mutations. Company skill mutations still require a distinct administrator.
- **Skill projection** turns an applied knowledge version into the active `Skill`, immutable `SkillVersion`, access grants, and registry revision used by Pi.
- **Applied** means the canonical knowledge mutation committed. It does not mean the skill projection is active.
- **Active skill revision** means projection completed and the next runtime bootstrap can carry the new revision.

## Human decisions

- **Decision** is the durable question shown by web and Lark adapters. It owns ask, delivery, actor checks, expiry, answer validation, and atomic answer settlement.
- A Decision does not own knowledge policy or tool execution. Producer modules settle their domain transitions through the linked Decision seam.
- A **linked Decision** is a requester-owned Decision that waits on a separate authority decision. The authority outcome returns to the producer that owns the domain transition.

## Runtime use

- Pi receives skills from the backend native-skill bootstrap. It never writes the mounted skill files.
- A changed bootstrap digest replaces the warm Pi process between turns. The new skill is therefore promised from the next turn, not the turn that approved it.
