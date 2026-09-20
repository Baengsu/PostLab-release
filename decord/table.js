import {
  todayKoreaLabel,
  loadRows,
  deleteByScheduleId,
  clearAll,
} from "./schedule_table.js";
import {
  FIXED_CSV_NAME,
  loadFileHandle,
  getFileMeta,
  pickSaveLocation,
  pickAndImportFile,
  autoLoadLinkedFile,
  syncToLinkedFile,
} from "./file_store.js";

const ASSIGN_KEY = "decordAssignments";

const todayEl = document.getElementById("today-label");
const countEl = document.getElementById("count-label");
const tbody = document.getElementById("table-body");
const statusEl = document.getElementById("status");
const pathLabel = document.getElementById("file-path-label");
const btnSetPath = document.getElementById("btn-set-path");
const btnLoad = document.getElementById("btn-load");
const btnSaveNow = document.getElementById("btn-save-now");
const btnClearTable = document.getElementById("btn-clear-table");
const btnRefresh = document.getElementById("btn-refresh");

let rows = [];
/** @type {Record<string, { www?: boolean, facility?: boolean, label?: string }>} */
let assignments = {};
/** @type {FileSystemFileHandle | null} */
let linkedFileHandle = null;

function setStatus(msg) {
  statusEl.textContent = msg;
}

function escapeHtml(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function updatePathLabel() {
  if (linkedFileHandle?.name) {
    pathLabel.innerHTML = `연결됨: <strong>${escapeHtml(linkedFileHandle.name)}</strong> · 삭제/추가 시 자동 저장`;
  } else {
    pathLabel.innerHTML =
      `저장 위치: <strong>아직 없음</strong> — [저장 위치] 또는 [불러오기]로 <code>${FIXED_CSV_NAME}</code> 연결`;
  }
}

async function loadAssignments() {
  const data = await chrome.storage.local.get([ASSIGN_KEY]);
  assignments = data[ASSIGN_KEY] && typeof data[ASSIGN_KEY] === "object" ? data[ASSIGN_KEY] : {};
}

async function saveAssignment(sid, target, label) {
  const id = String(sid);
  // 기본/구단 각각 1개만 — 같은 target은 전부 해제 후 현재만 등록
  const next = {};
  for (const [key, val] of Object.entries(assignments)) {
    if (!val || typeof val !== "object") continue;
    const copy = { ...val };
    if (copy[target]) delete copy[target];
    // www/facility 둘 다 없으면 항목 제거
    if (copy.www || copy.facility) {
      next[key] = copy;
    }
  }
  const prev = next[id] || {};
  next[id] = {
    ...prev,
    [target]: true,
    label,
    at: Date.now(),
  };
  assignments = next;
  await chrome.storage.local.set({ [ASSIGN_KEY]: assignments });
}

/** 해당 행의 기본/구단 등록만 해제 (토글 OFF) */
async function clearAssignment(sid, target) {
  const id = String(sid);
  const next = { ...assignments };
  if (next[id] && typeof next[id] === "object") {
    const copy = { ...next[id] };
    delete copy[target];
    if (copy.www || copy.facility) next[id] = copy;
    else delete next[id];
  }
  assignments = next;
  await chrome.storage.local.set({ [ASSIGN_KEY]: assignments });
}

async function sendFill({ target, productId, scheduleId, matchLabel }) {
  const payload = {
    type: "DECORD_FILL_IDS",
    target,
    productId: String(productId ?? ""),
    scheduleId: String(scheduleId ?? ""),
    matchLabel: matchLabel || "",
    at: Date.now(),
  };
  await chrome.storage.local.set({ decordFillRequest: payload });
  chrome.runtime.sendMessage(payload).catch(() => {});
}

async function sendClear({ target }) {
  const payload = {
    type: "DECORD_CLEAR_IDS",
    target,
    at: Date.now(),
  };
  const data = await chrome.storage.local.get(["decordFillRequest"]);
  if (data.decordFillRequest?.target === target) {
    await chrome.storage.local.remove("decordFillRequest");
  }
  chrome.runtime.sendMessage(payload).catch(() => {});
}

function renderTable(list) {
  todayEl.textContent = todayKoreaLabel();
  countEl.textContent = `${list.length}경기`;
  tbody.innerHTML = "";

  if (!list.length) {
    tbody.innerHTML =
      '<tr class="empty"><td colspan="9">저장된 경기가 없습니다. [불러오기]로 기존 CSV를 추가할 수 있습니다.</td></tr>';
    return;
  }

  for (const r of list) {
    const sid = String(r.scheduleId ?? "");
    const pid = String(r.productId ?? "");
    const label = `${r.홈팀} vs ${r.어웨이팀}`;
    const a = assignments[sid] || {};
    const wwwOn = !!a.www;
    const facOn = !!a.facility;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td title="${escapeHtml(r.홈팀)}">${escapeHtml(r.홈팀)}</td>
      <td title="${escapeHtml(r.어웨이팀)}">${escapeHtml(r.어웨이팀)}</td>
      <td title="${escapeHtml(r.예매시간)}">${escapeHtml(r.예매시간)}</td>
      <td title="${escapeHtml(r.경기시간)}">${escapeHtml(r.경기시간)}</td>
      <td title="${escapeHtml(pid)}">${escapeHtml(pid)}</td>
      <td title="${escapeHtml(sid)}">${escapeHtml(sid)}</td>
      <td>
        <button type="button" class="btn-fill ${wwwOn ? "is-on" : ""}" data-act="www" data-sid="${escapeHtml(sid)}" data-pid="${escapeHtml(pid)}" data-label="${escapeHtml(label)}">기본</button>
        ${wwwOn ? '<span class="tag-reg">등록</span>' : ""}
      </td>
      <td>
        <button type="button" class="btn-fill ${facOn ? "is-on" : ""}" data-act="facility" data-sid="${escapeHtml(sid)}" data-pid="${escapeHtml(pid)}" data-label="${escapeHtml(label)}">구단</button>
        ${facOn ? '<span class="tag-reg">등록</span>' : ""}
      </td>
      <td><button type="button" class="btn-del" data-id="${escapeHtml(sid)}">삭제</button></td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll(".btn-fill").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const target = btn.getAttribute("data-act"); // www | facility
      const sid = btn.getAttribute("data-sid");
      const pid = btn.getAttribute("data-pid");
      const matchLabel = btn.getAttribute("data-label") || "";
      if (!sid || !pid) {
        setStatus("PID/SID가 비어 있습니다.");
        return;
      }
      const where = target === "facility" ? "구단 · JS" : "기본 · JS";
      const alreadyOn = !!assignments[sid]?.[target];

      // 이미 등록된 버튼을 다시 누르면 해제
      if (alreadyOn) {
        await clearAssignment(sid, target);
        await sendClear({ target });
        renderTable(rows);
        setStatus(`해제됨 → ${where} · ${matchLabel}`);
        return;
      }

      await sendFill({ target, productId: pid, scheduleId: sid, matchLabel });
      await saveAssignment(sid, target, matchLabel);
      renderTable(rows);
      setStatus(`등록됨 → ${where} · ${matchLabel} · PID ${pid} / SID ${sid}`);
    });
  });

  tbody.querySelectorAll(".btn-del").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      rows = await deleteByScheduleId(id);
      if (assignments[id]) {
        delete assignments[id];
        await chrome.storage.local.set({ [ASSIGN_KEY]: assignments });
      }
      renderTable(rows);
      await trySync();
      setStatus(`삭제됨 · ${id}`);
    });
  });
}

