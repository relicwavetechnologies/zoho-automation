import { prisma } from '../../utils/prisma';

const SYSTEM_ROLES = [
  { key: 'owner', name: 'Owner' },
  { key: 'admin', name: 'Admin' },
  { key: 'manager', name: 'Manager' },
  { key: 'member', name: 'Member' },
  { key: 'viewer', name: 'Viewer' },
];

export async function seedSystemRoles() {
  for (const role of SYSTEM_ROLES) {
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
