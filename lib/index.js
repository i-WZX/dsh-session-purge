/**
 * dsh-session-purge — host half (Node.js runtime).
 *
 * Mounts secure HTTP endpoints:
 *   - POST /session-purge/api/purge (and compatibility alias /session-purge/api/delete)
 *
 * Core capabilities:
 * 1. Physical Removal: Recursively removes session directory or log files from disk.
 * 2. Multi-tier Location Engine:
 *    - Official sessionPersistence locator
 *    - Direct ~/.dsh/sessions/{workspace}/{sessionId} filesystem locator fallback
 *    - ~/.dsh/storages/session_projcache/sessions/{sessionId}.json cache cleanup
 * 3. Strict Safety Assertion: Prevents parent/workspace directory wipeouts by asserting
 *    that the target path strictly matches the UUID session ID.
 * 4. CSRF & Localhost Guard: Enforces origin and host check, rejecting cross-site requests.
 * 5. In-Memory Session Detachment: Cancels running agent turns and detaches in-memory entries.
 * 6. Accounting Cleanup: Cleans workspace registry sessionIds and archivedSessionIds.
 */
import { access, readdir, rm, stat, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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

	// Case 1: Session has its own directory: .../session-<uuid>/log.jsonl or .../session-<uuid>/session.v4.jsonl.zstd
	if (parentBase === sessionId) {
		return { targetPath: parentDir, isDirectory: true };
	}

	// Case 2: Target path points directly to session directory: .../session-<uuid>
	if (fileBase === sessionId) {
		return { targetPath: normalized, isDirectory: true };
	}

	// Case 3: Flat file: .../session-<uuid>.jsonl or .../session-<uuid>.v4.jsonl.zstd
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
 * Direct disk scanner fallback: finds the session directory across ~/.dsh/sessions/{workspace}/{sessionId}
 */
async function findSessionDirOnDisk(sessionId) {
	const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
	const sessionsDir = join(dshHome, "sessions");
	try {
		const wsDirs = await readdir(sessionsDir);
		for (const ws of wsDirs) {
			const candidate = join(sessionsDir, ws, sessionId);
			try {
				const s = await stat(candidate);
				if (s.isDirectory()) {
					return candidate;
				}
			} catch {}
		}
	} catch {}
	return null;
}

/**
 * Clean projection cache: ~/.dsh/storages/session_projcache/sessions/<sessionId>.json
 */
async function removeProjectionCache(sessionId) {
	const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
	const cacheFile = join(dshHome, "storages", "session_projcache", "sessions", `${sessionId}.json`);
	try {
		await rm(cacheFile, { force: true });
	} catch {}
}

/**
 * Fallback to directly clean workspace.json if workspaceRegistry service is unavailable
 */
async function directWorkspaceJsonCleanup(sessionId) {
	const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
	const wsJsonPath = join(dshHome, "storages", "workspace.json");
	try {
		const raw = await readFile(wsJsonPath, "utf8");
		const data = JSON.parse(raw);
		let changed = false;

		// Clean global archivedSessionIds
		if (Array.isArray(data?.global?.archivedSessionIds) && data.global.archivedSessionIds.includes(sessionId)) {
			data.global.archivedSessionIds = data.global.archivedSessionIds.filter((id) => id !== sessionId);
			changed = true;
		}

		// Clean tables.workspaces.*.sessionIds
		if (data?.tables?.workspaces && typeof data.tables.workspaces === "object") {
			for (const key of Object.keys(data.tables.workspaces)) {
				const ws = data.tables.workspaces[key];
				if (Array.isArray(ws?.sessionIds) && ws.sessionIds.includes(sessionId)) {
					ws.sessionIds = ws.sessionIds.filter((id) => id !== sessionId);
					changed = true;
				}
			}
		}

		if (changed) {
			await writeFile(wsJsonPath, JSON.stringify(data, null, 2), "utf8");
		}
	} catch {}
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

	// 1. Handle in-memory / live session
	const live = sessions?.get?.(sessionId);
	let header = live?.header;
	if (live !== void 0) {
		const agents = ctx.get("agents");
		try {
			agents?.get?.(sessionId)?.cancel?.({ kind: "user" }, { keepInbox: false });
		} catch (error) {
			ctx.logger?.warn?.(`dsh-session-purge: cancel agent failed for ${sessionId}: ${String(error?.message ?? error)}`);
		}

		const entry = sessions.store?.get?.(sessionId);
		if (entry?.detach !== void 0) {
			try {
				entry.detach();
			} catch (error) {
				throw new SessionPurgeError("detach-failed", `无法从内存中安全移除会话：${String(error?.message ?? error)}`);
			}
		}
	}

	// 2. Resolve target directory: Multi-tier strategy
	let targetPath = null;
	let isDirectory = true;

	// Tier A: Try official persistence locator
	if (persistence !== void 0) {
		try {
			if (!header) {
				const headers = await persistence.list?.();
				if (Array.isArray(headers)) {
					const uuid = sessionId.replace(/^session-/, "");
					header = headers.find((item) => {
						const id = String(item.id ?? item.sessionId ?? "");
						return id === sessionId || id === uuid || id.includes(uuid);
					});
				}
			}

			if (header) {
				const location = persistence.locate?.(header);
				if (location && typeof location.path === "string") {
					const resolved = resolveSafePurgeTarget(location.path, sessionId);
					targetPath = resolved.targetPath;
					isDirectory = resolved.isDirectory;
				}
			}
		} catch (err) {
			ctx.logger?.warn?.(`dsh-session-purge: persistence locate failed for ${sessionId}: ${String(err?.message ?? err)}`);
		}
	}

	// Tier B: Direct disk scan fallback (if persistence service didn't find or locate it)
	if (!targetPath) {
		const diskPath = await findSessionDirOnDisk(sessionId);
		if (diskPath) {
			const resolved = resolveSafePurgeTarget(diskPath, sessionId);
			targetPath = resolved.targetPath;
			isDirectory = resolved.isDirectory;
		}
	}

	// 3. Clean projection cache
	await removeProjectionCache(sessionId);

	// 4. Physical removal from disk
	if (targetPath) {
		await rm(targetPath, { recursive: isDirectory, force: true });
		try {
			await access(targetPath);
			throw new SessionPurgeError("delete-failed", `无法彻底删除目标路径 ${targetPath}`, 500);
		} catch (error) {
			if (error instanceof SessionPurgeError) throw error;
			// ENOENT means successfully removed
		}
	}

	// 5. Clean workspace registry accounting
	await removeSessionAccounting(ctx, sessionId);

	// If neither disk path was found nor live, but files might already be gone
	if (!targetPath && !live) {
		// Verify if it really existed
		return { sessionId, path: "cleaned-metadata", purged: true };
	}

	return { sessionId, path: targetPath ?? "purged", purged: true };
}

/**
 * Remove session ID from workspace items and archivedSessionIds state.
 */
async function removeSessionAccounting(ctx, sessionId) {
	let handledByRegistry = false;
	const registry = ctx.get("workspaceRegistry");

	if (registry !== void 0 && typeof registry.enqueueOperation === "function") {
		try {
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
				handledByRegistry = true;
			});
		} catch {}
	}

	// Double-check direct workspace.json cleanup to ensure no orphaned reference remains
	await directWorkspaceJsonCleanup(sessionId);
}
