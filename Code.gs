/*******************************************************
 * WAREHOUSE CONTROL SYSTEM — BACKEND CORE v1.1
 * Standalone Apps Script: script เดียวคุมทั้ง N และ CN
 *
 * Data flow:
 *   Transactions (Source of Truth, ห้ามลบ)
 *     → Stock_Ledger (append-only)
 *     → Current_Stock / Location_Summary (derived, ระบบเขียนเอง)
 *     → API / Dashboard
 *
 * หน่วยสต็อกทุก Transaction = JUMBO (Settings.STOCK_UNIT)
 *
 * ติดตั้ง:
 *   1) ใส่ Spreadsheet ID ของไฟล์ N และ CN ใน CONFIG.SPREADSHEET_IDS
 *   2) Project Settings → Time zone = (GMT+07:00) Bangkok
 *   3) ไฟล์ที่มีข้อมูลจาก v1 อยู่แล้ว → รัน upgradeFromV1() ครั้งเดียว
 *      ไฟล์ใหม่เปล่า            → รัน setupBackend()
 *******************************************************/


/* ============================ CONFIG ============================ */

const CONFIG = {
  SPREADSHEET_IDS: {
    N: "PUT_N_SPREADSHEET_ID_HERE",
    CN: "PUT_CN_SPREADSHEET_ID_HERE"
  },
  TIMEZONE: "Asia/Bangkok",
  LOCK_TIMEOUT_MS: 30000,
  HIGH_UTILIZATION: 0.9,       // >= 90% = Capacity Risk
  PLANNING_HORIZON_DAYS: 7,    // Incoming / Outbound next N days
  VERSION: "1.1.0"
};

const AREAS = ["N", "CN"];

const SHEETS = {
  TRANSACTIONS: "Transactions",
  LOCATIONS: "Locations",
  RICE_MASTER: "Rice_Master",
  SUPPLIERS: "Suppliers",
  LOTS: "Lots",
  STOCK_LEDGER: "Stock_Ledger",
  CURRENT_STOCK: "Current_Stock",
  LOCATION_SUMMARY: "Location_Summary",
  PLANNING: "Planning",
  RECONCILIATION: "Reconciliation",
  SETTINGS: "Settings"
};

/*
 * ลำดับคอลัมน์เดิมของ v1 ไม่เปลี่ยน — คอลัมน์ใหม่ต่อท้ายเท่านั้น
 * setupBackend()/upgradeFromV1() จะเติมคอลัมน์ที่ขาดให้อัตโนมัติ
 */
const HEADERS = {
  Transactions: [
    "Transaction_ID", "Timestamp", "Transaction_Date", "Transaction_Type", "Area",
    "Location_ID", "Rice_Type", "Grade", "Supplier_ID", "Lot_ID", "Qty", "Unit",
    "Reference", "Customer_ID", "Status", "User", "Remark",
    // v1.1
    "Doc_ID", "Transfer_ID", "Reversal_Of", "Client_Request_ID", "Plan_ID", "Seq"
  ],
  Locations: [
    "Location_ID", "Area", "Zone", "Capacity", "Unit", "Active", "Allow_Mix_Rice"
  ],
  Rice_Master: [
    "Rice_ID", "Rice_Type", "Grade", "Description", "Default_Unit", "Active"
  ],
  Suppliers: [
    "Supplier_ID", "Supplier_Name", "Supplier_Code", "Contact", "Active", "Remark"
  ],
  Lots: [
    "Lot_ID", "Supplier_ID", "Rice_Type", "Grade", "Receive_Date", "Original_Qty",
    "Unit", "Status", "Created_Transaction_ID", "Remark",
    // v1.1
    "Origin_Area"
  ],
  Stock_Ledger: [
    "Ledger_ID", "Transaction_ID", "Lot_ID", "Area", "Location_ID", "Rice_Type",
    "Qty_In", "Qty_Out", "Balance_After", "Timestamp",
    // v1.1  (Balance_After = ยอดของ Lot นี้ที่ Location นี้)
    "Transaction_Type", "Grade", "Supplier_ID", "Unit", "Location_Balance_After", "Seq"
  ],
  Current_Stock: [
    "Area", "Location_ID", "Rice_Type", "Grade", "Lot_ID", "Supplier_ID", "Qty", "Unit",
    "Capacity", "Free_Capacity", "Utilization", "Last_Transaction", "Stock_Status",
    // v1.1  (Capacity/Free/Utilization เป็นค่าระดับ Location — ห้าม SUM ใช้ Location_Summary)
    "Last_In_Seq", "Last_In_Date"
  ],
  Location_Summary: [
    "Area", "Location_ID", "Zone", "Capacity", "Unit", "Stock", "Free_Capacity",
    "Utilization", "Rice_Types", "Lot_Count", "Active", "Allow_Mix_Rice", "Status", "Updated_At"
  ],
  Planning: [
    "Plan_ID", "Plan_Date", "Plan_Type", "Supplier_ID", "Customer_ID", "Rice_Type", "Grade",
    "Qty", "Unit", "Area", "Preferred_Location", "Reference", "Status", "Created_By", "Remark",
    // v1.1
    "Updated_At", "Updated_By"
  ],
  Reconciliation: [
    "Reconciliation_ID", "Date", "Area", "Location_ID", "System_Qty", "Physical_Qty",
    "Difference", "Unit", "Reason", "Adjustment_Transaction_ID", "Checked_By", "Status", "Remark"
  ],
  Settings: ["Key", "Value", "Description"]
};

// คอลัมน์ที่ต้องเป็น Plain text (กัน Sheets แปลง "12/9" หรือ "001" เป็นวันที่/ตัวเลข)
const TEXT_COLUMNS = [
  "Transaction_ID", "Location_ID", "Rice_Type", "Grade", "Supplier_ID", "Lot_ID", "Reference",
  "Customer_ID", "Doc_ID", "Transfer_ID", "Reversal_Of", "Client_Request_ID", "Plan_ID",
  "Ledger_ID", "Created_Transaction_ID", "Rice_ID", "Supplier_Code", "Preferred_Location",
  "Reconciliation_ID", "Adjustment_Transaction_ID", "Last_Transaction", "Zone"
];

const DEFAULT_SETTINGS = [
  ["BACKEND_AREA", null, "N หรือ CN — ต้องตรงกับไฟล์นี้ (ห้ามแก้)"],
  ["STOCK_UNIT", "JUMBO", "หน่วยสต็อกของทุก Transaction"],
  ["CN_DEFAULT_CAPACITY", 278, "Capacity เริ่มต้นต่อห้อง CN (ใช้ตอนสร้าง Locations ครั้งแรกเท่านั้น)"],
  ["ALLOW_MIX_RICE_CN", false, "ค่าเริ่มต้นของ Allow_Mix_Rice สำหรับห้อง CN ที่ช่องว่าง — ค่าจริงอ่านจากคอลัมน์ Allow_Mix_Rice ใน Locations"],
  ["LIFO_ENABLED", true, "จ่ายออกแบบ LIFO อัตโนมัติเมื่อไม่ระบุ Lot"],
  ["QTY_INTEGER_ONLY", true, "จำนวนต้องเป็นจำนวนเต็ม Jumbo"],
  ["BLOCK_UNMAPPED_CAPACITY", false, "TRUE = ห้ามรับเข้า Location ที่ยังไม่มี Capacity / FALSE = รับได้แต่เตือน"],
  ["ALLOW_FUTURE_DATE", false, "อนุญาต Transaction_Date ในอนาคต"]
];

const IN_TYPES = ["IN", "TRANSFER_IN", "ADJUSTMENT_IN"];
const OUT_TYPES = ["OUT", "TRANSFER_OUT", "ADJUSTMENT_OUT"];
const EFFECTIVE_STATUSES = ["POSTED", "COMPLETED"];   // COMPLETED = สถานะจาก v1
const PLAN_TYPES = ["INBOUND", "OUTBOUND"];
const PLAN_STATUSES = ["FORECAST", "PLANNED", "ALLOCATED", "CONFIRMED", "COMPLETED", "CANCELLED"];
const PLAN_OPEN_STATUSES = ["FORECAST", "PLANNED", "ALLOCATED", "CONFIRMED"];
const PLAN_PENDING_ALLOCATION = ["FORECAST", "PLANNED"];
const RECON_CLOSED_STATUSES = ["ADJUSTED", "CLOSED", "RESOLVED"];
const REVERSE_TYPE = {
  IN: "ADJUSTMENT_OUT", TRANSFER_IN: "ADJUSTMENT_OUT", ADJUSTMENT_IN: "ADJUSTMENT_OUT",
  OUT: "ADJUSTMENT_IN", TRANSFER_OUT: "ADJUSTMENT_IN", ADJUSTMENT_OUT: "ADJUSTMENT_IN"
};

// Per-execution caches (Apps Script รีเซ็ต global ทุก execution)
let _inLock = false;
let _ssCache = {};
let _ctxCache = {};


/* ============================ ROUTES ============================ */

const GET_ROUTES = {
  dashboard:      function (p) { return getDashboard(); },
  locations:      function (p) { return getLocations(p.area); },
  current_stock:  function (p) { return getCurrentStock(p.area); },
  location_stock: function (p) { return getStockByLocation(p.locationId, p.area); },
  capacity:       function (p) { return getCapacity(p.area); },
  lot:            function (p) { return getLot(p.lotId); },
  search_lot:     function (p) { return searchLot(p.keyword); },
  planning:       function (p) { return getPlanning(p.from, p.to, p.area); },
  reconciliation: function (p) { return getReconciliation(p.area); }
};

const POST_ROUTES = {
  createInbound:     function (b) { return createInbound(b.data); },
  previewInbound:    function (b) { return previewInbound(b.data); },
  createOutbound:    function (b) { return createOutbound(b.data); },
  previewOutbound:   function (b) { return previewOutbound(b.data); },
  createTransfer:    function (b) { return createTransfer(b.data); },
  previewTransfer:   function (b) { return previewTransfer(b.data); },
  createAdjustment:  function (b) { return createAdjustment(b.data); },
  previewAdjustment: function (b) { return previewAdjustment(b.data); },
  reverseDocument:   function (b) { return reverseDocument(b.data); },
  createPlan:        function (b) { return createPlan(b.data); },
  updatePlan:        function (b) { return updatePlan(b.planId || (b.data && b.data.planId), b.data); },
  rebuildDerived:    function (b) { return rebuildDerived(b.data && b.data.area); }
};

function doGet(e) {
  const p = (e && e.parameter) || {};
  return jsonOut_(dispatch_(GET_ROUTES, p.action || "dashboard", p));
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return jsonOut_({ success: false, error: "Invalid JSON body", errors: ["Invalid JSON body"] });
  }
  return jsonOut_(dispatch_(POST_ROUTES, body.action, body));
}

/**
 * สำหรับ Frontend แบบ HtmlService: google.script.run.api("createInbound", { data: {...} })
 * GET actions: google.script.run.api("current_stock", { area: "CN" })
 */
function api(action, payload) {
  const routes = GET_ROUTES[action] ? GET_ROUTES : POST_ROUTES;
  return dispatch_(routes, action, payload || {});
}

