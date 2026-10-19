# Brückenbauer

Ein Brücken-Bauspiel fürs Handy, Tablet (besonders iPad) und den PC. Du baust aus
Holz-, Stahl- und Seil-Balken eine Brücke über eine Schlucht oder einen Fluss –
dann fahren Fahrrad, Auto, Bus und LKW darüber, und die Physik entscheidet, ob
die Brücke hält. Es gibt vorgefertigte Level, einen Sandkasten zum freien
Bauen und einen Level-Editor für eigene Level.

Die gesamte Bedienung ist auf Deutsch. Das Spiel läuft im Browser, braucht
keine Installation aus einem App-Store und funktioniert nach dem ersten
Öffnen auch **offline**. Auf dem iPad lässt es sich wie eine richtige App auf
den Home-Bildschirm legen (siehe unten).

Dieses README richtet sich an alle, die das Spiel **nicht** als
Programmierer:in betreuen, sondern nur testen, pflegen und veröffentlichen
wollen. Du brauchst dafür keine Programmierkenntnisse.

---

## Neu in Version 3.4: Fahrrouten mit Fahnen und Reihenfolge, Wasser und Schluchten, überarbeitete 3D-Modelle

- **Fahrrouten.** Jedes Fahrzeug hat eine Route aus nummerierten Fahnen (Zwischenfahnen, Zielfahne). Eine Fahne zählt nur, wenn das Fahrzeug in der richtigen **Höhe** an ihr vorbeifährt (Gelände oder Brückendeck); fährt es tiefer oder höher vorbei, hat es sie ausgelassen und das Level ist verloren. Ein Fahrzeug kann auf ein anderes **warten**: „startet erst, wenn der Bus Flagge 1 erreicht hat“. Das Anzeigefeld unten bei der Testfahrt zeigt je Fahrzeug „Flagge 2/3“ oder „wartet auf Auto (Flagge 1)“.
  - Szene: Fahnen in der Farbe der Route, mit Nummer (Stern = Ziel), auf der echten Höhe; in der Zeitreise im Stil der Epoche (Fellbanner, Wimpel, Banner). Architektenansicht: dieselben Fahnen mit Nummern und eine gestrichelte Routenlinie mit Pfeilen. Im Baumodus steht an jedem Start eine Fahrzeug-Silhouette in der Fahrzeug- bzw. Routenfarbe („× 3“ bei mehreren).
  - **12 neue Level:** acht in der neuen Welt **„Fahrplan“** (R-01 … R-08: Zwischenfahne, drei Ebenen, oben und unten, Übergabe auf dem Plateau, Fahne auf dem Brückendeck, Klippe, Wagen wartet im Tal, der Fahrplan) und je eines in Steinzeit, Antike, Mittelalter und Industrialisierung (Z-ST-11 … Z-IN-11). Alle haben eine Musterlösung und einen Nachweis: Steht eine Fahne in falscher Höhe oder warten sich zwei Fahrzeuge gegenseitig, scheitert die Musterlösung (`tools/check_routes.js`).
  - **Was nach Poly Bridge belegt ist und was nicht:** Belegt sind nur Kontrollpunkte und Fahrten von A nach B. Reihenfolge der Fahnen, Warten auf ein anderes Fahrzeug und mehrere Höhen sind **nach Ihrer Beschreibung** umgesetzt. Grenzen: Fahrzeuge fahren immer von links nach rechts; „Ebenen“ sind Plateaus und Talböden verschiedener Höhe (das Gelände ist eine Funktion von x, es gibt keine zwei Straßen übereinander); die Reihenfolge der Fahnen einer Route ist damit immer die Reihenfolge von links nach rechts – ausgelassen werden kann eine Fahne nur durch die falsche Höhe.
- **Wasser, Schluchten, Bäume.** Gefunden: Die Epochen der Zeitreise hatten nie ihre eigene Farbpalette (Landschaft und Pflanzen waren überall „grün“) – behoben, jede Epoche hat jetzt ihre Palette und ihre Pflanzen. Bäume und Felsen standen in 147 von 217 Leveln in der Lücke oder im Wasser (die alte Platzierung setzte sie auf jeden ebenen Fleck, auch auf den Grund der Schlucht) – jetzt stehen sie nie in der Lücke oder unter Wasser, dafür an den Kanten der Schlucht (Bäume, Büsche, Felsen). Flüsse füllen die Schlucht: mindestens 3 m tief, mindestens 55 % der Höhe zwischen Flussbett und Ufer, immer 1,5 m unter dem Ufer (49 klassische Level, 19 Zeitreise-Level und der Level-Generator für Wochen-Challenge und Sandkasten wurden angepasst; Level mit Durchfahrten behalten ihr Wasser). Echte Furten (Z-ST-05, Z-ST-10, Z-AN-04) sind mit `ford: true` gekennzeichnet. Felswände haben Schichten. Tests: `tools/check_water.js` (water_coverage, props_not_in_water, gap_theme_consistency).
- **3D-Modelle neu gebaut (Zeitreise).** Menschen mit Kopf, Körper und laufenden Beinen (Jäger, Legionäre, Ritter, Kutscher), Tiere als ruhige Low-Poly-Figuren (Pferd, Ochse, Mammut mit Kopf, Hals/Rüssel, Beinen, Schwanz) mit Lauf-Animation – die Beine schwingen mit der gefahrenen Strecke, nichts gleitet. Karren mit runden Rädern (Steinzeit: Vollscheiben aus Bohlen, Antike und später: Speichenräder mit Eisenreifen), Ladeflächen mit Fässern, Amphoren, Säcken, Kisten. Schiffe: Floß, Nilboot mit Schilfbündeln, Galeere mit rudernden Rudern, Kogge mit Kastellen, Raddampfer – mit leichter Wippbewegung. Türme der Epochen (Riesenbaum, Säulenturm, Steinturm, Eisengitterturm), Fahnen im Epochenstil, neues Aussehen für Holz, Eiche, Eisen (Nieten), Nietträger, Bronze, Hanf, Draht, Guss, Winde.
  - **Modellgalerie:** im Testlabor ganz unten; jedes Modell auf dem Drehteller (Finger oder Maus drehen, Seite / Schräg / Vorne / Drehen), Fahrzeuge laufen und rollen. Test ohne Browser: `tools/check_models.js` (Größe, Bodenkontakt, Dreiecke).
  - Ehrlich: Das ist Low-Poly mit flachen Farben, kein Detailreichtum; die klassischen Fahrzeuge (Auto, Bus, Lkw, Tanker, Kran, Zug) habe ich angesehen und unverändert gelassen.
