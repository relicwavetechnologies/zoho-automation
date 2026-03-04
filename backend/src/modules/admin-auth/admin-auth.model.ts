import type { AdminSessionDTO } from '../../company/contracts';

export type AdminLoginResult = {
  token: string;
  session: AdminSessionDTO;
};