function dispatch_(routes, action, payload) {
  try {
    const fn = routes[action];
    if (!fn) throw new Error("Unknown action: " + action);
    return toOutput_(fn(payload || {}));
  } catch (err) {
    return toOutput_({
      success: false,
      error: err.message,
      errors: err.details || [err.message],
      context: err.context || null
    });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


/* ============================ SETUP / UPGRADE ============================ */

/** ไฟล์ใหม่: สร้างชีท, Settings, Locations ตั้งต้น แล้วคำนวณสต็อก */
function setupBackend() {
  return withLock_(function () {
    return AREAS.map(function (area) {
      const report = setupArea_(area);
      report.rebuild = rebuildArea_(area);
      report.warnings = report.warnings.concat(checkLocationsConfig_(area));
      return report;
    });
  });
}

/**
 * ไฟล์เดิมจาก v1 (รันครั้งเดียว, รันซ้ำได้ปลอดภัย):
 * - เติมคอลัมน์ใหม่ท้ายตาราง
 * - เติม Seq / Doc_ID / Transfer_ID ให้แถวเดิมที่ยังว่าง (ไม่แตะค่าเดิม)
 * - เติม Stock_Ledger ที่ขาด แล้ว rebuild Current_Stock
 */
function upgradeFromV1() {
  return withLock_(function () {
    resetCounters_();
    return AREAS.map(function (area) {
      const report = setupArea_(area);
      report.backfill = backfillV1Columns_(area);
      report.rebuild = rebuildArea_(area);
      report.warnings = report.warnings.concat(checkLocationsConfig_(area));
      return report;
    });
  });
}

/** คำนวณ Current_Stock + Location_Summary ใหม่จาก Transactions และเติม Ledger ที่ขาด */
function rebuildDerived(area) {
  return withLock_(function () {
    const areas = area ? [normalizeArea_(area)] : AREAS;
    return areas.map(function (a) { return rebuildArea_(a); });
  });
}

function setupArea_(area) {
  const ss = getSS_(area);
  ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE);
  const headerChanges = {};
  Object.keys(HEADERS).forEach(function (name) {
    const added = ensureSheet_(ss, name);
    if (added.length) headerChanges[name] = added;
  });
  setupSettings_(area);
  const created = setupDefaultLocations_(area);
  protectManagedSheets_(ss);
  delete _ctxCache[area];
  return { area: area, headerChanges: headerChanges, defaultLocationsCreated: created, warnings: [] };
}

function ensureSheet_(ss, name) {
  const expected = HEADERS[name];
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);

  let added;
  if (sh.getLastRow() === 0 || sh.getLastColumn() === 0) {
    sh.getRange(1, 1, 1, expected.length).setValues([expected]);
    sh.setFrozenRows(1);
    added = expected.slice();
  } else {
    const current = headerRow_(sh);
    const dup = current.filter(function (h, i) { return h && current.indexOf(h) !== i; });
    if (dup.length) throw new Error(ss.getName() + "/" + name + " has duplicate headers: " + dup.join(", "));
    added = expected.filter(function (h) { return current.indexOf(h) < 0; });
    if (added.length) {
      const start = current.length + 1;
      const needCols = start + added.length - 1;
      if (sh.getMaxColumns() < needCols) sh.insertColumnsAfter(sh.getMaxColumns(), needCols - sh.getMaxColumns());
      sh.getRange(1, start, 1, added.length).setValues([added]);
    }
  }

  // Plain-text format สำหรับคอลัมน์รหัส/ข้อความ
  const headers = headerRow_(sh);
  headers.forEach(function (h, i) {
    if (TEXT_COLUMNS.indexOf(h) >= 0) sh.getRange(2, i + 1, Math.max(1, sh.getMaxRows() - 1), 1).setNumberFormat("@");
  });
  return added;
}

function setupSettings_(area) {
  const t = readTable_(area, SHEETS.SETTINGS);
  const existing = {};
  t.rows.forEach(function (r) { existing[str_(r.Key)] = r; });

  if (existing.BACKEND_AREA && up_(existing.BACKEND_AREA.Value) !== area) {
    throw new Error("Spreadsheet configured as " + area + " but its Settings.BACKEND_AREA = " +
      existing.BACKEND_AREA.Value + ". Check CONFIG.SPREADSHEET_IDS (N/CN swapped?).");
  }
  const add = DEFAULT_SETTINGS
    .filter(function (s) { return !existing[s[0]]; })
    .map(function (s) {
      return { Key: s[0], Value: s[0] === "BACKEND_AREA" ? area : s[1], Description: s[2] };
    });
  appendObjects_(area, SHEETS.SETTINGS, add);
}

function setupDefaultLocations_(area) {
  const t = readTable_(area, SHEETS.LOCATIONS);
  if (t.rows.length) return 0;
  const s = loadSettings_(area);
  const rows = [];

  if (area === "CN") {
    for (let i = 1; i <= 10; i++) {
      rows.push({
        Location_ID: "CN" + pad_(i, 2), Area: "CN", Zone: "CN",
        Capacity: s.CN_DEFAULT_CAPACITY, Unit: s.STOCK_UNIT, Active: true,
        Allow_Mix_Rice: s.ALLOW_MIX_RICE_CN
      });
    }
  } else {
    // ตัวอย่างเท่านั้น — Capacity เว้นว่างจนกว่าจะใส่ Mapping จริง (ห้ามเดา)
    ["N1-A1", "N1-A2", "N1-A3", "N1-A4", "N1-B1", "N1-B2", "N1-B3", "N1-B4",
     "N2-A1", "N2-A2", "N2-A3", "N2-A4", "N2-A5"].forEach(function (id) {
      rows.push({
        Location_ID: id, Area: "N", Zone: id.split("-")[0],
        Capacity: "", Unit: s.STOCK_UNIT, Active: true, Allow_Mix_Rice: true
      });
    });
  }
  appendObjects_(area, SHEETS.LOCATIONS, rows);
  return rows.length;
}

function protectManagedSheets_(ss) {
  [SHEETS.TRANSACTIONS, SHEETS.STOCK_LEDGER, SHEETS.CURRENT_STOCK, SHEETS.LOCATION_SUMMARY]
    .forEach(function (name) {
      const sh = ss.getSheetByName(name);
      if (!sh) return;
      if (sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) return;
      sh.protect()
        .setDescription("Managed by Warehouse backend — do not edit manually")
        .setWarningOnly(true);
    });
}

function backfillV1Columns_(area) {
  const t = readTable_(area, SHEETS.TRANSACTIONS);
  const out = { seqAssigned: 0, docIdAssigned: 0, transferIdAssigned: 0, rowsWithoutLot: 0 };
  const n = t.sheet.getLastRow() - 1;
  if (n <= 0) return out;

  const col = function (h) { return t.headers.indexOf(h) + 1; };
  const seqR = t.sheet.getRange(2, col("Seq"), n, 1), seqV = seqR.getValues();
  const docR = t.sheet.getRange(2, col("Doc_ID"), n, 1), docV = docR.getValues();
  const trfR = t.sheet.getRange(2, col("Transfer_ID"), n, 1), trfV = trfR.getValues();

  let maxSeq = 0;
  t.rows.forEach(function (r) {
    const s = Number(r.Seq);
    if (r.Seq !== "" && !isNaN(s) && s > maxSeq) maxSeq = s;
  });
  t.rows
    .filter(function (r) { return r.Seq === "" || r.Seq === null; })
    .sort(txnOrder_)
    .forEach(function (r) { seqV[r._row - 2][0] = ++maxSeq; out.seqAssigned++; });

  t.rows.forEach(function (r) {
    const i = r._row - 2;
    const type = up_(r.Transaction_Type);
    const isTrf = (type === "TRANSFER_IN" || type === "TRANSFER_OUT") && /^TRF/i.test(str_(r.Reference));
    if (isTrf && trfV[i][0] === "") { trfV[i][0] = str_(r.Reference); out.transferIdAssigned++; }
    if (docV[i][0] === "") { docV[i][0] = isTrf ? str_(r.Reference) : str_(r.Transaction_ID); out.docIdAssigned++; }
    if (!str_(r.Lot_ID)) out.rowsWithoutLot++;
  });

  seqR.setValues(seqV);
  docR.setValues(docV);
  trfR.setValues(trfV);
  delete _ctxCache[area];
  return out;
}

function checkLocationsConfig_(area) {
  const s = loadSettings_(area);
  const locs = loadLocations_(area, s);
  const warnings = [];
  let unmapped = 0;
  Object.keys(locs).forEach(function (k) {
    const L = locs[k];
    if (L.area !== area) warnings.push("Location " + L.id + " has Area=" + L.area + " but is in " + area + " file");
    if (L.unit && L.unit !== s.STOCK_UNIT) warnings.push("Location " + L.id + " Unit=" + L.unit + " — must be " + s.STOCK_UNIT + " (edit Locations sheet)");
    if (L.capacity === null && L.active) unmapped++;
  });
  if (unmapped) warnings.push(unmapped + " active locations in " + area + " have no Capacity yet (not mapped)");
  return warnings;
}


/* ============================ POST: INBOUND ============================ */

/**
 * data: {
 *   area, locationId, qty            (รับเข้า Location เดียว)
 *   หรือ area, allocations:[{locationId, qty}, ...]   (แบ่งหลาย Location — Lot เดียวกัน)
 *   riceType, grade, supplierId, lotId?, transactionDate?, reference, remark,
 *   planId?, clientRequestId?, unit?
 * }
 */
function createInbound(data)  { return withLock_(function () { return opInbound_(data, false); }); }
function previewInbound(data) { return withLock_(function () { return opInbound_(data, true); }); }

function opInbound_(data, dryRun) {
  data = data || {};
  const area = normalizeArea_(data.area);
  const ctx = getContext_(area);
  const s = ctx.settings;

  if (!dryRun) {
    const dup = findDuplicate_(area, str_(data.clientRequestId));
    if (dup) return dup;
  }
  checkUnit_(data.unit, s);
  const req = baseRequest_(data, s);
  const allocs = parseInboundAllocations_(ctx, data);
  const totalQty = allocs.reduce(function (sum, a) { return sum + a.qty; }, 0);
  const errors = [], warnings = [];

  // ---- Lot ----
  let lotId = str_(data.lotId);
  let riceType = str_(data.riceType), grade = str_(data.grade), supplierId = str_(data.supplierId);
  let newLot = true;

  if (lotId) {
    if (/[\r\n]/.test(lotId) || lotId.length > 60) throw new Error("Invalid lotId");
    const existing = ctxLots_(ctx)[up_(lotId)];
    if (existing) {
      newLot = false;
      lotId = str_(existing.Lot_ID);
      [["riceType", riceType, existing.Rice_Type],
       ["grade", grade, existing.Grade],
       ["supplierId", supplierId, existing.Supplier_ID]].forEach(function (c) {
        if (c[1] && str_(c[2]) && up_(c[1]) !== up_(c[2])) {
          errors.push("Lot " + lotId + ": " + c[0] + " '" + c[1] + "' does not match lot master '" + c[2] + "'");
        }
      });
      riceType = str_(existing.Rice_Type) || riceType;
      grade = str_(existing.Grade) || grade;
      supplierId = str_(existing.Supplier_ID) || supplierId;
      warnings.push("Lot " + lotId + " already exists — this receipt adds quantity to the existing lot");
    } else {
      const other = otherArea_(area);
      if (ctxLots_(getContext_(other))[up_(lotId)]) {
        errors.push("Lot " + lotId + " already exists in " + other + ". Use Transfer to move it into " + area + ".");
      }
    }
  }
  if (!riceType) errors.push("riceType is required");
  if (newLot && !supplierId) errors.push("supplierId is required for a new lot");
  validateMaster_(ctx, riceType, supplierId, errors, warnings);
  validatePlan_(req.planId, area, "INBOUND", errors);

  const draftLot = lotId || "__NEW_LOT__";
  const drafts = allocs.map(function (a) {
    return {
      Transaction_Type: "IN", Location_ID: a.L.id, Rice_Type: riceType, Grade: grade,
      Supplier_ID: supplierId, Lot_ID: draftLot, Qty: a.qty
    };
  });

  const checks = allocs.map(function (a) {
    const cur = locationTotal_(ctx.state, a.L.id);
    return {
      locationId: a.L.id, current: cur, incoming: a.qty, capacity: a.L.capacity,
      free: a.L.capacity === null ? null : Math.max(0, a.L.capacity - cur),
      after: cur + a.qty, riceTypesNow: riceTypesAt_(ctx.state, a.L.id)
    };
  });

  let suggestion = null;
  if (!errors.length) {
    const sim = simulate_(ctx, drafts, {});
    pushAll_(errors, sim.errors);
    pushAll_(warnings, sim.warnings);
    if (sim.errors.length && riceType) suggestion = suggestAllocation_(ctx, riceType, totalQty, allocs[0].L);
  }

  if (dryRun || errors.length) {
    const view = {
      area: area, totalQty: totalQty, checks: checks,
      lot: { lotId: lotId || "(auto)", newLot: newLot, riceType: riceType, grade: grade, supplierId: supplierId },
      suggestion: suggestion
    };
    if (!dryRun) throw validationError_(errors, view);
    return Object.assign({ success: true, dryRun: true, valid: errors.length === 0, errors: errors, warnings: warnings }, view);
  }

  // ---- Commit ----
  if (!lotId) lotId = nextLotId_(req.date);
  drafts.forEach(function (d) { d.Lot_ID = lotId; });
  const docId = nextDocId_(area);
  const txns = finalizeTxns_(area, drafts, req, docId, "");
  const lotRows = newLot ? [{
    Lot_ID: lotId, Supplier_ID: supplierId, Rice_Type: riceType, Grade: grade,
    Receive_Date: req.date, Original_Qty: totalQty, Unit: s.STOCK_UNIT, Status: "OPEN",
    Created_Transaction_ID: txns[0].Transaction_ID, Remark: req.remark, Origin_Area: area
  }] : [];

  commit_([{ area: area, txns: txns, lots: lotRows }]);

  return {
    success: true, message: "Inbound posted", area: area, docId: docId, lotId: lotId, newLot: newLot,
    transactionIds: txns.map(function (t) { return t.Transaction_ID; }),
    transactionId: txns[0].Transaction_ID,
    checks: checks, warnings: warnings
  };
}

