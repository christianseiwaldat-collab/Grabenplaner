# Linux-Runtime-Migrationen

`runtime-schema.json` versioniert den ausserhalb des App-Ordners installierten
Serververtrag. Dazu gehoeren die Vorlagen fuer systemd, Caddy, den einmaligen
Admin-Bootstrap und die geschuetzte Env-Datei.

Das normale Update vergleicht vor jeder Aenderung die SHA-256-Fingerprints
dieser Artefakte. Es aktualisiert ausschliesslich den App-Baum. Dabei gelten
zwei harte Regeln:

- Geaenderte Artefakte bei unveraenderter `deploymentSchemaVersion` werden als
  fehlerhaftes Paket abgelehnt.
- Eine neue `deploymentSchemaVersion` stoppt das Update mit
  `migration-required`. Eine dafuer freigegebene Servermigration muss zuerst
  systemd/Caddy sichern, die bestehende Konfiguration und Secrets erhalten,
  die neuen Dateien validieren und bei einem Fehler zurueckrollen.

Neue Deployment-Haertungen duerfen deshalb nicht nur in den Vorlagen geaendert
werden. Die Schemaversion, eine gepruefte Migrationsroutine und ihre Tests
gehoeren immer zu derselben Aenderung. Env-Secrets, produktive Caddy-Regeln und
systemd-Units werden niemals blind aus einem App-Paket ueberschrieben.

## Deployment-Schema 2

Schema 2 ergaenzt `grabenplaner-monitor.service` und
`grabenplaner-monitor.timer` als root-verwaltete Runtime-Artefakte. Der Wechsel
von Schema 1 erfordert deshalb eine ausdrueckliche Wartungsmigration mit
Sicherung, Installation und Pruefung der neuen Units; das normale App-Update
bricht vorher mit `migration-required:1->2` ab.

### Offizieller Weg von Schema 1 auf Schema 2

Die Migration wird direkt aus dem separat heruntergeladenen und per SHA-256
freigegebenen v0.74-Linux-Serverpaket gestartet:

```bash
unzip Grabenplaner-Server-v0.74.0-beta-linux-x64.zip -d /root/grabenplaner-v074
sudo bash /root/grabenplaner-v074/server-tools/linux/migrate-grabenplaner-runtime-v2.sh \
  --package /root/Grabenplaner-Server-v0.74.0-beta-linux-x64.zip \
  --sha256-file /root/Grabenplaner-Server-v0.74.0-beta-linux-x64.zip.sha256
```

Das Werkzeug ist absichtlich kein Erstinstaller und akzeptiert nur eine aktive,
bereits fertig eingerichtete Produktionsinstallation mit Deployment-Schema 1,
mindestens einem aktiven Admin und bereits verbrauchtem Bootstrap-Schluessel.
Es fuehrt insbesondere folgende Schritte aus:

1. Paket-SHA, ZIP-Struktur, Einzeldatei-Manifest, Runtimevertrag und ClamAV
   pruefen; zugelassen ist ausschliesslich Schema 1 -> 2.
2. Eine gemeinsame root-only Wartungssperre halten und die neuen
   Monitor-Units samt Statusgruppe vorbereiten. Der Bootstrap wird dabei weder
   gestartet noch mit einem neuen Token versehen.
3. Bei aktivem Offsite-Modul dessen bisherige Installation gegen den
   Installationsbeleg pruefen, Timer pausieren und den unveraenderten
   Modulvertrag atomar an die v0.74-Werkzeuge binden. Repository, restic/rclone,
   Passwoerter und verschluesselte rclone-Konfiguration bleiben bestehen.
4. Den bewaehrten Server-Updater unter derselben Wartungssperre ausfuehren.
   Dieser erstellt einen verifizierten lokalen DB-/Dokumentsicherungspunkt,
   uebertraegt ihn bei aktivem Offsite vor dem App-Tausch, installiert die
   eingefrorenen Produktionsabhaengigkeiten und prueft internes sowie
   oeffentliches Live/Ready. Fehler vor dem erfolgreichen App-Commit rollen
   App, Daten, Runtime und Offsite-Bindung auf Schema 1 zurueck.
5. Env- und Offsite-Geheimdateien per Vorher-/Nachher-Pruefsumme bestaetigen,
   Runtime-Fingerprint, Bootstrap-Zustand und Live/Ready erneut pruefen und
   einen root-geschuetzten Migrationsbeleg unter
   `/var/lib/grabenplaner/maintenance/history` schreiben. Dieser enthaelt auch
   die SHA-256 des verifizierten Vorabbackups, aber keine Geheimwerte.

