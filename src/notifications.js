'use strict';

// A short rolling log of things this node's students were told about.
//
// Kept server-side rather than only pushed to the browser, so a student who
// had the tab closed still sees what they missed - and so the automated
// verification can assert that an announcement actually landed.

const MAX = 50;
const items = [];
let seq = 0;

function push(notification) {
  const entry = { id: `ntf-${++seq}`, at: Date.now(), ...notification };
  items.unshift(entry);
  if (items.length > MAX) items.pop();
  return entry;
}

function list() {
  return items.slice();
}

function clear() {
  items.length = 0;
}

module.exports = { push, list, clear };
