'use strict';

function normalizeProfileUrl(data) {
  if (!data || typeof data.profileUrl !== 'string') return;
  const url = data.profileUrl.trim();
  if (!url) return;
  // Skip internal paths
  if (url.startsWith('/')) {
    data.profileUrl = url;
    return;
  }
  const match = url.match(/^(https?:\/\/)?([^\/?#]+)(.*)$/i);
  if (!match) return;
  const [, scheme, host, rest] = match;
  data.profileUrl = `${scheme ?? ''}${host.toLowerCase()}${rest}`;
}

module.exports = {
  beforeCreate(event) {
    normalizeProfileUrl(event.params.data);
  },
  beforeUpdate(event) {
    normalizeProfileUrl(event.params.data);
  },
};
