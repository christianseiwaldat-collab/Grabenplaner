# v0.92.37-beta: Umstellung der Deploy-Prüfungen

Stand: 12.09.2026. Kern und separates Offsite-Modul sind installiert und
abschließend geprüft. Der vollständige Recovery-Nachweis ist seit 05:47:02 UTC
erfolgreich signiert. Der aktuelle kompatible Kernstand darf damit den kurzen
Ablauf verwenden; die Grenze für das nächste Kernpaket steht weiter unten.

## Installierter Kern

- Quellstand: `c90dc0d68e02af95fb251c2b79ecf19fc6103a7c`.
- Paket: `Grabenplaner-Server-v0.92.37-beta-linux-x64.zip`.
- SHA256: `460b27165e10a4f161e06fbcc194db02be5d1c8073e666b85f7fca6f50f59dcd`.
- 558 Manifestdateien unabhängig lokal und auf dem Server geprüft.
- Runtime-Vertrag 5, separates Offsite-Modul 8.
- Erfolgreicher Updatebeleg: `update-2026-09-12T03-47-11-986493996.json`.
- Unmittelbarer Rückkehrpunkt:
  `dienstplan-2026-09-12T03-32-46-972695382-c66da9d3e5b5.db`.

Der erfolgreiche Kernlauf verwendete ausdrücklich den vollständigen Ablauf.
Alle 24 Betriebsprüfungen bestanden nach dem Versionswechsel in 28 Sekunden.
Der Berichtstest verarbeitete 104 Kassenpositionen und erzeugte eine PDF mit
elf Seiten in 4,911 Sekunden. Die höchste gemessene Readiness-Antwortzeit
währenddessen lag bei 588 ms. Quelldaten und gespeicherte Berichtsaufträge
blieben unverändert; die Test-PDF wurde nicht dauerhaft gespeichert.

Der erfolgreiche Kernupdate-Beleg erfasst folgende Phasen des ausdrücklich
vollständigen Einführungsablaufs:

| Phase | Dauer |
| --- | --- |
| Paketprüfung, Abhängigkeiten und Virenscan zusammen | 6 min 31 s |
| Erster Dienststopp, einschließlich bereits laufender alter Sicherung | 4 min 11 s |
| Erster Rückkehrpunkt mit Archivabschluss | 14 min 8 s |
| Wiederanlauf des bisherigen Kerns und externe Vorabsicherung zusammen | 12 min 28 s |
| Zweiter Dienststopp | 1 s |
| Frischer Rückkehrpunkt unmittelbar vor dem Austausch | 8 min 25 s |
| Anwendungsaustausch | 4 s |
| Start der neuen Anwendung | 5 min 32 s |
| Kurze Betriebsprüfungen | 28 s |

Diese Messung betrifft den vollständigen Einführungsablauf, nicht einen kurzen
Folge-Deploy. Die Datenbank-Abschlussprüfung bestand separat in 321,713 Sekunden
mit `integrity_check=ok` und ohne Fremdschlüsselfehler. Geprüfte Geschäftsbestände,
Kasseninventar und eigene Artikelbildzuordnungen entsprachen dem Ausgangsstand.

## Separater Recovery-Nachtrag

Der erste vollständige Lauf des neuen Moduls bestätigte die externe Sicherung,
die vollständige Repositoryprüfung und die Datenwiederherstellung aus Snapshot
`6b1b874b1c23`. Die isolierte Startprobe scheiterte nach 90 Sekunden. Der Lauf
`8248d155-2ec6-4bfc-bb81-f9b8a12cf84e` bleibt deshalb als fehlgeschlagen in der
signierten Historie erhalten; er erzeugt keinen Nachweis für kurze Deploys.

Der reguläre Anwendungsstart benötigte im Kernupdate 332 Sekunden. Die isolierte
Startprobe führt ebenfalls die vollständige SQLite-Startprüfung aus, unter
eigenen CPU-/Speichergrenzen. Ihr Budget wird daher auf zehn Minuten begrenzt;
die äußere systemd-Grenze beträgt 630 Sekunden und lässt Zeit für Beendigung
und Ergebnisprüfung. Isolation, Ressourcenlimits, Liveness, Readiness und
kontrolliertes Beenden bleiben unverändert erforderlich. Das für eine
Oneshot-Unit wirkungslose `RuntimeMaxSec` entfällt.

Dieser Nachtrag ist ausschließlich für das getrennt installierte Offsite-Modul:

- Quellstand: `f28995638109f017654bacb73e7c2cf35cdbed23`.
- Bereitstellungspaket SHA256:
  `bbe9d515267600a3792c1f647fb987804faeb7ec3eb1b3de8d83254cd03953b7`.
- 25 gezielte Tests bestanden, einschließlich Isolation, Bereinigung der
  Testkopie, Ergebnisprüfung und aufeinander abgestimmter Zeitgrenzen.
- Der GP-Kern wird durch diesen Modulnachtrag nicht erneut ausgetauscht.

Der separate Modulinstaller und sein Offsite-Betriebstest sind am 12.09.2026,
04:48:47 UTC, erfolgreich abgeschlossen. Alle 558 Dateien des installierten
Kernmanifests blieben unverändert. Der folgende vollständige Recovery-Lauf
trägt die Kennung `37a8b0ac-1116-4a9a-b3ad-1052d2ea0828`.

