/**
 * The board's geometry and its reading of a feed.
 *
 * The layout is the product's one inherited idea, so it is pinned here rather than in a
 * screenshot: a column is a Turn, bricks stack from the floor, the newest Turn is anchored at the
 * right edge, and a finished Turn slides its stack one cell left so the next one has a column to
 * fall into.
 */
import { describe, expect, it } from 'vitest'
import {
  BRICK_H,
  BRICK_W,
  GAP,
  LIVE_SCROLL,
  RAIL_MIN_THUMB,
  boardWindow,
  cellPlacement,
  clampScroll,
  fitBoard,
  heldScroll,
  leadOf,
  liveRaise,
  newestTurnOf,
  pitchX,
  pitchY,
  railGeometry,
  scrollLimit,
  tallestColumn,
  windowCell,
  windowColumns,
  type BoardColumn,
  type BoardMetrics,
} from '../src/client/board-geometry'
import { columnsOf, titleOf } from '../src/client/cache-board'
import type { BrickFeed, CacheBrick, BrickTone } from '../src/shared/cache-brick'

/** One brick, settled. */
function brick(turn: number, step: number, tone: BrickTone = 'good', attempt = 0): CacheBrick {
  return {
    id: `S:${String(turn)}:${String(step)}:${String(attempt)}`,
    turn,
    step,
    attempt,
    inputTokens: 10,
    cacheReadTokens: 990,
    cacheWriteTokens: 0,
    hitRatio: tone === 'unknown' ? null : 0.99,
    startedAt: step,
    finishedAt: step + 1,
    tone,
  }
}

/** A feed of bricks plus the turns known to have ended. */
function feed(bricks: CacheBrick[], endedTurns: number[] = []): BrickFeed {
  return { sessionId: 'S', bricks, dropped: 0, endedTurns, dispatched: bricks.length }
}

describe('fitting the gutter', () => {
  it('counts the columns and rows a band can hold', () => {
    // A 1440-wide window with a 600-wide transcript leaves a gutter of a few hundred pixels.
    const metrics = fitBoard(390, 720)
    expect(metrics).toEqual({ width: BRICK_W, height: BRICK_H, gap: GAP, columns: 10, rows: 40 })
  })

  it('refuses a band too small to read as a board', () => {
    expect(fitBoard(BRICK_W, BRICK_H * 10)).toBeUndefined()
    expect(fitBoard(BRICK_W * 10, BRICK_H * 2)).toBeUndefined()
  })

  it('never reserves more rows than a pathological viewport asks for', () => {
    expect(fitBoard(400, 10_000)!.rows).toBe(60)
  })

  it('places a brick by pitch, from the right edge and the floor', () => {
    const metrics: BoardMetrics = { width: BRICK_W, height: BRICK_H, gap: GAP, columns: 4, rows: 6 }
    expect(cellPlacement(metrics, 0, 0)).toEqual({ right: 0, bottom: 0 })
    expect(cellPlacement(metrics, 2, 3)).toEqual({ right: 2 * pitchX(metrics), bottom: 3 * pitchY(metrics) })
  })
})

describe('the lead cell', () => {
  it('is reserved once the newest Turn has finished, and not while it runs', () => {
    expect(leadOf([column(1, 2), column(2, 2)])).toBe(1)
    expect(leadOf([column(1, 2), column(2, 2, false)])).toBe(0)
    expect(leadOf([])).toBe(0)
  })
})

describe('the live anchor', () => {
  it('keeps the floor while the running Turn fits', () => {
    expect(liveRaise(12, 40)).toBe(0)
  })

  it('rises just far enough to keep the newest brick of a tall Turn in frame', () => {
    // The brick that just landed is the one worth seeing; an older, taller Turn is not allowed to
    // raise the window at all (it is not passed in).
    expect(liveRaise(43, 40)).toBe(3)
  })
})

