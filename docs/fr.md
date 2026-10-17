# Risco (LightSYS, Agility, WiComm) pour Gladys

Cette intégration relie une centrale d'alarme **Risco** à Gladys Assistant,
**en local** sur votre réseau (TCP), sans passer par le cloud Risco.

> **Jamais testé sur une vraie centrale.** Le protocole vient de la
> bibliothèque [pyrisco](https://github.com/OnFreund/pyrisco) (celle de
> l'intégration Risco de Home Assistant), portée en JavaScript et vérifiée
> seulement contre une centrale simulée. Faites vos premiers essais en
> présence, centrale désarmée, et signalez ce qui ne va pas.
>
> Intégration non officielle, sans lien avec Risco Group.

## Centrales prises en charge

Les types que pyrisco connaît : Agility 4 (RW032), Agility (RW132), WiComm
(RW232), WiCommPro (RW332), LightSYS (RP432), LightSYS+ (RP432MP), LightSYS
Air (RW432MPV), ProSYS Plus / GT Plus (RP512). La centrale doit avoir un
module réseau (IP) joignable depuis Gladys.

## Ce que vous obtenez

- **Centrale Risco** : connectée ou non, alimentation secteur, batterie
  faible, autoprotection du boîtier.
- **Une partition par appareil** (nom repris de la centrale) :
  - **État** en lecture seule : désarmée, armée (totale), armée (partielle),
    armée (groupe) ;
  - **Alarme en cours** et **Prête à armer** ;
  - trois **boutons** : armement total, armement partiel, désarmer.
- **Une zone par appareil** (nom repris de la centrale) : ouverte ou fermée
  (ou mouvement, fumée, fuite selon le type choisi), alarme, contournée, pile
  faible, et deux **boutons** : contourner, rétablir.
- **Déclencheurs de scène** : alarme déclenchée (avec la zone si la centrale
  la donne), partition armée (mode, demandé par Gladys ou non), partition
  désarmée.
- **Actions de scène** : armer (total ou partiel), désarmer.

Aucune commande n'est un interrupteur : un « éteins tout » d'un assistant
vocal, de HomeKit ou d'une scène ne peut pas désarmer l'alarme. Les états
sont en lecture seule, les commandes sont des boutons.

## Configuration

1. **Adresse de la centrale** : l'adresse IP de son module réseau. Donnez-lui
   une adresse fixe dans votre box.
2. **Port** : 1000, sauf changement par votre installateur.
3. **Code d'accès de la centrale** : le code d'accès à distance (5678 par
   défaut), pas un code utilisateur du clavier. C'est un champ secret : il est
   gardé par Gladys dans sa base, jamais réaffiché dans l'interface, et envoyé
   seulement à la centrale. Il n'apparaît jamais dans les journaux.
4. **Type des zones** (facultatif) : par exemple `2:motion, 5:smoke,
7-9:motion`. Types : `opening` (ouverture, par défaut), `motion`
   (mouvement), `smoke` (fumée), `leak` (fuite d'eau).
5. **Sécurité** : voir plus bas.
6. **Langue des noms** : français ou anglais.

Le bouton **Tester la connexion** se connecte tout de suite et indique le
modèle, l'état des partitions et le nombre de zones.

La première connexion lit toutes les zones possibles de la centrale (50 pour
une LightSYS, 512 pour une LightSYS+) : cela peut prendre de quelques
secondes à une minute. Les appareils apparaissent ensuite dans l'onglet
Découverte.

## Sécurité

- **Armer** est permis par défaut (option « Autoriser l'armement depuis
  Gladys »).
- **Désarmer est désactivé par défaut.** La centrale ne demande pas de code
  utilisateur pour désarmer : le code d'accès suffit. Ne l'autorisez que si
  votre Gladys est bien protégé (comptes, accès à distance). Désarmer coupe
  aussi une alarme en cours.
- **Contourner une zone est désactivé par défaut** : une zone contournée ne
  déclenche plus l'alarme.
- Avant chaque commande, l'intégration **relit l'état sur la centrale** et
  décide sur cet état, jamais sur ce qu'elle a en mémoire. Les commandes
  passent une par une.
- Une commande qui ne peut pas partir dans les temps (centrale lente, état
  illisible) est refusée avec « rien n'a été envoyé ». Une commande partie
  sans réponse de la centrale est annoncée « envoyée, sans confirmation » et
  l'état est relu deux secondes plus tard : elle n'est jamais annoncée « non
  envoyée ».
- Le contournement est une bascule sur la centrale : après un envoi, la zone
  n'accepte pas d'autre contournement tant que la centrale n'a pas montré le
  résultat (30 s au plus).
- Chaque commande, envoyée ou refusée, est écrite dans les journaux de
  l'intégration.

## Connexion et code refusé

- La centrale n'accepte **qu'une connexion locale à la fois** : arrêtez tout
  autre logiciel qui s'y connecte (Home Assistant, un pont Risco). Si la
  centrale ferme la connexion juste après chaque ouverture, l'intégration le
  signale et espace ses essais (5 minutes).
- Sur une coupure, les nouveaux essais sont espacés : 10 s, 30 s, 1 min,
  2 min, puis toutes les 5 minutes.
- **Si la centrale refuse le code d'accès, l'intégration s'arrête** et ne
  réessaie pas toute seule, même après un redémarrage (un code faux essayé en
  boucle pourrait bloquer la centrale). Corrigez le code puis enregistrez, ou
  cliquez sur « Tester la connexion ». Le fichier `/data/risco-state.json`
  garde seulement l'adresse concernée, jamais le code.

## Limites connues

- Jamais testé sur une vraie centrale (voir plus haut) ; les lettres d'état
  lues sont celles que pyrisco documente.
- Local seulement : le cloud Risco n'est pas pris en charge dans cette
  version. Selon la configuration de votre centrale, la connexion au cloud
  Risco et la connexion locale peuvent se gêner (non vérifié).
- L'armement par groupe (A à D) est affiché, pas commandé.
- Une alarme déjà en cours au démarrage de l'intégration ne déclenche pas de
  scène (seuls les changements vus le font).
- Les noms de zones sont lus en UTF-8 ; d'autres encodages de la centrale
  peuvent donner des caractères remplacés.

## Confidentialité

Tout reste sur votre réseau : l'intégration ne parle qu'à la centrale.

## Licence

Apache-2.0. Logique de protocole portée de pyrisco (MIT, On Freund) : voir
`THIRD_PARTY_NOTICES.md`.
