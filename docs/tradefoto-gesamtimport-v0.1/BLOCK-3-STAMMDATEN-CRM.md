# TradeFoto-Gesamtimport · Block 3/6 · Stammdaten und CRM

Stand: 05.09.2026. **Lokal implementiertes, synthetisch geprüftes Backend; keine produktive Aktivierung und keine Übernahme echter Geschäftsdaten.**

Arbeitsbasis: `feature/schedule-pdf-day-separators`, HEAD `8e0131f3a036fdda2ebd4fcc6aaab45b8a359478`, App `0.92.26-beta`. Vorhandene Änderungen aus [Block 1](README.md) und [Block 2](BLOCK-2-IMPORTFUNDAMENT.md) bleiben erhalten. Kein Commit, Push, Versionswechsel oder Deploy gehört zu dieser Freigabe.

## 1. Ergebnis und Abgrenzung

Das Importfundament besitzt jetzt Stammdatenprofile, transaktionsgebundene Fachadapter und einen gesonderten Zuordnungs-/CRM-Abgleichservice. Der zweistufige Aufbau ist bewusst:

1. **Geschützte Quellübernahme:** typisierte Herkunft, Zusatzkontakte, Adressen, Lieferanten, Konditionen, Taxonomie, Artikelattribute, Medienreferenzen und historische Organisationswerte erhalten.
2. **Bestätigte GP-Zuordnung:** geprüfte Kunden in die bestehende CRM-Kartei übernehmen oder vorhandene Kunden ausdrücklich verknüpfen; Artikel nur über ihre bereits vorhandene zentrale Trade-Quellbindung verbinden; Personal und Standorte einzeln bestätigt zuordnen.

Der Quellbestand ist kein zweiter operativer Artikelkatalog. Bestehende GP-Artikelidentitäten, Preise, Kennungen, Revisionen und Leihreferenzen werden nicht ersetzt. Der vorhandene Artikelimport bleibt der Weg für den zentralen Artikelstamm. Ungeprüfte zusätzliche Quellpreise werden durch diesen Block nicht zu gültigen Verkaufspreisen erklärt.

**Noch nicht enthalten:** Importoberfläche, produktive Serverrouten, Anwendungsmigration, Schlüssel-/Rechteverdrahtung, Verkaufs- oder Kassenübernahme, operative Konditionsberechnung, automatischer Abgleich aller Kunden oder eine Freigabe des Gesamtimports. Die Quellinventur bleibt `canImport: false`.

## 2. Vollständigkeit innerhalb dieses Blocks

| Umfang | Umsetzung |
| --- | --- |
| 66 Stammdatentabellen / 761 Quellfelder | Alle Tabellen aus `catalog.*`, `crm.*`, `suppliers.*` und `organization.*` des Block-1-Katalogs; auch leere Tabellen |
| 759 Geschäftsfelder | Vollständig in typisierten, verschlüsselten Quellsegmenten abgebildet |
| 2 Geheimnisfelder | `KUNDEN.Kennwort` und `MITARBEITER.Kennwort` ausgeschlossen; weder kopiert noch gehasht |
| 22 schlüsselbasierte Profile | Explizit ausgewählte, in der Inventur eindeutige und nicht leere Schlüsselkandidaten |
| 44 Snapshot-Profile | Identität aus Dateihash und Zeilenordinal; keine vermeintliche Deduplizierung echter Mehrfachvorkommen |
| 46 Beziehungen | 43 deklarierte Access-Beziehungen und 3 ausschließlich prüfende Kandidaten; Schema-Schreibweisen vereinheitlicht, Quellwerte nicht |
| 31 benannte SQL-Verträge | Providergebundene Statements; alle PostgreSQL-portabel kompilierbar |

Der Metadatengenerator prüft jeden ausdrücklich verwendeten Schlüsselkandidaten erneut gegen die Inventur. Ein eindeutiger Snapshot-Schlüssel ist **kein Nachweis eines Access-Primärschlüssels**. Insbesondere bleibt `LIEFERANTEN.Lieferant_ID` ungeeignet: der Quellcode `Suchname` dient als dokumentierter Kandidat. Lieferanten mit derselben numerischen Altkennung werden nicht zusammengeführt.

