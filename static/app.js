/* SuperSoft - front end (vanilla JS, works offline) */
"use strict";

// ---------------------------------------------------------------- helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const NF = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NF0 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const money = v => "₹" + NF.format(+v || 0);
const m2 = v => NF.format(+v || 0);
const qf = v => NF0.format(+v || 0);
const todayStr = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const shiftDate = (s, days) => { const d = new Date(s + "T00:00:00"); d.setDate(d.getDate() + days); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const dmy = s => s ? `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}` : "";
const opt = (v, l, sel) => `<option value="${esc(v)}" ${String(v) === String(sel ?? "") ? "selected" : ""}>${esc(l)}</option>`;
const store = {
  get(k, d) { try { const v = localStorage.getItem("sangam_" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("sangam_" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const NOT_RUNNING = "SuperSoft engine is not running. Double-click \"Start SuperSoft.bat\" and use the page it opens (http://127.0.0.1:8765).";
async function api(fn, body = {}) {
  if (location.protocol === "file:") throw new Error(NOT_RUNNING);
  let r;
  try {
    r = await fetch("/api/" + fn, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error(NOT_RUNNING);
  }
  const j = await r.json();
  if (r.status === 401 && j.auth) { showLogin(); throw new Error("Please log in again"); }
  if (!j.ok) throw new Error(j.error || "Error");
  return j.data;
}
async function guard(fn) {
  try { return await fn(); } catch (e) { toast(e.message, "err"); return undefined; }
}
function toast(msg, kind = "") {
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.textContent = msg;
  $("#toast-root").appendChild(t);
  setTimeout(() => t.remove(), kind === "err" ? 6000 : 3000);
}

// ---------------------------------------------------------------- modal
let modalStack = [];
function modal({ title, body, foot = "", wide = false, onClose }) {
  const wrap = document.createElement("div");
  wrap.className = "backdrop";
  wrap.innerHTML = `<div class="modal ${wide ? "wide" : ""}"><div class="mh">${esc(title)}<button class="x" data-x>×</button></div>
    <div class="mb">${body}</div>${foot ? `<div class="mf">${foot}</div>` : ""}</div>`;
  $("#modal-root").appendChild(wrap);
  const m = { el: wrap, close() { wrap.remove(); modalStack = modalStack.filter(x => x !== m); onClose && onClose(); } };
  modalStack.push(m);
  $("[data-x]", wrap).onclick = () => m.close();
  wrap.addEventListener("mousedown", e => { if (e.target === wrap) m.close(); });
  setTimeout(() => { const f = $("input:not([type=checkbox]),select,textarea", wrap); f && f.focus(); }, 30);
  return m;
}
function confirmBox(title, text, okLabel = "Yes") {
  return new Promise(res => {
    const m = modal({ title, body: `<div>${text}</div>`, foot: `<button data-no>No</button><button class="primary" data-yes>${esc(okLabel)}</button>`, onClose: () => res(false) });
    $("[data-no]", m.el).onclick = () => m.close();
    $("[data-yes]", m.el).onclick = () => { res(true); m.el.remove(); modalStack = modalStack.filter(x => x !== m); };
  });
}
// fields: [{k,label,type,options:[[v,l]],req,ph,hint}]
function formModal(title, fields, values = {}, onSave) {
  const body = fields.map(f => {
    const v = values[f.k] ?? f.def ?? "";
    let input;
    if (f.type === "select") input = `<select name="${f.k}">${f.options.map(([ov, ol]) => opt(ov, ol, v)).join("")}</select>`;
    else if (f.type === "textarea") input = `<textarea name="${f.k}" rows="3" placeholder="${esc(f.ph || "")}">${esc(v)}</textarea>`;
    else input = `<input name="${f.k}" type="${f.type || "text"}" ${f.type === "number" ? 'step="any"' : ""} value="${esc(v)}" placeholder="${esc(f.ph || "")}">`;
    return `<label class="f">${esc(f.label)}${f.req ? " *" : ""}${input}${f.hint ? `<span class="muted" style="font-weight:400">${esc(f.hint)}</span>` : ""}</label>`;
  }).join("");
  const m = modal({ title, body: `<form>${body}<button type="submit" hidden></button></form>`, foot: `<button data-c>Cancel</button><button class="primary" data-s>Save</button>` });
  $("form", m.el).style.cssText = "display:flex;flex-direction:column;gap:12px";
  const submit = async e => {
    e && e.preventDefault();
    const out = { ...values };
    for (const f of fields) {
      out[f.k] = $(`[name="${f.k}"]`, m.el).value.trim();
      if (f.req && !out[f.k]) { toast(`${f.label} is required`, "err"); return; }
    }
    const ok = await guard(() => onSave(out));
    if (ok !== undefined) m.close();
  };
  $("form", m.el).onsubmit = submit;
  $("[data-s]", m.el).onclick = submit;
  $("[data-c]", m.el).onclick = () => m.close();
  return m;
}

// ---------------------------------------------------------------- bootstrap data
let B = { settings: {}, categories: [], subcategories: [], size_sets: [], brands: [], suppliers: [] };
const isOwner = () => !!(B.me && B.me.role === "OWNER");
const canInward = () => isOwner() || !!(B.me && B.me.can_inward);
// Pages each role may open
const STAFF_PAGES = ["sales", "bills", "customers", "stock", "labels"];
const pageAllowed = pg => isOwner() || STAFF_PAGES.includes(pg) || (canInward() && ["inward", "inwards"].includes(pg));
function applyRole() {
  $$("#nav a").forEach(a => { a.style.display = pageAllowed(a.dataset.page) ? "" : "none"; });
  const u = B.me || {};
  $("#user-box").innerHTML = u.username ? `<div class="u-name">${esc(u.name || u.username)}</div><div class="u-role">${u.role === "OWNER" ? "Owner" : "Staff"} · ${esc(u.username)}</div>
    <div class="btns" style="margin-top:6px"><button class="small" id="u-pw">Change password</button><button class="small" id="u-out">Log out</button></div>` : "";
  const pw = $("#u-pw"); if (pw) pw.onclick = changePasswordForm;
  const out = $("#u-out"); if (out) out.onclick = async () => { await fetch("/api/logout", { method: "POST" }); location.hash = ""; location.reload(); };
}
function changePasswordForm() {
  formModal("Change my password", [{ k: "old", label: "Current password", type: "password", req: true },
    { k: "new", label: "New password (min 8 characters)", type: "password", req: true }, { k: "new2", label: "Repeat new password", type: "password", req: true }], {},
    async v => { if (v.new !== v.new2) throw new Error("New passwords do not match"); const r = await api("change_password", { old: v.old, new: v.new }); toast("Password changed", "ok"); return r; });
}
// Login / first-time setup screen
async function showLogin() {
  if ($("#login-root")) return;
  let st = { needs_setup: false, can_setup_here: false };
  try { const r = await fetch("/api/auth_status", { method: "POST" }); st = (await r.json()).data || st; } catch { /* server down */ }
  const setup = st.needs_setup;
  const el = document.createElement("div");
  el.id = "login-root";
  el.innerHTML = `<form class="login-card" autocomplete="on">
      <img src="logo.png" alt="SuperSoft" class="login-logo">
      <h2>${setup ? "Create owner account" : "Sign in"}</h2>
      ${setup && !st.can_setup_here ? `<div class="banner">No owner account exists yet. For safety it must be created from the server console:<br><code>python manage.py create-owner</code></div>`
        : `${setup ? `<div class="muted" style="font-size:13px">First-time setup: create the owner login. The owner can see everything and add staff logins later in Settings.</div>
            <label class="f">Your name<input name="name" autocomplete="name"></label>` : ""}
          <label class="f">Username<input name="username" autocomplete="username" required></label>
          <label class="f">Password${setup ? " (min 8 characters)" : ""}<input name="password" type="password" autocomplete="${setup ? "new-password" : "current-password"}" required></label>
          ${setup ? `<label class="f">Repeat password<input name="password2" type="password" autocomplete="new-password" required></label>` : ""}
          <div class="login-err" id="login-err"></div>
          <button class="primary big" type="submit">${setup ? "Create owner & sign in" : "Sign in"}</button>`}
    </form>`;
  document.body.appendChild(el);
  const f = $("form", el);
  const first = $("input", el); if (first) first.focus();
  f.onsubmit = async e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f).entries());
    if (setup && v.password !== v.password2) { $("#login-err").textContent = "Passwords do not match"; return; }
    const r = await fetch("/api/" + (setup ? "setup_owner" : "login"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
    const j = await r.json();
    if (!j.ok) { $("#login-err").textContent = j.error; return; }
    el.remove();
    await loadB(); applyRole(); route();
  };
}

async function loadB() {
  B = await api("bootstrap");
  $("#shop-name-side").textContent = B.settings.shop_name || "";
  document.title = "SuperSoft – " + (B.settings.shop_name || "");
}
const subById = id => B.subcategories.find(s => s.id == id);
const subsOf = cid => B.subcategories.filter(s => s.category_id == cid);
const catOpts = (sel, blank = "— Select —") => opt("", blank, sel) + B.categories.map(c => opt(c.id, c.name, sel)).join("");
const subOpts = (cid, sel, blank = "— Select —") => opt("", blank, sel) + (cid ? subsOf(cid) : B.subcategories).map(s => opt(s.id, cid ? s.name : `${s.category} › ${s.name}`, sel)).join("");
const supOpts = (sel, blank = "— Select supplier —") => opt("", blank, sel) + B.suppliers.map(s => opt(s.id, s.name + (s.city ? ` (${s.city})` : ""), sel)).join("");
const brandOpts = (sel) => opt("", "— No brand —", sel) + B.brands.map(b => opt(b.id, b.name, sel)).join("");
const GST_OPTS = [["SLAB", "Slab by price (5% / 18%)"], ["0", "0%"], ["5", "5%"], ["12", "12%"], ["18", "18%"]];
const UNIT_OPTS = [["PCS", "Pieces (PCS)"], ["MTR", "Metres (MTR)"], ["PACK", "Pack / Box (PACK)"]];

function roundPrice(v) {
  v = +v || 0;
  if (v <= 0) return 0;
  switch (String(B.settings.price_round)) {
    case "1": return Math.ceil(v);
    case "5": return Math.ceil(v / 5) * 5;
    case "10": return Math.ceil(v / 10) * 10;
    case "9": return Math.ceil((Math.ceil(v) + 1) / 10) * 10 - 1;
    default: return Math.round(v * 100) / 100;
  }
}
const calcMrp = (cost, markup) => roundPrice((+cost || 0) * (1 + (+markup || 0) / 100));

// ---------------------------------------------------------------- printing
// Every print first opens a preview; printing happens only from the preview's Print button.
// opts: { title, kind: "invoice" | "labels" | "report", extraFoot, onFoot(m, setContent) }
function printHTML(html, pageCss, opts = {}) {
  const m = modal({
    title: opts.title || "Print preview", wide: true,
    body: `<div class="pv-wrap"><div class="pv-paper pv-${opts.kind || "doc"}">${html}</div></div>`,
    foot: `${opts.extraFoot || ""}<span style="flex:1"></span><button data-pclose>Close</button><button class="primary" data-pgo>🖨 Print</button>`,
  });
  let cur = { html, pageCss };
  const setContent = (h, css, kind) => {
    cur = { html: h, pageCss: css };
    const paper = $(".pv-paper", m.el);
    paper.className = `pv-paper pv-${kind || opts.kind || "doc"}`;
    paper.innerHTML = h;
  };
  $("[data-pclose]", m.el).onclick = () => m.close();
  $("[data-pgo]", m.el).onclick = () => { doPrint(cur.html, cur.pageCss); };
  opts.onFoot && opts.onFoot(m, setContent);
  setTimeout(() => $("[data-pgo]", m.el).focus(), 60);
  return m;
}
function doPrint(html, pageCss) {
  $("#print-root").innerHTML = html;
  $("#page-style").textContent = pageCss;
  setTimeout(() => {
    window.print();
    setTimeout(() => { $("#print-root").innerHTML = ""; $("#page-style").textContent = ""; }, 500);
  }, 120);
}

// labels queue: [{item_id, copies}]
let LQ = store.get("labels", []);
function saveLQ() { store.set("labels", LQ); const n = LQ.reduce((a, b) => a + (+b.copies || 0), 0); $("#label-count").textContent = n ? n : ""; }
function addLabels(list) {
  for (const l of list) {
    const ex = LQ.find(x => x.item_id === l.item_id);
    if (ex) ex.copies = (+ex.copies || 0) + (+l.copies || 0); else LQ.push({ item_id: l.item_id, copies: +l.copies || 1 });
  }
  saveLQ();
}
function labelHTML(it) {
  const s = B.settings;
  const mrp = Number.isInteger(+it.mrp) ? NF0.format(it.mrp) : m2(it.mrp);
  return `<div class="lbl" style="width:${+s.label_w}mm;height:${+s.label_h}mm">
    ${s.label_show_shop === "1" ? `<div class="l-shop">${esc(s.shop_name)}</div>` : ""}
    <div class="l-name">${esc(it.name)}</div>
    <div class="l-mid"><span class="l-size">${it.size && it.size !== "FREE" ? "Size: " + esc(it.size) : esc(it.unit === "MTR" ? "Per Metre" : "")}</span><span class="l-mrp">MRP ₹${mrp}</span></div>
    <div class="l-bc">${barcodeSVG(it.barcode)}</div>
    <div class="l-code">${esc(it.barcode)}</div></div>`;
}
async function printLabels(queue) {
  const items = await api("items_by_ids", { ids: queue.map(q => q.item_id) });
  const byId = Object.fromEntries(items.map(i => [i.id, i]));
  const flat = [];
  for (const q of queue) { const it = byId[q.item_id]; if (it) for (let k = 0; k < (+q.copies || 0); k++) flat.push(it); }
  if (!flat.length) { toast("No labels to print", "err"); return; }
  const s = B.settings, cols = Math.max(1, +s.label_cols || 1), W = +s.label_w, H = +s.label_h, gap = +s.label_gap || 0;
  const pw = cols * W + (cols - 1) * gap;
  let html = "";
  for (let i = 0; i < flat.length; i += cols) {
    html += `<div class="lbl-row" style="width:${pw}mm;height:${H}mm;gap:${gap}mm">${flat.slice(i, i + cols).map(labelHTML).join("")}</div>`;
  }
  return printHTML(html, `@page { size: ${pw}mm ${H}mm; margin: 0; } @media print { html, body { margin: 0; padding: 0; } }`,
    { title: `Label preview — ${flat.length} label(s), ${W} × ${H} mm`, kind: "labels" });
}

const payModes = b => [["Cash", b.pay_cash], ["UPI", b.pay_upi], ["Card", b.pay_card], ["Cheque", b.pay_cheque]].filter(p => Math.abs(+p[1] || 0) > 0.001);
function inWords(num) {
  const a = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen",
    "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const b = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = x => x < 20 ? a[x] : b[Math.floor(x / 10)] + (x % 10 ? " " + a[x % 10] : "");
  const three = x => (x >= 100 ? a[Math.floor(x / 100)] + " Hundred" + (x % 100 ? " " : "") : "") + (x % 100 ? two(x % 100) : "");
  let n = Math.round(Math.abs(num));
  if (!n) return "Zero";
  const parts = [];
  const cr = Math.floor(n / 1e7); n %= 1e7;
  const lk = Math.floor(n / 1e5); n %= 1e5;
  const th = Math.floor(n / 1000); n %= 1000;
  if (cr) parts.push(three(cr) + " Crore");
  if (lk) parts.push(two(lk) + " Lakh");
  if (th) parts.push(two(th) + " Thousand");
  if (n) parts.push(three(n));
  return parts.join(" ");
}

function invoiceHTML(bill, format) {
  const s = B.settings, c = bill.customer || {};
  const thermal = (format || s.invoice_format) === "80mm";
  const taxes = {};
  for (const l of bill.lines) {
    const k = l.gst_rate;
    taxes[k] = taxes[k] || { taxable: 0, gst: 0 };
    taxes[k].taxable += l.taxable; taxes[k].gst += l.gst;
  }
  const totalQty = bill.lines.filter(l => l.qty > 0).reduce((a, l) => a + l.qty, 0);
  const disc = bill.line_discount + bill.bill_discount;
  const head = `<div class="c"><h1>${esc(s.shop_name)}</h1>
    <div>${esc(s.shop_address)}</div>
    ${s.shop_phone ? `<div>Ph: ${esc(s.shop_phone)}</div>` : ""}
    ${s.shop_gstin ? `<div><b>GSTIN: ${esc(s.shop_gstin)}</b>${s.shop_state ? " · State: " + esc(s.shop_state) : ""}</div>` : ""}</div>
    <div class="title">${bill.net < 0 ? "CREDIT NOTE" : "TAX INVOICE"}${bill.status === "CANCELLED" ? " — CANCELLED" : ""}</div>
    <div class="meta"><div><b>Bill No:</b> ${esc(bill.bill_no)}<br><b>Date:</b> ${dmy(bill.date)} ${esc((bill.created_at || "").slice(11, 16))}</div>
    <div class="r"><b>${esc(c.name || "")}</b><br>${esc(c.mobile || "")}${c.city ? "<br>" + esc(c.city) : ""}</div></div>`;
  const rowsHtml = bill.lines.map((l, i) => thermal
    ? `<tr class="${l.qty < 0 ? "ret" : ""}"><td colspan="4">${i + 1}. ${esc(l.name)} ${l.size && l.size !== "FREE" ? "(" + esc(l.size) + ")" : ""}${l.qty < 0 ? " [RETURN" + (l.ref_bill ? " of " + esc(l.ref_bill) : "") + "]" : ""}</td></tr>
       <tr class="${l.qty < 0 ? "ret" : ""}"><td>${qf(l.qty)} × ${m2(l.mrp)}</td><td class="r">${l.disc_pct ? qf(l.disc_pct) + "%" : ""}</td><td class="r">${qf(l.gst_rate)}%</td><td class="r">${m2(l.amount)}</td></tr>`
    : `<tr class="${l.qty < 0 ? "ret" : ""}"><td class="c">${i + 1}</td><td>${esc(l.name)}${l.qty < 0 ? ` <i>(Return${l.ref_bill ? " of " + esc(l.ref_bill) : ""})</i>` : ""}<br><span style="font-size:9px">${esc(l.barcode)}</span></td>
       <td class="c">${esc(l.hsn || "")}</td><td class="c">${esc(l.size === "FREE" ? "" : l.size)}</td><td class="r">${qf(l.qty)} ${l.unit === "MTR" ? "m" : ""}</td>
       <td class="r">${m2(l.mrp)}</td><td class="r">${l.disc_pct ? qf(l.disc_pct) + "%" : ""}</td><td class="r">${qf(l.gst_rate)}%</td><td class="r">${m2(l.amount)}</td></tr>`).join("");
  const table = thermal
    ? `<table><thead><tr><th style="text-align:left">Qty × MRP</th><th class="r">Disc</th><th class="r">GST</th><th class="r">Amount</th></tr></thead><tbody>${rowsHtml}</tbody></table>`
    : `<table><thead><tr><th>#</th><th>Item</th><th>HSN</th><th>Size</th><th>Qty</th><th>MRP</th><th>Disc</th><th>GST</th><th>Amount</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;
  const taxRows = Object.entries(taxes).filter(([, t]) => Math.abs(t.taxable) > 0.001).map(([r, t]) =>
    `<tr><td class="c">${qf(r)}%</td><td class="r">${m2(t.taxable)}</td><td class="r">${qf(r / 2)}% ${m2(t.gst / 2)}</td><td class="r">${qf(r / 2)}% ${m2(t.gst / 2)}</td><td class="r">${m2(t.gst)}</td></tr>`).join("");
  const taxTable = `<table style="margin-top:8px;font-size:${thermal ? 9.5 : 10}px"><thead><tr><th>GST</th><th>Taxable</th><th>CGST</th><th>SGST</th><th>Total Tax</th></tr></thead><tbody>${taxRows}</tbody></table>`;
  const tline = (l, v, cls = "") => `<tr class="${cls}"><td class="r">${l}</td><td class="r" style="width:110px">${v}</td></tr>`;
  const pays = payModes(bill).map(p => `${p[0]}: ${m2(p[1])}`).join(" · ") + (bill.pay_ref ? ` (Ref: ${esc(bill.pay_ref)})` : "");
  const totals = `<table class="tot" style="margin-top:6px">
    ${tline(`Total Qty: ${qf(totalQty)} &nbsp; Gross Amount`, m2(bill.gross))}
    ${disc > 0.001 ? tline("Discount", "- " + m2(disc)) : ""}
    ${bill.returns ? tline("Returns / Exchange", m2(bill.returns)) : ""}
    ${Math.abs(bill.round_off) > 0.001 ? tline("Round Off", m2(bill.round_off)) : ""}
    ${tline(bill.net < 0 ? "REFUND AMOUNT" : "NET AMOUNT", "₹ " + m2(Math.abs(bill.net)), "net")}</table>
    <div style="margin-top:4px"><b>Rupees ${inWords(bill.net)} Only</b></div>
    ${pays ? `<div style="margin-top:2px">Paid by — ${pays}</div>` : ""}
    ${disc > 0.001 ? `<div style="margin-top:2px"><b>You saved ₹${m2(disc)} on this bill!</b></div>` : ""}`;
  const foot = `<div class="foot"><div style="max-width:70%">${esc(s.invoice_footer)}</div>${thermal ? "" : `<div class="c">For ${esc(s.shop_name)}<br><br><br>Authorised Signatory</div>`}</div>
    <div class="c" style="margin-top:8px;font-size:9px;color:#555">Billing by SuperSoft</div>`;
  return `<div class="inv ${thermal ? "thermal" : "a4"}">${head}${table}${totals}${taxTable}${foot}</div>`;
}
const invoiceCss = f => f === "80mm" ? "@page { margin: 2mm; }" : "@page { size: A4; margin: 10mm; }";
function printInvoice(bill) {
  const f0 = B.settings.invoice_format === "80mm" ? "80mm" : "A4";
  return printHTML(invoiceHTML(bill, f0), invoiceCss(f0), {
    title: `Print preview — Bill ${bill.bill_no}`, kind: f0 === "80mm" ? "thermal" : "invoice",
    extraFoot: `<label class="chk">Paper <select data-fmt style="width:auto">${opt("A4", "A4 page", f0)}${opt("80mm", "80 mm thermal", f0)}</select></label>`,
    onFoot: (m, setContent) => {
      $("[data-fmt]", m.el).onchange = e => { const f = e.target.value; setContent(invoiceHTML(bill, f), invoiceCss(f), f === "80mm" ? "thermal" : "invoice"); };
    },
  });
}

// ---------------------------------------------------------------- router
const PAGES = {};
let current = null;
async function route() {
  let page = (location.hash || (isOwner() ? "#dashboard" : "#sales")).slice(1).split("?")[0];
  if (!pageAllowed(page) || !PAGES[page]) { page = isOwner() ? "dashboard" : "sales"; history.replaceState(null, "", "#" + page); }
  const fn = PAGES[page] || PAGES.dashboard;
  current = page;
  $$("#nav a").forEach(a => a.classList.toggle("active", a.dataset.page === page));
  modalStack.slice().forEach(m => m.close());
  // Fresh container per navigation, so a slow page that finishes late can't overwrite the new one
  const main = document.createElement("div");
  $("#main").replaceChildren(main);
  main.innerHTML = `<div class="muted">Loading…</div>`;
  try {
    if (!B.categories.length) await loadB();
    await fn(main);
  } catch (e) {
    main.innerHTML = `<div class="card" style="max-width:640px;border-color:#efb2ad">
      <h2 style="color:var(--bad)">Could not load this page</h2><div>${esc(e.message)}</div>
      <div class="btns" style="margin-top:12px"><button class="primary" onclick="location.reload()">Retry</button></div></div>`;
  }
}
window.addEventListener("hashchange", route);
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && modalStack.length) { modalStack[modalStack.length - 1].close(); return; }
  if (e.key === "F2") { e.preventDefault(); location.hash = "#sales"; }
  if (e.key === "F3") { e.preventDefault(); location.hash = "#inward"; }
  if (current === "sales" && !modalStack.length) {
    if (e.key === "F9") { e.preventDefault(); saveBill(true); }
    if (e.key === "F8") { e.preventDefault(); saveBill(false); }
    if (e.key === "F4") { e.preventDefault(); const c = $("#pk-cat"); if (c) c.focus(); }
  }
});

// ================================================================ DASHBOARD
PAGES.dashboard = async main => {
  const d = await api("dashboard");
  const pct = (p, s) => s ? ` · ${(p * 100 / s).toFixed(1)}% margin` : "";
  const kpi = (k, v, s, cls = "", attr = "") => `<div class="kpi ${cls}" ${attr}><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const maxTrend = Math.max(1, ...d.trend.map(t => t.sales));
  const maxSub = Math.max(1, ...d.top_sub.map(t => t.amount));
  const t = todayStr();
  main.innerHTML = `
  <div class="page-head"><h1>Dashboard</h1><span class="sub">${new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</span>
    <span class="spacer"></span><button class="primary" onclick="location.hash='#sales'">+ New Bill (F2)</button><button onclick="location.hash='#inward'">+ Stock Inward (F3)</button></div>
  ${d.setup_incomplete ? `<div class="banner">Shop details (name, address, GSTIN) are not complete. <a href="#settings">Open Settings</a> to fill them in so they print on invoices.</div>` : ""}
  <div class="grid g4" style="margin-bottom:16px">
    ${kpi("Today's Sales", money(d.today.sales), `${d.today.bills} bill${d.today.bills == 1 ? "" : "s"}`)}
    ${kpi("Today's Profit", money(d.today.profit), "Before expenses" + pct(d.today.profit, d.today.sales) + " · click for bill-wise", "good clickable", 'data-profit="today" title="Click for bill-wise profit"')}
    ${kpi("This Month Sales", money(d.month.sales), `${d.month.bills} bills`)}
    ${kpi("This Month Profit", money(d.month.profit), "Before expenses" + pct(d.month.profit, d.month.sales) + " · click for bill-wise", "good clickable", 'data-profit="month" title="Click for bill-wise profit"')}
    <div class="kpi clickable good" id="kpi-cash" title="Click for today's cash breakup">
      <div class="k">Cash in Hand</div><div class="v">${money(d.cash_in_hand)}</div>
      <div class="s">${B.settings.opening_cash_date ? "Click for today's cash flow →" : "Set opening cash for accuracy →"}</div></div>
    <div class="kpi clickable upi" id="kpi-upi" title="Click to see today's UPI bills">
      <div class="k">UPI Received Today</div><div class="v">${money(d.pay_today.upi)}</div>
      <div class="s">Click to see UPI bills & tally →</div></div>
    ${kpi("Today's Collection", money(d.pay_today.cash + d.pay_today.upi + d.pay_today.card + d.pay_today.cheque), `Cash ${m2(d.pay_today.cash)} · UPI ${m2(d.pay_today.upi)} · Card ${m2(d.pay_today.card)}${d.pay_today.cheque ? " · Cheque " + m2(d.pay_today.cheque) : ""}`)}
    ${kpi("Today's Expenses", money(d.expenses_today), "Click to add / view expenses", "clickable", 'data-go-exp')}
    ${kpi("This Month Expenses", money(d.expenses_month), "All payment modes", "clickable", 'data-go-exp')}
    ${kpi("This Month Net Profit", money(d.month.profit - d.expenses_month), `Profit ${m2(d.month.profit)} − expenses ${m2(d.expenses_month)}`, (d.month.profit - d.expenses_month) < 0 ? "alert" : "good")}
    ${kpi("Stock in Hand", qf(d.stock.pcs) + " pcs" + (d.stock.mtr ? ` + ${qf(d.stock.mtr)} mtr` : ""), `${money(d.stock.value_cost)} at cost · ${money(d.stock.value_mrp)} at MRP`)}
    <div class="kpi clickable ${d.low_stock.length ? "alert" : ""}" id="kpi-low" title="Click to see the low-stock items">
      <div class="k">Low Stock Alerts (MOQ)</div><div class="v">${d.low_stock.length}</div>
      <div class="s">${d.low_stock.length ? "Click to see which items to reorder →" : "All items above MOQ"}</div></div>
  </div>
  <div class="grid g2">
    <div class="card" style="border-color:${d.low_stock.length ? "#efb2ad" : "var(--line)"}">
      <h2 style="color:${d.low_stock.length ? "var(--bad)" : ""}">⚠ Low Stock Alert (below MOQ)<span class="spacer"></span>${d.low_stock.length ? `<button class="small primary" id="low-see" style="text-transform:none">See items</button>` : ""}<a href="#reports?low_stock" onclick="REP.name='low_stock'" style="font-size:12px;text-transform:none;margin-left:8px">Full report</a></h2>
      <div class="tbl-wrap" style="max-height:300px">${d.low_stock.length ? `<table class="t"><thead><tr><th>Category</th><th>Sub-category</th><th>Size</th><th class="r">Stock</th><th class="r">MOQ</th><th></th></tr></thead><tbody>
        ${d.low_stock.map(r => `<tr data-lowrow style="cursor:pointer" title="Click to see items"><td>${esc(r.category)}</td><td>${esc(r.subcategory)}</td><td>${esc(r.size)}</td><td class="r"><b>${qf(r.stock)}</b></td><td class="r">${qf(r.moq)}</td>
        <td>${r.stock <= 0 ? '<span class="pill bad">OUT</span>' : '<span class="pill warn">LOW</span>'}</td></tr>`).join("")}</tbody></table>`
        : `<div class="empty">No alerts. Every stocked item is at or above its MOQ.</div>`}</div>
    </div>
    <div class="card"><h2>Sales — last 14 days</h2>
      <div class="vbars">${d.trend.map(x => `<div class="col"><div class="bar ${x.date === t ? "today" : ""}" style="height:${(x.sales / maxTrend) * 100}%"><span class="tip">${dmy(x.date)}: ${money(x.sales)} · ${x.bills} bills · profit ${money(x.profit)}</span></div><div class="d">${x.date.slice(8)}</div></div>`).join("")}</div>
      <div class="muted" style="font-size:12px;margin-top:6px">Hover a bar for details. Total: ${money(d.trend.reduce((a, x) => a + x.sales, 0))} · Profit: ${money(d.trend.reduce((a, x) => a + x.profit, 0))}</div>
    </div>
  </div>
  <div class="grid g2">
    <div class="card"><h2>Top sub-categories — last 30 days</h2>
      ${d.top_sub.length ? d.top_sub.map(x => `<div class="hbar"><span class="lbl" title="${esc(x.category)}">${esc(x.subcategory)} <span class="muted">· ${esc(x.category)}</span></span><div class="track"><div class="fill" style="width:${(x.amount / maxSub) * 100}%"></div></div><span class="val">${money(x.amount)}</span></div>`).join("")
        : `<div class="empty">No sales yet.</div>`}
    </div>
    <div class="card"><h2>Highest selling products — last 30 days</h2>
      ${d.top_items.length ? `<div class="tbl-wrap"><table class="t"><thead><tr><th>#</th><th>Product</th><th>Size</th><th class="r">Qty</th><th class="r">Sales</th></tr></thead><tbody>
      ${d.top_items.map((x, i) => `<tr><td>${i + 1}</td><td>${esc([x.subcategory, x.brand, x.description].filter(Boolean).join(" "))}</td><td>${esc(x.size)}</td><td class="r"><b>${qf(x.qty)}</b></td><td class="r">${money(x.amount)}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">No sales yet.</div>`}
    </div>
  </div>
  <div class="grid g2">
    <div class="card"><h2>Stock by category</h2><div class="tbl-wrap"><table class="t"><thead><tr><th>Category</th><th class="r">Qty</th><th class="r">Value @Cost</th><th class="r">Value @MRP</th></tr></thead><tbody>
      ${d.by_category.map(x => `<tr><td>${esc(x.category)}</td><td class="r">${qf(x.qty)}</td><td class="r">${money(x.value_cost)}</td><td class="r">${money(x.value_mrp)}</td></tr>`).join("")}</tbody></table></div></div>
    <div class="card"><h2>Recent bills<span class="spacer"></span><a href="#bills" style="font-size:12px;text-transform:none">All bills</a></h2><div class="tbl-wrap"><table class="t"><thead><tr><th>Bill</th><th>Date</th><th>Customer</th><th class="r">Net</th><th class="r">Profit</th></tr></thead><tbody>
      ${d.recent.length ? d.recent.map(x => `<tr class="${x.status === "CANCELLED" ? "cancelled" : ""}"><td><button class="link" data-bill="${x.id}">${esc(x.bill_no)}</button></td><td>${dmy(x.date)}</td><td>${esc(x.customer || "")} <span class="muted">${esc(x.city || "")}</span></td><td class="r">${money(x.net)}</td><td class="r">${money(x.profit)}</td></tr>`).join("") : `<tr><td colspan="5" class="empty">No bills yet.</td></tr>`}
      </tbody></table></div>
      ${d.top_customers.length ? `<h2 style="margin-top:16px">Top customers — last 30 days</h2><table class="t"><tbody>${d.top_customers.map(x => `<tr><td>${esc(x.name)}</td><td>${esc(x.mobile)}</td><td>${esc(x.city)}</td><td class="r">${x.bills} bills</td><td class="r">${money(x.amount)}</td></tr>`).join("")}</tbody></table>` : ""}
    </div>
  </div>`;
  $$("[data-bill]", main).forEach(b => b.onclick = () => viewBill(+b.dataset.bill));
  $("#kpi-low", main).onclick = showLowStock;
  $("#kpi-cash", main).onclick = showCashToday;
  $("#kpi-upi", main).onclick = () => showUpiTally(todayStr());
  $$("[data-go-exp]", main).forEach(k => k.onclick = () => { EX.tab = "exp"; location.hash = "#expenses"; });
  $$("[data-profit]", main).forEach(k => k.onclick = () => showProfitBreakup(k.dataset.profit));
  $$("[data-lowrow]", main).forEach(r => r.onclick = showLowStock);
  const lb = $("#low-see", main); if (lb) lb.onclick = showLowStock;
};

// Profit drill-down: bill-wise profit for a period, expandable to item-wise (internal only - never printed on bills)
async function showProfitBreakup(period) {
  const t = todayStr();
  const P = { from: period === "month" ? t.slice(0, 8) + "01" : t, to: t };
  const m = modal({
    title: "Profit — bill-wise breakup (internal)", wide: true,
    body: `<div class="row">
        <label class="f narrow">From<input type="date" id="pb-from" value="${P.from}"></label><label class="f narrow">To<input type="date" id="pb-to" value="${P.to}"></label>
        <div class="btns"><button class="small" data-pp="today">Today</button><button class="small" data-pp="yday">Yesterday</button><button class="small" data-pp="month">This month</button><button class="small" data-pp="last">Last month</button></div>
        <button class="primary" id="pb-go">Show</button></div>
      <div id="pb-sum" class="grid g4" style="margin:4px 0"></div>
      <div class="muted" style="font-size:12px">Profit = sale value excluding GST − cost of goods. Click a bill row to see profit on each item. Cancelled bills are not counted.</div>
      <div id="pb-res" class="tbl-wrap" style="max-height:50vh"></div>`,
    foot: `<button data-csv>Export to Excel (CSV)</button><button class="primary" data-print>Print preview</button>`,
  });
  let bills = [];
  const go = async () => {
    P.from = $("#pb-from", m.el).value; P.to = $("#pb-to", m.el).value;
    const res = await guard(() => api("list_bills", { from: P.from, to: P.to })); if (!res) return;
    bills = res.filter(b => b.status === "ACTIVE").reverse();
    const sum = k => bills.reduce((a, b) => a + (+b[k] || 0), 0);
    const tp = sum("profit"), tt = sum("taxable");
    const best = bills.reduce((a, b) => (!a || b.profit > a.profit ? b : a), null);
    const tile = (k, v, s = "") => `<div class="kpi"><div class="k">${k}</div><div class="v" style="font-size:20px">${v}</div><div class="s">${s}</div></div>`;
    $("#pb-sum", m.el).innerHTML = tile("Total profit", `<span style="color:var(--ok)">${money(tp)}</span>`, tt ? `${(tp * 100 / tt).toFixed(1)}% margin` : "")
      + tile("Bills", bills.length, `Sales ${money(sum("net"))}`)
      + tile("Avg profit / bill", money(bills.length ? tp / bills.length : 0))
      + tile("Best bill", best ? money(best.profit) : "—", best ? `${esc(best.bill_no)} · ${esc(best.customer || "")}` : "");
    $("#pb-res", m.el).innerHTML = bills.length ? `<table class="t"><thead><tr><th></th><th>Date / time</th><th>Bill No</th><th>Customer</th><th>City</th><th class="r">Qty</th><th class="r">Net sale</th><th class="r">GST</th><th class="r">Sale excl. GST</th><th class="r">Cost</th><th class="r">Profit</th><th class="r">Margin</th></tr></thead><tbody>
      ${bills.map((b, i) => `<tr data-pbr="${i}" style="cursor:pointer"><td class="muted" data-arrow="${i}">▸</td><td>${dmy(b.date)} <span class="muted">${esc((b.created_at || "").slice(11, 16))}</span></td><td><b>${esc(b.bill_no)}</b>${b.returns ? ' <span class="pill warn">RET</span>' : ""}</td>
        <td>${esc(b.customer || "")}</td><td>${esc(b.city || "")}</td><td class="r">${qf(b.qty)}</td><td class="r">${m2(b.net)}</td><td class="r">${m2(b.gst)}</td><td class="r">${m2(b.taxable)}</td><td class="r">${m2(b.cost)}</td>
        <td class="r" style="font-weight:700;color:${b.profit < 0 ? "var(--bad)" : "var(--ok)"}">${m2(b.profit)}</td><td class="r">${b.taxable ? (b.profit * 100 / b.taxable).toFixed(1) + "%" : ""}</td></tr>
        <tr data-pbd="${i}" style="display:none"><td></td><td colspan="11" style="background:#fafbfc"></td></tr>`).join("")}
      </tbody><tfoot><tr><td></td><td colspan="4">TOTAL — ${bills.length} bills</td><td class="r">${qf(sum("qty"))}</td><td class="r">${m2(sum("net"))}</td><td class="r">${m2(sum("gst"))}</td><td class="r">${m2(tt)}</td><td class="r">${m2(sum("cost"))}</td>
        <td class="r" style="color:var(--ok)">${m2(tp)}</td><td class="r">${tt ? (tp * 100 / tt).toFixed(1) + "%" : ""}</td></tr></tfoot></table>`
      : `<div class="empty">No bills in this period.</div>`;
    $$("[data-pbr]", m.el).forEach(r => r.onclick = async () => {
      const i = +r.dataset.pbr, det = $(`[data-pbd="${i}"]`, m.el), cell = det.lastElementChild;
      if (det.style.display !== "none") { det.style.display = "none"; $(`[data-arrow="${i}"]`, m.el).textContent = "▸"; return; }
      if (!cell.innerHTML) {
        const bill = await guard(() => api("get_bill", { id: bills[i].id })); if (!bill) return;
        cell.innerHTML = `<table class="t" style="font-size:12px"><thead><tr><th>Item</th><th>Size</th><th class="r">Qty</th><th class="r">MRP</th><th class="r">Disc %</th><th class="r">Sold at</th><th class="r">Excl. GST</th><th class="r">Cost</th><th class="r">Profit</th></tr></thead><tbody>
          ${bill.lines.map(l => `<tr class="${l.qty < 0 ? "ret" : ""}"><td>${esc(l.name)}${l.qty < 0 ? " (return)" : ""} <span class="muted mono">${esc(l.barcode)}</span></td><td>${esc(l.size)}</td><td class="r">${qf(l.qty)}</td><td class="r">${m2(l.mrp)}</td><td class="r">${l.disc_pct ? qf(l.disc_pct) : ""}</td>
            <td class="r">${m2(l.amount)}</td><td class="r">${m2(l.taxable)}</td><td class="r">${m2(l.cost)}</td><td class="r"><b>${m2(l.profit)}</b></td></tr>`).join("")}
          </tbody></table>${bill.line_discount + bill.bill_discount > 0 ? `<div class="muted" style="font-size:12px;margin-top:4px">Discount given on this bill: ₹${m2(bill.line_discount + bill.bill_discount)} (already deducted from profit)</div>` : ""}`;
      }
      det.style.display = ""; $(`[data-arrow="${i}"]`, m.el).textContent = "▾";
    });
  };
  $$("[data-pp]", m.el).forEach(b => b.onclick = () => {
    const p = b.dataset.pp;
    if (p === "today") P.from = P.to = t;
    if (p === "yday") P.from = P.to = shiftDate(t, -1);
    if (p === "month") { P.from = t.slice(0, 8) + "01"; P.to = t; }
    if (p === "last") { const d = shiftDate(t.slice(0, 8) + "01", -1); P.from = d.slice(0, 8) + "01"; P.to = d; }
    $("#pb-from", m.el).value = P.from; $("#pb-to", m.el).value = P.to; go();
  });
  $("#pb-go", m.el).onclick = go;
  const cols = [["date", "Date"], ["bill_no", "Bill No"], ["customer", "Customer"], ["city", "City"], ["qty", "Qty"], ["net", "Net Sale"], ["gst", "GST"], ["taxable", "Sale excl GST"], ["cost", "Cost"], ["profit", "Profit"]];
  $("[data-csv]", m.el).onclick = () => {
    if (!bills.length) { toast("No bills to export", "err"); return; }
    const q = v => { const x = String(v ?? ""); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
    const lines = [cols.map(c => c[1]).join(","), ...bills.map(b => cols.map(([k]) => q(k === "date" ? dmy(b.date) : b[k])).join(","))];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }));
    a.download = `SuperSoft_profit_billwise_${P.from}_${P.to}.csv`; a.click();
  };
  $("[data-print]", m.el).onclick = () => {
    if (!bills.length) { toast("No bills to print", "err"); return; }
    const tot = k => bills.reduce((a, b) => a + (+b[k] || 0), 0);
    printHTML(`<div class="inv a4"><h1>${esc(B.settings.shop_name)}</h1><div class="title">PROFIT — BILL-WISE (INTERNAL)</div>
      <div class="c">Period: ${dmy(P.from)} to ${dmy(P.to)}</div><br>
      <table><thead><tr>${cols.map(c => `<th>${c[1]}</th>`).join("")}</tr></thead><tbody>
      ${bills.map(b => `<tr>${cols.map(([k]) => `<td class="${["qty", "net", "gst", "taxable", "cost", "profit"].includes(k) ? "r" : ""}">${k === "date" ? dmy(b.date) : ["net", "gst", "taxable", "cost", "profit"].includes(k) ? m2(b[k]) : esc(b[k] ?? "")}</td>`).join("")}</tr>`).join("")}
      <tr><td colspan="4"><b>TOTAL (${bills.length} bills)</b></td><td class="r"><b>${qf(tot("qty"))}</b></td>${["net", "gst", "taxable", "cost", "profit"].map(k => `<td class="r"><b>${m2(tot(k))}</b></td>`).join("")}</tr>
      </tbody></table></div>`, "@page { size: A4 portrait; margin: 10mm; } .inv.a4 th, .inv.a4 td { font-size: 10px; }",
      { title: "Print preview — Bill-wise profit", kind: "report" });
  };
  go();
}

// End-of-day UPI tally: every bill with a UPI payment on the chosen day, to match against the UPI app
async function showUpiTally(day) {
  const m = modal({
    title: "UPI received — end-of-day tally", wide: true,
    body: `<div class="row"><label class="f narrow">Date<input type="date" id="ut-day" value="${day}"></label>
        <div class="btns"><button class="small" data-ud="0">Today</button><button class="small" data-ud="-1">Yesterday</button></div></div>
      <div id="ut-sum" class="grid g4"></div>
      <div class="muted" style="font-size:12px">Match the UPI total with your UPI app / bank SMS for the day. Count the cash drawer against "Cash in Hand".</div>
      <div id="ut-res" class="tbl-wrap" style="max-height:50vh"></div>`,
    foot: `<button class="primary" data-print>Print preview</button>`,
  });
  let rows = [], cur = day;
  const go = async () => {
    cur = $("#ut-day", m.el).value || todayStr();
    const res = await guard(() => api("list_bills", { from: cur, to: cur })); if (!res) return;
    const act = res.filter(b => b.status === "ACTIVE");
    rows = act.filter(b => Math.abs(+b.pay_upi || 0) > 0.001).reverse();
    const sum = k => act.reduce((a, b) => a + (+b[k] || 0), 0);
    const tile = (k, v, s = "", cls = "") => `<div class="kpi ${cls}"><div class="k">${k}</div><div class="v" style="font-size:20px">${v}</div><div class="s">${s}</div></div>`;
    $("#ut-sum", m.el).innerHTML = tile("UPI received", money(sum("pay_upi")), `${rows.length} bill${rows.length === 1 ? "" : "s"}`, "upi")
      + tile("Cash received", money(sum("pay_cash")), "from bills (net of refunds)")
      + tile("Card", money(sum("pay_card"))) + tile("Cheque", money(sum("pay_cheque")));
    $("#ut-res", m.el).innerHTML = rows.length ? `<table class="t"><thead><tr><th>#</th><th>Time</th><th>Bill No</th><th>Customer</th><th>Mobile</th><th>Ref</th><th class="r">Bill total</th><th class="r">Cash part</th><th class="r">UPI amount</th></tr></thead><tbody>
      ${rows.map((b, i) => `<tr><td>${i + 1}</td><td>${esc((b.created_at || "").slice(11, 16))}</td><td><button class="link" data-ub="${b.id}">${esc(b.bill_no)}</button></td><td>${esc(b.customer || "")}</td><td>${esc(b.mobile || "")}</td><td>${esc(b.pay_ref || "")}</td>
        <td class="r">${m2(b.net)}</td><td class="r">${b.pay_cash ? m2(b.pay_cash) : ""}</td><td class="r"><b>${m2(b.pay_upi)}</b></td></tr>`).join("")}
      </tbody><tfoot><tr><td colspan="8">Total UPI — ${rows.length} bills</td><td class="r">${money(sum("pay_upi"))}</td></tr></tfoot></table>`
      : `<div class="empty">No UPI payments on ${dmy(cur)}.</div>`;
    $$("[data-ub]", m.el).forEach(b => b.onclick = () => viewBill(+b.dataset.ub));
  };
  $("#ut-day", m.el).onchange = go;
  $$("[data-ud]", m.el).forEach(b => b.onclick = () => { $("#ut-day", m.el).value = shiftDate(todayStr(), +b.dataset.ud); go(); });
  $("[data-print]", m.el).onclick = () => {
    const tot = rows.reduce((a, b) => a + (+b.pay_upi || 0), 0);
    printHTML(`<div class="inv a4"><h1>${esc(B.settings.shop_name)}</h1><div class="title">UPI RECEIVED — ${dmy(cur)}</div><br>
      <table><thead><tr><th>#</th><th>Time</th><th>Bill No</th><th>Customer</th><th>Mobile</th><th>Ref</th><th>UPI Amount</th></tr></thead><tbody>
      ${rows.map((b, i) => `<tr><td class="c">${i + 1}</td><td>${esc((b.created_at || "").slice(11, 16))}</td><td>${esc(b.bill_no)}</td><td>${esc(b.customer || "")}</td><td>${esc(b.mobile || "")}</td><td>${esc(b.pay_ref || "")}</td><td class="r">${m2(b.pay_upi)}</td></tr>`).join("")}
      <tr><td colspan="6"><b>TOTAL UPI (${rows.length} bills)</b></td><td class="r"><b>${m2(tot)}</b></td></tr></tbody></table>
      <div style="margin-top:24px">Checked with UPI app: ____________ &nbsp;&nbsp; Signature: ____________</div></div>`,
      "@page { size: A4 portrait; margin: 10mm; }", { title: `Print preview — UPI ${dmy(cur)}`, kind: "report" });
  };
  go();
}

// Low-stock drill-down: which items are below MOQ, with supplier and reorder qty
async function showLowStock() {
  const groups = await guard(() => api("low_stock_details")); if (!groups) return;
  if (!groups.length) { toast("No items are below MOQ", "ok"); return; }
  const out = groups.filter(g => g.stock <= 0).length;
  const totalReorder = groups.reduce((a, g) => a + g.reorder, 0);
  const itemName = it => [it.brand, it.description].filter(Boolean).join(" ") || "—";
  const table = (forPrint) => `<table class="${forPrint ? "" : "t"}"><thead><tr><th>Item</th><th>Size</th><th class="r">In stock</th><th class="r">MOQ</th><th class="r">Reorder qty</th>
      <th>Design / brand</th><th>Barcode</th><th>Supplier</th><th class="r">Cost</th><th class="r">MRP</th><th class="r">Sold</th><th>Last sold</th></tr></thead><tbody>
    ${groups.map(g => {
      const head = `<tr style="background:${forPrint ? "#eee" : g.stock <= 0 ? "var(--bad-soft)" : "var(--warn-soft)"};font-weight:700">
        <td>${esc(g.category)} › ${esc(g.subcategory)}</td><td>${esc(g.size)}</td><td class="r">${qf(g.stock)}</td><td class="r">${qf(g.moq)}</td>
        <td class="r">${qf(g.reorder)}${g.unit === "PCS" ? "" : " " + esc(g.unit)}</td>
        <td colspan="7">${forPrint ? "" : g.stock <= 0 ? '<span class="pill bad">OUT OF STOCK</span>' : '<span class="pill warn">LOW</span>'}</td></tr>`;
      const its = g.items.map(it => `<tr><td></td><td></td><td class="r">${qf(it.stock)}</td><td></td><td></td>
        <td>${esc(itemName(it))}</td><td class="mono">${esc(it.barcode)}</td><td>${esc(it.supplier || "")}${it.supplier_phone ? `<div class="muted" style="font-size:11px">${esc(it.supplier_phone)}</div>` : ""}</td>
        <td class="r">${m2(it.cost)}</td><td class="r">${m2(it.mrp)}</td><td class="r">${qf(it.sold)}</td><td>${dmy(it.last_sold || "")}</td></tr>`).join("");
      return head + its; }).join("")}
    </tbody></table>`;
  const m = modal({
    title: `Low stock — ${groups.length} item size(s) below MOQ`, wide: true,
    body: `<div class="row" style="gap:20px"><div><b style="color:var(--bad)">${out}</b> out of stock</div><div><b style="color:var(--warn)">${groups.length - out}</b> low</div>
        <div>Total to reorder: <b>${qf(totalReorder)}</b></div></div>
      <div class="muted" style="font-size:12px">Each coloured row is a sub-category + size that is below MOQ. The rows under it are the actual items (designs/barcodes) in that size, with their supplier — so you know what and whom to reorder from. Reorder qty brings stock back up to MOQ.</div>
      <div class="tbl-wrap" style="max-height:55vh">${table(false)}</div>`,
    foot: `<button data-rep>Open full report</button><button data-inw>+ Stock Inward</button><button class="primary" data-print>Print reorder list</button>`,
  });
  $("[data-rep]", m.el).onclick = () => { m.close(); REP.name = "low_stock"; location.hash = "#reports?low_stock"; };
  $("[data-inw]", m.el).onclick = () => { m.close(); location.hash = "#inward"; };
  $("[data-print]", m.el).onclick = () => {
    m.close();
    printHTML(`<div class="inv a4"><h1>${esc(B.settings.shop_name)}</h1><div class="title">REORDER LIST — ITEMS BELOW MOQ</div>
      <div class="c">As on ${dmy(todayStr())} · ${groups.length} item size(s) · total reorder qty ${qf(totalReorder)}</div><br>${table(true)}</div>`,
      "@page { size: A4 landscape; margin: 8mm; } .inv.a4 th, .inv.a4 td { font-size: 9.5px; padding: 2px 4px; }",
      { title: "Print preview — Reorder list", kind: "report" });
  };
}

// ================================================================ SALES
const newSale = () => ({ lines: [], calc: null, customer: { mobile: "", name: "", city: "" }, date: todayStr(), bill_disc: "", bill_disc_type: "pct", pay: { cash: "", mode: (B.settings.balance_mode || "UPI").toLowerCase(), ref: "" } });
let SALE = newSale();
let hideProfit = store.get("hide_profit", true);

PAGES.sales = async main => {
  main.innerHTML = `
  <div class="page-head"><h1>Sales / Billing</h1><span class="sub">Scan a barcode or pick from the list. <b>F4</b> Pick item · <b>F9</b> Save &amp; Print · <b>F8</b> Save</span><span class="spacer"></span>
    <label class="f" style="flex-direction:row;align-items:center;gap:6px">Bill date <input type="date" id="s-date" value="${SALE.date}" style="width:150px"></label>
    <button id="s-new">New bill</button></div>
  <div class="split">
    <div>
      <div class="card"><h2>Customer</h2><div class="row">
        <label class="f">Mobile number *<input id="c-mobile" maxlength="10" inputmode="numeric" value="${esc(SALE.customer.mobile)}" placeholder="10-digit mobile"></label>
        <label class="f wide">Customer name *<input id="c-name" value="${esc(SALE.customer.name)}" placeholder="Name"></label>
        <label class="f">City<input id="c-city" value="${esc(SALE.customer.city)}" placeholder="City"></label>
      </div><div id="c-hint" class="muted" style="font-size:12px;margin-top:6px"></div></div>
      <div class="card"><h2>Items</h2>
        <div class="row" style="margin-bottom:12px">
          <label class="f wide">Scan barcode (or type and press Enter)<input id="scan" class="scan mono" autocomplete="off" placeholder="Scan here…"></label>
          <button id="s-search">Search item</button><button id="s-return" class="danger">↺ Return / Exchange</button>
        </div>
        <div class="muted" style="font-size:12px;font-weight:700;margin-bottom:4px">OR PICK FROM LIST — NO BARCODE NEEDED (F4)</div>
        <div class="row picker" style="margin-bottom:12px;padding:10px;background:#fdf6f0;border-radius:6px">
          <label class="f">Category<select id="pk-cat">${catOpts(PK.cat)}</select></label>
          <label class="f">Sub-category<select id="pk-sub">${subOpts(PK.cat, PK.sub)}</select></label>
          <label class="f wide">Item · size · MRP · stock<select id="pk-item"><option value="">— Select sub-category first —</option></select></label>
          <label class="f narrow">Qty<input id="pk-qty" type="number" value="1" min="0" step="any" class="num"></label>
          <button class="primary" id="pk-add">Add item</button>
        </div>
        <div id="s-lines"></div><div id="s-warn"></div>
      </div>
    </div>
    <div>
      <div class="card sumbox" id="s-sum"></div>
    </div>
  </div>`;
  const C = SALE.customer;
  $("#s-date").onchange = e => SALE.date = e.target.value || todayStr();
  $("#s-new").onclick = async () => { if (!SALE.lines.length || await confirmBox("New bill", "Clear the current bill?")) { SALE = newSale(); route(); } };
  $("#c-mobile").oninput = async e => {
    e.target.value = e.target.value.replace(/\D/g, "");
    C.mobile = e.target.value;
    if (C.mobile.length === 10) {
      const cu = await guard(() => api("customer_lookup", { mobile: C.mobile }));
      if (cu) {
        C.name = cu.name; C.city = cu.city; $("#c-name").value = cu.name; $("#c-city").value = cu.city;
        $("#c-hint").innerHTML = `✓ Returning customer — details filled automatically.`;
        $("#scan").focus();
      } else { $("#c-hint").textContent = "New customer — enter name and city."; $("#c-name").focus(); }
    } else $("#c-hint").textContent = "";
  };
  $("#c-name").oninput = e => C.name = e.target.value;
  $("#c-city").oninput = e => C.city = e.target.value;
  $("#scan").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); const v = e.target.value.trim(); e.target.value = ""; if (v) scanItem(v); } };
  $("#s-search").onclick = () => searchItemModal();
  $("#s-return").onclick = () => returnModal();
  $("#pk-cat").onchange = e => { PK.cat = e.target.value; PK.sub = ""; $("#pk-sub").innerHTML = subOpts(PK.cat, ""); loadPickerItems(); };
  $("#pk-sub").onchange = e => { PK.sub = e.target.value; loadPickerItems().then(() => $("#pk-item").focus()); };
  const pkAdd = async () => {
    const id = $("#pk-item").value, q = +$("#pk-qty").value;
    if (!id) { toast("Select an item from the list", "err"); $("#pk-item").focus(); return; }
    if (!(q > 0)) { toast("Enter quantity", "err"); $("#pk-qty").focus(); return; }
    const it = PK.items.find(x => x.id == id);
    if (await addItem(it, q)) { $("#pk-qty").value = 1; loadPickerItems(id).then(() => $("#pk-item").focus()); }
  };
  $("#pk-add").onclick = pkAdd;
  $("#pk-item").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); pkAdd(); } };
  $("#pk-qty").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); pkAdd(); } };
  loadPickerItems();
  renderSaleLines(); renderSaleSummary();
  if (C.mobile.length === 10) $("#scan").focus(); else $("#c-mobile").focus();
};

async function setLines(lines) {
  if (!lines.length) { SALE.lines = []; SALE.calc = null; }
  else {
    const calc = await guard(() => api("bill_preview", { lines, bill_disc: SALE.bill_disc, bill_disc_type: SALE.bill_disc_type }));
    if (!calc) { renderSaleLines(); return false; }
    SALE.lines = lines; SALE.calc = calc;
  }
  if (current === "sales") { renderSaleLines(); renderSaleSummary(); }
  return true;
}
// Item picker (sell without scanning a barcode)
const PK = { cat: "", sub: "", items: [] };
async function loadPickerItems(keep) {
  const sel = $("#pk-item"); if (!sel) return;
  if (!PK.sub) { PK.items = []; sel.innerHTML = `<option value="">— Select sub-category first —</option>`; return; }
  const allowNeg = B.settings.allow_negative_stock === "1";
  PK.items = await guard(() => api("search_items", { subcategory_id: PK.sub, in_stock: allowNeg ? 0 : 1, limit: 1000 })) || [];
  const label = it => [it.brand, it.description].filter(Boolean).join(" ") || it.subcategory;
  sel.innerHTML = PK.items.length
    ? opt("", `— ${PK.items.length} item(s) in stock — select —`) + PK.items.map(it =>
      opt(it.id, `${label(it)}  |  Size ${it.size}  |  MRP ₹${m2(it.mrp)}  |  Stock ${qf(it.stock)}${it.unit === "PCS" ? "" : " " + it.unit}`, keep)).join("")
    : `<option value="">— No stock in this sub-category —</option>`;
}
async function addItem(it, qty = 1, focusQty) {
  const lines = SALE.lines.map(l => ({ ...l }));
  let idx = lines.findIndex(l => !l.return_of && l.item_id === it.id);
  if (idx >= 0) lines[idx].qty = +lines[idx].qty + qty;
  else { lines.push({ item_id: it.id, qty, disc_pct: 0 }); idx = lines.length - 1; }
  if (it.stock <= 0) toast(`${it.barcode} shows 0 stock`, "err");
  const ok = await setLines(lines);
  if (ok && focusQty) { const q = $(`[data-qty="${idx}"]`); if (q) { q.focus(); q.select(); } }
  return ok;
}
async function scanItem(code) {
  let it;
  try { it = await api("find_item", { barcode: code }); } catch (e) {
    // Not a barcode: treat what was typed as a search
    if (!/^\d+$/.test(code)) { searchItemModal(code); return; }
    toast(e.message, "err"); return;
  }
  const isMtr = it.unit === "MTR";
  const exists = SALE.lines.some(l => !l.return_of && l.item_id === it.id);
  if (await addItem(it, isMtr && exists ? 0 : 1, isMtr) && !isMtr) { const s = $("#scan"); s && s.focus(); }
}
function renderSaleLines() {
  const el = $("#s-lines"); if (!el) return;
  const c = SALE.calc;
  if (!c || !c.lines.length) { el.innerHTML = `<div class="empty">No items yet. Scan a barcode to add items.</div>`; $("#s-warn").innerHTML = ""; return; }
  el.innerHTML = `<div class="tbl-wrap"><table class="t"><thead><tr><th>#</th><th>Item</th><th>Size</th><th class="r">MRP</th><th class="r">Qty</th><th class="r">Disc %</th><th class="r">GST</th><th class="r">Amount</th><th></th></tr></thead><tbody>
    ${c.lines.map((l, i) => `<tr class="${l.return_of ? "ret" : ""}"><td>${i + 1}</td>
      <td>${esc(l.name)}<div class="muted mono" style="font-size:11px">${esc(l.barcode)}${l.return_of ? ` · RETURN of ${esc(l.ref_bill)}` : ` · stock ${qf(l.stock)}`}</div></td>
      <td>${esc(l.size)}</td><td class="r">${m2(l.mrp)}</td>
      <td class="r">${l.return_of ? qf(l.qty) : `<input data-qty="${i}" type="number" step="${l.unit === "MTR" ? "0.01" : "1"}" min="0" value="${l.qty}">`}${l.unit === "MTR" ? " m" : ""}</td>
      <td class="r">${l.return_of ? (l.disc_pct ? qf(l.disc_pct) : "") : `<input data-disc="${i}" type="number" step="any" min="0" max="100" value="${l.disc_pct || ""}" style="width:64px">`}</td>
      <td class="r">${qf(l.gst_rate)}%</td><td class="r"><b>${m2(l.amount)}</b></td>
      <td><button class="small danger" data-del="${i}" title="Remove">✕</button></td></tr>`).join("")}
    </tbody></table></div>`;
  $$("[data-qty]", el).forEach(inp => inp.onchange = () => {
    const i = +inp.dataset.qty, v = +inp.value, lines = SALE.lines.map(l => ({ ...l }));
    if (v <= 0) lines.splice(i, 1); else lines[i].qty = v;
    setLines(lines).then(() => { const s = $("#scan"); s && s.focus(); });
  });
  $$("[data-qty]", el).forEach(inp => inp.onkeydown = e => { if (e.key === "Enter") inp.blur(); });
  $$("[data-disc]", el).forEach(inp => inp.onchange = () => {
    const i = +inp.dataset.disc, lines = SALE.lines.map(l => ({ ...l }));
    lines[i].disc_pct = Math.min(100, Math.max(0, +inp.value || 0));
    setLines(lines);
  });
  $$("[data-del]", el).forEach(b => b.onclick = () => { const lines = SALE.lines.slice(); lines.splice(+b.dataset.del, 1); setLines(lines); });
  $("#s-warn").innerHTML = c.warnings.length ? `<div class="warnbox">⚠ Stock warning: ${c.warnings.map(esc).join("<br>")}</div>` : "";
}
// Payment: user enters cash only; the balance automatically goes to the chosen mode (UPI / Card / Cheque).
const BAL_MODES = [["upi", "UPI"], ["card", "Card"], ["cheque", "Cheque"]];
function payBreakup() {
  const net = SALE.calc ? SALE.calc.net : 0;
  const p = SALE.pay;
  if (net <= 0) return { cash: net, balance: 0, change: 0, mode: p.mode };       // refund / zero bill: settled in cash
  const entered = p.cash === "" ? net : Math.max(0, +p.cash || 0);              // blank cash = full cash
  const cash = Math.min(entered, net);
  return { cash, balance: Math.round((net - cash) * 100) / 100, change: Math.max(0, entered - net), mode: p.mode };
}
function payPayload() {
  const b = payBreakup(), out = { cash: b.cash, upi: 0, card: 0, cheque: 0, ref: SALE.pay.ref };
  out[b.mode] += b.balance;
  return out;
}
function renderPayStatus() {
  const el = $("#pay-status"); if (!el) return;
  const b = payBreakup(), modeName = (BAL_MODES.find(m => m[0] === b.mode) || [, ""])[1];
  el.innerHTML = `
    <div class="line"><span>Cash</span><b>${m2(b.cash)}</b></div>
    <div class="line" style="${b.balance > 0 ? "color:var(--info);font-weight:700" : "color:var(--muted)"}"><span>Balance by ${modeName} (auto)</span><span>${m2(b.balance)}</span></div>
    ${b.change > 0 ? `<div class="line" style="color:var(--warn);font-weight:700"><span>Return change to customer</span><span>${m2(b.change)}</span></div>` : ""}`;
  const show = b.balance > 0;
  ["#pay-ref", "#pay-ref-lbl"].forEach(id => { const e = $(id); if (e) e.style.display = show ? "" : "none"; });
}
function renderSaleSummary() {
  const el = $("#s-sum"); if (!el) return;
  const c = SALE.calc || { gross: 0, line_discount: 0, bill_discount: 0, returns: 0, total: 0, round_off: 0, net: 0, taxable: 0, gst: 0, cost: 0, profit: 0, lines: [] };
  const qty = c.lines.filter(l => !l.return_of).reduce((a, l) => a + l.qty, 0);
  const margin = c.taxable ? (c.profit * 100 / c.taxable) : 0;
  const rates = [...new Set(c.lines.map(l => l.gst_rate))];
  const gstLabel = rates.length === 1 ? `GST @ ${qf(rates[0])}% (included)` : "GST (included)";
  el.innerHTML = `<h2>Bill summary</h2>
    <div class="line"><span>Items / Qty</span><span>${c.lines.length} / ${qf(qty)}</span></div>
    <div class="line"><span>Gross (MRP)</span><span>${m2(c.gross)}</span></div>
    ${c.line_discount ? `<div class="line neg"><span>Item discounts</span><span>- ${m2(c.line_discount)}</span></div>` : ""}
    <div class="line" style="align-items:center;gap:8px"><span>Bill discount</span>
      <span style="display:flex;gap:4px;align-items:center"><input id="b-disc" type="number" step="any" min="0" value="${esc(SALE.bill_disc)}" style="width:80px">
      <select id="b-disc-t" style="width:56px">${opt("pct", "%", SALE.bill_disc_type)}${opt("amt", "₹", SALE.bill_disc_type)}</select></span></div>
    ${c.bill_discount ? `<div class="line neg"><span></span><span>- ${m2(c.bill_discount)}</span></div>` : ""}
    ${c.returns ? `<div class="line neg"><span>Returns / exchange</span><span>${m2(c.returns)}</span></div>` : ""}
    <div class="line muted"><span>Taxable value</span><span>${m2(c.taxable)}</span></div>
    <div class="line muted"><span>${gstLabel}</span><span>${m2(c.gst)}</span></div>
    <div class="line muted" style="font-size:12px;padding-top:0"><span>CGST ${m2(c.gst / 2)} + SGST ${m2(c.gst - Math.round(c.gst / 2 * 100) / 100)}</span><span></span></div>
    ${c.round_off ? `<div class="line muted"><span>Round off</span><span>${m2(c.round_off)}</span></div>` : ""}
    <div class="line big"><span>${c.net < 0 ? "REFUND" : "NET"}</span><span>₹${m2(Math.abs(c.net))}</span></div>
    <h2 style="margin-top:14px">Payment</h2>
    ${c.net > 0 ? `<div class="paygrid" style="grid-template-columns:120px 1fr">
      <span>Cash received</span><input class="num" id="pay-cash" type="number" step="any" min="0" value="${esc(SALE.pay.cash)}" placeholder="${m2(c.net)} (full cash)">
      <span>Balance by</span><select id="pay-mode">${BAL_MODES.map(([v, l]) => opt(v, l, SALE.pay.mode)).join("")}</select>
      <span id="pay-ref-lbl">Ref / Cheque no</span><input id="pay-ref" value="${esc(SALE.pay.ref)}" placeholder="optional">
    </div>
    <div class="btns" style="margin:8px 0 4px"><button class="small" data-full="cash">Full Cash</button>${BAL_MODES.map(([v, l]) => `<button class="small" data-full="${v}">Full ${l}</button>`).join("")}</div>`
      : `<div class="muted" style="font-size:13px">${c.net < 0 ? "Refund is settled in cash." : "Nothing to collect."}</div>`}
    <div id="pay-status"></div>
    <div style="margin-top:12px">
      ${!isOwner() ? "" : hideProfit ? `<button class="small link" id="p-eye">Show internal profit</button>`
        : `<div class="profit-box"><div class="line"><b>Internal — profit (never printed)</b><button class="small link" id="p-eye">Hide</button></div>
          <div class="line"><span>Cost of goods</span><span>${m2(c.cost)}</span></div>
          <div class="line"><span>Sale value (excl. GST)</span><span>${m2(c.taxable)}</span></div>
          <div class="line" style="font-size:18px;font-weight:800;color:var(--ok)"><span>Profit</span><span>₹${m2(c.profit)} <small>(${margin.toFixed(1)}%)</small></span></div></div>`}
    </div>
    <div class="btns" style="margin-top:14px">
      <button class="primary big" id="b-save-print" style="flex:1" ${c.lines.length ? "" : "disabled"}>Save &amp; Print (F9)</button>
      <button class="big" id="b-save" ${c.lines.length ? "" : "disabled"}>Save (F8)</button></div>`;
  $("#b-disc").onchange = e => { SALE.bill_disc = e.target.value; setLines(SALE.lines); };
  $("#b-disc-t").onchange = e => { SALE.bill_disc_type = e.target.value; setLines(SALE.lines); };
  const cashIn = $("#pay-cash");
  if (cashIn) {
    cashIn.oninput = () => { SALE.pay.cash = cashIn.value; renderPayStatus(); };
    $("#pay-mode").onchange = e => { SALE.pay.mode = e.target.value; renderPayStatus(); };
    $("#pay-ref").oninput = e => { SALE.pay.ref = e.target.value; };
    $$("[data-full]", el).forEach(b => b.onclick = () => {
      const m = b.dataset.full;
      if (m === "cash") SALE.pay.cash = ""; else { SALE.pay.cash = "0"; SALE.pay.mode = m; }
      renderSaleSummary();
    });
  }
  renderPayStatus();
  const eye = $("#p-eye"); if (eye) eye.onclick = () => { hideProfit = !hideProfit; store.set("hide_profit", hideProfit); renderSaleSummary(); };
  $("#b-save-print").onclick = () => saveBill(true);
  $("#b-save").onclick = () => saveBill(false);
}
let saving = false;
async function saveBill(print) {
  if (saving || !SALE.lines.length) return;
  const C = SALE.customer;
  if (!/^\d{10}$/.test(C.mobile)) { toast("Enter a valid 10-digit mobile number", "err"); $("#c-mobile").focus(); return; }
  if (!C.name.trim()) { toast("Enter customer name", "err"); $("#c-name").focus(); return; }
  const b = payBreakup();
  if (b.balance > 0 && b.mode === "cheque" && !String(SALE.pay.ref || "").trim()) { toast("Enter the cheque number", "err"); $("#pay-ref").focus(); return; }
  saving = true;
  const bill = await guard(() => api("save_bill", { customer: C, date: SALE.date, lines: SALE.lines, bill_disc: SALE.bill_disc, bill_disc_type: SALE.bill_disc_type, pay: payPayload() }));
  saving = false;
  if (!bill) return;
  SALE = newSale();
  route();
  if (print) { printInvoice(bill); return; }
  const m = modal({
    title: `Bill ${bill.bill_no} saved`,
    body: `<div style="font-size:28px;font-weight:800;color:var(--brand)">${bill.net < 0 ? "Refund" : "Net"} ₹${m2(Math.abs(bill.net))}</div>
      <div>${esc(bill.customer.name)} · ${esc(bill.customer.mobile)} · ${esc(bill.customer.city)}</div>
      <div class="muted">${payModes(bill).map(p => `${p[0]} ${m2(p[1])}`).join(" · ")}</div>
      ${b.change > 0 ? `<div style="font-weight:700;color:var(--warn)">Return change: ₹${m2(b.change)}</div>` : ""}`,
    foot: `<button data-p>Print preview</button><button class="primary" data-n>New bill (Enter)</button>`,
  });
  $("[data-p]", m.el).onclick = () => { m.close(); printInvoice(bill); };
  $("[data-n]", m.el).onclick = () => m.close();
  setTimeout(() => $("[data-n]", m.el).focus(), 50);
}
function searchItemModal(initial = "") {
  const m = modal({ title: "Search item", wide: true, body: `<input id="si-q" value="${esc(initial)}" placeholder="Type sub-category, brand, description, size or barcode…"><div id="si-res" class="tbl-wrap" style="max-height:420px"></div>` });
  let timer;
  const run = async () => {
    const res = await guard(() => api("search_items", { q: $("#si-q", m.el).value, in_stock: 1, limit: 100 }));
    if (!res) return;
    $("#si-res", m.el).innerHTML = res.length ? `<table class="t"><thead><tr><th>Barcode</th><th>Item</th><th>Size</th><th class="r">MRP</th><th class="r">Stock</th><th></th></tr></thead><tbody>
      ${res.map(it => `<tr><td class="mono">${esc(it.barcode)}</td><td>${esc(it.name)} <span class="muted">${esc(it.category)}</span></td><td>${esc(it.size)}</td><td class="r">${m2(it.mrp)}</td><td class="r">${qf(it.stock)}</td><td><button class="small primary" data-add="${esc(it.barcode)}">Add</button></td></tr>`).join("")}</tbody></table>`
      : `<div class="empty">No items in stock match.</div>`;
    $$("[data-add]", m.el).forEach(b => b.onclick = () => { scanItem(b.dataset.add); toast("Added " + b.dataset.add, "ok"); });
  };
  $("#si-q", m.el).oninput = () => { clearTimeout(timer); timer = setTimeout(run, 250); };
  run();
}
function returnModal(prefill = "") {
  const m = modal({
    title: "Return / Exchange — items from an earlier bill", wide: true,
    body: `<div class="row"><label class="f">Original bill number<input id="r-bill" value="${esc(prefill)}" placeholder="e.g. ${esc(B.settings.bill_prefix)}00012"></label><button id="r-find" class="primary">Find bill</button></div>
      <div class="muted" style="font-size:12px">Returned items are added to the current bill as negative lines and go back into stock. For an exchange, also scan the new items — the customer pays only the difference.</div>
      <div id="r-res"></div>`,
  });
  const find = async () => {
    const bill = await guard(() => api("get_bill", { bill_no: $("#r-bill", m.el).value }));
    if (!bill) return;
    if (bill.status !== "ACTIVE") { $("#r-res", m.el).innerHTML = `<div class="warnbox">This bill is cancelled.</div>`; return; }
    const lines = bill.lines.filter(l => !l.return_of);
    const inCart = id => SALE.lines.filter(x => x.return_of === id).reduce((a, x) => a + (+x.qty || 0), 0);
    $("#r-res", m.el).innerHTML = `<div><b>${esc(bill.bill_no)}</b> · ${dmy(bill.date)} · ${esc(bill.customer.name)} · ${esc(bill.customer.mobile)} · Net ${money(bill.net)}</div>
      <table class="t"><thead><tr><th>Item</th><th>Size</th><th class="r">Sold</th><th class="r">Already returned</th><th class="r">Paid / unit</th><th class="r">Return qty</th></tr></thead><tbody>
      ${lines.map(l => { const left = l.qty - l.returned - inCart(l.id); return `<tr><td>${esc(l.name)}<div class="muted mono" style="font-size:11px">${esc(l.barcode)}</div></td><td>${esc(l.size)}</td><td class="r">${qf(l.qty)}</td><td class="r">${qf(l.returned + inCart(l.id))}</td><td class="r">${m2(l.amount / l.qty)}</td>
        <td class="r">${left > 0 ? `<input type="number" step="${l.unit === "MTR" ? "0.01" : "1"}" min="0" max="${left}" data-rl="${l.id}" placeholder="0" style="width:70px"> / ${qf(left)}` : "—"}</td></tr>`; }).join("")}
      </tbody></table><div class="btns" style="justify-content:flex-end;margin-top:10px"><button class="primary" id="r-add">Add returns to current bill</button></div>`;
    $("#r-add", m.el).onclick = async () => {
      const add = $$("[data-rl]", m.el).map(i => ({ return_of: +i.dataset.rl, qty: +i.value || 0 })).filter(x => x.qty > 0);
      if (!add.length) { toast("Enter a return quantity", "err"); return; }
      if (!SALE.customer.mobile) { SALE.customer = { mobile: bill.customer.mobile, name: bill.customer.name, city: bill.customer.city }; }
      const merged = SALE.lines.map(l => ({ ...l }));
      for (const a of add) { const ex = merged.find(x => x.return_of === a.return_of); if (ex) ex.qty += a.qty; else merged.push(a); }
      if (await setLines(merged)) {
        m.close();
        if (current === "sales") route(); else location.hash = "#sales";
        toast("Return items added to the bill", "ok");
      }
    };
  };
  $("#r-find", m.el).onclick = find;
  $("#r-bill", m.el).onkeydown = e => { if (e.key === "Enter") find(); };
  if (prefill) find();
}

// ================================================================ BILLS
const BF = { from: shiftDate(todayStr(), -30), to: todayStr(), q: "" };
PAGES.bills = async main => {
  main.innerHTML = `<div class="page-head"><h1>Bills &amp; Returns</h1><span class="spacer"></span><button class="primary" onclick="location.hash='#sales'">+ New bill</button></div>
  <div class="card"><div class="row">
    <label class="f narrow">From<input type="date" id="bf-from" value="${BF.from}"></label>
    <label class="f narrow">To<input type="date" id="bf-to" value="${BF.to}"></label>
    <label class="f wide">Search bill no / mobile / name<input id="bf-q" value="${esc(BF.q)}"></label>
    <button class="primary" id="bf-go">Show</button></div></div>
  <div class="card"><div id="bf-res" class="tbl-wrap tall"></div></div>`;
  const go = async () => {
    BF.from = $("#bf-from").value; BF.to = $("#bf-to").value; BF.q = $("#bf-q").value;
    const res = await guard(() => api("list_bills", BF));
    if (!res) return;
    const act = res.filter(r => r.status === "ACTIVE");
    const sum = k => act.reduce((a, r) => a + (+r[k] || 0), 0);
    $("#bf-res").innerHTML = res.length ? `<table class="t"><thead><tr><th>Date</th><th>Bill No</th><th>Customer</th><th>Mobile</th><th>City</th><th class="r">Qty</th><th class="r">Net</th>${isOwner() ? '<th class="r">Profit</th>' : ""}<th>Paid by</th><th>Status</th></tr></thead><tbody>
      ${res.map(r => `<tr class="${r.status === "CANCELLED" ? "cancelled" : ""}"><td>${dmy(r.date)}</td><td><button class="link" data-bill="${r.id}">${esc(r.bill_no)}</button></td><td>${esc(r.customer)}</td><td>${esc(r.mobile)}</td><td>${esc(r.city)}</td>
        <td class="r">${qf(r.qty)}</td><td class="r">${money(r.net)}</td>${isOwner() ? `<td class="r">${money(r.profit)}</td>` : ""}
        <td>${payModes(r).map(p => p[0]).join(" + ")}</td>
        <td>${r.status === "ACTIVE" ? (r.returns ? '<span class="pill warn">RETURN</span>' : '<span class="pill ok">OK</span>') : '<span class="pill bad">CANCELLED</span>'}</td></tr>`).join("")}
      </tbody><tfoot><tr><td colspan="5">${act.length} active bills</td><td class="r">${qf(sum("qty"))}</td><td class="r">${money(sum("net"))}</td>${isOwner() ? `<td class="r">${money(sum("profit"))}</td>` : ""}<td colspan="2"></td></tr></tfoot></table>`
      : `<div class="empty">No bills found.</div>`;
    $$("[data-bill]", main).forEach(b => b.onclick = () => viewBill(+b.dataset.bill, go));
  };
  $("#bf-go").onclick = go;
  $("#bf-q").onkeydown = e => { if (e.key === "Enter") go(); };
  go();
};
async function viewBill(id, after) {
  const bill = await guard(() => api("get_bill", { id }));
  if (!bill) return;
  const m = modal({
    title: `Bill ${bill.bill_no}`, wide: true,
    body: `<div style="border:1px solid var(--line);padding:14px;border-radius:6px">${invoiceHTML(bill, "A4")}</div>`,
    foot: `${bill.status === "ACTIVE" ? `${isOwner() ? `<button class="danger" data-cancel>Cancel bill</button>` : ""}<button data-ret>Return / Exchange items</button>` : ""}<button class="primary" data-print>Print preview</button>`,
  });
  $("[data-print]", m.el).onclick = () => { m.close(); printInvoice(bill); };
  const ret = $("[data-ret]", m.el);
  if (ret) ret.onclick = () => { m.close(); location.hash = "#sales"; setTimeout(() => returnModal(bill.bill_no), 150); };
  const can = $("[data-cancel]", m.el);
  if (can) can.onclick = async () => {
    if (!await confirmBox("Cancel bill", `Cancel bill <b>${esc(bill.bill_no)}</b>? All its items go back into stock. This cannot be undone.`, "Cancel bill")) return;
    if (await guard(() => api("cancel_bill", { id }))) { toast("Bill cancelled", "ok"); m.close(); after ? after() : route(); }
  };
}

// ================================================================ CUSTOMERS
const CF = { q: "" };
PAGES.customers = async main => {
  main.innerHTML = `<div class="page-head"><h1>Customers</h1><span class="sub">Customer details (name, mobile, city) are saved automatically with every bill.</span><span class="spacer"></span>
    <button id="cu-add">+ Add customer</button>${isOwner() ? `<button onclick="REP.name='customer_list';location.hash='#reports?customer_list'">Customer report / Excel</button>` : ""}</div>
  <div class="card"><div class="row"><label class="f wide">Search name / mobile / city<input id="cu-q" value="${esc(CF.q)}"></label><button class="primary" id="cu-go">Search</button></div></div>
  <div class="card"><div id="cu-res"></div></div>`;
  const form = (c, after) => formModal(c.id ? "Edit customer" : "Add customer", [
    { k: "mobile", label: "Mobile (10 digits)", req: true }, { k: "name", label: "Name", req: true }, { k: "city", label: "City" }], c,
    async v => { const r = await api("save_customer", v); toast("Customer saved", "ok"); after(); return r; });
  const go = async () => {
    CF.q = $("#cu-q").value;
    const res = await guard(() => api("list_customers", { q: CF.q })); if (!res) return;
    $("#cu-res").innerHTML = res.length ? `<div class="muted" style="margin-bottom:8px">${res.length} customers</div><div class="tbl-wrap tall"><table class="t"><thead><tr><th>Name</th><th>Mobile</th><th>City</th><th>Customer since</th><th class="r">Bills</th><th class="r">Total purchases</th><th>Last visit</th><th></th></tr></thead><tbody>
      ${res.map((c, i) => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.mobile)}</td><td>${esc(c.city)}</td><td>${dmy((c.created_at || "").slice(0, 10))}</td><td class="r">${c.bills}</td><td class="r">${money(c.amount)}</td><td>${dmy(c.last || "")}</td>
        <td style="white-space:nowrap"><button class="small" data-h="${i}">Bills</button> <button class="small" data-e="${i}">Edit</button></td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">No customers yet. They are added automatically when you save a bill.</div>`;
    $$("[data-e]", main).forEach(b => b.onclick = () => form(res[+b.dataset.e], go));
    $$("[data-h]", main).forEach(b => b.onclick = async () => {
      const c = res[+b.dataset.h], bills = await guard(() => api("customer_bills", { id: c.id })); if (!bills) return;
      const m = modal({ title: `${c.name} · ${c.mobile} · ${c.city || ""}`, wide: true,
        body: bills.length ? `<table class="t"><thead><tr><th>Date</th><th>Bill</th><th class="r">Qty</th><th class="r">Amount</th><th>Status</th></tr></thead><tbody>
          ${bills.map(x => `<tr class="${x.status === "CANCELLED" ? "cancelled" : ""}"><td>${dmy(x.date)}</td><td><button class="link" data-b="${x.id}">${esc(x.bill_no)}</button></td><td class="r">${qf(x.qty)}</td><td class="r">${money(x.net)}</td><td>${esc(x.status)}</td></tr>`).join("")}</tbody></table>`
          : `<div class="empty">No bills yet.</div>` });
      $$("[data-b]", m.el).forEach(x => x.onclick = () => viewBill(+x.dataset.b));
    });
  };
  $("#cu-add").onclick = () => form({}, go);
  $("#cu-go").onclick = go;
  $("#cu-q").onkeydown = e => { if (e.key === "Enter") go(); };
  go();
};

// ================================================================ EXPENSES & CASH
const EXP_MODES = [["CASH", "Cash"], ["UPI", "UPI"], ["BANK", "Bank transfer"], ["CARD", "Card"], ["CHEQUE", "Cheque"]];
const EX = { tab: "exp", from: todayStr().slice(0, 8) + "01", to: todayStr(), head_id: "", edit: null, cedit: null };
function openingCashForm(after) {
  formModal("Opening cash in hand", [
    { k: "opening_cash", label: "Cash in the drawer at the start (₹)", type: "number", req: true },
    { k: "opening_cash_date", label: "As on date (start of that day)", type: "date", req: true,
      hint: "Count the cash in your drawer at the start of a day and enter it here. Cash in hand is calculated from this date onwards." }],
    { opening_cash: B.settings.opening_cash || "0", opening_cash_date: B.settings.opening_cash_date || todayStr() },
    async v => { const r = await api("save_settings", { settings: v }); await loadB(); toast("Opening cash saved", "ok"); after && after(); return r; });
}
PAGES.expenses = async main => {
  await loadB();
  const tabs = [["exp", "Expenses"], ["cash", "Cash In / Out"], ["book", "Cash Book"], ["heads", "Expense Heads"]];
  main.innerHTML = `<div class="page-head"><h1>Expenses &amp; Cash</h1><span class="sub">Record day-to-day expenses and cash movements. Cash in hand updates automatically.</span>
      <span class="spacer"></span><button id="ex-open">Opening cash: ${money(B.settings.opening_cash)}${B.settings.opening_cash_date ? " on " + dmy(B.settings.opening_cash_date) : " (not set)"}</button></div>
    ${!B.settings.opening_cash_date ? `<div class="banner">Set your <b>opening cash</b> (cash in the drawer when you start using SuperSoft) so that Cash in Hand is correct. <button class="small primary" id="ex-open2">Set opening cash</button></div>` : ""}
    <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${EX.tab === k ? "on" : ""}">${l}</button>`).join("")}</div><div id="ex-body"></div>`;
  $$("[data-tab]", main).forEach(b => b.onclick = () => { EX.tab = b.dataset.tab; EX.edit = EX.cedit = null; route(); });
  $("#ex-open").onclick = () => openingCashForm(route);
  const o2 = $("#ex-open2"); if (o2) o2.onclick = () => openingCashForm(route);
  const body = $("#ex-body");
  const dateFilter = (extra = "") => `<div class="row"><label class="f narrow">From<input type="date" id="xf-from" value="${EX.from}"></label>
      <label class="f narrow">To<input type="date" id="xf-to" value="${EX.to}"></label>
      <div class="btns"><button class="small" data-xp="today">Today</button><button class="small" data-xp="month">This month</button><button class="small" data-xp="last">Last month</button></div>${extra}
      <button class="primary" id="xf-go">Show</button></div>`;
  const bindDates = go => {
    $$("[data-xp]", body).forEach(b => b.onclick = () => {
      const t = todayStr(), p = b.dataset.xp;
      if (p === "today") EX.from = EX.to = t;
      if (p === "month") { EX.from = t.slice(0, 8) + "01"; EX.to = t; }
      if (p === "last") { const d = shiftDate(t.slice(0, 8) + "01", -1); EX.from = d.slice(0, 8) + "01"; EX.to = d; }
      $("#xf-from").value = EX.from; $("#xf-to").value = EX.to; go();
    });
    $("#xf-go").onclick = () => { EX.from = $("#xf-from").value; EX.to = $("#xf-to").value; go(); };
  };

  if (EX.tab === "exp") {
    const e = EX.edit || { date: todayStr(), head_id: "", amount: "", paid_by: "CASH", paid_to: "", note: "" };
    body.innerHTML = `<div class="card"><h2>${EX.edit ? "Edit expense" : "Add expense"}</h2><form id="xe-form" class="row">
        <label class="f narrow">Date *<input type="date" name="date" value="${e.date}"></label>
        <label class="f">Expense head *<span style="display:flex;gap:6px"><select name="head_id">${opt("", "— Select —", e.head_id)}${B.expense_heads.map(h => opt(h.id, h.name, e.head_id)).join("")}</select><button type="button" id="xe-addhead" title="Add expense head">+</button></span></label>
        <label class="f narrow">Amount ₹ *<input name="amount" type="number" step="any" min="0" class="num" value="${esc(e.amount)}"></label>
        <label class="f narrow">Paid by<select name="paid_by">${EXP_MODES.map(([v, l]) => opt(v, l, e.paid_by)).join("")}</select></label>
        <label class="f">Paid to<input name="paid_to" value="${esc(e.paid_to)}" placeholder="e.g. Landlord, Staff name"></label>
        <label class="f wide">Note<input name="note" value="${esc(e.note)}"></label>
        <button class="primary" type="submit">${EX.edit ? "Update" : "Save expense"}</button>${EX.edit ? `<button type="button" id="xe-cancel">Cancel</button>` : ""}
      </form><div class="muted" style="font-size:12px;margin-top:6px">Only expenses paid in <b>Cash</b> reduce Cash in Hand. All expenses are deducted from profit in the Profit &amp; Loss report.</div></div>
      <div class="card">${dateFilter(`<label class="f">Head<select id="xf-head">${opt("", "All heads", EX.head_id)}${B.expense_heads.map(h => opt(h.id, h.name, EX.head_id)).join("")}</select></label>`)}</div>
      <div class="grid" style="grid-template-columns:minmax(0,1fr) 300px"><div class="card"><div id="xe-list"></div></div><div class="card"><h2>By head</h2><div id="xe-heads"></div></div></div>`;
    const f = $("#xe-form");
    f.onsubmit = async ev => {
      ev.preventDefault();
      const v = Object.fromEntries(new FormData(f).entries());
      if (EX.edit) v.id = EX.edit.id;
      if (await guard(() => api("save_expense", v))) { toast(EX.edit ? "Expense updated" : "Expense saved", "ok"); EX.edit = null; route(); }
    };
    $("#xe-addhead").onclick = () => formModal("Add expense head", [{ k: "name", label: "Expense head", req: true, ph: "e.g. Diwali decoration" }], {},
      async v => { const r = await api("save_expense_head", v); await loadB(); $('[name="head_id"]', f).innerHTML = opt("", "— Select —") + B.expense_heads.map(h => opt(h.id, h.name, r.id)).join(""); return r; });
    const c = $("#xe-cancel"); if (c) c.onclick = () => { EX.edit = null; route(); };
    const go = async () => {
      EX.head_id = $("#xf-head").value;
      const res = await guard(() => api("list_expenses", { from: EX.from, to: EX.to, head_id: EX.head_id })); if (!res) return;
      const tot = res.reduce((a, r) => a + r.amount, 0), cash = res.filter(r => r.paid_by === "CASH").reduce((a, r) => a + r.amount, 0);
      $("#xe-list").innerHTML = res.length ? `<div class="tbl-wrap tall"><table class="t"><thead><tr><th>Date</th><th>Head</th><th>Paid to</th><th>Paid by</th><th>Note</th><th class="r">Amount</th><th></th></tr></thead><tbody>
        ${res.map((r, i) => `<tr><td>${dmy(r.date)}</td><td>${esc(r.head)}</td><td>${esc(r.paid_to)}</td><td>${r.paid_by === "CASH" ? '<span class="pill warn">CASH</span>' : esc(r.paid_by)}</td><td>${esc(r.note)}</td><td class="r"><b>${m2(r.amount)}</b></td>
          <td style="white-space:nowrap"><button class="small" data-xe="${i}">Edit</button> <button class="small danger" data-xd="${i}">✕</button></td></tr>`).join("")}
        </tbody><tfoot><tr><td colspan="5">${res.length} entries · cash ${money(cash)} · other ${money(tot - cash)}</td><td class="r">${money(tot)}</td><td></td></tr></tfoot></table></div>`
        : `<div class="empty">No expenses in this period.</div>`;
      const byHead = {};
      res.forEach(r => byHead[r.head] = (byHead[r.head] || 0) + r.amount);
      const mx = Math.max(1, ...Object.values(byHead));
      $("#xe-heads").innerHTML = Object.keys(byHead).length ? Object.entries(byHead).sort((a, b) => b[1] - a[1]).map(([h, v]) =>
        `<div class="hbar" style="grid-template-columns:minmax(80px,40%) 1fr auto"><span class="lbl">${esc(h)}</span><div class="track"><div class="fill" style="width:${v / mx * 100}%"></div></div><span class="val">${m2(v)}</span></div>`).join("")
        + `<div class="line" style="display:flex;justify-content:space-between;border-top:1px solid var(--line);margin-top:8px;padding-top:8px;font-weight:700"><span>Total</span><span>${money(tot)}</span></div>`
        : `<div class="empty">—</div>`;
      $$("[data-xe]", body).forEach(b => b.onclick = () => { EX.edit = res[+b.dataset.xe]; route(); });
      $$("[data-xd]", body).forEach(b => b.onclick = async () => {
        const r = res[+b.dataset.xd];
        if (await confirmBox("Delete expense", `Delete ${esc(r.head)} ₹${m2(r.amount)} on ${dmy(r.date)}?`, "Delete") && await guard(() => api("delete_expense", { id: r.id }))) { toast("Deleted", "ok"); go(); }
      });
    };
    bindDates(go); go();
    $('[name="amount"]', f).focus();
  }

  if (EX.tab === "cash") {
    const e = EX.cedit || { date: todayStr(), direction: "OUT", reason: "", amount: "", note: "" };
    const reasons = dir => (dir === "IN" ? B.cash_in_reasons : B.cash_out_reasons);
    body.innerHTML = `<div class="card"><h2>${EX.cedit ? "Edit cash entry" : "Cash in / out (not an expense)"}</h2><form id="xc-form" class="row">
        <label class="f narrow">Date *<input type="date" name="date" value="${e.date}"></label>
        <label class="f narrow">Type *<select name="direction">${opt("OUT", "Cash Out (−)", e.direction)}${opt("IN", "Cash In (+)", e.direction)}</select></label>
        <label class="f">Reason *<input name="reason" list="xc-reasons" value="${esc(e.reason)}" placeholder="Choose or type"><datalist id="xc-reasons">${reasons(e.direction).map(r => `<option value="${esc(r)}">`).join("")}</datalist></label>
        <label class="f narrow">Amount ₹ *<input name="amount" type="number" step="any" min="0" class="num" value="${esc(e.amount)}"></label>
        <label class="f wide">Note<input name="note" value="${esc(e.note)}"></label>
        <button class="primary" type="submit">${EX.cedit ? "Update" : "Save"}</button>${EX.cedit ? `<button type="button" id="xc-cancel">Cancel</button>` : ""}
      </form><div class="muted" style="font-size:12px;margin-top:6px">Use this for cash that moves without being an expense: depositing cash in the bank, owner taking cash home, paying a supplier in cash, or adding cash to the drawer. These change Cash in Hand but not profit.</div></div>
      <div class="card">${dateFilter()}</div><div class="card"><div id="xc-list"></div></div>`;
    const f = $("#xc-form");
    $('[name="direction"]', f).onchange = ev => { $("#xc-reasons").innerHTML = reasons(ev.target.value).map(r => `<option value="${esc(r)}">`).join(""); $('[name="reason"]', f).value = ""; };
    f.onsubmit = async ev => {
      ev.preventDefault();
      const v = Object.fromEntries(new FormData(f).entries());
      if (EX.cedit) v.id = EX.cedit.id;
      if (await guard(() => api("save_cash_entry", v))) { toast("Saved", "ok"); EX.cedit = null; route(); }
    };
    const c = $("#xc-cancel"); if (c) c.onclick = () => { EX.cedit = null; route(); };
    const go = async () => {
      const res = await guard(() => api("list_cash_entries", { from: EX.from, to: EX.to })); if (!res) return;
      const tin = res.filter(r => r.direction === "IN").reduce((a, r) => a + r.amount, 0), tout = res.filter(r => r.direction === "OUT").reduce((a, r) => a + r.amount, 0);
      $("#xc-list").innerHTML = res.length ? `<div class="tbl-wrap tall"><table class="t"><thead><tr><th>Date</th><th>Type</th><th>Reason</th><th>Note</th><th class="r">Amount</th><th></th></tr></thead><tbody>
        ${res.map((r, i) => `<tr><td>${dmy(r.date)}</td><td>${r.direction === "IN" ? '<span class="pill ok">CASH IN</span>' : '<span class="pill bad">CASH OUT</span>'}</td><td>${esc(r.reason)}</td><td>${esc(r.note)}</td>
          <td class="r"><b>${r.direction === "IN" ? "+" : "−"} ${m2(r.amount)}</b></td><td style="white-space:nowrap"><button class="small" data-ce="${i}">Edit</button> <button class="small danger" data-cd="${i}">✕</button></td></tr>`).join("")}
        </tbody><tfoot><tr><td colspan="4">Cash in ${money(tin)} · Cash out ${money(tout)}</td><td class="r">${money(tin - tout)}</td><td></td></tr></tfoot></table></div>`
        : `<div class="empty">No cash in/out entries in this period.</div>`;
      $$("[data-ce]", body).forEach(b => b.onclick = () => { EX.cedit = res[+b.dataset.ce]; route(); });
      $$("[data-cd]", body).forEach(b => b.onclick = async () => {
        const r = res[+b.dataset.cd];
        if (await confirmBox("Delete entry", `Delete ${esc(r.reason)} ₹${m2(r.amount)}?`, "Delete") && await guard(() => api("delete_cash_entry", { id: r.id }))) { toast("Deleted", "ok"); go(); }
      });
    };
    bindDates(go); go();
  }

  if (EX.tab === "book") {
    body.innerHTML = `<div class="card">${dateFilter()}</div><div id="xb-sum" class="grid g4" style="margin-bottom:16px"></div><div class="card"><div id="xb-list"></div></div>`;
    const go = async () => {
      const cb = await guard(() => api("cash_book", { from: EX.from, to: EX.to })); if (!cb) return;
      const s = k => cb.days.reduce((a, d) => a + d[k], 0);
      const tile = (k, v, cls = "") => `<div class="kpi ${cls}"><div class="k">${k}</div><div class="v" style="font-size:20px">${v}</div></div>`;
      $("#xb-sum").innerHTML = tile("Opening cash", money(cb.opening)) + tile("+ Cash sales & cash added", money(s("cash_sales") + s("cash_in")), "good")
        + tile("− Cash expenses & cash out", money(s("cash_expenses") + s("cash_out"))) + tile("= Closing cash in hand", money(cb.closing), "good");
      $("#xb-list").innerHTML = cb.days.length ? `<div class="tbl-wrap tall"><table class="t"><thead><tr><th>Date</th><th class="r">Opening</th><th class="r">+ Cash sales</th><th class="r">+ Cash added</th><th class="r">− Cash expenses</th><th class="r">− Cash out</th><th class="r">Closing</th></tr></thead><tbody>
        ${cb.days.slice().reverse().map(d => `<tr><td>${dmy(d.date)}</td><td class="r">${m2(d.opening)}</td><td class="r">${d.cash_sales ? m2(d.cash_sales) : ""}</td><td class="r">${d.cash_in ? m2(d.cash_in) : ""}</td>
          <td class="r">${d.cash_expenses ? m2(d.cash_expenses) : ""}</td><td class="r">${d.cash_out ? m2(d.cash_out) : ""}</td><td class="r"><b>${m2(d.closing)}</b></td></tr>`).join("")}
        </tbody><tfoot><tr><td>Total</td><td class="r">${m2(cb.opening)}</td><td class="r">${m2(s("cash_sales"))}</td><td class="r">${m2(s("cash_in"))}</td><td class="r">${m2(s("cash_expenses"))}</td><td class="r">${m2(s("cash_out"))}</td><td class="r">${m2(cb.closing)}</td></tr></tfoot></table></div>`
        : `<div class="empty">No cash activity in this period.</div>`;
    };
    bindDates(go); go();
  }

  if (EX.tab === "heads") {
    body.innerHTML = `<div class="card"><h2>Expense heads<span class="spacer"></span><button class="small primary" id="xh-add">+ Add head</button></h2>
      <table class="t"><tbody>${B.expense_heads.map(h => `<tr><td><b>${esc(h.name)}</b></td><td class="muted">${h.used} entries</td><td style="text-align:right;white-space:nowrap"><button class="small" data-he="${h.id}">Rename</button> <button class="small danger" data-hd="${h.id}">Delete</button></td></tr>`).join("")}</tbody></table></div>`;
    const f = h => formModal(h.id ? "Rename expense head" : "Add expense head", [{ k: "name", label: "Expense head", req: true }], h,
      async v => { const r = await api("save_expense_head", v); await loadB(); route(); return r; });
    $("#xh-add").onclick = () => f({});
    $$("[data-he]", body).forEach(b => b.onclick = () => f(B.expense_heads.find(h => h.id == b.dataset.he)));
    $$("[data-hd]", body).forEach(b => b.onclick = async () => {
      if (await confirmBox("Delete", "Delete this expense head?", "Delete") && await guard(() => api("delete_expense_head", { id: +b.dataset.hd }))) { await loadB(); route(); }
    });
  }
};
async function showCashToday() {
  const t = todayStr(), cb = await guard(() => api("cash_book", { from: t, to: t })); if (!cb) return;
  const d = cb.days[0] || { opening: cb.opening, cash_sales: 0, cash_in: 0, cash_expenses: 0, cash_out: 0, closing: cb.closing };
  const ln = (l, v, st = "") => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line);${st}"><span>${l}</span><span>${v}</span></div>`;
  const m = modal({
    title: `Cash in hand — ${dmy(t)}`,
    body: `${!B.settings.opening_cash_date ? `<div class="banner">Opening cash is not set, so this starts from ₹0. Set it for an accurate figure.</div>` : ""}
      ${ln("Opening cash (start of today)", m2(d.opening))}${ln("+ Cash received from sales (net of cash refunds)", m2(d.cash_sales))}
      ${ln("+ Cash added", m2(d.cash_in))}${ln("− Cash expenses", m2(d.cash_expenses))}${ln("− Cash taken out (bank deposit / owner / supplier)", m2(d.cash_out))}
      ${ln("<b>= Cash in hand now</b>", `<b>₹${m2(d.closing)}</b>`, "font-size:18px;color:var(--ok);border-bottom:none")}
      <div class="muted" style="font-size:12px">Count the cash in your drawer — it should match this amount.</div>`,
    foot: `<button data-oc>Set opening cash</button><button data-exp>+ Add expense</button><button class="primary" data-book>Open cash book</button>`,
  });
  $("[data-oc]", m.el).onclick = () => { m.close(); openingCashForm(route); };
  $("[data-exp]", m.el).onclick = () => { m.close(); EX.tab = "exp"; location.hash = "#expenses"; };
  $("[data-book]", m.el).onclick = () => { m.close(); EX.tab = "book"; location.hash = "#expenses"; };
}

// ================================================================ STOCK INWARD
const newInward = () => ({ date: todayStr(), supplier_id: "", supplier_bill_no: "", gst_amount: "", notes: "", lines: [],
  e: { category_id: "", subcategory_id: "", brand_id: "", description: "", markup: "", unit: "PCS", rows: {}, extra: [] } });
let INW = newInward();

PAGES.inward = async main => {
  if (INW.e.markup === "") INW.e.markup = B.settings.default_markup;
  main.innerHTML = `
  <div class="page-head">${INW.edit_id ? `<h1>Edit Inward ${esc(INW.inward_no)}</h1><span class="pill warn">EDITING</span><span class="sub">Barcodes stay the same. Stock is corrected automatically.</span>`
    : `<h1>Stock Inward</h1><span class="sub">Record goods received from a supplier. Barcodes are created automatically on saving.</span>`}</div>
  <div class="card"><h2>1. Inward details</h2><div class="row">
    <label class="f narrow">Date *<input type="date" id="i-date" value="${INW.date}"></label>
    <label class="f wide">Supplier *<span style="display:flex;gap:6px"><select id="i-sup">${supOpts(INW.supplier_id)}</select><button id="i-sup-add" title="Add supplier">+</button></span></label>
    <label class="f">Supplier bill no<input id="i-bill" value="${esc(INW.supplier_bill_no)}"></label>
    <label class="f narrow">Purchase GST ₹<input id="i-gst" type="number" step="any" class="num" value="${esc(INW.gst_amount)}" title="GST amount on the supplier's bill (for the purchase register)"></label>
    <label class="f">Notes<input id="i-notes" value="${esc(INW.notes)}"></label>
  </div></div>
  <div class="card"><h2>2. Add items</h2>
    <div class="row">
      <label class="f">Category *<select id="e-cat">${catOpts(INW.e.category_id)}</select></label>
      <label class="f">Sub-category *<select id="e-sub">${subOpts(INW.e.category_id, INW.e.subcategory_id)}</select></label>
      <label class="f">Brand<span style="display:flex;gap:6px"><select id="e-brand">${brandOpts(INW.e.brand_id)}</select><button id="e-brand-add" title="Add brand">+</button></span></label>
      <label class="f wide">Description / design / colour<input id="e-desc" value="${esc(INW.e.description)}" placeholder="e.g. Cotton RN, White"></label>
      <label class="f narrow">Markup % *<input id="e-markup" type="number" step="any" class="num" value="${esc(INW.e.markup)}"></label>
      <label class="f narrow">Unit<select id="e-unit">${UNIT_OPTS.map(([v, l]) => opt(v, v, INW.e.unit)).join("")}</select></label>
    </div>
    <div id="e-sizes" style="margin-top:14px"></div>
  </div>
  <div class="card"><h2>3. Items in this inward</h2><div id="i-lines"></div></div>`;

  $("#i-date").onchange = e => INW.date = e.target.value;
  $("#i-sup").onchange = e => INW.supplier_id = e.target.value;
  $("#i-bill").oninput = e => INW.supplier_bill_no = e.target.value;
  $("#i-gst").oninput = e => INW.gst_amount = e.target.value;
  $("#i-notes").oninput = e => INW.notes = e.target.value;
  $("#i-sup-add").onclick = () => supplierForm({}, async id => { INW.supplier_id = id; $("#i-sup").innerHTML = supOpts(id); });
  $("#e-brand-add").onclick = () => formModal("Add brand", [{ k: "name", label: "Brand name", req: true }], {}, async v => {
    const r = await api("save_brand", v); await loadB(); INW.e.brand_id = r.id; $("#e-brand").innerHTML = brandOpts(r.id); return r;
  });
  $("#e-cat").onchange = e => { INW.e.category_id = e.target.value; INW.e.subcategory_id = ""; $("#e-sub").innerHTML = subOpts(INW.e.category_id, ""); INW.e.rows = {}; INW.e.extra = []; renderSizeGrid(); };
  $("#e-sub").onchange = e => {
    INW.e.subcategory_id = e.target.value; INW.e.rows = {}; INW.e.extra = [];
    const s = subById(INW.e.subcategory_id); if (s) { INW.e.unit = s.unit; $("#e-unit").value = s.unit; }
    renderSizeGrid();
  };
  $("#e-brand").onchange = e => INW.e.brand_id = e.target.value;
  $("#e-desc").oninput = e => INW.e.description = e.target.value;
  $("#e-markup").oninput = e => { INW.e.markup = e.target.value; refreshMrps(); };
  $("#e-unit").onchange = e => { INW.e.unit = e.target.value; renderSizeGrid(); };
  renderSizeGrid(); renderInwardLines();
};
function entrySizes() {
  const s = subById(INW.e.subcategory_id);
  const base = s && s.sizes ? s.sizes.split(",") : ["FREE"];
  return [...base, ...INW.e.extra];
}
function renderSizeGrid() {
  const el = $("#e-sizes"); if (!el) return;
  if (!INW.e.subcategory_id) { el.innerHTML = `<div class="empty">Select a category and sub-category to enter quantities size-wise.</div>`; return; }
  const unit = INW.e.unit;
  const sizes = entrySizes();
  el.innerHTML = `<div class="row" style="margin-bottom:10px">
      <label class="f narrow">Same cost for all sizes<input id="e-allcost" type="number" step="any" class="num" placeholder="₹"></label>
      <button id="e-apply">Apply cost</button><span class="spacer" style="flex:1"></span>
      <label class="f narrow">Add another size<input id="e-newsize" placeholder="e.g. 115"></label><button id="e-addsize">Add size</button></div>
    <div class="tbl-wrap"><table class="t size-tbl"><thead><tr><th>Size</th><th class="r">Qty (${unit})</th><th class="r">Cost / ${unit === "MTR" ? "metre" : unit === "PACK" ? "pack" : "piece"} ₹</th><th class="r">MRP ₹ (auto, editable)</th><th class="r">Profit / unit</th><th class="r">Cost value</th></tr></thead><tbody>
    ${sizes.map(sz => { const r = INW.e.rows[sz] || {}; return `<tr><td>${esc(sz)}</td>
      <td class="r"><input data-sz="${esc(sz)}" data-f="qty" type="number" step="${unit === "MTR" ? "0.01" : "1"}" min="0" value="${esc(r.qty || "")}"></td>
      <td class="r"><input data-sz="${esc(sz)}" data-f="cost" type="number" step="any" min="0" value="${esc(r.cost || "")}"></td>
      <td class="r"><input data-sz="${esc(sz)}" data-f="mrp" type="number" step="any" min="0" value="${esc(r.mrp || "")}" style="width:100px;${r.manual ? "background:#fff7e0" : ""}"></td>
      <td class="r" data-pr="${esc(sz)}"></td><td class="r" data-val="${esc(sz)}"></td></tr>`; }).join("")}
    </tbody></table></div>
    <div class="btns" style="justify-content:flex-end;margin-top:12px"><span class="muted" style="align-self:center;font-size:12px">MRP = cost + markup %, rounded as set in Settings. Type a different MRP to override.</span>
      <button class="primary" id="e-add">Add to inward list ↓</button></div>`;
  const update = sz => {
    const r = INW.e.rows[sz] || {};
    const pr = $(`[data-pr="${CSS.escape(sz)}"]`, el), vl = $(`[data-val="${CSS.escape(sz)}"]`, el);
    pr.textContent = r.cost && r.mrp ? m2(r.mrp / (1 + gstGuess(r.mrp) / 100) - r.cost) : "";
    vl.textContent = r.qty && r.cost ? m2(r.qty * r.cost) : "";
  };
  $$("[data-sz]", el).forEach(inp => {
    inp.oninput = () => {
      const sz = inp.dataset.sz, f = inp.dataset.f;
      const r = INW.e.rows[sz] = INW.e.rows[sz] || {};
      r[f] = inp.value;
      if (f === "mrp") { r.manual = inp.value !== ""; inp.style.background = r.manual ? "#fff7e0" : ""; }
      if (f === "cost" && !r.manual) { r.mrp = r.cost ? String(calcMrp(r.cost, INW.e.markup)) : ""; $(`[data-sz="${CSS.escape(sz)}"][data-f="mrp"]`, el).value = r.mrp; }
      update(sz);
    };
    inp.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); const all = $$("[data-sz]", el); const i = all.indexOf(inp); (all[i + 3] || $("#e-add")).focus(); } };
  });
  sizes.forEach(update);
  $("#e-apply").onclick = () => {
    const v = $("#e-allcost").value; if (!v) return;
    for (const sz of sizes) { const r = INW.e.rows[sz] = INW.e.rows[sz] || {}; r.cost = v; if (!r.manual) r.mrp = String(calcMrp(v, INW.e.markup)); }
    renderSizeGrid();
  };
  $("#e-addsize").onclick = () => { const v = $("#e-newsize").value.trim(); if (v && !sizes.includes(v)) { INW.e.extra.push(v); renderSizeGrid(); } };
  $("#e-add").onclick = addEntryToInward;
}
function gstGuess(mrp) {
  const s = subById(INW.e.subcategory_id), st = B.settings;
  if (st.gst_mode !== "SLAB") return +st.gst_flat_rate || 0;
  if (!s || s.gst === "SLAB") return +mrp <= +st.gst_threshold ? +st.gst_low : +st.gst_high;
  return +s.gst || 0;
}
function refreshMrps() {
  for (const [sz, r] of Object.entries(INW.e.rows)) if (!r.manual && r.cost) r.mrp = String(calcMrp(r.cost, INW.e.markup));
  renderSizeGrid();
}
function addEntryToInward() {
  const e = INW.e, s = subById(e.subcategory_id);
  if (!s) { toast("Select a sub-category", "err"); return; }
  if (e.markup === "" || isNaN(+e.markup)) { toast("Enter markup %", "err"); return; }
  const add = [];
  for (const sz of entrySizes()) {
    const r = e.rows[sz]; if (!r || !(+r.qty > 0)) continue;
    if (!(+r.cost > 0)) { toast(`Enter cost for size ${sz}`, "err"); return; }
    if (!(+r.mrp > 0)) { toast(`Enter MRP for size ${sz}`, "err"); return; }
    if (+r.mrp < +r.cost) { toast(`MRP is below cost for size ${sz}`, "err"); return; }
    const brand = B.brands.find(b => b.id == e.brand_id);
    add.push({ subcategory_id: s.id, category: s.category, subcategory: s.name, brand_id: e.brand_id || null, brand: brand ? brand.name : "",
      description: e.description.trim(), size: sz, unit: e.unit, qty: +r.qty, cost: +r.cost, markup: r.manual ? +((r.mrp / r.cost - 1) * 100).toFixed(2) : +e.markup, mrp: +r.mrp });
  }
  if (!add.length) { toast("Enter quantity for at least one size", "err"); return; }
  INW.lines.push(...add);
  e.rows = {}; e.description = ""; $("#e-desc").value = "";
  renderSizeGrid(); renderInwardLines();
  toast(`${add.length} line(s) added`, "ok");
  $("#e-desc").focus();
}
function renderInwardLines() {
  const el = $("#i-lines"); if (!el) return;
  const editing = !!INW.edit_id;
  if (!INW.lines.length) {
    el.innerHTML = `<div class="empty">No items added yet.</div>${editing ? `<div class="btns" style="justify-content:flex-end"><button id="i-cancel-edit">Cancel edit</button></div>` : ""}`;
    if (editing) $("#i-cancel-edit").onclick = cancelInwardEdit;
    return;
  }
  el.innerHTML = `<div class="muted" style="font-size:12px;margin-bottom:6px">You can correct qty, cost, MRP, description and size directly in this table. Markup is recalculated from cost and MRP.</div>
    <div class="tbl-wrap"><table class="t"><thead><tr><th>#</th><th>Barcode</th><th>Item</th><th>Description</th><th>Size</th><th class="r">Qty</th><th class="r">Cost</th><th class="r">MRP</th><th class="r">Markup</th><th class="r">Cost value</th><th class="r">MRP value</th><th></th></tr></thead><tbody>
    ${INW.lines.map((l, i) => `<tr><td>${i + 1}</td><td class="mono" style="font-size:12px">${l.barcode ? esc(l.barcode) : '<span class="pill ok">NEW</span>'}</td>
      <td>${esc(l.category)} › ${esc([l.subcategory, l.brand].filter(Boolean).join(" "))}</td>
      <td><input data-li="${i}" data-f="description" value="${esc(l.description)}" style="width:150px;text-align:left"></td>
      <td><input data-li="${i}" data-f="size" value="${esc(l.size)}" style="width:60px;text-align:left"></td>
      <td class="r"><input data-li="${i}" data-f="qty" type="number" step="any" min="0" value="${l.qty}" style="width:70px">${l.moved > 0 ? `<div class="muted" style="font-size:11px">${qf(l.moved)} sold</div>` : ""}</td>
      <td class="r"><input data-li="${i}" data-f="cost" type="number" step="any" min="0" value="${l.cost}" style="width:80px"></td>
      <td class="r"><input data-li="${i}" data-f="mrp" type="number" step="any" min="0" value="${l.mrp}" style="width:80px"></td>
      <td class="r" data-mk="${i}"></td><td class="r" data-cv="${i}"></td><td class="r" data-mv="${i}"></td>
      <td><button class="small danger" data-rm="${i}" title="Remove line">✕</button></td></tr>`).join("")}
    </tbody><tfoot><tr><td colspan="5" id="i-tl"></td><td class="r" id="i-tq"></td><td colspan="3"></td><td class="r" id="i-tc"></td><td class="r" id="i-tm"></td><td></td></tr></tfoot></table></div>
    <div class="btns" style="justify-content:flex-end;margin-top:12px">
      ${editing ? `<button id="i-cancel-edit">Cancel edit</button><button class="primary big" id="i-save">Save changes to ${esc(INW.inward_no)}</button>`
        : `<button class="danger" id="i-clear">Clear all</button><button class="primary big" id="i-save">Save inward &amp; create barcodes</button>`}</div>`;
  const totals = () => {
    INW.lines.forEach((l, i) => {
      $(`[data-mk="${i}"]`, el).textContent = l.cost > 0 ? qf((l.mrp / l.cost - 1) * 100) + "%" : "";
      $(`[data-cv="${i}"]`, el).textContent = m2(l.qty * l.cost);
      $(`[data-mv="${i}"]`, el).textContent = m2(l.qty * l.mrp);
    });
    $("#i-tl", el).textContent = `${INW.lines.length} lines`;
    $("#i-tq", el).textContent = qf(INW.lines.reduce((a, l) => a + l.qty, 0));
    $("#i-tc", el).textContent = money(INW.lines.reduce((a, l) => a + l.qty * l.cost, 0));
    $("#i-tm", el).textContent = money(INW.lines.reduce((a, l) => a + l.qty * l.mrp, 0));
  };
  $$("[data-li]", el).forEach(inp => inp.oninput = () => {
    const l = INW.lines[+inp.dataset.li], f = inp.dataset.f;
    l[f] = ["qty", "cost", "mrp"].includes(f) ? (+inp.value || 0) : inp.value;
    if (f === "cost" || f === "mrp") l.markup = l.cost > 0 ? +((l.mrp / l.cost - 1) * 100).toFixed(2) : 0;
    totals();
  });
  totals();
  $$("[data-rm]", el).forEach(b => b.onclick = async () => {
    const l = INW.lines[+b.dataset.rm];
    if (l.moved > 0) { toast("This item is already sold — reduce its qty instead of removing it", "err"); return; }
    INW.lines.splice(+b.dataset.rm, 1); renderInwardLines();
  });
  const clr = $("#i-clear"); if (clr) clr.onclick = async () => { if (await confirmBox("Clear", "Remove all lines from this inward?")) { INW.lines = []; renderInwardLines(); } };
  const ce = $("#i-cancel-edit"); if (ce) ce.onclick = cancelInwardEdit;
  $("#i-save").onclick = saveInward;
}
async function cancelInwardEdit() {
  if (!await confirmBox("Cancel edit", "Discard your changes to this inward?")) return;
  INW = newInward(); route();
}
async function saveInward() {
  if (!INW.supplier_id) { toast("Select a supplier", "err"); $("#i-sup").focus(); return; }
  for (const l of INW.lines) {
    if (!(l.qty > 0) || !(l.cost > 0) || !(l.mrp > 0)) { toast(`Line ${l.subcategory} ${l.size}: qty, cost and MRP must be more than 0`, "err"); return; }
    if (l.moved > 0 && l.qty < l.moved) { toast(`${l.barcode}: ${qf(l.moved)} already sold — qty cannot be less`, "err"); return; }
  }
  const editing = !!INW.edit_id;
  const res = await guard(() => api(editing ? "update_inward" : "save_inward", editing ? { ...INW, id: INW.edit_id } : INW));
  if (!res) return;
  const total = res.labels.reduce((a, l) => a + l.copies, 0);
  INW = newInward();
  if (editing) { history.replaceState(null, "", "#inwards"); await route(); } else route();
  const m = modal({
    title: `Inward ${res.inward_no} ${editing ? "updated" : "saved"}`,
    body: editing
      ? `<div>Changes saved and stock corrected.${res.labels.length ? ` <b>${res.labels.length}</b> item(s) are new or have a changed MRP/description — <b>${total}</b> label(s) should be (re)printed.` : " No labels need reprinting."}</div>`
      : `<div>Stock updated. <b>${res.labels.length}</b> barcodes created — <b>${total}</b> labels needed.</div>`,
    foot: res.labels.length ? `<button data-q>Add to label queue</button><button class="primary" data-p>Print labels now</button>` : `<button class="primary" data-c>OK</button>`,
  });
  if (res.labels.length) {
    $("[data-q]", m.el).onclick = () => { addLabels(res.labels); m.close(); toast("Added to label queue", "ok"); };
    $("[data-p]", m.el).onclick = () => { addLabels(res.labels); m.close(); location.hash = "#labels"; };
  } else $("[data-c]", m.el).onclick = () => m.close();
}
function editInward(p) {
  INW = newInward();
  Object.assign(INW, {
    edit_id: p.id, inward_no: p.inward_no, date: p.date, supplier_id: String(p.supplier_id), supplier_bill_no: p.supplier_bill_no || "",
    gst_amount: p.gst_amount ? String(p.gst_amount) : "", notes: p.notes || "",
    lines: p.lines.map(l => ({ item_id: l.item_id, barcode: l.barcode, subcategory_id: l.subcategory_id, category: l.category, subcategory: l.subcategory,
      brand_id: l.brand_id, brand: l.brand, description: l.description || "", size: l.size, unit: l.unit, qty: l.qty, cost: l.cost,
      markup: l.markup, mrp: l.mrp, moved: l.moved })),
  });
  location.hash = "#inward";
}
function supplierForm(vals, after) {
  formModal(vals.id ? "Edit supplier" : "Add supplier", [
    { k: "name", label: "Supplier name", req: true }, { k: "phone", label: "Phone" }, { k: "city", label: "City" },
    { k: "gstin", label: "GSTIN" }, { k: "address", label: "Address", type: "textarea" }], vals,
    async v => { const r = await api("save_supplier", v); await loadB(); after && await after(r.id); toast("Supplier saved", "ok"); return r; });
}

// ================================================================ INWARD HISTORY
const IF = { from: shiftDate(todayStr(), -90), to: todayStr(), supplier_id: "" };
PAGES.inwards = async main => {
  main.innerHTML = `<div class="page-head"><h1>Inward History</h1><span class="spacer"></span><button class="primary" onclick="location.hash='#inward'">+ New inward</button></div>
  <div class="card"><div class="row">
    <label class="f narrow">From<input type="date" id="if-from" value="${IF.from}"></label><label class="f narrow">To<input type="date" id="if-to" value="${IF.to}"></label>
    <label class="f wide">Supplier<select id="if-sup">${supOpts(IF.supplier_id, "All suppliers")}</select></label><button class="primary" id="if-go">Show</button></div></div>
  <div class="card"><div id="if-res" class="tbl-wrap tall"></div></div>`;
  const go = async () => {
    IF.from = $("#if-from").value; IF.to = $("#if-to").value; IF.supplier_id = $("#if-sup").value;
    const res = await guard(() => api("list_inwards", IF)); if (!res) return;
    $("#if-res").innerHTML = res.length ? `<table class="t"><thead><tr><th>Date</th><th>Inward No</th><th>Supplier</th><th>Supplier Bill</th><th class="r">Lines</th><th class="r">Qty</th><th class="r">Cost value</th><th class="r">GST</th></tr></thead><tbody>
      ${res.map(r => `<tr><td>${dmy(r.date)}</td><td><button class="link" data-in="${r.id}">${esc(r.inward_no)}</button> <button class="small" data-ined="${r.id}">✎ Edit</button></td><td>${esc(r.supplier)}</td><td>${esc(r.supplier_bill_no)}</td><td class="r">${r.lines}</td><td class="r">${qf(r.total_qty)}</td><td class="r">${money(r.total_cost)}</td><td class="r">${money(r.gst_amount)}</td></tr>`).join("")}
      </tbody><tfoot><tr><td colspan="5">${res.length} inwards</td><td class="r">${qf(res.reduce((a, r) => a + r.total_qty, 0))}</td><td class="r">${money(res.reduce((a, r) => a + r.total_cost, 0))}</td><td class="r">${money(res.reduce((a, r) => a + r.gst_amount, 0))}</td></tr></tfoot></table>`
      : `<div class="empty">No inward entries found.</div>`;
    $$("[data-in]", main).forEach(b => b.onclick = () => viewInward(+b.dataset.in, go));
    $$("[data-ined]", main).forEach(b => b.onclick = async () => { const p = await guard(() => api("get_inward", { id: +b.dataset.ined })); if (p) editInward(p); });
  };
  $("#if-go").onclick = go; go();
};
async function viewInward(id, after) {
  const p = await guard(() => api("get_inward", { id })); if (!p) return;
  const m = modal({
    title: `Inward ${p.inward_no} — ${p.supplier}`, wide: true,
    body: `<div>Date ${dmy(p.date)} · Supplier bill ${esc(p.supplier_bill_no || "—")} · ${esc(p.notes || "")}</div>
      <div class="tbl-wrap" style="max-height:420px"><table class="t"><thead><tr><th>Barcode</th><th>Item</th><th>Size</th><th class="r">Qty</th><th class="r">Cost</th><th class="r">Markup</th><th class="r">MRP</th><th class="r">In stock</th></tr></thead><tbody>
      ${p.lines.map(l => `<tr><td class="mono">${esc(l.barcode)}</td><td>${esc(l.name)}</td><td>${esc(l.size)}</td><td class="r">${qf(l.qty)}</td><td class="r">${m2(l.cost)}</td><td class="r">${qf(l.markup)}%</td><td class="r">${m2(l.mrp)}</td><td class="r">${qf(l.stock)}</td></tr>`).join("")}
      </tbody><tfoot><tr><td colspan="3"></td><td class="r">${qf(p.total_qty)}</td><td colspan="4">Cost value ${money(p.total_cost)}</td></tr></tfoot></table></div>`,
    foot: `${isOwner() ? `<button class="danger" data-del>Delete inward</button>` : ""}<button data-edit>✎ Edit inward</button><button data-lab>Labels (current stock)</button><button class="primary" data-laball>Labels (full qty)</button>`,
  });
  $("[data-edit]", m.el).onclick = () => { m.close(); editInward(p); };
  const go = list => { addLabels(list); m.close(); location.hash = "#labels"; };
  $("[data-laball]", m.el).onclick = () => go(p.lines.map(l => ({ item_id: l.item_id, copies: l.unit === "MTR" ? 1 : Math.ceil(l.qty) })));
  $("[data-lab]", m.el).onclick = () => go(p.lines.filter(l => l.stock > 0).map(l => ({ item_id: l.item_id, copies: l.unit === "MTR" ? 1 : Math.ceil(l.stock) })));
  const delBtn = $("[data-del]", m.el); if (delBtn) delBtn.onclick = async () => {
    if (!await confirmBox("Delete inward", `Delete inward <b>${esc(p.inward_no)}</b> and remove its items from stock? Only possible if nothing from it has been sold.`, "Delete")) return;
    if (await guard(() => api("delete_inward", { id }))) { toast("Inward deleted", "ok"); m.close(); after && after(); }
  };
}

// ================================================================ STOCK / ITEMS
const SF = { q: "", category_id: "", subcategory_id: "", supplier_id: "", in_stock: true };
PAGES.stock = async main => {
  main.innerHTML = `<div class="page-head"><h1>Stock / Items</h1><span class="sub">Every barcode with its current stock.</span></div>
  <div class="card"><div class="row">
    <label class="f wide">Search (barcode, description, brand, size)<input id="sf-q" value="${esc(SF.q)}"></label>
    <label class="f">Category<select id="sf-cat">${catOpts(SF.category_id, "All")}</select></label>
    <label class="f">Sub-category<select id="sf-sub">${subOpts(SF.category_id, SF.subcategory_id, "All")}</select></label>
    <label class="f">Supplier<select id="sf-sup">${supOpts(SF.supplier_id, "All")}</select></label>
    <label class="chk"><input type="checkbox" id="sf-in" ${SF.in_stock ? "checked" : ""}> In stock only</label>
    <button class="primary" id="sf-go">Show</button></div></div>
  <div class="card"><div id="sf-res"></div></div>`;
  $("#sf-cat").onchange = e => { $("#sf-sub").innerHTML = subOpts(e.target.value, "", "All"); };
  let res = [];
  const go = async () => {
    Object.assign(SF, { q: $("#sf-q").value, category_id: $("#sf-cat").value, subcategory_id: $("#sf-sub").value, supplier_id: $("#sf-sup").value, in_stock: $("#sf-in").checked });
    res = await guard(() => api("search_items", { ...SF, in_stock: SF.in_stock ? 1 : 0 })); if (!res) return;
    const tq = res.reduce((a, r) => a + Math.max(0, r.stock), 0), tv = res.reduce((a, r) => a + Math.max(0, r.stock) * r.cost, 0), tm = res.reduce((a, r) => a + Math.max(0, r.stock) * r.mrp, 0);
    const own = isOwner();
    $("#sf-res").innerHTML = res.length ? `<div class="btns" style="margin-bottom:10px"><span class="muted" style="align-self:center">${res.length} items · ${qf(tq)} in stock${own ? ` · ${money(tv)} at cost` : ""} · ${money(tm)} at MRP</span><span style="flex:1"></span><button id="sf-lab">Add all shown to labels</button></div>
      <div class="tbl-wrap tall"><table class="t"><thead><tr><th>Barcode</th><th>Category</th><th>Item</th><th>Size</th><th>Supplier</th><th>Inward</th>${own ? '<th class="r">Cost</th>' : ""}<th class="r">MRP</th><th class="r">Stock</th>${own ? '<th class="r">Value</th>' : ""}<th></th></tr></thead><tbody>
      ${res.map((r, i) => `<tr><td class="mono">${esc(r.barcode)}</td><td>${esc(r.category)}</td><td>${esc(r.name)}</td><td>${esc(r.size)}</td><td>${esc(r.supplier || "")}</td><td>${dmy((r.created_at || "").slice(0, 10))}</td>
        ${own ? `<td class="r">${m2(r.cost)}</td>` : ""}<td class="r">${m2(r.mrp)}</td><td class="r"><b style="color:${r.stock <= 0 ? "var(--bad)" : ""}">${qf(r.stock)}</b> ${r.unit === "PCS" ? "" : r.unit}</td>${own ? `<td class="r">${m2(Math.max(0, r.stock) * r.cost)}</td>` : ""}
        <td style="white-space:nowrap"><button class="small" data-l="${i}">Label</button>${own ? ` <button class="small" data-e="${i}">Edit</button> <button class="small" data-a="${i}">Adjust</button>` : ""}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">No items found.</div>`;
    const lab = $("#sf-lab");
    if (lab) lab.onclick = () => { addLabels(res.filter(r => r.stock > 0).map(r => ({ item_id: r.id, copies: r.unit === "MTR" ? 1 : Math.ceil(r.stock) }))); toast("Added to label queue", "ok"); };
    $$("[data-l]", main).forEach(b => b.onclick = () => { const r = res[+b.dataset.l];
      formModal(`Labels for ${r.barcode}`, [{ k: "copies", label: "Number of labels", type: "number", req: true }], { copies: Math.max(1, Math.ceil(r.stock)) },
        async v => { addLabels([{ item_id: r.id, copies: Math.max(1, Math.round(+v.copies)) }]); toast("Added to label queue", "ok"); return true; }); });
    $$("[data-e]", main).forEach(b => b.onclick = () => { const r = res[+b.dataset.e];
      formModal(`Edit ${r.barcode}`, [{ k: "description", label: "Description" }, { k: "brand_id", label: "Brand", type: "select", options: [["", "— No brand —"], ...B.brands.map(x => [x.id, x.name])] },
        { k: "mrp", label: "MRP ₹", type: "number", req: true, hint: `Cost ₹${m2(r.cost)}. Changing MRP means old labels show the old price; reprint labels after changing.` }],
        { description: r.description, brand_id: r.brand_id || "", mrp: r.mrp }, async v => { const x = await api("update_item", { id: r.id, ...v }); toast("Item updated", "ok"); go(); return x; }); });
    $$("[data-a]", main).forEach(b => b.onclick = () => { const r = res[+b.dataset.a];
      formModal(`Adjust stock — ${r.barcode} (now ${qf(r.stock)})`, [{ k: "qty", label: "Quantity change (+ to add, − to reduce)", type: "number", req: true },
        { k: "reason", label: "Reason", req: true, ph: "Damaged / Physical count correction / Gift…" }], {},
        async v => { const x = await api("adjust_stock", { item_id: r.id, ...v }); toast("Stock adjusted", "ok"); go(); return x; }); });
  };
  $("#sf-go").onclick = go;
  $("#sf-q").onkeydown = e => { if (e.key === "Enter") go(); };
  go();
};

// ================================================================ LABELS
PAGES.labels = async main => {
  const s = B.settings;
  main.innerHTML = `<div class="page-head"><h1>Barcode Labels</h1><span class="sub">Label size ${s.label_w} × ${s.label_h} mm · ${s.label_cols} across · <a href="#settings">change in Settings</a></span></div>
  <div class="card"><div class="row"><label class="f wide">Add by barcode (scan)<input id="lb-scan" class="mono"></label><label class="f narrow">Copies<input id="lb-copies" type="number" value="1" min="1"></label><button id="lb-add">Add</button>
    <span style="flex:1"></span><button class="danger" id="lb-clear">Clear queue</button><button class="primary big" id="lb-print">🖨 Print labels</button></div></div>
  <div class="grid g2"><div class="card"><h2>Print queue</h2><div id="lb-list"></div></div><div class="card"><h2>Preview (actual size)</h2><div id="lb-prev" class="label-preview"></div>
  <div class="muted" style="font-size:12px;margin-top:10px">Printing tip: in the print dialog choose your thermal label printer, set margins to <b>None</b>, scale <b>100%</b>, and turn off headers/footers. Set the printer's paper size to the same label size in its driver settings.</div></div></div>`;
  const render = async () => {
    saveLQ();
    const items = LQ.length ? await guard(() => api("items_by_ids", { ids: LQ.map(q => q.item_id) })) || [] : [];
    const byId = Object.fromEntries(items.map(i => [i.id, i]));
    LQ = LQ.filter(q => byId[q.item_id]); saveLQ();
    const total = LQ.reduce((a, q) => a + (+q.copies || 0), 0);
    $("#lb-list").innerHTML = LQ.length ? `<div class="tbl-wrap" style="max-height:480px"><table class="t"><thead><tr><th>Barcode</th><th>Item</th><th>Size</th><th class="r">MRP</th><th class="r">Copies</th><th></th></tr></thead><tbody>
      ${LQ.map((q, i) => { const it = byId[q.item_id]; return `<tr><td class="mono">${esc(it.barcode)}</td><td>${esc(it.name)}</td><td>${esc(it.size)}</td><td class="r">${m2(it.mrp)}</td><td class="r"><input type="number" min="0" data-c="${i}" value="${q.copies}" style="width:70px"></td><td><button class="small danger" data-r="${i}">✕</button></td></tr>`; }).join("")}
      </tbody><tfoot><tr><td colspan="4">Total labels</td><td class="r">${total}</td><td></td></tr></tfoot></table></div>` : `<div class="empty">Queue is empty. Labels are added here after a stock inward, or from Stock / Items.</div>`;
    $("#lb-prev").innerHTML = LQ.slice(0, 6).map(q => `<div class="lbl-box">${labelHTML(byId[q.item_id])}</div>`).join("") || `<div class="muted">—</div>`;
    $$("[data-c]", main).forEach(inp => inp.onchange = () => { LQ[+inp.dataset.c].copies = Math.max(0, Math.round(+inp.value || 0)); render(); });
    $$("[data-r]", main).forEach(b => b.onclick = () => { LQ.splice(+b.dataset.r, 1); render(); });
  };
  const add = async () => {
    const code = $("#lb-scan").value.trim(); if (!code) return;
    const it = await guard(() => api("find_item", { barcode: code })); if (!it) return;
    addLabels([{ item_id: it.id, copies: Math.max(1, +$("#lb-copies").value || 1) }]);
    $("#lb-scan").value = ""; $("#lb-scan").focus(); render();
  };
  $("#lb-add").onclick = add;
  $("#lb-scan").onkeydown = e => { if (e.key === "Enter") add(); };
  $("#lb-clear").onclick = async () => { if (LQ.length && await confirmBox("Clear queue", "Remove all labels from the queue?")) { LQ = []; render(); } };
  $("#lb-print").onclick = async () => {
    if (!LQ.length) { toast("Queue is empty", "err"); return; }
    const m = await printLabels(LQ);
    if (!m) return;
    const go = $("[data-pgo]", m.el);
    go.insertAdjacentHTML("beforebegin", `<button data-pclear>Print &amp; clear queue</button>`);
    $("[data-pclear]", m.el).onclick = () => { go.click(); LQ = []; m.close(); render(); };
  };
  render();
};

// ================================================================ REPORTS
const REPORTS = [
  ["Sales", [
    ["sales_register", "Sales register (bill-wise)", "d"], ["sales_items", "Item-wise sales", "dfs"], ["sales_by_category", "Category / sub-category sales", "dfs"],
    ["sales_by_size", "Size-wise sales", "dfs"], ["sales_by_supplier", "Supplier-wise sales & profit", "dfs"], ["sales_by_day", "Day-wise sales & collection", "d"],
    ["sales_by_month", "Month-wise sales & profit", "d"], ["gst_summary", "GST summary (HSN / rate)", "d"], ["returns", "Sales returns", "d"]]],
  ["Customers", [
    ["customer_list", "Customer data (all customers)", ""], ["customer_sales", "Customer-wise sales (period)", "d"], ["city_sales", "City-wise sales", "d"]]],
  ["Expenses & Cash", [
    ["profit_loss", "Profit & Loss (net profit after expenses)", "d"], ["expense_register", "Expense register", "d"],
    ["expense_by_head", "Expenses by head", "d"], ["cash_book", "Cash book (day-wise cash in hand)", "d"], ["cash_entries", "Cash in / out entries", "d"]]],
  ["Purchase", [
    ["purchase_register", "Purchase / inward register", "ds"], ["purchase_items", "Item-wise purchases", "dfs"],
    ["purchase_by_supplier", "Supplier-wise purchases", "dfs"], ["purchase_by_category", "Category-wise purchases", "dfs"]]],
  ["Stock", [
    ["stock", "Stock report (item-wise)", "fsz"], ["stock_summary", "Stock summary (size-wise)", "fs"], ["low_stock", "Low stock / MOQ alert", "fs"],
    ["stock_adjustments", "Stock adjustments", "dfs"]]],
];
const NO_TOTAL = new Set(["mrp", "disc_pct", "gst_rate", "margin", "avg_markup", "markup", "moq"]);
const REP = { name: "sales_register", from: todayStr().slice(0, 8) + "01", to: todayStr(), category_id: "", subcategory_id: "", supplier_id: "", include_zero: false, data: null };
const repMeta = n => { for (const [, list] of REPORTS) for (const r of list) if (r[0] === n) return r; return REPORTS[0][1][0]; };
function fyStart() { const t = todayStr(), y = +t.slice(0, 4), m = +t.slice(5, 7); return `${m >= 4 ? y : y - 1}-04-01`; }

PAGES.reports = async main => {
  const q = location.hash.split("?")[1]; if (q) REP.name = q;
  main.innerHTML = `<div class="page-head"><h1>Reports</h1></div>
  <div class="rep-layout"><div class="card rep-list">${REPORTS.map(([g, list]) => `<div class="grp">${g}</div>${list.map(r => `<button data-rep="${r[0]}" class="${r[0] === REP.name ? "on" : ""}">${esc(r[1])}</button>`).join("")}`).join("")}</div>
  <div><div class="card" id="rep-filters"></div><div class="card" id="rep-out"><div class="empty">Choose filters and click Run.</div></div></div></div>`;
  $$("[data-rep]", main).forEach(b => b.onclick = () => { REP.name = b.dataset.rep; REP.data = null; $$("[data-rep]", main).forEach(x => x.classList.toggle("on", x === b)); renderFilters(); runReport(); });
  renderFilters(); runReport();
};
function renderFilters() {
  const [, label, flags] = repMeta(REP.name);
  const el = $("#rep-filters");
  el.innerHTML = `<h2>${esc(label)}</h2><div class="row">
    ${flags.includes("d") ? `<label class="f narrow">From<input type="date" id="rf-from" value="${REP.from}"></label><label class="f narrow">To<input type="date" id="rf-to" value="${REP.to}"></label>
      <div class="btns"><button class="small" data-pr="today">Today</button><button class="small" data-pr="month">This month</button><button class="small" data-pr="last">Last month</button><button class="small" data-pr="fy">This FY</button></div>` : ""}
    ${flags.includes("f") ? `<label class="f">Category<select id="rf-cat">${catOpts(REP.category_id, "All")}</select></label><label class="f">Sub-category<select id="rf-sub">${subOpts(REP.category_id, REP.subcategory_id, "All")}</select></label>` : ""}
    ${flags.includes("s") ? `<label class="f">Supplier<select id="rf-sup">${supOpts(REP.supplier_id, "All")}</select></label>` : ""}
    ${flags.includes("z") ? `<label class="chk"><input type="checkbox" id="rf-zero" ${REP.include_zero ? "checked" : ""}> Include zero stock</label>` : ""}
    <button class="primary" id="rf-run">Run</button><button id="rf-csv">Export to Excel (CSV)</button><button id="rf-print">Print</button></div>`;
  const cat = $("#rf-cat", el); if (cat) cat.onchange = () => { $("#rf-sub", el).innerHTML = subOpts(cat.value, "", "All"); };
  $$("[data-pr]", el).forEach(b => b.onclick = () => {
    const t = todayStr(), p = b.dataset.pr;
    if (p === "today") { REP.from = REP.to = t; }
    if (p === "month") { REP.from = t.slice(0, 8) + "01"; REP.to = t; }
    if (p === "last") { const d = shiftDate(t.slice(0, 8) + "01", -1); REP.from = d.slice(0, 8) + "01"; REP.to = d; }
    if (p === "fy") { REP.from = fyStart(); REP.to = t; }
    $("#rf-from").value = REP.from; $("#rf-to").value = REP.to; runReport();
  });
  $("#rf-run", el).onclick = runReport;
  $("#rf-csv", el).onclick = exportCSV;
  $("#rf-print", el).onclick = printReport;
}
function readFilters() {
  const v = id => { const e = $(id); return e ? e.value : ""; };
  if ($("#rf-from")) { REP.from = v("#rf-from"); REP.to = v("#rf-to"); }
  REP.category_id = v("#rf-cat"); REP.subcategory_id = v("#rf-sub"); REP.supplier_id = v("#rf-sup");
  REP.include_zero = !!($("#rf-zero") && $("#rf-zero").checked);
}
function fmtCell(c, v) {
  if (v == null || v === "") return "";
  if (c.type === "money") return m2(v);
  if (c.type === "num") return qf(v);
  if (c.type === "date") return dmy(String(v));
  return esc(v);
}
const totalable = c => (c.type === "money" || c.type === "num") && !NO_TOTAL.has(c.key) && !(["stock", "purchase_items"].includes(REP.name) && c.key === "cost");
async function runReport() {
  readFilters();
  const [, , flags] = repMeta(REP.name);
  const args = { name: REP.name, include_zero: REP.include_zero ? 1 : 0 };
  if (flags.includes("d")) Object.assign(args, { from: REP.from, to: REP.to });
  if (flags.includes("f")) Object.assign(args, { category_id: REP.category_id, subcategory_id: REP.subcategory_id });
  if (flags.includes("s")) args.supplier_id = REP.supplier_id;
  const d = await guard(() => api("report", args)); if (!d) return;
  REP.data = d;
  const el = $("#rep-out");
  if (!d.rows.length) { el.innerHTML = `<div class="empty">No data for the selected filters.</div>`; return; }
  const tot = {}; d.columns.forEach(c => { if (totalable(c)) tot[c.key] = d.rows.reduce((a, r) => a + (+r[c.key] || 0), 0); });
  el.innerHTML = `<div class="muted" style="margin-bottom:8px">${d.rows.length} rows</div><div class="tbl-wrap tall"><table class="t"><thead><tr>${d.columns.map(c => `<th class="${c.type === "money" || c.type === "num" ? "r" : ""}">${esc(c.label)}</th>`).join("")}</tr></thead><tbody>
    ${d.rows.map(r => `<tr class="${r.status === "CANCELLED" ? "cancelled" : ""}">${d.columns.map(c => `<td class="${c.type === "money" || c.type === "num" ? "r" : ""}">${c.key === "status" && r.status !== "ACTIVE" && r.status !== "OK" ? `<span class="pill ${r.status === "LOW" ? "warn" : "bad"}">${esc(r.status)}</span>` : fmtCell(c, r[c.key])}</td>`).join("")}</tr>`).join("")}
    </tbody><tfoot><tr>${d.columns.map((c, i) => `<td class="r">${c.key in tot ? fmtCell(c, tot[c.key]) : i === 0 ? "TOTAL" : ""}</td>`).join("")}</tr></tfoot></table></div>`;
}
function exportCSV() {
  const d = REP.data; if (!d || !d.rows.length) { toast("Run the report first", "err"); return; }
  const q = v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [d.columns.map(c => q(c.label)).join(",")];
  for (const r of d.rows) lines.push(d.columns.map(c => q(c.type === "date" ? dmy(String(r[c.key] || "")) : r[c.key])).join(","));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `SuperSoft_${REP.name}_${REP.from || ""}_${REP.to || todayStr()}.csv`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function printReport() {
  const d = REP.data; if (!d || !d.rows.length) { toast("Run the report first", "err"); return; }
  const [, label, flags] = repMeta(REP.name);
  const tot = {}; d.columns.forEach(c => { if (totalable(c)) tot[c.key] = d.rows.reduce((a, r) => a + (+r[c.key] || 0), 0); });
  const html = `<div class="inv a4"><h1>${esc(B.settings.shop_name)}</h1><div class="title">${esc(label.toUpperCase())}</div>
    <div class="c">${flags.includes("d") ? `Period: ${dmy(REP.from)} to ${dmy(REP.to)}` : `As on ${dmy(todayStr())}`}</div><br>
    <table><thead><tr>${d.columns.map(c => `<th>${esc(c.label)}</th>`).join("")}</tr></thead><tbody>
    ${d.rows.map(r => `<tr>${d.columns.map(c => `<td class="${c.type === "money" || c.type === "num" ? "r" : ""}">${fmtCell(c, r[c.key])}</td>`).join("")}</tr>`).join("")}
    <tr>${d.columns.map((c, i) => `<td class="r"><b>${c.key in tot ? fmtCell(c, tot[c.key]) : i === 0 ? "TOTAL" : ""}</b></td>`).join("")}</tr></tbody></table>
    <div style="margin-top:8px;font-size:9px">Printed ${new Date().toLocaleString("en-IN")} · SuperSoft</div></div>`;
  printHTML(html, `@page { size: A4 ${d.columns.length > 8 ? "landscape" : "portrait"}; margin: 8mm; } .inv.a4 th, .inv.a4 td { font-size: 9px; padding: 2px 3px; }`,
    { title: `Print preview — ${label}`, kind: "report" });
}

// ================================================================ MASTERS
let MT = { tab: "cat", cat: null };
PAGES.masters = async main => {
  await loadB();
  if (!MT.cat && B.categories.length) MT.cat = B.categories[0].id;
  const tabs = [["cat", "Categories & Sub-categories"], ["sizes", "Size sets"], ["brands", "Brands"], ["sup", "Suppliers"]];
  main.innerHTML = `<div class="page-head"><h1>Masters</h1><span class="sub">Add or change categories, sub-categories, sizes, brands and suppliers at any time.</span></div>
    <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${MT.tab === k ? "on" : ""}">${l}</button>`).join("")}</div><div id="mt-body"></div>`;
  $$("[data-tab]", main).forEach(b => b.onclick = () => { MT.tab = b.dataset.tab; route(); });
  const body = $("#mt-body");
  const reload = async () => { await loadB(); route(); };
  const del = async (fn, id, what) => { if (await confirmBox("Delete", `Delete ${esc(what)}?`, "Delete")) { if (await guard(() => api(fn, { id }))) { toast("Deleted", "ok"); reload(); } } };

  if (MT.tab === "cat") {
    const cat = B.categories.find(c => c.id == MT.cat);
    const subs = cat ? subsOf(cat.id) : [];
    const ssOpts = [["", "— None —"], ...B.size_sets.map(s => [s.id, `${s.name} (${s.sizes})`])];
    body.innerHTML = `<div class="grid" style="grid-template-columns:280px minmax(0,1fr)">
      <div class="card"><h2>Categories<span class="spacer"></span><button class="small primary" id="c-add">+ Add</button></h2>
        <div class="rep-list">${B.categories.map(c => `<button data-c="${c.id}" class="${c.id == MT.cat ? "on" : ""}">${esc(c.name)} <span class="muted" style="margin-left:auto">${subsOf(c.id).length}</span></button>`).join("") || `<div class="empty">No categories.</div>`}</div>
        ${cat ? `<div class="btns" style="margin-top:12px"><button class="small" id="c-edit">Rename</button><button class="small danger" id="c-del">Delete</button></div>` : ""}</div>
      <div class="card"><h2>Sub-categories of ${esc(cat ? cat.name : "—")}<span class="spacer"></span>${cat ? `<button class="small primary" id="s-add">+ Add sub-category</button>` : ""}</h2>
        ${subs.length ? `<div class="tbl-wrap"><table class="t"><thead><tr><th>Sub-category</th><th>HSN</th><th>GST</th><th>Unit</th><th>Size set</th><th class="r">MOQ</th><th class="r">Items</th><th></th></tr></thead><tbody>
        ${subs.map(s => `<tr><td><b>${esc(s.name)}</b></td><td>${esc(s.hsn)}</td><td>${s.gst === "SLAB" ? "Slab" : esc(s.gst) + "%"}</td><td>${esc(s.unit)}</td><td>${esc(s.size_set || "—")}<div class="muted" style="font-size:11px">${esc(s.sizes || "")}</div></td>
          <td class="r">${s.moq == null ? `<span class="muted">${esc(B.settings.default_moq)} (default)</span>` : qf(s.moq)}</td><td class="r">${s.item_count}</td>
          <td style="white-space:nowrap"><button class="small" data-se="${s.id}">Edit</button> <button class="small danger" data-sd="${s.id}">Delete</button></td></tr>`).join("")}</tbody></table></div>`
        : `<div class="empty">No sub-categories yet.</div>`}
        <div class="muted" style="font-size:12px;margin-top:10px">MOQ = minimum stock per size; the dashboard alerts when stock falls below it. Leave blank to use the default MOQ from Settings.</div></div></div>`;
    $$("[data-c]", body).forEach(b => b.onclick = () => { MT.cat = +b.dataset.c; route(); });
    $("#c-add", body).onclick = () => formModal("Add category", [{ k: "name", label: "Category name", req: true, ph: "e.g. Sarees, Kids Wear, Fabric" }], {}, async v => { const r = await api("save_category", v); MT.cat = r.id; reload(); return r; });
    if (cat) {
      $("#c-edit", body).onclick = () => formModal("Rename category", [{ k: "name", label: "Category name", req: true }], cat, async v => { const r = await api("save_category", v); reload(); return r; });
      $("#c-del", body).onclick = () => del("delete_category", cat.id, `category "${cat.name}"`).then(() => { MT.cat = null; });
      const subForm = s => formModal(s.id ? "Edit sub-category" : `Add sub-category to ${cat.name}`, [
        { k: "name", label: "Sub-category name", req: true }, { k: "hsn", label: "HSN code", ph: "e.g. 6109" },
        { k: "gst", label: "GST rate", type: "select", options: GST_OPTS, def: "SLAB" },
        { k: "unit", label: "Selling unit", type: "select", options: UNIT_OPTS, def: "PCS" },
        { k: "size_set_id", label: "Size set", type: "select", options: ssOpts },
        { k: "moq", label: "MOQ (minimum stock per size)", type: "number", ph: `Blank = default (${B.settings.default_moq})` }],
        { ...s, moq: s.moq ?? "" }, async v => { const r = await api("save_subcategory", { ...v, category_id: cat.id }); reload(); return r; });
      $("#s-add", body).onclick = () => subForm({});
      $$("[data-se]", body).forEach(b => b.onclick = () => subForm(subById(b.dataset.se)));
      $$("[data-sd]", body).forEach(b => b.onclick = () => del("delete_subcategory", +b.dataset.sd, `sub-category "${subById(b.dataset.sd).name}"`));
    }
  }
  if (MT.tab === "sizes") {
    body.innerHTML = `<div class="card"><h2>Size sets<span class="spacer"></span><button class="small primary" id="z-add">+ Add size set</button></h2>
      <table class="t"><thead><tr><th>Name</th><th>Sizes</th><th></th></tr></thead><tbody>${B.size_sets.map(s => `<tr><td><b>${esc(s.name)}</b></td><td>${esc(s.sizes.split(",").join(" · "))}</td>
      <td style="white-space:nowrap"><button class="small" data-ze="${s.id}">Edit</button> <button class="small danger" data-zd="${s.id}">Delete</button></td></tr>`).join("")}</tbody></table>
      <div class="muted" style="font-size:12px;margin-top:10px">A size set is the list of sizes shown in Stock Inward for a sub-category. Use "FREE" for items without sizes.</div></div>`;
    const f = s => formModal(s.id ? "Edit size set" : "Add size set", [{ k: "name", label: "Name", req: true, ph: "e.g. Jeans waist" }, { k: "sizes", label: "Sizes (comma separated)", req: true, ph: "28,30,32,34,36" }], s,
      async v => { const r = await api("save_size_set", v); reload(); return r; });
    $("#z-add", body).onclick = () => f({});
    $$("[data-ze]", body).forEach(b => b.onclick = () => f(B.size_sets.find(s => s.id == b.dataset.ze)));
    $$("[data-zd]", body).forEach(b => b.onclick = () => del("delete_size_set", +b.dataset.zd, "this size set"));
  }
  if (MT.tab === "brands") {
    body.innerHTML = `<div class="card"><h2>Brands<span class="spacer"></span><button class="small primary" id="b-add">+ Add brand</button></h2>
      ${B.brands.length ? `<table class="t"><tbody>${B.brands.map(s => `<tr><td><b>${esc(s.name)}</b></td><td style="text-align:right"><button class="small" data-be="${s.id}">Rename</button> <button class="small danger" data-bd="${s.id}">Delete</button></td></tr>`).join("")}</tbody></table>`
        : `<div class="empty">No brands yet. Brand is optional on stock inward.</div>`}</div>`;
    const f = s => formModal(s.id ? "Rename brand" : "Add brand", [{ k: "name", label: "Brand name", req: true, ph: "e.g. Jockey, Rupa, Lux" }], s, async v => { const r = await api("save_brand", v); reload(); return r; });
    $("#b-add", body).onclick = () => f({});
    $$("[data-be]", body).forEach(b => b.onclick = () => f(B.brands.find(s => s.id == b.dataset.be)));
    $$("[data-bd]", body).forEach(b => b.onclick = () => del("delete_brand", +b.dataset.bd, "this brand"));
  }
  if (MT.tab === "sup") {
    body.innerHTML = `<div class="card"><h2>Suppliers<span class="spacer"></span><button class="small primary" id="p-add">+ Add supplier</button></h2>
      ${B.suppliers.length ? `<div class="tbl-wrap"><table class="t"><thead><tr><th>Name</th><th>Phone</th><th>City</th><th>GSTIN</th><th>Address</th><th></th></tr></thead><tbody>${B.suppliers.map(s => `<tr><td><b>${esc(s.name)}</b></td><td>${esc(s.phone)}</td><td>${esc(s.city)}</td><td>${esc(s.gstin)}</td><td>${esc(s.address)}</td>
      <td style="white-space:nowrap"><button class="small" data-pe="${s.id}">Edit</button> <button class="small danger" data-pd="${s.id}">Delete</button></td></tr>`).join("")}</tbody></table></div>`
        : `<div class="empty">No suppliers yet.</div>`}</div>`;
    $("#p-add", body).onclick = () => supplierForm({}, reload);
    $$("[data-pe]", body).forEach(b => b.onclick = () => supplierForm(B.suppliers.find(s => s.id == b.dataset.pe), reload));
    $$("[data-pd]", body).forEach(b => b.onclick = () => del("delete_supplier", +b.dataset.pd, "this supplier"));
  }
};

// ================================================================ SETTINGS
PAGES.settings = async main => {
  await loadB();
  const s = B.settings;
  const F = (k, label, type = "text", extra = "") => `<label class="f">${label}<input name="${k}" type="${type}" ${type === "number" ? 'step="any"' : ""} value="${esc(s[k])}" ${extra}></label>`;
  const S = (k, label, options) => `<label class="f">${label}<select name="${k}">${options.map(([v, l]) => opt(v, l, s[k])).join("")}</select></label>`;
  main.innerHTML = `<div class="page-head"><h1>Settings</h1><span class="spacer"></span><button class="primary" id="st-save">Save settings</button></div>
  <form id="st-form">
  <div class="card"><h2>Shop details (printed on invoice)</h2><div class="row">${F("shop_name", "Shop name")}${F("shop_phone", "Phone")}${F("shop_gstin", "GSTIN")}${F("shop_state", "State")}</div>
    <div class="row" style="margin-top:12px"><label class="f wide">Address<input name="shop_address" value="${esc(s.shop_address)}"></label></div>
    <div class="row" style="margin-top:12px"><label class="f wide">Invoice footer / terms<input name="invoice_footer" value="${esc(s.invoice_footer)}"></label>${S("invoice_format", "Invoice print size", [["A4", "A4 page"], ["80mm", "80 mm thermal receipt"]])}</div></div>
  <div class="card"><h2>GST</h2><div class="row">
    ${S("gst_mode", "GST method", [["FLAT", "Same GST % on every bill"], ["SLAB", "By sub-category / price slab"]])}
    ${F("gst_flat_rate", "GST % for every bill", "number")}</div>
    <div class="muted" style="font-size:12px;margin-top:8px">GST is charged on every bill and shown as CGST + SGST. MRP is GST-inclusive (as required for MRP-labelled goods), so the GST is part of the MRP.
      Choose "By sub-category / price slab" later to use the rates below and each sub-category's GST setting.</div>
    <div class="row" style="margin-top:12px">${F("gst_threshold", "Slab: price limit per piece ₹", "number")}${F("gst_low", "Slab: GST % up to the limit", "number")}${F("gst_high", "Slab: GST % above the limit", "number")}</div></div>
  <div class="card"><h2>Payment</h2><div class="row">${S("balance_mode", "Default mode for balance after cash", [["UPI", "UPI"], ["CARD", "Card"], ["CHEQUE", "Cheque"]])}</div>
    <div class="muted" style="font-size:12px;margin-top:8px">At billing you enter only the cash received; the remaining amount is automatically taken by this mode (it can be changed on each bill).</div></div>
  <div class="card"><h2>Pricing &amp; stock</h2><div class="row">${F("default_markup", "Default markup %", "number")}
    ${S("price_round", "MRP rounding", [["0", "No rounding"], ["1", "Round up to ₹1"], ["5", "Round up to ₹5"], ["10", "Round up to ₹10"], ["9", "End with 9 (e.g. 249, 399)"]])}
    ${F("default_moq", "Default MOQ (per size)", "number")}${S("allow_negative_stock", "Billing when out of stock", [["0", "Block the bill"], ["1", "Allow (stock goes negative)"]])}</div></div>
  <div class="card"><h2>Cash in hand</h2><div class="row">${F("opening_cash", "Opening cash ₹", "number")}${F("opening_cash_date", "Opening cash as on date", "date")}</div>
    <div class="muted" style="font-size:12px;margin-top:8px">Cash in hand = opening cash + cash sales − cash expenses + cash added − cash taken out, counted from this date.</div></div>
  <div class="card"><h2>Numbering</h2><div class="row">${F("bill_prefix", "Bill number prefix")}${F("bill_next", "Next bill number", "number")}${F("inward_prefix", "Inward number prefix")}${F("inward_next", "Next inward number", "number")}</div></div>
  <div class="card"><h2>Barcode labels (thermal printer)</h2><div class="row">${F("label_w", "Label width (mm)", "number")}${F("label_h", "Label height (mm)", "number")}
    ${S("label_cols", "Labels across", [["1", "1"], ["2", "2"], ["3", "3"]])}${F("label_gap", "Gap between labels (mm)", "number")}${S("label_show_shop", "Print shop name on label", [["1", "Yes"], ["0", "No"]])}</div></div>
  </form>
  <div class="card"><h2>Users &amp; logins<span class="spacer"></span><button class="small primary" id="us-add">+ Add user</button></h2><div id="us-list"></div>
    <div class="muted" style="font-size:12px;margin-top:8px"><b>Owner</b>: full access. <b>Staff</b>: billing, returns, customers, stock list and labels only. Staff never see cost, profit, cash in hand, expenses or reports. Tick "Stock inward" to also let a staff member enter stock (they will see cost prices there).</div></div>
  <div class="card"><h2>Backup</h2><div>All data is stored in <span class="mono">${esc(B.data_path)}</span>. An automatic backup is taken every day when SuperSoft starts (the last 60 are kept in the <span class="mono">backups</span> folder).</div>
    <div class="btns" style="margin-top:10px"><button id="st-backup">Take backup now</button></div></div>`;
  $("#st-save").onclick = async () => {
    const settings = {};
    $$("#st-form [name]").forEach(i => settings[i.name] = i.value.trim());
    if (await guard(() => api("save_settings", { settings }))) { await loadB(); toast("Settings saved", "ok"); }
  };
  $("#st-backup").onclick = async () => { const r = await guard(() => api("backup")); if (r) toast("Backup saved: " + r.path, "ok"); };
  const userForm = u => formModal(u.id ? `Edit user ${u.username}` : "Add user", [
    ...(u.id ? [] : [{ k: "username", label: "Username (for login)", req: true, ph: "e.g. ravi" }]),
    { k: "name", label: "Full name" },
    { k: "password", label: u.id ? "New password (leave blank to keep current)" : "Password (min 8 characters)", type: "password", req: !u.id },
    { k: "role", label: "Role", type: "select", options: [["STAFF", "Staff (billing only, no profit/cost)"], ["OWNER", "Owner (full access)"]], def: "STAFF" },
    { k: "can_inward", label: "Staff can do stock inward?", type: "select", options: [["0", "No"], ["1", "Yes (will see cost prices)"]], def: "0" },
    ...(u.id ? [{ k: "active", label: "Status", type: "select", options: [["1", "Active"], ["0", "Disabled (cannot log in)"]] }] : [])],
    { ...u, can_inward: u.can_inward ? "1" : "0", active: u.active === false ? "0" : "1" },
    async v => { const r = await api("save_user", v); toast("User saved", "ok"); loadUsers(); return r; });
  const loadUsers = async () => {
    const us = await guard(() => api("list_users")); if (!us) return;
    $("#us-list").innerHTML = `<table class="t"><thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Stock inward</th><th>Status</th><th></th></tr></thead><tbody>
      ${us.map((u, i) => `<tr><td><b>${esc(u.username)}</b>${B.me && B.me.id === u.id ? ' <span class="muted">(you)</span>' : ""}</td><td>${esc(u.name)}</td>
        <td>${u.role === "OWNER" ? '<span class="pill ok">OWNER</span>' : '<span class="pill warn">STAFF</span>'}</td><td>${u.role === "OWNER" || u.can_inward ? "Yes" : "No"}</td>
        <td>${u.active ? "Active" : '<span class="pill bad">DISABLED</span>'}</td><td style="text-align:right"><button class="small" data-ue="${i}">Edit</button></td></tr>`).join("")}</tbody></table>`;
    $$("[data-ue]", main).forEach(b => b.onclick = () => userForm(us[+b.dataset.ue]));
  };
  $("#us-add").onclick = () => userForm({});
  loadUsers();
};

// ---------------------------------------------------------------- start
// The page stays hidden (body.booting) until we know who is logged in, so the
// app screens never flash before the sign-in box.
const ready = () => document.body.classList.remove("booting");
(async () => {
  saveLQ();
  let st = null;
  try { const r = await fetch("/api/auth_status", { method: "POST" }); st = (await r.json()).data; } catch { /* handled below */ }
  try {
    if (!st) { await guard(loadB); await route(); return; }   // engine not running: route() shows the message
    if (!st.user) { await showLogin(); return; }
    await guard(loadB);
    applyRole();
    await route();
  } finally {
    ready();
  }
})();
