/** Token-Zähler: input, output, cache write 5m, cache write 1h, cache read, Dollar, Antworten. */
export type Tok = {
  i: number
  o: number
  w5: number
  w1: number
  r: number
  usd: number
  n: number
}

export type Row = { name: string; tok: Tok }

export type Limit = {
  kind: string
  percentUsed: number
  resetsAt?: string
  /** Wann der Wert zuletzt von der API kam (ms seit Epoch). */
  seenAt: number
}

export type Period = 'today' | 'month' | 'total'

export type Snapshot = {
  updatedAt: number
  firstDay?: string
  session: Tok
  today: Tok
  month: Tok
  total: Tok
  days: { day: string; tok: Tok }[]
  byModel: { today: Row[]; month: Row[]; total: Row[] }
  byProject: { today: Row[]; month: Row[]; total: Row[] }
  limits: Limit[]
  limitsLive: boolean
  files: number
  skipped: number
  error?: string
}

export type View = { period: Period; metric: 'tokens' | 'usd' }

declare module 'claude-code' {
  interface PluginState {
    'token-monitor': {
      snap: Shaped<Snapshot | null>
      view: Shaped<View>
    }
  }
}
