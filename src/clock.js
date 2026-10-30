'use strict';

// Lamport logical clock.
//
// Wall clocks on three machines disagree, so "which event happened first"
// cannot be answered with timestamps. A Lamport clock gives a partial order
// that respects causality: if event A caused event B then L(A) < L(B).
class LamportClock {
  constructor() {
    this.t = 0;
  }

  // A local event, or the moment just before sending a message.
  tick() {
    return ++this.t;
  }

  // Receiving a message: never fall behind the sender.
  receive(remote) {
    this.t = Math.max(this.t, Number(remote || 0)) + 1;
    return this.t;
  }

  get value() {
    return this.t;
  }
}

module.exports = new LamportClock();