- Neue Dateien zum Hochladen: `js/r3d-zmodels.js`, `js/gallery.js` (zusätzlich `js/time.js`, `js/levels-time.js`, `js/overlay.js` u. a. aus 3.2/3.3); geänderte: `index.html`, `style.css`, `service-worker.js`, `js/*.js`. **Nicht** hochladen: die Ordner `screenshots/` und `tools/`.

---

## Neu in Version 3.3: Darstellungsfehler behoben, Kampagnen-Auswahl, neue Kampagne „Zeitreise“

- **Bildtest über alle Level.** Ein automatischer Test (`tools/render_check.js`, Teil von `node tools/run_all.js`) öffnet jedes Level – Klassisch, Zeitreise, Testlabor, Wochen-Challenge – in der Architekten- **und** der Szenen-Ansicht, macht Bilder und prüft in den Bildern selbst: Wasser sichtbar über dem Grund und über die ganze Lücke? Autobahn mit fahrendem Verkehr? Gleise mit Zug? Schlucht ohne „leeren Himmel“ unter der Brücke? Dazu entstehen Kontaktbögen (`screenshots/v3.3/`, nicht hochladen).
  - Gefunden und behoben: Hinweis-Karte wurde von den Ansichts-Knöpfen verdeckt (Testlauf wartete 30 s pro Level), Nacht-Szenen zu dunkel, Gleise mit falscher Spurweite, gemischte Autobahn-und-Bahn-Level (Zug fuhr über Asphalt), zwei Level (W5-02, W5-11) mit einer einstürzenden Beispiel-Säule mitten in der Fahrbahn, Texte, die „Ufer“/„Insel“ versprachen, wo es trocken ist.
  - Durchfahrten (Lkw-/Zug-Tore) jetzt auch in W5-02, W5-03, W5-06, W5-08, W5-10, W5-11, W2-05 und S-04; in **Y-02** bleibt es bei einer festen Lücke, weil die Hubzylinder der Plattform die Fahrspur belegen – dort ist kein Platz für ein Tor.
  - Alle Zug-Level und Zug-Labortests wurden einzeln geprüft (Gleise, Lok/Wagen, Größe, Räder auf den Schienen, Verhalten auf der Brücke, Zug unter der Brücke, beide Ansichten): `screenshots/v3.3/trains/`.
- **Kampagnen-Auswahl beim Start.** Zwei große Karten: „Klassisch“ (13 Welten, 155 Level) und „Zeitreise“ (Steinzeit bis Moderne, 50 Level), jeweils mit Sternen, aktueller Welt/Epoche und kleinem Vorschaubild. Die zuletzt gespielte Kampagne wird gemerkt, „Weiterspielen“ macht dort weiter, „Kampagne wechseln“ (Menü und Karte) wechselt jederzeit. Jede Kampagne hat **eigenen Fortschritt** (Sterne, Freischaltungen, letzte Stelle); dein alter Spielstand ist jetzt der Fortschritt von „Klassisch“ – nichts geht verloren. Export/Import enthält beide. Testlabor, Editor, Wochen-Challenge und Einstellungen gelten für beide; der Tester-Modus gilt je Kampagne und verändert nie den echten Fortschritt. Getestet mit `node tools/check_campaign.js`.
- **Kampagne „Zeitreise“ (fünf Epochen, je zehn Level).** Zeitstrahl-Karte, Freischaltung durch Sterne (18 / 42 / 66 / 96), Karte mit Text und neuen Erfindungen bei jeder neuen Epoche, eigener Look je Epoche (Landschaft, Pflanzen, Fahrzeuge, Schiffe) und passende Linien-Symbole in der Bauansicht. Die Materialien der Epoche bleiben in späteren Epochen erhalten, noch nicht erfundene sind ausgegraut und zeigen, ab wann es sie gibt.
  - **Steinzeit:** Baumstamm, Ast, Liane, Felsblock · Jäger, Fellkarren, Mammut · Floß.
  - **Antike:** Bohle, Holzbalken, Steinblock (Bögen), Steinpfeiler, Hanfseil, Bronzeklammer, Fundamente · Ochsenkarren, Streitwagen, Marschkolonne · Nilboot, Galeere.
  - **Mittelalter:** Eichenbalken, Eichenbohle, Eisenbalken, Eisenkette, Winde (Zugbrücken) · Pferdewagen, Kutsche, Ritterzug · Kogge.
  - **Industrialisierung:** Gusseisen, Nietträger, Drahtseil, Ziegelpfeiler, Schienen · Dampflok, Motorwagen, Lastfuhrwerk · Dampfer.
  - **Moderne:** Stahl, Beton, Kabel, Feder, Hydraulik, Fundamente (die bekannten Materialien) – vier neue Level plus sechs neu inszenierte Schlüssel-Level aus der klassischen Kampagne (Federn, Klappbrücke, Autobahn und Bahn, Viadukt für den Zug, Kran auf Fundamenten, Tanklaster).
  - **Pflicht-Nachweis:** In jeder Epoche gibt es mindestens drei Level, in denen ein typisches Material zwingend ist (automatisch bewiesen); die Tabelle steht in `tools/MECHANICS_ZEIT.md`. Nicht zwingend (nur „erlaubt“) sind Bohle, Holzbalken, Eichenbohle und Gusseisen; der Steinblock ist nur in Z-AN-03 zwingend, die übrigen Bogen-Level sind auch mit anderem Material lösbar.
  - **Vereinfachungen (ehrlich):** Stein, Gusseisen, Felsblock und Ziegel haben getrennte Zug- und Druckgrenzen (wirklich in der Physik: sie brechen bei Zug und halten Druck). Die „Winde“ ist physikalisch eine Hydraulik-Variante (Phasen, ausfahren/einfahren), mit anderem Namen und Preis – kein echter Seilzug. Fahrzeuge und Schiffe sind neue Low-Poly-Modelle, in der Physik aber Varianten der vorhandenen Fahrzeugtypen. Historisch ist alles vereinfacht (z. B. Eichenbohlen und lange Eisenketten als Spielmaterial), aber nichts behauptet Falsches.
