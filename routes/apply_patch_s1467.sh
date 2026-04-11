#!/bin/bash
# Patch S1467: Injection intelligente — éliminer le bourrage
# Applique les modifications à session.js

FILE="/home/furycom/mcp-stack/routes/session.js"

# 1. next_tasks: 100 → 10, P5 → P3
sed -i "s/roadmap.filter(t => t.priority !== \"P5\").slice(0, 100)/roadmap.filter(t => t.priority <= 3).slice(0, 10)/" "$FILE"

# 2. critical_lessons: truncate 250 → 150 chars, remove spread operator to keep only essential fields
sed -i "s/effectiveLessons.map(l => ({...l, lesson_text: l.lesson_text ? l.lesson_text.slice(0, 250) : ''}))/effectiveLessons.slice(0, 3).map(l => ({ id: l.id, lesson_text: l.lesson_text ? l.lesson_text.slice(0, 150) : '', importance: l.importance, lesson_type: l.lesson_type }))/" "$FILE"

# 3. clarifications_pending: replace full array with count only
sed -i "s/clarifications_pending: clarificationsPending,/clarifications_pending_count: clarificationsPending.length,/" "$FILE"

# 4. last_session: keep summary only
sed -i "s/last_session: lastSession,/last_session: lastSession ? { id: lastSession.id, notes: (lastSession.notes || '').slice(0, 200), tasks_completed: lastSession.tasks_completed } : null,/" "$FILE"

# 5. rag_context: comment out (already in context_prompt)
sed -i "s/rag_context: ragResults,/\/\/ [S1467] rag_context removed — already in context_prompt/" "$FILE"

echo "Patch S1467 applied to $FILE"
echo "Changes:"
echo "  1. next_tasks: max 10, P1-P3 only (was 100, all except P5)"
echo "  2. critical_lessons: max 3, 150 chars, essential fields only (was 5, 250 chars, all fields)"
echo "  3. clarifications_pending: count only (was full array of 357 objects)"
echo "  4. last_session: summary only (was full object)"
echo "  5. rag_context: removed (duplicate of context_prompt)"
