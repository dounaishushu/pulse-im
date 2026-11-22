const { isIP } = require('node:net');

function diagnosticFields(data) {
  if (typeof data?.ip !== 'string' || !isIP(data.ip)) return null;
  const score = data.fraudScore;
  const location = {};
  for (const [source, key] of [['country', 'country'], ['region', 'province'], ['city', 'city'], ['district', 'district']]) {
    const value = typeof data[source] === 'string' ? data[source].trim() : '';
    location[key] = value.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value : '';
  }
  return { exit_ip: data.ip,
    risk_score: Number.isFinite(score) && score >= 0 && score <= 100 ? score : null,
    is_residential: typeof data.isResidential === 'boolean' ? data.isResidential : null,
    is_broadcast: typeof data.isBroadcast === 'boolean' ? data.isBroadcast : null,
    ...(Object.values(location).some(Boolean) ? { exit_location: location } : {}) };
}

async function decodeExitResponse(response) {
  if (!response.ok || !response.body) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 16384) return null;
    chunks.push(chunk);
  }
  return diagnosticFields(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

module.exports = { diagnosticFields, decodeExitResponse };
