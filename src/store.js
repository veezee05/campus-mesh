'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { NODE_ID, NODE_NAME } = require('./config');
const { matches } = require('./match');

// Each node owns its own resource table. There is no shared database and no
// coordinator - a node can only learn about another node's inventory by
// sending it a message. That is what makes this genuinely distributed.
//
// The store emits events rather than publishing to MQTT itself. Keeping the
// table ignorant of the messaging layer is what lets BOTH the local HTTP path
// and the inbound RPC path announce a change without either one knowing the
// other exists. index.js is the only place the two are wired together.

const DATA_DIR = path.join(__dirname, '..', 'data');

const emitter = new EventEmitter();
let items = [];

function load() {
  const own = path.join(DATA_DIR, `seed.${NODE_ID}.json`);
  const file = fs.existsSync(own) ? own : path.join(DATA_DIR, 'seed.default.json');
  items = JSON.parse(fs.readFileSync(file, 'utf8'));
  return items.length;
}

// The wire form of a resource: the owning node stamps its own identity on
// every record, so an aggregated result set stays attributable.
function decorate(r) {
  return {
    rid: r.rid,
    name: r.name,
    category: r.category,
    status: r.status,
    node_id: NODE_ID,
    node_name: NODE_NAME,
    version: r.version
  };
}

function find(query) {
  return items.filter((r) => matches(r, query));
}

function get(rid) {
  return items.find((r) => r.rid === rid);
}

// All reservation logic lives behind this one function. FA-2 replaces its
// body with a distributed lock or a consensus round and touches nothing else.
function reserve({ rid, requester, hours }) {
  const r = get(rid);
  if (!r) {
    return { granted: false, reason: 'no such resource on this node' };
  }
  if (r.status !== 'available') {
    return { granted: false, reason: `already ${r.status}`, version: r.version };
  }

  r.status = 'reserved';
  r.holder = requester || 'anonymous';
  r.reservedHours = Number(hours) || 2;
  r.reservedAt = Date.now();
  r.version += 1;

  emitter.emit('reserved', r);

  return {
    granted: true,
    reason: 'granted',
    handover_room: `room-${rid.replace(/:/g, '-')}-v${r.version}`,
    version: r.version
  };
}

function release(rid) {
  const r = get(rid);
  if (!r) return { ok: false, reason: 'no such resource on this node' };

  r.status = 'available';
  r.holder = null;
  r.reservedHours = null;
  r.reservedAt = null;
  r.version += 1;

  emitter.emit('released', r);

  return { ok: true, resource: r };
}

// Local view keeps the fields the owning node's own UI needs.
function list() {
  return items.map((r) => ({ ...decorate(r), holder: r.holder, tags: r.tags }));
}

function count() {
  return items.length;
}

module.exports = {
  load, find, get, reserve, release, list, count, decorate,
  on: emitter.on.bind(emitter)
};
