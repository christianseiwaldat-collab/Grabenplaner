# Gesamtimport · Block 2/6 – technisches Importfundament

Stand: 05.09.2026. Status: lokal implementiert und mit synthetischen Daten geprüft; nicht in der produktiven Anwendung aktiviert.

Nachtrag 06.09.2026: Der nachfolgend beschriebene historische `purge`-Pfad wurde im Zuge der ausdrücklich freigegebenen [datenbewahrenden Speicheroptimierung](GROSSDATEN-BACKUP-STRATEGIE.md) gesperrt (`IMPORT_PURGE_DISABLED`). Weder Ablauf noch Abbruch erlauben nun das Leeren der Prüf-/Rücknahmepayloads. Bestehende Altläufe bleiben lesbar; gemeinsame Teilobjekte werden vorerst nur in isolierten Tests ausdrücklich aktiviert. Die übrigen Block-2-Angaben dokumentieren den damaligen Ausgangsstand.

[Inventur und Gesamtplan](README.md) · [Aktueller Quellen-Vorabcheck](block2-preflight.json)

## Ergebnis und klare Blockgrenze

Der neue, quellenunabhängige Importkern bietet versionierte Profile und Quellenmanifeste, persistente verschlüsselte Prüfdaten, eine datensparsame Vorschau, Wiederholungs-/Konfliktprüfungen, atomare Übernahme in begrenzten Paketen, Wiederaufnahme und kontrollierte Rücknahme mit eigener Vorschau und Auditspur.

Die Speicheroperationen sind über den bestehenden provider-neutralen Persistenzvertrag gekapselt. Alle benannten SQL-Anweisungen werden durch den vorhandenen PostgreSQL-Dialektcompiler geprüft. Das Schema verwendet portable SQL-Grundtypen und echte Beziehungsfelder. Es wurde kein PostgreSQL-Server produktiv aktiviert und kein Live-PostgreSQL-Durchlauf behauptet.

**Nicht Teil dieses Blocks:** Kunden-/Artikel-/Verkaufsadapter für die produktiven Fachtabellen, echte Datenübernahme, neue Upload-/HTTP-Endpunkte, Importoberfläche, automatische Rechtevergabe, Bereitstellung von Schlüsseln, produktive Migration oder Änderung des bestehenden Artikelimports. Die neue Speicherung wurde nur in separaten synthetischen Testdatenbanken erzeugt. Die GP-Anwendungsdatenbank bleibt unverändert.

Die Fachadapter und ihre Einbindung folgen in Block 3/4, die vorgesehenen Fachansichten in Block 5. Insbesondere sind Vorschau und Rücknahme jetzt als getestete Servicefunktionen vorhanden, noch nicht als sichtbare Schaltflächen im GP.

## 1. Verträge und Herkunft

Ein Profil definiert unveränderlich:

- Profil-ID, Version, Quellsystem, Quelltabelle, Zielentität und erwarteten Schema-Fingerprint;
- explizite Quellschlüsselfelder und die freigegebenen Feldzuordnungen;
- Werttypen, NULL-Zulässigkeit, Dezimalpräzision und reine Herkunftsfelder ohne aktive Zielzuordnung;
- Datenklassen für die Berechtigungsprüfung sowie ausdrücklich ausgeschlossene Geheimnisfelder.

Es gibt keine frei eingegebenen SQL-Anweisungen, ausführbaren Feldtransformationen oder automatisch aus Quellrollen übernommenen Rechte. Bekannte Profile stammen aus der vertrauenswürdigen Server-Komposition, nicht aus ungeprüften Formular-/Uploadwerten. Änderungen am Profil erzeugen einen anderen Fingerprint; gespeicherte Läufe werden nicht nachträglich auf eine neue Feldzuordnung umgestellt.

Das Manifest bindet einen Lauf an Quellinstanz, Dateihash, Schemahash, Snapshot-Zeitpunkt, erwartete und deklarierte Zeilenzahl sowie offene Entscheidungstore. Die Quelle muss später durch einen fachlich freigegebenen Adapter selbst gelesen und geprüft werden. Ein vom Client übermittelter JSON-Bericht oder ein behaupteter Hash ist kein Nachweis authentischer Quelldaten.

