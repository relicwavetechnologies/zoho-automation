import type { HTMLAttributes } from 'react';

import { cn } from '../../lib/cn';

type AlertTone = 'error' | 'success' | 'info';

export const Alert = ({
  className,
  children,
  tone = 'info',
  ...props
}: HTMLAttributes<HTMLDivElement> & { tone?: AlertTone }) => (
  <div
    className={cn(
      'ui-alert',
      tone === 'error' && 'ui-alert--error',
      tone === 'success' && 'ui-alert--success',
      tone === 'info' && 'ui-alert--info',
      className,
    )}
    {...props}
  >
    {children}
  </div>
);
