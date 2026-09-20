/**
 * content.js — Auto Click Rec only (OCR / 스캔 / 디버그 없음)
 */

const AUTO_REC_ARMED_KEY = "autoRecArmed";
const AUTO_REC_CONFIG_KEY = "autoRecConfig";
const FAC_AUTO_REC_ARMED_KEY = "facilityAutoRecArmed";
const FAC_AUTO_REC_CONFIG_KEY = "facilityAutoRecConfig";

const recChannels = {
  www: { armed: false, config: null, running: false, observer: null, pollTimer: null, label: "기본" },
  facility: {
    armed: false,
    config: null,
    running: false,
    observer: null,
    pollTimer: null,
    label: "구단",
  },
};

function progressLog(text, level = "info") {
  chrome.runtime.sendMessage({ type: "PROGRESS_LOG", text, level, source: "content" }).catch(() => {});
}

function simulateHumanClick(element) {
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    element.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        buttons: type.includes("down") ? 1 : 0,
      })
    );
  }
}

function mainButtonSelector(index) {
  return `div#reservation > div.reserve_lst_bx:nth-of-type(2) > ul > li:nth-of-type(${index}) > div.match_btn:nth-of-type(3) > a.common_btn.btn_primary`;
}

function facilityButtonSelector(index) {
  return `div#scheduleListDiv > table > tbody > tr:nth-of-type(${index}) > td:nth-of-type(4) > a.btn.btn_reserve`;
}

function findMainButton(config) {
  const index = Number(config?.index) || 1;
  const site = String(config?.site || "www").trim() || "www";
  let btn = null;

  if (site === "facility") {
    const rows = document.querySelectorAll("#scheduleListDiv table tbody tr, #scheduleListDiv table tr");
    const row = rows[index - 1];
    // 교체된 오픈예정 버튼 우선
    btn =
      row?.querySelector("a.__sts_exp_forced_active") ||
      document.querySelector(facilityButtonSelector(index)) ||
      row?.querySelector("a.btn.btn_reserve:not(.btn_reserve_scdl)") ||
      [...(row?.querySelectorAll("a.btn.btn_reserve, a.btn_reserve") || [])].find(
        (a) => !a.classList.contains("btn_reserve_scdl")
      ) ||
      null;
  } else {
    const lis = document.querySelectorAll("#reservation ul > li, #reservation li");
    const li = lis[index - 1];
    btn =
      li?.querySelector("a.__sts_exp_forced_active") ||
      document.querySelector(mainButtonSelector(index)) ||
      li?.querySelector("a.common_btn.btn_primary, a.btn_reserve") ||
      null;
  }

  if (!btn) return null;
  // 교체 버튼은 텍스트가 예매하기로 바뀌어 있음 — 강제 허용
  if (btn.classList.contains("__sts_exp_forced_active")) return btn;
  const want = String(config?.text || "").trim();
  if (want && !btn.innerText.includes(want)) return null;
  return btn;
}

