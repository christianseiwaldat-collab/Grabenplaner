# Assurance-Control: getrennte Antwortverbindung

Der privilegierte Broker kann seine Arbeit abschließen, nachdem der aufrufende
Client seinen Unix-Socket bereits geschlossen hat. Bisher führte das asynchrone
`EPIPE` von stdout zu einem unbehandelten Prozessabbruch. Die Korrektur behandelt
ausschließlich diesen Transportfall und protokolliert
`ASSURANCE_RESPONSE_DISCONNECTED`. Sie bestätigt keine Zustellung, wiederholt
keine Aktion und verändert weder Wartungssperren noch Signaturnachweise,
Zugriffsrechte, Zeitpläne oder Client-Timeouts. Andere Ausgabefehler bleiben Fehler.

Die konkrete Ursache einer einzelnen Client-Trennung lässt sich aus `EPIPE`
allein nicht ableiten. Der Statusclient hat ein dreisekündiges Antwortbudget,
während die vorgeschalteten Wartungs-/Broker-Sperren zusammen bereits bis zu
sechs Sekunden warten dürfen. Unter Last ist eine verspätete Antwort daher
möglich. Eine fehlende Antwort darf nicht als erfolgreicher Aufruf gelten.

Verifikation: 50 gezielte Tests unter Linux/Node 22, darunter ein tatsächlich
geschlossenes Antwort-Pipe, normale Antworten, unerwartete I/O-Fehler sowie die
bestehenden Protokoll-, Rechte- und Wartungszeitplan-Prüfungen.

Installation ausschließlich über den regulären Offsite-Modulinstaller mit
unveränderter Repository-Bindung und geprüften bestehenden Binaries. Keine
manuelle Änderung der installierten Vertragsquittung. Danach der automatisch
ausgelöste vollständige Assurance-Nachweis und reguläre Modulprüfung; erst
anschließend frische Neustartprüfung. Diese Korrektur erteilt keine
Neustartfreigabe.
