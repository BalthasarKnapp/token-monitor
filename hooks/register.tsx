import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Period, Row, Snapshot, Tok, View } from '../types'

// ───────────────────────── Zustand ─────────────────────────

const PANE = 'token-monitor'
const snapAtom = atom({ plugin: 'token-monitor', key: 'snap' } as const, null, {
  shape: 'snap-1',
})
const viewAtom = atom(
  { plugin: 'token-monitor', key: 'view' } as const,
  { period: 'month', metric: 'tokens' } as View,
  { shape: 'view-1' },
)

type Eng = EngineInterface

/** Pro Transkript-Datei gespeichert: mtime, Größe, Session-ID, Tagesbuckets. */
type FileRec = {
  m: number
  s: number
  sid: string
  /** key = day \u0001 model \u0001 project → [i, o, w5, w1, r, usd, n] */
  b: Record<string, number[]>
}
type Store = Record<string, FileRec>

type Rec = {
  id: string
  ts: number
  model: string
  fast: boolean
  cwd: string
  sid: string
  i: number
  o: number
  w5: number
  w1: number
  r: number
}

// ───────────────────────── Preise ($ pro Mio. Tokens) ─────────────────────────
// [Präfix, Input, Output, Cache-Read (leer = 0,1 × Input)]
// Cache-Write: 5 Min = 1,25 × Input, 1 Std = 2 × Input. Fast-Modus = 2 × alles.

const PRICE_TABLE: [string, number, number, number?][] = [
  ['claude-fable-5-2', 8, 40, 0.2],
  ['claude-mythos-5-2', 8, 40, 0.2],
  ['claude-fable-5-1', 10, 50, 0.25],
  ['claude-mythos-5-1', 10, 50, 0.25],
  ['claude-fable-5', 10, 50, 1],
  ['claude-mythos-5', 10, 50, 1],
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus-5', 5, 25],
  ['claude-opus-4-8', 5, 25],
  ['claude-opus-4-7', 5, 25],
  ['claude-opus-4-6', 5, 25],
  ['claude-opus-4-5', 5, 25],
  ['claude-opus-4-1', 15, 75],
  ['claude-opus-4', 15, 75],
  ['claude-3-opus', 15, 75],
  ['claude-sonnet-5-5', 2, 10, 0.1],
  ['claude-sonnet-5', 2, 10],
  ['claude-sonnet-4', 3, 15],
  ['claude-3-7-sonnet', 3, 15],
  ['claude-3-5-sonnet', 3, 15],
  ['claude-haiku-5-5', 0.1, 0.5],
  ['claude-haiku-4-5', 1, 5],
  ['claude-3-5-haiku', 0.8, 4],
  ['claude-3-haiku', 0.25, 1.25],
]
const PRICES = [...PRICE_TABLE].sort((a, b) => b[0].length - a[0].length)

function costOf(r: Rec): number {
  const m = r.model.toLowerCase()
  const hit = PRICES.find(p => m.startsWith(p[0]))
  if (!hit) return 0
  const [, pi, po, pr] = hit
  const read = pr ?? pi * 0.1
  const usd =
    (r.i * pi + r.o * po + r.w5 * pi * 1.25 + r.w1 * pi * 2 + r.r * read) / 1e6
  return r.fast ? usd * 2 : usd
}

// ───────────────────────── Zeit / Zeitzone ─────────────────────────

/** Minuten-Offset, falls die Laufzeit selbst keine Zeitzone kennt. */
let manualOffset: number | null = null

async function initTz($: Eng): Promise<void> {
  if (new Date().getTimezoneOffset() !== 0) return
  try {
    const res = await $.process.run(
      [
        'powershell.exe',
        '-NoProfile',
        '-Command',
        '[int][TimeZoneInfo]::Local.GetUtcOffset([DateTime]::UtcNow).TotalMinutes',
      ],
      { timeoutMs: 15000 },
    )
    const n = Number(res.stdout.trim())
    if (Number.isFinite(n) && n !== 0) manualOffset = n
  } catch {
    // Kein PowerShell: dann eben UTC.
  }
}

