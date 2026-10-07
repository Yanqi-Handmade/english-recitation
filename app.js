
const defaultStudents=[
 {id:"30101",name:"测试学生A",class:"三年级1班",registrationCode:"A30101",password:"123456",parentPin:"2580",registered:true,needsPasswordReset:false,points:0},
 {id:"30102",name:"测试学生B",class:"三年级1班",registrationCode:"A30102",password:"123456",parentPin:"3690",registered:true,needsPasswordReset:false,points:0}
];
const defaultTasks=[
 {id:"t1",title:"示例单词",type:"word",text:"hello school teacher friend"},
 {id:"t2",title:"示例课文",type:"text",text:"Hello. My name is Amy. Nice to meet you."}
];

let students=JSON.parse(localStorage.getItem("v5students")||localStorage.getItem("v3students")||"null")||defaultStudents;
let tasks=JSON.parse(localStorage.getItem("v5tasks")||localStorage.getItem("v3tasks")||"null")||defaultTasks;
let records=JSON.parse(localStorage.getItem("v5records")||localStorage.getItem("v3records")||"[]");
let approvals=JSON.parse(localStorage.getItem("v53approvals")||"[]");
let passwordResetRequests=JSON.parse(localStorage.getItem("v54passwordResetRequests")||"[]");
let pendingImport=[];
let current=null, loginOk=false, secondOk=false, phraseOk=false, liveOk=false;
let otp="", currentPhrase="", recognition=null;
let recitationActive=false, recitationCompleting=false, lastEyeStats={openMs:0,violation:false};
let eyeCalibrationReady=false;
let sessionVerificationReady=false;
let editingTaskId=null;
let teacherToken=sessionStorage.getItem("teacherToken")||"";
let studentToken=sessionStorage.getItem("studentToken")||"";
let cloudSyncTimer=null,suppressCloudSave=false;
let teacherLoggedIn=!!teacherToken;

function save(){
 localStorage.setItem("v5students",JSON.stringify(students));
 localStorage.setItem("v5tasks",JSON.stringify(tasks));
 localStorage.setItem("v5records",JSON.stringify(records));
 localStorage.setItem("v53approvals",JSON.stringify(approvals));
 localStorage.setItem("v54passwordResetRequests",JSON.stringify(passwordResetRequests));
 if(!suppressCloudSave&&teacherLoggedIn&&teacherToken&&window.CloudAPI?.configured()){
   clearTimeout(cloudSyncTimer);
   cloudSyncTimer=setTimeout(async()=>{
     try{
       await CloudAPI.teacherSaveState(teacherToken,{
         students:students.map(s=>({id:s.id,name:s.name,class:s.class,registrationCode:s.registrationCode||"",registered:!!s.registered,needsPasswordReset:!!s.needsPasswordReset,points:Number(s.points)||0})),
         tasks,records,approvals,passwordResetRequests
       });
       setCloudStatus("云端已同步","ok");
     }catch(e){setCloudStatus("云端同步失败："+friendlyCloudError(e),"bad")}
   },350);
 }
}
save();




function friendlyCloudError(e){
 const m=String(e?.message||e||"");
 if(m==="CLOUD_NOT_CONFIGURED")return "请在 config.js 填写 SCF 函数 URL";
 if(e?.status===401)return "登录已失效";
 return m;
}
function setCloudStatus(t,k=""){const el=document.getElementById("cloudStatus");if(el){el.textContent=t;el.className="status "+k}}
async function loadTeacherCloudState(){
 const d=await CloudAPI.teacherState(teacherToken);
 suppressCloudSave=true;
 students=d.students||[];tasks=d.tasks||[];records=d.records||[];approvals=d.approvals||[];passwordResetRequests=d.passwordResetRequests||[];
 suppressCloudSave=false;save();renderAll();
}
async function loadStudentCloudState(){
 const d=await CloudAPI.studentState(studentToken);
 suppressCloudSave=true;
 current=d.profile||current;tasks=d.tasks||[];records=d.records||[];approvals=d.approvals||[];
 students=current?[current]:[];
 suppressCloudSave=false;save();renderAll();
}
async function initCloud(){
 if(!window.CloudAPI?.configured()){setCloudStatus("尚未配置腾讯云：请编辑 config.js","warn");return}
 try{
   const h=await CloudAPI.request("/health");setCloudStatus("腾讯云已连接 · "+(h.storage||"COS"),"ok");
   if(teacherToken){try{teacherLoggedIn=true;await loadTeacherCloudState();updateTeacherVisibility()}catch(e){teacherToken="";teacherLoggedIn=false;sessionStorage.removeItem("teacherToken")}}
   else if(studentToken){try{await loadStudentCloudState();loginOk=!!current;updateGate()}catch(e){studentToken="";sessionStorage.removeItem("studentToken")}}
 }catch(e){setCloudStatus("腾讯云连接失败："+friendlyCloudError(e),"bad")}
}

// ===== v5.4 学生账号数据兼容：保留旧版已注册账号 =====
students=students.map(s=>({
 ...s,
 registrationCode:String(s.registrationCode||s.initialCode||"").trim(),
 registered:s.registered!==undefined ? !!s.registered : !!s.password,
 needsPasswordReset:!!s.needsPasswordReset
}));
save();

