const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const helpers = import(pathToFileURL(path.resolve(__dirname, '../web-vue/src/features/contacts/contactAutosave.ts')).href);
const initial = { remark: '旧备注', group_name: '工作' };
const gate = () => { let resolve; const promise = new Promise(ok => { resolve = ok; }); return { promise, resolve }; };

test('typing is debounced and clearing a remark persists an empty value', async () => {
  const { createContactAutosave } = await helpers;
  const writes = []; let server = { ...initial };
  const editor = createContactAutosave({ initial, delay: 15, changed() {}, write: async patch => { writes.push(patch); return server = { ...server, ...patch }; } });
  assert.equal(writes.length, 0);
  editor.edit({ ...initial, remark: '新' }); editor.edit({ ...initial, remark: '新备注' });
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.deepEqual(writes, [{ remark: '新备注' }]);
  editor.edit({ ...initial, remark: '' }); await editor.flush();
  assert.equal(server.remark, ''); assert.equal(editor.state().phase, 'saved'); editor.stop();
});

test('an old acknowledgement cannot replace newer input and writes never overlap', async () => {
  const { createContactAutosave } = await helpers;
  const started = gate(), finish = gate(), writes = []; let server = { ...initial }, active = 0, max = 0;
  const editor = createContactAutosave({ initial, delay: 60000, changed() {}, write: async patch => {
    writes.push(patch); active++; max = Math.max(max, active);
    if (writes.length === 1) { started.resolve(); await finish.promise; }
    active--; return server = { ...server, ...patch };
  } });
  editor.edit({ ...initial, remark: '第一版' }); const saving = editor.flush(); await started.promise;
  editor.edit({ remark: '最终备注', group_name: '家人' }); const closing = editor.flush(); finish.resolve();
  assert.equal(await saving, true); assert.equal(await closing, true);
  assert.deepEqual(writes, [{ remark: '第一版' }, { remark: '最终备注', group_name: '家人' }]);
  assert.equal(max, 1); assert.deepEqual(server, editor.state().draft); editor.stop();
});

test('changing only a remark preserves a concurrent server-side group change', async () => {
  const { createContactAutosave } = await helpers;
  const editor = createContactAutosave({ initial, changed() {}, write: async patch => {
    assert.deepEqual(patch, { remark: '新备注' }); return { remark: '新备注', group_name: '服务器新分组' };
  } });
  editor.edit({ ...initial, remark: '新备注' }); await editor.flush();
  assert.deepEqual(editor.state().draft, { remark: '新备注', group_name: '服务器新分组' });
  assert.equal(editor.state().dirty, false); editor.stop();
});

test('a failed save keeps the draft and requires an explicit retry or a new edit', async () => {
  const { createContactAutosave } = await helpers;
  let fails = true, writes = 0;
  const editor = createContactAutosave({ initial, changed() {}, write: async patch => {
    writes++; if (fails) throw Object.assign(Error('conflict'), { status: 409 }); return { ...initial, ...patch };
  } });
  editor.edit({ ...initial, remark: '保留输入' }); assert.equal(await editor.flush(), false);
  assert.equal(editor.state().draft.remark, '保留输入'); assert.equal(editor.state().phase, 'error');
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(writes, 1);
  fails = false; assert.equal(await editor.flush(), true); assert.equal(writes, 2); editor.stop();
});

test('pausing for composition prevents interim saves and stopping cancels queued edits', async () => {
  const { createContactAutosave } = await helpers;
  const writes = [];
  const editor = createContactAutosave({ initial, delay: 10, changed() {}, write: async patch => { writes.push(patch); return { ...initial, ...patch }; } });
  editor.edit({ ...initial, remark: '拼音输入前' }); editor.pause();
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(writes.length, 0);
  editor.edit({ ...initial, remark: '完整中文备注' }); await editor.flush();
  assert.deepEqual(writes, [{ remark: '完整中文备注' }]);
  editor.edit({ ...initial, remark: '已离开的资料' }); editor.stop();
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(writes.length, 1);
});
