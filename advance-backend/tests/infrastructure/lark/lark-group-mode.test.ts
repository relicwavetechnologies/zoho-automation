import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LARK_GROUP_MODE,
  larkGroupModeControlKey,
  loadLarkGroupMode,
  saveLarkGroupMode,
} from '../../../src/infrastructure/channels/lark/lark-group-mode.ts';

const address = {
  companyId: 'company-1',
  tenantKey: 'tenant-1',
  appId: 'app-1',
  chatId: 'oc-room-1',
};

describe('Lark group mode', () => {
  it('defaults missing and invalid values to threaded', async () => {
    for (const value of [null, 'surprise']) {
      const store = {
        adminControlState: {
          findUnique: async () => value === null ? null : { value },
          upsert: async () => undefined,
        },
      };
      assert.equal(await loadLarkGroupMode(store, address), DEFAULT_LARK_GROUP_MODE);
    }
  });

  it('separates controls by installation and chat', () => {
    const first = larkGroupModeControlKey(address);
    assert.notEqual(first, larkGroupModeControlKey({ ...address, chatId: 'oc-room-2' }));
    assert.notEqual(first, larkGroupModeControlKey({ ...address, appId: 'app-2' }));
    assert.notEqual(first, larkGroupModeControlKey({ ...address, tenantKey: 'tenant-2' }));
  });

  it('persists the selected mode under the company-scoped control key', async () => {
    let write: unknown;
    const store = {
      adminControlState: {
        findUnique: async () => null,
        upsert: async (input: unknown) => { write = input; },
      },
    };

    await saveLarkGroupMode(store, address, 'inline', 'user-admin');

    assert.deepEqual(write, {
      where: {
        controlKey_companyId: {
          controlKey: larkGroupModeControlKey(address),
          companyId: 'company-1',
        },
      },
      create: {
        controlKey: larkGroupModeControlKey(address),
        companyId: 'company-1',
        value: 'inline',
        updatedBy: 'user-admin',
      },
      update: { value: 'inline', updatedBy: 'user-admin' },
    });
  });
});
