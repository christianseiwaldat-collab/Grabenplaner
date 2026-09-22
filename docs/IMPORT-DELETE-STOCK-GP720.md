# Importlöschung, Filialbestand und nächtliche Wartung

Stand: 22.09.2026. Implementierung im Arbeitszweig; keine produktive Bereitstellung und keine Löschung produktiver Quellen.

## Nicht übernommene Datenquellen löschen

Unter „Vorhandene Datenquellen“ bietet die Detailansicht eine endgültige Löschung mit Vorschau und ausdrücklicher Bestätigung. Sie entfernt die vorbereiteten Importzeilen, deren Protokolle, unbenutzte gemeinsame Datenblöcke, den Quelleintrag und eine gegebenenfalls verbliebene verschlüsselte Upload-Datei samt Kennwortumschlag. Ein technischer Löschvermerk ohne Quellinhalte bleibt erhalten. Bestehende Sicherungen behalten ihre eigene Aufbewahrung.

Serverseitig erforderlich sind persönliche Gesamtimport-Lese- und Vorbereitungsrechte, Eigentümerschaft, CSRF-Schutz und die aktuelle Revision. Laufende Jobs blockieren die Aktion. Schon teilweise übernommene oder zurückgenommene Quellen, abhängige produktive Verweise und jemals freigegebene Kassenstände sind gesperrt. Eine ältere Quelle ist nicht allein aufgrund ihres Alters löschbar.

Der verschlüsselte Löschauftrag wird zuerst in Core gespeichert. Sales entfernt anschließend höchstens 2.000 Zeilen je Schritt. Core schreibt danach den Fortschritt. Fehlende bereits entfernte Läufe und verlorene Fortschrittsmeldungen sind wiederaufnehmbar; die Anwendung verlangt keine Transaktion mit zwei Datenbank-Schreibern. Abschluss und technischer Löschvermerk werden gemeinsam in Core gespeichert. Die alte allgemeine Engine-Purge-Funktion bleibt geschlossen.

Eine additive Sales-Migration ergänzt drei Indizes und erlaubt die Entfernung ausschließlich unreferenzierter Datenblöcke. Updates dieser Blöcke bleiben unveränderlich geschützt. Die Migration prüft Ausgangsschema, Rollen und Fingerabdruck, arbeitet atomar und ist wiederholbar. Der Release-Updater führt sie unter seiner Wartungssperre nach einer frischen Paarsicherung aus. Das Core-Schema bleibt unverändert.

## Filialbestand und Warenwert

„Einkauf & Bestand“ erhält „Filialbestand & Warenwert“. Eine Filiale muss ausdrücklich gewählt werden; verfügbar sind berechtigte Trade-Quellfilialen, auch wenn noch keine GP-Standortbindung besteht. Ungebundene Filialen verlangen unternehmensweite Rechte plus das Recht auf unzugeordnete Daten.

Die Auswertung verwendet den letzten vollständig übernommenen ARTIKEL_FILIALEN-Stand und den übernommenen Artikelstamm. Sie zeigt Datenstand, bestätigte Lagermenge, Nettowarenwert insgesamt und nach Sortiment. Bewertung: positiver Bestand × DurchschnittEK; exakte Dezimalrechnung, Anzeige in EUR. Das ist eine operative Näherung, keine Inventurbewertung. Mengen können unterschiedliche Einheiten enthalten.

Sachkonten, OhneBestand und bestätigte Dienstleistungen werden ausgeschlossen, unabhängig von ihrem Einkaufspreis. Ein EK von null beweist keine Dienstleistung. Ungeklärte Artikelarten erscheinen getrennt und zählen nicht zur bestätigten Lagermenge; ihr positiver EK kann im ausdrücklich vorläufigen Wert enthalten sein. Fehlende Artikel, doppelte Bestandszuordnungen, negative Mengen und ungültige Preise werden sichtbar, nicht stillschweigend bewertet. Ohne Kostenrecht bleiben alle Preis- und Wertfelder verborgen.

Alle Quellpositionen werden in fortsetzbaren Seiten authentifiziert. Teilwerte heißen ausdrücklich Teilwerte; ein verschlüsselter Cursor bindet Ergebnis, Datenrevision, Klassifikation, Filter und Benutzerrechte. Ein Daten- oder Rechtewechsel verwirft die Fortsetzung. Indexzugriffe nach Artikel/Filiale und gebündelte Leser vermeiden die zuvor beobachteten wiederholten Vollscans. Eine produktive Laufzeitmessung nach Installation der neuen Indizes steht noch aus.

## Befund zur Datenbankgröße

Die aktuelle Nur-Lese-Prüfung ergab Core 208.484.031 Bytes und Sales 11.578.341.055 Bytes: zusammen rund 10,98 GiB. Größte Einzelbereiche waren Importzeilen (2,68 GiB), Importverknüpfungen (1,20 GiB), ein Kassen-Detailtabellentyp (1,09 GiB), Änderungsnachweise (0,86 GiB), Historienversionen (0,84 GiB) und Historiensegmente (0,80 GiB). Nummerierte Kassen-Snapshot-Tabellen sind verschiedene Tabellentypen und nicht automatisch redundante Datenbankkopien.

