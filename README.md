# Campus Mesh

A distributed campus resource discovery and sharing network.
Distributed Systems mini project (FA-1 and FA-2).

Three autonomous department nodes each own an inventory of shareable physical
resources. A student searches from their own node; that node checks itself,
asks every peer in parallel over gRPC, and returns one aggregated list. The
student never names a node and cannot tell a local hit from a remote one.

## Status

| Phase | What it adds | State |
|-------|--------------|-------|
| 1 | Single node, store, REST API, UI | done |
| 2 | gRPC service + parallel fan-out search | done |
| 3 | Docker, three containers from one image | done |
| 4 | MQTT availability announcements + wantlist | done |
| 5 | Heartbeat, peer state, staged failure | done |
| 6 | WebRTC data channel for handover | done |
| 7 | WebRTC media stream + QoS panel | done (media path needs a browser test) |
| 8 | Lamport space-time diagram, report | partial (clock is in) |

## Run it

Install once:

    npm install

### With Docker (use this for the demo)

    docker compose up --build

Then open http://localhost:5001 (Computer Science), :5002 (Library),
:5003 (Electronics). Follow the logs with `docker compose logs -f`.

### Without Docker (faster to iterate)

    npm run dev

Forks all three nodes into one terminal. Same ports.

## Try it

1. Open http://localhost:5002 (Library) and search `arduino`.
   The Library owns none - the result comes from Electronics.
2. Watch the terminal: `RPC OUT` on node-lib, `RPC IN` on the other two,
   then `RPC OK  3/3 nodes responded in Nms`.
3. Search `vr headset`. Nothing on the mesh - a clean miss, which is what
   Phase 4's "notify me" wantlist will hang off.
4. Search `hdmi`. Two nodes own one; available items sort first, and this
   node's own items sort before remote ones.
5. Request an item. The reservation is decided by the node that OWNS it,
   routed by the owner encoded in the resource identifier.

## Architecture

Hybrid, deliberately:

- **Client-server** between a browser and its home node (HTTP/REST)
- **Structured P2P overlay** between nodes (gRPC - every node both serves
  and consumes the same service; there is no coordinator)
- **Publish-subscribe** for availability announcements (Phase 4, MQTT)
- **Layered** inside each node: UI -> HTTP -> middleware -> store

### Names, identifiers, addresses

    NODE_NAME   "Electronics Lab"       name       human facing, may change
    NODE_ID     node-ee                 identifier unique, never reused
    PEERS       node-ee:50051           address    where it lives, may move

Resources follow the same scheme: `node-ee:cable:0001`. The owner is encoded
in the identifier, which is how a reservation is routed to the only node
allowed to decide it.

### Why four communication mechanisms

| Channel | Used for | Sync | Coupling |
|---------|----------|------|----------|
| gRPC | Search, Reserve, Ping | synchronous | caller knows callee |
| MQTT | availability announcements | asynchronous | publisher knows nobody |
| WebRTC data | handover coordination | async, bidirectional | direct peer link |
| WebRTC media | live item verification | continuous stream | direct peer link |

## Layout

    proto/resource.proto     the published interface - a 4th node needs only this
    src/config.js            identity and peers, entirely from the environment
    src/clock.js             Lamport logical clock
    src/log.js               per-node coloured, clock-stamped logging
    src/store.js             this node's own resource table (emits events)
    src/match.js             one matcher shared by search and the wantlist
    src/mq/bus.js            MQTT publish + subscribe
    src/wantlist.js          standing requests parked on this node
    src/notifications.js     what this node's students were told
    src/http/events.js       SSE push channel to the browsers
    public/rtc.js            the handover channel: signalling, data, media
    src/rpc/proto.js         shared proto loader
    src/rpc/server.js        implements ResourceNode
    src/rpc/peers.js         peer stubs + the parallel fan-out
    src/http/api.js          the REST surface the browser uses
    public/                  the UI
    data/seed.<node>.json    each node's starting inventory

## FA-2 hooks already in place

- Every gRPC message carries a `lamport` value.
- Every resource carries unused `version`, `lockedBy` and `lockExpiry` fields
  (optimistic concurrency and lease-based locking, no schema change needed).
- All reservation logic sits behind `store.reserve()` - swapping it for
  two-phase commit or a consensus round touches one function.

Known limitation, and the FA-2 entry point: two simultaneous requests for the
same item are serialised by the single owning node. That single point of
serialisation is what distributed locking replaces.

## Verify the build

    npm run verify

Boots the broker and all three nodes, runs 71 checks over the live mesh,
kills a node to prove both partial results and heartbeat detection, restarts
it to prove recovery, then tears everything down. Exit code 0 means
everything works. Re-run it after every phase.

To verify while a demo mesh is already running, shift the ports:

    OFFSET=20 npm run verify

The checks are grouped by the concept they prove, so a failure tells you
which distributed-systems property broke - not just which line threw.

Without an OFFSET nothing may be listening on 5001-5003, 50051-50053 or
1883, so stop any `npm run dev` or `docker compose` first.

## Phase 4 - message-oriented communication

    campus/resource/available/<category>    published when an item is returned
    campus/resource/reserved/<category>     published when one is taken

The broker in `broker/` is deliberately dumb - it knows nothing about
resources or nodes and only forwards by topic.

