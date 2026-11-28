import test from 'node:test';
import assert from 'node:assert/strict';
import { Trace, formatNote } from '../src/core/trace.ts';

test('转移按相对时间渲染成一行', () => {
  assert.equal(
    formatNote({ t: 1500, kind: 'claim', detail: 'model mineBlock' }, 0),
    '+1.5s claim    model mineBlock',
  );
});

test('轨迹保留全部转移，不设环形容量', () => {
  const trace = new Trace(0);
  for (let i = 1; i <= 501; i++) trace.push({ t: i, kind: 'step', detail: String(i) });
  assert.equal(trace.size, 501);
  assert.equal(trace.recent(1)[0]?.detail, '501');
});
