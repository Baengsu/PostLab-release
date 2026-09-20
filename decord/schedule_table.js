/**
 * 경기 표 저장소 (chrome.storage.local)
 * 중복 키: scheduleId — 있으면 스킵, 새 것만 추가
 */

const STORAGE_KEY = "scheduleTable";
const META_KEY = "scheduleMeta";

/** 표용 짧은 팀명: KIA/LG 고정, 나머지 앞 2글자 */
function shortTeamName(name) {
  const s = String(name || "").trim();
  if (!s) return "";
  if (/^KIA/i.test(s)) return "KIA";
  if (/^LG/i.test(s)) return "LG";
  return [...s].slice(0, 2).join("");
}

function toKoreaTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return "";

  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(n))) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  let hour = parts.hour || "00";
  if (hour === "24") hour = "00";
  // 연도·초 제외 → 09-08 17:00
  return `${parts.month}-${parts.day} ${hour}:${parts.minute}`;
}

/** 예전 저장값에서 연도/초만 제거 (분은 유지) */
function normalizeTimeLabel(s) {
  let t = String(s || "").trim();
  t = t.replace(/^\d{4}-/, ""); // 2026-
  t = t.replace(/(\d{2}:\d{2}):\d{2}$/, "$1"); // HH:MM:SS → HH:MM
  return t;
}

function todayKoreaLabel() {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(new Date())) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  const week = { Sun: "일", Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토" };
  const w = week[parts.weekday] || parts.weekday;
  return `${parts.year}-${parts.month}-${parts.day} (${w})`;
}

function rowFromSchedule(s) {
  const scheduleMs = Number(s?.scheduleDate) || 0;
  const reserveMs = Number(s?.reserveOpenDate) || 0;
  return {
    scheduleId: s?.scheduleId ?? "",
    productId: s?.productId ?? "",
    홈팀: shortTeamName(s?.homeTeam?.teamName || ""),
    어웨이팀: shortTeamName(s?.awayTeam?.teamName || ""),
    예매시간: toKoreaTime(reserveMs),
    경기시간: toKoreaTime(scheduleMs),
    scheduleMs,
    reserveMs,
  };
}

function extractSchedules(decoded) {
  return (
    decoded?.data?.schedules ||
    decoded?.schedules ||
    (Array.isArray(decoded) ? decoded : null)
  );
}

function sortNearToday(rows) {
  const now = Date.now();
  return [...rows].sort((a, b) => {
    const da = Math.abs((a.scheduleMs || 0) - now);
    const db = Math.abs((b.scheduleMs || 0) - now);
    if (da !== db) return da - db;
    return (a.scheduleMs || 0) - (b.scheduleMs || 0);
  });
}

async function loadRows() {
  const data = await chrome.storage.local.get([STORAGE_KEY]);
  const rows = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  for (const r of rows) {
    r.홈팀 = shortTeamName(r.홈팀);
    r.어웨이팀 = shortTeamName(r.어웨이팀);
    r.예매시간 = normalizeTimeLabel(r.예매시간);
    r.경기시간 = normalizeTimeLabel(r.경기시간);
  }
  return sortNearToday(rows);
}

async function saveRows(rows) {
  const sorted = sortNearToday(rows);
  await chrome.storage.local.set({
    [STORAGE_KEY]: sorted,
    [META_KEY]: { updatedAt: Date.now() },
  });
  return sorted;
}

/** 새 경기만 추가. scheduleId 중복은 건너뜀. */
async function mergeSchedules(decoded) {
  const schedules = extractSchedules(decoded);
  if (!Array.isArray(schedules)) {
    throw new Error("schedules 배열을 찾을 수 없습니다.");
  }

  const current = await loadRows();
  const existing = new Set(current.map((r) => String(r.scheduleId)));
  let added = 0;
  let skipped = 0;

  for (const s of schedules) {
    const row = rowFromSchedule(s);
    const id = String(row.scheduleId);
    if (!id || existing.has(id)) {
      skipped += 1;
      continue;
    }
    existing.add(id);
    current.push(row);
    added += 1;
  }

  const saved = await saveRows(current);
  return { rows: saved, added, skipped, total: saved.length };
}

async function deleteByScheduleId(scheduleId) {
  const id = String(scheduleId);
  const current = await loadRows();
  const next = current.filter((r) => String(r.scheduleId) !== id);
  return saveRows(next);
}

async function clearAll() {
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
  return [];
}

/** CSV (엑셀에서 바로 열림, UTF-8 BOM) */
function rowsToCsv(rows) {
  const headers = ["홈팀", "어웨이팀", "예매시간", "경기시간", "productId", "scheduleId"];
  const esc = (v) => {
    const s = String(v ?? "");
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(",")];
  for (const r of sortNearToday(rows)) {
    lines.push(
      [r.홈팀, r.어웨이팀, r.예매시간, r.경기시간, r.productId, r.scheduleId]
        .map(esc)
        .join(",")
    );
  }
  return "\uFEFF" + lines.join("\r\n");
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQ = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** CSV 텍스트 → 표 행 (기존 파일 불러오기용) */
function csvToRows(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const idx = (name) => headers.indexOf(name);

  const iHome = idx("홈팀");
  const iAway = idx("어웨이팀");
  const iReserve = idx("예매시간");
  const iSched = idx("경기시간");
  const iPid = idx("productId");
  const iSid = idx("scheduleId");

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const sid = String(cols[iSid] ?? "").trim();
    if (!sid) continue;
    const reserveLabel = normalizeTimeLabel(cols[iReserve] ?? "");
    const schedLabel = normalizeTimeLabel(cols[iSched] ?? "");
    rows.push({
      scheduleId: sid,
      productId: String(cols[iPid] ?? "").trim(),
      홈팀: shortTeamName(cols[iHome] ?? ""),
      어웨이팀: shortTeamName(cols[iAway] ?? ""),
      예매시간: reserveLabel,
      경기시간: schedLabel,
      scheduleMs: 0,
      reserveMs: 0,
    });
  }
  return rows;
}

/** CSV/다른 표 행을 현재 표에 병합 (SID 중복 스킵) */
async function mergeTableRows(incoming) {
  const current = await loadRows();
  const existing = new Set(current.map((r) => String(r.scheduleId)));
  let added = 0;
  let skipped = 0;
  for (const row of incoming || []) {
    const id = String(row.scheduleId ?? "").trim();
    if (!id || existing.has(id)) {
      skipped += 1;
      continue;
    }
    existing.add(id);
    current.push({
      ...row,
      홈팀: shortTeamName(row.홈팀),
      어웨이팀: shortTeamName(row.어웨이팀),
      예매시간: normalizeTimeLabel(row.예매시간),
      경기시간: normalizeTimeLabel(row.경기시간),
    });
    added += 1;
  }
  const saved = await saveRows(current);
  return { rows: saved, added, skipped, total: saved.length };
}

export {
  toKoreaTime,
  normalizeTimeLabel,
  shortTeamName,
  todayKoreaLabel,
  rowFromSchedule,
  sortNearToday,
  loadRows,
  saveRows,
  mergeSchedules,
  mergeTableRows,
  deleteByScheduleId,
  clearAll,
  rowsToCsv,
  csvToRows,
};
