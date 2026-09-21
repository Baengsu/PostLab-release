/**
 * NOL(인터파크) 전용 — 서버 시계 기준 예약 감시 → disabled 해제 시 1회 클릭
 * ticketlink content.js / content-exp.js 와 완전 분리
 * 시각 기준: 상단 Sync(stsServerSync.offsetMs) — PC 로컬 시계 아님
 */

const NOL_ARMED_KEY = "nolArmed";
const NOL_CONFIG_KEY = "nolConfig";
const STS_SYNC_STORAGE = "stsServerSync";

let nolArmed = false;
let nolConfig = null;
let syncOffsetMs = null;
let waitTimer = null;
let findTimer = null;
let exactTimer = null;
let observer = null;
let isClicked = false;
let watching = false;

function progressLog(text, level = "info") {
  chrome.runtime.sendMessage({ type: "PROGRESS_LOG", text, level, source: "nol" }).catch(() => {});
}

function serverNowMs() {
  if (syncOffsetMs == null || !Number.isFinite(syncOffsetMs)) return null;
  return Date.now() + syncOffsetMs;
}

function clearTimersAndObserver() {
  if (waitTimer != null) {
    clearTimeout(waitTimer);
    waitTimer = null;
  }
  if (findTimer != null) {
    clearTimeout(findTimer);
    findTimer = null;
  }
  if (exactTimer != null) {
    clearTimeout(exactTimer);
    exactTimer = null;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  watching = false;
}

function stopNolWatch(log = true) {
  clearTimersAndObserver();
  isClicked = false;
  if (log) progressLog("[NOL] 감시 중지", "info");
}

function parseTargetMs(config) {
  if (config?.targetMs != null && Number.isFinite(Number(config.targetMs))) {
    return Number(config.targetMs);
  }
  const raw = String(config?.targetString || "").trim();
  if (!raw) return NaN;
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  return new Date(normalized).getTime();
}

function isBtnDisabled(btn, disabledClass) {
  if (!btn) return true;
  if (btn.hasAttribute("disabled")) return true;
  const cls = String(disabledClass || "").trim();
  if (cls && btn.classList.contains(cls)) return true;
  return false;
}

function executeClick(btn, reason) {
  if (isClicked || !btn) return false;
  isClicked = true;
  btn.click();
  progressLog(`[NOL] [${reason}] 버튼 클릭 성공`, "ok");
  chrome.runtime
    .sendMessage({ type: "NOL_RESULT", ok: true, reason })
    .catch(() => {});
  clearTimersAndObserver();
  return true;
}

function initObserver() {
  if (!nolArmed || !nolConfig) return;
  watching = true;

  const selector = String(nolConfig.selector || "div.buttons > button").trim();
  const disabledClass = String(nolConfig.disabledClass || "").trim();
  const targetBtn = document.querySelector(selector);

  if (!targetBtn) {
    progressLog("[NOL] 버튼 없음 — 0.1초 후 재시도", "warn");
    findTimer = setTimeout(() => {
      findTimer = null;
      if (nolArmed) initObserver();
    }, 100);
    return;
  }

  const checkDisabled = () => isBtnDisabled(targetBtn, disabledClass);

  if (!checkDisabled()) {
    executeClick(targetBtn, "즉시 실행");
    return;
  }

  observer = new MutationObserver(() => {
    if (!nolArmed || isClicked) return;
    if (!checkDisabled()) {
      executeClick(targetBtn, "감지 완료");
    }
  });
  observer.observe(targetBtn, {
    attributes: true,
    attributeFilter: ["disabled", "class"],
  });

  const now = serverNowMs();
  const targetMs = parseTargetMs(nolConfig);
  if (now != null && Number.isFinite(targetMs)) {
    const timeToExact = targetMs - now;
    if (timeToExact > 0) {
      exactTimer = setTimeout(() => {
        exactTimer = null;
        if (!nolArmed || isClicked) return;
        if (!checkDisabled()) {
          executeClick(targetBtn, "정각 안전장치");
        }
      }, timeToExact);
    }
  }

  const warmupMs = Math.max(0, Number(nolConfig.warmupMs) || 2000);
  progressLog(`[NOL] 예열 완료 — 서버시각 기준 ${warmupMs}ms 전 감시 중`, "info");
}

function startNolSchedule() {
  stopNolWatch(false);
  isClicked = false;

  if (!nolArmed || !nolConfig) return;

  const now = serverNowMs();
  if (now == null) {
    progressLog("[NOL] 서버 시계 없음 — 상단 Sync 후 다시 예약", "error");
    return;
  }

  const targetMs = parseTargetMs(nolConfig);
  if (!Number.isFinite(targetMs)) {
    progressLog("[NOL] 시각 형식 오류", "error");
    return;
  }

  const warmupMs = Math.max(0, Number(nolConfig.warmupMs) || 2000);
  const timeToOpen = targetMs - now;
  const delayMs = timeToOpen - warmupMs;

  progressLog(
    `[NOL] ${nolConfig.targetString} 오픈까지(서버) ${(timeToOpen / 1000).toFixed(1)}초`,
    "info"
  );

  if (delayMs > 0) {
    progressLog(`[NOL] ${(delayMs / 1000).toFixed(1)}초 후 감시 시작`, "info");
    waitTimer = setTimeout(() => {
      waitTimer = null;
      if (nolArmed) initObserver();
    }, delayMs);
  } else {
    initObserver();
  }
}

async function loadNolFromStorage() {
  const data = await chrome.storage.local.get([NOL_ARMED_KEY, NOL_CONFIG_KEY, STS_SYNC_STORAGE]);
  nolArmed = Boolean(data[NOL_ARMED_KEY]);
  nolConfig = data[NOL_CONFIG_KEY] || null;
  const sync = data[STS_SYNC_STORAGE];
  syncOffsetMs = sync?.offsetMs != null ? Number(sync.offsetMs) : null;
  if (nolArmed && nolConfig) startNolSchedule();
  else stopNolWatch(false);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  let nolChanged = false;
  let syncChanged = false;

  if (changes[NOL_ARMED_KEY]) {
    nolArmed = Boolean(changes[NOL_ARMED_KEY].newValue);
    nolChanged = true;
  }
  if (changes[NOL_CONFIG_KEY]) {
    nolConfig = changes[NOL_CONFIG_KEY].newValue || null;
    nolChanged = true;
  }
  if (changes[STS_SYNC_STORAGE]) {
    const sync = changes[STS_SYNC_STORAGE].newValue;
    const next = sync?.offsetMs != null ? Number(sync.offsetMs) : null;
    if (next !== syncOffsetMs) {
      syncOffsetMs = next;
      syncChanged = true;
    }
  }

  if (!nolChanged && !syncChanged) return;

  if (nolArmed && nolConfig) startNolSchedule();
  else if (nolChanged) stopNolWatch(true);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "NOL_RESTART") {
    if (nolArmed && nolConfig) startNolSchedule();
  }
});

loadNolFromStorage().catch(() => {});
