/**
 * The little that all four Mail Ops repositories share.
 *
 * Deliberately small. Each repository below declares the models it actually
 * touches rather than taking this union, so a delivery repository cannot reach
 * a subscription row by accident and a reader can see an aggregate's whole
 * surface from its constructor.
 */
import type { PrismaClient } from '../../../generated/prisma';

export type MailOpsDb = Pick<
  PrismaClient,
  | 'mailboxSubscription'
  | 'mailAutomationRule'
  | 'mailEvent'
  | 'mailDelivery'
  | '$transaction'
  | '$executeRaw'
>;

export const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 500);
