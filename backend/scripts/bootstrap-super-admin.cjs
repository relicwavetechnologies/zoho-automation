const bcrypt = require('bcryptjs');
const { PrismaClient } = require('../src/generated/prisma');

const prisma = new PrismaClient();

const SUPER_ADMIN_EMAIL = 'rdx.omega2678@gmail.com';
const SUPER_ADMIN_PASSWORD = 'vAbhi2678';

async function main() {
  const existingUser = await prisma.user.findUnique({
    where: { email: SUPER_ADMIN_EMAIL },
  });

  const passwordHash = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 10);

  const user = existingUser
    ? await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          password: passwordHash,
          name: existingUser.name ?? 'Root Super Admin',
        },
      })
    : await prisma.user.create({
        data: {
          email: SUPER_ADMIN_EMAIL,
          password: passwordHash,
          name: 'Root Super Admin',
        },
      });

  const membership = await prisma.adminMembership.findFirst({
    where: {
      userId: user.id,
      role: 'SUPER_ADMIN',
      isActive: true,
    },
  });

  if (!membership) {
    await prisma.adminMembership.create({
      data: {
        userId: user.id,
        role: 'SUPER_ADMIN',
        isActive: true,
      },
    });
  }

  console.log('Super-admin bootstrap ensured for:', SUPER_ADMIN_EMAIL);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
