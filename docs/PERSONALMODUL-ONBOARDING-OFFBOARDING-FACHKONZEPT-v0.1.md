# Personalmodul – Fach- und Organisationskonzept Onboarding/Offboarding v0.1

Stand: 2. August 2026

Status: fachlich-organisatorischer Konzeptentwurf zur Abstimmung; keine technische Umsetzung, keine Produktivfreigabe und keine Freigabe für Automatisierungen

Produktgrenze: Das Installationsmerkmal `personnelLifecycle` bleibt standardmäßig deaktiviert. Die bestehenden technischen Sperren für Onboarding, Offboarding und vertrauliche Personalprozesse bleiben bestehen, bis der jeweilige Rechte-, Daten- und Schutzvertrag in einem eigenen technischen Block umgesetzt und abgenommen wurde.

## 1. Ziel und Geltungsbereich

Dieses Konzept legt fest, wie Eintritt und Austritt von Mitarbeitenden fachlich organisiert werden sollen. Es beschreibt Zuständigkeiten, Prozesspakete, Sichtbarkeiten, Referenztermine, Sonderfälle und Freigaben. Es trifft noch keine Detailentscheidung über Tabellen, API-Felder, Benachrichtigungskanäle oder einen grafischen Editor.

Onboarding und Offboarding werden in die bestehende Personalverwaltung, das vorhandene Mitarbeiterprofil und die bestehende Workflow-Basis integriert. Es entsteht weder ein zweiter Mitarbeiterstamm noch eine zweite Aufgaben- oder Workflow-Engine.

Der Geltungsbereich beginnt:

- beim Onboarding erst nach der kontrollierten Anlage eines Mitarbeiters; Bewerber und Preboarding bleiben getrennt,
- beim Offboarding mit der vertraulichen Erfassung eines geplanten Austritts für eine bestehende Beschäftigung,
- jeweils bei der ausdrücklichen fachlichen Freigabe durch eine berechtigte Personalstelle.

Nicht Gegenstand dieses Konzepts sind arbeitsrechtliche Einzelfallentscheidungen, kollektivvertragliche Bewertung, automatische Behördenmeldungen, automatische Kontoänderungen, elektronische Signaturen mit Rechtswirkungsbehauptung oder die Auswahl konkreter externer Anbieter. Rechtliche Fristen und Aufbewahrungsvorgaben müssen je Unternehmen und Einsatzland gesondert geprüft werden.

## 2. Fachliche Grundbegriffe

### 2.1 Preboarding und Onboarding

Preboarding bleibt Teil der Bewerberdomäne. Der Bewerber besitzt keine Personalnummer und erhält durch Preboarding keinen Mitarbeiter- oder Portalzugang.

Onboarding bezieht sich ausschließlich auf einen angelegten Mitarbeiter und eine konkrete Beschäftigungsepisode. Es darf nicht stillschweigend durch die Bewerberumwandlung gestartet werden. Die Umwandlung kann später einen vorbereiteten Startvorschlag erzeugen; der tatsächliche Start bleibt eine eigene, geprüfte Fachaktion.

### 2.2 Beschäftigungsepisode

Eine Beschäftigungsepisode ist fachlich der Zeitraum von einem vereinbarten Eintritt bis zu einem Austritt. Sie ist vom technischen Mitarbeiterkonto zu unterscheiden. Eine spätere Wiedereinstellung erzeugt ein neues Onboarding und eine neue Beschäftigungsepisode; abgeschlossene historische Prozesse werden nicht wieder geöffnet.

Ob die Beschäftigungsepisode später als eigene Entität oder als geschützter Sidecar umgesetzt wird, ist eine technische Folgeentscheidung. Verbindlich ist, dass Wiedereinstellung, Austrittsrücknahme und interne Versetzung nicht durch Überschreiben historischer Prozesse abgebildet werden.

### 2.3 Onboarding- und Offboarding-Fall

Ein Onboarding- oder Offboarding-Fall ist die gemeinsame fachliche Ansicht mehrerer getrennt versionierter Workflow-Instanzen für denselben Mitarbeiter und dieselbe Beschäftigungsepisode.

Beispiel für ein Onboarding:

- unternehmensweites Pflichtpaket,
- Personal- und Administrationspaket,
- Standortpaket,
- Abteilungspaket,
- Rollen- oder Schulungspaket.

Die Pakete bleiben eigenständige Instanzen. Der Fall bündelt Bezug, Referenztermine, Sichtbarkeit und Fortschritt, dupliziert aber keine Aufgabenstatus. Eine Änderung an einer Vorlage verändert weder laufende Pakete noch den historischen Fall.

### 2.4 PL und PL+

`PL` bezeichnet die Personalleitung. `PL+` ist in diesem Fachkonzept keine zusätzliche Rolle und keine zweite Person, sondern der Sammelbegriff „Personalleitung und darüber“. Er umfasst PL, Admin, IT-Admin und Developer; die PL selbst gehört damit bereits zu PL+.

PL+ beschreibt die organisatorische Berechtigungsebene für zentrale Personal-Funktionen. Konkreter Datenzugriff und konkrete Aktionen bleiben dennoch an kleine Fachrechte gebunden. Dadurch kann die einzige PL eines KMU alle ihr zugewiesenen PL-Funktionen allein ausführen, während eine technische Rolle nicht allein durch ihren Namen unbemerkt jede vertrauliche Information als Nebenprodukt erhält. Admin, IT-Admin und Developer können dieselben zentralen Fachaktionen ausführen, wenn das jeweilige PL+-Fachrecht in ihrem Rollenprofil wirksam ist.

Die Freigabe lokaler Rechte an FL oder AL ist eine eigene Aktion und bleibt von der Nutzung einer Fachfunktion getrennt. „PL+“ bedeutet deshalb nicht automatisch „darf Rechte weiterdelegieren“.

## 3. Verbindliche Organisationsprinzipien

1. Bewerber, Mitarbeiter und Beschäftigungsepisode bleiben fachlich unterscheidbar.
2. Onboarding und Offboarding starten nur durch eine ausdrückliche, auditierte Fachaktion. Im ersten technischen Ausbauschritt gibt es keinen automatischen Start.
3. Jede Prozessinstanz ist an genau eine veröffentlichte, unveränderliche Workflow-Version gebunden.
4. Unternehmensweite Pflichtprozesse werden immer additiv berücksichtigt. Standort-, Abteilungs- und Rollenpakete dürfen ergänzen, aber nichts überschreiben oder entfernen.
5. Ein Konflikt zwischen passenden Paketen wird vor dem Start sichtbar gemacht und blockiert den Start, bis eine zentral berechtigte Stelle ihn geklärt hat.
6. Jede fachliche Aufgabe besitzt vor dem Start genau eine verantwortliche Person. Eine Rolle allein genügt nicht als laufende Zuweisung.
7. Zuständigkeiten, Sichtbarkeit und Datenzugriff werden serverseitig geprüft. Eine sichtbare Oberfläche oder eine Aufgabenbenachrichtigung begründet kein Recht.
8. PL+ umfasst PL, Admin, IT-Admin und Developer. Die PL ist selbst Teil dieser Ebene und benötigt weder eine zweite Person noch eine höhere Rolle, um ihre zentralen Fachaufgaben auszuführen.
9. Die vertrauliche Offboarding-Freigabe benötigt ein eigenes geschütztes Aktionsrecht. Dieselbe persönlich berechtigte PL+-Person darf einen Fall vorbereiten und freigeben; eine zweite Person ist dafür nicht erforderlich. Ein allgemeines technisches Rollenrecht oder ein Delegationsrecht ersetzt das Offboarding-Aktionsrecht nicht.
10. FL und AL handeln nur im wirksamen, von einem PL+-Konto mit eigenem Delegationsrecht freigegebenen Standort- beziehungsweise Abteilungsbereich. AL erhält keine standortweite Wirkung.
11. Vertrauliche PL- und Offboarding-Inhalte werden technisch getrennt und nicht nur optisch verborgen.
12. Dokumente und Nachweise verwenden die bestehende geschützte Personalakte samt Versionierung und Historie; Workflow-Aufgaben erzeugen keine ungeschützten Dokumentkopien.
13. Prozessstände, Freigaben, Umbesetzungen, Abbrüche und Ausnahmen bleiben nachvollziehbar. Verwendete Prozesse und historische Fälle werden archiviert, nicht physisch gelöscht.
14. Externe Nachrichten, Kontosperren, Behördenmeldungen und andere Außenwirkungen bleiben ohne eigenen Integrations- und Freigabevertrag gesperrt.
15. Fehlende Rechte, Referenztermine, Verantwortliche, Pflichtpakete oder eindeutige Organisationsbereiche führen zu keinem Start.

