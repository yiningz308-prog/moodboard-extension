export type ImageAnalysis = {
  promptEn: string
  promptZh: string
  lexicon: Array<{
    termZh: string
    termEn: string
    definition: string
    relevance: 'high' | 'mid' | 'low'
  }>
  vibes: string[]
  searchKeywords: string[]
  analyzedAt: string
}

export type VisionSettings = {
  provider: 'siliconflow' | 'openrouter' | 'volcengine' | 'custom'
  apiKey: string
  model: string
  endpoint: string
}

const PROVIDERS: Record<Exclude<VisionSettings['provider'], 'custom'>, { endpoint: string; model: string }> = {
  siliconflow: {
    endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
    model: 'Pro/Qwen/Qwen2.5-VL-7B-Instruct',
  },
  openrouter: {
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'qwen/qwen2.5-vl-72b-instruct',
  },
  volcengine: {
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    model: 'doubao-1.5-vision-pro-32k',
  },
}

export function providerDefaults(provider: VisionSettings['provider']) {
  return provider === 'custom' ? { endpoint: '', model: '' } : PROVIDERS[provider]
}

function colorDistance(a: number[], b: number[]) {
  return (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2
}

function saturation(color: number[]) {
  const max = Math.max(...color)
  const min = Math.min(...color)
  const lightness = (max + min) / 510
  if (max === min) return 0
  return (max - min) / (lightness < 0.5 ? max + min : 510 - max - min)
}

export async function extractPalette(blob: Blob, count = 6): Promise<string[]> {
  if (!blob.type.startsWith('image/')) return []
  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = 80
    canvas.height = 80
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return []
    context.drawImage(bitmap, 0, 0, 80, 80)
    const data = context.getImageData(0, 0, 80, 80).data
    const pixels: number[][] = []
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3]! < 128) continue
      const color = [data[index]!, data[index + 1]!, data[index + 2]!]
      const lightness = (Math.max(...color) + Math.min(...color)) / 2
      if (lightness >= 10 && lightness <= 245) pixels.push(color)
    }
    if (!pixels.length) return []
    const clusterCount = Math.min(count, pixels.length)
    let centers = Array.from({ length: clusterCount }, (_, index) => [
      ...pixels[Math.floor((index / clusterCount) * pixels.length)]!,
    ])
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const clusters = Array.from({ length: clusterCount }, () => [] as number[][])
      pixels.forEach(pixel => {
        let best = 0
        let distance = Infinity
        centers.forEach((center, index) => {
          const next = colorDistance(pixel, center)
          if (next < distance) { best = index; distance = next }
        })
        clusters[best]!.push(pixel)
      })
      centers = clusters.map((cluster, index) => {
        if (!cluster.length) return centers[index]!
        return [0, 1, 2].map(channel => Math.round(
          cluster.reduce((sum, color) => sum + color[channel]!, 0) / cluster.length,
        ))
      })
    }
    const unique = centers
      .filter((color, index, all) => all.slice(0, index).every(previous => colorDistance(color, previous) > 1000))
      .sort((a, b) => saturation(b) - saturation(a))
    return unique.slice(0, count).map(color => `#${color.map(value => value.toString(16).padStart(2, '0')).join('')}`)
  } catch {
    return []
  } finally {
    bitmap?.close()
  }
}

export function colorHue(hex: string): { hue: number; saturation: number; lightness: number } {
  const value = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map(index => parseInt(value.slice(index, index + 2), 16) / 255)
  const max = Math.max(r!, g!, b!)
  const min = Math.min(r!, g!, b!)
  const delta = max - min
  let hue = 0
  if (delta) {
    if (max === r) hue = 60 * (((g! - b!) / delta) % 6)
    else if (max === g) hue = 60 * ((b! - r!) / delta + 2)
    else hue = 60 * ((r! - g!) / delta + 4)
  }
  if (hue < 0) hue += 360
  const lightness = (max + min) / 2
  const saturationValue = delta ? delta / (1 - Math.abs(2 * lightness - 1)) : 0
  return { hue, saturation: saturationValue * 100, lightness: lightness * 100 }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

const SYSTEM_PROMPT = `你是一名视觉设计分析专家。分析图片的主体、风格、色彩、构图、光线、材质、排版和情绪。只返回 JSON：
{"prompt_en":"完整英文生图提示词","prompt_zh":"完整中文提示词","lexicon":[{"term_zh":"中文术语","term_en":"english term","definition":"一句话中文释义","relevance":"high|mid|low"}],"vibes":["中文氛围词"],"search_keywords":["英文搜图词"]}
lexicon 给 3-5 个设计术语，vibes 给 3-5 个词，search_keywords 给 5-8 个适合 Pinterest 搜索的英文短语。`

export async function analyzeImage(blob: Blob, title: string, settings: VisionSettings): Promise<ImageAnalysis> {
  if (!settings.apiKey.trim()) throw new Error('请先填写视觉模型 API Key')
  const defaults = providerDefaults(settings.provider)
  const endpoint = (settings.endpoint.trim() || defaults.endpoint).replace(/\/$/, '')
  const model = settings.model.trim() || defaults.model
  if (!endpoint || !model) throw new Error('请填写接口地址和模型名称')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${settings.apiKey.trim()}`,
  }
  if (settings.provider === 'openrouter') {
    headers['HTTP-Referer'] = location.origin
    headers['X-Title'] = 'Personal Moodboard'
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: await blobToDataUrl(blob), detail: 'high' } },
          { type: 'text', text: `分析这张图片并输出要求的 JSON。图片标题：${title || '未命名'}` },
        ] },
      ],
      max_tokens: 1600,
      stream: false,
    }),
    signal: AbortSignal.timeout(120000),
  })
  if (!response.ok) throw new Error(`视觉模型返回 ${response.status}：${(await response.text()).slice(0, 240)}`)
  const payload = await response.json()
  const raw = String(payload?.choices?.[0]?.message?.content || '')
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim()
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('视觉模型没有返回可解析的 JSON')
  const parsed = JSON.parse(match[0]) as Record<string, unknown>
  const lexicon = Array.isArray(parsed.lexicon) ? parsed.lexicon.map(term => {
    const value = term as Record<string, unknown>
    const relevance = String(value.relevance || 'mid')
    return {
      termZh: String(value.term_zh || value.termZh || ''),
      termEn: String(value.term_en || value.termEn || ''),
      definition: String(value.definition || ''),
      relevance: (['high', 'mid', 'low'].includes(relevance) ? relevance : 'mid') as 'high' | 'mid' | 'low',
    }
  }) : []
  return {
    promptEn: String(parsed.prompt_en || ''),
    promptZh: String(parsed.prompt_zh || ''),
    lexicon,
    vibes: Array.isArray(parsed.vibes) ? parsed.vibes.map(String) : [],
    searchKeywords: Array.isArray(parsed.search_keywords) ? parsed.search_keywords.map(String) : [],
    analyzedAt: new Date().toISOString(),
  }
}
