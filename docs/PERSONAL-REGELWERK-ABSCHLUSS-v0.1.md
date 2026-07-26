# Personal-Regelwerk – Abschluss der Blöcke 1 bis 7 v0.1

| Merkmal | Stand |
|---|---|
| Roadmap | Block 7 von 7 |
| Datum | 26. Juli 2026 |
| Gegenstand | fachliches Regelmodell, Kollektivvertragsregister, Regelbaukasten, Governance und bereichsbezogene Lesesicht |
| Produktstatus | Abschlussstand zur gemeinsamen lokalen und CI-gestützten Prüfung |
| Betriebsübernahme | getrennt über Sicherungs-, Migrations- und Gesundheitsprüfungen nachzuweisen |
| Rechtswirkung | technische Planungs- und Governance-Unterstützung, keine Rechtsberatung oder pauschale Rechtsfreigabe |

## Ziel des Abschlussblocks

Block 7 schließt die zusammenhängende Ausbaustufe des Personal-Regelwerks ab. Im Mittelpunkt steht die verständliche Nutzung durch Filial- und Abteilungsleitungen, ohne die in Block 6 eingeführte Trennung von Lesen, fachlicher Prüfung, Veröffentlichung und Wirksamkeit aufzuweichen.

Das Dashboard bietet deshalb:

- eine auf den aktuell angemeldeten Zugang begrenzte Lesesicht,
- nachvollziehbare Regelprofile, Fassungen, Quellen und Geltungszuordnungen,
- eine reine Planvorschau innerhalb der sichtbaren Filialen und Abteilungen,
- eine eindeutige Unterscheidung zwischen aktuell wirksamen, künftigen und inaktiven oder abgelaufenen Zuordnungen,
- qualifizierte Hinweise zur fachlichen und rechtlichen Grenze des Prüfergebnisses.

Das Dashboard enthält keine Schreib-, Veröffentlichungs-, Freigabe- oder Zuordnungsfunktion.

## Abschlussbild der sieben Blöcke

| Block | Ergebnis |
|---|---|
| 1 | Jugendprofil für Beschäftigte unter 18 und altersbezogene Anwendbarkeit |
| 2 | praxistaugliche Planhinweise und Jugendregel-Konzept |
| 3 | versioniertes Personal-Regelwerk-Dashboard mit Quellen und Planvorschau |
| 4 | Kollektivvertragsregister, Betriebsteile und vorbereitete Zuordnungen |
| 5 | Baukasten für eigene, versionierte Personalregel-Entwürfe |
| 6 | unabhängiger Freigabeweg, Veröffentlichung, additive Wirksamkeit und append-only Audit |
| 7 | bereichsbezogene FL-/AL-Lesesicht, klare Zustände, Bedienungs- und Dokumentationsabschluss |

## Rollen- und Rechteabgrenzung

Die Dashboard-Sicht benötigt ausschließlich `work_rules:read`. Filial- und Abteilungsleitungen erhalten dadurch keine impliziten Governance-Rechte.

Insbesondere entstehen durch das Dashboard nicht:

- `work_rules:draft`,
- `work_rules:review`,
- `work_rules:publish`,
- `work_rules:assign`,
- `collective_agreements:approve`.

Eine Planvorschau verwendet den Lesekontext des aktuell angemeldeten Zugangs. Die angebotenen Filialen und Abteilungen kommen aus diesem serverseitig begrenzten Kontext. Andere Unternehmensbereiche werden in einer bereichsgebundenen Sitzung nicht als auswählbare Vorschauziele dargestellt.

Personen mit weitergehenden Fachrechten arbeiten für Änderungen und Freigaben in den getrennten Bereichen der Personalverwaltung. Auch für sie bleibt das Dashboard selbst eine Lesesicht.

## Darstellung der Geltungszuordnungen

Zuordnungen werden anhand ihres technischen Stands am angezeigten Stichtag erklärt:

