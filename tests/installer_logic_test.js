"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const code = fs.readFileSync(__dirname + "/../ostore-installer.js", "utf8");
const updateUrl = "https://garbagebuild.github.io/JScalated-Store/Apps-directory/OStore/update.webmanifest";

function stageFromGitHubPage() {
  const html = fs.readFileSync(__dirname + "/../index.html", "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "landing page script exists");
  const button = {};
  const status = { textContent: "Ready." };
  const location = { href: "https://garbagebuild.github.io/JScalated-Store/" };
  const window = { name: "" };
  class MockXHR {
    open(_method, url) { this.url = url; }
    send() {
      const file = new URL(this.url).pathname.split("/").pop();
      assert.ok(["appsmanager.js", "ostore-installer.js"].includes(file));
      this.status = 200;
      this.responseText = fs.readFileSync(__dirname + "/../" + file, "utf8");
      this.onload();
    }
  }
  vm.runInNewContext(script, {
    document: { getElementById: id => id === "stage" ? button : status },
    location, window, XMLHttpRequest: MockXHR, URL, Error,
  });
  button.onclick();
  assert.equal(location.href, "http://system.localhost/proxy.html");
  assert.ok(window.name.startsWith("<script>"));
  assert.ok(window.name.includes("https://garbagebuild.github.io/JScalated-Store/"));
  assert.ok(window.name.includes("Apps-directory/OStore/update.webmanifest"));
  assert.ok(window.name.includes("JScalatedAppsManager"));
}

async function scenario(apps, wanted, codec, available = false) {
  const calls = [];
  const nodes = {
    "jsc-store-log": { textContent: "Starting…" },
    "jsc-store-retry": {},
    "jsc-store-close": {},
  };
  let inserted = false;
  function call(kind, value) {
    calls.push([kind, String(value), value instanceof URL]);
    if (wanted === "object" && !(value instanceof URL))
      throw new TypeError("Expected URL, got string");
    if (wanted === "string" && typeof value !== "string")
      throw new TypeError("Expected string, bug got object");
    return Promise.resolve(kind === "check" ? available : { name: "OStore" });
  }
  const manager = {
    getAll: () => Promise.resolve(apps),
    installPackage: value => call("install", value),
    checkForUpdate: value => call("check", value),
    update: value => call("update", value),
  };
  if (codec) {
    manager.wrapper_payload_message = {};
    for (const [name, field] of [
      ["InstallPackageRequest", "updateUrl"],
      ["CheckForUpdateRequest", "updateUrl"],
      ["UpdateRequest", "manifestUrl"],
    ]) manager.wrapper_payload_message[name] = { encode(payload) {
      if (wanted === "object" && !(payload[field] instanceof URL))
        throw new TypeError("Expected URL, got string");
      if (wanted === "string" && typeof payload[field] !== "string")
        throw new TypeError("Expected string, bug got object");
    } };
  }
  class Client {
    connect() { return Promise.resolve(manager); }
    static errorText(error) { return String(error); }
  }
  const document = {
    currentScript: { src: "" },
    body: { appendChild() { inserted = true; } },
    createElement: () => ({ innerHTML: "", id: "", style: {} }),
    getElementById: id => id === "jscalated-store-installer"
      ? (inserted ? { style: {} } : null) : nodes[id],
  };
  vm.runInNewContext(code, { document, window: { JScalatedAppsManager: Client },
    URL, Promise, String });
  for (let i = 0; i < 8; i++) await new Promise(setImmediate);
  return calls;
}

(async () => {
  stageFromGitHubPage();
  assert.deepEqual(await scenario([], "string", true),
    [["install", updateUrl, false]]);
  assert.deepEqual(await scenario([], "object", true),
    [["install", updateUrl, true]]);
  assert.deepEqual(await scenario([], "object", false),
    [["install", updateUrl, false], ["install", updateUrl, true]]);
  const existing = { name: "OStore", updateURL: updateUrl,
    manifestURL: "http://ostore.localhost/manifest.webmanifest" };
  assert.deepEqual(await scenario([existing], "string", true, true), [
    ["check", updateUrl, false], ["update", existing.manifestURL, false],
  ]);
  assert.deepEqual(await scenario([{ name: "OStore" }], "string", true),
    [["install", updateUrl, false]]);
  assert.deepEqual(await scenario([{ name: "OStore", updateURL:
    "http://old-lan.example/Apps-directory/OStore/update.webmanifest" }], "string", true),
    [["install", updateUrl, false]]);
  console.log("OStore GitHub installer target and AppsManager URL types passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
