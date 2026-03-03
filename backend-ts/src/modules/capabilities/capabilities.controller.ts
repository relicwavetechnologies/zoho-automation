import { Request, Response } from 'express';

import { resolvePolicy, capabilitiesForRole } from '../policy/policy.service';

export async function capabilityBootstrap(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const roleKey = req.roleKey!;

  const capabilities = await capabilitiesForRole({ organizationId, roleKey });
  return res.status(200).json(capabilities);
}

export async function policyCheck(req: Request, res: Response) {
  const organizationId = req.organizationId!;
  const roleKey = req.roleKey!;
  const tool_key = (req.body?.tool_key ?? '').trim();

  const policy = await resolvePolicy({ organizationId, roleKey, toolKey: tool_key });
  return res.status(200).json({
    allowed: policy.allowed,
    reason: policy.allowed ? 'allowed' : policy.reason,
    requires_approval: policy.requires_approval,
  });
}
