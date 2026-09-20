/**
 * Server Time Sync — 사이드패널
 * Sync / 예약 / www·구단 Auto Click / 오픈예정 교체 / Progress Log
 */

const STORAGE_KEY = "serverTimeUrl";
const SCHED_REC_KEY = "schedRecInputs";
const FAC_REC_FIELDS_KEY = "facilityRecFields";

const urlInput = document.getElementById("url-input");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const timeDisplay = document.getElementById("time-display");
const statusText = document.getElementById("status-text");
const rttValue = document.getElementById("rtt-value");

const autoUrl = document.getElementById("auto-url");
const autoIndex = document.getElementById("auto-index");
const autoText = document.getElementById("auto-text");
const midSelector = document.getElementById("mid-selector");
const modalDelay = document.getElementById("modal-delay");
const modalSelector = document.getElementById("modal-selector");
const modalText = document.getElementById("modal-text");
const autoClickBtn = document.getElementById("auto-click-btn");
const autoStatus = document.getElementById("auto-status");
const autoRecState = document.getElementById("auto-rec-state");

const facAutoUrl = document.getElementById("fac-auto-url");
const facAutoIndex = document.getElementById("fac-auto-index");
const facAutoText = document.getElementById("fac-auto-text");
const facMidSelector = document.getElementById("fac-mid-selector");
const facModalDelay = document.getElementById("fac-modal-delay");
const facModalSelector = document.getElementById("fac-modal-selector");
const facModalText = document.getElementById("fac-modal-text");
const facAutoClickBtn = document.getElementById("fac-auto-click-btn");
const facAutoStatus = document.getElementById("fac-auto-status");
const facRecState = document.getElementById("fac-rec-state");

const schedHh = document.getElementById("sched-hh");
const schedMm = document.getElementById("sched-mm");
const schedSs = document.getElementById("sched-ss");
const schedMs = document.getElementById("sched-ms");
const schedRecArmBtn = document.getElementById("sched-rec-arm-btn");
const schedRecClearBtn = document.getElementById("sched-rec-clear-btn");
const schedRecSite = document.getElementById("sched-rec-site");
const schedRecState = document.getElementById("sched-rec-state");
const schedRecStatus = document.getElementById("sched-rec-status");

const progressLogEl = document.getElementById("progress-log");
const progressLogWrap = document.getElementById("progress-log-wrap");
const progressLogToggle = document.getElementById("progress-log-toggle");
const progressLogBody = document.getElementById("progress-log-body");
const progressLogCount = document.getElementById("progress-log-count");
const clearProgressBtn = document.getElementById("clear-progress-btn");
const copyProgressBtn = document.getElementById("copy-progress-btn");

function isProgressOpen() {
  return Boolean(progressLogWrap?.classList.contains("is-open"));
}

function setProgressOpen(open) {
  if (!progressLogWrap || !progressLogToggle || !progressLogBody) return;
  progressLogWrap.classList.toggle("is-open", open);
  progressLogToggle.setAttribute("aria-expanded", open ? "true" : "false");
  progressLogBody.hidden = !open;
  if (open) {
    progressLogCount?.classList.remove("has-new");
    if (progressLogEl) progressLogEl.scrollTop = progressLogEl.scrollHeight;
  }
}

function updateProgressCount() {
  if (!progressLogCount || !progressLogEl) return;
  const n = progressLogEl.querySelectorAll(".plog").length;
  progressLogCount.textContent = String(n);
}

function appendProgressLog(text, level = "info", source = "ui") {
  if (!progressLogEl || !text) return;
  const row = document.createElement("div");
  row.className = `plog ${level}`;
  const now = new Date();
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const mark = friendlyLevelMark(level);
  const src = friendlySource(source);
  const msg = friendlyMessage(text);
  row.dataset.raw = `[${time}] ${mark} ${src} ${String(text)}`;
  row.innerHTML =
    `<span class="plog-time">${time}</span>` +
    `<span class="plog-mark">${mark}</span>` +
    `<span class="plog-src">${src}</span>` +
    `<span class="plog-msg"></span>`;
  row.querySelector(".plog-msg").textContent = msg;
  progressLogEl.appendChild(row);
  progressLogEl.scrollTop = progressLogEl.scrollHeight;
  while (progressLogEl.children.length > 200) {
    progressLogEl.removeChild(progressLogEl.firstChild);
  }
  updateProgressCount();
  if (!isProgressOpen()) progressLogCount?.classList.add("has-new");
}

async function copyProgressLogAll() {
  if (!progressLogEl) return;
  const lines = [...progressLogEl.querySelectorAll(".plog")]
    .map((row) => row.dataset.raw || row.textContent || "")
    .filter(Boolean);
  if (!lines.length) {
    appendProgressLog("복사할 로그 없음", "warn", "ui");
    return;
  }
  const text = lines.join("\n");
  try {
    await navigator.clipboard.writeText(text);
    appendProgressLog(`로그 ${lines.length}줄 복사됨`, "ok", "ui");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      appendProgressLog(`로그 ${lines.length}줄 복사됨`, "ok", "ui");
    } catch (error) {
      appendProgressLog(`복사 실패: ${error.message || error}`, "error", "ui");
    }
    ta.remove();
  }
}