- **Testlabor:** neue Gruppe „Zeitreise“ mit einem Test für jedes neue Material, Fahrzeug und Schiff (88 Tests insgesamt).
- Neue Dateien zum Hochladen: `js/time.js`, `js/levels-time.js` (zusätzlich zu `js/overlay.js` u. a. aus 3.2); geänderte: `index.html`, `style.css`, `service-worker.js`, `manifest.json`, `js/*.js`. **Nicht** hochladen: die Ordner `screenshots/` und `tools/`.

---

## Neu in Version 3.2: Durchfahrten, Pflicht-Mechaniken, Untergrund, Fundamente, neue Bauansicht, neues Icon

- **Schiffe, LKW und Züge fahren durch die Brücke.** Sie bewegen sich nicht mehr seitlich, sondern **quer zur Brückenachse** durch eine
  *Durchfahrt* (ein gestrichelter Rahmen in der Brückenebene, beschriftet z. B. „Durchfahrt 4,5 m“). Hängt ein Brückenteil in den Rahmen,
  bleibt das Fahrzeug stehen, hupt, und das Level ist verloren. In der Szene sieht man es auf die Brücke zufahren und hindurchfahren, im Bauplan
  zeigt der Rahmen die Umrisse des Fahrzeugs.
- **Hydraulik hat jetzt einen Grund.** Hohe Schiffe lösen die Phasen aus (Schiff kommt → Brücke öffnet → Schiff ist durch → Brücke schließt),
  Haltelinien und Ampeln halten die Fahrzeuge zurück, solange die Brücke offen ist, die Statusanzeige nennt die aktuelle Phase.
  Neue bzw. umgebaute Level: Klappbrücken und Zugbrücken für hohe Schiffe (W3-02, W3-03, W3-05, W3-08, W5-05, W5-09, T-08),
  mehrere Schiffe verschiedener Höhe nacheinander (W3-07, W3-09, W3-11), Hubplattformen für Höhenunterschiede (Y-01 … Y-07, N-18, N-19).
- **Jede Mechanik ist in mindestens 4 Leveln Pflicht** (Straße, Verstärkte Straße, Holz, Stahl, Seil, Kabel, Feder, Beton-Pfeiler, Schiene,
  Hydraulik, Fundament). „Pflicht“ ist automatisch bewiesen: Die Musterlösung gewinnt, aber **ohne** die Mechanik (Teil entfernt, Hydraulik
  eingefroren) – oder mit **jedem erlaubten Ersatzmaterial** im Budget – scheitert sie. Die Tabelle steht in `tools/MECHANICS.md`, die Prüfung
  ist `node tools/check_needs.js`. In der Level-Info (Taste **I**) steht, welche Bauteile in dem Level nötig sind; das erste Level jeder Mechanik
  erklärt sie unter der Aufgabe.
- **Untergrund (`gap`).** Jedes Level kennt den Untergrund unter der Brücke: **Wasser, Autobahn, Bahnstrecke, Schlucht, Nebelschlucht, Lava**.
  Wasser steht sichtbar über dem Grund (beide Ansichten), Autobahnen haben Fahrbahn mit fahrenden Autos, Schildern und Leitplanken, Bahnstrecken
  Schotter, Schienen und gelegentlich einen Zug, Lava glüht, die Nebelschlucht hat Dunst. Ein Test (`node tools/check_gap.js`) prüft, dass Name,
  Beschreibung, Welt und Wasserstand zusammenpassen. Neue Welt **Verkehrsknoten** (VK-01 … VK-09: Brücken über Autobahn und Gleise).
  Insgesamt **155 Level in 13 Welten**.