Ein Lauf ist zusätzlich an Organisation/Bereich, ausführendes Konto und Profil-Fingerprint gebunden. Gleiche Startanforderungen liefern denselben Lauf zurück. Ein ausdrücklich neuer Versuch erhält eine eigene `attemptId`; dies verändert weder die fachliche Quellidentität noch die Regeln gegen doppelte Ziel-Datensätze.

Die stabile Quellidentität enthält Bereich, Quellsystem, Quellinstanz, Quelltabelle, Zielentität und Schlüsselfeldnamen/-werte. Sie ist unabhängig vom Dateinamen, Dateihash, aktuellen Importlauf und ausführenden Konto. Verschiedene Konten können daher nicht allein durch einen erneuten Import desselben Schlüssels neue Zielidentitäten erzeugen. Sichtbar sind dennoch nur die jeweils eigenen Läufe.

## 2. Ablauf und Zustände

| Schritt | Servicefunktion | Wirkung / Grenze |
| --- | --- | --- |
| Eigene Läufe finden | `list` | Kontogebundene Übersicht, aktuelle Leseberechtigung je Datenklasse und stabile Cursor-Pagination |
| Lauf eröffnen | `start` | Manifest und Profil unveränderlich speichern; idempotenter Start und Audit |
| Prüfwerte annehmen | `stage` | Fortlaufende Pakete von höchstens 200 Zeilen, verschlüsselte Speicherung; bei verlorener Antwort identische Pakete wiederholen |
| Eingang abschließen | `seal` | Nur bei genau erreichter erwarteter Zeilenzahl; danach keine Quellzeilenänderung mehr |
| Vorschau berechnen | `review` | Je Paket gegen aktuellen Ziel-/Quellbindungsstand prüfen; noch keine Fachschreibzugriffe |
| Ergebnis lesen | `preview`, `detail` | Übersicht ohne Quellwerte; vollständige Einzelwerte nur mit zusätzlicher Detailberechtigung |
| Übernehmen | `apply` | Nur bereiter Lauf ohne offene Tore und mit registriertem Fachadapter; pro Paket atomar mit Quellbindung, Änderungsnachweis und Audit |
| Rücknahme vorprüfen | `undoPreview` | Rücknahmefähigkeit je Seite prüfen, ohne Änderungen; die Prüfung wird bei der Rücknahme wiederholt |
| Rücknehmen | `undo` | Bereits übernommene Änderungen rückwärts und paketweise wiederherstellen; Revisionen bleiben aufsteigend |
| Unveröffentlichten Lauf abbrechen | `cancel` | Nur vor Fachübernahme; keine Änderung an Geschäftsdaten |
| Prüfwerte entfernen | `purge` | Explizite Entfernung verschlüsselter Prüf-/Rücknahmepayloads nach den unten genannten Regeln; Audit und Herkunftsmetadaten bleiben |
| Audit lesen | `events` | Kontogebundene, paginierte Ereignisse mit Aktion, Zeit und Laufrevision, ohne Quellfreitexte |

Zustandsfolge: `staging` → `reviewing` → `ready` oder `needs_review`. Von `ready` führt die bestätigte Übernahme über gegebenenfalls mehrere `applying`-Pakete zu `applied`. Rücknahmen laufen über `reverting` zu `reverted`. Nicht übernommene Läufe können `cancelled` werden; bereinigte Laufpayloads führen zu `purged`.

Eine Vorschau ist kein Freibrief für spätere Änderungen. Jede Mutation benötigt die erwartete Laufrevision. Bei der tatsächlichen Übernahme werden Zielrevision, Zielwerte und Quellbindungsrevision nochmals gegen die gespeicherte Vorschau geprüft. Änderungen seit der Vorschau führen zum Konflikt und zum vollständigen Zurückrollen des aktuellen Pakets; es wird nicht still neu geplant.

Nach einem Prozessneustart wird aus den gespeicherten Zeilenstatus fortgesetzt. Bereits bestätigte Pakete werden nicht erneut übernommen. Ein Fehler in einem Paket hinterlässt weder halbe Zieländerungen noch halbe Quellbindungen, Auditereignisse oder Fortschrittsmarkierungen. Bereits vorher erfolgreich bestätigte Pakete bleiben erhalten und können kontrolliert rückgenommen werden.

