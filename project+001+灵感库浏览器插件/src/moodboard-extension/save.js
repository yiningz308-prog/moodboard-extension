// save.js — 个人本地库版本

const ALL_TAGS = ['运营', 'IP', '品牌', '包装', 'H5', '插画', '3D', '渲染', '排版', '图形', '标识', '科技感', '未来感', '趣味感']

let selectedTags = []
let pendingImage = null

// ── UI 状态切换 ──────────────────────────────────────────────────────
function showMain(userName) {
  document.getElementById('mainForm').style.display = 'flex'
  document.getElementById('footer').style.display = 'flex'
  document.getElementById('loginHint').style.display = 'none'
  document.getElementById('userLabel').textContent = userName
}

function showError(msg) {
  const el = document.getElementById('errorBar')
  if (!el) return
  el.textContent = msg
  el.style.display = msg ? 'block' : 'none'
}

// ── 标签渲染 ────────────────────────────────────────────────────────
function renderTags() {
  const container = document.getElementById('tagList')
  container.innerHTML = ''
  ALL_TAGS.forEach((tag) => {
    const btn = document.createElement('button')
    btn.className = 'tag' + (selectedTags.includes(tag) ? ' active' : '')
    btn.textContent = tag
    btn.addEventListener('click', () => {
      selectedTags = selectedTags.includes(tag)
        ? selectedTags.filter(t => t !== tag)
        : [...selectedTags, tag]
      renderTags()
    })
    container.appendChild(btn)
  })
}

// ── 向 background 发消息（带超时） ──────────────────────────────────
function sendMsg(type, payload, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    try {
      chrome.runtime.sendMessage({ type, payload }, (response) => {
        clearTimeout(timer)
        if (chrome.runtime.lastError) {
          resolve(null)
        } else {
          resolve(response)
        }
      })
    } catch (e) {
      clearTimeout(timer)
      resolve(null)
    }
  })
}

// ── 初始化 ──────────────────────────────────────────────────────────
async function init() {
  renderTags()
  showMain('个人本地库')

  // 2. 读取待保存内容
  let stored = {}
  try { stored = await chrome.storage.local.get('pendingImage') } catch (e) {}
  pendingImage = stored.pendingImage || null

  if (!pendingImage?.imageUrl) {
    document.getElementById('previewWrap').innerHTML =
      '<div class="preview-placeholder"><div class="icon">😅</div><div>未找到文件<br>请重新右键选择</div></div>'
    return
  }

  // 3. 预览
  const wrap = document.getElementById('previewWrap')
  wrap.innerHTML = ''
  if (pendingImage.mediaType === 'video') {
    if (pendingImage.thumb) {
      // 优先用 content script 截的帧（最快，无 CORS 问题）
      const img = document.createElement('img')
      img.src = pendingImage.thumb
      img.style.cssText = 'max-width:100%;max-height:130px;object-fit:contain;display:block;'
      // 左上角加视频标识
      const badge = document.createElement('div')
      badge.textContent = '▶ 视频'
      badge.style.cssText = 'position:absolute;top:6px;left:6px;background:rgba(0,0,0,0.55);color:#fff;font-size:10px;padding:2px 6px;border-radius:4px;'
      wrap.style.position = 'relative'
      wrap.appendChild(img)
      wrap.appendChild(badge)
    } else {
      // thumb 为 null（截帧失败），让 SW 下载字节渲染
      wrap.innerHTML = '<div class="preview-placeholder"><div class="icon">⏳</div><div>视频加载中…</div></div>'
      sendMsg('FETCH_PREVIEW_BYTES', { url: pendingImage.imageUrl, tabId: pendingImage.tabId }, 15000).then(res => {
        wrap.innerHTML = ''
        if (res?.ok && res.bytes) {
          const blob = new Blob([new Uint8Array(res.bytes)], { type: res.mime || 'video/mp4' })
          const blobUrl = URL.createObjectURL(blob)
          const vid = document.createElement('video')
          vid.src = blobUrl
          vid.muted = true; vid.autoplay = true; vid.loop = true; vid.controls = true
          vid.style.cssText = 'max-width:100%;max-height:130px;object-fit:contain;display:block;'
          wrap.appendChild(vid)
        } else {
          wrap.innerHTML = '<div class="preview-placeholder"><div class="icon">🎬</div><div>预览不可用<br>但仍可正常收藏</div></div>'
        }
      })
    }
  } else {
    const img = document.createElement('img')
    img.src = pendingImage.imageUrl
    img.onerror = () => { wrap.innerHTML = '<div class="preview-placeholder"><div class="icon">🖼️</div><div>预览加载失败</div></div>' }
    wrap.appendChild(img)
  }

  // 4. 来源
  if (pendingImage.pageUrl) {
    const bar = document.getElementById('sourceBar')
    bar.style.display = 'flex'
    document.getElementById('sourceUrl').textContent = (() => {
      try {
        const u = new URL(pendingImage.pageUrl)
        return u.hostname + (u.pathname !== '/' ? u.pathname.slice(0, 28) : '')
      } catch { return pendingImage.pageUrl.slice(0, 40) }
    })()
  }

  // 5. 标题预填
  const titleInput = document.getElementById('titleInput')
  titleInput.value = pendingImage.alt || pendingImage.pageTitle || ''
  titleInput.focus()
  titleInput.select()
}

// ── 保存 ────────────────────────────────────────────────────────────
async function handleSave() {
  if (!pendingImage) return
  const title = document.getElementById('titleInput').value.trim()
  if (!title) { showError('请填写标题'); document.getElementById('titleInput').focus(); return }
  showError('')

  const btn = document.getElementById('btnSave')
  btn.disabled = true
  btn.innerHTML = '<span class="spinner"></span>保存中…'

  const result = await sendMsg('SAVE_IMAGE', {
    imageUrl: pendingImage.imageUrl,
    pageUrl: pendingImage.pageUrl,
    pageTitle: pendingImage.pageTitle,
    title,
    tags: selectedTags.join(',') || null,
    description: null,
    mediaType: pendingImage.mediaType || 'image',
    tabId: pendingImage.tabId || null,
  }, 30000)

  if (result?.ok) {
    try { chrome.storage.local.remove('pendingImage') } catch (e) {}
    window.close()
  } else {
    btn.disabled = false
    btn.innerHTML = '收藏'
    showError(result?.error || '保存失败，请重试')
  }
}

// ── 事件绑定 ────────────────────────────────────────────────────────
document.getElementById('btnSave').addEventListener('click', handleSave)
document.getElementById('btnCancel').addEventListener('click', () => window.close())
document.getElementById('btnOpenApp')?.addEventListener('click', async () => {
  await sendMsg('OPEN_LIBRARY', null, 10000)
  window.close()
})
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleSave()
  if (e.key === 'Escape') window.close()
})

init()
