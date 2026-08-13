import Ajv from 'ajv';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DIVO_SEMRUSH_OPERATIONS,
  DIVO_SEMRUSH_PARAMS,
} from '../../../divo-pi/divo/extensions/divo-gateway/native-tools/semrush-contract.ts';
import {
  SEMRUSH_OPERATIONS,
  SemrushToolArgsSchema,
} from '../../src/application/semrush/semrush.types';

const validatePiContract = new Ajv({ allErrors: true, strict: false }).compile(DIVO_SEMRUSH_PARAMS);

const contractCases: Array<{ name: string; args: unknown; accepted: boolean }> = [
  { name: 'domain overview', args: { operation: 'domain_overview', domain: 'example.com' }, accepted: true },
  { name: 'country overview', args: { operation: 'domain_overview', domain: 'example.com', database: 'in' }, accepted: true },
  { name: 'backlink comparison', args: { operation: 'backlinks_comparison', targets: ['a.com', 'b.com'] }, accepted: true },
  {
    name: 'keyword trend',
    args: {
      operation: 'keyword_position_trend',
      domain: 'example.com',
      keyword: 'agent runtime',
      date: '20260813',
      dateType: 'monthly',
    },
    accepted: true,
  },
  { name: 'unknown operation', args: { operation: 'site_audit', domain: 'example.com' }, accepted: false },
  { name: 'protocol is not a domain', args: { operation: 'domain_overview', domain: 'https://example.com' }, accepted: false },
  { name: 'duplicate targets', args: { operation: 'backlinks_comparison', targets: ['a.com', 'a.com'] }, accepted: false },
  { name: 'empty targets', args: { operation: 'backlinks_comparison', targets: [] }, accepted: false },
  { name: 'invalid date', args: { operation: 'keyword_position_trend', domain: 'example.com', keyword: 'agent', date: '2026-08-13' }, accepted: false },
  { name: 'invalid database', args: { operation: 'domain_overview', domain: 'example.com', database: 'india' }, accepted: false },
  { name: 'extra property', args: { operation: 'domain_overview', domain: 'example.com', endpoint: '/anything' }, accepted: false },
];

describe('Semrush backend and Pi-native contract parity', () => {
  it('exposes exactly the operations the backend implements', () => {
    assert.deepEqual(DIVO_SEMRUSH_OPERATIONS, SEMRUSH_OPERATIONS);
  });

  for (const contractCase of contractCases) {
    it(`${contractCase.accepted ? 'accepts' : 'rejects'} ${contractCase.name} on both boundaries`, () => {
      const piAccepted = validatePiContract(contractCase.args);
      const backendAccepted = SemrushToolArgsSchema.safeParse(contractCase.args).success;
      assert.equal(piAccepted, contractCase.accepted, JSON.stringify(validatePiContract.errors));
      assert.equal(backendAccepted, contractCase.accepted);
    });
  }
});
