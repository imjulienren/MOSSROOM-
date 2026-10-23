const assert=require('node:assert/strict');
const M=require('../dist/mixer-core.js');
const sr=48000,amp=db=>10**(db/20),tone=(hz,a=.1,seconds=1)=>Float32Array.from({length:sr*seconds},(_,i)=>a*Math.sin(2*Math.PI*hz*i/sr));
function run(input,fx={},extra={}){return M.process(input,sr,{start:0,end:input[0].length/sr,gain:0,...extra,fx});}
function rms(x,from=sr/4){return Math.sqrt(x.slice(from).reduce((s,v)=>s+v*v,0)/(x.length-from));}
const raw=tone(440);assert.deepEqual(run([raw]).channels[0],raw);assert.deepEqual(raw,tone(440));
const hp50=rms(run([tone(50)],{filterOn:true,hp:200,lp:20000}).channels[0]);
const hp1k=rms(run([tone(1000)],{filterOn:true,hp:200,lp:20000}).channels[0]);assert(hp50<hp1k*.08);
assert(rms(run([tone(10000)],{filterOn:true,hp:20,lp:2000}).channels[0])<.004);
for(const [hz,fx] of [[40,{low:6}],[1800,{mid:6}],[16000,{high:6}]]){const output=run([tone(hz)],{eqOn:true,...fx}).channels[0];assert(rms(output)/rms(tone(hz))>1.85);}
const comp=run([tone(440,.8)],{compOn:true,threshold:-24,ratio:6,attack:1,release:100});assert(comp.stats.gainReductionDb>12);assert(rms(comp.channels[0])<.15);
const gate=run([tone(440,.001)],{gateOn:true,gateThreshold:-40});assert(rms(gate.channels[0])<1e-8);
assert(rms(run([tone(440,.3)],{gateOn:true,gateThreshold:-40}).channels[0])>.2);
const impulse=new Float32Array(sr);impulse[0]=.5;
const delay=run([impulse],{delayOn:true,delayTime:100,delayMix:50,delayFeedback:50}).channels[0];assert.equal(delay[4800],.25);assert.equal(delay[9600],.125);assert.equal(delay.length,sr);
const verb=run([impulse],{reverbOn:true,reverbMix:40,reverbDecay:.8}).channels[0];assert(verb.slice(500).some(x=>Math.abs(x)>1e-5));assert(verb.every(Number.isFinite));
const stereo=[tone(440,.3),tone(660,.2)];const mono=run(stereo,{mono:true}).channels;assert.equal(mono.length,1);assert(Math.abs(mono[0][100]-(stereo[0][100]+stereo[1][100])/2)<1e-7);
const narrow=run(stereo,{width:0}).channels;assert.deepEqual(narrow[0],narrow[1]);
const right=run([raw],{pan:100}).channels;assert.equal(right.length,2);assert(M.measure([right[0]]).peak<1e-9);assert.deepEqual(right[1],raw);
for(const input of [Float32Array.from({length:sr},(_,i)=>2-i/sr),Float32Array.from({length:sr},(_,i)=>i===1000?2:.2)]){const out=run([input],{limiterOn:true,ceiling:-3});assert(out.channels[0].every(Number.isFinite));assert(out.stats.peak<=amp(-3)+1e-6);assert(out.stats.limitedDb>5);assert.equal(out.channels[0].length,input.length);}
const norm=run([raw],{eqOn:true,mid:6},{normalize:true});assert(Math.abs(norm.stats.peak-amp(-1))<1e-6);
const bypass=run(stereo,{mono:true,eqOn:true,low:12},{bypassEffects:true,gain:12,fadeIn:1});assert.deepEqual(bypass.channels,stereo);
assert.equal(M.channelCount(2,{fx:{mono:true}}),1);assert.equal(M.channelCount(1,{fx:{pan:50}}),2);
const clip=run([tone(440,.8)],{},{gain:12});assert(clip.stats.clippedSamples>0);assert.equal(clip.stats.peak,1);
console.log('Mixer checks passed: filters, EQ, compression, gate, reverb, delay, stereo, normalization, bypass, clipping and limiter edge cases.');
