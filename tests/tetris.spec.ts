import { describe, expect, it } from 'vitest'
import {
  ACTIVITY,
  ERROR_COLOR,
  spanMaterial,
  spanTtftColor,
  SPAN_OPACITY,
  SPAN_RADIUS,
  toneAt,
  toneMark,
  TRAJECTORY_TONE,
  TONE_WEIGHT_RESTING,
  BRICK_H,
  BRICK_W,
  CHANNEL,
  FLIP_LABEL,
  GAP,
  LIFECYCLE,
  MAX_ROWS,
  REASONING_CHARS_PER_TOOL_CALL,
  TONE_TEXT,
  TONE_WEIGHT,
  brickAriaLabel,
  brickEdges,
  faceEnglish,
  faceLabel,
  faceSegments,
  flipTransform,
  reasoningShare,
  revealTarget,
  toggledFace,
  TONE_BRICK,
  TONE_EDGE,
  auxLaneRow,
  brickKey,
  brickTitle,
  columnRowLimit,
  cellPlacement,
  fitBoard,
  rowLimit,
  visibleColumns,
  type ActivityTone,
  type BoardColumn,
} from '../src/client/tetris'
import type { CacheTone } from '../src/client/logic'

/** Every official lane, so a palette test can prove the board defines all of them. */
const TONES: readonly ActivityTone[] = ['input', 'model', 'tool', 'context', 'system']

/** One column of `count` bricks. */
function column(turn: number, count: number, tone: CacheTone = 'good', ended = true): BoardColumn {
  return {
    turn,
    ended,
    bricks: Array.from({ length: count }, (_, index) => ({
      turn,
      step: index + 1,
      tone,
      label: '99.2%',
      kind: 'tool' as const,
      target: { kind: 'assistant-step' as const, turn, step: index + 1 },
    })),
  }
}

describe('fitBoard', () => {
  it('fits whole bricks into the gutter', () => {
    const metrics = fitBoard(BRICK_W * 4 + GAP * 3, BRICK_H * 6 + GAP * 5)
    expect(metrics).toEqual({ width: BRICK_W, height: BRICK_H, gap: GAP, columns: 4, rows: 6 })
  })

  it('keeps the brick wide enough to print its reading', () => {
    // `99.2%` at 9px monospace needs roughly this much room; a square brick could
    // not carry a label, which is why the brick is a slab.
    expect(BRICK_W).toBeGreaterThanOrEqual(34)
    expect(BRICK_W).toBeGreaterThan(BRICK_H)
  })

  it('fills the visible band, with only a pathological bound', () => {
    // A 1080p window offers roughly this band above the composer; the board is
    // meant to use it, not to stop at a short stack.
    const band = BRICK_H * 40 + GAP * 39
    expect(fitBoard(BRICK_W * 6, band)!.rows).toBe(40)
    expect(fitBoard(BRICK_W * 6, BRICK_H * 500)!.rows).toBe(MAX_ROWS)
    expect(MAX_ROWS).toBeGreaterThanOrEqual(40)
  })

  it('refuses a gutter too small to read as a board', () => {
    expect(fitBoard(BRICK_W, BRICK_H * 10)).toBeUndefined()
    expect(fitBoard(BRICK_W * 10, BRICK_H * 2)).toBeUndefined()
  })
})

describe('visibleColumns', () => {
  it('anchors the newest column and pushes the old ones off the left', () => {
    const columns = [column(1, 2), column(2, 1), column(3, 4, 'good', false)]
    const { columns: visible, evicted, lead } = visibleColumns(columns, 2)
    expect(visible.map((entry) => entry.turn)).toEqual([2, 3])
    expect(evicted).toBe(1)
    expect(lead).toBe(0)
  })

  it('reserves the right column once the newest task has finished', () => {
    const finished = visibleColumns([column(1, 1), column(2, 3)], 4)
    expect(finished.lead).toBe(1)
    expect(finished.evicted).toBe(0)
    const running = visibleColumns([column(1, 1), column(2, 3, 'good', false)], 4)
    expect(running.lead).toBe(0)
  })

  it('lets the oldest turn leave the frame when the reserved column is needed', () => {
    const columns = [column(1, 1), column(2, 1), column(3, 1)]
    const { columns: visible, lead, evicted } = visibleColumns(columns, 3)
    // Capacity counts the reserved column: the finished stack plus the free
    // column for the next task is all the board can hold.
    expect(visible.map((entry) => entry.turn)).toEqual([2, 3])
    expect(lead).toBe(1)
    expect(evicted).toBe(1)
  })

  it('keeps everything while it fits', () => {
    const { columns: visible, evicted } = visibleColumns([column(1, 1)], 5)
    expect(visible).toHaveLength(1)
    expect(evicted).toBe(0)
  })

  it('shows nothing when the board has no room', () => {
    const { columns: visible, evicted } = visibleColumns([column(1, 1)], 0)
    expect(visible).toEqual([])
    expect(evicted).toBe(1)
  })
})

