# Audit des connecteurs

## Périmètre
- Fichier audité : `connectors.json`
- Logique de validation/usage analysée : `routes/connectors.js`

## Logique observée dans `routes/connectors.js`
1. Le fichier JSON est lu puis parsé dans la variable `connectors`.
2. La liste effectivement parcourue est déterminée ainsi :
   - si `connectors` est un **tableau**, il est utilisé directement ;
   - sinon si `connectors` est un **objet**, le code utilise `Object.values(connectors)`.
3. Pour chaque élément, le routeur lit les champs `id`, `name`, `url`, `kind`.
4. `url` est utilisé par `pingUrl(url)` : c'est le seul champ nécessaire pour un ping valide.
5. `id`, `name` et `kind` ont des valeurs de repli (`id || name || url`, etc.).

## Champs attendus vs présents

### Champs attendus (par connecteur)
- `url` : **requis en pratique** (sinon `pingUrl` est appelé avec `undefined`).
- `id` : optionnel (fallback sur `name` puis `url`).
- `name` : optionnel (fallback sur `id` puis `url`).
- `kind` : optionnel (fallback sur `"generic"`).

### Connecteurs présents dans `connectors.json`
Le fichier contient une structure enveloppe :

```json
{
  "connectors": [
    {
      "name": "validate_service",
      "url": "http://172.18.0.1:4001",
      "auth_header": "X-BRUCE-TOKEN",
      "auth_value": "<BRUCE_AUTH_TOKEN>"
    }
  ]
}
```

Cela implique que `Object.values(connectors)` retourne un seul élément qui est un **tableau**, pas un objet connecteur.

## Résultats de l'audit

### Connecteurs valides
- Aucun connecteur n'est valide **dans la forme réellement consommée par `routes/connectors.js`**.

### Connecteurs avec champs manquants ou incohérents

#### Élément itéré #1 (issu de `Object.values(connectors)`)
- Type réel : `Array` (au lieu d'un objet connecteur).
- Champs attendus : `url` (requis), `id` (optionnel), `name` (optionnel), `kind` (optionnel).
- Champs présents à ce niveau : aucun de ces champs (car l'élément est un tableau).
- Conséquence : `url` est absent au niveau lu par la route, donc `pingUrl(url)` reçoit `undefined`.

#### Connecteur déclaré dans `connectors.json.connectors[0]`
- Champs présents : `name`, `url`, `auth_header`, `auth_value`.
- Champs attendus par la route : `url`, `id`, `name`, `kind`.
- Évaluation :
  - `url` : présent ✅
  - `name` : présent ✅
  - `id` : absent (acceptable, fallback) ⚠️
  - `kind` : absent (acceptable, fallback) ⚠️
  - `auth_header` / `auth_value` : non utilisés par `routes/connectors.js` (informations ignorées par cette route).

## Conclusion
Le contenu interne du connecteur est globalement compatible avec les champs lus par la route (`name`/`url`), mais la **structure racine de `connectors.json` est incohérente** avec la logique de `routes/connectors.js`.

En l'état, la route itère sur un tableau au lieu d'objets connecteurs, ce qui rend tous les champs attendus indisponibles au moment du traitement.
