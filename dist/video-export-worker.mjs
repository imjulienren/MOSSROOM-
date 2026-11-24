import { BlobSource, BufferTarget, CanvasSink, Conversion, Input, MATROSKA, MP4, Mp4OutputFormat, Output, QTFF, WEBM } from './vendor/mediabunny.min.mjs';

const audioBitrate = 160_000;
const gifFrameLimit = 12_000;
const gifByteLimit = 256 * 1024 * 1024;

self.onmessage = async ({data: {file, settings, kind}}) => {
  const input = new Input({source: new BlobSource(file), formats: [MP4, QTFF, WEBM, MATROSKA]});
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw Error('文件中没有可导出的视频轨道。');
    const result = settings.format === 'gif'
      ? await makeGif(video, settings, kind === 'estimate')
      : await makeMp4(input, video, settings, kind === 'estimate');
    self.postMessage({result});
  } catch (error) {
    self.postMessage({error: error.message || '视频处理失败。'});
  } finally {
    input.dispose();
  }
};

async function makeMp4(input, video, {start, end}, estimating) {
  const audio = await input.getPrimaryAudioTrack();
  const width = await video.getDisplayWidth();
  const height = await video.getDisplayHeight();
  const bitrate = Math.min(45_000_000, Math.max(400_000, Math.round(width * height * 5)));
  const target = new BufferTarget();
  const output = new Output({format: new Mp4OutputFormat(), target});
  const conversion = await Conversion.init({
    input, output, tracks: 'primary', showWarnings: false,
    trim: {start, end},
    video: {codec: 'avc', bitrate, forceTranscode: true},
    audio: {codec: 'aac', bitrate: audioBitrate, forceTranscode: true}
  });
  if (!conversion.isValid || !conversion.utilizedTracks.includes(video)) {
    throw Error('当前浏览器无法将此视频编码为 H.264 MP4。可以尝试导出 GIF。');
  }
  if (audio && !conversion.utilizedTracks.includes(audio)) {
    throw Error('当前浏览器无法将此音轨编码为 AAC。可以尝试导出 GIF。');
  }
  if (estimating) {
    return {bytes: Math.round((end - start) * (bitrate + (audio ? audioBitrate : 0)) / 8) + 2048};
  }
  conversion.onProgress = reportProgress;
  await conversion.execute();
  return {blob: new Blob([target.buffer], {type: 'video/mp4'})};
}

function reportProgress(value) {
  self.postMessage({progress: value});
}

async function sampleGifColors(track, width, height, frameCount, start, fps) {
  const scale = Math.min(1, 96 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const sink = new CanvasSink(track, {width: w, height: h, fit: 'contain', poolSize: 1});
  const count = Math.min(5, frameCount);
  const colors = new Uint8Array(count * w * h * 4);
  let length = 0;
  for (let i = 0; i < count; i++) {
    const frameIndex = Math.round(i * (frameCount - 1) / Math.max(1, count - 1));
    const frame = await sink.getCanvas(start + frameIndex / fps);
    if (!frame) continue;
    const rgba = frame.canvas.getContext('2d').getImageData(0, 0, w, h).data;
    colors.set(rgba, length);
    length += rgba.length;
  }
  return colors.subarray(0, length);
}

function createPaletteMapper(palette) {
  // Cache the nearest palette index for each RGB565 color across all frames.
  const cache = new Uint16Array(1 << 16);
  return rgba => {
    const pixels = new Uint8Array(rgba.length / 4);
    for (let i = 0, offset = 0; i < pixels.length; i++, offset += 4) {
      const r5 = rgba[offset] >> 3;
      const g6 = rgba[offset + 1] >> 2;
      const b5 = rgba[offset + 2] >> 3;
      const key = (r5 << 11) | (g6 << 5) | b5;
      let index = cache[key];
      if (index === 0) {
        // Use the center of each bucket so estimates and exports map colors consistently.
        const r = r5 * 8 + 4, g = g6 * 4 + 2, b = b5 * 8 + 4;
        let nearest = Infinity;
        for (let j = 0; j < palette.length; j++) {
          const [pr, pg, pb] = palette[j];
          const distance = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
          if (distance < nearest) {
            nearest = distance;
            index = j + 1;
          }
        }
        cache[key] = index;
      }
      pixels[i] = index - 1;
    }
    return pixels;
  };
}

async function makeGif(track, {start, end, edge, fps}, estimating) {
  const duration = end - start;
  const durationTicks = Math.max(2, Math.round(duration * 100));
  let frameCount = Math.max(1, Math.ceil(duration * fps));
  if (frameCount > 1 && durationTicks - Math.round((frameCount - 1) / fps * 100) < 2) frameCount--;
  if (frameCount > gifFrameLimit) throw Error('GIF 帧数过多，请缩短选区或降低帧率。');
  if (!await track.canDecode()) throw Error('当前浏览器无法解码此视频以生成 GIF。');

  const {GIFEncoder, quantize} = await import('./vendor/gifenc.mjs');
  const width = await track.getDisplayWidth();
  const height = await track.getDisplayHeight();
  const scale = Math.min(1, edge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const sink = new CanvasSink(track, {width: w, height: h, fit: 'contain', poolSize: 2});
  const blankCanvas = new OffscreenCanvas(w, h);
  const samples = await sampleGifColors(track, w, h, frameCount, start, fps);
  const sharedPalette = samples.length ? quantize(samples, 256) : [[0, 0, 0]];
  const mapWithSharedPalette = createPaletteMapper(sharedPalette);

  function writeFrame(gif, frame, index) {
    const canvas = frame?.canvas || blankCanvas;
    const rgba = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const palette = index === 0 ? sharedPalette : undefined;
    const pixels = mapWithSharedPalette(rgba);
    // Quantize cumulative time so the 10 ms GIF delay unit doesn't skew the clip's speed.
    const elapsed = Math.round(index / fps * 100);
    const next = index === frameCount - 1 ? durationTicks : Math.round((index + 1) / fps * 100);
    gif.writeFrame(pixels, w, h, {palette, delay: (next - elapsed) * 10, repeat: 0});
  }

  const gif = GIFEncoder();
  if (estimating) {
    const count = Math.min(6, frameCount);
    for (let i = 0; i < count; i++) {
      const index = count === 1 ? 0 : Math.round(i * (frameCount - 1) / (count - 1));
      writeFrame(gif, await sink.getCanvas(start + index / fps), index);
    }
    return {bytes: Math.round(gif.bytesView().byteLength / count * frameCount) + 1};
  }

  const timestamps = function* () {
    for (let i = 0; i < frameCount; i++) yield start + i / fps;
  };
  let index = 0;
  for await (const frame of sink.canvasesAtTimestamps(timestamps())) {
    writeFrame(gif, frame, index++);
    if (gif.bytesView().byteLength > gifByteLimit) {
      throw Error('GIF 文件过大，请缩短选区、减小画面尺寸或降低帧率。');
    }
    if (index % 5 === 0 || index === frameCount) reportProgress(index / frameCount);
  }
  gif.finish();
  return {blob: new Blob([gif.bytesView()], {type: 'image/gif'})};
}
