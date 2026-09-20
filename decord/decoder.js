/**
 * 커스텀 Base64 + URI 디코드
 * Body = encodeURIComponent(JSON) → 커스텀 Base64
 */

const KNOWN_ALPHABETS = [
  "vUTaEsQjcHKzDmPNuwM5JxdlS0CgZFiqeOG6yfnX8VAhk239WtI4b1BrR7pLYo+/=",
  "b5pMtgV0ijLeqAX2cv8SlhUN7k3nTQwOHaxJyRFBz9EPKZrmufoWds4D6IGCY1+/=",
  "DfvAoe9p51y6WTjtLYBdub027lhEXcqOHiVC3rxgFzs4nkKIGRmQM8JUaSPZwN+/=",
  "fTH1xzA9aGUElQnZpt0457SFhPijVmsCYgR3DB6cK2oqwOeJkMNbL8XyWuvrId+/=",
  "CrkGy3MAR7IDFumUj2cth59fanOdlx4zBXsESwoKLJe8bqg0V1QvZWYHT6ipPN+/=",
  "ZkHqWugQ1YzM4Gc5KVIo970XFTJC8SjitL63smPANxbdaBwEflhypevrOnD2RU+/=",
];

const ALPHABET_RE = /['"]([A-Za-z0-9+/]{64}=)['"]/g;

function extractAlphabets(text) {
  const found = [];
  let m;
  const re = new RegExp(ALPHABET_RE);
  while ((m = re.exec(text || "")) !== null) {
    const a = m[1];
    if (a.includes("+") && a.includes("/") && a.endsWith("=") && !found.includes(a)) {
      found.push(a);
    }
  }
  return found;
}

function customBase64ToBinary(encoded, alphabet) {
  const cleaned = String(encoded).replace(/[^A-Za-z0-9+/=]/g, "").trim();
  if (!cleaned) throw new Error("인코딩된 문자열이 비어 있습니다.");
  if (!alphabet || alphabet.length < 64) throw new Error("알파벳이 올바르지 않습니다.");

  let raw = "";
  let i = 0;
  while (i < cleaned.length) {
    const a = alphabet.indexOf(cleaned.charAt(i++));
    const b = alphabet.indexOf(cleaned.charAt(i++));
    let c = alphabet.indexOf(cleaned.charAt(i++));
    let d = alphabet.indexOf(cleaned.charAt(i++));

    if (a < 0 || b < 0) throw new Error("알파벳에 없는 문자");
    if (c < 0) c = 64;
    if (d < 0) d = 64;

    raw += String.fromCharCode((a << 2) | (b >> 4));
    if (c !== 64) raw += String.fromCharCode(((b & 0xf) << 4) | (c >> 2));
    if (d !== 64) raw += String.fromCharCode(((c & 0x3) << 6) | d);
  }
  return raw;
}

function scoreCandidate(text) {
  let sc = 0;
  const s = text.trimStart();
  if (s.startsWith("{") || s.startsWith("[")) sc += 50;
  if (text.includes('"data"')) sc += 20;
  if (text.includes("couponCount") || text.includes("schedules")) sc += 40;
  try {
    JSON.parse(text);
    sc += 200;
  } catch (_) {}
  return sc;
}

function decodeWithAlphabet(encoded, alphabet) {
  const binary = customBase64ToBinary(encoded, alphabet);
  return decodeURIComponent(binary);
}

async function loadCachedAlphabets() {
  try {
    const data = await chrome.storage.local.get(["alphabets"]);
    const list = data.alphabets;
    return Array.isArray(list) ? list.filter((a) => typeof a === "string" && a.length >= 64) : [];
  } catch (_) {
    return [];
  }
}

async function rememberAlphabet(alphabet) {
  if (!alphabet) return;
  const prev = await loadCachedAlphabets();
  const merged = [alphabet, ...prev, ...KNOWN_ALPHABETS].filter(
    (a, i, arr) => a && arr.indexOf(a) === i
  );
  await chrome.storage.local.set({ alphabets: merged.slice(0, 20) });
}

async function fetchLiveAlphabets(onLog) {
  const pages = [
    "https://www.ticketlink.co.kr/",
    "https://www.ticketlink.co.kr/sports/baseball",
  ];
  const found = [];

  for (const page of pages) {
    onLog?.(`페이지 확인: ${page}`);
    let html;
    try {
      const res = await fetch(page);
      html = await res.text();
    } catch (e) {
      onLog?.(`페이지 실패: ${e.message}`);
      continue;
    }

    for (const a of extractAlphabets(html)) {
      if (!found.includes(a)) found.push(a);
    }

    const srcs = [];
    const srcRe = /src=["']([^"']+)["']/g;
    let m;
    while ((m = srcRe.exec(html)) !== null) {
      if (m[1].toLowerCase().includes("evfw")) srcs.push(m[1]);
    }
    const evRe = /\?evfw=[A-Za-z0-9_-]+/g;
    while ((m = evRe.exec(html)) !== null) {
      srcs.push("https://www.ticketlink.co.kr/" + m[0].replace(/^\//, ""));
    }

    for (let src of srcs) {
      let url;
      if (src.startsWith("/")) url = "https://www.ticketlink.co.kr" + src;
      else if (src.startsWith("http")) url = src;
      else if (src.startsWith("?")) url = "https://www.ticketlink.co.kr/" + src;
      else url = "https://www.ticketlink.co.kr/" + src;

      try {
        onLog?.(`evfw 다운로드: ${url.slice(0, 80)}`);
        const js = await (await fetch(url)).text();
        for (const a of extractAlphabets(js)) {
          if (!found.includes(a)) {
            found.push(a);
            onLog?.(`알파벳 발견: ${a.slice(0, 20)}...`);
          }
        }
      } catch (e) {
        onLog?.(`evfw 실패: ${e.message}`);
      }
    }

    if (found.length) break;
  }

  if (found.length) {
    const prev = await loadCachedAlphabets();
    const merged = [...found, ...prev, ...KNOWN_ALPHABETS].filter(
      (a, i, arr) => a && arr.indexOf(a) === i
    );
    await chrome.storage.local.set({ alphabets: merged.slice(0, 20) });
  }
  return found;
}

async function decodePayload(encoded, { autoFetch = true, onLog } = {}) {
  const body = String(encoded || "").trim();
  if (!body) throw new Error("인코딩된 내용이 비어 있습니다.");

  const alphabets = [];
  for (const a of [...(await loadCachedAlphabets()), ...KNOWN_ALPHABETS]) {
    if (a && !alphabets.includes(a)) alphabets.push(a);
  }

  let best = null;

  const tryList = (list) => {
    for (const alph of list) {
      try {
        const text = decodeWithAlphabet(body, alph);
        const sc = scoreCandidate(text);
        let parsed = null;
        try {
          if (sc >= 50) parsed = JSON.parse(text);
        } catch (_) {}
        if (parsed !== null) {
          return { text, json: parsed, detail: "커스텀 Base64 + URI 디코드", alphabet: alph };
        }
        if (!best || sc > best.sc) best = { sc, text, alphabet: alph };
      } catch (_) {}
    }
    return null;
  };

  let hit = tryList(alphabets);
  if (hit) {
    await rememberAlphabet(hit.alphabet);
    return hit;
  }

  if (autoFetch) {
    onLog?.("캐시 실패 → 티켓링크에서 evfw 알파벳 가져오는 중...");
    const live = await fetchLiveAlphabets(onLog);
    if (live.length) {
      hit = tryList(live);
      if (hit) {
        hit.detail += " (라이브 evfw)";
        await rememberAlphabet(hit.alphabet);
        return hit;
      }
    }
  }

  if (best && best.sc >= 50 && (best.text.trimStart().startsWith("{") || best.text.trimStart().startsWith("["))) {
    let parsed = null;
    try {
      parsed = JSON.parse(best.text);
    } catch (_) {}
    await rememberAlphabet(best.alphabet);
    return {
      text: best.text,
      json: parsed,
      detail: "커스텀 Base64 + URI 디코드 (JSON 추정)",
      alphabet: best.alphabet,
    };
  }

  throw new Error(
    "디코딩 실패. 티켓링크에 접속 가능한지 확인하거나, 인코딩 Body가 맞는지 확인해 주세요."
  );
}

export {
  decodePayload,
  extractAlphabets,
  loadCachedAlphabets,
  rememberAlphabet,
  fetchLiveAlphabets,
  KNOWN_ALPHABETS,
};