progressLogToggle?.addEventListener("click", () => {
  setProgressOpen(!isProgressOpen());
});

copyProgressBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  void copyProgressLogAll();
});
clearProgressBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  if (progressLogEl) progressLogEl.innerHTML = "";
  updateProgressCount();
  progressLogCount?.classList.remove("has-new");
});

let offsetMs = null;
let rafId = null;
let running = false;
let scheduleRecArmed = false;
let scheduleRecTargetMs = null;
let wwwRecArmed = false;
let facRecArmed = false;

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

function formatServerTime(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${pad(
    d.getMilliseconds(),
    3
  )}`;
}

function setStatus(message, type = "") {
  if (!statusText) return;
  statusText.textContent = message;
  statusText.className = type ? `status ${type}` : "status";
}

function normalizeUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) throw new Error("URL을 입력해주세요.");
  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(withProtocol).href;
  } catch {
    throw new Error("올바른 URL 형식이 아닙니다.");
  }
}

function startClock() {
  if (rafId !== null) return;
  const tick = () => {
    if (offsetMs === null) {
      rafId = null;
      return;
    }
    if (timeDisplay) timeDisplay.textContent = formatServerTime(Date.now() + offsetMs);
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function stopClock({ resetDisplay = false } = {}) {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (resetDisplay) {
    offsetMs = null;
    if (timeDisplay) timeDisplay.textContent = "--:--:-- ---";
  }
}

function siteLabel(site) {
  return site === "facility" ? "Club" : "Basic";
}

/** Short English log (HTML names: Start / Basic / Club / Rec) */
function friendlySource(source) {
  const map = {
    ui: "UI",
    bg: "Sys",
    sync: "Time",
    sched: "Book",
    auto: "Rec",
    content: "Page",
  };
  return map[source] || "Info";
}

function friendlyLevelMark(level) {
  if (level === "ok") return "OK";
  if (level === "warn") return "WARN";
  if (level === "error") return "ERR";
  return "…";
}

function friendlyMessage(text) {
  let t = String(text || "");
  const reps = [
    [/서버 시간 맞춤을 시작했습니다[^\n]*/gi, "Time sync ON"],
    [/서버 시간 맞춤을 멈췄습니다/gi, "Time sync OFF"],
    [/BG Sync ON[^\n]*/gi, "Time sync ON"],
    [/BG Sync OFF/gi, "Time sync OFF"],
    [/Sync 실패[:：]?\s*/gi, "Sync fail: "],
    [/시간 맞춤 실패[:：]?\s*/gi, "Sync fail: "],
    [/Sync\(alarm\) 실패[:：]?\s*/gi, "Sync fail: "],
    [/시간은 멈췄지만 예약은 그대로입니다/gi, "Sync OFF · booking kept"],
    [/Sync 중지[^\n]*/gi, "Sync OFF · booking kept"],
    [/Start 버튼으로[^\n]*/gi, "Press Start again"],
    [/Sync는 버튼으로[^\n]*/gi, "Press Start again"],
    [/예매 페이지가 아직[^\n]*/gi, "Page not ready"],
    [/content 미연결[^\n]*/gi, "Page not ready"],
    [/예매 페이지와 연결[^\n]*/gi, "Page linked"],
    [/content 로드[^\n]*/gi, "Page linked"],
    [/예약이 설정되었습니다[^\n]*/gi, "Booked"],
    [/예약 Armed[^\n]*/gi, "Booked"],
    [/예약 설정[^\n]*/gi, "Booked"],
    [/예약을 취소했습니다/gi, "Booking cleared"],
    [/예약 해제[^\n]*/gi, "Booking cleared"],
    [/저장된 예약을 불러왔습니다/gi, "Booking restored"],
    [/예약 복구됨[^\n]*/gi, "Booking restored"],
    [/예약 임박[^\n]*/gi, "Booking soon"],
    [/예약 시각이 곧[^\n]*/gi, "Booking soon"],
    [/예약 시각입니다[^\n]*/gi, "Time hit · Rec start"],
    [/예약 시각 도달[^\n]*/gi, "Time hit · Rec start"],
    [/이미 자동 클릭이 켜져[^\n]*/gi, "Rec already ON"],
    [/이미 Rec ON[^\n]*/gi, "Rec already ON"],
    [/예약 실행 실패[:：]?\s*/gi, "Book fail: "],
    [/예약 Rec 실패[:：]?\s*/gi, "Book fail: "],
    [/자동 클릭 시작[^\n]*구단[^\n]*/gi, "Club Rec ON"],
    [/자동 클릭 시작[^\n]*기본[^\n]*/gi, "Basic Rec ON"],
    [/구단 자동 클릭 감시[^\n]*/gi, "Club Rec ON"],
    [/기본 자동 클릭 감시[^\n]*/gi, "Basic Rec ON"],
    [/자동 클릭 감시를 시작[^\n]*/gi, "Rec ON"],
    [/Rec ON[^\n]*구단[^\n]*/gi, "Club Rec ON"],
    [/Rec ON[^\n]*www[^\n]*/gi, "Basic Rec ON"],
    [/Rec ON[^\n]*/gi, "Rec ON"],
    [/자동 클릭 중지[^\n]*구단[^\n]*/gi, "Club Rec OFF"],
    [/자동 클릭 중지[^\n]*기본[^\n]*/gi, "Basic Rec OFF"],
    [/구단 자동 클릭을 멈췄습니다/gi, "Club Rec OFF"],
    [/기본 자동 클릭을 멈췄습니다/gi, "Basic Rec OFF"],
    [/자동 클릭을 멈췄습니다/gi, "Rec OFF"],
    [/Rec OFF[^\n]*구단[^\n]*/gi, "Club Rec OFF"],
    [/Rec OFF[^\n]*www[^\n]*/gi, "Basic Rec OFF"],
    [/Rec OFF[^\n]*/gi, "Rec OFF"],
    [/Rec Stop[^\n]*/gi, "Rec OFF"],
    [/예매 버튼을 기다리는 중/gi, "Waiting btn"],
    [/Rec 감시 활성/gi, "Waiting btn"],
    [/자동 클릭에 성공했습니다/gi, "Rec OK"],
    [/Rec 클릭 성공/gi, "Rec OK"],
    [/자동 클릭에 실패했습니다/gi, "Rec fail"],
    [/Rec 실패/gi, "Rec fail"],
    [/예매 페이지로 이동합니다[:：]?\s*/gi, "Go: "],
    [/URL 이동[:：]?\s*/gi, "Go: "],
    [/예매 버튼을 찾았습니다[^\n]*/gi, "Btn found"],
    [/타겟 포착[^\n]*/gi, "Btn found"],
    [/① 예매 버튼을 찾는 중/gi, "1. Find btn"],
    [/\[1단계\] 버튼 탐색[^\n]*/gi, "1. Find btn"],
    [/① 예매 버튼을 찾지 못했습니다/gi, "1. No btn"],
    [/\[1단계\] 메인 버튼 없음[^\n]*/gi, "1. No btn"],
    [/① 예매 버튼을 눌렀습니다/gi, "1. Clicked"],
    [/\[1단계\] 클릭 완료/gi, "1. Clicked"],
    [/①-② 안내 창을 확인했습니다/gi, "1.5 Notice OK"],
    [/\[1\.5단계\][^\n]*클릭 완료/gi, "1.5 Notice OK"],
    [/①-② 안내 창을 찾는 중/gi, "1.5 Notice…"],
    [/\[1\.5단계\][^\n]*/gi, "1.5 Notice…"],
    [/② 확인 버튼을 눌렀습니다/gi, "2. Confirm OK"],
    [/\[2단계\][^\n]*클릭 완료/gi, "2. Confirm OK"],
    [/② 확인 버튼을 찾는 중/gi, "2. Confirm…"],
    [/\[2단계\][^\n]*/gi, "2. Confirm…"],
    [/잠시 대기 중\s*\((\d+)ms\)/gi, "Wait $1ms"],
    [/\[대기\]\s*(\d+)ms/gi, "Wait $1ms"],
    [/예매 클릭을 모두 마쳤습니다/gi, "Click done"],
    [/예매 클릭을 마쳤습니다/gi, "Click done"],
    [/클릭 시퀀스 성공[^\n]*/gi, "Click done"],
    [/클릭 시퀀스 완료/gi, "Click done"],
    [/응답속도\s*(\d+)\s*ms/gi, "RTT $1ms"],
    [/RTT\s*(\d+)\s*ms/gi, "RTT $1ms"],
    [/site=facility/gi, "Club"],
    [/site=www/gi, "Basic"],
    [/\bwww\b/gi, "Basic"],
    [/facility/gi, "Club"],
    [/구단/gi, "Club"],
    [/기본/gi, "Basic"],
    [/\(BG\)/gi, ""],
  ];
  for (const [re, to] of reps) t = t.replace(re, to);
  return t.replace(/\s{2,}/g, " ").trim();
}

async function start() {
  let url;
  try {
    url = normalizeUrl(urlInput.value);
  } catch (error) {
    setStatus(error.message, "error");
    return;
  }
  urlInput.value = url;
  await chrome.storage.local.set({ [STORAGE_KEY]: url });
  running = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  urlInput.disabled = true;
  setStatus("동기화 중…");
  try {
    const result = await chrome.runtime.sendMessage({ type: "START_SERVER_SYNC", url });
    if (!result?.ok) throw new Error(result?.error || "시간 맞춤 실패");
    offsetMs = result.offsetMs;
    if (rttValue) rttValue.textContent = `RTT ${result.rttMs} ms`;
    setStatus(`연결됨 · 응답속도 ${result.rttMs} ms`, "ok");
    startClock();
  } catch (error) {
    running = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    urlInput.disabled = false;
    setStatus(error.message, "error");
  }
}

async function stop() {
  running = false;
  try {
    await chrome.runtime.sendMessage({ type: "STOP_SERVER_SYNC", keepOffset: true });
  } catch {
    /* ignore */
  }
  stopClock({ resetDisplay: false });
  startBtn.disabled = false;
  stopBtn.disabled = true;
  urlInput.disabled = false;
  setStatus("Stop — 시간 맞춤을 멈췄습니다", "warn");
}

startBtn?.addEventListener("click", () => void start());
stopBtn?.addEventListener("click", () => void stop());
// Enter로는 Sync 시작하지 않음 — Sync 버튼만

chrome.storage.local.get(STORAGE_KEY).then((data) => {
  if (data[STORAGE_KEY] && urlInput) urlInput.value = data[STORAGE_KEY];
}).catch(() => {});

function setWwwRecUi(armed) {
  wwwRecArmed = Boolean(armed);
  if (autoRecState) {
    autoRecState.textContent = wwwRecArmed ? "ON" : "Idle";
    autoRecState.classList.toggle("on", wwwRecArmed);
  }
  if (autoClickBtn) {
    autoClickBtn.textContent = wwwRecArmed ? "■ Stop" : "● Rec";
    autoClickBtn.classList.toggle("is-on", wwwRecArmed);
  }
}

function setFacRecUi(armed) {
  facRecArmed = Boolean(armed);
  if (facRecState) {
    facRecState.textContent = facRecArmed ? "ON" : "Idle";
    facRecState.classList.toggle("on", facRecArmed);
  }
  if (facAutoClickBtn) {
    facAutoClickBtn.textContent = facRecArmed ? "■ Stop" : "● 구단Rec";
    facAutoClickBtn.classList.toggle("is-on", facRecArmed);
  }
}

function buildRecPayload(site) {
  const isFacility = site === "facility";
  const delayMs = Math.max(0, Number((isFacility ? facModalDelay : modalDelay)?.value) || 0);
  return {
    type: "START_AUTO_REC",
    site: isFacility ? "facility" : "www",
    url: (isFacility ? facAutoUrl : autoUrl)?.value?.trim() || "",
    index: (isFacility ? facAutoIndex : autoIndex)?.value || "1",
    text: (isFacility ? facAutoText : autoText)?.value?.trim() || "",
    midSelector: (isFacility ? facMidSelector : midSelector)?.value?.trim() || "",
    mSelector: (isFacility ? facModalSelector : modalSelector)?.value?.trim() || "",
    mText: (isFacility ? facModalText : modalText)?.value?.trim() || "",
    delayMs,
  };
}

async function startAutoRecFromUi({ source = "ui", site = "www" } = {}) {
  const isFacility = site === "facility";
  const payload = buildRecPayload(site);
  appendProgressLog(
    `자동 클릭 시작 — ${isFacility ? "구단" : "기본"} (순서 ${payload.index})`,
    "info",
    source
  );
  if (isFacility) {
    void chrome.storage.local.set({
      [FAC_REC_FIELDS_KEY]: {
        url: payload.url,
        index: payload.index,
        text: payload.text,
        midSelector: payload.midSelector,
        mSelector: payload.mSelector,
        mText: payload.mText,
        delayMs: payload.delayMs,
      },
    });
  }
  const result = await chrome.runtime.sendMessage(payload);
  if (result?.ok) {
    if (isFacility) setFacRecUi(true);
    else setWwwRecUi(true);
    appendProgressLog(`${isFacility ? "구단" : "기본"} · 예매 버튼을 기다리는 중`, "ok", source);
    return { ok: true };
  }
  const err = result?.error || "Rec 시작 실패";
  const statusEl = isFacility ? facAutoStatus : autoStatus;
  if (statusEl) {
    statusEl.textContent = err;
    statusEl.className = "status error";
  }
  appendProgressLog(err, "error", source);
  return { ok: false, error: err };
}

async function stopAutoRecFromUi({ source = "ui", site = "www" } = {}) {
  const isFacility = site === "facility";
  appendProgressLog(`자동 클릭 중지 — ${isFacility ? "구단" : "기본"}`, "info", source);
  const result = await chrome.runtime.sendMessage({
    type: "STOP_AUTO_REC",
    site: isFacility ? "facility" : "www",
  });
  if (result?.ok) {
    if (isFacility) setFacRecUi(false);
    else setWwwRecUi(false);
  }
}

autoClickBtn?.addEventListener("click", () => {
  if (wwwRecArmed) void stopAutoRecFromUi({ site: "www" });
  else void startAutoRecFromUi({ site: "www" });
});

facAutoClickBtn?.addEventListener("click", () => {
  if (facRecArmed) void stopAutoRecFromUi({ site: "facility" });
  else void startAutoRecFromUi({ site: "facility" });
});

chrome.storage.local.get(FAC_REC_FIELDS_KEY).then((data) => {
  const f = data[FAC_REC_FIELDS_KEY];
  if (!f) return;
  if (facAutoUrl && f.url != null) facAutoUrl.value = String(f.url);
  if (facAutoIndex && f.index != null) facAutoIndex.value = String(f.index);
  if (facAutoText && f.text != null) facAutoText.value = String(f.text);
  if (facMidSelector && f.midSelector != null) facMidSelector.value = String(f.midSelector);
  if (facModalSelector && f.mSelector != null) facModalSelector.value = String(f.mSelector);
  if (facModalText && f.mText != null) facModalText.value = String(f.mText);
  if (facModalDelay && f.delayMs != null) facModalDelay.value = String(f.delayMs);
}).catch(() => {});

function clampInt(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function readSchedParts() {
  return {
    hh: clampInt(schedHh?.value, 0, 23, 0),
    mm: clampInt(schedMm?.value, 0, 59, 0),
    ss: clampInt(schedSs?.value, 0, 59, 0),
    ms: clampInt(schedMs?.value, 0, 999, 0),
  };
}

function syncSchedInputs() {
  const p = readSchedParts();
  if (schedHh) schedHh.value = String(p.hh);
  if (schedMm) schedMm.value = String(p.mm);
  if (schedSs) schedSs.value = String(p.ss);
  if (schedMs) schedMs.value = String(p.ms);
  return p;
}

function formatSchedLabel(p) {
  return `${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}.${pad(p.ms, 3)}`;
}

function setSchedRecStatus(text, level = "") {
  if (schedRecStatus) {
    schedRecStatus.textContent = text;
    schedRecStatus.className = level ? `status ${level}` : "status";
  }
  if (schedRecState) {
    schedRecState.textContent = scheduleRecArmed ? "Armed" : "Idle";
    schedRecState.classList.toggle("on", scheduleRecArmed);
  }
  if (schedRecArmBtn) {
    schedRecArmBtn.textContent = scheduleRecArmed ? "예약중" : "예약";
    schedRecArmBtn.classList.toggle("is-on", !scheduleRecArmed);
  }
}

async function armScheduleRec() {
  const parts = syncSchedInputs();
  const site = schedRecSite?.value === "facility" ? "facility" : "www";
  const recPayload = buildRecPayload(site);
  void chrome.storage.local.set({ [SCHED_REC_KEY]: { ...parts, site } });
  const result = await chrome.runtime.sendMessage({
    type: "ARM_SCHED_REC",
    parts,
    site,
    recPayload,
  });
  if (!result?.ok) {
    setSchedRecStatus(result?.error || "예약 실패", "error");
    scheduleRecArmed = false;
    return;
  }
  scheduleRecArmed = true;
  scheduleRecTargetMs = result.targetMs ?? null;
  const siteLabelText = site === "facility" ? "구단" : "기본";
  setSchedRecStatus(`예약 대기 → ${formatSchedLabel(parts)} · ${siteLabelText}`, "ok");
  appendProgressLog(`예약 설정 · ${formatSchedLabel(parts)} · ${siteLabelText}`, "ok", "sched");
}

function disarmScheduleRec() {
  scheduleRecArmed = false;
  scheduleRecTargetMs = null;
  void chrome.runtime.sendMessage({ type: "DISARM_SCHED_REC" }).catch(() => {});
  setSchedRecStatus("예약 해제됨", "");
}

schedRecArmBtn?.addEventListener("click", () => void armScheduleRec());
schedRecClearBtn?.addEventListener("click", () => {
  disarmScheduleRec();
  appendProgressLog("예약 해제", "info", "sched");
});

for (const el of [schedHh, schedMm, schedSs, schedMs, schedRecSite]) {
  el?.addEventListener("change", () => {
    const parts = syncSchedInputs();
    void chrome.storage.local.set({
      [SCHED_REC_KEY]: {
        ...parts,
        site: schedRecSite?.value === "facility" ? "facility" : "www",
      },
    });
    if (scheduleRecArmed) void armScheduleRec();
  });
}

chrome.storage.local.get(SCHED_REC_KEY).then((data) => {
  const p = data[SCHED_REC_KEY];
  if (!p) return;
  if (schedHh && p.hh != null) schedHh.value = String(clampInt(p.hh, 0, 23, 0));
  if (schedMm && p.mm != null) schedMm.value = String(clampInt(p.mm, 0, 59, 0));
  if (schedSs && p.ss != null) schedSs.value = String(clampInt(p.ss, 0, 59, 0));
  if (schedMs && p.ms != null) schedMs.value = String(clampInt(p.ms, 0, 999, 0));
  if (schedRecSite && p.site) schedRecSite.value = p.site === "facility" ? "facility" : "www";
}).catch(() => {});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "PROGRESS_LOG") {
    appendProgressLog(message.text, message.level || "info", message.source || "bg");
  }
  if (message?.type === "SERVER_SYNC_STATE") {
    if (message.offsetMs != null) {
      offsetMs = message.offsetMs;
      startClock();
    }
    if (rttValue && message.rttMs != null) rttValue.textContent = `RTT ${message.rttMs} ms`;
    if (message.running) {
      running = true;
      if (startBtn) startBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = false;
      if (urlInput) urlInput.disabled = true;
      if (message.ok !== false && message.serverDate) {
        setStatus(`연결됨 · 서버 시간 맞춤 중`, "ok");
      }
    } else if (message.stopped) {
      running = false;
      if (startBtn) startBtn.disabled = false;
      if (stopBtn) stopBtn.disabled = true;
      if (urlInput) urlInput.disabled = false;
    }
    if (message.ok === false && message.error) setStatus(message.error, "error");
  }
  if (message?.type === "SCHED_REC_STATE") {
    scheduleRecArmed = Boolean(message.armed);
    scheduleRecTargetMs = message.targetMs ?? null;
    if (message.fired) {
      setSchedRecStatus(`발화! ${message.label || ""} → Rec`, "ok");
    } else if (scheduleRecArmed) {
      setSchedRecStatus("예약 대기 중", "ok");
    } else if (message.disarmed) {
      setSchedRecStatus("예약 해제됨", "");
    } else {
      setSchedRecStatus(schedRecStatus?.textContent || "Start 후 예약", "");
    }
  }
  if (message?.type === "AUTO_REC_STATE") {
    if (message.site === "facility") setFacRecUi(Boolean(message.armed));
    else setWwwRecUi(Boolean(message.armed));
  }
});

chrome.runtime.sendMessage({ type: "GET_SERVER_SYNC_STATE" }).then((st) => {
  if (!st?.ok) return;
  if (st.url && urlInput && !urlInput.value) urlInput.value = st.url;
  // running일 때만 시계·버튼 상태를 Sync 중으로 맞춤 (자동 재개 없음)
  if (st.running) {
    if (st.offsetMs != null) {
      offsetMs = st.offsetMs;
      if (rttValue && st.rttMs != null) rttValue.textContent = `RTT ${st.rttMs} ms`;
      startClock();
    }
    running = true;
    if (startBtn) startBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = false;
    if (urlInput) urlInput.disabled = true;
    setStatus(`서버 시간 맞춤 중`, "ok");
  } else if (st.url) {
    setStatus("URL 저장됨 — Start 버튼을 누르세요", "");
  }
}).catch(() => {});

chrome.runtime.sendMessage({ type: "GET_SCHED_REC_STATE" }).then((st) => {
  if (!st?.ok) return;
  scheduleRecArmed = Boolean(st.armed);
  scheduleRecTargetMs = st.targetMs ?? null;
  if (st.site && schedRecSite) schedRecSite.value = st.site === "facility" ? "facility" : "www";
  if (st.parts) {
    if (schedHh && st.parts.hh != null) schedHh.value = String(st.parts.hh);
    if (schedMm && st.parts.mm != null) schedMm.value = String(st.parts.mm);
    if (schedSs && st.parts.ss != null) schedSs.value = String(st.parts.ss);
    if (schedMs && st.parts.ms != null) schedMs.value = String(st.parts.ms);
  }
  if (scheduleRecArmed && st.parts) {
    setSchedRecStatus(
      `예약 대기 → ${formatSchedLabel(st.parts)} · ${st.site === "facility" ? "구단" : "기본"}`,
      "ok"
    );
  }
}).catch(() => {});

chrome.runtime.sendMessage({ type: "GET_AUTO_REC_STATE" }).then((result) => {
  if (!result?.ok) return;
  setWwwRecUi(Boolean(result.www?.armed ?? result.armed));
  setFacRecUi(Boolean(result.facility?.armed));
}).catch(() => {});

// 오픈예정 → 예매하기 교체
// ==========================================
const expBtnScanBtn = document.getElementById("exp-btn-scan-btn");
const expBtnPick = document.getElementById("exp-btn-pick");
const expActivateBtn = document.getElementById("exp-activate-btn");
const expActivateClearBtn = document.getElementById("exp-activate-clear-btn");
const expUpgradeProductId = document.getElementById("exp-upgrade-product-id");
const expUpgradeScheduleId = document.getElementById("exp-upgrade-schedule-id");
const expActivateStatus = document.getElementById("exp-activate-status");
const expActivateState = document.getElementById("exp-activate-state");

let expScannedButtons = [];

function setExpActivateStatus(text, level = "") {
  if (expActivateStatus) {
    expActivateStatus.textContent = text;
    expActivateStatus.className = level ? `status ${level}` : "status";
  }
  if (expActivateState) {
    expActivateState.textContent = level === "ok" ? "교체됨" : "—";
    expActivateState.classList.toggle("on", level === "ok");
  }
}

async function sendExpToTab(payload) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error("활성 탭 없음 — ticketlink 탭 클릭");
  try {
    return await chrome.tabs.sendMessage(tab.id, payload);
  } catch {
    throw new Error("교체 content 미연결 — 페이지 새로고침 하세요");
  }
}

function fillExpBtnPick(buttons, selectedIndex = "") {
  expScannedButtons = Array.isArray(buttons) ? buttons : [];
  if (!expBtnPick) return;
  expBtnPick.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = expScannedButtons.length
    ? `버튼 ${expScannedButtons.length}개 — 바꿀 번호 선택`
    : "목록 스캔 후 선택";
  expBtnPick.appendChild(ph);
  for (const b of expScannedButtons) {
    const opt = document.createElement("option");
    opt.value = String(b.index);
    const sid = b.scheduleId ? ` sid=${b.scheduleId}` : "";
    opt.textContent = `#${b.index} ${b.kind || ""} · ${(b.text || "").slice(0, 36)}${sid}`;
    expBtnPick.appendChild(opt);
  }
  if (selectedIndex) expBtnPick.value = String(selectedIndex);
}

