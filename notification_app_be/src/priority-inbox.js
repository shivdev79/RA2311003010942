'use strict';

/**
 * Priority Inbox — Min-Heap of fixed size N
 *
 * Priority:  Placement (3)  >  Result (2)  >  Event (1)
 *
 * The heap root is always the WORST item in the current top-N set.
 * Inserting a new notification: O(log N).  Space: O(N).
 *
 * NOTE: pure JS — no external libraries (per evaluation rules).
 */

const TYPE_PRIORITY = { Placement: 3, Result: 2, Event: 1 };

function score(n) { return TYPE_PRIORITY[n.Type] ?? 0; }

// True when item `a` should be evicted before `b` (a is "worse")
function isWorse(a, b) {
  if (a._score !== b._score) return a._score < b._score;
  return a._ts < b._ts; // older = worse
}

class PriorityInbox {
  constructor(maxSize) {
    this._max  = maxSize;
    this._heap = [];
  }

  add(notif) {
    const item = {
      ...notif,
      _score: score(notif),
      _ts:    new Date(notif.Timestamp).getTime(),
    };

    if (this._heap.length < this._max) {
      this._heap.push(item);
      this._bubbleUp(this._heap.length - 1);
      return;
    }

    const root = this._heap[0];
    if (item._score > root._score ||
        (item._score === root._score && item._ts > root._ts)) {
      this._heap[0] = item;
      this._siftDown(0);
    }
  }

  getTopN() {
    return [...this._heap].sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      return b._ts - a._ts;
    });
  }

  _bubbleUp(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!isWorse(this._heap[i], this._heap[p])) break;
      [this._heap[i], this._heap[p]] = [this._heap[p], this._heap[i]];
      i = p;
    }
  }

  _siftDown(i) {
    const n = this._heap.length;
    for (;;) {
      let worst = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && isWorse(this._heap[l], this._heap[worst])) worst = l;
      if (r < n && isWorse(this._heap[r], this._heap[worst])) worst = r;
      if (worst === i) break;
      [this._heap[i], this._heap[worst]] = [this._heap[worst], this._heap[i]];
      i = worst;
    }
  }
}

module.exports = { PriorityInbox };
