const assert=require('node:assert/strict');
const core=require('../dist/audio-core.js');
const {stretchAudio}=require('../dist/stretch-engine.js');
const create=require('../dist/vendor/signalsmith-stretch.js');
const source=[new Float32Array([.1,.2,.3,.4]),new Float32Array([-.1,-.2,-.3,-.4])];
for(const at of [0,2,4]){
 const result=core.insertSilence(source,4,at/4,.5);
 assert.equal(result[0].length,6);
 for(let c=0;c<2;c++){
  assert.deepEqual(result[c].subarray(0,at),source[c].subarray(0,at));
  assert.deepEqual(Array.from(result[c].subarray(at,at+2)),[0,0]);
  assert.deepEqual(result[c].subarray(at+2),source[c].subarray(at));
 }
}
const before=source.map(c=>c.slice());
const replacement=[new Float32Array([.6,.7,.8]),new Float32Array([-.6,-.7,-.8])];
const replaced=core.replaceRange(source,1,3,replacement);
assert.equal(replaced[0].length,5);assert.equal(replaced[0][0],source[0][0]);assert.equal(replaced[0].at(-1),source[0].at(-1));assert.deepEqual(source,before);
assert.throws(()=>core.insertSilence(source,4,0,-1));
assert.throws(()=>core.replaceRange(source,-1,2,replacement));
assert.throws(()=>core.replaceRange(source,0,2,[replacement[0]]));

(async()=>{
 for(const sampleRate of [44100,48000]){
  const count=sampleRate,signal=new Float32Array(count);
  for(let i=0;i<count;i++)signal[i]=.5*Math.sin(2*Math.PI*440*i/sampleRate);
  const stereo=[signal,Float32Array.from(signal,v=>-v)];
  const exact=await stretchAudio(stereo,sampleRate,count,create);
  assert.deepEqual(exact,stereo);assert.notEqual(exact[0],stereo[0]);
  for(const ratio of [.25,.5,.75,1.5,2,4]){
   const frames=Math.round(count*ratio),out=await stretchAudio(stereo,sampleRate,frames,create);
   assert.equal(out.length,2);assert.equal(out[0].length,frames);
   let crossings=0,squares=0,correlationError=0;
   const from=Math.round(.05*sampleRate),end=frames-Math.round(.05*sampleRate);
   for(let i=from;i<end;i++){assert(Number.isFinite(out[0][i]));if(out[0][i]<=0&&out[0][i+1]>0)crossings++;squares+=out[0][i]**2;correlationError=Math.max(correlationError,Math.abs(out[0][i]+out[1][i]));}
   assert(Math.abs(crossings*sampleRate/(end-from)-440)<8,'Pitch drift at '+ratio);
   assert(Math.sqrt(squares/(end-from))>.25,'Unexpected silence at '+ratio);
   // Allow sub-milliscale float FFT error while retaining channel coherence.
   assert(correlationError<.001,'Stereo phase changed');
   assert.equal(out[0][0],signal[0]);assert.equal(out[0].at(-1),signal.at(-1));
   const prefix=new Float32Array(73).fill(.123),suffix=new Float32Array(91).fill(-.234),full=new Float32Array(prefix.length+count+suffix.length);
   full.set(prefix);full.set(signal,prefix.length);full.set(suffix,prefix.length+count);
   const splice=core.replaceRange([full],prefix.length,prefix.length+count,[out[0]])[0];
   assert.deepEqual(splice.subarray(0,prefix.length),prefix);assert.deepEqual(splice.subarray(prefix.length+frames),suffix);
  }
  const tiny=new Float32Array(Math.round(sampleRate*.02)).fill(.2);
  const short=await stretchAudio([tiny],sampleRate,tiny.length*2,create);assert.equal(short[0].length,tiny.length*2);assert(short[0].every(Number.isFinite));
 }
 console.log('Timeline checks passed: exact silence at start/middle/end, unchanged surrounding audio, 25–400% durations, pitch preservation, stereo phase and short clips.');
})().catch(error=>{console.error(error);process.exitCode=1;});