async function scanExpButtons() {
  try {
    const result = await sendExpToTab({ type: "EXP_LIST_BUTTON_STATES" });
    if (!result?.ok) throw new Error(result?.error || "스캔 실패");
    const buttons = result.buttons || [];
    fillExpBtnPick(buttons, expBtnPick?.value || "");
    setExpActivateStatus(
      buttons.length
        ? buttons.map((b) => `#${b.index}[${b.looksInactive ? "비활성" : "활성"}]`).join(" · ")
        : "예매 슬롯 없음",
      buttons.length ? "ok" : "error"
    );
    appendProgressLog(`버튼목록 ${buttons.length}개`, "ok", "ui");
  } catch (error) {
    setExpActivateStatus(error.message, "error");
    appendProgressLog(`버튼목록 실패: ${error.message}`, "error", "ui");
  }
}

function applyExpBtnPick(indexValue) {
  const idx = String(indexValue || "").trim();
  if (!idx) return;
  if (expBtnPick && expBtnPick.value !== idx) expBtnPick.value = idx;
  const row = expScannedButtons.find((b) => String(b.index) === idx);
  if (row) {
    if (expUpgradeScheduleId && row.scheduleId) expUpgradeScheduleId.value = row.scheduleId;
    if (expUpgradeProductId && row.productId) expUpgradeProductId.value = row.productId;
    setExpActivateStatus(
      `#${row.index} 선택 · ${row.kind} · ${(row.text || "").slice(0, 40)}`,
      row.looksInactive ? "ok" : ""
    );
  }
}