| Anzeige | Bedeutung |
|---|---|
| Aktuell wirksam | aktive Zuordnung; Beginn erreicht und Ende noch nicht überschritten |
| Künftig | zeitlich noch nicht wirksame Zuordnung mit einem noch nicht erreichten Beginn; der Freigabestand wird davon getrennt beurteilt |
| Inaktiv | technisch nicht aktive Zuordnung; derzeit keine Planwirkung |
| Abgelaufen | das dokumentierte Ende liegt vor dem Stichtag; derzeit keine Planwirkung |

Die Farbe unterstützt diese Einordnung, ist aber nicht der einzige Informationsträger. Jeder Eintrag enthält zusätzlich einen ausgeschriebenen Status und einen zugänglichen Namen. Die Bestätigung der Anwendbarkeit wird getrennt vom zeitlichen Status angezeigt.

Eine automatische Jugendprofil-Auswahl ist als Systemregel gekennzeichnet. Sie wird bei bestätigtem Geburtsdatum für den jeweiligen Diensttag ermittelt und ist keine frei gewählte manuelle Zuordnung.

## Planvorschau

Die Planvorschau prüft bereits gespeicherte Dienste für:

- eine sichtbare Kalenderwoche,
- eine sichtbare Filiale,
- optional eine sichtbare Abteilung.

Sie ändert keine Dienste, Regelprofile, Quellen, Geltungszuordnungen, Entscheidungen oder Freigaben. Das Ergebnis unterscheidet technische Bestätigungen, Hinweise, manuell zu prüfende Punkte und Blockierungen. Es ist kein Genehmigungs- oder Veröffentlichungsweg.

## Rechts- und Fachgrenze

Der im System gespeicherte Regelstand unterstützt die Dienstplanung, ersetzt aber keine Rechtsberatung, KV-Einstufung oder fachliche Einzelfallprüfung.

Maßgeblich bleiben insbesondere:

- die am konkreten Dienstzeitpunkt geltende Rechtslage,
- der tatsächlich anwendbare Kollektivvertrag und seine richtige Zuordnung,
- Arbeitsvertrag und zulässige betriebliche Regelungen,
- fachlich bestätigte Ausnahmen und deren Voraussetzungen,
- noch nicht maschinenlesbare Sachverhalte.

Auch ein unauffälliges oder grünes Prüfergebnis ist keine Rechtsfreigabe und keine pauschale Bestätigung vollständiger Rechtskonformität.

## Bedienungs- und Darstellungsprüfung

Die Block-7-Oberfläche ist für folgende Prüfpunkte ausgelegt:

- Hell- und Dunkeldarstellung verwenden dieselben semantischen Dashboard-Variablen,
- das Layout reduziert sich von sechs Zusammenfassungskarten über drei und zwei Spalten bis zur einspaltigen mobilen Zustandslegende,
- Profilwahl, Filter, Aktualisierung und Planvorschau sind vollständig per Tastatur erreichbar,
- dynamische Scope- und Vorschauinformationen werden als Status beziehungsweise Live-Region ausgezeichnet,
- rein dekorative Zustandsmarken sind für Screenreader ausgeblendet,
- Profil- und Zuordnungseinträge besitzen ausgeschriebene zugängliche Namen,
- sichtbarer Text benennt die fehlende Änderungs- und Freigabefunktion ausdrücklich.

Die statische Regression hierzu liegt in `test/block7-personnel-rules-ui.test.js`.

## Abnahmegrenze

Mit Block 7 ist die geplante Ausbaustufe im Quellstand vollständig abgebildet. Eine Betriebsübernahme auf einen VPS ist nicht Bestandteil dieser fachlichen Block-Abnahme, sondern ein eigener kontrollierter Rollout mit:

1. Sicherung und Wiederherstellbarkeitsprüfung,
2. kontrollierter Migration,
3. Dienststart und Gesundheitsprüfung,
4. Rollen-Smoke-Tests für HR, FL und AL,
5. dokumentierter Rückfallentscheidung.

Diese Abschlussdokumentation selbst erteilt keine Produktionsfreigabe.