- **Fundamente stehen nur auf festem Boden.** Beim Setzen zeigt eine Vorschau **grün** (möglich) oder **rot** (mit Grund: zu steil, außerhalb der
  Bauzone, dort fährt der Verkehr durch, schon belegt, Grenze erreicht). Sie rastet in x am Raster ein und sitzt immer **am Boden darunter** –
  nie in der Luft, auch wenn man mit Finger oder Stift darüber zielt. In mindestens 4 Leveln sind Fundamente Pflicht (W3-12, T-09, N-10, N-21, VK-03, VK-08).
  Prüfung: `node tools/check_found.js` plus Browsertests mit Maus und Touch.
- **Neue Bauansicht** (Architekt und Szene, Maus, Tastatur, Finger und Stift): Werkzeugleiste links (alle Knöpfe ≥ 44 px) mit
  *Bauen, Wählen, Löschen, Linie, Bogen, Teilen, Phasen, Rückgängig, Vor, Leeren*; nicht erlaubte Materialien bleiben **grau mit Begründung** sichtbar.
  *Wählen*: Rahmen ziehen oder antippen, Auswahl durch Ziehen verschieben (grün = passt, rot = nicht), kopieren, ausschneiden, einfügen,
  15° drehen, spiegeln, löschen. *Linie* und *Bogen* zeichnen eine Strecke nach – die Gelenke verteilen sich gleichmäßig und werden mit dem
  gewählten Material verbunden; *Füllen* ergänzt Streben. Beliebig viele Rückgängig-/Wiederholen-Schritte. Schalter oben rechts: **Raster (G)**,
  **Belastungsvorschau (T)** (Schnelltest: eine Probefahrt im Schnelldurchlauf, die Balken zeigen ihre höchste Last, dazu das Ergebnis),
  **Level-Info (I)** (Aufgabe, Fahrzeuge, Budget, Sterne, erlaubte Bauteile) und **Ausblenden (H)**. Das Bauteil-Raster erscheint nur in der Bauzone,
  der Baubereich ist als gestrichelter Rahmen markiert. Der **Phasen-Editor** zeigt eine Tabelle Kolben × Phase und erklärt, was jede Phase auslöst.
  Zoomen/Verschieben mit zwei Fingern oder Mausrad, **Leertaste halten + ziehen** oder mittlere Maustaste.
- **Neues App-Icon** (`icons/icon.svg`, flache Grafik: Fachwerkbrücke auf Bauplan-Grund, nur die Fahrbahn in der Akzentfarbe). Die PNGs heißen
  jetzt `icon-v32-….png`, damit das iPad nicht das alte Bild aus dem Zwischenspeicher zeigt; erzeugt mit `node tools/make_icons.js`.

**Tasten (PC):** 1–9, 0 Material · B Bauen · S Wählen · X Löschen-Werkzeug · L Linie · A Bogen · J Teilen · P Phasen · U Fundament ·
Q/E drehen · F spiegeln links/rechts, Umschalt+F oben/unten · Strg+C / X / V / A · Entf löschen · Pfeiltasten verschieben ·
G Raster · T Belastungsvorschau · I Info · H Oberfläche ausblenden · V Ansicht · Leertaste antippen = Testfahrt.

**Ehrlich dazu – was bewusst anders ist als in Poly Bridge:** Alle Annahmen über Poly Bridge beruhen nur auf den im Auftrag genannten, belegten
Funktionen; nichts davon wurde kopiert. Die Taste **V** bleibt der Ansichtswechsel, deshalb spiegelt **F** (und Umschalt+F) statt F/V.
Die Physik rechnet auf einem ganzzahligen Meter-Raster; „Raster aus“ heißt daher: Enden rasten nur noch an vorhandenen Gelenken und an genau getroffenen
Rasterpunkten ein. Drehen um 15° rundet auf das Raster; fällt dabei ein Gelenk mit einem anderen zusammen, sagt das Spiel es. Die Belastungsvorschau ist eine
echte, schnelle Probefahrt (nicht nur das Eigengewicht). Über dem Budget kann man bauen und testen, das Level zählt dann aber nicht
(sonst wären die Pflicht-Mechaniken nicht mehr Pflicht). Eine echte **Drehbrücke** (Drehung in der Draufsicht) lässt sich im 2D-Seitenschnitt nicht
darstellen; stattdessen schließen Klappen und Zugbrücken die Lücke, nachdem das Schiff durch ist. Wie Poly Bridge 3 genau die Fundamente behandelt, ist
nicht belegt; hier gilt die eigene Regel oben.

**Testen:** `node tools/run_all.js` startet alle automatischen Prüfungen nacheinander. Einzeln: `node tools/run.js` (alle 155 Level: Musterlösung gewinnt, 3 Sterne, Belastung ≤ 85 %, ohne Brücke nicht zu schaffen),
`node tools/check_gap.js`, `node tools/check_found.js`, `node tools/check_needs.js 6`, `node tools/check_editor.js`; im Spiel
*Einstellungen → Selbsttest* und *Testlabor → Alle Tests automatisch prüfen* (jetzt 54 Tests inkl. Fundament gültig/ungültig, Autobahn, Bahn, Lava, Wasser, Hubbrücke mit Schiff).

**Neues Icon auf dem iPad:** Safari merkt sich das Icon beim Hinzufügen zum Home-Bildschirm. Darum die App einmal vom Home-Bildschirm entfernen und
neu hinzufügen – **vorher den Spielstand exportieren** (Einstellungen → Spielstand exportieren) und danach wieder importieren, denn die installierte
App hat ihren eigenen Speicher (siehe Abschnitt 6).

