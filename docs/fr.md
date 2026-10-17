# Panasonic Viera

Pilotez vos téléviseurs **Panasonic Viera** depuis Gladys, sur votre réseau
local, sans aucun cloud : marche/arrêt, volume, sourdine, touches de la
télécommande, source (TV, HDMI 1 à 4) et lancement d'applications. L'intégration
utilise la télécommande réseau UPnP/SOAP de la TV (port 55000), la même que
l'application « TV Remote » de Panasonic.

> **Intégration non officielle, sans lien avec Panasonic.** Ce premier jalon a
> été écrit et testé contre une TV simulée :
> l'intégration n'a **jamais été testée** sur un vrai téléviseur. Vos retours
> sont les bienvenus.

## Préparer la TV

1. Dans les menus de la TV : **Réseau > Réglages TV Remote App** (le nom
   varie selon l'année), activez **TV Remote** (la commande par le réseau).
2. Pour pouvoir allumer la TV depuis Gladys, activez aussi, selon le modèle,
   **Allumage par les applications** (« Powered On by Apps ») et/ou le
   **Wake-on-LAN**.
3. Donnez à la TV une **adresse IP fixe** dans votre box (bail DHCP réservé).

## Ajouter une TV

- **Par son adresse** : saisissez l'adresse IP dans « Adresses IP des TV »
  (plusieurs adresses séparées par des virgules) et enregistrez.
- **Par la recherche** : utilisez **Chercher les TV**. Gladys interroge le
  réseau (SSDP) pour l'intégration ; une TV éteinte ou un réseau qui bloque le
  multicast peut ne pas répondre : saisissez alors l'adresse.

La TV apparaît dans l'onglet **Découverte** de l'intégration : créez-la.

## Appairage (modèles depuis 2018 environ)

Les TV récentes (séries FZ, GZ, HZ, JZ et suivantes) chiffrent leur
télécommande et demandent un code PIN une seule fois :

1. Allumez la TV.
2. Dans la configuration de l'intégration, utilisez **Démarrer l'appairage**
   avec l'adresse IP de la TV. La TV affiche un code PIN (4 à 8 chiffres,
   en général 4).
3. Dans les 5 minutes, utilisez **Terminer l'appairage** avec ce code.

L'intégration garde alors les clés données par la TV dans son propre dossier
de données (`/data`) ; elles ne sont jamais envoyées à Gladys ni écrites dans
les logs. Elles y restent quand l'appareil est supprimé de Gladys (une action
« oublier une TV » est prévue). Si la TV est réinitialisée et refuse
explicitement ces clés (ou refuse la session trois fois, à quelques minutes
d'intervalle, alors qu'elle est allumée), l'état de l'intégration le signale :
refaites l'appairage. Les clés sont tout de même réessayées toutes les 30
minutes, au cas où le refus était passager. Les TV plus anciennes n'ont pas
besoin d'appairage.

Avant l'appairage, le volume et la sourdine fonctionnent déjà ; les touches,
la marche/arrêt et les applications, non.

## Ce que vous obtenez

| Fonction    | Détail                                                                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marche      | État lu sur la TV ; commande par la touche marche/arrêt                                                                                                                                  |
| Volume      | 0 à 100, lu et réglé                                                                                                                                                                     |
| Sourdine    | Bouton : chaque appui inverse la sourdine lue sur la TV                                                                                                                                  |
| Boutons     | Volume +/-, chaîne +/-, dernière chaîne, flèches, OK, retour, quitter, menu, option, info, guide, entrée, lecture, pause, stop, retour/avance rapide, saut arrière/avant, enregistrement |
| Source      | Liste : TV, HDMI 1 à 4                                                                                                                                                                   |
| Application | Liste : Netflix, YouTube, Prime Video, navigateur… et les applications annoncées par la TV (après une « Mise à jour » de l'appareil dans Découverte)                                     |
| Touche      | Liste de toutes les touches de la télécommande (chiffres, couleurs, sous-titres…), utile dans les scènes                                                                                 |

Source et application ne sont pas relues sur la TV : la liste sert à
commander, pas à afficher l'état.

## Allumer la TV

La touche marche/arrêt inverse l'état : l'intégration lit donc l'état de la
TV juste avant d'agir (1,5 seconde au plus) et n'envoie rien si la TV est déjà
dans l'état voulu. « Allumée » veut dire « la TV répond aux demandes de
volume » ; « éteinte », « rien ne répond ». Quand la TV répond quelque chose
d'inattendu, l'état est **inconnu** : rien n'est publié et aucune touche
marche/arrêt n'est envoyée.

- TV en **veille réseau** (« Allumage par les applications » activé) : la
  touche marche/arrêt suffit.
- TV en **veille profonde** (elle ne répond plus du tout) : il faut le
  **Wake-on-LAN**. Gladys envoie le paquet pour l'intégration, à la MAC vue
  par la recherche, ou à celle saisie dans « Adresses MAC pour le
  Wake-on-LAN » (`192.168.1.40=a8:13:74:12:34:56`). Avec une MAC connue,
  « allumer » envoie toujours le paquet ; si la TV répond encore sur son port
  réseau, la touche marche/arrêt est envoyée d'abord. La commande est
  confirmée tout de suite à Gladys, puis l'intégration attend jusqu'à 20
  secondes la TV en arrière-plan, en renvoyant le paquet toutes les 2,5
  secondes, jamais de touche marche/arrêt (elle pourrait éteindre une TV en
  train de démarrer). Si une TV ne se réveille pas, essayez l'adresse de
  diffusion de votre réseau dans « Adresse de diffusion du Wake-on-LAN ».

Limites connues, dans les deux sens (à vérifier sur de vrais modèles) :

- une TV en veille qui répond encore aux demandes de volume apparaît
  **allumée** : « allumer » n'envoie alors rien (sauf le Wake-on-LAN, si la
  MAC est connue) ;
- une TV allumée qui ne répond pas aux demandes de volume apparaît
  **éteinte** : « allumer » enverrait alors la touche marche/arrêt et
  l'éteindrait.

Contournement dans les deux cas : la liste « Touche », valeur **Power**,
envoie la touche marche/arrêt telle quelle, sans lire l'état.

## Réglages

- **Intervalle de rafraîchissement** : lecture de la marche, du volume et de
  la sourdine, de 5 à 300 secondes (10 par défaut).
- **Vérifier les TV** : état, appairage et Wake-on-LAN de chaque TV connue.

## Limites

- Réseau local uniquement, port 55000 ouvert entre Gladys et la TV.
- Les notifications vocales de Gladys ne passent pas par la TV.
- Les touches HDMI directes et la liste d'applications dépendent du modèle.
- Jamais testée sur une vraie TV à ce jour.

## Crédits

Logique portée en JavaScript depuis
[panasonic-viera](https://github.com/florianholzapfel/panasonic-viera) de
Florian Holzapfel (licence MIT). Panasonic et Viera sont des marques de
Panasonic Holdings Corporation, citées seulement pour nommer les produits
compatibles.
