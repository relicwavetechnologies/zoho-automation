import type { ChannelBranding } from '../../domain/channel/outbound';
import type { PermissionResult } from '../permissions/permission.types';

const DEPT_COLORS: Array<[RegExp, ChannelBranding['departmentColor']]> = [
  [/finance|books|accounting/i, 'green'],
  [/sales|crm/i,                'blue'],
  [/marketing|growth/i,         'purple'],
  [/engineering|tech|product/i, 'turquoise'],
  [/ops|operations|admin/i,     'orange'],
  [/hr|people/i,                'red'],
];

function pickColor(label: string): ChannelBranding['departmentColor'] {
  for (const [pattern, color] of DEPT_COLORS) {
    if (pattern.test(label)) return color;
  }
  return 'grey';
}

export function resolveBranding(perm: PermissionResult): ChannelBranding {
  const label = perm.department?.name ?? 'Divo';
  const color  = pickColor(label);
  return {
    departmentLabel: label,
    ...(color ? { departmentColor: color } : {}),
  };
}