## 4. Referenztermine

Relative Fristen dürfen sich nicht auf ein mehrdeutiges Feld „Eintritt“ oder „Austritt“ beziehen. Das Fachmodell unterscheidet mindestens:

| Referenz | Bedeutung | Sichtbarkeit |
|---|---|---|
| vertraglicher Eintritt | Beginn des Dienstverhältnisses | PL; operativ nur soweit für eine Aufgabe erforderlich |
| erster Arbeitstag | erster geplanter tatsächlicher Arbeitstag | PL und zuständige operative Beteiligte |
| Onboarding-Zieldatum | vereinbartes Ende der Einstiegsphase | PL und zuständige Führung |
| Austritt erfasst | vertraulicher Erfassungszeitpunkt | ausschließlich berechtigte PL-Stellen |
| Kommunikationsfreigabe | Zeitpunkt, ab dem vorbereitete Informationen den freigegebenen Kreis erreichen dürfen | berechtigte PL-Stellen; operativ nur als Freigabestatus |
| Mitarbeiter informiert | dokumentierter Zeitpunkt der persönlichen Information | PL und ausdrücklich beteiligte Führung |
| letzter Arbeitstag | letzter geplanter tatsächlicher Arbeitstag | nach Kommunikationsfreigabe an zuständige Beteiligte |
| rechtliches Austrittsdatum | Ende des Dienstverhältnisses | PL; operativ nur soweit erforderlich |
| Zugriffssperrzeitpunkt | fachlich freigegebener Zeitpunkt für Zugangsmaßnahmen | nur ausführende, berechtigte Stelle und PL |

Eine Terminänderung ist keine stille Korrektur. Sie erzeugt ein nachvollziehbares Änderungsereignis mit Grund und Akteur. Erledigte Aufgaben bleiben unverändert. Noch offene relative Fristen dürfen später nur über eine ausdrücklich bestätigte Neuberechnung angepasst werden.

Kalender-, Wochenend- und Feiertagsregeln sowie verbindliche Fristwerte sind kundenspezifische Konfiguration und vor einer Automatisierung gesondert festzulegen.

## 5. Onboarding

### 5.1 Prozessbereiche

Ein Onboarding besteht fachlich aus vier parallelen Bereichen:

#### Personal und Administration

Typische Verantwortung: PL.

- Stammdaten und Organisationszuordnung geprüft,
- Vertrag und erforderliche Bestätigungen vorhanden,
- Personalnummer und Arbeitszeitmodell eingetragen,
- Personal- und Abrechnungsaufgaben veranlasst,
- erforderliche Dokumente vollständig,
- Probezeit- und Folgetermine erfasst.

#### Arbeitsplatz, Systeme und Arbeitsmittel

Typische Verantwortung: PL koordiniert; ausführende Fachstelle, FL oder benannte verantwortliche Person erledigt die Einzelaufgabe.

- Arbeitsplatz vorbereitet,
- notwendige Arbeitsmittel bereitgestellt,
- Zugangsanforderungen fachlich freigegeben,
- Schlüssel und Zutrittsmittel vorbereitet,
- Übergabe und Rückgabeverantwortung dokumentiert.

Ein technischer Administrator erhält dadurch keinen Zugriff auf das Mitarbeiterprofil. Eine spätere Integration darf nur die für den konkreten Auftrag erforderlichen Daten ausgeben.

#### Standort, Abteilung und Organisation

Typische Verantwortung: FL beziehungsweise AL im freigegebenen Bereich.

- Begrüßung und Rundgang,
- Team und Ansprechpartner,
- lokale Abläufe und Kommunikationswege,
- Pausen-, Sicherheits- und Notfallinformationen,
- konkrete Zuständigkeiten und erste Einsatzplanung.

#### Einschulung und Schulungen

Typische Verantwortung: benannte Führungskraft, Trainer oder Prüfer.

- allgemeine Basisschulung,
- standort-, abteilungs- und rollenspezifische Module,
- Datenschutz- und Sicherheitsunterweisungen,
- Abschluss, Freigabe und erforderlicher Nachweis,
- Ablauf- oder Wiederholungstermin, falls fachlich vorgesehen.

Eine Schulungsaufgabe kann Teil des Onboardings sein und zugleich in den dauerhaften Schulungsverlauf des Mitarbeiters projiziert werden. Der Abschluss wird nicht doppelt gespeichert.

### 5.2 Paket- und Geltungsmatrix

| Paketfamilie | Fachlicher Eigentümer | Zulässige Grundform | Typischer Geltungsbereich |
|---|---|---|---|
| Personal und Administration | zentrale PL | unternehmensweites Pflichtpaket | Unternehmen |
| Basissicherheit und Datenschutz | zentrale PL/Fachverantwortung | unternehmensweites Pflichtpaket | Unternehmen |
| Arbeitsplatz, Systeme und Arbeitsmittel | zentrale PL mit ausführender Fachstelle | zentraler Pflichtkern plus lokale Ergänzung | Unternehmen oder Standort |
| Standort und Organisation | FL unter zentraler Governance | lokale Ergänzung | Standort |
| Abteilung und fachliche Einschulung | AL/Fachverantwortung unter zentraler Governance | lokale Ergänzung | Abteilung |
| Rolle oder Position | zentrale PL/Fachverantwortung | Auswahlregel für passende veröffentlichte Ergänzungen | noch kein eigener technischer Scope-Typ |
| Schulung | fachlicher Schulungseigentümer | zentral verpflichtend oder lokal ergänzend | Unternehmen, Standort oder Abteilung |

Eine Rollen- oder Positionszuordnung darf im ersten Ausbau nur als geprüfte Auswahlregel auf bereits zulässige Unternehmens-, Standort- oder Abteilungspakete wirken. Das bestehende M4-Modell kennt Rolle beziehungsweise Position noch nicht als eigenen Geltungsbereich; eine Erweiterung benötigt einen gesonderten Scope- und Migrationsvertrag.

### 5.3 Paketauflösung

