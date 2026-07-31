import {
  createLarkSdkInventory,
  LARK_SDK_PARITY_BASELINE,
} from '../src/infrastructure/channels/lark/lark-sdk-inventory';

const inventory = createLarkSdkInventory();
const matchesBaseline = inventory.version === LARK_SDK_PARITY_BASELINE.version
  && inventory.endpointCount === LARK_SDK_PARITY_BASELINE.endpointCount
  && inventory.serviceCount === LARK_SDK_PARITY_BASELINE.serviceCount
  && inventory.sha256 === LARK_SDK_PARITY_BASELINE.sha256;

process.stdout.write(`${JSON.stringify({
  packageName: inventory.packageName,
  version: inventory.version,
  endpointCount: inventory.endpointCount,
  serviceCount: inventory.serviceCount,
  sha256: inventory.sha256,
  matchesBaseline,
}, null, 2)}\n`);

if (!matchesBaseline) process.exitCode = 1;