async function upgradeExpButton() {
  try {
    const index = expBtnPick?.value || "";
    const productId = expUpgradeProductId?.value?.trim() || "";
    const scheduleId = expUpgradeScheduleId?.value?.trim() || "";
    if (!index) throw new Error("목록에서 버튼 번호를 선택하세요");
    if (!productId || !scheduleId) throw new Error("productId / scheduleId를 입력하세요");

    const result = await sendExpToTab({
      type: "EXP_UPGRADE_TO_RESERVE",
      index,
      productId,
      scheduleId,
    });
    if (!result?.ok) throw new Error(result?.error || "교체 실패");
    setExpActivateStatus(
      `#${result.index} 교체됨 · "${(result.before || "").slice(0, 24)}" → 예매하기 · sid=${result.scheduleId}`,
      "ok"
    );
    appendProgressLog(
      `오픈예정→예매하기 교체 #${result.index} sid=${result.scheduleId} pid=${result.productId}`,
      "ok",
      "ui"
    );
  } catch (error) {
    setExpActivateStatus(error.message, "error");
    appendProgressLog(`교체 실패: ${error.message}`, "error", "ui");
  }
}

async function clearExpActivate() {
  try {
    await sendExpToTab({ type: "EXP_CLEAR_FORCE_ACTIVATE" });
    setExpActivateStatus("해제됨 — 원래 오픈예정으로 복구", "");
    appendProgressLog("예매하기 교체 해제", "info", "ui");
  } catch (error) {
    setExpActivateStatus(error.message, "error");
  }
}

