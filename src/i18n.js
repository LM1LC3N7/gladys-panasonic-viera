// -----------------------------------------------------------------------------
// Texts shown to the user (action messages, connection status), in English and
// French. Never a key, a PIN or a session id in them.
// -----------------------------------------------------------------------------

const list = (names) => names.join(', ');

export const T = {
  invalidEntries: (entries) => ({
    en: `Ignored in the configuration (invalid): ${list(entries)}.`,
    fr: `Ignoré dans la configuration (invalide) : ${list(entries)}.`,
  }),
  pairingNeeded: (names) => ({
    en: `To pair with Gladys: ${list(names)}. Use "Start pairing", then "Finish pairing" with the PIN shown on the TV.`,
    fr: `À appairer avec Gladys : ${list(names)}. Utilisez « Démarrer l'appairage », puis « Terminer l'appairage » avec le code PIN affiché sur la TV.`,
  }),
  found: (tvs) =>
    tvs.length === 0
      ? {
          en: 'No Panasonic TV found. Check that the TVs are on, on the same network, and type their IP address in the configuration if the network blocks the search.',
          fr: 'Aucune TV Panasonic trouvée. Vérifiez que les TV sont allumées, sur le même réseau, et saisissez leur adresse IP dans la configuration si le réseau bloque la recherche.',
        }
      : {
          en: `${tvs.length} TV(s): ${list(tvs)}. They are in the Discovery tab.`,
          fr: `${tvs.length} TV : ${list(tvs)}. Elles sont dans l'onglet Découverte.`,
        },
  invalidAddress: {
    en: 'Type the IP address of the TV, for example 192.168.1.40.',
    fr: "Saisissez l'adresse IP de la TV, par exemple 192.168.1.40.",
  },
  unreachable: (host) => ({
    en: `The TV at ${host} does not answer. Turn it on (a TV in standby does not answer) and check its address.`,
    fr: `La TV à l'adresse ${host} ne répond pas. Allumez-la (une TV en veille ne répond pas) et vérifiez son adresse.`,
  }),
  notPanasonic: (host) => ({
    en: `${host} does not answer like a Panasonic Viera TV (port 55000).`,
    fr: `${host} ne répond pas comme une TV Panasonic Viera (port 55000).`,
  }),
  noPairingNeeded: (name) => ({
    en: `${name} does not need pairing: it is in the Discovery tab.`,
    fr: `${name} n'a pas besoin d'appairage : elle est dans l'onglet Découverte.`,
  }),
  pinDisplayed: (name, minutes) => ({
    en: `${name} now shows a PIN. Type it in "Finish pairing" within ${minutes} minutes.`,
    fr: `${name} affiche maintenant un code PIN. Saisissez-le dans « Terminer l'appairage » dans les ${minutes} minutes.`,
  }),
  pairingRefused: (name, detail) => ({
    en: `${name} refused to start pairing (${detail}). Check that "TV Remote App" / network remote control is allowed in the TV's network settings.`,
    fr: `${name} a refusé de démarrer l'appairage (${detail}). Vérifiez que la commande à distance par le réseau (« TV Remote App ») est autorisée dans les réglages réseau de la TV.`,
  }),
  invalidPinFormat: {
    en: 'The PIN is the 4-digit code shown on the TV.',
    fr: 'Le code PIN est le code à 4 chiffres affiché sur la TV.',
  },
  noPendingPairing: {
    en: 'No pairing in progress, or it expired: use "Start pairing" first.',
    fr: "Aucun appairage en cours, ou il a expiré : utilisez d'abord « Démarrer l'appairage ».",
  },
  wrongPin: {
    en: 'The TV refused this PIN. Use "Start pairing" again to get a new one.',
    fr: "La TV a refusé ce code PIN. Utilisez de nouveau « Démarrer l'appairage » pour en obtenir un nouveau.",
  },
  paired: (name) => ({
    en: `${name} is paired. It is in the Discovery tab (use "Update" if it was already created).`,
    fr: `${name} est appairée. Elle est dans l'onglet Découverte (utilisez « Mettre à jour » si elle était déjà créée).`,
  }),
  pairingFailed: (name, detail) => ({
    en: `Pairing with ${name} failed (${detail}). Use "Start pairing" again.`,
    fr: `L'appairage avec ${name} a échoué (${detail}). Utilisez de nouveau « Démarrer l'appairage ».`,
  }),
  noTv: {
    en: 'No TV known yet: use "Find the TVs" or type their address in the configuration.',
    fr: "Aucune TV connue pour l'instant : utilisez « Chercher les TV » ou saisissez leur adresse dans la configuration.",
  },
  check: (lines) => ({
    en: lines.map((l) => l.en).join(' · '),
    fr: lines.map((l) => l.fr).join(' · '),
  }),
  checkLine: (tv, reading) => {
    const on = reading.on;
    const pairing = !tv.encrypted
      ? { en: 'no pairing needed', fr: "pas d'appairage nécessaire" }
      : tv.keysRefused
        ? { en: 'keys refused, pair again', fr: 'clés refusées, à appairer de nouveau' }
        : tv.appId
          ? { en: 'paired', fr: 'appairée' }
          : { en: 'to pair', fr: 'à appairer' };
    const wake = tv.wakeMac
      ? { en: 'Wake-on-LAN ready', fr: 'Wake-on-LAN prêt' }
      : { en: 'no MAC for Wake-on-LAN', fr: 'pas de MAC pour le Wake-on-LAN' };
    return {
      en: `${tv.name} (${tv.host || 'address unknown'}): ${on ? `on, volume ${reading.volume}${reading.muted ? ', muted' : ''}` : 'off or unreachable'}, ${pairing.en}, ${wake.en}`,
      fr: `${tv.name} (${tv.host || 'adresse inconnue'}) : ${on ? `allumée, volume ${reading.volume}${reading.muted ? ', sourdine' : ''}` : 'éteinte ou injoignable'}, ${pairing.fr}, ${wake.fr}`,
    };
  },
};