function parseInboundAllocations_(ctx, data) {
  const s = ctx.settings;
  let list;
  if (Array.isArray(data.allocations) && data.allocations.length) {
    list = data.allocations.map(function (a, i) {
      return {
        L: requireLocation_(ctx, a && a.locationId, true),
        qty: parseQty_(a && a.qty, s, "allocations[" + i + "].qty")
      };
    });
    const total = list.reduce(function (sum, a) { return sum + a.qty; }, 0);
    if (!isBlank_(data.qty) && parseQty_(data.qty, s) !== total) {
      throw new Error("qty (" + data.qty + ") does not match sum of allocations (" + total + ")");
    }
  } else {
    list = [{ L: requireLocation_(ctx, data.locationId, true), qty: parseQty_(data.qty, s) }];
  }
  const seen = {};
  list.forEach(function (a) {
    if (seen[a.L.key]) throw new Error("Location " + a.L.id + " appears more than once in allocations");
    seen[a.L.key] = true;
  });
  return list;
}

/** เสนอการแบ่ง Location (ข้อเสนอเท่านั้น — ผู้ใช้ต้อง Confirm เอง) */
function suggestAllocation_(ctx, riceType, qty, preferred) {
  const rice = up_(riceType);
  const candidates = Object.keys(ctx.locs).map(function (k) { return ctx.locs[k]; })
    .filter(function (L) { return L.active && L.area === ctx.area && (!L.unit || L.unit === ctx.settings.STOCK_UNIT); })
    .map(function (L) {
      const total = locationTotal_(ctx.state, L.id);
      const types = riceTypesAt_(ctx.state, L.id).map(up_);
      const mixOk = L.allowMix || types.length === 0 || (types.length === 1 && types[0] === rice);
      return {
        L: L, total: total, mixOk: mixOk, sameRice: types.indexOf(rice) >= 0,
        free: L.capacity === null ? null : Math.max(0, L.capacity - total)
      };
    })
    .filter(function (x) { return x.mixOk && x.free !== null && x.free > 0; });

  candidates.sort(function (a, b) {
    return (Number(b.L.key === preferred.key) - Number(a.L.key === preferred.key)) ||
      (Number(b.sameRice) - Number(a.sameRice)) ||
      (b.free - a.free) ||
      a.L.id.localeCompare(b.L.id);
  });

  const allocations = [];
  let remaining = qty;
  candidates.forEach(function (x) {
    if (remaining <= 0) return;
    const take = Math.min(x.free, remaining);
    allocations.push({ locationId: x.L.id, qty: take, currentQty: x.total, freeBefore: x.free, sameRiceType: x.sameRice });
    remaining -= take;
  });
  return {
    allocations: allocations,
    unallocated: remaining,
    note: "Suggestion only — user must confirm. Locations without mapped capacity are never suggested."
  };
}


/* ============================ POST: OUTBOUND ============================ */

/**
 * data: {
 *   area, locationId, qty,
 *   lotId?                         → จ่ายจาก Lot ที่ระบุ
 *   allocations?:[{lotId, qty}]    → ผู้ใช้กำหนด Lot เอง
 *   (ไม่ระบุทั้งคู่ + LIFO_ENABLED) → ระบบจัด LIFO
 *   reference, customerId, transactionDate?, remark, planId?, clientRequestId?
 * }
 */
function createOutbound(data)  { return withLock_(function () { return opOutbound_(data, false); }); }
function previewOutbound(data) { return withLock_(function () { return opOutbound_(data, true); }); }

function opOutbound_(data, dryRun) {
  data = data || {};
  const area = normalizeArea_(data.area);
  const ctx = getContext_(area);
  const s = ctx.settings;

  if (!dryRun) {
    const dup = findDuplicate_(area, str_(data.clientRequestId));
    if (dup) return dup;
  }
  checkUnit_(data.unit, s);
  const req = baseRequest_(data, s);
  const L = requireLocation_(ctx, data.locationId, false);
  const errors = [], warnings = [];

  let allocs = [];
  try { allocs = resolveAllocations_(ctx, L, data); } catch (e) { errors.push(e.message); }
  validatePlan_(req.planId, area, "OUTBOUND", errors);
  if (!req.reference) warnings.push("reference is empty (e.g. STF number)");

  const customerId = str_(data.customerId);
  const drafts = allocs.map(function (a) { return moveDraft_("OUT", L, a, { Customer_ID: customerId }); });
  const allocationView = allocationView_(allocs);
  const before = locationTotal_(ctx.state, L.id);
  const total = allocs.reduce(function (sum, a) { return sum + a.qty; }, 0);

  if (!errors.length) {
    const sim = simulate_(ctx, drafts, {});
    pushAll_(errors, sim.errors);
    pushAll_(warnings, sim.warnings);
  }

  if (dryRun || errors.length) {
    const view = { area: area, locationId: L.id, locationBefore: before, locationAfter: before - total, allocations: allocationView };
    if (!dryRun) throw validationError_(errors, view);
    return Object.assign({ success: true, dryRun: true, valid: errors.length === 0, errors: errors, warnings: warnings }, view);
  }

  const docId = nextDocId_(area);
  const txns = finalizeTxns_(area, drafts, req, docId, "");
  commit_([{ area: area, txns: txns, lots: [] }]);

  return {
    success: true, message: "Outbound posted", area: area, docId: docId,
    transactionIds: txns.map(function (t) { return t.Transaction_ID; }),
    locationId: L.id, locationBefore: before, locationAfter: before - total,
    allocations: allocationView, warnings: warnings
  };
}


/* ============================ POST: TRANSFER ============================ */

/**
 * data: {
 *   fromArea, fromLocationId, toArea, toLocationId, qty,
 *   lotId? | allocations?:[{lotId, qty}]  (ไม่ระบุ = LIFO จากต้นทาง)
 *   reference, remark, transactionDate?, clientRequestId?
 * }
 * N↔CN ข้ามไฟล์ได้ — Lot master จะถูก copy ไปไฟล์ปลายทางด้วย Lot_ID เดิม
 */
function createTransfer(data)  { return withLock_(function () { return opTransfer_(data, false); }); }
function previewTransfer(data) { return withLock_(function () { return opTransfer_(data, true); }); }

function opTransfer_(data, dryRun) {
  data = data || {};
  const fromArea = normalizeArea_(data.fromArea);
  const toArea = normalizeArea_(data.toArea);
  const src = getContext_(fromArea);
  const dst = getContext_(toArea);
  const s = src.settings;

  if (!dryRun) {
    const dup = findDuplicate_(fromArea, str_(data.clientRequestId));
    if (dup) return dup;
  }
  checkUnit_(data.unit, s);
  if (dst.settings.STOCK_UNIT !== s.STOCK_UNIT) throw new Error("STOCK_UNIT differs between N and CN");
  const req = baseRequest_(data, s);
  const Lf = requireLocation_(src, data.fromLocationId, false);
  const Lt = requireLocation_(dst, data.toLocationId, true);
  if (fromArea === toArea && Lf.key === Lt.key) throw new Error("Source and destination location are the same");

  const errors = [], warnings = [];
  let allocs = [];
  try { allocs = resolveAllocations_(src, Lf, data); } catch (e) { errors.push(e.message); }

  const outDrafts = allocs.map(function (a) { return moveDraft_("TRANSFER_OUT", Lf, a); });
  const inDrafts = allocs.map(function (a) { return moveDraft_("TRANSFER_IN", Lt, a); });

  if (!errors.length) {
    const sims = fromArea === toArea
      ? [simulate_(src, outDrafts.concat(inDrafts), {})]
      : [simulate_(src, outDrafts, {}), simulate_(dst, inDrafts, {})];
    sims.forEach(function (sim) { pushAll_(errors, sim.errors); pushAll_(warnings, sim.warnings); });
  }

  const view = {
    from: { area: fromArea, locationId: Lf.id, before: locationTotal_(src.state, Lf.id) },
    to: { area: toArea, locationId: Lt.id, before: locationTotal_(dst.state, Lt.id), capacity: Lt.capacity },
    allocations: allocationView_(allocs)
  };
  if (dryRun || errors.length) {
    if (!dryRun) throw validationError_(errors, view);
    return Object.assign({ success: true, dryRun: true, valid: errors.length === 0, errors: errors, warnings: warnings }, view);
  }

  const transferId = nextTransferId_();
  const outTx = finalizeTxns_(fromArea, outDrafts, req, transferId, transferId);
  const inTx = finalizeTxns_(toArea, inDrafts, req, transferId, transferId);

  let parts;
  if (fromArea === toArea) {
    parts = [{ area: fromArea, txns: outTx.concat(inTx), lots: [] }];
  } else {
    const dstLots = ctxLots_(dst), srcLots = ctxLots_(src);
    const copies = [], seen = {};
    allocs.forEach(function (a) {
      const k = up_(a.row.Lot_ID);
      if (!k || seen[k] || dstLots[k]) return;
      seen[k] = true;
      const m = srcLots[k] || {};
      copies.push({
        Lot_ID: a.row.Lot_ID, Supplier_ID: m.Supplier_ID || a.row.Supplier_ID,
        Rice_Type: m.Rice_Type || a.row.Rice_Type, Grade: m.Grade || a.row.Grade,
        Receive_Date: m.Receive_Date || "", Original_Qty: m.Original_Qty || "", Unit: s.STOCK_UNIT,
        Status: "OPEN", Created_Transaction_ID: m.Created_Transaction_ID || "",
        Remark: "Copied from " + fromArea + " via " + transferId,
        Origin_Area: m.Origin_Area || fromArea
      });
    });
    parts = [
      { area: fromArea, txns: outTx, lots: [] },
      { area: toArea, txns: inTx, lots: copies }
    ];
  }
  commit_(parts);

  return {
    success: true, message: "Transfer posted", transferId: transferId,
    outboundTransactionIds: outTx.map(function (t) { return t.Transaction_ID; }),
    inboundTransactionIds: inTx.map(function (t) { return t.Transaction_ID; }),
    from: view.from, to: view.to, allocations: view.allocations, warnings: warnings
  };
}


/* ============================ POST: ADJUSTMENT ============================ */

/**
 * data: { area, locationId, direction:"IN"|"OUT", qty, lotId, reason,
 *         reconciliationId?, transactionDate?, clientRequestId? }
 * Adjustment สะท้อนของจริงจากการนับ → Capacity/Mixing เป็นคำเตือน ไม่ block
 * แต่ Negative Stock ยัง block
 */
function createAdjustment(data)  { return withLock_(function () { return opAdjustment_(data, false); }); }
function previewAdjustment(data) { return withLock_(function () { return opAdjustment_(data, true); }); }

function opAdjustment_(data, dryRun) {
  data = data || {};
  const area = normalizeArea_(data.area);
  const ctx = getContext_(area);
  const s = ctx.settings;

  if (!dryRun) {
    const dup = findDuplicate_(area, str_(data.clientRequestId));
    if (dup) return dup;
  }
  checkUnit_(data.unit, s);
  const req = baseRequest_(data, s);
  const direction = up_(data.direction);
  if (direction !== "IN" && direction !== "OUT") throw new Error('direction must be "IN" or "OUT"');
  const L = requireLocation_(ctx, data.locationId, false);
  const qty = parseQty_(data.qty, s);
  const lotId = requireStr_(data.lotId, "lotId");
  const reason = requireStr_(data.reason || data.remark, "reason");
  if (str_(data.reconciliationId)) req.reference = str_(data.reconciliationId);

  const errors = [], warnings = [];
  const row = ctx.state[skey_(L.id, lotId)];
  const master = ctxLots_(ctx)[up_(lotId)];
  if (!row && !master) errors.push("Lot " + lotId + " is unknown in " + area + " (not in Lots and not at " + L.id + ")");
  const srcInfo = row || master || {};

  const draft = {
    Transaction_Type: direction === "IN" ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT",
    Location_ID: L.id, Lot_ID: str_(srcInfo.Lot_ID) || lotId,
    Rice_Type: str_(srcInfo.Rice_Type), Grade: str_(srcInfo.Grade), Supplier_ID: str_(srcInfo.Supplier_ID),
    Qty: qty, Remark: reason
  };
  if (!errors.length) {
    const sim = simulate_(ctx, [draft], { softCapacity: true, softMixing: true, softUnmapped: true });
    pushAll_(errors, sim.errors);
    pushAll_(warnings, sim.warnings);
  }
  const view = { area: area, locationId: L.id, lotId: draft.Lot_ID, lotQtyBefore: row ? row.Qty : 0, direction: direction, qty: qty };
  if (dryRun || errors.length) {
    if (!dryRun) throw validationError_(errors, view);
    return Object.assign({ success: true, dryRun: true, valid: errors.length === 0, errors: errors, warnings: warnings }, view);
  }

  const docId = nextDocId_(area);
  const txns = finalizeTxns_(area, [draft], req, docId, "");
  commit_([{ area: area, txns: txns, lots: [] }]);
  return Object.assign({ success: true, message: "Adjustment posted", docId: docId, transactionId: txns[0].Transaction_ID, warnings: warnings }, view);
}