expBtnScanBtn?.addEventListener("click", () => void scanExpButtons());
expActivateBtn?.addEventListener("click", () => void upgradeExpButton());
expActivateClearBtn?.addEventListener("click", () => void clearExpActivate());
expBtnPick?.addEventListener("change", () => {
  if (expBtnPick.value) applyExpBtnPick(expBtnPick.value);
});

// ==========================================
// 구단(facility) 목록 / 오픈예정→예매하기 교체
// ==========================================
const facBtnScanBtn = document.getElementById("fac-btn-scan-btn");
const facBtnPick = document.getElementById("fac-btn-pick");
const facActivateBtn = document.getElementById("fac-activate-btn");
const facActivateClearBtn = document.getElementById("fac-activate-clear-btn");
const facUpgradeProductId = document.getElementById("fac-upgrade-product-id");
const facUpgradeScheduleId = document.getElementById("fac-upgrade-schedule-id");
const facActivateStatus = document.getElementById("fac-activate-status");
const facActivateState = document.getElementById("fac-activate-state");

let facScannedButtons = [];

function setFacActivateStatus(text, level = "") {
  if (facActivateStatus) {
    facActivateStatus.textContent = text;
    facActivateStatus.className = level ? `status ${level}` : "status";
  }
  if (facActivateState) {
    facActivateState.textContent = level === "ok" ? "교체됨" : "—";
    facActivateState.classList.toggle("on", level === "ok");
  }
}

