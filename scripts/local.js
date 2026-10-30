'use strict';

// Runs the broker and all three nodes on this machine without Docker, for
// fast iteration. Unlike the container setup the gRPC ports must differ here,
// because all four processes share one host network namespace.
//
// For the actual demo use `docker compose up --build` - separate hostnames and
// `docker stop` make the fault-tolerance story far more convincing.

const { fork } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'index.js');
const BROKER = path.join(ROOT, 'broker', 'index.js');

const OFFSET = Number(process.env.OFFSET || 0);
const MQTT_PORT = 1883 + OFFSET;
const MQTT_URL = `mqtt://localhost:${MQTT_PORT}`;

const p = (base) => String(base + OFFSET);

const NODES = [
  { NODE_ID: 'node-cs',  NODE_NAME: 'Computer Science Lab', GRPC_PORT: p(50051), HTTP_PORT: p(5001), PEERS: `node-lib@localhost:${p(50052)},node-ee@localhost:${p(50053)}`, MQTT_URL },
  { NODE_ID: 'node-lib', NODE_NAME: 'Central Library',      GRPC_PORT: p(50052), HTTP_PORT: p(5002), PEERS: `node-cs@localhost:${p(50051)},node-ee@localhost:${p(50053)}`, MQTT_URL },
  { NODE_ID: 'node-ee',  NODE_NAME: 'Electronics Lab',      GRPC_PORT: p(50053), HTTP_PORT: p(5003), PEERS: `node-cs@localhost:${p(50051)},node-lib@localhost:${p(50052)}`, MQTT_URL }
];

const children = [];

children.push(
  fork(BROKER, { env: { ...process.env, MQTT_PORT: String(MQTT_PORT) }, stdio: 'inherit' })
);

// Give the broker a moment so the nodes' first connect attempt succeeds.
// They reconnect on their own anyway - this only keeps the logs clean.
setTimeout(() => {
  NODES.forEach((env) =>
    children.push(fork(ENTRY, { env: { ...process.env, ...env }, stdio: 'inherit' }))
  );
}, 400);

function shutdown() {
  children.forEach((c) => {
    try {
      c.kill();
    } catch {
      /* already gone */
    }
  });
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
