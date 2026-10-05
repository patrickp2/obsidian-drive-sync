import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishUiAction } from '../src/ui-action';
test('UI cleanup never assimilates an Obsidian-style chainable component', async () => {
  let resets = 0; let assimilations = 0;
  const button = { then() { assimilations++; throw new Error('UI component must not be assimilated'); }, setDisabled() { resets++; return this; } };
  await finishUiAction(Promise.resolve(), () => button.setDisabled());
  assert.equal(resets, 1); assert.equal(assimilations, 0);
  const error = new Error('failed operation');
  await assert.rejects(finishUiAction(Promise.reject(error), () => button.setDisabled()), error);
  assert.equal(resets, 2); assert.equal(assimilations, 0);
});
