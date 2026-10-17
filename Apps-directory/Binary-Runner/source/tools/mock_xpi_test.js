// Exercise the generated installer against an in-memory XPCOM filesystem.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'dist',
  'binary-installer-api.generated.js'), 'utf8');
const catalog = require('../payloads/catalog.json');
const selected = fs.readFileSync(path.join(__dirname, '..', catalog[0].path));
const old = Buffer.from('original updater bytes');
const profile = '/data/b2g/mozilla/test.default';
const targetPath = '/data/local/service/updater/updater-daemon';
const root = '/data/local/service/updater';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function start({ failFinalRestore = false, alreadyInstalled = false, noRequest = false } = {}) {
  const entries = new Map();
  const launches = [];
  const listeners = [];
  const pumps = [];
  let remainingFinalRestoreFailures = failFinalRestore ? 1 : 0;
  const requestId = '0123456789abcdef';
  function add(name, bytes, mode = 0o644, type = 'file') {
    entries.set(name, { bytes: Buffer.from(bytes), mode, type });
  }
  for (const dir of ['/data', '/data/local', '/data/local/service', root,
    '/data/b2g', '/data/b2g/mozilla', profile, profile + '/extensions', '/system', '/system/bin']) {
    add(dir, [], 0o755, 'dir');
  }
  add(root + '/init', []);
  add('/system/bin/sh', []);
  add(profile + '/extensions/jscalated-adb@local.xpi', 'existing ADB extension');
  add(targetPath, alreadyInstalled ? selected : old, alreadyInstalled ? 0o644 : 0o755);
  if (alreadyInstalled) {
    add(root + '/jscalated-runner', [], 0o700, 'dir');
    add(root + '/jscalated-runner/first-use-backup', [], 0o700, 'dir');
    add(root + '/jscalated-runner/first-use-backup/updater-daemon', old, 0o644);
  }
  if (!noRequest) {
    add(profile + '/binary-runner-payload-' + requestId + '.bin', selected);
    add(profile + '/binary-runner-request.json', JSON.stringify({ id: requestId,
      action: 'stage', name: catalog[0].name, size: selected.length,
      sha256: hash(selected) }));
  }

  class File {
    constructor(name) { this.path = name; }
    get node() { return entries.get(this.path); }
    exists() { return entries.has(this.path); }
    isSymlink() { return false; }
    isFile() { return !!this.node && this.node.type === 'file'; }
    isDirectory() { return !!this.node && this.node.type === 'dir'; }
    get fileSize() { return this.node.bytes.length; }
    get permissions() { return this.node.mode; }
    set permissions(value) { this.node.mode = value; }
    initWithPath(value) { this.path = value; }
    create(type, mode) {
      assert(!this.exists(), 'create must not overwrite');
      assert(entries.get(path.posix.dirname(this.path))?.type === 'dir');
      add(this.path, [], mode, type === 1 ? 'dir' : 'file');
    }
    copyTo(parent, name) {
      const dest = parent.path + '/' + name;
      assert(!entries.has(dest), 'copy must not overwrite');
      const node = this.node;
      add(dest, node.bytes, node.mode, node.type);
    }
    moveTo(parent, name) {
      const dest = parent.path + '/' + name;
      assert.equal(path.posix.dirname(this.path), path.posix.dirname(dest),
        'target replacement should be on one filesystem');
      entries.set(dest, this.node);
      entries.delete(this.path);
      this.path = dest;
    }
    remove() { entries.delete(this.path); }
  }
  const factories = {
    '@mozilla.org/file/local;1': () => new File(''),
    '@mozilla.org/network/file-input-stream;1': () => ({
      init(file) { this.file = file; }, close() {},
    }),
    '@mozilla.org/intl/converter-input-stream;1': () => ({
      init(input) { this.input = input; },
      readString(_length, result) { result.value = this.input.file.node.bytes.toString('utf8'); },
      close() {},
    }),
    '@mozilla.org/security/hash;1': () => ({
      SHA256: 2, init() { this.hash = crypto.createHash('sha256'); },
      updateFromStream(input) { this.hash.update(input.file.node.bytes); },
      finish() { return this.hash.digest('latin1'); },
    }),
    '@mozilla.org/network/file-output-stream;1': () => ({
      init(file, flags) {
        this.file = file;
        this.append = !!(flags & 0x10);
        if (!this.append || !file.exists()) add(file.path, [], 0o600);
      },
      write(value, length) {
        this.file.node.bytes = Buffer.concat([this.file.node.bytes, Buffer.from(value, 'ascii')]);
        return length;
      },
      close() {},
    }),
    '@mozilla.org/network/server-socket;1': () => ({
      init(port, loopback) { assert.equal(port, 5556); assert.equal(loopback, true); },
      asyncListen(listener) { listeners.push(listener); }, close() {},
    }),
    '@mozilla.org/network/input-stream-pump;1': () => ({
      init() {}, asyncRead(listener) { this.listener = listener; pumps.push(this); listener.onStartRequest(); },
    }),
    '@mozilla.org/scriptableinputstream;1': () => ({
      init(stream) { this.stream = stream; }, read() { return this.stream.data; },
    }),
    '@mozilla.org/timer;1': () => ({ initWithCallback() {}, cancel() {} }),
    '@mozilla.org/uuid-generator;1': () => ({
      generateUUID() { return { toString() { return '{01234567-89ab-4cde-8123-456789abcdef}'; } }; },
    }),
    '@mozilla.org/process/util;1': () => ({
      init(file) { assert.equal(file.path, '/system/bin/sh'); },
      run(_blocking, args) {
        assert.equal(args[0], '-c');
        assert.match(args[1], /^restorecon '\/data\/local\/service\/updater\/[A-Za-z0-9._-]+'$/);
        launches.push(args[1]);
        this.exitValue = remainingFinalRestoreFailures > 0 && args[1] ===
          "restorecon '/data/local/service/updater/updater-daemon'" ? 1 : 0;
        if (this.exitValue) remainingFinalRestoreFailures--;
      },
      runAsync(args, _count, observer) {
        assert.equal(args[0], '-c');
        const output = /> '([^']+)'$/.exec(args[1]);
        assert(output, 'debug command output must be confined to the profile');
        assert(output[1].startsWith(profile + '/binary-runner-cmd-'));
        launches.push('debug command');
        add(output[1], 'mock command output\n', 0o600);
        this.exitValue = 0;
        observer.observe(this, 'process-finished');
      },
    }),
  };
  const Cc = new Proxy({}, { get(_target, key) {
    assert(factories[key], 'unexpected XPCOM class: ' + key);
    return { createInstance: factories[key], getService: factories[key] };
  } });
  const context = { Cc, Ci: { nsIFile: { DIRECTORY_TYPE: 1, NORMAL_FILE_TYPE: 0 },
    nsITransport: { OPEN_BLOCKING: 1 }, nsITimer: { TYPE_ONE_SHOT: 0 } },
    ChromeUtils: { import() { return { Services: {
      dirsvc: { get() { return new File(profile); } },
    } }; } },
    ExtensionAPI: class {}, console, Error, Set, Date };
  vm.createContext(context);
  vm.runInContext(source, context);
  const extension = new context.binaryRunnerInstaller();
  extension.onStartup();
  return { entries, launches, extension, requestId, listeners, pumps };
}

