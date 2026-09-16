# v0.92.54 Beta · Schnellere Datenbankimporte

## Änderung

Der Import bündelt PostgreSQL-Lese- und Schreibzugriffe für Trade-, Bestell-
und Kassendaten. Authentifizierte Referenzen werden innerhalb derselben
Transaktion wiederverwendet. Neue Ziele werden in begrenzten Paketen gespeichert,
aus der Datenbank zurückgelesen und erneut authentifiziert. Rücknahmebelege,
Konflikterkennung, Berechtigungsprüfung und gespeicherte Wiederaufnahme bleiben
erhalten. Es gibt keine neue Migration und keine zusätzliche Abhängigkeit.

Die [Analyse und Messungen](IMPORT-OPTIMIERUNG-2026-09-15.md) dokumentieren
die Ursachen, vollständige lokale Dateiimporte und die noch offene Verbesserung
für Tabellen ohne stabile Quellschlüssel. Die angestrebten ungefähr 30 Minuten
pro Datenbank auf dem VPS sind damit noch nicht nachgewiesen.

## Erneute Freigabeprüfung am 16.09.2026

- Gesamtlauf des aktuellen Testverzeichnisses mit Node 24.19.0:
  3.621 Prüfungen, davon 3.502 bestanden, 27 fehlgeschlagen und 92 übersprungen.
  Vier veraltete Test-Dummys wurden anschließend ergänzt und erfolgreich erneut
  geprüft. Die übrigen 23 Fehler wurden in einem separaten Checkout des
  unveränderten Ausgangscommits `40caa8f` reproduziert. Sie betreffen vorhandene
  Personalrechts-, Schema-, Dokumentations- und historische Inventarprüfungen;
  der Gesamtlauf ist deshalb ausdrücklich nicht vollständig grün.
- Abschließende gezielte Prüfung mit Node 22.22.1: 83 bestanden, kein Fehler,
  eine Linux-Prüfung auf Windows erwartungsgemäß übersprungen. Die Ergänzungen
  an vier Test-Dummys betreffen den vorhandenen Import-Dienststopp, den
  Datenbankmodus und die Verbindungsprüfung. Der betreffende Anwendungscode
  wurde nicht geändert.
- Fünf native PostgreSQL-Prüfungen mit Node 22.22.1 und PostgreSQL 18.6:
  alle bestanden, keine übersprungene Prüfung. Darunter 30.567 Zeilen in
  153 begrenzten Wiederprüfungspaketen; maximale Paketdauer im letzten Lauf
  45 ms, im vorherigen Lauf unter paralleler Testlast 2.451 ms. Geprüft wurden
  außerdem Wiederaufnahme, Dubletten, manipulierte Verschlüsselung, atomare
  Rücknahme sowie der tatsächlich produktiv verwendete verzögerte Provider.
- Die Architekturprüfung registriert die neuen Paketdateien ausdrücklich.
  Ihre verbleibenden zwei historischen Katalogfehler stimmen exakt mit dem
  Ausgangsstand überein; es bleibt kein zusätzlicher Architekturfehler.
- Die VPS-Vorprüfung bestätigte sämtliche 718 Dateien der installierten v53,
  vier erfolgreiche Live-/Ready-Prüfungen, unveränderte Dienste sowie einen
  erfolgreichen vollständigen Wiederherstellungsnachweis von heute Nacht.

## Veröffentlichungsstand

Die Veröffentlichung ist vorbereitet. Commit, Paketprüfung und produktive
Abschlussnachweise werden nach dem tatsächlichen Ablauf ergänzt.