function fillFacBtnPick(buttons, selectedIndex = "") {
  facScannedButtons = Array.isArray(buttons) ? buttons : [];
  if (!facBtnPick) return;
  facBtnPick.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = facScannedButtons.length
    ? `구단 ${facScannedButtons.length}행 — 바꿀 번호 선택`
    : "구단 목록 스캔 후 선택";
  facBtnPick.appendChild(ph);
  for (const b of facScannedButtons) {
    const opt = document.createElement("option");
    opt.value = String(b.index);
    const sid = b.scheduleId ? ` sid=${b.scheduleId}` : "";
    opt.textContent = `#${b.index} ${b.kind || ""} · ${(b.text || "").slice(0, 36)}${sid}`;
    facBtnPick.appendChild(opt);
  }
  if (selectedIndex) facBtnPick.value = String(selectedIndex);
}

async function scanFacButtons() {
  try {
    const result = await sendExpToTab({ type: "EXP_LIST_FACILITY_BUTTON_STATES" });
    if (!result?.ok) throw new Error(result?.error || "구단 스캔 실패");
    const buttons = result.buttons || [];
    fillFacBtnPick(buttons, facBtnPick?.value || "");
    if (facAutoIndex && buttons.length && !facAutoIndex.value) {
      facAutoIndex.value = "1";
    }
    setFacActivateStatus(
      buttons.length
        ? buttons.map((b) => `#${b.index}[${b.looksInactive ? "비활성" : "활성"}]`).join(" · ")
        : "구단 테이블 행 없음 — facility 페이지인지 확인",
      buttons.length ? "ok" : "error"
    );
    appendProgressLog(`구단 목록 ${buttons.length}행`, buttons.length ? "ok" : "warn", "ui");
  } catch (error) {
    setFacActivateStatus(error.message, "error");
    appendProgressLog(`구단 목록 실패: ${error.message}`, "error", "ui");
  }
}