{
  const state = start({ noRequest: true });
  assert.equal(state.listeners.length, 1, 'debug socket must start without a binary request');
  assert.equal(state.launches.length, 0, 'boot alone must not launch a command');
}
{
  const state = start();
  assert.deepEqual(state.entries.get(targetPath).bytes, selected);
  assert.equal(state.entries.get(targetPath).mode, 0o755);
  assert.deepEqual(state.entries.get(root + '/jscalated-runner/first-use-backup/updater-daemon').bytes, old);
  assert.equal(state.entries.get(profile + '/extensions/jscalated-adb@local.xpi').bytes.toString(),
    'existing ADB extension');
  const status = JSON.parse(state.entries.get(profile + '/binary-runner-status-' + state.requestId + '.json').bytes);
  assert.equal(status.state, 'success');
  assert.equal(JSON.parse(state.entries.get(profile + '/binary-runner-socket.json').bytes).state,
    'listening');
  assert.equal(state.listeners.length, 1);
  const replies = [];
  const transport = {
    openInputStream() { return {}; },
    openOutputStream() { return { write(value) { replies.push(value); return value.length; } }; },
    close() {},
  };
  state.listeners[0].onSocketAccepted(null, transport);
  const feed = value => state.pumps[0].listener.onDataAvailable(null, { data: value }, 0, value.length);
  const beforeAuth = state.launches.length;
  feed('RUN id\n');
  assert.equal(state.launches.length, beforeAuth, 'unauthenticated commands must not execute');
  const authorized = start();
  const authReplies = [];
  authorized.listeners[0].onSocketAccepted(null, {
    openInputStream() { return {}; },
    openOutputStream() { return { write(value) { authReplies.push(value); return value.length; } }; },
    close() {},
  });
  const authFeed = value => authorized.pumps[0].listener.onDataAvailable(null, { data: value }, 0, value.length);
  authFeed('AUTH 0123456789ab4cde8123456789abcdef\n');
  authFeed('RUN id\n');
  assert(authReplies.join('').includes('mock command output'));
  assert(authorized.launches.includes('debug command'));
  const launchCount = state.launches.length;
  state.extension.onStartup();
  assert.equal(state.launches.length, launchCount, 'the XPI must be one shot');
}
{
  const state = start({ alreadyInstalled: true });
  assert.deepEqual(state.entries.get(targetPath).bytes, selected);
  assert.equal(state.entries.get(targetPath).mode, 0o755);
}
{
  const state = start({ failFinalRestore: true });
  assert.deepEqual(state.entries.get(targetPath).bytes, old);
  const status = JSON.parse(state.entries.get(profile + '/binary-runner-status-' + state.requestId + '.json').bytes);
  assert.equal(status.state, 'failed');
  assert.match(status.detail, /previous file restored/);
}
console.log('XPI stage, mode, ADB preservation, socket authentication, command, one shot, and rollback checks passed');
