/**
 * dsh-session-purge — host half (Node.js runtime).
 *
 * Mounts secure HTTP endpoints:
 *   - POST /session-purge/api/purge (and compatibility alias /session-purge/api/delete)
 *
 * Core capabilities:
 * 1. Physical Removal: Recursively removes session directory or log files from disk.
 * 2. Strict Safety Assertion: Prevents parent/workspace directory wipeouts by asserting
 *    that the target path strictly matches the UUID session ID.
 * 3. CSRF & Localhost Guard: Enforces origin and host check, rejecting cross-site requests.
 * 4. In-Memory Session Detachment: Cancels running agent turns and detaches in-memory entries,
 *    preventing memory resurrection.
 * 5. Accounting Cleanup: Cleans workspace registry sessionIds and archivedSessionIds.
 */
import { access, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export const name = "dsh-session-purge";
export const inject = ["webServer"];

const SESSION_ID_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BODY_BYTES = 1 << 20; // 1MB body bound
const ROUTE_PREFIXES = ["/session-purge", "/session-delete"];

/** Error carrying an HTTP status code */
export class SessionPurgeError extends Error {
	constructor(code, message, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
}

/** Check if the request is from a legitimate local origin (CSRF defense) */
function isAllowedRequest(req) {
	const host = req.headers?.host ?? "";
	const isLocalHost = host === "" || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
	if (!isLocalHost) return false;

	// Check Origin if present (defense against CSRF from evil.com)
	const origin = req.headers?.origin;
	if (origin) {
		try {
			const originUrl = new URL(origin);
			const isLocalOrigin = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(originUrl.hostname);
			if (!isLocalOrigin) return false;
		} catch {
			return false;
		}
	}

	// Reject cross-site fetch requests
	const secFetchSite = req.headers?.["sec-fetch-site"];
	if (secFetchSite && secFetchSite === "cross-site") {
		return false;
	}

	return true;
}

/** Read and parse the JSON request body */
async function readJsonBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		total += buffer.length;
		if (total > MAX_BODY_BYTES) throw new SessionPurgeError("bad-request", "request body too large", 400);
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim() === "") return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new SessionPurgeError("bad-request", "request body is not valid JSON", 400);
	}
}

function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(payload);
}

function writeOk(res, value) {
	writeJson(res, 200, { ok: true, value });
}

function writeError(res, error) {
	if (error instanceof SessionPurgeError) {
		writeJson(res, error.status, {
			ok: false,
			error: { code: error.code, message: error.message }
		});
		return;
	}
	writeJson(res, 500, {
		ok: false,
		error: { code: "internal", message: String(error?.message ?? error) }
	});
}

/**
 * Safely resolves the target filesystem path to be removed.
 * Strictly asserts that the target is bound to sessionId, preventing accidental deletion of parent dirs.
 */
export function resolveSafePurgeTarget(locationPath, sessionId) {
	const normalized = resolve(locationPath);
	const parentDir = dirname(normalized);
	const parentBase = basename(parentDir);
	const fileBase = basename(normalized);

	// Case 1: Session has its own directory: .../session-<uuid>/log.jsonl
	if (parentBase === sessionId) {
		return { targetPath: parentDir, isDirectory: true };
	}

	// Case 2: Target path points directly to session directory: .../session-<uuid>
	if (fileBase === sessionId) {
		return { targetPath: normalized, isDirectory: true };
	}

	// Case 3: Flat file: .../session-<uuid>.jsonl
	if (fileBase.startsWith(sessionId)) {
		return { targetPath: normalized, isDirectory: false };
	}

	// Safety violation: path does not contain sessionId in basename
	throw new SessionPurgeError(
		"path-safety-violation",
		`安全拦截：定位路径 "${normalized}" 未严格匹配会话 ID "${sessionId}"，拒绝操作以防止误删父目录。`,
		500
	);
}

/**
 * Plugin body: register routes and handlers
 */
