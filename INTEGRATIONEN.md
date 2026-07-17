# Direkte Integrationen

Grabenplaner v0.69 ergänzt die vorhandenen CSV-/XLSX-Abläufe um zwei bewusst eng begrenzte, manuell ausgelöste Verbindungsarten:

- Personalstammdaten aus einer freigegebenen Microsoft-SQL-Server-View lesen
- final geprüfte Lohnwerte an eine dokumentierte HTTPS-JSON-API übergeben

Es gibt keine automatische Synchronisation. Jede Übernahme beziehungsweise Übergabe wird durch eine berechtigte Person ausgelöst und bleibt nachvollziehbar.

## Versionierte Schnittstellenverträge

Jede direkte Verbindung ist fest an einen maschinenlesbaren Vertrag gebunden. Die Vertragsübersicht in den Einstellungen zeigt Version, Richtung, Transport und SHA-256-Prüfsumme; das vollständige JSON-Dokument kann für Prüfung und Ablage durch die Firmen-IT heruntergeladen werden.

- `grabenplaner.personnel-view.v1` beschreibt den schreibgeschützten Eingang notwendiger Personalstammdaten.
- `grabenplaner.payroll.v1` beschreibt die minimierte, idempotente HTTPS-JSON-Übergabe final geprüfter Lohnwerte.

Der Vertrag kann nicht durch freie Eingaben auf einen fachfremden Datenweg umgestellt werden. Eine spätere Vertragsänderung erhält eine neue Version und muss bewusst in Grabenplaner implementiert und geprüft werden.

## Microsoft SQL Server

Die Firmen-IT stellt eine eigene, datensparsame View bereit. Der verwendete Datenbankbenutzer erhält ausschließlich `SELECT` auf genau diese View. In der Verbindung wird zusätzlich eine ausdrückliche Freigabeliste der tatsächlich benötigten Spalten hinterlegt. Die SQL-Verbindung ist verschlüsselt und prüft die Zertifikatskette sowie den Servernamen vollständig; interne Zertifizierungsstellen können über den Node-Vertrauensspeicher bereitgestellt werden. Grabenplaner akzeptiert keine frei eingegebenen SQL-Befehle, Tabellen, gespeicherten Prozeduren oder Schreibzugriffe.

Die View und die Spalten-Freigabeliste sollen nur benötigte Personalstammdaten enthalten, beispielsweise Personalnummer, Name, Anzeigename, Sollstunden sowie freigegebene Standort-, Abteilungs- und Positionskennungen. SV-Nummer, Bankverbindung, Anschrift, Telefonnummer, Passwörter, AUM- oder andere Personalaktdaten dürfen nicht enthalten sein. Entsprechend benannte sensible Spalten werden vor dem Lesen abgewiesen.

Nach dem Lesen gelten dieselben Schutzschritte wie beim Dateiimport: befristete Vorschau im Arbeitsspeicher, frei prüfbare Feldzuordnung, Dublettenbehandlung, Bereichsprüfung und ausdrückliche atomare Übernahme.

Ein gespeichertes SQL-Importprofil merkt sich Feldzuordnung, Standardwerte, Dublettenregel und die konkrete SQL-Personalquelle. Beim erneuten Verwenden wird die View trotzdem neu gelesen, als Vorschau dargestellt und erst nach Bestätigung übernommen. Ein Profil kann nicht still mit einer anderen Quelle ausgeführt werden.

## HTTPS-Lohnziel

Das Zielsystem muss einen dokumentierten HTTPS-POST-Endpunkt bereitstellen. Grabenplaner überträgt ausschließlich final geprüfte Daten ohne offene Blocker. Namen werden in der direkten Übergabe standardmäßig entfernt; Personalakt-, Bank-, Adress-, SV-, Telefon- und AUM-Daten sind nicht Bestandteil des Schemas.

Die Nutzdaten verwenden das versionierte Schema `grabenplaner.payroll.v1`. Eine stabile Idempotenzkennung verhindert unbeabsichtigte Doppelübergaben. Bei einem Verbindungsabbruch nach möglichem Versand wird der Status als unklar gekennzeichnet und nicht still als fehlgeschlagen wiederholt.

Der Transport erlaubt ausschließlich HTTPS, prüft alle DNS-Ergebnisse gegen private und reservierte Netze, pinnt die geprüfte Zieladresse für die TLS-Verbindung, behält die Zertifikatsprüfung des ursprünglichen Hostnamens bei und lehnt Redirects ab. TLS 1.2+, feste Zeit- und Größenlimits sowie eine Header-Allowlist sind verpflichtend.

Der technische Verbindungstest führt ausschließlich eine DNS-, Netzwerk- und TLS-Prüfung durch. Er sendet weder einen fachlichen HTTP-Aufruf noch Test- oder Lohndaten an das Zielsystem.

## Rechte

- `Direkte Verbindungen lesen`: öffentliche Konfiguration und Status sehen
- `Direkte Verbindungen konfigurieren`: SQL-Quellen und API-Ziele verwalten
- `Zugangsdaten direkter Verbindungen ersetzen`: neue Geheimnisse setzen; vorhandene Werte werden nie angezeigt
- `Personalstammdaten importieren`: SQL- oder Dateiimport prüfen und übernehmen
- `Lohnverrechnungsdaten sicher übertragen`: final geprüfte Daten fachlich übergeben

Standardmäßig konfigurieren Developer und IT-Admin die technischen Verbindungen und Zugangsdaten. Admin und Personalleitung können die öffentliche Konfiguration sehen und fachlich freigegebene Lohnwerte übergeben. Personenbezogene Zusatzrechte bleiben möglich, sollten aber sparsam vergeben werden.

Die technische Verbindungsverwaltung und der direkte SQL-Import setzen zusätzlich einen globalen Unternehmensbereich voraus. Standort- oder abteilungsbeschränkte Zugänge erhalten dadurch auch mit versehentlich delegierten Einzelrechten keinen Einblick in fremde Verbindungskonfigurationen oder View-Vorschauen.

## Schlüssel im HTTPS-Serverbetrieb

Im lokalen Betrieb entsteht ein geschützter Schlüssel im privaten Datenverzeichnis. Im HTTPS-Serverbetrieb werden Schlüssel ausschließlich über die Dienstumgebung bereitgestellt:

- `GRABENPLANER_INTEGRATION_KEY_ID`: Kennung des aktiven Schlüssels
- `GRABENPLANER_INTEGRATION_KEY`: aktiver 32-Byte-Schlüssel als Base64 oder 64-stelliges Hex
- `GRABENPLANER_INTEGRATION_KEYS`: optionales JSON-Objekt mit aktivem und früheren Schlüsseln für eine kontrollierte Rotation

Geheimnisse, vollständige Payloads, Personalzeilen und Antwortinhalte werden weder in öffentliche API-Antworten noch in Audit- oder Laufprotokolle geschrieben. Datenbank, privater Schlüsselbereich und Backups benötigen weiterhin restriktive Betriebssystemrechte.
