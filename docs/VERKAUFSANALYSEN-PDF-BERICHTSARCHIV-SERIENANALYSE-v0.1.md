# Verkaufsanalysen – PDF-Berichtsarchiv und Serienanalyse v0.1

**Stand:** 10.08.2026<br>
**Arbeitsblock:** 10 – PDF-Berichtsarchiv und zeitraumübergreifende Analyse<br>
**Produktbereich:** Verkaufsverwaltung > Verkaufsanalysen<br>
**Status:** Entwicklungsstand im separaten Verkaufsverwaltungs-Worktree; nicht veröffentlicht oder ausgerollt

## 1. Ziel und Einordnung

Dieser Block macht mehrere bereits bestätigte und unveränderlich gespeicherte
TradeFoto-PDF-Statistiken gemeinsam auswertbar. GP erkennt und verwendet die im
PDF enthaltene Filiale, die tatsächlichen aktuellen und verglichenen Zeiträume,
Warengruppen sowie die bestätigten Kennzahlen. Ein Bericht über beispielsweise
17 Tage bleibt deshalb ein 17-Tage-Bericht und wird nicht künstlich zu einer
Woche oder einem Monat umgedeutet.

Das Berichtsarchiv und die gemeinsame Analyse sind fest in den vorhandenen
Desktop-Arbeitsbereich integriert. Sie sind kein optionales Modul und erhalten
keine eigene mobile Fachansicht.

## 2. Berichtsarchiv

Die vorhandene Berichtsliste wird als Desktop-Archiv mit folgenden Angaben
ausgegeben:

- auswählbarer Bericht;
- GP-Filiale;
- tatsächlicher aktueller Zeitraum und Anzahl der Kalendertage;
- Vergleichszeitraum;
- Anzahl der Warengruppen;
- Importdatum;
- sichtbarer Hinweis auf weitere Berichte mit überlappendem aktuellem Zeitraum.

Die Datumsfilter verwenden eine echte Intervallschnittmenge. Ein Bericht vom
1. bis 17. eines Monats wird daher auch gefunden, wenn nach dem 10. bis 20.
gefiltert wird. Die Archivkennzeichnung verändert oder löscht keinen Bericht.
Ein überlappender Bericht kann weiterhin einzeln geöffnet und analysiert werden.

## 3. Zulässige Serienauswahl

Eine gemeinsame Analyse umfasst mindestens einen und höchstens 24 Berichte. Sie
ist nur zulässig, wenn alle ausgewählten Berichte

- derselben GP-Filiale zugeordnet sind;
- aus demselben Quellsystem und derselben Berichtsart stammen;
- dieselbe Währung verwenden;
- im aktuellen Zeitraum nicht überlappen;
- auch in den jeweiligen Vergleichszeiträumen nicht überlappen.

Die Prüfung erfolgt zunächst verständlich im Desktop-Arbeitsbereich und nochmals
verbindlich auf dem Server. Eine Berührung aufeinanderfolgender Zeiträume ist
nur dann überschneidungsfrei, wenn der zweite Zeitraum am Folgetag beginnt. Der
17. eines Monats darf somit nicht zugleich Ende des ersten und Beginn des
zweiten Berichts sein.

Zeitliche Lücken sind zulässig, werden aber als Lückentage einschließlich ihrer
konkreten Intervalle ausgewiesen. GP behauptet bei einer lückenhaften Auswahl
keine vollständige Abdeckung der gesamten Zeitspanne.

## 4. Rechenvertrag

Nur additive, bestätigte Kennzahlen werden mit dezimalgenauer Ganzzahlarithmetik
summiert:

- Menge;
- Nettoumsatz;
- Kundenanzahl;
- Rohertrag ausschließlich bei wirksamem Rohertragsrecht.

Umsatz je Kunde ist nicht additiv. Er wird für die Serie aus dem summierten
Nettoumsatz und der summierten Kundenanzahl neu berechnet. Zusätzlich kann GP
Durchschnittswerte je tatsächlich abgedecktem Kalendertag anzeigen. Dafür wird
nur durch die Summe der Abdeckungstage geteilt; Lückentage werden weder mit null
aufgefüllt noch als erfundene Tageswerte behandelt.

Warengruppen werden über ihre externe Warengruppennummer zusammengeführt. Falls
dieselbe Nummer in den PDFs unterschiedlich bezeichnet ist, bleibt die aktuelle
Bezeichnung sichtbar und die Serie führt die vorkommenden
Bezeichnungsvarianten mit. Fehlende Warengruppen werden nicht künstlich mit
Einzelwerten ergänzt.

## 5. Analysesicht

Eine erfolgreiche Serienauswahl verwendet die vorhandenen GP-Analysen für

- gemeinsame Kennzahlen und Vergleichswerte;
- das Warengruppendiagramm;
- die breite, such- und sortierbare Warengruppentabelle;
- eine Abdeckungsdarstellung der ausgewählten PDF-Zeiträume;
- sichtbare Abdeckungs-, Spannweiten- und Lückenangaben.

