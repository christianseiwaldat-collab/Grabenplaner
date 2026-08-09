# Personalmodul – Workflow-Publikation M4 v0.1

Stand: 1. August 2026

Status: verbindlicher technischer Vertrag; in v0.89.0-beta als standardmäßig deaktiviertes Fundament enthalten

Produktstatus: nicht für den produktiven Betrieb freigegeben; das Installationsmerkmal `personnelLifecycle` bleibt standardmäßig deaktiviert

## 1. Umfang

M4 erweitert die vorhandene Prozessbasis um eine ausdrückliche Publikationsschicht. Es entsteht keine zweite Workflow-Engine.

- `custom_processes` und `custom_process_steps` bleiben der editierbare Entwurf.
- `custom_process_revisions` bleibt die unveränderliche Entwurfsrevision und Quelle einer Veröffentlichung.
- `custom_process_publications` ist die unveränderliche veröffentlichte Workflow-Version.
- `custom_process_publication_archives` ist der append-only Archivierungsnachweis.
- `custom_process_runs` und `custom_process_run_steps` bleiben in M4 unverändert. Ihre kontrollierte Bindung an eine Veröffentlichung ist M5.

Bestehende aktive Prozesse oder Revisionen werden nicht automatisch als Personal-Workflow klassifiziert. Sie bleiben als Legacy-Bestand sichtbar und müssen später ausdrücklich übernommen werden.

## 2. Publikationsinvarianten

Eine Veröffentlichung friert den vollständigen Revisionssnapshot einschließlich Titel, Schritten und Geltungsbereich ein. Entwurfsrevision und Veröffentlichungsnummer sind getrennt:

- Die Entwurfsrevision steigt bei jeder Bearbeitung.
- Die Veröffentlichungsnummer beginnt je Definition bei 1 und steigt lückenlos nur bei einer Veröffentlichung.
- Dieselbe Entwurfsrevision kann je Definition höchstens einmal veröffentlicht werden.
- Der stabile `workflowCode` darf zwischen Versionen derselben Definition nicht wechseln.
- Snapshot und Publikationsbeleg werden jeweils mit SHA-256 geprüft.
- Veröffentlichungszeilen können weder aktualisiert noch physisch gelöscht werden.
- Archivierung erzeugt genau einen unveränderlichen Tombstone und verändert keine Veröffentlichung, keinen Lauf, keine Aufgabe und keine Benachrichtigung.
- Eine Definition oder Revision mit einer Veröffentlichung oder einem vorhandenen Lauf darf nicht physisch gelöscht werden.

M4 veröffentlicht ausschließlich `dataClassification = standard`. Vertrauliche Schritte sowie `offboarding` bleiben bis zu einem eigenen Schutzvertrag fail-closed gesperrt. Damit werden vertrauliche Inhalte nicht ungeschützt in den bestehenden Klartext-Entwurfs- und Revisionspfad eingeführt.

## 3. Geltungsbereiche

Publikationen verwenden exakt einen der Bereiche `company`, `location` oder `department`.

- `mandatory` ist ausschließlich unternehmensweit zulässig.
- Lokale Veröffentlichungen sind ausschließlich `supplemental` und müssen einen Standort oder eine konkrete Standort-/Abteilungskombination besitzen.
- Unternehmensweite Publikationen und passende lokale Ergänzungen werden additiv vereinigt.
- Gleiche Codes oder Titel erzeugen keinen Override. Die Auflösung liefert stattdessen einen sichtbaren Konflikthinweis.
- Archivierte Versionen werden bei der aktiven Auflösung nicht berücksichtigt.

## 4. Rechtevertrag

M4 verwendet eigene Rechte und leitet keinen Workflow-Zugriff aus Bewerbungsrechten oder `processes:write` ab:

- `personnel:workflows:read`
- `personnel:workflows:draft:write`
- `personnel:workflows:review`
- `personnel:workflows:publish`
- `personnel:workflows:local:supplement`
- `personnel:workflows:confidential:read`
- `personnel:workflows:confidential:write`
- `personnel:workflows:delegate`

PL verwendet die bestehende Rolle `hr`. PL+ ist eine PL mit der zusätzlichen, nicht weiterdelegierbaren Capability `personnel:workflows:delegate`. Nur Lesen, Entwurfsbearbeitung, Veröffentlichung und lokale Ergänzung sind bereichsbezogen an FL oder AL delegierbar.

FL wirkt ausschließlich in der Schnittmenge eines ganzen allgemeinen Portalstandorts und des von PL+ für das jeweilige Recht genehmigten Standorts. AL benötigt auf beiden Seiten exakt dieselbe Standort-/Abteilungskombination. Lokale Veröffentlichung setzt alle vier lokalen Rechte voraus und kann nur eine Ergänzung erzeugen. IT-Admin bleibt auch bei injizierten Workflow-Rechten vollständig geschlossen. Vertrauliche Workflow-Rechte sind ausschließlich für PL vorgesehen; technische Rollen erhalten sie nicht automatisch.

Abhängigkeiten werden beim Speichern der Rechte geprüft: Schreiben setzt Lesen voraus, Veröffentlichen setzt Entwurfsbearbeitung voraus, lokale Ergänzung setzt Entwurfsbearbeitung voraus und vertrauliches Schreiben setzt vertrauliches Lesen sowie normales Schreiben voraus.

## 5. SQLite-Migration und Import

