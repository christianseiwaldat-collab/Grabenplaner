# Einmaliger Direktimport vom 15.09.2026

Der Benutzer hat die beiden weiteren Dateien aus
`Grabenplaner-Offsite/Datenbanken` zur nacheinander erfolgenden Übernahme
freigegeben. Er ist heute nicht mehr am PC; der Transfer soll am Server
erfolgen. Der bestehende Trade-Auftrag läuft bereits.

## Bestelldatenbank

`Trade_DatenBestell.accdb` wurde über die vorhandene Drive-Anbindung abgerufen
und über deren kurzlebigen Dateiabruf direkt am VPS übernommen. Die 136.056.832
Bytes wurden nur im Arbeitsspeicher verarbeitet und anschließend mit der
vorhandenen Schlüsselverwaltung verschlüsselt abgelegt.

- Drive-Datei: `1Mjx7KYAK1uizCv0cTH_4qbau1ljAdhDk`
- SHA256: `7c752da9beac0dc55e9b731273048b7c4c20b13c2f602f6902b431bd9beb6fa0`
- Bestehender Import: `9e798eafae1558fea649606d8121f6239c051fe92b72a3499ed0a8eecd05347e`
- Einleseprobe: 21 Tabellen, 414.434 deklarierte Zeilen; ohne Dateikennwort lesbar.

Der Hash entspricht exakt dem am 14.09.2026 um 00:53:59 UTC begonnenen,
unterbrochenen Import. Die gespeicherten Pakete können weiterverwendet werden.

Die einmalige Unit `grabenplaner-drive-bestell-20260915.service` wartet auf
den Abschluss des bestehenden Trade-Auftrags. Das Warten benötigt keine
offenen Datenbankverbindungen. Die Übernahme verwendet anschließend dieselben
Import-, Prüf-, Rechte-, Revisions-, Wiederaufnahme- und Schreibfunktionen
wie die Anwendung. Die Berechtigung des bestehenden anfordernden Developers
wird erneut gelesen; es wird kein Login und keine neue Berechtigung erstellt.
Die ausdrückliche Freigabe bezieht sich nur auf den genannten Dateihash.

Die Arbeit erhält eine gemeinsame Lesesperre auf der vorhandenen
Wartungssperre. Sobald ein exklusiver Wartungsvorgang wartet, pausiert der
Auftrag am gespeicherten Stand, schließt seine Datenbankverbindungen und
gibt die Sperre frei. Dieses Sperrverhalten wurde mit einer eigenen isolierten
Linux-Sperrdatei geprüft. Andere aktive Importaufträge erhalten ebenfalls
Vorrang. Die Unit ist auf 1,5 GiB RAM, 50 Prozent CPU und 70 Stunden Laufzeit
begrenzt; fachliche Prüfsperren bleiben erhalten.

Geschütztes Arbeitsverzeichnis:
`/var/lib/grabenplaner-import-drive-20260915`. `status.json` zeigt den aktuellen
Stand; nur `completed.json` mit `verified: true` belegt den Abschluss.
Der Stand bei Einrichtung war **wartend**, noch nicht vollständig integriert.
Bei einem fachlichen oder endgültigen Fehler werden der gespeicherte Stand
und ein Hinweis zur weiteren Bearbeitung erhalten. Die ursprüngliche
verschlüsselte Arbeitskopie wird nach erfolgreichem Abschluss entfernt.

## Kassendatenbank: noch blockiert

`Kassen_Umsätze.accdb`, Drive-ID `1iog-Kf0DniLCgs_bDbieuJBoqE2cCwHb`,
hat 331.485.184 Bytes. Die Codex-Drive-Anbindung lehnt den Rohabruf oberhalb
268.435.456 Bytes ab. Die unabhängige VPS-Verbindung ist auf `drive.file`
begrenzt und meldet für beide manuell hochgeladenen Dateien bei Abruf über
ihre bekannten IDs `404/notFound`. Ihre Berechtigungen wurden nicht verändert.
Der Download über Chrome wurde blockiert und auf Benutzerwunsch beendet.

Für die Kassendatei ist daher eine passende Lesefreigabe der Serveranbindung
oder ein anderer vom Benutzer freigegebener direkter Transferweg erforderlich.
Es wurde weder ein älterer Kassenstand übernommen noch die Datei als importiert
gemeldet. Die Freigabe soll erst geklärt werden, wenn der Benutzer wieder
verfügbar ist.
