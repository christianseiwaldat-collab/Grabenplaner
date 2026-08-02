# Personalmodul – Mitarbeiterprofil-Projektionen M7 v0.1

Stand: 2. August 2026

Status: verbindlicher technischer Vertrag für den mit v0.90.0-beta veröffentlichten M7-Stand; abhängig von M6 und nicht zur produktiven Aktivierung freigegeben

Produktgrenze: Das Installationsmerkmal `personnelLifecycle` bleibt standardmäßig deaktiviert. M7 führt ausschließlich lesende Profilprojektionen ein und erzeugt weder Prozesse noch Aufgaben, Fristen, Benachrichtigungen oder Automatisierungen.

## 1. Umfang

M7 aktiviert im bestehenden Mitarbeiterprofil zwei weitere, getrennt geladene Register:

- `Stammdaten & Organisation` verwendet ausschließlich bereits vorhandene Mitarbeiter- und Personalstammdaten.
- `Personalakte & Dokumente` verwendet ausschließlich die in M6 abgesicherte Dokumentliste und deren geschützten Speicherpfad.

Die M6-Übersicht bleibt die Einstiegsprojektion. Es entsteht weder ein zweiter Mitarbeiterstamm noch eine zweite Personalakte. Alle Register bleiben read-only; bestehende Bearbeitungsdialoge und Dokumentmutationen werden nicht dupliziert.

## 2. Rechte- und Bereichsvertrag

Die Oberfläche leitet keine Berechtigung aus einer sichtbaren Schaltfläche ab. Jeder Registerabruf prüft serverseitig Rolle, persönliche Sitzung, vorhandenes Leserecht, Register-Capability und den Zielbereich.

- Der echte, nicht persistierte lokale Systemzugang bleibt als technische Offline-Grenze ohne fachliche Profilrechte zugelassen. Persönliche PL-Zugänge (`hr`) benötigen für die Übersicht `personnel:profiles:read`, für Stammdaten zusätzlich `personnel:profiles:master:read` und für Dokumente zusätzlich `personnel:profiles:documents:read`; die vorhandenen zentralen und feldbezogenen Schutzrechte bleiben kumulativ erforderlich.
- PL+ ist ein persönlicher PL-Zugang mit dem zusätzlichen, nicht weiterdelegierbaren Recht `personnel:profiles:delegate`. Dieses Recht erlaubt nur die kontrollierte Freigabe lokaler Profilrechte und erzeugt selbst keine Datensicht.
- FL (`manager`) und AL (`department_manager`) benötigen `employees:read`, `personnel:profiles:read`, für das Stammdatenregister zusätzlich `personnel:profiles:master:read`, den jeweils fachrechtgebundenen PL+-Freigabebereich und eine vollständige Übereinstimmung des Mitarbeiters mit diesem Bereich.
- FL darf nur Mitarbeitende eines ausdrücklich freigegebenen Standorts sehen. AL darf nur Mitarbeitende einer ausdrücklich freigegebenen Standort-/Abteilungskombination sehen.
- FL und AL erhalten in M7 ausschließlich die minimale Organisationsprojektion in Übersicht und Stammdatenregister. Private Kontakte, Adresse, Bankdaten, Personalvermerke und Dokumente bleiben geschlossen.
- Organisationskonten, Mitarbeiter-Self-Service, Standortplanung sowie technische Rollen wie Admin, IT-Admin und Developer erhalten durch M7 keinen Mitarbeiterprofilzugriff.
- Die lokal delegierbaren Profilrechte sind ausschließlich `personnel:profiles:read` und `personnel:profiles:master:read`. Das Dokumentrecht wird in M7 nicht an FL oder AL delegiert. Profilrechte, Bewerberrechte, Workflow-Rechte und geschützte technische Rechte bleiben getrennt.
- Admin und Developer dürfen unter der bestehenden technischen Rechtehierarchie den geschützten PL+-Marker verwalten, aber weder die beiden lokalen Profilrechte noch deren Fachscopes freigeben. Die fachliche Bereichsfreigabe bleibt einem persönlichen HR-Zugang mit `personnel:profiles:delegate` vorbehalten und erzeugt für technische Rollen keine Datensicht.

