const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const contentPath = path.join(__dirname, '../src/moodboard-extension/content.js')
const source = fs.readFileSync(contentPath, 'utf8')

const sandbox = {
  URL,
  console,
  location: { href: 'https://example.com/page', hostname: 'example.com' },
  document: {
    addEventListener() {},
    querySelectorAll() { return [] },
    title: 'test',
  },
  chrome: { runtime: { onMessage: { addListener() {} } } },
  performance: { getEntriesByType() { return [] } },
  getComputedStyle() { return { backgroundImage: 'none' } },
}

vm.createContext(sandbox)
vm.runInContext(source + `
  globalThis.__test = {
    bestFromSrcset,
    upgradePinterestUrl,
    upgradeHuabanUrl,
    upgradeXhsUrl,
  }
`, sandbox, { filename: contentPath })

const resolver = sandbox.__test

assert.equal(
  resolver.bestFromSrcset('https://img.test/a.jpg 236w, https://img.test/b.jpg 1200w'),
  'https://img.test/b.jpg',
)
assert.equal(
  resolver.upgradePinterestUrl('https://i.pinimg.com/236x/aa/bb/file.jpg?x=1'),
  'https://i.pinimg.com/originals/aa/bb/file.jpg',
)
assert.equal(
  resolver.upgradeHuabanUrl('https://gd-hbimg.huaban.com/abc123?imageView2/1/w/800'),
  'https://gd-hbimg.huaban.com/abc123',
)
assert.equal(
  resolver.upgradeXhsUrl('https://sns-webpic-qc.xhscdn.com/20260621/abc123!nd_dft_wlteh_webp_3'),
  'https://sns-img-qc.xhscdn.com/abc123?imageView2/format/png',
)

console.log('URL resolver tests passed')
