"use strict";
const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const ALLOWED = __ALLOWLIST__;
const UPDATER = "/data/local/service/updater/updater-daemon";
const UPDATER_DIR = "/data/local/service/updater";
const STOCK_UPDATER = "/system/kaios/updater-daemon";
const BACKUPS = UPDATER_DIR + "/jscalated-runner";
const REQUEST = "binary-runner-request.json";
const MAX = 16 * 1024 * 1024;
function fileAt(path){const f=Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);f.initWithPath(path);return f;}
function regular(f,max=MAX){return f.exists()&&!f.isSymlink()&&f.isFile()&&f.fileSize>0&&f.fileSize<=max;}
function createDir(path){const d=fileAt(path);if(!d.exists())d.create(Ci.nsIFile.DIRECTORY_TYPE,0o700);if(d.isSymlink()||!d.isDirectory())throw Error("Unsafe directory: "+path);return d;}
function readText(f,max=4096){if(!regular(f,max))throw Error("Missing request file");const stream=Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);stream.init(f,0x01,0,0);
 const ci=Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);ci.init(stream,"UTF-8",0,0);let out={};try{ci.readString(-1,out);}finally{ci.close();}return out.value;}
function sha256(f){if(!regular(f))throw Error("Missing or unsafe binary: "+f.path);
 const input=Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);input.init(f,0x01,0,0);
 const hash=Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);hash.init(hash.SHA256);
 try{hash.updateFromStream(input,f.fileSize);}finally{input.close();}const digest=hash.finish(false);let hex="";for(let i=0;i<digest.length;i++)hex+=(digest.charCodeAt(i)+256).toString(16).slice(1);return hex;}
function armElf(f){if(!regular(f)||f.fileSize<20)return false;
 const input=Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);input.init(f,0x01,0,0);
 const binary=Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);binary.setInputStream(input);
 let b;try{b=binary.readByteArray(20);}finally{input.close();}
 return b[0]===127&&b[1]===69&&b[2]===76&&b[3]===70&&b[4]===1&&b[5]===1&&b[18]===40&&b[19]===0;}
function writeText(f,value,append){if(f.exists()&&(f.isSymlink()||!f.isFile()))throw Error("Unsafe output path");
 const stream=Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
 stream.init(f,0x02|0x08|(append?0x10:0x20),0o600,0);
 try{if(stream.write(value,value.length)!==value.length)throw Error("Short write");}finally{stream.close();}}
function event(profile,msg){try{const f=fileAt(profile.path+"/binary-runner-events.log");const value=new Date().toISOString()+" "+String(msg).replace(/[^\x20-\x7e]/g,"?").slice(0,440)+"\n";
 writeText(f,value,!(f.exists()&&f.fileSize>32768));}catch(e){console.error("Binary Runner events: "+e);}}
function result(profile,id,state,message){writeText(fileAt(profile.path+"/binary-runner-status-"+id+".json"),JSON.stringify({id,state,detail:String(message).replace(/[^\x20-\x7e]/g,"?")})+"\n",false);event(profile,"request "+id+" "+state+": "+message);}
function socketState(profile, state, detail) {
  writeText(fileAt(profile.path + "/binary-runner-socket.json"),
    JSON.stringify({ state, port: 5556, detail: String(detail).slice(0, 512) }) + "\n");
  event(profile, "socket " + state + ": " + detail);
}