Snapshot-Profile behalten mehrere identische Notizen, Konditionssätze oder Adressen als getrennte Vorkommen. Ein erneuter Import derselben Datei und Zeile ist identisch; eine andere Datei erzeugt neue Herkunftsvorkommen. Daraus darf eine spätere Oberfläche keine kumulierte Zahl aktiver Adressen oder Konditionen ableiten: Anzeige nach vollständigem Snapshot/Herkunft ist nötig. Es gibt keine automatische Lösch- oder Zusammenführungsregel für fehlende Zeilen eines späteren Snapshots.

Artikelbestände, Bewegungen, Shop-Zuordnungen außerhalb dieser Gruppen, Reparatur-/Belegreste, Kassen- und Finanzreferenztabellen bleiben im Gesamtkatalog und sind **nicht** durch diese 66 Profile erledigt. Sie gehören zu den Folgeblöcken.

## 3. Typen und fachliche Projektionen

Kennungen bleiben Zeichenfolgen einschließlich führender Nullen. Access-Ganzzahlen werden nur bei sicherer Darstellung in Textkennungen umgewandelt. Geld-, Mengen- und Prozentfelder werden als Dezimalzeichenfolgen geführt, nicht als JavaScript-Geldsummen. Mehr als zwölf Nachkommastellen werden nicht still gerundet, sondern verbleiben als beanstandete Zeile im geschützten Prüfbestand. Die Dezimaldarstellung belegt keine höhere Genauigkeit als das ursprüngliche Access-DOUBLE.

Der ergänzte Typ `civil_datetime` speichert lokale Zivilwerte ohne Zeitzonenverschiebung. Reader-Dates werden anhand ihrer gelieferten Komponenten übernommen; ein Geburtstag wird bei der bestätigten CRM-Projektion daraus als Datum abgeleitet. Es gibt keine Konvertierung über die Windows-Zeitzone.

Zusätzlich zu den unveränderten typisierten Quellfeldern existieren lesende Fachprojektionen:

- Kunden: externe Nummer, Namen, Adresse, zusätzliche Telefon-/Fax-/E-Mail-Kontakte, Rechnungs-E-Mail und gestufte Skontobedingungen.
- Lieferadressen: Bezug ausschließlich über `KID`; `KUND_NR = 0` bleibt Quellinformation und wird nicht zur Kundenverknüpfung benutzt.
- Lieferanten: Quellcode, numerische Altkennung, Firma, eigene Kundennummer beim Lieferanten, Kontakte, Adresszeilen und Konditionsstufen.
- Artikel: Zusatzbezeichnungen, Kurzbeschreibung, Lieferumfang, Marke, Sortiment, Lieferant, Bestellnummer, Einheit und reine Medienreferenzen.
- Mitarbeitende/Standorte: historische Quellidentität und explizite GP-Zuordnung, keine aktive Personalanlage oder Einstellungsübernahme.

Konditionswerte bleiben Quellbedingungen mit `operationallyApplied: false`. Ungeklärte Rabatt-/Faktorketten werden nicht verrechnet. Bonusstände und Salden bleiben Snapshots, keine neu gebuchten Kontostände. `Internet` wird nicht zur Website; ein Newsletter-Kennzeichen ist keine bestätigte Einwilligung. Kontakte sind nicht automatisch verifiziert. Bild-/Dokumentpfade und URLs werden niemals geöffnet oder heruntergeladen.

Eine Projektion nennt ausgelassene Segmente ausdrücklich. Verborgene Finanz- oder Preisfelder dürfen nicht als bestätigte Nullwerte interpretiert werden.

## 4. Bestehende CRM-Kartei und manuelle Änderungen

`previewCustomer` verlangt eine konkrete Quellrevision. Bei der ersten Zuordnung müssen Kundenart und gegebenenfalls Firmenname bewusst entschieden werden. Keine Ableitung „gewerblich“ aus fehlendem Vornamen oder Großhandelskennzeichen. Kunden ohne gültigen Namen, mit ungültiger E-Mail/UID oder anderen Validierungsfehlern bleiben im Quellbestand. Nummer 0 wird nicht zu einem gemeinsamen CRM-Kunden.