Unbekannte und außerhalb der Schnittmenge aus allgemeinem Portalbereich und rechtsspezifischem PL+-Fachbereich liegende Personalnummern werden am Profilendpunkt wertneutral behandelt. Abgewiesene Zugriffe werden ohne Ausgabe geschützter Inhalte auditiert.

## 3. Positive Projektionen

Jeder Abruf liefert nur die Daten des ausdrücklich angeforderten Registers. Fehlende Capabilities gelten als `false`.

### 3.1 Übersicht

Die M6-Projektion bleibt kompatibel: Personalnummer, Anzeigename, Aktivstatus und freigegebene Organisationsbezeichnungen für Position, Kostenstelle, Standort und Abteilung.

### 3.2 Stammdaten & Organisation

Die Projektion enthält die gemeinsame Profilidentität und eine ausdrücklich definierte `masterData`-Struktur. Für PL beziehungsweise den lokalen Systemzugang werden nur Felder aufgenommen, deren vorhandenes Feldrecht mindestens `read` ist. Für FL und AL bleibt die Struktur auf die freigegebene Organisationszuordnung begrenzt.

Nicht ausgegebene Felder werden nicht durch `null`, Platzhalter oder leere Nebenstrukturen angedeutet. Freie vertrauliche PL-Notizen, Rollen, Rechte, Auditdaten, AUM-Inhalte und Prozessdaten sind ausgeschlossen.

### 3.3 Personalakte & Dokumente

Die Projektion verwendet die sichere M6-Listendarstellung. Sie darf fachliche Listendaten wie Kategorie, Titel, Sichtbarkeit, Dokumentdatum, Status, aktuelle Version, Revision, Dateityp und Größe enthalten. Speicherreferenzen, Verschlüsselungsdaten, Inhalts- oder Beleg-Hashes und interne Akteursdaten werden nicht ausgegeben.

Das Register ist nur verfügbar, wenn das vorhandene wirksame Feldrecht `documents` mindestens `read` erlaubt. M7 ergänzt keine Vorschau-, Download-, Upload-, Versions-, Archivierungs- oder Aufbewahrungsmutation; dafür bleiben die vorhandenen M6-Endpunkte und Schutzprüfungen zuständig.

## 4. API-Änderung

Der vorhandene Endpunkt wird tab-spezifisch erweitert:

`GET /api/portal/v1/personnel-lifecycle/employees/:employeeNumber/profile?tab=<tab>`

Unterstützte Werte:

- `overview`: bestehende M6-Antwort mit `profile`, `tabs` und `capabilities`,
- `master_org`: gemeinsame Profilidentität plus `masterData`, `tabs` und `capabilities`,
- `documents`: gemeinsame Profilidentität plus sichere `documents`-Liste, `tabs` und `capabilities`.

Unbekannte oder nicht verfügbare Register bleiben fail-closed. Ein Übersichtsabruf lädt weder Stammdaten noch Dokumente mit.

Die bestehende, bereits serverseitig bereichsgefilterte Mitarbeitendenliste ergänzt pro Zeile ausschließlich `personnel_profile_access: { available: boolean }`. Sie liefert weder Profil-Capabilities noch zusätzliche Fachbereiche. Die zentrale Personalverzeichnisroute bleibt zentral geschützt.

## 5. Oberfläche

Das Mitarbeiterprofil bleibt in die vorhandene Mitarbeitendenansicht eingebettet.

