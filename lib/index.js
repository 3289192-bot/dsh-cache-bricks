import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
/** Whether a usage record carries at least one cache-accounting field. */
function hasCacheFields(usage) {
	if (usage === void 0) return false;
	return typeof usage.cacheReadTokens === "number" || typeof usage.cacheWriteTokens === "number";
}
/**
* The whole prompt of one call: the three disjoint buckets summed.
*
* Writing cache is not a hit — a call that paid full price for 400k tokens *and* wrote them into
* the cache is not a 99% hit — so the denominator includes what was read, what was re-billed and
* what was written.
*
* @param usage - one call's accounting.
* @returns prompt tokens, never negative.
*/
function promptTokensOf(usage) {
	return Math.max(0, usage.inputTokens) + (typeof usage.cacheReadTokens === "number" ? Math.max(0, usage.cacheReadTokens) : 0) + (typeof usage.cacheWriteTokens === "number" ? Math.max(0, usage.cacheWriteTokens) : 0);
}
/**
* Cache-read share of one call's prompt.
*
* @param usage - one call's accounting, or undefined while the provider has said nothing.
* @returns the share in [0, 1], or `null` when there is no cache field to divide by.
*/
function hitRatioOf(usage) {
	if (usage === void 0 || !hasCacheFields(usage)) return null;
	const prompt = promptTokensOf(usage);
	if (prompt <= 0) return null;
	const cached = typeof usage.cacheReadTokens === "number" ? Math.max(0, usage.cacheReadTokens) : 0;
	return Math.min(1, cached / prompt);
}
/**
* The colour of one brick.
*
* @param usage - one call's accounting.
* @returns `good`, `warn`, `bad`, or `unknown` when there is nothing honest to say.
*/
function toneOf(usage) {
	const ratio = hitRatioOf(usage);
	if (ratio === null || usage === void 0) return "unknown";
	if (promptTokensOf(usage) < 1e3) return "unknown";
	if (ratio < .7) return "bad";
	return ratio < .9 ? "warn" : "good";
}
/** Built from the settlement, so it needs no id counter and stays stable across a reload. */
function brickIdOf(sessionId, turn, step, attempt) {
	return `${sessionId}:${String(turn)}:${String(step)}:${String(attempt)}`;
}
/** Reads the last `usage` chunk out of a durable compact stream. */
function usageFromStream$1(stream) {
	let found;
	for (const record of stream ?? []) {
		if (record === null || typeof record !== "object") continue;
		const entry = record;
		if (entry.type !== "chunk" || entry.chunk?.type !== "usage") continue;
		const usage = entry.chunk.usage;
		if (usage !== void 0) found = usage;
	}
	return found;
}
/**
* Turns the harness's three channels into bricks.
*
* One tracker per session. It holds the open attempts (a handful), the bricks (a ring), and two
* counters. Nothing else — no store, no refs, no history.
*/
var AttemptTracker = class {
	sessionId;
	capacity;
	now;
	bricks = [];
	open = /* @__PURE__ */ new Map();
	ordinals = /* @__PURE__ */ new Map();
	ended = /* @__PURE__ */ new Set();
	droppedCount = 0;
	dispatchCount = 0;
	skippedSettlements = 0;
	backfilledCount = 0;
	/**
	* `(turn, step)` pairs this process has seen live.
	*
	* A step that is running *now* must not be filled in from the log: the live attempt is the one
	* that is actually being billed, and a backfilled brick for the same step would either duplicate
	* it or steal its ordinal. So the log fills the past and the live path owns the present.
	*/
	liveSteps = /* @__PURE__ */ new Set();
	constructor(sessionId, options = {}) {
		this.sessionId = sessionId;
		this.capacity = Math.max(1, options.capacity ?? 1024);
		this.now = options.now ?? Date.now;
	}
	/** A real model call was dispatched (`llm/stream`). */
	dispatched() {
		this.dispatchCount += 1;
	}
	/**
	* One `agent/assistant-stream` frame.
	*
	* Only `start` and a `usage` chunk are read. Text and reasoning deltas are not observed at
	* all: this plugin's brick does not count characters, so the cheapest handling of a delta is
	* not to look at it — which is also why a long answer costs the tracker nothing.
	*/
	frame(frame) {
		if (frame.type === "start") {
			const turn = frame.turn ?? 0;
			const step = frame.step ?? 0;
			const key = this.keyOf(turn, step);
			const ordinal = this.ordinals.get(key) ?? 0;
			this.ordinals.set(key, ordinal + 1);
			const queue = this.open.get(key) ?? [];
			queue.push({
				turn,
				step,
				ordinal,
				attemptId: frame.attemptId,
				startedAt: frame.time ?? this.now(),
				liveUsage: void 0
			});
			this.open.set(key, queue);
			return;
		}
		if (frame.type !== "chunk" || frame.chunk?.type !== "usage") return;
		const usage = frame.chunk.usage;
		if (usage === void 0) return;
		const attempt = this.newestOpen();
		if (attempt !== void 0) attempt.liveUsage = usage;
	}
	/**
	* A durable settlement landed: this is the brick.
	*
	* @param settlement - the `assistant/message` / `assistant/attempt` event's fields.
	* @returns the brick, or undefined when the event named no step (a compaction or a title call,
	*   which this version does not draw).
	*/
	settle(settlement) {
		const turn = settlement.turn;
		const step = settlement.step;
		if (typeof turn !== "number" || typeof step !== "number") {
			this.skippedSettlements += 1;
			return;
		}
		this.liveSteps.add(this.keyOf(turn, step));
		const attempt = this.takeOpen(turn, step);
		const ordinal = attempt?.ordinal ?? this.nextOrdinal(turn, step);
		const usage = settlement.usage ?? usageFromStream$1(settlement.stream) ?? attempt?.liveUsage;
		const finishedAt = settlement.time ?? this.now();
		const brick = {
			id: brickIdOf(this.sessionId, turn, step, ordinal),
			turn,
			step,
			attempt: ordinal,
			inputTokens: usage?.inputTokens ?? 0,
			cacheReadTokens: usage?.cacheReadTokens ?? 0,
			cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
			hitRatio: hitRatioOf(usage),
			startedAt: attempt?.startedAt ?? finishedAt,
			finishedAt,
			tone: toneOf(usage)
		};
		this.bricks.push(brick);
		while (this.bricks.length > this.capacity) {
			this.bricks.shift();
			this.droppedCount += 1;
		}
		return brick;
	}
	/**
	* A settlement read out of the session's own log, for a session opened after this process started.
	*
	* Same brick, same arithmetic — the log carries the billed usage — with one rule: a step this
	* process has already seen live is left alone (see {@link liveSteps}).
	*
	* @param settlement - the settlement as the log recorded it.
	* @returns the brick, or undefined when the log had nothing to add for this step.
	*/
	settleFromLog(settlement) {
		const turn = settlement.turn;
		const step = settlement.step;
		if (typeof turn !== "number" || typeof step !== "number") {
			this.skippedSettlements += 1;
			return;
		}
		if (this.liveSteps.has(this.keyOf(turn, step))) return void 0;
		const brick = this.settle(settlement);
		if (brick !== void 0) this.backfilledCount += 1;
		return brick;
	}
	/** Bricks that came out of a session log rather than from this process's own traffic. */
	get backfilled() {
		return this.backfilledCount;
	}
	/** A `turn/end` was seen: its stack may slide one cell left on the board. */
	turnEnded(turn) {
		this.ended.add(turn);
	}
	/** Every brick still in the ring, oldest first. */
	records() {
		return this.bricks;
	}
	/** Bricks the ring had to let go. */
	get dropped() {
		return this.droppedCount;
	}
	/** Real requests dispatched on this session. */
	get dispatchedCount() {
		return this.dispatchCount;
	}
	/** Settlements that named no `(turn, step)` — auxiliary calls, which have no column. */
	get skipped() {
		return this.skippedSettlements;
	}
	/** Turns known to have ended. */
	endedTurns() {
		return [...this.ended].sort((left, right) => left - right);
	}
	/** Attempts that started and never settled: requests in flight, or aborted. */
	get inFlight() {
		let count = 0;
		for (const queue of this.open.values()) count += queue.length;
		return count;
	}
	keyOf(turn, step) {
		return `${String(turn)}:${String(step)}`;
	}
	/** The oldest attempt still waiting on this step — the one this settlement belongs to. */
	takeOpen(turn, step) {
		const key = this.keyOf(turn, step);
		const queue = this.open.get(key);
		if (queue === void 0 || queue.length === 0) return void 0;
		const attempt = queue.shift();
		if (queue.length === 0) this.open.delete(key);
		return attempt;
	}
	/** Count a settlement whose start frame was never seen. */
	nextOrdinal(turn, step) {
		const key = this.keyOf(turn, step);
		const ordinal = this.ordinals.get(key) ?? 0;
		this.ordinals.set(key, ordinal + 1);
		return ordinal;
	}
	newestOpen() {
		let newest;
		for (const queue of this.open.values()) {
			const candidate = queue[queue.length - 1];
			if (candidate !== void 0 && (newest === void 0 || candidate.startedAt >= newest.startedAt)) newest = candidate;
		}
		return newest;
	}
};
/**
* One session's bricks, and the readers waiting on them.
*
* Publishing is coalesced by the collector, not here: this class only knows how to say "these
* are the bricks now".
*/
var SessionFeed = class {
	tracker;
	sessionId;
	sinks = /* @__PURE__ */ new Set();
	constructor(sessionId, options = {}) {
		this.sessionId = sessionId;
		this.tracker = new AttemptTracker(sessionId, options);
	}
	/** The tracker this feed reads, so the collector can hand it observations. */
	get attempts() {
		return this.tracker;
	}
	/** The session's current bricks. */
	snapshot() {
		return {
			sessionId: this.sessionId,
			bricks: this.tracker.records(),
			dropped: this.tracker.dropped,
			endedTurns: this.tracker.endedTurns(),
			backfilled: this.tracker.backfilled,
			dispatched: this.tracker.dispatchedCount
		};
	}
	/** Watch this feed. The returned function stops watching. */
	subscribe(sink) {
		this.sinks.add(sink);
		return () => {
			this.sinks.delete(sink);
		};
	}
	/** Number of live readers — the collector skips serializing when nobody is looking. */
	get listeners() {
		return this.sinks.size;
	}
	/** Hand every reader the current feed. */
	publish() {
		if (this.sinks.size === 0) return;
		const feed = this.snapshot();
		for (const sink of this.sinks) try {
			sink(feed);
		} catch {}
	}
	/** Drop every reader and every brick. */
	dispose() {
		this.sinks.clear();
	}
};
/** Every session's feed, with the least recently used dropped first. */
var BrickFeeds = class {
	feeds = /* @__PURE__ */ new Map();
	capacity;
	trackerOptions;
	constructor(options = {}) {
		this.capacity = Math.max(1, options.sessions ?? 8);
		this.trackerOptions = options.tracker ?? {};
	}
	/**
	* The feed for one session, created on first use.
	*
	* @param sessionId - the session a model call belongs to.
	* @returns the feed, most recently used.
	*/
	for(sessionId) {
		const existing = this.feeds.get(sessionId);
		if (existing !== void 0) {
			this.feeds.delete(sessionId);
			this.feeds.set(sessionId, existing);
			return existing;
		}
		if (this.feeds.size >= this.capacity) {
			const oldest = this.feeds.keys().next();
			if (oldest.done !== true) {
				this.feeds.get(oldest.value)?.dispose();
				this.feeds.delete(oldest.value);
			}
		}
		const feed = new SessionFeed(sessionId, this.trackerOptions);
		this.feeds.set(sessionId, feed);
		return feed;
	}
	/** The feed for a session, without creating one. */
	peek(sessionId) {
		return this.feeds.get(sessionId);
	}
	/** Every session this process has seen recently, most recent first. */
	sessions() {
		return [...this.feeds.keys()].reverse();
	}
	/** Drop everything. */
	dispose() {
		for (const feed of this.feeds.values()) feed.dispose();
		this.feeds.clear();
	}
};
//#endregion
//#region src/host/routes.ts
const LOOPBACK = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"::1",
	"::ffff:127.0.0.1"
]);
/**
* True when the peer is this machine.
*
* An absent `remoteAddress` is **not** treated as local: an unidentifiable peer is refused rather
* than admitted, because the answer would otherwise be a session's activity on an unknown
* connection.
*/
function isLoopback(request) {
	const address = request.socket?.remoteAddress;
	return address !== void 0 && LOOPBACK.has(address);
}
/** True when the request either carries no `Origin` or one matching the `Host` it reached. */
function isSameOrigin(request) {
	const origin = request.headers.origin;
	if (typeof origin !== "string" || origin === "") return true;
	const host = request.headers.host;
	if (typeof host !== "string" || host === "") return false;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}
