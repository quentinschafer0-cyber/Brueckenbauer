/*
 * Brückenbauer – time.js (v3.3)
 * ----------------------------------------------------------------------------
 * The campaign "Zeitreise": five epochs of bridge building. This file holds the DATA of the campaign:
 *   BB.TIME.EPOCHS    the five epochs (name, theme, unlock stars, story text, new inventions)
 *   BB.TIME.MATS      the materials of the epochs (physics parameters, name, short info, how they are drawn)
 *   BB.TIME.VEHICLES  the vehicles of the epochs (variants of the physics vehicles)
 *   BB.TIME.TECH      which materials a level of an epoch may use (the tech tree)
 *   BB.TIME.LEVELS    the levels (filled by levels-time.js)
 * The materials and vehicles are registered in BB.MATERIALS / BB.VEHICLES so the physics, the editor and the renderers
 * treat them like the classic ones – but they are NOT part of BB.MATERIAL_ORDER / BB.VEHICLE_ORDER, so classic levels,
 * the sandbox and the level editor are not affected.
 *
 * Material fields (on top of the classic ones): strengthC = limit for compression (when different from `strength`, which is
 * then the limit for tension – stone and cast iron are strong when pressed and weak when pulled), look = which of the classic
 * drawings is used ('road' | 'wood' | 'steel' | 'rope' | 'cable' | 'concrete' | 'hydraulic'), info = short German hint.
 * Only simplified, widely known facts are used for the story texts.
 */
