let landmarker=null,running=false,challenge=null,success=0,lastVideoTime=-1;
let modelLoading=false, modelError=null;
let eyeSession=null, eyeFrameId=null;

const video=document.getElementById("video"),statusEl=document.getElementById("liveStatus"),
textEl=document.getElementById("challengeText"),btn=document.getElementById("challengeBtn");

async function initModel(){
 if(landmarker) return true;
 if(modelLoading){
   while(modelLoading) await new Promise(r=>setTimeout(r,100));
   return !!landmarker;
 }
 modelLoading=true; modelError=null;
 statusEl.textContent="摄像头已打开，正在加载活体检测模型…";
 try{
   const mod=await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm");
   const {FaceLandmarker,FilesetResolver}=mod;
   const vision=await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
   landmarker=await FaceLandmarker.createFromOptions(vision,{
     baseOptions:{
       modelAssetPath:"https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
       delegate:"GPU"
     },
     runningMode:"VIDEO",
     numFaces:1,
     outputFaceBlendshapes:true
   });
   statusEl.className="status ok";
   statusEl.textContent="摄像头已打开，活体模型已就绪";
   if(btn) btn.disabled=false;
   return true;
 }catch(e){
   console.error("活体模型加载失败",e); modelError=e;
   statusEl.className="status warn";
   statusEl.textContent="摄像头可正常使用，但活体模型加载失败。请检查网络后重试。";
   if(btn) btn.disabled=false;
   return false;
 }finally{
   modelLoading=false;
 }
}
window.prepareLivenessModel=initModel;

// ===== 原有随机活体检测 =====
window.startChallenge=async function(){
 if(!window.__cameraStream){
   statusEl.className="status bad";statusEl.textContent="请先打开摄像头";return;
 }
 if(!landmarker){
   statusEl.className="status";statusEl.textContent="正在加载活体检测模型，请稍候…";
   const ok=await initModel();
   if(!ok){
     statusEl.className="status bad";
     statusEl.textContent="活体模型加载失败。摄像头正常，但检测模型未加载，请联网后重试。";
     return;
   }
 }
 const pool=["blink","left","right"];
 challenge=pool[Math.floor(Math.random()*pool.length)];
 success=0;running=true;
 textEl.textContent={blink:"请眨眼睛",left:"请向左转头",right:"请向右转头"}[challenge];
 statusEl.className="status";statusEl.textContent="正在检测…";
 requestAnimationFrame(challengeLoop);
};

function d(a,b){return Math.hypot(a.x-b.x,a.y-b.y)}
function eyeRatio(lm,t,b,l,r){return d(lm[t],lm[b])/Math.max(d(lm[l],lm[r]),.0001)}
function getEyeEARs(lm){
 return {
   left:eyeRatio(lm,159,145,33,133),
   right:eyeRatio(lm,386,374,362,263)
 };
}
function getEAR(lm){
 const e=getEyeEARs(lm);
 return (e.left+e.right)/2;
}
function getBlendshapeScores(result){
 const out={blinkLeft:null,blinkRight:null};
 const cats=result.faceBlendshapes?.[0]?.categories||[];
 for(const c of cats){
   if(c.categoryName==="eyeBlinkLeft") out.blinkLeft=c.score;
   if(c.categoryName==="eyeBlinkRight") out.blinkRight=c.score;
 }
 return out;
}
function isStrictlyClosed(result,lm){
 const ears=getEyeEARs(lm);
 const bs=getBlendshapeScores(result);

 // 严格闭眼：左右眼都必须非常小，且两个 blink blendshape 都要高。
 // 眯眼通常会降低 EAR，但 blendshape 不会同时达到真正闭眼的强度。
 const earClosed = ears.left < 0.155 && ears.right < 0.155;
 const blendClosed =
   bs.blinkLeft!=null && bs.blinkRight!=null
     ? (bs.blinkLeft > 0.72 && bs.blinkRight > 0.72)
     : true; // 极少数环境无 blendshape 时退回严格 EAR
 return earClosed && blendClosed;
}
function challengeCondition(result,lm){
 const center=(lm[33].x+lm[263].x)/2;
 const width=Math.abs(lm[263].x-lm[33].x);
 const yaw=(lm[1].x-center)/Math.max(width,.0001);
 if(challenge==="blink")return isStrictlyClosed(result,lm);
 if(challenge==="left")return yaw>.10;
 if(challenge==="right")return yaw<-.10;
 return false;
}
function challengeLoop(){
 if(!running||!landmarker||!window.__cameraStream)return;
 if(video.readyState>=2&&video.currentTime!==lastVideoTime){
   lastVideoTime=video.currentTime;
   try{
     const result=landmarker.detectForVideo(video,performance.now());
     if(result.faceLandmarks?.length===1){
       const ok=challengeCondition(result,result.faceLandmarks[0]);
       success=ok?success+1:Math.max(0,success-1);
       statusEl.textContent=`检测中… ${Math.min(success,8)}/8`;
       if(success>=8){
         running=false;
         statusEl.className="status ok";
         statusEl.textContent="活体检测通过";
         textEl.textContent="✅ 已通过";
         window.onLivenessPassed?.();
         return;
       }
     }else{
       success=0;
       statusEl.textContent="请让一张脸完整出现在画面中";
     }
   }catch(e){
     console.error(e);
     running=false;
     statusEl.className="status bad";
     statusEl.textContent="活体检测运行失败，请重试";
     return;
   }
 }
 requestAnimationFrame(challengeLoop);
}

