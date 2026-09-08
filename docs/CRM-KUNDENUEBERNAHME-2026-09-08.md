# Kundenübernahme aus dem vorhandenen TradeFoto-Import

Stand: 08.09.2026. **30.503 Kundenkarten sind produktiv angelegt und vollständig gegen die bestätigte Feldprojektion geprüft.** Der Lauf endete um 02:14:02 Uhr Europe/Vienna erfolgreich. Die Anwendung blieb auf Version 0.92.29-beta und wurde nicht neu gestartet.

## Umfang

Die ausdrücklich freigegebene Erstübernahme verwendet ausschließlich die bereits auf dem VPS vorbereitete Tabelle `KUNDEN` aus dem zuletzt hochgeladenen TradeFoto-Stand. `KUND_NR` wird zur eindeutigen Kunden-Kontonummer. `KontoNr` bleibt geschützte Zusatzinformation; die getrennte optionale CRM-Kundennummer bleibt leer. Der Quellwert `0` erhält keine Kundenkarte. Unbekannte Kundentypen bleiben „Nicht angegeben“, fehlende Namen und Kontakte sind zulässig.

Die produktive Quellprüfung ergibt 30.504 eindeutige Schlüssel, davon 30.503 Kundenkonten und einmal Null. 814 der zu übernehmenden Karten haben keinen Namen. 239 Datensätze enthalten einen für das jeweilige CRM-Feld ungültigen Originalwert: 183 E-Mail-Adressen, 44 UID-Werte, zwei Straßenangaben, einen Nachnamen und neun Ortsangaben. Diese Kunden werden ebenfalls angelegt. Das betreffende reguläre Feld bleibt leer; ein eigenes Textfeld „TradeFoto – … prüfen“ enthält den ungeprüften Originalwert und einen Prüfhinweis. Das verschlüsselte Quelloriginal bleibt erhalten. Es werden keine Kontaktdaten geraten oder ungeprüfte Werte als gültige E-Mail-/UID-Felder ausgegeben.

## Ausführung

Der Helfer [import-tradefoto-crm.cjs](../scripts/import-tradefoto-crm.cjs) benutzt die installierte Version 0.92.29-beta und deren vorhandene Import-/CRM-Repositories. Die allgemeine produktive HTTP-Importfreigabe wird nicht verändert. Es gibt keinen erneuten Upload, keinen Kassen- oder Artikelimport, keine Schemaänderung und keinen App-Neustart.

Eine vollständige lesende Planung bindet Quellhash, Quellzeilen, Akteur, Zuordnungsregeln und Originalwert-Hinweise an einen HMAC-geschützten Plan. Nur dessen identischer Hash erlaubt die Ausführung. Der bestehende Importlauf übernimmt zunächst genau die Kundenquellen in Schritten von 200 Zeilen. Jede Kundenanlage speichert Karte, authentifizierte Quellbindung und verschlüsseltes Abgleichereignis atomar einschließlich zentralem Audit. Die Belegsuche kann diese Bindung über ihren vorhandenen TradeFoto-Leser auflösen.

Prüfhinweise werden danach über das normale CRM-Repository mit Revision und Audit ergänzt. Ein Abbruch zwischen Anlage und Prüfhinweis ist wiederaufnehmbar. Bereits verbundene Karten werden beim Wiederholen nicht erneut angelegt oder überschrieben; vorhandene eigene Felder bleiben erhalten. Namens-/E-Mail-Ähnlichkeit führt zu keiner Zusammenführung. Nummernkollisionen mit einer zuvor anders angelegten Karte benötigen eine gesonderte Zielzuordnung.

Der Helfer ist auf diese Erstübernahme und ihre Wiederaufnahme beschränkt. Spätere geänderte Quellen und Konflikte mit manuellen Änderungen brauchen den bestehenden geprüften Folgeabgleich; der Helfer gibt diesen nicht pauschal frei. Die Oberfläche zur allgemeinen Stapelübernahme ist dadurch nicht automatisch aktiviert.

## Herkunft und Rücknahme

- Quelldatei SHA-256: `42a40cb19d867fcc5d6e6f3429065ba0ff77f65a7b9b7fcfaae3d0b61f8154f3`.
- Vorhandene Quell-ID: `53d722d6fddd880419fda162c3cdb68377f3f31a5f226f7c47a410ce574d2d47`.
- Kundenlauf: `fad0557e59c1e1da4b12c1e9e35b7069ec5941db2014608b7009b51881d21bef`.
- Bestätigter Plan: `7f8bec02c09a3bb6b20f411e2aed782aa958cf592f4397e28eae345c042fe4bb`.
- Ausgeführter Helfer SHA-256: `b06a89f3b0922a15d24ab9c1442a8b80a98aa1e877ccf00ed641ac5a5510fcbc`.
- Vorab-Snapshot: `/var/backups/grabenplaner-crm-import-20260908/before-customers.db`, 2.288.504.832 Bytes, SHA-256 `56a9b677bf62eae1f70855da17898859279cbcabd52323779cb0f733d6e3c082`.
- Ausführungsnachweis: `/var/backups/grabenplaner-crm-import-20260908/applied.json`, SHA-256 `a739b3768525e1b70dfc01ea69f5141e675dd83445ec5ed8bed43b70b277ad04`. Helfer und Plan liegen im selben geschützten Nachweisverzeichnis.

