import type { StatusHandle } from '../../channels/channel.adapter';

export type { StatusHandle };

export interface StatusChannel {
  sendStatus(text: string): Promise<StatusHandle | null>;
  editStatus(handle: StatusHandle | null, text: string): Promise<StatusHandle | null>;
}