Vor dem Start werden alle passenden veröffentlichten Pakete ermittelt:

`Unternehmenspflicht + Standortergänzung + Abteilungsergänzung + optionale Rollenergänzung`

Verbindlich gelten folgende Regeln:

- Pflichtpakete sind ausschließlich unternehmensweit und können lokal nicht abgewählt werden.
- Lokale Pakete sind ausschließlich Ergänzungen.
- Gleiche Codes oder fachlich widersprüchliche Aufgaben erzeugen keinen impliziten Vorrang.
- Die Startvorschau nennt Paket, Version, Geltungsbereich, Verantwortliche und fehlende Voraussetzungen.
- Gestartet wird nur die vollständig bestätigte Auflösung. Jedes Paket behält seine eigene Version und Instanzidentität.
- Die Paketauflösung erfolgt serverseitig. Ein Client darf weder ein Pflichtpaket noch einen Konflikt durch Weglassen aus dem Startauftrag umgehen.
- Fall, sämtliche ausgewählten Paketinstanzen, alle Einzelzuweisungen und das Startaudit entstehen als eine idempotente Alles-oder-nichts-Fachaktion in einer serialisierbaren Transaktion. Scheitert ein Teil, bleibt kein halber Fall und keine einzelne gestartete Instanz zurück.
- Der Startauftrag besitzt eine eindeutige Vorgangs-ID und einen kanonischen Inhaltsbeleg. Eine exakte Wiederholung liefert dasselbe Ergebnis; dieselbe ID mit anderem Inhalt ist ein Konflikt.
- Eine Konfliktentscheidung benötigt eine zentrale Berechtigung, Begründung und Audit. Sie verändert keine veröffentlichte Version, sondern bestätigt ausschließlich die konkrete zulässige Fallauflösung.
- Spätere Veröffentlichungen gelten nur für neue Starts. Eine Übernahme in laufende Fälle erfolgt niemals automatisch.

- Bereits vorhandene M4-Onboarding-Publikationen werden nicht automatisch nachträglich startbar. Sie müssen unter dem neuen Schutzvertrag ausdrücklich geprüft und erneut freigegeben oder durch eine neue Veröffentlichung ersetzt werden.

### 5.4 Onboarding-Zustände

| Zustand | Fachliche Bedeutung |
|---|---|
| vorbereitet | Pakete, Termine und Verantwortliche werden geprüft; noch keine laufenden Aufgaben |
| freigegeben | Startvorschau ist bestätigt; es existieren noch keine Paketinstanzen, Zuweisungen oder Aufgabenprojektionen |
| aktiv | die atomare Erzeugung aller Pakete und Zuweisungen ist abgeschlossen; erst jetzt dürfen berechtigte Aufgabenprojektionen erscheinen |
| abgeschlossen | alle Pflichtpakete sind fachlich abgeschlossen; offene optionale Ergänzungen sind ausdrücklich geklärt |
| abgebrochen | Eintritt findet nicht statt oder der Fall wurde aus dokumentiertem Grund beendet; Historie bleibt erhalten |

Ein Onboarding wird nicht allein durch einen Prozentwert abgeschlossen. Fehlende Pflichtaufgaben, ungeklärte Ausnahmen oder nicht vollständig belegte Pflichtnachweise blockieren den Abschluss.

Zulässige Übergänge sind fachlich begrenzt:

| Von | Nach | Entscheidung |
|---|---|---|
| noch kein Fall | vorbereitet | berechtigte PL legt Beschäftigungsepisode, Referenztermine und Fallverantwortung fest |
| vorbereitet | freigegeben | berechtigte PL bestätigt die vollständige konfliktfreie Paketauflösung und den atomaren Startauftrag |
| freigegeben | aktiv | die atomare Erzeugung aller Paketinstanzen und Zuweisungen wurde erfolgreich abgeschlossen |
| vorbereitet, freigegeben oder aktiv | abgebrochen | berechtigte PL bestätigt Grund und Behandlung offener Aufgaben; nach dem Start ist ein eigener technischer Abbruchvertrag erforderlich |
| aktiv | abgeschlossen | berechtigte PL bestätigt sämtliche Abschlussgates |

`abgeschlossen` und `abgebrochen` sind terminal. Sie werden nicht wieder geöffnet. Ein neuer Onboarding-Fall in derselben Beschäftigungsepisode ist nur nach einer ausdrücklichen zentralen Entscheidung mit Grund und unveränderlichem Vorgängerbezug zulässig; er verwendet die dann aktuelle veröffentlichte Version. Korrekturen an einem abgeschlossenen Fall erfolgen über ein neues Korrekturereignis oder einen eigenen Folgeprozess.

## 6. Offboarding

### 6.1 Prozessbereiche

Ein Offboarding kann folgende getrennte Pakete enthalten:

- PL und Vertragsende,
- Kommunikation und Übergabe,
- Wissenstransfer und offene Verantwortlichkeiten,
- Arbeitsmittel und Zutrittsmittel,
- Zugänge und Berechtigungen,
- offene Schulungs- oder Nachweispflichten,
- Abschlussgespräch,
- Abschlussdokumente und Nacharbeiten.

Der Austrittsgrund, interne Bewertungen, rechtliche Unterlagen und PL-Vermerke gehören nicht in operative Aufgaben. Ausführende Stellen erhalten nur die erforderliche Handlung, den freigegebenen Zeitpunkt und eine minimale Identität.

| Paketfamilie | Fachlicher Eigentümer | Zulässige Grundform | Typischer Geltungsbereich |
|---|---|---|---|
| PL und Vertragsende | zentrale PL | unternehmensweites, streng vertrauliches Pflichtpaket | Unternehmen |
| Kommunikationsfreigabe und Mitarbeiterinformation | zentrale PL mit getrenntem Freigaberecht | unternehmensweites Pflichtpaket | Unternehmen |
| Zugänge und Berechtigungen | zentrale PL mit IT-/Security-Ausführung | unternehmensweiter Pflichtkern; keine lokale Abwahl | Unternehmen, operative Ausführung am Standort möglich |
| Arbeits- und Zutrittsmittel | zentrale PL mit Arbeitsmittelverantwortung | unternehmensweiter Pflichtkern plus lokale Ergänzung | Unternehmen oder Standort |
| Übergabe und offene Verantwortlichkeiten | PL mit zuständiger Führung | zentraler Prüfpflichtkern plus lokale Ergänzung | Standort oder Abteilung |
| Abschlussdokumente und Nacharbeiten | zentrale PL | unternehmensweites Pflichtpaket | Unternehmen |
| Abschlussgespräch | zentrale PL | ausdrücklich konfigurierbares Pflicht- oder Ergänzungspaket | Unternehmen oder Standort |

Auch der zeitkritische Ausnahmepfad muss mindestens Vertrags-/Fallentscheidung, Kommunikationsfreigabe, Zugangsentscheidung, Arbeitsmittelprüfung, Audit und dokumentierte Nacharbeit enthalten. Lokale Offboarding-Ergänzungen dürfen nur operative Übergabe- oder Arbeitsmittelaufgaben ergänzen und niemals Austrittsgrund, Freigabe, Zugangsentscheidung oder zentrale PL-Kontrollen verändern.

### 6.2 Vertrauliche Zustandsfolge