type Parts = { y: number; mo: number; d: number; h: number; mi: number; wd: number }
function parts(ts: number): Parts {
  if (manualOffset === null) {
    const d = new Date(ts)
    return {
      y: d.getFullYear(),
      mo: d.getMonth() + 1,
      d: d.getDate(),
      h: d.getHours(),
      mi: d.getMinutes(),
      wd: d.getDay(),
    }
  }
  const d = new Date(ts + manualOffset * 60000)
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    wd: d.getUTCDay(),
  }
}
const pad = (n: number) => String(n).padStart(2, '0')
function dayKey(ts: number): string {
  const p = parts(ts)
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`
}
/** Tag `k` Tage vor `day` (YYYY-MM-DD), rein kalendarisch. */
function dayMinus(day: string, k: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) - k))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']

// ───────────────────────── Transkripte lesen ─────────────────────────

let sep = '/'

async function configDir($: Eng): Promise<string> {
  const custom = await $.env.get('CLAUDE_CONFIG_DIR')
  if (custom) {
    if (custom.includes('\\')) sep = '\\'
    return custom.replace(/[\\/]+$/, '')
  }
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  if (home.includes('\\')) sep = '\\'
  return `${home.replace(/[\\/]+$/, '')}${sep}.claude`
}

type FileInfo = { path: string; size: number; mtime: number; sid: string }

async function walk($: Eng, root: string): Promise<FileInfo[]> {
  const out: FileInfo[] = []
  const projects = await $.fs.list(root).catch(() => [])
  for (const p of projects) {
    if (p.kind !== 'dir') continue
    const pdir = `${root}${sep}${p.name}`
    const entries = await $.fs.list(pdir).catch(() => [])
    for (const f of entries) {
      if (f.kind === 'file' && f.name.endsWith('.jsonl')) {
        out.push({
          path: `${pdir}${sep}${f.name}`,
          size: f.size,
          mtime: f.mtimeMs,
          sid: f.name.slice(0, -6),
        })
      } else if (f.kind === 'dir') {
        // <projekt>/<session-id>/subagents/*.jsonl
        const sub = `${pdir}${sep}${f.name}${sep}subagents`
        const agents = await $.fs.list(sub).catch(() => [])
        for (const a of agents) {
          if (a.kind === 'file' && a.name.endsWith('.jsonl')) {
            out.push({
              path: `${sub}${sep}${a.name}`,
              size: a.size,
              mtime: a.mtimeMs,
              sid: f.name,
            })
          }
        }
      }
    }
  }
  return out
}

function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0
}

function parseText(text: string): Rec[] {
  const byId = new Map<string, Rec>()
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const msg = o?.message
    const u = msg?.usage
    if (o?.type !== 'assistant' || !u || typeof msg?.model !== 'string') continue
    if (msg.model === '<synthetic>') continue
    const cc = u.cache_creation
    const w5 = cc ? num(cc.ephemeral_5m_input_tokens) : num(u.cache_creation_input_tokens)
    const w1 = cc ? num(cc.ephemeral_1h_input_tokens) : 0
    const id = `${msg.id ?? ''}:${o.requestId ?? ''}`
    // Spätere Zeilen derselben Antwort tragen den endgültigen Stand.
    byId.set(id, {
      id,
      ts: Date.parse(o.timestamp) || 0,
      model: msg.model,
      fast: u.speed === 'fast',
      cwd: typeof o.cwd === 'string' ? o.cwd : '',
      sid: typeof o.sessionId === 'string' ? o.sessionId : '',
      i: num(u.input_tokens),
      o: num(u.output_tokens),
      w5,
      w1,
      r: num(u.cache_read_input_tokens),
    })
  }
  return [...byId.values()]
}

// Dateien über 4 MiB kann $.fs.read nicht lesen: PowerShell zieht nur die Usage-Felder heraus.
const BIG_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  'foreach($l in [IO.File]::ReadLines($env:TM_FILE)){',
  " if(-not $l.Contains('\"usage\"')){continue}",
  ' $o=$null; try{$o=ConvertFrom-Json $l}catch{continue}',
  " if($o.type -ne 'assistant' -or $null -eq $o.message.usage){continue}",
  ' $u=$o.message.usage; $c=$u.cache_creation; $w5=0; $w1=0',
  ' if($c){$w5=[long]$c.ephemeral_5m_input_tokens;$w1=[long]$c.ephemeral_1h_input_tokens}else{$w5=[long]$u.cache_creation_input_tokens}',
  ' [Console]::Out.WriteLine((@($o.message.id,$o.requestId,$o.timestamp,$o.message.model,$u.speed,$o.cwd,$o.sessionId,[long]$u.input_tokens,[long]$u.output_tokens,$w5,$w1,[long]$u.cache_read_input_tokens)) -join "`t")',
  '}',
].join('\n')

