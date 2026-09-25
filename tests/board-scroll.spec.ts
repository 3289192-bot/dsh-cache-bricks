/**
 * The board's window: what a pan shows, what it hides, and what the rails claim.
 *
 * The rails are the first feature that lets a reader move the board without moving the
 * conversation, so the arithmetic that decides "what is inside the frame" is pure and
 * tested here rather than inside the DOM. Two things are being pinned:
 *
 * 1. **1.7.1 still holds.** At pan 0 the window shows exactly the columns and rows the
 *    frozen board showed, with the same cell placement — a session that never touches a
 *    rail must look untouched (the equivalence is asserted against `visibleColumns` itself,
 *    not against a copy of its arithmetic).
 * 2. **A window is a window.** Neither axis may show a brick outside the frame, count a
 *    hidden column as visible, or offer a pan the content cannot honour.
 */
import { describe, expect, it } from 'vitest'
import {
  BRICK_H,
  BRICK_W,
  GAP,
  LIVE_SCROLL,
  RAIL_MIN_THUMB,
  auxLaneRow,
  boardWindow,
  cellPlacement,
  clampScroll,
  columnRowLimit,
  leadOf,
  liveScroll,
  pitchX,
  pitchY,
  railGeometry,
  scrollLimit,
  tallestColumn,
  visibleColumns,
  windowCell,
  windowColumns,
  type BoardColumn,
  type BoardMetrics,
} from '../src/client/tetris'

/** One column of `count` bricks (the same shape `tetris.spec.ts` uses). */
function column(turn: number, count: number, ended = true): BoardColumn {
  return {
    turn,
    ended,
    bricks: Array.from({ length: count }, (_, index) => ({
      turn,
      step: index + 1,
      tone: 'good' as const,
      label: '99.2%',
      kind: 'tool' as const,
      target: { kind: 'assistant-step' as const, turn, step: index + 1 },
    })),
  }
}

/** A window of `columns` x `rows` bricks. */
function metrics(columns: number, rows: number): BoardMetrics {
  return { width: BRICK_W, height: BRICK_H, gap: GAP, columns, rows }
}

describe('the window at pan 0 is the board 1.7.1 drew', () => {
  const cases: readonly (readonly [number, number])[] = [
    [1, 5], [3, 4], [3, 3], [5, 3], [8, 4], [12, 10], [20, 10],
  ]

  it('shows the same Turns, in the same order, with the same placement', () => {
    for (const [turns, capacity] of cases) {
      const columns = Array.from({ length: turns }, (_, index) => column(index + 1, 2, index + 1 !== turns || turns === 1))
      const frozen = visibleColumns(columns, capacity)
      const window = boardWindow(columns, metrics(capacity, 6), undefined, false)
      expect(window.columns.map((entry) => entry.turn)).toEqual(frozen.columns.map((entry) => entry.turn))
      expect(window.lead).toBe(frozen.lead)
      expect(window.older).toBe(frozen.evicted)
      expect(window.newer).toBe(0)
      expect(window.scroll).toEqual(LIVE_SCROLL)
      // Same pixels: cell placement for the newest-first distance 1.7.1 used.
      const newest = columns.length - 1
      for (let index = 0; index < window.columns.length; index += 1) {
        const turn = window.columns[index]!.turn
        const source = columns.findIndex((entry) => entry.turn === turn)
        const frozenDistance = newest - source + frozen.lead
        const cell = windowCell(newest - source, 0, window.lead, window.scroll, capacity, window.limit)!
        expect(cell.column).toBe(frozenDistance)
        expect(cellPlacement(metrics(capacity, 6), cell.column, cell.row))
          .toEqual(cellPlacement(metrics(capacity, 6), frozenDistance, 0))
      }
    }
  })

  it('keeps the lane and the column limit the board already had', () => {
    const columns = [column(1, 2), column(2, 2, false)]
    const withLane = boardWindow(columns, metrics(4, 6), undefined, true)
    expect(withLane.lane).toBe(auxLaneRow(metrics(4, 6), true))
    expect(withLane.limit).toBe(columnRowLimit(metrics(4, 6), true))
    const without = boardWindow(columns, metrics(4, 6), undefined, false)
    expect(without.lane).toBeUndefined()
    expect(without.limit).toBe(6)
  })

  it('leaves a column taller than the board showing its floor rows, as it did', () => {
    const tall = [column(1, 20), column(2, 3, false)]
    const window = boardWindow(tall, metrics(4, 6), undefined, false)
    // Rows 0..5 of Turn 1 are inside; the rest is one pan away rather than gone.
    expect(windowCell(1, 0, 0, window.scroll, 4, window.limit)).toEqual({ column: 1, row: 0 })
    expect(windowCell(1, 5, 0, window.scroll, 4, window.limit)).toEqual({ column: 1, row: 5 })
    expect(windowCell(1, 6, 0, window.scroll, 4, window.limit)).toBeUndefined()
    expect(window.limitScroll.up).toBe(14)
    expect(window.tallest).toBe(20)
  })
})

