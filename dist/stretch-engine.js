(function(root) {
  'use strict';
  // Standalone to support a Blob Worker and direct offline-file use.
  async function stretchAudio(channels, sampleRate, targetFrames, createModule, progress) {
    const sourceFrames=channels[0]?.length;
    if(!sourceFrames||channels.some(c=>c.length!==sourceFrames)||!Number.isInteger(targetFrames)||targetFrames<1) throw Error('拉伸参数无效');
    const ratio=targetFrames/sourceFrames;
    if(ratio<.24999||ratio>4.00001) throw Error('拉伸长度需在原片段的 25% 至 400% 之间');
    if(targetFrames===sourceFrames) return channels.map(c=>c.slice());
    const wasm=await createModule();
    wasm._main();wasm._presetDefault(channels.length,sampleRate);
    // Short sounds benefit from a smaller analysis window.
    const shortest=Math.min(sourceFrames,targetFrames);
    if(shortest<sampleRate*.24){const block=Math.max(64,Math.round(Math.min(sampleRate*.12,shortest*.5)/4)*4);wasm._configure(channels.length,block,Math.max(16,Math.round(block/4)),false);}
    wasm._reset();wasm._setTransposeSemitones(0,8000/sampleRate);
    const inputLatency=wasm._inputLatency(),outputLatency=wasm._outputLatency(),quantum=1024,rate=sourceFrames/targetFrames;
    const capacity=Math.max(inputLatency,Math.ceil(quantum*rate)+2,quantum),pointer=wasm._setBuffers(channels.length,capacity)/4;
    function inputViews(){const heap=new Float32Array(wasm.HEAP8.buffer);return channels.map((_,c)=>heap.subarray(pointer+c*capacity,pointer+(c+1)*capacity));}
    function feed(position,count){const views=inputViews();for(let c=0;c<channels.length;c++){views[c].fill(0,0,count);const from=Math.max(0,position),end=Math.min(sourceFrames,position+count);if(end>from)views[c].set(channels[c].subarray(from,end),from-position);}}
    feed(0,inputLatency);wasm._seek(inputLatency,rate);
    const result=channels.map(()=>new Float32Array(targetFrames)),total=targetFrames+outputLatency;
    for(let offset=0,blocks=0;offset<total;blocks++){
      const count=Math.min(quantum,total-offset),inputStart=Math.round(offset*rate),inputEnd=Math.round((offset+count)*rate);
      feed(inputLatency+inputStart,inputEnd-inputStart);wasm._process(inputEnd-inputStart,count);
      const from=Math.max(offset,outputLatency),to=Math.min(offset+count,total),heap=new Float32Array(wasm.HEAP8.buffer);
      if(to>from)for(let c=0;c<channels.length;c++){const out=pointer+(c+channels.length)*capacity;result[c].set(heap.subarray(out+from-offset,out+to-offset),from-outputLatency);}
      offset+=count;
      if(blocks%16===0){if(progress)progress(Math.min(1,offset/total));await new Promise(resolve=>setTimeout(resolve,0));}
    }
    // Blend only inside the edited segment to match the original splice edges.
    const edge=Math.min(Math.round(sampleRate*.005),Math.floor(Math.min(sourceFrames,targetFrames)/4));
    for(let c=0;c<channels.length;c++)for(let i=0;i<edge;i++){
      const mix=edge>1?.5-.5*Math.cos(Math.PI*i/(edge-1)):0;
      result[c][i]=channels[c][i]*(1-mix)+result[c][i]*mix;
      result[c][targetFrames-1-i]=channels[c][sourceFrames-1-i]*(1-mix)+result[c][targetFrames-1-i]*mix;
    }
    if(progress)progress(1);
    return result;
  }
  if(typeof module!=='undefined'&&module.exports)module.exports={stretchAudio};
  else root.AudioStretch={stretchAudio};
})(typeof globalThis!=='undefined'?globalThis:this);
