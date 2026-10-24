/** 查找/替换匹配器（与主进程窗口模式查找保持同一套语义） */

export interface FindOptions {
  matchCase: boolean
  wholeWord: boolean
  regex: boolean
}

export interface Hit {
  start: number
  end: number
}

function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false
  return /[A-Za-z0-9_\u00c0-\uffff]/.test(ch) && !/\s/.test(ch)
}

export class SearchMatcher {
  readonly ok: boolean
  readonly error?: string
  private re: RegExp | null = null
  private needle = ''
  private opts: FindOptions = { matchCase: false, wholeWord: false, regex: false }

  constructor(query: string, opts: FindOptions) {
    this.opts = opts
    if (!query) {
      this.ok = false
      this.error = '查找内容为空'
      return
    }
    if (opts.regex) {
      try {
        this.re = new RegExp(query, opts.matchCase ? 'g' : 'gi')
        this.ok = true
      } catch (e: any) {
        this.ok = false
        this.error = '正则表达式无效：' + (e?.message || e)
      }
    } else {
      this.needle = opts.matchCase ? query : query.toLowerCase()
      this.ok = true
    }
  }

  /** 某行内从 from 开始的第一个命中 */
  one(line: string, from = 0): Hit | null {
    if (!this.ok) return null
    if (this.re) {
      const re = this.re
      re.lastIndex = Math.max(0, from)
      const m = re.exec(line)
      if (!m) return null
      if (m[0].length === 0) {
        // 零宽匹配（如 ^、\b）：返回空区间，调用方负责前进一位，避免死循环
        re.lastIndex = m.index + 1
        return { start: m.index, end: m.index }
      }
      return { start: m.index, end: m.index + m[0].length }
    }
    const hay = this.opts.matchCase ? line : line.toLowerCase()
    let i = hay.indexOf(this.needle, Math.max(0, from))
    while (i >= 0) {
      if (!this.opts.wholeWord || (!isWordChar(hay[i - 1]) && !isWordChar(hay[i + this.needle.length]))) {
        return { start: i, end: i + this.needle.length }
      }
      i = hay.indexOf(this.needle, i + 1)
    }
    return null
  }

  /** 某行内全部命中（渲染高亮用，设上限避免超长行卡死） */
  all(line: string, cap = 4000): Hit[] {
    if (!this.ok) return []
    const out: Hit[] = []
    if (this.re) {
      const re = this.re
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(line))) {
        if (m[0].length === 0) {
          out.push({ start: m.index, end: m.index })
          re.lastIndex++
          if (re.lastIndex > line.length) break
          if (out.length >= cap) break
          continue
        }
        out.push({ start: m.index, end: m.index + m[0].length })
        if (out.length >= cap) break
      }
      return out
    }
    const hay = this.opts.matchCase ? line : line.toLowerCase()
    let from = 0
    while (from <= hay.length) {
      const i = hay.indexOf(this.needle, from)
      if (i < 0) break
      if (!this.opts.wholeWord || (!isWordChar(hay[i - 1]) && !isWordChar(hay[i + this.needle.length]))) {
        out.push({ start: i, end: i + this.needle.length })
        if (out.length >= cap) break
        from = i + Math.max(1, this.needle.length)
      } else {
        from = i + 1
      }
    }
    return out
  }

  /** 替换文本展开（支持 $1 / $& / $2 / \1 反向引用） */
  private sticky: RegExp | null = null

  private stickyFor(): RegExp | null {
    if (!this.re) return null
    if (!this.sticky) {
      const flags = this.re.flags.replace(/[gy]/g, '') + 'y'
      this.sticky = new RegExp(this.re.source, flags)
    }
    return this.sticky
  }

  expand(replacement: string, line: string, hit: Hit): string {
    if (!this.re) return replacement
    const re = this.stickyFor()!
    re.lastIndex = hit.start
    const m = re.exec(line)
    if (!m) return replacement
    return replacement
      .replace(/\\(\d)/g, '$$$1')
      .replace(/\$(\$|&|\d{1,2})/g, (_all, g: string) => {
        if (g === '$') return '$'
        if (g === '&') return m[0]
        return m[Number(g)] ?? ''
      })
  }
}
