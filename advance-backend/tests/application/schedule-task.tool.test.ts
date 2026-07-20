import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createScheduleTaskTool } from '../../src/application/orchestration/tools/orchestration/schedule-task.tool';

async function executeDynamic(tool: unknown, input: unknown): Promise<string> {
  return (tool as any).execute(input, { toolCallId: 'call-1', messages: [] });
}

describe('scheduleTask orchestration tool', () => {
  it('fails closed until the scheduling skill has been resolved', async () => {
    let created = false;
    const prisma = {
      scheduledWorkflow: {
        create: async () => {
          created = true;
          throw new Error('should not create');
        },
      },
    } as any;
    const tool = createScheduleTaskTool(
      prisma,
      {
        companyId: 'company-1',
        userId: 'user-1',
        companyRole: 'MEMBER',
        departmentId: 'department-1',
        channel: 'lark',
        chatId: 'chat-1',
      } as any,
      { isSchedulingSkillResolved: () => false },
    );

    const output = await executeDynamic(tool, {
      name: 'Daily research',
      intent: 'Research the named company using approved web sources and return a sourced report in this conversation. Do not perform external writes.',
      scheduleType: 'daily',
      timezone: 'Asia/Kolkata',
      hour: 14,
      timeMinute: 0,
      delivery: 'current_conversation',
    });

    assert.match(output, /^skill_required:/);
    assert.match(output, /call resolve_work/i);
    assert.equal(created, false);
  });
});
