# Private Zusatzmodule vor dem Appwechsel pruefen

Ein vorhandenes privates Workspace-Modul kann den aktuellen GP-Stand korrekt
akzeptieren und einen neuen Stand trotzdem wegen einer fehlenden exakten
Manifestbindung ablehnen. Deshalb muss die Kompatibilitaet beider Staende vor
dem Dienststopp bekannt sein. Der erfolgreiche Vorabcheck der alten App allein
beweist diese Kompatibilitaet nicht.

## Datenpruefung ohne Ausfuehrung des Zusatzmoduls

`server-tools/linux/lib/private-workspace-preflight.py` liest ausschliesslich
Dateien und JSON-Metadaten. Es importiert oder startet weder das konfigurierte
JavaScriptmodul noch dessen private Implementierung. Es verwendet nur die
Python-Standardbibliothek und wird mit `python3 -I -B` aufgerufen.

Geprueft wird die tatsaechliche Servereinstellung
`GRABENPLANER_PRIVATE_WORKSPACE_MODULE` (Singular). Nicht gesetzt oder nur
Leerzeichen bleibt regulaer optional. Ein gesetzter, aber fehlender Pfad ist
ein Fehler. Unbekannte Wrapperformate werden nicht geraten oder automatisch
umgeschrieben; unterstuetzt ist die echte gemeinsame Deklaration
`const bindings=<JSON>,codeFiles=<JSON>;`. Beide Werte werden nur als strenge
JSON-Daten gelesen. Ein anderer Deklarator, ein JavaScriptausdruck oder ein
Ersatzmarker wird abgelehnt. Die global deklarierten privaten Dateipins muessen
mit beiden ausgewaehlten Bindungen uebereinstimmen.

Die Pruefung verlangt:

- Root-eigene, kanonische Dateien und Eltern ohne Gruppen-/Fremdschreibrechte,
  Links oder zusaetzliche Dateihardlinks. Die vorhandene leseberechtigte
  Dienstgruppe und Modus 0640 bleiben zulaessig.
- Je eine eindeutige Bindung fuer den SHA256 des aktuellen und des neuen
  GP-Manifests samt exakt passender GP-Version und Quellcommit.
- Alle gebundenen oeffentlichen Dateien mit passender Groesse und SHA256, sowohl
  gegen das zugehoerige GP-Manifest als auch gegen die echten Dateibytes.
- Unveraenderte private `codeRoot`-/`codeFiles`-Bindung zwischen beiden Staenden,
  gleiche gebundene GP-Dateiliste und richtige Hashwerte aller privaten Dateien.
- Keine Pfadflucht, doppelten JSON-Schluessel, mehrdeutigen Bindungen oder
  veraenderten Dateien waehrend der Pruefung.

Der Wrapper ist auf 4 MiB, jedes Manifest auf 16 MiB begrenzt. Die gebundenen
Dateien werden stueckweise gelesen, pro Datei bis 64 MiB und insgesamt bis
256 MiB. Die Pruefung besitzt ein gemeinsames 30-Sekunden-Lesebudget.
Nicht gebundene oeffentliche Assets werden hier nur als Manifestmetadaten
betrachtet; der normale Paketverifier bleibt fuer das gesamte Paket zustaendig.

Die normale Ausgabe nennt nur Erfolg, Pruefsummen und Dateizaehler. Fehler
verwenden feste `PRIVATE_WORKSPACE_*`-Kennungen, ohne private Quelltexte,
Konfigurationsinhalte oder fremde Fehlermeldungen zu protokollieren. Beispielsweise
unterscheiden `PRIVATE_WORKSPACE_BINDING_MISSING_CURRENT` und
`PRIVATE_WORKSPACE_BINDING_MISSING_CANDIDATE` die fehlende Bindung.

## Zeitpunkt und Auslieferung

Der App-Updater prueft den versiegelten Kandidaten vor Abhaengigkeitsinstall,
ClamAV und Dienststopp. Der ausdrueckliche Offsite13-Refresh prueft bereits nach
der ZIP-/Baumbindung vor ClamAV und erneut unter FD9 vor der externen
Modultransaktion. Eine fehlende private Bindung darf daher nicht erst beim
Start der neuen App auffallen oder zuvor externe Module veraendern.

Der Helper legt selbst keine neue Bindung an und installiert nichts. Ein
erforderliches privates Begleitartefakt wird separat mit dem regulaeren privaten
Buildverfahren aus dem endgueltigen GP-ZIP und dessen freigegebenem SHA256
erzeugt. Historische Bindungen, Wrapperlogik und private Implementierungsdateien
bleiben dabei bytegleich. Private Dateien gehoeren nicht in das oeffentliche
Git-Repository. Der neue Python-Helper selbst ist neutraler oeffentlicher
Servercode und muss im GP-Paketmanifest enthalten sein.

Die Reihenfolge ist deshalb: endgueltiges GP-ZIP und Quellcommit festlegen,
das exakt darauf gebundene private A+B-Begleitartefakt bauen und pruefen, dieses
mit dem regulaeren privaten FD9-Verfahren bei noch alter App uebernehmen,
danach die GP-Vorabpruefung fuer beide Staende ausfuehren. Die private Uebernahme
ist keine direkte Textbearbeitung des installierten Moduls. Keine abweichende
Whitelist, Ersatz-ID oder ungepruefte Versionsannahme ist erlaubt.

Der neue GP-Updatetreiber muss schon fuer diesen ersten Versionswechsel aus
dem vollstaendig geprueften, root-versiegelten Kandidaten stammen und die alte
Installation mit explizitem `--app-dir /opt/grabenplaner/app` adressieren.
Die Paket-, Laufzeit- und Baumverifier stammen weiterhin aus dieser
installierten App. Dadurch wirkt die neue Rueckkehrabsicherung bereits beim
ersten Wechsel; ein unveraenderter alter Updatetreiber erhaelt sie nicht
nachtraeglich. Bei dem eingerichteten Offsite13-Refresh uebernimmt der eigene
Koordinator diese Reihenfolge und die gemeinsame FD9-Sperre. Ohne eingerichtetes
externes Offsite bleibt der regulaere gepruefte Kandidatentreiber mit
`--verification auto` zulaessig; auch er darf keine Verifikation auslassen.

Nach dem Build bleiben echte lokale Start-, Dienst-, Datenbindungs- und
Rueckkehrpruefungen fuer die exakten oeffentlichen/privaten Kombinationen
verpflichtend. Dieser Datencheck beweist keine beliebige JavaScript-Kompatibilitaet,
Cloudanmeldung oder vollstaendige konfigurierte Recovery Assurance.