export function apply(ctx) {
	for (const prefix of ROUTE_PREFIXES) {
		ctx.effect(() => ctx.webServer.register({
			kind: "prefix",
			path: prefix,
			handler: async (req, res) => {
				try {
					if (!isAllowedRequest(req)) throw new SessionPurgeError("forbidden", "forbidden request source", 403);
					if (req.method !== "POST") throw new SessionPurgeError("method-error", "method not allowed", 405);

					const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
					const endpoint = pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length + 1) : void 0;

					if (endpoint !== "api/purge" && endpoint !== "api/delete") {
						throw new SessionPurgeError("not-found", `unknown endpoint "${endpoint ?? ""}"`, 404);
					}

					const result = await purgeSession(ctx, await readJsonBody(req));
					writeOk(res, result);
				} catch (error) {
					writeError(res, error);
				}
			}
		}), `dsh-session-purge: routes (${prefix})`);
	}
}

/**
 * Physically purge a session and clean registry accounting.
 */
export async function purgeSession(ctx, payload) {
	const sessionId = payload?.sessionId;
	if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
		throw new SessionPurgeError("invalid-session-id", "sessionId 格式无效，必须符合 'session-<uuid>' 规则");
	}

	const sessions = ctx.get("sessions");
	const persistence = ctx.get("sessionPersistence");
	if (persistence === void 0) {
		throw new SessionPurgeError("no-persistence", "DSH sessionPersistence 持久化服务不可用", 500);
	}

	// Handle in-memory / live session
	const live = sessions?.get?.(sessionId);
	let header;
	if (live !== void 0) {
		// Cancel active agent turn
		const agents = ctx.get("agents");
		try {
			agents?.get?.(sessionId)?.cancel?.({ kind: "user" }, { keepInbox: false });
		} catch (error) {
			ctx.logger?.warn?.(`dsh-session-purge: cancel agent failed for ${sessionId}: ${String(error?.message ?? error)}`);
		}

		// Detach in-memory session to prevent memory resurrecting the disk file
		const entry = sessions.store?.get?.(sessionId);
		if (entry?.detach !== void 0) {
			try {
				entry.detach();
			} catch (error) {
				throw new SessionPurgeError("detach-failed", `无法从内存中安全移除会话：${String(error?.message ?? error)}`);
			}
		}
		header = live.header;
	}

	// Fallback to persistence header list if not live
	if (!header) {
		const headers = await persistence.list();
		header = headers.find((item) => String(item.id) === sessionId);
		if (!header) {
			throw new SessionPurgeError("session-not-found", `会话 ${sessionId} 不存在或已被删除`, 404);
		}
	}

	// Locate session file via official persistence contract
	const location = persistence.locate(header);
	if (location?.kind !== "jsonl" || typeof location.path !== "string") {
		throw new SessionPurgeError("unsupported-backend", `不支持的会话持久化后端类型: "${String(location?.kind)}"`, 500);
	}

	// Safe target resolution
	const { targetPath, isDirectory } = resolveSafePurgeTarget(location.path, sessionId);

	// Remove from disk
	await rm(targetPath, { recursive: isDirectory, force: true });

	// Double check that it has been removed
	try {
		await access(targetPath);
		throw new SessionPurgeError("delete-failed", `无法彻底删除目标路径 ${targetPath}`, 500);
	} catch (error) {
		if (error instanceof SessionPurgeError) throw error;
		// ENOENT means successfully removed
	}

	// Clean workspace registry accounting
	await removeSessionAccounting(ctx, sessionId);

	return { sessionId, path: targetPath, purged: true };
}

/**
 * Remove session ID from workspace items and archivedSessionIds state.
 */
async function removeSessionAccounting(ctx, sessionId) {
	const registry = ctx.get("workspaceRegistry");
	if (registry === void 0 || typeof registry.enqueueOperation !== "function") return;

	await registry.enqueueOperation(async () => {
		const table = registry.requireTable?.() ?? registry.table;
		if (table && typeof table.entries === "function") {
			const updates = [];
			for (const [id, record] of table.entries()) {
				if (Array.isArray(record.sessionIds) && record.sessionIds.includes(sessionId)) {
					updates.push(table.update(id, (current) => ({
						...current,
						sessionIds: current.sessionIds.filter((entry) => entry !== sessionId)
					})));
				}
			}
			await Promise.all(updates);
		}

		const state = registry.requireState?.() ?? registry.state;
		if (state && Array.isArray(state.archivedSessionIds) && state.archivedSessionIds.includes(sessionId)) {
			await registry.setState({
				...state,
				archivedSessionIds: state.archivedSessionIds.filter((entry) => entry !== sessionId)
			});
		}
	});
}