/** JSON response helper. */
function json(response, status, body) {
	response.statusCode = status;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.setHeader("cache-control", "no-store");
	response.end(JSON.stringify(body));
}
/**
* Build the route handler for the plugin's namespace.
* @param deps - brick access.
* @param options - prefix and guard.
* @returns a handler suitable for `webServer.register`, plus the path it serves.
*/
function createBrickRouter(deps, options = {}) {
	const path = options.basePath ?? "/cache-bricks";
	const handler = (request, response) => {
		const rejection = options.guard?.(request);
		if (rejection !== void 0) {
			json(response, rejection, { error: rejection === 401 ? "unauthenticated" : "forbidden" });
			return;
		}
		if (!isLoopback(request) || !isSameOrigin(request)) {
			json(response, 403, { error: "forbidden" });
			return;
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			json(response, 405, { error: "method not allowed" });
			return;
		}
		const url = new URL(request.url ?? "/", "http://localhost");
		const route = url.pathname.slice(path.length);
		if (route === "/sessions") {
			json(response, 200, { sessions: deps.sessions() });
			return;
		}
		const sessionId = url.searchParams.get("sessionId");
		if (route === "/bricks" || route === "/stream") {
			if (sessionId === null) {
				json(response, 400, { error: "sessionId is required" });
				return;
			}
			deps.looked?.(sessionId);
		}
		if (route === "/bricks") {
			const payload = deps.bricks(sessionId);
			json(response, payload === void 0 ? 404 : 200, payload ?? { error: "this session has no bricks yet" });
			return;
		}
		if (route === "/stream") {
			response.writeHead?.(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive"
			});
			const send = (event, payload) => {
				response.write?.(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
			};
			const current = deps.bricks(sessionId);
			if (current !== void 0) send("bricks", current);
			const unsubscribe = deps.subscribe(sessionId, (feed) => {
				send("bricks", feed);
			});
			const heartbeat = setInterval(() => {
				response.write?.(": hb\n\n");
			}, 25e3);
			const close = () => {
				clearInterval(heartbeat);
				unsubscribe();
			};
			response.on?.("close", close);
			return;
		}
		json(response, 404, { error: "not found" });
	};
	return {
		path,
		handler
	};
}
//#endregion
//#region src/host/session-log.ts
/**
* Reading a session's own log — once, on request.
*
* This is the one place Lite touches history, and it is deliberately narrow: a session's
* `.jsonl.zstd` artifact is opened **only when a browser asks for that session's bricks**, read in
* one pass, and turned into the same eleven-field bricks the live path produces. Nothing is
* stored: the bricks go into the same in-memory ring, which drops the oldest as it always does.
*
* The log is the harness's own artifact, so the decoding follows the harness's own reader
* (`dsh-session-persistence-jsonl`): **Zstandard frames are located structurally** — magic,
* descriptor, block headers — rather than by scanning for the magic bytes, which can also occur
* inside compressed data. A frame that is incomplete at the tail (a log being written right now) is
* skipped rather than guessed at, exactly as a reader of a live file should.
*
* What is read out of a record is what a brick is made of, and nothing else:
*
* - `assistant/message` / `assistant/attempt` → one settled attempt each (`turn`, `step`, and the
*   usage it was billed, or the last `usage` chunk of its compact stream);
* - `turn/end` → the mark that lets a finished stack step one cell left;
* - everything else → not read at all.
*
* A prompt, a tool call, a request envelope: never touched, because a brick does not carry them.
*/
/** Big-endian Zstandard frame magic, as a uint32 read little-endian — the harness's own constant. */
const ZSTD_MAGIC = 4247762216;
/**
* Locate the complete frames in a log artifact.
*
* @param buffer - the bytes currently on disk.
* @returns each frame's byte range, in order; an incomplete final frame is left out.
*/
function frameRanges(buffer) {
	const frames = [];
	let offset = 0;
	if (buffer.length >= 4 && buffer.readUInt32LE(0) !== ZSTD_MAGIC) {
		const magic = Buffer.from([
			40,
			181,
			47,
			253
		]);
		const at = buffer.indexOf(magic);
		if (at < 0) return frames;
		offset = at;
	}
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) break;
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
		offset += 4;
		if (offset === buffer.length) break;
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) break;
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) break;
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) return frames;
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = blockHeader >>> 1 & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) return frames;
			const payload = blockType === 1 ? 1 : blockSize;
			if (buffer.length - offset < payload) return frames;
			offset += payload;
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) return frames;
			offset += 4;
		}
		frames.push({
			start,
			end: offset
		});
	}
	return frames;
}
/**
* Decode every complete frame of a log artifact.
*
* @param buffer - the bytes currently on disk.
* @returns the decoded text of each frame, oldest first.
*/
function decodeFrames(buffer) {
	const decoded = [];
	for (const frame of frameRanges(buffer)) try {
		decoded.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString("utf8"));
	} catch {
		break;
	}
	return decoded;
}
/** The last `usage` chunk inside a settled attempt's compact stream. */
function usageFromStream(stream) {
	let found;
	for (const record of stream ?? []) {
		if (record === null || typeof record !== "object") continue;
		const entry = record;
		if (entry.type !== "chunk" || entry.chunk?.type !== "usage") continue;
		if (entry.chunk.usage !== void 0) found = entry.chunk.usage;
	}
	return found;
}
/** A usage object, keeping absent cache buckets absent. */
function usageOf(usage) {
	if (usage === null || typeof usage !== "object") return void 0;
	const entry = usage;
	if (typeof entry.inputTokens !== "number") return void 0;
	return {
		inputTokens: entry.inputTokens,
		...typeof entry.cacheReadTokens === "number" ? { cacheReadTokens: entry.cacheReadTokens } : {},
		...typeof entry.cacheWriteTokens === "number" ? { cacheWriteTokens: entry.cacheWriteTokens } : {}
	};
}
/**
* Fold decoded log text into settlements.
*
* The log is JSONL: a session header record first, then one event per line. A torn tail line (the
* log is being appended to while it is read) is ignored, which is why parsing a line is allowed to
* fail without failing the read.
*
* @param chunks - the decoded text of each frame, oldest first.
* @returns the settlements, the ended Turns, and counts for the two things that were not read.
*/
function readLog(chunks) {
	const settlements = [];
	const endedTurns = /* @__PURE__ */ new Set();
	let records = 0;
	let skipped = 0;
	for (const chunk of chunks) for (const line of chunk.split("\n")) {
		if (line === "") continue;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		records += 1;
		const type = parsed.type;
		if (type === "turn/end") {
			const turn = parsed.data?.turn;
			if (typeof turn === "number") endedTurns.add(turn);
			continue;
		}
		if (type !== "assistant/message" && type !== "assistant/attempt") continue;
		const data = parsed.data ?? {};
		if (typeof data.turn !== "number" || typeof data.step !== "number") {
			skipped += 1;
			continue;
		}
		const usage = usageOf(data.usage) ?? usageFromStream(Array.isArray(data.stream) ? data.stream : void 0);
		settlements.push({
			turn: data.turn,
			step: data.step,
			...typeof parsed.time === "number" ? { time: parsed.time } : {},
			...usage === void 0 ? {} : { usage },
			...Array.isArray(data.stream) ? { stream: data.stream } : {}
		});
	}
	return {
		settlements,
		endedTurns: [...endedTurns].sort((left, right) => left - right),
		records,
		skipped,
		frames: chunks.length
	};
}
/** The roots a session log may be under, most specific first. */
function logRoots(options = {}) {
	if (options.roots !== void 0 && options.roots.length > 0) return [...options.roots];
	const roots = [];
	const explicit = process.env.DSH_SESSION_ROOT;
	if (explicit !== void 0 && explicit !== "") roots.push(explicit);
	const home = process.env.DSH_HOME;
	roots.push(join(home !== void 0 && home !== "" ? home : join(homedir(), ".dsh"), "sessions"));
	return roots;
}
/**
* Find one session's log artifact.
*
* Layout is the harness's own: `sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd`. The
* workspace slug is not derivable from a session id, so the directory is found by name.
*
* @param sessionId - the session to find.
* @param options - where to look.
* @returns the artifact's path, or undefined when this process cannot see it.
*/
async function findSessionLog(sessionId, options = {}) {
	for (const root of logRoots(options)) {
		let workspaces;
		try {
			workspaces = await readdir(root);
		} catch {
			continue;
		}
		for (const workspace of workspaces) {
			const dir = join(root, workspace, sessionId);
			try {
				const log = (await readdir(dir)).find((name) => /^session\.v\d+\.jsonl\.zstd$/u.test(name));
				if (log !== void 0) return join(dir, log);
			} catch {}
		}
	}
}
/**
* Read one session's log, if this process can find it.
*
* @param sessionId - the session to read.
* @param options - where to look.
* @returns the settlements and the counts, or undefined when there is no log to read.
*/
async function readSessionLog(sessionId, options = {}) {
	const path = await findSessionLog(sessionId, options);
	if (path === void 0) return void 0;
	if (await stat(path).then((info) => info.size).catch(() => 0) === 0) return void 0;
	const chunks = decodeFrames(await readFile(path));
	if (chunks.length === 0) return void 0;
	return {
		path,
		...readLog(chunks)
	};
}
//#endregion
//#region src/host/collect.ts
/** How long bricks are allowed to wait for one push. One frame at 60 Hz is 16 ms. */
const PUBLISH_INTERVAL_MS = 100;
/**
* Install the collector.
* @param ctx - the plugin's Cordis context.
* @param options - capacity and serving options.
* @returns the collector, so a host or a test can read it directly.
*/
function installCollector(ctx, options = {}) {
	const backfilled = /* @__PURE__ */ new Set();
	const backfillEnabled = options.backfill !== false;
	const feeds = new BrickFeeds({
		...options.sessions === void 0 ? {} : { sessions: options.sessions },
		...options.capacity === void 0 ? {} : { tracker: { capacity: options.capacity } }
	});
	let disposed = false;
	/** Run something that sits inside the model-call path without ever letting it throw. */
	const safely = (action) => {
		try {
			action();
		} catch (error) {
			console.warn("[dsh-cache-bricks] observation failed:", error instanceof Error ? error.message : error);
		}
	};
	let lastPublish = 0;
	let trailing;
	const publishNow = (feed) => {
		lastPublish = Date.now();
		feed.publish();
	};
	/**
	* Push the current bricks, at most once per {@link PUBLISH_INTERVAL_MS}.
	*
	* A settlement is the only thing that calls this, so the coalescing matters for one case only:
	* a turn that settles several attempts in quick succession (a retry chain) should reach the
	* browser as one repaint rather than three.
	*/
	const publish = (feed) => {
		if (feed.listeners === 0) return;
		const wait = PUBLISH_INTERVAL_MS - (Date.now() - lastPublish);
		if (wait <= 0) {
			publishNow(feed);
			return;
		}
		if (trailing !== void 0) return;
		trailing = setTimeout(() => {
			trailing = void 0;
			publishNow(feed);
		}, wait);
	};
	ctx.on("llm/stream", ((...args) => {
		const request = args[0];
		const next = args[1];
		let sessionId = "unknown";
		try {
			if (typeof request?.sessionId === "string") sessionId = request.sessionId;
		} catch {
			sessionId = "unknown";
		}
		safely(() => {
			feeds.for(sessionId).attempts.dispatched();
		});
		return next?.();
	}), {
		global: true,
		prepend: true
	});
	ctx.on("agent/assistant-stream", ((...args) => {
		const payload = args[0];
		const frame = payload?.frame;
		if (frame === void 0) return;
		safely(() => {
			const sessionId = payload?.agent?.session?.id ?? "unknown";
			feeds.for(sessionId).attempts.frame(frame);
		});
	}), { global: true });
	ctx.on("session/event", ((...args) => {
		const session = args[0];
		const event = args[1];
		if (session?.id === void 0 || event?.type === void 0) return;
		safely(() => {
			const sessionId = session.id;
			const feed = feeds.for(sessionId);
			if (event.type === "turn/end") {
				const turn = event.data?.turn;
				if (typeof turn === "number") {
					feed.attempts.turnEnded(turn);
					publish(feed);
				}
				return;
			}
			if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return;
			const data = event.data ?? {};
			if (feed.attempts.settle({
				...typeof data.turn === "number" ? { turn: data.turn } : {},
				...typeof data.step === "number" ? { step: data.step } : {},
				...event.time === void 0 ? {} : { time: event.time },
				...data.usage === void 0 ? {} : { usage: {
					inputTokens: data.usage.inputTokens ?? 0,
					...data.usage.cacheReadTokens === void 0 ? {} : { cacheReadTokens: data.usage.cacheReadTokens },
					...data.usage.cacheWriteTokens === void 0 ? {} : { cacheWriteTokens: data.usage.cacheWriteTokens }
				} },
				...data.stream === void 0 ? {} : { stream: data.stream }
			}) !== void 0) publish(feed);
		});
	}), { global: true });
	/**
	* Fill a session's ring from its own log, once, when a browser first looks at it.
	*
	* Deliberately *not* done when the collector merely sees an event for a session: an active
	* session is already producing live bricks and its past is the least interesting thing about it.
	* The trigger is a reader asking, which is also when the cost is worth paying.
	*
	* @param sessionId - the session a browser asked about.
	*/
	const ensureBackfilled = (sessionId) => {
		if (!backfillEnabled || backfilled.has(sessionId)) return;
		backfilled.add(sessionId);
		(async () => {
			try {
				const read = await readSessionLog(sessionId, { ...options.logsRoots === void 0 ? {} : { roots: options.logsRoots } });
				if (read === void 0 || disposed) return;
				const feed = feeds.for(sessionId);
				let added = 0;
				for (const settlement of read.settlements) if (feed.attempts.settleFromLog(settlement) !== void 0) added += 1;
				for (const turn of read.endedTurns) feed.attempts.turnEnded(turn);
				if (added > 0) {
					feed.publish();
					console.info(`[dsh-cache-bricks] read ${String(added)} settled attempt(s) for ${sessionId} from ${read.path} (${String(read.records)} records, ${String(read.frames)} frame(s))`);
				}
			} catch (error) {
				console.warn("[dsh-cache-bricks] session log backfill failed:", error instanceof Error ? error.message : error);
			}
		})();
	};
	const collector = {
		feeds,
		feed: (sessionId) => feeds.peek(sessionId)?.snapshot(),
		sessions: () => feeds.sessions(),
		subscribe: (sessionId, sink) => feeds.for(sessionId).subscribe(sink),
		looked: (sessionId) => {
			ensureBackfilled(sessionId);
		},
		dispose: () => {
			disposed = true;
			feeds.dispose();
			if (trailing !== void 0) {
				clearTimeout(trailing);
				trailing = void 0;
			}
		}
	};
	if (options.serve !== false) {
		const router = createBrickRouter({
			bricks: (sessionId) => collector.feed(sessionId),
			sessions: () => collector.sessions(),
			subscribe: (sessionId, sink) => collector.subscribe(sessionId, sink),
			looked: (sessionId) => {
				collector.looked(sessionId);
			}
		}, {
			...options.basePath === void 0 ? {} : { basePath: options.basePath },
			guard: (request) => {
				return ctx.get("connection")?.requestRejection?.(request);
			}
		});
		ctx.inject(["webServer"], (webCtx) => {
			const server = webCtx.get("webServer");
			if (server === void 0 || disposed) return;
			webCtx.effect(() => server.register({
				kind: "prefix",
				path: options.basePath ?? router.path,
				handler: router.handler
			}));
		});
	}
	return collector;
}
//#endregion
//#region src/index.ts
/**
* Node-half entry.
*
* A browser cannot see a model call: the request, the usage the provider billed and the attempt
* identity only exist on the host. This half watches them and turns each settled request into a
* brick; the other half draws it. Nothing is stored — see `shared/cache-brick.ts` for what a
* brick is, and for the list of things this version deliberately does not carry.
*
* It adds no tool, no prompt section and no request rewrite: the plugin's only interaction with
* the model-call path is an `llm/stream` observer that returns `next()` untouched. The two
* server-side facts that make this safe are the waterfall contract (returning anything else
* would replace the model's stream) and the deep-frozen loop request (writing to it throws),
* both verified against the installed runtime.
*/
const name = "dsh-cache-bricks";
/**
* Install the collector.
*
* `webServer` is requested through `ctx.inject` rather than a module-level
* `inject`, so the collector still observes on a composition that serves no HTTP
* (headless, TUI) — it simply has no routes to publish to.
*
* @param ctx - the plugin context.
* @param config - optional capacity and serving options from the plugin row.
*/
function apply(ctx, config) {
	installCollector(ctx, config ?? {});
}
//#endregion
export { apply, name };