// ===== v5.1：摄像头按 v1 逻辑独立打开，不再依赖活体模型是否加载成功 =====
let mediaStream=null;
window.startCamera=async function(preserveVerification=false){
 const video=document.getElementById("video"), status=document.getElementById("liveStatus"), btn=document.getElementById("challengeBtn");
 try{
   if(mediaStream) mediaStream.getTracks().forEach(t=>t.stop());
   mediaStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"user"},audio:false});
   window.__cameraStream=mediaStream;
   video.srcObject=mediaStream;
   try{await video.play()}catch(e){}
   status.className="status ok";
   status.textContent="摄像头已打开";
   document.getElementById("challengeText").textContent="摄像头正常，请先完成活体检测";
   if(!preserveVerification){
     liveOk=false;
     eyeCalibrationReady=false;
     sessionVerificationReady=false;
     window.clearEyeCalibration?.();
     const calBtn=document.getElementById("eyeCalibrationBtn");
     if(calBtn){calBtn.disabled=true;calBtn.textContent="开始睁眼/闭眼校准";}
     const calStatus=document.getElementById("eyeCalibrationStatus");
     if(calStatus){calStatus.className="status";calStatus.textContent="请先完成活体检测";}
   }else{
     const calStatus=document.getElementById("eyeCalibrationStatus");
     if(calStatus&&sessionVerificationReady){
       calStatus.className="status ok";
       calStatus.textContent="✅ 已沿用本次登录的睁眼/闭眼校准";
     }
   }
   btn.disabled=false;
   updateGate();
   // 模型后台加载，失败不影响摄像头画面
   if(window.prepareLivenessModel) window.prepareLivenessModel();
   return true;
 }catch(e){
   console.error("摄像头打开失败",e);
   status.className="status bad";
   status.textContent="无法打开摄像头："+(e.name||"请检查浏览器摄像头权限");
   return false;
 }
};
window.stopCamera=function(preserveVerification=false){
 if(window.stopLivenessLoop) window.stopLivenessLoop();
 if(mediaStream){mediaStream.getTracks().forEach(t=>t.stop());mediaStream=null;}
 window.__cameraStream=null;
 const video=document.getElementById("video");video.srcObject=null;
 document.getElementById("challengeBtn").disabled=true;
 document.getElementById("challengeText").textContent="先打开摄像头";
 const status=document.getElementById("liveStatus");status.className="status";status.textContent="已关闭";
 if(!preserveVerification){
   liveOk=false;
   eyeCalibrationReady=false;
   sessionVerificationReady=false;
   window.clearEyeCalibration?.();
   const calBtn=document.getElementById("eyeCalibrationBtn");
   if(calBtn){calBtn.disabled=true;calBtn.textContent="开始睁眼/闭眼校准";}
   const calStatus=document.getElementById("eyeCalibrationStatus");
   if(calStatus){calStatus.className="status";calStatus.textContent="尚未完成睁眼/闭眼校准";}
 }else{
   const calStatus=document.getElementById("eyeCalibrationStatus");
   if(calStatus&&sessionVerificationReady){
     calStatus.className="status ok";
     calStatus.textContent="✅ 本次登录已完成校准；换任务无需重复检测";
   }
 }
 updateGate();
};

// ===== 教师端登录（腾讯云） =====
window.teacherLogin=async function(){
 const u=document.getElementById("teacherUser").value.trim(),p=document.getElementById("teacherPassword").value;
 const msg=document.getElementById("teacherLoginMsg");
 try{const d=await CloudAPI.teacherLogin(u,p);teacherToken=d.token;sessionStorage.setItem("teacherToken",teacherToken);teacherLoggedIn=true;msg.textContent="教师端登录成功";msg.className="status ok";await loadTeacherCloudState();updateTeacherVisibility()}
 catch(e){teacherLoggedIn=false;msg.textContent="教师登录失败："+friendlyCloudError(e);msg.className="status bad"}
};
window.teacherLogout=function(){teacherLoggedIn=false;teacherToken="";sessionStorage.removeItem("teacherToken");updateTeacherVisibility()};
function updateTeacherVisibility(){
 const box=document.getElementById("teacherProtected");if(box)box.classList.toggle("hidden",!teacherLoggedIn);
 const msg=document.getElementById("teacherLoginMsg");if(msg&&teacherLoggedIn){msg.textContent="教师端已登录（云端）";msg.className="status ok"}
 if(teacherLoggedIn){renderApprovals();renderPasswordResetRequests()}
}

// ===== 批量添加学生（v5.4：不再由老师分配密码） =====
let pendingBatch=[];
window.previewBatchStudents=function(){
 const raw=document.getElementById("batchStudents").value.trim();
 if(!raw){document.getElementById("batchSummary").textContent="请先填写学生信息";return;}
 const existing=new Set(students.map(s=>String(s.id))), seen=new Set();
 pendingBatch=raw.split(/\r?\n/).filter(Boolean).map((line,i)=>{
   const parts=line.split(/[,，\t]/).map(x=>x.trim());
   const [id,name,cls,registrationCode]=parts;
   const invalid=parts.length<4||!id||!name||!cls||!registrationCode;
   const dupInFile=seen.has(id); if(id)seen.add(id);
   const dupExisting=existing.has(id);
   return {
     row:i+1,id:id||"",name:name||"",class:cls||"",
     registrationCode:registrationCode||"",
     password:"",parentPin:"",registered:false,needsPasswordReset:false,
     points:0,invalid,dupInFile,dupExisting
   };
 });
 const valid=pendingBatch.filter(x=>!x.invalid&&!x.dupInFile&&!x.dupExisting).length;
 document.getElementById("batchSummary").className="status "+(valid?"ok":"warn");
 document.getElementById("batchSummary").textContent=`共 ${pendingBatch.length} 行，可添加 ${valid} 名学生。学生首次登录时自己设置密码和家长 PIN。`;
 document.getElementById("batchPreview").innerHTML=
   `<table><tr><th>行</th><th>ID</th><th>姓名</th><th>班级</th><th>初始注册码</th><th>状态</th></tr>`+
   pendingBatch.map(x=>`<tr class="${x.invalid?'invalid':(x.dupInFile||x.dupExisting?'dup':'')}"><td>${x.row}</td><td>${escapeHtml(x.id)}</td><td>${escapeHtml(x.name)}</td><td>${escapeHtml(x.class)}</td><td>${escapeHtml(x.registrationCode)}</td><td>${x.invalid?'格式不完整':(x.dupInFile?'批量内容重复':(x.dupExisting?'系统已存在':'可添加'))}</td></tr>`).join("")+
   `</table>`;
 document.getElementById("confirmBatchBtn").disabled=valid===0;
};
window.confirmBatchStudents=function(){
 const valid=pendingBatch.filter(x=>!x.invalid&&!x.dupInFile&&!x.dupExisting).map(({row,invalid,dupInFile,dupExisting,...x})=>x);
 if(!valid.length){alert("没有可添加的学生");return;}
 students.push(...valid);save();renderStudents();
 document.getElementById("batchSummary").className="status ok";
 document.getElementById("batchSummary").textContent=`成功批量添加 ${valid.length} 名学生。学生现在可以使用学生ID + 姓名 + 初始注册码完成首次注册。`;
 document.getElementById("confirmBatchBtn").disabled=true;pendingBatch=[];
};

window.showTab=function(tab){
 document.getElementById("student").classList.toggle("hidden",tab!=="student");
 document.getElementById("teacher").classList.toggle("hidden",tab!=="teacher");
 document.getElementById("studentTab").classList.toggle("active",tab==="student");
 document.getElementById("teacherTab").classList.toggle("active",tab==="teacher");
 updateTeacherVisibility();
 renderAll();
}