Einzelne Korrekturen werden ausdrücklich angegeben, validiert und im verschlüsselten Abgleichprotokoll festgehalten; das Quelloriginal bleibt unverändert. Die externe Kundennummer kann auf diesem Weg nicht umnummeriert werden.

Existiert dieselbe Kundennummer schon im GP, ist eine Zielbestätigung mit GP-ID und aktueller Revision nötig. Die erste Verknüpfung verändert die vorhandene Karte nicht. Gleichnamige Personen oder gemeinsame E-Mail-Adressen werden nicht automatisch zusammengeführt. Die GP-ID ist unabhängig von der Kundennummer.

Bei einem Folgeabgleich werden letzter bestätigter Quellstand, neue Quelle und aktuelle GP-Felder verglichen:

- Unveränderte Quellfelder lassen manuelle GP-Korrekturen stehen.
- Eindeutige neue Quelländerungen werden nur auf dem unveränderten früheren Stand fortgeschrieben.
- Abweichende Änderungen an beiden Seiten sperren den Abgleich.
- Website, eigene GP-Textfelder und Fotometadaten werden nicht durch die Quelle ersetzt. Der Adapter aktualisiert nur CRM-Kernspalten; die Tabellen eigener Felder und Fotos werden nicht neu geschrieben.

`syncCustomer` benötigt den HMAC-geschützten Fingerprint der Vorschau und prüft unmittelbar erneut Quelle, Ziel, Revisionen und Berechtigungen. CRM-Schreibvorgang, Quellbindung, verschlüsseltes Vorher-/Nachherereignis und zentraler Audit-Eintrag liegen in derselben Provider-Transaktion.

## 5. Artikel, Personal und Standorte verbinden

`previewBinding` / `bind` sind separate, bestätigungspflichtige Aktionen. Die Bestätigung enthält Quellrevision, Begründung und die Entscheidung, ob es eine historische Zuordnung ist.

- Artikel: ausschließlich vorhandene `tradefoto.artikel_stamm`-Quellbindung und stabile Produkt-ID; keine EAN-/Nummernvermutung, keine zweite Anlage, keine Preisänderung.
- Mitarbeitende: Trade-`Verkäufer_ID` ist nicht automatisch eine GP-Personalnummer. Die heutige GP-Persistenz verwendet `employees.personnel_number` als Schlüssel; dieser wird ausdrücklich als Textziel ausgewählt. Rollen, Stunden, Urlaubsregeln und alte Zugangswerte werden nicht geschrieben.
- Standorte: bestehende GP-Standort-ID ausdrücklich wählen; keine Öffnungszeit-/Netzwerk-/Dienstplanänderung.
- Inaktive Ziele sind nur mit bewusst historischer Zuordnung zulässig. Quelle 0 bleibt bei Kunden und Verkäufern „nicht zugeordnet“. Fehlende historische Quellen bleiben `missing_source`, vorhandene unverbundene Quellen `unlinked`; es wird kein aktiver Platzhalter erfunden.

`resolve` liefert die geschützte Zuordnung für spätere Belegadapter. Es prüft den Bereich, das konkrete Zielrecht und den aktuellen Zielzustand erneut; spätere Deaktivierung oder ein fehlendes Ziel bleiben sichtbar. Ein anderer Quellnummernraum/Quellmandant kann dieselben Zeichenfolgen verwenden, ohne dieselbe Identität zu erhalten.

## 6. Schutz, Rechte und Rücknahme

Quellwerte sind in getrennten Segmenten AES-256-GCM-verschlüsselt. AAD bindet Bereich, Quellinstanz, Tabelle, Identitäts-HMAC, Profil, Datensatz, Revision, Segment und Datenklasse. Bindungen und Abgleichereignisse besitzen eigene Authentifizierungskontexte. Datenbankmetadaten, normaler Audit-Text und öffentliche Fehlermeldungen enthalten keine Klartext-Quellwerte.