**Veröffentlichen:** alle Dateien des Ordners hochladen. Neu bzw. geändert in 3.2: `js/levels-d.js`, `js/overlay.js`, `js/main.js`, `js/editor.js`,
`js/physics.js`, `js/render*.js`, `js/r3d-*.js`, `js/levels.js`, `js/testlab.js`, `index.html`, `style.css`, `manifest.json`, `service-worker.js`
(`VERSION` 3.2.0) und der Ordner `icons/` (alte Icon-Dateien sind gelöscht). Der Ordner `tools/` ist nur für Entwickler.

---

## Neu in Version 3.1: zwei Ansichten, ruhiger Look, neuer Ton, neues Menü, Testlabor, 30 neue Level

- **Zwei Ansichten.** *Architektenansicht*: Bauplan von vorn (ohne Perspektive) auf dunkelblauem Papier mit feinem Gitter,
  hellblaues Gelände, Balken als Linien mit Gelenkpunkten, die Fahrbahn als Doppellinie, Materialien unterscheidbar,
  Belastungsfarben Blau → Grün → Gelb → Rot. Das Baugitter erscheint **nur in der erlaubten Bauzone**. Sie ist reines 2D und
  läuft auch ohne WebGL. *Szenenansicht*: die 3D-Low-Poly-Welt. Bei der Testfahrt schaltet das Spiel automatisch auf die Szene,
  danach zurück auf die gewählte Bauansicht. Umschalten jederzeit mit dem Knopf oben oder der Taste **V**; die Wahl wird
  gespeichert (Einstellungen → Standardansicht). Bauen, Einrasten, Vorschau, Löschen und Antippen funktionieren in beiden Ansichten gleich.
- **Aufgeräumte 3D-Optik.** Eine ruhige, zusammenpassende Farbpalette pro Welt, weiches Licht, sanfter Himmelsverlauf,
  wenige große Hügel in Dunstschichten, fast glattes Wasser, saubere Geländeschichten, neu modellierte Fahrzeuge
  (Fahrrad, Motorrad, Auto, Bus, LKW, Tanklaster, Kran, Zug, Schiff) und vereinfachte Pylonen, Anker, Schilder, Bäume und Felsen.
- **Neuer Ton** (alles synthetisch, keine Dateien): rund 40 % der früheren Lautstärke, Tiefpass, weiche Einschwingzeiten,
  leises „Tock“ beim Bauen, „Plopp“ beim Löschen, gedämpftes Knarzen beim Bruch, kurze Dur-Melodie beim Gewinnen. Jeder Ton
  höchstens alle 80 ms. Einstellungen: Lautstärke-Regler, Schalter für Geräusche und Musik (Musik standardmäßig **aus**), „Alles stumm“.
- **Neues Menü** im Bauplan-/Low-Poly-Stil: *Weiterspielen, Weltkarte, Wochen-Challenge, Testlabor, Editor, Einstellungen*.
  Die Weltkarte zeigt Welten als Stationen mit kleinen Level-Markierungen (Sterne), Levelkarten zeigen eine Bauplan-Vorschau.
  Das Spielfeld hat weniger Knöpfe (Mehr-Menü „⋯“ für Ton, Hilfe, Einstellungen); alle Knöpfe sind mindestens 44 px groß.
- **Testlabor** (im Menü, von Anfang an offen): 43 Kurztests für jede Mechanik (Materialien, Hydraulik, Fundamente, Federn,
  Seile & Kabel, Fahrzeuge, Sprünge, Wind & Eis, Fracht, Kontrollpunkte, Schiffe, Bauzonen, Vorgebautes, Hindernisse, Routen),
  jeweils mit „Prüft:“ und „Erwartet:“. Dazu der **freie Sandkasten** und ein Knopf **„Alle Tests automatisch prüfen“**.
  Ergebnisse zählen nicht für den Fortschritt und verändern den Spielstand nicht. In den Einstellungen gibt es die
  **Debug-Anzeige** (Belastungszahlen an den Balken, Tempo, FPS) und den **Tester-Modus** (öffnet alle Welten; der echte Fortschritt bleibt unverändert).
- **30 neue Level** (N-01 … N-30) mit neuem Gelände und neuen Fahrzeug- und Mechanik-Mischungen (Kran-LKW und Tanklaster
  bekommen endlich eigene Level) – dazu **sieben ersetzte** sehr ähnliche Level (Hafenstadt W3-04, W3-06, W3-08, W3-10 und
  Federpark F-03, F-04, F-05 – gleiche Nummern, also bleiben Sterne und Freischaltungen gültig). Jedes Level hat eine automatisch
  geprüfte Musterlösung (3 Sterne, kein Balken über 85 %, ohne Brücke nicht zu schaffen). Insgesamt jetzt **140 Level**.
- **Spielstand** bleibt Version 3; neue Einstellungen (Lautstärke, Geräusche, Musik, Ansicht, Tester-Modus, Debug) bekommen
  beim Laden automatisch Standardwerte, nichts geht verloren.
- Zum Testen am PC: `python -m http.server 8000 --bind 0.0.0.0` im Ordner `Brueckenbauer` starten, dann am PC
  `http://localhost:8000/` öffnen. Auf dem iPad (im selben WLAN) `http://<IP-des-PCs>:8000/` in Safari öffnen
  (IP des PCs: in der Eingabeaufforderung `ipconfig`, Zeile „IPv4-Adresse“). Test-Adressen: `?gfx=low|mid|high|2d`.