## 3. Prüfbereich statt stiller Datenverluste

- Unbekannte Spalten gelten als Schemadrift und weisen das gesamte betroffene Paket zurück; früher bestätigte Prüfpakete bleiben erhalten.
- Fachlich ungültige bekannte Werte bleiben verschlüsselt mit einem neutralen Fehlercode im Prüfbereich. Sie werden weder als korrekt übernommen noch still gelöscht.
- Exakte Wiederholungen desselben belegten Quellschlüssels und derselben Werte sind Dubletten. Derselbe Schlüssel mit verschiedenen Werten sperrt alle beteiligten Zeilen, nicht nur die zuletzt gelesene.
- Diese Behandlung setzt einen fachlich belegten Schlüssel voraus. Die in Block 1 gefundenen ungeklärten Tagesbericht- und Lieferanten-Schlüsselkandidaten dürfen noch nicht als bestätigte Importprofile verwendet werden.
- Kennungen bleiben Text einschließlich führender Nullen. Geldwerte bleiben Dezimalzeichenfolgen; keine Float-Summierung oder stillschweigende Rundung. Datum und Uhrzeit bleiben getrennte lokale Geschäftswerte.
- Herkunftsfelder ohne aktive Zielzuordnung bleiben im verschlüsselten Datensatz erhalten. Quellattribute werden nicht pauschal zu CRM-Notizen oder aktuellen Finanzkennzahlen umgedeutet.
- Bereits existierende Ziel-Datensätze ohne sichere Quellbindung erzeugen `UNLINKED_TARGET_EXISTS`. Explizite Zuordnungs-/Konfliktauflösung durch den jeweiligen Fachadapter folgt in Block 3; kein automatisches Zusammenführen anhand ähnlicher Namen.

## 4. Schutz manueller Änderungen und Rücknahme

Folgeimporte vergleichen pro zugeordnetem Zielfeld drei Stände: den letzten Quellwert, den aktuellen GP-Wert und den neuen Quellwert. Unveränderte Quellfelder überschreiben keine inzwischen manuell geänderten GP-Werte. Haben GP und Quelle dasselbe Feld unterschiedlich weitergeändert, wird die Zeile zum Konflikt.

Vor einer Übernahme muss der Fachadapter innerhalb derselben Provider-Transaktion arbeiten. Er muss sichere Identitätssuche, Lesen, Erzeugen, revisionsgebundene Änderung/Wiederherstellung, Abhängigkeitsprüfung und Entfernung bereitstellen. Er darf dabei keine externen Nachrichten, Dateien oder andere nicht transaktionale Nebenwirkungen auslösen.

Für jede tatsächliche Änderung werden Vorherzustand, Nachherzustand und vorherige Quellbindung verschlüsselt aufgezeichnet. Eine Rücknahme ist nur möglich, wenn:

1. keine spätere, noch wirksame Übernahme dieselbe Quellbindung beansprucht;
2. Zielwerte und aktuelle Revision zum erwarteten Nachherzustand passen;
3. keine vom Fachadapter gemeldeten abhängigen Vorgänge eine Löschung oder Wiederherstellung verhindern.

Eine spätere manuelle Änderung wird niemals durch „Rückgängig“ überschrieben. Bei Rücknahme einer Folgeübernahme wird die vorherige Quellbindung wiederhergestellt und ihre erwartete Zielrevision aktualisiert. Dadurch kann anschließend auch eine frühere Übernahme rückgenommen werden, sofern deren übrige Voraussetzungen noch erfüllt sind. Die Revision des Ziel-Datensatzes wird nicht zurückgedreht.

Die Rücknahme-Vorschau ist paginiert und beurteilt nur die angezeigte Seite; sie behauptet keine Freigabe für ungelesene Seiten. `undo` prüft jedes Paket unmittelbar erneut. Ein später blockiertes Paket lässt bereits sicher rückgenommene Pakete nachvollziehbar im Zustand `reverting` stehen; es erfolgt keine blinde Fortsetzung.

## 5. Schutz der gespeicherten Daten

