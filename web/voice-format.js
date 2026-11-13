(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PulseVoiceFormat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const sampleRate = 16000, maximumSeconds = 300, maximumBytes = 10 * 1024 * 1024;

  function encodePCM(channels, rate = sampleRate) {
    if (rate !== sampleRate || !Array.isArray(channels) || !channels.length || channels.length > 8) throw Error('录音采样格式无效，请重新录制。');
    const length = channels[0]?.length;
    if (!Number.isSafeInteger(length) || length < rate / 5 || length > rate * (maximumSeconds + 0.5) || channels.some(channel => channel?.length !== length)) throw Error('录音时长无效，请录制0.2秒到5分钟的语音。');
    const frames = Math.min(length, rate * maximumSeconds), bytes = new ArrayBuffer(44 + frames * 2), view = new DataView(bytes);
    const text = (offset, value) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)); };
    text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, frames * 2, true);
    for (let frame = 0; frame < frames; frame++) {
      let value = 0;
      for (const channel of channels) {
        if (!Number.isFinite(channel[frame])) throw Error('录音内容无效，请重新录制。');
        value += channel[frame] / channels.length;
      }
      value = Math.max(-1, Math.min(1, value));
      view.setInt16(44 + frame * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }
    if (bytes.byteLength > maximumBytes) throw Error('语音大小不能超过10MB。');
    return { bytes, durationMilliseconds: Math.round(frames * 1000 / rate), sampleRate: rate, channels: 1 };
  }

  async function prepare(blob, OfflineContext = root.OfflineAudioContext || root.webkitOfflineAudioContext) {
    if (!blob?.size || blob.size > maximumBytes) throw Error('录音为空或超过10MB限制。');
    if (!OfflineContext) throw Error('当前环境无法处理兼容语音，请更新浏览器或客户端。');
    const decoder = new OfflineContext(1, 1, sampleRate);
    const audio = await decoder.decodeAudioData(await blob.arrayBuffer());
    const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index));
    const encoded = encodePCM(channels, audio.sampleRate);
    return { ...encoded, blob: new root.Blob([encoded.bytes], { type: 'audio/wav' }) };
  }

  return { encodePCM, prepare, sampleRate, maximumSeconds, maximumBytes };
});
