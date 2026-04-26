import type { StatusHandle }  from '../../channels/channel.adapter';
import type { StatusUpdate }  from '../../../domain/channel/outbound';

export type { StatusHandle };

export interface StatusChannel {
  sendStatus(update: StatusUpdate): Promise<StatusHandle | null>;
  editStatus(handle: StatusHandle | null, update: StatusUpdate): Promise<StatusHandle | null>;
}
