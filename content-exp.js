// content-exp.js — 오픈예정 → 예매하기 교체 (www / 구단)
(() => {
  if (window.__stsExpRecLoaded) return;
  window.__stsExpRecLoaded = true;

  function progressLog(text, level = "info") {
    chrome.runtime.sendMessage({ type: "PROGRESS_LOG", text, level, source: "exp" }).catch(() => {});
  }

  function getReserveListItems() {
    const primary = [
      ...document.querySelectorAll("div#reservation > div.reserve_lst_bx:nth-of-type(2) > ul > li"),
    ];
    if (primary.length) return primary;
    return [...document.querySelectorAll("#reservation ul li")].filter((li) =>
      li.querySelector(".match_btn, a.common_btn, a.btn_reserve")
    );
  }

  function getMatchBtnSlot(li) {
    if (!li) return null;
    return (
      li.querySelector("div.match_btn:nth-of-type(3)") ||
      [...li.querySelectorAll("div.match_btn")].slice(-1)[0] ||
      li
    );
  }

  function getFiber(node) {
    let el = node;
    while (el) {
      try {
        const keys = Reflect.ownKeys(el);
        for (const k of keys) {
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

  function fiberDiag(node) {
    if (!node) return "node=null";
    const own = Object.getOwnPropertyNames(node).filter((k) => k.includes("react")).slice(0, 5);
    const fiber = getFiber(node);
    return `tag=${node.tagName || "?"} reactKeys=${own.join("|") || "-"} fiber=${Boolean(fiber)}`;
  }

  function pickIdsFromProps(props) {
    if (!props || typeof props !== "object") return null;
    const bag = [props, props.schedule, props.item, props.data, props.game, props.match, props.product];
    for (const obj of bag) {
      if (!obj || typeof obj !== "object") continue;
      const scheduleId = obj.scheduleId ?? obj.schedule_id;
      const productId = obj.productId ?? obj.product_id;
      if (scheduleId != null || productId != null) {
        return {
          scheduleId: scheduleId != null ? String(scheduleId) : "",
          productId: productId != null ? String(productId) : "",
        };
      }
    }
    return null;
  }

  function extractIdsFromNode(node) {
    let fiber = getFiber(node);
    for (let i = 0; i < 16 && fiber; i += 1, fiber = fiber.return) {
      const ids = pickIdsFromProps(fiber.memoizedProps);
      if (ids && (ids.scheduleId || ids.productId)) return ids;
    }
    return { scheduleId: "", productId: "" };
  }

  function fnSrc(fn) {
    try {
      return Function.prototype.toString.call(fn);
    } catch {
      return "";
    }
  }

  /** 활성 예매하기 샘플에서 V 후보 / onReserve 계열 찾기 */
  function findEntryFnsNear(node) {
    const found = { V: null, onReserve: null, onClick: null };
    let fiber = getFiber(node);
    for (let d = 0; d < 20 && fiber; d += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== "object") continue;
      for (const [k, v] of Object.entries(props)) {
        if (typeof v !== "function") continue;
        const src = fnSrc(v);
        if (!found.onClick && k === "onClick") found.onClick = v;
        if (!found.onReserve && (/onReserve|reserve/i.test(k) || /예매|onReserve/i.test(src.slice(0, 240)))) {
          found.onReserve = v;
        }
        if (!found.V && /\bV\s*\(/.test(src) && /scheduleId/.test(src) && /productId/.test(src)) {
          found.V = v;
        }
      }
    }
    return found;
  }

  function findGlobalV() {
    const keys = ["V", "v", "openReserve", "goReserve", "startReserve"];
    for (const k of keys) {
      try {
        if (typeof window[k] === "function") return window[k];
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  function getReactRoots() {
    const roots = [];
    const hosts = [document.getElementById("app"), document.body, document.documentElement].filter(Boolean);
    for (const host of hosts) {
      for (const key of Object.keys(host)) {
        if (key.startsWith("__reactContainer$") || key.startsWith("__reactFiber$")) {
          const v = host[key];
          roots.push(v?.stateNode?.current || v?.current || v);
        }
      }
    }
    return roots.filter(Boolean);
  }

  function walkAllFibers(visit) {
    const seen = new Set();
    const stack = [...getReactRoots()];
    while (stack.length) {
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      try {
        visit(fiber);
      } catch {
        /* ignore */
      }
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
  }

  function discoverEntryCandidates() {
    const cands = [];
    walkAllFibers((fiber) => {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== "object") return;
      for (const [k, v] of Object.entries(props)) {
        if (typeof v !== "function") continue;
        const src = fnSrc(v);
        if (!/scheduleId/i.test(src) || !/productId/i.test(src)) continue;
        let score = 0;
        if (/\bV\s*\(/.test(src)) score += 10;
        if (/window\.open|\.open\s*\(/.test(src)) score += 6;
        if (/onClose|onReserve|onClick/i.test(k)) score += 3;
        if (src.length < 400) score += 2;
        cands.push({ fn: v, key: k, src: src.slice(0, 180), score });
      }
    });
    cands.sort((a, b) => b.score - a.score);
    return cands;
  }

  function writeIdsIntoObject(obj, sid, pid, depth = 0, seen = new Set()) {
    if (!obj || typeof obj !== "object" || depth > 5) return 0;
    if (seen.has(obj)) return 0;
    seen.add(obj);
    let hits = 0;
    const hasSid = "scheduleId" in obj || "schedule_id" in obj;
    const hasPid = "productId" in obj || "product_id" in obj;
    if (hasSid) {
      if ("scheduleId" in obj) obj.scheduleId = sid;
      if ("schedule_id" in obj) obj.schedule_id = sid;
      hits += 1;
    }
    if (hasPid && pid) {
      if ("productId" in obj) obj.productId = pid;
      if ("product_id" in obj) obj.product_id = pid;
      hits += 1;
    }
    for (const key of ["schedule", "item", "data", "game", "match", "product", "info", "row", "value"]) {
      if (obj[key] && typeof obj[key] === "object") {
        hits += writeIdsIntoObject(obj[key], sid, pid, depth + 1, seen);
      }
    }
    return hits;
  }

  /** 같은 객체 참조(클로저의 _)를 직접 고쳐 속 내용을 바꿈 */
  function mutateIdsInFiberTree(node, sid, pid) {
    let hits = 0;
    let fiber = getFiber(node);
    for (let i = 0; i < 22 && fiber; i += 1, fiber = fiber.return) {
      hits += writeIdsIntoObject(fiber.memoizedProps, sid, pid);
      hits += writeIdsIntoObject(fiber.pendingProps, sid, pid);
      let st = fiber.memoizedState;
      for (let j = 0; j < 40 && st; j += 1, st = st.next) {
        hits += writeIdsIntoObject(st.memoizedState, sid, pid);
        hits += writeIdsIntoObject(st.baseState, sid, pid);
      }
    }
    // 기존 키가 없으면(오픈예정 행) props 자체/중첩에 강제 기입
    if (hits === 0 && node) {
      fiber = getFiber(node);
      for (let i = 0; i < 12 && fiber; i += 1, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (!props || typeof props !== "object") continue;
        try {
          props.scheduleId = sid;
          props.productId = pid;
          for (const key of ["schedule", "item", "data", "game", "match"]) {
            if (props[key] && typeof props[key] === "object") {
              props[key].scheduleId = sid;
              props[key].productId = pid;
              hits += 1;
            }
          }
          hits += 1;
          break;
        } catch {
          /* next */
        }
      }
    }
    return hits;
  }

  function fakeClickEvent(target) {
    return {
      type: "click",
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      target,
      currentTarget: target,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
      stopImmediatePropagation() {},
      nativeEvent: { isTrusted: true },
      isTrusted: true,
    };
  }

  async function tryInvokeReserve(scheduleId, productId, sampleBtn, targetLi, extra = {}) {
    const sid = String(scheduleId);
    const pid = String(productId);
    const site = extra.site || (document.getElementById("scheduleListDiv") ? "facility" : "www");
    const notes = [];
    const rowIndex = Number(extra.rowIndex) || 0;

    if (sampleBtn) notes.push(`sampleDiag=${fiberDiag(sampleBtn)}`);
    if (targetLi) notes.push(`targetDiag=${fiberDiag(targetLi)}`);

    let onclickTpl = String(extra.onclickTpl || "");
    let hrefTpl = String(extra.hrefTpl || "");
    if (!onclickTpl && sampleBtn) {
      onclickTpl = sampleBtn.getAttribute?.("onclick") || "";
      hrefTpl = hrefTpl || sampleBtn.getAttribute?.("href") || "";
    }
    if (!onclickTpl && site === "facility") {
      const real = document.querySelector(
        "#scheduleListDiv a.btn.btn_reserve:not(.btn_reserve_scdl):not(.__sts_exp_forced_active)"
      );
      const scdl = document.querySelector("#scheduleListDiv a.btn.btn_reserve_scdl");
      onclickTpl = real?.getAttribute("onclick") || scdl?.getAttribute("onclick") || "";
      hrefTpl = hrefTpl || real?.getAttribute("href") || "";
    }

    try {
      const main = await chrome.runtime.sendMessage({
        type: "EXP_INVOKE_RESERVE_MAIN",
        scheduleId: sid,
        productId: pid,
        site,
        onclickTpl,
        hrefTpl,
        rowIndex,
      });
      if (main?.ok) {
        return {
          ok: true,
          method: main.method || "MAIN",
          notes: `${notes.join(",")} | site=${site} | vue=${main.vueKind || "-"} vueHits=${main.vueHits ?? "?"} ref=${main.hasSchedulesRef} sampleHits=${main.samplePatchHits ?? "?"} listPatch=${main.listPatchHits ?? "?"} ${Array.isArray(main.probeNotes) ? main.probeNotes.join(" ") : ""}`,
        };
      }
      notes.push(
        `mainFail=${main?.error || "?"};fiber=${main?.fiberOk};sample=${main?.hasSample};method=${main?.method || "-"};vue=${main?.vueKind};vueHits=${main?.vueHits ?? "?"};ref=${main?.hasSchedulesRef};sampleHits=${main?.samplePatchHits ?? "?"};listPatch=${main?.listPatchHits ?? "?"}`
      );
    } catch (error) {
      notes.push(`mainEx=${error.message}`);
    }

    // isolated fallback (www React 전용 — facility 는 MAIN classic 이 본체)
    const sampleOrig = sampleBtn ? extractIdsFromNode(sampleBtn) : { scheduleId: "", productId: "" };
    if (targetLi) notes.push(`targetFiber=${mutateIdsInFiberTree(targetLi, sid, pid)}`);
    if (sampleBtn) notes.push(`sampleFiber=${mutateIdsInFiberTree(sampleBtn, sid, pid)}`);

    const restoreSample = () => {
      if (!sampleBtn || (!sampleOrig.scheduleId && !sampleOrig.productId)) return;
      mutateIdsInFiberTree(sampleBtn, sampleOrig.scheduleId || sid, sampleOrig.productId || pid);
    };

    if (sampleBtn) {
      const fns = findEntryFnsNear(sampleBtn);
      const ev = fakeClickEvent(sampleBtn);
      if (typeof fns.onClick === "function") {
        try {
          fns.onClick(ev);
          setTimeout(restoreSample, 15000);
          return { ok: true, method: "iso.sample.onClick", notes: notes.join(",") };
        } catch {
          /* next */
        }
      }
      if (typeof fns.onReserve === "function") {
        try {
          fns.onReserve(ev);
          setTimeout(restoreSample, 15000);
          return { ok: true, method: "iso.sample.onReserve", notes: notes.join(",") };
        } catch {
          /* next */
        }
      }
      if (typeof fns.V === "function") {
        try {
          fns.V({ scheduleId: sid, productId: pid });
          setTimeout(restoreSample, 15000);
          return { ok: true, method: "iso.sample.V", notes: notes.join(",") };
        } catch {
          /* next */
        }
      }
    }

    restoreSample();
    return { ok: false, method: "none", notes: notes.join(",") };
  }

  function getSlotAtIndex(index) {
    const idx = Number(index) || 0;
    const items = getReserveListItems();
    const li = items[idx - 1];
    if (!li) return null;
    const slot = getMatchBtnSlot(li);
    const activeBtn =
      slot?.querySelector("a.btn_reserve, a.common_btn.btn_primary, a.common_btn") ||
      li.querySelector("a.btn_reserve, a.common_btn.btn_primary");
    // 오픈예정 등은 <a> 없이 div.match_btn 텍스트만 있는 경우도 슬롯으로 취급
    const textHost = activeBtn || slot || li;
    const text = (textHost.innerText || "").replace(/\s+/g, " ").trim();
    const ids = extractIdsFromNode(activeBtn || slot || li);
    const hasMatchBtnSlot = Boolean(slot && (slot.classList?.contains("match_btn") || slot.matches?.("div.match_btn")));
    const looksInactive =
      !activeBtn ||
      activeBtn.getAttribute("aria-disabled") === "true" ||
      /오픈예정|판매예정|마감/.test(text);
    const looksActive = Boolean(activeBtn) && /예매하기/.test(text) && !looksInactive;
    // 활성/비활성/match_btn 슬롯이면 목록에 포함 (빈 잡슬롯 제외)
    const selectable = looksActive || looksInactive || hasMatchBtnSlot || Boolean(text);
    if (!selectable) return null;
    return {
      index: idx,
      li,
      slot: slot || li,
      activeBtn,
      text: text.slice(0, 60) || "(빈 슬롯)",
      looksInactive: looksInactive || (!looksActive && hasMatchBtnSlot),
      looksActive,
      scheduleId: ids.scheduleId || "",
      productId: ids.productId || "",
    };
  }

  function findActiveSample() {
    const items = getReserveListItems();
    for (let i = 0; i < items.length; i += 1) {
      const info = getSlotAtIndex(i + 1);
      if (
        info?.looksActive &&
        info.activeBtn &&
        !info.activeBtn.classList.contains("__sts_exp_forced_active")
      ) {
        return info;
      }
    }
    return null;
  }

  function listReserveButtonStates() {
    const items = getReserveListItems();
    const out = [];
    for (let i = 0; i < items.length; i += 1) {
      const info = getSlotAtIndex(i + 1);
      if (!info) continue;
      out.push({
        index: info.index,
        exists: true,
        text: info.text,
        looksInactive: info.looksInactive,
        looksActive: info.looksActive,
        scheduleId: info.scheduleId,
        productId: info.productId,
        kind: info.looksActive ? "예매하기(활성)" : info.looksInactive ? "오픈예정(비활성)" : "기타",
      });
    }
    return out;
  }

  // ==========================================
  // 구단(facility) — #scheduleListDiv 테이블
  // ==========================================
  function getFacilityRows() {
    return [...document.querySelectorAll("#scheduleListDiv table tbody tr")];
  }

  function getFacilityReserveCell(tr) {
    if (!tr) return null;
    // 1) 예매/오픈예정 버튼이 있는 td만 (경기명 칸 오인 방지)
    const byBtn = [...tr.querySelectorAll("td")].find((td) =>
      td.querySelector("a.btn.btn_reserve, a.btn.btn_reserve_scdl, a.btn_reserve_scdl, a.btn_reserve")
    );
    if (byBtn) return byBtn;
    // 2) 고정 4번째 칸
    return tr.querySelector("td:nth-of-type(4)") || null;
  }

  /** 활성 샘플 없으면 a.btn.btn_reserve 를 직접 생성 */
  function buildFacilityReserveButton(sampleBtn, scdlBtn) {
    let el;
    if (sampleBtn) {
      el = sampleBtn.cloneNode(true);
    } else if (scdlBtn) {
      el = scdlBtn.cloneNode(true);
      el.classList.remove("btn_reserve_scdl");
      if (!el.classList.contains("btn_reserve")) el.classList.add("btn_reserve");
      if (!el.classList.contains("btn")) el.classList.add("btn");
      el.textContent = "예매하기";
    } else {
      el = document.createElement("a");
      el.href = "javascript:;";
      el.className = "btn btn_reserve";
      el.textContent = "예매하기";
    }
    el.classList.add("__sts_exp_forced_active");
    el.removeAttribute("aria-disabled");
    el.setAttribute("aria-disabled", "false");
    el.style.pointerEvents = "auto";
    el.style.opacity = "1";
    el.style.cursor = "pointer";
    return el;
  }

  /** www: 활성 샘플 없으면 a.common_btn.btn_primary 생성 */
  function buildWwwReserveButton(sampleBtn) {
    let el;
    if (sampleBtn) {
      el = sampleBtn.cloneNode(true);
    } else {
      el = document.createElement("a");
      el.href = "javascript:;";
      el.className = "common_btn btn_primary";
      el.textContent = "예매하기";
    }
    el.classList.add("__sts_exp_forced_active");
    el.removeAttribute("aria-disabled");
    el.setAttribute("aria-disabled", "false");
    el.style.pointerEvents = "auto";
    el.style.opacity = "1";
    el.style.cursor = "pointer";
    return el;
  }

  function extractIdsFromFacilityHtml(node) {
    const ids = extractIdsFromNode(node);
    if (ids.scheduleId || ids.productId) return ids;

    let scheduleId = "";
    let productId = "";
    const tr = node?.closest?.("tr") || node;
    const bag = [
      node?.getAttribute?.("href") || "",
      node?.getAttribute?.("onclick") || "",
      node?.outerHTML || "",
      tr?.innerHTML || "",
    ].join(" ");

    const sidM =
      bag.match(/scheduleId[=:\s'"]+(\d+)/i) ||
      bag.match(/schedule[_-]?id[=:\s'"]+(\d+)/i);
    const pidM =
      bag.match(/productId[=:\s'"]+(\d+)/i) ||
      bag.match(/product[_-]?id[=:\s'"]+(\d+)/i) ||
      bag.match(/\/product\/(\d+)/i);
    if (sidM) scheduleId = sidM[1];
    if (pidM) productId = pidM[1];

    try {
      const u = new URL(location.href);
      if (!productId) productId = u.pathname.match(/\/product\/(\d+)/)?.[1] || "";
      if (!scheduleId) scheduleId = u.searchParams.get("scheduleId") || "";
    } catch {
      /* ignore */
    }
    return { scheduleId, productId };
  }

  function getFacilitySlotAtIndex(index) {
    const idx = Number(index) || 0;
    const rows = getFacilityRows();
    const tr = rows[idx - 1];
    if (!tr) return null;
    const slot = getFacilityReserveCell(tr);
    // 활성: btn_reserve / 오픈예정: btn_reserve_scdl
    const activeBtn =
      slot?.querySelector("a.btn.btn_reserve:not(.btn_reserve_scdl), a.btn_reserve:not(.btn_reserve_scdl)") ||
      tr.querySelector("a.btn.btn_reserve:not(.btn_reserve_scdl), a.btn_reserve:not(.btn_reserve_scdl)");
    const scdlBtn =
      slot?.querySelector("a.btn.btn_reserve_scdl, a.btn_reserve_scdl") ||
      tr.querySelector("a.btn.btn_reserve_scdl, a.btn_reserve_scdl");
    const textHost = activeBtn || scdlBtn || slot || tr;
    const text = (textHost.innerText || "").replace(/\s+/g, " ").trim();
    const rowText = (tr.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const ids = extractIdsFromFacilityHtml(activeBtn || scdlBtn || slot || tr);
    const looksInactive =
      Boolean(scdlBtn) ||
      !activeBtn ||
      activeBtn.getAttribute("aria-disabled") === "true" ||
      /오픈예정|판매예정|마감/.test(text) ||
      /오픈예정|판매예정|마감/.test(rowText);
    const looksActive = Boolean(activeBtn) && /예매하기|예매/.test(text) && !looksInactive;
    return {
      index: idx,
      li: tr,
      slot,
      activeBtn,
      scdlBtn,
      text: (text || rowText).slice(0, 60),
      looksInactive,
      looksActive,
      scheduleId: ids.scheduleId || "",
      productId: ids.productId || "",
    };
  }

  function findFacilityActiveSample() {
    const rows = getFacilityRows();
    for (let i = 0; i < rows.length; i += 1) {
      const info = getFacilitySlotAtIndex(i + 1);
      if (
        info?.looksActive &&
        info.activeBtn &&
        !info.activeBtn.classList.contains("__sts_exp_forced_active")
      ) {
        return info;
      }
    }
    return null;
  }

  function captureReserveTemplates(btn) {
    if (!btn) {
      const real = document.querySelector(
        "#scheduleListDiv a.btn.btn_reserve:not(.btn_reserve_scdl):not(.__sts_exp_forced_active)"
      );
      const scdl = document.querySelector("#scheduleListDiv a.btn.btn_reserve_scdl");
      const src = real || scdl;
      return {
        onclickTpl: src?.getAttribute("onclick") || "",
        hrefTpl: src?.getAttribute("href") || "",
      };
    }
    return {
      onclickTpl: btn.getAttribute("onclick") || "",
      hrefTpl: btn.getAttribute("href") || "",
    };
  }

  function listFacilityButtonStates() {
    const rows = getFacilityRows();
    const out = [];
    for (let i = 0; i < rows.length; i += 1) {
      const info = getFacilitySlotAtIndex(i + 1);
      if (!info) continue;
      out.push({
        index: info.index,
        exists: true,
        text: info.text,
        looksInactive: info.looksInactive,
        looksActive: info.looksActive,
        scheduleId: info.scheduleId,
        productId: info.productId,
        kind: info.looksActive ? "예매하기(활성)" : info.looksInactive ? "오픈예정(비활성)" : "기타",
        site: "facility",
      });
    }
    return out;
  }

  function upgradeFacilityToActiveReserve(index, scheduleId, productId) {
    const sid = String(scheduleId || "").trim();
    const pid = String(productId || "").trim();
    if (!sid || !pid) return { ok: false, error: "scheduleId / productId 모두 필요" };

    const target = getFacilitySlotAtIndex(index);
    if (!target?.slot) return { ok: false, error: `#${index} 구단 행/슬롯 없음 (td:nth-of-type(4) 확인)` };

    const sample = findFacilityActiveSample();
    const sampleBtn = sample?.activeBtn || null;
    if (!sampleBtn) {
      progressLog(`구단 #${index} 활성 샘플 없음 → btn_reserve 합성 생성`, "warn");
    }

    const templates = captureReserveTemplates(sampleBtn || target.scdlBtn);
    progressLog(
      `구단 #${index} tpl onclick=${templates.onclickTpl ? "Y" : "N"} href=${templates.hrefTpl ? "Y" : "N"}`,
      "info"
    );

    ensureActivateStyle();
    clearForcedActivate({ clearNav: false });

    const targetNode = target.scdlBtn || target.activeBtn || target.li || target.slot;
    const fiberHits = mutateIdsInFiberTree(targetNode, sid, pid);
    progressLog(
      `구단 #${index} fiber hits=${fiberHits} · slot=td4 · ${fiberDiag(targetNode)}`,
      fiberHits > 0 ? "ok" : "warn"
    );

    const slot = target.slot;
    if (slot.dataset.stsOrigHtml == null) {
      slot.dataset.stsOrigHtml = slot.innerHTML;
    }
    slot.classList.add("__sts_exp_upgraded_slot");

    const wireCloneClick = (cloneEl, sampleRef, targetEl) => {
      cloneEl.dataset.stsOnclickTpl = templates.onclickTpl || "";
      cloneEl.dataset.stsHrefTpl = templates.hrefTpl || "";
      cloneEl.dataset.stsRowIndex = String(index);
      cloneEl.dataset.stsScheduleId = sid;
      cloneEl.dataset.stsProductId = pid;
      // 손클릭 → 스케줄배열(샘플행) 패치 후 활성 샘플.click (NetFunnel 통과 + sid 치환)
      cloneEl.addEventListener(
        "click",
        (event) => {
          if (cloneEl.dataset.stsInvoking === "1") return;
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          cloneEl.dataset.stsInvoking = "1";
          progressLog(
            `구단 #${index} 클릭 → 샘플클릭+schedules 패치 sid=${sid}`,
            "info"
          );
          const liveSample =
            (sampleRef &&
              sampleRef.isConnected &&
              !sampleRef.classList.contains("__sts_exp_forced_active") &&
              sampleRef) ||
            document.querySelector(
              "#scheduleListDiv a.btn.btn_reserve:not(.btn_reserve_scdl):not(.__sts_exp_forced_active)"
            ) ||
            cloneEl;
          void tryInvokeReserve(sid, pid, liveSample, targetEl, {
            site: "facility",
            onclickTpl: cloneEl.dataset.stsOnclickTpl || "",
            hrefTpl: cloneEl.dataset.stsHrefTpl || "",
            rowIndex: index,
          })
            .then((invoked) => {
              if (invoked.ok) {
                progressLog(
                  `구단 진입 OK · ${invoked.method} · ${invoked.notes || ""}`,
                  "ok"
                );
              } else {
                progressLog(
                  `구단 진입 실패 · ${invoked.notes || invoked.error || "?"}`,
                  "warn"
                );
              }
            })
            .finally(() => {
              setTimeout(() => {
                delete cloneEl.dataset.stsInvoking;
              }, 800);
            });
        },
        true
      );
    };

    const placeButton = (btnEl) => {
      const old =
        slot.querySelector("a.btn.btn_reserve_scdl, a.btn_reserve_scdl, a.btn.btn_reserve, a.btn_reserve") ||
        null;
      if (old) old.replaceWith(btnEl);
      else {
        slot.appendChild(btnEl);
      }
    };

    // 가능하면 해당 행 원본 버튼을 in-place 변환 (클론은 jQuery 핸들러 유실)
    let placed = null;
    const live =
      target.scdlBtn ||
      target.activeBtn ||
      slot.querySelector("a.btn.btn_reserve_scdl, a.btn_reserve_scdl, a.btn.btn_reserve, a.btn_reserve");
    if (live) {
      live.classList.remove("btn_reserve_scdl");
      if (!live.classList.contains("btn")) live.classList.add("btn");
      if (!live.classList.contains("btn_reserve")) live.classList.add("btn_reserve");
      live.classList.add("__sts_exp_forced_active");
      live.href = "javascript:;";
      live.removeAttribute("aria-disabled");
      live.setAttribute("aria-disabled", "false");
      live.style.pointerEvents = "auto";
      live.style.opacity = "1";
      live.style.cursor = "pointer";
      live.textContent = "예매하기";
      placed = live;
    } else {
      const clone = buildFacilityReserveButton(sampleBtn, target.scdlBtn);
      placeButton(clone);
      placed = clone;
    }
    wireCloneClick(placed, sampleBtn || placed, target.li || target.slot);

    lastUpgrade = {
      index: Number(index),
      scheduleId: sid,
      productId: pid,
      site: "facility",
    };

    const reinject = () => {
      if (!lastUpgrade || lastUpgrade.site !== "facility") return;
      const again = getFacilitySlotAtIndex(lastUpgrade.index);
      if (!again?.slot) return;
      if (again.slot.querySelector("a.__sts_exp_forced_active")) return;
      const sampleNow = findFacilityActiveSample();
      if (again.slot.dataset.stsOrigHtml == null) {
        again.slot.dataset.stsOrigHtml = again.slot.innerHTML;
      }
      again.slot.classList.add("__sts_exp_upgraded_slot");
      let placed2 = null;
      const live2 =
        again.scdlBtn ||
        again.activeBtn ||
        again.slot.querySelector(
          "a.btn.btn_reserve_scdl, a.btn_reserve_scdl, a.btn.btn_reserve, a.btn_reserve"
        );
      if (live2) {
        live2.classList.remove("btn_reserve_scdl");
        if (!live2.classList.contains("btn")) live2.classList.add("btn");
        if (!live2.classList.contains("btn_reserve")) live2.classList.add("btn_reserve");
        live2.classList.add("__sts_exp_forced_active");
        live2.href = "javascript:;";
        live2.textContent = "예매하기";
        live2.style.pointerEvents = "auto";
        live2.style.opacity = "1";
        live2.style.cursor = "pointer";
        placed2 = live2;
      } else {
        const clone2 = buildFacilityReserveButton(sampleNow?.activeBtn || null, again.scdlBtn);
        const old2 =
          again.slot.querySelector(
            "a.btn.btn_reserve_scdl, a.btn_reserve_scdl, a.btn.btn_reserve, a.btn_reserve"
          ) || null;
        if (old2) old2.replaceWith(clone2);
        else again.slot.appendChild(clone2);
        placed2 = clone2;
      }
      wireCloneClick(placed2, sampleNow?.activeBtn || placed2, again.li || again.slot);
      progressLog(`구단 #${lastUpgrade.index} 리렌더 → 재교체`, "warn");
      installFacilityNavRewrite(lastUpgrade.scheduleId, lastUpgrade.productId, lastUpgrade.index);
    };

    let reinjectTimer = null;
    activateKeepAlive = new MutationObserver(() => {
      if (reinjectTimer) clearTimeout(reinjectTimer);
      reinjectTimer = setTimeout(reinject, 100);
    });
    activateKeepAlive.observe(target.li || slot, { childList: true, subtree: true });

    const after = getFacilitySlotAtIndex(index);
    progressLog(
      `구단 #${index} 교체 완료 · sid=${sid} pid=${pid} · mode=${live ? "live" : "clone"} · sample=${sampleBtn ? "있음" : "합성"}`,
      "ok"
    );
    installFacilityNavRewrite(sid, pid, index);
    return {
      ok: true,
      index: Number(index),
      scheduleId: sid,
      productId: pid,
      before: target.text,
      after: after?.text || "예매하기",
      sampleIndex: sample?.index || null,
      synthesized: !sampleBtn,
      site: "facility",
      mode: live ? "live" : "clone",
    };
  }

  function ensureActivateStyle() {
    if (document.getElementById("__sts_exp_activate_style")) return;
    const style = document.createElement("style");
    style.id = "__sts_exp_activate_style";
    style.textContent = `
      a.__sts_exp_forced_active {
        outline: 3px solid #22c55e !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 4px rgba(34,197,94,.35) !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  let activateKeepAlive = null;
  let activateKeepAliveTimer = null;
  let lastUpgrade = null;

  function clearForcedActivate({ clearNav = true } = {}) {
    if (activateKeepAlive) {
      activateKeepAlive.disconnect();
      activateKeepAlive = null;
    }
    if (activateKeepAliveTimer) {
      clearInterval(activateKeepAliveTimer);
      activateKeepAliveTimer = null;
    }
    document.querySelectorAll(".__sts_exp_upgraded_slot").forEach((el) => {
      if (el.dataset.stsOrigHtml != null) {
        el.innerHTML = el.dataset.stsOrigHtml;
        delete el.dataset.stsOrigHtml;
      }
      el.classList.remove("__sts_exp_upgraded_slot");
    });
    document.querySelectorAll(".__sts_exp_forced_active").forEach((el) => {
      el.classList.remove("__sts_exp_forced_active");
    });
    lastUpgrade = null;
    // 구단 URL sid 치환 훅 — 사용자가 해제 누를 때만 제거 (재교체 시엔 유지/갱신)
    if (clearNav) {
      try {
        chrome.runtime.sendMessage({ type: "EXP_CLEAR_FACILITY_NAV_REWRITE" }).catch(() => {});
      } catch {
        /* ignore */
      }
    }
  }

  function installFacilityNavRewrite(scheduleId, productId, rowIndex) {
    const sid = String(scheduleId || "").trim();
    const pid = String(productId || "").trim();
    if (!sid || !pid) return;
    try {
      chrome.runtime
        .sendMessage({
          type: "EXP_INSTALL_FACILITY_NAV_REWRITE",
          scheduleId: sid,
          productId: pid,
          rowIndex: Number(rowIndex) || 0,
        })
        .then((r) => {
          if (r?.ok) {
            progressLog(
              `구단 스케줄 패치 · sid=${sid} row=#${rowIndex || "?"} hits=${r.hits ?? "?"} → 초록 버튼 직접 클릭`,
              r.hits > 0 ? "ok" : "warn"
            );
          }
        })
        .catch(() => {});
    } catch {
      /* ignore */
    }
  }

  /**
   * 비활성(오픈예정) 슬롯을 활성 예매하기로 만들고
   * fiber 속 ID + 클릭 시 MAIN 핸들러로 진입 시도.
   *
   * 중요: 다른 활성 샘플이 없을 때 기존 <a> 를 replaceWith 하면
   * React fiber 가 끊겨 클릭이 먹통이 됨 → 그때는 원본 노드를 살린다.
   */
  function upgradeToActiveReserve(index, scheduleId, productId) {
    const sid = String(scheduleId || "").trim();
    const pid = String(productId || "").trim();
    if (!sid || !pid) return { ok: false, error: "scheduleId / productId 모두 필요" };

    ensureActivateStyle();
    clearForcedActivate();

    const target = getSlotAtIndex(index);
    if (!target?.slot) return { ok: false, error: `#${index} 슬롯 없음` };

    const sample = findActiveSample();
    const otherSampleBtn =
      sample?.activeBtn && sample.index !== Number(index) ? sample.activeBtn : null;
    const existingA =
      target.slot.querySelector("a.btn_reserve, a.common_btn.btn_primary, a.common_btn") ||
      target.activeBtn ||
      null;

    let mode = "synthesize";
    if (existingA && !otherSampleBtn) {
      mode = "live";
      progressLog(`#${index} 외부 샘플 없음 → 이 행 <a> 살림(fiber 유지)`, "warn");
    } else if (otherSampleBtn && existingA) {
      mode = "clone-from-sample";
    } else if (otherSampleBtn && !existingA) {
      mode = "clone-into-empty";
    } else if (!existingA) {
      progressLog(`#${index} <a> 없음 → common_btn.btn_primary 합성`, "warn");
    }

    const targetNode = existingA || target.li || target.slot;
    const fiberHits = mutateIdsInFiberTree(targetNode, sid, pid);
    const afterPatch = extractIdsFromNode(targetNode);
    progressLog(
      `#${index} fiber 패치 hits=${fiberHits} · ${fiberDiag(targetNode)} · 읽힌 sid=${afterPatch.scheduleId || "?"} pid=${afterPatch.productId || "?"}`,
      fiberHits > 0 ? "ok" : "warn"
    );
    if (otherSampleBtn) {
      progressLog(`#${index} 샘플 진단 · ${fiberDiag(otherSampleBtn)} (클릭→MAIN)`, "info");
    } else if (existingA) {
      progressLog(`#${index} live 진단 · ${fiberDiag(existingA)} (클릭→MAIN)`, "info");
    }

    const slot = target.slot;
    if (slot.dataset.stsOrigHtml == null) {
      slot.dataset.stsOrigHtml = slot.innerHTML;
    }
    slot.classList.add("__sts_exp_upgraded_slot");

    const wireCloneClick = (cloneEl, sampleRef, targetRef) => {
      cloneEl.dataset.stsOnclickTpl = sampleRef?.getAttribute?.("onclick") || "";
      cloneEl.dataset.stsHrefTpl = sampleRef?.getAttribute?.("href") || "";
      cloneEl.addEventListener(
        "click",
        (event) => {
          if (cloneEl.dataset.stsInvoking === "1") return;
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          cloneEl.dataset.stsInvoking = "1";
          progressLog(`교체버튼 클릭 → MAIN 속 진입 sid=${sid} pid=${pid}`, "info");
          const liveSample = sampleRef || cloneEl;
          void tryInvokeReserve(sid, pid, liveSample, targetRef, {
            site: "www",
            onclickTpl: cloneEl.dataset.stsOnclickTpl || "",
            hrefTpl: cloneEl.dataset.stsHrefTpl || "",
            useForcedAsSample: true,
          })
            .then((invoked) => {
              if (invoked.ok) {
                progressLog(`진입 OK · ${invoked.method} · ${invoked.notes || ""}`, "ok");
              } else {
                progressLog(`진입 실패 · ${invoked.notes || "핸들러/V 못 찾음"}`, "warn");
              }
            })
            .finally(() => {
              setTimeout(() => {
                delete cloneEl.dataset.stsInvoking;
              }, 800);
            });
        },
        true
      );
    };

    const activateLiveAnchor = (live) => {
      live.classList.add("__sts_exp_forced_active", "common_btn", "btn_primary");
      live.classList.remove("btn_reserve_scdl");
      live.removeAttribute("aria-disabled");
      live.setAttribute("aria-disabled", "false");
      live.style.pointerEvents = "auto";
      live.style.opacity = "1";
      live.style.cursor = "pointer";
      if (!/예매하기/.test((live.innerText || "").trim())) {
        live.textContent = "예매하기";
      }
      if (!live.getAttribute("href")) live.href = "javascript:;";
      wireCloneClick(live, live, targetNode);
      return live;
    };

    let usedEl;
    if (mode === "live") {
      usedEl = activateLiveAnchor(existingA);
    } else if (mode === "clone-from-sample") {
      const clone = buildWwwReserveButton(otherSampleBtn);
      wireCloneClick(clone, otherSampleBtn, targetNode);
      existingA.replaceWith(clone);
      usedEl = clone;
    } else if (mode === "clone-into-empty") {
      const clone = buildWwwReserveButton(otherSampleBtn);
      wireCloneClick(clone, otherSampleBtn, targetNode);
      slot.innerHTML = "";
      slot.appendChild(clone);
      usedEl = clone;
    } else {
      const clone = buildWwwReserveButton(null);
      wireCloneClick(clone, null, targetNode);
      if (existingA) existingA.replaceWith(clone);
      else {
        slot.innerHTML = "";
        slot.appendChild(clone);
      }
      usedEl = clone;
    }

    try {
      usedEl.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch {
      usedEl.scrollIntoView(true);
    }

    lastUpgrade = {
      index: Number(index),
      scheduleId: sid,
      productId: pid,
      site: "www",
      mode,
    };

    const reinject = () => {
      if (!lastUpgrade || lastUpgrade.site === "facility") return;
      const again = getSlotAtIndex(lastUpgrade.index);
      if (!again?.slot) return;
      if (again.slot.querySelector("a.__sts_exp_forced_active")) return;
      const sampleNow = findActiveSample();
      const otherNow =
        sampleNow?.activeBtn && sampleNow.index !== lastUpgrade.index
          ? sampleNow.activeBtn
          : null;
      const againExisting =
        again.slot.querySelector("a.btn_reserve, a.common_btn.btn_primary, a.common_btn") ||
        again.activeBtn ||
        null;
      const againTargetNode = againExisting || again.li || again.slot;
      mutateIdsInFiberTree(againTargetNode, lastUpgrade.scheduleId, lastUpgrade.productId);
      if (again.slot.dataset.stsOrigHtml == null) {
        again.slot.dataset.stsOrigHtml = again.slot.innerHTML;
      }
      again.slot.classList.add("__sts_exp_upgraded_slot");

      if (againExisting && !otherNow) {
        againExisting.classList.add("__sts_exp_forced_active", "common_btn", "btn_primary");
        againExisting.removeAttribute("aria-disabled");
        againExisting.setAttribute("aria-disabled", "false");
        againExisting.style.pointerEvents = "auto";
        againExisting.style.opacity = "1";
        againExisting.style.cursor = "pointer";
        if (!/예매하기/.test((againExisting.innerText || "").trim())) {
          againExisting.textContent = "예매하기";
        }
        wireCloneClick(againExisting, againExisting, againTargetNode);
        progressLog(`#${lastUpgrade.index} 리렌더 → live 재적용`, "warn");
        return;
      }

      const clone2 = buildWwwReserveButton(otherNow);
      wireCloneClick(clone2, otherNow || clone2, againTargetNode);
      if (againExisting) againExisting.replaceWith(clone2);
      else {
        again.slot.innerHTML = "";
        again.slot.appendChild(clone2);
      }
      progressLog(`#${lastUpgrade.index} 리렌더 → 예매하기 재교체`, "warn");
    };

    let reinjectTimer = null;
    activateKeepAlive = new MutationObserver(() => {
      if (reinjectTimer) clearTimeout(reinjectTimer);
      reinjectTimer = setTimeout(reinject, 100);
    });
    activateKeepAlive.observe(target.li || slot, { childList: true, subtree: true });
    activateKeepAliveTimer = reinjectTimer;

    const after = getSlotAtIndex(index);
    progressLog(
      `#${index} 교체 완료 · sid=${sid} pid=${pid} · mode=${mode}`,
      "ok"
    );
    return {
      ok: true,
      index: Number(index),
      scheduleId: sid,
      productId: pid,
      before: target.text,
      after: after?.text || "예매하기",
      sampleIndex: sample?.index || null,
      synthesized: mode === "synthesize",
      mode,
      fiberHits,
      patchedScheduleId: afterPatch.scheduleId || "",
      patchedProductId: afterPatch.productId || "",
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "EXP_LIST_BUTTON_STATES") {
      try {
        sendResponse({ ok: true, buttons: listReserveButtonStates(), site: "www" });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return false;
    }
    if (message?.type === "EXP_LIST_FACILITY_BUTTON_STATES") {
      try {
        sendResponse({ ok: true, buttons: listFacilityButtonStates(), site: "facility" });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return false;
    }
    if (message?.type === "EXP_UPGRADE_TO_RESERVE") {
      try {
        sendResponse(
          upgradeToActiveReserve(message.index, message.scheduleId, message.productId)
        );
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return false;
    }
    if (message?.type === "EXP_UPGRADE_FACILITY_TO_RESERVE") {
      try {
        sendResponse(
          upgradeFacilityToActiveReserve(message.index, message.scheduleId, message.productId)
        );
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return false;
    }
    if (message?.type === "EXP_CLEAR_FORCE_ACTIVATE") {
      try {
        clearForcedActivate();
        progressLog("예매하기 교체 해제 (원래 오픈예정 복구)", "info");
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return false;
    }
    return false;
  });

  progressLog("교체 모듈 연결됨", "info");
  // 예전 실험 Rec 저장키 잔여 정리 (기능 없음)
  chrome.storage.local.remove(["expAutoRecArmed", "expAutoRecConfig"]).catch(() => {});
})();
