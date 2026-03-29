import type { DesktopTaskState } from '../../../modules/desktop-chat/desktop-thread-memory';
import { hotContextStore, type HotContextIndexedEntity } from '../hot-context.store';

const buildReferenceSuffix = (entity: HotContextIndexedEntity): string => {
  const parts = [`recordId=${entity.recordId}`];
  if (entity.label?.trim()) {
    parts.push(`label=${entity.label.trim()}`);
  }
  if (entity.reference?.trim()) {
    parts.push(`reference=${entity.reference.trim()}`);
  }
  return parts.join(', ');
};

const getPreferredEntityIndex = (
  taskId: string,
  taskState?: Pick<DesktopTaskState, 'activeModule' | 'workingSets' | 'currentEntity'>,
): HotContextIndexedEntity[] => {
  const invoiceEntries = hotContextStore.getLatestEntityIndex(taskId, 'invoice');
  if (invoiceEntries.length > 0) {
    return invoiceEntries;
  }
  const taskEntries = hotContextStore.getLatestEntityIndex(taskId, 'task');
  if (taskEntries.length > 0) {
    return taskEntries;
  }
  const recordEntries = hotContextStore.getLatestEntityIndex(taskId, 'record');
  if (recordEntries.length > 0) {
    return recordEntries;
  }
  const workingSet = taskState?.activeModule ? taskState.workingSets[taskState.activeModule] : undefined;
  if (!workingSet || workingSet.recordIds.length === 0) {
    return [];
  }
  return workingSet.recordIds.map((recordId, index) => ({
    ordinal: index + 1,
    recordId,
    label: workingSet.labelsByRecordId[recordId],
    reference: `${workingSet.module}:${recordId}`,
  }));
};

export const resolveOrdinalReferences = (
  userMessage: string,
  taskId: string,
  taskState?: Pick<DesktopTaskState, 'activeModule' | 'workingSets' | 'currentEntity'>,
): string => {
  const trimmed = userMessage.trim();
  if (!trimmed) {
    return userMessage;
  }

  const entityIndex = getPreferredEntityIndex(taskId, taskState);
  if (entityIndex.length === 0) {
    if (
      /\bthat (invoice|task|record|estimate|item)\b/i.test(trimmed)
      && taskState?.currentEntity?.recordId
    ) {
      return trimmed.replace(
        /\bthat (invoice|task|record|estimate|item)\b/gi,
        (match) =>
          `${match} (recordId=${taskState.currentEntity!.recordId}, label=${taskState.currentEntity!.label ?? taskState.currentEntity!.module})`,
      );
    }
    return userMessage;
  }

  let resolved = trimmed;

  resolved = resolved.replace(/\b(\d+)(st|nd|rd|th)\s+one\b/gi, (match, ordinalText) => {
    const ordinal = Number.parseInt(String(ordinalText), 10);
    if (!Number.isFinite(ordinal)) {
      return match;
    }
    const entity = entityIndex.find((entry) => entry.ordinal === ordinal);
    if (!entity) {
      return match;
    }
    return `${match} (${buildReferenceSuffix(entity)})`;
  });

  if (/\bthe last one\b/i.test(resolved)) {
    const entity = entityIndex[entityIndex.length - 1];
    if (entity) {
      resolved = resolved.replace(
        /\bthe last one\b/gi,
        `the last one (${buildReferenceSuffix(entity)})`,
      );
    }
  }

  if (/\bthat (invoice|task|record|estimate|item)\b/i.test(resolved)) {
    const entity = entityIndex[entityIndex.length - 1];
    if (entity) {
      resolved = resolved.replace(
        /\bthat (invoice|task|record|estimate|item)\b/gi,
        (match) => `${match} (${buildReferenceSuffix(entity)})`,
      );
    }
  }

  if (/\bthis one\b/i.test(resolved)) {
    const entity = entityIndex[entityIndex.length - 1];
    if (entity) {
      resolved = resolved.replace(/\bthis one\b/gi, `this one (${buildReferenceSuffix(entity)})`);
    }
  }

  return resolved;
};
