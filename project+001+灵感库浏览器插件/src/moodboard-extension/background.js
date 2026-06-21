// background.js — Service Worker (v5.3.1)
// 核心修复：所有 Appwrite API 调用通过注入灵感板页面来执行，复用页面 Cookie

const APP_ORIGIN  = 'https://moodboard-v2.frontend-cloud.corp.kuaishou.com'
const API_BASE    = 'https://frontend-cloud.corp.kuaishou.com/v1'
const PROJECT_ID  = 'moodboard'
const DATABASE_ID = 'moodboard_db'
const TABLE_ID    = 'images'
const BUCKET_ID   = 'moodboard_images'

// ── 注册右键菜单 ────────────────────────────────────────────────────
function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'save-to-moodboard',
      title: '保存到灵感库 📌',
      // Pinterest/花瓣/小红书常在媒体上覆盖链接或按钮。
      // link/page 交给 content script 继续识别右键位置下的真实媒体。
      contexts: ['image', 'video', 'link', 'page'],
    }, () => {
      if (chrome.runtime.lastError) {
        console.error('[moodboard] 右键菜单创建失败:', chrome.runtime.lastError.message)
      }
    })
  })
}
chrome.runtime.onInstalled.addListener(createContextMenu)
chrome.runtime.onStartup.addListener(createContextMenu)
// 扩展重载后 Service Worker 会直接执行顶层代码，立即补齐菜单。
createContextMenu()

// ── 右键菜单点击 ────────────────────────────────────────────────────
function storePendingAndOpen(media, tab, pageUrl = '', pageTitle = '') {
  const imageUrl = media?.src || ''
  const isVideo = media?.mediaType === 'video' || /\.(mp4|webm|mov|m3u8)(\?|#|$)/i.test(imageUrl)
  const isGif = !isVideo && (media?.mediaType === 'gif' || /\.gif(\?|#|$)/i.test(imageUrl))
  const pendingImage = {
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

  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ pendingImage }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }
      chrome.windows.create({
        url: chrome.runtime.getURL('save.html'),
        type: 'popup',
        width: 360,
        height: 520,
        focused: true,
      }, (createdWindow) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
        else resolve(createdWindow)
      })
    })
  })
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'save-to-moodboard') return

  const browserMediaUrl = info.srcUrl || ''

  // 先尝试从 content script 拿截帧缩略图（视频专用）和更精确的 URL
  const tryGetMedia = (cb) => {
    if (!tab?.id) return cb({ src: browserMediaUrl })
    chrome.tabs.sendMessage(tab.id, { type: 'GET_LAST_IMG' }, res => {
      if (chrome.runtime.lastError || !res) return cb({ src: browserMediaUrl })
      cb(res)
    })
  }

  tryGetMedia((media) => {
    storePendingAndOpen(
      media?.src ? media : { ...media, src: browserMediaUrl, mediaType: info.mediaType },
      tab,
      info.pageUrl || '',
      tab?.title || '',
    ).catch(error => console.error('[moodboard] 打开保存窗口失败:', error))
  })
})

// ── 消息路由 ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OPEN_SAVE_POPUP') {
    storePendingAndOpen(
      msg.payload,
      sender.tab,
      msg.pageUrl || sender.tab?.url || '',
      msg.pageTitle || sender.tab?.title || '',
    )
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error.message || String(error) }))
    return true
  }

  if (msg.type === 'GET_AUTH') {
    runGetAuth()
      .then(user => sendResponse(user))
      .catch(() => sendResponse(null))
    return true
  }

  if (msg.type === 'GET_AUTH_DEBUG') {
    // 用 keepAlive ping 防止 Service Worker 在处理期间休眠
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 1000)
    runGetAuthDebug()
      .then(result => { clearInterval(keepAlive); sendResponse(result) })
      .catch(e => { clearInterval(keepAlive); sendResponse({ user: null, debug: 'error: ' + e.message }) })
    return true
  }

  if (msg.type === 'FETCH_PREVIEW_BYTES') {
    // 在 SW 里下载媒体文件，返回 base64 给 popup 渲染（绕过 CORS/CSP）
    const { url } = msg.payload
    fetch(url, { headers: { 'Referer': '' } })
      .then(async res => {
        if (!res.ok) { sendResponse({ ok: false }); return }
        const mime = res.headers.get('content-type')?.split(';')[0] || 'video/mp4'
        const buf = await res.arrayBuffer()
        const bytes = Array.from(new Uint8Array(buf))
        sendResponse({ ok: true, bytes, mime })
      })
      .catch(() => sendResponse({ ok: false }))
    return true
  }

  if (msg.type === 'SAVE_IMAGE') {
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 1000)
    handleSaveImage(msg.payload)
      .then(result => { clearInterval(keepAlive); sendResponse(result) })
      .catch(err => { clearInterval(keepAlive); sendResponse({ ok: false, error: err.message || String(err) }) })
    return true
  }

