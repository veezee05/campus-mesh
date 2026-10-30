'use strict';

const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

// One loader shared by the server and the peer stubs, so both sides are
// provably generated from the same interface definition.
const definition = protoLoader.loadSync(
  path.join(__dirname, '..', '..', 'proto', 'resource.proto'),
  { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true }
);

module.exports = {
  grpc,
  campus: grpc.loadPackageDefinition(definition).campus
};