Normale CRM-Projektionen enthalten keine Bank-/Mandatsdaten. Preisfelder übernehmen zusätzlich die vorhandene Trennung `catalog_prices` / `catalog_costs`; unklare Lieferanten-/Preiskonditionen bleiben vorsorglich in der strengeren Kostenklasse. Diese Klassen sind **keine automatisch vergebenen GP-Rollenrechte**. Die spätere Server-Komposition muss sie auf die bestehenden Lese-/Preis-/Kostenrechte und gegebenenfalls neu freizugebende Finanz-/Lieferantenrechte abbilden. Altrollen und geschützte Developer-Rechte werden nicht verändert.

Serviceaktionen `master.read`, `customer.sync`, `master.link`, `master.resolve` und `master.undo` erfordern jeweils aktuelle Berechtigung; personenbezogene Ziele zusätzlich ihren Zielbereich. Die Rücknahme eines Abgleichereignisses ist nur durch seinen eigenen Akteur möglich. Die Engine übergibt Fachschreibern jetzt einen unveränderlichen, verifizierten Laufkontext statt einer frei wählbaren Quellinstanz.

Rücknahmen prüfen letzte wirksame Bindung, GP-Revision und Nachherwerte. Bei manuellen Änderungen, späterem Abgleich, eigenen Feldern/Fotos eines neu erzeugten Kunden oder registrierten Folgeabhängigkeiten wird die Rücknahme gesperrt. Eine Folgeänderung kann auf einer **neuen** Revision rückgenommen und danach der vorherige Abgleich rückgenommen werden. Revisionen werden nicht zurückgedreht.

Die neue Tabelle `import_master_holds` ist die verbindliche Abhängigkeitsschnittstelle für Folgeblöcke. Ein Beleg-/Vorgangsadapter muss seinen Hold in derselben Transaktion wie die Verwendung anlegen. Eine verknüpfte Quelle oder eine Quelle mit referenzierenden Kindern lässt sich über die Import-Engine nicht einfach entfernen. Kundensynchronisation und Quellimport besitzen getrennte Rücknahmeprotokolle und werden in dieser Reihenfolge rückabgewickelt.

Produktive Schlüsselverwaltung, Aufbewahrung/Löschung der Quellsegmente und Ereignisse sowie ein Rechte- und Backupkonzept bleiben vor der tatsächlichen Aktivierung festzulegen. Es wurde kein Schlüssel provisioniert und keine automatische Löschung eingerichtet.

## 7. Code und Prüfungen

| Datei | Aufgabe |
| --- | --- |
| [tradefoto-master-profiles.js](../../lib/tradefoto-master-profiles.js) | 66 feste Profile, Reader-Grenze, Textidentitäten, typisierte Segmente und Beziehungen |
| [tradefoto-master-metadata.json](../../lib/tradefoto-master-metadata.json) | Datensparsame Schema-/Klassifikationsmetadaten, keine Geschäftszeilen |
| [build-tradefoto-master-metadata.mjs](../../scripts/build-tradefoto-master-metadata.mjs) | Reproduzierbare Ableitung und Prüfung gegen den vollständigen Block-1-Katalog |
| [tradefoto-master-views.js](../../lib/tradefoto-master-views.js) | Lesende Fachprojektionen ohne operative Nebenwirkungen |
| [import-master-data.js – Repository](../../lib/persistence/repositories/import-master-data.js) | Engine-Schreiber, CRM-Abgleich, explizite Bindungen, Zugriffsschutz und Rücknahme |
| [import-master-data.js – Statements](../../lib/persistence/statements/import-master-data.js) | 31 providerneutrale Persistenzverträge |
| [import-master-catalog.js](../../lib/persistence/sqlite/import-master-catalog.js) | Parametrisiertes SQL ohne quellgesteuerte Tabellen-/Spaltennamen |
| [import-master-schema.js](../../lib/persistence/sqlite/operations/import-master-schema.js) | Isolierte Quell-/Segment-/Beziehungs-/Bindungs-/Ereignis-/Hold-Tabellen |
| [tradefoto-master-data.test.js](../../test/tradefoto-master-data.test.js) | 30 neue synthetische Funktions-, Sicherheits- und Integrationstests |

