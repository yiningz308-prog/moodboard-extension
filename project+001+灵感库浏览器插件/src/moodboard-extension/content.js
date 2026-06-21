// content.js — v5.3.1
// 识别右键位置的真实媒体，并对 Pinterest/花瓣/小红书做原图地址升级。

'use strict'

let lastRightClicked = null

function absoluteUrl(value) {
  if (!value) return null
  try { return new URL(value, location.href).href } catch { return null }
}

function bestFromSrcset(srcset) {
  if (!srcset) return null
  const candidates = srcset.split(',').map((part) => {
    const bits = part.trim().split(/\s+/)
    const descriptor = bits[1] || '1x'
    const weight = descriptor.endsWith('w')
      ? Number.parseFloat(descriptor)
      : Number.parseFloat(descriptor) * 10000
    return { url: absoluteUrl(bits[0]), weight: Number.isFinite(weight) ? weight : 0 }
  }).filter(item => item.url)
  candidates.sort((a, b) => b.weight - a.weight)
  return candidates[0]?.url || null
}

function upgradePinterestUrl(value) {
  try {
    const url = new URL(value)
    if (!/(^|\.)pinimg\.com$/i.test(url.hostname)) return value
    url.pathname = url.pathname.replace(
      /\/(?:60x60|75x75_RS|136x136|236x|474x|564x|736x)\//i,
      '/originals/',
    )
    url.search = ''
    url.hash = ''
    return url.href
  } catch { return value }
}

function upgradeHuabanUrl(value) {
  try {
    const url = new URL(value)
    if (!/hbimg\.huaban\.com$|huabanimg\.(?:com|cn)$/i.test(url.hostname)) return value
    // 花瓣 CDN 原图键在 pathname，imageView2 等缩放参数可直接去掉。
    url.search = ''
    url.hash = ''
    return url.href
  } catch { return value }
}

function upgradeXhsUrl(value) {
  try {
    const url = new URL(value)
    if (!/(^|\.)xhscdn\.com$/i.test(url.hostname)) return value
    const parts = url.pathname.split('/').filter(Boolean)
    const traceId = (parts.at(-1) || '').split('!')[0]
    if (!traceId) return value
    const prefix = url.pathname.includes('/notes_pre_post/')
      ? 'notes_pre_post/'
      : (url.pathname.includes('/comment/') ? 'comment/' : '')
    return `https://sns-img-qc.xhscdn.com/${prefix}${traceId}?imageView2/format/png`
  } catch { return value }
}

function upgradeMediaUrl(value) {
  const url = absoluteUrl(value)
  if (!url || !/^https?:/i.test(url)) return url
  if (/(^|\.)pinimg\.com(?:\/|$)/i.test(new URL(url).hostname)) return upgradePinterestUrl(url)
  if (/huaban|hbimg/i.test(new URL(url).hostname)) return upgradeHuabanUrl(url)
  if (/xhscdn\.com$/i.test(new URL(url).hostname)) return upgradeXhsUrl(url)
  return url
}

function imageCandidates(img) {
  if (!img) return []
  return [
    bestFromSrcset(img.getAttribute('srcset')),
    bestFromSrcset(img.getAttribute('data-srcset')),
    img.currentSrc,
    img.src,
    img.getAttribute('data-origin-src'),
    img.getAttribute('data-original'),
    img.getAttribute('data-src'),
    img.getAttribute('data-lazy'),
    img.getAttribute('data-url'),
  ].map(upgradeMediaUrl).filter(Boolean)
}

function elementArea(el) {
  const rect = el?.getBoundingClientRect?.()
  return Math.max(0, rect?.width || 0) * Math.max(0, rect?.height || 0)
}

