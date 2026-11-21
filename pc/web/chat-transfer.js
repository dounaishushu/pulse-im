(function (root) {
  'use strict';
  const format = 'pulse-im-pc-chat-transfer';
  const maxPlaintext = 8 * 1024 * 1024;
  const encoder = new TextEncoder();

  function encode(bytes) {
    const pieces = [];
    for (let offset = 0; offset < bytes.length; offset += 16384) {
      pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + 16384)));
    }
    return btoa(pieces.join(''));
  }

  function decode(text, max) {
    if (typeof text !== 'string' || text.length > Math.ceil(max / 3) * 4) throw Error('聊天备份的大小或格式无效。');
    return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
  }

  async function key(passphrase, salt) {
    if (typeof passphrase !== 'string' || passphrase.length < 10 || passphrase.length > 128) {
      throw Error('请输入 10 至 128 个字符的备份密码。');
    }
    const secret = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
      secret,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  async function seal(state, passphrase) {
    const bytes = encoder.encode(JSON.stringify(state));
    if (bytes.length > maxPlaintext) throw Error('备份超过 8 MB，请先处理部分待发消息。');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(format + ':1') },
      await key(passphrase, salt), bytes,
    );
    return JSON.stringify({ format, version: 1, salt: encode(salt), iv: encode(iv), data: encode(new Uint8Array(cipher)) });
  }

  async function open(text, passphrase) {
    if (typeof text !== 'string' || text.length > 12 * 1024 * 1024) throw Error('请选择 12 MB 以内的聊天备份。');
    let envelope;
    try { envelope = JSON.parse(text); } catch { throw Error('无法读取聊天备份。'); }
    if (envelope?.format !== format || envelope.version !== 1) throw Error('请选择旧版导出的聊天备份。');
    try {
      const salt = decode(envelope.salt, 16);
      const iv = decode(envelope.iv, 12);
      const data = decode(envelope.data, maxPlaintext + 16);
      if (salt.length !== 16 || iv.length !== 12 || data.length < 17 || data.length > maxPlaintext + 16) throw Error();
      const bytes = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(format + ':1') },
        await key(passphrase, salt), data,
      );
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw Error('无法解开聊天备份，请检查备份密码和文件。');
    }
  }

  if (typeof module === 'object' && module.exports) module.exports = { seal, open };
  else root.PulseChatTransfer = { seal, open };
})(globalThis);