// No command runs at XPI startup. The listener is limited to loopback.
function startDebugSocket(profile) {
  const server = Cc["@mozilla.org/network/server-socket;1"]
    .createInstance(Ci.nsIServerSocket);
  server.init(5556, true, 2);
  let closed = false;
  let busy = false;
  let serial = 0;
  const clients = new Set();
  const listener = {
    onSocketAccepted(_server, transport) {
      if (closed || clients.size >= 2) { transport.close(0); return; }
      const input = transport.openInputStream(0, 0, 0);
      const output = transport.openOutputStream(Ci.nsITransport.OPEN_BLOCKING, 0, 0);
      const client = { transport, output, buffer: "", pump: null };
      clients.add(client);
      function send(value) {
        try {
          if (output.write(value, value.length) !== value.length)
            throw new Error("Short socket write");
        } catch (error) {
          event(profile, "socket write failed: " + error);
          transport.close(0);
        }
      }
      function command(line) {
        if (line === "QUIT") { transport.close(0); return; }
        if (line === "STATUS") {
          send("B2G command socket listening on 127.0.0.1:5556; " +
            (busy ? "command running" : "idle") + ".\n");
          return;
        }
        if (line === "INSPECT") {
          const paths = [UPDATER, BACKUPS + "/first-use-backup/updater-daemon",
            UPDATER_DIR + "/init"];
          for (const path of paths) {
            try {
              const file = fileAt(path);
              if (!file.exists()) { send(path + ": missing\n"); continue; }
              if (file.isSymlink() || !file.isFile()) {
                send(path + ": not a regular file\n"); continue;
              }
              const mode = (file.permissions & 0o777).toString(8).padStart(3, "0");
              const digest = file.fileSize && file.fileSize <= MAX ?
                " sha256=" + sha256(file) : "";
              send(path + ": size=" + file.fileSize + " mode=" + mode + digest + "\n");
            } catch (error) { send(path + ": inspection failed: " + error + "\n"); }
          }
          return;
        }
        if (line === "LOG") {
          try {
            const file = fileAt(profile.path + "/binary-runner-events.log");
            if (!file.exists()) { send("No XPI log yet.\n"); return; }
            const lines = readText(file, 32768).trim().split(/\r?\n/).slice(-12);
            send(lines.join("\n").slice(-4096) + "\n");
          } catch (error) { send("Log read failed: " + error + "\n"); }
          return;
        }
        if (!/^RUN [\x20-\x7e]{1,256}$/.test(line)) {
          send("Use INSPECT, LOG, STATUS, RUN <command>, or QUIT.\n");
          return;
        }
        if (busy) { send("A command is already running.\n"); return; }
        busy = true;
        const outputFile = fileAt(profile.path + "/binary-runner-cmd-" +
          Date.now() + "-" + (++serial) + ".txt");
        const shell = fileAt("/system/bin/sh");
        let timer;
        try {
          if (!shell.exists() || !shell.isFile()) throw new Error("/system/bin/sh unavailable");
          if (outputFile.exists()) throw new Error("Command output path already exists");
          const process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
          process.init(shell);
          const script = "( " + line.slice(4) + " ) 2>&1 | /system/bin/toybox head -c 8192 > '" +
            outputFile.path + "'";
          timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
          let timedOut = false;
          timer.initWithCallback({ notify() {
            if (process.isRunning) { timedOut = true; process.kill(); }
          } }, 8000, Ci.nsITimer.TYPE_ONE_SHOT);
          process.runAsync(["-c", script], 2, { observe(_subject, topic) {
            timer.cancel();
            busy = false;
            let result = "";
            try {
              if (outputFile.exists()) {
                result = outputFile.fileSize ? readText(outputFile, 8193) : "";
                outputFile.remove(false);
              }
            } catch (error) { result = "Output read failed: " + error + "\n"; }
            let outcome = timedOut ? "timed out" : "process failed";
            if (!timedOut && topic !== "process-failed") {
              try { outcome = "shell pipeline exit " + process.exitValue; }
              catch (error) { outcome = "exit status unavailable: " + error; }
            }
            send(result + "\n[" + outcome + "]\n");
            event(profile, "debug command finished: " + outcome);
          } }, false);
          event(profile, "debug command started");
        } catch (error) {
          if (timer) timer.cancel();
          busy = false;
          send("Command could not start: " + error + "\n");
          event(profile, "debug command start failed: " + error);
        }
      }
      const pump = Cc["@mozilla.org/network/input-stream-pump;1"]
        .createInstance(Ci.nsIInputStreamPump);
      client.pump = pump;
      pump.init(input, 0, 0, true);
      pump.asyncRead({
        onStartRequest() { send("Binary Runner B2G socket. INSPECT, LOG, STATUS, RUN <command>, QUIT.\n"); },
        onDataAvailable(_request, stream, _offset, count) {
          if (count > 1024) { transport.close(0); throw new Error("Debug input too long"); }
          const reader = Cc["@mozilla.org/scriptableinputstream;1"]
            .createInstance(Ci.nsIScriptableInputStream);
          reader.init(stream);
          client.buffer += reader.read(count);
          if (client.buffer.length > 1024) { transport.close(0); return; }
          let end;
          while ((end = client.buffer.indexOf("\n")) >= 0) {
            const line = client.buffer.slice(0, end).replace(/\r$/, "");
            client.buffer = client.buffer.slice(end + 1);
            command(line);
          }
        },
        onStopRequest() { clients.delete(client); transport.close(0); }
      }, null);
    },
    onStopListening(_server, reason) {
      if (!closed) {
        try { socketState(profile, "stopped", "listener stopped: " + reason); }
        catch (error) { console.error("Binary Runner socket stop log failed: " + error); }
      }
    }
  };
  server.asyncListen(listener);
  try { socketState(profile, "listening", "127.0.0.1:5556; local command access"); }
  catch (error) { console.error("Binary Runner socket status write failed: " + error); }
  return { close() {
    closed = true;
    server.close();
    for (const client of clients) client.transport.close(0);
    clients.clear();
    try { socketState(profile, "stopped", "XPI shut down"); } catch (_) {}
  } };
}

