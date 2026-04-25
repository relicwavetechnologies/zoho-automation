import 'dotenv/config';
import { hitlActionRepository } from '../src/company/state/hitl';

async function main() {
  const slim = await hitlActionRepository.getLatestPendingByChat('lark', 'ou_48b958c283635491b756c0ef23f47159');
  if (!slim) { console.log('NOT FOUND'); return; }

  const action = await hitlActionRepository.getHydratedByActionId(slim.actionId);
  if (!action) { console.log('NOT FOUND (hydrated)'); return; }

  // Print everything — payload and metadata raw
  console.log(JSON.stringify({
    actionId:    action.actionId,
    toolId:      action.toolId,
    actionGroup: action.actionGroup,
    status:      action.status,
    taskId:      action.taskId,
    channel:     action.channel,
    _channel:    action._channel,
    _chatId:     action._chatId,
    _payloadJson: action._payloadJson,
    _metadataJson: action._metadataJson,
    metadata:    action.metadata,
    payload:     action.payload,
  }, null, 2));
}

main().catch(console.error);
