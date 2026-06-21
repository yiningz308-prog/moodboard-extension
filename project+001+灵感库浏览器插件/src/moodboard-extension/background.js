// background.js — Personal local-first edition (v6.0.0)

const DEFAULT_LIBRARY_URL = 'http://localhost:5173'
const MAX_TRANSFER_BYTES = 80 * 1024 * 1024

function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'save-to-moodboard',
      title: '保存到个人灵感库 📌',
      contexts: ['image', 'video', 'link', 'page'],
    }, () => {
      if (chrome.runtime.lastError) console.error(chrome.runtime.lastError.message)
    })
  })
}

chrome.runtime.onInstalled.addListener(createContextMenu)
chrome.runtime.onStartup.addListener(createContextMenu)
createContextMenu()

chrome.action?.onClicked.addListener(() => {
  getOrCreateLibraryTab(true).catch(console.error)
})

async function getLibraryUrl() {
  const stored = await chrome.storage.local.get('libraryUrl')
  return stored.libraryUrl || DEFAULT_LIBRARY_URL
}

async function findLibraryTab() {
  const libraryUrl = await getLibraryUrl()
  const expected = new URL(libraryUrl)
  const tabs = await chrome.tabs.query({})
  return tabs.find(tab => {
    try {
      const value = new URL(tab.url || '')
      return value.origin === expected.origin
    } catch {
      return false
    }
  }) || null
}

async function getOrCreateLibraryTab(active = false) {
  const existing = await findLibraryTab()
  if (existing) {
    if (active && existing.id) await chrome.tabs.update(existing.id, { active: true })
    return existing
  }
  const tab = await chrome.tabs.create({ url: await getLibraryUrl(), active })
  await new Promise(resolve => {
    let finished = false
    const done = () => {
      if (finished) return
      finished = true
      chrome.tabs.onUpdated.removeListener(onUpdated)
      resolve(undefined)
    }
    const onUpdated = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') done()
    }
    chrome.tabs.onUpdated.addListener(onUpdated)
    setTimeout(done, 8000)
  })
  return tab
}

function pendingRecord(media, tab, pageUrl = '', pageTitle = '') {
  const imageUrl = media?.src || ''
  const isVideo = media?.mediaType === 'video' || /\.(mp4|webm|mov|m3u8)(\?|#|$)/i.test(imageUrl)
  const isGif = !isVideo && (media?.mediaType === 'gif' || /\.gif(\?|#|$)/i.test(imageUrl))
  return {
    imageUrl,
    pageUrl: pageUrl || tab?.url || '',
    pageTitle: pageTitle || tab?.title || '',
    mediaType: isVideo ? 'video' : (isGif ? 'gif' : 'image'),
    thumb: media?.thumb || null,
    alt: media?.alt || '',
    width: media?.width || 0,
    height: media?.height || 0,
    resolver: media?.resolver || 'browser',
    tabId: tab?.id || null,
  }
}

function storePendingAndOpen(media, tab, pageUrl = '', pageTitle = '') {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ pendingImage: pendingRecord(media, tab, pageUrl, pageTitle) }, () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
      chrome.windows.create({
        url: chrome.runtime.getURL('save.html'),
        type: 'popup',
        width: 380,
        height: 540,
        focused: true,
      }, created => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
        else resolve(created)
      })
    })
  })
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'save-to-moodboard') return
  const fallback = { src: info.srcUrl || '', mediaType: info.mediaType || 'image' }
  if (!tab?.id) {
    storePendingAndOpen(fallback, tab, info.pageUrl || '', tab?.title || '').catch(console.error)
    return
  }
  chrome.tabs.sendMessage(tab.id, { type: 'GET_LAST_IMG' }, response => {
    const media = !chrome.runtime.lastError && response?.src ? response : fallback
    storePendingAndOpen(media, tab, info.pageUrl || '', tab?.title || '').catch(console.error)
  })
})

async function fetchInSourceTab(tabId, url) {
  if (!tabId) return null
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (mediaUrl, maxBytes) => {
      try {
        const response = await fetch(mediaUrl, { credentials: 'include', cache: 'no-store', referrer: location.href })
        if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
        const declared = Number(response.headers.get('content-length') || 0)
        if (declared > maxBytes) return { ok: false, error: '文件超过 80MB' }
        const buffer = await response.arrayBuffer()
        if (buffer.byteLength > maxBytes) return { ok: false, error: '文件超过 80MB' }
        return {
          ok: true,
          bytes: Array.from(new Uint8Array(buffer)),
          mimeType: response.headers.get('content-type')?.split(';')[0] || '',
        }
      } catch (error) {
        return { ok: false, error: error?.message || String(error) }
      }
    },
    args: [url, MAX_TRANSFER_BYTES],
  })
  return results?.[0]?.result || null
}

