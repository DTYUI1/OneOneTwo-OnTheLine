// Прототип доработок обучения диспетчера ДДС (../README.md, раздел 6).
// Всё на заглушках: сервера нет, бригада и службы — сценарий в браузере.
// Интерфейс АРМ повторяет наш тренажёр; новое — учебный слой поверх него.
"use strict";
(function () {
  const D = window.PROTO_DATA;
  const AUDIO = window.PROTO_AUDIO || {};
  const AUDIO_MS = window.PROTO_AUDIO_MS || {};
  const ACCEL = 40; // время на месте у бригады показываем ускоренно
  const root = document.getElementById("app");

  // ---------------------------------------------------------------- мелочи
  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const norm = (text) => String(text ?? "").toLowerCase().replace(/ё/g, "е");
  const hasAny = (text, keys) => {
    const value = norm(text);
    return keys.some((key) => value.includes(norm(key)));
  };
  const mmss = (seconds) => {
    if (seconds == null || !isFinite(seconds)) return "—";
    const s = Math.max(0, Math.round(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const nowReal = () => performance.now() / 1000;
  const houseRe = (house) => new RegExp(`(^|[^0-9])${house}([^0-9а-яa-z]|$)`, "i");
  const plural = (n, one, few, many) => {
    const t = n % 100, o = n % 10;
    if (t >= 11 && t <= 14) return many;
    if (o === 1) return one;
    if (o >= 2 && o <= 4) return few;
    return many;
  };
  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(items, random = Math.random) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
  const store = {
    get(key, fallback) {
      try { const raw = localStorage.getItem(`dds-proto.${key}`); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`dds-proto.${key}`, JSON.stringify(value)); } catch { /* прототип работает и без хранилища */ }
    },
  };

  // ---------------------------------------------------------------- звук
  let actx = null;
  function ac() {
    if (!P.sound || typeof AudioContext === "undefined") return null;
    actx = actx || new AudioContext();
    if (actx.state === "suspended") actx.resume();
    return actx;
  }
  function beep(ctx, at, hz, dur, level) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + 0.005);
    gain.gain.setValueAtTime(level, at + dur - 0.005);
    gain.gain.linearRampToValueAtTime(0, at + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + dur + 0.01);
  }
  const tone = {
    card() { const c = ac(); if (!c) return; const t = c.currentTime; beep(c, t, 880, 0.12, 0.06); beep(c, t + 0.2, 880, 0.12, 0.06); },
    ring() { const c = ac(); if (!c) return; const t = c.currentTime; for (let b = 0; b < 2; b++) for (let s = 0; s < 8; s++) beep(c, t + b * 1.4 + s * 0.05, s % 2 ? 480 : 440, 0.05, 0.06); },
    // Тревога — свой звук: двухтональный, его не спутать с обычным вызовом.
    alarm() { const c = ac(); if (!c) return; const t = c.currentTime; for (let i = 0; i < 3; i++) { beep(c, t + i * 0.5, 960, 0.24, 0.08); beep(c, t + i * 0.5 + 0.25, 770, 0.24, 0.08); } },
    ringback() { const c = ac(); if (!c) return; beep(c, c.currentTime, 425, 0.9, 0.05); },
  };

  let voice = null;
  function stopVoice() {
    if (voice) { voice.stop(); voice = null; }
  }
  function speak(id, onEnd) {
    stopVoice();
    let finished = false;
    const done = () => { if (finished) return; finished = true; voice = null; if (onEnd) onEnd(); };
    const text = D.LINES[id] || "";
    const ms = AUDIO_MS[id] || Math.max(1500, text.length * 60);
    if (P.sound && AUDIO[id]) {
      const audio = new Audio(AUDIO[id]);
      const guard = setTimeout(done, ms + 1500);
      audio.onended = () => { clearTimeout(guard); done(); };
      audio.play().catch(() => {});
      voice = { stop() { clearTimeout(guard); audio.pause(); finished = true; } };
    } else {
      const timer = setTimeout(done, P.sound ? ms : Math.min(ms, 1800));
      voice = { stop() { clearTimeout(timer); finished = true; } };
    }
  }
  function playClip(id) {
    stopVoice();
    if (id.startsWith("blob:")) { const a = new Audio(id); a.play().catch(() => {}); voice = { stop() { a.pause(); } }; return; }
    speak(id);
  }

  // ---------------------------------------------------------------- состояние
  const P = {
    scene: "shift",
    guide: true,
    sound: true,
    menu: null,
    toast: null,
    modal: null,
    shift: null,
    drill: null,
    teacher: { tab: "live", menuFor: null, sim: null, dor: null, follow: false },
    path: { picks: {}, checked: false },
    example: { shift: null, card: "c1" },
  };

  function newShift() {
    return {
      phase: "briefing", started: null, paused: 0, pausedAt: null,
      view: "list", cards: [],
      brigades: D.BRIGADES.map((b) => ({ ...b, card: null, lastContact: null })),
      phone: false, form: null, call: null, ringing: [], log: [], doklads: [],
      inj: { noAnswer: false }, stop: { done: false, active: null, score: null },
      handover: {}, seq: 1,
    };
  }
  P.shift = newShift();

  const S = () => P.shift;
  function T(s = P.shift) {
    if (!s.started) return 0;
    const n = nowReal();
    return n - s.started - s.paused - (s.pausedAt ? n - s.pausedAt : 0);
  }
  const cardById = (id, s = P.shift) => s.cards.find((c) => c.id === id);
  const brig = (id, s = P.shift) => s.brigades.find((b) => b.id === id);
  function log(card, type, data = {}) { S().log.push({ t: T(), card, type, ...data }); }
  function toast(text) {
    P.toast = { text, until: nowReal() + 3.5 };
    renderToast();
  }

  // ---------------------------------------------------------------- карточки
  function deliver(id) {
    const s = S();
    if (cardById(id)) return;
    s.cards.push({
      id, def: D.CARDS[id], deliveredAt: T(), openedAt: null, status: "received", primaryAt: null,
      statusAt: { received: T() }, hist: [{ status: "received", at: T(), comment: "" }], comments: [], crew: "",
      addrText: "", addrSaved: null, addrWrongEver: false, addrAtDispatch: null, suggest: false,
      brigade: null, dispatchedAt: null, reports: {}, ev: {}, sched: {}, feed: [], closedAt: null,
    });
    log(id, "deliver");
    tone.card();
  }

  function addrVerdict(def, text) {
    const t = norm(text);
    if (!t.trim()) return "none";
    const e = def.expected;
    if (e.wrongStem && t.includes(e.wrongStem)) return "wrong";
    if (!t.includes(e.stem)) return "wrong";
    return houseRe(e.house).test(t) ? "ok" : "partial";
  }

  const NEXT = {
    received: ["accepted", "rejected"], rejected: ["accepted"], accepted: ["responding", "refused"],
    responding: ["arrived", "refused"], arrived: ["working", "refused"], working: ["completed", "refused"],
  };
  const NEED = { responding: "departure", arrived: "arrival", working: "works", completed: "completion" };
  const NEED_LABEL = { departure: "доклада о выезде", arrival: "доклада о прибытии", works: "доклада о работах", completion: "доклада о завершении" };

  function setStatus(c, status, crew, comment) {
    const s = S();
    c.status = status;
    c.statusAt[status] = T();
    c.hist.push({ status, at: T(), crew, comment });
    if (comment) c.comments.push(comment);
    if (crew) c.crew = crew;
    if ((status === "accepted" || status === "rejected") && c.primaryAt == null) c.primaryAt = T();
    log(c.id, "status", { status, comment });
    const final = status === "completed" || status === "refused" || (c.id === "c3" && status === "rejected");
    if (final) {
      c.closedAt = T();
      const b = c.brigade ? brig(c.brigade) : null;
      if (b) b.card = null;
      s.ringing = s.ringing.filter((r) => r.card !== c.id);
      log(c.id, "close");
    }
    s.form = null;
  }

  function dispatch(c, id) {
    const b = brig(id);
    if (!b || b.state !== "free" || b.card) return;
    b.card = c.id;
    b.lastContact = T();
    c.brigade = id;
    c.dispatchedAt = T();
    c.addrAtDispatch = c.addrSaved;
    log(c.id, "dispatch", { brigade: id });
  }

  // ---------------------------------------------------------------- вызовы бригады
  const KIND = {
    departure: { line: (c) => `${c.id}_departure`, stage: "departure", label: "доклад о выезде" },
    floor_query: {
      line: () => "c1_floor_query", stage: "arrival", label: "прибытие и вопрос об этаже",
      replies: [
        { label: "Девятый этаж", line: "c1_floor_ok", effect: "floor_ok" },
        { label: "Не знаю — ищите по подъездам", line: "c1_floor_bad", effect: "floor_bad" },
        { label: "Уточню у заявителя и перезвоню", line: "c1_floor_bad", effect: "floor_bad" },
      ],
    },
    request: {
      line: () => "c1_request", label: "просьба: нужна скорая",
      replies: [{ label: "Понял, вызываю скорую", line: "c1_request_ack", effect: "request_ack" }],
    },
    works: { line: (c) => `${c.id}_works`, stage: "works", label: "доклад о работах" },
    completion: { line: (c) => `${c.id}_completion`, stage: "completion", label: "доклад о завершении" },
    arrival: { line: () => "c2_arrival_ok", stage: "arrival", label: "доклад о прибытии" },
    arrival_wrong: {
      // В полосе вызова — как обычный доклад: что адрес не тот, обучаемый узнаёт из разговора.
      line: () => "c2_arrival_wrong", label: "расчёт приехал не туда", ring: "доклад о прибытии",
      replies: [
        { label: "Ошибка в адресе: правильно — улица Дубнинская, 32, это САО", line: "c2_fix_ack", effect: "addr_fix" },
        { label: "Сейчас проверю адрес и перезвоню", line: null, effect: "addr_later" },
      ],
    },
    alarm: {
      line: () => "alarm", label: "ТРЕВОГА: травмирован боец",
      replies: [{ label: "Понял! Вызываю скорую и докладываю руководителю", line: "alarm_ack", effect: "alarm_ack" }],
    },
  };

  function ringFrom(c, kind, alarm = false) {
    const s = S();
    s.ringing.push({ id: s.seq++, card: c.id, brigade: c.brigade, kind, at: T(), alarm, tone: nowReal() });
    if (alarm) tone.alarm(); else tone.ring();
    log(c.id, "ring", { kind, alarm });
  }

  function script(c, t) {
    if (c.id === "c3" || c.closedAt) return false;
    let changed = false;
    const fire = (key, kind, alarm) => { c.ev[key] = true; ringFrom(c, kind, alarm); changed = true; };
    const primaryOk = c.status !== "received" && c.status !== "rejected";
    if (c.brigade && primaryOk && !c.ev.depRang && t >= Math.max(c.dispatchedAt, c.primaryAt) + 6) fire("depRang", "departure");
    if (c.id === "c1") {
      if (c.statusAt.responding != null && !c.ev.arrRang && t >= c.statusAt.responding + 9) fire("arrRang", "floor_query");
      if (c.statusAt.arrived != null && !c.ev.reqRang && t >= c.statusAt.arrived + 7) fire("reqRang", "request");
      if (c.ev.request && !c.ev.worksRang && t >= c.ev.request.at + 18) fire("worksRang", "works");
      if (c.status === "working" && !c.ev.complRang) {
        const b = brig(c.brigade);
        const last = b.lastContact ?? t;
        if (!c.ev.silence && t - last >= 23) { c.ev.silence = { flaggedAt: t }; changed = true; }
        const due = c.ev.silence && c.ev.silence.checkedAt != null ? c.ev.silence.checkedAt + 10 : last + 45;
        if (t >= due) {
          if (c.ev.silence && c.ev.silence.checkedAt == null) c.ev.silence.missed = true;
          fire("complRang", "completion");
        }
      }
    }
    if (c.id === "c2") {
      if (c.statusAt.responding != null && !c.ev.arrRang && t >= c.statusAt.responding + 9) {
        const wrong = addrVerdict(c.def, c.addrAtDispatch || "") === "wrong" && !(c.ev.addrFix && c.ev.addrFix.before);
        fire("arrRang", wrong ? "arrival_wrong" : "arrival");
      }
      if (c.ev.addrFix && c.ev.addrFix.after && !c.ev.arr2Rang && t >= c.ev.addrFix.at + 14) fire("arr2Rang", "arrival");
      if (c.statusAt.arrived != null && !c.ev.worksRang && t >= c.statusAt.arrived + 8) fire("worksRang", "works");
      if (c.statusAt.working != null && !c.ev.complRang && t >= c.statusAt.working + 12) fire("complRang", "completion");
    }
    return changed;
  }

  // Смена стоит, пока открыта другая вкладка прототипа: бригада не звонит в разминку.
  function setScene(id) {
    const s = S();
    if (P.scene === "shift" && id !== "shift" && s.phase === "work" && s.pausedAt == null) {
      s.pausedAt = nowReal();
      s.autoPaused = true;
      stopVoice();
    }
    if (id === "shift" && s.autoPaused) {
      s.paused += nowReal() - s.pausedAt;
      s.pausedAt = null;
      s.autoPaused = false;
    }
    P.scene = id;
    P.menu = null;
  }

  function director() {
    const s = S();
    if (s.phase !== "work" || s.stop.active || s.pausedAt != null) return false;
    const t = T();
    let changed = false;
    if (!cardById("c1") && t >= 2.5) { deliver("c1"); changed = true; }
    const c1 = cardById("c1");
    if (c1 && !cardById("c2")) {
      const r = c1.statusAt.responding;
      if ((r != null && t >= r + 6) || t >= 150) { deliver("c2"); changed = true; }
    }
    for (const c of s.cards) changed = script(c, t) || changed;
    for (const r of s.ringing) {
      if (nowReal() - r.tone > (r.alarm ? 2.4 : 5)) { if (r.alarm) tone.alarm(); else tone.ring(); r.tone = nowReal(); }
    }
    const c2 = cardById("c2");
    if (!s.stop.done && !s.call && !s.ringing.length && c1 && c2 && !c1.closedAt && c2.dispatchedAt != null && t >= c2.dispatchedAt + 5) {
      openStopFrame();
      changed = true;
    }
    return changed;
  }

  // ---------------------------------------------------------------- звонки
  function answer(ringId) {
    const s = S();
    const r = s.ringing.find((x) => x.id === ringId);
    if (!r) return;
    if (s.call) endCall(true);
    s.ringing = s.ringing.filter((x) => x !== r);
    const c = cardById(r.card);
    const k = KIND[r.kind];
    const b = brig(r.brigade);
    const line = k.line(c);
    log(c.id, "answer", { kind: r.kind, wait: T() - r.at, line, alarm: r.alarm });
    if (b) b.lastContact = T();
    if (r.kind === "alarm") c.ev.alarm.answeredAt = T();
    if (r.kind === "request") c.ev.request = { at: T() };
    if (k.stage) { c.reports[k.stage] = T(); log(c.id, "report", { stage: k.stage }); }
    s.view = c.id;
    if (!c.openedAt) { c.openedAt = T(); log(c.id, "open"); }
    s.phone = false;
    s.form = null;
    const call = { id: s.seq++, dir: "in", card: c.id, who: b ? b.name : "Расчёт", kind: r.kind, stage: "talk", startedAt: T(), feed: [], replies: k.replies || null, alarm: r.alarm, canHang: !k.replies };
    call.feed.push({ who: call.who, text: D.LINES[line], line });
    s.call = call;
    speak(line);
  }

  function reply(index) {
    const s = S();
    const call = s.call;
    if (!call || !call.replies) return;
    const r = call.replies[index];
    const c = cardById(call.card);
    call.feed.push({ who: "Вы", text: r.label });
    call.replies = null;
    log(c.id, "reply", { kind: call.kind, effect: r.effect, label: r.label });
    if (r.effect === "floor_ok") c.ev.floor = { answer: "ok", at: T() };
    if (r.effect === "floor_bad") c.ev.floor = { answer: "bad", at: T() };
    if (r.effect === "request_ack") c.ev.request.ack = T();
    if (r.effect === "addr_fix") c.ev.addrFix = { at: T(), after: true };
    if (r.effect === "addr_later") c.ev.addrQuery = { at: T(), pending: true };
    if (r.effect === "alarm_ack") c.ev.alarm.ack = T();
    if (r.line) talkLine(call, r.line);
    else call.canHang = true;
  }

  function talkLine(call, line) {
    call.stage = "talk";
    call.feed.push({ who: call.who, text: D.LINES[line] || "", line });
    speak(line, () => { if (S().call === call) { call.canHang = true; render(); } });
    render();
  }

  function dial(targetId) {
    const s = S();
    const c = cardById(s.view);
    if (!c) return;
    if (s.call) endCall(true);
    const d = D.DIRECTORY.find((x) => x.id === targetId);
    const call = { id: s.seq++, dir: "out", card: c.id, target: d, who: d.name, stage: "dialing", startedAt: T(), feed: [{ who: "Линия", text: `Набор ${d.phone}…` }], doklad: "", check: null };
    s.call = call;
    s.phone = false;
    log(c.id, "dial", { target: d.id });
    tone.ringback();
    if (d.id === "103" && s.inj.noAnswer) {
      s.inj.noAnswer = false;
      c.ev.noAnswer = { at: T() };
      let n = 0;
      const timer = setInterval(() => {
        if (S().call !== call) { clearInterval(timer); return; }
        n += 1;
        tone.ringback();
        if (n >= 3) {
          clearInterval(timer);
          call.stage = "failed";
          call.feed.push({ who: "Линия", text: "Абонент не отвечает." });
          log(c.id, "noanswer", { target: d.id });
          render();
        }
      }, 2000);
      return;
    }
    setTimeout(() => {
      if (S().call !== call) return;
      call.stage = "talk";
      call.feed.push({ who: d.name, text: D.LINES.listen, line: `listen_${d.voice}` });
      speak(`listen_${d.voice}`);
      log(c.id, "callOut", { target: d.id });
      render();
    }, 1600);
  }

  function callBrigade(id) {
    const s = S();
    const b = brig(id);
    const here = cardById(s.view);
    if (s.call) endCall(true);
    const call = { id: s.seq++, dir: "out", card: here ? here.id : b.card, who: b.name, brigade: id, stage: "dialing", startedAt: T(), feed: [{ who: "Линия", text: `Вызов: ${b.name}…` }] };
    s.call = call;
    s.phone = false;
    tone.ringback();
    setTimeout(() => {
      if (S().call !== call) return;
      if (b.state === "repair") { call.stage = "failed"; call.feed.push({ who: "Линия", text: "Расчёт не отвечает: на ремонте." }); render(); return; }
      if (b.state === "busy") { talkLine(call, "refusal_busy"); return; }
      if (!b.card) { talkLine(call, "refusal_not_assigned"); return; }
      if (here && b.card !== here.id) { talkLine(call, "refusal_busy"); return; }
      const bc = cardById(b.card);
      b.lastContact = T();
      log(bc.id, "brigadeCall", { brigade: id });
      if (bc.ev.news && bc.ev.news.relayedAt == null) {
        bc.ev.news.relayedAt = T();
        call.feed.push({ who: "Вы", text: "Новые сведения: в квартире может быть внук хозяина, 7 лет." });
        talkLine(call, "news_ack");
        return;
      }
      if (bc.id === "c2" && bc.ev.addrQuery && bc.ev.addrQuery.pending) {
        if (addrVerdict(bc.def, bc.addrSaved || "") === "ok") {
          bc.ev.addrQuery.pending = false;
          bc.ev.addrFix = { at: T(), after: true };
          call.feed.push({ who: "Вы", text: "Уточнила адрес: улица Дубнинская, 32, это САО." });
          talkLine(call, "c2_fix_ack");
        } else {
          talkLine(call, "c2_arrival_wrong");
        }
        return;
      }
      const wrongAtDispatch = addrVerdict(bc.def, bc.addrAtDispatch || "") === "wrong";
      if (bc.id === "c2" && wrongAtDispatch && !bc.reports.arrival && !bc.ev.arrRang && !bc.ev.addrFix && addrVerdict(bc.def, bc.addrSaved || "") === "ok") {
        bc.ev.addrFix = { at: T(), before: true };
        call.feed.push({ who: "Вы", text: "Уточнение адреса: улица Дубнинская, 32, САО — не Дубининская." });
        talkLine(call, "c2_fix_ack");
        return;
      }
      if (bc.ev.silence && bc.ev.silence.checkedAt == null) {
        bc.ev.silence.checkedAt = T();
        talkLine(call, "c1_silence_check");
        return;
      }
      talkLine(call, "brigade_generic");
    }, 1200);
    render();
  }

  // Звонок в службу закрывает ожидания: запрос скорой, тревогу, резервный номер.
  function markServiceCall(c, target) {
    const t = T();
    const viaReserve = target === "reserve";
    if (target === "103" || viaReserve) {
      if (c.ev.request && c.ev.request.handledAt == null) { c.ev.request.handledAt = t; c.ev.request.viaReserve = viaReserve; }
      if (c.ev.alarm && c.ev.alarm.call103At == null) c.ev.alarm.call103At = t;
    }
    if (viaReserve && c.ev.noAnswer && c.ev.noAnswer.reserveAt == null) c.ev.noAnswer.reserveAt = t;
    if (target === "101" && c.ev.alarm && c.ev.alarm.report101At == null) c.ev.alarm.report101At = t;
  }

  function checkScheme(c, text) {
    const k = c.def.keys;
    const t = norm(text);
    return {
      where: t.includes(c.def.expected.stem) && houseRe(c.def.expected.house).test(t),
      what: hasAny(t, k.what),
      people: hasAny(t, [...k.people, "боец", "пожарн", "травм"]) || /пострадавших нет|без пострадавших/.test(t),
      hazards: hasAny(t, k.hazards),
      forces: hasAny(t, D.COMMON_FORCES),
    };
  }

  function hangUp() {
    const s = S();
    const call = s.call;
    if (!call) return;
    if (call.dir === "out" && call.target && call.stage === "talk") {
      const voiced = !!(call.recording || call.rec);
      stopRecording(call);
      const text = (call.doklad || "").trim();
      if (text || voiced) {
        const c = cardById(call.card);
        const items = checkScheme(c, text);
        const dok = { card: c.id, target: call.target.id, name: call.target.name, at: T(), text, items, n: Object.values(items).filter(Boolean).length, rec: call.rec || null, voiced };
        s.doklads.push(dok);
        log(c.id, "doklad", { target: dok.target, dok });
        markServiceCall(c, call.target.id);
        call.check = dok;
        call.stage = "result";
        call.feed.push({ who: call.target.name, text: D.LINES.accepted, line: `accepted_${call.target.voice}` });
        speak(`accepted_${call.target.voice}`);
        return;
      }
    }
    endCall(false);
  }

  function endCall(silent) {
    stopVoice();
    const s = S();
    const call = s.call;
    if (!call) return;
    stopRecording(call);
    if (call.card) log(call.card, "hangup", {});
    s.call = null;
    if (!silent) render();
  }

  // Запись своего доклада — по желанию; без микрофона доклад вписывается текстом.
  async function startRecording() {
    const call = S().call;
    if (!call || call.recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const parts = [];
      rec.ondataavailable = (e) => parts.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        call.rec = URL.createObjectURL(new Blob(parts, { type: rec.mimeType }));
        if (call.check) call.check.rec = call.rec;
      };
      rec.start();
      call.recording = rec;
      render();
    } catch {
      toast("Микрофон недоступен — впишите доклад текстом: так его увидит проверка.");
    }
  }
  function stopRecording(call) {
    if (call && call.recording) { call.recording.stop(); call.recording = null; }
  }

  // ---------------------------------------------------------------- стоп-кадр
  function openStopFrame() {
    const s = S();
    s.pausedAt = nowReal();
    stopVoice();
    const c1 = cardById("c1");
    const c2 = cardById("c2");
    const free = s.brigades.filter((b) => b.state === "free" && !b.card).length;
    const onScene = s.brigades.filter((b) => b.card && cardById(b.card).reports.arrival).map((b) => b.name);
    const reported = (c) => s.doklads.some((d) => d.card === c.id && d.target === "101");
    const sceneAnswer = onScene.length === 2 ? "Оба" : onScene.length === 0 ? "Ни один" : onScene[0];
    const reportAnswer = !reported(c1) && !reported(c2) ? "Ни по одной не доложено"
      : !reported(c1) ? c1.def.number : !reported(c2) ? c2.def.number : "По обеим доложено";
    s.stop.active = {
      answers: [null, null, null],
      checked: false,
      q: [
        { text: "Сколько расчётов вашей службы свободно прямо сейчас?", options: ["0", "1", "2", "3"], answer: String(free),
          why: `Свободно: ${free}. Расчёт 3 на ремонте, Расчёт 4 на другом происшествии, остальные — на ваших карточках.` },
        { text: "Какой расчёт уже на месте?", options: ["Расчёт 1", "Расчёт 2", "Оба", "Ни один"], answer: sceneAnswer,
          why: onScene.length ? `На месте: ${onScene.join(", ")}.` : "Пока ни один расчёт не доложил о прибытии." },
        { text: "По какой карточке вы ещё не доложили руководителю?", options: [c1.def.number, c2.def.number, "По обеим доложено", "Ни по одной не доложено"], answer: reportAnswer,
          why: "Доклад руководителю смены — по каждой принятой карточке." },
      ],
    };
  }
  function closeStopFrame() {
    const s = S();
    const sf = s.stop.active;
    s.stop.score = sf.q.filter((q, i) => sf.answers[i] === q.answer).length;
    s.paused += nowReal() - s.pausedAt;
    s.pausedAt = null;
    s.stop.done = true;
    s.stop.active = null;
    log(null, "stop", { score: s.stop.score });
  }

  // ---------------------------------------------------------------- вводные
  function inject(id) {
    const s = S();
    if (s.phase !== "work") { toast("Вводные работают во время смены: «Смена» → «Принять смену»."); return false; }
    if (id === "alarm") {
      const b = s.brigades.find((x) => x.card && cardById(x.card).reports.arrival && !cardById(x.card).ev.alarm);
      if (!b) { toast("Тревогу может подать расчёт на месте — дождитесь доклада о прибытии."); return false; }
      const c = cardById(b.card);
      c.ev.alarm = { at: T() };
      log(c.id, "inject", { id });
      ringFrom(c, "alarm", true);
    }
    if (id === "news") {
      const c = cardById("c1");
      if (!c || c.closedAt || !c.brigade) { toast("Эта вводная — для карточки 73120101, когда по ней направлен расчёт."); return false; }
      if (c.ev.news) { toast("Новые сведения по этой карточке уже приходили."); return false; }
      c.ev.news = { at: T() };
      log(c.id, "inject", { id });
      c.feed.push({ at: T(), text: "Соседка перезвонила: в квартире может быть внук хозяина, 7 лет.", fresh: true });
      tone.card();
      toast("Новые сведения в карточке 73120101 — передайте расчёту.");
    }
    if (id === "duplicate") {
      if (cardById("c3")) { toast("Дубль уже пришёл."); return false; }
      deliver("c3");
      log("c3", "inject", { id });
    }
    if (id === "noAnswer") {
      s.inj.noAnswer = true;
      log(null, "inject", { id });
      toast("Следующий звонок в 103 останется без ответа.");
    }
    return true;
  }

  // ---------------------------------------------------------------- оценка
  function evaluate(c, s) {
    const L = s.log.filter((e) => e.card === c.id);
    const reaction = c.primaryAt != null ? c.primaryAt - c.deliveredAt : null;
    const dup = c.id === "c3";
    const addr = dup ? null : addrVerdict(c.def, c.addrSaved || "");
    const doklads = s.doklads.filter((d) => d.card === c.id);
    const best101 = doklads.filter((d) => d.target === "101").reduce((m, d) => Math.max(m, d.n), -1);
    const commentText = c.comments.join(" ");
    const commentItems = dup
      ? { decision: hasAny(commentText, c.def.keys.decision) }
      : {
          where: hasAny(commentText, [c.def.expected.stem]),
          what: hasAny(commentText, c.def.keys.what),
          people: hasAny(commentText, c.def.keys.people),
          decision: hasAny(commentText, c.def.keys.decision),
        };
    const commentN = Object.values(commentItems).filter(Boolean).length;
    const commentMax = Object.keys(commentItems).length;

    const waits = L.filter((e) => e.type === "answer");
    const work = [];
    if (waits.length) {
      const longest = Math.max(...waits.map((w) => w.wait));
      work.push({ title: `Вызовы расчёта: ${waits.length}`, action: `дольше всего расчёт ждал ответа ${mmss(longest)}`, ok: longest <= 20 });
    }
    if (c.ev.arrRang && c.id === "c1")
      work.push({ title: "Расчёт спросил этаж", action: c.ev.floor ? (c.ev.floor.answer === "ok" ? "назвали девятый — он был в описании карточки" : "этаж не назвали, хотя он был в описании") : "не ответили", ok: c.ev.floor?.answer === "ok" });
    if (c.ev.request) {
      const d = c.ev.request.handledAt != null ? c.ev.request.handledAt - c.ev.request.at : null;
      work.push({ title: "Расчёт попросил скорую", action: d == null ? "в 103 не позвонили" : `позвонили в 103 через ${mmss(d)}${c.ev.request.viaReserve ? " (через резерв)" : ""}`, ok: d != null && d <= 60 });
    }
    if (c.ev.silence)
      work.push({ title: "Расчёт 15 минут на месте без доклада", action: c.ev.silence.checkedAt != null ? "позвонили сами и узнали обстановку" : "не проверили — узнали только из доклада о завершении", ok: c.ev.silence.checkedAt != null });
    if (c.ev.news)
      work.push({ title: "Заявитель перезвонил с новыми сведениями", action: c.ev.news.relayedAt != null ? `передали расчёту через ${mmss(c.ev.news.relayedAt - c.ev.news.at)}` : "расчёту не передали", ok: c.ev.news.relayedAt != null });
    if (c.ev.alarm) {
      const a = c.ev.alarm;
      work.push({
        title: "ТРЕВОГА: травмирован боец",
        action: [
          a.answeredAt != null ? `ответили через ${mmss(a.answeredAt - a.at)}` : "не ответили",
          a.call103At != null ? `скорую вызвали через ${mmss(a.call103At - a.at)}` : "скорую не вызвали",
          a.report101At != null ? "руководителю доложили" : "руководителю не доложили",
        ].join(", "),
        ok: a.answeredAt != null && a.answeredAt - a.at <= 10 && a.call103At != null && a.report101At != null,
        critical: a.answeredAt == null || a.call103At == null,
      });
    }
    if (c.ev.noAnswer)
      work.push({ title: "Скорая не ответила", action: c.ev.noAnswer.reserveAt != null ? "позвонили старшему смены по резервному номеру" : "резервный номер не использовали", ok: c.ev.noAnswer.reserveAt != null });
    const wrongArrival = L.some((e) => e.type === "ring" && e.kind === "arrival_wrong");
    if (c.id === "c2" && (wrongArrival || c.ev.addrFix))
      work.push({ title: "Адрес ушёл расчёту с ошибкой", action: c.ev.addrFix ? (c.ev.addrFix.before ? "исправили и сообщили расчёту до прибытия" : "исправили после звонка расчёта с места") : "адрес не исправили", ok: !!(c.ev.addrFix && c.ev.addrFix.before) });

    const cat = {};
    cat.reaction = reaction == null ? 1 : reaction <= 30 ? 5 : reaction <= 45 ? 4 : reaction <= 60 ? 3 : reaction <= 90 ? 2 : 1;
    const wrongAtDispatch = !dup && !!c.addrAtDispatch && addrVerdict(c.def, c.addrAtDispatch) === "wrong";
    const fixedBefore = !!(c.ev.addrFix && c.ev.addrFix.before);
    if (dup) cat.address = null;
    else if (addr === "ok") cat.address = !c.addrWrongEver ? 5 : !wrongAtDispatch ? 4 : fixedBefore ? 3 : 2;
    else cat.address = addr === "partial" ? 3 : addr === "none" ? 2 : 1;
    if (dup) cat.forces = c.status === "rejected" ? (commentItems.decision ? 5 : 3) : c.brigade ? 1 : 2;
    else {
      let f = c.brigade ? 5 : 1;
      if (c.brigade && c.dispatchedAt - (c.primaryAt ?? c.dispatchedAt) > 60) f = Math.min(f, 4);
      if (c.ev.request) f = Math.min(f, c.ev.request.handledAt == null ? 2 : c.ev.request.handledAt - c.ev.request.at > 60 ? 3 : 5);
      if (c.ev.alarm && c.ev.alarm.call103At == null) f = 1;
      cat.forces = f;
    }
    cat.brigade = work.length ? 1 + Math.round((4 * work.filter((w) => w.ok).length) / work.length) : null;
    cat.report = dup ? null : best101 < 0 ? 1 : 1 + Math.round((best101 / 5) * 4);
    cat.comment = 1 + Math.round((4 * commentN) / commentMax);
    const values = Object.values(cat).filter((v) => v != null);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const score = Math.round(((avg - 1) / 4) * 100);
    // Критическая ошибка — та, из-за которой люди ждут помощи дольше: расчёт уехал не туда,
    // тревога без ответа или без скорой, второй расчёт на дубль.
    const criticalWhy = [];
    if (addr === "wrong" || (wrongAtDispatch && !fixedBefore)) criticalWhy.push("адрес ушёл расчёту с ошибкой");
    if (work.some((w) => w.critical)) criticalWhy.push("тревога без ответа или без скорой");
    if (dup && c.brigade) criticalWhy.push("на дубль направлен второй расчёт");
    const critical = criticalWhy.length > 0;
    return {
      card: c, reaction, addr, doklads, commentItems, work, cat, score, critical, criticalWhy,
      passed: score >= 70 && !critical, outcome: outcome(c, { reaction, addr, s }), next: nextStep(cat), timeline: timeline(c, s),
    };
  }

  function outcome(c, { reaction, addr, s }) {
    const paras = [];
    let map = false;
    const why = [];
    const late = reaction != null && reaction > 30;
    const bname = c.brigade ? brig(c.brigade, s).name : "Расчёт";
    if (!c.closedAt) {
      return { paras: ["Карточка ещё в работе — исход появится, когда расчёт доложит о завершении и карточка будет закрыта."], map: false, why: [] };
    }
    if (c.id === "c1") {
      paras.push(`${bname} вскрыл дверь квартиры 115 на девятом этаже: горела кухня. Пожар потушили, газ на квартиру перекрыли.`);
      if (late) paras.push(`Карточку приняли через ${mmss(reaction)} при нормативе 0:30 — выезд начался на ${Math.round(reaction - 30)} с позже.`);
      if (c.ev.floor?.answer === "ok") paras.push("Этаж вы назвали сразу — расчёт поднялся без поиска.");
      else if (c.ev.arrRang) paras.push("Этаж расчёт искал сам по шести подъездам — около 6 минут, хотя этаж был в описании карточки.");
      if (c.ev.request) {
        const d = c.ev.request.handledAt != null ? c.ev.request.handledAt - c.ev.request.at : null;
        if (d != null && d <= 60) paras.push(`Скорую вы вызвали через ${mmss(d)} после просьбы расчёта. Мужчину 70 лет с отравлением дымом госпитализировали — он жив.`);
        else if (d != null) paras.push(`Скорую вызвали через ${mmss(d)} после просьбы расчёта. Всё это время мужчина без сознания лежал на площадке и ждал помощи. Его госпитализировали.`);
        else paras.push("Скорую по просьбе расчёта вы не вызвали — её вызвал сам расчёт по рации через 7 минут. Всё это время мужчина без сознания ждал помощи на площадке.");
      }
      if (c.ev.news) paras.push(c.ev.news.relayedAt != null ? "Сведения о ребёнке вы передали — расчёт проверил все комнаты. Ребёнка в квартире не было." : "Сведения о ребёнке расчёт не получил и комнаты отдельно не проверял. В этот раз ребёнка в квартире не было.");
      if (c.ev.silence) paras.push(c.ev.silence.checkedAt != null ? "Когда расчёт долго молчал, вы позвонили сами и знали обстановку на месте." : "15 минут расчёт работал без доклада, а вы не знали, что происходит на месте. Случись там беда — вы узнали бы о ней последним.");
      why.push("В комнате с современной мебелью общая вспышка наступает через 3:20–4:50, а на выход у людей меньше 3 минут (UL FSRI).");
      why.push("При остановке дыхания и сердца каждая минута до помощи отнимает шансы выжить (модель Larsen, 1993).");
    }
    if (c.id === "c2") {
      if (c.ev.addrFix && !c.ev.addrFix.before) {
        map = true;
        paras.push(`Адрес ушёл расчёту как «Дубининская» — это другой конец Москвы, 18 км по прямой. ${bname} приехал к офисному центру и потерял около 20 минут на дорогу обратно.`);
        paras.push("За это время дым поднялся по лестнице до восьмого этажа: жильцов верхних этажей выводили через задымлённый подъезд. Пострадавших нет — повезло.");
        paras.push("Ошибку видно было ещё в подсказке улиц: рядом с «Дубининской» стояло «ЮАО, Даниловский», а заявитель звонил из САО.");
      } else if (c.ev.addrFix && c.ev.addrFix.before) {
        map = true;
        paras.push("Адрес ушёл расчёту с ошибкой, но вы заметили её и передали правильный до прибытия. Расчёт развернулся по дороге — потеряно около 5 минут.");
      } else if (addr === "wrong") {
        map = true;
        paras.push("В карточке так и осталась «Дубининская». Следующее звено — руководитель, скорая, полиция — поедет туда же.");
      } else {
        paras.push(`${bname} приехал по адресу сразу: в мусоропроводе тлел мусор. Его потушили, подъезд проветрили. Пострадавших нет.`);
      }
      if (late) paras.push(`Карточку приняли через ${mmss(reaction)} при нормативе 0:30.`);
      why.push("Дубнинская (САО) и Дубининская (ЦАО и ЮАО) — 18 км друг от друга. Заказчик называл путаницу адресов главной опасностью (Q&A 16.09).");
      why.push("Из квартиры с современной мебелью на выход меньше 3 минут (UL FSRI) — минуты дороги решают.");
    }
    if (c.id === "c3") {
      if (c.status === "rejected" && hasAny(c.comments.join(" "), c.def.keys.decision)) paras.push("Вы распознали дубль: по этому адресу уже работает Расчёт 1. Свободный расчёт остался в резерве для других вызовов.");
      else if (c.brigade) paras.push("Карточку приняли как новое происшествие и направили второй расчёт на тот же адрес. У службы не осталось свободных сил на другие вызовы.");
      else paras.push("Это дубль карточки 73120101: тот же дом и тот же дым. Правильно — «Не принята» с причиной «работаем по карточке 73120101».");
      why.push("Дубли — частая картина крупных происшествий: звонят несколько соседей. Лишний расчёт на одном адресе — это пустой район где-то ещё.");
    }
    return { paras, map, why };
  }

  const NEXT_STEP = {
    address: { title: "Разминка «Найди отличие в адресе»", drill: "address", why: "адрес — главная причина, по которой расчёт едет не туда" },
    reaction: { title: "Разминка «Статус по докладу»", drill: "status", why: "быстрее решение — меньше задержка выезда" },
    forces: { title: "Разминка «Кого направить»", drill: "routing", why: "правильные службы и вовремя" },
    brigade: { title: "Повторить ступень 3 «Живая бригада»", drill: null, why: "расчёт ждёт ответа и действий" },
    report: { title: "Разминка «Комментарий за 40 секунд»", drill: "comment", why: "та же схема — где, что, люди — нужна и в докладе" },
    comment: { title: "Разминка «Комментарий за 40 секунд»", drill: "comment", why: "комментарий читает следующее звено" },
  };
  function nextStep(cat) {
    const entries = Object.entries(cat).filter(([, v]) => v != null).sort((a, b) => a[1] - b[1]);
    const [key, value] = entries[0];
    if (value >= 5) return { title: "Ступень 4 «Параллельная работа»", drill: null, why: "все категории на высшем уровне" };
    return { ...NEXT_STEP[key], key };
  }

  const KIND_LABEL = (kind) => KIND[kind]?.label || kind;
  function timeline(c, s) {
    const L = s.log.filter((e) => e.card === c.id);
    const rows = [];
    const at = (e) => e.t - c.deliveredAt;
    for (const e of L) {
      if (e.type === "deliver") rows.push({ t: at(e), text: "Карточка показана в списке" });
      if (e.type === "open") rows.push({ t: at(e), text: "Карточка открыта" });
      if (e.type === "addr") rows.push({ t: at(e), text: `Адрес сохранён: «${e.text}»`, over: e.verdict === "wrong" ? "не тот адрес" : null });
      if (e.type === "status") {
        const over = (e.status === "accepted" || e.status === "rejected") && at(e) > 30 ? "позже норматива 0:30" : null;
        rows.push({ t: at(e), text: `Статус «${D.STATUS_LABELS[e.status]}»${e.comment ? ` — «${e.comment}»` : ""}`, over });
      }
      if (e.type === "dispatch") rows.push({ t: at(e), text: `Направлен ${brig(e.brigade, s).name}` });
      if (e.type === "ring") rows.push({ t: at(e), text: `${e.alarm ? "ТРЕВОГА — " : ""}Расчёт вызывает: ${KIND_LABEL(e.kind)}`, alarm: e.alarm });
      if (e.type === "answer") rows.push({ t: at(e), text: `Ответили через ${mmss(e.wait)}`, play: e.line, over: e.wait > 20 ? "расчёт ждал долго" : null });
      if (e.type === "reply") rows.push({ t: at(e), text: `Вы: «${e.label}»` });
      if (e.type === "callOut") rows.push({ t: at(e), text: `Звонок: ${D.DIRECTORY.find((d) => d.id === e.target).name}` });
      if (e.type === "noanswer") rows.push({ t: at(e), text: "Скорая не отвечает", over: "нужен резервный номер" });
      if (e.type === "doklad") {
        const n = e.dok ? e.dok.n : e.n;
        const name = e.dok ? e.dok.name : D.DIRECTORY.find((d) => d.id === e.target).name;
        rows.push({ t: at(e), text: `Доклад по схеме (${name}): ${n} из 5`, play: e.dok ? e.dok.rec : null, over: n < 5 ? "не всё" : null });
      }
      if (e.type === "brigadeCall") rows.push({ t: at(e), text: "Вы позвонили расчёту" });
      if (e.type === "inject") rows.push({ t: at(e), text: `Вводная преподавателя: ${D.INJECTS.find((i) => i.id === e.id).title}`, inject: true });
    }
    for (const note of s.teacherNotes?.[c.id] || []) rows.push({ t: note.t, text: note.text, note: true });
    return rows.sort((a, b) => a.t - b.t);
  }

  // ---------------------------------------------------------------- пример разбора
  // Готовая смена с типичными ошибками: разбор можно посмотреть, не проходя смену.
  function makeExample() {
    const s = newShift();
    s.phase = "done";
    const mk = (id, at) => ({
      id, def: D.CARDS[id], deliveredAt: at, openedAt: null, status: "received", primaryAt: null,
      statusAt: { received: at }, hist: [], comments: [], crew: "", addrText: "", addrSaved: null, addrWrongEver: false,
      addrAtDispatch: null, brigade: null, dispatchedAt: null, reports: {}, ev: {}, sched: {}, feed: [], closedAt: null,
    });
    const c1 = mk("c1", 3);
    const c2 = mk("c2", 70);
    s.cards = [c1, c2];
    const L = (t, card, type, data = {}) => s.log.push({ t, card, type, ...data });
    L(3, "c1", "deliver"); L(12, "c1", "open");
    L(25, "c1", "addr", { text: "Бескудниковский бульвар, д. 24, кв. 115", verdict: "ok" });
    c1.addrSaved = "Бескудниковский бульвар, д. 24, кв. 115";
    L(51, "c1", "status", { status: "accepted", comment: "Принята, дым из квартиры, пожилой мужчина. Направлен расчёт 1" });
    Object.assign(c1, { primaryAt: 51, status: "completed", brigade: 1, dispatchedAt: 66, addrAtDispatch: c1.addrSaved, openedAt: 12, closedAt: 330 });
    c1.comments = ["Принята, дым из квартиры, пожилой мужчина. Направлен расчёт 1"];
    L(66, "c1", "dispatch", { brigade: 1 });
    L(92, "c1", "callOut", { target: "101" });
    s.doklads.push({ card: "c1", target: "101", name: "Руководитель смены", at: 110, text: D.CARDS.c1.samples["101"], items: { where: true, what: true, people: true, hazards: false, forces: true }, n: 4, rec: null });
    L(110, "c1", "doklad", { target: "101", n: 4 });
    L(118, "c1", "ring", { kind: "departure" }); L(121, "c1", "answer", { kind: "departure", wait: 3, line: "c1_departure" });
    L(127, "c1", "status", { status: "responding" });
    L(137, "c1", "ring", { kind: "floor_query" }); L(141, "c1", "answer", { kind: "floor_query", wait: 4, line: "c1_floor_query" });
    L(150, "c1", "reply", { label: "Девятый этаж" });
    L(156, "c1", "status", { status: "arrived" });
    L(163, "c1", "ring", { kind: "request" }); L(188, "c1", "answer", { kind: "request", wait: 25, line: "c1_request" });
    L(196, "c1", "reply", { label: "Понял, вызываю скорую" });
    L(268, "c1", "callOut", { target: "103" });
    s.doklads.push({ card: "c1", target: "103", name: "Скорая помощь", at: 281, text: D.CARDS.c1.samples["103"], items: { where: true, what: true, people: true, hazards: true, forces: true }, n: 5, rec: null });
    L(281, "c1", "doklad", { target: "103", n: 5 });
    L(206, "c1", "ring", { kind: "works" }); L(212, "c1", "answer", { kind: "works", wait: 6, line: "c1_works" });
    L(219, "c1", "status", { status: "working" });
    L(300, "c1", "ring", { kind: "completion" }); L(304, "c1", "answer", { kind: "completion", wait: 4, line: "c1_completion" });
    L(330, "c1", "status", { status: "completed", comment: "Пожар ликвидирован, мужчина передан скорой" });
    c1.comments.push("Пожар ликвидирован, мужчина передан скорой");
    c1.ev = { arrRang: true, floor: { answer: "ok", at: 150 }, request: { at: 188, ack: 196, handledAt: 281 }, silence: { flaggedAt: 242, missed: true } };
    L(70, "c2", "deliver"); L(74, "c2", "open");
    L(85, "c2", "addr", { text: "Дубининская улица, д. 32", verdict: "wrong" });
    L(92, "c2", "status", { status: "accepted", comment: "Принята. Запах гари в подъезде, жильцы выходят. Направлен расчёт 2" });
    L(97, "c2", "dispatch", { brigade: 2 });
    L(104, "c2", "ring", { kind: "departure" }); L(106, "c2", "answer", { kind: "departure", wait: 2, line: "c2_departure" });
    L(110, "c2", "status", { status: "responding" });
    L(176, "c2", "callOut", { target: "101" });
    s.doklads.push({ card: "c2", target: "101", name: "Руководитель смены", at: 190, text: "Дубининская 32, подъезд 3, запах гари, дым на лестнице, жильцы выходят. Направлен расчёт 2.", items: { where: false, what: true, people: true, hazards: true, forces: true }, n: 4, rec: null });
    L(190, "c2", "doklad", { target: "101", n: 4 });
    L(119, "c2", "ring", { kind: "arrival_wrong" }); L(160, "c2", "answer", { kind: "arrival_wrong", wait: 41, line: "c2_arrival_wrong" });
    L(166, "c2", "reply", { label: "Ошибка в адресе: правильно — улица Дубнинская, 32, это САО" });
    L(171, "c2", "addr", { text: "Дубнинская улица, д. 32", verdict: "ok" });
    L(180, "c2", "ring", { kind: "arrival" }); L(183, "c2", "answer", { kind: "arrival", wait: 3, line: "c2_arrival_ok" });
    L(188, "c2", "status", { status: "arrived" });
    L(197, "c2", "ring", { kind: "works" }); L(200, "c2", "answer", { kind: "works", wait: 3, line: "c2_works" });
    L(204, "c2", "status", { status: "working" });
    L(216, "c2", "ring", { kind: "completion" }); L(219, "c2", "answer", { kind: "completion", wait: 3, line: "c2_completion" });
    L(226, "c2", "status", { status: "completed", comment: "Мусоропровод потушен, пострадавших нет" });
    Object.assign(c2, {
      primaryAt: 92, status: "completed", brigade: 2, dispatchedAt: 97, openedAt: 74, closedAt: 226,
      addrSaved: "Дубнинская улица, д. 32", addrWrongEver: true, addrAtDispatch: "Дубининская улица, д. 32",
      comments: ["Принята. Запах гари в подъезде, жильцы выходят. Направлен расчёт 2", "Мусоропровод потушен, пострадавших нет"],
      ev: { arrRang: true, addrFix: { at: 166, after: true } },
    });
    s.stop = { done: true, active: null, score: 2 };
    s.teacherNotes = {
      c1: [
        { t: 48, text: "Преподаватель: карточку открыли на 9-й секунде, а «Принята» поставили на 48-й. Адрес можно переписать после статуса — сначала решение." },
        { t: 185, text: "Преподаватель: расчёт ждал ответа 25 секунд — в это время вы писали комментарий по второй карточке. Сначала ответьте бригаде, комментарий подождёт." },
      ],
      c2: [{ t: 17, text: "Преподаватель: в подсказке улиц рядом с «Дубининской» было «ЮАО, Даниловский». Сверяйте округ с карточкой." }],
    };
    return s;
  }

  // ---------------------------------------------------------------- проводник
  function guideFor() {
    if (P.scene !== "shift" || !P.guide || P.modal) return null;
    const s = S();
    if (s.phase !== "work" || s.stop.active) return null;
    if (s.ringing.length) {
      const r = s.ringing[0];
      return { sel: `[data-act="answer"][data-id="${r.id}"]`, text: r.alarm ? "Тревога! Ответьте сразу — это важнее всего остального." : "Расчёт вызывает. Ответьте — он ждёт." };
    }
    const call = s.call;
    if (call) {
      if (call.replies) return { sel: ".call-replies", text: "Ответьте расчёту. Подсказка — в описании карточки." };
      if (call.dir === "out" && call.target && call.stage === "talk") return { sel: "#doklad", text: "Доложите по схеме: где, что, люди, опасности, силы. Потом «Положить трубку»." };
      if (call.stage === "result") return { sel: '[data-act="hangup"]', text: "Посмотрите, что попало в доклад, и закройте разговор." };
      if (call.stage === "failed") return { sel: '[data-act="hangup"]', text: "Не отвечают. Положите трубку и звоните по резервному номеру." };
      if (call.canHang) return { sel: '[data-act="hangup"]', text: "Доклад получен. Положите трубку и отметьте статус." };
      return null;
    }
    if (s.view === "list") {
      const fresh = s.cards.find((c) => !c.openedAt);
      if (fresh) return { sel: `[data-row="${fresh.id}"]`, text: "Новая карточка. Откройте её — время реакции уже идёт." };
      const open = s.cards.find((c) => !c.closedAt && needsAction(c));
      if (open) return { sel: `[data-row="${open.id}"]`, text: "По этой карточке есть дело — откройте её." };
      return null;
    }
    const c = cardById(s.view);
    if (!c) return null;
    const phone = (sel, text) => (s.phone ? { sel, text } : { sel: '[data-act="phone"]', text: `${text} Раскройте телефон.` });
    if (c.closedAt) return { sel: '[data-act="review"]', text: "Карточка закрыта. Откройте разбор — там «Что было дальше»." };
    if (c.id === "c3" && c.status === "received")
      return s.form ? { sel: "#status-form", text: "Сравните адрес с карточкой 73120101. Если это то же происшествие — «Не принята» с причиной." } : { sel: '[data-act="tile"]', text: "Похоже на уже знакомый адрес. Щёлкните плитку своей службы." };
    if (!c.addrSaved && c.id !== "c3") return { sel: "#addr-input", text: "Перепишите адрес из карточки и нажмите «Сохранить»." };
    if (c.status === "received" || c.status === "rejected")
      return s.form ? { sel: "#status-form", text: "«Принята», номер наряда и коротко: что, где, люди. Затем ✓." } : { sel: '[data-act="tile"]', text: "Щёлкните плитку своей службы." };
    if (!c.brigade && c.status === "accepted") return phone(".forces", "Отметьте свободный расчёт и нажмите «Направить выбранные».");
    if (c.ev.alarm && c.ev.alarm.call103At == null) return phone('[data-dial="103"]', "Тревога: вызовите скорую — позвоните 103.");
    if (c.ev.noAnswer && c.ev.noAnswer.reserveAt == null) return phone('[data-dial="reserve"]', "Скорая не отвечает — звоните старшему смены по резервному номеру.");
    if (c.ev.request && c.ev.request.handledAt == null) return phone('[data-dial="103"]', "Расчёт просит скорую — позвоните 103 и доложите.");
    if (c.ev.alarm && c.ev.alarm.report101At == null) return phone('[data-dial="101"]', "Доложите о тревоге руководителю смены — 101.");
    if (!S().doklads.some((d) => d.card === c.id && d.target === "101")) return phone('[data-dial="101"]', "Доложите руководителю смены: позвоните 101.");
    if (c.ev.addrQuery && c.ev.addrQuery.pending)
      return addrVerdict(c.def, c.addrSaved || "") === "ok" ? phone(`[data-brig-call="${c.brigade}"]`, "Адрес исправлен — перезвоните расчёту.") : { sel: "#addr-input", text: "Исправьте адрес: сверьте улицу с адресом от 112." };
    if (c.ev.news && c.ev.news.relayedAt == null) return phone(`[data-brig-call="${c.brigade}"]`, "Новые сведения — передайте расчёту.");
    if (c.ev.silence && c.ev.silence.checkedAt == null && !c.reports.completion) return phone(`[data-brig-call="${c.brigade}"]`, "Расчёт давно молчит — позвоните и узнайте обстановку.");
    const next = NEXT[c.status]?.find((st) => NEED[st] && c.reports[NEED[st]]);
    if (next) return s.form ? { sel: "#status-form", text: `Доклад получен — выберите «${D.STATUS_LABELS[next]}» и ✓.` } : { sel: '[data-act="tile"]', text: `Доклад получен — поставьте «${D.STATUS_LABELS[next]}».` };
    const other = s.cards.find((x) => x.id !== c.id && !x.closedAt && (needsAction(x) || !x.openedAt));
    if (other) return { sel: `[data-tab="${other.id}"]`, text: "Расчёт работает. Пока займитесь другой карточкой." };
    return { sel: ".tabs", text: "Расчёт в пути или работает — он позвонит сам." };
  }
  function needsAction(c) {
    if (c.closedAt) return false;
    if (c.status === "received" || !c.addrSaved) return true;
    if (c.status === "accepted" && !c.brigade) return true;
    const next = NEXT[c.status]?.find((st) => NEED[st] && c.reports[NEED[st]]);
    return !!next || (c.ev.request && c.ev.request.handledAt == null) || (c.ev.silence && c.ev.silence.checkedAt == null && !c.reports.completion) || (c.ev.news && c.ev.news.relayedAt == null) || (c.ev.alarm && c.ev.alarm.call103At == null);
  }

  // ================================================================ отрисовка
  function render() {
    const active = document.activeElement;
    const focusId = active && active.id ? active.id : null;
    const selStart = focusId && "selectionStart" in active ? active.selectionStart : null;
    const selEnd = focusId && "selectionEnd" in active ? active.selectionEnd : null;
    const scrolls = {};
    root.querySelectorAll("[data-keep]").forEach((el) => { scrolls[el.dataset.keep] = el.scrollTop; });
    root.innerHTML = view();
    root.querySelectorAll("[data-keep]").forEach((el) => { if (scrolls[el.dataset.keep] != null) el.scrollTop = scrolls[el.dataset.keep]; });
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) {
        el.focus({ preventScroll: true });
        if (selStart != null && "setSelectionRange" in el) { try { el.setSelectionRange(selStart, selEnd); } catch { /* не текстовое поле */ } }
      }
    }
    // После выбора улицы из подсказки — курсор в конец поля, дописывать номер дома.
    if (P.caretEnd) {
      const el = document.getElementById(P.caretEnd);
      P.caretEnd = null;
      if (el) { el.focus({ preventScroll: true }); el.setSelectionRange(el.value.length, el.value.length); }
    }
    placeGuide();
    ticks();
    renderToast();
  }

  function view() {
    return `${protoBar()}<div class="scene${P.scene === "shift" && S().stop.active ? " blurred" : ""}">${sceneView()}</div>${P.scene === "shift" ? stopFrameView() : ""}${modalView()}<div id="guide" class="guide-bubble" hidden></div><div id="toast" class="toast" hidden></div>`;
  }

  function protoBar() {
    const tab = (id, label) => `<button class="pb-tab${P.scene === id ? " on" : ""}" data-act="scene" data-id="${id}">${label}</button>`;
    const injects = P.menu === "inject"
      ? `<div class="pb-menu">${D.INJECTS.map((i) => `<button class="pb-menu-item" data-act="inject" data-id="${i.id}"><b>${esc(i.title)}</b><span>${esc(i.text)}</span></button>`).join("")}</div>`
      : "";
    return `<div class="proto-bar">
      <span class="pb-title" title="Прототип доработок обучения диспетчера ДДС. Все данные — заглушки.">Прототип ДДС <small>заглушки</small></span>
      <nav class="pb-tabs">${tab("shift", "Смена")}${tab("drills", "Разминка")}${tab("teacher", "Пульт преподавателя")}${tab("path", "Мой путь")}${tab("example", "Разбор — пример")}</nav>
      <span class="pb-right">
        <label class="pb-toggle"><input type="checkbox" data-act="toggleGuide" ${P.guide ? "checked" : ""}> Проводник</label>
        <label class="pb-toggle"><input type="checkbox" data-act="toggleSound" ${P.sound ? "checked" : ""}> Звук</label>
        <span class="pb-drop"><button class="pb-btn" data-act="menu" data-id="inject" title="Как у преподавателя на пульте">Вводные ▾</button>${injects}</span>
        <button class="pb-btn" data-act="restart">Начать смену заново</button>
      </span>
    </div>`;
  }

  function sceneView() {
    if (P.scene === "shift") return shellHead() + shiftView();
    if (P.scene === "drills") return shellHead() + drillsView();
    if (P.scene === "teacher") return shellHead("teacher") + teacherView();
    if (P.scene === "path") return shellHead() + pathView();
    return shellHead() + exampleView();
  }

  function shellHead(role) {
    const who = role === "teacher" ? "Пульт преподавателя · Учебный класс УМЦ" : `АРМ ${D.SERVICE.workstation} · Служба ${D.SERVICE.id} — ${D.SERVICE.name} · Обучаемый`;
    return `<header class="shell-head"><span class="sh-brand">Тренажёр ДДС</span><span class="sh-who">${esc(who)}</span><span class="sh-right"><span class="sh-clock" data-tick="clock"></span><button class="sh-btn" disabled>Порядок работы</button><button class="sh-btn" disabled>Выйти</button></span></header>`;
  }

  // ---------------------------------------------------------------- смена
  function shiftView() {
    const s = S();
    if (s.phase === "briefing") return `<div class="arm"><div class="arm-search"><h1>Поиск происшествий</h1></div><div class="arm-empty">Смена ещё не принята.</div></div>`;
    let body;
    if (s.view === "list") body = listView();
    else if (s.view.startsWith("review:")) body = reviewView(evaluate(cardById(s.view.slice(7)), s), s, false);
    else body = cardView(cardById(s.view));
    return `<div class="arm">${s.view === "list" || s.view.startsWith("review:") ? `<div class="arm-search"><h1>Поиск происшествий</h1><div class="arm-search-row"><input disabled placeholder="номер, тип, адрес"><button disabled>сбросить</button></div></div>` : ""}${tabsView()}${ringBar()}${body}</div>${callView()}`;
  }

  function tabsView() {
    const s = S();
    const tabs = s.cards.filter((c) => !c.closedAt).map((c) => {
      const ring = s.ringing.find((r) => r.card === c.id);
      const cls = [s.view === c.id ? "on" : "", !c.openedAt ? "new" : "", ring ? (ring.alarm ? "alarm" : "ring") : ""].join(" ");
      return `<button class="tab ${cls}" data-act="open" data-id="${c.id}" data-tab="${c.id}">${c.def.number}<span class="tab-time" data-tick="tab:${c.id}"></span>${ring ? `<span class="tab-ring">${ring.alarm ? "ТРЕВОГА" : "Расчёт вызывает"}</span>` : ""}</button>`;
    }).join("");
    return `<div class="tabs"><button class="tab${s.view === "list" ? " on" : ""}" data-act="list">Список происшествий</button>${tabs}</div>`;
  }

  function ringBar() {
    const s = S();
    if (!s.ringing.length) return "";
    return s.ringing.map((r) => {
      const c = cardById(r.card);
      const b = brig(r.brigade);
      return `<div class="ringbar${r.alarm ? " alarm" : ""}"><span>${r.alarm ? "⚠ ТРЕВОГА" : "☎"} ${esc(b ? b.name : "Расчёт")} вызывает · карточка ${c.def.number} · ${esc(KIND[r.kind].ring || KIND[r.kind].label)} · ждёт <b data-tick="ring:${r.id}"></b></span><button class="ring-answer" data-act="answer" data-id="${r.id}">Ответить</button></div>`;
    }).join("");
  }

  function listView() {
    const s = S();
    const rows = [...s.cards].reverse().map((c) => {
      return `<tr class="reg-row" data-act="open" data-id="${c.id}" data-row="${c.id}" tabindex="0">
        <td class="reg-chev">⌄</td><td></td><td>${D.SERVICE.workstation}</td><td>${c.def.number}</td><td>01.10.26</td>
        <td class="reg-time" data-tick="clockAt:${c.id}"></td><td>${esc(c.def.klass)}</td><td>${c.def.flags.victims === "да" ? "Да" : "Нет"}</td>
        <td class="reg-addr">${esc(c.def.address112.replace("Россия, ", ""))}</td><td>${D.STATUS_LABELS[c.status]}</td><td class="reg-react" data-tick="react:${c.id}"></td></tr>
        <tr class="reg-desc" data-act="open" data-id="${c.id}"><td></td><td colspan="10"><span class="reg-desc-label">Описание:</span> ${esc(c.def.description)}</td></tr>`;
    }).join("");
    const closed = s.cards.filter((c) => c.closedAt);
    return `<div class="list" data-keep="list">
      <div class="list-head"><h2>Список происшествий ˄</h2>
        <span class="list-actions">
          ${closed.map((c) => `<button class="blue-btn" data-act="review" data-id="${c.id}">Разбор ${c.def.number}</button>`).join("")}
          <button class="grey-btn" data-act="endShift">Завершить смену</button>
        </span>
      </div>
      ${s.cards.length ? `<table class="reg"><thead><tr><th></th><th>ЧС</th><th>АРМ</th><th>Номер</th><th>Дата</th><th>Время</th><th>Тип происшествия</th><th>Постр.</th><th>Адрес</th><th>Статус службы</th><th>Реакция</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="list-wait">Ждём карточки… Первая придёт через несколько секунд.</p>`}
    </div>`;
  }

  function cardView(c) {
    const s = S();
    if (!c) return "";
    const d = c.def;
    const feed = [`<div class="feed-line"><div class="feed-meta">01.10.2026 ${clockAt(c.deliveredAt)} · Оператор 112</div><p>${esc(d.description)}</p></div>`]
      .concat(c.feed.map((f) => `<div class="feed-line feed-new"><div class="feed-meta">01.10.2026 ${clockAt(f.at)} · Оператор 112 · <b>новое</b></div><p>${esc(f.text)}</p></div>`))
      .join("");
    const hist = c.hist.slice(1).map((h) => `<li><b>${clockAt(h.at)}</b> ${D.STATUS_LABELS[h.status]}${h.crew ? ` · наряд ${esc(h.crew)}` : ""}${h.comment ? ` — ${esc(h.comment)}` : ""}</li>`).join("");
    return `<section class="card">
      <div class="card-head">
        <div class="phone-strip"><button class="phone-btn${s.phone ? " on" : ""}" data-act="phone">☎ Телефон ${s.phone ? "▴" : "▾"}</button><span class="phone-off">Отключение</span></div>
        <div class="phones">
          <div class="phone"><span class="ph-label">АОН</span><span>${esc(d.aon)}</span></div>
          <div class="phone"><span class="ph-label">предоставленный</span><span></span></div>
          <div class="phone"><span class="ph-label">телефон на место</span><span></span></div>
        </div>
        <div class="head-info"><strong>Происшествие ${d.number}</strong><span>Сохр. 01.10.2026 в ${clockAt(c.deliveredAt)}</span><span>Опер. 112, АРМ ${D.SERVICE.workstation}</span></div>
        <div class="head-timer" data-tick="head:${c.id}"></div>
        ${c.closedAt ? `<button class="blue-btn" data-act="review" data-id="${c.id}">Разбор</button>` : ""}
        <button class="head-close" data-act="list" title="К списку">✕</button>
      </div>
      ${s.phone ? phonePanel(c) : ""}
      <div class="card-body">
        <div class="col" data-keep="left">
          <div class="box"><span class="box-label">ФИО заявителя</span>${esc(d.caller)}</div>
          <div class="box"><b>${esc(d.address112)}</b></div>
          <div class="feed">${feed}</div>
          ${c.id === "c3" ? "" : addrBlock(c)}
          <div class="history"><h3>История статусов</h3>${hist ? `<ul>${hist}</ul>` : `<p class="muted">Статусов ещё нет.</p>`}</div>
        </div>
        <div class="col">
          <div class="flags-row"><div class="flags">Пострадавшие: ${d.flags.victims} &nbsp; Отказ от скорой: ${d.flags.refused} &nbsp; Заблокированные: ${d.flags.blocked}</div><span class="badge-chs">ЧС</span><span class="badge-chp">ЧП ⚠</span></div>
          <div class="incident"><h3 class="incident-head">Происшествие ${D.SERVICE.id}</h3><div class="tags">${d.tags.map(esc).join(" . ")} .</div><div class="klass">Класс.: <b>${esc(d.klass)}</b> ;</div></div>
          <div class="klass box-white">[ВИС] Класс.:</div>
        </div>
      </div>
      ${servicesBar(c)}
    </section>`;
  }

  function addrBlock(c) {
    const q = norm(c.addrText).replace(/[^а-яa-z0-9 ]/g, " ").trim().split(/\s+/)[0] || "";
    const sugg = c.suggest && q.length >= 3 ? D.STREETS.filter((st) => norm(st.name).startsWith(q) || norm(st.name).includes(q)).slice(0, 6) : [];
    const saved = c.addrSaved ? `<span class="addr-note">Сохранено: «${esc(c.addrSaved)}»</span>` : `<span class="addr-note warn">Адрес не сохранён</span>`;
    return `<div class="addr-block${c.addrSaved ? "" : " empty"}"><span class="box-label">Адрес — ввод диспетчера</span>
      <div class="addr-row"><input id="addr-input" data-bind="addr" data-id="${c.id}" value="${esc(c.addrText)}" placeholder="улица, дом, корпус, квартира" autocomplete="off"><button data-act="saveAddr" data-id="${c.id}">Сохранить</button></div>
      ${sugg.length ? `<div class="suggest">${sugg.map((st) => `<button class="suggest-item" data-act="pickStreet" data-id="${c.id}" data-name="${esc(st.name)}">${esc(st.name)} <span class="suggest-area">${esc(st.area)}</span></button>`).join("")}</div>` : ""}
      ${saved}
    </div>`;
  }

  function servicesBar(c) {
    const s = S();
    const tiles = c.def.services.map((id) => {
      if (id === D.SERVICE.id) {
        const at = c.statusAt[c.status];
        return `<button class="svc-tile own${s.form ? " open" : ""}" data-act="tile" data-id="${c.id}" ${c.closedAt ? "disabled" : ""}><span class="svc-name">Служба ${id}</span><span class="svc-state">${clockAt(at)} ${D.STATUS_LABELS[c.status]}</span></button>`;
      }
      const other = T() - c.deliveredAt > 20 + Number(id.slice(-1)) * 4 ? "Принята" : "Добавлена";
      return `<div class="svc-tile"><span class="svc-name">Служба ${id}</span><span class="svc-state">${clockAt(c.deliveredAt)} ${other}</span></div>`;
    }).join("");
    return `<div class="svc-bar"><span class="svc-label">Службы:</span>${tiles}${s.form && s.form.card === c.id ? statusForm(c) : ""}</div>`;
  }

  function statusForm(c) {
    const s = S();
    const f = s.form;
    const opts = (NEXT[c.status] || []).map((st) => {
      const need = NEED[st];
      const blocked = need && !c.reports[need];
      return `<option value="${st}" ${blocked ? "disabled" : ""} ${f.status === st ? "selected" : ""}>${D.STATUS_LABELS[st]}${blocked ? ` — ждём ${NEED_LABEL[need]}` : ""}</option>`;
    }).join("");
    return `<div class="status-dock"><div class="sf-notes">${f.note ? `<span class="sf-warn">${esc(f.note)}</span>` : ""}</div>
      <div class="status-form" id="status-form">
        <select id="sf-status" data-bind="formStatus"><option value="">— статус —</option>${opts}</select>
        <input id="sf-crew" data-bind="formCrew" value="${esc(f.crew)}" placeholder="номер наряда" size="10">
        <input id="sf-comment" data-bind="formComment" value="${esc(f.comment)}" placeholder="комментарий: что, где, люди, решение" size="44">
        <button class="sf-ok" data-act="saveStatus" title="Сохранить">✓</button><button class="sf-cancel" data-act="closeForm" title="Закрыть">✕</button>
        ${c.status === "received" ? `<button class="sf-sample" data-act="sampleComment" title="Прототип: подставить пример">пример</button>` : ""}
      </div></div>`;
  }

  function phonePanel(c) {
    const s = S();
    const canSend = c.status !== "received" && c.status !== "rejected" && !c.brigade && !c.closedAt;
    const rows = s.brigades.map((b) => {
      const st = brigadeState(b);
      const selectable = b.state === "free" && !b.card && canSend;
      return `<tr class="${st.cls}"><td>${selectable ? `<input type="checkbox" data-bind="pickBrigade" data-id="${b.id}" ${s.pick === b.id ? "checked" : ""}>` : ""}</td><td><b>${b.name}</b><br><small>${b.station}</small></td><td>${st.text}${st.flag ? `<div class="b-flag">⚠ ${st.flag}</div>` : ""}</td><td><button data-act="callBrigade" data-id="${b.id}" data-brig-call="${b.id}">Позвонить</button></td></tr>`;
    }).join("");
    const dir = D.DIRECTORY.map((d) => `<li class="${d.reserve ? "reserve" : ""}"><span><b>${d.phone}</b> ${esc(d.name)}</span><button data-act="dial" data-id="${d.id}" data-dial="${d.id}">Позвонить</button></li>`).join("");
    return `<div class="phone-panel">
      <div class="pp-section forces"><h3>Табло сил · Служба ${D.SERVICE.id} <small>время на месте показано ускоренно ×${ACCEL}</small></h3>
        <table>${rows}</table>
        <button class="blue-btn" data-act="sendBrigade" ${canSend ? "" : "disabled"}>Направить выбранные</button>
        ${c.status === "received" ? `<p class="muted">Направить можно после «Принята».</p>` : ""}
      </div>
      <div class="pp-section"><h3>Справочник</h3><ul class="dir-list">${dir}</ul></div>
    </div>`;
  }

  function brigadeState(b) {
    if (b.state === "repair") return { text: b.note, cls: "off" };
    if (b.state === "busy") return { text: b.note, cls: "off" };
    if (!b.card) return { text: "свободен", cls: "free" };
    const c = cardById(b.card);
    if (!c.reports.departure) return { text: `направлен: ${c.def.number}, ждём доклад о выезде`, cls: "busy" };
    if (!c.reports.arrival) return { text: `в пути: ${c.def.number}`, cls: "busy" };
    const quiet = Math.floor(((T() - (b.lastContact ?? T())) * ACCEL) / 60);
    return { text: `на месте: ${c.def.number} · без доклада <span data-tick="quiet:${b.id}">${quiet}</span> мин`, cls: "busy", flag: c.ev.silence && c.ev.silence.checkedAt == null && !c.reports.completion ? "давно без доклада — позвоните" : null };
  }

  function callView() {
    const call = S().call;
    if (!call) return "";
    const feed = call.feed.map((l) => `<div class="cf-line${l.who === "Вы" ? " me" : ""}"><span class="cf-who">${esc(l.who)}:</span> ${esc(l.text)}</div>`).join("");
    let extra = "";
    if (call.replies) extra = `<div class="call-replies">${call.replies.map((r, i) => `<button class="reply" data-act="reply" data-id="${i}">${esc(r.label)}</button>`).join("")}</div>`;
    if (call.dir === "out" && call.target && call.stage === "talk") {
      const c = cardById(call.card);
      extra = `<div class="scheme"><div class="scheme-head">Доклад по схеме</div>${D.SCHEME.map((it) => `<span class="scheme-item"><b>${it.label}</b> ${it.hint}</span>`).join("")}</div>
        <label class="doklad-label" for="doklad">Ваш доклад <small>в тренажёре речь распознаётся сама; в прототипе — впишите или подставьте пример</small></label>
        <textarea id="doklad" data-bind="doklad" rows="4" placeholder="Говорите или пишите: где, что, люди, опасности, силы">${esc(call.doklad)}</textarea>
        <div class="doklad-tools"><button data-act="sampleDoklad">Пример доклада</button>${"MediaRecorder" in window ? `<button data-act="${call.recording ? "stopRec" : "rec"}">${call.recording ? "■ Остановить запись" : "🎙 Записать голос"}</button>` : ""}<span class="muted">${esc(c.def.number)}</span></div>`;
    }
    if (call.stage === "result" && call.check) {
      const items = D.SCHEME.map((it) => `<span class="scheme-item ${call.check.items[it.key] ? "ok" : "miss"}">${call.check.items[it.key] ? "✓" : "✗"} <b>${it.label}</b> ${it.hint}</span>`).join("");
      const note = !call.check.text && call.check.voiced
        ? "Голос записан. В тренажёре его распознает речь (faster-whisper уже есть в worker), в прототипе проверяется только текст."
        : call.check.n < 5 ? "Пропущенное руководитель не узнает — а решение о силах он принимает по докладу." : "";
      extra = `<div class="scheme result"><div class="scheme-head">Что попало в доклад: ${call.check.n} из 5</div>${items}${note ? `<p class="muted">${note}</p>` : ""}</div>`;
    }
    const canHang = call.dir === "out" || call.canHang || call.stage === "failed";
    const label = call.stage === "result" ? "Закрыть" : "Положить трубку";
    return `<aside class="call${call.alarm ? " alarm" : ""}"><div class="call-head"><b>${esc(call.who)}</b><span data-tick="callTime"></span><span class="muted">${call.stage === "dialing" ? "гудки…" : call.stage === "failed" ? "нет ответа" : "разговор"}</span></div>
      <div class="call-feed" data-keep="callfeed">${feed}</div>${extra}
      <div class="call-actions"><button class="${call.stage === "result" ? "grey-btn" : "hang"}" data-act="hangup" ${canHang ? "" : "disabled"}>${label}</button></div></aside>`;
  }

  function stopFrameView() {
    const sf = S().stop.active;
    if (!sf) return "";
    const qs = sf.q.map((q, i) => `<div class="sf-q"><p><b>${i + 1}.</b> ${esc(q.text)}</p><div class="sf-opts">${q.options.map((o) => {
      const chosen = sf.answers[i] === o;
      const cls = sf.checked ? (o === q.answer ? "ok" : chosen ? "bad" : "") : chosen ? "on" : "";
      return `<button class="sf-opt ${cls}" data-act="sfAnswer" data-q="${i}" data-o="${esc(o)}" ${sf.checked ? "disabled" : ""}>${esc(o)}</button>`;
    }).join("")}</div>${sf.checked ? `<p class="sf-why">${esc(q.why)}</p>` : ""}</div>`).join("");
    const score = sf.q.filter((q, i) => sf.answers[i] === q.answer).length;
    return `<div class="overlay"><div class="stopframe"><h2>Стоп-кадр</h2><p class="muted">Время карточек стоит. Не подглядывайте — ответьте по памяти: так проверяется картина обстановки.</p>${qs}
      <div class="modal-actions">${sf.checked ? `<span>Верно ${score} из 3.</span><button class="blue-btn" data-act="sfClose">Продолжить смену</button>` : `<button class="blue-btn" data-act="sfCheck" ${sf.answers.includes(null) ? "disabled" : ""}>Проверить</button>`}</div></div></div>`;
  }

  // ---------------------------------------------------------------- разбор
  function reviewView(r, s, example) {
    const c = r.card;
    const cats = D.DOR.map((d) => {
      const v = r.cat[d.key];
      if (v == null) return `<div class="cat-row na"><span>${d.label}</span><span class="cat-bar"></span><span class="muted">не требуется</span></div>`;
      return `<div class="cat-row"><span>${d.label}</span><span class="cat-bar">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= v ? "f" : ""}"></i>`).join("")}</span><span class="cat-anchor">${esc(d.anchors[v - 1])}</span></div>`;
    }).join("");
    const work = r.work.length
      ? `<table class="bw-table">${r.work.map((w) => `<tr class="${w.ok ? "ok" : "bad"}"><td>${w.ok ? "✓" : "✗"}</td><td><b>${esc(w.title)}</b></td><td>${esc(w.action)}</td></tr>`).join("")}</table>`
      : `<p class="muted">Событий бригады по этой карточке не было.</p>`;
    const doklads = r.doklads.length
      ? r.doklads.map((d) => `<div class="dk"><div><b>${esc(d.name || d.target)}</b> · ${d.n} из 5 ${d.rec ? `<button class="play-btn" data-act="play" data-id="${esc(d.rec)}">▶ ваш голос</button>` : ""}</div><div class="dk-items">${D.SCHEME.map((it) => `<span class="${d.items[it.key] ? "ok" : "miss"}">${d.items[it.key] ? "✓" : "✗"} ${it.label}</span>`).join("")}</div>${d.text ? `<p class="dk-text">«${esc(d.text)}»</p>` : ""}</div>`).join("")
      : `<p class="muted">Докладов по этой карточке не было.</p>`;
    const tl = r.timeline.map((row) => `<div class="tl-row${row.over ? " over" : ""}${row.note ? " note" : ""}${row.inject ? " inject" : ""}${row.alarm ? " alarm" : ""}"><span class="tl-time">${mmss(row.t)}</span><span class="tl-text">${row.note ? "💬 " : ""}${esc(row.text)}${row.over ? ` <em>${esc(row.over)}</em>` : ""}</span>${row.play ? `<button class="play-btn" data-act="play" data-id="${esc(row.play)}">▶</button>` : ""}</div>`).join("");
    const comment = Object.entries(r.commentItems).map(([k, ok]) => `<span class="${ok ? "ok" : "miss"}">${ok ? "✓" : "✗"} ${{ where: "где", what: "что", people: "люди", decision: "решение" }[k]}</span>`).join("");
    return `<div class="review" data-keep="review">
      <div class="rv-head">${example ? "" : `<button class="grey-btn" data-act="${c.closedAt ? "list" : "open"}" data-id="${c.id}">← назад</button>`}
        <h2>Разбор: ${c.def.number} · ${esc(c.def.title)}</h2>
        <span class="verdict ${r.passed ? "pass" : "fail"}">${r.passed ? "Зачтено" : "Не зачтено"} · ${r.score} %${r.critical ? ` · критическая ошибка: ${esc(r.criticalWhy.join(", "))}` : ""}</span></div>
      <div class="rv-grid">
        <section class="rv-panel outcome"><h3>Что было дальше</h3>${r.outcome.paras.map((p) => `<p>${esc(p)}</p>`).join("")}
          ${r.outcome.map ? mapSvg() : ""}
          <div class="why"><b>Почему это важно.</b> ${r.outcome.why.map(esc).join(" ")}<br><small>Учебная иллюстрация по фактам вашей попытки, не медицинский прогноз.</small></div></section>
        <section class="rv-panel"><h3>По категориям <small>как в отчёте наставника</small></h3>${cats}
          <div class="next-card"><b>Дальше:</b> ${esc(r.next.title)} <small>— ${esc(r.next.why)}</small>${r.next.drill ? `<button class="blue-btn" data-act="goDrill" data-id="${r.next.drill}">Начать</button>` : ""}</div></section>
        <section class="rv-panel"><h3>Работа с бригадой</h3>${work}</section>
        <section class="rv-panel"><h3>Доклады по схеме</h3>${doklads}<h3>Комментарий</h3><div class="dk-items">${comment}</div></section>
        <section class="rv-panel wide"><h3>Лента попытки <small>время от показа карточки; ▶ — голос; 💬 — комментарий преподавателя к моменту</small></h3><div class="timeline">${tl}</div></section>
      </div></div>`;
  }

  function mapSvg() {
    // Координаты из Википедии: Дубнинская 55.876 37.558, Дубининская 55.720 37.635, центр 55.752 37.617.
    const pt = (lat, lon) => [180 + (lon - 37.617) * 62.6 * 8, 170 - (lat - 55.752) * 111.2 * 8];
    const [ax, ay] = pt(55.8758, 37.5575);
    const [bx, by] = pt(55.7197, 37.6347);
    return `<figure class="map"><svg viewBox="0 0 360 340" role="img" aria-label="Схема Москвы: Дубнинская и Дубининская улицы в 18 км друг от друга">
      <ellipse cx="180" cy="170" rx="118" ry="151" class="mkad"/><circle cx="180" cy="170" r="18" class="sadovoe"/>
      <text x="180" y="12" class="map-small" text-anchor="middle">МКАД</text>
      <line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" class="route"/>
      <circle cx="${ax}" cy="${ay}" r="7" class="pt-ok"/><text x="${ax + 10}" y="${ay - 6}" class="map-label">Дубнинская ул., САО — вызов</text>
      <circle cx="${bx}" cy="${by}" r="7" class="pt-bad"/><text x="${bx + 10}" y="${by + 16}" class="map-label">Дубининская ул. — сюда уехал расчёт</text>
      <text x="${(ax + bx) / 2 + 8}" y="${(ay + by) / 2}" class="map-dist">≈ 18 км</text></svg>
      <figcaption>Схема, не карта. В тренажёре — офлайн-карта Москвы (идея 15).</figcaption></figure>`;
  }

  // ---------------------------------------------------------------- модальные окна
  function modalView() {
    const m = P.modal;
    if (!m) return "";
    let head = "", body = "", actions = "";
    if (m.type === "briefing") {
      const b = D.BRIEFING;
      head = "Инструктаж смены";
      body = `<p><b>${b.date}.</b> Служба ${D.SERVICE.id} — ${D.SERVICE.name}, АРМ ${D.SERVICE.workstation}.</p>
        <h4>Обстановка</h4><ul>${b.situation.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        <h4>Силы</h4><ul>${D.BRIGADES.map((x) => `<li><b>${x.name}</b> (${x.station}) — ${x.state === "free" ? "свободен" : esc(x.note)}</li>`).join("")}</ul>
        <h4>На что смотрим сегодня</h4><ul>${b.focus.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        <p class="muted">Прототип: смена — две карточки и живая бригада, около 6 минут. Вводные преподавателя — меню «Вводные» вверху. Лучше в наушниках.</p>`;
      actions = `<button class="blue-btn" data-act="startShift">Принять смену</button>`;
    }
    if (m.type === "confirmComplete") {
      head = "Закрыть карточку?";
      body = `<p>Статус «${D.STATUS_LABELS[m.status]}» закрывает карточку для правок. Итог работ уже в комментарии?</p>`;
      actions = `<button class="grey-btn" data-act="modalClose">Вернуться</button><button class="blue-btn" data-act="confirmComplete">Закрыть карточку</button>`;
    }
    if (m.type === "handover") {
      const open = m.open.map((id) => cardById(id));
      head = "Сдача смены";
      body = open.length
        ? `<p>Незакрытые карточки переходят к сменщику. Напишите по каждой одну-две строки: что сделано и чего ждём.</p>${open.map((c) => `<div class="ho"><b>${c.def.number} · ${esc(c.def.title)}</b> <span class="muted">статус «${D.STATUS_LABELS[c.status]}»</span><textarea id="ho-${c.id}" data-bind="handover" data-id="${c.id}" rows="2" placeholder="например: расчёт 1 на месте, ждём доклад о завершении; скорая вызвана">${esc(m.text[c.id] || "")}</textarea></div>`).join("")}`
        : `<p>Все карточки закрыты — передавать нечего.</p>`;
      actions = `<button class="grey-btn" data-act="modalClose">Вернуться к смене</button><button class="blue-btn" data-act="finishShift">Сдать смену</button>`;
    }
    if (m.type === "summary") {
      const s = S();
      const results = s.cards.map((c) => evaluate(c, s));
      const reactions = results.filter((r) => r.reaction != null).map((r) => r.reaction);
      head = "Итоги смены";
      body = `<table class="sum">${results.map((r) => `<tr><td><b>${r.card.def.number}</b> ${esc(r.card.def.title)}</td><td>${r.card.closedAt ? `<span class="verdict ${r.passed ? "pass" : "fail"}">${r.passed ? "Зачтено" : "Не зачтено"} · ${r.score} %</span>` : `<span class="muted">передана сменщику</span>`}</td><td><button class="grey-btn" data-act="review" data-id="${r.card.id}">Разбор</button></td></tr>`).join("")}</table>
        <p>Реакция в среднем: <b>${reactions.length ? mmss(reactions.reduce((a, b) => a + b, 0) / reactions.length) : "—"}</b> · стоп-кадр: <b>${s.stop.score ?? "—"} из 3</b></p>
        ${Object.entries(s.handover).map(([id, h]) => `<p>Передача по ${cardById(id).def.number}: ${h.items.map((x) => `<span class="${x.ok ? "ok" : "miss"}">${x.ok ? "✓" : "✗"} ${x.label}</span>`).join(" ")}</p>`).join("")}`;
      actions = `<button class="blue-btn" data-act="modalClose">Готово</button>`;
    }
    if (m.type === "classSlide") {
      head = "Разбор с классом";
      body = `<p class="slide-big">5 из 23 записали адрес без ориентира «напротив ТЦ Европарк».</p><p>Рублёвское шоссе — около 8 км внутри МКАД. Без ориентира наряд ищет место вдоль шоссе.</p><p class="muted">Имён на проекторе нет: разбираем ошибку, а не человека. Свой разбор каждый видит у себя.</p>`;
      actions = `<button class="blue-btn" data-act="modalClose">Дальше</button>`;
    }
    return `<div class="modal-back"><div class="modal"><h2>${head}</h2><div class="modal-body">${body}</div><div class="modal-actions">${actions}</div></div></div>`;
  }

  // ---------------------------------------------------------------- пример
  function exampleView() {
    if (!P.example.shift) P.example.shift = makeExample();
    const s = P.example.shift;
    const c = cardById(P.example.card, s);
    const tab = (id) => `<button class="tab${P.example.card === id ? " on" : ""}" data-act="exampleCard" data-id="${id}">${D.CARDS[id].number} · ${esc(D.CARDS[id].title)}</button>`;
    return `<div class="arm"><div class="example-note">Готовая смена с типичными ошибками — чтобы посмотреть разбор, не проходя смену. Свою смену — во вкладке «Смена».</div><div class="tabs">${tab("c1")}${tab("c2")}</div>${reviewView(evaluate(c, s), s, true)}</div>`;
  }

  // ---------------------------------------------------------------- разминка
  function drillsView() {
    const d = P.drill;
    if (!d) {
      const best = store.get("best", {});
      const card = (id, title, text, minutes) => `<div class="drill-card"><h3>${title}</h3><p>${text}</p><p class="muted">${minutes} · ${best[id] ? `ваш лучший: ${esc(best[id])}` : "ещё не проходили"}</p><button class="blue-btn" data-act="drill" data-id="${id}">Начать</button></div>`;
      return `<div class="drills"><h2>Разминка</h2><p class="muted">Короткие упражнения на один навык. Сравнение — только с собой; ошибки вернутся завтра и через три дня.</p>
        <div class="drill-grid">
          ${card("address", "Найди отличие в адресе", "Две записи адреса: одинаковые или нет? Дубнинская и Дубининская, корпус и строение, переставленные цифры.", "10 пар · около 1 минуты")}
          ${card("routing", "Кого направить", "Описание происшествия → отметьте службы. Как ключ происшествия и состав сил в немецких диспетчерских.", "6 происшествий · 2 минуты")}
          ${card("status", "Статус по докладу", "Звучит доклад бригады — выберите статус. «Работы не проводили» — это отказ, а «помощь оказана» — завершение.", "8 докладов · 2 минуты")}
          ${card("comment", "Комментарий за 40 секунд", "Карточка на экране — напишите комментарий для следующего звена: где, что, люди, решение.", "1 карточка · 40 секунд")}
        </div>
        <div class="drill-card wide"><h3>Проверьте себя — по дням</h3><p>Тест по памятке ДДС уже есть в тренажёре. Здесь он стал бы частью разминки: банк на 30–40 вопросов, ошибки возвращаются через день и через три, результаты хранятся на сервере, а не в браузере.</p></div></div>`;
    }
    if (d.kind === "address") return drillAddress(d);
    if (d.kind === "routing") return drillRouting(d);
    if (d.kind === "status") return drillStatus(d);
    return drillComment(d);
  }

  function drillShell(title, body, progress) {
    return `<div class="drills"><div class="drill-top"><button class="grey-btn" data-act="drillMenu">← Разминка</button><h2>${title}</h2><span class="muted">${progress || ""}</span><span class="drill-timer" data-tick="drill"></span></div>${body}</div>`;
  }

  function drillDone(d, scoreText, missed) {
    const best = store.get("best", {});
    const prev = best[d.kind];
    const isBetter = !prev || d.points > (parseInt(prev, 10) || 0);
    if (!d.saved) { if (isBetter) { best[d.kind] = scoreText; store.set("best", best); } d.saved = true; d.better = isBetter; d.prev = prev; }
    return `<div class="drill-result"><p class="slide-big">${esc(scoreText)}</p><p>${d.prev ? (d.better ? `Лучше, чем в прошлый раз (было: ${esc(d.prev)}).` : `Ваш лучший результат: ${esc(d.prev)}.`) : "Первый результат — дальше сравнение с ним."}</p>
      ${missed.length ? `<h4>Вернутся завтра и через 3 дня</h4><ul>${missed.map((m) => `<li>${m}</li>`).join("")}</ul>` : `<p>Ошибок нет.</p>`}
      <button class="blue-btn" data-act="drill" data-id="${d.kind}">Ещё раз</button> <button class="grey-btn" data-act="drillMenu">К разминке</button></div>`;
  }

  function diffMark(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    let j = 0;
    while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
    const mark = (s) => (i >= s.length - j ? esc(s) : `${esc(s.slice(0, i))}<mark>${esc(s.slice(i, s.length - j))}</mark>${esc(s.slice(s.length - j))}`);
    return [mark(a), mark(b)];
  }

  function drillAddress(d) {
    if (d.i >= d.items.length) {
      const right = d.answers.filter((a, i) => a === d.items[i][2]).length;
      d.points = right;
      return drillShell("Найди отличие в адресе", drillDone(d, `${right} из ${d.items.length} за ${mmss(d.finished - d.started)}`, d.items.filter((it, i) => d.answers[i] !== it[2]).map((it) => `${esc(it[0])} / ${esc(it[1])}${it[3] ? ` — ${esc(it[3])}` : ""}`)));
    }
    const [a, b, same, note] = d.items[d.i];
    const shown = d.feedback;
    const [ma, mb] = shown && !same ? diffMark(a, b) : [esc(a), esc(b)];
    return drillShell("Найди отличие в адресе", `<div class="pair"><div class="pair-a">${ma}</div><div class="pair-b">${mb}</div></div>
      ${shown ? `<p class="drill-fb ${shown.ok ? "ok" : "bad"}">${shown.ok ? "Верно." : "Неверно."} ${same ? "Записи одинаковые." : esc(note)}</p>` : `<div class="pair-btns"><button class="big-btn" data-act="pairAnswer" data-id="1">Одинаковые <small>←</small></button><button class="big-btn" data-act="pairAnswer" data-id="0">Разные <small>→</small></button></div>`}`, `${d.i + 1} из ${d.items.length}`);
  }

  function drillRouting(d) {
    if (d.i >= d.items.length) {
      d.points = d.right;
      return drillShell("Кого направить", drillDone(d, `${d.right} из ${d.items.length} без ошибок`, d.missed), "");
    }
    const item = d.items[d.i];
    const picks = d.picks;
    const btns = D.ROUTING_SERVICES.map((svc) => {
      let cls = picks.includes(svc) ? "on" : "";
      if (d.checked) cls = item.key.includes(svc) ? (picks.includes(svc) ? "ok" : "miss") : picks.includes(svc) ? "extra" : "";
      return `<button class="svc-pick ${cls}" data-act="routePick" data-id="${svc}" ${d.checked ? "disabled" : ""}>${svc === "Мослифт" ? "Мослифт" : `Служба ${svc}`}</button>`;
    }).join("");
    return drillShell("Кого направить", `<div class="route-card">${esc(item.text)}</div><div class="routing-svcs">${btns}</div>
      ${d.checked ? `<p class="drill-fb ${d.lastOk ? "ok" : "bad"}">${d.lastOk ? "Верно." : `Нужно: ${item.key.map((k) => (k === "Мослифт" ? k : `Служба ${k}`)).join(", ")}.`}</p><button class="blue-btn" data-act="routeNext">Дальше</button>` : `<button class="blue-btn" data-act="routeCheck" ${picks.length ? "" : "disabled"}>Проверить</button>`}
      <p class="muted">Ключ — службы тренировочных сценариев; в тренажёре — классификатор происшествий 046_24.</p>`, `${d.i + 1} из ${d.items.length}`);
  }

  function drillStatus(d) {
    if (d.i >= d.items.length) {
      d.points = d.right;
      return drillShell("Статус по докладу", drillDone(d, `${d.right} из ${d.items.length}`, d.missed), "");
    }
    const item = d.items[d.i];
    const opts = ["responding", "arrived", "working", "completed", "refused"].map((st) => {
      let cls = "";
      if (d.chosen) cls = st === item.answer ? "ok" : d.chosen === st ? "bad" : "";
      return `<button class="status-opt ${cls}" data-act="statusPick" data-id="${st}" ${d.chosen ? "disabled" : ""}>${D.STATUS_LABELS[st]}</button>`;
    }).join("");
    return drillShell("Статус по докладу", `<div class="route-card"><button class="blue-btn" data-act="play" data-id="${item.line}">▶ Прослушать доклад</button> ${d.chosen ? `<p class="drill-text">«${esc(D.LINES[item.line])}»</p>` : `<p class="muted">Текст появится после ответа. Без звука — включите «Звук» вверху или нажмите «Показать текст».</p><button class="grey-btn" data-act="showText">Показать текст</button>${d.showText ? `<p class="drill-text">«${esc(D.LINES[item.line])}»</p>` : ""}`}</div>
      <div class="status-opts">${opts}</div>${d.chosen ? `<p class="drill-fb ${d.chosen === item.answer ? "ok" : "bad"}">${esc(item.why)}</p><button class="blue-btn" data-act="statusNext">Дальше</button>` : ""}`, `${d.i + 1} из ${d.items.length}`);
  }

  function drillComment(d) {
    const c = D.COMMENT_DRILL;
    const checks = d.checked ? c.checks.map((ch) => ({ ...ch, ok: hasAny(d.text, ch.keys) })) : null;
    if (checks && !d.points) d.points = checks.filter((x) => x.ok).length;
    return drillShell("Комментарий за 40 секунд", `<div class="route-card"><b>Карточка ${c.number}</b> · ${esc(c.address)}<p>${esc(c.description)}</p></div>
      <textarea id="drill-comment" data-bind="drillComment" rows="3" ${d.checked ? "disabled" : ""} placeholder="Принята. Где, что, люди, решение, приметы…">${esc(d.text)}</textarea>
      ${checks ? `<div class="dk-items">${checks.map((x) => `<span class="${x.ok ? "ok" : "miss"}">${x.ok ? "✓" : "✗"} ${x.label}</span>`).join("")}</div>${drillDone(d, `${d.points} из ${c.checks.length} за ${mmss(Math.min(40, d.finished - d.started))}`, checks.filter((x) => !x.ok).map((x) => `${x.label}: ${x.keys.slice(0, 3).join(", ")}…`))}` : `<button class="blue-btn" data-act="commentCheck">Проверить</button>`}`, "40 секунд");
  }

  // ---------------------------------------------------------------- пульт преподавателя
  function teacherView() {
    const t = P.teacher;
    const tab = (id, label) => `<button class="tab${t.tab === id ? " on" : ""}" data-act="teacherTab" data-id="${id}">${label}</button>`;
    let body = "";
    if (t.tab === "live") body = teacherLive();
    if (t.tab === "class") body = teacherClass();
    if (t.tab === "dor") body = teacherDor();
    return `<div class="teacher"><div class="tabs light">${tab("live", "Ход занятия")}${tab("class", "Общее задание · класс сейчас")}${tab("dor", "Вердикт по категориям")}</div>${body}</div>`;
  }

  function myTile() {
    const s = S();
    if (s.phase === "briefing") return { text: "Инструктаж смены", level: "idle" };
    if (s.phase === "done") return { text: "Смена сдана", level: "idle" };
    const ring = s.ringing[0];
    if (ring) return { text: `${ring.alarm ? "ТРЕВОГА · " : ""}бригада ждёт ответа`, level: "late" };
    const open = s.cards.filter((c) => !c.closedAt);
    return { text: open.length ? open.map((c) => `${c.def.number} · ${D.STATUS_LABELS[c.status]}`).join("; ") : "Ждёт карточку", level: open.some((c) => c.status === "received") ? "soon" : "ok" };
  }

  function teacherLive() {
    const t = P.teacher;
    const tiles = D.TRAINEES.map((name, i) => {
      const me = name === null;
      const st = me ? myTile() : D.TRAINEE_STATES[i];
      const n = i + 1;
      const menu = t.menuFor === n ? `<div class="t-menu">${D.INJECTS.map((x) => `<button data-act="teacherInject" data-id="${x.id}" data-arm="${n}"><b>${esc(x.title)}</b><span>${esc(x.text)}</span></button>`).join("")}</div>` : "";
      return `<div class="t-tile ${st.level}${me ? " me" : ""}"><div class="t-arm">АРМ ${n}</div><div class="t-name">${me ? "Вы (вкладка «Смена»)" : esc(name)}</div><div class="t-state">${esc(st.text)}</div><button class="grey-btn small" data-act="teacherMenu" data-id="${n}">Вводная ▾</button>${menu}</div>`;
    }).join("");
    return `<div class="t-body"><p class="muted">Вводная уходит на рабочее место по ходу занятия. АРМ 5 — это вы: отправьте вводную и вернитесь во вкладку «Смена». Остальные места — заглушки.</p><div class="t-tiles">${tiles}</div>
      <div class="legend"><span class="t-dot ok"></span>работает <span class="t-dot soon"></span>скоро норматив <span class="t-dot late"></span>нужна помощь <span class="t-dot idle"></span>ждёт</div></div>`;
  }

  function classSimState() {
    const sim = P.teacher.sim;
    if (!sim) return null;
    const elapsed = Math.min(70, (nowReal() - sim.started) * 3.5);
    const count = (f) => sim.people.filter(f).length;
    return {
      elapsed,
      done: elapsed >= 70,
      opened: count((p) => p.open <= elapsed),
      acceptedIn: count((p) => p.accept <= elapsed && p.accept <= 30),
      accepted: count((p) => p.accept <= elapsed),
      dispatched: count((p) => p.dispatch <= elapsed),
      reported: count((p) => p.report <= elapsed),
      addrErr: count((p) => p.addrErr && p.accept <= elapsed),
      hist: [0, 10, 20, 30, 40, 50].map((lo) => count((p) => p.accept <= elapsed && p.accept >= lo && p.accept < lo + 10)),
    };
  }

  function teacherClass() {
    const ct = D.CLASS_TASK;
    const st = classSimState();
    const bar = (label, n, warn) => `<div class="cb-row"><span>${label}</span><span class="cb-bar${warn ? " warn" : ""}"><i style="width:${(n / ct.total) * 100}%"></i></span><b>${n} из ${ct.total}</b></div>`;
    const unit = st ? 80 / Math.max(1, ...st.hist) : 0;
    const hist = st ? `<svg viewBox="0 0 300 120" class="hist" role="img" aria-label="Время до «Принята»">${st.hist.map((n, i) => `<rect x="${10 + i * 48}" y="${100 - n * unit}" width="40" height="${n * unit}" class="${i >= 3 ? "late" : ""}"/><text x="${30 + i * 48}" y="114" text-anchor="middle">${i * 10}–${i * 10 + 10}</text><text x="${30 + i * 48}" y="${95 - n * unit}" text-anchor="middle">${n || ""}</text>`).join("")}</svg><p class="muted">Секунды до «Принята»; красное — позже 30 с.</p>` : "";
    const scale = st ? st.elapsed / 70 : 0;
    return `<div class="t-body class-board">
      <div class="cb-head"><div><b>Общее задание:</b> карточка ${ct.number} — ${esc(ct.title)} — всем ${ct.total} местам одновременно.</div>
        <div>${st ? (st.done ? "Задание завершено" : `идёт: ${mmss(st.elapsed)}`) : `<button class="blue-btn" data-act="classStart">Запустить у всех</button>`}
        <label class="pb-toggle dark"><input type="checkbox" data-act="followMode" ${P.teacher.follow ? "checked" : ""}> «Делай как я»</label></div></div>
      ${P.teacher.follow ? `<p class="follow-note">«Делай как я»: преподаватель ведёт карточку на проекторе, у обучаемых — та же карточка, шаг преподавателя подсвечен. Обучаемые повторяют, а не ждут.</p>` : ""}
      ${st ? `<div class="cb-grid"><div>${bar("Открыли карточку", st.opened)}${bar("Приняли за 30 с", st.acceptedIn)}${bar("Приняли всего", st.accepted)}${bar("Направили наряд", st.dispatched)}${bar("Доложили руководителю", st.reported)}${bar("Ошибка в адресе", st.addrErr, true)}</div><div>${hist}</div></div>
        <h3>Частые ошибки класса <small>без имён — для проектора</small></h3><ul class="cb-errors">${ct.errors.map((e) => `<li><b>${Math.round(e.count * scale)}</b> ${esc(e.text)}</li>`).join("")}</ul>
        ${st.done ? `<button class="blue-btn" data-act="classSlide">Разобрать с классом</button>` : ""}` : `<p class="muted">Метод заказчика: интерфейс → «делай как я» → одно задание группой → каждому своё. Здесь — третий шаг: одна карточка всем и сводка класса на проектор.</p>`}
    </div>`;
  }

  function teacherDor() {
    if (!P.example.shift) P.example.shift = makeExample();
    const t = P.teacher;
    const r = evaluate(cardById("c1", P.example.shift), P.example.shift);
    if (!t.dor) t.dor = { values: { ...r.cat }, comment: "", at: "3:05" };
    const rows = D.DOR.map((d) => {
      const v = t.dor.values[d.key];
      return `<div class="dor-row"><span class="dor-label">${d.label}<small>авто: ${r.cat[d.key] ?? "—"}</small></span><span class="dor-opts">${[1, 2, 3, 4, 5].map((n) => `<button class="dor-opt${v === n ? " on" : ""}" data-act="dorSet" data-key="${d.key}" data-id="${n}" title="${esc(d.anchors[n - 1])}">${n}</button>`).join("")}</span><span class="dor-anchor">${v ? esc(d.anchors[v - 1]) : "не требуется"}</span></div>`;
    }).join("");
    const times = r.timeline.map((row) => mmss(row.t));
    return `<div class="t-body dor">
      <h3>Обучаемый 03 · карточка 73120101 · Задымление в квартире <small>оценка системы ${r.score} %</small></h3>
      <p class="muted">Как ежедневный отчёт наставника (APCO CTO, модель Сан-Хосе): шесть категорий, у каждой оценки — описание уровня. Система заполняет сама, преподаватель правит за полминуты.</p>
      ${rows}
      <div class="dor-comment"><label>Комментарий к моменту ленты <select id="dor-at" data-bind="dorAt">${[...new Set(times)].map((x) => `<option ${x === t.dor.at ? "selected" : ""}>${x}</option>`).join("")}</select></label>
        <textarea id="dor-text" data-bind="dorComment" rows="2" placeholder="например: расчёт ждал ответа 25 секунд — сначала бригада">${esc(t.dor.comment)}</textarea></div>
      <button class="blue-btn" data-act="dorSave">Сохранить вердикт</button>
      <h3>Так увидит обучаемый</h3><div class="dor-preview">${D.DOR.map((d) => { const v = t.dor.values[d.key]; return v == null ? "" : `<div class="cat-row"><span>${d.label}</span><span class="cat-bar">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= v ? "f" : ""}"></i>`).join("")}</span><span class="cat-anchor">${esc(d.anchors[v - 1])}</span></div>`; }).join("")}</div>
    </div>`;
  }

  // ---------------------------------------------------------------- мой путь
  function pathView() {
    const ex = P.example.shift || (P.example.shift = makeExample());
    const live = S().cards.filter((c) => c.closedAt).map((c) => evaluate(c, S()));
    const last = live.length ? live[live.length - 1] : evaluate(cardById("c2", ex), ex);
    const steps = D.PATH.map((st) => `<div class="step ${st.state}"><span class="step-n">${st.n}</span><div><b>${esc(st.title)}</b>${st.isNew ? ` <span class="step-new">новая</span>` : ""}<br><span class="muted">${esc(st.skill)}</span></div><span class="step-state">${{ passed: "пройдена", current: `текущая · зачтено подряд ${st.streak}`, locked: "закрыта" }[st.state]}</span></div>`).join("");
    const p = P.path;
    const items = D.MAJOR.map((m, i) => {
      const picked = !!p.picks[m.number];
      const res = p.checked && i > 0 ? (picked === m.same ? "ok" : "bad") : "";
      return `<label class="major-item ${res}"><input type="checkbox" data-act="majorPick" data-id="${m.number}" ${picked ? "checked" : ""} ${p.checked || i === 0 ? "disabled" : ""}> <b>${m.number}</b> ${esc(m.text)}${i === 0 ? ` <span class="muted">— первая карточка</span>` : ""}${p.checked && m.note ? `<br><small>${esc(m.note)}</small>` : ""}</label>`;
    }).join("");
    return `<div class="path"><h2>Мой путь</h2>
      <div class="next-card big"><b>Следующее задание по слабому месту:</b> ${esc(last.next.title)} <small>— ${esc(last.next.why)}${live.length ? " (по вашей последней карточке)" : " (по примеру разбора)"}</small>${last.next.drill ? `<button class="blue-btn" data-act="goDrill" data-id="${last.next.drill}">Начать</button>` : ""}</div>
      <div class="steps">${steps}</div>
      <section class="rv-panel"><h3>Ступень 5 «Крупное происшествие» — проба</h3>
        <p>За три минуты пришло шесть карточек. Отметьте те, что про <b>то же происшествие</b>, что и первая. По ним — «Не принята: работаем по карточке 73120201», а руководителю — доклад о крупном происшествии.</p>
        <div class="major">${items}</div>
        ${p.checked ? `<div class="scheme result"><div class="scheme-head">Доклад руководителю о крупном происшествии</div><span class="scheme-item ok"><b>КРУПНОЕ</b> да — пожар в ТЦ, 4 карточки, нужна ЧС</span><span class="scheme-item ok"><b>ГДЕ</b> Ленинградский пр-т, 80, второй этаж</span><span class="scheme-item ok"><b>ЛЮДИ</b> эвакуация, застряли в лифте</span><span class="scheme-item ok"><b>ОПАСНОСТИ</b> дым на втором этаже</span><span class="scheme-item ok"><b>СИЛЫ</b> нужны ещё расчёты, скорая, Мослифт</span></div>` : `<button class="blue-btn" data-act="majorCheck">Проверить</button>`}
        <p class="muted">В тренажёре — серия карточек в реальном времени и доклад по схеме METHANE.</p></section>
      <section class="rv-panel"><h3>Нештатный режим — в ступени 3</h3><p>Служба не берёт трубку, связь с бригадой обрывается, номер руководителя занят. Попробуйте в смене: «Вводные» → «Служба не отвечает», затем позвоните в 103.</p></section>
    </div>`;
  }

  // ================================================================ события
  const actions = {
    scene(d) { setScene(d.id); if (d.id !== "drills") stopVoice(); },
    menu(d) { P.menu = P.menu === d.id ? null : d.id; },
    toggleGuide() { P.guide = !P.guide; },
    toggleSound() { P.sound = !P.sound; if (!P.sound) stopVoice(); },
    restart() { endCall(true); stopVoice(); P.shift = newShift(); P.scene = "shift"; P.modal = { type: "briefing" }; P.menu = null; P.drill = null; },
    inject(d) { P.menu = null; if (P.scene !== "shift") setScene("shift"); inject(d.id); },
    startShift() { const s = S(); s.phase = "work"; s.started = nowReal(); P.modal = null; ac(); },
    list() { const s = S(); s.view = "list"; s.phone = false; s.form = null; },
    open(d) {
      const s = S();
      const c = cardById(d.id);
      if (!c) return;
      s.view = c.id; s.phone = false; s.form = null;
      if (!c.openedAt) { c.openedAt = T(); log(c.id, "open"); }
    },
    review(d) { const s = S(); s.view = `review:${d.id || s.view}`; s.phone = false; s.form = null; P.modal = null; setScene("shift"); },
    phone() { const s = S(); s.phone = !s.phone; s.form = null; },
    tile() { const s = S(); s.form = s.form ? null : { card: s.view, status: "", crew: "", comment: "" }; s.phone = false; },
    closeForm() { S().form = null; },
    sampleComment() { const s = S(); const c = cardById(s.view); s.form.comment = c.def.comment; if (!s.form.crew) s.form.crew = "12"; s.form.status = c.id === "c3" ? "rejected" : "accepted"; },
    saveStatus() {
      const s = S();
      const f = s.form;
      const c = cardById(f.card);
      if (!f.status) { f.note = "Выберите статус."; return; }
      if ((f.status === "rejected" || f.status === "refused") && !f.comment.trim()) { f.note = "Нужен комментарий с причиной."; return; }
      if (f.status === "completed" || f.status === "refused") { P.modal = { type: "confirmComplete", status: f.status }; return; }
      setStatus(c, f.status, f.crew, f.comment.trim());
    },
    confirmComplete() { const s = S(); const f = s.form; P.modal = null; setStatus(cardById(f.card), f.status, f.crew, f.comment.trim()); },
    modalClose() { P.modal = null; },
    saveAddr(d) {
      const c = cardById(d.id);
      if (!c.addrText.trim()) { toast("Впишите адрес."); return; }
      c.addrSaved = c.addrText.trim();
      c.suggest = false;
      const verdict = addrVerdict(c.def, c.addrSaved);
      if (verdict === "wrong") c.addrWrongEver = true;
      log(c.id, "addr", { text: c.addrSaved, verdict });
    },
    pickStreet(d) { const c = cardById(d.id); c.addrText = `${d.name}, д. `; c.suggest = false; P.caretEnd = "addr-input"; },
    sendBrigade() { const s = S(); const c = cardById(s.view); if (!s.pick) { toast("Отметьте свободный расчёт."); return; } dispatch(c, s.pick); s.pick = null; },
    callBrigade(d) { callBrigade(Number(d.id)); },
    dial(d) { dial(d.id); },
    answer(d) { answer(Number(d.id)); },
    reply(d) { reply(Number(d.id)); },
    hangup() { const call = S().call; if (call && call.stage === "result") endCall(false); else hangUp(); },
    sampleDoklad() { const s = S(); const c = cardById(s.call.card); s.call.doklad = c.def.samples[s.call.target.id] || c.def.samples["101"] || ""; },
    rec() { startRecording(); },
    stopRec() { stopRecording(S().call); },
    sfAnswer(d) { S().stop.active.answers[Number(d.q)] = d.o; },
    sfCheck() { S().stop.active.checked = true; },
    sfClose() { closeStopFrame(); },
    endShift() { const s = S(); P.modal = { type: "handover", open: s.cards.filter((c) => !c.closedAt).map((c) => c.id), text: {} }; },
    finishShift() {
      const s = S();
      const m = P.modal;
      for (const id of m.open) {
        const c = cardById(id);
        const text = m.text[id] || "";
        s.handover[id] = { text, items: [
          { label: "что за карточка", ok: hasAny(text, [c.def.number, c.def.expected.stem]) || hasAny(text, ["квартир", "подъезд", "дым", "гар"]) },
          { label: "что сделано", ok: hasAny(text, ["расчет", "направ", "на месте", "принят", "скор"]) },
          { label: "чего ждём", ok: hasAny(text, ["ждем", "ждём", "доклад", "заверш", "ответ"]) },
        ] };
      }
      endCall(true);
      s.ringing = [];
      s.phase = "done";
      s.pausedAt = nowReal();
      s.view = "list";
      P.modal = { type: "summary" };
    },
    play(d) { playClip(d.id); },
    exampleCard(d) { P.example.card = d.id; },
    goDrill(d) { setScene("drills"); startDrill(d.id); },
    drill(d) { startDrill(d.id); },
    drillMenu() { P.drill = null; stopVoice(); },
    pairAnswer(d) { pairAnswer(d.id === "1"); },
    routePick(d) { const dr = P.drill; dr.picks = dr.picks.includes(d.id) ? dr.picks.filter((x) => x !== d.id) : [...dr.picks, d.id]; },
    routeCheck() { const dr = P.drill; const item = dr.items[dr.i]; dr.checked = true; dr.lastOk = item.key.length === dr.picks.length && item.key.every((k) => dr.picks.includes(k)); if (dr.lastOk) dr.right++; else dr.missed.push(esc(item.text)); },
    routeNext() { const dr = P.drill; dr.i++; dr.picks = []; dr.checked = false; },
    statusPick(d) { const dr = P.drill; const item = dr.items[dr.i]; dr.chosen = d.id; if (d.id === item.answer) dr.right++; else dr.missed.push(`«${esc(D.LINES[item.line])}» — ${D.STATUS_LABELS[item.answer]}`); },
    statusNext() {
      const dr = P.drill;
      dr.i++; dr.chosen = null; dr.showText = false;
      const i = dr.i;
      if (i < dr.items.length) setTimeout(() => { if (P.drill === dr && dr.i === i) speak(dr.items[i].line); }, 200);
    },
    showText() { P.drill.showText = true; },
    commentCheck() { const dr = P.drill; dr.checked = true; dr.finished = nowReal(); },
    teacherTab(d) { P.teacher.tab = d.id; P.teacher.menuFor = null; },
    teacherMenu(d) { P.teacher.menuFor = P.teacher.menuFor === Number(d.id) ? null : Number(d.id); },
    teacherInject(d) {
      P.teacher.menuFor = null;
      if (Number(d.arm) === D.SERVICE.workstation) { if (inject(d.id)) toast("Вводная отправлена на АРМ 5 — откройте вкладку «Смена»."); }
      else toast(`Вводная «${D.INJECTS.find((x) => x.id === d.id).title}» отправлена на АРМ ${d.arm} (заглушка).`);
    },
    classStart() {
      const random = rng(23);
      P.teacher.sim = {
        started: nowReal(),
        people: Array.from({ length: D.CLASS_TASK.total }, (_, i) => {
          const open = 2 + random() * 14;
          const accept = open + 6 + random() * (i % 5 === 0 ? 40 : 18);
          return { open, accept, dispatch: accept + 5 + random() * 10, report: accept + 15 + random() * 30 + (i % 6 === 0 ? 40 : 0), addrErr: i % 5 === 2 };
        }),
      };
    },
    followMode() { P.teacher.follow = !P.teacher.follow; },
    classSlide() { P.modal = { type: "classSlide" }; },
    dorSet(d) { P.teacher.dor.values[d.key] = Number(d.id); },
    dorSave() { toast("Вердикт сохранён (заглушка): обучаемый увидит категории и комментарий к моменту ленты."); },
    majorPick(d) { P.path.picks[d.id] = !P.path.picks[d.id]; },
    majorCheck() { P.path.checked = true; },
  };

  function startDrill(kind) {
    stopVoice();
    if (kind === "address") P.drill = { kind, i: 0, items: shuffle(D.ADDRESS_PAIRS), answers: [], started: nowReal(), finished: null, feedback: null };
    if (kind === "routing") P.drill = { kind, i: 0, items: shuffle(D.ROUTING), picks: [], checked: false, right: 0, missed: [], started: nowReal() };
    if (kind === "status") {
      const drill = { kind, i: 0, items: shuffle(D.STATUS_DRILL), chosen: null, right: 0, missed: [], started: nowReal() };
      P.drill = drill;
      setTimeout(() => { if (P.drill === drill && P.scene === "drills") speak(drill.items[0].line); }, 300);
    }
    if (kind === "comment") P.drill = { kind, text: "", checked: false, started: nowReal(), finished: null, points: 0 };
  }

  function pairAnswer(same) {
    const d = P.drill;
    if (!d || d.kind !== "address" || d.feedback) return;
    const ok = same === d.items[d.i][2];
    d.answers.push(same);
    d.feedback = { ok };
    render();
    setTimeout(() => {
      d.feedback = null;
      d.i += 1;
      if (d.i >= d.items.length) d.finished = nowReal();
      render();
    }, ok ? 700 : 1800);
  }

  const binders = {
    addr(value, d) { const c = cardById(d.id); c.addrText = value; c.suggest = true; return true; },
    formStatus(value) { S().form.status = value; S().form.note = ""; },
    formCrew(value) { S().form.crew = value; },
    formComment(value) { S().form.comment = value; },
    doklad(value) { if (S().call) S().call.doklad = value; },
    pickBrigade(value, d, el) { S().pick = el.checked ? Number(d.id) : null; return true; },
    handover(value, d) { P.modal.text[d.id] = value; },
    drillComment(value) { P.drill.text = value; },
    dorComment(value) { P.teacher.dor.comment = value; },
    dorAt(value) { P.teacher.dor.at = value; },
  };

  root.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el) { if (P.menu || P.teacher.menuFor) { P.menu = null; P.teacher.menuFor = null; render(); } return; }
    const act = el.dataset.act;
    if (!actions[act]) return;
    if (el.tagName === "INPUT" && el.type === "checkbox") { /* переключатели — через change */ }
    actions[act](el.dataset, e);
    render();
  });
  root.addEventListener("input", (e) => {
    const el = e.target;
    const key = el.dataset.bind;
    if (!key || !binders[key]) return;
    if (binders[key](el.type === "checkbox" ? el.checked : el.value, el.dataset, el)) render();
  });
  root.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.bind === "formStatus" || el.dataset.bind === "dorAt") binders[el.dataset.bind](el.value, el.dataset, el);
  });
  root.addEventListener("keydown", (e) => {
    const el = e.target;
    if (e.key === "Enter" && el.id === "addr-input") { actions.saveAddr({ id: el.dataset.id }); render(); }
    if ((e.key === "Enter" || e.key === " ") && el.classList && el.classList.contains("reg-row")) { e.preventDefault(); actions.open(el.dataset); render(); }
  });
  document.addEventListener("keydown", (e) => {
    if (P.scene === "drills" && P.drill && P.drill.kind === "address" && !P.drill.feedback && P.drill.i < P.drill.items.length) {
      if (e.key === "ArrowLeft") pairAnswer(true);
      if (e.key === "ArrowRight") pairAnswer(false);
    }
    if (e.key === "Escape") { P.menu = null; P.teacher.menuFor = null; const s = S(); if (s.form) s.form = null; else if (s.phone) s.phone = false; render(); }
  });
  window.addEventListener("resize", placeGuide);
  root.addEventListener("scroll", placeGuide, true);

  // ---------------------------------------------------------------- тики
  function clockAt(t) {
    if (t == null) return "";
    const total = 8 * 3600 + Math.round(t);
    return `${String(Math.floor(total / 3600)).padStart(2, "0")}:${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  }
  function reactionText(c) {
    if (c.primaryAt != null) return { text: c.closedAt ? "закрыта" : `в работе ${mmss(T() - c.deliveredAt)}`, cls: "" };
    const r = T() - c.deliveredAt;
    return { text: `реакция ${mmss(r)}`, cls: r > 30 ? "t-late" : r > 25 ? "t-soon" : "" };
  }
  function ticks() {
    const s = S();
    root.querySelectorAll("[data-tick]").forEach((el) => {
      const [kind, id] = el.dataset.tick.split(":");
      let out = null;
      if (kind === "clock") out = { text: P.scene === "teacher" ? "08:00 · занятие идёт" : clockAt(T()) };
      if (kind === "clockAt") out = { text: clockAt(cardById(id)?.deliveredAt) };
      if (kind === "react" || kind === "tab" || kind === "head") { const c = cardById(id); if (c) out = reactionText(c); }
      if (kind === "ring") { const r = s.ringing.find((x) => String(x.id) === id); if (r) out = { text: mmss(T() - r.at) }; }
      if (kind === "callTime" && s.call) out = { text: mmss(T() - s.call.startedAt) };
      if (kind === "quiet") { const b = brig(Number(id)); if (b) out = { text: String(Math.floor(((T() - (b.lastContact ?? T())) * ACCEL) / 60)) }; }
      if (kind === "drill" && P.drill) {
        const d = P.drill;
        if (d.kind === "comment" && !d.checked) {
          const left = 40 - (nowReal() - d.started);
          out = { text: `осталось ${mmss(Math.max(0, left))}`, cls: left < 10 ? "t-late" : "" };
          if (left <= 0) { d.checked = true; d.finished = nowReal(); setTimeout(render, 0); }
        } else if (d.kind === "address" && d.finished == null) out = { text: mmss(nowReal() - d.started) };
      }
      if (out) {
        if (el.textContent !== out.text) el.textContent = out.text;
        el.classList.toggle("t-late", out.cls === "t-late");
        el.classList.toggle("t-soon", out.cls === "t-soon");
      }
    });
  }

  function placeGuide() {
    const bubble = document.getElementById("guide");
    if (!bubble) return;
    root.querySelectorAll(".guide-ring").forEach((el) => el.classList.remove("guide-ring"));
    const g = guideFor();
    const target = g && root.querySelector(g.sel);
    if (!g || !target || !target.getClientRects().length) { bubble.hidden = true; return; }
    target.classList.add("guide-ring");
    bubble.hidden = false;
    if (bubble.dataset.text !== g.text) { bubble.textContent = g.text; bubble.dataset.text = g.text; }
    const box = target.getBoundingClientRect();
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    const below = box.bottom + h + 14 < window.innerHeight;
    const top = below ? box.bottom + 10 : Math.max(8, box.top - h - 10);
    const left = Math.min(window.innerWidth - w - 8, Math.max(8, box.left + box.width / 2 - w / 2));
    bubble.style.top = `${top}px`;
    bubble.style.left = `${left}px`;
    bubble.classList.toggle("above", !below);
    bubble.style.setProperty("--arrow", `${Math.min(w - 16, Math.max(16, box.left + box.width / 2 - left))}px`);
  }

  function renderToast() {
    const el = document.getElementById("toast");
    if (!el) return;
    if (P.toast && P.toast.until > nowReal()) { el.hidden = false; el.textContent = P.toast.text; }
    else { el.hidden = true; P.toast = null; }
  }

  setInterval(() => {
    if (director()) render();
    else { ticks(); placeGuide(); }
    if (P.toast && P.toast.until <= nowReal()) renderToast();
    if (P.scene === "teacher" && P.teacher.tab === "class" && P.teacher.sim && !classSimState().done) render();
    if (P.scene === "teacher" && P.teacher.tab === "live") {
      const el = root.querySelector(".t-tile.me .t-state");
      if (el) el.textContent = myTile().text;
    }
  }, 250);

  // Для автопроверки прототипа (check.cjs): снимок состояния без ссылок на объекты.
  window.__ddsProto = {
    snapshot() {
      const s = S();
      return {
        scene: P.scene, modal: P.modal && P.modal.type, view: s.view, phase: s.phase, phone: s.phone, form: !!s.form, stop: !!s.stop.active,
        ringing: s.ringing.map((r) => ({ id: r.id, kind: r.kind, alarm: r.alarm, card: r.card })),
        call: s.call && { dir: s.call.dir, stage: s.call.stage, replies: !!s.call.replies, canHang: !!s.call.canHang, target: s.call.target && s.call.target.id, card: s.call.card },
        cards: s.cards.map((c) => ({
          id: c.id, status: c.status, opened: !!c.openedAt, addr: c.addrSaved, closed: !!c.closedAt, brigade: c.brigade,
          reports: Object.keys(c.reports), ev: JSON.parse(JSON.stringify(c.ev)),
          doklad101: s.doklads.some((d) => d.card === c.id && d.target === "101"),
          next: (NEXT[c.status] || []).find((st) => NEED[st] && c.reports[NEED[st]]) || null,
        })),
        brigades: s.brigades.map((b) => ({ id: b.id, state: b.state, card: b.card })),
      };
    },
  };

  P.modal = { type: "briefing" };
  render();
})();
