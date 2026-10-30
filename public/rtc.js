'use strict';

// Phase 6 + 7: the handover channel.
//
// Signalling (offer / answer / ICE) travels over each student's own node and
// across the mesh by MQTT. Once the peer connection is up, text and video flow
// BROWSER TO BROWSER with no node in the path - which you can prove by
// stopping both node containers while the chat keeps working.
//
// Role asymmetry is deliberate: the OWNER is always the offerer. The owner is
// the one who later switches on a camera, and adding a track fires
// negotiationneeded on whoever holds it. Keeping all offers on one side means
// that renegotiation can never collide with an offer coming the other way.

const Handover = (() => {
  const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

  // Identifies this browser tab, so it can ignore the echo of its own
  // signalling messages coming back off the bus.
  const myId = (() => {
    let id = sessionStorage.getItem('campus-mesh:peer');
    if (!id) {
      id = 'peer-' + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem('campus-mesh:peer', id);
    }
    return id;
  })();

  let pc = null;
  let chan = null;
  let room = null;
  let role = null; // 'owner' | 'requester'
  let localStream = null;
  let statsTimer = null;
  let helloTimer = null;
  let lastBytes = 0;
  let lastAt = 0;

  const ui = {};

  function bind() {
    ui.panel = document.getElementById('handoverPanel');
    ui.title = document.getElementById('handoverTitle');
    ui.state = document.getElementById('handoverState');
    ui.log = document.getElementById('chatLog');
    ui.form = document.getElementById('chatForm');
    ui.input = document.getElementById('chatInput');
    ui.video = document.getElementById('remoteVideo');
    ui.selfVideo = document.getElementById('selfVideo');
    ui.camBtn = document.getElementById('camBtn');
    ui.stats = document.getElementById('qos');
    ui.close = document.getElementById('handoverClose');

    ui.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = ui.input.value.trim();
      if (!text || !chan || chan.readyState !== 'open') return;
      chan.send(text);
      append('you', text);
      ui.input.value = '';
    });

    ui.camBtn.addEventListener('click', toggleCamera);
    ui.close.addEventListener('click', hangup);
  }

  function setState(text, kind) {
    ui.state.textContent = text;
    ui.state.className = 'hstate' + (kind ? ' ' + kind : '');
  }

  function append(sender, text) {
    const li = document.createElement('li');
    li.className = 'chat ' + sender;
    li.innerHTML = '<span class="chat-who">' + (sender === 'you' ? 'you' : 'them') +
      '</span><span class="chat-text"></span>';
    li.querySelector('.chat-text').textContent = text;
    ui.log.appendChild(li);
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function note(text) {
    const li = document.createElement('li');
    li.className = 'chat note';
    li.textContent = text;
    ui.log.appendChild(li);
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  // --- signalling transport -------------------------------------------------

  async function send(kind, payload) {
    try {
      await fetch('/api/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room, kind, from: myId, payload })
      });
    } catch (err) {
      setState('signalling failed: ' + err.message, 'bad');
    }
  }

  // Called by app.js for every 'signal' event pushed down the SSE channel.
  async function onSignal(msg) {
    if (!pc || msg.room !== room || msg.from === myId) return;

    try {
      if (msg.kind === 'hello') {
        note('the other student is here');
        // Only the owner ever offers.
        if (role === 'owner') await offer();
        return;
      }

      if (msg.kind === 'offer') {
        await pc.setRemoteDescription(msg.payload);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await send('answer', pc.localDescription);
        return;
      }

      if (msg.kind === 'answer') {
        // A late answer for an offer we have already superseded is harmless
        // to ignore; setRemoteDescription would throw on a stale state.
        if (pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription(msg.payload);
        return;
      }

      if (msg.kind === 'ice' && msg.payload) {
        await pc.addIceCandidate(msg.payload);
      }
    } catch (err) {
      note('signalling error: ' + err.message);
    }
  }

  // --- peer connection ------------------------------------------------------

  async function offer() {
    const desc = await pc.createOffer();
    await pc.setLocalDescription(desc);
    await send('offer', pc.localDescription);
  }

  function attach() {
    pc = new RTCPeerConnection({ iceServers: ICE });

    pc.onicecandidate = (e) => {
      if (e.candidate) send('ice', e.candidate);
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        setState('peer-to-peer channel open - no node in the path', 'good');
        clearInterval(helloTimer);
        startStats();
      } else if (s === 'failed' || s === 'disconnected') {
        setState('peer connection ' + s, 'bad');
      } else {
        setState(s);
      }
    };

    // Adding a camera track later fires this. Only the owner holds tracks, so
    // only the owner ever renegotiates - no glare.
    pc.onnegotiationneeded = async () => {
      if (role !== 'owner') return;
      if (pc.signalingState !== 'stable') return;
      try {
        await offer();
      } catch (err) {
        note('renegotiation failed: ' + err.message);
      }
    };

    pc.ontrack = (e) => {
      ui.video.srcObject = e.streams[0];
      ui.video.hidden = false;
      note('live video from the other side');
    };

    if (role === 'owner') {
      chan = pc.createDataChannel('handover');
      wireChannel();
    } else {
      pc.ondatachannel = (e) => {
        chan = e.channel;
        wireChannel();
      };
    }
  }

  function wireChannel() {
    chan.onopen = () => {
      note('text channel open');
      ui.input.disabled = false;
    };
    chan.onclose = () => {
      note('text channel closed');
      ui.input.disabled = true;
    };
    chan.onmessage = (e) => append('them', e.data);
  }

  // --- phase 7: continuous media -------------------------------------------

  async function toggleCamera() {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
      ui.selfVideo.srcObject = null;
      ui.selfVideo.hidden = true;
      ui.camBtn.textContent = 'Show the item';
      return;
    }

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, frameRate: 24 },
        audio: false
      });
    } catch (err) {
      // getUserMedia needs a secure context. http://localhost counts as one;
      // a LAN IP over plain http does not, and fails exactly here.
      note('camera unavailable: ' + err.message +
        (location.protocol === 'http:' && location.hostname !== 'localhost'
          ? ' (a camera needs https or localhost)'
          : ''));
      return;
    }

    ui.selfVideo.srcObject = localStream;
    ui.selfVideo.hidden = false;
    ui.camBtn.textContent = 'Stop showing';
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  }

  // A working video feed is just a webcam demo. What makes it STREAM-oriented
  // is that the data has deadlines the network may fail to meet - so show the
  // numbers that prove it, and watch them degrade under throttling.
  function startStats() {
    clearInterval(statsTimer);
    statsTimer = setInterval(async () => {
      if (!pc || pc.connectionState !== 'connected') return;
      const report = await pc.getStats();
      let shown = false;

      report.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') {
          const now = r.timestamp;
          const bytes = r.bytesReceived || 0;
          let kbps = 0;
          if (lastAt && now > lastAt) {
            kbps = Math.round(((bytes - lastBytes) * 8) / (now - lastAt));
          }
          lastBytes = bytes;
          lastAt = now;

          render({
            direction: 'receiving',
            fps: r.framesPerSecond ?? '-',
            jitter: r.jitter != null ? (r.jitter * 1000).toFixed(1) + ' ms' : '-',
            lost: r.packetsLost ?? 0,
            dropped: r.framesDropped ?? 0,
            bitrate: kbps + ' kbps'
          });
          shown = true;
        }
      });

      if (!shown) {
        report.forEach((r) => {
          if (r.type === 'outbound-rtp' && r.kind === 'video') {
            render({
              direction: 'sending',
              fps: r.framesPerSecond ?? '-',
              jitter: '-',
              lost: '-',
              dropped: r.framesDropped ?? 0,
              bitrate: '-'
            });
            shown = true;
          }
        });
      }

      if (!shown) ui.stats.innerHTML = '<span class="qos-idle">no media flowing</span>';
    }, 1000);
  }

  function render(s) {
    const cell = (label, value) =>
      '<span class="qos-cell"><span class="qos-label">' + label +
      '</span><span class="qos-value">' + value + '</span></span>';
    ui.stats.innerHTML =
      cell('', s.direction) +
      cell('fps', s.fps) +
      cell('jitter', s.jitter) +
      cell('lost', s.lost) +
      cell('dropped', s.dropped) +
      cell('bitrate', s.bitrate);
  }

  // --- lifecycle ------------------------------------------------------------

  function open(invite) {
    if (pc) hangup();

    room = invite.room;
    role = invite.role;

    ui.panel.hidden = false;
    ui.title.textContent = role === 'owner'
      ? 'Handing over ' + invite.name + ' to ' + (invite.holder || 'a student')
      : 'Collecting ' + invite.name + ' from ' + (invite.node_name || 'the owner');
    ui.camBtn.hidden = role !== 'owner';
    ui.log.innerHTML = '';
    ui.video.hidden = true;
    ui.selfVideo.hidden = true;
    ui.input.disabled = true;
    ui.stats.innerHTML = '<span class="qos-idle">no media flowing</span>';
    setState('connecting...');
    note('room ' + room + ' - signalling via your node, media direct');

    attach();

    // Announce arrival, and keep announcing until connected: the other
    // student may not have opened their panel yet, and neither side can know
    // whether the other is already listening.
    send('hello');
    clearInterval(helloTimer);
    let tries = 0;
    helloTimer = setInterval(() => {
      if (!pc || pc.connectionState === 'connected' || ++tries > 10) {
        return clearInterval(helloTimer);
      }
      send('hello');
    }, 2000);
  }

  function hangup() {
    clearInterval(statsTimer);
    clearInterval(helloTimer);
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    if (chan) {
      try { chan.close(); } catch { /* already closed */ }
      chan = null;
    }
    if (pc) {
      try { pc.close(); } catch { /* already closed */ }
      pc = null;
    }
    lastBytes = 0;
    lastAt = 0;
    ui.panel.hidden = true;
    ui.camBtn.textContent = 'Show the item';
  }

  // Exposed for the demo and for debugging: lets you show, from the console,
  // that both browsers really are on one peer connection with a live SCTP
  // data channel - and which ICE candidate pair the media is using.
  async function debug() {
    const out = {
      me: myId,
      room,
      role,
      connection: pc ? pc.connectionState : null,
      ice: pc ? pc.iceConnectionState : null,
      signalling: pc ? pc.signalingState : null,
      channel: chan ? { label: chan.label, id: chan.id, state: chan.readyState } : null,
      candidatePair: null
    };
    if (pc) {
      const report = await pc.getStats();
      report.forEach((r) => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded') {
          out.candidatePair = { bytesSent: r.bytesSent, bytesReceived: r.bytesReceived };
        }
      });
    }
    return out;
  }

  return { bind, open, onSignal, hangup, debug, get myId() { return myId; } };
})();