describe('cellPlacement', () => {
  const metrics = { width: BRICK_W, height: BRICK_H, gap: GAP, columns: 4, rows: 6 }
  const pitchX = BRICK_W + GAP
  const pitchY = BRICK_H + GAP

  it('rests the newest column against the right edge and the floor', () => {
    expect(cellPlacement(metrics, 0, 0)).toEqual({ right: 0, bottom: 0 })
  })

  it('steps one brick left per older turn and one brick up per earlier step', () => {
    expect(cellPlacement(metrics, 1, 0)).toEqual({ right: pitchX, bottom: 0 })
    expect(cellPlacement(metrics, 0, 2)).toEqual({ right: 0, bottom: pitchY * 2 })
  })

  it('bounds a column by the board height', () => {
    expect(rowLimit(metrics)).toBe(6)
  })
})

describe('the auxiliary lane', () => {
  const metrics = { width: BRICK_W, height: BRICK_H, gap: GAP, columns: 4, rows: 6 }

  it('takes the board’s top row only when there is something to show', () => {
    expect(auxLaneRow(metrics, false)).toBeUndefined()
    expect(auxLaneRow(metrics, true)).toBe(5)
    // The Turn columns stop below the lane rather than growing into it.
    expect(columnRowLimit(metrics, false)).toBe(6)
    expect(columnRowLimit(metrics, true)).toBe(5)
  })

  it('keeps at least one column row, however short the board is', () => {
    const tiny = { ...metrics, rows: 3 }
    expect(columnRowLimit(tiny, true)).toBe(2)
    expect(columnRowLimit({ ...metrics, rows: 1 }, true)).toBe(1)
  })
})

describe('brick identity and copy', () => {
  it('keys one brick per turn and step', () => {
    expect(brickKey(3, 2)).toBe('3:2')
    expect(brickKey(3, 2)).not.toBe(brickKey(3, 3))
  })

  it('titles a brick with its turn, step, activity and reading', () => {
    const brick = {
      turn: 4,
      step: 1,
      tone: 'good' as const,
      kind: 'output' as const,
      target: { kind: 'assistant-step' as const, turn: 4, step: 1 },
    }
    const title = brickTitle(brick, '99.2% · cached 150k')
    expect(title).toContain('turn 4 · step 1')
    expect(title).toContain('答复 visible output')
    expect(title).toContain('99.2% · cached 150k')
    expect(brickTitle(brick, undefined)).not.toContain('undefined')
  })

  it('names a split brick by both halves, and never prints a label it does not have', () => {
    const title = brickTitle({
      turn: 4,
      step: 1,
      tone: 'good',
      kind: 'mixed',
      target: { kind: 'assistant-step', turn: 4, step: 1 },
    }, undefined)
    expect(title).toContain('思考 + 工具')
    expect(title).not.toContain('undefined')
  })

  it('carries the lane and the specific in the tooltip, since the face prints neither', () => {
    const title = brickTitle({
      turn: 4,
      step: 1,
      tone: 'good',
      kind: 'tool',
      detail: 'bash',
      target: { kind: 'assistant-step', turn: 4, step: 1 },
    }, undefined)
    expect(title).toContain('TOOL')
    expect(title).toContain('工具 tool call, no reasoning')
    expect(title).toContain('bash')
  })

  it('spells out a lifecycle mark instead of hiding it in a glyph', () => {
    const title = brickTitle({
      turn: 4,
      step: 1,
      tone: 'good',
      kind: 'tool',
      abnormal: 'failed',
      target: { kind: 'assistant-step', turn: 4, step: 1 },
    }, undefined)
    expect(title).toContain('! failed')
    expect(brickTitle({
      turn: 4,
      step: 1,
      tone: 'good',
      kind: 'tool',
      abnormal: 'retry',
      target: { kind: 'retry-chain', turn: 4, step: 1, retryId: 'r' },
    }, undefined)).toContain('↻ retried')
  })

  it('tells a screen reader the activity, and what activating the brick does', () => {
    const label = brickAriaLabel({
      turn: 4,
      step: 1,
      tone: 'good',
      kind: 'tool',
      target: { kind: 'assistant-step', turn: 4, step: 1 },
    }, '99.2%')
    expect(label).toContain('工具 tool call, no reasoning')
    // Both gestures are spelled out, and the locating one names where it goes: "locates" alone
    // does not tell a screen reader whether to use it.
    expect(label).toContain('单击 / Enter 预览对话')
    expect(label).toContain('双击 / Shift+Enter 定位到第 4 轮并高亮')
  })
})

