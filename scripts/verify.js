'use strict';

// Verifies everything built so far (phases 1-5) end to end.
//
//   npm run verify              on the standard ports
//   OFFSET=20 npm run verify    shifted, to run alongside a live demo mesh
//
// Boots a broker and all three nodes, exercises the mesh over HTTP, kills a
// node to prove partial results and heartbeat detection, restarts it to prove
// recovery, then tears everything down. Exit code 0 means every check passed.

const { fork } = require('child_process');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'index.js');
const BROKER = path.join(ROOT, 'broker', 'index.js');

const OFFSET = Number(process.env.OFFSET || 0);
const MQTT_PORT = 1883 + OFFSET;
const MQTT_URL = `mqtt://localhost:${MQTT_PORT}`;
const p = (base) => String(base + OFFSET);

const HEARTBEAT_MS = '600'; // faster than the 3s default so the suite is quick
const MISSES_TO_DOWN = '3';

const NODE_ENV_BASE = { MQTT_URL, HEARTBEAT_MS, MISSES_TO_DOWN };

const NODES = {
  cs:  { NODE_ID: 'node-cs',  NODE_NAME: 'Computer Science Lab', GRPC_PORT: p(50051), HTTP_PORT: p(5001), PEERS: `node-lib@localhost:${p(50052)},node-ee@localhost:${p(50053)}`, ...NODE_ENV_BASE },
  lib: { NODE_ID: 'node-lib', NODE_NAME: 'Central Library',      GRPC_PORT: p(50052), HTTP_PORT: p(5002), PEERS: `node-cs@localhost:${p(50051)},node-ee@localhost:${p(50053)}`, ...NODE_ENV_BASE },
  ee:  { NODE_ID: 'node-ee',  NODE_NAME: 'Electronics Lab',      GRPC_PORT: p(50053), HTTP_PORT: p(5003), PEERS: `node-cs@localhost:${p(50051)},node-lib@localhost:${p(50052)}`, ...NODE_ENV_BASE }
};

const CS = `http://localhost:${p(5001)}`;
const LIB = `http://localhost:${p(5002)}`;
const EE = `http://localhost:${p(5003)}`;

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ${GREEN}PASS${RESET}  ${name}`);
  } else {
    failed++;
    console.log(`  ${RED}FAIL${RESET}  ${name}`);
    if (detail !== undefined) console.log(`        ${DIM}got: ${JSON.stringify(detail)}${RESET}`);
  }
}

function section(title) {
  console.log(`\n${BOLD}${title}${RESET}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

async function waitForNode(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await get(url + '/api/node');
      if (r.status === 200) return r.body;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error(`${url} did not become ready within ${timeoutMs}ms`);
}

// Poll a condition instead of sleeping a guessed duration, so the suite is
// neither flaky nor slower than it has to be.
async function waitUntil(label, fn, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

// Reads the node's SSE push channel and collects named events, so the parts
// of phases 4-6 that only exist as pushes can be asserted without a browser.
function openEventStream(url) {
  const collected = [];
  const controller = new AbortController();

  const ready = fetch(url + '/api/events', { signal: controller.signal }).then((res) => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let split;
          while ((split = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const type = /^event: (.+)$/m.exec(frame);
            const data = /^data: (.+)$/m.exec(frame);
            if (type && data) {
              try {
                collected.push({ type: type[1], data: JSON.parse(data[1]) });
              } catch {
                /* ignore a partial frame */
              }
            }
          }
        }
      } catch {
        /* aborted */
      }
    })();
  });

  return {
    ready,
    events: collected,
    find: (type, predicate) =>
      collected.find((e) => e.type === type && (!predicate || predicate(e.data))),
    close: () => controller.abort()
  };
}

const children = [];

function spawnNode(key) {
  const c = fork(ENTRY, {
    env: { ...process.env, ...NODES[key] },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc']
  });
  children.push(c);
  return c;
}

function stopAll() {
  children.forEach((c) => {
    try {
      c.kill();
    } catch {
      /* already gone */
    }
  });
}