// ── 找到或创建灵感板页面 Tab ────────────────────────────────────────
})

async function getOrCreateAppTab() {
  const tabs = await chrome.tabs.query({ url: APP_ORIGIN + '/*' })
  if (tabs.length > 0) return tabs[0]

  // 没有开着的灵感板页面 → 后台静默打开
  const tab = await chrome.tabs.create({ url: APP_ORIGIN, active: false })
  await new Promise((resolve) => {
    function onUpdated(tabId, info) {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated)
    setTimeout(resolve, 4000) // 超时保底缩短到 4s
  })
  return tab
}

// ── 通用：在灵感板页面注入并执行函数 ─────────────────────────────────
async function injectAndRun(func, args = []) {
  const tab = await getOrCreateAppTab()
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func,
    args,
    world: 'MAIN',
  })
  const result = results?.[0]?.result
  if (result && result.__error) throw new Error(result.__error)
  return result
}

// 在右键来源页的 MAIN world 中读取媒体。
// 这一层会携带来源站的 Cookie/Referer，主要用于小红书等防盗链资源。
async function fetchBytesFromSourceTab(tabId, url) {
  if (!tabId || !url) return null
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async function (mediaUrl) {
      try {
        const res = await fetch(mediaUrl, {
          credentials: 'include',
          cache: 'no-store',
          referrer: location.href,
        })
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
        const size = Number(res.headers.get('content-length') || 0)
        if (size > 80 * 1024 * 1024) {
          return { ok: false, error: '文件超过 80MB，请改用服务端转存' }
        }
        const buf = await res.arrayBuffer()
        if (buf.byteLength > 80 * 1024 * 1024) {
          return { ok: false, error: '文件超过 80MB，请改用服务端转存' }
        }
        return {
          ok: true,
          bytes: Array.from(new Uint8Array(buf)),
          mime: res.headers.get('content-type')?.split(';')[0] || '',
        }
      } catch (e) {
        return { ok: false, error: e?.message || String(e) }
      }
    },
    args: [url],
  })
  return results?.[0]?.result || null
}