window.previewXlsx=async function(){
 const input=document.getElementById("xlsxFile"), file=input.files[0];
 if(!file)return;
 if(typeof XLSX==="undefined"){alert("XLSX 解析组件加载失败，请检查网络后重试。");return}
 let wb;
 try{wb=XLSX.read(await file.arrayBuffer(),{type:"array"})}catch(e){alert("无法读取 XLSX 文件，请确认文件没有损坏。");return}
 const ws=wb.Sheets[wb.SheetNames[0]];
 const rows=XLSX.utils.sheet_to_json(ws,{defval:"",raw:false});
 const required=["学生ID","姓名","班级","初始注册码"];
 const missing=required.filter(k=>!(rows[0]&&Object.prototype.hasOwnProperty.call(rows[0],k)));
 if(missing.length){
   const summary=document.getElementById("importSummary");
   summary.className="status bad"; summary.textContent="缺少表头："+missing.join("、");
   document.getElementById("previewWrap").innerHTML="";
   document.getElementById("confirmImportBtn").disabled=true; pendingImport=[]; return;
 }
 const seen=new Set(), existing=new Set(students.map(s=>String(s.id)));
 pendingImport=rows.filter(r=>Object.values(r).some(v=>String(v).trim()!=="")).map((r,i)=>{
   const x={
     row:i+2,
     id:String(r["学生ID"]).trim(),
     name:String(r["姓名"]).trim(),
     class:String(r["班级"]).trim(),
     registrationCode:String(r["初始注册码"]).trim(),
     password:"",parentPin:"",registered:false,needsPasswordReset:false,points:0
   };
   x.invalid=!x.id||!x.name||!x.class||!x.registrationCode;
   x.dupInFile=seen.has(x.id); if(x.id)seen.add(x.id);
   x.dupExisting=existing.has(x.id);
   return x;
 });
 const bad=pendingImport.filter(x=>x.invalid).length;
 const dup=pendingImport.filter(x=>x.dupInFile||x.dupExisting).length;
 const summary=document.getElementById("importSummary");
 summary.className="status "+((bad||dup)?"warn":"ok");
 summary.textContent=`读取 ${pendingImport.length} 行；缺失字段 ${bad} 行；重复ID ${dup} 行。黄色/红色行不会导入。`;
 document.getElementById("previewWrap").innerHTML=
   `<table><tr><th>行</th><th>学生ID</th><th>姓名</th><th>班级</th><th>初始注册码</th><th>状态</th></tr>`+
   pendingImport.map(x=>`<tr class="${x.invalid?'invalid':(x.dupInFile||x.dupExisting?'dup':'')}"><td>${x.row}</td><td>${escapeHtml(x.id)}</td><td>${escapeHtml(x.name)}</td><td>${escapeHtml(x.class)}</td><td>${escapeHtml(x.registrationCode)}</td><td>${x.invalid?'缺失字段':(x.dupInFile?'文件内重复':(x.dupExisting?'系统已存在':'可导入'))}</td></tr>`).join("")+"</table>";
 document.getElementById("confirmImportBtn").disabled=!pendingImport.some(x=>!x.invalid&&!x.dupInFile&&!x.dupExisting);
}

window.confirmImport=function(){
 const valid=pendingImport.filter(x=>!x.invalid&&!x.dupInFile&&!x.dupExisting).map(({row,invalid,dupInFile,dupExisting,...x})=>x);
 if(!valid.length){alert("没有可导入的学生");return}
 students.push(...valid); save();renderStudents();
 const summary=document.getElementById("importSummary");
 summary.className="status ok";
 summary.textContent=`成功导入 ${valid.length} 名学生。学生可自行完成首次注册密码。`;
 document.getElementById("confirmImportBtn").disabled=true; pendingImport=[];
}

window.resetImport=function(){
 pendingImport=[];
 const input=document.getElementById("xlsxFile"); if(input)input.value="";
 document.getElementById("previewWrap").innerHTML="";
 const summary=document.getElementById("importSummary"); summary.className="status"; summary.textContent="尚未选择文件";
 document.getElementById("confirmImportBtn").disabled=true;
}

window.clearStudents=function(){
 if(confirm("确认清空当前浏览器中的全部学生名单吗？此操作不会删除任务和背诵记录。")){
   students=[];current=null;loginOk=secondOk=phraseOk=liveOk=false;save();renderStudents();renderPoints();updateGate();
 }
}

window.login=async function(){
 const id=document.getElementById("studentId").value.trim(),pw=document.getElementById("studentPassword").value,msg=document.getElementById("loginMsg");
 try{
   const d=await CloudAPI.studentLogin(id,pw);studentToken=d.token;sessionStorage.setItem("studentToken",studentToken);current=d.profile;loginOk=true;secondOk=phraseOk=liveOk=false;eyeCalibrationReady=sessionVerificationReady=false;
   msg.textContent=`登录成功：${current.name}（${current.class}）`;msg.className="status ok";await loadStudentCloudState()
 }catch(e){
   current=null;loginOk=false;const c=e?.data?.code;
   msg.textContent=c==="NOT_REGISTERED"?"该学生尚未注册，请先设置密码":c==="NEEDS_RESET"?"老师已批准重置，请重新设置密码":"学生ID或密码错误";msg.className="status bad"
 }
 updateGate();renderPoints();renderTaskAttemptStatus()
}
window.registerStudentAccount=async function(){
 const b={id:document.getElementById("regStudentId").value.trim(),name:document.getElementById("regStudentName").value.trim(),registrationCode:document.getElementById("regCode").value.trim(),password:document.getElementById("regPassword").value,password2:document.getElementById("regPassword2").value,parentPin:document.getElementById("regParentPin").value.trim()};
 const msg=document.getElementById("registerMsg");
 if(b.password.length<6){msg.textContent="登录密码至少6位";msg.className="status bad";return}
 if(b.password!==b.password2){msg.textContent="两次密码不一致";msg.className="status bad";return}
 if(!/^\d{4,6}$/.test(b.parentPin)){msg.textContent="家长PIN需4-6位数字";msg.className="status bad";return}
 try{await CloudAPI.studentRegister(b);msg.textContent="设置成功，请用学生ID+密码登录";msg.className="status ok"}
 catch(e){msg.textContent="设置失败："+(e?.data?.error||friendlyCloudError(e));msg.className="status bad"}
}
window.requestPasswordReset=async function(){
 const id=document.getElementById("forgotStudentId").value.trim(),name=document.getElementById("forgotStudentName").value.trim(),msg=document.getElementById("forgotMsg");
 try{await CloudAPI.requestPasswordReset(id,name);msg.textContent="密码重置申请已提交";msg.className="status ok"}
 catch(e){msg.textContent="提交失败："+(e?.data?.error||friendlyCloudError(e));msg.className="status bad"}
}

