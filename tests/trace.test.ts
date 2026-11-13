import test from 'node:test';
import assert from 'node:assert/strict';
import { Trace, formatNote } from '../src/core/trace.ts';

test('转移按相对时间渲染成一行', () => {
  assert.equal(
    formatNote({ t: 1500, kind: 'claim', detail: 'model mineBlock' }, 0),
    '+1.5s claim    model mineBlock',
  );
});

test('环形缓冲只留最近的若干条', () => {
  const trace = new Trace(2, 0);
  trace.push({ t: 1, kind: 'a', detail: '1' });
  trace.push({ t: 2, kind: 'b', detail: '2' });
  trace.push({ t: 3, kind: 'c', detail: '3' });
  assert.equal(trace.size, 2);
  assert.deepEqual(trace.recent().map((note) => note.kind), ['b', 'c']);
});
