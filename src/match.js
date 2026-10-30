'use strict';

// One matcher, used both when searching this node's own table and when
// deciding whether an announcement from another node satisfies a student's
// standing request. Sharing it means a wantlist can never disagree with a
// search about what "hdmi" means.
function matches(resource, query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return false;
  const tags = resource.tags || [];
  return (
    resource.name.toLowerCase().includes(q) ||
    resource.category === q ||
    tags.some((t) => t.includes(q) || q.includes(t))
  );
}

module.exports = { matches };
