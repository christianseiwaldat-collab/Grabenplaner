# Block 4: lokaler Einstieg für historische Auswertungen

Aktueller Abschluss der erneuten Vorprüfung: [Bestehender GP und gesamte schlanke Kasse](BLOCK-4-NEUPRUEFUNG-2026-09-07.md). Die nachstehenden früheren Größen des universellen Gesamtimports sind historische Vergleichswerte. Es läuft kein weiterer Trade-Volltest; die Kassenintegration kann mit den vorhandenen geprüften Nachweisen fortgesetzt werden.

Aktuelle Umfangsentscheidung: [TradeFoto vollständig und gesamte Kasse im schlanken GP-Prototyp](KASSE-VOLLBESTAND-GP-PROTOTYP-2026-09-07.md). Die 24-Monate-Grenze entfällt; nur der Kassenaufbau wird vereinfacht. Die folgende lokale/VPS-Platzprüfung bleibt ein Nachweis für den ursprünglichen universellen Importaufbau; der neue Kassenaufbau wird gesondert nach Größe und Wiederherstellung qualifiziert.

Der aktuelle [Vollbestands-GP-Prototyp](KASSE-VOLLBESTAND-GP-PROTOTYP-2026-09-07.md) belegt 816,53 MB für die gesamte Kasse einschließlich Verschlüsselung und Indizes sowie ein 449,21-MB-Archiv mit erfolgreicher gekoppelter Wiederherstellung und erneutem vollständigem Wertevergleich. Die frühere Platzrechnung wird dadurch nicht automatisch freigegeben; die geschäftliche Aktivierung und Gesamtprüfung des Betriebs bleiben ausstehend.

Stand: 07.09.2026. Branch `feature/schedule-pdf-day-separators`, HEAD `41e6d92e5fc95c30a4ecb11d478802a930ea44e1`. Ergebnis: Der lokale Einstieg ist technisch möglich und die Platzprüfung für den vorhandenen isolierten Import-/Prüfablauf besteht. Eine dauerhaft nutzbare lokale Historieninstallation wurde in dieser Prüfung noch nicht gestartet. Der produktive VPS-Gesamtimport bleibt gesondert abnahmepflichtig.

## Nutzung und Datenstand

Der Nutzer benötigt vor allem Statistiken über die Vergangenheit. Es gibt keine Anforderung an täglich neue Kassenexporte. Ausschließlich die zuletzt bereitgestellten Dateien gelten bis zum nächsten Upload, auch über mehrere Wochen. Diese Klarstellung verkleinert nicht stillschweigend den zuvor vereinbarten Gesamtimport einschließlich CRM und historischer Verkäuferzuordnung.

Die beiden Desktop-Dateien vom 04.09.2026 wurden erneut gehasht und stimmen mit dem bestandenen Vollbestandslauf überein: Trade 188.649.472 Bytes, Kasse 330.928.128 Bytes. Ihre gemeinsamen rund 519,58 MB sind nicht mit der Größe der abgeleiteten Grabenplaner-Historie gleichzusetzen. Letztere enthält zusätzlich verschlüsselte Quell- und Änderungsnachweise, Zuordnungen und Indizes; der geprüfte kompaktierte Bestand hatte rund 11,60 GB.

Ein unveränderter Export verlangt keinen erneuten Vollimport. Ein normales App-Backup verlangt ebenfalls keinen Quellenimport. Der erste vollständige Aufbau dauerte in der vorhandenen Messung rund fünf Stunden; eine Wiederholung dieser Laufzeit ist keine Garantie und ein schnellerer vollständiger Neuaufbau wurde nicht nachgewiesen.

Der Nutzer hat zusätzlich klargestellt, dass Trade und Kasse nicht gleichzeitig importiert werden müssen. Für die Fortsetzung werden die Quellen getrennt verarbeitet: beim Erstaufbau zunächst Trade mit den benötigten Stammdaten und Zuordnungen, anschließend die davon abhängige Kassenhistorie. Die Schritte dürfen zeitlich auseinanderliegen. Jeder Quellenstand besitzt einen eigenen Abschluss; ein neuer Export der einen Datei verlangt keinen erneuten Import einer unveränderten anderen Datei. Unterschiedliche Bereitstellungszeitpunkte werden nachvollziehbar ausgewiesen; fehlende historische Bezüge bleiben offen, bis sie geprüft zugeordnet sind.