function findImageNear(target) {
  const found = []
  if (target?.tagName === 'IMG') found.push(target)

  let node = target
  for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
    if (node.tagName === 'IMG') found.push(node)
    node.querySelectorAll?.('img').forEach(img => found.push(img))

    const bg = getComputedStyle(node).backgroundImage
    const match = bg?.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/i)
    if (match) {
      return {
        src: upgradeMediaUrl(match[1]),
        alt: node.getAttribute?.('aria-label') || node.getAttribute?.('title') || '',
        width: Math.round(node.getBoundingClientRect?.().width || 0),
        height: Math.round(node.getBoundingClientRect?.().height || 0),
        resolver: 'css-background',
      }
    }
  }

  const unique = [...new Set(found)]
    .filter(img => imageCandidates(img).length)
    .sort((a, b) => elementArea(b) - elementArea(a))
  const img = unique[0]
  if (!img) return null
  return {
    src: imageCandidates(img)[0],
    alt: img.alt || img.getAttribute('aria-label') || img.title || '',
    width: img.naturalWidth || Math.round(img.getBoundingClientRect().width) || 0,
    height: img.naturalHeight || Math.round(img.getBoundingClientRect().height) || 0,
    resolver: location.hostname.includes('pinterest') ? 'pinterest' :
      (location.hostname.includes('huaban') ? 'huaban' :
        (location.hostname.includes('xiaohongshu') ? 'xiaohongshu' : 'dom-image')),
  }
}

function findVideoNear(target) {
  if (target?.tagName === 'VIDEO') return target
  const closest = target?.closest?.('video')
  if (closest) return closest
  let node = target
  for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
    const video = node.querySelector?.('video')
    if (video) return video
  }
  return null
}

