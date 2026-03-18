const { PrismaClient } = require('../src/generated/prisma');

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const readArg = (name) => {
  const prefix = `--${name}=`;
  const direct = args.find((arg) => arg.startsWith(prefix));
  if (direct) {
    return direct.slice(prefix.length).trim();
  }
  const index = args.indexOf(`--${name}`);
  if (index >= 0) {
    return (args[index + 1] || '').trim();
  }
  return '';
};

const companyId = readArg('companyId');
const userId = readArg('userId');
const email = readArg('email').toLowerCase();

if (!companyId || (!userId && !email)) {
  console.error('Usage: node backend/scripts/revoke-google-user-link.cjs --companyId <uuid> (--userId <uuid> | --email <email>)');
  process.exit(1);
}

(async () => {
  let resolvedUserId = userId;
  if (!resolvedUserId && email) {
    const user = await prisma.user.findFirst({
      where: {
        email: {
          equals: email,
          mode: 'insensitive',
        },
      },
      select: { id: true, email: true },
    });
    if (!user) {
      throw new Error(`No user found for email ${email}`);
    }
    resolvedUserId = user.id;
  }

  const result = await prisma.googleUserAuthLink.updateMany({
    where: {
      companyId,
      userId: resolvedUserId,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });

  console.log(JSON.stringify({
    companyId,
    userId: resolvedUserId,
    revokedCount: result.count,
  }, null, 2));
})()
  .catch(async (error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