Dieser Lauf bestätigte die externe Sicherung um 05:23:38 UTC, die vollständige
Repositoryprüfung um 05:28:16 UTC und die isolierte Datenwiederherstellung sowie
den Anwendungsstart um 05:36:30/31 UTC. Alle Nachweise beziehen sich auf Snapshot
`e5bfa0c5d04b` und den Restorebeleg mit SHA256
`5847edc09241f8ebe0d7b7675afe268bb1ec15ad346e9ce01225724ac442ceae`.
Die erfolgreiche isolierte Startprobe benötigte in diesem Lauf 35,244 Sekunden.
Das ist eine Einzelmessung nach vorbereiteter Testkopie, keine allgemeine
Zusicherung eines Starts unter 90 Sekunden. Der vollständige Betriebscheck des
Nachtlaufs bestand anschließend um 05:47:01 UTC; der signierte Gesamtnachweis
folgte um 05:47:02.692 UTC (Sequenz 1128). Der root-geschützte, an Code,
Schema und Konfiguration gebundene Deploy-Nachweis wurde erfolgreich geschrieben.

Der Modulinstaller führte bei diesem Update von Modul 8 einen regulären
Dienstneustart aus. Dabei begann eine native Sicherung, die vollständig
abgeschlossen wurde; dieser seltene Modulwechsel verwendet noch nicht die
gemeinsame Sicherungszuständigkeit von Kernupdater und Offsite-Vorbereitung.
Diese zusätzliche Dauer ist vom normalen Kernupdate getrennt zu bewerten.

## Grenzen und Messung

Der kurze Ablauf bleibt an einen tatsächlich erfolgreichen vollständigen Lauf
innerhalb von 36 Stunden und dessen Code-, Schema- und Konfigurationsbindung
geknüpft. Fehlende oder unpassende Nachweise sowie kritische Änderungen führen
weiterhin zum vollständigen Ablauf. Ein frischer, vollständig geprüfter
DB-/Dokument-Rückkehrpunkt bleibt auch im kurzen Ablauf erforderlich.

Die Organisationsmigration speichert erfolgreiche globale Prüfungen. Die
zusätzliche `quick_check`-Prüfung der Feature-Kompatibilität läuft weiterhin bei
jedem Start und bleibt ein gemessener Ansatzpunkt für weitere Beschleunigung.
Die Gesamtdauer eines künftigen kurzen Deploys ist noch nicht produktiv gemessen.
Der Modulnachtrag verändert die im nächsten Kernpaket mitgelieferten
Recovery-Dateien. Ihre erstmalige Übernahme in den Kern erzwingt nach der
konservativen Auswahlregel nochmals einen vollständigen Ablauf. Ein grüner
Nachweis auf dem jetzigen Kern hebt diese Erkennung kritischer Änderungen
nicht auf.

Die tatsächliche Auswahlprüfung bestätigte beide Fälle: `short` mit
`RECENT_FULL_RECOVERY` für den unveränderten installierten Kern und `full` mit
`RECOVERY_CONTRACT_CHANGED` für das Paket mit dem mitgelieferten Modulnachtrag.

## Abschlusskontrolle und Bereinigung

- Der reguläre Monitor bestand am 12.09.2026 um 05:48:09 UTC alle 24 Prüfungen
  in 28,534 Sekunden. Der GP-Prozess wurde dabei nicht neu gestartet.
- Interne und öffentliche Liveness/Readiness lieferten jeweils HTTP 200.
  Ausgelieferte Oberflächendateien, alle 558 Kernmanifestdateien und alle
  42 Dateien des separat installierten Offsite-Moduls stimmen mit ihren
  dokumentierten Paketen überein.
- Geschäftsbestände, Kasseninventar und eigene Artikelbildzuordnungen blieben
  unverändert. Vier bestehende Berichtsaufträge sind abgeschlossen; die
  Berichterstellung ist freigegeben. Bootkennung und Mail-Ereignisfreigaben
  entsprachen dem Ausgangsstand.
- Eigene Installations- und Uploadverzeichnisse wurden erst nach Prüfung von
  Pfad, Eigentümer, Paket-Hash und gesicherten Logs entfernt, einschließlich
  der temporären geschützten Konfigurationskopien. Der eigene temporäre
  Paket-Build-Checkout wurde ebenfalls entfernt.
- Sechs fehlgeschlagene eigene temporäre Deployment-Units wurden nach
  Sicherung ihrer Protokolle aus dem systemd-Fehlerstatus genommen. Historische
  Betriebsfehler anderer Units und die signierte Fehlerhistorie bleiben erhalten;
  neue operative Fehler gegenüber dem Ausgangsstand wurden nicht festgestellt.

## Einführung und verworfene Versuche

Die Einführung erforderte einen ausdrücklichen Modulwechsel und einen separat
gepinnten neuen Paketprüfer. Der alte Prüfer verstand den neuen Modulvertrag
noch nicht; ein betroffener Versuch wurde vor dem Kernwechsel abgewiesen.
Ein weiterer Versuch kehrte nach gescheiterter Betriebsprüfung automatisch
auf v0.92.36 zurück. Ursache war zunächst ein pausierter Timer und danach die
zirkuläre Forderung nach einem vollständigen Recovery-Nachweis unmittelbar
vor dessen erstem Lauf. Der erfolgreiche Kernstand erlaubt den offenen ersten
Gesamtnachweis beim Deploy nur bei frischer externer Sicherung, frischer
Repositoryprüfung, aktiven Timern und ohne ungeklärte Fehler dieser Prüfungen.
Diese Ausnahme erteilt ausdrücklich keine Freigabe für kurze Deploys.

Ein bereits begonnener alter Sicherungslauf wurde an einer kontrollierten
Vorbereitungsgrenze beendet; die laufende native Sicherung durfte vorher
abschließen. Es blieb kein pausierter Prozess zurück. Fehlgeschlagene Versuche
bleiben in Updatebelegen, Logs und signierter Historie nachvollziehbar.
Es erfolgte kein Host-Neustart und keine Änderung an den Netzwerkzugängen.