/* ============================ POST: REVERSAL ============================ */

/**
 * แก้รายการที่บันทึกผิดโดยไม่ลบ: สร้างรายการกลับทิศ (Reversal_Of = Transaction เดิม)
 * data: { docId (หรือ transactionId), reason, clientRequestId? }
 * Transfer ข้าม N/CN จะถูก reverse ทั้งสองฝั่งพร้อมกัน
 */
function reverseDocument(data) { return withLock_(function () { return opReverse_(data || {}); }); }

function opReverse_(data) {
  const id = requireStr_(data.docId || data.transactionId, "docId");
  const reason = requireStr_(data.reason, "reason");
  const crid = str_(data.clientRequestId);
  const revDocId = "REV-" + id;

  if (crid) {
    for (let i = 0; i < AREAS.length; i++) {
      const dup = findDuplicate_(AREAS[i], crid);
      if (dup) return dup;
    }
  }

  const found = [];
  AREAS.forEach(function (a) {
    const t = readTable_(a, SHEETS.TRANSACTIONS);
    const reversed = {};
    t.rows.forEach(function (r) { if (str_(r.Reversal_Of) && isEffective_(r)) reversed[up_(r.Reversal_Of)] = true; });
    const rows = t.rows.filter(function (r) {
      return isEffective_(r) && (up_(r.Doc_ID) === up_(id) || up_(r.Transaction_ID) === up_(id));
    });
    rows.forEach(function (r) {
      if (str_(r.Reversal_Of)) throw new Error(r.Transaction_ID + " is itself a reversal — post a new transaction instead");
      if (reversed[up_(r.Transaction_ID)]) throw new Error(r.Transaction_ID + " has already been reversed");
      if (!REVERSE_TYPE[up_(r.Transaction_Type)]) throw new Error(r.Transaction_ID + " has unknown type " + r.Transaction_Type);
    });
    if (rows.length) found.push({ area: a, rows: rows });
  });
  if (!found.length) throw new Error("No posted transactions found for " + id);

  const errors = [], warnings = [];
  found.forEach(function (f) {
    f.ctx = getContext_(f.area);
    f.req = {
      date: parseDate_("", f.ctx.settings), reference: id, remark: "REVERSAL: " + reason,
      clientRequestId: crid, planId: "", user: currentUser_(data)
    };
    f.drafts = f.rows.map(function (r) {
      return {
        Transaction_Type: REVERSE_TYPE[up_(r.Transaction_Type)], Location_ID: str_(r.Location_ID),
        Lot_ID: str_(r.Lot_ID), Rice_Type: str_(r.Rice_Type), Grade: str_(r.Grade),
        Supplier_ID: str_(r.Supplier_ID), Qty: num_(r.Qty), Customer_ID: str_(r.Customer_ID),
        Reversal_Of: str_(r.Transaction_ID), Plan_ID: str_(r.Plan_ID)
      };
    });
    const sim = simulate_(f.ctx, f.drafts, { softCapacity: true, softMixing: true, softUnmapped: true });
    pushAll_(errors, sim.errors.map(function (e) { return "Cannot reverse (" + f.area + "): " + e; }));
    pushAll_(warnings, sim.warnings);
  });
  if (errors.length) throw validationError_(errors, { docId: id });

  const parts = found.map(function (f) {
    return { area: f.area, txns: finalizeTxns_(f.area, f.drafts, f.req, revDocId, ""), lots: [] };
  });
  commit_(parts);

  return {
    success: true, message: "Reversal posted", docId: revDocId, reversedDocOrTransaction: id,
    transactionIds: parts.reduce(function (acc, p) { return acc.concat(p.txns.map(function (t) { return t.Transaction_ID; })); }, []),
    warnings: warnings
  };
}


/* ============================ POST: PLANNING ============================ */

/**
 * data: { area (บังคับ), planType:"INBOUND"|"OUTBOUND", planDate:"YYYY-MM-DD", qty, riceType,
 *         grade?, supplierId?, customerId?, preferredLocation?, reference?, status?, remark? }
 * Planning ไม่กระทบ Actual Stock
 */
function createPlan(data) { return withLock_(function () { return opCreatePlan_(data || {}); }); }

function opCreatePlan_(data) {
  const area = normalizeArea_(data.area);
  const ctx = getContext_(area);
  const s = ctx.settings;
  checkUnit_(data.unit, s);

  const planType = up_(data.planType);
  if (PLAN_TYPES.indexOf(planType) < 0) throw new Error("planType must be " + PLAN_TYPES.join(" or "));
  const status = up_(data.status || "FORECAST");
  if (PLAN_OPEN_STATUSES.indexOf(status) < 0) throw new Error("New plan status must be one of " + PLAN_OPEN_STATUSES.join(", "));
  const planDate = parseDate_(requireStr_(data.planDate, "planDate"), null, "planDate");
  const qty = parseQty_(data.qty, s);
  const riceType = requireStr_(data.riceType, "riceType");

  const errors = [], warnings = [];
  validateMaster_(ctx, riceType, str_(data.supplierId), errors, warnings);
  let pref = "";
  if (str_(data.preferredLocation)) pref = requireLocation_(ctx, data.preferredLocation, planType === "INBOUND").id;
  if (errors.length) throw validationError_(errors, null);

  const planId = nextPlanId_(area);
  const user = currentUser_(data);
  appendObjects_(area, SHEETS.PLANNING, [{
    Plan_ID: planId, Plan_Date: planDate, Plan_Type: planType, Supplier_ID: str_(data.supplierId),
    Customer_ID: str_(data.customerId), Rice_Type: riceType, Grade: str_(data.grade), Qty: qty,
    Unit: s.STOCK_UNIT, Area: area, Preferred_Location: pref, Reference: str_(data.reference),
    Status: status, Created_By: user, Remark: str_(data.remark), Updated_At: new Date(), Updated_By: user
  }]);
  return { success: true, message: "Plan created", planId: planId, warnings: warnings };
}

function updatePlan(planId, data) { return withLock_(function () { return opUpdatePlan_(planId, data || {}); }); }

function opUpdatePlan_(planId, data) {
  const p = findPlan_(requireStr_(planId, "planId"));
  if (!p) throw new Error("Plan not found: " + planId);
  const cur = up_(p.row.Status);
  if (cur === "COMPLETED" || cur === "CANCELLED") throw new Error("Plan " + p.row.Plan_ID + " is " + cur + " and cannot be changed");
  if (!isBlank_(data.area) && normalizeArea_(data.area) !== p.area) {
    throw new Error("Area cannot be changed. Cancel this plan and create a new one in the other area.");
  }
  const ctx = getContext_(p.area);
  const s = ctx.settings;
  const changes = {};
  const errors = [], warnings = [];

  if (data.planDate !== undefined) changes.Plan_Date = parseDate_(requireStr_(data.planDate, "planDate"), null, "planDate");
  if (data.qty !== undefined) changes.Qty = parseQty_(data.qty, s);
  if (data.status !== undefined) {
    const st = up_(data.status);
    if (PLAN_STATUSES.indexOf(st) < 0) throw new Error("status must be one of " + PLAN_STATUSES.join(", "));
    changes.Status = st;
  }
  if (data.preferredLocation !== undefined) {
    changes.Preferred_Location = str_(data.preferredLocation)
      ? requireLocation_(ctx, data.preferredLocation, false).id : "";
  }
  if (data.riceType !== undefined) {
    changes.Rice_Type = requireStr_(data.riceType, "riceType");
    validateMaster_(ctx, changes.Rice_Type, "", errors, warnings);
  }
  if (data.supplierId !== undefined) {
    changes.Supplier_ID = str_(data.supplierId);
    validateMaster_(ctx, "", changes.Supplier_ID, errors, warnings);
  }
  [["customerId", "Customer_ID"], ["grade", "Grade"], ["reference", "Reference"], ["remark", "Remark"]]
    .forEach(function (m) { if (data[m[0]] !== undefined) changes[m[1]] = str_(data[m[0]]); });
  if (errors.length) throw validationError_(errors, null);
  if (!Object.keys(changes).length) throw new Error("Nothing to update");

  changes.Updated_At = new Date();
  changes.Updated_By = currentUser_(data);
  const range = p.sheet.getRange(p.row._row, 1, 1, p.headers.length);
  const vals = range.getValues()[0];
  Object.keys(changes).forEach(function (k) {
    const i = p.headers.indexOf(k);
    if (i < 0) throw new Error("Planning is missing column " + k + " — run setupBackend()");
    vals[i] = changes[k];
  });
  range.setValues([vals]);
  return { success: true, message: "Plan updated", planId: p.row.Plan_ID, updated: Object.keys(changes), warnings: warnings };
}


/* ============================ GET APIs ============================ */

function getDashboard() {
  return withLock_(function () {
    const today = fmtDate_(new Date());
    const horizon = fmtDate_(new Date(Date.now() + CONFIG.PLANNING_HORIZON_DAYS * 86400000));
    const areas = {};
    const alerts = [];
    const total = { stock: 0, capacity: 0, stockInMappedLocations: 0, incoming: 0, outbound: 0 };
    let unit = "";

    AREAS.forEach(function (a) {
      const ctx = getContext_(a);
      unit = ctx.settings.STOCK_UNIT;
      const summary = summarizeLocations_(ctx);
      const stock = sumBy_(summary, "Stock");
      const mapped = summary.filter(function (x) { return x.Active === true && x.Capacity !== ""; });
      const capacity = sumBy_(mapped, "Capacity");
      const stockMapped = sumBy_(mapped, "Stock");
      const unmapped = summary.filter(function (x) { return x.Active === true && x.Capacity === ""; }).length;

      const plans = readTable_(a, SHEETS.PLANNING).rows.filter(function (r) {
        const d = dateStr_(r.Plan_Date);
        return PLAN_OPEN_STATUSES.indexOf(up_(r.Status)) >= 0 && d >= today && d <= horizon;
      });
      const incoming = plans.filter(function (r) { return up_(r.Plan_Type) === "INBOUND"; });
      const outgoing = plans.filter(function (r) { return up_(r.Plan_Type) === "OUTBOUND"; });
      const pending = incoming.filter(function (r) { return PLAN_PENDING_ALLOCATION.indexOf(up_(r.Status)) >= 0; });
      const inQty = sumBy_(incoming, "Qty"), outQty = sumBy_(outgoing, "Qty");
      const free = capacity - stockMapped;

      areas[a] = {
        stock: stock, capacity: capacity, freeCapacity: free,
        utilization: capacity ? stockMapped / capacity : null,
        unmappedLocations: unmapped, capacityComplete: unmapped === 0,
        incomingNextDays: inQty, outboundNextDays: outQty,
        pendingAllocation: { count: pending.length, qty: sumBy_(pending, "Qty") },
        projectedStock: stock + inQty - outQty,
        projectedFreeCapacity: free - inQty + outQty,
        locations: summary
      };

      summary.forEach(function (x) {
        const map = {
          OVER_CAPACITY: ["OVER_CAPACITY", "HIGH", x.Stock + " / " + x.Capacity],
          NEGATIVE: ["NEGATIVE_STOCK", "HIGH", "Negative lot balance at location"],
          INVALID_MIXING: ["INVALID_MIXING", "HIGH", x.Rice_Types],
          UNKNOWN_LOCATION: ["UNKNOWN_LOCATION", "HIGH", "Stock at location not in Locations sheet"],
          INACTIVE_WITH_STOCK: ["INACTIVE_WITH_STOCK", "MEDIUM", x.Stock + " in inactive location"],
          FULL: ["CAPACITY_RISK", "MEDIUM", "Full " + x.Stock + " / " + x.Capacity],
          HIGH: ["CAPACITY_RISK", "LOW", "Utilization " + Math.round(x.Utilization * 100) + "%"]
        };
        const m = map[x.Status];
        if (m) alerts.push(alert_(m[0], m[1], a, x.Location_ID, m[2]));
      });
      if (unmapped) alerts.push(alert_("CAPACITY_NOT_MAPPED", "LOW", a, "", unmapped + " active locations have no Capacity"));
      if (capacity && inQty > 0 && free - inQty + outQty < 0) {
        alerts.push(alert_("CAPACITY_RISK", "HIGH", a, "", "Projected free capacity in " + CONFIG.PLANNING_HORIZON_DAYS + " days = " + (free - inQty + outQty)));
      }
      if (pending.length) alerts.push(alert_("PENDING_ALLOCATION", "MEDIUM", a, "", pending.length + " inbound plans (" + sumBy_(pending, "Qty") + ") not allocated"));
      readTable_(a, SHEETS.RECONCILIATION).rows.forEach(function (r) {
        if (num_(r.Difference) !== 0 && RECON_CLOSED_STATUSES.indexOf(up_(r.Status)) < 0) {
          alerts.push(alert_("RECONCILIATION_DIFFERENCE", "MEDIUM", a, str_(r.Location_ID), str_(r.Reconciliation_ID) + ": difference " + r.Difference));
        }
      });

      total.stock += stock;
      total.capacity += capacity;
      total.stockInMappedLocations += stockMapped;
      total.incoming += inQty;
      total.outbound += outQty;
    });

    total.freeCapacity = total.capacity - total.stockInMappedLocations;
    total.utilization = total.capacity ? total.stockInMappedLocations / total.capacity : null;

    return {
      success: true, version: CONFIG.VERSION, unit: unit, generatedAt: new Date(),
      horizonDays: CONFIG.PLANNING_HORIZON_DAYS, total: total, areas: areas, alerts: alerts
    };
  });
}