// ── 云函数服务端转存：不经过客户端下载，彻底绕开 CORS ────────────
// ── GET_AUTH：在页面里用相对路径 /v1/account（必须相对路径，Cookie 才能带上）
async function runGetAuth() {
  return injectAndRun(async function (projectId) {
    try {
      const res = await fetch('/v1/account', {
        credentials: 'include',
        headers: { 'X-Appwrite-Project': projectId },
      })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  }, [PROJECT_ID])
}

// ── SAVE_IMAGE 主流程 ───────────────────────────────────────────────

async function handleSaveImage(payload) {
  const { imageUrl, pageUrl, title, tags, description, mediaType } = payload

  if (!imageUrl) {
    throw new Error('没有识别到图片或视频，请把鼠标放在媒体画面上再右键')
  }

  // blob: URL 是页面临时对象，离开页面后失效
  // 但如果 payload.bytes 已经有内容（悬浮按钮在页面上下文 fetch 好了），直接放行
  if (imageUrl && imageUrl.startsWith('blob:') && !(payload.bytes && payload.bytes.length > 0)) {
    throw new Error('视频链接为临时地址，无法直接保存。请使用「上传视频」功能，将视频文件直接上传到灵感库。')
  }

  // Step 1: 确认登录
  const user = await runGetAuth()
  if (!user || !user.$id) throw new Error('未登录，请先在灵感板网站登录后重试')

  let storedUrl = imageUrl

  // Step 2: 下载文件并上传到 Storage
  if (imageUrl && imageUrl.startsWith('http')) {
    let downloadOk = false
    let uint8Array = null
    let mimeType = mediaType === 'video' ? 'video/mp4' : 'image/jpeg'

    // 尝试 0: 悬浮按钮已在页面上下文 fetch 好，直接用（最优先）
    if (payload.bytes && payload.bytes.length > 0) {
      uint8Array = payload.bytes
      downloadOk = true
    }
    // 尝试 1: Service Worker 直接 fetch
    if (!downloadOk) try {
      const imgRes = await fetch(imageUrl, {
        credentials: 'include',
        cache: 'no-store',
        referrer: pageUrl || undefined,
      })
      if (imgRes.ok) {
        mimeType = imgRes.headers.get('content-type')?.split(';')[0] || mimeType
        const arrayBuffer = await imgRes.arrayBuffer()
        uint8Array = Array.from(new Uint8Array(arrayBuffer))
        downloadOk = true
      }
    } catch { /* SW fetch 失败（CORS），尝试其他方式 */ }

    // 尝试 2: 在来源 Tab 的 MAIN world 中读取。
    if (!downloadOk && payload.tabId) {
      try {
        const pageRes = await fetchBytesFromSourceTab(payload.tabId, imageUrl)
        if (pageRes?.ok && pageRes?.bytes?.length > 0) {
          uint8Array = pageRes.bytes
          mimeType = pageRes.mime || mimeType
          downloadOk = true
        }
      } catch { /* 来源页下载失败，继续降级 */ }
    }

    // 尝试 3: content script 后备通道。
    if (!downloadOk && payload.tabId) {
      try {
        const pageRes = await chrome.tabs.sendMessage(payload.tabId, { type: 'FETCH_IN_PAGE', url: imageUrl })
        if (pageRes?.ok && pageRes?.bytes?.length > 0) {
          uint8Array = pageRes.bytes
          mimeType = pageRes.mime || mimeType
          downloadOk = true
        }
      } catch { /* content script 下载也失败 */ }
    }

    // 尝试 4: 通过 injectAndRun 在 moodboard 页面上下文里下载
    if (!downloadOk) {
      try {
        const injectRes = await injectAndRun(
          async function (url) {
            try {
              const res = await fetch(url, { mode: 'cors' })
              if (!res.ok) return { __error: `fetch failed: ${res.status}` }
              const buf = await res.arrayBuffer()
              return { bytes: Array.from(new Uint8Array(buf)), mime: res.headers.get('content-type')?.split(';')[0] || '' }
            } catch (e) {
              // 最后兜底：no-cors 模式（只能拿 opaque response，无法读数据）
              try {
                const res = await fetch(url, { mode: 'no-cors' })
                return { __error: 'no-cors: cannot read data', opaque: true }
              } catch (e2) {
                return { __error: e.message }
              }
            }
          },
          [imageUrl]
        )
        if (injectRes?.bytes?.length > 0 && !injectRes.__error) {
          uint8Array = injectRes.bytes
          mimeType = injectRes.mime || mimeType
          downloadOk = true
        }
      } catch { /* 所有下载尝试都失败了 */ }
    }

    // 上传到 Storage
    if (downloadOk && uint8Array) {
      const result = await injectAndRun(
        async function (bytes, mimeType, userId, projectId, bucketId) {
          try {
            const blob = new Blob([new Uint8Array(bytes)], { type: mimeType })
            const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm' }
            const ext = extMap[mimeType] || (mimeType.split('/')[1] || 'jpg')
            const name = `ext_${Date.now()}.${ext}`

            const form = new FormData()
            form.append('fileId', 'unique()')
            form.append('file', blob, name)
            form.append('permissions[]', 'read("any")')
            form.append('permissions[]', `delete("user:${userId}")`)

            const up = await fetch(`/v1/storage/buckets/${bucketId}/files`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'X-Appwrite-Project': projectId },
              body: form,
            })
            if (!up.ok) {
              const err = await up.json().catch(() => ({}))
              return { __error: `上传失败 ${up.status}: ${err.message || ''}` }
            }
            const file = await up.json()
            return `/v1/storage/buckets/${bucketId}/files/${file.$id}/view?project=${projectId}`
          } catch (e) {
            return { __error: e.message }
          }
        },
        [uint8Array, mimeType, user.$id, PROJECT_ID, BUCKET_ID]
      )

      if (result && typeof result === 'string') {
        storedUrl = APP_ORIGIN + result
      }
    }

    if (!downloadOk) {
      throw new Error('已找到媒体地址，但来源站拒绝下载。请保持来源页打开并重试')
    }
    if (storedUrl === imageUrl) {
      throw new Error('媒体已下载，但上传灵感库失败，请重试')
    }
  }

  // 根据文件 URL 或传入类型判断 media_type
  const detectedType = mediaType || (
    storedUrl.match(/\.mp4/i) ? 'video' :
    storedUrl.match(/\.gif/i) ? 'gif' : 'image'
  )

  // Step 3: 写入数据库
  await injectAndRun(
    async function (docData, projectId, databaseId, tableId) {
      const res = await fetch(
        `/v1/databases/${databaseId}/collections/${tableId}/documents`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'X-Appwrite-Project': projectId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            documentId: 'unique()',
            data: docData,
            permissions: [
              'read("any")',
              `update("user:${docData.user_id}")`,
              `delete("user:${docData.user_id}")`,
            ],
          }),
        }
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        return { __error: err.message || `保存失败 (${res.status})` }
      }
      return { ok: true }
    },
    [
      {
        title: title || '来自浏览器的灵感',
        image_url: storedUrl,
        source_url: pageUrl || null,
        description: description || null,
        tags: tags || null,
        media_type: detectedType,
        user_id: user.$id,
        user_name: user.name || user.email || user.$id,
        created_at: new Date().toISOString(),
      },
      PROJECT_ID, DATABASE_ID, TABLE_ID,
    ]
  )

  return { ok: true }
}

