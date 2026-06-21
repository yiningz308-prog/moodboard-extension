import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArchiveRestore,
  Copy,
  Download,
  ExternalLink,
  Folder,
  FolderPlus,
  HardDrive,
  ImagePlus,
  Palette,
  Search,
  Settings,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import {
  addBlobFromExtension,
  addFiles,
  createFolder,
  deleteFolder,
  deleteItem,
  exportLibrary,
  importLibrary,
  listFolders,
  listItems,
  putItem,
  requestPersistentStorage,
  storageEstimate,
  type LibraryFolder,
  type LibraryItem,
} from '@/lib/localLibrary'
import {
  analyzeImage,
  colorHue,
  extractPalette,
  providerDefaults,
  type VisionSettings,
} from '@/lib/imageAnalysis'

const PAGE_SIZE = 30
const COLOR_FILTERS = [
  { id: 'red', label: '红', color: '#ff3b30', range: [340, 20] },
  { id: 'orange', label: '橙', color: '#ff9500', range: [20, 50] },
  { id: 'yellow', label: '黄', color: '#ffcc00', range: [50, 70] },
  { id: 'green', label: '绿', color: '#34c759', range: [70, 160] },
  { id: 'blue', label: '蓝', color: '#007aff', range: [160, 250] },
  { id: 'purple', label: '紫', color: '#af52de', range: [250, 310] },
  { id: 'pink', label: '粉', color: '#ff2d55', range: [310, 340] },
  { id: 'neutral', label: '黑白', color: '#8e8e93', range: null },
] as const

function matchesColor(item: LibraryItem, filterId: string) {
  if (!filterId) return true
  const filter = COLOR_FILTERS.find(value => value.id === filterId)
  if (!filter || !item.colorPalette?.length) return false
  return item.colorPalette.some(hex => {
    const value = colorHue(hex)
    if (!filter.range) return value.saturation < 16
    const [start, end] = filter.range
    return value.saturation >= 16 && (start > end
      ? value.hue >= start || value.hue < end
      : value.hue >= start && value.hue < end)
  })
}

