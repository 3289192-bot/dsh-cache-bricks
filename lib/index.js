//#region src/shared/sha256.ts
/**
* SHA-256, self-contained.
*
* The content-addressed store needs a strong hash to be trustworthy, and this
* plugin needs it in **both** halves: the host hashes outgoing requests, and the
* client can hash the same way when it wants to prove two bricks share a prefix.
* A dependency-free implementation keeps the host half free of Node builtins (so
* nothing about it is environment-specific), keeps the browser bundle free of
* polyfills, and lets the hash be verified against published test vectors instead
* of trusted.
*
* Synchronous and byte-oriented: hashing a multi-megabyte request once per model
* call is cheap next to the call itself.
*/
/** Round constants: the first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K = new Uint32Array([
	1116352408,
	1899447441,
	3049323471,
	3921009573,
	961987163,
	1508970993,
	2453635748,
	2870763221,
	3624381080,
	310598401,
	607225278,
	1426881987,
	1925078388,
	2162078206,
	2614888103,
	3248222580,
	3835390401,
	4022224774,
	264347078,
	604807628,
	770255983,
	1249150122,
	1555081692,
	1996064986,
	2554220882,
	2821834349,
	2952996808,
	3210313671,
	3336571891,
	3584528711,
	113926993,
	338241895,
	666307205,
	773529912,
	1294757372,
	1396182291,
	1695183700,
	1986661051,
	2177026350,
	2456956037,
	2730485921,
	2820302411,
	3259730800,
	3345764771,
	3516065817,
	3600352804,
	4094571909,
	275423344,
	430227734,
	506948616,
	659060556,
	883997877,
	958139571,
	1322822218,
	1537002063,
	1747873779,
	1955562222,
	2024104815,
	2227730452,
	2361852424,
	2428436474,
	2756734187,
	3204031479,
	3329325298
]);
/** Initial hash state: the first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const H0 = new Uint32Array([
	1779033703,
	3144134277,
	1013904242,
	2773480762,
	1359893119,
	2600822924,
	528734635,
	1541459225
]);
/** Rotate right. */
function rotr(value, bits) {
	return (value >>> bits | value << 32 - bits) >>> 0;
}
/**
* Hash bytes.
* @param data - the message.
* @returns the 32-byte digest.
*/
function sha256(data) {
	const length = data.length;
	const bitLength = length * 8;
	const padded = length + 9 + 63 >> 6 << 6;
	const buffer = new Uint8Array(padded);
	buffer.set(data);
	buffer[length] = 128;
	const view = new DataView(buffer.buffer);
	view.setUint32(padded - 8, Math.floor(bitLength / 2 ** 32));
	view.setUint32(padded - 4, bitLength >>> 0);
	const state = H0.slice();
	const schedule = /* @__PURE__ */ new Uint32Array(64);
	for (let offset = 0; offset < padded; offset += 64) {
		for (let index = 0; index < 16; index += 1) schedule[index] = view.getUint32(offset + index * 4);
		for (let index = 16; index < 64; index += 1) {
			const x = schedule[index - 15];
			const y = schedule[index - 2];
			const s0 = rotr(x, 7) ^ rotr(x, 18) ^ x >>> 3;
			const s1 = rotr(y, 17) ^ rotr(y, 19) ^ y >>> 10;
			schedule[index] = schedule[index - 16] + s0 + schedule[index - 7] + s1 >>> 0;
		}
		let a = state[0];
		let b = state[1];
		let c = state[2];
		let d = state[3];
		let e = state[4];
		let f = state[5];
		let g = state[6];
		let h = state[7];
		for (let index = 0; index < 64; index += 1) {
			const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = e & f ^ ~e & g;
			const temp1 = h + s1 + ch + K[index] + schedule[index] >>> 0;
			const temp2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + (a & b ^ a & c ^ b & c) >>> 0;
			h = g;
			g = f;
			f = e;
			e = d + temp1 >>> 0;
			d = c;
			c = b;
			b = a;
			a = temp1 + temp2 >>> 0;
		}
		state[0] = state[0] + a >>> 0;
		state[1] = state[1] + b >>> 0;
		state[2] = state[2] + c >>> 0;
		state[3] = state[3] + d >>> 0;
		state[4] = state[4] + e >>> 0;
		state[5] = state[5] + f >>> 0;
		state[6] = state[6] + g >>> 0;
		state[7] = state[7] + h >>> 0;
	}
	const digest = /* @__PURE__ */ new Uint8Array(32);
	for (let index = 0; index < 8; index += 1) {
		const word = state[index];
		digest[index * 4] = word >>> 24 & 255;
		digest[index * 4 + 1] = word >>> 16 & 255;
		digest[index * 4 + 2] = word >>> 8 & 255;
		digest[index * 4 + 3] = word & 255;
	}
	return digest;
}
/** UTF-8 bytes of a string, without depending on Node's `Buffer`. */
function utf8Bytes(text) {
	return new TextEncoder().encode(text);
}
/** Byte length of a string in UTF-8 (not its character count). */
function utf8Length(text) {
	return utf8Bytes(text).length;
}
/**
* Hash text or bytes to lowercase hex.
* @param input - a string (UTF-8 encoded) or raw bytes.
* @returns 64 hex characters.
*/
function sha256Hex(input) {
	const digest = sha256(typeof input === "string" ? utf8Bytes(input) : input);
	let hex = "";
	for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
	return hex;
}
/**
* Short content ref: the first 32 hex characters (128 bits).
*
* Long enough that a collision is not a practical concern for a few hundred
* thousand payloads, short enough to sit in a URL and in a record without noise.
* @param input - a string (UTF-8 encoded) or raw bytes.
* @returns 32 hex characters.
*/
function contentRef(input) {
	return sha256Hex(input).slice(0, 32);
}
//#endregion
//#region src/host/blob-store.ts
/**
* Content-addressed store for the big half of a brick record.
*
* The interesting raw material of a model call — the exact request the provider
* received, the tool schemas, the request header, the timed stream — is large and
* mostly identical from attempt to attempt: the 274th call of a session is the
* 273rd plus a few thousand tokens. Storing it per brick would turn a cache
* monitor into a duplication engine, so raw payloads are hashed and kept once.
* Bricks then hold refs, and two bricks that share a prefix share the bytes.
*
* Dependency-free (a local SHA-256, no Node builtins), so the same code runs in
* either half and the store stays a plain data structure with its own unit tests
* (dedupe, eviction, oversize handling).
*/
const DEFAULT_MAX_BLOB_BYTES = 4194304;
const DEFAULT_MAX_TOTAL_BYTES = 50331648;
const DEFAULT_MAX_BLOBS = 4096;
/**
* Envelope key under which every payload is stored.
*
* Without it a string payload that happens to be valid JSON (`'{"path":"a.ts"}'`,
* i.e. exactly the raw tool arguments) would read back as an object, and a
* forensic store that does not return what you put in is not a store. Wrapping is
* unambiguous because the store always wraps.
*/
const ENVELOPE = "v";
/** Canonical JSON: key order fixed, so equal values always hash equally. */
function canonicalize(value) {
	return JSON.stringify(value, (_key, item) => {
		if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
		const source = item;
		const sorted = {};
		for (const key of Object.keys(source).sort()) sorted[key] = source[key];
		return sorted;
	}) ?? "null";
}
/** Content-addressed store with LRU eviction. */
var BlobStore = class {
	blobs = /* @__PURE__ */ new Map();
	maxBlobBytes;
	maxTotalBytes;
	maxBlobs;
	bytes = 0;
	hits = 0;
	misses = 0;
	skipped = 0;
	evicted = 0;
	constructor(options = {}) {
		this.maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
		this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
		this.maxBlobs = options.maxBlobs ?? DEFAULT_MAX_BLOBS;
	}
	/**
	* Store a payload and return its ref.
	* @param value - any JSON-serializable payload.
	* @returns the ref and size, or undefined when the payload is too large to keep.
	*/
	put(value) {
		const text = canonicalize({ [ENVELOPE]: value });
		const bytes = utf8Length(text);
		if (bytes > this.maxBlobBytes) {
			this.skipped += 1;
			return;
		}
		const hash = contentRef(text);
		const existing = this.blobs.get(hash);
		if (existing !== void 0) {
			this.blobs.delete(hash);
			this.blobs.set(hash, existing);
			return {
				hash,
				bytes: existing.bytes,
				added: false
			};
		}
		this.blobs.set(hash, {
			text,
			bytes
		});
		this.bytes += bytes;
		this.evict();
		return {
			hash,
			bytes,
			added: true
		};
	}
	/**
	* Read a payload back.
	* @param hash - the ref returned by {@link put}.
	* @returns the payload, or undefined when it was never stored or has been evicted.
	*/
	get(hash) {
		const entry = this.blobs.get(hash);
		if (entry === void 0) {
			this.misses += 1;
			return;
		}
		this.hits += 1;
		this.blobs.delete(hash);
		this.blobs.set(hash, entry);
		return JSON.parse(entry.text)[ENVELOPE];
	}
	/** True when a ref is still resolvable. */
	has(hash) {
		return this.blobs.has(hash);
	}
	/** Current counters. */
	stats() {
		return {
			blobs: this.blobs.size,
			bytes: this.bytes,
			hits: this.hits,
			misses: this.misses,
			skipped: this.skipped,
			evicted: this.evicted
		};
	}
	/** Drop everything (used when a session ends). */
	clear() {
		this.blobs.clear();
		this.bytes = 0;
	}
	evict() {
		while (this.blobs.size > this.maxBlobs || this.bytes > this.maxTotalBytes && this.blobs.size > 1) {
			const oldest = this.blobs.keys().next();
			if (oldest.done === true) return;
			const entry = this.blobs.get(oldest.value);
			this.blobs.delete(oldest.value);
			if (entry !== void 0) this.bytes -= entry.bytes;
			this.evicted += 1;
		}
	}
};
//#endregion
//#region src/shared/metrics.ts
/**
* Prompt size in tokens.
*
* DSH keeps the three prompt buckets disjoint: `inputTokens` is the uncached
* input, cache reads and cache writes are counted separately. The prompt the
* provider billed is therefore their sum, and the ratios below divide by it — no
* guessing at a provider's own `prompt_tokens` convention.
*
* @param usage - provider usage for the attempt.
* @returns the prompt size, or undefined when the attempt reported no usage.
*/
function promptTokensOf(usage) {
	if (usage === void 0) return void 0;
	const total = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
	return total > 0 ? total : void 0;
}
/**
* Split the prompt into its three disjoint parts.
*
* Returns nothing when the provider reported **no** cache buckets at all: a
* missing field means "not reported", not "zero cached", and printing `0.00%`
* for a provider that never mentions caching is the same lie as printing `n/a`
* for one that does.
*
* @param usage - provider usage for the attempt.
* @returns the ratios, or undefined when there is no usable prompt size or no
*   cache accounting to split.
*/
function promptRatiosOf(usage) {
	if (usage !== void 0 && usage.cacheReadTokens === void 0 && usage.cacheWriteTokens === void 0) return;
	const promptTokens = promptTokensOf(usage);
	if (promptTokens === void 0 || usage === void 0) return void 0;
	const cacheRead = usage.cacheReadTokens ?? 0;
	const cacheWrite = usage.cacheWriteTokens ?? 0;
	return {
		promptTokens,
		cacheHitRatio: cacheRead / promptTokens,
		uncachedRatio: usage.inputTokens / promptTokens,
		cacheWriteRatio: cacheWrite / promptTokens
	};
}
/**
* Share of the output that was reasoning tokens.
* @param usage - provider usage for the attempt.
* @returns the ratio in `0..1`, or undefined when the provider reports no split.
*/
function reasoningRatioOf(usage) {
	if (usage === void 0 || usage.reasoningTokens === void 0) return void 0;
	const output = usage.totalTokens !== void 0 ? usage.totalTokens - (promptTokensOf(usage) ?? 0) : usage.outputTokens;
	return output > 0 ? usage.reasoningTokens / output : void 0;
}
/**
* How full the context window was for this request.
* @param promptTokens - prompt size in tokens.
* @param contextWindow - the window the request ran against.
* @returns the ratio in `0..1`, or undefined when either side is unknown.
*/
function contextOccupancyOf(promptTokens, contextWindow) {
	if (promptTokens === void 0 || contextWindow === void 0 || contextWindow <= 0) return void 0;
	return promptTokens / contextWindow;
}
/**
* Derive timing and throughput.
* @param timing - the timestamps the collector captured.
* @param outputTokens - output tokens for the attempt, when known.
* @returns the derived timings, each present only when its inputs are.
*/
function deriveTiming(timing, outputTokens) {
	const { dispatchedAt, firstTokenAt, finishAt } = timing;
	const ttftMs = dispatchedAt !== void 0 && firstTokenAt !== void 0 ? Math.max(0, firstTokenAt - dispatchedAt) : void 0;
	const durationMs = dispatchedAt !== void 0 && finishAt !== void 0 ? Math.max(0, finishAt - dispatchedAt) : void 0;
	const generationMs = firstTokenAt !== void 0 && finishAt !== void 0 ? Math.max(0, finishAt - firstTokenAt) : void 0;
	return {
		ttftMs,
		durationMs,
		generationMs,
		tps: generationMs !== void 0 && generationMs > 0 && outputTokens !== void 0 && outputTokens > 0 ? outputTokens / (generationMs / 1e3) : void 0
	};
}
/** An empty counter set, so a record is never missing its shape. */
const EMPTY_COUNTERS = {
	chunkCount: 0,
	textChars: 0,
	reasoningChars: 0,
	toolCallCount: 0
};
/**
* Assemble the metrics block.
* @param usage - provider usage, when the attempt produced any.
* @param timing - captured timestamps.
* @param counters - stream counters.
* @param contextWindow - the window the request ran against.
* @returns a fully populated metrics block (absent figures stay absent).
*/
function deriveMetrics(usage, timing, counters, contextWindow) {
	const promptTokens = promptTokensOf(usage);
	const ratios = promptRatiosOf(usage);
	const derived = deriveTiming(timing, usage?.outputTokens);
	const occupancy = contextOccupancyOf(promptTokens, contextWindow);
	const reasoningRatio = reasoningRatioOf(usage);
	return {
		...promptTokens === void 0 ? {} : { promptTokens },
		...ratios === void 0 ? {} : {
			cacheHitRatio: ratios.cacheHitRatio,
			uncachedRatio: ratios.uncachedRatio,
			cacheWriteRatio: ratios.cacheWriteRatio
		},
		...reasoningRatio === void 0 ? {} : { reasoningRatio },
		...occupancy === void 0 ? {} : { contextOccupancy: occupancy },
		...derived.ttftMs === void 0 ? {} : { ttftMs: derived.ttftMs },
		...derived.durationMs === void 0 ? {} : { durationMs: derived.durationMs },
		...derived.tps === void 0 ? {} : { tps: derived.tps },
		...timing.dispatchedAt === void 0 ? {} : { dispatchedAt: timing.dispatchedAt },
		...timing.firstTokenAt === void 0 ? {} : { firstTokenAt: timing.firstTokenAt },
		...timing.usageAt === void 0 ? {} : { usageAt: timing.usageAt },
		...timing.finishAt === void 0 ? {} : { finishAt: timing.finishAt },
		chunkCount: counters.chunkCount,
		textChars: counters.textChars,
		reasoningChars: counters.reasoningChars,
		toolCallCount: counters.toolCallCount
	};
}
//#endregion
//#region src/host/brick-ledger.ts
/**
* The ledger: folds what the runtime reports into one brick per **real model
* request attempt**.
*
* Three facts about DSH 0.1.7-rc.1 shape this design, all verified in the
* installed source:
*
* 1. `llm/stream` is a waterfall that carries the full outgoing request but **no
*    turn, step or attempt id**. The attempt identity arrives separately on
*    `agent/assistant-stream`'s `start` frame (`turn`, `step`, `attemptId`,
*    `revision`). So a dispatch is paired with an attempt through a per-session
*    FIFO: whichever side arrives first, the two meet in the middle.
* 2. `llm/retry` and `llm/retry-started` are **durable session events**, not
*    Cordis events. They come in through the session feed, and a retry is what
*    makes one `(turn, step)` hold more than one brick.
* 3. Context pressure and composition are *last-wins slots*, explicitly not one
*    atomic request observation. They are therefore snapshotted **at dispatch**
*    and frozen onto the brick, never read back after the fact.
*
* The ledger is pure: it consumes normalized observations and writes to a blob
* store. No DSH imports, no timers, no IO — so a whole session, including retries
* and failures, can be replayed in a unit test.
*/
const DEFAULT_MAX_BRICKS = 400;
/** The per-session ledger. */
var BrickLedger = class {
	sessionId;
	maxBricks;
	store;
	drafts = [];
	pendingDispatches = [];
	attemptCounts = /* @__PURE__ */ new Map();
	/** Retry chain id per `(turn, step)`, so the attempt that runs it can be stamped. */
	retryChains = /* @__PURE__ */ new Map();
	/** Observations that could not be attributed to an attempt, and were dropped. */
	unattributed = 0;
	endedTurns = /* @__PURE__ */ new Set();
	current;
	/** The auxiliary call in flight, if any: auxiliary calls are serialized. */
	auxiliary;
	header;
	contextRoute;
	pressure;
	constructor(sessionId, options = {}) {
		this.sessionId = sessionId;
		this.maxBricks = options.maxBricks ?? DEFAULT_MAX_BRICKS;
		this.store = options.store ?? new BlobStore();
	}
	/** The raw-payload store, so the adapter can stash blobs and hand back refs. */
	get blobStore() {
		return this.store;
	}
	/**
	* Fold one observation.
	* @param observation - a normalized runtime observation.
	* @returns the brick that changed, when the observation completed or updated one.
	*/
	observe(observation) {
		switch (observation.kind) {
			case "dispatch":
				if (observation.options.purpose !== void 0) return this.startAuxiliary(observation.at, observation.options);
				this.pendingDispatches.push({
					at: observation.at,
					options: observation.options
				});
				return;
			case "turn-end":
				this.endedTurns.add(observation.turn);
				return;
			case "attempt-start": return this.startAttempt(observation);
			case "chunk": return this.applyChunk(observation);
			case "attempt-end": return this.endAttempt(observation);
			case "settled": return this.settle(observation.snapshot);
			case "header":
				this.header = observation.snapshot;
				return;
			case "context":
				this.contextRoute = observation.snapshot;
				return;
			case "pressure":
				this.pressure = observation.snapshot;
				return;
			case "retry": return this.attachRetry(observation.snapshot);
			case "tool-call": return this.attachToolCall(observation);
			case "tool-result": return this.attachToolResult(observation);
			case "compaction": return this.attachCompaction(observation.compactionId);
			case "flush": return this.flushOrphans(observation.at);
		}
	}
	/**
	* Record an auxiliary call as its own brick.
	*
	* It gets one immediately, at `turn 0`, because there is no attempt frame coming
	* to complete a pairing; its stream is observed through the pass-through wrapper
	* the collector returns for it.
	*/
	startAuxiliary(at, options) {
		const key = `0:${options.purpose ?? "auxiliary"}`;
		const ordinal = this.attemptCounts.get(key) ?? 0;
		this.attemptCounts.set(key, ordinal + 1);
		const draft = {
			id: `${this.sessionId}:0:0:${String(ordinal)}`,
			turn: 0,
			step: 0,
			attemptOrdinal: ordinal,
			dispatchedAt: at,
			options,
			...this.header === void 0 ? {} : { header: this.header },
			...this.pressure === void 0 ? {} : { context: this.pressure },
			...this.contextRoute === void 0 ? {} : { contextRoute: this.contextRoute },
			counters: EMPTY_COUNTERS,
			settlement: "running",
			tools: []
		};
		this.drafts.push(draft);
		this.auxiliary = draft;
		this.evict();
	}
	/**
	* How many observations were dropped because no attempt could be identified for them.
	*
	* It is surfaced so "we lost something" is visible rather than silent — the alternative,
	* attaching it to the newest draft, is how a brick comes to hold another request's data.
	*/
	get unattributedCount() {
		return this.unattributed;
	}
	/** Every brick seen so far, oldest first. */
	records() {
		return this.drafts.map((draft) => this.materialize(draft));
	}
	/** The feed the browser consumes. */
	feed() {
		return {
			sessionId: this.sessionId,
			bricks: this.records(),
			endedTurns: [...this.endedTurns],
			store: {
				blobs: this.store.stats().blobs,
				bytes: this.store.stats().bytes
			},
			...this.unattributed === 0 ? {} : { unattributed: this.unattributed }
		};
	}
	/** Bricks for one `(turn, step)`, in attempt order. */
	attemptsOf(turn, step) {
		return this.drafts.filter((draft) => draft.turn === turn && draft.step === step).map((draft) => this.materialize(draft));
	}
	/**
	* Pair a live attempt with the dispatch that produced it.
	*
	* The order is not guaranteed: the loop constructs the attempt before calling
	* `llm.stream`, but the frames and the waterfall are observed through different
	* channels. Whichever arrives second completes the pair.
	*/
	startAttempt(observation) {
		const { turn, step } = observation;
		const ordinal = this.attemptCounts.get(`${String(turn)}:${String(step)}`) ?? 0;
		this.attemptCounts.set(`${String(turn)}:${String(step)}`, ordinal + 1);
		const pending = this.pendingDispatches.shift();
		const chain = this.retryChains.get(`${String(turn)}:${String(step)}`);
		const draft = {
			id: `${this.sessionId}:${String(turn)}:${String(step)}:${String(ordinal)}`,
			turn,
			step,
			attemptOrdinal: ordinal,
			...observation.attemptId === void 0 ? {} : { attemptId: observation.attemptId },
			...observation.revision === void 0 ? {} : { revision: observation.revision },
			...pending === void 0 ? {} : {
				dispatchedAt: pending.at,
				options: pending.options
			},
			...chain === void 0 ? {} : { retryChainId: chain },
			...this.header === void 0 ? {} : { header: this.header },
			...this.pressure === void 0 ? {} : { context: this.pressure },
			...this.contextRoute === void 0 ? {} : { contextRoute: this.contextRoute },
			counters: EMPTY_COUNTERS,
			settlement: "running",
			tools: []
		};
		this.drafts.push(draft);
		this.current = draft;
		this.queueAwaiting(draft);
		this.evict();
	}
	/** Count chunks, catch the first token, usage and finish. */
	applyChunk(observation) {
		const draft = observation.auxiliary === true ? this.auxiliary : this.current;
		if (draft === void 0) return void 0;
		const { chunk, at } = observation;
		draft.counters = {
			...draft.counters,
			chunkCount: draft.counters.chunkCount + 1
		};
		switch (chunk.type) {
			case "text":
				draft.counters = {
					...draft.counters,
					textChars: draft.counters.textChars + chunk.chars
				};
				break;
			case "reasoning":
				draft.counters = {
					...draft.counters,
					reasoningChars: draft.counters.reasoningChars + chunk.chars
				};
				break;
			case "tool-call":
				if (draft.tools.find((call) => call.callId === chunk.callId) === void 0) draft.tools.push({
					callId: chunk.callId,
					name: chunk.name ?? "",
					argumentsChars: chunk.argsChars,
					callAt: at
				});
				draft.counters = {
					...draft.counters,
					toolCallCount: draft.tools.length
				};
				break;
			case "usage":
				draft.usage = chunk.usage;
				draft.usageAt = at;
				break;
			case "finish":
				draft.finish = {
					reason: chunk.reason,
					...chunk.failure === void 0 ? {} : { failure: chunk.failure }
				};
				draft.finishAt = at;
		}
		if (draft.firstTokenAt === void 0 && (chunk.type === "text" || chunk.type === "reasoning" || chunk.type === "tool-call")) draft.firstTokenAt = at;
	}
	/** The live attempt frame ended: committed to the log or abandoned. */
	endAttempt(observation) {
		const draft = observation.auxiliary === true ? this.auxiliary : this.current;
		if (draft === void 0) return void 0;
		draft.settlement = observation.outcome === "abandoned" ? "abandoned" : observation.eventType === "assistant/attempt" ? "attempt" : "message";
		if (observation.seq !== void 0) draft.settlementSeq = observation.seq;
		draft.finishAt ??= observation.at;
		if (observation.auxiliary === true) this.auxiliary = void 0;
		else this.current = void 0;
		return this.materialize(draft);
	}
	/**
	* Enrich a brick with its durable settlement.
	*
	* The live end frame already said which event the attempt committed to; this
	* adds what only the log carries (authoritative usage, `interrupted`, the
	* embedded stream, the settlement `seq`).
	*/
	settle(snapshot) {
		const draft = (snapshot.seq > 0 ? this.drafts.find((draft) => draft.settlementSeq === snapshot.seq) : void 0) ?? (snapshot.turn === void 0 || snapshot.step === void 0 ? void 0 : this.takeAwaiting(snapshot.turn, snapshot.step));
		if (draft === void 0) {
			this.unattributed += 1;
			return;
		}
		this.forgetAwaiting(draft);
		if (draft.settlement === "running") draft.settlement = snapshot.settlement;
		draft.settlementSeq = snapshot.seq;
		draft.settlementTime = snapshot.time;
		if (snapshot.usage !== void 0) draft.usage = snapshot.usage;
		if (snapshot.interrupted === true) draft.interrupted = true;
		if (snapshot.finishReason !== void 0) draft.finish = {
			reason: snapshot.finishReason,
			...snapshot.failure === void 0 ? {} : { failure: snapshot.failure }
		};
		if (snapshot.streamRef !== void 0) draft.streamRef = snapshot.streamRef;
		if (snapshot.replayRef !== void 0) draft.replayRef = snapshot.replayRef;
		draft.finishAt ??= snapshot.time;
		if (this.current === draft) this.current = void 0;
		return this.materialize(draft);
	}
	/**
	* Attach a compaction id to the auxiliary call that performed it.
	*
	* The compaction row in the transcript is keyed by this id, while the auxiliary model
	* call is keyed by nothing at all — so this is the only link between the brick and the
	* row it belongs to. The call itself is the most recent `compaction` auxiliary call that
	* has not been claimed yet.
	*
	* @param compactionId - the id from the durable `compaction/start` event.
	* @returns the brick that changed, when an unclaimed one was found.
	*/
	attachCompaction(compactionId) {
		for (let index = this.drafts.length - 1; index >= 0; index -= 1) {
			const draft = this.drafts[index];
			if (draft.options?.purpose !== "compaction" || draft.compactionId !== void 0) continue;
			draft.compactionId = compactionId;
			return this.materialize(draft);
		}
	}
	/** A scheduled retry belongs to the attempt that failed. */
	attachRetry(snapshot) {
		const started = snapshot.turn === void 0 || snapshot.step === void 0 ? void 0 : this.attemptCounts.get(`${String(snapshot.turn)}:${String(snapshot.step)}`);
		const draft = this.draftAt(snapshot.turn, snapshot.step, snapshot.retry - 1) ?? (started === void 0 ? void 0 : this.draftAt(snapshot.turn, snapshot.step, started - 1));
		if (draft === void 0) {
			this.unattributed += 1;
			return;
		}
		draft.retry = {
			retryId: snapshot.retryId,
			provider: snapshot.provider,
			mode: snapshot.mode,
			policyKey: snapshot.policyKey,
			retry: snapshot.retry,
			...snapshot.maxRetries === void 0 ? {} : { maxRetries: snapshot.maxRetries },
			delayMs: snapshot.delayMs,
			...snapshot.failureMessage === void 0 ? {} : { failureMessage: snapshot.failureMessage },
			...snapshot.failureCode === void 0 ? {} : { failureCode: snapshot.failureCode }
		};
		this.retryChains.set(`${String(draft.turn)}:${String(draft.step)}`, snapshot.retryId);
		if (draft.finish === void 0 || draft.finish.reason !== "error") draft.finish = {
			reason: "error",
			...snapshot.failureMessage === void 0 ? {} : { failure: {
				message: snapshot.failureMessage,
				code: snapshot.failureCode ?? "unknown"
			} }
		};
		if (this.current === draft) this.current = void 0;
		return this.materialize(draft);
	}
	/** Attach the durable call record (raw arguments) to the brick that made it. */
	attachToolCall(observation) {
		for (let index = this.drafts.length - 1; index >= 0; index -= 1) {
			const draft = this.drafts[index];
			const callIndex = draft.tools.findIndex((call) => call.callId === observation.callId);
			if (callIndex === -1) {
				if (draft.settlement === "running" || index === this.drafts.length - 1) {
					draft.tools = [...draft.tools, {
						callId: observation.callId,
						name: observation.name,
						argumentsChars: observation.argumentsChars ?? 0,
						...observation.argumentsRef === void 0 ? {} : { argumentsRef: observation.argumentsRef }
					}];
					draft.counters = {
						...draft.counters,
						toolCallCount: draft.tools.length
					};
					return this.materialize(draft);
				}
				continue;
			}
			draft.tools[callIndex];
			draft.tools = draft.tools.map((entry, position) => position === callIndex ? {
				...entry,
				name: entry.name === "" ? observation.name : entry.name,
				...observation.argumentsRef === void 0 ? {} : { argumentsRef: observation.argumentsRef },
				...observation.argumentsChars === void 0 ? {} : { argumentsChars: observation.argumentsChars }
			} : entry);
			return this.materialize(draft);
		}
	}
	/** A tool result belongs to the attempt that emitted the call. */
	attachToolResult(observation) {
		for (let index = this.drafts.length - 1; index >= 0; index -= 1) {
			const draft = this.drafts[index];
			const callIndex = draft.tools.findIndex((call) => call.callId === observation.callId);
			if (callIndex === -1) continue;
			const call = draft.tools[callIndex];
			const updated = {
				...call,
				resultAt: observation.at,
				...call.callAt === void 0 ? {} : { durationMs: Math.max(0, observation.at - call.callAt) },
				...observation.isError === void 0 ? {} : { isError: observation.isError },
				...observation.error === void 0 ? {} : { error: observation.error },
				...observation.resultRef === void 0 ? {} : { resultRef: observation.resultRef }
			};
			draft.tools = draft.tools.map((entry, index2) => index2 === callIndex ? updated : entry);
			return this.materialize(draft);
		}
	}
	/**
	* Close dispatches that never got an attempt frame.
	*
	* A dispatch with no attempt is not noise: it is either an auxiliary call the
	* loop made outside a Turn (`session-title`, `compaction`) or a request that a
	* `llm/stream` listener vetoed before any frame existed. Both are worth a brick.
	*/
	flushOrphans(at) {
		let last;
		if (this.auxiliary !== void 0 && this.auxiliary.settlement === "running") {
			this.auxiliary.settlement = "abandoned";
			this.auxiliary.finishAt ??= at;
			last = this.materialize(this.auxiliary);
			this.auxiliary = void 0;
		}
		while (this.pendingDispatches.length > 0) {
			const pending = this.pendingDispatches.shift();
			const ordinal = this.attemptCounts.get("0:0") ?? 0;
			this.attemptCounts.set("0:0", ordinal + 1);
			const draft = {
				id: `${this.sessionId}:0:0:${String(ordinal)}`,
				turn: 0,
				step: 0,
				attemptOrdinal: ordinal,
				dispatchedAt: pending.at,
				options: pending.options,
				...this.header === void 0 ? {} : { header: this.header },
				...this.pressure === void 0 ? {} : { context: this.pressure },
				...this.contextRoute === void 0 ? {} : { contextRoute: this.contextRoute },
				counters: EMPTY_COUNTERS,
				settlement: "abandoned",
				finishAt: at,
				tools: []
			};
			this.drafts.push(draft);
			last = this.materialize(draft);
		}
		this.evict();
		return last;
	}
	/**
	* The drafts of one `(turn, step)` waiting to be settled by the log, oldest first.
	*
	* `(turn, step)` is a **bucket, not an identity**: one step can hold several attempts
	* (that is what a retry is), so it can narrow a settlement down to the attempts of that
	* step and no further. Within the bucket the rule is **FIFO**: the log settles a step's
	* attempts in the order they started, so the oldest unsettled one is the one being
	* settled. Picking "the newest" or "the newest running" instead would hand an early
	* attempt's verdict to a later one the moment two are in flight together — which is
	* exactly the interleave a retry creates.
	*/
	awaiting = /* @__PURE__ */ new Map();
	/** Queue a draft as awaiting its durable settlement. */
	queueAwaiting(draft) {
		const key = `${String(draft.turn)}:${String(draft.step)}`;
		const queue = this.awaiting.get(key);
		if (queue === void 0) this.awaiting.set(key, [draft]);
		else queue.push(draft);
	}
	/**
	* Consume the oldest unsettled attempt of one step.
	*
	* @param turn - the Turn the settlement names.
	* @param step - the step the settlement names.
	* @returns the draft, or undefined when that step has no unsettled attempt left.
	*/
	takeAwaiting(turn, step) {
		const key = `${String(turn)}:${String(step)}`;
		const queue = this.awaiting.get(key);
		if (queue === void 0) return void 0;
		const draft = queue.shift();
		if (queue.length === 0) this.awaiting.delete(key);
		return draft;
	}
	/** Drop a draft from its step's settlement queue, because it will not be settled again. */
	forgetAwaiting(draft) {
		const key = `${String(draft.turn)}:${String(draft.step)}`;
		const queue = this.awaiting.get(key);
		if (queue === void 0) return;
		const at = queue.indexOf(draft);
		if (at === -1) return;
		queue.splice(at, 1);
		if (queue.length === 0) this.awaiting.delete(key);
	}
	/** One exact attempt of a step, by its ordinal. */
	draftAt(turn, step, ordinal) {
		if (turn === void 0 || step === void 0 || ordinal === void 0) return void 0;
		return this.drafts.find((draft) => draft.turn === turn && draft.step === step && draft.attemptOrdinal === ordinal);
	}
	evict() {
		while (this.drafts.length > this.maxBricks) {
			const dropped = this.drafts.shift();
			if (dropped === this.current) this.current = void 0;
			if (dropped === void 0) continue;
			this.forgetAwaiting(dropped);
		}
	}
	/** Freeze a draft into the record the UI reads. */
	materialize(draft) {
		const options = draft.options;
		const usage = draft.usage;
		const contextWindow = draft.context?.contextWindow ?? draft.contextRoute?.contextWindow;
		const metrics = deriveMetrics(usage, {
			...draft.dispatchedAt === void 0 ? {} : { dispatchedAt: draft.dispatchedAt },
			...draft.firstTokenAt === void 0 ? {} : { firstTokenAt: draft.firstTokenAt },
			...draft.usageAt === void 0 ? {} : { usageAt: draft.usageAt },
			...draft.finishAt === void 0 ? {} : { finishAt: draft.finishAt }
		}, draft.counters, contextWindow);
		const route = {
			provider: options?.provider ?? draft.contextRoute?.provider ?? "unknown",
			model: options?.model ?? draft.contextRoute?.model ?? "unknown",
			...options?.purpose === void 0 ? {} : { purpose: options.purpose },
			...options?.reasoningEffort === void 0 ? {} : { reasoningEffort: options.reasoningEffort },
			...options?.temperature === void 0 ? {} : { temperature: options.temperature },
			...options?.maxTokens === void 0 ? {} : { maxTokens: options.maxTokens },
			...options?.stop === void 0 ? {} : { stop: options.stop },
			...contextWindow === void 0 ? {} : { contextWindow },
			...draft.header?.adapterDefaults?.reasoningEffort === true ? { reasoningEffortDefaulted: true } : {},
			...draft.header?.adapterDefaults?.maxTokens === true ? { maxTokensDefaulted: true } : {}
		};
		const context = {
			...draft.context?.pressureTokens === void 0 ? {} : { pressureTokens: draft.context.pressureTokens },
			...draft.context?.projectedTokens === void 0 ? {} : { projectedTokens: draft.context.projectedTokens },
			...contextWindow === void 0 ? {} : { contextWindow },
			...draft.context?.systemTokens === void 0 ? {} : { systemTokens: draft.context.systemTokens },
			...draft.context?.toolsTokens === void 0 ? {} : { toolsTokens: draft.context.toolsTokens },
			...draft.context?.messageTokens === void 0 ? {} : { messageTokens: draft.context.messageTokens },
			...draft.context?.meterRef === void 0 ? {} : { meterRef: draft.context.meterRef },
			...draft.context?.surfaceTokens === void 0 ? {} : { surfaceTokens: draft.context.surfaceTokens },
			...draft.context?.totalMeterTokens === void 0 ? {} : { totalMeterTokens: draft.context.totalMeterTokens },
			...draft.context?.surfaceDeltaTokens === void 0 ? {} : { surfaceDeltaTokens: draft.context.surfaceDeltaTokens },
			...draft.context?.baselineKind === void 0 ? {} : { baselineKind: draft.context.baselineKind },
			...draft.context?.baselineTokens === void 0 ? {} : { baselineTokens: draft.context.baselineTokens },
			...draft.context?.nodeCount === void 0 ? {} : { nodeCount: draft.context.nodeCount }
		};
		return {
			observedBy: "host",
			identity: {
				id: draft.id,
				sessionId: this.sessionId,
				turn: draft.turn,
				step: draft.step,
				attemptOrdinal: draft.attemptOrdinal,
				...draft.attemptId === void 0 ? {} : { attemptId: draft.attemptId },
				...draft.revision === void 0 ? {} : { revision: draft.revision }
			},
			settlement: draft.settlement,
			...draft.interrupted === void 0 ? {} : { interrupted: draft.interrupted },
			...draft.settlementSeq === void 0 ? {} : { settlementSeq: draft.settlementSeq },
			...draft.settlementTime === void 0 ? {} : { settlementTime: draft.settlementTime },
			route,
			...usage === void 0 ? {} : { usage },
			metrics,
			request: {
				...draft.header?.seq === void 0 ? {} : { headerEventSeq: draft.header.seq },
				...draft.header?.reason === void 0 ? {} : { headerReason: draft.header.reason },
				...draft.header?.startsSeries === void 0 ? {} : { startsSeries: draft.header.startsSeries },
				...options?.messageCount === void 0 ? {} : { messageCount: options.messageCount },
				...options?.developerMessageCount === void 0 ? {} : { developerMessageCount: options.developerMessageCount },
				...options?.toolSchemaCount === void 0 ? {} : { toolSchemaCount: options.toolSchemaCount },
				...options?.toolSchemaDeclared === void 0 ? {} : { toolSchemaDeclared: options.toolSchemaDeclared },
				...options?.toolSchemaAdded === void 0 ? {} : { toolSchemaAdded: options.toolSchemaAdded },
				...options?.toolSchemaActivated === void 0 ? {} : { toolSchemaActivated: options.toolSchemaActivated },
				...options?.deferredToolCount === void 0 ? {} : { deferredToolCount: options.deferredToolCount },
				...options?.toolUpdateMessages === void 0 ? {} : { toolUpdateMessages: options.toolUpdateMessages },
				...options?.toolHistoryRef === void 0 ? {} : { toolHistoryRef: options.toolHistoryRef },
				...(options?.systemHash ?? draft.header?.systemHash) === void 0 ? {} : { systemHash: options?.systemHash ?? draft.header?.systemHash },
				...(options?.toolsHash ?? draft.header?.toolsHash) === void 0 ? {} : { toolsHash: options?.toolsHash ?? draft.header?.toolsHash },
				...options?.messagesHash === void 0 ? {} : { messagesHash: options.messagesHash },
				...options?.messageHashesRef === void 0 ? {} : { messageHashesRef: options.messageHashesRef },
				...options?.messagesStored === void 0 ? {} : { messagesStored: options.messagesStored },
				...options?.sharedMessagePrefix === void 0 ? {} : { sharedMessagePrefix: options.sharedMessagePrefix },
				...draft.header?.headerHash === void 0 ? {} : { headerHash: draft.header.headerHash },
				...options?.requestRef === void 0 ? {} : { requestRef: options.requestRef },
				...draft.header?.headerRef === void 0 ? {} : { headerRef: draft.header.headerRef }
			},
			...Object.keys(context).length === 0 ? {} : { context },
			tools: draft.tools,
			...draft.retry === void 0 ? {} : { retry: draft.retry },
			...draft.retryChainId === void 0 ? {} : { retryChainId: draft.retryChainId },
			...draft.compactionId === void 0 ? {} : { compactionId: draft.compactionId },
			...draft.finish === void 0 ? {} : { finish: draft.finish },
			raw: {
				...draft.streamRef === void 0 ? {} : { streamRef: draft.streamRef },
				...draft.replayRef === void 0 ? {} : { replayRef: draft.replayRef }
			}
		};
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
* True when the peer is the local machine.
*
* An absent `remoteAddress` is **not** treated as local: this route serves whole
* requests, tool arguments and model streams, so an unidentifiable peer is
* refused rather than admitted. (With the harness fence in place this is only a
* backstop — the official policy runs first.)
*/
function isLoopback(request) {
	const address = request.socket?.remoteAddress;
	return address !== void 0 && LOOPBACK.has(address);
}
/**
* True when the request either carries no `Origin` (same-origin fetches from the
* page, and non-browser clients) or carries one matching the `Host` it was sent
* to. A cross-origin page cannot read the response either way without CORS, but
* refusing outright keeps the data out of reach of a stray `<img>`/`<script>`.
*/
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
	const text = JSON.stringify(body);
	response.statusCode = status;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.setHeader("cache-control", "no-store");
	response.end(text);
}
/**
* Build the route handler for the plugin's namespace.
* @param deps - ledger access.
* @returns a handler suitable for `webServer.register`, plus the path it serves.
*/
function createCacheBadgeRouter(deps, options = {}) {
	const path = options.basePath ?? "/cache-badge";
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
		const url = new URL(request.url ?? "/", "http://localhost");
		const route = url.pathname.slice(path.length);
		if (request.method !== "GET" && request.method !== "HEAD") {
			json(response, 405, { error: "method not allowed" });
			return;
		}
		if (route === "/sessions") {
			json(response, 200, { sessions: deps.sessions() });
			return;
		}
		if (route === "/attempts") {
			const sessionId = url.searchParams.get("sessionId");
			if (sessionId === null) {
				json(response, 400, { error: "sessionId is required" });
				return;
			}
			const feed = deps.feed(sessionId);
			json(response, feed === void 0 ? 404 : 200, feed ?? { error: "no observations for this session yet" });
			return;
		}
		if (route === "/blob") {
			const ref = url.searchParams.get("ref");
			if (ref === null) {
				json(response, 400, { error: "ref is required" });
				return;
			}
			const value = deps.blob(ref);
			if (value === void 0) {
				json(response, 404, { error: "unknown or evicted ref" });
				return;
			}
			json(response, 200, {
				ref,
				value
			});
			return;
		}
		if (route === "/stream") {
			const sessionId = url.searchParams.get("sessionId");
			if (sessionId === null) {
				json(response, 400, { error: "sessionId is required" });
				return;
			}
			response.writeHead?.(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive"
			});
			const send = (event, payload) => {
				response.write?.(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
			};
			const current = deps.feed(sessionId);
			if (current !== void 0) send("feed", current);
			const unsubscribe = deps.subscribe(sessionId, (feed) => {
				send("feed", feed);
			});
			const heartbeat = setInterval(() => {
				response.write?.(": hb\n\n");
			}, 25e3);
			let closed = false;
			const cleanup = () => {
				if (closed) return;
				closed = true;
				clearInterval(heartbeat);
				unsubscribe();
			};
			response.on?.("close", cleanup);
			return;
		}
		json(response, 404, { error: "unknown route" });
	};
	return {
		path,
		handler
	};
}
//#endregion
//#region src/host/observe.ts
/**
* Translating what the runtime emits into ledger observations.
*
* Everything here takes **plain data shaped like the runtime's own payloads** and
* returns the normalized observations the ledger folds. No DSH import is needed
* (the runtime types are structural), which is deliberate: the same code runs on
* 0.1.6-alpha.1 and 0.1.7-rc.1, and it can be unit-tested by handing it fake
* events instead of standing up a harness.
*
* The one rule that matters more than any field: an observation must never
* influence the request. The `llm/stream` tap reads the options and returns
* `next()` untouched; nothing in this module mutates its input.
*/
/** True when a declaration is deferred until a later developer message activates it. */
function isDeferredTool(tool) {
	return tool !== null && typeof tool === "object" && tool.deferLoading === true;
}
/** The name a declaration is keyed by, when it carries one. */
function toolNameOf(tool) {
	const name = tool?.name;
	return typeof name === "string" && name !== "" ? name : void 0;
}
/**
* The definitions a tool history contributes, in the order the history added them.
* @param history - the request's `toolHistory`, when it carries one.
* @returns the added declarations; empty for every core that predates the field.
*/
function toolAdditionsOf(history) {
	const additions = [];
	for (const update of history?.updates ?? []) for (const tool of update.additions ?? []) additions.push(tool);
	return additions;
}
/**
* The declaration list the model can call **at this point in the history**.
*
* The two halves overlap, and that is the whole subtlety of rc.2's shape: `tools` is the
* complete list the request header recorded — with not-yet-activated declarations flagged
* `deferLoading` — while `toolHistory`'s additions are the ones a later developer message
* activated, which are *already in that list*. Concatenating the two would count and store the
* same tool twice (measured: `["read","write","write"]`).
*
* So the list is deduplicated by name, first occurrence winning, and the `deferLoading`
* bookkeeping flag is dropped: the adapter strips it before dispatch (`projectToolUpdates`'s
* `withoutDeveloperMessages`/`immediateTools`), and a flag the provider never sees must not be
* able to move a hash whose entire job is to say "the tools changed here".
*
* @param tools - the request's declarations, as built.
* @param additions - what its tool history activated.
* @returns the effective declarations; equal to `tools` whenever the history adds nothing the
*   header did not already declare.
*/
function effectiveToolsOf(tools, additions) {
	const seen = /* @__PURE__ */ new Set();
	const effective = [];
	for (const tool of [...tools, ...additions]) {
		const name = toolNameOf(tool);
		if (name !== void 0) {
			if (seen.has(name)) continue;
			seen.add(name);
		}
		if (isDeferredTool(tool)) {
			const { deferLoading: _deferred, ...rest } = tool;
			effective.push(rest);
			continue;
		}
		effective.push(tool);
	}
	return effective;
}
/** The additions that genuinely extend the declared list, i.e. names it did not already carry. */
function newToolAdditionsOf(tools, additions) {
	const declared = /* @__PURE__ */ new Set();
	for (const tool of tools) {
		const name = toolNameOf(tool);
		if (name !== void 0) declared.add(name);
	}
	return additions.filter((tool) => {
		const name = toolNameOf(tool);
		return name !== void 0 && !declared.has(name);
	});
}
/** Normalize provider usage, keeping absent buckets absent. */
function usageOf(usage) {
	if (usage === void 0) return void 0;
	return {
		inputTokens: usage.inputTokens ?? 0,
		outputTokens: usage.outputTokens ?? 0,
		...usage.totalTokens === void 0 ? {} : { totalTokens: usage.totalTokens },
		...usage.cacheReadTokens === void 0 ? {} : { cacheReadTokens: usage.cacheReadTokens },
		...usage.cacheWriteTokens === void 0 ? {} : { cacheWriteTokens: usage.cacheWriteTokens },
		...usage.reasoningTokens === void 0 ? {} : { reasoningTokens: usage.reasoningTokens }
	};
}
/** Normalize a finish reason, which the runtime expresses as a tagged object. */
function finishOf(reason) {
	const kind = reason?.kind;
	if (kind !== "stop" && kind !== "tool-calls" && kind !== "max-tokens" && kind !== "aborted" && kind !== "error") return;
	const failure = reason?.failure;
	if (failure === void 0 || failure.message === void 0 || failure.code === void 0) return { reason: kind };
	return {
		reason: kind,
		failure: {
			message: failure.message,
			code: failure.code,
			...failure.status === void 0 ? {} : { status: failure.status },
			...failure.providerRetryAfterMs === void 0 ? {} : { providerRetryAfterMs: failure.providerRetryAfterMs },
			...failure.requestId === void 0 ? {} : { requestId: failure.requestId },
			...failure.offloadImages === void 0 ? {} : { offloadImages: failure.offloadImages }
		}
	};
}
/** Map one live stream chunk to counts and terminal facts. */
function chunkObservation(chunk) {
	switch (chunk.type) {
		case "text-delta": return {
			type: "text",
			chars: chunk.text?.length ?? 0
		};
		case "reasoning-delta": return {
			type: "reasoning",
			chars: chunk.text?.length ?? 0
		};
		case "tool-call-delta": {
			const delta = chunk;
			return {
				type: "tool-call",
				callId: delta.id ?? "",
				...delta.name === void 0 ? {} : { name: delta.name },
				argsChars: delta.argumentsDelta?.length ?? 0
			};
		}
		case "usage": {
			const usage = usageOf(chunk.usage);
			return usage === void 0 ? { type: "other" } : {
				type: "usage",
				usage
			};
		}
		case "finish": {
			const finish = finishOf(chunk.reason);
			return finish === void 0 ? { type: "other" } : {
				type: "finish",
				reason: finish.reason,
				...finish.failure === void 0 ? {} : { failure: finish.failure }
			};
		}
		default: return { type: "other" };
	}
}
/** Read the last `usage` chunk out of a durable compact stream. */
function usageFromStream(stream) {
	let found;
	for (const record of stream ?? []) {
		if (record.type !== "chunk") continue;
		const chunk = record.chunk;
		if (chunk?.type !== "usage") continue;
		found = usageOf(chunk.usage) ?? found;
	}
	return found;
}
/**
* Read the terminal finish out of a durable compact stream.
*
* Neither `assistant/message` nor `assistant/attempt` carries a finish reason at
* the top level — it exists only as the stream's final `finish` chunk.
*/
function finishFromStream(stream) {
	let found;
	for (const record of stream ?? []) {
		if (record.type !== "chunk") continue;
		const chunk = record.chunk;
		if (chunk?.type !== "finish") continue;
		found = finishOf(chunk.reason) ?? found;
	}
	return found;
}
/** Read the adapter's private replay state out of a durable stream. */
function replayFromStream(stream) {
	for (const record of stream ?? []) {
		if (record.type !== "chunk") continue;
		const chunk = record.chunk;
		if (chunk?.type === "finish" && chunk.replayState !== void 0) return chunk.replayState;
	}
}
/**
* Cheap structural fingerprint of a message, used to guard the hash memo.
*
* The runtime promises that a durable message's identity and content survive
* every boundary, so hashing a 600K-token history on every request would be pure
* waste. But a memo keyed on the id alone would silently report "prefix shared"
* for content that changed, which is worse than being slow — so a cache hit also
* requires this fingerprint (role, block count and types, total characters) to
* match. An edit that keeps the same id, the same block shape *and* the same
* character count can still slip through; nothing in the runtime can produce one.
*/
function messageFingerprint(message) {
	const content = Array.isArray(message.content) ? message.content : [];
	let chars = 0;
	let types = "";
	for (const block of content) {
		if (block === null || typeof block !== "object") {
			types += "?";
			continue;
		}
		const record = block;
		types += typeof record.type === "string" ? record.type[0] ?? "?" : "?";
		if (typeof record.text === "string") chars += record.text.length;
		else if (typeof record.arguments === "string") chars += record.arguments.length;
		else if (typeof record.content === "string") chars += record.content.length;
	}
	return `${message.role ?? "?"}|${String(content.length)}|${types}|${String(chars)}`;
}
/**
* Turns outgoing requests into refs and hashes, remembering per-message hashes so
* a long conversation is neither re-hashed nor re-stored on every call.
*
* Two levels of sharing come out of this: the hash memo keeps a stable message
* from being re-hashed, and the content-addressed store keeps it from being
* re-stored. A 525-message request whose predecessor shared 523 of them therefore
* costs two messages, one ref list and one small envelope — not a 1.7 MB copy.
*
* Identity-free one-shot inputs (`RequestUserInput`) have no stability promise at
* all and are always hashed.
*/
var RequestSummarizer = class {
	store;
	memo = /* @__PURE__ */ new Map();
	/**
	* The previous request's message refs, **per kind of request**.
	*
	* An auxiliary call (`compaction`, `session-title`) runs on a prompt of its own that has
	* nothing to do with the conversation, so using it as the baseline for the next Turn request
	* would report that request as sharing nothing — a number the diff then repeats as "the
	* prefix is shared up to message 0 of 300". Keeping one baseline per kind means a Turn
	* request is compared with the previous Turn request (so the count reads as "how much of the
	* prefix survived", for a compaction too) and an auxiliary call with the previous auxiliary
	* call.
	*/
	previousHashes = {
		turn: [],
		auxiliary: []
	};
	constructor(store) {
		this.store = store;
	}
	/**
	* Store one message and return its ref.
	*
	* The ref **is** the store's ref: computing it separately (say, by hashing the
	* message directly) would produce an address the store cannot resolve, and the
	* `has` check would then miss every time and re-store the whole history. The
	* memo is only a fast path — it saves re-serializing a message that a previous
	* request already stored — and it is keyed on the structural fingerprint so a
	* changed message can never reuse it.
	*/
	refForMessage(message) {
		const key = typeof message.id === "string" && message.source !== void 0 ? `${message.id}#${messageFingerprint(message)}` : void 0;
		if (key !== void 0) {
			const cached = this.memo.get(key);
			if (cached !== void 0) return {
				ref: cached,
				added: false
			};
		}
		const stored = this.store.put(message);
		const ref = stored?.hash ?? contentRef(stableJson(message));
		if (key !== void 0) this.memo.set(key, ref);
		return {
			ref,
			added: stored?.added === true
		};
	}
	/**
	* Summarize one outgoing request.
	* @param options - the request the runtime is about to dispatch (read only).
	* @returns the options block for the brick, including how much of the message
	*   prefix it shares with the previous request **of the same kind** (a Turn request
	*   is measured against the previous Turn request, an auxiliary call against the
	*   previous auxiliary call — an auxiliary prompt is not the conversation).
	*/
	summarize(options) {
		const messages = options.messages ?? [];
		const refs = [];
		let storedMessages = 0;
		for (const message of messages) {
			const { ref, added } = this.refForMessage(message);
			refs.push(ref);
			if (added) storedMessages += 1;
		}
		const kind = options.purpose === void 0 ? "turn" : "auxiliary";
		const baseline = this.previousHashes[kind];
		let shared = 0;
		while (shared < refs.length && shared < baseline.length && refs[shared] === baseline[shared]) shared += 1;
		this.previousHashes[kind] = refs;
		const tools = options.tools ?? [];
		const additions = toolAdditionsOf(options.toolHistory);
		const effectiveTools = effectiveToolsOf(tools, additions);
		const addedTools = newToolAdditionsOf(tools, additions);
		const deferredTools = tools.filter(isDeferredTool).length;
		let developerMessages = 0;
		for (const message of messages) if (message.role === "developer") developerMessages += 1;
		const toolHistoryRef = options.toolHistory === void 0 ? void 0 : this.store.put(options.toolHistory);
		const messagesRef = this.store.put({ refs });
		const toolsRef = effectiveTools.length === 0 ? void 0 : this.store.put({ tools: effectiveTools });
		const requestRef = this.store.put({
			provider: options.provider,
			model: options.model,
			...options.reasoningEffort === void 0 ? {} : { reasoningEffort: options.reasoningEffort },
			...options.temperature === void 0 ? {} : { temperature: options.temperature },
			...options.maxTokens === void 0 ? {} : { maxTokens: options.maxTokens },
			...options.stop === void 0 ? {} : { stop: options.stop },
			...options.system === void 0 ? {} : { system: options.system },
			toolSchemaCount: effectiveTools.length,
			...addedTools.length === 0 ? {} : {
				toolSchemaDeclared: tools.length,
				toolSchemaAdded: addedTools.length
			},
			...additions.length === 0 ? {} : { toolSchemaActivated: additions.length },
			...deferredTools === 0 ? {} : { deferredToolCount: deferredTools },
			...developerMessages === 0 ? {} : { developerMessageCount: developerMessages },
			...toolsRef === void 0 ? {} : { toolsRef: toolsRef.hash },
			...toolHistoryRef === void 0 ? {} : { toolHistoryRef: toolHistoryRef.hash },
			...messagesRef === void 0 ? {} : { messageRefsRef: messagesRef.hash },
			messageCount: refs.length
		});
		return {
			provider: options.provider ?? "unknown",
			model: options.model ?? "unknown",
			...options.reasoningEffort === void 0 ? {} : { reasoningEffort: options.reasoningEffort },
			...options.temperature === void 0 ? {} : { temperature: options.temperature },
			...options.maxTokens === void 0 ? {} : { maxTokens: options.maxTokens },
			...options.stop === void 0 ? {} : { stop: options.stop },
			...options.purpose === void 0 ? {} : { purpose: options.purpose },
			messageCount: messages.length,
			...developerMessages === 0 ? {} : { developerMessageCount: developerMessages },
			toolSchemaCount: effectiveTools.length,
			...addedTools.length === 0 ? {} : {
				toolSchemaDeclared: tools.length,
				toolSchemaAdded: addedTools.length
			},
			...additions.length === 0 ? {} : { toolSchemaActivated: additions.length },
			...deferredTools === 0 ? {} : { deferredToolCount: deferredTools },
			...options.toolHistory === void 0 ? {} : { toolUpdateMessages: options.toolHistory.updates?.length ?? 0 },
			...toolHistoryRef === void 0 ? {} : { toolHistoryRef: toolHistoryRef.hash },
			...options.system === void 0 ? {} : { systemHash: contentRef(options.system) },
			...effectiveTools.length === 0 ? {} : { toolsHash: contentRef(stableJson(effectiveTools)) },
			messagesHash: contentRef(refs.join(",")),
			messagesStored: storedMessages,
			...messagesRef === void 0 ? {} : { messageHashesRef: messagesRef.hash },
			sharedMessagePrefix: shared,
			...requestRef === void 0 ? {} : { requestRef: requestRef.hash }
		};
	}
};
/** JSON with object keys sorted, so equal payloads hash equally. */
function stableJson(value) {
	return JSON.stringify(value, (_key, item) => {
		if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
		if (item instanceof AbortSignal) return void 0;
		const source = item;
		const sorted = {};
		for (const key of Object.keys(source).sort()) {
			if (key === "signal") continue;
			sorted[key] = source[key];
		}
		return sorted;
	}) ?? "null";
}
/** Build the observation for a `request/header` event. */
function headerObservation(event, store) {
	const data = event.data;
	if (data?.header === void 0) return void 0;
	const reason = data.reason;
	const headerHash = contentRef(stableJson(data.header));
	const ref = store.put(data.header);
	const tools = data.header.tools ?? [];
	return {
		kind: "header",
		snapshot: {
			seq: event.seq ?? 0,
			reason: reason === "resume" || reason === "change" || reason === "series" ? reason : "initial",
			...data.startsSeries === true ? { startsSeries: true } : {},
			...data.header.adapterDefaults === void 0 ? {} : { adapterDefaults: data.header.adapterDefaults },
			headerHash,
			...ref === void 0 ? {} : { headerRef: ref.hash },
			...tools.length === 0 ? {} : { toolsHash: contentRef(stableJson(tools)) },
			toolSchemaCount: tools.length
		}
	};
}
/**
* Build the observation for a `compaction/start` event.
*
* This is the id the transcript's compaction row is keyed by — the chat view anchors that
* node at its own checkpoint seq, **not** at the auxiliary model call's settlement seq, so
* the id is the only thing that can bridge the two.
*
* @param event - the durable compaction event.
* @returns the observation, or undefined when the event names no compaction.
*/
function compactionObservation(event) {
	const compactionId = event.data?.compactionId;
	if (typeof compactionId !== "string" || compactionId === "") return void 0;
	return {
		kind: "compaction",
		compactionId
	};
}
/** Build the observation for a `request/context` event. */
function contextObservation(event) {
	const data = event.data;
	if (data?.provider === void 0 || data.model === void 0) return void 0;
	return {
		kind: "context",
		snapshot: {
			provider: data.provider,
			model: data.model,
			...data.contextWindow === void 0 ? {} : { contextWindow: data.contextWindow },
			...data.systemPromptUpdate === "in-history" ? { systemPromptUpdate: "in-history" } : {}
		}
	};
}
/** Build the observation for an `llm/retry` event. */
function retryObservation(event) {
	const data = event.data;
	if (data?.retryId === void 0 || data.retry === void 0) return void 0;
	return {
		kind: "retry",
		snapshot: {
			retryId: data.retryId,
			...data.turn === void 0 ? {} : { turn: data.turn },
			...data.step === void 0 ? {} : { step: data.step },
			provider: data.provider ?? "unknown",
			mode: data.mode === "always" ? "always" : "normal",
			policyKey: data.policyKey ?? "",
			retry: data.retry,
			...data.maxRetries === void 0 ? {} : { maxRetries: data.maxRetries },
			delayMs: data.delayMs ?? 0,
			...data.failure?.message === void 0 ? {} : { failureMessage: data.failure.message },
			...data.failure?.code === void 0 ? {} : { failureCode: data.failure.code }
		}
	};
}
/**
* Build the observation for an `assistant/message` or `assistant/attempt` event.
*
* Usage comes from `data.usage` when present and from the embedded stream
* otherwise: `assistant/attempt` never carries usage, so a failed attempt would
* otherwise look free.
*/
function settlementObservation(event, store) {
	const data = event.data;
	if (data?.turn === void 0 || data.step === void 0) return void 0;
	const stream = data.stream;
	const usage = usageOf(data.usage) ?? usageFromStream(stream);
	const finish = finishFromStream(stream);
	const streamRef = store.put(stream ?? []);
	const replay = replayFromStream(stream);
	const replayRef = replay === void 0 ? void 0 : store.put(replay);
	return {
		kind: "settled",
		snapshot: {
			seq: event.seq ?? 0,
			time: event.time ?? Date.now(),
			turn: data.turn,
			step: data.step,
			settlement: data.usage === void 0 && usage === void 0 ? "attempt" : "message",
			...usage === void 0 ? {} : { usage },
			...data.interrupted === true ? { interrupted: true } : {},
			...finish === void 0 ? {} : { finishReason: finish.reason },
			...finish?.failure === void 0 ? {} : { failure: finish.failure },
			...streamRef === void 0 ? {} : { streamRef: streamRef.hash },
			...replayRef === void 0 ? {} : { replayRef: replayRef.hash }
		}
	};
}
/** Build the observation for a durable `tool/call` event. */
function toolCallObservation(event, store) {
	const data = event.data;
	if (data?.callId === void 0) return void 0;
	const ref = data.arguments === void 0 ? void 0 : store.put(data.arguments);
	return {
		kind: "tool-call",
		at: event.time ?? Date.now(),
		seq: event.seq ?? 0,
		callId: data.callId,
		name: data.name ?? "",
		...ref === void 0 ? {} : { argumentsRef: ref.hash },
		...data.arguments === void 0 ? {} : { argumentsChars: data.arguments.length }
	};
}
/** Build the observation for a durable `tool/result` event. */
function toolResultObservation(event, store) {
	const message = event.data?.message;
	const callId = message?.toolCallId;
	if (callId === void 0) return void 0;
	const ref = store.put(message?.content ?? null);
	return {
		kind: "tool-result",
		at: event.time ?? Date.now(),
		callId,
		...message?.isError === void 0 ? {} : { isError: message.isError },
		...event.data?.error === void 0 ? {} : { error: {
			name: event.data.error.name ?? "Error",
			code: event.data.error.code ?? "unknown",
			...event.data.error.reason === void 0 ? {} : { reason: event.data.error.reason }
		} },
		...ref === void 0 ? {} : { resultRef: ref.hash }
	};
}
//#endregion
//#region src/host/collect.ts
/**
* The host half's collector: a read-only tap on the model-call path plus the
* ledger and HTTP surface behind it.
*
* The whole design rests on one promise: **observing a request must not change
* it**. DSH makes that easy to keep, and hard to break silently:
*
* - `llm/stream` is a waterfall, so its listener *is* the dispatch: the value it
*   returns is the stream the agent loop consumes. Every path through this module
*   returns `next()` — a listener that returns nothing would replace the model's
*   stream with `undefined`.
* - A loop-built request arrives deep-frozen, so writing to it throws rather than
*   corrupting the prompt; this module only reads.
* - Observation happens inside `try`/`catch`: a bug in the ledger must never turn
*   into a failed model call.
*
* Attempt identity is the other half of the design. `llm/stream` carries the
* request but no turn/step/attempt id; `agent/assistant-stream` carries the
* identity but no request. The ledger pairs them through a per-session FIFO, so
* whichever channel reports first, the two meet.
*/
/**
* Install the collector on a host context.
* @param ctx - the plugin's Cordis context.
* @param options - capacity and serving options.
* @returns the collector, so tests and hosts can read from it directly.
*/
function installCollector(ctx, options = {}) {
	const store = new BlobStore({ maxTotalBytes: options.maxStoreBytes ?? 50331648 });
	const sessions = /* @__PURE__ */ new Map();
	let disposed = false;
	/** Run an observation without ever letting it reach the caller. */
	const safely = (action) => {
		try {
			action();
		} catch (error) {
			console.warn("[dsh-cache-badge] observation failed:", error instanceof Error ? error.message : error);
		}
	};
	/**
	* Session states, capped. A long-running host sees many sessions, and each one
	* holds a ledger and (through the shared store) raw payloads; the oldest is
	* dropped rather than kept until the plugin is disposed.
	*/
	const MAX_SESSIONS = options.maxSessions ?? 8;
	const stateFor = (sessionId) => {
		const existing = sessions.get(sessionId);
		if (existing !== void 0) {
			sessions.delete(sessionId);
			sessions.set(sessionId, existing);
			return existing;
		}
		if (sessions.size >= MAX_SESSIONS) {
			const oldest = sessions.keys().next();
			if (oldest.done !== true) sessions.delete(oldest.value);
		}
		const state = {
			ledger: new BrickLedger(sessionId, {
				store,
				...options.maxBricks === void 0 ? {} : { maxBricks: options.maxBricks }
			}),
			summarizer: new RequestSummarizer(store),
			listeners: /* @__PURE__ */ new Set(),
			warnedUnattributed: false
		};
		sessions.set(sessionId, state);
		return state;
	};
	const PUBLISH_INTERVAL_MS = 100;
	let lastPublish = 0;
	let trailing;
	const publishNow = (state) => {
		lastPublish = Date.now();
		if (state.listeners.size === 0) return;
		const feed = state.ledger.feed();
		for (const listener of state.listeners) try {
			listener(feed);
		} catch {}
	};
	/**
	* Push the current feed, coalesced to at most one send per
	* {@link PUBLISH_INTERVAL_MS}. The trailing send matters: the last observation
	* of an attempt must reach the browser even if it lands inside a quiet window.
	*/
	const publish = (state) => {
		const wait = PUBLISH_INTERVAL_MS - (Date.now() - lastPublish);
		if (wait <= 0) {
			publishNow(state);
			return;
		}
		if (trailing !== void 0) return;
		trailing = setTimeout(() => {
			trailing = void 0;
			publishNow(state);
		}, wait);
	};
	/**
	* Observations worth waking a browser for.
	*
	* `agent/assistant-stream` emits one frame per token-level delta, and materializing
	* every retained brick (up to 400) plus serializing the whole feed on each of a
	* long answer's ~1500 chunks is pure waste: nothing a brick displays changes
	* until usage, a tool call, or the attempt ends. Text and reasoning deltas are
	* still folded — they just do not trigger a push.
	*/
	const publishable = (observation) => {
		if (observation.kind === "chunk") {
			const type = observation.chunk.type;
			return type === "usage" || type === "finish" || type === "tool-call";
		}
		return true;
	};
	const collect = (sessionId, observation) => {
		const state = stateFor(sessionId);
		state.ledger.observe(observation);
		if (!state.warnedUnattributed && state.ledger.unattributedCount > 0) {
			state.warnedUnattributed = true;
			console.warn(`[dsh-cache-badge] dropped ${String(state.ledger.unattributedCount)} observation(s) for session ${sessionId}: no attempt could be identified for them (see feed.unattributed).`);
		}
		if (state.listeners.size === 0) return;
		if (!publishable(observation)) return;
		publish(state);
	};
	/** Snapshot the context environment at dispatch: pressure, composition, meter. */
	const snapshotContext = (sessionId) => {
		const session = ctx.get("sessions")?.get(sessionId);
		if (session === void 0) return;
		const pressure = ctx.get("sessionProjections")?.stateOf(session, "contextPressure");
		const breakdown = ctx.get("sessionProjections")?.stateOf(session, "contextBreakdown");
		const header = session.requestHeader?.();
		const meter = ctx.get("tokenMeter")?.measure(session, header);
		const meterRef = meter === void 0 ? void 0 : store.put(meter);
		const projected = pressure?.pressureTokens !== void 0 && pressure.surfaceTokens !== void 0 && pressure.sampledSurfaceTokens !== void 0 ? Math.max(0, pressure.pressureTokens + pressure.surfaceTokens - pressure.sampledSurfaceTokens) : void 0;
		collect(sessionId, {
			kind: "pressure",
			snapshot: {
				...pressure?.contextWindow === void 0 ? {} : { contextWindow: pressure.contextWindow },
				...pressure?.pressureTokens === void 0 ? {} : { pressureTokens: pressure.pressureTokens },
				...projected === void 0 ? {} : { projectedTokens: projected },
				...pressure?.surfaceTokens === void 0 ? {} : { surfaceTokens: pressure.surfaceTokens },
				...breakdown?.systemTokens === void 0 ? {} : { systemTokens: breakdown.systemTokens },
				...breakdown?.toolsTokens === void 0 ? {} : { toolsTokens: breakdown.toolsTokens },
				...breakdown?.messageTokens === void 0 ? {} : { messageTokens: breakdown.messageTokens },
				...meter?.baseline?.kind === void 0 ? {} : { baselineKind: meter.baseline.kind },
				...meter?.baseline?.tokens === void 0 ? {} : { baselineTokens: meter.baseline.tokens },
				...meter?.surfaceDeltaTokens === void 0 ? {} : { surfaceDeltaTokens: meter.surfaceDeltaTokens },
				...meter?.totalTokens === void 0 ? {} : { totalMeterTokens: meter.totalTokens },
				...meter?.nodes === void 0 ? {} : { nodeCount: meter.nodes.length },
				...meterRef === void 0 ? {} : { meterRef: meterRef.hash }
			}
		});
	};
	ctx.on("llm/stream", ((...args) => {
		const options = args[0];
		const next = args[1];
		let sessionId = "unknown";
		try {
			if (typeof options.sessionId === "string") sessionId = options.sessionId;
		} catch {
			sessionId = "unknown";
		}
		safely(() => {
			snapshotContext(sessionId);
			collect(sessionId, {
				kind: "dispatch",
				at: Date.now(),
				options: stateFor(sessionId).summarizer.summarize(options)
			});
		});
		const stream = next();
		let purpose;
		try {
			purpose = options.purpose;
		} catch {
			purpose = void 0;
		}
		if (purpose !== "compaction" && purpose !== "session-title") return stream;
		return observeAuxiliary(stream, sessionId);
	}), {
		global: true,
		prepend: true
	});
	/**
	* Pass every chunk through untouched while folding it onto the auxiliary brick.
	* @param stream - the downstream async iterable.
	* @param sessionId - the session the call belongs to.
	* @returns an iterable that yields the same chunks in the same order.
	*/
	async function* observeAuxiliary(stream, sessionId) {
		try {
			for await (const chunk of stream) {
				safely(() => {
					collect(sessionId, {
						kind: "chunk",
						at: Date.now(),
						chunk: chunkObservation(chunk),
						auxiliary: true
					});
				});
				yield chunk;
			}
		} finally {
			safely(() => {
				collect(sessionId, {
					kind: "attempt-end",
					at: Date.now(),
					outcome: "committed",
					auxiliary: true
				});
			});
		}
	}
	ctx.on("agent/assistant-stream", ((...args) => {
		const payload = args[0];
		const frame = payload?.frame;
		if (frame === void 0) return;
		safely(() => {
			const sessionId = payload.agent?.session?.id ?? "unknown";
			stateFor(sessionId);
			if (frame.type === "start") {
				collect(sessionId, {
					kind: "attempt-start",
					at: Date.now(),
					turn: frame.turn ?? 0,
					step: frame.step ?? 0,
					...frame.attemptId === void 0 ? {} : { attemptId: frame.attemptId },
					...frame.revision === void 0 ? {} : { revision: frame.revision }
				});
				return;
			}
			if (frame.type === "chunk") {
				if (frame.chunk === void 0) return;
				collect(sessionId, {
					kind: "chunk",
					at: frame.time ?? Date.now(),
					chunk: chunkObservation(frame.chunk)
				});
				return;
			}
			if (frame.type === "end") {
				const committed = frame.outcome?.kind === "committed";
				collect(sessionId, {
					kind: "attempt-end",
					at: Date.now(),
					outcome: committed ? "committed" : "abandoned",
					...committed && frame.outcome?.eventType !== void 0 ? { eventType: frame.outcome.eventType } : {},
					...frame.outcome?.seq === void 0 ? {} : { seq: frame.outcome.seq }
				});
			}
		});
	}), { global: true });
	ctx.on("session/event", ((...args) => {
		const session = args[0];
		const event = args[1];
		if (session?.id === void 0 || event?.type === void 0) return;
		safely(() => {
			const sessionId = session.id;
			switch (event.type) {
				case "request/header":
					collect(sessionId, headerObservation({
						seq: event.seq,
						data: event.data
					}, store) ?? {
						kind: "flush",
						at: Date.now()
					});
					break;
				case "request/context":
					safely(() => {
						const observation = contextObservation({ data: event.data });
						if (observation !== void 0) collect(sessionId, observation);
					});
					break;
				case "assistant/message":
				case "assistant/attempt":
					safely(() => {
						const observation = settlementObservation({
							seq: event.seq,
							time: event.time,
							data: event.data
						}, store);
						if (observation !== void 0) collect(sessionId, observation);
					});
					break;
				case "turn/end": {
					const turn = event.data?.turn;
					if (typeof turn === "number") collect(sessionId, {
						kind: "turn-end",
						turn
					});
					break;
				}
				case "compaction/start":
					safely(() => {
						const observation = compactionObservation({ data: event.data });
						if (observation !== void 0) collect(sessionId, observation);
					});
					break;
				case "llm/retry":
					safely(() => {
						const observation = retryObservation({ data: event.data });
						if (observation !== void 0) collect(sessionId, observation);
					});
					break;
				case "tool/call":
					safely(() => {
						const observation = toolCallObservation({
							seq: event.seq,
							time: event.time,
							data: event.data
						}, store);
						if (observation !== void 0) collect(sessionId, observation);
					});
					break;
				case "tool/result": safely(() => {
					const observation = toolResultObservation({
						time: event.time,
						data: event.data
					}, store);
					if (observation !== void 0) collect(sessionId, observation);
				});
			}
		});
	}), { global: true });
	const collector = {
		store,
		feed: (sessionId) => sessions.get(sessionId)?.ledger.feed(),
		sessions: () => [...sessions.keys()],
		blob: (ref) => store.get(ref),
		subscribe: (sessionId, sink) => {
			const state = stateFor(sessionId);
			state.listeners.add(sink);
			return () => {
				state.listeners.delete(sink);
			};
		},
		dispose: () => {
			disposed = true;
			sessions.clear();
			if (trailing !== void 0) {
				clearTimeout(trailing);
				trailing = void 0;
			}
		}
	};
	if (options.serve !== false) {
		const router = createCacheBadgeRouter({
			feed: (sessionId) => collector.feed(sessionId),
			sessions: () => collector.sessions(),
			blob: (ref) => collector.blob(ref),
			subscribe: (sessionId, sink) => collector.subscribe(sessionId, sink)
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
* The cache badge is a browser-facing plugin, but its data cannot be gathered in
* the browser: the outgoing request, the attempt identity, the retry records and
* the token-meter snapshot only exist on the host. This half therefore installs a
* **read-only** collector (see `./host/collect`) and serves what it gathered over
* its own HTTP namespace.
*
* It adds no tool, no prompt section and no request rewrite: the plugin's only
* interaction with the model-call path is an `llm/stream` observer that returns
* `next()` untouched. The two server-side facts that make this safe are the
* waterfall contract (returning anything else would replace the model's stream)
* and the deep-frozen loop request (writing to it throws), both verified against
* the installed runtime.
*/
const name = "dsh-cache-badge";
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
