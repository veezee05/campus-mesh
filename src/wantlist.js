'use strict';

const { matches } = require('./match');
const log = require('./log');

// A student searched, found nothing, and asked to be told when one turns up.
//
// This is the case request/reply cannot serve. To do it over RPC this node
// would have to poll every peer forever. Instead the student's need is parked
// here and an announcement from ANY node wakes it up.

let seq = 0;
const entries = [];

function add(query, requester) {
  const entry = {
    id: `want-${++seq}`,
    query: String(query || '').trim(),
    requester: requester || 'anonymous',
    createdAt: Date.now()
  };
  entries.push(entry);
  log.http(`wantlist + "${entry.query}" for ${entry.requester}`);
  return entry;
}

function remove(id) {
  const i = entries.findIndex((e) => e.id === id);
  if (i === -1) return false;
  entries.splice(i, 1);
  return true;
}

function list() {
  return entries.slice();
}

// An announcement carries the resource's name, category and tags, so it can be
// tested against a standing query with exactly the same matcher a search uses.
function matchAgainst(announcement) {
  return entries.filter((e) => matches(announcement, e.query));
}

module.exports = { add, remove, list, matchAgainst };