Der vorhandene Vollmessungshelfer verarbeitet die beiden Quellen bereits sequenziell: In `scripts/verify-tradefoto-full-import.mjs` wird Upload, Prüfung und Übernahme einer Quelle vollständig abgewartet, bevor die nächste Quelle folgt. Die gemessenen 11,60 GB bezeichnen den danach gespeicherten Gesamtbestand. Sie entstehen nicht durch zwei gleichzeitig laufende Importprozesse. Die neue Klarstellung erlaubt getrennte Betriebsphasen, begründet aber keinen nachträglichen Speicherabzug vom bereits sequenziell gemessenen Bestand. Eine Verringerung des dauerhaften Platzbedarfs benötigt weiterhin die Prüfung des Import-/Historienmodells.

Die anschließende [Berechnung nur für TradeFoto](TRADE-EINZELIMPORT-BERECHNUNG-2026-09-07.md) grenzt den ersten Abschnitt des Messprotokolls ab: 188,65 MB Quelle, 395.163 Zeilen, rund 71 Minuten Import und 3,53 GB beobachtete Spitze für Datenbank samt Schreibjournal. Die separate kompaktierte Endgröße und Archivgröße wurden damals nicht gemessen. Für einen begrenzten Trade-Folgeversuch mit 4-GiB-Datenbanklimit ergibt der vorhandene Budgetrechner 29,53 GB Startfreiraum; ein neuer Lauf wurde nicht gestartet.

Für die Oberfläche sind Quelldateistand, Übernahmezeitpunkt und tatsächlich belegter Geschäftszeitraum getrennt auszuweisen. Ein alter Upload ist als historischer Stand zulässig. Nicht belegte Tage werden weiterhin nicht als erwiesener Nullumsatz ausgegeben. Regeln, Vollständigkeitsabgleich und bestätigte Personal-/Filial-/Kundenzuordnungen bleiben erforderlich; fehlende Zuordnungen werden nicht aus gleichen Nummern geraten.

## Aktuelle Platzprüfung

Alle Größen in dieser Tabelle sind dezimale GB. Der lokale Import-/Messplan und das VPS-Betriebsmodell haben unterschiedliche Umfänge.

| Bereich | Frei | Vergleichsbudget | Ergebnis |
| --- | ---: | ---: | --- |
| Interne C:-Platte | 136,54 GB | 98,25 GB für den vorhandenen kontrollierten Import-/Backup-/Restore-Messablauf einschließlich Reserve | Rund 38,29 GB darüber; lokale Startprüfung bestanden |
| VPS | 72,46 GB | 133,30 GB zusätzlicher Freiraum im bisherigen gemeinsamen Betriebsmodell | Rund 60,84 GB fehlen für dieses Modell |

Die lokale Zahl ist eine Startprüfung des bestehenden begrenzten Ablaufs, keine pauschale Freigabe beliebig vieler dauerhafter Vollkopien. Die 133,30 GB werden mit dem freien VPS-Platz verglichen, nicht zu den 72,46 GB addiert. Seltene neue Quelldateien beseitigen dort nicht automatisch die Sicherheitskopien für App-Backup, Wiederherstellung und Updates. Drei verbleibende Sicherungspunkte allein lösen den Engpass des bestehenden Modells nicht.

Der lesende VPS-Check vom 07.09.2026, 03:41:29 UTC bestätigt App und Caddy aktiv. Keine erneute Wiederherstellung, kein Import, keine Änderung installierter Dienste, keine Löschung und kein Speicherzukauf. Einzelwerte und Quellenhashes stehen im [maschinenlesbaren Nachweis](LOKALER-BLOCK-4-START-2026-09-07.json).

## Drei mögliche Wege

### 1. Import und Auswertung vorerst vollständig lokal

Dieser Einstieg vermeidet die noch offene VPS-Kapazitätsfreigabe für die erste Nutzung. Der vorhandene Grabenplaner unterstützt bereits einen eigenen Datenordner und Betrieb auf `127.0.0.1`. Importverwaltung, Zuordnungsoberfläche und schrittweise historische Zeitraumsauswertung sind vorhanden. In der normalen App sind Übernahme, Zuordnung und Historienaktivierung jedoch weiterhin ausdrücklich geschlossen; ein unverändertes `node server.js` zeigt noch keine freigegebenen neuen Historienkennzahlen.

Konkrete verbleibende Umsetzung für diesen Weg:

