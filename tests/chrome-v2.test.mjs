import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemName } from '../scripts/chrome-v2.mjs';

test('itemName builds the v2 resource path used by every endpoint', () => {
  assert.equal(
    itemName('68260b6b-c97f-41c0-aea2-d530b60d7c53', 'mpjleclhdlfhdcimphbcbcikklhgkimm'),
    'publishers/68260b6b-c97f-41c0-aea2-d530b60d7c53/items/mpjleclhdlfhdcimphbcbcikklhgkimm',
  );
});