// ===== v6.0：背诵前视频完成睁眼/闭眼校准，正式背诵只做持续监测 =====

let savedEyeCalibration=null;
let preCalSession=null;
let preCalFrameId=null;

function median(arr){
  if(!arr.length) return null;
  const a=[...arr].sort((x,y)=>x-y);
  const m=Math.floor(a.length/2);
  return a.length%2 ? a[m] : (a[m-1]+a[m])/2;
}

function getEyeFeatures(result){
  if(!result.faceLandmarks?.length) return null;
  const lm=result.faceLandmarks[0];
  const ears=getEyeEARs(lm);
  const bs=getBlendshapeScores(result);
  return {
    leftEAR:ears.left,
    rightEAR:ears.right,
    blinkLeft:bs.blinkLeft,
    blinkRight:bs.blinkRight
  };
}

function buildDualCalibration(openSamples,closedSamples){
  const oL=median(openSamples.map(s=>s.leftEAR).filter(Number.isFinite));
  const oR=median(openSamples.map(s=>s.rightEAR).filter(Number.isFinite));
  const cL=median(closedSamples.map(s=>s.leftEAR).filter(Number.isFinite));
  const cR=median(closedSamples.map(s=>s.rightEAR).filter(Number.isFinite));
  if([oL,oR,cL,cR].some(v=>v==null)) return null;

  if(!(cL < oL*0.95 && cR < oR*0.95)) return null;

  const leftThreshold  = cL + (oL-cL)*0.40;
  const rightThreshold = cR + (oR-cR)*0.40;

  const openBL=median(openSamples.map(s=>s.blinkLeft).filter(Number.isFinite));
  const openBR=median(openSamples.map(s=>s.blinkRight).filter(Number.isFinite));
  const closeBL=median(closedSamples.map(s=>s.blinkLeft).filter(Number.isFinite));
  const closeBR=median(closedSamples.map(s=>s.blinkRight).filter(Number.isFinite));

  return {
    leftThreshold,rightThreshold,
    baseline:{
      openLeftEAR:oL,openRightEAR:oR,
      closedLeftEAR:cL,closedRightEAR:cR,
      openBlinkLeft:openBL,openBlinkRight:openBR,
      closedBlinkLeft:closeBL,closedBlinkRight:closeBR
    }
  };
}

function isClosedByCalibration(features,cal){
  if(!features||!cal)return false;

  const earClosed=
    features.leftEAR<=cal.leftThreshold &&
    features.rightEAR<=cal.rightThreshold;

  let blendSupport=true;
  const b=cal.baseline;
  if(
    Number.isFinite(features.blinkLeft)&&Number.isFinite(features.blinkRight)&&
    Number.isFinite(b.openBlinkLeft)&&Number.isFinite(b.closedBlinkLeft)&&
    Number.isFinite(b.openBlinkRight)&&Number.isFinite(b.closedBlinkRight)
  ){
    const leftMid=b.openBlinkLeft+(b.closedBlinkLeft-b.openBlinkLeft)*0.20;
    const rightMid=b.openBlinkRight+(b.closedBlinkRight-b.openBlinkRight)*0.20;
    const stronglyOpen=
      features.blinkLeft<leftMid &&
      features.blinkRight<rightMid;
    blendSupport=!stronglyOpen;
  }

  return earClosed&&blendSupport;
}

