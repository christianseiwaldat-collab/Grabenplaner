# Block 1: Bestand, Aufteilung und Abnahmevertrag

Stand 12.09.2026. Die Zwei-Datenbank-Variante ist vom Nutzer gewählt. Dieser Block 1 gehört zum neuen 12-Block-Migrationsplan, nicht zu den alten v0.87-Providerblöcken.

## Ergebnis

Alle 248 Tabellen und sämtliche 267 expliziten Indizes, 369 Trigger sowie die View sind in [block-1-inventory.json](block-1-inventory.json) einzeln zugeordnet. Grundlage sind die live gelesene Struktur und die unveränderte Sicherung `dienstplan-2026-09-12T04-58-19-637766712-92c4e5d379db.db`. Ihre Schemafingerprints stimmen überein. Mengen und Seitenbelegung stammen ausschließlich aus dieser Sicherung; keine erneute vollständige produktive Integritätsprüfung.

| Ziel | Tabellen | Daten einschließlich zugehöriger Indizes |
|---|---:|---:|
| `grabenplaner_core.gp` | 191 | 261.840.896 Bytes, ca. 249,71 MiB |
| `grabenplaner_sales` | 57 | 2.328.109.056 Bytes, ca. 2,17 GiB |

Damit entfallen etwa 90 % des zugeordneten Platzes auf Verkauf. PostgreSQL-Zielgrößen einschließlich WAL und neuer Indizes müssen später gemessen werden. Eine Tabellenaufteilung ist keine Zusage desselben Speicherverbrauchs nach Konvertierung.

## Eigentümer und Verbindungen

- Core führt Personal, CRM, Rollen und individuelle Rechte, Planung, Zeiten, Workflows, Leihe, Bestellung sowie globale Quellenkonfiguration und Schlüsselreferenzen.
- Sales führt die importierten Quellbestände, Importläufe/Payloadblöcke/Rücknahmeinformationen, Kassenbereitstellung, Artikelrevisionen/Bilder, Berichte und Wörterbücher. Die bisherigen Importtabellen bleiben als zusammenhängender Verbund erhalten. Generischer Import darf beim späteren Umbau nicht per Namensheuristik aufgeteilt werden; die hier erzeugte explizite Objektliste ist der geprüfte Ausgangsstand.
- Drei Fremdschlüsselbeziehungen kreuzen die neue Grenze: `loan_items` zur zusammengesetzten Artikelrevision sowie `sales_branch_mapping_revisions` und `sales_aggregate_reports` zu Standorten. Dafür sind lokale unveränderliche Referenzstände und versionierte Zuordnungen in Block 7 nötig. Keine ersatzlose Entfernung einer Beziehung.
- Ein katalogisiertes SQL-Statement (`import-master.crm.dependents`) liest beide Seiten. Zwei Schemaabfragen gehören in die providerabhängige Core-Systemauskunft. Der SQL-Wortvergleich inventarisiert mögliche Beziehungen konservativ; er ersetzt nicht die nachfolgende Prüfung der Repository-Transaktionen.
- Zusätzliche Beziehungen verlaufen über mehrere Aufrufe: CRM-Import samt eigenen Feldern/Fotos, Artikelübernahme in Leihen, Mitarbeiter-/Filialzuordnungen, zentrale Rechteprüfung und Berichtaufträge. Diese werden an der Core/Sales-Kompositionsgrenze geprüft. Berichte müssen Kassen-, Trade-, Zuordnungs- und Regelrevision gemeinsam binden.

## Vollständigkeit außerhalb der Datenbank

Das geschützte GP-Verzeichnis wurde auf Dateimetadaten geprüft. `private`: 56 Dateien / 8.091.866 Bytes; `branding-kits`: 9 / 200.399 Bytes. Dateiinhalte und Konfigurationswerte wurden nicht in Prüfartefakte ausgegeben. Eigene Artikelbilder liegen separat davon als BLOB in der Datenbank. Aktuelle Nullbestände sind kein Grund, diese Speicherverträge auszulassen.