1. Einen eigenen dauerhaften Datenordner auf C: mit lokalem Startprofil und verwalteter, wiederherstellbarer Schlüsselablage einrichten. Bestehende lokale Datenbanken bleiben erhalten.
2. Die bestätigten Quellen-, Rechenregel- und Belegabdeckungsnachweise in dieser lokalen Installation an die persönliche Anmeldung binden. Fachliche Zuordnungen vor abhängiger Historie ausdrücklich übernehmen; keine synthetischen Test-IDs verwenden.
3. Den Vollbestand einmal dauerhaft aufbauen, danach vollständige Zeiträume und Geschäftszuordnungen abgleichen. Die lokale Oberfläche zeigt den historischen Quellenstand.
4. Den gekoppelten Stand aus Datenbank und Schlüsselverwaltung archivieren und separat zurücksichern. Für diesen neuen lokalen Bestand einen begrenzten Sicherungsablauf prüfen; eine bestehende VPS-Aufbewahrung wird dadurch nicht geändert.

Die zwölf Implementierungsdateien der bestandenen Vollbestandsmessung sind weiterhin unverändert. Deren Testdatenbank wurde aber wie vorgesehen entfernt und der flüchtige Testschlüssel vernichtet. Dieser Test liefert einen Import-/Restore-Nachweis, keine schon vorhandene dauerhafte Benutzerinstallation. Der Testhelfer wird nicht einfach auf dauerhafte Nutzung umgestellt: Seine synthetischen Ziele und sein flüchtiger Schlüssel gehören ausschließlich zur Verifikation.

### 2. Nur den Erstimport lokal ausführen, danach am VPS auswerten

Dies kann die Serverlast beim ersten Aufbau verringern, beseitigt aber weder den großen dauerhaften Bestand noch dessen Backup-/Restore-Bedarf auf dem VPS. Für eine Übernahme ausschließlich der geprüften Historie ist noch kein fertiger Transferweg qualifiziert. Der zum Übernahmezeitpunkt aktuelle Dienstplan- und Personalbestand muss erhalten bleiben; eine lokal aufgebaute Gesamt-App-Datenbank kann dafür nicht als pauschaler Ersatz dienen.

Zusätzlich bleiben die bestehende Paket-/Runtime-Migration, die gemeinsame Kapazitätsabnahme und der vollständige signierte Betriebs-/Wiederherstellungslauf erforderlich. Der zuletzt fehlgeschlagene vollständige VPS-Lauf scheiterte am installierten 120-Sekunden-Startfenster; die längere lokale Korrektur ist noch nicht installiert. Separate erfolgreiche Restores ersetzen diesen vollständigen Lauf nicht.

### 3. Später ein eigenes, lesbares Historienarchiv

Ein unveränderlicher Archivstand mit einer davon getrennten Auswertung könnte vermeiden, dass die gesamte alte Kassenhistorie in jede operative Dienstplan-Sicherung eingeht. Neue Stände würden erst nach einem neuen Upload aufgebaut, geprüft und aktiviert. Die vollständigen Quellen bleiben als Grundlage erhalten.

Das ist eine passende Architektur für selten aktualisierte historische Daten, derzeit aber ein eigener Umbau. Benutzerrechte, Kundenzuordnung, Datenstandswechsel und gemeinsame Wiederherstellung müssten dafür zusammenhängend umgesetzt werden. Ein geringerer dauerhafter Speicherbedarf wäre neu zu messen; aus diesem Vorschlag ergibt sich keine bereits umgesetzte Einsparung.

## Ergebnis dieser Fortsetzung

Aktueller Checkout, freier C:-Platz, vorhandenes Importbudget, Quellenhashes, unveränderte Messimplementierung und die weiterhin geschlossenen Aktivierungsgrenzen wurden lesend geprüft. Das VPS-Freiraumdefizit wurde frisch bestätigt. Die lokale Vorbereitung kann unabhängig von einer produktiven VPS-Freigabe fortgesetzt werden. Ob die erste Nutzung vollständig lokal bleiben oder nur der Erstimport lokal stattfinden soll, wurde dem Nutzer zur Auswahl gestellt.

In dieser Fortsetzung wurden nur diese Entscheidungsvorlage, ihr Nachweis und der aktuelle Verweis ergänzt. Kein neuer mehrstündiger Import, keine Produktivaktivierung, kein Commit, Push oder Deploy. Die vorherigen Mess- und Fehlerberichte bleiben erhalten.
