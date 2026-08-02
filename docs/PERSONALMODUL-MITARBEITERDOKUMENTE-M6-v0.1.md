# Personalmodul – Mitarbeiterdokumente M6 und Profilgrundgerüst v0.1

Stand: 2. August 2026

Status: verbindlicher technischer Vertrag für das mit v0.90.0-beta veröffentlichte M6-Fundament; nicht zur produktiven Aktivierung freigegeben

Produktgrenze: Das Installationsmerkmal `personnelLifecycle` bleibt standardmäßig deaktiviert. M6 erzeugt weder Onboarding-, Schulungs- oder Offboarding-Prozesse noch Aufgaben, Fristen, Benachrichtigungen oder Eskalationen.

## 1. Umfang

M6 erweitert den vorhandenen verschlüsselten Personalakt. Es entsteht kein zweites Dokumenten- oder Mitarbeitersystem.

- `employees` bleibt die Identität des Mitarbeiters.
- `personnel_record_documents` bleibt der Dokumentstamm und zeigt auf die jeweils aktuelle Version.
- Der bestehende geschützte Dateispeicher bleibt die einzige Binärablage.
- Additive Sidecars führen Kategorien, unveränderbare Versionen und eine append-only, belegverkettete Historie.
- Das Mitarbeiterprofil wird als Unteransicht der vorhandenen Personalverwaltung angelegt. Es besitzt sieben getrennte Tabs, lädt in diesem Fundament aber ausschließlich die freigegebene Übersichtsprojektion.

Der bestehende Stammdaten-Dialog und der bestehende Personalakt bleiben eigenständige, weiterhin nutzbare Integrationspunkte. Sie werden nicht in eine parallele Profilimplementierung kopiert.

## 2. Dokumentinvarianten

1. Jedes neue oder sicher nachklassifizierte Mitarbeiterdokument besitzt eine Kategorie und zunächst ausschließlich die Sichtbarkeit `hr_confidential`.
2. Vertrauliche Dateinamen, fachliche Metadaten, MIME-Typ, Größe und Inhalts-Hash bleiben in der bestehenden geschützten Metadatenhülle. Speicherpfade und Hashwerte werden nie durch die Fach-API ausgegeben.
3. Eine neue Datei zu einem Dokument erzeugt eine lückenlos nummerierte, unveränderbare Version. Die bisherige Version und ihr verschlüsselter Blob bleiben erhalten.
4. Dokumentereignisse sind append-only, lückenlos nummeriert und über den vorherigen SHA-256-Beleg verkettet. Archivierungsakteur und -zeit sind technisch an das terminale Archivereignis gebunden.
5. Archivierung und Aufbewahrungsprüfung behalten alle Versionen im geschützten Speicher, in Sicherungen und in der Importprüfung. Ein Dokument in Aufbewahrungsprüfung bleibt in der berechtigten Personalakt-Liste sichtbar.
6. M6 bietet keine physische Löschung, Anonymisierung, automatische Bereinigung oder Crypto-Shredding-Funktion. Eine solche Mutation bleibt bis zur schriftlichen Aufbewahrungsentscheidung technisch gesperrt.
7. Vorschau beziehungsweise Download, Versionsanlage, Historienabruf, Archivierung und Aufbewahrungsprüfung werden serverseitig geprüft und auditiert.

## 3. Rechte- und Sichtbarkeitsvertrag

M6 erweitert die fachlichen Rechte in diesem Fundament nicht implizit:

- Dokumentzugriff benötigt weiterhin die vorhandene serverseitige Personalakt-Bereichsprüfung und das wirksame Feldrecht `documents`.
- Neue Dokumentmutationen benötigen das bestehende Schreibrecht für `documents` und CSRF-Schutz.
- Die einzige freigegebene Sichtbarkeit ist vorerst `hr_confidential`. Weitere Sichtbarkeiten werden erst mit einem eigenen, durch PL+ freigegebenen Profil- und Dokumentrechtevertrag aktiviert.
- Die Profilübersicht ist ausschließlich für einen persönlichen PL-Zugang (`hr`) mit `personnel:central:read` beziehungsweise den lokalen Systemzugang freigegeben.
- IT-Admin, Developer, FL, AL, Standortplanung, Organisationskonten und Mitarbeiter-Self-Service erhalten aus diesem Fundament keinen Profilzugriff.
- Fehlende Capabilities gelten als `false`. Die Oberfläche entscheidet keine Feld-, Tab- oder Bereichsberechtigung selbst.

Diese enge Zwischenstufe verhindert, dass breite technische oder bestehende Listenrechte unbeabsichtigt vertrauliche Profildaten freischalten. Bereichsbezogene Profilrechte für FL und AL bleiben ein eigener späterer Schutzvertrag.

## 4. SQLite-Migration

Der Marker lautet `v0.90-personnel-document-history`. Die additive Migration:

1. prüft die M6-Tabellen, die vier Root-Spalten einschließlich Typaffinität, Pflichtwert und Default, Schutztrigger, Revisionen, Versionsfolgen und Ereignisketten,
2. erzeugt vor einer notwendigen Änderung einer vorhandenen Datenbank einen internen Pre-Migration-Sicherungspunkt,
3. legt `personnel_document_categories`, `personnel_record_document_versions` und `personnel_record_document_events` an,
4. übernimmt vorhandene nicht physisch bereinigte Personalakt-Dokumente ohne Blobkopie als Version 1; ein früher fachlich gelöschtes Legacy-Dokument wird dabei erst vollständig versioniert und danach mit erhaltenem Akteur und Zeitpunkt archiviert,
5. klassifiziert sie konservativ als `hr_confidential` und lässt die Aufbewahrung auf `manual_review` ohne erfundene Frist,
6. erzeugt einen unveränderbaren Registrierungsbeleg und
7. schreibt den Migrationsmarker erst nach vollständiger Integritätsprüfung.