function getLocations(area) {
  return withLock_(function () {
    const areas = area ? [normalizeArea_(area)] : AREAS;
    let list = [];
    areas.forEach(function (a) { list = list.concat(summarizeLocations_(getContext_(a))); });
    return { success: true, area: area || "ALL", locations: list };
  });
}

function getCapacity(area) {
  return withLock_(function () {
    const areas = area ? [normalizeArea_(area)] : AREAS;
    const result = {};
    areas.forEach(function (a) {
      const summary = summarizeLocations_(getContext_(a));
      const mapped = summary.filter(function (x) { return x.Active === true && x.Capacity !== ""; });
      const cap = sumBy_(mapped, "Capacity"), used = sumBy_(mapped, "Stock");
      result[a] = {
        capacity: cap, usedInMappedLocations: used, freeCapacity: cap - used,
        utilization: cap ? used / cap : null, totalStock: sumBy_(summary, "Stock"),
        unmappedLocations: summary.filter(function (x) { return x.Active === true && x.Capacity === ""; }).length,
        locations: summary
      };
    });
    return { success: true, areas: result };
  });
}

function getCurrentStock(area) {
  return withLock_(function () {
    const areas = area ? [normalizeArea_(area)] : AREAS;
    let rows = [];
    areas.forEach(function (a) { rows = rows.concat(stockRows_(getContext_(a))); });
    return { success: true, area: area || "ALL", stock: rows };
  });
}

/** สต็อกใน Location เรียงตามลำดับ LIFO (ตัวแรก = จะถูกจ่ายก่อน) */
function getStockByLocation(locationId, area) {
  return withLock_(function () {
    const id = requireStr_(locationId, "locationId");
    const areas = area ? [normalizeArea_(area)] : AREAS;
    for (let i = 0; i < areas.length; i++) {
      const ctx = getContext_(areas[i]);
      const L = ctx.locs[up_(id)];
      const rows = stockRows_(ctx).filter(function (r) { return up_(r.Location_ID) === up_(id); });
      if (!L && !rows.length) continue;
      const summary = summarizeLocations_(ctx).filter(function (x) { return up_(x.Location_ID) === up_(id); })[0] || null;
      return {
        success: true, area: areas[i], locationId: L ? L.id : id, summary: summary,
        lifoOrder: rows.map(function (r, idx) { return Object.assign({ LIFO_Rank: idx + 1 }, r); })
      };
    }
    throw new Error("Location not found: " + id);
  });
}

/** Traceability: Lot มาจาก Supplier ไหน อยู่ไหน รับเมื่อไร จ่ายออกไปเท่าไร เหลือเท่าไร */
function getLot(lotId) {
  return withLock_(function () {
    const id = up_(requireStr_(lotId, "lotId"));
    const masters = [], locations = [], history = [];
    const totals = { received: 0, shipped: 0, transferredIn: 0, transferredOut: 0, adjustedIn: 0, adjustedOut: 0 };
    const field = { IN: "received", OUT: "shipped", TRANSFER_IN: "transferredIn", TRANSFER_OUT: "transferredOut", ADJUSTMENT_IN: "adjustedIn", ADJUSTMENT_OUT: "adjustedOut" };

    AREAS.forEach(function (a) {
      const ctx = getContext_(a);
      const m = ctxLots_(ctx)[id];
      if (m) masters.push(Object.assign({ Area: a }, m));
      Object.keys(ctx.state).forEach(function (k) {
        const r = ctx.state[k];
        if (up_(r.Lot_ID) === id && r.Qty !== 0) {
          locations.push({ area: a, locationId: r.Location_ID, qty: r.Qty, lastInDate: r.Last_In_Date, lastInSeq: r.Last_In_Seq });
        }
      });
      readTable_(a, SHEETS.TRANSACTIONS).rows.forEach(function (r) {
        if (up_(r.Lot_ID) !== id || !isEffective_(r)) return;
        history.push(r);
        const f = field[up_(r.Transaction_Type)];
        if (f) totals[f] += num_(r.Qty);
      });
    });
    if (!masters.length && !history.length) throw new Error("Lot not found: " + lotId);

    history.sort(function (a, b) { return (toTime_(a.Timestamp) - toTime_(b.Timestamp)) || (num_(a.Seq) - num_(b.Seq)); });
    const master = masters.filter(function (m) { return !str_(m.Origin_Area) || up_(m.Origin_Area) === m.Area; })[0] || masters[0] || null;
    const firstIn = history.filter(function (h) { return up_(h.Transaction_Type) === "IN"; })[0];

    return {
      success: true, lotId: master ? master.Lot_ID : lotId, master: master, masters: masters,
      supplierId: master ? master.Supplier_ID : (firstIn ? firstIn.Supplier_ID : ""),
      firstReceived: firstIn ? { date: firstIn.Transaction_Date, area: firstIn.Area, locationId: firstIn.Location_ID, qty: firstIn.Qty, transactionId: firstIn.Transaction_ID } : null,
      onHand: locations.reduce(function (s, x) { return s + x.qty; }, 0),
      locations: locations,
      totals: totals,
      shipments: history.filter(function (h) { return up_(h.Transaction_Type) === "OUT"; }).map(function (h) {
        return { transactionId: h.Transaction_ID, docId: h.Doc_ID, date: h.Transaction_Date, area: h.Area, locationId: h.Location_ID, qty: h.Qty, reference: h.Reference, customerId: h.Customer_ID };
      }),
      history: history
    };
  });
}

/** ค้นหา Lot จาก Lot_ID / Supplier / Rice / Remark / Reference ของ Transaction (เช่น STF 095/26) */
function searchLot(keyword) {
  return withLock_(function () {
    const kw = up_(keyword);
    if (kw.length < 2) throw new Error("keyword must be at least 2 characters");
    const results = {};
    const add = function (lotId, base, area, matchedBy) {
      const k = up_(lotId);
      if (!k) return;
      if (!results[k]) results[k] = Object.assign({ Lot_ID: str_(lotId), Areas: [], MatchedBy: [], OnHand: 0 }, base || {});
      if (area && results[k].Areas.indexOf(area) < 0) results[k].Areas.push(area);
      if (results[k].MatchedBy.indexOf(matchedBy) < 0) results[k].MatchedBy.push(matchedBy);
    };
    AREAS.forEach(function (a) {
      readTable_(a, SHEETS.LOTS).rows.forEach(function (r) {
        const hay = [r.Lot_ID, r.Supplier_ID, r.Rice_Type, r.Grade, r.Remark].map(up_).join(" | ");
        if (hay.indexOf(kw) >= 0) add(r.Lot_ID, r, a, "LOT");
      });
      readTable_(a, SHEETS.TRANSACTIONS).rows.forEach(function (r) {
        if (isEffective_(r) && up_(r.Reference).indexOf(kw) >= 0) add(r.Lot_ID, null, a, "REFERENCE:" + str_(r.Reference));
      });
    });
    AREAS.forEach(function (a) {
      const st = getContext_(a).state;
      Object.keys(st).forEach(function (k) {
        const res = results[up_(st[k].Lot_ID)];
        if (res) res.OnHand += st[k].Qty;
      });
    });
    const list = Object.keys(results).map(function (k) { return results[k]; }).slice(0, 50);
    return { success: true, keyword: keyword, count: list.length, lots: list };
  });
}

/** Planning + Actual (จาก Transactions ที่อ้าง Plan_ID) → Forecast vs Actual */
function getPlanning(dateFrom, dateTo, area) {
  return withLock_(function () {
    const from = isBlank_(dateFrom) ? "0000-00-00" : fmtDate_(parseDate_(dateFrom, null, "from"));
    const to = isBlank_(dateTo) ? "9999-99-99" : fmtDate_(parseDate_(dateTo, null, "to"));
    const areas = area ? [normalizeArea_(area)] : AREAS;
    const plans = [];
    areas.forEach(function (a) {
      const actual = actualByPlan_(a);
      readTable_(a, SHEETS.PLANNING).rows.forEach(function (r) {
        const d = dateStr_(r.Plan_Date);
        if (d < from || d > to) return;
        const act = actual[up_(r.Plan_ID)] || 0;
        plans.push(Object.assign({}, r, { Plan_Date: d, Actual_Qty: act, Variance: act - num_(r.Qty) }));
      });
    });
    plans.sort(function (x, y) { return x.Plan_Date.localeCompare(y.Plan_Date); });
    return { success: true, from: from, to: to, plans: plans };
  });
}

function getReconciliation(area) {
  return withLock_(function () {
    const areas = area ? [normalizeArea_(area)] : AREAS;
    let rows = [];
    areas.forEach(function (a) { rows = rows.concat(readTable_(a, SHEETS.RECONCILIATION).rows); });
    return { success: true, area: area || "ALL", reconciliation: rows };
  });
}


/* ============================ CORE: CONTEXT / STATE ============================ */

function withLock_(fn) {
  if (_inLock) return fn();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) throw new Error("System is busy — please retry in a moment");
  _inLock = true;
  _ctxCache = {};   // อ่านข้อมูลสดทุกครั้งที่ได้ Lock
  try {
    return fn();
  } finally {
    _inLock = false;
    _ctxCache = {};
    lock.releaseLock();
  }
}

function getContext_(area) {
  area = normalizeArea_(area);
  if (_ctxCache[area]) return _ctxCache[area];
  if (isDirty_(area)) {
    // การเขียนครั้งก่อนไม่จบ → คำนวณใหม่จาก Transactions ก่อนทำอะไรต่อ
    rebuildArea_(area);
    return _ctxCache[area];
  }
  const ctx = buildCtx_(area, loadStockState_(area));
  _ctxCache[area] = ctx;
  return ctx;
}

function buildCtx_(area, state) {
  const settings = loadSettings_(area);
  if (settings.BACKEND_AREA !== area) {
    throw new Error("Spreadsheet configured as " + area + " reports BACKEND_AREA='" + settings.BACKEND_AREA +
      "'. Run setupBackend() or check CONFIG.SPREADSHEET_IDS.");
  }
  return { area: area, settings: settings, locs: loadLocations_(area, settings), state: state, _lots: null, _rice: null, _sup: null };
}

function ctxLots_(ctx) {
  if (!ctx._lots) ctx._lots = loadLots_(ctx.area);
  return ctx._lots;
}

function loadSettings_(area) {
  const t = readTable_(area, SHEETS.SETTINGS);
  const s = {};
  DEFAULT_SETTINGS.forEach(function (d) { s[d[0]] = d[1]; });
  t.rows.forEach(function (r) {
    const k = str_(r.Key);
    if (k) s[k] = r.Value;
  });
  s.BACKEND_AREA = up_(s.BACKEND_AREA);
  s.STOCK_UNIT = up_(s.STOCK_UNIT) || "JUMBO";
  ["LIFO_ENABLED", "QTY_INTEGER_ONLY", "BLOCK_UNMAPPED_CAPACITY", "ALLOW_FUTURE_DATE", "ALLOW_MIX_RICE_CN"]
    .forEach(function (k) { s[k] = toBool_(s[k]); });
  s.CN_DEFAULT_CAPACITY = Number(s.CN_DEFAULT_CAPACITY) || 278;
  return s;
}

