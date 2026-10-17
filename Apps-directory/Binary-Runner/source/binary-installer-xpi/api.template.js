"use strict";

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const ALLOWED = __ALLOWLIST__;
const TARGET_DIR = "/data/local/service/updater";
const TARGET_PATH = TARGET_DIR + "/updater-daemon";
const BACKUP_PATH = TARGET_DIR + "/jscalated-runner";
const REQUEST_NAME = "binary-runner-request.json";
const MAX_BYTES = 16 * 1024 * 1024;

function fileAt(path) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  return file;
}

function regular(file, max) {
  return file.exists() && !file.isSymlink() && file.isFile() &&
    file.fileSize > 0 && file.fileSize <= max;
}

function readText(file, limit = 4096) {
  if (!regular(file, limit)) throw new Error("Missing or invalid text file: " + file.path);
  const input = Cc["@mozilla.org/network/file-input-stream;1"]
    .createInstance(Ci.nsIFileInputStream);
  input.init(file, 0x01, 0, 0);
  const converter = Cc["@mozilla.org/intl/converter-input-stream;1"]
    .createInstance(Ci.nsIConverterInputStream);
  converter.init(input, "UTF-8", 0, 0);
  const result = {};
  try { converter.readString(-1, result); }
  finally { converter.close(); }
  return result.value;
}

function sha256(file) {
  if (!regular(file, MAX_BYTES)) throw new Error("Invalid binary file: " + file.path);
  const input = Cc["@mozilla.org/network/file-input-stream;1"]
    .createInstance(Ci.nsIFileInputStream);
  input.init(file, 0x01, 0, 0);
  const hash = Cc["@mozilla.org/security/hash;1"]
    .createInstance(Ci.nsICryptoHash);
  hash.init(hash.SHA256);
  try { hash.updateFromStream(input, file.fileSize); }
  finally { input.close(); }
  const digest = hash.finish(false);
  let hex = "";
  for (let i = 0; i < digest.length; i++)
    hex += (digest.charCodeAt(i) + 256).toString(16).slice(1);
  return hex;
}

function writeStatus(profile, id, state, detail) {
  const status = fileAt(profile.path + "/binary-runner-status-" + id + ".json");
  if (status.exists() && (status.isSymlink() || !status.isFile()))
    throw new Error("Unsafe status path");
  const value = JSON.stringify({ id, state,
    detail: String(detail).replace(/[^\x20-\x7e]/g, "?") }) + "\n";
  const output = Cc["@mozilla.org/network/file-output-stream;1"]
    .createInstance(Ci.nsIFileOutputStream);
  output.init(status, 0x02 | 0x08 | 0x20, 0o600, 0);
  try {
    if (output.write(value, value.length) !== value.length)
      throw new Error("Short status write");
  } finally { output.close(); }
  appendEvent(profile, "request " + id + " " + state + ": " + detail);
}

function writeText(file, value) {
  if (file.exists() && (file.isSymlink() || !file.isFile()))
    throw new Error("Unsafe output path: " + file.path);
  const output = Cc["@mozilla.org/network/file-output-stream;1"]
    .createInstance(Ci.nsIFileOutputStream);
  output.init(file, 0x02 | 0x08 | 0x20, 0o600, 0);
  try {
    if (output.write(value, value.length) !== value.length)
      throw new Error("Short output write");
  } finally { output.close(); }
}

function appendEvent(profile, detail) {
  try {
    const file = fileAt(profile.path + "/binary-runner-events.log");
    if (file.exists() && (file.isSymlink() || !file.isFile())) return;
    const reset = file.exists() && file.fileSize > 32768;
    const value = new Date().toISOString() + " " +
      String(detail).replace(/[^\x20-\x7e]/g, "?").slice(0, 512) + "\n";
    const output = Cc["@mozilla.org/network/file-output-stream;1"]
      .createInstance(Ci.nsIFileOutputStream);
    output.init(file, 0x02 | 0x08 | (reset ? 0x20 : 0x10), 0o600, 0);
    try { output.write(value, value.length); }
    finally { output.close(); }
  } catch (error) { console.error("Binary Runner log write failed: " + error); }
}

function socketState(profile, state, detail) {
  writeText(fileAt(profile.path + "/binary-runner-socket.json"),
    JSON.stringify({ state, port: 5556, detail: String(detail).slice(0, 512) }) + "\n");
  appendEvent(profile, "socket " + state + ": " + detail);
}