| Zustand | Sichtbarkeit und Wirkung |
|---|---|
| intern vorbereitet | ausschließlich berechtigte PL-Stellen; für Mitarbeiter, FL, AL, Aufgabenempfänger und Benachrichtigungssysteme existiert der Fall nicht |
| zur Kommunikation freigegeben | freigegebene interne Beteiligte dürfen vorbereitete Aufgaben sehen; für den Mitarbeiter bleiben Register, Aufgaben, Badges und Benachrichtigungen vollständig gesperrt |
| Mitarbeiter informiert | persönliche Information ist mit Zeitpunkt und verantwortlicher Person dokumentiert; erst dieser atomare Übergang darf ausdrücklich mitarbeiterfreigegebene Inhalte öffnen |
| aktives Offboarding | freigegebene Aufgaben dürfen entsprechend ihrem Zeitpunkt bearbeitet werden |
| abgeschlossen | Pflichtpakete, offene Ausnahmen, Zugänge und Arbeitsmittel sind fachlich geklärt |
| abgebrochen | Austritt wurde zurückgenommen oder der Fall aus dokumentiertem Grund beendet; alle bisherigen Ereignisse bleiben erhalten |

Der Übergang aus `intern vorbereitet` benötigt eine ausdrückliche Freigabe durch eine persönlich berechtigte PL. Dieselbe PL darf den Fall vorbereiten und freigeben. Vor dem Übergang werden das aktuelle Freigaberecht, eine erneute bewusste Bestätigung und die Begründung geprüft; Akteur und Zeitpunkt werden geschützt auditiert. Eine zweite Person oder eine Rolle oberhalb der PL ist nicht erforderlich; die PL gehört bereits zur PL+-Ebene.

Im Zustand `intern vorbereitet` existiert ausschließlich der gesondert geschützte Offboarding-Fall mit seinen geschützten Vorbereitungsdaten. Es werden noch keine operativen M5-Instanzen oder persönlichen Aufgaben angelegt. Benötigte interne Vorbereitungsschritte dürfen später nur über einen eigenen vertraulichen Aufgabenpfad abgebildet werden. Erst die Kommunikationsfreigabe darf die freigegebenen operativen Paketinstanzen als atomare Fachaktion erzeugen.

Vor der Kommunikationsfreigabe dürfen weder Aufgaben, Kalenderhinweise, E-Mails, SMS, WhatsApp-Nachrichten, Portalbadges noch aggregierte Fortschrittswerte die Existenz des Offboardings offenlegen. Auch technische Logs und Auditprojektionen müssen die vertrauliche Klassifikation beachten.

Zulässige Übergänge sind fachlich begrenzt:

| Von | Nach | Entscheidung |
|---|---|---|
| noch kein Fall | intern vorbereitet | persönlich berechtigte PL mit vertraulichem Vorbereitungsrecht |
| intern vorbereitet | zur Kommunikation freigegeben | persönlich berechtigte PL mit vertraulichem Lese- und Freigaberecht; dieselbe PL darf auch vorbereitet haben |
| zur Kommunikation freigegeben | Mitarbeiter informiert | berechtigte PL dokumentiert die tatsächlich erfolgte persönliche Information; Mitarbeitersicht wird erst mit diesem Übergang freigegeben |
| Mitarbeiter informiert | aktives Offboarding | berechtigte PL aktiviert die nach Information zulässigen Aufgaben |
| intern vorbereitet | abgebrochen | vorbereitende PL mit Grund; keine Offenlegung an den Mitarbeiter |
| zur Kommunikation freigegeben | abgebrochen | persönlich berechtigte PL mit Freigaberecht bestätigt Rücknahme und Behandlung bereits bereitgestellter interner Aufgaben |
| Mitarbeiter informiert oder aktiv | abgebrochen | persönlich berechtigte PL mit Freigaberecht bestätigt Rücknahme, Nacharbeit und erforderliche Korrekturinformation an den Mitarbeiter |
| aktives Offboarding | abgeschlossen | berechtigte PL bestätigt sämtliche Abschlussgates |

`abgeschlossen` und `abgebrochen` sind terminal. Ein neuer Offboarding-Fall in derselben Beschäftigungsepisode ist nur nach zentraler Entscheidung mit Grund und unveränderlichem Vorgängerbezug zulässig. Bereits ausgeführte Sperr-, Freigabe- oder Rückgabeaktionen werden nie aus der Historie entfernt; notwendige Gegenmaßnahmen entstehen als neue Aufgaben beziehungsweise Folgeaktionen.

### 6.3 Zeitkritische und sofortige Austritte

Ein zeitkritischer Austritt verwendet einen gesonderten, vertraulichen Ausnahmepfad. Er darf Fristen verkürzen, aber keine zentralen Pflichtkontrollen entfernen. Insbesondere bleiben Freigabe, dokumentierter Sperrzeitpunkt, verantwortliche Einzelzuweisung, Audit und spätere Nacharbeit erforderlich.

Konten oder Zugänge werden niemals allein durch das Anlegen eines Offboardings gesperrt. Eine spätere technische Integration benötigt eine eigene freigegebene Aktion mit Zielsystem, Zeitpunkt, Ausführungsnachweis und kontrollierter Fehlerbehandlung.

Mitarbeiteridentität, persönlicher Portalzugang und externe Systemzugänge werden getrennt behandelt. Die historische Mitarbeiteridentität darf nicht vor Abschluss der erforderlichen Offboarding-Nachweise entfernt werden. Da der heutige M5-Start einen aktiven Mitarbeiterbezug verlangt, muss der technische Folgeblock entweder die Deaktivierung kontrolliert ans Prozessende legen oder einen eigenen geschützten Zustand „Austritt läuft“ einführen. Eine vorzeitige Deaktivierung darf keinen unauflösbaren Restprozess erzeugen.

## 7. Rollen und Verantwortungen

`R` bedeutet ausführungsverantwortlich, `A` fachlich verantwortlich, `C` einzubeziehen und `I` nach Freigabe zu informieren. Jeder Vorgang besitzt genau eine fachlich verantwortliche Stelle. Eine Person kann mehrere Rollen wahrnehmen, die Berechtigungsprüfungen bleiben dennoch getrennt.