function updatePreCalibrationUI(){
  const box=document.getElementById("eyeCalibrationStatus");
  if(!box||!preCalSession)return;

  if(preCalSession.stage==="open"){
    const pct=Math.min(100,Math.round((performance.now()-preCalSession.stageStart)/preCalSession.openMs*100));
    box.className="status warn";
    box.textContent=`第1步：请自然睁眼看摄像头… ${pct}%`;
  }else if(preCalSession.stage==="closed"){
    const pct=Math.min(100,Math.round((performance.now()-preCalSession.stageStart)/preCalSession.closedMs*100));
    box.className="status warn";
    box.textContent=`第2步：请完全闭眼保持不动… ${pct}%`;
  }
}

window.startPreRecitationEyeCalibration=async function(){
  if(!window.__cameraStream){
    const box=document.getElementById("eyeCalibrationStatus");
    if(box){box.className="status bad";box.textContent="请先打开摄像头";}
    return false;
  }

  const ok=await initModel();
  if(!ok)return false;

  if(preCalFrameId)cancelAnimationFrame(preCalFrameId);

  savedEyeCalibration=null;
  preCalSession={
    stage:"open",
    stageStart:performance.now(),
    openMs:1000,
    closedMs:2000,
    openSamples:[],
    closedSamples:[]
  };

  updatePreCalibrationUI();
  preCalFrameId=requestAnimationFrame(preCalibrationLoop);
  return true;
};

function failPreCalibration(msg){
  if(preCalFrameId){cancelAnimationFrame(preCalFrameId);preCalFrameId=null;}
  preCalSession=null;
  savedEyeCalibration=null;

  const box=document.getElementById("eyeCalibrationStatus");
  if(box){box.className="status bad";box.textContent=msg||"眼睛校准失败，请重新检测";}
  window.onPreEyeCalibrationFailed?.();
}

function finishPreCalibration(){
  const cal=buildDualCalibration(preCalSession.openSamples,preCalSession.closedSamples);
  if(!cal||preCalSession.openSamples.length<5||preCalSession.closedSamples.length<8){
    failPreCalibration("眼睛校准失败：请正对摄像头，重新进行睁眼/闭眼检测");
    return;
  }

  savedEyeCalibration=cal;
  if(preCalFrameId){cancelAnimationFrame(preCalFrameId);preCalFrameId=null;}
  preCalSession=null;

  const box=document.getElementById("eyeCalibrationStatus");
  if(box){
    box.className="status ok";
    box.textContent="✅ 睁眼/闭眼校准通过，可以开始背诵";
  }

  window.onPreEyeCalibrationReady?.(cal);
}

function preCalibrationLoop(){
  if(!preCalSession||!landmarker||!window.__cameraStream)return;

  let features=null;
  if(video.readyState>=2){
    try{
      const result=landmarker.detectForVideo(video,performance.now());
      features=getEyeFeatures(result);
    }catch(e){console.error(e);}
  }

  if(preCalSession.stage==="open"){
    if(features)preCalSession.openSamples.push(features);
    updatePreCalibrationUI();

    if(performance.now()-preCalSession.stageStart>=preCalSession.openMs){
      preCalSession.stage="closed";
      preCalSession.stageStart=performance.now();
    }

    preCalFrameId=requestAnimationFrame(preCalibrationLoop);
    return;
  }

  if(preCalSession.stage==="closed"){
    if(features)preCalSession.closedSamples.push(features);
    updatePreCalibrationUI();

    if(performance.now()-preCalSession.stageStart>=preCalSession.closedMs){
      finishPreCalibration();
      return;
    }

    preCalFrameId=requestAnimationFrame(preCalibrationLoop);
  }
}

