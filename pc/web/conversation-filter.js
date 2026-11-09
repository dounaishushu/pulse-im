// Search only the current account's loaded conversations and private remarks.
(function (root) {
  'use strict';
  const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
  function matches(query, { name, remark, preview, conversationId, internalStaff, nickname, username, publicId, description }) {
    const value = normalize(query);
    if (!value) return true;
    const fields = [name, remark, preview, conversationId];
    if (internalStaff) fields.push(nickname, username, username ? '@' + username : '', publicId, description);
    const values = fields.map(normalize).filter(Boolean);
    const terms = internalStaff ? value.split(' ') : [value];
    return terms.every(term => values.some(field => field.includes(term)));
  }
  root.PulseConversationFilter = { normalize, matches };
})(window);