| Vorgang | A | R | C/I |
|---|---|---|---|
| unternehmensweite Pflichtpakete festlegen | zentrale PL mit Publikationsfreigabe | benannte PL/Fachverantwortung | FL, AL und betroffene Fachstellen als C |
| lokale Prozessverwaltung freigeben | PL+-Konto mit eigenem Delegationsrecht | dasselbe berechtigte PL+-Konto | lokale FL/AL als I |
| Onboarding-Fall vorbereiten und starten | fallverantwortliche PL | fallverantwortliche PL | zuständige FL, AL, Arbeitsmittel-, Schulungs- und Fachstellen als C |
| Personal- und Administrationsaufgaben | fallverantwortliche PL | konkret zugewiesene PL oder Lohnverrechnungs-Fachstelle | Mitarbeiter nur bei eigener freigegebener Aufgabe |
| Standortorganisation | fallverantwortliche PL | zuständige FL | AL und lokale Arbeitsmittelverantwortung als C; Mitarbeiter als C |
| Abteilungseinschulung | fachlich verantwortliche PL | zuständige AL beziehungsweise ausdrücklich benannter Trainer | FL als C; Mitarbeiter als C |
| Schulungsabschluss bestätigen | benannter Schulungseigentümer | ausdrücklich benannter Trainer oder Prüfer | PL/FL/AL nach freigegebener Projektion als I |
| Offboarding intern vorbereiten | fallverantwortliche PL mit vertraulichem Recht | dieselbe PL | keine operative Information |
| Offboarding zur Kommunikation freigeben | fallverantwortliche PL mit eigenem vertraulichem Lese- und Freigaberecht | dieselbe PL | keine zweite Person erforderlich; die allgemeine PL+-Ebene ersetzt das Aktionsrecht nicht |
| Mitarbeiter persönlich informieren | fallverantwortliche PL | ausdrücklich benannte PL oder Führungskraft mit Minimalprojektion | Mitarbeiter als I im Moment der dokumentierten Information |
| Arbeitsmittel und operative Übergabe | fallverantwortliche PL | Arbeitsmittelverantwortung; FL/AL nur für ihren Bereich | Mitarbeiter als C nach Information |
| Zugangsmaßnahme fachlich anweisen | fallverantwortliche PL | getrennte IT-/Security-Fachstelle | FL/AL nur als I; Mitarbeiter erst nach zulässiger Offenlegung |
| Referenztermin ändern und offene Fristen neu berechnen | fallverantwortliche PL | fallverantwortliche PL | betroffene Aufgabenverantwortliche als C |
| kritischen Zugriffssperrzeitpunkt übersteuern | fallverantwortliche PL mit eigenem Freigaberecht beziehungsweise freigegebene Notfallstelle | fallverantwortliche PL | IT-/Security-Fachstelle als C |
| Onboarding-Fall abschließen oder abbrechen | fallverantwortliche PL | fallverantwortliche PL | betroffene Stellen und Mitarbeiter nach Sichtbarkeitsregel als C/I |
| Offboarding nach Kommunikationsfreigabe abbrechen | fallverantwortliche PL mit eigenem Freigaberecht | fallverantwortliche PL | betroffene interne Stellen und Mitarbeiter nach Sichtbarkeitsregel als I |
| Offboarding abschließen | fallverantwortliche PL | fallverantwortliche PL | IT/Security, Arbeitsmittelverantwortung, FL/AL als C |

Die Tabelle beschreibt Verantwortungen, nicht automatisch technische Rechte. Die PL+-Ebene macht PL, Admin, IT-Admin und Developer für zentrale Fachfunktionen berechtigbar; wirksam wird eine konkrete Datenansicht oder Aktion erst durch das zugehörige Fachrecht. Ein Delegationsrecht erzeugt keinen zusätzlichen Fallzugriff. FL, AL, Lohnverrechnung, IT/Security, Arbeitsmittelverantwortung und Trainer sind getrennte Empfängerklassen und sehen ausschließlich die für ihren freigegebenen Bereich und ihre konkrete Aufgabe erforderliche Projektion.

## 8. Verantwortliche, Vertretung und Ausnahmen

- Vor dem Start wird jeder nicht systemische Schritt genau einer aktiven, berechtigten Person zugewiesen.
- Das System wählt bei mehreren geeigneten Personen niemanden stillschweigend aus.
- Eine Umbesetzung ersetzt den historischen Verantwortlichen nicht. Sie erzeugt eine nachvollziehbare Nachfolgezuweisung mit Grund, Zeitpunkt und Akteur.
- Eine abwesende oder deaktivierte verantwortliche Person löst im ersten Ausbauschritt keine automatische Eskalation aus. Der Fall wird für die fachlich verantwortliche PL als Klärungsbedarf sichtbar.
- Eine Pflichtaufgabe darf nur dann als nicht anwendbar behandelt werden, wenn die veröffentlichte Version dies fachlich zulässt und eine dafür berechtigte Stelle einen Grund bestätigt.
- FL und AL dürfen zentrale PL-, Compliance- oder vertrauliche Schritte weder überspringen noch als nicht anwendbar erklären.
- „Übersprungen“, „nicht anwendbar“ und „abgeschlossen“ bleiben unterschiedliche, auditierbare Ergebnisse.

Für die manuelle Bearbeitung gilt zunächst folgende Klärungskette:

| Aufgabenklasse | erste Klärung | fachliche Eskalation | letzte fachliche Klärung |
|---|---|---|---|
| operative Onboarding-Aufgabe | konkret verantwortliche Person | zuständige FL oder AL | fallverantwortliche PL |
| Personal- oder Administrationsaufgabe | fallverantwortliche PL | erneute bewusste Prüfung durch dieselbe PL | keine weitere Person als Pflicht |
| Arbeitsmittel- oder Zugangsaufgabe | ausführende Fachstelle | fallverantwortliche PL | benannte Sicherheits-/Betriebsverantwortung |
| vertrauliche Offboarding-Freigabe | fallverantwortliche PL | erneute bewusste Bestätigung mit aktuellem Freigaberecht | keine weitere Person als Pflicht |

Jede veröffentlichte Aufgabe muss fachlich festlegen: Referenztermin, Zielzeit oder Reihenfolge, Kritikalität, zulässige Ausnahme, erforderlichen Nachweis und verantwortliche Klärungskette. Das ist zunächst Prozessinhalt und löst noch keine automatische Erinnerung oder Eskalation aus.

Vertretungs-, Fälligkeits- und Eskalationsautomatik werden erst in einem späteren, getrennten Automatisierungsblock festgelegt.

## 9. Sichtbarkeit und Datenminimierung

Das Konzept unterscheidet fachlich mindestens folgende Schutzklassen. Die späteren technischen Bezeichner werden in einem eigenen Rechtevertrag festgelegt:

| Klasse | Beispiele | Zulässiger Empfängerkreis |
|---|---|---|
| operativ standard | Rundgang, Arbeitsplatzvorbereitung, allgemeine Einschulung | konkret zugewiesene Personen im wirksamen Bereich |
| personenbezogen eingeschränkt | Arbeitszeitmodell, private Kontaktdaten, individuelle Nachweise | PL und ausdrücklich berechtigte Empfänger |
| PL-vertraulich | Vertragsdetails, interne PL-Aufgaben, rechtliche Unterlagen | berechtigte PL-Stellen |
| Offboarding streng vertraulich | geplanter Austritt vor Kommunikationsfreigabe, Austrittsgrund, Sperrstrategie | ausdrücklich berechtigte PL-Stellen |
| mitarbeiterfreigegeben | eigene Aufgaben, Termine und bereitgestellte Unterlagen | betroffener Mitarbeiter beim Onboarding nach ausdrücklicher Aufgabenfreigabe, beim Offboarding erst ab dokumentiertem Zustand `Mitarbeiter informiert` |

Verbindliche Sichtbarkeitsregeln:

