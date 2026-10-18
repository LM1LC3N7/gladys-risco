// -----------------------------------------------------------------------------
// Names and messages, French and English.
// -----------------------------------------------------------------------------

export const word = (entry, language) => entry?.[language] ?? entry?.en ?? '';

/** An entry whose values are functions -> the entry of their results. */
export const fill = (entry, ...args) =>
  Object.fromEntries(
    Object.entries(entry).map(([lang, value]) => [
      lang,
      typeof value === 'function' ? value(...args) : value,
    ]),
  );

export const DEVICE_NAMES = {
  panel: { fr: 'Centrale Risco', en: 'Risco panel' },
  partition: { fr: (n) => `Partition ${n}`, en: (n) => `Partition ${n}` },
  zone: { fr: (n) => `Zone ${n}`, en: (n) => `Zone ${n}` },
};

export const FEATURE_NAMES = {
  online: { fr: 'Centrale connectée', en: 'Panel connected' },
  'ac-power': { fr: 'Alimentation secteur', en: 'Mains power' },
  'battery-low': { fr: 'Batterie faible', en: 'Battery low' },
  tamper: { fr: 'Autoprotection', en: 'Tamper' },
  mode: { fr: 'État', en: 'State' },
  alarm: { fr: 'Alarme en cours', en: 'Alarm in progress' },
  ready: { fr: 'Prête à armer', en: 'Ready to arm' },
  'arm-away': { fr: 'Armement total', en: 'Arm away' },
  'arm-stay': { fr: 'Armement partiel', en: 'Arm stay' },
  disarm: { fr: 'Désarmer', en: 'Disarm' },
  kind: {
    opening: { fr: 'Ouverture', en: 'Opening' },
    motion: { fr: 'Mouvement', en: 'Motion' },
    smoke: { fr: 'Fumée', en: 'Smoke' },
    leak: { fr: "Fuite d'eau", en: 'Water leak' },
  },
  'zone-alarm': { fr: 'Alarme', en: 'Alarm' },
  bypassed: { fr: 'Contournée', en: 'Bypassed' },
  'zone-battery-low': { fr: 'Pile faible', en: 'Battery low' },
  bypass: { fr: 'Contourner', en: 'Bypass' },
  unbypass: { fr: 'Rétablir', en: 'Unbypass' },
};

/** The text of the read-only state feature of a partition. */
export const MODE_NAMES = {
  disarmed: { fr: 'Désarmée', en: 'Disarmed' },
  armed_away: { fr: 'Armée (totale)', en: 'Armed (away)' },
  armed_stay: { fr: 'Armée (partielle)', en: 'Armed (stay)' },
  armed_group: { fr: 'Armée (groupe)', en: 'Armed (group)' },
};

const modeList = (partitions, language) =>
  partitions.length === 0
    ? ''
    : ` (${partitions
        .map(({ partition, mode }) =>
          mode
            ? `${partition}: ${word(MODE_NAMES[mode], language).toLowerCase()}`
            : `${partition}: ?`,
        )
        .join(', ')})`;

const nothing = { fr: " : rien n'a été envoyé.", en: ': nothing was sent.' };