(function (BB) {
  'use strict';

  var EPOCHS = [
    {
      id: 'steinzeit', inText: 'in der Steinzeit', name: 'Steinzeit', subtitle: 'Baumstämme & Lianen', theme: 'stone', unlockStars: 0, mx: 10, my: 50, period: 'vor mehr als 5000 Jahren',
      description: 'Ein Baumstamm über den Bach: Die ersten Brücken waren gefällte Bäume, Äste und Lianen.',
      intro: 'Metall kennt hier noch niemand – aber es gibt Bäume, Äste, Lianen und große Felsen. Die ersten Brücken waren wohl gefällte Stämme über Bäche und Schluchten. Wanderer und Jäger gehen darüber, später auch Fellkarren und sogar ein Mammut.',
    },
    {
      id: 'antike', inText: 'in der Antike', name: 'Antike', subtitle: 'Stein, Bögen & Hanf', theme: 'antique', unlockStars: 18, mx: 30, my: 50, period: 'etwa 800 v. Chr. bis 500 n. Chr.',
      description: 'Pfeiler im Fluss, Bögen aus Stein: In der Antike werden Brücken für Karren, Streitwagen und Marschkolonnen gebaut.',
      intro: 'Jetzt gibt es behauene Steine, Bohlen, Hanfseile und Bronzeklammern. Stein trägt viel, wenn er gedrückt wird – wer ihn zieht, bricht ihn leicht. Darum baut man Bögen: Sie leiten die Last in die Widerlager. Auf dem Fluss fahren Nilboote und Galeeren.',
    },
    {
      id: 'mittelalter', inText: 'im Mittelalter', name: 'Mittelalter', subtitle: 'Eisen, Ketten & Zugbrücken', theme: 'medieval', unlockStars: 42, mx: 50, my: 50, period: 'etwa 500 bis 1500',
      description: 'Burggräben, Flussbrücken und Zugbrücken: Eisen und Ketten kommen dazu, und die Winde hebt die Brücke.',
      intro: 'Schmiede liefern Eisenbalken und Ketten. Mit einer Winde und einem Gegengewicht lassen sich Zugbrücken heben, wenn ein Schiff kommt oder die Burg sich verschließt. Auf der Brücke fahren Pferdewagen, Kutschen und Ritter.',
    },
    {
      id: 'industrie', inText: 'in der Industrialisierung', name: 'Industrialisierung', subtitle: 'Gusseisen, Stahl & Dampf', theme: 'industry', unlockStars: 66, mx: 70, my: 50, period: 'das 19. Jahrhundert',
      description: 'Dampfloks, Eisenbahn und Hängebrücken: Gusseisen, Stahlträger und Drahtseile machen große Spannweiten möglich.',
      intro: 'Gusseisen trägt Druck, genietete Stahlträger und Drahtseile tragen noch viel mehr. Dampfloks ziehen schwere Wagen, die ersten Autos knattern über die Brücken und Dampfer fahren darunter durch.',
    },
    {
      id: 'moderne', inText: 'in der Moderne', name: 'Moderne', subtitle: 'Stahl, Beton & Hydraulik', theme: 'modern', unlockStars: 96, mx: 90, my: 50, period: 'heute',
      description: 'Autobahnkreuze, Hubbrücken und Schwerlast: Stahl, Beton, Kabel, Federn und Hydraulik – alles zusammen.',
      intro: 'Stahl, Beton, Kabel, Federn, Hydraulik und Fundamente – alles, was du kennst, steht dir zur Verfügung. Lastwagen, Tanker, Kräne und Züge fahren über deine Brücken, große Schiffe brauchen Hubbrücken.',
    },
  ];

  // ---------------------------------------------------------------------------------------------
  // materials  (price in €/m, mass in kg/m, strength in N; same scale as the classic materials)
  // ---------------------------------------------------------------------------------------------
  var MATS = {
    // ---- Steinzeit
    log: { epoch: 'steinzeit', name: 'Baumstamm', price: 70, mass: 70, strength: 48000, maxLength: 4, drivable: true, tensionOnly: false, stiffness: 4.0e7, color: '#8a5a34', look: 'road', info: 'Fahrbahn und Balken in einem – tragfähig, aber schwer' },
    branch: { epoch: 'steinzeit', name: 'Ast', price: 25, mass: 10, strength: 22000, maxLength: 3, drivable: false, tensionOnly: false, stiffness: 3.0e7, color: '#a77c4c', look: 'wood', info: 'leicht und billig, bricht aber früh' },
    liana: { epoch: 'steinzeit', name: 'Liane', price: 30, mass: 4, strength: 32000, maxLength: 12, drivable: false, tensionOnly: true, stiffness: 4.0e7, color: '#5f8f4a', look: 'rope', info: 'nur auf Zug, dehnt sich ein wenig' },
    boulder: { epoch: 'steinzeit', name: 'Felsblock', price: 160, mass: 320, strength: 40000, strengthC: 320000, maxLength: 3, drivable: false, tensionOnly: false, vertical: true, stiffness: 6.0e8, color: '#8d8a82', look: 'concrete', info: 'trägt viel – steht senkrecht auf festem Boden' },
    // ---- Antike
    plank: { epoch: 'antike', name: 'Bohle', price: 130, mass: 45, strength: 52000, maxLength: 4, drivable: true, tensionOnly: false, stiffness: 2.0e7, color: '#c08a4c', look: 'road', info: 'befahrbar, leichter als der Baumstamm' },
    timber: { epoch: 'antike', name: 'Holzbalken', price: 90, mass: 28, strength: 52000, maxLength: 4.5, drivable: false, tensionOnly: false, stiffness: 1.0e8, color: '#b5793a', look: 'wood', info: 'gerade, fest und günstig' },
    stone: { epoch: 'antike', name: 'Steinblock', price: 220, mass: 420, strength: 18000, strengthC: 380000, maxLength: 3, drivable: true, tensionOnly: false, stiffness: 8.0e8, color: '#b6ad9a', look: 'concrete', info: 'trägt riesigen Druck, bricht bei Zug – ideal für Bögen' },
    pier: { epoch: 'antike', name: 'Steinpfeiler', price: 200, mass: 300, strength: 40000, strengthC: 420000, maxLength: 4, drivable: false, tensionOnly: false, vertical: true, stiffness: 7.0e8, color: '#a9a08e', look: 'concrete', info: 'senkrechter Pfeiler aus Stein – steht auf festem Boden' },
    hemp: { epoch: 'antike', name: 'Hanfseil', price: 60, mass: 6, strength: 70000, maxLength: 16, drivable: false, tensionOnly: true, stiffness: 6.0e7, color: '#c9b27c', look: 'rope', info: 'nur auf Zug, stark und leicht' },
    bronze: { epoch: 'antike', name: 'Bronzeklammer', price: 250, mass: 60, strength: 130000, maxLength: 3, drivable: false, tensionOnly: false, stiffness: 2.0e8, color: '#b87d3a', look: 'steel', info: 'kurz und sehr fest – verbindet wie eine Klammer' },
    // ---- Mittelalter
    oak: { epoch: 'mittelalter', name: 'Eichenbalken', price: 150, mass: 36, strength: 80000, maxLength: 5, drivable: false, tensionOnly: false, stiffness: 1.2e8, color: '#8a6238', look: 'wood', info: 'schwere, feste Balken für Fachwerk' },
    oakplank: { epoch: 'mittelalter', name: 'Eichenbohle', price: 210, mass: 58, strength: 120000, maxLength: 4.5, drivable: true, tensionOnly: false, stiffness: 6.0e7, color: '#7a5230', look: 'road', info: 'befahrbar und fest – die Fahrbahn der Zugbrücken' },
    iron: { epoch: 'mittelalter', name: 'Eisenbalken', price: 280, mass: 55, strength: 190000, maxLength: 4.5, drivable: false, tensionOnly: false, stiffness: 2.5e8, color: '#6f7479', look: 'steel', info: 'geschmiedet: fest, aber teuer' },
    chain: { epoch: 'mittelalter', name: 'Eisenkette', price: 110, mass: 16, strength: 220000, maxLength: 20, drivable: false, tensionOnly: true, stiffness: 8.0e7, color: '#4f565d', look: 'cable', info: 'nur auf Zug, sehr stark, gibt etwas nach' },
    winch: { epoch: 'mittelalter', name: 'Winde', price: 380, mass: 38, strength: 260000, maxLength: 6, drivable: false, tensionOnly: false, hyd: true, stiffness: 2.0e8, color: '#8f6a3a', look: 'hydraulic', info: 'hebt und senkt mit Seil und Gegengewicht – in Phasen' },
    // ---- Industrialisierung
    cast: { epoch: 'industrie', name: 'Gusseisen', price: 210, mass: 90, strength: 60000, strengthC: 420000, maxLength: 4, drivable: true, tensionOnly: false, stiffness: 5.0e8, color: '#4d4a47', look: 'road', info: 'befahrbar, druckfest, bricht bei Zug' },
    girder: { epoch: 'industrie', name: 'Nietträger', price: 310, mass: 46, strength: 290000, maxLength: 6, drivable: false, tensionOnly: false, stiffness: 3.5e8, color: '#7d5a47', look: 'steel', info: 'genietete Stahlträger: fest und leicht' },
    wire: { epoch: 'industrie', name: 'Drahtseil', price: 240, mass: 10, strength: 380000, maxLength: 24, drivable: false, tensionOnly: true, stiffness: 4.0e8, color: '#7f8a94', look: 'cable', info: 'nur auf Zug, extrem stark – für Hängebrücken' },
    brick: { epoch: 'industrie', name: 'Ziegelpfeiler', price: 420, mass: 200, strength: 30000, strengthC: 700000, maxLength: 8, drivable: false, tensionOnly: false, vertical: true, stiffness: 1.0e9, color: '#a8553f', look: 'concrete', info: 'senkrechte Pfeiler aus Ziegeln – tragen viel Druck' },
  };

  // ---------------------------------------------------------------------------------------------
  // tech tree: the materials a level of an epoch may allow (new ones + what is carried on). The classic set is Moderne.
  // ---------------------------------------------------------------------------------------------
  var TECH = {
    steinzeit: ['log', 'branch', 'liana', 'boulder'],
    antike: ['log', 'plank', 'timber', 'stone', 'pier', 'hemp', 'bronze'],
    mittelalter: ['plank', 'timber', 'oak', 'oakplank', 'stone', 'pier', 'iron', 'hemp', 'chain', 'winch'],
    industrie: ['plank', 'oak', 'oakplank', 'stone', 'pier', 'iron', 'chain', 'winch', 'cast', 'girder', 'wire', 'brick', 'rail'],
    moderne: ['road', 'steelroad', 'wood', 'steel', 'rope', 'cable', 'spring', 'concrete', 'hydraulic', 'rail'],
  };
  /** foundations (planted points on the ground) are known from the Antike on */
  var FOUNDATION_FROM = 'antike';

  // ---------------------------------------------------------------------------------------------
  // vehicles (variants of the physics vehicles: mass in kg, size and speed in m, m/s); base = the classic type used by the
  // simple renderers
  // ---------------------------------------------------------------------------------------------
  var VEHICLES = {
    hunter: { epoch: 'steinzeit', name: 'Jäger', base: 'bike', mass: 100, length: 1.8, height: 1.7, wheelRadius: 0.34, axles: [-0.55, 0.55], speed: 3.6, color: '#8a5a34' },
    furcart: { epoch: 'steinzeit', name: 'Fellkarren', base: 'car', mass: 420, length: 2.8, height: 1.6, wheelRadius: 0.5, axles: [-0.8, 0.8], speed: 3.0, color: '#a8794a' },
    mammoth: { epoch: 'steinzeit', name: 'Mammut', base: 'bus', mass: 3000, length: 5.6, height: 3.6, wheelRadius: 0.85, axles: [-1.9, 1.9], speed: 2.6, color: '#6b4a34' },
    oxcart: { epoch: 'antike', name: 'Ochsenkarren', base: 'truck', mass: 2200, length: 5.2, height: 2.2, wheelRadius: 0.55, axles: [-1.0, 1.4], speed: 3.0, color: '#9a6b3a' },
    chariot: { epoch: 'antike', name: 'Streitwagen', base: 'car', mass: 450, length: 3.2, height: 1.9, wheelRadius: 0.55, axles: [-0.5, 0.5], speed: 6.5, color: '#b24a3a' },
    legion: { epoch: 'antike', name: 'Marschkolonne', base: 'bus', mass: 3200, length: 8.0, height: 2.2, wheelRadius: 0.4, axles: [-3.0, 3.0], speed: 3.4, color: '#a83a32' },
    horsecart: { epoch: 'mittelalter', name: 'Pferdewagen', base: 'truck', mass: 3000, length: 6.0, height: 2.4, wheelRadius: 0.6, axles: [-1.3, 2.0], speed: 4.0, color: '#8a6238' },
    carriage: { epoch: 'mittelalter', name: 'Kutsche', base: 'car', mass: 1800, length: 4.8, height: 2.5, wheelRadius: 0.6, axles: [-1.4, 1.4], speed: 5.5, color: '#6a3a4a' },
    knights: { epoch: 'mittelalter', name: 'Ritterzug', base: 'bus', mass: 5200, length: 8.0, height: 3.0, wheelRadius: 0.5, axles: [-3.0, 3.0], speed: 3.8, color: '#9a9ea4' },
    loco: { epoch: 'industrie', name: 'Dampflok', base: 'train', mass: 52000, length: 20, height: 4.2, wheelRadius: 0.6, axles: [-8, -5.5, -3, 0, 3, 6, 8.5], speed: 4.5, color: '#2f3438' },
    oldcar: { epoch: 'industrie', name: 'Motorwagen', base: 'car', mass: 950, length: 3.8, height: 1.8, wheelRadius: 0.4, axles: [-1.2, 1.2], speed: 5.0, color: '#2f4a3a' },
    wagon: { epoch: 'industrie', name: 'Lastfuhrwerk', base: 'truck', mass: 6000, length: 6.5, height: 2.8, wheelRadius: 0.6, axles: [-1.6, 2.2], speed: 3.5, color: '#7a5a3a' },
  };

  // ships: how the passage-gate vessel of an epoch looks (length, beam, height above the water, hull / cabin colour)
  var SHIPS = {
    raft: { epoch: 'steinzeit', name: 'Floß', len: 5, beam: 2.2, hull: '#8a5a34', cabin: '#a77c4c' },
    nileboat: { epoch: 'antike', name: 'Nilboot', len: 9, beam: 2.6, hull: '#b8905a', cabin: '#e9dcc0' },
    galley: { epoch: 'antike', name: 'Galeere', len: 14, beam: 3.2, hull: '#8a4a38', cabin: '#d9c8a0' },
    cog: { epoch: 'mittelalter', name: 'Kogge', len: 12, beam: 4.0, hull: '#6e4a30', cabin: '#d8d0c0' },
    steamer: { epoch: 'industrie', name: 'Dampfer', len: 16, beam: 4.2, hull: '#3a3f46', cabin: '#d8d4cc' },
  };

  // ---------------------------------------------------------------------------------------------
  // registration in the physics tables (the same objects the physics reads)
  // ---------------------------------------------------------------------------------------------
  function register() {
    var M = BB.MATERIALS, V = BB.VEHICLES;
    if (M) Object.keys(MATS).forEach(function (k) { if (!M[k]) M[k] = Object.assign({ key: k }, MATS[k]); });
    if (V) Object.keys(VEHICLES).forEach(function (k) { if (!V[k]) V[k] = Object.assign({ key: k }, VEHICLES[k]); });
  }
  register();

  /** materials a level of the epoch may allow */
  function techFor(epochId) { return (TECH[epochId] || []).slice(); }
  /** the epoch in which a material appears ('moderne' for the classic ones) */
  function epochOfMaterial(k) { return MATS[k] ? MATS[k].epoch : 'moderne'; }
  function epochIndex(id) { for (var i = 0; i < EPOCHS.length; i++) if (EPOCHS[i].id === id) return i; return -1; }
  function get(id) { var i = epochIndex(id); return i >= 0 ? EPOCHS[i] : null; }
  /** vehicle / material keys that are NEW in the epoch */
  function inventions(id) {
    var out = [];
    Object.keys(MATS).forEach(function (k) { if (MATS[k].epoch === id) out.push(k); });
    if (id === FOUNDATION_FROM) out.push('foundation');
    if (id === 'moderne') ['steelroad', 'steel', 'concrete', 'cable', 'spring', 'hydraulic'].forEach(function (k) { out.push(k); });
    return out;
  }

  BB.TIME = {
    EPOCHS: EPOCHS, MATS: MATS, TECH: TECH, VEHICLES: VEHICLES, SHIPS: SHIPS, FOUNDATION_FROM: FOUNDATION_FROM,
    LEVELS: (BB.TIME && BB.TIME.LEVELS) || [],
    register: register, techFor: techFor, epochOfMaterial: epochOfMaterial, epochIndex: epochIndex, get: get, inventions: inventions,
    /** epochs that already have at least one level */
    availableEpochs: function () { var ids = {}; (BB.TIME.LEVELS || []).forEach(function (l) { ids[l.world] = true; }); return EPOCHS.filter(function (e) { return ids[e.id]; }); },
    levelsOf: function (id) { return (BB.TIME.LEVELS || []).filter(function (l) { return l.world === id; }); },
  };
})(globalThis.BB = globalThis.BB || {});
