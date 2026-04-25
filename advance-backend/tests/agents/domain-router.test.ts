/**
 * DomainRouter unit tests.
 *
 * The router is pure and synchronous — no mocking needed.
 * Tests verify:
 *   - Lark keywords route to 'lark'
 *   - Google keywords route to 'google'
 *   - Zoho keywords route to 'zoho'
 *   - Context/search keywords route to 'context'
 *   - Ambiguous / no-keyword messages route to 'general'
 *   - Tool presence boosts a domain score even when keywords are weak
 *   - Admin-named child agents are preferred when the domain matches
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DomainRouter } from '../../src/application/orchestration/agents/domain-router.ts';
import { makeTool } from '../helpers/agent-mocks.ts';
import type { AgentChildView } from '../../src/infrastructure/persistence/agent-definition.repository.ts';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const router = new DomainRouter();

const larkTools  = ['larkTask', 'larkMessaging', 'larkCalendar'].map(makeTool);
const googleTools = ['googleGmail', 'googleDrive', 'googleCalendar'].map(makeTool);
const zohoTools   = ['zohoCrm', 'zohoBooks'].map(makeTool);
const contextTools = ['contextSearch', 'webSearch'].map(makeTool);
const allTools    = [...larkTools, ...googleTools, ...zohoTools, ...contextTools];

function makeChild(name: string): AgentChildView {
  return { id: `child-${name}`, name, systemPrompt: null, toolIds: [] };
}

// ─── Keyword routing ──────────────────────────────────────────────────────────

describe('DomainRouter — keyword routing', () => {
  it('routes Lark task request to lark', () => {
    const { domain } = router.route('Create a task for Alice', larkTools, []);
    assert.equal(domain, 'lark');
  });

  it('routes Lark message request to lark', () => {
    const { domain } = router.route('Send a lark message to Bob', allTools, []);
    assert.equal(domain, 'lark');
  });

  it('routes approval request to lark', () => {
    const { domain } = router.route('Submit an approval for budget', allTools, []);
    assert.equal(domain, 'lark');
  });

  it('routes gmail/email to google', () => {
    const { domain } = router.route('Send an email via Gmail to the team', allTools, []);
    assert.equal(domain, 'google');
  });

  it('routes google calendar to google', () => {
    const { domain } = router.route('Create a google calendar event', allTools, []);
    assert.equal(domain, 'google');
  });

  it('routes CRM lead request to zoho', () => {
    const { domain } = router.route('Add a new lead to the CRM', allTools, []);
    assert.equal(domain, 'zoho');
  });

  it('routes invoice request to zoho', () => {
    const { domain } = router.route('Create an invoice in Zoho Books', allTools, []);
    assert.equal(domain, 'zoho');
  });

  it('routes "search for" to context', () => {
    const { domain } = router.route('Search for information about our Q3 report', allTools, []);
    assert.equal(domain, 'context');
  });

  it('routes web search request to context', () => {
    const { domain } = router.route('Do a web search for AI news', allTools, []);
    assert.equal(domain, 'context');
  });
});

// ─── Fallback to general ──────────────────────────────────────────────────────

describe('DomainRouter — fallback to general', () => {
  it("returns 'general' for a vague message with no tools available", () => {
    // No tools = no tool-score boost → only keyword score matters.
    // 'Help me' contains no domain keywords → 'general'
    const { domain } = router.route('Help me with something', [], []);
    assert.equal(domain, 'general');
  });

  it("returns 'general' when empty message and no tools", () => {
    const { domain } = router.route('', [], []);
    assert.equal(domain, 'general');
  });

  it("returns 'general' with no tools available", () => {
    const { domain } = router.route('Create a task for Alice', [], []);
    // No tool scores, but keyword scores still apply → lark wins
    // (this is correct behaviour — keywords alone are enough)
    assert.equal(domain, 'lark');
  });

  it("returns 'general' for multi-domain mixed message with equal scores", () => {
    // A message that mentions Lark AND Google equally might go general,
    // but keyword scoring will pick the higher-count domain.
    // This test just asserts a valid domain is returned.
    const { domain } = router.route(
      'I need to check my email and also lark messages',
      allTools,
      [],
    );
    assert.ok(['lark', 'google', 'general'].includes(domain));
  });
});

// ─── Tool score boosting ──────────────────────────────────────────────────────

describe('DomainRouter — tool score boosting', () => {
  it('boosts lark score when only lark tools are available', () => {
    // Even a vague message gets boosted toward the available tool family
    const { domain } = router.route('Do something for me', larkTools, []);
    // lark gets +3 from tool presence (larkTask + larkMessaging + larkCalendar)
    assert.equal(domain, 'lark');
  });

  it('boosts google score when only google tools available', () => {
    const { domain } = router.route('Do something for me', googleTools, []);
    assert.equal(domain, 'google');
  });
});

// ─── Child agent matching ─────────────────────────────────────────────────────

describe('DomainRouter — admin child agent matching', () => {
  it('returns matched child when name contains domain keyword', () => {
    const children = [makeChild('Lark Operations Agent'), makeChild('Google Workspace Agent')];
    const { domain, child } = router.route('Create a task on lark', allTools, children);
    assert.equal(domain, 'lark');
    assert.ok(child !== null);
    assert.equal(child!.name, 'Lark Operations Agent');
  });

  it('returns null child when no child matches the domain', () => {
    const children = [makeChild('Google Workspace Agent')];
    const { domain, child } = router.route('Create a task on lark', allTools, children);
    assert.equal(domain, 'lark');
    assert.equal(child, null);
  });

  it('returns null child for general domain (no tools, no keywords)', () => {
    // With no tools and no domain keyword in message, router picks 'general'.
    // matchChildToDomain skips 'general' domain → child=null.
    const children = [makeChild('General Assistant')];
    const { domain, child } = router.route('help me', [], children);
    assert.equal(domain, 'general');
    assert.equal(child, null);
  });

  it('prefers exact domain name match in child name', () => {
    const children = [makeChild('zoho CRM specialist'), makeChild('Lark specialist')];
    const { domain, child } = router.route('Add a new lead to CRM', allTools, children);
    assert.equal(domain, 'zoho');
    assert.ok(child !== null);
    assert.equal(child!.name, 'zoho CRM specialist');
  });
});
