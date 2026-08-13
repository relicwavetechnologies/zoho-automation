import assert from "node:assert/strict"
import test from "node:test"

import { hasUsableMailerConnection } from "./mailer-onboarding"

const MAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
]

test("returning members skip Mailer onboarding for their usable persisted Gmail connection", () => {
  assert.equal(hasUsableMailerConnection([{ ownerType: "user", access: "admin", scopes: MAIL_SCOPES }]), true)
})

test("Mailer onboarding is still required when the member has no usable personal Gmail connection", () => {
  assert.equal(hasUsableMailerConnection([]), false)
  assert.equal(hasUsableMailerConnection([{ ownerType: "company", access: "admin", scopes: MAIL_SCOPES }]), false)
  assert.equal(hasUsableMailerConnection([{ ownerType: "user", access: "admin", scopes: MAIL_SCOPES, reconnectRequired: true }]), false)
  assert.equal(hasUsableMailerConnection([{ ownerType: "user", access: "admin", scopes: [MAIL_SCOPES[0]!] }]), false)
})
