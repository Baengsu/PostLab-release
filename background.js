/**
 * Server Time Sync — 경량 백그라운드
 * Sync / 예약 Rec / Auto Click + 오픈예정 교체. OCR/CDP/Network 없음.
 */

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function progressLog(text, level = "info", source = "bg") {
  broadcast({ type: "PROGRESS_LOG", text, level, source, at: Date.now() });
}

function pad2(n, width = 2) {
  return String(n).padStart(width, "0");
}

function formatServerClock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${pad2(
    d.getMilliseconds(),
    3
  )}`;
}

// —— Side panel on action click ——
function enableChromeSidePanelOnAction() {
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  } catch {
    /* ignore */
  }
}
chrome.runtime.onInstalled.addListener(() => enableChromeSidePanelOnAction());
chrome.runtime.onStartup.addListener(() => enableChromeSidePanelOnAction());
enableChromeSidePanelOnAction();

// —— Server time probe ——
async function probeServerTime(url, signal) {
  const t0 = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method: "HEAD",
      cache: "no-store",
      redirect: "follow",
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      signal,
    });
  }
  const t1 = Date.now();
  const dateHeader = response.headers.get("Date");
  if (!dateHeader) throw new Error("응답에 Date 헤더가 없습니다.");
  const serverMs = Date.parse(dateHeader);
  if (Number.isNaN(serverMs)) throw new Error("Date 헤더를 해석할 수 없습니다.");
  const rtt = Math.max(0, t1 - t0);
  const offsetMs = serverMs + rtt / 2 - t1;
  return {
    ok: true,
    offsetMs,
    rttMs: Math.round(rtt),
    serverDate: dateHeader,
    status: response.status,
  };
}

async function fetchServerTime(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    let best = null;
    let lastError = null;
    for (let i = 0; i < 3; i += 1) {
      try {
        const sample = await probeServerTime(url, controller.signal);
        if (!best || sample.rttMs < best.rttMs) best = sample;
      } catch (error) {
        lastError = error;
      }
    }
    if (!best) throw lastError || new Error("서버 시간을 가져오지 못했습니다.");
    return best;
  } finally {
    clearTimeout(timeoutId);
  }
}

// —— Sync + Sched engine ——
const STS_SYNC_ALARM = "sts-server-sync";
const STS_SCHED_ALARM = "sts-sched-fire";
const STS_SCHED_PREP_ALARM = "sts-sched-prep";
const STS_SYNC_STORAGE = "stsServerSync";
const STS_SCHED_STORAGE = "stsSchedRec";

let stsSync = {
  running: false,
  url: "",
  offsetMs: null,
  rttMs: null,
  serverDate: "",
  lastOkAt: 0,
};

let stsSched = {
  armed: false,
  targetMs: null,
  site: "www",
  parts: null,
  recPayload: null,
  firing: false,
};

let stsSyncLoopTimer = null;
let stsSchedWatchTimer = null;

function serverNowMs() {
  if (stsSync.offsetMs == null) return null;
  return Date.now() + stsSync.offsetMs;
}

function broadcastSyncState(extra = {}) {
  broadcast({
    type: "SERVER_SYNC_STATE",
    running: stsSync.running,
    url: stsSync.url,
    offsetMs: stsSync.offsetMs,
    rttMs: stsSync.rttMs,
    serverDate: stsSync.serverDate,
    serverNowMs: serverNowMs(),
    ...extra,
  });
}

function broadcastSchedState(extra = {}) {
  broadcast({
    type: "SCHED_REC_STATE",
    armed: stsSched.armed,
    targetMs: stsSched.targetMs,
    site: stsSched.site,
    parts: stsSched.parts,
    ...extra,
  });
  updateActionBadge();
}

function updateActionBadge() {
  try {
    if (stsSched.armed) {
      chrome.action.setBadgeText({ text: "ARM" });
      chrome.action.setBadgeBackgroundColor({ color: "#0d9488" });
    } else if (stsSync.running) {
      chrome.action.setBadgeText({ text: "SYNC" });
      chrome.action.setBadgeBackgroundColor({ color: "#334155" });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
  } catch {
    /* ignore */
  }
}

async function persistSyncState() {
  await chrome.storage.local.set({
    [STS_SYNC_STORAGE]: {
      running: stsSync.running,
      url: stsSync.url,
      offsetMs: stsSync.offsetMs,
      rttMs: stsSync.rttMs,
      serverDate: stsSync.serverDate,
      lastOkAt: stsSync.lastOkAt,
    },
  });
}

async function persistSchedState() {
  await chrome.storage.local.set({
    [STS_SCHED_STORAGE]: {
      armed: stsSched.armed,
      targetMs: stsSched.targetMs,
      site: stsSched.site,
      parts: stsSched.parts,
      recPayload: stsSched.recPayload,
    },
  });
}

async function refreshServerOffset() {
  if (!stsSync.url) throw new Error("Sync URL이 없습니다.");
  const result = await fetchServerTime(stsSync.url);
  if (!result?.ok) throw new Error(result?.error || "서버 시간 동기화 실패");
  stsSync.offsetMs = result.offsetMs;
  stsSync.rttMs = result.rttMs;
  stsSync.serverDate = result.serverDate;
  stsSync.lastOkAt = Date.now();
  await persistSyncState();
  broadcastSyncState({ ok: true });
  return result;
}

function clearStsSyncLoop() {
  if (stsSyncLoopTimer != null) {
    clearInterval(stsSyncLoopTimer);
    stsSyncLoopTimer = null;
  }
}

function clearStsSchedWatch() {
  if (stsSchedWatchTimer != null) {
    clearInterval(stsSchedWatchTimer);
    stsSchedWatchTimer = null;
  }
}

async function ensureSyncAlarms() {
  await chrome.alarms.clear(STS_SYNC_ALARM);
  if (!stsSync.running) return;
  await chrome.alarms.create(STS_SYNC_ALARM, { periodInMinutes: 1 });
}

function startStsSyncLoop() {
  clearStsSyncLoop();
  stsSyncLoopTimer = setInterval(() => {
    if (!stsSync.running) return;
    refreshServerOffset().catch((err) => {
      progressLog(`Sync 실패: ${err.message}`, "error", "sync");
      broadcastSyncState({ ok: false, error: err.message });
    });
  }, 1000);
}

async function startServerSync(url) {
  const trimmed = String(url || "").trim();
  if (!trimmed) throw new Error("URL을 입력해주세요.");
  stsSync.running = true;
  stsSync.url = trimmed;
  await chrome.storage.local.set({ serverTimeUrl: trimmed });
  await persistSyncState();
  const result = await refreshServerOffset();
  startStsSyncLoop();
  await ensureSyncAlarms();
  updateActionBadge();
  progressLog(`서버 시간 맞춤을 시작했습니다 (응답속도 ${result.rttMs}ms)`, "ok", "sync");
  return result;
}

async function stopServerSync({ keepOffset = true } = {}) {
  stsSync.running = false;
  clearStsSyncLoop();
  await chrome.alarms.clear(STS_SYNC_ALARM);
  if (!keepOffset) {
    stsSync.offsetMs = null;
    stsSync.rttMs = null;
    stsSync.serverDate = "";
  }
  await persistSyncState();
  broadcastSyncState({ stopped: true });
  updateActionBadge();
  progressLog("서버 시간 맞춤을 멈췄습니다", "info", "sync");
  if (stsSched.armed) {
    progressLog("시간은 멈췄지만 예약은 그대로입니다", "warn", "sched");
  }
}

function computeSchedTargetMs(parts, serverNow) {
  const d = new Date(serverNow);
  d.setHours(parts.hh, parts.mm, parts.ss, parts.ms);
  return d.getTime();
}

async function clearSchedAlarms() {
  await chrome.alarms.clear(STS_SCHED_ALARM);
  await chrome.alarms.clear(STS_SCHED_PREP_ALARM);
}

function startSchedWatchLoop() {
  clearStsSchedWatch();
  stsSchedWatchTimer = setInterval(() => {
    void checkAndFireSchedRec();
  }, 50);
}

async function armSchedRec({ parts, site, recPayload }) {
  if (stsSync.offsetMs == null) throw new Error("먼저 Sync 하세요");
  const p = {
    hh: Math.min(23, Math.max(0, Math.trunc(Number(parts?.hh) || 0))),
    mm: Math.min(59, Math.max(0, Math.trunc(Number(parts?.mm) || 0))),
    ss: Math.min(59, Math.max(0, Math.trunc(Number(parts?.ss) || 0))),
    ms: Math.min(999, Math.max(0, Math.trunc(Number(parts?.ms) || 0))),
  };
  const now = serverNowMs();
  const target = computeSchedTargetMs(p, now);
  if (target <= now) {
    throw new Error(
      `이미 지난 시각 (${pad2(p.hh)}:${pad2(p.mm)}:${pad2(p.ss)}.${pad2(p.ms, 3)})`
    );
  }

  stsSched.armed = true;
  stsSched.targetMs = target;
  stsSched.site = site === "facility" ? "facility" : "www";
  stsSched.parts = p;
  stsSched.recPayload = recPayload || null;
  stsSched.firing = false;
  await persistSchedState();
  await clearSchedAlarms();

  const waitMs = Math.max(0, target - now);
  await chrome.alarms.create(STS_SCHED_ALARM, {
    when: Date.now() + Math.max(0, waitMs - 5),
  });
  if (waitMs > 9000) {
    await chrome.alarms.create(STS_SCHED_PREP_ALARM, {
      when: Date.now() + Math.max(0, waitMs - 8000),
    });
  } else {
    startSchedWatchLoop();
  }

  if (!stsSync.running && stsSync.url) {
    await startServerSync(stsSync.url);
  }

  broadcastSchedState();
  const label = `${pad2(p.hh)}:${pad2(p.mm)}:${pad2(p.ss)}.${pad2(p.ms, 3)}`;
  const siteLabel = stsSched.site === "facility" ? "구단" : "기본";
  progressLog(`예약이 설정되었습니다 · ${label} · ${siteLabel}`, "ok", "sched");
  return { ok: true, targetMs: target, waitMs, label, site: stsSched.site };
}

async function disarmSchedRec({ silent = false } = {}) {
  stsSched.armed = false;
  stsSched.targetMs = null;
  stsSched.firing = false;
  clearStsSchedWatch();
  await clearSchedAlarms();
  await persistSchedState();
  broadcastSchedState({ disarmed: true });
  if (!silent) progressLog("예약 해제(BG)", "info", "sched");
}

async function resolveSchedRecPayload(site) {
  if (stsSched.recPayload && typeof stsSched.recPayload === "object") {
    return { ...stsSched.recPayload, site, type: "START_AUTO_REC" };
  }
  const data = await chrome.storage.local.get(["autoRecConfig", "facilityAutoRecConfig"]);
  const c =
    site === "facility" ? data.facilityAutoRecConfig || {} : data.autoRecConfig || {};
  return {
    type: "START_AUTO_REC",
    site: site === "facility" ? "facility" : "www",
    url: String(c.url || "").trim(),
    index: String(c.index || "1"),
    text: String(c.text || "예매하기").trim(),
    midSelector: String(c.midSelector || "div.modal_notice").trim(),
    mSelector: String(
      c.mSelector ||
        (site === "facility" ? "button#noticeModalClose" : "button.common_modal_close")
    ).trim(),
    mText: String(c.mText || (site === "facility" ? "" : "확인")).trim(),
    delayMs: Math.max(0, Number(c.delayMs) || 0),
  };
}

async function startAutoRecInternal(payload) {
  const site = String(payload.site || "www").trim() === "facility" ? "facility" : "www";
  const config = {
    site,
    url: String(payload.url || "").trim(),
    index: String(payload.index || "1"),
    text: String(payload.text || "").trim(),
    midSelector: String(payload.midSelector || "").trim(),
    mSelector: String(payload.mSelector || "").trim(),
    mText: String(payload.mText || "").trim(),
    delayMs: Math.max(0, Number(payload.delayMs) || 0),
  };

  if (site === "facility") {
    await chrome.storage.local.set({
      facilityAutoRecArmed: true,
      facilityAutoRecConfig: config,
    });
  } else {
    await chrome.storage.local.set({
      autoRecArmed: true,
      autoRecConfig: config,
    });
  }

  progressLog(
    `자동 클릭 시작 — ${site === "facility" ? "구단" : "기본"} (순서 ${config.index})`,
    "ok",
    "auto"
  );

  let tab = null;
  const ticketTabs = await chrome.tabs.query({
    url: [
      "*://www.ticketlink.co.kr/*",
      "*://facility.ticketlink.co.kr/*",
      "*://*.ticketlink.co.kr/*",
    ],
  });
  if (ticketTabs.length) {
    tab =
      ticketTabs.find((t) => t.active) ||
      ticketTabs.find((t) =>
        site === "facility"
          ? /facility\.ticketlink/i.test(t.url || "")
          : /www\.ticketlink/i.test(t.url || "")
      ) ||
      ticketTabs[0];
  }
  if (!tab?.id) {
    const active = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = active[0];
  }
  if (!tab?.id) throw new Error("티켓링크 탭을 찾을 수 없습니다.");

  if (config.url && config.url.startsWith("http")) {
    const hostHint = config.url.replace(/^https?:\/\//, "").slice(0, 40);
    if (tab.url && !String(tab.url).includes(hostHint)) {
      progressLog(`URL 이동: ${config.url}`, "warn", "auto");
      await chrome.tabs.update(tab.id, { url: config.url });
    } else {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "AUTO_REC_RESTART" });
      } catch {
        progressLog("content 미연결 — 로드 후 감시 시작", "warn", "auto");
      }
    }
  } else {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "AUTO_REC_RESTART" });
    } catch {
      progressLog("content 미연결 — 로드 후 감시 시작", "warn", "auto");
    }
  }

  broadcast({ type: "AUTO_REC_STATE", armed: true, site, config });
  return { ok: true, armed: true, site, tabId: tab.id };
}

async function stopAutoRecInternal(site) {
  const s = site === "facility" ? "facility" : "www";
  if (s === "facility") {
    await chrome.storage.local.set({ facilityAutoRecArmed: false });
  } else {
    await chrome.storage.local.set({ autoRecArmed: false });
  }
  progressLog(`자동 클릭 중지 — ${s === "facility" ? "구단" : "기본"}`, "info", "auto");
  broadcast({ type: "AUTO_REC_STATE", armed: false, site: s });
  return { ok: true, armed: false, site: s };
}

const NOL_TAB_URLS = [
  "*://ticket.interpark.com/*",
  "*://tickets.interpark.com/*",
  "*://nol.interpark.com/*",
  "*://*.interpark.com/*",
];

async function armNolInternal(payload) {
  if (stsSync.offsetMs == null) throw new Error("먼저 상단 Sync 하세요");

  const targetString = String(payload.targetString || "").trim();
  if (!targetString) throw new Error("오픈 시각을 선택하세요");

  const normalized = targetString.includes("T")
    ? targetString
    : targetString.replace(" ", "T");
  const targetMs = new Date(normalized).getTime();
  if (!Number.isFinite(targetMs)) {
    throw new Error("시각 형식 오류");
  }

  const now = serverNowMs();
  if (now == null) throw new Error("먼저 상단 Sync 하세요");
  if (targetMs <= now) {
    throw new Error(`이미 지난 시각 (서버 기준) — ${targetString}`);
  }

  const config = {
    targetString,
    targetMs,
    warmupMs: Math.max(0, Number(payload.warmupMs) || 2000),
    selector: String(payload.selector || "div.buttons > button").trim() || "div.buttons > button",
    disabledClass: String(
      payload.disabledClass != null ? payload.disabledClass : "_disabled_2p3w6_34"
    ).trim(),
  };

  await chrome.storage.local.set({ nolArmed: true, nolConfig: config });

  if (!stsSync.running && stsSync.url) {
    try {
      await startServerSync(stsSync.url);
    } catch {
      /* offset already present — keep arming */
    }
  }

  const waitSec = ((targetMs - now) / 1000).toFixed(1);
  progressLog(
    `[NOL] 예약 ON — ${config.targetString} (서버 · ${waitSec}s · 워밍업 ${config.warmupMs}ms)`,
    "ok",
    "nol"
  );

  const tabs = await chrome.tabs.query({ url: NOL_TAB_URLS });
  for (const tab of tabs) {
    if (tab.id == null) continue;
    chrome.tabs.sendMessage(tab.id, { type: "NOL_RESTART" }).catch(() => {});
  }

  broadcast({ type: "NOL_STATE", armed: true, config });
  return { ok: true, armed: true, config, tabCount: tabs.length, waitMs: targetMs - now };
}

async function disarmNolInternal() {
  await chrome.storage.local.set({ nolArmed: false });
  progressLog("[NOL] 예약 OFF", "info", "nol");
  broadcast({ type: "NOL_STATE", armed: false });
  return { ok: true, armed: false };
}

async function fireSchedRec() {
  if (!stsSched.armed || stsSched.firing) return;
  stsSched.firing = true;
  const site = stsSched.site === "facility" ? "facility" : "www";
  const label =
    stsSched.targetMs != null ? formatServerClock(stsSched.targetMs).replace(" ", ".") : "?";

  try {
    if (stsSync.url) {
      try {
        await refreshServerOffset();
      } catch {
        /* keep offset */
      }
    }
    const data = await chrome.storage.local.get(["autoRecArmed", "facilityAutoRecArmed"]);
    const already =
      site === "facility" ? Boolean(data.facilityAutoRecArmed) : Boolean(data.autoRecArmed);
    if (already) {
      progressLog(`이미 Rec ON — 예약 발화 스킵`, "warn", "sched");
    } else {
      const payload = await resolveSchedRecPayload(site);
      await startAutoRecInternal(payload);
      progressLog(`예약 시각 도달 → Rec 시작 (${label})`, "ok", "sched");
    }
  } catch (err) {
    progressLog(`예약 Rec 실패: ${err.message}`, "error", "sched");
  } finally {
    stsSched.armed = false;
    stsSched.targetMs = null;
    stsSched.firing = false;
    clearStsSchedWatch();
    await clearSchedAlarms();
    await persistSchedState();
    broadcastSchedState({ fired: true, label });
  }
}

async function checkAndFireSchedRec() {
  if (!stsSched.armed || stsSched.targetMs == null || stsSched.firing) return;
  const now = serverNowMs();
  if (now == null) return;
  if (stsSched.targetMs - now <= 8000) startSchedWatchLoop();
  if (now >= stsSched.targetMs) await fireSchedRec();
}

async function restoreStsEngineFromStorage() {
  const data = await chrome.storage.local.get([STS_SYNC_STORAGE, STS_SCHED_STORAGE, "serverTimeUrl"]);
  const sync = data[STS_SYNC_STORAGE];
  if (sync?.url) stsSync.url = String(sync.url);
  else if (data.serverTimeUrl) stsSync.url = String(data.serverTimeUrl);
  if (sync?.offsetMs != null) stsSync.offsetMs = Number(sync.offsetMs);
  if (sync?.rttMs != null) stsSync.rttMs = Number(sync.rttMs);
  if (sync?.serverDate) stsSync.serverDate = String(sync.serverDate);

  // Sync는 사용자가 Sync 버튼을 누를 때만 시작 — 재시작/패널 오픈 시 자동 재개 금지
  stsSync.running = false;
  clearStsSyncLoop();
  await chrome.alarms.clear(STS_SYNC_ALARM);
  await persistSyncState();

  const sched = data[STS_SCHED_STORAGE];
  if (sched?.armed && sched?.targetMs != null) {
    stsSched.armed = true;
    stsSched.targetMs = Number(sched.targetMs);
    stsSched.site = sched.site === "facility" ? "facility" : "www";
    stsSched.parts = sched.parts || null;
    stsSched.recPayload = sched.recPayload || null;
    const now = serverNowMs() ?? Date.now();
    if (stsSched.targetMs <= now) {
      await fireSchedRec();
    } else {
      const waitMs = stsSched.targetMs - now;
      await clearSchedAlarms();
      await chrome.alarms.create(STS_SCHED_ALARM, {
        when: Date.now() + Math.max(0, waitMs - 5),
      });
      if (waitMs > 9000) {
        await chrome.alarms.create(STS_SCHED_PREP_ALARM, {
          when: Date.now() + Math.max(0, waitMs - 8000),
        });
      } else {
        startSchedWatchLoop();
      }
      broadcastSchedState({ restored: true });
      progressLog("예약 복구됨 (BG) — Sync는 버튼으로 다시 켜세요", "ok", "sched");
    }
  }
  updateActionBadge();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === STS_SYNC_ALARM) {
    if (!stsSync.running) return;
    refreshServerOffset().catch((err) => {
      progressLog(`Sync(alarm) 실패: ${err.message}`, "error", "sync");
    });
    if (stsSync.running && stsSyncLoopTimer == null) startStsSyncLoop();
    return;
  }
  if (alarm.name === STS_SCHED_PREP_ALARM) {
    progressLog("예약 임박 — 정밀 감시", "warn", "sched");
    if (stsSync.running && stsSync.url) refreshServerOffset().catch(() => {});
    startSchedWatchLoop();
    void checkAndFireSchedRec();
    return;
  }
  if (alarm.name === STS_SCHED_ALARM) {
    startSchedWatchLoop();
    void checkAndFireSchedRec();
  }
});

void restoreStsEngineFromStorage();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "PROGRESS_LOG") {
    broadcast(message);
    return false;
  }

  if (message?.type === "START_SERVER_SYNC") {
    startServerSync(message.url)
      .then((result) => sendResponse({ ok: true, ...result, running: true }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error.name === "AbortError" ? "요청 시간 초과" : error.message,
        })
      );
    return true;
  }

  if (message?.type === "STOP_SERVER_SYNC") {
    stopServerSync({ keepOffset: message.keepOffset !== false })
      .then(() => sendResponse({ ok: true, running: false, offsetMs: stsSync.offsetMs }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_SERVER_SYNC_STATE") {
    sendResponse({
      ok: true,
      running: stsSync.running,
      url: stsSync.url,
      offsetMs: stsSync.offsetMs,
      rttMs: stsSync.rttMs,
      serverDate: stsSync.serverDate,
      serverNowMs: serverNowMs(),
    });
    return false;
  }

  if (message?.type === "ARM_SCHED_REC") {
    armSchedRec({
      parts: message.parts,
      site: message.site,
      recPayload: message.recPayload,
    })
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "DISARM_SCHED_REC") {
    disarmSchedRec()
      .then(() => sendResponse({ ok: true, armed: false }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_SCHED_REC_STATE") {
    sendResponse({
      ok: true,
      armed: stsSched.armed,
      targetMs: stsSched.targetMs,
      site: stsSched.site,
      parts: stsSched.parts,
      serverNowMs: serverNowMs(),
    });
    return false;
  }

  if (message?.type === "START_AUTO_REC") {
    startAutoRecInternal(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "STOP_AUTO_REC") {
    stopAutoRecInternal(message.site)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_AUTO_REC_STATE") {
    chrome.storage.local
      .get(["autoRecArmed", "autoRecConfig", "facilityAutoRecArmed", "facilityAutoRecConfig"])
      .then((data) => {
        sendResponse({
          ok: true,
          www: { armed: Boolean(data.autoRecArmed), config: data.autoRecConfig || null },
          facility: {
            armed: Boolean(data.facilityAutoRecArmed),
            config: data.facilityAutoRecConfig || null,
          },
          armed: Boolean(data.autoRecArmed),
          config: data.autoRecConfig || null,
        });
      });
    return true;
  }

  if (message?.type === "AUTO_REC_RESULT") {
    const site = message.site === "facility" ? "facility" : "www";
    if (message.ok) {
      progressLog(
        `${site === "facility" ? "구단" : "기본"} 자동 클릭에 성공했습니다`,
        "ok",
        "auto"
      );
    } else {
      progressLog(message.error || "자동 클릭에 실패했습니다", "error", "auto");
    }
    return false;
  }


  // ==========================================
  // 오픈예정 → 예매하기 (MAIN / facility nav)
  // ==========================================
  if (message?.type === "EXP_INSTALL_FACILITY_NAV_REWRITE") {
    (async () => {
      try {
        let tabId = sender.tab?.id;
        if (tabId == null) {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          tabId = tabs[0]?.id;
        }
        if (tabId == null) throw new Error("tab missing — ticketlink 탭을 활성화하세요");
        const sid = String(message.scheduleId || "").trim();
        const pid = String(message.productId || "").trim();
        const rowIndex = Number(message.rowIndex) || 0;
        if (!sid || !pid) throw new Error("scheduleId/productId 필요");
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          args: [sid, pid, rowIndex],
          func: (scheduleId, productId, rowIndex) => {
            const sid = String(scheduleId);
            const pid = String(productId);
            const rowIdx = Math.max(0, (Number(rowIndex) || 1) - 1);
            const sidNum = Number(sid);
            const pidNum = Number(pid);
            let hits = 0;
            const seen = new Set();

            const patchItem = (item) => {
              if (!item || typeof item !== "object") return;
              try {
                if ("scheduleId" in item) {
                  item.scheduleId = Number.isFinite(sidNum) ? sidNum : sid;
                  hits += 1;
                }
                if ("schedule_id" in item) {
                  item.schedule_id = Number.isFinite(sidNum) ? sidNum : sid;
                  hits += 1;
                }
                if ("productId" in item) {
                  item.productId = Number.isFinite(pidNum) ? pidNum : pid;
                  hits += 1;
                }
                if ("product_id" in item) {
                  item.product_id = Number.isFinite(pidNum) ? pidNum : pid;
                  hits += 1;
                }
              } catch {
                /* ignore */
              }
            };
            const tryArr = (arr) => {
              if (!Array.isArray(arr) || arr.length <= rowIdx) return;
              if (!arr[rowIdx] || typeof arr[rowIdx] !== "object") return;
              if (!("scheduleId" in arr[rowIdx] || "schedule_id" in arr[rowIdx])) return;
              patchItem(arr[rowIdx]);
            };
            const looks = (arr) => {
              if (!Array.isArray(arr) || !arr.length) return false;
              const first = arr.find((x) => x && typeof x === "object");
              return Boolean(first && ("scheduleId" in first || "schedule_id" in first));
            };
            const visit = (node, depth) => {
              if (node == null || depth > 8 || typeof node !== "object" || seen.has(node)) return;
              seen.add(node);
              if (looks(node)) {
                tryArr(node);
                return;
              }
              if (Array.isArray(node)) {
                for (let i = 0; i < Math.min(node.length, 40); i += 1) visit(node[i], depth + 1);
                return;
              }
              let keys = [];
              try {
                keys = Object.keys(node);
              } catch {
                return;
              }
              for (const key of keys) {
                try {
                  const low = String(key).toLowerCase();
                  if (
                    low.includes("schedule") ||
                    low.includes("game") ||
                    low === "data" ||
                    low === "list" ||
                    low === "state" ||
                    low === "store"
                  ) {
                    visit(node[key], depth + 1);
                  }
                } catch {
                  /* ignore */
                }
                if (hits > 0 && depth > 3) return;
              }
              if (depth <= 1) {
                for (const key of keys.slice(0, 80)) {
                  try {
                    visit(node[key], depth + 1);
                  } catch {
                    /* ignore */
                  }
                  if (hits > 0) return;
                }
              }
            };
            // window 전체 순회는 페이지를 멈춤 → 금지. 훅이 잡아둔 ref 만 사용.
            try {
              if (Array.isArray(window.__stsSchedulesRef)) {
                tryArr(window.__stsSchedulesRef);
              }
            } catch {
              /* ignore */
            }

            const stamp = (el) => {
              if (!el) return;
              try {
                el.setAttribute("data-schedule-id", sid);
                el.setAttribute("data-scheduleId", sid);
                el.setAttribute("data-product-id", pid);
                el.setAttribute("data-productId", pid);
                if (el.dataset) {
                  el.dataset.scheduleId = sid;
                  el.dataset.productId = pid;
                }
                const $ = window.jQuery || window.$;
                if ($ && typeof $.fn?.data === "function") {
                  $(el).data("scheduleId", sid);
                  $(el).data("productId", pid);
                }
              } catch {
                /* ignore */
              }
            };
            const forced = document.querySelector(
              "#scheduleListDiv a.__sts_exp_forced_active, a.__sts_exp_forced_active"
            );
            stamp(forced);
            stamp(forced?.closest("tr"));

            try {
              window.__stsClearFacilityNavRewrite?.();
            } catch {
              /* ignore */
            }
            window.__stsFacilityPatch = { sid, pid, rowIndex: rowIdx + 1, hits };
            return { ok: true, hits, sid, pid, rowIndex: rowIdx + 1 };
          },
        });
        sendResponse(result?.result || { ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }

  if (message?.type === "EXP_CLEAR_FACILITY_NAV_REWRITE") {
    (async () => {
      try {
        let tabId = sender.tab?.id;
        if (tabId == null) {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          tabId = tabs[0]?.id;
        }
        if (tabId == null) throw new Error("tab missing — ticketlink 탭을 활성화하세요");
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: () => {
            try {
              window.__stsClearFacilityNavRewrite?.();
            } catch {
              /* ignore */
            }
            try {
              delete window.__stsFacilityPatch;
            } catch {
              /* ignore */
            }
            return { ok: true };
          },
        });
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }

  /** 페이지 MAIN world 에서 예매 진입 함수/핸들러 호출 (fiber·V 는 isolated 에서 안 잡힘) */
  if (message?.type === "EXP_INVOKE_RESERVE_MAIN") {
    (async () => {
      try {
        let tabId = sender.tab?.id;
        if (tabId == null) {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          tabId = tabs[0]?.id;
        }
        if (tabId == null) throw new Error("tab missing — ticketlink 탭을 활성화하세요");
        const sid = String(message.scheduleId || "").trim();
        const pid = String(message.productId || "").trim();
        if (!sid || !pid) throw new Error("scheduleId/productId 필요");
        const siteHint = String(message.site || "").trim();
        const onclickTpl = String(message.onclickTpl || "");
        const hrefTpl = String(message.hrefTpl || "");
        const rowIndex = Number(message.rowIndex) || 0;

        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          args: [sid, pid, siteHint, onclickTpl, hrefTpl, rowIndex],
          func: (scheduleId, productId, siteHint, onclickTpl, hrefTpl, rowIndex) => {
            const sid = String(scheduleId);
            const pid = String(productId);
            const rowIdx = Math.max(0, (Number(rowIndex) || 1) - 1);

            const isFacility =
              siteHint === "facility" ||
              Boolean(document.getElementById("scheduleListDiv")) ||
              /facility\.ticketlink\.co\.kr/i.test(location.hostname);

            function fiberOf(node) {
              let el = node;
              while (el) {
                try {
                  for (const k of Reflect.ownKeys(el)) {
                    const name = typeof k === "string" ? k : "";
                    if (
                      name.startsWith("__reactFiber$") ||
                      name.startsWith("__reactInternalInstance$")
                    ) {
                      return el[k];
                    }
                  }
                } catch {
                  /* ignore */
                }
                el = el.parentElement;
              }
              return null;
            }

            function writeIds(obj, depth, seen) {
              if (!obj || typeof obj !== "object" || depth > 6 || seen.has(obj)) return 0;
              seen.add(obj);
              let hits = 0;
              if ("scheduleId" in obj || "schedule_id" in obj) {
                if ("scheduleId" in obj) obj.scheduleId = sid;
                if ("schedule_id" in obj) obj.schedule_id = sid;
                hits += 1;
              }
              if ("productId" in obj || "product_id" in obj) {
                if ("productId" in obj) obj.productId = pid;
                if ("product_id" in obj) obj.product_id = pid;
                hits += 1;
              }
              for (const key of ["schedule", "item", "data", "game", "match", "product", "info"]) {
                if (obj[key] && typeof obj[key] === "object") {
                  hits += writeIds(obj[key], depth + 1, seen);
                }
              }
              return hits;
            }

            function mutateFiber(node) {
              let hits = 0;
              let fiber = fiberOf(node);
              for (let i = 0; i < 24 && fiber; i += 1, fiber = fiber.return) {
                hits += writeIds(fiber.memoizedProps, 0, new Set());
                hits += writeIds(fiber.pendingProps, 0, new Set());
              }
              return hits;
            }

            /** www fiber 이식의 구단 대응: 버튼/행/목록 루트의 Vue·Knockout 객체만 훑음 (window 순회 없음) */
            function mutateVueAround(startEl, clickRowIdx) {
              const out = { hits: 0, kinds: [], notes: [] };
              if (!startEl) return out;

              const patchArrAt = (arr) => {
                if (!Array.isArray(arr) || !arr.length) return 0;
                const idx = Math.min(Math.max(0, clickRowIdx), arr.length - 1);
                const item = arr[idx];
                if (!item || typeof item !== "object") return 0;
                if (!("scheduleId" in item || "schedule_id" in item)) return 0;
                return writeIds(item, 0, new Set());
              };

              const walkVal = (val, depth, seen) => {
                if (!val || typeof val !== "object" || depth > 5 || seen.has(val)) return;
                seen.add(val);
                out.hits += writeIds(val, 0, new Set());
                if (Array.isArray(val)) {
                  out.hits += patchArrAt(val);
                  return;
                }
                for (const key of ["schedules", "scheduleList", "list", "items", "games"]) {
                  try {
                    if (Array.isArray(val[key])) out.hits += patchArrAt(val[key]);
                  } catch {
                    /* ignore */
                  }
                }
              };

              const ingestVue2 = (vm) => {
                if (!vm || typeof vm !== "object") return;
                out.kinds.push("v2");
                const seen = new Set();
                let cur = vm;
                for (let i = 0; i < 14 && cur; i += 1, cur = cur.$parent) {
                  walkVal(cur, 0, seen);
                  walkVal(cur.$data, 0, seen);
                  walkVal(cur.$props, 0, seen);
                  try {
                    out.hits += writeIds(cur, 0, new Set());
                  } catch {
                    /* ignore */
                  }
                }
              };

              const ingestVue3 = (inst) => {
                if (!inst || typeof inst !== "object") return;
                out.kinds.push("v3");
                const seen = new Set();
                let cur = inst;
                for (let i = 0; i < 14 && cur; i += 1, cur = cur.parent) {
                  walkVal(cur.props, 0, seen);
                  walkVal(cur.setupState, 0, seen);
                  walkVal(cur.ctx, 0, seen);
                  walkVal(cur.data, 0, seen);
                  walkVal(cur.proxy, 0, seen);
                  try {
                    walkVal(cur.vnode && cur.vnode.props, 0, seen);
                  } catch {
                    /* ignore */
                  }
                }
              };

              const considerEl = (el) => {
                if (!el || el.nodeType !== 1) return;
                try {
                  if (el.__vue__) ingestVue2(el.__vue__);
                  if (el.__vueParentComponent) ingestVue3(el.__vueParentComponent);
                  if (el.__vnode && el.__vnode.component) ingestVue3(el.__vnode.component);
                  if (el.__vue_app__ && el.__vue_app__._instance) {
                    ingestVue3(el.__vue_app__._instance);
                  }
                } catch {
                  /* ignore */
                }
                try {
                  for (const k of Reflect.ownKeys(el)) {
                    const name = typeof k === "string" ? k : "";
                    if (
                      name.startsWith("__vue") ||
                      name === "__vnode" ||
                      name === "_vnode" ||
                      name.startsWith("__react")
                    ) {
                      out.notes.push(name.slice(0, 48));
                    }
                  }
                } catch {
                  /* ignore */
                }
                try {
                  const ko = window.ko;
                  if (ko && typeof ko.dataFor === "function") {
                    const d = ko.dataFor(el);
                    if (d) {
                      out.kinds.push("ko");
                      out.hits += writeIds(d, 0, new Set());
                    }
                  }
                } catch {
                  /* ignore */
                }
              };

              const roots = [];
              const push = (el) => {
                if (el && roots.indexOf(el) < 0) roots.push(el);
              };
              push(startEl);
              try {
                push(startEl.closest("tr"));
                push(startEl.closest("td"));
                push(startEl.closest("table"));
              } catch {
                /* ignore */
              }
              push(document.getElementById("scheduleListDiv"));
              push(document.getElementById("app"));
              push(document.getElementById("wrap"));
              push(document.querySelector("[data-v-app]"));

              for (const root of roots) {
                let n = root;
                for (
                  let i = 0;
                  i < 18 && n && n !== document.documentElement;
                  i += 1, n = n.parentElement
                ) {
                  considerEl(n);
                }
              }
              out.kinds = [...new Set(out.kinds)];
              out.notes = [...new Set(out.notes)].slice(0, 8);
              return out;
            }

            function fnSrc(fn) {
              try {
                return Function.prototype.toString.call(fn);
              } catch {
                return "";
              }
            }

            function findHandlers(node) {
              const out = { onClick: null, onReserve: null, Vlike: null };
              let fiber = fiberOf(node);
              for (let d = 0; d < 24 && fiber; d += 1, fiber = fiber.return) {
                const props = fiber.memoizedProps;
                if (!props || typeof props !== "object") continue;
                for (const [k, v] of Object.entries(props)) {
                  if (typeof v !== "function") continue;
                  const src = fnSrc(v);
                  if (!out.onClick && k === "onClick") out.onClick = v;
                  if (
                    !out.onReserve &&
                    (/onReserve|reserve/i.test(k) || /onReserve|예매/.test(src.slice(0, 240)))
                  ) {
                    out.onReserve = v;
                  }
                  if (
                    !out.Vlike &&
                    /scheduleId/.test(src) &&
                    /productId/.test(src) &&
                    (/\bV\s*\(/.test(src) || src.length < 400)
                  ) {
                    out.Vlike = v;
                  }
                }
              }
              return out;
            }

            function isForced(el) {
              return Boolean(el?.classList?.contains("__sts_exp_forced_active"));
            }

            function findActiveBtn() {
              const selectors = isFacility
                ? [
                    "#scheduleListDiv a.btn.btn_reserve:not(.btn_reserve_scdl)",
                    "#scheduleListDiv a.btn_reserve:not(.btn_reserve_scdl)",
                  ]
                : [
                    "#reservation a.btn_reserve, #reservation a.common_btn.btn_primary, #reservation a.common_btn",
                  ];
              for (const sel of selectors) {
                for (const a of document.querySelectorAll(sel)) {
                  if (isForced(a)) continue;
                  if (a.classList.contains("btn_reserve_scdl")) continue;
                  const t = (a.innerText || "").replace(/\s+/g, " ").trim();
                  if (/오픈예정|판매예정|마감/.test(t)) continue;
                  if (a.getAttribute("aria-disabled") === "true") continue;
                  if (/예매하기|예매/.test(t) || isFacility) return a;
                }
              }
              return null;
            }

            /** onclick/href 템플릿의 큰 숫자 ID를 사용자 sid/pid 로 치환 */
            function rewriteIdsInCode(code) {
              if (!code) return "";
              let next = String(code);
              next = next.replace(/(scheduleId\s*[:=]\s*['"]?)(\d+)/gi, `$1${sid}`);
              next = next.replace(/(productId\s*[:=]\s*['"]?)(\d+)/gi, `$1${pid}`);
              next = next.replace(/(schedule_id\s*[:=]\s*['"]?)(\d+)/gi, `$1${sid}`);
              next = next.replace(/(product_id\s*[:=]\s*['"]?)(\d+)/gi, `$1${pid}`);
              const nums = [...new Set(next.match(/\d{6,}/g) || [])];
              if (nums.length === 1) {
                next = next.split(nums[0]).join(sid);
              } else if (nums.length >= 2) {
                // 보통 앞이 schedule / product 중 하나
                next = next.replace(nums[0], sid);
                next = next.replace(nums[1], pid);
              }
              return next;
            }

            function runOnclickString(code, el) {
              const rewritten = rewriteIdsInCode(code);
              if (!rewritten) return false;
              try {
                // eslint-disable-next-line no-new-func
                const fn = new Function("event", rewritten);
                fn.call(el || window, { type: "click", target: el, preventDefault() {} });
                return rewritten;
              } catch {
                try {
                  // eslint-disable-next-line no-eval
                  eval(rewritten);
                  return rewritten;
                } catch {
                  return false;
                }
              }
            }

            function stampScheduleIds(el) {
              if (!el) return;
              const apply = (node) => {
                if (!node) return;
                try {
                  node.setAttribute("data-schedule-id", sid);
                  node.setAttribute("data-scheduleId", sid);
                  node.setAttribute("data-product-id", pid);
                  node.setAttribute("data-productId", pid);
                  if (node.dataset) {
                    node.dataset.scheduleId = sid;
                    node.dataset.scheduleid = sid;
                    node.dataset.productId = pid;
                    node.dataset.productid = pid;
                  }
                } catch {
                  /* ignore */
                }
                try {
                  const $ = window.jQuery || window.$;
                  if ($ && typeof $.fn?.data === "function") {
                    $(node).data("scheduleId", sid);
                    $(node).data("scheduleid", sid);
                    $(node).data("productId", pid);
                    $(node).data("productid", pid);
                    $(node).data("schedule_id", sid);
                    $(node).data("product_id", pid);
                  }
                } catch {
                  /* ignore */
                }
              };
              apply(el);
              apply(el.closest?.("tr"));
              apply(el.closest?.("td"));
            }

            /** schedules 배열을 깊게 찾아 해당 행 sid/pid 덮어씀 */
            function patchFacilityScheduleList() {
              let hits = 0;
              const seen = new Set();
              const sidNum = Number(sid);
              const pidNum = Number(pid);

              const patchItem = (item) => {
                if (!item || typeof item !== "object") return false;
                let local = 0;
                try {
                  if ("scheduleId" in item) {
                    item.scheduleId = Number.isFinite(sidNum) ? sidNum : sid;
                    local += 1;
                  }
                  if ("schedule_id" in item) {
                    item.schedule_id = Number.isFinite(sidNum) ? sidNum : sid;
                    local += 1;
                  }
                  if ("productId" in item) {
                    item.productId = Number.isFinite(pidNum) ? pidNum : pid;
                    local += 1;
                  }
                  if ("product_id" in item) {
                    item.product_id = Number.isFinite(pidNum) ? pidNum : pid;
                    local += 1;
                  }
                } catch {
                  return false;
                }
                hits += local;
                return local > 0;
              };

              const tryArr = (arr) => {
                if (!Array.isArray(arr) || arr.length <= rowIdx) return;
                if (!arr[rowIdx] || typeof arr[rowIdx] !== "object") return;
                if (!("scheduleId" in arr[rowIdx] || "schedule_id" in arr[rowIdx])) return;
                patchItem(arr[rowIdx]);
              };

              const looksScheduleArray = (arr) => {
                if (!Array.isArray(arr) || !arr.length) return false;
                const first = arr.find((x) => x && typeof x === "object");
                return Boolean(
                  first && ("scheduleId" in first || "schedule_id" in first)
                );
              };

              const visit = (node, depth) => {
                if (node == null || depth > 8) return;
                if (typeof node !== "object") return;
                if (seen.has(node)) return;
                seen.add(node);
                if (looksScheduleArray(node)) {
                  tryArr(node);
                  return;
                }
                if (Array.isArray(node)) {
                  for (let i = 0; i < Math.min(node.length, 40); i += 1) {
                    visit(node[i], depth + 1);
                    if (hits > 0 && depth > 2) return;
                  }
                  return;
                }
                let keys;
                try {
                  keys = Object.keys(node);
                } catch {
                  return;
                }
                for (const key of keys) {
                  if (hits > 0 && depth > 3) return;
                  try {
                    const low = String(key).toLowerCase();
                    if (
                      low.includes("schedule") ||
                      low.includes("game") ||
                      low === "data" ||
                      low === "list" ||
                      low === "state" ||
                      low === "store"
                    ) {
                      visit(node[key], depth + 1);
                    }
                  } catch {
                    /* ignore */
                  }
                }
                // 키가 애매해도 1단은 훑기
                if (depth <= 1) {
                  for (const key of keys.slice(0, 80)) {
                    try {
                      visit(node[key], depth + 1);
                    } catch {
                      /* ignore */
                    }
                    if (hits > 0) return;
                  }
                }
              };

              try {
                if (Array.isArray(window.__stsSchedulesRef)) {
                  tryArr(window.__stsSchedulesRef);
                }
              } catch {
                /* ignore */
              }

              for (const n of [
                "scheduleList",
                "schedules",
                "scheduleListData",
                "gameList",
                "gameScheduleList",
                "reserveScheduleList",
                "sportsScheduleList",
                "__INITIAL_STATE__",
                "__NEXT_DATA__",
              ]) {
                try {
                  tryArr(window[n]);
                  visit(window[n], 0);
                } catch {
                  /* ignore */
                }
              }

              // window 전체 순회는 페이지를 멈춤 → 금지

              // jQuery data 캐시
              try {
                const $ = window.jQuery || window.$;
                if ($ && $._data) {
                  const root = document.getElementById("scheduleListDiv") || document.body;
                  const stack = [root, ...root.querySelectorAll("tr, td, a, table")];
                  for (const el of stack.slice(0, 300)) {
                    try {
                      const d = $._data(el);
                      if (d) visit(d, 0);
                    } catch {
                      /* ignore */
                    }
                  }
                }
              } catch {
                /* ignore */
              }

              return hits;
            }

            function invokeFacilityClassic() {
              const diag = {
                hasSample: false,
                fiberOk: false,
                mutateHits: 0,
                method: "",
                handlerKeys: [],
                site: "facility",
                hasOnclickTpl: Boolean(onclickTpl),
                hasHrefTpl: Boolean(hrefTpl),
                rowIndex: rowIdx + 1,
                listPatchHits: 0,
                samplePatchHits: 0,
                hasSchedulesRef: Boolean(window.__stsSchedulesRef),
                sampleIndex: 0,
                vueHits: 0,
                vueKind: "-",
                probeNotes: [],
              };

              const forced = document.querySelector(
                "#scheduleListDiv a.__sts_exp_forced_active, a.__sts_exp_forced_active"
              );
              const realBtns = [
                ...document.querySelectorAll(
                  "#scheduleListDiv a.btn.btn_reserve:not(.btn_reserve_scdl):not(.__sts_exp_forced_active), #scheduleListDiv a.btn_reserve:not(.btn_reserve_scdl):not(.__sts_exp_forced_active)"
                ),
              ];
              diag.hasSample = realBtns.length > 0;
              const sample = realBtns[0] || null;

              const rows = [
                ...document.querySelectorAll(
                  "#scheduleListDiv tbody tr, #scheduleListDiv table tr"
                ),
              ].filter((tr) => tr.querySelector("a.btn_reserve, a.btn_reserve_scdl"));
              const sampleTr = sample?.closest?.("tr") || null;
              let sampleIdx = sampleTr ? rows.indexOf(sampleTr) : -1;
              if (sampleIdx < 0) sampleIdx = 0;
              diag.sampleIndex = sampleIdx + 1;

              const sidNum = Number(sid);
              const pidNum = Number(pid);
              const backups = [];

              const patchItem = (item, tag) => {
                if (!item || typeof item !== "object") return 0;
                let local = 0;
                const bak = {
                  tag,
                  item,
                  scheduleId: item.scheduleId,
                  schedule_id: item.schedule_id,
                  productId: item.productId,
                  product_id: item.product_id,
                };
                try {
                  if ("scheduleId" in item) {
                    item.scheduleId = Number.isFinite(sidNum) ? sidNum : sid;
                    local += 1;
                  }
                  if ("schedule_id" in item) {
                    item.schedule_id = Number.isFinite(sidNum) ? sidNum : sid;
                    local += 1;
                  }
                  if ("productId" in item) {
                    item.productId = Number.isFinite(pidNum) ? pidNum : pid;
                    local += 1;
                  }
                  if ("product_id" in item) {
                    item.product_id = Number.isFinite(pidNum) ? pidNum : pid;
                    local += 1;
                  }
                } catch {
                  return 0;
                }
                if (local > 0) backups.push(bak);
                return local;
              };

              const restoreBackups = () => {
                for (const b of backups) {
                  try {
                    if ("scheduleId" in b.item) b.item.scheduleId = b.scheduleId;
                    if ("schedule_id" in b.item) b.item.schedule_id = b.schedule_id;
                    if ("productId" in b.item) b.item.productId = b.productId;
                    if ("product_id" in b.item) b.item.product_id = b.product_id;
                  } catch {
                    /* ignore */
                  }
                }
              };

              // hook 이 잡아둔 스케줄 배열 — 샘플 행 sid 를 사용자 값으로
              try {
                const ref = window.__stsSchedulesRef;
                if (Array.isArray(ref) && ref.length) {
                  diag.hasSchedulesRef = true;
                  const idx = Math.min(sampleIdx, ref.length - 1);
                  diag.samplePatchHits += patchItem(ref[idx], "ref.sample");
                  if (rowIdx !== idx && rowIdx < ref.length) {
                    diag.samplePatchHits += patchItem(ref[rowIdx], "ref.target");
                  }
                }
              } catch {
                /* ignore */
              }

              diag.listPatchHits = patchFacilityScheduleList();
              const vueDiag = mutateVueAround(sample || forced, sampleIdx);
              diag.vueHits = vueDiag.hits;
              diag.vueKind = vueDiag.kinds.join(",") || "-";
              if (forced) stampScheduleIds(forced);
              if (sample) stampScheduleIds(sample);

              const clickTarget = sample || forced;
              if (!clickTarget) {
                restoreBackups();
                return {
                  ok: false,
                  error: "활성 샘플/강제 버튼 없음",
                  ...diag,
                };
              }

              // NetFunnel: 활성 샘플 실제 click — URL 직행/강제합성 클릭 금지
              try {
                clickTarget.click();
                diag.method = sample
                  ? "facility.vuePatch+sampleClick"
                  : "facility.vuePatch+forcedClick";
                diag.probeNotes.push(
                  `vue=${diag.vueKind} vueHits=${diag.vueHits} keys=${vueDiag.notes.join("|") || "-"} ref=${diag.hasSchedulesRef} sampleHits=${diag.samplePatchHits} listHits=${diag.listPatchHits} sample#=${diag.sampleIndex}`
                );
                setTimeout(restoreBackups, 8000);
                const patched =
                  diag.vueHits > 0 || diag.samplePatchHits > 0 || diag.listPatchHits > 0;
                return {
                  ok: true,
                  ...diag,
                  error: patched
                    ? ""
                    : "Vue/배열 못 찾음 — 로그 vue= 와 keys= 확인",
                };
              } catch (e) {
                restoreBackups();
                return {
                  ok: false,
                  error: String(e?.message || e),
                  ...diag,
                };
              }
            }

            // ===== facility: React 없음 → classic =====
            if (isFacility) {
              return invokeFacilityClassic();
            }

            // ===== www: React fiber 경로 =====
            const forcedBtn = document.querySelector(
              "#reservation a.__sts_exp_forced_active, a.__sts_exp_forced_active"
            );
            const otherSample = findActiveBtn();

            function hasOwnFiber(node) {
              if (!node) return false;
              try {
                for (const k of Reflect.ownKeys(node)) {
                  const name = typeof k === "string" ? k : "";
                  if (
                    name.startsWith("__reactFiber$") ||
                    name.startsWith("__reactInternalInstance$")
                  ) {
                    return true;
                  }
                }
              } catch {
                /* ignore */
              }
              return false;
            }

            const probeList = [];
            const pushProbe = (el, tag) => {
              if (!el || probeList.some((p) => p.el === el)) return;
              probeList.push({ el, tag });
            };

            // 클론(비활성 교체)은 own fiber 없음 → 활성 샘플 핸들러+ID패치가 본체
            // live(이미 활성 덮어쓰기)는 own fiber 있음 → forced 우선
            if (hasOwnFiber(forcedBtn)) {
              pushProbe(forcedBtn, "forced");
              pushProbe(otherSample, "other");
            } else {
              pushProbe(otherSample, "other");
              pushProbe(forcedBtn, "forced");
            }
            document
              .querySelectorAll(
                "#reservation a.btn_reserve, #reservation a.common_btn.btn_primary, #reservation a.common_btn, #reservation li, #reservation .match_btn"
              )
              .forEach((el) => pushProbe(el, "scan"));
            pushProbe(document.querySelector("#reservation"), "root");

            const diag = {
              hasSample: Boolean(otherSample),
              hasForced: Boolean(forcedBtn),
              forcedOwnFiber: hasOwnFiber(forcedBtn),
              fiberOk: false,
              mutateHits: 0,
              method: "",
              handlerKeys: [],
              site: "www",
              probeCount: probeList.length,
              hasOnclickTpl: Boolean(onclickTpl),
              hasHrefTpl: Boolean(hrefTpl),
            };

            function tryInvokeOnNode(node, tag) {
              if (!node) return null;
              const fiberOk = Boolean(fiberOf(node));
              if (fiberOk) diag.fiberOk = true;
              const hits = mutateFiber(node);
              diag.mutateHits += hits;
              const fns = findHandlers(node);
              const keys = Object.entries(fns)
                .filter(([, v]) => typeof v === "function")
                .map(([k]) => k);
              if (keys.length) {
                diag.handlerKeys = [...new Set([...(diag.handlerKeys || []), ...keys])];
              }

              const ev = {
                type: "click",
                bubbles: true,
                cancelable: true,
                target: node,
                currentTarget: node,
                preventDefault() {},
                stopPropagation() {},
                isTrusted: true,
              };

              if (typeof fns.onReserve === "function") {
                try {
                  fns.onReserve(ev);
                  return `${tag}.onReserve`;
                } catch (e) {
                  diag.onReserveErr = String(e?.message || e);
                }
              }
              if (typeof fns.onClick === "function") {
                try {
                  fns.onClick(ev);
                  return `${tag}.onClick`;
                } catch (e) {
                  diag.onClickErr = String(e?.message || e);
                }
              }
              if (typeof fns.Vlike === "function") {
                try {
                  fns.Vlike({ scheduleId: sid, productId: pid });
                  return `${tag}.Vlike`;
                } catch {
                  try {
                    fns.Vlike();
                    return `${tag}.Vlike()`;
                  } catch (e2) {
                    diag.VlikeErr = String(e2?.message || e2);
                  }
                }
              }
              return null;
            }

            for (const { el, tag } of probeList) {
              const method = tryInvokeOnNode(el, tag);
              if (method) {
                diag.method = `www.${method}`;
                return { ok: true, ...diag };
              }
            }

            // forced / other 네이티브 click (React가 네이티브 리스너인 경우)
            for (const el of [forcedBtn, otherSample]) {
              if (!el) continue;
              try {
                const prevOn = el.getAttribute("onclick");
                if (prevOn) {
                  const ran = runOnclickString(prevOn, el);
                  if (ran) {
                    diag.method = "www.onclick";
                    return { ok: true, ...diag };
                  }
                }
              } catch (e) {
                diag.nativeClickErr = String(e?.message || e);
              }
            }

            // 캡처 리스너가 React bubble 을 막은 경우: forced 에서 stop 없이 재클릭 불가하니
            // 잠깐 클래스를 유지한 채 프로그램 click (isolated capture 는 이미 지난 뒤)
            if (forcedBtn) {
              try {
                forcedBtn.click();
                diag.method = "www.forced.click";
                return { ok: true, ...diag };
              } catch (e) {
                diag.forcedClickErr = String(e?.message || e);
              }
            }
            if (otherSample) {
              try {
                otherSample.click();
                diag.method = "www.sample.click";
                return { ok: true, ...diag };
              } catch (e) {
                diag.nativeClickErr = String(e?.message || e);
              }
            }

            // onclick 템플릿 (합성 버튼용)
            if (onclickTpl) {
              const ran = runOnclickString(onclickTpl, forcedBtn || document.body);
              if (ran) {
                diag.method = "www.onclickTpl";
                return { ok: true, ...diag };
              }
            }
            if (hrefTpl) {
              const nextHref = rewriteIdsInCode(hrefTpl);
              if (/^https?:|^\//.test(nextHref)) {
                location.href = nextHref;
                diag.method = "www.hrefTpl";
                return { ok: true, ...diag };
              }
              if (/^javascript:/i.test(nextHref)) {
                const ran = runOnclickString(
                  nextHref.replace(/^javascript:/i, ""),
                  forcedBtn || document.body
                );
                if (ran) {
                  diag.method = "www.hrefJavascript";
                  return { ok: true, ...diag };
                }
              }
            }

            for (const k of ["V", "openReserve", "goReserve", "startReserve", "onReserve"]) {
              try {
                if (typeof window[k] === "function") {
                  window[k]({ scheduleId: sid, productId: pid });
                  diag.method = `main.window.${k}`;
                  return { ok: true, ...diag };
                }
              } catch {
                /* next */
              }
            }

            return {
              ok: false,
              error: "MAIN: 핸들러/V 없음",
              ...diag,
            };
          },
        });

        const result = results?.[0]?.result || { ok: false, error: "executeScript 결과 없음" };
        progressLog(
          result.ok
            ? `MAIN OK · ${result.method} · site=${result.site || "?"} hits=${result.mutateHits}`
            : `MAIN fail · ${result.error || "?"} · site=${result.site || "?"}`,
          result.ok ? "ok" : "warn",
          "exp"
        );
        sendResponse(result);
      } catch (error) {
        progressLog(`MAIN exception: ${error.message}`, "error", "exp");
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }

  // DECORD 경기 표 팝업 — 이미 열려 있으면 포커스
  if (message?.type === "DECORD_FOCUS_TABLE") {
    (async () => {
      try {
        const url = message.url || chrome.runtime.getURL("decord/table.html");
        const wins = await chrome.windows.getAll({ populate: true, windowTypes: ["popup"] });
        for (const w of wins) {
          const hit = (w.tabs || []).find((t) => t.url && t.url.startsWith(url.split("?")[0]));
          if (hit) {
            await chrome.windows.update(w.id, { focused: true });
            if (hit.id != null) await chrome.tabs.update(hit.id, { active: true });
            sendResponse({ ok: true, focused: true });
            return;
          }
        }
        sendResponse({ ok: false, focused: false });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // —— NOL(인터파크) 전용 — ticketlink Rec/Sched와 스토리지·메시지 분리 ——
  if (message?.type === "NOL_ARM") {
    armNolInternal(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "NOL_DISARM") {
    disarmNolInternal()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "NOL_GET_STATE") {
    chrome.storage.local.get(["nolArmed", "nolConfig"]).then((data) => {
      sendResponse({
        ok: true,
        armed: Boolean(data.nolArmed),
        config: data.nolConfig || null,
      });
    });
    return true;
  }

  if (message?.type === "NOL_RESULT") {
    if (message.ok) {
      progressLog(`[NOL] 클릭 성공 (${message.reason || "ok"})`, "ok", "nol");
      chrome.storage.local.set({ nolArmed: false }).then(() => {
        broadcast({ type: "NOL_STATE", armed: false });
      });
    } else {
      progressLog(message.error || "[NOL] 클릭 실패", "error", "nol");
    }
    return false;
  }

  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab?.url || !/ticketlink\.co\.kr/i.test(tab.url)) return;
  chrome.storage.local.get(["autoRecArmed", "facilityAutoRecArmed"]).then((data) => {
    if (!data.autoRecArmed && !data.facilityAutoRecArmed) return;
    chrome.tabs.sendMessage(tabId, { type: "AUTO_REC_RESTART" }).catch(() => {});
  });
});

/** NOL 전용 — interpark 탭만, ticketlink AUTO_REC_RESTART와 무관 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab?.url || !/interpark\.com/i.test(tab.url)) return;
  chrome.storage.local.get(["nolArmed"]).then((data) => {
    if (!data.nolArmed) return;
    chrome.tabs.sendMessage(tabId, { type: "NOL_RESTART" }).catch(() => {});
  });
});
