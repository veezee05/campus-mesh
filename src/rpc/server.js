'use strict';

const { grpc, campus } = require('./proto');
const { NODE_ID, NODE_NAME, GRPC_PORT } = require('../config');
const clock = require('../clock');
const log = require('../log');
const store = require('../store');

// --- service implementation -------------------------------------------------

function Search(call, cb) {
  clock.receive(call.request.lamport); // causal update on receive
  const matches = store.find(call.request.query).map(store.decorate);
  log.rpcIn(
    `Search("${call.request.query}") from ${call.request.origin_id} -> ${matches.length} hit(s)`
  );
  cb(null, { node_id: NODE_ID, lamport: clock.tick(), matches });
}

function Reserve(call, cb) {
  clock.receive(call.request.lamport);
  const { rid, requester, hours } = call.request;
  const result = store.reserve({ rid, requester, hours });
  log.rpcIn(
    `Reserve(${rid}) by ${requester} -> ${result.granted ? 'GRANTED' : 'REFUSED (' + result.reason + ')'}`
  );
  cb(null, {
    granted: result.granted,
    reason: result.reason,
    handover_room: result.handover_room || '',
    version: result.version || 0,
    lamport: clock.tick()
  });
}

function Ping(call, cb) {
  clock.receive(call.request.lamport);
  cb(null, {
    node_id: NODE_ID,
    node_name: NODE_NAME,
    resource_count: store.count(),
    lamport: clock.tick()
  });
}

// --- boot -------------------------------------------------------------------

function start() {
  return new Promise((resolve, reject) => {
    const server = new grpc.Server();
    server.addService(campus.ResourceNode.service, { Search, Reserve, Ping });
    server.bindAsync(
      `0.0.0.0:${GRPC_PORT}`,
      grpc.ServerCredentials.createInsecure(),
      (err, port) => {
        if (err) return reject(err);
        log.boot(`gRPC ResourceNode serving on 0.0.0.0:${port}`);
        resolve(server);
      }
    );
  });
}

module.exports = { start };
