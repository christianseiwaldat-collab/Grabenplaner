# Produktivanbindung – Block 1 von 4

Stand: 05.09.2026. Lokal implementiert; keine Veröffentlichung und keine produktive Datenübernahme.

## Umfang und Freigabegrenze

- Eigener aufklappbarer Bereich **Verkauf → TradeFoto-Gesamtimport** für berechtigte persönliche Konten. Der bisherige Artikel- und PDF-Berichtsimport bleibt unverändert.
- ACCDB-Auswahl für TradeFoto bzw. Kassen-Umsätze, Größenlimit 512 MiB, optionales flüchtiges Dateikennwort. Ein isolierter Leser verarbeitet die unveränderte Datei mit bestätigten 200-Zeilen-Paketen. Maximal ein Datei-Upload/Leser gleichzeitig.
- Geschützte Quellenübersicht mit Dateifingerabdruck, gelesenem und deklariertem Zähler je Tabelle, Fortschritt, paginiertem Ereignisprotokoll, Zeilenstatus, Wiederanlauf und Rücknahmeprüfung.
- 66 Stammdaten- und 43 Historienprofile sind zugelassen. 26 bekannte technische TradeFoto-Tabellen und die verknüpfte Kassentabelle `ARTIKEL_STAMM` bleiben ausgeschlossen. Neue/unbekannte Tabellen und Schemaänderungen werden nicht still übergangen.
- Die Anwendung registriert ausschließlich leere Importtabellen. Beim Start entstehen weder Importläufe noch Schlüssel. `allowApply: false` im Server verhindert die produktive Übernahme auch bei vorhandenem Übernahmerecht; HTTP-Anfragen können dieses Gate nicht ändern.
- Eine Vorschau schreibt nur verschlüsselte Prüfzeilen, keine aktiven GP-Kunden, Artikel, Berechtigungen, Bestände oder Kennzahlen. Auch die bisherigen Verkaufsansichten bleiben bis zur späteren Fachanbindung und Freigabe deaktiviert.

## Rechte und Schutz

Getrennte Rechte: `data:imports:read`, `data:imports:prepare`, `data:imports:apply`, `data:imports:undo`. Erforderlich sind zusätzlich persönliche Anmeldung, Verkaufsanalyse-Zugang und Gesamtfirmen-Leserecht. Vergabe nur an dafür zugelassene Admin-/Developer-Rollen; andere Rollen erhalten keine automatischen Zusatzrechte. Der Developer behält den vollständigen bekannten Rechtekatalog.

Importläufe und Protokolle sind kontogebunden. Jede HTTP-Aktion sowie jedes eingelesene Paket prüft die aktuelle Anmeldung erneut. Änderungen benötigen CSRF-Prüfung. Antworten sind `private, no-store`. Die Oberfläche speichert keine Quelldaten oder Kennwörter im Browser und verwirft ausstehende Antworten beim Kontowechsel/Abmelden.

Rohdateien werden nicht auf dem Server-Dateisystem abgelegt; Access-Verknüpfungen, Makros und Plugins werden nicht ausgeführt. Ausschließlich erlaubte Geschäftsfelder gelangen in die bestehende AES-GCM-Staging-Schicht. Ausgeschlossene Zugangsfelder werden bereits beim Lesen weggelassen. Fehler und Protokolle enthalten Codes/Zähler, keine Kundentexte oder Kennwörter.

## Schlüssel und Wiederherstellung

Bei der ersten berechtigten Vorbereitung erzeugt die App getrennte Daten- und Indexschlüssel und legt sie mit dem bestehenden Integration-Secret-Vault verschlüsselt in `data_import_runtime_keys` ab. Es werden keine Umgebungsvariablen, Zugangsdaten oder Schlüsseldateien geändert. Ein fehlender/nicht passender Vault führt zu einer geschlossenen Sperre, nicht zu neuen Ersatzschlüsseln.

Für Wiederherstellung müssen **dieselbe Datenbanksicherung einschließlich Import-Key-Umschlag und die passende bestehende App-Vault-Schlüsselverwaltung** vorhanden sein. Ein Restore-Test muss beide gemeinsam prüfen. Der Indexschlüssel bleibt für wiederholte Importe stabil. Die vorhandene Anwendungssicherung bleibt unverändert; produktive Backup-/Restore- und Kapazitätsprüfung erfolgen vor der Aktivierung.

## Wiederanlauf und Rücknahme

Nach HTTP-Annahme (`202`) ist der Verlauf separat lesbar. Bei Leserabbruch oder Serverneustart wird derselbe Dateistand erneut ausgewählt. Datei-Hash, Besitzer, Profil und Manifest bestimmen den Importlauf. Bereits gespeicherte Pakete werden beim Wiederanlauf verglichen, nicht dupliziert. Der Beginn der Bereitstellung ist ein technischer Zeitstempel, kein Belegdatum oder Nachweis der Datenabdeckung.

Nach vollständiger Bereitstellung ist keine erneute Quelldatei für die fortgesetzte Prüfung erforderlich. Verarbeitung und Checkpoints sind transaktional. Ein nach einem Absturz veralteter Oberflächenstand wird aus dem betreffenden Lauf aktualisiert. Vor späterem Übernehmen einer abhängigen Tabelle werden ihre Pläne neu geprüft; Referenz- und Versionskontrollen bleiben wirksam.