- Der Mitarbeiter sieht nur ausdrücklich für ihn freigegebene eigene Inhalte. Beim Offboarding bleibt diese Sicht bis zum atomaren Übergang `Mitarbeiter informiert` vollständig geschlossen. M7-Self-Service-Rechte werden daraus nicht abgeleitet.
- FL und AL sehen nur operative Inhalte im freigegebenen Bereich und erst nach Erreichen der jeweiligen Sichtbarkeitsstufe.
- Technische Rollen wie Admin, IT-Admin oder Developer erhalten aus ihrer Systemrolle keine neuen Onboarding-/Offboarding-Fallrechte und keine vertraulichen Fallprojektionen. Bestehende globale M4-Rechte für Standard-Workflows bleiben unverändert, reichen für diese neuen Fälle aber nicht aus.
- Eine ausführende technische Fachstelle erhält keinen Austrittsgrund, keine PL-Notiz und keine vollständige Personalakte.
- Kommentare, Anhänge, Nachweise, Titel, Vorschauen und Benachrichtigungstexte erben mindestens die Schutzklasse des zugehörigen Schritts.
- Vertrauliche Inhalte müssen später im gesamten Pfad aus Entwurf, Revision, Veröffentlichung, Instanz, Aufgabe und Historie geschützt gespeichert und positiv projiziert werden. Der heutige Klartextpfad für Prozessentwürfe und Revisionssnapshots ist dafür nicht zulässig.
- Nicht berechtigte Ansichten erhalten vor einer Offboarding-Kommunikationsfreigabe weder Platzhalter noch Zähler oder Hinweise auf einen verborgenen Fall.
- Nach Freigabe kann ein geschützter Teilbereich neutral als „Personaladministration in Bearbeitung“ erscheinen. Schrittzahl, Titel, Kommentare und Ursache bleiben verborgen.
- Listen, Detailansichten, Aufgaben, Exporte, Dokumentabrufe, Suche, Benachrichtigungen und Auditprojektionen wenden dieselbe Klassifikation an.

Onboarding-, Offboarding- und Schulungsrechte sind eigene spätere Fachrechte. M4-Workflowrechte und M7-Profilrechte allein schalten weder Fallinhalte noch Mutationen frei.

Eigene Mitarbeiteraufgaben sind erst zulässig, wenn ein aktiver persönlicher Portalzugang besteht und die Aufgabe ausdrücklich als mitarbeiterfreigegeben klassifiziert wurde. Vorher wird keine Selbstzuweisung erzeugt; die vorbereitende Aufgabe bleibt bei einer berechtigten internen Person.

Für interne Aufgabenprojektionen gilt als fachliche Positivliste:

| Empfängerklasse | Erforderliche Felder | Ausdrücklich ausgeschlossen |
|---|---|---|
| Mitarbeiter | eigener Aufgabentitel, freigegebene Anleitung, Termin, eigener Status, erlaubter Nachweis | interne Gründe, PL-Kommentare, Sperrplanung, andere Verantwortliche und verborgene Pakete |
| FL/AL | Auftrags-ID, Anzeigename, freigegebener Standort/Abteilung, operative Aufgabe, Termin, eigener Status | Austrittsgrund, Privatkontakt, Vertragsdaten, PL-Dokumente und fachfremde Pakete |
| IT/Security | Auftrags-ID, Anzeigename oder erforderliche geschäftliche Kennung, Zielsystem, Aktion, freigegebener Ausführungszeitpunkt | Austrittsgrund, Privatkontakt, Vertragsdaten, PL-Notizen, andere Aufgaben und vollständiges Profil |
| Arbeitsmittelverantwortung | Auftrags-ID, Anzeigename, Standort, konkrete Asset-/Schlüsselkennung, Übergabe- oder Rückgabetermin | Austrittsgrund, Vertragsdaten, private Kontaktdaten und Zugangsplanung |
| Trainer/Prüfer | Auftrags-ID, Anzeigename, freigegebener Organisationsbereich, Modul, Termin und Nachweisstatus | Vertragsdaten, Austrittsgrund, private Kontaktdaten und andere Schulungen |
| Lohnverrechnung | Auftrags-ID, Personalnummer, Anzeigename und ausdrücklich erforderliche Beschäftigungs-/Abrechnungsfelder | Prozesskommentare, operative Aufgaben, Arbeitsmittel, Zugangsplanung und nicht erforderliche Dokumente |

Die spätere API darf je Aufgabenart nur die Schnittmenge aus dieser fachlichen Liste, dem konkreten Auftragszweck und den aktuellen Feldrechten liefern. Ein Feld wird nicht allein deshalb ausgegeben, weil es in einer anderen Aufgabenklasse zulässig wäre.

## 10. Aufgaben, Fortschritt und Abschluss

Aufgaben bleiben Projektionen von Workflow-Instanzschritten und werden nicht als zweite Wahrheit gespeichert.

Ein Fall zeigt pro Paket:

- veröffentlichte Version,
- Verantwortliche,
- sichtbare offene und überfällige Aufgaben,
- nächste sichtbare Frist,
- Blockaden und Abhängigkeiten,
- freigegebene Nachweise,
- fachlichen Abschlussstatus.

Fortschritt wird pro Paket ausgewiesen. Ein Gesamtfortschritt darf nur aus den für die betrachtende Person zulässigen Informationen entstehen. Sind geschützte Pakete vorhanden, wird kein scheinbar vollständiger Prozentwert aus einer Teilmenge angezeigt. Stattdessen werden sichtbarer Fortschritt und geschützte Bereiche getrennt gekennzeichnet.

Ein Fall kann erst abgeschlossen werden, wenn:

1. alle Pflichtpakete einen zulässigen Endstatus besitzen,
2. übersprungene oder nicht anwendbare Pflichtschritte ausdrücklich begründet und freigegeben sind,
3. notwendige Dokument- und Übergabenachweise vorhanden sind,
4. offene Blockaden geklärt oder als dokumentierte Nacharbeit übernommen wurden und
5. eine berechtigte PL den fachlichen Abschluss bestätigt.

## 11. Dokumente, Nachweise und Kommentare

- Dokumente bleiben in der bestehenden geschützten Mitarbeiterakte und verwenden Kategorien, Sichtbarkeit, Versionierung, Integritätsbelege und Historie aus M6.
- Ein Prozessschritt verweist später auf eine ausdrücklich freigegebene Dokumentversion; er speichert weder Binärinhalt noch ungeschützte Metadatenkopien.
- Eine neue Dokumentversion verändert keinen bereits abgeschlossenen historischen Nachweis rückwirkend.
- Operative Übergabeprotokolle, Schulungsnachweise und PL-Dokumente erhalten getrennte Kategorien und Sichtbarkeiten.
- Freitext ist kein Ersatz für strukturierte Status-, Grund- oder Nachweisfelder. Hinweise dürfen keine unnötigen Gesundheits-, Bewerbungs-, Rechts- oder Bewertungsdaten enthalten.
- Kenntnisnahmen und einfache Bestätigungen werden nur als interne Nachweise behandelt. Eine qualifizierte elektronische Signatur oder sonstige externe Rechtswirkung wird nicht behauptet.
- Physische Löschung, Anonymisierung und Aufbewahrungsfristen bleiben bis zu einer gesonderten, dokumentierten Aufbewahrungsentscheidung gesperrt.

## 12. Einbettung in das Mitarbeiterprofil

### Onboarding-Register

Das Register bündelt die getrennten Pakete einer Beschäftigungsepisode und zeigt nur berechtigte Projektionen. Es enthält Paketstatus, sichtbare Aufgaben, Fristen, Verantwortliche und Nachweise. Schulungsabschlüsse werden zusätzlich in den dauerhaften Schulungsverlauf projiziert, ohne den Abschluss doppelt zu speichern.

### Offboarding-Register

Ohne sichtbaren freigegebenen Fall zeigt das Register ausschließlich den neutralen Leerzustand. Ein intern vorbereiteter Fall verändert diesen Zustand für Unberechtigte nicht. Nach der Kommunikationsfreigabe werden nur für freigegebene interne Beteiligte die vorgesehenen Inhalte geladen. Für den betroffenen Mitarbeiter bleibt das Register bis zum dokumentierten Übergang `Mitarbeiter informiert` unverändert geschlossen.