Neben übernommenen Ständen existieren ältere vorbereitete Quellen. Deren tatsächliches Einsparpotenzial hängt von der Auswahl und gemeinsam genutzten Blöcken ab; eine belastbare GiB-Zahl wurde nicht vorweggenommen. PostgreSQL macht gelöschten Platz durch VACUUM wiederverwendbar. Eine sofort kleinere Datei erfordert gegebenenfalls separat geplante Tabellenkompaktierung mit Sperrzeit und zusätzlichem Platz. Es wurde weder gelöscht noch VACUUM FULL ausgeführt.

Referenz: https://www.postgresql.org/docs/current/routine-vacuuming.html

## Vorhandene und neue Datenquellen

Der aktuelle GP-Stand vom 14.09.2026 umfasst 233.197 Filialbestandspositionen, 19.328 Artikel und 231 Sortimente. Alle Artikel haben eine Sortimentszuordnung. 554 Artikel tragen Sachkonto/OhneBestand-Ausschlussmerkmale; 18.900 haben einen positiven DurchschnittEK, 416 einen Nullpreis und zwölf keinen Preis. Diese globalen Stammdatenzahlen sind keine Bestandsmengen einer konkreten Filiale.

Für die neue Ansicht reichen die vorhandenen Daten. Der aktuelle Bericht aus „Trade-Datenbanken analysieren“ vom 22.09.2026 erschließt zusätzlich WEUM-Bewegungen, ein separates InventurProtokoll und historische Artikelreferenzen. WEUM enthält 87.564 Wareneingänge und 53.520 Umlagerungen; das InventurProtokoll enthält 464 Köpfe und 332.675 Details. Diese Quellen sind für Bewegungs- und Inventurhistorie wertvoll, wurden durch diese Aufgabe aber nicht importiert. Das ältere leere Inventur.accdb ist eine andere Quelle.

## Nächtliche Recovery Assurance

Belegt: Am 22.09. startete automatische Paketwartung PostgreSQL um 03:06:51 während der Vorbereitung neu. PostgreSQL meldete 57P01; der Lauf endete mit PREPARE_FAILED nach rund acht Minuten. Ein späterer manueller Gesamtlauf von 08:37 bis 09:27 war erfolgreich. Ein konfiguriertes Acht-Minuten-Limit ist nicht die Ursache.

GP719 enthält einen separat geprüften, reversiblen Installationshelfer, der APT mit der GP-Wartungssperre koordiniert. Dieser wurde bislang nur geprüft, nicht auf dem produktiven Host aktiviert. Die konkrete Restart-Kollision ist damit produktiv noch nicht behoben.

Weitere geprüfte Risiken:

- Systemprüfung und Restore-Timer sind hinter Assurance angeordnet und geschützt; gleichzeitig terminierte Timer bedeuten hier keine mehrfachen vollständigen Sicherungen.
- Die Anzeige von 14 täglichen Punkten ist die Aufbewahrung, nicht 14 tägliche Uploads. Manuelle Prüfungen und freigegebene Änderungen können zusätzliche Sicherungen erzeugen.
- Lange andere Wartungen oder externe Repository-Sperren können begrenzte Sperrwartezeiten überschreiten. Netzwerk, Google-Quota oder widerrufene OAuth-Berechtigungen bleiben mögliche Uploadfehler; kein solcher aktueller Fehler wurde nachgewiesen.
- Rund 68 GB freier VPS-Speicher; seit dem 20.09. kein belegter OOM-, I/O- oder Platzmangelfehler. Kumulierte temporäre PostgreSQL-Schreibmengen sind kein aktuell belegter Speicherverbrauch.
- Die Restore-Platzprüfung verwendet teilweise eine feste Mindestreserve statt der entpackten Gesamtgröße beider Datenbanken. Bei künftig knapper Platte ist das eine offene Härtung; es erklärt den vorliegenden Abbruch nicht. Sie wurde in dieser Änderung nicht umgebaut.

## Nachweise

SQLite-/API-/UI-Tests prüfen exakte Summen, Dienstleistungsausschlüsse, Rechte, Cursorwechsel, gemeinsame Blöcke, Teilübernahmen, veröffentlichte Kassenstände und Wiederaufnahme nach verlorenen Checkpoints. Native PostgreSQL-Tests laufen in einem eigenen Cluster auf Loopback-Port 55472 mit synthetischen Daten; Produktion auf Port 5432 bleibt unverändert. Die separate Testinstanz wird nach Abschluss angehalten.

Die Browser-Funktionsvorschau verwendet ausschließlich synthetische Daten. Helles und dunkles Desktop-Layout wurden visuell geprüft. Die mobile Screenshotprüfung war durch einen Browser-Capture-Timeout eingeschränkt.

Technische Diagnosebelege liegen außerhalb des Repositories unter `output/analysis/gp720-stock-and-nightly`; der ursprüngliche System-Center-Bericht und die PDF-/Markdown-Prüfberichte unter `output/analysis/gp719-system-center`.

Abschließende Prüfung: 103 lokale Funktions-/API-/UI-Tests bestanden; vier native PostgreSQL-/Linux-Updater-Tests bestanden, einschließlich Trade- und Kassenlöschung. Zusätzlich bestanden die gezielten Backup-/Betriebsprüfungen (der auf Windows ausgelassene POSIX-Updater-Test wurde unter Linux bestanden). Bash- und JavaScript-Syntax sowie `git diff --check` sind sauber. Die isolierte PostgreSQL-Testinstanz wurde kontrolliert angehalten. Produktive Löschungen, Schemaänderungen und APT-Aktivierung wurden nicht ausgeführt.
