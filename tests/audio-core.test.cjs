const assert = require('node:assert/strict');
const core = require('../dist/audio-core.js');
assert.equal(core.formatTime(63.456),'01:03.456');
assert.equal(core.formatTime(59.9998),'01:00.000');
assert.equal(core.parseTime('01:03.456'),63.456);
assert.equal(core.parseTime('1:02:03.456'),3723.456);
assert.equal(core.parseTime('3.25'),3.25);
for(const invalid of ['1:60','1.5:02','-1','bad','1:2:3:4','']) assert(Number.isNaN(core.parseTime(invalid)),invalid);
const source=[new Float32Array([.25,.5,-.5,.75,-1,.5,.25,0])];
const options={start:.25,end:.75,gain:0,normalize:false,fadeIn:0,fadeOut:0};
const trimmed=core.processSelection(source,8,options);
assert.deepEqual(Array.from(trimmed[0]),[-.5,.75,-1,.5]);
const faded=core.processSelection(source,8,{...options,fadeIn:.25,fadeOut:.25});
assert(faded[0][0]===0);assert(faded[0].at(-1)===0);assert.equal(faded[0][1],.375);
const normalized=core.processSelection([new Float32Array([.25,-.5])],2,{start:0,end:1,normalize:true});
assert(Math.abs(Math.abs(normalized[0][1])-Math.pow(10,-1/20))<1e-6);
const clipped=core.processSelection(source,8,{...options,gain:12});
assert.equal(clipped[0][0],-1);assert.equal(clipped[0][1],1);
for(const depth of [16,24]){
 const channels=[new Float32Array([-1,0,1]),new Float32Array([1,0,-1])];
 const buffer=core.encodeWav(channels,48000,depth),view=new DataView(buffer);
 assert.equal(Buffer.from(buffer,0,4).toString(),'RIFF');assert.equal(view.getUint32(24,true),48000);
 assert.equal(view.getUint16(22,true),2);assert.equal(view.getUint16(34,true),depth);assert.equal(view.getUint32(40,true),3*2*depth/8);
 assert.equal(view.getUint32(4,true),buffer.byteLength-8);
 if(depth===16){assert.equal(view.getInt16(44,true),-32768);assert.equal(view.getInt16(46,true),32767);}
 else{assert.deepEqual(Array.from(new Uint8Array(buffer,44,6)),[0,0,128,255,255,127]);}
}
const odd=core.encodeWav([new Float32Array([.5])],44100,24);
assert.equal(odd.byteLength,48);assert.equal(new DataView(odd).getUint32(40,true),3);
const tiny=core.processSelection(source,8,{start:.749999,end:.749999,fadeIn:1,fadeOut:1});
assert.equal(tiny[0].length,1);assert(Number.isFinite(tiny[0][0]));
console.log('Audio checks passed: time parsing, sample-accurate trim, fades, normalization, clipping, stereo PCM16/24 and RIFF padding.');
