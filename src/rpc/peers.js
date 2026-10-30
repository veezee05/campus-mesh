'use strict';

const { grpc, campus } = require('./proto');
const { NODE_ID, NODE_NAME, PEERS, RPC_DEADLINE_MS } = require('../config');
const clock = require('../clock');
const log = require('../log');
const store = require('../store');

// One long-lived stub per peer. The address is resolved by DNS on each call,
// so a peer that restarts at a new IP is picked up without a reboot here.
const peers = PEERS.map((p) => ({
  ...p,
  stub: new campus.ResourceNode(p.address, grpc.credentials.createInsecure())
}));

function deadline(ms) {
  return new Date(Date.now() + ms);
}

function askPeer(peer, query) {
  return new Promise((resolve, reject) => {
    peer.stub.Search(
      { query, origin_id: NODE_ID, lamport: clock.tick(), ttl: 1 },
      { deadline: deadline(RPC_DEADLINE_MS) },
      (err, reply) => (err ? reject(err) : resolve(reply))
    );
  });
}

// Available first, then this node's own items (a walk of zero metres beats a
// walk across campus), then alphabetically for a stable order.
function rank(a, b) {
  const avail = (r) => (r.status === 'available' ? 0 : 1);
  if (avail(a) !== avail(b)) return avail(a) - avail(b);
  const local = (r) => (r.node_id === NODE_ID ? 0 : 1);
  if (local(a) !== local(b)) return local(a) - local(b);
  return a.name.localeCompare(b.name);
}

// THE core of the project.
//
// Every peer is asked at the SAME TIME and each call carries its own deadline.
// Consequences, both of which matter for the viva:
//   - latency is bounded by the SLOWEST peer, not the SUM of all peers  (scalability)
//   - a dead peer costs one deadline and never blocks the result       (fault tolerance)
async function distributedSearch(query) {
  const t0 = Date.now();
  clock.tick();

  const local = store.find(query).map(store.decorate);
  log.rpcOut(
    `Search("${query}") -> ${peers.length ? peers.map((p) => p.id).join(', ') : '(no peers configured)'}`
  );

  const settled = await Promise.allSettled(peers.map((p) => askPeer(p, query)));

  const remote = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      clock.receive(r.value.lamport);
      peers[i].state = 'UP';
      remote.push(...r.value.matches);
    } else {
      peers[i].state = 'DOWN';
      log.warn(`peer ${peers[i].id} unreachable: ${r.reason.details || r.reason.message}`);
    }
  });

  const responded = settled.filter((r) => r.status === 'fulfilled').length + 1;
  const total = peers.length + 1;
  const matches = [...local, ...remote].sort(rank);
  const latencyMs = Date.now() - t0;

  log.rpcOk(
    `${responded}/${total} nodes responded in ${latencyMs}ms -> ${matches.length} match(es)`
  );

  return { matches, responded, total, latencyMs, query };
}

function findPeer(id) {
  return peers.find((p) => p.id === id);
}

// A reservation must be decided by the node that OWNS the resource - that is
// why the owner is encoded in the identifier. No node ever writes another
// node's table.
function reserveRemote(peer, { rid, requester, hours }) {
  return new Promise((resolve, reject) => {
    log.rpcOut(`Reserve(${rid}) -> ${peer.id}`);
    peer.stub.Reserve(
      { rid, requester, hours, lamport: clock.tick() },
      { deadline: deadline(RPC_DEADLINE_MS) },
      (err, reply) => {
        if (err) return reject(err);
        clock.receive(reply.lamport);
        resolve(reply);
      }
    );
  });
}

function pingPeer(peer) {
  return new Promise((resolve, reject) => {
    peer.stub.Ping(
      { from: NODE_ID, lamport: clock.tick() },
      { deadline: deadline(1000) },
      (err, reply) => (err ? reject(err) : resolve(reply))
    );
  });
}

function snapshot() {
  return [
    { id: NODE_ID, name: NODE_NAME, address: 'self', state: 'UP', self: true },
    ...peers.map((p) => ({
      id: p.id,
      name: p.name || p.id, // learned from Ping once the peer has answered once
      address: p.address,
      state: p.state,
      misses: p.misses,
      resourceCount: p.resourceCount,
      self: false
    }))
  ];
}

// Phase 5 adds the heartbeat timer here and maintains peer.state / peer.misses
// continuously instead of only as a side effect of searching.

module.exports = { peers, distributedSearch, reserveRemote, pingPeer, findPeer, snapshot };

// --- phase 5: liveness -----------------------------------------------------
//
// Peer state is maintained continuously, not as a side effect of somebody
// searching. Liveness is tested with Ping over the SAME channel a search
// would use, deliberately: a peer that cannot answer Ping cannot answer
// Search either, so this is a real readiness signal rather than a guess.
//
// Flap protection: one missed beat is noise (a GC pause, a busy event loop).
// Three consecutive misses is a failure. One success restores the peer.

let timer = null;

function startHeartbeat(onChange) {
  const { HEARTBEAT_MS, MISSES_TO_DOWN } = require('../config');

  if (!peers.length) {
    log.boot('heartbeat idle - no peers configured');
    return () => {};
  }

  log.boot(`heartbeat every ${HEARTBEAT_MS}ms, ${MISSES_TO_DOWN} misses marks a peer DOWN`);

  const beat = async () => {
    let changed = false;

    await Promise.all(
      peers.map(async (p) => {
        const was = p.state;
        try {
          const reply = await pingPeer(p);
          clock.receive(reply.lamport);
          p.misses = 0;
          p.state = 'UP';
          p.name = reply.node_name;
          p.resourceCount = reply.resource_count;
          if (was === 'DOWN') log.ok(`${p.id} rejoined the network`);
        } catch {
          p.misses += 1;
          if (p.misses >= MISSES_TO_DOWN && p.state !== 'DOWN') {
            p.state = 'DOWN';
            log.warn(`${p.id} marked DOWN after ${p.misses} missed heartbeats`);
          }
        }
        if (p.state !== was) changed = true;
      })
    );

    if (changed && typeof onChange === 'function') onChange(snapshot());
  };

  beat();
  timer = setInterval(beat, HEARTBEAT_MS);
  timer.unref();

  return () => clearInterval(timer);
}

module.exports.startHeartbeat = startHeartbeat;