describe('reading a feed into columns', () => {
  it('groups by Turn, oldest first, with the bricks in the order they landed', () => {
    const columns = columnsOf(feed([
      brick(2, 1), brick(1, 1), brick(2, 2), brick(1, 2),
    ]))
    expect(columns.map((column) => column.turn)).toEqual([1, 2])
    expect(columns[0]!.bricks.map((entry) => entry.step)).toEqual([1, 2])
  })

  it('keeps a retry in the column of the step it replaced, after it', () => {
    const columns = columnsOf(feed([brick(1, 1, 'unknown', 0), brick(1, 1, 'good', 1), brick(1, 2)]))
    expect(columns[0]!.bricks.map((entry) => [entry.step, entry.attempt])).toEqual([[1, 0], [1, 1], [2, 0]])
  })

  it('marks a Turn finished only when the log said so', () => {
    const columns = columnsOf(feed([brick(1, 1), brick(2, 1)], [1]))
    expect(columns.map((column) => [column.turn, column.ended])).toEqual([[1, true], [2, false]])
  })

  it('gives an auxiliary call no column of its own', () => {
    // Turn 0 is a compaction or a session title: a real request, but not part of the conversation
    // the board is drawing a column per Turn for.
    const columns = columnsOf(feed([brick(0, 0), brick(1, 1)]))
    expect(columns.map((column) => column.turn)).toEqual([1])
  })
})