function pageVideoCandidates(video) {
  const candidates = []
  const add = value => {
    const url = absoluteUrl(value)
    if (url && /^https?:/i.test(url) && !candidates.includes(url)) candidates.push(url)
  }

  add(video?.currentSrc)
  add(video?.src)
  video?.querySelectorAll?.('source').forEach(source => add(source.src || source.getAttribute('src')))

  // 小红书视频标签有时使用 blob: URL，真实 CDN 地址仍会出现在资源时序里。
  try {
    performance.getEntriesByType('resource').slice().reverse().forEach((entry) => {
      if (/\.(?:mp4|webm)(?:\?|$)|sns-video|video.*xhscdn|xhscdn.*video/i.test(entry.name)) add(entry.name)
    })
  } catch {}

  // 再从页面内嵌状态里找 master_url/masterUrl。只扫描有视频特征的脚本，避免读取无关内容。
  if (!candidates.length && location.hostname.includes('xiaohongshu.com')) {
    document.querySelectorAll('script').forEach((script) => {
      let text = script.textContent || ''
      if (text.length > 3_000_000 || !/master_url|masterUrl|origin_video_key|video/i.test(text)) return
      text = text.replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/\\u0026/gi, '&')
      const urls = text.match(/https?:\/\/[^"'\\\s<>]+/g) || []
      urls.filter(url => /\.mp4(?:\?|$)|sns-video|xhscdn.*video|video.*xhscdn/i.test(url)).forEach(add)
    })
  }
  return candidates
}

function captureVideoFrame(video) {
  try {
    const width = video.videoWidth || 320
    const height = video.videoHeight || 180
    const scale = Math.min(1, 400 / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.8)
  } catch { return null }
}

document.addEventListener('contextmenu', (event) => {
  lastRightClicked = null
  const video = findVideoNear(event.target)
  if (video) {
    const src = pageVideoCandidates(video)[0]
    lastRightClicked = {
      src: src || video.currentSrc || video.src || '',
      alt: video.title || video.getAttribute('aria-label') || document.title,
      mediaType: 'video',
      width: video.videoWidth || 0,
      height: video.videoHeight || 0,
      thumb: captureVideoFrame(video),
      resolver: location.hostname.includes('xiaohongshu') ? 'xiaohongshu-video' : 'dom-video',
    }
    return
  }

  const image = findImageNear(event.target)
  if (image?.src) {
    lastRightClicked = {
      ...image,
      mediaType: /\.gif(?:\?|#|$)/i.test(image.src) ? 'gif' : 'image',
      thumb: null,
    }
  }
}, true)

// 花瓣会用自定义右键菜单拦截浏览器的 contextmenu，
// 所以额外提供一个不依赖右键的悬浮保存按钮。
function huabanImageAtPoint(x, y) {
  const found = []
  const elements = document.elementsFromPoint?.(x, y) || []
  elements.forEach((element) => {
    if (element.tagName === 'IMG') found.push(element)
    element.querySelectorAll?.('img').forEach((img) => {
      const rect = img.getBoundingClientRect()
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) found.push(img)
    })
  })
  const image = [...new Set(found)]
    .filter(img => elementArea(img) >= 120 * 120 && imageCandidates(img).length)
    .sort((a, b) => elementArea(b) - elementArea(a))[0]
  if (!image) return null
  const rect = image.getBoundingClientRect()
  return {
    media: {
      src: imageCandidates(image)[0],
      alt: image.alt || image.getAttribute('aria-label') || image.title || document.title,
      width: image.naturalWidth || Math.round(rect.width) || 0,
      height: image.naturalHeight || Math.round(rect.height) || 0,
      mediaType: /\.gif(?:\?|#|$)/i.test(imageCandidates(image)[0]) ? 'gif' : 'image',
      thumb: null,
      resolver: 'huaban-hover',
    },
    rect,
  }
}

function installHuabanHoverButton() {
  if (!/(^|\.)huaban\.com$/i.test(location.hostname)) return
  if (document.getElementById('moodboard-huaban-save-host')) return

  const host = document.createElement('div')
  host.id = 'moodboard-huaban-save-host'
  host.style.cssText = [
    'position:fixed',
    'display:none',
    'z-index:2147483647',
    'pointer-events:auto',
  ].join(';')

  const shadow = host.attachShadow({ mode: 'closed' })
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = '📌 保存到灵感库'
  button.style.cssText = [
    'height:38px',
    'padding:0 15px',
    'border:0',
    'border-radius:19px',
    'background:#1677ff',
    'color:#fff',
    'font:600 14px/38px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'box-shadow:0 5px 18px rgba(0,0,0,.28)',
    'cursor:pointer',
    'white-space:nowrap',
  ].join(';')
  shadow.appendChild(button)
  document.documentElement.appendChild(host)

  let currentMedia = null
  let scheduled = false

  function hide() {
    currentMedia = null
    host.style.display = 'none'
  }

  document.addEventListener('mousemove', (event) => {
    if (event.composedPath?.().includes(host) || scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      const result = huabanImageAtPoint(event.clientX, event.clientY)
      if (!result?.media?.src) {
        hide()
        return
      }
      currentMedia = result.media
      lastRightClicked = result.media
      const visibleBottom = Math.min(result.rect.bottom, window.innerHeight)
      host.style.left = `${Math.max(12, result.rect.left + 12)}px`
      host.style.top = `${Math.max(12, visibleBottom - 50)}px`
      host.style.display = 'block'
    })
  }, true)

  window.addEventListener('scroll', hide, true)
  window.addEventListener('blur', hide)

  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (!currentMedia?.src || button.disabled) return
    button.disabled = true
    button.textContent = '正在打开…'
    chrome.runtime.sendMessage({
      type: 'OPEN_SAVE_POPUP',
      payload: currentMedia,
      pageUrl: location.href,
      pageTitle: document.title,
    }, (response) => {
      const failed = chrome.runtime.lastError || !response?.ok
      button.textContent = failed ? '打开失败，请重试' : '✓ 已打开'
      setTimeout(() => {
        button.disabled = false
        button.textContent = '📌 保存到灵感库'
      }, 1200)
    })
  }, true)
}

installHuabanHoverButton()

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_LAST_IMG') {
    sendResponse(lastRightClicked)
    return
  }

  if (msg.type === 'FETCH_IN_PAGE') {
    ;(async () => {
      try {
        const res = await fetch(msg.url, {
          credentials: 'include',
          cache: 'no-store',
          referrer: location.href,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const declaredSize = Number(res.headers.get('content-length') || 0)
        if (declaredSize > 80 * 1024 * 1024) throw new Error('文件超过 80MB')
        const buffer = await res.arrayBuffer()
        if (buffer.byteLength > 80 * 1024 * 1024) throw new Error('文件超过 80MB')
        sendResponse({
          ok: true,
          bytes: Array.from(new Uint8Array(buffer)),
          mime: res.headers.get('content-type')?.split(';')[0] || '',
        })
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) })
      }
    })()
    return true
  }
})
