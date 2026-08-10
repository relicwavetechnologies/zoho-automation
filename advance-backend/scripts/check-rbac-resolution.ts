/**
 * Read-only: resolve a user's live tool permissions exactly the way a turn
 * would, and print the decision with its provenance.
 *
 * This is the RBAC half of an end-to-end check, separated out so it can be run
 * before anything writes a row or sends a message. It builds the real
 * PermissionService against the real database and asks the same question the
 * gateway asks, so a surprise here is a real surprise — not a harness artifact.
 *
 *   tsx scripts/check-rbac-resolution.ts <email> [channel] [departmentSlug]
 */

import { PrismaClient } from '../src/generated/prisma';
import { ConsoleLogger } from '../src/shared/logger';
import { PermissionServiceImpl } from '../src/application/permissions/permission.service';
import { CompanyRoleRepository } from '../src/infrastructure/persistence/company-role.repository';
import { ToolPermissionRepository } from '../src/infrastructure/persistence/tool-permission.repository';
import { ToolActionPermissionRepository } from '../src/infrastructure/persistence/tool-action-permission.repository';
import { DepartmentRepository } from '../src/infrastructure/persistence/department.repository';
import { DeptToolPermissionRepository } from '../src/infrastructure/persistence/department-tool-permission.repository';
import { DeptUserOverrideRepository } from '../src/infrastructure/persistence/department-user-override.repository';
import type { CachePort } from '../src/shared/cache';
import { ok } from '../src/shared/result';
import type { CompanyRoleSlug } from '../src/domain/permissions/company-role';
import { asCompanyId, asUserId, asDepartmentId } from '../src/shared/ids';
import type { ChannelKey } from '../src/domain/channel/incoming-message';

/**
 * A cache that never hits. The point of this script is to read what the tables
 * currently say, so borrowing the running server's warm permission cache would
 * answer a question nobody asked.
 */
const coldCache: CachePort = {
  get: async () => ok(null),
  set: async () => ok(undefined),
  setNx: async () => ok(true),
  del: async () => ok(undefined),
  scanDel: async () => ok(0),
};

async function main(): Promise<void> {
  const email = process.argv[2];
  const channel = (process.argv[3] ?? 'lark') as ChannelKey;
  const wantedSlug = process.argv[4];
  if (!email) {
    console.error('usage: tsx scripts/check-rbac-resolution.ts <email> [channel] [departmentSlug]');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const logger = new ConsoleLogger({ script: 'check-rbac' });

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true },
    });
    if (!user) throw new Error(`no user with email ${email}`);

    const admin = await prisma.adminMembership.findFirst({
      where: { userId: user.id, isActive: true },
      select: { companyId: true, role: true },
    });
    if (!admin) throw new Error(`${email} has no active company membership`);
    // AdminMembership.companyId is nullable in the schema; a null one names no
    // tenant, so there is nothing to resolve against.
    const companyId = admin.companyId;
    if (!companyId) throw new Error(`${email}'s company membership has no companyId`);

    // The ceiling for a channel turn is ChannelIdentity.aiRole, not
    // AdminMembership.role. They usually agree; when they drift, the turn
    // follows the identity row, so that is what this has to read.
    const identity = await prisma.channelIdentity.findFirst({
      where: { companyId, channel, email },
      select: { aiRole: true, externalUserId: true, displayName: true },
    });
    const companyRole = (identity?.aiRole ?? admin.role) as CompanyRoleSlug;

    const memberships = await prisma.departmentMembership.findMany({
      where: { userId: user.id, status: 'active' },
      select: {
        department: { select: { id: true, name: true, slug: true, companyId: true } },
        role: { select: { slug: true, name: true } },
      },
    });

    const preference = await prisma.userDepartmentPreference.findUnique({
      where: { companyId_userId: { companyId, userId: user.id } },
      select: { activeDepartmentId: true },
    });

    // What a Lark turn would land on: the stored preference, else the single
    // membership. An explicit argument overrides both, for comparing two roles.
    const chosen = wantedSlug
      ? memberships.find(m => m.department.slug === wantedSlug)
      : memberships.find(m => m.department.id === preference?.activeDepartmentId)
        ?? (memberships.length === 1 ? memberships[0] : undefined);

    console.log(`user        : ${user.name} <${user.email}>  (${user.id})`);
    console.log(`channel     : ${channel}${identity ? `  identity ${identity.externalUserId}` : '  (no ChannelIdentity — falling back to AdminMembership)'}`);
    console.log(`company     : ${companyId}   company role: ${companyRole}${identity && identity.aiRole !== admin.role ? `  (AdminMembership says ${admin.role})` : ''}`);
    console.log(`memberships : ${memberships.map(m => `${m.department.slug}:${m.role.slug}`).join(', ') || '(none)'}`);
    console.log(`preference  : ${preference?.activeDepartmentId ?? '(none)'}`);
    if (!chosen) {
      console.log('\nNo department resolves — the turn would run on the company axis only.');
    } else {
      console.log(`resolves to : ${chosen.department.name} (${chosen.department.slug}) as ${chosen.role.slug}`);
    }

    const permissions = new PermissionServiceImpl({
      companyRoleRepo: new CompanyRoleRepository(prisma),
      toolPermRepo: new ToolPermissionRepository(prisma),
      toolActionRepo: new ToolActionPermissionRepository(prisma),
      deptRepo: new DepartmentRepository(prisma),
      deptToolPermRepo: new DeptToolPermissionRepository(prisma),
      deptUserOverrideRepo: new DeptUserOverrideRepository(prisma),
      cache: coldCache,
      logger,
      finalPermissionAliases: [{
        companyId: process.env['MENHOOD_COMPANY_ID'] ?? '',
        source: { toolId: 'airtableRecords', action: 'read' },
        target: { toolId: 'menhoodData', action: 'read' },
      }],
    });

    const resolved = await permissions.resolve({
      companyId: asCompanyId(companyId),
      userId: asUserId(user.id),
      companyRole,
      channel,
      ...(chosen ? { departmentId: asDepartmentId(chosen.department.id) } : {}),
    });

    if (!resolved.ok) {
      console.log(`\nRESOLVE FAILED: ${resolved.error.payload.reason} — ${resolved.error.message}`);
      return;
    }

    const bySource = new Map<string, string[]>();
    for (const d of resolved.value.decisions) {
      if (!d.allowed) continue;
      const list = bySource.get(d.source) ?? [];
      list.push(`${d.toolId}:${d.actionGroup}`);
      bySource.set(d.source, list);
    }

    console.log(`\n${resolved.value.allowedToolIds.size} tools allowed, ${resolved.value.decisions.filter(d => d.allowed).length} tool:action pairs\n`);
    for (const toolId of [...resolved.value.allowedToolIds].sort()) {
      const actions = [...(resolved.value.allowedActionsByTool.get(toolId) ?? [])].sort();
      console.log(`  ${String(toolId).padEnd(22)} ${actions.join(', ')}`);
    }

    console.log('\nby provenance:');
    for (const [source, entries] of [...bySource].sort()) {
      console.log(`  ${source.padEnd(26)} ${entries.length}`);
    }

    // Menhood access is derived from the Airtable read grant rather than a
    // separate department permission row.
    const hasMenhood = resolved.value.allowedActionsByTool
      .get('menhoodData' as never)?.has('read' as never) ?? false;
    console.log(`  ${hasMenhood ? 'OK  ' : 'MISS'} menhoodData:read (alias off airtableRecords:read)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
