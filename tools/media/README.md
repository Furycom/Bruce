# Media Library XML Import

Script d'import des inventaires XML (Excel XML Spreadsheet 2003) vers Supabase.

## Fichiers

- `parse_media_xml.py`: parse les fichiers XML, crée la table si possible, puis insère les données en batch avec upsert.

## Prérequis

Variables d'environnement:

- `SUPABASE_URL` (optionnel, défaut: `http://192.168.2.146:8000`)
- `SUPABASE_KEY` (requis pour insertion et RPC SQL, clé service role JWT)

## Exécution

Depuis la racine du repo:

```bash
python3 tools/media/parse_media_xml.py
```

Options:

```bash
python3 tools/media/parse_media_xml.py \
  --dir /home/furycom/bruce-config/projets/media-library/ \
  [--dry-run] \
  [--disque sata10]
```

- `--dir`: répertoire contenant les 9 XML d'inventaire
- `--dry-run`: parse/compte uniquement, sans insertion
- `--disque`: traite un disque spécifique (`sata10`, `sata11`, etc.)

## Schéma SQL utilisé

Le script tente d'exécuter `POST /rest/v1/rpc/exec_sql` avec:

```sql
CREATE TABLE IF NOT EXISTS media_library (
    id BIGSERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    original_title TEXT,
    year INTEGER,
    genres TEXT,
    rating TEXT,
    plot TEXT,
    resolution TEXT,
    video_codec TEXT,
    video_definition TEXT,
    duration_min INTEGER,
    country TEXT,
    actors TEXT,
    subtitles TEXT,
    disque TEXT NOT NULL,
    path TEXT,
    filename TEXT,
    file_size_bytes BIGINT,
    file_extension TEXT,
    imdb_id TEXT,
    imdb_link TEXT,
    tmdb_id TEXT,
    date_added TIMESTAMP,
    is_duplicate BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(imdb_id, disque)
);
CREATE INDEX IF NOT EXISTS idx_media_library_title ON media_library(title);
CREATE INDEX IF NOT EXISTS idx_media_library_disque ON media_library(disque);
CREATE INDEX IF NOT EXISTS idx_media_library_imdb_id ON media_library(imdb_id);
```

Si la RPC `exec_sql` renvoie 404, le script affiche un message et continue en supposant que la table existe déjà.
