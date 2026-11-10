function doGet(e) {
  var action = e && e.parameter ? e.parameter.accion : "";
  if (!action) {
    return ContentService.createTextOutput("Conexión Activa").setMimeType(ContentService.MimeType.TEXT);
  }

  try {
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
      var groupName = String(e.parameter.grupo || "").trim();
      var secondsText = String(e.parameter.segundos === undefined ? "" : e.parameter.segundos);
      if (!groupName) return jsonOutput({ status: "error", mensaje: "El grupo es obligatorio." });
      if (!/^\d+$/.test(secondsText)) {
        return jsonOutput({ status: "error", mensaje: "segundos debe ser un entero mayor o igual a cero." });
      }
      var secondsValue = Number(secondsText);
      if (!Number.isSafeInteger(secondsValue) || secondsValue < 0) {
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
  } catch (error) {
    return jsonOutput({ status: "error", mensaje: error && error.message ? error.message : String(error) });
  }
}

function jsonOutput(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}