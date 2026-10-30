'use strict';

const el = (id) => document.getElementById(id);
let me = { node_id: '', node_name: '' };
let lastQuery = '';

// Handover invitations pushed by this node, keyed by room, so the markup only
// ever carries an id rather than a serialised object.
const invites = new Map();

// Identity is a name in a box. Real authentication is a Unit 4 topic.
const who = el('who');
who.value = localStorage.getItem('campus-mesh:who') || '';
who.addEventListener('change', () => localStorage.setItem('campus-mesh:who', who.value));

function toast(message, ms = 5000) {
  const t = el('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

async function api(path, body) {
  const res = await fetch('/api' + path, body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  } : undefined);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

const ago = (ts) => {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return Math.round(s / 3600) + 'h ago';
};

// ---- node identity, peer dots, broker state ----

function renderPeers(peers) {
  el('peers').innerHTML = peers
    .filter((p) => !p.self)
    .map((p) => {
      const count = p.resourceCount ? '<span class="count">' + p.resourceCount + '</span>' : '';
      return '<span class="peer" title="' + p.address + ' · ' + p.state + '">' +
        '<span class="dot ' + p.state + '"></span>' + p.id + count +
        '</span>';
    })
    .join('');
}

async function loadNode() {
  const node = await api('/node');
  me = node;
  el('nodeName').textContent = node.node_name;
  el('nodeId').textContent = node.node_id + ' · grpc:' + node.grpc_port + ' · http:' + node.http_port;
  const mq = el('mqState');
  mq.className = 'mq ' + (node.mqtt ? 'on' : 'off');
  mq.textContent = node.mqtt ? 'broker up' : 'no broker';
  renderPeers(node.peers);
}

// ---- search ----

function resourceRow(r) {
  const isLocal = r.node_id === me.node_id;
  const here = isLocal ? '<span class="tag local">here</span>' : '';
  const request = r.status === 'available'
    ? '<button data-rid="' + r.rid + '" class="reserve">Request</button>'
    : '';
  return '<li class="row">' +
    '<div class="what">' +
      '<div class="name">' + r.name + '</div>' +
      '<div class="where">' + r.node_name + ' · ' + r.rid + ' · v' + r.version + '</div>' +
    '</div>' +
    here +
    '<span class="tag ' + r.status + '">' + r.status + '</span>' +
    request +
  '</li>';
}

async function runSearch(query) {
  lastQuery = query;
  el('searchMeta').textContent = 'searching the mesh...';
  el('searchMeta').classList.remove('partial');

  const r = await api('/search', { query });

  // The honest line: never hide that part of the network did not answer.
  const meta = el('searchMeta');
  meta.textContent = r.matches.length + ' match(es) · ' +
    r.responded + ' of ' + r.total + ' nodes responded · ' + r.latencyMs + 'ms';
  meta.classList.toggle('partial', r.responded < r.total);

  el('results').innerHTML = r.matches.length
    ? r.matches.map(resourceRow).join('')
    : '<li class="empty">Nothing matching "' + query + '" anywhere on the mesh.</li>';

  // Request/reply has nothing more to offer here. Park the need instead and
  // let an announcement from any node wake it up.
  if (!r.matches.some((m) => m.status === 'available')) {
    el('results').insertAdjacentHTML('beforeend',
      '<li class="notify-row">' +
        '<p>Nothing available right now. Want to be told the moment one frees up?</p>' +
        '<button class="ghost notify" data-query="' + query + '">Notify me</button>' +
      '</li>');
  }
}

el('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = el('query').value.trim();
  if (!query) return;
  try {
    await runSearch(query);
  } catch (err) {
    el('searchMeta').textContent = 'search failed: ' + err.message;
  }
});

// ---- actions ----

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.classList.contains('reserve')) {
    btn.disabled = true;
    try {
      const r = await api('/reserve', {
        rid: btn.dataset.rid,
        requester: who.value.trim() || 'anonymous',
        hours: 2
      });
      if (r.granted) {
        toast('Granted by ' + r.decided_by + '. Opening the handover channel.');
        const row = btn.closest('.row');
        Handover.open({
          room: r.handover_room,
          role: 'requester',
          name: row ? row.querySelector('.name').textContent : 'the item',
          node_name: r.decided_by
        });
      } else {
        toast('Refused by ' + r.decided_by + ': ' + r.reason);
      }
    } catch (err) {
      toast('Reservation failed: ' + err.message);
    }
    await refresh();
    if (lastQuery) await runSearch(lastQuery).catch(() => {});
  }

  if (btn.classList.contains('release')) {
    btn.disabled = true;
    try {
      await api('/release', { rid: btn.dataset.rid });
      toast('Returned to the pool. Announced to the whole mesh.');
    } catch (err) {
      toast('Release failed: ' + err.message);
    }
    await refresh();
  }

  if (btn.classList.contains('notify')) {
    btn.disabled = true;
    try {
      await api('/wantlist', {
        query: btn.dataset.query,
        requester: who.value.trim() || 'anonymous'
      });
      btn.textContent = 'Watching';
      await loadWatching();
    } catch (err) {
      toast('Could not add to your wantlist: ' + err.message);
    }
  }

  if (btn.classList.contains('accept')) {
    const invite = invites.get(btn.dataset.room);
    if (invite) Handover.open(invite);
    btn.closest('.invite').remove();
  }

  if (btn.classList.contains('unwatch')) {
    await api('/wantlist/remove', { id: btn.dataset.id });
    await loadWatching();
  }
});

