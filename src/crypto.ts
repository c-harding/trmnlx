import { createHash, timingSafeEqual } from "node:crypto";

export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest();

// Compares two strings in constant time, whatever their lengths.
export const safeEqual = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));
