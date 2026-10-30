'use strict';

const path = require('path');
const express = require('express');

const { NODE_ID, NODE_NAME, HTTP_PORT, PEERS } = require('./config');
const log = require('./log');
const store = require('./store');
const rpcServer = require('./rpc/server');
const peers = require('./rpc/peers');
const bus = require('./mq/bus');
const wantlist = require('./wantlist');
const notifications = require('./notifications');
const events = require('./http/events');
const api = require('./http/api');

// This function is the only place in the codebase where the resource table,
// the messaging bus, the standing requests and the browsers know about each
// other. Everything else stays independently testable.
function wire() {
  // A change to this node's own table becomes an announcement to the mesh.
  // Fires for BOTH the local HTTP path and an inbound RPC from another node,
  // because neither one publishes directly.
  store.on('released', (r) => bus.announceAvailable(r));
  store.on('reserved', (r) => bus.announceReserved(r));

  // An announcement from ANY node - including this one - is tested against
  // every standing request parked here.
  bus.bus.on('available', (msg) => {
    const hits = wantlist.matchAgainst(msg);
    if (!hits.length) return;

    log.ok(`${hits.length} student(s) waiting for "${msg.name}" - notifying`);
    hits.forEach((hit) => {
      const entry = notifications.push({
        kind: 'available',
        query: hit.query,
        requester: hit.requester,
        rid: msg.rid,
        name: msg.name,
        node_id: msg.node_id,
        node_name: msg.node_name,
        lamport: msg.lamport
      });
      events.broadcast('available', entry);
      wantlist.remove(hit.id); // satisfied - stop watching
    });
  });

  // A reservation elsewhere invalidates what a browser may be showing.
  bus.bus.on('reserved', (msg) => events.broadcast('reserved', msg));

  // Phase 6: when THIS node grants a reservation on one of its own items, the
  // student standing in this lab is the one who has to hand it over. Invite
  // them into the handover channel.
  store.on('reserved', (r) => {
    events.broadcast('handover', {
      room: `room-${r.rid.replace(/:/g, '-')}-v${r.version}`,
      rid: r.rid,
      name: r.name,
      holder: r.holder,
      role: 'owner'
    });
  });

  // Relayed signalling arrives from the mesh and is pushed to whichever
  // browsers on this node are in that room. The node does not interpret it.
  bus.bus.on('signal', (msg) => events.broadcast('signal', msg));

  // Peer liveness changes are pushed so the status dots move on their own.
  peers.startHeartbeat((snapshot) => events.broadcast('peers', snapshot));
}

async function main() {
  const loaded = store.load();
  log.boot(`${NODE_NAME} (${NODE_ID}) - ${loaded} resources loaded`);
  log.boot(`peers: ${PEERS.length ? PEERS.map((p) => p.address).join(', ') : 'none (standalone)'}`);

  await rpcServer.start();
  bus.connect();
  wire();

  const app = express();
  app.use(express.json());
  app.use('/api', api);
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.listen(HTTP_PORT, () => {
    log.boot(`UI on http://localhost:${HTTP_PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
