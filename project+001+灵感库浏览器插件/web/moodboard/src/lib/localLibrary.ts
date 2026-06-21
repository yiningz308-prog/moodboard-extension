import { extractPalette, type ImageAnalysis } from '@/lib/imageAnalysis'

export type LibraryItem = {
  id: string
  title: string
  description: string
  tags: string[]
  folderId: string | null
  sourceUrl: string
  mediaType: 'image' | 'gif' | 'video'
  mimeType: string
  originalName: string
  createdAt: string
  updatedAt: string
  width: number
  height: number
  blob: Blob
  thumbnail?: Blob
  colorPalette?: string[]
  analysis?: ImageAnalysis
}

export type LibraryFolder = {
  id: string
  name: string
  createdAt: string
}

type ExportItem = Omit<LibraryItem, 'blob' | 'thumbnail'> & {
  fileName: string
}

type ExportManifest = {
  format: 'moodboard-personal-library'
  version: 1
  exportedAt: string
  folders: LibraryFolder[]
  items: ExportItem[]
}

const DB_NAME = 'moodboard-personal-library'
const DB_VERSION = 1
const ITEMS_STORE = 'items'
const FOLDERS_STORE = 'folders'

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

async function openLibrary(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(ITEMS_STORE)) {
        const store = database.createObjectStore(ITEMS_STORE, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
        store.createIndex('folderId', 'folderId')
      }
      if (!database.objectStoreNames.contains(FOLDERS_STORE)) {
        database.createObjectStore(FOLDERS_STORE, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function inferMediaType(file: Blob): LibraryItem['mediaType'] {
  if (file.type.startsWith('video/')) return 'video'
  if (file.type === 'image/gif') return 'gif'
  return 'image'
}

function safeExtension(name: string, mimeType: string): string {
  const fromName = name.match(/\.([a-zA-Z0-9]{1,8})$/)?.[1]
  if (fromName) return fromName.toLowerCase()
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
  }
  return map[mimeType] || 'bin'
}

async function imageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  if (!blob.type.startsWith('image/')) return { width: 0, height: 0 }
  try {
    const bitmap = await createImageBitmap(blob)
    const result = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return result
  } catch {
    return { width: 0, height: 0 }
  }
}

export async function createThumbnail(blob: Blob, maxEdge = 720): Promise<Blob | undefined> {
  if (!blob.type.startsWith('image/')) return undefined
  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(blob)
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) return undefined
    context.drawImage(bitmap, 0, 0, width, height)
    return await new Promise((resolve) => canvas.toBlob(
      result => resolve(result || undefined),
      'image/webp',
      0.78,
    ))
  } catch {
    return undefined
  } finally {
    bitmap?.close()
  }
}

