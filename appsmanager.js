(function (global) {
  "use strict";

  var ROOT = "http://127.0.0.1/api/v1/";
  var scripts = ["shared/core.js", "shared/session.js", "apps/service.js"];
  var scriptPromise = null;

  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      var finished = false;
      var timer = setTimeout(function () { finish(new Error("Timed out loading " + url)); }, 12000);
      function finish(error) {
        if (finished) { return; }
        finished = true;
        clearTimeout(timer);
        if (error) { reject(error); } else { resolve(); }
      }
      script.onload = function () { finish(); };
      script.onerror = function () { finish(new Error("Could not load " + url)); };
      script.src = url;
      (document.head || document.documentElement).appendChild(script);
    });
  }

  function loadApi() {
    if (!scriptPromise) {
      scriptPromise = scripts.reduce(function (previous, path) {
        return previous.then(function () { return loadScript(ROOT + path); });
      }, Promise.resolve()).catch(function (error) {
        scriptPromise = null;
        throw error;
      });
    }
    return scriptPromise;
  }

  function token() {
    try {
      if (navigator.b2g && navigator.b2g.externalapi &&
          typeof navigator.b2g.externalapi.getToken === "function") {
        return Promise.resolve(navigator.b2g.externalapi.getToken());
      }
    } catch (ignore) {}
    return Promise.resolve("secrettoken");
  }

  function errorText(error) {
    var value = error && error.value;
    var code = typeof value === "number" ? value :
      (value && typeof value.error === "number" ? value.error : null);
    var names = global.lib_apps && global.lib_apps.AppsServiceError;
    var name = "";
    if (code !== null && names) {
      Object.keys(names).some(function (key) {
        if (names[key] === code) { name = key; return true; }
        return false;
      });
    }
    return [name || (code !== null ? "code " + code : ""),
      error && error.reason, error && error.message].filter(Boolean).join(": ") || String(error);
  }

  function callUrlMethod(manager, method, url, rest) {
    var args = rest || [];
    var address = new URL(String(url)).href;
    var requests = {
      installPackage: ["InstallPackageRequest", "updateUrl"],
      checkForUpdate: ["CheckForUpdateRequest", "updateUrl"],
      update: ["UpdateRequest", "manifestUrl"],
      setEnabled: ["SetEnabledRequest", "manifestUrl"]
    };
    var request = requests[method];
    var codec = request && manager.wrapper_payload_message &&
      manager.wrapper_payload_message[request[0]];
    var extra = method === "checkForUpdate" ? { appsOption: args[0] } :
      (method === "setEnabled" ? { status: args[0] } : {});
    function accepts(value) {
      if (!codec || typeof codec.encode !== "function") { return false; }
      var payload = {};
      payload[request[1]] = value;
      Object.keys(extra).forEach(function (key) { payload[key] = extra[key]; });
      try { codec.encode(payload); return true; }
      catch (_) { return false; }
    }
    function call(value) {
      return Promise.resolve().then(function () {
        return manager[method].apply(manager, [value].concat(args));
      });
    }
    // The generated encoder is local: probing it cannot start an install.
    var first = codec && !accepts(address) && accepts(new URL(address)) ?
      new URL(address) : address;
    return call(first).catch(function (error) {
      var message = String((error && error.message) || error || "");
      if (typeof first === "string" &&
          /Expected\s+URL\s*,\s*(?:bug\s+|but\s+)?got\s+string/i.test(message)) {
        return call(new URL(address));
      }
      if (typeof first !== "string" &&
          /Expected\s+string\s*,\s*(?:bug\s+|but\s+)?got\s+(?:object|URL)/i.test(message)) {
        return call(address);
      }
      throw error;
    });
  }

  function Client(log) {
    this.log = log || function () {};
    this.manager = null;
    this.session = null;
    this.pending = null;
    this.onEvent = null;
  }

  Client.prototype.connect = function () {
    var self = this;
    if (self.manager) { return Promise.resolve(self.manager); }
    if (self.pending) { return self.pending; }
    self.pending = loadApi().then(token).then(function (sessionToken) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () { fail(new Error("AppsManager connection timed out")); }, 12000);
        function fail(error) {
          if (settled) { return; }
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
        var state = {
          onsessionconnected: function () {
            global.lib_apps.AppsManager.get(self.session).then(function (manager) {
              if (settled) { return; }
              settled = true;
              clearTimeout(timer);
              self.manager = manager;
              ["APP_INSTALLING_EVENT", "APP_INSTALLED_EVENT", "APP_DOWNLOAD_FAILED_EVENT",
                "APP_UPDATING_EVENT", "APP_UPDATED_EVENT"].forEach(function (name) {
                if (manager[name] === undefined || !manager.addEventListener) { return; }
                manager.addEventListener(manager[name], function (event) {
                  if (self.onEvent) { self.onEvent(name, event); }
                });
              });
              resolve(manager);
            }, fail);
          },
          onsessiondisconnected: function () {
            self.manager = null;
            self.session = null;
            self.pending = null;
            self.log("AppsManager disconnected");
          }
        };
        try {
          self.session = new global.lib_session.Session();
          self.session.open("websocket", "localhost", sessionToken || "secrettoken", state, true);
        } catch (error) { fail(error); }
      });
    }).catch(function (error) {
      self.pending = null;
      throw error;
    });
    return self.pending;
  };

  Client.errorText = errorText;
  Client.callUrlMethod = callUrlMethod;
  global.JScalatedAppsManager = Client;
}(window));