Der Vorab-Snapshot entstand mit der SQLite-Backup-API bei laufender Anwendung. `quick_check` war erfolgreich; Kundenkarten und Kundenquellen waren leer. Das Verzeichnis ist nur für root zugänglich. Dieser zusätzliche Datenbanksnapshot sichert die eng begrenzte CRM-Datenänderung ab; bestehende gekoppelte Dokument-/Offsite-Sicherungen bleiben bestehen. Er ist kein neuer vollständiger Wiederherstellungsnachweis.

Eine Rücknahme über die bestehenden Importdienste muss Revisionen, spätere Änderungen, Quellbindungen, eigene Felder und Folgeabhängigkeiten prüfen. Insbesondere dürfen die hinzugefügten Prüfhinweise nicht durch eine unkontrollierte Löschung umgangen werden. Ein vollständiger Datenbank-Rollback wäre eine gesonderte Betriebsmaßnahme mit Prüfung aller zwischenzeitlichen Änderungen.

## Prüfungen

57 gezielte Domänen-, Persistenz-, Quellen- und Importtests sowie fünf Architekturtests bestanden. Die neue Prüfung umfasst identische Wiederaufnahme ohne doppelte Karten oder Anlageereignisse, Erhalt der Originalwerte, Abbruch bei der Hinweisspeicherung und Schutz manueller Änderungen. Das Persistence-Audit ist erfolgreich, Syntax- und Whitespace-Prüfung sind bestanden.

Die abschließende produktive Prüfung hat alle regulären importierten CRM-Felder und Originalwert-Hinweise mit der bestätigten Projektion verglichen und die Quellbindungen authentifiziert: 30.503 Karten bestanden, darunter 814 ohne Namen und alle 239 mit Prüfhinweis. Der Helfer endete mit Exitcode 0. Planung und Ausführung von 01:51:25 bis 02:14:02 Uhr dauerten zusammen rund 22 Minuten 37 Sekunden; die eigentliche Kartenanlage endete bereits um 02:12:41 Uhr. Kein vollständiger TradeFoto-/Kassen-Reimport oder Wiederholungsimport wurde gestartet.

Die unabhängige lesende Datenbankprüfung bestätigt 30.503 unterschiedliche Kontonummern, 30.504 geschützte Kundenquellen einschließlich Null, 30.503 Bindungen und Abgleichereignisse sowie 239 eigene Prüffelder. Es fehlen keine Bindungsziele; `quick_check` ist `ok`, Fremdschlüsselfehler sind null. Zentraler Audit: 30.503 Kundenanlagen und 239 Aktualisierungen für die Prüfhinweise. Die sieben Kassenbestände, eine Kassenveröffentlichung, 11.059 Kassenbindungen und Veröffentlichungsrevision 1 sind unverändert.

Die Datenbank umfasst danach 2.653.700.096 Bytes, ein Zuwachs von 365.195.264 Bytes (rund 348 MiB) für Kundenquellen, Karten, Bindungen und Abgleichnachweise. Beim Abschlusscheck sind 66.545.713.152 Bytes auf dem VPS frei, bereits einschließlich des zusätzlichen Vorab-Snapshots. App und Caddy laufen mit unveränderten Startzeiten; alle vier internen/öffentlichen Live-/Ready-Abfragen liefern HTTP 200.

Die installierte CRM-Suchabfrage wurde mit einem echten übernommenen Konto lesend geprüft: Kontonummer, Vor-/Nachname, Straßen-/Postleitzahlteile, Telefon, E-Mail und kombinierte Joker finden jeweils die richtige Karte. Zehn echte Kassenbelege konnten über den vorhandenen authentifizierten TradeFoto-Referenzleser ihrer CRM-Karte zugeordnet werden. Die Stichprobe umfasste elf Belege; ein weiterer Kundenverweis hat auch nach vollständiger Anlage den Zustand `missing_source`: Diese historische Kundenkennung fehlt im gelieferten TradeFoto-Kundenbestand. Es wurden weder Ersatzkunden angelegt noch Belege umnummeriert. Während des laufenden Imports benötigten die sechs CRM-Suchabfragen jeweils 11,6–12,7 Sekunden. Das bestätigt die Funktion, aber keine ausreichende Suchleistung.

Eine einzelne zusätzliche Kontensuche nach Ende des Imports fand die richtige Karte in 17,7 Sekunden. Die langsame Suche ist somit nicht allein durch den gleichzeitig laufenden Kundenimport erklärt. Eine gezielte Verbesserung der Suchabfrage bleibt erforderlich; weitere Vollimporte oder Datenkopien sind dafür nicht nötig.

Der temporäre Importpfad `/tmp/grabenplaner-crm-import-20260908` wurde nach erfolgreichem Abschluss geprüft und entfernt. Die drei Dateien wurden zuvor bytegleich in das geschützte Nachweisverzeichnis übernommen; der Vorab-Snapshot bleibt erhalten. Alle zugehörigen Import-/Prüfprozesse sind beendet.

Die persönliche Browseranmeldung war abgelaufen. Die Prüfung über die tatsächlichen installierten Datenzugriffs- und Suchmodule ersetzt keine angemeldete UI-Prüfung; diese bleibt von der erneuten Anmeldung abhängig. Es werden keine Sitzungen erzeugt oder Anmeldungen umgangen.

Die vom vorherigen Deployment offene vollständige Recovery Assurance und die separat dokumentierte Suchleistung werden durch diese Kundenübernahme nicht als behoben ausgegeben.
