/**
 * 轨迹：控制面每次转移一行，用来回答"刚才这 9 秒发生了什么"。
 *
 * 内存里是环形缓冲，落盘是 JSONL（由装配方接）。
 */

export interface TraceNote {
  /** 绝对时间（毫秒）。 */
  t: number;
  kind: string;
  detail: string;
}

export function formatNote(note: TraceNote, base: number): string {
  const dt = ((note.t - base) / 1000).toFixed(1);
  return `+${dt}s ${note.kind.padEnd(8)} ${note.detail}`;
}

export class Trace {
  private readonly notes: TraceNote[] = [];
  private readonly capacity: number;
  /** 第一条轨迹的时间，格式化时的相对原点。 */
  readonly base: number;

  constructor(capacity = 500, base = Date.now()) {
    this.capacity = capacity;
    this.base = base;
  }

  push(note: TraceNote): void {
    this.notes.push(note);
    if (this.notes.length > this.capacity) this.notes.shift();
  }

  get size(): number {
    return this.notes.length;
  }

  recent(count = 50): readonly TraceNote[] {
    return this.notes.slice(-count);
  }

  lines(count = 50): string[] {
    return this.recent(count).map((note) => formatNote(note, this.base));
  }
}
