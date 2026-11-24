(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const playbackProgress = $('playback-progress');
  const {clamp,formatTime,parseTime,findPeak,encodeWav,estimateBpm} = AudioCore;
  const tracks = [];
  let current = null, audioContext = null, source = null, playing = false;
  let sourceOffset = 0, sourceTime = 0, sourceRate = 1, playbackRequest = 0;
  let progressDrag = null;
  let frame = 0, zoom = 1, importing = false, drag = null, toastTimer = 0;
  let processed = null, exporting = false, downloadUrl = null, dragDepth = 0, timelineJob = null;
  let auditionOriginal=false,mixResumeTimer=0,clipLatch=0,fxBefore=null,gainBefore=null;
  let activeTab = 'audio';
  const audioConstructor = window.AudioContext || window.webkitAudioContext;
  const settings = t => ({start:t.start,end:t.end,volume:t.volume,fadeIn:t.fadeIn,fadeOut:t.fadeOut,normalize:t.normalize,fx:{...MixerCore.defaults(),...t.fx}});
  const snapshot = t => ({...settings(t),buffer:t.buffer,cursor:t.cursor,timelineEdited:t.timelineEdited});
  const equals = (a,b) => a.buffer===b.buffer && JSON.stringify(settings(a))===JSON.stringify(settings(b));
  const icon = name => { const svg = document.createElementNS('http://www.w3.org/2000/svg','svg'); const use = document.createElementNS(svg.namespaceURI,'use'); use.setAttribute('href','#i-'+name); svg.append(use); return svg; };
  const context = () => { if (!audioConstructor) throw Error('当前浏览器不支持音频处理，请使用新版 Safari、Chrome 或 Edge。'); return audioContext || (audioContext = new audioConstructor({latencyHint:'interactive'})); };
  function toast(message) { clearTimeout(toastTimer); $('toast').textContent=message; $('toast').hidden=false; toastTimer=setTimeout(()=>$('toast').hidden=true,4200); }
  function status(message,busy=false) { $('status-text').replaceChildren(); const dot=document.createElement('span'); dot.className='status-dot'; $('status-text').append(dot,document.createTextNode(message)); document.body.classList.toggle('is-busy',busy); }
  function memoryUsage(){const buffers=new Set();for(const t of tracks){buffers.add(t.buffer);for(const state of [...t.history,...t.future])buffers.add(state.buffer);}return [...buffers].reduce((sum,b)=>sum+b.length*b.numberOfChannels*4,0);}
  function pruneHistory(){while(memoryUsage()>384*1024*1024){let removed=false;for(const t of tracks){if(t.history.length>(t===current?1:0)){t.history.shift();removed=true;break;}if(t.future.length){t.future.shift();removed=true;break;}}if(!removed)break;}}
  function remember(before) { if (!current || equals(before,snapshot(current))) return; current.history.push(before); if(current.history.length>60)current.history.shift(); current.future=[]; pruneHistory(); }
  function minimum(t=current) { return Math.min(.001,t.buffer.duration); }
  function clean(t) { t.start=clamp(Math.round(t.start*1000)/1000,0,t.buffer.duration-minimum(t)); t.end=clamp(Math.round(t.end*1000)/1000,t.start+minimum(t),t.buffer.duration); t.fadeIn=clamp(t.fadeIn,0,Math.min(10,t.end-t.start)); t.fadeOut=clamp(t.fadeOut,0,Math.min(10,t.end-t.start)); t.volume=clamp(t.volume,0,10);t.cursor=clamp(t.cursor,0,t.buffer.duration); }
  function edit(update,record=true) { if(!current)return; pause(); const before=snapshot(current); update(current); clean(current); if(record)remember(before); processed=null; render(); }
  function liveEdit(update,record=true){const resume=playing||!!mixResumeTimer;edit(update,record);if(resume)mixResumeTimer=setTimeout(()=>{mixResumeTimer=0;play();},120);}
  function analyzeBuffer(buffer) {
    const channels=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i));
    const peak=findPeak(channels,0,buffer.length), buckets=Math.min(24000,buffer.length), peaks=new Float32Array(buckets);
    const stride=buffer.length/buckets;
    for(let b=0;b<buckets;b++){ let p=0; const from=Math.floor(b*stride),to=Math.min(buffer.length,Math.ceil((b+1)*stride)); for(const channel of channels)for(let i=from;i<to;i++)p=Math.max(p,Math.abs(channel[i])); peaks[b]=p; }
    return {channels,peak,peaks};
  }
  function makeTrack(name,buffer,size=0) {
    const {channels,peak,peaks}=analyzeBuffer(buffer);
    const track={id:crypto.randomUUID?crypto.randomUUID():String(Date.now()+Math.random()),name:name.replace(/\.(mp3|wav|m4a|aac|flac|aiff?|ogg|webm|opus)$/i,''),fullName:name,buffer,channels,size,peak,peaks,bpm:estimateBpm(channels,buffer.sampleRate),start:0,end:buffer.duration,cursor:0,volume:1,fadeIn:0,fadeOut:0,normalize:false,fx:MixerCore.defaults(),timelineEdited:false,history:[],future:[]};
    return track;
  }
  function activate(track) { pause();current=track;processed=null;clipLatch=0;fxBefore=null;gainBefore=null;auditionOriginal=false;zoom=1;$('wave-content').style.width='100%';$('wave-scroll').scrollLeft=0;render();requestAnimationFrame(drawWave); }
  function removeTrack(track) { const index=tracks.indexOf(track);if(index<0)return;tracks.splice(index,1);if(current===track)activate(tracks[Math.min(index,tracks.length-1)]||null);else render();if(!current)status('等待导入音频'); }
  const fileFormat = track => track.fullName.includes('.')?track.fullName.split('.').pop().toUpperCase():'音频';
  function renderLibrary() {
    $('track-list').replaceChildren();$('track-count').textContent=tracks.length;
    for(const track of tracks){
      const row=document.createElement('div');row.className='track-item'+(track===current?' active':'');
      const choose=document.createElement('button');choose.className='track-select';choose.setAttribute('aria-pressed',String(track===current));choose.title=track.fullName;choose.onclick=()=>activate(track);
      const image=document.createElement('span');image.className='track-icon';image.append(icon('wave'));
      const copy=document.createElement('span');copy.className='track-copy';const name=document.createElement('span');name.className='track-name';name.textContent=track.name;
      const detail=document.createElement('span');detail.className='track-detail';detail.textContent=track.buffer.duration.toFixed(2)+' 秒　'+fileFormat(track);copy.append(name,detail);choose.append(image,copy);
      const remove=document.createElement('button');remove.className='track-remove';remove.title='移除 '+track.name;remove.setAttribute('aria-label','移除 '+track.name);remove.append(icon('close'));remove.onclick=()=>removeTrack(track);row.append(choose,remove);$('track-list').append(row);
    }
  }
  function render() {
    renderLibrary();$('track-editor').hidden=!current;
    $('empty-state').hidden=!!current;$('workspace-heading').hidden=!current;$('export-btn').disabled=!current||!!timelineJob;$('stretch-btn').disabled=$('silence-btn').disabled=!current||importing||!!timelineJob;
    if(!current)return;
    const t=current, duration=t.buffer.duration;
    playbackProgress.min=t.start;playbackProgress.max=t.end;
    $('track-title').textContent=t.name;$('file-meta').textContent=(fileFormat(t)+'　')+(t.buffer.numberOfChannels===1?'单声道':'立体声')+'　'+(t.buffer.sampleRate/1000).toFixed(1).replace('.0','')+' kHz　'+duration.toFixed(2)+' 秒　'+(t.bpm===null?'未检测到节拍':'约 '+t.bpm+' BPM');
    $('edit-badge').hidden=!t.timelineEdited;
    $('start-input').value=formatTime(t.start);$('end-input').value=formatTime(t.end);
    $('selection-duration').replaceChildren(document.createTextNode((t.end-t.start).toFixed(3)));const unit=document.createElement('span');unit.textContent='秒';$('selection-duration').append(unit);
    $('selection-time').textContent=(t.end-t.start).toFixed(3)+' s';
    $('selection').style.left=(t.start/duration*100)+'%';$('selection').style.width=((t.end-t.start)/duration*100)+'%';
    for(const endpoint of ['start','end']){const handle=$('handle-'+endpoint);handle.setAttribute('aria-valuemax',String(duration));handle.setAttribute('aria-valuenow',t[endpoint].toFixed(3));handle.setAttribute('aria-valuetext',formatTime(t[endpoint]));}
    $('gain').value=t.volume;$('gain-value').value=t.volume+' 倍';
    $('fade-in').value=Number(t.fadeIn.toFixed(3));$('fade-out').value=Number(t.fadeOut.toFixed(3));$('fade-in').max=$('fade-out').max=Math.min(10,t.end-t.start);$('normalize').checked=t.normalize;
    $('undo-btn').disabled=!t.history.length;$('redo-btn').disabled=!t.future.length;
    $('zoom-value').textContent=Math.round(zoom*100)+'%';$('zoom-out').disabled=zoom<=1;$('zoom-in').disabled=zoom>=8;
    renderTimeline();drawWave();renderPlayhead();renderMixer();updateMeters();
  }
  const signed = value => (value>0?'+':'')+value;
  function renderMixer(){
    if(!current)return;const f=current.fx;
    for(const input of document.querySelectorAll('[data-fx]')){const value=f[input.dataset.fx];if(input.type==='checkbox')input.checked=!!value;else if(document.activeElement!==input||input.type==='range')input.value=value;}
    for(const out of document.querySelectorAll('[data-readout]')){
      const key=out.dataset.readout,value=f[key];
      out.value=(['low','mid','high'].includes(key)?signed(value):value)+out.dataset.unit;
    }
    $('bypass-btn').setAttribute('aria-pressed',String(auditionOriginal));
    $('bypass-btn').textContent=auditionOriginal?'正在听原音':'原音对比';
  }
  function updateMeters(live=false){
    const buffer=processed?.buffer,stats=processed?.stats,peaks=[0,0];let sum=0,count=0;
    if(live&&playing&&current&&buffer){const from=Math.floor(clamp(current.cursor-current.start,0,buffer.duration)*buffer.sampleRate),to=Math.min(buffer.length,from+1024);for(let ch=0;ch<buffer.numberOfChannels;ch++){const data=buffer.getChannelData(ch);for(let i=from;i<to;i++){peaks[ch]=Math.max(peaks[ch],Math.abs(data[i]));sum+=data[i]*data[i];count++;}}if(buffer.numberOfChannels===1)peaks[1]=peaks[0];}
    const db=v=>v>1e-6?(20*Math.log10(v)).toFixed(1):'−∞';
    for(let i=0;i<2;i++){const level=clamp((20*Math.log10(Math.max(1e-6,peaks[i]))+60)/60,0,1),el=$(i?'meter-right':'meter-left');el.style.height=level*100+'%';el.style.setProperty('--level',level);}
    $('meter-peak').value=db(live?Math.max(...peaks):stats?.peak||0);$('meter-rms').value=db(live?Math.sqrt(sum/Math.max(1,count)):stats?.rms||0);$('meter-gr').value=(stats?Math.max(stats.gainReductionDb||0,stats.limitedDb||0):0).toFixed(1);
    $('clip-reset').classList.toggle('clipped',clipLatch>0);$('clip-text').textContent=clipLatch?'削波 '+(clipLatch>999?'999+':clipLatch):'无削波';$('clip-reset').title=clipLatch+' 个样本超出 0 dB，点击清除记录';
    $('peak-hint').classList.toggle('warning',!!stats?.clippedSamples);$('peak-hint').textContent=stats?.clippedSamples?'输出削波':'';
  }
  function renderTimeline() {
    if(!current)return;
    const width=$('wave-area').clientWidth,duration=current.buffer.duration,desired=duration/Math.max(2,Math.floor(width/100));
    const steps=[.01,.025,.05,.1,.25,.5,1,2,5,10,15,30,60,120,300,600,1800,3600];const step=steps.find(s=>s>=desired)||7200;
    $('timeline').replaceChildren();
    const positions=[];for(let time=0;time<=duration;time+=step)positions.push(time);
    if(!positions.length||duration-positions[positions.length-1]>step*.55)positions.push(duration);
    positions.forEach(time=>{const tick=document.createElement('span');tick.className='timeline-tick';tick.style.left=(time/duration*100)+'%';tick.textContent=formatTime(time).slice(0,step<1?8:5);$('timeline').append(tick);});
  }
  function drawWave() {
    if(!current||$('empty-state').hidden===false)return;
    const canvas=$('wave-canvas'),width=$('wave-area').clientWidth,height=$('wave-area').clientHeight;
    if(!width||!height)return;
    const dpr=Math.min(window.devicePixelRatio||1,2,16384/width);canvas.width=Math.ceil(width*dpr);canvas.height=Math.ceil(height*dpr);
    const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);ctx.clearRect(0,0,width,height);
    const t=current,scale=Math.min(3,.9/(t.peak||1)),bars=Math.ceil(width/3.5),duration=t.buffer.duration;
    for(let b=0;b<bars;b++){
      const from=Math.floor(b/bars*t.peaks.length),to=Math.max(from+1,Math.ceil((b+1)/bars*t.peaks.length));let peak=0;
      for(let i=from;i<to;i++)peak=Math.max(peak,t.peaks[i]||0);
      const x=b*3.5,amplitude=Math.max(1.2,Math.min(height*.39,peak*scale*height*.43)),time=b/bars*duration;
      ctx.fillStyle=time>=t.start&&time<=t.end?'#216749':'#729581';ctx.fillRect(Math.round(x),Math.round(height/2-amplitude),2,Math.round(amplitude*2));
    }
    if(t.fadeIn>0||t.fadeOut>0){ctx.strokeStyle='#99541ecc';ctx.lineWidth=1;ctx.setLineDash([3,3]);ctx.beginPath();const from=t.start/duration*width,to=t.end/duration*width;ctx.moveTo(from,t.fadeIn?height-15:15);if(t.fadeIn)ctx.lineTo((t.start+t.fadeIn)/duration*width,15);if(t.fadeOut){ctx.lineTo((t.end-t.fadeOut)/duration*width,15);ctx.lineTo(to,height-15);}else ctx.lineTo(to,15);ctx.stroke();ctx.setLineDash([]);}
  }
  function renderPlayhead() {
    if(!current)return;
    const {cursor,start,end,buffer}=current;
    $('playhead').style.left=(clamp(cursor,0,buffer.duration)/buffer.duration*100)+'%';
    $('playback-time').textContent=formatTime(cursor);
    const position=clamp(cursor,start,end);
    if(playbackProgress.valueAsNumber!==position)playbackProgress.valueAsNumber=position;
    playbackProgress.setAttribute('aria-valuetext',formatTime(position));
    playbackProgress.style.setProperty('--played',((position-start)/(end-start)*100)+'%');
  }
  function revealPlayhead() {
    if(zoom<=1)return;
    const scroll=$('wave-scroll'),wave=$('wave-area');
    const x=current.cursor/current.buffer.duration*wave.clientWidth+wave.offsetLeft;
    if(x>scroll.scrollLeft+scroll.clientWidth-30||x<scroll.scrollLeft+10)scroll.scrollLeft=Math.max(0,x-scroll.clientWidth*.2);
  }
  function setPlaybackUI() { $('play-btn').replaceChildren(icon(playing?'pause':'play'));$('play-btn').setAttribute('aria-label',playing?'暂停':'播放选区');$('play-btn').title=(playing?'暂停':'播放选区')+' Space'; }
  function getPlaybackPosition() {
    if(!playing||!current||!processed)return current?current.cursor:0;
    const elapsed=sourceOffset+(context().currentTime-sourceTime)*sourceRate;
    return current.start+($('loop-btn').getAttribute('aria-pressed')==='true'?elapsed%processed.buffer.duration:Math.min(elapsed,processed.buffer.duration));
  }
  function pause() {
    progressDrag=null;
    clearTimeout(mixResumeTimer);mixResumeTimer=0;
    playbackRequest++;
    if(playing&&current)current.cursor=clamp(getPlaybackPosition(),0,current.buffer.duration);
    playing=false;cancelAnimationFrame(frame);if(source){source.onended=null;try{source.stop();}catch{}source.disconnect();source=null;}setPlaybackUI();renderPlayhead();updateMeters();
  }
  function prepareSelection(range=settings(current)) {
    const key=current.id+JSON.stringify(range);if(processed&&processed.key===key&&processed.source===current.buffer)return processed.buffer;
    const rendered=MixerCore.process(current.channels,current.buffer.sampleRate,range),data=rendered.channels;
    const buffer=context().createBuffer(data.length,data[0].length,current.buffer.sampleRate);data.forEach((values,i)=>buffer.copyToChannel(values,i));processed={key,buffer,source:current.buffer,stats:rendered.stats};clipLatch=Math.max(clipLatch,rendered.stats.clippedSamples);updateMeters();return buffer;
  }
  async function play() {
    if(!current)return;
    clearTimeout(mixResumeTimer);mixResumeTimer=0;
    const request=++playbackRequest;
    try{
      await context().resume();if(request!==playbackRequest)return;
      const buffer=prepareSelection({...settings(current),bypassEffects:auditionOriginal});source=context().createBufferSource();source.buffer=buffer;source.loop=$('loop-btn').getAttribute('aria-pressed')==='true';sourceRate=Number($('speed').value);source.playbackRate.value=sourceRate;source.connect(context().destination);
      sourceOffset=current.cursor>=current.start&&current.cursor<current.end?Math.min(current.cursor-current.start,buffer.duration):0;sourceTime=context().currentTime;const thisSource=source;
      source.onended=()=>{if(source!==thisSource)return;playing=false;source.disconnect();source=null;current.cursor=current.end;cancelAnimationFrame(frame);setPlaybackUI();renderPlayhead();updateMeters();status('播放完成');};
      source.start(0,sourceOffset);playing=true;setPlaybackUI();status(source.loop?'正在循环试听选区':'正在试听选区');animate();
    }catch(error){pause();toast('无法播放音频：'+error.message);status('播放失败');}
  }
  function animate() {
    if(!playing||!current)return;current.cursor=getPlaybackPosition();renderPlayhead();updateMeters(true);
    revealPlayhead();
    frame=requestAnimationFrame(animate);
  }
  function togglePlay(){if(playing||mixResumeTimer){pause();status('已暂停');}else play();}
  function seek(time){if(!current)return;const resume=playing;pause();current.cursor=clamp(time,0,current.buffer.duration);renderPlayhead();if(resume)play();}
  function toggleLoop(){if(!current)return;const position=playing?getPlaybackPosition():0,enabled=$('loop-btn').getAttribute('aria-pressed')!=='true';$('loop-btn').setAttribute('aria-pressed',String(enabled));$('loop-label').textContent=enabled?'循环开启':'循环关闭';if(source){sourceOffset=position-current.start;sourceTime=context().currentTime;source.loop=enabled;}status(enabled?'循环播放已开启':'循环播放已关闭');}
  function setZoom(value){if(!current)return;const scroll=$('wave-scroll'),center=(scroll.scrollLeft+scroll.clientWidth/2)/Math.max(1,$('wave-content').clientWidth);zoom=clamp(value,1,8);$('wave-content').style.width=(zoom*100)+'%';scroll.scrollLeft=center*$('wave-content').clientWidth-scroll.clientWidth/2;render();}
  function history(direction){if(!current||timelineJob)return;const from=direction==='undo'?current.history:current.future,to=direction==='undo'?current.future:current.history;if(!from.length)return;pause();to.push(snapshot(current));const previous=from.pop(),changed=previous.buffer!==current.buffer;Object.assign(current,previous);if(changed)Object.assign(current,analyzeBuffer(current.buffer));processed=null;render();status(direction==='undo'?'已撤销':'已重做');}
  function setTime(endpoint){if(!current)return;const input=$(endpoint+'-input'),value=parseTime(input.value);if(!Number.isFinite(value)){toast('请输入有效时间，例如 01:23.500，或直接输入秒数。');render();return;}if(value<0||value>current.buffer.duration||(endpoint==='start'?value>=current.end:value<=current.start)){toast(endpoint==='start'?'开始时间需要早于结束时间，并位于音频范围内。':'结束时间需要晚于开始时间，并位于音频范围内。');render();return;}edit(t=>{t[endpoint]=value;t.cursor=endpoint==='start'?value:t.cursor;});status('选区已更新');}
  function pointerTime(event){const rect=$('wave-area').getBoundingClientRect();return clamp((event.clientX-rect.left)/rect.width,0,1)*current.buffer.duration;}
  $('wave-area').addEventListener('pointerdown',event=>{
    if(!current||event.button!==0)return;event.preventDefault();pause();const endpoint=event.target.closest('.selection-handle');if(endpoint)endpoint.focus();else $('wave-area').focus();
    drag={pointer:event.pointerId,endpoint:endpoint?endpoint.id.replace('handle-',''):null,anchor:pointerTime(event),x:event.clientX,before:snapshot(current),moved:false,stretch:!!endpoint&&endpoint.id==='handle-end'&&event.altKey};$('wave-area').setPointerCapture(event.pointerId);
    if(drag.stretch){$('selection').classList.add('stretching-selection');$('wave-area').classList.add('stretch-dragging');}
  });
  $('wave-area').addEventListener('pointermove',event=>{
    if(!drag||!current||event.pointerId!==drag.pointer)return;const time=pointerTime(event);
    if(Math.abs(event.clientX-drag.x)>3)drag.moved=true;
    if(drag.stretch){const length=drag.before.end-drag.before.start,delta=(event.clientX-drag.x)/$('wave-area').getBoundingClientRect().width*current.buffer.duration;drag.target=clamp(length+delta,Math.max(.02,length*.25),length*4);$('selection').style.width=(drag.target/current.buffer.duration*100)+'%';$('selection-time').textContent=drag.target.toFixed(3)+' s';return;}
    if(drag.endpoint==='start')current.start=clamp(time,0,current.end-minimum());else if(drag.endpoint==='end')current.end=clamp(time,current.start+minimum(),current.buffer.duration);else if(drag.moved){current.start=Math.min(drag.anchor,time);current.end=Math.max(drag.anchor,time);}
    if(drag.moved||drag.endpoint){clean(current);current.cursor=current.start;processed=null;render();}
  });
  function endDrag(event){if(!drag||!current||event.pointerId!==drag.pointer)return;const completed=drag;drag=null;$('selection').classList.remove('stretching-selection');$('wave-area').classList.remove('stretch-dragging');if(completed.stretch){render();if(completed.moved&&openStretch(completed.target))$('stretch-form').requestSubmit();return;}if(!completed.moved&&!completed.endpoint){current.cursor=pointerTime(event);renderPlayhead();}else{remember(completed.before);render();status('选区已更新');}}
  $('wave-area').addEventListener('pointerup',endDrag);
  $('wave-area').addEventListener('pointercancel',event=>{if(drag&&current){Object.assign(current,drag.before);drag=null;$('selection').classList.remove('stretching-selection');$('wave-area').classList.remove('stretch-dragging');render();}});
  for(const endpoint of ['start','end'])$('handle-'+endpoint).addEventListener('keydown',event=>{if(!current||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();event.stopPropagation();const delta=(event.shiftKey?.1:.001)*(event.key==='ArrowLeft'?-1:1);edit(t=>{const target=event.key==='Home'?0:event.key==='End'?t.buffer.duration:t[endpoint]+delta;t[endpoint]=endpoint==='start'?clamp(target,0,t.end-minimum(t)):clamp(target,t.start+minimum(t),t.buffer.duration);t.cursor=t.start;});});
  async function importFiles(files){
    if(importing||timelineJob){toast('正在处理音频，请稍候。');return;}if(!files.length)return;importing=true;$('import-btn').disabled=true;let success=0,errors=[];
    try{for(const file of files){
      try{if(file.size>100*1024*1024)throw Error('文件超过 100 MB，请先拆分后导入');status('正在读取 '+file.name+'…',true);await new Promise(resolve=>setTimeout(resolve,20));
        let buffer=await context().decodeAudioData(await file.arrayBuffer());
        if(buffer.numberOfChannels>2){const offline=new OfflineAudioContext(2,buffer.length,buffer.sampleRate),s=offline.createBufferSource();s.buffer=buffer;s.connect(offline.destination);s.start();buffer=await offline.startRendering();}
        const memory=tracks.reduce((sum,t)=>sum+t.buffer.length*t.buffer.numberOfChannels*4,0)+buffer.length*buffer.numberOfChannels*4;
        if(memory>384*1024*1024)throw Error('音频资料库内存已满，请先移除一些音频');
        if(buffer.duration<=0||!Number.isFinite(buffer.duration))throw Error('音频时长无效');
        const track=makeTrack(file.name,buffer,file.size);tracks.push(track);activate(track);pruneHistory();success++;
      }catch(error){errors.push(file.name+'：'+(error.name==='EncodingError'?'格式暂不支持或文件已损坏，请尝试 WAV / MP3。':error.message));}
    }}finally{importing=false;$('import-btn').disabled=false;$('file-input').value='';status(success?'已导入 '+success+' 个音频':'导入未完成');render();if(errors.length)toast(errors.join('；'));else toast('已导入 '+success+' 个音频');}
  }
  function ensureEditCapacity(newLength){const active=tracks.reduce((sum,t)=>sum+t.buffer.length*t.buffer.numberOfChannels*4,0),additional=newLength*current.buffer.numberOfChannels*4;if(active+additional>384*1024*1024)throw Error('本次编辑需要更多内存，请缩短选区或移除其他音频。');}
  function commitTimeline(channels,before,range,cursor){const buffer=context().createBuffer(channels.length,channels[0].length,current.buffer.sampleRate);channels.forEach((data,c)=>buffer.copyToChannel(data,c));const analysis=analyzeBuffer(buffer);Object.assign(current,{buffer,...analysis,...range,cursor,timelineEdited:true});clean(current);remember(before);processed=null;render();}
  function syncStretchTarget(value,updateInput=true){if(!current)return;const original=current.end-current.start,min=Number($('stretch-duration').min),max=Number($('stretch-duration').max);if(!Number.isFinite(value)||value<=0)return;const target=clamp(value,min,max),percent=target/original*100;if(updateInput)$('stretch-duration').value=target.toFixed(3);$('stretch-ratio').value=percent.toFixed(1).replace('.0','')+'%';$('stretch-percent').value=Math.round(percent);const fill=(percent-Number($('stretch-percent').min))/(400-Number($('stretch-percent').min))*100;$('stretch-percent').style.background=`linear-gradient(to right,#b6cc7d ${fill}%,#252a1d ${fill}%)`;for(const button of document.querySelectorAll('[data-stretch]')){const duration=original*Number(button.dataset.stretch);button.disabled=duration<min-.00001||duration>max+.00001;button.classList.toggle('active',Math.abs(percent-Number(button.dataset.stretch)*100)<.1);}}
  function openStretch(target){if(!current||importing||timelineJob)return false;pause();const duration=current.end-current.start;if(duration<.02){toast('请至少选择 0.020 秒音频再进行拉伸。');return false;}$('stretch-original').replaceChildren(document.createTextNode(duration.toFixed(3)+' '));const unit=document.createElement('small');unit.textContent='秒';$('stretch-original').append(unit);$('stretch-duration').min=(Math.ceil(Math.max(.02,duration*.25)*1000)/1000).toFixed(3);$('stretch-duration').max=(Math.floor(duration*4*1000)/1000).toFixed(3);$('stretch-percent').min=Math.ceil(Math.max(.02,duration*.25)/duration*100);$('stretch-progress').hidden=true;syncStretchTarget(typeof target==='number'?target:duration*1.25);$('stretch-dialog').showModal();return true;}
  function abortError(){const error=Error('操作已取消');error.name='AbortError';return error;}
  function cancelTimeline(){if(timelineJob){timelineJob.cancelled=true;if(timelineJob.abort)timelineJob.abort();}}
  async function renderStretch(channels,rate,frames,job){
    const progress=value=>{if(job.cancelled)throw abortError();$('stretch-progress-text').textContent='正在拉伸 '+Math.round(value*100)+'%';$('stretch-progress-bar').value=value;};
    if(window.Worker){
      const code='var _scriptName; const createModule='+SignalsmithStretchModule.toString()+'; const stretch='+AudioStretch.stretchAudio.toString()+'; self.onmessage=async e=>{try{const data=e.data;const result=await stretch(data.channels,data.rate,data.frames,createModule,value=>self.postMessage({progress:value}));self.postMessage({channels:result},result.map(c=>c.buffer));}catch(error){self.postMessage({error:error.message});}};';
      const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));let worker;
      try{return await new Promise((resolve,reject)=>{try{worker=new Worker(url);}catch(error){error.workerUnavailable=true;reject(error);return;}job.abort=()=>{worker.terminate();reject(abortError());};worker.onmessage=event=>{if(job.cancelled)return;if(event.data.error)reject(Error(event.data.error));else if(event.data.channels)resolve(event.data.channels);else progress(event.data.progress);};worker.onerror=()=>{const error=Error('浏览器暂时无法启动后台处理');error.workerUnavailable=true;reject(error);};worker.postMessage({channels,rate,frames});});}
      catch(error){if(job.cancelled||!error.workerUnavailable)throw error;}
      finally{if(worker)worker.terminate();URL.revokeObjectURL(url);job.abort=null;}
    }
    return AudioStretch.stretchAudio(channels,rate,frames,SignalsmithStretchModule,progress);
  }
  async function applyStretch(event){
    event.preventDefault();if(!current||timelineJob)return;const duration=Number($('stretch-duration').value),rate=current.buffer.sampleRate,[start,end]=AudioCore.selectionFrames(current.start,current.end,rate,current.buffer.length),frames=clamp(Math.round(duration*rate),Math.ceil((end-start)*.25),(end-start)*4),ratio=frames/(end-start);
    if(!Number.isFinite(duration)||duration<.02||ratio<.2499||ratio>4.0001){toast('请输入有效的目标时长，范围为原片段的 25% 至 400%。');return;}if(frames===end-start){$('stretch-dialog').close();toast('目标时长与原片段相同，无需拉伸。');return;}
    try{ensureEditCapacity(current.buffer.length-(end-start)+frames);}catch(error){toast(error.message);return;}
    pause();const job={track:current,before:snapshot(current),cancelled:false,abort:null};timelineJob=job;const controls=[...$('stretch-form').querySelectorAll('input,button[data-stretch],button[type="submit"]')];controls.forEach(control=>control.disabled=true);$('stretch-progress').hidden=false;$('stretch-progress-text').textContent='正在准备拉伸…';$('stretch-progress-bar').value=0;status('正在拉伸选区…',true);
    try{const input=current.channels.map(c=>c.slice(start,end));const replacement=await renderStretch(input,rate,frames,job);if(job.cancelled)throw abortError();if(current!==job.track)throw Error('音频已切换，请重新选择片段。');const result=AudioCore.replaceRange(current.channels,start,end,replacement);commitTimeline(result,job.before,{start:start/rate,end:(start+frames)/rate},start/rate);$('stretch-dialog').close();status('选区已拉伸至 '+duration.toFixed(3)+' 秒');toast('拉伸完成，后续内容已自动移动。');}
    catch(error){if(error.name==='AbortError'){status('已取消拉伸');}else{$('stretch-progress-text').textContent='拉伸失败：'+error.message;status('拉伸失败');toast(error.message);}}
    finally{timelineJob=null;controls.forEach(control=>control.disabled=false);document.body.classList.remove('is-busy');if($('stretch-dialog').open)syncStretchTarget(Number($('stretch-duration').value));render();}
  }
  function openSilence(){if(!current||importing||timelineJob)return;pause();$('silence-position').value=formatTime(current.cursor);$('silence-duration').value='0.5';syncSilencePresets();$('silence-dialog').showModal();}
  function syncSilencePresets(){for(const button of document.querySelectorAll('[data-silence]'))button.classList.toggle('active',Number(button.dataset.silence)===Number($('silence-duration').value));}
  function applySilence(event){event.preventDefault();if(!current||timelineJob)return;const position=parseTime($('silence-position').value),seconds=Number($('silence-duration').value),rate=current.buffer.sampleRate;if(!Number.isFinite(position)||position<0||position>Math.round(current.buffer.duration*1000)/1000){toast('插入位置需要位于音频范围内，可以在开头或结尾插入。');return;}if(!Number.isFinite(seconds)||seconds<.001||seconds>600){toast('空白时长需在 0.001 秒至 600 秒之间。');return;}
    try{const frames=Math.max(1,Math.round(seconds*rate)),at=clamp(Math.round(position*rate)/rate,0,current.buffer.duration),gap=frames/rate;ensureEditCapacity(current.buffer.length+frames);pause();const before=snapshot(current),result=AudioCore.insertSilence(current.channels,rate,at,seconds);let start=before.start,end=before.end;const point=Math.round(at*rate);if(point<Math.round(start*rate)){start+=gap;end+=gap;}else if(point<=Math.round(end*rate))end+=gap;commitTimeline(result,before,{start,end},at);$('silence-dialog').close();status('已在 '+formatTime(at)+' 插入 '+gap.toFixed(3)+' 秒空白');toast('空白已插入，后续内容已自动后移。');}catch(error){toast('无法插入空白：'+error.message);}
  }
  function exportRange(){return {...settings(current),...($('export-scope').value==='full'?{start:0,end:current.buffer.duration}:{})};}
  function estimateExport(){
    if(!current)return;
    const range=exportRange(),seconds=range.end-range.start;
    const channels=$('export-channels').value==='mono'?1:MixerCore.channelCount(current.buffer.numberOfChannels,range);
    const bytes=$('export-format').value==='mp3'
      ? seconds*Number($('export-bitrate').value)*1000/8
      : seconds*Number($('export-rate').value)*Number($('export-depth').value)/8*channels+44;
    $('export-range').textContent=formatTime(range.start)+' — '+formatTime(range.end)+'　'+seconds.toFixed(3)+' 秒';
    $('export-size').textContent='预计 '+(bytes>=1024*1024?(bytes/1024/1024).toFixed(1)+' MB':Math.max(1,Math.round(bytes/1024))+' KB');
  }
  function syncExportFormat(){
    const format=$('export-format').value,mp3=format==='mp3',sourceRate=current.buffer.sampleRate;
    const rates=mp3?[48000,44100,32000]:[...new Set([48000,44100,sourceRate])];
    const nearest=rates.reduce((a,b)=>Math.abs(a-sourceRate)<=Math.abs(b-sourceRate)?a:b);
    $('export-rate').replaceChildren(...rates.map(rate=>new Option(rate.toLocaleString('en-US')+' Hz',rate)));
    $('export-rate').value=nearest;
    $('export-wav-settings').hidden=mp3;$('export-mp3-settings').hidden=!mp3;
    $('export-extension').textContent='.'+format;
    $('export-confirm-label').textContent='导出 '+format.toUpperCase();
    estimateExport();
  }
  function openExport(){
    if(!current||importing||timelineJob||exporting)return;
    pause();
    $('export-name').value=current.name+'_剪辑';$('export-track-name').textContent=current.name;
    $('export-scope').value=current.timelineEdited?'full':'selection';
    $('export-progress').hidden=true;$('download-again').hidden=true;
    syncExportFormat();
    $('export-dialog').showModal();
  }
  async function encodeOffThread(channels,rate,depth){
    if(!window.Worker)return encodeWav(channels,rate,depth);
    const url=URL.createObjectURL(new Blob(['const encodeWav='+encodeWav.toString()+'; self.onmessage = e => {try{const result=encodeWav(e.data.channels,e.data.rate,e.data.depth);self.postMessage({buffer:result},[result]);}catch(error){self.postMessage({error:error.message});}};'],{type:'text/javascript'}));
    try{return await new Promise((resolve,reject)=>{const worker=new Worker(url);worker.onmessage=event=>{worker.terminate();event.data.error?reject(Error(event.data.error)):resolve(event.data.buffer);};worker.onerror=event=>{worker.terminate();reject(Error(event.message||'音频编码失败'));};worker.postMessage({channels,rate,depth});});}
    catch{return encodeWav(channels,rate,depth);}finally{URL.revokeObjectURL(url);}
  }
  async function encodeMp3(channels,rate,bitrate){
    if(!window.lamejs?.Mp3Encoder)throw Error('MP3 编码器未加载');
    const encoder=new window.lamejs.Mp3Encoder(channels.length,rate,bitrate);
    const parts=[],blockSize=1152,pcm=channels.map(()=>new Int16Array(blockSize));
    for(let offset=0;offset<channels[0].length;offset+=blockSize){
      const count=Math.min(blockSize,channels[0].length-offset);
      for(let ch=0;ch<channels.length;ch++){
        for(let i=0;i<count;i++){
          const sample=clamp(channels[ch][offset+i],-1,1);
          pcm[ch][i]=Math.round(sample*(sample<0?32768:32767));
        }
      }
      const left=pcm[0].subarray(0,count);
      const bytes=channels.length===1?encoder.encodeBuffer(left):encoder.encodeBuffer(left,pcm[1].subarray(0,count));
      if(bytes.length)parts.push(bytes);
      if(offset%(blockSize*20)===0){
        $('export-progress').textContent='正在编码 MP3 '+Math.floor(offset/channels[0].length*100)+'%…';
        await new Promise(resolve=>setTimeout(resolve,0));
      }
    }
    parts.push(encoder.flush());
    return new Blob(parts,{type:'audio/mpeg'});
  }
  async function exportAudio(event){
    event.preventDefault();
    if(!current||exporting)return;
    const name=$('export-name').value.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g,'_').replace(/\.(wav|mp3)$/i,'').trim();
    if(!name){$('export-name').focus();toast('请为导出的音频命名。');return;}
    const format=$('export-format').value,filename=name+'.'+format;
    const rate=Number($('export-rate').value),depth=Number($('export-depth').value);
    const bitrate=Number($('export-bitrate').value),mono=$('export-channels').value==='mono',range=exportRange();
    const controls=[...$('export-form').querySelectorAll('input,select,button')];
    exporting=true;
    controls.forEach(control=>control.disabled=true);
    $('download-again').hidden=true;
    $('export-progress').hidden=false;
    $('export-progress').textContent='正在处理音频…';
    status('正在导出音频…',true);
    try{
      await new Promise(resolve=>setTimeout(resolve,40));let buffer=prepareSelection(range);
      if(mono&&buffer.numberOfChannels>1){const result=context().createBuffer(1,buffer.length,buffer.sampleRate),data=result.getChannelData(0);for(let ch=0;ch<buffer.numberOfChannels;ch++){const src=buffer.getChannelData(ch);for(let i=0;i<data.length;i++)data[i]+=src[i]/buffer.numberOfChannels;}buffer=result;}
      if(buffer.sampleRate!==rate){const offline=new OfflineAudioContext(buffer.numberOfChannels,Math.max(1,Math.round(buffer.duration*rate)),rate),s=offline.createBufferSource();s.buffer=buffer;s.connect(offline.destination);s.start();buffer=await offline.startRendering();}
      $('export-progress').textContent='正在编码 '+format.toUpperCase()+'…';
      const channels=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i));
      const blob=format==='mp3'?await encodeMp3(channels,rate,bitrate):new Blob([await encodeOffThread(channels,rate,depth)],{type:'audio/wav'});
      if(downloadUrl)URL.revokeObjectURL(downloadUrl);
      downloadUrl=URL.createObjectURL(blob);
      const link=$('download-again');link.href=downloadUrl;link.download=filename;link.hidden=false;link.click();
      $('export-progress').textContent='已生成 '+filename;
      $('export-cancel').textContent='完成';status('已导出 '+filename);
    }catch(error){$('export-progress').textContent='导出失败：'+error.message;status('导出失败');toast('导出失败，请缩短选区后重试。');}
    finally{exporting=false;controls.forEach(control=>control.disabled=false);document.body.classList.remove('is-busy');}
  }
  $('import-btn').onclick=$('empty-import').onclick=()=>$('file-input').click();$('file-input').onchange=event=>importFiles([...event.target.files]);
  $('play-btn').onclick=togglePlay;$('loop-btn').onclick=toggleLoop;$('jump-start').onclick=()=>{if(current)seek(current.start);};$('jump-end').onclick=()=>{if(current){pause();current.cursor=current.end;renderPlayhead();}};
  playbackProgress.addEventListener('input',()=>{
    if(!current)return;
    const position=playbackProgress.valueAsNumber;
    if(!progressDrag){
      const resume=playing||!!mixResumeTimer;
      pause();
      progressDrag={resume};
    }
    current.cursor=position;
    renderPlayhead();
    revealPlayhead();
  });
  function finishProgressDrag(){
    if(!progressDrag)return;
    const {resume}=progressDrag;
    progressDrag=null;
    if(resume&&current.cursor<current.end)play();
    else if(resume)status('播放完成');
  }
  for(const event of ['change','pointercancel','blur'])playbackProgress.addEventListener(event,finishProgressDrag);
  $('speed').onchange=()=>{const resume=playing;pause();if(resume)play();};$('zoom-in').onclick=()=>setZoom(zoom*1.5);$('zoom-out').onclick=()=>setZoom(zoom/1.5);$('zoom-fit').onclick=()=>setZoom(1);
  $('undo-btn').onclick=()=>history('undo');$('redo-btn').onclick=()=>history('redo');$('start-input').onchange=()=>setTime('start');$('end-input').onchange=()=>setTime('end');
  for(const id of ['start-input','end-input'])$(id).addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();event.target.blur();}});
  $('select-all').onclick=()=>edit(t=>{t.start=0;t.end=t.buffer.duration;t.cursor=0;});$('reset-selection').onclick=()=>{edit(t=>{t.start=0;t.end=t.buffer.duration;t.cursor=0;t.volume=1;t.fadeIn=0;t.fadeOut=0;t.normalize=false;});status('已重置选区、音量与淡入淡出');};
  $('gain').addEventListener('input',()=>{if(!current)return;if(!gainBefore)gainBefore=snapshot(current);liveEdit(t=>{t.volume=Number($('gain').value);},false);});
  $('gain').addEventListener('change',()=>{if(gainBefore){remember(gainBefore);gainBefore=null;render();}});
  for(const [id,key] of [['fade-in','fadeIn'],['fade-out','fadeOut']])$(id).onchange=()=>{const value=Number($(id).value);liveEdit(t=>t[key]=Number.isFinite(value)?value:0);};
  $('normalize').onchange=()=>liveEdit(t=>t.normalize=$('normalize').checked);
  const enableFor={low:'eqOn',mid:'eqOn',high:'eqOn',reverbMix:'reverbOn'};
  for(const input of document.querySelectorAll('[data-fx]')){
    const change=(record=true)=>{if(!current)return;const k=input.dataset.fx,value=input.type==='checkbox'?input.checked:clamp(Number(input.value),Number(input.min),Number(input.max));if(typeof value==='number'&&!Number.isFinite(value))return;liveEdit(t=>{t.fx[k]=value;if(enableFor[k])t.fx[enableFor[k]]=true;},record);};
    if(input.type==='range'){input.oninput=()=>{if(!current)return;if(!fxBefore)fxBefore=snapshot(current);change(false);};input.onchange=()=>{if(fxBefore){remember(fxBefore);fxBefore=null;render();}};}else input.onchange=()=>change();
  }
  $('reset-mix').onclick=()=>{auditionOriginal=false;liveEdit(t=>{t.fx=MixerCore.defaults();t.volume=1;t.fadeIn=t.fadeOut=0;t.normalize=false;});status('调音已重置');};
  $('bypass-btn').onclick=()=>{const resume=playing||!!mixResumeTimer;pause();auditionOriginal=!auditionOriginal;processed=null;renderMixer();if(resume)play();status(auditionOriginal?'正在对比原始选区':'已恢复调音试听');};
  $('clip-reset').onclick=()=>{clipLatch=0;updateMeters(playing);};
  $('stretch-btn').onclick=()=>openStretch();$('stretch-form').onsubmit=applyStretch;$('stretch-percent').oninput=()=>{if(current)syncStretchTarget((current.end-current.start)*Number($('stretch-percent').value)/100);};$('stretch-duration').oninput=()=>syncStretchTarget(Number($('stretch-duration').value),false);$('stretch-duration').onchange=()=>syncStretchTarget(Number($('stretch-duration').value));for(const button of document.querySelectorAll('[data-stretch]'))button.onclick=()=>{if(current)syncStretchTarget((current.end-current.start)*Number(button.dataset.stretch));};
  $('silence-btn').onclick=openSilence;$('silence-form').onsubmit=applySilence;$('silence-duration').oninput=syncSilencePresets;for(const button of document.querySelectorAll('[data-silence]'))button.onclick=()=>{$('silence-duration').value=button.dataset.silence;syncSilencePresets();};for(const button of document.querySelectorAll('[data-position]'))button.onclick=()=>{if(current)$('silence-position').value=formatTime(current[button.dataset.position]);};
  $('export-btn').onclick=openExport;$('export-form').onsubmit=exportAudio;
  $('export-format').onchange=syncExportFormat;
  for(const id of ['export-rate','export-depth','export-bitrate','export-channels','export-scope'])$(id).onchange=estimateExport;
  $('help-btn').onclick = () => {
    $('audio-shortcuts').hidden = activeTab !== 'audio';
    $('video-shortcuts').hidden = activeTab !== 'video';
    $('help-dialog').showModal();
  };
  for(const button of document.querySelectorAll('.close-dialog'))button.onclick=()=>{if(!exporting){const dialog=button.closest('dialog');if(dialog.id==='stretch-dialog')cancelTimeline();dialog.close();}};
  $('stretch-dialog').addEventListener('close',cancelTimeline);
  $('export-dialog').addEventListener('close',()=>{$('export-cancel').textContent='取消';});$('export-dialog').addEventListener('cancel',event=>{if(exporting)event.preventDefault();});
  for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',event=>{if(event.target===dialog&&!exporting){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  let activeGuide=null,guideTimer=0;
  function positionGuide(){
    if(!activeGuide)return;
    const {button,popup}=activeGuide,margin=10,gap=6;
    const anchor=button.getBoundingClientRect();
    if(!button.getClientRects().length||anchor.bottom<0||anchor.top>window.innerHeight){closeGuide();return;}
    const width=popup.offsetWidth,height=popup.offsetHeight;
    const top=anchor.bottom+gap+height<=window.innerHeight-margin?anchor.bottom+gap:anchor.top-gap-height;
    popup.style.left=clamp(anchor.left,margin,window.innerWidth-width-margin)+'px';
    popup.style.top=clamp(top,margin,window.innerHeight-height-margin)+'px';
  }
  function closeGuide(){
    clearTimeout(guideTimer);
    if(!activeGuide)return;
    const {popup}=activeGuide;
    if(popup.hidePopover)popup.hidePopover();else popup.classList.remove('guide-open');
    activeGuide=null;
  }
  function openGuide(button,popup){
    clearTimeout(guideTimer);
    if(activeGuide?.popup!==popup){
      closeGuide();
      if(popup.showPopover)popup.showPopover();else popup.classList.add('guide-open');
      activeGuide={button,popup};
    }
    positionGuide();
  }
  for(const button of document.querySelectorAll('.guide-button')){
    const popup=$(button.getAttribute('aria-describedby'));
    const show=()=>openGuide(button,popup);
    const scheduleClose=()=>{
      clearTimeout(guideTimer);
      guideTimer=setTimeout(()=>{
        if(activeGuide?.popup===popup&&!button.matches(':hover,:focus-visible')&&!popup.matches(':hover'))closeGuide();
      },150);
    };
    button.addEventListener('pointerenter',show);
    button.addEventListener('pointerleave',scheduleClose);
    button.addEventListener('focus',show);
    button.addEventListener('blur',scheduleClose);
    button.addEventListener('click',show);
    popup.addEventListener('pointerenter',()=>clearTimeout(guideTimer));
    popup.addEventListener('pointerleave',scheduleClose);
    button.closest('dialog')?.addEventListener('close',()=>{
      if(activeGuide?.popup===popup)closeGuide();
    });
  }
  document.addEventListener('pointerdown',event=>{
    if(activeGuide&&!event.target.closest('.guide-anchor'))closeGuide();
  });
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&activeGuide){event.preventDefault();closeGuide();}
  });
  window.addEventListener('scroll',positionGuide,true);
  window.addEventListener('resize',positionGuide);
  const tabs = ['audio', 'video'];
  function activateTab(name) {
    if (name === activeTab) return;
    closeGuide();
    if (activeTab === 'audio') pause();
    else VideoEditor.pause();
    activeTab = name;
    for (const tab of tabs) {
      const active = tab === name;
      $(tab + '-tab').setAttribute('aria-selected', String(active));
      $(tab + '-tab').tabIndex = active ? 0 : -1;
      $(tab + '-panel').hidden = !active;
    }
    if (name === 'audio') requestAnimationFrame(() => { renderTimeline(); drawWave(); });
  }
  for (const name of tabs) {
    const tab = $(name + '-tab');
    tab.addEventListener('click', () => activateTab(name));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const target = event.key === 'Home' ? 'audio' : event.key === 'End' ? 'video' : tabs.find(item => item !== name);
      activateTab(target);
      $(target + '-tab').focus();
    });
  }
  document.addEventListener('keydown',event=>{
    if(document.querySelector('dialog[open]'))return;
    if(activeTab==='video'){VideoEditor.handleKeydown(event);return;}
    const modifier=event.metaKey||event.ctrlKey,key=event.key.toLowerCase();
    if(modifier&&key==='o'){event.preventDefault();$('file-input').click();return;}if(modifier&&key==='e'){event.preventDefault();openExport();return;}
    if(event.target.closest('input,textarea,select,.guide-button'))return;
    if(event.code==='Space'&&event.target.closest('button,a'))return;
    if(modifier&&key==='a'){event.preventDefault();$('select-all').click();return;}if(modifier&&key==='z'){event.preventDefault();history(event.shiftKey?'redo':'undo');return;}
    if(modifier||event.altKey)return;
    if(event.code==='Space'){event.preventDefault();togglePlay();}else if(key==='l'){event.preventDefault();toggleLoop();}else if(current&&(key==='['||key===']')){event.preventDefault();const point=current.cursor;if(key==='['&&point<current.end)edit(t=>t.start=point);else if(key===']'&&point>current.start)edit(t=>t.end=point);}
    else if(current&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();seek(current.cursor+(event.key==='ArrowLeft'?-1:1)*(event.shiftKey?1:.1));}
  });
  function hideDropOverlays() {
    $('drop-overlay').hidden = $('video-drop-overlay').hidden = true;
  }
  window.addEventListener('dragenter', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepth++;
    if (!document.querySelector('dialog[open]')) {
      $(activeTab === 'video' ? 'video-drop-overlay' : 'drop-overlay').hidden = false;
    }
  });
  window.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = document.querySelector('dialog[open]') ? 'none' : 'copy';
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) hideDropOverlays();
  });
  window.addEventListener('drop', event => {
    event.preventDefault();
    dragDepth = 0;
    hideDropOverlays();
    if (document.querySelector('dialog[open]')) return;
    const files = [...event.dataTransfer.files];
    if (activeTab === 'video') VideoEditor.importFiles(files);
    else importFiles(files);
  });
  let resizeFrame=0;new ResizeObserver(()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{renderTimeline();drawWave();positionGuide();});}).observe($('wave-scroll'));
  window.addEventListener('pagehide',()=>{pause();if(downloadUrl)URL.revokeObjectURL(downloadUrl);});
  render();status('等待导入音频');
})();
