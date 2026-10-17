(function () {
  "use strict";

  var BASE = new URL("./", document.baseURI).href;
  var TARGET = "local/service/updater";
  var RUNNER = TARGET + "/jscalated-runner";
  var XPI_NAME = "jscalated-binary-runner@local.xpi";
  var REQUEST_NAME = "binary-runner-request.json";
  var MAX_BYTES = 16 * 1024 * 1024;
  var state = { apps: null, appsRoot: null, target: null, runner: null, entries: [], installedVersion: null };

  var choice = document.getElementById("choice");
  var detail = document.getElementById("detail");
  var status = document.getElementById("status");
  var log = document.getElementById("log");
  var stageButton = document.getElementById("stage");
  var inspectButton = document.getElementById("inspect");
  var restoreButton = document.getElementById("restore");
  var debugButton = document.getElementById("debug");
  var refreshButton = document.getElementById("refresh-logs");

  function say(message) {
    status.textContent = message;
    var line = new Date().toLocaleTimeString() + " " + message;
    log.textContent = (log.textContent + line + "\n").split("\n").slice(-100).join("\n");
  }
  function fail(error) {
    say("Stopped: " + (error && error.message || String(error)));
  }
  function deadline(promise, label) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(Error(label + " timed out after 15 seconds")); }, 15000);
      Promise.resolve(promise).then(function (value) { clearTimeout(timer); resolve(value); },
        function (error) { clearTimeout(timer); reject(error); });
    });
  }
  function isDirectory(value) {
    return !!value && typeof value.getFilesAndDirectories === "function";
  }
  async function child(directory, name) {
    var entries = await directory.getFilesAndDirectories();
    return entries.find(function (entry) { return entry.name === name; }) || null;
  }
  async function entryAt(root, path) {
    try {
      return await root.get(path);
    } catch (firstError) {
      var current = root;
      var parts = path.split("/");
      for (var i = 0; i < parts.length; i++) {
        if (!isDirectory(current)) throw firstError;
        var entries = await current.getFilesAndDirectories();
        current = entries.find(function (entry) { return entry.name === parts[i]; });
        if (!current) throw firstError;
      }
      return current;
    }
  }
  async function directoryAt(root, path) {
    var entry = await entryAt(root, path);
    if (!isDirectory(entry)) throw Error("Missing /data/" + path);
    return entry;
  }
  function readBytes(file) {
    return new Promise(function (resolve, reject) {
      if (!file || isDirectory(file) || file.size > MAX_BYTES) {
        reject(Error("File is missing, a directory, or too large"));
        return;
      }
      var reader = new FileReader();
      reader.onload = function () { resolve(new Uint8Array(reader.result)); };
      reader.onerror = function () { reject(reader.error || Error("FileReader failed")); };
      reader.readAsArrayBuffer(file);
    });
  }
  function same(left, right) {
    if (left.length !== right.length) return false;
    for (var i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
    return true;
  }
  function requestBytes(url) {
    return new Promise(function (resolve, reject) {
      var request = new XMLHttpRequest();
      request.open("GET", url, true);
      request.responseType = "arraybuffer";
      request.timeout = 30000;
      request.onload = function () {
        if (request.status !== 200 || !request.response) reject(Error("GET " + request.status + " for " + url));
        else resolve(new Uint8Array(request.response));
      };
      request.onerror = function () { reject(Error("Network error fetching " + url)); };
      request.ontimeout = function () { reject(Error("Timed out fetching " + url)); };
      request.send();
    });
  }
  async function sha256(bytes) {
    if (!crypto.subtle || !crypto.subtle.digest) throw Error("SHA-256 is unavailable on this page");
    var digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest).map(function (value) { return value.toString(16).padStart(2, "0"); }).join("");
  }
  function validEntry(entry) {
    return entry && typeof entry.name === "string" && /^[A-Za-z0-9._-]+$/.test(entry.name) &&
      entry.kind === "binary" &&
      entry.path === "payloads/binaries/" + entry.name &&
      Number.isInteger(entry.size) && entry.size > 0 && entry.size <= MAX_BYTES &&
      typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256);
  }
  async function loadCatalog() {
    if (!BASE || new URL(BASE).origin !== location.origin) throw Error("App assets must load from the installed app");
    var bytes = await requestBytes(new URL("payloads/catalog.json", BASE).href);
    var parsed = JSON.parse(new TextDecoder("utf-8").decode(bytes));
    if (!Array.isArray(parsed) || !parsed.every(validEntry)) throw Error("Invalid payload catalog");
    state.entries = parsed;
    choice.replaceChildren();
    parsed.forEach(function (entry, index) {
      var option = document.createElement("option");
      option.value = String(index);
      option.textContent = entry.name + " (" + entry.kind + ")";
      choice.appendChild(option);
    });
    stageButton.disabled = !parsed.length;
    updateDetail();
    say(parsed.length ? parsed.length + " bundled file(s) available." : "No files are bundled yet.");
  }
  function updateDetail() {
    var entry = state.entries[Number(choice.value)];
    detail.textContent = entry ? entry.kind + ", " + entry.size + " bytes, SHA-256 " + entry.sha256 : "";
  }
  async function storage() {
    if (!state.apps) {
      if (navigator.b2g && typeof navigator.b2g.getDeviceStorage === "function") {
        state.apps = navigator.b2g.getDeviceStorage("apps");
      } else if (typeof navigator.getDeviceStorage === "function") {
        state.apps = navigator.getDeviceStorage("apps");
      } else {
        throw Error("The installed core app does not expose the apps DeviceStorage API");
      }
      if (!state.apps || typeof state.apps.getRoot !== "function") {
        throw Error("The apps DeviceStorage filesystem interface is unavailable");
      }
      state.appsRoot = await state.apps.getRoot();
    }
    return state.apps;
  }
  async function preflight() {
    await storage();
    state.target = await directoryAt(state.appsRoot, TARGET);
    var init = await child(state.target, "init");
    if (!init || isDirectory(init)) throw Error("Updater init marker missing; boot would restore stock");
    var installed = await directoryAt(state.target, "installed");
    var manifests = (await installed.getFilesAndDirectories()).filter(function (file) {
      return /^updater-.*\.toml$/.test(file.name) && !isDirectory(file);
    });
    if (manifests.length !== 1) throw Error("Expected one installed updater manifest; found " + manifests.length);
    var manifest = new TextDecoder("utf-8").decode(await readBytes(manifests[0]));
    var match = manifest.match(/\bversion\s*=\s*"([0-9]+(?:\.[0-9]+)*)"/);
    if (!match) throw Error("Installed updater version is unavailable");
    state.installedVersion = match[1];
    var current = await child(state.target, "updater-daemon");
    if (!current || isDirectory(current)) throw Error("Updater executable is missing");
    var bytes = await readBytes(current);
    var runner = await child(state.target, "jscalated-runner");
    if (runner && !isDirectory(runner)) throw Error("Runner backup path is a file");
    state.runner = runner;
    return bytes;
  }
  function requestId() {
    var bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(function (value) {
      return (value + 256).toString(16).slice(1);
    }).join("");
  }
  async function profileInfo() {
    await storage();
    var mozilla = await directoryAt(state.appsRoot, "b2g/mozilla");
    var ini = new TextDecoder("utf-8").decode(
      await readBytes(await entryAt(mozilla, "profiles.ini")));
    var sections = ini.split(/^\[/m).filter(function (part) { return /^Profile\d+\]/.test(part); });
    var profiles = sections.map(function (section) {
      var path = /^Path=([^\r\n]+)/m.exec(section);
      var relative = /^IsRelative=(\d+)/m.exec(section);
      return { path: path && path[1].trim(), relative: relative && relative[1],
        isDefault: /^Default=1\s*$/m.test(section) };
    }).filter(function (item) { return !!item.path; });
    var chosen = profiles.filter(function (item) { return item.isDefault; });
    if (chosen.length !== 1) chosen = profiles.length === 1 ? profiles : [];
    if (chosen.length !== 1 || chosen[0].relative !== "1")
      throw Error("Could not identify one relative default Mozilla profile");
    var parts = chosen[0].path.split("/");
    if (parts.some(function (part) {
      return !/^[A-Za-z0-9._-]+$/.test(part) || part === "." || part === "..";
    })) throw Error("Unsafe Mozilla profile path");
    return await directoryAt(mozilla, chosen[0].path);
  }
  async function stageExact(directory, name, bytes, mime) {
    var existing = await child(directory, name);
    if (existing) {
      if (isDirectory(existing) || !same(await readBytes(existing), bytes))
        throw Error(name + " already exists with different contents");
    } else {
      await directory.createFile(name, {
        ifExists: "fail", data: new Blob([bytes], { type: mime })
      });
    }
    if (!same(await readBytes(await child(directory, name)), bytes))
      throw Error("Readback mismatch for " + name);
  }
  async function installerXpi(profile, id) {
    var metaBytes = await requestBytes(new URL("payloads/binary-installer-meta.json", BASE).href);
    var meta = JSON.parse(new TextDecoder("utf-8").decode(metaBytes));
    var xpi = await requestBytes(new URL("payloads/binary-installer.xpi", BASE).href);
    if (meta.file !== "binary-installer.xpi" || meta.size !== xpi.length ||
        !/^[a-f0-9]{64}$/.test(meta.sha256) || await sha256(xpi) !== meta.sha256)
      throw Error("Bundled installer XPI failed size or SHA-256 verification");
    var extensions = await child(profile, "extensions");
    if (!extensions) extensions = await profile.createDirectory("extensions");
    if (!isDirectory(extensions)) throw Error("Profile extensions path is not a directory");
    var existing = await child(extensions, XPI_NAME);
    if (existing && isDirectory(existing)) throw Error("Installer XPI path is a directory");
    if (existing && !same(await readBytes(existing), xpi)) {
      await stageExact(extensions, XPI_NAME + ".backup-" + id,
        await readBytes(existing), "application/octet-stream");
      await extensions.remove(XPI_NAME);
      try { await stageExact(extensions, XPI_NAME, xpi, "application/x-xpinstall"); }
      catch (error) {
        if (!(await child(extensions, XPI_NAME))) {
          var backup = await child(extensions, XPI_NAME + ".backup-" + id);
          await stageExact(extensions, XPI_NAME, await readBytes(backup),
            "application/x-xpinstall");
        }
        throw error;
      }
    } else if (!existing) {
      await stageExact(extensions, XPI_NAME, xpi, "application/x-xpinstall");
    }
    say("Separate Binary Runner XPI verified. Existing ADB XPI was not changed.");
  }
  async function ensureExtensionScan(profile, id) {
    var existing = await child(profile, "user.js");
    var original = existing ? new TextDecoder("utf-8").decode(await readBytes(existing)) : "";
    var pref = 'user_pref("extensions.startupScanScopes", 1);';
    if (/^user_pref\("extensions\.startupScanScopes",\s*1\);?\s*$/m.test(original)) return;
    if (/^user_pref\("extensions\.startupScanScopes",/m.test(original))
      throw Error("user.js has a conflicting extension scan setting");
    var updated = original + (original && !/\n$/.test(original) ? "\n" : "") + pref + "\n";
    if (existing) {
      await stageExact(profile, "user.js.binary-runner-backup-" + id,
        new TextEncoder().encode(original), "text/plain");
      await profile.remove("user.js");
    }
    try {
      await stageExact(profile, "user.js", new TextEncoder().encode(updated), "text/plain");
    } catch (error) {
      if (existing && !(await child(profile, "user.js"))) {
        await stageExact(profile, "user.js", new TextEncoder().encode(original), "text/plain");
      }
      throw error;
    }
    say("Enabled profile extension scanning without changing other preferences.");
  }
  async function checkPending(profile) {
    var current = await child(profile, REQUEST_NAME);
    if (!current) return;
    var task = JSON.parse(new TextDecoder("utf-8").decode(await readBytes(current)));
    if (!/^[0-9a-f]{16}$/.test(task.id)) throw Error("Existing request is invalid");
    var statusFile = await child(profile, "binary-runner-status-" + task.id + ".json");
    if (!statusFile) throw Error("An earlier request is still waiting for XPI startup");
    var status = JSON.parse(new TextDecoder("utf-8").decode(await readBytes(statusFile)));
    if (status.id !== task.id || (status.state !== "success" && status.state !== "failed"))
      throw Error("An earlier request is still in progress");
  }
  async function stageRequest(profile, task, bytes) {
    if (task.action !== "restore") await checkPending(profile);
    var id = task.id;
    if (bytes) await stageExact(profile, "binary-runner-payload-" + id + ".bin",
      bytes, "application/octet-stream");
    await installerXpi(profile, id);
    await ensureExtensionScan(profile, id);
    var request = new TextEncoder().encode(JSON.stringify(task) + "\n");
    var old = await child(profile, REQUEST_NAME);
    if (old) {
      await stageExact(profile, REQUEST_NAME + ".backup-" + id,
        await readBytes(old), "application/json");
      await profile.remove(REQUEST_NAME);
    }
    try { await stageExact(profile, REQUEST_NAME, request, "application/json"); }
    catch (error) {
      if (old && !(await child(profile, REQUEST_NAME))) {
        var backup = await child(profile, REQUEST_NAME + ".backup-" + id);
        await stageExact(profile, REQUEST_NAME, await readBytes(backup), "application/json");
      }
      throw error;
    }
    say("Request " + id + " staged for the separate XPI.");
  }
  async function selectedBytes(entry) {
    var bytes = await requestBytes(new URL(entry.path, BASE).href);
    if (bytes.length !== entry.size || await sha256(bytes) !== entry.sha256) throw Error("Bundled file failed size or SHA-256 verification");
    if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46 || bytes[4] !== 1 || bytes[5] !== 1 || bytes[18] !== 40 || bytes[19] !== 0) {
      throw Error("Selected binary is not a 32-bit ARM ELF");
    }
    return bytes;
  }
  async function run(label, work) {
    stageButton.disabled = inspectButton.disabled = restoreButton.disabled = debugButton.disabled = refreshButton.disabled = true;
    say(label + "…");
    try { await work(); }
    catch (error) { fail(error); }
    finally {
      inspectButton.disabled = restoreButton.disabled = debugButton.disabled = refreshButton.disabled = false;
      stageButton.disabled = !state.entries.length;
    }
  }
  choice.onchange = updateDetail;
  async function refreshXpiLogs() {
    say("Reading XPI logs…");
    var profile = await deadline(profileInfo(), "Mozilla profile lookup");
    var events = await deadline(child(profile, "binary-runner-events.log"), "XPI log lookup");
    if (events) {
      var lines = new TextDecoder("utf-8").decode(await deadline(readBytes(events), "XPI log read"))
        .trim().split(/\r?\n/).slice(-25);
      lines.forEach(function (line) { say("XPI: " + line); });
    } else say("No XPI log yet. Install the debug XPI and restart manually.");
    var socketFile = await deadline(child(profile, "binary-runner-socket.json"), "Socket status lookup");
    if (socketFile) {
      var socket = JSON.parse(new TextDecoder("utf-8").decode(await readBytes(socketFile)));
      say("Debug socket: " + socket.state + ". " + socket.detail);
      if (socket.state === "listening") {
        var tokenFile = await child(profile, "binary-runner-debug-token");
        if (tokenFile) say("Debug AUTH token: " + new TextDecoder("utf-8").decode(await readBytes(tokenFile)).trim());
      }
    } else say("No debug socket status yet. Restart manually after installing the debug XPI.");
    var request = await deadline(child(profile, REQUEST_NAME), "XPI request lookup");
    if (request) {
      var task = JSON.parse(new TextDecoder("utf-8").decode(await readBytes(request)));
      var statusFile = await child(profile, "binary-runner-status-" + task.id + ".json");
      if (statusFile) {
        var result = JSON.parse(new TextDecoder("utf-8").decode(await readBytes(statusFile)));
        say("XPI request " + task.id + ": " + result.state + ". " + result.detail);
      } else say("XPI request " + task.id + " is waiting for startup.");
    }
  }
  refreshButton.onclick = function () { return run("Refreshing XPI logs", refreshXpiLogs); };
  inspectButton.onclick = function () { return run("Inspecting updater", async function () {
    try {
      var current = await deadline(preflight(), "Updater inspection");
      say("Updater present: " + current.length + " bytes. First-use backup " +
        (state.runner && await child(state.runner, "first-use-backup") ? "exists." : "not created yet."));
      say("Installed updater version: " + state.installedVersion + ". The apps storage API cannot read /system/kaios/updater.ver, so the stock version cannot be checked here.");
    } catch (error) { say("Updater inspection failed: " + error.message); }
    await refreshXpiLogs();
  }); };
  debugButton.onclick = function () { return run("Installing debug XPI", async function () {
    var profile = await deadline(profileInfo(), "Mozilla profile lookup");
    var id = requestId();
    await installerXpi(profile, id);
    await ensureExtensionScan(profile, id);
    say("Debug XPI installed. Restart manually, then tap Refresh XPI logs to check port 5556.");
  }); };
  stageButton.onclick = function () { return run("Staging selected binary", async function () {
    var entry = state.entries[Number(choice.value)];
    if (!entry) throw Error("Choose a bundled file");
    var bytes = await selectedBytes(entry);
    await deadline(preflight(), "Updater preflight");
    var profile = await deadline(profileInfo(), "Mozilla profile lookup");
    if (!confirm("Stage " + entry.name + " for the separate installer XPI? It will copy the binary and verify executable permissions at its next startup. The app and XPI will not restart the phone or B2G.")) return;
    var id = requestId();
    await stageRequest(profile, { id: id, action: "stage", name: entry.name,
      size: entry.size, sha256: entry.sha256 }, bytes);
    say("Manually restart once so the XPI can apply the request. Inspect its result before relying on the binary; the updater may already have started during that boot.");
    alert("Request staged. Restart manually, then inspect the XPI result.");
  }); };
  restoreButton.onclick = function () { return run("Staging first-use restore", async function () {
    await deadline(preflight(), "Updater preflight");
    var original = state.runner && await child(state.runner, "first-use-backup");
    if (!isDirectory(original)) throw Error("No first-use backup exists");
    if (!confirm("Ask the separate XPI to restore the first-use updater file at its next startup? This also replaces any pending stage request.")) return;
    var profile = await deadline(profileInfo(), "Mozilla profile lookup");
    await stageRequest(profile, { id: requestId(), action: "restore" }, null);
    say("Restore request staged. Restart the phone manually, then inspect the XPI result.");
    alert("Restore request staged. Restart manually, then inspect the result.");
  }); };

  // KaiOS 3.0: explicit focus navigation for keypad-only phones.
  function keypadControls() {
    return [inspectButton, stageButton, restoreButton, debugButton, refreshButton].filter(function (item) {
      return !item.disabled && item.getClientRects().length > 0;
    });
  }
  function focusOffset(direction) {
    var items = keypadControls();
    if (!items.length) return;
    var index = items.indexOf(document.activeElement);
    var next = index < 0 ? (direction > 0 ? 0 : items.length - 1) :
      (index + direction + items.length) % items.length;
    items[next].focus();
  }
  function changeChoice(direction) {
    if (!state.entries.length || !choice.options.length) return;
    var next = (choice.selectedIndex + direction + choice.options.length) %
      choice.options.length;
    choice.selectedIndex = next;
    updateDetail();
  }
  document.addEventListener("keydown", function (event) {
    var current = document.activeElement;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (current === choice) {
        event.preventDefault();
        inspectButton.focus();
      } else if (current && current.tagName === "BUTTON") {
        event.preventDefault();
        focusOffset(event.key === "ArrowDown" ? 1 : -1);
      }
    } else if (event.key === "ArrowLeft" && current && current.tagName === "BUTTON") {
      event.preventDefault();
      choice.focus();
    } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") &&
               current === choice) {
      event.preventDefault();
      changeChoice(event.key === "ArrowRight" ? 1 : -1);
    } else if (event.key === "Enter" &&
               current && current.tagName === "BUTTON") {
      event.preventDefault();
      if (!event.repeat && !current.disabled) current.click();
    }
  });
  // In a packaged KaiOS app there is no mouse to supply initial focus.
  inspectButton.focus();
  loadCatalog().catch(fail);
})();
