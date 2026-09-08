# Bewerbungsbewertungen im mobilen Mitarbeiterportal

Stand: 8. September 2026. Fachliche Prüfung abgeschlossen. Die beschriebenen
Korrekturen sind als v0.92.31-beta auf dem VPS installiert; der Updater
bestätigte den Versionswechsel um 15:15:33.830 UTC. Den erfolgreichen Abschluss
der Betriebs- und Wiederherstellungsprüfung enthält der
[Veröffentlichungsnachweis](PREBOARDING-RELEASE-v09231.md).
Ausgangspunkt der fachlichen Prüfung: `e4b40f96460e8aae826fb09d6ca461b4301b564a`,
`feature/schedule-pdf-day-separators`, damals produktiv v0.92.30-beta.

## Ergebnis

Zugewiesene Bewerber- und Preboarding-Bewertungen werden beim persönlichen
Anmelden und Neuladen direkt geöffnet. Normale Mitarbeitende benötigen dafür
keinen Zugang zur Bewerberverwaltung. Die Bewertung ist ausschließlich der
zugewiesenen Person zugänglich. Vertrauliche Kontaktdaten, Leitungsnotizen und
fremde Einzelbewertungen werden dabei nicht ausgeliefert.

Zwei Fehler wurden im tatsächlichen Browserablauf reproduziert und korrigiert:

1. Wurde eine Bewertung einem bereits geöffneten Portal zugewiesen, erschien
   dort bisher kein Hinweis. Jetzt erscheint oberhalb des aktuellen Bereichs
   „Bewerbung bewerten“ mit „Bewertung öffnen“. Der Abruf erfolgt beim erneuten
   Sichtbarwerden und im bestehenden 45-Sekunden-Takt, solange das Portal
   sichtbar ist. Eine laufende Eingabe wird dabei nicht unterbrochen. Der
   Hinweis enthält nur die Anzahl offener Bewertungen; nach Erledigung
   verschwindet er beim nächsten Abruf. Anmelden und Neuladen öffnen weiterhin
   direkt die persönliche Bewertungsfläche.
2. Bei einer zwischenzeitlichen Änderung der Bewerbung konnte ein
   Versionskonflikt Sterne und Kommentare aus dem geöffneten Bewertungsformular
   löschen. Diese Eingaben bleiben jetzt für dieselbe Bewertung erhalten;
   die aktualisierte Fassung lässt sich ausdrücklich erneut absenden.
   Ein Entwurf wird nicht auf eine andere Bewertung übertragen. Ein Fehler
   beim Neuladen wird sichtbar behandelt. Eine inzwischen leere Zuweisungsliste
   meldet keine erfolgreiche Abgabe, wenn tatsächlich nichts abgegeben wurde.

## Lesende Ausgangsprüfung auf dem VPS

Die VPS-Prüfung war ausschließlich lesend. Das Personalmodul ist aktiviert;
es bestehen zwei Bewerberdatensätze. Die installierten Bewertungsdateien und
das Portal stimmten mit dem geprüften v0.92.30-Quellstand überein. Die abweichende
lokale Portal-Dateiprüfsumme erklärte sich durch Windows-Zeilenenden; der
unveränderte Git-Quellinhalt stimmte mit der installierten Datei überein.

Im vorhandenen Audit-Protokoll finden sich 73 Listenabrufe und zwölf PDF-Abrufe,
aber keine protokollierte Aktion `personnel-lifecycle.team-evaluation.assign`
oder `personnel-lifecycle.team-evaluation.submit`. Das ist ein Protokollbefund,
keine Auswertung der verschlüsselten Bewerberinhalte. Für die Produktivprüfung
wurden weder personenbezogene Bewerberinhalte entschlüsselt noch fremde
Mitarbeitersitzungen angelegt oder echte Zuweisungen/Abgaben erzeugt.

Eine Bewertung wird beim Bewerber unter „Bewertungsübersicht“ zugewiesen:
Personen auswählen und „Bewertung zuweisen“ ausführen. Das bloße Anlegen einer
Bewerbung oder eines Schnuppertermins ersetzt diese persönliche Zuweisung nicht.

## Prüfnachweise

- Isolierte lokale Anwendung mit synthetischen Mitarbeitenden und Bewerbungen,
  echten Anmeldungen und den regulären Zuweisungs-/Abgabe-APIs.
- Handy-Browser mit Touch in 320×568, 390×844, 844×390 und 932×430:
  Hinweis und Bewertungsformular ohne horizontalen Seitenüberlauf;
  Screenshots visuell geprüft, keine JavaScript-Laufzeitfehler.
- Spätere Zuweisung beim Sichtbarwerden sowie echter 45-Sekunden-Abruf bei
  einem geöffneten ZA-Entwurf; der Entwurf bleibt erhalten.
- Bewerbung im Status `preboarding`, persönliche Abgabe per Touch,
  Rückkehr ins Portal und bestätigte Speicherung in der Bewerberauswertung.
- Nicht zugewiesene Person erhält keine offene Bewertung und kann eine fremde
  Bewertung nicht absenden. Geprüfte Rollen-/Sitzungswechsel verwerfen alte
  Antworten; Filialkonten und Terminals erhalten diesen persönlichen Einstieg nicht.
- Erster Zugang mit Pflicht-Passwortwechsel: Bewertung erst nach erfolgreichem
  Passwortwechsel zugänglich. Zwei offene Bewertungen lassen sich nacheinander
  absenden; Kommentare dürfen leer bleiben.
- Gleichzeitige Bewerbungsänderung: zunächst reproduzierter Verlust aller
  Eingaben, nach Korrektur beide Sterneauswahlen und Kommentare erhalten;
  anschließende Speicherung erfolgreich.
- Fachlich fokussierter Lauf: 19 Tests bestanden. Ergänzende
  Mobilnavigation: vier Tests; Sitzungs-/Abmelde-/Formularregressionen:
  27 Tests bestanden. Die fokussierte tatsächliche API-Prüfung bestand ebenfalls.
- Abschließende Release-Prüfung für v0.92.31-beta: 57 Tests bestanden,
  einschließlich Bewertungsformular, Portalnavigation und Sitzungsgrenzen.
- JavaScript-Syntax, `git diff --check` und Persistenz-Kopplungsinventar bestanden.
  Keine Server-, Schema-, Rechte- oder Speicherstrukturänderung.

Die Browserprüfung emuliert Handygrößen und Touch in Chrome; sie ist keine
Abnahme auf physischer Handy-Hardware. Die neue Hinweisfunktion und der Erhalt
bei Versionskonflikten sind mit v0.92.31-beta installiert. Der separate
Veröffentlichungsnachweis dokumentiert Paket, Quellcommit, VPS-Beleg und die
weiteren Betriebsprüfungen.

Lokale Arbeitsbelege: `tmp/preboarding-mobile-review/`,
`tmp/preboarding-mobile-browser-baseline.log`,
`tmp/preboarding-mobile-extra-baseline.log`,
`tmp/preboarding-mobile-extra-fixed.log`,
`tmp/preboarding-mobile-password-sequence.log`,
`tmp/preboarding-final-focused.log`, `tmp/preboarding-session-regression.log`,
`tmp/preboarding-live-readonly.log` und `tmp/preboarding-persistence-audit.log`.
