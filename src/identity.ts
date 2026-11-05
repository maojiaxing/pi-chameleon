import { createHash, randomBytes, randomUUID } from "node:crypto";

/** A generated device id, stable for the lifetime of this Pi process. */
export const DEVICE_ID = randomBytes(32).toString("hex");
const FALLBACK_SESSION_ID = randomUUID();

/** Preserve real UUIDs; derive a stable UUID without exposing Pi paths or ids. */
export function sessionUuid(sessionId: string | undefined): string {
	if (sessionId === undefined) return FALLBACK_SESSION_ID;
	if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
		return sessionId;
	}
	const value = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
	return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20)}`;
}