// ── GET_AUTH_DEBUG：带详细日志的登录检测 ───────────────────────────
async function runGetAuthDebug() {
  const steps = []

  // Step A: 找 Tab
  let tab = null
  try {
    const tabs = await chrome.tabs.query({ url: APP_ORIGIN + '/*' })
    if (tabs.length > 0) {
      tab = tabs[0]
      steps.push(`找到灵感板tab: id=${tab.id}`)
    } else {
      steps.push('未找到灵感板tab，尝试后台打开')
      tab = await getOrCreateAppTab()
      steps.push(`后台打开tab: id=${tab?.id}`)
    }
  } catch (e) {
    steps.push('找tab失败: ' + e.message)
    return { user: null, debug: steps.join(' | ') }
  }

  // Step B: 注入脚本（使用相对路径）
  let injectResult = null
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async function (projectId) {
        const steps2 = []
        try {
          steps2.push('注入成功,origin=' + location.origin)
          const res = await fetch('/v1/account', {
            credentials: 'include',
            headers: { 'X-Appwrite-Project': projectId },
          })
          steps2.push(`fetch状态=${res.status}`)
          if (!res.ok) {
            const body = await res.text().catch(() => '')
            steps2.push('body=' + body.slice(0, 80))
            return { user: null, steps: steps2 }
          }
          const user = await res.json()
          steps2.push('登录成功 id=' + user.$id)
          return { user, steps: steps2 }
        } catch (e) {
          steps2.push('注入内部异常: ' + e.message)
          return { user: null, steps: steps2 }
        }
      },
      args: [PROJECT_ID],
      world: 'MAIN',
    })
    injectResult = results?.[0]?.result
    steps.push('注入返回: ' + JSON.stringify(injectResult?.steps))
  } catch (e) {
    steps.push('executeScript失败: ' + e.message)
    return { user: null, debug: steps.join(' | ') }
  }

  return {
    user: injectResult?.user || null,
    debug: steps.join(' | '),
  }
}