- Zum Veröffentlichen alle Dateien des Ordners hochladen (siehe Abschnitt 3 und 4). Neu in 3.1: `js/render-bp.js`,
  `js/levels-c.js`, `js/testlab.js` (der Service Worker kennt sie bereits; `VERSION` steht auf 3.1.0).

---

## Neu in Version 3: Low-Poly-3D, Weltkarte, neue Bauteile

- **3D-Grafik** (Three.js, liegt lokal in `js/vendor/three.min.js` – läuft also auch offline). Die Physik bleibt 2D, nur die
  Darstellung ist 3D. Ohne WebGL schaltet das Spiel automatisch auf die alte 2D-Grafik um.
  In den Einstellungen: 3D an/aus und Qualität Niedrig / Mittel / Hoch (zusätzlich senkt das Spiel die Auflösung selbst,
  wenn es ruckelt). Zum Testen: `index.html?gfx=low|mid|high|2d`.
- **Weltkarte** mit 13 Welten und (seit 3.2) **155 Levels**. Welten öffnen über die Gesamtzahl der Sterne, in beliebiger Reihenfolge.
- **Neue Bauteile:** Verstärkte Straße, Kabel, Feder, Hydraulik (mit Phasen), Fundament, Geteilte Gelenke, Bauzonen,
  vorgebaute Teile und feste Hindernisse, mehrere Routen mit farbigen Flaggen.
- **Testfahrt:** Pause, Zeitlupe, Zeitleiste zum Zurückspulen, Wiederholung, Verfolgerkamera.
- **Wöchentliche Herausforderung** (statt der täglichen), **Sandkasten** mit Welt-Look, **Level-Editor** mit Bauzonen,
  vorgebauten Teilen, Kolben, Booten, Kontrollpunkten, zweitem Ziel und Auswahl der erlaubten Bauteile.
- **Spielstand:** Version 3 – ein alter Spielstand (Version 1 oder 2) wird beim Start automatisch übernommen. Alle Level-Nummern
  (L01 … W5-11) sind gleich geblieben, deshalb bleiben Sterne, Bestwerte, gebaute Brücken und eigene Level erhalten.
- Im Ordner `tools/` liegen die Werkzeuge, mit denen die neuen Level gebaut und automatisch geprüft wurden
  (Node.js nötig, nur für Entwickler; für das Spiel selbst unwichtig).

---

## 1. Was ist in diesem Ordner?

```
Brueckenbauer/
├── index.html          Startseite des Spiels (die Datei, die geöffnet wird)
├── style.css            Aussehen (Farben, Schrift, Layout)
├── manifest.json         Beschreibung für "Zum Home-Bildschirm"
├── service-worker.js     sorgt für Offline-Betrieb und Updates
├── .nojekyll             technische Datei für GitHub Pages (nicht löschen)
├── tools/                Werkzeuge der Entwickler (Level bauen und prüfen, Node.js nötig – fürs Spielen unwichtig)
├── README.md             diese Anleitung
├── js/                   das eigentliche Spielprogramm
│   ├── main.js              Spielablauf, Menüs, Bedienung
│   ├── render3d.js, r3d-*.js   3D-Grafik (Low-Poly, Fahrzeuge, Welten)
│   ├── vendor/three.min.js     Three.js (lokal, kein Internet nötig)
│   ├── levels-b.js             die 50 Level der Welten 3, 6–11
│   ├── levels-c.js             die 30 neuen Level + 7 ersetzte Level (v3.1)
│   ├── levels-d.js             Version 3.2: Durchfahrten, Untergrund, Pflicht-Mechaniken, neue Welt, neue Level
│   ├── time.js                 Version 3.3: Epochen, Materialien, Fahrzeuge und Schiffe der Zeitreise
│   ├── r3d-zmodels.js          Version 3.4: handgebaute Modelle der Zeitreise (Menschen, Tiere, Karren, Schiffe)
│   ├── gallery.js              Version 3.4: Modellgalerie im Testlabor
│   ├── levels-time.js          Version 3.3: die 50 Level der Zeitreise
│   ├── overlay.js              Auswahl, Vorschau von Verschieben/Einfügen/Linie/Bogen (alle Ansichten)
│   ├── testlab.js              die Kurztests des Testlabors (v3.1)
│   ├── render-bp.js            Architektenansicht (Bauplan, 2D) (v3.1)
│   ├── weekly.js               wöchentliche Herausforderung
│   ├── physics.js            Brücken-Physik (Kräfte, Bruch, Simulation)
│   ├── render.js              alles, was gezeichnet wird
│   ├── editor.js               Bau-Logik (Balken setzen, Löschen, Rückgängig)
│   ├── levels.js                 die vorgefertigten Level
│   ├── save.js                    Spielstand (siehe Abschnitt 6)
│   └── audio.js                    Soundeffekte (synthetisch, leise)
└── icons/               App-Icons in verschiedenen Größen
    ├── icon.svg                                              (Vorlage des Icons)
    ├── icon-v32-192.png, icon-v32-512.png, icon-v32-maskable-512.png   (Android/PWA)
    ├── icon-v32-180.png                                      (iPad/iPhone, apple-touch-icon)
    └── favicon-v32-32.png                                    (Browser-Tab)
```

Du musst an diesen Dateien normalerweise **nichts** ändern – dieses README
beschreibt nur, wie du das Spiel testest und veröffentlichst.

---

## 2. Auf dem PC testen

Das Spiel **nur per Doppelklick auf `index.html` zu öffnen reicht nicht
ganz**: Der Browser öffnet die Datei dann über `file://…`, und darüber
funktionieren Offline-Betrieb und "Installieren" nicht. Zum Testen richtig
einrichten:

