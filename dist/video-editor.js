const VideoEditor = (() => {
  'use strict';

  const $ = id => document.getElementById('video-' + id);
  const {clamp, formatTime, parseTime} = AudioCore;
  const preview = $('preview');
  const captureButton = $('capture');
  const captureList = $('capture-list');
  const capturePreview = $('capture-preview');
  const capturePreviewImage = capturePreview.querySelector('img');
  const trackList = $('track-list');
  const clips = [];
  const pendingFiles = [];
  const filmstrip = $('filmstrip');
  const progress = $('progress');
  const dialog = $('export-dialog');
  const exportWorkerUrl = new URL('video-export-worker.mjs', document.baseURI);
  const scriptVersion = document.currentScript && new URL(document.currentScript.src).searchParams.get('v');
  if (scriptVersion) exportWorkerUrl.searchParams.set('v', scriptVersion);
  const seekKeys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
  const captureMaxEdge = 1280;
  const captureQuality = 0.82;
  const captureMaxBytes = 1_000_000;
  let clip = null;
  let drag = null;
  let scrub = null;
  let animation = 0;
  let importing = false;
  let capturePreviewTimer = 0;
  let pendingSeek = null;
  let thumbnailJob = null;
  let estimateJob = null;
  let exportJob = null;
  let downloadUrl = null;

  function status(message) {
    $('status').lastElementChild.textContent = message;
  }

  function releaseMedia(video) {
    video.removeAttribute('src');
    video.load();
  }

  function waitForMedia(video, type, signal) {
    return new Promise((resolve, reject) => {
      const listeners = new AbortController();
      const timeout = setTimeout(() => finish(Error('读取视频超时。')), 15000);
      function finish(error) {
        clearTimeout(timeout);
        listeners.abort();
        if (error) reject(error);
        else resolve();
      }
      video.addEventListener(type, () => finish(), {signal: listeners.signal});
      video.addEventListener('error', () => finish(Error('浏览器无法打开此视频。请试用 MP4、MOV 或 WebM。')), {signal: listeners.signal});
      signal?.addEventListener('abort', () => finish(new DOMException('已取消', 'AbortError')), {signal: listeners.signal});
    });
  }

  async function readClip(file) {
    const url = URL.createObjectURL(file);
    const probe = document.createElement('video');
    probe.muted = true;
    probe.preload = 'auto';
    try {
      const loaded = waitForMedia(probe, 'loadeddata');
      probe.src = url;
      await loaded;
      const {duration, videoWidth: width, videoHeight: height} = probe;
      if (!width || !height || !Number.isFinite(duration) || duration <= 0) {
        throw Error('请导入带有画面和有效时长的视频。');
      }
      const name = file.name.replace(/\.[^.]+$/, '') || file.name;
      return {file, url, name, width, height, duration, start: 0, end: duration, cursor: 0, captures: [], capturing: false};
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    } finally {
      releaseMedia(probe);
    }
  }

  async function importFiles(files) {
    pendingFiles.push(...files);
    if (!pendingFiles.length || importing) return;
    importing = true;
    $('import').disabled = $('empty-import').disabled = true;
    let imported = 0;
    const errors = [];
    try {
      while (pendingFiles.length) {
        const file = pendingFiles.shift();
        status('正在读取 ' + file.name + '…');
        try {
          const video = await readClip(file);
          clips.push(video);
          appendLibraryItem(video);
          if (!clip) activateClip(video);
          imported++;
        } catch (error) {
          errors.push(file.name + '：' + error.message);
        }
      }
      const messages = imported ? ['已导入 ' + imported + ' 个视频', ...errors] : errors;
      status(messages.join('；'));
    } finally {
      importing = false;
      $('import').disabled = $('empty-import').disabled = false;
    }
  }

  function appendLibraryItem(video) {
    const row = $('track-template').content.firstElementChild.cloneNode(true);
    const choose = row.querySelector('.track-select');
    choose.title = video.file.name;
    choose.setAttribute('aria-pressed', 'false');
    choose.onclick = () => activateClip(video);
    row.querySelector('.track-name').textContent = video.file.name;
    row.querySelector('.track-detail').textContent = formatTime(video.duration);
    const remove = row.querySelector('.track-remove');
    remove.setAttribute('aria-label', '移除 ' + video.file.name);
    remove.title = '移除 ' + video.file.name;
    remove.onclick = () => {
      const index = clips.indexOf(video);
      clips.splice(index, 1);
      row.remove();
      $('track-count').textContent = clips.length;
      if (clip === video) activateClip(clips[Math.min(index, clips.length - 1)] || null);
      URL.revokeObjectURL(video.url);
      for (const capture of video.captures) URL.revokeObjectURL(capture.url);
      const neighbor = trackList.children[Math.min(index, clips.length - 1)];
      (neighbor?.querySelector('.track-select') || $('import')).focus();
      if (!clip && !importing) status('等待导入视频');
    };
    trackList.append(row);
    $('track-count').textContent = clips.length;
  }

  function activateClip(video) {
    if (clip === video) return;
    pause();
    if (clip && preview.currentSrc === clip.url && !preview.seeking && pendingSeek === null) {
      clip.cursor = clamp(preview.currentTime, clip.start, clip.end);
    }
    pendingSeek = null;
    thumbnailJob?.abort();
    drag = null;
    clip = video;
    for (const [index, row] of Array.from(trackList.children).entries()) {
      const selected = clips[index] === clip;
      row.classList.toggle('active', selected);
      row.querySelector('.track-select').setAttribute('aria-pressed', String(selected));
    }
    $('empty').hidden = !!clip;
    $('heading').hidden = $('editor').hidden = !clip;
    renderCaptures();
    if (!clip) {
      releaseMedia(preview);
      updateCaptureButton();
      return;
    }
    preview.src = clip.url;
    updateCaptureButton();
    const {file, width, height, duration, cursor} = clip;
    $('title').textContent = file.name;
    $('meta').textContent = width + ' × ' + height + '　' + formatTime(duration) + '　' + formatBytes(file.size);
    $('time-middle').textContent = formatTime(duration / 2);
    $('time-end').textContent = formatTime(duration);
    renderSelection();
    renderPosition(cursor);
    thumbnailJob = new AbortController();
    drawThumbnails(clip, thumbnailJob.signal);
  }

  async function drawThumbnails({url, duration}, signal) {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    const canvas = $('thumbnails');
    const context = canvas.getContext('2d');
    const count = 8;
    const width = canvas.width / count;
    const height = canvas.height;
    context.clearRect(0, 0, canvas.width, height);
    try {
      const loaded = waitForMedia(video, 'loadeddata', signal);
      video.src = url;
      await loaded;
      for (let i = 0; i < count && !signal.aborted; i++) {
        const time = duration * (i + .5) / count;
        if (video.currentTime !== time) {
          const sought = waitForMedia(video, 'seeked', signal);
          video.currentTime = time;
          await sought;
        }
        if (signal.aborted) break;
        const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
        const sourceWidth = width / scale;
        const sourceHeight = height / scale;
        context.drawImage(video, (video.videoWidth - sourceWidth) / 2, (video.videoHeight - sourceHeight) / 2,
          sourceWidth, sourceHeight, i * width, 0, width, height);
      }
    } catch {
      // The timeline remains interactive if a thumbnail seek fails.
    } finally {
      releaseMedia(video);
    }
  }

  function renderSelection() {
    const {start, end, duration} = clip;
    const left = start / duration * 100;
    const right = end / duration * 100;
    $('selection').style.left = left + '%';
    $('selection').style.width = (right - left) + '%';
    filmstrip.style.setProperty('--cut-start', left + '%');
    filmstrip.style.setProperty('--cut-end', right + '%');
    for (const endpoint of ['start', 'end']) {
      const handle = $('handle-' + endpoint);
      handle.setAttribute('aria-valuemin', String(endpoint === 'start' ? 0 : start + minimum()));
      handle.setAttribute('aria-valuemax', String(endpoint === 'start' ? end - minimum() : duration));
      handle.setAttribute('aria-valuenow', String(clip[endpoint]));
      handle.setAttribute('aria-valuetext', formatTime(clip[endpoint]));
      $(endpoint).value = formatTime(clip[endpoint]);
    }
    $('selection-duration').textContent = (end - start).toFixed(3) + ' 秒';
    progress.min = start;
    progress.max = end;
  }

  function renderPosition(time) {
    if (!clip) return;
    const {start, end, duration} = clip;
    const position = clamp(time, start, end);
    clip.cursor = position;
    progress.valueAsNumber = position;
    progress.setAttribute('aria-valuetext', formatTime(position));
    progress.style.setProperty('--played', (position - start) / (end - start) * 100 + '%');
    $('playhead').style.left = position / duration * 100 + '%';
    $('playback-time').textContent = formatTime(position);
  }

  function seek(time, interactive = false) {
    if (!clip) return;
    const position = clamp(time, clip.start, clip.end);
    renderPosition(position);
    if (interactive) {
      pendingSeek = position;
      flushPreviewSeek();
    } else {
      pendingSeek = null;
      if (preview.currentTime !== position) preview.currentTime = position;
    }
    updateCaptureButton();
  }

  function flushPreviewSeek() {
    if (pendingSeek === null || preview.seeking || preview.currentSrc !== clip?.url ||
      preview.readyState < HTMLMediaElement.HAVE_METADATA) return;
    // Let the decoder finish its current preview frame and skip superseded positions.
    const target = pendingSeek;
    pendingSeek = null;
    if (preview.currentTime !== target) preview.currentTime = target;
  }

  function pause() {
    scrub = null;
    preview.pause();
    cancelAnimationFrame(animation);
    hideCapturePreview();
    updateCaptureButton();
  }

  function canCapture() {
    return clip && preview.currentSrc === clip.url && !clip.capturing && !drag && !scrub &&
      preview.paused && !preview.seeking && pendingSeek === null &&
      preview.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && preview.videoWidth && preview.videoHeight;
  }

  function updateCaptureButton() {
    captureButton.disabled = !canCapture();
  }

  async function encodeCapture() {
    const frame = document.createElement('canvas');
    const {videoWidth, videoHeight} = preview;
    const scale = Math.min(1, captureMaxEdge / Math.max(videoWidth, videoHeight));
    frame.width = Math.max(1, Math.round(videoWidth * scale));
    frame.height = Math.max(1, Math.round(videoHeight * scale));
    frame.getContext('2d', {alpha: false}).drawImage(preview, 0, 0, frame.width, frame.height);

    const resized = document.createElement('canvas');
    const initialEdge = Math.max(frame.width, frame.height);
    for (let edge = initialEdge; edge >= 1; edge = Math.floor(edge * .75)) {
      const canvas = edge === initialEdge ? frame : resized;
      if (canvas === resized) {
        const ratio = edge / initialEdge;
        canvas.width = Math.max(1, Math.round(frame.width * ratio));
        canvas.height = Math.max(1, Math.round(frame.height * ratio));
        canvas.getContext('2d', {alpha: false}).drawImage(frame, 0, 0, canvas.width, canvas.height);
      }
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', captureQuality));
      if (blob?.type !== 'image/jpeg') throw Error('无法生成 JPEG 截图');
      if (blob.size <= captureMaxBytes) return blob;
    }
    throw Error('无法将截图压缩至 1 MB 以内');
  }

  async function captureFrame() {
    if (!canCapture()) return;
    const time = formatTime(preview.currentTime);
    const video = clip;
    video.capturing = true;
    updateCaptureButton();
    try {
      const blob = await encodeCapture();
      if (!clips.includes(video)) return;
      video.captures.unshift({url: URL.createObjectURL(blob), time, bytes: blob.size});
      if (clip === video) {
        renderCaptures();
        status('已暂存 ' + time + ' 的截图');
      }
    } catch {
      if (clip === video) status('无法截取当前画面，请重新定位后再试。');
    } finally {
      video.capturing = false;
      updateCaptureButton();
    }
  }

  function renderCaptures() {
    hideCapturePreview();
    const captures = clip?.captures ?? [];
    $('captures').hidden = !clip;
    $('capture-hint').hidden = !captures.length;
    $('capture-empty').hidden = !!captures.length;
    captureList.replaceChildren(...captures.map(makeCaptureItem));
    captureList.scrollTop = captureList.scrollLeft = 0;
  }

  function makeCaptureItem({url, time, bytes}) {
    const {name} = clip;
    const link = document.createElement('a');
    link.href = url;
    link.download = name.replace(/[<>:"/\\|?*]/g, '_') + '_截图_' + time.replace(':', '-') + '.jpg';
    const size = formatBytes(bytes);
    link.setAttribute('aria-label', '下载 ' + name + ' 在 ' + time + ' 的截图，' + size);
    const image = new Image();
    image.src = url;
    image.alt = '';
    const stamp = document.createElement('span');
    stamp.append(time, document.createElement('br'), size);
    link.append(image, stamp);
    link.addEventListener('pointerenter', event => {
      if (event.pointerType === 'mouse') scheduleCapturePreview(link, url);
    });
    link.addEventListener('pointerleave', hideCapturePreview);
    link.addEventListener('focus', () => {
      if (link.matches(':focus-visible')) scheduleCapturePreview(link, url);
    });
    link.addEventListener('blur', hideCapturePreview);
    link.addEventListener('click', hideCapturePreview);
    const item = document.createElement('li');
    item.append(link);
    return item;
  }

  function hideCapturePreview() {
    clearTimeout(capturePreviewTimer);
    capturePreview.hidden = true;
    capturePreviewImage.removeAttribute('src');
  }

  function scheduleCapturePreview(anchor, url) {
    hideCapturePreview();
    capturePreviewTimer = setTimeout(() => {
      const rect = anchor.getBoundingClientRect();
      if (!rect.width) return;
      const margin = 12, gap = 10;
      const spaceOnLeft = rect.left - margin - gap;
      const fitsOnLeft = spaceOnLeft >= 240;
      const maxHeight = Math.min(window.innerHeight * .65, 520);
      const thumbnail = anchor.querySelector('img');
      const imageWidth = thumbnail.naturalWidth || clip.width;
      const imageHeight = thumbnail.naturalHeight || clip.height;
      const width = Math.min(620, maxHeight * imageWidth / imageHeight,
        fitsOnLeft ? spaceOnLeft : window.innerWidth - margin * 2);
      capturePreviewImage.width = imageWidth;
      capturePreviewImage.height = imageHeight;
      capturePreviewImage.src = url;
      capturePreview.style.width = width + 'px';
      capturePreview.hidden = false;
      const height = capturePreview.offsetHeight;
      const left = fitsOnLeft ? rect.left - gap - width : clamp(rect.left, margin, window.innerWidth - width - margin);
      const top = fitsOnLeft ? rect.top : rect.top - gap - height;
      capturePreview.style.left = left + 'px';
      capturePreview.style.top = clamp(top, margin, Math.max(margin, window.innerHeight - height - margin)) + 'px';
    }, 500);
  }

  function updatePlayback() {
    if (!clip || scrub || drag || pendingSeek !== null || preview.currentSrc !== clip.url || preview.seeking ||
      preview.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const time = preview.currentTime;
    if (!preview.paused && time >= clip.end) {
      pause();
      seek(clip.end);
      return;
    }
    renderPosition(time);
  }

  function tick() {
    updatePlayback();
    if (!preview.paused) animation = requestAnimationFrame(tick);
  }

  async function togglePlay() {
    if (!clip) return;
    if (!preview.paused) {
      pause();
      return;
    }
    if (clip.cursor >= clip.end - .001) seek(clip.start);
    try {
      await preview.play();
    } catch (error) {
      if (error.name !== 'AbortError') status('暂时无法播放该视频。');
    }
  }

  function minimum() {
    return Math.min(.010, clip.duration);
  }

  function setBoundary(endpoint, time, interactive = false) {
    if (!Number.isFinite(time)) {
      $(endpoint).value = formatTime(clip[endpoint]);
      status('请输入秒数或分:秒，例如 4.2 或 00:04.200。');
      return;
    }
    if (!interactive) pause();
    const rounded = Math.round(time * 1000) / 1000;
    clip[endpoint] = endpoint === 'start'
      ? clamp(rounded, 0, clip.end - minimum())
      : clamp(rounded, clip.start + minimum(), clip.duration);
    renderSelection();
    seek(clip[endpoint], interactive);
  }

  function selectAll() {
    if (!clip) return;
    pause();
    clip.start = 0;
    clip.end = clip.duration;
    renderSelection();
    seek(0);
  }

  function chooseFile() {
    if (!importing) $('file-input').click();
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function exportSettings() {
    return {
      format: $('export-format').value,
      edge: Number($('gif-edge').value),
      fps: Number($('gif-fps').value),
      start: clip.start,
      end: clip.end
    };
  }

  function runWorker(kind, settings, onMessage) {
    let worker;
    try {
      worker = new Worker(exportWorkerUrl, {type: 'module'});
      worker.onmessage = ({data}) => {
        if (data.progress === undefined) worker.terminate();
        onMessage(data);
      };
      worker.onerror = () => {
        worker.terminate();
        onMessage({error: '无法启动视频处理。请在新版浏览器中通过网页打开 Mossroom Studio。'});
      };
      worker.postMessage({kind, settings, file: clip.file});
    } catch {
      worker?.terminate();
      queueMicrotask(() => onMessage({error: '当前浏览器无法启动本地视频处理。'}));
    }
    return {cancel() { worker?.terminate(); }};
  }

  function discardDownload() {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
    $('download-again').hidden = true;
    $('download-again').removeAttribute('href');
    $('size-actual').hidden = true;
  }

  function refreshEstimate() {
    estimateJob?.cancel();
    discardDownload();
    const settings = exportSettings();
    const isGif = settings.format === 'gif';
    $('export-extension').textContent = '.' + settings.format;
    $('gif-options').hidden = !isGif;
    $('export-info').textContent = isGif
      ? '静音循环播放。根据片段抽帧估算大小。'
      : '保留画面比例和声音。根据目标码率估算大小。';
    $('export-label').textContent = isGif ? '导出 GIF' : '导出 MP4';
    $('export-confirm').disabled = true;
    $('export-progress').hidden = true;
    $('export-cancel').textContent = '取消';
    $('size-estimate').textContent = '正在估算文件大小…';

    const job = runWorker('estimate', settings, ({result, error}) => {
      if (estimateJob !== job) return;
      estimateJob = null;
      $('size-estimate').textContent = result ? '预计 ' + formatBytes(result.bytes) : '预计大小暂不可用';
      $('export-confirm').disabled = !result;
      if (error) {
        $('export-message').textContent = error;
        $('export-bar').hidden = true;
        $('export-progress').hidden = false;
      }
    });
    estimateJob = job;
  }

  function openExport() {
    if (!clip || importing || dialog.open) return;
    pause();
    $('export-source').textContent = clip.file.name;
    $('export-name').value = clip.name + '_剪辑';
    $('export-name').setCustomValidity('');
    $('export-range').textContent = formatTime(clip.start) + ' – ' + formatTime(clip.end) + '　' + (clip.end - clip.start).toFixed(3) + ' 秒';
    dialog.showModal();
    refreshEstimate();
  }

  function setExportBusy(busy) {
    for (const id of ['export-name', 'export-format', 'gif-edge', 'gif-fps', 'export-confirm']) $(id).disabled = busy;
    $('export-cancel').textContent = busy ? '取消导出' : '取消';
  }

  function exportVideo(event) {
    event.preventDefault();
    if (!clip || exportJob || $('export-confirm').disabled) return;
    const settings = exportSettings();
    const nameInput = $('export-name');
    const basename = nameInput.value.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\.(mp4|gif)$/i, '').trim();
    if (!basename) {
      nameInput.setCustomValidity('请为导出文件命名。');
      nameInput.reportValidity();
      return;
    }
    const name = basename + '.' + settings.format;
    discardDownload();
    setExportBusy(true);
    $('export-message').textContent = '正在导出 0%';
    $('export-bar').value = 0;
    $('export-bar').hidden = false;
    $('export-progress').hidden = false;

    const job = runWorker('export', settings, ({progress, result, error}) => {
      if (exportJob !== job) return;
      if (progress !== undefined) {
        $('export-message').textContent = '正在导出 ' + Math.floor(progress * 100) + '%';
        $('export-bar').value = progress;
        return;
      }
      exportJob = null;
      setExportBusy(false);
      $('export-bar').hidden = true;
      if (error) {
        $('export-message').textContent = error;
        return;
      }
      downloadUrl = URL.createObjectURL(result.blob);
      const link = $('download-again');
      link.href = downloadUrl;
      link.download = name;
      link.hidden = false;
      $('size-actual').textContent = '实际 ' + formatBytes(result.blob.size);
      $('size-actual').hidden = false;
      $('export-message').textContent = '已生成 ' + name;
      $('export-cancel').textContent = '完成';
      link.click();
      status('已导出 ' + name);
    });
    exportJob = job;
  }

  function closeExport() {
    if (!exportJob) {
      dialog.close();
      return;
    }
    exportJob.cancel();
    exportJob = null;
    setExportBusy(false);
    $('export-bar').hidden = true;
    $('export-message').textContent = '已取消导出。';
  }

  $('import').onclick = $('empty-import').onclick = chooseFile;
  $('file-input').addEventListener('change', event => {
    importFiles([...event.target.files]);
    event.target.value = '';
  });

  preview.addEventListener('play', () => {
    $('play').setAttribute('aria-label', '暂停播放');
    $('play').querySelector('use').setAttribute('href', '#i-pause');
    cancelAnimationFrame(animation);
    animation = requestAnimationFrame(tick);
  });
  preview.addEventListener('pause', () => {
    $('play').setAttribute('aria-label', '播放选区');
    $('play').querySelector('use').setAttribute('href', '#i-play');
    cancelAnimationFrame(animation);
  });
  preview.addEventListener('loadedmetadata', () => {
    if (clip && preview.currentSrc === clip.url && clip.cursor) seek(clip.cursor);
  });
  preview.addEventListener('seeked', flushPreviewSeek);
  for (const event of ['timeupdate', 'loadeddata', 'seeked']) preview.addEventListener(event, updatePlayback);
  for (const event of ['play', 'pause', 'ended', 'loadeddata', 'seeking', 'seeked', 'emptied', 'error']) {
    preview.addEventListener(event, updateCaptureButton);
  }
  preview.addEventListener('error', () => status('视频预览加载失败。请重新导入文件。'));

  $('play').onclick = togglePlay;
  captureButton.onclick = captureFrame;
  $('jump-start').onclick = () => seek(clip.start);
  $('jump-end').onclick = () => { pause(); seek(clip.end); };
  $('select-all').onclick = selectAll;
  progress.addEventListener('input', () => {
    if (!scrub) {
      scrub = {resume: !preview.paused};
      preview.pause();
    }
    seek(progress.valueAsNumber, true);
  });
  for (const event of ['change', 'pointercancel', 'blur']) progress.addEventListener(event, () => {
    if (!scrub) return;
    const {resume} = scrub;
    scrub = null;
    seek(clip.cursor);
    if (resume && clip.cursor < clip.end - .001) togglePlay();
  });
  window.addEventListener('scroll', hideCapturePreview, true);
  window.addEventListener('resize', hideCapturePreview);

  for (const endpoint of ['start', 'end']) {
    const input = $(endpoint);
    input.addEventListener('change', () => setBoundary(endpoint, parseTime(input.value)));
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') input.blur();
    });
    $('handle-' + endpoint).addEventListener('keydown', event => {
      if (!seekKeys.includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = (event.key === 'ArrowLeft' ? -1 : 1) * .001;
      const time = event.key === 'Home' ? 0 : event.key === 'End' ? clip.duration : clip[endpoint] + delta;
      setBoundary(endpoint, time);
    });
  }

  filmstrip.addEventListener('pointerdown', event => {
    if (!clip || event.button !== 0 || drag) return;
    const handle = event.target.closest('.video-handle');
    const rect = filmstrip.getBoundingClientRect();
    if (!handle) {
      pause();
      seek((event.clientX - rect.left) / rect.width * clip.duration);
      return;
    }
    event.preventDefault();
    pause();
    handle.focus();
    const endpoint = handle.id.endsWith('start') ? 'start' : 'end';
    drag = {pointer: event.pointerId, endpoint, x: event.clientX, time: clip[endpoint], width: rect.width, cursor: clip.cursor};
    updateCaptureButton();
    filmstrip.setPointerCapture(event.pointerId);
  });
  filmstrip.addEventListener('pointermove', event => {
    if (event.pointerId !== drag?.pointer) return;
    setBoundary(drag.endpoint, drag.time + (event.clientX - drag.x) / drag.width * clip.duration, true);
  });
  for (const type of ['pointerup', 'lostpointercapture']) filmstrip.addEventListener(type, event => {
    if (event.pointerId !== drag?.pointer) return;
    drag = null;
    seek(clip.cursor);
  });
  filmstrip.addEventListener('pointercancel', event => {
    if (event.pointerId !== drag?.pointer) return;
    clip[drag.endpoint] = drag.time;
    const cursor = drag.cursor;
    drag = null;
    renderSelection();
    seek(cursor);
  });

  $('export').onclick = openExport;
  $('export-form').onsubmit = exportVideo;
  $('export-name').oninput = event => event.currentTarget.setCustomValidity('');
  for (const id of ['export-format', 'gif-edge', 'gif-fps']) $(id).onchange = refreshEstimate;
  $('export-close').onclick = $('export-cancel').onclick = closeExport;
  dialog.addEventListener('cancel', event => {
    if (!exportJob) return;
    event.preventDefault();
    closeExport();
  });
  dialog.addEventListener('close', () => {
    estimateJob?.cancel();
    estimateJob = null;
    exportJob?.cancel();
    exportJob = null;
    setExportBusy(false);
    discardDownload();
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog || !exportJob) return;
    // The application's shared backdrop handler closes idle dialogs.
    event.stopImmediatePropagation();
  });

  window.addEventListener('pagehide', event => {
    pause();
    if (event.persisted) return;
    thumbnailJob?.abort();
    estimateJob?.cancel();
    exportJob?.cancel();
    discardDownload();
    for (const video of clips) {
      URL.revokeObjectURL(video.url);
      for (const capture of video.captures) URL.revokeObjectURL(capture.url);
    }
  });

  return {importFiles, pause};
})();