function loadLocations_(area, settings) {
  const t = readTable_(area, SHEETS.LOCATIONS);
  const map = {};
  t.rows.forEach(function (r) {
    const id = str_(r.Location_ID);
    if (!id) return;
    const key = id.toUpperCase();
    if (map[key]) throw new Error("Duplicate Location_ID in " + area + "/Locations: " + id);
    const locArea = up_(r.Area) || area;
    map[key] = {
      key: key, id: id, area: locArea, zone: str_(r.Zone),
      capacity: parseCapacity_(r.Capacity),
      unit: up_(r.Unit),
      active: isBlank_(r.Active) ? true : toBool_(r.Active),
      allowMix: isBlank_(r.Allow_Mix_Rice)
        ? (locArea === "CN" ? settings.ALLOW_MIX_RICE_CN : true)
        : toBool_(r.Allow_Mix_Rice)
    };
  });
  return map;
}

function loadLots_(area) {
  const map = {};
  readTable_(area, SHEETS.LOTS).rows.forEach(function (r) {
    const id = str_(r.Lot_ID);
    if (!id || up_(r.Status) === "VOIDED") return;
    if (!map[up_(id)]) map[up_(id)] = r;   // v1 อาจมีแถวซ้ำ — ใช้แถวแรก
  });
  return map;
}

function loadStockState_(area) {
  const state = {};
  readTable_(area, SHEETS.CURRENT_STOCK).rows.forEach(function (r) {
    const loc = str_(r.Location_ID);
    if (!loc) return;
    state[skey_(loc, r.Lot_ID)] = {
      Area: area, Location_ID: loc, Lot_ID: str_(r.Lot_ID), Rice_Type: str_(r.Rice_Type),
      Grade: str_(r.Grade), Supplier_ID: str_(r.Supplier_ID), Qty: num_(r.Qty),
      Last_In_Seq: num_(r.Last_In_Seq), Last_In_Date: r.Last_In_Date || "",
      Last_Transaction: str_(r.Last_Transaction)
    };
  });
  return state;
}

/**
 * ใช้ Transaction 1 แถวกับ state (key = Location + Lot)
 * strict=true → ห้ามติดลบ (ใช้ตอน validate/commit)
 * strict=false → ยอมติดลบเพื่อสะท้อนข้อมูลจริง (ใช้ตอน rebuild)
 * return ยอดของ Lot นี้ที่ Location นี้หลังรายการ
 */
function applyMovement_(state, t, strict) {
  const type = up_(t.Transaction_Type);
  const qty = num_(t.Qty);
  const loc = str_(t.Location_ID);
  const lot = str_(t.Lot_ID);
  const k = skey_(loc, lot);
  const isIn = IN_TYPES.indexOf(type) >= 0;
  const isOut = OUT_TYPES.indexOf(type) >= 0;
  if (!isIn && !isOut) {
    if (strict) throw new Error("Unknown transaction type: " + t.Transaction_Type);
    return null;
  }
  let row = state[k];
  if (isOut) {
    const have = row ? row.Qty : 0;
    if (strict && have < qty) {
      throw new Error("Insufficient stock at " + loc + " / " + (lot || "(no lot)") + ": Available=" + have + ", Requested=" + qty);
    }
  }
  if (!row) {
    row = state[k] = {
      Area: t.Area || "", Location_ID: loc, Lot_ID: lot, Rice_Type: str_(t.Rice_Type), Grade: str_(t.Grade),
      Supplier_ID: str_(t.Supplier_ID), Qty: 0, Last_In_Seq: 0, Last_In_Date: "", Last_Transaction: ""
    };
  }
  if (isIn) {
    // Reversal ของ OUT คืนของกลับที่เดิม → ไม่ย้ายตำแหน่ง LIFO ถ้า Lot ยังมีของอยู่
    const keepPosition = str_(t.Reversal_Of) && row.Qty > 0;
    row.Qty += qty;
    if (!keepPosition) {
      row.Last_In_Seq = num_(t.Seq);
      row.Last_In_Date = t.Transaction_Date || "";
    }
  } else {
    row.Qty -= qty;
  }
  if (t.Transaction_ID) row.Last_Transaction = t.Transaction_ID;
  return row.Qty;
}

function cloneState_(state) {
  const c = {};
  Object.keys(state).forEach(function (k) { c[k] = Object.assign({}, state[k]); });
  return c;
}

function locRows_(state, loc) {
  const key = up_(loc);
  return Object.keys(state)
    .map(function (k) { return state[k]; })
    .filter(function (r) { return up_(r.Location_ID) === key; });
}

function locationTotal_(state, loc) {
  return locRows_(state, loc).reduce(function (s, r) { return s + r.Qty; }, 0);
}

function riceTypesAt_(state, loc) {
  const set = {};
  locRows_(state, loc).forEach(function (r) { if (r.Qty > 0) set[up_(r.Rice_Type)] = r.Rice_Type; });
  return Object.keys(set).map(function (k) { return set[k]; });
}

/**
 * Validate ผลลัพธ์สุดท้ายของเอกสารทั้งใบบน state จำลอง:
 * Negative Stock, Over Capacity, Rice Mixing (ตาม Allow_Mix_Rice ของ Location)
 */
function simulate_(ctx, drafts, opts) {
  opts = opts || {};
  const errors = [], warnings = [];
  const st = cloneState_(ctx.state);
  try {
    drafts.forEach(function (d) { applyMovement_(st, d, true); });
  } catch (e) {
    errors.push(e.message);
    return { errors: errors, warnings: warnings, state: st };
  }
  const touched = {};
  drafts.forEach(function (d) {
    if (IN_TYPES.indexOf(up_(d.Transaction_Type)) >= 0) touched[up_(d.Location_ID)] = d.Location_ID;
  });
  Object.keys(touched).forEach(function (k) {
    const L = ctx.locs[k];
    if (!L) { errors.push("Invalid location: " + touched[k]); return; }
    const before = locationTotal_(ctx.state, L.id);
    const after = locationTotal_(st, L.id);
    if (L.capacity === null) {
      const msg = "Capacity of " + L.id + " is not mapped yet (current=" + before + ", after=" + after + ")";
      if (ctx.settings.BLOCK_UNMAPPED_CAPACITY && !opts.softUnmapped) errors.push(msg); else warnings.push(msg);
    } else if (after > L.capacity) {
      const msg = "Capacity exceeded at " + L.id + ": Current=" + before + ", Free=" + Math.max(0, L.capacity - before) +
        ", Incoming=" + (after - before) + ", Capacity=" + L.capacity;
      (opts.softCapacity ? warnings : errors).push(msg);
    }
    if (!L.allowMix) {
      const types = riceTypesAt_(st, L.id);
      if (types.length > 1) {
        (opts.softMixing ? warnings : errors).push("Rice mixing not allowed at " + L.id + ": " + types.join(" + "));
      }
    }
  });
  return { errors: errors, warnings: warnings, state: st };
}

/** เลือก Lot สำหรับ OUT / TRANSFER_OUT: allocations > lotId > LIFO */
function resolveAllocations_(ctx, L, data) {
  const s = ctx.settings;
  if (Array.isArray(data.allocations) && data.allocations.length) {
    const seen = {};
    const allocs = data.allocations.map(function (a, i) {
      const lotId = requireStr_(a && a.lotId, "allocations[" + i + "].lotId");
      if (seen[up_(lotId)]) throw new Error("Lot " + lotId + " appears twice in allocations");
      seen[up_(lotId)] = true;
      const q = parseQty_(a.qty, s, "allocations[" + i + "].qty");
      const row = ctx.state[skey_(L.id, lotId)];
      if (!row || row.Qty <= 0) throw new Error("Lot " + lotId + " has no stock at " + L.id);
      return { row: row, qty: q, mode: "MANUAL" };
    });
    const total = allocs.reduce(function (sum, a) { return sum + a.qty; }, 0);
    if (!isBlank_(data.qty) && parseQty_(data.qty, s) !== total) {
      throw new Error("qty (" + data.qty + ") does not match sum of allocations (" + total + ")");
    }
    return allocs;
  }
  const qty = parseQty_(data.qty, s);
  if (str_(data.lotId)) {
    const row = ctx.state[skey_(L.id, data.lotId)];
    if (!row || row.Qty <= 0) throw new Error("Lot " + data.lotId + " has no stock at " + L.id);
    return [{ row: row, qty: qty, mode: "MANUAL" }];
  }
  if (!s.LIFO_ENABLED) throw new Error("lotId or allocations is required (LIFO_ENABLED = FALSE)");
  return lifoAllocate_(ctx.state, L, qty);
}

/** LIFO ต่อ Location: Lot ที่เข้า Location นี้ล่าสุด (Last_In_Seq สูงสุด) ออกก่อน */
function lifoAllocate_(state, L, qty) {
  const rows = locRows_(state, L.id)
    .filter(function (r) { return r.Qty > 0; })
    .sort(function (a, b) {
      return (b.Last_In_Seq - a.Last_In_Seq) || up_(b.Lot_ID).localeCompare(up_(a.Lot_ID));
    });
  const available = rows.reduce(function (s, r) { return s + r.Qty; }, 0);
  if (available < qty) throw new Error("Insufficient stock at " + L.id + ": Available=" + available + ", Requested=" + qty);
  const out = [];
  let remaining = qty;
  rows.forEach(function (r) {
    if (remaining <= 0) return;
    const take = Math.min(r.Qty, remaining);
    out.push({ row: r, qty: take, mode: "LIFO" });
    remaining -= take;
  });
  return out;
}

function moveDraft_(type, L, a, extra) {
  return Object.assign({
    Transaction_Type: type, Location_ID: L.id, Lot_ID: a.row.Lot_ID, Rice_Type: a.row.Rice_Type,
    Grade: a.row.Grade, Supplier_ID: a.row.Supplier_ID, Qty: a.qty
  }, extra || {});
}

function allocationView_(allocs) {
  return allocs.map(function (a) {
    return {
      lotId: a.row.Lot_ID, qty: a.qty, lotQtyBefore: a.row.Qty, lotQtyAfter: a.row.Qty - a.qty,
      riceType: a.row.Rice_Type, grade: a.row.Grade, supplierId: a.row.Supplier_ID,
      lastInDate: a.row.Last_In_Date, mode: a.mode
    };
  });
}


/* ============================ CORE: POSTING ============================ */

function finalizeTxns_(area, drafts, req, docId, transferId) {
  const now = new Date();
  const unit = getContext_(area).settings.STOCK_UNIT;
  return drafts.map(function (d) {
    return {
      Transaction_ID: nextTxnId_(area), Timestamp: now, Transaction_Date: req.date,
      Transaction_Type: d.Transaction_Type, Area: area, Location_ID: d.Location_ID,
      Rice_Type: d.Rice_Type || "", Grade: d.Grade || "", Supplier_ID: d.Supplier_ID || "",
      Lot_ID: d.Lot_ID || "", Qty: d.Qty, Unit: unit,
      Reference: d.Reference !== undefined ? d.Reference : req.reference,
      Customer_ID: d.Customer_ID || "", Status: "POSTED", User: req.user,
      Remark: d.Remark !== undefined ? d.Remark : req.remark,
      Doc_ID: docId, Transfer_ID: transferId || "", Reversal_Of: d.Reversal_Of || "",
      Client_Request_ID: req.clientRequestId || "",
      Plan_ID: d.Plan_ID !== undefined ? d.Plan_ID : (req.planId || ""),
      Seq: nextSeq_(area)
    };
  });
}

/**
 * ลำดับการเขียน:
 *   1) ตั้ง DIRTY flag
 *   2) Lots (master) → 3) Transactions (Source of Truth)
 *      ถ้าข้อ 3 ล้ม: แถวที่เขียนไปแล้ว Status = VOIDED (ไม่ลบ) แล้ว throw
 *   4) Stock_Ledger + Current_Stock + Location_Summary แล้วล้าง DIRTY
 *      ถ้าข้อ 4 ล้ม: DIRTY ค้าง → รายการถัดไปจะ rebuild จาก Transactions อัตโนมัติ
 */
