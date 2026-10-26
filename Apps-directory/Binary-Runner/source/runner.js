(function () {
"use strict";
var BASE = new URL("./", document.baseURI).href;
var XPI_NAME = "jscalated-binary-runner@local.xpi";
var REQ = "binary-runner-request.json";
var MAX = 16 * 1024 * 1024;
var state = { root:null, storage:null, catalog:[], selected:-1, local:null, busy:false };
var openChoice = document.getElementById("open-choice"), choice = document.getElementById("choice"), detail = document.getElementById("detail"),
    status = document.getElementById("status"), log = document.getElementById("log"),
    local = document.getElementById("local"), localFile = document.getElementById("local-file"),
    stage = document.getElementById("stage"), restore = document.getElementById("restore"),
    inspect = document.getElementById("inspect"), debug = document.getElementById("debug"),
    logs = document.getElementById("refresh-logs");
function report(message) {
  var time = new Date().toLocaleTimeString();
  status.textContent = message;
  var existing = log.textContent === "Ready." ? "" : log.textContent;
  log.textContent = (existing + time + " " + message + "\n").split("\n").slice(-25).join("\n");
}
function errorMessage(e) { return e && e.message ? e.message : String(e); }
function fail(e) { report("Error: " + errorMessage(e)); }
function timeout(p, what, ms) { return new Promise(function(resolve, reject) {
  var t=setTimeout(function(){reject(new Error(what+" timed out"));},ms||15000);
  Promise.resolve(p).then(function(v){clearTimeout(t);resolve(v);},function(e){clearTimeout(t);reject(e);});
}); }
function isDir(v) { return !!v && typeof v.getFilesAndDirectories === "function"; }
async function entry(dir,name) {
  var items=await timeout(dir.getFilesAndDirectories(), "Directory listing");
  for(var i=0;i<items.length;i++)if(items[i].name===name)return items[i];
  return null;
}
async function at(dir,path) {
  var parts=path.split("/").filter(Boolean),cur=dir;
  for(var i=0;i<parts.length;i++){if(!isDir(cur))throw new Error("Not a directory: "+parts[i]);cur=await entry(cur,parts[i]);if(!cur)throw new Error("Missing: "+path);}
  return cur;
}
function bytes(file) {return new Promise(function(resolve,reject){
 if(!file||isDir(file)||file.size>MAX){reject(new Error("Invalid or oversized file"));return;}
 var r=new FileReader();r.onload=function(){resolve(new Uint8Array(r.result));};
 r.onerror=function(){reject(r.error||new Error("Read failed"));};r.readAsArrayBuffer(file);
});}
function decode(b){return new TextDecoder("utf-8").decode(b);}
function encode(s){return new TextEncoder().encode(s);}
function equal(a,b){if(a.length!==b.length)return false;for(var i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;}
function get(url){return new Promise(function(resolve,reject){var r=new XMLHttpRequest();r.open("GET",new URL(url,BASE).href,true);r.responseType="arraybuffer";r.timeout=25000;
 r.onload=function(){if(r.status!==200||!r.response)reject(new Error("Asset HTTP "+r.status+": "+url));else resolve(new Uint8Array(r.response));};
 r.onerror=function(){reject(new Error("Could not read "+url));};r.ontimeout=function(){reject(new Error("Asset request timed out"));};r.send();});}
async function hash(b){if(!crypto.subtle||!crypto.subtle.digest)throw new Error("SHA-256 unavailable");var d=new Uint8Array(await crypto.subtle.digest("SHA-256",b));return Array.from(d).map(function(x){return (x+256).toString(16).slice(1);}).join("");}
function id(){var b=new Uint8Array(8);crypto.getRandomValues(b);return Array.from(b).map(function(x){return(x+256).toString(16).slice(1);}).join("");}
async function root(){if(!state.root){var b=navigator.b2g&&navigator.b2g.getDeviceStorage?navigator.b2g.getDeviceStorage("apps"):navigator.getDeviceStorage&&navigator.getDeviceStorage("apps");if(!b||!b.getRoot)throw new Error("Apps storage API unavailable");state.storage=b;state.root=await timeout(b.getRoot(),"Opening apps storage");}return state.root;}
async function profile(){var r=await root(),m=await at(r,"b2g/mozilla"),ini=decode(await bytes(await at(m,"profiles.ini")));
 var sections=ini.split(/^\[/m).filter(function(s){return /^Profile\d+\]/.test(s);});
 var ps=sections.map(function(s){var p=/^Path=([^\r\n]+)/m.exec(s);return {path:p&&p[1].trim(),rel:/^IsRelative=1\s*$/m.test(s),def:/^Default=1\s*$/m.test(s)};}).filter(function(p){return p.path;});
 var selected=ps.filter(function(p){return p.def;});if(selected.length!==1)selected=ps.length===1?ps:[];
 if(selected.length!==1||!selected[0].rel||selected[0].path.split("/").some(function(s){return !/^[\w.-]+$/.test(s)||s==="."||s==="..";}))throw new Error("Cannot safely find default profile");
 return at(m,selected[0].path);
}
async function save(dir,name,data,type){var f=await entry(dir,name);if(f){if(isDir(f)||!equal(await bytes(f),data))throw new Error("Existing "+name+" differs; not overwritten");}
 else await timeout(dir.createFile(name,{ifExists:"fail",data:new Blob([data],{type:type||"application/octet-stream"})}),"Writing "+name);
 if(!equal(await bytes(await entry(dir,name)),data))throw new Error("Readback failed: "+name);
}
async function replaceText(dir,name,newValue,backupName){var prior=await entry(dir,name),old=prior?await bytes(prior):null;
 if(prior){if(isDir(prior))throw new Error("Unsafe file: "+name);if(equal(old,newValue))return;
 await save(dir,backupName,old,"application/octet-stream");await timeout(dir.remove(name),"Removing old "+name);}
 try{await save(dir,name,newValue,"application/json");}
 catch(e){if(old&&!(await entry(dir,name))){try{await save(dir,name,old,"application/octet-stream");}catch(ignored){report("Backup retained: "+backupName);}}throw e;}
}
async function preflight(){var r=await root(),dir=await at(r,"local/service/updater"),init=await entry(dir,"init"),daemon=await entry(dir,"updater-daemon");
 if((init&&isDir(init))||(daemon&&isDir(daemon)))throw new Error("Unsafe updater path; nothing changed");
 return {dir:dir,daemon:daemon};}
async function installXpi(p){var meta=JSON.parse(decode(await get("payloads/binary-installer-meta.json"))),content=await get("payloads/binary-installer.xpi");
 if(meta.size!==content.length||meta.sha256!==await hash(content))throw new Error("XPI hash mismatch");
 var extensions=await entry(p,"extensions");if(!extensions)extensions=await p.createDirectory("extensions");if(!isDir(extensions))throw new Error("Profile extensions path is not a directory");
 await replaceText(extensions,XPI_NAME,content,XPI_NAME+".backup-"+id());
 var f=await entry(p,"user.js"),old=f?decode(await bytes(f)):"";
 var pref='user_pref("extensions.startupScanScopes", 1);';
 if(!/^user_pref\("extensions\.startupScanScopes",\s*1\);?\s*$/m.test(old)){
 if(/^user_pref\("extensions\.startupScanScopes",/m.test(old))throw new Error("Conflicting extension scan preference; leaving user.js unchanged");
 var updated=old+(old&&!/\n$/.test(old)?"\n":"")+pref+"\n";
 await replaceText(p,"user.js",encode(updated),"user.js.binary-runner-backup-"+id());
 }
 report("Installer XPI verified; existing ADB XPI untouched.");
}
async function pending(p){var f=await entry(p,REQ);if(!f)return;var req=JSON.parse(decode(await bytes(f)));if(!/^[a-f0-9]{16}$/.test(req.id))throw new Error("Old request invalid");
 var sf=await entry(p,"binary-runner-status-"+req.id+".json");if(!sf)throw new Error("Previous request pending; inspect before restaging");
 var v=JSON.parse(decode(await bytes(sf)));if(v.state!=="success"&&v.state!=="failed")throw new Error("Old request still active");
}
function armElf(b){return b.length>=20&&b[0]===127&&b[1]===69&&b[2]===76&&b[3]===70&&b[4]===1&&b[5]===1&&b[18]===40&&b[19]===0;}
async function loadLocal(file){
 var b=await bytes(file);if(!armElf(b))throw new Error("Local file is not a 32-bit ARM ELF binary");
 state.local={file:file,name:file.name||"Local binary",size:b.length,sha256:await hash(b)};
 state.selected=-1;choice.value="";choice.hidden=true;openChoice.hidden=false;showChoice();
 report("Loaded local binary: "+state.local.name+" ("+b.length+" bytes). Review it, then Stage binary.");
}
async function startStage(){var selected=state.local||state.catalog[state.selected];if(!selected)throw new Error("Choose a bundled or local binary");
 report("Checking payload...");var b=state.local?await bytes(selected.file):await get(selected.path);
 if(b.length!==selected.size||await hash(b)!==selected.sha256)throw new Error("Selected binary changed or failed verification");
 if(!armElf(b))throw new Error("Not a 32-bit ARM ELF binary");
 await preflight();var p=await timeout(profile(),"Profile inspection",25000);await pending(p);
 if(!confirm("Stage "+selected.name+"? On your next manual reboot, the helper will restore the stock updater, copy this binary into its executable file, and stop the service. A second manual reboot starts the binary."))return;
 var taskId=id();await save(p,"binary-runner-payload-"+taskId+".bin",b);
 report("Payload verified; placing separate XPI...");await installXpi(p);
 var request={id:taskId,action:"stage",name:state.local?"Local_binary":selected.name,size:b.length,sha256:selected.sha256};
 if(state.local)request.kind="local";
 var task=encode(JSON.stringify(request)+"\n");
 await replaceText(p,REQ,task,REQ+".backup-"+taskId);
 report("Request "+taskId+" saved. Reboot to restore stock and stage the binary; check status, then reboot again to start it.");
}
async function restoreStock(){
 await preflight();
 if(!confirm("Restore the stock updater? On the next manual reboot, the helper will stop the service, remove the installed updater and init marker, start the stock wrapper, and verify the result."))return;
 var p=await timeout(profile(),"Profile inspection",25000);
 await installXpi(p);
 var taskId=id(),task=encode(JSON.stringify({id:taskId,action:"restore"})+"\n");
 await replaceText(p,REQ,task,REQ+".backup-"+taskId);
 report("Stock restore request "+taskId+" saved. Reboot once, then Check status.");
}
async function installDebug(){var p=await timeout(profile(),"Profile inspection",25000);
 await installXpi(p);report("Debug XPI installed. Manually reboot once; port 5556 accepts commands without a token.");}
async function readEvents(keepStatus){var p=await timeout(profile(),"Profile inspection",25000),f=await entry(p,"binary-runner-events.log");
 if(f){var s=decode(await bytes(f));var lines=s.trim().split(/\r?\n/).slice(-16);log.textContent=lines.join("\n")||"No events";if(!keepStatus)status.textContent="Loaded "+lines.length+" XPI log entries.";}
 else report("No XPI logs yet. Stage then manually restart.");
}
async function statusCheck(){report("Checking updater...");var t=await timeout(preflight(),"Updater inspection",25000);
 var h=null;
 if(t.daemon){var present=await bytes(t.daemon);h=await hash(present);report("Updater file: "+present.length+" bytes; SHA-256 "+h.slice(0,20)+"…");}
 else report("Updater file is missing. Restore stock before restarting the phone.");
 var p=await timeout(profile(),"Profile inspection",25000),f=await entry(p,REQ);
 if(f){var req=JSON.parse(decode(await bytes(f))),sf=await entry(p,"binary-runner-status-"+req.id+".json");
 if(sf){var v=JSON.parse(decode(await bytes(sf)));report("XPI: "+v.state+" — "+v.detail);if(v.state==="success"&&req.action==="stage")report(h===req.sha256?"Installed bytes MATCH selected binary. XPI verified inode, mode 0755, and label.":"WARNING: updater bytes do not match requested binary.");}
 else report("XPI has not reported yet. A manual reboot is needed.");}
 else report("No stage request found. Executable mode cannot be read through DeviceStorage.");
 await readEvents(true);
}
async function job(label,func){if(state.busy)return;state.busy=true;openChoice.disabled=choice.disabled=local.disabled=stage.disabled=restore.disabled=inspect.disabled=debug.disabled=logs.disabled=true;report(label);
 try{await func();}catch(e){fail(e);}finally{state.busy=false;openChoice.disabled=choice.disabled=!state.catalog.length;stage.disabled=!(state.local||state.selected>=0);local.disabled=restore.disabled=inspect.disabled=debug.disabled=logs.disabled=false;}}
function showChoice(){var p=state.local||state.catalog[state.selected];var labels={Cingular_Flex_2:"Cingular Flex 2",ghostlock_nokia2760:"GhostLock Nokia 2760",TCL_Flip_3:"TCL Flip 3"};
 detail.textContent=p?(state.local?"Local: "+p.name:"Bundled: "+(labels[p.name]||p.name))+" · "+p.size+" bytes · SHA-256 "+p.sha256.slice(0,16)+"…":"No binary selected";
 stage.disabled=state.busy||!p;
}
function closeChoice(){choice.hidden=true;openChoice.hidden=false;openChoice.focus();}
openChoice.onclick=function(){if(!state.busy&&state.catalog.length){openChoice.hidden=true;choice.hidden=false;choice.focus();
 try{if(typeof choice.showPicker==="function")choice.showPicker();else choice.click();}catch(e){report("Press OK to open the binary list.");}
}};
choice.onchange=function(){if(!choice.value)return;state.local=null;state.selected=state.catalog.findIndex(function(x){return x.name===choice.value;});closeChoice();showChoice();};
choice.onblur=function(){if(!choice.hidden){choice.hidden=true;openChoice.hidden=false;}};
local.onclick=function(){if(!state.busy){localFile.value="";localFile.click();}};
localFile.onchange=function(){var file=localFile.files&&localFile.files[0];if(file)job("Loading local binary...",function(){return loadLocal(file);});};
stage.onclick=function(){job("Staging...",startStage);};restore.onclick=function(){job("Scheduling stock restore...",restoreStock);};inspect.onclick=function(){job("Checking status...",statusCheck);};debug.onclick=function(){job("Installing debug XPI...",installDebug);};logs.onclick=function(){job("Reading logs...",function(){return readEvents(false);});};
var focusables=[openChoice,local,stage,restore,inspect,debug,logs];
function move(delta){var v=focusables.filter(function(e){return !e.disabled;}),n=v.indexOf(document.activeElement),next=n<0?(delta>0?0:v.length-1):(n+delta+v.length)%v.length;v[next].focus();}
document.addEventListener("keydown",function(e){
 var k=e.key,a=document.activeElement;
 if(a===choice){if(k==="Backspace"||k==="Escape"){e.preventDefault();closeChoice();}return;}
 if(k==="SoftLeft"||k==="F1"){e.preventDefault();openChoice.focus();return;}
 if(k==="SoftRight"||k==="F2"){e.preventDefault();if(!state.busy)logs.click();return;}
 if(k==="ArrowUp"||k==="ArrowDown"){e.preventDefault();move(k==="ArrowDown"?1:-1);return;}
 if(k==="ArrowLeft"&&a!==openChoice){e.preventDefault();openChoice.focus();return;}
 if(k==="Enter"&&a&&a.tagName==="BUTTON"){e.preventDefault();if(!e.repeat&&!a.disabled)a.click();}
});
get("payloads/catalog.json").then(function(b){var entries=JSON.parse(decode(b));if(!Array.isArray(entries)||entries.length!==3||entries.some(function(x){return x.kind!=="binary"||x.path!=="payloads/binaries/"+x.name||!/^(Cingular_Flex_2|ghostlock_nokia2760|TCL_Flip_3)$/.test(x.name)||!Number.isInteger(x.size)||x.size<=0||x.size>MAX||!/^[0-9a-f]{64}$/.test(x.sha256);}))throw new Error("Invalid catalog");
 state.catalog=entries;choice.textContent="";var placeholder=document.createElement("option");placeholder.value="";placeholder.textContent="Select binary";choice.appendChild(placeholder);
 var labels={Cingular_Flex_2:"Cingular Flex 2",ghostlock_nokia2760:"GhostLock Nokia 2760",TCL_Flip_3:"TCL Flip 3"};
 entries.forEach(function(item){var option=document.createElement("option");option.value=item.name;option.textContent=labels[item.name]||item.name;choice.appendChild(option);});
 choice.value="";choice.disabled=openChoice.disabled=false;showChoice();report("Ready. Select a bundled binary or load a local file.");openChoice.focus();}).catch(fail);
})();
