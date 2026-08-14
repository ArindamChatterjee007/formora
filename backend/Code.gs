/**
 * Formora — Google Sheets login backend (Google Apps Script Web App)
 * =====================================================================
 * This lets accounts persist in YOUR Google Sheet so you can log in from
 * any device (fixes "anyone can't see it"). Passwords are salted + SHA-256
 * hashed before storing — never kept in plain text.
 *
 * ONE-TIME SETUP (about 2 minutes):
 *  1. Go to https://sheets.new  → create a Google Sheet (any name).
 *  2. Extensions ▸ Apps Script → delete the sample, paste ALL of this file.
 *  3. Click Deploy ▸ New deployment ▸ gear icon ▸ "Web app".
 *  4. Set  Execute as: Me   |   Who has access: Anyone   → Deploy.
 *  5. Authorise when prompted, then COPY the Web app URL (ends in /exec).
 *  6. Paste that URL into  js/config.js  →  window.SHEETS_API = "...".
 *  7. Tell me the URL and I'll wire + test the client sign-up/login.
 *
 * Note: a Sheets backend is fine for a personal/hobby app but is not
 * bank-grade security (no rate limiting, hashes visible to sheet owners).
 */

const SHEET_NAME = "Users";

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(["name", "email", "phone", "salt", "hash", "createdAt"]);
  }
  return sh;
}

function hash_(salt, pw) {
  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, salt + ":" + pw, Utilities.Charset.UTF_8);
  return raw.map((b) => ("0" + (b & 0xff).toString(16)).slice(-2)).join("");
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function findRow_(sh, email) {
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]).toLowerCase() === email.toLowerCase()) return data[i];
  }
  return null;
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const sh = sheet_();
    const email = String(req.email || "").trim();

    if (req.action === "signup") {
      if (!email || !req.password) return json_({ ok: false, error: "Missing fields" });
      if (findRow_(sh, email)) return json_({ ok: false, error: "Account already exists — log in." });
      const salt = Utilities.getUuid();
      sh.appendRow([req.name || "", email, req.phone || "", salt, hash_(salt, req.password), new Date().toISOString()]);
      return json_({ ok: true, user: { name: req.name || "", email: email, phone: req.phone || "" } });
    }

    if (req.action === "login") {
      const row = findRow_(sh, email);
      if (!row) return json_({ ok: false, error: "No account for this email." });
      const salt = row[3], hash = row[4];
      if (hash_(salt, req.password) !== hash) return json_({ ok: false, error: "Incorrect password." });
      return json_({ ok: true, user: { name: row[0], email: email, phone: row[2] } });
    }

    return json_({ ok: false, error: "Unknown action" });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doGet() {
  return json_({ ok: true, service: "Formora auth backend" });
}
