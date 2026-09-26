/**
 * Browser-half entry.
 *
 * The board renders **nothing into the seat it is mounted in**: the bricks are a body-level
 * overlay parked in the blank gutter beside the transcript, because no seat exists there. The
 * seat's only job is to hand this component the session it belongs to, which is the one thing the
 * board cannot work out for itself.
 *
 * Compared with the full line, this half has no conversation-node definition, no chat-store
 * selector, no panel, no navigation and no `ui-chat` dependency at all: a brick's colour and
 * number arrive complete over the plugin's own route, so the browser never needs to look at the
 * conversation to draw one.
 */
import { useEffect, useRef } from 'react'
// The renderer declares `Context.slots` and the conversation package declares the dock seat this
// half registers into; both are type-only imports (no runtime dependency on either).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import { CacheBoard } from './cache-board'
import { BrickFeedClient } from './feed'
import type { BrickFeed } from '../shared/cache-brick'

/** The session-scoped props the conversation dock seat delivers. */
interface CacheBricksSeatProps {
  /** Session this seat belongs to (session-scoped seat), when the carrier provides it. */
  sessionId?: string
}

/**
 * The seat: mount the board, follow the session's bricks, draw them.
 *
 * The board is created once and driven imperatively — it lives outside React's tree, so a render
 * must never re-create it. The feed subscription is keyed by session, so switching sessions
 * changes what the board draws and nothing else.
 */
function CacheBricksSeat(props: CacheBricksSeatProps): null {
  const boardRef = useRef<CacheBoard | undefined>(undefined)
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined

  useEffect(() => {
    const board = new CacheBoard()
    boardRef.current = board
    board.start()
    return () => {
      boardRef.current = undefined
      board.dispose()
    }
  }, [])

  useEffect(() => {
    if (sessionId === undefined || sessionId === '') return undefined
    const client = new BrickFeedClient()
    let last: BrickFeed | undefined
    const stop = client.start(sessionId, (feed) => {
      // The board only repaints when the bricks actually changed: a reconnect that re-sends the
      // same list is not a reason to touch the DOM.
      if (feed === last) return
      last = feed
      boardRef.current?.setFeed(feed)
    })
    return () => {
      stop()
      boardRef.current?.setFeed(undefined)
    }
  }, [sessionId])

  return null
}

/**
 * The service this half needs. Declared here rather than at module scope so a composition
 * without a slot registry fails to activate this half only — the host half keeps counting
 * requests, and the board simply never appears.
 */
export const inject = ['slots']

/**
 * Register the board's seat.
 *
 * `conversation.composer.dock` is the session-scoped seat that carries `sessionId`; the board
 * anchors itself to the transcript's own scrollport from there.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'cache-bricks',
    order: 1,
  }, CacheBricksSeat))
}
