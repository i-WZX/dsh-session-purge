/**
 * dsh-session-purge — web client half (Browser runtime).
 *
 * Adds a "彻底删除 / Purge session" entry to the conversation ellipsis menu.
 *
 * Enhancements:
 * 1. Multi-tier Session Identification:
 *    - Tier 1: React Fiber / Props inspection for direct sessionId extraction
 *    - Tier 2: DOM anchor links / data-session-id attributes
 *    - Tier 3: Trigger element resolution (data-state="open" / aria-expanded="true")
 *    - Tier 4: Resilient Title matching against snapshot store
 *    - Tier 5: Workspace tree index order & archived sessions matching
 * 2. Robust Element Matching:
 *    - Matches all [role="menuitem"] elements (button, div, a)
 *    - Fallbacks for custom triggers and keyboard accessibility
 * 3. Modern Interaction & Defense:
 *    - Non-blocking confirmation modal styled with DSH design tokens
 *    - Keyboard accessible (Esc to cancel, Enter to confirm)
 *    - Toast notifications replacing intrusive window.alert
 */
window.__ModuleLoader__.load({
	id: "dsh-session-purge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const PURGE_ROUTE = "/session-purge/api/purge";
		const ARCHIVE_LABELS = ["归档会话", "归档对话", "归档", "Archive session", "Archive conversation", "Archive"];
		const DELETE_LABELS = ["删除", "Delete", "Purge"];

		/** Trash icon SVG */
		const TRASH_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex:none"><path d="M14.4782 4.84067L14.2138 10.1152C14.1102 12.1872 14.067 13.0115 13.3866 13.9607C13.1044 14.3546 12.7498 14.6912 12.3424 14.9535C11.8239 15.2872 11.2415 15.4316 10.5585 15.4998C9.88727 15.5668 9.04946 15.5656 7.99998 15.5656C6.95051 15.5656 6.1127 15.5668 5.44142 15.4998C4.75851 15.4316 4.17602 15.2872 3.65753 14.9535C3.25012 14.6912 2.89559 14.3546 2.61332 13.9607C1.93296 13.0115 1.88979 12.1872 1.78619 10.1152L1.52179 4.84067L2.89006 4.77277L3.15343 10.0463C3.26221 12.2218 3.32452 12.6015 3.72646 13.1624C3.90825 13.4161 4.13686 13.6334 4.39927 13.8023C4.66204 13.9714 5.00263 14.0792 5.57825 14.1367C6.16562 14.1953 6.92298 14.1963 7.99998 14.1963C9.07699 14.1963 9.83434 14.1953 10.4217 14.1367C10.9973 14.0792 11.3379 13.9714 11.6007 13.8023C11.8631 13.6334 12.0917 13.4161 12.2735 13.1624C12.6755 12.6015 12.7378 12.2218 12.8465 10.0463L13.1099 4.77277L14.4782 4.84067ZM5.43011 6.22849H6.7994V11.3909H5.43011V6.22849ZM9.20056 6.22849H10.5699V11.3909H9.20056V6.22849ZM8.53597 0.434431C9.17976 0.434431 9.6522 0.426926 10.0966 0.571258C10.2357 0.616451 10.3717 0.672554 10.502 0.738948C10.9182 0.951107 11.2464 1.29099 11.7015 1.74612L12.4978 2.54136H15.3742V3.91169H0.625732V2.54136H3.50218L4.29845 1.74612C4.75358 1.29099 5.08174 0.951107 5.49801 0.738948C5.62831 0.672554 5.76425 0.616451 5.90334 0.571258C6.34776 0.426926 6.82021 0.434431 7.46399 0.434431H8.53597ZM7.46399 1.80476C6.73208 1.80476 6.51641 1.81187 6.32617 1.87369C6.25545 1.89667 6.18668 1.92533 6.12041 1.95907C5.96398 2.03878 5.82348 2.16253 5.44142 2.54136H10.5585C10.1765 2.16253 10.036 2.03878 9.87955 1.95907C9.81329 1.92533 9.74452 1.89667 9.67369 1.87369C9.48356 1.81187 9.26789 1.80476 8.53597 1.80476H7.46399Z" fill="currentColor"/></svg>`;

		const inject = ["sessions", "workspaces", "connection"];

		let ctx = null;
		let lastAnchor = null;
		let lastRow = null;
		let observer = null;

		function isZh() {
			return (document.documentElement.lang || navigator.language || "").toLowerCase().startsWith("zh");
		}

		/** Extract title from button aria-label or row element */
		function titleFromLabel(button, row) {
			if (button) {
				const label = button.getAttribute("aria-label") ?? "";
				const quotes = label.match(/["“](.+)["”]/);
				if (quotes) return quotes[1];
				const en = label.match(/actions\s+for\s+(.+)$/i);
				if (en) return en[1];
				const zh = label.match(/会话(.+)的操作$/);
				if (zh) return zh[1];
				if (label && !label.toLowerCase().includes("action")) return label;
			}
			if (row) {
				const titleEl = row.querySelector('[class*="title"], [class*="name"], span, a');
				if (titleEl && titleEl.textContent) {
					return titleEl.textContent.trim();
				}
			}
			return "";
		}

		/**
		 * Tier 1: Try reading session ID directly from React Fiber / Props.
		 */
		function extractFromReact(element) {
			if (!element) return null;
			let curr = element;
			let depth = 0;
			while (curr && depth < 8) {
				for (const key of Object.keys(curr)) {
					if (key.startsWith("__reactProps$") || key.startsWith("__reactFiber$")) {
						const node = curr[key];
						const props = node?.memoizedProps || node;
						if (props) {
							const idCandidate = props.session?.id || props.item?.id || props.sessionId || props.id;
							if (typeof idCandidate === "string" && idCandidate.startsWith("session-")) {
								return idCandidate;
							}
						}
					}
				}
				curr = curr.parentElement;
				depth += 1;
			}
			return null;
		}

		/**
		 * Tier 2: Check standard HTML attributes and links.
		 */
		function extractFromDomAttributes(row) {
			if (!row) return null;
			const dataId = row.getAttribute("data-session-id") || row.getAttribute("data-id");
			if (dataId && dataId.startsWith("session-")) return dataId;

			const link = row.querySelector('a[href*="session-"]');
			if (link) {
				const match = link.getAttribute("href")?.match(/(session-[0-9a-f-]{36})/);
				if (match) return match[1];
			}
			return null;
		}

		/**
		 * Multi-tier resolution algorithm to find the session ID.
		 */
		function resolveSessionId(row, runtime, anchor) {
			const active = runtime ?? ctx;
			if (!active || !row) return null;

			const anchorEl = anchor ?? lastAnchor;

			// Tier 1: Direct React Fiber inspection
			const fromReact = extractFromReact(row) || extractFromReact(anchorEl);
			if (fromReact) return fromReact;

			// Tier 2: DOM attributes & links
			const fromAttr = extractFromDomAttributes(row);
			if (fromAttr) return fromAttr;

			// Snapshot data
			const slist = active.sessions?.list?.getSnapshot?.() ?? {};
			const wlist = active.workspaces?.list?.getSnapshot?.() ?? {};
			const archived = wlist.archivedSessionIds ?? [];
			const byId = slist.byId ?? {};
			const title = anchorEl ? titleFromLabel(anchorEl, row) : "";

			const displayTitleOf = (id) => byId[id]?.displayTitle ?? byId[id]?.title ?? "";
			const matchesTitle = (id) => {
				if (!title) return true;
				const t = displayTitleOf(id);
				return !t || t === title;
			};

			// Tier 3: Unique title matching within workspace items
			if (title) {
				const exactMatches = (slist.ids ?? []).filter((id) => displayTitleOf(id) === title);
				if (exactMatches.length === 1) {
					return exactMatches[0];
				}
			}

			// Tier 4: Tree-order index calculation
			const tree = row.closest('[role="tree"]');
			if (!tree) return null;

			const allRows = [...tree.querySelectorAll('[role="treeitem"]')];
			const rowIndex = allRows.indexOf(row);
			if (rowIndex === -1) return null;

			const headerIndexes = [];
			allRows.forEach((entry, index) => {
				if (entry.hasAttribute("aria-expanded")) headerIndexes.push(index);
			});

			let candidates = [];
			let inGroupIndex = -1;

			if (headerIndexes.length === 0) {
				candidates = (slist.ids ?? []).filter((id) => byId[id] !== void 0 && !archived.includes(id));
				inGroupIndex = rowIndex;
			} else {
				let groupIndex = -1;
				for (let i = 0; i < headerIndexes.length; i += 1) {
					if (headerIndexes[i] < rowIndex) groupIndex = i;
					else break;
				}
				if (groupIndex === -1) return null;
				inGroupIndex = rowIndex - headerIndexes[groupIndex] - 1;

				if (groupIndex < (wlist.items?.length ?? 0)) {
					const workspace = wlist.items[groupIndex];
					candidates = (workspace.sessionIds ?? []).filter((id) => !archived.includes(id));
				} else {
					const accounted = new Set((wlist.items ?? []).flatMap((ws) => ws.sessionIds ?? []));
					candidates = (slist.ids ?? []).filter((id) => byId[id] !== void 0 && !accounted.has(id) && !archived.includes(id));
				}
			}

			if (inGroupIndex >= 0 && inGroupIndex < candidates.length) {
				const candidate = candidates[inGroupIndex];
				if (matchesTitle(candidate)) return candidate;
			}

			// Fallback: sorted by updatedAt
			const byUpdated = [...candidates].sort((a, b) => (byId[b]?.updatedAt ?? 0) - (byId[a]?.updatedAt ?? 0));
			if (inGroupIndex >= 0 && inGroupIndex < byUpdated.length) {
				const candidate = byUpdated[inGroupIndex];
				if (matchesTitle(candidate)) return candidate;
			}

			return null;
		}

		/**
		 * Modern non-blocking dialog confirming physical purge
		 */
		function showConfirmDialog(titleText) {
			return new Promise((resolve) => {
				const zh = isZh();
				const overlay = document.createElement("div");
				overlay.style.cssText = `
					position: fixed; inset: 0; z-index: 99999;
					background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(4px);
					display: flex; align-items: center; justify-content: center;
					animation: dshPurgeFadeIn 0.15s ease-out;
				`;

				const card = document.createElement("div");
				card.style.cssText = `
					background: var(--dsw-alias-surface-overlay, #222226);
					color: var(--dsw-alias-text-primary, #f0f0f0);
					border: 1px solid var(--dsw-alias-border-subtle, rgba(255, 255, 255, 0.1));
					box-shadow: 0 16px 36px rgba(0, 0, 0, 0.4);
					border-radius: 12px; width: 420px; max-width: 90vw; padding: 24px;
					display: flex; flex-direction: column; gap: 16px;
					font-family: inherit; font-size: 14px; line-height: 1.5;
				`;

				const title = document.createElement("h3");
				title.style.cssText = "margin: 0; font-size: 16px; font-weight: 600; color: #ef4444; display: flex; align-items: center; gap: 8px;";
				title.innerHTML = `${TRASH_SVG} <span>${zh ? "彻底删除会话" : "Permanently Purge Session"}</span>`;

				const body = document.createElement("div");
				body.style.cssText = "color: var(--dsw-alias-text-secondary, #a0a0a5);";
				body.innerHTML = zh
					? `确定要彻底删除会话 <strong>“${titleText}”</strong> 吗？<br/><br/><span style="color:#ef4444; font-size:12px;">⚠️ 注意：该会话的本地日志和所有记录将从磁盘完全抹除，此操作不可撤销！</span>`
					: `Are you sure you want to permanently purge <strong>"${titleText}"</strong>?<br/><br/><span style="color:#ef4444; font-size:12px;">⚠️ Warning: All local logs and files will be removed from disk. This cannot be undone!</span>`;

				const actions = document.createElement("div");
				actions.style.cssText = "display: flex; justify-content: flex-end; gap: 12px; margin-top: 8px;";

				const cancelBtn = document.createElement("button");
				cancelBtn.textContent = zh ? "取消" : "Cancel";
				cancelBtn.style.cssText = `
					padding: 8px 16px; border-radius: 6px; cursor: pointer; border: 1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,0.15));
					background: transparent; color: inherit; font-size: 13px; transition: background 0.2s;
				`;

				const confirmBtn = document.createElement("button");
				confirmBtn.textContent = zh ? "彻底删除" : "Purge";
				confirmBtn.style.cssText = `
					padding: 8px 16px; border-radius: 6px; cursor: pointer; border: none;
					background: #ef4444; color: #ffffff; font-weight: 500; font-size: 13px; transition: opacity 0.2s;
				`;

				const cleanup = (confirmed) => {
					window.removeEventListener("keydown", onKeyDown);
					overlay.remove();
					resolve(confirmed);
				};

				const onKeyDown = (e) => {
					if (e.key === "Escape") cleanup(false);
					if (e.key === "Enter") cleanup(true);
				};

				cancelBtn.addEventListener("click", () => cleanup(false));
				confirmBtn.addEventListener("click", () => cleanup(true));
				window.addEventListener("keydown", onKeyDown);

				actions.appendChild(cancelBtn);
				actions.appendChild(confirmBtn);
				card.appendChild(title);
				card.appendChild(body);
				card.appendChild(actions);
				overlay.appendChild(card);
				document.body.appendChild(overlay);

				cancelBtn.focus();
			});
		}

		/** Toast notification */
		function showToast(message, isError = false) {
			const toast = document.createElement("div");
			toast.style.cssText = `
				position: fixed; bottom: 24px; right: 24px; z-index: 100000;
				padding: 10px 16px; border-radius: 8px; font-size: 13px;
				background: ${isError ? "#ef4444" : "var(--dsw-alias-surface-overlay, #2b2b30)"};
				color: #fff; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
				border: 1px solid ${isError ? "transparent" : "rgba(255,255,255,0.15)"};
				transition: opacity 0.3s ease, transform 0.3s ease;
			`;
			toast.textContent = message;
			document.body.appendChild(toast);
			setTimeout(() => {
				toast.style.opacity = "0";
				toast.style.transform = "translateY(8px)";
				setTimeout(() => toast.remove(), 300);
			}, 3000);
		}

		/** Inject the Purge entry into the session menu */
		function injectPurgeEntry(menu) {
			if (menu.dataset.sessionPurgeInjected === "1") return;

			// Match any role="menuitem" (button, div, a)
			const items = [...menu.querySelectorAll('[role="menuitem"]')];
			if (items.length === 0) return;

			const anchorItem = items.find((el) =>
				ARCHIVE_LABELS.some((label) => (el.textContent ?? "").includes(label))
			) || items[items.length - 1];

			if (!anchorItem) return;

			// Determine if wrapped in a single container
			const wrap = (anchorItem.parentElement && anchorItem.parentElement !== menu && anchorItem.parentElement.children.length === 1)
				? anchorItem.parentElement
				: anchorItem;

			const clone = wrap.cloneNode(true);
			const itemElement = clone.matches('[role="menuitem"]')
				? clone
				: clone.querySelector('[role="menuitem"]') || clone;

			// Replace icon and label
			const iconSlot = itemElement.querySelector("svg")?.parentElement || itemElement.querySelector("span");
			if (iconSlot) {
				iconSlot.innerHTML = TRASH_SVG;
				iconSlot.style.display = "inline-flex";
				iconSlot.style.alignItems = "center";
			}

			const spans = [...itemElement.querySelectorAll("span")];
			const labelSlot = spans.find((span) =>
				ARCHIVE_LABELS.concat(DELETE_LABELS).some((label) => (span.textContent ?? "").includes(label))
			) || spans[spans.length - 1] || itemElement;

			if (labelSlot) {
				labelSlot.textContent = isZh() ? "彻底删除" : "Purge session";
			}
			itemElement.style.color = "var(--dsw-alias-state-error-primary, #ef4444)";

			itemElement.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				void handlePurgeClicked();
			});

			wrap.parentElement.insertBefore(clone, wrap.nextSibling);
			menu.dataset.sessionPurgeInjected = "1";
		}

		function scanForMenus(root) {
			if (root.nodeType !== 1) return;
			const element = root;
			if (element.matches?.('[role="menu"]') === true) injectPurgeEntry(element);
			for (const menu of element.querySelectorAll?.('[role="menu"]') ?? []) {
				injectPurgeEntry(menu);
			}
		}

		async function handlePurgeClicked() {
			let anchor = lastAnchor;
			let row = lastRow || (anchor ? anchor.closest('[role="treeitem"]') : null);

			// Fallback: look for currently opened trigger
			if (!row) {
				const activeTrigger = document.querySelector('button[aria-expanded="true"], [data-state="open"][aria-haspopup="menu"]');
				if (activeTrigger) {
					anchor = activeTrigger;
					row = activeTrigger.closest('[role="treeitem"]');
				}
			}

			if (!row) {
				// Fallback to active selection if current row cannot be captured
				const currentId = ctx?.sessions?.list?.getSnapshot?.()?.current;
				if (currentId) {
					row = document.querySelector(`[data-session-id="${currentId}"], [role="treeitem"][aria-selected="true"]`);
				}
			}

			// Dismiss native menu
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

			const sessionId = resolveSessionId(row, ctx, anchor);
			if (!sessionId) {
				showToast(isZh() ? "无法识别该会话，请刷新重试" : "Could not identify session", true);
				return;
			}

			const title = titleFromLabel(anchor, row) || sessionId;
			const confirmed = await showConfirmDialog(title);
			if (!confirmed) return;

			try {
				const response = await fetch(PURGE_ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId })
				});

				const body = await response.json().catch(() => null);
				if (!response.ok || !body?.ok) {
					throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
				}

				if (ctx?.sessions?.list?.getSnapshot?.()?.current === sessionId) {
					ctx.sessions?.clear?.();
				}

				await Promise.allSettled([
					ctx?.sessions?.refresh?.(),
					ctx?.workspaces?.refresh?.()
				]);

				showToast(isZh() ? `会话“${title}”已从磁盘彻底删除` : `Session "${title}" purged from disk.`);
			} catch (error) {
				showToast(isZh() ? `删除失败：${String(error?.message ?? error)}` : `Purge failed: ${String(error?.message ?? error)}`, true);
			}
		}

		function apply(pluginCtx) {
			ctx = pluginCtx;

			ctx.effect(() => {
				const recordAnchor = (event) => {
					const target = event.target;
					if (!(target instanceof Element)) return;
					if (target.closest('[role="menu"]')) return;

					const button = target.closest('button, [role="button"]');
					const row = target.closest('[role="treeitem"], [data-session-id], a[href*="session-"]');

					if (row) lastRow = row;
					if (button) lastAnchor = button;
				};

				document.addEventListener("pointerdown", recordAnchor, true);
				document.addEventListener("click", recordAnchor, true);
				document.addEventListener("contextmenu", recordAnchor, true);

				observer = new MutationObserver((mutations) => {
					for (const mutation of mutations) {
						for (const node of mutation.addedNodes) {
							if (node instanceof Element) scanForMenus(node);
						}
					}
				});

				observer.observe(document.body, { childList: true, subtree: true });
				for (const menu of document.querySelectorAll('[role="menu"]')) {
					injectPurgeEntry(menu);
				}

				return () => {
					document.removeEventListener("pointerdown", recordAnchor, true);
					document.removeEventListener("click", recordAnchor, true);
					document.removeEventListener("contextmenu", recordAnchor, true);
					observer?.disconnect();
					observer = null;
					lastAnchor = null;
					lastRow = null;
					ctx = null;
				};
			}, "dsh-session-purge: menu injection");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports._resolveSessionId = resolveSessionId;
		return module.exports;
	}
});