### Personalaufgaben

Eigene Aufgaben, Freigaben und bereichsbezogene Managementansichten bleiben Projektionen derselben Prozessinstanzen. Aufgaben dürfen keine geschützten Fallinhalte in Titel, Vorschau, Browserbenachrichtigung oder URL offenlegen.

Die M7-Regeln für Lazy Loading und Zustandsbereinigung gelten fort: Geschützte Inhalte werden erst bei tatsächlichem Registerwechsel geladen und bei Rechteentzug, Bereichsänderung, Fehler oder Schließen vollständig aus UI-Zustand und DOM entfernt.

## 13. Sonderfälle

| Sonderfall | Verbindliche Behandlung |
|---|---|
| Eintritt verschoben | Änderung mit Grund protokollieren; offene relative Fristen nur nach ausdrücklicher Bestätigung neu berechnen |
| Eintritt abgesagt oder nicht angetreten | Onboarding abbrechen, Historie erhalten und bereits angelegte Arbeitsmittel/Zugänge über kontrollierte Rücknahmeaufgaben klären |
| interne Standort-, Abteilungs- oder Positionsänderung | kein Offboarding; eigener Änderungsprozess mit Delta für Aufgaben, Arbeitsmittel und Zugänge |
| Rückkehr nach längerer Abwesenheit | eigener Rückkehrprozess; abgeschlossenes Onboarding bleibt geschlossen |
| Wiedereinstellung | neue Beschäftigungsepisode und neues Onboarding; frühere Prozesse bleiben historisch; Portalzugang, Sitzungen, Rollen, Fachscopes und externe Zugänge werden niemals automatisch reaktiviert |
| Austritt zurückgenommen | Offboarding abbrechen; bereits ausgeführte Sperr- oder Rückgabeaktionen werden nicht gelöscht, sondern über kontrollierte Wiederherstellungsaufgaben behandelt |
| sofortiger Austritt | vertraulicher Ausnahmepfad mit verkürzten Fristen, aber ohne Wegfall zentraler Kontrollen |
| mehrere organisatorische Zuordnungen | Start bleibt gesperrt, bis der fachlich wirksame Bereich und die anzuwendenden Pakete eindeutig bestätigt sind |
| verantwortliche Person fällt aus | Klärungsbedarf an fachlich verantwortliche PL; keine automatische oder stillschweigende Ersatzperson |
| parallele Fälle | pro Beschäftigungsepisode höchstens ein aktiver Onboarding- und ein aktiver Offboarding-Fall; Überschneidungen benötigen eine ausdrückliche zentrale Entscheidung |

## 14. Audit, Archivierung und Datenschutz

Mindestens folgende Ereignisse müssen später nachvollziehbar sein:

- Fall vorbereitet, freigegeben, gestartet, abgeschlossen oder abgebrochen,
- Paketauflösung und verwendete Versionen,
- Referenztermin geändert,
- Verantwortlicher zugewiesen oder ersetzt,
- Aufgabe abgeschlossen, übersprungen oder als nicht anwendbar bestätigt,
- Nachweis verknüpft,
- Offboarding zur Kommunikation freigegeben und Mitarbeiterinformation bestätigt,
- Ausnahme, Blockade und Abschlussfreigabe.

Auditdaten enthalten Akteur, Zeitpunkt, Aktion, fachlichen Bezug und erforderlichen Grund, aber keine unnötigen Dokumentinhalte, Freitextkopien, privaten Kontaktdaten oder kryptografischen Rohbelege.

Bei streng vertraulichen Offboarding-Fällen werden auch erfolgreiche Detailansichten, Suchzugriffe mit Treffern, Exporte und Dokumentabrufe in einer geschützten Zugriffsspur protokolliert. Abgewiesene Zugriffe bleiben wertneutral und dürfen die Existenz des Falls nicht offenlegen. Wer diese Zugriffsspur lesen darf und wie lange sie aufbewahrt wird, benötigt vor O1 eine eigene Security-/Datenschutzentscheidung; ein allgemeines Admin- oder Developer-Recht genügt nicht.

Veröffentlichte Versionen, laufende und abgeschlossene Instanzen sowie verwendete Fälle werden nicht physisch gelöscht. Die Archivierung einer Veröffentlichung sperrt ausschließlich neue Starts und verändert keine laufende Instanz oder Aufgabe. Die Archivierung eines bereits terminalen Falls entfernt ihn aus aktiven Ansichten, ohne seine Instanzen oder Historie zu verändern. Aufbewahrung, Anonymisierung und physische Bereinigung benötigen einen eigenen Rechtsgrundlagen- und Löschvertrag.

## 15. Abgrenzung des ersten technischen Ausbaus

Nach Freigabe dieses Konzepts soll der erste technische Ausbau bewusst klein bleiben:

- gemeinsame Fall- und Schutzgrenze für Onboarding und Offboarding,
- eigene, aktionsbezogene Rechte und positive Projektionen,
- Vorbereitung einer späteren kontrollierten Startgrenze; der erste O1/O2-Grundblock startet noch keine Onboarding- oder Offboarding-Instanz,
- explizite Einzelzuweisungen,
- getrennte Onboarding-Pakete und ein geschützter Offboarding-Vorbereitungszustand,
- read-only Einbettung in die bestehenden Profilregister,
- Audit, Integrität, Migration und Negativtests.

Der technische Grundblock muss zusätzlich berücksichtigen:

- heutige M4-Onboarding-Publikationen bleiben ohne ausdrückliche Prüfung gesperrt,
- Offboarding-Inhalte benötigen einen geschützten Entwurfs-, Versions-, Instanz- und Aufgabenpfad,
- das aktuelle lineare M5-Schrittmodell erhält noch keine Verzweigungs- oder Bedingungsautomatik,
- heutige Systemschritte dürfen keine Konto-, Geräte- oder sonstige Außenwirkung auslösen,
- Abbruch, Ablösung und Umbesetzung benötigen additive Ereignisse beziehungsweise Sidecars; unveränderliche Bestandsbelege werden nicht überschrieben,
- Profilregister benötigen eine eigene mitarbeiterbezogene Serverprojektion; eine clientseitige Filterung der bestehenden Managementliste ist unzulässig und
- Mitarbeiter- und Portaldeaktivierung müssen so geordnet sein, dass ein laufender Offboarding-Fall kontrolliert abschließbar bleibt.

Onboarding darf erst mit O4 gemeinsam mit der kontrollierten Ausführung nach vollständiger, atomarer Paketauflösung startbar werden. O3 bleibt eine read-only Vorschau und erzeugt weder Instanzen noch Aufgaben. Offboarding darf erst mit O5 über den geschützten Vorbereitungs- und Kommunikationsfreigabepfad operative Instanzen erzeugen. Bis dahin bleiben beide Startarten fail-closed.

Noch nicht enthalten:

- automatische Starts aus Bewerberumwandlung, Eintritt oder Austritt,
- automatische Verantwortlichenauflösung,
- Fälligkeiten, Erinnerungen, Eskalationen und Vertretung,
- E-Mail, SMS, WhatsApp oder Push-Nachrichten,
- automatische Konto-, Schlüssel-, Geräte- oder Behördenaktionen,
- Mitarbeiter-Self-Service-Mutationen,
- grafischer Workflow-Editor,
- produktive PostgreSQL-Freigabe.