describe('what a brick says when hovered', () => {
  it('names the Turn, the step, the reading and what a retry is', () => {
    const text = titleOf(brick(4, 17, 'good', 1))
    expect(text).toContain('turn 4')
    expect(text).toContain('step 17')
    expect(text).toContain('attempt 1 (a retry)')
    expect(text).toContain('99.0% of this prompt came from the cache')
    expect(text).toContain('prompt 1000 tokens')
  })

  it('says the provider reported nothing, instead of claiming a miss', () => {
    // Usage with no cache field: the provider billed the call and stayed silent about caching.
    expect(titleOf(brick(1, 1, 'unknown'))).toContain('the provider reported no cache fields')
  })

  it('does not blame the provider for an attempt that was never billed', () => {
    // Measured live on a retry chain: five attempts settled with no usage at all, then one that
    // worked. Those five are grey for a different reason, and the text says which.
    const failed: CacheBrick = { ...brick(1, 1, 'unknown'), inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    expect(titleOf(failed)).toContain('no usage was billed')
    expect(titleOf(failed)).not.toContain('provider')
  })
})


// ── the window and the rails ────────────────────────────────────────────────────────────
//
// Ported with the code they test: this is 0.1.3's window arithmetic, and its tests came over with
// it. Two things are pinned — the live corner places columns and rows exactly where the frozen
// board placed them, and a window is a window: nothing outside it is drawn, nothing hidden counts
// as visible, and no rail offers travel the content cannot honour.

/** One column of `count` bricks whose steps start at `from`. */
function column(turn: number, count: number, ended = true, from = 1): BoardColumn {
  return {
    turn,
    ended,
    bricks: Array.from({ length: count }, (_, index) => ({ step: from + index, attempt: 0 })),
  }
}

const metricsOf = (columns: number, rows: number): BoardMetrics => ({ width: BRICK_W, height: BRICK_H, gap: GAP, columns, rows })

describe('the window a pan shows', () => {
  const columns = Array.from({ length: 8 }, (_, index) => column(index + 1, 2, index !== 7))

  it('anchors the newest column at the right edge, leaving the drop slot', () => {
    const live = boardWindow(columns, metricsOf(4, 6), undefined)
    expect(live.columns.map((entry) => entry.turn)).toEqual([5, 6, 7, 8])
    expect(live.lead).toBe(0)
    const finished = [...columns.slice(0, 7), column(8, 2)]
    expect(boardWindow(finished, metricsOf(4, 6), undefined).lead).toBe(1)
  })

  it('reveals older Turns and counts what it left behind on both sides', () => {
    const live = boardWindow(columns, metricsOf(4, 6), undefined)
    const panned = boardWindow(columns, metricsOf(4, 6), { back: 2, up: 0 })
    expect(live.columns.map((entry) => entry.turn)).toEqual([5, 6, 7, 8])
    expect(panned.columns.map((entry) => entry.turn)).toEqual([3, 4, 5, 6])
    expect(panned.newer).toBe(2)
    expect(panned.older).toBe(2)
  })

  it('stops at the oldest Turn rather than running past it', () => {
    const limit = scrollLimit(columns, 4, 6, leadOf(columns))
    expect(limit.back).toBe(4)
    const end = boardWindow(columns, metricsOf(4, 6), { back: 99, up: 0 })
    expect(end.scroll.back).toBe(limit.back)
    expect(end.columns.map((entry) => entry.turn)).toEqual([1, 2, 3, 4])
    expect(end.older).toBe(0)
    expect(end.newer).toBe(4)
  })

  it('raises the window only for the running Turn, and keeps its newest brick in frame', () => {
    const tall = [column(1, 20), column(2, 3, false)]
    const window = boardWindow(tall, metricsOf(4, 6), undefined)
    expect(windowCell(1, 0, 0, window.scroll, 4, window.limit)).toEqual({ column: 1, row: 0 })
    expect(windowCell(1, 5, 0, window.scroll, 4, window.limit)).toEqual({ column: 1, row: 5 })
    expect(windowCell(1, 6, 0, window.scroll, 4, window.limit)).toBeUndefined()
    expect(window.limitScroll.up).toBe(14)
    expect(window.tallest).toBe(20)
    // An older, taller Turn may not raise the window; history is what the vertical rail is for.
    const history = [column(1, 30), column(2, 4, false)]
    expect(boardWindow(history, metricsOf(4, 6), undefined).scroll).toEqual(LIVE_SCROLL)
    // A running Turn taller than the board does raise it, by exactly what it cannot fit.
    expect(liveRaise(12, 6)).toBe(6)
    expect(liveRaise(43, 40)).toBe(3)
  })

  it('never draws a brick outside the frame', () => {
    const window = boardWindow(columns, metricsOf(4, 3), { back: 3, up: 0 })
    for (const entry of columns) {
      for (let row = 0; row < entry.bricks.length; row += 1) {
        const cell = windowCell(columns.length - 1 - (entry.turn - 1), row, window.lead, window.scroll, 4, window.limit)
        if (cell === undefined) continue
        expect(cell.column).toBeGreaterThanOrEqual(0)
        expect(cell.column).toBeLessThanOrEqual(3)
        expect(cell.row).toBeGreaterThanOrEqual(0)
        expect(cell.row).toBeLessThanOrEqual(2)
      }
    }
  })

  it('states the index range it is showing, so a paint costs the window', () => {
    const huge = Array.from({ length: 5_000 }, (_, index) => column(index + 1, 3))
    const window = boardWindow(huge, metricsOf(10, 40), { back: 2_500, up: 0 })
    expect(window.columnEnd - window.columnStart).toBeLessThanOrEqual(10)
    expect(window.columns).toHaveLength(window.columnEnd - window.columnStart)
    expect(huge[window.columnStart]!.turn).toBeGreaterThan(1)
  })

  it('clamps a pan that asks for more than exists', () => {
    expect(clampScroll({ back: -3, up: -1 }, { back: 4, up: 2 })).toEqual(LIVE_SCROLL)
    expect(clampScroll({ back: 9, up: 9 }, { back: 4, up: 2 })).toEqual({ back: 4, up: 2 })
    expect(clampScroll({ back: 1.6, up: 0.4 }, { back: 4, up: 2 })).toEqual({ back: 2, up: 0 })
  })
})

describe('holding the pan while the content changes', () => {
  const columns = Array.from({ length: 8 }, (_, index) => column(index + 1, 2, index !== 7))
  const panned = { back: 2, up: 0 }

  it('holds the same Turns on screen when a Turn appends', () => {
    const before = windowColumns(columns, 4, panned.back).columns.map((entry) => entry.turn)
    const grown = [...columns, column(9, 1, false)]
    const after = heldScroll(panned, grown, newestTurnOf(columns))!
    expect(after.back).toBe(3)
    expect(windowColumns(grown, 4, after.back).columns.map((entry) => entry.turn)).toEqual(before)
  })

  it('leaves the pan exactly where it was when the ring ages out at the older end', () => {
    const before = windowColumns(columns, 4, panned.back).columns.map((entry) => entry.turn)
    // The ring drops its oldest Turns: the array shrinks from the front, which must not move the
    // reader by a single cell.
    const aged = columns.slice(2)
    const after = heldScroll(panned, aged, newestTurnOf(columns))!
    expect(after).toBe(panned)
    expect(windowColumns(aged, 4, after.back).columns.map((entry) => entry.turn)).toEqual(before)
  })

  it('does not touch a board that is following the live end', () => {
    expect(heldScroll(undefined, columns, 8)).toBeUndefined()
    expect(heldScroll(LIVE_SCROLL, [...columns, column(9, 1, false)], 8)).toEqual(LIVE_SCROLL)
  })

  it('measures the tallest column, and the newest Turn', () => {
    expect(tallestColumn([column(1, 3), column(2, 30)])).toBe(30)
    expect(tallestColumn([])).toBe(0)
    expect(newestTurnOf(columns)).toBe(8)
    expect(newestTurnOf([])).toBeUndefined()
  })
})

describe('the rails', () => {
  it('anchors the thumb at the live end and travels the whole track', () => {
    const live = railGeometry(390, 10, 20, 0)
    expect(live.scrollable).toBe(true)
    expect(live.offset).toBe(390 - live.thumb)
    const end = railGeometry(390, 10, 20, 10)
    expect(end.offset).toBe(0)
    const half = railGeometry(390, 10, 20, 5)
    expect(half.offset).toBe(Math.round((390 - half.thumb) / 2))
  })

  it('sizes the thumb by the fraction of the content that fits', () => {
    expect(railGeometry(200, 10, 20, 0).thumb).toBe(100)
    expect(railGeometry(200, 5, 20, 0).thumb).toBe(50)
    expect(railGeometry(200, 20, 20, 0).thumb).toBe(200)
  })

  it('never lets the thumb vanish into an ungrabbable sliver', () => {
    const tiny = railGeometry(300, 2, 400, 0)
    expect(tiny.thumb).toBe(RAIL_MIN_THUMB)
    expect(tiny.offset).toBe(300 - RAIL_MIN_THUMB)
    expect(railGeometry(8, 2, 400, 0).thumb).toBe(8)
  })

  it('offers no travel when the content fits', () => {
    const fits = railGeometry(200, 12, 12, 0)
    expect(fits.scrollable).toBe(false)
    expect(fits.thumb).toBe(200)
    expect(fits.offset).toBe(0)
    expect(railGeometry(0, 0, 0, 0)).toEqual({ track: 0, thumb: 0, offset: 0, scrollable: false })
  })

  it('never returns a thumb or an offset outside the track', () => {
    for (const [track, view, content, offset] of [[390, 10, 20, 99], [390, 10, 20, -5], [1, 1, 1, 0], [40, 3, 100, 97]]) {
      const geometry = railGeometry(track!, view!, content!, offset!)
      expect(geometry.thumb).toBeLessThanOrEqual(geometry.track)
      expect(geometry.offset).toBeGreaterThanOrEqual(0)
      expect(geometry.offset + geometry.thumb).toBeLessThanOrEqual(geometry.track)
    }
  })

  it('agrees with the window about how much is hidden on each side', () => {
    const columns = Array.from({ length: 9 }, (_, index) => column(index + 1, 3, index !== 8))
    const capacity = 4
    const view = boardWindow(columns, metricsOf(capacity, 6), { back: 3, up: 0 })
    const h = railGeometry(200, capacity, columns.length + view.lead, view.scroll.back)
    expect(view.newer).toBe(3)
    expect(view.older).toBe(2)
    expect(view.limitScroll.back).toBe(5)
    expect(h.offset).toBe(Math.round((200 - h.thumb) * (1 - 3 / 5)))
    expect(pitchX(metricsOf(capacity, 6))).toBe(BRICK_W + GAP)
    expect(pitchY(metricsOf(capacity, 6))).toBe(BRICK_H + GAP)
  })
})
