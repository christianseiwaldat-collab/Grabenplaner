# Linux-Runtime-Migrationen

## Deployment-Schema 5 und Offsite-Modul 7

Der gekoppelte Wartungsweg `migrate-grabenplaner-runtime-v5.sh` akzeptiert
ausschliesslich Runtime 4 -> 5 mit bereits eingerichtetem Offsite-Modul 6.
Er prueft das per SHA-256 bereitgestellte Paket, die unveraenderten
Host-Control-/Hardening-/Providervertraege und den exakten Unterschied der
App- und Bootstrap-Unit: Start und Stopp erhalten jeweils 1500 Sekunden.
Alle anderen verwalteten Runtime-Dateien bleiben bytegleich.

Unter der bestehenden Wartungssperre werden die beiden Units und ihre drei
Vertragsdateien gesichert. Der im Paket verifizierte Updater darf nur mit
einem root-only, an Paket, Aufrufpfad und Commitmarker gebundenen
Uebergangsbeleg die neue Paketpruefung verwenden. Neue lokale Sicherungspaare
entstehen aus dem vollstaendig geprueften Kandidatenbaum und werden jeweils
mit Datenbank, Dokumenten und Hashes verifiziert. Die unveraenderte Alt-Historie
wird dabei weder erneut gelesen noch bereinigt. Der bisherige Offsite-Hook
uebertraegt den Vorabstand; die installierten Restore-Werkzeuge bleiben fuer
einen moeglichen Rollback erhalten.

Die neue Offsite-Bindung wird erst nach dem erfolgreichen App-Commit
installiert. Die bisherigen Timer pausieren waehrend der gesamten Migration;
ihre Aktivzustaende werden anschliessend wiederhergestellt. Modulversion 7
behaelt die Unit-Dateien, Provider-, Repository- und Zugangskonfiguration bei
und bringt die speicherbegrenzten Staging-/Restore-Helfer mit. Ihr neuer
Installationsbeleg uebernimmt die zuvor gepruefte Providerbindung unveraendert.
Danach wird die vollstaendige signierte Assurance eingeplant.

Ein unterbrochener Migrationsprozess behaelt seine Ruecksicherungsartefakte
und einen Diagnosemarker. Sein Zustand wird anhand des Updater-Commitbelegs
geprueft, bevor ein manueller Wiederanlauf oder Rollback erfolgt. Eine aeussere
Prozessgruppen-Zeitbegrenzung darf die verschachtelte Transaktion nicht
abschneiden; die Start-/Healthfenster bleiben jeweils auf 1500 Sekunden begrenzt.

Vor dem App-Commit stellt ein Fehler die alten Units und Runtime-Dateien
wieder her; den App-/Datenrollback uebernimmt der vorhandene Updater. Nach
einem bestaetigten App-Commit wird kein Teilrollback ausgefuehrt. Ein Fehler
im folgenden Modul- oder Belegabschluss erhaelt den Diagnoseordner und laesst
die Offsite-Timer bis zur gezielten Reparatur pausiert.

Die Initialisierung der beiden lokalen Archive und deren ausdrueckliche
Aktivierung erfolgen anschliessend mit den installierten Werkzeugen und der
vorhandenen Vault-Bindung. Ein App-Update allein importiert keine Kassendaten
und aktiviert keine fachlichen Zuordnungen.

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
unzip Grabenplaner-Server-v0.88.4-beta-linux-x64.zip -d /root/grabenplaner-runtime-v3
sudo bash /root/grabenplaner-runtime-v3/server-tools/linux/migrate-grabenplaner-runtime-v3.sh \
  --package /root/Grabenplaner-Server-v0.88.4-beta-linux-x64.zip \
  --sha256-file /root/Grabenplaner-Server-v0.88.4-beta-linux-x64.zip.sha256
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

### Ausschliesslicher Post-Commit-Abschluss

Ist Schema 3 bereits installiert und der innere App-Updater nachweislich
committed, darf die Schema-2→3-Migration nicht erneut gestartet werden. Fehlt
in diesem Sonderfall nur der aeussere Migrationsbeleg, kann das v0.88.4-Paket
den retained Diagnoseordner fail-closed finalisieren:

