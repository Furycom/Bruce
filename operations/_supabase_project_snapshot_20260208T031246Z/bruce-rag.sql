CREATE OR REPLACE FUNCTION public.bruce_rag_hybrid_search_text(qtext text, qvec text, k integer DEFAULT 10)
 RETURNS TABLE(chunk_id uuid, doc_id uuid, chunk_index integer, cos_sim double precision, fts_score double precision, tri_score double precision, hybrid_score double precision, preview text)
 LANGUAGE sql
 STABLE
AS $function$
WITH q AS (SELECT coalesce(qtext,'') AS t),
exact AS (
  SELECT c.chunk_id, c.doc_id, c.chunk_index,
         0::double precision AS cos_sim, 1::double precision AS fts_score,
         1::double precision AS tri_score, 1::double precision AS hybrid_score,
         substring(c.text from greatest(strpos(c.text,(SELECT t FROM q))-200,1) for 520) AS preview,
         strpos(c.text,(SELECT t FROM q)) AS pos
  FROM public.bruce_chunks c
  WHERE (
    (SELECT t FROM q) LIKE 'RAG_MARKER_%'
    OR (SELECT t FROM q) LIKE 'File:%'
    OR (SELECT t FROM q) ILIKE '%README_SESSION_GUIDE_V5.md%'
    OR (SELECT t FROM q) ILIKE '%Zéro placeholders%'
    OR (SELECT t FROM q) ILIKE '%Protocole Copyback%'
  ) AND strpos(c.text,(SELECT t FROM q))>0
  ORDER BY pos ASC
  LIMIT k
)
SELECT e.chunk_id,e.doc_id,e.chunk_index,e.cos_sim,e.fts_score,e.tri_score,e.hybrid_score,e.preview FROM exact e
UNION ALL
SELECT * FROM public.bruce_rag_hybrid_search(qtext, qvec::vector(1024), k)
WHERE NOT EXISTS (SELECT 1 FROM exact);
$function$;