## 16. Offene Entscheidungen vor technischer Umsetzung

| Entscheidung | Empfohlener Ausgangspunkt |
|---|---|
| Wer ist standardmäßig Fallverantwortlicher? | eine ausdrücklich ausgewählte PL; keine Ableitung aus Rolle oder Organisation |
| Welche Onboarding-Pakete sind unternehmensweit verpflichtend? | zunächst Personal/Administration, Basissicherheit und Datenschutz; konkrete Inhalte kundenspezifisch freigeben |
| Welche Fristen gelten relativ zu welchem Referenztermin? | pro veröffentlichter Prozessversion ausdrücklich festlegen; keine impliziten Standardfristen |
| Was darf der Mitarbeiter nach dokumentierter persönlicher Information selbst sehen und bestätigen? | erst ab Zustand `Mitarbeiter informiert` nur eigene freigegebene Aufgaben und Unterlagen; keine PL-internen Gründe, Bewertungen oder Sperrplanung |
| Wer darf Pflichtschritte als nicht anwendbar bestätigen? | zentrale PL; lokale Leitung nur für ausdrücklich lokale optionale Schritte |
| Wie werden Mehrfachzuordnungen und Wechsel während eines laufenden Falls behandelt? | durch ausdrückliche Fallentscheidung und versionierten Scope-Snapshot, nicht automatisch |
| Welche Identität gilt bei einer Wiedereinstellung? | Personalnummer und Mitarbeiteridentität sind kundenabhängige Stamm-/Lohnverrechnungsentscheidungen; immer neue Beschäftigungsepisode, keine automatische Reaktivierung von Portalprofil, Sitzungen, Rollen, Fachscopes oder externen Zugängen; Anerkennung alter Nachweise nur je Kategorie nach ausdrücklicher Prüfung |
| Wann werden Mitarbeiteridentität, Portalzugang und externe Zugänge deaktiviert? | eigener geschützter Zustand `Austritt läuft` wird empfohlen; operativer Zugang kann zum freigegebenen Sperrzeitpunkt enden, historische Identität und PL-Restbearbeitung bleiben bis zum kontrollierten Abschluss erreichbar |
| Wie werden Abbruch, Neustart und Korrektur technisch abgebildet? | terminale Fälle nie wieder öffnen; neuer Fall oder Folgeprozess nur mit Vorgängerbezug, Grund, Idempotenz und eigener Rechteprüfung |
| Welche Dokumentkategorien, Aufbewahrungsfristen und Rechtsgrundlagen gelten? | vor Upload- oder Bereinigungsautomatik je Kategorie dokumentieren und rechtlich prüfen |
| Wo endet Schulungsnachweis und wo beginnt ein externes Lernsystem? | Grabenplaner hält Zuweisung, Status und Nachweis; Lerninhalt nur bei ausdrücklicher Integrationsentscheidung |
| Welche Systeme dürfen später Zugangs- oder Arbeitsmittelaktionen erhalten? | Positivliste je Integration mit minimaler Projektion, Freigabe, Idempotenz und Rückmeldung |
| Welche Bedeutung haben digitale Kenntnisnahmen? | zunächst ausschließlich interner Nachweis ohne Signatur- oder Rechtswirkungsbehauptung |
| Wer darf die geschützte Zugriffsspur vertraulicher Fälle lesen und wie lange bleibt sie erhalten? | eigenes, nicht technisch abgeleitetes Auditrecht; Aufbewahrung und Zugriff mit Datenschutz/Security festlegen, keine vertraulichen Nutzdaten im allgemeinen Audit |

Offene Entscheidungen erzeugen keine produktiven Standardwerte. Wo eine Entscheidung fehlt, bleibt die betreffende Mutation oder Außenwirkung gesperrt.

## 17. Empfohlene Issues und PRs nach Konzeptfreigabe

1. **O1 – Rechte-, Datenklassifikations- und Fallvertrag**
   Eigene Rechte, Sichtbarkeitsklassen, Zustandsautomaten, positive Projektionen, Auditgrenzen und technische Zielentitäten dokumentieren und testen.
2. **O2 – Additives Fall- und Instanzfundament**
   Verlustfreie Migration, die in O1 festgelegte technische Repräsentation von Beschäftigungsepisode und Fall, unveränderliche Bindungen sowie read-only Paketauflösung und Startvorschau. Onboarding- und Offboarding-Starts bleiben gesperrt.
3. **O3 – Onboarding-Pakete im Mitarbeiterprofil**
   Additive serverseitige Paketauflösung, read-only Startvorschau, Zuweisungsvorschau und serverseitig geschützte Profilprojektion. Dieser PR startet keine Instanz, erzeugt keine Aufgabe und erlaubt keine Aufgabenmutation oder automatische Fortschaltung.
4. **O4 – Kontrollierte Onboarding-Ausführung**
   Atomarer idempotenter Mehrpaket-Start, explizite Einzelzuweisungen, kontrollierte Aufgabenstatus, Nachweise, dokumentierte Ausnahmen und Abschlussfreigabe; noch ohne Benachrichtigungs- oder Eskalationsautomatik.
5. **O5 – Vertrauliches Offboarding**
   unsichtbare Vorbereitung ohne operative M5-Instanzen, getrenntes Freigaberecht, atomare Instanzerzeugung nach Kommunikationsfreigabe, minimale operative Projektionen, Ausnahmepfad und technische Nicht-Offenlegung.
6. **O6 – Schulungs-, Arbeitsmittel- und Zugangsschnittstellen**
   erst nach eigener Datenminimierungs-, Rechte- und Integrationsentscheidung.
7. **O7 – Fristen, Vertretung, Erinnerungen und Eskalationen**
   separater Automatisierungsblock mit Kalenderregeln, Vorschau, kontrollierten Außenwirkungen und Fehlerbehandlung.
8. **O8 – Grafischer Editor**
   erst nach stabilen Fall-, Rechte-, Versions- und Ausführungsgrenzen.

Jeder PR bleibt klein genug, um Migration, API, UI, Datenschutz und Regressionen unabhängig prüfen zu können. O2 und folgende dürfen erst beginnen, wenn O1 und die offenen fachlichen Entscheidungen für ihren jeweiligen Umfang freigegeben sind.

## 18. Abnahmekriterien für dieses Konzept

Das Konzept gilt als fachlich freigegeben, wenn mindestens bestätigt sind:

- Trennung von Preboarding, Onboarding, Beschäftigungsepisode und Offboarding,
- vier Onboarding-Bereiche und additive Paketauflösung,
- Offboarding-Zustandsfolge samt vollständiger Unsichtbarkeit vor Kommunikationsfreigabe,
- RACI und Bereichsgrenzen für die PL+-Ebene einschließlich PL, Admin, IT-Admin und Developer sowie für FL und AL,
- getrennte Referenztermine,
- Regeln für Verantwortliche, Abbruch, Wiedereinstellung, Versetzung und Austrittsrücknahme,
- Dokument-, Nachweis-, Audit- und Archivierungsgrenzen,
- konkrete Entscheidungen für den jeweils nächsten technischen Issue-Umfang.

Die fachliche Freigabe dieses Dokuments ist noch keine Produktiv-, Release-, Automatisierungs- oder Integrationsfreigabe.
