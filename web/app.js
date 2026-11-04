// 出席カード：画面の処理（中核処理は core.js）
(function () {
  "use strict";
  const C = window.AttendanceCore;
  const $ = id => document.getElementById(id);
  const LS = { key: "attcard.key", courses: "attcard.courses", form: "attcard.formurl" };

  let key = null;        // Uint8Array
  let courses = {};      // {id: name}
  let cards = [];        // [{code, url, date, number, course, course_name}]
  let cardsFileName = "";
  let respRows = null, respName = "", decoded = null;

  // ---------- 共通 ----------
  function msg(id, text, cls) {
    const el = $(id);
    el.textContent = text;
    el.className = "msg" + (cls ? " " + cls : "");
  }

  function download(name, text, bom) {
    const blob = new Blob([(bom ? "﻿" : "") + text], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function readFile(input) {
    return new Promise((resolve, reject) => {
      const f = input.files[0];
      if (!f) return reject(new Error("ファイルが選ばれていません"));
      const r = new FileReader();
      r.onload = () => resolve({ name: f.name, text: r.result });
      r.onerror = () => reject(r.error);
      r.readAsText(f, "utf-8");
    });
  }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const compact = iso => iso.replace(/-/g, "");

  // ---------- タブ ----------
  document.querySelectorAll("nav button").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach(x => x.classList.toggle("active", x === b));
    document.querySelectorAll("section.tab").forEach(s => s.classList.toggle("active", s.id === "tab-" + b.dataset.tab));
  }));

  // ---------- 秘密鍵 ----------
  function setKey(k, source) {
    key = k;
    const st = $("keystatus");
    st.textContent = key ? `秘密鍵：読み込み済み（${source}）` : "秘密鍵：未読み込み";
    st.className = key ? "ok" : "bad";
    ["gen", "check"].forEach(id => { $(id).disabled = !key; });
    $("decode").disabled = !key || !respRows;
    if (key && $("keyremember").checked) localStorage.setItem(LS.key, toHex(key));
  }
  const toHex = b => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");

  $("keyfile").addEventListener("change", async e => {
    try {
      const { name, text } = await readFile(e.target);
      const k = C.parseKeyHex(text);
      if (!k) throw new Error("鍵ファイルの形式が正しくありません（16進数の文字列のはずです）");
      setKey(k, name);
      msg("keymsg", `${name} を読み込みました。`, "ok");
    } catch (err) { msg("keymsg", err.message, "bad"); }
  });

  $("keygen").addEventListener("click", () => {
    if (key && !confirm("既に鍵が読み込まれています。新しい鍵を作ると，今の鍵で作ったカードは新しい鍵ではデコードできません。続けますか？")) return;
    const hex = C.newKeyHex();
    download("secret.key", hex + "\n");
    setKey(C.parseKeyHex(hex), "新規作成");
    msg("keymsg", "新しい鍵を作成し，secret.key としてダウンロードしました。必ずバックアップしてください。", "ok");
  });

  $("keyremember").addEventListener("change", e => {
    if (e.target.checked && key) localStorage.setItem(LS.key, toHex(key));
    if (!e.target.checked) localStorage.removeItem(LS.key);
  });
  $("keyforget").addEventListener("click", () => {
    localStorage.removeItem(LS.key);
    $("keyremember").checked = false;
    msg("keymsg", "このブラウザに記憶した鍵を消しました（今開いているページでは引き続き使えます）。", "ok");
  });

  // ---------- フォームURL ----------
  $("formurl").value = localStorage.getItem(LS.form) || "";
  $("formurl").addEventListener("change", e => localStorage.setItem(LS.form, e.target.value.trim()));

  // ---------- 授業ID表 ----------
  function saveCourses() {
    localStorage.setItem(LS.courses, JSON.stringify(courses));
    renderCourses();
  }

  function renderCourses() {
    const ids = Object.keys(courses).map(Number).sort((a, b) => a - b);
    $("coursetable").tBodies[0].innerHTML = ids.length
      ? ids.map(i => `<tr><td>${i}</td><td>${esc(courses[i])}</td>`
        + `<td><button class="btn" data-del="${i}">削除</button></td></tr>`).join("")
      : `<tr><td colspan="3" class="note">まだ登録はありません</td></tr>`;
    const sel = $("gcourse"), cur = sel.value;
    sel.innerHTML = ids.map(i => `<option value="${i}">${i}：${esc(courses[i])}</option>`).join("")
      + `<option value="manual">番号を直接指定（未登録）</option>`;
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
    $("gcourseidwrap").classList.toggle("hidden", sel.value !== "manual");
  }

  $("coursetable").addEventListener("click", e => {
    const id = e.target.dataset.del;
    if (id === undefined) return;
    if (!confirm(`ID ${id}（${courses[id]}）を削除しますか？\nこのIDのカードを配っている場合，デコード結果に授業名が出なくなります。`)) return;
    delete courses[id];
    saveCourses();
  });

  $("cadd").addEventListener("click", () => {
    const name = $("cname").value.trim();
    const idText = $("cid").value.trim();
    if (!name) return msg("coursemsg", "授業名を入れてください。", "bad");
    if (/^\d+$/.test(name)) return msg("coursemsg", "授業名を数字だけにはできません（番号と区別がつかないため）。", "bad");
    if (Object.values(courses).includes(name)) return msg("coursemsg", `「${name}」は既に登録されています。`, "bad");
    const ids = Object.keys(courses).map(Number);
    const id = idText === "" ? Math.max(0, ...ids) + 1 : Number(idText);
    if (!(Number.isInteger(id) && id >= 0 && id < 256)) return msg("coursemsg", "授業IDは 0〜255 です。", "bad");
    if (id in courses) return msg("coursemsg", `ID ${id} は既に「${courses[id]}」に使われています。`, "bad");
    courses[id] = name;
    saveCourses();
    $("cname").value = ""; $("cid").value = "";
    msg("coursemsg", `ID ${id} = ${name} を登録しました。`, "ok");
  });

  $("coursefile").addEventListener("change", async e => {
    try {
      const { name, text } = await readFile(e.target);
      courses = C.parseCourses(text);
      saveCourses();
      msg("coursemsg", `${name} から ${Object.keys(courses).length} 件を読み込みました。`, "ok");
    } catch (err) { msg("coursemsg", err.message, "bad"); }
  });

  $("coursesave").addEventListener("click", () => download("courses.csv", C.coursesToCSV(courses), true));
  $("gcourse").addEventListener("change", renderCourses);

  // ---------- カード作成 ----------
  const kind = () => document.querySelector("input[name=kind]:checked").value;
  document.querySelectorAll("input[name=kind]").forEach(r => r.addEventListener("change", () => {
    const nodate = kind() === "nodate";
    document.querySelectorAll(".dated-only").forEach(el => el.classList.toggle("hidden", nodate));
    $("gtitle").value = nodate ? "発言カード" : "出席カード";
    $("gnotice").value = nodate ? "※1枚1回限り" : "※当日のみ有効・1枚1回限り";
  }));
  $("gdate").value = C.todayISO();

  $("gen").addEventListener("click", () => {
    try {
      const formUrl = $("formurl").value.trim();
      if (!formUrl) throw new Error("フォームURLが入っていません（「準備」タブで自分のフォームの事前入力URLを貼ってください）。");
      if (!/=$/.test(formUrl)) throw new Error("フォームURLが「=」で終わっていません（「準備」タブで確認してください）。");
      const count = Number($("gcount").value), start = Number($("gstart").value);
      if (!(Number.isInteger(count) && count >= 1)) throw new Error("枚数は1以上の整数にしてください。");
      if (!(Number.isInteger(start) && start >= 0 && start + count - 1 < 65536)) throw new Error("番号は 0〜65535 の範囲にしてください。");
      const course = $("gcourse").value === "manual" ? Number($("gcourseid").value) : Number($("gcourse").value);
      if (!(Number.isInteger(course) && course >= 0 && course < 256)) throw new Error("授業IDは 0〜255 です。");

      let dates;
      if (kind() === "nodate") {
        dates = [null];
      } else {
        const first = $("gdate").value || C.todayISO();
        const repeat = Number($("grepeat").value), interval = Number($("ginterval").value);
        if (!(Number.isInteger(repeat) && repeat >= 1)) throw new Error("回数は1以上の整数にしてください。");
        if (!(Number.isInteger(interval) && interval >= 1)) throw new Error("間隔は1以上の整数にしてください。");
        dates = Array.from({ length: repeat }, (_, i) => C.addDays(first, interval * i));
      }

      const name = courses[course] || "";
      cards = [];
      for (const date of dates) {
        for (let no = start; no < start + count; no++) {
          const code = C.encode(key, date, no, course);
          cards.push({ code, url: formUrl + code, date: date || "", number: no, course, course_name: name });
        }
      }
      cardsFileName = dates[0] === null ? `cards_nodate_${start}-${start + count - 1}.csv`
        : dates.length === 1 ? `cards_${compact(dates[0])}.csv`
        : `cards_${compact(dates[0])}-${compact(dates[dates.length - 1])}.csv`;
      renderSheets();
      msg("genmsg", `${dates.length} 回分 × ${count} 枚（計 ${cards.length} 枚）を作成しました。下のプレビューを確認して印刷してください。`, "ok");
    } catch (err) { msg("genmsg", err.message, "bad"); }
  });

  // Python 版で作ったカードCSVの読み込み（そのまま印刷）
  $("cardsfile").addEventListener("change", async e => {
    try {
      const { name, text } = await readFile(e.target);
      const rows = C.parseCSV(text);
      const h = rows[0];
      if (!h || h[0] !== "code") throw new Error("カードCSV（cards_*.csv）ではないようです。");
      cards = rows.slice(1).map(r => {
        const o = {};
        h.forEach((k, i) => { o[k] = r[i] || ""; });
        o.number = Number(o.number); o.course = Number(o.course);
        if (!o.course_name) o.course_name = courses[o.course] || "";
        return o;
      });
      const nodate = cards.length && !cards[0].date;
      $("gtitle").value = nodate ? "発言カード" : "出席カード";
      $("gnotice").value = nodate ? "※1枚1回限り" : "※当日のみ有効・1枚1回限り";
      cardsFileName = name;
      renderSheets();
      msg("genmsg", `${name} から ${cards.length} 枚を読み込みました（カードの名前・注意書きは上の欄の値を使います）。`, "ok");
    } catch (err) { msg("genmsg", err.message, "bad"); }
  });

  // ---------- 印刷レイアウト ----------
  const L = { cardW: 91, cardH: 55, mx: 14, my: 10, cols: 2, rows: 5 }; // mm
  const PER_SHEET = L.cols * L.rows;

  function qrSvg(text) {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return `<svg class="qr" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"><path d="${d}"/></svg>`;
  }

  function cardHtml(card, title, notice) {
    let big;
    if (card.date) {
      const [y, m, d] = card.date.split("-");
      big = `${y}年${m}月${d}日`;
    } else big = title;
    return `<div class="title"><b>${esc(title)}</b>：下記のQRコードからアクセスし，フォームに記入してください．</div>
      <div class="body">${qrSvg(card.url)}
        <div class="side">
          ${card.course_name ? `<div class="course">${esc(card.course_name)}</div>` : ""}
          <div class="big">${esc(big)}</div>
          <div class="codelabel">QRが読めない場合のコード：</div>
          <div class="code">${esc(card.code)}</div>
        </div></div>
      <div class="foot"><span class="notice">${esc(notice)}</span><span>No. ${card.number}</span></div>`;
  }

  function renderSheets() {
    const title = $("gtitle").value.trim() || "出席カード";
    const notice = $("gnotice").value.trim();
    let guides = "";
    for (let i = 0; i <= L.cols; i++) guides += `<div class="guide-v" style="left:${L.mx + i * L.cardW}mm"></div>`;
    for (let j = 0; j <= L.rows; j++) guides += `<div class="guide-h" style="top:${L.my + j * L.cardH}mm"></div>`;
    const html = [];
    for (let s = 0; s < cards.length; s += PER_SHEET) {
      const items = cards.slice(s, s + PER_SHEET).map((c, k) => {
        const col = k % L.cols, row = Math.floor(k / L.cols);
        return `<div class="card" style="left:${L.mx + col * L.cardW}mm;top:${L.my + row * L.cardH}mm">${cardHtml(c, title, notice)}</div>`;
      });
      html.push(`<div class="sheet">${guides}${items.join("")}</div>`);
    }
    $("sheets").innerHTML = html.join("");
    $("printpanel").classList.toggle("hidden", !cards.length);
    msg("printmsg", `A4 ${html.length} 枚になります。`);
  }

  ["gtitle", "gnotice"].forEach(id => $(id).addEventListener("change", () => { if (cards.length) renderSheets(); }));
  $("print").addEventListener("click", () => window.print());
  $("savecards").addEventListener("click", () => {
    const head = ["code", "url", "date", "number", "course", "course_name"];
    download(cardsFileName || "cards.csv", C.toCSV([head, ...cards.map(c => head.map(k => c[k]))]));
  });

  // ---------- デコード ----------
  $("respfile").addEventListener("change", async e => {
    try {
      const { name, text } = await readFile(e.target);
      respRows = C.parseCSV(text);
      if (respRows.length < 1) throw new Error("空のファイルです。");
      respName = name;
      $("respcol").innerHTML = `<option value="">自動検出</option>`
        + respRows[0].map((h, j) => `<option value="${j}">${esc(h)}</option>`).join("");
      $("decode").disabled = !key;
      msg("decmsg", `${name}：回答 ${respRows.length - 1} 件。「デコード」を押してください。`);
    } catch (err) { respRows = null; msg("decmsg", err.message, "bad"); }
  });

  $("decode").addEventListener("click", () => {
    const v = $("respcol").value;
    const res = C.decodeResponses(key, respRows, courses, v === "" ? null : Number(v));
    decoded = res.rows;
    $("respcol").value = String(res.column);
    const body = decoded.slice(1);
    const nOk = body.filter(r => r[r.length - 1] === "OK").length;
    const nDup = body.filter(r => r[r.length - 1].startsWith("重複")).length;
    const nBad = body.length - nOk - nDup;
    msg("decmsg", `コード列：「${respRows[0][res.column]}」\n${body.length} 件中 OK ${nOk} 件・重複 ${nDup} 件・不正コード ${nBad} 件`,
      nBad || nDup ? "" : "ok");
    const h = decoded[0];
    $("dectable").innerHTML = `<thead><tr>${h.map(x => `<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>`
      + body.map(r => {
        const st = r[r.length - 1];
        const cls = st === "OK" ? "ok" : "bad";
        return `<tr>${r.map((x, i) => `<td title="${esc(x)}"${i === r.length - 1 ? ` class="${cls}"` : ""}>${esc(x)}</td>`).join("")}</tr>`;
      }).join("") + "</tbody>";
    $("decresult").classList.remove("hidden");
    $("savedecoded").disabled = false;
  });

  $("savedecoded").addEventListener("click", () => {
    const base = respName.replace(/\.csv$/i, "");
    download(`${base}_decoded.csv`, C.toCSV(decoded), true);
  });

  // ---------- 単発の確認 ----------
  function doCheck() {
    const t = $("checkcode").value;
    const res = C.decode(key, C.extractCode(t) || t);
    if (!res) return msg("checkmsg", "不正なコードです", "bad");
    const name = courses[res.course];
    msg("checkmsg", `日付 ${res.date || "なし"}　カードNo ${res.number}　授業ID ${res.course}${name ? `（${name}）` : ""}`, "ok");
  }
  $("check").addEventListener("click", doCheck);
  $("checkcode").addEventListener("keydown", e => { if (e.key === "Enter" && key) doCheck(); });

  // ---------- 起動時 ----------
  try { courses = JSON.parse(localStorage.getItem(LS.courses) || "{}"); } catch (e) { courses = {}; }
  renderCourses();
  const saved = localStorage.getItem(LS.key);
  if (saved && C.parseKeyHex(saved)) {
    $("keyremember").checked = true;
    setKey(C.parseKeyHex(saved), "ブラウザに記憶した鍵");
  }
})();
