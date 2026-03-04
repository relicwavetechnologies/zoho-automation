import type { AdminSessionDTO } from '../../emiac/contracts';

export type AdminLoginResult = {
  token: string;
  session: AdminSessionDTO;
};
