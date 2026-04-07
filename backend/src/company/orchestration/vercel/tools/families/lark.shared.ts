import type { VercelToolEnvelope } from '../../types';

export const LARK_LARGE_RESULT_THRESHOLD = 20;

export const projectLarkItem = (
  item: Record<string, unknown>,
): Record<string, unknown> => {
  const projected: Record<string, unknown> = {};
  const id =
    item.id
    ?? item.taskId
    ?? item.taskGuid
    ?? item.eventId
    ?? item.meetingId
    ?? item.instanceCode
    ?? item.recordId
    ?? item.tableId
    ?? item.viewId
    ?? item.fieldId
    ?? item.tasklistId
    ?? item.appToken
    ?? item.openId
    ?? item.externalUserId
    ?? item.assigneeId;
  const title =
    item.title
    ?? item.summary
    ?? item.topic
    ?? item.name
    ?? item.displayName;
  const status = item.status;
  const dueDate =
    item.dueDate
    ?? item.due
    ?? item.dueTs
    ?? item.dueTime;
  const startTime =
    item.startTime
    ?? item.start_date
    ?? item.startDate;
  const assignee =
    item.assignee
    ?? item.assignees
    ?? item.assigneeId
    ?? item.owner;
  const url =
    item.url
    ?? item.link
    ?? item.permalink;

  if (id !== undefined && id !== null) projected.id = id;
  if (title !== undefined && title !== null) projected.title = title;
  if (status !== undefined && status !== null) projected.status = status;
  if (dueDate !== undefined && dueDate !== null) projected.dueDate = dueDate;
  if (startTime !== undefined && startTime !== null) projected.startTime = startTime;
  if (assignee !== undefined && assignee !== null) projected.assignee = assignee;
  if (url !== undefined && url !== null) projected.url = url;
  return projected;
};

export const buildLarkItemsEnvelope = (input: {
  summary: string;
  emptySummary: string;
  items: Array<Record<string, unknown>>;
  fullPayload?: Record<string, unknown>;
  keyData?: Record<string, unknown>;
  buildEnvelope: (payload: Record<string, unknown>) => VercelToolEnvelope;
}): VercelToolEnvelope => {
  const isLargeResult = input.items.length > LARK_LARGE_RESULT_THRESHOLD;
  const projectedItems = isLargeResult
    ? input.items.map((item) => projectLarkItem(item))
    : input.items;
  const projectionNote = isLargeResult
    ? ' Results projected to essential fields to stay within context limits.'
    : '';

  return input.buildEnvelope({
    success: true,
    summary: (input.items.length > 0 ? input.summary : input.emptySummary) + projectionNote,
    keyData: {
      ...(input.keyData ?? {}),
      items: projectedItems,
      ...(isLargeResult
        ? { projectedFields: ['id', 'title', 'status', 'dueDate', 'startTime', 'assignee', 'url'] }
        : {}),
    },
    fullPayload: {
      ...(input.fullPayload ?? {}),
      items: projectedItems,
    },
  });
};