// ---- panels ----

async function refresh() {
  const inv = await api('/resources');
  el('invMeta').textContent = inv.items.length + ' resources owned by ' + inv.node_id;
  el('inventory').innerHTML = inv.items.map((r) => {
    const held = r.holder ? ' · held by ' + r.holder : '';
    const ret = r.status !== 'available'
      ? '<button data-rid="' + r.rid + '" class="release">Return</button>'
      : '';
    return '<li class="row">' +
      '<div class="what">' +
        '<div class="name">' + r.name + '</div>' +
        '<div class="where">' + r.rid + ' · v' + r.version + held + '</div>' +
      '</div>' +
      '<span class="tag ' + r.status + '">' + r.status + '</span>' +
      ret +
    '</li>';
  }).join('');
}

async function loadWatching() {
  const w = await api('/wantlist');
  el('watchMeta').textContent = w.entries.length
    ? w.entries.length + ' standing request(s) parked on this node'
    : 'no standing requests';
  el('watching').innerHTML = w.entries.map((e) =>
    '<li class="row">' +
      '<div class="what">' +
        '<div class="name">"' + e.query + '"</div>' +
        '<div class="where">' + e.requester + ' · ' + ago(e.createdAt) + '</div>' +
      '</div>' +
      '<button class="ghost unwatch" data-id="' + e.id + '">Stop</button>' +
    '</li>'
  ).join('');
}

function feedRow(n, fresh) {
  return '<li class="row' + (fresh ? ' fresh' : '') + '">' +
    '<div class="what">' +
      '<div class="name">' + n.name + ' is available</div>' +
      '<div class="where">' + n.node_name + ' · matched "' + n.query +
        '" for ' + n.requester + ' · L=' + n.lamport + '</div>' +
    '</div>' +
    '<span class="when">' + ago(n.at) + '</span>' +
  '</li>';
}

async function loadFeed() {
  const f = await api('/notifications');
  el('feedMeta').textContent = f.items.length
    ? f.items.length + ' announcement(s) matched a standing request'
    : 'nothing yet';
  el('feed').innerHTML = f.items.map((n) => feedRow(n, false)).join('');
}

// ---- push channel ----
//
// Peer state and availability announcements arrive without the browser asking
// for them. Nobody polls: the node pushes when the mesh tells it something.
function listen() {
  const src = new EventSource('/api/events');

  src.addEventListener('peers', (e) => renderPeers(JSON.parse(e.data)));

  src.addEventListener('available', (e) => {
    const n = JSON.parse(e.data);
    toast(n.name + ' just became available at ' + n.node_name, 8000);
    loadFeed().catch(() => {});
    loadWatching().catch(() => {});
  });

  src.addEventListener('reserved', () => {
    if (lastQuery) runSearch(lastQuery).catch(() => {});
    refresh().catch(() => {});
  });

  // This node owns the item somebody just reserved, so the student standing
  // in this lab is the one handing it over. Offer, never force - a lab screen
  // should not start a camera on its own.
  src.addEventListener('handover', (e) => {
    const invite = JSON.parse(e.data);
    invites.set(invite.room, invite);
    toast(invite.holder + ' requested ' + invite.name + ' - open the handover channel to coordinate', 9000);

    const li = document.createElement('li');
    li.className = 'invite';
    li.innerHTML = '<p></p><button class="ghost accept">Open handover</button>';
    li.querySelector('p').textContent = invite.holder + ' is collecting ' + invite.name;
    li.querySelector('button').dataset.room = invite.room;
    el('inventory').prepend(li);
  });

  src.addEventListener('signal', (e) => Handover.onSignal(JSON.parse(e.data)));
}

Handover.bind();

loadNode()
  .then(() => Promise.all([refresh(), loadWatching(), loadFeed()]))
  .then(listen)
  .catch((err) => toast('Could not reach this node: ' + err.message));

setInterval(() => loadNode().catch(() => {}), 5000);