function debugToken(profile) {
  const file = fileAt(profile.path + "/binary-runner-debug-token");
  if (file.exists()) {
    if (file.isSymlink() || !file.isFile() || (file.permissions & 0o077))
      throw new Error("Unsafe debug token file");
    const token = readText(file).trim();
    if (!/^[0-9a-f]{32}$/.test(token)) throw new Error("Invalid debug token");
    return token;
  }
  const token = Cc["@mozilla.org/uuid-generator;1"].getService(Ci.nsIUUIDGenerator)
    .generateUUID().toString().replace(/[{}-]/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(token)) throw new Error("Could not generate debug token");
  writeText(file, token + "\n");
  file.permissions = 0o600;
  return token;
}

// One authenticated command per RUN line. No command runs at XPI startup.
function startDebugSocket(profile) {
  const token = debugToken(profile);
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
      const client = { transport, output, buffer: "", authorized: false, pump: null };
      clients.add(client);
      function send(value) {
        try {
          if (output.write(value, value.length) !== value.length)
            throw new Error("Short socket write");
        } catch (error) {
          appendEvent(profile, "socket write failed: " + error);
          transport.close(0);
        }
      }
      function command(line) {
        if (!client.authorized) {
          if (line === "AUTH " + token) {
            client.authorized = true;
            send("OK. Enter RUN <command>, STATUS, or QUIT.\n");
          } else {
            send("Authentication failed.\n");
            transport.close(0);
          }
          return;
        }
        if (line === "QUIT") { transport.close(0); return; }
        if (line === "STATUS") {
          send("B2G command socket listening on 127.0.0.1:5556; " +
            (busy ? "command running" : "idle") + ".\n");
          return;
        }
        if (!/^RUN [\x20-\x7e]{1,256}$/.test(line)) {
          send("Use RUN <command>, STATUS, or QUIT.\n");
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
            appendEvent(profile, "debug command finished: " + outcome);
          } }, false);
          appendEvent(profile, "debug command started");
        } catch (error) {
          if (timer) timer.cancel();
          busy = false;
          send("Command could not start: " + error + "\n");
          appendEvent(profile, "debug command start failed: " + error);
        }
      }
      const pump = Cc["@mozilla.org/network/input-stream-pump;1"]
        .createInstance(Ci.nsIInputStreamPump);
      client.pump = pump;
      pump.init(input, 0, 0, true);
      pump.asyncRead({
        onStartRequest() { send("Binary Runner debug socket. AUTH <token> required.\n"); },
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
  try { socketState(profile, "listening", "127.0.0.1:5556; authenticated command access"); }
  catch (error) { console.error("Binary Runner socket status write failed: " + error); }
  return { close() {
    closed = true;
    server.close();
    for (const client of clients) client.transport.close(0);
    clients.clear();
    try { socketState(profile, "stopped", "XPI shut down"); } catch (_) {}
  } };
}

function validateRequest(value) {
  if (!value || !/^[0-9a-f]{16}$/.test(value.id) ||
      (value.action !== "stage" && value.action !== "restore"))
    throw new Error("Invalid Binary Runner request");
  if (value.action === "stage") {
    const entry = ALLOWED[value.name];
    if (!entry || value.sha256 !== entry.sha256 || value.size !== entry.size)
      throw new Error("Binary is not in this release's allowlist");
  }
  return value;
}

function ensureDirectory(path) {
  const directory = fileAt(path);
  if (!directory.exists()) directory.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  if (directory.isSymlink() || !directory.isDirectory())
    throw new Error("Unsafe directory: " + path);
  return directory;
}

function verify(file, hash) {
  if (sha256(file) !== hash) throw new Error("Binary readback hash mismatch");
  if ((file.permissions & 0o111) !== 0o111)
    throw new Error("Executable permission bits are missing");
}

function restoreContext(path) {
  const shell = fileAt("/system/bin/sh");
  if (!shell.exists() || !shell.isFile())
    throw new Error("System shell is unavailable");
  const process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
  process.init(shell);
  if (!/^\/data\/local\/service\/updater\/[A-Za-z0-9._-]+$/.test(path))
    throw new Error("Unsafe restorecon path");
  process.run(true, ["-c", "restorecon '" + path + "'"], 2);
  if (process.exitValue !== 0)
    throw new Error("restorecon failed with exit " + process.exitValue);
}

function firstUseBackup(target) {
  const directory = ensureDirectory(BACKUP_PATH + "/first-use-backup");
  const backup = fileAt(directory.path + "/updater-daemon");
  if (backup.exists()) {
    if (!regular(backup, MAX_BYTES)) throw new Error("First-use backup is invalid");
    return backup;
  }
  if ((target.permissions & 0o111) !== 0o111)
    throw new Error("Cannot back up a nonexecutable updater as the first-use file");
  const expected = sha256(target);
  target.copyTo(directory, "updater-daemon");
  if (sha256(backup) !== expected) throw new Error("First-use backup did not verify");
  return backup;
}

function replace(source, expected, id) {
  const directory = fileAt(TARGET_DIR);
  const target = fileAt(TARGET_PATH);
  if (!regular(target, MAX_BYTES)) throw new Error("Updater executable is missing or unsafe");
  const oldHash = sha256(target);
  if (oldHash === expected) {
    target.permissions = 0o755;
    verify(target, expected);
    restoreContext(TARGET_PATH);
    return "existing bytes made executable";
  }

  const temporaryName = ".jscalated-stage-" + id;
  const temporary = fileAt(TARGET_DIR + "/" + temporaryName);
  if (temporary.exists()) throw new Error("Temporary path already exists");
  source.copyTo(directory, temporaryName);
  temporary.permissions = 0o755;
  verify(temporary, expected);
  restoreContext(temporary.path);

  const previous = ensureDirectory(BACKUP_PATH + "/backup-" + id);
  const saved = fileAt(previous.path + "/updater-daemon");
  if (saved.exists()) throw new Error("Previous-file backup already exists");
  let replaced = false;
  try {
    target.copyTo(previous, "updater-daemon");
    if (sha256(saved) !== oldHash) throw new Error("Previous-file backup did not verify");
    if ((saved.permissions & 0o111) !== (target.permissions & 0o111))
      throw new Error("Previous-file backup lost executable permissions");
    temporary.moveTo(directory, "updater-daemon");
    replaced = true;
    const installed = fileAt(TARGET_PATH);
    installed.permissions = 0o755;
    verify(installed, expected);
    restoreContext(TARGET_PATH);
    verify(installed, expected);
    return "binary placed, mode verified, and prior file saved";
  } catch (error) {
    if (!replaced) throw error;
    let rollback = "";
    try {
      const rollbackName = ".jscalated-rollback-" + id;
      const rollbackFile = fileAt(TARGET_DIR + "/" + rollbackName);
      if (rollbackFile.exists()) throw new Error("Rollback path already exists");
      saved.copyTo(directory, rollbackName);
      if (sha256(rollbackFile) !== oldHash)
        throw new Error("Rollback copy hash mismatch");
      rollbackFile.moveTo(directory, "updater-daemon");
      restoreContext(TARGET_PATH);
      if (sha256(fileAt(TARGET_PATH)) !== oldHash)
        throw new Error("Restored file hash mismatch");
      rollback = "previous file restored";
    } catch (restoreError) {
      rollback = "RESTORE FAILED: " + String(restoreError);
    }
    throw new Error(String(error) + "; " + rollback);
  }
}

function perform(profile, request) {
  const marker = fileAt(TARGET_DIR + "/init");
  if (!marker.exists() || marker.isSymlink() || !marker.isFile())
    throw new Error("Updater init marker is missing");
  ensureDirectory(BACKUP_PATH);
  const target = fileAt(TARGET_PATH);
  if (!regular(target, MAX_BYTES)) throw new Error("Updater executable is missing or unsafe");

  let source;
  let expected;
  if (request.action === "stage") {
    source = fileAt(profile.path + "/binary-runner-payload-" + request.id + ".bin");
    if (!regular(source, request.size) || source.fileSize !== request.size)
      throw new Error("Staged binary size does not match");
    expected = request.sha256;
    if (sha256(source) !== expected) throw new Error("Staged binary hash does not match");
    firstUseBackup(target);
  } else {
    source = fileAt(BACKUP_PATH + "/first-use-backup/updater-daemon");
    if (!regular(source, MAX_BYTES)) throw new Error("First-use backup is unavailable");
    expected = sha256(source);
  }
  return replace(source, expected, request.id);
}

this.binaryRunnerInstaller = class extends ExtensionAPI {
  onStartup() {
    const profile = Services.dirsvc.get("ProfD", Ci.nsIFile);
    try { this.debugSocket = startDebugSocket(profile); }
    catch (error) {
      try { socketState(profile, "failed", error); } catch (_) {}
      console.error("Binary Runner debug socket failed: " + error);
    }
    const requestFile = fileAt(profile.path + "/" + REQUEST_NAME);
    if (!requestFile.exists()) return;
    let request;
    try {
      request = validateRequest(JSON.parse(readText(requestFile)));
      const attempt = fileAt(profile.path + "/binary-runner-attempt-" + request.id);
      if (attempt.exists()) return;
      attempt.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
      writeStatus(profile, request.id, "running", "Installer started");
      const result = perform(profile, request);
      writeStatus(profile, request.id, "success", result);
    } catch (error) {
      try {
        if (request) writeStatus(profile, request.id, "failed", error);
      } catch (_) {}
      console.error("Binary Runner installer stopped: " + String(error));
    }
  }
  onShutdown() {
    if (this.debugSocket) this.debugSocket.close();
  }
};