Der Marker lautet `v0.89-personnel-workflow-publications`. Die additive Startmigration:

1. prüft Tabellen, Trigger und vorhandene Publikationsdaten gegen kanonische Definitionen,
2. erzeugt bei einer vorhandenen Datenbank vor jeder notwendigen Änderung ein internes Pre-Migration-Backup,
3. erweitert die R1-Scope-Tabelle verlustfrei um die vier bereichsbezogenen Workflow-Rechte,
4. legt zwei M4-Tabellen, Indizes und zehn Schutztrigger an,
5. schreibt den Marker erst nach erfolgreicher Integritätsprüfung.

Ein fehlender M4-Stand ist migrationsfähig. Eine leere abweichende M4-Struktur darf kontrolliert neu aufgebaut werden. Sobald eine abweichende Struktur Publikations- oder Archivdaten enthält, bricht der Start nach dem Backup ohne Datenänderung fail-closed ab.

Die Read-only-Importprüfung unterscheidet `pre-m4-compatible`, `m4` und `invalid`. Altstände ohne M4 bleiben zulässig. Partielle Tabellen, fehlende Schutztrigger, ungültige Scope-Bezüge, Lücken in der Versionsfolge sowie manipulierte Snapshot- oder Beleg-Hashes sperren den Import. Die geprüfte Quelldatei wird nicht verändert.

SQLite bleibt der einzige Produktprovider. Der PostgreSQL-Katalog bildet die drei neuen Repository-Statements ausschließlich als `contract-only` ab; die zehn Anwendungsmigrationsstufen bleiben dort weiterhin 0/10 umgesetzt.

## 6. API

Die neuen Endpunkte liegen unter der vorhandenen fail-closed Feature-Grenze `/api/portal/v1/personnel-lifecycle`:

- `GET /workflows`
- `GET /workflow-publications/resolve?locationId=..&departmentId=..`
- `POST /workflows/:processId/publish`
- `POST /workflow-publications/:publicationId/archive`

Schreibzugriffe benötigen CSRF. Globale Zugriffe benötigen zusätzlich die vorhandenen zentralen Personalrechte; lokale Zugriffe werden durch die Rechte-/Scope-Schnittmenge begrenzt. Antworten enthalten nur fachliche Metadaten und Capabilities. Rohsnapshot, Hashwerte, Publikationsakteur, Archivierungsgrund und Genehmigungsidentitäten werden nicht ausgegeben.

`publish` akzeptiert ausschließlich `workflowCode`, `workflowType`, `requirementKind`, `dataClassification` und `containsConfidentialSteps`. Unbekannte Felder werden abgewiesen. `archive` akzeptiert ausschließlich eine Begründung mit 3 bis 300 Zeichen.

## 7. Bewusste Abgrenzung und M5-Folgestand

M4 erzeugt oder verändert keine laufende Instanz. An dieser historischen M4-Grenze waren für M5 ausdrücklich offen:

- die unveränderliche Bindung einer neuen Instanz an genau eine veröffentlichte Version,
- der Fachobjektbezug zu Bewerber oder Mitarbeiter,
- die Übernahme beziehungsweise Fortführung vorhandener Legacy-Läufe,
- Aufgabenprojektion, Eskalation und Verantwortlichenauflösung,
- die Klassifikation und technische Speicherung vertraulicher Onboarding-/Offboarding-Schritte.

Der grafische Editor und erweiterte Automatisierungen bleiben spätere, getrennte Blöcke.

Der Folgestand M5 löst ausschließlich die kontrollierte Bindung neuer Standard-Instanzen: Die Sidecars `custom_process_run_bindings` und `custom_process_run_step_assignments` binden einen neu erzeugten Lauf unveränderbar an genau eine Veröffentlichung, einen Bewerbungs- oder Mitarbeiterbezug sowie explizit geprüfte Einzelzuweisungen. Legacy-Läufe werden weiterhin nicht übernommen. Die Managementoberfläche zeigt Instanzen und ihren aktiven Schritt ausschließlich read-only; die bestehende persönliche Portalaufgabenroute darf den eingefroren zugewiesenen aktiven Schritt nach erneuter Live-Prüfung idempotent abschließen. Verantwortlichenautomatik, Fristen, Eskalation, Benachrichtigungen, freie `custom_personnel`-Workflows, Onboarding, Offboarding und vertrauliche Schritte bleiben außerhalb von M5. Der aktuelle Gesamtvertrag steht in `PERSONALMODUL-ZIELARCHITEKTUR-v0.1.md`.

## 8. Abnahme

Die M4-Grenze wird mindestens durch folgende Tests abgesichert:

- additive, sicherungsbewehrte und idempotente Migration,
- unveränderte Legacy-Prozesse, Revisionen und Läufe ohne automatische Publikation,
- SQL-seitige Unveränderbarkeit und Löschschutz,
- lückenlose Versionsfolge, stabiler Workflow-Code und unveränderter Snapshot,
- Pflicht-/Ergänzungs- und Konfliktauflösung ohne Override,
- PL-/PL+- sowie FL-/AL-Rechte, IT-Admin-Ausschluss und IDOR-Grenzen,
- fail-closed Schutz vertraulicher und Offboarding-Schritte,
- append-only Archivierung ohne Laufmutation,
- Read-only-Import für Altstand, gültiges M4 und manipulierte Negativfälle,
- Provider-, Portal- und bestehende Prozessregressionen.