```text
node scripts/build-tradefoto-master-metadata.mjs
node scripts/render-tradefoto-catalog.mjs docs/tradefoto-gesamtimport-v0.1/catalog.json --check
node --test --test-concurrency=1 test/data-import-foundation.test.js test/tradefoto-master-data.test.js
node --test --test-concurrency=1 test/v087-database-coupling-inventory.test.js
git diff --check
```

Die Prüfungen erzeugen ausschließlich synthetische Testdaten. Alle 66 Profile werden mindestens einmal vollständig geschrieben und gelesen. Negativtests erfassen Schemaabweichung, fehlende Namen, ungültige Kontaktdaten, Dezimalpräzision, falsche Zuordnung, Bereichs-/Zielrechte, widerrufene Berechtigungen, manuelle Änderungen, veraltete Vorschauen, Abhängigkeiten, Manipulation von Ciphertext/Metadaten und Transaktionsabbruch bei fehlgeschlagenem Audit.

Abschließender erweiterter Prüflauf: **135 Tests bestanden, 0 Fehler, 0 übersprungen**, etwa 22,4 Sekunden. Davon 30 neue Block-3-Tests und 34 vorhandene Block-2-Fundamenttests. Zusätzlich geprüft: CRM-Domäne/-Persistenz/-Rechte, bisherige Artikel-/ACCDB-Importe, Analyse-Import-/Persistenzfundament, Artikel-PostgreSQL-Vertrag, SQLite-Provider und Architekturgrenzen. Dies ist ausdrücklich keine App-Vollsuite.

PostgreSQL-Kompatibilität wurde auf DDL-/Vertrags-/Compiler-Ebene geprüft. Das neue Schema verwendet auch für historische Bindungen echte `BOOLEAN`-Deklaration; Dezimalwerte bleiben verlustfrei im geschützten Quellpayload. Es wurde **kein PostgreSQL-Server gestartet oder aktiviert**. Die bestehenden CRM-/Anwendungsschemata sind dadurch nicht automatisch vollständig PostgreSQL-fähig. Vollsuite, echte Importgröße und Wiederanlauf unter Produktivbedingungen bleiben Block 6.

## Übergabe an Block 4

Nächster ausdrücklich freizugebender Block: Verkäufe, Kassenbelege und Historie. Die Belegadapter müssen auf die stabilen Quellidentitäten und bestätigten Bindungen aufbauen, Kunden-/Verkäufer-0 gesondert behandeln, Kopf- und Positionsverkäufer erhalten und jeden Bezug mit einem Hold gegen unzulässige Rücknahme schützen.

Weiter offen: Q01 unabhängige Lesedeckung, Q02 Umsatz-/Storno-/Retouren-/Rabattsemantik, echte Q03-Kundenentscheidungen und Korrekturen, echte Q04-Zuordnungen, Q05 historische Fehlstämme, Q06 Schlüsselfreigabe, Q07 historische Datums-/Standortfälle, Q08 externe Medien, Q09 produktive Rechte/Schlüssel/Aufbewahrung, Q10 noch nicht operative Zusatzsemantik und Q12 verwaiste Beziehungen. Dieser Block stellt deren sichere Behandlung bereit, behauptet aber keine Klärung anhand synthetischer Tests.

Dieser historische Übergabestand wurde inzwischen durch die ausdrücklich freigegebenen [Blöcke 4](BLOCK-4-VERKAUFS-KASSENHISTORIE.md), [5](BLOCK-5-GP-ANSICHTEN.md) und [6](BLOCK-6-PRUEFUNG-UND-ABNAHME.md) fortgesetzt. Block 6 ergänzt die verlustfreie Behandlung von Access-Double-/Floatwerten und Quellmemos sowie einen begrenzten, isolierten Echtdaten-Testimport. Kein produktiver Import, Commit, Push oder Deploy; die fachliche Summenabnahme bleibt offen.
