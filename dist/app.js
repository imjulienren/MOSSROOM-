(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const {clamp,formatTime,parseTime,findPeak,processSelection,encodeWav} = AudioCore;
  const tracks = [];
  let current = null, audioContext = null, source = null, playing = false;
  let sourceOffset = 0, sourceTime = 0, sourceRate = 1, playbackRequest = 0;
  let frame = 0, zoom = 1, importing = false, drag = null, toastTimer = 0;
  let processed = null, exporting = false, downloadUrl = null, dragDepth = 0, timelineJob = null;
  let monitorNode=null,monitorLevel=.8,auditionOriginal=false,mixResumeTimer=0,clipLatch=0,fxBefore=null;
  const audioConstructor = window.AudioContext || window.webkitAudioContext;
  const settings = t => ({start:t.start,end:t.end,gain:t.gain,fadeIn:t.fadeIn,fadeOut:t.fadeOut,normalize:t.normalize,fx:{...MixerCore.defaults(),...t.fx}});
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
  function clean(t) { t.start=clamp(Math.round(t.start*1000)/1000,0,t.buffer.duration-minimum(t)); t.end=clamp(Math.round(t.end*1000)/1000,t.start+minimum(t),t.buffer.duration); t.fadeIn=clamp(t.fadeIn,0,Math.min(10,t.end-t.start)); t.fadeOut=clamp(t.fadeOut,0,Math.min(10,t.end-t.start)); t.gain=clamp(t.gain,-24,12);t.cursor=clamp(t.cursor,0,t.buffer.duration); }
  function edit(update,record=true) { if(!current)return; pause(); const before=snapshot(current); update(current); clean(current); if(record)remember(before); processed=null; render(); }
  function liveEdit(update,record=true){const resume=playing||!!mixResumeTimer;edit(update,record);if(resume)mixResumeTimer=setTimeout(()=>{mixResumeTimer=0;play();},120);}
  const presets={neutral:MixerCore.defaults(),voice:{...MixerCore.defaults(),filterOn:true,hp:90,lp:16000,eqOn:true,low:-2,mid:2,midFreq:2500,high:2.5,compOn:true,threshold:-20,ratio:3,attack:8,release:130,gateOn:true,gateThreshold:-54,limiterOn:true},warm:{...MixerCore.defaults(),filterOn:true,hp:35,lp:14000,eqOn:true,low:2,mid:-1,high:-3,compOn:true,threshold:-16,ratio:2,attack:25,release:180,reverbOn:true,reverbMix:6,reverbDecay:.5,limiterOn:true},podcast:{...MixerCore.defaults(),filterOn:true,hp:80,lp:12000,eqOn:true,mid:2,high:1,compOn:true,threshold:-24,ratio:4,makeup:3,gateOn:true,gateThreshold:-48,mono:true,limiterOn:true},music:{...MixerCore.defaults(),eqOn:true,low:2,high:1.5,compOn:true,threshold:-18,ratio:2,attack:20,release:180,width:110,limiterOn:true}};
  function analyzeBuffer(buffer) {
    const channels=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i));
    const peak=findPeak(channels,0,buffer.length), buckets=Math.min(24000,buffer.length), peaks=new Float32Array(buckets);
    const stride=buffer.length/buckets;
    for(let b=0;b<buckets;b++){ let p=0; const from=Math.floor(b*stride),to=Math.min(buffer.length,Math.ceil((b+1)*stride)); for(const channel of channels)for(let i=from;i<to;i++)p=Math.max(p,Math.abs(channel[i])); peaks[b]=p; }
    return {channels,peak,peaks};
  }
  function makeTrack(name,buffer,size=0,demo=false) {
    const {channels,peak,peaks}=analyzeBuffer(buffer);
    const track={id:crypto.randomUUID?crypto.randomUUID():String(Date.now()+Math.random()),name:name.replace(/\.(mp3|wav|m4a|aac|flac|aiff?|ogg|webm|opus)$/i,''),fullName:name,buffer,channels,size,demo,peak,peaks,start:demo?3.2:0,end:demo?13.6:buffer.duration,cursor:demo?3.2:0,gain:0,fadeIn:0,fadeOut:0,normalize:false,fx:MixerCore.defaults(),timelineEdited:false,history:[],future:[]};
    return track;
  }
  function createDemo() {
    const rate=context().sampleRate, duration=16, buffer=context().createBuffer(2,rate*duration,rate);
    const left=buffer.getChannelData(0),right=buffer.getChannelData(1);
    const melody=[72,76,79,83,79,76,74,79,71,74,78,81,78,74,72,76,69,72,76,79,76,72,67,71,67,71,74,79,74,71,69,67];
    melody.forEach((m,index)=>{
      const frequency=440*Math.pow(2,(m-69)/12), start=Math.floor((index*.46+.16)*rate), length=Math.floor(1.55*rate), pan=.22*Math.sin(index*1.7);
      for(let n=0;n<length&&start+n<left.length;n++){
        const time=n/rate,envelope=Math.min(1,time/.012)*Math.exp(-time*3.7)*.2;
        const tone=(Math.sin(2*Math.PI*frequency*time)+.24*Math.sin(4*Math.PI*frequency*time)+.08*Math.sin(6*Math.PI*frequency*time))*envelope;
        left[start+n]+=tone*(.85-pan); right[start+n]+=tone*(.85+pan);
        const echo=start+n+Math.floor(.18*rate);if(echo<right.length)right[echo]+=tone*.12;
      }
    });
    const chords=[[48,55,60],[47,54,59],[45,52,57],[43,50,55]];
    chords.forEach((notes,c)=>notes.forEach(m=>{const frequency=440*Math.pow(2,(m-69)/12),start=Math.floor((c*3.68+.16)*rate),length=Math.floor(3.5*rate);for(let n=0;n<length&&start+n<left.length;n++){const time=n/rate,value=Math.sin(2*Math.PI*frequency*time)*Math.min(1,time/.05)*Math.exp(-time*1.3)*.045;left[start+n]+=value;right[start+n]+=value*.94;}}));
    for(let i=0;i<left.length;i++){ const endFade=Math.min(1,(left.length-i-1)/(rate*.6));left[i]*=endFade;right[i]*=endFade; }
    const track=makeTrack('晨间随想',buffer,0,true);tracks.push(track);activate(track);return track;
  }
  function activate(track) { pause();current=track;processed=null;clipLatch=0;fxBefore=null;auditionOriginal=false;zoom=1;$('wave-content').style.width='100%';$('wave-scroll').scrollLeft=0;render();requestAnimationFrame(drawWave); }
  function removeTrack(track) { const index=tracks.indexOf(track);if(index<0)return;tracks.splice(index,1);if(current===track){pause();current=tracks[Math.min(index,tracks.length-1)]||null;processed=null;zoom=1;$('wave-content').style.width='100%';}render(); }
  function renderLibrary() {
    $('track-list').replaceChildren();$('track-count').textContent=tracks.length;
    for(const track of tracks){
      const row=document.createElement('div');row.className='track-item'+(track===current?' active':'');
      const choose=document.createElement('button');choose.className='track-select';choose.setAttribute('aria-pressed',String(track===current));choose.title=track.fullName;choose.onclick=()=>activate(track);
      const image=document.createElement('span');image.className='track-icon';image.append(icon('wave'));
      const copy=document.createElement('span');copy.className='track-copy';const name=document.createElement('span');name.className='track-name';name.textContent=track.name;
      const detail=document.createElement('span');detail.className='track-detail';detail.textContent=track.buffer.duration.toFixed(2)+' 秒　'+(track.demo?'演示音频':track.fullName.split('.').pop().toUpperCase());copy.append(name,detail);choose.append(image,copy);
      const remove=document.createElement('button');remove.className='track-remove';remove.title='移除 '+track.name;remove.setAttribute('aria-label','移除 '+track.name);remove.append(icon('close'));remove.onclick=()=>removeTrack(track);row.append(choose,remove);$('track-list').append(row);
    }
    $('sidebar-empty').hidden=tracks.length!==0;
  }
  function render() {
    renderLibrary();$('empty-state').hidden=!!current;$('export-btn').disabled=!current||!!timelineJob;$('stretch-btn').disabled=$('silence-btn').disabled=!current||importing||!!timelineJob;
    if(!current){$('track-title').textContent='开始新的剪辑';$('file-meta').textContent='';return;}
    const t=current, duration=t.buffer.duration;
    $('track-title').textContent=t.name;$('file-meta').textContent=(t.demo?'演示音频　':t.fullName.split('.').pop().toUpperCase()+'　')+(t.buffer.numberOfChannels===1?'单声道':'立体声')+'　'+(t.buffer.sampleRate/1000).toFixed(1).replace('.0','')+' kHz　'+duration.toFixed(2)+' 秒';
    $('demo-badge').hidden=!t.demo&&!t.timelineEdited;$('demo-badge').textContent=t.timelineEdited?'已编辑':'演示';
    $('start-input').value=formatTime(t.start);$('end-input').value=formatTime(t.end);
    $('selection-duration').replaceChildren(document.createTextNode((t.end-t.start).toFixed(3)));const unit=document.createElement('span');unit.textContent='秒';$('selection-duration').append(unit);
    $('selection-time').textContent=(t.end-t.start).toFixed(3)+' s';
    $('selection').style.left=(t.start/duration*100)+'%';$('selection').style.width=((t.end-t.start)/duration*100)+'%';
    for(const endpoint of ['start','end']){const handle=$('handle-'+endpoint);handle.setAttribute('aria-valuemax',String(duration));handle.setAttribute('aria-valuenow',t[endpoint].toFixed(3));handle.setAttribute('aria-valuetext',formatTime(t[endpoint]));}
    $('gain').value=t.gain;$('gain-value').value=(t.gain>0?'+':'')+t.gain.toFixed(1)+' dB';const percent=(t.gain+24)/36*100;$('gain').style.background=`linear-gradient(to right,#b6cc7d ${percent}%,#252a1d ${percent}%)`;
    $('fade-in').value=Number(t.fadeIn.toFixed(3));$('fade-out').value=Number(t.fadeOut.toFixed(3));$('fade-in').max=$('fade-out').max=Math.min(10,t.end-t.start);$('normalize').checked=t.normalize;
    const overload=!!processed?.stats?.clippedSamples;
    $('peak-hint').classList.toggle('warning',overload);$('peak-hint').textContent=overload?'输出削波，请降低增益或开启限制器':'';
    $('undo-btn').disabled=!t.history.length;$('redo-btn').disabled=!t.future.length;
    $('zoom-value').textContent=Math.round(zoom*100)+'%';$('zoom-out').disabled=zoom<=1;$('zoom-in').disabled=zoom>=8;
    renderTimeline();drawWave();renderPlayhead();renderMixer();updateMeters();
  }
  function renderMixer(){
    if(!current)return;const f=current.fx;
    for(const input of document.querySelectorAll('[data-fx]')){const value=f[input.dataset.fx];if(input.type==='checkbox')input.checked=!!value;else if(document.activeElement!==input||input.type==='range')input.value=value;}
    for(const out of document.querySelectorAll('[data-readout]')){const k=out.dataset.readout,v=f[k];out.value=k==='pan'?(v===0?'中央':(v<0?'左 ':'右 ')+Math.abs(v)):(['low','mid','high'].includes(k)&&v>0?'+':'')+v+out.dataset.unit;}
    $('preset').value=Object.keys(presets).find(k=>JSON.stringify(presets[k])===JSON.stringify(f))||'custom';
    $('bypass-btn').setAttribute('aria-pressed',String(auditionOriginal));$('bypass-btn').textContent=auditionOriginal?'正在听原音':'原音对比';renderFXResponse();
  }
  function renderFXResponse(){
    if(!current)return;const canvas=$('fx-response'),w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;
    const dpr=Math.min(devicePixelRatio||1,2);canvas.width=w*dpr;canvas.height=h*dpr;const c=canvas.getContext('2d');c.scale(dpr,dpr);c.fillStyle='#161e14';c.fillRect(0,0,w,h);
    c.strokeStyle='#34402a';c.lineWidth=1;for(const y of [h/4,h/2,h*3/4]){c.beginPath();c.moveTo(0,y);c.lineTo(w,y);c.stroke();}
    const f=current.fx,sr=current.buffer.sampleRate,cs=[];if(f.filterOn)cs.push(MixerCore.coefficients('highpass',f.hp,0,sr),MixerCore.coefficients('lowpass',f.lp,0,sr));if(f.eqOn)cs.push(MixerCore.coefficients('low',120,f.low,sr),MixerCore.coefficients('peak',f.midFreq,f.mid,sr,.85),MixerCore.coefficients('high',8000,f.high,sr));
    c.beginPath();for(let x=0;x<w;x++){const frequency=20*Math.pow(Math.min(20000,sr*.47)/20,x/(w-1)),angle=2*Math.PI*frequency/sr;let gain=1;for(const [b0,b1,b2,a1,a2] of cs){const re=b0+b1*Math.cos(angle)+b2*Math.cos(2*angle),im=-b1*Math.sin(angle)-b2*Math.sin(2*angle),ar=1+a1*Math.cos(angle)+a2*Math.cos(2*angle),ai=-a1*Math.sin(angle)-a2*Math.sin(2*angle);gain*=Math.sqrt((re*re+im*im)/(ar*ar+ai*ai));}const y=clamp(h/2-20*Math.log10(Math.max(1e-8,gain))/36*h,2,h-2);if(x===0)c.moveTo(x,y);else c.lineTo(x,y);}c.strokeStyle='#b6cc7d';c.lineWidth=2;c.stroke();
  }
  function updateMeters(live=false){
    const buffer=processed?.buffer,stats=processed?.stats,peaks=[0,0];let sum=0,count=0;
    if(live&&playing&&current&&buffer){const from=Math.floor(clamp(current.cursor-current.start,0,buffer.duration)*buffer.sampleRate),to=Math.min(buffer.length,from+1024);for(let ch=0;ch<buffer.numberOfChannels;ch++){const data=buffer.getChannelData(ch);for(let i=from;i<to;i++){peaks[ch]=Math.max(peaks[ch],Math.abs(data[i]));sum+=data[i]*data[i];count++;}}if(buffer.numberOfChannels===1)peaks[1]=peaks[0];}
    const db=v=>v>1e-6?(20*Math.log10(v)).toFixed(1):'−∞';
    for(let i=0;i<2;i++){const level=clamp((20*Math.log10(Math.max(1e-6,peaks[i]))+60)/60,0,1),el=$(i?'meter-right':'meter-left');el.style.height=level*100+'%';el.style.setProperty('--level',level);}
    $('meter-peak').value=db(live?Math.max(...peaks):stats?.peak||0);$('meter-rms').value=db(live?Math.sqrt(sum/Math.max(1,count)):stats?.rms||0);$('meter-gr').value=(stats?Math.max(stats.gainReductionDb||0,stats.limitedDb||0):0).toFixed(1);
    $('clip-reset').classList.toggle('clipped',clipLatch>0);$('clip-text').textContent=clipLatch?'削波 '+(clipLatch>999?'999+':clipLatch):'无削波';$('clip-reset').title=clipLatch+' 个样本超出 0 dB，点击清除记录';
    $('peak-hint').classList.toggle('warning',!!stats?.clippedSamples);$('peak-hint').textContent=stats?.clippedSamples?'输出削波，请降低增益或开启限制器':'';
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
      ctx.fillStyle=time>=t.start&&time<=t.end?'#bfd38a':'#638150';ctx.fillRect(Math.round(x),Math.round(height/2-amplitude),2,Math.round(amplitude*2));
    }
    if(t.fadeIn>0||t.fadeOut>0){ctx.strokeStyle='#d1ba7788';ctx.lineWidth=1;ctx.setLineDash([3,3]);ctx.beginPath();const from=t.start/duration*width,to=t.end/duration*width;ctx.moveTo(from,t.fadeIn?height-15:15);if(t.fadeIn)ctx.lineTo((t.start+t.fadeIn)/duration*width,15);if(t.fadeOut){ctx.lineTo((t.end-t.fadeOut)/duration*width,15);ctx.lineTo(to,height-15);}else ctx.lineTo(to,15);ctx.stroke();ctx.setLineDash([]);}
  }
  function renderPlayhead() { if(!current)return;$('playhead').style.left=(clamp(current.cursor,0,current.buffer.duration)/current.buffer.duration*100)+'%';$('playback-time').textContent=formatTime(current.cursor); }
  function setPlaybackUI() { $('play-btn').replaceChildren(icon(playing?'pause':'play'));$('play-btn').setAttribute('aria-label',playing?'暂停':'播放选区');$('play-btn').title=(playing?'暂停':'播放选区')+' Space'; }
  function getPlaybackPosition() {
    if(!playing||!current||!processed)return current?current.cursor:0;
    const elapsed=sourceOffset+(context().currentTime-sourceTime)*sourceRate;
    return current.start+($('loop-btn').getAttribute('aria-pressed')==='true'?elapsed%processed.buffer.duration:Math.min(elapsed,processed.buffer.duration));
  }
  function pause() {
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
      const buffer=prepareSelection({...settings(current),bypassEffects:auditionOriginal});source=context().createBufferSource();source.buffer=buffer;source.loop=$('loop-btn').getAttribute('aria-pressed')==='true';sourceRate=Number($('speed').value);source.playbackRate.value=sourceRate;if(!monitorNode){monitorNode=context().createGain();monitorNode.gain.value=monitorLevel;monitorNode.connect(context().destination);}source.connect(monitorNode);
      sourceOffset=current.cursor>=current.start&&current.cursor<current.end?Math.min(current.cursor-current.start,buffer.duration):0;sourceTime=context().currentTime;const thisSource=source;
      source.onended=()=>{if(source!==thisSource)return;playing=false;source.disconnect();source=null;current.cursor=current.end;cancelAnimationFrame(frame);setPlaybackUI();renderPlayhead();updateMeters();status('播放完成');};
      source.start(0,sourceOffset);playing=true;setPlaybackUI();status(source.loop?'正在循环试听选区':'正在试听选区');animate();
    }catch(error){pause();toast('无法播放音频：'+error.message);status('播放失败');}
  }
  function animate() {
    if(!playing||!current)return;current.cursor=getPlaybackPosition();renderPlayhead();updateMeters(true);
    if(zoom>1){const scroll=$('wave-scroll'),x=current.cursor/current.buffer.duration*$('wave-area').clientWidth+23;if(x>scroll.scrollLeft+scroll.clientWidth-30||x<scroll.scrollLeft+10)scroll.scrollLeft=Math.max(0,x-scroll.clientWidth*.2);}
    frame=requestAnimationFrame(animate);
  }
  function togglePlay(){if(playing||mixResumeTimer){pause();status('已暂停');}else play();}
  function seek(time){if(!current)return;const resume=playing;pause();current.cursor=clamp(time,0,current.buffer.duration);renderPlayhead();if(resume)play();}
  function toggleLoop(){const position=playing?getPlaybackPosition():0,enabled=$('loop-btn').getAttribute('aria-pressed')!=='true';$('loop-btn').setAttribute('aria-pressed',String(enabled));$('loop-label').textContent=enabled?'循环开启':'循环关闭';if(source){sourceOffset=position-current.start;sourceTime=context().currentTime;source.loop=enabled;}status(enabled?'循环播放已开启':'循环播放已关闭');}
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
    }}finally{importing=false;$('import-btn').disabled=false;$('file-input').value='';status(success?'已导入 '+success+' 个音频':'导入未完成');render();if(errors.length)toast(errors.join('；'));else toast('已导入 '+success+' 个音频，拖动波形即可选择片段。');}
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
  function estimateExport(){if(!current)return;const range=exportRange(),channels=$('export-channels').value==='mono'?1:MixerCore.channelCount(current.buffer.numberOfChannels,range);const bytes=(range.end-range.start)*Number($('export-rate').value)*Number($('export-depth').value)/8*channels+44;$('export-range').textContent=formatTime(range.start)+' — '+formatTime(range.end)+'　'+(range.end-range.start).toFixed(3)+' 秒';$('export-size').textContent='预计 '+(bytes>=1024*1024?(bytes/1024/1024).toFixed(1)+' MB':Math.max(1,Math.round(bytes/1024))+' KB');}
  function openExport(){if(!current||timelineJob)return;pause();$('export-name').value=current.name+'_剪辑';$('export-track-name').textContent=current.name;$('export-scope').value=current.timelineEdited?'full':'selection';
    const rate=current.buffer.sampleRate;if(![...$('export-rate').options].some(o=>Number(o.value)===rate))$('export-rate').add(new Option(rate.toLocaleString()+' Hz',String(rate)));$('export-rate').value=String(rate);$('export-progress').hidden=true;$('download-again').hidden=true;estimateExport();$('export-dialog').showModal();}
  async function encodeOffThread(channels,rate,depth){
    if(!window.Worker)return encodeWav(channels,rate,depth);
    const url=URL.createObjectURL(new Blob(['const encodeWav='+encodeWav.toString()+'; self.onmessage = e => {try{const result=encodeWav(e.data.channels,e.data.rate,e.data.depth);self.postMessage({buffer:result},[result]);}catch(error){self.postMessage({error:error.message});}};'],{type:'text/javascript'}));
    try{return await new Promise((resolve,reject)=>{const worker=new Worker(url);worker.onmessage=event=>{worker.terminate();event.data.error?reject(Error(event.data.error)):resolve(event.data.buffer);};worker.onerror=event=>{worker.terminate();reject(Error(event.message||'音频编码失败'));};worker.postMessage({channels,rate,depth});});}
    catch{return encodeWav(channels,rate,depth);}finally{URL.revokeObjectURL(url);}
  }
  async function exportAudio(event){
    event.preventDefault();if(!current||exporting)return;let name=$('export-name').value.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g,'_').replace(/\.wav$/i,'');if(!name){$('export-name').focus();toast('请为导出的音频命名。');return;}
    exporting=true;const track=current;$('export-confirm').disabled=true;$('export-cancel').disabled=true;$('export-dialog').querySelector('.dialog-heading .close-dialog').disabled=true;$('export-progress').hidden=false;$('export-progress').textContent='正在处理选区与声音调整…';status('正在导出音频…',true);
    try{
      await new Promise(resolve=>setTimeout(resolve,40));let buffer=prepareSelection(exportRange());const rate=Number($('export-rate').value),depth=Number($('export-depth').value),mono=$('export-channels').value==='mono';
      if(mono&&buffer.numberOfChannels>1){const result=context().createBuffer(1,buffer.length,buffer.sampleRate),data=result.getChannelData(0);for(let ch=0;ch<buffer.numberOfChannels;ch++){const src=buffer.getChannelData(ch);for(let i=0;i<data.length;i++)data[i]+=src[i]/buffer.numberOfChannels;}buffer=result;}
      if(buffer.sampleRate!==rate){const offline=new OfflineAudioContext(buffer.numberOfChannels,Math.max(1,Math.round(buffer.duration*rate)),rate),s=offline.createBufferSource();s.buffer=buffer;s.connect(offline.destination);s.start();buffer=await offline.startRendering();}
      $('export-progress').textContent='正在编码 WAV…';const channels=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i));const wav=await encodeOffThread(channels,rate,depth);
      if(downloadUrl)URL.revokeObjectURL(downloadUrl);downloadUrl=URL.createObjectURL(new Blob([wav],{type:'audio/wav'}));const link=$('download-again');link.href=downloadUrl;link.download=name+'.wav';link.hidden=false;link.click();
      $('export-progress').textContent='已生成 '+name+'.wav，可点击“再次下载”重新保存。';$('export-cancel').textContent='完成';status('已导出 '+name+'.wav');toast('WAV 已生成，正在下载。');
    }catch(error){$('export-progress').textContent='导出失败：'+error.message;status('导出失败');toast('导出失败，请缩短选区后重试。');}
    finally{exporting=false;$('export-confirm').disabled=false;$('export-cancel').disabled=false;$('export-dialog').querySelector('.dialog-heading .close-dialog').disabled=false;document.body.classList.remove('is-busy');}
  }
  $('import-btn').onclick=$('empty-import').onclick=()=>$('file-input').click();$('file-input').onchange=event=>importFiles([...event.target.files]);$('load-demo').onclick=()=>{try{createDemo();status('演示音频已载入');}catch(error){toast(error.message);}};
  $('play-btn').onclick=togglePlay;$('loop-btn').onclick=toggleLoop;$('jump-start').onclick=()=>{if(current)seek(current.start);};$('jump-end').onclick=()=>{if(current){pause();current.cursor=current.end;renderPlayhead();}};
  $('speed').onchange=()=>{const resume=playing;pause();if(resume)play();};$('zoom-in').onclick=()=>setZoom(zoom*1.5);$('zoom-out').onclick=()=>setZoom(zoom/1.5);$('zoom-fit').onclick=()=>setZoom(1);
  $('undo-btn').onclick=()=>history('undo');$('redo-btn').onclick=()=>history('redo');$('start-input').onchange=()=>setTime('start');$('end-input').onchange=()=>setTime('end');
  for(const id of ['start-input','end-input'])$(id).addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();event.target.blur();}});
  $('select-all').onclick=()=>edit(t=>{t.start=0;t.end=t.buffer.duration;t.cursor=0;});$('reset-selection').onclick=()=>{edit(t=>{t.start=0;t.end=t.buffer.duration;t.cursor=0;t.gain=0;t.fadeIn=0;t.fadeOut=0;t.normalize=false;});status('已重置选区、增益与淡入淡出');};
  let gainBefore=null;
  $('gain').addEventListener('input',()=>{if(!current)return;if(!gainBefore)gainBefore=snapshot(current);liveEdit(t=>{t.gain=Number($('gain').value);},false);});
  $('gain').addEventListener('change',()=>{if(gainBefore){remember(gainBefore);gainBefore=null;render();}});
  for(const [id,key] of [['fade-in','fadeIn'],['fade-out','fadeOut']])$(id).onchange=()=>{const value=Number($(id).value);liveEdit(t=>t[key]=Number.isFinite(value)?value:0);};
  $('normalize').onchange=()=>liveEdit(t=>t.normalize=$('normalize').checked);
  const enableFor={hp:'filterOn',lp:'filterOn',low:'eqOn',mid:'eqOn',high:'eqOn',midFreq:'eqOn',threshold:'compOn',ratio:'compOn',attack:'compOn',release:'compOn',makeup:'compOn',gateThreshold:'gateOn',gateRelease:'gateOn',reverbMix:'reverbOn',reverbDecay:'reverbOn',delayMix:'delayOn',delayTime:'delayOn',delayFeedback:'delayOn',ceiling:'limiterOn'};
  for(const input of document.querySelectorAll('[data-fx]')){
    const change=(record=true)=>{if(!current)return;const k=input.dataset.fx,value=input.type==='checkbox'?input.checked:clamp(Number(input.value),Number(input.min),Number(input.max));if(typeof value==='number'&&!Number.isFinite(value))return;liveEdit(t=>{t.fx[k]=value;if(enableFor[k])t.fx[enableFor[k]]=true;},record);};
    if(input.type==='range'){input.oninput=()=>{if(!current)return;if(!fxBefore)fxBefore=snapshot(current);change(false);};input.onchange=()=>{if(fxBefore){remember(fxBefore);fxBefore=null;render();}};}else input.onchange=()=>change();
  }
  $('preset').onchange=()=>{const p=presets[$('preset').value];if(!p)return;auditionOriginal=false;liveEdit(t=>t.fx={...p});status('调音预设已应用');};
  $('reset-mix').onclick=()=>{auditionOriginal=false;liveEdit(t=>{t.fx=MixerCore.defaults();t.gain=0;t.fadeIn=t.fadeOut=0;t.normalize=false;});status('调音已重置');};
  $('bypass-btn').onclick=()=>{const resume=playing||!!mixResumeTimer;pause();auditionOriginal=!auditionOriginal;processed=null;renderMixer();if(resume)play();status(auditionOriginal?'正在对比原始选区':'已恢复调音试听');};
  $('monitor-volume').oninput=()=>{monitorLevel=Number($('monitor-volume').value)/100;$('monitor-value').value=Math.round(monitorLevel*100)+'%';if(monitorNode)monitorNode.gain.setTargetAtTime(monitorLevel,context().currentTime,.01);};
  $('clip-reset').onclick=()=>{clipLatch=0;updateMeters(playing);};
  $('stretch-btn').onclick=()=>openStretch();$('stretch-form').onsubmit=applyStretch;$('stretch-percent').oninput=()=>{if(current)syncStretchTarget((current.end-current.start)*Number($('stretch-percent').value)/100);};$('stretch-duration').oninput=()=>syncStretchTarget(Number($('stretch-duration').value),false);$('stretch-duration').onchange=()=>syncStretchTarget(Number($('stretch-duration').value));for(const button of document.querySelectorAll('[data-stretch]'))button.onclick=()=>{if(current)syncStretchTarget((current.end-current.start)*Number(button.dataset.stretch));};
  $('silence-btn').onclick=openSilence;$('silence-form').onsubmit=applySilence;$('silence-duration').oninput=syncSilencePresets;for(const button of document.querySelectorAll('[data-silence]'))button.onclick=()=>{$('silence-duration').value=button.dataset.silence;syncSilencePresets();};for(const button of document.querySelectorAll('[data-position]'))button.onclick=()=>{if(current)$('silence-position').value=formatTime(current[button.dataset.position]);};
  $('export-btn').onclick=openExport;$('export-form').onsubmit=exportAudio;for(const id of ['export-rate','export-depth','export-channels','export-scope'])$(id).onchange=estimateExport;
  $('tutorial-btn').onclick=()=>{const hidden=document.body.classList.toggle('hide-guides');$('tutorial-btn').setAttribute('aria-pressed',String(!hidden));$('tutorial-btn').textContent=hidden?'显示说明':'隐藏说明';};
  $('help-btn').onclick=()=>$('help-dialog').showModal();for(const button of document.querySelectorAll('.close-dialog'))button.onclick=()=>{if(!exporting){const dialog=button.closest('dialog');if(dialog.id==='stretch-dialog')cancelTimeline();dialog.close();}};
  $('stretch-dialog').addEventListener('close',cancelTimeline);
  $('export-dialog').addEventListener('close',()=>{$('export-cancel').textContent='取消';});$('export-dialog').addEventListener('cancel',event=>{if(exporting)event.preventDefault();});
  for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',event=>{if(event.target===dialog&&!exporting){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  document.addEventListener('keydown',event=>{
    if(document.querySelector('dialog[open]'))return;const modifier=event.metaKey||event.ctrlKey,key=event.key.toLowerCase();
    if(modifier&&key==='o'){event.preventDefault();$('file-input').click();return;}if(modifier&&key==='e'){event.preventDefault();openExport();return;}
    if(event.target.closest('input,textarea,select'))return;
    if(modifier&&key==='a'){event.preventDefault();$('select-all').click();return;}if(modifier&&key==='z'){event.preventDefault();history(event.shiftKey?'redo':'undo');return;}
    if(modifier||event.altKey)return;
    if(event.code==='Space'){event.preventDefault();togglePlay();}else if(key==='l'){event.preventDefault();toggleLoop();}else if(current&&(key==='['||key===']')){event.preventDefault();const point=current.cursor;if(key==='['&&point<current.end)edit(t=>t.start=point);else if(key===']'&&point>current.start)edit(t=>t.end=point);}
    else if(current&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();seek(current.cursor+(event.key==='ArrowLeft'?-1:1)*(event.shiftKey?1:.1));}
  });
  window.addEventListener('dragenter',event=>{if([...event.dataTransfer.types].includes('Files')){event.preventDefault();dragDepth++;$('drop-overlay').hidden=false;}});
  window.addEventListener('dragover',event=>{if([...event.dataTransfer.types].includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy';}});
  window.addEventListener('dragleave',event=>{event.preventDefault();dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('drop-overlay').hidden=true;});
  window.addEventListener('drop',event=>{event.preventDefault();dragDepth=0;$('drop-overlay').hidden=true;if(document.querySelector('dialog[open]'))return;importFiles([...event.dataTransfer.files]);});
  let resizeFrame=0;new ResizeObserver(()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{renderTimeline();drawWave();renderFXResponse();});}).observe($('wave-scroll'));
  window.addEventListener('pagehide',()=>{pause();if(downloadUrl)URL.revokeObjectURL(downloadUrl);});
  try{createDemo();status('就绪');}catch(error){render();toast(error.message);}
})();