describe('the activity face (the board’s other side)', () => {
  it('names each kind and gives it one of the official lanes', () => {
    expect(Object.keys(ACTIVITY).sort()).toEqual(['auxiliary', 'mixed', 'output', 'reasoning', 'tool'])
    for (const kind of Object.keys(ACTIVITY) as (keyof typeof ACTIVITY)[]) {
      expect(ACTIVITY[kind].english.length).toBeGreaterThan(0)
      expect(TONES).toContain(ACTIVITY[kind].tone)
    }
    // Thinking and answering are both the model lane: the colour says which lane, the label
    // says what happened in it. Tool work is the tools lane, and a compaction is system.
    expect(ACTIVITY.reasoning.tone).toBe('model')
    expect(ACTIVITY.output.tone).toBe('model')
    expect(ACTIVITY.tool.tone).toBe('tool')
    expect(ACTIVITY.auxiliary.tone).toBe('system')
    expect([...ACTIVITY.reasoning.label]).toHaveLength(2)
  })

  it('borrows the official trajectory colours as tokens, never as copied hex', () => {
    // Verbatim from the installed `dsh-client-ui-trajectory`
    // (`[data-timeline-span=user|message|subtool|context]`): the board speaks the vocabulary
    // a reader already has from the trajectory view, and follows the app's theme with it.
    expect(TRAJECTORY_TONE.input).toBe('var(--dsw-alias-state-business-primary)')
    expect(TRAJECTORY_TONE.tool).toBe('var(--dsw-alias-state-warn-label)')
    expect(TRAJECTORY_TONE.system).toBe('var(--dsw-alias-label-secondary)')
    expect(TRAJECTORY_TONE.model).toContain('--dsw-alias-brand-primary-new-colorprimary-new-color')
    expect(TRAJECTORY_TONE.model).toContain('--dsw-alias-state-error-secondary')
    expect(TRAJECTORY_TONE.context).toContain('--dsw-alias-state-success-primary')
    for (const expression of Object.values(TRAJECTORY_TONE)) {
      // Nothing hard-coded: every tone is either a token or a mix of tokens.
      expect(expression.includes('#')).toBe(false)
    }
    // The error colour is a state, painted on the rim, not a lane.
    expect(ERROR_COLOR).toBe('var(--dsw-alias-state-error-primary)')
  })

  it('keeps two lanes the board cannot currently produce, and says so by test', () => {
    // `input` and `context` are the trajectory's other two spans. No brick maps to them,
    // because the frozen contract makes a brick a dispatched model call — an assertion here
    // means a future kind cannot quietly start wearing one of them.
    const reachable = new Set(Object.values(ACTIVITY).map((face) => face.tone))
    expect([...reachable].sort()).toEqual(['model', 'system', 'tool'])
    expect(TONES).toContain('input')
    expect(TONES).toContain('context')
  })

  it('mixes a tone down to the board’s weight, and leaves the lit brick at full strength', () => {
    expect(toneAt(TRAJECTORY_TONE.tool, TONE_WEIGHT_RESTING))
      .toBe(`color-mix(in srgb, var(--dsw-alias-state-warn-label) 50%, var(--dsw-alias-bg-base))`)
    const rested = faceSegments('tool')
    expect(rested).toEqual([{ tone: 'tool', label: '工具', color: toneAt(TRAJECTORY_TONE.tool, TONE_WEIGHT_RESTING), share: 1 }])
    const lit = faceSegments('tool', { highlight: true })
    expect(lit[0]!.color).toBe(TRAJECTORY_TONE.tool)
  })

  it('draws a mixed brick as the model half and the tool half, in proportion', () => {
    const mixed = faceSegments('mixed', { portion: 0.25 })
    expect(mixed.map((segment) => segment.tone)).toEqual(['model', 'tool'])
    expect(mixed[0]!.share).toBeCloseTo(0.25)
    expect(mixed[0]!.share + mixed[1]!.share).toBeCloseTo(1)
    // Lighting up never moves the seam: the proportions are the measurement.
    const bright = faceSegments('mixed', { portion: 0.25, highlight: true })
    expect(bright.map((segment) => segment.share)).toEqual(mixed.map((segment) => segment.share))
    expect(bright[0]!.color).toBe(TRAJECTORY_TONE.model)
  })

  it('clamps the seam so neither half can vanish', () => {
    const lopsided = faceSegments('mixed', { portion: 0.99, floor: 0.14 })
    expect(lopsided[0]!.share).toBeCloseTo(0.86)
    expect(lopsided[1]!.share).toBeCloseTo(0.14)
    expect(faceSegments('mixed', { portion: -1, floor: 0.14 })[0]!.share).toBeCloseTo(0.14)
  })

  it('weighs reasoning against tool calls, and splits evenly when there is nothing to weigh', () => {
    expect(reasoningShare(0, 1)).toBe(0)
    expect(reasoningShare(REASONING_CHARS_PER_TOOL_CALL, 1)).toBeCloseTo(0.5)
    expect(reasoningShare(0, 0)).toBe(0.5)
    expect(reasoningShare(-5, -5)).toBe(0.5)
  })

  it('names the lane in one word, for the tooltip rather than the face', () => {
    expect(toneMark('reasoning')).toBe('MODEL')
    expect(toneMark('output')).toBe('MODEL')
    expect(toneMark('tool')).toBe('TOOL')
    expect(toneMark('mixed')).toBe('MODEL')
    expect(toneMark('auxiliary')).toBe('SYS')
  })

  it('marks a lifecycle with a glyph, never with a colour', () => {
    expect(LIFECYCLE.retry.glyph).toBe('↻')
    expect(LIFECYCLE.failed.glyph).toBe('!')
    expect(LIFECYCLE.interrupted.glyph).toBe('⏹')
    expect(LIFECYCLE['max-tokens'].glyph).toBe('⌁')
    const glyphs = Object.values(LIFECYCLE).map((mark) => mark.glyph)
    expect(new Set(glyphs).size).toBe(glyphs.length)
  })

  it('draws the type face the way the official timeline draws a span', () => {
    // Measured from `dsh-client-ui-trajectory`: `.span { height: 8px; border-radius: 1px;
    // opacity: .78 }`, with the lanes that matter overriding the opacity to 1. Flat, no rim,
    // no shadow — the official appearance is the fill and nothing else.
    expect(spanMaterial(TRAJECTORY_TONE.tool)).toEqual({ background: TRAJECTORY_TONE.tool, radius: '1px' })
    expect(SPAN_RADIUS).toBe('1px')
    expect(SPAN_OPACITY).toEqual({ dim: 0.78, solid: 1 })
  })

  it('gives a model span the official TTFT gradient, and nothing else one', () => {
    const waiting = spanMaterial(TRAJECTORY_TONE.model, {
      ttftShare: 0.2,
      ttftColor: spanTtftColor(TRAJECTORY_TONE.model),
    })
    // `[data-timeline-span=message][data-assistant-timing=true]`: the first `ttft` share of the
    // width in the lighter colour, the rest in the decoding colour.
    expect(waiting.background).toContain('linear-gradient(to right')
    expect(waiting.background).toContain('20%')
    expect(waiting.background).toContain(spanTtftColor(TRAJECTORY_TONE.model))
    expect(spanTtftColor(TRAJECTORY_TONE.model))
      .toBe(`color-mix(in srgb, ${TRAJECTORY_TONE.model} 54%, var(--dsw-alias-bg-layer-2))`)
    // An imperceptible wait, and an unknown one, both leave the span flat.
    expect(spanMaterial(TRAJECTORY_TONE.model, { ttftShare: 0.01, ttftColor: '#ffffff' }).background)
      .toBe(TRAJECTORY_TONE.model)
    expect(spanMaterial(TRAJECTORY_TONE.model).background).toBe(TRAJECTORY_TONE.model)
  })

  it('turns the whole board over, and names the destination', () => {
    expect(flipTransform('cache')).toBe('rotateY(0deg)')
    expect(flipTransform('type')).toBe('rotateY(180deg)')
    expect(toggledFace('cache')).toBe('type')
    expect(toggledFace('type')).toBe('cache')
    expect(FLIP_LABEL.cache).toBe('类型')
    expect(FLIP_LABEL.type).toBe('缓存')
  })
})