- Beim Öffnen wird ausschließlich `overview` geladen.
- `master_org` und `documents` werden erst beim tatsächlichen Registerwechsel geladen.
- Register werden nur anhand der serverseitigen `tabs`- und `capabilities`-Antwort aktiviert.
- Vertrauliche Registerdaten werden beim Wechsel, bei einem Fehler, beim Schließen sowie bei Profil-, Dokument- oder einzelnen Feldrechteentzügen sowohl aus dem DOM als auch aus dem JavaScript-Zustand entfernt; laufende Antworten werden dabei ungültig.
- Gesperrte Register zeigen einen neutralen Leerzustand und lösen keinen Fachabruf aus.
- Die Darstellung verwendet ausschließlich feste Feld- und Dokument-Positivlisten; unbekannte Antwortfelder werden ignoriert.

Ein lokaler Leitungszugang darf keine unternehmensweite Personalverzeichnisquelle erhalten. Ein UI-Einstieg für FL beziehungsweise AL muss daher aus einer bereits serverseitig bereichsgefilterten Mitarbeitendenquelle erfolgen.

## 6. Datenbankmigrationen

M7 benötigt keine neue Fachtabelle, Spalte und keinen neuen Binärspeicher. Die additive Startmigration `v0.90-personnel-profile-scoped-rights` erweitert jedoch den vorhandenen Fachscope-Träger `portal_permission_scope_grants` um die zwei lokal zulässigen Profilrechte. Vor einer erforderlichen Änderung entsteht der vorhandene Pre-Migration-Sicherungspunkt; bestehende Bewerbungs- und Workflow-Fachscopes bleiben unverändert erhalten. Start, Read-only-Import und Maintenance erkennen ausschließlich die exakten R1-/M4-Vorgängerschemata als migrationsfähig. Partielle, unbekannte oder semantisch inkonsistente Strukturen bleiben fail-closed.

## 7. Bewusste Abgrenzung

Nicht Bestandteil von M7 sind:

- Schreib- oder Schnellaktionen im Profil,
- Übernahme von Bewerberdokumenten,
- Mitarbeiter-Self-Service,
- Beschäftigungs- oder Dokumenthistorien als neues Gesamthistorienregister,
- Onboarding, Schulungen und Offboarding,
- Prozessstart, Verantwortliche, Fristen, Erinnerungen und Eskalationen,
- grafischer Workflow-Editor und
- produktive PostgreSQL-Freigabe.

Onboarding und Offboarding bleiben ein eigener großer Folgeblock. Vor technischer Umsetzung wird dafür ein eigenes fachliches und organisatorisches Konzept erstellt und freigegeben.

## 8. Offene Architekturentscheidungen

Vor weiteren Profilblöcken sind mindestens festzulegen:

- eigene Rechte und Freigabewege für Profil- und Dokumentmutationen; die M7-Leserechte und ihre PL+-Bereichsfreigabe gelten nicht automatisch für Schreibaktionen,
- Sichtbarkeitsklassen jenseits von `hr_confidential`,
- Aufbewahrungsfristen und Ergebnisse je Dokumentkategorie,
- Regeln für eine ausdrücklich ausgewählte Bewerberdokument-Übernahme,
- Trennung von Stammdaten, Beschäftigung & PL sowie der späteren Gesamthistorie,
- Klassifikation vertraulicher Onboarding- und Offboarding-Schritte und
- Grenze zwischen internem Schulungsnachweis und externer Lernplattform.

Offene Entscheidungen erzeugen keine produktiven Standardwerte.

## 9. Abnahme

M7 benötigt mindestens:

- positive und negative Rollen-, Feldrechte-, Bereichs- und IDOR-Tests,
- Positivlisten-Tests für beide neuen Register,
- Nachweis, dass Übersicht und gesperrte Register keine Nebenabrufe auslösen,
- UI-Tests für Lazy Loading, Wechsel, Fehler, Schließen und Zustandsbereinigung,
- Mobil- und Tastaturtests für Register, Fokus und horizontalen Überlauf sowie
- Regressionstests für M6-Dokumente, Personalakt, Bewerbungen und M4/M5.