describe('panning', () => {
  const columns = Array.from({ length: 8 }, (_, index) => column(index + 1, 2, index !== 7))

  it('reveals older Turns and counts what it left behind', () => {
    const live = boardWindow(columns, metrics(4, 6), undefined, false)
    const panned = boardWindow(columns, metrics(4, 6), { back: 2, up: 0 }, false)
    expect(live.columns.map((entry) => entry.turn)).toEqual([5, 6, 7, 8])
    expect(panned.columns.map((entry) => entry.turn)).toEqual([3, 4, 5, 6])
    expect(panned.newer).toBe(2)
    expect(panned.older).toBe(2)
  })

  it('stops at the oldest Turn rather than running past it', () => {
    const limit = scrollLimit(columns, 4, 6, leadOf(columns))
    expect(limit.back).toBe(4)
    const end = boardWindow(columns, metrics(4, 6), { back: 99, up: 0 }, false)
    expect(end.scroll.back).toBe(limit.back)
    expect(end.columns.map((entry) => entry.turn)).toEqual([1, 2, 3, 4])
    expect(end.older).toBe(0)
    // Nothing left to the left, and something to the right: the fades read the same numbers.
    expect(end.newer).toBe(4)
  })

  it('counts the reserved lead cell as content, so it can be panned into view', () => {
    const finished = [column(1, 2), column(2, 2)]
    // Two Turns and the lead cell need three cells; a two-cell window cannot hold them.
    expect(scrollLimit(finished, 2, 6, leadOf(finished)).back).toBe(1)
    const live = boardWindow(finished, metrics(2, 6), undefined, false)
    // At the live corner the lead cell is the free slot on the right, so only one Turn fits.
    expect(live.columns.map((entry) => entry.turn)).toEqual([2])
    const panned = boardWindow(finished, metrics(2, 6), { back: 1, up: 0 }, false)
    expect(panned.columns.map((entry) => entry.turn)).toEqual([1, 2])
    expect(panned.limitScroll.back).toBe(1)
  })

  it('clamps a pan that asks for more than exists', () => {
    expect(clampScroll({ back: -3, up: -1 }, { back: 4, up: 2 })).toEqual(LIVE_SCROLL)
    expect(clampScroll({ back: 9, up: 9 }, { back: 4, up: 2 })).toEqual({ back: 4, up: 2 })
    expect(clampScroll({ back: 1.6, up: 0.4 }, { back: 4, up: 2 })).toEqual({ back: 2, up: 0 })
    expect(clampScroll({ back: 0, up: 0 }, LIVE_SCROLL)).toEqual(LIVE_SCROLL)
  })

  it('never shows a brick outside the frame', () => {
    const capacity = 4
    const limit = 3
    const window = boardWindow(columns, metrics(capacity, limit), { back: 3, up: 0 }, false)
    for (const columnEntry of columns) {
      for (let row = 0; row < columnEntry.bricks.length; row += 1) {
        const cell = windowCell(columns.length - 1 - (columnEntry.turn - 1), row, window.lead, window.scroll, capacity, limit)
        if (cell === undefined) continue
        expect(cell.column).toBeGreaterThanOrEqual(0)
        expect(cell.column).toBeLessThanOrEqual(capacity - 1)
        expect(cell.row).toBeGreaterThanOrEqual(0)
        expect(cell.row).toBeLessThanOrEqual(limit - 1)
      }
    }
  })

  it('keeps the columns it shows adjacent and in order', () => {
    const window = boardWindow(columns, metrics(4, 6), { back: 2, up: 0 }, false)
    const distances = window.columns.map((entry) => columns.length - 1 - columns.indexOf(entry) + window.lead - window.scroll.back)
    for (let index = 1; index < distances.length; index += 1) {
      // One cell apart, descending towards the newest side: no gaps, no reordering.
      expect(distances[index - 1]! - distances[index]!).toBe(1)
    }
  })

  it('moves rows without touching columns', () => {
    const cell = windowCell(0, 4, 0, { back: 0, up: 2 }, 4, 6)
    expect(cell).toEqual({ column: 0, row: 2 })
    // Rows 2..7 are inside a six-row window raised by two; row 8 is above it.
    expect(windowCell(0, 1, 0, { back: 0, up: 2 }, 4, 6)).toBeUndefined()
    expect(windowCell(0, 7, 0, { back: 0, up: 2 }, 4, 6)).toEqual({ column: 0, row: 5 })
    expect(windowCell(0, 8, 0, { back: 0, up: 2 }, 4, 6)).toBeUndefined()
  })

  it('hides rows outside the lane-adjusted limit', () => {
    // With the lane shown the columns may fill one row less: rows 0..4 of a five-row
    // pane are inside, and row 5 — the lane's own row — is not a column row at all.
    expect(windowCell(0, 4, 0, LIVE_SCROLL, 4, 5)).toEqual({ column: 0, row: 4 })
    expect(windowCell(0, 5, 0, LIVE_SCROLL, 4, 5)).toBeUndefined()
    expect(windowCell(0, 5, 0, LIVE_SCROLL, 4, 6)).toEqual({ column: 0, row: 5 })
  })
})

