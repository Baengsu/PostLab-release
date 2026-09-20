/**
 * 고정 CSV 파일 핸들 저장/읽기
 * 파일명: decord_schedules.csv (항상 같은 이름 · 덮어쓰기)
 */

import { rowsToCsv, csvToRows, mergeTableRows, loadRows, saveRows } from "./schedule_table.js";

export const FIXED_CSV_NAME = "decord_schedules.csv";

const IDB_NAME = "decord-files";
const IDB_STORE = "handles";
const META_KEY = "decordFileMeta";

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveFileHandle(handle) {
  const db = await openIdb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(handle, "csv");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  await chrome.storage.local.set({
    [META_KEY]: { name: handle.name, updatedAt: Date.now() },
  });
}

export async function loadFileHandle() {
  try {
    const db = await openIdb();
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get("csv");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle || null;
  } catch {
    return null;
  }
}

export async function getFileMeta() {
  const data = await chrome.storage.local.get([META_KEY]);
  return data[META_KEY] || null;
}

async function ensurePermission(handle, mode = "readwrite") {
  if (!handle) return false;
  let ok = await handle.queryPermission({ mode });
  if (ok !== "granted") ok = await handle.requestPermission({ mode });
  return ok === "granted";
}

export async function writeFixedCsv(handle, rows) {
  if (!(await ensurePermission(handle, "readwrite"))) {
    throw new Error("파일 쓰기 권한이 없습니다.");
  }
  const writable = await handle.createWritable();
  await writable.write(rowsToCsv(rows));
  await writable.close();
  await chrome.storage.local.set({
    [META_KEY]: { name: handle.name, updatedAt: Date.now() },
  });
}

export async function readCsvFromHandle(handle) {
  if (!(await ensurePermission(handle, "read"))) {
    throw new Error("파일 읽기 권한이 없습니다.");
  }
  const file = await handle.getFile();
  const text = await file.text();
  return csvToRows(text);
}

/** 저장 위치 지정 (고정 파일명 · 덮어쓰기) */
export async function pickSaveLocation() {
  const handle = await showSaveFilePicker({
    suggestedName: FIXED_CSV_NAME,
    types: [{ description: "DECORD CSV", accept: { "text/csv": [".csv"] } }],
  });
  await saveFileHandle(handle);
  const rows = await loadRows();
  await writeFixedCsv(handle, rows);
  return handle;
}

/** 기존 파일 불러오기 → 표에 병합 + 그 파일을 저장 위치로 연결 */
export async function pickAndImportFile() {
  const [handle] = await showOpenFilePicker({
    multiple: false,
    types: [{ description: "DECORD CSV", accept: { "text/csv": [".csv"] } }],
  });
  const incoming = await readCsvFromHandle(handle);
  const merged = await mergeTableRows(incoming);
  await saveFileHandle(handle);
  // 연결 파일에 현재 전체 표 덮어쓰기(동기화)
  try {
    await writeFixedCsv(handle, merged.rows);
  } catch {
    /* 읽기 전용으로 골랐을 수 있음 */
  }
  return { handle, ...merged };
}

/** 연결된 파일 자동 로드 (시작 시) */
export async function autoLoadLinkedFile(handle) {
  if (!handle) return { ok: false, reason: "no-handle" };
  try {
    const incoming = await readCsvFromHandle(handle);
    // 파일 내용을 기준으로 맞추되, storage에만 있고 파일에 없는 것도 유지하려면 merge
    // 새 PC: storage 비어 있음 → 파일 전체가 들어옴
    // 기존: merge로 SID 중복 스킵
    const merged = await mergeTableRows(incoming);
    return { ok: true, ...merged, name: handle.name };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
}

export async function syncToLinkedFile(handle) {
  if (!handle) return { ok: false };
  const rows = await loadRows();
  await writeFixedCsv(handle, rows);
  return { ok: true, name: handle.name, total: rows.length };
}
