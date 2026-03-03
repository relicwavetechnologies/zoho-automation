import { prisma } from '../src/utils/prisma';

async function main() {
  const users = await prisma.user.findMany();

  for (const user of users) {
    const hasMembership = await prisma.membership.findFirst({
      where: { user_id: user.id },
    });

    if (hasMembership) continue;

    const created = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: `${user.first_name} ${user.last_name}`.trim() || user.email,
        },
      });

      const membership = await tx.membership.create({
        data: {
          user_id: user.id,
          organization_id: org.id,
          role_key: 'owner',
          status: 'active',
        },
      });

      return { org, membership };
    });

    // eslint-disable-next-line no-console
    console.log(
      `Backfilled user ${user.email} -> org ${created.org.id}, membership ${created.membership.id}`,
    );
  }
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