Prüfwerte, Quellwert-Baselines und Vorher-/Nachherdaten werden mittels AES-256-GCM verschlüsselt. Die Authentifizierung bindet sie an Zweck, Bereich, Lauf und Zeile bzw. Quellbindung. Vertauschte Payloads, falsche Schlüssel und veränderte Identitäts-/Inhaltssummen werden abgewiesen.

Quellidentitäten und Inhaltsprüfsummen verwenden schlüsselgebundenes HMAC-SHA-256 statt öffentlich nachrechenbarer Hashes kleiner Kunden- oder Personalnummernräume. Die Schlüssel werden ausschließlich von einer späteren geschützten Server-Komposition bereitgestellt. Dieser Block erzeugt oder verändert keine produktiven Schlüssel, Zugänge oder Umgebungsvariablen. Der Indexschlüssel muss für stabile Quellidentitäten erhalten bleiben; ein neuer Verschlüsselungsschlüssel macht alte Payloads nicht automatisch lesbar. Ein produktiver Rotations-/Keyringpfad ist vor seiner Nutzung gesondert zu integrieren.

Jede Serviceaktion prüft die aktuelle Berechtigung, nicht nur die Eröffnung des Laufs. Lesen, Prüfdaten schreiben, Vorschau berechnen, sensible Details lesen, übernehmen, rücknehmen und bereinigen sind getrennte Aktionen. Rechte folgen der freigegebenen Profil-/Datenklasse. Bestehende GP-Rollen einschließlich `developer` wurden nicht verändert; keine Altrolle kann daraus GP-Rechte ableiten.

Das technische Gültigkeitsfenster beträgt derzeit 30 Tage für Vorschau, Übernahme und Rücknahme. Nach Ablauf werden aktive Schreib-/Detailaktionen abgewiesen. **Es läuft keine automatische Löschung.** Abgebrochene und rückgenommene Läufe können ausdrücklich bereinigt werden; bei vollständig übernommenen Läufen ist die Payload-Bereinigung erst nach Ablauf dieses Fensters erlaubt. Aktuelle Quellbindungen bleiben für die Erkennung von Folgeimporten erhalten. Teilweise übernommene Läufe werden nie automatisch bereinigt und benötigen bei abgelaufenem Fenster einen gesonderten geprüften Wiederherstellungsweg. Vor Produktivaktivierung ist diese Aufbewahrungs-/Wiederherstellungsregel im Betriebskonzept festzulegen.

## 6. Quellen-Vorabcheck und offene Tore

Der separate Diagnosebefehl prüft die vollständige Inventur gegen die aktuellen Dateihashes. Er liest die Dateien nur als Byte-Streams, führt keine Access-Makros aus, verfolgt keine Verknüpfungsziele und übernimmt keine Fachzeilen in den GP.

Der Quellenstand aus Block 1 enthält weiterhin die Differenzen von einem Artikel und vier Artikel-Filial-Zeilen zwischen Metadatenzähler und gelesener Menge. Der zusätzliche native Read-only-ACE-Prüfversuch am 05.09.2026 lieferte kein auswertbares Ergebnis (Prozessende `-3`). Daraus wird weder eine Ursache noch eine erfolgreiche Gegenprüfung abgeleitet.

`SOURCE_ROW_COUNT_MISMATCH` bleibt deshalb geschlossen. Daneben bleibt `BUSINESS_ADAPTERS_PENDING` aktiv. Ein JSON-Inventurbericht ist grundsätzlich nur Diagnostik und besitzt immer `canImport: false`. Ein geänderter Dateihash, Schema-Fingerprint, fehlendes Feld oder unvollständige Tabellenbilanz wird zusätzlich als Sperrgrund ausgegeben. Keine der offenen Fachfragen Q02–Q12 wird durch diesen Block als beantwortet markiert.

## 7. Implementierung und Verifikation