async function fetchMedia(payload) {
  if (!payload.imageUrl) throw new Error('没有识别到媒体地址')
  if (payload.imageUrl.startsWith('blob:')) throw new Error('视频是临时 blob 地址，请在画面加载后重试')

  try {
    const response = await fetch(payload.imageUrl, { credentials: 'include', cache: 'no-store' })
    if (response.ok) {
      const declared = Number(response.headers.get('content-length') || 0)
      if (declared > MAX_TRANSFER_BYTES) throw new Error('文件超过 80MB')
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > MAX_TRANSFER_BYTES) throw new Error('文件超过 80MB')
      return {
        bytes: Array.from(new Uint8Array(buffer)),
        mimeType: response.headers.get('content-type')?.split(';')[0] || '',
      }
    }
  } catch {}

  const pageResult = await fetchInSourceTab(payload.tabId, payload.imageUrl).catch(() => null)
  if (pageResult?.ok && pageResult.bytes?.length) {
    return { bytes: pageResult.bytes, mimeType: pageResult.mimeType || '' }
  }

  if (payload.tabId) {
    const contentResult = await chrome.tabs.sendMessage(payload.tabId, { type: 'FETCH_IN_PAGE', url: payload.imageUrl }).catch(() => null)
    if (contentResult?.ok && contentResult.bytes?.length) {
      return { bytes: contentResult.bytes, mimeType: contentResult.mime || '' }
    }
  }
  throw new Error('来源站拒绝读取该文件，请保持原页打开后重试')
}

async function sendToLibrary(payload) {
  const media = await fetchMedia(payload)
  const tab = await getOrCreateLibraryTab(false)
  if (!tab?.id) throw new Error('无法打开个人灵感库')
  const message = {
    type: 'IMPORT_TO_LIBRARY',
    payload: {
      bytes: media.bytes,
      mimeType: media.mimeType || (payload.mediaType === 'video' ? 'video/mp4' : 'image/jpeg'),
      title: payload.title || payload.pageTitle || payload.alt || '来自浏览器的灵感',
      sourceUrl: payload.pageUrl || '',
      mediaType: payload.mediaType || 'image',
      tags: payload.tags ? payload.tags.split(',').map(tag => tag.trim()).filter(Boolean) : [],
      description: payload.description || '',
    },
  }
  let response = await chrome.tabs.sendMessage(tab.id, message).catch(() => null)
  if (!response?.ok) {
    await chrome.tabs.reload(tab.id)
    await new Promise(resolve => setTimeout(resolve, 1200))
    response = await chrome.tabs.sendMessage(tab.id, message).catch(() => null)
  }
  if (!response?.ok) throw new Error(response?.error || '个人灵感库页面未就绪，请打开网页后重试')
  return { ok: true }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OPEN_SAVE_POPUP') {
    storePendingAndOpen(message.payload, sender.tab, message.pageUrl, message.pageTitle)
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error.message }))
    return true
  }
  if (message.type === 'OPEN_LIBRARY') {
    getOrCreateLibraryTab(true)
      .then(tab => sendResponse({ ok: Boolean(tab), url: tab?.url }))
      .catch(error => sendResponse({ ok: false, error: error.message }))
    return true
  }
  if (message.type === 'GET_LIBRARY_STATUS') {
    Promise.all([findLibraryTab(), getLibraryUrl()])
      .then(([tab, url]) => sendResponse({ ok: true, open: Boolean(tab), url }))
      .catch(error => sendResponse({ ok: false, error: error.message }))
    return true
  }
  if (message.type === 'FETCH_PREVIEW_BYTES') {
    fetchMedia({ imageUrl: message.payload.url, tabId: message.payload.tabId })
      .then(result => sendResponse({ ok: true, bytes: result.bytes, mime: result.mimeType }))
      .catch(error => sendResponse({ ok: false, error: error.message }))
    return true
  }
  if (message.type === 'SAVE_IMAGE') {
    sendToLibrary(message.payload)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: error.message || String(error) }))
    return true
  }
})
