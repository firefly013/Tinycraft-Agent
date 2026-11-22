/**
 * 施工前的现场快照：只记“会被改到的格子”原来的样子，按 JSONL 追加。
 *
 * 存成 JSONL 而不是一个大 JSON：施工中途崩溃也能按行读到已经改过的部分。
 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface UndoRecord {
  x: number;
  y: number;
  z: number;
  state: string;
}

export function undoPath(blueprintDir: string): string {
  return join(blueprintDir, 'undo.jsonl');
}

/** 一次新的施工开始：旧快照作废。 */
export function resetUndo(blueprintDir: string): void {
  writeFileSync(undoPath(blueprintDir), '');
}

export function appendUndo(blueprintDir: string, record: UndoRecord): void {
  appendFileSync(undoPath(blueprintDir), `${JSON.stringify(record)}\n`);
}

/** 读回全部记录；坏行跳过，不让一条脏数据毁掉整次还原。 */
export function readUndo(blueprintDir: string): UndoRecord[] {
  const path = undoPath(blueprintDir);
  if (!existsSync(path)) return [];
  const records: UndoRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    try {
      const value = JSON.parse(text) as UndoRecord;
      if ([value.x, value.y, value.z].every(Number.isInteger) && typeof value.state === 'string') records.push(value);
    } catch {
      // 半截行：忽略。
    }
  }
  return records;
}

export function clearUndo(blueprintDir: string): void {
  rmSync(undoPath(blueprintDir), { force: true });
}
