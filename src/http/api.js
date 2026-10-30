'use strict';

const express = require('express');
const { NODE_ID, NODE_NAME, GRPC_PORT, HTTP_PORT } = require('../config');
const clock = require('../clock');
const log = require('../log');
const store = require('../store');
const rpc = require('../rpc/peers');
const bus = require('../mq/bus');
const wantlist = require('../wantlist');
const notifications = require('../notifications');
const events = require('./events');

const router = express.Router();

router.get('/node', (req, res) => {
  res.json({
    node_id: NODE_ID,
    node_name: NODE_NAME,
    grpc_port: GRPC_PORT,
    http_port: HTTP_PORT,
    lamport: clock.value,
    mqtt: bus.connected(),
    peers: rpc.snapshot()
  });
});

router.get('/resources', (req, res) => {
  res.json({ node_id: NODE_ID, node_name: NODE_NAME, items: store.list() });
});

// The browser sends ONLY the query text. It never names a node, and it cannot
// tell a local hit from a remote one - the reply is a flat, uniform list.
// That is location transparency and access transparency, demonstrated.
router.post('/search', async (req, res) => {
  const query = (req.body && req.body.query) || '';
  log.http(`search "${query}"`);
  try {
    res.json(await rpc.distributedSearch(query));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Routed by IDENTIFIER: the owner is encoded in the rid, so the request goes
// to the node that owns the resource - locally if that is us, by RPC if not.
router.post('/reserve', async (req, res) => {
  const { rid, requester, hours } = req.body || {};
  if (!rid) return res.status(400).json({ error: 'rid is required' });

  const ownerId = String(rid).split(':')[0];

  if (ownerId === NODE_ID) {
    const result = store.reserve({ rid, requester, hours });
    log.http(`local reserve ${rid} -> ${result.granted ? 'GRANTED' : 'REFUSED'}`);
    return res.json({ ...result, decided_by: NODE_ID });
  }

  const peer = rpc.findPeer(ownerId);
  if (!peer) {
    return res.status(404).json({ error: `unknown owner node ${ownerId}` });
  }

  try {
    const reply = await rpc.reserveRemote(peer, { rid, requester, hours });
    res.json({
      granted: reply.granted,
      reason: reply.reason,
      handover_room: reply.handover_room,
      version: reply.version,
      decided_by: ownerId
    });
  } catch (err) {
    res.status(503).json({
      error: `owner node ${ownerId} unreachable`,
      detail: err.details || err.message
    });
  }
});

// Only the owning node may release its own item. store.release() emits
// 'released', which index.js turns into an MQTT announcement.
router.post('/release', (req, res) => {
  const { rid } = req.body || {};
  if (!rid) return res.status(400).json({ error: 'rid is required' });
  if (String(rid).split(':')[0] !== NODE_ID) {
    return res.status(403).json({ error: 'only the owning node can release a resource' });
  }
  const result = store.release(rid);
  log.http(`release ${rid} -> ${result.ok ? 'available' : result.reason}`);
  res.json(result);
});

// --- phase 4: standing requests --------------------------------------------

router.get('/wantlist', (req, res) => {
  res.json({ node_id: NODE_ID, entries: wantlist.list() });
});

router.post('/wantlist', (req, res) => {
  const { query, requester } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query is required' });
  res.json(wantlist.add(query, requester));
});

router.post('/wantlist/remove', (req, res) => {
  const { id } = req.body || {};
  res.json({ ok: wantlist.remove(id) });
});

router.get('/notifications', (req, res) => {
  res.json({ node_id: NODE_ID, items: notifications.list() });
});

// --- phase 6: WebRTC signalling ---------------------------------------------

// The browser hands its offer / answer / ICE candidates to its OWN node, which
// relays them across the mesh. Nothing here understands WebRTC - it is an
// opaque relay, and once the peer connection is established it is idle.
router.post('/signal', (req, res) => {
  const { room, kind, from, payload } = req.body || {};
  if (!room || !kind) return res.status(400).json({ error: 'room and kind are required' });

  const sent = bus.publishSignal(room, { kind, from, payload });
  if (!sent) {
    return res.status(503).json({ error: 'no broker connection - signalling unavailable' });
  }
  res.json({ ok: true, room, kind });
});

// Push channel: peer state, availability announcements, handover invitations
// and relayed signalling.
router.get('/events', events.handler);

module.exports = router;
