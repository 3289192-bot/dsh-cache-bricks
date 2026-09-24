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
/**
 * Hash bytes.
 * @param data - the message.
 * @returns the 32-byte digest.
 */
export declare function sha256(data: Uint8Array): Uint8Array;
/** UTF-8 bytes of a string, without depending on Node's `Buffer`. */
export declare function utf8Bytes(text: string): Uint8Array;
/** Byte length of a string in UTF-8 (not its character count). */
export declare function utf8Length(text: string): number;
/**
 * Hash text or bytes to lowercase hex.
 * @param input - a string (UTF-8 encoded) or raw bytes.
 * @returns 64 hex characters.
 */
export declare function sha256Hex(input: string | Uint8Array): string;
/**
 * Short content ref: the first 32 hex characters (128 bits).
 *
 * Long enough that a collision is not a practical concern for a few hundred
 * thousand payloads, short enough to sit in a URL and in a record without noise.
 * @param input - a string (UTF-8 encoded) or raw bytes.
 * @returns 32 hex characters.
 */
export declare function contentRef(input: string | Uint8Array): string;