async function runClickSequence(config) {
  const index = Number(config?.index) || 1;
  const btnText = String(config?.text || "").trim();
  const midSelector = String(config?.midSelector || "").trim();
  const mSelector = String(config?.mSelector || "").trim();
  const mText = String(config?.mText || "").trim();
  const delayMs = Math.max(0, Number(config?.delayMs) || 0);
  const site = String(config?.site || "www").trim() || "www";

  progressLog(`[1단계] 버튼 탐색 (site=${site}, index=${index})`, "info");
  const btn1 = findMainButton(config);
  if (!btn1) {
    progressLog(`[1단계] 메인 버튼 없음 (${site})`, "error");
    return { ok: false, error: `1단계: 메인 버튼을 찾을 수 없습니다. (${site})` };
  }
  if (btnText && !btn1.classList.contains("__sts_exp_forced_active") && !btn1.innerText.includes(btnText)) {
    return { ok: false, error: `1단계: 텍스트 불일치 (현재: ${btn1.innerText})` };
  }

  const isForced = btn1.classList.contains("__sts_exp_forced_active");
  simulateHumanClick(btn1);
  progressLog(isForced ? "[1단계] 교체버튼 클릭 → MAIN 진입 위임" : "[1단계] 클릭 완료", "ok");

  // 교체 버튼은 content-exp가 MAIN world 진입을 처리 — 잠시 대기 후 모달 시퀀스 계속
  if (isForced) {
    await new Promise((r) => setTimeout(r, 0));
  }
  if (delayMs > 0) {
    progressLog(`[대기] ${delayMs}ms`, "info");
    await new Promise((r) => setTimeout(r, delayMs));
  }

  if (midSelector) {
    progressLog(`[1.5단계] ${midSelector}`, "info");
    let midFound = false;
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const midBtn = document.querySelector(midSelector);
      if (midBtn) {
        simulateHumanClick(midBtn);
        midFound = true;
        progressLog(`[1.5단계] 클릭 완료`, "ok");
        break;
      }
    }
    if (!midFound) {
      return { ok: false, error: "1.5단계: 공지 요소를 찾지 못했습니다." };
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (mSelector) {
    progressLog(`[2단계] ${mSelector}`, "info");
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      for (const mBtn of document.querySelectorAll(mSelector)) {
        if (!mText || mBtn.innerText.includes(mText)) {
          simulateHumanClick(mBtn);
          progressLog("[2단계] 클릭 완료", "ok");
          return { ok: true, msg: `클릭 시퀀스 성공 (대기 ${delayMs}ms)` };
        }
      }
    }
    return { ok: false, error: "2단계: 확인 버튼을 찾지 못했습니다." };
  }

  return { ok: true, msg: "클릭 시퀀스 완료" };
}

function stopAutoRecWatch(site = "www") {
  const ch = recChannels[site] || recChannels.www;
  ch.observer?.disconnect();
  ch.observer = null;
  if (ch.pollTimer) {
    clearInterval(ch.pollTimer);
    ch.pollTimer = null;
  }
}

function tryAutoRecClick(site = "www") {
  const ch = recChannels[site] || recChannels.www;
  if (!ch.armed || ch.running || !ch.config) return false;
  const cfg = { ...ch.config, site };
  if (!findMainButton(cfg)) return false;

  ch.running = true;
  progressLog(`[${ch.label}] 타겟 포착 — 클릭 시작`, "ok");
  void runClickSequence(cfg)
    .then((result) => {
      if (result?.ok) {
        progressLog(`[${ch.label}] ${result.msg || "성공"}`, "ok");
        chrome.runtime
          .sendMessage({ type: "AUTO_REC_RESULT", ok: true, msg: result.msg, site })
          .catch(() => {});
      } else {
        progressLog(`[${ch.label}] ${result?.error || "실패"}`, "error");
        chrome.runtime
          .sendMessage({
            type: "AUTO_REC_RESULT",
            ok: false,
            error: result?.error || "실패",
            site,
          })
          .catch(() => {});
        ch.running = false;
      }
    })
    .catch((error) => {
      progressLog(`[${ch.label}] 예외: ${error.message}`, "error");
      ch.running = false;
    });
  return true;
}

function startAutoRecWatch(site = "www", { resetRunning = true } = {}) {
  const ch = recChannels[site] || recChannels.www;
  if (!ch.armed || !ch.config) {
    stopAutoRecWatch(site);
    return;
  }
  if (ch.observer || ch.pollTimer || ch.running) {
    if (!ch.running) tryAutoRecClick(site);
    return;
  }
  if (resetRunning) ch.running = false;

  progressLog(
    `[${ch.label}] Rec ON — 감시 (index=${ch.config.index || 1})`,
    "info"
  );
  if (tryAutoRecClick(site)) return;

  ch.observer = new MutationObserver(() => tryAutoRecClick(site));
  ch.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
  });
  ch.pollTimer = setInterval(() => {
    if (!ch.armed || ch.running) {
      if (!ch.armed) stopAutoRecWatch(site);
      return;
    }
    tryAutoRecClick(site);
  }, 250);
}