```bash
sudo bash /root/grabenplaner-v0884/server-tools/linux/finalize-grabenplaner-runtime-v3.sh \
  --package /root/Grabenplaner-Server-v0.88.4-beta-linux-x64.zip \
  --sha256-file /root/Grabenplaner-Server-v0.88.4-beta-linux-x64.zip.sha256 \
  --diagnostic-dir /opt/grabenplaner/.runtime-v3-migration.XXXXXXXX \
  --from-version 0.87.0-beta \
  --to-version 0.88.3-beta \
  --original-package-sha256 ORIGINALPAKET_SHA256
```

Der Finalizer bindet sich bytegleich an das vollstaendig verifizierte
v0.88.4-Paket. Unter derselben Wartungssperre korreliert er Transcript,
Commitmarker und dauerhaften Updatebeleg, verifiziert den kompletten
DB-/Dokumentsicherungspunkt erneut und reproduziert Runtime-, Env-, Unit-,
Health- und Offsite-Nachweise. Er schreibt ausschliesslich den fehlenden
Migrationsbeleg, einen Recovery-Sidecar und `FINALIZED.json`. App, systemd,
Env, Provider, Repository und Zugangsdaten werden nicht veraendert; es wird
kein Dienst und kein Host neu gestartet. Der Diagnose- und Rollbackordner
bleibt bis zur getrennten Abschlusskontrolle erhalten.

## Deployment-Schema 4

Schema 4 behaelt den root-verwalteten Host-Control-Pfad und saemtliche
Hardening-Direktiven aus Schema 3 unveraendert bei. Neu ist ausschliesslich die
systemd-Credential-Bindung `host-boot-id` an
`/proc/sys/kernel/random/boot_id`. PID 1 kopiert diese Boot-ID vor Aufbau des
gehaerteten Prozess-Namensraums in den nur fuer den Dienst lesbaren
Credential-Pfad. Dadurch kann die App eine echte Bootgeneration bestaetigen,
obwohl `ProtectProc=invisible` und `ProcSubset=pid` den direkten `/proc`-Zugriff
weiterhin begrenzen.

Der normale Updater lehnt den Runtime-Fingerprintwechsel mit
`migration-required:3->4` ab. Der freigegebene Wartungsweg lautet:

```bash
sudo bash /root/grabenplaner-runtime-v4/server-tools/linux/migrate-grabenplaner-runtime-v4.sh \
  --package /root/Grabenplaner-Server-VERSION-linux-x64.zip \
  --sha256-file /root/Grabenplaner-Server-VERSION-linux-x64.zip.sha256
```

Die Migration akzeptiert nur eine gesunde Schema-3-Installation. Sie verlangt,
dass die App-Unit exakt um den einen Credential-Block erweitert wurde. Als
einzige weitere Abweichung ist der bekannte, rein kommentierte
E-Mail-/SMS-/WhatsApp-Beispielblock in `grabenplaner.env.example` bytegenau
zulaessig; ist er bereits installiert, muss das Template vollstaendig
bytegleich sein. Die echte root-only Datei `/etc/grabenplaner/grabenplaner.env`
wird nicht veraendert und ihr SHA-256-Wert vor und nach der Migration
bestaetigt. Alle anderen verwalteten Runtime-Artefakte muessen bytegleich
bleiben. Vor jeder Aenderung prueft die Migration Paket-SHA, ZIP-Struktur,
Manifest, ClamAV, Runtimevertrag,
installierte Unit und Live/Ready. Die Kandidaten-Unit wird vor der atomaren
Bindung mit `systemd-analyze verify` geprueft. Anschliessend laeuft der normale,
backup- und rollback-faehige Server-Updater unter derselben Wartungssperre.

Vor dem App-Commit werden Unit und Runtimebaum bei einem Fehler gemeinsam auf
Schema 3 zurueckgesetzt. Nach dem Commit werden Runtime-Fingerprint,
Credential-Zeile, Live/Ready und eine 32-stellige `hostBootGeneration` erneut
verifiziert. Der root-geschuetzte Migrationsbeleg wird unter
`/var/lib/grabenplaner/maintenance/history` geschrieben. Die Migration lockert
keine Hardening-Direktive und startet weder den Host-Reboot-Dienst noch einen
anderen VPS-Neustart.
