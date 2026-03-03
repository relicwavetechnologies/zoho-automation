/* eslint-disable no-console */
require('dotenv').config();

const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'rdx.omega2678@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_FIRST_NAME = process.env.ADMIN_FIRST_NAME || 'Abhishek';
const ADMIN_LAST_NAME = process.env.ADMIN_LAST_NAME || 'Verma';
const ORG_NAME = process.env.ADMIN_ORG_NAME || 'Omega Workspace';

async function seedSystemRoles() {
  const roles = [
    { key: 'owner', name: 'Owner' },
    { key: 'admin', name: 'Admin' },
    { key: 'manager', name: 'Manager' },
    { key: 'member', name: 'Member' },
    { key: 'viewer', name: 'Viewer' },
  ];

  for (const role of roles) {
    const existing = await prisma.role.findFirst({
      where: { organization_id: null, key: role.key },
      select: { id: true },
    });

    if (existing) {
      await prisma.role.update({
        where: { id: existing.id },
        data: { name: role.name, is_system: true },
      });
      continue;
    }

    await prisma.role.create({
      data: {
        organization_id: null,
        key: role.key,
        name: role.name,
        is_system: true,
      },
    });
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('Missing DATABASE_URL');
  }

  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
    throw new Error('Set ADMIN_PASSWORD (min 8 chars) before running script');
  }

  console.info('Cleaning database...');

  await prisma.message.deleteMany({});
  await prisma.conversation.deleteMany({});
  await prisma.memberRole.deleteMany({});
  await prisma.roleToolPermission.deleteMany({});
  await prisma.organizationToolSetting.deleteMany({});
  await prisma.invite.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.organizationIntegration.deleteMany({});
  await prisma.membership.deleteMany({});
  await prisma.role.deleteMany({});
  await prisma.organization.deleteMany({});
  await prisma.user.deleteMany({});

  await seedSystemRoles();

  const password_hash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  const user = await prisma.user.create({
    data: {
      first_name: ADMIN_FIRST_NAME,
      last_name: ADMIN_LAST_NAME,
      email: ADMIN_EMAIL.toLowerCase(),
      password_hash,
      is_email_verified: true,
    },
  });

  const organization = await prisma.organization.create({
    data: { name: ORG_NAME },
  });

  const role = await prisma.role.findFirst({
    where: { organization_id: null, key: 'admin' },
  });

  if (!role) {
    throw new Error('System role admin missing after seed');
  }

  const membership = await prisma.membership.create({
    data: {
      user_id: user.id,
      organization_id: organization.id,
      role_key: 'admin',
      status: 'active',
    },
  });

  await prisma.memberRole.create({
    data: {
      membership_id: membership.id,
      role_id: role.id,
      status: 'active',
    },
  });

  await prisma.organizationToolSetting.createMany({
    data: [
      { organization_id: organization.id, tool_key: 'get_current_time', is_enabled: true },
      { organization_id: organization.id, tool_key: 'zoho.clients.read', is_enabled: true },
      { organization_id: organization.id, tool_key: 'zoho.invoices.read', is_enabled: true },
      { organization_id: organization.id, tool_key: 'zoho.invoice.write', is_enabled: true },
    ],
    skipDuplicates: true,
  });

  console.info('Seed complete');
  console.info(`Admin email: ${user.email}`);
  console.info(`Org: ${organization.name} (${organization.id})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