1. **Visual Studio Code** installieren (falls noch nicht vorhanden):
   <https://code.visualstudio.com/> → herunterladen → installieren.
2. In VS Code links auf das Erweiterungen-Symbol klicken (die vier Quadrate),
   nach **"Live Server"** suchen (von Ritwick Dey) und installieren.
3. In VS Code den Ordner `Brueckenbauer` öffnen (Datei → Ordner öffnen…).
4. Im Datei-Explorer von VS Code **rechtsklick auf `index.html`** →
   **"Open with Live Server"**. Der Browser öffnet sich automatisch mit einer
   Adresse wie `http://127.0.0.1:5500/index.html` – jetzt funktioniert alles
   wie später online, inklusive Offline-Test (siehe Abschnitt 8).
5. Änderungen an einer Datei speichern (Strg+S) – Live Server lädt die Seite
   automatisch neu.

Zum schnellen Ansehen ohne Testen der Offline-Funktion reicht auch ein
Doppelklick auf `index.html`, aber dann bitte nicht über fehlendes Offline-
Verhalten oder eine fehlende Installier-Möglichkeit wundern – das ist normal
und kein Fehler.

---

## 3. Veröffentlichen mit GitHub Desktop

So bekommt das Spiel eine eigene Internet-Adresse, die du mit anderen teilen
kannst (kostenlos, über "GitHub Pages").

### 3.1 Einmalig einrichten

1. Falls noch nicht vorhanden: einen GitHub-Account anlegen auf
   <https://github.com> ("Sign up").
2. **GitHub Desktop** installieren: <https://desktop.github.com/> →
   herunterladen → installieren → mit dem GitHub-Account anmelden.
3. In GitHub Desktop: **File → Add local repository…**
4. Als Ordner `Documents\Brueckenbauer` auswählen.
5. GitHub Desktop fragt meist "This directory does not appear to be a Git
   repository" – dann auf **"create a repository"** klicken.
6. Wichtig: Der Name muss **genau** `Brueckenbauer` heißen (so wird er
   automatisch vorgeschlagen, wenn der Ordner so heißt) – das ergibt später
   die Adresse `https://<benutzername>.github.io/Brueckenbauer/`. Bestätigen.