function applyFacBtnPick(indexValue) {
  const idx = String(indexValue || "").trim();
  if (!idx) return;
  if (facBtnPick && facBtnPick.value !== idx) facBtnPick.value = idx;
  if (facAutoIndex) facAutoIndex.value = idx;
  const row = facScannedButtons.find((b) => String(b.index) === idx);
  if (row) {
    if (facUpgradeScheduleId && row.scheduleId) facUpgradeScheduleId.value = row.scheduleId;
    if (facUpgradeProductId && row.productId) facUpgradeProductId.value = row.productId;
    setFacActivateStatus(
      `#${row.index} 선택 · ${row.kind} · ${(row.text || "").slice(0, 40)}`,
      row.looksInactive ? "ok" : ""
    );
  }
}

async function upgradeFacButton() {
  try {
    const index = facBtnPick?.value || facAutoIndex?.value || "";
    const productId = facUpgradeProductId?.value?.trim() || "";
    const scheduleId = facUpgradeScheduleId?.value?.trim() || "";
    if (!index) throw new Error("구단 목록에서 행 번호를 선택하세요");
    if (!productId || !scheduleId) throw new Error("productId / scheduleId를 입력하세요");

    const result = await sendExpToTab({
      type: "EXP_UPGRADE_FACILITY_TO_RESERVE",
      index,
      productId,
      scheduleId,
    });
    if (!result?.ok) throw new Error(result?.error || "구단 교체 실패");
    setFacActivateStatus(
      `#${result.index} 교체됨 · "${(result.before || "").slice(0, 24)}" → 예매하기 · sid=${result.scheduleId}`,
      "ok"
    );
    appendProgressLog(
      `구단 교체 #${result.index} sid=${result.scheduleId} pid=${result.productId}`,
      "ok",
      "ui"
    );
  } catch (error) {
    setFacActivateStatus(error.message, "error");
    appendProgressLog(`구단 교체 실패: ${error.message}`, "error", "ui");
  }
}

