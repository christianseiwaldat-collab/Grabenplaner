# Integration der vorbereiteten Funktionen

Der Benutzer hat am 14.09.2026 die sechs Integrationsblöcke nacheinander und
anschließend den Deploy bei bestandener Abnahme freigegeben. Die frühere
Veröffentlichungspause im Bestandsaudit ist damit aufgehoben.

1. Filialkonto: Artikelkarten, Durchschnitts-EK-Rechner, Bestände, Bilder und Links.
2. Filialkonto: Quellenfilialen, Belegverkäufer und Kundensuche.
3. Filialkonto: gesondert freischaltbare ZA-Anträge mit Planvorschau.
4. Einkauf und historische Filialversorgung aus dem bestehenden Bestellimport.
5. Filialpreise, Klassifikation, Langsamdreher und Reichweite.
6. Kunden-/Gerätehistorien und Reparaturen einschließlich eigener GP-Status.

Die vorhandenen Planungsoptimierungen werden gemeinsam veröffentlicht. Der
aktuelle Hintergrundimport und die PostgreSQL-Belegprozesse bleiben erhalten.
Es werden keine alten Speicher-/Importprototypen über den aktuellen Stand gelegt.

## Arbeitsnachweise

- Block 1 lokal integriert. 34 gezielte Tests bestanden, ohne Überspringen:
  Rechner, Artikelclient, echter Filialportal-HTTP-Zugang, Quellbestände,
  Bildzugriff und Rechteentzug. Protokoll: `tmp/integration-block1-tests.log`.
- Native PostgreSQL-, Browser- und gemeinsame Releaseabnahme folgen nach
  Abschluss der Integrationen. Ein lokales Testergebnis ist kein Deploynachweis.

## Fachliche Grenzen

WEID/WEID_Wien liegen weiterhin nicht vor; kumulierte Liefermengen werden nicht
als Wareneingangsjournal oder tatsächliches Lageralter dargestellt. Unbestätigte
Gruppen bleiben ungeklärt. Historischer Rohertrag stammt unverändert aus Kassa;
der Artikelrechner verwendet ausschließlich den bestätigten Durchschnitts-EK.

- Block 2 lokal integriert: 48 gezielte Tests bestanden. Filialfilter, exakte
  Belegverkäufer, Kundenfeld und die bisherigen PostgreSQL-Belegprozesse.
- Block 3 lokal integriert: ZA-Opt-in, Filialmitarbeiter, Vorschau und bestehende
  Genehmigung. Ein veralteter Navigationstest wurde durch Wiederherstellung der
  bisherigen Setter-Reihenfolge behoben; 23 betroffene Navigation-/Planungstests
  bestanden. Gemeinsamer Lauf steht noch aus.
- Block 4: geschützte, fortsetzbare Einkaufs- und Versorgungsansichten integriert;
  zwei echte SQLite-Import-/Berechtigungs- und SQL-Übersetzungstests bestanden.
- Blöcke 5 und 6 integriert. Eigene Klassifikationen und Reparaturstatus liegen
  verschlüsselt in einer additiven Core-Tabelle. Die native Migration wurde mit
  absichtlicher Unterbrechung, vollständiger Rücknahme dieser Transaktion,
  anschließendem Erfolg und unverändertem zweiten Aufruf qualifiziert. Der
  Anwendungszugang darf das Migrationsprotokoll nicht verändern.
- Gemeinsame Auswahl: **147 Tests bestanden**, keine Fehler und keine Skips.
  Persistenzaudit: keine unklassifizierte Datei, keine Grenzverletzung;
  Statementvertrag 1369. Native Fachprüfung auf PostgreSQL bestanden: 65
  Einkaufspositionen über zwei Seiten, 230 Kassenpositionen mit Fortsetzung,
  eigene Klassifikation, Erhalt des Reparaturstatus trotz späterer Quellauslassung,
  Revisionskonflikte und unmittelbarer Rechteentzug im bestehenden Leserpool.
- Native Historienreferenzen verhindern die Rücknahme verwendeter Stammdaten;
  eine erfundene Referenz kann keine Ersatzsperre erzeugen. Der tatsächliche
  Bestellimport verwendet nur einen Schreiber in Sales und keine zweite
  Core-Schreibtransaktion.
- Browserprüfung an synthetischen Daten: persönliche Anmeldung, eigene
  Klassifikation und Reparaturstatus gespeichert; Zurück zwischen den Registern
  führt korrekt zur vorherigen GP-Ansicht. Filialkonto: Artikel gefunden, Detail
  geöffnet, Bild/Links/Bestand sichtbar, Preis- und Ziel-RE-Rechner geprüft.
  Bei 100 Euro Bruttopreis wird negativer RE rot angezeigt; Ziel-RE 3 Prozent
  ergibt im Test 152,74 Euro brutto, mit positivem RE in Grün.
- Filialkonto-Belegsuche lieferte die synthetischen Belege einschließlich
  Kunden-/Belegverkäuferdaten und PDF-Aktionen. Quellenfilialen und Internetgruppe
  sind sichtbar auswählbar. Der vollständige synthetische ganztägige ZA-Antrag
  wurde mit markierter Dienstplanvorschau zur bestehenden Genehmigung eingereicht.
  Die schmale Artikelkarte hat keinen horizontalen Überlauf; Felder und Ergebnisse
  bleiben vollständig über die Seite erreichbar. Native Android- oder
  Drive-Dateiauswahl wurde in dieser Prüfung nicht bedient.

## Reihenfolge beim PostgreSQL-Release

Zuerst wird das normale Codepaket durch den vorhandenen transaktionalen Updater
veröffentlicht. Der neue Code akzeptiert das bestehende Schema ebenso wie das
optionale neue Migrationsprotokoll. Erst nach erfolgreichem Commit des Updaters
führt der installierte, manifestgeprüfte Root-Helfer unter derselben Wartungssperre
die kurze additive Core-Migration aus. Der frisch geprüfte Sicherungsstand darf
höchstens eine Stunde alt sein; Identität beider Datenbanken und das unveränderte
Sales-Schema werden vor und nach dem Schritt geprüft.

Bis zum Code-Commit bleibt die bisherige automatische Rücknahme möglich. Nach
erfolgreicher Schemaerweiterung darf alter, schemaunverträglicher Code nicht
ungeprüft zurückgespielt werden. Ein Fehler innerhalb der DDL-Transaktion wird
vollständig zurückgenommen; der bereits veröffentlichte neue Code kann mit dem
alten Schema weiterlaufen. Tabelleninhalte des bisherigen GP werden durch die
additive Migration nicht umgeschrieben. Nächtliche Wiederherstellungsprüfungen
verwenden anschließend den neuen Programm- und Schemastand.

Der tatsächliche Installationsnachweis steht separat in
`docs/DEPLOY-RELEASE-v09246.md`. Die obigen Qualifikationen erfolgten vor dem
produktiven Wechsel und sind für sich kein Deploynachweis.
