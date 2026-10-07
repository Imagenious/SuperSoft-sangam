"""
SuperSoft - Cloth Business ERP
Offline, single-PC application. Runs a small local web server (Python standard
library only) and stores all data in data/sangam.db (SQLite).

Start:  python server.py     (or double-click "Start SuperSoft.bat")
Open:   http://127.0.0.1:8765
"""
import datetime
import hashlib
import hmac
import http.cookies
import json
import math
import mimetypes
import os
import shutil
import sqlite3
import sys
import secrets
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")
DATA = os.environ.get("SANGAM_DATA") or os.path.join(BASE, "data")
DB_PATH = os.path.join(DATA, "sangam.db")
BACKUPS = os.path.join(DATA, "backups")
HOST, PORT = "127.0.0.1", int(os.environ.get("SANGAM_PORT") or 8765)

LOCK = threading.RLock()
DB = None


class ApiError(Exception):
    pass


def r2(x):
    return round(float(x or 0) + 1e-9, 2) if x >= 0 else -round(-float(x) + 1e-9, 2)


IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))


def now_dt():
    """Current time in Indian Standard Time, whatever the server's own timezone is."""
    return datetime.datetime.now(IST).replace(tzinfo=None)


def now():
    return now_dt().strftime("%Y-%m-%d %H:%M:%S")


def today_date():
    return now_dt().date()


def today():
    return today_date().isoformat()


# --------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS size_sets(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, sizes TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS subcategories(
  id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL, hsn TEXT DEFAULT '', gst TEXT DEFAULT 'SLAB', unit TEXT DEFAULT 'PCS',
  size_set_id INTEGER REFERENCES size_sets(id), moq REAL, UNIQUE(category_id, name));
CREATE TABLE IF NOT EXISTS brands(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS suppliers(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, phone TEXT DEFAULT '',
  city TEXT DEFAULT '', gstin TEXT DEFAULT '', address TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY, barcode TEXT UNIQUE NOT NULL, subcategory_id INTEGER NOT NULL REFERENCES subcategories(id),
  brand_id INTEGER REFERENCES brands(id), description TEXT DEFAULT '', size TEXT DEFAULT '', unit TEXT DEFAULT 'PCS',
  cost REAL NOT NULL, markup REAL DEFAULT 0, mrp REAL NOT NULL, stock REAL NOT NULL DEFAULT 0,
  supplier_id INTEGER REFERENCES suppliers(id), created_at TEXT);
CREATE TABLE IF NOT EXISTS purchases(
  id INTEGER PRIMARY KEY, inward_no TEXT UNIQUE, date TEXT NOT NULL, supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  supplier_bill_no TEXT DEFAULT '', notes TEXT DEFAULT '', total_qty REAL DEFAULT 0, total_cost REAL DEFAULT 0,
  gst_amount REAL DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS purchase_lines(
  id INTEGER PRIMARY KEY, purchase_id INTEGER NOT NULL REFERENCES purchases(id), item_id INTEGER NOT NULL REFERENCES items(id),
  qty REAL NOT NULL, cost REAL NOT NULL, markup REAL NOT NULL, mrp REAL NOT NULL);
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, mobile TEXT UNIQUE NOT NULL,
  city TEXT DEFAULT '', created_at TEXT);
CREATE TABLE IF NOT EXISTS sales(
  id INTEGER PRIMARY KEY, bill_no TEXT UNIQUE, date TEXT NOT NULL, created_at TEXT,
  customer_id INTEGER REFERENCES customers(id), gross REAL DEFAULT 0, line_discount REAL DEFAULT 0,
  bill_discount REAL DEFAULT 0, returns REAL DEFAULT 0, total REAL DEFAULT 0, round_off REAL DEFAULT 0, net REAL DEFAULT 0,
  taxable REAL DEFAULT 0, gst REAL DEFAULT 0, cost REAL DEFAULT 0, profit REAL DEFAULT 0,
  pay_cash REAL DEFAULT 0, pay_upi REAL DEFAULT 0, pay_card REAL DEFAULT 0,
  status TEXT DEFAULT 'ACTIVE', notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS sale_lines(
  id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id), item_id INTEGER NOT NULL REFERENCES items(id),
  qty REAL NOT NULL, mrp REAL NOT NULL, disc_pct REAL DEFAULT 0, amount REAL NOT NULL, gst_rate REAL NOT NULL,
  taxable REAL NOT NULL, gst REAL NOT NULL, cost REAL NOT NULL, profit REAL NOT NULL, return_of INTEGER REFERENCES sale_lines(id));
CREATE TABLE IF NOT EXISTS stock_adjustments(
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), date TEXT, qty REAL NOT NULL, reason TEXT DEFAULT '');
CREATE INDEX IF NOT EXISTS ix_sales_date ON sales(date);
CREATE INDEX IF NOT EXISTS ix_sl_sale ON sale_lines(sale_id);
CREATE INDEX IF NOT EXISTS ix_sl_item ON sale_lines(item_id);
CREATE INDEX IF NOT EXISTS ix_pl_purchase ON purchase_lines(purchase_id);
CREATE INDEX IF NOT EXISTS ix_items_sub ON items(subcategory_id);
CREATE TABLE IF NOT EXISTS expense_heads(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS expenses(
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, head_id INTEGER NOT NULL REFERENCES expense_heads(id), amount REAL NOT NULL,
  paid_by TEXT NOT NULL DEFAULT 'CASH', paid_to TEXT DEFAULT '', note TEXT DEFAULT '', created_at TEXT);
CREATE TABLE IF NOT EXISTS cash_entries(
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('IN','OUT')),
  reason TEXT NOT NULL, amount REAL NOT NULL, note TEXT DEFAULT '', created_at TEXT);
CREATE INDEX IF NOT EXISTS ix_exp_date ON expenses(date);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT DEFAULT '', pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'STAFF', can_inward INTEGER DEFAULT 0, active INTEGER DEFAULT 1, created_at TEXT);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT, expires REAL NOT NULL);
CREATE INDEX IF NOT EXISTS ix_cash_date ON cash_entries(date);
"""

DEFAULT_SETTINGS = {
    "shop_name": "My Cloth Store",
    "shop_address": "Shop address, City - PIN",
    "shop_phone": "",
    "shop_gstin": "",
    "shop_state": "",
    "invoice_footer": "Thank you for shopping with us! Exchange within 7 days with bill. No cash refund.",
    "invoice_format": "A4",
    "default_moq": "10",
    "gst_mode": "FLAT",
    "gst_flat_rate": "5",
    "gst_threshold": "2500",
    "gst_low": "5",
    "gst_high": "18",
    "default_markup": "50",
    "price_round": "9",
    "bill_prefix": "SB",
    "bill_next": "1",
    "inward_prefix": "IN",
    "inward_next": "1",
    "barcode_next": "10000001",
    "label_w": "50",
    "label_h": "25",
    "label_cols": "1",
    "label_gap": "2",
    "label_show_shop": "1",
    "allow_negative_stock": "0",
    "balance_mode": "UPI",
    "opening_cash": "0",
    "opening_cash_date": "",
}

SEED_SIZE_SETS = [
    ("Free Size", "FREE"),
    ("Hosiery (cm)", "75,80,85,90,95,100,105,110"),
    ("Bra", "30B,32B,32C,34B,34C,34D,36B,36C,36D,38B,38C,38D,40C,40D"),
    ("Standard (S-XXL)", "S,M,L,XL,XXL"),
    ("Women Wear (XS-3XL)", "XS,S,M,L,XL,XXL,3XL"),
    ("Men Shirt (36-46)", "36,38,40,42,44,46"),
    ("Men Waist (28-42)", "28,30,32,34,36,38,40,42"),
    ("Women Waist (26-36)", "26,28,30,32,34,36"),
]

# Seed catalogs are applied once each (tracked by a settings flag). Only missing categories /
# sub-categories are inserted, so anything the user renamed, edited or deleted later is left alone.
# category -> [(sub-category, HSN, size set, GST, unit)]   GST "SLAB" = price-based slab from Settings
SEED_CATALOGS = [
    ("seed_v1", [
        ("Men's Hosiery", [
            ("Banian / Vest", "6109", "Hosiery (cm)", "SLAB", "PCS"),
            ("Underwear / Briefs / Trunks", "6107", "Hosiery (cm)", "SLAB", "PCS"),
            ("Handkerchief", "6213", "Free Size", "SLAB", "PCS"),
        ]),
        ("Women's Hosiery", [
            ("Bra", "6212", "Bra", "SLAB", "PCS"),
            ("Panties", "6108", "Standard (S-XXL)", "SLAB", "PCS"),
            ("Handkerchief", "6213", "Free Size", "SLAB", "PCS"),
        ]),
        ("Towels", [
            ("Bath Towel", "6302", "Free Size", "SLAB", "PCS"),
            ("Hand Towel", "6302", "Free Size", "SLAB", "PCS"),
            ("Face Towel", "6302", "Free Size", "SLAB", "PCS"),
        ]),
    ]),
    ("seed_v2", [
        ("Sarees", [
            ("Silk Saree", "5007", "Free Size", "5", "PCS"),
            ("Cotton Saree", "5208", "Free Size", "5", "PCS"),
            ("Georgette Saree", "5407", "Free Size", "5", "PCS"),
            ("Chiffon Saree", "5407", "Free Size", "5", "PCS"),
            ("Banarasi Saree", "5007", "Free Size", "5", "PCS"),
            ("Printed / Daily Wear Saree", "5407", "Free Size", "5", "PCS"),
            ("Designer / Party Wear Saree", "5407", "Free Size", "5", "PCS"),
        ]),
        ("Shirts", [
            ("Men's Formal Shirt", "6205", "Men Shirt (36-46)", "SLAB", "PCS"),
            ("Men's Casual Shirt", "6205", "Standard (S-XXL)", "SLAB", "PCS"),
            ("Men's T-Shirt", "6109", "Standard (S-XXL)", "SLAB", "PCS"),
            ("Women's Shirt / Top", "6206", "Women Wear (XS-3XL)", "SLAB", "PCS"),
        ]),
        ("Pants", [
            ("Men's Formal Trouser", "6203", "Men Waist (28-42)", "SLAB", "PCS"),
            ("Men's Jeans", "6203", "Men Waist (28-42)", "SLAB", "PCS"),
            ("Men's Cotton / Casual Pant", "6203", "Men Waist (28-42)", "SLAB", "PCS"),
            ("Women's Trouser / Pant", "6204", "Women Waist (26-36)", "SLAB", "PCS"),
            ("Women's Jeans", "6204", "Women Waist (26-36)", "SLAB", "PCS"),
            ("Women's Leggings / Palazzo", "6104", "Women Wear (XS-3XL)", "SLAB", "PCS"),
        ]),
        ("Dress Material", [
            ("Men's Shirting (per metre)", "5208", "Free Size", "5", "MTR"),
            ("Men's Suiting (per metre)", "5515", "Free Size", "5", "MTR"),
            ("Men's Shirt + Pant Piece Set", "5208", "Free Size", "5", "PCS"),
            ("Women's Unstitched Suit (3 pc)", "5208", "Free Size", "5", "PCS"),
            ("Women's Unstitched Suit (2 pc)", "5208", "Free Size", "5", "PCS"),
            ("Women's Running Fabric (per metre)", "5208", "Free Size", "5", "MTR"),
        ]),
    ]),
]


def apply_seed_catalogs(db):
    for name, sizes in SEED_SIZE_SETS:
        db.execute("INSERT OR IGNORE INTO size_sets(name, sizes) VALUES(?, ?)", (name, sizes))
    for flag, catalog in SEED_CATALOGS:
        if db.execute("SELECT 1 FROM settings WHERE key=?", (flag,)).fetchone():
            continue
        for cat, subs in catalog:
            db.execute("INSERT OR IGNORE INTO categories(name) VALUES(?)", (cat,))
            cid = db.execute("SELECT id FROM categories WHERE name=?", (cat,)).fetchone()[0]
            for sub, hsn, ss, gst, unit in subs:
                ssid = db.execute("SELECT id FROM size_sets WHERE name=?", (ss,)).fetchone()[0]
                db.execute("""INSERT OR IGNORE INTO subcategories(category_id, name, hsn, gst, unit, size_set_id)
                              VALUES(?,?,?,?,?,?)""", (cid, sub, hsn, gst, unit, ssid))
        db.execute("INSERT INTO settings(key, value) VALUES(?, ?)", (flag, now()))


SEED_EXPENSE_HEADS = ["Shop Rent", "Staff Salary", "Electricity Bill", "Tea / Snacks", "Transport / Freight",
                      "Packing Material / Carry Bags", "Telephone / Internet", "Repairs & Maintenance", "Cleaning",
                      "Stationery & Printing", "Advertising", "Bank Charges", "Miscellaneous"]
CASH_IN_REASONS = ["Cash added by owner", "Cash withdrawn from bank", "Other income"]
CASH_OUT_REASONS = ["Deposited to bank", "Owner withdrawal", "Payment to supplier", "Other"]


def connect():
    os.makedirs(DATA, exist_ok=True)
    os.makedirs(BACKUPS, exist_ok=True)
    db = sqlite3.connect(DB_PATH, check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(SCHEMA)
    for k, v in DEFAULT_SETTINGS.items():
        db.execute("INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)", (k, v))
    cols = {r[1] for r in db.execute("PRAGMA table_info(sales)").fetchall()}
    if "pay_cheque" not in cols:
        db.execute("ALTER TABLE sales ADD COLUMN pay_cheque REAL DEFAULT 0")
    if "pay_ref" not in cols:
        db.execute("ALTER TABLE sales ADD COLUMN pay_ref TEXT DEFAULT ''")
    apply_seed_catalogs(db)
    if not db.execute("SELECT 1 FROM settings WHERE key='seed_expense_heads'").fetchone():
        for h in SEED_EXPENSE_HEADS:
            db.execute("INSERT OR IGNORE INTO expense_heads(name) VALUES(?)", (h,))
        db.execute("INSERT INTO settings(key, value) VALUES('seed_expense_heads', ?)", (now(),))
    db.commit()
    return db


def rows(sql, args=()):
    return [dict(r) for r in DB.execute(sql, args).fetchall()]


def row(sql, args=()):
    r = DB.execute(sql, args).fetchone()
    return dict(r) if r else None


def get_settings():
    return {r["key"]: r["value"] for r in rows("SELECT key, value FROM settings")}


def next_counter(key, prefix_key=None, width=5):
    st = get_settings()
    n = int(st.get(key, "1"))
    DB.execute("UPDATE settings SET value=? WHERE key=?", (str(n + 1), key))
    if prefix_key:
        return f"{st.get(prefix_key, '')}{n:0{width}d}"
    return str(n)


def backup(tag="manual"):
    os.makedirs(BACKUPS, exist_ok=True)
    name = f"sangam_{now_dt().strftime('%Y%m%d_%H%M%S')}_{tag}.db"
    dest = os.path.join(BACKUPS, name)
    with LOCK:
        target = sqlite3.connect(dest)
        DB.backup(target)
        target.close()
    return dest


def auto_backup():
    stamp = today_date().strftime("%Y%m%d")
    if not any(f.startswith(f"sangam_{stamp}") for f in os.listdir(BACKUPS)):
        backup("auto")
    # keep the latest 60 backups
    files = sorted(f for f in os.listdir(BACKUPS) if f.endswith(".db"))
    for f in files[:-60]:
        try:
            os.remove(os.path.join(BACKUPS, f))
        except OSError:
            pass


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
ITEM_SQL = """
SELECT i.*, s.name AS subcategory, s.hsn, s.gst AS gst_mode, s.moq AS sub_moq, c.id AS category_id,
       c.name AS category, b.name AS brand, sp.name AS supplier
