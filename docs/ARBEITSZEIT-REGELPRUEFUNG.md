# Arbeitszeit-Regelprüfung

Stand: v0.81 Beta

Die Arbeitszeit-Regelprüfung unterstützt die **Dienstplanung** mit versionierten, nachvollziehbaren Hinweisen. Sie bewertet ausschließlich geplante Dienste (`planned_schedule`). Tatsächliche Buchungen der Zeiterfassung werden weder eingelesen noch als Planzeit ausgegeben.

## Sicherer Start

- Das eingebaute Handelsprofil startet installationsweit im **Monitorbetrieb**.
- Alter, Branchenzugehörigkeit und betriebliche Anwendbarkeit gelten zunächst als nicht bestätigt.
- Nicht bestätigte Sachverhalte bleiben `manuell zu prüfen`; sie werden niemals stillschweigend als bestanden gewertet.
- Ein Kollektivvertragsprofil Handel 2026 ist nur als nicht zuweisbarer Entwurf hinterlegt.
- Erst eine berechtigte Stelle kann ein veröffentlichtes Profil mit Gültigkeitszeitraum und Geltungsbereich zuweisen.

## Technisches Bewertungsmodell

Jeder Befund enthält:

- Regel-ID und versionierte Profilfassung
- Ergebnis `pass`, `fail` oder `unknown`
- Schweregrad und vorgesehene Durchsetzung
- betroffene Person und Zeitraum
- verwendete Planwerte
- amtliche Quellen
- deterministischen SHA-256-Fingerprint

Der Monitorbetrieb setzt die wirksame Durchsetzung auf einen Hinweis zurück. Im aktiven Regelbetrieb können absolute, bestätigte Grenzen das Speichern einer Planänderung verhindern. Nur Regeln, die ausdrücklich eine dokumentierte Ausnahme vorsehen, können mit Grund, Nachweis und Gültigkeitszeitraum übersteuert werden.

Bewertungen nach Planänderungen werden gemeinsam mit der Planmutation atomar als vollständig hashgebundene Prüfreceipts gespeichert. Das gilt auch für Dienständerungen durch genehmigten oder stornierten Zeitausgleich. Profilzuordnungen werden für den jeweils betroffenen Diensttag und die damals zugewiesene Profilversion aufgelöst. Kann eine Wochen-, Durchschnitts- oder Ruhezeitprüfung über eine Profilgrenze nicht sicher kombiniert werden, entsteht ausdrücklich `manuell zu prüfen` statt eines scheinbaren `pass`. Veröffentlichte Profilfassungen und Prüfreceipts sind in SQLite gegen nachträgliche Änderung oder Löschung geschützt.

## Eingebaute Prüfpunkte

Das Erwachsenenprofil berücksichtigt derzeit:

- tägliche und wöchentliche Normalarbeitszeit
- Hinweise bei mehr als zehn Stunden täglich beziehungsweise fünfzig Stunden wöchentlich
- tägliche und wöchentliche Höchstarbeitszeit
- durchschnittliche Wochenarbeitszeit über 17 Wochen
- Ruhepause bei mehr als sechs Stunden
- tägliche Ruhezeit
- wöchentliche Ruhezeit
- Sonn- und Feiertagsarbeit

Das Handels-Monitorprofil ergänzt:

- profilierte Verteilung bis neun Stunden täglich und 44 Stunden in einzelnen Wochen bei vierwöchigem Durchschnitt
- Prüfhinweis bei Verkaufstätigkeit am Samstag nach 18:00 Uhr

Fehlen für eine rollierende Bewertung vollständige Wochen oder eine prüfbare Pausenangabe, lautet das Ergebnis `unknown` und nicht `pass`.

## Amtliche Quellen des Katalogs

- [AZG § 3 – Normalarbeitszeit](https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008238&Paragraf=3)
- [AZG § 4 – andere Verteilung der Normalarbeitszeit](https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008238&Paragraf=4)
- [AZG § 7 – Überstunden und Ablehnungsrecht](https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008238&Paragraf=7)
- [AZG § 9 – Höchstgrenzen](https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008238&Paragraf=9)
- [AZG § 11 – Ruhepausen](https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008238&Paragraf=11)
- [AZG § 12 – tägliche Ruhezeit](https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008238&Paragraf=12)
- [ARG – Arbeitsruhegesetz](https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008541)
- [Öffnungszeitengesetz 2003](https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=20002816)

Der WKO-Kollektivvertrag Handel 2026 ist als ergänzende Quelle dokumentiert, aber ohne fachlich bestätigte Anwendbarkeit nicht zuweisbar.

## Grenzen

Die Prüfung ist eine technische Planungshilfe. Sie ist keine Rechtsberatung und bestätigt keine vollständige Rechts- oder Kollektivvertragskonformität. Insbesondere individuelle Verträge, Betriebsvereinbarungen, Jugendliche, leitende Angestellte, Sonderausnahmen und nicht modellierte kollektivvertragliche Regelungen benötigen eine eigene fachliche Prüfung und gegebenenfalls ein zusätzliches versioniertes Profil.
