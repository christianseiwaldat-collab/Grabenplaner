# Integrationsvertrag

Integrationen werden durch berechtigte Personen geprüft und ausdrücklich ausgelöst.
Access-DB-Importe verwenden eine kontrollierte Vorschau, Feldzuordnung, Bereichsprüfung und nachvollziehbare Übernahme.
Dateifingerabdruck, Profil und Tabellenplan binden eine Wiederaufnahme an denselben Quelldatenstand.

SQL-Personalimporte lesen ausschließlich eine freigegebene datensparsame View mit SELECT-Recht und Spalten-Allowlist.
Freie SQL-Befehle, Schreibzugriffe und sensible fachfremde Spalten sind ausgeschlossen.
SQL-Verbindungen prüfen Zertifikatskette und Servername; gespeicherte Profile ersetzen keine erneute Vorschau und Bestätigung.

HTTPS-Übergaben verwenden versionierte Verträge, geprüfte finalisierte Daten und stabile Idempotenzkennungen.
Der Transport verlangt TLS 1.2+, prüft alle DNS-Ziele und den ursprünglichen Zertifikatsnamen, pinnt die freigegebene Zieladresse,
lehnt private/reservierte Netze und Redirects ab und begrenzt Zeit, Größe und zugelassene Header.
Unklarer Versand wird ausdrücklich ausgewiesen und nicht automatisch als Fehlversuch wiederholt.
Verbindungstests prüfen ausschließlich Netzwerk und TLS; sie versenden keine fachlichen Daten.

`grabenplaner.personnel-view.v1`, `grabenplaner.payroll.v1` und `grabenplaner.payroll-period.v2` bleiben versionierte Schnittstellenverträge.
Monatsübergaben enthalten nur notwendige Personalnummern, finalisierte Ist-Nachweise, Revisionen, Hashes und Arbeits-/Pausenminuten.
Planzeit wird niemals als Ist-Zeit übergeben. Ohne zugeordnetes externes Protokoll gilt die Übergabe nicht als abgeschlossen.
Es besteht keine direkte ELDA-Schnittstelle; Entgelt und Sozialversicherungsbeiträge werden nicht berechnet.

Technische Konfiguration erfordert globale Bereichsrechte; fachliche Freigaben, Zugangsdatenverwaltung und Übertragung besitzen getrennte Rechte.
Geheimnisse werden verschlüsselt gespeichert und weder angezeigt noch in öffentliche Antworten oder Laufprotokolle aufgenommen.
Server-Schlüssel kommen aus der geschützten Dienstumgebung. Schlüsselrotation bewahrt benötigte frühere Schlüssel.
[Betriebs- und Recovery-Vertrag](SERVERBETRIEB.md) und [Sicherheit](SECURITY.md) gelten auch für Integrationen.