| Datei | Aufgabe |
| --- | --- |
| [data-import-contract.js](../../lib/data-import-contract.js) | Unveränderliche Profile, Wert-/Schlüssel-/Manifestverträge, Grenzen |
| [data-import-protection.js](../../lib/data-import-protection.js) | Verschlüsselung und schlüsselgebundene Prüfsummen |
| [data-import-engine.js](../../lib/data-import-engine.js) | Laufsteuerung, Vorschau, Schutz manueller Änderungen, Übernahme-/Rücknahmeregeln |
| [data-import.js – Repository](../../lib/persistence/repositories/data-import.js) | Providergebundene serialisierbare Transaktionen |
| [data-import.js – Statements](../../lib/persistence/statements/data-import.js) | Benannte Persistenzverträge |
| [data-import-catalog.js](../../lib/persistence/sqlite/data-import-catalog.js) | Parametrisierte SQL-Zuordnungen, durch PostgreSQL-Compiler geprüft |
| [data-import-schema.js](../../lib/persistence/sqlite/operations/data-import-schema.js) | Isoliertes Schema für Läufe, Zeilen, Quellbindungen, Änderungen und Ereignisse |
| [tradefoto-import-preflight.js](../../lib/tradefoto-import-preflight.js) | Nicht schreibende Auswertung der Gesamtinventur |
| [check-tradefoto-import-foundation.mjs](../../scripts/check-tradefoto-import-foundation.mjs) | Quellenhash-Vergleich und datensparsamer Diagnosebericht |
| [data-import-foundation.test.js](../../test/data-import-foundation.test.js) | Synthetische Funktions-, Persistenz-, Schutz- und Negativtests |

Nachweise umfassen insbesondere Paketreihenfolge, verlorene Antworten, wiederholte Quellen, symmetrische Schlüsselkonflikte, manuelle Feldänderungen, konkurrierende Vorschauen, Abbruch innerhalb einer Transaktion, Wiederaufnahme aus einer geschlossenen und neu geöffneten Dateidatenbank, Rücknahme mit Abhängigkeiten, verschlüsselte Prüfwerte, manipulierte Ciphertexte/Metadaten, Kontogrenzen und widerrufene Berechtigungen.

Reproduzierbare Prüfungen:

```text
node --test --test-concurrency=1 test/data-import-foundation.test.js
node --test --test-concurrency=1 test/v087-database-coupling-inventory.test.js
node scripts/check-tradefoto-import-foundation.mjs docs/tradefoto-gesamtimport-v0.1/catalog.json TRADE.accdb CASH.accdb docs/tradefoto-gesamtimport-v0.1/block2-preflight.json
git diff --check
```

Die Bestandsregression umfasst außerdem die vorhandenen Artikel-/ACCDB-Importverträge, das frühere Analyse-Importfundament, dessen Persistenz, CRM-Persistenz und den SQLite-Provider. PostgreSQL wurde auf Vertrag-/Compiler-Ebene geprüft, nicht gegen eine laufende Datenbank. Die App-Vollsuite und der umfangreiche Echtdaten-Testimport bleiben dem ausdrücklich freigegebenen Abschlussblock vorbehalten.

Abschließender lokaler Prüflauf: **92 Tests bestanden, 0 Fehler, 0 übersprungen**; davon 34 neue Fundamenttests. Alle 25 Persistenzstatements wurden als `portable-generated` übersetzt. Syntax-, Dokumentlink-, Katalogkonsistenz- und Whitespace-Prüfungen sind bestanden. Beide Dateihashes stimmen weiterhin mit Block 1 überein; `BUSINESS_ADAPTERS_PENDING` und `SOURCE_ROW_COUNT_MISMATCH` bleiben ausdrücklich aktiv.

## Übergabe an Block 3

Fortsetzung: [Block 3 – Stammdaten und CRM](BLOCK-3-STAMMDATEN-CRM.md) ist inzwischen
lokal implementiert. Die folgende Übergabe dokumentiert den damaligen Abschluss
von Block 2 und wird dadurch nicht zur Freigabe einer produktiven Übernahme.

Nächster freizugebender Schritt: Stammdaten-/CRM-Profile und Fachadapter entwickeln, insbesondere Quellbindungen vorhandener Artikel und Kunden, explizite Standort-/Personalzuordnung, getrennte Zusatzkontakte/-adressen und Konditionen. Vor echter Übernahme müssen Q01 und die jeweils betroffenen Fach-/Rechtetore belastbar geklärt sowie Schlüsselverwaltung, Rechtekomposition und produktive Migration separat integriert und getestet sein.

Kein Commit, Push, Versionswechsel oder Deploy im Rahmen dieses Blocks.