Die Analyse speichert keine neue Faktentabelle und verändert die importierten
Berichte nicht. Das Ergebnis wird für die aktuelle Anfrage berechnet und mit
einem deterministischen Fingerabdruck der geordneten Berichtsauswahl versehen.

## 6. Rechte, Datenschutz und Audit

Die bestehenden Verkaufsanalyse-Rechte gelten unverändert:

- ohne `sales:analytics:access` sind Archiv und Analyse nicht erreichbar;
- jeder ausgewählte Bericht wird serverseitig gegen den wirksamen Filialbereich
  der Sitzung geprüft;
- Berichte unterschiedlicher Filialen dürfen nicht zu einer künstlichen
  Unternehmenssumme verbunden werden;
- ohne `sales:analytics:margin:read` werden Rohertragswerte bereits vor der
  Serienberechnung aus jedem Bericht entfernt;
- `it_admin`, `admin` und `hr` erhalten aus ihrer Rolle weiterhin keinen
  automatischen Verkaufsdatenzugriff;
- ausschließlich der besonders geschützte `developer` erhält entsprechend der
  allgemeinen GP-Superuserregel den vollständigen bekannten
  Anwendungsberechtigungskatalog und damit auch alle Verkaufsanalyse-Rechte;
- Antworten werden als private, nicht zu speichernde Daten ausgeliefert.

Erfolgreiche Analysen und abgewiesene Versuche werden auditiert. Der
Erfolgsnachweis enthält Filiale, Berichtszahl, Zeitraum, Abdeckungs- und
Lückenanzahl sowie den Auswahlfingerabdruck. Ablehnungen protokollieren
Fehlerklasse und Anzahl, aber keine Verkaufskennzahlen oder vollständigen
Berichtskennungen.

## 7. Bewusste Grenzen

Nicht Bestandteil dieses Blocks sind:

- direkte Verbindung oder Hintergrundsynchronisation mit einer
  TradeFoto-Access-Datenbank;
- automatisches Einlesen der bereitgestellten Access-Dumps in produktive
  Verkaufsdaten;
- Verbindung von Berichten verschiedener Filialen zu einer Unternehmenssumme;
- stilles Summieren überlappender aktueller oder verglichener Zeiträume;
- Erfindung täglicher Einzelumsätze aus aggregierten PDF-Werten;
- neue PDF-Berichtsarten außerhalb des vorhandenen Importvertrags;
- mobile Fachansicht oder mobile Abnahme;
- Commit, Push, Release oder VPS-Deployment.

Die bekannten Access-Dumps bleiben bis zu einem ausdrücklich freigegebenen
späteren Integrationsblock Datenkatalog- und Validierungsgrundlage. Der
PDF-Berichtsimport bleibt der derzeitige Weg für aufgearbeitete TradeFoto-Daten.

## 8. Prüfvertrag

Der Block wird mindestens durch folgende Prüfungen abgesichert:

- exakte Summen und Neuberechnung nicht additiver Kennzahlen;
- 17-Tage- und andere frei begrenzte Berichtsintervalle;
- lückenlose, lückenhafte, überlappende und aneinandergrenzende Zeiträume;
- unabhängige Überschneidungsprüfung für aktuelle und verglichene Zeiträume;
- Filial-, Quellen-, Berichtsart- und Währungsgrenzen;
- serverseitige Rohertragsprojektion vor der Aggregation;
- CSRF-, Sitzungs-, Filial- und Auditverdrahtung des Analyse-Endpunkts;
- JavaScript-Syntax, Persistenzkopplungs-Audit und vollständige GP-Regression.

### 8.1 Lokaler Prüfstand am 10.08.2026

- Block-10-Fach- und Verkaufssuite: 52 Tests, 52 bestanden,
  0 fehlgeschlagen;
- vollständige GP-Regressionssuite: 1.779 Tests, 1.739 bestanden,
  40 bewusst übersprungen, 0 fehlgeschlagen;
- Persistenzkopplungs-Audit: `OK`, SQLite-/PostgreSQL-Katalogvertrag
  `979/979/979`, Sales-Analytics-Slice `29/29`, DDL `24/24`, keine
  unklassifizierten Dateien und keine Phasengrenzverletzung;
- JavaScript-Syntaxprüfung für Server, Browser-App und Serienaggregator:
  fehlerfrei;
- reale Desktop-Browserprüfung mit zwei synthetischen Berichten über 17 und
  14 Tage: 31 lückenlose Abdeckungstage, korrekte Neuberechnung nicht additiver
  Kennzahlen, gesperrter Einzelberichtshorizont während der Serienansicht und
  keine Browserwarnung oder JavaScript-Fehler;
- keine mobile Abnahme, weil für diesen Fachbereich ausdrücklich keine mobile
  Darstellung vorgesehen ist;
- kein Commit, Push, Release oder VPS-Deployment.
