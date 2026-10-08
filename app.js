
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
let wordEditorItems=[];
let hearingRecognition=null,hearingRunning=false,hearingFinalText="",hearingFontSize=42;
let spellingTaskId=null,spellingIndex=0;
let wordTestTaskId=null,wordTestOrder=[],wordTestIndex=0,wordTestAnswers=[],wordTestActive=false;
let sectionEditorItems=[];
let selectedSectionIndex=-1;
let studentMistakes=JSON.parse(localStorage.getItem("v75mistakes")||"{}");
let appSettings=JSON.parse(localStorage.getItem("v76settings")||"null")||{eyeLimitMs:3000};
let selectedStudentIds=new Set();
let teacherToken=localStorage.getItem("teacherTokenPersistent")||sessionStorage.getItem("teacherToken")||"";
let studentToken=localStorage.getItem("studentTokenPersistent")||sessionStorage.getItem("studentToken")||"";
let persistentStudentId=localStorage.getItem("studentPersistentId")||"";
let cloudSyncTimer=null,suppressCloudSave=false,cloudReadyForTeacherSave=false;
let teacherLoggedIn=!!teacherToken;

function save(){
 localStorage.setItem("v5students",JSON.stringify(students));
 localStorage.setItem("v5tasks",JSON.stringify(tasks));
 localStorage.setItem("v5records",JSON.stringify(records));
 localStorage.setItem("v53approvals",JSON.stringify(approvals));
 localStorage.setItem("v54passwordResetRequests",JSON.stringify(passwordResetRequests));
 localStorage.setItem("v75mistakes",JSON.stringify(studentMistakes));
 localStorage.setItem("v76settings",JSON.stringify(appSettings));
 if(!suppressCloudSave&&cloudReadyForTeacherSave&&teacherLoggedIn&&teacherToken&&!studentToken&&window.CloudAPI?.configured()){
   clearTimeout(cloudSyncTimer);
   cloudSyncTimer=setTimeout(async()=>{
     try{
       await CloudAPI.teacherSaveState(teacherToken,{
         students:students.map(s=>({id:s.id,name:s.name,class:s.class,registrationCode:s.registrationCode||"",registered:!!s.registered,needsPasswordReset:!!s.needsPasswordReset,points:Number(s.points)||0})),
         tasks,records,approvals,passwordResetRequests,settings:appSettings,rosterMode:"merge-safe"
       });
       setCloudStatus("云端已同步","ok");
       const rosterSummary=document.getElementById("cloudRosterSummary");
       if(rosterSummary&&teacherLoggedIn){
         const registered=students.filter(s=>s.registered).length;
         rosterSummary.textContent=`云端学生 ${students.length} 人 · 已注册 ${registered} 人 · 未注册 ${students.length-registered} 人`;
         rosterSummary.className="status ok";
       }
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
 cloudReadyForTeacherSave=false;
 const d=await CloudAPI.teacherState(teacherToken);
 suppressCloudSave=true;
 try{
   students=d.students||[];
   tasks=d.tasks||[];
   records=d.records||[];
   approvals=d.approvals||[];
   passwordResetRequests=d.passwordResetRequests||[];
   appSettings={eyeLimitMs:3000,...(d.settings||{})};
   save(); // 这里只更新本地缓存，suppressCloudSave=true，不回写云端
 }finally{suppressCloudSave=false}
 cloudReadyForTeacherSave=true;
 const summary=document.getElementById("cloudRosterSummary");
 if(summary){
   const registered=students.filter(s=>s.registered).length;
   summary.textContent=`云端学生 ${students.length} 人 · 已注册 ${registered} 人 · 未注册 ${students.length-registered} 人`;
   summary.className="status ok";
 }
 renderAll();
}
async function loadStudentCloudState(){
 const d=await CloudAPI.studentState(studentToken);
 suppressCloudSave=true;
 try{
   current=d.profile||current;
   tasks=d.tasks||[];
   records=d.records||[];
   approvals=d.approvals||[];
   appSettings={eyeLimitMs:3000,...(d.settings||{})};
   // 关键修复：学生端不再执行 students=[current]，全班名册只属于教师端。
   // 学生端仅通过 current 保存自己的资料。
   save(); // 只写本地缓存，且学生身份不会写 teacher/state
 }finally{suppressCloudSave=false}
 renderTasks();renderWordTasks();renderPoints();renderTaskAttemptStatus();renderMistakeBook();renderSectionStudy();updateEyeLimitUI();updateGate();updateStudentAccountUI();
}
async function initCloud(){
 cloudReadyForTeacherSave=false;
 if(!window.CloudAPI?.configured()){setCloudStatus("尚未配置腾讯云：请编辑 config.js","warn");return}
 try{
   const h=await CloudAPI.request("/health");setCloudStatus("腾讯云已连接 · "+(h.storage||"COS"),"ok");
   if(teacherToken){
     // 当前 tab 如果已有教师会话，教师身份优先，并清除学生身份，避免双身份并存。
     studentToken="";persistentStudentId="";
     sessionStorage.removeItem("studentToken");
     localStorage.removeItem("studentTokenPersistent");
     localStorage.removeItem("studentPersistentId");
     try{
       teacherLoggedIn=true;
       await loadTeacherCloudState();
       updateTeacherVisibility();
       return;
     }catch(e){
       teacherToken="";teacherLoggedIn=false;cloudReadyForTeacherSave=false;
       sessionStorage.removeItem("teacherToken");
       localStorage.removeItem("teacherTokenPersistent");
     }
   }
   if(studentToken){
     try{
       teacherLoggedIn=false;teacherToken="";cloudReadyForTeacherSave=false;
       sessionStorage.removeItem("teacherToken");
       await loadStudentCloudState();
       loginOk=!!current;
       const msg=document.getElementById("loginMsg");
       if(msg&&current){msg.textContent=`本设备已自动登录：${current.name}（${current.class}）`;msg.className="status ok"}
       updateGate();
     }catch(e){
       studentToken="";persistentStudentId="";
       sessionStorage.removeItem("studentToken");
       localStorage.removeItem("studentTokenPersistent");
       localStorage.removeItem("studentPersistentId");
     }
   }
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


window.toggleRegistrationArea=function(force){
 const box=document.getElementById("registrationArea");if(!box)return;
 const show=typeof force==="boolean"?force:box.classList.contains("hidden");
 box.classList.toggle("hidden",!show);
}
window.scrollToStudentArea=function(id){document.getElementById(id)?.scrollIntoView({behavior:"smooth",block:"start"})}
function updateStudentAccountUI(){
 const logged=!!(current&&studentToken&&loginOk);
 const welcome=document.getElementById("studentLoggedInWelcome");
 const loginArea=document.getElementById("studentLoginArea");
 const reg=document.getElementById("registrationArea");
 const forgot=document.getElementById("forgotArea");
 welcome?.classList.toggle("hidden",!logged);
 loginArea?.classList.toggle("hidden",logged);
 forgot?.classList.toggle("hidden",logged);
 if(logged){
   reg?.classList.add("hidden");
   const t=document.getElementById("studentWelcomeText"),m=document.getElementById("studentWelcomeMeta");
   if(t)t.textContent=`👋 ${current.name||"同学"}，欢迎回来`;
   if(m)m.textContent=`${current.class||""} · 学生ID ${current.id||""} · 本设备已自动记住登录`;
 }
}

// ===== 教师端登录（腾讯云） =====
window.teacherLogin=async function(){
 const u=document.getElementById("teacherUser").value.trim(),p=document.getElementById("teacherPassword").value;
 const msg=document.getElementById("teacherLoginMsg");
 try{
   const d=await CloudAPI.teacherLogin(u,p);
   // 教师与学生会话互斥
   studentToken="";persistentStudentId="";current=null;loginOk=false;
   sessionStorage.removeItem("studentToken");
   localStorage.removeItem("studentTokenPersistent");
   localStorage.removeItem("studentPersistentId");
   teacherToken=d.token;
   sessionStorage.setItem("teacherToken",teacherToken);
   localStorage.setItem("teacherTokenPersistent",teacherToken);
   teacherLoggedIn=true;cloudReadyForTeacherSave=false;
   msg.textContent="教师端登录成功";msg.className="status ok";
   await loadTeacherCloudState();
   updateTeacherVisibility();
 }catch(e){
   teacherLoggedIn=false;cloudReadyForTeacherSave=false;
   msg.textContent="教师登录失败："+friendlyCloudError(e);msg.className="status bad";
 }
};
window.teacherLogout=function(){
 try{stopHearingRecognition()}catch(e){}
 document.getElementById("hearingOverlay")?.classList.remove("open");
 document.body.style.overflow="";
 teacherLoggedIn=false;teacherToken="";cloudReadyForTeacherSave=false;
 sessionStorage.removeItem("teacherToken");
 localStorage.removeItem("teacherTokenPersistent");
 updateTeacherVisibility();
};
function updateTeacherVisibility(){
 const box=document.getElementById("teacherProtected");if(box)box.classList.toggle("hidden",!teacherLoggedIn);
 const loginCard=document.getElementById("teacherLoginCard");if(loginCard)loginCard.classList.toggle("hidden",teacherLoggedIn);
 const msg=document.getElementById("teacherLoginMsg");
 if(msg&&teacherLoggedIn){msg.textContent="教师端已登录（本设备已记住）";msg.className="status ok"}
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

window.clearStudents=async function(){
 if(!teacherLoggedIn){alert("请先登录教师端");return}
 if(!confirm("确认清空云端全部学生名单吗？此操作不会删除任务和历史背诵记录。"))return;
 suppressCloudSave=true;
 try{
   await CloudAPI.teacherReplaceRoster(teacherToken,{students:[],tasks,records,approvals,passwordResetRequests,settings:appSettings});
   students=[];selectedStudentIds.clear();
   localStorage.setItem("v5students","[]");
   renderStudents();
   const summary=document.getElementById("cloudRosterSummary");
   if(summary){summary.textContent="云端学生 0 人";summary.className="status ok"}
   setCloudStatus("云端学生名单已清空","ok");
 }catch(e){
   alert("清空失败："+friendlyCloudError(e));
   await loadTeacherCloudState();
 }finally{suppressCloudSave=false}
}

window.login=async function(){
 const id=document.getElementById("studentId").value.trim(),pw=document.getElementById("studentPassword").value,msg=document.getElementById("loginMsg");
 try{
   const d=await CloudAPI.studentLogin(id,pw);
   // 学生与教师会话互斥，学生永远不能触发 teacher/state 写入
   teacherLoggedIn=false;teacherToken="";cloudReadyForTeacherSave=false;
   sessionStorage.removeItem("teacherToken");
   localStorage.removeItem("teacherTokenPersistent");
   studentToken=d.token;
   sessionStorage.setItem("studentToken",studentToken);
   localStorage.setItem("studentTokenPersistent",studentToken);
   localStorage.setItem("studentPersistentId",String(id));
   persistentStudentId=String(id);
   current=d.profile;loginOk=true;secondOk=phraseOk=liveOk=false;eyeCalibrationReady=sessionVerificationReady=false;
   msg.textContent=`登录成功：${current.name}（${current.class}），本设备已记住登录`;msg.className="status ok";
   await loadStudentCloudState();
 }catch(e){
   studentToken="";persistentStudentId="";
   sessionStorage.removeItem("studentToken");
   localStorage.removeItem("studentTokenPersistent");
   localStorage.removeItem("studentPersistentId");
   current=null;loginOk=false;const c=e?.data?.code;
   msg.textContent=c==="NOT_REGISTERED"?"该学生尚未注册，请先设置密码":c==="NEEDS_RESET"?"老师已批准重置，请重新设置密码":"学生ID或密码错误";msg.className="status bad";
   if(c==="NOT_REGISTERED"||c==="NEEDS_RESET"){
     document.getElementById("regStudentId").value=id;
     toggleRegistrationArea(true);
   }
 }
 updateGate();renderPoints();renderTaskAttemptStatus();updateStudentAccountUI();
}
window.studentLogout=function(){
 studentToken="";persistentStudentId="";current=null;loginOk=secondOk=phraseOk=liveOk=false;eyeCalibrationReady=sessionVerificationReady=false;
 sessionStorage.removeItem("studentToken");
 localStorage.removeItem("studentTokenPersistent");
 localStorage.removeItem("studentPersistentId");
 const msg=document.getElementById("loginMsg");if(msg){msg.textContent="已退出学生账号";msg.className="status"}
 updateGate();renderPoints();renderTaskAttemptStatus();renderWordTasks();updateStudentAccountUI();
}

window.registerStudentAccount=async function(){
 const b={id:document.getElementById("regStudentId").value.trim(),name:document.getElementById("regStudentName").value.trim(),registrationCode:document.getElementById("regCode").value.trim(),password:document.getElementById("regPassword").value,password2:document.getElementById("regPassword2").value,parentPin:document.getElementById("regParentPin").value.trim()};
 const msg=document.getElementById("registerMsg");
 if(b.password.length<6){msg.textContent="登录密码至少6位";msg.className="status bad";return}
 if(b.password!==b.password2){msg.textContent="两次密码不一致";msg.className="status bad";return}
 if(!/^\d{4,6}$/.test(b.parentPin)){msg.textContent="家长PIN需4-6位数字";msg.className="status bad";return}
 try{
   await CloudAPI.studentRegister(b);
   msg.textContent="设置成功，请用刚设置的密码登录；登录成功后本设备会自动记住。";msg.className="status ok";
   document.getElementById("studentId").value=b.id;
   document.getElementById("studentPassword").value="";
   setTimeout(()=>toggleRegistrationArea(false),900);
 }catch(e){msg.textContent="设置失败："+(e?.data?.error||friendlyCloudError(e));msg.className="status bad"}
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


function getEyeLimitMs(){const n=Number(appSettings?.eyeLimitMs);return Number.isFinite(n)&&n>=0?n:3000}
function eyeCheckEnabled(){return getEyeLimitMs()>0}
function eyeGateReady(){return !eyeCheckEnabled()||eyeCalibrationReady}
function baseVerificationOk(){return loginOk&&secondOk&&phraseOk&&liveOk&&eyeGateReady()&&(!eyeCheckEnabled()||sessionVerificationReady)}
function eyeLimitLabel(){
 const ms=getEyeLimitMs();
 if(ms===0)return "已关闭";
 return (ms/1000).toFixed(ms%1000?1:0)+" 秒";
}
function updateEyeLimitUI(){
 const preset=document.getElementById("eyeLimitPreset"),wrap=document.getElementById("eyeLimitCustomWrap"),custom=document.getElementById("eyeLimitCustom"),status=document.getElementById("eyeLimitStatus");
 if(!preset)return;
 const ms=getEyeLimitMs(), known=[0,1000,3000,5000];
 preset.value=known.includes(ms)?String(ms):"custom";
 wrap?.classList.toggle("hidden",preset.value!=="custom");
 if(custom&&preset.value==="custom")custom.value=(ms/1000).toFixed(ms%1000?1:0);
 if(status){status.textContent=ms===0?"当前：已关闭闭眼限制":"当前允许累计睁眼："+eyeLimitLabel();status.className="status ok"}
 const timer=document.getElementById("eyeOpenTime");
 if(timer)timer.textContent=ms===0?"闭眼限制已关闭":`累计睁眼：0.0 / ${(ms/1000).toFixed(1)} 秒`;
 const note=document.getElementById("eyeCalibrationStatus");
 if(ms===0&&note){note.className="status ok";note.textContent="教师已关闭闭眼限制，本次无需眼睛校准";}
 updateGate();
}
window.changeEyeLimitPreset=function(){
 const v=document.getElementById("eyeLimitPreset").value;
 document.getElementById("eyeLimitCustomWrap")?.classList.toggle("hidden",v!=="custom");
 if(v==="custom")return;
 appSettings.eyeLimitMs=Number(v);save();updateEyeLimitUI();
}
window.saveCustomEyeLimit=function(){
 const sec=Number(document.getElementById("eyeLimitCustom").value);
 if(!Number.isFinite(sec)||sec<0.5||sec>30){alert("自定义阈值请输入 0.5～30 秒");return}
 appSettings.eyeLimitMs=Math.round(sec*1000);save();updateEyeLimitUI();
}

function updateGate(){
 [["c1",loginOk],["c2",secondOk],["c3",phraseOk],["c4",liveOk]].forEach(([id,ok])=>{
   const el=document.getElementById(id);
   if(el){el.textContent=ok?"已通过":"未通过"; el.className=ok?"pass":"fail";}
 });
 const eye=document.getElementById("c5");
 if(eye){
   if(!eyeCheckEnabled()){eye.textContent="已关闭";eye.className="pass"}
   else {eye.textContent=eyeCalibrationReady?"已通过":"未通过";eye.className=eyeCalibrationReady?"pass":"fail"}
 }
 const ok=baseVerificationOk();
 const gate=document.getElementById("gate");
 gate.textContent=ok?"全部核验通过，可以开始背诵":(eyeCheckEnabled()?"核验未完成，请依次完成到“睁眼/闭眼校准”":"核验未完成，请完成账号、第二步核验、随机口令和活体检测");
 gate.className="status "+(ok?"ok":"bad");
 document.getElementById("speechBtn").disabled=!ok;
 document.getElementById("gradeBtn").disabled=true;
 renderTaskAttemptStatus();
}



function parseTaskTime(v){
 if(!v)return null;
 const d=new Date(v);
 return isNaN(d.getTime())?null:d;
}
function taskTimeState(task){
 const now=new Date(),start=parseTaskTime(task?.startAt),deadline=parseTaskTime(task?.deadline);
 return {start,deadline,beforeStart:!!start&&now<start,overdue:!!deadline&&now>deadline,allowLate:!!task?.allowLate};
}
function fmtTaskTime(v){
 const d=parseTaskTime(v);return d?d.toLocaleString():"未设置";
}
function taskSubmissionAllowed(task){
 const s=taskTimeState(task);
 if(s.beforeStart)return {ok:false,reason:"任务尚未到开始时间"};
 if(s.overdue&&!s.allowLate)return {ok:false,reason:"任务已超过截止时间"};
 return {ok:true,reason:""};
}
function renderTaskDeadlineStatus(){
 const box=document.getElementById("taskDeadlineStatus");if(!box)return;
 const task=getTask();
 if(!task){box.textContent="请选择任务查看时间要求。";box.className="status";return}
 const s=taskTimeState(task),parts=[];
 if(s.start)parts.push("开始："+s.start.toLocaleString());
 if(s.deadline)parts.push("截止："+s.deadline.toLocaleString());
 if(!s.start&&!s.deadline)parts.push("未设置时间限制");
 if(s.beforeStart){parts.push("⏳ 尚未开始");box.className="status warn"}
 else if(s.overdue&&!s.allowLate){parts.push("⛔ 已截止，不能再提交");box.className="status bad"}
 else if(s.overdue&&s.allowLate){parts.push("⚠️ 已截止，但教师允许补交");box.className="status warn"}
 else box.className="status ok";
 box.textContent=parts.join(" ｜ ");
}

function normalizeSections(task){
 if(!task||task.type!=="text")return [];
 if(Array.isArray(task.sections)&&task.sections.length){
   return task.sections.map((s,i)=>({title:String(s.title||("第"+(i+1)+"段")),text:String(s.text||"").trim()})).filter(s=>s.text);
 }
 const text=String(task.text||"").trim();
 return text?[{title:"全文",text}]:[];
}
function currentStudyText(task){
 if(!task)return "";
 if(task.type!=="text")return task.text||"";
 const sections=normalizeSections(task);
 if(selectedSectionIndex>=0 && sections[selectedSectionIndex]) return sections[selectedSectionIndex].text;
 return task.text||sections.map(s=>s.text).join(" ");
}
function renderSectionStudy(){
 const panel=document.getElementById("sectionStudyPanel"),box=document.getElementById("sectionList");
 if(!panel||!box)return;
 const task=getTask();
 if(!task||task.type!=="text"){panel.classList.add("hidden");box.innerHTML="";selectedSectionIndex=-1;return}
 const sections=normalizeSections(task);
 panel.classList.remove("hidden");
 box.innerHTML=sections.map((s,i)=>`<button class="sectionBtn ${selectedSectionIndex===i?"active":""}" onclick="selectSection(${i})">${escapeHtml(s.title)}：${escapeHtml(s.text.slice(0,42))}${s.text.length>42?"…":""}</button>`).join("");
}
window.selectSection=function(i){selectedSectionIndex=Number(i);renderSectionStudy();renderTaskAttemptStatus();document.getElementById("recognized").value="";document.getElementById("scoreResult").innerHTML="";document.getElementById("diffResult")?.classList.add("hidden")}
window.selectWholeText=function(){selectedSectionIndex=-1;renderSectionStudy();renderTaskAttemptStatus();document.getElementById("recognized").value="";document.getElementById("scoreResult").innerHTML="";document.getElementById("diffResult")?.classList.add("hidden")}

function tokenizeForDiff(s){return String(s||"").toLowerCase().match(/[a-z']+|[0-9]+/g)||[]}
function wordDiff(expected,spoken){
 const a=tokenizeForDiff(expected), b=tokenizeForDiff(spoken), n=a.length, m=b.length;
 const dp=Array.from({length:n+1},()=>Array(m+1).fill(0));
 for(let i=0;i<=n;i++)dp[i][0]=i;
 for(let j=0;j<=m;j++)dp[0][j]=j;
 for(let i=1;i<=n;i++)for(let j=1;j<=m;j++){
   const cost=a[i-1]===b[j-1]?0:1;
   dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+cost);
 }
 let i=n,j=m,ops=[];
 while(i>0||j>0){
   if(i>0&&j>0&&a[i-1]===b[j-1]&&dp[i][j]===dp[i-1][j-1]){ops.push({type:"ok",e:a[i-1],s:b[j-1]});i--;j--}
   else if(i>0&&j>0&&dp[i][j]===dp[i-1][j-1]+1){ops.push({type:"replace",e:a[i-1],s:b[j-1]});i--;j--}
   else if(i>0&&dp[i][j]===dp[i-1][j]+1){ops.push({type:"missing",e:a[i-1],s:""});i--}
   else {ops.push({type:"extra",e:"",s:b[j-1]});j--}
 }
 return ops.reverse();
}
function renderDiff(expected,spoken){
 const box=document.getElementById("diffResult"); if(!box)return;
 const ops=wordDiff(expected,spoken);
 const html=ops.map(o=>{
   if(o.type==="ok")return `<span class="diffToken diffOk">${escapeHtml(o.e)}</span>`;
   if(o.type==="missing")return `<span class="diffToken diffMissing" title="漏读">${escapeHtml(o.e)}</span>`;
   if(o.type==="extra")return `<span class="diffToken diffExtra" title="多读">+${escapeHtml(o.s)}</span>`;
   return `<span class="diffToken diffReplace" title="标准词 → 识别词">${escapeHtml(o.e)} → ${escapeHtml(o.s)}</span>`;
 }).join(" ");
 box.innerHTML=`<b>逐词反馈</b><div style="margin-top:8px">${html||"暂无可比较内容"}</div><div class="legend"><span>🟩 正确</span><span>🟥 漏词</span><span>🟨 多读</span><span>🟦 错词/替换</span></div>`;
 box.classList.remove("hidden");
}

function normalizeVocab(task){
 if(!task||task.type!=="word")return [];
 if(Array.isArray(task.vocab)&&task.vocab.length){
   return task.vocab.map(v=>({word:String(v.word||"").trim(),zh:String(v.zh||"").trim()})).filter(v=>v.word);
 }
 return String(task.text||"").split(/\s+/).map(w=>w.trim()).filter(Boolean).map(word=>({word,zh:""}));
}
function renderTasks(){
 const sel=document.getElementById("taskSelect");if(!sel)return;
 const textTasks=tasks.filter(t=>t.type==="text");
 const previous=sel.value;
 sel.innerHTML=textTasks.length?textTasks.map(t=>`<option value="${t.id}">${escapeHtml(t.title)}</option>`).join(""):'<option value="">暂无课文任务</option>';
 if(previous&&textTasks.some(t=>String(t.id)===String(previous)))sel.value=previous;
 sel.onchange=()=>{
   const recognized=document.getElementById("recognized"),score=document.getElementById("scoreResult");
   if(recognized)recognized.value="";if(score)score.innerHTML="";
   selectedSectionIndex=-1;renderTaskDeadlineStatus();renderTaskAttemptStatus();renderSectionStudy();
 };
 renderSectionStudy();renderTaskDeadlineStatus();renderTaskAttemptStatus();
}
function getTask(){
 const el=document.getElementById("taskSelect");if(!el||!el.value)return null;
 return tasks.find(t=>String(t.id)===String(el.value)&&t.type==="text")||null;
}
function getWordTask(){
 const el=document.getElementById("wordTaskSelect");if(!el||!el.value)return null;
 return tasks.find(t=>String(t.id)===String(el.value)&&t.type==="word")||null;
}
function renderWordTasks(){
 const sel=document.getElementById("wordTaskSelect");if(!sel)return;
 const wordTasks=tasks.filter(t=>t.type==="word");
 const previous=sel.value;
 sel.innerHTML=wordTasks.length?wordTasks.map(t=>`<option value="${t.id}">${escapeHtml(t.title)}</option>`).join(""):'<option value="">暂无单词任务</option>';
 if(previous&&wordTasks.some(t=>String(t.id)===String(previous)))sel.value=previous;
 sel.onchange=()=>{cancelWordTest(true);renderWordStudy();renderWordTestStatus();renderWordTaskDeadlineStatus()};
 renderWordStudy();renderWordTestStatus();renderWordTaskDeadlineStatus();
}
function renderWordStudy(){
 const box=document.getElementById("wordStudyList");if(!box)return;
 const task=getWordTask();
 if(!task){box.innerHTML='<div class="note">暂无单词任务。</div>';return}
 const vocab=normalizeVocab(task);
 box.innerHTML=vocab.length?vocab.map((v,i)=>`
   <div class="wordStudyRow">
     <div class="en">${escapeHtml(v.word)}</div>
     <div class="zh">${escapeHtml(v.zh||"（未填写中文）")}</div>
     <button class="secondary" onclick="speakWord('${String(v.word).replace(/\\/g,"\\\\").replace(/'/g,"\\'")}')">🔊 发音</button>
     <button onclick="openSpellingMode('${task.id}',${i})">学习拼写</button>
   </div>`).join(""):'<div class="note">这个单词任务还没有单词。</div>';
}
function renderWordTaskDeadlineStatus(){
 const box=document.getElementById("wordTaskDeadlineStatus");if(!box)return;
 const task=getWordTask();
 if(!task){box.textContent="暂无单词任务。";box.className="status";return}
 const s=taskTimeState(task),parts=[];
 if(s.start)parts.push("开始："+s.start.toLocaleString());
 if(s.deadline)parts.push("截止："+s.deadline.toLocaleString());
 if(!s.start&&!s.deadline)parts.push("未设置时间限制");
 if(s.beforeStart){parts.push("⏳ 尚未开始");box.className="status warn"}
 else if(s.overdue&&!s.allowLate){parts.push("⛔ 已截止，不能测试");box.className="status bad"}
 else if(s.overdue&&s.allowLate){parts.push("⚠️ 已截止，但允许补交测试");box.className="status warn"}
 else box.className="status ok";
 box.textContent=parts.join(" ｜ ");
}
function renderWordTestStatus(){
 const box=document.getElementById("wordTestStatus"),req=document.getElementById("wordTestRequestBox");if(!box)return;
 if(!current){box.className="status";box.textContent="登录后可参加正式单词测试。";if(req)req.innerHTML="";return}
 const task=getWordTask();if(!task){box.textContent="暂无单词任务";if(req)req.innerHTML="";return}
 const info=taskAttemptInfo(current.id,task);
 if(info.passed){
   box.className="status ok";box.textContent=`单词测试已合格 · 获得 1 分 · 共测试 ${info.used} 次`;
   if(req)req.innerHTML="";
 }else{
   box.className="status "+(info.remaining?"warn":"bad");
   box.textContent=`正式测试已使用 ${info.used}/${info.max} 次，剩余 ${info.remaining} 次${info.extra?`（老师额外批准 ${info.extra} 次）`:""}`;
   if(req)req.innerHTML=info.remaining===0?(info.pending?'<div class="status warn">增加次数申请已提交，等待老师审批。</div>':'<button class="warn" onclick="requestMoreWordAttempts()">申请老师增加测试次数</button>'):"";
 }
}
window.speakWord=function(word){
 try{
   speechSynthesis.cancel();
   const u=new SpeechSynthesisUtterance(String(word||""));
   u.lang="en-US";u.rate=0.82;
   speechSynthesis.speak(u);
 }catch(e){alert("当前浏览器无法播放语音")}
}

window.startRecitationSpeech=async function(){
 const baseOk=baseVerificationOk();
 if(!baseOk||!current){
   alert(eyeCheckEnabled()?"请先完成登录、第二步核验、随机口令、活体检测和睁眼/闭眼校准":"请先完成登录、第二步核验、随机口令和活体检测");
   return;
 }
 if(eyeCheckEnabled()&&!window.hasEyeCalibration?.()){
   alert("请先在上方视频区域完成睁眼/闭眼校准。");
   return;
 }

 const task=getTask();
 if(!task){alert("当前没有背诵任务");return}
 const timeGate=taskSubmissionAllowed(task);
 if(!timeGate.ok){alert(timeGate.reason);renderTaskDeadlineStatus();return}
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
 if(eyeTime) eyeTime.textContent=eyeCheckEnabled()?`累计睁眼：0.0 / ${(getEyeLimitMs()/1000).toFixed(1)} 秒`:"闭眼限制已关闭";

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
   if(eyeTime)eyeTime.textContent=eyeCheckEnabled()?`累计睁眼：0.0 / ${(getEyeLimitMs()/1000).toFixed(1)} 秒`:"闭眼限制已关闭";
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

 // 摄像头就绪后才从0开始本次闭眼计时；教师关闭闭眼限制时跳过。
 if(eyeCheckEnabled()){
   const monitor=await window.startClosedEyeSession?.(getEyeLimitMs());
   if(!monitor?.ok){
     try{recognition.stop()}catch(e){}
     const reason=monitor?.reason;
     speechStatus.className="status bad";
     speechStatus.textContent="闭眼检测启动失败，本次未开始";
     alert(reason==="calibration"?"眼睛校准已失效，请重新完成视频校准。":"闭眼检测启动失败，请重试。");
     return;
   }
 }

 // 正式开始：此刻起才允许语音结果写入，并从0累计睁眼时间。
 finalText="";
 document.getElementById("recognized").value="";
 recitationActive=true;
 recitationCompleting=false;
 lastEyeStats={openMs:0,violation:false};

 speechStatus.className="status ok";
 speechStatus.textContent=eyeCheckEnabled()?"🎤 麦克风已启动，正在语音识别，请保持闭眼背诵":"🎤 麦克风已启动，闭眼限制已关闭";
 if(eyeStatus){
   eyeStatus.className="status ok";
   eyeStatus.textContent=eyeCheckEnabled()?"正式背诵已开始，闭眼计时从 0 秒开始":"正式背诵已开始，本次不启用闭眼限制";
 }
 if(eyeTime)eyeTime.textContent=eyeCheckEnabled()?`累计睁眼：0.0 / ${(getEyeLimitMs()/1000).toFixed(1)} 秒`:"闭眼限制已关闭";

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
 const pts=passedTaskRecords(studentId).length;
 const s=students.find(x=>String(x.id)===String(studentId));
 if(s)s.points=pts;
 if(current&&String(current.id)===String(studentId))current.points=pts;
}

async function completeRecitationAttempt(forceEyeFail=false){
 if(recitationCompleting)return;
 if(!current||!recitationActive)return;
 recitationCompleting=true;

 const task=getTask();
 const timeGate=taskSubmissionAllowed(task);
 if(!timeGate.ok){recitationCompleting=false;alert(timeGate.reason);renderTaskDeadlineStatus();return}
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
 const limitMs=getEyeLimitMs();
 const eyeViolation=limitMs>0&&(forceEyeFail||eyeStats.violation||eyeStats.openMs>limitMs);

 // 提交后必须关闭摄像头。下一次开始会重新打开并重新计时。
 window.stopCamera(true);
 recitationActive=false;
 const speechStatus=document.getElementById("speechStatus");
 if(speechStatus){speechStatus.className="status";speechStatus.textContent="本次语音识别已结束";}

 const studyText=currentStudyText(task); const score=spoken?scoreText(studyText,spoken):0;
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
   result+=`<div class="status bad">本次未通过：累计睁眼 ${eyeSec} 秒，超过允许的 ${(limitMs/1000).toFixed(1)} 秒。本次已计入一次背诵机会。</div>`;
 }else{
   result+=`<div class="status ${pass?"ok":"bad"}">${pass?"合格，本任务获得 1 分":"未合格，需要达到 80%"}</div>`;
   result+=limitMs>0?`<div class="status ok">闭眼检测通过：累计睁眼 ${eyeSec} / ${(limitMs/1000).toFixed(1)} 秒</div>`:`<div class="status">本次教师已关闭闭眼限制</div>`;
 }
 if(!pass){
   result+=`<div class="status ${after.remaining>0?"warn":"bad"}">本任务已使用 ${after.used}/${after.max} 次；剩余 ${after.remaining} 次。</div>`;
   if(after.remaining===0) result+=`<button class="warn" onclick="requestMoreAttempts()">申请老师增加背诵次数</button>`;
 }
 if(spotCheck) result+='<div class="status warn">本次被随机抽中：正式版需上传短视频供老师人工抽查</div>';
 document.getElementById("scoreResult").innerHTML=result;
 renderDiff(studyText,spoken);

 recitationCompleting=false;
 updateRecitationButtons();
 renderTaskAttemptStatus();
}

window.grade=function(){
 if(!recitationActive){
   alert("请先点击“开始课文背诵”，系统需要在整个背诵过程中检测闭眼状态。");
   return;
 }
 if(eyeCheckEnabled()&&!eyeCalibrationReady){
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
 if(box){box.className="status bad";box.textContent=`累计睁眼超过 ${(getEyeLimitMs()/1000).toFixed(1)} 秒，本次自动判为未通过。`;}
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
 const baseOk=baseVerificationOk();
 const timeGate=taskSubmissionAllowed(task);renderTaskDeadlineStatus();
 document.getElementById("speechBtn").disabled=!baseOk||!timeGate.ok||info.passed||info.remaining===0||recitationActive;
 document.getElementById("gradeBtn").disabled=!baseOk||!timeGate.ok||info.passed||info.remaining===0||!recitationActive;
 const stopBtn=document.getElementById("stopSpeechBtn");
 if(stopBtn)stopBtn.disabled=!recitationActive;
}

function renderPoints(){
 const total=document.getElementById("points"),wordBox=document.getElementById("wordPoints"),textBox=document.getElementById("textPoints"),history=document.getElementById("studentPointHistory");
 if(!current){
   if(total)total.textContent="0";if(wordBox)wordBox.textContent="0";if(textBox)textBox.textContent="0";
   if(history)history.innerHTML='<div class="note">登录后可查看历史任务积分。</div>';return;
 }
 syncStudentPoints(current.id);
 const passed=passedTaskRecords(current.id);
 let wordPts=0,textPts=0;
 passed.forEach(r=>{
   const task=tasks.find(t=>String(t.id)===String(r.taskId));
   if(task?.type==="word")wordPts++;
   else if(task?.type==="text")textPts++;
 });
 if(total)total.textContent=current.points||0;
 if(wordBox)wordBox.textContent=wordPts;
 if(textBox)textBox.textContent=textPts;
 if(history){
   const rows=[],seen=new Set();
   tasks.filter(t=>!String(t.id).startsWith("mistakes-")).forEach(task=>{
     const info=taskAttemptInfo(current.id,task),key="id:"+String(task.id);seen.add(key);
     const result=info.passed?"已合格":(info.used?"未合格":"未开始");
     rows.push({type:task.type==="word"?"单词测试":"课文背诵",title:task.title,used:info.used,max:info.max,result,point:info.passed?1:0});
   });
   const grouped={};
   records.filter(r=>String(r.studentId)===String(current.id)).forEach(r=>{
     const key=passedTaskKey(r);if(seen.has(key))return;
     if(!grouped[key])grouped[key]={title:r.task||"已删除任务",used:0,passed:false};
     grouped[key].used++;if(r.pass)grouped[key].passed=true;
   });
   Object.values(grouped).forEach(g=>rows.push({type:"历史任务",title:g.title+"（已删除）",used:g.used,max:"—",result:g.passed?"已合格":"未合格",point:g.passed?1:0}));
   history.innerHTML=`<table><tr><th>类型</th><th>任务</th><th>正式次数</th><th>结果</th><th>积分</th></tr>`+
     rows.map(r=>`<tr><td>${r.type}</td><td>${escapeHtml(r.title)}</td><td>${r.used}/${r.max}</td><td>${r.result}</td><td>${r.point}</td></tr>`).join("")+`</table>`;
 }
 save();
}
window.saveSpotRate=function(){localStorage.setItem("spotRate",document.getElementById("spotRate").value)}
function teacherFilteredStudents(){
 const q=(document.getElementById("studentSearch")?.value||"").trim().toLowerCase();
 const cls=document.getElementById("studentClassFilter")?.value||"";
 const taskId=document.getElementById("studentTaskFilter")?.value||"";
 const completion=document.getElementById("studentCompletionFilter")?.value||"";
 const task=tasks.find(t=>String(t.id)===String(taskId));
 return students.filter(s=>{
   if(q&&!String(s.id+" "+s.name).toLowerCase().includes(q))return false;
   if(cls&&String(s.class)!==cls)return false;
   if(task&&completion){
     const passed=taskPassed(s.id,task);
     if(completion==="passed"&&!passed)return false;
     if(completion==="unfinished"&&passed)return false;
   }
   return true;
 });
}
function refreshTeacherFilters(){
 const classes=[...new Set(students.map(s=>String(s.class||"")).filter(Boolean))].sort();
 const cls=document.getElementById("studentClassFilter");
 if(cls){
   const prev=cls.value;
   cls.innerHTML='<option value="">全部班级</option>'+classes.map(x=>`<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join("");
   if(classes.includes(prev))cls.value=prev;
 }
 for(const id of ["studentTaskFilter","batchAttemptTask"]){
   const el=document.getElementById(id);if(!el)continue;
   const prev=el.value;
   el.innerHTML=(id==="studentTaskFilter"?'<option value="">不按任务筛选</option>':'<option value="">选择要增加次数的任务</option>')+
     tasks.map(t=>`<option value="${t.id}">${escapeHtml(t.title)}</option>`).join("");
   if(tasks.some(t=>String(t.id)===String(prev)))el.value=prev;
 }
}
function updateStudentSelectionStatus(){
 const el=document.getElementById("studentSelectionStatus");
 if(el)el.textContent=`已选择 ${selectedStudentIds.size} 名学生`;
}
window.toggleStudentSelection=function(id,checked){
 if(checked)selectedStudentIds.add(String(id));else selectedStudentIds.delete(String(id));
 updateStudentSelectionStatus();
}
window.selectVisibleStudents=function(){teacherFilteredStudents().forEach(s=>selectedStudentIds.add(String(s.id)));renderStudents()}
window.clearStudentSelection=function(){selectedStudentIds.clear();renderStudents()}
function renderStudents(){
 const box=document.getElementById("studentTable");
 if(!box)return;
 refreshTeacherFilters();
 const rows=teacherFilteredStudents();
 box.innerHTML=
 `<table><tr><th>选择</th><th>ID</th><th>姓名</th><th>班级</th><th>账号状态</th><th>积分</th></tr>`+
 rows.map(s=>{
   const state=s.needsPasswordReset?"待重新设置密码":(s.registered?"已注册":"未注册");
   const checked=selectedStudentIds.has(String(s.id))?"checked":"";
   return `<tr><td><input class="smallCheck" type="checkbox" ${checked} onchange="toggleStudentSelection('${String(s.id).replace(/'/g,"\\'")}',this.checked)"></td><td>${escapeHtml(s.id)}</td><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.class)}</td><td>${state}</td><td>${s.points||0}</td></tr>`;
 }).join("")+"</table>";
 if(!rows.length)box.innerHTML='<div class="note">当前筛选条件下没有学生。</div>';
 updateStudentSelectionStatus();
}
window.batchGrantAttempt=function(){
 if(!teacherLoggedIn){alert("请先登录教师端");return}
 const taskId=document.getElementById("batchAttemptTask")?.value||"";
 const task=tasks.find(t=>String(t.id)===String(taskId));
 if(!task){alert("请选择要增加次数的任务");return}
 const ids=[...selectedStudentIds];
 if(!ids.length){alert("请先勾选学生");return}
 if(!confirm(`确认给已选 ${ids.length} 名学生的“${task.title}”各增加 1 次背诵机会吗？`))return;
 const now=new Date().toISOString();
 ids.forEach(id=>{
   const s=students.find(x=>String(x.id)===String(id));if(!s)return;
   approvals.unshift({id:"ba"+Date.now()+"-"+Math.random().toString(36).slice(2,7),studentId:s.id,studentName:s.name,taskId:task.id,taskTitle:task.title,requestedAt:now,processedAt:now,status:"approved",extraAttempts:1,batchGranted:true});
 });
 save();renderApprovals();renderStudents();alert(`已为 ${ids.length} 名学生各增加 1 次机会`);
}
window.copyTask=function(id){
 if(!teacherLoggedIn){alert("请先登录教师端");return}
 const t=tasks.find(x=>String(x.id)===String(id));if(!t)return;
 const copy=JSON.parse(JSON.stringify(t));copy.id="t"+Date.now();copy.title=t.title+"（副本）";
 tasks.push(copy);save();renderTasks();renderTaskTable();renderStudents();
 alert("任务已复制，可点击“编辑”修改副本。");
}
function buildMistakeExportRows(){
 const agg={};
 Object.values(studentMistakes).forEach(x=>{
   const k=String(x.word||"").toLowerCase();if(!k)return;
   if(!agg[k])agg[k]={单词:x.word,中文:x.zh||"",累计错误:0,学生数:new Set()};
   agg[k]["累计错误"]+=Number(x.count)||0;agg[k]["学生数"].add(String(x.studentId));
 });
 return Object.values(agg).sort((a,b)=>b["累计错误"]-a["累计错误"]).map(x=>({单词:x["单词"],中文:x["中文"],累计错误:x["累计错误"],涉及学生数:x["学生数"].size}));
}
window.exportTeacherExcel=function(){
 if(!teacherLoggedIn){alert("请先登录教师端");return}
 if(typeof XLSX==="undefined"){alert("Excel 组件尚未加载，请刷新页面后重试");return}
 const wb=XLSX.utils.book_new();
 const summary=[
   ["导出时间",new Date().toLocaleString()],
   ["学生数",students.length],
   ["任务数",tasks.length],
   ["背诵记录数",records.length],
   ["待处理增加次数申请",approvals.filter(a=>a.status==="pending").length],
   ["累计睁眼阈值",getEyeLimitMs()===0?"关闭":eyeLimitLabel()]
 ];
 XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(summary),"概览");
 XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(students.map(s=>({
   学生ID:s.id,姓名:s.name,班级:s.class,账号状态:s.needsPasswordReset?"待重置":(s.registered?"已注册":"未注册"),积分:s.points||0
 }))),"学生");
 XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(tasks.map(t=>({
   任务ID:t.id,任务名称:t.title,类型:t.type==="word"?"单词":"课文",开始时间:t.startAt||"",截止时间:t.deadline||"",允许补交:t.allowLate?"是":"否",单词数:t.type==="word"?normalizeVocab(t).length:"",分段数:t.type==="text"?normalizeSections(t).length:"",内容:t.text||""
 }))),"任务");
 XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(records.map(r=>({
   时间:r.time,学生ID:r.studentId,姓名:r.name,任务:r.task,准确率:r.score,结果:r.pass?"合格":"未合格",睁眼秒数:r.eyeOpenMs===undefined?"":(Number(r.eyeOpenMs)/1000).toFixed(1),闭眼违规:r.eyeViolation?"是":"否",抽查:r.spotCheck?"是":"否"
 }))),"背诵记录");
 XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(approvals.map(a=>({
   申请时间:a.requestedAt,处理时间:a.processedAt||"",学生ID:a.studentId,姓名:a.studentName,任务:a.taskTitle,状态:a.status,增加次数:a.extraAttempts||0,批量发放:a.batchGranted?"是":"否"
 }))),"次数审批");
 XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(passwordResetRequests.map(r=>({
   申请时间:r.requestedAt,处理时间:r.processedAt||"",学生ID:r.studentId,姓名:r.studentName,班级:r.class,状态:r.status
 }))),"密码重置");
 const mistakes=buildMistakeExportRows();
 XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(mistakes.length?mistakes:[{提示:"当前浏览器暂无错词统计"}]),"错词统计");
 XLSX.writeFile(wb,`英语背诵学习记录_${new Date().toISOString().slice(0,10)}.xlsx`);
}

window.toggleTaskEditor=function(){
 const type=document.getElementById("newTaskType")?.value||"word";
 document.getElementById("wordTaskEditor")?.classList.toggle("hidden",type!=="word");
 document.getElementById("textTaskEditor")?.classList.toggle("hidden",type!=="text");
}
function renderWordEditorRows(){
 const box=document.getElementById("wordEditorRows"); if(!box)return;
 box.innerHTML=wordEditorItems.length?wordEditorItems.map((v,i)=>`
   <div class="wordEditorRow">
     <input value="${escapeHtml(v.word)}" oninput="wordEditorItems[${i}].word=this.value" placeholder="英文单词">
     <input value="${escapeHtml(v.zh)}" oninput="wordEditorItems[${i}].zh=this.value" placeholder="中文释义">
     <button class="badBtn" type="button" onclick="removeWordEditorRow(${i})">删除</button>
   </div>`).join(""):'<div class="note">还没有单词，请在上面逐个添加。</div>';
}
window.addWordEditorRow=function(){
 const en=document.getElementById("wordInputEn"),zh=document.getElementById("wordInputZh");
 const word=(en?.value||"").trim(),cn=(zh?.value||"").trim();
 if(!word){alert("请先输入英文单词");en?.focus();return}
 wordEditorItems.push({word,zh:cn});
 if(en)en.value="";if(zh)zh.value="";
 renderWordEditorRows();en?.focus();
}
window.removeWordEditorRow=function(i){wordEditorItems.splice(i,1);renderWordEditorRows()}


function renderSectionEditorRows(){
 const box=document.getElementById("sectionEditorRows");if(!box)return;
 box.innerHTML=sectionEditorItems.length?sectionEditorItems.map((s,i)=>`
 <div class="sectionEditorRow">
   <b>${i+1}</b>
   <textarea oninput="sectionEditorItems[${i}].text=this.value" placeholder="第 ${i+1} 段内容">${escapeHtml(s.text||"")}</textarea>
   <button type="button" class="badBtn" onclick="removeSectionEditorRow(${i})">删除</button>
 </div>`).join(""):'<div class="note">还没有分段。可点击上面的自动分段按钮。</div>';
}
window.removeSectionEditorRow=function(i){sectionEditorItems.splice(i,1);renderSectionEditorRows()}
window.splitTextByParagraph=function(){
 const t=document.getElementById("newTaskText").value.trim();
 sectionEditorItems=t.split(/\n+/).map(x=>x.trim()).filter(Boolean).map((text,i)=>({title:"第"+(i+1)+"段",text}));
 renderSectionEditorRows();
}
window.splitTextBySentence=function(){
 const t=document.getElementById("newTaskText").value.trim();
 const parts=t.match(/[^.!?。！？]+[.!?。！？]?/g)||[];
 sectionEditorItems=parts.map(x=>x.trim()).filter(Boolean).map((text,i)=>({title:"第"+(i+1)+"段",text}));
 renderSectionEditorRows();
}

window.addTask=function(){
 const title=document.getElementById("newTaskTitle").value.trim();
 const type=document.getElementById("newTaskType").value;
 const startAt=document.getElementById("newTaskStartAt")?.value||"";
 const deadline=document.getElementById("newTaskDeadline")?.value||"";
 const allowLate=!!document.getElementById("newTaskAllowLate")?.checked;
 if(startAt&&deadline&&new Date(startAt)>=new Date(deadline)){alert("截止时间必须晚于开始时间");return}
 let text="",vocab=[];
 if(type==="word"){
   vocab=wordEditorItems.map(v=>({word:String(v.word||"").trim(),zh:String(v.zh||"").trim()})).filter(v=>v.word);
   if(!vocab.length){alert("请至少逐个添加 1 个单词");return}
   text=vocab.map(v=>v.word).join(" ");
 }else{
   text=document.getElementById("newTaskText").value.trim();
   if(!text){alert("请填写课文文本");return}
 }
 if(!title){alert("请填写任务名");return}
 if(editingTaskId){
   const task=tasks.find(t=>String(t.id)===String(editingTaskId));
   if(!task){alert("任务不存在");cancelTaskEdit();return}
   const oldTitle=task.title;
   task.title=title; task.type=type; task.text=text; task.startAt=startAt; task.deadline=deadline; task.allowLate=allowLate;
   if(type==="word"){task.vocab=vocab;delete task.sections;} else {delete task.vocab;task.sections=(sectionEditorItems.length?sectionEditorItems.map((s,i)=>({title:"第"+(i+1)+"段",text:String(s.text||"").trim()})).filter(s=>s.text):normalizeSections({type:"text",text}));}
   records.forEach(r=>{
     if((r.taskId && String(r.taskId)===String(task.id)) || (!r.taskId && r.task===oldTitle)) r.task=title;
   });
   approvals.forEach(a=>{if(String(a.taskId)===String(task.id))a.taskTitle=title;});
   save();cancelTaskEdit();renderTasks();renderTaskTable();renderRecords();renderPoints();
   alert("任务已修改");
 }else{
   const task={id:"t"+Date.now(),title,type,text,startAt,deadline,allowLate};
   if(type==="word")task.vocab=vocab; else task.sections=(sectionEditorItems.length?sectionEditorItems.map((s,i)=>({title:"第"+(i+1)+"段",text:String(s.text||"").trim()})).filter(s=>s.text):normalizeSections(task));
   tasks.push(task);
   save();renderTasks();renderTaskTable();
   document.getElementById("newTaskTitle").value="";
   document.getElementById("newTaskText").value="";
   document.getElementById("newTaskStartAt").value=""; document.getElementById("newTaskDeadline").value=""; document.getElementById("newTaskAllowLate").checked=false;
   wordEditorItems=[];sectionEditorItems=[];renderWordEditorRows();renderSectionEditorRows();
 }
}

window.editTask=function(id){
 if(!teacherLoggedIn){alert("请先登录教师端");return}
 const task=tasks.find(t=>String(t.id)===String(id)); if(!task)return;
 editingTaskId=task.id;
 document.getElementById("newTaskTitle").value=task.title;
 document.getElementById("newTaskType").value=task.type;
 document.getElementById("newTaskText").value=task.type==="text"?task.text:"";
 document.getElementById("newTaskStartAt").value=task.startAt||"";
 document.getElementById("newTaskDeadline").value=task.deadline||"";
 document.getElementById("newTaskAllowLate").checked=!!task.allowLate;
 wordEditorItems=task.type==="word"?normalizeVocab(task).map(v=>({...v})):[];
 sectionEditorItems=task.type==="text"?normalizeSections(task).map(s=>({...s})):[];
 renderWordEditorRows();renderSectionEditorRows();toggleTaskEditor();
 document.getElementById("saveTaskBtn").textContent="保存修改";
 document.getElementById("cancelTaskEditBtn").classList.remove("hidden");
 document.getElementById("taskEditHint").textContent="正在编辑："+task.title;
 document.getElementById("newTaskTitle").scrollIntoView({behavior:"smooth",block:"center"});
}

window.cancelTaskEdit=function(){
 editingTaskId=null;wordEditorItems=[];sectionEditorItems=[];
 const title=document.getElementById("newTaskTitle"), text=document.getElementById("newTaskText");
 if(title)title.value=""; if(text)text.value="";
 const st=document.getElementById("newTaskStartAt"),dl=document.getElementById("newTaskDeadline"),al=document.getElementById("newTaskAllowLate"); if(st)st.value=""; if(dl)dl.value=""; if(al)al.checked=false;
 const en=document.getElementById("wordInputEn"),zh=document.getElementById("wordInputZh");
 if(en)en.value="";if(zh)zh.value="";
 renderWordEditorRows();renderSectionEditorRows();
 const btn=document.getElementById("saveTaskBtn"); if(btn)btn.textContent="新增任务";
 const cancel=document.getElementById("cancelTaskEditBtn"); if(cancel)cancel.classList.add("hidden");
 const hint=document.getElementById("taskEditHint"); if(hint)hint.textContent="";
 toggleTaskEditor();
}

window.deleteTask=function(id){
 if(!teacherLoggedIn){alert("请先登录教师端");return}
 const task=tasks.find(t=>String(t.id)===String(id)); if(!task)return;
 const used=records.filter(r=>(r.taskId&&String(r.taskId)===String(task.id))||(!r.taskId&&r.task===task.title)).length;
 const extra=used?`\n这个任务已有 ${used} 条历史背诵记录。删除任务不会删除这些历史记录和已获得积分。`:"";
 if(!confirm(`确认删除任务“${task.title}”吗？${extra}`))return;
 tasks=tasks.filter(t=>String(t.id)!==String(id));
 if(String(editingTaskId)===String(id))cancelTaskEdit();
 save();renderTasks();renderTaskTable();renderPoints();
}

function renderTaskTable(){
 const box=document.getElementById("taskTable");if(!box)return;
 if(!tasks.length){box.innerHTML='<div class="note">暂无任务</div>';return}
 const renderOne=t=>{
   const vocab=normalizeVocab(t),sections=normalizeSections(t);
   const content=t.type==="word"?vocab.map(v=>`${escapeHtml(v.word)}　${escapeHtml(v.zh||"")}`).join("<br>"):escapeHtml(t.text);
   const count=t.type==="word"?vocab.length:tokenize(t.text).length;
   return `<div class="task">
     <div class="row" style="align-items:center">
       <div style="flex:2"><b>${escapeHtml(t.title)}</b><div class="note">${t.type==="word"?"单词测试任务":"课文背诵任务"} · ${count} 个${t.type==="word"?"单词":"词"}${t.type==="text"&&sections.length>1?" · "+sections.length+"段":""}</div><div class="note">开始：${escapeHtml(fmtTaskTime(t.startAt))} ｜ 截止：${escapeHtml(fmtTaskTime(t.deadline))}${t.allowLate?" ｜ 可补交":""}</div></div>
       <button class="secondary" onclick="editTask('${t.id}')">编辑</button>
       <button class="secondary" onclick="copyTask('${t.id}')">复制</button>
       <button class="badBtn" onclick="deleteTask('${t.id}')">删除</button>
     </div>
     <details style="margin-top:8px"><summary style="cursor:pointer;font-weight:700">查看任务内容</summary><div class="taskContent">${content}</div></details>
   </div>`;
 };
 const words=tasks.filter(t=>t.type==="word"&&!String(t.id).startsWith("mistakes-"));
 const texts=tasks.filter(t=>t.type==="text");
 box.innerHTML=`<div class="taskGroupTitle">📚 单词任务</div>${words.length?words.map(renderOne).join(""):'<div class="note">暂无单词任务</div>'}
 <div class="taskGroupTitle">📖 课文任务</div>${texts.length?texts.map(renderOne).join(""):'<div class="note">暂无课文任务</div>'}`;
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


function shuffleCopy(arr){
 const a=arr.slice();
 for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}
 return a;
}
window.startWordTest=function(){
 if(!current||!studentToken){alert("请先登录学生账号");return}
 const task=getWordTask();if(!task){alert("暂无单词任务");return}
 const gate=taskSubmissionAllowed(task);if(!gate.ok){alert(gate.reason);renderWordTaskDeadlineStatus();return}
 const info=taskAttemptInfo(current.id,task);
 if(info.passed){alert("这个单词测试已经合格并获得积分，无需重复测试。");return}
 if(info.remaining<=0){alert("正式测试次数已经用完，请先申请老师增加次数。");return}
 const vocab=normalizeVocab(task);
 if(!vocab.length){alert("这个任务还没有单词");return}
 wordTestTaskId=task.id;
 wordTestOrder=shuffleCopy(vocab.map((v,i)=>({ ...v,sourceIndex:i })));
 wordTestIndex=0;wordTestAnswers=[];wordTestActive=true;
 document.getElementById("wordTestPanel")?.classList.remove("hidden");
 document.getElementById("wordTestResult").innerHTML="";
 renderWordTestQuestion();
}
function currentWordTestItem(){return wordTestOrder[wordTestIndex]||null}
function renderWordTestQuestion(){
 const v=currentWordTestItem();if(!v)return;
 document.getElementById("wordTestProgress").textContent=`第 ${wordTestIndex+1} / ${wordTestOrder.length} 题`;
 document.getElementById("wordTestChinese").textContent=v.zh||"请听发音后拼写";
 const input=document.getElementById("wordTestInput");input.value="";setTimeout(()=>input.focus(),50);
}
window.playWordTestAudio=function(){const v=currentWordTestItem();if(v)speakWord(v.word)}
window.nextWordTestQuestion=function(){
 if(!wordTestActive)return;
 const v=currentWordTestItem();if(!v)return;
 const ans=document.getElementById("wordTestInput").value.trim();
 if(!ans){alert("请先填写本题答案");return}
 wordTestAnswers.push({word:v.word,zh:v.zh||"",answer:ans,correct:ans.toLowerCase()===String(v.word).trim().toLowerCase()});
 if(wordTestIndex<wordTestOrder.length-1){wordTestIndex++;renderWordTestQuestion()}
 else finishWordTest();
}
async function finishWordTest(){
 if(!wordTestActive)return;
 const task=tasks.find(t=>String(t.id)===String(wordTestTaskId));if(!task)return;
 wordTestActive=false;
 const correct=wordTestAnswers.filter(x=>x.correct).length,total=wordTestAnswers.length;
 const score=total?Math.round(correct/total*100):0;
 wordTestAnswers.filter(x=>!x.correct).forEach(x=>addMistake(x.word,x.zh));
 const panel=document.getElementById("wordTestPanel");panel?.classList.add("hidden");
 const result=document.getElementById("wordTestResult");
 result.innerHTML='<div class="status warn">正在提交测试成绩…</div>';
 try{
   await CloudAPI.submitAttempt(studentToken,{taskId:task.id,score,eyeOpenMs:0,eyeViolation:false,spotCheck:false});
   await loadStudentCloudState();
 }catch(e){
   result.innerHTML=`<div class="status bad">成绩提交失败：${escapeHtml(friendlyCloudError(e))}</div>`;
   renderWordTestStatus();return;
 }
 const passed=score>=80;
 const rows=wordTestAnswers.map(x=>`<tr><td>${escapeHtml(x.zh)}</td><td>${escapeHtml(x.word)}</td><td>${escapeHtml(x.answer)}</td><td>${x.correct?"✅":"❌"}</td></tr>`).join("");
 result.innerHTML=`<div class="big">${score}%</div>
   <div class="status ${passed?"ok":"bad"}">${passed?"单词测试合格，本任务获得 1 分":"未达到 80%，本次计入一次正式测试机会"}</div>
   <div class="tablewrap"><table class="wordTestResultTable"><tr><th>中文</th><th>正确拼写</th><th>你的答案</th><th>结果</th></tr>${rows}</table></div>`;
 renderWordTestStatus();renderPoints();renderMistakeBook();
}
window.cancelWordTest=function(silent=false){
 if(wordTestActive&&!silent&&!confirm("确定退出本次测试吗？未提交的测试不会占次数。"))return;
 wordTestActive=false;wordTestTaskId=null;wordTestOrder=[];wordTestIndex=0;wordTestAnswers=[];
 document.getElementById("wordTestPanel")?.classList.add("hidden");
 if(!silent){const r=document.getElementById("wordTestResult");if(r)r.innerHTML='<div class="status">已退出，本次未计入测试次数。</div>'}
}
window.requestMoreWordAttempts=async function(){
 if(!current){alert("请先登录");return}
 const task=getWordTask();if(!task)return;
 try{await CloudAPI.requestExtra(studentToken,task.id);await loadStudentCloudState();alert("申请已提交，请等待老师审批")}
 catch(e){alert("申请失败："+(e?.data?.error||friendlyCloudError(e)))}
}

// ===== 免登录：老人听障语音转文字 =====
window.openHearingMode=function(){
 if(!teacherLoggedIn||!teacherToken){
   alert("请先登录教师端后再使用听障语音转文字。");
   return;
 }
 const ov=document.getElementById("hearingOverlay");
 ov?.classList.add("open");ov?.setAttribute("aria-hidden","false");
 document.body.style.overflow="hidden";
 document.getElementById("hearingText").style.fontSize=hearingFontSize+"px";
}
window.closeHearingMode=function(){
 stopHearingRecognition();
 const ov=document.getElementById("hearingOverlay");
 ov?.classList.remove("open");ov?.setAttribute("aria-hidden","true");
 document.body.style.overflow="";
 try{if(document.fullscreenElement)document.exitFullscreen()}catch(e){}
}
window.changeHearingFont=function(delta){
 hearingFontSize=Math.max(24,Math.min(88,hearingFontSize+Number(delta||0)));
 const el=document.getElementById("hearingText");if(el)el.style.fontSize=hearingFontSize+"px";
}
window.clearHearingText=function(){
 hearingFinalText="";
 const el=document.getElementById("hearingText");if(el)el.textContent="这里会实时显示说话内容。";
}
window.startHearingRecognition=function(){
 if(!teacherLoggedIn||!teacherToken){alert("教师登录已失效，请重新登录。");closeHearingMode();return}
 const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
 const status=document.getElementById("hearingStatus"),textBox=document.getElementById("hearingText");
 if(!SR){status.textContent="当前浏览器不支持实时语音识别，建议使用 Chrome / Edge。";status.className="status bad";return}
 stopHearingRecognition();
 hearingRecognition=new SR();
 hearingRecognition.lang=document.getElementById("hearingLang")?.value||"zh-CN";
 hearingRecognition.continuous=true;hearingRecognition.interimResults=true;
 hearingRecognition.onstart=()=>{hearingRunning=true;status.textContent="正在听… 请正常说话";status.className="status ok"};
 hearingRecognition.onresult=e=>{
   let interim="";
   for(let i=e.resultIndex;i<e.results.length;i++){
     const t=e.results[i][0].transcript;
     if(e.results[i].isFinal)hearingFinalText+=(hearingFinalText?" ":"")+t.trim();
     else interim+=t;
   }
   textBox.textContent=(hearingFinalText+(interim?((hearingFinalText?" ":"")+interim):""))||"正在听…";
 };
 hearingRecognition.onerror=e=>{status.textContent="语音识别错误："+(e.error||"unknown");status.className="status bad"};
 hearingRecognition.onend=()=>{
   const shouldRestart=hearingRunning;
   if(shouldRestart){try{hearingRecognition.start();return}catch(e){}}
   status.textContent="已停止";status.className="status";
 };
 try{hearingRecognition.start()}catch(e){status.textContent="启动失败："+e.message;status.className="status bad"}
 try{document.getElementById("hearingOverlay")?.requestFullscreen?.()}catch(e){}
}
window.stopHearingRecognition=function(){
 hearingRunning=false;
 try{hearingRecognition?.stop()}catch(e){}
 hearingRecognition=null;
 const status=document.getElementById("hearingStatus");if(status){status.textContent="已停止";status.className="status"}
}


function mistakeKey(studentId,word){return String(studentId||"")+"::"+String(word||"").toLowerCase()}
function addMistake(word,zh){
 if(!current||!word)return;
 const k=mistakeKey(current.id,word);
 const prev=studentMistakes[k]||{studentId:String(current.id),studentName:current.name||"",word:String(word),zh:String(zh||""),count:0,lastAt:""};
 prev.count=(Number(prev.count)||0)+1;prev.lastAt=new Date().toLocaleString();prev.studentName=current.name||prev.studentName;prev.zh=zh||prev.zh;
 studentMistakes[k]=prev;
 localStorage.setItem("v75mistakes",JSON.stringify(studentMistakes));
 renderMistakeBook();renderTeacherMistakeStats();
}
window.renderMistakeBook=function(){
 const box=document.getElementById("mistakeBookList");if(!box)return;
 if(!current){box.innerHTML='<div class="note">登录后查看自己的错词。</div>';return}
 const rows=Object.values(studentMistakes).filter(x=>String(x.studentId)===String(current.id)).sort((a,b)=>(b.count||0)-(a.count||0));
 box.innerHTML=rows.length?rows.map(x=>`<div class="mistakeRow"><b>${escapeHtml(x.word)}</b><span>${escapeHtml(x.zh||"")}</span><span class="mistakeCount">错 ${x.count} 次</span><button onclick="speakWord('${String(x.word).replace(/\\/g,"\\\\").replace(/'/g,"\\'")}')">🔊</button></div>`).join(""):'<div class="note">目前没有错词，继续保持！</div>';
}
window.practiceMistakes=function(){
 if(!current){alert("请先登录学生端");return}
 const rows=Object.values(studentMistakes).filter(x=>String(x.studentId)===String(current.id)).sort((a,b)=>(b.count||0)-(a.count||0));
 if(!rows.length){alert("目前没有错词");return}
 const id="mistakes-"+current.id;
 const fake={id,type:"word",title:"我的错词",vocab:rows.map(x=>({word:x.word,zh:x.zh})),text:rows.map(x=>x.word).join(" ")};
 const old=tasks.findIndex(t=>String(t.id)===id); if(old>=0)tasks[old]=fake; else tasks.push(fake);
 renderWordTasks();const sel=document.getElementById("wordTaskSelect");if(sel)sel.value=id;renderWordStudy();openSpellingMode(id,0);
}
function renderTeacherMistakeStats(){
 const box=document.getElementById("teacherMistakeStats");if(!box)return;
 const agg={};
 Object.values(studentMistakes).forEach(x=>{const k=String(x.word||"").toLowerCase();if(!k)return;(agg[k]||(agg[k]={word:x.word,zh:x.zh,count:0,students:new Set()}));agg[k].count+=Number(x.count)||0;agg[k].students.add(String(x.studentId))});
 const rows=Object.values(agg).sort((a,b)=>b.count-a.count).slice(0,50);
 box.innerHTML=rows.length?`<table><tr><th>单词</th><th>中文</th><th>累计错误</th><th>涉及学生</th></tr>${rows.map(x=>`<tr><td>${escapeHtml(x.word)}</td><td>${escapeHtml(x.zh||"")}</td><td>${x.count}</td><td>${x.students.size}</td></tr>`).join("")}</table>`:'<div class="note">暂无错词数据。</div>';
}

// ===== 单词拼写学习 =====
function spellingVocab(){
 const task=tasks.find(t=>String(t.id)===String(spellingTaskId));
 return normalizeVocab(task);
}
function renderSpellingWord(){
 const vocab=spellingVocab();
 if(!vocab.length)return;
 spellingIndex=((spellingIndex%vocab.length)+vocab.length)%vocab.length;
 const v=vocab[spellingIndex];
 document.getElementById("spellChinese").textContent=v.zh||"请听发音拼写";
 document.getElementById("spellInput").value="";
 const r=document.getElementById("spellResult");r.textContent=`第 ${spellingIndex+1} / ${vocab.length} 个`;r.className="status";
 setTimeout(()=>document.getElementById("spellInput")?.focus(),50);
}
window.openSpellingMode=function(taskId,index=0){
 spellingTaskId=taskId;spellingIndex=Number(index)||0;
 const ov=document.getElementById("spellingOverlay");
 ov?.classList.add("open");ov?.setAttribute("aria-hidden","false");
 document.body.style.overflow="hidden";renderSpellingWord();
}
window.closeSpellingMode=function(){
 document.getElementById("spellingOverlay")?.classList.remove("open");
 document.getElementById("spellingOverlay")?.setAttribute("aria-hidden","true");
 document.body.style.overflow="";
}
window.playCurrentSpellWord=function(){
 const v=spellingVocab()[spellingIndex];if(v)speakWord(v.word);
}
window.checkSpelling=function(){
 const v=spellingVocab()[spellingIndex];if(!v)return;
 const input=document.getElementById("spellInput").value.trim().toLowerCase();
 const ok=input===v.word.trim().toLowerCase();
 const r=document.getElementById("spellResult");
 r.textContent=ok?"✅ 拼写正确！":"❌ 再试一次";
 r.className="status "+(ok?"ok":"bad");
 if(ok)speakWord(v.word); else addMistake(v.word,v.zh);
}
window.revealSpelling=function(){
 const v=spellingVocab()[spellingIndex];if(!v)return;
 document.getElementById("spellInput").value=v.word;
 const r=document.getElementById("spellResult");r.textContent="答案："+v.word;r.className="status warn";
 speakWord(v.word);
}
window.nextSpellingWord=function(){
 const vocab=spellingVocab();if(!vocab.length)return;
 spellingIndex=(spellingIndex+1)%vocab.length;renderSpellingWord();
}

function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
function renderAll(){renderTasks();renderWordTasks();renderStudents();renderTaskTable();renderRecords();renderApprovals();renderPasswordResetRequests();renderPoints();updateEyeLimitUI();updateGate();renderTaskAttemptStatus();renderWordEditorRows();renderSectionEditorRows();toggleTaskEditor();renderMistakeBook();renderTeacherMistakeStats();renderSectionStudy();renderTaskDeadlineStatus();renderWordTaskDeadlineStatus();refreshTeacherFilters();updateStudentAccountUI();}
renderAll();
updateTeacherVisibility();
updateStudentAccountUI();

window.addEventListener("load",()=>initCloud());