describe('the channel grammar (computed, not painted)', () => {
  const base = { reasoning: false, tools: false, output: false, inputChange: false, auxiliary: false }

  it('still derives every channel, so the hover text can name them', () => {
    expect(brickEdges({ content: { ...base, output: true } })).toEqual({ right: CHANNEL.output })
    const rich = brickEdges({ content: { ...base, reasoning: true, tools: true, output: true } })
    expect(rich).toEqual({ top: CHANNEL.reasoning, bottom: CHANNEL.tools, right: CHANNEL.output })
    expect(brickEdges({ content: { ...base, auxiliary: true } }).left).toBe(CHANNEL.auxiliary)
    expect(brickEdges({ content: base, abnormal: 'failed' }).ring).toBe(CHANNEL.failure)
  })

  it('keeps every channel hue clear of the cache fills', () => {
    const fills = new Set([TONE_BRICK.good, TONE_BRICK.warn, TONE_BRICK.critical, TONE_BRICK.minor])
    for (const color of Object.values(CHANNEL)) expect(fills.has(color)).toBe(false)
  })
})

describe('revealTarget', () => {
  it('puts the row a quarter down the viewport, and never past either end', () => {
    expect(revealTarget(1000, 10_000, 800)).toBe(800)
    // Near the top it clamps to zero rather than scrolling above the start.
    expect(revealTarget(100, 10_000, 800)).toBe(0)
    // Near the bottom it clamps to the last scrollable position.
    expect(revealTarget(9700, 10_000, 800)).toBe(9200)
  })
})

