(function(root){
  'use strict';
  function createMixer(){
    const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
    const db=v=>20*Math.log10(Math.max(1e-12,v));
    const amp=v=>Math.pow(10,v/20);
    function defaults(){return {filterOn:false,hp:80,lp:18000,eqOn:false,low:0,mid:0,high:0,midFreq:1800,compOn:false,threshold:-18,ratio:3,attack:10,release:150,makeup:0,gateOn:false,gateThreshold:-50,gateRelease:100,reverbOn:false,reverbMix:12,reverbDecay:.8,delayOn:false,delayMix:15,delayTime:220,delayFeedback:25,pan:0,width:100,mono:false,limiterOn:false,ceiling:-1};}
    // RBJ biquad coefficients, following the W3C Audio EQ Cookbook.
    function coefficients(type,frequency,gain,sampleRate,q=Math.SQRT1_2){
      const w=2*Math.PI*clamp(frequency,10,sampleRate*.47)/sampleRate,c=Math.cos(w),s=Math.sin(w),A=Math.pow(10,gain/40),alpha=s/(2*q),beta=2*Math.sqrt(A)*s/Math.sqrt(2);
      let b0,b1,b2,a0,a1,a2;
      if(type==='highpass'){b0=(1+c)/2;b1=-(1+c);b2=b0;a0=1+alpha;a1=-2*c;a2=1-alpha;}
      else if(type==='lowpass'){b0=(1-c)/2;b1=1-c;b2=b0;a0=1+alpha;a1=-2*c;a2=1-alpha;}
      else if(type==='peak'){b0=1+alpha*A;b1=-2*c;b2=1-alpha*A;a0=1+alpha/A;a1=-2*c;a2=1-alpha/A;}
      else if(type==='low'){b0=A*((A+1)-(A-1)*c+beta);b1=2*A*((A-1)-(A+1)*c);b2=A*((A+1)-(A-1)*c-beta);a0=(A+1)+(A-1)*c+beta;a1=-2*((A-1)+(A+1)*c);a2=(A+1)+(A-1)*c-beta;}
      else if(type==='high'){b0=A*((A+1)+(A-1)*c+beta);b1=-2*A*((A-1)+(A+1)*c);b2=A*((A+1)+(A-1)*c-beta);a0=(A+1)-(A-1)*c+beta;a1=2*((A-1)-(A+1)*c);a2=(A+1)-(A-1)*c-beta;}
      else throw Error('Unknown filter');
      return [b0/a0,b1/a0,b2/a0,a1/a0,a2/a0];
    }
    function filter(channels,coeff){const [b0,b1,b2,a1,a2]=coeff;for(const data of channels){let z1=0,z2=0;for(let i=0;i<data.length;i++){const x=data[i],y=b0*x+z1;z1=b1*x-a1*y+z2;z2=b2*x-a2*y;data[i]=y;}}}
    function measure(channels){let peak=0,sum=0,clippedSamples=0;for(const data of channels)for(const value of data){peak=Math.max(peak,Math.abs(value));sum+=value*value;if(Math.abs(value)>1)clippedSamples++;}return {peak,rms:Math.sqrt(sum/(channels.length*channels[0].length)),clippedSamples};}
    function channelCount(count,options){const f={...defaults(),...options.fx};return options.bypassEffects?count:f.mono?(f.pan!==0?2:1):count===1&&f.pan!==0?2:count;}
    function process(input,sampleRate,options){
      const length=input[0].length,from=clamp(Math.round(options.start*sampleRate),0,length-1),to=clamp(Math.round(options.end*sampleRate),from+1,length),frames=to-from;
      let channels=input.map(data=>data.slice(from,to));
      if(options.bypassEffects){const stats=measure(channels);for(const c of channels)for(let i=0;i<c.length;i++)c[i]=clamp(c[i],-1,1);return {channels,stats:{...stats,gainReductionDb:0,limitedDb:0}};}
      const f={...defaults(),...options.fx};let gainReductionDb=0;
      if(f.filterOn){filter(channels,coefficients('highpass',f.hp,0,sampleRate));filter(channels,coefficients('lowpass',f.lp,0,sampleRate));}
      if(f.eqOn){if(f.low)filter(channels,coefficients('low',120,f.low,sampleRate));if(f.mid)filter(channels,coefficients('peak',f.midFreq,f.mid,sampleRate,.85));if(f.high)filter(channels,coefficients('high',8000,f.high,sampleRate));}
      if(f.gateOn){let envelope=0,gain=0,hold=0;const threshold=amp(f.gateThreshold),release=Math.exp(-1/(sampleRate*Math.max(.01,f.gateRelease/1000))),attack=Math.exp(-1/(sampleRate*.001)),decay=Math.exp(-1/(sampleRate*.008));for(let i=0;i<frames;i++){let p=0;for(const c of channels)p=Math.max(p,Math.abs(c[i]));envelope=Math.max(p,envelope*decay);if(envelope>threshold)hold=Math.round(sampleRate*.025);else if(hold>0)hold--;const target=hold>0?1:0,coefficient=target>gain?attack:release;gain=target+(gain-target)*coefficient;for(const c of channels)c[i]*=gain;}}
      if(f.compOn){let envelope=0;const attack=Math.exp(-1/(sampleRate*Math.max(.0001,f.attack/1000))),release=Math.exp(-1/(sampleRate*Math.max(.01,f.release/1000))),ratio=clamp(f.ratio,1,20),makeup=amp(f.makeup),knee=6;for(let i=0;i<frames;i++){let p=0;for(const c of channels)p=Math.max(p,Math.abs(c[i]));const coeff=p>envelope?attack:release;envelope=p+(envelope-p)*coeff;const over=db(envelope)-f.threshold;let reduction=0;if(over>knee/2)reduction=over*(1-1/ratio);else if(over>-knee/2)reduction=(1-1/ratio)*(over+knee/2)**2/(2*knee);gainReductionDb=Math.max(gainReductionDb,reduction);const gain=amp(-reduction)*makeup;for(const c of channels)c[i]*=gain;}}
      if(f.reverbOn&&f.reverbMix>0){for(let ch=0;ch<channels.length;ch++){const data=channels[ch],mix=clamp(f.reverbMix/100,0,.6),times=[.0297,.0371,.0411,.0437],lines=times.map(t=>new Float32Array(Math.max(1,Math.round((t+ch*.00073)*sampleRate)))),feedback=lines.map(l=>Math.pow(.001,l.length/(sampleRate*Math.max(.1,f.reverbDecay)))),damped=new Float64Array(4),positions=new Int32Array(4),ap=new Float32Array(Math.max(1,Math.round(sampleRate*(.005+ch*.0003))));let apIndex=0;for(let i=0;i<frames;i++){const dry=data[i];let wet=0;for(let j=0;j<4;j++){const value=lines[j][positions[j]];damped[j]=value*.65+damped[j]*.35;lines[j][positions[j]]=dry+damped[j]*feedback[j];positions[j]=(positions[j]+1)%lines[j].length;wet+=value*.25;}const delayed=ap[apIndex],diff=wet+delayed*.5;ap[apIndex]=diff;apIndex=(apIndex+1)%ap.length;wet=delayed-diff*.5;data[i]=dry+wet*mix;}}}
      if(f.delayOn&&f.delayMix>0){for(const data of channels){const line=new Float32Array(Math.max(1,Math.round(sampleRate*f.delayTime/1000))),mix=clamp(f.delayMix/100,0,.6),feedback=clamp(f.delayFeedback/100,0,.75);let index=0;for(let i=0;i<frames;i++){const delayed=line[index],dry=data[i];line[index]=dry+delayed*feedback;data[i]=dry+delayed*mix;index=(index+1)%line.length;}}}
      if(f.mono&&channels.length>1){const mono=new Float32Array(frames);for(const c of channels)for(let i=0;i<frames;i++)mono[i]+=c[i]/channels.length;channels=[mono];}
      if(channels.length===2&&f.width!==100){const width=clamp(f.width/100,0,2);for(let i=0;i<frames;i++){const mid=(channels[0][i]+channels[1][i])*.5,side=(channels[0][i]-channels[1][i])*.5*width;channels[0][i]=mid+side;channels[1][i]=mid-side;}}
      const pan=clamp(f.pan/100,-1,1);
      if(pan!==0){if(channels.length===1){const mono=channels[0],left=new Float32Array(frames),right=new Float32Array(frames),a=Math.cos((pan+1)*Math.PI/4),b=Math.sin((pan+1)*Math.PI/4);for(let i=0;i<frames;i++){left[i]=mono[i]*a;right[i]=mono[i]*b;}channels=[left,right];}else{for(let i=0;i<frames;i++){const l=channels[0][i],r=channels[1][i];if(pan<0){channels[0][i]=l+r*Math.cos((pan+1)*Math.PI/2);channels[1][i]=r*Math.sin((pan+1)*Math.PI/2);}else{channels[0][i]=l*Math.cos(pan*Math.PI/2);channels[1][i]=r+l*Math.sin(pan*Math.PI/2);}}}}
      const peak=options.normalize?measure(channels).peak:0,gain=amp(options.gain||0)*(peak>0?amp(-1)/peak:1),fadeIn=Math.min(frames-1,Math.round((options.fadeIn||0)*sampleRate)),fadeOut=Math.min(frames-1,Math.round((options.fadeOut||0)*sampleRate));
      for(const c of channels)for(let i=0;i<frames;i++){const envelope=(fadeIn>0?Math.min(1,i/fadeIn):1)*(fadeOut>0?Math.min(1,(frames-1-i)/fadeOut):1);c[i]*=gain*envelope;}
      const pre=measure(channels);let limitedDb=0;
      if(f.limiterOn){const lookahead=Math.max(1,Math.round(sampleRate*.005)),peak=new Float32Array(frames),queue=new Int32Array(lookahead+2),size=queue.length,ceiling=amp(clamp(f.ceiling,-12,0)),release=Math.exp(-1/(sampleRate*.08));for(let i=0;i<frames;i++)for(const c of channels)peak[i]=Math.max(peak[i],Math.abs(c[i]));let head=0,tail=0,next=0,gain=1;for(let i=0;i<frames;i++){while(head!==tail&&queue[head]<i)head=(head+1)%size;const end=Math.min(frames-1,i+lookahead);while(next<=end){while(head!==tail&&peak[queue[(tail-1+size)%size]]<=peak[next])tail=(tail-1+size)%size;queue[tail]=next++;tail=(tail+1)%size;}while(head!==tail&&queue[head]<i)head=(head+1)%size;const target=Math.min(1,ceiling/(peak[queue[head]]+1e-12));gain=Math.min(target,1+(gain-1)*release);limitedDb=Math.max(limitedDb,-db(gain));for(const c of channels)c[i]*=gain;}}
      const stats=measure(channels);for(const c of channels)for(let i=0;i<frames;i++)c[i]=clamp(c[i],-1,1);
      return {channels,stats:{...stats,peak:Math.min(1,stats.peak),rms:stats.clippedSamples?measure(channels).rms:stats.rms,inputPeak:pre.peak,gainReductionDb,limitedDb}};
    }
    return {defaults,coefficients,measure,process,channelCount};
  }
  const api=createMixer();api.create=createMixer;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.MixerCore=api;
})(typeof globalThis!=='undefined'?globalThis:this);
