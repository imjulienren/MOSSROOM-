(function(root) {
  'use strict';
  const Mixer=typeof module!=='undefined'&&module.exports?require('./mixer-core.js'):root.MixerCore;
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  function formatTime(seconds) {
    const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
    const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
    return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0') + '.' + String(ms % 1000).padStart(3,'0');
  }
  function parseTime(text) {
    const value = String(text).trim();
    if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
    const parts = value.split(':');
    if (parts.length < 2 || parts.length > 3 || parts.some(p => !/^\d+(?:\.\d+)?$/.test(p))) return NaN;
    if (parts.slice(0,-1).some(p => !/^\d+$/.test(p)) || parts.slice(1).some(p => Number(p) >= 60)) return NaN;
    return parts.reduce((sum, p) => sum * 60 + Number(p), 0);
  }
  function selectionFrames(start, end, sampleRate, length) {
    const a = clamp(Math.round(start * sampleRate), 0, Math.max(0, length - 1));
    const b = clamp(Math.round(end * sampleRate), a + 1, length);
    return [a, b];
  }
  function findPeak(channels, start, end) {
    let peak = 0;
    for (const data of channels) for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(data[i]));
    return peak;
  }
  function processSelection(channels, sampleRate, options) {
    return Mixer.process(channels,sampleRate,options).channels;
  }
  function replaceRange(channels, start, end, replacement) {
    if (!channels.length || channels.length !== replacement.length) throw Error('音频声道不一致');
    const length = channels[0].length, inserted = replacement[0].length;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > length) throw Error('编辑范围无效');
    if (channels.some(c => c.length !== length) || replacement.some(c => c.length !== inserted)) throw Error('音频声道长度不一致');
    return channels.map((channel, index) => {
      const result = new Float32Array(length - (end - start) + inserted);
      result.set(channel.subarray(0,start));
      result.set(replacement[index],start);
      result.set(channel.subarray(end),start+inserted);
      return result;
    });
  }
  function insertSilence(channels, sampleRate, position, seconds) {
    if (!Number.isFinite(position) || !Number.isFinite(seconds) || seconds <= 0) throw Error('请输入有效的空白时长');
    const at = clamp(Math.round(position*sampleRate),0,channels[0].length), frames = Math.max(1,Math.round(seconds*sampleRate));
    return replaceRange(channels,at,at,channels.map(() => new Float32Array(frames)));
  }
  // This function is self-contained so the editor can also run it in a Worker.
  function encodeWav(channels, sampleRate, bitDepth) {
    if (!channels.length || !channels[0].length || ![16,24].includes(bitDepth)) throw new Error('无效的音频参数');
    const channelCount = channels.length, length = channels[0].length, bytes = bitDepth / 8;
    const dataBytes = length * channelCount * bytes, padding = dataBytes % 2;
    const buffer = new ArrayBuffer(44 + dataBytes + padding), view = new DataView(buffer);
    const str = (offset, value) => { for (let i=0; i<value.length; i++) view.setUint8(offset+i,value.charCodeAt(i)); };
    str(0,'RIFF'); view.setUint32(4,36+dataBytes+padding,true); str(8,'WAVE'); str(12,'fmt ');
    view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,channelCount,true);
    view.setUint32(24,sampleRate,true); view.setUint32(28,sampleRate*channelCount*bytes,true);
    view.setUint16(32,channelCount*bytes,true); view.setUint16(34,bitDepth,true); str(36,'data'); view.setUint32(40,dataBytes,true);
    let offset = 44;
    for (let i=0; i<length; i++) for (let ch=0; ch<channelCount; ch++) {
      const value = Math.max(-1, Math.min(1, channels[ch][i]));
      if (bitDepth === 16) { view.setInt16(offset,Math.round(value*(value<0?32768:32767)),true); offset += 2; }
      else { const sample = Math.round(value*(value<0?8388608:8388607)); view.setUint8(offset++,sample&255); view.setUint8(offset++,(sample>>8)&255); view.setUint8(offset++,(sample>>16)&255); }
    }
    return buffer;
  }
  function estimateBpm(channels, sampleRate) {
    const hop = Math.round(sampleRate / 100);
    const frames = Math.floor(Math.min(channels[0]?.length || 0, sampleRate * 45) / hop);
    if (frames < 4 * sampleRate / hop) return null;
    const envelope = new Float32Array(frames);
    let loudest = 0;
    for (let frame = 0; frame < frames; frame++) {
      let energy = 0;
      const start = frame * hop;
      for (const channel of channels) {
        for (let i = start; i < start + hop; i++) energy += channel[i] ** 2;
      }
      envelope[frame] = Math.sqrt(energy / (hop * channels.length));
      loudest = Math.max(loudest, envelope[frame]);
    }
    if (loudest < 1e-5) return null;
    const floor = loudest * .015;
    const onsets = envelope.map((value, i) => {
      if (i < 3) return 0;
      return Math.max(0, Math.log((floor + value) / (floor + envelope[i - 3])) - .1);
    });
    let events = 0, last = -12;
    for (let i = 3; i < frames; i++) {
      if (onsets[i] > .4 && i - last >= 12) { events++; last = i; }
    }
    if (events < 4) return null;

    const beatsPerMinute = 60 * sampleRate / hop;
    const minLag = Math.floor(beatsPerMinute / 205);
    const maxLag = Math.ceil(beatsPerMinute / 55);
    const scores = new Float64Array(maxLag + 2);
    for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
      let overlap = 0, energyA = 0, energyB = 0;
      for (let i = lag; i < frames; i++) {
        const a = onsets[i], b = onsets[i - lag];
        overlap += a * b;
        energyA += a * a;
        energyB += b * b;
      }
      scores[lag] = overlap / Math.max(1e-8, Math.sqrt(energyA * energyB));
    }
    let bestLag = 0, bestScore = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const score = scores[lag];
      if (score <= scores[lag - 1] || score < scores[lag + 1]) continue;
      // A multiple can align more closely when the beat falls between analysis frames.
      const multiple = bestLag ? Math.round(lag / bestLag) : 0;
      if (multiple > 1 && Math.abs(lag - bestLag * multiple) <= 2 && bestScore >= score * .8) continue;
      if (score > bestScore + .06) { bestLag = lag; bestScore = score; }
    }
    if (bestScore < .35) return null;
    const left = scores[bestLag - 1], right = scores[bestLag + 1];
    const offset = .5 * (right - left) / (2 * bestScore - left - right);
    return Math.round(beatsPerMinute / (bestLag + offset));
  }
  const api = {clamp,formatTime,parseTime,selectionFrames,findPeak,processSelection,replaceRange,insertSilence,encodeWav,estimateBpm};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AudioCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