describe('colours', () => {
  it('paints the alarming tone red and keeps every tone distinguishable', () => {
    expect(TONE_BRICK.critical).toBe('#dc2626')
    expect(new Set([TONE_BRICK.good, TONE_BRICK.warn, TONE_BRICK.critical, TONE_BRICK.minor]).size).toBe(4)
    expect(TONE_BRICK.unknown).toBe(TONE_BRICK.minor)
    expect(TONE_EDGE.critical).not.toBe(TONE_BRICK.critical)
    // Every brick carries printed text, so every tone needs a legible text colour.
    expect(TONE_TEXT.critical).toBe('#ffffff')
    expect(TONE_TEXT.good).not.toBe(TONE_BRICK.good)
    expect(new Set(Object.values(TONE_TEXT)).size).toBeGreaterThan(1)
  })

  it('keeps a healthy pile quiet and only bolds what alarms', () => {
    // A wall of saturated green would bury the red brick the board exists for.
    expect(TONE_BRICK.good.startsWith('rgba')).toBe(true)
    expect(TONE_BRICK.critical.startsWith('#')).toBe(true)
    expect(TONE_WEIGHT.good).toBe('500')
    expect(TONE_WEIGHT.critical).toBe('700')
    expect(TONE_WEIGHT.warn).toBe('700')
  })
})