FROM items i
JOIN subcategories s ON s.id = i.subcategory_id
JOIN categories c ON c.id = s.category_id
LEFT JOIN brands b ON b.id = i.brand_id
LEFT JOIN suppliers sp ON sp.id = i.supplier_id
"""


def item_name(it):
    parts = [it.get("subcategory") or ""]
    if it.get("brand"):
        parts.append(it["brand"])
    if it.get("description"):
        parts.append(it["description"])
    return " ".join(p for p in parts if p)


def get_item(item_id=None, barcode=None):
    if item_id is not None:
        it = row(ITEM_SQL + " WHERE i.id=?", (item_id,))
    else:
        it = row(ITEM_SQL + " WHERE i.barcode=?", (str(barcode).strip(),))
    if it:
        it["name"] = item_name(it)
    return it


def gst_rate_for(mode, unit_price, st):
    if st.get("gst_mode", "FLAT") == "FLAT":
        return float(st.get("gst_flat_rate") or 0)
    if (mode or "SLAB") == "SLAB":
        return float(st["gst_low"]) if unit_price <= float(st["gst_threshold"]) + 1e-9 else float(st["gst_high"])
    try:
        return float(mode)
    except ValueError:
        return 0.0


def num(v, default=0.0):
    try:
        if v is None or v == "":
            return default
        return float(v)
    except (TypeError, ValueError):
        raise ApiError(f"Invalid number: {v}")


def date_filter(col, a):
    sql, args = [], []
    if a.get("from"):
        sql.append(f"{col} >= ?")
        args.append(a["from"])
    if a.get("to"):
        sql.append(f"{col} <= ?")
        args.append(a["to"])
    return sql, args


# --------------------------------------------------------------------------
# API: bootstrap, settings, masters
# --------------------------------------------------------------------------
def api_bootstrap(a):
    return {
        "settings": get_settings(),
        "categories": rows("SELECT * FROM categories ORDER BY name"),
        "subcategories": rows("""SELECT s.*, c.name AS category, ss.name AS size_set, ss.sizes,
                                 (SELECT COUNT(*) FROM items i WHERE i.subcategory_id=s.id) AS item_count
                                 FROM subcategories s JOIN categories c ON c.id=s.category_id
                                 LEFT JOIN size_sets ss ON ss.id=s.size_set_id ORDER BY c.name, s.name"""),
        "size_sets": rows("SELECT * FROM size_sets ORDER BY name"),
        "expense_heads": rows("""SELECT h.*, (SELECT COUNT(*) FROM expenses e WHERE e.head_id=h.id) AS used
                                 FROM expense_heads h ORDER BY h.name"""),
        "cash_in_reasons": CASH_IN_REASONS, "cash_out_reasons": CASH_OUT_REASONS,
        "brands": rows("SELECT * FROM brands ORDER BY name"),
        "suppliers": rows("SELECT * FROM suppliers ORDER BY name"),
        "data_path": DATA,
    }


def api_save_settings(a):
    allowed = set(DEFAULT_SETTINGS)
    for k, v in (a.get("settings") or {}).items():
        if k in allowed:
            DB.execute("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)", (k, str(v)))
    return get_settings()


def _req(a, key, label):
    v = str(a.get(key) or "").strip()
    if not v:
        raise ApiError(f"{label} is required")
    return v


def _save(table, a, fields):
    vals = {f: (a.get(f) if a.get(f) is not None else "") for f in fields}
    try:
        if a.get("id"):
            sets = ", ".join(f"{f}=?" for f in fields)
            DB.execute(f"UPDATE {table} SET {sets} WHERE id=?", (*vals.values(), a["id"]))
            return {"id": a["id"]}
        cols = ", ".join(fields)
        q = ", ".join("?" for _ in fields)
        return {"id": DB.execute(f"INSERT INTO {table}({cols}) VALUES({q})", tuple(vals.values())).lastrowid}
    except sqlite3.IntegrityError:
        raise ApiError("A record with this name already exists")


def _delete(table, id_, checks):
    for sql, msg in checks:
        if DB.execute(sql, (id_,)).fetchone()[0]:
            raise ApiError(msg)
    DB.execute(f"DELETE FROM {table} WHERE id=?", (id_,))
    return {}


def api_save_category(a):
    a["name"] = _req(a, "name", "Category name")
    return _save("categories", a, ["name"])


def api_delete_category(a):
    return _delete("categories", a["id"], [
        ("SELECT COUNT(*) FROM subcategories WHERE category_id=?", "Delete its sub-categories first")])


def api_save_subcategory(a):
    a["name"] = _req(a, "name", "Sub-category name")
    if not a.get("category_id"):
        raise ApiError("Category is required")
    a["moq"] = None if a.get("moq") in (None, "") else num(a["moq"])
    a["size_set_id"] = a.get("size_set_id") or None
    a["gst"] = a.get("gst") or "SLAB"
    a["unit"] = a.get("unit") or "PCS"
    fields = ["category_id", "name", "hsn", "gst", "unit", "size_set_id", "moq"]
    vals = [a.get(f) if a.get(f) is not None or f in ("moq", "size_set_id") else "" for f in fields]
    try:
        if a.get("id"):
            DB.execute(f"UPDATE subcategories SET {', '.join(f + '=?' for f in fields)} WHERE id=?", (*vals, a["id"]))
            return {"id": a["id"]}
        return {"id": DB.execute(f"INSERT INTO subcategories({', '.join(fields)}) VALUES({', '.join('?' * len(fields))})",
                                 vals).lastrowid}
    except sqlite3.IntegrityError:
        raise ApiError("This sub-category already exists in the category")


def api_delete_subcategory(a):
    return _delete("subcategories", a["id"], [
        ("SELECT COUNT(*) FROM items WHERE subcategory_id=?", "This sub-category has stock items and cannot be deleted")])


def api_save_size_set(a):
    a["name"] = _req(a, "name", "Size set name")
    sizes = [s.strip() for s in str(a.get("sizes") or "").split(",") if s.strip()]
    if not sizes:
        raise ApiError("Enter at least one size")
    a["sizes"] = ",".join(sizes)
    return _save("size_sets", a, ["name", "sizes"])


def api_delete_size_set(a):
    return _delete("size_sets", a["id"], [
        ("SELECT COUNT(*) FROM subcategories WHERE size_set_id=?", "This size set is used by a sub-category")])


def api_save_brand(a):
    a["name"] = _req(a, "name", "Brand name")
    return _save("brands", a, ["name"])


def api_delete_brand(a):
    return _delete("brands", a["id"], [("SELECT COUNT(*) FROM items WHERE brand_id=?", "This brand is used by stock items")])


def api_save_supplier(a):
    a["name"] = _req(a, "name", "Supplier name")
    return _save("suppliers", a, ["name", "phone", "city", "gstin", "address"])


def api_delete_supplier(a):
    return _delete("suppliers", a["id"], [
        ("SELECT COUNT(*) FROM purchases WHERE supplier_id=?", "This supplier has inward entries")])


# --------------------------------------------------------------------------
# API: stock inward
# --------------------------------------------------------------------------
def api_save_inward(a):
    supplier_id = a.get("supplier_id")
    if not supplier_id or not row("SELECT id FROM suppliers WHERE id=?", (supplier_id,)):
        raise ApiError("Select a supplier")
    lines = a.get("lines") or []
    if not lines:
        raise ApiError("Add at least one item line")
    date = a.get("date") or today()
    inward_no = next_counter("inward_next", "inward_prefix")
    pid = DB.execute(
        "INSERT INTO purchases(inward_no, date, supplier_id, supplier_bill_no, notes, gst_amount, created_at) VALUES(?,?,?,?,?,?,?)",
        (inward_no, date, supplier_id, a.get("supplier_bill_no") or "", a.get("notes") or "",
         num(a.get("gst_amount")), now())).lastrowid
    tq = tc = 0.0
    labels = []
    for ln in lines:
        sub = row("SELECT * FROM subcategories WHERE id=?", (ln.get("subcategory_id"),))
        if not sub:
            raise ApiError("Invalid sub-category in a line")
        qty, cost, mrp = num(ln.get("qty")), num(ln.get("cost")), num(ln.get("mrp"))
        if qty <= 0:
            raise ApiError("Quantity must be more than 0")
        if cost <= 0 or mrp <= 0:
            raise ApiError("Cost and MRP must be more than 0")
        barcode = next_counter("barcode_next")
        iid = DB.execute(
            """INSERT INTO items(barcode, subcategory_id, brand_id, description, size, unit, cost, markup, mrp, stock,
               supplier_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            (barcode, sub["id"], ln.get("brand_id") or None, (ln.get("description") or "").strip(),
             (ln.get("size") or "").strip(), ln.get("unit") or sub["unit"], cost, num(ln.get("markup")), mrp, qty,
             supplier_id, now())).lastrowid
        DB.execute("INSERT INTO purchase_lines(purchase_id, item_id, qty, cost, markup, mrp) VALUES(?,?,?,?,?,?)",
                   (pid, iid, qty, cost, num(ln.get("markup")), mrp))
        tq += qty
        tc += qty * cost
        labels.append({"item_id": iid, "copies": int(math.ceil(qty)) if (ln.get("unit") or sub["unit"]) != "MTR" else 1})
    DB.execute("UPDATE purchases SET total_qty=?, total_cost=? WHERE id=?", (tq, r2(tc), pid))
    return {"id": pid, "inward_no": inward_no, "labels": labels}