function commit_(parts) {
  parts.forEach(function (p) { setDirty_(p.area, true); });

  const lotsWritten = [];
  parts.forEach(function (p) {
    if (p.lots && p.lots.length) {
      appendObjects_(p.area, SHEETS.LOTS, p.lots);
      lotsWritten.push(p);
    }
  });

  const txWritten = [];
  try {
    parts.forEach(function (p) {
      appendObjects_(p.area, SHEETS.TRANSACTIONS, p.txns);
      txWritten.push(p);
    });
  } catch (e) {
    txWritten.forEach(function (p) {
      const ids = p.txns.map(function (t) { return up_(t.Transaction_ID); });
      markStatus_(p.area, SHEETS.TRANSACTIONS, function (r) { return ids.indexOf(up_(r.Transaction_ID)) >= 0; }, "VOIDED");
    });
    lotsWritten.forEach(function (p) {
      const pairs = p.lots.map(function (l) { return up_(l.Lot_ID) + "|" + up_(l.Created_Transaction_ID); });
      markStatus_(p.area, SHEETS.LOTS, function (r) { return pairs.indexOf(up_(r.Lot_ID) + "|" + up_(r.Created_Transaction_ID)) >= 0; }, "VOIDED");
    });
    throw new Error("Posting failed — no stock was changed: " + e.message);
  }

  parts.forEach(function (p) {
    const ctx = getContext_(p.area);
    const ledger = p.txns.map(function (t) {
      const bal = applyMovement_(ctx.state, t, true);
      return ledgerRow_(p.area, t, bal, locationTotal_(ctx.state, t.Location_ID));
    });
    ledger.forEach(function (l) { l.Ledger_ID = nextLedgerId_(p.area); });
    appendObjects_(p.area, SHEETS.STOCK_LEDGER, ledger);
    writeDerived_(ctx);
    setDirty_(p.area, false);
  });
  SpreadsheetApp.flush();
}

function ledgerRow_(area, t, bal, locBal) {
  const isIn = IN_TYPES.indexOf(up_(t.Transaction_Type)) >= 0;
  return {
    Ledger_ID: "", Transaction_ID: t.Transaction_ID, Lot_ID: t.Lot_ID, Area: area,
    Location_ID: t.Location_ID, Rice_Type: t.Rice_Type,
    Qty_In: isIn ? num_(t.Qty) : 0, Qty_Out: isIn ? 0 : num_(t.Qty),
    Balance_After: bal, Timestamp: t.Timestamp, Transaction_Type: t.Transaction_Type,
    Grade: t.Grade, Supplier_ID: t.Supplier_ID, Unit: t.Unit,
    Location_Balance_After: locBal, Seq: t.Seq
  };
}

/** คำนวณ state ใหม่ทั้งหมดจาก Transactions ตามลำดับ Seq */
function computeStateFromTransactions_(area) {
  const t = readTable_(area, SHEETS.TRANSACTIONS);
  const txns = t.rows.filter(isEffective_).sort(txnOrder_);
  const state = {}, anomalies = [], ledger = [], locTotals = {};

  txns.forEach(function (r) {
    const type = up_(r.Transaction_Type);
    if (IN_TYPES.indexOf(type) < 0 && OUT_TYPES.indexOf(type) < 0) {
      anomalies.push(r.Transaction_ID + ": unknown type '" + r.Transaction_Type + "'");
      return;
    }
    if (!str_(r.Location_ID)) {
      anomalies.push(r.Transaction_ID + ": missing Location_ID");
      return;
    }
    if (!str_(r.Lot_ID)) anomalies.push(r.Transaction_ID + ": missing Lot_ID");
    const bal = applyMovement_(state, r, false);
    const lk = up_(r.Location_ID);
    locTotals[lk] = (locTotals[lk] || 0) + (IN_TYPES.indexOf(type) >= 0 ? 1 : -1) * num_(r.Qty);
    if (bal < 0) anomalies.push(r.Transaction_ID + ": negative balance " + bal + " at " + r.Location_ID + " / " + (str_(r.Lot_ID) || "(no lot)"));
    ledger.push(ledgerRow_(area, r, bal, locTotals[lk]));
  });
  return { state: state, anomalies: anomalies, ledger: ledger };
}

function rebuildArea_(area) {
  delete _ctxCache[area];
  let before = {};
  try { before = loadStockState_(area); } catch (e) { before = {}; }

  const comp = computeStateFromTransactions_(area);

  // Self-heal Stock_Ledger: เติมเฉพาะ Transaction ที่ยังไม่มี Ledger (ไม่แก้แถวเดิม)
  const have = {};
  readTable_(area, SHEETS.STOCK_LEDGER).rows.forEach(function (r) { have[up_(r.Transaction_ID)] = true; });
  const missing = comp.ledger.filter(function (l) { return !have[up_(l.Transaction_ID)]; });
  missing.forEach(function (l) { l.Ledger_ID = nextLedgerId_(area); });
  appendObjects_(area, SHEETS.STOCK_LEDGER, missing);

  const ctx = buildCtx_(area, comp.state);
  writeDerived_(ctx);
  setDirty_(area, false);
  _ctxCache[area] = ctx;

  const diffs = diffStates_(before, comp.state);
  return {
    area: area,
    stockRows: Object.keys(comp.state).filter(function (k) { return comp.state[k].Qty !== 0; }).length,
    ledgerRowsAdded: missing.length,
    anomalyCount: comp.anomalies.length,
    anomalies: comp.anomalies.slice(0, 100),
    differenceCount: diffs.length,
    differencesFromPrevious: diffs.slice(0, 50)
  };
}

function diffStates_(a, b) {
  const keys = {};
  Object.keys(a).concat(Object.keys(b)).forEach(function (k) { keys[k] = true; });
  const out = [];
  Object.keys(keys).forEach(function (k) {
    const qa = a[k] ? a[k].Qty : 0, qb = b[k] ? b[k].Qty : 0;
    if (qa !== qb) {
      const r = b[k] || a[k];
      out.push({ locationId: r.Location_ID, lotId: r.Lot_ID, previous: qa, rebuilt: qb });
    }
  });
  return out;
}

function summarizeLocations_(ctx) {
  const byLoc = {};
  Object.keys(ctx.locs).forEach(function (k) {
    byLoc[k] = { L: ctx.locs[k], id: ctx.locs[k].id, stock: 0, rice: {}, lots: 0, negative: false };
  });
  Object.keys(ctx.state).forEach(function (k) {
    const r = ctx.state[k];
    if (r.Qty === 0) return;
    const lk = up_(r.Location_ID);
    if (!byLoc[lk]) byLoc[lk] = { L: null, id: r.Location_ID, stock: 0, rice: {}, lots: 0, negative: false };
    const b = byLoc[lk];
    b.stock += r.Qty;
    b.lots++;
    if (r.Qty < 0) b.negative = true; else b.rice[up_(r.Rice_Type)] = r.Rice_Type;
  });
  return Object.keys(byLoc).sort().map(function (k) {
    const b = byLoc[k], L = b.L;
    const cap = L ? L.capacity : null;
    const types = Object.keys(b.rice).map(function (x) { return b.rice[x]; });
    return {
      Area: ctx.area, Location_ID: b.id, Zone: L ? L.zone : "",
      Capacity: cap === null ? "" : cap, Unit: ctx.settings.STOCK_UNIT, Stock: b.stock,
      Free_Capacity: cap === null ? "" : cap - b.stock,
      Utilization: cap ? b.stock / cap : "",
      Rice_Types: types.join(", "), Lot_Count: b.lots,
      Active: L ? L.active : false, Allow_Mix_Rice: L ? L.allowMix : "",
      Status: locStatus_(L, b.stock, types, b.negative)
    };
  });
}

function locStatus_(L, stock, types, negative) {
  if (!L) return "UNKNOWN_LOCATION";
  if (negative) return "NEGATIVE";
  if (L.capacity !== null && stock > L.capacity) return "OVER_CAPACITY";
  if (!L.allowMix && types.length > 1) return "INVALID_MIXING";
  if (!L.active) return stock ? "INACTIVE_WITH_STOCK" : "INACTIVE";
  if (stock === 0) return "EMPTY";
  if (L.capacity === null) return "CAPACITY_NOT_MAPPED";
  if (stock >= L.capacity) return "FULL";
  if (stock / L.capacity >= CONFIG.HIGH_UTILIZATION) return "HIGH";
  return "OK";
}

/** แถว Current_Stock เรียงตาม Location แล้วตาม LIFO */
function stockRows_(ctx) {
  const sum = {};
  summarizeLocations_(ctx).forEach(function (x) { sum[up_(x.Location_ID)] = x; });
  return Object.keys(ctx.state)
    .map(function (k) { return ctx.state[k]; })
    .filter(function (r) { return r.Qty !== 0; })
    .sort(function (a, b) {
      return up_(a.Location_ID).localeCompare(up_(b.Location_ID)) || (b.Last_In_Seq - a.Last_In_Seq);
    })
    .map(function (r) {
      const sm = sum[up_(r.Location_ID)];
      return {
        Area: ctx.area, Location_ID: r.Location_ID, Rice_Type: r.Rice_Type, Grade: r.Grade,
        Lot_ID: r.Lot_ID, Supplier_ID: r.Supplier_ID, Qty: r.Qty, Unit: ctx.settings.STOCK_UNIT,
        Capacity: sm.Capacity, Free_Capacity: sm.Free_Capacity, Utilization: sm.Utilization,
        Last_Transaction: r.Last_Transaction, Stock_Status: r.Qty < 0 ? "NEGATIVE" : sm.Status,
        Last_In_Seq: r.Last_In_Seq, Last_In_Date: r.Last_In_Date
      };
    });
}

function writeDerived_(ctx) {
  const now = new Date();
  replaceTableData_(ctx.area, SHEETS.CURRENT_STOCK, stockRows_(ctx));
  replaceTableData_(ctx.area, SHEETS.LOCATION_SUMMARY, summarizeLocations_(ctx).map(function (x) {
    return Object.assign({}, x, { Updated_At: now });
  }));
}


/* ============================ VALIDATION HELPERS ============================ */

function baseRequest_(data, settings) {
  return {
    date: parseDate_(data.transactionDate, settings, "transactionDate"),
    reference: str_(data.reference),
    remark: str_(data.remark),
    clientRequestId: str_(data.clientRequestId),
    planId: str_(data.planId),
    user: currentUser_(data)
  };
}

function requireLocation_(ctx, locationId, forInbound) {
  const id = requireStr_(locationId, "locationId");
  const L = ctx.locs[up_(id)];
  if (!L) throw new Error("Invalid location for area " + ctx.area + ": " + id);
  if (L.area !== ctx.area) throw new Error("Location " + L.id + " belongs to area " + L.area + ", not " + ctx.area);
  if (L.unit && L.unit !== ctx.settings.STOCK_UNIT) {
    throw new Error("Location " + L.id + " unit is " + L.unit + "; expected " + ctx.settings.STOCK_UNIT + " (fix Locations sheet)");
  }
  if (forInbound && !L.active) throw new Error("Location " + L.id + " is inactive");
  return L;
}

function validateMaster_(ctx, riceType, supplierId, errors, warnings) {
  if (!ctx._rice) ctx._rice = activeSet_(ctx.area, SHEETS.RICE_MASTER, "Rice_Type");
  if (!ctx._sup) ctx._sup = activeSet_(ctx.area, SHEETS.SUPPLIERS, "Supplier_ID");
  if (riceType) {
    if (!ctx._rice.count) warnings.push("Rice_Master (" + ctx.area + ") is empty — rice type not validated");
    else if (!ctx._rice.set[up_(riceType)]) errors.push("Unknown or inactive rice type in " + ctx.area + ": " + riceType);
  }
  if (supplierId) {
    if (!ctx._sup.count) warnings.push("Suppliers (" + ctx.area + ") is empty — supplier not validated");
    else if (!ctx._sup.set[up_(supplierId)]) errors.push("Unknown or inactive supplier in " + ctx.area + ": " + supplierId);
  }
}

function activeSet_(area, sheetName, col) {
  const t = readTable_(area, sheetName);
  const set = {};
  t.rows.forEach(function (r) {
    if (str_(r[col]) && (isBlank_(r.Active) || toBool_(r.Active))) set[up_(r[col])] = true;
  });
  return { set: set, count: t.rows.length };
}

function validatePlan_(planId, area, planType, errors) {
  if (!planId) return;
  const p = findPlan_(planId);
  if (!p) { errors.push("Plan not found: " + planId); return; }
  if (p.area !== area) errors.push("Plan " + planId + " is for area " + p.area + ", not " + area);
  if (up_(p.row.Plan_Type) !== planType) errors.push("Plan " + planId + " is " + p.row.Plan_Type + ", expected " + planType);
  if (up_(p.row.Status) === "CANCELLED") errors.push("Plan " + planId + " is cancelled");
}

function findPlan_(planId) {
  const id = up_(planId);
  const m = id.match(/^PLN-(N|CN)-/);
  const areas = m ? [m[1]] : AREAS;
  for (let i = 0; i < areas.length; i++) {
    const t = readTable_(areas[i], SHEETS.PLANNING);
    const row = t.rows.filter(function (r) { return up_(r.Plan_ID) === id; })[0];
    if (row) return { area: areas[i], row: row, sheet: t.sheet, headers: t.headers };
  }
  return null;
}