describe('the live anchor', () => {
  it('follows the floor while the running Turn fits', () => {
    expect(liveScroll([column(1, 3), column(2, 5, false)], 6)).toEqual(LIVE_SCROLL)
  })

  it('rises just far enough to keep the newest brick of a Turn taller than the board', () => {
    expect(liveScroll([column(1, 3), column(2, 12, false)], 6)).toEqual({ back: 0, up: 6 })
    // And the brick that just landed is the one at the top of the window.
    const window = boardWindow([column(1, 3), column(2, 12, false)], metrics(4, 6), undefined, false)
    expect(windowCell(0, 11, 0, window.scroll, 4, 6)).toEqual({ column: 0, row: 5 })
  })

  it('is not raised by an older Turn, however tall', () => {
    const columns = [column(1, 30), column(2, 4, false)]
    expect(liveScroll(columns, 6)).toEqual(LIVE_SCROLL)
    // History is what the vertical rail is for, and it says so.
    expect(scrollLimit(columns, 4, 6, 0).up).toBe(24)
    expect(tallestColumn(columns)).toBe(30)
  })

  it('follows the floor again once the tall Turn has ended', () => {
    expect(liveScroll([column(1, 3), column(2, 12)], 6)).toEqual(LIVE_SCROLL)
  })
})

describe('rail geometry', () => {
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
    // The lower bound is a grab handle, not a claim: the position is still exact.
    expect(tiny.offset).toBe(300 - RAIL_MIN_THUMB)
    expect(railGeometry(8, 2, 400, 0).thumb).toBe(8)
    expect(RAIL_MIN_THUMB).toBeGreaterThanOrEqual(12)
  })

  it('offers no travel when the content fits', () => {
    const fits = railGeometry(200, 12, 12, 0)
    expect(fits.scrollable).toBe(false)
    expect(fits.thumb).toBe(200)
    expect(fits.offset).toBe(0)
    // A degenerate track (a hidden board) is not a division by zero.
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
})

describe('the rails describe the same board the window shows', () => {
  it('agrees on how much is hidden on each side', () => {
    const columns = Array.from({ length: 9 }, (_, index) => column(index + 1, 3, index !== 8))
    const capacity = 4
    const view = boardWindow(columns, metrics(capacity, 6), { back: 3, up: 0 }, false)
    const h = railGeometry(200, capacity, columns.length + view.lead, view.scroll.back)
    // Three of the nine cells sit to the right of the frame and two to the left: the thumb
    // is exactly as far from the live end as the three hidden cells are of the whole travel.
    expect(view.newer).toBe(3)
    expect(view.older).toBe(2)
    expect(view.limitScroll.back).toBe(5)
    expect(h.offset).toBe(Math.round((200 - h.thumb) * (1 - 3 / 5)))
    expect(pitchX(metrics(capacity, 6))).toBe(BRICK_W + GAP)
    expect(pitchY(metrics(capacity, 6))).toBe(BRICK_H + GAP)
  })
})
