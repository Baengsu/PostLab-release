/**
 * NOL 사이드패널 — 기존 sidepanel.js Rec/Sched와 분리
 * 시각: yyyy/mm/dd/hh/mi/ss 셀렉트 → YYYY-MM-DD HH:mm:ss
 */
(function initNolPanel() {
  const NOL_FIELDS_KEY = "nolPanelFields";

  const yyyyEl = document.getElementById("nol-yyyy");
  const moEl = document.getElementById("nol-mo");
  const ddEl = document.getElementById("nol-dd");
  const hhEl = document.getElementById("nol-hh");
  const miEl = document.getElementById("nol-mi");
  const ssEl = document.getElementById("nol-ss");
  const warmupEl = document.getElementById("nol-warmup");
  const selectorEl = document.getElementById("nol-selector");
  const disabledEl = document.getElementById("nol-disabled-class");
  const armBtn = document.getElementById("nol-arm-btn");
  const clearBtn = document.getElementById("nol-clear-btn");
  const statusEl = document.getElementById("nol-status");
  const stateEl = document.getElementById("nol-state");

  if (!armBtn || !yyyyEl) return;

  let armed = false;

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function fillSelect(el, start, end, pad) {
    if (!el) return;
    const prev = el.value;
    el.innerHTML = "";
    for (let i = start; i <= end; i += 1) {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = pad ? pad2(i) : String(i);
      el.appendChild(opt);
    }
    if (prev && [...el.options].some((o) => o.value === prev)) el.value = prev;
  }

  function daysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
  }

  function refreshDayOptions() {
    const y = Number(yyyyEl.value) || new Date().getFullYear();
    const m = Number(moEl.value) || 1;
    const max = daysInMonth(y, m);
    const prev = Number(ddEl.value) || 1;
    fillSelect(ddEl, 1, max, true);
    ddEl.value = String(Math.min(prev, max));
  }

  function initSelects() {
    const now = new Date();
    const y0 = now.getFullYear();
    fillSelect(yyyyEl, y0 - 1, y0 + 2, false);
    fillSelect(moEl, 1, 12, true);
    fillSelect(hhEl, 0, 23, true);
    fillSelect(miEl, 0, 59, true);
    fillSelect(ssEl, 0, 59, true);

    yyyyEl.value = String(y0);
    moEl.value = String(now.getMonth() + 1);
    refreshDayOptions();
    ddEl.value = String(now.getDate());
    hhEl.value = "20";
    miEl.value = "0";
    ssEl.value = "0";
  }

  function buildTargetString() {
    const y = Number(yyyyEl.value);
    const m = Number(moEl.value);
    const d = Number(ddEl.value);
    const hh = Number(hhEl.value);
    const mi = Number(miEl.value);
    const ss = Number(ssEl.value);
    if (![y, m, d, hh, mi, ss].every((n) => Number.isFinite(n))) return "";
    return `${y}-${pad2(m)}-${pad2(d)} ${pad2(hh)}:${pad2(mi)}:${pad2(ss)}`;
  }

  function applyTargetString(raw) {
    const s = String(raw || "").trim();
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})$/);
    if (!m) return;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const dd = Number(m[3]);
    const hh = Number(m[4]);
    const mi = Number(m[5]);
    const ss = Number(m[6]);
    if (y < Number(yyyyEl.options[0]?.value) || y > Number(yyyyEl.options[yyyyEl.options.length - 1]?.value)) {
      fillSelect(yyyyEl, Math.min(y, Number(yyyyEl.options[0]?.value) || y), Math.max(y, Number(yyyyEl.options[yyyyEl.options.length - 1]?.value) || y), false);
    }
    yyyyEl.value = String(y);
    moEl.value = String(mo);
    refreshDayOptions();
    ddEl.value = String(Math.min(dd, daysInMonth(y, mo)));
    hhEl.value = String(hh);
    miEl.value = String(mi);
    ssEl.value = String(ss);
  }

  function setStatus(text, level = "") {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = level ? `status ${level}` : "status";
  }

  function setArmedUi(on) {
    armed = Boolean(on);
    if (stateEl) {
      stateEl.textContent = armed ? "Armed" : "Idle";
      stateEl.classList.toggle("on", armed);
    }
    if (armBtn) {
      armBtn.textContent = armed ? "예약중" : "● NOL 예약";
      armBtn.classList.toggle("is-on", armed);
    }
  }

  function readConfig() {
    return {
      targetString: buildTargetString(),
      warmupMs: Math.max(0, Number(warmupEl?.value) || 2000),
      selector: String(selectorEl?.value || "div.buttons > button").trim(),
      disabledClass: String(disabledEl?.value || "").trim(),
    };
  }

  function applyConfig(cfg) {
    if (!cfg) return;
    if (cfg.targetString != null) applyTargetString(cfg.targetString);
    if (warmupEl && cfg.warmupMs != null) warmupEl.value = String(cfg.warmupMs);
    if (selectorEl && cfg.selector != null) selectorEl.value = String(cfg.selector);
    if (disabledEl && cfg.disabledClass != null) disabledEl.value = String(cfg.disabledClass);
  }

  function persistFields() {
    const cfg = readConfig();
    void chrome.storage.local.set({ [NOL_FIELDS_KEY]: cfg });
  }

  async function armNol() {
    const config = readConfig();
    if (!config.targetString) {
      setStatus("오픈 시각을 선택하세요", "error");
      return;
    }
    persistFields();
    try {
      const result = await chrome.runtime.sendMessage({ type: "NOL_ARM", ...config });
      if (!result?.ok) {
        setStatus(result?.error || "예약 실패", "error");
        setArmedUi(false);
        return;
      }
      setArmedUi(true);
      const tabs = result.tabCount ?? 0;
      setStatus(
        tabs > 0
          ? `예약됨 · ${config.targetString} · 탭 ${tabs}개`
          : `예약됨 · ${config.targetString} · interpark 페이지를 열어 두세요`,
        tabs > 0 ? "ok" : "warn"
      );
    } catch (err) {
      setStatus(err.message || "예약 실패", "error");
      setArmedUi(false);
    }
  }

  async function disarmNol() {
    persistFields();
    try {
      await chrome.runtime.sendMessage({ type: "NOL_DISARM" });
    } catch {
      /* ignore */
    }
    setArmedUi(false);
    setStatus("예약 해제됨", "");
  }

  initSelects();

  armBtn.addEventListener("click", () => {
    if (armed) void disarmNol();
    else void armNol();
  });
  clearBtn?.addEventListener("click", () => void disarmNol());

  yyyyEl.addEventListener("change", () => {
    refreshDayOptions();
    persistFields();
  });
  moEl.addEventListener("change", () => {
    refreshDayOptions();
    persistFields();
  });

  for (const el of [ddEl, hhEl, miEl, ssEl, warmupEl, selectorEl, disabledEl]) {
    el?.addEventListener("change", persistFields);
    el?.addEventListener("blur", persistFields);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "NOL_STATE") return;
    setArmedUi(Boolean(message.armed));
    if (message.config) applyConfig(message.config);
    if (message.armed) setStatus("예약 대기 중 (서버 시계)", "ok");
    else if (message.armed === false) setStatus("예약 해제됨", "");
  });

  chrome.storage.local.get([NOL_FIELDS_KEY]).then((data) => {
    applyConfig(data[NOL_FIELDS_KEY]);
  });

  chrome.runtime
    .sendMessage({ type: "NOL_GET_STATE" })
    .then((st) => {
      if (!st?.ok) return;
      setArmedUi(Boolean(st.armed));
      if (st.config) applyConfig(st.config);
      if (st.armed) setStatus("예약 대기 중 (서버 시계)", "ok");
    })
    .catch(() => {});
})();
