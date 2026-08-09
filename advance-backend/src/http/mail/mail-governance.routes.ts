import { Router, type Response } from 'express';
import { z } from 'zod';
import { mailRuleLeavesOrganisation } from '../../application/mail-ops/external-destination';
import {
  mailDestinationLeaves,
  type MailRuleDestination,
} from '../../application/mail-ops/mail-ops.types';
import type { CompanyMailForward } from '../../infrastructure/persistence/mail-ops-read.repository';
import type { Logger } from '../../shared/logger';

/**
 * Whose mail leaves the company, and where it goes.
 *
 * The one question about Mail Ops that nobody could ask. Each member sees their
 * own rules, and their own Mail page marks the ones pointing outside their
 * domain — but a forward is a **standing export** of whatever matches it, it is
 * created by asking Divo in a sentence, and until this there was no way to find
 * out how many exist across a company or where they point. Somebody changes
 * team, or leaves, and their rules keep forwarding to an address nobody has
 * looked at since the day it was approved.
 *
 * Read-only, deliberately. Stopping one of these is the owner's action or an
 * administrator's, taken with the rule in front of them and its history
 * visible; a bulk switch on an audit page is how you turn off the rule that was
 * carrying the invoices.
 *
 * Company-scoped from the session and never from the request, the same rule
 * every other read here follows.
 */
export interface MailGovernanceDeps {
  readRepo: {
    listEmailForwardsForCompany(input: {
      companyId: string;
      includeInactive?: boolean;
    }): Promise<
      | { ok: true; value: CompanyMailForward[] }
      | { ok: false; error: { message: string } }
    >;
  };
  logger: Logger;
}

const querySchema = z.object({
  includeInactive: z.enum(['true', 'false']).optional(),
  /**
   * Whether to answer with every email forward or only the ones leaving the
   * company. Default is `external`, because that is the question — the rest are
   * a colleague forwarding their own mail to their own team.
   */
  scope: z.enum(['external', 'all']).optional(),
});

export function createMailGovernanceRoutes(deps: MailGovernanceDeps): Router {
  const router = Router();
  const log = deps.logger.child({ route: 'mail-governance' });

  const companyOf = (res: Response): string => String(res.locals['companyId'] ?? '');

  router.get('/forwards', async (req, res) => {
    const parsed = querySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      res.status(400).json({ success: false, message: 'Invalid query.' });
      return;
    }
    const companyId = companyOf(res);
    if (!companyId) {
      res.status(401).json({ success: false, message: 'No company in session.' });
      return;
    }

    try {
      const rows = await deps.readRepo.listEmailForwardsForCompany({
        companyId,
        includeInactive: parsed.data.includeInactive === 'true',
      });
      if (!rows.ok) {
        res.status(500).json({ success: false, message: rows.error.message });
        return;
      }

      /*
       * "Leaves the company" is decided here, by the same function the writer
       * uses before asking a manager to approve one — not by a second rule
       * written in SQL against a JSON column. An owner whose address cannot be
       * read counts as external, which is the fail-closed direction: it shows
       * one rule too many rather than hiding one.
       */
      /*
       * One entry per recipient, not per rule.
       *
       * A routed rule sends to several people, so counting it once would report
       * a company with three external recipients as having one — and the
       * `totalForwards` denominator, which is the whole point of the number,
       * would be measuring rules while reading as though it measured
       * destinations. `mailDestinationLeaves` answers for both shapes and
       * includes the `otherwise` branch, which is where an unwatched address is
       * most likely to be sitting.
       */
      const forwards = rows.value.flatMap(row => {
        const leaves = mailDestinationLeaves(
          row.destination as unknown as MailRuleDestination,
        ).flatMap(leaf => leaf.type === 'email' ? [leaf.email] : []);
        // A destination Divo cannot read at all still has to appear. Dropping
        // it would hide a rule rather than flag one, which is the wrong
        // direction for a report somebody audits with.
        const addresses = leaves.length > 0 ? leaves : [''];
        return addresses.map(email => ({
          ...row,
          destinationEmail: email,
          external: email.length > 0 && mailRuleLeavesOrganisation({
            destinationEmail: email,
            requesterEmail: row.ownerEmail ?? undefined,
          }),
        }));
      });

      const shown = parsed.data.scope === 'all'
        ? forwards
        : forwards.filter(f => f.external);

      log.info('mail_governance.forwards_read', {
        companyId,
        total: forwards.length,
        external: forwards.filter(f => f.external).length,
      });

      res.json({
        success: true,
        data: {
          forwards: shown,
          // Both counts, always — so a page showing nothing can say whether
          // that is "no forwards at all" or "none of them leave", which are
          // very different answers to an auditor.
          totalForwards: forwards.length,
          externalCount: forwards.filter(f => f.external).length,
        },
      });
    } catch (error) {
      log.error('mail_governance.forwards_failed', {
        companyId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ success: false, message: 'Those rules could not be read.' });
    }
  });

  return router;
}