def api_list_inwards(a):
    w, args = date_filter("p.date", a)
    if a.get("supplier_id"):
        w.append("p.supplier_id=?")
        args.append(a["supplier_id"])
    where = ("WHERE " + " AND ".join(w)) if w else ""
    return rows(f"""SELECT p.*, sp.name AS supplier, (SELECT COUNT(*) FROM purchase_lines WHERE purchase_id=p.id) AS lines
                    FROM purchases p JOIN suppliers sp ON sp.id=p.supplier_id {where}
                    ORDER BY p.date DESC, p.id DESC LIMIT 500""", args)


def api_get_inward(a):
    p = row("SELECT p.*, sp.name AS supplier FROM purchases p JOIN suppliers sp ON sp.id=p.supplier_id WHERE p.id=?",
            (a["id"],))
    if not p:
        raise ApiError("Inward not found")
    p["lines"] = []
    for ln in rows("SELECT * FROM purchase_lines WHERE purchase_id=? ORDER BY id", (a["id"],)):
        it = get_item(ln["item_id"])
        ln.update({"barcode": it["barcode"], "name": it["name"], "size": it["size"], "unit": it["unit"],
                   "stock": it["stock"], "category": it["category"], "category_id": it["category_id"],
                   "subcategory": it["subcategory"], "subcategory_id": it["subcategory_id"], "brand_id": it["brand_id"],
                   "brand": it["brand"] or "", "description": it["description"],
                   "moved": r2(ln["qty"] - it["stock"])})  # qty already sold / adjusted out
        p["lines"].append(ln)
    return p