7. Unten links einen kurzen Commit-Kommentar eintragen (z. B. "Erste
   Version") und auf **"Commit to main"** klicken.
8. Oben auf **"Publish repository"** klicken. Im Dialog die Option
   **"Keep this code private" UNBEDINGT ABWÄHLEN** (Haken entfernen) – nur
   ein öffentliches Repository kann später über GitHub Pages im Internet
   angezeigt werden. Dann auf "Publish repository" klicken.

### 3.2 GitHub Pages einschalten (auch nur einmalig)

1. Im Browser zu `https://github.com/<benutzername>/Brueckenbauer` gehen
   (oder in GitHub Desktop oben auf "View on GitHub").
2. Oben auf **Settings** (Zahnrad-Symbol, im Reiter der Repository-Seite).
3. Links auf **Pages** klicken.
4. Bei **"Source"** auswählen: **"Deploy from a branch"**.
5. Bei **"Branch"**: **`main`** auswählen, Ordner **`/ (root)`** auswählen.
6. Auf **Save** klicken.
7. **1–2 Minuten warten**, dann ist das Spiel erreichbar unter:

   ```
   https://<benutzername>.github.io/Brueckenbauer/
   ```

   (`<benutzername>` durch den eigenen GitHub-Benutzernamen ersetzen, klein
   geschrieben, ohne `< >`.)

---

## 4. Später etwas ändern und veröffentlichen

1. Dateien ganz normal bearbeiten (z. B. in VS Code) und lokal testen
   (Abschnitt 2).
2. In GitHub Desktop erscheinen die geänderten Dateien automatisch in der
   Liste links.
3. Unten links einen kurzen Kommentar eintragen, was sich geändert hat, und
   auf **"Commit to main"** klicken.
4. Oben auf **"Push origin"** klicken (lädt die Änderung zu GitHub hoch).
5. Fertig. Das veröffentlichte Spiel aktualisiert sich **von selbst**: Beim
   nächsten Öffnen – oder spätestens beim übernächsten – laden Browser und
   installierte App automatisch die neue Version im Hintergrund nach (siehe
   Abschnitt 8, "Technischer Hintergrund"). Niemand muss etwas neu
   installieren, und **der Spielstand bleibt dabei vollständig erhalten.**

---

## 5. Auf dem iPad installieren

1. Auf dem iPad in **Safari** (nicht Chrome oder einem anderen Browser) die
   Adresse `https://<benutzername>.github.io/Brueckenbauer/` öffnen.
2. Unten (oder oben, je nach iPadOS-Version) auf das **Teilen-Symbol**
   tippen (Quadrat mit Pfeil nach oben).
3. Im Menü nach unten scrollen und **"Zum Home-Bildschirm"** antippen.
4. Oben rechts auf **"Hinzufügen"** tippen.

Jetzt liegt ein Brückenbauer-Icon auf dem Home-Bildschirm. **Das Spiel immer
über dieses Icon starten**, nicht über ein Lesezeichen in Safari – nur die
installierte App läuft im Vollbild und hat ihren eigenen, verlässlichen
Speicherplatz für den Spielstand (siehe nächster Abschnitt).

---

## 6. Ganz wichtig: der Spielstand

Das Spiel merkt sich automatisch, welche Level geschafft wurden, wie viele
Sterne und welche eigenen Level gebaut wurden. Dabei gilt:

- **Die Adresse darf sich nie mehr ändern.** Der Spielstand hängt an der
  genauen Internet-Adresse. Das heißt:
  - Das GitHub-Repository **nie umbenennen**.
  - Den GitHub-Benutzernamen **nie ändern**.
  - Das Repository **nie löschen**.
  - **Keine eigene Domain** nachträglich einrichten (auch wenn GitHub Pages
    das anbietet) – dann wäre der alte Spielstand auf der neuen Adresse
    nicht mehr da.
- Die auf dem **Home-Bildschirm installierte App hat ihren eigenen
  Speicherplatz**, getrennt von normalen Safari-Tabs. Öffnet man dieselbe
  Adresse in einem normalen Safari-Tab, sieht man dort **nicht** automatisch
  den Spielstand der installierten App (und umgekehrt). Darum: **immer über
  das Home-Bildschirm-Icon spielen.**
- Das Spiel speichert zusätzlich gleich in **zwei** unabhängigen Speichern
  des Geräts (damit ein Problem mit dem einen den Spielstand nicht komplett
  verliert) und speichert bei jeder Änderung sofort, auch wenn man die App
  nur kurz wechselt oder zuklappt.
- Trotzdem: **Mach regelmäßig eine Sicherung**, besonders vor größeren
  iPad- oder Browser-Updates:
  - Im Spiel: **Einstellungen → Spielstand exportieren**.
  - Auf dem iPad erscheint danach ein Teilen-Dialog – dort **"In Dateien
    sichern"** wählen und einen Ordner aussuchen (z. B. iCloud Drive). Auf
    dem PC wird stattdessen direkt eine Datei heruntergeladen
    (`brueckenbauer-spielstand-JJJJ-MM-TT.json`).
  - Zum Zurückspielen: im Spiel **Einstellungen → Spielstand importieren**
    und die gesicherte Datei auswählen. Das Spiel zeigt vorher an, was in
    der Datei enthalten ist (Anzahl geschaffter Level etc.), und fragt nach
    Bestätigung.
  - Das Spiel erinnert selbst daran, wenn die letzte Sicherung mehr als 14
    Tage her ist.

---

## 7. Fehlerbehebung

- **Direkt nach dem Veröffentlichen erscheint "404 – page not found".**
  Kein Fehler, GitHub Pages braucht nach dem Einrichten manchmal 1–2 Minuten.
  Einfach kurz warten und die Seite neu laden.
- **Auf dem iPad erscheint noch die alte Version des Spiels.** Die App einmal
  ganz schließen (im App-Umschalter nach oben wischen) und zweimal
  nacheinander neu öffnen – beim ersten Öffnen wird die neue Version im
  Hintergrund geladen, beim zweiten Öffnen wird sie angezeigt.
- **Nach dem Umbenennen/Löschen eines Repositories ist der Spielstand weg.**
  Das lässt sich leider nicht reparieren (siehe Abschnitt 6) – deshalb vorher
  immer exportieren/sichern.
- **"Publish repository" bietet keine Checkbox "Keep this code private"
  mehr an** (z. B. weil das Repository schon veröffentlicht wurde). Dann in
  den GitHub-Einstellungen des Repositories unter *Settings → General →
  Danger Zone → Change visibility* auf "Public" stellen, falls es aus
  Versehen privat angelegt wurde – ein privates Repository zeigt GitHub
  Pages nicht öffentlich an.

---

## 8. Technischer Hintergrund (optional zu lesen)

Für alle, die es genauer wissen möchten:

- **Offline-Betrieb**: Ein sogenannter *Service Worker*
  (`service-worker.js`) legt beim ersten Besuch eine Kopie aller Spieldateien
  im Browser ab. Danach startet das Spiel auch ganz ohne Internetverbindung.
  Beim Testen mit Live Server (`localhost`/`127.0.0.1`) wird zur Bequemlichkeit
  bei jedem Laden zuerst die aktuelle Datei vom Server genommen; nur wenn der
  Server nicht erreichbar ist, kommt die gespeicherte Kopie zum Einsatz. Auf
  der echten, veröffentlichten Adresse läuft es andersherum: Es wird sofort
  die gespeicherte Kopie gezeigt (schneller Start, funktioniert offline),
  während im Hintergrund nach einer neueren Version geschaut wird – ist eine
  da, wird sie erst beim *übernächsten* Start sichtbar, und zwar nur, wenn
  wirklich **alle** Dateien erfolgreich geladen werden konnten (kein
  Durcheinander aus alten und neuen Dateien).
- **Spielstand**: `js/save.js` speichert gleichzeitig in zwei getrennten
  Browser-Speichern (`localStorage` und `IndexedDB`) und nimmt beim Start
  automatisch die neuere der beiden Kopien. Jede Änderung wird nach rund
  300 ms automatisch gesichert, und zusätzlich sofort, sobald die Seite in
  den Hintergrund geht, geschlossen oder neu geladen wird. Ein beschädigter
  Spielstand wird nie stillschweigend überschrieben, sondern aufbewahrt. Der
  Service Worker selbst rührt den Spielstand nie an.
- **Icons**: `icons/icon.svg` ist die Vorlage; `node tools/make_icons.js <Pfad zu playwright-core>` rendert daraus mit Chrome alle PNG-Größen
  (180, 192, 512, maskable 512, Favicon 32). Nötig nur, wenn das Icon selbst verändert werden soll.
