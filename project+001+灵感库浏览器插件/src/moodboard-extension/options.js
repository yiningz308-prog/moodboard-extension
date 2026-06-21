const DEFAULT_LIBRARY_URL = 'http://localhost:5173'

async function restore() {
  const stored = await chrome.storage.local.get('libraryUrl')
  document.getElementById('libraryUrl').value = stored.libraryUrl || DEFAULT_LIBRARY_URL
}

document.getElementById('save').addEventListener('click', async () => {
  const input = document.getElementById('libraryUrl')
  const status = document.getElementById('status')
  try {
    const value = new URL(input.value.trim())
    if (!['http:', 'https:'].includes(value.protocol)) throw new Error('仅支持 http 或 https 地址')
    const libraryUrl = value.href.replace(/\/$/, '')
    await chrome.storage.local.set({ libraryUrl })
    input.value = libraryUrl
    status.textContent = '已保存'
  } catch (error) {
    status.textContent = error?.message || '地址格式不正确'
    status.style.color = '#d93025'
    return
  }
  status.style.color = '#16803c'
})

restore()
