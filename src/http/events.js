'use strict';

// Server-Sent Events: the push channel from a node to the browsers attached
// to it. Deliberately not WebSockets - nothing here needs to travel upstream,
// and SSE reconnects on its own.

const clients = new Set();

function handler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 2000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

function broadcast(type, data) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

function count() {
  return clients.size;
}

module.exports = { handler, broadcast, count };
