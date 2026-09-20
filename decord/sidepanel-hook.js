import { decodePayload } from "./decoder.js";
import { loadRows, mergeSchedules } from "./schedule_table.js";
import { loadFileHandle, syncToLinkedFile } from "./file_store.js";

const bodyEl = document.getElementById("decord-body");
const statusEl = document.getElementById("decord-status");
const countEl = document.getElementById("decord-count");
const btnDecode = document.getElementById("decord-decode-btn");
const btnOpenTable = document.getElementById("decord-open-table-btn");
const btnClear = document.getElementById("decord-clear-btn");

const expProduct = document.getElementById("exp-upgrade-product-id");
const expSchedule = document.getElementById("exp-upgrade-schedule-id");
const expStatus = document.getElementById("exp-activate-status");
const expState = document.getElementById("exp-activate-state");
const facProduct = document.getElementById("fac-upgrade-product-id");
const facSchedule = document.getElementById("fac-upgrade-schedule-id");
const facStatus = document.getElementById("fac-activate-status");
const facState = document.getElementById("fac-activate-state");

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}

async function refreshCount() {
  const rows = await loadRows();
  if (countEl) countEl.textContent = `${rows.length}`;
}

async function syncAfterChange() {
  try {
    const handle = await loadFileHandle();
    if (handle) await syncToLinkedFile(handle);
  } catch {
    /* ignore */
  }
}

function openDetailsFor(target) {
  const name = target === "facility" ? "facility" : "www";
  if (typeof window.__postlabActivateTab === "function") {
    window.__postlabActivateTab(name);
  }
}

function applyFill(msg) {
  if (!msg) return;
  const target = msg.target;
  const pid = String(msg.productId || "");
  const sid = String(msg.scheduleId || "");
  const label = msg.matchLabel || `${pid}/${sid}`;

  if (target === "facility") {
    if (facProduct) facProduct.value = pid;
    if (facSchedule) facSchedule.value = sid;
    if (facStatus) {
      facStatus.textContent = `DECORD 등록 · ${label} · PID ${pid} / SID ${sid}`;
      facStatus.className = "status ok";
    }
    if (facState) {
      facState.textContent = "등록";
      facState.classList.add("on");
    }
    openDetailsFor("facility");
    setStatus(`구단 · JS에 등록 · ${label}`);
  } else {
    if (expProduct) expProduct.value = pid;
    if (expSchedule) expSchedule.value = sid;
    if (expStatus) {
      expStatus.textContent = `DECORD 등록 · ${label} · PID ${pid} / SID ${sid}`;
      expStatus.className = "status ok";
    }
    if (expState) {
      expState.textContent = "등록";
      expState.classList.add("on");
    }
    openDetailsFor("www");
    setStatus(`기본 · JS에 등록 · ${label}`);
  }
}

function applyClear(msg) {
  if (!msg) return;
  const target = msg.target;

  if (target === "facility") {
    if (facProduct) facProduct.value = "";
    if (facSchedule) facSchedule.value = "";
    if (facStatus) {
      facStatus.textContent = "목록 → 행 선택 → ID → 교체";
      facStatus.className = "status";
    }
    if (facState) {
      facState.textContent = "—";
      facState.classList.remove("on");
    }
    setStatus("구단 · JS 등록 해제");
  } else {
    if (expProduct) expProduct.value = "";
    if (expSchedule) expSchedule.value = "";
    if (expStatus) {
      expStatus.textContent = "목록 → 선택 → ID → 교체";
      expStatus.className = "status";
    }
    if (expState) {
      expState.textContent = "—";
      expState.classList.remove("on");
    }
    setStatus("기본 · JS 등록 해제");
  }
}

btnDecode?.addEventListener("click", async () => {
  const body = (bodyEl?.value || "").trim();
  if (!body) {
    setStatus("Body를 붙여넣으세요.");
    return;
  }
  btnDecode.disabled = true;
  setStatus("디코딩 중...");
  try {
    const result = await decodePayload(body, {
      autoFetch: true,
      onLog: (m) => setStatus(m),
    });
    if (!result.json) throw new Error("JSON 결과가 없습니다.");
    const merged = await mergeSchedules(result.json);
    await refreshCount();
    await syncAfterChange();
    setStatus(
      `완료 · 새 ${merged.added} / 중복 ${merged.skipped} / 총 ${merged.total}`
    );
  } catch (e) {
    setStatus(`실패: ${e.message || e}`);
  } finally {
    btnDecode.disabled = false;
  }
});

btnOpenTable?.addEventListener("click", async () => {
  const url = chrome.runtime.getURL("decord/table.html");
  try {
    const existing = await chrome.runtime.sendMessage({
      type: "DECORD_FOCUS_TABLE",
      url,
    });
    if (existing?.ok) return;
  } catch {
    /* ignore */
  }
  try {
    await chrome.windows.create({
      url,
      type: "popup",
      width: 900,
      height: 600,
      focused: true,
    });
  } catch (e) {
    setStatus(`표 창 열기 실패: ${e.message || e}`);
  }
});

btnClear?.addEventListener("click", () => {
  if (bodyEl) bodyEl.value = "";
  setStatus("입력 지움");
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "DECORD_FILL_IDS") applyFill(msg);
  if (msg?.type === "DECORD_CLEAR_IDS") applyClear(msg);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.scheduleTable) refreshCount();
  if (area === "local" && changes.decordFillRequest?.newValue) {
    applyFill(changes.decordFillRequest.newValue);
  }
});

refreshCount();

chrome.storage.local.get(["decordFillRequest"]).then((data) => {
  if (data.decordFillRequest) applyFill(data.decordFillRequest);
});
