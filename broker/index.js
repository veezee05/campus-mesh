// A standalone MQTT broker for the mesh.
//
// The broker is deliberately dumb: it knows nothing about resources, students
// or nodes. It only forwards messages from publishers to whoever subscribed to
// a matching topic. That ignorance is the point - publishers and subscribers
// are decoupled in time, space and identity.
//
// ESM with top-level await, because aedes v1 ships as an ES module and is
// built by an async factory rather than a constructor.

import net from 'node:net';
import { Aedes } from 'aedes';

const PORT = Number(process.env.MQTT_PORT || 1883);
const TAG = '\x1b[31m[broker   ]\x1b[0m';

const broker = await Aedes.createBroker();
const server = net.createServer(broker.handle);

server.listen(PORT, () => {
  console.log(`${TAG} BOOT    MQTT broker listening on ${PORT}`);
});

broker.on('client', (c) => {
  console.log(`${TAG} CONN    ${c.id} subscribed to the mesh`);
});

broker.on('clientDisconnect', (c) => {
  console.log(`${TAG} GONE    ${c.id} disconnected`);
});

broker.on('publish', (packet, client) => {
  if (!client) return; // the broker's own $SYS keepalives
  console.log(`${TAG} FWD     ${packet.topic}  (from ${client.id})`);
});

broker.on('clientError', (client, err) => {
  console.log(`${TAG} ERR     ${client.id}: ${err.message}`);
});