window.requestOtp=function(){
 if(!loginOk){alert("请先登录");return}
 if(document.getElementById("verifyMode").value!=="otp"){alert("当前选择的是家长 PIN");return}
 otp=String(Math.floor(100000+Math.random()*900000));
 document.getElementById("verifyMsg").textContent="测试验证码："+otp;
 document.getElementById("verifyMsg").className="status warn";
}

window.verifySecondFactor=async function(){
 if(!current){alert("请先登录");return}
 const mode=document.getElementById("verifyMode").value,code=document.getElementById("verifyCode").value.trim();
 if(mode==="pin"){try{const r=await CloudAPI.verifyParentPin(studentToken,code);secondOk=!!r.ok}catch(e){secondOk=false}}
 else secondOk=(code===otp&&otp!=="");
 document.getElementById("verifyMsg").textContent=secondOk?"第二步核验通过":"核验失败";
 document.getElementById("verifyMsg").className="status "+(secondOk?"ok":"bad");updateGate()
}

const phrases=[
 "Today is a good day",
 "I like English",
 "This is my school",
 "I can read by myself",
 "Learning English is fun"
];

window.newPhrase=function(){
 if(!secondOk){alert("请先完成账号和第二步核验");return}
 currentPhrase=phrases[Math.floor(Math.random()*phrases.length)];
 document.getElementById("phraseText").textContent=currentPhrase;
 document.getElementById("phraseResult").value="";
 phraseOk=false; updateGate();
}

window.speakPhrase=function(){
 if(!currentPhrase){newPhrase(); if(!currentPhrase)return}
 const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
 if(!SR){alert("当前浏览器不支持网页语音识别，可先手动输入测试。");return}
 recognition=new SR(); recognition.lang="en-US"; recognition.interimResults=true;
 recognition.onresult=e=>{
   let t=""; for(let i=0;i<e.results.length;i++) t+=e.results[i][0].transcript+" ";
   document.getElementById("phraseResult").value=t.trim();
 };
 recognition.start();
}

