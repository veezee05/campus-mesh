'use strict';

const { EventEmitter } = require('events');
const mqtt = require('mqtt');
const { NODE_ID, NODE_NAME, MQTT_URL } = require('../config');
const clock = require('../clock');
const log = require('../log');

// Message-oriented communication.
//
// Contrast with gRPC deliberately: an RPC is a question addressed to a known
// node that blocks until it is answered. A publish is an announcement to a
// TOPIC - this node does not know who is subscribed, does not wait, and does
// not find out whether anybody heard it. That is what makes "tell me when an
// HDMI cable frees up" possible without polling anybody.

const TOPIC = {
  available: (category) => `campus/resource/available/${category}`,
  reserved: (category) => `campus/resource/reserved/${category}`,
  signal: (room) => `campus/signal/${room}`,
  subscriptions: ['campus/resource/#', 'campus/signal/#']
};

const bus = new EventEmitter();
let client = null;

function connected() {
  return Boolean(client && client.connected);
}

function publish(topic, payload) {
  if (!connected()) return false;
  client.publish(
    topic,
    JSON.stringify({
      ...payload,
      node_id: NODE_ID,
      node_name: NODE_NAME,
      lamport: clock.tick(),
      ts: Date.now()
    })
  );
  log.mqOut(`${topic}  ${payload.name}`);
  return true;
}

function announceAvailable(r) {
  return publish(TOPIC.available(r.category), {
    rid: r.rid,
    name: r.name,
    category: r.category,
    tags: r.tags || []
  });
}

function announceReserved(r) {
  return publish(TOPIC.reserved(r.category), {
    rid: r.rid,
    name: r.name,
    category: r.category,
    tags: r.tags || [],
    holder: r.holder
  });
}

// Phase 6: WebRTC signalling relayed across the mesh.
//
// The two students are attached to DIFFERENT nodes, so the session
// description and ICE candidates have to cross the network before the peer
// connection can exist. Rather than invent a channel for it, the existing
// message bus carries them - signalling is just messaging. Once the peer
// connection is up, nothing here is in the path any more, which is exactly
// the separation of signalling from data.
function publishSignal(room, payload) {
  if (!connected()) return false;
  const topic = TOPIC.signal(room);
  client.publish(
    topic,
    JSON.stringify({
      ...payload,
      room,
      node_id: NODE_ID,
      lamport: clock.tick(),
      ts: Date.now()
    })
  );
  log.mqOut(`${topic}  ${payload.kind}`);
  return true;
}

function connect() {
  if (!MQTT_URL) {
    log.warn('MQTT_URL not set - running without announcements');
    return bus;
  }

  client = mqtt.connect(MQTT_URL, {
    clientId: `${NODE_ID}-${process.pid}`,
    reconnectPeriod: 2000,
    connectTimeout: 5000
  });

  client.on('connect', () => {
    log.boot(`MQTT connected to ${MQTT_URL}`);
    client.subscribe(TOPIC.subscriptions, (err) => {
      if (err) log.warn(`MQTT subscribe failed: ${err.message}`);
    });
  });

  client.on('error', (err) => log.warn(`MQTT ${err.message}`));

  client.on('message', (topic, buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return log.warn(`MQTT malformed payload on ${topic}`);
    }

    clock.receive(msg.lamport);

    // Own messages are NOT skipped. A different student on this same node may
    // be waiting for exactly this item, and the publisher has no idea who is
    // listening - that is the whole point of decoupling.
    const own = msg.node_id === NODE_ID ? ' (own echo)' : '';
    log.mqIn(`${topic}  ${msg.name || msg.kind}${own}`);

    if (topic.startsWith('campus/resource/available/')) {
      bus.emit('available', msg);
    } else if (topic.startsWith('campus/resource/reserved/')) {
      bus.emit('reserved', msg);
    } else if (topic.startsWith('campus/signal/')) {
      bus.emit('signal', msg);
    }
  });

  return bus;
}

module.exports = {
  bus, connect, connected,
  announceAvailable, announceReserved, publishSignal,
  TOPIC
};
