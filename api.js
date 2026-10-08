(function(){
 const base=()=>String(window.CLOUD_API_BASE||"").replace(/\/+$/,"");
 const configured=()=>base()&&!base().includes("PASTE_YOUR");
 async function req(path,{method="GET",body,token}={}){
   if(!configured())throw new Error("CLOUD_NOT_CONFIGURED");
   const headers={"Content-Type":"application/json"};
   if(token)headers.Authorization="Bearer "+token;
   const r=await fetch(base()+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
   let d={}; try{d=await r.json()}catch(e){}
   if(!r.ok){const e=new Error(d.error||("HTTP_"+r.status));e.status=r.status;e.data=d;throw e}
   return d;
 }
 window.CloudAPI={
   configured,request:req,
   teacherLogin:(u,p)=>req("/teacher/login",{method:"POST",body:{username:u,password:p}}),
   teacherState:t=>req("/teacher/state",{token:t}),
   teacherSaveState:(t,s)=>req("/teacher/state",{method:"POST",token:t,body:s}),
   teacherReplaceRoster:(t,s)=>req("/teacher/state",{method:"POST",token:t,body:{...s,rosterReplace:true}}),
   studentLogin:(id,password)=>req("/student/login",{method:"POST",body:{id,password}}),
   studentRegister:b=>req("/student/register",{method:"POST",body:b}),
   studentState:t=>req("/student/state",{token:t}),
   verifyParentPin:(t,pin)=>req("/student/verify-pin",{method:"POST",token:t,body:{pin}}),
   submitAttempt:(t,b)=>req("/student/attempt",{method:"POST",token:t,body:b}),
   requestExtra:(t,taskId)=>req("/student/request-extra",{method:"POST",token:t,body:{taskId}}),
   requestPasswordReset:(id,name)=>req("/student/request-password-reset",{method:"POST",body:{id,name}})
 };
})();