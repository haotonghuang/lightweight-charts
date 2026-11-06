import assert from 'node:assert/strict';
import { caseFromDraft, createCaseDraft, filterCases } from './encyclopedia.js';

const cases = [
  { id: 'one', date: '2017-03-14', barNumber: 15, time: 1489501800, setupIds: ['gap-low2'], tagIds: ['buying', 'ema'], notes: 'opening drive' },
  { id: 'two', date: '2018-01-08', barNumber: 6, time: 1515429000, setupIds: ['gap-low2'], tagIds: ['buying'], notes: 'failed follow through' },
  { id: 'three', date: '2019-02-01', barNumber: 23, time: 1549036800, setupIds: ['other'], tagIds: ['ema'], notes: 'trend day' },
];

assert.deepEqual(filterCases(cases, { setupId: 'gap-low2', tagIds: ['buying', 'ema'] }).map(item => item.id), ['one']);
assert.deepEqual(filterCases(cases, { tagIds: ['buying', 'ema'], tagMode: 'any' }).map(item => item.id), ['three', 'two', 'one']);
assert.deepEqual(filterCases(cases, { setupId: 'gap-low2', tagIds: ['buying'], query: 'failed' }).map(item => item.id), ['two']);
assert.deepEqual(filterCases(cases, { setupId: 'missing' }), []);

const selected = {
  date: '2017-03-14', barNumber: 15, time: 1489501800,
  interval: 5, session: 'rth', adjustment: 'back', rollRevision: 'v1', dataSource: 'ES',
};
const draft = createCaseDraft(selected, { setupIds: ['gap-low2'], tagIds: ['buying'], notes: '  strong buying  ' });
selected.date = '2017-03-15';
selected.barNumber = 16;
assert.equal(draft.anchor.date, '2017-03-14', 'draft anchor is copied from the selected signal bar');
assert.equal(draft.anchor.barNumber, 15, 'later chart selection cannot retarget an unsaved draft');
assert.deepEqual(caseFromDraft(draft), {
  date: '2017-03-14', barNumber: 15, time: 1489501800,
  interval: 5, session: 'rth', adjustment: 'back', rollRevision: 'v1', dataSource: 'ES',
  setupIds: ['gap-low2'], tagIds: ['buying'], notes: 'strong buying',
});
assert.throws(() => caseFromDraft(createCaseDraft(null)), /信号 K 线/);

console.log('百科筛选、标签组合与草稿定位测试通过');