function actualByPlan_(area) {
  const out = {};
  readTable_(area, SHEETS.TRANSACTIONS).rows.forEach(function (r) {
    const pid = up_(r.Plan_ID);
    if (!pid || !isEffective_(r)) return;
    const type = up_(r.Transaction_Type);
    let sign = 0;
    if (str_(r.Reversal_Of)) sign = -1;               // reversal ของรายการที่ผูกกับ plan
    else if (type === "IN" || type === "OUT") sign = 1;
    out[pid] = (out[pid] || 0) + sign * num_(r.Qty);
  });
  return out;
}

function findDuplicate_(area, crid) {
  if (!crid) return null;
  const rows = readTable_(area, SHEETS.TRANSACTIONS).rows.filter(function (r) {
    return str_(r.Client_Request_ID) === crid;
  });
  if (!rows.length) return null;
  return {
    success: true, duplicate: true, message: "This request was already processed",
    docId: str_(rows[0].Doc_ID),
    transactionIds: rows.map(function (r) { return r.Transaction_ID; })
  };
}

function checkUnit_(unit, settings) {
  if (!isBlank_(unit) && up_(unit) !== settings.STOCK_UNIT) {
    throw new Error("Unit must be " + settings.STOCK_UNIT + " (got " + unit + ")");
  }
}

function parseQty_(v, settings, label) {
  label = label || "qty";
  if (isBlank_(v)) throw new Error(label + " is required");
  const q = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
  if (!isFinite(q) || q <= 0) throw new Error(label + " must be a number greater than 0");
  if (settings.QTY_INTEGER_ONLY && Math.floor(q) !== q) {
    throw new Error(label + " must be a whole number of " + settings.STOCK_UNIT);
  }
  return q;
}

function parseDate_(v, settings, label) {
  label = label || "date";
  let d;
  if (isBlank_(v)) {
    d = Utilities.parseDate(fmtDate_(new Date()), CONFIG.TIMEZONE, "yyyy-MM-dd");
  } else if (v instanceof Date) {
    if (isNaN(v.getTime())) throw new Error(label + " is not a valid date");
    d = v;
  } else {
    const s = String(v).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(label + " must be YYYY-MM-DD (got " + s + ")");
    d = Utilities.parseDate(s, CONFIG.TIMEZONE, "yyyy-MM-dd");
    if (fmtDate_(d) !== s) throw new Error(label + " is not a valid date: " + s);
  }
  if (settings && !settings.ALLOW_FUTURE_DATE && fmtDate_(d) > fmtDate_(new Date())) {
    throw new Error(label + " cannot be in the future: " + fmtDate_(d));
  }
  return d;
}

function requireStr_(v, label) {
  const s = str_(v);
  if (!s) throw new Error(label + " is required");
  return s;
}

function normalizeArea_(a) {
  const s = up_(a);
  if (AREAS.indexOf(s) < 0) throw new Error("Invalid area: '" + (a === undefined ? "" : a) + "' (must be N or CN)");
  return s;
}

function currentUser_(data) {
  let email = "";
  try { email = Session.getActiveUser().getEmail(); } catch (e) { email = ""; }
  if (email) return email;
  const claimed = str_(data && data.user);
  return claimed ? "unverified:" + claimed : "unknown";
}

function validationError_(errors, context) {
  const e = new Error(errors.join(" | "));
  e.details = errors;
  e.context = context || null;
  return e;
}


/* ============================ SHEET I/O ============================ */

function getSS_(area) {
  area = normalizeArea_(area);
  if (_ssCache[area]) return _ssCache[area];
  const id = CONFIG.SPREADSHEET_IDS[area];
  if (!id || id.indexOf("PUT_") === 0) throw new Error("Spreadsheet ID for area " + area + " is not configured (CONFIG.SPREADSHEET_IDS)");
  _ssCache[area] = SpreadsheetApp.openById(id);
  return _ssCache[area];
}

function getSheet_(area, name) {
  const sh = getSS_(area).getSheetByName(name);
  if (!sh) throw new Error("Sheet '" + name + "' not found in " + area + " — run setupBackend()");
  return sh;
}

function headerRow_(sh) {
  const c = sh.getLastColumn();
  return c ? sh.getRange(1, 1, 1, c).getValues()[0].map(function (h) { return String(h).trim(); }) : [];
}

function readTable_(area, name) {
  const sh = getSheet_(area, name);
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow === 0 || lastCol === 0) return { sheet: sh, headers: [], rows: [] };
  const values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0].map(function (h) { return String(h).trim(); });
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (v.every(function (c) { return c === "" || c === null; })) continue;
    const o = { _row: i + 1 };
    headers.forEach(function (h, j) { if (h) o[h] = v[j]; });
    rows.push(o);
  }
  return { sheet: sh, headers: headers, rows: rows };
}

function requireColumns_(area, name, headers) {
  const missing = HEADERS[name].filter(function (h) { return headers.indexOf(h) < 0; });
  if (missing.length) throw new Error(area + "/" + name + " is missing columns: " + missing.join(", ") + " — run setupBackend()");
}

function appendObjects_(area, name, objs) {
  if (!objs || !objs.length) return;
  const sh = getSheet_(area, name);
  const headers = headerRow_(sh);
  requireColumns_(area, name, headers);
  const values = objs.map(function (o) { return headers.map(function (h) { return cell_(o[h]); }); });
  sh.getRange(sh.getLastRow() + 1, 1, values.length, headers.length).setValues(values);
}

/** เขียนทับข้อมูลใต้ header โดยไม่มีช่วงที่ตารางว่าง (เขียนใหม่ก่อน แล้วค่อยล้างแถวเกิน) */
function replaceTableData_(area, name, objs) {
  const sh = getSheet_(area, name);
  const headers = headerRow_(sh);
  requireColumns_(area, name, headers);
  const oldRows = Math.max(0, sh.getLastRow() - 1);
  if (objs.length) {
    sh.getRange(2, 1, objs.length, headers.length)
      .setValues(objs.map(function (o) { return headers.map(function (h) { return cell_(o[h]); }); }));
  }
  if (oldRows > objs.length) {
    sh.getRange(2 + objs.length, 1, oldRows - objs.length, headers.length).clearContent();
  }
}

function markStatus_(area, name, matchFn, status) {
  const t = readTable_(area, name);
  const col = t.headers.indexOf("Status") + 1;
  if (!col) return;
  t.rows.filter(matchFn).forEach(function (r) { t.sheet.getRange(r._row, col).setValue(status); });
}


/* ============================ IDS / COUNTERS / FLAGS ============================ */

function props_() { return PropertiesService.getScriptProperties(); }

function isDirty_(area) { return props_().getProperty("DIRTY_" + area) === "1"; }

function setDirty_(area, on) {
  if (on) props_().setProperty("DIRTY_" + area, "1");
  else props_().deleteProperty("DIRTY_" + area);
}

/** ต้องเรียกภายใน Lock เท่านั้น */
function nextCounter_(key, initFn) {
  const p = props_();
  const cur = p.getProperty(key);
  const n = (cur === null ? initFn() : Number(cur)) + 1;
  p.setProperty(key, String(n));
  return n;
}

function resetCounters_() {
  const p = props_();
  Object.keys(p.getProperties()).forEach(function (k) { if (k.indexOf("CTR_") === 0) p.deleteProperty(k); });
}

function maxSuffix_(areas, sheetName, column, prefix) {
  let max = 0;
  areas.forEach(function (a) {
    readTable_(a, sheetName).rows.forEach(function (r) {
      const v = up_(r[column]);
      if (v.indexOf(prefix) !== 0) return;
      const n = parseInt(v.substring(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    });
  });
  return max;
}

function nextTxnId_(area) {
  const pre = "TXN-" + area + "-";
  return pre + pad_(nextCounter_("CTR_TXN_" + area, function () { return maxSuffix_([area], SHEETS.TRANSACTIONS, "Transaction_ID", pre); }), 6);
}

function nextSeq_(area) {
  return nextCounter_("CTR_SEQ_" + area, function () {
    const rows = readTable_(area, SHEETS.TRANSACTIONS).rows;
    let m = rows.length;
    rows.forEach(function (r) { const n = Number(r.Seq); if (r.Seq !== "" && !isNaN(n) && n > m) m = n; });
    return m;
  });
}

function nextLedgerId_(area) {
  const pre = "LED-" + area + "-";
  return pre + pad_(nextCounter_("CTR_LED_" + area, function () { return maxSuffix_([area], SHEETS.STOCK_LEDGER, "Ledger_ID", pre); }), 7);
}

function nextDocId_(area) {
  const pre = "DOC-" + area + "-";
  return pre + pad_(nextCounter_("CTR_DOC_" + area, function () { return maxSuffix_([area], SHEETS.TRANSACTIONS, "Doc_ID", pre); }), 6);
}

function nextTransferId_() {
  const pre = "TRF-";
  return pre + pad_(nextCounter_("CTR_TRF", function () { return maxSuffix_(AREAS, SHEETS.TRANSACTIONS, "Transfer_ID", pre); }), 6);
}

function nextPlanId_(area) {
  const pre = "PLN-" + area + "-";
  return pre + pad_(nextCounter_("CTR_PLN_" + area, function () { return maxSuffix_([area], SHEETS.PLANNING, "Plan_ID", pre); }), 6);
}

/** Lot_ID global ข้าม N/CN: LOT-YYYY-00001 */
function nextLotId_(date) {
  const y = Utilities.formatDate(date, CONFIG.TIMEZONE, "yyyy");
  const pre = "LOT-" + y + "-";
  return pre + pad_(nextCounter_("CTR_LOT_" + y, function () { return maxSuffix_(AREAS, SHEETS.LOTS, "Lot_ID", pre); }), 5);
}


/* ============================ SMALL UTILS ============================ */

function str_(v) { return v === null || v === undefined ? "" : String(v).trim(); }
function up_(v) { return str_(v).toUpperCase(); }
function num_(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function isBlank_(v) { return v === undefined || v === null || String(v).trim() === ""; }
function pad_(n, w) { return String(n).padStart(w, "0"); }
function cell_(v) { return v === undefined || v === null ? "" : v; }
function skey_(loc, lot) { return up_(loc) + "\u0001" + up_(lot); }
function otherArea_(a) { return a === "N" ? "CN" : "N"; }
function pushAll_(arr, items) { items.forEach(function (x) { arr.push(x); }); }
function sumBy_(arr, key) { return arr.reduce(function (s, x) { return s + num_(x[key]); }, 0); }
function isEffective_(r) { return !str_(r.Status) || EFFECTIVE_STATUSES.indexOf(up_(r.Status)) >= 0; }
function alert_(type, severity, area, locationId, message) {
  return { type: type, severity: severity, area: area, locationId: locationId, message: message };
}

function toBool_(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  return ["TRUE", "YES", "Y", "1"].indexOf(String(v).trim().toUpperCase()) >= 0;
}

function parseCapacity_(v) {
  if (isBlank_(v)) return null;
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : null;   // ว่าง/0 = ยังไม่ได้ Map
}

function fmtDate_(d) { return Utilities.formatDate(d, CONFIG.TIMEZONE, "yyyy-MM-dd"); }

function dateStr_(v) {
  if (v instanceof Date) return fmtDate_(v);
  return str_(v).substring(0, 10);
}

function toTime_(v) {
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}

/** ลำดับการประมวลผล: Seq ก่อน, ถ้าไม่มี Seq ใช้ Timestamp แล้วตามแถว */
function txnOrder_(a, b) {
  const sa = Number(a.Seq), sb = Number(b.Seq);
  const hasA = a.Seq !== "" && a.Seq !== undefined && !isNaN(sa);
  const hasB = b.Seq !== "" && b.Seq !== undefined && !isNaN(sb);
  if (hasA && hasB && sa !== sb) return sa - sb;
  return (toTime_(a.Timestamp) - toTime_(b.Timestamp)) || ((a._row || 0) - (b._row || 0));
}

/** แปลงผลลัพธ์ให้ส่งเป็น JSON ได้: Date → string, ตัด field ภายใน (_row ฯลฯ) */
function toOutput_(v, key) {
  if (v instanceof Date) {
    return /Date$/.test(key || "")
      ? Utilities.formatDate(v, CONFIG.TIMEZONE, "yyyy-MM-dd")
      : Utilities.formatDate(v, CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
  }
  if (Array.isArray(v)) return v.map(function (x) { return toOutput_(x, key); });
  if (v && typeof v === "object") {
    const o = {};
    Object.keys(v).forEach(function (k) { if (k.charAt(0) !== "_") o[k] = toOutput_(v[k], k); });
    return o;
  }
  return v;
}
