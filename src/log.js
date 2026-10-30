'use strict';

const { NODE_ID } = require('./config');
const clock = require('./clock');

// The examiner watches the terminals more than the UI. Fixed-width fields,
// one colour per node, Lamport value always in the same column.
const COLOURS = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m', '\x1b[34m'];
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';

const colour = COLOURS[
  [...NODE_ID].reduce((a, c) => a + c.charCodeAt(0), 0) % COLOURS.length
];

function line(tag, message) {
  const id = NODE_ID.padEnd(9);
  const l = `L=${String(clock.value).padEnd(4)}`;
  console.log(`${colour}[${id}]${RESET} ${DIM}${l}${RESET} ${tag.padEnd(7)} ${message}`);
}

module.exports = {
  boot:   (m) => line('BOOT', m),
  rpcOut: (m) => line('RPC OUT', m),
  rpcIn:  (m) => line('RPC IN', m),
  rpcOk:  (m) => line('RPC OK', m),
  http:   (m) => line('HTTP', m),
  mqOut:  (m) => line('MQ OUT', m),
  mqIn:   (m) => line('MQ IN', m),
  warn:   (m) => line('WARN', `${RED}${m}${RESET}`),
  ok:     (m) => line('OK', `${GREEN}${m}${RESET}`)
};