function verify(f,hash){if(sha256(f)!==hash)throw Error("Readback hash mismatch");if((f.permissions&0o111)!==0o111)throw Error("Executable mode missing: "+f.permissions.toString(8));}
function quote(value){return "'"+String(value).replace(/'/g,"'\\''")+"'";}
function runShell(script){const shell=fileAt("/system/bin/sh");
 if(!shell.exists()||!shell.isFile())throw Error("System shell unavailable");
 const process=Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
 process.init(shell);process.run(true,["-c",script],2);
 if(process.exitValue!==0)throw Error("System command failed (exit "+process.exitValue+")");
}
function updaterMeta(profile,id){const out=fileAt(profile.path+"/binary-runner-meta-"+id+".txt");
 if(out.exists()){if(out.isSymlink()||!out.isFile())throw Error("Unsafe metadata report");out.remove(false);}
 try{
  runShell("/system/bin/ls -liZ "+quote(UPDATER)+" > "+quote(out.path));
  const line=readText(out,1024);
  const match=/^\s*(\d+)\s+\S+\s+\d+\s+\S+\s+\S+\s+(u:object_r:[A-Za-z0-9_]+:s0)\s+/.exec(line);
  if(!match)throw Error("Could not read updater inode and SELinux label");
  return {inode:match[1],label:match[2]};
 }finally{if(out.exists())out.remove(false);}
}
function stopUpdater(){runShell("/system/bin/setprop ctl.stop updater-daemon || exit 11; " +
 "i=0; while [ \"$i\" -lt 5 ]; do " +
 "[ \"$(/system/bin/getprop init.svc.updater-daemon)\" = stopped ] && exit 0; " +
 "/system/bin/sleep 1; i=$((i+1)); done; exit 12");}
function startUpdater(){runShell("/system/bin/setprop ctl.start updater-daemon || exit 21; " +
 "i=0; while [ \"$i\" -lt 5 ]; do " +
 "[ \"$(/system/bin/getprop init.svc.updater-daemon)\" = running ] && " +
 "[ -f "+quote(UPDATER)+" ] && [ -f "+quote(UPDATER_DIR+"/init")+" ] && exit 0; " +
 "/system/bin/sleep 1; i=$((i+1)); done; exit 22");}
function copyWithMode(source,parent,name,mode){if(!regular(source))throw Error("Invalid copy source");const expected=sha256(source);const dest=fileAt(parent.path+"/"+name);if(dest.exists())throw Error("Copy destination already exists");
 source.copyTo(parent,name);if(!regular(dest))throw Error("Backup copy failed");
 dest.permissions=mode;
 if(sha256(dest)!==expected)throw Error("Backup hash mismatch");
 if((dest.permissions&0o777)!==(mode&0o777))throw Error("Backup mode mismatch");
 return dest;}
function ensureFirstBackup(stock){const d=createDir(BACKUPS+"/first-use-backup");const f=fileAt(d.path+"/updater-daemon");
 if(f.exists()){if(!regular(f))throw Error("Old first-use backup invalid");event(Services.dirsvc.get("ProfD",Ci.nsIFile),"First-use backup preserved, mode "+f.permissions.toString(8));return;}
 copyWithMode(stock,d,"updater-daemon",0o755);}
function restoreStock(profile,id){
 const stock=fileAt(STOCK_UPDATER),target=fileAt(UPDATER),init=fileAt(UPDATER_DIR+"/init");
 if(!regular(stock))throw Error("System stock updater missing or unsafe");
 // The read-only system copy can be mode 0644; the service recreates an executable data-side copy.
 const expected=sha256(stock);
 for(const f of [target,init])if(f.exists()&&(f.isSymlink()||!f.isFile()))
   throw Error("Unsafe updater path: "+f.path);
 stopUpdater();
 // Removing both files makes the stock wrapper create a fresh inode and label.
 if(init.exists())init.remove(false);
 if(target.exists())target.remove(false);
 if(target.exists()||init.exists())throw Error("Could not clear old updater and init marker");
 startUpdater();
 if(!regular(target)||!init.exists()||init.isSymlink()||!init.isFile())
   throw Error("Stock wrapper did not recreate updater and init marker");
 if(sha256(target)!==expected||(target.permissions&0o777)!==0o755)
   throw Error("Restored updater does not match the executable system stock copy");
 const meta=updaterMeta(profile,id);
 if(/:(b2g_data_file|shell_data_file):/.test(meta.label))
   throw Error("Restored updater has unexpected SELinux label "+meta.label);
 event(profile,"Stock restored: SHA256 "+expected+" mode 0755 label "+meta.label+" inode "+meta.inode);
 return {hash:expected,meta};
}
function replaceFrom(source,expected,id,profile,stock){const target=fileAt(UPDATER),dir=fileAt(UPDATER_DIR);
 if(!regular(target))throw Error("Updater target missing or unsafe");
 const oldHash=sha256(target),oldMode=target.permissions&0o777;
 if(oldHash!==stock.hash||oldMode!==0o755)throw Error("Stock updater changed before staging");
 const tempName=".binary-runner-stage-"+id, temp=copyWithMode(source,dir,tempName,0o755);
 verify(temp,expected);
 const oldDir=createDir(BACKUPS+"/backup-"+id);
 copyWithMode(target,oldDir,"updater-daemon",oldMode);
 event(profile,"Stock updater backup saved: SHA256 "+oldHash+" label "+stock.meta.label);
 try{
  stopUpdater();
  // A successful empty append proves the stock inode can be written in place.
  runShell(": >> "+quote(UPDATER));
  const before=updaterMeta(profile,id);
  if(before.inode!==stock.meta.inode||before.label!==stock.meta.label)
    throw Error("Stock updater inode or SELinux label changed before copy");
  runShell("/system/bin/cp -f "+quote(temp.path)+" "+quote(UPDATER)+
   " && /system/bin/chmod 755 "+quote(UPDATER));
  const installed=fileAt(UPDATER);verify(installed,expected);
  if((installed.permissions&0o777)!==0o755)throw Error("Updater mode is not 0755");
  const after=updaterMeta(profile,id);
  if(after.inode!==before.inode||after.label!==before.label)
    throw Error("Updater inode or SELinux label changed during copy");
  runShell("[ \"$(/system/bin/getprop init.svc.updater-daemon)\" = stopped ]");
  event(profile,"New updater SHA256 "+expected+" mode 0755 label "+after.label+
    " inode "+after.inode+" preserved; service stopped");
  try{temp.remove(false);}catch(cleanupError){event(profile,"Staged copy cleanup failed: "+cleanupError);}
 }catch(e){
  let note="";
  try{restoreStock(profile,id);note="stock updater restored and running";}
  catch(r){note="CRITICAL: stock recovery failed: "+r;}
  throw Error(e+"; "+note);
 }
}
function validate(v){if(!v||!/^[a-f0-9]{16}$/.test(v.id))throw Error("Unrecognized staging request");
 if(v.action==="restore"&&Object.keys(v).length===2)return v;
 if(v.action==="stage"&&v.kind==="local"&&v.name==="Local_binary"&&
    Object.keys(v).length===6&&Number.isSafeInteger(v.size)&&v.size>=20&&v.size<=MAX&&
    /^[a-f0-9]{64}$/.test(v.sha256))return v;
 if(v.action!=="stage"||v.kind!==undefined||!Object.prototype.hasOwnProperty.call(ALLOWED,v.name)||
    ALLOWED[v.name].size!==v.size||ALLOWED[v.name].sha256!==v.sha256)
   throw Error("Unrecognized staging request");
 return v;}
function perform(p,v){
 if(v.action==="restore"){
  restoreStock(p,v.id);
  return "Stock updater restored and running; hash, mode, and SELinux label verified.";
 }
 const src=fileAt(p.path+"/binary-runner-payload-"+v.id+".bin");
 if(!regular(src,v.size)||src.fileSize!==v.size||sha256(src)!==v.sha256||!armElf(src))throw Error("Staged binary failed verification");
 const stock=restoreStock(p,v.id);
 createDir(BACKUPS);ensureFirstBackup(fileAt(STOCK_UPDATER));
 replaceFrom(src,v.sha256,v.id,p,stock);
 return "Copied "+v.name+" into the fresh stock inode; hash, mode 0755, and SELinux label verified. Reboot manually once more to start it.";
}
this.binaryRunnerInstaller=class extends ExtensionAPI{
 onStartup(){const p=Services.dirsvc.get("ProfD",Ci.nsIFile),f=fileAt(p.path+"/"+REQUEST);
  try{this.debugSocket=startDebugSocket(p);}catch(e){event(p,"Debug socket failed: "+e);}
  if(!f.exists())return;
  let v;
  try{
   v=validate(JSON.parse(readText(f)));
   const marker=fileAt(p.path+"/binary-runner-attempt-"+v.id);
   if(marker.exists())return;
   marker.create(Ci.nsIFile.NORMAL_FILE_TYPE,0o600);
   result(p,v.id,"running","Installer started");
   result(p,v.id,"success",perform(p,v));
  }catch(e){try{if(v)result(p,v.id,"failed",e);}catch(ignored){}console.error("Binary Runner stopped: "+e);}
 }
 onShutdown(){if(this.debugSocket)this.debugSocket.close();}
};