function syncRecFromStorage(data) {
  let wwwConfig = data[AUTO_REC_CONFIG_KEY] || null;
  if (wwwConfig) wwwConfig = { ...wwwConfig, site: "www" };
  let facConfig = data[FAC_AUTO_REC_CONFIG_KEY] || null;
  if (facConfig) facConfig = { ...facConfig, site: "facility" };

  recChannels.www.armed = Boolean(data[AUTO_REC_ARMED_KEY]);
  recChannels.www.config = wwwConfig;
  recChannels.facility.armed = Boolean(data[FAC_AUTO_REC_ARMED_KEY]);
  recChannels.facility.config = facConfig;
}

async function loadSettings() {
  const data = await chrome.storage.local.get([
    AUTO_REC_ARMED_KEY,
    AUTO_REC_CONFIG_KEY,
    FAC_AUTO_REC_ARMED_KEY,
    FAC_AUTO_REC_CONFIG_KEY,
  ]);
  syncRecFromStorage(data);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  const wwwChanged =
    Boolean(changes[AUTO_REC_ARMED_KEY]) || Boolean(changes[AUTO_REC_CONFIG_KEY]);
  const facChanged =
    Boolean(changes[FAC_AUTO_REC_ARMED_KEY]) || Boolean(changes[FAC_AUTO_REC_CONFIG_KEY]);

  if (wwwChanged) {
    if (changes[AUTO_REC_ARMED_KEY]) {
      recChannels.www.armed = Boolean(changes[AUTO_REC_ARMED_KEY].newValue);
    }
    if (changes[AUTO_REC_CONFIG_KEY]) {
      const cfg = changes[AUTO_REC_CONFIG_KEY].newValue || null;
      recChannels.www.config = cfg ? { ...cfg, site: "www" } : null;
    }
    if (recChannels.www.armed) {
      stopAutoRecWatch("www");
      startAutoRecWatch("www", { resetRunning: true });
    } else {
      stopAutoRecWatch("www");
      recChannels.www.running = false;
      progressLog("[기본] 자동 클릭을 멈췄습니다", "info");
    }
  }

  if (facChanged) {
    if (changes[FAC_AUTO_REC_ARMED_KEY]) {
      recChannels.facility.armed = Boolean(changes[FAC_AUTO_REC_ARMED_KEY].newValue);
    }
    if (changes[FAC_AUTO_REC_CONFIG_KEY]) {
      const cfg = changes[FAC_AUTO_REC_CONFIG_KEY].newValue || null;
      recChannels.facility.config = cfg ? { ...cfg, site: "facility" } : null;
    }
    if (recChannels.facility.armed) {
      stopAutoRecWatch("facility");
      startAutoRecWatch("facility", { resetRunning: true });
    } else {
      stopAutoRecWatch("facility");
      recChannels.facility.running = false;
      progressLog("[구단] 자동 클릭을 멈췄습니다", "info");
    }
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "AUTO_REC_RESTART") {
    void loadSettings().then(() => {
      if (recChannels.www.armed) startAutoRecWatch("www");
      else stopAutoRecWatch("www");
      if (recChannels.facility.armed) startAutoRecWatch("facility");
      else stopAutoRecWatch("facility");
      sendResponse({
        ok: true,
        wwwArmed: recChannels.www.armed,
        facilityArmed: recChannels.facility.armed,
      });
    });
    return true;
  }
  return false;
});

progressLog("예매 페이지와 연결되었습니다");
loadSettings().then(() => {
  if (recChannels.www.armed) startAutoRecWatch("www");
  if (recChannels.facility.armed) startAutoRecWatch("facility");
});