function updateEyeUI(state){
  const box=document.getElementById("eyeMonitorStatus");
  const timer=document.getElementById("eyeOpenTime");

  if(!eyeSession){
    if(box){box.className="status";box.textContent="尚未开始背诵闭眼检测";}
    if(timer)timer.textContent="累计睁眼：0.0 / 3.0 秒";
    return;
  }

  const sec=(eyeSession.openMs/1000).toFixed(1);
  if(timer)timer.textContent=`累计睁眼：${sec} / ${(eyeSession.maxOpenMs/1000).toFixed(1)} 秒`;

  if(!box)return;

  if(eyeSession.violation){
    box.className="status bad";
    box.textContent="累计睁眼已超过 3 秒，本次自动判为未通过";
  }else if(state==="closed"){
    box.className="status ok";
    box.textContent="检测正常：已识别为闭眼";
  }else if(state==="open"){
    box.className="status warn";
    box.textContent="检测到睁眼，正在累计睁眼时间";
  }else if(state==="missing"){
    box.className="status warn";
    box.textContent="未检测到完整人脸，此时间也会计入睁眼时间";
  }else{
    box.className="status";
    box.textContent="正在启动背诵闭眼检测…";
  }
}

window.startClosedEyeSession=async function(maxOpenMs=3000){
  if(!window.__cameraStream)return {ok:false,reason:"camera"};
  if(!savedEyeCalibration)return {ok:false,reason:"calibration"};

  const ok=await initModel();
  if(!ok)return {ok:false,reason:"model"};

  running=false;
  eyeSession={
    active:true,
    calibration:savedEyeCalibration,
    maxOpenMs:Number(maxOpenMs)||3000,
    openMs:0,
    lastTs:null,
    violation:false,
    lastState:"unknown"
  };

  updateEyeUI("unknown");
  if(eyeFrameId)cancelAnimationFrame(eyeFrameId);
  eyeFrameId=requestAnimationFrame(eyeLoop);
  return {ok:true};
};

function eyeLoop(ts){
  if(!eyeSession?.active||!landmarker||!window.__cameraStream)return;

  const dt=eyeSession.lastTs==null?0:Math.min(Math.max(ts-eyeSession.lastTs,0),250);
  eyeSession.lastTs=ts;

  let features=null,state="missing";
  if(video.readyState>=2){
    try{
      const result=landmarker.detectForVideo(video,performance.now());
      features=getEyeFeatures(result);
    }catch(e){console.error("闭眼检测运行失败",e);}
  }

  if(features){
    state=isClosedByCalibration(features,eyeSession.calibration)?"closed":"open";
    window.__lastEyeDebug={...features,state,calibration:eyeSession.calibration};
  }else{
    state="missing";
  }

  if(state==="open"||state==="missing")eyeSession.openMs+=dt;
  eyeSession.lastState=state;

  if(eyeSession.openMs>eyeSession.maxOpenMs){
    eyeSession.violation=true;
    eyeSession.active=false;
    updateEyeUI(state);
    window.onEyeOpenLimitExceeded?.(eyeSession.openMs);
    return;
  }

  updateEyeUI(state);
  eyeFrameId=requestAnimationFrame(eyeLoop);
}

window.stopClosedEyeSession=function(){
  if(eyeFrameId){cancelAnimationFrame(eyeFrameId);eyeFrameId=null;}
  if(!eyeSession)return {openMs:0,violation:false,lastState:"unknown",calibrated:!!savedEyeCalibration};

  eyeSession.active=false;
  return {
    openMs:Math.round(eyeSession.openMs),
    violation:!!eyeSession.violation,
    lastState:eyeSession.lastState,
    calibrated:!!savedEyeCalibration
  };
};

window.getClosedEyeSessionStats=function(){
  if(!eyeSession)return {
    openMs:0,violation:false,lastState:"unknown",active:false,calibrated:!!savedEyeCalibration
  };
  return {
    openMs:Math.round(eyeSession.openMs),
    violation:!!eyeSession.violation,
    lastState:eyeSession.lastState,
    active:!!eyeSession.active,
    calibrated:!!savedEyeCalibration
  };
};

window.hasEyeCalibration=function(){return !!savedEyeCalibration;};

window.clearEyeCalibration=function(){
  savedEyeCalibration=null;
  const box=document.getElementById("eyeCalibrationStatus");
  if(box){box.className="status";box.textContent="尚未完成睁眼/闭眼校准";}
};

window.stopLivenessLoop=function(){
  running=false;
  if(eyeFrameId){cancelAnimationFrame(eyeFrameId);eyeFrameId=null;}
  if(preCalFrameId){cancelAnimationFrame(preCalFrameId);preCalFrameId=null;}
  if(eyeSession)eyeSession.active=false;
  preCalSession=null;
};

window.getEyeDebug=function(){return window.__lastEyeDebug||null;};