| Bereich | Behandlung |
|---|---|
| Datenbank und WAL/SHM | Konsistenter SQLite-Ausgangssnapshot; Journale nicht als unabhängige Datenquellen migrieren |
| Private Dokumente/Fotos und Branding | Vollständiges Dateimanifest, Referenz-/Hashprüfung und gekoppelter Restore in Block 9/10 |
| AMU-/Integrations-/WLAN-Schlüssel, Secret- und Tokenkonfiguration | Getrennte geschützte Übernahme; bestehende Schlüsselkennung und Kontextbindung erhalten; keine Werte im Repository |
| `backups`, zusätzliche Sicherungen unter `/var/backups/grabenplaner` | Alte SQLite-Rückkehrpunkte behalten; nicht in fachliche PostgreSQL-Tabellen importieren |
| `maintenance`, Offsite-/Assurance-Zustände und Belege | Betriebshistorie erhalten; providergebundene neue Belege in Block 10 erzeugen; alte Erfolgsbelege gelten nicht automatisch für PostgreSQL |
| Historisches `.lock-helper-test` | Als vorhandenen technischen Altbestand dokumentieren und unangetastet lassen |
| Laufzeitkonfiguration, Dienstdefinitionen, Mailfreigaben, TLS-/Zugriffskonfiguration | Separater Betriebsvertrag; kein automatisches Übernehmen produktiver Verbindungen in Tests |

Größter Core-Verbraucher ist `work_rule_evaluation_runs`: 544 Einträge mit zusammen etwa 219,47 MiB einschließlich Indizes. Diese Auswertungsverläufe bleiben erhalten. Ihre mögliche Aufbewahrungsoptimierung ist kein Teil der Datenübernahme.

## Reproduzierbare Baseline und Ziele

- [Core-Baseline](block-1-core-baseline.json): aktuelles vollständiges SQLite-Schema, 200 synthetische Mitarbeiter, vier reale Katalog-Lesewege, je 100 Messungen nach fünf Aufwärmläufen. Dies ist eine Repository-Baseline ohne HTTP und ohne Konkurrenzlast.
- [Artikel-Baseline](block-1-sales-baseline.json): 19.024 synthetische Artikel, aktuelle Suche mit Suchprojektion, identische Treffer zum bisherigen Fachvertrag. Das alte Messskript benötigte eine Ergänzung seiner Fixture um die inzwischen hinzugekommenen Preisquellen. Lauf erfolgreich; keine Produktivänderung.
- Produktionsähnliche Gesamtlast samt Entschlüsselung, Browser/Netzwerk und parallel laufenden Berichten wird nach den Portierungen in Block 8/11 gemessen. Die obigen lokalen Zeiten werden nicht als heutige produktive p95-Werte ausgegeben.
- Festes Vergleichsprofil für die spätere Abnahme: je fünf gleichzeitige interaktive Benutzer, ein großer Bericht, Monats- und Mehrjahreszeitraum, Einzel- und Gesamtfilialen, exakte und mehrteilige Artikel-/Belegsuche. Mindestens 100 auswertbare Wiederholungen pro interaktivem Fall, getrennte Kalt-/Warmläufe, dieselbe Probe und derselbe Rechner vor/nachher. Erfasst werden p50/p95, Antwortvollständigkeit, SQL-/Poolwartezeit, CPU, RSS, Eventloop-Verzögerung und Fehler.
- Ziele: erste normale Suchseite p95 < 1 s, Folgeseite < 500 ms; Auftragsannahme < 1 s. Interaktive GP-Kernfunktionen sollen unter Berichtlast höchstens 20 % gegenüber ihrer gemessenen PostgreSQL-Baseline nachgeben. Ziele bleiben bis zum Lastnachweis offen; keine unvollständigen Ergebnisse für einen besseren Messwert.

## Sicherheits- und Aufwandseinschätzung

Jede Tabelle erhält in Block 9 einen kanonischen Inhaltsvergleich, nicht nur `COUNT(*)`. Alle Quellen, auch ungeklärte Belege, Historien, Bilder und Rechte bleiben enthalten. Typ-/Nullability-, Dezimal-, Zeit-, Identitäts- und Verschlüsselungsregeln aus der Bestandsaufnahme gelten weiter.

191 Core-Tabellen und ihre umfangreichen Trigger bestätigen die bisherige Spanne von 25–45 technischen Arbeitstagen für alle zwölf Blöcke. Für Blöcke 3/4 ist das obere Ende ernst zu nehmen; kleine erfolgreiche Provider-Slices rechtfertigen keine pauschale Freigabe. Core/Sales-Übergaben sind explizite Abhängigkeiten von Block 7, vollständiger Betrieb/Produktivwechsel von Block 10–12.

## Verifikation

Die vier gezielten Inventartests bestanden: exakte Objektvollständigkeit, synthetischer Aufbau des ganzen aktuellen Schemas einschließlich aller Trigger, referenzielle Integrität der Probe und Ablehnung einer ungeprüften Quellschemaänderung vor erneuter Zielzuordnung. Beide Baselines wurden ausgeführt. Produktive Daten, Dienste und Zugänge wurden nicht verändert. Block 1 ist damit als Inventar- und Abnahmevorbereitung abgeschlossen; anschließend folgt die isolierte Umgebung.
