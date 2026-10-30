'use strict';

// A node knows nothing about itself except what the environment tells it.
// This is what lets one image become three nodes, and it is the clearest
// demonstration of names vs identifiers vs addresses:
//
//   NODE_NAME  "Electronics Lab"   a NAME      - human facing, may change
//   NODE_ID    node-ee             an IDENTIFIER - unique, never reused
//   PEERS      node-ee:50051       an ADDRESS  - where it lives, may move

// A peer is written either as "node-ee:50051", where the hostname doubles as
// the identifier, or as "node-ee@localhost:50053" when identity and address
// have to be stated separately - which is exactly the case when all three
// nodes share one host during local development. The identifier is what the
// system routes on; the address is only how it gets there.
function parsePeers(raw) {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, address] = entry.includes('@')
        ? entry.split('@')
        : [entry.split(':')[0], entry];
      return {
        id,
        address,          // resolved by DNS at call time, not at boot
        state: 'UNKNOWN', // phase 5 (heartbeat) maintains this
        misses: 0
      };
    });
}

module.exports = {
  NODE_ID:   process.env.NODE_ID   || 'node-dev',
  NODE_NAME: process.env.NODE_NAME || 'Development Node',
  GRPC_PORT: Number(process.env.GRPC_PORT || 50051),
  HTTP_PORT: Number(process.env.HTTP_PORT || 5000),
  PEERS:     parsePeers(process.env.PEERS),
  RPC_DEADLINE_MS: Number(process.env.RPC_DEADLINE_MS || 2000),
  MQTT_URL:  process.env.MQTT_URL || '',
  HEARTBEAT_MS: Number(process.env.HEARTBEAT_MS || 3000),
  MISSES_TO_DOWN: Number(process.env.MISSES_TO_DOWN || 3)
};