Why this cannot be done with RPC: a student who searches and finds nothing
has nowhere to send a request. Their need is parked in this node's wantlist,
and an announcement from *any* node wakes it up. Over RPC this node would
have to poll every peer forever.

`store.js` emits `reserved` / `released` events instead of publishing
directly, so both the local HTTP path and an inbound RPC from another node
announce a change without either knowing the other exists. `src/index.js` is
the only place those layers are wired together.

Own announcements are deliberately *not* filtered out. A different student on
the same node may be waiting for exactly that item, and a publisher has no
idea who is listening - which is the whole point of decoupling.

### Try it

1. On http://localhost:5002 search `arduino`, then click **Notify me**.
   It appears under "You are watching".
2. On http://localhost:5003 find Arduino UNO R3 and click **Return**.
3. The Library browser toasts within a second and the announcement lands
   under "Waiting for you". Nobody asked node-ee anything.

## Phase 5 - fault tolerance

Three mechanisms, layered:

1. **Deadlines** - every RPC carries a 2s budget, so a dead peer costs one
   deadline rather than hanging the search.
2. **Heartbeat** - `Ping` every 3s; three consecutive misses marks a peer
   DOWN, one success restores it. Liveness is tested on the *same channel* a
   search uses, deliberately: a peer that cannot answer Ping cannot answer
   Search either. One missed beat is noise (a GC pause), three is a failure.
3. **Honest partial results** - the search reply carries `responded` and
   `total`, and the UI says "2 of 3 nodes responded" whenever they differ.

Peer state is pushed to browsers over SSE, so the status dots move without
anybody refreshing or searching.

### The staged moment

    docker stop node-ee

The Electronics dot goes red within ~9s with nobody touching the UI. Search
again: results still come back from two nodes with the honest count. Then

    docker start node-ee

and the dot goes green on its own, with the peer's name and inventory size
re-learned from `Ping` rather than from config.

## Phase 6 - peer-to-peer handover

The two students are attached to *different* nodes, so the offer, answer and
ICE candidates have to cross the network before a peer connection can exist.
Rather than invent a channel for that, the existing message bus carries them:

    campus/signal/<room>

Each browser POSTs to `/api/signal` on its **own** node; that node publishes,
every node receives, and each pushes it to whichever of its browsers are in
that room. The nodes never interpret the payload - they are an opaque relay.
Signalling is just messaging.

Room ids come from the reservation itself (`room-<rid>-v<version>`), so both
sides derive the same room without negotiating one.

### Role asymmetry, and why

The **owner is always the offerer**. The owner is the one who later switches
on a camera, and adding a track fires `negotiationneeded` on whoever holds it.
Keeping every offer on one side means renegotiation can never collide with an
offer travelling the other way, so there is no glare to resolve.

Each side re-announces `hello` every 2s until connected, because neither can
know whether the other has opened their panel yet.

### The proof that it is really peer-to-peer

Verified by driving two browsers against two different nodes:

1. Both browsers reach `connectionState: connected` on **one** candidate pair,
   with mirrored byte counters (2331 sent one side = 2331 received the other).
2. Text flows both ways.
3. **Both node processes and the broker were then killed.** `fetch('/api/node')`
   fails on both browsers - and a message sent after that still arrives, with
   the byte counters still climbing.

Step 3 is the demo moment. Nothing but a direct browser-to-browser link can
behave that way.

## Phase 7 - stream-oriented communication

The owner clicks **Show the item** and their camera feed goes to the
requester, so nobody walks across campus for a frayed cable.

A working video feed on its own is just a webcam demo. What makes it
*stream-oriented* is that the data has deadlines the network may miss, so the
QoS panel reports `getStats()` live: fps, jitter, packets lost, frames
dropped, bitrate.

### What to say while the numbers move

Open DevTools -> Network -> throttle to Slow 3G. Resolution drops, frame rate
falls, jitter climbs, and the picture keeps moving. Then:

> "An RPC reply that arrives late is still correct. A video frame that
> arrives late is worthless - so the stream drops it rather than delaying the
> ones behind it. That trade-off is the whole difference between discrete and
> continuous communication, and you can watch it happening in these numbers."

### Still to test yourself

The media path is the one thing not verified here, because it needs a real
camera permission grant. Two browser windows on one machine is enough:

1. `npm run dev`, open http://localhost:5002 and http://localhost:5003.
2. On :5002 search `arduino` and click **Request**. The handover panel opens.
3. On :5003 click **Open handover** on the invitation banner.
4. Both should say "peer-to-peer channel open". Send a message each way.
5. On :5003 click **Show the item** and grant camera access. Video appears
   on :5002 and the QoS panel starts reporting.

`Handover.debug()` in the browser console prints connection state, channel
state and the live candidate-pair byte counters.

### Secure-context warning

`getUserMedia` needs a secure context. `http://localhost` counts as one; a LAN
IP over plain http does **not**, and the camera fails exactly there. So demo
WebRTC either on one machine with two windows, or serve over https with a
self-signed certificate. Decide which, and test it, at least two days before
the evaluation.

### No TURN server

Only STUN is configured, so this works on one machine and on a normal LAN. A
network that blocks peer-to-peer traffic would need a TURN relay - out of
scope, and worth saying out loud rather than being caught by it.
