const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const backgroundPath = path.join(__dirname, '../src/moodboard-extension/background.js')
const source = fs.readFileSync(backgroundPath, 'utf8')
const menus = []
const listeners = []
const event = { addListener(fn) { listeners.push(fn) } }

const chrome = {
  contextMenus: {
    removeAll(callback) { callback() },
    create(options, callback) { menus.push(options); callback?.() },
    onClicked: event,
  },
  runtime: {
    lastError: null,
    onInstalled: event,
    onStartup: event,
    onMessage: event,
    getURL(value) { return `chrome-extension://test/${value}` },
    getPlatformInfo(callback) { callback({}) },
  },
  tabs: { onUpdated: { addListener() {}, removeListener() {} } },
}

vm.runInNewContext(source, {
  chrome,
  console,
  fetch: async () => { throw new Error('not used in load test') },
  setInterval,
  clearInterval,
  setTimeout,
  Uint8Array,
  Blob,
  FormData,
  URL,
}, { filename: backgroundPath })

assert.equal(menus.length, 1)
assert.equal(menus[0].id, 'save-to-moodboard')
assert.deepEqual(Array.from(menus[0].contexts), ['image', 'video', 'link', 'page'])
assert.ok(listeners.length >= 4)

console.log('Background load and context menu tests passed')