def api_update_inward(a):
    p = api_get_inward(a)
    supplier_id = a.get("supplier_id")
    if not supplier_id or not row("SELECT id FROM suppliers WHERE id=?", (supplier_id,)):
        raise ApiError("Select a supplier")
    lines = a.get("lines") or []
    if not lines:
        raise ApiError("An inward needs at least one line. Use Delete to remove the whole inward.")
    st = get_settings()
    old = {ln["item_id"]: ln for ln in p["lines"]}
    keep = {int(ln["item_id"]) for ln in lines if ln.get("item_id")}
    for iid, ln in old.items():  # lines removed in the edit
        if iid not in keep:
            used = DB.execute("SELECT (SELECT COUNT(*) FROM sale_lines WHERE item_id=?) + "
                              "(SELECT COUNT(*) FROM stock_adjustments WHERE item_id=?)", (iid, iid)).fetchone()[0]
            if used:
                raise ApiError(f"{ln['barcode']} is already sold/adjusted and cannot be removed - reduce its qty instead")
            DB.execute("DELETE FROM purchase_lines WHERE id=?", (ln["id"],))
            DB.execute("DELETE FROM items WHERE id=?", (iid,))
    DB.execute("UPDATE purchases SET date=?, supplier_id=?, supplier_bill_no=?, notes=?, gst_amount=? WHERE id=?",
               (a.get("date") or p["date"], supplier_id, a.get("supplier_bill_no") or "", a.get("notes") or "",
                num(a.get("gst_amount")), p["id"]))
    labels, tq, tc = [], 0.0, 0.0
    for ln in lines:
        sub = row("SELECT * FROM subcategories WHERE id=?", (ln.get("subcategory_id"),))
        if not sub:
            raise ApiError("Invalid sub-category in a line")
        qty, cost, mrp = num(ln.get("qty")), num(ln.get("cost")), num(ln.get("mrp"))
        if qty <= 0 or cost <= 0 or mrp <= 0:
            raise ApiError("Qty, cost and MRP must be more than 0 on every line")
        markup = r2((mrp / cost - 1) * 100)
        unit = ln.get("unit") or sub["unit"]
        fields = (sub["id"], ln.get("brand_id") or None, (ln.get("description") or "").strip(),
                  (ln.get("size") or "").strip(), unit, cost, markup, mrp, supplier_id)
        o = old.get(int(ln["item_id"])) if ln.get("item_id") else None
        if o:
            new_stock = qty - o["moved"]
            if new_stock < -1e-9 and st.get("allow_negative_stock") != "1":
                raise ApiError(f"{o['barcode']}: {o['moved']:g} already sold/adjusted, qty cannot be less than that")
            DB.execute("""UPDATE items SET subcategory_id=?, brand_id=?, description=?, size=?, unit=?, cost=?, markup=?,
                          mrp=?, supplier_id=?, stock=? WHERE id=?""", (*fields, new_stock, o["item_id"]))
            DB.execute("UPDATE purchase_lines SET qty=?, cost=?, markup=?, mrp=? WHERE id=?", (qty, cost, markup, mrp, o["id"]))
            label_changed = (abs(o["mrp"] - mrp) > 0.001 or o["size"] != fields[3] or o["description"] != fields[2]
                             or o["subcategory_id"] != sub["id"] or (o["brand_id"] or None) != fields[1])
            if label_changed:
                labels.append({"item_id": o["item_id"], "copies": 1 if unit == "MTR" else int(math.ceil(max(new_stock, 0)))})
        else:
            barcode = next_counter("barcode_next")
            iid = DB.execute("""INSERT INTO items(barcode, subcategory_id, brand_id, description, size, unit, cost, markup,
                                mrp, supplier_id, stock, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                             (barcode, *fields, qty, now())).lastrowid
            DB.execute("INSERT INTO purchase_lines(purchase_id, item_id, qty, cost, markup, mrp) VALUES(?,?,?,?,?,?)",
                       (p["id"], iid, qty, cost, markup, mrp))
            labels.append({"item_id": iid, "copies": 1 if unit == "MTR" else int(math.ceil(qty))})
        tq += qty
        tc += qty * cost
    DB.execute("UPDATE purchases SET total_qty=?, total_cost=? WHERE id=?", (tq, r2(tc), p["id"]))
    return {"id": p["id"], "inward_no": p["inward_no"], "labels": [x for x in labels if x["copies"] > 0]}


def api_delete_inward(a):
    p = api_get_inward(a)
    for ln in p["lines"]:
        sold = DB.execute("SELECT COUNT(*) FROM sale_lines WHERE item_id=?", (ln["item_id"],)).fetchone()[0]
        adj = DB.execute("SELECT COUNT(*) FROM stock_adjustments WHERE item_id=?", (ln["item_id"],)).fetchone()[0]
        if sold or adj:
            raise ApiError(f"Item {ln['barcode']} is already sold/adjusted - this inward cannot be deleted")
    for ln in p["lines"]:
        DB.execute("DELETE FROM purchase_lines WHERE id=?", (ln["id"],))
        DB.execute("DELETE FROM items WHERE id=?", (ln["item_id"],))
    DB.execute("DELETE FROM purchases WHERE id=?", (a["id"],))
    return {}


# --------------------------------------------------------------------------
# API: items / stock
# --------------------------------------------------------------------------
def api_find_item(a):
    it = get_item(barcode=a.get("barcode", ""))
    if not it:
        raise ApiError(f"No item with barcode {a.get('barcode')}")
    return it


def api_search_items(a):
    w, args = [], []
    q = str(a.get("q") or "").strip()
    if q:
        w.append("(i.barcode LIKE ? OR i.description LIKE ? OR s.name LIKE ? OR b.name LIKE ? OR i.size = ?)")
        args += [f"%{q}%"] * 4 + [q]
    if a.get("category_id"):
        w.append("c.id=?")
        args.append(a["category_id"])
    if a.get("subcategory_id"):
        w.append("s.id=?")
        args.append(a["subcategory_id"])
    if a.get("supplier_id"):
        w.append("i.supplier_id=?")
        args.append(a["supplier_id"])
    if a.get("in_stock"):
        w.append("i.stock > 0")
    where = ("WHERE " + " AND ".join(w)) if w else ""
    res = rows(ITEM_SQL + f" {where} ORDER BY c.name, s.name, i.description, i.id LIMIT {int(a.get('limit') or 2000)}", args)
    for it in res:
        it["name"] = item_name(it)
    return res


def api_update_item(a):
    it = get_item(a["id"])
    if not it:
        raise ApiError("Item not found")
    mrp = num(a.get("mrp"), it["mrp"])
    if mrp <= 0:
        raise ApiError("MRP must be more than 0")
    DB.execute("UPDATE items SET mrp=?, description=?, brand_id=? WHERE id=?",
               (mrp, (a.get("description") if a.get("description") is not None else it["description"]).strip(),
                a.get("brand_id") or None, a["id"]))
    return get_item(a["id"])


def api_adjust_stock(a):
    it = get_item(a["item_id"])
    if not it:
        raise ApiError("Item not found")
    q = num(a.get("qty"))
    if q == 0:
        raise ApiError("Enter a quantity (+ to add, - to reduce)")
    if not str(a.get("reason") or "").strip():
        raise ApiError("Enter a reason (damaged, count correction, etc.)")
    DB.execute("INSERT INTO stock_adjustments(item_id, date, qty, reason) VALUES(?,?,?,?)",
               (it["id"], today(), q, a["reason"].strip()))
    DB.execute("UPDATE items SET stock = stock + ? WHERE id=?", (q, it["id"]))
    return get_item(it["id"])


def api_items_by_ids(a):
    ids = [int(x) for x in (a.get("ids") or [])]
    out = []
    for i in ids:
        it = get_item(i)
        if it:
            out.append(it)
    return out


# --------------------------------------------------------------------------
# API: sales / billing
# --------------------------------------------------------------------------
def api_customer_lookup(a):
    return row("SELECT * FROM customers WHERE mobile=?", (str(a.get("mobile") or "").strip(),))


def api_list_customers(a):
    w, args = [], []
    q = str(a.get("q") or "").strip()
    if q:
        w.append("(cu.name LIKE ? OR cu.mobile LIKE ? OR cu.city LIKE ?)")
        args += [f"%{q}%"] * 3
    where = ("WHERE " + " AND ".join(w)) if w else ""
    return rows(f"""SELECT cu.*, COUNT(x.id) AS bills, COALESCE(SUM(x.net),0) AS amount, MAX(x.date) AS last
                    FROM customers cu LEFT JOIN sales x ON x.customer_id=cu.id AND x.status='ACTIVE'
                    {where} GROUP BY cu.id ORDER BY cu.name LIMIT 5000""", args)


def api_save_customer(a):
    name, mobile, city = (str(a.get(k) or "").strip() for k in ("name", "mobile", "city"))
    if not name:
        raise ApiError("Customer name is required")
    if not (mobile.isdigit() and len(mobile) == 10):
        raise ApiError("Enter a valid 10-digit mobile number")
    try:
        if a.get("id"):
            DB.execute("UPDATE customers SET name=?, mobile=?, city=? WHERE id=?", (name, mobile, city, a["id"]))
            return {"id": a["id"]}
        return {"id": DB.execute("INSERT INTO customers(name, mobile, city, created_at) VALUES(?,?,?,?)",
                                 (name, mobile, city, now())).lastrowid}
    except sqlite3.IntegrityError:
        raise ApiError("Another customer already has this mobile number")


def api_customer_bills(a):
    return rows("""SELECT s.id, s.bill_no, s.date, s.net, s.status,
                   (SELECT COALESCE(SUM(qty),0) FROM sale_lines WHERE sale_id=s.id AND qty>0) AS qty
                   FROM sales s WHERE s.customer_id=? ORDER BY s.id DESC""", (a["id"],))


def calc_bill(a):
    st = get_settings()
    out, sale_part = [], []
    for ln in a.get("lines") or []:
        if ln.get("return_of"):
            ol = row("""SELECT sl.*, s.status, s.bill_no FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id
                        WHERE sl.id=?""", (ln["return_of"],))
            if not ol or ol["qty"] <= 0:
                raise ApiError("Original bill line not found")
            if ol["status"] != "ACTIVE":
                raise ApiError(f"Bill {ol['bill_no']} is cancelled")
            q = abs(num(ln.get("qty")))
            done = DB.execute("""SELECT COALESCE(SUM(-sl.qty),0) FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id
                                 WHERE sl.return_of=? AND s.status='ACTIVE'""", (ol["id"],)).fetchone()[0]
            if q <= 0 or q > ol["qty"] - done + 1e-9:
                raise ApiError(f"Return qty exceeds what is returnable ({ol['qty'] - done:g}) on bill {ol['bill_no']}")
            f = q / ol["qty"]
            amount = -r2(ol["amount"] * f)
            taxable = -r2(ol["taxable"] * f)
            cost = -r2(ol["cost"] * f)
            it = get_item(ol["item_id"])
            out.append({"item_id": it["id"], "barcode": it["barcode"], "name": it["name"], "size": it["size"],
                        "unit": it["unit"], "hsn": it["hsn"], "qty": -q, "mrp": ol["mrp"], "disc_pct": ol["disc_pct"],
                        "gross": -r2(ol["mrp"] * q), "amount": amount, "gst_rate": ol["gst_rate"], "taxable": taxable,
                        "gst": r2(amount - taxable), "cost": cost, "profit": r2(taxable - cost),
                        "return_of": ol["id"], "ref_bill": ol["bill_no"], "stock": it["stock"]})
        else:
            it = get_item(ln.get("item_id"))
            if not it:
                raise ApiError("Item not found")
            q = num(ln.get("qty"))
            if q <= 0:
                raise ApiError(f"Quantity for {it['barcode']} must be more than 0")
            d = min(100.0, max(0.0, num(ln.get("disc_pct"))))
            gross = it["mrp"] * q
            rec = {"item_id": it["id"], "barcode": it["barcode"], "name": it["name"], "size": it["size"],
                   "unit": it["unit"], "hsn": it["hsn"], "qty": q, "mrp": it["mrp"], "disc_pct": d,
                   "gross": r2(gross), "_after": gross * (1 - d / 100), "_cost_unit": it["cost"],
                   "_gst_mode": it["gst_mode"], "return_of": None, "stock": it["stock"]}
            out.append(rec)
            sale_part.append(rec)

    base = sum(r["_after"] for r in sale_part)
    bd = num(a.get("bill_disc"))
    disc_amt = base * bd / 100 if a.get("bill_disc_type") == "pct" else bd
    disc_amt = r2(max(0.0, min(disc_amt, base)))
    allocated = 0.0
    for i, r in enumerate(sale_part):
        if i == len(sale_part) - 1:
            share = r2(disc_amt - allocated)
        else:
            share = r2(disc_amt * r["_after"] / base) if base else 0.0
        allocated += share
        amount = r2(r.pop("_after") - share)
        rate = gst_rate_for(r.pop("_gst_mode"), amount / r["qty"], st)
        taxable = r2(amount / (1 + rate / 100))
        cost = r2(r.pop("_cost_unit") * r["qty"])
        r.update({"amount": amount, "gst_rate": rate, "taxable": taxable, "gst": r2(amount - taxable),
                  "cost": cost, "profit": r2(taxable - cost), "bill_disc_share": share})

    gross = r2(sum(r["gross"] for r in sale_part))
    line_disc = r2(sum(r["gross"] for r in sale_part) - sum(r["amount"] + r.get("bill_disc_share", 0) for r in sale_part))
    returns = r2(sum(r["amount"] for r in out if r["return_of"]))
    total = r2(sum(r["amount"] for r in out))
    net = float(round(total))
    warnings = []
    need = {}
    for r in sale_part:
        need[r["item_id"]] = need.get(r["item_id"], 0) + r["qty"]
    for r in sale_part:
        if r["item_id"] in need and need[r["item_id"]] > r["stock"] + 1e-9:
            warnings.append(f"{r['barcode']} {r['name']} {r['size']}: only {r['stock']:g} in stock")
            need.pop(r["item_id"])
    taxable = r2(sum(r["taxable"] for r in out))
    cost = r2(sum(r["cost"] for r in out))
    return {"lines": out, "gross": gross, "line_discount": line_disc, "bill_discount": disc_amt, "returns": returns,
            "total": total, "round_off": r2(net - total), "net": net, "taxable": taxable,
            "gst": r2(sum(r["gst"] for r in out)), "cost": cost, "profit": r2(taxable - cost), "warnings": warnings}


def api_bill_preview(a):
    return calc_bill(a)


def api_save_bill(a):
    c = a.get("customer") or {}
    name, mobile, city = (str(c.get(k) or "").strip() for k in ("name", "mobile", "city"))
    if not name:
        raise ApiError("Customer name is required")
    if not (mobile.isdigit() and len(mobile) == 10):
        raise ApiError("Enter a valid 10-digit mobile number")
    if not (a.get("lines") or []):
        raise ApiError("Add at least one item")
    calc = calc_bill(a)
    st = get_settings()
    if calc["warnings"] and st.get("allow_negative_stock") != "1":
        raise ApiError("Not enough stock: " + "; ".join(calc["warnings"]))
    p = a.get("pay") or {}
    cash, upi, card, cheque = (num(p.get(k)) for k in ("cash", "upi", "card", "cheque"))
    if abs(cash + upi + card + cheque - calc["net"]) > 0.009:
        raise ApiError(f"Payment total (₹{cash + upi + card + cheque:.2f}) must equal net amount (₹{calc['net']:.2f})")

    cust = row("SELECT * FROM customers WHERE mobile=?", (mobile,))
    if cust:
        DB.execute("UPDATE customers SET name=?, city=? WHERE id=?", (name, city, cust["id"]))
        cid = cust["id"]
    else:
        cid = DB.execute("INSERT INTO customers(name, mobile, city, created_at) VALUES(?,?,?,?)",
                         (name, mobile, city, now())).lastrowid
    bill_no = next_counter("bill_next", "bill_prefix")
    sid = DB.execute(
        """INSERT INTO sales(bill_no, date, created_at, customer_id, gross, line_discount, bill_discount, returns, total,
           round_off, net, taxable, gst, cost, profit, pay_cash, pay_upi, pay_card, pay_cheque, pay_ref, status, notes)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ACTIVE',?)""",
        (bill_no, a.get("date") or today(), now(), cid, calc["gross"], calc["line_discount"], calc["bill_discount"],
         calc["returns"], calc["total"], calc["round_off"], calc["net"], calc["taxable"], calc["gst"], calc["cost"],
         calc["profit"], cash, upi, card, cheque, str(p.get("ref") or "").strip(), a.get("notes") or "")).lastrowid
    for r in calc["lines"]:
        DB.execute("""INSERT INTO sale_lines(sale_id, item_id, qty, mrp, disc_pct, amount, gst_rate, taxable, gst, cost,
                      profit, return_of) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                   (sid, r["item_id"], r["qty"], r["mrp"], r["disc_pct"], r["amount"], r["gst_rate"], r["taxable"],
                    r["gst"], r["cost"], r["profit"], r["return_of"]))
        DB.execute("UPDATE items SET stock = stock - ? WHERE id=?", (r["qty"], r["item_id"]))
    return api_get_bill({"id": sid})


def api_get_bill(a):
    if a.get("id"):
        s = row("SELECT * FROM sales WHERE id=?", (a["id"],))
    else:
        s = row("SELECT * FROM sales WHERE bill_no=? COLLATE NOCASE", (str(a.get("bill_no") or "").strip(),))
    if not s:
        raise ApiError("Bill not found")
    s["customer"] = row("SELECT * FROM customers WHERE id=?", (s["customer_id"],))
    s["lines"] = []
    for ln in rows("SELECT * FROM sale_lines WHERE sale_id=? ORDER BY id", (s["id"],)):
        it = get_item(ln["item_id"])
        ln.update({"barcode": it["barcode"], "name": it["name"], "size": it["size"], "unit": it["unit"], "hsn": it["hsn"]})
        if ln["return_of"]:
            ref = row("SELECT s.bill_no FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id WHERE sl.id=?", (ln["return_of"],))
            ln["ref_bill"] = ref["bill_no"] if ref else ""
        else:
            ln["returned"] = DB.execute("""SELECT COALESCE(SUM(-sl.qty),0) FROM sale_lines sl JOIN sales x ON x.id=sl.sale_id
                                           WHERE sl.return_of=? AND x.status='ACTIVE'""", (ln["id"],)).fetchone()[0]
        s["lines"].append(ln)
    return s


def api_list_bills(a):
    w, args = date_filter("s.date", a)
    q = str(a.get("q") or "").strip()
    if q:
        w.append("(s.bill_no LIKE ? OR c.mobile LIKE ? OR c.name LIKE ?)")
        args += [f"%{q}%"] * 3
    where = ("WHERE " + " AND ".join(w)) if w else ""
    return rows(f"""SELECT s.*, c.name AS customer, c.mobile, c.city,
                    (SELECT COALESCE(SUM(qty),0) FROM sale_lines WHERE sale_id=s.id AND qty>0) AS qty
                    FROM sales s LEFT JOIN customers c ON c.id=s.customer_id {where}
                    ORDER BY s.id DESC LIMIT 1000""", args)


def api_cancel_bill(a):
    s = api_get_bill(a)
    if s["status"] != "ACTIVE":
        raise ApiError("Bill is already cancelled")
    for ln in s["lines"]:
        if not ln["return_of"] and ln.get("returned"):
            raise ApiError("Items of this bill were returned on another bill - cancel that bill first")
    for ln in s["lines"]:
        DB.execute("UPDATE items SET stock = stock + ? WHERE id=?", (ln["qty"], ln["item_id"]))
    DB.execute("UPDATE sales SET status='CANCELLED', notes=? WHERE id=?",
               ((s["notes"] + " | " if s["notes"] else "") + "Cancelled " + now(), s["id"]))
    return api_get_bill({"id": s["id"]})


# --------------------------------------------------------------------------
# API: dashboard
# --------------------------------------------------------------------------
def api_dashboard(a):
    st = get_settings()
    t = today()
    month_start = t[:8] + "01"
    d30 = (today_date() - datetime.timedelta(days=29)).isoformat()
    d14 = (today_date() - datetime.timedelta(days=13)).isoformat()
    act = "status='ACTIVE'"

    def agg(where, args):
        return row(f"SELECT COUNT(*) AS bills, COALESCE(SUM(net),0) AS sales, COALESCE(SUM(profit),0) AS profit "
                   f"FROM sales WHERE {act} AND {where}", args)

    stock = row("""SELECT COALESCE(SUM(CASE WHEN unit!='MTR' THEN stock END),0) AS pcs,
                   COALESCE(SUM(CASE WHEN unit='MTR' THEN stock END),0) AS mtr,
                   COALESCE(SUM(stock*cost),0) AS value_cost, COALESCE(SUM(stock*mrp),0) AS value_mrp
                   FROM items WHERE stock > 0""")
    dm = float(st.get("default_moq") or 0)
    low = rows("""SELECT c.name AS category, s.name AS subcategory, i.size, SUM(i.stock) AS stock,
                  COALESCE(s.moq, ?) AS moq, MAX(i.unit) AS unit
                  FROM items i JOIN subcategories s ON s.id=i.subcategory_id JOIN categories c ON c.id=s.category_id
                  GROUP BY s.id, i.size HAVING SUM(i.stock) < COALESCE(s.moq, ?)
                  ORDER BY SUM(i.stock) * 1.0 / MAX(COALESCE(s.moq, ?), 1), c.name, s.name""", (dm, dm, dm))
    top_sub = rows(f"""SELECT c.name AS category, s.name AS subcategory, SUM(sl.qty) AS qty, SUM(sl.amount) AS amount,
                       SUM(sl.profit) AS profit
                       FROM sale_lines sl JOIN sales x ON x.id=sl.sale_id JOIN items i ON i.id=sl.item_id
                       JOIN subcategories s ON s.id=i.subcategory_id JOIN categories c ON c.id=s.category_id
                       WHERE x.{act} AND x.date >= ? GROUP BY s.id HAVING SUM(sl.qty) > 0
                       ORDER BY amount DESC LIMIT 8""", (d30,))
    top_items = rows(f"""SELECT s.name AS subcategory, b.name AS brand, i.description, i.size, SUM(sl.qty) AS qty,
                         SUM(sl.amount) AS amount
                         FROM sale_lines sl JOIN sales x ON x.id=sl.sale_id JOIN items i ON i.id=sl.item_id
                         JOIN subcategories s ON s.id=i.subcategory_id LEFT JOIN brands b ON b.id=i.brand_id
                         WHERE x.{act} AND x.date >= ?
                         GROUP BY s.id, i.brand_id, i.description, i.size HAVING SUM(sl.qty) > 0
                         ORDER BY qty DESC, amount DESC LIMIT 10""", (d30,))
    daily = {r["date"]: r for r in rows(f"""SELECT date, SUM(net) AS sales, SUM(profit) AS profit, COUNT(*) AS bills
                                            FROM sales WHERE {act} AND date >= ? GROUP BY date""", (d14,))}
    trend = []
    for k in range(13, -1, -1):
        d = (today_date() - datetime.timedelta(days=k)).isoformat()
        r = daily.get(d) or {}
        trend.append({"date": d, "sales": r.get("sales") or 0, "profit": r.get("profit") or 0, "bills": r.get("bills") or 0})
    by_cat = rows("""SELECT c.name AS category, COALESCE(SUM(CASE WHEN i.stock>0 THEN i.stock END),0) AS qty,
                     COALESCE(SUM(CASE WHEN i.stock>0 THEN i.stock*i.cost END),0) AS value_cost,
                     COALESCE(SUM(CASE WHEN i.stock>0 THEN i.stock*i.mrp END),0) AS value_mrp
                     FROM categories c LEFT JOIN subcategories s ON s.category_id=c.id
                     LEFT JOIN items i ON i.subcategory_id=s.id GROUP BY c.id ORDER BY c.name""")
    top_customers = rows(f"""SELECT c.name, c.mobile, c.city, COUNT(*) AS bills, SUM(x.net) AS amount
                             FROM sales x JOIN customers c ON c.id=x.customer_id WHERE x.{act} AND x.date >= ?
                             GROUP BY c.id ORDER BY amount DESC LIMIT 5""", (d30,))
    pay_today = row(f"""SELECT COALESCE(SUM(pay_cash),0) AS cash, COALESCE(SUM(pay_upi),0) AS upi,
                        COALESCE(SUM(pay_card),0) AS card, COALESCE(SUM(pay_cheque),0) AS cheque
                        FROM sales WHERE {act} AND date=?""", (t,))
    recent = rows("""SELECT s.id, s.bill_no, s.date, s.net, s.profit, s.status, c.name AS customer, c.city
                     FROM sales s LEFT JOIN customers c ON c.id=s.customer_id ORDER BY s.id DESC LIMIT 8""")
    exp_today = DB.execute("SELECT COALESCE(SUM(amount),0) FROM expenses WHERE date=?", (t,)).fetchone()[0]
    exp_month = DB.execute("SELECT COALESCE(SUM(amount),0) FROM expenses WHERE date>=?", (month_start,)).fetchone()[0]
    cash = cash_book({"from": t, "to": t})
    return {"today": agg("date=?", (t,)), "month": agg("date>=?", (month_start,)), "stock": stock, "low_stock": low,
            "expenses_today": exp_today, "expenses_month": exp_month, "cash_today": cash["days"][-1] if cash["days"] else None,
            "cash_in_hand": cash["closing"],
            "top_sub": top_sub, "top_items": top_items, "trend": trend, "by_category": by_cat,
            "top_customers": top_customers, "pay_today": pay_today, "recent": recent,
            "setup_incomplete": not st.get("shop_gstin")}


# --------------------------------------------------------------------------
# API: expenses & cash book
# --------------------------------------------------------------------------
def api_save_expense_head(a):
    a["name"] = _req(a, "name", "Expense head")
    return _save("expense_heads", a, ["name"])


def api_delete_expense_head(a):
    return _delete("expense_heads", a["id"], [
        ("SELECT COUNT(*) FROM expenses WHERE head_id=?", "This head has expenses recorded and cannot be deleted")])


PAY_MODES = ("CASH", "UPI", "BANK", "CARD", "CHEQUE")


def api_save_expense(a):
    if not a.get("head_id") or not row("SELECT id FROM expense_heads WHERE id=?", (a["head_id"],)):
        raise ApiError("Select an expense head")
    amount = num(a.get("amount"))
    if amount <= 0:
        raise ApiError("Amount must be more than 0")
    paid_by = str(a.get("paid_by") or "CASH").upper()
    if paid_by not in PAY_MODES:
        raise ApiError("Invalid payment mode")
    vals = (a.get("date") or today(), a["head_id"], amount, paid_by, str(a.get("paid_to") or "").strip(),
            str(a.get("note") or "").strip())
    if a.get("id"):
        DB.execute("UPDATE expenses SET date=?, head_id=?, amount=?, paid_by=?, paid_to=?, note=? WHERE id=?", (*vals, a["id"]))
        return {"id": a["id"]}
    return {"id": DB.execute("INSERT INTO expenses(date, head_id, amount, paid_by, paid_to, note, created_at) VALUES(?,?,?,?,?,?,?)",
                             (*vals, now())).lastrowid}


def api_delete_expense(a):
    DB.execute("DELETE FROM expenses WHERE id=?", (a["id"],))
    return {}


def api_list_expenses(a):
    w, args = date_filter("e.date", a)
    if a.get("head_id"):
        w.append("e.head_id=?")
        args.append(a["head_id"])
    if a.get("paid_by"):
        w.append("e.paid_by=?")
        args.append(a["paid_by"])
    where = ("WHERE " + " AND ".join(w)) if w else ""
    return rows(f"""SELECT e.*, h.name AS head FROM expenses e JOIN expense_heads h ON h.id=e.head_id {where}
                    ORDER BY e.date DESC, e.id DESC LIMIT 3000""", args)


def api_save_cash_entry(a):
    direction = str(a.get("direction") or "").upper()
    if direction not in ("IN", "OUT"):
        raise ApiError("Choose Cash In or Cash Out")
    amount = num(a.get("amount"))
    if amount <= 0:
        raise ApiError("Amount must be more than 0")
    reason = _req(a, "reason", "Reason")
    vals = (a.get("date") or today(), direction, reason, amount, str(a.get("note") or "").strip())
    if a.get("id"):
        DB.execute("UPDATE cash_entries SET date=?, direction=?, reason=?, amount=?, note=? WHERE id=?", (*vals, a["id"]))
        return {"id": a["id"]}
    return {"id": DB.execute("INSERT INTO cash_entries(date, direction, reason, amount, note, created_at) VALUES(?,?,?,?,?,?)",
                             (*vals, now())).lastrowid}


def api_delete_cash_entry(a):
    DB.execute("DELETE FROM cash_entries WHERE id=?", (a["id"],))
    return {}


def api_list_cash_entries(a):
    w, args = date_filter("date", a)
    where = ("WHERE " + " AND ".join(w)) if w else ""
    return rows(f"SELECT * FROM cash_entries {where} ORDER BY date DESC, id DESC LIMIT 3000", args)


def cash_book(a):
    """Day-wise cash book. Cash in hand = opening cash (Settings) + cash sales (net of cash refunds)
    - cash expenses + cash added - cash taken out, counted from the opening-cash date."""
    st = get_settings()
    start = st.get("opening_cash_date") or "0000-00-00"
    opening_cash = float(st.get("opening_cash") or 0)
    frm = max(a.get("from") or start, start)
    to = a.get("to") or today()

    def flows(where, args):
        q = lambda sql: DB.execute(sql.format(w=where), args).fetchone()[0] or 0  # noqa: E731
        return (q("SELECT SUM(pay_cash) FROM sales WHERE status='ACTIVE' AND {w}"),
                q("SELECT SUM(amount) FROM expenses WHERE paid_by='CASH' AND {w}"),
                q("SELECT SUM(amount) FROM cash_entries WHERE direction='IN' AND {w}"),
                q("SELECT SUM(amount) FROM cash_entries WHERE direction='OUT' AND {w}"))

    s0, e0, i0, o0 = flows("date >= ? AND date < ?", (start, frm))
    opening = r2(opening_cash + s0 - e0 + i0 - o0)
    per = {}
    for tbl, col, sql in (
            ("sales", "sales", "SELECT date, SUM(pay_cash) FROM sales WHERE status='ACTIVE' AND date BETWEEN ? AND ? GROUP BY date"),
            ("expenses", "expenses", "SELECT date, SUM(amount) FROM expenses WHERE paid_by='CASH' AND date BETWEEN ? AND ? GROUP BY date"),
            ("in", "cash_in", "SELECT date, SUM(amount) FROM cash_entries WHERE direction='IN' AND date BETWEEN ? AND ? GROUP BY date"),
            ("out", "cash_out", "SELECT date, SUM(amount) FROM cash_entries WHERE direction='OUT' AND date BETWEEN ? AND ? GROUP BY date")):
        for d, v in DB.execute(sql, (frm, to)).fetchall():
            per.setdefault(d, {"sales": 0, "expenses": 0, "cash_in": 0, "cash_out": 0})[col] = v or 0
    days, bal = [], opening
    d = datetime.date.fromisoformat(frm) if frm != "0000-00-00" else None
    if d is None:  # no opening date: list only days with activity
        dates = sorted(per)
    else:
        end = datetime.date.fromisoformat(to)
        dates = []
        while d <= end:
            dates.append(d.isoformat())
            d += datetime.timedelta(days=1)
    for day in dates:
        f = per.get(day, {"sales": 0, "expenses": 0, "cash_in": 0, "cash_out": 0})
        close = r2(bal + f["sales"] - f["expenses"] + f["cash_in"] - f["cash_out"])
        days.append({"date": day, "opening": bal, "cash_sales": r2(f["sales"]), "cash_expenses": r2(f["expenses"]),
                     "cash_in": r2(f["cash_in"]), "cash_out": r2(f["cash_out"]), "closing": close})
        bal = close
    return {"opening": opening, "closing": bal, "days": days, "opening_cash_date": st.get("opening_cash_date") or ""}


def api_cash_book(a):
    return cash_book(a)


def api_low_stock_details(a):
    """Low-stock groups (sub-category + size below MOQ) with the individual items in each."""
    dm = float(get_settings().get("default_moq") or 0)
    groups = rows("""SELECT s.id AS subcategory_id, c.name AS category, s.name AS subcategory, i.size,
                     SUM(i.stock) AS stock, COALESCE(s.moq, ?) AS moq, MAX(i.unit) AS unit
                     FROM items i JOIN subcategories s ON s.id=i.subcategory_id JOIN categories c ON c.id=s.category_id
                     GROUP BY s.id, i.size HAVING SUM(i.stock) < COALESCE(s.moq, ?)
                     ORDER BY SUM(i.stock) * 1.0 / MAX(COALESCE(s.moq, ?), 1), c.name, s.name, i.size""", (dm, dm, dm))
    for g in groups:
        g["reorder"] = max(0.0, g["moq"] - g["stock"])
        g["items"] = rows("""SELECT i.id, i.barcode, i.description, b.name AS brand, sp.name AS supplier, sp.phone AS supplier_phone,
                             i.stock, i.cost, i.mrp, substr(i.created_at,1,10) AS inward_date,
                             (SELECT COALESCE(SUM(sl.qty),0) FROM sale_lines sl JOIN sales x ON x.id=sl.sale_id
                              WHERE sl.item_id=i.id AND x.status='ACTIVE') AS sold,
                             (SELECT MAX(x.date) FROM sale_lines sl JOIN sales x ON x.id=sl.sale_id
                              WHERE sl.item_id=i.id AND x.status='ACTIVE' AND sl.qty>0) AS last_sold
                             FROM items i LEFT JOIN brands b ON b.id=i.brand_id LEFT JOIN suppliers sp ON sp.id=i.supplier_id
                             WHERE i.subcategory_id=? AND i.size=? ORDER BY i.created_at DESC""",
                          (g["subcategory_id"], g["size"]))
    return groups


# --------------------------------------------------------------------------
# API: reports
# --------------------------------------------------------------------------
def C(key, label, t="text"):
    return {"key": key, "label": label, "type": t}


def _item_filters(a, w, args, item_alias="i", sub_alias="s"):
    if a.get("category_id"):
        w.append(f"{sub_alias}.category_id=?")
        args.append(a["category_id"])
    if a.get("subcategory_id"):
        w.append(f"{sub_alias}.id=?")
        args.append(a["subcategory_id"])
    if a.get("supplier_id"):
        w.append(f"{item_alias}.supplier_id=?")
        args.append(a["supplier_id"])


SALE_LINE_JOIN = """FROM sale_lines sl JOIN sales x ON x.id=sl.sale_id JOIN items i ON i.id=sl.item_id
  JOIN subcategories s ON s.id=i.subcategory_id JOIN categories c ON c.id=s.category_id
  LEFT JOIN brands b ON b.id=i.brand_id LEFT JOIN suppliers sp ON sp.id=i.supplier_id
  LEFT JOIN customers cu ON cu.id=x.customer_id"""


def _sl_where(a):
    w, args = date_filter("x.date", a)
    w.append("x.status='ACTIVE'")
    _item_filters(a, w, args)
    return "WHERE " + " AND ".join(w), args


def report(a):
    name = a.get("name")
    dm = float(get_settings().get("default_moq") or 0)

    if name == "sales_register":
        w, args = date_filter("x.date", a)
        if not a.get("include_cancelled"):
            w.append("x.status='ACTIVE'")
        where = ("WHERE " + " AND ".join(w)) if w else ""
        cols = [C("date", "Date", "date"), C("bill_no", "Bill No"), C("customer", "Customer"), C("mobile", "Mobile"),
                C("city", "City"), C("qty", "Qty", "num"), C("gross", "Gross", "money"),
                C("discount", "Discount", "money"), C("returns", "Returns", "money"), C("taxable", "Taxable", "money"),
                C("gst", "GST", "money"), C("net", "Net", "money"), C("cost", "Cost", "money"),
                C("profit", "Profit", "money"), C("pay_cash", "Cash", "money"), C("pay_upi", "UPI", "money"),
                C("pay_card", "Card", "money"), C("pay_cheque", "Cheque", "money"), C("pay_ref", "Pay Ref"),
                C("status", "Status")]
        data = rows(f"""SELECT x.date, x.bill_no, cu.name AS customer, cu.mobile, cu.city,
                        (SELECT COALESCE(SUM(qty),0) FROM sale_lines WHERE sale_id=x.id AND qty>0) AS qty,
                        x.gross, x.line_discount + x.bill_discount AS discount, x.returns, x.taxable, x.gst, x.net,
                        x.cost, x.profit, x.pay_cash, x.pay_upi, x.pay_card, x.pay_cheque, x.pay_ref, x.status
                        FROM sales x LEFT JOIN customers cu ON cu.id=x.customer_id {where} ORDER BY x.date, x.id""", args)
        return cols, data

    if name == "sales_items":
        where, args = _sl_where(a)
        cols = [C("date", "Date", "date"), C("bill_no", "Bill No"), C("customer", "Customer"), C("barcode", "Barcode"),
                C("category", "Category"), C("subcategory", "Sub-category"), C("brand", "Brand"),
                C("description", "Description"), C("size", "Size"), C("supplier", "Supplier"), C("qty", "Qty", "num"),
                C("mrp", "MRP", "money"), C("disc_pct", "Disc %", "num"), C("amount", "Amount", "money"),
                C("gst_rate", "GST %", "num"), C("taxable", "Taxable", "money"), C("cost", "Cost", "money"),
                C("profit", "Profit", "money")]
        data = rows(f"""SELECT x.date, x.bill_no, cu.name AS customer, i.barcode, c.name AS category, s.name AS subcategory,
                        b.name AS brand, i.description, i.size, sp.name AS supplier, sl.qty, sl.mrp, sl.disc_pct,
                        sl.amount, sl.gst_rate, sl.taxable, sl.cost, sl.profit
                        {SALE_LINE_JOIN} {where} ORDER BY x.date, x.id, sl.id""", args)
        return cols, data

    if name == "sales_by_category":
        where, args = _sl_where(a)
        cols = [C("category", "Category"), C("subcategory", "Sub-category"), C("qty", "Qty Sold", "num"),
                C("amount", "Sales", "money"), C("taxable", "Taxable", "money"), C("cost", "Cost", "money"),
                C("profit", "Profit", "money"), C("margin", "Margin %", "num")]
        data = rows(f"""SELECT c.name AS category, s.name AS subcategory, SUM(sl.qty) AS qty, SUM(sl.amount) AS amount,
                        SUM(sl.taxable) AS taxable, SUM(sl.cost) AS cost, SUM(sl.profit) AS profit,
                        ROUND(CASE WHEN SUM(sl.taxable)!=0 THEN SUM(sl.profit)*100.0/SUM(sl.taxable) END, 1) AS margin
                        {SALE_LINE_JOIN} {where} GROUP BY s.id ORDER BY amount DESC""", args)
        return cols, data

    if name == "sales_by_size":
        where, args = _sl_where(a)
        cols = [C("category", "Category"), C("subcategory", "Sub-category"), C("size", "Size"),
                C("qty", "Qty Sold", "num"), C("amount", "Sales", "money"), C("profit", "Profit", "money")]
        data = rows(f"""SELECT c.name AS category, s.name AS subcategory, i.size, SUM(sl.qty) AS qty,
                        SUM(sl.amount) AS amount, SUM(sl.profit) AS profit
                        {SALE_LINE_JOIN} {where} GROUP BY s.id, i.size ORDER BY c.name, s.name, qty DESC""", args)
        return cols, data

    if name == "sales_by_supplier":
        where, args = _sl_where(a)
        cols = [C("supplier", "Supplier"), C("qty", "Qty Sold", "num"), C("amount", "Sales", "money"),
                C("cost", "Cost", "money"), C("profit", "Profit", "money"), C("margin", "Margin %", "num")]
        data = rows(f"""SELECT COALESCE(sp.name,'-') AS supplier, SUM(sl.qty) AS qty, SUM(sl.amount) AS amount,
                        SUM(sl.cost) AS cost, SUM(sl.profit) AS profit,
                        ROUND(CASE WHEN SUM(sl.taxable)!=0 THEN SUM(sl.profit)*100.0/SUM(sl.taxable) END, 1) AS margin
                        {SALE_LINE_JOIN} {where} GROUP BY sp.id ORDER BY amount DESC""", args)
        return cols, data

    if name == "sales_by_day":
        w, args = date_filter("date", a)
        w.append("status='ACTIVE'")
        cols = [C("date", "Date", "date"), C("bills", "Bills", "num"), C("net", "Net Sales", "money"),
                C("discount", "Discount", "money"), C("gst", "GST", "money"), C("profit", "Profit", "money"),
                C("cash", "Cash", "money"), C("upi", "UPI", "money"), C("card", "Card", "money"),
                C("cheque", "Cheque", "money")]
        data = rows(f"""SELECT date, COUNT(*) AS bills, SUM(net) AS net, SUM(line_discount+bill_discount) AS discount,
                        SUM(gst) AS gst, SUM(profit) AS profit, SUM(pay_cash) AS cash, SUM(pay_upi) AS upi,
                        SUM(pay_card) AS card, SUM(pay_cheque) AS cheque FROM sales WHERE {' AND '.join(w)} GROUP BY date ORDER BY date""", args)
        return cols, data

    if name == "sales_by_month":
        w, args = date_filter("date", a)
        w.append("status='ACTIVE'")
        cols = [C("month", "Month"), C("bills", "Bills", "num"), C("net", "Net Sales", "money"),
                C("gst", "GST", "money"), C("cost", "Cost", "money"), C("profit", "Profit", "money")]
        data = rows(f"""SELECT substr(date,1,7) AS month, COUNT(*) AS bills, SUM(net) AS net, SUM(gst) AS gst,
                        SUM(cost) AS cost, SUM(profit) AS profit FROM sales WHERE {' AND '.join(w)}
                        GROUP BY month ORDER BY month""", args)
        return cols, data

    if name == "gst_summary":
        w, args = date_filter("x.date", a)
        w.append("x.status='ACTIVE'")
        cols = [C("hsn", "HSN"), C("gst_rate", "GST %", "num"), C("qty", "Qty", "num"), C("taxable", "Taxable", "money"),
                C("cgst", "CGST", "money"), C("sgst", "SGST", "money"), C("gst", "Total GST", "money"),
                C("amount", "Invoice Value", "money")]
        data = rows(f"""SELECT s.hsn, sl.gst_rate, SUM(sl.qty) AS qty, SUM(sl.taxable) AS taxable,
                        ROUND(SUM(sl.gst)/2, 2) AS cgst, SUM(sl.gst) - ROUND(SUM(sl.gst)/2, 2) AS sgst,
                        SUM(sl.gst) AS gst, SUM(sl.amount) AS amount
                        FROM sale_lines sl JOIN sales x ON x.id=sl.sale_id JOIN items i ON i.id=sl.item_id
                        JOIN subcategories s ON s.id=i.subcategory_id WHERE {' AND '.join(w)}
                        GROUP BY s.hsn, sl.gst_rate ORDER BY s.hsn, sl.gst_rate""", args)
        return cols, data

    if name == "customer_sales":
        w, args = date_filter("x.date", a)
        w.append("x.status='ACTIVE'")
        cols = [C("name", "Customer"), C("mobile", "Mobile"), C("city", "City"), C("bills", "Bills", "num"),
                C("amount", "Purchases", "money"), C("profit", "Profit", "money"), C("last", "Last Visit", "date")]
        data = rows(f"""SELECT cu.name, cu.mobile, cu.city, COUNT(*) AS bills, SUM(x.net) AS amount,
                        SUM(x.profit) AS profit, MAX(x.date) AS last
                        FROM sales x JOIN customers cu ON cu.id=x.customer_id WHERE {' AND '.join(w)}
                        GROUP BY cu.id ORDER BY amount DESC""", args)
        return cols, data

    if name == "customer_list":
        cols = [C("name", "Customer"), C("mobile", "Mobile"), C("city", "City"), C("since", "Customer Since", "date"),
                C("bills", "Bills", "num"), C("qty", "Items Bought", "num"), C("amount", "Total Purchases", "money"),
                C("last", "Last Visit", "date")]
        data = rows("""SELECT cu.name, cu.mobile, cu.city, substr(cu.created_at,1,10) AS since,
                       COUNT(x.id) AS bills, COALESCE(SUM(x.net),0) AS amount, MAX(x.date) AS last,
                       COALESCE((SELECT SUM(sl.qty) FROM sale_lines sl JOIN sales y ON y.id=sl.sale_id
                                 WHERE y.customer_id=cu.id AND y.status='ACTIVE'),0) AS qty
                       FROM customers cu LEFT JOIN sales x ON x.customer_id=cu.id AND x.status='ACTIVE'
                       GROUP BY cu.id ORDER BY cu.name""")
        return cols, data

    if name == "city_sales":
        w, args = date_filter("x.date", a)
        w.append("x.status='ACTIVE'")
        cols = [C("city", "City"), C("customers", "Customers", "num"), C("bills", "Bills", "num"),
                C("amount", "Sales", "money"), C("profit", "Profit", "money")]
        data = rows(f"""SELECT COALESCE(NULLIF(cu.city,''),'-') AS city, COUNT(DISTINCT cu.id) AS customers,
                        COUNT(*) AS bills, SUM(x.net) AS amount, SUM(x.profit) AS profit
                        FROM sales x JOIN customers cu ON cu.id=x.customer_id WHERE {' AND '.join(w)}
                        GROUP BY lower(cu.city) ORDER BY amount DESC""", args)
        return cols, data

    if name == "returns":
        w, args = date_filter("x.date", a)
        w += ["x.status='ACTIVE'", "sl.qty < 0"]
        cols = [C("date", "Date", "date"), C("bill_no", "Bill No"), C("ref_bill", "Original Bill"),
                C("customer", "Customer"), C("barcode", "Barcode"), C("subcategory", "Sub-category"),
                C("description", "Description"), C("size", "Size"), C("qty", "Qty", "num"), C("amount", "Amount", "money")]
        data = rows(f"""SELECT x.date, x.bill_no, ox.bill_no AS ref_bill, cu.name AS customer, i.barcode,
                        s.name AS subcategory, i.description, i.size, -sl.qty AS qty, -sl.amount AS amount
                        {SALE_LINE_JOIN} LEFT JOIN sale_lines ol ON ol.id=sl.return_of LEFT JOIN sales ox ON ox.id=ol.sale_id
                        WHERE {' AND '.join(w)} ORDER BY x.date, x.id""", args)
        return cols, data

    if name == "purchase_register":
        w, args = date_filter("p.date", a)
        if a.get("supplier_id"):
            w.append("p.supplier_id=?")
            args.append(a["supplier_id"])
        where = ("WHERE " + " AND ".join(w)) if w else ""
        cols = [C("date", "Date", "date"), C("inward_no", "Inward No"), C("supplier", "Supplier"),
                C("supplier_bill_no", "Supplier Bill"), C("lines", "Lines", "num"), C("total_qty", "Qty", "num"),
                C("total_cost", "Cost Value", "money"), C("gst_amount", "Purchase GST", "money"),
                C("bill_total", "Bill Total", "money"), C("mrp_value", "MRP Value", "money")]
        data = rows(f"""SELECT p.date, p.inward_no, sp.name AS supplier, p.supplier_bill_no,
                        (SELECT COUNT(*) FROM purchase_lines WHERE purchase_id=p.id) AS lines, p.total_qty, p.total_cost,
                        p.gst_amount, p.total_cost + p.gst_amount AS bill_total,
                        (SELECT COALESCE(SUM(qty*mrp),0) FROM purchase_lines WHERE purchase_id=p.id) AS mrp_value
                        FROM purchases p JOIN suppliers sp ON sp.id=p.supplier_id {where} ORDER BY p.date, p.id""", args)
        return cols, data

    if name == "purchase_items":
        w, args = date_filter("p.date", a)
        _item_filters(a, w, args)
        where = ("WHERE " + " AND ".join(w)) if w else ""
        cols = [C("date", "Date", "date"), C("inward_no", "Inward No"), C("supplier", "Supplier"),
                C("barcode", "Barcode"), C("category", "Category"), C("subcategory", "Sub-category"),
                C("brand", "Brand"), C("description", "Description"), C("size", "Size"), C("qty", "Qty", "num"),
                C("cost", "Cost", "money"), C("markup", "Markup %", "num"), C("mrp", "MRP", "money"),
                C("value", "Cost Value", "money"), C("stock", "In Stock", "num")]
        data = rows(f"""SELECT p.date, p.inward_no, sp.name AS supplier, i.barcode, c.name AS category,
                        s.name AS subcategory, b.name AS brand, i.description, i.size, pl.qty, pl.cost, pl.markup,
                        pl.mrp, pl.qty*pl.cost AS value, i.stock
                        FROM purchase_lines pl JOIN purchases p ON p.id=pl.purchase_id JOIN items i ON i.id=pl.item_id
                        JOIN subcategories s ON s.id=i.subcategory_id JOIN categories c ON c.id=s.category_id
                        LEFT JOIN brands b ON b.id=i.brand_id JOIN suppliers sp ON sp.id=p.supplier_id
                        {where} ORDER BY p.date, p.id, pl.id""", args)
        return cols, data

    if name == "purchase_by_supplier":
        w, args = date_filter("p.date", a)
        _item_filters(a, w, args)
        where = ("WHERE " + " AND ".join(w)) if w else ""
        cols = [C("supplier", "Supplier"), C("inwards", "Inwards", "num"), C("qty", "Qty", "num"),
                C("value", "Cost Value", "money"), C("mrp_value", "MRP Value", "money"),
                C("in_stock", "Still In Stock", "num")]
        data = rows(f"""SELECT sp.name AS supplier, COUNT(DISTINCT p.id) AS inwards, SUM(pl.qty) AS qty,
                        SUM(pl.qty*pl.cost) AS value, SUM(pl.qty*pl.mrp) AS mrp_value, SUM(i.stock) AS in_stock
                        FROM purchase_lines pl JOIN purchases p ON p.id=pl.purchase_id JOIN items i ON i.id=pl.item_id
                        JOIN subcategories s ON s.id=i.subcategory_id JOIN suppliers sp ON sp.id=p.supplier_id
                        {where} GROUP BY sp.id ORDER BY value DESC""", args)
        return cols, data

    if name == "purchase_by_category":
        w, args = date_filter("p.date", a)
        _item_filters(a, w, args)
        where = ("WHERE " + " AND ".join(w)) if w else ""
        cols = [C("category", "Category"), C("subcategory", "Sub-category"), C("qty", "Qty", "num"),
                C("value", "Cost Value", "money"), C("mrp_value", "MRP Value", "money"),
                C("avg_markup", "Avg Markup %", "num")]
        data = rows(f"""SELECT c.name AS category, s.name AS subcategory, SUM(pl.qty) AS qty, SUM(pl.qty*pl.cost) AS value,
                        SUM(pl.qty*pl.mrp) AS mrp_value,
                        ROUND((SUM(pl.qty*pl.mrp)/SUM(pl.qty*pl.cost) - 1) * 100, 1) AS avg_markup
                        FROM purchase_lines pl JOIN purchases p ON p.id=pl.purchase_id JOIN items i ON i.id=pl.item_id
                        JOIN subcategories s ON s.id=i.subcategory_id JOIN categories c ON c.id=s.category_id
                        {where} GROUP BY s.id ORDER BY c.name, s.name""", args)
        return cols, data

    if name == "stock":
        w, args = [], []
        _item_filters(a, w, args)
        if not a.get("include_zero"):
            w.append("i.stock != 0")
        where = ("WHERE " + " AND ".join(w)) if w else ""
        cols = [C("barcode", "Barcode"), C("category", "Category"), C("subcategory", "Sub-category"),
                C("brand", "Brand"), C("description", "Description"), C("size", "Size"), C("supplier", "Supplier"),
                C("inward_date", "Inward Date", "date"), C("stock", "Stock", "num"), C("unit", "Unit"),
                C("cost", "Cost", "money"), C("mrp", "MRP", "money"), C("value_cost", "Value @Cost", "money"),
                C("value_mrp", "Value @MRP", "money")]
        data = rows(f"""SELECT i.barcode, c.name AS category, s.name AS subcategory, b.name AS brand, i.description,
                        i.size, sp.name AS supplier, substr(i.created_at,1,10) AS inward_date, i.stock, i.unit, i.cost,
                        i.mrp, i.stock*i.cost AS value_cost, i.stock*i.mrp AS value_mrp
                        FROM items i JOIN subcategories s ON s.id=i.subcategory_id JOIN categories c ON c.id=s.category_id
                        LEFT JOIN brands b ON b.id=i.brand_id LEFT JOIN suppliers sp ON sp.id=i.supplier_id
                        {where} ORDER BY c.name, s.name, i.description, i.size""", args)
        return cols, data

    if name == "stock_summary":
        w, args = [], []
        _item_filters(a, w, args)
        where = ("WHERE " + " AND ".join(w)) if w else ""
        cols = [C("category", "Category"), C("subcategory", "Sub-category"), C("size", "Size"),
                C("stock", "Stock", "num"), C("moq", "MOQ", "num"), C("value_cost", "Value @Cost", "money"),
                C("value_mrp", "Value @MRP", "money"), C("status", "Status")]
        data = rows(f"""SELECT c.name AS category, s.name AS subcategory, i.size, SUM(i.stock) AS stock,
                        COALESCE(s.moq, ?) AS moq, SUM(CASE WHEN i.stock>0 THEN i.stock*i.cost ELSE 0 END) AS value_cost,
                        SUM(CASE WHEN i.stock>0 THEN i.stock*i.mrp ELSE 0 END) AS value_mrp,
                        CASE WHEN SUM(i.stock) <= 0 THEN 'OUT OF STOCK'
                             WHEN SUM(i.stock) < COALESCE(s.moq, ?) THEN 'LOW' ELSE 'OK' END AS status
                        FROM items i JOIN subcategories s ON s.id=i.subcategory_id JOIN categories c ON c.id=s.category_id
                        {where} GROUP BY s.id, i.size ORDER BY c.name, s.name, i.size""", [dm, dm] + args)
        return cols, data

    if name == "low_stock":
        cols, data = report({**a, "name": "stock_summary"})
        return cols, [r for r in data if r["status"] != "OK"]

    if name == "expense_register":
        w, args = date_filter("e.date", a)
        if a.get("head_id"):
            w.append("e.head_id=?")
            args.append(a["head_id"])
        where = ("WHERE " + " AND ".join(w)) if w else ""
        cols = [C("date", "Date", "date"), C("head", "Expense Head"), C("paid_to", "Paid To"), C("paid_by", "Paid By"),
                C("note", "Note"), C("amount", "Amount", "money")]
        data = rows(f"""SELECT e.date, h.name AS head, e.paid_to, e.paid_by, e.note, e.amount
                        FROM expenses e JOIN expense_heads h ON h.id=e.head_id {where} ORDER BY e.date, e.id""", args)
        return cols, data

    if name == "expense_by_head":
        w, args = date_filter("e.date", a)
        where = ("WHERE " + " AND ".join(w)) if w else ""
        cols = [C("head", "Expense Head"), C("entries", "Entries", "num"), C("cash", "Cash", "money"),
                C("other", "UPI / Bank / Card", "money"), C("amount", "Total", "money")]
        data = rows(f"""SELECT h.name AS head, COUNT(*) AS entries,
                        SUM(CASE WHEN e.paid_by='CASH' THEN e.amount ELSE 0 END) AS cash,
                        SUM(CASE WHEN e.paid_by!='CASH' THEN e.amount ELSE 0 END) AS other, SUM(e.amount) AS amount
                        FROM expenses e JOIN expense_heads h ON h.id=e.head_id {where} GROUP BY h.id ORDER BY amount DESC""", args)
        return cols, data

    if name == "cash_book":
        cb = cash_book(a)
        cols = [C("date", "Date", "date"), C("opening", "Opening Cash", "money"), C("cash_sales", "Cash Sales (net)", "money"),
                C("cash_in", "Cash Added", "money"), C("cash_expenses", "Cash Expenses", "money"),
                C("cash_out", "Cash Taken Out", "money"), C("closing", "Closing Cash", "money")]
        return cols, cb["days"]

    if name == "cash_entries":
        w, args = date_filter("date", a)
        where = ("WHERE " + " AND ".join(w)) if w else ""
        cols = [C("date", "Date", "date"), C("direction", "In / Out"), C("reason", "Reason"), C("note", "Note"),
                C("amount", "Amount", "money")]
        return cols, rows(f"SELECT date, direction, reason, note, amount FROM cash_entries {where} ORDER BY date, id", args)

    if name == "profit_loss":
        w, args = date_filter("date", a)
        w.append("status='ACTIVE'")
        sales = {r["month"]: r for r in rows(f"""SELECT substr(date,1,7) AS month, SUM(net) AS net, SUM(gst) AS gst,
                    SUM(taxable) AS taxable, SUM(cost) AS cost, SUM(profit) AS profit
                    FROM sales WHERE {' AND '.join(w)} GROUP BY month""", args)}
        w2, args2 = date_filter("date", a)
        where2 = ("WHERE " + " AND ".join(w2)) if w2 else ""
        exp = {r["month"]: r["amount"] for r in rows(f"""SELECT substr(date,1,7) AS month, SUM(amount) AS amount
                    FROM expenses {where2} GROUP BY month""", args2)}
        cols = [C("month", "Month"), C("net", "Sales (incl. GST)", "money"), C("gst", "GST", "money"),
                C("taxable", "Sales excl. GST", "money"), C("cost", "Cost of Goods", "money"),
                C("profit", "Gross Profit", "money"), C("expenses", "Expenses", "money"), C("net_profit", "Net Profit", "money")]
        data = []
        for mth in sorted(set(sales) | set(exp)):
            sr = sales.get(mth, {})
            e = exp.get(mth, 0) or 0
            data.append({"month": mth, "net": sr.get("net", 0), "gst": sr.get("gst", 0), "taxable": sr.get("taxable", 0),
                         "cost": sr.get("cost", 0), "profit": sr.get("profit", 0), "expenses": e,
                         "net_profit": r2((sr.get("profit") or 0) - e)})
        return cols, data

    if name == "stock_adjustments":
        w, args = date_filter("a.date", a)
        _item_filters(a, w, args)
        where = ("WHERE " + " AND ".join(w)) if w else ""
        cols = [C("date", "Date", "date"), C("barcode", "Barcode"), C("subcategory", "Sub-category"),
                C("description", "Description"), C("size", "Size"), C("qty", "Qty +/-", "num"),
                C("value", "Value @Cost", "money"), C("reason", "Reason")]
        data = rows(f"""SELECT a.date, i.barcode, s.name AS subcategory, i.description, i.size, a.qty,
                        a.qty*i.cost AS value, a.reason
                        FROM stock_adjustments a JOIN items i ON i.id=a.item_id JOIN subcategories s ON s.id=i.subcategory_id
                        {where} ORDER BY a.date, a.id""", args)
        return cols, data

    raise ApiError("Unknown report")


def api_report(a):
    cols, data = report(a)
    return {"columns": cols, "rows": data}


def api_backup(a):
    return {"path": backup("manual")}


API = {k[4:]: v for k, v in globals().items() if k.startswith("api_") and callable(v)}
READ_ONLY = {"bootstrap", "list_expenses", "list_cash_entries", "cash_book", "low_stock_details", "list_customers", "customer_bills", "find_item", "search_items", "items_by_ids", "customer_lookup", "bill_preview", "get_bill",
             "list_bills", "list_inwards", "get_inward", "dashboard", "report", "backup", "list_users"}


# --------------------------------------------------------------------------
# Users, login and permissions
# --------------------------------------------------------------------------
SESSION_DAYS = 30
PBKDF2_ITERS = 200_000


def hash_password(pw):
    salt = secrets.token_bytes(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, PBKDF2_ITERS)
    return f"pbkdf2${PBKDF2_ITERS}${salt.hex()}${h.hex()}"


def check_password(pw, stored):
    try:
        _, iters, salt, h = stored.split("$")
        calc = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), bytes.fromhex(salt), int(iters))
        return hmac.compare_digest(calc.hex(), h)
    except (ValueError, AttributeError):
        return False


def validate_new_password(pw):
    if len(pw or "") < 8:
        raise ApiError("Password must be at least 8 characters")


def public_user(u):
    return {"id": u["id"], "username": u["username"], "name": u["name"], "role": u["role"],
            "can_inward": bool(u["can_inward"]), "active": bool(u["active"])}


def create_user(username, password, role="STAFF", name="", can_inward=False):
    username = (username or "").strip()
    if not username or not all(c.isalnum() or c in "._-" for c in username):
        raise ApiError("Username can contain only letters, numbers, dot, dash and underscore")
    validate_new_password(password)
    if role not in ("OWNER", "STAFF"):
        raise ApiError("Invalid role")
    try:
        return DB.execute("INSERT INTO users(username, name, pass_hash, role, can_inward, active, created_at) VALUES(?,?,?,?,?,1,?)",
                          (username, (name or "").strip(), hash_password(password), role, 1 if can_inward else 0, now())).lastrowid
    except sqlite3.IntegrityError:
        raise ApiError("This username already exists")


def session_user(token):
    if not token:
        return None
    th = hashlib.sha256(token.encode()).hexdigest()
    u = row("""SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
               WHERE s.token=? AND s.expires > ? AND u.active=1""", (th, time.time()))
    return u


def new_session(user_id):
    token = secrets.token_urlsafe(32)
    th = hashlib.sha256(token.encode()).hexdigest()
    DB.execute("DELETE FROM sessions WHERE expires < ?", (time.time(),))
    DB.execute("INSERT INTO sessions(token, user_id, created_at, expires) VALUES(?,?,?,?)",
               (th, user_id, now(), time.time() + SESSION_DAYS * 86400))
    return token


def owner_count():
    return DB.execute("SELECT COUNT(*) FROM users WHERE role='OWNER' AND active=1").fetchone()[0]


def api_list_users(a):
    return [public_user(u) for u in rows("SELECT * FROM users ORDER BY role, username")]


def api_save_user(a):
    role = a.get("role") or "STAFF"
    can_inward = str(a.get("can_inward")) in ("1", "true", "True", "yes")
    active = str(a.get("active", "1")) in ("1", "true", "True", "yes")
    if not a.get("id"):
        return {"id": create_user(a.get("username"), a.get("password"), role, a.get("name"), can_inward)}
    u = row("SELECT * FROM users WHERE id=?", (a["id"],))
    if not u:
        raise ApiError("User not found")
    if u["role"] == "OWNER" and u["active"] and (role != "OWNER" or not active) and owner_count() <= 1:
        raise ApiError("You must keep at least one active owner account")
    if role not in ("OWNER", "STAFF"):
        raise ApiError("Invalid role")
    DB.execute("UPDATE users SET name=?, role=?, can_inward=?, active=? WHERE id=?",
               ((a.get("name") or "").strip(), role, 1 if can_inward else 0, 1 if active else 0, u["id"]))
    if a.get("password"):
        validate_new_password(a["password"])
        DB.execute("UPDATE users SET pass_hash=? WHERE id=?", (hash_password(a["password"]), u["id"]))
        DB.execute("DELETE FROM sessions WHERE user_id=?", (u["id"],))
    if not active:
        DB.execute("DELETE FROM sessions WHERE user_id=?", (u["id"],))
    return {"id": u["id"]}


API.update(list_users=api_list_users, save_user=api_save_user)

# API sets by role. Anything not listed for staff is owner-only.
STAFF_APIS = {"bootstrap", "find_item", "search_items", "items_by_ids", "customer_lookup", "bill_preview", "save_bill",
              "get_bill", "list_bills", "list_customers", "save_customer", "customer_bills"}
INWARD_APIS = {"save_inward", "list_inwards", "get_inward", "update_inward", "save_brand", "save_supplier"}
# Fields hidden from staff (cost / profit / cash position)
STAFF_HIDDEN = {"cost", "profit", "markup", "value_cost", "margin", "opening_cash", "opening_cash_date"}
PUBLIC_APIS = {"auth_status", "login", "logout", "setup_owner"}


def scrub(obj):
    if isinstance(obj, dict):
        return {k: scrub(v) for k, v in obj.items() if k not in STAFF_HIDDEN}
    if isinstance(obj, list):
        return [scrub(v) for v in obj]
    return obj


_login_fails = {}  # ip -> [count, locked_until]


def dispatch(name, args, token, remote_ip, local_mode):
    """Runs one API call. Returns (http_status, response_dict, set_cookie_value_or_None)."""
    ensure_db()
    maybe_periodic_backup()
    if name in PUBLIC_APIS:
        with LOCK:
            return _public_api(name, args, token, remote_ip, local_mode)
    fn = API.get(name)
    if not fn and name != "change_password":
        return 404, {"ok": False, "error": "Unknown API"}, None
    with LOCK:
        user = session_user(token)
        if not user:
            return 401, {"ok": False, "error": "Please log in", "auth": True}, None
        is_owner = user["role"] == "OWNER"
        allowed = is_owner or name in STAFF_APIS or (user["can_inward"] and name in INWARD_APIS) or name == "change_password"
        if not allowed:
            return 403, {"ok": False, "error": "Only the owner can do this"}, None
        try:
            if name == "change_password":
                result = _change_password(user, args)
            else:
                result = fn(args)
            if name not in READ_ONLY:
                DB.commit()
            else:
                DB.rollback()
        except Exception:
            DB.rollback()
            raise
        if name == "bootstrap":
            result["me"] = public_user(user)
        if not is_owner and not (user["can_inward"] and name in INWARD_APIS):
            result = scrub(result)
        return 200, {"ok": True, "data": result}, None


def _change_password(user, a):
    if not check_password(a.get("old") or "", user["pass_hash"]):
        raise ApiError("Current password is wrong")
    validate_new_password(a.get("new"))
    DB.execute("UPDATE users SET pass_hash=? WHERE id=?", (hash_password(a["new"]), user["id"]))
    return {}


def _public_api(name, a, token, ip, local_mode):
    users = DB.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    if name == "auth_status":
        u = session_user(token)
        return 200, {"ok": True, "data": {"needs_setup": users == 0, "can_setup_here": local_mode,
                                          "user": public_user(u) if u else None}}, None
    if name == "logout":
        if token:
            DB.execute("DELETE FROM sessions WHERE token=?", (hashlib.sha256(token.encode()).hexdigest(),))
            DB.commit()
        return 200, {"ok": True, "data": {}}, ""
    if name == "setup_owner":
        if users:
            return 200, {"ok": False, "error": "Setup is already done. Please log in."}, None
        if not local_mode:
            return 200, {"ok": False, "error": "For safety, create the owner account from the server console: python manage.py create-owner"}, None
        try:
            uid = create_user(a.get("username"), a.get("password"), "OWNER", a.get("name"))
            tok = new_session(uid)
            DB.commit()
        except ApiError as e:
            DB.rollback()
            return 200, {"ok": False, "error": str(e)}, None
        return 200, {"ok": True, "data": {"user": public_user(row("SELECT * FROM users WHERE id=?", (uid,)))}}, tok
    if name == "login":
        rec = _login_fails.get(ip, [0, 0])
        if rec[1] > time.time():
            return 200, {"ok": False, "error": f"Too many wrong attempts. Try again in {int(rec[1] - time.time()) // 60 + 1} minute(s)."}, None
        u = row("SELECT * FROM users WHERE username=? COLLATE NOCASE AND active=1", (str(a.get("username") or "").strip(),))
        if not u or not check_password(str(a.get("password") or ""), u["pass_hash"]):
            rec[0] += 1
            if rec[0] >= 8:
                rec = [0, time.time() + 300]
            _login_fails[ip] = rec
            return 200, {"ok": False, "error": "Wrong username or password"}, None
        _login_fails.pop(ip, None)
        tok = new_session(u["id"])
        DB.commit()
        return 200, {"ok": True, "data": {"user": public_user(u)}}, tok
    return 404, {"ok": False, "error": "Unknown API"}, None


def cookie_header(token, secure):
    if token == "":
        return "ss_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax" + ("; Secure" if secure else "")
    return (f"ss_session={token}; Path=/; Max-Age={SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax"
            + ("; Secure" if secure else ""))


def token_from_cookie(raw):
    try:
        c = http.cookies.SimpleCookie(raw or "")
        return c["ss_session"].value if "ss_session" in c else None
    except http.cookies.CookieError:
        return None


# --------------------------------------------------------------------------
# Shared request handling (local server and WSGI / PythonAnywhere)
# --------------------------------------------------------------------------
SECURITY_HEADERS = [("X-Content-Type-Options", "nosniff"), ("X-Frame-Options", "DENY"),
                    ("Referrer-Policy", "same-origin"), ("Cache-Control", "no-store")]
MAX_BODY = 5 * 1024 * 1024
_last_backup_check = [0.0]


def ensure_db():
    global DB
    if DB is None:
        with LOCK:
            if DB is None:
                DB = connect()
                auto_backup()


def maybe_periodic_backup():
    if time.time() - _last_backup_check[0] > 3600:
        _last_backup_check[0] = time.time()
        try:
            auto_backup()
        except Exception:  # never block a request because of backup problems
            pass


def static_file(path):
    if path in ("", "/"):
        path = "/index.html"
    full = os.path.normpath(os.path.join(STATIC, path.lstrip("/")))
    if not full.startswith(STATIC + os.sep) or not os.path.isfile(full):
        return 404, b"Not found", "text/plain; charset=utf-8"
    ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
    if ctype.startswith("text/") or ctype.endswith("javascript"):
        ctype += "; charset=utf-8"
    with open(full, "rb") as f:
        return 200, f.read(), ctype


def api_request(name, raw_body, cookie_raw, remote_ip, local_mode, secure):
    """Returns (status, body_bytes, extra_headers)."""
    try:
        args = json.loads(raw_body or b"{}") if raw_body else {}
        if not isinstance(args, dict):
            raise ValueError
    except ValueError:
        return 400, json.dumps({"ok": False, "error": "Bad request"}).encode(), []
    try:
        status, body, tok = dispatch(name, args, token_from_cookie(cookie_raw), remote_ip, local_mode)
    except ApiError as e:
        status, body, tok = 200, {"ok": False, "error": str(e)}, None
    except Exception as e:  # unexpected
        import traceback
        traceback.print_exc()
        status, body, tok = 200, {"ok": False, "error": f"Internal error: {e}"}, None
    headers = []
    if tok is not None:
        headers.append(("Set-Cookie", cookie_header(tok, secure)))
    return status, json.dumps(body, default=str).encode("utf-8"), headers


STATUS_TEXT = {200: "200 OK", 400: "400 Bad Request", 401: "401 Unauthorized", 403: "403 Forbidden",
               404: "404 Not Found", 405: "405 Method Not Allowed", 413: "413 Payload Too Large"}


def wsgi_app(environ, start_response):
    """WSGI entry point (used on PythonAnywhere through wsgi.py)."""
    method = environ.get("REQUEST_METHOD", "GET")
    path = environ.get("PATH_INFO") or "/"
    if method == "GET":
        status, body, ctype = static_file(path)
        extra = []
    elif method == "POST" and path.startswith("/api/"):
        length = int(environ.get("CONTENT_LENGTH") or 0)
        if length > MAX_BODY:
            status, body, ctype, extra = 413, b"Too large", "text/plain", []
        else:
            raw = environ["wsgi.input"].read(length) if length else b""
            ip = (environ.get("HTTP_X_REAL_IP") or environ.get("HTTP_X_FORWARDED_FOR", "").split(",")[0].strip()
                  or environ.get("REMOTE_ADDR", ""))
            secure = environ.get("wsgi.url_scheme") == "https" or environ.get("HTTP_X_FORWARDED_PROTO") == "https"
            status, body, extra = api_request(path[5:], raw, environ.get("HTTP_COOKIE"), ip, False, secure)
            ctype = "application/json; charset=utf-8"
    else:
        status, body, ctype, extra = 405, b"Method not allowed", "text/plain", []
    headers = [("Content-Type", ctype), ("Content-Length", str(len(body)))] + SECURITY_HEADERS + extra
    start_response(STATUS_TEXT.get(status, f"{status} Error"), headers)
    return [body]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype, extra=()):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in list(SECURITY_HEADERS) + list(extra):
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        code, body, ctype = static_file(urlparse(self.path).path)
        self._send(code, body, ctype)

    def do_POST(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            return self._send(404, b"Not found", "text/plain")
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            return self._send(413, b"Too large", "text/plain")
        raw = self.rfile.read(n) if n else b""
        ip = self.client_address[0]
        local = ip in ("127.0.0.1", "::1")
        code, body, extra = api_request(path[5:], raw, self.headers.get("Cookie"), ip, local, False)
        self._send(code, body, "application/json; charset=utf-8", extra)


def main():
    ensure_db()
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError:
        print(f"SuperSoft seems to be already running. Opening http://{HOST}:{PORT}")
        webbrowser.open(f"http://{HOST}:{PORT}")
        return
    url = f"http://{HOST}:{PORT}"
    print("=" * 56)
    print("  SuperSoft is running")
    print(f"  Open in browser : {url}")
    print(f"  Data folder     : {DATA}")
    print("  Keep this window open while using the software.")
    print("  Close this window (or press Ctrl+C) to stop.")
    print("=" * 56)
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        DB.close()


if __name__ == "__main__":
    main()