async function clearFacActivate() {
  try {
    await sendExpToTab({ type: "EXP_CLEAR_FORCE_ACTIVATE" });
    setFacActivateStatus("해제됨 — 원래 상태로 복구", "");
    appendProgressLog("구단 예매하기 교체 해제", "info", "ui");
  } catch (error) {
    setFacActivateStatus(error.message, "error");
  }
}

facBtnScanBtn?.addEventListener("click", () => void scanFacButtons());
facActivateBtn?.addEventListener("click", () => void upgradeFacButton());
facActivateClearBtn?.addEventListener("click", () => void clearFacActivate());
facBtnPick?.addEventListener("change", () => {
  if (facBtnPick.value) applyFacBtnPick(facBtnPick.value);
});

// —— 기본 / 구단 / Decode 탭 (MV3: 인라인 script 불가 → 여기로) ——
(function initSegTabs() {
  const tabs = document.querySelectorAll(".seg-tab");
  const panels = document.querySelectorAll(".tab-panel");
  if (!tabs.length || !panels.length) return;

  function activate(name) {
    tabs.forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    panels.forEach((p) => {
      const on = p.dataset.panel === name;
      p.classList.toggle("is-active", on);
      p.hidden = !on;
    });
  }

  tabs.forEach((t) => {
    t.addEventListener("click", () => activate(t.dataset.tab));
  });
  window.__postlabActivateTab = activate;
})();