export async function listItems(): Promise<LibraryItem[]> {
  const database = await openLibrary()
  const transaction = database.transaction(ITEMS_STORE, 'readonly')
  const result = await requestResult(transaction.objectStore(ITEMS_STORE).getAll()) as LibraryItem[]
  database.close()
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function putItem(item: LibraryItem): Promise<void> {
  const database = await openLibrary()
  const transaction = database.transaction(ITEMS_STORE, 'readwrite')
  transaction.objectStore(ITEMS_STORE).put(item)
  await transactionDone(transaction)
  database.close()
}

export async function addFiles(
  files: File[],
  defaults: Partial<Pick<LibraryItem, 'folderId' | 'sourceUrl' | 'tags'>> = {},
): Promise<LibraryItem[]> {
  const created: LibraryItem[] = []
  // 串行生成预览图，避免多张大图同时解码占用内存。
  for (const file of files) {
    const now = new Date().toISOString()
    const dimensions = await imageDimensions(file)
    const thumbnail = await createThumbnail(file)
    const colorPalette = await extractPalette(thumbnail || file)
    const item: LibraryItem = {
      id: crypto.randomUUID(),
      title: file.name.replace(/\.[^.]+$/, '') || '未命名灵感',
      description: '',
      tags: defaults.tags || [],
      folderId: defaults.folderId || null,
      sourceUrl: defaults.sourceUrl || '',
      mediaType: inferMediaType(file),
      mimeType: file.type || 'application/octet-stream',
      originalName: file.name,
      createdAt: now,
      updatedAt: now,
      width: dimensions.width,
      height: dimensions.height,
      blob: file,
      thumbnail,
      colorPalette,
    }
    await putItem(item)
    created.push(item)
  }
  return created
}

export async function addBlobFromExtension(payload: {
  bytes: number[]
  mimeType: string
  title?: string
  sourceUrl?: string
  mediaType?: LibraryItem['mediaType']
  tags?: string[]
  description?: string
}): Promise<LibraryItem> {
  const blob = new Blob([new Uint8Array(payload.bytes)], { type: payload.mimeType || 'image/jpeg' })
  const extension = safeExtension('', blob.type)
  const file = new File([blob], `extension-${Date.now()}.${extension}`, { type: blob.type })
  const [item] = await addFiles([file], {
    sourceUrl: payload.sourceUrl || '',
    tags: payload.tags || [],
  })
  if (!item) throw new Error('文件写入失败')
  const updated = {
    ...item,
    title: payload.title?.trim() || item.title,
    description: payload.description?.trim() || '',
    mediaType: payload.mediaType || item.mediaType,
  }
  await putItem(updated)
  return updated
}

export async function deleteItem(id: string): Promise<void> {
  const database = await openLibrary()
  const transaction = database.transaction(ITEMS_STORE, 'readwrite')
  transaction.objectStore(ITEMS_STORE).delete(id)
  await transactionDone(transaction)
  database.close()
}

export async function listFolders(): Promise<LibraryFolder[]> {
  const database = await openLibrary()
  const transaction = database.transaction(FOLDERS_STORE, 'readonly')
  const result = await requestResult(transaction.objectStore(FOLDERS_STORE).getAll()) as LibraryFolder[]
  database.close()
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function putFolder(folder: LibraryFolder): Promise<void> {
  const database = await openLibrary()
  const transaction = database.transaction(FOLDERS_STORE, 'readwrite')
  transaction.objectStore(FOLDERS_STORE).put(folder)
  await transactionDone(transaction)
  database.close()
}

export async function createFolder(name: string): Promise<LibraryFolder> {
  const folder = { id: crypto.randomUUID(), name: name.trim(), createdAt: new Date().toISOString() }
  await putFolder(folder)
  return folder
}

export async function deleteFolder(id: string): Promise<void> {
  const database = await openLibrary()
  const transaction = database.transaction([FOLDERS_STORE, ITEMS_STORE], 'readwrite')
  transaction.objectStore(FOLDERS_STORE).delete(id)
  const itemStore = transaction.objectStore(ITEMS_STORE)
  const items = await requestResult(itemStore.getAll()) as LibraryItem[]
  items.filter(item => item.folderId === id).forEach(item => itemStore.put({ ...item, folderId: null }))
  await transactionDone(transaction)
  database.close()
}

function writeHandle(handle: FileSystemFileHandle, content: Blob | string): Promise<void> {
  return handle.createWritable().then(async writable => {
    await writable.write(content)
    await writable.close()
  })
}

export async function exportLibrary(): Promise<{ itemCount: number; folderName: string }> {
  const picker = (window as Window & {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
  }).showDirectoryPicker
  if (!picker) throw new Error('当前浏览器不支持目录导出，请使用 Chrome 或 Edge')

  const items = await listItems()
  const folders = await listFolders()
  const root = await picker({ mode: 'readwrite' })
  const folderName = `moodboard-backup-${new Date().toISOString().slice(0, 10)}`
  const exportRoot = await root.getDirectoryHandle(folderName, { create: true })
  const mediaRoot = await exportRoot.getDirectoryHandle('media', { create: true })
  const manifestItems: ExportItem[] = []

  for (const item of items) {
    const fileName = `${item.id}.${safeExtension(item.originalName, item.mimeType)}`
    const fileHandle = await mediaRoot.getFileHandle(fileName, { create: true })
    await writeHandle(fileHandle, item.blob)
    const { blob: _blob, thumbnail: _thumbnail, ...metadata } = item
    void _blob
    void _thumbnail
    manifestItems.push({ ...metadata, fileName })
  }

  const manifest: ExportManifest = {
    format: 'moodboard-personal-library',
    version: 1,
    exportedAt: new Date().toISOString(),
    folders,
    items: manifestItems,
  }
  const manifestHandle = await exportRoot.getFileHandle('manifest.json', { create: true })
  await writeHandle(manifestHandle, JSON.stringify(manifest, null, 2))
  return { itemCount: items.length, folderName }
}

export async function importLibrary(files: FileList): Promise<number> {
  const allFiles = Array.from(files)
  const manifestFile = allFiles.find(file => file.name === 'manifest.json')
  if (!manifestFile) throw new Error('备份中未找到 manifest.json')
  const manifest = JSON.parse(await manifestFile.text()) as ExportManifest
  if (manifest.format !== 'moodboard-personal-library' || manifest.version !== 1) {
    throw new Error('不支持的灵感库备份格式')
  }

  for (const folder of manifest.folders) await putFolder(folder)
  let imported = 0
  for (const metadata of manifest.items) {
    const media = allFiles.find(file => file.name === metadata.fileName)
    if (!media) continue
    const thumbnail = await createThumbnail(media)
    const { fileName: _fileName, ...itemMetadata } = metadata
    const colorPalette = itemMetadata.colorPalette?.length
      ? itemMetadata.colorPalette
      : await extractPalette(thumbnail || media)
    void _fileName
    await putItem({ ...itemMetadata, blob: media, thumbnail, colorPalette })
    imported += 1
  }
  return imported
}

export async function storageEstimate(): Promise<{ usage: number; quota: number }> {
  const estimate = await navigator.storage?.estimate?.()
  return { usage: estimate?.usage || 0, quota: estimate?.quota || 0 }
}

export async function requestPersistentStorage(): Promise<boolean> {
  return await navigator.storage?.persist?.() || false
}