Die Rücknahme arbeitet paketweise in umgekehrter Abhängigkeit und ist **keine pauschale Wiederherstellung der gesamten Anwendung**. Jede Änderung wird erneut geprüft. Spätere Importe, manuelle Änderungen und referenzierende Vorgänge können sie verhindern; zuvor abgeschlossene Pakete bleiben nachvollziehbar. Rücknahmefrist: 30 Tage ab Laufbeginn. Es erfolgt keine automatische Löschung von Quelldaten oder Archivhistorie. Nach bewusster Rücknahme wird dieselbe Datei nicht automatisch als neuer Versuch erneut angewandt.

## Bestätigte Umsatzsemantik

Der Nutzer hat den Abgleich der vorhandenen Unterlagen bestätigt und die Belege vom 05.09.2026 ausdrücklich aus der weiteren Abnahme ausgeklammert. Dafür werden keine weiteren Unterlagen verlangt.

- Filiale/Kasse 18, 03.09.2026: **2.494,51 EUR**, einschließlich Nullpreisbeleg und aller bestätigten Positionen.
- Filiale/Kasse 18, 04.09.2026: **1.001,71 EUR**, einschließlich negativer Positionen; Papierabschluss und Quellpositionssumme stimmen überein. `Tagesbericht` enthält für diesen Tag noch keine entsprechenden Datensätze.
- Rechenbasis: vorzeichenbehaftete Menge × finaler Brutto-Einzelpreis, kaufmännische Rundung je Position. Gespeicherte Rabatte nicht nochmals abziehen. `AStorno=true` oder `Ret=false` sind kein alleiniger Ausschluss-/Rückgabeentscheid.
- Ein explizit bestätigtes Quellenprofil darf `RechnungsBetrag=0` als fehlenden Kopfwert kennzeichnen (`headerZeroMeaning: unavailable`). Der Standard bleibt die strenge Kopfprüfung. Nichtnull-Kopfwerte, vollständige Belegzugehörigkeit, Steuer-/Statusregeln und ihre Evidenz bleiben verpflichtend. Originalnullwerte und Nullpreispositionen werden nicht ersetzt/entfernt.
- Die neue optionale Regel ist synthetisch regressiongetestet. Eine produktive, belegte Regelzuordnung und Zeitraumsauswertung wird damit noch nicht global freigeschaltet. Unbestätigte Statuskombinationen bleiben prüfpflichtig. Kassenbewegungen und PDF-Berichte werden nicht zu Einzelverkäufen addiert.

Zuletzt rein lesend bestätigter Kassenstand: 219.920 Belegköpfe, 385.877 Positionen. Datei-SHA256 `6a7e9f3cb8404299da54aef8c5ab661d7d66e1791003ebcd62c10d60a6a4e395`; die älteren Block-6-Berichte beziehen sich auf den früheren Snapshot und bleiben historische Nachweise.

## Weiterhin offen – nicht Teil dieses Blocks

1. **Block 2:** explizite GP-Zuordnungen und skalierbare Verkaufs-/CRM-Ansichten, insbesondere Jahreszeiträume über der bisherigen 5.000-Datensatz-Prüfgrenze.
2. **Block 3:** vollständiger Import in eine isolierte Testdatenbank; Vollständigkeit, Laufzeit, Speicherbedarf, Wiederholung und Rücknahme. Die Quellenabweichung Q01 bleibt offen: `ARTIKEL_STAMM` 19.187 deklariert / 19.186 gelesen; `ARTIKEL_FILIALEN` 231.355 / 231.351. Keine Zählerkorrektur ohne unabhängige Bestätigung. Keine Umgehung blockierter Access-Ausführung.
3. **Block 4:** erst nach Freigabe Releasekette, VPS-Backup/Restore-/Kapazitätsprüfung, kontrollierter produktiver Erstimport und Aktivierung. App-Port weiterhin ausschließlich Loopback; keine Änderung an SSH, Firewall, Tailscale oder Zugängen.

Alle fachlichen Testdaten dieses Blocks sind synthetisch. Ein technischer Test ersetzt weder den vollständigen Testimport noch die Produktivfreigabe.

## Lokale Verifikation

- Vollsuite: 2.860 Tests, davon 2.820 bestanden, 40 bewusst übersprungen, 0 Fehler; rund 470 Sekunden. Drei alte Struktur-/Zählerannahmen aus dem ersten Lauf wurden auf die ausdrücklich angebundenen, leeren Importkataloge aktualisiert; keine PostgreSQL-Produktivfreigabe wurde gelockert.
- Anschließend auf dem abschließenden Importstand: 132 gezielte Import-, Rechte-, Routen-, UI- und Historientests bestanden. Enthalten sind Widerruf während der Bereitstellung, erneute Abhängigkeitsprüfung, verlorener Fortschritts-Checkpoint und Fehler nach dem letzten Leserpaket.
- SQLite-/PostgreSQL-Vertragsinventar: 1.244 eindeutige Anwendungsstatements, davon 1.130 generierte PostgreSQL-Syntaxkandidaten und 114 offene Overrides. Das PostgreSQL-Vollanwendungsgate bleibt bei **0/1.244** akzeptierten Live-/Paritätsnachweisen geschlossen.
- Syntax- und Diff-Prüfung lokal erfolgreich. Keine Browsersteuerung oder visuelle Browserabnahme durchgeführt.
- Branch `feature/schedule-pdf-day-separators`, Ausgangs-HEAD `41e6d92e5fc95c30a4ecb11d478802a930ea44e1`; Version unverändert `0.92.27-beta`. Änderungen bleiben lokal und uncommitted.
