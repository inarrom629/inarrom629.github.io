// ====== CONFIGURACIÓN ======
// El mismo Client ID que pegas en app.js (GOOGLE_CLIENT_ID).
var CLIENT_ID = "236441999538-2e43bndqv3gq2g34damvahkmbv0pjfll.apps.googleusercontent.com";
// Hoja de cálculo con el personal autorizado: pestaña "Ajustes",
// columna A = nombre, columna B = correo.
var AUTH_SPREADSHEET_ID = "1LQTuX6sMZ8AJkhrLT2-1wH9py5M93MOil5duoU9raX0";
var AUTH_SHEET_NAME = "Ajustes";
// Los grupos y sus segundos siguen en la PRIMERA pestaña de ESTA hoja (A = grupo, B = segundos).

function doGet() {
  return ContentService.createTextOutput("Conexión Activa").setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    var email = verifyIdToken(body.token);
    if (!isTeacher(email)) {
      return jsonOutput({
        status: "error",
        codigo: "no_autorizado",
        mensaje: email + " no está en la lista de personal autorizado."
      });
    }
    return handleAction(body);
  } catch (error) {
    var response = { status: "error", mensaje: error && error.message ? error.message : String(error) };
    if (error && error.codigo) response.codigo = error.codigo;
    return jsonOutput(response);
  }
}

// ====== ACCIONES (solo llegan aquí los profesores autorizados) ======
function handleAction(body) {
  var action = body.accion;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  if (!sheet) throw new Error("No se encontró la primera hoja de cálculo.");

  if (action === "obtener") {
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return jsonOutput([]);
    var rows = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    var groups = [];
    rows.forEach(function (row) {
      var group = row[0];
      if (group !== "" && group !== null && String(group).trim() !== "") {
        var seconds = Number(row[1]);
        groups.push({ grupo: String(group).trim(), segundos: Number.isInteger(seconds) && seconds >= 0 ? seconds : 0 });
      }
    });
    return jsonOutput(groups);
  }

  if (action === "guardar") {
    var groupName = String(body.grupo || "").trim();
    var secondsText = String(body.segundos === undefined ? "" : body.segundos);
    if (!groupName) return jsonOutput({ status: "error", mensaje: "El grupo es obligatorio." });
    if (!/^\d+$/.test(secondsText)) {
      return jsonOutput({ status: "error", mensaje: "segundos debe ser un entero mayor o igual a cero." });
    }
    var secondsValue = Number(secondsText);
    if (!Number.isSafeInteger(secondsValue)) {
      return jsonOutput({ status: "error", mensaje: "segundos debe ser un entero mayor o igual a cero." });
    }

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) {
      return jsonOutput({ status: "error", mensaje: "No se pudo obtener el bloqueo para guardar. Inténtalo de nuevo." });
    }
    try {
      var finalRow = sheet.getLastRow();
      var groupRows = finalRow >= 2 ? sheet.getRange(2, 1, finalRow - 1, 1).getValues() : [];
      var targetRow = -1;
      for (var index = 0; index < groupRows.length; index++) {
        if (String(groupRows[index][0]).trim() === groupName) {
          targetRow = index + 2;
          break;
        }
      }
      if (targetRow === -1) targetRow = Math.max(2, finalRow + 1);
      sheet.getRange(targetRow, 1, 1, 2).setValues([[groupName, secondsValue]]);
    } finally {
      lock.releaseLock();
    }
    return jsonOutput({ status: "ok" });
  }

  return jsonOutput({ status: "error", mensaje: "Acción no reconocida." });
}

// ====== SEGURIDAD ======
function authError(codigo, mensaje) {
  var error = new Error(mensaje);
  error.codigo = codigo;
  return error;
}

// Valida con Google el token de inicio de sesión y devuelve el correo verificado.
function verifyIdToken(token) {
  if (!token || typeof token !== "string") throw authError("sesion_expirada", "Falta iniciar sesión.");

  var cache = CacheService.getScriptCache();
  var cacheKey = "tok_" + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  var cachedEmail = cache.get(cacheKey);
  if (cachedEmail) return cachedEmail;

  var response = UrlFetchApp.fetch(
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token),
    { muteHttpExceptions: true }
  );
  if (response.getResponseCode() !== 200) throw authError("sesion_expirada", "La sesión no es válida o ha caducado.");

  var info = JSON.parse(response.getContentText());
  var now = Math.floor(Date.now() / 1000);
  var validIssuer = info.iss === "accounts.google.com" || info.iss === "https://accounts.google.com";
  if (info.aud !== CLIENT_ID || !validIssuer || String(info.email_verified) !== "true" || !info.email || Number(info.exp) <= now) {
    throw authError("sesion_expirada", "La sesión no es válida o ha caducado.");
  }

  var email = String(info.email).toLowerCase();
  cache.put(cacheKey, email, Math.max(1, Math.min(300, Number(info.exp) - now)));
  return email;
}

// Comprueba que el correo esté en la columna B de la pestaña "Ajustes" (la lista se cachea 60 s).
function isTeacher(email) {
  var cache = CacheService.getScriptCache();
  var raw = cache.get("lista_autorizados");
  var list;
  if (raw) {
    list = JSON.parse(raw);
  } else {
    list = readAuthorizedEmails();
    cache.put("lista_autorizados", JSON.stringify(list), 60);
  }
  return list.indexOf(email) !== -1;
}

function readAuthorizedEmails() {
  var spreadsheet;
  try {
    spreadsheet = SpreadsheetApp.openById(AUTH_SPREADSHEET_ID);
  } catch (error) {
    throw new Error("No se puede abrir la hoja de personal autorizado. Comparte esa hoja (como mínimo en modo lector) con la cuenta propietaria del script.");
  }
  var sheet = spreadsheet.getSheetByName(AUTH_SHEET_NAME);
  if (!sheet) throw new Error("Falta la pestaña «" + AUTH_SHEET_NAME + "» en la hoja de personal autorizado.");
  var lastRow = sheet.getLastRow();
  if (lastRow < 1) return [];
  // Solo se aceptan celdas con aspecto de correo, así que una cabecera como "Correo" se ignora sola.
  return sheet.getRange(1, 2, lastRow, 1).getValues()
    .map(function (row) { return String(row[0]).trim().toLowerCase(); })
    .filter(function (value) { return value.indexOf("@") > 0; });
}

// Prueba desde el editor: Ver → Registros debe mostrar cuántos correos autorizados lee el script.
function probarLista() {
  var list = readAuthorizedEmails();
  Logger.log(list.length + " correos autorizados: " + list.join(", "));
}

function jsonOutput(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

// Ejecuta esta función UNA vez desde el editor para conceder el permiso de conexión externa.
function autorizar() {
  UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo", { muteHttpExceptions: true });
}