function norm(s){return (s.toLowerCase().match(/[a-z']+/g)||[]).join(" ")}
window.checkPhrase=function(){
 const spoken=norm(document.getElementById("phraseResult").value);
 const target=norm(currentPhrase);
 phraseOk=!!target && spoken===target;
 document.getElementById("phraseMsg").textContent=phraseOk?"随机口令通过":"口令不一致，请重新读";
 document.getElementById("phraseMsg").className="status "+(phraseOk?"ok":"bad");
 updateGate();
}

window.onLivenessPassed=function(){
 liveOk=true;
 eyeCalibrationReady=false;
 const calBtn=document.getElementById("eyeCalibrationBtn");
 if(calBtn){calBtn.disabled=false;calBtn.textContent="开始睁眼/闭眼校准";}
 const calStatus=document.getElementById("eyeCalibrationStatus");
 if(calStatus){calStatus.className="status warn";calStatus.textContent="活体检测已通过，请点击“开始睁眼/闭眼校准”";}
 updateGate();
}

window.beginEyeCalibration=async function(){
 if(!liveOk){alert("请先完成活体检测");return}
 if(!window.__cameraStream){alert("请先打开摄像头");return}
 const btn=document.getElementById("eyeCalibrationBtn");
 if(btn){btn.disabled=true;btn.textContent="校准中…";}
 const ok=await window.startPreRecitationEyeCalibration?.();
 if(!ok && btn){btn.disabled=false;btn.textContent="重新开始睁眼/闭眼校准";}
}

function updateGate(){
 [["c1",loginOk],["c2",secondOk],["c3",phraseOk],["c4",liveOk],["c5",eyeCalibrationReady]].forEach(([id,ok])=>{
   const el=document.getElementById(id);
   if(el){el.textContent=ok?"已通过":"未通过"; el.className=ok?"pass":"fail";}
 });
 const ok=loginOk&&secondOk&&phraseOk&&liveOk&&eyeCalibrationReady&&sessionVerificationReady;
 const gate=document.getElementById("gate");
 gate.textContent=ok?"全部核验通过，可以开始背诵":"核验未完成，请依次完成到“睁眼/闭眼校准”";
 gate.className="status "+(ok?"ok":"bad");
 document.getElementById("speechBtn").disabled=!ok;
 document.getElementById("gradeBtn").disabled=true;
 renderTaskAttemptStatus();
}

function renderTasks(){
 const sel=document.getElementById("taskSelect");
 const previous=sel.value;
 sel.innerHTML=tasks.map(t=>`<option value="${t.id}">${escapeHtml(t.title)}（${t.type==="word"?"单词":"课文"}）</option>`).join("");
 if(previous && tasks.some(t=>t.id===previous)) sel.value=previous;
 sel.onchange=()=>{document.getElementById("recognized").value="";document.getElementById("scoreResult").innerHTML="";renderTaskAttemptStatus();};
}
function getTask(){return tasks.find(t=>t.id===document.getElementById("taskSelect").value)}

window.startRecitationSpeech=async function(){
 const baseOk=loginOk&&secondOk&&phraseOk&&liveOk&&eyeCalibrationReady&&sessionVerificationReady;
 if(!baseOk||!current){
   alert("请先完成登录、第二步核验、随机口令、活体检测和睁眼/闭眼校准");
   return;
 }
 if(!window.hasEyeCalibration?.()){
   alert("请先在上方视频区域完成睁眼/闭眼校准。");
   return;
 }

 const task=getTask();
 if(!task){alert("当前没有背诵任务");return}
 const info=taskAttemptInfo(current.id,task);
 if(info.passed){alert("这个任务已经合格，不需要再次背诵。");return}
 if(info.used>=info.max){alert("本任务背诵次数已经用完，请先申请老师增加次数。");return}
 if(recitationActive){alert("当前已经在背诵检测中");return}

 const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
 if(!SR){alert("当前浏览器不支持网页语音识别。");return}

 const speechStatus=document.getElementById("speechStatus");
 const eyeStatus=document.getElementById("eyeMonitorStatus");
 const eyeTime=document.getElementById("eyeOpenTime");

 document.getElementById("recognized").value="";
 document.getElementById("scoreResult").innerHTML="";

 // 在麦克风权限真正通过前，明确保持闭眼计时为0。
 if(eyeStatus){
   eyeStatus.className="status";
   eyeStatus.textContent="等待麦克风允许后才开始闭眼计时";
 }
 if(eyeTime) eyeTime.textContent="累计睁眼：0.0 / 3.0 秒";

 let finalText="";
 let micStarted=false;
 let micStartResolve, micStartReject;
 const micStartPromise=new Promise((resolve,reject)=>{
   micStartResolve=resolve;
   micStartReject=reject;
 });

 recognition=new SR();
 recognition.lang="en-US";
 recognition.continuous=true;
 recognition.interimResults=true;

 recognition.onstart=()=>{
   micStarted=true;
   speechStatus.className="status ok";
   speechStatus.textContent="🎤 麦克风已允许，正在启动闭眼计时…";
   micStartResolve(true);
 };

 recognition.onresult=e=>{
   if(!recitationActive)return;
   let interim="";
   for(let i=e.resultIndex;i<e.results.length;i++){
     const t=e.results[i][0].transcript;
     if(e.results[i].isFinal)finalText+=" "+t;
     else interim+=" "+t;
   }
   document.getElementById("recognized").value=(finalText+" "+interim).trim();
 };

 recognition.onerror=e=>{
   const map={
     "not-allowed":"麦克风权限被拒绝，请允许麦克风后重新开始",
     "service-not-allowed":"浏览器不允许使用语音识别服务",
     "audio-capture":"没有检测到可用麦克风",
     "network":"语音识别网络连接失败",
     "no-speech":"没有检测到语音，请继续说话"
   };
   speechStatus.className="status bad";
   speechStatus.textContent=map[e.error]||("语音识别异常："+e.error);

   // 麦克风尚未真正启动时发生错误：本次不开始计时，也不占次数。
   if(!micStarted){
     try{micStartReject(new Error(e.error||"mic-error"))}catch(_){}
   }
 };

 recognition.onend=()=>{
   // 只有正式背诵已经开始后，才尝试自动续接语音识别。
   if(recitationActive&&!recitationCompleting){
     try{recognition.start()}catch(e){}
   }
 };

 // 关键：必须在用户点击事件中立即调用 start()，让浏览器正常弹麦克风授权。
 try{
   speechStatus.className="status warn";
   speechStatus.textContent="正在等待麦克风权限…";
   recognition.start();
 }catch(e){
   speechStatus.className="status bad";
   speechStatus.textContent="语音识别启动失败，请检查麦克风权限";
   return;
 }

 // 等到浏览器明确触发 onstart，才允许闭眼计时开始。
 try{
   await Promise.race([
     micStartPromise,
     new Promise((_,reject)=>setTimeout(()=>reject(new Error("mic-timeout")),15000))
   ]);
 }catch(e){
   try{recognition.stop()}catch(_){}
   if(eyeStatus){
     eyeStatus.className="status bad";
     eyeStatus.textContent="麦克风尚未启动，本次没有开始背诵，也没有累计睁眼时间";
   }
   if(eyeTime)eyeTime.textContent="累计睁眼：0.0 / 3.0 秒";
   if(String(e.message)==="mic-timeout"){
     speechStatus.className="status bad";
     speechStatus.textContent="等待麦克风授权超时，请重新点击开始";
   }
   return;
 }

 // 麦克风已真正允许后，若上一任务提交时已经关闭摄像头，则自动重新打开。
 // 这里只恢复摄像头画面，沿用本次登录已经完成的活体与眼睛校准。
 if(!window.__cameraStream){
   const cameraOk=await window.startCamera(true);
   if(!cameraOk){
     try{recognition.stop()}catch(e){}
     speechStatus.className="status bad";
     speechStatus.textContent="摄像头重新打开失败，本次未开始";
     return;
   }
 }

 // 摄像头就绪后才从0开始本次闭眼计时。
 const monitor=await window.startClosedEyeSession?.(3000);
 if(!monitor?.ok){
   try{recognition.stop()}catch(e){}
   const reason=monitor?.reason;
   speechStatus.className="status bad";
   speechStatus.textContent="闭眼检测启动失败，本次未开始";
   alert(reason==="calibration"?"眼睛校准已失效，请重新完成视频校准。":"闭眼检测启动失败，请重试。");
   return;
 }

 // 正式开始：此刻起才允许语音结果写入，并从0累计睁眼时间。
 finalText="";
 document.getElementById("recognized").value="";
 recitationActive=true;
 recitationCompleting=false;
 lastEyeStats={openMs:0,violation:false};

 speechStatus.className="status ok";
 speechStatus.textContent="🎤 麦克风已启动，正在语音识别，请保持闭眼背诵";
 if(eyeStatus){
   eyeStatus.className="status ok";
   eyeStatus.textContent="正式背诵已开始，闭眼计时从 0 秒开始";
 }
 if(eyeTime)eyeTime.textContent="累计睁眼：0.0 / 3.0 秒";

 updateRecitationButtons();
}

window.stopSpeech=function(){
 try{recognition&&recognition.stop()}catch(e){}
 const speechStatus=document.getElementById("speechStatus");
 if(speechStatus){speechStatus.className="status warn";speechStatus.textContent="语音识别已停止，请尽快提交评分";}
 const box=document.getElementById("eyeMonitorStatus");
 if(recitationActive&&box&&!lastEyeStats.violation){
   box.className="status warn";
   box.textContent="语音识别已停止，但摄像头仍在检测闭眼状态；请尽快提交评分。";
 }
};

function tokenize(s){return (s.toLowerCase().match(/[a-z']+/g)||[])}
function scoreText(target,spoken){
 const a=tokenize(target),b=tokenize(spoken),counts={};
 b.forEach(w=>counts[w]=(counts[w]||0)+1);
 let hit=0;a.forEach(w=>{if(counts[w]>0){hit++;counts[w]--}});
 return a.length?Math.round(hit/a.length*100):0;
}

function recordMatchesTask(r,task){
 return String(r.studentId)===String(current?.id) &&
   ((r.taskId && String(r.taskId)===String(task.id)) || (!r.taskId && r.task===task.title));
}
function studentTaskRecords(studentId,task){
 return records.filter(r=>String(r.studentId)===String(studentId) &&
   ((r.taskId && String(r.taskId)===String(task.id)) || (!r.taskId && r.task===task.title)));
}
function taskPassed(studentId,task){
 return studentTaskRecords(studentId,task).some(r=>r.pass);
}
function approvedExtraAttempts(studentId,taskId){
 return approvals
   .filter(a=>String(a.studentId)===String(studentId)&&String(a.taskId)===String(taskId)&&a.status==="approved")
   .reduce((sum,a)=>sum+(Number(a.extraAttempts)||1),0);
}
function taskAttemptInfo(studentId,task){
 const rs=studentTaskRecords(studentId,task);
 const used=rs.length;
 const extra=approvedExtraAttempts(studentId,task.id);
 const max=3+extra;
 const passed=rs.some(r=>r.pass);
 const pending=approvals.some(a=>String(a.studentId)===String(studentId)&&String(a.taskId)===String(task.id)&&a.status==="pending");
 return {used,extra,max,passed,pending,remaining:Math.max(0,max-used)};
}
function passedTaskKey(r){
 return r.taskId ? "id:"+String(r.taskId) : "legacy:"+String(r.task||"");
}
function passedTaskRecords(studentId){
 const seen=new Set(), out=[];
 records.filter(r=>String(r.studentId)===String(studentId)&&r.pass).forEach(r=>{
   const key=passedTaskKey(r);
   if(!seen.has(key)){seen.add(key);out.push(r);}
 });
 return out;
}
function syncStudentPoints(studentId){
 const s=students.find(x=>String(x.id)===String(studentId));
 if(s) s.points=passedTaskRecords(studentId).length;
}

async function completeRecitationAttempt(forceEyeFail=false){
 if(recitationCompleting)return;
 if(!current||!recitationActive)return;
 recitationCompleting=true;

 const task=getTask();
 const info=taskAttemptInfo(current.id,task);
 if(info.passed||info.used>=info.max){
   recitationCompleting=false;return;
 }

 const spoken=document.getElementById("recognized").value.trim();
 if(!forceEyeFail && !spoken){
   recitationCompleting=false;
   alert("暂时没有识别到背诵内容，请继续背诵后再提交。");
   return;
 }

 try{recognition&&recognition.stop()}catch(e){}
 const eyeStats=window.stopClosedEyeSession?.()||{openMs:0,violation:false};
 lastEyeStats=eyeStats;
 const eyeViolation=forceEyeFail||eyeStats.violation||eyeStats.openMs>3000;

 // 提交后必须关闭摄像头。下一次开始会重新打开并重新计时。
 window.stopCamera(true);
 recitationActive=false;
 const speechStatus=document.getElementById("speechStatus");
 if(speechStatus){speechStatus.className="status";speechStatus.textContent="本次语音识别已结束";}

 const score=spoken?scoreText(task.text,spoken):0;
 const pass=!eyeViolation && score>=80;
 const spotRate=Number(localStorage.getItem("spotRate")||0.2);
 const spotCheck=Math.random()<spotRate;

 try{
   await CloudAPI.submitAttempt(studentToken,{taskId:task.id,score,eyeOpenMs:Math.round(eyeStats.openMs||0),eyeViolation,spotCheck});
   await loadStudentCloudState();
 }catch(e){
   recitationCompleting=false;updateRecitationButtons();alert("成绩提交云端失败："+friendlyCloudError(e));return;
 }
 const after=taskAttemptInfo(current.id,task);
 const eyeSec=((eyeStats.openMs||0)/1000).toFixed(1);
 let result=`<div class="big">${score}%</div>`;
 if(eyeViolation){
   result+=`<div class="status bad">本次未通过：累计睁眼 ${eyeSec} 秒，超过允许的 3 秒。本次已计入一次背诵机会。</div>`;
 }else{
   result+=`<div class="status ${pass?"ok":"bad"}">${pass?"合格，本任务获得 1 分":"未合格，需要达到 80%"}</div>`;
   result+=`<div class="status ok">闭眼检测通过：累计睁眼 ${eyeSec} / 3.0 秒</div>`;
 }
 if(!pass){
   result+=`<div class="status ${after.remaining>0?"warn":"bad"}">本任务已使用 ${after.used}/${after.max} 次；剩余 ${after.remaining} 次。</div>`;
   if(after.remaining===0) result+=`<button class="warn" onclick="requestMoreAttempts()">申请老师增加背诵次数</button>`;
 }
 if(spotCheck) result+='<div class="status warn">本次被随机抽中：正式版需上传短视频供老师人工抽查</div>';
 document.getElementById("scoreResult").innerHTML=result;

 recitationCompleting=false;
 updateRecitationButtons();
 renderTaskAttemptStatus();
}

window.grade=function(){
 if(!recitationActive){
   alert("请先点击“开始背诵/背单词”，系统需要在整个背诵过程中检测闭眼状态。");
   return;
 }
 if(!eyeCalibrationReady){
   alert("请先在上方视频区域完成睁眼/闭眼校准。");
   return;
 }
 completeRecitationAttempt(false);
};

window.onPreEyeCalibrationReady=function(){
 eyeCalibrationReady=true;
 sessionVerificationReady=true;
 const calBtn=document.getElementById("eyeCalibrationBtn");
 if(calBtn){calBtn.disabled=true;calBtn.textContent="✅ 睁眼/闭眼校准已完成";}
 const speechStatus=document.getElementById("speechStatus");
 if(speechStatus){
   speechStatus.className="status";
   speechStatus.textContent="眼睛校准已完成，点击开始背诵后再启动语音识别";
 }
 updateGate();
};

window.onPreEyeCalibrationFailed=function(){
 eyeCalibrationReady=false;
 sessionVerificationReady=false;
 const calBtn=document.getElementById("eyeCalibrationBtn");
 if(calBtn){calBtn.disabled=false;calBtn.textContent="重新开始睁眼/闭眼校准";}
 updateGate();
};

window.onEyeOpenLimitExceeded=function(openMs){
 lastEyeStats={openMs,violation:true};
 const box=document.getElementById("eyeMonitorStatus");
 if(box){box.className="status bad";box.textContent="累计睁眼超过 3 秒，本次自动判为未通过。";}
 completeRecitationAttempt(true);
};

function updateRecitationButtons(){
 const speech=document.getElementById("speechBtn");
 const grade=document.getElementById("gradeBtn");
 const stop=document.getElementById("stopSpeechBtn");
 if(speech){
   speech.textContent=recitationActive?"正在背诵检测中…":"🎤 开始背诵 / 背单词";
 }
 if(stop)stop.disabled=!recitationActive;
 // 最终可用性还会在 renderTaskAttemptStatus 里结合任务次数计算。
 renderTaskAttemptStatus();
}

window.requestMoreAttempts=async function(){
 if(!current){alert("请先登录");return}
 const task=getTask();if(!task)return;
 try{await CloudAPI.requestExtra(studentToken,task.id);await loadStudentCloudState();alert("申请已提交，请等待老师审批")}
 catch(e){alert("申请失败："+(e?.data?.error||friendlyCloudError(e)))}
}

function renderTaskAttemptStatus(){
 const box=document.getElementById("taskAttemptStatus");
 const requestBox=document.getElementById("attemptRequestBox");
 if(!box)return;
 if(!current){box.className="status";box.textContent="登录后可查看本任务背诵次数。";if(requestBox)requestBox.innerHTML="";return}
 const task=getTask();
 if(!task){box.textContent="暂无任务";return}
 const info=taskAttemptInfo(current.id,task);
 if(info.passed){
   box.className="status ok";
   box.textContent=`本任务已合格 · 积分 1 分 · 共背诵 ${info.used} 次`;
   if(requestBox)requestBox.innerHTML="";
 }else{
   box.className="status "+(info.remaining?"warn":"bad");
   box.textContent=`本任务已使用 ${info.used}/${info.max} 次，剩余 ${info.remaining} 次${info.extra?`（老师额外批准 ${info.extra} 次）`:""}`;
   if(requestBox){
     requestBox.innerHTML=info.remaining===0
       ? (info.pending
          ? '<div class="status warn">增加次数申请已提交，等待老师审批。</div>'
          : '<button class="warn" onclick="requestMoreAttempts()">申请老师增加背诵次数</button>')
       : "";
   }
 }
 // Gate the submit button additionally by attempt state.
 const baseOk=loginOk&&secondOk&&phraseOk&&liveOk&&eyeCalibrationReady&&sessionVerificationReady;
 document.getElementById("speechBtn").disabled=!baseOk||!eyeCalibrationReady||info.passed||info.remaining===0||recitationActive;
 document.getElementById("gradeBtn").disabled=!baseOk||info.passed||info.remaining===0||!recitationActive||!eyeCalibrationReady;
 const stopBtn=document.getElementById("stopSpeechBtn");
 if(stopBtn)stopBtn.disabled=!recitationActive;
}

function renderPoints(){
 const total=document.getElementById("points");
 const history=document.getElementById("studentPointHistory");
 if(!current){if(total)total.textContent="0";if(history)history.innerHTML='<div class="note">登录后可查看历史任务积分。</div>';return}
 syncStudentPoints(current.id);
 if(total) total.textContent=current.points||0;
 if(history){
   const rows=[];
   const seen=new Set();
   // 现有任务
   tasks.forEach(task=>{
     const info=taskAttemptInfo(current.id,task);
     const key="id:"+String(task.id); seen.add(key);
     const result=info.passed?"已合格":(info.used?"未合格":"未开始");
     rows.push({title:task.title,used:info.used,max:info.max,result,point:info.passed?1:0});
   });
   // 已删除但有历史记录的任务
   const grouped={};
   records.filter(r=>String(r.studentId)===String(current.id)).forEach(r=>{
     const key=passedTaskKey(r);
     if(seen.has(key))return;
     if(!grouped[key])grouped[key]={title:r.task||"已删除任务",used:0,passed:false};
     grouped[key].used++; if(r.pass)grouped[key].passed=true;
   });
   Object.values(grouped).forEach(g=>rows.push({title:g.title+"（已删除）",used:g.used,max:"—",result:g.passed?"已合格":"未合格",point:g.passed?1:0}));
   history.innerHTML=`<table><tr><th>历史任务</th><th>背诵次数</th><th>结果</th><th>积分</th></tr>`+
     rows.map(r=>`<tr><td>${escapeHtml(r.title)}</td><td>${r.used}/${r.max}</td><td>${r.result}</td><td>${r.point}</td></tr>`).join("")+`</table>`;
 }
 save();
}

window.saveSpotRate=function(){localStorage.setItem("spotRate",document.getElementById("spotRate").value)}
function renderStudents(){
 const box=document.getElementById("studentTable");
 if(!box)return;
 box.innerHTML=
 `<table><tr><th>ID</th><th>姓名</th><th>班级</th><th>账号状态</th><th>积分</th></tr>`+
 students.map(s=>{
   const state=s.needsPasswordReset?"待重新设置密码":(s.registered?"已注册":"未注册");
   return `<tr><td>${escapeHtml(s.id)}</td><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.class)}</td><td>${state}</td><td>${s.points||0}</td></tr>`;
 }).join("")+"</table>";
}
window.addTask=function(){
 const title=document.getElementById("newTaskTitle").value.trim();
 const type=document.getElementById("newTaskType").value;
 const text=document.getElementById("newTaskText").value.trim();
 if(!title||!text){alert("请填写任务名和文本");return}
 if(editingTaskId){
   const task=tasks.find(t=>String(t.id)===String(editingTaskId));
   if(!task){alert("任务不存在");cancelTaskEdit();return}
   const oldTitle=task.title;
   task.title=title; task.type=type; task.text=text;
   // 同步历史显示名称，不改变成绩
   records.forEach(r=>{
     if((r.taskId && String(r.taskId)===String(task.id)) || (!r.taskId && r.task===oldTitle)) r.task=title;
   });
   approvals.forEach(a=>{if(String(a.taskId)===String(task.id))a.taskTitle=title;});
   save();cancelTaskEdit();renderTasks();renderTaskTable();renderRecords();renderPoints();
   alert("任务已修改");
 }else{
   tasks.push({id:"t"+Date.now(),title,type,text});
   save();renderTasks();renderTaskTable();
   document.getElementById("newTaskTitle").value="";
   document.getElementById("newTaskText").value="";
 }
}

window.editTask=function(id){
 if(!teacherLoggedIn){alert("请先登录教师端");return}
 const task=tasks.find(t=>String(t.id)===String(id)); if(!task)return;
 editingTaskId=task.id;
 document.getElementById("newTaskTitle").value=task.title;
 document.getElementById("newTaskType").value=task.type;
 document.getElementById("newTaskText").value=task.text;
 document.getElementById("saveTaskBtn").textContent="保存修改";
 document.getElementById("cancelTaskEditBtn").classList.remove("hidden");
 document.getElementById("taskEditHint").textContent="正在编辑："+task.title;
 document.getElementById("newTaskTitle").scrollIntoView({behavior:"smooth",block:"center"});
}

window.cancelTaskEdit=function(){
 editingTaskId=null;
 const title=document.getElementById("newTaskTitle"), text=document.getElementById("newTaskText");
 if(title)title.value=""; if(text)text.value="";
 const btn=document.getElementById("saveTaskBtn"); if(btn)btn.textContent="新增任务";
 const cancel=document.getElementById("cancelTaskEditBtn"); if(cancel)cancel.classList.add("hidden");
 const hint=document.getElementById("taskEditHint"); if(hint)hint.textContent="";
}

window.deleteTask=function(id){
 if(!teacherLoggedIn){alert("请先登录教师端");return}
 const task=tasks.find(t=>String(t.id)===String(id)); if(!task)return;
 const used=records.filter(r=>(r.taskId&&String(r.taskId)===String(task.id))||(!r.taskId&&r.task===task.title)).length;
 const extra=used?`\\n这个任务已有 ${used} 条历史背诵记录。删除任务不会删除这些历史记录和已获得积分。`:"";
 if(!confirm(`确认删除任务“${task.title}”吗？${extra}`))return;
 tasks=tasks.filter(t=>String(t.id)!==String(id));
 if(String(editingTaskId)===String(id))cancelTaskEdit();
 save();renderTasks();renderTaskTable();renderPoints();
}

function renderTaskTable(){
 const box=document.getElementById("taskTable"); if(!box)return;
 if(!tasks.length){box.innerHTML='<div class="note">暂无任务</div>';return}
 box.innerHTML=tasks.map(t=>`
   <div class="task">
     <div class="row" style="align-items:center">
       <div style="flex:2"><b>${escapeHtml(t.title)}</b><div class="note">${t.type==="word"?"单词":"课文"} · ${tokenize(t.text).length} 个词</div></div>
       <button class="secondary" onclick="editTask('${t.id}')">编辑</button>
       <button class="badBtn" onclick="deleteTask('${t.id}')">删除</button>
     </div>
     <details style="margin-top:8px">
       <summary style="cursor:pointer;font-weight:700">查看任务内容</summary>
       <div class="taskContent">${escapeHtml(t.text)}</div>
     </details>
   </div>`).join("");
}


function renderPasswordResetRequests(){
 const box=document.getElementById("passwordResetTable");
 if(!box)return;
 const pending=passwordResetRequests.filter(r=>r.status==="pending");
 const processed=passwordResetRequests.filter(r=>r.status!=="pending").slice(0,50);
 let html='<h3>待处理</h3>';
 if(!pending.length) html+='<div class="note">暂无密码重置申请。</div>';
 else html+=`<table><tr><th>申请时间</th><th>学生</th><th>班级</th><th>处理</th></tr>`+
 pending.map(r=>`<tr><td>${escapeHtml(r.requestedAt||"")}</td><td>${escapeHtml(r.studentName||"")}<br><span class="note">${escapeHtml(r.studentId||"")}</span></td><td>${escapeHtml(r.class||"")}</td><td><button class="good" onclick="processPasswordReset('${r.id}','approve')">批准重置</button> <button class="secondary" onclick="processPasswordReset('${r.id}','reject')">拒绝</button></td></tr>`).join("")+'</table>';
 html+='<h3 style="margin-top:18px">已处理</h3>';
 if(!processed.length) html+='<div class="note">暂无已处理记录。</div>';
 else html+=`<table><tr><th>处理时间</th><th>学生</th><th>结果</th><th>新密码状态</th></tr>`+
 processed.map(r=>`<tr><td>${escapeHtml(r.processedAt||"")}</td><td>${escapeHtml(r.studentName||"")}</td><td>${r.status==="approved"?"已批准":"已拒绝"}</td><td>${r.completedAt?"已重新设置":"—"}</td></tr>`).join("")+'</table>';
 box.innerHTML=html;
}

window.processPasswordReset=function(id,action){
 if(!teacherLoggedIn){alert("请先登录教师端");return}
 const r=passwordResetRequests.find(x=>x.id===id);
 if(!r||r.status!=="pending")return;
 r.status=action==="approve"?"approved":"rejected";
 r.processedAt=new Date().toLocaleString();
 if(action==="approve"){
   const s=students.find(x=>String(x.id)===String(r.studentId));
   if(s) s.needsPasswordReset=true;
 }
 save();
 renderPasswordResetRequests();
 renderStudents();
};

function renderApprovals(){
 const box=document.getElementById("approvalTable");
 if(!box)return;
 const pending=approvals.filter(a=>a.status==="pending");
 const processed=approvals.filter(a=>a.status!=="pending").slice(0,50);
 let html='<h3>待处理</h3>';
 if(!pending.length) html+='<div class="note">暂无待审批申请。</div>';
 else html+=`<table><tr><th>申请时间</th><th>学生</th><th>任务</th><th>当前次数</th><th>处理</th></tr>`+
   pending.map(a=>{
     const task=tasks.find(t=>String(t.id)===String(a.taskId));
     const info=task?taskAttemptInfo(a.studentId,task):{used:"-",max:"-"};
     return `<tr><td>${escapeHtml(a.requestedAt)}</td><td>${escapeHtml(a.studentName)}<br><span class="note">${escapeHtml(a.studentId)}</span></td><td>${escapeHtml(a.taskTitle)}</td><td>${info.used}/${info.max}</td><td><button class="good" onclick="processApproval('${a.id}','approve')">批准 +1次</button> <button class="secondary" onclick="processApproval('${a.id}','reject')">拒绝</button></td></tr>`;
   }).join("")+'</table>';
 html+='<h3 style="margin-top:18px">已处理</h3>';
 if(!processed.length) html+='<div class="note">暂无已处理记录。</div>';
 else html+=`<table><tr><th>处理时间</th><th>学生</th><th>任务</th><th>结果</th></tr>`+
   processed.map(a=>`<tr><td>${escapeHtml(a.processedAt||"")}</td><td>${escapeHtml(a.studentName)}</td><td>${escapeHtml(a.taskTitle)}</td><td>${a.status==="approved"?"已批准 +"+(a.extraAttempts||1)+" 次":"已拒绝"}</td></tr>`).join("")+'</table>';
 box.innerHTML=html;
}

window.processApproval=function(id,action){
 if(!teacherLoggedIn){alert("请先登录教师端");return}
 const a=approvals.find(x=>x.id===id);
 if(!a||a.status!=="pending")return;
 a.status=action==="approve"?"approved":"rejected";
 a.extraAttempts=action==="approve"?1:0;
 a.processedAt=new Date().toLocaleString();
 save();renderApprovals();renderTaskAttemptStatus();renderPoints();
}

function renderRecords(){
 document.getElementById("recordTable").innerHTML=
 `<table><tr><th>时间</th><th>学生</th><th>任务</th><th>准确率</th><th>睁眼累计</th><th>结果</th><th>抽查</th></tr>`+
 records.slice(0,100).map(r=>{
   const eye=(r.eyeOpenMs===undefined)?"—":(Number(r.eyeOpenMs)/1000).toFixed(1)+"秒"+(r.eyeViolation?" ⚠️":"");
   return `<tr><td>${escapeHtml(r.time)}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.task)}</td><td>${r.score}%</td><td>${eye}</td><td>${r.pass?"合格":"未合格"}</td><td>${r.spotCheck?"是":"否"}</td></tr>`;
 }).join("")+"</table>";
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
function renderAll(){renderTasks();renderStudents();renderTaskTable();renderRecords();renderApprovals();renderPasswordResetRequests();renderPoints();updateGate();renderTaskAttemptStatus();}
renderAll();
updateTeacherVisibility();

window.addEventListener("load",()=>initCloud());