async function main() {
  console.log(`${BOLD}Campus Mesh - build verification${RESET}${OFFSET ? DIM + `  (port offset +${OFFSET})` + RESET : ''}`);

  section('0  ports are free');
  const ports = [5001, 5002, 5003, 50051, 50052, 50053].map((x) => x + OFFSET).concat(MQTT_PORT);
  for (const port of ports) {
    check(`port ${port} available`, await portFree(port));
  }
  if (failed) {
    console.log(`\n${RED}Something is already using these ports.${RESET}`);
    console.log(`Stop your running mesh, or run alongside it with:  ${BOLD}OFFSET=20 npm run verify${RESET}`);
    process.exit(1);
  }

  process.on('SIGINT', () => { stopAll(); process.exit(130); });

  try {
    children.push(fork(BROKER, { env: { ...process.env, MQTT_PORT: String(MQTT_PORT) }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
    await sleep(500);
    let ee = spawnNode('ee');
    spawnNode('cs');
    spawnNode('lib');

    section('1  all three nodes boot and report their identity');
    const ids = await Promise.all([waitForNode(CS), waitForNode(LIB), waitForNode(EE)]);
    check('node-cs identity', ids[0].node_id === 'node-cs', ids[0].node_id);
    check('node-lib identity', ids[1].node_id === 'node-lib', ids[1].node_id);
    check('node-ee identity', ids[2].node_id === 'node-ee', ids[2].node_id);
    check('each node knows exactly two peers',
      ids.every((n) => n.peers.filter((x) => !x.self).length === 2),
      ids.map((n) => n.peers.length));

    section('2  local inventories loaded independently');
    const inv = await Promise.all([get(CS + '/api/resources'), get(LIB + '/api/resources'), get(EE + '/api/resources')]);
    check('node-cs owns 7 resources', inv[0].body.items.length === 7, inv[0].body.items.length);
    check('node-lib owns 7 resources', inv[1].body.items.length === 7, inv[1].body.items.length);
    check('node-ee owns 8 resources', inv[2].body.items.length === 8, inv[2].body.items.length);
    check('every rid is prefixed with its owning node',
      inv.every((r) => r.body.items.every((i) => i.rid.startsWith(r.body.node_id))));

    section('3  remote hit - searching from a node that owns nothing matching');
    const arduino = await post(LIB + '/api/search', { query: 'arduino' });
    check('exactly one match', arduino.body.matches.length === 1, arduino.body.matches.length);
    check('match is owned by node-ee', arduino.body.matches[0]?.node_id === 'node-ee', arduino.body.matches[0]);
    check('all 3 nodes responded', arduino.body.responded === 3 && arduino.body.total === 3, arduino.body);
    check('latency bounded by the slowest peer, not the sum', arduino.body.latencyMs < 1000, arduino.body.latencyMs);

    section('4  aggregation across several nodes');
    const hdmi = await post(CS + '/api/search', { query: 'hdmi' });
    const owners = new Set(hdmi.body.matches.map((m) => m.node_id));
    check('3 matches found', hdmi.body.matches.length === 3, hdmi.body.matches.length);
    check('results span 2 different nodes', owners.size === 2, [...owners]);
    check('available items sort first', hdmi.body.matches[0]?.status === 'available', hdmi.body.matches[0]);
    check('one flat uniform list - local is indistinguishable from remote',
      hdmi.body.matches.every((m) => 'node_id' in m && 'status' in m && !('local' in m)));

    section('5  clean miss - nothing on the mesh');
    const vr = await post(EE + '/api/search', { query: 'vr headset' });
    check('zero matches, no error', vr.body.matches.length === 0, vr.body);
    check('still 3 of 3 responded', vr.body.responded === 3, vr.body.responded);

    section('6  reservation is decided by the OWNING node');
    const remote = await post(LIB + '/api/reserve', { rid: 'node-ee:board:0001', requester: 'roll-4210', hours: 2 });
    check('granted', remote.body.granted === true, remote.body);
    check('decided by node-ee, not by the node that asked', remote.body.decided_by === 'node-ee', remote.body.decided_by);
    check('version incremented 1 -> 2', remote.body.version === 2, remote.body.version);
    check('handover room issued for phase 6', remote.body.handover_room === 'room-node-ee-board-0001-v2', remote.body.handover_room);

    section('7  double booking is refused');
    const dupe = await post(CS + '/api/reserve', { rid: 'node-ee:board:0001', requester: 'roll-9999', hours: 2 });
    check('refused', dupe.body.granted === false, dupe.body);
    check('reason states current status', /already reserved/.test(dupe.body.reason || ''), dupe.body.reason);
    check('still decided by the owner', dupe.body.decided_by === 'node-ee', dupe.body.decided_by);

    section('8  local reservation needs no RPC');
    const local = await post(CS + '/api/reserve', { rid: 'node-cs:calculator:0001', requester: 'roll-4210', hours: 1 });
    check('granted', local.body.granted === true, local.body);
    check('decided by node-cs itself', local.body.decided_by === 'node-cs', local.body.decided_by);

    section('9  release, and only by the owner');
    const rel = await post(CS + '/api/release', { rid: 'node-cs:calculator:0001' });
    check('owner can release', rel.body.ok === true, rel.body);
    check('status back to available', rel.body.resource?.status === 'available', rel.body.resource?.status);
    const badRel = await post(CS + '/api/release', { rid: 'node-ee:cable:0001' });
    check('non-owner is refused with 403', badRel.status === 403, badRel.status);

    section('10  phase 4 - every node connected to the broker');
    const mqStates = await Promise.all([get(CS + '/api/node'), get(LIB + '/api/node'), get(EE + '/api/node')]);
    check('all three report an MQTT connection', mqStates.every((r) => r.body.mqtt === true), mqStates.map((r) => r.body.mqtt));

    section('11  phase 4 - a standing request is satisfied by another node');
    // A student at the Library wants an Arduino. It exists, but node-ee has it
    // reserved from check 6, so request/reply can offer nothing more.
    const want = await post(LIB + '/api/wantlist', { query: 'arduino', requester: 'roll-7788' });
    check('wantlist entry parked on node-lib', Boolean(want.body.id), want.body);
    const parked = await get(LIB + '/api/wantlist');
    check('one standing request listed', parked.body.entries.length === 1, parked.body.entries.length);

    // Electronics returns it. node-ee publishes; node-lib was never asked.
    const returned = await post(EE + '/api/release', { rid: 'node-ee:board:0001' });
    check('node-ee released its own item', returned.body.ok === true, returned.body);

    const landed = await waitUntil('node-lib to be notified via MQTT', async () => {
      const n = await get(LIB + '/api/notifications');
      return n.body.items.length ? n.body.items[0] : false;
    });
    check('node-lib was notified without ever asking', landed.kind === 'available', landed);
    check('notification names the announcing node', landed.node_id === 'node-ee', landed.node_id);
    check('notification is attributed to the right student', landed.requester === 'roll-7788', landed.requester);
    check('notification carries the sender\'s Lamport value', Number(landed.lamport) > 0, landed.lamport);

    const drained = await get(LIB + '/api/wantlist');
    check('satisfied request stops watching', drained.body.entries.length === 0, drained.body.entries.length);

    section('12  phase 5 - heartbeat detects a dead node with nobody searching');
    ee.kill();
    const down = await waitUntil('node-ee to be marked DOWN', async () => {
      const r = await get(CS + '/api/node');
      const peer = r.body.peers.find((x) => x.id === 'node-ee');
      return peer && peer.state === 'DOWN' ? peer : false;
    });
    check('node-ee marked DOWN by the heartbeat alone', down.state === 'DOWN', down);
    check('only after repeated misses, not one', down.misses >= 3, down.misses);
    const stillUp = await get(CS + '/api/node');
    check('node-lib still marked UP', stillUp.body.peers.find((x) => x.id === 'node-lib')?.state === 'UP');

    section('13  phase 5 - the mesh degrades honestly');
    const degraded = await post(CS + '/api/search', { query: 'hdmi' });
    check('search still succeeds', degraded.status === 200, degraded.status);
    check('reports 2 of 3 nodes responded', degraded.body.responded === 2 && degraded.body.total === 3, degraded.body);
    check('surviving node\'s result is still returned', degraded.body.matches.some((m) => m.node_id === 'node-lib'));
    check('no results attributed to the dead node', !degraded.body.matches.some((m) => m.node_id === 'node-ee'));

    const orphan = await post(CS + '/api/reserve', { rid: 'node-ee:cable:0001', requester: 'roll-4210', hours: 2 });
    check('reserving from a dead owner fails cleanly with 503', orphan.status === 503, orphan.status);
    check('error names the unreachable node', /node-ee unreachable/.test(orphan.body.error || ''), orphan.body.error);

    section('14  phase 5 - a returning node rejoins on its own');
    ee = spawnNode('ee');
    await waitForNode(EE);
    const back = await waitUntil('node-ee to be marked UP again', async () => {
      const r = await get(CS + '/api/node');
      const peer = r.body.peers.find((x) => x.id === 'node-ee');
      return peer && peer.state === 'UP' ? peer : false;
    });
    check('node-ee marked UP again with no restart of its peers', back.state === 'UP', back);
    check('peer name learned from Ping, not from config', back.name === 'Electronics Lab', back.name);
    check('peer inventory size learned from Ping', back.resourceCount === 8, back.resourceCount);

    const healed = await post(CS + '/api/search', { query: 'hdmi' });
    check('full mesh answers again', healed.body.responded === 3, healed.body.responded);
    check('the rejoined node\'s items are back in results', healed.body.matches.some((m) => m.node_id === 'node-ee'));

    section('15  phase 6 - handover invitation reaches the owning node');
    // The owner's own node is the one that must invite them, because it is
    // the node that granted the reservation. Listen on node-ee, then reserve
    // one of its items from a DIFFERENT node.
    const eeStream = openEventStream(EE);
    await eeStream.ready;
    await sleep(300);

    const handoverRes = await post(LIB + '/api/reserve', { rid: 'node-ee:analyzer:0001', requester: 'roll-5150', hours: 2 });
    check('reservation granted', handoverRes.body.granted === true, handoverRes.body);

    const invite = await waitUntil('a handover invitation on node-ee', () =>
      eeStream.find('handover', (d) => d.rid === 'node-ee:analyzer:0001'));
    check('node-ee invited its own student to hand over', invite.data.role === 'owner', invite.data);
    check('invitation names the collecting student', invite.data.holder === 'roll-5150', invite.data.holder);
    check('invitation room matches the room the requester was given',
      invite.data.room === handoverRes.body.handover_room,
      [invite.data.room, handoverRes.body.handover_room]);

    section('16  phase 6 - signalling crosses the mesh between two nodes');
    // The two students are on different nodes, so an offer posted to one node
    // must reach a browser attached to another. This is the relay that makes
    // a cross-node peer connection possible at all.
    const room = handoverRes.body.handover_room;
    const csStream = openEventStream(CS);
    await csStream.ready;
    await sleep(300);

    const posted = await post(EE + '/api/signal', {
      room,
      kind: 'offer',
      from: 'peer-owner-test',
      payload: { type: 'offer', sdp: 'v=0\r\no=- test\r\n' }
    });
    check('node-ee accepted the signalling message', posted.body.ok === true, posted.body);

    const relayed = await waitUntil('the offer to arrive on node-cs', () =>
      csStream.find('signal', (d) => d.room === room && d.kind === 'offer'));
    check('an offer posted to node-ee reached a browser on node-cs', Boolean(relayed), relayed && relayed.data);
    check('relayed payload is untouched by the nodes',
      relayed.data.payload?.sdp === 'v=0\r\no=- test\r\n',
      relayed.data.payload);
    check('relay records which node published it', relayed.data.node_id === 'node-ee', relayed.data.node_id);
    check('relay carries a Lamport value', Number(relayed.data.lamport) > 0, relayed.data.lamport);

    // ICE candidates take the same path.
    await post(CS + '/api/signal', { room, kind: 'ice', from: 'peer-req-test', payload: { candidate: 'candidate:1 1 udp', sdpMid: '0' } });
    const ice = await waitUntil('an ICE candidate to be relayed back', () =>
      eeStream.find('signal', (d) => d.room === room && d.kind === 'ice'));
    check('ICE candidates relay in the other direction too', Boolean(ice), ice && ice.data);

    csStream.close();
    eeStream.close();

    section('17  Lamport clock advanced with causal events');
    const finalNode = await get(CS + '/api/node');
    check('clock is well past zero', finalNode.body.lamport > 10, finalNode.body.lamport);
  } catch (err) {
    failed++;
    console.log(`\n${RED}Verification aborted: ${err.message}${RESET}`);
  } finally {
    stopAll();
    await sleep(300);
  }

  const total = passed + failed;
  console.log(
    `\n${BOLD}${failed === 0 ? GREEN + 'ALL CHECKS PASSED' : RED + 'FAILURES'}${RESET}  ${passed}/${total} checks passed\n`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main();
