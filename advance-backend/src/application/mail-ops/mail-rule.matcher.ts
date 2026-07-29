import { z } from 'zod';
import type {
  MailMessageMetadata,
  MailRuleAction,
  MailRuleDestination,
  MailRuleMatch,
} from './mail-ops.types';

export const mailRuleMatchSchema = z.object({
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
  subjectContains: z.string().trim().min(1).optional(),
  bodyContains: z.string().trim().min(1).optional(),
  hasAttachment: z.boolean().optional(),
}).refine(value => Object.keys(value).length > 0, {
  message: 'At least one deterministic mail match is required.',
});

const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('forward') }),
  z.object({ type: z.literal('deliver') }),
]);

const DestinationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('email'), email: z.string().email() }),
  z.object({ type: z.literal('lark_chat'), chatId: z.string().trim().min(1) }),
]);

export function parseMailRule(input: {
  match: Record<string, unknown>;
  action: Record<string, unknown>;
  destination: Record<string, unknown>;
}): {
  match: MailRuleMatch;
  action: MailRuleAction;
  destination: MailRuleDestination;
} {
  const parsedMatch = mailRuleMatchSchema.parse(input.match);
  const match: MailRuleMatch = {
    ...(parsedMatch.from ? { from: parsedMatch.from } : {}),
    ...(parsedMatch.to ? { to: parsedMatch.to } : {}),
    ...(parsedMatch.subjectContains
      ? { subjectContains: parsedMatch.subjectContains }
      : {}),
    ...(parsedMatch.bodyContains
      ? { bodyContains: parsedMatch.bodyContains }
      : {}),
    ...(parsedMatch.hasAttachment !== undefined
      ? { hasAttachment: parsedMatch.hasAttachment }
      : {}),
  };
  const action = ActionSchema.parse(input.action);
  const destination = DestinationSchema.parse(input.destination);
  if (action.type === 'forward' && destination.type !== 'email') {
    throw new Error('Forward rules require an email destination.');
  }
  return { match, action, destination };
}

export function mailRuleMatches(
  match: MailRuleMatch,
  message: MailMessageMetadata,
): boolean {
  const includes = (actual: string, expected: string): boolean =>
    actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
  return (
    (!match.from || includes(message.from, match.from))
    && (!match.to || includes(message.to, match.to))
    && (!match.subjectContains || includes(message.subject, match.subjectContains))
    && (!match.bodyContains || includes(message.bodyText, match.bodyContains))
    && (
      match.hasAttachment === undefined
      || message.hasAttachment === match.hasAttachment
    )
  );
}