function formatBytes(value: number): string {
  if (!value) return '0 MB'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`
}

function useObjectUrl(blob?: Blob): string {
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!blob) return
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])
  return url
}

function LibraryCard({ item, onOpen }: { item: LibraryItem; onOpen: () => void }) {
  const previewUrl = useObjectUrl(item.thumbnail || item.blob)
  return (
    <button className="personal-card" onClick={onOpen} type="button">
      <div className="personal-card-media">
        {item.mediaType === 'video' ? (
          <video src={previewUrl} muted preload="metadata" />
        ) : (
          <img src={previewUrl} alt={item.title} loading="lazy" decoding="async" />
        )}
        <span className="personal-card-type">{item.mediaType === 'video' ? '视频' : '原图'}</span>
      </div>
      <div className="personal-card-body">
        <strong>{item.title}</strong>
        <span>{item.width && item.height ? `${item.width} × ${item.height}` : item.mimeType}</span>
        {item.tags.length > 0 && (
          <div className="personal-card-tags">
            {item.tags.slice(0, 3).map(tag => <i key={tag}>{tag}</i>)}
          </div>
        )}
      </div>
    </button>
  )
}

function DetailPanel({
  item,
  folders,
  onClose,
  onSaved,
  onDeleted,
}: {
  item: LibraryItem
  folders: LibraryFolder[]
  onClose: () => void
  onSaved: (item: LibraryItem) => void
  onDeleted: (id: string) => void
}) {
  const originalUrl = useObjectUrl(item.blob)
  const [title, setTitle] = useState(item.title)
  const [description, setDescription] = useState(item.description)
  const [tags, setTags] = useState(item.tags.join(', '))
  const [folderId, setFolderId] = useState(item.folderId || '')
  const [currentItem, setCurrentItem] = useState(item)
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [analysisError, setAnalysisError] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [vision, setVision] = useState<VisionSettings>(() => {
    const provider = (localStorage.getItem('moodboard_vlm_provider') || 'siliconflow') as VisionSettings['provider']
    const defaults = providerDefaults(provider)
    return {
      provider,
      apiKey: localStorage.getItem('moodboard_vlm_key') || '',
      model: localStorage.getItem('moodboard_vlm_model') || defaults.model,
      endpoint: localStorage.getItem('moodboard_vlm_endpoint') || defaults.endpoint,
    }
  })

  useEffect(() => {
    if (currentItem.mediaType === 'video' || currentItem.colorPalette?.length) return
    extractPalette(currentItem.thumbnail || currentItem.blob).then(async colorPalette => {
      if (!colorPalette.length) return
      const updated = { ...currentItem, colorPalette }
      await putItem(updated)
      setCurrentItem(updated)
      onSaved(updated)
    }).catch(() => undefined)
  }, [currentItem, onSaved])

  function saveVision(next: VisionSettings) {
    setVision(next)
    localStorage.setItem('moodboard_vlm_provider', next.provider)
    localStorage.setItem('moodboard_vlm_key', next.apiKey)
    localStorage.setItem('moodboard_vlm_model', next.model)
    localStorage.setItem('moodboard_vlm_endpoint', next.endpoint)
  }

  async function generateAnalysis() {
    setAnalysisLoading(true)
    setAnalysisError('')
    try {
      const analysis = await analyzeImage(currentItem.thumbnail || currentItem.blob, currentItem.title, vision)
      const updated = { ...currentItem, analysis, updatedAt: new Date().toISOString() }
      await putItem(updated)
      setCurrentItem(updated)
      onSaved(updated)
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : String(error))
      if (!vision.apiKey) setShowSettings(true)
    } finally {
      setAnalysisLoading(false)
    }
  }

  async function save() {
    const updated: LibraryItem = {
      ...currentItem,
      title: title.trim() || '未命名灵感',
      description: description.trim(),
      tags: tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean),
      folderId: folderId || null,
      updatedAt: new Date().toISOString(),
    }
    await putItem(updated)
    onSaved(updated)
  }

  function downloadOriginal() {
    const anchor = document.createElement('a')
    anchor.href = originalUrl
    anchor.download = item.originalName || item.title
    anchor.click()
  }

  return (
    <div className="personal-modal-backdrop" onMouseDown={onClose}>
      <div className="personal-detail" onMouseDown={event => event.stopPropagation()}>
        <button className="personal-icon-button personal-close" onClick={onClose} type="button"><X size={18} /></button>
        <div className="personal-detail-preview">
          {item.mediaType === 'video' ? (
            <video src={originalUrl} controls />
          ) : (
            <img src={originalUrl} alt={item.title} />
          )}
        </div>
        <div className="personal-detail-info">
          <div>
            <span className="personal-eyebrow">原始文件永久保留</span>
            <h2>{currentItem.title}</h2>
            <p>{formatBytes(currentItem.blob.size)} · {currentItem.mimeType}</p>
          </div>
          {currentItem.colorPalette?.length ? (
            <section className="personal-analysis-section">
              <div className="personal-section-title"><Palette size={15} /> 色板与色相</div>
              <div className="personal-palette">
                {currentItem.colorPalette.map(hex => {
                  const value = colorHue(hex)
                  return (
                    <button key={hex} title={`${hex} · 色相 ${Math.round(value.hue)}°`} onClick={() => navigator.clipboard.writeText(hex)} type="button">
                      <i style={{ background: hex }} /><span>{hex}<small>H {Math.round(value.hue)}°</small></span>
                    </button>
                  )
                })}
              </div>
            </section>
          ) : null}
          <label>标题<input value={title} onChange={event => setTitle(event.target.value)} /></label>
          <label>标签<input value={tags} onChange={event => setTags(event.target.value)} placeholder="品牌, 排版, 科技感" /></label>
          <label>文件夹
            <select value={folderId} onChange={event => setFolderId(event.target.value)}>
              <option value="">未分类</option>
              {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select>
          </label>
          <label>备注<textarea value={description} onChange={event => setDescription(event.target.value)} rows={4} /></label>
          <section className="personal-analysis-section">
            <div className="personal-section-heading">
              <div className="personal-section-title"><Sparkles size={15} /> 一键图片反推</div>
              <button className="personal-icon-button compact" onClick={() => setShowSettings(value => !value)} title="视觉模型设置" type="button"><Settings size={14} /></button>
            </div>
            {showSettings && (
              <div className="personal-vlm-settings">
                <label>服务
                  <select value={vision.provider} onChange={event => {
                    const provider = event.target.value as VisionSettings['provider']
                    const defaults = providerDefaults(provider)
                    saveVision({ ...vision, provider, model: defaults.model, endpoint: defaults.endpoint })
                  }}>
                    <option value="siliconflow">硅基流动</option>
                    <option value="openrouter">OpenRouter</option>
                    <option value="volcengine">火山引擎 / 豆包</option>
                    <option value="custom">自定义 OpenAI 兼容接口</option>
                  </select>
                </label>
                <label>API Key<input type="password" value={vision.apiKey} onChange={event => saveVision({ ...vision, apiKey: event.target.value })} placeholder="仅保存在当前浏览器" /></label>
                <label>模型<input value={vision.model} onChange={event => saveVision({ ...vision, model: event.target.value })} /></label>
                <label>接口地址<input value={vision.endpoint} onChange={event => saveVision({ ...vision, endpoint: event.target.value })} /></label>
              </div>
            )}
            <button className="personal-btn primary analysis-trigger" disabled={analysisLoading || currentItem.mediaType === 'video'} onClick={generateAnalysis} type="button">
              <Sparkles size={15} /> {analysisLoading ? '正在识图分析…' : currentItem.analysis ? '重新分析图片' : '生成提示词与设计分析'}
            </button>
            {analysisError && <div className="personal-analysis-error">{analysisError}</div>}
            {currentItem.analysis && (
              <div className="personal-analysis-result">
                <article><header>英文提示词<button onClick={() => navigator.clipboard.writeText(currentItem.analysis!.promptEn)} type="button"><Copy size={13} /></button></header><p>{currentItem.analysis.promptEn}</p></article>
                <article><header>中文提示词<button onClick={() => navigator.clipboard.writeText(currentItem.analysis!.promptZh)} type="button"><Copy size={13} /></button></header><p>{currentItem.analysis.promptZh}</p></article>
                {currentItem.analysis.lexicon.length > 0 && <div><strong>设计术语</strong>{currentItem.analysis.lexicon.map(term => <div className="personal-term" key={`${term.termZh}-${term.termEn}`}><b>{term.termZh}</b><span>{term.termEn}</span><i>{term.relevance === 'high' ? '高' : term.relevance === 'low' ? '低' : '中'}</i><p>{term.definition}</p></div>)}</div>}
                {currentItem.analysis.vibes.length > 0 && <div><strong>氛围词</strong><div className="personal-chip-list pink">{currentItem.analysis.vibes.map(value => <i key={value}>{value}</i>)}</div></div>}
                {currentItem.analysis.searchKeywords.length > 0 && <div><strong>搜图提示词</strong><div className="personal-chip-list">{currentItem.analysis.searchKeywords.map(value => <button key={value} onClick={() => window.open(`https://www.pinterest.com/search/pins/?q=${encodeURIComponent(value)}`, '_blank')} type="button">{value}</button>)}</div></div>}
              </div>
            )}
          </section>
          {item.sourceUrl && (
            <a className="personal-source-link" href={item.sourceUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> 打开来源页
            </a>
          )}
          <div className="personal-detail-actions">
            <button className="personal-btn primary" onClick={save} type="button">保存修改</button>
            <button className="personal-btn" onClick={downloadOriginal} type="button"><Download size={15} /> 下载原图</button>
            <button
              className="personal-btn danger"
              onClick={async () => {
                if (!confirm('确定删除这个文件？')) return
                await deleteItem(item.id)
                onDeleted(item.id)
              }}
              type="button"
            >
              <Trash2 size={15} /> 删除
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function PersonalLibraryPage() {
  const [items, setItems] = useState<LibraryItem[]>([])
  const [folders, setFolders] = useState<LibraryFolder[]>([])
  const [activeFolder, setActiveFolder] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [activeColor, setActiveColor] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [selected, setSelected] = useState<LibraryItem | null>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [usage, setUsage] = useState({ usage: 0, quota: 0 })
  const uploadRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    const [nextItems, nextFolders, nextUsage] = await Promise.all([listItems(), listFolders(), storageEstimate()])
    setItems(nextItems)
    setFolders(nextFolders)
    setUsage(nextUsage)
    // 旧数据没有色板：页面先显示，再在后台逐张补齐，避免阻塞首屏。
    void (async () => {
      for (const item of nextItems.filter(value => value.mediaType !== 'video' && !value.colorPalette?.length)) {
        const colorPalette = await extractPalette(item.thumbnail || item.blob)
        if (!colorPalette.length) continue
        const updated = { ...item, colorPalette }
        await putItem(updated)
        setItems(previous => previous.map(value => value.id === updated.id ? updated : value))
        await new Promise(resolve => setTimeout(resolve, 40))
      }
    })()
  }, [])

  useEffect(() => {
    requestPersistentStorage().catch(() => false)
    refresh().catch(error => setNotice(error instanceof Error ? error.message : String(error)))
  }, [refresh])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setVisibleCount(value => value + PAGE_SIZE)
    }, { rootMargin: '400px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.data?.source !== 'moodboard-extension' || event.data?.type !== 'IMPORT_MEDIA') return
      setBusy('正在保存插件采集的文件…')
      addBlobFromExtension(event.data.payload)
        .then(item => {
          setItems(previous => [item, ...previous])
          setNotice(`已保存：${item.title}`)
          window.postMessage({
            source: 'moodboard-web',
            type: 'IMPORT_MEDIA_RESULT',
            requestId: event.data.requestId,
            result: { ok: true, id: item.id },
          }, window.location.origin)
        })
        .catch(error => {
          const message = error instanceof Error ? error.message : String(error)
          setNotice(message)
          window.postMessage({
            source: 'moodboard-web',
            type: 'IMPORT_MEDIA_RESULT',
            requestId: event.data.requestId,
            result: { ok: false, error: message },
          }, window.location.origin)
        })
        .finally(() => setBusy(''))
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [])

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return items.filter(item => {
      const folderMatch = activeFolder === 'all' || (activeFolder === 'none' ? !item.folderId : item.folderId === activeFolder)
      const textMatch = !normalized || [item.title, item.description, item.tags.join(' ')]
        .some(value => value.toLowerCase().includes(normalized))
      return folderMatch && textMatch && matchesColor(item, activeColor)
    })
  }, [items, activeFolder, query, activeColor])

  async function handleUpload(fileList: FileList | null) {
    if (!fileList?.length) return
    setBusy(`正在处理 ${fileList.length} 个文件…`)
    try {
      const created = await addFiles(Array.from(fileList), { folderId: activeFolder === 'all' || activeFolder === 'none' ? null : activeFolder })
      setItems(previous => [...created.reverse(), ...previous])
      setNotice(`已保存 ${created.length} 个原始文件`)
      setUsage(await storageEstimate())
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
      if (uploadRef.current) uploadRef.current.value = ''
    }
  }

  async function handleExport() {
    setBusy('正在导出原图和元数据…')
    try {
      const result = await exportLibrary()
      setNotice(`已导出 ${result.itemCount} 个文件到 ${result.folderName}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  async function handleImport(fileList: FileList | null) {
    if (!fileList?.length) return
    setBusy('正在导入备份并重建预览图…')
    try {
      const count = await importLibrary(fileList)
      await refresh()
      setNotice(`已导入 ${count} 个原始文件`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
      if (importRef.current) importRef.current.value = ''
    }
  }

  async function handleCreateFolder() {
    const name = prompt('输入文件夹名称')?.trim()
    if (!name) return
    const folder = await createFolder(name)
    setFolders(previous => [...previous, folder])
    setActiveFolder(folder.id)
  }

  return (
    <div className="personal-app">
      <header className="personal-header">
        <div className="personal-brand">
          <div className="personal-logo"><ImagePlus size={20} /></div>
          <div><strong>灵感库</strong><span>Personal · Local-first</span></div>
        </div>
        <div className="personal-header-actions">
          <button className="personal-btn" onClick={() => importRef.current?.click()} type="button"><ArchiveRestore size={16} /> 导入</button>
          <button className="personal-btn" onClick={handleExport} type="button"><Download size={16} /> 导出</button>
          <button className="personal-btn primary" onClick={() => uploadRef.current?.click()} type="button"><Upload size={16} /> 添加文件</button>
          <input ref={uploadRef} hidden multiple type="file" accept="image/*,video/*" onChange={event => handleUpload(event.target.files)} />
          <input
            ref={(node) => {
              importRef.current = node
              node?.setAttribute('webkitdirectory', '')
              node?.setAttribute('directory', '')
            }}
            hidden
            multiple
            type="file"
            onChange={event => handleImport(event.target.files)}
          />
        </div>
      </header>

      <div className="personal-shell">
        <aside className="personal-sidebar">
          <div className="personal-sidebar-title">文件夹<button onClick={handleCreateFolder} type="button"><FolderPlus size={15} /></button></div>
          <button className={activeFolder === 'all' ? 'active' : ''} onClick={() => setActiveFolder('all')} type="button"><Folder size={16} /> 全部灵感 <span>{items.length}</span></button>
          <button className={activeFolder === 'none' ? 'active' : ''} onClick={() => setActiveFolder('none')} type="button"><Folder size={16} /> 未分类 <span>{items.filter(item => !item.folderId).length}</span></button>
          {folders.map(folder => (
            <div className="personal-folder-row" key={folder.id}>
              <button className={activeFolder === folder.id ? 'active' : ''} onClick={() => setActiveFolder(folder.id)} type="button"><Folder size={16} /> {folder.name}<span>{items.filter(item => item.folderId === folder.id).length}</span></button>
              <button
                className="personal-folder-delete"
                onClick={async () => {
                  if (!confirm(`删除文件夹「${folder.name}」？原图会移到未分类。`)) return
                  await deleteFolder(folder.id)
                  if (activeFolder === folder.id) setActiveFolder('all')
                  await refresh()
                }}
                type="button"
              ><X size={13} /></button>
            </div>
          ))}
          <div className="personal-storage">
            <HardDrive size={16} />
            <div><strong>本机存储</strong><span>{formatBytes(usage.usage)} / {usage.quota ? formatBytes(usage.quota) : '浏览器配额'}</span></div>
          </div>
        </aside>

        <main className="personal-main">
          <div className="personal-hero">
            <div><span className="personal-eyebrow">单用户 · 无需登录</span><h1>把好灵感，放在自己手里。</h1><p>原图存在本机，预览图用于快速浏览；导出后可在新设备完整恢复。</p></div>
            <div className="personal-search"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标题、标签或备注" /></div>
          </div>
          <div className="personal-color-filters">
            <span><Palette size={14} /> 色相</span>
            <button className={!activeColor ? 'active' : ''} onClick={() => setActiveColor('')} type="button">全部</button>
            {COLOR_FILTERS.map(filter => <button className={activeColor === filter.id ? 'active' : ''} key={filter.id} onClick={() => setActiveColor(filter.id)} type="button"><i style={{ background: filter.color }} />{filter.label}</button>)}
          </div>

          {(notice || busy) && <div className={`personal-notice ${busy ? 'busy' : ''}`}>{busy || notice}</div>}
          {filtered.length === 0 ? (
            <div className="personal-empty">
              <ImagePlus size={34} />
              <h2>这里还没有灵感</h2>
              <p>上传原图，或从浏览器插件采集。</p>
              <button className="personal-btn primary" onClick={() => uploadRef.current?.click()} type="button">选择文件</button>
            </div>
          ) : (
            <>
              <div className="personal-grid">
                {filtered.slice(0, visibleCount).map(item => <LibraryCard key={item.id} item={item} onOpen={() => setSelected(item)} />)}
              </div>
              <div ref={sentinelRef} className="personal-sentinel">{visibleCount < filtered.length ? '继续加载…' : `共 ${filtered.length} 项`}</div>
            </>
          )}
        </main>
      </div>

      {selected && (
        <DetailPanel
          item={selected}
          folders={folders}
          onClose={() => setSelected(null)}
          onSaved={(updated) => {
            setItems(previous => previous.map(item => item.id === updated.id ? updated : item))
            setSelected(updated)
            setNotice('修改已保存')
          }}
          onDeleted={(id) => {
            setItems(previous => previous.filter(item => item.id !== id))
            setSelected(null)
            setNotice('文件已删除')
          }}
        />
      )}
    </div>
  )
}