/** Connection status and command messages. */
export const T = {
  noHost: {
    en: 'Enter the address of the Risco panel in the configuration.',
    fr: "Saisissez l'adresse de la centrale Risco dans la configuration.",
  },
  noCode: {
    en: 'Enter the access code of the panel (5678 unless your installer changed it).',
    fr: "Saisissez le code d'accès de la centrale (5678 sauf si votre installateur l'a changé).",
  },
  badCode: {
    en: 'The access code must be 4 to 8 digits.',
    fr: "Le code d'accès doit compter 4 à 8 chiffres.",
  },
  connecting: { en: 'Connecting to the Risco panel…', fr: 'Connexion à la centrale Risco…' },
  connected: {
    en: (model, partitions, zones) =>
      `Connected to the ${model} panel${modeList(partitions, 'en')}, ${zones} zone(s).`,
    fr: (model, partitions, zones) =>
      `Connecté à la centrale ${model}${modeList(partitions, 'fr')}, ${zones} zone(s).`,
  },
  unreachable: {
    en: (reason, seconds) => `Risco panel unreachable (${reason}), next try in ${seconds} s.`,
    fr: (reason, seconds) =>
      `Centrale Risco injoignable (${reason}), nouvel essai dans ${seconds} s.`,
  },
  refused: {
    en: 'The panel refused the access code, or closed the connection while checking it: connection stopped, no new try. Fix the code, then save, or click "Test the connection".',
    fr: "La centrale a refusé le code d'accès, ou a coupé la connexion pendant sa vérification : connexion arrêtée, sans nouvel essai. Corrigez le code puis enregistrez, ou cliquez sur « Tester la connexion ».",
  },
  unsupported: {
    en: 'This Risco panel type is not supported (see the documentation): connection stopped.',
    fr: "Ce type de centrale Risco n'est pas pris en charge (voir la documentation) : connexion arrêtée.",
  },
  contended: {
    en: (seconds) =>
      `The panel keeps closing the connection right after it opens: another program may be connected to it (Home Assistant, a Risco bridge…). Next try in ${seconds} s.`,
    fr: (seconds) =>
      `La centrale ferme la connexion juste après son ouverture, à chaque fois : un autre logiciel y est peut-être connecté (Home Assistant, un pont Risco…). Nouvel essai dans ${seconds} s.`,
  },
  offline: {
    en: `The panel is not connected${nothing.en}`,
    fr: `La centrale n'est pas connectée${nothing.fr}`,
  },
  armRefused: {
    en: `Arming from Gladys is disabled in the configuration${nothing.en}`,
    fr: `L'armement depuis Gladys est désactivé dans la configuration${nothing.fr}`,
  },
  disarmRefused: {
    en: `Disarming from Gladys is disabled in the configuration${nothing.en}`,
    fr: `Le désarmement depuis Gladys est désactivé dans la configuration${nothing.fr}`,
  },
  bypassRefused: {
    en: `Bypassing zones from Gladys is disabled in the configuration${nothing.en}`,
    fr: `Le contournement des zones depuis Gladys est désactivé dans la configuration${nothing.fr}`,
  },
  otherMode: {
    en: `The partition is already armed in another mode, disarm it first${nothing.en}`,
    fr: `La partition est déjà armée dans un autre mode, désarmez-la d'abord${nothing.fr}`,
  },
  unknownPartition: {
    en: (n) => `Partition ${n} is not on the panel${nothing.en}`,
    fr: (n) => `La partition ${n} n'existe pas sur la centrale${nothing.fr}`,
  },
  unknownZone: {
    en: (n) => `Zone ${n} is not on the panel${nothing.en}`,
    fr: (n) => `La zone ${n} n'existe pas sur la centrale${nothing.fr}`,
  },
  stateUnknown: {
    en: `The current state could not be read from the panel${nothing.en}`,
    fr: `L'état actuel n'a pas pu être relu sur la centrale${nothing.fr}`,
  },
  tooLate: {
    en: `The panel answered too slowly to send the command in time${nothing.en}`,
    fr: `La centrale a répondu trop lentement pour envoyer la commande à temps${nothing.fr}`,
  },
  bypassPending: {
    en: `A bypass of this zone was just sent and is not confirmed yet${nothing.en}`,
    fr: `Un contournement de cette zone vient d'être envoyé et n'est pas encore confirmé${nothing.fr}`,
  },
  panelRefused: {
    en: (what, code) => `The panel refused the command (${what}, answer ${code}).`,
    fr: (what, code) => `La centrale a refusé la commande (${what}, réponse ${code}).`,
  },
  unconfirmed: {
    en: (what) =>
      `Sent to the panel (${what}), without confirmation in time: the state is read again in 2 s.`,
    fr: (what) =>
      `Envoyé à la centrale (${what}), sans confirmation dans les temps : l'état est relu dans 2 s.`,
  },
  stopped: {
    en: 'The connection is stopped: click "Test the connection" to try again.',
    fr: 'La connexion est arrêtée : cliquez sur « Tester la connexion » pour réessayer.',
  },
  stillConnecting: {
    en: 'The panel is still being read (zones and partitions); try again in a moment.',
    fr: 'La centrale est encore en cours de lecture (zones et partitions) ; réessayez dans un instant.',
  },
  discovering: {
    en: (zone, of) => `Discovery in progress (zone ${zone}/${of}); try again in a moment.`,
    fr: (zone, of) => `Découverte en cours (zone ${zone}/${of}) ; réessayez dans un instant.`,
  },
};

/** What a command does, for the logs and the messages. */
export const COMMAND_NAMES = {
  armed_away: {
    en: (p) => `arm away, partition ${p}`,
    fr: (p) => `armement total, partition ${p}`,
  },
  armed_stay: {
    en: (p) => `arm stay, partition ${p}`,
    fr: (p) => `armement partiel, partition ${p}`,
  },
  disarm: { en: (p) => `disarm, partition ${p}`, fr: (p) => `désarmement, partition ${p}` },
  bypass: { en: (z) => `bypass, zone ${z}`, fr: (z) => `contournement, zone ${z}` },
  unbypass: { en: (z) => `unbypass, zone ${z}`, fr: (z) => `rétablissement, zone ${z}` },
};