Tritt erst nach dem bereits erfolgreichen, von Live/Ready bestaetigten
App-Commit ein Fehler bei dieser abschliessenden Belegpruefung auf, wird kein
gefaehrlicher Teilrollback auf Schema 1 versucht. Die konsistente Runtime-v2-
Installation bleibt aktiv und das root-only Diagnoseverzeichnis wird mit
`POST-UPDATE-ACTION-REQUIRED` erhalten. Dieser Sonderfall verlangt eine
kontrollierte IT-Pruefung; er oeffnet ebenfalls niemals den Admin-Bootstrap.

## Deployment-Schema 3

Schema 3 ergaenzt einen eng begrenzten, root-verwalteten Steuerpfad fuer einen
ausdruecklich bestaetigten Ubuntu-Host-Neustart. Die App erhaelt keine
allgemeinen `sudo`- oder systemd-Rechte. Ausschliesslich der Dienstbenutzer
`grabenplaner` darf ueber
`/run/grabenplaner-host-control/request.sock` eine streng validierte Anfrage an
den separat unter `/opt/grabenplaner-host-control/module` installierten Broker
senden. Die Brokerkopie und alle drei Units gehoeren root und sind fuer die App
nicht schreibbar.

Der Wechsel von Schema 2 erfordert eine ausdrueckliche Wartungsmigration. Das
normale App-Update bricht vorher mit `migration-required:2->3` ab. Insbesondere
reicht es nicht, nur die neuen Dateien in den App-Ordner zu kopieren.

### Offizieller Weg von Schema 2 auf Schema 3

Die Migration wird aus dem separat bereitgestellten, per SHA-256 freigegebenen
Linux-Serverpaket gestartet:

```bash
unzip Grabenplaner-Server-v0.88.1-beta-linux-x64.zip -d /root/grabenplaner-runtime-v3
sudo bash /root/grabenplaner-runtime-v3/server-tools/linux/migrate-grabenplaner-runtime-v3.sh \
  --package /root/Grabenplaner-Server-v0.88.1-beta-linux-x64.zip \
  --sha256-file /root/Grabenplaner-Server-v0.88.1-beta-linux-x64.zip.sha256
```

Das Werkzeug akzeptiert ausschliesslich eine gesunde, produktive
Schema-2-Installation mit geschlossenem Bootstrap und aktivem administrativem
Zugang. Es fuehrt folgende Schritte aus:

1. Paket-SHA, ZIP-Struktur, Einzeldateimanifest, ClamAV, Runtime-Fingerprints,
   Live/Ready und den unveraenderten Hardening-Vertrag pruefen. Ein geaenderter
   Offsite-Quellfingerprint ist bei nicht aktivierter Offsite-Sicherung
   zulaessig. Bei einer konfigurierten Sicherung muss dagegen die getrennte
   Offsite-Migration bereits abgeschlossen sein: Der root-only
   Installationsbeleg und der installierte Modulbaum muessen exakt
   Modulversion, Schema, Dateiliste und Fingerprint des Kandidaten bestaetigen.
   Zudem werden die unveraenderte Providerbindung, die live von rclone
   redigierte Provider-Richtlinie und die gebundene Repository-Identitaet mit
   den Kandidatenwerkzeugen geprueft. Andernfalls endet der Vorgang
   fail-closed mit `Offsite-Migration zuerst`; ein Providerwechsel ist in der
   Runtime-Migration ausgeschlossen.
2. Die root-only Wartungssperre halten und den bestehenden Schema-2-Runtimebaum
   als lokalen Rollbackpunkt sichern.
3. Die dedizierte Gruppe `grabenplaner-host-control` erstellen, nur den
   Dienstbenutzer aufnehmen und Broker sowie Units root-owned vorbereiten.
4. Alle Units vor und nach der atomaren Installation mit `systemd-analyze
   verify` pruefen und ausschliesslich den Unix-Socket aktivieren.
5. Den normalen Server-Updater unter derselben Wartungssperre ausfuehren. Damit
   entstehen ein verifiziertes DB-/Dokumentenbackup, gegebenenfalls die
   verpflichtende Offsite-Kopie sowie der uebliche App- und Datenrollback.
6. Runtime-Fingerprint, Eigentumsrechte, Gruppenmitgliedschaft, Socket,
   Bootstrap und Live/Ready erneut pruefen und einen root-geschuetzten Beleg
   unter `/var/lib/grabenplaner/maintenance/history` schreiben.

Die Migration startet weder `grabenplaner-host-reboot.service` noch einen
anderen Neustartbefehl; der Beleg enthaelt deshalb explizit
`"rebootTriggered": false`. Scheitert sie vor dem App-Commit, werden Runtime,
Units, Brokerkopie und neu angelegte Gruppenbindung zurueckgerollt. Nach einem
bereits erfolgreichen App-Commit bleibt wie bei Schema 2 der konsistente neue
Stand erhalten und ein root-only Diagnoseordner markiert den erforderlichen
manuellen Nachlauf.