async function readBig($: Eng, path: string): Promise<Rec[]> {
  const res = await $.process.run(
    ['powershell.exe', '-NoProfile', '-Command', BIG_SCRIPT],
    { env: { TM_FILE: path }, timeoutMs: 300000 },
  )
  const byId = new Map<string, Rec>()
  for (const line of res.stdout.split(/\r?\n/)) {
    const f = line.split('\t')
    if (f.length < 12) continue
    const model = f[3] ?? ''
    if (!model || model === '<synthetic>') continue
    const id = `${f[0]}:${f[1]}`
    byId.set(id, {
      id,
      ts: Date.parse(f[2] ?? '') || 0,
      model,
      fast: f[4] === 'fast',
      cwd: f[5] ?? '',
      sid: f[6] ?? '',
      i: Number(f[7]) || 0,
      o: Number(f[8]) || 0,
      w5: Number(f[9]) || 0,
      w1: Number(f[10]) || 0,
      r: Number(f[11]) || 0,
    })
  }
  return [...byId.values()]
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

function toFileRec(recs: Rec[], f: FileInfo): FileRec {
  const b: Record<string, number[]> = {}
  let sid = f.sid
  for (const r of recs) {
    if (r.sid) sid = r.sid
    const key = `${dayKey(r.ts)}\u0001${r.model}\u0001${baseName(r.cwd) || '(unbekannt)'}`
    const v = (b[key] ??= [0, 0, 0, 0, 0, 0, 0])
    v[0] = (v[0] ?? 0) + r.i
    v[1] = (v[1] ?? 0) + r.o
    v[2] = (v[2] ?? 0) + r.w5
    v[3] = (v[3] ?? 0) + r.w1
    v[4] = (v[4] ?? 0) + r.r
    v[5] = (v[5] ?? 0) + costOf(r)
    v[6] = (v[6] ?? 0) + 1
  }
  return { m: f.mtime, s: f.size, sid, b }
}

// ───────────────────────── Aggregation ─────────────────────────

const zero = (): Tok => ({ i: 0, o: 0, w5: 0, w1: 0, r: 0, usd: 0, n: 0 })
function add(t: Tok, v: number[]): void {
  t.i += v[0] ?? 0
  t.o += v[1] ?? 0
  t.w5 += v[2] ?? 0
  t.w1 += v[3] ?? 0
  t.r += v[4] ?? 0
  t.usd += v[5] ?? 0
  t.n += v[6] ?? 0
}
export const tokens = (t: Tok) => t.i + t.o + t.w5 + t.w1 + t.r

function prettyModel(m: string): string {
  const bits = m.replace(/^claude-/, '').split('-')
  const fam = bits.find(b => /^[a-z]+$/.test(b)) ?? m
  const nums = bits.filter(b => /^\d{1,2}$/.test(b))
  return `${fam.charAt(0).toUpperCase()}${fam.slice(1)} ${nums.join('.')}`.trim()
}

function rows(map: Map<string, Tok>): Row[] {
  return [...map.entries()]
    .map(([name, tok]) => ({ name, tok }))
    .sort((a, b) => tokens(b.tok) - tokens(a.tok))
    .slice(0, 8)
}

function aggregate(store: Store, sid: string, now: number): Omit<Snapshot, 'limits' | 'limitsLive' | 'files' | 'skipped'> {
  const today = dayKey(now)
  const month = today.slice(0, 7)
  const session = zero()
  const todayT = zero()
  const monthT = zero()
  const total = zero()
  const perDay = new Map<string, Tok>()
  const models = { today: new Map<string, Tok>(), month: new Map<string, Tok>(), total: new Map<string, Tok>() }
  const projects = { today: new Map<string, Tok>(), month: new Map<string, Tok>(), total: new Map<string, Tok>() }
  let firstDay: string | undefined

  const bump = (m: Map<string, Tok>, k: string, v: number[]) => {
    let t = m.get(k)
    if (!t) m.set(k, (t = zero()))
    add(t, v)
  }

  for (const fr of Object.values(store)) {
    for (const [key, v] of Object.entries(fr.b)) {
      const [day = '', model = '', proj = ''] = key.split('\u0001')
      const mName = prettyModel(model)
      if (!firstDay || day < firstDay) firstDay = day
      add(total, v)
      bump(models.total, mName, v)
      bump(projects.total, proj, v)
      bump(perDay, day, v)
      if (fr.sid === sid) add(session, v)
      if (day.startsWith(month)) {
        add(monthT, v)
        bump(models.month, mName, v)
        bump(projects.month, proj, v)
      }
      if (day === today) {
        add(todayT, v)
        bump(models.today, mName, v)
        bump(projects.today, proj, v)
      }
    }
  }

  const days: { day: string; tok: Tok }[] = []
  for (let k = 29; k >= 0; k--) {
    const d = dayMinus(today, k)
    days.push({ day: d, tok: perDay.get(d) ?? zero() })
  }

  return {
    updatedAt: now,
    firstDay,
    session,
    today: todayT,
    month: monthT,
    total,
    days,
    byModel: { today: rows(models.today), month: rows(models.month), total: rows(models.total) },
    byProject: { today: rows(projects.today), month: rows(projects.month), total: rows(projects.total) },
  }
}

// ───────────────────────── Aktualisieren ─────────────────────────

let busy = false
let pending = false
let lastStore: Store | null = null
let lastFiles = 0
let lastSkipped = 0
let lastError: string | undefined

async function scan($: Eng): Promise<void> {
  const root = `${await configDir($)}${sep}projects`
  const files = await walk($, root)
  const stored = (((await $.store.get('files')) ?? {}) as Store)
  let changed = false
  let skipped = 0
  for (const f of files) {
    const old = stored[f.path]
    if (old && old.m === f.mtime && old.s === f.size) continue
    try {
      const recs =
        f.size > 4_000_000
          ? await readBig($, f.path)
          : parseText(String(await $.fs.read(f.path)))
      stored[f.path] = toFileRec(recs, f)
      changed = true
    } catch {
      skipped++
    }
  }
  // Gelöschte Transkripte bleiben im Speicher: so geht der Verlauf nicht verloren.
  lastError = undefined
  if (changed) {
    try {
      await $.store.set('files', stored)
    } catch (err) {
      lastError = `Speichern fehlgeschlagen: ${String(err).slice(0, 120)}`
    }
  }
  lastStore = stored
  lastFiles = files.length
  lastSkipped = skipped
}

async function readLimits($: Eng, now: number): Promise<{ limits: Limit[]; live: boolean }> {
  try {
    const u = await $.session.usage()
    if (u.rateLimits.length > 0) {
      const limits = u.rateLimits.map(r => ({
        kind: r.kind,
        percentUsed: r.percentUsed,
        resetsAt: r.resetsAt,
        seenAt: now,
      }))
      await $.store.set('limits', limits)
      return { limits, live: true }
    }
  } catch {
    // weiter mit dem zuletzt bekannten Stand
  }
  const saved = ((await $.store.get('limits')) ?? []) as Limit[]
  return { limits: saved, live: false }
}

async function refresh($: Eng, rescan: boolean): Promise<void> {
  if (busy) {
    pending = pending || rescan
    return
  }
  busy = true
  try {
    if (rescan || !lastStore) await scan($)
    const now = await $.clock.now()
    const sid = await $.session.id()
    const { limits, live } = await readLimits($, now)
    const snap: Snapshot = {
      ...aggregate(lastStore ?? {}, sid, now),
      limits,
      limitsLive: live,
      files: lastFiles,
      skipped: lastSkipped,
      error: lastError,
    }
    await update($, snapAtom, () => snap)
  } catch (err) {
    $.ui.log(`token-monitor: ${String(err)}`, { to: 'debug' })
  } finally {
    busy = false
    if (pending) {
      pending = false
      void refresh($, true)
    }
  }
}

// ───────────────────────── Formatierung ─────────────────────────

function fmtTok(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2).replace('.', ',')} Mrd`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2).replace('.', ',')} Mio`
  if (n >= 1e4) return `${Math.round(n / 1e3)} Tsd`
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}
function fmtUsd(x: number): string {
  const s = x >= 100 ? x.toFixed(0) : x.toFixed(2)
  return `$${s.replace('.', ',')}`
}
function fmtDur(ms: number): string {
  if (ms <= 0) return 'jetzt'
  const min = Math.round(ms / 60000)
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  if (d > 0) return `${d} Tg ${h} Std`
  if (h > 0) return `${h} Std ${m} Min`
  return `${m} Min`
}
function fmtWhen(ts: number): string {
  const p = parts(ts)
  return `${WD[p.wd] ?? ''} ${pad(p.h)}:${pad(p.mi)}`
}
function limitColor(p: number): string {
  return p >= 90 ? 'error' : p >= 70 ? 'warning' : 'success'
}
const HEX: Record<string, string> = { error: '#E5484D', warning: '#E2A336', success: '#3FA66B' }
const ACCENT = '#D97757'