async function refresh() {
  await loadAssignments();
  rows = await loadRows();
  renderTable(rows);
}

async function trySync() {
  if (!linkedFileHandle) return;
  try {
    await syncToLinkedFile(linkedFileHandle);
  } catch (e) {
    setStatus(`파일 동기화 실패: ${e.message || e}`);
  }
}

btnSetPath.addEventListener("click", async () => {
  try {
    linkedFileHandle = await pickSaveLocation();
    updatePathLabel();
    await refresh();
    setStatus(`저장 위치 연결 · ${linkedFileHandle.name} (이후 자동 덮어쓰기)`);
  } catch (e) {
    if (e?.name === "AbortError") setStatus("저장 위치 지정 취소");
    else setStatus(`저장 위치 실패: ${e.message || e}`);
  }
});

btnLoad.addEventListener("click", async () => {
  try {
    const result = await pickAndImportFile();
    linkedFileHandle = result.handle;
    updatePathLabel();
    rows = result.rows;
    await loadAssignments();
    renderTable(rows);
    setStatus(
      `불러오기 완료 · 새 ${result.added} / 중복 ${result.skipped} / 총 ${result.total} · 파일: ${result.handle.name}`
    );
  } catch (e) {
    if (e?.name === "AbortError") setStatus("불러오기 취소");
    else setStatus(`불러오기 실패: ${e.message || e}`);
  }
});

btnSaveNow.addEventListener("click", async () => {
  if (!linkedFileHandle) {
    setStatus("CSV로 저장하려면 먼저 [저장 위치] 또는 [불러오기]로 파일을 연결하세요.");
    return;
  }
  try {
    await syncToLinkedFile(linkedFileHandle);
    setStatus(`저장 완료 · ${linkedFileHandle.name} 덮어씀`);
  } catch (e) {
    setStatus(`저장 실패: ${e.message || e}`);
  }
});

btnClearTable.addEventListener("click", async () => {
  if (!confirm("경기 표를 모두 비울까요?")) return;
  rows = await clearAll();
  assignments = {};
  await chrome.storage.local.set({ [ASSIGN_KEY]: {} });
  renderTable(rows);
  await trySync();
  setStatus("표를 비웠습니다.");
});

btnRefresh.addEventListener("click", async () => {
  await refresh();
  setStatus("새로고침 완료");
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.scheduleTable) refresh().then(() => trySync());
  if (changes[ASSIGN_KEY]) loadAssignments().then(() => renderTable(rows));
});

(async () => {
  linkedFileHandle = await loadFileHandle();
  updatePathLabel();
  await loadAssignments();

  if (linkedFileHandle) {
    const auto = await autoLoadLinkedFile(linkedFileHandle);
    if (auto.ok) {
      rows = auto.rows;
      renderTable(rows);
      setStatus(
        `자동 불러오기 · ${auto.name} · 새 ${auto.added} / 중복 ${auto.skipped} / 총 ${auto.total}`
      );
      return;
    }
    setStatus(`자동 불러오기 실패(권한 필요할 수 있음): ${auto.reason} · [불러오기]를 눌러주세요`);
  } else {
    const meta = await getFileMeta();
    if (meta?.name) {
      setStatus(`이전에 ${meta.name} 를 썼습니다. 새 PC면 [불러오기]로 다시 연결하세요.`);
    }
  }
  await refresh();
})();
