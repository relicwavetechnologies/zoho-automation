/**
 * fix-duplicate-users — finds Users created by broken sync (no AuthLink,
 * no DeptMembership) and merges them into the original User that owns the
 * LarkUserAuthLink for the same openId.
 *
 * Safe: dry-run by default. Pass --apply to actually write.
 * Usage:
 *   pnpm tsx scripts/fix-duplicate-users.ts          # dry-run
 *   pnpm tsx scripts/fix-duplicate-users.ts --apply   # write changes
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/index.js';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

async function main() {
  console.log(`\nMode: ${apply ? '⚠️  APPLY (writing changes)' : '🔍  DRY RUN'}\n`);

  // Get all Lark ChannelIdentities with an email and openId
  const identities = await prisma.channelIdentity.findMany({
    where: { channel: 'lark', larkOpenId: { not: null }, email: { not: null } },
    select: { larkOpenId: true, email: true, displayName: true, companyId: true },
  });

  let fixed = 0;
  let skipped = 0;

  for (const ci of identities) {
    if (!ci.larkOpenId || !ci.email) continue;
    const larkEmail = ci.email.trim().toLowerCase();

    // Find the LarkUserAuthLink for this openId → the "real" userId
    const authLink = await prisma.larkUserAuthLink.findFirst({
      where: { larkOpenId: ci.larkOpenId },
      select: { userId: true },
    });
    if (!authLink) continue;

    const realUser = await prisma.user.findUnique({
      where: { id: authLink.userId },
      select: { id: true, email: true, name: true },
    });
    if (!realUser) continue;

    // If the real user already has the correct email, no merge needed
    if (realUser.email.trim().toLowerCase() === larkEmail) continue;

    // Check if an orphan user exists with the Lark email
    const orphanUser = await prisma.user.findUnique({
      where: { email: larkEmail },
      select: { id: true, email: true, name: true },
    });
    if (!orphanUser) {
      // No orphan — just need to update the real user's email
      console.log(`[UPDATE] Real user ${realUser.id} (${realUser.email}) → email ${larkEmail}`);
      if (apply) {
        await prisma.user.update({ where: { id: realUser.id }, data: { email: larkEmail } });
      }
      fixed++;
      continue;
    }

    // Orphan exists — check it's truly orphaned (no auth link, no dept membership)
    const orphanAuthLink = await prisma.larkUserAuthLink.findFirst({
      where: { userId: orphanUser.id },
      select: { id: true },
    });
    const orphanDeptMembership = await prisma.departmentMembership.findFirst({
      where: { userId: orphanUser.id },
      select: { id: true },
    });

    if (orphanAuthLink || orphanDeptMembership) {
      console.log(`[SKIP] Orphan ${orphanUser.id} (${orphanUser.email}) has auth link or dept membership — manual review needed`);
      skipped++;
      continue;
    }

    console.log(`[MERGE] Real: ${realUser.id} (${realUser.email}) ← Orphan: ${orphanUser.id} (${orphanUser.email})`);

    if (apply) {
      // Transfer orphan's AdminMembership to real user (if real user doesn't have one)
      const orphanAdminMemberships = await prisma.adminMembership.findMany({
        where: { userId: orphanUser.id },
        select: { id: true, companyId: true, role: true },
      });
      for (const am of orphanAdminMemberships) {
        const realHas = await prisma.adminMembership.findFirst({
          where: { userId: realUser.id, companyId: am.companyId },
        });
        if (!realHas) {
          // Transfer to real user
          await prisma.adminMembership.update({
            where: { id: am.id },
            data: { userId: realUser.id },
          });
          console.log(`  Transferred AdminMembership ${am.id} (${am.role}) to real user`);
        } else {
          // Delete duplicate
          await prisma.adminMembership.delete({ where: { id: am.id } });
          console.log(`  Deleted duplicate AdminMembership ${am.id} (real user already has one)`);
        }
      }

      // Delete orphan user
      await prisma.user.delete({ where: { id: orphanUser.id } });
      console.log(`  Deleted orphan user ${orphanUser.id}`);

      // Update real user's email to match Lark
      await prisma.user.update({
        where: { id: realUser.id },
        data: { email: larkEmail, ...(ci.displayName ? { name: ci.displayName } : {}) },
      });
      console.log(`  Updated real user email: ${realUser.email} → ${larkEmail}`);
    }

    fixed++;
  }

  console.log(`\n✅ ${fixed} users ${apply ? 'fixed' : 'would be fixed'}, ${skipped} skipped (need manual review)`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