function barSvg(pct: number, color: string): string {
  const w = Math.max(0, Math.min(100, pct)) * 2.4
  return `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="8" viewBox="0 0 240 8"><rect width="240" height="8" rx="4" fill="#8888884d"/><rect width="${w.toFixed(1)}" height="8" rx="4" fill="${color}"/></svg>`
}
function barText(pct: number, width = 20): string {
  const n = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width)
  return '█'.repeat(n) + '░'.repeat(width - n)
}

function chartSvg(days: { day: string; tok: Tok }[], metric: 'tokens' | 'usd'): string {
  const W = 300
  const H = 110
  const top = 14
  const base = 92
  const val = (t: Tok) => (metric === 'usd' ? t.usd : tokens(t))
  const max = Math.max(1e-9, ...days.map(d => val(d.tok)))
  const bw = W / days.length
  let bars = ''
  days.forEach((d, idx) => {
    const v = val(d.tok)
    const h = v > 0 ? Math.max(1.5, (v / max) * (base - top)) : 0
    const x = idx * bw + 1
    const isToday = idx === days.length - 1
    bars += `<rect x="${x.toFixed(1)}" y="${(base - h).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${ACCENT}" fill-opacity="${isToday ? 1 : 0.7}"/>`
  })
  let labels = ''
  for (const idx of [0, 7, 14, 21, 29]) {
    const d = days[idx]
    if (!d) continue
    const [, m, dd] = d.day.split('-')
    const x = idx * bw + bw / 2
    labels += `<text x="${x.toFixed(1)}" y="${H - 4}" font-size="9" text-anchor="middle" fill="#8a8a8a" font-family="sans-serif">${dd}.${m}.</text>`
  }
  const maxLabel = metric === 'usd' ? fmtUsd(max) : fmtTok(max)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><line x1="0" y1="${base + 0.5}" x2="${W}" y2="${base + 0.5}" stroke="#8a8a8a" stroke-opacity="0.4"/><text x="0" y="9" font-size="9" fill="#8a8a8a" font-family="sans-serif">max ${maxLabel}</text>${bars}${labels}</svg>`
}

function sparkline(days: { day: string; tok: Tok }[], metric: 'tokens' | 'usd'): string {
  const chars = '▁▂▃▄▅▆▇█'
  const val = (t: Tok) => (metric === 'usd' ? t.usd : tokens(t))
  const max = Math.max(1e-9, ...days.map(d => val(d.tok)))
  return days
    .map(d => {
      const v = val(d.tok)
      return v <= 0 ? ' ' : chars[Math.min(7, Math.floor((v / max) * 7.999))]
    })
    .join('')
}

const LIMIT_NAME: Record<string, string> = {
  five_hour: '5-Stunden-Fenster',
  seven_day: 'Wochenlimit',
  spend_limit: 'Ausgabenlimit',
}
const PERIOD_NAME: Record<Period, string> = { today: 'Heute', month: 'Monat', total: 'Gesamt' }

// ───────────────────────── Hooks ─────────────────────────

let ticker: { cancel: () => void } | null = null

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'tokens',
      description: 'Token-Monitor öffnen (Verbrauch, Limits, Kosten)',
    })
    void $.ui.open({ id: PANE, title: 'Token-Monitor' })
    await initTz($)
    void refresh($, true)
    ticker?.cancel()
    let tick = 0
    // Jede Minute Limits und Countdown, alle 5 Minuten auch die Dateien.
    ticker = $.clock.every(60000, () => {
      tick++
      void refresh($, tick % 5 === 0)
    })
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    void refresh($, true)
    return done
  })

  on('command.run', { command: 'tokens' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Token-Monitor' })
    void refresh($, true)
    return { text: 'Token-Monitor geöffnet.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Select } = table
    const Svg = 'Svg' in table ? table.Svg : undefined
    const snap = await read($, snapAtom)
    const view = await read($, viewAtom)
    const now = await $.clock.now()

    if (!snap) {
      return (
        <Box flexDirection="column" gap={1} padding={1}>
          <Text weight="semibold">Token-Monitor</Text>
          <Text dimColor>Lese Transkripte …</Text>
        </Box>
      )
    }

    const section = (title: string) => (
      <Text size="footnote" weight="semibold" dimColor>
        {title.toUpperCase()}
      </Text>
    )

    // ── Limits
    const limitRows = snap.limits
      .filter(l => l.kind === 'five_hour' || l.kind === 'seven_day' || l.kind === 'spend_limit')
      .map(l => {
        const reset = l.resetsAt ? Date.parse(l.resetsAt) : NaN
        const isReset = !snap.limitsLive && Number.isFinite(reset) && reset <= now
        const pct = isReset ? 0 : l.percentUsed
        const color = limitColor(pct)
        return (
          <Box flexDirection="column" key={`limit-${l.kind}`}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text>{LIMIT_NAME[l.kind] ?? l.kind}</Text>
              <Text color={color} weight="semibold" tabular>
                {pct.toFixed(pct % 1 === 0 ? 0 : 1).replace('.', ',')} %
              </Text>
            </Box>
            {Svg ? (
              <Svg source={barSvg(pct, HEX[color] ?? ACCENT)} alt={`${pct} Prozent verbraucht`} width={240} height={8} />
            ) : (
              <Text color={color}>{barText(pct)}</Text>
            )}
            <Text size="caption" dimColor>
              {isReset
                ? 'Inzwischen zurückgesetzt'
                : Number.isFinite(reset)
                  ? `Reset in ${fmtDur(reset - now)} (${fmtWhen(reset)})`
                  : ''}
            </Text>
          </Box>
        )
      })

    const limitInfo = snap.limits.length === 0
      ? 'Noch kein Messwert. Er erscheint nach der nächsten Antwort von Claude.'
      : snap.limitsLive
        ? 'Live aus der letzten API-Antwort'
        : `Zuletzt gemessen ${fmtWhen(snap.limits[0]?.seenAt ?? now)}`

    // ── Verbrauch
    const usageRow = (label: string, t: Tok) => (
      <Box flexDirection="column" key={`use-${label}`}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text>{label}</Text>
          <Box flexDirection="row" gap={2}>
            <Text weight="semibold" tabular>
              {fmtTok(tokens(t))}
            </Text>
            <Text dimColor tabular>
              {fmtUsd(t.usd)}
            </Text>
          </Box>
        </Box>
        <Text size="caption" dimColor>
          In {fmtTok(t.i)} · Out {fmtTok(t.o)} · Cache-W {fmtTok(t.w5 + t.w1)} · Cache-R {fmtTok(t.r)}
        </Text>
      </Box>
    )

    // ── Aufteilung
    const listRows = (list: Row[], prefix: string) => {
      const sum = list.reduce((s, r) => s + tokens(r.tok), 0) || 1
      if (list.length === 0) return [<Text dimColor key={`${prefix}-none`}>Keine Daten im Zeitraum.</Text>]
      return list.map(r => {
        const share = (tokens(r.tok) / sum) * 100
        return (
          <Box flexDirection="column" key={`${prefix}-${r.name}`}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text wrap="truncate-end">{r.name}</Text>
              <Box flexDirection="row" gap={2}>
                <Text tabular>{fmtTok(tokens(r.tok))}</Text>
                <Text dimColor tabular>
                  {fmtUsd(r.tok.usd)}
                </Text>
              </Box>
            </Box>
            {Svg ? (
              <Svg source={barSvg(share, ACCENT)} alt={`${Math.round(share)} Prozent`} width={240} height={8} />
            ) : (
              <Text color="claude">{barText(share, 16)}</Text>
            )}
          </Box>
        )
      })
    }

    const periodSelect = (
      <Select
        key="period"
        label="Zeitraum"
        value={view.period}
        options={[
          { value: 'today', label: 'Heute' },
          { value: 'month', label: 'Dieser Monat' },
          { value: 'total', label: 'Gesamt' },
        ]}
        onSelect={v => void update($, viewAtom, cur => ({ ...cur, period: v as Period }))}
      />
    )
    const metricSelect = (
      <Select
        key="metric"
        label="Diagramm"
        value={view.metric}
        options={[
          { value: 'tokens', label: 'Tokens' },
          { value: 'usd', label: 'Kosten ($)' },
        ]}
        onSelect={v => void update($, viewAtom, cur => ({ ...cur, metric: v as 'tokens' | 'usd' }))}
      />
    )

    const firstDay = snap.firstDay ? snap.firstDay.split('-').reverse().join('.') : '–'

    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text size="caption" dimColor>
            Stand {fmtWhen(snap.updatedAt)}
          </Text>
          <Button key="refresh" label="Aktualisieren" onPress={() => void refresh($, true)} />
        </Box>

        {section('Limits (Pro)')}
        {limitRows}
        <Text size="caption" dimColor>
          {limitInfo}
        </Text>

        {section('Verbrauch')}
        {usageRow('Diese Session', snap.session)}
        {usageRow('Heute', snap.today)}
        {usageRow('Dieser Monat', snap.month)}
        {usageRow('Gesamt', snap.total)}

        {section('Verlauf (30 Tage)')}
        {metricSelect}
        {Svg ? (
          <Svg source={chartSvg(snap.days, view.metric)} alt="Verbrauch pro Tag der letzten 30 Tage" width={300} height={110} />
        ) : (
          <Text color="claude">{sparkline(snap.days, view.metric)}</Text>
        )}

        {section(`Nach Modell · ${PERIOD_NAME[view.period]}`)}
        {periodSelect}
        {listRows(snap.byModel[view.period], 'model')}

        {section(`Nach Projekt · ${PERIOD_NAME[view.period]}`)}
        {listRows(snap.byProject[view.period], 'proj')}

        <Text size="caption" dimColor>
          Daten seit {firstDay} · {snap.files} Transkripte
          {snap.skipped > 0 ? ` · ${snap.skipped} nicht lesbar` : ''}. Kosten = was der Verbrauch
          über die API kosten würde, nicht dein Abo-Preis.
        </Text>
        {snap.error ? <Text color="error">{snap.error}</Text> : null}
      </Box>
    )
  })
}