Bereits physisch bereinigte Legacy-Zeilen werden nicht reaktiviert. Nach dem Backfill können neue Versionen ausschließlich für aktive Dokumente entstehen. Ein partielles oder manipuliertes M6-Schema mit Fachdaten wird nicht automatisch neu aufgebaut; Start beziehungsweise Read-only-Import brechen fail-closed ab.

## 5. API-Änderungen

Die bestehenden Personalakt-Endpunkte bleiben die Integrationsgrenze. M6 ergänzt beziehungsweise schärft sie:

- `POST /api/portal/v1/personnel-records/:employeeNumber/documents` legt Dokument, Version 1 und Registrierungsereignis atomar an.
- `POST /api/portal/v1/personnel-records/:employeeNumber/documents/:documentId/versions` legt eine neue aktuelle Version an.
- `GET /api/portal/v1/personnel-records/:employeeNumber/documents/:documentId/history` liefert ausschließlich freigegebene Versions- und Ereignismetadaten.
- `GET /api/portal/v1/personnel-records/:employeeNumber/documents/:documentId/versions/:versionNumber/content` öffnet eine ausdrücklich gewählte historische Version.
- `POST /api/portal/v1/personnel-records/:employeeNumber/documents/:documentId/retention-review` merkt das Dokument für die Aufbewahrungsprüfung vor.
- Der bestehende `DELETE`-Endpunkt führt ab M6 ausschließlich eine fachliche Archivierung aus; er entfernt keinen Blob und keine Historie.
- `GET /api/portal/v1/personnel-lifecycle/employees/:employeeNumber/profile?tab=overview` liefert eine positive Übersichtsprojektion ohne Personalakt, Dokumente, AUM, Workflows, Auditdaten oder technische Rechte.

Unbekannte Profil-Tabs bleiben geschlossen. Onboarding, Schulungen und Offboarding zeigen nur neutrale Leerzustände und erzeugen keine weiteren API-Aufrufe.

## 6. Mitarbeiterprofil-Grundgerüst

Das Profil liegt innerhalb `Personalverwaltung → Mitarbeitende` und enthält:

- Übersicht,
- Stammdaten und Organisation,
- Personalakte und Dokumente,
- Onboarding,
- Schulungen,
- Offboarding,
- Historie.

Nur die Übersicht ist in diesem Fundament aktiv. Sie enthält ausschließlich Personalnummer, Anzeigename, Aktivstatus sowie freigegebene Organisationsbezeichnungen für Position, Kostenstelle, Standort und Abteilung. Private Kontakte, Adresse, Geburtsdaten, SV-Nummer, Bankdaten, Beschäftigungsnotizen, Personalakt, AUM, Rollen, Rechte, Dokumente und Prozessdaten sind ausdrücklich ausgeschlossen.

## 7. Bewusste Abgrenzung

Nicht Bestandteil von M6 sind:

- automatische oder manuelle Bewerberdokument-Übernahme,
- Mitarbeiter-Self-Service,
- neue delegierbare Profil- oder Dokumentrechte,
- Onboarding-, Schulungs- oder Offboarding-Instanzen,
- vertrauliche Workflow-Schritte,
- Verantwortlichen-, Vertretungs-, Frist-, Erinnerungs- oder Eskalationslogik,
- E-Mail-, SMS- oder WhatsApp-Versand,
- grafischer Workflow-Editor und
- produktive PostgreSQL-Freigabe.

## 8. Offene Architekturentscheidungen

Vor einer Erweiterung bleiben schriftlich zu entscheiden:

- Rechtsgrundlage, Frist und Ergebnis je Dokumentkategorie,
- Sichtbarkeitsklassen und eigene aktionsbezogene Profil-/Dokumentrechte einschließlich PL+-Delegation für FL und AL,
- Regeln für ausdrücklich ausgewählte Bewerberdokument-Übernahmen,
- Klassifikation vertraulicher Profil-, Onboarding- und Offboarding-Daten,
- Mitarbeiter-Self-Service und Dokumenteinsicht sowie
- Grenze zwischen internem Schulungsnachweis und externer Lernplattform.

Offene Entscheidungen erzeugen keine produktiven Standardwerte. Die jeweilige Mutation bleibt bis zur Freigabe gesperrt.

## 9. Abnahme

M6 benötigt mindestens:

- frische, additive und idempotente Migrationstests einschließlich Legacy-Dokumenten,
- Integritätstests für unveränderbare Versionen, lückenlose Belege und Löschschutz,
- vollständige Sicherungs- und Read-only-Importprüfung aller historischen Blobs,
- positive und negative Rechte-, Bereichs-, CSRF- und IDOR-Tests,
- Scanner-, Größen-, Dateityp-, Manipulations- und Rollbacktests,
- Positivlisten-Tests der Profilprojektion,
- UI- und Mobiltests für Tabnavigation, Überlauf, Fokus und sichere Leerzustände sowie
- Regressionstests für Personalakt, Portal, Dienstplan und M4/M5.
